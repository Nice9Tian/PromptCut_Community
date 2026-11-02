import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TUNING, PROBE_MAX_FRAMES, PROBE_MAX_MS, TUNING_RANGE, resolveTuning, robustStep } from './pipelineTuning.mjs';

const seq = (n, f = (i) => i) => Array.from({ length: n }, (_, i) => f(i));

test('the default coefficients are the three written in task brief K2', () => {
  assert.deepEqual({ ...DEFAULT_TUNING }, { COST_SCALE: 1, STEP_PERCENTILE: 0.9, STEP_MIN_SAMPLES: 16 });
  assert.deepEqual({ ...resolveTuning() }, { ...DEFAULT_TUNING });
  assert.deepEqual({ ...resolveTuning(null) }, { ...DEFAULT_TUNING });
  assert.deepEqual({ ...resolveTuning({}) }, { ...DEFAULT_TUNING });
});

test('resolveTuning clamps to the three ranges of K2', () => {
  assert.equal(resolveTuning({ COST_SCALE: 0 }).COST_SCALE, TUNING_RANGE.COST_SCALE.min);
  assert.equal(resolveTuning({ COST_SCALE: 100 }).COST_SCALE, TUNING_RANGE.COST_SCALE.max);
  assert.equal(resolveTuning({ STEP_PERCENTILE: 0.1 }).STEP_PERCENTILE, 0.5);
  assert.equal(resolveTuning({ STEP_PERCENTILE: 2 }).STEP_PERCENTILE, 1);
  assert.equal(resolveTuning({ STEP_MIN_SAMPLES: 1 }).STEP_MIN_SAMPLES, 8);
  assert.equal(resolveTuning({ STEP_MIN_SAMPLES: 10000 }).STEP_MIN_SAMPLES, 120);
  // In-range values are kept as-is
  assert.equal(resolveTuning({ COST_SCALE: 2 }).COST_SCALE, 2);
  assert.equal(resolveTuning({ STEP_MIN_SAMPLES: 32.4 }).STEP_MIN_SAMPLES, 32, 'sample count is rounded to an integer');
});

test('resolveTuning falls back to defaults on bad values, without modifying its arguments', () => {
  const overrides = { COST_SCALE: 'x', STEP_PERCENTILE: NaN, STEP_MIN_SAMPLES: Infinity };
  const before = JSON.stringify(overrides);
  assert.deepEqual({ ...resolveTuning(overrides) }, { ...DEFAULT_TUNING });
  assert.equal(JSON.stringify(overrides), before);
  assert.deepEqual({ ...resolveTuning('nope') }, { ...DEFAULT_TUNING });
});

test('robustStep takes the nearest-rank percentile: the 0.9 quantile of 16 samples is the 15th', () => {
  // 0…15, default STEP_MIN_SAMPLES = 16 is just enough
  const samples = seq(16);
  assert.equal(robustStep(samples, resolveTuning()), 14, 'ceil(0.9 × 16) = 15 → 15th in ascending order = 14');
  // Out-of-order input produces the same result (internally sorted)
  assert.equal(robustStep([...samples].reverse(), resolveTuning()), 14);
});

test('STEP_PERCENTILE set to 1 is the old "single maximum" basis', () => {
  const samples = [...seq(19, (i) => i + 1), 500];
  assert.equal(robustStep(samples, resolveTuning({ STEP_PERCENTILE: 1 })), 500);
  assert.equal(robustStep(samples, resolveTuning()), 18, 'the default 0.9 quantile (the 18th of 20 samples) keeps that one-off stutter frame out');
});

test('when samples are fewer than STEP_MIN_SAMPLES, take the maximum (conservative side)', () => {
  const few = [1, 1, 2, 40];
  assert.equal(robustStep(few, resolveTuning()), 40);
  // After collecting enough samples, the same set of numbers uses percentiles to block that frame
  const enough = [...seq(19, () => 1), 40];
  assert.equal(robustStep(enough, resolveTuning()), 1);
  // Lower STEP_MIN_SAMPLES so that 4 samples also use percentiles
  assert.equal(robustStep(few, resolveTuning({ STEP_MIN_SAMPLES: 8 })), 40, '4 < 8 still takes the maximum');
  assert.equal(robustStep(seq(8, (i) => i), resolveTuning({ STEP_MIN_SAMPLES: 8 })), 7, 'ceil(0.9 × 8) = 8 → the 8th');
});

test('robustStep drops non-finite numbers; an empty list returns 0', () => {
  assert.equal(robustStep([], resolveTuning()), 0);
  assert.equal(robustStep(undefined, resolveTuning()), 0);
  assert.equal(robustStep([NaN, Infinity], resolveTuning()), 0);
  assert.equal(robustStep([1, NaN, 3], resolveTuning()), 3, '2 samples left < 16 → take the maximum');
});

test('robustStep also accepts bare override values, no need to resolveTuning first', () => {
  assert.equal(robustStep(seq(16), { STEP_PERCENTILE: 1 }), 15);
  assert.equal(robustStep(seq(16)), 14, 'Without a coefficient, the default is used');
});

test('Cap constant for the probe timing pass', () => {
  assert.equal(PROBE_MAX_FRAMES, 300);
  assert.equal(PROBE_MAX_MS, 500);
});
