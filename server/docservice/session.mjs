/**
 * Document service session layer (part of assembly layer, contract
 * `docs/plan/http-transport-contract.md` sections 3, 4, 5, 7, 8 and section 16).
 *
 * See semantics under "Sessions and transports" in `docs/semantics/product/document-service.md` and
 * `docs/semantics/mechanism/document-service.md`: a session exists between document service and each
 * party; messages within session are bidirectionally ordered and sequence-numbered, acknowledged by
 * receiver; transports (WebSocket, HTTP long polling) are merely carrier methods, interruption of a
 * single transport does not end session, and it is only considered disconnected once retention time
 * limit is exceeded.
 *
 * Core (`router.mjs`) only sees a connection (`connId`): `router.connect` when session is
 * established, and `router.disconnect` when session ends; disconnecting and resuming transports do
 * not pass through core, and modules are unaware of them. Four core hooks connect here (section 7):
 * - `write(connId, text)`: attaches `seq` and `ack`, puts into unacknowledged buffer; writes out if
 *   transport is attached, or retains while detached;
 * - `buffered(connId)`: unacknowledged byte count (including those already handed to socket), so
 *   when client does not acknowledge, backlog keeps growing; once it exceeds limit, core ends
 *   session with 1013;
 * - `close(connId, code, reason)`: ends session (not retained), closes current transport; defers
 *   `router.disconnect` and `conn.close` to next event loop iteration;
 * - `router.drained(connId)`: called once after peer's `ack` advances and unacknowledged bytes
 *   decrease.
 *
 * Legacy clients (handshake without session items, section 3.6) are also registered here, marked
 * `legacy`: messages do not have `seq` / `ack` added, handed to core as-is, backlog is calculated
 * from sockets, session ends as soon as transport disconnects (retention time limit is equivalent to
 * 0), matching behavior prior to session layer.
 *
 * Transport objects are created by assembly layer (WebSocket, `service.mjs`) or long polling
 * (`http-transport.mjs`, HT-b wiring), with shape:
 * `{ kind: 'ws' | 'http', send(wireText), control(obj), close(code, reason), bufferedAmount? }`.
 * - `send`: a business message with `seq` (WebSocket writes immediately; long polling only wakes
 *   pending GET, frames are fetched by `pull`);
 * - `control`: session control messages (`session.welcome`, `session.ack`). Not used by long
 *   polling: welcome info is in response to `POST /lp/open`, and acknowledgment is in response to
 *   `POST /lp/send`.
 *
 * Session id `sid` is 32-byte CSPRNG base64url, serving as bearer credential for session: appears
 * only in handshake request headers and `session.welcome`, never in logs, `describe()`, or
 * `/healthz`. Only imports Node built-in modules.
 */
import { randomBytes } from 'node:crypto';

export const SESSION_DEFAULTS = Object.freeze({
  /** How long session is retained after transport disconnects (section 4.2) */
  RETAIN_MS: 60_000,
  /** How long ended sessions keep tombstones: resuming with it during this time gets 4410 (section 4.2, section 16) */
  TOMBSTONE_MS: 120_000,
  /** Sends a standalone `session.ack` once unacknowledged received messages reach this count (section 3.3) */
  ACK_EVERY: 32,
  /** Sends a standalone `session.ack` if there is no piggyback acknowledgment opportunity this long after receiving a message (section 3.3) */
  ACK_DELAY_MS: 1000,
  /**
   * Also sends standalone once received unacknowledged bytes reach this amount (supplement in this
   * implementation [ruling]): peer's unacknowledged buffer has an upper limit (1 MiB), and if
   * back-to-back large messages are acknowledged only by message count and 1 s, the peer might exceed
   * the limit within 1 s and end session
   */
  ACK_BYTES: 64 * 1024,
});

/** Session items (section 4.1) */
export const SESSION_ITEM_NEW = 'promptcut.session.new';
export const SESSION_ITEM_PREFIX = 'promptcut.session.';
/** Type prefix for session control messages: reserved by core, modules must not claim (section 3.2) */
export const SESSION_TYPE_PREFIX = 'session.';

/** Close codes used by session layer */
export const SESSION_CLOSE = Object.freeze({
  /** Out-of-order or out-of-bounds ack (section 3.5) */
  BAD_SEQ: 1002,
  /** New transport connects for the same session, old one is closed (section 3.1) */
  SUPERSEDED: 4009,
  /** Resume over WebSocket: session does not exist (section 16, corresponds to HTTP 404 `no-session`) */
  NO_SESSION: 4404,
  /** Resume over WebSocket: session already ended (section 16, corresponds to HTTP 410 `session-closed`) */
  SESSION_CLOSED: 4410,
});

/**
 * Transports closing with these codes end the session rather than detaching: protocol error
 * occurred on this transport (`ws.mjs` protocol error, binary frame, malformed UTF-8, too long),
 * and retransmitting the same message after resuming will only fail again.
 */
const END_ON_TRANSPORT_CODES = new Set([1002, 1003, 1007, 1009]);

const RESUME_RE = /^promptcut\.session\.([A-Za-z0-9_-]{43})\.(0|[1-9][0-9]{0,15})$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byteLen = (text) => Buffer.byteLength(text, 'utf8');
const positive = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/** Close reason truncated to within 123 bytes (upper limit of WebSocket close frame) */
export function clipReason(v) {
  if (typeof v !== 'string') return '';
  let s = v;
  while (byteLen(s) > 123) s = s.slice(0, -1);
  return s;
}

/** Client-provided close code: recognizes only 1000 and 3000-4999 (application-usable range), records others as 1000 */
export function clientCloseCode(v) {
  return Number.isInteger(v) && (v === 1000 || (v >= 3000 && v <= 4999)) ? v : 1000;
}

/**
 * Identifies session item from handshake subprotocol list (section 4.1):
 * - `{ kind: 'legacy' }`: no session item, legacy client (section 3.6);
 * - `{ kind: 'new' }`: `promptcut.session.new`, provided together with authentication item;
 * - `{ kind: 'resume', sid, ack }`: `promptcut.session.<sid>.<ack>`; list can only contain
 *   `promptcut.v1` and it (resume item and authentication item are mutually exclusive);
 * - `{ kind: 'bad' }`: more than one session item, invalid format, other items alongside resume
 *   item, or missing `promptcut.v1`. Handshake returns 400.
 */
export function parseSessionItem(offered, protocol = 'promptcut.v1') {
  const list = Array.isArray(offered) ? offered : [];
  const items = list.filter((p) => p.startsWith(SESSION_ITEM_PREFIX));
  if (items.length === 0) return { kind: 'legacy' };
  if (items.length > 1 || !list.includes(protocol)) return { kind: 'bad' };
  if (items[0] === SESSION_ITEM_NEW) return { kind: 'new' };
  const m = RESUME_RE.exec(items[0]);
  if (!m) return { kind: 'bad' };
  if (list.some((p) => p !== protocol && p !== items[0])) return { kind: 'bad' };
  const ack = Number(m[2]);
  if (!Number.isSafeInteger(ack)) return { kind: 'bad' };
  return { kind: 'resume', sid: m[1], ack };
}

/**
 * Appends `seq` and `ack` to message text written by core: appended at end of object (fields with
 * same name appearing later take precedence, overriding any `seq` / `ack` written by module itself).
 * Core always writes `JSON.stringify(object)`; non-object texts are returned as-is (cannot carry
 * sequence numbers, can only be caller error).
 */
function withSeq(text, seq, ack) {
  if (text.length < 2 || text[0] !== '{' || text[text.length - 1] !== '}') return text;
  const tail = `"seq":${seq},"ack":${ack}}`;
  return text.length === 2 ? `{${tail}` : `${text.slice(0, -1)},${tail}`;
}

/**
 * @param {object} options
 * @param {object} options.router Core (return value of `createRouter`); uses its `connect`, `disconnect`, `dispatch`, `drained`
 * @param {() => string} options.nextConnId Same ID sequence as other connections
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {number} [options.retainMs] Default 60 000
 * @param {number} [options.tombstoneMs] Default 120 000
 * @param {(principal: object) => string | null} [options.resumeGate] Re-checks persistent permission status before resume
 */
export function createSessionLayer({
  router,
  nextConnId,
  now = Date.now,
  log = () => {},
  retainMs,
  tombstoneMs,
  resumeGate,
} = /** @type {any} */ ({})) {
  if (!router || typeof router.connect !== 'function') throw new TypeError('createSessionLayer: router is required');
  if (typeof nextConnId !== 'function') throw new TypeError('createSessionLayer: nextConnId is required');
  const retain = positive(retainMs, SESSION_DEFAULTS.RETAIN_MS);
  const tombTtl = positive(tombstoneMs, SESSION_DEFAULTS.TOMBSTONE_MS);
  const say = (event, fields) => { try { log(event, fields); } catch { /* Log errors do not affect the session */ } };

  /** connId → session (including legacy clients) */
  const byConn = new Map();
  /** sid → session (session-aware only) */
  const bySid = new Map();
  /** sid → { code, reason, until }: ended sessions */
  const tombs = new Map();
  const counters = { opened: 0, resumed: 0, expired: 0, fallbacks: 0 };

  function newSid() {
    let sid;
    do sid = randomBytes(32).toString('base64url'); while (bySid.has(sid) || tombs.has(sid));
    return sid;
  }

  function record(connId, { legacy, principal, remote, transport, fallback }) {
    const s = {
      connId,
      sid: legacy ? null : newSid(),
      legacy,
      principal,
      remote,
      transport,
      lastTransport: transport.kind,
      fallback: fallback ?? null,
      ended: false,
      gone: null,
      resolveGone: null,
      // Outbound: numbered messages, `frames[head..]` are not yet acknowledged; `acked` is highest seq acknowledged by peer
      outSeq: 0,
      acked: 0,
      frames: [],
      head: 0,
      unackedBytes: 0,
      // Inbound: maximum seq fully received in order; `ackSent` has been told to peer; `inBytes` is bytes received since then
      inSeq: 0,
      ackSent: 0,
      inBytes: 0,
      ackTimer: null,
      // Detach
      detachedAt: 0,
      retainTimer: null,
      resumes: 0,
    };
    if (legacy) s.gone = new Promise((resolve) => { s.resolveGone = resolve; });
    return s;
  }

  const welcomeOf = (s, resumed) => ({
    type: 'session.welcome', sid: s.sid, resumed, ack: s.inSeq, retainMs: retain, transport: s.transport?.kind ?? s.lastTransport,
    ...(s.principal?.realm === 'account' && s.principal?.role === 'agent' ? { connId: s.connId } : {}),
  });

  function noteFallback(s, fallback) {
    if (typeof fallback !== 'string' || fallback === '') return;
    s.fallback = fallback;
    counters.fallbacks += 1;
    say('session.fallback', { connId: s.connId, reason: fallback });
  }

  // ---------- Acknowledgments ----------

  function clearAckTimer(s) {
    if (s.ackTimer) clearTimeout(s.ackTimer);
    s.ackTimer = null;
  }

  /** Already communicated `inSeq` to peer (piggybacked or standalone) */
  function markAcked(s) {
    s.ackSent = s.inSeq;
    s.inBytes = 0;
    clearAckTimer(s);
  }

  /** Sends standalone `session.ack`. Not sent when detached: included in welcome upon resume */
  function sendAck(s) {
    clearAckTimer(s);
    if (s.ended || !s.transport || s.inSeq <= s.ackSent) return;
    try {
      s.transport.control({ type: 'session.ack', ack: s.inSeq });
    } catch { /* Transport broken, waiting for it to report close */ }
    markAcked(s);
  }

  /** After receiving next application message: ack immediately if count or bytes reached, else send standalone if no piggyback within 1 s */
  function noteReceived(s, bytes) {
    if (s.ended) return;
    s.inBytes += bytes;
    if (s.inSeq <= s.ackSent) return;
    if (s.inSeq - s.ackSent >= SESSION_DEFAULTS.ACK_EVERY || s.inBytes >= SESSION_DEFAULTS.ACK_BYTES) {
      sendAck(s);
      return;
    }
    if (!s.ackTimer) {
      s.ackTimer = setTimeout(() => { s.ackTimer = null; sendAck(s); }, SESSION_DEFAULTS.ACK_DELAY_MS);
      s.ackTimer.unref?.();
    }
  }

  /** Drops frames acknowledged by peer; if buffer drops, lets core continue writing backlogged messages. `ack` out of bounds returns false (session already ended with 1002) */
  function applyAck(s, ack) {
    if (!Number.isSafeInteger(ack) || ack < 0 || ack > s.outSeq) {
      badSeq(s);
      return false;
    }
    if (!release(s, ack)) return true;
    try {
      router.drained(s.connId);
    } catch (err) {
      say('conn.error', { connId: s.connId, message: String(err?.message ?? err) });
    }
    return !s.ended;
  }

  /** Drops frames with seq ≤ ack; returns whether any were dropped (does not call core) */
  function release(s, ack) {
    if (ack <= s.acked) return false;
    s.acked = ack;
    while (s.head < s.frames.length && s.frames[s.head].seq <= ack) {
      s.unackedBytes -= s.frames[s.head].bytes;
      s.head += 1;
    }
    if (s.head === s.frames.length) {
      s.frames = [];
      s.head = 0;
    } else if (s.head > 1024 && s.head * 2 > s.frames.length) {
      s.frames = s.frames.slice(s.head);
      s.head = 0;
    }
    return true;
  }

  function badSeq(s) {
    say('session.bad-seq', { connId: s.connId });
    endSession(s, SESSION_CLOSE.BAD_SEQ, 'bad-seq');
  }

  // ---------- Lifecycle ----------

  /**
   * Ends session: do not retain. Erects tombstone (for session-aware ones), closes current transport;
   * calls `router.disconnect` and logs `conn.close` in next event loop tick (module's `ctx.close`
   * may currently be inside its own handler). Returns a Promise for completed unregistration.
   */
  function endSession(s, code, reason, { closeTransport = true, discard = false } = {}) {
    if (s.ended) return s.gone;
    s.ended = true;
    clearAckTimer(s);
    if (s.retainTimer) clearTimeout(s.retainTimer);
    s.retainTimer = null;
    if (s.sid) {
      bySid.delete(s.sid);
      tombs.set(s.sid, { code, reason, until: now() + tombTtl });
    }
    const t = s.transport;
    s.transport = null;
    // Hands unacknowledged frames to transport being closed: long polling returns all of them before
    // sending `closed` (Section 6.3); WebSocket has already written them out, not needed
    const rest = !discard && t && closeTransport && t.kind !== 'ws' ? s.frames.slice(s.head).map((f) => withSeq(f.text, f.seq, s.inSeq)) : [];
    s.frames = [];
    s.head = 0;
    s.unackedBytes = 0;
    if (t && closeTransport) {
      try { t.close(code, reason, rest); } catch { /* Closed */ }
    }
    s.gone = new Promise((resolve) => {
      setImmediate(() => {
        if (byConn.get(s.connId) === s) byConn.delete(s.connId);
        try {
          router.disconnect(s.connId);
        } catch (err) {
          say('conn.error', { connId: s.connId, message: String(err?.message ?? err) });
        }
        say('conn.close', { connId: s.connId, code, reason, transport: s.lastTransport });
        s.resolveGone?.();
        resolve();
      });
    });
    return s.gone;
  }

  /** Transport disconnected: session detaches, retained for `retainMs`, ends upon expiration (Section 4.2) */
  function detach(s, info = {}) {
    const t = s.transport;
    s.transport = null;
    s.detachedAt = now();
    clearAckTimer(s);
    say('session.detach', { connId: s.connId, transport: t?.kind ?? s.lastTransport, ...(info.code !== undefined ? { code: info.code } : {}), ...(info.why ? { why: info.why } : {}) });
    if (s.retainTimer) clearTimeout(s.retainTimer);
    s.retainTimer = setTimeout(() => {
      s.retainTimer = null;
      if (s.ended || s.transport) return;
      counters.expired += 1;
      say('conn.timeout', { connId: s.connId, transport: s.lastTransport });
      endSession(s, 1006, 'timeout');
    }, retain);
    s.retainTimer.unref?.();
  }

  function sendFrame(s, f) {
    try {
      s.transport.send(withSeq(f.text, f.seq, s.inSeq));
    } catch { /* Transport broken, waiting for it to report close */ }
    markAcked(s);
  }

  function tombOf(sid) {
    const tomb = tombs.get(sid);
    if (!tomb) return null;
    if (tomb.until <= now()) {
      tombs.delete(sid);
      return null;
    }
    return tomb;
  }

  const live = () => [...byConn.values()].filter((s) => !s.ended);

  return {
    /**
     * Legacy clients (without session items): one transport is one session. Registers into core, returns connId.
     * `principal` is normalized; assembly layer must call `transportClosed` after `transport.close`.
     */
    openLegacy({ principal, remote, transport }) {
      const connId = nextConnId();
      const s = record(connId, { legacy: true, principal, remote, transport });
      byConn.set(connId, s);
      counters.opened += 1;
      say('conn.open', { connId, remote, userId: principal.userId, ...(principal.role ? { role: principal.role } : {}), transport: transport.kind, legacy: true });
      router.connect(connId, principal, { remote, connectedAt: now() });
      return connId;
    },

    /**
     * Creates new session: first sends `session.welcome` (first outbound message) via this transport,
     * then registers into core (module `connect` may send messages immediately).
     * Returns `{ connId, sid, welcome }`; long polling puts fields of `welcome` into `POST /lp/open` response.
     */
    openSession({ principal, remote, transport, fallback }) {
      const connId = nextConnId();
      const s = record(connId, { legacy: false, principal, remote, transport });
      byConn.set(connId, s);
      bySid.set(s.sid, s);
      counters.opened += 1;
      noteFallback(s, fallback);
      const welcome = welcomeOf(s, false);
      try { transport.control(welcome); } catch { /* Transport broken, waiting for it to report close */ }
      say('conn.open', { connId, remote, userId: principal.userId, ...(principal.role ? { role: principal.role } : {}), transport: transport.kind });
      router.connect(connId, principal, { remote, connectedAt: now() });
      return { connId, sid: s.sid, welcome };
    },

    /**
     * Resume (Section 4.1): session id is the credential, no re-authentication. On success, returns
     * `{ ok: true, connId, welcome }`: closes old transport (half-open) with 4009, sends welcome
     * (with highest client seq fully received by server), then retransmits messages unacknowledged by peer
     * using original seq.
     * On failure, returns `{ ok: false, code, reason, status }`:
     * - Session does not exist: 4404 `no-session` (HTTP 404);
     * - Ended (tombstone exists): 4410, `reason` is `session-closed <original close code>[ <original reason>]` (HTTP 410);
     * - `ack` greater than maximum seq sent by server: session ends with 1002 `bad-seq`, returns same code (HTTP 410).
     */
    resume({ sid, ack, transport, fallback }) {
      const s = bySid.get(sid);
      if (!s || s.ended) {
        const tomb = tombOf(sid);
        if (tomb) {
          return {
            ok: false, status: 410, code: SESSION_CLOSE.SESSION_CLOSED, closedCode: tomb.code, closedReason: tomb.reason,
            reason: clipReason(`session-closed ${tomb.code}${tomb.reason ? ` ${tomb.reason}` : ''}`),
          };
        }
        return { ok: false, status: 404, code: SESSION_CLOSE.NO_SESSION, reason: 'no-session' };
      }
      const resumeAllowed = (reason) => {
        if (s.ended) return { ok: false, status: 410, code: SESSION_CLOSE.SESSION_CLOSED, reason: 'session-closed' };
        if (typeof transport.isUsable === 'function' && !transport.isUsable())
          return { ok: false, status: 503, code: 1012, reason: 'transport-unavailable' };
        if (typeof reason === 'string') {
          endSession(s, 1012, reason);
          return { ok: false, status: 503, code: 1012, closedCode: 1012, closedReason: reason, reason };
        }
      if (!Number.isSafeInteger(ack) || ack < 0 || ack > s.outSeq) {
        badSeq(s);
        return { ok: false, status: 410, code: SESSION_CLOSE.BAD_SEQ, closedCode: SESSION_CLOSE.BAD_SEQ, closedReason: 'bad-seq', reason: 'bad-seq' };
      }
      const old = s.transport;
      if (old) {
        s.transport = null;
        try { old.close(SESSION_CLOSE.SUPERSEDED, 'superseded'); } catch { /* Closed */ }
      }
      if (s.retainTimer) clearTimeout(s.retainTimer);
      s.retainTimer = null;
      const gapMs = s.detachedAt ? Math.max(0, now() - s.detachedAt) : 0;
      s.detachedAt = 0;
      s.transport = transport;
      s.lastTransport = transport.kind;
      s.resumes += 1;
      counters.resumed += 1;
      noteFallback(s, fallback);
      const welcome = welcomeOf(s, true);
      try { transport.control(welcome); } catch { /* Transport broken, waiting for it to report close */ }
      markAcked(s);
      say('session.resume', { connId: s.connId, transport: transport.kind, gapMs });
      // First release according to ack in resume item, retransmit remaining messages (original seq, in order),
      // and only then let core continue writing backlogged messages:
      // Otherwise new messages would be written before retransmitted old messages, and peer would see
      // skipped sequence numbers
      const released = release(s, ack);
      if (s.transport === transport) {
        for (let i = s.head; i < s.frames.length && s.transport === transport; i++) sendFrame(s, s.frames[i]);
      }
      if (released) {
        try {
          router.drained(s.connId);
        } catch (err) {
          say('conn.error', { connId: s.connId, message: String(err?.message ?? err) });
        }
      }
      return { ok: true, connId: s.connId, welcome };
      };
      if (typeof resumeGate !== 'function') return resumeAllowed(null);
      try {
        const reason = resumeGate(s.principal);
        return reason && typeof reason.then === 'function' ? reason.then(resumeAllowed, () => resumeAllowed('forbidden')) : resumeAllowed(reason);
      } catch { return resumeAllowed('forbidden'); }
    },

    /** Transport received text message (Section 3.3). Legacy clients handed to core as is */
    receive(connId, text) {
      const s = byConn.get(connId);
      if (!s || s.ended) return;
      if (s.legacy) {
        return router.dispatch(connId, text);
      }
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        msg = undefined;
      }
      // Not an object with type: hand to core to return bad-message (core responses are numbered as usual)
      if (!isObj(msg) || typeof msg.type !== 'string') {
        return router.dispatch(connId, text);
      }
      if (msg.type.startsWith(SESSION_TYPE_PREFIX)) {
        if (msg.type === 'session.ack') applyAck(s, msg.ack);
        else if (msg.type === 'session.close') endSession(s, clientCloseCode(msg.code), clipReason(msg.reason));
        // Ignore other control messages (client should not send them)
        return;
      }
      if (Object.hasOwn(msg, 'ack') && !applyAck(s, msg.ack)) return;
      const seq = msg.seq;
      if (!Number.isSafeInteger(seq) || seq < 1 || seq > s.inSeq + 1) {
        badSeq(s);
        return;
      }
      if (seq <= s.inSeq) return; // Duplicate, discard
      s.inSeq = seq;
      const body = { ...msg };
      delete body.seq;
      delete body.ack;
      const dispatched = router.dispatch(connId, JSON.stringify(body));
      noteReceived(s, byteLen(text));
      return dispatched;
    },

    /**
     * Transport closed (WebSocket close event; long polling determines transport disconnected).
     * Ignore if not current transport for this session (already replaced).
     * Legacy clients: session ends immediately, calls `router.disconnect` right away (synchronous, just
     * like before session layer existed).
     * Session-aware clients: detach, retain for `retainMs`; end immediately if protocol error occurred on
     * transport (1002, 1003, 1007, 1009).
     */
    transportClosed(connId, transport, { code, reason, why } = {}) {
      const s = byConn.get(connId);
      if (!s || s.ended || s.transport !== transport) return;
      if (s.legacy) {
        s.ended = true;
        s.transport = null;
        byConn.delete(connId);
        router.disconnect(connId);
        say('conn.close', { connId, code, reason, transport: transport.kind });
        s.resolveGone?.();
        return;
      }
      if (END_ON_TRANSPORT_CODES.has(code)) {
        endSession(s, code, typeof reason === 'string' ? reason : '', { closeTransport: false });
        return;
      }
      detach(s, { code, why });
    },

    // ---------- Core hooks ----------

    write(connId, text) {
      const s = byConn.get(connId);
      if (!s || s.ended) return;
      if (s.legacy) {
        s.transport?.send(text);
        return;
      }
      const f = { seq: ++s.outSeq, text, bytes: byteLen(text) };
      s.frames.push(f);
      s.unackedBytes += f.bytes;
      if (s.transport) sendFrame(s, f);
    },

    buffered(connId) {
      const s = byConn.get(connId);
      if (!s || s.ended) return 0;
      if (s.legacy) return Number(s.transport?.bufferedAmount ?? 0) || 0;
      return s.unackedBytes;
    },

    /** Core `close` and assembly layer `closeConn`: server actively closes, session ends immediately without retention (Section 4.2). Returns false if session does not exist */
    close(connId, code, reason) {
      const s = byConn.get(connId);
      if (!s || s.ended) return false;
      if (s.legacy) {
        try { s.transport?.close(code, reason); } catch { /* Closed */ }
        return true;
      }
      endSession(s, code, reason);
      return true;
    },

    /** Security fence is separate from normal close/tail replay. The caller owns
     * actual transport closure; this synchronously kills SID and outbound caches. */
    fence(connId, code = 4003, reason = 'access-revoked') {
      const s = byConn.get(connId);
      if (!s) return { sid: null, gone: Promise.resolve(), existed: false };
      const sid = s.sid;
      // Even an ordinary-close session still waiting for router disconnect cannot
      // leave its logical cache available through a dedicated security fence.
      s.frames = []; s.head = 0; s.unackedBytes = 0;
      const gone = endSession(s, code, reason, { closeTransport: false, discard: true });
      return { sid, gone: gone ?? Promise.resolve(), existed: true };
    },

    // ---------- For long polling (HT-b wiring) ----------

    /** Finds connId of an open session by session id; returns null if not found */
    connIdOf(sid) {
      const s = bySid.get(sid);
      return s && !s.ended ? s.connId : null;
    },

    /** Tombstone `{ code, reason }` of ended session; returns null if none */
    tombOf(sid) {
      const tomb = tombOf(sid);
      return tomb ? { code: tomb.code, reason: tomb.reason } : null;
    },

    /** Acknowledgment reported by peer via long polling; returns false if out of bounds (session already ended with 1002) */
    ack(connId, ack) {
      const s = byConn.get(connId);
      if (!s || s.ended || s.legacy) return false;
      return applyAck(s, ack);
    },

    /** Highest seq from peer fully received in order by server, also counted as told to peer (long polling includes it in `POST /lp/send` response) */
    takeAck(connId) {
      const s = byConn.get(connId);
      if (!s || s.legacy) return 0;
      if (!s.ended) markAcked(s);
      return s.inSeq;
    },

    /** Client-initiated termination (long polling `POST /lp/close`, same as `session.close`, Section 4.2); returns false if session does not exist */
    end(connId, code, reason) {
      const s = byConn.get(connId);
      if (!s || s.ended || s.legacy) return false;
      endSession(s, clientCloseCode(code), clipReason(reason));
      return true;
    },

    /** Maximum seq sent by server */
    lastSeq(connId) {
      return byConn.get(connId)?.outSeq ?? 0;
    },

    /**
     * Long polling GET frame fetch: unacknowledged application messages (text with seq and current ack),
     * from the earliest, total bytes not exceeding `maxBytes` (at least one frame).
     * Frames stay in buffer until peer acknowledges; same frame may appear in two GET requests,
     * peer deduplicates by seq.
     */
    pull(connId, maxBytes) {
      const s = byConn.get(connId);
      if (!s || s.ended || s.legacy) return [];
      const out = [];
      let size = 0;
      for (let i = s.head; i < s.frames.length; i++) {
        const f = s.frames[i];
        if (out.length > 0 && size + f.bytes > maxBytes) break;
        out.push(withSeq(f.text, f.seq, s.inSeq));
        size += f.bytes;
      }
      if (out.length > 0) markAcked(s);
      return out;
    },

    /** Whether there are unacknowledged application messages (long polling checks whether GET should hang) */
    hasPending(connId) {
      const s = byConn.get(connId);
      return !!s && !s.ended && !s.legacy && s.head < s.frames.length;
    },

    /** Whether this transport is the one currently attached to this session */
    isCurrent(connId, transport) {
      const s = byConn.get(connId);
      return !!s && !s.ended && s.transport === transport;
    },

    // ---------- Assembly layer ----------

    has(connId) {
      const s = byConn.get(connId);
      return !!s && !s.ended;
    },

    /** Number of open sessions (including detached ones and legacy clients), counts toward `maxConnections` */
    size() {
      return live().length;
    },

    connIds() {
      return live().map((s) => s.connId);
    },

    /** Assembly layer fields of `describe().conns[i]` (Section 8) */
    describeConn(connId) {
      const s = byConn.get(connId);
      if (!s) return null;
      return { transport: s.transport?.kind ?? null, fallback: s.fallback, detached: !s.legacy && !s.ended && !s.transport, resumes: s.resumes };
    },

    /** `sessions` in `/healthz` (Section 8): excludes identity, address, and session id */
    stats() {
      const list = live().map((s) => ({
        connId: s.connId,
        transport: s.transport?.kind ?? null,
        fallback: s.fallback,
        detached: !s.legacy && !s.transport,
        legacy: s.legacy,
      }));
      return {
        total: list.length,
        ws: list.filter((i) => i.transport === 'ws').length,
        http: list.filter((i) => i.transport === 'http').length,
        detached: list.filter((i) => i.detached).length,
        legacy: list.filter((i) => i.legacy).length,
        opened: counters.opened,
        resumed: counters.resumed,
        expired: counters.expired,
        fallbacks: counters.fallbacks,
        list,
      };
    },

    /** Deletes expired tombstones (called every round by assembly layer heartbeat) */
    sweep() {
      const t = now();
      for (const [sid, tomb] of tombs) {
        if (tomb.until <= t) tombs.delete(sid);
      }
    },

    /**
     * Shutdown: all sessions end with `code` (detached ones also end), legacy clients close their
     * transports. Returns a Promise for all unregistrations completed.
     */
    closeSpace(space, code, reason) {
      for (const s of [...byConn.values()]) if (s.principal?.tenantId === space) endSession(s, code, reason);
    },
    closeAll(code, reason) {
      const waits = [];
      for (const s of [...byConn.values()]) {
        if (s.ended) {
          if (s.gone) waits.push(s.gone);
          continue;
        }
        if (s.legacy) {
          waits.push(s.gone);
          try { s.transport?.close(code, reason); } catch { /* Closed */ }
          continue;
        }
        waits.push(endSession(s, code, reason));
      }
      return Promise.all(waits).then(() => {});
    },
  };
}
