/**
 * 多 Agent 的服务端一侧(计划 `docs/plan/agent-workflow-plan.md` A3;语义 `user-workflow.md`「多 Agent」「保护」):
 *
 *   - `spawn_agent`:主 Agent 拉起子 Agent 并分派任务 —— 新的对话 ID(= 新身份,登记进 `agent-sessions.mjs`:
 *     厂商 / 驱动沿用父对话,`role` 是预设角色,记下父对话),经页面开一个新页签,任务作为第一条消息投进它的信箱
 *     (页签一开、空闲就由页面发出,与 `send_message` 同一条投递路)。
 *     上限(计划第 4 节第 2 条〔裁〕):子 Agent 不能再拉起(深度 1);同一个主 Agent 同时开着的子 Agent 至多 4 个
 *     (〔裁〕「同时在跑」= 页签还开着:子 Agent 跑完一轮仍可能被消息唤起继续跑,用户关掉页签才腾出名额)。
 *     子 Agent 的创造力等级取父对话此刻生效的等级、之后也不高于父对话(〔裁〕,见 `agent-sessions.mjs`)。
 *     调用方没有页签可开(桌面 APP 的会话、编辑台没打开)时回清楚的错误。
 *   - 公告板的四个工具(`declare_scope` / `list_agents` / `send_message` / `check_messages`)交给按项目的公告板
 *     (`agent-board.mjs`)。
 *   - `wrap`:包住每一次工具调用 —— 记下这是谁在跑什么工具(提交流的记录带工具名),调用完把公告板要告诉它的
 *     (消息、别人动了它声明的范围、它写的被覆盖了、它写进了别人声明的范围)放进结果。
 *   - `attachLink`:把文档服务的提交流(`doc-link.mjs` 的 `onCommit`)和发给各对话连接的 `project.overwritten`
 *     接到公告板上。
 *
 * 不依赖 vite:页签经 `openTab` 开(生产上是编辑器页面的 SSE 通道),由调用方注入,测试用假的。
 */
import { randomBytes } from 'node:crypto';
import { SPAWN_ROLE_IDS, loadRole } from './agent-roles.mjs';
import { annotateBoard, byOfActor } from './agent-board.mjs';

export const SPAWN_LIMITS = Object.freeze({
  /** 拉起的深度:主 Agent 拉起的子 Agent 不能再拉起 */
  maxDepth: 1,
  /** 同一个主 Agent 同时开着的子 Agent 数 */
  maxChildren: 4,
  /** 任务正文的上限(字符) */
  taskMax: 8000,
});

/** 在服务端答的多 Agent 工具 */
export const MULTI_AGENT_TOOLS = Object.freeze(['spawn_agent', 'declare_scope', 'list_agents', 'send_message', 'check_messages']);
const COORD = new Set(MULTI_AGENT_TOOLS);

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

/** 子 Agent 的对话 ID:`sub-` + 12 位随机(页签的会话 id 与服务端对话 ID 共用 `[A-Za-z0-9_-]{1,64}`) */
export function newChildId() {
  return `sub-${randomBytes(9).toString('base64url')}`;
}

/**
 * @param {object} o
 * @param {ReturnType<import('./agent-sessions.mjs').createAgentSessions>} o.sessions
 * @param {() => ReturnType<import('./agent-board.mjs').createAgentBoard>} o.board 当前项目的公告板
 * @param {(spec: { conversationId: string, role: string, roleName: string, parent: string, provider: string | null, creativity: string, task: string }) => Promise<void>} o.openTab
 *   开页签;开不出来就抛(没有编辑台、页面没回)
 * @param {() => string} [o.projectCreativity] 项目此刻的默认等级
 * @param {() => string} [o.newId]
 */
export function createMultiAgent({ sessions, board, openTab, projectCreativity = () => 'high', newId = newChildId, limits: limitsIn = {} } = {}) {
  if (!sessions || typeof board !== 'function' || typeof openTab !== 'function') throw new TypeError('createMultiAgent: 要 sessions、board、openTab');
  const L = { ...SPAWN_LIMITS, ...limitsIn };

  /** 这个主 Agent 此刻开着的子 Agent(页签没关过的) */
  function liveChildren(parent) {
    const b = board();
    return sessions.childrenOf(parent).filter((c) => !b.tabClosed(c.id));
  }

  async function spawn(parentKey, args) {
    const role = typeof args?.role === 'string' ? args.role.trim() : '';
    const task = typeof args?.task === 'string' ? args.task.trim() : '';
    if (!SPAWN_ROLE_IDS.includes(role)) return fail(`role 只能是 ${SPAWN_ROLE_IDS.join(' / ')}`, { code: 'bad-role' });
    if (!task) return fail('task 必填:交给子 Agent 的任务', { code: 'bad-task' });
    if (task.length > L.taskMax) return fail(`task 太长(${task.length} 字符,上限 ${L.taskMax}),写要点,细节让它自己读项目`, { code: 'bad-task' });
    if (!parentKey) return fail('这条调用没带 Agent 对话 ID(可能是外部命令行调的),拉不起子 Agent:子 Agent 要挂在一个对话下面', { code: 'no-parent' });
    const parent = sessions.get(parentKey);
    if (parent.type === 'desktop') {
      return fail('你是桌面 APP 的会话(或没在 AI 栏登记过的对话),没有页签可开,不能拉起子 Agent。需要分工时请用户在编辑界面的 AI 栏开新页签。', { code: 'no-tab' });
    }
    if (parent.parent) {
      return fail(`你是子 Agent(由 ${parent.parent} 拉起),不能再拉起别的 Agent(深度上限 ${L.maxDepth})。需要帮手就用 send_message 告诉拉起你的 Agent。`, { code: 'depth' });
    }
    const live = liveChildren(parentKey);
    if (live.length >= L.maxChildren) {
      return fail(`你同时开着的子 Agent 已经有 ${live.length} 个(上限 ${L.maxChildren}):${live.map((c) => c.id).join('、')}。用 send_message 把活派给它们,或等用户关掉用不着的页签。`, { code: 'too-many', children: live.map((c) => c.id) });
    }
    const def = loadRole(role);
    if (!def) return fail(`角色 ${role} 的提示词读不到(src/ai/roles/${role}.md)`, { code: 'bad-role' });
    const level = sessions.creativityOf(parentKey, projectCreativity()).level;
    const id = newId();
    const provider = parent.type === 'api' ? 'api' : parent.vendor;
    sessions.register(id, { type: parent.type, vendor: parent.vendor, role, parent: parentKey, creativity: level });
    const b = board();
    b.markSeen(id);
    b.touch(id);
    // 任务作为第一条消息进它的信箱:页签一开、空闲就由页面发出(与 send_message 同一条投递路)
    b.deliver({ from: parentKey, to: id, text: task, hops: 1 });
    try {
      await openTab({ conversationId: id, role, roleName: def.name, parent: parentKey, provider, creativity: level, task });
    } catch (err) {
      sessions.unregister(id);
      b.takeInbox(id, false);
      return fail(`开不出子 Agent 的页签:${err?.message ?? err}`, { code: 'no-tab' });
    }
    return {
      ok: true,
      conversationId: id,
      role,
      roleName: def.name,
      parent: parentKey,
      provider,
      creativity: level,
      note: `已开新页签「${def.name}」,任务作为它的第一条消息发出。它的对话 ID 是 ${id}:用 send_message 和它协调,用 list_agents 看它忙不忙;它写的内容以它自己的身份提交。`,
    };
  }

  return {
    limits: L,

    isTool(tool) {
      return COORD.has(tool);
    },

    /** 在服务端答一个多 Agent 工具;`agent` 是发起调用的对话 ID('' = 没带) */
    async handle(tool, args, agent = '') {
      const key = typeof agent === 'string' ? agent : '';
      const b = board();
      b.touch(key);
      switch (tool) {
        case 'spawn_agent': return spawn(key, args ?? {});
        case 'declare_scope': return b.declareScope(key, args ?? {});
        case 'list_agents': return b.listAgents(key);
        case 'send_message': return b.sendMessage(key, args ?? {});
        case 'check_messages': return b.checkMessages(key);
        default: throw Object.assign(new Error(`Unknown tool: ${tool}`), { code: 'UNKNOWN_TOOL' });
      }
    },

    /**
     * 包住一次工具调用:调用期间登记「谁在跑什么工具」,调用完把公告板要告诉它的放进结果(`notice` 在最前)。
     * 多 Agent 工具本身不带(`check_messages` 自己就列着消息)。抛错时不取走待告知的,留给下一次。
     */
    async wrap(agent, tool, run) {
      const key = typeof agent === 'string' ? agent : '';
      const b = board();
      const since = b.seq();
      b.touch(key);
      b.beginCall(key, tool);
      let result;
      try {
        result = await run();
      } finally {
        b.endCall(key);
      }
      if (COORD.has(tool)) return result;
      const scopeClash = key ? b.writerNotice(key, since) : [];
      const pending = b.pendingFor(key);
      return annotateBoard(result, { ...pending, scopeClash }, b.limits);
    },
  };
}

/**
 * 把一条到文档服务的连接(`doc-link.mjs` 的 `createAgentLink`)接到公告板上:
 *   - 提交流 → 改动记录(带写入身份);
 *   - 发给各对话连接的 `project.overwritten` → 被覆盖的那个 Agent 下一次工具结果里得知。
 * 回解绑函数。
 * @param {ReturnType<import('./doc-link.mjs').createAgentLink>} link
 * @param {() => ReturnType<import('./agent-board.mjs').createAgentBoard>} board
 */
export function attachLink(link, board) {
  const offCommit = link.onCommit((c) => {
    try { board().noteCommit(c); } catch { /* 公告板是附带的 */ }
  });
  const offMessage = link.onMessage((msg) => {
    if (msg?.type !== 'project.overwritten') return;
    if (msg.projectId !== undefined && msg.projectId !== link.projectId) return;
    const victim = byOfActor(msg.writer);
    if (victim.kind !== 'agent' || victim.agent === null) return;
    board().noteOverwritten(victim.agent, { entity: msg.entity, by: msg.by, rev: msg.rev, at: msg.at });
  });
  return () => { offCommit(); offMessage(); };
}
