/**
 * C4 选帧的单测。跑:node --test src/render/snapshotPick.test.mjs
 *
 * 这一层的错法很安静:多回溯一帧、少回溯一帧,画面都还是「一张快照」,只是
 * 状态不对 —— 所以逐条钉死 C4 写的情形:同区间内回溯、不跨区间、按层各自选、
 * 冷缓存回到区间起点、选不出来就透明(不等待)。
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
  // start 1s、end 2s:mountFrameOf = ceil((1 - 0.05) * 30) = 29;last = 59,last + 1 = 60
  const clips = [{ start: 1, end: 2 }, { start: 3, end: 4 }];
  const anchors = anchorFrames(clips, fps);
  assert.equal(anchors[0], 0, 'Frame 0 is always an anchor frame');
  assert.deepEqual(anchors, [0, 29, 60, 89, 120]);
  // 别的片段的锚帧同样切段:下层依赖卡的画面在别人挂载 / 退场时会换一段
  assert.equal(segmentStartOf(anchors, 100), 89);
  assert.equal(segmentStartOf(anchors, 29), 29, 'The anchor frame itself belongs to the new segment');
  assert.equal(segmentStartOf(anchors, 28), 0);
  assert.equal(segmentStartOf(anchors, 10_000), 120);
  assert.equal(segmentStartOf([], 5), 0, 'With no anchor frames, the whole track is one segment');
  assert.deepEqual(anchorFrames([], 30), [0]);
  assert.deepEqual(anchorFrames(undefined, 0), [0], 'Does not throw when fps is invalid');
});

test('pick backtracks inside the segment and refuses to cross it', () => {
  // 就绪的是 [0,0](锚帧)和 [100,120]
  const ranges = [[0, 0], [100, 120]];
  assert.equal(pickSnapshotFrame({ ranges, localFrame: 110, segmentStart: 100 }), 110);
  assert.equal(pickSnapshotFrame({ ranges, localFrame: 150, segmentStart: 100 }), 120, 'Within the same segment, look back to the nearest frame in the segment');
  // 目标在 [100, …] 这一段,但只有第 0 帧就绪 —— 第 0 帧属于上一段,不能跨过去拿
  assert.equal(pickSnapshotFrame({ ranges: [[0, 0]], localFrame: 150, segmentStart: 100 }), null, 'Does not cross ranges');
  // 同一份就绪表、同一个目标,段起点在 0 时就可以回溯到第 0 帧
  assert.equal(pickSnapshotFrame({ ranges: [[0, 0]], localFrame: 150, segmentStart: 0 }), 0);
  assert.equal(pickSnapshotFrame({ ranges: [], localFrame: 10 }), null, 'No waiting: if nothing can be picked, this layer is transparent');
  assert.equal(pickSnapshotFrame({ ranges, localFrame: -1 }), null);
});

test('cold cache at frame 1000 lands on the segment start (C acceptance check)', () => {
  const fps = 30;
  // 一张从 0 秒铺到 60 秒的 stateful 卡,另一张卡在第 20 秒挂载 —— 它的挂载帧切出一段
  const clips = [{ start: 0, end: 60 }, { start: 20, end: 30 }];
  const anchors = anchorFrames(clips, fps);
  // 第二张卡挂载于 599(ceil(19.95 × 30))、退场于 900(last 899 + 1)
  assert.deepEqual(anchors, [0, 599, 900, 1800]);
  const segment = segmentStartOf(anchors, 1000);
  assert.equal(segment, 900, 'Frame 1000 falls in the segment cut by the anchor frame "second card exits"');
  // 冷缓存:C2 先产锚帧,所以这一层就绪的只有几个锚帧本身
  const ranges = [[0, 0], [segment, segment], [960, 960]];
  assert.equal(pickSnapshotFrame({ ranges, localFrame: 1000, segmentStart: segment }), 960, 'If the same segment already has a closer frame, use it');
  // 真正的冷缓存(只有锚帧):回到区间起点,而不是第 0 帧、也不是空白
  assert.equal(pickSnapshotFrame({ ranges: [[0, 0], [segment, segment]], localFrame: 1000, segmentStart: segment }), segment);
});

test('localWindowOf maps a global frame onto one layer and clamps the segment start', () => {
  const anchors = [0, 100, 400];
  // 片段从全局第 100 帧开始:本地帧 = 全局 - 100
  assert.deepEqual(localWindowOf({ globalFrame: 450, firstFrame: 100, count: 600, anchors }), { localFrame: 350, segmentStart: 300 });
  // 段起点比片段起点还早时夹到 0(片段自己的第一帧就是它这一段的起点)
  assert.deepEqual(localWindowOf({ globalFrame: 150, firstFrame: 100, count: 600, anchors }), { localFrame: 50, segmentStart: 0 });
  assert.equal(localWindowOf({ globalFrame: 50, firstFrame: 100, count: 600, anchors }), null, 'Clip is not mounted yet');
  assert.equal(localWindowOf({ globalFrame: 800, firstFrame: 100, count: 600, anchors }), null, 'Clip has already exited');
});

test('pickLayerSnapshot: each layer answers from its own table, missing layers stay transparent', () => {
  const anchors = [0, 100, 400];
  const html = { clipId: 'a', kind: 'html', key: 'KA', ranges: [[0, 0], [300, 302]] };
  const stream = { clipId: 'a', kind: 'stream', key: 'SA', ranges: [[0, 12]] };
  // 同一张卡的两张表并存、互不覆盖
  assert.deepEqual(pickLayerSnapshot({ layer: html, globalFrame: 450, firstFrame: 100, count: 600, anchors }),
    { kind: 'html', key: 'KA', localFrame: 302 });
  assert.deepEqual(pickLayerSnapshot({ layer: stream, globalFrame: 105, firstFrame: 100, count: 600, anchors }),
    { kind: 'stream', key: 'SA', localFrame: 5 });
  // 段起点 300 之前的那一帧不能跨过来
  assert.equal(pickLayerSnapshot({ layer: { ...html, ranges: [[0, 0]] }, globalFrame: 450, firstFrame: 100, count: 600, anchors }), null);
  assert.equal(pickLayerSnapshot({ layer: null, globalFrame: 450 }), null);
  assert.equal(pickLayerSnapshot({ layer: { clipId: 'a', kind: 'html', ranges: [[0, 9]] }, globalFrame: 1 }), null, 'Without a key it cannot be addressed');
});
