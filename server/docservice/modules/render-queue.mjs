/**
 * Module adapter for the render queue on the document service (contracts
 * `docs/plan/render-queue-contract.md` G.4, H.3).
 *
 * - `renderQueueModule(q, { sweepMs })`: wraps a queue implemented according to the contract A.3
 *   interface into a document service module. The connection's business roles (publisher
 *   `publisherId`, render node `node`) are recorded in this module's own connection table; the core
 *   only records principal;
 * - `renderQueuePlaceholder()`: occupies the same set of message types when the queue is not yet
 *   mounted, always returning `queue-unavailable`.
 *
 * The assembly layer `service.mjs` legacy interface `mountRenderQueue` uses these two factories to
 * switch between the placeholder and real queue.
 *
 * C6.1 (H.3) adds two things here; the queue body `server/render-queue/` remains unchanged:
 * - **Coalesce key**: `task.opened`, `task.taken`, and `task.closed` emitted by the queue via
 *   `send` carry `coalesceKey: 'task:<id>'`, keeping only the latest status change when the same
 *   task backlogs on a slow connection. The queue's `send` is wired by the caller to the assembly
 *   layer's `service.send`, and the assembly layer then passes it to this module's
 *   `outbound(connId, message)` to determine send options (see below);
 * - **Summary subscription**: `queue.watch { projects: 'all', mode: 'summary' }` is handled by
 *   this module and not passed to the queue. Subscribes to channel `queue-summary:all`, computing
 *   counts for each project on each `tick` and only publishing when changed, carrying
 *   `coalesceKey: 'queue-summary'`. Connections with a summary subscription do not receive
 *   single-task deltas: this module sends `queue.watch { projects: [] }` (the queue accepts an
 *   empty array) to the queue on their behalf, so the queue stops sending any deltas to them; that
 *   `queue.snapshot` response is swallowed by `outbound`.
 *
 * M6a (`docs/plan/auth-contract.md` section 6 "Role restrictions in the queue"):
 * - `node.hello` only allows connections with `role: 'render'` and `local` identity; others return
 *   `forbidden`. Legacy principals without `scope` (test-injected `authenticate`, M5 anonymous
 *   identity) are unrestricted and behave the same as M5;
 * - When starting instances by space, a shell from `../spaces.mjs` wraps it; this module is
 *   unaware of spaces;
 * - `claimsOf(connId)`: number of claims currently held by the node on this connection, used by the
 *   "Rendering" label in the member list.
 *
 * M7 (`docs/plan/m7-contract.md` section 13 ruling) before passing `node.hello` to the queue:
 * - D9 render ticket with `owner: { kind: 'browser' }` connection (pure browser node connection
 *   opened by page): profile is fixed to `browser`, self-reporting anything else always returns
 *   `forbidden`; if nodeId is already bound to another userId (the queue's `nodeUserOf`), returns
 *   `forbidden`, and this connection does not record the node role;
 * - D10 `environment: { platform, userAgent, renderer, vendor }` (raw values reported by the page,
 *   `src/editor/pageEnvironment.mjs`) is used here to compute fingerprint via `describeEnvironment`,
 *   written into `envFingerprint` passed to the queue (`node.welcome` returns it to page):
 *   connections with browser ownership are always computed this way and self-reported values do not
 *   count; if environment is not reported, returns `bad-message`; other connections only compute it
 *   this way when no fingerprint was self-reported;
 * - D14 checking in as `browser`, reporting environment while UA is not Chromium-based: returns
 *   `error { reason: 'not-chromium' }` and does not act as a node.
 */
import { QUEUE_DEFAULTS } from '../../render-queue/constants.mjs';
import { parseInbound, makeMessage, prioritySummaryValue, NODE_TYPES, PUBLISHER_TYPES } from '../../render-queue/messages.mjs';
import { describeEnvironment, describeCardEnvironment, isChromiumUserAgent } from '../../render-node/fingerprint.mjs';
import { deviceRank } from '../../render-node/session.mjs';
import { tr } from '../../i18n.mjs';

export const RENDER_QUEUE_MODULE = 'render-queue';

/** Summary channel (H.3): prefix declared by this module; core only recognizes strings */
const SUMMARY_PREFIX = 'queue-summary';
const SUMMARY_CHANNEL = `${SUMMARY_PREFIX}:all`;
const SUMMARY_KEY = 'queue-summary';
/**
 * reqId used for `queue.watch` sent to queue on behalf of connection when switching to summary;
 * its response is swallowed by `outbound` and will not reach the client
 */
const SILENT_WATCH_REQ = '\u0000summary-switch';

/** Message types passed to queue for handling: taken from `messages.mjs` exports, not hardcoded */
function queueTypes() {
  return [...new Set(['node.hello', 'publisher.hello', ...NODE_TYPES, ...PUBLISHER_TYPES])];
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

const NO_ROLES = () => ({ roles: [], publisherId: null, node: null });

/**
 * Whether this principal can check in as a render node: `render` role, `local` identity, and legacy
 * identity without `scope`
 */
export function mayRegisterNode(principal) {
  if (!principal || principal.scope === undefined) return true;
  return principal.scope === 'local' || principal.role === 'render';
}

/**
 * Whether render ticket ownership is a pure browser node (M7 D9: page signs render ticket with
 * `owner: { kind: 'browser' }`)
 */
export const isBrowserOwned = (principal) => principal?.owner?.kind === 'browser';

/** Maximum length for each raw environment value reported by page (UA and WebGL strings are far below it) */
const ENV_FIELD_MAX = 1024;
const ENV_FIELDS = ['platform', 'userAgent', 'renderer', 'vendor'];

/**
 * `environment` of `node.hello` (M7 D10): object, four optional items, must be strings, each
 * ≤ 1024 characters; missing items default to empty strings. Returns null if invalid.
 */
function environmentOf(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of ENV_FIELDS) {
    const x = v[k];
    if (x === undefined || x === null) { out[k] = ''; continue; }
    if (typeof x !== 'string' || x.length > ENV_FIELD_MAX) return null;
    out[k] = x;
  }
  return out;
}

/**
 * M7 D9, D10, D14: determines profile and fingerprint here before passing `node.hello` to queue.
 * Returns `{ msg }` (possibly with rewritten `envFingerprint`) or `{ error: { reason, detail } }`.
 */
function admitNodeHello(principal, msg, nodeUserOf) {
  const browserOwned = isBrowserOwned(principal);
  if (browserOwned && msg.profile !== 'browser') {
    return { error: { reason: 'forbidden', detail: 'A pure-browser node connection can only check in as browser' } };
  }
  let out = msg;
  if (msg.environment !== undefined && msg.environment !== null) {
    const env = environmentOf(msg.environment);
    if (!env) return { error: { reason: 'bad-message', detail: 'environment must be a { platform, userAgent, renderer, vendor } string' } };
    if (msg.profile === 'browser' && !isChromiumUserAgent(env.userAgent)) {
      return { error: { reason: 'not-chromium', detail: tr("In phase 1, only Chromium-based browsers can serve as render nodes") } };
    }
    const own = msg.envFingerprint;
    if (browserOwned || own === undefined || own === null || own === '') {
      const envFingerprint = describeEnvironment({ platform: env.platform, renderer: env.renderer, vendor: env.vendor, chromeVersion: env.userAgent }).fingerprint;
      out = { ...msg, envFingerprint };
    }
    // Chunk N (`docs/plan/online-card-exec-contract.md` section 7 item 2): fingerprint used by pure browser
    // nodes executing user cards and media effect cards = three environment values plus the "online card
    // runtime version" (`msg.cardRuntime`) reported by page, also computed here; self-reported values do
    // not count; missing or invalid values result in no such fingerprint.
    // Connections with other profiles or without environment always omit this entry: only browser nodes
    // have it. `envFingerprint` remains untouched word-for-word.
    const { cardRuntime, ...rest } = out;
    out = rest;
    if (msg.profile === 'browser') {
      const cardEnv = describeCardEnvironment({ platform: env.platform, renderer: env.renderer, vendor: env.vendor, chromeVersion: env.userAgent, cardRuntime });
      out = { ...out, cardEnvFingerprint: cardEnv.cardEnvFingerprint };
    } else {
      const { cardEnvFingerprint: _own, ...others } = out;
      out = others;
    }
  } else if (browserOwned) {
    return { error: { reason: 'bad-message', detail: 'A pure-browser node must report environment (the page\'s raw environment values); the document service computes the fingerprint' } };
  }
  if (msg.environment === undefined || msg.environment === null) {
    // Without raw environment values, fingerprint cannot be computed: self-reported cardRuntime and
    // cardEnvFingerprint do not count
    const { cardRuntime: _r, cardEnvFingerprint: _c, ...bare } = out;
    out = bare;
  }
  const bound = typeof nodeUserOf === 'function' && typeof msg.nodeId === 'string' ? nodeUserOf(msg.nodeId) : null;
  if (bound !== null && principal && bound !== principal.userId) {
    return { error: { reason: 'forbidden', detail: 'This nodeId belongs to another user' } };
  }
  return { msg: out };
}

/** Message types claimed by queue module (also used by shell when starting instances by space) */
export const RENDER_QUEUE_TYPES = Object.freeze(queueTypes());

/** Messages by coalesce key: extracts task id (H.3); other messages return null, without key */
function coalesceIdOf(message) {
  switch (message.type) {
    case 'task.opened':
      return isObj(message.task) && typeof message.task.id === 'string' ? message.task.id : null;
    case 'task.taken':
    case 'task.closed':
      return typeof message.id === 'string' ? message.id : null;
    default:
      return null;
  }
}

/**
 * Task fingerprint group key: `requires.envFingerprint`; missing (or not a non-empty string) recorded
 * under `''`
 */
function fingerprintOf(requires) {
  const fp = isObj(requires) ? requires.envFingerprint : undefined;
  return typeof fp === 'string' ? fp : '';
}

/**
 * @param {{ connect: Function, disconnect: Function, handle: Function, tick: Function, epoch?: string, describe?: Function }} q
 *   Queue interface from contract A.3, with `send` at construction wired to document service `send`
 * @param {{ sweepMs?: number }} [options] Interval between `tick` calls
 */
export function renderQueueModule(q, { sweepMs = QUEUE_DEFAULTS.SWEEP_INTERVAL_MS } = {}) {
  for (const m of ['connect', 'disconnect', 'handle', 'tick']) {
    if (typeof q?.[m] !== 'function') throw new TypeError(`queueInterface.${m} must be a function`);
  }
  /** connId → { principal, publisherId, node, summary } */
  const conns = new Map();
  /** Connections subscribed to summary */
  const summaryConns = new Set();
  /**
   * `projects` (JSON) last published to summary channel; cleared when there are no subscribers,
   * guaranteed to publish on first tick after someone subscribes again
   */
  let lastSummary = null;

  /**
   * Task id → { priority, fp }: priority and fingerprint needed by summary. Not present in
   * `q.describe()`, so recorded from inbound `task.publish` at publish time; authoritative value
   * comes from `task.published` response with `created: true` (tasks rebuilt after TTL will get new
   * values). Pruned on each summary calculation based on tasks still present in `describe()`.
   */
  const infos = new Map();
  let infosPrunedAt = 0;
  /**
   * A publish currently being passed to queue: { connId, pending: Map<id, info> }; processed
   * synchronously by queue, cleared once finished
   */
  let publishing = null;
  /** Silent `queue.watch` currently being sent on behalf of connection: { connId } */
  let silencing = null;

  function recordRole(ctx, connId, conn, type, body) {
    if (type === 'publisher.hello') {
      conn.publisherId = body.publisherId;
      ctx.log('role.publisher', { connId, publisherId: body.publisherId, userId: conn.principal.userId });
      return;
    }
    conn.node = {
      nodeId: body.nodeId,
      profile: body.profile,
      envFingerprint: body.envFingerprint,
      capabilities: body.capabilities,
      codeVersions: body.codeVersions,
      maxConcurrent: body.maxConcurrent,
      planOnly: body.planOnly === true,
      projectStreams: body.projectStreams ?? null,
      streams: body.streams ?? null,
    };
    ctx.log('role.node', { connId, nodeId: body.nodeId, profile: body.profile, userId: conn.principal.userId });
  }

  function rolesOf(conn) {
    const roles = [];
    if (conn.publisherId !== null) roles.push('publisher');
    if (conn.node) roles.push('node');
    return roles;
  }

  function reply(ctx, connId, type, fields, reqId) {
    ctx.send(connId, makeMessage(q.epoch ?? null, type, fields, reqId));
  }

  // ---------- Summary (H.3) ----------

  /**
   * Computes counts for each project according to `q.describe()`; only lists projects with open or
   * claimed tasks, in ascending order of projectId
   */
  function summarize() {
    const d = typeof q.describe === 'function' ? q.describe() : { tasks: [] };
    const tasks = Array.isArray(d?.tasks) ? d.tasks : [];
    const byProject = new Map();
    const alive = new Set();
    for (const t of tasks) {
      alive.add(t.id);
      if (t.state !== 'open' && t.state !== 'claimed') continue;
      let p = byProject.get(t.projectId);
      if (!p) {
        p = { projectId: t.projectId, open: 0, claimed: 0, topPriority: null, fps: new Map() };
        byProject.set(t.projectId, p);
      }
      if (t.state === 'claimed') {
        p.claimed += 1;
        continue;
      }
      p.open += 1;
      const info = infos.get(t.id);
      if (info && (p.topPriority === null || info.priority > p.topPriority)) p.topPriority = info.priority;
      const fp = info ? info.fp : '';
      p.fps.set(fp, (p.fps.get(fp) ?? 0) + 1);
    }
    for (const id of infos.keys()) if (!alive.has(id)) infos.delete(id);
    infosPrunedAt = infos.size;
    const projects = [...byProject.values()]
      .sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0))
      .map((p) => ({
        projectId: p.projectId,
        open: p.open,
        claimed: p.claimed,
        topPriority: p.topPriority,
        openByFingerprint: Object.fromEntries([...p.fps.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))),
      }));
    return projects;
  }

  function summaryMessage(ctx, projects, reqId) {
    return makeMessage(q.epoch ?? null, 'queue.summary', { at: ctx.now(), projects }, reqId);
  }

  function publishSummary(ctx) {
    if (summaryConns.size === 0) {
      lastSummary = null;
      // No need to compute every time when no one subscribes to summary; prune when registered publish
      // info grows significantly, preventing it from growing indefinitely
      if (infos.size > infosPrunedAt * 2 + 1024) summarize();
      return;
    }
    const projects = summarize();
    const json = JSON.stringify(projects);
    if (json === lastSummary) return;
    lastSummary = json;
    ctx.publish(SUMMARY_CHANNEL, summaryMessage(ctx, projects), { coalesceKey: SUMMARY_KEY });
  }

  function watchSummary(ctx, connId, conn, msg) {
    const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
    if (msg.projects !== 'all') {
      return reply(ctx, connId, 'error', { reason: 'bad-message', detail: "projects in a digest subscription must be 'all'" }, reqId);
    }
    if (!conn?.node) return reply(ctx, connId, 'error', { reason: 'not-registered' }, reqId);
    // Pure browser only sees own tasks; summary would leak other people's projects
    if (conn.node.profile === 'browser') return reply(ctx, connId, 'error', { reason: 'forbidden' }, reqId);

    // Stop queue from sending single-task deltas: watch empty project list on its behalf, response is
    // swallowed by outbound
    silencing = { connId };
    try {
      q.handle(connId, { type: 'queue.watch', projects: [], reqId: SILENT_WATCH_REQ });
    } finally {
      silencing = null;
    }
    ctx.subscribe(connId, SUMMARY_CHANNEL);
    conn.summary = true;
    summaryConns.add(connId);
    ctx.send(connId, summaryMessage(ctx, summarize(), reqId));
  }

  function leaveSummary(ctx, connId, conn) {
    if (!conn?.summary) return;
    conn.summary = false;
    summaryConns.delete(connId);
    ctx.unsubscribe(connId, SUMMARY_CHANNEL);
  }

  // ---------- Publish info (priority and fingerprint for summary) ----------

  function handlePublish(connId, msg) {
    const parsed = parseInbound(msg);
    if (!parsed.ok) return q.handle(connId, msg);
    const pending = new Map();
    // c10a contract section 17: `priority` can be 'normal' / 'backfill'; summary only compares numbers
    // (prerender retry tier counts as -1)
    for (const t of parsed.body.tasks) pending.set(t.id, { priority: prioritySummaryValue(t.priority), fp: fingerprintOf(t.requires) });
    publishing = { connId, pending, seen: false };
    try {
      q.handle(connId, msg);
    } finally {
      const done = publishing;
      publishing = null;
      // Fallback when queue send is not connected to this module (response not seen): unregistered ids
      // are recorded from this publish
      if (!done.seen) {
        for (const [id, info] of done.pending) if (!infos.has(id)) infos.set(id, info);
      }
    }
  }

  // ---------- Cross-layer preemption (more capable device takes over stream tasks in progress by a less capable device) ----------

  /** Which connection this nodeId is currently checked in on: `{ connId, node }`; returns null if offline */
  function connOfNode(nodeId) {
    if (typeof nodeId !== 'string') return null;
    for (const [connId, c] of conns.entries()) if (c.node?.nodeId === nodeId) return { connId, node: c.node };
    return null;
  }
  const nodeById = (nodeId) => connOfNode(nodeId)?.node ?? null;

  /**
   * When claiming a stream task currently in progress by another party, only if the claiming party
   * has a higher device tier and passes all qualifications does it release the original holder's
   * claim on its behalf, send `task.lease-lost { reason: 'preempted' }`, and claim under the new
   * version; returns true. If any check fails, returns false: original holder is left untouched,
   * claim is passed to the queue as usual, queue rejects with `taken` / `throttled`, and claiming
   * party's in-flight claim is thereby cleared.
   * Qualifications (verified first before touching original holder):
   *   - Claiming party can see this task (`claimedStreamsFor`: watches this project, pre-filtered by
   *     fingerprint; hosted nodes only preempt within projects they checked into);
   *   - Queue is not currently throttling claiming party (`throttled` in its `describe().nodes`;
   *     when throttled, queue always returns throttled for its claims, so original holder cannot be
   *     kicked first);
   *   - Claiming party can produce track streams; hosted nodes do not preempt when project disabled
   *     "generate track streams"; planOnly nodes do not preempt;
   *   - Environment fingerprint matches; local media gate (`requires.localMedia`) passes.
   */
  function tryPreempt(ctx, connId, conn, msg) {
    const node = conn?.node;
    const claimerRank = deviceRank(node);
    if (claimerRank <= 1 || typeof q.describe !== 'function' || typeof q.claimedStreamsFor !== 'function') return false;
    const [entry] = q.claimedStreamsFor(connId, msg.id);
    if (!entry) return false;
    const holder = connOfNode(entry.holderNodeId);
    if (!holder || claimerRank <= deviceRank(holder.node)) return false;
    const d = q.describe();
    const target = (Array.isArray(d?.tasks) ? d.tasks : []).find((t) => t.id === msg.id);
    if (!target || target.state !== 'claimed' || !target.claim || target.claim.nodeId !== entry.holderNodeId) return false;
    const me = (Array.isArray(d?.nodes) ? d.nodes : []).find((n) => n.nodeId === node.nodeId);
    if (me?.throttled === true) return false;
    const caps = node.capabilities ?? {};
    const hasStreams = caps.streams === true || (caps.streams !== false && (node.profile === 'pc' || caps.transcode === true));
    if (!hasStreams || node.planOnly === true) return false;
    const projectId = entry.task.source?.projectId;
    if (node.profile === 'host' && (node.projectStreams?.[projectId] ?? node.streams) === false) return false;
    const requires = entry.task.requires ?? {};
    if (requires.envFingerprint && node.envFingerprint && requires.envFingerprint !== node.envFingerprint) return false;
    if (requires.localMedia && requires.localMedia !== node.nodeId) return false;
    const oldToken = target.claim.token;
    q.handle(holder.connId, { type: 'task.release', id: target.id, token: oldToken, reason: 'preempted' });
    ctx.send(holder.connId, makeMessage(q.epoch ?? null, 'task.lease-lost', { id: target.id, token: oldToken, reason: 'preempted' }));
    q.handle(connId, { ...msg, expectVersion: target.version + 1 });
    return true;
  }

  return {
    name: RENDER_QUEUE_MODULE,
    types: queueTypes(),
    channels: [SUMMARY_PREFIX],
    tickMs: sweepMs,

    connect(ctx, connId, principal) {
      conns.set(connId, { principal, publisherId: null, node: null, summary: false });
      q.connect(connId, principal);
    },

    disconnect(ctx, connId) {
      const conn = conns.get(connId);
      conns.delete(connId);
      summaryConns.delete(connId);
      q.disconnect(connId);
      if (conn && (conn.publisherId !== null || conn.node)) {
        ctx.log('role.close', { connId, publisherId: conn.publisherId, nodeId: conn.node?.nodeId ?? null });
      }
    },

    handle(ctx, connId, msg) {
      const conn = conns.get(connId);
      if (msg.type === 'queue.watch') {
        if (msg.mode === 'summary') return watchSummary(ctx, connId, conn, msg);
        if (msg.mode !== undefined && msg.mode !== 'full') {
          const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
          return reply(ctx, connId, 'error', { reason: 'bad-message', detail: "mode must be 'full' or 'summary'" }, reqId);
        }
        // Full watch: latest takes precedence; if valid, unsubscribe from summary first, then pass to queue
        // as usual
        if (conn?.summary && parseInbound(msg).ok) leaveSummary(ctx, connId, conn);
        return q.handle(connId, msg);
      }
      if (msg.type === 'node.hello' && !mayRegisterNode(conn?.principal)) {
        const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
        return reply(ctx, connId, 'error', { reason: 'forbidden', detail: 'Only connections with the render role can check in as a render node' }, reqId);
      }
      if (msg.type === 'node.hello') {
        // M7 D9 / D10 / D14: profile bound to credential, fingerprint computed here from raw environment
        // values, non-Chromium cannot act as node
        const admitted = admitNodeHello(conn?.principal, msg, typeof q.nodeUserOf === 'function' ? q.nodeUserOf : null);
        if (admitted.error) {
          const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
          ctx.log('role.node-refused', { connId, reason: admitted.error.reason, userId: conn?.principal?.userId ?? null });
          return reply(ctx, connId, 'error', admitted.error, reqId);
        }
        msg = admitted.msg;
      }
      // hello is answered with welcome by queue; this records connection role only when message is valid
      // (queue uses same validation)
      if (conn && (msg.type === 'node.hello' || msg.type === 'publisher.hello')) {
        const parsed = parseInbound(msg);
        if (parsed.ok) recordRole(ctx, connId, conn, parsed.type, { ...msg, ...parsed.body });
      }
      if (msg.type === 'node.active') {
        const busy = typeof msg.busy === 'string' ? msg.busy : null;
        if (busy === 'scrub' || busy === 'drag' || busy === 'play') {
          const nodeId = conns.get(connId)?.node?.nodeId;
          if (nodeId && typeof q.describe === 'function') {
            const d = q.describe();
            const heldStreams = (Array.isArray(d?.tasks) ? d.tasks : []).filter(
              (t) => t.state === 'claimed' && t.claim?.nodeId === nodeId && typeof t.id === 'string' && t.id.startsWith('stream:')
            );
            for (const t of heldStreams) {
              const currentStep = t.claim?.progress?.step ?? 0;
              q.handle(connId, {
                type: 'task.progress',
                id: t.id,
                token: t.claim.token,
                done: t.claim?.progress?.done ?? null,
                step: currentStep + 1,
              });
            }
          }
        }
      }
      if (msg.type === 'task.claim' && typeof msg.id === 'string' && msg.id.startsWith('stream:') && tryPreempt(ctx, connId, conn, msg)) return;
      if (msg.type === 'task.publish') return handlePublish(connId, msg);
      q.handle(connId, msg);
    },

    tick(ctx) {
      q.tick();
      publishSummary(ctx);
    },

    /**
     * Legacy assembly layer interface `service.send` (queue `send`) determines send options via this:
     * returns `{ coalesceKey? }`; returns null to indicate this message is not sent (response to silent
     * watch sent on behalf of connection). Not a G.3 module interface, only used for assembly layer
     * facade.
     */
    outbound(connId, message) {
      if (!isObj(message)) return {};
      if (silencing && silencing.connId === connId && message.type === 'queue.snapshot' && message.reqId === SILENT_WATCH_REQ) {
        return null;
      }
      if (publishing && publishing.connId === connId && message.type === 'task.published' && Array.isArray(message.results)) {
        publishing.seen = true;
        for (const r of message.results) {
          if (!isObj(r) || r.created !== true) continue;
          const info = publishing.pending.get(r.id);
          if (info) infos.set(r.id, info);
        }
      }
      // Preemption info for in-flight stream tasks (used by more capable nodes to determine if they can
      // preempt): only provided to connections that can see it (`claimedStreamsFor`, same visibility as
      // open tasks), with only minimum fields needed for decision; excludes claim token; pure browser
      // gets nothing (does not preempt others)
      if (message.type === 'task.taken' && typeof message.id === 'string' && message.id.startsWith('stream:')) {
        const [entry] = typeof q.claimedStreamsFor === 'function' ? q.claimedStreamsFor(connId, message.id) : [];
        const holder = entry ? nodeById(entry.holderNodeId) : null;
        message.holderProfile = holder?.profile ?? null;
        message.holderRank = holder ? deviceRank(holder) : null;
        message.density = message.id.endsWith(':sparse') ? 'sparse' : null;
        if (entry) message.task = entry.task;
      }
      if (message.type === 'queue.snapshot') {
        const entries = typeof q.claimedStreamsFor === 'function' ? q.claimedStreamsFor(connId) : [];
        message.claimedStreams = entries.map(({ task, holderNodeId }) => {
          const holder = nodeById(holderNodeId);
          return {
            id: task.id, version: task.version, holderProfile: holder?.profile ?? null, holderRank: holder ? deviceRank(holder) : null,
            density: task.input?.density === 'sparse' ? 'sparse' : null, task,
          };
        });
      }
      const id = coalesceIdOf(message);
      return id === null ? {} : { coalesceKey: `task:${id}` };
    },

    /**
     * Immediately releases all claims held by this connection's node (not a G.3 module interface):
     * sends `task.release` on its behalf for each, immediately returning tasks to unclaimed without
     * waiting for disconnect grace period. Used when toggling off host render node
     * (`docs/plan/hosted-render-contract.md` section 3). Returns count of released claims
     */
    releaseClaims(connId, reason = 'released') {
      const nodeId = conns.get(connId)?.node?.nodeId;
      if (!nodeId || typeof q.describe !== 'function') return 0;
      const d = q.describe();
      const held = (Array.isArray(d?.tasks) ? d.tasks : []).filter((t) => t.state === 'claimed' && t.claim?.nodeId === nodeId);
      for (const t of held) q.handle(connId, { type: 'task.release', id: t.id, token: t.claim.token, reason });
      return held.length;
    },

    /**
     * Number of claims currently held by this connection's node (not a G.3 module interface, used by
     * member list)
     */
    claimsOf(connId) {
      const nodeId = conns.get(connId)?.node?.nodeId;
      if (!nodeId || typeof q.describe !== 'function') return 0;
      const d = q.describe();
      return (Array.isArray(d?.tasks) ? d.tasks : []).filter((t) => t.state === 'claimed' && t.claim?.nodeId === nodeId).length;
    },

    describeConn(connId) {
      const conn = conns.get(connId);
      if (!conn) return NO_ROLES();
      return {
        roles: rolesOf(conn),
        publisherId: conn.publisherId,
        node: conn.node ? structuredClone(conn.node) : null,
      };
    },

    health() {
      const list = [...conns.values()];
      return {
        queue: true,
        publishers: list.filter((c) => c.publisherId !== null).length,
        nodes: list.filter((c) => c.node).length,
        epoch: q.epoch ?? null,
      };
    },

    describe() {
      return typeof q.describe === 'function' ? q.describe() : { epoch: q.epoch ?? null };
    },
  };
}

/**
 * Placeholder when queue is not yet mounted: claims all queue types, always returns
 * `queue-unavailable`
 */
export function renderQueuePlaceholder() {
  return {
    name: RENDER_QUEUE_MODULE,
    types: queueTypes(),

    handle(ctx, connId, msg) {
      const out = { type: 'error', reason: 'queue-unavailable', detail: tr("The render queue is not attached yet") };
      if (isReqId(msg.reqId)) out.reqId = msg.reqId;
      ctx.send(connId, out);
    },

    describeConn: NO_ROLES,

    health() {
      return { queue: false, publishers: 0, nodes: 0 };
    },

    describe() {
      return null;
    },
  };
}
