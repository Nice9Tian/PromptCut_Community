/**
 * In this round of playback, whether the playhead passed a card's mount frame tick by tick
 * ("natural entrance"), or started playing from its middle.
 *
 * Why distinguish: play-state swap (K3(b), `runPlayingSwap` in `src/editor/stageSwap.ts`) is used
 * to catch up state for light cards (tier (b) with `vtOk = false`) that "cannot advance subtree
 * virtual time and only recognize the global clock". For such cards that enter naturally during
 * continuous playback, the visible stage advances tick by tick by global clock and mounts them at
 * their mount frame, so their state is inherently correct (advancing frame by frame just like
 * export); only when playback starts from their middle (seeking to the middle of the card and
 * playing, opening the page parked in the middle of the card and playing, or resuming playback in
 * the middle of the card after pause) does their state come from pause-state positioning, requiring
 * a whole-scene catch-up run followed by a swap (`AGENT-pause-precise.md` "What was left undone and
 * observations" item 1).
 *
 * # Rules (pure state machine, identical between browser and Node)
 *
 * - **Play start** (`notePlayStart`): this round of playback starts from the `fromSec` frame. The
 *   video frame at play start comes from pause state (`setTime` positioning, or pause-state second
 *   route swap); cards already mounted at that moment count as "started from the middle".
 * - **One tick** (`notePlayBeat`): each time visible stage reports a tick (`frame` event), tick
 *   index is calculated as `round(sec × fps)`.
 *   - Exactly 1 greater than previous tick: continuous.
 *   - Same as previous tick: repeated report (for example, the armed stop tick), not counted as a
 *     break.
 *   - Jumped (difference > 1) or backward: **break**, restart calculation from drop target, drop
 *     target becomes new start point.
 * - **Dropped frames do not count as a break**: when the main thread stalls, visible stage "waits
 *   on slow frames": this tick lengthens and the entire timeline shifts backward without skipping
 *   tick numbers (`runBeatLoop` in `StageView.tsx`, `scheduleNextBeat` in `beatLoop.mjs`); tick
 *   indices received by the parent page still increment one by one, only arriving late; card clocks
 *   are still pushed tick by tick. Thus continuity depends solely on tick indices, not wall-clock
 *   intervals. Only when tick indices genuinely jump (for example, seeking during playback, or
 *   switching stages without catching up) does it count as a break.
 * - **Seam** (`notePlaySeam`): the new visible stage swapped in by play-state swap is in an exact
 *   state computed by a whole-scene catch-up run at frame `T`; continuing to report ticks from `T`
 *   counts as continuous (start point unchanged).
 * - **Natural entrance** (`enteredNaturally`): cards mounted after start point (mount frame > start
 *   point). mount frame = start point does not count: it was already mounted at play start, its
 *   state comes from pause-state positioning (for example, seeking backward to mount frame where
 *   component instance is not replaced and retains pre-seek state), and is decided by estimated
 *   duration as before. If playback has not started yet (start point unknown), never count as
 *   natural entrance and take original path.
 */

/** @param {number} sec @param {number} fps */
function frameOf(sec, fps) {
  const rate = Math.max(1, Number(fps) || 30);
  return Math.round((Number(sec) || 0) * rate);
}

/** @returns {{ startFrame: number | null, lastFrame: number | null, breaks: number }} */
export function createPlayRun() {
  return { startFrame: null, lastFrame: null, breaks: 0 };
}

/**
 * This round of playback starts from `fromSec` (play pressed, or switched stage and restarted ticks).
 * Mutates `run` directly.
 * @param {{ startFrame: number | null, lastFrame: number | null, breaks: number }} run
 * @param {number} fromSec
 * @param {number} fps
 */
export function notePlayStart(run, fromSec, fps) {
  const f = frameOf(fromSec, fps);
  run.startFrame = f;
  run.lastFrame = f;
}

/**
 * Visible stage reports a tick. Mutates `run` directly, returning what this tick counts as.
 * @param {{ startFrame: number | null, lastFrame: number | null, breaks: number }} run
 * @param {number} sec
 * @param {number} fps
 * @returns {'continuous' | 'repeat' | 'break'}
 */
export function notePlayBeat(run, sec, fps) {
  const f = frameOf(sec, fps);
  if (run.lastFrame !== null && f === run.lastFrame + 1) {
    run.lastFrame = f;
    return 'continuous';
  }
  if (run.lastFrame !== null && f === run.lastFrame) return 'repeat';
  // Playback has not started (start point unknown), skipped ticks or stepped back: restart
  // calculation from drop target
  run.startFrame = f;
  run.lastFrame = f;
  run.breaks++;
  return 'break';
}

/**
 * Visible stage state at frame `sec` is whole-scene exact (new stage swapped in by play-state
 * swap), thereafter continuing to report ticks from this frame. Start point unchanged; if playback
 * has not started yet, use this frame as start point.
 * @param {{ startFrame: number | null, lastFrame: number | null, breaks: number }} run
 * @param {number} sec
 * @param {number} fps
 */
export function notePlaySeam(run, sec, fps) {
  const f = frameOf(sec, fps);
  if (run.startFrame === null || f < run.startFrame) run.startFrame = f;
  run.lastFrame = f;
}

/**
 * Whether the card with mount frame `mountFrame` entered naturally in this round of playback
 * (stepped tick by tick after start point to reach its mount frame).
 * @param {{ startFrame: number | null, lastFrame: number | null }} run
 * @param {number} mountFrame
 */
export function enteredNaturally(run, mountFrame) {
  if (run.startFrame === null || run.lastFrame === null) return false;
  if (!Number.isFinite(mountFrame)) return false;
  return mountFrame > run.startFrame && mountFrame <= run.lastFrame;
}
