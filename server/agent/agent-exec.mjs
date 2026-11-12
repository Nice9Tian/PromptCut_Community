/**
 * Tool executor on the Agent server side (C6.5 design doc `docs/plan/c65-design.md` sections 5 and 7;
 * `cloud-task.md` D1, D2, D4).
 *
 * **Write tools execute on project replicas** (D1): tools with `side: "agent"` no longer go through
 *   the page. Inside a serial lock, the executor:
 *   1. Puts current content of replica (`doc-link.mjs`) into server-side store (`ssr-host.mjs`),
 *   2. Runs the same implementation in `src/mcp/handlers`,
 *   3. `diffProject(replica, executed project)` computes operations and commits them via this Agent
 *      chat's connection (write identity = agent + chat number), with `expectRev` set to **the version
 *      last read by this chat** (`rev` in read tool responses, or version when last write landed);
 *   4. Once landed, hands operations over to the replica, and tool response carries new `rev`; if
 *      rejected (`stale`), returns error with who modified which entities in the interim, letting
 *      Agent re-read before modifying again.
 *   When the handler throws an error, this change is invalidated entirely (not committed).
 *
 * **Read tools execute on replicas** (D4): `get_project`, `get_layout`, `see_frames` (final video),
 *   `get_gif`, `bake_card`, and `inspect_card_dom` read replica and query prerender process without
 *   going through the page; responses carry `rev` and record it as the version read by this chat
 *   (read-after-write consistency).
 *
 * **Tool call events** (D2): each tool call sends "create" and "complete" events to document
 *   service's `events` module via this chat's connection; complete arguments go into content
 *   store `event-detail`; for those that wrote to the project, "complete" includes the write's `opId`,
 *   `rev`, and inverse operation (`write`), based on which the page AI panel's "Undo this step" commits
 *   the inverse operation under the page's own identity with `undoOf` (design doc section 8).
 *
 * No dependency on vite: tool implementations obtained via `loadHost()` (`ssr-host.mjs`), and
 * prerendering queried via `prerenderPost`, both injected by caller.
 */
import { randomUUID } from 'node:crypto';
import { annotateResult, clipIdsOfOps, overwroteView } from './user-editing.mjs';
import { parkedCutsIndex, cutLookView } from './ssr-host.mjs';
import { modelToolName } from '../tools/ui-names.mjs';

export const AGENT_EXEC_DEFAULTS = Object.freeze({
  /** After rejection (stale), wait for replica to catch up to doc service current version so Agent immediately reads latest */
  staleWaitMs: 2_000,
  /** Max wait time when project has no live entity in doc service (page just connected and hasn't written project yet) */
  bodyWaitMs: 5_000,
  /** Wait for replica to catch up to this version after write lands */
  landWaitMs: 5_000,
  /**
   * After a commit (`project.op`) times out waiting for a response (connection's `requestTimeoutMs`,
   * 15 seconds), resend the same opId as-is a few times. Commits queue up to land per project
   * (account projects must pass sequence service and authorization checks); when render nodes and
   * frame viewing run concurrently, queuing can take dozens of seconds; the document service
   * deduplicates by opId: already landed commits return `project.op.ok` (`duplicate: true`), while
   * those still queuing line up behind it to land together: so resending will not land twice, but only
   * clarifies "whether this commit actually landed or not". Online 2026-10-21: switch_cut reported
   * failure when no response returned after waiting 15 seconds the first time, but actually landed
   * about 60 seconds later (`docs/archive/agent-reports/AGENT-cut-stream-fix.md` bug 5).
   */
  opResends: 4,
  /** Page-side tools wrote to project: wait for these commits to appear in replica */
  pageWritesWaitMs: 3_000,
  /** Chat panel "visible results": max wait time when submitting visualization records */
  visualTimeoutMs: 3_000,
  /** Upper limit for argument summary in events (characters, limit of event module `ARGS`) */
  eventArgsMax: 2048,
  /** Do not store in event-detail if full args exceed this many bytes (content store limit 256 KiB) */
  detailMaxBytes: 200 * 1024,
  /** Do not include inverse operation in "complete" event if exceeding bytes (event module `EVENTS_LIMITS.INVERSE`) */
  inverseMaxBytes: 256 * 1024,
  /** Max commit size (doc service `PROJECT_LIMITS.MAX_OPS_BYTES`); if exceeded, switch to root replacement via `project.upload` */
  maxOpsBytes: 256 * 1024,
  /** Characters per part for `project.upload` (UTF-8 worst-case 4 B, <= doc service 512 KiB limit; same as page DocSync) */
  uploadPartChars: 128 * 1024,
  /** Max parts for `project.upload` (document service `PROJECT_LIMITS.UPLOAD_MAX_PARTS`) */
  uploadMaxParts: 64,
  /** Max wait time when requesting page state from the page */
  pageStateTimeoutMs: 10_000,
  /** Max commits to list in stale summary, and max entities per commit */
  staleShowCommits: 8,
  staleShowEntities: 6,
});

/** Card modify / delete / create tools: chat panel renders before/after cards (same criterion as page mcpExecutor withVisual) */
const CLIP_EDIT_TOOLS = new Set([
  'update_clip', 'set_clip', 'set_position', 'set_rect', 'align', 'nudge', 'set_emphasis',
  'add_part', 'set_part', 'remove_part', 'move_part',
]);
const CLIP_CREATE_TOOLS = new Set(['add_clip', 'duplicate_clip', 'add_composite']);

/**
 * Tools that both read page-exclusive state and write to the project (c65-integ2 ruling: violates
 * D1 criterion; changed so writes execute on Agent server side under agent identity, requesting
 * needed page state once from the page as read-only values via existing SSE page channel). Values
 * are keys to request from the page:
 *   - `t`: page playhead. Switching cuts (`user_interface_switch_cut`, `remove_cut` deleting the
 *     current cut) needs to save it back to the parked cut (`add_cut` only creates without
 *     switching since 2026-10-21, no longer needing playhead);
 *   - `track`: trajectory produced by `track_points` in page memory (`attach_clip_motion` reads
 *     it to compute frame-by-frame coordinates).
 * `set_project_meta` does not read page state (manual truncation value of `duration` is derived by
 * the page itself from the project upon receiving remote changes; see `src/store/remotePageState.ts`),
 * so it is not in this table and executes directly on the server side.
 * "Writing" page state (page playhead, selection, pausing playback after switching cuts) is likewise
 * performed by the page itself upon receiving remote changes, without going through this channel.
 */
export const PAGE_STATE_TOOLS = Object.freeze({
  user_interface_switch_cut: Object.freeze(['t']),
  remove_cut: Object.freeze(['t']),
  attach_clip_motion: Object.freeze(['track']),
});

/** Read tools with separate server-side implementations that bypass the routing table */
export const SERVER_READ_TOOLS = Object.freeze(['get_project', 'get_layout', 'see_frames', 'get_gif', 'bake_card', 'inspect_card_dom']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');

export class StaleWriteError extends Error {
  constructor(message, info) {
    super(message);
    this.code = 'stale';
    this.stale = info;
  }
}

/** Write identity → human-readable description */
export function describeActor(actor) {
  if (!actor || typeof actor !== 'object') return 'Unknown writer';
  if (actor.role === 'agent') return `Agent chat ${actor.conversation ?? '?'}${actor.session ? `(${actor.session})` : ''}`;
  if (actor.role === 'page') return `Page${actor.userId && actor.userId !== 'local' ? `(${actor.userId})` : ''}`;
  if (actor.role === 'render') return 'Render node';
  return actor.userId ? `User ${actor.userId}` : 'Unknown writer';
}

/** stale response → tool error message (who modified which entities) */
export function staleMessage({ expectRev, currentRev, since = [], sinceComplete = true }, limits = AGENT_EXEC_DEFAULTS) {
  const shown = since.slice(-limits.staleShowCommits);
  const lines = shown.map((s) => {
    const ents = Array.isArray(s.entities) && s.entities.length ? s.entities : (Array.isArray(s.paths) ? s.paths : []);
    const list = ents.slice(0, limits.staleShowEntities).join(', ') + (ents.length > limits.staleShowEntities ? ` and ${ents.length} more` : '');
    return `  rev ${s.rev}: ${describeActor(s.actor)}${s.undoOf ? '(undo)' : ''} changed ${list || '(no entity changes)'}`;
  });
  const omitted = since.length - shown.length;
  return [
    `The project was changed after your last read: you read rev ${expectRev}, it is now rev ${currentRev}. This write was not applied.`,
    ...(lines.length ? ['Changes in the meantime:', ...lines] : []),
    ...(omitted > 0 || !sinceComplete ? [`  (and ${omitted > 0 ? omitted : 'a few'} earlier ones not listed)`] : []),
    'Re-read the current state first (get_project, get_clip, get_layout, etc.) to confirm it, then decide how to change it.',
  ].join('\n');
}

/**
 * What total project duration should be after an Agent write on server side (C6.5 wrap-up ruling:
 * accompanying total duration updates are committed with same batch of ops in this write, and the
 * page does not follow up with an extra write upon receiving it; otherwise that follow-up write by
 * the page would be under page identity, causing this chat's next write to be rejected once due to
 * version mismatch).
 *
 * The rule is the existing one on the page (`src/kernel/duration.ts`; on the page side, timeline
 * effect computes it via `effectiveDuration` and writes via `syncDuration`, at least 1 s); here
 * it is simply executed on the server-side replica:
 *   - Server lacks manual truncation value (page state), so it is derived from project itself: if
 *     this write changed total duration (`set_project_meta` truncation), derive from after state,
 *     otherwise from before state; this is the same `manualDurationFor` used by `pageStateAfterRemote`
 *     when the page receives remote changes;
 *   - Only calculated when clips or total duration changed (page timeline effect only runs for these
 *     two as well); writes that only rename, etc., do not touch total duration.
 * Returns the project that should be committed; returns `after` as-is when no modification is needed.
 *
 * @param {object} before Replica before changes
 * @param {object} after Project after handler runs
 * @param {{ contentEndOf: Function, effectiveDuration: Function, manualDurationFor: Function }} rules `src/kernel/duration.ts`
 */
export function settleDuration(before, after, rules) {
  if (!isPlainObject(after) || !isPlainObject(before) || !rules) return after;
  if (after.tracks === before.tracks && after.duration === before.duration) return after;
  const current = Number(after.duration);
  if (!Number.isFinite(current)) return after;
  const end = rules.contentEndOf(after.tracks ?? []);
  const manual = after.duration !== before.duration
    ? rules.manualDurationFor(current, end)
    : rules.manualDurationFor(Number(before.duration), rules.contentEndOf(before.tracks ?? []));
  const target = rules.effectiveDuration(end, current, manual);
  // Same gate as timeline effect + `syncDuration`: do not write if diff < 1e-6, at least 1 s when writing
  if (Math.abs(target - current) <= 1e-6) return after;
  const val = Math.max(1, target);
  if (Math.abs(val - current) < 1e-6) return after;
  return { ...after, duration: val };
}

/** Include version in tool response; arrays and non-objects returned as-is (preserving shape) */
function withRev(result, rev) {
  if (!isPlainObject(result) || Object.hasOwn(result, 'rev')) return result;
  return { ...result, rev };
}

/** Response shape of get_project (same as getProject in page handlers/project.ts: transcript gives only a summary) */
export function projectView(project) {
  // Put clip index of parked cuts first: tracks is only for the active cut; for the model to
  // modify clips in other cuts, it needs clipId first, without which it calls switch_cut
  const parkedCuts = parkedCutsIndex(project);
  return {
    ...(parkedCuts ? { parkedCuts } : null),
    ...project,
    media: (project.media || []).map((m) => (m?.transcript ? {
      ...m,
      transcript: {
        engine: m.transcript.engine, model: m.transcript.model, language: m.transcript.language,
        createdAt: m.transcript.createdAt, segments: m.transcript.segments?.length ?? 0,
        hint: 'Use get_transcript for the full transcript',
      },
    } : m)),
  };
}

/**
 * `cutId` of `see_frames` → project view passed to render (`cutLookView` in
 * `src/kernel/agentScopes.mjs`). Throws an error for the model when cutId does not exist.
 * Returns `{ project, cut: { id, name }, active, parkedT }`.
 */
export function seeFramesView(project, cutId) {
  if (cutId !== undefined && cutId !== null && typeof cutId !== 'string') throw new Error('cutId must be a string (the cut id from list_cuts); if omitted, the currently active cut is used.');
  return cutLookView(project, cutId);
}

function targetOf(args) {
  if (!isPlainObject(args)) return null;
  for (const k of ['clipId', 'trackId', 'mediaId', 'filterId', 'pixelMapId', 'fxId', 'transitionId', 'cutId', 'cardId', 'partInstanceId']) {
    if (typeof args[k] === 'string' && args[k]) return `${k}:${args[k]}`.slice(0, 512);
  }
  return null;
}

/**
 * @param {object} options
 * @param {ReturnType<import('./doc-link.mjs').createAgentLink>} options.link
 * @param {() => Promise<object>} options.loadHost  Version of `loadSsrHost` in `ssr-host.mjs` with `load` bound
 * @param {(path: string, body: object, opts?: object) => Promise<any>} [options.prerenderPost]
 * @param {() => number} [options.playhead] Page playhead (seconds); used when get_layout / see_frames omits time
 * @param {Record<string, string>} [options.toolGroups] Tool name → group name (icon for the event)
 * @param {(event: string, fields?: object) => void} [options.log]
 * @param {(tool: string, args: object, keys: readonly string[], agentKey: string) => Promise<object | null>} [options.pageState]
 *   Requests read-only page state from page once (`PAGE_STATE_TOOLS`); returns null or throws when
 *   there is no page, executor falls back to `playhead()`
 */
export function createAgentExecutor({
  link,
  loadHost,
  prerenderPost = null,
  playhead = () => 0,
  pageState = null,
  toolGroups = {},
  log = () => {},
  limits: limitsIn = {},
  newOpId = (session) => `${session}:${Date.now().toString(36)}:${randomUUID().slice(0, 8)}`,
  agentLabel = null,
  now = () => Date.now(),
  /**
   * Serial lock is provided by caller: when a process has multiple executors (hosted tier, one per
   * "project × member"), they share the server-side store and must queue in the same lock. If not
   * provided, each uses its own (desktop: only one executor per process).
   */
  serial: serialIn = null,
  /** Clear non-project store state on entering lock, remove project on leaving lock: prevent next instance tools from reading things left by previous instance */
  isolateStore = false,
  /**
   * Called once after entering the lock and before placing the project; returns a cleanup function
   * called upon leaving the lock (or null). Hosted tier uses it to temporarily register user card
   * definitions of **this project** (statically parsed, without executing source code) into the
   * server-side card table, and removes them upon leaving the lock: like store, the card table is a
   * process-level singleton, preventing cards of one project from being left for the next project.
   */
  enterHost = null,
} = {}) {
  if (!link) throw new TypeError('createAgentExecutor: link is required');
  if (typeof loadHost !== 'function') throw new TypeError('createAgentExecutor: loadHost is required');
  const limits = { ...AGENT_EXEC_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect tools */ } };
  const projectId = link.projectId;
  const bootId = Date.now().toString(36);

  /** agentKey ('' indicates call without chat id) → chat records */
  const convs = new Map();
  let nextNumber = 1;
  let lock = Promise.resolve();
  const stats = { executed: 0, committed: 0, stale: 0, rejected: 0, noop: 0, events: 0, eventErrors: 0, pageStates: 0, uploads: 0 };

  function conversationOf(agentKey = '') {
    const key = typeof agentKey === 'string' ? agentKey : '';
    let c = convs.get(key);
    if (!c) {
      c = { key, n: nextNumber++, session: `agent:${key || 'default'}`.slice(0, 128), lastRead: null, eventSeq: 0 };
      convs.set(key, c);
      // Register this chat's connection (connects only when used); first registered also subscribes to replica
      link.conversation(c.n);
    }
    return c;
  }

  /** Serial lock: server store is a single copy; placing project, running handler, and getting results must be done in one go */
  function serial(fn) {
    if (typeof serialIn === 'function') return serialIn(fn);
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  }

  async function replicaReady() {
    await link.ready();
    const r = link.replica;
    if (r.hasBody) return;
    // Page just connected and has not yet written project to document service: wait for it briefly
    const t0 = Date.now();
    while (!r.hasBody && Date.now() - t0 < limits.bodyWaitMs) await r.waitRev(r.rev + 1, 250);
    if (!r.hasBody) {
      throw Object.assign(new Error(`Project ${projectId} has no content in the document service yet (the page has not written the project into it). Try again later.`), { code: 'no-body' });
    }
  }

  function markRead(conv, rev) {
    if (conv.lastRead === null || rev > conv.lastRead) conv.lastRead = rev;
  }

  /* ---------------- Visualization records (chat) ---------------- */

  async function withVisual(tool, args, result, before, after) {
    if (!prerenderPost || !isPlainObject(result) || result.ok === false) return result;
    let body = null;
    if (CLIP_CREATE_TOOLS.has(tool)) {
      const id = result.id || result.clipId;
      if (id) body = { tool, clipId: id, after };
    } else if (tool === 'remove_clip') {
      if (args?.clipId) body = { tool, clipId: args.clipId, before };
    } else if (CLIP_EDIT_TOOLS.has(tool)) {
      if (args?.clipId) body = { tool, clipId: args.clipId, before, after };
    }
    if (!body) return result;
    try {
      const v = await prerenderPost('/api/ai/visual', body, { timeoutMs: limits.visualTimeoutMs });
      if (v?.ok && v.visualId) return { visualId: v.visualId, ...result };
    } catch { /* Visualization is incidental; drop it if it cannot be submitted */ }
    return result;
  }

  /* ---------------- Write tools: run handler on replica ---------------- */

  /**
   * Requests page state needed by this tool from page (`PAGE_STATE_TOOLS`), only once. When
   * unavailable (editor not open, timed out): playhead falls back to page playhead remembered by
   * server (`playhead()`, the one pushed to data mirror by page); trajectory has no substitute,
   * returns error directly.
   */
  async function pageStateFor(tool, args, agentKey = '') {
    const keys = PAGE_STATE_TOOLS[tool];
    if (!keys) return null;
    let got = null;
    if (typeof pageState === 'function') {
      let timer;
      try {
        got = await Promise.race([
          // Fourth parameter is the chat requesting it (hosted tier looks up page state when message
          // was sent by chat; desktop has only one page, ignores it)
          Promise.resolve(pageState(tool, args ?? {}, keys, agentKey)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`The page did not return its page state within ${limits.pageStateTimeoutMs} ms`)), limits.pageStateTimeoutMs); timer.unref?.(); }),
        ]);
      } catch (err) {
        say('agent.page-state-failed', { tool, message: String(err?.message ?? err) });
        got = null;
      } finally {
        clearTimeout(timer);
      }
    }
    stats.pageStates += 1;
    const out = {};
    if (keys.includes('t')) out.t = typeof got?.t === 'number' && Number.isFinite(got.t) ? got.t : (Number(playhead()) || 0);
    if (keys.includes('track')) {
      const mediaId = typeof args?.mediaId === 'string' ? args.mediaId : null;
      if (mediaId && (!got || typeof got !== 'object')) {
        throw Object.assign(new Error('The editor is not open (or not responding), so the tracking results in the page cannot be read. Open the editor and try again.'), { code: 'no-page' });
      }
      const tr = got?.track && typeof got.track === 'object' ? got.track : {};
      out.track = mediaId ? { mediaId, result: tr.result ?? null, running: tr.running === true } : null;
    }
    return out;
  }

  /** Changes exceeding single-run limit: upload completed project in chunks (`project.upload`), return the root replacement referencing it */
  async function uploadRoot(conn, opId, after) {
    const text = JSON.stringify(after);
    const count = Math.ceil(text.length / limits.uploadPartChars);
    if (count > limits.uploadMaxParts) {
      stats.rejected += 1;
      throw Object.assign(new Error(`This change is too large (the serialized project is about ${text.length} characters, over the chunked upload limit) and the document service will not accept it. Split it into several smaller changes.`), { code: 'too-large' });
    }
    const uploadId = `up.${opId}`.slice(0, 128);
    for (let index = 0; index < count; index += 1) {
      const reply = await conn.request(
        { type: 'project.upload', projectId, uploadId, index, count, data: text.slice(index * limits.uploadPartChars, (index + 1) * limits.uploadPartChars) },
        (m) => m.type === 'project.uploaded' || m.type === 'error',
      );
      if (reply.type === 'error') {
        stats.rejected += 1;
        throw Object.assign(new Error(`Chunked upload was rejected by the document service (${reply.reason ?? 'error'})${reply.detail ? `:${reply.detail}` : ''}`), { code: reply.reason ?? 'error' });
      }
    }
    stats.uploads += 1;
    return { wire: [{ op: 'set', path: '', upload: uploadId }], local: [{ op: 'set', path: '', value: JSON.parse(text) }] };
  }

  /** Send a commit; if response times out, resend same opId (see `opResends`); document service deduplicates by opId */
  async function submitOp(conn, message, tool) {
    const accept = (m) => m.type === 'project.op.ok' || m.type === 'project.op.rejected' || m.type === 'error';
    const started = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      try {
        const reply = await conn.request(message, accept);
        if (attempt > 0) say('agent.op-slow', { tool, opId: message.opId, attempts: attempt + 1, ms: Date.now() - started, reply: reply.type, ...(reply.duplicate ? { duplicate: true } : {}) });
        return reply;
      } catch (err) {
        if (err?.code !== 'timeout' || attempt >= limits.opResends) throw err;
        say('agent.op-resend', { tool, opId: message.opId, attempt: attempt + 1, ms: Date.now() - started });
      }
    }
  }

  /**
   * `apply` (optional): bypasses routing table; caller modifies directly on host where project is
   * placed (server-implemented tools in hosted tier, e.g. registering assets after importing assets).
   * When provided, skips routing table lookup and page state; the rest (entering lock, clearing
   * state, calculating diff, committing with expected rev, recording this write) is identical to
   * routed tools.
   */
  async function runRoute(tool, args, conv, ctx, apply = null) {
    await replicaReady();
    const host = await loadHost();
    if (!apply && !host.routeOf(tool)) throw new Error(`Unknown tool: ${tool}`);
    const ps = apply ? null : await pageStateFor(tool, args, conv.key);
    const prepared = await serial(async () => {
      const replica = link.replica;
      const base = replica.project;
      const baseRev = replica.rev;
      if (isolateStore) host.resetStore?.();
      let leave = null;
      if (typeof enterHost === 'function') { try { leave = enterHost(host, conv.key) ?? null; } catch (err) { say('agent.enter-host-failed', { message: String(err?.message ?? err).slice(0, 160) }); } }
      host.setProject(base);
      const cleanup = ps && typeof host.setPageState === 'function' ? host.setPageState(ps) : null;
      let result;
      let after;
      try {
        result = apply ? await apply(host) : await host.callRoute(tool, args);
      } finally {
        // Take out finished project first, then return store to replica; if handler throws, this
        // entire change is invalidated (not committed)
        after = host.getProject();
        if (isolateStore && typeof host.clearProject === 'function') host.clearProject();
        else host.setProject(base);
        cleanup?.();
        try { leave?.(); } catch { /* Cleanup failure does not affect this result */ }
      }
      if (after === base) return { result, base, baseRev, ops: [], inverse: [] };
      // Adjusting total duration to follow content is done together here, committed along with the
      // same batch of ops (page will not write again upon receipt)
      after = settleDuration(base, after, host.durationRules);
      const { ops, inverse } = host.diffProject(base, after);
      return { result, base, baseRev, ops, inverse, after };
    });
    const { result, base, baseRev, ops, inverse } = prepared;
    if (!ops.length) {
      stats.noop += 1;
      markRead(conv, baseRev);
      return withRev(result, baseRev);
    }
    const expectRev = conv.lastRead ?? baseRev;
    const opId = newOpId(conv.session);
    const conn = link.conversation(conv.n);
    // Document service commit limit is 256 KiB (c65-integ2 ruling): larger changes become
    // "root replacement = entire finished project", uploaded in chunks via `project.upload`
    // and referenced in commit; reverse operation still uses diff-computed one (reversible)
    let wireOps = ops;
    let landedOps = ops;
    if (bytesOf(ops) > limits.maxOpsBytes) {
      const up = await uploadRoot(conn, opId, prepared.after);
      wireOps = up.wire;
      landedOps = up.local;
    }
    const reply = await submitOp(conn, { type: 'project.op', projectId, opId, session: conv.session, expectRev, ops: wireOps }, tool);
    if (reply.type === 'project.op.ok') {
      stats.committed += 1;
      link.replica.offer(reply.rev, landedOps, { opId, actor: { role: 'agent', conversation: conv.n, session: conv.session }, session: conv.session });
      await link.replica.waitRev(reply.rev, limits.landWaitMs);
      markRead(conv, reply.rev);
      const overwrote = Array.isArray(reply.overwrote) ? reply.overwrote : [];
      // `before`: project before write (excluded from events/results; host uses it to find pre-edit
      // cost identity when classifying light/heavy, `render-clips.mjs` "send heavy cards only")
      ctx.write = { opId, rev: reply.rev, inverse, overwrote, clipIds: clipIdsOfOps(ops), before: base };
      say('agent.write', { tool, conversation: conv.n, opId, rev: reply.rev, ops: ops.length, ...(overwrote.length ? { overwrote: overwrote.length } : {}) });
      const shown = await withVisual(tool, args, result, base, prepared.after);
      // Overwrote entity written by someone else within 10 minutes (computed by document service, A2):
      // include in results; writer is page marked "user just edited", other Agent marked
      // "Agent <identity> just edited"
      const noted = overwrote.length ? annotateResult(shown, { overwrote: overwroteView(overwrote, { now: now(), agentLabel }) }) : shown;
      return withRev(noted, reply.rev);
    }
    if (reply.type === 'project.op.rejected' && reply.reason === 'stale') {
      stats.stale += 1;
      // Wait for replica to catch up to current rev: Agent can immediately read changes landed in between
      if (Number.isSafeInteger(reply.currentRev)) await link.replica.waitRev(reply.currentRev, limits.staleWaitMs);
      const info = { expectRev, currentRev: reply.currentRev, since: reply.since ?? [], sinceComplete: reply.sinceComplete !== false };
      say('agent.stale', { tool, conversation: conv.n, expectRev, currentRev: reply.currentRev, since: info.since.length });
      throw new StaleWriteError(staleMessage(info, limits), info);
    }
    stats.rejected += 1;
    const reason = reply.reason ?? 'error';
    const detail = reply.detail ? `:${reply.detail}` : '';
    throw Object.assign(new Error(`The document service did not accept this write (${reason})${detail}`), { code: reason });
  }

  /* ---------------- Read tools: read replica ---------------- */

  async function readSnapshot(conv) {
    await replicaReady();
    const r = link.replica;
    const snap = { project: r.project, rev: r.rev };
    markRead(conv, snap.rev);
    return snap;
  }

  async function getLayout(args, conv, toolDef) {
    const snap = await readSnapshot(conv);
    const host = await loadHost();
    const frames = await serial(async () => {
      if (isolateStore) host.resetStore?.();
      host.setProject(snap.project);
      try {
        const all = (snap.project.tracks || []).flatMap((tr) => (tr.clips || []).map((c) => c.id));
        if (args?.clipId && !all.includes(args.clipId)) throw new Error(`clip ${args.clipId} not found`);
        const ids = args?.clipId ? [args.clipId] : all;
        return { ids, stage: host.stageSize(), layout: Object.fromEntries(ids.map((id) => [id, host.frameLayoutOf(id)])) };
      } finally {
        if (isolateStore) host.clearProject?.();
      }
    });
    let measured = null;
    let note = null;
    if (prerenderPost && frames.ids.length) {
      try {
        const data = await prerenderPost('/api/cards/layout', { project: snap.project, t: playhead(), clipIds: frames.ids }, { timeoutMs: toolDef?.timeoutMs || 60_000 });
        if (data && data.ok !== false && isPlainObject(data.clips)) measured = data.clips;
        else note = `Prerender could not measure the entity box: ${data?.error ?? 'no result'}`;
      } catch (err) {
        note = `Prerender did not respond, cannot measure the entity box: ${err?.message ?? err}`;
      }
    }
    const clips = {};
    for (const id of frames.ids) {
      const m = measured?.[id] ?? { contentBox: null, ...(note ? { contentNote: note } : {}) };
      clips[id] = { ...frames.layout[id], contentBox: m.contentBox ?? null, ...(m.contentNote ? { contentNote: m.contentNote } : {}) };
    }
    if (args?.clipId) return withRev(clips[args.clipId], snap.rev);
    return { stage: frames.stage, clips, rev: snap.rev };
  }

  async function seeFrames(args, conv, toolDef) {
    const snap = await readSnapshot(conv);
    const { source, cutId, ...rest } = args || {};
    if (rest.view !== undefined && rest.view !== null && rest.view !== 'camera' && rest.view !== 'space') {
      throw new Error(`view must be "camera" or "space", received ${JSON.stringify(rest.view)}`);
    }
    const view = rest.view === 'space' ? 'space' : rest.view === 'camera' ? 'camera' : undefined;
    // cutId (user decision, 2026-10-21): viewing inactive cuts does not require switching.
    // Render receives project view with "that cut treated as active"; view is only used for this image
    // output, does not write replica, does not commit, does not change activeCutId; render side sees
    // normal project, older render process versions also render correctly
    const look = seeFramesView(snap.project, cutId);
    const times = Array.isArray(rest.times) ? rest.times.filter((x) => typeof x === 'number').slice(0, 10) : [];
    const body = times.length
      ? { project: look.project, times, clipId: rest.clipId, ...(view ? { view } : {}) }
      : { project: look.project, t: typeof rest.t === 'number' ? rest.t : (rest.clipId ? undefined : (look.active ? playhead() : look.parkedT)), clipId: rest.clipId, ...(view ? { view } : {}) };
    // cutLook: image output must render using this view (account mode therefore does not hand off
    // to member devices: member page renders against its own project, cannot view other cuts)
    const data = await prerenderPost('/api/vision/snapshot', body, { timeoutMs: toolDef?.timeoutMs || 180_000, ...(look.active ? {} : { cutLook: true }) });
    if (!data?.ok) throw new Error(data?.error || 'Failed to render the frame');
    let result = times.length ? { ok: true, frames: data.frames, note: data.note, ...(data.view ? { view: data.view } : {}), __images: data.__images } : data;
    result = { ...result, cut: look.cut };
    const images = [];
    if (data.__image?.base64) images.push({ mime: data.__image.mime, base64: data.__image.base64, label: typeof data.t === 'number' ? `t=${data.t}s` : '' });
    for (const im of Array.isArray(data.__images) ? data.__images : []) if (im?.base64) images.push({ mime: im.mime, base64: im.base64, label: im.label ?? '' });
    if (images.length) {
      const v = await prerenderPost('/api/ai/visual', { tool: 'see_frames', images }, { timeoutMs: 5000 }).catch(() => null);
      if (v?.ok && v.visualId) result = { visualId: v.visualId, ...result };
    }
    return withRev(result, snap.rev);
  }

  async function getGif(args, conv, toolDef) {
    const snap = await readSnapshot(conv);
    const timeoutMs = toolDef?.timeoutMs || 180_000;
    const spec = await prerenderPost('/api/ai/visual', { tool: 'get_gif', clipId: args.clipId, after: snap.project }, { timeoutMs });
    if (!spec?.ok) throw new Error(spec?.error || 'Failed to make the animated image');
    if (!spec.gifKey) throw new Error(`No clip with id ${args.clipId} on the timeline.`);
    const data = await prerenderPost('/api/ai/visual/render', { key: spec.gifKey }, { timeoutMs });
    if (!data?.ok) throw new Error(data?.error || 'Failed to make the animated image');
    return {
      visualId: spec.visualId, ok: true, clipId: args.clipId, times: data.times, gif: data.gifUrl,
      note: 'Collage 4×2: cell k corresponds to the k-th time in times (row by row, left to right). The user can open this step in the chat panel to see the animated image.',
      ...(data.grid ? { __image: { mime: 'image/png', base64: data.grid } } : {}),
      rev: snap.rev,
    };
  }

  async function bakeCard(args, conv, toolDef) {
    const snap = await readSnapshot(conv);
    const data = await prerenderPost('/api/vision/bake', { project: snap.project, clipId: args.clipId, t: args.t, size: args.size, bg: args.bg }, { timeoutMs: toolDef?.timeoutMs || 150_000 });
    if (!data?.ok) throw new Error(data?.error || 'Render failed');
    return withRev(data, snap.rev);
  }

  async function inspectCardDom(args, conv, toolDef) {
    const snap = await readSnapshot(conv);
    const ref = typeof args.ref === 'string' ? Number(String(args.ref).replace(/^ref_/, '')) : args.ref;
    const data = await prerenderPost('/api/cards/dom', { project: snap.project, clipId: args.clipId, t: args.t, ref, depth: args.depth }, { timeoutMs: toolDef?.timeoutMs || 60_000 });
    if (!data?.ok) throw new Error(data?.error || 'Cannot read the DOM tree');
    return withRev(data, snap.rev);
  }

  /* ---------------- Events (D2) ---------------- */

  function sendEvent(conv, message, accept = (m) => m.type === 'events.ack' || m.type === 'error') {
    const conn = link.conversation(conv.n);
    return conn.request({ ...message, projectId, session: conv.session }, accept).then((reply) => {
      if (reply?.type === 'error') {
        stats.eventErrors += 1;
        say('agent.event-rejected', { type: message.type, reason: reply.reason, detail: reply.detail });
      } else stats.events += 1;
      return reply;
    }, (err) => {
      stats.eventErrors += 1;
      say('agent.event-failed', { type: message.type, message: String(err?.message ?? err) });
      return null;
    });
  }

  function argsSummary(args) {
    let text;
    try { text = JSON.stringify(args ?? {}); } catch { text = '(arguments cannot be serialized)'; }
    return text.length > limits.eventArgsMax ? `${text.slice(0, limits.eventArgsMax - 1)}…` : text;
  }

  function resultSummary(result, error) {
    if (error) return String(error?.message ?? error).slice(0, 2048);
    let text;
    try {
      text = JSON.stringify(result, (k, v) => (k === '__image' || k === '__images' || k === 'base64' ? undefined : v));
    } catch { text = ''; }
    return (text ?? '').slice(0, 2048) || null;
  }

  /** Write info in completion event: only for successful writes; omitted if reverse op is too large (exceeds event module limit), so step cannot be undone */
  function writeFields(write) {
    if (!write) return {};
    const out = { opId: write.opId, rev: write.rev };
    if (bytesOf(write.inverse) <= limits.inverseMaxBytes) out.inverse = write.inverse;
    return out;
  }

  /** Supplementary event-detail upon completion: args, result summary, write info; drop reverse op then args if content store limit exceeded */
  function completeDetail(tool, args, summary, fields) {
    const full = { tool, args: args ?? {}, summary, ...fields };
    if (bytesOf(full) <= limits.detailMaxBytes) return full;
    const { inverse: _i, ...noInverse } = full;
    if (bytesOf(noInverse) <= limits.detailMaxBytes) return { ...noInverse, inverseOmitted: true };
    return { tool, summary, ...(fields.opId ? { opId: fields.opId, rev: fields.rev, inverseOmitted: true } : {}), argsOmitted: true };
  }

  /* ---------------- External ---------------- */

  const READERS = { get_layout: getLayout, see_frames: seeFrames, get_gif: getGif, bake_card: bakeCard, inspect_card_dom: inspectCardDom };

  return {
    projectId,
    conversationOf,

    /**
     * Executes a `side: "agent"` tool. Returns `undefined` to indicate server does not handle it
     * (hands off to page): currently only `see_frames` media mosaic.
     * `ctx` is passed in by `track`, and executor records this write (`write`) on it.
     */
    async execute(toolIn, args, agentKey, toolDef, ctx = {}) {
      // Legacy names (switch_cut, etc.) recognized as usual: routing table and PAGE_STATE_TOOLS
      // use new names (server/tools/ui-names.mjs)
      const tool = modelToolName(toolIn);
      const conv = conversationOf(agentKey);
      stats.executed += 1;
      const required = toolDef?.inputSchema?.required ?? [];
      const missing = required.filter((k) => args?.[k] === undefined || args?.[k] === null);
      if (missing.length) throw new Error(`Missing required parameters: ${missing.join(', ')}. Add them and try again.`);
      if (tool === 'get_project') {
        const snap = await readSnapshot(conv);
        return { ...projectView(snap.project), rev: snap.rev };
      }
      if (tool === 'see_frames' && args?.source !== undefined && args.source !== 'timeline') return undefined;
      if (tool === 'prerender_cut_to_2d') {
        if (!prerenderPost) return undefined;
        const snap = await readSnapshot(conv);
        const look = seeFramesView(snap.project, args?.cutId);
        if (look.project.cutKind !== '3d' && (snap.project.cuts ?? []).find((c) => c.id === look.cut.id)?.kind !== '3d') {
          throw new Error(`Cut "${look.cut.name}" is already a 2D cut; only 3D cuts need pre-rendering to a 2D cut`);
        }
        const data = await prerenderPost(
          '/api/vision/prerender-cut',
          { project: snap.project, cutId: look.cut.id, name: args?.name },
          { timeoutMs: toolDef?.timeoutMs || 180_000 },
        );
        if (!data?.ok) throw new Error(data?.error || 'Failed to pre-render 3D cut');
        return runRoute(tool, args ?? {}, conv, ctx, (host) =>
          host.commitPrerenderedCutTo2D(look.cut.id, data, { switchTo: false, name: args?.name }));
      }
      const reader = READERS[tool];
      if (reader) {
        if (!prerenderPost && tool !== 'get_layout') return undefined;
        return reader(args ?? {}, conv, toolDef);
      }
      return runRoute(tool, args ?? {}, conv, ctx);
    },

    /**
     * Used by server-implemented tools in hosted tier: executes `apply(host)` on project replica,
     * calculating diffs as usual, committing with expected rev, and recording into `ctx.write`.
     * `apply` runs inside a process-level lock, performing only synchronous project mutations without
     * waiting on external tasks (downloads and uploads complete before entering the lock).
     */
    mutate(tool, agentKey, ctx, apply) {
      return runRoute(tool, {}, conversationOf(agentKey), ctx ?? {}, apply);
    },

    /** Hosted tier: sends request to document service via this chat's connection (fetch asset ticket, read/write card source); returns document service response */
    async request(agentKey, message, accept) {
      await replicaReady();
      const conv = conversationOf(agentKey);
      return link.conversation(conv.n).request({ ...message, projectId }, accept);
    },

    /** Hosted tier: current project replica (read-only; records that this chat has read this rev) */
    async snapshot(agentKey) {
      return readSnapshot(conversationOf(agentKey));
    },

    /**
     * Emits an event before and after each tool call (regardless of which side executes the tool).
     * `run(ctx)` executes the tool; failed event emissions do not affect the tool.
     * `meta.callId` is the id of this tool call on the model side (`_meta["claudecode/toolUseId"]` in
     * Claude Code, tool_use id in direct API): attached to both events so the page AI panel matches
     * events to that tool call in chat history.
     */
    async track(tool, args, agentKey, run, meta = {}) {
      const conv = conversationOf(agentKey);
      const eventId = `${conv.session}.${bootId}.${++conv.eventSeq}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
      const detailFits = bytesOf(args ?? {}) <= limits.detailMaxBytes;
      const callId = typeof meta?.callId === 'string' && meta.callId && meta.callId.length <= 128 ? meta.callId : null;
      const callField = callId ? { callId } : {};
      sendEvent(conv, {
        type: 'events.create', eventId, tool, ...callField,
        icon: toolGroups[tool] ?? null, target: targetOf(args), args: argsSummary(args),
        ...(detailFits ? { detail: { tool, args: args ?? {} } } : {}),
      });
      const t0 = Date.now();
      const ctx = { write: null };
      let result;
      let error = null;
      try {
        result = await run(ctx);
        return result;
      } catch (err) {
        error = err;
        throw err;
      } finally {
        // Only successfully landed writes include opId, rev, and reverse op; read tools and
        // rejected writes do not (lead session ruling)
        const fields = error ? {} : writeFields(ctx.write);
        const summary = resultSummary(result, error);
        sendEvent(conv, {
          type: 'events.complete', eventId, ...callField,
          status: error ? 'error' : 'ok',
          summary,
          durationMs: Date.now() - t0,
          ...fields,
          detail: completeDetail(tool, args, summary, fields),
        });
      }
    },

    /** Push one when entire text reply completes (D2) */
    text(agentKey, text) {
      if (typeof text !== 'string' || !text.trim()) return;
      const conv = conversationOf(agentKey);
      const eventId = `${conv.session}.${bootId}.${++conv.eventSeq}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
      sendEvent(conv, { type: 'events.text', eventId, text: text.slice(0, 64 * 1024) });
    },

    /**
     * Tools remaining on page wrote to project (page response includes `opIds` it committed): wait for
     * these commits to enter replica; if only these commits occurred after the rev this chat last read,
     * advance the read rev forward: otherwise the Agent's subsequent write will be rejected due to
     * changes it asked the page to make.
     */
    async notePageWrites(agentKey, opIds) {
      if (!Array.isArray(opIds) || !opIds.length) return;
      const conv = conversationOf(agentKey);
      const r = link.replica;
      const t0 = Date.now();
      let revs = [];
      while (Date.now() - t0 < limits.pageWritesWaitMs) {
        revs = opIds.map((id) => r.revOfOpId(id));
        if (revs.every((v) => v !== null)) break;
        await r.waitRev(r.rev + 1, 200);
      }
      if (revs.some((v) => v === null) || conv.lastRead === null) return;
      const top = Math.max(...revs);
      if (top <= conv.lastRead) return;
      const between = r.between(conv.lastRead, top);
      if (between && between.every((h) => opIds.includes(h.opId))) conv.lastRead = top;
    },

    /** Last rev read by this chat (testing and diagnostics) */
    lastRead(agentKey) {
      return convs.get(typeof agentKey === 'string' ? agentKey : '')?.lastRead ?? null;
    },

    describe() {
      return {
        projectId,
        conversations: [...convs.values()].map((c) => ({ key: c.key, conversation: c.n, session: c.session, lastRead: c.lastRead })),
        stats: { ...stats },
        link: link.describe(),
      };
    },
  };
}
