/**
 * 编辑器进程与文档服务在场状态之间的桥(计划 `docs/plan/agent-workflow-plan.md` A3 第二阶段)。
 *
 * 文档服务一侧是 `../docservice/modules/presence.mjs`(只在内存里转发、带过期时间、不进项目历史)。这里:
 *   - **收**:订阅连接(`doc-link.mjs` 兼做订阅的那条)上收到的 `presence.update` / `presence.state` / `presence.message`:
 *       - `kind: 'editing'`:别的成员的页面正在编辑的片段 → A2 看板的另一个来源(`reportRemote`),
 *         Agent 读写到时提示「用户 <成员>正在编辑」;本机页面自己发布的那份按会话号跳过;
 *       - `kind: 'agent'`:别的成员那边的 Agent 声明的范围 → 公告板的名单(`applyRemoteAgent`);本进程发出去的按 `origin` 跳过;
 *       - `kind: 'agent-message'`:发给本机某个 Agent 的消息 → 进它的信箱(与本机 `send_message` 同一条投递路);
 *   - **发**:本机 Agent 声明了范围(公告板的 `onDeclare`)→ 以**这个 Agent 自己的连接**(它的写入身份)`presence.set`;
 *     本机 Agent 给别的成员那边的 Agent 发消息(公告板的 `forwardRemote`)→ `presence.send`。
 *
 * **兼容**:旧版文档服务(没有在场状态模块)对这几种消息回 `error { reason: 'unsupported' }`。第一次看到就记下「不支持」,
 * 之后一概不发;不抛错、不断线,只是没有跨设备提示。请求超时、连接没就绪也只是这一次没发出去。
 *
 * 只依赖本目录的公告板与看板接口;连接由 `doc-link.mjs` 给。
 */
import { randomBytes } from 'node:crypto';
import { BOARD_DEFAULTS } from './agent-board.mjs';

export const PRESENCE_DEFAULTS = Object.freeze({
  /** Agent 范围的过期时间:与公告板「多久没动静就不算在跑」一致 */
  agentTtlMs: BOARD_DEFAULTS.idleMs,
  /** 一次请求等回包的上限 */
  requestTimeoutMs: 5_000,
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 写入身份 → 成员名:共享项目里 userId 是「用户名@设备」,只取用户名;本机空间(local)回 null */
export function memberOf(actor) {
  const u = typeof actor?.userId === 'string' ? actor.userId : null;
  if (!u || u === 'local' || u === 'anonymous') return null;
  const at = u.indexOf('@');
  return at > 0 ? u.slice(0, at) : u;
}

/**
 * @param {object} o
 * @param {ReturnType<import('./doc-link.mjs').createAgentLink>} o.link
 * @param {() => ReturnType<import('./agent-board.mjs').createAgentBoard>} o.board
 * @param {ReturnType<import('./user-editing.mjs').createUserEditingBoard>} [o.editing]
 * @param {(agentKey: string) => number} o.conversationNumberOf 对话 ID → 它在这条 link 上的对话号(`agent-side` 的 `conversationNumber`)
 * @param {(key: string) => string | null} [o.labelOf] 对话 ID → 厂商
 * @param {(key: string) => { role?: string | null } | null} [o.infoOf]
 * @param {string} [o.origin] 本进程的标识(自己发出去又收回来的按它跳过)
 */
export function createPresenceBridge({ link, board, editing = null, conversationNumberOf, labelOf = () => null, infoOf = () => null, origin = `ed-${randomBytes(6).toString('base64url')}`, log = () => {}, limits: limitsIn = {} } = {}) {
  if (!link || typeof board !== 'function' || typeof conversationNumberOf !== 'function') throw new TypeError('createPresenceBridge: 要 link、board、conversationNumberOf');
  const L = { ...PRESENCE_DEFAULTS, ...limitsIn };
  const projectId = link.projectId;
  /** null = 还不知道;true = 文档服务认;false = 旧版文档服务,不再发 */
  let supported = null;
  const stats = { sent: 0, failed: 0, received: 0, unsupported: 0 };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响 */ } };

  function markReply(reply) {
    if (reply?.type === 'error') {
      if (reply.reason === 'unsupported') {
        if (supported !== false) say('agent.presence.unsupported', { projectId });
        supported = false;
        stats.unsupported += 1;
      } else {
        stats.failed += 1;
      }
      return false;
    }
    if (reply?.type === 'presence.ok' || reply?.type === 'presence.state') supported = true;
    return true;
  }

  /** 以某个对话的连接发一条;回回包(失败回 null,不抛) */
  async function request(agentKey, message) {
    if (supported === false) return null;
    let conn;
    try {
      conn = link.conversation(conversationNumberOf(agentKey));
    } catch {
      return null;
    }
    try {
      const reply = await conn.request({ ...message, projectId }, (m) => m.type === 'presence.ok' || m.type === 'presence.state' || m.type === 'error');
      stats.sent += 1;
      markReply(reply);
      return reply;
    } catch (err) {
      stats.failed += 1;
      say('agent.presence.send-failed', { type: message.type, message: String(err?.message ?? err) });
      return null;
    }
  }

  function ingestUpdate({ key, from, data, expiresAt }) {
    if (typeof key !== 'string') return;
    const member = memberOf(from);
    if (key === 'editing' || key.startsWith('editing:')) {
      if (!editing) return;
      const session = isObj(data) && typeof data.session === 'string' ? data.session : null;
      if (data === null) {
        // 撤销不带 data:按发布者身份里的 session 认
        const s = typeof from?.session === 'string' ? from.session : null;
        if (s) editing.clearRemote(s);
        return;
      }
      if (!session || data.kind !== 'editing') return;
      editing.reportRemote(session, data.entities, { who: member ?? (typeof data.who === 'string' ? data.who : null), expiresAt });
      return;
    }
    if (key.startsWith('agent:')) {
      const id = key.slice('agent:'.length);
      if (data === null) { board().removeRemoteAgent(id); return; }
      if (!isObj(data) || data.kind !== 'agent' || data.origin === origin) return;
      board().applyRemoteAgent({ id, member: member ?? (typeof data.member === 'string' ? data.member : '?'), vendor: data.vendor ?? null, scope: data.scope ?? null, busy: !!data.busy, expiresAt });
    }
  }

  function ingestMessage({ from, data }) {
    if (!isObj(data) || data.kind !== 'agent-message' || data.origin === origin) return;
    if (typeof data.to !== 'string' || typeof data.text !== 'string') return;
    const b = board();
    const local = b.listRaw('').find((a) => a.id === data.to && !a.remote);
    if (!local) return;
    const member = memberOf(from);
    const who = `Agent ${data.from ?? '?'}(${[data.vendor, member ? `成员 ${member} 那边` : null].filter(Boolean).join(',') || '别的成员那边'})`;
    b.deliver({ from: typeof data.from === 'string' ? data.from : null, fromLabel: who, to: data.to, text: data.text, hops: data.hops });
  }

  const off = link.onMessage((msg) => {
    if (!isObj(msg) || (msg.projectId !== undefined && msg.projectId !== projectId)) return;
    switch (msg.type) {
      case 'presence.update':
        stats.received += 1;
        ingestUpdate(msg);
        return;
      case 'presence.message':
        stats.received += 1;
        ingestMessage(msg);
        return;
      case 'project.state':
        // 订阅连接(重新)打开了项目:取一次现有的在场状态(别的成员此刻正在编辑的、别人的 Agent 声明的范围)
        void refresh();
        return;
      default:
    }
  });

  async function refresh() {
    const reply = await request('', { type: 'presence.list' });
    if (reply?.type !== 'presence.state' || !Array.isArray(reply.entries)) return;
    for (const e of reply.entries) ingestUpdate(e);
  }

  const bridge = {
    origin,

    /** 本机某个 Agent 的范围(或撤掉:scope 为 null)经它自己的连接发布 */
    async publishAgent(agentKey) {
      if (typeof agentKey !== 'string' || !agentKey) return null;
      const b = board();
      const me = b.listRaw(agentKey).find((a) => a.you);
      const info = (() => { try { return infoOf(agentKey) ?? {}; } catch { return {}; } })();
      if (!me?.scope) return request(agentKey, { type: 'presence.clear', key: `agent:${agentKey}` });
      return request(agentKey, {
        type: 'presence.set',
        key: `agent:${agentKey}`,
        ttlMs: L.agentTtlMs,
        data: { v: 1, kind: 'agent', origin, id: agentKey, vendor: labelOf(agentKey) ?? null, role: info.role ?? null, scope: me.scope, busy: !!me.busy },
      });
    },

    /** 本机 Agent 发给别的成员那边的 Agent:经发件方自己的连接广播(收件方所在的编辑器进程按 `to` 认) */
    forward({ from, to, text, hops }) {
      if (supported === false) return false;
      void request(typeof from === 'string' ? from : '', {
        type: 'presence.send',
        data: { v: 1, kind: 'agent-message', origin, from: from ?? null, to, text, hops, vendor: from ? labelOf(from) ?? null : null },
      });
      return true;
    },

    /** 立刻打开订阅并取一次(绑上项目时调,不等 Agent 第一次调工具) */
    async start() {
      try {
        link.conversation(conversationNumberOf(''));
        await link.ready();
      } catch (err) {
        say('agent.presence.start-failed', { message: String(err?.message ?? err) });
        return;
      }
      await refresh();
    },

    supported() {
      return supported;
    },

    describe() {
      return { origin, supported, stats: { ...stats } };
    },

    close() {
      off();
    },
  };
  return bridge;
}
