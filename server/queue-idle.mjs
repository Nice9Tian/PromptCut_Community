/**
 * Idle gate for local queue nodes (M6c X5, `docs/plan/m6c-contract.md`; semantics in
 * `product/platforms.md` "Nodes only claim when idle").
 *
 * The M5b gate was the executor's `isIdle()`: had to wait for preload to reach `ready` (and stream
 * not busy), so the local node started up rather late. Now changed to: if the executor has
 * available slots (held + in-flight < maxConcurrent, guarded by the node session itself) and **no
 * interactive frame requests in the last 500 ms**, fine-grained tasks can be claimed. Does not
 * block while preload is still running or streams are still producing.
 *
 * Interactive frame requests (scrub, playback) come from these sources:
 *   - Recorded by routes: `/api/frames/see` (`user` lane, legacy preview frame fetching during
 *     scrub), `/api/frames/playback` (legacy preview playback clock): callers notify the gate via
 *     `note()` or `lastInteractionAt()`;
 *   - From the pipeline: legacy preview warm pool is playing (`playback.playing`), background yield
 *     lease is active or currently yielding (the editor process borrows the prerender room during
 *     playback);
 *   - Playhead reported by mirror plugin (`pipeline.playhead()`, reported during page scrubbing and
 *     playback): playing and had audio within 5 seconds, or moved within 500 ms.
 *
 * Yields according to semantics when the user plays or scrubs: **do not claim new ones, finish what
 * is currently in hand** (callers no longer `yieldAll` because of being busy).
 *
 * Pure logic, starts no timers; clock is injectable.
 */

/** Do not claim new tasks if an interactive frame request occurred within this recent duration */
export const INTERACTION_QUIET_MS = 500;
/** How long after the playhead reports "playing" without further reports before it is no longer considered playing (same as `FramePipeline.streamBusy`: the playing page sends a keepalive every 2 seconds, and throttles reports at 100 ms when there is a gap) */
export const PLAYING_STALE_MS = 5_000;

/**
 * Whether the pipeline currently has interaction: returns reason string, or null if none.
 * @param {any} pipeline  `FramePipeline` (only reads closed, playback, backgroundYielding, backgroundLeaseUntil, playhead())
 */
export function interactionReason(pipeline, at, { quietMs = INTERACTION_QUIET_MS } = {}) {
  if (!pipeline) return null;
  if (pipeline.closed) return 'closed';
  if (pipeline.playback?.playing) return 'playback';
  if (pipeline.backgroundYielding || Number(pipeline.backgroundLeaseUntil) > at) return 'yield';
  let head = null;
  try { head = typeof pipeline.playhead === 'function' ? pipeline.playhead() : null; } catch { head = null; }
  const headAt = Number(head?.at);
  if (Number.isFinite(headAt)) {
    if (head.playing && at - headAt < PLAYING_STALE_MS) return 'playing';
    if (at - headAt < quietMs) return 'scrub';
  }
  return null;
}

/**
 * @param {object} [options]
 * @param {any} [options.pipeline]                     Pipeline (optional: only inspects note / lastInteractionAt)
 * @param {() => number} [options.now]
 * @param {number} [options.quietMs]
 * @param {() => number} [options.lastInteractionAt]  Timestamp of the most recent interactive frame request recorded externally (recorded in routes)
 */
export function createQueueIdleGate({ pipeline = null, now = Date.now, quietMs = INTERACTION_QUIET_MS, lastInteractionAt = () => -Infinity } = {}) {
  let noted = -Infinity;
  const latest = () => {
    const outside = Number(lastInteractionAt());
    return Math.max(noted, Number.isFinite(outside) ? outside : -Infinity);
  };
  /** Reason why claims are not allowed right now; returns null if claimable */
  const reason = (at = now()) => {
    if (at - latest() < quietMs) return 'interaction';
    return interactionReason(pipeline, at, { quietMs });
  };
  return {
    /** Record an interactive frame request (frame fetching during scrub, playback clock) */
    note(at = now()) { if (at > noted) noted = at; },
    /** Whether new tasks can be claimed */
    idle: (at = now()) => reason(at) === null,
    reason,
    get lastInteractionAt() { return latest(); },
  };
}
