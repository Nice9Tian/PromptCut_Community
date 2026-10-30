#!/usr/bin/env node
/**
 * M8「只能出网的节点」一侧的本机替身（M8 执行计划 `docs/plan/m8-plan.md` 第 7 节裁定 D5）。
 *
 * 要证的：独立渲染主机（`cloud/scripts/render-host.mjs`）只经一个 HTTP CONNECT 代理出网时 ——
 *   主机的每条出站连接都经代理（代理记到的目标覆盖文档服务与素材服务；另起旁证：主机进程树没有直连代理以外地址的 TCP 连接），
 *   创建者发布的细任务全部完成（J-全完）、每个任务恰好一次 `task.done`（J-恰一），主机到文档服务的传输是 WebSocket。
 * 证不了的（仍待跨机复核）：真实云端出网代理的怪癖（TLS 中间人、只放行 443、挡无头 Chromium 之类）。
 *
 * 主机经代理的办法不改产品代码：以 `NODE_USE_ENV_PROXY=1` 加 `HTTP_PROXY` / `HTTPS_PROXY`（Node ≥ 24.5）运行，
 * `NO_PROXY=localhost,127.0.0.1,::1`（主机自己的编辑器、预渲染进程、Chrome 调试口都在回环上，不能进代理）。
 * 本脚本的 host 角色发现自己没带这些环境变量时，带上它们重新起自己（子孙进程都继承）。
 *
 * 角色（KV 沿用 `ht-w-probe.mjs` 的 `htw.<run>.*`，creator 就是 `ht-w-probe.mjs --role creator`，本脚本不另写）：
 *   creator  `node scripts/probes/ht-w-probe.mjs --role creator --hosted <托管端> --coord <协调口> [--run <id>] [--port 5792]`
 *            建共享项目、起自己的编辑器队列节点（切分 plan、也做一部分细任务）、旁观节点、发布、汇总 J-全完 / J-恰一，收尾删项目。
 *   proxy    `node scripts/probes/m8/connect-proxy.mjs --listen 127.0.0.1:5798 [--log <文件>]`（主机那台机器上，另开一个终端）
 *   host     `node scripts/probes/m8-outbound-probe.mjs --role host --proxy http://127.0.0.1:5798 | env --hosted <托管端> --coord <协调口>
 *              [--run <id>] [--port 5795] [--host-concurrency 2] [--sample-s 5] [--out <目录>] [--timeout-min 25] [--keep-temp]`
 *            `--proxy env`：用本进程已有的 HTTPS_PROXY / HTTP_PROXY（云端容器自带的出网代理）；那种代理没有 `/__status`，
 *            proxy-reachable 与 proxy-covers-* 两条不做，只剩 TCP 旁证（对端只许是回环或代理自己的地址）。
 *   all      本机替身：同一台机器上起全部角色（见下）。
 *
 * ## --role host
 *   0. 没有 `NODE_USE_ENV_PROXY=1` 就带上代理环境变量重新起自己；
 *   1. `GET <代理>/__status` 核对代理在（之后从这里取代理的连接记录）；
 *   2. 从 KV 取 `config`，写共享项目配置（成员 `host`、`role: 'render'`，`url` 就是托管端地址，不另转）；
 *   3. 起 `cloud/scripts/render-host.mjs`（IPC），写 KV `host.ready`（环境指纹、代码版本）；
 *   4. 每 `--sample-s` 秒采一次本进程树的 TCP 连接（Windows：`Get-CimInstance Win32_Process` 找子孙、`Get-NetTCPConnection` 按进程 id 查）；
 *   5. 等 KV `plan`（creator 写的：细任务、每个任务 `task.done` 的次数），读主机诊断，最后采一次、取代理记录；
 *   6. IPC `shutdown` 正常退出，结果写 KV `host`（`completed` / `dedup` 给 creator 的 host-worked 用）。
 *
 * ## host 的断言（`checks`）
 *   proxy-reachable       代理的 `/__status` 答了
 *   host-config / render-host-ready / plan-received
 *   host-worked           主机完成（含判重）≥ 1 个细任务
 *   host-transport-ws     主机节点到文档服务的传输是 `ws`，不是旧服务端退化（`legacy`）
 *   proxy-covers-docservice  代理记到了到文档服务（`--hosted` 的 host:port）的连接，双向都有字节
 *   proxy-covers-asset    代理记到了到主机所用素材服务（诊断 `assetBase` 的 host:port）的连接，双向都有字节
 *   no-direct-tcp         （Windows、Linux）每次采样里，主机进程树的 TCP 连接的对端只有回环 127.0.0.1 / ::1 与代理自己的地址，
 *                         没有别的；并且至少一次看到进程树到代理的连接（证明采样看得见这棵树）。Linux 用 /proc 找子孙、`ss -tanpH` 取连接
 *   render-host-exit      render-host 正常退出（退出码 0）
 *
 * ## --role all（本机替身）
 *   「远端」一律放在 127.0.0.2 上：本机回环 127.0.0.1 在 `NO_PROXY` 里，127.0.0.2 不在，主机连它就必须经代理；
 *   进程树里出现对端是 127.0.0.2 的 TCP 连接就是直连。端口全在 5790～5799：
 *     5792～5794  creator 的编辑器（+舞台端口，`--creator-port`）  5795～5797  主机的编辑器（+舞台端口，`--host-port`）
 *     5790 / 5791  托管组合的文档服务 / 素材服务（绑 127.0.0.2，信任关，素材服务登记地址 http://127.0.0.2:5791/api/asset）
 *     5798         出站代理（127.0.0.1，独立子进程）      5799        协调口（127.0.0.2，开信箱，令牌现场生成、不打印）
 *   （127.0.0.1 上的 5790、5791 常被别的检出的预渲染进程随机占到，所以编辑器的三连号放在 5792 起，127.0.0.2 上的不受影响。）
 *   creator 不走代理、直连 127.0.0.2；主机经代理。两个角色的结果与代理汇总合成一行，另加 `J-all-done`、`J-exactly-once`
 *   （分别取 creator 的 all-done、done-exactly-once：`task.done` 次数取自发布方编辑器诊断的 `doneCounts`）。
 *     node scripts/probes/m8-outbound-probe.mjs --role all [--out <目录>] [--seconds 8] [--clips 4] [--host-concurrency 2] [--timeout-min 25] [--keep-temp] [--proxy-env]
 *   `--proxy-env`：主机角色改以 `--proxy env` 跑（代理地址只放在它的 HTTPS_PROXY / HTTP_PROXY 里，同云端容器）；此时主机不做
 *   proxy-covers-*，代理覆盖看汇总行的 `proxySummary.byTarget`。
 *
 * ## 跨机（经阿里云；两种主机：笔记本上的本机代理替身，或真「只能出网」的云端容器）
 *   两台都要 `PROBE_MAIL_TOKEN`（协调口信箱令牌），同一个 `--run`；两台检出同一提交（卡片代码版本要相同）。
 *   PC：   node scripts/probes/ht-w-probe.mjs --role creator --hosted https://203-0-113-16.sslip.io/hosted --coord https://203-0-113-16.sslip.io/coord --run <id> --port 5792
 *   笔记本，终端 1：node scripts/probes/m8/connect-proxy.mjs --listen 127.0.0.1:5798 --log <目录>/proxy.log
 *   笔记本，终端 2：node scripts/probes/m8-outbound-probe.mjs --role host --proxy http://127.0.0.1:5798 \
 *                     --hosted https://203-0-113-16.sslip.io/hosted --coord https://203-0-113-16.sslip.io/coord --run <id> --port 5795
 *   注意：ht-w 的 creator 要求主机的环境指纹与它的本机节点相同。PC 与笔记本的指纹不同时（多半如此），要等测试指纹开关
 *   （`PROMPTCUT_TEST_ENV_FINGERPRINT`，C10 集成）进了两台的检出，在两台的两个终端里设同一个值；在那之前，creator 改在笔记本
 *   上跑（第一个实例，`--port 5792`），PC 只看结果。阿里云上文档服务、素材服务、协调口同在 `203-0-113-16.sslip.io:443` 后面，
 *   代理记录按 host:port 分不开三者，proxy-covers-* 两条只证「都经代理」，分不出谁是谁（字节数仍在）。
 *   `PC_CHROME_ARGS` 只把参数原样透传给探针起的 Chrome(典型用途:云端 Linux 以 root 运行要 `--no-sandbox`);不要用它关 TLS 校验(如 `--ignore-certificate-errors`),否则对远端站点的探针在证书有问题时照样通过,掩盖真问题。
 *   云端容器当主机（真「只能出网」，容器已有 HTTPS_PROXY；另要 PC_CHROME_ARGS=--no-sandbox）：
 *     node scripts/probes/m8-outbound-probe.mjs --role host --proxy env --hosted https://203-0-113-16.sslip.io/hosted  *       --coord https://203-0-113-16.sslip.io/coord --run <id>
 *   指纹的限制同上（容器与 creator 那台的指纹几乎一定不同）。
 *
 * 输出：过程写 stderr；stdout 最后一行一行 JSON `{ probe, role, run, ok, checks, fails, … }`，`ok` 为假退出码 1，参数不对 2。
 * 口令、令牌不进 stdout / stderr；代理记录不含路径、查询串与请求头。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { spawn, fork, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coordClient } from './probe-coord.mjs';
import { checkPorts, lastJsonLine } from './m8/lib.mjs';
import { until, killTree, exited, portFree, collectLines, startCoord, HOSTED_MAIN, SCRUB_ENV } from './m8/procs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = fileURLToPath(import.meta.url);
const HTW = path.join(ROOT, 'scripts', 'probes', 'ht-w-probe.mjs');
const PROXY_CLI = path.join(ROOT, 'scripts', 'probes', 'm8', 'connect-proxy.mjs');
const RENDER_HOST = path.join(ROOT, 'cloud', 'scripts', 'render-host.mjs');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ROLE = arg('--role', null);
const TIMEOUT_MS = Number(arg('--timeout-min', 25)) * 60_000;
const KEEP = argv.includes('--keep-temp');
const PROXY_ENV_MODE = argv.includes('--proxy-env');
const SAMPLE_MS = Number(arg('--sample-s', 5)) * 1000;
const BAND = [5790, 5799];
const REMOTE_IP = '127.0.0.2';
const PORTS = { creator: Number(arg('--creator-port', 5792)), host: Number(arg('--host-port', 5795)), doc: 5790, asset: 5791, proxy: 5798, coord: 5799 };
const NO_PROXY = 'localhost,127.0.0.1,::1';
const PROXY_ENV_KEYS = ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
const LOOPBACK = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);
const started = Date.now();
const deadline = started + TIMEOUT_MS;
const checks = [];
const fails = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  if (!ok) fails.push(`${name}${detail === undefined ? '' : ` ${JSON.stringify(detail).slice(0, 600)}`}`);
  return !!ok;
};
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), probe: 'm8-outbound', role: ROLE, step, ...fields })}\n`);
const K = (run, name) => `htw.${run}.${name}`;
const newRunId = () => `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

async function json(url, { timeoutMs = 15_000, ...init } = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
}

/** 地址 → `host:port`（缺省端口按协议补；ws 同 http、wss 同 https） */
export function targetOfUrl(url) {
  const u = new URL(String(url));
  const port = u.port || (/^(https|wss):$/.test(u.protocol) ? 443 : 80);
  const h = u.hostname.replace(/^\[|\]$/g, '');
  return h.includes(':') ? `[${h}]:${port}` : `${h}:${port}`;
}

/* ================================================================== TCP 采样（Windows） */

const TCP_PS1 = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$root = [int]$args[0]
$procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate)
$born = @{}
foreach ($p in $procs) { $born[[int]$p.ProcessId] = $p.CreationDate }
$ids = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$ids.Add($root)
do {
  $added = $false
  foreach ($p in $procs) {
    # 父进程 id 会被复用：只认比父进程晚起的（不然会把无关进程算进树里）
    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId) -and $p.CreationDate -ge $born[[int]$p.ParentProcessId]) { [void]$ids.Add([int]$p.ProcessId); $added = $true }
  }
} while ($added)
$names = @{}
foreach ($p in $procs) { if ($ids.Contains([int]$p.ProcessId)) { $names[[int]$p.ProcessId] = [string]$p.Name } }
$conns = @(Get-NetTCPConnection | Where-Object { $ids.Contains([int]$_.OwningProcess) } | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.OwningProcess; name = $names[[int]$_.OwningProcess]; state = [string]$_.State;
    laddr = [string]$_.LocalAddress; lport = [int]$_.LocalPort; raddr = [string]$_.RemoteAddress; rport = [int]$_.RemotePort } })
[pscustomobject]@{ pids = $ids.Count; names = @($names.Values | Sort-Object -Unique); conns = $conns } | ConvertTo-Json -Compress -Depth 4
`;

/** Linux：由 /proc 找子孙（同样只认比父进程晚起的），`ss -tanpH` 取连接 */
function sampleTcpLinux(rootPid) {
  return new Promise((resolve) => {
    const procs = [];
    try {
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
          const close = stat.lastIndexOf(')');
          const name = stat.slice(stat.indexOf('(') + 1, close);
          const f2 = stat.slice(close + 2).split(' ');
          procs.push({ pid: Number(d), ppid: Number(f2[1]), start: Number(f2[19]), name });
        } catch { /* 进程已退 */ }
      }
    } catch (e) { return resolve({ error: `proc: ${String(e.message ?? e).slice(0, 120)}` }); }
    const born = new Map(procs.map((p) => [p.pid, p.start]));
    const ids = new Set([rootPid]);
    for (let added = true; added;) {
      added = false;
      for (const p of procs) if (ids.has(p.ppid) && !ids.has(p.pid) && p.start >= (born.get(p.ppid) ?? 0)) { ids.add(p.pid); added = true; }
    }
    const names = new Map(procs.filter((p) => ids.has(p.pid)).map((p) => [p.pid, p.name]));
    execFile('ss', ['-tanpH'], { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) return resolve({ error: `ss: ${String(error.message ?? error).slice(0, 160)}` });
      const conns = [];
      const split = (a) => { const i = a.lastIndexOf(':'); return [a.slice(0, i).replace(/^\[|\]$/g, '').replace(/^::ffff:/, '').replace(/%.*$/, ''), Number(a.slice(i + 1))]; };
      for (const line of String(stdout).split(/\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 6) continue;
        const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])).filter((p) => ids.has(p));
        if (!pids.length) continue;
        const [laddr, lport] = split(cols[3]);
        const [raddr, rport] = split(cols[4]);
        const state = cols[0] === 'LISTEN' ? 'Listen' : cols[0] === 'ESTAB' ? 'Established' : cols[0];
        conns.push({ pid: pids[0], name: names.get(pids[0]) ?? null, state, laddr, lport, raddr, rport });
      }
      resolve({ at: Date.now(), pids: ids.size, names: [...new Set(names.values())], conns });
    });
  });
}

/** 采一次 pid 为根的进程树的 TCP 连接；Windows 与 Linux 以外回 null */
function sampleTcp(rootPid, scriptFile) {
  if (process.platform === 'linux') return sampleTcpLinux(rootPid);
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, String(rootPid)],
      { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        if (error && !stdout) return resolve({ error: String(error.message ?? error).slice(0, 200) });
        try {
          const v = JSON.parse(String(stdout).trim());
          const conns = Array.isArray(v.conns) ? v.conns : v.conns ? [v.conns] : [];
          resolve({ at: Date.now(), pids: v.pids, names: Array.isArray(v.names) ? v.names : [v.names], conns });
        } catch (e) { resolve({ error: `parse: ${String(e.message ?? e).slice(0, 120)}` }); }
      });
  });
}

/**
 * 一次采样里：直连（状态不是监听、对端既不是回环也不是代理）的连接、到代理的连接。
 * @param {Set<string>} proxyAddrs 代理的 `ip:port`（代理地址是主机名时解析出的全部地址）
 */
export function classifyTcp(sample, proxyAddrs) {
  const live = (sample?.conns ?? []).filter((c) => c.state !== 'Listen' && c.state !== 'Bound');
  const isProxy = (c) => proxyAddrs.has(`${c.raddr}:${c.rport}`);
  return {
    total: live.length,
    direct: live.filter((c) => !LOOPBACK.has(c.raddr) && !isProxy(c)),
    toProxy: live.filter((c) => isProxy(c) && c.state === 'Established').length,
  };
}

/** 代理地址去掉用户名口令（只留协议、主机、端口），给记录用 */
const redactProxy = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return '(unparsable)'; } };

/* ================================================================== host */

async function runHost(out) {
  const HOSTED = arg('--hosted', null)?.replace(/\/+$/, '') ?? null;
  const COORD = arg('--coord', null)?.replace(/\/+$/, '') ?? null;
  // --proxy env：用本进程已有的 HTTPS_PROXY / HTTP_PROXY（云端容器自带的出网代理），代理记录取不到，只做 TCP 旁证
  const EXTERNAL = arg('--proxy', null) === 'env';
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;
  const PROXY = (EXTERNAL ? envProxy : arg('--proxy', null))?.replace(/\/+$/, '') ?? null;
  if (!HOSTED || !COORD || !PROXY) { fails.push(EXTERNAL ? '--proxy env 要本进程已有 HTTPS_PROXY 或 HTTP_PROXY' : '要给 --hosted、--coord 与 --proxy'); process.exitCode = 2; return; }

  // 0. 没带代理环境变量：带上重新起自己（子孙进程都继承），本进程只转结果
  if (process.env.NODE_USE_ENV_PROXY !== '1' || process.env.M8_OUTBOUND_INNER !== '1') {
    const env = { ...process.env };
    const keepNoProxy = EXTERNAL ? String(process.env.NO_PROXY || process.env.no_proxy || '') : '';
    const noProxy = [...new Set([...keepNoProxy.split(',').map((x) => x.trim()).filter(Boolean), ...NO_PROXY.split(',')])].join(',');
    const httpProxy = EXTERNAL ? (process.env.HTTP_PROXY || process.env.http_proxy || PROXY) : PROXY;
    for (const k of PROXY_ENV_KEYS) delete env[k];
    Object.assign(env, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: httpProxy, HTTPS_PROXY: PROXY, http_proxy: httpProxy, https_proxy: PROXY, NO_PROXY: noProxy, no_proxy: noProxy, M8_OUTBOUND_INNER: '1' });
    const child = spawn(process.execPath, [SELF, ...argv], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    const code = await exited(child, TIMEOUT_MS + 120_000);
    const line = lastJsonLine(stdout);
    out.reexec = true;
    if (!line) { fails.push(`内层没有结果行（退出码 ${code}）`); return; }
    Object.assign(out, line);
    checks.push(...(line.checks ?? []));
    fails.push(...(line.fails ?? []));
    return;
  }

  const c = coordClient(COORD);
  const run = arg('--run', null) ?? (await c.take('htw.latest', Date.now() + 120_000))?.run;
  if (!run) { fails.push('没有 --run，KV 里也没有 htw.latest'); return; }
  out.run = run;
  const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-m8-outbound-${run}`, 'host')));
  fs.mkdirSync(OUT, { recursive: true });
  const port = Number(arg('--port', PORTS.host));
  const proxyUrl = new URL(PROXY);
  const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80));
  const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, '');
  const proxyAddrs = new Set((await dns.lookup(proxyHost, { all: true }).catch(() => [{ address: proxyHost }])).map((a) => `${a.address.replace(/^::ffff:/, '')}:${proxyPort}`));
  if (proxyHost === 'localhost') for (const a of ['127.0.0.1', '::1']) proxyAddrs.add(`${a}:${proxyPort}`);
  out.proxy = { url: redactProxy(PROXY), external: EXTERNAL, addrs: [...proxyAddrs] };
  out.env = { NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY, NO_PROXY: process.env.NO_PROXY, node: process.version };
  const tcpScript = path.join(OUT, 'tcp-sample.ps1');
  // 带 UTF-8 BOM:TCP_PS1 里有中文注释，中文 Windows 的 PowerShell 5.1 读无 BOM 脚本按 GBK 解码
  fs.writeFileSync(tcpScript, '\uFEFF' + TCP_PS1);
  let child = null;
  let lines = [];
  let sampler = null;
  const samples = [];
  const put = async (name, value) => { try { await c.put(K(run, name), value); } catch (error) { say('kv-put-failed', { name, message: String(error?.message ?? error) }); } };
  const aborted = async () => { try { return await c.get(K(run, 'abort'), 0); } catch { return null; } };
  try {
    // 1. 代理在（外部代理没有状态页，跳过）
    let baselineIds = new Set();
    if (!EXTERNAL) {
      const st0 = await json(`${PROXY}/__status`, { timeoutMs: 5000 }).catch((e) => ({ ok: false, body: String(e?.message ?? e) }));
      if (!check('proxy-reachable', st0.ok, st0.ok ? { conns: st0.body?.conns ?? null } : st0.body)) return;
      baselineIds = new Set((st0.body?.records ?? []).map((r) => r.id));
    }

    // 2. 配置
    const cfg = await c.take(K(run, 'config'), deadline);
    if (!check('host-config', !!cfg)) return;
    out.projectId = cfg.projectId;
    out.hostedWs = cfg.hostedWs;
    for (const p of [port, port + 1, port + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
    const configFile = path.join(OUT, 'host.json');
    const deviceId = `m8o-host-${run}`.replace(/[^A-Za-z0-9_-]/g, '-').padEnd(16, '0').slice(0, 64);
    fs.writeFileSync(configFile, JSON.stringify([{ url: cfg.hostedWs, projectId: cfg.projectId, username: cfg.member.username, deviceId, deviceName: 'M8 outbound host (probe)', as: 'member', role: 'render', password: cfg.member.password }], null, 2));

    // 3. 主机
    const env = { ...process.env };
    for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_TEST_CODE_VERSION', 'PROMPTCUT_TRANSPORT', 'PROMPTCUT_ASSET_URL', 'PROBE_MAIL_TOKEN', 'M8_OUTBOUND_INNER']) delete env[key];
    const dataDir = path.join(OUT, 'render-host-data');
    child = fork(RENDER_HOST, ['--config', configFile, '--port', String(port), '--data', dataDir, '--max-concurrent', String(Number(arg('--host-concurrency', 2)))],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    let exitLine = null;
    lines = collectLines(child, { onLine: (line) => { if (line.startsWith('[render-host] exit ')) { try { exitLine = JSON.parse(line.slice('[render-host] exit '.length)); } catch { /* 半行 */ } } } });
    // 从一开始就采（主机起来的过程里也可能有出站连接）
    const tick = async () => {
      const s = await sampleTcp(process.pid, tcpScript);
      if (s) samples.push(s);
      if (sampler !== false) sampler = setTimeout(tick, SAMPLE_MS);
    };
    if (process.platform === 'win32' || process.platform === 'linux') sampler = setTimeout(tick, 1000);
    const ready = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 300_000);
      child.on('message', (m) => { if (m?.type === 'ready') { clearTimeout(t); resolve(m); } });
      child.once('exit', () => { clearTimeout(t); resolve(null); });
    });
    if (!check('render-host-ready', !!ready, ready ? undefined : lines.slice(-8))) return;
    const editor = `http://127.0.0.1:${port}`;
    const queue = async () => (await json(`${editor}/api/frames/queue`, { timeoutMs: 10_000 })).body;
    const q0 = await queue();
    await put('host.ready', { port, envFingerprint: q0?.envFingerprint ?? null, codeVersion: q0?.codeVersion ?? null, at: Date.now() });
    out.envFingerprint = q0?.envFingerprint ?? null;
    say('host-ready', { port });
    // 预渲染进程诊断里的事件只留最近几十条：每 3 s 收一次主机失败 / 丢租约的事件（只作记录，与出站判据无关）
    const hostEvents = new Map();
    let prerenderUrl = null;
    let eventsTimer = null;
    const pollEvents = async () => {
      try {
        prerenderUrl ??= (await json(`${editor}/api/prerender/info`, { timeoutMs: 5000 })).body?.url ?? null;
        if (!prerenderUrl) return;
        for (const e of (await json(`${prerenderUrl}/api/frames/diagnostics`, { timeoutMs: 10_000 })).body?.queue?.events ?? []) {
          if (/^node\.(failed|lost)$/.test(String(e?.event ?? ''))) hostEvents.set(`${e.event}|${e.id}|${e.at}`, { event: e.event, id: e.id ?? null, at: e.at ?? null, error: String(e.error ?? '').slice(0, 200) });
        }
      } catch { /* 下一拍再试 */ }
    };
    const tickEvents = async () => { await pollEvents(); if (eventsTimer !== false) eventsTimer = setTimeout(tickEvents, 3000); };
    void tickEvents();

    // 5. 等 plan
    const plan = await until(async () => (await c.get(K(run, 'plan'), 20_000).catch(() => null)) ?? ((await aborted()) ? { aborted: true } : null), Math.max(1000, deadline - Date.now()), 100);
    clearTimeout(eventsTimer);
    eventsTimer = false;
    await pollEvents();
    out.hostEvents = [...hostEvents.values()].slice(-10);
    if (!check('plan-received', !!plan && !plan.aborted, plan?.aborted ? 'creator abort' : undefined)) return;
    const n = (await queue())?.nodes?.[0] ?? {};
    Object.assign(out, { claimed: n.claimed ?? null, completed: n.completed ?? null, dedup: n.dedup ?? null, failed: n.failed ?? null, lost: n.lost ?? null,
      released: n.released ?? null, opens: n.opens ?? null, resumes: n.resumes ?? null, connectFailed: n.connectFailed ?? null,
      transport: n.transport ?? null, legacy: n.legacy ?? null, session: n.session ?? null, assetBase: n.assetBase ?? null, tasks: plan.tasks ?? null });
    check('host-worked', (n.completed ?? 0) + (n.dedup ?? 0) >= 1, { completed: n.completed ?? null, dedup: n.dedup ?? null, tasks: plan.tasks ?? null });
    check('host-transport-ws', n.transport === 'ws' && n.legacy !== true, { transport: n.transport ?? null, legacy: n.legacy ?? null, opens: n.opens ?? null, resumes: n.resumes ?? null });

    // 最后一次采样、代理记录
    clearTimeout(sampler);
    sampler = false;
    const last = await sampleTcp(process.pid, tcpScript);
    if (last) samples.push(last);
    const st = EXTERNAL ? null : await json(`${PROXY}/__status`, { timeoutMs: 5000 }).catch(() => null);
    const recs = (st?.body?.records ?? []).filter((r) => !baselineIds.has(r.id));
    const byTarget = {};
    for (const r of recs) {
      const t = (byTarget[r.target] ??= { conns: 0, up: 0, down: 0, kinds: {}, denied: 0, errors: 0 });
      if (r.kind === 'denied') { t.denied++; continue; }
      t.conns++; t.up += r.up; t.down += r.down; t.kinds[r.kind] = (t.kinds[r.kind] ?? 0) + 1;
      if (r.error) t.errors++;
    }
    out.proxy.byTarget = byTarget;
    out.proxy.conns = recs.filter((r) => r.kind !== 'denied').length;
    const docTarget = targetOfUrl(cfg.hostedWs);
    const assetTarget = n.assetBase ? targetOfUrl(n.assetBase) : null;
    const covered = (t) => !!t && byTarget[t] && byTarget[t].conns > 0 && byTarget[t].up > 0 && byTarget[t].down > 0;
    if (EXTERNAL) out.proxy.records = 'unavailable: 外部代理，没有逐条记录；只做 TCP 旁证';
    else {
      check('proxy-covers-docservice', covered(docTarget), { target: docTarget, seen: byTarget[docTarget] ?? null });
      check('proxy-covers-asset', covered(assetTarget), { target: assetTarget, seen: assetTarget ? byTarget[assetTarget] ?? null : null });
    }

    // TCP 旁证
    if (process.platform === 'win32' || process.platform === 'linux') {
      const good = samples.filter((s) => !s.error);
      const direct = [];
      let sawProxy = 0;
      for (const s of good) {
        const k = classifyTcp(s, proxyAddrs);
        sawProxy += k.toProxy;
        for (const d of k.direct) direct.push({ at: s.at, name: d.name, pid: d.pid, state: d.state, remote: `${d.raddr}:${d.rport}` });
      }
      out.tcp = { samples: good.length, sampleErrors: samples.length - good.length, maxPids: Math.max(0, ...good.map((s) => s.pids ?? 0)),
        names: [...new Set(good.flatMap((s) => s.names ?? []))], toProxyTotal: sawProxy, direct: direct.length };
      check('no-direct-tcp', good.length >= 2 && direct.length === 0 && sawProxy > 0,
        { samples: good.length, toProxyTotal: sawProxy, direct: direct.slice(0, 10), sampleErrors: samples.filter((s) => s.error).slice(0, 2) });
    } else {
      out.tcp = { skipped: `platform ${process.platform}` };
    }

    // 6. 正常退出
    child.send({ type: 'shutdown' });
    out.exitCode = await exited(child, 60_000);
    out.releasedOnExit = exitLine?.released ?? null;
    check('render-host-exit', out.exitCode === 0, { exitCode: out.exitCode, tail: out.exitCode === 0 ? undefined : lines.slice(-4) });
  } catch (error) {
    fails.push(`host 出错：${String(error?.message ?? error).slice(0, 600)}`);
    say('error', { stack: String(error?.stack ?? error).slice(0, 1500) });
    await put('abort', { reason: `host: ${String(error?.message ?? error).slice(0, 200)}`, at: Date.now() });
  } finally {
    if (sampler) clearTimeout(sampler);
    sampler = false;
    if (child && child.exitCode === null) { killTree(child); await exited(child); }
    try { fs.writeFileSync(path.join(OUT, 'render-host.log'), lines.join('\n')); } catch { /* 写不了不影响结论 */ }
    try { fs.writeFileSync(path.join(OUT, 'tcp-samples.json'), JSON.stringify(samples)); } catch { /* 同上 */ }
    if (!KEEP) { try { fs.rmSync(path.join(OUT, 'render-host-data'), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows 句柄没放 */ } }
    out.out = OUT;
    try { await c.put(K(run, 'host'), { ...out, ok: fails.length === 0, fails, checks }); } catch (e) { fails.push(`结果交不回协调口：${e?.message ?? e}`); }
  }
}

/* ================================================================== all（本机替身） */

async function startHosted(dir) {
  const data = path.join(dir, 'hosted-data');
  fs.mkdirSync(data, { recursive: true });
  const env = { ...process.env };
  for (const key of [...SCRUB_ENV, ...PROXY_ENV_KEYS, 'PROBE_MAIL_TOKEN']) delete env[key];
  Object.assign(env, {
    PROMPTCUT_DATA_DIR: data, PROMPTCUT_DOCSERVICE_HOST: REMOTE_IP, PROMPTCUT_DOCSERVICE_PORT: String(PORTS.doc), PROMPTCUT_ASSET_PORT: String(PORTS.asset),
    PROMPTCUT_ASSET_PUBLIC_URL: `http://${REMOTE_IP}:${PORTS.asset}/api/asset`, PROMPTCUT_DOCSERVICE_PUBLIC_URL: `ws://${REMOTE_IP}:${PORTS.doc}`,
    PROMPTCUT_TRUST_LOOPBACK: '0', PROMPTCUT_CLUSTER_TOKEN: randomBytes(32).toString('base64url'),
  });
  const child = spawn(process.execPath, [HOSTED_MAIN], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let listen = null;
  const lines = collectLines(child, { onLine: (l) => { if (l.includes('"event":"listen"')) { try { listen = JSON.parse(l); } catch { /* 半行 */ } } } });
  await until(() => listen || child.exitCode !== null, 30_000, 100);
  if (!listen) { killTree(child); throw new Error(`托管组合没起来：${lines.slice(-4).join(' | ').slice(0, 600)}`); }
  return { child, lines, listen, stop: async () => { killTree(child); await exited(child, 10_000); } };
}

async function runAll(out) {
  const run = arg('--run', null) ?? newRunId();
  out.run = run;
  const outDir = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-m8-outbound-${run}`)));
  fs.mkdirSync(outDir, { recursive: true });
  out.out = outDir;
  checkPorts([PORTS.creator, PORTS.host], { band: BAND, triple: true });
  checkPorts([PORTS.doc, PORTS.asset, PORTS.proxy, PORTS.coord], { band: BAND, triple: false });
  for (const p of [PORTS.creator, PORTS.creator + 1, PORTS.creator + 2, PORTS.host, PORTS.host + 1, PORTS.host + 2, PORTS.proxy]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  for (const p of [PORTS.doc, PORTS.asset, PORTS.coord]) if (!(await portFree(p, REMOTE_IP))) throw new Error(`端口 ${REMOTE_IP}:${p} 被占用或绑不上`);

  let hosted = null;
  let coord = null;
  let proxy = null;
  let proxyLines = [];
  try {
    const mailToken = randomBytes(24).toString('base64url');
    process.env.PROBE_MAIL_TOKEN = mailToken; // 子进程随环境继承；不上命令行、不打印
    hosted = await startHosted(outDir);
    coord = await startCoord({ port: PORTS.coord, host: REMOTE_IP, mailToken });
    const proxyLog = path.join(outDir, 'proxy.log');
    proxy = spawn(process.execPath, [PROXY_CLI, '--listen', `127.0.0.1:${PORTS.proxy}`, '--log', proxyLog], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    proxyLines = collectLines(proxy);
    if (!(await until(() => proxyLines.some((l) => l.includes('"event":"listen"')) || null, 10_000, 100))) throw new Error(`代理没起来：${proxyLines.slice(-3).join(' | ')}`);
    say('stand-in-up', { hosted: `http://${REMOTE_IP}:${PORTS.doc}`, asset: hosted.listen.asset?.publicUrl ?? null, coord: coord.url, proxy: `http://127.0.0.1:${PORTS.proxy}` });

    const hostedUrl = `http://${REMOTE_IP}:${PORTS.doc}`;
    const coordUrl = `http://${REMOTE_IP}:${PORTS.coord}`;
    const pass = ['--seconds', '--clips', '--host-concurrency', '--timeout-min'].flatMap((n) => (arg(n, null) !== null ? [n, arg(n)] : []));
    const common = ['--hosted', hostedUrl, '--coord', coordUrl, '--run', run, ...pass, ...(KEEP ? ['--keep-temp'] : [])];
    const cleanEnv = { ...process.env };
    for (const k of [...PROXY_ENV_KEYS, 'M8_OUTBOUND_INNER']) delete cleanEnv[k];
    const runChild = (script, role, args, env = cleanEnv) => new Promise((resolve) => {
      const ch = spawn(process.execPath, [script, '--role', role, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
      let stdout = '';
      ch.stdout.on('data', (d) => { stdout += d.toString(); });
      ch.stderr.on('data', (d) => process.stderr.write(d));
      ch.once('exit', (code) => resolve({ role, code, line: lastJsonLine(stdout) }));
    });
    const results = await Promise.all([
      runChild(HTW, 'creator', ['--port', String(PORTS.creator), '--out', path.join(outDir, 'creator'), ...common]),
      // --proxy-env：主机按「云端容器」的样子跑（代理只在它的环境变量里，`--proxy env`），走的是那条路径
      PROXY_ENV_MODE
        ? runChild(SELF, 'host', ['--port', String(PORTS.host), '--proxy', 'env', '--out', path.join(outDir, 'host'), ...common],
          { ...cleanEnv, HTTPS_PROXY: `http://127.0.0.1:${PORTS.proxy}`, HTTP_PROXY: `http://127.0.0.1:${PORTS.proxy}` })
        : runChild(SELF, 'host', ['--port', String(PORTS.host), '--proxy', `http://127.0.0.1:${PORTS.proxy}`, '--out', path.join(outDir, 'host'), ...common]),
    ]);
    for (const r of results) {
      const line = r.line ?? { ok: false, fails: [`没有结果行（退出码 ${r.code}）`], checks: [] };
      out[r.role] = line;
      for (const ch of line.checks ?? []) checks.push({ ...ch, name: `${r.role}:${ch.name}` });
      for (const f of line.fails ?? []) fails.push(`${r.role}: ${f}`);
      if (!line.ok && !(line.fails ?? []).length) fails.push(`${r.role}: 退出码 ${r.code}`);
    }
    const cr = new Map((out.creator?.checks ?? []).map((ch) => [ch.name, ch]));
    const alias = (name, from) => { const ch = cr.get(from); check(name, !!ch?.ok, ch ? { from: `creator:${from}`, detail: ch.detail } : { from: `creator:${from}`, missing: true }); };
    alias('J-all-done', 'all-done');
    alias('J-exactly-once', 'done-exactly-once');
  } catch (error) {
    fails.push(`出错：${String(error?.message ?? error).slice(0, 600)}`);
    say('error', { stack: String(error?.stack ?? error).slice(0, 1500) });
  } finally {
    if (proxy) {
      try { proxy.stdin.write('quit\n'); } catch { /* 已关 */ }
      await exited(proxy, 5000);
      killTree(proxy);
      const summary = proxyLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((v) => v?.event === 'summary').at(-1) ?? null;
      if (summary) out.proxySummary = { conns: summary.conns, denied: summary.denied, kinds: summary.kinds, up: summary.up, down: summary.down, byTarget: summary.byTarget };
    }
    await coord?.stop?.();
    if (hosted) { await hosted.stop(); try { fs.writeFileSync(path.join(outDir, 'hosted.log'), hosted.lines.join('\n')); } catch { /* 写不了不影响结论 */ } }
    if (!KEEP) { try { fs.rmSync(path.join(outDir, 'hosted-data'), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 同上 */ } }
    out.ports = { ...PORTS, remoteIp: REMOTE_IP };
  }
}

/* ================================================================== 入口 */

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const out = { probe: 'm8-outbound', role: ROLE };
  if (!['host', 'all'].includes(ROLE)) {
    process.stderr.write('用法见文件头：--role host | all（creator 用 ht-w-probe.mjs --role creator，代理用 m8/connect-proxy.mjs）\n');
    process.stdout.write(`${JSON.stringify({ ...out, ok: false, error: 'usage', checks: [], fails: ['--role 取 host | all'] })}\n`);
    process.exitCode = 2;
  } else {
    try {
      if (ROLE === 'host') await runHost(out);
      else await runAll(out);
    } catch (error) {
      fails.push(`出错：${String(error?.message ?? error).slice(0, 600)}`);
    }
    out.ms = Date.now() - started;
    out.checks = checks;
    out.fails = fails;
    out.ok = fails.length === 0 && checks.length > 0;
    process.stdout.write(`${JSON.stringify(out)}\n`);
    if (process.exitCode !== 2) process.exitCode = out.ok ? 0 : 1;
    setTimeout(() => process.exit(process.exitCode), 10_000).unref();
  }
}
