import { createNodeSession } from './session.mjs';
import { lockKeyOf, splitPlan } from './split.mjs';
import { createTaskRunner, untilAborted } from './task-runner.mjs';
import { browserCardsOf, isListPlan, priorityBand } from '../render-queue/messages.mjs';
import { LOCK_IDLE_TAKEOVER_MS, QUEUE_DEFAULTS } from '../render-queue/constants.mjs';
import { exportIndexOf, isExportOnlyPlan } from './export-plan.mjs';

/**
 * Local render node arrangement (distributed prerender M3, contract
 * `docs/plan/render-queue-contract.md` Section D).
 *
 * Production arrangement module: strings together node session (`session.mjs`), splitting
 * (`split.mjs`), fine-grained task arrangement (`task-runner.mjs`), and three injected items:
 *
 *   endpoint  A connection to the queue (in-process loopback endpoint, WebSocket adapter layer
 *             starting from M5)
 *   executor  The actual worker: computes plans, renders a segment
 *   sink      Artifact store: push first, confirm fully received, then report complete (design 4.4,
 *             semantics `mechanism/asset-service.md`)
 *
 * Only recognizes these injected interfaces; does not import network, does not touch the file
 * system, does not read environment variables, does not start timers, and does not recognize any
 * real storage. Loopback transport, mock executor, and mock artifact store exist only in
 * `server/test/` (for testing and in-process integration only); production code must not import them.
 * Ticks are driven by caller: call `tick()` at intervals.
 *
 * # After claiming a task
 *
 * Before starting work, synchronously report progress 0 once, so that queue stall rules also cover
 * frozen executors that never report progress.
 *
 *   plan    executor.plan → splitPlan → task.publish fine-grained tasks (with reqId) → wait for
 *           task.published with the same reqId → (if card-locked, re-split and resend according to
 *           lock) → complete this plan (plan tasks with a clip manifest: prerender set is replaced
 *           with its clip manifest; streams are only split by clips in the manifest; prerender
 *           retry plans (backfill) do not split streams, fine-grained tasks are marked backfill,
 *           see `listPlanOverrides`)
 *   fine-grained task  If sink.has is true, directly complete (dedup, with sink.resultFor
 *           manifest); otherwise executor.render → sink.put → complete only when fully received
 *           (with manifest returned from put), fail if not fully received (retryable). ref received
 *           by sink includes task input and requires (contract J.3). This section is in isomorphic
 *           `task-runner.mjs` (M7 D11: shared by pure browser nodes in pages, without pulling in
 *           split.mjs and node:crypto), behavior remains the same as before
 *   M7      When claim response for plan includes `browserFingerprints` (D1), hand over to
 *           splitting, producing another copy for cards the browser can do; after splitting
 *           completes, pass fine-grained tasks that were ultimately published successfully to
 *           `executor.afterSplit` (optional, writes layer table v 3, D12); `takeoverLocked` receives
 *           lock description `{ lockIdleMs, lockedByProfile, lockUndone }` in publish response (D2),
 *           PC and standalone render host pass `idleLockTakeover`
 *   error   fail, non-retryable only when `error.retryable === false`
 *
 * Publishing must precede completion: derived tasks inherit plan user and subscribers (contract
 * A.4, last paragraph), provided that the plan is still claimed by this node at the moment of
 * publishing. Therefore, complete only after publish response returns and publishing is confirmed
 * effective (contract F.7 item 5).
 *
 * # Publishing rejected by lock (contract F.7)
 *
 * The queue rejects creating cards locked by other fingerprints; corresponding response item is
 * `{ id, error: 'card-locked', lockedBy: X }`. Merge lock keys of these items and X into `cardLocks`
 * and rerun `splitPlan`, resending only tasks for these lock keys: items matched by `takeoverLocked`
 * are resent with `takeover` using this node's fingerprint; the rest emit keys according to X. Retry
 * at most `RELOCK_ROUNDS` rounds, and give up if still rejected; if any resend occurred, report
 * `plan-relocked { id, lockKeys, gaveUp }`. `derived` in `complete` only lists ids ultimately
 * published successfully (response item has no `error`).
 *
 * Waiting for responses does not start timers, but is driven only by received messages: responses,
 * `error` with the same reqId (treated as retryable failure), and abort signals (lost claim, yield,
 * stop). On `start()` reconnect, still-held plans resend pending publishes once using the original
 * reqId (publishing is idempotent, merged into existing tasks); if responses are lost without
 * reconnecting, lease renewal progress stays at 0 and is reclaimed by queue stall rules.
 *
 * # "Still held" and late results
 *
 * Each claim starts one "execution" (run), with its own token and AbortController. In execution,
 * after each await settles and before sending any message to the queue, recheck whether it is still
 * held:
 *
 *   Not stopped, current execution not aborted, running table still points to this execution, and
 *   `session.held()` has a hold with the same id and same token
 *
 * No await between check and message send, so no other message can intervene. Session `complete` /
 * `fail` / `progress` uses the token held by the session **at this moment**, so the "same token"
 * rule guarantees an old execution will never complete a task with a new token: when the same id is
 * reclaimed by this node under a new token, the old execution has already been aborted by `onLost`
 * and its token does not match. If the check fails, discard the result and report `discarded` without
 * sending any message. Artifacts already pushed to artifact store are not reclaimed:
 * content-addressed, so the next claimer checking `has` will complete directly.
 *
 * `start(resume)` only resumes items in the running table of this instance with matching tokens:
 * resume is only used for reconnects of the same instance.
 *
 * Every wait on an injected interface races with the abort signal: if executor or artifact store
 * ignores abort and never returns, this execution still settles on abort (`settled()` will not be
 * held up by a stuck executor), and whatever it returns afterwards is discarded.
 *
 * @typedef {object} PlanContext Result of executor.plan, fed as-is to splitPlan (contracts B.4, F.2)
 * @property {string} entryKey
 * @property {object[]} cardPlan
 * @property {Set<string>} [prerenderSet]
 * @property {object[]} [streams]
 * @property {number[]} [anchorFrames]
 * @property {Record<string, string>} [cardSourceVersions]
 * @property {(control: object) => object} [weightOf]
 * @property {(control: object) => boolean} [isUserCard]
 * @property {(control: object) => boolean} [isGraphCard]
 * @property {Map<string, string> | Record<string, string>} [cardLocks]
 *   Per-card fingerprint lock (contract F.2): lock key `<kind>:<input.contentKey>` → lock
 *   fingerprint. Cards locked by other fingerprints emit keys according to the lock fingerprint,
 *   and remaining frames are only given to nodes with the same fingerprint
 * @property {boolean | Set<string> | ((lockKey: string) => boolean)} [takeover]
 *   Which cards locked by other fingerprints to take over: emit keys according to this node's
 *   fingerprint, task includes `takeover: true`
 * @property {string | null} [localMedia]
 *   Local tier capability gate (M6c X2): publisher nodeId when this project revision contains
 *   assets without content hashes. Fine-grained tasks where `usesLocalMedia` returns true set
 *   `requires.localMedia`, which only that node can claim
 * @property {(control: object) => boolean} [usesLocalMedia]
 *   Which control inputs use these assets (all by default)
 *
 * @typedef {object} Executor Executor (contract D.1)
 * @property {(planTask: object, opts: { signal: AbortSignal }) => Promise<PlanContext>} plan
 *   Computes the plan for this project revision. planTask is TaskView
 * @property {(task: object, opts: { signal: AbortSignal, progress: (done: number) => void }) => Promise<unknown>} render
 *   Renders a segment. task is TaskView; progress(done) reports progress; returned artifacts are
 *   opaque and passed as-is to sink.put. Errors thrown with `retryable === false` are treated as
 *   non-retryable, otherwise retryable
 * @property {(planTask: object, info: { tasks: object[], derived: string[] }) => unknown} [afterSplit]
 *   (M7 D12) Called once after splitting completes and all publish responses return; `tasks` are the
 *   fine-grained tasks (TaskInput) ultimately published successfully. Does not wait for it; errors
 *   only log events
 *
 * @typedef {object} SinkRef
 * @property {string} resultKey
 * @property {'snapshot' | 'stream'} kind
 * @property {'shared' | 'local' | null} tier Stream tasks are null
 * @property {{ unit: string, from: number, to: number }} range
 * @property {object} [input] Task input, as-is (contract J.3; C6.2 Section 11 item 3)
 * @property {object} [requires] Task requires, as-is
 *
 * @typedef {object} Sink Artifact store (contract D.1; implemented by asset service starting from M5)
 * @property {(ref: SinkRef) => Promise<boolean>} has Whether this segment has been fully received
 * @property {(entry: SinkRef & { artifacts: unknown, meta: { taskId: string, nodeId: string, token: number } }) => Promise<{ complete: boolean, result?: object }>} put
 *   Pushes a segment; `complete !== true` indicates not fully received. meta is for accounting
 *   (design Section 7 "Node trust"). When response includes `result` (task manifest), spreads into
 *   `task.complete` result (contract J.3)
 * @property {(ref: SinkRef) => Promise<object | null>} [resultFor]
 *   Fetches manifest of this segment after `has` returns true (C6.4 Section 3); spreads into result
 *   on dedup completion. If this method is absent, returns null, or throws, completes with only
 *   `{ ranges, dedup: true }` (contract J.10)
 *
 * @typedef {object} Endpoint A connection to the queue
 * @property {(message: object) => void} send
 * @property {(handler: (message: object) => void) => void} onMessage
 *
 * @typedef {object} LocalNode
 * @property {(resume?: { id: string, token: number }[]) => void} start
 * @property {() => void} tick
 * @property {(reason?: string) => number} yieldAll
 * @property {() => void} stop
 * @property {() => string[]} running
 * @property {() => { id: string, kind: string, phase: string }[]} occupying
 *   Executions that have not yet reached push (contract A.12 [ruling])
 * @property {() => Promise<void>} settled
 * @property {ReturnType<typeof createNodeSession>} session
 */

const noop = () => {};

/** Maximum retry rounds after publish is rejected by card-locked (contract F.7 item 5). */
const RELOCK_ROUNDS = 2;

/**
 * Determination of lock idle takeover (M7 contract D2, Section 13 ruling): used for
 * `createLocalNode({ takeoverLocked })`, passed by both PC and standalone render host.
 * When publish response indicates this card is locked on another environment: take over only if
 * locking party has been idle for **strictly more than** 30 s
 * (`lockIdleMs > LOCK_IDLE_TAKEOVER_MS`, same value as `CARD_LOCK_IDLE_MS` in local lock store
 * `server/card-lock.mjs`), and locking party still has unfinished work for this card
 * (`lockUndone` is not 0; treated as "unknown" if missing, does not block): semantics: "still
 * missing frames, and the locking party has not produced for some time, so take over the entire
 * card with own fingerprint" (`mechanism/rendering.md`). Never take over if `lockIdleMs` is
 * absent in response (legacy queue). Pure function.
 *
 * @param {string} lockKey
 * @param {string} lockedBy
 * @param {{ lockIdleMs?: number, lockedByProfile?: string | null, lockUndone?: number }} [info]
 * @returns {boolean}
 */
export function idleLockTakeover(lockKey, lockedBy, info = {}) {
  const idle = info?.lockIdleMs;
  if (typeof idle !== 'number' || !Number.isFinite(idle)) return false;
  return idle > LOCK_IDLE_TAKEOVER_MS && info.lockUndone !== 0;
}

/**
 * `takeoverLocked` (boolean or `(lockKey, lockedBy, info) => boolean`) → predicate function; only
 * recognizes `=== true`.
 * `info` is description of this lock `{ lockIdleMs, lockedByProfile, lockUndone }` in publish
 * response (M7 D2; absent in legacy queues).
 */
function takeoverLockedTest(takeoverLocked) {
  if (takeoverLocked === true) return () => true;
  if (typeof takeoverLocked === 'function') return (lockKey, lockedBy, info) => takeoverLocked(lockKey, lockedBy, info) === true;
  return () => false;
}

/** Copies `cardLocks` (Map, plain object, or omitted) into a Map, then merges new locks. */
function mergedLocks(cardLocks, extra) {
  const out = new Map();
  if (cardLocks != null) {
    const entries = typeof cardLocks.entries === 'function' && typeof cardLocks.get === 'function'
      ? cardLocks.entries()
      : Object.entries(cardLocks);
    for (const [key, value] of entries) out.set(key, value);
  }
  for (const [key, value] of extra) out.set(key, value);
  return out;
}

/**
 * Plan tasks with a clip manifest: prerender retry plan (c10a contract Section 17; (legacy page
 * `backfill` tier; online pages always send normal-priority manifest plans starting from 2026-10-07,
 * this tier has no new publishers and is kept only to recognize legacy pages during deployment
 * transitions)) and online page manifest plans (C10 contract Section 7, Section 18 item 9). Clips
 * in the manifest calculate keys as heavy cards: prerender set is replaced with the manifest
 * (independent of local classification as heavy).
 * The tier of fine-grained tasks follows plan: prerender retry plans are all marked `backfill`,
 * and manifest plans follow normal ranking. Returns an empty object when not a plan with a
 * manifest, splitting as before.
 *
 * Track streams (`docs/plan/browser-stream-task.md` first occurrence; task brief
 * `docs/plan/render-refactor-task.md` "Jia-3"):
 *   - Prerender retry plan does not split streams as before (legacy pages that send it do not
 *     consume streams);
 *   - Online page manifest plans: when executor provides `browserStreamsFor` (computes streams
 *     from clips in the manifest, `planForQueue` in `frame-pipeline.mjs`), produce a copy of these
 *     streams for browser (single-card streams, produced only if browser can do them). **Splitter's
 *     own copy** depends on `ownListStreams` provided by executor:
 *       - If true (this machine can produce streams at this moment; host render nodes additionally
 *         require "generate track streams" enabled for this project, collected per project by
 *         executor, `plan` in `prerender-executor.mjs`): emit single-card streams together with its
 *         own copy, paired with browser copy according to `splitPlan` rules (`input.dual`, first to
 *         claim gets it);
 *       - If false and executor provides `ownListSparseStreams: true` (host render nodes can produce
 *         streams, "generate track streams" is disabled for this project): mark single-card
 *         streams as `ownSparseOnly`, splitter's own copy emits only sparse stream tasks (file
 *         header "Sparse stream tasks" in `splitPlan`), and browser copy proceeds as usual;
 *       - If neither is true (this machine cannot produce streams, legacy executor): emit only for
 *         browser as before (`browserOnly`), splitter itself does not produce.
 *     Group streams are marked `browserOnly` at all times (browser cannot draw them, equivalent to
 *     not emitting): content key of group streams changes with "which clips remain in the
 *     manifest", does not match back to this revision when stream tasks return, and layer table
 *     cannot list it (`issuedStreamSpecs` in `frame-pipeline.mjs` only recognizes single-card
 *     streams and below-dependent streams).
 *     **Below-dependent streams** (`kind: 'below'`, task brief "Wu-2" under "Lower layer 4"):
 *     handled with the same switches as single-card streams: emit splitter's own copy when
 *     `ownListStreams` is true (both sparse and full density tasks), mark `ownSparseOnly` when only
 *     `ownListSparseStreams` is present, and mark `browserOnly` when neither is true. `splitPlan`
 *     never emits browser copy to begin with (browser cannot do it: requires isolated project plus
 *     differential layer extraction), so such streams are emitted only under splitter's own
 *     fingerprint and produced by splitter itself; marking `browserOnly` emits nothing. Its
 *     content key is determined solely by the target card and layers beneath it, independent of
 *     which clips remain in the manifest, and can be matched back upon stream task return by
 *     computing one on the fly for the target card (`matchStream` in `prerender-executor.mjs`).
 *     If executor does not provide `browserStreamsFor` (legacy executor, test double), do not
 *     split streams, same as before.
 *
 * Manifest plans for export only (`input.exportOnly: true`, sent during online browser export for
 * cards not executed on this page; `../export-frames.mjs`):
 *   Prerender set is empty (does not split snapshots) and does not split track streams; only emits
 *   export bitmap tasks (`exportStreams`, provided by executor's `exportStreamsFor`) according to
 *   clips in the manifest; unsupported clips and reasons are in `exportUnsupported`. When executor
 *   does not provide `exportStreamsFor` (legacy executor), records all as unsupported (`no-executor`).
 */
export function listPlanOverrides(task, plan) {
  if (!isListPlan(task)) return {};
  const clips = Array.isArray(task.input?.clips) ? task.input.clips.filter(id => typeof id === 'string' && id) : [];
  if (isExportOnlyPlan(task)) {
    let found = null;
    // `input.exportSalt`: identifier carried when re-exporting after a previous page failure,
    // export key changes accordingly (`exportSaltOf` in `../export-frames.mjs`)
    if (typeof plan?.exportStreamsFor === 'function') { try { found = plan.exportStreamsFor(new Set(clips), task.input?.exportSalt); } catch { found = null; } }
    const exportStreams = Array.isArray(found?.streams) ? found.streams.filter(s => s && typeof s === 'object') : [];
    const exportUnsupported = found ? (Array.isArray(found.unsupported) ? found.unsupported : []) : clips.map(clipId => ({ clipId, reason: 'no-executor' }));
    return { prerenderSet: new Set(), streams: [], exportStreams, exportUnsupported, lane: 'normal' };
  }
  const backfill = priorityBand(task.priority) === 'backfill';
  let streams = [];
  if (!backfill && typeof plan?.browserStreamsFor === 'function') {
    const own = plan.ownListStreams === true;
    const sparseOwn = !own && plan.ownListSparseStreams === true;
    const single = s => s.kind === 'card' && s.plane === 'local' && Array.isArray(s.clipIds) && s.clipIds.length === 1;
    // Below-dependent streams: only one member (the target card), in stage coordinates; splitter's own
    // copy is emitted following the same switches as single-card streams
    const below = s => s.kind === 'below' && s.plane === 'stage' && Array.isArray(s.clipIds) && s.clipIds.length === 1;
    const ownable = s => single(s) || below(s);
    try {
      streams = (plan.browserStreamsFor(new Set(clips)) ?? []).filter(s => s && typeof s === 'object')
        .map(s => (own && ownable(s) ? { ...s } : sparseOwn && ownable(s) ? { ...s, ownSparseOnly: true } : { ...s, browserOnly: true }));
    } catch { streams = []; }
  }
  return { prerenderSet: new Set(clips), streams, lane: backfill ? 'backfill' : 'normal' };
}

/** Description of a lock in publish response (M7 D2): omitted if not present */
function lockInfoOf(result) {
  const info = {};
  for (const k of ['lockIdleMs', 'lockedByProfile', 'lockUndone']) if (result?.[k] !== undefined) info[k] = result[k];
  return info;
}

/**
 * @param {object} options
 * @param {string} options.nodeId
 * @param {string} [options.publisherId]  Defaults to nodeId; fine-grained tasks split out are
 *   published with it
 * @param {object} options.node           Node description from contract B.2
 * @param {Endpoint} options.endpoint
 * @param {() => number} options.now
 * @param {() => number} [options.random]
 * @param {() => boolean} [options.isIdle]
 * @param {number} [options.maxConcurrent]
 * @param {object} [options.constants]
 * @param {string[] | 'all'} [options.projects]
 * @param {string} [options.codeVersion]  Written to requires.codeVersion when splitting fine-grained
 *   tasks
 * @param {Executor} options.executor
 * @param {Sink} options.sink
 * @param {boolean | ((lockKey: string, lockedBy: string, info: object) => boolean)} [options.takeoverLocked]
 *   Whether to take over when publication is rejected with card-locked (contract F.7): defaults to
 *   false, resend using locking party's fingerprint; pc and standalone render host pass
 *   `idleLockTakeover` (M7 D2)
 * @param {(event: object) => void} [options.onEvent]  For diagnostics
 * @param {(task: object, info: { held: number }) => boolean} [options.canClaim]  Whether this task
 *   can start right now (checked once before session claim; used by standalone render host,
 *   contract A.12 [ruling])
 * @param {() => number} [options.claimLimit]  Maximum items held at this moment (claim gate; always
 *   defaults to maxConcurrent, see session.mjs)
 * @returns {LocalNode}
 */
export function createLocalNode({
  nodeId,
  publisherId = nodeId,
  node,
  endpoint,
  now,
  random,
  isIdle,
  maxConcurrent,
  constants = {},
  projects,
  codeVersion,
  executor,
  sink,
  takeoverLocked = false,
  onEvent = noop,
  canClaim,
  claimLimit,
}) {
  /** Publications awaiting responses: reqId → { run, message, resolve, reject } */
  const publishes = new Map();
  let publishSeq = 0;
  /**
   * Whether the queue recognizes sparse stream tasks (`node.welcome.sparseStreams`; omitted by older
   * queues): only split sparse stream tasks when true (`sparseStreams` in `splitPlan`)
   */
  let sparseStreams = false;
  let attached = false;
  const takesOverLocked = takeoverLockedTest(takeoverLocked);

  // Diagnostic callback errors must not interrupt protocol flow (it may be called inside message handlers)
  const emit = event => {
    try { onEvent(event); } catch { /* Swallow exceptions from diagnostic callbacks */ }
  };

  // Arrangement of fine-grained tasks is in isomorphic modules (M7 D11); plan splitting is only
  // here (requires split.mjs)
  // eslint-disable-next-line prefer-const
  let session;
  const runner = createTaskRunner({ nodeId, session: () => session, executor, sink, emit, executePlan, now });
  const { holding } = runner;

  // Do not pass undefined, letting the session use its own default value
  const sessionOptions = { nodeId, node, send: message => endpoint.send(message), now, constants, onTask: runner.onTask, onLost: runner.onLost };
  if (random !== undefined) sessionOptions.random = random;
  if (isIdle !== undefined) sessionOptions.isIdle = isIdle;
  if (maxConcurrent !== undefined) sessionOptions.maxConcurrent = maxConcurrent;
  if (projects !== undefined) sessionOptions.projects = projects;
  if (canClaim !== undefined) sessionOptions.canClaim = canClaim;
  if (claimLimit !== undefined) sessionOptions.claimLimit = claimLimit;
  session = createNodeSession(sessionOptions);

  /**
   * Sends a `task.publish` (with a reqId unique to this instance) and waits for `task.published`
   * with the same reqId to return, returning its `results`. If `error` returns for the same reqId
   * (such as bad-message), reject with a retryable error.
   * Do not start a timer; races with abort signal, canceling waiting after aborting or settling.
   */
  function publishAndWait(run, tasks) {
    publishSeq += 1;
    const reqId = `${publisherId}#publish-${publishSeq}`;
    const message = { type: 'task.publish', tasks, reqId };
    const waiting = () => new Promise((resolve, reject) => {
      // Register before sending: under synchronous transport, the response may arrive before send returns
      publishes.set(reqId, { run, message, resolve, reject });
      endpoint.send(message);
    });
    return untilAborted(waiting, run.controller.signal).finally(() => publishes.delete(reqId));
  }

  /**
   * Splits and publishes derived tasks, handling card-locked creation rejection (contract F.7 item 5).
   * → `{ derived: successfully published ids, published: successfully published fine-grained tasks
   *      (TaskInput, layer table is written from it, M7 D12), relocked: resent lock keys (ascending),
   *      gaveUp: lock keys still rejected in the end (ascending) }`.
   * "Successfully published" = response item has no `error` and status is not failed.
   * After waiting for each response, only continue if still held; return early when no longer held,
   * to be discarded by caller.
   */
  async function publishDerived(run, base, ctxLocks) {
    const derived = [];
    const seen = new Set();
    const published = new Map();   // id → TaskInput (the copy from the last successful publish)
    const relocked = new Set();
    const learned = new Map();   // Locks reported by responses: lockKey → lockedBy, accumulated round by round
    let gaveUp = [];
    let tasks = splitPlan(base);
    for (let round = 0; tasks.length > 0; round += 1) {
      const results = await publishAndWait(run, tasks);
      if (!holding(run)) break;
      const byId = new Map(tasks.map(t => [t.id, t]));
      /** Rejected in this round: lockKey → { lockedBy, info } */
      const rejected = new Map();
      /**
       * Successfully published in this round under locks with other fingerprints, where responses carry
       * lock descriptions (M7-A10): lockKey → { lockedBy, info, ids }
       */
      const followed = new Map();
      for (const r of Array.isArray(results) ? results : []) {
        if (r?.id == null) continue;
        if (r.error == null) {
          if (!seen.has(r.id)) { seen.add(r.id); derived.push(r.id); }
          if (r.state !== 'failed' && byId.has(r.id)) published.set(r.id, byId.get(r.id));
          const task = byId.get(r.id);
          const fp = task?.requires?.envFingerprint;
          const lockKey = lockKeyOf(task);
          // Locks on other environments: keyed by lock (fp is not self), or existing tasks merged in with
          // response carrying lockedBy (not rejected, F.7)
          const lockedBy = typeof r.lockedBy === 'string' && r.lockedBy ? r.lockedBy : fp;
          if (r.lockIdleMs !== undefined && lockKey != null && typeof lockedBy === 'string' && lockedBy && lockedBy !== node?.envFingerprint) {
            const entry = followed.get(lockKey) ?? { lockedBy, info: lockInfoOf(r), ids: [] };
            entry.ids.push(r.id);
            followed.set(lockKey, entry);
          }
          continue;
        }
        // limit and other errors: not created, excluded from derived, and skip lock handling (F.7 item 4)
        if (r.error !== 'card-locked') continue;
        const lockKey = lockKeyOf(byId.get(r.id));
        if (lockKey == null || typeof r.lockedBy !== 'string' || r.lockedBy === '') continue;
        rejected.set(lockKey, { lockedBy: r.lockedBy, info: lockInfoOf(r) });
      }
      // M7-A10: Cards keyed by lock (local lock store says locked on another environment, publish will
      // not be rejected) are likewise evaluated for takeover per D2: if locking party idle timed out and
      // not yet finished, treat this card as rejected, and resend below with takeover using this node's
      // fingerprint; copies sent per lock are immediately invalidated by queue, not counted as
      // successful publish
      for (const [lockKey, entry] of followed) {
        if (rejected.has(lockKey) || !takesOverLocked(lockKey, entry.lockedBy, entry.info)) continue;
        rejected.set(lockKey, { lockedBy: entry.lockedBy, info: entry.info });
        for (const id of entry.ids) {
          published.delete(id);
          const at = derived.indexOf(id);
          if (at >= 0) derived.splice(at, 1);
          seen.delete(id);
        }
      }
      if (rejected.size === 0) break;
      for (const lockKey of rejected.keys()) relocked.add(lockKey);
      if (round >= RELOCK_ROUNDS) {
        gaveUp = [...rejected.keys()].sort();
        break;
      }
      for (const [lockKey, { lockedBy }] of rejected) learned.set(lockKey, lockedBy);
      const cardLocks = mergedLocks(ctxLocks, learned);
      const takeover = lockKey => rejected.has(lockKey)
        && takesOverLocked(lockKey, rejected.get(lockKey).lockedBy, rejected.get(lockKey).info);
      // Only resend lock keys rejected in this round; remaining tasks have already been published and
      // are not resent
      tasks = splitPlan({ ...base, cardLocks, takeover }).filter(t => rejected.has(lockKeyOf(t)));
    }
    return { derived, published: [...published.values()], relocked: [...relocked].sort(), gaveUp };
  }

  /**
   * plan task: compute plan → split → publish (await response) → hand over to executor to write
   * layer table → complete. Exceptions are caught by runner (fail)
   */
  async function executePlan(run, task, ctx = {}) {
    const { id } = run;
    const { signal } = run.controller;
    const discard = () => emit({ type: 'discarded', id });
    const plan = await untilAborted(() => executor.plan(task, { signal }), signal);
    if (!holding(run)) return discard();
    // Put plan first: splitting node's own fingerprint, plan, and code version definitely take effect
    // (design 2.1); cardLocks / takeover carried by plan are passed as-is to splitting along with
    // expansion (contract F.2).
    // M7 D1: Browser fingerprints in claim response (pure browser nodes of the same user online for
    // this project on document service) are handed to splitting
    const browserFingerprints = Array.isArray(ctx.browserFingerprints) ? ctx.browserFingerprints : [];
    // Chunk N: Which user cards and media effect cards this page (same user) can run: page self-reports
    // in manifest plan's `input.browser`, and `browserCardEnvFingerprints` from document service is
    // credential that "such an online node indeed exists"; only when both match is browser given copies
    // for user cards and media effect cards (`browserCards` of `splitPlan`)
    const browserCards = browserCardsOf(task?.input?.browser);
    const browserCardEnvFingerprints = Array.isArray(ctx.browserCardEnvFingerprints) ? ctx.browserCardEnvFingerprints : [];
    // Executor split by another version (project moved forward, contract J.15): fine-grained task's
    // `source.projectRev` records the actual revision; `derivedFrom` remains this plan
    const cutBy = Number.isSafeInteger(plan?.actualRev) && plan.actualRev !== task?.source?.projectRev
      ? { ...task, source: { ...task.source, projectRev: plan.actualRev } }
      : task;
    // Nodes that only split and do not claim fine-grained tasks (`planOnly`, test only, filter.mjs
    // rule 8) do not emit their own stream copy: they will not do it, and emitting it only adds
    // a candidate that no one will ever produce
    const listPlan = node?.planOnly === true && (plan?.ownListStreams === true || plan?.ownListSparseStreams === true)
      ? { ...plan, ownListStreams: false, ownListSparseStreams: false } : plan;
    const base = { ...plan, planTask: cutBy, envFingerprint: node?.envFingerprint, codeVersion, constants, browserFingerprints, browserCards, browserCardEnvFingerprints, sparseStreams,
      ...listPlanOverrides(task, listPlan) };
    const outcome = await publishDerived(run, base, plan?.cardLocks);
    if (!holding(run)) return discard();
    const { derived, published, relocked, gaveUp } = outcome;
    if (relocked.length > 0) emit({ type: 'plan-relocked', id, lockKeys: relocked, gaveUp });
    // M7 D12: Write layer table once after splitting completes (candidates in each layer follow final
    // emitted keys), and hand to executor; do not await it, failures only log events
    if (typeof executor.afterSplit === 'function') {
      try {
        Promise.resolve(executor.afterSplit(task, { tasks: published, derived })).catch(error => {
          emit({ type: 'after-split-failed', id, error: String(error?.message ?? error) });
        });
      } catch (error) {
        emit({ type: 'after-split-failed', id, error: String(error?.message ?? error) });
      }
    }
    // Export-only plan: return key and shape of each export bitmap to page upon completion (page reads
    // from `task.done`, `exportIndexOf` in `export-plan.mjs`)
    const exportIndex = isExportOnlyPlan(task)
      ? exportIndexOf({ exportStreams: base.exportStreams, exportUnsupported: base.exportUnsupported, published, projectRev: cutBy?.source?.projectRev,
        segmentsPerTask: constants?.STREAM_SEGMENTS ?? QUEUE_DEFAULTS.STREAM_SEGMENTS })
      : null;
    session.complete(id, { ranges: null, derived, ...(exportIndex ? { exportIndex } : {}) });
    emit({ type: 'plan-split', id, derived });
  }

  function handle(message) {
    if (runner.stopped()) return;
    if (message?.type === 'node.welcome') sparseStreams = message.sparseStreams === true;
    session.receive(message);
    const waiter = message?.reqId != null ? publishes.get(message.reqId) : undefined;
    if (waiter && message.type === 'task.published') {
      waiter.resolve(message.results);
    } else if (waiter && message.type === 'error') {
      const error = new Error(`publish-${message.reason ?? 'error'}`);
      error.retryable = true;
      waiter.reject(error);
    }
    if (message?.type === 'task.published') emit({ type: 'publish-result', results: message.results });
  }

  function start(resume = []) {
    runner.resume();
    if (!attached) {
      endpoint.onMessage(handle);
      attached = true;
    }
    endpoint.send({ type: 'publisher.hello', publisherId });
    // Only resume claims that this instance is actually running with matching tokens: other items have
    // no execution to complete them, so resuming them only repeatedly renews leases, holding
    // maxConcurrent. The running table of a new process instance is empty, equivalent to not resuming
    // (contract D.2 [ruling])
    const resumable = (resume ?? []).filter(entry => entry && runner.tokenOf(entry.id) === entry.token);
    session.start(resumable);
    // If resumed plan is still awaiting publish responses: responses on old connection will not
    // arrive, so resend once with original reqId.
    // Publishing is idempotent (existing tasks only merge subscribers), and at this point plan is
    // still claimed by this node, so inheritance condition still holds
    for (const waiter of [...publishes.values()]) {
      if (holding(waiter.run)) endpoint.send(waiter.message);
    }
  }

  function tick() {
    if (runner.stopped()) return;
    session.tick();
  }

  function yieldAll(reason = 'busy') {
    runner.abortAll(reason);
    return session.yieldAll(reason);
  }

  function stop() {
    runner.stop('stopped');
  }

  return {
    start,
    tick,
    yieldAll,
    stop,
    running: runner.running,
    occupying: runner.occupying,
    settled: runner.settled,
    get session() { return session; },
  };
}
