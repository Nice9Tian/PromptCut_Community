/**
 * 服务地址登记模块（契约 `docs/plan/render-queue-contract.md` G.6）。
 *
 * 素材服务等所在的一方把自己的地址上报（`service.announce`），需要它的渲染节点、客户端订阅
 * （`service.watch`）后收到全量列表（`service.endpoints`）；上报方撤回（`service.withdraw`）或断开超过宽限期后，
 * 地址随之撤回（语义 `docs/semantics/mechanism/document-service.md`「连接发现」）。
 *
 * 只交换地址：本模块不访问登记的 URL，不转发任何字节。推送一律是按订阅者 `kinds` 过滤后的全量，列表很小，不做增量。
 * 权限（`docs/plan/auth-contract.md` 第 10 节）：`service.announce` / `service.withdraw` 只给管理身份与 `local` 身份，
 * 成员（`scope: 'member'`）回 `forbidden`；`service.watch` 与下发的 `service.endpoints` 对所有身份开放（只读）。
 * 不带 `scope` 的旧式身份（测试注入的 `authenticate`）不受限，与 M5 相同。
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
  if (typeof v !== 'string' || !ANNOUNCER_RE.test(v)) bad('announcerId 不合法');
  return v;
}

function checkKind(v) {
  if (typeof v !== 'string' || !KIND_RE.test(v)) bad('kind 不合法');
  return v;
}

function checkUrls(v, maxUrls) {
  if (!Array.isArray(v) || v.length < 1 || v.length > maxUrls) bad(`urls 要有 1～${maxUrls} 个`);
  return v.map((u) => {
    if (typeof u !== 'string' || u.length > MAX_URL_LENGTH) bad('地址必须是不超过 2048 字符的字符串');
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      bad('地址解析不了');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') bad('地址只能是 http 或 https');
    if (parsed.username !== '' || parsed.password !== '') bad('地址不能带用户名或密码');
    return u;
  });
}

function checkMeta(v, maxBytes) {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) bad('meta 必须是对象');
  let text;
  try {
    text = JSON.stringify(v);
  } catch {
    bad('meta 不能序列化');
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) bad(`meta 序列化后超过 ${maxBytes} 字节`);
  return JSON.parse(text);
}

const sameUrls = (a, b) => a.length === b.length && a.every((u, i) => u === b[i]);
const sameMeta = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {object} [options] 覆盖 `ENDPOINT_DEFAULTS` 的上限（测试用）
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
  /** connId → principal.scope（`member` 不能登记与撤回；不带 scope 的旧式身份不受限） */
  const scopes = new Map();

  const keyOf = (announcerId, kind) => `${kind}\u0000${announcerId}`;

  const view = (e) => ({ announcerId: e.announcerId, kind: e.kind, urls: [...e.urls], meta: structuredClone(e.meta), since: e.since });

  const sees = (filter, kind) => filter === 'all' || filter.has(kind);

  function visibleTo(filter) {
    return [...entries.values()].filter((e) => sees(filter, e.kind)).map(view);
  }

  /** 登记变了：给订阅了这些 kind 的连接各推一条全量 */
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
      return reply(ctx, connId, { type: 'error', reason: 'limit', detail: `登记数已到上限 ${maxAnnouncers}` }, reqId);
    }
    let changed = true;
    if (existing && existing.offlineAt !== null && sameUrls(existing.urls, urls) && sameMeta(existing.meta, meta)) {
      // 宽限期内从新连接以相同内容再登记：只改绑连接，订阅方看到的没变，不推送
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
      bad("kinds 必须是字符串数组或 'all'");
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
      // 登记标为离线但仍然可见，过了宽限期由 tick 删掉
      for (const e of entries.values()) {
        if (e.connId === connId && e.offlineAt === null) e.offlineAt = at;
      }
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: '服务地址登记不支持这种消息' }, reqId);
      // 登记与撤回只给管理身份与本机身份；成员只能订阅（auth-contract 第 10 节）
      if (fn !== watch && scopes.get(connId) === 'member') {
        return reply(ctx, connId, { type: 'error', reason: 'forbidden', detail: '成员不能登记或撤回服务地址' }, reqId);
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

/** 别名：与其它工厂的命名习惯对齐 */
export const createEndpointsModule = endpointsModule;
export default endpointsModule;
