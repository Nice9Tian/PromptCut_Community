/**
 * How card source sync connects to the document service in account cloud projects
 * (`server/card-sync.mjs` rules remain unchanged, only endpoints are swapped).
 *
 * The document service for account projects only recognizes account-based connection tickets
 * (`cloud/docservice/account-hosted.mjs`: subprotocol `promptcut.account.<ticket>`; legacy
 * `auth.ticket` is rejected on such connections). The page fetches the ticket from
 * `/hosted/shared/account/session` using its own login; the role is still page, and permissions
 * match this member's current permissions; the editor process itself holds no login and claims
 * no identity.
 *
 * The two differences from legacy shared projects are both in this endpoint:
 *
 * 1. **Resume does not carry a ticket**. The document service requires that a resume item cannot
 *    accompany an auth item (`parseSessionItem` in `server/docservice/session.mjs`; carrying one
 *    returns 400 on handshake); on resume, the server re-verifies login and membership based on the
 *    identity recorded in the session (`resumeGate`). Therefore, tickets are only presented when
 *    creating a new session.
 *
 * 2. **Connections have a lifetime; replace with a new one before expiry**. Every message on an
 *    account connection must pass a gate, which queries the account service using the access token
 *    backing the ticket presented at connection setup; after the access token expires (measured at
 *    120 seconds; the ticket's `expiresAt` is that exact moment), the connection remains open, but
 *    every message returns `credential-revoked` (or later `authorization-expired`), and renewing
 *    the token cannot save this connection. Therefore: after establishing a session, schedule a
 *    timer based on the ticket's `expiresAt`, end this session `renewMarginMs` early, and establish
 *    the next one with a new ticket; if missed (clock skew, timer delayed), switch immediately upon
 *    receiving an `error` with either of these two reasons. To the sync rules, that switch is a
 *    disconnect and reconnect: in-flight requests fail as disconnected and stay in pending uploads;
 *    once the new session is established, resubscribe and reconcile; others' versions during the
 *    gap are caught up via reconciliation. When permissions are genuinely revoked (logged out,
 *    kicked, project deleted), a new ticket cannot be obtained; the session layer retries with
 *    backoff, and the page side unbinds once it discovers a terminal reason.
 */
import { createDocEndpoint } from './render-node/session-link.mjs';
import { PRODUCT } from './auth/product.mjs';

export const ACCOUNT_PROTOCOL_PREFIX = 'promptcut.account.';
const TICKET = /^[A-Za-z0-9_-]{43}$/;
/** Gate returns these two reasons: access token backing this connection expired (or login was revoked); connection can no longer be used */
const DEAD_REASONS = new Set(['credential-revoked', 'authorization-expired']);

export const ACCOUNT_CARD_LINK_DEFAULTS = Object.freeze({
  /**
   * How long before ticket expiry to switch to the next session. Must be smaller than the page's
   * lead time for renewing access tokens (`ensureLogin` in `src/account/client.ts`: renews with less
   * than 10 seconds remaining), so that when requesting a ticket, the page is guaranteed to have
   * renewed the token, yielding a full-lifetime ticket; if larger, it would receive a ticket with only
   * a dozen seconds left, triggering several rapid switches in a row.
   */
  renewMarginMs: 8_000,
  /** Minimum duration a session is used before switching (avoids switching immediately after creation when only a few seconds remain; missed cases are caught by `error`) */
  minSessionMs: 3_000,
  /** Duration assumed for tickets without an expiry time (account access token lifetime is 120 seconds; take half) */
  fallbackLifeMs: 60_000,
});

/** Ticket returned by the page: `{ ticket, expiresAt? }` or just the ticket string */
function normalizeTicket(value) {
  const ticket = typeof value === 'string' ? value : value?.ticket;
  if (typeof ticket !== 'string' || !TICKET.test(ticket)) throw new Error('Invalid account connection ticket');
  const expiresAt = typeof value === 'object' && Number.isSafeInteger(value?.expiresAt) ? value.expiresAt : null;
  return { ticket, expiresAt };
}

/**
 * Endpoint used for account projects in `createCardSync({ connect })`. Same shape as
 * `createDocEndpoint` (send, onMessage, onOpen, onResume, onClose, close, stats).
 *
 * @param {object} o
 * @param {string} o.url ws(s):// address of the document service
 * @param {() => Promise<string | { ticket: string, expiresAt?: number }>} o.getTicket Fetches an
 *   account-based connection ticket on demand; throws if unable to obtain
 * @param {(event: string, fields?: object) => void} [o.log]
 * @param {(o: object) => object} [o.createEndpoint] Defaults to `createDocEndpoint` (replaced with
 *   test double in tests)
 * @param {Function} [o.WebSocket] Only for tests to swap implementation (with root CA)
 */
export function accountCardEndpoint({
  url,
  getTicket,
  log = () => {},
  createEndpoint = createDocEndpoint,
  WebSocket = undefined,
  now = Date.now,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  renewMarginMs = ACCOUNT_CARD_LINK_DEFAULTS.renewMarginMs,
  minSessionMs = ACCOUNT_CARD_LINK_DEFAULTS.minSessionMs,
  fallbackLifeMs = ACCOUNT_CARD_LINK_DEFAULTS.fallbackLifeMs,
} = {}) {
  if (typeof getTicket !== 'function') throw new TypeError('accountCardEndpoint: getTicket must be a function');
  const handlers = { message: [], open: [], resume: [], close: [] };
  const emit = (kind, arg) => { for (const h of [...handlers[kind]]) { try { h(arg); } catch { /* Errors in upper-layer handling do not affect the connection */ } } };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failures do not affect the connection */ } };
  let closed = false;
  /** Current session endpoint `{ ep, expiresAt, timer, renewing }`; replaced entirely when switching */
  let cur = null;
  let renews = 0;

  function start() {
    const rec = { ep: null, expiresAt: null, timer: null, renewing: false };
    cur = rec;
    const protocols = async () => {
      const t = normalizeTicket(await getTicket());
      rec.expiresAt = t.expiresAt;
      return ['promptcut.v1', `${ACCOUNT_PROTOCOL_PREFIX}${t.ticket}`];
    };
    const ep = createEndpoint({ url, protocols, log, ...(WebSocket ? { WebSocket } : {}) });
    rec.ep = ep;
    ep.onOpen(() => {
      if (cur !== rec || closed) return;
      const life = rec.expiresAt === null ? fallbackLifeMs : rec.expiresAt - now() - renewMarginMs;
      const delay = Math.max(minSessionMs, life);
      if (rec.timer !== null) clearTimer(rec.timer);
      rec.timer = setTimer(() => { rec.timer = null; renew(rec, 'ticket-expiring'); }, delay);
      rec.timer?.unref?.();
      say('account.session', { renewInMs: Math.round(delay), renews });
      emit('open');
    });
    ep.onResume?.(() => { if (cur === rec && !closed) emit('resume'); });
    ep.onClose((info) => {
      if (cur !== rec) return;
      // Session ended (closed by server, retention period expired): endpoint retries with backoff to create a new session, refetching ticket and rescheduling then
      if (rec.timer !== null) { clearTimer(rec.timer); rec.timer = null; }
      emit('close', info);
    });
    ep.onMessage((msg) => {
      if (cur !== rec || closed) return;
      emit('message', msg);
      if (msg?.type === 'error' && DEAD_REASONS.has(msg.reason)) renew(rec, msg.reason);
    });
  }

  /** End this session and create the next one with a new ticket */
  function renew(rec, why) {
    if (closed || cur !== rec || rec.renewing) return;
    rec.renewing = true;
    renews += 1;
    say('account.renew', { why, renews });
    if (rec.timer !== null) { clearTimer(rec.timer); rec.timer = null; }
    // Close first (still the current endpoint; closure is reported to upper layer as usual: in-flight requests are treated as disconnected), then start a new one
    try { rec.ep.close(); } catch { /* Already closed */ }
    if (closed || cur !== rec) return;
    start();
  }

  start();

  return {
    send: (message) => (closed || !cur ? false : cur.ep.send(message)),
    onMessage(h) { handlers.message.push(h); },
    onOpen(h) { handlers.open.push(h); },
    onResume(h) { handlers.resume.push(h); },
    onClose(h) { handlers.close.push(h); },
    close() {
      if (closed) return;
      closed = true;
      const rec = cur;
      if (rec?.timer != null) { clearTimer(rec.timer); rec.timer = null; }
      try { rec?.ep.close(); } catch { /* Already closed */ }
    },
    /** Disconnect current transport only (for testing) */
    dropTransport: () => cur?.ep.dropTransport?.() ?? false,
    stats() {
      let inner = null;
      try { inner = cur?.ep.stats?.() ?? null; } catch { inner = null; }
      return inner ? { ...inner, accountRenews: renews } : null;
    },
  };
}

/**
 * The entry in `createCardSync().bind({ protocols })` indicating "this is an account project":
 * `cardSyncConnect` recognizes it and switches to `accountCardEndpoint`. Can also be called directly
 * as a subprotocol function (only presents the ticket, ignoring lifetime) to prevent errors when
 * other endpoints receive it.
 */
export function accountCardProtocols(getTicket) {
  if (typeof getTicket !== 'function') throw new TypeError('accountCardProtocols: getTicket must be a function');
  const list = async () => ['promptcut.v1', `${ACCOUNT_PROTOCOL_PREFIX}${normalizeTicket(await getTicket()).ticket}`];
  return Object.assign(list, { accountTicket: getTicket });
}

/**
 * `createCardSync({ connect })`: account projects (subprotocols provided by `accountCardProtocols`)
 * use `accountCardEndpoint`; the rest is identical to the default
 * (`createDocEndpoint({ url, protocols, log })`, prefixing log events with `doc.`).
 */
export function cardSyncConnect(say = () => {}, { WebSocket = undefined } = {}) {
  const log = (event, fields) => say(`doc.${event}`, fields);
  return ({ url, protocols }) => (typeof protocols?.accountTicket === 'function'
    ? accountCardEndpoint({ url, getTicket: protocols.accountTicket, log, ...(WebSocket ? { WebSocket } : {}) })
    : createDocEndpoint({ url, protocols, log, ...(WebSocket ? { WebSocket } : {}) }));
}

/** Document service address for account cloud projects: only this one in production, written into product manifests (absent in the public edition); the desktop shell's account bridge also only recognizes it (`account_cloud_binding` in `desktop/src-tauri/src/lib.rs`) */
export const ACCOUNT_CLOUD_ORIGIN = PRODUCT.accountCloudOrigin;

/**
 * The address the editor process connects to using account tickets can only be the account cloud
 * document service (`wss://<cloud-host>/hosted/`). Tickets are credentials for the member's own
 * permissions; the address in a binding request cannot arbitrarily point anywhere: otherwise,
 * anyone who can call the binding endpoint could make the editor process send the ticket to their
 * specified server. `PROMPTCUT_ACCOUNT_CLOUD_ORIGIN` (comma-separated https origins) is only for local
 * integration testing and probes to swap in a test account service; if unset, only production is
 * recognized.
 */
export function accountDocUrlAllowed(url, env = process.env) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'wss:' || u.username || u.password || u.search || u.hash || u.pathname !== '/hosted/') return false;
  const allowed = [ACCOUNT_CLOUD_ORIGIN, ...String(env?.PROMPTCUT_ACCOUNT_CLOUD_ORIGIN ?? '').split(',').map((s) => s.trim())].filter(Boolean);
  return allowed.some((origin) => { try { const o = new URL(origin); return o.protocol === 'https:' && o.host === u.host; } catch { return false; } });
}
