/**
 * 工具调用事件模块（C6.5 设计稿 `docs/plan/c65-design.md` 第 7 节，D2「页面按操作收增量」）。
 *
 * Agent 服务端每个工具调用发两条：创建（工具名、图标、目标、参数摘要）与完成（状态、摘要、耗时）；
 * 文字回复整条完成时发一条。本模块把它们在**项目频道**（`project:<projectId>`，由项目模块持有）上广播成
 * `events.event`，页面 AI 栏按 `eventId` 更新对应记录。完整参数（`detail`）写进内容库 `event-detail`，
 * 键是 `<projectId>/<eventId>`，页面展开时用 `content.get` 再拉。
 *
 * 本模块不声明自己的频道：广播借同一空间里项目模块的 `publishToProject`，订阅就是 `project.open`；
 * 写内容库借内容模块的 `putFromModule`。两者由组装层按空间配对传进来（`shared-service.mjs`）。
 * 写入身份照项目模块取 principal 加消息里的 `session`（`actor.mjs`）；渲染节点的连接不能发事件。
 * 最近的事件按项目在内存里留一份（`events.list` 取），不落盘：重启后从新的事件开始。
 *
 * 两条事件都可带 `callId`（模型那一侧这次工具调用的 id，页面 AI 栏按它对上聊天记录；c65-integ2）。
 * 完成事件可带这次调用写入项目的 `opId`、`rev`、`inverse`（逆操作），原样广播、记进 `events.list`；
 * 也可带 `detail`，把 `event-detail` 按同一个键补写一次（c65-agent，主会话裁定：结果摘要与写入信息一并存）。
 */
import { actorOf } from './actor.mjs';

export const EVENTS_MODULE = 'events';

export const EVENTS_LIMITS = Object.freeze({
  /** 每个项目在内存里留多少条事件 */
  KEEP: 500,
  TOOL: 128,
  /** 模型那一侧这次工具调用的 id（AI 栏按它对上聊天记录，c65-integ2） */
  CALL_ID: 128,
  ICON: 64,
  TARGET: 512,
  ARGS: 2048,
  SUMMARY: 2048,
  TEXT: 64 * 1024,
  /** 完成事件里逆操作序列化后的上限（UTF-8 字节）；与提交的上限相同 */
  INVERSE: 256 * 1024,
});

export const EVENT_STATUSES = Object.freeze(['ok', 'error', 'cancelled']);

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

class BadMessage extends Error {}
function bad(detail) { throw new BadMessage(detail); }
class Refused extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}

function checkProjectId(v) {
  if (typeof v !== 'string' || !PROJECT_ID_RE.test(v)) bad('projectId 不合法');
  return v;
}

function checkEventId(v) {
  if (typeof v !== 'string' || !EVENT_ID_RE.test(v)) bad('eventId 必须是 1～128 个 [A-Za-z0-9._:-] 字符');
  return v;
}

/** 可选的短文本：没给（或 null）记 null；给了就得是不超过 max 个字符的字符串 */
function optText(v, name, max) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) bad(`${name} 必须是不超过 ${max} 个字符的字符串`);
  return v;
}

function checkSession(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length < 1 || v.length > 128) bad('session 必须是 1～128 个字符的字符串');
  return v;
}

/** 事件详情在内容库里的键 */
export const eventDetailKey = (projectId, eventId) => `${projectId}/${eventId}`;

/**
 * @param {object} options
 * @param {{ publishToProject(projectId: string, message: object, opts?: object): number }} options.project
 *   同一空间的项目模块（广播用）
 * @param {{ putFromModule(args: object): object }} [options.content] 同一空间的内容模块（写 `event-detail` 用）；
 *   不给时带 `detail` 的事件回 `unsupported`
 * @param {() => number} [options.now] 缺省用 `ctx.now()`
 */
export function eventsModule({ project, content = null, now } = {}) {
  if (!project || typeof project.publishToProject !== 'function') throw new TypeError('eventsModule: project 必须是带 publishToProject 的项目模块');
  /** connId → principal */
  const principals = new Map();
  /** projectId → Map<eventId, 记录>（插入序，超过上限丢最早的） */
  const recent = new Map();
  const stats = { created: 0, completed: 0, texts: 0, details: 0 };

  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  function remember(projectId, eventId, patch) {
    let list = recent.get(projectId);
    if (!list) recent.set(projectId, (list = new Map()));
    const rec = { ...(list.get(eventId) ?? { eventId }), ...patch };
    list.delete(eventId);
    list.set(eventId, rec);
    while (list.size > EVENTS_LIMITS.KEEP) list.delete(list.keys().next().value);
    return rec;
  }

  function common(connId, msg) {
    const projectId = checkProjectId(msg.projectId);
    const eventId = checkEventId(msg.eventId);
    const session = checkSession(msg.session);
    const principal = principals.get(connId);
    if (principal?.role === 'render') throw new Refused('forbidden', '渲染节点的连接不能发工具调用事件');
    return { projectId, eventId, actor: actorOf(principal, session) };
  }

  function broadcast(connId, projectId, event) {
    project.publishToProject(projectId, { type: 'events.event', ...event }, { except: connId });
  }

  function create(ctx, connId, msg, reqId) {
    const { projectId, eventId, actor } = common(connId, msg);
    if (typeof msg.tool !== 'string' || msg.tool.length < 1 || msg.tool.length > EVENTS_LIMITS.TOOL) bad(`tool 必须是 1～${EVENTS_LIMITS.TOOL} 个字符的字符串`);
    const icon = optText(msg.icon, 'icon', EVENTS_LIMITS.ICON);
    const target = optText(msg.target, 'target', EVENTS_LIMITS.TARGET);
    const args = optText(msg.args, 'args', EVENTS_LIMITS.ARGS);
    const callId = optText(msg.callId, 'callId', EVENTS_LIMITS.CALL_ID);
    const at = clock(ctx);
    let detailKey = null;
    if (msg.detail !== undefined) {
      if (!content || typeof content.putFromModule !== 'function') throw new Refused('unsupported', '没有内容库，存不了事件详情');
      detailKey = eventDetailKey(projectId, eventId);
      try {
        content.putFromModule({ kind: 'event-detail', key: detailKey, body: msg.detail, actor });
      } catch (err) {
        if (err?.reason === 'too-large') throw new Refused('too-large', '事件详情超过内容库的上限');
        throw err;
      }
      stats.details += 1;
    }
    const call = callId ? { callId } : {};
    const event = { projectId, eventId, phase: 'create', tool: msg.tool, icon, target, args, detailKey, actor, at, ...call };
    remember(projectId, eventId, { tool: msg.tool, icon, target, args, detailKey, actor, createdAt: at, status: null, ...call });
    stats.created += 1;
    reply(ctx, connId, { type: 'events.ack', projectId, eventId, phase: 'create', detailKey }, reqId);
    broadcast(connId, projectId, event);
  }

  function complete(ctx, connId, msg, reqId) {
    const { projectId, eventId, actor } = common(connId, msg);
    if (!EVENT_STATUSES.includes(msg.status)) bad(`status 只能是 ${EVENT_STATUSES.join(' / ')}`);
    const summary = optText(msg.summary, 'summary', EVENTS_LIMITS.SUMMARY);
    const callId = optText(msg.callId, 'callId', EVENTS_LIMITS.CALL_ID);
    const call = callId ? { callId } : {};
    let durationMs = null;
    if (msg.durationMs !== undefined && msg.durationMs !== null) {
      if (typeof msg.durationMs !== 'number' || !Number.isFinite(msg.durationMs) || msg.durationMs < 0) bad('durationMs 必须是非负数');
      durationMs = msg.durationMs;
    }
    // 这次调用写了项目时（c65-agent，主会话裁定）：透传这次写入的 `opId`、落地的 `rev` 与逆操作 `inverse`，
    // 页面 AI 栏「撤销这一步」据此以页面自己的身份提交逆操作、带 `undoOf`。读工具与被拒的写入不带
    const write = {};
    if (msg.opId !== undefined && msg.opId !== null) {
      if (typeof msg.opId !== 'string' || msg.opId.length < 1 || msg.opId.length > 128) bad('opId 必须是 1～128 个字符的字符串');
      write.opId = msg.opId;
    }
    if (msg.rev !== undefined && msg.rev !== null) {
      if (!Number.isSafeInteger(msg.rev) || msg.rev < 1) bad('rev 必须是正整数');
      write.rev = msg.rev;
    }
    if (msg.inverse !== undefined && msg.inverse !== null) {
      if (write.opId === undefined) bad('带 inverse 时必须带 opId');
      if (!Array.isArray(msg.inverse)) bad('inverse 必须是操作数组');
      if (Buffer.byteLength(JSON.stringify(msg.inverse), 'utf8') > EVENTS_LIMITS.INVERSE) bad(`inverse 序列化后不能超过 ${EVENTS_LIMITS.INVERSE} 字节`);
      write.inverse = msg.inverse;
    }
    // 完成时把 event-detail 补写一次（含结果摘要与上面的写入信息），页面展开这一条时一次拿全
    let detailKey;
    if (msg.detail !== undefined) {
      if (!content || typeof content.putFromModule !== 'function') throw new Refused('unsupported', '没有内容库，存不了事件详情');
      detailKey = eventDetailKey(projectId, eventId);
      try {
        content.putFromModule({ kind: 'event-detail', key: detailKey, body: msg.detail, actor });
      } catch (err) {
        if (err?.reason === 'too-large') throw new Refused('too-large', '事件详情超过内容库的上限');
        throw err;
      }
      stats.details += 1;
    }
    const at = clock(ctx);
    remember(projectId, eventId, { status: msg.status, summary, durationMs, completedAt: at, completedBy: actor, ...call, ...write, ...(detailKey ? { detailKey } : {}) });
    stats.completed += 1;
    reply(ctx, connId, { type: 'events.ack', projectId, eventId, phase: 'complete', ...(detailKey ? { detailKey } : {}) }, reqId);
    broadcast(connId, projectId, { projectId, eventId, phase: 'complete', status: msg.status, summary, durationMs, actor, at, ...call, ...write, ...(detailKey ? { detailKey } : {}) });
  }

  function text(ctx, connId, msg, reqId) {
    const { projectId, eventId, actor } = common(connId, msg);
    if (typeof msg.text !== 'string' || msg.text.length > EVENTS_LIMITS.TEXT) bad(`text 必须是不超过 ${EVENTS_LIMITS.TEXT} 个字符的字符串`);
    const at = clock(ctx);
    remember(projectId, eventId, { text: msg.text, actor, createdAt: at, completedAt: at, status: 'ok', tool: null });
    stats.texts += 1;
    reply(ctx, connId, { type: 'events.ack', projectId, eventId, phase: 'text' }, reqId);
    broadcast(connId, projectId, { projectId, eventId, phase: 'text', text: msg.text, actor, at });
  }

  function list(ctx, connId, msg, reqId) {
    const projectId = checkProjectId(msg.projectId);
    const items = [...(recent.get(projectId)?.values() ?? [])].map((r) => ({ ...r }));
    reply(ctx, connId, { type: 'events.listing', projectId, items }, reqId);
  }

  const HANDLERS = { 'events.create': create, 'events.complete': complete, 'events.text': text, 'events.list': list };

  return {
    name: EVENTS_MODULE,
    types: ['events.'],

    connect(ctx, connId, principal) {
      principals.set(connId, { ...principal });
    },

    disconnect(ctx, connId) {
      principals.delete(connId);
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: '事件模块不支持这种消息' }, reqId);
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (err instanceof Refused) return reply(ctx, connId, { type: 'error', reason: err.reason, detail: err.message }, reqId);
        if (!(err instanceof BadMessage)) throw err;
        reply(ctx, connId, { type: 'error', reason: 'bad-message', detail: err.message }, reqId);
      }
    },

    describe() {
      return { ...stats, projects: recent.size };
    },
  };
}

export const createEventsModule = eventsModule;
export default eventsModule;
