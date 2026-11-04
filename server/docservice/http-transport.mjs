/**
 * Second transport for document service: HTTP long polling (contract
 * `docs/plan/http-transport-contract.md` Section 6), hooked below the session layer (`session.mjs`).
 *
 * **Not wired in this phase** (contract header "split, 2026-09-27": HT-a covers only session model
 * and WebSocket; HTTP long polling is HT-b): `service.mjs` does not import this file, and document
 * service does not respond to `/lp/…`. When HT-b is wired, the assembly layer hooks it up as follows:
 *   const http = createHttpTransport({ sessions, authenticate, canOpen, remoteOf, normalizePrincipal, … });
 *   In standalone mode HTTP handling, run `if (http.handle(req, res)) return;` first; `http.sweep()` on
 *   each heartbeat; `http.shutdown()` on shutdown.
 * Attached mode (local document service inside vite) is not connected (semantics "embedded mode").
 *
 * Used for nodes whose egress only permits 443 HTTPS and does not support WebSocket upgrade.
 * Sessions, sequence numbers, acknowledgements, retention, and retransmissions are all in the
 * session layer; this file only forwards:
 * - `POST /lp/open`: header `X-Promptcut-Protocols` is the WebSocket subprotocol list, including
 *   session items (Section 4.1); optional `X-Promptcut-Fallback` (downgrade reason, Section 4.3
 *   item 5). A new session passes the list as `sec-websocket-protocol` to the **same**
 *   `authenticate(req)` (proof, ticket, local claim, rate limiting, loopback trust all as usual;
 *   `req.socket` is still the real socket); resuming queries only by session id, without
 *   re-authentication. Response contains session id and welcome fields;
 * - `POST /lp/send`: `Authorization: Bearer <sid>`, body `{ frames: ["<message text with seq>", …] }`,
 *   passed frame-by-frame to session layer (deduplicated by seq, gap error 1002); only one POST in
 *   flight per session at a time (subsequent ones return 409 `busy`); returns `ack` fully received
 *   by server;
 * - `GET /lp/recv?ack=&wait=`: first releases by `ack`, then returns unacknowledged frames (plain text
 *   with seq; up to 1 MiB at a time); hangs if none (only one pending GET per session, newer
 *   replaces older, older returns `superseded: true`); when session ends, returns remaining frames
 *   before returning `closed`;
 * - `POST /lp/close`: client actively ends the session.
 *
 * Transport disconnect (Section 6.5): if there is neither a pending GET nor an incoming request
 * within `waitMs + 15 s`, `sweep()` marks this transport disconnected, and the session detaches and
 * enters the retention period (no longer v1's "disconnect on expiration"); tombstones are set by the
 * session layer only when the session ends.
 * `sid` and credentials in request headers do not enter logs or URLs. Only imports Node built-in
 * modules and `session.mjs` in the same directory.
 */
import { parseSessionItem } from './session.mjs';

export const HTTP_TRANSPORT_DEFAULTS = Object.freeze({
  /** Maximum duration a pending GET can wait (takes minimum of client's `wait` and this) */
  WAIT_MS: 25_000,
  /** Upper bound for `waitMs`: idle timeout for common proxies and load balancers is 30-60 s */
  MAX_WAIT_MS: 30_000,
  /** If no pending GET or incoming request, after `waitMs` plus this duration, consider transport disconnected (Section 6.5) */
  IDLE_SLACK_MS: 15_000,
  /** How long to keep a transport after session ends if remaining frames and `closed` are uncollected */
  CLOSED_KEEP_MS: 120_000,
  /** Margin by which a POST /lp/send request body can exceed the single-frame limit */
  BODY_SLACK_BYTES: 64 * 1024,
  /** Upper limit on total frame bytes in a single GET response (at least one frame) */
  RECV_MAX_BYTES: 1024 * 1024,
  /** Request body upper limit for open / close (originally just empty or very small JSON) */
  SMALL_BODY_BYTES: 4096,
});

export const PROTOCOLS_HEADER = 'x-promptcut-protocols';
export const FALLBACK_HEADER = 'x-promptcut-fallback';
/** Downgrade reason (Section 4.3 item 5); other values are not recorded */
export const FALLBACK_REASONS = Object.freeze(['ws-error', 'ws-timeout', 'ws-closed']);

const JSON_TYPE = 'application/json; charset=utf-8';
const CORS_METHODS = 'GET, POST, OPTIONS';
const CORS_HEADERS = 'Authorization, Content-Type, X-Promptcut-Protocols, X-Promptcut-Fallback';
const CORS_MAX_AGE = '600';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byteLen = (text) => Buffer.byteLength(text, 'utf8');
const positive = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/** Subprotocol list in request headers (comma-separated, trimmed, empty items removed; duplicate headers concatenated) */
function protocolList(raw) {
  if (raw === undefined) return [];
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  return text.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** sid in `Authorization: Bearer <sid>`; returns null if missing or malformed */
function bearerOf(req) {
  const m = /^Bearer[ \t]+([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? '').trim());
  return m ? m[1] : null;
}

function fallbackOf(req) {
  const v = String(req.headers[FALLBACK_HEADER] ?? '').trim();
  return FALLBACK_REASONS.includes(v) ? v : null;
}

/**
 * Reads request body, up to `limit` bytes. Returns `{ tooLarge: true }` if exceeded (remaining
 * bytes discarded, no longer accumulated). Returns `{ aborted: true }` if client disconnects midway.
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve({ tooLarge: true });
      return;
    }
    const chunks = [];
    let size = 0;
    let over = false;
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        settle({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(over ? { tooLarge: true } : { text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => settle({ aborted: true }));
    req.on('aborted', () => settle({ aborted: true }));
  });
}

/**
 * @param {object} options
 * @param {ReturnType<import('./session.mjs').createSessionLayer>} options.sessions Session layer
 * @param {(req: object) => object | null} options.authenticate Same as WebSocket handshake
 * @param {() => null | 'closing' | 'full'} [options.canOpen] Whether new sessions can be opened
 *   (shutting down, session pool full); defaults to always
 * @param {(req: object) => string | null} [options.remoteOf] Source address, defaults to socket peer
 * @param {(principal: object) => object} [options.normalizePrincipal] Normalizes principal from auth
 *   (same-named function in assembly layer); defaults to as-is
 * @param {string} [options.prefix] Path portion of base URL (without trailing slash; empty string
 *   for root path). Endpoint is `<prefix>/lp/<name>`
 * @param {string} [options.protocol] Must be present in list and be first item; defaults to `promptcut.v1`
 * @param {number} [options.retainMs] `retainMs` in response (same value as in session layer)
 * @param {number} [options.maxFrameBytes] Single-frame limit (= WebSocket `maxPayload`)
 * @param {number} [options.waitMs]
 * @param {string[]} [options.corsOrigins] Allowed cross-origin Origins; defaults to empty: does not
 *   return any CORS headers
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function createHttpTransport({
  sessions,
  authenticate,
  admissionRefusal = () => false,
  completeAdmission = () => {},
  principalOf = () => null,
  dispatchInvocation = (_input, next) => next(),
  needsInvocation = () => false,
  internalTransport = () => false,
  transportConnected,
  canOpen = () => null,
  remoteOf = (req) => req?.socket?.remoteAddress ?? null,
  normalizePrincipal = (p) => p,
  prefix = '',
  protocol = 'promptcut.v1',
  retainMs = 60_000,
  maxFrameBytes = 1024 * 1024,
  waitMs,
  corsOrigins = [],
  now = Date.now,
  log = () => {},
} = /** @type {any} */ ({})) {
  if (!sessions || typeof sessions.openSession !== 'function') throw new TypeError('createHttpTransport: the session layer `sessions` is required');
  if (typeof authenticate !== 'function') throw new TypeError('createHttpTransport: authenticate must be a function');
  const base = String(prefix).replace(/\/+$/, '');
  const lpRoot = `${base}/lp/`;
  const waitCap = Math.min(positive(waitMs, HTTP_TRANSPORT_DEFAULTS.WAIT_MS), HTTP_TRANSPORT_DEFAULTS.MAX_WAIT_MS);
  const idleMs = waitCap + HTTP_TRANSPORT_DEFAULTS.IDLE_SLACK_MS;
  const maxFrame = positive(maxFrameBytes, 1024 * 1024);
  const maxSendBody = maxFrame + HTTP_TRANSPORT_DEFAULTS.BODY_SLACK_BYTES;
  const corsSet = new Set(Array.isArray(corsOrigins) ? corsOrigins.filter((o) => typeof o === 'string' && o !== '') : []);
  const say = (event, fields) => { try { log(event, fields); } catch { /* Logging errors do not affect transport */ } };

  /** sid → transport object for this transport (most recently connected via HTTP; kept after session ends until remaining frames fetched) */
  const bySid = new Map();
  // Active request/response pairs, including superseded transports. finish does
  // not remove an owner: both actual close events must have happened.
  const ownedRequests = new Set();
  // A response close can follow finish while its keep-alive TCP socket remains
  // open. Keep each associated socket until the actual socket close event.
  const ownedSockets = new Set();
  const fencedConns = new Set();
  const counters = { superseded: 0 };
  let shuttingDown = false;

  function track(t, req, res) {
    const record = { t, req, res, socket: req.socket };
    const closed = target => target?.closed === true;
    const actualClose = target => closed(target) ? Promise.resolve() : new Promise(resolve => target.once('close', resolve));
    record.done = Promise.all([actualClose(req), actualClose(res)]);
    ownedRequests.add(record);
    record.done.then(() => ownedRequests.delete(record));
    if (req.socket && ![...ownedSockets].some(owner => owner.t === t && owner.socket === req.socket)) {
      const owner = { t, socket: req.socket, done: actualClose(req.socket) };
      ownedSockets.add(owner);
      owner.done.then(() => ownedSockets.delete(owner));
    }
    if (fencedConns.has(t.connId)) {
      t.fenced = true; t.closed = { code: 4003, reason: 'access-revoked' }; t.rest = []; t.dead = true;
      if (bySid.get(t.sid) === t) bySid.delete(t.sid);
      res.destroy(); req.destroy(); req.socket?.destroy();
    }
  }

  // ---------- Response ----------

  function corsFor(req) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !corsSet.has(origin)) return null;
    return { 'access-control-allow-origin': origin, vary: 'Origin' };
  }

  function sendJson(res, status, body, cors) {
    if (res.headersSent || res.writableEnded) return;
    const headers = { 'content-type': JSON_TYPE, 'cache-control': 'no-store', ...(cors ?? {}) };
    if (shuttingDown) headers.connection = 'close';
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  // ---------- Transport object ----------

  /**
   * An HTTP transport (connected via an `open`). Shape seen by the session layer: `kind`, `send`,
   * `control`, `close`.
   * - `send`: Has new frames; wakes up the pending GET (frames are pulled by the GET from the session
   *   layer via `pull`, so frames are not stored here);
   * - `control`: Unused (welcome is in the open response, ack is in the send response);
   * - `close(code, reason, rest)`: 4009 means replaced by another transport (the pending GET responds
   *   with `superseded`); other codes mean the session ended, recording `closed` and remaining
   *   frames, and the pending GET responds immediately.
   */
  function newTransport(sid) {
    const t = {
      kind: 'http',
      sid,
      connId: null,
      waiter: null,
      wakeQueued: false,
      /** Session ended: { code, reason }; remaining frames are in `rest` */
      closed: null,
      rest: [],
      closedAt: 0,
      superseded: false,
      /** Deemed disconnected (sweep) or replaced: subsequent requests no longer belong to this transport */
      dead: false,
      sending: false,
      lastSeen: now(),
      send() { wake(t); },
      control() {},
      close(code, reason, rest) {
        if (code === 4009) {
          t.superseded = true;
          t.dead = true;
          const w = clearWaiter(t);
          if (w) {
            counters.superseded += 1;
            sendJson(w.res, 200, { ok: true, frames: [], closed: null, superseded: true }, w.cors);
          }
          return;
        }
        t.closed = { code, reason };
        t.rest = Array.isArray(rest) ? rest : [];
        t.closedAt = now();
        wake(t, true);
      },
    };
    return t;
  }

  function clearWaiter(t) {
    const w = t.waiter;
    if (!w) return null;
    t.waiter = null;
    clearTimeout(w.timer);
    return w;
  }

  /**
   * Immediately respond to a recv: if the session is still open, fetch frames from the session
   * layer; if ended, return remaining frames; once all returned, include `closed` and forget this
   * transport
   */
  function respondRecv(t, res, cors, lease) {
    if (lease) return Promise.resolve().then(() => lease.check()).then(() => {
      if (t.fenced || t.dead || t.superseded || !t.closed && !sessions.isCurrent(t.connId, t))
        throw Object.assign(Error('superseded'), { status: 409, code: 'superseded' });
      return respondRecv(t, res, cors);
    }).catch(error => sendJson(res, error?.status ?? 503,
      { ok: false, error: error?.code ?? 'instance-invocation-forbidden' }, cors));
    t.lastSeen = now();
    if (t.closed) {
      const frames = [];
      let size = 0;
      while (t.rest.length > 0) {
        const bytes = byteLen(t.rest[0]);
        if (frames.length > 0 && size + bytes > HTTP_TRANSPORT_DEFAULTS.RECV_MAX_BYTES) break;
        frames.push(t.rest.shift());
        size += bytes;
      }
      const done = t.rest.length === 0;
      sendJson(res, 200, { ok: true, frames, closed: done ? t.closed : null }, cors);
      if (done && bySid.get(t.sid) === t) bySid.delete(t.sid);
      return;
    }
    const frames = sessions.pull(t.connId, HTTP_TRANSPORT_DEFAULTS.RECV_MAX_BYTES);
    sendJson(res, 200, { ok: true, frames, closed: null }, cors);
  }

  /**
   * New frames available or session ended: wake up the pending GET. When multiple writes occur in the
   * same round, batch them into a single response
   */
  function wake(t, immediate = false) {
    if (!t.waiter) return;
    if (immediate) {
      const w = clearWaiter(t);
      respondRecv(t, w.res, w.cors, w.lease);
      return;
    }
    if (t.wakeQueued) return;
    t.wakeQueued = true;
    setImmediate(() => {
      t.wakeQueued = false;
      const w = clearWaiter(t);
      if (w) respondRecv(t, w.res, w.cors, w.lease);
    });
  }

  /**
   * Find the HTTP transport for this session by `Authorization`; if not found, 404 / 410 / 409 has
   * already been sent, return null.
   * If the session was already taken over by another transport (e.g. the client switched to
   * WebSocket), respond with 409 `superseded`.
   */
  function transportOf(req, res, cors) {
    const sid = bearerOf(req);
    const t = sid ? bySid.get(sid) : undefined;
    if (t && !t.superseded) return t;
    if (t?.superseded) {
      sendJson(res, 409, { ok: false, error: 'superseded' }, cors);
      return null;
    }
    const tomb = sid ? sessions.tombOf(sid) : null;
    if (tomb) {
      sendJson(res, 410, { ok: false, error: 'session-closed', code: tomb.code, reason: tomb.reason }, cors);
      return null;
    }
    if (sid && sessions.connIdOf(sid)) {
      // Session exists, but the attached transport is not HTTP: must resume via open first
      sendJson(res, 409, { ok: false, error: 'superseded' }, cors);
      return null;
    }
    sendJson(res, 404, { ok: false, error: 'no-session' }, cors);
    return null;
  }

  /** Using this transport to send or close after the session has ended: respond with 410 */
  function closedReply(t, res, cors) {
    sendJson(res, 410, { ok: false, error: 'session-closed', code: t.closed.code, reason: t.closed.reason }, cors);
  }

  // ---------- Endpoints ----------

  const openReply = (welcome) => ({
    ok: true,
    sid: welcome.sid,
    resumed: welcome.resumed,
    ack: welcome.ack,
    retainMs: welcome.retainMs ?? retainMs,
    waitMs: waitCap,
    maxFrameBytes: maxFrame,
    protocol,
    transport: 'http',
    ...(welcome.connId ? { connId: welcome.connId } : {}),
  });

  function invoke(t, req, res, cors, kind, bodyText, next, extra = {}) {
    if (!needsInvocation(t.principal, req)) return next();
    return Promise.resolve().then(() => dispatchInvocation({ connId: t.connId, principal: t.principal,
      kind, bodyText, ...extra, transport: { kind: 'http', req, res, socket: req.socket,
        internal: internalTransport(req) } }, next)).catch(error => {
      sendJson(res, error?.status ?? 503, { ok: false, error: error?.code ?? 'instance-invocation-forbidden' }, cors);
      throw error;
    });
  }

  // Only Agent instance dispatch is asynchronous. Recheck the exact transport
  // after that await before mutating a session which may have been resumed.
  function requireCurrentInvocation(t) {
    if (needsInvocation(t.principal) && (t.fenced || t.dead || t.superseded || !sessions.isCurrent(t.connId, t)))
      throw Object.assign(Error('superseded'), { status: 409, code: 'superseded' });
  }

  async function onOpen(req, res, cors) {
    if (canOpen() === 'closing') return sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
    const offered = protocolList(req.headers[PROTOCOLS_HEADER]);
    if (offered.length === 0 || offered[0] !== protocol) return sendJson(res, 400, { ok: false, error: 'bad-protocols' }, cors);
    const item = parseSessionItem(offered, protocol);
    // Long polling has no legacy clients: the list must contain a session entry
    if (item.kind === 'bad' || item.kind === 'legacy') return sendJson(res, 400, { ok: false, error: 'bad-protocols' }, cors);
    const body = await readBody(req, HTTP_TRANSPORT_DEFAULTS.SMALL_BODY_BYTES);
    if (body.aborted) return undefined;
    if (body.tooLarge) return sendJson(res, 413, { ok: false, error: 'too-large' }, cors);
    const fallback = fallbackOf(req);

    if (item.kind === 'resume') {
      // Resume entries are looked up by sid before authentication (an extra rule added in Section 14
      // "Evaluation order of open")
      if (canOpen() === 'closing') return sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
      const t = newTransport(item.sid);
      t.isUsable = () => !shuttingDown && !res.destroyed && !res.writableEnded && !req.aborted;
      t.connId = sessions.connIdOf(item.sid);
      t.principal = principalOf(t.connId);
      if (t.connId) track(t, req, res);
      const r = await invoke(t, req, res, cors, 'resume', body.text,
        () => sessions.resume({ sid: item.sid, ack: item.ack, transport: t, fallback }),
        { sessionItem: { sid: item.sid, ack: item.ack } });
      if (!r.ok) {
        if (r.status === 404) return sendJson(res, 404, { ok: false, error: 'no-session' }, cors);
        if (r.status === 503) return sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
        return sendJson(res, 410, { ok: false, error: 'session-closed', code: r.closedCode ?? r.code, reason: r.closedReason ?? r.reason }, cors);
      }
      t.connId = r.connId;
      t.principal = principalOf(r.connId);
      const old = bySid.get(item.sid);
      if (old && old !== t) old.dead = true;
      bySid.set(item.sid, t);
      if (!ownedRequests.size || ![...ownedRequests].some(record => record.req === req && record.res === res)) track(t, req, res);
      return sendJson(res, 200, openReply(r.welcome), cors);
    }

    // While reading the request body, shutdown may have started or sessions may have reached capacity
    if (canOpen() !== null) return sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
    // Same request object: only put the subprotocol list into the WebSocket handshake header;
    // socket, url, and remaining headers stay unchanged
    const headers = { ...req.headers, 'sec-websocket-protocol': offered.join(', ') };
    const authReq = Object.create(req, { headers: { value: headers, enumerable: true, writable: true, configurable: true },
      transportBodyText: { value: body.text }, transportProtocolHeaders: { value: req.headers } });
    let principal;
    try {
    try { principal = await authenticate(authReq); }
    catch (error) {
      return sendJson(res, error?.status === 503 ? 503 : 401,
        { ok: false, error: error?.status === 503 ? 'unavailable' : 'unauthorized' }, cors);
    }
    if (!principal || typeof principal.userId !== 'string') return sendJson(res, 401, { ok: false, error: 'unauthorized' }, cors);
    if (admissionRefusal(principal)) return sendJson(res, 401, { ok: false, error: 'unauthorized' }, cors);
    // No await between this check and openSession: a peer finishing auth meanwhile
    // cannot consume the last slot behind our back.
    if (canOpen() !== null || res.destroyed || res.writableEnded || req.aborted)
      return sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
    let remote = null;
    try {
      remote = remoteOf(authReq) ?? req.socket?.remoteAddress ?? null;
    } catch {
      remote = req.socket?.remoteAddress ?? null;
    }
    const t = newTransport(null);
    t.principal = normalizePrincipal(principal);
    let opened;
    try {
      opened = sessions.openSession({ principal: normalizePrincipal(principal), remote, transport: t, fallback });
    } catch (err) {
      say('http.error', { stage: 'open', message: String(err?.message ?? err) });
      return sendJson(res, 500, { ok: false, error: 'internal' }, cors);
    }
    t.sid = opened.sid;
    t.connId = opened.connId;
    transportConnected?.({ connId: t.connId, principal: t.principal, req });
    bySid.set(opened.sid, t);
    track(t, req, res);
    return sendJson(res, 200, openReply(opened.welcome), cors);
    } finally { completeAdmission(authReq); }
  }

  async function onSend(req, res, cors) {
    const t = transportOf(req, res, cors);
    if (!t) return undefined;
    const scoped = needsInvocation(t.principal, req);
    if (!scoped) { track(t, req, res); t.lastSeen = now(); }
    if (!scoped && t.closed) { req.resume(); return closedReply(t, res, cors); }
    if (!scoped && t.sending) { req.resume(); return sendJson(res, 409, { ok: false, error: 'busy' }, cors); }
    if (!scoped) t.sending = true;
    try {
      const body = await readBody(req, maxSendBody);
      if (body.aborted) return undefined;
      if (!scoped) t.lastSeen = now();
      if (body.tooLarge) {
        sendJson(res, 413, { ok: false, error: 'too-large' }, cors);
        // A SID locates a session; unverified input cannot close an Agent session.
        if (!scoped) sessions.close(t.connId, 1009, 'too-large');
        return undefined;
      }
      if (!scoped && t.closed) return closedReply(t, res, cors);
      let msg;
      try { msg = JSON.parse(body.text); } catch { msg = null; }
      if (!isObj(msg) || !Array.isArray(msg.frames) || msg.frames.some(f => typeof f !== 'string'))
        return sendJson(res, 400, { ok: false, error: 'bad-request' }, cors);
      if (msg.frames.some(f => byteLen(f) > maxFrame)) {
        sendJson(res, 413, { ok: false, error: 'too-large' }, cors);
        if (!scoped) sessions.close(t.connId, 1009, 'too-large');
        return undefined;
      }
      if (scoped && msg.frames.length === 0) return sendJson(res, 400, { ok: false, error: 'empty-frames' }, cors);
      if (scoped) return await invoke(t, req, res, cors, 'message', body.text, async firstFrame => {
        requireCurrentInvocation(t);
        if (t.sending) return sendJson(res, 409, { ok: false, error: 'busy' }, cors);
        // Complete input and its first proof are verified before claiming a
        // session slot, idle clock or resource lease. Partial input owns itself.
        track(t, req, res); t.lastSeen = now(); t.sending = true;
        try {
          await sessions.receive(t.connId, firstFrame);
          for (let frameIndex = 1; frameIndex < msg.frames.length; frameIndex++) {
            requireCurrentInvocation(t);
            await invoke(t, req, res, cors, 'message', body.text, frame => {
              requireCurrentInvocation(t); return sessions.receive(t.connId, frame);
            }, { text: msg.frames[frameIndex], frameIndex, frameCount: msg.frames.length });
          }
          requireCurrentInvocation(t);
          return sendJson(res, 200, { ok: true, ack: sessions.takeAck(t.connId) }, cors);
        } finally { t.sending = false; }
      }, { text: msg.frames[0], frameIndex: 0, frameCount: msg.frames.length });
      for (const text of msg.frames) {
        if (t.closed || !sessions.isCurrent(t.connId, t)) break;
        sessions.receive(t.connId, text);
      }
      if (t.closed) return closedReply(t, res, cors);
      return sendJson(res, 200, { ok: true, ack: sessions.takeAck(t.connId) }, cors);
    } finally { if (!scoped) t.sending = false; }
  }
  function onRecv(req, res, cors, url) {
    const t = transportOf(req, res, cors);
    if (!t) return;
    if (needsInvocation(t.principal, req)) return invoke(t, req, res, cors, 'recv', '', (_frame, check) => {
      if (typeof check !== 'function') throw Object.assign(Error('instance-read-lease-required'),
        { status: 503, code: 'instance-read-lease-required' });
      requireCurrentInvocation(t); track(t, req, res);
      return receiveAllowed(t, req, res, cors, url, { check });
    });
    track(t, req, res);
    return receiveAllowed(t, req, res, cors, url);
  }

  function receiveAllowed(t, req, res, cors, url, lease) {
    // This runs after signature/current-run checks, before ACK or waiter changes.
    requireCurrentInvocation(t);
    // A signed read invocation stays live until this response actually finishes
    // or closes. Its fresh check is used again immediately before pulling bytes.
    const replied = lease ? new Promise(resolve => { res.once('finish', resolve); res.once('close', resolve); }) : undefined;
    t.lastSeen = now();
    const rawWait = Number(url.searchParams.get('wait') ?? waitCap);
    const wait = Number.isFinite(rawWait) && rawWait >= 0 ? Math.min(rawWait, waitCap) : waitCap;

    // New GET replaces the old one (after client timeout and reconnect, the old request may still
    // be pending here)
    const old = clearWaiter(t);
    if (old) {
      counters.superseded += 1;
      sendJson(old.res, 200, { ok: true, frames: [], closed: null, superseded: true }, old.cors);
    }

    if (!t.closed) {
      const ack = Number(url.searchParams.get('ack') ?? 0);
      const last = sessions.lastSeq(t.connId);
      if (!Number.isSafeInteger(ack) || ack < 0 || ack > last) {
        // Out-of-bounds ack: session is corrupted (Section 3.5); session layer ends it with 1002
        sessions.ack(t.connId, ack);
        sendJson(res, 400, { ok: false, error: 'bad-ack', last }, cors);
        return replied;
      }
      sessions.ack(t.connId, ack);
    }

    if (t.closed || wait === 0 || sessions.hasPending(t.connId)) {
      respondRecv(t, res, cors, lease);
      return replied;
    }
    const w = { res, cors, timer: null, lease };
    w.timer = setTimeout(() => {
      if (t.waiter !== w) return;
      t.waiter = null;
      respondRecv(t, res, cors, lease);
    }, wait);
    w.timer.unref?.();
    t.waiter = w;
    res.on('close', () => {
      if (t.waiter !== w) return;
      clearWaiter(t);
      t.lastSeen = now();
    });
    return replied;
  }

  async function onClose(req, res, cors) {
    const t = transportOf(req, res, cors);
    if (!t) return undefined;
    const scoped = needsInvocation(t.principal, req);
    const body = await readBody(req, HTTP_TRANSPORT_DEFAULTS.SMALL_BODY_BYTES);
    if (body.aborted) return undefined;
    if (body.tooLarge) return sendJson(res, 413, { ok: false, error: 'too-large' }, cors);
    if (scoped && body.text.length === 0) return sendJson(res, 400, { ok: false, error: 'bad-request' }, cors);
    let msg = null;
    if (body.text) {
      try { msg = JSON.parse(body.text); } catch { msg = null; }
    }
    if (!scoped) track(t, req, res);
    return invoke(t, req, res, cors, 'close', body.text, () => {
      requireCurrentInvocation(t);
      if (needsInvocation(t.principal, req)) track(t, req, res);
      if (!t.closed) sessions.end(t.connId, isObj(msg) ? msg.code : undefined, isObj(msg) ? msg.reason : '');
      // Closed by the client itself: it does not want the remaining frames
      if (bySid.get(t.sid) === t) bySid.delete(t.sid);
      sendJson(res, 200, { ok: true }, cors);
      return undefined;
    });
  }

  /**
   * Handle an HTTP request. If it matches `<prefix>/lp/…`, take over and return true; otherwise
   * return false without touching anything.
   */
  function handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    if (!url.pathname.startsWith(lpRoot)) return false;
    const cors = corsFor(req);
    const name = url.pathname.slice(lpRoot.length);
    if (req.method === 'OPTIONS') {
      // Preflight performs no session operations; when the list is empty (or Origin is not in the
      // list), do not return any CORS headers
      const headers = { 'cache-control': 'no-store', ...(cors ?? {}) };
      if (cors) {
        headers['access-control-allow-methods'] = CORS_METHODS;
        headers['access-control-allow-headers'] = CORS_HEADERS;
        headers['access-control-max-age'] = CORS_MAX_AGE;
      }
      res.writeHead(204, headers);
      res.end();
      return true;
    }
    const routes = { open: 'POST', send: 'POST', recv: 'GET', close: 'POST' };
    if (!Object.hasOwn(routes, name)) {
      sendJson(res, 404, { ok: false, error: 'not-found' }, cors);
      return true;
    }
    if (req.method !== routes[name]) {
      sendJson(res, 405, { ok: false, error: 'method' }, cors);
      return true;
    }
    if (shuttingDown && name === 'open') {
      sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
      return true;
    }
    const fail = (err) => {
      say('http.error', { stage: name, message: String(err?.message ?? err) });
      sendJson(res, 500, { ok: false, error: 'internal' }, cors);
    };
    try {
      let r;
      if (name === 'open') r = onOpen(req, res, cors);
      else if (name === 'send') r = onSend(req, res, cors);
      else if (name === 'recv') r = onRecv(req, res, cors, url);
      else r = onClose(req, res, cors);
      if (r && typeof r.then === 'function') r.then(undefined, fail);
    } catch (err) {
      fail(err);
    }
    return true;
  }

  return {
    handle,
    connectionIdsMatching(predicate) {
      return [...new Set([...bySid.values(), ...[...ownedRequests].map(record => record.t), ...[...ownedSockets].map(owner => owner.t)]
        .filter(t => predicate(t.principal)).map(t => t.connId))];
    },

    /** Dedicated revocation never serves ordinary close's remaining frames. */
    async fenceConn(connId, code = 4003, reason = 'access-revoked') {
      fencedConns.add(connId);
      const records = [...ownedRequests].filter(record => record.t.connId === connId);
      const socketOwners = [...ownedSockets].filter(owner => owner.t.connId === connId);
      const transports = new Set([...bySid.values(), ...records.map(record => record.t), ...socketOwners.map(owner => owner.t)]);
      for (const t of transports) {
        if (t.connId !== connId) continue;
        t.closed = { code, reason }; t.fenced = true; t.rest = []; t.dead = true;
        clearWaiter(t);
        if (bySid.get(t.sid) === t) bySid.delete(t.sid);
      }
      const sockets = new Set([...records.map(record => record.socket), ...socketOwners.map(owner => owner.socket)].filter(Boolean));
      const actualSockets = [...sockets].map(socket => socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve)));
      for (const record of records) { record.res.destroy(); record.req.destroy(); }
      for (const socket of sockets) socket.destroy();
      await Promise.all([...records.map(record => record.done), ...actualSockets]);
      return { actualClosed: true, closedHttp: records.length };
    },

    /**
     * Assembly layer heartbeat invoked every round: transports with neither pending GET nor incoming
     * requests within `waitMs + 15 s` are deemed disconnected, detaching the session (session layer
     * enters retention period);
     * if the session has ended and the client never fetches remaining frames, forget it after a while.
     */
    sweep() {
      const t0 = now();
      for (const [sid, t] of [...bySid]) {
        if (t.closed) {
          if (!t.waiter && t0 - t.closedAt >= HTTP_TRANSPORT_DEFAULTS.CLOSED_KEEP_MS) bySid.delete(sid);
          continue;
        }
        if (t.dead) {
          bySid.delete(sid);
          continue;
        }
        if (t.waiter || t.sending || t0 - t.lastSeen < idleMs) continue;
        t.dead = true;
        bySid.delete(sid);
        sessions.transportClosed(t.connId, t, { why: 'http-idle' });
      }
    },

    /**
     * Shutdown: no longer create sessions; pending GETs respond with `closed` when the session layer
     * ends the session (assembly layer calls `sessions.closeAll` first)
     */
    shutdown() {
      shuttingDown = true;
    },

    /**
     * Diagnostics: number of transports attached to HTTP and number of superseded GETs (session
     * statistics are in the session layer)
     */
    stats() {
      return { transports: [...bySid.values()].filter((t) => !t.closed && !t.dead).length, superseded: counters.superseded };
    },
  };
}
