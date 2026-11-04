/**
 * Shared coordination endpoint for cross-machine probes (`shared-project-probe.mjs` internet /
 * LAN mode, `render-host-probe.mjs` cross-machine mode). Roles only exchange configuration and
 * completion signals through it, without sharing filesystems. Uses only Node built-in modules.
 *
 * Shape (one coordination endpoint serves these routes simultaneously; multiple probes can share
 * the same endpoint):
 *   GET  /healthz                    `{ ok: true, keys: [...] }`
 *   PUT  /kv/<key>                   JSON request body, stored and wakes up waiters for this key
 *   GET  /kv/<key>?wait=<ms>         `{ ok: true, value }`; if absent, wait (up to 60 s); 404 on timeout
 *   Remaining paths handled by `extra(req, res, url)` (`render-host-probe`'s `/configs/*`,
 *   `/ready/*`, `/round/*`, `/result/*`, `/state`, `/stop`); 404 if no `extra` or unrecognized.
 * Keys: `[A-Za-z0-9._-]{1,64}`. The coordination endpoint has no authentication, and config
 * contains passphrases for probe-created projects: bind only to trusted subnets, shut down after
 * run.
 *
 * Additionally, an HTTP mailbox between two Agents (`mail` option, see `createMailbox`; unrelated
 * to document service transport):
 *   POST /mail/<queue>, GET /mail/<queue>?after=<seq>&wait=<seconds>, each request carries `X-Mail-Token`.
 *   When mailbox is enabled, `/kv/*` also requires the same token (`coordClient` automatically
 *   gets it from environment variable `PROBE_MAIL_TOKEN`); `/healthz` does not.
 *
 * CLI (token is only taken from environment variable `PROBE_MAIL_TOKEN`, no CLI arguments accepted
 * to avoid entering process list and history):
 *   node scripts/probes/probe-coord.mjs serve --port 8799 [--host 0.0.0.0] [--mail-file <file>]
 *   node scripts/probes/probe-coord.mjs send --base <url> --queue to-cloud --from local --kind instruction [--ref <seq>] (--body <text> | --body-file <file>)
 *   node scripts/probes/probe-coord.mjs wait --base <url> --queue to-local [--after <seq> | --state <file>] [--timeout-min 0]
 *     `wait` repeatedly long polls, prints when at least one message is received (one JSON per line)
 *     and exits with 0; `--state` records the last read seq, reading after it next time;
 *     `--timeout-min` exits with 3 if nothing received by timeout (0 means no limit); network errors
 *     retry continuously with backoff.
 *   `--kind` takes instruction / receipt (`--ref` points to instruction seq) / question (matters to
 *   be decided by peer or user) / status (check in and status).
 *
 * Waiting for messages in Claude Code: Use a `wait` command running in background (Bash background
 * mode), having it repeatedly long poll within process (holding for 25 s each time); exit and wake
 * the session only upon receiving messages; do not have model poll periodically at intervals.
 * `--state` file records the last read seq, and the next `wait` reads after it, so each time after
 * being awakened and processing messages, simply start another identical background `wait` to
 * avoid missed reads or duplicate reads.
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

/** Read JSON request body (returns `{}` for empty body); throws error if over 4 MiB or not JSON */
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
  /** Maximum duration to hold long polling (within nginx default `proxy_read_timeout` 60 s) */
  MAX_WAIT_MS: 25_000,
  /** How many entries each queue keeps in memory; earlier ones are stored only in files */
  KEEP: 1000,
  /** Upper limit for a single message (JSON of the entire envelope) */
  MAX_MESSAGE_BYTES: 256 * 1024,
  /** Maximum number of entries returned by a single GET */
  MAX_BATCH: 100,
});

const FROM_RE = /^[A-Za-z0-9._@-]{1,64}$/;

/**
 * HTTP mailbox between two Agents (not document service transport). Each queue is unidirectional
 * and append-only; the server adds `seq` (starting from 1 per queue) and `t`.
 *   POST /mail/<queue>                    `{ from, kind, ref?, body }` → `{ ok, seq, t }`
 *   GET  /mail/<queue>?after=<seq>&wait=<sec> → `{ ok, messages: [envelope…], last }`;
 *        hangs and waits if no new messages, up to `MAX_WAIT_MS`
 * Envelope: `{ queue, seq, t, from, kind, ref, body }`; `kind` is instruction / receipt / question /
 * status, and `ref` is the peer seq referenced by the receipt (null if none).
 * Every request must include the `X-Mail-Token` header, returning 401 if incorrect. Tokens do not
 * enter logs or responses.
 * If `file` is provided, append line by line as JSON lines, read back on restart, and continue
 * numbering seq.
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
  if (typeof token !== 'string' || token.length < 16) throw new TypeError('Mailbox token must be at least 16 characters');
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
 * Start the coordination port.
 * @param {object} o
 * @param {number} o.port 0 picks a random port
 * @param {string} [o.host] defaults to 127.0.0.1; specify 0.0.0.0 for cross-machine access
 * @param {(req, res, url: URL, send: typeof sendJson) => Promise<boolean> | boolean} [o.extra] other routes; return true if handled
 * @param {Parameters<typeof createMailbox>[0]} [o.mail] if provided, enable mailbox (`/mail/*`); otherwise return 404 `mail-disabled`
 * @returns {Promise<{ server: http.Server, port: number, url: string, kv: Map<string, unknown>, close: () => Promise<void> }>} reject if binding fails
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
        // When mailbox is enabled (coordination port on public internet), KV also requires the same token:
        // member config has the project passphrase
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
 * Coordination port client (the KV endpoints).
 * @param {string} base e.g. `http://192.168.50.96:5409`
 * @param {string} [token] `X-Mail-Token` required by KV when coordination port has mailbox enabled;
 * defaults to env var `PROBE_MAIL_TOKEN`, omitted if neither exists
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
      if (!res.ok) throw new Error(`Coordination endpoint PUT ${key} returned ${res.status}`);
    },
    /** Fetch once (wait up to waitMs); return null if none */
    async get(key, waitMs = 0) {
      const res = await fetch(`${root}/kv/${encodeURIComponent(key)}?wait=${Math.max(0, waitMs)}`, { headers: auth, signal: AbortSignal.timeout(waitMs + 10_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Coordination endpoint GET ${key} returned ${res.status}`);
      return (await res.json()).value ?? null;
    },
    /** Wait until this key appears or deadline (millisecond timestamp); retry every 500 ms if coordination port is temporarily unreachable */
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
 * Mailbox client.
 * @param {string} base e.g. `https://203-0-113-16.sslip.io/coord`
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
      if (!res.ok || !j?.ok) throw Object.assign(new Error(`Mailbox POST ${queue} returned ${res.status}${j?.error ? `: ${j.error}` : ''}`), { status: res.status });
      return j;
    },
    /** Fetch messages after after, holding for up to waitS seconds */
    async read(queue, after = 0, waitS = 0) {
      const res = await fetch(`${root}/mail/${encodeURIComponent(queue)}?after=${after}&wait=${waitS}`, {
        headers, signal: AbortSignal.timeout((waitS + 15) * 1000),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) throw Object.assign(new Error(`Mailbox GET ${queue} returned ${res.status}${j?.error ? `: ${j.error}` : ''}`), { status: res.status });
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
    if (!token) { console.error('Missing environment variable PROBE_MAIL_TOKEN'); return 2; }
    const c = await startCoordServer({
      port: Number(arg('--port', '8799')), host: arg('--host', '127.0.0.1'),
      mail: { token, file: arg('--mail-file', null), log: (event, fields) => out({ t: new Date().toISOString(), event, ...fields }) },
    });
    out({ t: new Date().toISOString(), event: 'coord.listen', port: c.port, mail: c.mailbox.summary() });
    return new Promise(() => {});
  }
  if (!token) { console.error('Missing environment variable PROBE_MAIL_TOKEN'); return 2; }
  const base = arg('--base', null);
  const queue = arg('--queue', null);
  if (!base || !queue) { console.error('--base and --queue are required'); return 2; }
  const mc = mailClient(base, token);
  if (cmd === 'send') {
    const bodyFile = arg('--body-file', null);
    const body = bodyFile ? fs.readFileSync(bodyFile, 'utf8') : arg('--body', null);
    if (body === null) { console.error('--body or --body-file is required'); return 2; }
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
  console.error('See the file header for usage: serve / send / wait');
  return 2;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  // Exit naturally via exitCode instead of calling process.exit: hard exit on Windows while fetch
  // connections are still closing hits a libuv assertion (exit code 127)
  cli(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exitCode = code; }, (e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
}
