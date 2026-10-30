import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TUNING, PROBE_MAX_FRAMES, PROBE_MAX_MS, TUNING_RANGE, resolveTuning, robustStep } from './pipelineTuning.mjs';

const seq = (n, f = (i) => i) => Array.from({ length: n }, (_, i) => f(i));

test('缺省系数就是任务书 K2 写的那三个', () => {
  assert.deepEqual({ ...DEFAULT_TUNING }, { COST_SCALE: 1, STEP_PERCENTILE: 0.9, STEP_MIN_SAMPLES: 16 });
  assert.deepEqual({ ...resolveTuning() }, { ...DEFAULT_TUNING });
  assert.deepEqual({ ...resolveTuning(null) }, { ...DEFAULT_TUNING });
  assert.deepEqual({ ...resolveTuning({}) }, { ...DEFAULT_TUNING });
});

test('resolveTuning 夹取到 K2 的三个范围', () => {
  assert.equal(resolveTuning({ COST_SCALE: 0 }).COST_SCALE, TUNING_RANGE.COST_SCALE.min);
  assert.equal(resolveTuning({ COST_SCALE: 100 }).COST_SCALE, TUNING_RANGE.COST_SCALE.max);
  assert.equal(resolveTuning({ STEP_PERCENTILE: 0.1 }).STEP_PERCENTILE, 0.5);
  assert.equal(resolveTuning({ STEP_PERCENTILE: 2 }).STEP_PERCENTILE, 1);
  assert.equal(resolveTuning({ STEP_MIN_SAMPLES: 1 }).STEP_MIN_SAMPLES, 8);
  assert.equal(resolveTuning({ STEP_MIN_SAMPLES: 10000 }).STEP_MIN_SAMPLES, 120);
  // 范围内的值原样留着
  assert.equal(resolveTuning({ COST_SCALE: 2 }).COST_SCALE, 2);
  assert.equal(resolveTuning({ STEP_MIN_SAMPLES: 32.4 }).STEP_MIN_SAMPLES, 32, '样本数取整');
});

test('resolveTuning 对坏值退回缺省,不改入参', () => {
  const overrides = { COST_SCALE: 'x', STEP_PERCENTILE: NaN, STEP_MIN_SAMPLES: Infinity };
  const before = JSON.stringify(overrides);
  assert.deepEqual({ ...resolveTuning(overrides) }, { ...DEFAULT_TUNING });
  assert.equal(JSON.stringify(overrides), before);
  assert.deepEqual({ ...resolveTuning('nope') }, { ...DEFAULT_TUNING });
});

test('robustStep 取最近秩百分位:16 个样本的 0.9 分位是第 15 个', () => {
  // 0…15，缺省 STEP_MIN_SAMPLES = 16 刚好够
  const samples = seq(16);
  assert.equal(robustStep(samples, resolveTuning()), 14, 'ceil(0.9 × 16) = 15 → 升序第 15 个 = 14');
  // 乱序输入结果一样（内部排序）
  assert.equal(robustStep([...samples].reverse(), resolveTuning()), 14);
});

test('STEP_PERCENTILE 取 1 就是旧的「单次最大」口径', () => {
  const samples = [...seq(19, (i) => i + 1), 500];
  assert.equal(robustStep(samples, resolveTuning({ STEP_PERCENTILE: 1 })), 500);
  assert.equal(robustStep(samples, resolveTuning()), 18, '缺省 0.9 分位（20 个样本取第 18 个）把那一帧偶发卡顿挡在外面');
});

test('样本不足 STEP_MIN_SAMPLES 时取最大值（保守侧）', () => {
  const few = [1, 1, 2, 40];
  assert.equal(robustStep(few, resolveTuning()), 40);
  // 补够样本之后同一组数走百分位、挡掉那一帧
  const enough = [...seq(19, () => 1), 40];
  assert.equal(robustStep(enough, resolveTuning()), 1);
  // 下调 STEP_MIN_SAMPLES 让 4 个样本也走百分位
  assert.equal(robustStep(few, resolveTuning({ STEP_MIN_SAMPLES: 8 })), 40, '4 < 8 仍然取最大');
  assert.equal(robustStep(seq(8, (i) => i), resolveTuning({ STEP_MIN_SAMPLES: 8 })), 7, 'ceil(0.9 × 8) = 8 → 第 8 个');
});

test('robustStep 丢掉非有限数;空表回 0', () => {
  assert.equal(robustStep([], resolveTuning()), 0);
  assert.equal(robustStep(undefined, resolveTuning()), 0);
  assert.equal(robustStep([NaN, Infinity], resolveTuning()), 0);
  assert.equal(robustStep([1, NaN, 3], resolveTuning()), 3, '剩 2 个样本 < 16 → 取最大');
});

test('robustStep 也收裸的覆盖值,不必先 resolveTuning', () => {
  assert.equal(robustStep(seq(16), { STEP_PERCENTILE: 1 }), 15);
  assert.equal(robustStep(seq(16)), 14, '不传系数就用缺省');
});

test('探针计时趟的封顶常量', () => {
  assert.equal(PROBE_MAX_FRAMES, 300);
  assert.equal(PROBE_MAX_MS, 500);
});
