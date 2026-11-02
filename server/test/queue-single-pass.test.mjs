// Determination of queue fine-grained task one pass per segment forward push
// (`FramePipeline#queueSinglePass`, `docs/archive/agent-reports/AGENT-uc-latency.md`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePipeline } from '../frame-pipeline.mjs';

const judge = (self, control, range) => FramePipeline.prototype.queueSinglePass.call({ playheadWanted: () => [], ...self }, control, range);
const control = (extra = {}) => ({ clipId: 'c1', count: 120, sampling: { firstFrame: 30 }, capabilities: { compositing: 'independent' }, ...extra });

test('QSP1 a queue segment (range given), DOM card: sequential pass', () => {
  assert.equal(judge({}, control(), { from: 0, to: 59 }), true);
  assert.equal(judge({}, control(), { from: 60, to: 119 }), true);
});

test('QSP2 no range (the whole card in one pass, the background pass), canvas heavy card, switch off: proceeds batch by batch', () => {
  assert.equal(judge({}, control(), null), false);
  assert.equal(judge({}, control({ capabilities: { canvasHeavy: true } }), { from: 0, to: 59 }), false);
  assert.equal(judge({ queueSinglePassOff: true }, control(), { from: 0, to: 59 }), false);
  const before = process.env.PROMPTCUT_QUEUE_SINGLE_PASS;
  process.env.PROMPTCUT_QUEUE_SINGLE_PASS = '0';
  try { assert.equal(judge({}, control(), { from: 0, to: 59 }), false); }
  finally { if (before === undefined) delete process.env.PROMPTCUT_QUEUE_SINGLE_PASS; else process.env.PROMPTCUT_QUEUE_SINGLE_PASS = before; }
});

test('QSP3 the playhead wants a frame within this segment of this card (C4 wanted): proceeds batch by batch so that the batch containing the playhead comes out first; when what is wanted is in another segment or another card, it still does a sequential pass', () => {
  // Global frame 30 + local frame 75 = 105, falling in the 60-119 segment
  const wanted = (items) => ({ playheadWanted: () => items });
  assert.equal(judge(wanted([{ clipId: 'c1', frame: 105 }]), control(), { from: 60, to: 119 }), false);
  assert.equal(judge(wanted([{ clipId: 'c1', frame: 105 }]), control(), { from: 0, to: 59 }), true);
  assert.equal(judge(wanted([{ clipId: 'c2', frame: 105 }]), control(), { from: 60, to: 119 }), true);
});
