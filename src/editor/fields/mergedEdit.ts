/**
 * Small helper for "a run of consecutive changes counts as one step" in the editor panel (shared by `NumberField` /
 * `RangeField` / drag-to-tweak on parameter names).
 *
 * Undo stack merging relies on the store's existing mergeKey (`setProject` in `src/store/core.ts`, `commit` in `docsync.ts`):
 * consecutive changes with the same key inside the merge window fold into the same undo step. This module only handles
 *   - issuing a unique key for each drag (`newGestureKey`), with an infinite window (only the key counts, not time);
 *   - for stepping (arrow keys, up/down arrows), a wider rolling window (`STEP_BURST_MS`), so repeated presses merge into one step;
 *   - throttling commits during a drag (`createLatestThrottle`), so not every pointer move sends a commit to the document service.
 */
import { withMerge } from "../../store/project";

/** Within one drag, commit at most once per this interval (the last value is always committed on release) */
export const GESTURE_COMMIT_INTERVAL_MS = 50;
/** Continuous stepping: two steps no more than this far apart merge into one undo step (rolling forward from the latest one) */
export const STEP_BURST_MS = 1000;
/** One drag: only the key counts, not time */
export const GESTURE_WINDOW_MS = Infinity;

let seq = 0;
/** Each drag gets a unique key, so the next drag does not merge into the previous one */
export function newGestureKey(tag: string): string {
  return `${tag}#${++seq}`;
}

/** All project changes made inside `fn` merge into the same undo step */
export function commitMerged<T>(key: string, windowMs: number, fn: () => T): T {
  return withMerge({ key, windowMs }, fn);
}

export interface ThrottleEnv {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

const realEnv: ThrottleEnv = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * Latest-value-only throttle: the first value is committed immediately, later values at most once per `intervalMs`
 * (intermediate ones are replaced by newer ones); `flush()` commits the latest pending value right away (call on release),
 * `cancel()` drops anything uncommitted.
 */
export function createLatestThrottle<T>(apply: (v: T) => void, intervalMs: number, env: ThrottleEnv = realEnv) {
  let last = -Infinity;
  let pending: { v: T } | null = null;
  let timer: unknown = null;
  const run = () => {
    timer = null;
    if (!pending) return;
    const { v } = pending;
    pending = null;
    last = env.now();
    apply(v);
  };
  return {
    push(v: T) {
      pending = { v };
      if (timer !== null) return;
      const wait = last + intervalMs - env.now();
      if (wait <= 0) run();
      else timer = env.setTimeout(run, wait);
    },
    flush() {
      if (timer !== null) { env.clearTimeout(timer); timer = null; }
      run();
    },
    cancel() {
      if (timer !== null) { env.clearTimeout(timer); timer = null; }
      pending = null;
    },
  };
}
