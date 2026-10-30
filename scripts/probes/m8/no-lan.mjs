/**
 * `--assert-no-lan <PC 局域网地址>`（`docs/plan/m8-plan.md` 第 2.3 节「异地接入托管」）：证明这一端全程没走局域网。
 *
 * 只读、不改任何设置（约束「不动宿主机的网络」）：
 *   - **基线排除**：`startNoLanWatch` 一开始先跑一次 `netstat -an`，记下那时已有的、对端是这个地址的 (本端, 对端) 对
 *     （上一项留下的 `TIME_WAIT`、`CLOSE_WAIT` 等都在这里），只记进 `baseline` 供排查、不算；
 *   - 之后每 `everyMs`（缺省 2 s）采样一次，`stop()` 时再采一次：出现的、对端是这个地址、**不在基线里**的 TCP 连接，
 *     **不论状态**（`ESTABLISHED`、`TIME_WAIT`、`SYN_SENT`、`CLOSE_WAIT`…）都算，记最大值 `maxTcp` 与出现过的行 `seen`（至多 5 条）。
 *     两次采样之间建立又关掉的短连接（例如一次很快的 HTTP 请求），下一次采样时只剩 `TIME_WAIT`，照样抓得到；
 *     只数 `ESTABLISHED` 会漏掉它，这正是「全程没走局域网」要抓的；
 *   - `stop()` 时再做一次一次性的局域网发现（`server/lan/discovery.mjs` 的 `discoverLan`，缺省 3 s），记发现到的主机数。
 * 两项都是 0 才算没走局域网；分成 `tcpOk`、`discoveryOk` 两项交给调用方各自判（局域网里别的程序在广播时，发现结果不为 0
 * 不等于这一端连了局域网，两项分开才说得清）。结果只有计数与地址，没有凭证。
 * 判法的纯函数是 `countNewTcpTo`、`judgeNoLanTcp`（单测 `m8-no-lan.test.mjs`）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * `netstat -an` 的一行 → `{ proto, local, foreign, state }`；不是 TCP 行回 null。Windows 与 Linux 的列序不同，
 * 按「像地址的列」取前两个；`state` 取对端之后的那一列（全大写字母与下划线），没有就是 null
 */
export function parseNetstatLine(line) {
  const cols = String(line).trim().split(/\s+/);
  if (!/^tcp/i.test(cols[0] ?? '')) return null;
  const addrs = cols.filter((c) => /[:.]\d+$/.test(c) && /\d/.test(c) && c !== cols[0]);
  if (addrs.length < 2) return null;
  const after = cols[cols.lastIndexOf(addrs[1]) + 1];
  const state = typeof after === 'string' && /^[A-Z][A-Z_0-9]*$/.test(after) ? after : null;
  return { proto: cols[0], local: addrs[0], foreign: addrs[1], state };
}

/** 对端地址是不是这个 IPv4（`a.b.c.d:port`，也认 IPv4 映射的 `[::ffff:a.b.c.d]:port`） */
export function foreignIs(foreign, ip) {
  const f = String(foreign);
  return f.startsWith(`${ip}:`) || f.startsWith(`[::ffff:${ip}]:`);
}

/** 一条连接的 (本端, 对端) 键 */
export const pairKey = (l) => `${l.local}>${l.foreign}`;

/** 数 `netstat -an` 输出里对端是 `ip` 的 TCP 行（任何状态） */
export function countTcpTo(text, ip) {
  const lines = String(text).split(/\r?\n/).map(parseNetstatLine).filter(Boolean).filter((x) => foreignIs(x.foreign, ip));
  return { count: lines.length, lines };
}

/**
 * 基线排除：对端是 `ip`、(本端, 对端) 不在 `baseline` 里的 TCP 行，不论状态都算（`count` / `lines`）；
 * 在基线里的进 `baselineLines`（只供排查）
 * @param {string} text  `netstat -an` 的输出
 * @param {string} ip
 * @param {Set<string>} baseline  开始时已有的 `pairKey`
 */
export function countNewTcpTo(text, ip, baseline = new Set()) {
  const { lines: all } = countTcpTo(text, ip);
  const lines = all.filter((x) => !baseline.has(pairKey(x)));
  return { count: lines.length, lines, baselineLines: all.filter((x) => baseline.has(pairKey(x))) };
}

/** 判法：基线取到了、基线之后至少采样过一次、且全程没见到基线之外到这个地址的连接（不论状态） */
export function judgeNoLanTcp({ baselineOk = true, samples, maxTcp }) {
  return baselineOk === true && samples > 0 && maxTcp === 0;
}

function netstat() {
  const r = spawnSync('netstat', ['-an'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return { ok: r.status === 0 && typeof r.stdout === 'string', text: r.stdout ?? '', error: r.error ? String(r.error.message ?? r.error) : null };
}

/**
 * @param {string} ip  PC 的局域网地址
 * @param {{ everyMs?: number, discoverMs?: number, log?: (event: string, fields: object) => void, netstat?: () => { ok: boolean, text: string }, discover?: boolean }} [o]
 *   `netstat`、`discover: false` 只给单测注入（单测不做真的局域网发现）
 */
export function startNoLanWatch(ip, { everyMs = 2000, discoverMs = 3000, log = () => {}, netstat: run = netstat, discover = true } = {}) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip ?? ''))) throw new TypeError(`--assert-no-lan 要给 IPv4 地址，收到 ${ip}`);
  const state = { ip, baselineOk: false, baseline: [], samples: 0, failedSamples: 0, maxTcp: 0, seen: [] };
  const baselineKeys = new Set();
  const describe = (l) => `${pairKey(l)}${l.state ? ` ${l.state}` : ''}`;
  const sample = () => {
    const n = run();
    if (!n.ok) { state.failedSamples += 1; return; }
    if (!state.baselineOk) {
      // 第一次取到的 netstat 是基线：那时已有的连接都是开始之前的
      for (const l of countTcpTo(n.text, ip).lines) {
        baselineKeys.add(pairKey(l));
        if (state.baseline.length < 20) state.baseline.push(describe(l));
      }
      state.baselineOk = true;
      return;
    }
    const { count, lines } = countNewTcpTo(n.text, ip, baselineKeys);
    state.samples += 1;
    if (count > state.maxTcp) state.maxTcp = count;
    for (const l of lines) {
      const key = describe(l);
      if (state.seen.length < 5 && !state.seen.includes(key)) state.seen.push(key);
    }
    if (count > 0) log('no-lan.tcp-seen', { ip, count });
  };
  sample();
  const timer = setInterval(sample, everyMs);
  timer.unref?.();
  return {
    /** 立刻采一次（单测用；探针靠定时器） */
    sample,
    async stop() {
      clearInterval(timer);
      sample();
      let discovery;
      if (!discover) discovery = { hosts: null, skipped: true };
      else {
        try {
          const { discoverLan } = await import(pathToFileURL(path.join(ROOT, 'server/lan/discovery.mjs')).href);
          const d = await discoverLan({ timeoutMs: discoverMs });
          discovery = { hosts: d.hosts.length, interfaces: d.interfaces.length, sent: d.sent, errors: d.errors.length };
        } catch (error) {
          discovery = { hosts: null, error: String(error?.message ?? error) };
        }
      }
      return { ...state, discovery, tcpOk: judgeNoLanTcp(state), discoveryOk: discovery.hosts === 0 };
    },
  };
}
