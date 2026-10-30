import test from 'node:test';
import assert from 'node:assert/strict';
import { clipFrameSpan, planShardRanges, shardCutCandidates } from './shardPlan.mjs';
import { cardMountedAt } from './frameWindow.mjs';

const sizes = ranges => ranges.map(([a, b]) => b - a + 1);
const contiguous = (ranges, start, end) => {
  assert.equal(ranges[0][0], start);
  assert.equal(ranges.at(-1)[1], end);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1] + 1);
};
const cutsInside = (ranges, clip, fps) => {
  const span = clipFrameSpan(clip, fps);
  return ranges.slice(1).map(([a]) => a).filter(c => c > span[0] && c <= span[1]);
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

test('direct-only timelines split into near-equal shards', () => {
  const clips = [{ start: 0, end: 88.7, mode: 'direct' }, { start: 5, end: 11, mode: 'direct' }];
  const ranges = planShardRanges(clips, 0, 2660, 30, 4);
  contiguous(ranges, 0, 2660);
  assert.equal(ranges.length, 4);
  assert.ok(Math.max(...sizes(ranges)) - Math.min(...sizes(ranges)) <= 1, JSON.stringify(ranges));
});

test('no shard boundary falls inside a stateful card, including one that starts mid-shard', () => {
  // Tokyo project: step-timeline 65.3-68.0 was cut at frame 1962 by a caption boundary.
  const stepTimeline = { start: 65.3, end: 68, mode: 'stateful' };
  const clips = [{ start: 0, end: 88.7, mode: 'direct' }, stepTimeline, { start: 5, end: 11, mode: 'stateful' }, { start: 40.4, end: 52.3, mode: 'stateful' }];
  for (const workers of [2, 3, 4, 6]) {
    const ranges = planShardRanges(clips, 0, 2660, 30, workers);
    contiguous(ranges, 0, 2660);
    for (const clip of clips.filter(c => c.mode === 'stateful')) assert.deepEqual(cutsInside(ranges, clip, 30), [], `${workers} workers ${JSON.stringify(ranges)}`);
  }
});

test('a boundary exactly at a stateful card mount or after its last frame is allowed', () => {
  const clip = { start: 2, end: 3, mode: 'stateful' };
  const candidates = new Set(shardCutCandidates([clip], 0, 149, 30));
  assert.equal(candidates.has(59), true);
  assert.equal(candidates.has(60), false);
  assert.equal(candidates.has(89), false);
  assert.equal(candidates.has(90), true);
});

test('unknown modes are stateful and a timeline-long stateful card cannot be split', () => {
  assert.deepEqual(planShardRanges([{ start: 0, end: 10 }], 0, 299, 30, 4), [[0, 299]]);
  assert.deepEqual(planShardRanges([{ start: 0, end: 10, mode: 'react' }], 0, 299, 30, 4), [[0, 299]]);
});

test('sparse cut points give fewer shards, never a shard shorter than one second', () => {
  // Stateful cards leave only frames 299, 300 and 599 as cut points.
  const clips = [{ start: 0.05, end: 9.95, mode: 'stateful' }, { start: 10.05, end: 19.95, mode: 'stateful' }];
  assert.deepEqual(shardCutCandidates(clips, 0, 599, 30), [299, 300, 599]);
  assert.deepEqual(planShardRanges(clips, 0, 599, 30, 4), [[0, 299], [300, 599]]);
  // Too short to be worth a second Chrome.
  assert.deepEqual(planShardRanges([], 0, 40, 30, 4), [[0, 40]]);
  for (const ranges of [planShardRanges([], 0, 100, 30, 8), planShardRanges(clips, 0, 599, 30, 8)]) {
    assert.ok(sizes(ranges).every(n => n >= 30), JSON.stringify(ranges));
  }
});

test('the longest shard is as short as the allowed cut points permit', () => {
  const clips = [{ start: 1, end: 7, mode: 'stateful' }, { start: 12, end: 13.5, mode: 'stateful' }];
  const candidates = shardCutCandidates(clips, 0, 599, 30);
  const ranges = planShardRanges(clips, 0, 599, 30, 2);
  assert.equal(ranges.length, 2);
  const best = Math.min(...candidates.map(c => Math.max(c, 600 - c)));
  assert.equal(Math.max(...sizes(ranges)), best);
});

test('a partial frame range is planned within its own bounds', () => {
  const clips = [{ start: 0, end: 100, mode: 'direct' }, { start: 30, end: 33, mode: 'stateful' }];
  const ranges = planShardRanges(clips, 600, 1199, 30, 3);
  contiguous(ranges, 600, 1199);
  assert.equal(ranges.length, 3);
  assert.deepEqual(cutsInside(ranges, clips[1], 30), []);
  assert.deepEqual(planShardRanges(clips, 600, 1199, 30, 1), [[600, 1199]]);
});
