/**
 * 待合并表模块(语义 `docs/semantics/product/document-service.md`「冲突」:每个用户的待合并项保存在文档服务、项目 JSON 之外;
 * 机制 `docs/semantics/mechanism/document-service.md`「保存基准与修改状态检查」:按「项目 × 用户身份」存)。
 *
 * - **独立于项目 JSON**:不经项目模块、不增加项目历史序号、不广播给别的成员;按项目落在同一空间存储的 `merges/<项目号>` 里。
 * - **按「项目 × 用户」分**:用户身份只取连接的 principal(账号项目按账号号,口令项目按用户名,本机空间是 `local`),
 *   消息里自报的一律不认。同一用户换设备、换页面看到的是同一张表;不同用户互相看不见。
 * - 表里的一条是一样东西(`src/editor/sync/mergeItems.ts` 的 `MergeThing`),本模块不认识内容,只认 `key` 与 `props[].prop`,只限大小。
 *
 * 消息(都带 `projectId`,可带 `reqId`):
 * - `merge.list`:回 `merge.state { projectId, things, version }`;
 * - `merge.put { things }`:按 `key` 整条替换或新增,回 `merge.state`;
 * - `merge.remove { remove: [{ key, props? }] }`:拿掉这些二级项(`props` 不给 = 整条),二级项拿光的整条拿掉,回 `merge.state`。
 *   拿掉不存在的不报错(重复提交幂等);
 * - 表变了,同一用户在这个项目里的别的连接收到一条 `merge.state`(换设备也能马上看到)。
 * 渲染节点、托管方服务、Agent 的连接不能用(待合并表是人的)。
 */

export const MERGE_MODULE = 'merge';

/** 三级数字(报告里交主会话定) */
export const MERGE_LIMITS = Object.freeze({
  /** 一个用户在一个项目里最多记多少样东西 */
  THINGS_PER_USER: 2000,
  /** 一样东西序列化后的上限(UTF-8 字节) */
  THING_BYTES: 512 * 1024,
  /** 一个用户在一个项目里整张表的上限 */
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
 * 连接属于哪个用户;不能用待合并表的连接回 null。
 * 账号项目按账号号(`account:<号>`),口令项目按用户名(`user:<名>`,同一用户名在哪台设备上都是同一张表),本机空间是 `local`。
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
  if (!isObj(t) || typeof t.key !== 'string' || t.key.length < 1 || t.key.length > 512) throw new Refused('bad-message', 'things[].key 必须是 1～512 个字符');
  if (!Array.isArray(t.props) || t.props.some((p) => !isObj(p) || typeof p.prop !== 'string' || p.prop.length > 256)) throw new Refused('bad-message', 'things[].props 必须是 { prop } 的数组');
  let n;
  try { n = bytes(t); } catch { throw new Refused('bad-message', '记录不能序列化'); }
  if (n > limits.THING_BYTES) throw new Refused('too-large', `一样东西超过 ${limits.THING_BYTES} 字节`);
  return t;
}

/**
 * @param {object} options
 * @param {{ read(stream: string): object[], rewrite(stream: string, records: object[]): void }} options.store 同一空间的日志存储
 * @param {() => number} [options.now]
 * @param {typeof MERGE_LIMITS} [options.limits] 单测换小数字用
 */
export function pendingMergeModule({ store, now = Date.now, limits = MERGE_LIMITS } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.rewrite !== 'function') throw new TypeError('pendingMergeModule: store 必须有 read / rewrite');
  const principals = new Map();
  /** projectId → Map<user, { things: object[], version: number }>(用到时从存储读) */
  const projects = new Map();
  /** connId → Set<projectId>(列过表的连接:表变了推给它) */
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
    if (typeof msg.projectId !== 'string' || !PROJECT_ID_RE.test(msg.projectId)) throw new Refused('bad-message', 'projectId 不合法');
    const principal = principals.get(connId);
    const user = mergeUserOf(principal);
    if (!user) throw new Refused('forbidden', '这条连接不能用待合并表');
    // 共享项目的空间就是项目本身:只能碰这个项目的表(本机空间的项目号由页面给)
    if (principal.tenantId && principal.tenantId !== 'local' && msg.projectId !== principal.tenantId) throw new Refused('forbidden', '不是这条连接的项目');
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

  /** 同一用户在这个项目里别的连接 */
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
    if (!Array.isArray(msg.things)) throw new Refused('bad-message', 'things 必须是数组');
    const incoming = msg.things.map((t) => checkThing(t, limits));
    const t = tableOf(projectId);
    const e = t.get(user) ?? { things: [], version: 0 };
    const things = [...e.things];
    for (const x of incoming) {
      const i = things.findIndex((y) => y.key === x.key);
      if (i >= 0) things[i] = x;
      else things.push(x);
    }
    // 超限:整条不收(不丢最旧的、不收一半),表原样;页面把这几条留在本机,窗口里说「暂时只存在这台设备上」
    if (things.length > limits.THINGS_PER_USER) throw new Refused('too-many', `待合并表最多 ${limits.THINGS_PER_USER} 样东西`);
    if (bytes(things) > limits.USER_BYTES) throw new Refused('too-large', `待合并表超过 ${limits.USER_BYTES} 字节`);
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
      throw new Refused('bad-message', 'remove 必须是 { key, props? } 的数组');
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
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: '待合并表模块不支持这种消息' }, reqId);
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
