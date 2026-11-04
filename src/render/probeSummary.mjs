/**
 * Collapses the **raw samples** returned by the probe into the numbers expected in a cost record
 * (task brief K1 + 3.8).
 *
 * **Compute in one place, share across two paths**: the offline probe `scripts/probe-card-costs.mjs`
 * and resident probe `src/editor/probeRunner.ts` must measure numbers under the same baseline:
 * writing statistics separately in both places would make it impossible to verify that "the same
 * batch of cards measures consistently across both paths" (same applies to the `device` string,
 * see `costDevice.mjs`).
 *
 * The page side is only responsible for **measuring** and only returns raw arrays; quantiles,
 * extrapolation, and classifying as heavy are all done here. The advantage is that `--json`
 * retains raw samples: recalculating with changed coefficients or comparing differences in
 * heavy-classification lists between two runs does not require re-probing.
 *
 * # How the numbers are derived
 *
 * - `stepMs` = `robustStep(steps)`: `STEP_PERCENTILE` percentile (takes max if samples are
 *   insufficient). **The only number used to classify as heavy.**
 * - `stepMaxMs` = single maximum, **for diagnostics only**, does not enter heavy classification or
 *   dispatch (under a 2-core limit, two passes can differ by over 10x).
 * - `catchUpMs` = sum of all frames; when the timing pass is capped by `PROBE_MAX_FRAMES` /
 *   `PROBE_MAX_MS`, frames not stepped are filled in using the **median excluding the first frame**:
 *   do not use the average: the first frame must build trees and parse keyframes, so including it
 *   in the average systematically skews it higher (the old approach was 1.7~3.6x too high).
 *   `direct` cards are always 0.
 * - `inlineMs` / `rasterMs` / `serializeMs` also take robust values (the three stages of generate
 *   snapshots, do not enter heavy classification).
 */

import { robustStep } from './pipelineTuning.mjs';

const finite = (xs) => (Array.isArray(xs) ? xs.map(Number).filter((x) => Number.isFinite(x)) : []);

export const maxOf = (xs) => finite(xs).reduce((m, x) => (x > m ? x : m), 0);
export const sumOf = (xs) => finite(xs).reduce((a, x) => a + x, 0);

/** Ascending nearest-rank percentile (same baseline as `robustStep`, no interpolation). For table output and diagnostics only */
export function percentile(xs, p) {
  const s = finite(xs).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1] : 0;
}

export function median(xs) {
  const s = finite(xs).sort((a, b) => a - b);
  if (!s.length) return 0;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/**
 * @param {object} raw
 * @param {'random'|'stepped'} raw.kind
 * @param {number[]} raw.steps        Per-frame live render duration (timing pass; for `direct` cards, `stepMs` of each sample)
 * @param {number[]} [raw.inline]     Per-frame style inlining duration
 * @param {number[]} [raw.raster]     Per-frame canvas rasterization duration
 * @param {number[]} [raw.serialize]  Per-frame serialization duration
 * @param {number} [raw.totalFrames]  Total clip frames (used for `stepped` card extrapolation)
 * @param {boolean} [raw.truncated]   Whether the timing pass was capped (diagnostic fields only)
 * @param {object} [tuning]           K2 coefficients
 */
export function summarizeProbe(raw, tuning) {
  const steps = finite(raw?.steps);
  const rest = steps.slice(1);
  const pushed = steps.length;
  const stepped = raw?.kind === 'stepped';
  const remaining = stepped ? Math.max(0, (Number(raw?.totalFrames) || 0) - pushed) : 0;
  const tailMs = remaining > 0 ? median(rest) * remaining : 0;
  return {
    stepMs: robustStep(steps, tuning),
    stepMaxMs: maxOf(steps),
    inlineMs: robustStep(raw?.inline, tuning),
    rasterMs: robustStep(raw?.raster, tuning),
    serializeMs: robustStep(raw?.serialize, tuning),
    catchUpMs: stepped ? sumOf(steps) + tailMs : 0,

    /* The following only enter diagnostics / reports, not cost records */
    samples: pushed,
    stepP50: percentile(steps, 0.5),
    stepP90: percentile(steps, 0.9),
    firstMs: steps[0] ?? 0,
    restMedianMs: median(rest),
    extrapolatedMs: tailMs,
    remainingFrames: remaining,
    /** What the old baseline ("average of stepped frames × total clip frames") would calculate, for side-by-side comparison in reports */
    legacyCatchUpMs: !stepped ? 0
      : (raw?.truncated && pushed ? (sumOf(steps) / pushed) * (Number(raw?.totalFrames) || pushed) : sumOf(steps)),
  };
}
