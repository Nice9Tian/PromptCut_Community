/**
 * 内容库模块（契约 `docs/plan/docservice-contract.md` 第 2 节）。
 *
 * 按 `(kind, key)` 存小的 JSON 正文：卡片源码、快照清单、渲染清单、事件详情（`docs/plan/cloud-task.md` 组件表）。
 * - `content.put` / `get` / `list`：存、取、按前缀列；
 * - `content.watch`：订阅 `content:<kind>` 频道，之后每次写入都收到 `content.changed`。
 *
 * `card-source` 这一类按键发 `rev`（就是 `cardRev`）：每次 `put` 加一，内容相同也加。其它 `kind` 没有 `rev`。
 * 同一键再写时后写的赢（语义 `docs/semantics/product/document-service.md`「冲突」），
 * 覆盖方看 `content.stored`，被覆盖方看频道里 `content.changed.previousActor`，两边都知道。
 *
 * 写入者身份取建连时的 principal，消息里自报的 `userId` 一律不认。
 * 每个 `kind` 一条追加日志，第一次用到时回放一次，恢复每个键的最后状态与 `rev`，之后只在内存里维护。
 * 这条连接只传小消息：正文序列化后超过 `maxBodyBytes` 就拒收，不落任何状态。
 */
import { createHash } from 'node:crypto';
import { createMemoryStore } from '../store/index.mjs';
import { actorOf } from './actor.mjs';

export const CONTENT_MODULE = 'content';
export const CONTENT_KINDS = Object.freeze(['card-source', 'snapshot-manifest', 'render-manifest', 'event-detail']);
export const CONTENT_DEFAULTS = Object.freeze({ MAX_BODY_BYTES: 256 * 1024, MAX_LIST: 1000, MAX_KEY_LENGTH: 512 });

/** 按键发 rev 的类别 */
const REV_KINDS = new Set(['card-source']);

const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

class BadMessage extends Error {}
function bad(detail) { throw new BadMessage(detail); }
class TooLarge extends Error {}

function checkKind(v) {
  if (typeof v !== 'string' || !CONTENT_KINDS.includes(v)) bad(`kind 只能是 ${CONTENT_KINDS.join(' / ')}`);
  return v;
}

function checkKey(v) {
  if (typeof v !== 'string' || v.length < 1 || v.length > CONTENT_DEFAULTS.MAX_KEY_LENGTH) bad('key 必须是 1～512 个字符的字符串');
  return v;
}

function checkPrefix(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > CONTENT_DEFAULTS.MAX_KEY_LENGTH) bad('prefix 必须是不超过 512 个字符的字符串');
  return v;
}

/** `session` 可选（同项目版本模块）：没给记为 null；给了就得是 1～128 个字符的字符串 */
function checkSession(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length < 1 || v.length > 128) bad('session 必须是 1～128 个字符的字符串');
  return v;
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const streamOf = (kind) => `content/${kind}`;
const channelOf = (kind) => `content:${kind}`;
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 把 rev（只有按键发 rev 的类别才有）加进消息 */
function withRev(message, kind, rev) {
  if (REV_KINDS.has(kind)) message.rev = rev;
  return message;
}

/**
 * @param {object} [options]
 * @param {{ append(stream: string, record: object): void, read(stream: string): object[] }} [options.store]
 *   日志存储（`../store/index.mjs`）；缺省用内存存储，不跨重启
 * @param {() => number} [options.now] 缺省用 `ctx.now()`
 * @param {number} [options.maxBodyBytes] 正文序列化后的上限，缺省 256 KiB
 */
export function contentModule({ store = createMemoryStore(), now, maxBodyBytes = CONTENT_DEFAULTS.MAX_BODY_BYTES } = {}) {
  /** kind → Map<key, { body, hash, rev, actor, at }>；第一次用到某个 kind 时从日志回放 */
  const kinds = new Map();
  /** connId → principal */
  const principals = new Map();
  /** connId → 订阅的 kind（最后一次 watch 为准） */
  const watching = new Map();
  /** 最近一次拿到的上下文：别的模块代为写入（`putFromModule`）时借它广播 */
  let lastCtx = null;

  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());

  function itemsOf(kind) {
    let items = kinds.get(kind);
    if (items) return items;
    items = new Map();
    for (const rec of store.read(streamOf(kind))) {
      if (rec.kind !== kind || typeof rec.key !== 'string' || typeof rec.hash !== 'string' || !('body' in rec)) continue;
      const prev = items.get(rec.key);
      const rev = REV_KINDS.has(kind) ? (Number.isSafeInteger(rec.rev) ? rec.rev : (prev?.rev ?? 0) + 1) : null;
      items.set(rec.key, { body: rec.body, hash: rec.hash, rev, actor: rec.actor ?? null, at: Number.isFinite(rec.at) ? rec.at : null });
    }
    kinds.set(kind, items);
    return items;
  }

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  /**
   * 写一条（`content.put` 与 `putFromModule` 共用）：校验大小、落日志、改内存，返回回包字段与要广播的消息。
   * 超过上限抛 TooLarge，什么都不落。
   */
  function write(ctx, kind, key, bodyIn, actor) {
    const text = JSON.stringify(bodyIn);
    if (Buffer.byteLength(text, 'utf8') > maxBodyBytes) throw new TooLarge(`body 序列化后超过 ${maxBodyBytes} 字节`);
    const items = itemsOf(kind);
    const prev = items.get(key);
    const hash = sha256(text);
    const rev = REV_KINDS.has(kind) ? (prev?.rev ?? 0) + 1 : null;
    const at = clock(ctx);
    const body = JSON.parse(text);
    const record = withRev({ kind, key, hash }, kind, rev);
    record.actor = actor;
    record.at = at;
    record.body = body;
    // 先落日志再改内存：落盘失败时状态不变，核心回 internal
    store.append(streamOf(kind), record);
    items.set(key, { body, hash, rev, actor, at });
    const changed = withRev({ type: 'content.changed', kind, key, hash }, kind, rev);
    changed.actor = actor;
    changed.previousActor = prev?.actor ?? null;
    return { hash, rev, changed };
  }

  function put(ctx, connId, msg, reqId) {
    const kind = checkKind(msg.kind);
    const key = checkKey(msg.key);
    if (!('body' in msg) || msg.body === undefined) bad('缺少 body');
    const session = checkSession(msg.session);
    const actor = actorOf(principals.get(connId), session);
    const { hash, rev, changed } = write(ctx, kind, key, msg.body, actor);
    reply(ctx, connId, withRev({ type: 'content.stored', kind, key, hash }, kind, rev), reqId);
    ctx.publish(channelOf(kind), changed, { coalesceKey: `content:${kind}:${key}` });
  }

  function get(ctx, connId, msg, reqId) {
    const kind = checkKind(msg.kind);
    const key = checkKey(msg.key);
    const item = itemsOf(kind).get(key);
    if (!item) return reply(ctx, connId, { type: 'content.item', kind, key, missing: true }, reqId);
    reply(ctx, connId, withRev({ type: 'content.item', kind, key, body: structuredClone(item.body), hash: item.hash }, kind, item.rev), reqId);
  }

  function list(ctx, connId, msg, reqId) {
    const kind = checkKind(msg.kind);
    const prefix = checkPrefix(msg.prefix);
    const keys = [...itemsOf(kind).keys()].filter((k) => k.startsWith(prefix)).sort(byCodeUnit);
    const items = kinds.get(kind);
    const shown = keys.slice(0, CONTENT_DEFAULTS.MAX_LIST).map((key) => {
      const item = items.get(key);
      return withRev({ key, hash: item.hash }, kind, item.rev);
    });
    reply(ctx, connId, { type: 'content.listing', kind, items: shown, truncated: keys.length > CONTENT_DEFAULTS.MAX_LIST }, reqId);
  }

  function watch(ctx, connId, msg, reqId) {
    if (!Array.isArray(msg.kinds)) bad('kinds 必须是字符串数组');
    const wanted = [...new Set(msg.kinds.map(checkKind))];
    const before = watching.get(connId) ?? new Set();
    for (const kind of before) {
      if (!wanted.includes(kind)) ctx.unsubscribe(connId, channelOf(kind));
    }
    for (const kind of wanted) ctx.subscribe(connId, channelOf(kind));
    watching.set(connId, new Set(wanted));
    reply(ctx, connId, { type: 'content.watching', kinds: wanted }, reqId);
  }

  const HANDLERS = { 'content.put': put, 'content.get': get, 'content.list': list, 'content.watch': watch };

  return {
    name: CONTENT_MODULE,
    types: ['content.'],
    channels: ['content'],

    connect(ctx, connId, principal) {
      lastCtx = ctx;
      principals.set(connId, { ...principal });
    },

    disconnect(ctx, connId) {
      // 频道订阅由核心在断开时清掉
      principals.delete(connId);
      watching.delete(connId);
    },

    handle(ctx, connId, msg) {
      lastCtx = ctx;
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: '内容库不支持这种消息' }, reqId);
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (err instanceof BadMessage) return reply(ctx, connId, { type: 'error', reason: 'bad-message', detail: err.message }, reqId);
        if (err instanceof TooLarge) return reply(ctx, connId, { type: 'error', reason: 'too-large', detail: err.message }, reqId);
        throw err;
      }
    },

    describe() {
      return {
        kinds: Object.fromEntries([...kinds.entries()].sort(([a], [b]) => byCodeUnit(a, b)).map(([kind, items]) => [kind, items.size])),
        watchers: watching.size,
      };
    },

    /**
     * 同一空间里的别的模块代为写一条（C6.5 第 7 节：工具调用的完整参数进 `event-detail`）。
     * `actor` 由调用方按它那条连接的 principal 算好（`actor.mjs`），这里不再核对。写完照常广播 `content.changed`。
     * 校验不过抛 TypeError；超过上限抛错，`err.reason === 'too-large'`，什么都不落。
     * @returns {{ kind: string, key: string, hash: string, rev?: number }}
     */
    putFromModule({ kind, key, body, actor } = {}) {
      if (typeof kind !== 'string' || !CONTENT_KINDS.includes(kind)) throw new TypeError(`kind 只能是 ${CONTENT_KINDS.join(' / ')}`);
      if (typeof key !== 'string' || key.length < 1 || key.length > CONTENT_DEFAULTS.MAX_KEY_LENGTH) throw new TypeError('key 必须是 1～512 个字符的字符串');
      if (body === undefined) throw new TypeError('缺少 body');
      const ctx = lastCtx ?? { now: () => Date.now(), publish: () => 0 };
      let out;
      try {
        out = write(ctx, kind, key, body, actor ?? null);
      } catch (err) {
        if (err instanceof TooLarge) err.reason = 'too-large';
        throw err;
      }
      ctx.publish(channelOf(kind), out.changed, { coalesceKey: `content:${kind}:${key}` });
      return withRev({ kind, key, hash: out.hash }, kind, out.rev);
    },
  };
}

/** 别名：与其它工厂的命名习惯对齐 */
export const createContentModule = contentModule;
export default contentModule;
