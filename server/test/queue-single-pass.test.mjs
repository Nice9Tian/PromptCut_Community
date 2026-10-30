// 队列细任务一段一趟顺推的判定(`FramePipeline#queueSinglePass`,`docs/archive/agent-reports/AGENT-uc-latency.md`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePipeline } from '../frame-pipeline.mjs';

const judge = (self, control, range) => FramePipeline.prototype.queueSinglePass.call({ playheadWanted: () => [], ...self }, control, range);
const control = (extra = {}) => ({ clipId: 'c1', count: 120, sampling: { firstFrame: 30 }, capabilities: { compositing: 'independent' }, ...extra });

test('QSP1 队列的一段(给了 range)、DOM 卡:顺推', () => {
  assert.equal(judge({}, control(), { from: 0, to: 59 }), true);
  assert.equal(judge({}, control(), { from: 60, to: 119 }), true);
});

test('QSP2 没有 range(整张卡一趟,后台那一趟)、canvas 重卡、开关关着:照逐批', () => {
  assert.equal(judge({}, control(), null), false);
  assert.equal(judge({}, control({ capabilities: { canvasHeavy: true } }), { from: 0, to: 59 }), false);
  assert.equal(judge({ queueSinglePassOff: true }, control(), { from: 0, to: 59 }), false);
  const before = process.env.PROMPTCUT_QUEUE_SINGLE_PASS;
  process.env.PROMPTCUT_QUEUE_SINGLE_PASS = '0';
  try { assert.equal(judge({}, control(), { from: 0, to: 59 }), false); }
  finally { if (before === undefined) delete process.env.PROMPTCUT_QUEUE_SINGLE_PASS; else process.env.PROMPTCUT_QUEUE_SINGLE_PASS = before; }
});

test('QSP3 播放头正要这张卡这一段里的帧(C4 wanted):照逐批,好让含播放头的那一批先出;要的是别的段或别的卡时照样顺推', () => {
  // 全局帧 30 + 本地帧 75 = 105,落在 60-119 这一段
  const wanted = (items) => ({ playheadWanted: () => items });
  assert.equal(judge(wanted([{ clipId: 'c1', frame: 105 }]), control(), { from: 60, to: 119 }), false);
  assert.equal(judge(wanted([{ clipId: 'c1', frame: 105 }]), control(), { from: 0, to: 59 }), true);
  assert.equal(judge(wanted([{ clipId: 'c2', frame: 105 }]), control(), { from: 60, to: 119 }), true);
});
