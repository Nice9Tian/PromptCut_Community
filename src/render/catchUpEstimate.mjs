/**
 * Estimation of K3(b) "actual catch-up amount" (pinned render 4). Pure function, kept in a separate
 * file for unit testing: `stageSwap.ts` requires the card registry and store, which cannot be
 * brought into `node --test`.
 *
 * # Formula
 *
 *   `t_c = (t − t_start) × FPS × t_oc`
 *
 * Long motion runs on **virtual time**: whichever frame the playhead currently lands on within it,
 * only that many frames need to be caught up. `t_oc` is the worst-case single-frame time: the K1
 * probe measures precisely "the slowest frame during frame pushing" (`stepMaxMs`); if this number
 * is missing, it falls back to p90 `stepMs`.
 *
 * # Why not directly use full-clip `catchUpMs`
 *
 * Full-clip `catchUpMs` is the total cost of "rushing from frame 0 to the **last frame**"
 * (pinned render 3 last sentence; K2 uses it to classify as light or heavy). Estimating by it when
 * the playhead has just entered a 60-second clip would push the target tick `T` of K5's second
 * path out by several seconds: the visible stage waits in vain, that card remains transparent
 * inside `suppressed` for much longer, while the background actually finishes catch-up in tens of ms.
 *
 * # Cap
 *
 * Position estimate **cannot exceed the full-clip cost**: `t_oc` is single-frame worst case, and
 * multiplying it across the entire clip is even more pessimistic than the measured full-clip cost.
 * If position cannot be calculated (no `t_oc`, or frame count is 0), fall back to full-clip cost.
 *
 * **Only affects the actual value of "how much to catch up"**: K2 light/heavy dispatch still
 * evaluates by full-clip worst case (`clipWeight` is unaffected).
 */

/**
 * Estimated catch-up run cost (milliseconds) for a card at playback position
 * `frames` (= `(t − t_start) × fps`, number of frames advanced).
 *
 * @param {{ catchUpMs?: number, stepMaxMs?: number, stepMs?: number } | null | undefined} record K1 cost record
 * @param {number} frames Number of frames from the in point to the current moment
 * @returns {number} Milliseconds; returns 0 if no usable value is available (caller handles fallback)
 */
export function catchUpEstimateMs(record, frames) {
  const whole = Number(record?.catchUpMs) || 0;
  const perFrame = Number(record?.stepMaxMs) || Number(record?.stepMs) || 0;
  const n = Number(frames);
  const steps = Number.isFinite(n) && n > 0 ? n : 0;
  const byPosition = perFrame > 0 && steps > 0 ? steps * perFrame : 0;
  if (byPosition <= 0) return whole;
  return whole > 0 ? Math.min(byPosition, whole) : byPosition;
}

/**
 * Cost of a **whole scene** catch-up run (time estimate for K3(b) playback swap).
 *
 * Background stage catch-up run is `render(T, { jump: true })`: all cards active at this moment
 * are remounted, and the clock pushes the **entire show** frame-by-frame to `T` from the earliest
 * in point among them. The background stage has no dispatch table, and cards classified as heavy
 * are also live rendered there: so the wall-clock time spent is not just that light card's own
 * frame catch-up cost, but the **sum** of the individual frame-push costs of every card on stage
 * during this period (C10-A4 benchmark: a 90 ms light card with nine 40 ms/frame heavy cards took
 * 11 s to catch up to 1.03 s).
 *
 * @param {{ start: number, end: number, record?: object | null }[]} entries
 *   Card clips on stage (both light and heavy)
 * @param {number} t Playhead at the current moment (seconds)
 * @param {number} fps
 * @param {(entry: { start: number, end: number }, t: number) => boolean} [activeAt]
 *   Whether mounted at this moment (defaults to checking in and out points)
 * @returns {{ backlogMs: number, ratePerSec: number }}
 *   - `backlogMs`: Wall-clock time to push from the push start point (earliest in point among
 *     currently active cards) to `t`. Each card is pushed from max(in point, push start point)
 *     to min(out point, t), estimated via `catchUpEstimateMs` (same formula as a single card,
 *     likewise capped at the whole-clip cost);
 *   - `ratePerSec`: Additional wall-clock time (ms) needed for each additional 1 s of timeline
 *     pushed after `t` = Σ(single-frame cost of currently active cards) × fps.
 *     The **exact same number** (`stepMaxMs`, falling back to `stepMs` only if absent) is used
 *     for both single frame and backlog, so backlog and rate use the same scale.
 *     Measured (c10-browser-probe, PC): backlog estimated by `stepMaxMs` of 10982 ms matched the
 *     measured 11 s catch-up run; rate calculated by p90 `stepMs` was only about one-ninth of the
 *     measured frame-push speed.
 */
export function sceneCatchUpCost(entries, t, fps, activeAt = (e, sec) => sec >= e.start && sec < e.end) {
  const f = Math.max(1, Number(fps) || 30);
  const list = Array.isArray(entries) ? entries : [];
  const active = list.filter((e) => activeAt(e, t));
  if (!active.length) return { backlogMs: 0, ratePerSec: 0 };
  const from = Math.min(...active.map((e) => e.start));
  let backlogMs = 0;
  for (const e of list) {
    const lo = Math.max(e.start, from);
    const hi = Math.min(e.end, t);
    if (!(hi > lo)) continue;
    backlogMs += catchUpEstimateMs(e.record, (hi - lo) * f);
  }
  let ratePerSec = 0;
  for (const e of active) {
    const clipFrames = (e.end - e.start) * f;
    // Records with no per-frame value and only whole-clip cost: amortize across frames
    // (on the backlog side, catchUpEstimateMs takes the whole clip directly)
    const perFrame = Number(e.record?.stepMaxMs) || Number(e.record?.stepMs)
      || (clipFrames > 0 ? (Number(e.record?.catchUpMs) || 0) / clipFrames : 0);
    ratePerSec += perFrame * f;
  }
  return { backlogMs, ratePerSec };
}

/**
 * How many milliseconds ahead of the playhead the target tick for playback swap must lead;
 * returns `null` if it cannot catch up.
 *
 * The background stage must first finish `backlogMs`. Meanwhile, the visible stage advances at
 * 1 s / s, and pushing each additional 1 s of timeline in the background takes an extra
 * `ratePerSec` ms. The lead L must satisfy L = backlog + rate × L / 1000, i.e.,
 * L = backlog / (1 − rate / 1000). When `rate ≥ 1000` (pushing 1 s of timeline in the background
 * requires 1 s or more of wall-clock time), the background can never catch up to the visible stage,
 * so no such L exists.
 *
 * @param {number} backlogMs
 * @param {number} ratePerSec
 * @returns {number | null}
 */
export function playingLeadMs(backlogMs, ratePerSec) {
  const backlog = Math.max(0, Number(backlogMs) || 0);
  const rate = Math.max(0, Number(ratePerSec) || 0);
  if (rate >= 1000) return null;
  return backlog / (1 - rate / 1000);
}
