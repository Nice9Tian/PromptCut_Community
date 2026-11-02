/**
 * For testing only; must not be referenced by production code.
 *
 * Shared test fixture for both document service transports (WebSocket and HTTP long polling,
 * `docs/plan/http-transport-contract.md`):
 *
 *   transportClient(kind, url, protocols?)  Uses Node built-in WebSocket for kind 'ws', and
 *                                           `HttpWebSocket` for 'http'; returns an object with the
 *                                           same shape as wsClient from fake-ws-kit
 *                                           (opened / closed / send / next / quiet / close).
 *                                           Note: `HttpWebSocket` still uses v1 long polling
 *                                           protocol (batch number, `{ seq, data }` wrapper),
 *                                           incompatible with v2 server
 *                                           (`docservice/http-transport.mjs` under session layer);
 *                                           will be updated together when HT-b updates the client.
 *   authByProtocols(req)                    Determines principal by `x-user.<name>`,
 *                                           `x-role.<role>`, `x-conv.<id>`, `x-dev.<device>` in the
 *                                           subprotocol list; rejects `x-user.deny`. Both
 *                                           transports pass to it via `sec-websocket-protocol`.
 *   protocolsOf({ user, role, conv, dev })  Builds the list above (first item promptcut.v1).
 *   lp(base)                                Raw client hitting the long polling endpoint directly
 *                                           (contract v2 section 6): open / send / recv / close /
 *                                           options, returning { status, body, headers }. The open
 *                                           list must include session items itself.
 *   recvUntil(client, sid, match, opts)     Repeatedly GETs to receive frames (frames are message
 *                                           text with seq) until match is true or has closed.
 *
 * Imports only Node built-in modules and `render-node/http-transport.mjs` under test.
 */
import { HttpWebSocket } from '../render-node/http-transport.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Subprotocol list (`sec-websocket-protocol` header) */
function offered(req) {
  const raw = req?.headers?.['sec-websocket-protocol'];
  if (raw === undefined) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

export function authByProtocols(req) {
  const list = offered(req);
  const pick = (prefix) => list.find((p) => p.startsWith(prefix))?.slice(prefix.length) ?? null;
  const user = pick('x-user.') ?? 'u-default';
  if (user === 'deny') return null;
  const role = pick('x-role.');
  if (!role) return { userId: user, tenantId: 't-test' };
  const dev = pick('x-dev.') ?? 'dev-1';
  const conv = pick('x-conv.');
  return {
    userId: `${user}@${dev}`, tenantId: 't-test', scope: 'member', username: user, deviceId: dev, deviceName: dev,
    creator: false, role, conversation: conv ? Number(conv) : null, owner: null,
  };
}

export function protocolsOf({ user, role, conv, dev } = {}) {
  const out = ['promptcut.v1'];
  if (user) out.push(`x-user.${user}`);
  if (role) out.push(`x-role.${role}`);
  if (conv) out.push(`x-conv.${conv}`);
  if (dev) out.push(`x-dev.${dev}`);
  return out;
}

export function transportClient(kind, url, protocols) {
  const Impl = kind === 'http' ? HttpWebSocket : WebSocket;
  const ws = protocols === undefined ? new Impl(url) : new Impl(url, protocols);
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
    ws.addEventListener('error', () => reject(new Error(`${kind} connection failed`)), { once: true });
  });
  opened.catch(() => {});
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e), { once: true }));
  return {
    kind, ws, opened, closed, all, inbox,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next(match = () => true, ms = 3000) {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) { waiters.splice(k, 1); reject(new Error(`[${kind}] timed out waiting for a message; received so far: ${JSON.stringify(all).slice(0, 800)}`)); }
        }, ms);
      });
    },
    async quiet(match = () => true, ms = 150) {
      const before = all.length;
      await sleep(ms);
      return all.slice(before).filter(match);
    },
    close() { try { ws.close(); } catch { /* Closed */ } },
  };
}

/** Raw client for long polling endpoint (tests server protocol itself) */
export function lp(base) {
  const root = base.replace(/\/+$/, '');
  const call = async (method, route, { headers = {}, body, query = '' } = {}) => {
    const res = await fetch(`${root}/lp/${route}${query}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { __raw: text }; }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  const bearer = (sid) => ({ authorization: `Bearer ${sid}` });
  return {
    open(protocols = ['promptcut.v1', 'promptcut.session.new'], headers = {}) {
      const h = { ...headers };
      if (protocols !== null) h['x-promptcut-protocols'] = [].concat(protocols).join(', ');
      return call('POST', 'open', { headers: h, body: '{}' });
    },
    /** `frames`: objects (carrying their own seq) or serialized text */
    send(sid, frames) {
      return call('POST', 'send', { headers: { ...bearer(sid), 'content-type': 'application/json' }, body: JSON.stringify({ frames: frames.map((f) => (typeof f === 'string' ? f : JSON.stringify(f))) }) });
    },
    sendRaw(sid, body) {
      return call('POST', 'send', { headers: { ...bearer(sid), 'content-type': 'application/json' }, body });
    },
    recv(sid, ack = 0, wait = 0) {
      return call('GET', 'recv', { headers: bearer(sid), query: `?ack=${ack}&wait=${wait}` });
    },
    close(sid, body = {}) {
      return call('POST', 'close', { headers: { ...bearer(sid), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    },
    options(route, headers = {}) {
      return call('OPTIONS', route, { headers });
    },
    call,
  };
}

/** Receives frames until match is true (long polling); returns { frames: received message objects (deduplicated by seq), ack } */
export async function recvUntil(client, sid, match, { ack = 0, ms = 3000, wait = 500 } = {}) {
  const until = Date.now() + ms;
  const got = [];
  let last = ack;
  while (Date.now() < until) {
    const r = await client.recv(sid, last, wait);
    if (r.status !== 200) throw new Error(`recv ${r.status} ${JSON.stringify(r.body)}`);
    for (const text of r.body.frames) {
      const m = JSON.parse(text);
      if (!(m.seq > last)) continue;
      last = m.seq;
      got.push(m);
    }
    if (r.body.closed || got.some(match)) return { frames: got, ack: last, closed: r.body.closed };
  }
  throw new Error(`timed out waiting for a frame; received so far: ${JSON.stringify(got).slice(0, 800)}`);
}
