import { tr } from "../../i18n.mjs";
/**
 * Service address registration module (contract `docs/plan/render-queue-contract.md` G.6).
 *
 * The party hosting the asset service or similar announces its address (`service.announce`),
 * and render nodes or clients that need it subscribe (`service.watch`) to receive the full list
 * (`service.endpoints`); when the announcer withdraws (`service.withdraw`) or disconnects beyond
 * the grace period, the address is withdrawn accordingly (semantics
 * `docs/semantics/mechanism/document-service.md` "Connection Discovery").
 *
 * Exchanges addresses only: this module does not access registered URLs or forward any bytes.
 * Pushes are always full lists filtered by subscriber `kinds`; the list is small, so no deltas
 * are used.
 * Permissions (`docs/plan/auth-contract.md` Section 10): `service.announce` / `service.withdraw`
 * are only granted to admin identity and `local` identity; members (`scope: 'member'`) receive
 * `forbidden`; `service.watch` and delivered `service.endpoints` are open to all identities
 * (read-only).
 * Legacy identities without `scope` (test-injected `authenticate`) are unrestricted, same as M5.
 */

export const ENDPOINT_DEFAULTS = Object.freeze({
  GRACE_MS: 10_000,
  MAX_ANNOUNCERS: 64,
  MAX_URLS: 8,
  MAX_META_BYTES: 4096,
  TICK_MS: 1000,
});

export const ENDPOINTS_MODULE = 'endpoints';

const ANNOUNCER_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_URL_LENGTH = 2048;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

class BadMessage extends Error {}
function bad(detail) { throw new BadMessage(detail); }

function checkAnnouncer(v) {
  if (typeof v !== 'string' || !ANNOUNCER_RE.test(v)) bad('announcerId is invalid');
  return v;
}

function checkKind(v) {
  if (typeof v !== 'string' || !KIND_RE.test(v)) bad('kind is invalid');
  return v;
}

function checkUrls(v, maxUrls) {
  if (!Array.isArray(v) || v.length < 1 || v.length > maxUrls) bad(`urls must have 1-${maxUrls} entries`);
  return v.map((u) => {
    if (typeof u !== 'string' || u.length > MAX_URL_LENGTH) bad('The URL must be a string of at most 2048 characters');
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      bad('The URL cannot be parsed');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') bad('The URL must be http or https');
    if (parsed.username !== '' || parsed.password !== '') bad('The URL cannot contain a username or password');
    return u;
  });
}

function checkMeta(v, maxBytes) {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) bad('meta must be an object');
  let text;
  try {
    text = JSON.stringify(v);
  } catch {
    bad('meta cannot be serialized');
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) bad(`meta exceeds ${maxBytes} bytes when serialized`);
  return JSON.parse(text);
}

const sameUrls = (a, b) => a.length === b.length && a.every((u, i) => u === b[i]);
const sameMeta = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {object} [options] Overrides `ENDPOINT_DEFAULTS` limits (for testing)
 * @param {number} [options.graceMs]
 * @param {number} [options.maxAnnouncers]
 * @param {number} [options.maxUrls]
 * @param {number} [options.maxMetaBytes]
 * @param {number} [options.tickMs]
 */
export function endpointsModule(options = {}) {
  const {
    graceMs = ENDPOINT_DEFAULTS.GRACE_MS,
    maxAnnouncers = ENDPOINT_DEFAULTS.MAX_ANNOUNCERS,
    maxUrls = ENDPOINT_DEFAULTS.MAX_URLS,
    maxMetaBytes = ENDPOINT_DEFAULTS.MAX_META_BYTES,
    tickMs = ENDPOINT_DEFAULTS.TICK_MS,
  } = options;

  /** `${kind}\u0000${announcerId}` → { announcerId, kind, urls, meta, since, connId, offlineAt } */
  const entries = new Map();
  /** connId → Set<kind> | 'all' */
  const watchers = new Map();
  /** connId → principal.scope (`member` cannot register or withdraw; legacy identities unrestricted) */
  const scopes = new Map();

  const keyOf = (announcerId, kind) => `${kind}\u0000${announcerId}`;

  const view = (e) => ({ announcerId: e.announcerId, kind: e.kind, urls: [...e.urls], meta: structuredClone(e.meta), since: e.since });

  const sees = (filter, kind) => filter === 'all' || filter.has(kind);

  function visibleTo(filter) {
    return [...entries.values()].filter((e) => sees(filter, e.kind)).map(view);
  }

  /** Registrations changed: push a full list to each connection subscribed to these kinds */
  function push(ctx, kinds) {
    for (const [connId, filter] of watchers) {
      if ([...kinds].some((k) => sees(filter, k))) {
        ctx.send(connId, { type: 'service.endpoints', endpoints: visibleTo(filter) });
      }
    }
  }

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  function announce(ctx, connId, msg, reqId) {
    const announcerId = checkAnnouncer(msg.announcerId);
    const kind = checkKind(msg.kind);
    const urls = checkUrls(msg.urls, maxUrls);
    const meta = checkMeta(msg.meta, maxMetaBytes);
    const key = keyOf(announcerId, kind);
    const existing = entries.get(key);
    if (!existing && entries.size >= maxAnnouncers) {
      return reply(ctx, connId, { type: 'error', reason: 'limit', detail: tr("Registration count has reached the limit of {0}", maxAnnouncers) }, reqId);
    }
    let changed = true;
    if (existing && existing.offlineAt !== null && sameUrls(existing.urls, urls) && sameMeta(existing.meta, meta)) {
      // Re-registered with identical content from a new connection within grace period:
      // only rebinds connection; unchanged from subscriber perspective, no push
      existing.connId = connId;
      existing.offlineAt = null;
      changed = false;
    } else {
      entries.set(key, { announcerId, kind, urls, meta, since: ctx.now(), connId, offlineAt: null });
    }
    reply(ctx, connId, { type: 'service.announced', announcerId, kind, urls: [...urls] }, reqId);
    if (changed) push(ctx, [kind]);
  }

  function withdraw(ctx, connId, msg, reqId) {
    const announcerId = checkAnnouncer(msg.announcerId);
    const kind = checkKind(msg.kind);
    const key = keyOf(announcerId, kind);
    const existing = entries.get(key);
    const removed = existing !== undefined && existing.connId === connId && existing.offlineAt === null;
    if (removed) entries.delete(key);
    reply(ctx, connId, { type: 'service.withdrawn', announcerId, kind, removed }, reqId);
    if (removed) push(ctx, [kind]);
  }

  function watch(ctx, connId, msg, reqId) {
    let filter;
    if (msg.kinds === 'all') {
      filter = 'all';
    } else if (Array.isArray(msg.kinds)) {
      filter = new Set(msg.kinds.map(checkKind));
    } else {
      bad("kinds must be an array of strings or 'all'");
    }
    watchers.set(connId, filter);
    reply(ctx, connId, { type: 'service.endpoints', endpoints: visibleTo(filter) }, reqId);
  }

  const HANDLERS = { 'service.announce': announce, 'service.withdraw': withdraw, 'service.watch': watch };

  return {
    name: ENDPOINTS_MODULE,
    types: ['service.'],
    tickMs,

    connect(ctx, connId, principal) {
      scopes.set(connId, principal?.scope);
    },

    disconnect(ctx, connId) {
      scopes.delete(connId);
      watchers.delete(connId);
      const at = ctx.now();
      // Registration marked offline but remains visible; removed by tick after grace period expires
      for (const e of entries.values()) {
        if (e.connId === connId && e.offlineAt === null) e.offlineAt = at;
      }
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: 'Service address registration does not support this message' }, reqId);
      // Register and withdraw are only for admin and local identities;
      // members can only subscribe (auth-contract Section 10)
      if (fn !== watch && scopes.get(connId) === 'member') {
        return reply(ctx, connId, { type: 'error', reason: 'forbidden', detail: tr("Members cannot register or withdraw service addresses") }, reqId);
      }
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (!(err instanceof BadMessage)) throw err;
        reply(ctx, connId, { type: 'error', reason: 'bad-message', detail: err.message }, reqId);
      }
    },

    tick(ctx) {
      const at = ctx.now();
      const kinds = new Set();
      for (const [key, e] of entries) {
        if (e.offlineAt !== null && at - e.offlineAt > graceMs) {
          entries.delete(key);
          kinds.add(e.kind);
        }
      }
      if (kinds.size > 0) push(ctx, kinds);
    },

    health() {
      return { endpoints: entries.size };
    },

    describe() {
      return {
        endpoints: [...entries.values()].map((e) => ({ ...view(e), connId: e.connId, offlineAt: e.offlineAt })),
        watchers: watchers.size,
      };
    },
  };
}

/** Alias: aligned with naming conventions of other factories */
export const createEndpointsModule = endpointsModule;
export default endpointsModule;
