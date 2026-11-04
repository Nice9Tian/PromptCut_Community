/**
 * Pending merge table module (semantics `docs/semantics/product/document-service.md` "Conflicts":
 * each user's pending merge items are stored in the document service outside the project JSON;
 * mechanism `docs/semantics/mechanism/document-service.md` "Save baseline and modification state
 * check": stored by "project × user identity").
 *
 * - **Independent of project JSON**: does not go through the project module, does not increment
 *   the project history sequence number, and is not broadcast to other members; stored by project
 *   in `merges/<project-id>` in the same space.
 * - **Divided by "project × user"**: user identity takes only the connection's principal (by
 *   account id for account projects, by username for passphrase projects, and `local` for local
 *   space); self-reported identities in messages are never accepted. The same user sees the same
 *   table across different devices and pages; different users cannot see each other's tables.
 * - An entry in the table is a thing (`MergeThing` in `src/editor/sync/mergeItems.ts`); this module
 *   is agnostic to content, recognizes only `key` and `props[].prop`, and only limits size.
 *
 * Messages (all include `projectId`, may include `reqId`):
 * - `merge.list`: returns `merge.state { projectId, things, version }`;
 * - `merge.put { things }`: replaces the entire entry or adds by `key`, returns `merge.state`;
 * - `merge.remove { remove: [{ key, props? }] }`: removes these second-level items (`props` omitted
 *   = entire entry); when all second-level items are removed, removes the entire entry and returns
 *   `merge.state`. Removing non-existent items does not throw errors (idempotent duplicate submission);
 * - When the table changes, other connections of the same user in this project receive a
 *   `merge.state` (immediately visible when switching devices).
 * Connections from render nodes, host services, and Agents cannot use this (the pending merge
 * table belongs to humans).
 */

export const MERGE_MODULE = 'merge';

/** Tier-3 number (deferred to lead session in report) */
export const MERGE_LIMITS = Object.freeze({
  /** Maximum number of things a user can record in a project */
  THINGS_PER_USER: 2000,
  /** Upper limit for a serialized thing (UTF-8 bytes) */
  THING_BYTES: 512 * 1024,
  /** Upper limit for a user's entire table in a project */
  USER_BYTES: 4 * 1024 * 1024,
});

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

class Refused extends Error {
  constructor(reason, detail) { super(detail); this.reason = reason; }
}

/**
 * Which user the connection belongs to; connections that cannot use the pending merge table
 * return null.
 * Account projects use account id (`account:<id>`), passphrase projects use username (`user:<name>`,
 * same username is the same table on any device), and local space is `local`.
 */
export function mergeUserOf(principal) {
  if (!principal || principal.scope === 'admin' || principal.scope === 'service') return null;
  if (typeof principal.service === 'string' || principal.role === 'render' || principal.role === 'agent') return null;
  if (principal.realm === 'account') return typeof principal.accountId === 'string' && principal.accountId ? `account:${principal.accountId}` : null;
  if (typeof principal.username === 'string' && principal.username) return `user:${principal.username}`;
  if (principal.userId === 'local' || principal.scope === 'local') return 'local';
  return null;
}

function checkThing(t, limits = MERGE_LIMITS) {
  if (!isObj(t) || typeof t.key !== 'string' || t.key.length < 1 || t.key.length > 512) throw new Refused('bad-message', 'things[].key must be 1-512 characters');
  if (!Array.isArray(t.props) || t.props.some((p) => !isObj(p) || typeof p.prop !== 'string' || p.prop.length > 256)) throw new Refused('bad-message', 'things[].props must be an array of { prop }');
  let n;
  try { n = bytes(t); } catch { throw new Refused('bad-message', 'Record cannot be serialized'); }
  if (n > limits.THING_BYTES) throw new Refused('too-large', `An item exceeds ${limits.THING_BYTES} bytes`);
  return t;
}

/**
 * @param {object} options
 * @param {{ read(stream: string): object[], rewrite(stream: string, records: object[]): void }} options.store
 *   Log storage in the same space
 * @param {() => number} [options.now]
 * @param {typeof MERGE_LIMITS} [options.limits] Used by unit tests to swap in smaller numbers
 */
export function pendingMergeModule({ store, now = Date.now, limits = MERGE_LIMITS } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.rewrite !== 'function') throw new TypeError('pendingMergeModule: store must have read / rewrite');
  const principals = new Map();
  /** projectId → Map<user, { things: object[], version: number }> (read from storage when used) */
  const projects = new Map();
  /** connId → Set<projectId> (connections that listed tables: pushed to them when the table changes) */
  const watching = new Map();
  const stats = { lists: 0, puts: 0, removes: 0 };

  const streamOf = (projectId) => `merges/${projectId}`;

  function tableOf(projectId) {
    let t = projects.get(projectId);
    if (t) return t;
    t = new Map();
    for (const r of store.read(streamOf(projectId))) {
      if (r?.projectId !== projectId || typeof r.user !== 'string' || !Array.isArray(r.things)) continue;
      t.set(r.user, { things: r.things, version: Number.isSafeInteger(r.version) ? r.version : 0 });
    }
    projects.set(projectId, t);
    return t;
  }

  function persist(projectId) {
    const t = projects.get(projectId);
    const records = [];
    for (const [user, e] of t ?? []) if (e.things.length) records.push({ projectId, user, version: e.version, things: e.things, at: now() });
    store.rewrite(streamOf(projectId), records);
  }

  function common(connId, msg) {
    if (typeof msg.projectId !== 'string' || !PROJECT_ID_RE.test(msg.projectId)) throw new Refused('bad-message', 'projectId is invalid');
    const principal = principals.get(connId);
    const user = mergeUserOf(principal);
    if (!user) throw new Refused('forbidden', 'This connection cannot use the pending merge list');
    // A shared project's space is the project itself: can only touch this project's table (the project
    // id for local space is provided by the page)
    if (principal.tenantId && principal.tenantId !== 'local' && msg.projectId !== principal.tenantId) throw new Refused('forbidden', 'Not the project of this connection');
    return { projectId: msg.projectId, user };
  }

  function stateOf(projectId, user) {
    const e = tableOf(projectId).get(user);
    return { type: 'merge.state', projectId, things: e ? e.things : [], version: e ? e.version : 0 };
  }

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  /** Other connections of the same user in this project */
  function push(ctx, exceptConn, projectId, user) {
    for (const [connId, set] of watching) {
      if (connId === exceptConn || !set.has(projectId)) continue;
      if (mergeUserOf(principals.get(connId)) !== user) continue;
      ctx.send(connId, stateOf(projectId, user));
    }
  }

  function watch(connId, projectId) {
    let s = watching.get(connId);
    if (!s) watching.set(connId, (s = new Set()));
    s.add(projectId);
  }

  function list(ctx, connId, msg, reqId) {
    const { projectId, user } = common(connId, msg);
    stats.lists += 1;
    watch(connId, projectId);
    reply(ctx, connId, stateOf(projectId, user), reqId);
  }

  function put(ctx, connId, msg, reqId) {
    const { projectId, user } = common(connId, msg);
    if (!Array.isArray(msg.things)) throw new Refused('bad-message', 'things must be an array');
    const incoming = msg.things.map((t) => checkThing(t, limits));
    const t = tableOf(projectId);
    const e = t.get(user) ?? { things: [], version: 0 };
    const things = [...e.things];
    for (const x of incoming) {
      const i = things.findIndex((y) => y.key === x.key);
      if (i >= 0) things[i] = x;
      else things.push(x);
    }
    // Limit exceeded: rejects the entire item (does not drop the oldest or accept half), leaving the
    // table as is; the page keeps these items locally and displays "Temporarily exists only on this device"
    // in the window
    if (things.length > limits.THINGS_PER_USER) throw new Refused('too-many', `The pending merge list holds at most ${limits.THINGS_PER_USER} items`);
    if (bytes(things) > limits.USER_BYTES) throw new Refused('too-large', `The pending merge list exceeds ${limits.USER_BYTES} bytes`);
    t.set(user, { things, version: e.version + 1 });
    persist(projectId);
    stats.puts += 1;
    watch(connId, projectId);
    reply(ctx, connId, stateOf(projectId, user), reqId);
    push(ctx, connId, projectId, user);
  }

  function remove(ctx, connId, msg, reqId) {
    const { projectId, user } = common(connId, msg);
    if (!Array.isArray(msg.remove) || msg.remove.some((r) => !isObj(r) || typeof r.key !== 'string' || (r.props !== undefined && (!Array.isArray(r.props) || r.props.some((p) => typeof p !== 'string')))))
      throw new Refused('bad-message', 'remove must be an array of { key, props? }');
    const t = tableOf(projectId);
    const e = t.get(user);
    watch(connId, projectId);
    stats.removes += 1;
    if (!e) return reply(ctx, connId, stateOf(projectId, user), reqId);
    const drop = new Map(msg.remove.map((r) => [r.key, r.props ? new Set(r.props) : null]));
    let changed = false;
    const things = [];
    for (const x of e.things) {
      if (!drop.has(x.key)) { things.push(x); continue; }
      const props = drop.get(x.key);
      const kept = props ? x.props.filter((p) => !props.has(p.prop)) : [];
      if (kept.length === x.props.length) { things.push(x); continue; }
      changed = true;
      if (kept.length) things.push({ ...x, props: kept });
    }
    if (changed) {
      if (things.length) t.set(user, { things, version: e.version + 1 });
      else t.set(user, { things: [], version: e.version + 1 });
      persist(projectId);
    }
    reply(ctx, connId, stateOf(projectId, user), reqId);
    if (changed) push(ctx, connId, projectId, user);
  }

  const HANDLERS = { 'merge.list': list, 'merge.put': put, 'merge.remove': remove };

  return {
    name: MERGE_MODULE,
    types: ['merge.'],

    connect(ctx, connId, principal) {
      principals.set(connId, { ...principal });
    },

    disconnect(ctx, connId) {
      principals.delete(connId);
      watching.delete(connId);
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: 'The pending merge list module does not support this message' }, reqId);
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        reply(ctx, connId, { type: 'error', reason: err.reason, detail: err.message }, reqId);
      }
    },

    describe() {
      let users = 0, things = 0;
      for (const t of projects.values()) for (const e of t.values()) { if (e.things.length) users++; things += e.things.length; }
      return { projects: projects.size, users, things, stats: { ...stats } };
    },
  };
}

export default pendingMergeModule;
