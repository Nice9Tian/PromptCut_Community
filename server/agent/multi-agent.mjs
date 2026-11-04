/**
 * Server side of multi-agent (plan `docs/plan/agent-workflow-plan.md` A3; semantics `user-workflow.md`
 * "Multi-Agent", "Protection"):
 *
 *   - `spawn_agent`: lead Agent spawns subagents and dispatches tasks: new chat ID (= new
 *     identity, registered in `agent-sessions.mjs`: vendor / driver inherited from parent chat,
 *     `role` is preset role, records parent chat); opens a new tab via page, and task is dropped
 *     into its inbox as first message (sent by page once tab opens and is idle, same delivery
 *     route as `send_message`).
 *     Limits (plan section 4 item 2 [ruling]): subagents cannot spawn further (depth 1); at most
 *     4 subagents open concurrently for the same lead Agent ([ruling] "running concurrently" = tab
 *     remains open: after subagent finishes a round, it may still be awakened by messages to
 *     continue running; quota is freed only when user closes the tab).
 *     Subagent creativity level takes currently effective level of parent chat, and cannot exceed
 *     parent chat afterwards ([ruling], see `agent-sessions.mjs`).
 *     Returns a clear error when caller has no tab to open (desktop app session, editor not open).
 *   - Four bulletin board tools (`declare_scope` / `list_agents` / `send_message` /
 *     `check_messages`) delegated to per-project bulletin board (`agent-board.mjs`).
 *   - `wrap`: wraps each tool call: records who is running what tool (commit stream records carry
 *     tool name); after call finishes, puts what bulletin board needs to tell it (messages, others
 *     modified its declared scope, its writes were overwritten, it wrote into others' declared
 *     scope) into the result.
 *   - `attachLink`: connects document service commit stream (`onCommit` in `doc-link.mjs`) and
 *     `project.overwritten` sent to each chat connection to the bulletin board.
 *
 * Does not depend on vite: tabs are opened via `openTab` (in production, the editor page's SSE
 * channel), injected by caller; tests use mocks.
 */
import { randomBytes } from 'node:crypto';
import { SPAWN_ROLE_IDS, loadRole } from './agent-roles.mjs';
import { annotateBoard, byOfActor } from './agent-board.mjs';

export const SPAWN_LIMITS = Object.freeze({
  /** Spawn depth: subagents spawned by lead Agent cannot spawn further */
  maxDepth: 1,
  /** Number of concurrent subagents open for the same lead Agent */
  maxChildren: 4,
  /** Task body limit (characters) */
  taskMax: 8000,
});

/** Multi-agent tools answered on the server side */
export const MULTI_AGENT_TOOLS = Object.freeze(['spawn_agent', 'declare_scope', 'list_agents', 'send_message', 'check_messages']);
const COORD = new Set(MULTI_AGENT_TOOLS);

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

/** Subagent chat ID: `sub-` + 12 random characters (tab session id and server chat ID share `[A-Za-z0-9_-]{1,64}`) */
export function newChildId() {
  return `sub-${randomBytes(9).toString('base64url')}`;
}

/**
 * @param {object} o
 * @param {ReturnType<import('./agent-sessions.mjs').createAgentSessions>} o.sessions
 * @param {() => ReturnType<import('./agent-board.mjs').createAgentBoard>} o.board Bulletin board
 *   for the current project
 * @param {(spec: { conversationId: string, role: string, roleName: string, parent: string, provider: string | null, creativity: string, task: string }) => Promise<void>} o.openTab
 *   Opens tab; throws if unable to open (no editor, page did not respond)
 * @param {() => string} [o.projectCreativity] Current default level for the project
 * @param {() => string} [o.newId]
 */
export function createMultiAgent({ sessions, board, openTab, projectCreativity = () => 'high', newId = newChildId, limits: limitsIn = {} } = {}) {
  if (!sessions || typeof board !== 'function' || typeof openTab !== 'function') throw new TypeError('createMultiAgent: requires sessions, board, openTab');
  const L = { ...SPAWN_LIMITS, ...limitsIn };

  /** Subagents currently open for this lead Agent (tabs not yet closed) */
  function liveChildren(parent) {
    const b = board();
    return sessions.childrenOf(parent).filter((c) => !b.tabClosed(c.id));
  }

  async function spawn(parentKey, args) {
    const role = typeof args?.role === 'string' ? args.role.trim() : '';
    const task = typeof args?.task === 'string' ? args.task.trim() : '';
    if (!SPAWN_ROLE_IDS.includes(role)) return fail(`role must be one of ${SPAWN_ROLE_IDS.join(' / ')}`, { code: 'bad-role' });
    if (!task) return fail('task is required: the task to hand to the sub-Agent', { code: 'bad-task' });
    if (task.length > L.taskMax) return fail(`task is too long (${task.length} characters, limit ${L.taskMax}); write the key points and let it read the project for details`, { code: 'bad-task' });
    if (!parentKey) return fail('This call carries no Agent chat ID (it may have come from an external command line), so a sub-Agent cannot be spawned: a sub-Agent must hang under a chat', { code: 'no-parent' });
    const parent = sessions.get(parentKey);
    if (parent.type === 'desktop') {
      return fail('You are a desktop app session (or a chat not registered in the AI panel), so there is no tab to open and you cannot spawn a sub-Agent. When work needs to be split, ask the user to open a new tab in the AI panel of the editor.', { code: 'no-tab' });
    }
    if (parent.parent) {
      return fail(`You are a sub-Agent (spawned by ${parent.parent}) and cannot spawn other Agents (depth limit ${L.maxDepth}). If you need help, use send_message to tell the Agent that spawned you.`, { code: 'depth' });
    }
    const live = liveChildren(parentKey);
    if (live.length >= L.maxChildren) {
      return fail(`You already have ${live.length} sub-Agents open at once (limit ${L.maxChildren}): ${live.map((c) => c.id).join(', ')}. Use send_message to hand work to them, or wait for the user to close unneeded tabs.`, { code: 'too-many', children: live.map((c) => c.id) });
    }
    const def = loadRole(role);
    if (!def) return fail(`Cannot read the prompt for role ${role} (src/ai/roles/${role}.md)`, { code: 'bad-role' });
    const level = sessions.creativityOf(parentKey, projectCreativity()).level;
    const id = newId();
    const provider = parent.type === 'api' ? 'api' : parent.vendor;
    sessions.register(id, { type: parent.type, vendor: parent.vendor, role, parent: parentKey, creativity: level });
    const b = board();
    b.markSeen(id);
    b.touch(id);
    // Task enters its inbox as first message: sent by page once tab is open and idle (same delivery route as send_message)
    b.deliver({ from: parentKey, to: id, text: task, hops: 1 });
    try {
      await openTab({ conversationId: id, role, roleName: def.name, parent: parentKey, provider, creativity: level, task });
    } catch (err) {
      sessions.unregister(id);
      b.takeInbox(id, false);
      return fail(`Cannot open a tab for the sub-Agent: ${err?.message ?? err}`, { code: 'no-tab' });
    }
    return {
      ok: true,
      conversationId: id,
      role,
      roleName: def.name,
      parent: parentKey,
      provider,
      creativity: level,
      note: `Opened new tab "${def.name}"; the task was sent as its first message. Its chat ID is ${id}: use send_message to coordinate with it and list_agents to see whether it is busy; what it writes is submitted under its own identity.`,
    };
  }

  return {
    limits: L,

    isTool(tool) {
      return COORD.has(tool);
    },

    /** Answer a multi-agent tool on the server side; `agent` is calling chat ID ('' = omitted) */
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
     * Wraps a tool call: registers "who is running what tool" during execution, and puts what the
     * bulletin board needs to tell it into the result once completed (`notice` at the front).
     * Multi-agent tools themselves do not carry this (`check_messages` lists messages on its own).
     * On error, does not consume pending notices, leaving them for the next call.
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
 * Connects a document service connection (`createAgentLink` in `doc-link.mjs`) to the bulletin
 * board:
 *   - Commit stream → change records (with write identity);
 *   - `project.overwritten` sent to chat connections → overwritten Agent learns in next tool result.
 * Returns unbind function.
 * @param {ReturnType<import('./doc-link.mjs').createAgentLink>} link
 * @param {() => ReturnType<import('./agent-board.mjs').createAgentBoard>} board
 */
export function attachLink(link, board) {
  const offCommit = link.onCommit((c) => {
    try { board().noteCommit(c); } catch { /* Bulletin board is incidental */ }
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
