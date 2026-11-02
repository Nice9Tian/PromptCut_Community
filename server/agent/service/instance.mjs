/**
 * An instance of Agent service (contract `docs/plan/cloud-agent-contract.md` sections 2.1 and 3).
 *
 * This is the original setup from the `server/vite-plugin-ai.ts` plugin closure: page channel,
 * project replica binding, main entry point for tool calls (SKILL gate, creativity level gate,
 * multi-Agent), chat (`/api/ai/chat`), and interfaces for multi-Agent and desktop sessions.
 * The state in the closure is the state of this instance: desktop tier creates only one instance,
 * with `vite-plugin-ai.ts` mounting `routes` onto the editor process.
 *
 * `env.server` is a small vite server shape provided by the host (`httpServer`, `ssrLoadModule`,
 * `config.root`, `middlewares.use`); frontend code is loaded only via `ssrLoadModule` →
 * `../ssr-host.mjs`; this directory does not directly reference `src/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { overLimit } from '../../http-guard.mjs';
import { createCallPairing } from '../call-pairing.mjs';
import { createAgentSessions, CREATIVITY_HINT, CREATIVITY_LABEL, normalizeCreativity, projectCreativity } from '../agent-sessions.mjs';
import { createDesktopActivity } from '../desktop-activity.mjs';
import { createAgentBoards } from '../agent-board.mjs';
import { attachLink, createMultiAgent } from '../multi-agent.mjs';
import { createPresenceBridge } from '../presence-bridge.mjs';
import { loadRole } from '../agent-roles.mjs';
import { annotateError, annotateResult, createUserEditingBoard, userEditingFor } from '../user-editing.mjs';
import { effectiveIsFile } from '../../card-overrides.mjs';
import { parkedCutsIndex, cutLookView } from '../ssr-host.mjs';
import { modelToolName, pageToolName } from '../../tools/ui-names.mjs';
import {
  checkCloudTool, initiatorOffline, initiatorUnreachable,
  CLOUD_AGENT_SIDE, CLOUD_HOSTED_TOOLS, CLOUD_INITIATOR_TOOLS, CLOUD_LOOK_TOOLS, CLOUD_PAGE_STATE_READS, CLOUD_PAGE_TOOLS, CLOUD_PLAYHEAD_TOOLS, CLOUD_SLOW_TOOLS,
  cloudSystemNote, cloudOpenTools, cloudLookResult, lookUnavailable, lookSourceUnavailable,
} from './cloud-tools.mjs';
import { attachmentsPrompt } from './hosted-tools.mjs';

/**
 * Maximum wait time per request for tools requesting visuals (and card audio) from the render
 * service in hosted tier. Such requests queue on the render service side
 * (`server/hosted-render/look.mjs`): queuing takes up to 30 minutes, followed by 1 minute per
 * render attempt with 3 retries, all returning explicit results; this is only a fallback, so it is
 * set longer (35 minutes).
 */
const LOOK_QUEUE_TOOL_MS = 35 * 60_000;

function sendJson(res, code, data) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/**
 * @param {object} env
 * @param {object} env.server `{ httpServer, ssrLoadModule(id), config: { root }, middlewares: { use(path, handler) } }`
 * @param {Function} env.prerenderPost Queries prerender process (`server/prerender-client.mjs`;
 *   must be statically imported and passed in by host, see notes in host)
 * @param {() => object | null} env.latestMirror Data mirror of current editor page (`server/vite-plugin-mirror.ts`)
 * @param {() => { t: number } | null} env.latestPlayhead
 * @param {'desktop' | 'hosted'} [env.profile] Default `desktop`. When `hosted` (cloud node,
 *   contract section 3), also provide:
 *   `projectId` (this instance serves only this project), `docUrl`,
 *   `protocolsFor(chatNumber, chatId)` (subprotocols connecting to document service),
 *   `execSerial` (process-level serial lock shared across all instances), `log(event, fields)`,
 *   and optional:
 *   `initiatorOnline(chatId)` (whether member who initiated this round is currently connected and watching),
 *   `pageCall(chatId, tool, args)` (reverse channel: have the page that initiated this round execute once,
 *   returning `{ ok: true, result: { ok, result?, error? } }` or `{ offline: true }`; contract section 28),
 *   `onWrite(chatId, { opId, rev, clipIds })` (a write has landed),
 *   `onFinalClose({ code, reason })` (document service closed data connection with 4003 / 4004: revoked),
 *   `hostedTools` (process-level portion of `hosted-tools.mjs`: tools implemented on the server),
 *   `ownerKey` (who owns the chat, workspace directory partitioned by it)
 */
export function createAgentInstance(env) {
  const { server, prerenderPost, latestMirror, latestPlayhead } = env;
  /**
   * Hosted tier: no page, no CLI driver or desktop session; tools allowed by open manifest,
   * credentials provided by host (contract sections 3, 4, 9)
   */
  const HOSTED = env.profile === 'hosted';
  /**
   * Tool provider for this task in account mode (`account-tools.mjs`, provided by host based on what
   * is actually created in this process); not present in legacy hosted tier or desktop tier.
   * Whether a tool counts as "connected" depends solely on this: only passed to model and executed if
   * present in `accountProvided`; otherwise returns "not yet connected" per static table or takes
   * legacy path.
   */
  const accountTools = HOSTED && env.accountMode === true && env.accountTools && typeof env.accountTools.call === 'function' ? env.accountTools : null;
  const accountProvided = accountTools?.names instanceof Set && accountTools.names.size ? accountTools.names : null;
  /**
   * Call id for this tool call (tool_use id on model side): provider uses it as request id, and host
   * retries of same call will not start a second job
   */
  const toolCallScope = new AsyncLocalStorage();
  let editorRes = null;
  let nextCallId = 1;
  const pendingCalls = new Map                               ();
  const activeRuns = new Map                                                                                                       ();
  /**
   * Pairing callId between codex and agy channels (server/agent/call-pairing.mjs): runner checks in
   * upon seeing tool call in output stream; incoming /api/mcp/call for the same call claims by clues
   * forwarded from mcp-server.mjs, obtaining the same callId as in chat history.
   */
  const callPairing = createCallPairing();
  /**
   * CLI quota circuit breaker (server/runners/quota.mjs): gate before chat starts; after ending,
   * bill by new bytes and recheck in background when reaching threshold; if recheck finds quota
   * exceeded, kill all running chats on the same channel. Module is lazy-loaded like other runners.
   */
  let quotaGuardPromise = null;
  const getQuotaGuard = () => {
    quotaGuardPromise ??= import(new URL('../../runners/quota.mjs', import.meta.url).href).then((m) => ({ guard: m.createQuotaGuard(), mod: m }));
    return quotaGuardPromise;
  };
  const failProviderRuns = (provider, message) => {
    for (const [id, st] of activeRuns) {
      if (st.finished || st.provider !== provider) continue;
      try { st.fail?.(message); } catch {}
      try { st.abort(); } catch {}
      st.finished = true;
      activeRuns.delete(id);
    }
  };

  async function getRunner() {
    let runnerUrl;
    if (process.env.PROMPTCUT_AI_FAKE_RUNNER === '1') {
      runnerUrl = new URL('../../test/fake-runner.mjs', import.meta.url).href;
    } else {
      const mod = process.env.PROMPTCUT_AI_RUNNER_MODULE || './runners/index.mjs';
      // Relative paths resolve against server/ directory (same as before moving into this directory)
      runnerUrl = new URL(mod, new URL('../../', import.meta.url)).href;
    }
    try {
      return await import(runnerUrl);
    } catch (e) {
      throw new Error(`Runner is not ready or failed to load: ${e.message}`);
    }
  }

  /**
   * agent: Agent chat ID that initiated this call (multi-Agent tab). For CLI route, mcp-server brings
   * it from environment variable PROMPTCUT_AGENT; for direct API route, startRun's callTool closure
   * carries it; editor uses it to record "who changed what".
   */
  /*
   * Read-only mirror for data management (docs/archive/topics/decoupling-plan.md section 3.2, stage 4; A7).
   *
   * Editor page pushes project (with version number) to **mirror plugin**
   * (server/vite-plugin-mirror.ts, mounted on both processes); playhead uses its
   * /api/data/playhead. Read-only here: Agent reads and rendering - get_project /
   * see_frames(final video)/ get_gif / bake_card / inspect_card_dom - query prerender process
   * directly with mirror, **completely bypassing editor page**: previously these calls were forwarded
   * via SSE to page, which then sent render requests, hanging for minutes and occupying connections
   * from editor origin, freezing UI while CPU was completely idle.
   * Writes still go through page (undo / redo are both there); page pushes changes before returning
   * results, ensuring read-after-write consistency.
   * When page closes, mirror remains in memory; Agent can still read and view frames as usual.
   *
   * Mirror itself (storage, version window, two-tier diff, forwarding to prerender) moved to mirror
   * plugin: ai plugin is only mounted on editor side, while prerender process also needs to fetch
   * project by key.
   */

  /**
   * These tools execute in place on the server (when mirror exists); others go through editor page
   * as usual.
   * C6.5 D4: when bound to project replica (see bindAgent below), mirror is no longer used: these
   * plus get_layout are executed by server/agent/agent-exec.mjs reading **replica**, response
   * includes rev; this table only handles legacy path when no replica is bound.
   */
  const MIRRORED_TOOLS = new Set(['get_project', 'see_frames', 'get_gif', 'bake_card', 'inspect_card_dom']);

  /**
   * Execute a read / render tool on server. Returns undefined = unhandled here, delegate to editor
   * page.
   * Throw on error (same as page path: bridge passes error to Agent as is).
   */
  async function runMirroredTool(tool, args, toolDef) {
    const mirror = latestMirror();
    if (!MIRRORED_TOOLS.has(tool) || !mirror) return undefined;
    const required = toolDef?.inputSchema?.required ?? [];
    const missing = required.filter((k) => args?.[k] === undefined || args?.[k] === null);
    if (missing.length) throw new Error(`Missing required parameters: ${missing.join(', ')}. Add them and try again.`);
    const project = mirror.project;
    const timeoutMs = toolDef?.timeoutMs || 60000;

    if (tool === 'get_project') {
      // Same shape as editor page getProject: transcript provides only summary, full text uses get_transcript
      // Clip index of parked cuts placed first; model can get clipId in other cuts without user_interface_switch_cut
      const parkedCuts = parkedCutsIndex(project);
      return {
        ...(parkedCuts ? { parkedCuts } : null),
        ...project,
        media: (project.media || []).map((m) => m?.transcript ? {
          ...m,
          transcript: {
            engine: m.transcript.engine, model: m.transcript.model, language: m.transcript.language,
            createdAt: m.transcript.createdAt, segments: m.transcript.segments?.length ?? 0,
            hint: 'Use get_transcript for the full transcript',
          },
        } : m),
      };
    }

    if (tool === 'see_frames') {
      const { source, cutId, ...rest } = args || {};
      // Media shot montage requires running shot detection and writing back to project; left to editor page
      if (source !== undefined && source !== 'timeline') return undefined;
      // cutId: view visuals for that cut without switching (view used only for this export, see seeFrames
      // in agent-exec.mjs)
      if (cutId !== undefined && cutId !== null && typeof cutId !== 'string') throw new Error('cutId must be a string (the cut id from list_cuts); if omitted, the currently active cut is used.');
      const look = cutLookView(project, cutId);
      const times = Array.isArray(rest.times) ? rest.times.filter((x) => typeof x === 'number').slice(0, 10) : [];
      const body = times.length
        ? { project: look.project, times, clipId: rest.clipId }
        : { project: look.project, t: typeof rest.t === 'number' ? rest.t : (rest.clipId ? undefined : (look.active ? (latestPlayhead()?.t ?? 0) : look.parkedT)), clipId: rest.clipId };
      const data = await prerenderPost('/api/vision/snapshot', body, { timeoutMs });
      if (!data?.ok) throw new Error(data?.error || 'Failed to render the frame');
      let result = times.length ? { ok: true, frames: data.frames, note: data.note, __images: data.__images } : data;
      result = { ...result, cut: look.cut };
      // "Visible tool results" in chat panel: same record as editor page withVisual
      const images = [];
      if (data.__image?.base64) images.push({ mime: data.__image.mime, base64: data.__image.base64, label: typeof data.t === 'number' ? `t=${data.t}s` : '' });
      for (const im of Array.isArray(data.__images) ? data.__images : []) if (im?.base64) images.push({ mime: im.mime, base64: im.base64, label: im.label ?? '' });
      if (images.length) {
        const v = await prerenderPost('/api/ai/visual', { tool: 'see_frames', images }, { timeoutMs: 5000 }).catch(() => null);
        if (v?.ok && v.visualId) result = { visualId: v.visualId, ...result };
      }
      return result;
    }

    if (tool === 'get_gif') {
      // Two steps (cloud-task.md resolution 12): Agent side writes specs only (`'agent'`), pixel
      // rendering left to `user` side `/render`
      const spec = await prerenderPost('/api/ai/visual', { tool: 'get_gif', clipId: args.clipId, after: project }, { timeoutMs });
      if (!spec?.ok) throw new Error(spec?.error || 'Failed to make the animated image');
      if (!spec.gifKey) throw new Error(`No clip with id ${args.clipId} on the timeline.`);
      const data = await prerenderPost('/api/ai/visual/render', { key: spec.gifKey }, { timeoutMs });
      if (!data?.ok) throw new Error(data?.error || 'Failed to make the animated image');
      return {
        visualId: spec.visualId, ok: true, clipId: args.clipId, times: data.times, gif: data.gifUrl,
        note: 'Collage 4×2: cell k corresponds to the k-th time in times (row by row, left to right). The user can open this step in the chat panel to see the animated image.',
        ...(data.grid ? { __image: { mime: 'image/png', base64: data.grid } } : {}),
      };
    }

    if (tool === 'bake_card') {
      const data = await prerenderPost('/api/vision/bake', { project, clipId: args.clipId, t: args.t, size: args.size, bg: args.bg }, { timeoutMs });
      if (!data?.ok) throw new Error(data?.error || 'Render failed');
      return data;
    }

    if (tool === 'inspect_card_dom') {
      const ref = typeof args.ref === 'string' ? Number(String(args.ref).replace(/^ref_/, '')) : args.ref;
      const data = await prerenderPost('/api/cards/dom', { project, clipId: args.clipId, t: args.t, ref, depth: args.depth }, { timeoutMs });
      if (!data?.ok) throw new Error(data?.error || 'Cannot read the DOM tree');
      return data;
    }
    return undefined;
  }

  /*
   * ------ C6.5: Agent server-side project replica (D1, D2, D4; docs/plan/c65-design.md sections 5, 7) ------
   *
   * After connecting to document service, page calls POST /api/agent/bind to inform "which project
   * I am editing, which document service I am connecting to". Once bound:
   *   - Tools with side: "agent" execute here on project replica (server/agent/agent-exec.mjs); writes
   *     commit to document service under Agent chat identity with expected version, no longer through
   *     page; get_project / get_layout / see_frames etc. read replica;
   *   - Each tool call (regardless of execution side) emits two events (create / complete) to document
   *     service events module; text reply emits one event upon full completion.
   * When not bound (page not connected to document service, headless instance disabled document service),
   * everything remains as before: write tools sent via SSE to page, read tools read data mirror.
   *
   * Credentials provided by chat number (server/agent/doc-link.mjs, one connection per chat):
   *   - mode "local": this machine local space, loopback + promptcut.role.agent.<n>;
   *   - mode "lan-host": creator's shared project on LAN host, this machine declares
   *     promptcut.tenant.<projectId> + promptcut.role.agent.<n>;
   *   - mode "ticket": shared project (hosted side, LAN member), requests connection ticket from page
   *     via SSE (k:'conn', r:'agent', c:<n>), page returns it via POST /api/agent/ticket.
   */
  /*
   * "User is editing" (plan agent-workflow-plan.md A2): editor page throttles clips being edited and
   * pushes to POST /api/agent/editing, recorded here (with expiration timestamp). When Agent reads or
   * writes to these clips, tool result includes userEditing and a notice; notice only, no blocking.
   */
  const userEditingBoard = createUserEditingBoard();
  /**
   * Chat id → human-readable provider name (used in overwrite notice "Agent <identity>(<provider>)
   * just modified"; desktop app sessions use names like "Claude Code"; registry below)
   */
  const agentLabelOf = (key) => {
    try { const e = agentSessions.get(key); return e?.label ?? e?.vendor ?? null; } catch { return null; }
  };


  let agentBinding = null;
  let ticketSeq = 0;
  const ticketWaiters = new Map                                                                                                                   ();
  const AGENT_MODES = new Set(HOSTED ? ["hosted"] : ["local", "lan-host", "ticket"]);
  const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
  const editorPortOf = () => (server.httpServer?.address())?.port || 5195;
  const agentLog = (event, fields = {}) => {
    // Hosted tier logs handed to host (one JSON per line, only id, count, reason code)
    if (HOSTED) { try { env.log?.(event, fields); } catch { /* Logging failures do not affect the service */ } return; }
    try { console.info("[agent]", event, JSON.stringify(fields)); } catch { console.info("[agent]", event); }
  };

  /** Request an agent role connection ticket from page (signed by page using its document service identity) */
  function requestTicket(projectId, conversation) {
    return new Promise((resolve, reject) => {
      if (!editorRes) return reject(new Error("The editor is not open, so a connection ticket cannot be obtained"));
      const reqId = `t${++ticketSeq}`;
      const timer = setTimeout(() => {
        ticketWaiters.delete(reqId);
        reject(new Error("The page did not return a connection ticket within 10 seconds"));
      }, 10_000);
      ticketWaiters.set(reqId, { resolve, reject, timer });
      editorRes.write(`data: ${JSON.stringify({ type: "agent.ticket", reqId, projectId, role: "agent", conversation })}\n\n`);
    });
  }

  async function bindAgent(input) {
    const projectId = typeof input?.projectId === "string" && PROJECT_ID_RE.test(input.projectId) ? input.projectId : null;
    if (!projectId) throw new Error("projectId is invalid");
    const mode = typeof input?.mode === "string" ? input.mode : (HOSTED ? "hosted" : "local");
    if (!AGENT_MODES.has(mode)) throw new Error(`mode must be one of ${[...AGENT_MODES].join(" / ")}`);
    let url = `ws://127.0.0.1:${editorPortOf()}/docservice`;
    if (mode === "ticket") {
      if (typeof input?.url !== "string" || !/^wss?:\/\//.test(input.url)) throw new Error("When mode is ticket, provide the document service's ws(s):// address");
      url = input.url;
    }
    if (mode === "hosted") {
      // Hosted tier instances serve only project specified at creation: project and document service URL
      // ignore requests
      if (projectId !== env.projectId) throw new Error("This instance does not serve this project");
      if (env.accountDataRequired === true &&
          (env.accountMode !== true || typeof env.accountDataWebSocketImpl !== 'function'))
        throw new Error('The account data connection lacks a trusted instance proof');
      url = env.docUrl;
    }
    // Only the trusted account runner may cancel its own pending binding.
    // Page/LAN bind requests never supply or inherit this signal.
    const bindSignal = mode === 'hosted' && env.accountMode === true && env.accountDataRequired === true &&
      input?.signal && typeof input.signal.addEventListener === 'function' &&
      typeof input.signal.removeEventListener === 'function' ? input.signal : null;
    if (bindSignal?.aborted) throw new Error('run-fenced');
    if (agentBinding && agentBinding.projectId === projectId && agentBinding.mode === mode && agentBinding.url === url) return agentBinding;
    unbindAgent("rebind");
    const imports = Promise.all([
      import(new URL("../agent-side.mjs", import.meta.url).href),
      import(new URL("../ssr-host.mjs", import.meta.url).href),
      import(new URL("../../mcp-tools.mjs", import.meta.url).href),
    ]);
    let imported;
    if (bindSignal) {
      let rejectOnAbort;
      const cancelled = new Promise((_, reject) => { rejectOnAbort = () => reject(new Error('run-fenced'));
        bindSignal.addEventListener('abort', rejectOnAbort, { once: true });
        if (bindSignal.aborted) rejectOnAbort(); });
      try { imported = await Promise.race([imports, cancelled]); }
      finally { bindSignal.removeEventListener('abort', rejectOnAbort); }
      if (bindSignal.aborted) throw new Error('run-fenced');
    } else imported = await imports;
    const [{ createAgentSide }, { loadSsrHost }, { tools, toolGroups }] = imported;
    const protocolsFor = async (n) => {
      // Hosted tier: credentials provided per chat (chat delegation tied to a single chat, contract
      // section 4.2), so handed to host together with chat id corresponding to this chat number
      if (mode === "hosted") {
        const conversationId = side.describe().conversations.find((c) => c.conversation === n)?.key ?? '';
        // The one without chat id ('') is instance's own connection (replica subscription, presence);
        // host decides whose credentials it uses and which round to finalize when rejected
        return env.protocolsFor(n, conversationId);
      }
      if (mode === "local") return ["promptcut.v1", `promptcut.role.agent.${n}`];
      if (mode === "lan-host") return ["promptcut.v1", `promptcut.tenant.${projectId}`, `promptcut.role.agent.${n}`];
      return ["promptcut.v1", `promptcut.ticket.${await requestTicket(projectId, n)}`];
    };
    // Dispatch (side: agent / page / server) and events are in server/agent/agent-side.mjs; tests use same copy
    const side = createAgentSide({
      projectId,
      url,
      protocolsFor,
      ...(env.accountMode === true && env.accountDataWebSocketImpl ? { WebSocketImpl: env.accountDataWebSocketImpl } : {}),
      // Hosted tier: several read-only project and registry page tools now execute on server replica;
      // those with separate server implementations (import media, create/modify card, voiceover) are
      // marked as executed via "page": hosted tier "page" is hostedCallPage below, handed to hosted-tools.mjs;
      // tools with providers created in this process (account mode, `account-tools.mjs`) are all handed to
      // it (take "execute via page" dispatch path, see hostedCallPage);
      // `see_frames` keeps `side: "agent"`, timeline visuals execute on replica as usual, media montage
      // (`source: "media"`) falls back to hostedCallPage after executor returns undefined
      tools: HOSTED ? tools.map((t) => (accountProvided?.has(t.name) && t.name !== 'see_frames' ? { ...t, side: "page" } : CLOUD_AGENT_SIDE.has(t.name) ? { ...t, side: "agent" } : CLOUD_HOSTED_TOOLS.has(t.name) ? { ...t, side: "page" } : t)) : tools,
      toolGroups,
      // Hosted tier has no editor process: leaked /api/* calls in tool implementations point to an
      // unresolvable address, failing immediately without hitting other services on same machine
      loadHost: () => loadSsrHost((id) => server.ssrLoadModule(id), { apiBase: HOSTED ? "http://agent-service.invalid" : `http://127.0.0.1:${editorPortOf()}` }),
      prerenderPost,
      // Hosted tier has no "server-remembered page playhead": playhead comes only from snapshot when
      // sending message, looked up by chat (hostedCallPage below)
      playhead: () => (HOSTED ? 0 : (latestPlayhead()?.t ?? 0)),
      ...(HOSTED ? {
        onWrite: (agent, write) => { try { env.onWrite?.(agent, write); } catch { /* Host responsibility */ } },
        // If the document service closes the data connection with 4003 / 4004, it means revocation
        // (contract section 4.5): do not reconnect; report to the host to stop this round immediately
        // and record the reason
        linkOptions: { onFinalClose: (_n, info) => { try { env.onFinalClose?.(info); } catch { /* Host responsibility */ } } },
      } : {}),
      // Hosted tier: the server-side store is a singleton in the process; all instances share a
      // single lock and clear the field upon entering the lock (contract section 3.3)
      ...(HOSTED ? {
        execSerial: env.execSerial, isolateStore: true,
        // Upon entering the lock, temporarily register user card definitions of **this project**
        // (statically parsed, without executing source code) into the card table, and remove them upon
        // exiting the lock
        enterHost: (host) => host.registerProjectCards(hostedShared?.cards.parsed ?? []),
      } : {}),
      log: agentLog,
      pageResult: "wrapped",
      callPage: async (tool, args, ctx) => {
        if (HOSTED) return hostedCallPage(tool, args, ctx);
        const def = tools.find((t) => t.name === tool);
        const out = await callEditorPage(tool, args, ctx?.agent || undefined, def?.timeoutMs || (tool === "__page_state" ? 10_000 : 60_000));
        if (!out.ok) throw new Error(out.error);
        return { result: out.result || out, opIds: out.opIds };
      },
      callServer: (tool, args, ctx) => runServerTool(tool, args, ctx?.agent || ''),
      userEditing: () => userEditingBoard.current(),
      agentLabel: agentLabelOf,
      onPageWrites: (agent, opIds) => boards.boardFor(projectId).attributeOps(agent, opIds),
    });
    // The bulletin board's change records are fed by this connection's commit stream;
    // project.overwritten sent to each chat connection is recorded for the overwritten Agent (A3)
    const detachLink = attachLink(side.link, () => boards.boardFor(projectId));
    /*
     * Cross-device (A3 phase 2): receive clips currently being edited by other members via the
     * document service's presence (into the A2 board), as well as scopes and messages from Agents on
     * other members' sides (into the bulletin board); send local Agent scopes and messages to them.
     * If legacy document services do not recognize these messages, stop sending, without errors.
     */
    const bridge = createPresenceBridge({
      link: side.link,
      board: () => boards.boardFor(projectId),
      editing: userEditingBoard,
      conversationNumberOf: (key) => side.conversationNumber(key),
      labelOf: agentLabelOf,
      infoOf: (key) => ({ role: agentSessions.get(key).role }),
      log: agentLog,
    });
    presenceBridge = bridge;
    boards.boardFor(projectId).onDeclare = (key) => { void bridge.publishAgent(key); };
    void bridge.start();
    const detachBoard = () => {
      detachLink();
      bridge.close();
      if (presenceBridge === bridge) presenceBridge = null;
      const b = boards.boardFor(projectId);
      b.onDeclare = null;
    };
    agentBinding = { projectId, mode, url, side, detachBoard };
    agentLog("agent.bind", { projectId, mode, url });
    return agentBinding;
  }

  function unbindAgent(reason) {
    const b = agentBinding;
    if (!b) return;
    agentBinding = null;
    try { b.detachBoard?.(); } catch { /* Already released */ }
    try { b.side.close(); } catch { /* Already closed */ }
    agentLog("agent.unbind", { projectId: b.projectId, reason });
  }
  server.httpServer?.once("close", () => unbindAgent("server-close"));

  /**
   * Read-only lock when review loop runs via CLI: null = no lock; Set = only allow these tools
   * (empty Set = block all). See callToolInternal below
   */
  let loopToolLock = null;

  /*
   * Agent session registry (server/agent/agent-sessions.mjs): chat ID -> override values for type,
   * vendor, role, and creativity level.
   * Register once each time a message is sent via /api/ai/chat; register desktop app sessions on each
   * call at /api/mcp/call (type desktop, follows project).
   */
  const agentSessions = createAgentSessions();
  /*
   * Desktop app session grouping in the AI panel (A4, server/agent/desktop-activity.mjs): vendor,
   * ongoing operation, and submitted progress reports.
   * When changed, push the entire snapshot to the page via SSE (agent.desktop), throttled to 100 ms.
   */
  let desktopPushTimer = null;
  const pushDesktop = () => {
    if (desktopPushTimer) return;
    desktopPushTimer = setTimeout(() => {
      desktopPushTimer = null;
      if (!editorRes) return;
      try { editorRes.write(`data: ${JSON.stringify({ type: 'agent.desktop', sessions: desktopActivity.snapshot() })}\n\n`); } catch { /* Page is gone */ }
    }, 100);
  };
  const desktopActivity = createDesktopActivity({ onChange: pushDesktop });
  /**
   * The caller field of /api/mcp/call: only recognizes desktop session identities reported by
   * mcp-server.mjs; if the shape is incorrect, treat as not provided
   */
  const desktopCallerOf = (c) => {
    if (!c || typeof c !== 'object' || c.type !== 'desktop') return null;
    if (typeof c.key !== 'string' || !/^desk-[A-Za-z0-9_-]{1,59}$/.test(c.key)) return null;
    const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
    const client = c.client && typeof c.client === 'object' && typeof c.client.name === 'string'
      ? { name: c.client.name.slice(0, 64), version: typeof c.client.version === 'string' ? c.client.version.slice(0, 32) : '' }
      : null;
    return { key: c.key, vendor: str(c.vendor, 64), label: str(c.label, 64), client };
  };
  /**
   * Preview of "last completed action" under the SKILL floating window (desktop/src-tauri/src/skill_shell.rs
   * watches skillRoot/last-action.*):
   * When a desktop session completes an operation and SKILL mode is open, have the page render a
   * frame of that moment and return it (the page only acts on timeline operations; fails silently).
   * Originally this was done by the headless instance's page; after the headless instance was
   * archived, it is done by the user's page.
   */
  const requestSkillPreview = (tool, args, result) => {
    if (!editorRes || (result && typeof result === 'object' && result.ok === false)) return;
    void import(new URL('../../skill-gate.mjs', import.meta.url).href).then((gate) => {
      if (!gate.readState().active || !editorRes) return;
      const clipId = typeof args?.clipId === 'string' ? args.clipId : typeof result?.clip?.id === 'string' ? result.clip.id : null;
      const start = typeof args?.start === 'number' ? args.start : null;
      try { editorRes.write(`data: ${JSON.stringify({ type: 'skill.preview', tool, clipId, start })}\n\n`); } catch { /* Page is gone */ }
    }).catch(() => {});
  };
  /**
   * Project default level reported in passing when the page sends a message: used when the server
   * cannot read the project (no replica bound, no mirror)
   */
  let projectCreativityHint = null;
  /**
   * Current default level of the project. In order of freshness: if a project replica is bound,
   * read the replica (the latest version from the document service); otherwise, read the mirror
   * pushed by the page; if still none, use the one reported when the page sent the message; if none
   * at all, default to factory "high".
   */
  function currentProjectCreativity() {
    const replica = (agentBinding)?.side?.link?.replica?.project;
    if (replica && typeof replica === 'object') return projectCreativity(replica);
    const mirrored = latestMirror()?.project;
    if (mirrored && typeof mirrored === 'object') return projectCreativity(mirrored);
    return normalizeCreativity(projectCreativityHint) ?? projectCreativity(null);
  }
  /**
   * The level of create_card is determined by "whether this user card exists" (rewriting an existing
   * one entirely = medium, creating new = high); evaluated against the active copy, overlay layer
   * takes precedence
   */
  function userCardExists(id) {
    // Hosted tier: user cards are in this project's content store (the main entry point has
    // already listed them before determining the level)
    if (HOSTED) return hostedShared?.cards.items.has(`src/cards/user/${id}.tsx`) === true;
    return effectiveIsFile(server.config.root, path.join(server.config.root, 'src', 'cards', 'user', `${id}.tsx`));
  }

  /*
   * ---------------- Multi-Agent (plan agent-workflow-plan.md A3) ----------------
   *
   * Bulletin board (server/agent/agent-board.mjs) is one per project, inside this process:
   * declare_scope / list_agents / send_message / check_messages are answered here (side: "server"),
   * and all Agents see the same copy. Change records are fed by the document service's commit stream
   * (when a project replica is bound, attachLink); when not bound, the page executor calculates the
   * scope and returns it with the result, recorded in dispatchTool below.
   * spawn_agent (server/agent/multi-agent.mjs) asks the page via SSE to open a new tab (agent.spawn),
   * and the page responds via POST /api/agent/spawned.
   * Scope names and unread marks on tabs are pushed to the page via the same SSE (agent.board); when
   * the page is idle, it fetches messages via POST /api/agent/inbox and sends them out.
   */
  /**
   * Current project: if a replica is bound, use the replica's project id; otherwise use the project
   * id in the mirror; if neither, '' (the local copy)
   */
  const currentProjectKey = () => {
    const b = agentBinding;
    if (b) return b.projectId;
    const id = (latestMirror())?.project?.id;
    return typeof id === 'string' ? id : '';
  };
  let lastTabs = [];
  let presenceBridge = null;
  let boardPushTimer = null;
  const pushBoard = () => {
    if (boardPushTimer) return;
    boardPushTimer = setTimeout(() => {
      boardPushTimer = null;
      if (!editorRes) return;
      try { editorRes.write(`data: ${JSON.stringify({ type: 'agent.board', agents: board().snapshot() })}\n\n`); } catch { /* Page is gone */ }
    }, 50);
  };
  const boards = createAgentBoards(() => ({
    labelOf: agentLabelOf,
    // Recipient is with another member of the shared project: forwarded via document service
    // (A3 phase 2; cannot forward when project replica is not bound or document service is legacy)
    forwardRemote: (msg) => presenceBridge?.forward(msg) ?? false,
    infoOf: (key) => {
      const e = agentSessions.get(key);
      return { role: e.role, roleName: e.role && e.role !== 'main' ? loadRole(e.role)?.name ?? null : null, parent: e.parent };
    },
  }));
  const boardKeys = new Set        ();
  /**
   * Bulletin board for the current project; subscribe when first used (push to page when changed)
   * and backfill tabs recently reported by the page
   */
  function board() {
    const key = currentProjectKey();
    const b = boards.boardFor(key);
    if (!boardKeys.has(key)) {
      boardKeys.add(key);
      b.subscribe(() => { if (currentProjectKey() === key) pushBoard(); });
      if (lastTabs.length) b.setTabs(lastTabs);
    }
    return b;
  }
  let spawnSeq = 0;
  const spawnWaiters = new Map                                                                                                     ();
  /** Ask the page to open a subagent tab and wait for its response (8 seconds) */
  function openAgentTab(spec) {
    return new Promise((resolve, reject) => {
      if (!editorRes) return reject(new Error('The editor is not open, so there is no tab to open'));
      const reqId = `s${++spawnSeq}`;
      const timer = setTimeout(() => {
        spawnWaiters.delete(reqId);
        reject(new Error('The page did not open a tab within 8 seconds'));
      }, 8_000);
      spawnWaiters.set(reqId, { resolve, reject, timer });
      editorRes.write(`data: ${JSON.stringify({ type: 'agent.spawn', reqId, ...spec })}\n\n`);
    });
  }
  const multiAgent = createMultiAgent({
    sessions: agentSessions,
    board,
    openTab: openAgentTab,
    projectCreativity: () => currentProjectCreativity(),
  });

  function callToolInternal(toolIn, args, agent, callId) {
    // Tools that modify the user interface have been renamed (`user_interface_` prefix,
    // server/tools/ui-names.mjs): old chat history still contains old names; when the model calls an
    // old name, execute as usual.
    // From here down (tool table, allowlist, gates, events), always use new names; convert back to the
    // old internal operation names when sending to the page
    const tool = modelToolName(toolIn);
    return toolCallScope.run({ callId: typeof callId === 'string' ? callId : undefined }, () => callToolScoped(tool, args, agent, callId));
  }

  /**
   * Execution of tools operating on the initiator's interface in account mode: initiator and
   * initiating page are only obtained from the execution authorization confirmed by the document
   * service (verified in provider); tool parameters are not recognized
   */
  async function callAccountInitiatorTool(tool, args, agent, callId) {
    try {
      // The two collection login tools are executed by the collection instance (it prompts the
      // initiator's computer to open a login window via the same reverse channel)
      if (accountTools.familyOf?.(tool) === 'collect') {
        const hosted = hostedContext(agent);
        if (hosted?.has(tool)) return await hosted.call(tool, args, {});
        return initiatorUnreachable(tool);
      }
      return await accountTools.call(tool, args, { callId });
    } catch (err) {
      // Authorization missing, internal channel unavailable, or invalid parameters: truthfully state
      // that this step was not completed; do not fall back to alternative approaches
      const code = typeof err?.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(err.code) ? err.code : 'unavailable';
      agentLog('agent.page.failed', { tool, code });
      return { ok: false, cloudUnavailable: true, code, error: `${tool} did not succeed this time: the channel from the cloud to the initiator's page is unavailable right now (${code}). Continue based on the project content; do not wait.` };
    }
  }

  async function callToolScoped(tool, args, agent, callId) {
    const { tools } = await import(new URL('../../mcp-tools.mjs', import.meta.url).href);
    const toolDef = tools.find((t) => t.name === tool);

    if (!toolDef) {
      const err = new Error('Unknown tool');
      (err).code = 'UNKNOWN_TOOL';
      throw err;
    }

    /*
     * Allowlist for the hosted tier (server/agent/service/cloud-tools.mjs, contract section 9): execute
     * nothing for tools not on the list, explicitly return "Temporarily unsupported in the cloud".
     * Tools reading page state answer according to snapshots when the message was sent; if the
     * initiator is not online, state it plainly and do not wait (contract section 9.4).
     */
    if (HOSTED) {
      const open = checkCloudTool(tool, accountProvided);
      if (!open.ok) {
        agentLog('agent.cloud-unavailable', { tool });
        return open;
      }
      // For viewing frames (contract section 9.8): explicitly state if this node has no configured
      // interface for viewing frames; asset shot montages are executed by the mediaFrames provider when
      // available in account mode
      if (CLOUD_LOOK_TOOLS.has(tool)) {
        const isMediaFrames = tool === 'see_frames' && (args?.source === 'media' || (args?.source === undefined && typeof args?.mediaId === 'string'));
        if (isMediaFrames) {
          if (!accountProvided?.has('see_frames')) return lookSourceUnavailable();
          const mediaArgs = args?.source === 'media' ? args : { ...args, source: 'media' };
          return await callToolChecked(tool, toolDef, mediaArgs, agent, callId);
        }
        if (tool === 'get_gif' && accountProvided?.has('get_gif')) {
          await hostedContext(agent || '')?.refreshCards().catch(() => {});
          return await callToolChecked(tool, toolDef, args, agent, callId);
        }
        if (!prerenderPost) return lookUnavailable(tool);
        if (tool === 'see_frames' && args?.source !== undefined && args.source !== 'timeline') return lookSourceUnavailable();
        // First list this project's card source table to the latest version (the render service uses it
        // to decide whether to use isolated worker processes and which version of the card to wait for)
        await hostedContext(agent || '')?.refreshCards().catch(() => {});
        return cloudLookResult(tool, await callToolChecked(tool, toolDef, args, agent, callId));
      }
      // get_selection in Account-v2 uses doc's authoritative query of all-member selections. Remaining
      // page tools still act on the initiator's page; get_selection for local/LAN keeps the original page
      // channel.
      // The other four (web takeover, two QR code logins, opening subagent tabs) return "Initiator is
      // offline" when offline, and return the reason why it cannot be done when online
      if (CLOUD_INITIATOR_TOOLS.has(tool)) {
        if (env.accountMode === true && tool === 'get_selection') return hostedAccountSelection(agent || '');
        if (accountProvided?.has(tool)) return callAccountInitiatorTool(tool, args, agent || '', callId);
        if (CLOUD_PAGE_TOOLS.has(tool)) return hostedPageTool(tool, args, agent || '');
        if (!hostedInitiatorOnline(agent || '')) return initiatorOffline(tool);
        return initiatorUnreachable(tool);
      }
      // This project's own user cards: list once (fetch body only when changed); subsequent level
      // determination and registration upon entering lock both use them
      await hostedContext(agent || '')?.refreshCards().catch(() => {});
      // Three cut-switching tools requiring the playhead: execute as usual when the initiator is
      // offline, recording the playhead as 0, and note this in the result (contract section 9.4)
      if (CLOUD_PLAYHEAD_TOOLS.has(tool) && !hostedInitiatorOnline(agent || '')) {
        const out = await callToolChecked(tool, toolDef, args, agent, callId);
        return out && typeof out === 'object' && !Array.isArray(out) && out.ok !== false
          ? { ...out, initiatorOffline: true, note: 'The initiator is offline; the playhead is taken as 0.' }
          : out;
      }
    }
    return callToolChecked(tool, toolDef, args, agent, callId);
  }

  /**
   * Second half of the main tool invocation entry point: gates and execution (desktop tier reaches
   * here directly; hosted tier first passes the allowlist above)
   */
  async function callToolChecked(tool, toolDef, args, agent, callId) {

    /*
     * Read-only lock when the review loop runs via CLI (set by runners/cli-loop.mjs via setToolAccess).
     *
     * CLI MCP is registered globally, and tools cannot be reduced on a per-round basis, so they can
     * only be intercepted at the execution entry point: reviewer / judger rounds only permit the
     * read-only list, and reflection rounds permit none. The lock is global to this server: write
     * operations sent from other chat pages during those few locked minutes will also be blocked, which
     * is intentional: projects currently being inspected by reviewer should not be modified
     * concurrently.
     */
    if (loopToolLock && !loopToolLock.has(tool)) {
      return {
        ok: false,
        error: loopToolLock.size
          ? `This turn of the review loop is read-only: ${tool} cannot be used in this turn. Only ${[...loopToolLock].join(', ')} can be used.`
          : `This turn of the review loop calls no tools, so ${tool} was rejected. Answer in text only.`,
      };
    }

    /*
     * SKILL mode gate (server/skill-gate.mjs), intercepts by caller type (A4): registered desktop app
     * sessions do nothing when SKILL mode is off, whereas Agents in the AI panel are not governed by
     * it. **Intercepted before execution**: switching back to Classic mode revokes the desktop app's
     * hand, and the session there might be running mid-way unaware; rolling back after execution cannot
     * clean up cleanly. Invocations that are unregistered and report no identity are treated as
     * unknown and not intercepted.
     */
    if (!HOSTED) { // Cloud nodes have no desktop app sessions and no SKILL mode
      const callerEntry = agentSessions.get(agent);
      const gate = await import(new URL('../../skill-gate.mjs', import.meta.url).href);
      const verdict = gate.checkGate(tool, callerEntry.registeredAt ? callerEntry.type : 'unknown');
      if (!verdict.ok) return { ok: false, skillClosed: true, error: verdict.message, message: verdict.message };
    }

    /*
     * Plug loopholes (plan agent-workflow-plan.md A1): if set_project_meta contains fields undeclared
     * in the schema, reject the entire request.
     * The implementation layer (src/mcp/handlers/project.ts) also blocks it; this is a common gate for
     * both entry points.
     */
    const strict = await import(new URL('../strict-args.mjs', import.meta.url).href);
    const unknownArgs = strict.undeclaredArgs(tool, toolDef, args);
    if (unknownArgs.length) return { ok: false, error: strict.undeclaredArgsError(tool, toolDef, unknownArgs) };

    /*
     * Creativity level gate (server/agent/creativity-gate.mjs, lookup table is there). The effective
     * level for this chat:
     * Chats in the AI panel take their own override value, falling back to the project if none; desktop
     * app sessions (unregistered chat IDs) follow the project. Intercept before execution.
     */
    const creativityGate = await import(new URL('../creativity-gate.mjs', import.meta.url).href);
    const { level: creativity, source: creativitySource } = agentSessions.creativityOf(agent, currentProjectCreativity());
    const allowed = creativityGate.checkCreativity(tool, args, creativity, { cardExists: userCardExists, source: creativitySource });
    if (!allowed.ok) {
      agentLog('agent.creativity-denied', { tool, agent: agent || '', ...allowed.creativity });
      return { ok: false, error: allowed.error, creativity: allowed.creativity };
    }
    agentSessions.touch(agent);

    /*
     * Bound to project replica (C6.5): delegate to server/agent/agent-side.mjs: emit an event before
     * and after each tool call (D2, with callId); side: "agent" executes on the replica (D1 / D4),
     * "page" via the page, and "server" in place (runServerTool).
     * Not bound: same as before, no events emitted.
     */
    /*
     * Multi-Agent (A3): wrap a layer: during invocation, the bulletin board knows "who is running what
     * tool"; after invocation, put what needs to be told to it (messages sent to it by other Agents,
     * others modifying scopes it declared, its writes being overwritten, it writing into scopes declared
     * by others) into the result, with notice first.
     */
    return multiAgent.wrap(agent || '', tool, async () => {
      const binding = agentBinding;
      if (binding) return binding.side.callTool(tool, args, { agent: agent || '', callId });
      // Replica not bound: writes execute via the page, and which clips were written is unknown here;
      // notify based on clips named in parameters (when bound, computed in agent-side from actual writes)
      try {
        const out = await dispatchTool(tool, args, agent, toolDef);
        return annotateResult(out, { userEditing: userEditingFor({ tool, args, editing: userEditingBoard.current() }) });
      } catch (err) {
        throw annotateError(err, userEditingFor({ tool, args, editing: userEditingBoard.current() }));
      }
    });
  }

  async function dispatchTool(tool, args, agent, toolDef) {
    /*
     * Read / render tools execute in place when mirrors exist, querying the prerender process
     * directly without going through the editor page (see runMirroredTool above).
     * Those returning undefined (no mirror, asset montages, etc.) go through the bridge as usual.
     */
    const mirrored = await runMirroredTool(tool, args, toolDef);
    if (mirrored !== undefined) return mirrored;
    if (toolDef.side === 'server') return runServerTool(tool, args, agent);
    const out = await callEditorPage(tool, args, agent, toolDef.timeoutMs || 60000);
    // When not connected to document service, bulletin board change records are recorded here: page
    // executor calculates which "cut->track" entries were modified and returns them with the response (A3)
    if (Array.isArray(out?.scopes) && out.scopes.length && !agentBinding) board().noteChange(agent || '', tool, out.scopes);
    if (out.ok) return out.result || out;
    throw new Error(out.error);
  }

  /** Tools with side: "server" (do not touch projects, do not go through browser bridge) */
  async function runServerTool(tool, args, agent) {
    // The five multi-Agent tools (A3): bulletin board and launching subagents, answered in this process
    if (multiAgent.isTool(tool)) return multiAgent.handle(tool, args, agent || '');

    /*
     * Tools with side: "server" execute in place and do not go through the browser bridge.
     *
     * Currently only wait. It is purely "sleeping for a while", with no reason to take a pass through
     * the editor: and this way, even if the bridge is busy at this moment, waiting between polling will
     * not fail.
     * The SKILL gate above still governs it (when the user revokes control, even waiting should not
     * continue).
     */
    {
      if (tool === 'wait') {
        // Only recognize genuine numbers: Number(null) is 0, Number('') is also 0; relying on isFinite
        // treats "not filled" as "filled 0" and clamps it to 1 second: that is not the user's intent, the
        // default should be 3 seconds
        const raw = (args)?.seconds;
        const secs = typeof raw === 'number' && Number.isFinite(raw)
          ? Math.min(30, Math.max(1, raw))
          : 3;
        await new Promise((r) => setTimeout(r, secs * 1000));
        return { ok: true, waited: secs };
      }
      if (tool === 'report_progress') {
        // Progress reports only undergo validation and normalization; the UI directly reads input in the
        // tool_call event.
        const { validateProgressReport } = await import(new URL('../../progress-report.mjs', import.meta.url).href);
        const checked = validateProgressReport(args);
        if (!checked.ok) {
          return { ok: false, error: checked.error };
        }
        return { ok: true, message: 'Progress report recorded', report: checked.value };
      }
      return { ok: false, error: `Server tool ${tool} is not implemented` };
    }
  }

  /**
   * Execute a tool via editor page (SSE sends call, page returns via POST /api/mcp/result). Raw
   * response returned to page is { ok, result, error, opIds? }; returns ok:false on timeout.
   * `__page_state` (PAGE_STATE_TOOL in server/agent/agent-side.mjs) also takes this path: requests
   * read-only page state once from the page.
   */
  async function callEditorPage(tool, args, agent, limit) {
    if (!editorRes) {
      // Desktop app sessions hit this most often (SKILL mode keeps the editor closed by default;
      // background mode is plan A5): explain what it is and what to do
      throw new Error(`Editor is not open: no page is connected to /api/mcp/events. ${tool} has to run in the PromptCut editor; ask the user to open the editor and try again, and do not retry repeatedly.`);
    }

    const id = nextCallId++;
    // Most tools are instantaneous; slow tasks return a jobId for callers to poll, so 60 seconds is
    // sufficient.
    // The exception is see_frames: it launches a Chrome on the spot to render a frame; cold start plus
    // asset preheating may take over a minute.
    // Let tools declare their own limits rather than relaxing them for all tools: report errors early
    // when truly stuck. (limit is provided by callers per tool)
    // Keep timer handles: if not cleared after tool returns normally, each call leaves a stray timer
    // for up to tens of seconds in the event loop. Tool calls are frequent; accumulating them wastes
    // memory and wakeups.
    let timer;
    const p = new Promise     (resolve => {
      pendingCalls.set(id, (result) => { clearTimeout(timer); resolve(result); });
      timer = setTimeout(() => {
        if (pendingCalls.has(id)) {
          pendingCalls.delete(id);
          resolve({ ok: false, error: `${tool} did not return within ${Math.round(limit / 1000)} seconds; stopped waiting.` });
        }
      }, limit);
    });

    editorRes.write(`data: ${JSON.stringify({ type: 'call', id, tool: pageToolName(tool), args, agent: agent || undefined })}\n\n`);

    // When tools remaining on the page write to the project, the page response includes opIds
    // committed this time (c65-integ2 wiring); agent-side advances the version read by the chat accordingly
    return await p;
  }

  server.middlewares.use('/api/ai/chat', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    let body = '';
    let over = false;
    // 32MB: attachments carry addresses and text (ChatAttachment has no inline binary), enough for
    // whole captions and entire documents; anything larger is no longer normal input, but someone
    // flooding data through this path.
    req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 32 * 1024 * 1024, 'Request body exceeds 32MB'); });
    req.on('end', async () => {
      if (over) return;
      let hasDone = false;
      // This round on the bulletin board has started (A3): record an end regardless of how it finishes,
      // otherwise this chat remains considered "busy"
      let runBegun = false;
      let runAgentId = '';
      try {
        const runners = await getRunner();
        const data = JSON.parse(body);
        const { provider, prompt, sessionId, model, effort, fast, attachments, script, schemaCompat, deepAuto } = data;
        if (provider === 'codex') {
          const { codexAuthState, authFailureEvent } = await import('../../runners/codex-auth-state.mjs');
          const auth = codexAuthState().snapshot();
          if (auth.state !== 'normal') {
            // Before quota probes or task registration: no CLI executes known-invalid credentials.
            const event = auth.state === 'invalid' ? authFailureEvent(auth.reason) : {
              type: 'error', message: 'Codex login state needs confirmation, please log in again.', retryable: false,
              authProvider: 'codex', authReason: 'state_unknown', authGeneration: auth.revision,
            };
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.end(`data: ${JSON.stringify(event)}\n\n`);
            return;
          }
        }
        // Multi-Agent tab: chat ID for this tab. Only recognizes the session id character set;
        // treat everything else as not provided
        const agentId = typeof data.conversationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.conversationId) ? data.conversationId : '';
        runAgentId = agentId;

        let systemPrompt = '';
        try {
          systemPrompt = fs.readFileSync(new URL('../../ai-system-prompt.md', import.meta.url), 'utf-8');
        } catch {
          systemPrompt = 'System prompt missing.';
        }

        // The script is concatenated into the system prompt each round rather than mentioned once in the
        // first user message: multi-round execution easily drifts off course following intermediate results;
        // placing it in the system prompt keeps it on track.
        if (typeof script === 'string' && script.trim()) {
          systemPrompt += `\n\n## Script for this video (written by the user; follow it at every step)\n\n${script.trim()}\n\n` +
            'This is the storyline of this video. Check against it for every decision about arrangement, captions and motion graphics; ' +
            'Do not do anything that conflicts with it, and when unsure follow what the script says. Details the script does not cover are yours to decide.';
        }

        let finalPrompt = prompt;
        // List those media library items separately: provide mediaId and cardUrl usable directly by cards,
        // **do not provide disk paths**: previously each round stuffed disk paths for every asset in, yet
        // the model had no tool to read them and was repeatedly misled to read them (see src/ai/mediaRef.ts)
        const library = (attachments || []).filter((a) => a.library);
        const userFiles = (attachments || []).filter((a) => !a.library);
        if (library.length > 0) {
          const kindName = { video: 'Video', image: 'Image', audio: 'audio' };
          finalPrompt += '\n\nMedia library (already imported; use mediaId in tools, use cardUrl for references in card parameters):\n' + library.map((a) => {
            let line = `- [${kindName[a.kind] || a.kind}] ${a.name} · mediaId ${a.id} · cardUrl ${a.url}`;
            if (a.durationSec && a.kind !== 'image') line += ` · duration ${a.durationSec} seconds`;
            return line;
          }).join('\n');
        }
        // Attachments also **do not provide disk paths** (for the same reason as media library items above):
        // Agents read and write bytes via interfaces and do not read any storage directories
        // (docs/semantics/product/agent.md "Assets and artifacts"); it cannot read disk paths and will only
        // be misled to read them.
        // To cut, transcribe, or add motion graphics, first use import_media to load the "site URL" into
        // the media library (import_media tool description documents this path).
        if (userFiles.length > 0) {
          finalPrompt += '\n\nAttachments (in the chat\'s working directory, not in the media library; to cut, transcribe or add motion graphics, first pass its in-app URL to import_media to load it into the media library):\n' + userFiles.map((a) => {
            let line = `- [${a.kind === 'video' ? 'Video' : a.kind}] ${a.name} · in-app URL ${a.url}`;
            if (a.durationSec) line += ` · duration ${a.durationSec} seconds`;
            if (a.text) line += `\n\`\`\`\n${a.text}\n\`\`\``;
            return line;
          }).join('\n');
        }

        /*
         * Register this chat (server/agent/agent-sessions.mjs): override values for type, vendor, role, and
         * creativity level.
         * creativity is the level set separately for this tab; null / omitted = follows project;
         * projectCreativity is the project default on the page at this moment, used only when the server
         * cannot read the project. Register with every message: users may switch drivers or levels between
         * two messages.
         */
        if (typeof data.projectCreativity === 'string') projectCreativityHint = normalizeCreativity(data.projectCreativity);
        agentSessions.register(agentId, {
          type: provider === 'api' ? 'api' : 'cli',
          vendor: provider === 'api' ? String((await import(new URL('../../ai-config.mjs', import.meta.url).href)).publicConfig()?.api?.vendor || 'api') : String(provider || ''),
          role: 'main',
          creativity: normalizeCreativity(data.creativity),
        });
        const { level: convCreativity, source: convCreativitySource } = agentSessions.creativityOf(agentId, currentProjectCreativity());

        /*
         * Multi-Agent (A3):
         *   - Subagents launched by spawn_agent: concatenate its role prompt into the system prompt each
         *     round (after multiple rounds it is easiest to forget who it is);
         *   - Updates from other Agents (what scopes were modified, undelivered messages that reached inbox
         *     capacity) are concatenated before this round's prompt, entering only the model;
         *   - hops: which layer of automatic delivery this is (included when the page delivers another
         *     Agent's messages); the bulletin board uses this to cap cascades.
         */
        const sess = agentSessions.get(agentId);
        if (agentId && sess.parent && sess.role) {
          const role = loadRole(sess.role);
          if (role) {
            systemPrompt += `\n\n## Your role: ${role.name}\n\nYou are a sub-Agent spawned by Agent ${sess.parent} with spawn_agent, chat ID ${agentId}.` +
              'Do only the part it handed to you; start with declare_scope, report back with report_progress when done, then use send_message to tell the Agent that spawned you the result.' +
              ` You cannot spawn other Agents.\n\n${role.prompt}`;
          }
        }
        const agentNotes = agentId ? board().consumeNotes(agentId) : '';
        if (agentNotes) finalPrompt = `${agentNotes}\n\n${finalPrompt}`;
        const runHops = Number.isSafeInteger(data.hops) && data.hops > 0 ? data.hops : 0;

        const editorPort = (server.httpServer?.address())?.port || 5195;
        const editorState = editorRes ? "Editor connected" : "Not connected";
        finalPrompt += `\n\nCurrent port ${editorPort}; ${editorState}` + (agentId ? `; your Agent chat ID: ${agentId}` : '') +
          `; creativity level "${CREATIVITY_LABEL[convCreativity                                 ]}" (${convCreativitySource}): ` +
          `${CREATIVITY_HINT[convCreativity                                ]}. Tool calls above your level will be rejected; if rejected, stop and tell the user, do not work around it`;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.flushHeaders();

        const keepAlive = setInterval(() => {
          res.write(': ping\n\n');
        }, 15000);

        const mcp = {
          serverName: "promptcut",
          command: process.execPath,
          args: [fileURLToPath(new URL('../../mcp-server.mjs', import.meta.url))],
          // PROMPTCUT_CALLER=cli: this MCP is started by the AI panel, not a desktop app session
          // (mcp-server.mjs uses this to not report desktop identity)
          env: { PROMPTCUT_CALLER: 'cli', PROMPTCUT_PORT: String(editorPort), ...(agentId ? { PROMPTCUT_AGENT: agentId } : {}) }
        };

        const cwd = path.join(server.config.root, 'exports', 'ai-workspace');
        fs.mkdirSync(cwd, { recursive: true });

        const runId = Math.random().toString(36).substring(2, 9);
        res.write(`data: ${JSON.stringify({ type: 'run', runId })}\n\n`);

        const { publicConfig } = await import(new URL('../../ai-config.mjs', import.meta.url).href);
        const cfg = publicConfig();

        // Quota circuit breaker: check usage for this route first; if it exceeds the limit, do not launch
        // the CLI and tell the user the reason directly
        const { guard: quotaGuard, mod: quotaMod } = await getQuotaGuard();
        try {
          // Pass the model in together: windows like "This week (Fable)" in claude's /usage are model-specific;
          // if not running that model, do not use it to block (see decidingWindows in quota.mjs)
          await quotaGuard.gate(provider, cfg.quota, model);
        } catch (e) {
          if (e instanceof quotaMod.QuotaExceededError) {
            res.write(`data: ${JSON.stringify({ type: 'error', message: e.message, quota: e.quota })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            clearInterval(keepAlive);
            res.end();
            return;
          }
          throw e;
        }
        let replyBytes = 0;
        /*
         * D2: Emit an event when the full text reply completes (when bound to a project replica).
         * Replies form segments between tool calls; when the next tool call or the end of this round is
         * reached, the accumulated segment is sent.
         */
        let pendingText = '';
        const flushText = () => {
          const b = agentBinding;
          if (b && pendingText.trim()) b.side.executor.text(agentId, pendingText);
          pendingText = '';
        };

        if (agentId) { board().beginRun(agentId, runHops); runBegun = true; }
        const run = runners.startRun({
          provider,
          prompt: finalPrompt,
          systemPrompt,
          sessionId,
          cwd,
          // Code block space is placed under the working directory by project (server/tools/code-cache.mjs,
          // A07 2026-10-22); when no project is bound, it uses the local copy
          codeCacheDir: path.join(cwd, 'code-cache', String(currentProjectKey() || 'local').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_') || 'local'),
          codeCacheWriter: agentId || sessionId,
          // Speed records for setting single-output limits based on measured speed: on this machine, placed
          // in the same directory as ai.json (localOutputSpeedFile in runners/api.mjs)
          outputSpeedFile: 'local',
          // User-added skills: skills/ in the same directory as ai.json (localSkillsDir in runners/api.mjs)
          skillsDir: 'local',
          model,
          /*
           * Deep autonomy: the round limit is replaced with "autonomous rounds" in settings (deepAutoRounds
           * in ai.json, default 300, 0 means unlimited), and no wording regarding rounds is given to the
           * model anymore.
           *
           * The number of rounds is taken from **server configuration**, ignoring the number in the
           * request body: the frontend only sends a boolean for "whether enabled". The limit is a safety
           * valve and should not be casually overridden by a request field.
           */
          maxRounds: deepAuto ? (cfg.deepAutoRounds ?? 300) : undefined,
          deepAuto: !!deepAuto,
          // Reasoning effort and acceleration tiers: which provider supports which is translated into flags
          // by their respective runners; unsupported ones are directly ignored (the frontend has also grayed
          // out the corresponding controls)
          effort,
          fast,
          /*
           * Deep autonomy: the round limit is replaced with "autonomous rounds" in settings (deepAutoRounds
           * in ai.json, default 300, 0 means unlimited), and no wording regarding rounds is given to the
           * model anymore.
           *
           * The number of rounds is taken from **server configuration**, ignoring the number in the
           * request body: the frontend only sends a boolean for "whether enabled". The limit is a safety
           * valve and should not be casually overridden by a request field.
           */
          maxRounds: deepAuto ? (cfg.deepAutoRounds ?? 300) : undefined,
          deepAuto: !!deepAuto,
          // Parameter compatibility mode (tool schema sanitized to Gemini subset): 'auto' / 'on' / 'off',
          // only used by direct API runners
          schemaCompat,
          // Standalone toggle for review loop (only used by direct API); if omitted, follows deep autonomy,
          // see runners/api.mjs
          reviewLoop: typeof data.reviewLoop === 'boolean' ? data.reviewLoop : undefined,
          // When review loop runs via CLI, place a read-only lock on tools per turn (see callToolInternal).
          // null = unlocked
          setToolAccess: (list) => { loopToolLock = list ? new Set(list) : null; },
          toolProtocol: cfg.toolProtocol,
          mcp,
          // codex and agy check in tool calls in the output stream; /api/mcp/call claims the same callId
          // based on clues (see callPairing above)
          callPairing,
          // meta.callId: the tool_use id from the direct API path (passed in from
          // server/harness/tools/index.mjs); events include it, and the AI panel matches against it
          callTool: async (name, args, meta) => await callToolInternal(name, args, agentId || undefined, typeof meta?.callId === 'string' ? meta.callId : undefined),
          onEvent: (ev) => {
            if (ev.type === 'done' || ev.type === 'error') hasDone = true;
            if (ev.type === 'text' && typeof ev.delta === 'string') pendingText += ev.delta;
            if (ev.type === 'tool_call' || ev.type === 'done' || ev.type === 'error') flushText();
            if (ev.type === 'text' && typeof ev.delta === 'string') replyBytes += Buffer.byteLength(ev.delta, 'utf8');
            // The chat never reads a tool result's full output (get_project is the whole
            // project); sending it made the editor parse and trace megabytes per result.
            // Server-side consumers of onEvent still receive it unchanged.
            const outbound = ev.type === 'tool_result' && ev.output !== undefined ? { ...ev, output: undefined, outputOmitted: true } : ev;
            res.write(`data: ${JSON.stringify(outbound)}\n\n`);
          }
        });

        const runState = {
          abort: run.abort, finished: false, provider,
          // When a background recheck detects that limits are exceeded, write the reason to the person
          // currently viewing this chat, then kill the process
          fail: (message) => { try { res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`); } catch {} },
        };
        activeRuns.set(runId, runState);

        res.on('close', () => {
          if (!runState.finished) run.abort();
          activeRuns.delete(runId);
          clearInterval(keepAlive);
        });

        try {
          await run.done;
        } catch (e) {
          if (!res.headersSent) throw e;
          res.write(`data: ${JSON.stringify({ type: 'error', message: String(e) })}\n\n`);
        }

        runState.finished = true;
        activeRuns.delete(runId);
        clearInterval(keepAlive);
        flushText();
        // Accounting: new context this round = sent prompt + received reply. Recheck in the background upon
        // hitting the limit, and kill other chats on the same path when limits are exceeded
        const noted = quotaGuard.note(provider, Buffer.byteLength(finalPrompt, 'utf8') + replyBytes, cfg.quota, model);
        if (noted) noted.then((v) => { if (v?.blocked) failProviderRuns(provider, v.message); }).catch(() => {});
        if (!hasDone) {
           res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        }
        res.end();

      } catch (e) {
        if (!res.headersSent) {
          sendJson(res, 503, { ok: false, error: String(e) });
        } else {
          res.write(`data: ${JSON.stringify({ type: 'error', message: String(e) })}\n\n`);
          res.end();
        }
      } finally {
        if (runBegun) board().endRun(runAgentId);
      }
    });
  });

  server.middlewares.use('/api/ai/abort', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    let body = '';
    let over = false;
    req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 8192, 'Request body exceeds 8KB'); });
    req.on('end', () => {
      if (over) return;
      try {
        const { runId } = JSON.parse(body);
        const runState = activeRuns.get(runId);
        if (runState && !runState.finished) {
          runState.abort();
          runState.finished = true;
          activeRuns.delete(runId);
        }
        sendJson(res, 200, { ok: true });
      } catch(e) {
        sendJson(res, 400, { ok: false, error: String(e) });
      }
    });
  });

  server.middlewares.use('/api/mcp/events', (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });

    // There is only one in this position (editorRes); subsequent connections evict the previous one:
    // user page refreshes rely on it to take over again
    if (editorRes) {
      editorRes.write(`data: ${JSON.stringify({ type: "replaced" })}\n\n`);
      editorRes.end();
    }

    editorRes = res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();

    const port = (server.httpServer?.address())?.port || 5195;
    res.write(`data: ${JSON.stringify({ type: 'hello', port })}\n\n`);
    // Push a copy of the bulletin board's current state (scope name on the tab, unread) first (A3);
    // also push a copy of desktop app session groups (A4)
    pushBoard();
    pushDesktop();

    req.on('close', () => {
      if (editorRes === res) editorRes = null;
    });
  });

  server.middlewares.use('/api/mcp/result', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    let body = '';
    let over = false;
    // Tool results return from the page, which may contain full visuals or large blocks of text, so
    // be generous; being generous still has an upper limit.
    req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, 'Tool result exceeds 64MB'); });
    req.on('end', () => {
      if (over) return;
      try {
        const data = JSON.parse(body);
        const cb = pendingCalls.get(data.id);
        if (cb) {
          cb(data);
          pendingCalls.delete(data.id);
        }
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e) });
      }
    });
  });

  server.middlewares.use('/api/mcp/call', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    let body = '';
    let over = false;
    req.on('data', c => { if (over) return; body += c; over = overLimit(req, res, body.length, 32 * 1024 * 1024, 'Request body exceeds 32MB'); });
    req.on('end', async () => {
      if (over) return;
      try {
        const { tool, args, agent, callId, pair, caller } = JSON.parse(body);
        // callId: Claude Code brings it via MCP's _meta["claudecode/toolUseId"] (forwarded from
        // server/mcp-server.mjs); events include it
        let call = typeof callId === 'string' && callId.length <= 128 ? callId : undefined;
        /*
         * codex and agy do not carry callId, only pairing clues pair: { scope, hint? } (pairingOf in
         * mcp-server.mjs). Events are emitted only when bound to a project replica, which is when callId
         * is useful; when not bound, do not wait for pairing. If it cannot be paired, omit it, same as
         * before.
         */
        if (!call && agentBinding && pair && typeof pair.scope === 'string' && pair.scope.length <= 160) {
          call = await callPairing.claim(pair.scope, tool, args ?? {}, typeof pair.hint === 'string' && pair.hint.length <= 128 ? pair.hint : undefined);
        }
        /*
         * Desktop app sessions (A4): mcp-server.mjs reports caller { type: 'desktop', key, vendor,
         * label, client }. Register on each call (type desktop, following the project's creativity level),
         * using its key as the chat ID: write identity (document service opens connections per chat),
         * bulletin board, "user editing", and overwrite notices all distinguish by it, taking the same
         * path as Agents in the AI panel. AI panel calls carry agent, not caller.
         */
        const desk = desktopCallerOf(caller);
        const agentKey = desk ? desk.key : (typeof agent === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(agent) ? agent : undefined);
        if (desk) agentSessions.register(desk.key, { type: 'desktop', vendor: desk.vendor, label: desk.label, client: desk.client, role: null });
        const handle = desk ? desktopActivity.begin(desk.key, desk, String(tool), args) : null;
        let result;
        try {
          result = await callToolInternal(tool, args, agentKey, call);
        } catch (e) {
          if (handle) desktopActivity.end(handle, null, e);
          throw e;
        }
        if (handle) {
          desktopActivity.end(handle, result, null);
          requestSkillPreview(String(tool), args, result);
        }
        sendJson(res, 200, { ok: true, result });
      } catch (e) {
        if (e.code === 'UNKNOWN_TOOL') {
          sendJson(res, 404, { ok: false, error: e.message });
        } else {
          sendJson(res, 200, { ok: false, error: e.message });
        }
      }
    });
  });

  /*
   * C6.5 Project replica on the Agent server (see bindAgent above). After the page (c65-editor)
   * connects to the document service:
   *   POST /api/agent/bind   { projectId, mode?: "local" | "lan-host" | "ticket", url? } → { ok, projectId, mode, url }
   *   POST /api/agent/unbind {} → { ok } (when switching projects or disconnecting from document service)
   *   POST /api/agent/ticket { reqId, ticket? , error? } → returns connection ticket requested by { type: "agent.ticket" } in SSE
   *   GET  /api/agent/status → whether bound, version read by each chat, replica version (diagnostics)
   */
  const readJsonBody = (req, res, max, onBody) => {
    let body = '';
    let over = false;
    req.on('data', (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, max, `Request body exceeds ${max} bytes`); });
    req.on('end', () => {
      if (over) return;
      let data;
      try { data = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'Request body is not JSON' }); }
      onBody(data);
    });
  };
  server.middlewares.use('/api/agent/bind', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    readJsonBody(req, res, 8192, async (data) => {
      try {
        const b = await bindAgent(data);
        sendJson(res, 200, { ok: true, projectId: b.projectId, mode: b.mode, url: b.url });
      } catch (e) { sendJson(res, 400, { ok: false, error: e?.message || String(e) }); }
    });
  });
  server.middlewares.use('/api/agent/unbind', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    readJsonBody(req, res, 8192, () => { unbindAgent('page'); sendJson(res, 200, { ok: true }); });
  });
  server.middlewares.use('/api/agent/ticket', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    readJsonBody(req, res, 8192, (data) => {
      const w = typeof data?.reqId === 'string' ? ticketWaiters.get(data.reqId) : undefined;
      if (!w) return sendJson(res, 404, { ok: false, error: 'Nothing is waiting for this ticket' });
      ticketWaiters.delete(data.reqId);
      clearTimeout(w.timer);
      if (typeof data.ticket === 'string' && data.ticket.length > 0 && data.ticket.length <= 2048) w.resolve(data.ticket);
      else w.reject(new Error(typeof data.error === 'string' ? `Page failed to sign a ticket: ${data.error}` : 'Ticket returned by the page is invalid'));
      sendJson(res, 200, { ok: true });
    });
  });
  /*
   * "User editing" (A2):
   *   POST /api/agent/editing { session, entities: [{ clipId, kind: "drag" | "text" | "recent", remainingMs? }] } → { ok, count }
   *     Full state pushed by editor page (src/editor/userEditing.ts), pushed on change (throttled),
   *     renewed via heartbeat when non-empty;
   *   GET  /api/agent/editing → { ok, entities } (diagnostics, probe)
   */
  server.middlewares.use('/api/agent/editing', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, entities: userEditingBoard.current() });
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET / POST only' });
    readJsonBody(req, res, 64 * 1024, (data) => {
      try {
        const count = userEditingBoard.report(data?.session, data?.entities);
        sendJson(res, 200, { ok: true, count });
      } catch (e) { sendJson(res, 400, { ok: false, error: e?.message || String(e) }); }
    });
  });
  /*
   * Multi-Agent (A3):
   *   POST /api/agent/tabs    { tabs: [{ conversationId, title, busy }] } → { ok }
   *     Page tabs (full set), used by bulletin board list and concurrency quota
   *   POST /api/agent/inbox   { conversationId, onlyAuto? } → { ok, messages }
   *     When page is idle, fetches messages sent to this tab to emit as a user message
   *   POST /api/agent/spawned { reqId, ok, error? } → { ok }
   *     Page finished opening (or failed to open) tab requested by spawn_agent
   *   GET  /api/agent/board → { ok, agents, list }
   *     Diagnostics, probe
   */
  server.middlewares.use('/api/agent/tabs', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    readJsonBody(req, res, 64 * 1024, (data) => {
      lastTabs = Array.isArray(data?.tabs) ? data.tabs.slice(0, 64) : [];
      board().setTabs(lastTabs);
      sendJson(res, 200, { ok: true });
    });
  });
  server.middlewares.use('/api/agent/inbox', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    readJsonBody(req, res, 8192, (data) => {
      const key = typeof data?.conversationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(data.conversationId) ? data.conversationId : null;
      if (!key) return sendJson(res, 400, { ok: false, error: 'conversationId is invalid' });
      const b = board();
      b.markSeen(key);
      sendJson(res, 200, { ok: true, messages: b.takeInbox(key, data?.onlyAuto !== false) });
    });
  });
  server.middlewares.use('/api/agent/spawned', (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    readJsonBody(req, res, 8192, (data) => {
      const w = typeof data?.reqId === 'string' ? spawnWaiters.get(data.reqId) : undefined;
      if (!w) return sendJson(res, 404, { ok: false, error: 'Nothing is waiting for this tab' });
      spawnWaiters.delete(data.reqId);
      clearTimeout(w.timer);
      if (data.ok === true) w.resolve();
      else w.reject(new Error(typeof data.error === 'string' ? data.error.slice(0, 300) : 'Page failed to open a tab'));
      sendJson(res, 200, { ok: true });
    });
  });
  server.middlewares.use('/api/agent/board', (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    res.setHeader('Cache-Control', 'no-store');
    const b = board();
    sendJson(res, 200, { ok: true, project: currentProjectKey(), agents: b.snapshot(), list: b.listRaw(''), sessions: agentSessions.list(), changes: b._changes().slice(-50) });
  });
  /*
   * Desktop app session groups (A4): GET /api/agent/desktop → { ok, sessions } (fetched once when
   * the page connects, then receives SSE's agent.desktop; probe also reads it). Each session: id,
   * vendor, ongoing operations, recent calls, submitted progress reports, as well as type in the
   * registry and effective creativity level.
   */
  server.middlewares.use('/api/agent/desktop', (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    res.setHeader('Cache-Control', 'no-store');
    const level = currentProjectCreativity();
    const sessions = desktopActivity.snapshot().map((s) => {
      const c = agentSessions.creativityOf(s.id, level);
      return { ...s, type: c.entry.type, creativity: c.level };
    });
    sendJson(res, 200, { ok: true, sessions });
  });
  server.middlewares.use('/api/agent/status', (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    res.setHeader('Cache-Control', 'no-store');
    const b = agentBinding;
    sendJson(res, 200, b ? { ok: true, bound: true, mode: b.mode, url: b.url, ...b.side.describe(), presence: presenceBridge?.describe() ?? null, editing: userEditingBoard.describe() } : { ok: true, bound: false });
  });

  server.middlewares.use('/api/mcp/status', (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    const port = (server.httpServer?.address())?.port || 5195;
    let activeRunCount = 0;
    for (const st of activeRuns.values()) if (!st.finished) activeRunCount++;
    sendJson(res, 200, {
      editorConnected: !!editorRes,
      pending: pendingCalls.size,
      /*
       * How many chat rounds are still running. The patch script (desktop/scripts/apply-patch.ps1)
       * relies on this to decide whether to intercept: the patch will overwrite the entire runtime/app,
       * and when an overwrite happens right under a dev server currently serving pages, the agent side
       * **will not crash, only go mute**: loops in Node run as usual, requests to the model are sent as
       * usual, but every HTTP request sent by the page (tool result returns, frame viewing, reading card
       * source code) hangs completely until the service restarts. The symptom is a series of inexplicable
       * tool timeouts with no traceable cause.
       */
      activeRuns: activeRunCount,
      port
    });
  });

  /*
   * ---------------- Hosted tier (contract cloud-agent-contract.md sections 2, 3, 9) ----------------
   *
   * There is no page channel on cloud nodes: chats do not go through /api/ai/chat; the host
   * (create-agent-service.mjs) calls startHostedRun to start a round, handing events to the host to
   * record before sending; a round is independent of the connection that initiated it. Page state
   * consists only of the snapshot provided by the page when sending the message.
   */
  /** Chat id → page state { t, selection } provided by the page when sending this round's message */
  const hostedPageStates = new Map();

  /**
   * "Initiator online": an event stream from the member who initiated this round is currently
   * connected to this chat (determined by the host, contract section 9.4)
   */
  function hostedInitiatorOnline(agent) {
    try { return env.initiatorOnline ? env.initiatorOnline(agent) === true : false; } catch { return false; }
  }

  /**
   * Hosted tier's "execute via page": only answers read-only page state, cannot do anything else.
   * The playhead responds according to the snapshot from when **the chat requesting it** sent its
   * message (`ctx.pageStateFor`, chat id brought by `agent-side.mjs`): if the same member opens
   * two chats simultaneously, each uses its own; if the initiator is offline, or that message did
   * not carry a snapshot, treat as 0.
   */
  async function hostedCallPage(tool, args, ctx) {
    if (tool === '__page_state') {
      const agent = typeof ctx?.pageStateFor === 'string' ? ctx.pageStateFor : '';
      const t = hostedInitiatorOnline(agent) ? Number(hostedPageStates.get(agent)?.t) : 0;
      return { result: { t: Number.isFinite(t) ? t : 0 }, opIds: [] };
    }
    // Provider tools created in this process (account mode): hand over to them. The request id uses
    // this tool call's call number, and committed writes are recorded on this call's event context
    if (accountProvided?.has(tool)) {
      return { result: await accountTools.call(tool, args, { callId: toolCallScope.getStore()?.callId, track: ctx?.track }), opIds: [] };
    }
    // Tools implemented separately on the server (import media, create/edit cards, voiceover): hand
    // over to hosted-tools.mjs; committed writes are recorded on this call's event context
    const hosted = hostedContext(typeof ctx?.agent === 'string' ? ctx.agent : '');
    if (hosted?.has(tool)) return { result: await hosted.call(tool, args, ctx?.track), opIds: [] };
    throw new Error(`This version of the Cloud Agent cannot use ${tool} yet: it has to run in the editor.`);
  }

  /**
   * State shared across chats in the instance (this project's card source code table); null when
   * there is no hosted-tools (only for tests that do not touch these tools)
   */
  const hostedShared = HOSTED && env.hostedTools ? env.hostedTools.newSharedState() : null;
  /** Chat id → tool context for this chat (workspace and document service requests are per chat) */
  const hostedContexts = new Map();
  /** Chat id → id of the currently running round (used for usage tracking) */
  const hostedRunIds = new Map();
  function hostedContext(agent) {
    if (!HOSTED || !env.hostedTools || !hostedShared || !agent) return null;
    let ctx = hostedContexts.get(agent);
    if (!ctx) {
      ctx = env.hostedTools.forConversation({
        identity: { projectId: env.projectId, userId: env.identity?.userId ?? '', username: env.identity?.username ?? '' },
        ownerKey: env.ownerKey,
        conversationId: agent,
        side: () => agentBinding.side,
        host: async () => {
          const { loadSsrHost } = await import(new URL('../ssr-host.mjs', import.meta.url).href);
          return loadSsrHost((id) => server.ssrLoadModule(id), { apiBase: 'http://agent-service.invalid' });
        },
        pageState: () => {
          const online = hostedInitiatorOnline(agent);
          const t = Number(hostedPageStates.get(agent)?.t);
          return { online, t: online && Number.isFinite(t) ? t : 0 };
        },
        runId: () => hostedRunIds.get(agent) ?? null,
        shared: hostedShared,
        // Card audio: card code is handed to the render service on the same machine to execute (the same
        // endpoint as frame viewing); null when no node is configured
        look: () => prerenderPost ?? null,
        // Account mode: "project assets" for this task (read/write this project's assets via task
        // authorization). When omitted, those asset tools continue using member tickets as usual
        ...(env.accountMode === true && env.accountRunAssets ? { runAssets: env.accountRunAssets } : {}),
        // Account mode: collection delegation endpoint for this round (sites requiring login are
        // downloaded by the initiator's computer; `collect-bridge.mjs`). If not created, do not provide
        // it; collection is still performed anonymously in the cloud as usual
        ...(accountTools && typeof accountTools.collectDelegate === 'function' ? { collectDelegate: () => accountTools.collectDelegate() } : {}),
      });
      hostedContexts.set(agent, ctx);
    }
    return ctx;
  }

  /*
   * "Whether this round is running" (contract section 5): the instance connection remains connected
   * after a round ends until idle reclamation; the member list cannot assume "Agent is running" just
   * from being "connected". When a round is running, attach a `cloud-run` entry to presence via the
   * instance's own connection (with an expiration time, periodically renewed), removed when the last
   * round ends; the page uses it to mark "Offline, Agent running" and counts it toward the Agent count.
   * Failure to send (legacy document service) does not affect this round.
   */
  const RUN_PRESENCE_TTL_MS = 90_000;
  let hostedRunning = 0;
  let runPresenceTimer = null;
  function publishRunPresence() {
    const side = agentBinding?.side;
    if (!side) return;
    const message = hostedRunning > 0
      ? { type: 'presence.set', key: 'cloud-run', ttlMs: RUN_PRESENCE_TTL_MS, data: { v: 1, kind: 'cloud-run', runs: hostedRunning } }
      : { type: 'presence.clear', key: 'cloud-run' };
    void side.executor.request('', message, (m) => m.type === 'presence.ok' || m.type === 'error').catch(() => {});
  }
  function noteRun(delta) {
    hostedRunning = Math.max(0, hostedRunning + delta);
    publishRunPresence();
    if (hostedRunning > 0 && !runPresenceTimer) {
      runPresenceTimer = setInterval(publishRunPresence, Math.round(RUN_PRESENCE_TTL_MS / 3));
      runPresenceTimer.unref?.();
    } else if (hostedRunning === 0 && runPresenceTimer) {
      clearInterval(runPresenceTimer);
      runPresenceTimer = null;
    }
  }

  /**
   * Local/LAN `get_selection` and page control tools are still executed via the reverse channel.
   * Arguments are first checked against the same rules as on this machine (required, `seek`'s `t` is
   * a finite number ≥ 0); those not complying are not sent to the page. If executed by the page:
   * return the result it delivered back (same implementation and shape as on this machine); after
   * `seek` succeeds, update the playhead recorded for this chat to the new value (used later by tools
   * that switch cuts). If that page is absent (not connected, timed out, disconnected while waiting,
   * or legacy page lacks reverse channel): `get_selection` falls back to the snapshot from when the
   * message was sent if this member still has other windows connected and viewing (noted as a
   * snapshot); otherwise, like the other three, it returns "Initiator offline".
   */
  async function hostedAccountSelection(agent) {
    const scope = env.accountSelection;
    const binding = agentBinding;
    const unavailable = reason => {
      agentLog('agent.selection.unavailable', { reason });
      return { ok: false, code: 'selection-unavailable', error: 'The current project selection is unavailable.' };
    };
    if (!scope || typeof scope.projectId !== 'string' || typeof scope.conversationId !== 'string' ||
        typeof scope.runId !== 'string' || typeof scope.runGrantId !== 'string' || !scope.runGrantId ||
        agent !== scope.conversationId || hostedRunIds.get(agent) !== scope.runId ||
        binding?.projectId !== scope.projectId || binding.mode !== 'hosted') return unavailable('run-binding');
    let reply;
    try {
      reply = await binding.side.executor.request(agent, {
        type: 'selection.query', projectId: scope.projectId, runGrantId: scope.runGrantId,
      }, (message) => message?.type === 'selection.state' || message?.type === 'error');
    } catch { return unavailable('doc-request'); }
    // An old response cannot be consumed by a later run or a rebound project.
    if (agentBinding !== binding || hostedRunIds.get(agent) !== scope.runId ||
        reply?.type !== 'selection.state' || reply.projectId !== scope.projectId ||
        !Number.isSafeInteger(reply.projectRev) || !Number.isSafeInteger(reply.presenceRevision) ||
        !Array.isArray(reply.members) || !Number.isSafeInteger(reply.queriedAt) ||
        reply.members.some(member => typeof member?.accountId !== 'string' ||
          typeof member.username !== 'string' || typeof member.displayName !== 'string' ||
          typeof member.isInitiator !== 'boolean' || !Array.isArray(member.pages) ||
          member.pages.some(page => typeof page?.pageId !== 'string' ||
            typeof page.live !== 'boolean' || !Array.isArray(page.selection?.clipIds) ||
            !Array.isArray(page.items)))) return unavailable(reply?.type === 'error' ? 'doc-denied' : 'doc-reply');
    const { type: _type, reqId: _reqId, ...state } = reply;
    return { ok: true, ...state };
  }

  async function hostedPageTool(tool, args, agent) {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    // What is sent to the page are legacy internal operation names (seek / play / pause): legacy pages
    // recognize them as usual
    const wire = pageToolName(tool);
    if (wire === 'seek' && !(typeof a.t === 'number' && Number.isFinite(a.t) && a.t >= 0)) {
      // When no one is connected and viewing, report offline first (what the Agent should know is "this
      // step cannot use the page", rather than retrying with filled-in parameters)
      if (!hostedInitiatorOnline(agent)) return initiatorOffline(tool);
      return { ok: false, error: `${tool} needs t (seconds, a number not less than 0).` };
    }
    const send = wire === 'seek' ? { t: a.t } : {};
    let out = null;
    try { out = env.pageCall ? await env.pageCall(agent, wire, send) : null; } catch { out = null; }
    if (out?.ok === true && out.result && typeof out.result === 'object') {
      const r = out.result;
      if (r.ok !== true) return { ok: false, error: String(r.error || `${tool} did not succeed on the initiator's page`) };
      if (wire === 'seek') {
        const ps = hostedPageStates.get(agent);
        hostedPageStates.set(agent, { ...(ps && typeof ps === 'object' ? ps : {}), t: a.t });
      }
      if (tool === 'get_selection') return r.result ?? null;
      return r.result && typeof r.result === 'object' ? r.result : { ok: true };
    }
    agentLog('agent.page.offline', { tool, why: out?.why ?? 'none' });
    if (CLOUD_PAGE_STATE_READS.has(tool)) return hostedPageRead(tool, agent);
    return initiatorOffline(tool);
  }

  /** Fallback path of get_selection for legacy page channels; account-v2 will not reach here. */
  function hostedPageRead(tool, agent) {
    const ps = hostedPageStates.get(agent) ?? null;
    const online = hostedInitiatorOnline(agent);
    if (!online || !ps || !Array.isArray(ps.selection)) {
      return initiatorOffline(tool);
    }
    const ids = ps.selection.filter((x) => typeof x === 'string').slice(0, 200);
    const project = agentBinding?.side?.link?.replica?.project;
    const clips = [];
    for (const tr of project?.tracks ?? []) {
      for (const c of tr.clips ?? []) if (ids.includes(c.id)) clips.push({ ...c, trackId: tr.id });
    }
    return { ok: true, ids, clips, note: 'This is the selection at the time the user sent this message; the page may have changed since.' };
  }

  /**
   * Start a round (hosted tier). Only uses direct API; tools follow open manifest; does not enable
   * deep autonomy or review loop (contract section 9.3).
   * @param {object} o `{ runId, conversationId, prompt, model?, effort?, creativity?, script?, library?, pageState?,
   *   apiConfig, historyFile, sessionKey?, fetchImpl?, onEvent }`
   * @returns {{ runId: string, abort(): void, done: Promise<void> }}
   */
  function startHostedRun(o) {
    const agentId = String(o.conversationId);
    if (env.accountMode === true && env.accountSelection &&
        (o.runId !== env.accountSelection.runId || agentId !== env.accountSelection.conversationId ||
          agentBinding?.projectId !== env.accountSelection.projectId))
      throw Object.assign(new Error('account run binding mismatch'), { code: 'run-record-mismatch' });
    let aborted = false;
    let inner = null;
    const activeTools = new Set();
    const emit = (ev) => { try { o.onEvent(ev); } catch { /* Host responsibility */ } };
    const done = (async () => {
      const binding = agentBinding;
      if (!binding) {
        emit({ type: 'error', code: 'unavailable', message: 'The Cloud Agent for this project is not yet connected to the document service, please try again later.' });
        return;
      }
      let systemPrompt = '';
      try {
        systemPrompt = fs.readFileSync(new URL('../../ai-system-prompt.md', import.meta.url), 'utf-8');
      } catch {
        systemPrompt = 'System prompt missing.';
      }
      // mediaFrames must be passed separately: `see_frames` has no provider field in the tool table, and
      // `provided` filtering will drop it. Use the same condition as the actual dispatch below (the
      // `isMediaFrames` branch), lest prompt descriptions diverge from actual capabilities
      systemPrompt += `\n\n${cloudSystemNote({ look: !!prerenderPost, provided: accountProvided, collectDelegate: accountTools?.delegateDownload?.() === true, mediaFrames: !!accountProvided?.has('see_frames') })}`;
      if (typeof o.script === 'string' && o.script.trim()) {
        systemPrompt += `\n\n## Script for this video (written by the user; follow it at every step)\n\n${o.script.trim()}\n\n` +
          'This is the storyline of this video. Check against it for every decision about arrangement, captions and motion graphics; ' +
          'Do not do anything that conflicts with it, and when unsure follow what the script says. Details the script does not cover are yours to decide.';
      }
      let finalPrompt = String(o.prompt ?? '');
      const library = Array.isArray(o.library) ? o.library.filter((a) => a && typeof a === 'object').slice(0, 500) : [];
      if (library.length > 0) {
        const kindName = { video: 'Video', image: 'Image', audio: 'audio' };
        finalPrompt += '\n\nMedia library (already imported; use mediaId in tools, use cardUrl for references in card parameters):\n' + library.map((a) => {
          let line = `- [${kindName[a.kind] || a.kind}] ${a.name} · mediaId ${a.id} · cardUrl ${a.url}`;
          if (a.durationSec && a.kind !== 'image') line += ` · duration ${a.durationSec} seconds`;
          return line;
        }).join('\n');
      }
      const ps = o.pageState && typeof o.pageState === 'object' ? o.pageState : null;
      hostedPageStates.set(agentId, ps);
      // Attachments: only recognize files that actually exist in this chat's workspace; provided as a
      // `work:` address, not a disk path
      try {
        const hosted = hostedContext(agentId);
        if (hosted) finalPrompt += attachmentsPrompt(hosted.workspace(), o.attachments);
      } catch { /* This process has no workspace: attachments cannot be used; does not affect this round */ }

      const apiConfig = o.apiConfig && typeof o.apiConfig === 'object' ? o.apiConfig : {};
      agentSessions.register(agentId, { type: 'api', vendor: String(apiConfig.vendor || 'api'), role: 'main', creativity: normalizeCreativity(o.creativity) });
      const { level, source } = agentSessions.creativityOf(agentId, currentProjectCreativity());
      finalPrompt += `\n\nYour Agent chat ID: ${agentId}; creativity level "${CREATIVITY_LABEL[level]}" (${source}): ` +
        `${CREATIVITY_HINT[level]}. Tool calls above your level will be rejected; if rejected, stop and tell the user, do not work around it`;

      emit({ type: 'run', runId: o.runId });
      // Single project replica limit (contract section 11): projects that are too large are not served.
      // Wait for the replica to become ready first (connections for this chat register at this point)
      try {
        binding.side.conversationNumber(agentId);
        await binding.side.link.ready();
        const project = binding.side.link.replica.project;
        const max = Number(o.maxProjectBytes) > 0 ? Number(o.maxProjectBytes) : 16 * 1024 * 1024;
        if (project && JSON.stringify(project).length > max) {
          emit({ type: 'error', code: 'too-large', message: 'The project is too large and the Cloud Agent does not support it yet. Please use PromptCut on your computer.' });
          return;
        }
      } catch (err) {
        emit({ type: 'error', code: 'unavailable', message: `The Cloud Agent cannot reach this project's document service: ${String(err?.message ?? err).slice(0, 200)}` });
        return;
      }
      const api = await import(new URL('../../runners/api.mjs', import.meta.url).href);
      if (aborted) return;

      let pendingText = '';
      const flushText = () => {
        const b = agentBinding;
        if (b && pendingText.trim()) b.side.executor.text(agentId, pendingText);
        pendingText = '';
      };
      board().beginRun(agentId, 0);
      hostedRunIds.set(agentId, o.runId);
      noteRun(+1);
      try {
        inner = api.startRun({
          provider: 'api',
          prompt: finalPrompt,
          systemPrompt,
          // History is located via the file provided by the host; sessionId is only a name in events,
          // ignoring whatever the page self-reports
          sessionId: typeof o.sessionKey === 'string' && o.sessionKey ? o.sessionKey : `cloud-${o.runId}`,
          historyFile: o.historyFile || undefined,
          // Code block space (A07): directory provided by the host per project; when omitted, the api runner
          // places it next to this chat's history file
          ...(typeof o.codeCacheDir === 'string' && o.codeCacheDir ? { codeCacheDir: o.codeCacheDir } : {}),
          codeCacheWriter: agentId,
          // Speed records (setting per-output limits based on measured speed): file provided by the host;
          // the task process spawns a new generation each round, so records must be placed where all
          // generations can read them
          ...(typeof o.outputSpeedFile === 'string' && o.outputSpeedFile ? { outputSpeedFile: o.outputSpeedFile } : {}),
          // Skills provided by the host: directory provided by the host; when omitted, only built-in skills
          // are available
          ...(typeof o.skillsDir === 'string' && o.skillsDir ? { skillsDir: o.skillsDir } : {}),
          ...(Number(o.historyMaxBytes) > 0 ? { historyMaxBytes: Number(o.historyMaxBytes) } : {}),
          cwd: null,
          model: o.model,
          effort: o.effort,
          deepAuto: false,
          reviewLoop: false,
          apiConfig,
          fetchImpl: o.fetchImpl,
          localTools: false,
          // When no frame-viewing endpoint is configured, the four frame-viewing tools are not given to the
          // model. Provider tools created in this process (account mode) are also passed to the model;
          // without a provider, it remains the original two tables
          toolFilter: cloudOpenTools({ look: !!prerenderPost, provided: accountProvided }),
          // Persist model history after each completed tool round-trip (can resume even if process is
          // killed); pass through the host gate before and after each model request, recording usage
          // (contract sections 6.2 and 7.1)
          checkpoint: true,
          ...(typeof o.onModelCall === 'function' ? { onModelCall: o.onModelCall } : {}),
          callTool: async (name, args, meta) => {
            // Account-v2 supplies a fresh doc runGrant/fence gate before any local
            // or project tool side effect. Legacy hosted callers omit this hook.
            if (typeof o.beforeToolCall === 'function') await o.beforeToolCall({ runId: o.runId, conversationId: agentId, name });
            // Timeout for a single tool call (contract section 11): when expired, stop waiting and state
            // clearly that this step did not finish. Tool implementations run in a process-level serial lock,
            // so this merely prevents this round from idling; implementations that are genuinely stuck rely
            // on the round's wall-clock limit and watchdog fallback
            const work = callToolInternal(name, args, agentId, typeof meta?.callId === 'string' ? meta.callId : undefined);
            activeTools.add(work);
            void work.finally(() => activeTools.delete(work)).catch(() => {});
            // Frame-viewing tools get a separate timeout: projects with user cards must wait for the isolated
            // worker process to start, and must queue when other projects are rendering; the render service
            // side has its own shorter timeout and returns a clear reason
            const isQueuedLook = CLOUD_LOOK_TOOLS.has(name) || name === 'get_layout' || name === 'render_card_audio';
            const isLook = isQueuedLook || CLOUD_SLOW_TOOLS.has(name);
            // Those requesting frames from the render service (queued on its side since 0.7.18): how long to
            // queue, how long each render takes, and how many retries are all determined by the render service
            // and returned with clear results (`server/hosted-render/look.mjs`: queue at most 30 minutes, render
            // 1 minute each time, retry 3 times). The timeout here is merely a fallback and must be longer
            // than that: otherwise, when queued behind other projects (multi-project mode alternates between
            // projects, having to wait for preceding requests and skin swaps before its turn), this step would
            // be killed before its turn, making the model think viewing failed while the request remains in queue
            const limitMs = isQueuedLook ? (Number(o.lookQueueTimeoutMs) > 0 ? Number(o.lookQueueTimeoutMs) : LOOK_QUEUE_TOOL_MS)
              : isLook && Number(o.lookTimeoutMs) > 0 ? Number(o.lookTimeoutMs) : Number(o.toolTimeoutMs) > 0 ? Number(o.toolTimeoutMs) : 60_000;
            let timer = null;
            const timeout = new Promise((resolve) => {
              timer = setTimeout(() => {
                agentLog('agent.tool-timeout', { tool: name });
                resolve({ ok: false, timeout: true, error: `${name} did not finish within ${Math.round(limitMs / 1000)} seconds; no longer waiting for it. It may not have taken effect, so read the project once to confirm before continuing.` });
              }, limitMs);
              timer.unref?.();
            });
            work.catch(() => {});
            try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
          },
          onEvent: (ev) => {
            if (ev.type === 'text' && typeof ev.delta === 'string') pendingText += ev.delta;
            if (ev.type === 'tool_call' || ev.type === 'done' || ev.type === 'error') flushText();
            // Same as desktop: full output of tool results is not sent to viewers (get_project is the whole
            // project)
            emit(ev.type === 'tool_result' && ev.output !== undefined ? { ...ev, output: undefined, outputOmitted: true } : ev);
          },
        });
        if (aborted) { try { inner.abort(); } catch { /* Already ended */ } }
        await inner.done;
      } finally {
        flushText();
        hostedRunIds.delete(agentId);
        noteRun(-1);
        try { board().endRun(agentId); } catch { /* Instance is already closed */ }
        // Scopes declared this round are revoked as this round ends (completion, failure, being stopped,
        // and cancellation all reach here): cloud chats have no tabs to close; if not revoked, the top
        // of other members' AI panels will persistently show "<member>'s Cloud Agent is editing: ...".
        // Send presence.clear via this chat's own connection; when the connection has already been closed,
        // presence is lost along with the connection
        try { if (board().clearScope(agentId)) void presenceBridge?.publishAgent(agentId)?.catch?.(() => {}); } catch { /* Instance is already closed */ }
      }
    })();
    return {
      runId: o.runId,
      abort() {
        aborted = true;
        try { inner?.abort(); } catch { /* Already ended */ }
      },
      /** Control ACK waits for the runner AND timed-out underlying tool dispatches.
       * A hung dispatch leaves this promise pending; callers must not claim closure. */
      async drain() {
        aborted = true;
        try { inner?.abort(); } catch { /* Already ended */ }
        await done;
        while (activeTools.size) await Promise.allSettled([...activeTools]);
        return { runId: o.runId, dispatchesOpen: 0 };
      },
      done,
    };
  }

  return {
    /** CLI quota circuit breaker: `/api/ai/quota` (kept in the host) shares the same copy with chats */
    getQuotaGuard,
    /** The following are for hosted tier hosts (desktop uses routes registered above, not these) */
    bindAgent,
    unbindAgent,
    callTool: callToolInternal,
    startHostedRun,
    /**
     * Account mode: `seek` succeeded on the initiator's page; update the playhead recorded for this
     * chat to the new one
     */
    notePlayhead(agent, t) {
      if (typeof agent !== 'string' || typeof t !== 'number' || !Number.isFinite(t) || t < 0) return;
      const ps = hostedPageStates.get(agent);
      hostedPageStates.set(agent, { ...(ps && typeof ps === 'object' ? ps : {}), t });
    },
    /**
     * Project replica bound to this instance and versions read by each chat (diagnostics); returns
     * null when not bound
     */
    describe: () => (agentBinding ? agentBinding.side.describe() : null),
    /** Hosted tier: whether this project's content store has card source code (if so, rendered by the render service's isolated worker process; prerender retries must queue) */
    hasProjectCards: () => (hostedShared?.cards.items.size ?? 0) > 0,
    /** Hosted tier: "key → version" of card source code in this project's content store (passed to the render service when viewing video: if cards exist, goes through the isolated worker process and waits for it to install this version) */
    cardRevs: () => Object.fromEntries([...(hostedShared?.cards.items ?? [])].map(([key, v]) => [key, Number.isFinite(v?.rev) ? v.rev : null])),
    /**
     * Hosted tier: this project's shared cost record (the document service's `cost.list`, the copy
     * written after the page tests cards), used to classify cards as light or heavy before publishing
     * prerender ("only dispatch heavy cards" in `render-clips.mjs`). Queried over this chat's
     * connection; returns null if not bound, unreachable, timed out, or rejected (old document service
     * does not allow Agent to read).
     */
    async costRecords(agent) {
      const binding = agentBinding;
      if (!HOSTED || !binding?.side?.executor || typeof agent !== 'string' || !agent) return null;
      try {
        const reply = await binding.side.executor.request(agent, { type: 'cost.list' }, (m) => m?.type === 'cost.listing' || m?.type === 'error');
        return reply?.type === 'cost.listing' && Array.isArray(reply.records) ? reply.records : null;
      } catch { return null; }
    },
    /** Current project replica and its version (used by hosted tier host to select clips for prerender retries); returns null if not bound or without content yet */
    replica: () => {
      const r = agentBinding?.side?.link?.replica;
      return r && r.hasBody ? { project: r.project, rev: r.rev } : null;
    },
    close(reason = 'close') {
      clearInterval(runPresenceTimer);
      runPresenceTimer = null;
      unbindAgent(reason);
      clearTimeout(boardPushTimer);
      clearTimeout(desktopPushTimer);
      hostedPageStates.clear();
      hostedContexts.clear();
    },
  };
}
