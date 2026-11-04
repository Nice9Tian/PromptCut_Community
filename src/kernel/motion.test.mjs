/**
 * Pure logic unit tests for motion tracking. Run: node --test src/kernel/motion.test.mjs
 *
 * This guards against a particularly insidious bug: the card **is indeed moving**, but tracking
 * the wrong thing. Time out of sync (card placed mid-asset, asset carries its own mediaOffset),
 * coordinates unconverted (asset 1920 wide, stage 1280 wide), or anchor chosen on an occluded
 * frame: if any of the three is wrong, the preview just shows "a card moving slowly", making it
 * impossible to tell that it is tracking another moment or a different scale.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildClipMotion, motionAt } from "./motion.ts";

/** Create a straight-line trajectory that moves right by 10 asset pixels per frame */
function line(n, { x0 = 100, y0 = 50, dx = 10, dy = 0 } = {}) {
  return Array.from({ length: n }, (_, i) => [x0 + i * dx, y0 + i * dy]);
}

const MEDIA = { id: "m1", width: 1920, height: 1080, duration: 10 };
const STAGE = { width: 1920, height: 1080 };

test("A card covers the whole media: displacement accumulates frame by frame, the anchor resets to zero", () => {
  const n = 100; // 10 seconds / 100 frames → frameStep 0.1
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
    media: MEDIA, stage: { width: 960, height: 540 }, // Exactly half
    card: { start: 0, end: 10 },
    clipOfMedia: { start: 0, mediaOffset: 0 },
    pointIndex: 0, whenHidden: "hold",
  });
  assert.equal(motion.offsets[1][0], 5, "Media displacement 10 → stage displacement 5");
});

test("A card covers only a middle section of the media: the trajectory must be cut starting from the corresponding frame", () => {
  const n = 100; // frameStep 0.1s
  // Media clip starts playing at timeline 2s, and plays from 3s into the asset
  // Card placed at timeline 5s → asset time 3 + (5 - 2) = 6s → frame 60
  const { motion } = buildClipMotion({
    xy: line(n), visible: Array(n).fill(true),
    media: MEDIA, stage: STAGE,
    card: { start: 5, end: 6 },
    clipOfMedia: { start: 2, mediaOffset: 3 },
    pointIndex: 0, whenHidden: "hold",
  });

  // Slice start is frame 60, displacement zeroed relative to it; after one second (frame 70)
  // it should have moved 10 frames × 10px
  assert.deepEqual(motion.offsets[0], [0, 0]);
  assert.equal(motion.offsets[10][0], 100);
  // Take only 1 second + 1 frame
  assert.equal(motion.offsets.length, Math.ceil(1 / 0.1) + 1);
});

test("The target is blocked at the start of the card: the anchor must be taken from the first visible frame", () => {
  const n = 50;
  const visible = Array(n).fill(true);
  for (let i = 0; i < 5; i++) visible[i] = false; // First 5 frames are invisible

  const { motion } = buildClipMotion({
    xy: line(n), visible,
    media: { ...MEDIA, duration: 5 }, stage: STAGE,
    card: { start: 0, end: 5 },
    clipOfMedia: { start: 0, mediaOffset: 0 },
    pointIndex: 0, whenHidden: "hold",
  });

  // Anchor is frame 5 (x=150), so frame 5 displacement is 0 and frame 0 is negative
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
  const a = motionAt(M, 0.15); // Right between frame 1 and frame 2
  assert.ok(Math.abs(a.dx - 15) < 1e-6, `Interpolation result ${a.dx}`);
});

test("hold: when the target is not visible, stay at the last position where it was seen", () => {
  const a = motionAt(M, 0.2); // Frame 2, invisible
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
