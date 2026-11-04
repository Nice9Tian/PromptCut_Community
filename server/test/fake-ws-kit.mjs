/**
 * For testing and probes only; must not be referenced by production code.
 *
 * Shared utilities for M5a network layer tests (contract `docs/plan/render-queue-contract.md` G.9)
 * and probes (G.8):
 *
 *   wsClient(url, protocols?)        Node built-in WebSocket client; queues received messages,
 *                                    waits on conditions
 *   rawHandshake(port, { protocols, path })   Raw TCP handshake, gets status code and response
 *                                             headers (tests 401 / subprotocol echo)
 *   createTcpProxy({ target })       Controllable TCP proxy: cutAll() forcibly disconnects,
 *                                    mode = 'pass' | 'reject', retarget()
 *   createSleepExecutor({ taskMs })  Executor that sleeps using real timers (executor shape
 *                                    from contract D.1)
 *   refusingPort()                   Port held by the test itself that RSTs on connect
 *                                    ("unreachable" address); close when done
 *   waitFor(pred, ms)                Polls until condition is met
 *   randomToken()                    32-byte random base64url (token format in G.5), generated on
 *                                    the fly in tests, not hardcoded
 *   snapshotTaskInput(...)           Creates a valid snapshot fine-grained task (contract A.4)
 *
 * Imports only Node built-in modules.
 */
import { connect as netConnect, createServer as netCreateServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';

export const randomToken = () => randomBytes(32).toString('base64url');

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Polls until pred() returns truthy; throws on timeout (with what description). */
export async function waitFor(pred, ms = 3000, what = 'condition') {
  const until = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what} (${ms} ms)`);
    await sleep(5);
  }
}

/** Connects using Node built-in WebSocket; queues received messages and waits on conditions. */
export function wsClient(url, protocols) {
  const ws = protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols);
  const inbox = [];
  const all = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { msg = { __raw: String(e.data) }; }
    all.push(msg);
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('Connection failed')), { once: true });
  });
  opened.catch(() => {});
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e), { once: true }));
  return {
    ws, opened, closed,
    /** All received messages (including those already consumed by next). */
    all,
    /** Messages not yet consumed by next. */
    inbox,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next(match = () => true, ms = 2000) {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) { waiters.splice(k, 1); reject(new Error(`timed out waiting for a message; received so far: ${JSON.stringify(all).slice(0, 800)}`)); }
        }, ms);
      });
    },
    /** Waits ms milliseconds; returns matching messages arriving in inbox (used to assert "not received"). */
    async quiet(match = () => true, ms = 150) {
      const before = all.length;
      await sleep(ms);
      return all.slice(before).filter(match);
    },
    close() { try { ws.close(); } catch { /* Closed */ } },
  };
}

export const byType = (type) => (m) => m?.type === type;
export const byReq = (reqId) => (m) => m?.reqId === reqId;

/**
 * Raw TCP handshake: sends Upgrade request (optionally with Sec-WebSocket-Protocol), reads
 * until response headers.
 * → { status, headers: { lowercaseName: value }, rawHead, sock }. Caller is responsible
 * for sock.destroy().
 */
export async function rawHandshake(port, { protocols, path = '/', host = '127.0.0.1' } = {}) {
  const sock = netConnect(port, host);
  sock.on('error', () => {});
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  let buf = Buffer.alloc(0);
  const key = randomBytes(16).toString('base64');
  const lines = [
    `GET ${path} HTTP/1.1`, `Host: ${host}:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
  ];
  if (protocols !== undefined) lines.push(`Sec-WebSocket-Protocol: ${[].concat(protocols).join(', ')}`);
  sock.write(`${lines.join('\r\n')}\r\n\r\n`);
  const head = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for the handshake response')), 3000);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      clearTimeout(t);
      sock.off('data', onData);
      resolve(buf.subarray(0, end).toString('latin1'));
    };
    sock.on('data', onData);
    sock.once('close', () => { clearTimeout(t); resolve(buf.toString('latin1')); });
  });
  const [statusLine, ...rest] = head.split('\r\n');
  const headers = {};
  for (const line of rest) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  return { status: Number(statusLine.split(' ')[1]), headers, rawHead: head, sock, acceptOk: headers['sec-websocket-accept'] === accept };
}

/**
 * Controllable TCP proxy (for testing, does not parse WebSocket):
 *   mode = 'pass'    Normal forwarding
 *   mode = 'reject'  Disconnects new connections immediately upon connect (simulates unreachable)
 *   cutAll()         Sever both ends of existing connections (simulates server forced disconnect /
 *                    network drop)
 *   retarget(port)   Redirects subsequent new connections to another port
 *   accepted         Cumulative accepted connection count (including rejected ones)
 */
export async function createTcpProxy({ target, host = '127.0.0.1' }) {
  let targetPort = target;
  const pairs = new Set();
  const proxy = {
    mode: 'pass',
    accepted: 0,
    port: 0,
    cutAll() {
      for (const p of pairs) { p.a.destroy(); p.b.destroy(); }
      pairs.clear();
    },
    retarget(port) { targetPort = port; },
    live: () => pairs.size,
    close() {
      proxy.cutAll();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  const server = netCreateServer((a) => {
    proxy.accepted += 1;
    a.on('error', () => {});
    if (proxy.mode === 'reject') { a.destroy(); return; }
    const b = netConnect(targetPort, host);
    b.on('error', () => {});
    const pair = { a, b };
    pairs.add(pair);
    a.pipe(b);
    b.pipe(a);
    const drop = () => { pairs.delete(pair); a.destroy(); b.destroy(); };
    a.on('close', drop);
    b.on('close', drop);
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  proxy.port = server.address().port;
  return proxy;
}

/** Starts HTTP server responding only with fixed /healthz (for T6). Never responds when body is null (tests timeout). */
export async function healthServer(body) {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (body === null) return; // Hang
    if (req.url?.startsWith('/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/**
 * An "unreachable" port: held by the test itself, immediately RSTs on connect (`{ port, close }`,
 * close when done).
 *
 * Avoids "claim an idle port then close it and assume nobody listens": full test runs execute
 * dozens of parallel processes, so a closed port can be seized by another process at any moment
 * (Windows assigns sequentially and wraps around; other OSes assign randomly), turning what
 * "should be unreachable" into connecting to someone else's service.
 * Holding it prevents this; to callers the effect is identical to rejection (fetch / http.request /
 * WebSocket all error immediately).
 */
export async function refusingPort() {
  const server = netCreateServer((socket) => {
    socket.on('error', () => {});
    if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
    else socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/**
 * Executor that sleeps using real timers (contract D.1). render sleeps for taskMs (reporting
 * progress every 50 ms), abortable by signal.
 * plan is unsupported (these tests and probes only send fine-grained tasks). calls records task id
 * of each render.
 */
export function createSleepExecutor({ taskMs = 50 } = {}) {
  const calls = [];
  return {
    calls,
    plan: async () => { throw Object.assign(new Error('sleep-executor does not count as a plan'), { retryable: false }); },
    render(task, { signal, progress }) {
      calls.push(task.id);
      return new Promise((resolve, reject) => {
        let done = 0;
        const step = Math.min(50, taskMs);
        const iv = setInterval(() => { done += 1; try { progress?.(done); } catch { /* Ignore */ } }, step);
        const t = setTimeout(() => { clearInterval(iv); resolve({ frames: task.range ? task.range.to - task.range.from + 1 : 0 }); }, taskMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          clearInterval(iv);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    },
  };
}

/** Creates a valid snapshot fine-grained task (contract A.4: id = `snapshot:${resultKey}:${from}-${to}`). */
export function snapshotTaskInput({ resultKey, from = 0, to = 29, projectId = 'probe-project', projectRev = 1, weight = 'light' }) {
  return {
    id: `snapshot:${resultKey}:${from}-${to}`,
    kind: 'snapshot',
    tier: 'shared',
    resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId, projectRev },
    input: {},
    weight: { class: weight, estMs: null, frames: to - from + 1 },
    requires: {},
    priority: 0,
  };
}
