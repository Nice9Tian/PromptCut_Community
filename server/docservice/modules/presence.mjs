/**
 * 在场状态模块(计划 `docs/plan/agent-workflow-plan.md` A3 第二阶段;语义 `user-workflow.md`「保护」「多 Agent」)。
 *
 * 共享项目里,各成员页面的「正在编辑」、各 Agent 的范围声明和互发的消息,要让同一项目的其它成员知道。
 * 它们**不进项目历史**、带过期时间:本模块只在内存里转发,不落盘、不记版本,重启就清空。
 *
 * 消息(都带 `projectId`,可带 `session`;写入身份照项目模块取 principal 加 `session`,消息里自报的身份一律不认):
 * - `presence.set { key, data, ttlMs? }`:记下「这个身份的这一项」(同一身份同一 key 整条替换),在项目频道上
 *   给别的订阅者广播 `presence.update { projectId, key, from, data, expiresAt }`,回 `presence.ok`;
 * - `presence.clear { key }`:撤掉,广播 `presence.update { …, data: null, expiresAt: 0 }`;
 * - `presence.list`:回 `presence.state { projectId, entries: [{ key, from, data, expiresAt }] }`(没过期的);
 * - `presence.send { data }`:不记,只广播一次 `presence.message { projectId, from, data, at }`(Agent 之间的消息);
 * - 连接断了,它记下的各项一并撤掉(广播撤销)。
 * `data` 由客户端约定(`kind: 'editing' | 'agent' | 'agent-message'`),本模块不认识内容,只限大小。
 *
 * 广播借同一空间里项目模块的 `publishToProject`(订阅就是 `project.open`),与事件模块同一个做法;渲染节点的连接不能发。
 *
 * **兼容**:旧版文档服务没有本模块,这几种消息回 `error { reason: 'unsupported' }`(核心的「没有模块处理这种消息」),
 * 客户端据此停发、不报错、不断线;旧客户端不发这些消息,不受影响。
 */
import { actorOf } from './actor.mjs';

export const PRESENCE_MODULE = 'presence';

export const PRESENCE_LIMITS = Object.freeze({
  /** `data` 序列化后的上限(UTF-8 字节) */
  DATA_BYTES: 8 * 1024,
  /** 过期时间:缺省、最短、最长 */
  TTL_DEFAULT_MS: 30_000,
  TTL_MIN_MS: 1_000,
  TTL_MAX_MS: 30 * 60_000,
  /** 每个项目最多记多少项 */
  PER_PROJECT: 256,
});

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class BadMessage extends Error {}
function bad(detail) { throw new BadMessage(detail); }
class Refused extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}

const identityOf = (a) => JSON.stringify([a?.userId ?? null, a?.deviceId ?? null, a?.role ?? null, a?.conversation ?? null, a?.session ?? null]);

/**
 * @param {object} options
 * @param {{ publishToProject(projectId: string, message: object, opts?: object): number }} options.project 同一空间的项目模块
 * @param {() => number} [options.now]
 */
export function presenceModule({ project, now } = {}) {
  if (!project || typeof project.publishToProject !== 'function') throw new TypeError('presenceModule: project 必须是带 publishToProject 的项目模块');
  const principals = new Map();
  /** projectId → Map<entryKey, { key, from, data, expiresAt, connId }> */
  const projects = new Map();
  const stats = { sets: 0, clears: 0, sends: 0, lists: 0 };
  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  function common(connId, msg) {
    if (typeof msg.projectId !== 'string' || !PROJECT_ID_RE.test(msg.projectId)) bad('projectId 不合法');
    let session = null;
    if (msg.session !== undefined && msg.session !== null) {
      if (typeof msg.session !== 'string' || msg.session.length < 1 || msg.session.length > 128) bad('session 必须是 1～128 个字符的字符串');
      session = msg.session;
    }
    const principal = principals.get(connId);
    if (principal?.role === 'render') throw new Refused('forbidden', '渲染节点的连接不能发在场状态');
    return { projectId: msg.projectId, from: actorOf(principal, session) };
  }

  function checkData(v) {
    if (!isObj(v)) bad('data 必须是对象');
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch { bad('data 不能序列化'); }
    if (bytes > PRESENCE_LIMITS.DATA_BYTES) throw new Refused('too-large', `data 超过 ${PRESENCE_LIMITS.DATA_BYTES} 字节`);
    return v;
  }

  function prune(list, t) {
    for (const [k, e] of list) if (e.expiresAt <= t) list.delete(k);
  }

  function listOf(projectId) {
    let list = projects.get(projectId);
    if (!list) projects.set(projectId, (list = new Map()));
    return list;
  }

  function set(ctx, connId, msg, reqId) {
    const { projectId, from } = common(connId, msg);
    if (typeof msg.key !== 'string' || !KEY_RE.test(msg.key)) bad('key 必须是 1～64 个 [A-Za-z0-9._:-] 字符');
    const data = checkData(msg.data);
    let ttl = PRESENCE_LIMITS.TTL_DEFAULT_MS;
    if (msg.ttlMs !== undefined) {
      if (!Number.isFinite(msg.ttlMs)) bad('ttlMs 必须是数字');
      ttl = Math.min(PRESENCE_LIMITS.TTL_MAX_MS, Math.max(PRESENCE_LIMITS.TTL_MIN_MS, Math.round(msg.ttlMs)));
    }
    const t = clock(ctx);
    const list = listOf(projectId);
    prune(list, t);
    const entryKey = `${identityOf(from)}|${msg.key}`;
    if (!list.has(entryKey) && list.size >= PRESENCE_LIMITS.PER_PROJECT) throw new Refused('too-many', `这个项目的在场状态已有 ${PRESENCE_LIMITS.PER_PROJECT} 项`);
    const expiresAt = t + ttl;
    list.set(entryKey, { key: msg.key, from, data, expiresAt, connId });
    stats.sets += 1;
    project.publishToProject(projectId, { type: 'presence.update', projectId, key: msg.key, from, data, expiresAt }, { except: connId });
    reply(ctx, connId, { type: 'presence.ok', projectId, key: msg.key, expiresAt }, reqId);
  }

  function clear(ctx, connId, msg, reqId) {
    const { projectId, from } = common(connId, msg);
    if (typeof msg.key !== 'string' || !KEY_RE.test(msg.key)) bad('key 必须是 1～64 个 [A-Za-z0-9._:-] 字符');
    const list = projects.get(projectId);
    const had = list?.delete(`${identityOf(from)}|${msg.key}`);
    stats.clears += 1;
    if (had) project.publishToProject(projectId, { type: 'presence.update', projectId, key: msg.key, from, data: null, expiresAt: 0 }, { except: connId });
    reply(ctx, connId, { type: 'presence.ok', projectId, key: msg.key, expiresAt: 0 }, reqId);
  }

  function list(ctx, connId, msg, reqId) {
    const { projectId } = common(connId, msg);
    const t = clock(ctx);
    const l = projects.get(projectId);
    if (l) prune(l, t);
    stats.lists += 1;
    const entries = l ? [...l.values()].map(({ key, from, data, expiresAt }) => ({ key, from, data, expiresAt })) : [];
    reply(ctx, connId, { type: 'presence.state', projectId, entries }, reqId);
  }

  function send(ctx, connId, msg, reqId) {
    const { projectId, from } = common(connId, msg);
    const data = checkData(msg.data);
    stats.sends += 1;
    const n = project.publishToProject(projectId, { type: 'presence.message', projectId, from, data, at: clock(ctx) }, { except: connId });
    reply(ctx, connId, { type: 'presence.ok', projectId, delivered: n }, reqId);
  }

  const HANDLERS = { 'presence.set': set, 'presence.clear': clear, 'presence.list': list, 'presence.send': send };

  return {
    name: PRESENCE_MODULE,
    types: ['presence.'],

    connect(ctx, connId, principal) {
      principals.set(connId, { ...principal });
    },

    disconnect(ctx, connId) {
      principals.delete(connId);
      for (const [projectId, l] of projects) {
        for (const [k, e] of l) {
          if (e.connId !== connId) continue;
          l.delete(k);
          project.publishToProject(projectId, { type: 'presence.update', projectId, key: e.key, from: e.from, data: null, expiresAt: 0 });
        }
        if (!l.size) projects.delete(projectId);
      }
    },

    tick(ctx) {
      const t = clock(ctx);
      for (const [projectId, l] of projects) {
        prune(l, t);
        if (!l.size) projects.delete(projectId);
      }
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: '在场状态模块不支持这种消息' }, reqId);
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (err instanceof Refused) return reply(ctx, connId, { type: 'error', reason: err.reason, detail: err.message }, reqId);
        if (!(err instanceof BadMessage)) throw err;
        reply(ctx, connId, { type: 'error', reason: 'bad-message', detail: err.message }, reqId);
      }
    },

    describe() {
      return { projects: projects.size, entries: [...projects.values()].reduce((n, l) => n + l.size, 0), stats: { ...stats } };
    },
  };
}

export const createPresenceModule = presenceModule;
export default presenceModule;
