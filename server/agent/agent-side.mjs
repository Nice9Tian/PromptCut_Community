/**
 * Full Agent server-side suite (C6.5 design doc `docs/plan/c65-design.md` sections 5 and 7):
 * connection to document service and project replica (`doc-link.mjs`), tool executor
 * (`agent-exec.mjs`), plus **dispatching by tool `side`**.
 *
 * Assembled here for both editor vite process (`/api/agent/bind` in `vite-plugin-ai.ts`) and tests;
 * dispatch rules are single-sourced:
 *   - `side: "agent"`: executed on project replica (written under identity of this Agent chat,
 *     committed with expected rev); tools where executor returns `undefined` (media shot mosaic)
 *     are handed off to page;
 *   - `side: "page"`: executed via page (`callPage`, SSE page channel in production); when page
 *     response includes `opIds` it committed, recorded into executor to prevent Agent's immediate
 *     subsequent write from being blocked by changes it asked the page to make;
 *   - `side: "server"`: handed off to `callServer` (`wait`, `report_progress`, does not touch project).
 * Emits an event before and after each tool call (either side) (D2), carrying model-side `callId` (if any).
 *
 * Page state (c65-integ2 ruling): tools that both read page state and write project
 * (`PAGE_STATE_TOOLS` in `agent-exec.mjs`) execute on server, requesting required page state from
 * page once via `callPage(PAGE_STATE_TOOL, { tool, args, keys })` (read-only).
 */
import { createAgentLink } from './doc-link.mjs';
import { createAgentExecutor } from './agent-exec.mjs';
import { modelToolName, pageToolName } from '../tools/ui-names.mjs';
import { annotateError, annotateResult, userEditingFor } from './user-editing.mjs';

/** Internal tool name for requesting read-only page state from the page (not in tool table, hidden from Agent; recognized by page `src/ai/mcpExecutor.ts`) */
export const PAGE_STATE_TOOL = '__page_state';

/**
 * @param {object} o
 * @param {string} o.projectId
 * @param {string | ((conversation: number) => string)} o.url Document service address
 * @param {(conversation: number) => Promise<string[]> | string[]} o.protocolsFor
 * @param {() => Promise<object>} o.loadHost Version of `loadSsrHost` from `ssr-host.mjs` with `load` bound
 * @param {Array<{ name: string, side?: string }>} o.tools Tool table (`tools` from `mcp-tools.mjs`)
 * @param {(tool: string, args: object, ctx: { agent: string }) => Promise<{ result?: any, opIds?: string[] } | any>} o.callPage
 *   Executes a tool via the page. Returns `{ result, opIds }` (`pageResult: 'wrapped'`) or returns the
 *   result directly (default); throws on failure
 * @param {(tool: string, args: object) => Promise<any>} [o.callServer]
 * @param {'wrapped' | 'plain'} [o.pageResult]
 * @param {() => Array<{ clipId: string, kind: string }>} [o.userEditing] Clips currently being edited by
 *   the user (`createUserEditingBoard().current` from `user-editing.mjs`); if provided, tool results
 *   reading / writing these clips include `userEditing` and a notice (A2, notice only, no blocking)
 * @param {(key: string) => string | null} [o.agentLabel] Chat id → vendor name, used in the overwrite notice
 *   "Agent <identity> just edited this"
 * @param {(agent: string, opIds: string[]) => void} [o.onPageWrites] Page executed writes on behalf of an
 *   Agent (A3 bulletin board attributes these commits to it)
 * @param {(agent: string, write: { opId: string, rev: number, clipIds: string[] }) => void} [o.onWrite] A write from a chat has landed
 * `callServer(tool, args, { agent })`: tools with `side: "server"` (`wait`, `report_progress`, A3
 * multi-Agent coordination tools).
 */
export function createAgentSide({
  projectId,
  url,
  protocolsFor,
  WebSocketImpl,
  loadHost,
  tools,
  callPage,
  callServer = async (tool) => ({ ok: false, error: `Server tool ${tool} is not implemented` }),
  pageResult = 'plain',
  prerenderPost = null,
  playhead = () => 0,
  toolGroups = {},
  log = () => {},
  linkOptions = {},
  execLimits = {},
  userEditing = null,
  agentLabel = null,
  onPageWrites = null,
  onWrite = null,
  execSerial = null,
  isolateStore = false,
  enterHost = null,
} = {}) {
  if (!Array.isArray(tools)) throw new TypeError('createAgentSide: tools (the tool table) is required');
  if (typeof callPage !== 'function') throw new TypeError('createAgentSide: callPage is required');
  const byName = new Map(tools.map((t) => [t.name, t]));
  const link = createAgentLink({ url, projectId, protocolsFor, log, ...(WebSocketImpl ? { WebSocketImpl } : {}), ...linkOptions });

  /** Executed via the page, normalized to { result, opIds } */
  async function viaPage(tool, args, agent, extra = null) {
    // Sent to the page are old internal operation names (the ones touching UI, server/tools/ui-names.mjs): 0.7.18 pages also recognize them
    const out = await callPage(pageToolName(tool), args, extra ? { agent, ...extra } : { agent });
    if (pageResult === 'wrapped') return { result: out?.result, opIds: Array.isArray(out?.opIds) ? out.opIds : [] };
    return { result: out, opIds: [] };
  }

  const executor = createAgentExecutor({
    link,
    loadHost,
    prerenderPost,
    playhead,
    toolGroups,
    log,
    limits: execLimits,
    agentLabel,
    // When multiple instances share a server-side store (hosted tier), caller provides lock and clears on acquisition
    ...(execSerial ? { serial: execSerial } : {}),
    isolateStore,
    ...(typeof enterHost === 'function' ? { enterHost } : {}),
    // Read-only page state: requested once over the same page channel
    // `agent` is still '' (desktop page channel dispatches by it, behavior unchanged); the chat requesting
    // it is placed separately in `pageStateFor`, which hosted tier uses to find this chat's page state
    pageState: async (tool, args, keys, agentKey = '') => {
      const { result } = await viaPage(PAGE_STATE_TOOL, { tool, args, keys: [...keys] }, '', { pageStateFor: agentKey });
      return result && typeof result === 'object' ? result : null;
    },
  });

  async function dispatch(tool, args, agent, toolDef, ctx) {
    if (toolDef.side === 'agent') {
      const done = await executor.execute(tool, args, agent, toolDef, ctx);
      if (done !== undefined) return done;
    } else if (toolDef.side === 'server') {
      return callServer(tool, args, { agent });
    }
    // `track` is call event context: tools implemented on server in hosted tier record landed writes on it (desktop page channel ignores it)
    const { result, opIds } = await viaPage(tool, args, agent, { track: ctx });
    const own = opIds.filter((x) => typeof x === 'string');
    if (own.length) {
      // Writes executed by page on behalf of this Agent commit with page identity: tells bulletin board that these commits belong to it (A3)
      try { onPageWrites?.(agent, own); } catch { /* Bulletin board is incidental */ }
      await executor.notePageWrites(agent, own).catch(() => {});
    }
    return result;
  }

  return {
    link,
    executor,
    projectId,

    /**
     * Executes a tool (with events). `agent` is the Agent chat id (string, '' if none), `callId` is the
     * call id of this invocation on the model side. Unknown tools throw `code: 'UNKNOWN_TOOL'`.
     */
    async callTool(toolIn, args = {}, { agent = '', callId } = {}) {
      // Tools touching UI were renamed (user_interface_ prefix): old names are recognized, downstream strictly uses new names
      const tool = modelToolName(toolIn);
      const toolDef = byName.get(tool);
      if (!toolDef) throw Object.assign(new Error(`Unknown tool: ${tool}`), { code: 'UNKNOWN_TOOL' });
      const key = typeof agent === 'string' ? agent : '';
      let seen = null;
      const editingNow = () => {
        if (typeof userEditing !== 'function') return [];
        try { return userEditing() ?? []; } catch { return []; }
      };
      try {
        const result = await executor.track(tool, args, key, (ctx) => { seen = ctx; return dispatch(tool, args, key, toolDef, ctx); }, { callId });
        // A clip currently being edited by the user was read or written by this call: result includes
        // userEditing and a notice (A2; notice only, no blocking)
        // This call landed a write: tells the host which clips were written to (hosted tier uses this
        // to issue a prerender retry plan, contract cloud-agent-contract.md section 16)
        if (seen?.write && typeof onWrite === 'function') {
          try { onWrite(key, { opId: seen.write.opId, rev: seen.write.rev, clipIds: seen.write.clipIds ?? [], before: seen.write.before ?? null }); } catch { /* Host matter, does not affect tool results */ }
        }
        const hit = userEditingFor({ tool, args, written: seen?.write?.clipIds ?? [], editing: editingNow() });
        return annotateResult(result, { userEditing: hit });
      } catch (err) {
        throw annotateError(err, userEditingFor({ tool, args, editing: editingNow() }));
      }
    },

    /** Chat number for a chat id in this process (`conversation` in write identity) */
    conversationNumber(agent = '') {
      return executor.conversationOf(typeof agent === 'string' ? agent : '').n;
    },

    describe() {
      return executor.describe();
    },

    close() {
      link.close();
    },
  };
}
