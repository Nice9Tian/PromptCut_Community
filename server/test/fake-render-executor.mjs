/**
 * For testing and in-process integration only; production code must not import this.
 *
 * Scriptable fake executor supporting arrangement (contract `docs/plan/render-queue-contract.md`
 * D.1 `executor`, D.3), plus the fake clock it uses.
 *
 *   executor.plan(planTask, { signal })               → Promise<PlanContext> (test-provided)
 *   executor.render(task, { signal, progress })       → Promise<artifacts>
 *
 * All waits advance according to the injected fake clock, without using real timers:
 * `createTimerClock`'s `sleep(ms, signal)` resolves when the test calls `advance` / `set` to advance
 * the clock past expiration time; rejected immediately with `AbortError` when `signal` aborts.
 *
 * An executor is shared by multiple nodes: `forNode(nodeId)` provides the D.1 interface bound
 * to node identity; call records include `nodeId`, and arrangement rules can also be
 * distinguished by node. Arrangement (`on(match, behavior)`, picks the first matching rule in
 * addition order that still has remaining runs):
 *
 *   match     task id (string) | RegExp (on id) | (task, { nodeId, call }) => boolean (call is the
 *             1-based render count for this id)
 *   behavior  {
 *     durationMs,          duration (defaults to constructor argument, 1000)
 *     progressEveryMs,     progress step: reports progress at this interval (defaults to 250),
 *                          reporting completed frame count
 *     fail: { retryable = true, message = 'render-failed', afterMs },   throws when due; when
 *                          retryable === false, error carries retryable: false
 *     hang: true | { afterProgress: n },   hang: first reports progress n times (defaults to 0),
 *                          then never returns and stops reporting progress, while ignoring
 *                          aborts: until test calls release(), at which point artifacts are
 *                          returned as usual ("late result")
 *     times,               how many times this rule applies (defaults to unlimited)
 *   }
 *
 * When no rule matches, completes normally with default duration and default step.
 */

/** Starting time for tests (same as T0 in fake-render-queue-env.mjs, does not start from 0). */
export const T0 = 1_000_000;

function abortError(signal) {
  const reason = signal?.reason;
  const error = new Error(`aborted${reason instanceof Error ? `: ${reason.message}` : ''}`);
  error.name = 'AbortError';
  return error;
}

/**
 * Fake clock with timer: `now()`, `advance(ms)`, `set(t)`, `sleep(ms, signal)`.
 * Advancing the clock resolves expired `sleep` calls in expiration order (resolved continuations
 * run in microtasks; tests need to yield the event loop once to observe them).
 */
export function createTimerClock(start = T0) {
  let t = start;
  let seq = 0;
  let timers = [];

  function fireDue() {
    timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    while (timers.length > 0 && timers[0].at <= t) {
      const timer = timers.shift();
      timer.cleanup();
      timer.resolve();
    }
  }

  return {
    now: () => t,
    advance(ms) { t += ms; fireDue(); return t; },
    set(v) { t = v; fireDue(); return t; },
    sleep(ms, signal) {
      if (signal?.aborted) return Promise.reject(abortError(signal));
      if (!(ms > 0)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = { at: t + ms, seq: seq++, resolve, cleanup: () => {} };
        if (signal) {
          const onAbort = () => {
            timers = timers.filter(x => x !== timer);
            reject(abortError(signal));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          timer.cleanup = () => signal.removeEventListener('abort', onAbort);
        }
        timers.push(timer);
      });
    },
    /** Count of unexpired sleep calls */
    pendingTimers: () => timers.length,
  };
}

/** Task frame count: snapshots use local frame count; track stream is 15 frames per segment (design Section 2). */
function framesOf(task) {
  const r = task?.range;
  if (!r) return 1;
  const n = r.to - r.from + 1;
  return task.kind === 'stream' ? n * 15 : n;
}

function matches(match, task, info) {
  if (typeof match === 'string') return task?.id === match;
  if (match instanceof RegExp) return match.test(task?.id ?? '');
  if (typeof match === 'function') return !!match(task, info);
  return false;
}

export function createFakeExecutor({
  clock,
  planContext,
  planMs = 200,
  durationMs = 1_000,
  progressEveryMs = 250,
} = {}) {
  if (!clock || typeof clock.sleep !== 'function') throw new TypeError('createFakeExecutor: clock must be an instance of createTimerClock()');
  const rules = [];
  const calls = [];
  const hung = [];
  const errors = [];
  let seq = 0;

  function behaviorFor(task, info) {
    for (const rule of rules) {
      if (rule.remaining <= 0 || !matches(rule.match, task, info)) continue;
      rule.remaining -= 1;
      rule.hits += 1;
      return rule.behavior;
    }
    return {};
  }

  function track(call, signal) {
    if (!signal) return;
    if (signal.aborted) call.abortSeen = true;
    else signal.addEventListener('abort', () => { call.abortSeen = true; }, { once: true });
  }

  function bind(nodeId) {
    async function plan(planTask, { signal } = {}) {
      const call = { seq: seq++, kind: 'plan', nodeId, id: planTask?.id, startedAt: clock.now(), endedAt: null, state: 'running', abortSeen: false, progress: [] };
      calls.push(call);
      track(call, signal);
      try {
        await clock.sleep(planMs, signal);
        const ctx = typeof planContext === 'function' ? planContext(planTask, { nodeId }) : planContext;
        call.state = 'ok';
        return ctx;
      } catch (error) {
        call.state = signal?.aborted ? 'aborted' : 'failed';
        throw error;
      } finally {
        call.endedAt = clock.now();
      }
    }

    async function render(task, { signal, progress } = {}) {
      const nth = calls.filter(c => c.kind === 'render' && c.id === task?.id).length + 1;
      const call = { seq: seq++, kind: 'render', nodeId, id: task?.id, startedAt: clock.now(), endedAt: null, state: 'running', abortSeen: false, late: false, progress: [] };
      calls.push(call);
      track(call, signal);
      const b = behaviorFor(task, { nodeId, call: nth });
      const total = framesOf(task);
      const duration = b.durationMs ?? durationMs;
      const every = Math.max(1, b.progressEveryMs ?? progressEveryMs);
      const report = done => {
        call.progress.push(done);
        try {
          progress?.(done);
        } catch (error) {
          errors.push(error);
          throw error;
        }
      };
      const artifacts = () => ({
        taskId: task.id, nodeId, kind: task.kind,
        from: task.range?.from ?? null, to: task.range?.to ?? null, frames: total,
      });
      try {
        if (b.hang) {
          const k = b.hang === true ? 0 : (b.hang.afterProgress ?? 0);
          for (let i = 1; i <= k; i++) {
            await clock.sleep(every, signal);
            report(Math.min(total, i));
          }
          // Hang: does not report progress and ignores abort, until test calls release()
          call.state = 'hung';
          await new Promise(resolve => hung.push({ call, resolve }));
          call.late = true;
          call.state = 'ok';
          return artifacts();
        }
        const end = b.fail ? (b.fail.afterMs ?? duration) : duration;
        let elapsed = 0;
        while (elapsed < end) {
          const step = Math.min(every, end - elapsed);
          await clock.sleep(step, signal);
          elapsed += step;
          if (!b.fail || elapsed < end) report(Math.min(total, Math.floor((total * elapsed) / duration)));
        }
        if (b.fail) {
          const error = new Error(b.fail.message ?? 'render-failed');
          if (b.fail.retryable === false) error.retryable = false;
          throw error;
        }
        call.state = 'ok';
        return artifacts();
      } catch (error) {
        call.state = signal?.aborted ? 'aborted' : 'failed';
        throw error;
      } finally {
        call.endedAt = clock.now();
      }
    }

    return { plan, render };
  }

  return {
    /** D.1 executor interface bound to node identity */
    forNode: bind,
    /** Adds an arrangement rule and returns the rule itself (`hits` records hit count) */
    on(match, behavior = {}) {
      const rule = { match, behavior, remaining: behavior.times ?? Infinity, hits: 0 };
      rules.push(rule);
      return rule;
    },
    /** Releases hung calls (filterable by `id` / `nodeId`), which then return artifacts as usual. Returns released count. */
    release({ id, nodeId } = {}) {
      let n = 0;
      for (let i = hung.length - 1; i >= 0; i--) {
        const { call, resolve } = hung[i];
        if ((id !== undefined && call.id !== id) || (nodeId !== undefined && call.nodeId !== nodeId)) continue;
        hung.splice(i, 1);
        resolve();
        n += 1;
      }
      return n;
    },
    /** Call records (filterable by kind / id / nodeId), in start order */
    calls({ kind, id, nodeId } = {}) {
      return calls.filter(c => (kind === undefined || c.kind === kind) && (id === undefined || c.id === id)
        && (nodeId === undefined || c.nodeId === nodeId)).map(c => ({ ...c, progress: [...c.progress] }));
    },
    renderCount: id => calls.filter(c => c.kind === 'render' && c.id === id).length,
    /** Currently hung calls */
    hung: () => hung.map(h => ({ ...h.call, progress: [...h.call.progress] })),
    /** Exceptions thrown by progress callbacks */
    errors: () => errors.slice(),
  };
}
