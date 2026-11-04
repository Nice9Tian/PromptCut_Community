/**
 * Client session layer: a **session** to the document service (contract
 * `docs/plan/http-transport-contract.md` sections 3, 4, 9, 16; semantics
 * `docs/semantics/product/document-service.md` and `docs/semantics/mechanism/document-service.md`
 * "Session and transport").
 *
 * `createDocEndpoint` return value has the same shape as `createWsEndpoint` (`send`, `onMessage`,
 * `onOpen`, `onClose`, `close`, `connected`, `closed`, `stats()`), plus `onResume`, and can be
 * passed directly to `createLocalNode`, `createContentClient`, etc.
 *
 * Session and transport:
 *   - Session establishment: The handshake subprotocol is the auth list freshly retrieved from
 *     `protocols()` plus `promptcut.session.new`; the server's first message is
 *     `session.welcome { sid, resumed, ack, retainMs, transport }`; only upon receiving it is the
 *     session established, calling `onOpen` (nodes send `hello.resume` here, pages resubscribe here).
 *   - Sequence numbers and acknowledgments: Outbound business messages carry `seq` (starting from 1
 *     in this session) and piggyback `ack` (the highest server `seq` received completely in order);
 *     inbound messages are received by `seq`, stripped of `seq` / `ack` before being passed to
 *     `onMessage`, retransmissions are dropped, and skipped sequence numbers or out-of-bounds `ack`
 *     terminate the session as corrupted (1002). When there is no piggybacking opportunity,
 *     immediately send a standalone `{ type: 'session.ack', ack }` once `ackEvery` messages (32)
 *     have been received or the raw text of received messages reaches `ackBytes` (64 KiB, [ruling]
 *     2026-09-27), otherwise within `ackDelayMs` (1 s). `session.*` control messages do not carry
 *     `seq` and are not passed to higher layers.
 *   - Transport disconnects only cause the session to **detach**: unacknowledged outbound messages
 *     are retained, and `send` still accepts messages; resuming follows backoff, and the resume
 *     subprotocols are only `promptcut.v1` and `promptcut.session.<sid>.<ack>` (without calling
 *     `protocols()` again). On successful resume, call `onResume` (not `onOpen`), release messages
 *     up to `welcome.ack`, and retransmit the rest in order using their original `seq`. Transport
 *     disconnects and resumes are only recorded in logs and `stats()`.
 *   - Only when the session terminates is `onClose { code, reason }` called: the server closes with
 *     a close code other than "transport failure" (4003, 4004, 1013, 1001, 1002, etc.); resume is
 *     rejected (the server accepts the upgrade first, then closes with 4404 session does not exist
 *     / 4410 session ended, contract section 16 item 1); detached longer than `welcome.retainMs`
 *     without resuming; this end detects skipped sequence numbers (1002) or unacknowledged outbound
 *     bytes exceed `maxPendingBytes` (1013). The `reason` of 4410 carries the original close code;
 *     when the original code belongs to `FINAL_CLOSE` (4003, 4004, which would not trigger
 *     reconnect even if received while connected), the original close code and reason are reported
 *     to `onClose` (e.g. project deleted while detached, higher layers still see 4004), otherwise
 *     4410 is reported ([ruling] 2026-09-27, contract section 17). After termination,
 *     unacknowledged messages are dropped (counted in `stats().dropped`), subsequent `send` calls
 *     drop messages and increment the counter, and a new session is established after re-fetching
 *     credentials following backoff.
 *   - `close()`: First sends `{ type: 'session.close', code: 1000, reason: 'closed' }` before
 *     closing the transport, and the server terminates the session immediately; no reconnects.
 *
 * Transport selection (section 4.3): HT-a only uses WebSocket. `url` accepts `ws(s)://` or
 * `http(s)://`, and converts them all into WebSocket addresses. The `transport` option (provided by
 * caller in browser) or Node's `PROMPTCUT_TRANSPORT`: `ws` forces WebSocket; `auto` (default) is
 * equivalent to `ws` in HT-a; `http` is not enabled in HT-a, throwing
 * `code: 'transport-unavailable'` during construction. HTTP long polling fallback,
 * `X-Promptcut-Fallback`, and `fetch` are reserved for HT-b: `fallbackAfter()` is the interface
 * hook; HT-a always returns null (each reconnect still starts from WebSocket, and
 * `stats().fallbacks` is always 0).
 *
 * Two points outside the contract (specified in report
 * `docs/archive/agent-reports/AGENT-ht-client.md`):
 *   - **Legacy servers**: When the server does not have a session layer yet (handshake succeeds,
 *     first message is not `session.welcome`), degrades to "one transport is one session": messages
 *     carry no `seq` / `ack`, the session ends as soon as the transport disconnects, and behavior
 *     is identical to `createWsEndpoint` (`stats().legacy` is true). To distinguish quickly, if no
 *     message is received within `legacyProbeMs` after the handshake, send a harmless
 *     `{ type: 'session.ack', ack: 0 }`: new servers have already sent welcome, while legacy
 *     servers reply with `error unsupported` (this response is not passed to higher layers).
 *   - `onConnectFail(handler)`: Called when establishing a new session fails (handshake failed,
 *     timed out waiting for welcome, or `protocols()` failed), used by pages to distinguish
 *     "rejected due to incorrect passphrase"; when `renew: false`, the endpoint only runs a single
 *     session, closing itself if establishment fails or after it terminates, leaving it up to the
 *     caller to decide whether to create another one.
 *     `dropTransport()`: For development and testing only; drops only the current transport
 *     (session detaches and resumes) without terminating the session.
 *
 * Uses only global `WebSocket` and timers (both injectable), compatible with both browser and Node;
 * does not handle proxies directly (set `NODE_USE_ENV_PROXY=1` starting from Node 22.22). Session
 * IDs and credentials are never included in URLs, logs, or any error messages.
 */
import { PROTOCOL, BACKOFF_DEFAULTS, backoffDelay } from './ws-transport.mjs';

export const SESSION_NEW = 'promptcut.session.new';
export const SESSION_PREFIX = 'promptcut.session.';
const TOKEN_PREFIX = 'promptcut.token.';

export const SESSION_DEFAULTS = Object.freeze({
  /** Sends a standalone `session.ack` once unacknowledged received messages reach this count (section 3.3) */
  ackEvery: 32,
  /**
   * Sends a standalone `session.ack` if no piggyback opportunity occurs within this duration after
   * receiving a message (section 3.3)
   */
  ackDelayMs: 1000,
  /**
   * Sends a standalone `session.ack` immediately once received unacknowledged raw message bytes
   * reach this threshold ([ruling 2026-09-27 lead session, identical for both ends, added in contract
   * section 17]): if large messages such as snapshot chunks are only acknowledged by message count
   * and 1 s, the peer could accumulate over 1 MiB unacknowledged within one second, terminating its
   * own session with 1013
   */
  ackBytes: 64 * 1024,
  /**
   * Upper limit on client unacknowledged outbound bytes; exceeding terminates the session with 1013
   * (section 3.4)
   */
  maxPendingBytes: 1024 * 1024,
  /** Used when welcome does not include `retainMs` (section 4.2 default) */
  retainMs: 60_000,
  /**
   * Timeout waiting for `session.welcome` after handshake succeeds; exceeding is treated as a failed
   * handshake
   */
  welcomeTimeoutMs: 10_000,
  /**
   * If no message is received for this long after handshake succeeds, sends a probe to distinguish
   * legacy servers
   */
  legacyProbeMs: 250,
});

/** Close code when session ends: resume failed (contract section 16, item 1) */
export const CLOSE_NO_SESSION = 4404;
export const CLOSE_SESSION_ENDED = 4410;
/**
 * Transport failures: these close codes only cause the session to detach and then resume; other
 * close codes (1000, 1001, 1002, 1013, 4003, 4004, 4009, etc.) indicate that the server terminated
 * the session and will not resume (section 4.2 "Server-initiated close").
 */
const TRANSPORT_FAULT = new Set([1005, 1006, 1011, 1012, 1014, 1015]);
/**
 * Close codes that "would not reconnect even if received while connected": results of creator
 * actions, 4003 kick / remove (`kicked` / `removed`), 4004 delete project (`deleted`),
 * `auth-contract.md` section 7; matches `FATAL_CLOSE` in the page's `SyncLink`. When a session
 * terminates due to these codes while detached, the 4410 received on resume is reported to upper
 * layers as the original close code without rebuilding, keeping behavior identical to receiving the
 * code while connected ([ruling] 2026-09-27 lead session, contract section 17).
 */
export const FINAL_CLOSE = new Set([4003, 4004]);

/**
 * Extracts the original close code and reason from the `reason` of 4410 (server format
 * `session-closed <orig-close-code>[ <orig-reason>]`, contract section 4.1); returns null if it does
 * not match this format.
 */
export function closedCodeOf(reason) {
  const m = /^session-closed (\d{4})(?: ([\s\S]*))?$/.exec(typeof reason === 'string' ? reason : '');
  return m ? { code: Number(m[1]), reason: m[2] ?? '' } : null;
}

/** Downgrade reasons used by HT-b (section 4.3, item 5); HT-a does not downgrade */
export const FALLBACK_REASONS = Object.freeze(['ws-error', 'ws-timeout', 'ws-closed']);

const OPEN = 1;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Byte count of a string UTF-8 encoded (without allocating a buffer) */
export function utf8Length(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** `ws(s)://` or `http(s)://` → WebSocket address */
export function wsUrlOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new TypeError('createDocEndpoint: url is not a valid address');
  }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new TypeError('createDocEndpoint: url must be ws(s):// or http(s)://');
  return u.toString();
}

/** `ws(s)://` or `http(s)://` → HTTP address (used as long polling base URL in HT-b) */
export function httpUrlOf(url) {
  const u = new URL(wsUrlOf(url));
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  return u.toString();
}

/**
 * Determines transport: options take precedence, followed by Node's `PROMPTCUT_TRANSPORT`,
 * defaulting to `auto`. Returns `'auto' | 'ws'`.
 * `http` is not enabled in HT-a: throws `code: 'transport-unavailable'`; other values throw TypeError.
 */
export function transportOf(option, env = globalThis.process?.env?.PROMPTCUT_TRANSPORT) {
  const raw = option ?? env;
  const v = raw === undefined || raw === null ? 'auto' : String(raw).trim().toLowerCase() || 'auto';
  if (v === 'auto' || v === 'ws') return v;
  if (v === 'http') {
    throw Object.assign(new Error('HTTP long polling transport is not enabled in this version (HT-a), only WebSocket is available: remove PROMPTCUT_TRANSPORT=http (or --transport http), or change it to ws'), { code: 'transport-unavailable' });
  }
  throw new TypeError(`Transport must be auto, ws or http: ${JSON.stringify(String(raw)).slice(0, 40)}`);
}

/**
 * @param {object} options
 * @param {string} options.url  `ws(s)://` or `http(s)://`
 * @param {() => (string[] | Promise<string[]>)} [options.protocols]  Fetches auth list on demand
 *   before each **session creation** (includes `promptcut.v1`, excludes session items)
 * @param {() => (string[] | Promise<string[]>)} [options.resumeProtocols] Separately fetches gateway
 *   routing capabilities during relay resume; session secret unchanged, retains session and
 *   backs off to retry on failure
 * @param {string} [options.token]  Cluster token (for management API); mutually exclusive with
 *   `protocols`; only includes `promptcut.v1` if neither is given
 * @param {'auto' | 'ws' | 'http'} [options.transport]  Defaults to Node's `PROMPTCUT_TRANSPORT`,
 *   otherwise defaults to `auto`
 * @param {typeof fetch} [options.fetch]  Used for HT-b HTTP long polling; not called in HT-a
 * @param {number} [options.waitMs]  Wait duration for HT-b; not used in HT-a
 * @param {any} [options.WebSocket]
 * @param {(fn: () => void, ms: number) => any} [options.setTimeout]
 * @param {(handle: any) => void} [options.clearTimeout]
 * @param {() => number} [options.random]
 * @param {Partial<typeof BACKOFF_DEFAULTS>} [options.backoff]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.maxPendingBytes]  Cap on unacknowledged outbound bytes, defaults to 1 MiB
 *   (Section 3.4)
 * @param {boolean} [options.renew]  Defaults to true: automatically creates a new session after
 *   session ends; false: runs only one session
 */
export function createDocEndpoint({
  url,
  protocols: protocolsOf,
  resumeProtocols: resumeProtocolsOf,
  token,
  transport,
  // eslint-disable-next-line no-unused-vars
  fetch: fetchImpl = globalThis.fetch,
  // eslint-disable-next-line no-unused-vars
  waitMs,
  WebSocket: WebSocketImpl = globalThis.WebSocket,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  random = Math.random,
  backoff,
  log = () => {},
  now = Date.now,
  maxPendingBytes = SESSION_DEFAULTS.maxPendingBytes,
  ackEvery = SESSION_DEFAULTS.ackEvery,
  ackDelayMs = SESSION_DEFAULTS.ackDelayMs,
  ackBytes = SESSION_DEFAULTS.ackBytes,
  welcomeTimeoutMs = SESSION_DEFAULTS.welcomeTimeoutMs,
  legacyProbeMs = SESSION_DEFAULTS.legacyProbeMs,
  renew = true,
} = /** @type {any} */ ({})) {
  const mode = transportOf(transport);
  const wsUrl = wsUrlOf(url);
  if (typeof WebSocketImpl !== 'function') throw new TypeError('createDocEndpoint: no WebSocket available');
  if (token !== undefined && token !== null && (typeof token !== 'string' || token === '')) {
    throw new TypeError('createDocEndpoint: token must be a non-empty string');
  }
  if (protocolsOf !== undefined && protocolsOf !== null) {
    if (typeof protocolsOf !== 'function') throw new TypeError('createDocEndpoint: protocols must be a function');
    if (token) throw new TypeError('createDocEndpoint: protocols and token cannot both be given');
  }
  const policy = { ...BACKOFF_DEFAULTS, ...(backoff ?? {}) };
  const fixedProtocols = token ? [PROTOCOL, TOKEN_PREFIX + token] : [PROTOCOL];
  const parsed = new URL(wsUrl);
  /** Logs only write URLs without credentials */
  const safeUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;

  const messageHandlers = [];
  const openHandlers = [];
  const resumeHandlers = [];
  const closeHandlers = [];
  const connectFailHandlers = [];
  /**
   * Counters (`stats()` returns as-is, node diagnostics reads from here, chaos tests use it to
   * determine "how many times resumed, how many times lost, whether session was rebuilt"):
   *   opens number of established sessions (including rebuilds); renews those created after previous
   *   session ended (rebuilds); resumes successful resumes; detaches transport disconnected,
   *   session detached; lost resume rejected by server (4404 / 4410); expired local end determined
   *   detachment exceeded retention period; connectFails failed to establish new session;
   *   closes session ended; dropped dropped outbound messages (unacknowledged when session ended,
   *   `send` called when no session existed).
   */
  const counters = { opens: 0, closes: 0, sent: 0, received: 0, dropped: 0, badFrames: 0, duplicates: 0, resumes: 0, detaches: 0, fallbacks: 0,
    renews: 0, lost: 0, expired: 0, connectFails: 0 };
  /** Last session close `{ code, reason, at }` and last detachment `{ code, at }`; reason is truncated to 120 characters (server close reasons contain no credentials) */
  let lastClose = null;
  let lastDetach = null;
  /** Had a session (the next established one counts as a rebuild) */
  let hadSession = false;

  let closed = false;
  /**
   * Current session; null = no session (not yet established or already ended).
   * { sid, legacy, retainMs, outSeq, outBuf: [{ seq, body, bytes }], pendingBytes, inAck, inUnacked, ackTimer, detachedAt }
   */
  let sess = null;
  /** Current transport (in handshake, waiting for welcome, or attached); late events from old transports are ignored */
  let cur = null;
  let attempt = 0;
  let retryTimer = null;
  /** Fetching auth list (`protocols()` has not returned yet) */
  let pendingProtocols = false;

  const say = (event, fields = {}) => {
    try { log(event, { url: safeUrl, ...fields }); } catch { /* Logging failures do not affect the connection */ }
  };

  function emit(handlers, arg, what) {
    for (const handler of [...handlers]) {
      try {
        handler(arg);
      } catch (error) {
        say('session.handler-error', { handler: what, message: String(error?.message ?? error) });
      }
    }
  }

  function listen(socket, type, fn) {
    if (typeof socket.addEventListener === 'function') socket.addEventListener(type, fn);
    else socket[`on${type}`] = fn;
  }

  const attached = () => cur !== null && cur.stage === 'attached';

  function rawSend(rec, message) {
    if (!rec || rec.ended || (typeof rec.socket.readyState === 'number' && rec.socket.readyState !== OPEN)) return false;
    try {
      rec.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function clearRecTimers(rec) {
    if (rec.welcomeTimer !== null) { clearTimer(rec.welcomeTimer); rec.welcomeTimer = null; }
    if (rec.probeTimer !== null) { clearTimer(rec.probeTimer); rec.probeTimer = null; }
  }

  function clearAckTimer(s) {
    if (s && s.ackTimer !== null) { clearTimer(s.ackTimer); s.ackTimer = null; }
  }

  // ------------------------------------------------------------------ Session creation, resume

  function connect() {
    retryTimer = null;
    if (closed || cur !== null) return;
    if (sess && !sess.legacy) {
      if (now() - sess.detachedAt >= sess.retainMs) {
        counters.expired++;
        say('session.expired', { retainMs: sess.retainMs });
        endSession(1006, 'retain-expired', { notify: false });
        return;
      }
      if (typeof resumeProtocolsOf !== 'function') {
        dial([PROTOCOL, `${SESSION_PREFIX}${sess.sid}.${sess.inAck}`], 'resume');
        return;
      }
      // Session secret is still verified by original service; relay gateway additionally requires current routing capabilities, cannot be omitted due to resume.
      const saved = sess;
      pendingProtocols = true;
      Promise.resolve().then(() => resumeProtocolsOf()).then(list => {
        pendingProtocols = false;
        if (closed || sess !== saved || cur !== null) return;
        if (!Array.isArray(list) || list.some(p => typeof p !== 'string')) throw new TypeError('resumeProtocols() must return an array of strings');
        dial([PROTOCOL, `${SESSION_PREFIX}${saved.sid}.${saved.inAck}`, ...list.filter(p => p !== PROTOCOL && p !== SESSION_NEW && !p.startsWith(SESSION_PREFIX))], 'resume');
      }).catch(() => {
        pendingProtocols = false;
        if (closed || sess !== saved) return;
        say('session.resume-protocols-failed');
        scheduleRetry();
      });
      return;
    }
    if (typeof protocolsOf !== 'function') {
      dial([...fixedProtocols, SESSION_NEW], 'new');
      return;
    }
    let got;
    try {
      got = protocolsOf();
    } catch (error) {
      protocolsFailed(error);
      return;
    }
    pendingProtocols = true;
    Promise.resolve(got).then((list) => {
      pendingProtocols = false;
      if (closed) return;
      if (!Array.isArray(list) || list.some((p) => typeof p !== 'string')) throw new TypeError('protocols() must return an array of strings');
      dial([...list.filter((p) => p !== SESSION_NEW && !p.startsWith(SESSION_PREFIX)), SESSION_NEW], 'new');
    }).catch((error) => {
      pendingProtocols = false;
      if (closed) return;
      protocolsFailed(error);
    });
  }

  function protocolsFailed(error) {
    // Logs only record reasons, not subprotocols (which contain proofs or tickets)
    say('session.error', { stage: 'protocols', message: String(error?.message ?? error) });
    newSessionFailed({ code: 0, reason: 'protocols' });
  }

  /** Failed to establish new session: notify caller; close if `renew: false`, otherwise back off and retry */
  function newSessionFailed(info) {
    emit(connectFailHandlers, info, 'connect-fail');
    if (closed) return;
    if (!renew) {
      shutdown();
      return;
    }
    scheduleRetry();
  }

  /**
   * Hook point for HT-b: which transport to switch to after WebSocket handshake fails (Section 4.3,
   * Item 3). HT-a does not connect to HTTP long polling, always returning null and starting from
   * WebSocket again next time; `mode === 'ws'` (forced) does not downgrade either.
   */
  function fallbackAfter(/* rec, reason */) {
    if (mode === 'ws') return null;
    return null;
  }

  function dial(list, kind) {
    if (closed) return;
    const rec = { socket: null, kind, stage: 'connecting', ended: false, dropping: false, welcomeTimer: null, probeTimer: null, probeSent: false, probeSwallowed: false };
    cur = rec;
    let socket;
    try {
      socket = new WebSocketImpl(wsUrl, list);
    } catch (error) {
      say('session.error', { stage: 'construct', message: String(error?.message ?? error) });
      onSocketGone(rec, 1006, 'construct');
      return;
    }
    rec.socket = socket;
    listen(socket, 'open', () => onSocketOpen(rec));
    listen(socket, 'message', (event) => onSocketMessage(rec, event));
    listen(socket, 'error', (event) => {
      // When handshake fails, Node's implementation may emit only error and no close (verified in cloud testing, 2026-09-27): treat error as transport gone
      if (rec.ended) return;
      say('session.transport-error', { stage: rec.stage, message: String(event?.message ?? event?.error?.message ?? 'error') });
      onSocketGone(rec, 1006, '');
    });
    listen(socket, 'close', (event) => {
      onSocketGone(rec, typeof event?.code === 'number' ? event.code : 1006, typeof event?.reason === 'string' ? event.reason : '');
    });
  }

  function onSocketOpen(rec) {
    if (cur !== rec || rec.ended) return;
    if (closed) {
      try { rec.socket.close(1000, 'closed'); } catch { /* Already closing */ }
      return;
    }
    rec.stage = 'open';
    rec.welcomeTimer = setTimer(() => {
      rec.welcomeTimer = null;
      if (cur !== rec || rec.stage !== 'open') return;
      say('session.welcome-timeout', { kind: rec.kind, timeoutMs: welcomeTimeoutMs });
      abortSocket(rec, 1006, 'welcome-timeout');
    }, welcomeTimeoutMs);
    if (rec.kind === 'new' && legacyProbeMs >= 0) {
      rec.probeTimer = setTimer(() => {
        rec.probeTimer = null;
        if (cur !== rec || rec.stage !== 'open') return;
        rec.probeSent = rawSend(rec, { type: 'session.ack', ack: 0 });
      }, legacyProbeMs);
    }
  }

  /** Local end gives up on transport (wait for welcome timed out, etc.): close and treat as transport gone */
  function abortSocket(rec, code, reason) {
    try { rec.socket.close(1000, reason); } catch { /* Already closing */ }
    onSocketGone(rec, code, reason);
  }

  function onSocketMessage(rec, event) {
    if (cur !== rec || rec.ended || rec.stage === 'connecting') return;
    const data = event?.data;
    let msg;
    if (typeof data === 'string') {
      try { msg = JSON.parse(data); } catch { msg = undefined; }
    }
    if (!isObj(msg) || typeof msg.type !== 'string') {
      counters.badFrames++;
      return;
    }
    if (rec.stage === 'open') {
      if (msg.type === 'session.welcome') {
        onWelcome(rec, msg);
        return;
      }
      if (rec.kind !== 'new') {
        say('session.bad-welcome', { kind: rec.kind, type: msg.type.slice(0, 40) });
        abortSocket(rec, 1006, 'bad-welcome');
        return;
      }
      enterLegacy(rec);
      if (cur !== rec || closed) return;
    }
    counters.received++;
    const s = sess;
    if (!s) return;
    if (s.legacy) {
      // Probe responses (old servers do not recognize `session.ack`) are not passed to upper layers
      if (rec.probeSent && !rec.probeSwallowed && msg.type === 'error' && msg.reqId === undefined && msg.reason === 'unsupported') {
        rec.probeSwallowed = true;
        return;
      }
      emit(messageHandlers, msg, 'message');
      return;
    }
    if (msg.type.startsWith('session.')) {
      if (msg.type === 'session.ack') onPeerAck(msg.ack);
      return;
    }
    if (msg.ack !== undefined && !onPeerAck(msg.ack)) return;
    const seq = msg.seq;
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > s.inAck + 1) {
      say('session.bad-seq', { got: Number.isSafeInteger(seq) ? seq : null, expected: s.inAck + 1 });
      endSession(1002, 'bad-seq', { notify: true });
      return;
    }
    if (seq <= s.inAck) {
      counters.duplicates++;
      return;
    }
    s.inAck = seq;
    noteInbound(s, utf8Length(data));
    const { seq: _seq, ack: _ack, ...body } = msg;
    emit(messageHandlers, body, 'message');
  }

  function enterLegacy(rec) {
    clearRecTimers(rec);
    rec.stage = 'attached';
    attempt = 0;
    sess = { legacy: true, sid: null, retainMs: 0, outSeq: 0, outBuf: [], pendingBytes: 0, inAck: 0, inUnacked: 0, inUnackedBytes: 0, ackTimer: null, detachedAt: null };
    noteOpen();
    say('session.open', { transport: 'ws', legacy: true, protocol: typeof rec.socket.protocol === 'string' ? rec.socket.protocol : null });
    emit(openHandlers, undefined, 'open');
  }

  /** Established a session: update counters; returns whether it is a rebuild */
  function noteOpen() {
    counters.opens++;
    const renewed = hadSession;
    if (renewed) counters.renews++;
    hadSession = true;
    return renewed;
  }

  function onWelcome(rec, msg) {
    clearRecTimers(rec);
    const sid = msg.sid;
    if (typeof sid !== 'string' || sid === '') {
      say('session.bad-welcome', { kind: rec.kind, reason: 'no-sid' });
      abortSocket(rec, 1006, 'bad-welcome');
      return;
    }
    const retainMs = Number.isFinite(msg.retainMs) && msg.retainMs >= 0 ? msg.retainMs : SESSION_DEFAULTS.retainMs;
    if (rec.kind === 'new') {
      rec.stage = 'attached';
      attempt = 0;
      sess = { legacy: false, sid, retainMs, outSeq: 0, outBuf: [], pendingBytes: 0, inAck: 0, inUnacked: 0, inUnackedBytes: 0, ackTimer: null, detachedAt: null };
      const renewed = noteOpen();
      say('session.open', { transport: 'ws', retainMs, ...(renewed ? { renew: true } : {}) });
      emit(openHandlers, undefined, 'open');
      return;
    }
    const s = sess;
    if (!s || s.legacy || sid !== s.sid) {
      say('session.bad-welcome', { kind: rec.kind, reason: 'sid-mismatch' });
      abortSocket(rec, 1006, 'bad-welcome');
      return;
    }
    rec.stage = 'attached';
    attempt = 0;
    s.retainMs = retainMs;
    if (!onPeerAck(msg.ack ?? 0)) return;
    // Resume item already includes local ack
    s.inUnacked = 0;
    s.inUnackedBytes = 0;
    clearAckTimer(s);
    const gapMs = s.detachedAt === null ? 0 : now() - s.detachedAt;
    s.detachedAt = null;
    counters.resumes++;
    say('session.resume', { transport: 'ws', gapMs, resend: s.outBuf.length });
    for (const entry of [...s.outBuf]) {
      if (sess !== s || !attached()) break;
      writeEntry(s, entry);
    }
    if (sess !== s) return;
    emit(resumeHandlers, undefined, 'resume');
  }

  // ------------------------------------------------------------------ Acknowledgment

  /** Peer's `ack`: release acknowledged outbound; out-of-bounds ends session as corrupted. Returns false = session already ended */
  function onPeerAck(value) {
    const s = sess;
    if (!s) return false;
    if (!Number.isSafeInteger(value) || value < 0 || value > s.outSeq) {
      say('session.bad-ack', { got: Number.isSafeInteger(value) ? value : null, max: s.outSeq });
      endSession(1002, 'bad-seq', { notify: true });
      return false;
    }
    while (s.outBuf.length > 0 && s.outBuf[0].seq <= value) s.pendingBytes -= s.outBuf.shift().bytes;
    if (s.outBuf.length === 0) s.pendingBytes = 0;
    return true;
  }

  /** Receive next application message (`bytes` is raw byte count): ack immediately if full count or bytes reached, else within `ackDelayMs` */
  function noteInbound(s, bytes) {
    s.inUnacked++;
    s.inUnackedBytes += bytes;
    if (s.inUnacked >= ackEvery || s.inUnackedBytes >= ackBytes) {
      sendAck(s);
      return;
    }
    if (s.ackTimer === null) {
      s.ackTimer = setTimer(() => {
        s.ackTimer = null;
        if (sess === s && s.inUnacked > 0) sendAck(s);
      }, ackDelayMs);
      s.ackTimer?.unref?.();
    }
  }

  function sendAck(s) {
    if (sess !== s || !attached()) return;
    if (rawSend(cur, { type: 'session.ack', ack: s.inAck })) {
      s.inUnacked = 0;
      s.inUnackedBytes = 0;
      clearAckTimer(s);
    }
  }

  function writeEntry(s, entry) {
    if (!attached()) return;
    const message = s.inAck > 0 ? { ...entry.body, ack: s.inAck } : entry.body;
    if (rawSend(cur, message) && s.inAck > 0) {
      s.inUnacked = 0;
      s.inUnackedBytes = 0;
      clearAckTimer(s);
    }
  }

  // ------------------------------------------------------------------ Transport lost, session ended

  function onSocketGone(rec, code, reason) {
    if (rec.ended) return;
    rec.ended = true;
    clearRecTimers(rec);
    if (cur !== rec) return;
    cur = null;
    if (closed) return;
    if (rec.stage !== 'attached') {
      // This handshake failed
      if (rec.kind === 'resume') {
        if (code === CLOSE_NO_SESSION || code === CLOSE_SESSION_ENDED) {
          // During detachment, session ended due to code that "would not reconnect even if received while connected" (e.g. project deleted): report original close code, upper layer handles same as connected
          const orig = code === CLOSE_SESSION_ENDED ? closedCodeOf(reason) : null;
          counters.lost++;
          if (orig && FINAL_CLOSE.has(orig.code)) {
            say('session.lost', { code, closedCode: orig.code });
            endSession(orig.code, orig.reason, { notify: false });
            return;
          }
          say('session.lost', { code, closedCode: orig ? orig.code : null });
          endSession(code, reason || (code === CLOSE_NO_SESSION ? 'no-session' : 'session-closed'), { notify: false });
          return;
        }
        say('session.resume-failed', { code });
        scheduleRetry();
        return;
      }
      counters.connectFails++;
      say('session.connect-failed', { code });
      fallbackAfter(rec, 'ws-error');
      newSessionFailed({ code, reason });
      return;
    }
    const s = sess;
    if (!s) return;
    if (s.legacy) {
      endSession(code, reason, { notify: false });
      return;
    }
    if (rec.dropping || TRANSPORT_FAULT.has(code)) {
      s.detachedAt = now();
      counters.detaches++;
      lastDetach = { code, at: s.detachedAt };
      say('session.detach', { code, pendingBytes: s.pendingBytes });
      scheduleRetry();
      return;
    }
    endSession(code, reason, { notify: false });
  }

  /**
   * End session: unacknowledged messages are dropped and counted; when `notify` is set, send
   * `session.close` first to let server terminate immediately, close current transport, report
   * `onClose`; then create new session or close endpoint according to `renew`.
   */
  function endSession(code, reason, { notify }) {
    const s = sess;
    if (!s) return;
    sess = null;
    clearAckTimer(s);
    counters.dropped += s.outBuf.length;
    s.outBuf = [];
    s.pendingBytes = 0;
    const rec = cur;
    if (rec) {
      cur = null;
      if (notify && !s.legacy && rec.stage === 'attached') rawSend(rec, { type: 'session.close', code, reason });
      rec.ended = true;
      clearRecTimers(rec);
      try { rec.socket.close(1000, String(reason).slice(0, 100)); } catch { /* Already closing */ }
    }
    counters.closes++;
    lastClose = { code, reason: String(reason ?? '').slice(0, 120), at: now() };
    say('session.close', { code, reason, legacy: s.legacy });
    emit(closeHandlers, { code, reason }, 'close');
    if (closed) return;
    if (!renew) {
      shutdown();
      return;
    }
    scheduleRetry();
  }

  function scheduleRetry() {
    if (closed || retryTimer !== null || pendingProtocols || cur !== null) return;
    const n = attempt++;
    const delayMs = backoffDelay(n, policy, random);
    say('session.retry', { attempt: n, delayMs, resume: !!(sess && !sess.legacy) });
    retryTimer = setTimer(connect, delayMs);
  }

  /** Endpoint closes itself (session ended with `renew: false`): does not send session.close, no more reconnects */
  function shutdown() {
    closed = true;
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  // ------------------------------------------------------------------ External

  function send(message) {
    if (!isObj(message) || closed || !sess) {
      counters.dropped++;
      return false;
    }
    const s = sess;
    if (s.legacy) {
      if (!attached() || !rawSend(cur, message)) {
        counters.dropped++;
        return false;
      }
      counters.sent++;
      return true;
    }
    const seq = s.outSeq + 1;
    const body = { ...message, seq };
    delete body.ack;
    let text;
    try {
      text = JSON.stringify(body);
    } catch {
      counters.dropped++;
      return false;
    }
    const bytes = utf8Length(text);
    if (s.pendingBytes + bytes > maxPendingBytes) {
      counters.dropped++;
      say('session.backpressure', { pendingBytes: s.pendingBytes, bytes, maxPendingBytes });
      endSession(1013, 'backpressure', { notify: true });
      return false;
    }
    s.outSeq = seq;
    const entry = { seq, body, bytes };
    s.outBuf.push(entry);
    s.pendingBytes += bytes;
    counters.sent++;
    writeEntry(s, entry);
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
    const s = sess;
    const rec = cur;
    cur = null;
    sess = null;
    if (rec) {
      if (s && !s.legacy && rec.stage === 'attached') rawSend(rec, { type: 'session.close', code: 1000, reason: 'closed' });
      rec.ended = true;
      clearRecTimers(rec);
      try { rec.socket.close(1000, 'closed'); } catch { /* Already closing */ }
    }
    if (s) {
      clearAckTimer(s);
      counters.dropped += s.outBuf.length;
      counters.closes++;
      lastClose = { code: 1000, reason: 'closed', at: now() };
      say('session.close', { code: 1000, reason: 'closed', legacy: s.legacy });
      emit(closeHandlers, { code: 1000, reason: 'closed' }, 'close');
    }
    say('session.closed');
  }

  /** Dev and test only: only disconnect current transport; session detaches then resumes (disconnect on older servers). Returns whether disconnected */
  function dropTransport() {
    const rec = cur;
    if (!rec || rec.stage !== 'attached' || closed) return false;
    rec.dropping = true;
    try { rec.socket.close(1000, 'drop'); } catch { /* Already closing */ }
    onSocketGone(rec, 1006, 'drop');
    return true;
  }

  connect();

  return {
    send,
    onMessage(handler) { messageHandlers.push(handler); },
    onOpen(handler) { openHandlers.push(handler); },
    onResume(handler) { resumeHandlers.push(handler); },
    onClose(handler) { closeHandlers.push(handler); },
    onConnectFail(handler) { connectFailHandlers.push(handler); },
    close,
    dropTransport,
    /** Session is active (including while detached, during which `send` buffers and replays after resume) */
    get connected() { return !closed && sess !== null; },
    get closed() { return closed; },
    stats() {
      const s = sess;
      return {
        ...counters,
        transport: attached() ? 'ws' : null,
        pendingBytes: s ? s.pendingBytes : 0,
        legacy: !!s?.legacy,
        detached: !!(s && !s.legacy && s.detachedAt !== null),
        lastClose: lastClose ? { ...lastClose } : null,
        lastDetach: lastDetach ? { ...lastDetach } : null,
        mode,
      };
    },
  };
}
