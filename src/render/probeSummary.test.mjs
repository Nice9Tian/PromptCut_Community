import test from 'node:test';
import assert from 'node:assert/strict';

import { maxOf, median, percentile, sumOf, summarizeProbe } from './probeSummary.mjs';
import { DEFAULT_TUNING, resolveTuning } from './pipelineTuning.mjs';

const seq = (n, f = () => 1) => Array.from({ length: n }, (_, i) => f(i));

test('小工具:最近秩分位、中位数、和、最大', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.9), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([], 0.9), 0);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), 0);
  assert.equal(sumOf([1, 2, NaN, 3]), 6, '非有限数丢掉');
  assert.equal(maxOf([1, 9, 2]), 9);
  assert.equal(maxOf([]), 0);
});

test('stepped 卡推完了:catchUpMs 就是各帧之和,不外推', () => {
  const steps = seq(20, (i) => 1 + i * 0.1);
  const out = summarizeProbe({ kind: 'stepped', steps, totalFrames: 20 }, DEFAULT_TUNING);
  assert.equal(out.remainingFrames, 0);
  assert.equal(out.extrapolatedMs, 0);
  assert.equal(out.catchUpMs, sumOf(steps));
  assert.equal(out.stepMs, percentile(steps, 0.9), '样本够就走百分位');
  assert.equal(out.stepMaxMs, maxOf(steps));
});

test('计时趟被封顶:剩下的帧按「除首帧外的中位数」补,不用平均', () => {
  // 首帧 20 ms(建树 + 解析关键帧),其余 40 帧各 1 ms;片段共 300 帧
  const steps = [20, ...seq(40, () => 1)];
  const out = summarizeProbe({ kind: 'stepped', steps, totalFrames: 300, truncated: true }, DEFAULT_TUNING);
  assert.equal(out.remainingFrames, 259);
  assert.equal(out.restMedianMs, 1);
  assert.equal(out.extrapolatedMs, 259);
  assert.equal(out.catchUpMs, 20 + 40 + 259);
  // 旧口径(已推帧的平均 × 总帧数)在「首帧贵」的卡上系统性偏大
  assert.ok(out.legacyCatchUpMs > out.catchUpMs * 1.3, `旧口径 ${out.legacyCatchUpMs} 对新口径 ${out.catchUpMs}`);
});

test('direct 卡:catchUpMs 恒为 0、不外推', () => {
  const out = summarizeProbe({ kind: 'random', steps: [1, 2, 3], totalFrames: 120 }, DEFAULT_TUNING);
  assert.equal(out.catchUpMs, 0);
  assert.equal(out.legacyCatchUpMs, 0);
  assert.equal(out.remainingFrames, 0);
});

test('样本不足 STEP_MIN_SAMPLES 时 stepMs 退回取最大(保守侧)', () => {
  const steps = [1, 1, 1, 1, 1, 9];
  const out = summarizeProbe({ kind: 'stepped', steps, totalFrames: 6 }, DEFAULT_TUNING);
  assert.equal(out.samples, 6);
  assert.equal(out.stepMs, 9);
  // 把门槛放低就走百分位
  const loose = summarizeProbe({ kind: 'stepped', steps, totalFrames: 6 }, resolveTuning({ STEP_MIN_SAMPLES: 8 }));
  assert.equal(loose.stepMs, 9, 'STEP_MIN_SAMPLES 夹取下限是 8,6 个样本仍然不足');
  const enough = summarizeProbe({ kind: 'stepped', steps: seq(20, (i) => (i === 19 ? 9 : 1)), totalFrames: 20 }, DEFAULT_TUNING);
  assert.equal(enough.stepMs, 1, '20 个样本里只有 1 个 9,p90 挑不到它');
  assert.equal(enough.stepMaxMs, 9, '单次最大另记,只作诊断');
});

test('三段生成快照的耗时同样取稳健值', () => {
  const out = summarizeProbe({
    kind: 'stepped', steps: seq(20), totalFrames: 20,
    inline: seq(20, (i) => (i === 19 ? 99 : 10)), raster: seq(20, () => 0), serialize: seq(20, () => 5),
  }, DEFAULT_TUNING);
  assert.equal(out.inlineMs, 10, '偶发的一帧 99 不该顶成成绩');
  assert.equal(out.rasterMs, 0, '没有画布的卡是 0');
  assert.equal(out.serializeMs, 5);
});

test('空样本 / 缺字段不抛', () => {
  const out = summarizeProbe({ kind: 'stepped', steps: [] }, DEFAULT_TUNING);
  assert.equal(out.stepMs, 0);
  assert.equal(out.catchUpMs, 0);
  assert.equal(out.firstMs, 0);
  assert.deepEqual(summarizeProbe({}, DEFAULT_TUNING).stepMs, 0);
  assert.deepEqual(summarizeProbe(null).stepMs, 0);
});

test('两条路同一份输入算出同一批数(纯函数,不改入参)', () => {
  const raw = { kind: 'stepped', steps: seq(30, (i) => i + 1), inline: seq(30), totalFrames: 60, truncated: true };
  const before = JSON.stringify(raw);
  const a = summarizeProbe(raw, DEFAULT_TUNING);
  const b = summarizeProbe(raw, resolveTuning(DEFAULT_TUNING));
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(raw), before);
});
