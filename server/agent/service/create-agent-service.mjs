/**
 * Hosted-tier Agent service: instance registry and round lifecycle (contract
 * `docs/plan/cloud-agent-contract.md` sections 3, 6, 7, 16).
 *
 * Within a process, a running instance (`instance.mjs`) is created for each
 * "project x member (`userId`)", and instances do not share any state keyed by page
 * self-reported ids: all lookups are first scoped by `identity` (from authentication, not from the
 * request body), then searched by chat id within that scope.
 *
 * The **ownership** of running instances and chats are two different things (contract sections 3.1, 7.2):
 *   - Chats (event log, status, model history, prerender retry manifest) are stored in the data
 *     directory (`conversations.mjs`) by "project x owner key", do not disappear when instances
 *     are recycled, and do not depend on any connection; the owner can recover them on another device;
 *   - Each round runs in the instance of the device that initiated it. Two consecutive rounds of the
 *     same chat can run in two instances, with only one round at any given moment.
 *
 * A round belongs only to the server side: once the message is responded to, it is decoupled from that
 * connection. Only these few things can end it, each leaving a human-readable reason and an `end` in
 * the event log, with the status and reason in `meta.json` updated in sync (contract section 7.3):
 *   finished speaking (idle), stopped by owner (idle / stopped), model call failed (failed / model),
 *   quota exceeded (failed / quota-exceeded), round limit or time limit reached (failed / limit),
 *   revocation: switch turned off, removed, kicked, project deleted, authorization expired
 *   (revoked / reason), service process exited or killed (interrupted).
 * Each tool write is an atomic commit to the document service, so if a round is stopped at any
 * moment, the project always stops after the last successful commit.
 *
 * Process-level items:
 *   - `execSerial`: server-side store is a singleton in the process (`src/store/core.ts`); tool
 *     implementations across all instances execute serially through the same lock, clearing on
 *     acquiring the lock;
 *   - Gate and usage records (`gate.mjs`, `usage.mjs`);
 *   - Chat storage (`conversations.mjs`) and prerender retry publishing (`render-request.mjs`).
 * This file does not import `src/`.
 */
import { createHeavyRenderGate, createRenderClipPicker, FLAT_KERNEL_MODULE, loadHeavyJudge } from './render-clips.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createAgentInstance } from './instance.mjs';
import { createConversationStore, INTERRUPTED_MESSAGE } from './conversations.mjs';
import { createGate, limitsFileOf } from './gate.mjs';
import { createUsageLog } from './usage.mjs';
import { createRenderRequests } from './render-request.mjs';
import { modelReady, pickModel, publicModelInfo } from './model-config.mjs';
import { createWorkspaces } from './workspace.mjs';
import { createEgressGate } from './egress.mjs';
import { createHostedTools, readHostedVoiceConfig, saveAttachment } from './hosted-tools.mjs';
import { createAccountConversationService } from './conversation-policy.mjs';
import { findAgentExtension } from './extensions.mjs';

export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Quota notice (primary text, user confirmed this phrasing on 2026-10-13). The same phrasing on
 * the page side is centralized in `src/ai/cloud/chatTexts.ts` and must be kept in sync */
export const CONVERSATION_LIMIT_MESSAGE = 'You already have 50 cloud chats in this project. Delete unused chats first, then create a new one.';

export const HOSTED_DEFAULTS = Object.freeze({
  /** Instances with no active round and no requests for this long are recycled */
  idleMs: 10 * 60_000,
  /** Wall-clock limit for a round (relaxed along with the round limit on 2026-10-24: using 22 minutes
   * for 24 rounds hits the 30-minute wall; 48 rounds must be paired with a longer wall clock,
   * otherwise relaxing the round limit is wasted) */
  runMs: 60 * 60_000,
  /** Maximum model round-trips per round (normal limit in the driver; used here only to inform
   * the page and write the finalization message) */
  rounds: 48,
  /** A single project replica (JSON) exceeding this size will not be served */
  maxProjectBytes: 16 * 1024 * 1024,
  /** Maximum wait time for a single tool call (contract section 11) */
  toolMs: 60_000,
  /** Maximum wait time for the look tool: projects with user cards must wait for the isolated worker
   * process to start up (around ten seconds), and also queue when other projects are rendering
   * (contract section 9.8) */
  lookToolMs: 180_000,
  /** If a chat's model history (`history.json`) exceeds this size, truncate it according to existing
   * history (contract section 7.2) */
  maxHistoryBytes: 8 * 1024 * 1024,
  /** Reverse channel (contract section 28): maximum wait time after sending a request to the
   * initiator's page; returns "initiator offline" on timeout */
  pageMs: 15_000,
  /** Reverse channel: when the initiator's page has just sent a message and the event stream has
   * not yet connected (or just disconnected and is reconnecting), wait for it at most this long;
   * if it has been away longer, immediately return "initiator offline" */
  pageAttachMs: 3_000,
});

/** Page id: a random string generated by the page itself, reported once when sending a message
 * and once when opening an event stream (contract section 28) */
export const PAGE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Maximum size of the result (JSON) returned by the page over the reverse channel */
const MAX_PAGE_RESULT_BYTES = 64 * 1024;

/** Gate test double: always passes and does not record usage (only for tests unconcerned with
 * gates; the service defaults to the real gate from `gate.mjs`) */
export const ALLOW_ALL_GATE = Object.freeze({
  admitRun: () => ({ ok: true }),
  admitModelCall: () => ({ ok: true }),
  record: () => {},
  release: () => {},
});

export class AgentServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const sha = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 32);

/**
 * Who owns the chat (contract section 7.2, lead session ruling 2026-10-06, pending user review).
 * After the document service verifies the delegation ticket, it directly returns the owner key
 * (`creator` / `user:<username>` / `device:<userId>`, key does not include project); use it if
 * present; if absent (test double), infer from fields following the same rule:
 * Creators and restricted entry list members use username, and can recover on another device;
 * open entry members use "username + device", and can only recover on the original device.
 * Returns a digest used as a directory name (project folded in).
 * @param {{ projectId: string, userId: string, username?: string, creator?: boolean, mode?: string, ownerKey?: string }} identity
 */
export function ownerKeyOf(identity) {
  let name;
  if (typeof identity.ownerKey === 'string' && identity.ownerKey) name = identity.ownerKey;
  else if (identity.creator === true) name = 'creator';
  else if (identity.mode === 'restricted' && identity.username) name = `user:${identity.username}`;
  else name = `device:${identity.userId}`;
  return sha(`${identity.projectId}\n${name}`);
}

/** Message written into chat records upon revocation and authorization invalidation */
const REVOKE_TEXT = Object.freeze({
  disabled: 'The project creator has turned off the Cloud Agent, so this turn was stopped. Changes already applied are kept in the project.',
  removed: 'You were removed from this project, so the Cloud Agent\'s turn was stopped. Changes already applied are kept in the project.',
  kicked: 'You were kicked from this project, so the Cloud Agent\'s turn was stopped. Changes already applied are kept in the project.',
  deleted: 'The project was deleted, so the Cloud Agent\'s turn was stopped.',
  expired: 'The authorization for this turn has expired, so it was stopped. Changes already applied are kept in the project; send another message to continue.',
  generation: 'The project\'s member list or password was changed, so the authorization for this turn is no longer valid and it was stopped. Changes already applied are kept in the project; send another message to continue.',
  'bad-grant': 'The authorization for this turn was not accepted by the document service, so it was stopped. Changes already applied are kept in the project; send another message to continue.',
});
const revokeText = (reason) => REVOKE_TEXT[reason] ?? `This Cloud Agent chat is no longer valid (${reason}), so this turn was stopped. Changes already applied are kept in the project.`;

/** `reason` when document service refuses a ticket → finalization reason in chat records; those
 * not in the table (unreachable, timeout) are transient failures and do not finalize */
const CREDENTIAL_REASON = Object.freeze({
  'service-disabled': 'disabled', 'service-revoked': 'disabled', banned: 'kicked', 'not-listed': 'removed', 'no-project': 'deleted',
  expired: 'expired', generation: 'generation',
  signature: 'bad-grant', format: 'bad-grant', audience: 'bad-grant', 'not-grant': 'bad-grant', project: 'bad-grant', conversation: 'bad-grant', forbidden: 'bad-grant',
});

/** Close code and reason when data connection is closed by document service → finalization
 * reason (contract section 4.5) */
export function revokeReasonOfClose({ code, reason } = {}) {
  if (code === 4004) return 'deleted';
  if (reason === 'service-disabled') return 'disabled';
  if (reason === 'kicked' || reason === 'removed') return reason;
  return typeof reason === 'string' && reason ? reason.slice(0, 40) : 'removed';
}

/** Strip URLs from raw errors returned by model API (URLs are host configuration; Key has
 * already been replaced by driver) */
const scrub = (text) => String(text ?? '').replace(/https?:\/\/[^\s"'<>)]+/g, '[URL]').slice(0, 500);

/**
 * @param {object} o
 * @param {string} o.root Repository root directory (system prompts and others are resolved
 *   relative to it)
 * @param {(id: string) => Promise<any>} o.loadModule Sole entry point for frontend code (Vite's
 *   `ssrLoadModule`), passed only to `ssr-host.mjs`
 * @param {string} o.docUrl ws(s) address of the document service
 * @param {object} o.credentials Credentials for connecting to document service (interface slot;
 *   the real one is provided by Block Yi's `server/auth/service-client.mjs`):
 *   `protocolsFor(identity, chat number, { conversationId, grant })` → subprotocol used for this
 *   chat's connection. When document service explicitly refuses, throws error with `reason`
 *   (`expired`, `generation`, `service-disabled`, `banned`, `not-listed`, `no-project`, etc.),
 *   and this round finalizes accordingly;
 *   `admitGrant?(identity, conversationId, grant)` → verify chat delegation before sending a message;
 *   throw if invalid (returns `bad-grant`).
 * @param {() => Promise<object> | object} o.modelConfig Model configuration used for this round
 *   `{ vendor, model, apiKey?, baseUrl?, maxTokens? }`
 * @param {string | null} [o.dataDir] Data directory; if omitted, chats remain in memory only and
 *   do not log usage streams (testing only)
 * @param {object} [o.gate] Gate; if omitted, uses the one from `gate.mjs` (reads
 *   `<data-dir>/config/limits.json`)
 * @param {object | null} [o.publisher] Publishing channel for prerender retry (interface slot,
 *   see `render-request.mjs` for shape); if omitted, does not publish prerender retries
 * @param {{ agentEnabled?(projectId): boolean, renderEnabled?(projectId): boolean }} [o.projectState]
 *   Switches for each project (interface slot; the real ones are fed by document service pushes).
 *   When omitted, all are considered enabled
 * @param {string | null} [o.assetBase] Address of the asset service on the same machine
 *   (`http://127.0.0.1:<port>`); if omitted, media import and voiceover storage cannot be
 *   performed (tools return an explicit reason)
 * @param {{ forProject(projectId: string, o?: object): Function, describe?(): object } | null} [o.look]
 *   Look client (`server/agent-service/look-client.mjs`): requests a frame from the render service
 *   on the same machine. When omitted, look tools are not exposed to the model (contract section 9.8)
 * @param {object} [o.egress] Options for the egress gate (`createEgressGate` in `egress.mjs`;
 *   `testAllow` is only for tests and probes)
 * @param {() => Promise<object | null>} [o.voiceConfig] Voiceover configuration from the host;
 *   if omitted, reads `config/voice.json` and `config/keys/voice.key` in the data directory
 * @param {object} [o.workspaceLimits] Total workspace limits (`workspace.mjs`)
 * @param {object | null} [o.collect] Collection tool on the node (`readCollectConfig` in
 *   `hosted-collect.mjs`); if omitted, collection tools return "This cloud node does not have
 *   collection tools installed"
 */
export function createHostedAgentService({
  root,
  loadModule,
  docUrl,
  credentials,
  modelConfig,
  dataDir = null,
  gate: gateIn = null,
  publisher = null,
  projectState = {},
  limits: limitsIn = {},
  storeLimits = {},
  renderLimits = {},
  assetBase = null,
  look = null,
  egress: egressOptions = {},
  voiceConfig = null,
  workspaceLimits = {},
  toolLimits = {},
  toolFetch = undefined,
  collect = null,
  accountMode = false,
  conversationClient = null,
  runClient = null,
  dataClient = null,
  resources = null,
  requireAccountRunner = false,
  readIntentsFile = null,
  runEventsFile = null,
  runEventsAuthorityId = null,
  runnerFactory = null,
  serviceKid = null,
  instanceId = null,
  connectionsClosed = null,
  childrenClosed = null,
  task = null, assignmentReady = null, onTaskDrained = null, runEventsSink = null,
  runAssets = null,
  accountTools = null,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  if (accountMode === true) {
    if (requireAccountRunner === true || runClient) { const runnerExt = findAgentExtension('account-runner'); if (!runnerExt?.createService) throw new AgentServiceError('run-unavailable', 'account runner is not mounted', 503); return runnerExt.createService({ root, loadModule, docUrl, dataDir,
      modelConfig, dataClient, resources, assetBase, look, voiceConfig: voiceConfig ?? (async () => null), collect,
      egress: egressOptions, workspaceLimits, toolLimits, toolFetch, runAssets, accountTools,
      conversationClient, runClient, readIntentsFile, runEventsFile, runEventsAuthorityId, runnerFactory, serviceKid, instanceId,
      connectionsClosed, childrenClosed, task, assignmentReady, onTaskDrained, runEventsSink, log, now }); }
    return createAccountConversationService({ conversationClient, now });
  }
  if (typeof loadModule !== 'function') throw new TypeError('createHostedAgentService: loadModule is required');
  if (typeof docUrl !== 'string' || !/^wss?:\/\//.test(docUrl)) throw new TypeError('createHostedAgentService: docUrl must be a ws(s):// URL');
  if (!credentials || typeof credentials.protocolsFor !== 'function') throw new TypeError('createHostedAgentService: credentials.protocolsFor is required');
  if (typeof modelConfig !== 'function') throw new TypeError('createHostedAgentService: modelConfig is required');
  const limits = { ...HOSTED_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failures do not affect the service */ } };

  const agentEnabled = (projectId) => { try { return projectState.agentEnabled ? projectState.agentEnabled(projectId) !== false : true; } catch { return true; } };
  const renderEnabled = (projectId) => { try { return projectState.renderEnabled ? projectState.renderEnabled(projectId) !== false : true; } catch { return true; } };

  const usage = gateIn ? null : createUsageLog({ dir: dataDir ? path.join(dataDir, 'usage') : null, now, log: say });
  const gate = gateIn ?? createGate({ limitsFile: dataDir ? limitsFileOf(dataDir) : null, usage, isEnabled: agentEnabled, now, log: say });
  const store = createConversationStore({ dataDir, now, limits: storeLimits, log: say });
  const render = createRenderRequests({ publisher, store, now, limits: renderLimits, log: say });
  // Everything read and written by tools on the node is isolated by "project x chat"; egress to
  // addresses provided by the model only goes through the egress gate (task brief J, contract
  // sections 9.5, 9.6)
  const workspaces = createWorkspaces({ dataDir, limits: workspaceLimits, log: say });
  const egress = createEgressGate({ ...egressOptions, log: say });
  // Flattened view of cut segments (collects cards in cut segments when publishing prerenders,
  // `render-clips.mjs`): fetches kernel functions via the loading seam; before loaded, picks only
  // by clip id
  let flatKernel = null;
  Promise.resolve().then(() => loadModule(FLAT_KERNEL_MODULE)).then((m) => { flatKernel = m; }, () => {});
  // Classify light and heavy before publishing prerenders (publish heavy cards only,
  // `render-clips.mjs` "publish heavy cards only"): classification function is fetched via the same
  // loading seam; if it cannot load, publish all as before
  let heavyJudge = null;
  if (render.enabled) {
    Promise.resolve().then(() => loadHeavyJudge(loadModule)).then((fn) => { heavyJudge = fn; },
      (err) => say('agent.render.judge-unavailable', { message: String(err?.message ?? err).slice(0, 120) }));
  }
  const hostedTools = createHostedTools({
    root,
    loadModule,
    workspaces,
    egress,
    assetBase,
    voiceConfig: voiceConfig ?? (() => readHostedVoiceConfig(dataDir)),
    // Paid external calls (voiceover) and model requests are recorded into the same usage log
    recordService: (row) => { try { gate.record(row); } catch (err) { say('agent.usage.service-failed', { message: String(err?.message ?? err).slice(0, 120) }); } },
    limits: toolLimits,
    // Web collection: whether installed on the node depends on deployment (`hosted-collect.mjs`);
    // if absent, tools return an explicit reason
    collect,
    ...(toolFetch ? { fetchImpl: toolFetch } : {}),
    log: say,
  });

  // Chats where the previous process exited before finalizing: mark as interrupted, do not
  // automatically resume (contract section 7.5). Prerender retry manifests not yet finished
  // rendering are republished (using service identity only)
  store.recover();
  const restored = Promise.resolve().then(() => render.restore()).catch((err) => { say('agent.render.restore-failed', { message: String(err?.message ?? err).slice(0, 160) }); return 0; });

  /** Process-level serial lock: tool implementations in all instances share the server-side store */
  let lock = Promise.resolve();
  const execSerial = (fn) => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  };

  /** Instance key → { key, identity, ownerKey, inst, ready, runs: Map(chat id → chat), lastUsed, closed } */
  const instances = new Map();
  /** "instance key\nchat id" → chat delegation for this round. In-memory only, not persisted to
   * disk, not written to logs (contract section 4.2) */
  const grants = new Map();
  let closed = false;
  /** Parties to be notified upon revocation (HTTP layer closes event streams accordingly, auth
   * layer clears verification cache accordingly) */
  const revokeListeners = new Set();

  const keyOf = (identity) => `${identity.projectId}\n${identity.userId}\n${ownerKeyOf(identity)}`;
  const maxInstances = () => limitsIn.maxInstances ?? gate.nodeLimits?.().maxInstances ?? 24;

  function checkIdentity(identity) {
    if (!identity || typeof identity.projectId !== 'string' || !identity.projectId || typeof identity.userId !== 'string' || !identity.userId) {
      throw new AgentServiceError('unauthorized', 'No identity', 401);
    }
  }

  function checkConversationId(id) {
    if (typeof id !== 'string' || !CONVERSATION_ID_RE.test(id)) throw new AgentServiceError('bad-request', 'Invalid chat id');
  }

  function closeEntry(entry, reason) {
    if (entry.closed) return;
    entry.closed = true;
    instances.delete(entry.key);
    // Rounds still running are first stopped by callers for their respective reasons; any still
    // remaining here (should not happen) are finalized as interrupted, avoiding hanging
    for (const conv of [...entry.runs.values()]) conv.run?.stop('interrupted');
    for (const rg of entry.renderGates?.values() ?? []) rg.close();
    try { entry.inst.close(reason); } catch { /* Already closed */ }
    say('agent.instance.close', { projectId: entry.identity.projectId, user: sha(entry.identity.userId).slice(0, 8), reason });
  }

  function reclaim() {
    const at = now();
    for (const entry of [...instances.values()]) {
      if (entry.runs.size === 0 && at - entry.lastUsed >= limits.idleMs) closeEntry(entry, 'idle');
    }
  }
  const sweep = setInterval(reclaim, Math.min(60_000, limits.idleMs));
  sweep.unref?.();

  /** "Initiator online": an event stream from the `userId` that initiated this round is currently
   * connected to this chat (contract section 9.4) */
  function initiatorOnline(entry, conversationId) {
    const conv = entry.runs.get(conversationId);
    if (!conv?.run) return false;
    for (const l of conv.listeners) if (l.userId === conv.run.userId) return true;
    return false;
  }

  /*
   * ---------------- Reverse channel (contract section 28) ----------------
   *
   * When a round needs the initiator's page to perform actions (playhead, play and pause, read
   * current selection): send a `page.request { id, runId, tool, args, timeoutMs }` to the event
   * stream of **the page that initiated this round**, which the page executes using the same tool
   * implementation on its local machine, and returns via `POST …/page-results`.
   *   - Recognizes only that single page: the page reports its page id (`pageId`) when sending a
   *     message and also when opening an event stream; only the stream where both match and share the
   *     same `userId` counts. Other devices and tabs of the same member can see the chat, but will
   *     not receive the request. Pages that do not report a page id when sending a message (legacy
   *     pages) have no reverse channel.
   *   - `page.request` is sent only to that stream, **does not enter the event log, and carries no
   *     `seq`**: it is a one-time request at this moment, and anyone viewing later should not execute
   *     it again.
   *   - `id` is a 128-bit random number generated by the server, obtainable only by that page; upon
   *     submission, it is verified against "owner of this chat, `userId` that initiated this round,
   *     page id of this round, pending `id`", valid only once.
   *   - Waiting for results has a time limit (`pageMs`); on timeout, if the stream disconnects
   *     midway, or if this round ends, all return "initiator offline", and the Agent proceeds
   *     accordingly.
   */
  const pageListenerOf = (conv) => {
    const run = conv?.run;
    if (!run?.pageId) return null;
    for (const l of conv.listeners) if (l.userId === run.userId && l.pageId === run.pageId) return l;
    return null;
  };

  /** End a pending request (succeeds only once) */
  function settlePage(run, id, out) {
    const p = run?.pageRequests?.get(id);
    if (!p) return false;
    run.pageRequests.delete(id);
    clearTimeout(p.timer);
    p.resolve(out);
    return true;
  }

  /** Pending requests for this round are closed as "initiator offline" (if `listener` is provided,
   * close only those sent to that stream; if omitted, close all, including those waiting for the
   * page to connect) */
  function failPageRequests(run, why, listener = null) {
    if (!run?.pageRequests) return;
    for (const [id, p] of [...run.pageRequests]) {
      if (listener && p.listener !== listener) continue;
      settlePage(run, id, { offline: true, why });
    }
    if (!listener) for (const w of [...run.pageWaiters]) w();
  }

  /**
   * Executes once on the initiator's page. Returns `{ ok: true, result }` (page executed, `result`
   * is the `{ ok, result?, error? }` it returned) or `{ offline: true, why }` (no reverse channel /
   * page absent / timeout / disconnected midway / round ended).
   */
  async function pageCall(entry, conversationId, tool, args) {
    const conv = entry.runs.get(conversationId);
    const run = conv?.run;
    if (!run?.pageId) return { offline: true, why: 'no-page' };
    let listener = pageListenerOf(conv);
    if (!listener) {
      // Stream not yet connected right after sending a message, or just disconnected and reconnecting:
      // wait briefly; return immediately if already away for a while
      const left = run.pageSeenAt + limits.pageAttachMs - now();
      if (left <= 0) return { offline: true, why: 'detached' };
      await new Promise((resolve) => {
        let t = null;
        const done = () => { clearTimeout(t); run.pageWaiters.delete(done); resolve(); };
        t = setTimeout(done, left);
        t.unref?.();
        run.pageWaiters.add(done);
      });
      if (conv.run !== run) return { offline: true, why: 'ended' };
      listener = pageListenerOf(conv);
      if (!listener) return { offline: true, why: 'detached' };
    }
    const id = randomBytes(16).toString('base64url');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { settlePage(run, id, { offline: true, why: 'timeout' }); }, limits.pageMs);
      timer.unref?.();
      run.pageRequests.set(id, { resolve, timer, listener, tool });
      say('agent.page.request', { projectId: entry.identity.projectId, runId: run.runId, tool });
      try {
        listener.cb({ type: 'page.request', id, runId: run.runId, tool, args: args ?? {}, timeoutMs: limits.pageMs });
      } catch {
        settlePage(run, id, { offline: true, why: 'detached' });
      }
    });
  }

  /** A write landed in this instance: pick clips requiring prerender and hand them to prerender
   * retry (contract section 16) */
  function onWrite(entry, conversationId, write) {
    if (!render.enabled) return;
    const conv = entry.runs.get(conversationId);
    if (!conv?.run) return;
    // Cards in cut segments are sent by virtual clip id in the flattened view (`render-clips.mjs`;
    // one copy of previous signature table per instance)
    entry.renderPicker ??= createRenderClipPicker(() => flatKernel);
    renderGateOf(entry, conversationId, conv).note(write?.clipIds ?? [], write?.before ?? null);
  }

  /**
   * This chat's "batch briefly, classify light and heavy, publish heavy cards only"
   * (`createHeavyRenderGate` in `render-clips.mjs`). Batching duration shares the same number as the
   * prerender retry debounce; those classified as heavy are handed to prerender retry
   * (`render.noteWrite`), recorded under the round that wrote them.
   */
  function renderGateOf(entry, conversationId, conv) {
    entry.renderGates ??= new Map();
    let rg = entry.renderGates.get(conversationId);
    if (!rg) {
      let runId = conv.run?.runId ?? null;
      rg = createHeavyRenderGate({
        picker: entry.renderPicker, delayMs: render.debounceMs, log: say,
        replica: () => entry.inst.replica?.() ?? null,
        judge: () => heavyJudge,
        records: () => entry.inst.costRecords?.(conversationId) ?? Promise.resolve(null),
        emit: (clips, { rev }) => {
          const replica = entry.inst.replica?.();
          render.noteWrite(conv, { clips, rev: rev ?? replica?.rev, project: replica?.project ?? null, runId: rg.runId, userCards: entry.inst.hasProjectCards?.() === true });
        },
      });
      rg.runId = runId;
      entry.renderGates.set(conversationId, rg);
    }
    if (conv.run?.runId) rg.runId = conv.run.runId;
    return rg;
  }

  /**
   * Credentials used by the instance's n-th connection to the document service. Chat delegations are
   * strictly bound to a single chat (contract section 4.2), so both chat id and this round's
   * delegation are passed to the credentials side. The instance's own connection (replica
   * subscription, presence; the one in the executor without a chat id) has no delegation of its own:
   * it borrows from a chat in this instance that currently has a delegation. When the document
   * service explicitly refuses (delegation expired, generation changed, switch turned off, kicked,
   * removed, project gone), the round of the used chat is finalized according to the reason;
   * transient issues such as connection failure or timeout are excluded and retried with backoff by
   * the connection layer as usual.
   */
  async function connectionCredentials(entry, n, conversationId) {
    let id = conversationId;
    let grant = grants.get(`${entry.key}\n${id}`) ?? null;
    if (!id) {
      const prefix = `${entry.key}\n`;
      for (const [k, g] of grants) {
        if (k.startsWith(prefix)) { id = k.slice(prefix.length); grant = g; break; }
      }
      if (!id) id = entry.runs.keys().next().value ?? '';
    }
    try {
      return await credentials.protocolsFor(entry.identity, n, { conversationId: id, grant });
    } catch (err) {
      const why = CREDENTIAL_REASON[err?.reason];
      if (why) entry.runs.get(id)?.run?.stop('revoked', { reason: why });
      throw err;
    }
  }

  /** Find or create this member's instance in this project; concurrent arrivals with the same key
   * share the same creation */
  async function instanceFor(identity) {
    if (closed) throw new AgentServiceError('unavailable', 'Service is shutting down', 503);
    const key = keyOf(identity);
    let entry = instances.get(key);
    if (!entry) {
      if (instances.size >= maxInstances()) {
        const idle = [...instances.values()].filter((e) => e.runs.size === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!idle) throw new AgentServiceError('busy', 'The Cloud Agent is busy. Please try again later.', 503);
        closeEntry(idle, 'evicted');
      }
      entry = { key, identity: { ...identity }, ownerKey: ownerKeyOf(identity), inst: null, runs: new Map(), lastUsed: now(), closed: false, ready: null };
      const own = entry;
      entry.inst = createAgentInstance({
        profile: 'hosted',
        server: {
          httpServer: null,
          ssrLoadModule: loadModule,
          config: { root },
          // Hosted tier has no /api/*: none of the desktop routes registered by instances are mounted
          middlewares: { use() {} },
        },
        // Look: request a frame from the render service on the same machine. Project is this instance's
        // project (from auth), tool parameters cannot modify it; card source version is reported on the fly
        // by the instance
        prerenderPost: look ? look.forProject(identity.projectId, { cards: () => own.inst?.cardRevs?.() ?? {} }) : null,
        latestMirror: () => null,
        latestPlayhead: () => null,
        projectId: identity.projectId,
        identity: { userId: identity.userId, username: identity.username ?? '' },
        ownerKey: own.ownerKey,
        hostedTools,
        docUrl,
        protocolsFor: (n, conversationId) => connectionCredentials(own, n, conversationId),
        execSerial,
        initiatorOnline: (conversationId) => initiatorOnline(own, conversationId),
        pageCall: (conversationId, tool, args) => pageCall(own, conversationId, tool, args),
        onWrite: (conversationId, write) => onWrite(own, conversationId, write),
        // Document service closed the data connection with 4003 / 4004: revoked, immediately stop every
        // round in this instance and close the instance, no reconnection
        onFinalClose: (info) => {
          const reason = revokeReasonOfClose(info);
          queueMicrotask(() => api.revoke({ projectId: own.identity.projectId, userId: own.identity.userId, reason }));
        },
        log: (event, fields) => say(event, fields),
      });
      entry.ready = entry.inst.bindAgent({ projectId: identity.projectId, mode: 'hosted' }).then(() => own, (err) => {
        closeEntry(own, 'bind-failed');
        throw new AgentServiceError('unavailable', `Cannot reach the document service: ${err?.message ?? err}`, 503);
      });
      instances.set(key, entry);
      say('agent.instance.open', { projectId: identity.projectId, user: sha(identity.userId).slice(0, 8), instances: instances.size });
    }
    entry.lastUsed = now();
    return entry.ready;
  }

  /** A chat for this member (by owner key) in this project; returns null if none exists */
  function conversationOf(identity, conversationId, create = false) {
    checkIdentity(identity);
    if (typeof conversationId !== 'string' || !CONVERSATION_ID_RE.test(conversationId)) return null;
    try {
      return store.get(identity.projectId, ownerKeyOf(identity), conversationId, { create, startedOn: identity.deviceName ?? null });
    } catch (err) {
      // Do not automatically delete history when quota is reached (user decision, 2026-10-08): creation
      // is rejected, requiring the user to delete old ones first
      if (err?.code === 'conversation-limit') throw new AgentServiceError('conversation-limit', CONVERSATION_LIMIT_MESSAGE, 409);
      throw err;
    }
  }

  const listItem = (m) => ({ id: m.id, title: m.title ?? '', updatedAt: m.updatedAt ?? null, state: m.state, reason: m.reason ?? null, lastSeq: m.lastSeq ?? 0, startedOn: m.startedOn ?? null });

  const api = {
    limits,
    /** Whether prerender retry republishing on startup has finished (tests wait for it) */
    restored,

    /**
     * Send a message and start a round. From this point on, this round is independent of the caller's
     * connection: events enter this chat's event log, and whoever is connected can view them.
     * @returns {Promise<{ runId: string, seq: number }>} `seq` is the sequence number of the first
     *   event (user message) in this round
     */
    async send(identity, conversationId, body = {}) {
      checkIdentity(identity);
      if (closed) throw new AgentServiceError('unavailable', 'Service is shutting down', 503);
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new AgentServiceError('bad-request', 'The message is empty');
      checkConversationId(conversationId);
      const before = conversationOf(identity, conversationId, false);
      if (before?.run) throw new AgentServiceError('busy-conversation', 'This chat still has a turn in progress.', 409);
      if (before && store.full(before)) throw new AgentServiceError('too-large', 'The history of this chat is too long. Please start a new chat.', 413);
      const cfg = (await modelConfig()) ?? {};
      if (!modelReady(cfg)) throw new AgentServiceError('no-model-key', 'The host has not configured a model for the Cloud Agent yet.', 503);
      const grant = typeof body.grant === 'string' && body.grant ? body.grant : null;
      if (typeof credentials.admitGrant === 'function') {
        try {
          await credentials.admitGrant(identity, conversationId, grant);
        } catch (err) {
          if (err instanceof AgentServiceError) throw err;
          const why = CREDENTIAL_REASON[err?.reason];
          if (why === 'disabled') throw new AgentServiceError('disabled', 'The project creator has turned off the Cloud Agent.', 403);
          if (err?.reason === 'unavailable' || err?.reason === 'timeout') throw new AgentServiceError('unavailable', 'The document service is temporarily unreachable. Please try again later.', 503);
          throw new AgentServiceError('bad-grant', 'The grant attached to this message is invalid or has expired. Please retry.', 403);
        }
      }
      // Gate: before a round starts (contract Section 6.2). Admitting takes a slot, returned exactly once afterward
      const admitted = await gate.admitRun({ projectId: identity.projectId, userId: identity.userId });
      if (!admitted?.ok) {
        const code = admitted?.code ?? 'busy';
        throw new AgentServiceError(code, admitted?.message ?? 'The Cloud Agent is busy. Please try again later.', code === 'disabled' ? 403 : 429);
      }
      const slot = { projectId: identity.projectId, userId: identity.userId };
      // Set up delegation first: as soon as the instance is created it must connect to the document
      // service, so credentials must be ready by then
      const grantKey = `${keyOf(identity)}\n${conversationId}`;
      const hadGrant = grants.get(grantKey);
      if (grant) grants.set(grantKey, grant);
      let entry;
      let conv;
      try {
        entry = await instanceFor(identity);
        conv = conversationOf(identity, conversationId, true);
        if (!conv) throw new AgentServiceError('bad-request', 'Invalid chat id');
        if (conv.run) throw new AgentServiceError('busy-conversation', 'This chat still has a turn in progress.', 409);
      } catch (err) {
        gate.release(slot);
        // This message did not start a round: do not keep the delegation it brought (put back the
        // delegation for the round currently running in the same chat)
        if (grant) { if (hadGrant) grants.set(grantKey, hadGrant); else grants.delete(grantKey); }
        throw err;
      }
      // No awaiting from here to `conv.run = …`: of two concurrent messages arriving for the same chat,
      // only one gets through

      const runId = randomUUID();
      if (!grant) grants.delete(grantKey);
      const model = pickModel(cfg, typeof body.model === 'string' ? body.model : undefined);
      let finished = false;
      let stopped = false;
      let sawError = null;
      let limitHit = false;
      let inner = null;
      let timer = null;

      const finish = (state, reason = null, message = null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // Requests still waiting for the page: this round is gone, stop waiting
        failPageRequests(conv.run, 'ended');
        conv.run = null;
        conv.pinned = false;
        entry.runs.delete(conversationId);
        grants.delete(grantKey);
        entry.lastUsed = now();
        gate.release(slot);
        store.emit(conv, { type: 'end', runId, state, ...(reason ? { reason } : {}) });
        store.setState(conv, { state, reason, message, endedAt: now() });
        store.compact(conv);
        say('agent.run.end', { projectId: identity.projectId, runId, state, ...(reason ? { reason } : {}) });
        // Round ended: finish classifying accumulated items as light or heavy first, then immediately
        // dispatch prerender retries to ensure the final version has a plan
        void Promise.resolve(entry.renderGates?.get(conversationId)?.flush()).then(() => render.flush(conv));
      };

      const stop = (kind, detail = {}) => {
        if (finished) return;
        stopped = true;
        try { inner?.abort(); } catch { /* Already ended */ }
        if (kind === 'stopped') {
          store.emit(conv, { type: 'status', runId, text: 'Stopped' });
          finish('idle', 'stopped');
        } else if (kind === 'limit') {
          const message = `This turn exceeded the limit of ${Math.round(limits.runMs / 60_000)} minutes and was stopped. Changes already applied are kept in the project.`;
          store.emit(conv, { type: 'error', code: 'limit', runId, message });
          finish('failed', 'limit', message);
        } else if (kind === 'revoked') {
          const reason = detail.reason ?? 'revoked';
          const message = revokeText(reason);
          store.emit(conv, { type: 'error', code: 'revoked', reason, runId, message });
          finish('revoked', reason, message);
        } else {
          store.emit(conv, { type: 'error', code: 'interrupted', runId, message: INTERRUPTED_MESSAGE });
          finish('interrupted', 'interrupted', INTERRUPTED_MESSAGE);
        }
      };

      conv.run = {
        runId, userId: identity.userId, stop,
        // Reverse channel (contract Section 28): page id of the page that initiated this round;
        // if not reported (legacy page), there is no reverse channel
        pageId: typeof body.pageId === 'string' && PAGE_ID_RE.test(body.pageId) ? body.pageId : null,
        pageRequests: new Map(),
        pageWaiters: new Set(),
        pageSeenAt: now(),
      };
      conv.pinned = true;
      entry.runs.set(conversationId, conv);
      // Attachments included with this message (only recognize those actually in this chat's working
      // directory): record name, address, and size into the user message event, visible in bubbles when
      // switching devices or reopening the chat
      const attached = [];
      if (Array.isArray(body.attachments) && workspaces.available) {
        try {
          const ws = workspaces.open({ projectId: identity.projectId, ownerKey: ownerKeyOf(identity), conversationId });
          for (const a of body.attachments.slice(0, 32)) {
            const url = typeof a?.url === 'string' ? a.url : '';
            if (!url.startsWith('work:attachments/')) continue;
            let st = null;
            try { st = ws.stat(url.slice(5)); } catch { st = null; }
            if (st) attached.push({ name: url.slice('work:attachments/'.length), url, size: st.size });
          }
        } catch { /* No workspace: treat as having no attachments */ }
      }
      const first = store.emit(conv, { type: 'user', runId, prompt: body.prompt, from: identity.deviceName ?? null, at: now(), ...(attached.length ? { attachments: attached } : {}) });
      store.setState(conv, {
        state: 'running', reason: null, message: null, runId, startedAt: now(), endedAt: null,
        startedOn: identity.deviceName ?? conv.meta.startedOn ?? null,
        ...(conv.meta.title ? {} : { title: (body.prompt.trim().split('\n')[0] ?? '').slice(0, 40) }),
      });
      say('agent.run.start', { projectId: identity.projectId, runId });

      inner = entry.inst.startHostedRun({
        runId,
        conversationId,
        prompt: body.prompt,
        model: typeof body.model === 'string' ? body.model : undefined,
        effort: typeof body.effort === 'string' ? body.effort : undefined,
        creativity: body.creativity,
        script: body.script,
        library: Array.isArray(body.library) ? body.library : [],
        attachments: attached,
        pageState: body.pageState && typeof body.pageState === 'object' ? body.pageState : null,
        apiConfig: cfg,
        historyFile: dataDir ? path.join(store.dirOf(identity.projectId, ownerKeyOf(identity), conversationId), 'history.json') : null,
        // Code block space is stored per project (A07, 2026-10-22), placed under this project's tenants
        // directory: cleared along with it when deleting the project (delete project in conversations.mjs);
        // when there is no data directory, placed beside history files by the api runner
        ...(dataDir ? { codeCacheDir: path.join(dataDir, 'tenants', identity.projectId, 'code-cache') } : {}),
        // Output speed records (set single-output limit by measured speed, 2026-10-22): in the same
        // directory as usage logs
        ...(dataDir ? { outputSpeedFile: path.join(dataDir, 'usage', 'model-speed.json') } : {}),
        // Skills provided by the host (issue 46): located under config/ alongside model configuration
        ...(dataDir ? { skillsDir: path.join(dataDir, 'config', 'skills') } : {}),
        sessionKey: `cloud-${ownerKeyOf(identity).slice(0, 16)}-${conversationId}`,
        maxProjectBytes: limits.maxProjectBytes,
        toolTimeoutMs: limits.toolMs,
        lookTimeoutMs: limits.lookToolMs,
        historyMaxBytes: limits.maxHistoryBytes,
        fetchImpl: body.__fetchImpl,
        // Gate: before each model request (contract Section 6.2); record a line of usage afterward (Section 6.3)
        onModelCall: async (phase, info) => {
          if (phase === 'before') {
            const ok = await gate.admitModelCall({ projectId: identity.projectId, userId: identity.userId, model });
            if (!ok?.ok) throw Object.assign(new Error(ok?.message ?? 'The Cloud Agent cannot call the model right now.'), { runErrorCode: ok?.code ?? 'busy' });
            return;
          }
          gate.record({
            t: now(), projectId: identity.projectId, userId: identity.userId, username: identity.username ?? '', conversationId, runId,
            vendor: info?.vendor ?? cfg.vendor ?? '', model: info?.model ?? model,
            input: info?.input ?? 0, output: info?.output ?? 0, cacheRead: info?.cacheRead ?? 0, ok: info?.ok !== false, ms: info?.ms ?? 0,
          });
        },
        onEvent: (ev) => {
          if (finished) return;
          let out = ev;
          if (ev.type === 'diagnostic') {
            // Hosted tier sends only configurations and request/response counts, without model endpoint
            // addresses (contract Section 2.4); skill manifest has only names and error codes, visible when
            // deployed but inactive
            if (ev.stage !== 'configuration' && ev.stage !== 'request' && ev.stage !== 'response' && ev.stage !== 'skills') return;
          } else if (ev.type === 'error') {
            out = typeof ev.code === 'string' ? ev : { ...ev, code: 'model', message: `Model call failed: ${scrub(ev.message)}` };
            sawError = out;
          } else if (ev.type === 'done' && ev.outcome === 'round_limit') {
            limitHit = true;
          }
          store.emit(conv, { ...out, runId });
        },
      });
      timer = setTimeout(() => stop('limit'), limits.runMs);
      timer.unref?.();
      if (stopped) { try { inner.abort(); } catch { /* Already ended */ } }

      inner.done.then(
        () => {
          if (finished || stopped) return;
          if (sawError) return finish('failed', sawError.code ?? 'model', sawError.message ?? null);
          if (limitHit) {
            const message = `This turn reached the limit of ${limits.rounds} model round trips and was stopped. Changes already applied are kept in the project, and you can continue.`;
            store.emit(conv, { type: 'error', code: 'limit', runId, message });
            return finish('failed', 'limit', message);
          }
          return finish('idle', null);
        },
        (err) => {
          if (finished || stopped) return;
          const message = `Model call failed: ${scrub(err?.message ?? err)}`;
          store.emit(conv, { type: 'error', code: 'model', runId, message });
          finish('failed', 'model', message);
        },
      );
      return { runId, seq: first.seq };
    },

    /**
     * Watch events for a chat: replay events with `seq` greater than `after` first, then connect to
     * real-time ones. Returns unsubscribe function.
     * Returns null if the chat does not exist (or does not belong to this member in this project),
     * leaking nothing beyond existence.
     */
    subscribe(identity, conversationId, after, onEvent, { pageId = null } = {}) {
      const conv = conversationOf(identity, conversationId, false);
      if (!conv) return null;
      const entry = instances.get(keyOf(identity));
      if (entry) entry.lastUsed = now();
      const page = typeof pageId === 'string' && PAGE_ID_RE.test(pageId) ? pageId : null;
      const off = store.subscribe(conv, after, onEvent, { userId: identity.userId, pageId: page });
      const mine = off.listener;
      const isInitiator = (run) => !!run && !!page && run.pageId === page && run.userId === identity.userId;
      // The page that initiated this round has connected: wake up calls waiting for it
      if (isInitiator(conv.run)) for (const w of [...conv.run.pageWaiters]) w();
      return () => {
        off();
        const run = conv.run;
        if (!run) return;
        // Record the moment it disconnected (grace period for brief reconnection is counted from here);
        // stop waiting for requests sent to this stream
        if (isInitiator(run)) run.pageSeenAt = now();
        failPageRequests(run, 'detached', mine);
      };
    },

    /**
     * Initiator's page returns the result of a reverse channel request (contract Section 28). Verify:
     * this chat belongs to this member (owner key), a round is running, the submitter is the `userId`
     * that initiated this round, the page id belongs to this round, and `id` is still waiting. If any
     * of the latter four is incorrect, return the same `page-request-gone` without specifying which;
     * if the chat does not belong to them (or does not exist), return null (HTTP layer responds 404,
     * matching other endpoints).
     * Valid once: removed from waiting table upon receipt; submitting the same `id` again is rejected.
     */
    pageResult(identity, conversationId, body = {}) {
      const conv = conversationOf(identity, conversationId, false);
      if (!conv) return null;
      const gone = () => new AgentServiceError('page-request-gone', 'This request is no longer being waited on.', 410);
      const run = conv.run;
      const id = typeof body.id === 'string' ? body.id : '';
      if (!run || !run.pageId || run.userId !== identity.userId || body.pageId !== run.pageId || !run.pageRequests.has(id)) throw gone();
      const out = body.ok === true
        ? { ok: true, result: body.result ?? null }
        : { ok: false, error: String(typeof body.error === 'string' && body.error ? body.error : 'The page did not complete this step').slice(0, 500) };
      if (Buffer.byteLength(JSON.stringify(out)) > MAX_PAGE_RESULT_BYTES) {
        // Do not accept payloads that are too large, but treat this request as answered (prevent Agent
        // from waiting idle until timeout)
        settlePage(run, id, { ok: true, result: { ok: false, error: 'The result returned by the page is too large and was not accepted.' } });
        throw new AgentServiceError('too-large', 'The result returned by the page is too large', 413);
      }
      if (!settlePage(run, id, { ok: true, result: out })) throw gone();
      return { ok: true };
    },

    /**
     * Stop the in-progress round in this chat. The owner can stop it from any device; others' or
     * nonexistent chats are treated as not found
     */
    abort(identity, conversationId) {
      const conv = conversationOf(identity, conversationId, false);
      conv?.run?.stop('stopped');
      return { ok: true };
    },

    /** Chats of this member (by owner key) in this project, most recently active first */
    conversations(identity) {
      checkIdentity(identity);
      return store.list(identity.projectId, ownerKeyOf(identity)).map(listItem);
    },

    /** Status of a chat; returns null if nonexistent */
    conversation(identity, conversationId) {
      const conv = conversationOf(identity, conversationId, false);
      if (!conv) return null;
      return { ...listItem({ ...conv.meta, lastSeq: conv.seq }), message: conv.meta.message ?? null, runId: conv.meta.runId ?? null };
    },

    /** Change title; returns false if this chat does not exist */
    rename(identity, conversationId, title) {
      const conv = conversationOf(identity, conversationId, false);
      if (!conv) return false;
      store.setState(conv, { title: String(title ?? '').trim().slice(0, 80) });
      return true;
    },

    /**
     * Delete chat: stop in-progress round first; delete together with model history, prerender retry
     * manifest, and working directory (attachments, downloaded files). Returns false if this chat does
     * not exist
     */
    remove(identity, conversationId) {
      const conv = conversationOf(identity, conversationId, false);
      if (!conv) return false;
      conv.run?.stop('stopped');
      const owner = instances.get(keyOf(identity));
      owner?.renderGates?.get(conversationId)?.close();
      owner?.renderGates?.delete(conversationId);
      render.forget(conv);
      store.remove(conv);
      try { workspaces.open({ projectId: identity.projectId, ownerKey: ownerKeyOf(identity), conversationId }).destroy(); } catch { /* No workspace */ }
      return true;
    },

    /**
     * Save an attachment to this chat's working directory (contract Section 9.5). Can be uploaded even
     * before the chat exists (attachments selected before sending the first message);
     * returns `{ name, url, size, kind, text? }`, where `url` is `work:attachments/<filename>`,
     * brought back with the next message's `attachments`.
     * Read-only members can also upload (attachments remain only in their own chat; whether they enter
     * the media library is determined by permissions during `import_media`).
     * @param {AsyncIterable<Buffer>} stream
     */
    async attach(identity, conversationId, name, stream) {
      checkIdentity(identity);
      checkConversationId(conversationId);
      if (closed) throw new AgentServiceError('unavailable', 'Service is shutting down', 503);
      if (!agentEnabled(identity.projectId)) throw new AgentServiceError('disabled', 'The project creator has turned off the Cloud Agent.', 403);
      if (!workspaces.available) throw new AgentServiceError('unavailable', 'This Cloud Agent service has no working directory and cannot accept attachments.', 503);
      const ws = workspaces.open({ projectId: identity.projectId, ownerKey: ownerKeyOf(identity), conversationId });
      try {
        return await saveAttachment(ws, name, stream);
      } catch (err) {
        if (err?.workspace) throw new AgentServiceError(err.code === 'quota' || err.code === 'too-large' ? 'too-large' : 'bad-request', err.message, err.code === 'quota' || err.code === 'too-large' ? 413 : 400);
        if (err?.code === 'too-large') throw new AgentServiceError('too-large', err.message, 413);
        if (err?.code === 'bad-request') throw new AgentServiceError('bad-request', err.message, 400);
        throw err;
      }
    },

    /** Usage for this project: total and per-member amounts (queryable by any member in the project) */
    usage(identity, since = null) {
      checkIdentity(identity);
      if (!usage) return { project: { tokens: 0, calls: 0 }, members: [], services: [] };
      const s = usage.summary(identity.projectId, Number.isFinite(since) ? since : null);
      const byName = new Map();
      for (const m of s.members) {
        const name = m.username || String(m.userId ?? '').split('@')[0];
        const cur = byName.get(name) ?? { username: name, tokens: 0, calls: 0 };
        cur.tokens += m.tokens; cur.calls += m.calls;
        byName.set(name, cur);
      }
      // External service calls (voiceover, etc.) are listed separately: grouped by service and provider,
      // and aggregated by username for each member
      const services = (s.services ?? []).map((sv) => {
        const people = new Map();
        for (const m of sv.members ?? []) {
          const name = m.username || String(m.userId ?? '').split('@')[0];
          const cur = people.get(name) ?? { username: name, calls: 0, units: 0 };
          cur.calls += m.calls; cur.units += m.units;
          people.set(name, cur);
        }
        return { service: sv.service, vendor: sv.vendor, calls: sv.calls, units: sv.units, unit: sv.unit, members: [...people.values()] };
      });
      return { project: s.project, members: [...byName.values()], services };
    },

    /** Content of `GET /v1/info` (contract Section 2.3) */
    async info(identity) {
      checkIdentity(identity);
      let cfg = {};
      try { cfg = (await modelConfig()) ?? {}; } catch { cfg = {}; }
      const q = gate.quotaOf?.(identity.projectId) ?? { tokens: 0, limitTokens: null };
      return {
        enabled: agentEnabled(identity.projectId),
        render: { enabled: render.enabled && renderEnabled(identity.projectId) },
        ...publicModelInfo(cfg),
        limits: { rounds: limits.rounds, runMs: limits.runMs },
        usage: { tokens: q.tokens, limitTokens: q.limitTokens, ...(q.window ? { window: q.window } : {}) },
        running: store.list(identity.projectId, ownerKeyOf(identity)).filter((m) => m.state === 'running').map((m) => m.id),
      };
    },

    /**
     * Revocation (contract Section 4.5): in affected instances, stop each in-progress round immediately
     * after recording reasons, and shut down instances. Omitted `userId` represents the entire project.
     * `reason`: `disabled` (switch disabled), `removed`, `kicked`, `deleted`. On switch disabled and project
     * deletion, revoke and clear the prerender retry manifest; on project deletion, delete chat records
     * and model history for this project (keep usage records, which are the host's ledger).
     */
    revoke({ projectId, userId = null, reason }) {
      for (const entry of [...instances.values()]) {
        if (entry.identity.projectId !== projectId) continue;
        if (userId !== null && entry.identity.userId !== userId) continue;
        for (const conv of [...entry.runs.values()]) conv.run?.stop('revoked', { reason });
        closeEntry(entry, `revoked:${reason}`);
      }
      if (reason === 'disabled' || reason === 'deleted') void render.cancelProject(projectId);
      if (reason === 'deleted') { store.removeProject(projectId); workspaces.removeProject(projectId); }
      for (const fn of [...revokeListeners]) { try { fn({ projectId, userId, reason }); } catch { /* Listener's concern */ } }
    },

    /**
     * Call `fn({ projectId, userId, reason })` when revocation occurs (`userId` as null represents entire
     * project); returns cancel function
     */
    onRevoke(fn) {
      revokeListeners.add(fn);
      return () => revokeListeners.delete(fn);
    },

    /** Diagnostics: contains no body text */
    describe() {
      return {
        instances: [...instances.values()].map((e) => ({
          projectId: e.identity.projectId,
          user: sha(e.identity.userId).slice(0, 8),
          conversations: e.runs.size,
          running: e.runs.size,
        })),
        gate: gate.describe?.() ?? null,
        render: render.describe(),
        egress: egress.describe(),
        look: look?.describe?.() ?? null,
      };
    },

    /** Testing and diagnostics: instance of a member (returns null if absent) */
    _instance(identity) {
      return instances.get(keyOf(identity))?.inst ?? null;
    },
    _render: render,
    _store: store,
    _workspaces: workspaces,
    /** Whether this process is configured with an endpoint to view frames (reported by status endpoint) */
    look: !!look,
    /** Whether this node has collection tools installed; whether it uses a test double (must be false in production) */
    collect: hostedTools.collectInstalled === true,
    collectTestRunner: collect?.testRunner === true,
    /** Whether egress gate test exceptions are enabled (reported by status endpoint; must be false in production) */
    egressTestAllow: egress.testAllowActive,

    /**
     * Finalize (SIGTERM, contract Section 3.4): no longer accept new requests → record "interrupted" for
     * each in-progress round and stop → persist state to disk → close connections.
     * Prerender retry manifests that have not finished rendering remain on disk to be redispatched upon
     * next startup.
     */
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(sweep);
      for (const entry of [...instances.values()]) {
        for (const conv of [...entry.runs.values()]) conv.run?.stop('interrupted');
        closeEntry(entry, 'service-close');
      }
      render.close();
      usage?.close();
      store.close();
    },
  };
  return api;
}
