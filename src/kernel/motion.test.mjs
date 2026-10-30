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

test("卡片压满整段素材：位移逐帧累积，锚点归零", () => {
  const n = 100; // 10 秒 / 100 帧 → frameStep 0.1
  const { motion, summary } = buildClipMotion({
    xy: line(n), visible: Array(n).fill(true),
    media: MEDIA, stage: STAGE,
    card: { start: 0, end: 10 },
    clipOfMedia: { start: 0, mediaOffset: 0 },
    pointIndex: 0, whenHidden: "hold",
  });

  assert.deepEqual(motion.offsets[0], [0, 0], "第一帧位移必须是 0");
  assert.equal(motion.offsets[1][0], 10, "舞台和素材同尺寸时，位移就是原始位移");
  assert.ok(Math.abs(motion.frameStep - 0.1) < 1e-9);
  assert.equal(summary.rangeX, (n - 1) * 10);
  assert.equal(summary.rangeY, 0);
});

test("舞台比素材小：按 cover 缩放，位移跟着缩", () => {
  const n = 100;
  const { motion } = buildClipMotion({
    xy: line(n), visible: Array(n).fill(true),
    media: MEDIA, stage: { width: 960, height: 540 }, // 正好一半
    card: { start: 0, end: 10 },
    clipOfMedia: { start: 0, mediaOffset: 0 },
    pointIndex: 0, whenHidden: "hold",
  });
  assert.equal(motion.offsets[1][0], 5, "素材位移 10 → 舞台位移 5");
});

test("卡片只压在素材中间一截：轨迹要从对应的那一帧切起", () => {
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

test("卡片开头目标正被挡：锚点要取第一个可见帧", () => {
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

test("素材缺分辨率或时长要直接报错，不能悄悄产出错的轨迹", () => {
  const base = {
    xy: line(10), visible: Array(10).fill(true), stage: STAGE,
    card: { start: 0, end: 1 }, clipOfMedia: { start: 0, mediaOffset: 0 },
    pointIndex: 0, whenHidden: "hold",
  };
  assert.throws(
    () => buildClipMotion({ ...base, media: { ...MEDIA, duration: 0 } }), /时长/);
  assert.throws(
    () => buildClipMotion({ ...base, media: { ...MEDIA, width: 0 } }), /分辨率/);
});

// ── motionAt ──────────────────────────────────────────────────────────

const M = {
  mediaId: "m1", pointIndex: 0,
  offsets: [[0, 0], [10, 0], [20, 0], [30, 0]],
  visible: [true, true, false, true],
  frameStep: 0.1,
  whenHidden: "hold",
};

test("两帧之间线性插值", () => {
  const a = motionAt(M, 0.15); // 第 1 帧和第 2 帧正中间
  assert.ok(Math.abs(a.dx - 15) < 1e-6, `插值结果 ${a.dx}`);
});

test("hold：目标不可见时停在最后一次看见的位置", () => {
  const a = motionAt(M, 0.2); // 第 2 帧，不可见
  assert.equal(a.visible, false);
  assert.equal(a.dx, 10, "该停在第 1 帧的位置，而不是用第 2 帧那个外推值");
});

test("超出轨迹末尾要夹住，不能跳回原点或外推出画面", () => {
  const a = motionAt(M, 99);
  assert.equal(a.dx, 30);
  const b = motionAt(M, -5);
  assert.equal(b.dx, 0);
});

test("空轨迹不崩", () => {
  const a = motionAt({ ...M, offsets: [], visible: [] }, 1);
  assert.deepEqual([a.dx, a.dy], [0, 0]);
});
