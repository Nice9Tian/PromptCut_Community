/**
 * Host-service-side client: connects to the document service's **control connection** with the
 * service private key to inspect catalog, verify delegations, and exchange tickets (contracts
 * `docs/plan/hosted-render-contract.md` Sections 1.2 and 1.3, `docs/plan/cloud-agent-contract.md`
 * Sections 4.3 and 16; written into `docs/plan/auth-contract.md` Section 17). Used by Cloud Agent
 * service; other host services (with different service names) can also use it.
 *
 * ```js
 * const client = createServiceClient({ base: 'ws://127.0.0.1:8787', key: readServiceKeyFile(dir), log });
 * await client.ready();                                   // Control connection established (auto-reconnects on disconnect)
 * client.watch({ onProjects, onProject });                // Catalog: full manifest and every subsequent change (auto-resubscribes on reconnect)
 * const who = await client.verifyDelegation(delegationTicket); // { ok: true, projectId, userId, username, acc, ownerKey, … } | { ok: false, reason }
 * const t = await client.memberTicket({ projectId, conversation, conversationId, delegation: chatDelegation });
 * const protocols = client.dataProtocols(t.ticket);       // Passed to data connection (`promptcut.ticket.<ticket>`)
 * const p = await client.publishTicket(projectId);        // Connection ticket only used to publish prerender retry plans
 * await client.demand(projectId, holdMs);                 // Declares "this project has work for other host services to do"
 * client.close();
 * ```
 *
 * - Control connections only accept local origination (judged on the document service side), so
 *   `base` is a loopback address on the same machine.
 * - Each connection fetches a challenge and signs once (`nonce` can only be used once); if the
 *   connection drops, reconnect with backoff according to `reconnectMs`. Requests during
 *   disconnection immediately return `{ ok: false, reason: 'unavailable' }` without queuing:
 *   callers (Agent service) will not accept new chats based on this.
 * - Requests are paired by `reqId`; timeouts return `{ ok: false, reason: 'timeout' }`. Any
 *   `error { reason }` in the response is returned as-is without throwing.
 * - Raw private keys, signatures, `nonce`, delegations, and tickets do not enter logs: logs only
 *   contain event name, service name, reason code, and project id.
 *
 * Uses only Node built-in capabilities (global `WebSocket`, `fetch`), injectable.
 */
import { PROTOCOL, TICKET_PREFIX } from './protocol.mjs';
import { buildServiceProtocols, readServiceKeyFile } from './service-identity.mjs';
import { tr } from '../i18n.mjs';

export const SERVICE_CLIENT_DEFAULTS = Object.freeze({
  requestTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
  reconnectMs: [200, 500, 1000, 2000, 5000],
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `http(s)://…` → `ws(s)://…`; leaves existing ws as-is */
function wsUrlOf(base) {
  const u = new URL(base);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  return u.toString();
}

/** Subprotocol used for data connection handshake */
export const ticketProtocols = (ticket) => [PROTOCOL, TICKET_PREFIX + ticket];

/**
 * @param {object} options
 * @param {string} options.base Document service address (`ws://127.0.0.1:8787` or `http://…`)
 * @param {{ service, kid, priv, instanceId, instanceName }} [options.key] Result of `readServiceKeyFile`
 * @param {string} [options.keyFile] Private key file or its directory (read when `key` is not provided)
 * @param {typeof globalThis.WebSocket} [options.WebSocketImpl]
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.connectTimeoutMs]
 * @param {number[]} [options.reconnectMs] Progressively increased, capped at the last value
 * @param {boolean} [options.autoReconnect] Defaults to true
 */
export function createServiceClient({
  base,
  key: givenKey,
  keyFile,
  WebSocketImpl = globalThis.WebSocket,
  fetch: fetchImpl = globalThis.fetch,
  log = () => {},
  requestTimeoutMs = SERVICE_CLIENT_DEFAULTS.requestTimeoutMs,
  connectTimeoutMs = SERVICE_CLIENT_DEFAULTS.connectTimeoutMs,
  reconnectMs = SERVICE_CLIENT_DEFAULTS.reconnectMs,
  autoReconnect = true,
} = {}) {
  if (typeof base !== 'string' || base === '') throw new TypeError('createServiceClient: base must be a non-empty string');
  if (typeof WebSocketImpl !== 'function') throw new TypeError('createServiceClient: no WebSocket implementation available');
  const key = givenKey ?? readServiceKeyFile(keyFile);
  const url = wsUrlOf(base);
  const say = (event, fields = {}) => {
    try { log(event, { service: key.service, ...fields }); } catch { /* Logging should not affect the connection */ }
  };

  let ws = null;
  let open = false;
  let closed = false;
  let attempt = 0;
  let connecting = null;
  let retryTimer = null;
  let seq = 0;
  /** reqId → { resolve, timer } */
  const waiting = new Map();
  /** Callback for catalog subscription; automatically resubscribes after reconnect */
  let watcher = null;
  const stateListeners = new Set();

  const emitState = (state, info = {}) => {
    for (const fn of [...stateListeners]) {
      try { fn(state, info); } catch { /* Listener errors should not affect the connection */ }
    }
  };

  function failAll(reason) {
    for (const [reqId, w] of [...waiting]) {
      waiting.delete(reqId);
      clearTimeout(w.timer);
      w.resolve({ ok: false, reason });
    }
  }

  function onMessage(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!isObj(m)) return;
    if (m.reqId !== undefined && waiting.has(m.reqId)) {
      const w = waiting.get(m.reqId);
      waiting.delete(m.reqId);
      clearTimeout(w.timer);
      if (m.type === 'error') w.resolve({ ok: false, reason: typeof m.reason === 'string' ? m.reason : 'error' });
      else w.resolve({ ok: true, message: m });
      return;
    }
    if (m.type === 'hosted.project' && watcher?.onProject) {
      const { type: _t, ...item } = m;
      try { watcher.onProject(item); } catch (err) { say('service-client.watcher-error', { message: String(err?.message ?? err) }); }
    }
  }

  function scheduleReconnect() {
    if (closed || !autoReconnect || retryTimer) return;
    const wait = reconnectMs[Math.min(attempt, reconnectMs.length - 1)] ?? 1000;
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect().catch(() => {});
    }, wait);
    retryTimer.unref?.();
  }

  /** Establishes a control connection; returns immediately if already connected. Throws on failure (and schedules next attempt with backoff) */
  function connect() {
    if (closed) return Promise.reject(Object.assign(new Error('The service client is closed'), { code: 'closed' }));
    if (open) return Promise.resolve();
    connecting ??= (async () => {
      try {
        const protocols = await buildServiceProtocols({ base, key, fetch: fetchImpl });
        if (closed) throw Object.assign(new Error('The service client is closed'), { code: 'closed' });
        await new Promise((resolve, reject) => {
          const sock = new WebSocketImpl(url, protocols);
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { sock.close(); } catch { /* Not connected yet */ }
            reject(Object.assign(new Error(tr("Control connection timed out")), { code: 'timeout' }));
          }, connectTimeoutMs);
          timer.unref?.();
          sock.addEventListener('open', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ws = sock;
            open = true;
            attempt = 0;
            resolve();
          });
          sock.addEventListener('message', (ev) => { if (typeof ev.data === 'string') onMessage(ev.data); });
          sock.addEventListener('error', () => { /* Followed immediately by close */ });
          sock.addEventListener('close', (ev) => {
            const wasOpen = ws === sock && open;
            if (ws === sock) {
              ws = null;
              open = false;
            }
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(Object.assign(new Error(tr("Control connection failed ({0})", ev.code ?? 0)), { code: 'refused', closeCode: ev.code ?? null }));
              return;
            }
            if (wasOpen) {
              failAll('unavailable');
              say('service-client.down', { code: ev.code ?? null, reason: String(ev.reason ?? '') });
              emitState('down', { code: ev.code ?? null, reason: String(ev.reason ?? '') });
              scheduleReconnect();
            }
          });
        });
        say('service-client.up', {});
        emitState('up', {});
        if (watcher) void rewatch();
      } catch (err) {
        say('service-client.connect-failed', { reason: String(err?.code ?? 'error') });
        scheduleReconnect();
        throw err;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  /** Sends a request, returns `{ ok: true, message }` or `{ ok: false, reason }`; does not throw */
  function request(message) {
    if (closed) return Promise.resolve({ ok: false, reason: 'closed' });
    if (!open || !ws) return Promise.resolve({ ok: false, reason: 'unavailable' });
    const reqId = `sc-${(seq += 1)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(reqId);
        resolve({ ok: false, reason: 'timeout' });
      }, requestTimeoutMs);
      timer.unref?.();
      waiting.set(reqId, { resolve, timer });
      try {
        ws.send(JSON.stringify({ ...message, reqId }));
      } catch {
        waiting.delete(reqId);
        clearTimeout(timer);
        resolve({ ok: false, reason: 'unavailable' });
      }
    });
  }

  const strip = (r, type) => {
    if (!r.ok) return r;
    if (r.message.type !== type) return { ok: false, reason: 'bad-reply' };
    const { type: _t, reqId: _r, ...rest } = r.message;
    return { ok: true, ...rest };
  };

  async function rewatch() {
    const r = strip(await request({ type: 'hosted.watch' }), 'hosted.projects');
    if (!r.ok) {
      say('service-client.watch-failed', { reason: r.reason });
      return r;
    }
    try { watcher?.onProjects?.(Array.isArray(r.projects) ? r.projects : []); } catch (err) { say('service-client.watcher-error', { message: String(err?.message ?? err) }); }
    return r;
  }

  const api = {
    /** Which service this client represents */
    service: key.service,
    instanceId: key.instanceId,
    get connected() { return open; },

    /** Waits for control connection to connect (initiates one if not connecting); throws if unable to connect */
    ready: connect,

    /** Connection state change: `fn('up' | 'down', { code?, reason? })`; returns unsubscribe function */
    onState(fn) {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },

    /**
     * Subscribes to catalog. `onProjects(fullManifest)` is called once upon successful subscription
     * and after each reconnect, and `onProject(entry)` is called on every subsequent change
     * (entry `{ projectId, enabled, active, members, hosted }` or `{ projectId, removed: true }`;
     * `enabled` is this service's own toggle).
     * @returns {Promise<{ ok: true, projects: object[] } | { ok: false, reason: string }>}
     */
    watch({ onProjects, onProject } = {}) {
      watcher = { onProjects, onProject };
      return rewatch();
    },

    /**
     * Verifies a delegation ticket or chat delegation (does not sign anything).
     * @returns {Promise<{ ok: true, projectId, userId, username, deviceId, deviceName, creator, mode,
     *   acc, exp, ownerKey, grant, conversationId? } | { ok: false, reason }>}
     */
    async verifyDelegation(delegation) {
      return strip(await request({ type: 'hosted.delegate.verify', delegation }), 'hosted.delegate.ok');
    },

    /**
     * Exchanges a chat delegation for a connection ticket representing that member (2 minutes, used only
     * during handshake).
     * @param {{ projectId: string, conversation: number, conversationId: string, delegation: string }} fields
     * @returns {Promise<{ ok: true, ticket, exp, userId, username, access, ownerKey, conversation,
     *   conversationId } | { ok: false, reason }>}
     */
    async memberTicket({ projectId, conversation, conversationId, delegation }) {
      return strip(await request({ type: 'hosted.ticket', projectId, conversation, conversationId, delegation }), 'hosted.ticket.ok');
    },

    /** Connection ticket only used to publish prerender retry plans (service's own identity, without any member permissions) */
    async publishTicket(projectId) {
      return strip(await request({ type: 'hosted.ticket', projectId, purpose: 'publish' }), 'hosted.ticket.ok');
    },

    /** Ticket to enter project under service's own identity (only obtainable by services with `actsFor: 'self'`, such as render service) */
    async serviceTicket(projectId) {
      return strip(await request({ type: 'hosted.ticket', projectId }), 'hosted.ticket.ok');
    },

    /** Declares "this project has work for other host services to do"; `holdMs: 0` revokes */
    async demand(projectId, holdMs) {
      return strip(await request({ type: 'hosted.demand', projectId, ...(holdMs === undefined ? {} : { holdMs }) }), 'hosted.demand.ok');
    },

    /** Subprotocols used for data connection handshake: `[promptcut.v1, promptcut.ticket.<ticket>]` */
    dataProtocols: ticketProtocols,

    /**
     * For `createAgentLink({ protocolsFor })` in `server/agent/doc-link.mjs`: exchanges ticket on the
     * fly by chat number and constructs subprotocols. Each invocation (initial connection, session
     * resume, disconnect reconnect) exchanges anew with the held chat delegation, so page presence is
     * not required; throws if exchange fails, where `code` is the reason given by the document
     * service (`expired`, `generation`, `service-disabled`, `banned`, `not-listed`, `unavailable`...).
     * @param {{ projectId: string, conversationId: string, delegation: string | (() => string) }} fields
     * @returns {(conversation: number) => Promise<string[]>}
     */
    protocolsForConversation({ projectId, conversationId, delegation }) {
      return async (conversation) => {
        const grant = typeof delegation === 'function' ? delegation() : delegation;
        const r = await api.memberTicket({ projectId, conversation, conversationId, delegation: grant });
        if (!r.ok) throw Object.assign(new Error(tr("Could not exchange for a connection ticket ({0})", r.reason)), { code: r.reason });
        return ticketProtocols(r.ticket);
      };
    },

    /** Closes the control connection and stops reconnecting */
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      failAll('closed');
      const sock = ws;
      ws = null;
      open = false;
      try { sock?.close(1000, 'client-close'); } catch { /* Already disconnected */ }
    },
  };
  return api;
}
