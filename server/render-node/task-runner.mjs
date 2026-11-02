/**
 * Execution arrangement of fine-grained tasks (M7 contract D11 (a): isomorphic module extracted
 * from `local-node.mjs`, shared between desktop and page pure browser nodes).
 *
 * Imports no modules: does not import `split.mjs`, the queue core, or `fingerprint.mjs`, has no
 * `node:` built-in modules, sets no timers, and reads no environment variables, so it can enter
 * the page build as-is. Splitting (`plan` tasks) is not here: desktop `local-node.mjs` injects it
 * via `executePlan`; pure browsers do not claim plan (Design 4.3 Rule 6), the page does not provide
 * `executePlan`, and if a plan is actually received it is treated as a non-retryable failure.
 *
 * # After claiming a fine-grained task (same practice as local-node since M3, contract D.2)
 *
 *   Before starting work, synchronously report progress 0 once: queue stall rules take effect only
 *   when done !== null, allowing recovery even if the executor freezes and never reports progress.
 *   If sink.has is true, complete directly (dedup, with manifest from sink.resultFor); otherwise
 *   executor.render → sink.put → complete only after collecting everything (with manifest returned
 *   from put); fail if not fully collected (retryable). The ref received by sink includes the
 *   task's input and requires (contract J.3).
 *   On error, fail; non-retryable only when `error.retryable === false`.
 *   If error thrown by the executor has `superseded === true` (this content has been superseded by
 *   a newer version, `render-queue-contract.md` J.15): still send `task.fail`, but error is fixed to
 *   `'superseded'` and non-retryable (the queue recognizes invalidation by this error), and the
 *   diagnostic event is `superseded` rather than `failed`.
 *
 * # "Still holding" and late results
 *
 * Each claim starts one "run" with its own token and AbortController. In the run, after each await
 * settles and before sending any message to the queue, recheck "still holding": not stopped, this
 * run has not been aborted, the running table still contains this run, and `session.held()` has a
 * holding with matching id and token. Do not await between checking and sending messages. If the
 * check fails, discard the result and report `discarded` without sending any messages; artifacts
 * already pushed to the sink are not reclaimed (content-addressed; the next claimer checking `has`
 * completes directly).
 *
 * Every wait on injected interfaces races against the abort signal (`untilAborted`): if the
 * executor or sink ignores abort and never returns, this run also settles upon abort (`settled()`
 * will not be blocked by a frozen executor), and anything it returns afterwards is discarded.
 *
 * # Diagnostics of phases and finalization events (`docs/archive/agent-reports/AGENT-stall-phases.md`)
 *
 * Each run records which phase it is currently in: `dedup` (`sink.has`), `manifest`
 * (`sink.resultFor`), `render` (`executor.render`), `push` (`sink.put`), `plan` (splitting). The
 * executor and sink can report a more granular position via extra callbacks (`phase(name, fields)`
 * in the executor's second parameter; `report({ stage, blocks, pushed, bytes })` in the sink
 * `put`'s second parameter), working normally even if omitted. The `lost`, `discarded`, `failed`,
 * `completed`, and `dedup` events include: phase `phase` and sub-division `detail`, frame count
 * `done`, time elapsed since last frame change `sinceDoneMs`, time elapsed since claim
 * `sinceClaimMs`, duration in this phase `phaseMs`; the push phase additionally includes
 * `push: { blocks, pushed, bytes, ms }`. Timestamps are obtained from injected `now` (defaulting to
 * `Date.now`), setting no timers.
 *
 * # Work count (contract A.12 [ruling])
 *
 * When changing phases, when the executor reports a step (outputting a batch of frames, changing to
 * a new sub-division), or each time the sink finishes pushing a chunk, invoke `advance(id)` on the
 * session once (omitted if session lacks this method): the queue uses it to determine "still
 * reporting progress", so phases where frame count remains unchanged (such as pushing artifacts or
 * post-render finalization) are no longer treated as frozen. If the executor or sink truly freezes,
 * none of these callbacks arrive, the count does not advance, and the task is reclaimed as stalled
 * after STALL_MS as before (I8).
 * `occupying()` lists runs that have not yet reached push (`{ id, kind, phase }`): standalone
 * render hosts use this to claim only when the prerender room is free (`host.mjs`).
 *
 * @typedef {object} TaskRunner
 * @property {(task: object, ctx: { token: number, browserFingerprints?: string[], browserCardEnvFingerprints?: string[] }) => void} onTask  session onTask
 * @property {(id: string, reason: string) => void} onLost   session onLost
 * @property {(run: object) => boolean} holding
 * @property {(reason: string) => void} abortAll
 * @property {(reason?: string) => void} stop       stop: send no further messages to the queue hereafter
 * @property {() => void} resume                    restart after `stop` (start in local-node)
 * @property {() => boolean} stopped
 * @property {(id: string) => number | null} tokenOf   token for this id in running table (for resume evaluation)
 * @property {() => string[]} running
 * @property {() => { id: string, kind: string, phase: string }[]} occupying   runs that have not yet reached push
 * @property {() => Promise<void>} settled
 */

/** Flag thrown on abort: lost race to abort signal, not the executor's own error. */
export const ABORTED = Symbol('aborted');

/**
 * Wait for promise to settle or wait for abort signal, whichever comes first. Reject immediately
 * if signal is already aborted.
 */
export function untilAborted(work, signal) {
  if (signal.aborted) return Promise.reject(ABORTED);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // The executor may throw synchronously or return a non-Promise value: wrap uniformly into a Promise
  const settled = new Promise(resolve => resolve(work()));
  return Promise.race([settled, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** Manifest returned by sink → object spreadable into `complete` result; add nothing if not a plain object (null, omitted, array). */
export function resultFields(result) {
  return result != null && typeof result === 'object' && !Array.isArray(result) ? result : {};
}

/**
 * @param {object} options
 * @param {string} options.nodeId
 * @param {() => { held(): { id: string, token: number }[], progress(id: string, done: number): boolean,
 *   complete(id: string, result?: object): boolean, fail(id: string, error?: string, retryable?: boolean): boolean }} options.session
 *   Getter function for session (session needs onTask / onLost, so runner is created first, session second)
 * @param {{ render: (task: object, opts: { signal: AbortSignal, progress: (done: number) => void }) => Promise<unknown> }} options.executor
 * @param {{ has: Function, put: Function, resultFor?: Function }} options.sink
 * @param {(event: object) => void} [options.emit]   Diagnostic events (caller is responsible for swallowing its own exceptions)
 * @param {() => number} [options.now]   Diagnostic clock (defaults to `Date.now`)
 * @param {(run: object, task: object, ctx: object) => Promise<void>} [options.executePlan]
 *   How to execute plan tasks (provided by desktop); errors it throws fail according to
 *   fine-grained task rules. When omitted, plan is treated as a non-retryable failure
 * @returns {TaskRunner}
 */
export function createTaskRunner({ nodeId, session, executor, sink, emit = () => {}, executePlan = null, now = Date.now }) {
  /** Running table: id → current execution { id, token, kind, controller }. Removed on abort */
  const active = new Map();
  /** Executions not yet settled (including aborted, still finalizing), for `settled()` to wait on */
  const pending = new Set();
  let stopped = false;

  function abortRun(run, reason) {
    if (active.get(run.id) === run) active.delete(run.id);
    run.controller.abort(reason);
  }

  function abortAll(reason) {
    for (const run of [...active.values()]) abortRun(run, reason);
  }

  const clock = () => {
    try { const t = now(); return Number.isFinite(t) ? t : Date.now(); } catch { return Date.now(); }
  };

  /** Work progressed by one step (see "Work count" in file header): recorded only if still held */
  function touch(run) {
    if (!holding(run)) return;
    try { session().advance?.(run.id); } catch { /* Session broken: renewal will also fail; reclaimed by queue according to lease */ }
  }

  /**
   * Enter a stage (diagnostic); clear fine-grained location. Changing stages also counts as one
   * step of work progress, and immediately reports progress on the spot (with the new count):
   * if the next step hangs, stagnation timing starts from this moment without waiting for the next
   * renewal (I8 reclaim time is not postponed by the count).
   */
  function enter(run, phase) {
    run.phase = phase;
    run.phaseAt = clock();
    run.detail = null;
    touch(run);
    if (!holding(run)) return;
    try { session().progress(run.id, run.done); } catch { /* Connection broken: finalized by error handling in execution or by queue lease */ }
  }

  /** Fine-grained location reported by executor/sink (diagnostic): keep only name and numeric fields */
  function note(run, name, fields) {
    if (typeof name !== 'string' || !name) return;
    const detail = { name: name.slice(0, 40) };
    if (fields && typeof fields === 'object') {
      for (const [k, v] of Object.entries(fields)) if (typeof v === 'number' && Number.isFinite(v)) detail[k.slice(0, 24)] = v;
    }
    run.detail = detail;
    touch(run);
  }

  /** Execution diagnostics included in events (see file header) */
  function info(run) {
    const t = clock();
    const out = {
      phase: run.phase, done: run.done,
      sinceDoneMs: Math.max(0, t - run.doneAt), sinceClaimMs: Math.max(0, t - run.claimedAt), phaseMs: Math.max(0, t - run.phaseAt),
    };
    if (run.detail) out.detail = { ...run.detail };
    if (run.push) {
      const { blocks, pushed, bytes, startedAt, endedAt } = run.push;
      out.push = { blocks, pushed, bytes, ms: Math.max(0, (endedAt ?? t) - startedAt) };
    }
    return out;
  }

  /** Progress callback for sink `put`: gives total chunks when push starts, completed chunks after each */
  function pushReport(run) {
    return (update) => {
      if (!update || typeof update !== 'object' || !run.push || run.controller.signal.aborted) return;
      const before = run.push.pushed;
      for (const k of ['blocks', 'pushed', 'bytes']) if (Number.isFinite(update[k])) run.push[k] = update[k];
      if (typeof update.stage === 'string') note(run, update.stage);
      else if (run.push.pushed !== before) touch(run);
    };
  }

  /** Still held: see file header. Evaluated synchronously; cannot await between check and message send. */
  function holding(run) {
    if (stopped || run.controller.signal.aborted || active.get(run.id) !== run) return false;
    return session().held().some(hold => hold.id === run.id && hold.token === run.token);
  }

  function onTask(task, ctx = {}) {
    const id = task?.id;
    if (id == null) return;
    // Same id still has an old execution attached: its hold is already gone (otherwise session
    // would not call onTask again), abort first
    const previous = active.get(id);
    if (previous) abortRun(previous, 'reclaimed');
    const at = clock();
    const run = {
      id, token: ctx.token, kind: task.kind, controller: new AbortController(),
      // Diagnostics (see "Diagnostics for stage and finalization events" in file header)
      claimedAt: at, phase: 'start', phaseAt: at, detail: null, done: 0, doneAt: at, push: null,
    };
    active.set(id, run);
    // Report progress 0 first upon starting work (contract D.2 [ruling])
    try {
      session().progress(id, 0);
    } catch {
      // Connection broken: subsequent sends will also fail; finalized by error handling in execution
    }
    const done = execute(run, task, ctx).then(() => {
      if (active.get(id) === run) active.delete(id);
      pending.delete(done);
    });
    pending.add(done);
  }

  function onLost(id, reason) {
    const run = active.get(id);
    const diag = run ? info(run) : {};
    if (run) abortRun(run, reason);
    emit({ type: 'lost', id, reason, ...diag });
  }

  /** A single execution. Never rejects: all exceptions are caught here. */
  async function execute(run, task, ctx) {
    const { id } = run;
    const { signal } = run.controller;
    const discard = () => {
      const why = signal.reason;
      emit({ type: 'discarded', id, ...(typeof why === 'string' && why ? { reason: why } : {}), ...info(run) });
    };
    try {
      if (task.kind === 'plan') {
        enter(run, 'plan');
        if (typeof executePlan !== 'function') {
          throw Object.assign(new Error('This node does not split plan tasks'), { retryable: false });
        }
        await executePlan(run, task, ctx);
        return;
      }

      const { resultKey, kind, range } = task;
      // Pass input / requires as is: local tier disk-commit keys require input.entryKey, input.contentKey,
      // requires.envFingerprint, and canvasHeavy uses input.canvasHeavy (C6.2 section 11 items 2 and 3, J.3)
      const ref = { resultKey, kind, tier: task.tier ?? null, range, input: task.input, requires: task.requires };
      const ranges = [[range?.from, range?.to]];

      enter(run, 'dedup');
      // When checking, sink may opportunistically push chunks present locally but missing on asset service
      // (AGENT-sink-has): each chunk processed also counts as one step of work progress
      const dedupReport = (update) => {
        if (signal.aborted || !update || typeof update !== 'object') return;
        if (typeof update.stage === 'string') note(run, update.stage);
        else if (Number.isFinite(update.pushed)) note(run, run.detail?.name ?? 'dedup', { blocks: update.blocks, pushed: update.pushed });
      };
      const have = await untilAborted(() => sink.has({ ...ref }, { signal, report: dedupReport }), signal);
      if (!holding(run)) return discard();
      if (have === true) {
        // Deduplicated completion also includes manifest so subscribers can fetch it (C6.4 section 3);
        // when sink has no resultFor, proceed as before (D.2). resultFor throwing counts as "no manifest":
        // complete via deduplication as before without failing the task (contract J.10)
        let manifest = null;
        if (typeof sink.resultFor === 'function') {
          enter(run, 'manifest');
          try {
            manifest = await untilAborted(() => sink.resultFor({ ...ref }), signal);
          } catch (error) {
            if (error === ABORTED) throw error;
            manifest = null;
          }
          if (!holding(run)) return discard();
        }
        session().complete(id, { ranges, dedup: true, ...resultFields(manifest) });
        emit({ type: 'dedup', id, ...info(run) });
        return;
      }

      const progress = done => {
        if (signal.aborted) return;
        if (done !== run.done) { run.done = done; run.doneAt = clock(); }
        touch(run);
        if (holding(run)) session().progress(id, done);
      };
      // Executor reports fine-grained location (diagnostic, can be omitted)
      const phase = (name, fields) => { if (!signal.aborted) note(run, name, fields); };
      enter(run, 'render');
      const artifacts = await untilAborted(() => executor.render(task, { signal, progress, phase }), signal);
      if (!holding(run)) return discard();

      enter(run, 'push');
      run.push = { blocks: null, pushed: 0, bytes: null, startedAt: clock(), endedAt: null };
      const report = pushReport(run);
      const r = await untilAborted(
        () => sink.put({ ...ref, artifacts, meta: { taskId: id, nodeId, token: run.token } }, { signal, report }),
        signal,
      );
      run.push.endedAt = clock();
      if (!holding(run)) return discard();
      if (r?.complete !== true) {
        session().fail(id, 'sink-incomplete', true);
        // If sink specified why it was incomplete (missing frames, missing small size, push error),
        // record together; error reported to queue remains sink-incomplete
        const why = typeof r?.reason === 'string' && r.reason ? { why: r.reason.slice(0, 300) } : {};
        emit({ type: 'failed', id, error: 'sink-incomplete', retryable: true, ...why, ...info(run) });
        return;
      }
      // Manifest returned by put (C6.2 section 3) is spread into result of task.done (J.3)
      session().complete(id, { ranges, ...resultFields(r.result) });
      emit({ type: 'completed', id, ...info(run) });
    } catch (error) {
      if (error === ABORTED || !holding(run)) return discard();
      // This content has been superseded by a newer version (determined by executor, contract J.15):
      // report to queue as invalidated (error fixed to 'superseded', non-retryable), not counted as failure
      if (error?.superseded === true) {
        try {
          session().fail(id, 'superseded', false);
        } catch {
          // Connection broken: same as below, queue will reclaim by lease or disconnection
        }
        emit({ type: 'superseded', id, ...(typeof error.detail === 'string' && error.detail ? { why: error.detail.slice(0, 300) } : {}), ...info(run) });
        return;
      }
      const message = String(error?.message ?? error);
      const retryable = error?.retryable !== false;
      try {
        session().fail(id, message, retryable);
      } catch {
        // Cannot even send failure (connection broken): hold already removed from session,
        // queue will reclaim by lease or disconnection
      }
      emit({ type: 'failed', id, error: message, retryable, ...info(run) });
    }
  }

  return {
    onTask,
    onLost,
    holding,
    abortAll,
    stop(reason = 'stopped') {
      stopped = true;
      abortAll(reason);
    },
    resume() { stopped = false; },
    stopped: () => stopped,
    tokenOf: id => active.get(id)?.token ?? null,
    running: () => [...active.keys()].sort(),
    /** Executions that have not yet reached push (see "Work count" in file header) */
    occupying: () => [...active.values()].filter(run => run.phase !== 'push').map(({ id, kind, phase }) => ({ id, kind, phase })),
    settled: async () => { await Promise.all([...pending]); },
  };
}
