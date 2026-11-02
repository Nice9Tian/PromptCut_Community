/**
 * 运动跟随的纯逻辑单测。跑：node --test src/kernel/motion.test.mjs
 *
 * 这里防的是一类特别难查的错：卡片**确实在动**，只是跟错了。
 * 时间没对齐（卡片压在素材中间、素材自己带 mediaOffset）、坐标没换算
 * （素材 1920 宽、舞台 1280 宽）、锚点取在被遮挡的那一帧——三者任何一个错了，
 * 预览里看到的都是「一张卡在缓缓移动」，看不出它跟的是别的时刻或别的比例。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildClipMotion, motionAt } from "./motion.ts";

/** 造一条每帧右移 10 素材像素的直线轨迹 */
function line(n, { x0 = 100, y0 = 50, dx = 10, dy = 0 } = {}) {
  return Array.from({ length: n }, (_, i) => [x0 + i * dx, y0 + i * dy]);
}

const MEDIA = { id: "m1", width: 1920, height: 1080, duration: 10 };
const STAGE = { width: 1920, height: 1080 };

test("A card covers the whole media: displacement accumulates frame by frame, the anchor resets to zero", () => {
  const n = 100; // 10 秒 / 100 帧 → frameStep 0.1
  const { motion, summary } = buildClipMotion({
    xy: line(n), visible: Array(n).fill(true),
    media: MEDIA, stage: STAGE,
    card: { start: 0, end: 10 },
    clipOfMedia: { start: 0, mediaOffset: 0 },
    pointIndex: 0, whenHidden: "hold",
  });

  assert.deepEqual(motion.offsets[0], [0, 0], "The displacement of the first frame must be 0");
  assert.equal(motion.offsets[1][0], 10, "When the stage and the media are the same size, the displacement is the raw displacement");
  assert.ok(Math.abs(motion.frameStep - 0.1) < 1e-9);
  assert.equal(summary.rangeX, (n - 1) * 10);
  assert.equal(summary.rangeY, 0);
});

test("The stage is smaller than the media: scaled by cover, and the displacement scales with it", () => {
  const n = 100;
  const { motion } = buildClipMotion({
    xy: line(n), visible: Array(n).fill(true),
    media: MEDIA, stage: { width: 960, height: 540 }, // 正好一半
    card: { start: 0, end: 10 },
    clipOfMedia: { start: 0, mediaOffset: 0 },
    pointIndex: 0, whenHidden: "hold",
  });
  assert.equal(motion.offsets[1][0], 5, "Media displacement 10 → stage displacement 5");
});

test("A card covers only a middle section of the media: the trajectory must be cut starting from the corresponding frame", () => {
  const n = 100; // frameStep 0.1s
  // 素材段从时间轴 2s 开始播，且从素材第 3s 处开始播
  // 卡片放在时间轴 5s → 素材时间 3 + (5 - 2) = 6s → 第 60 帧
  const { motion } = buildClipMotion({
    xy: line(n), visible: Array(n).fill(true),
    media: MEDIA, stage: STAGE,
    card: { start: 5, end: 6 },
    clipOfMedia: { start: 2, mediaOffset: 3 },
    pointIndex: 0, whenHidden: "hold",
  });

  // 切片起点是第 60 帧，位移相对它归零；一秒后（第 70 帧）应该走了 10 帧 × 10px
  assert.deepEqual(motion.offsets[0], [0, 0]);
  assert.equal(motion.offsets[10][0], 100);
  // 只取 1 秒 + 1 帧
  assert.equal(motion.offsets.length, Math.ceil(1 / 0.1) + 1);
});

test("The target is blocked at the start of the card: the anchor must be taken from the first visible frame", () => {
  const n = 50;
  const visible = Array(n).fill(true);
  for (let i = 0; i < 5; i++) visible[i] = false; // 开头 5 帧看不见

  const { motion } = buildClipMotion({
    xy: line(n), visible,
    media: { ...MEDIA, duration: 5 }, stage: STAGE,
    card: { start: 0, end: 5 },
    clipOfMedia: { start: 0, mediaOffset: 0 },
    pointIndex: 0, whenHidden: "hold",
  });

  // 锚点是第 5 帧（x=150），所以第 5 帧位移为 0，第 0 帧是负的
  assert.deepEqual(motion.offsets[5], [0, 0]);
  assert.equal(motion.offsets[0][0], -50);
});

test("Media missing its resolution or duration must raise an error directly, and must not silently produce a wrong trajectory", () => {
  const base = {
    xy: line(10), visible: Array(10).fill(true), stage: STAGE,
    card: { start: 0, end: 1 }, clipOfMedia: { start: 0, mediaOffset: 0 },
    pointIndex: 0, whenHidden: "hold",
  };
  assert.throws(
    () => buildClipMotion({ ...base, media: { ...MEDIA, duration: 0 } }), /duration/);
  assert.throws(
    () => buildClipMotion({ ...base, media: { ...MEDIA, width: 0 } }), /resolution/);
});

// ── motionAt ──────────────────────────────────────────────────────────

const M = {
  mediaId: "m1", pointIndex: 0,
  offsets: [[0, 0], [10, 0], [20, 0], [30, 0]],
  visible: [true, true, false, true],
  frameStep: 0.1,
  whenHidden: "hold",
};

test("Linear interpolation between two frames", () => {
  const a = motionAt(M, 0.15); // 第 1 帧和第 2 帧正中间
  assert.ok(Math.abs(a.dx - 15) < 1e-6, `Interpolation result ${a.dx}`);
});

test("hold: when the target is not visible, stay at the last position where it was seen", () => {
  const a = motionAt(M, 0.2); // 第 2 帧，不可见
  assert.equal(a.visible, false);
  assert.equal(a.dx, 10, "Should stay at the position of frame 1, instead of using the extrapolated value from frame 2");
});

test("Beyond the end of the trajectory it must be clamped, and must not jump back to the origin or extrapolate out of frame", () => {
  const a = motionAt(M, 99);
  assert.equal(a.dx, 30);
  const b = motionAt(M, -5);
  assert.equal(b.dx, 0);
});

test("An empty trajectory does not crash", () => {
  const a = motionAt({ ...M, offsets: [], visible: [] }, 1);
  assert.deepEqual([a.dx, a.dy], [0, 0]);
});
