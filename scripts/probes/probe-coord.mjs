/**
 * 跨机探针共用的协调口（`shared-project-probe.mjs` 互联网 / 局域网模式、`render-host-probe.mjs` 跨机模式）。
 * 各角色只经它交换配置与完成信号，不共享文件系统。只用 Node 内置模块。
 *
 * 形状（一个协调口同时答这几条，几个探针可以共用同一个口）：
 *   GET  /healthz                    `{ ok: true, keys: [...] }`
 *   PUT  /kv/<键>                     JSON 请求体，存起来并叫醒在等这个键的
 *   GET  /kv/<键>?wait=<毫秒>         `{ ok: true, value }`；没有就等（至多 60 s），等不到 404
 *   其余路径交给 `extra(req, res, url)`（`render-host-probe` 的 `/configs/*`、`/ready/*`、`/round/*`、`/result/*`、`/state`、`/stop`）；
 *   没有 `extra` 或它不认就 404。
 * 键：`[A-Za-z0-9._-]{1,64}`。协调口不设鉴权，配置里有探针自建项目的口令：只绑在可信网段上，跑完就关。
 *
 * 另有两个 Agent 之间的 HTTP 信箱（`mail` 选项，见 `createMailbox`；与文档服务的传输无关）：
 *   POST /mail/<队列>、GET /mail/<队列>?after=<seq>&wait=<秒>，每个请求带 `X-Mail-Token`。
 *   开了信箱时 `/kv/*` 也要同一个令牌（`coordClient` 自动从环境变量 `PROBE_MAIL_TOKEN` 取）；`/healthz` 不要。
 *
 * 命令行（令牌只从环境变量 `PROBE_MAIL_TOKEN` 取，不收命令行参数，免得进进程列表与历史）：
 *   node scripts/probes/probe-coord.mjs serve --port 8799 [--host 0.0.0.0] [--mail-file <文件>]
 *   node scripts/probes/probe-coord.mjs send --base <url> --queue to-cloud --from local --kind instruction [--ref <seq>] (--body <文本> | --body-file <文件>)
 *   node scripts/probes/probe-coord.mjs wait --base <url> --queue to-local [--after <seq> | --state <文件>] [--timeout-min 0]
 *     `wait` 反复长轮询，收到至少一条就打印（一行一条 JSON）并退出 0；`--state` 记最后读到的 seq，下次从它之后读；
 *     `--timeout-min` 到时没收到退出 3（0 为不限）；网络错误按退避一直重试。
 *   `--kind` 取 instruction（指令）/ receipt（回执，`--ref` 指向指令的 seq）/ question（要对方或用户定的事）/ status（报到与状态）。
 *
 * 在 Claude Code 里等消息：用一条后台运行的 `wait` 命令（Bash 的后台运行），由它在进程内反复长轮询（每次挂 25 s），
 * 收到消息才退出、唤醒会话；不要让模型隔一会儿调一次去逐次轮询。`--state` 文件记最后读到的 seq，下一条 `wait` 从它之后读，
 * 所以每次被唤醒、处理完消息后再起一条同样的后台 `wait` 即可，不漏读也不重读。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BODY = 4 << 20;

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** 读 JSON 请求体（空体回 `{}`）；超过 4 MiB 或不是 JSON 抛错 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too-large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export const MAIL_DEFAULTS = Object.freeze({
  QUEUES: Object.freeze(['to-cloud', 'to-local']),
  KINDS: Object.freeze(['instruction', 'receipt', 'question', 'status']),
  /** 长轮询最长挂多久（nginx 缺省 `proxy_read_timeout` 60 s 之内） */
  MAX_WAIT_MS: 25_000,
  /** 每个队列在内存里留多少条；更早的只在文件里 */
  KEEP: 1000,
  /** 一条消息（整个信封的 JSON）上限 */
  MAX_MESSAGE_BYTES: 256 * 1024,
  /** 一次 GET 最多回多少条 */
  MAX_BATCH: 100,
});

const FROM_RE = /^[A-Za-z0-9._@-]{1,64}$/;

/**
 * 两个 Agent 之间的 HTTP 信箱（不是文档服务的传输）。每个队列单向、只追加，服务端补 `seq`（每队列从 1 起）与 `t`。
 *   POST /mail/<队列>                     `{ from, kind, ref?, body }` → `{ ok, seq, t }`
 *   GET  /mail/<队列>?after=<seq>&wait=<秒> → `{ ok, messages: [信封…], last }`；没有新消息就挂着等，最长 `MAX_WAIT_MS`
 * 信封：`{ queue, seq, t, from, kind, ref, body }`；`kind` 是 instruction / receipt / question / status，`ref` 是回执引用的对方 seq（没有为 null）。
 * 每个请求都要带请求头 `X-Mail-Token`，不对回 401。令牌不进日志、不进回包。
 * `file` 给了就逐条追加成 JSON 行，重启时读回来，seq 接着编。
 */
export function createMailbox({
  token,
  queues = MAIL_DEFAULTS.QUEUES,
  file = null,
  maxWaitMs = MAIL_DEFAULTS.MAX_WAIT_MS,
  keep = MAIL_DEFAULTS.KEEP,
  now = () => new Date(),
  log = () => {},
} = {}) {
  if (typeof token !== 'string' || token.length < 16) throw new TypeError('信箱令牌至少 16 个字符');
  const expected = Buffer.from(token, 'utf8');
  const state = new Map(queues.map((q) => [q, { last: 0, messages: [], waiters: new Set() }]));

  if (file && fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const q = state.get(m?.queue);
      if (!q || !Number.isInteger(m.seq) || m.seq <= q.last) continue;
      q.last = m.seq;
      q.messages.push(m);
      if (q.messages.length > keep) q.messages.shift();
    }
  }

  const authorized = (req) => {
    const given = req.headers['x-mail-token'];
    if (typeof given !== 'string') return false;
    const buf = Buffer.from(given, 'utf8');
    return buf.length === expected.length && timingSafeEqual(buf, expected);
  };

  function append(queue, { from, kind, ref, body }) {
    const q = state.get(queue);
    const m = { queue, seq: q.last + 1, t: now().toISOString(), from, kind, ref: ref ?? null, body };
    const line = JSON.stringify(m);
    if (Buffer.byteLength(line, 'utf8') > MAIL_DEFAULTS.MAX_MESSAGE_BYTES) return { error: 'too-large' };
    if (file) fs.appendFileSync(file, `${line}\n`);
    q.last = m.seq;
    q.messages.push(m);
    if (q.messages.length > keep) q.messages.shift();
    for (const wake of [...q.waiters]) wake();
    log('mail.post', { queue, seq: m.seq, from, kind, ref: m.ref });
    return { message: m };
  }

  const after = (q, seq) => q.messages.filter((m) => m.seq > seq).slice(0, MAIL_DEFAULTS.MAX_BATCH);

  async function handle(req, res, url) {
    const m = /^\/mail\/([^/]+)$/.exec(url.pathname);
    if (!m) return sendJson(res, 404, { ok: false, error: 'no-route' });
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    const queue = decodeURIComponent(m[1]);
    const q = state.get(queue);
    if (!q) return sendJson(res, 404, { ok: false, error: 'no-queue' });

    if (req.method === 'POST') {
      let b;
      try { b = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'bad-json' }); }
      if (typeof b.from !== 'string' || !FROM_RE.test(b.from)) return sendJson(res, 400, { ok: false, error: 'bad-from' });
      if (!MAIL_DEFAULTS.KINDS.includes(b.kind)) return sendJson(res, 400, { ok: false, error: 'bad-kind' });
      if (b.ref !== undefined && b.ref !== null && !(Number.isInteger(b.ref) && b.ref > 0)) return sendJson(res, 400, { ok: false, error: 'bad-ref' });
      if (b.body === undefined) return sendJson(res, 400, { ok: false, error: 'no-body' });
      const r = append(queue, b);
      if (r.error) return sendJson(res, 413, { ok: false, error: r.error });
      return sendJson(res, 200, { ok: true, seq: r.message.seq, t: r.message.t });
    }

    if (req.method === 'GET') {
      const since = Number(url.searchParams.get('after') ?? 0);
      if (!Number.isInteger(since) || since < 0) return sendJson(res, 400, { ok: false, error: 'bad-after' });
      const waitS = Number(url.searchParams.get('wait') ?? 0);
      const waitMs = Math.max(0, Math.min(Number.isFinite(waitS) ? waitS * 1000 : 0, maxWaitMs));
      let got = after(q, since);
      if (got.length === 0 && waitMs > 0) {
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            q.waiters.delete(finish);
            resolve();
          };
          const timer = setTimeout(finish, waitMs);
          q.waiters.add(finish);
          req.on('close', finish);
        });
        got = after(q, since);
      }
      if (res.destroyed || res.writableEnded) return undefined;
      return sendJson(res, 200, { ok: true, messages: got, last: q.last });
    }
    return sendJson(res, 405, { ok: false, error: 'method' });
  }

  return {
    handle,
    append,
    authorized,
    summary: () => Object.fromEntries([...state].map(([name, q]) => [name, { last: q.last, waiting: q.waiters.size }])),
    close() {
      for (const q of state.values()) for (const wake of [...q.waiters]) wake();
    },
  };
}

/**
 * 起协调口。
 * @param {object} o
 * @param {number} o.port 0 取随机端口
 * @param {string} [o.host] 缺省 127.0.0.1；跨机时给 0.0.0.0
 * @param {(req, res, url: URL, send: typeof sendJson) => Promise<boolean> | boolean} [o.extra] 别的路径；认了回 true
 * @param {Parameters<typeof createMailbox>[0]} [o.mail] 给了就开信箱（`/mail/*`），不给回 404 `mail-disabled`
 * @returns {Promise<{ server: http.Server, port: number, url: string, kv: Map<string, unknown>, close: () => Promise<void> }>} 绑不上时 reject
 */
export function startCoordServer({ port, host = '127.0.0.1', extra, mail } = {}) {
  const kv = new Map();
  const waiters = new Map();
  const mailbox = mail ? createMailbox(mail) : null;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://coord.local');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, keys: [...kv.keys()], ...(mailbox ? { mail: mailbox.summary() } : {}) });
      }
      if (url.pathname === '/mail' || url.pathname.startsWith('/mail/')) {
        if (!mailbox) return sendJson(res, 404, { ok: false, error: 'mail-disabled' });
        return await mailbox.handle(req, res, url);
      }
      const m = /^\/kv\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const key = decodeURIComponent(m[1]);
        // 开了信箱（公网上的协调口）时 KV 也要同一个令牌：成员配置里有项目口令
        if (mailbox && !mailbox.authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        if (!KEY_RE.test(key)) return sendJson(res, 400, { ok: false, error: 'bad-key' });
        if (req.method === 'PUT') {
          let value;
          try { value = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'bad-json' }); }
          kv.set(key, value);
          for (const w of waiters.get(key) ?? []) w();
          waiters.delete(key);
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'GET') {
          const wait = Math.min(Number(url.searchParams.get('wait') ?? 0) || 0, 60_000);
          if (!kv.has(key) && wait > 0) {
            await new Promise((resolve) => {
              const t = setTimeout(resolve, wait);
              const list = waiters.get(key) ?? [];
              list.push(() => { clearTimeout(t); resolve(); });
              waiters.set(key, list);
            });
          }
          return kv.has(key) ? sendJson(res, 200, { ok: true, value: kv.get(key) }) : sendJson(res, 404, { ok: false, error: 'missing' });
        }
        return sendJson(res, 405, { ok: false });
      }
      if (extra && (await extra(req, res, url, sendJson))) return undefined;
      return sendJson(res, 404, { ok: false, error: 'no-route' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      return undefined;
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        server, port: actual, kv, mailbox,
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual}`,
        close: () => new Promise((r) => { mailbox?.close(); server.close(() => r()); server.closeAllConnections?.(); }),
      });
    });
  });
}

/**
 * 协调口的客户端（KV 那几条）。
 * @param {string} base 形如 `http://192.168.50.96:5409`
 * @param {string} [token] 协调口开了信箱时 KV 要的 `X-Mail-Token`；缺省取环境变量 `PROBE_MAIL_TOKEN`，都没有就不带
 */
export function coordClient(base, token = process.env.PROBE_MAIL_TOKEN) {
  const root = String(base).replace(/\/+$/, '');
  const auth = token ? { 'X-Mail-Token': token } : {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const client = {
    base: root,
    async put(key, value) {
      const res = await fetch(`${root}/kv/${encodeURIComponent(key)}`, {
        method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`协调口 PUT ${key} 回 ${res.status}`);
    },
    /** 取一次（最多等 waitMs）；没有回 null */
    async get(key, waitMs = 0) {
      const res = await fetch(`${root}/kv/${encodeURIComponent(key)}?wait=${Math.max(0, waitMs)}`, { headers: auth, signal: AbortSignal.timeout(waitMs + 10_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`协调口 GET ${key} 回 ${res.status}`);
      return (await res.json()).value ?? null;
    },
    /** 等到这个键出现，或者到 deadline（毫秒时间戳）；协调口暂时连不上就隔 500 ms 再试 */
    async take(key, deadline) {
      while (Date.now() < deadline) {
        const wait = Math.max(1, Math.min(30_000, deadline - Date.now()));
        try {
          const v = await client.get(key, wait);
          if (v !== null) return v;
        } catch { await sleep(500); }
      }
      return null;
    },
  };
  return client;
}

/**
 * 信箱的客户端。
 * @param {string} base 形如 `https://203-0-113-16.sslip.io/coord`
 * @param {string} token `X-Mail-Token`
 */
export function mailClient(base, token) {
  const root = String(base).replace(/\/+$/, '');
  const headers = { 'X-Mail-Token': token };
  return {
    async send(queue, { from, kind, ref = null, body }) {
      const res = await fetch(`${root}/mail/${encodeURIComponent(queue)}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, kind, ref, body }), signal: AbortSignal.timeout(15_000),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) throw Object.assign(new Error(`信箱 POST ${queue} 回 ${res.status}${j?.error ? `：${j.error}` : ''}`), { status: res.status });
      return j;
    },
    /** 取 after 之后的消息，最多挂 waitS 秒 */
    async read(queue, after = 0, waitS = 0) {
      const res = await fetch(`${root}/mail/${encodeURIComponent(queue)}?after=${after}&wait=${waitS}`, {
        headers, signal: AbortSignal.timeout((waitS + 15) * 1000),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) throw Object.assign(new Error(`信箱 GET ${queue} 回 ${res.status}${j?.error ? `：${j.error}` : ''}`), { status: res.status });
      return j;
    },
  };
}

async function cli(argv) {
  const [cmd, ...rest] = argv;
  const arg = (name, fallback) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback);
  const token = process.env.PROBE_MAIL_TOKEN;
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  if (cmd === 'serve') {
    if (!token) { console.error('缺环境变量 PROBE_MAIL_TOKEN'); return 2; }
    const c = await startCoordServer({
      port: Number(arg('--port', '8799')), host: arg('--host', '127.0.0.1'),
      mail: { token, file: arg('--mail-file', null), log: (event, fields) => out({ t: new Date().toISOString(), event, ...fields }) },
    });
    out({ t: new Date().toISOString(), event: 'coord.listen', port: c.port, mail: c.mailbox.summary() });
    return new Promise(() => {});
  }
  if (!token) { console.error('缺环境变量 PROBE_MAIL_TOKEN'); return 2; }
  const base = arg('--base', null);
  const queue = arg('--queue', null);
  if (!base || !queue) { console.error('要给 --base 与 --queue'); return 2; }
  const mc = mailClient(base, token);
  if (cmd === 'send') {
    const bodyFile = arg('--body-file', null);
    const body = bodyFile ? fs.readFileSync(bodyFile, 'utf8') : arg('--body', null);
    if (body === null) { console.error('要给 --body 或 --body-file'); return 2; }
    const ref = arg('--ref', null);
    const r = await mc.send(queue, { from: arg('--from', 'local'), kind: arg('--kind', 'instruction'), ref: ref === null ? null : Number(ref), body });
    out({ ok: true, queue, seq: r.seq, t: r.t });
    return 0;
  }
  if (cmd === 'wait') {
    const stateFile = arg('--state', null);
    let after = Number(arg('--after', '0'));
    if (stateFile && fs.existsSync(stateFile)) after = Number(JSON.parse(fs.readFileSync(stateFile, 'utf8')).after ?? after);
    const timeoutMin = Number(arg('--timeout-min', '0'));
    const deadline = timeoutMin > 0 ? Date.now() + timeoutMin * 60_000 : Infinity;
    let backoff = 1000;
    while (Date.now() < deadline) {
      try {
        const r = await mc.read(queue, after, 25);
        backoff = 1000;
        if (r.messages.length) {
          for (const m of r.messages) out(m);
          after = r.messages.at(-1).seq;
          if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ after }));
          return 0;
        }
      } catch (e) {
        if (e.status === 401 || e.status === 404) { console.error(String(e.message)); return 2; }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
    return 3;
  }
  console.error('用法见文件头：serve / send / wait');
  return 2;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  // 用 exitCode 自然退出，不调 process.exit：Windows 上 fetch 的连接还没收完时硬退会撞 libuv 断言（退出码 127）
  cli(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exitCode = code; }, (e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
}
