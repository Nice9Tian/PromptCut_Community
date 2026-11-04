/**
 * Tunable coefficients for K2 (retained per user request, 2026-09-22) + K1 robust per-frame duration.
 *
 * Why this file exists: in measurements throttled to 2 cores, the "worst single frame" for the
 * same card across two runs could differ by more than tenfold (`particles-orbit` 33 ms vs 2.2 ms);
 * what crosses the line is an occasional single-frame stutter, not the card's steady-state cost.
 * Therefore `stepMs` was changed to take a percentile (`robustStep`), and heavy classification and
 * greedy weights are multiplied by a cost multiplier. All three numbers are placed here and can be
 * tuned without changing code (overrides in local `out/pipeline-tuning.json`, returned along with
 * records by `GET /api/data/costs` to both the page and the prerender process).
 *
 * **Shared by browser and Node, pure function**: both ends of `planPipelines` must compute
 * field-by-field identical tables; if coefficients differ on either end, the two tables will not
 * match (K2 "Tunable coefficients"). Therefore this file does not read files, inspect environment
 * variables, use `Date`, or use `Math.random`: identical input produces identical output.
 */

/** Default coefficients (task brief K2) */
export const DEFAULT_TUNING = Object.freeze({
  /**
   * Cost multiplier. Multiplied into the **measured** cost of each card (`stepMs` / `catchUpMs` /
   * `seekMs`): both the heavy classification comparison `stepMs × COST_SCALE > B` and greedy weight
   * `w` are multiplied. Increasing = more conservative, more cards enter the heavy pipeline;
   * decreasing = more cards live-rendered.
   * **It does not change the budget formula `B = 1000 / fps × 70%`**: it only changes "how
   * trustworthy measured values are."
   */
  COST_SCALE: 1,
  /** Percentile of per-frame live render duration samples for `stepMs`. Setting to 1 falls back to the old "single maximum" standard. */
  STEP_PERCENTILE: 0.9,
  /** When there are fewer samples than this, percentiles are unreliable; `robustStep` uses the maximum instead (see below). */
  STEP_MIN_SAMPLES: 16,
});

/** Clamp range (task brief K2). Values out of range are clamped to boundaries without error: coefficients are hand-written into JSON. */
export const TUNING_RANGE = Object.freeze({
  COST_SCALE: Object.freeze({ min: 0.25, max: 4 }),
  STEP_PERCENTILE: Object.freeze({ min: 0.5, max: 1 }),
  STEP_MIN_SAMPLES: Object.freeze({ min: 8, max: 120 }),
});

/**
 * Cap for probe timing pass (task brief K1). **Reserved only for long clips**, not a cutoff for
 * classifying as heavy: if a single frame is too slow, it stops as soon as the `robustStep` result
 * exceeds B, not based on cumulative wall clock of the whole pass. For those not finished pushing
 * by the cap, remaining frames are extrapolated as "first frame measured + median of other frames ×
 * remaining frame count" (do not use average containing mount cost: the first frame must build
 * the tree and parse keyframes; using it as the average overestimates by 1.7 to 3.6 times).
 */
export const PROBE_MAX_FRAMES = 300;
export const PROBE_MAX_MS = 500;

/**
 * A separate upper limit for the two-pass boolean probe (`vtOk` / `seekOk` / `seekMs`) (task brief K1):
 * **capped at 8 frames or 200 ms each**; if the comparison pass exceeds it, record `false`; if the pass
 * measuring `seekMs` exceeds it, record `null`. They do not consume timing pass / snapshot pass quota.
 *
 * The number 8 is part of the criterion itself (pinned partition axis 1 "How to distinguish SeekOK"
 * explicitly states "push to frame 8"), not an adjustable coefficient, so it does not enter the
 * `device` string or `resolveTuning`.
 */
export const PROBE_BOOL_FRAMES = 8;
export const PROBE_BOOL_MS = 200;

const clamp = (value, { min, max }) => (value < min ? min : value > max ? max : value);

/**
 * Clamps override values into a complete set of coefficients. Fields missing from `overrides` or
 * that are not finite numbers all use default values, so `resolveTuning()`, `resolveTuning(null)`,
 * and `resolveTuning({})` all return defaults. The returned object is a frozen new object and does
 * not mutate input arguments.
 */
export function resolveTuning(overrides) {
  const raw = overrides && typeof overrides === 'object' ? overrides : {};
  const pick = (name) => {
    const value = Number(raw[name]);
    return Number.isFinite(value) ? clamp(value, TUNING_RANGE[name]) : DEFAULT_TUNING[name];
  };
  return Object.freeze({
    COST_SCALE: pick('COST_SCALE'),
    STEP_PERCENTILE: pick('STEP_PERCENTILE'),
    STEP_MIN_SAMPLES: Math.round(pick('STEP_MIN_SAMPLES')),
  });
}

/**
 * A card's `stepMs`: robust value of per-frame live render duration samples.
 *
 * - Calculated using the **nearest-rank** percentile: sort samples ascending, take the
 *   `ceil(p × n)`-th sample (1-based). `p = 1` is exactly the maximum, so "`STEP_PERCENTILE`
 *   set to 1 = old single maximum criterion" holds automatically; no interpolation is done
 *   because both sides must match field-by-field, and interpolation introduces trailing
 *   floating-point discrepancies into heavy classification.
 * - **Take the maximum when samples are fewer than `STEP_MIN_SAMPLES`** (decided for this task;
 *   the task brief left it to the implementer). Reason: with few samples, the one picked by
 *   percentile is pure luck (0.9 quantile of 8 samples = 8th = maximum; with fewer samples it
 *   starts picking middle numbers), whereas testing half as much and classifying as light costs
 *   playback frame drops. Taking the maximum is the conservative side, in the same direction as
 *   "extrapolate by median, not by average" upon `catchUpMs` cutoff: better to classify as heavy
 *   than falsely classify as light. On the probe side there is a corresponding rule: if 8 samples
 *   of a `direct` card are fewer than `STEP_MIN_SAMPLES`, sample more until sufficient, so cards
 *   that finish normally follow percentiles; this fallback only takes effect when the probe is
 *   cut off.
 * - Samples that are not finite numbers (NaN / Infinity) are discarded; returns 0 if there are
 *   no samples.
 */
export function robustStep(samples, tuning) {
  const t = tuning && typeof tuning === 'object' && 'STEP_PERCENTILE' in tuning ? tuning : resolveTuning(tuning);
  const list = (Array.isArray(samples) ? samples : []).map(Number).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!list.length) return 0;
  if (list.length < t.STEP_MIN_SAMPLES) return list[list.length - 1];
  const rank = Math.ceil(t.STEP_PERCENTILE * list.length);
  return list[Math.min(list.length, Math.max(1, rank)) - 1];
}
