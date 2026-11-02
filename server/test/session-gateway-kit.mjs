/**
 * For testing and local verification only; production code must not reference this.
 *
 * Session gateway: a **minimal test session server stub** that speaks session per contract
 * `docs/plan/http-transport-contract.md` Sections 3, 4.1, 4.2, 5, and 16 and assumptions (H3 to H6)
 * of tester `server/test/ht-kit.mjs`, opening a legacy WebSocket (without session items) behind it
 * for each session to connect to the real document service. This allows client session layer
 * (`server/render-node/session-link.mjs`) to test "resuming when transport drops, retransmitting
 * from both sides, disconnecting when core is gone" against real business modules before server
 * session layer (`claude/http-transport`) is merged. It is not an implementation of server session
 * layer, nor does it replace it.
 *
 *   - Create session: if `promptcut.session.new` is in list, strip it and pass remaining items
 *     as-is to upstream handshake; only respond with 101 once upstream connects, then send
 *     `session.welcome { sid, resumed: false, ack: 0, retainMs, transport: 'ws' }`; respond with
 *     401 if upstream handshake is rejected.
 *   - Resume: `promptcut.session.<sid>.<ack>`: accept upgrade first; if session exists, attach
 *     it (close old transport with 4009), release up to ack, send welcome (`resumed: true`, `ack`
 *     is largest client seq received in full), and retransmit by original seq; if absent: close
 *     with 4410 if previously ended (tombstone), otherwise 4404.
 *   - Sequence numbers and acks: both directions per Section 3.3; control messages `session.ack`,
 *     `session.close`; skipped sequence 1002 `bad-seq`.
 *   - Transport disconnected: detach, retain for `retainMs`, and end session when expired (close
 *     upstream, record tombstone). Upstream closed: session ends with upstream close code.
 *   - Legacy client without session items (contract Section 3.6): pass upgrade request through
 *     to upstream as-is (TCP passthrough).
 *   - Given `httpUpstream`: pass ordinary HTTP requests (shared project challenge, create project)
 *     through to it as-is; pages and probes can use gateway as document service address.
 *   - `cutAll()`: cut all client transports from this server side (without sending close frames);
 *     `onForward(msg)`: each business message forwarded to upstream.
 *
 * Imports only Node built-in modules and `../docservice/ws.mjs`; upstream uses Node built-in
 * `WebSocket`.
 */
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { acceptUpgrade, rejectUpgrade } from '../docservice/ws.mjs';

const PROTOCOL = 'promptcut.v1';
const SESSION_NEW = 'promptcut.session.new';
const SESSION_PREFIX = 'promptcut.session.';

/**
 * @param {object} o
 * @param {() => string} o.upstream  WebSocket address of upstream document service (function:
 *   tests can switch midway)
 * @param {number} [o.retainMs]
 * @param {number} [o.ackDelayMs]
 * @param {number} [o.ackEvery]
 * @param {(event: string, fields?: object) => void} [o.log]
 */
export async function startSessionGateway({ upstream, httpUpstream = null, retainMs = 60_000, ackDelayMs = 1000, ackEvery = 32, log = () => {}, onForward = null, port = 0, host = '127.0.0.1' } = {}) {
  const sessions = new Map();
  const tombstones = new Map();
  const stats = { opened: 0, resumed: 0, expired: 0, superseded: 0, badSeq: 0, fromClient: 0, toClient: 0, legacy: 0 };
  const upstreamOf = typeof upstream === 'function' ? upstream : () => upstream;

  function end(s, code, reason, { closeUpstream = true } = {}) {
    if (s.ended) return;
    s.ended = true;
    sessions.delete(s.sid);
    tombstones.set(s.sid, { code, reason });
    clearTimeout(s.retainTimer);
    clearTimeout(s.ackTimer);
    if (s.ws) { try { s.ws.close(code, reason); } catch { /* Closed */ } }
    s.ws = null;
    if (closeUpstream) { try { s.up.close(1000, 'session-ended'); } catch { /* Closed */ } }
    log('gw.end', { code, reason });
  }

  function sendAck(s) {
    clearTimeout(s.ackTimer);
    s.ackTimer = null;
    if (s.ws && s.inUnacked > 0) {
      s.ws.send(JSON.stringify({ type: 'session.ack', ack: s.inAck }));
      s.inUnacked = 0;
    }
  }

  function write(s, entry) {
    if (!s.ws) return;
    const msg = s.inAck > 0 ? { ...entry.msg, ack: s.inAck } : entry.msg;
    s.ws.send(JSON.stringify(msg));
    if (s.inAck > 0) { s.inUnacked = 0; clearTimeout(s.ackTimer); s.ackTimer = null; }
    stats.toClient++;
  }

  function onPeerAck(s, n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > s.outSeq) {
      stats.badSeq++;
      end(s, 1002, 'bad-seq');
      return false;
    }
    while (s.outBuf.length && s.outBuf[0].seq <= n) s.outBuf.shift();
    return true;
  }

  function attach(s, ws, resumed) {
    if (s.ws) {
      stats.superseded++;
      const old = s.ws;
      s.ws = null;
      try { old.close(4009, 'superseded'); } catch { /* Closed */ }
    }
    clearTimeout(s.retainTimer);
    s.retainTimer = null;
    s.ws = ws;
    ws.send(JSON.stringify({ type: 'session.welcome', sid: s.sid, resumed, ack: s.inAck, retainMs, transport: 'ws' }));
    s.inUnacked = 0;
    for (const entry of [...s.outBuf]) write(s, entry);
    ws.on('message', (text) => {
      if (s.ws !== ws || s.ended) return;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type.startsWith('session.')) {
        if (msg.type === 'session.ack') onPeerAck(s, msg.ack);
        else if (msg.type === 'session.close') end(s, 1000, 'closed');
        return;
      }
      if (msg.ack !== undefined && !onPeerAck(s, msg.ack)) return;
      if (!Number.isSafeInteger(msg.seq) || msg.seq > s.inAck + 1) { stats.badSeq++; end(s, 1002, 'bad-seq'); return; }
      if (msg.seq <= s.inAck) return;
      s.inAck = msg.seq;
      const { seq: _s, ack: _a, ...body } = msg;
      stats.fromClient++;
      try { onForward?.(body); } catch { /* Observer errors do not affect forwarding */ }
      try { s.up.send(JSON.stringify(body)); } catch { /* Upstream is closing */ }
      s.inUnacked++;
      if (s.inUnacked >= ackEvery) sendAck(s);
      else if (!s.ackTimer) s.ackTimer = setTimeout(() => sendAck(s), ackDelayMs);
    });
    ws.on('close', () => {
      if (s.ws !== ws || s.ended) return;
      s.ws = null;
      log('gw.detach', {});
      s.retainTimer = setTimeout(() => { stats.expired++; end(s, 1006, 'timeout'); }, retainMs);
    });
  }

  // Ordinary HTTP requests (shared project challenge, create project, etc.): forward as-is to
  // `httpUpstream` if provided, otherwise 404
  const server = http.createServer((req, res) => {
    if (!httpUpstream) { res.writeHead(404); res.end(); return; }
    const target = new URL(req.url ?? '/', httpUpstream);
    const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: `${target.pathname}${target.search}`, headers: { ...req.headers, host: target.host } }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const items = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    if (items[0] !== PROTOCOL) { rejectUpgrade(socket, 400, 'Bad Request'); return; }
    const resumeItem = items.find((p) => p.startsWith(SESSION_PREFIX) && p !== SESSION_NEW);
    if (resumeItem) {
      if (items.length !== 2) { rejectUpgrade(socket, 400, 'Bad Request'); return; }
      const rest = resumeItem.slice(SESSION_PREFIX.length);
      const i = rest.lastIndexOf('.');
      const sid = rest.slice(0, i);
      const ack = Number(rest.slice(i + 1));
      const ws = acceptUpgrade(req, socket, head, { maxPayload: 16 * 1024 * 1024, protocol: PROTOCOL });
      if (!ws) return;
      ws.on('close', () => {});
      const s = sessions.get(sid);
      if (!s) {
        const t = tombstones.get(sid);
        if (t) ws.close(4410, `${t.code} ${t.reason}`);
        else ws.close(4404, 'no-session');
        return;
      }
      if (!onPeerAck(s, ack)) { ws.close(4410, '1002 bad-seq'); return; }
      stats.resumed++;
      log('gw.resume', {});
      attach(s, ws, true);
      return;
    }
    if (!items.includes(SESSION_NEW)) {
      // Legacy client (without session items, contract Section 3.6): forward as-is to upstream;
      // one transport is one connection
      pipeUpgrade(req, socket, head, new URL(upstreamOf()));
      stats.legacy++;
      return;
    }
    const upItems = items.filter((p) => p !== SESSION_NEW);
    const up = new WebSocket(upstreamOf(), upItems);
    let settled = false;
    const s = { sid: randomBytes(32).toString('base64url'), up, ws: null, outSeq: 0, outBuf: [], inAck: 0, inUnacked: 0, ackTimer: null, retainTimer: null, ended: false };
    up.addEventListener('message', (e) => {
      if (s.ended) return;
      let msg;
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      s.outSeq += 1;
      const entry = { seq: s.outSeq, msg: { ...msg, seq: s.outSeq } };
      s.outBuf.push(entry);
      write(s, entry);
    });
    up.addEventListener('open', () => {
      settled = true;
      const ws = acceptUpgrade(req, socket, head, { maxPayload: 16 * 1024 * 1024, protocol: PROTOCOL });
      if (!ws) { try { up.close(); } catch { /* Closed */ } return; }
      sessions.set(s.sid, s);
      stats.opened++;
      log('gw.open', {});
      attach(s, ws, false);
    });
    const upGone = (code, reason) => {
      if (!settled) {
        settled = true;
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      end(s, code === 1006 || code === 1005 ? 1001 : code, reason || 'upstream-closed', { closeUpstream: false });
    };
    up.addEventListener('close', (e) => upGone(e.code, e.reason));
    up.addEventListener('error', () => upGone(1006, ''));
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    port: server.address().port,
    url: `ws://${host}:${server.address().port}/`,
    stats,
    sessions,
    /** Cut all client transports from server side (no close frames, simulating network drops); session detaches, retained */
    cutAll() {
      let n = 0;
      for (const s of sessions.values()) if (s.ws) { s.ws.terminate(); n += 1; }
      return n;
    },
    /** Server actively ends a session (tests 4003, etc.) */
    endAll(code, reason) { for (const s of [...sessions.values()]) end(s, code, reason); },
    close() {
      for (const s of [...sessions.values()]) end(s, 1001, 'server shutting down');
      return new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    },
  };
}

/**
 * Forwards an upgrade request as-is (TCP passthrough) to `target`: replaces the path with `target`'s,
 * `Host` with its host; rewrites `Sec-WebSocket-Protocol` if `protocols` is given. Returns this pair
 * of connections (`{ a, b }`), which caller can track and cut.
 */
function pipeUpgrade(req, socket, head, target, protocols = null) {
  const up = net.connect(Number(target.port || 80), target.hostname);
  up.on('error', () => socket.destroy());
  up.on('connect', () => {
    const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const lower = k.toLowerCase();
      if (lower === 'sec-websocket-protocol' && protocols) continue;
      lines.push(`${k}: ${lower === 'host' ? target.host : req.rawHeaders[i + 1]}`);
    }
    if (protocols) lines.push(`Sec-WebSocket-Protocol: ${protocols.join(', ')}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  socket.on('close', () => up.destroy());
  up.on('close', () => socket.destroy());
  return { a: socket, b: up };
}

/**
 * "Legacy server" front-end: strips session items from the handshake in front of the real document
 * service (which may already have a session layer) and does TCP passthrough; server therefore treats
 * client as a legacy client (contract Section 3.6), so client does not see `session.welcome`: used
 * to test client degradation against a legacy server without a session layer, holding true both
 * before and after server session layer merge. `cutAll()` cuts existing connections (disconnecting
 * both ends).
 */
export async function startLegacyFront({ upstream, port = 0, host = '127.0.0.1' } = {}) {
  const target = new URL(upstream);
  const pairs = new Set();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const items = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    const pair = pipeUpgrade(req, socket, head, target, items.filter((p) => !p.startsWith(SESSION_PREFIX)));
    pairs.add(pair);
    socket.on('close', () => pairs.delete(pair));
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    port: server.address().port,
    url: `ws://${host}:${server.address().port}/`,
    cutAll() { for (const p of pairs) { p.a.destroy(); p.b.destroy(); } pairs.clear(); },
    close() {
      for (const p of pairs) { p.a.destroy(); p.b.destroy(); }
      return new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    },
  };
}
