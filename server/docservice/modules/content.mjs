/**
 * Content store module (contract `docs/plan/docservice-contract.md` Section 2).
 *
 * Stores small JSON bodies by `(kind, key)`: card source, snapshot manifests, render manifests,
 * event details (`docs/plan/cloud-task.md` component table).
 * - `content.put` / `get` / `list`: store, get, list by prefix;
 * - `content.watch`: subscribe to `content:<kind>` channel, receiving `content.changed` on every
 *   subsequent write.
 *
 * The `card-source` kind issues a `rev` per key (which is `cardRev`): incremented on each `put`,
 * even if the content is identical. Other `kind`s do not have a `rev`.
 * Subsequent writes to the same key follow last-write-wins (semantics
 * `docs/semantics/product/document-service.md` "Conflicts");
 * the overwriting side checks `content.stored`, and the overwritten side checks
 * `content.changed.previousActor` in the channel, so both sides know.
 *
 * Writer identity is taken from the connection principal; self-reported `userId` in messages
 * is never accepted.
 * Each `kind` has an append log, replayed once upon first use to restore the latest state and
 * `rev` for each key, and maintained in memory thereafter.
 * This connection transmits only small messages: if the serialized body exceeds `maxBodyBytes`,
 * it is rejected and no state is persisted.
 */
import { createHash } from 'node:crypto';
import { createMemoryStore } from '../store/index.mjs';
import { actorOf } from './actor.mjs';

export const CONTENT_MODULE = 'content';
export const CONTENT_KINDS = Object.freeze(['card-source', 'snapshot-manifest', 'render-manifest', 'event-detail']);
export const CONTENT_DEFAULTS = Object.freeze({ MAX_BODY_BYTES: 256 * 1024, MAX_LIST: 1000, MAX_KEY_LENGTH: 512 });

/** Kinds that issue a rev per key */
const REV_KINDS = new Set(['card-source']);

const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

class BadMessage extends Error {}
function bad(detail) { throw new BadMessage(detail); }
class TooLarge extends Error {}

function checkKind(v) {
  if (typeof v !== 'string' || !CONTENT_KINDS.includes(v)) bad(`kind must be one of ${CONTENT_KINDS.join(' / ')}`);
  return v;
}

function checkKey(v) {
  if (typeof v !== 'string' || v.length < 1 || v.length > CONTENT_DEFAULTS.MAX_KEY_LENGTH) bad('key must be a string of 1-512 characters');
  return v;
}

function checkPrefix(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > CONTENT_DEFAULTS.MAX_KEY_LENGTH) bad('prefix must be a string of at most 512 characters');
  return v;
}

/** Optional `session` (same as project version module): null if omitted; 1-128 chars if provided */
function checkSession(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length < 1 || v.length > 128) bad('session must be a string of 1-128 characters');
  return v;
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const streamOf = (kind) => `content/${kind}`;
const channelOf = (kind) => `content:${kind}`;
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Add rev (present only for kinds that issue a rev per key) to the message */
function withRev(message, kind, rev) {
  if (REV_KINDS.has(kind)) message.rev = rev;
  return message;
}

/**
 * @param {object} [options]
 * @param {{ append(stream: string, record: object): void, read(stream: string): object[] }} [options.store]
 *   Log store (`../store/index.mjs`); defaults to in-memory store, does not persist across restarts
 * @param {() => number} [options.now] Defaults to `ctx.now()`
 * @param {number} [options.maxBodyBytes] Upper limit on serialized body size, defaults to 256 KiB
 */
export function contentModule({ store = createMemoryStore(), now, maxBodyBytes = CONTENT_DEFAULTS.MAX_BODY_BYTES } = {}) {
  /** kind → Map<key, { body, hash, rev, actor, at }>; replayed from log when a kind is first used */
  const kinds = new Map();
  /** connId → principal */
  const principals = new Map();
  /** connId → subscribed kind (last watch takes precedence) */
  const watching = new Map();
  /** Latest context: borrowed for broadcasting when another module writes on its behalf (`putFromModule`) */
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
   * Writes one entry (shared by `content.put` and `putFromModule`): validates size, appends to log,
   * updates memory, and returns response fields and message to broadcast.
   * Throws TooLarge if exceeding the limit, persisting nothing.
   */
  function write(ctx, kind, key, bodyIn, actor) {
    const text = JSON.stringify(bodyIn);
    if (Buffer.byteLength(text, 'utf8') > maxBodyBytes) throw new TooLarge(`body exceeds ${maxBodyBytes} bytes after serialization`);
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
    // Append to log before updating memory: state remains unchanged on disk failure, core returns internal
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
    if (!('body' in msg) || msg.body === undefined) bad('Missing body');
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
    if (!Array.isArray(msg.kinds)) bad('kinds must be an array of strings');
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
      // Channel subscriptions are cleaned up by core upon disconnect
      principals.delete(connId);
      watching.delete(connId);
    },

    handle(ctx, connId, msg) {
      lastCtx = ctx;
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: 'The content store does not support this message' }, reqId);
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
     * Another module in the same space writes an entry on caller's behalf (C6.5 Section 7: full tool
     * call arguments go into `event-detail`).
     * `actor` is computed by caller from that connection's principal (`actor.mjs`) and not checked here.
     * Broadcasts `content.changed` as usual after writing.
     * Throws TypeError if validation fails; throws error with `err.reason === 'too-large'` if exceeding
     * limit, persisting nothing.
     * @returns {{ kind: string, key: string, hash: string, rev?: number }}
     */
    putFromModule({ kind, key, body, actor } = {}) {
      if (typeof kind !== 'string' || !CONTENT_KINDS.includes(kind)) throw new TypeError(`kind must be one of ${CONTENT_KINDS.join(' / ')}`);
      if (typeof key !== 'string' || key.length < 1 || key.length > CONTENT_DEFAULTS.MAX_KEY_LENGTH) throw new TypeError('key must be a string of 1-512 characters');
      if (body === undefined) throw new TypeError('Missing body');
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

/** Alias: aligned with naming conventions of other factories */
export const createContentModule = contentModule;
export default contentModule;
