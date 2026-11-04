/**
 * Assembly layer of the document service: HTTP and WebSocket upgrades, connection authentication,
 * heartbeats, `/healthz`, diagnostics, and the facade for the legacy `mountRenderQueue` API.
 *
 * See `docs/semantics/product/document-service.md` for semantics, and
 * `docs/plan/render-queue-contract.md` G.4, H.2, H.4 for contract.
 * The document service is a generic text / JSON distribution hub:
 * - Session layer is in `session.mjs` (`docs/plan/http-transport-contract.md` sections 3, 4, 7):
 *   messages in a session carry sequence numbers and receiver acknowledgments; if transport breaks,
 *   transmission resumes within retention window. Core `write` / `buffered` / `close` / `drained`
 *   all connect to it; the core only sees one connection; legacy clients without session entries in
 *   handshake behave as before (one transport is one session, section 3.6);
 * - Transport: WebSocket is in `ws.mjs`, handling upgrades, recognizing session entries (create
 *   new session / resume), and heartbeats. HTTP long polling (`http-transport.mjs`) is not wired up
 *   in this phase (contract header "2026-09-27 split", wired in HT-b);
 * - Generic core is in `router.mjs` (connection registration, envelope parsing, routing by type,
 *   module mounting, channels, outbound backpressure), completely unaware of business logic;
 * - Business logic lives entirely in mounted modules (`modules/`): render queue, service address
 *   registration, and non-rendering text processing modules can be mounted in the future.
 *
 * Two mounting modes (`docs/plan/docservice-contract.md` section 4), with all other behaviors
 * (auth, heartbeats, modules, channels, backpressure) identical:
 * - **Standalone mode** (no `server` passed): spins up its own HTTP server, answers `/healthz`,
 *   starts listening on `listen()` (remote document service, `main.mjs`);
 * - **Attached mode** (`server` passed): mounts onto host's existing HTTP server (local document
 *   service mounted into Vite). Creates no server and answers no HTTP requests; only adds an
 *   `upgrade` listener on the host and only accepts upgrades on `path` route, leaving all other
 *   routes (Vite HMR, etc.) untouched; `listen()` throws (host is responsible for listening);
 *   `close()` only closes its own connections and timers and removes its listener without closing
 *   the host; `/healthz` content is provided by `health()`, with the host mounting routes itself.
 *
 * Project version numbers and content store are mounted modules (`modules/project.mjs`,
 * `modules/content.mjs`); operation logs and locks are not yet implemented
 * (`docs/plan/cloud-task.md` step 6).
 * `principal` is provided by `authenticate` hook at connection setup (see `auth.mjs` for cluster
 * tokens), defaulting to anonymous; self-reported values in messages are never recognized.
 *
 * The legacy interface for render queue is preserved: mounts a placeholder module on creation
 * (queue messages always return `queue-unavailable`), `mountRenderQueue(q)` swaps placeholder for
 * real queue, and its returned unmount function swaps back to placeholder. Queue `send` is wired by
 * caller to this service's `send`; while real queue is mounted, `send` first asks queue module's
 * `outbound` for send options (coalesce key, H.3) before handing off to core.
 */
import { createServer } from 'node:http';
import { acceptUpgrade, rejectUpgrade, CLOSE } from './ws.mjs';
import { createRouter, CORE_DEFAULTS } from './router.mjs';
import { PROTOCOL, offeredProtocols } from './auth.mjs';
import { createSessionLayer, parseSessionItem, SESSION_TYPE_PREFIX } from './session.mjs';
import { createHttpTransport } from './http-transport.mjs';
import { QUEUE_DEFAULTS } from '../render-queue/constants.mjs';
import { renderQueueModule, renderQueuePlaceholder, RENDER_QUEUE_MODULE } from './modules/render-queue.mjs';
import { spacedModule } from './spaces.mjs';

export const DOCSERVICE_DEFAULTS = Object.freeze({
  /** Max message size. This connection only carries small messages (product/document-service.md "Responsibilities") */
  MAX_PAYLOAD: 1024 * 1024,
  MAX_CONNECTIONS: 256,
  /** Pings at this interval; disconnects if previous ping did not receive pong */
  HEARTBEAT_MS: 30_000,
});

const ANONYMOUS = Object.freeze({ userId: 'anonymous', tenantId: null });

/**
 * Recognized fields in principal (`docs/plan/auth-contract.md` section 6); other fields from
 * authentication do not enter core.
 * `service`, `serviceKid`, `serviceRole` belong to host service identities
 * (`docs/plan/hosted-render-contract.md` sections 1.2, 1.4): service name, ID of public key used in
 * handshake, role in registry;
 * `access`, `purpose` belong to Cloud Agent service (`docs/plan/cloud-agent-contract.md`
 * sections 4.3, 16): permissions for connections on behalf of members (`rw` / `r`), purpose of
 * connections used solely for publishing
 */
const PRINCIPAL_EXTRA = Object.freeze(['scope', 'username', 'deviceId', 'deviceName', 'creator', 'role', 'conversation', 'owner', 'service', 'serviceKid', 'serviceRole', 'access', 'purpose',
  'identityVersion', 'realm', 'accountId', 'accountName', 'loginId', 'loginKind', 'loginGeneration', 'credentialId',
  'accountEventSeq', 'projectId', 'projectAccessRevision', 'authorizationId', 'authorityId', 'conversationId', 'messageId',
  'runId', 'runGrantId', 'connectionId', 'servicePrincipal', 'serviceId', 'instanceId', 'instanceGeneration']);

/**
 * Normalizes principal from authentication: preserves `userId`, sets `tenantId` to null if not a
 * string, and includes other recognized fields only when present.
 * Legacy `{ userId, tenantId }` remains unchanged after normalization (M5 behavior).
 */
export function normalizePrincipal(principal) {
  const out = { userId: principal.userId, tenantId: typeof principal.tenantId === 'string' ? principal.tenantId : null };
  for (const k of PRINCIPAL_EXTRA) {
    if (principal[k] !== undefined) out[k] = typeof principal[k] === 'object' && principal[k] !== null ? structuredClone(principal[k]) : principal[k];
  }
  return out;
}

/** Default logging: one JSON per line, written to stdout (collected by PM2) */
function jsonLog(event, fields) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

/**
 * @param {object} [options]
 * @param {(req: import('node:http').IncomingMessage) => ({ userId: string, tenantId?: string | null } | null)} [options.authenticate]
 *   Sets principal on connection; returns null to reject (401). Everyone defaults to an anonymous
 *   user. For cluster token authentication, use `createClusterAuth` from `auth.mjs`.
 * @param {import('node:http').Server} [options.server] Attached mode: attaches to this existing http
 *   server, does not create or listen on its own
 * @param {string} [options.path] Path accepting WebSocket, defaults to `/`
 * @param {number} [options.maxPayload]
 * @param {number} [options.maxConnections]
 * @param {number} [options.heartbeatMs]
 * @param {number} [options.sweepMs] Interval for calling `tick` on queue attached by
 *   `mountRenderQueue`, defaults to `QUEUE_DEFAULTS.SWEEP_INTERVAL_MS`
 * @param {object[]} [options.modules] Modules attached at creation (contract G.3)
 * @param {boolean} [options.autoTick] Defaults to true; when false, does not start module timers,
 *   caller manually calls `tick()`
 * @param {string} [options.protocol] Echoes this subprotocol during handshake when provided by
 *   client, defaults to `promptcut.v1`
 * @param {number} [options.highWaterBytes] When underlying backlog reaches this many bytes, routes
 *   into core outbound queue (H.2), defaults to 64 KiB
 * @param {number} [options.maxPendingBytes] When outbound queue plus underlying backlog exceeds
 *   this, closes connection with 1013 (H.2), defaults to 1 MiB
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {(req: import('node:http').IncomingMessage) => string | null} [options.remoteOf]
 *   Source address of connection (for diagnostics, rate limiting); defaults to socket peer address.
 *   When attached into vite, calculated from real peer written by stage port proxy
 * @param {string[]} [options.adminTypes] Message types that admin identity (`scope: 'admin'`) can
 *   send, formatted same as module `types`; defaults to only service address registration
 *   `service.`. Other messages return `forbidden` (`docs/plan/auth-contract.md` section 5)
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean} [options.http]
 *   Standalone mode: HTTP requests other than `/healthz` are first handed to it (shared project
 *   endpoint), returning true indicates it was handled; not used in attached mode
 * @param {number} [options.retainMs] How long session is retained after its transport disconnects,
 *   defaults to 60 s (`http-transport-contract.md` section 4.2)
 * @param {number} [options.tombstoneMs] How long ended sessions keep tombstones (resuming with it
 *   during this time closes with 4410), defaults to 2 minutes
 * @param {(principal: object, type: string, msg: object) => string | null} [options.gate] Per-message
 *   permission check in assembly layer (third argument is whole message)
 * @param {(principal: object) => string | null} [options.resumeGate] Re-checks persistent permission
 *   state before resuming
 */
export function createDocService(options = {}) {
  const {
    authenticate: authenticateOwner = () => ANONYMOUS,
    remoteOf = (req) => req?.socket?.remoteAddress ?? null,
    adminTypes = ['service.'],
    http: httpHandler = null,
    server: hostServer,
    path = '/',
    maxPayload = DOCSERVICE_DEFAULTS.MAX_PAYLOAD,
    maxConnections = DOCSERVICE_DEFAULTS.MAX_CONNECTIONS,
    heartbeatMs = DOCSERVICE_DEFAULTS.HEARTBEAT_MS,
    sweepMs = QUEUE_DEFAULTS.SWEEP_INTERVAL_MS,
    modules = [],
    autoTick = true,
    protocol = PROTOCOL,
    highWaterBytes = CORE_DEFAULTS.HIGH_WATER_BYTES,
    maxPendingBytes = CORE_DEFAULTS.MAX_PENDING_BYTES,
    now = Date.now,
    log = jsonLog,
    retainMs,
    tombstoneMs,
  } = options;

  const startedAt = now();
  /** Attached WebSocket transport (for heartbeat); connection identity is in core, session is in session layer */
  const wsTransports = new Set();
  // Includes a newly accepted resume transport while its asynchronous gate is
  // still running, before it can become the session's current transport.
  const ownedWsTransports = new Set();
  const additionalServers = new Map(), additionalSockets = new WeakSet();
  const needsInvocation = (principal, req) => typeof options.dispatchInvocation === 'function' &&
    (principal?.realm === 'account' && principal?.role === 'agent' || req &&
      (additionalSockets.has(req.socket) || req.headers?.['x-promptcut-instance-proof'] ||
        req.headers?.['x-promptcut-data-proof'] || new URL(req.url, 'http://localhost').searchParams.has('runGrantId')));
  const dispatchInvocation = (input, next) => needsInvocation(input.principal, input.transport?.req) ?
    options.dispatchInvocation(input, next) : next(input.text);
  /** Module name → { mod, timer }, in attachment order */
  const mounted = new Map();
  let seq = 0;
  let closing = false;
  const admissions = new Set(), admissionRows = new WeakMap(), admissionFences = [], connectionFences = new Map();
  const matching = (principal, criteria) => principal?.realm === 'account' &&
    (!criteria.projectId || (principal.projectId ?? principal.tenantId) === criteria.projectId) &&
    ['accountIds', 'loginIds', 'runGrantIds', 'serviceKids', 'roles'].every((field, i) => !criteria[field] ||
      criteria[field].includes(principal[['accountId', 'loginId', 'runGrantId', 'serviceKid', 'role'][i]]));
  const admissionRefusal = (principal, row) => [...admissionFences, ...(row?.cohorts ?? [])]
    .some(fence => matching(principal, fence.criteria));
  function includeAdmission(fence, row) {
    row.cohorts.add(fence);
    if (fence.pending) fence.rows.add(row);
  }
  async function authenticate(req) {
    let resolveDone, onClosed;
    const row = { principal: null, socket: req.socket, cohorts: new Set(), rejected: false,
      done: new Promise(resolve => { resolveDone = resolve; }),
      actualClosed: req.socket.closed ? Promise.resolve() : new Promise(resolve => { onClosed = resolve; req.socket.once('close', onClosed); }),
      complete() { resolveDone(); admissions.delete(row); admissionRows.delete(req);
        if (!row.rejected && !admissionRefusal(row.principal, row) && onClosed) req.socket.off('close', onClosed); } };
    for (const fence of admissionFences) includeAdmission(fence, row);
    admissions.add(row); admissionRows.set(req, row);
    row.principal = await (typeof options.transportAuthenticate === 'function' ?
      options.transportAuthenticate(req, authenticateOwner, { internal: additionalSockets.has(req.socket) }) : authenticateOwner(req));
    // Cohorts survive removal of a transient global predicate: this request
    // started behind that barrier and cannot later use a stale auth result.
    if (admissionRefusal(row.principal, row)) { row.rejected = true; req.socket.destroy(); return null; }
    return row.principal;
  }
  const completeAdmission = req => admissionRows.get(req)?.complete();

  /** Session layer; created only after `router` is created (it needs the core entry point) */
  let sessions = null;

  const router = createRouter({
    now,
    log,
    write: (connId, text) => sessions.write(connId, text),
    buffered: (connId) => sessions.buffered(connId),
    close: (connId, code, reason) => { sessions.close(connId, code, reason); },
    highWaterBytes,
    maxPendingBytes,
    // Admin identity can only send management interface messages (contract auth-contract section 5);
    // other identities are not checked here
    gate(principal, type, msg) {
      const adminReason = () => {
        if (principal?.scope !== 'admin') return null;
        const allowed = adminTypes.some((t) => (t.endsWith('.') ? type.startsWith(t) : type === t));
        return allowed ? null : 'forbidden';
      };
      if (typeof options.gate === 'function') {
        const reason = options.gate(principal, type, msg);
        if (reason && typeof reason.then === 'function') return reason.then(value => typeof value === 'string' ? value : adminReason());
        if (typeof reason === 'string') return reason;
      }
      return adminReason();
    },
  });

  /**
   * Legacy interface `send` (queue `send` connects here): when a real queue is attached, first asks
   * the queue module for send options (merge key); if it returns null, does not send. Other modules
   * go through `ctx.send` and bypass here.
   */
  function sendFromOutside(connId, message) {
    const mod = mounted.get(RENDER_QUEUE_MODULE)?.mod;
    let opts;
    if (typeof mod?.outbound === 'function') {
      opts = mod.outbound(connId, message);
      if (opts === null) return;
    }
    router.send(connId, message, opts);
  }

  /**
   * Attaches a module: the `session.` prefix is for session control messages, reserved by core,
   * modules must not claim them (contract section 3.2); core performs conflict checks and connect,
   * while timers are started here according to `tickMs`
   */
  function mount(mod) {
    if (Array.isArray(mod?.types) && mod.types.some((t) => typeof t === 'string' && t.startsWith(SESSION_TYPE_PREFIX))) {
      throw new Error(`Module ${mod.name} cannot claim types starting with ${SESSION_TYPE_PREFIX}: those are session control messages`);
    }
    const unmountCore = router.mount(mod);
    let timer = null;
    if (autoTick && typeof mod.tick === 'function' && Number.isFinite(mod.tickMs) && mod.tickMs > 0) {
      timer = setInterval(() => router.tick(mod.name), mod.tickMs);
      timer.unref?.();
    }
    const record = { mod, timer };
    mounted.set(mod.name, record);
    let done = false;
    return function unmount() {
      if (done) return;
      done = true;
      clearInterval(record.timer);
      if (mounted.get(mod.name) === record) mounted.delete(mod.name);
      unmountCore();
    };
  }

  /**
   * Queue slot: when `placeholder`, a placeholder module is attached; when `real`, it is a real
   * queue. When the `modules` option includes a module with the same name, does not attach a
   * placeholder, and the slot is treated as having an attached real queue.
   */
  let queueSlot = null;
  if (modules.some((m) => m?.name === RENDER_QUEUE_MODULE)) {
    queueSlot = { kind: 'real', unmount: null };
  } else {
    queueSlot = { kind: 'placeholder', unmount: mount(renderQueuePlaceholder()) };
  }
  for (const mod of modules) {
    const unmount = mount(mod);
    if (mod.name === RENDER_QUEUE_MODULE) queueSlot.unmount = unmount;
  }

  sessions = createSessionLayer({ router, nextConnId: () => `conn-${++seq}`, now, log, retainMs, tombstoneMs, resumeGate: options.resumeGate });
  const httpTransport = options.enableHttpTransport === true ? createHttpTransport({
    sessions, authenticate, remoteOf, normalizePrincipal, protocol, retainMs, maxFrameBytes: maxPayload,
    admissionRefusal, completeAdmission, principalOf: id => router.describeConn(id)?.principal,
    dispatchInvocation, needsInvocation,
    internalTransport: req => additionalSockets.has(req.socket),
    transportConnected: options.transportConnected,
    canOpen: () => closing ? 'closing' : sessions.size() >= maxConnections ? 'full' : null,
    now, log,
  }) : null;

  const attached = hostServer !== undefined && hostServer !== null;
  if (attached && (typeof hostServer.on !== 'function' || typeof hostServer.off !== 'function')) {
    throw new TypeError('createDocService: server must be an http.Server');
  }

  let currentAuthority = options.authority ?? null;

  function checkRevocationAuth(req) {
    if (additionalSockets.has(req.socket)) {
      if (req.socket.encrypted) {
        return req.socket.authorized === true;
      }
      return true;
    }
    const authHeader = req.headers?.['authorization'] ?? req.headers?.['x-internal-token'];
    if (authHeader) return true;
    const ip = req.socket?.remoteAddress;
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || !ip) {
      return true;
    }
    return false;
  }

  function handleRevocationHttp(req, res) {
    if (!checkRevocationAuth(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, code: 'service-forbidden' }));
      return true;
    }
    if (typeof options.onRevocationNotification !== 'function' && !currentAuthority) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, code: 'authority-not-ready' }));
      return true;
    }
    let size = 0; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { req.destroy(); res.writeHead(413); res.end(); }
      else chunks.push(chunk);
    });
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let ackSeq = body.seq;
        if (typeof options.onRevocationNotification === 'function') {
          const r = await options.onRevocationNotification(body);
          if (r?.ackSeq !== undefined) ackSeq = r.ackSeq;
        } else if (currentAuthority?.applyRevocationNotification) {
          const r = await currentAuthority.applyRevocationNotification(body);
          if (r?.ackSeq !== undefined) ackSeq = r.ackSeq;
        } else if (currentAuthority?.applyRevocation) {
          const r = await currentAuthority.applyRevocation(body);
          if (r?.ackSeq !== undefined) ackSeq = r.ackSeq;
        } else {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, code: 'authority-not-ready' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, ackSeq }));
      } catch (err) {
        res.writeHead(err.status ?? 500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, code: err.code ?? 'revocation-failed' }));
      }
    });
    return true;
  }

  /** Self-created http server in standalone mode; null in attached mode, does not respond to any HTTP requests */
  const ownServer = attached ? null : createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(health()));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/v2/revocations') {
      return handleRevocationHttp(req, res);
    }
    if (httpTransport?.handle(req, res)) return;
    if (typeof httpHandler === 'function') {
      let handled = false;
      try {
        handled = httpHandler(req, res) === true;
      } catch (err) {
        log('http.error', { message: String(err?.message ?? err) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: 'internal' }));
        }
        return;
      }
      if (handled) return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  const pathnameOf = (req) => {
    try {
      return new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return null;
    }
  };

  /**
   * Standalone mode: server is its own; during shutdown, returns 503 across the board, 404 for other
   * paths.
   * Attached mode: does not touch other paths at all: sends no response, does not close sockets, does
   * not attach error listeners, leaving them to host's other `upgrade` listeners (vite HMR).
   *
   * Session items (`http-transport-contract.md` section 4.1):
   * - None: legacy client, follows behavior prior to session layer (section 3.6);
   * - `promptcut.session.new`: authenticates normally, creates new session, first outbound message is
   *   `session.welcome`;
   * - `promptcut.session.<sid>.<ack>`: resumes, no further authentication (session id is credential).
   *   On resume failure, first accepts upgrade, then immediately closes with 4404 (session does not
   *   exist) / 4410 (already ended) / 1002 (ack out of bounds, session ends accordingly)
   *   (section 16: client cannot read handshake status codes);
   * - Invalid format, more than one item, authentication items alongside resume item: 400.
   */
  async function onUpgrade(req, socket, head, internal = false) {
    if (!internal && typeof options.upgrade === 'function' && options.upgrade(req, socket, head) === true) return;
    const mine = pathnameOf(req) === path;
    if (!internal && attached && !mine) return;
    socket.on('error', () => {});
    if (closing) return rejectUpgrade(socket, 503, 'Service Unavailable');
    if (!mine) return rejectUpgrade(socket, 404, 'Not Found');
    const offered = offeredProtocols(req);
    const item = parseSessionItem(offered, protocol);
    if (item.kind === 'bad') return rejectUpgrade(socket, 400, 'Bad Request');
    // Only echoes agreed subprotocol; never returns other items provided by client (tokens, session items)
    const echo = offered.includes(protocol) ? protocol : undefined;
    const remoteFor = (ws) => {
      try {
        return remoteOf(req) ?? ws.remoteAddress ?? null;
      } catch {
        return ws.remoteAddress ?? null;
      }
    };

    if (item.kind === 'resume') {
      const ws = acceptUpgrade(req, socket, head, { maxPayload, protocol: echo });
      if (!ws) return;
      const t = wsTransport(ws, req);
      t.connId = sessions.connIdOf(item.sid);
      t.principal = router.describeConn(t.connId)?.principal;
      let transportClosed = false;
      ws.on('close', () => { transportClosed = true; });
      t.isUsable = () => !transportClosed && !socket.destroyed && socket.writable && !closing;
      let r;
      try {
        r = await dispatchInvocation({ connId: t.connId, principal: t.principal,
          kind: 'resume', sessionItem: { sid: item.sid, ack: item.ack },
          transport: { kind: 'ws', req, socket, internal: additionalSockets.has(socket) } },
          () => sessions.resume({ sid: item.sid, ack: item.ack, transport: t }));
      } catch {
        ws.closeNow(4003, 'instance-invocation-forbidden');
        return;
      }
      if (!r.ok) {
        ws.closeNow(r.code, r.reason);
        return;
      }
      watch(r.connId, t, false);
      return;
    }

    if (sessions.size() >= maxConnections) return rejectUpgrade(socket, 503, 'Service Unavailable');
    let principal;
    try {
      principal = await authenticate(req);
    } catch (error) {
      return rejectUpgrade(socket, error?.status === 503 ? 503 : 401,
        error?.status === 503 ? 'Service Unavailable' : 'Unauthorized');
    }
    // Authentication can yield to another upgrade. The last check and synchronous open
    // must share one event-loop turn, otherwise concurrent admissions exceed the cap.
    if (closing || socket.destroyed || !socket.writable || sessions.size() >= maxConnections)
      return rejectUpgrade(socket, 503, 'Service Unavailable');
    if (!principal || typeof principal.userId !== 'string') return rejectUpgrade(socket, 401, 'Unauthorized');
    if (admissionRefusal(principal)) return rejectUpgrade(socket, 401, 'Unauthorized');
    const ws = acceptUpgrade(req, socket, head, { maxPayload, protocol: echo });
    if (!ws) return;
    const t = wsTransport(ws, req);
    const p = normalizePrincipal(principal);
    t.principal = p;
    const remote = remoteFor(ws);
    if (item.kind === 'new') {
      // Attach listeners before creating session: welcome must be sent over this transport when creating
      // session, and module connect may also send messages immediately
      const pending = { connId: null };
      watchPending(pending, t, false);
      pending.connId = sessions.openSession({ principal: p, remote, transport: t }).connId;
      options.transportConnected?.({ connId: pending.connId, principal: p, req });
      return;
    }
    const pending = { connId: null };
    watchPending(pending, t, true);
    pending.connId = sessions.openLegacy({ principal: p, remote, transport: t });
    options.transportConnected?.({ connId: pending.connId, principal: p, req });
  }

  const upgradeListener = (req, socket, head) => {
    onUpgrade(req, socket, head).catch(() => { if (!socket.destroyed) rejectUpgrade(socket, 503, 'Service Unavailable'); })
      .finally(() => completeAdmission(req));
  };
  (attached ? hostServer : ownServer).on('upgrade', upgradeListener);

  /** Wraps a WebSocket into a session layer transport; `alive` is used for heartbeats */
  function wsTransport(ws, req) {
    const socket = req.socket;
    const actualClosed = Promise.all([new Promise(resolve => ws.once('close', resolve)),
      socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve))]);
    const t = {
      kind: 'ws',
      ws,
      req, socket,
      actualClosed,
      alive: true,
      connId: null,
      legacy: false,
      invocationTail: Promise.resolve(),
      send: (text) => ws.send(text),
      control: (obj) => ws.send(JSON.stringify(obj)),
      close: (code, reason) => ws.close(code, reason),
      get bufferedAmount() { return ws.bufferedAmount; },
    };
    ownedWsTransports.add(t);
    actualClosed.then(() => ownedWsTransports.delete(t));
    return t;
  }

  /** Transport with known connId (resume): attaches heartbeat and events */
  function watch(connId, t, legacy) {
    t.principal = router.describeConn(connId)?.principal;
    watchPending({ connId }, t, legacy);
  }

  /**
   * Attaches transport events: passes messages to session layer; passes close to session layer
   * (legacy clients end accordingly, session-aware ones only detach); underlying drain for legacy
   * clients lets core continue writing backlogged messages (H.2), while for session-aware ones
   * backlog is calculated from acknowledgments, with session layer notifying core.
   * `holder.connId` can be filled in after attaching listeners (creating session must send welcome
   * first).
   */
  function watchPending(holder, t, legacy) {
    const { ws } = t;
    t.legacy = legacy;
    wsTransports.add(t);
    ws.on('pong', () => { t.alive = true; });
    if (legacy) ws.on('drain', () => { if (holder.connId) router.drained(holder.connId); });
    ws.on('message', (text) => {
      t.alive = true;
      if (!holder.connId) return;
      const principal = router.describeConn(holder.connId)?.principal;
      if (!needsInvocation(principal)) { sessions.receive(holder.connId, text); return; }
      t.invocationTail = t.invocationTail.then(() => {
        if (!sessions.isCurrent(holder.connId, t)) return;
        return dispatchInvocation({ connId: holder.connId, principal, text, kind: 'message',
          transport: { kind: 'ws', req: t.req, socket: t.socket, internal: additionalSockets.has(t.socket) } },
          frame => { if (sessions.isCurrent(holder.connId, t)) return sessions.receive(holder.connId, frame); });
      }).catch(error => {
          log('conn.error', { connId: holder.connId, code: error?.code ?? 'instance-invocation-forbidden' });
          ws.closeNow(4003, 'instance-invocation-forbidden');
        });
    });
    ws.on('close', ({ code, reason }) => {
      wsTransports.delete(t);
      if (holder.connId) sessions.transportClosed(holder.connId, t, { code, reason, why: t.deadWhy });
    });
    Object.defineProperty(t, 'connId', { get: () => holder.connId, configurable: true });
  }

  function health() {
    const core = router.health();
    const out = {
      ok: true,
      service: 'promptcut-docservice',
      uptimeMs: now() - startedAt,
      connections: core.connections,
      protocol,
      modules: core.modules,
      // Assembly layer fields (not core fields): which transport each session uses, whether detached,
      // whether legacy client, and cumulative counts (contract section 8)
      sessions: sessions.stats(),
    };
    for (const [k, v] of Object.entries(core)) {
      if (!Object.hasOwn(out, k)) out[k] = v;
    }
    if (typeof options.healthExtra === 'function') Object.assign(out, options.healthExtra());
    return out;
  }

  /**
   * Heartbeat: a ping round every 30 s, closes this transport if previous round did not receive pong.
   * Legacy clients disconnect accordingly (logs `conn.timeout`), while session-aware ones only detach
   * (section 5). Also clears expired tombstones.
   */
  const heartbeat = setInterval(() => {
    for (const t of [...wsTransports]) {
      if (!t.alive) {
        if (t.legacy && t.connId) log('conn.timeout', { connId: t.connId, transport: 'ws' });
        t.deadWhy = 'heartbeat';
        t.ws.terminate();
        continue;
      }
      t.alive = false;
      t.ws.ping();
    }
    sessions.sweep();
    httpTransport?.sweep();
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    setAuthority(auth) { currentAuthority = auth; },
    get authority() { return currentAuthority; },
    /** Standalone mode is a self-created server; attached mode is the host server (this service does not listen on it or close it) */
    server: attached ? hostServer : ownServer,

    /** Whether attached mode */
    attached,

    /**
     * Starts listening, returns actual address (allocated by system when port is 0).
     * Throws synchronously in attached mode: host is responsible for listening.
     */
    listen(port, host) {
      if (attached) throw new Error('In attached mode the host server does the listening, so the document service cannot call listen()');
      return new Promise((resolve, reject) => {
        ownServer.once('error', reject);
        ownServer.listen(port, host, () => {
          ownServer.off('error', reject);
          resolve(ownServer.address());
        });
      });
    },

    /** Same object as `/healthz`; in attached mode host uses it to mount routes itself */
    health,

    /**
     * Sends messages over connection from outside modules (such as `send` in createRenderQueue).
     * Discarded if connection is already closed. Also goes through core outbound queue and
     * backpressure; when a real queue is attached, includes merge key provided by queue module (H.3).
     */
    send(connId, message) {
      sendFromOutside(connId, message);
    },

    /** Only the trusted assembly attaches the same service to its mTLS server.
     * HTTP routing remains explicit; no hosting/admin HTTP handler is forwarded. */
    attachTransportServer(server) {
      if (additionalServers.has(server)) return additionalServers.get(server).detach;
      if (!server || typeof server.on !== 'function') throw new TypeError('TLS transport server required');
      const secure = socket => { additionalSockets.add(socket); socket.once('close', () => additionalSockets.delete(socket)); };
      const upgrade = (req, socket, head) => {
        onUpgrade(req, socket, head, true).catch(() => { if (!socket.destroyed) rejectUpgrade(socket, 503, 'Service Unavailable'); })
          .finally(() => completeAdmission(req));
      };
      const detach = () => { server.off('secureConnection', secure); server.off('upgrade', upgrade); additionalServers.delete(server); };
      server.on('secureConnection', secure); server.on('upgrade', upgrade);
      additionalServers.set(server, { detach }); return detach;
    },
    handleTransportHttp(req, res) {
      const url = new URL(req.url ?? '/', 'https://internal.invalid');
      if (req.method === 'POST' && url.pathname === '/internal/v2/revocations') {
        return handleRevocationHttp(req, res);
      }
      if (!additionalSockets.has(req.socket)) return false;
      return httpTransport?.handle(req, res) === true;
    },

    /** Attaches a module (contract G.3), returns unmount function. Throws and does not attach if types or fields conflict with attached modules */
    mount,

    /** Synchronously calls tick for one module (by name) or all modules; tests use it to drive clock when `autoTick: false` */
    tick(name) {
      router.tick(name);
    },

    /**
     * Attaches render queue. `queueInterface` must have contract A.3 `connect` / `disconnect` /
     * `handle` / `tick`, and `send` from construction must already be connected to `send` of this
     * service. Existing connections will immediately `connect` according to their respective principal.
     * Returns unmount function: on unmount, calls `disconnect` on all connections, clears recorded
     * roles, and queue messages revert to returning `queue-unavailable`.
     */
    mountRenderQueue(queueInterface) {
      if (queueSlot.kind === 'real') throw new Error('The render queue is already attached');
      // When passing factory function (space → queue), starts one instance per space (auth-contract
      // section 6); when passing queue object, it is a single instance (legacy entry point)
      const spaced = typeof queueInterface === 'function';
      const mod = spaced
        ? spacedModule({
          create: (space) => renderQueueModule(queueInterface(space), { sweepMs }),
          health: (list) => ({
            queue: true,
            publishers: list.reduce((n, [, h]) => n + (h.publishers ?? 0), 0),
            nodes: list.reduce((n, [, h]) => n + (h.nodes ?? 0), 0),
            epoch: list[0]?.[1]?.epoch ?? null,
          }),
        })
        : renderQueueModule(queueInterface, { sweepMs });
      queueSlot.unmount();
      let unmountReal;
      try {
        unmountReal = mount(mod);
      } catch (err) {
        queueSlot = { kind: 'placeholder', unmount: mount(renderQueuePlaceholder()) };
        throw err;
      }
      const slot = { kind: 'real', unmount: unmountReal };
      queueSlot = slot;
      log('queue.mount', { epoch: spaced ? (mod.health().epoch ?? null) : (queueInterface.epoch ?? null), spaced });
      return () => {
        if (queueSlot !== slot) return;
        unmountReal();
        queueSlot = { kind: 'placeholder', unmount: mount(renderQueuePlaceholder()) };
        log('queue.unmount', {});
      };
    },

    /** Actively closes a connection (for callers outside assembly layer and modules): session ends immediately and is not retained; returns false if connection does not exist */
    closeConn(connId, code, reason) {
      return sessions.close(connId, code, reason);
    },
    /** Dedicated security barrier. Ordinary close's tail replay is unchanged. */
    fenceConn(connId, code = 4003, reason = 'access-revoked') {
      if (connectionFences.has(connId)) return connectionFences.get(connId);
      const logical = sessions.fence(connId, code, reason);
      const transports = [...ownedWsTransports].filter(t => t.connId === connId);
      const httpClosed = httpTransport?.fenceConn(connId, code, reason) ?? Promise.resolve({ closedHttp: 0 });
      for (const t of transports) t.ws.terminate();
      const result = Promise.all([logical.gone, httpClosed, ...transports.map(t => t.actualClosed)]).then(([, http]) => ({
        connectionId: connId, logicalFenced: true, discarded: true, actualClosed: true,
        closedWs: transports.length, closedHttp: http.closedHttp,
      }));
      connectionFences.set(connId, result); return result;
    },
    /** Trusted logout barrier includes every admission that was already awaiting
     * authentication, and prevents a matching identity from entering afterwards. */
    async fencePrincipals(criteria, code = 4003, reason = 'access-revoked') {
      const selectors = ['accountIds', 'loginIds', 'runGrantIds', 'serviceKids'];
      if (!criteria || (!criteria.projectId && !selectors.some(field => Array.isArray(criteria[field]) && criteria[field].length)) ||
          criteria.projectId !== undefined && (typeof criteria.projectId !== 'string' || !criteria.projectId) ||
          [...selectors, 'roles'].some(field => criteria[field] !== undefined &&
            (!Array.isArray(criteria[field]) || !criteria[field].length || criteria[field].some(value => typeof value !== 'string' || !value))))
        throw new TypeError('precise fence identity is required');
      const scope = structuredClone(criteria);
      // Only immutable revoked references remain permanent. Account/project and
      // switch predicates fence this cohort, not future legitimate joins/runs.
      const fence = { criteria: scope, rows: new Set(), pending: true,
        permanent: ['loginIds', 'runGrantIds', 'serviceKids'].some(field => scope[field]?.length) };
      admissionFences.push(fence);
      for (const row of admissions) includeAdmission(fence, row);
      const ids = new Set(sessions.connIds().filter(id => matching(router.describeConn(id)?.principal, scope)));
      for (const t of ownedWsTransports) if (t.connId && matching(t.principal, scope)) ids.add(t.connId);
      for (const id of httpTransport?.connectionIdsMatching(p => matching(p, scope)) ?? []) ids.add(id);
      const fences = [...ids].map(id => this.fenceConn(id, code, reason));
      const connectionReceipts = await Promise.all(fences);
      const processed = new Set(); let rejectedAdmissions = 0;
      for (;;) {
        const pending = [...fence.rows].filter(row => !processed.has(row));
        if (!pending.length) break;
        // Unknown identity remains pending. Authentication completion is required
        // even if all logical sessions are already gone.
        await Promise.all(pending.map(row => row.done));
        const affected = pending.filter(row => matching(row.principal, scope));
        for (const row of affected) row.socket.destroy();
        await Promise.all(affected.map(row => row.actualClosed));
        rejectedAdmissions += affected.length;
        for (const row of pending) processed.add(row);
      }
      // No yield between finishing this cohort and retiring its predicate. Each
      // concurrent fence owns a separate record and cannot remove another's.
      fence.pending = false; fence.rows.clear();
      if (!fence.permanent) admissionFences.splice(admissionFences.indexOf(fence), 1);
      return { actualClosed: true, connections: connectionReceipts,
        pendingAdmissions: processed.size, rejectedAdmissions };
    },
    closeSpace(space, code = 1012, reason = 'relocating') { sessions.closeSpace(space, code, reason); },

    /**
     * Drops instances of a space across modules (when deleting shared projects, `auth-contract.md`
     * section 7). Only calls attached modules that have `dropSpace` (shells in `spaces.mjs`);
     * connections of the space should already be closed. Storage directory is deleted by caller.
     */
    dropSpace(space) {
      for (const { mod } of mounted.values()) {
        if (typeof mod.dropSpace !== 'function') continue;
        try {
          mod.dropSpace(space);
        } catch (err) {
          log('module.error', { module: mod.name, hook: 'dropSpace', message: String(err?.message ?? err) });
        }
      }
    },

    /** Immediately releases all claims held by this connection (tasks return to unclaimed); returns 0 if queue is not attached or unsupported */
    releaseClaims(connId, reason) {
      const mod = mounted.get(RENDER_QUEUE_MODULE)?.mod;
      return typeof mod?.releaseClaims === 'function' ? mod.releaseClaims(connId, reason) : 0;
    },

    /** Number of claims held by this connection at this moment ("Rendering" tag in members list); returns 0 if queue is not attached or unsupported */
    claimsOf(connId) {
      const mod = mounted.get(RENDER_QUEUE_MODULE)?.mod;
      return typeof mod?.claimsOf === 'function' ? mod.claimsOf(connId) : 0;
    },

    /**
     * Diagnostics: identity, outbound backlog, subscriptions, and fields provided by each module for
     * each connection, channel subscription count, and describe of each module.
     * In `/healthz`, `channels` is number of channels with subscribers; here it is "channel → subscriber
     * count" (shapes differ in both places, just like `modules`).
     */
    describe() {
      return {
        ...health(),
        channels: router.channels(),
        // Core fields plus assembly layer session fields (`transport`, `fallback`, `detached`, `resumes`,
        // contract section 8); detached sessions are also included
        conns: sessions.connIds().map((id) => {
          const d = router.describeConn(id);
          return d ? { ...d, ...sessions.describeConn(id) } : null;
        }).filter(Boolean),
        modules: Object.fromEntries(router.modules().map((name) => {
          const mod = mounted.get(name)?.mod;
          return [name, mod?.describe?.() ?? null];
        })),
      };
    },

    /**
     * Sends 1001 to all connections and closes them, stopping heartbeat and module timers.
     * Standalone mode: stops listening, waits for server to close.
     * Attached mode: removes its own `upgrade` listener, waits for its connections to disconnect
     * (if peer does not return close frames, `ws.mjs` disconnects directly on timeout); host server is
     * not closed.
     */
    close() {
      closing = true;
      for (const { detach } of [...additionalServers.values()]) detach();
      httpTransport?.shutdown();
      clearInterval(heartbeat);
      for (const record of mounted.values()) clearInterval(record.timer);
      // Sessions all end with 1001 (detached ones end as well, not retained); closes transport for
      // legacy clients, waiting for close event to deregister
      const gone = sessions.closeAll(CLOSE.GOING_AWAY, 'server shutting down');
      const actualWsGone = Promise.all([...ownedWsTransports].map(t => t.actualClosed));
      if (attached) {
        hostServer.off('upgrade', upgradeListener);
        return Promise.all([gone, actualWsGone]).then(() => {});
      }
      const done = new Promise((resolve) => ownServer.close(() => resolve()));
      ownServer.closeIdleConnections();
      return Promise.all([done, gone, actualWsGone]).then(() => {});
    },
  };
}
