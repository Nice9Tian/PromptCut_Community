/**
 * Unit tests for C4 frame picking. Run: node --test src/render/snapshotPick.test.mjs
 *
 * Failures at this layer are very quiet: backtracking one frame too many or one frame too few
 * still yields "a snapshot", just with incorrect state: so lock down each case specified in C4:
 * backtrack within the same interval, do not cross intervals, pick independently per layer,
 * fall back to interval start on cold cache, and become transparent if nothing can be picked
 * (no waiting).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorFrames, latestReadyAtOrBefore, localWindowOf, pickLayerSnapshot, pickSnapshotFrame, segmentStartOf } from './snapshotPick.mjs';

test('latestReadyAtOrBefore binary-searches the closed ranges', () => {
  const ranges = [[0, 0], [10, 12], [40, 200]];
  assert.equal(latestReadyAtOrBefore(ranges, 0), 0, 'A frame inside a segment resolves to itself');
  assert.equal(latestReadyAtOrBefore(ranges, 5), 0, 'A frame in a gap falls back to the end of the previous segment');
  assert.equal(latestReadyAtOrBefore(ranges, 11), 11);
  assert.equal(latestReadyAtOrBefore(ranges, 39), 12);
  assert.equal(latestReadyAtOrBefore(ranges, 1000), 200, 'Past the end falls back to the last frame');
  assert.equal(latestReadyAtOrBefore([[10, 12]], 3), null, 'Earlier than the first segment: nothing available');
  assert.equal(latestReadyAtOrBefore([], 3), null);
  assert.equal(latestReadyAtOrBefore(undefined, 3), null);
  assert.equal(latestReadyAtOrBefore([[0, 5]], -1), null);
});

test('anchor set = every clip mountFrameOf, clipFrameSpan last + 1, and frame 0 (C1)', () => {
  const fps = 30;
  // start 1s, end 2s: mountFrameOf = ceil((1 - 0.05) * 30) = 29; last = 59, last + 1 = 60
  const clips = [{ start: 1, end: 2 }, { start: 3, end: 4 }];
  const anchors = anchorFrames(clips, fps);
  assert.equal(anchors[0], 0, 'Frame 0 is always an anchor frame');
  assert.deepEqual(anchors, [0, 29, 60, 89, 120]);
  // Anchor frames of other clips also split segments: visuals of below-dependent cards switch
  // segments when others mount / exit
  assert.equal(segmentStartOf(anchors, 100), 89);
  assert.equal(segmentStartOf(anchors, 29), 29, 'The anchor frame itself belongs to the new segment');
  assert.equal(segmentStartOf(anchors, 28), 0);
  assert.equal(segmentStartOf(anchors, 10_000), 120);
  assert.equal(segmentStartOf([], 5), 0, 'With no anchor frames, the whole track is one segment');
  assert.deepEqual(anchorFrames([], 30), [0]);
  assert.deepEqual(anchorFrames(undefined, 0), [0], 'Does not throw when fps is invalid');
});

test('pick backtracks inside the segment and refuses to cross it', () => {
  // Ready intervals are [0,0] (anchor frame) and [100,120]
  const ranges = [[0, 0], [100, 120]];
  assert.equal(pickSnapshotFrame({ ranges, localFrame: 110, segmentStart: 100 }), 110);
  assert.equal(pickSnapshotFrame({ ranges, localFrame: 150, segmentStart: 100 }), 120, 'Within the same segment, look back to the nearest frame in the segment');
  // Target is in segment [100, …], but only frame 0 is ready: frame 0 belongs to the previous
  // segment and cannot be fetched across segments
  assert.equal(pickSnapshotFrame({ ranges: [[0, 0]], localFrame: 150, segmentStart: 100 }), null, 'Does not cross ranges');
  // With the same ready table and target, when segment start is at 0, it can backtrack to frame 0
  assert.equal(pickSnapshotFrame({ ranges: [[0, 0]], localFrame: 150, segmentStart: 0 }), 0);
  assert.equal(pickSnapshotFrame({ ranges: [], localFrame: 10 }), null, 'No waiting: if nothing can be picked, this layer is transparent');
  assert.equal(pickSnapshotFrame({ ranges, localFrame: -1 }), null);
});

test('cold cache at frame 1000 lands on the segment start (C acceptance check)', () => {
  const fps = 30;
  // A stateful card spanning 0 s to 60 s, and another card mounts at 20 s: its mount frame splits out a segment
  const clips = [{ start: 0, end: 60 }, { start: 20, end: 30 }];
  const anchors = anchorFrames(clips, fps);
  // Second card mounts at 599 (ceil(19.95 × 30)) and exits at 900 (last 899 + 1)
  assert.deepEqual(anchors, [0, 599, 900, 1800]);
  const segment = segmentStartOf(anchors, 1000);
  assert.equal(segment, 900, 'Frame 1000 falls in the segment cut by the anchor frame "second card exits"');
  // Cold cache: C2 produces anchor frames first, so only a few anchor frames themselves are ready at this layer
  const ranges = [[0, 0], [segment, segment], [960, 960]];
  assert.equal(pickSnapshotFrame({ ranges, localFrame: 1000, segmentStart: segment }), 960, 'If the same segment already has a closer frame, use it');
  // True cold cache (anchor frames only): returns to interval start, not frame 0 and not blank
  assert.equal(pickSnapshotFrame({ ranges: [[0, 0], [segment, segment]], localFrame: 1000, segmentStart: segment }), segment);
});

test('localWindowOf maps a global frame onto one layer and clamps the segment start', () => {
  const anchors = [0, 100, 400];
  // Clip starts at global frame 100: local frame = global - 100
  assert.deepEqual(localWindowOf({ globalFrame: 450, firstFrame: 100, count: 600, anchors }), { localFrame: 350, segmentStart: 300 });
  // When segment start is earlier than clip start, clamp to 0 (clip's own first frame is the start of this segment)
  assert.deepEqual(localWindowOf({ globalFrame: 150, firstFrame: 100, count: 600, anchors }), { localFrame: 50, segmentStart: 0 });
  assert.equal(localWindowOf({ globalFrame: 50, firstFrame: 100, count: 600, anchors }), null, 'Clip is not mounted yet');
  assert.equal(localWindowOf({ globalFrame: 800, firstFrame: 100, count: 600, anchors }), null, 'Clip has already exited');
});

test('pickLayerSnapshot: each layer answers from its own table, missing layers stay transparent', () => {
  const anchors = [0, 100, 400];
  const html = { clipId: 'a', kind: 'html', key: 'KA', ranges: [[0, 0], [300, 302]] };
  const stream = { clipId: 'a', kind: 'stream', key: 'SA', ranges: [[0, 12]] };
  // Two tables coexist for the same card without overwriting each other
  assert.deepEqual(pickLayerSnapshot({ layer: html, globalFrame: 450, firstFrame: 100, count: 600, anchors }),
    { kind: 'html', key: 'KA', localFrame: 302 });
  assert.deepEqual(pickLayerSnapshot({ layer: stream, globalFrame: 105, firstFrame: 100, count: 600, anchors }),
    { kind: 'stream', key: 'SA', localFrame: 5 });
  // The frame before segment start 300 cannot cross over
  assert.equal(pickLayerSnapshot({ layer: { ...html, ranges: [[0, 0]] }, globalFrame: 450, firstFrame: 100, count: 600, anchors }), null);
  assert.equal(pickLayerSnapshot({ layer: null, globalFrame: 450 }), null);
  assert.equal(pickLayerSnapshot({ layer: { clipId: 'a', kind: 'html', ranges: [[0, 9]] }, globalFrame: 1 }), null, 'Without a key it cannot be addressed');
});
