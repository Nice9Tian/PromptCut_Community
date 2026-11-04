/**
 * Real executor for the render queue (contract `docs/plan/render-queue-contract.md` J.4, design appendix
 * `docs/plan/queue-executor-design.md` sections 1-3). Implements D.1 `executor` interface, passed to
 * `createLocalNode` in `render-node/local-node.mjs`.
 *
 * This is a very thin adaptation layer: actual work lives in new methods of `FramePipeline`
 * (`planForQueue`, `renderCardSnapshotRange`, `renderSceneSnapshotRange`, all on `'queue'` lane);
 * preload paths remain unchanged when they are not invoked. It cannot be placed in `server/render-node/`:
 * that directory is gated by D1 to allow only Node built-in modules, whereas this needs to import pipeline.
 *
 *   plan(planTask)   Fetches project snapshot from document service by `source.projectId@projectRev`
 *                    (`projects.get`, throws retryable `no-snapshot` on failure); passes to
 *                    `pipeline.planForQueue` after `prepareProject`; returns PlanContext (`streams`:
 *                    all streams for this revision if this machine can produce track streams, otherwise
 *                    empty: M6c X1). Results cached by revision (LRU ~4 entries), reused by `render`.
 *   render(task)     Snapshot tasks: shared tier `renderCardSnapshotRange`, local tier
 *                    `renderSceneSnapshotRange`. First matches task back to control of this revision
 *                    (appendix section 3 "Matching tasks back to control"); throws non-retryable
 *                    `plan-mismatch` on any mismatch.
 *                    Stream tasks (M6c X1): matches back to streams of this revision (content key,
 *                    result key, segment range), passed to `renderStreamRange` to produce by segment;
 *                    throws `plan-mismatch` on mismatch as well; throws non-retryable `no-streams`
 *                    if this machine cannot produce streams (switch disabled, no encoder).
 *                    When a stream task sliced from a manifest plan (task brief "Jia-3": the splitter's
 *                    own share) cannot be found in streams of this revision, calculates its single-card
 *                    stream on the fly from the task's clip and matches again (manifest was decided by
 *                    publisher; cards not classified as heavy on this machine are not in this machine's
 *                    streams for this revision).
 *                    Host render nodes produce streams according to project's "Generate track streams"
 *                    setting (task brief "Jia-3"): when caller provides `streamsEnabled` (whether the
 *                    project this executor belongs to produces streams at this moment, `render-node/host.mjs`
 *                    header "Whether to produce track streams per project"), plans with clip manifests
 *                    check it before splitting: if not producing, does not output the splitter's own stream
 *                    share (`context.ownListStreams`). Gate for claiming stream tasks is not here, but on
 *                    host claim gate (same quantity). Desktop app and ordinary standalone render hosts do
 *                    not pass it and do not manage per-project.
 *                    Returns `null`: outputs are in frame store / stream store; sink reads them itself
 *                    (`collectSnapshotResult` / `collectStreamResult`).
 *                    For shared tier cards with oversized frames recorded in local snapshot store
 *                    (`oversize` in `index.json`, R6-14), marks `snapshotOversize: true` on control
 *                    passed to split (see `markSnapshotOversize`); split accordingly does not produce
 *                    another copy for pure browser (M7 contract section 13 "Corrections after probe",
 *                    item 6; `claude/queue-maint` task E).
 *   afterSplit(planTask, { tasks })  (M7 contract D12) Invoked after local-node split completes and
 *                    publish responses return: records fingerprints for cards that actually emitted keys
 *                    based on successfully published fine-grained tasks (`pipeline.recordSplitCandidates`),
 *                    and plans with clip manifests rewrite layer table v 3 for this revision (candidates
 *                    based on actual emitted keys; standalone render host writes via `publishLayerMap`
 *                    option, PC writes via pipeline's own push queue). Layer table is written only after
 *                    split completes, no longer written before split based on local view (timing of D12).
 *
 * Diagnostics (`docs/archive/agent-reports/AGENT-stall-phases.md`): `render` reports its current step via
 * runner's `phase(name, fields)`: `project` (fetching project snapshot, computing plan for this revision),
 * `lane` (handed to pipeline, first batch of this segment not yet submitted; `ahead` is number of active
 * `'queue'` lane jobs on this pipeline, >0 means queuing), `frames` (emitting batches), `finish` (all frames
 * submitted, finalizing: small-size catch-up, page switch).
 *
 * # Project has moved forward (contract `docs/plan/render-queue-contract.md` J.15)
 *
 * Fine-grained task results are content-addressed; `source.projectRev` in a task is merely a clue for
 * "which revision to take input from". For projects with backing entities (shared projects), the document
 * service only provides the current revision: once modified after publishing, older revisions can no longer
 * be retrieved. This is not considered a failure:
 *   - If revision specified by task cannot be retrieved and document service returns current revision
 *     (`currentRev` from `projects.locate`): switches to compute against current revision (catching up
 *     all the way to latest if necessary);
 *   - Plans with clip manifests and their fine-grained tasks add an extra rule: if this executor has
 *     already computed a newer revision for this project, do not use older revision and verify directly
 *     against newer one (old revision frames are no longer needed, avoiding wasted renders; layer table
 *     won't be overwritten with an old revision by a late plan);
 *   - Plan tasks: split based on the actually retrieved revision; returned context carries `actualRev`,
 *     which splitter writes into `source.projectRev` of fine-grained tasks;
 *   - Fine-grained tasks: match back to control in actual revision by clip and content key. If content is
 *     unchanged, proceed as planned (output is byte-identical to original revision); if clip is gone or
 *     content key changed, content has been superseded by new revision, throw `superseded`
 *     (`error.superseded === true`, non-retryable), which runner reports to queue to invalidate without
 *     recording failure.
 * For projects without backing entities (every revision has an uploaded snapshot), document service does not
 * return `currentRev`, and behavior remains unchanged.
 *
 * From M6c onward, executor no longer has `isIdle()` (originally in J.4): idle gate for PC node switched to
 * `queue-idle.mjs` (X5), and standalone render hosts only check global concurrency gate anyway, so this
 * criterion is unused (integration ruling, `docs/plan/m6c-contract.md` "Integration rulings").
 */
import { resultKeyOf } from './render-node/fingerprint.mjs';
import { snapshotTier } from './snapshot-tier.mjs';
import { isListPlan, CLIPS_KEY_MARK, BACKFILL_KEY_MARK, isSparseStreamTask, STREAM_DENSITY_SPARSE } from './render-queue/index.mjs';
import { splitCandidatesOf, splitStreamCandidatesOf, streamCandidateKey } from './artifact-transfer.mjs';
import { isExportFramesTask, isExportOnlyPlan } from './render-node/export-plan.mjs';

/** `cardLocks` (Map, plain object, or omitted) → `(lockKey) => lock fingerprint | null` (same as `split.mjs`) */
function lockReader(cardLocks) {
  const fp = value => (typeof value === 'string' && value !== '' ? value : null);
  if (cardLocks == null) return () => null;
  if (typeof cardLocks.get === 'function') return key => fp(cardLocks.get(key));
  if (typeof cardLocks === 'object') return key => (Object.prototype.hasOwnProperty.call(cardLocks, key) ? fp(cardLocks[key]) : null);
  return () => null;
}

/**
 * Mark `snapshotOversize` on shared-tier cards based on the local snapshot store
 * (`claude/queue-maint` task E): mark this card if the local snapshot store has records of
 * oversize frames (`index.json`'s `oversize` is non-empty; recorded when A3c classified it as
 * oversize during local rendering, or similarly classified when pulling its manifest from the asset
 * service).
 * Check two keys: the key for the local fingerprint (`control.snapshotKey`), and the key for the
 * locking party's fingerprint when this card is locked to another environment (`cardLocks`).
 * Mark on the entire card, not per segment: snapshots for a card come from only one environment
 * (per-card fingerprint lock); if the browser claims one segment, it locks the entire card. If the
 * browser renders those oversize segments it is wasted work, while other environments are blocked
 * by the lock: therefore if even one frame is oversize, the entire card is withheld from the
 * browser.
 * Do not inspect the local tier (pure browsers only handle the shared tier); do not inspect canvas
 * cards (splits are not given to browsers anyway). Return a new cardPlan array (marked controls are
 * new objects, context in cache remains untouched); return the original array if nothing needs
 * marking. If the snapshot store cannot be read (test double, corrupted store), treat as no
 * records.
 */
export async function markSnapshotOversize(pipeline, context) {
  const cardPlan = Array.isArray(context?.cardPlan) ? context.cardPlan : [];
  let store = null;
  try { store = typeof pipeline?.snapshots === 'function' ? pipeline.snapshots() : null; } catch { store = null; }
  if (!store || typeof store.snapshotIndex !== 'function') return { cardPlan, marked: [] };
  const lockOf = lockReader(context?.cardLocks);
  const marked = [];
  const out = [];
  for (const control of cardPlan) {
    const tier = control?.tier || snapshotTier(control?.capabilities);
    if (!control || control.snapshotOversize === true || tier !== 'shared' || !control.contentKey || control.capabilities?.canvasHeavy === true) {
      out.push(control);
      continue;
    }
    const keys = new Set([control.snapshotKey]);
    const locked = lockOf(`snapshot:${control.contentKey}`);
    if (locked) keys.add(resultKeyOf(control.contentKey, locked));
    let over = false;
    for (const key of keys) {
      if (typeof key !== 'string' || !key) continue;
      try {
        const index = await store.snapshotIndex({ tier: 'shared', key });
        if (Array.isArray(index?.oversize) && index.oversize.length > 0) { over = true; break; }
      } catch { /* Treat as no records if unreadable */ }
    }
    if (over) { marked.push(control.clipId); out.push({ ...control, snapshotOversize: true }); } else out.push(control);
  }
  return { cardPlan: marked.length ? out : cardPlan, marked };
}

/**
 * How long to wait at most and how often to check when the manifest plan states that "the page sees
 * 'Generate track streams' enabled" but this machine has not seen it yet (tertiary numbers; this
 * machine reconciles with the manager process once per second)
 */
export const STREAMS_SETTLE_MS = 4000;
const STREAMS_SETTLE_POLL_MS = 100;

/** Number of contexts cached per version (Appendix Section 3: LRU of about 4 items) */
export const PLAN_CACHE_SIZE = 4;

const fail = (code, message, retryable) => Object.assign(new Error(message), { code, retryable });

/**
 * Maximum hops to catch up to the current version (each hop is a newer version number returned by
 * the document service; multiple hops only happen if the project changes again when fetching)
 */
export const DRIFT_MAX_HOPS = 8;
/**
 * Error reported to the queue for invalidated tasks: the queue recognizes it as "this output was
 * no longer wanted at the time" (`render-queue/queue.mjs`'s `isSuperseded`)
 */
export const SUPERSEDED = 'superseded';
const superseded = (detail) => Object.assign(new Error(SUPERSEDED), { code: SUPERSEDED, superseded: true, retryable: false, detail });

/**
 * A plan with a clip manifest, or a fine-grained task split from it (see plan id in
 * `source.derivedFrom`)
 */
export function isListWork(task) {
  if (isListPlan(task)) return true;
  const from = task?.source?.derivedFrom;
  return typeof from === 'string' && (from.includes(CLIPS_KEY_MARK) || from.includes(BACKFILL_KEY_MARK));
}

/**
 * Work submitted to `'queue'` lane on each pipeline via executor (snapshot segment, fetching plan
 * for a plan): pipeline → number of running items.
 * The lane is serial (`FramePipeline.runQueueTask`). The same pipeline is shared by executors of
 * multiple project nodes on the host, so it is recorded in the module and split by pipeline.
 * Only counts; does not queue and does not modify pipeline behavior.
 */
const laneWork = new WeakMap();
async function onLane(pipeline, work) {
  laneWork.set(pipeline, (laneWork.get(pipeline) ?? 0) + 1);
  try { return await work(); }
  finally { laneWork.set(pipeline, Math.max(0, (laneWork.get(pipeline) ?? 1) - 1)); }
}
/**
 * Number of jobs on this pipeline currently submitted to `'queue'` lane via executor that have not
 * yet settled
 */
export function laneBusy(pipeline) {
  return laneWork.get(pipeline) ?? 0;
}

/**
 * @param {object} options
 * @param {import('./frame-pipeline.mjs').FramePipeline} options.pipeline
 * @param {{ get(projectId: string, projectRev: number): Promise<object | null> }} options.projects  J.2 project client
 * @param {(project: any) => any} [options.prepareProject]  Defaults to as-is; prerender process
 *   passes `renderProject`
 * @param {(event: string, fields?: object) => void} [options.log]
 * @param {(entry: object) => void} [options.publishLayerMap]  Writes layer table after accepting a plan
 *   with clip manifest (C10 contract Section 18 Item 9):
 *   Standalone render host has no push queue, so the pipeline's own `publishLayerMap` cannot write
 *   out; host writes based on this connection's content store; PC node does not provide it (written
 *   via push queue as before)
 * @param {() => unknown} [options.codeStamp]  Card code epoch (c66-host-cards: `card-code.mjs`'s
 *   `epoch`). Cache is stored by "project revision + epoch": when card code changes (new cards
 *   installed synchronously), the context of the same project revision must be recomputed with the
 *   new code, otherwise tasks reconcile back to the old control
 * @param {null | (() => boolean)} [options.streamsEnabled]
 *   Whether the project to which this executor belongs currently produces track streams (task brief
 *   "Jia-3"; read live). Host render service worker processes provide this per project
 *   (`vite-plugin-frames.ts`'s `startHostNode`); defaults to null: not managed per project, this
 *   machine produces whenever able (desktop app, ordinary standalone render host)
 * @param {number} [options.streamsSettleMs]  Maximum time to wait when the manifest plan states that
 *   "the page sees this option enabled" (`input.streams`) but this machine has not seen it yet
 *   (see `plan`)
 * @param {(ms: number) => Promise<void>} [options.sleep]  For testing
 */
export function createPrerenderExecutor({ pipeline, projects, prepareProject = project => project, log = () => {}, codeStamp = () => '', publishLayerMap = null,
  streamsEnabled = null, streamsSettleMs = STREAMS_SETTLE_MS, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!pipeline) throw new Error('createPrerenderExecutor needs a pipeline');
  if (!projects || typeof projects.get !== 'function') throw new Error('createPrerenderExecutor needs a project client');
  /** Whether it is managed per project */
  const perProject = typeof streamsEnabled === 'function';
  /**
   * Whether this project currently produces streams; always true when not managed per project.
   * If the queried side errors, treat as not producing
   */
  const streamsOn = () => {
    if (!perProject) return true;
    try { return streamsEnabled() === true; } catch { return false; }
  };
  /**
   * When the creator just turns on "Generate track streams": online page sees it is open and resends
   * the manifest plan (result key includes this item, `render-queue/messages.mjs`'s
   * `clipsPlanTaskOf`), but this machine seeing it open from the manager process manifest is one
   * tick behind (within one second). If the plan arrives first, splitting according to "disabled"
   * currently held by this machine would miss its own share of streams, and this revision's plan
   * will not be split again once completed.
   * Therefore, when the plan specifies `input.streams: true` but this machine still has it disabled,
   * wait until this machine also sees it enabled or until `streamsSettleMs` has elapsed.
   * This item written by the page only determines "whether to wait"; whether to produce still depends
   * solely on the item this machine received from the catalog (page's self-report does not count).
   */
  const streamsSettled = async (planTask, signal) => {
    if (streamsOn() || planTask?.input?.streams !== true) return streamsOn();
    const until = Date.now() + Math.max(0, streamsSettleMs);
    while (!streamsOn() && Date.now() < until && !signal?.aborted) await sleep(STREAMS_SETTLE_POLL_MS);
    return streamsOn();
  };
  /** `projectId@projectRev` → Promise<{ entry, context }>; Map insertion order is LRU order */
  const cache = new Map();
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging errors do not affect execution */ } };
  /** Same as `say`; `say` in `render` is shadowed by stage callback, so this name is used to log there */
  const note = say;

  const versionOf = task => {
    const projectId = task?.source?.projectId;
    const projectRev = task?.source?.projectRev;
    if (typeof projectId !== 'string' || !projectId || !Number.isSafeInteger(projectRev)) {
      throw fail('bad-task', `Task source is invalid: ${JSON.stringify(task?.source ?? null)}`, false);
    }
    return { projectId, projectRev, id: `${projectId}@${projectRev}` };
  };

  /**
   * projectId → latest revision successfully computed by this executor (see "Project moved forward"
   * at file header)
   */
  const newest = new Map();
  /**
   * Plan task object → which revision it was actually split against (`afterSplit` writes layer table
   * using the same revision)
   */
  const planned = new WeakMap();

  const cacheIdOf = (projectId, projectRev) => {
    const version = `${projectId}@${projectRev}`;
    let stamp = '';
    try { stamp = String(codeStamp() ?? ''); } catch { stamp = ''; }
    return stamp ? `${version}#${stamp}` : version;
  };

  /**
   * Fetch project at this revision: `{ json }`, or `{ json: null, currentRev }` if missing.
   * If the project client lacks `locate` (test double, old client), only `get` is used
   */
  async function fetchProject(projectId, projectRev) {
    if (typeof projects.locate === 'function') {
      const found = await projects.locate(projectId, projectRev);
      return { json: found?.project ?? null, currentRev: Number.isSafeInteger(found?.currentRev) ? found.currentRev : null };
    }
    return { json: await projects.get(projectId, projectRev), currentRev: null };
  }

  /**
   * Fetch (or compute) context for exactly this revision. Failures are not kept in cache and are
   * recomputed next time; if the document service specified the current revision, the error carries
   * `currentRev`
   */
  function exactContext(projectId, projectRev, signal) {
    const version = `${projectId}@${projectRev}`;
    const id = cacheIdOf(projectId, projectRev);
    const hit = cache.get(id);
    if (hit) {
      cache.delete(id);
      cache.set(id, hit);
      return hit;
    }
    const work = (async () => {
      let found;
      try { found = await fetchProject(projectId, projectRev); }
      catch (error) { throw fail(error?.code === 'digest-mismatch' ? 'bad-snapshot' : 'no-snapshot', `Cannot get project snapshot ${version}: ${error?.message || error}`, true); }
      const json = found.json;
      if (!json) throw Object.assign(fail('no-snapshot', `The document service has no project snapshot ${version}`, true), { currentRev: found.currentRev });
      const project = prepareProject(json);
      if (!Array.isArray(project?.tracks) || !Number.isFinite(project?.duration) || project.duration <= 0) {
        throw fail('bad-snapshot', `Project snapshot ${version} is not a renderable project`, false);
      }
      const out = await onLane(pipeline, () => pipeline.planForQueue(project, { signal }));
      if (projectRev > (newest.get(projectId) ?? -1)) newest.set(projectId, projectRev);
      return out;
    })();
    cache.set(id, work);
    while (cache.size > PLAN_CACHE_SIZE) cache.delete(cache.keys().next().value);
    work.catch(() => { if (cache.get(id) === work) cache.delete(id); });
    return work;
  }

  /**
   * Which revision to compute this task against (see "Project moved forward" at file header).
   * Returns `{ entry, context, streamSpecs, rev, drifted }`: `rev` is the revision actually used,
   * and `drifted` being true indicates it is not the revision specified by the task.
   */
  async function contextFor(task, signal) {
    const { projectId, projectRev, id: version } = versionOf(task);
    let want = projectRev;
    // Plans with clip manifests and their fine-grained tasks: if a newer revision has already been
    // computed, do not fall back to the old one
    const known = newest.get(projectId);
    if (isListWork(task) && Number.isSafeInteger(known) && known > want) want = known;
    for (let hop = 0; ; hop += 1) {
      try {
        const got = await exactContext(projectId, want, signal);
        if (want !== projectRev) say('executor.drift', { id: task?.id ?? null, version, actual: want });
        return { ...got, rev: want, drifted: want !== projectRev };
      } catch (error) {
        const next = error?.currentRev;
        if (!Number.isSafeInteger(next) || next <= want || hop >= DRIFT_MAX_HOPS) throw error;
        want = next;
      }
    }
  }

  async function plan(planTask, { signal } = {}) {
    const { id } = versionOf(planTask);
    const resolved = await contextFor(planTask, signal);
    if (planTask && typeof planTask === 'object') planned.set(planTask, resolved);
    const { entry, rev, drifted } = resolved;
    // Project moved forward: split against the actual revision, and write that revision to
    // source.projectRev of fine-grained tasks (local-node reads actualRev)
    let context = drifted ? { ...resolved.context, actualRev: rev } : resolved.context;
    // Task brief "Jia-3": whether to output the splitter's own stream share in the manifest plan:
    // this machine can produce (`ownListStreams` from `planForQueue`) and this project currently produces
    // streams (hosted render nodes check "Generate track streams"; other nodes are not managed per
    // project). Query live on each split; do not put into the per-version cache
    if (isListPlan(planTask) && perProject && !isExportOnlyPlan(planTask)) {
      const on = await streamsSettled(planTask, signal);
      // This project currently does not produce streams: when this machine writes the layer table, it
      // does not list its own streams for this revision (listing them with no producer causes the page to
      // fetch manifests in vain); previously dispatched streams are listed according to candidate
      // records, and outputs are retained (`layerMapStreamOptions` in `frame-pipeline.mjs` reads
      // `entry.ownStreamsOff`). Only processes managed per project write this flag
      if (entry && typeof entry === 'object') entry.ownStreamsOff = !on;
      if (!on && context.ownListStreams === true) {
        // When this setting is off: host render nodes produce no track streams at all (neither full-density
        // streams nor sparse streams, only Agent frame queries; semantics in workflow/project.md "Project
        // settings").
        context = { ...context, ownListStreams: false, ownListSparseStreams: false };
        say('executor.list-streams-off', { version: id, sparse: false });
      }
    }
    // c10a contract Section 17: record clip manifest of prerender retry plan tasks into the pipeline
    // (added to prerender set, written to layer table); splitting is done by local-node according to
    // the manifest.
    // C10 contract Section 18 Item 9: manifest plans from online pages take the same path (the manifest
    // consists of clips the page itself classified as heavy).
    // Manifest plans solely for export (`export-frames.mjs`) do not enter the prerender set: they only
    // yield export bitmap tasks, and preview uses none of their outputs
    if (isListPlan(planTask) && !isExportOnlyPlan(planTask) && typeof pipeline.addBackfill === 'function') {
      const added = pipeline.addBackfill(entry, planTask.input?.clips ?? []);
      say('executor.backfill', { version: id, clips: planTask.input?.clips?.length ?? 0, added });
    }
    // Layer table is not written here: written after split finishes based on actual output keys
    // (afterSplit, M7 D12)
    say('executor.plan', { version: id, entryKey: entry.key, controls: context.cardPlan.length, locks: context.cardLocks?.size ?? 0 });
    // Task E: mark snapshotOversize on cards where local snapshot store recorded oversize frames
    // (read live on each split: oversize records increase as this machine renders and pulls; do not enter
    // per-version cache)
    const { cardPlan, marked } = await markSnapshotOversize(pipeline, context);
    if (!marked.length) return context;
    say('executor.oversize', { version: id, clips: marked.length });
    return { ...context, cardPlan };
  }

  /**
   * Appendix Section 3 "Reconciling tasks back to control": record each mismatched item in `why`;
   * throw `plan-mismatch` if any
   */
  function matchControl(task, entry, { drifted = false } = {}) {
    const input = task.input ?? {};
    const control = (entry.cardPlan ?? []).find(item => item?.clipId === input.clipId);
    const why = [];
    // Computed against a revision other than the one specified by task (project moved forward):
    // clip is gone or content key changed = this content was superseded by a newer version, invalidated,
    // not counted as failure
    if (drifted) {
      const tier = control ? (control.tier || snapshotTier(control.capabilities)) : null;
      const current = !control ? null : tier === 'local' ? `${entry.key}/${control.contentKey}` : control.contentKey;
      if (!control || input.contentKey !== current) throw superseded(!control ? `The new version has no clip ${input.clipId}` : `The content of clip ${input.clipId} changed in the new version`);
    }
    if (!control) why.push(`This version has no clip ${input.clipId}`);
    else {
      const tier = control.tier || snapshotTier(control.capabilities);
      const from = task.range?.from, to = task.range?.to;
      if (tier !== task.tier) why.push(`tier ${task.tier} ≠ ${tier}`);
      if (!pipeline.queueHandles(control)) why.push('This card is not produced by the queue');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > control.count - 1) why.push(`Frame range ${JSON.stringify(task.range)} is outside 0..${control.count - 1}`);
      const own = pipeline.envFingerprint;
      if (!own) why.push('This machine has no environment fingerprint yet');
      if (tier === 'shared') {
        if (input.contentKey !== control.contentKey) why.push('Content keys differ');
        else if (own && task.resultKey !== resultKeyOf(control.contentKey, own)) why.push('The result key is not the key of this machine\'s fingerprint');
      } else if (tier === 'local') {
        if (input.entryKey !== entry.key) why.push(`entry.key differs (local ${entry.key})`);
        if (input.contentKey !== `${entry.key}/${control.contentKey}`) why.push('Content keys differ');
        else if (own && task.resultKey !== resultKeyOf(input.contentKey, own)) why.push('The result key is not the key of this machine\'s fingerprint');
      }
    }
    if (why.length) throw fail('plan-mismatch', `Task ${task.id} does not match this version's plan: ${why.join(';')}`, false);
    return control;
  }

  /**
   * M6c X1: Reconcile stream tasks back to streams of this revision. Streams are identified by
   * content key (`input.contentKey`, i.e. `contentKey` of `planStreams`); result key must be derived
   * from this machine's fingerprint (node-side filtering already blocked by fingerprint; verified
   * again here); segment range must fall within this stream.
   * Below-dependent streams (`requires.belowDependent: true`,
   * `docs/plan/prerender-products-contract.md` Section 5) are also identified by content key: its
   * content key includes target card and each lower layer; if lower layers change, the key changes,
   * and mismatches (project moved forward) are treated as invalidated; do not produce if kind
   * specified by the task does not match the stream in this revision.
   */
  function matchStream(task, specs, { drifted = false, entry = null } = {}) {
    const input = task.input ?? {};
    let spec = (specs ?? []).find(item => item?.contentKey === input.contentKey) ?? null;
    // Task brief "Jia-3": the splitter's own share split from the manifest plan. The manifest is
    // classified by the publisher; cards this machine did not classify as heavy are not in this
    // machine's streams (`specs`) for this revision;
    // this share contains only single-card streams and below-dependent streams (`listPlanOverrides` in
    // `local-node.mjs`), whose content keys are independent of what other clips remain in the manifest
    // (single-card streams look only at this card; below-dependent streams look at the target card and
    // layers beneath it); compute one live from the task's clip to reconcile.
    // The process that split it might be another process, or this process before restart, so do not
    // count on remembering the manifest from that time
    if (!spec && entry && isListWork(task) && typeof input.clipId === 'string' && input.clipId && typeof pipeline.listStreamSpecs === 'function') {
      let listed = [];
      try { listed = pipeline.listStreamSpecs(entry, [input.clipId]) ?? []; } catch { listed = []; }
      spec = listed.find(item => (item?.kind === 'card' || item?.kind === 'below') && item.contentKey === input.contentKey) ?? null;
    }
    if (!spec && drifted) throw superseded('The new version has no such stream');
    const why = [];
    const wantsBelow = task.requires?.belowDependent === true;
    if (!spec) why.push(`This version has no ${wantsBelow ? 'stream that depends on the lower layer (this machine has not opened this kind of stream, or the target card, lower layer and splitting differ)' : 'stream'} with content key ${String(input.contentKey).slice(0, 16)}…`);
    else if (wantsBelow !== (spec.kind === 'below')) why.push(`Stream kind mismatch (task ${wantsBelow ? 'wants' : 'does not want'} the whole-scene lower layer, this version's stream is ${spec.kind})`);
    else {
      const own = pipeline.envFingerprint;
      const from = task.range?.from, to = task.range?.to;
      if (!own) why.push('This machine has no environment fingerprint yet');
      else if (task.resultKey !== resultKeyOf(spec.contentKey, own)) why.push('The result key is not the key of this machine\'s fingerprint');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < spec.firstSegment || to < from || to > spec.lastSegment) {
        why.push(`Segment range ${JSON.stringify(task.range)} is outside ${spec.firstSegment}..${spec.lastSegment}`);
      }
    }
    if (why.length) throw fail('plan-mismatch', `Task ${task.id} does not match this version's stream: ${why.join(';')}`, false);
    return spec;
  }

  /**
   * Frame-by-frame export bitmap tasks dedicated to export (`export-frames.mjs`): compute the export
   * bitmap plan for this revision live based on the task's clip to reconcile (content key already
   * includes this card's content and sample window; below-dependent ones additionally include each
   * lower layer); fetch only if matched. If the project moved forward and this card's content changed,
   * this output was no longer wanted at that time (invalidated, not counted as failure).
   */
  async function renderExport(task, { signal, progress }) {
    if (typeof pipeline.exportStreamSpecs !== 'function' || typeof pipeline.renderExportFrames !== 'function') {
      throw fail('no-export-frames', 'This machine cannot fetch export bitmaps', false);
    }
    const { entry, drifted } = await contextFor(task, signal);
    const input = task.input ?? {};
    let specs = [];
    try { specs = pipeline.exportStreamSpecs(entry, [input.clipId], input.exportSalt)?.specs ?? []; } catch { specs = []; }
    const spec = specs.find(item => item?.exportKey === input.exportKey) ?? null;
    if (!spec && drifted) throw superseded(`The content of clip ${input.clipId} changed in the new version`);
    const why = [];
    const from = task.range?.from, to = task.range?.to;
    if (!spec) why.push(`This version has no export bitmap with content key ${String(input.exportKey).slice(0, 16)}…`);
    else {
      if (task.resultKey !== spec.exportResultKey) why.push('The result key is not the key of this machine\'s fingerprint');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > spec.lastSegment) why.push(`Segment range ${JSON.stringify(task.range)} is outside 0..${spec.lastSegment}`);
    }
    if (why.length) throw fail('plan-mismatch', `Task ${task.id} does not match this version's export bitmap: ${why.join(';')}`, false);
    const started = Date.now();
    await pipeline.renderExportFrames(entry, spec, { from, to }, { signal, progress });
    say('executor.render', { id: task.id, kind: 'export-frames', clipId: input.clipId, ms: Date.now() - started });
    return null;
  }

  async function renderStream(task, { signal, progress }) {
    if (typeof pipeline.streamCapable === 'function' && !(await pipeline.streamCapable())) {
      throw fail('no-streams', 'This machine cannot produce track streams (PROMPTCUT_STREAMS=0 or no usable H.264 encoder)', false);
    }
    const { entry, streamSpecs, drifted } = await contextFor(task, signal);
    const spec = matchStream(task, streamSpecs, { drifted, entry });
    // Stream tasks split from manifest plans are handled like snapshot tasks (see `render`): this card
    // might not have been classified as heavy on this machine; record it into the prerender set so the
    // layer table written by this machine can list this stream (`issuedStreamSpecs` in
    // `frame-pipeline.mjs` only looks at cards in the prerender set)
    if (isListWork(task) && typeof pipeline.addBackfill === 'function' && typeof pipeline.prerenderPicked === 'function'
      && !pipeline.prerenderPicked(entry, spec.topClipId)) {
      pipeline.addBackfill(entry, [spec.topClipId]);
    }
    const range = { from: task.range.from, to: task.range.to };
    const started = Date.now();
    // Sparse stream tasks (`input.density: 'sparse'`): capture only the first frame of each segment;
    // full density tasks do not include this field
    await pipeline.renderStreamRange(entry, spec, range, { signal, progress, density: isSparseStreamTask(task) ? STREAM_DENSITY_SPARSE : null });
    say('executor.render', { id: task.id, kind: 'stream', streamKey: spec.streamKey.slice(0, 12), ms: Date.now() - started });
    promoteOwnStream(entry, spec);
    return null;
  }

  /**
   * When several environments each output a share of a stream (the splitter's own and the browser's,
   * in pairs, first to claim gets it), candidate ordering in the layer table must correspond to "who
   * actually produced it":
   * pages entering later did not receive completion notices and take the first candidate. When
   * splitting completes, it is not yet known who will win, so place one's own after others first
   * (`afterSplit`);
   * only when this machine actually produces a segment of this stream does it promote its own to the
   * front here and rewrite the layer table once. If someone else wins, this machine's share is
   * invalidated by the queue and never reaches here, leaving the order untouched.
   * Do nothing if this stream is not in the record or does not have this machine's fingerprint
   * (splitter was not this machine).
   */
  function promoteOwnStream(entry, spec) {
    try {
      const own = pipeline.envFingerprint;
      const key = streamCandidateKey(spec?.contentKey);
      const list = typeof pipeline.splitCandidatesFor === 'function' ? pipeline.splitCandidatesFor(key) : null;
      if (!own || !Array.isArray(list) || !list.includes(own) || list[0] === own || typeof pipeline.recordSplitCandidates !== 'function') return false;
      pipeline.recordSplitCandidates(new Map([[key, [own, ...list.filter(fp => fp !== own)]]]));
      if (typeof publishLayerMap === 'function') publishLayerMap(entry);
      else if (typeof pipeline.publishLayerMap === 'function') pipeline.publishLayerMap(entry);
      say('executor.stream-candidates', { streamKey: String(spec.streamKey).slice(0, 12), first: 'own' });
      return true;
    } catch (error) {
      say('executor.stream-candidates-failed', { message: String(error?.message ?? error) });
      return false;
    }
  }

  async function render(task, { signal, progress, phase } = {}) {
    const say = (name, fields) => { try { phase?.(name, fields); } catch { /* Diagnostic callback errors do not affect execution */ } };
    if (isExportFramesTask(task)) return renderExport(task, { signal, progress });
    if (task?.kind === 'stream') return renderStream(task, { signal, progress });
    if (task?.kind !== 'snapshot') throw fail('bad-task', `Unknown task kind: ${task?.kind}`, false);
    say('project');
    const { entry, drifted } = await contextFor(task, signal);
    const control = matchControl(task, entry, { drifted });
    // c10a contract Section 17: clips of prerender retry fine-grained tasks might be classified as light
    // on this machine (not in the prerender set, so the pipeline skips them); record them as prerender
    // retries according to the task before rendering.
    // The plan that split them may have been claimed by another process or before this process restarted,
    // so plan() cannot be counted on to have already recorded them here.
    // Fine-grained tasks split from manifest plans (sent by online pages or Cloud Agent services) work
    // similarly: the manifest is classified by the publisher, and this machine never recorded them after
    // restarting or when switching to another revision
    if ((task.priority === 'backfill' || isListWork(task)) && typeof pipeline.addBackfill === 'function' && !pipeline.prerenderPicked(entry, control.clipId)) {
      pipeline.addBackfill(entry, [control.clipId]);
    }
    const range = { from: task.range.from, to: task.range.to };
    const started = Date.now();
    const total = range.to - range.from + 1;
    say('lane', { ahead: laneBusy(pipeline) });
    const tracked = done => {
      say(done >= total ? 'finish' : 'frames', { done, total });
      progress?.(done);
    };
    // Diagnostics (does not change behavior): time spent on each step of this shared-tier segment
    // (queuing, borrowing a prerender room, switching pages, pushing frames, storing, drawing small
    // sizes), recorded into executor.render
    const timing = {};
    // When running on an Agent dedicated instance and yielding to the Agent midway, report a step
    // periodically (session work count) so the lease is not treated as stalled by the queue
    // (AGENT-maint-3)
    const heartbeat = () => say('agent-yield');
    await onLane(pipeline, () => (task.tier === 'shared'
      ? pipeline.renderCardSnapshotRange(entry, control, range, { signal, progress: tracked, timing, heartbeat })
      : pipeline.renderSceneSnapshotRange(entry, control, range, { signal, progress: tracked, heartbeat })));
    say('executor.render', { id: task.id, tier: task.tier, clipId: control.clipId, ms: Date.now() - started });
    // The `say` above is a stage callback (this line remains unchanged); segment elapsed time is logged
    // on a separate line (`log`), which the editor process forwarder passes through
    note('executor.render-timing', { id: task.id, tier: task.tier, clipId: control.clipId, ms: Date.now() - started, ...timing });
    return null;
  }

  /**
   * M7 D12: Write layer table after splitting finishes based on actual output keys. `tasks` are
   * fine-grained tasks successfully published; recording candidates is done for all plans (later
   * layer tables written by this machine also list by it);
   * writing layer tables is only done for plans with clip manifests (online pages locate manifests
   * via the layer table). Failures are only logged.
   */
  async function afterSplit(planTask, { tasks = [] } = {}) {
    const { id } = versionOf(planTask);
    const candidates = splitCandidatesOf(tasks);
    if (typeof pipeline.recordSplitCandidates === 'function') {
      pipeline.recordSplitCandidates(candidates);
      // Candidates for track streams (used by the layer table `streams` table) are stored in the same
      // record with keys prefixed with `stream:`, separate from card content keys; do not record if there
      // are no stream tasks in this split
      const streamCandidates = splitStreamCandidatesOf(tasks);
      // Streams where this machine and another environment each output a share: place one's own at the
      // back first, and promote to the front only when actually produced (`promoteOwnStream`). Those
      // already in front (produced previously) are not moved back
      const own = pipeline.envFingerprint;
      const ordered = (contentKey, fps) => {
        if (!own || fps.length < 2 || !fps.includes(own)) return fps;
        const before = typeof pipeline.splitCandidatesFor === 'function' ? pipeline.splitCandidatesFor(streamCandidateKey(contentKey)) : null;
        return Array.isArray(before) && before[0] === own ? [own, ...fps.filter(fp => fp !== own)] : [...fps.filter(fp => fp !== own), own];
      };
      if (streamCandidates.size) pipeline.recordSplitCandidates(new Map([...streamCandidates].map(([contentKey, fps]) => [streamCandidateKey(contentKey), ordered(contentKey, fps)])));
    }
    // Plans solely for export do not write layer tables (preview does not read their outputs;
    // the page retrieves the index from the plan's completion response)
    if (!isListPlan(planTask) || isExportOnlyPlan(planTask)) return;
    try {
      // Layer table is written based on the revision actually used during splitting (when the project
      // moved forward, this is not the revision specified by planTask)
      const { entry } = planned.get(planTask) ?? await contextFor(planTask);
      if (typeof publishLayerMap === 'function') publishLayerMap(entry);
      else if (typeof pipeline.publishLayerMap === 'function') pipeline.publishLayerMap(entry);
      say('executor.layer-map', { version: id, cards: candidates.size, dual: [...candidates.values()].filter(fps => fps.length > 1).length });
    } catch (error) {
      say('executor.layer-map-failed', { version: id, message: String(error?.message ?? error) });
    }
  }

  /**
   * Idle claiming for standalone render hosts (contract A.12 [ruling], `render-node/host.mjs`): which
   * serial lane the task requires: snapshots and plans use `'queue'` (`runQueueTask`, processing
   * only one item at a time); streams use the stream prerender room pool and do not count (returns
   * null). `laneBusy()` is the number of jobs on this pipeline currently submitted to `'queue'` lane
   * via the executor that have not yet settled (including one that has already been aborted but
   * pipeline has not yet yielded).
   */
  const laneOf = task => (task?.kind === 'snapshot' || task?.kind === 'plan' ? 'queue' : null);
  return { plan, render, afterSplit, forget: () => { cache.clear(); newest.clear(); }, laneOf, laneBusy: () => laneBusy(pipeline) };
}
