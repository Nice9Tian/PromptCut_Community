import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PUSH_WEIGHT, clipFrameSpan, defaultMaxLeadFrames, planShardRanges, shardCutCandidates, shardPushDrawFrom } from './shardPlan.mjs';
import { cardMountedAt } from './frameWindow.mjs';

const sizes = ranges => ranges.map(([a, b]) => b - a + 1);
const shardCosts = (ranges, start, w = DEFAULT_PUSH_WEIGHT) => ranges.map(([a, b]) => (a - start) * w + (b - a + 1));
const contiguous = (ranges, start, end) => {
  assert.equal(ranges[0][0], start);
  assert.equal(ranges.at(-1)[1], end);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1] + 1);
};
const cutsAfterLead = (ranges, clip, fps) => {
  const span = clipFrameSpan(clip, fps);
  const lead = defaultMaxLeadFrames(fps);
  return ranges.slice(1).map(([a]) => a).filter(c => c > span[0] + lead && c <= span[1]);
};

test('clip frame span matches Stage mounting, including the mount lead', () => {
  const clip = { start: 2, end: 3 };
  const span = clipFrameSpan(clip, 30);
  assert.deepEqual(span, [59, 89]);
  for (let n = 50; n < 100; n++) assert.equal(cardMountedAt(clip, n / 30), n >= span[0] && n <= span[1], `frame ${n}`);
  const odd = { start: 10.05, end: 11.9 };
  const oddSpan = clipFrameSpan(odd, 30);
  for (let n = 290; n < 370; n++) assert.equal(cardMountedAt(odd, n / 30), n >= oddSpan[0] && n <= oddSpan[1], `frame ${n}`);
});

test('direct-only timelines split into balanced-cost shards (and near-equal lengths when pushWeight is 0)', () => {
  const clips = [{ start: 0, end: 88.7, mode: 'direct' }, { start: 5, end: 11, mode: 'direct' }];
  const ranges = planShardRanges(clips, 0, 2660, 30, 4);
  contiguous(ranges, 0, 2660);
  assert.equal(ranges.length, 4);
  const costs = shardCosts(ranges, 0);
  assert.ok(Math.max(...costs) - Math.min(...costs) <= 2, JSON.stringify({ ranges, costs }));
  const unweighted = planShardRanges(clips, 0, 2660, 30, { workers: 4, pushWeight: 0 });
  assert.ok(Math.max(...sizes(unweighted)) - Math.min(...sizes(unweighted)) <= 1, JSON.stringify(unweighted));
});

test('no shard boundary falls inside a stateful card after its mount lead, including one that starts mid-shard', () => {
  // Tokyo project: step-timeline 65.3-68.0 was cut at frame 1962 by a caption boundary.
  const stepTimeline = { start: 65.3, end: 68, mode: 'stateful' };
  const clips = [{ start: 0, end: 88.7, mode: 'direct' }, stepTimeline, { start: 5, end: 11, mode: 'stateful' }, { start: 40.4, end: 52.3, mode: 'stateful' }];
  for (const workers of [2, 3, 4, 6]) {
    const ranges = planShardRanges(clips, 0, 2660, 30, workers);
    contiguous(ranges, 0, 2660);
    for (const clip of clips.filter(c => c.mode === 'stateful')) assert.deepEqual(cutsAfterLead(ranges, clip, 30), [], `${workers} workers ${JSON.stringify(ranges)}`);
  }
});

test('a boundary at a stateful card mount, within its mount lead, or after its last frame is allowed; mid-card is blocked', () => {
  const clip = { start: 2, end: 3, mode: 'stateful' };
  const candidates = new Set(shardCutCandidates([clip], 0, 149, 30));
  assert.equal(candidates.has(59), true);
  assert.equal(candidates.has(60), true);
  assert.equal(candidates.has(62), true);
  assert.equal(candidates.has(63), false);
  assert.equal(candidates.has(89), false);
  assert.equal(candidates.has(90), true);
  const zeroLead = new Set(shardCutCandidates([clip], 0, 149, 30, { maxLeadFrames: 0 }));
  assert.equal(zeroLead.has(59), true);
  assert.equal(zeroLead.has(60), false);
});

test('unknown modes are stateful and a timeline-long stateful card cannot be split', () => {
  assert.deepEqual(planShardRanges([{ start: 0, end: 10 }], 0, 299, 30, 4), [[0, 299]]);
  assert.deepEqual(planShardRanges([{ start: 0, end: 10, mode: 'react' }], 0, 299, 30, 4), [[0, 299]]);
});

test('sparse cut points give fewer shards, never a shard shorter than one second', () => {
  // With maxLeadFrames: 0, stateful cards leave only frames 299, 300 and 599 as cut points.
  const clips = [{ start: 0.05, end: 9.95, mode: 'stateful' }, { start: 10.05, end: 19.95, mode: 'stateful' }];
  assert.deepEqual(shardCutCandidates(clips, 0, 599, 30, { maxLeadFrames: 0 }), [299, 300, 599]);
  const planned = planShardRanges(clips, 0, 599, 30, 4);
  assert.equal(planned.length, 2);
  contiguous(planned, 0, 599);
  // Too short to be worth a second Chrome.
  assert.deepEqual(planShardRanges([], 0, 40, 30, 4), [[0, 40]]);
  for (const ranges of [planShardRanges([], 0, 100, 30, 8), planShardRanges(clips, 0, 599, 30, 8)]) {
    assert.ok(sizes(ranges).every(n => n >= 30), JSON.stringify(ranges));
  }
});

test('the highest shard cost is as small as the allowed cut points permit', () => {
  const clips = [{ start: 1, end: 7, mode: 'stateful' }, { start: 12, end: 13.5, mode: 'stateful' }];
  const candidates = shardCutCandidates(clips, 0, 599, 30).filter(c => c >= 30 && 600 - c >= 30);
  const ranges = planShardRanges(clips, 0, 599, 30, 2);
  assert.equal(ranges.length, 2);
  const costOfCut = c => Math.max(c, c * DEFAULT_PUSH_WEIGHT + (600 - c));
  const best = Math.min(...candidates.map(costOfCut));
  assert.ok(Math.abs(Math.max(...shardCosts(ranges, 0)) - best) < 1e-6);
});

test('a partial frame range is planned within its own bounds', () => {
  const clips = [{ start: 0, end: 100, mode: 'direct' }, { start: 30, end: 33, mode: 'stateful' }];
  const ranges = planShardRanges(clips, 600, 1199, 30, 3);
  contiguous(ranges, 600, 1199);
  assert.equal(ranges.length, 3);
  assert.deepEqual(cutsAfterLead(ranges, clips[1], 30), []);
  assert.deepEqual(planShardRanges(clips, 600, 1199, 30, 1), [[600, 1199]]);
});

test('back-to-back stateful cards split across mount leads and compute shardPushDrawFrom', () => {
  const clips = [];
  for (let s = 0; s < 48; s += 2) clips.push({ id: `c${s}`, start: s, end: s + 2, mode: 'stateful' });
  clips.push({ id: 'tail', start: 48, end: 60, mode: 'direct' });
  const ranges = planShardRanges(clips, 0, 1799, 30, 4);
  contiguous(ranges, 0, 1799);
  assert.equal(ranges.length, 4);
  assert.ok(ranges[0][1] < 800, `shard 0 is balanced: ${JSON.stringify(ranges)}`);
  assert.ok(ranges[0][1] - ranges[0][0] >= ranges[3][1] - ranges[3][0], 'earlier shard captures at least as much as final shard');
  assert.equal(shardPushDrawFrom(clips, 540, 30), 537);
  assert.equal(shardPushDrawFrom(clips, 1440, 30), null);
});
