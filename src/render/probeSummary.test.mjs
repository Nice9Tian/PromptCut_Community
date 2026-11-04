import test from 'node:test';
import assert from 'node:assert/strict';

import { maxOf, median, percentile, sumOf, summarizeProbe } from './probeSummary.mjs';
import { DEFAULT_TUNING, resolveTuning } from './pipelineTuning.mjs';

const seq = (n, f = () => 1) => Array.from({ length: n }, (_, i) => f(i));

test('helpers: nearest-rank percentile, median, sum, max', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.9), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([], 0.9), 0);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), 0);
  assert.equal(sumOf([1, 2, NaN, 3]), 6, 'non-finite numbers are dropped');
  assert.equal(maxOf([1, 9, 2]), 9);
  assert.equal(maxOf([]), 0);
});

test('stepped card fully advanced: catchUpMs is just the sum of the frames, no extrapolation', () => {
  const steps = seq(20, (i) => 1 + i * 0.1);
  const out = summarizeProbe({ kind: 'stepped', steps, totalFrames: 20 }, DEFAULT_TUNING);
  assert.equal(out.remainingFrames, 0);
  assert.equal(out.extrapolatedMs, 0);
  assert.equal(out.catchUpMs, sumOf(steps));
  assert.equal(out.stepMs, percentile(steps, 0.9), 'with enough samples use the percentile');
  assert.equal(out.stepMaxMs, maxOf(steps));
});

test('timing pass was capped: the remaining frames are filled with the "median excluding the first frame", not the average', () => {
  // First frame 20 ms (tree building + keyframe parsing), remaining 40 frames 1 ms each; clip total 300 frames
  const steps = [20, ...seq(40, () => 1)];
  const out = summarizeProbe({ kind: 'stepped', steps, totalFrames: 300, truncated: true }, DEFAULT_TUNING);
  assert.equal(out.remainingFrames, 259);
  assert.equal(out.restMedianMs, 1);
  assert.equal(out.extrapolatedMs, 259);
  assert.equal(out.catchUpMs, 20 + 40 + 259);
  // Legacy metric (average of pushed frames × total frames) is systematically
  // overestimated on cards with "expensive first frame"
  assert.ok(out.legacyCatchUpMs > out.catchUpMs * 1.3, `old method ${out.legacyCatchUpMs} vs new method ${out.catchUpMs}`);
});

test('direct card: catchUpMs is always 0, no extrapolation', () => {
  const out = summarizeProbe({ kind: 'random', steps: [1, 2, 3], totalFrames: 120 }, DEFAULT_TUNING);
  assert.equal(out.catchUpMs, 0);
  assert.equal(out.legacyCatchUpMs, 0);
  assert.equal(out.remainingFrames, 0);
});

test('with fewer than STEP_MIN_SAMPLES samples, stepMs falls back to the max (conservative side)', () => {
  const steps = [1, 1, 1, 1, 1, 9];
  const out = summarizeProbe({ kind: 'stepped', steps, totalFrames: 6 }, DEFAULT_TUNING);
  assert.equal(out.samples, 6);
  assert.equal(out.stepMs, 9);
  // Lowering the gate uses percentiles
  const loose = summarizeProbe({ kind: 'stepped', steps, totalFrames: 6 }, resolveTuning({ STEP_MIN_SAMPLES: 8 }));
  assert.equal(loose.stepMs, 9, 'STEP_MIN_SAMPLES clamp lower bound is 8, 6 samples are still not enough');
  const enough = summarizeProbe({ kind: 'stepped', steps: seq(20, (i) => (i === 19 ? 9 : 1)), totalFrames: 20 }, DEFAULT_TUNING);
  assert.equal(enough.stepMs, 1, 'only 1 of the 20 samples is 9, p90 does not pick it');
  assert.equal(enough.stepMaxMs, 9, 'single-run max is recorded separately, for diagnostics only');
});

test('the durations of the three generate snapshots stages also use a robust value', () => {
  const out = summarizeProbe({
    kind: 'stepped', steps: seq(20), totalFrames: 20,
    inline: seq(20, (i) => (i === 19 ? 99 : 10)), raster: seq(20, () => 0), serialize: seq(20, () => 5),
  }, DEFAULT_TUNING);
  assert.equal(out.inlineMs, 10, 'an occasional single frame of 99 should not become the result');
  assert.equal(out.rasterMs, 0, 'a card without a canvas is 0');
  assert.equal(out.serializeMs, 5);
});

test('empty samples / missing fields do not throw', () => {
  const out = summarizeProbe({ kind: 'stepped', steps: [] }, DEFAULT_TUNING);
  assert.equal(out.stepMs, 0);
  assert.equal(out.catchUpMs, 0);
  assert.equal(out.firstMs, 0);
  assert.deepEqual(summarizeProbe({}, DEFAULT_TUNING).stepMs, 0);
  assert.deepEqual(summarizeProbe(null).stepMs, 0);
});

test('both paths compute the same numbers from the same input (pure function, does not mutate its arguments)', () => {
  const raw = { kind: 'stepped', steps: seq(30, (i) => i + 1), inline: seq(30), totalFrames: 60, truncated: true };
  const before = JSON.stringify(raw);
  const a = summarizeProbe(raw, DEFAULT_TUNING);
  const b = summarizeProbe(raw, resolveTuning(DEFAULT_TUNING));
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(raw), before);
});
