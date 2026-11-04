/**
 * K4 tick loop and the pure-computation half of the K6 one-second window. The loop itself
 * (waiting for real frames, advancing the clock, posting events) remains in the closure of
 * `StageView.tsx`; split here to allow `node --test`: `StageView.tsx` includes JSX and the card
 * registry, so it cannot enter node.
 */
import { pipelineAt } from './pipelinePlan.mjs';

/** K6 window length (ms) */
export const K6_WINDOW_MS = 1000;

/**
 * Which second tick `n` (1-indexed) lands on. Tick sequence numbers are calculated by frame grid;
 * `sec` is always `frame / fps`: continuous floating-point accumulation drifts. Reaching or
 * passing the end of the video marks the final tick, with `sec` clamped to `duration`.
 *
 * @param {number} fromFrame Frame where playback starts (`Math.round(fromSec × fps)`)
 * @param {number} n Tick sequence number, 1-indexed
 * @param {number} fps
 * @param {number} duration Total project duration (seconds)
 * @returns {{ sec: number, frame: number, ended: boolean }}
 */
export function beatAt(fromFrame, n, fps, duration) {
  const frame = fromFrame + n;
  const rawSec = frame / fps;
  const ended = rawSec >= duration - 1e-9;
  return { sec: ended ? duration : rawSec, frame, ended };
}

/**
 * The absolute timestamp of the next tick after finishing the work of one tick. **Wait for slow
 * frames**: the timeline is shifted backward overall (`playStart += excess`) only if the work of
 * this tick itself exceeds `nextDue`; no catch-up, no frame skipping, and no rushing ahead;
 * if not exceeded, returns as is, and the caller waits until `nextDue`.
 *
 * @param {number} playStart Actual wall-clock time when playback started (may have been shifted
 *   backward by earlier slow ticks)
 * @param {number} n Sequence number of the tick just completed
 * @param {number} period Duration of one tick in milliseconds (`1000 / fps`)
 * @param {number} workEnd Actual wall-clock time when this tick's work finished
 * @returns {{ playStart: number, nextDue: number, late: boolean }}
 */
export function scheduleNextBeat(playStart, n, period, workEnd) {
  const nextDue = playStart + n * period;
  if (workEnd > nextDue) return { playStart: playStart + (workEnd - nextDue), nextDue, late: true };
  return { playStart, nextDue, late: false };
}

/**
 * @typedef {{ at: number, over: number, byClip: Map<string, number> }} K6Beat
 * @typedef {{ beats: K6Beat[], pending: ReadonlySet<string> }} K6State
 */

/** @returns {K6State} */
export function createK6State() {
  return { beats: [], pending: new Set() };
}

/**
 * Account for one tick (K6) and determine whether to downgrade at this moment. **Downgrade only,
 * never upgrade**.
 *
 * - **Overtime** only counts the portion of each tick's duration that exceeds 1/fps; the window
 *   keeps only the most recent `K6_WINDOW_MS` milliseconds.
 * - **The duration of `pending` cards (downgraded, dead asset not yet ready) in this tick is not
 *   counted toward overtime**, nor considered as candidates: it live renders as usual and slows
 *   down this tick as usual; if counted in, the window would blow up every second, downgrading
 *   another card every second until the light pipeline is empty.
 * - If there are at least two ticks in the window and accumulated overtime > 1/fps, downgrade the
 *   **light card** with the largest **measured** cumulative duration in this window (heavy cards
 *   are already pasting dead assets, downgrading them is meaningless); ties are ordered by clipId.
 * - Clear the window after downgrading one: the next one must accumulate enough overtime again
 *   before downgrading, otherwise multiple cards would be downgraded within a single second.
 *
 * Mutates `state` directly. Returns the clipId of the card to downgrade, or `null` if none.
 *
 * @param {K6State} state
 * @param {{ at: number, beatCost: number, byClip: Map<string, number>, fps: number, sec: number, plan: any }} beat
 * @returns {string | null}
 */
export function noteK6Beat(state, { at, beatCost, byClip, fps, sec, plan }) {
  let excused = 0;
  for (const id of state.pending) excused += byClip.get(id) ?? 0;
  const over = Math.max(0, beatCost - excused - 1000 / fps);
  const beats = state.beats;
  beats.push({ at, over, byClip: new Map(byClip) });
  while (beats.length && at - beats[0].at > K6_WINDOW_MS) beats.shift();

  if (beats.length < 2) return null;
  let totalOver = 0;
  for (const b of beats) totalOver += b.over;
  if (totalOver <= 1000 / fps) return null;
  const total = new Map();
  for (const b of beats) {
    for (const [id, ms] of b.byClip) {
      if (state.pending.has(id)) continue;
      if (pipelineAt(plan, id, sec) !== 'light') continue;
      total.set(id, (total.get(id) ?? 0) + ms);
    }
  }
  let worst = null;
  let worstMs = 0;
  for (const id of [...total.keys()].sort()) {
    const ms = total.get(id);
    if (ms > worstMs) { worst = id; worstMs = ms; }
  }
  if (!worst) return null;
  state.pending = new Set([...state.pending, worst]);
  state.beats = [];
  return worst;
}
