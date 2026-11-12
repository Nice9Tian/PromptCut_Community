// node --test src/kernel/space3d.test.mjs: sole gateway for 3D conversion
import test from "node:test";
import assert from "node:assert/strict";

import {
  cameraFor, perspectivePx, fovForDistance, clampFov,
  stageToWorld, worldToStage, projectStage,
  BOARD_NEAR_RATIO, boardNearDistance, boardWorldCorners, boardCameraDepthRange, isBoardBehindCamera,
  DEFAULT_FOV_DEG,
} from "./space3d.ts";
import { frameCss } from "./layout.ts";

const HD = { width: 1920, height: 1080 };
const VERT = { width: 1080, height: 1920 };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("d is derived from fov: once 1 world unit = 1 stage pixel is pinned down, the two are locked together", () => {
  // d = H / (2·tan(fov/2))
  near(cameraFor(HD, 50).distance, 1080 / (2 * Math.tan((50 * Math.PI) / 360)), 1e-9);
  assert.equal(Math.round(cameraFor(HD, 50).distance), 1158);
  assert.equal(Math.round(cameraFor(HD, 40).distance), 1484);
  assert.equal(Math.round(cameraFor(HD, 30).distance), 2015);
});

test("d=100 gives a fisheye: this number looks reasonable but is unusable in practice, so only fov is exposed", () => {
  assert.equal(Math.round(fovForDistance(HD, 100)), 159);
});

test("d and fov are inverse operations of each other", () => {
  for (const fov of [10, 25, 40, 55, 90]) {
    near(fovForDistance(HD, cameraFor(HD, fov).distance), fov, 1e-9);
  }
});

test("Switching the aspect ratio in portrait changes d for the same fov: this is exactly why d cannot be entered directly", () => {
  assert.notEqual(cameraFor(HD, 40).distance, cameraFor(VERT, 40).distance);
  assert.equal(Math.round(cameraFor(VERT, 40).distance), 2638);
});

test("perspectivePx is the camera distance: CSS and three.js use the same number", () => {
  assert.equal(perspectivePx(HD, 40), cameraFor(HD, 40).distance);
});

test("The camera is on +z, looking at the origin", () => {
  const c = cameraFor(HD, 40);
  assert.deepEqual(c.position, [0, 0, c.distance]);
  assert.ok(c.position[2] > 0, "Written as -d, either the camera faces away from the screen or the sign of z is opposite to CSS");
});

test("An omitted or out-of-range fov is clamped back into range", () => {
  assert.equal(clampFov(undefined), DEFAULT_FOV_DEG);
  assert.equal(clampFov(NaN), DEFAULT_FOV_DEG);
  assert.equal(clampFov("abc"), DEFAULT_FOV_DEG);
  assert.equal(clampFov(0), 5);
  assert.equal(clampFov(999), 120);
});

test("Stage → world: the origin moves to the center, y is flipped", () => {
  assert.deepEqual(stageToWorld({ x: 960, y: 540 }, HD), [0, 0, 0], "The center of the frame is the world origin");
  assert.deepEqual(stageToWorld({ x: 0, y: 0 }, HD), [-960, 540, 0], "Top-left corner: x negative, y **positive**");
  assert.deepEqual(stageToWorld({ x: 1920, y: 1080 }, HD), [960, -540, 0], "Bottom-right corner: y negative");
});

test("z passes through unchanged, positive toward the viewer (consistent with CSS translateZ)", () => {
  assert.deepEqual(stageToWorld({ x: 960, y: 540, z: 200 }, HD), [0, 0, 200]);
});

test("A round trip between stage and world loses no precision", () => {
  for (const p of [
    { x: 0, y: 0, z: 0 },
    { x: 1920, y: 1080, z: -300 },
    { x: 123.5, y: 456.25, z: 78.125 },
    { x: 960, y: 540, z: 0 },
  ]) {
    assert.deepEqual(worldToStage(stageToWorld(p, HD), HD), p);
  }
});

test("Projection: a point at z=0 does not move and its scale is 1: turning on 3D mode must not suddenly change the picture", () => {
  const r = projectStage({ x: 300, y: 200, z: 0 }, HD, 40);
  assert.deepEqual(r, { x: 300, y: 200, scale: 1 });
});

test("Projection: pushing toward the viewer makes it larger, pushing inward makes it smaller, relative to the center of the frame", () => {
  const nearer = projectStage({ x: 300, y: 200, z: 400 }, HD, 40);
  const farther = projectStage({ x: 300, y: 200, z: -400 }, HD, 40);
  assert.ok(nearer.scale > 1, `The nearer one should scale up, got ${nearer.scale}`);
  assert.ok(farther.scale < 1, `The farther one should scale down, got ${farther.scale}`);
  // Center point does not move regardless of z value
  assert.deepEqual(projectStage({ x: 960, y: 540, z: 500 }, HD, 40), { x: 960, y: 540, scale: projectStage({ x: 960, y: 540, z: 500 }, HD, 40).scale });
});

test("Projection: returns null when the point is at or behind the camera, without deciding for the caller what to do", () => {
  const d = cameraFor(HD, 40).distance;
  assert.equal(projectStage({ x: 0, y: 0, z: d }, HD, 40), null);
  assert.equal(projectStage({ x: 0, y: 0, z: d + 1 }, HD, 40), null);
  assert.ok(projectStage({ x: 0, y: 0, z: d - 1 }, HD, 40));
});

/*
 * The numbers below are **measured back from real Chrome**, not recalculated from formulas.
 *
 * This chain has three stages: layout.ts builds transform string → browser applies perspective →
 * projectStage in space3d.ts predicts where it lands. If any stage in the middle changes, visuals
 * will not error, it will only "look slightly off". So we pin it down once using the browser as
 * baseline.
 *
 * Measurement method (ran a one-off probe under scripts, puppeteer + getBoundingClientRect):
 *   Stage 800×450, fov 40 (perspective 618.18px), card 200×120 anchor centered at (400,225),
 *   rotateY 35°.
 *   Measure center x and height of card left and right edges, aligned bit-for-bit with projectStage
 *   predictions, all four differences are 0.0000px.
 */
test("Reconcile with a real browser: the transform assembled by frameCss lands exactly where projectStage predicts", () => {
  const STAGE = { width: 800, height: 450 };
  const FOV = 40, W = 200, H = 120, CX = 400, CY = 225, THETA = 35;

  // Stage 1: layout.ts really concatenated the 3D items, and perspective values match
  const css = frameCss({ x: CX, y: CY, w: W, h: H, anchor: [0.5, 0.5], rotateY: THETA }, STAGE);
  assert.equal(css.transform, "rotateY(35deg)");
  assert.equal(css.transformStyle, "preserve-3d");
  near(perspectivePx(STAGE, FOV), 618.18242, 1e-4);

  /*
   * Stage 3: rotateY(θ) maps the two local edges x = ∓W/2 to world (∓W/2·cosθ, 0, ±W/2·sinθ):
   * when θ is positive, **the left side comes toward the viewer** (z is positive), and the right side
   * goes inward. This sign was empirically verified; do not change it by intuition.
   */
  const rad = (THETA * Math.PI) / 180;
  const edge = (sign) => projectStage(
    { x: CX + sign * (W / 2) * Math.cos(rad), y: CY, z: -sign * (W / 2) * Math.sin(rad) },
    STAGE, FOV,
  );
  const L = edge(-1), R = edge(+1);

  // Four numbers measured back from the browser
  near(L.x, 309.70702, 1e-4);
  near(H * L.scale, 132.27285, 1e-4);
  near(R.x, 474.96008, 1e-4);
  near(H * R.scale, 109.81124, 1e-4);

  // The nearer edge must be taller: this is the criterion for \"whether perspective is present\"
  assert.ok(L.scale > 1 && R.scale < 1, `Left should be near and right far, got ${L.scale} / ${R.scale}`);
});

test("boardNearDistance scales with camera distance while preserving cameraFor().near === 1", () => {
  const camHd = cameraFor(HD, 40);
  const camVert = cameraFor(VERT, 40);
  assert.equal(camHd.near, 1);
  near(boardNearDistance(HD, 40), camHd.distance * BOARD_NEAR_RATIO, 1e-9);
  near(boardNearDistance(VERT, 40), camVert.distance * BOARD_NEAR_RATIO, 1e-9);
  assert.ok(boardNearDistance(VERT, 40) > boardNearDistance(HD, 40));
});

test("isBoardBehindCamera culls boards at or past the near plane and behind the camera", () => {
  const d = cameraFor(HD, 40).distance;
  const n = boardNearDistance(HD, 40);
  // Well in front of the camera and near plane -> visible
  assert.equal(isBoardBehindCamera({ x: 960, y: 540, w: 400, h: 225, anchor: [0.5, 0.5], translateZ: 0 }, HD, 40), false);
  assert.equal(isBoardBehindCamera({ x: 960, y: 540, w: 400, h: 225, anchor: [0.5, 0.5], translateZ: 600 }, HD, 40), false);
  assert.equal(isBoardBehindCamera({ x: 960, y: 540, w: 400, h: 225, anchor: [0.5, 0.5], translateZ: d - n - 1 }, HD, 40), false);
  // Exactly on the near plane, on the camera plane, and behind the camera -> culled
  assert.equal(isBoardBehindCamera({ x: 960, y: 540, w: 400, h: 225, anchor: [0.5, 0.5], translateZ: d - n }, HD, 40), true);
  assert.equal(isBoardBehindCamera({ x: 960, y: 540, w: 400, h: 225, anchor: [0.5, 0.5], translateZ: d }, HD, 40), true);
  assert.equal(isBoardBehindCamera({ x: 960, y: 540, w: 400, h: 225, anchor: [0.5, 0.5], translateZ: d + 250 }, HD, 40), true);
});

test("Tilted board straddling the near plane stays visible until all corners pass behind near", () => {
  const d = cameraFor(HD, 40).distance;
  const n = boardNearDistance(HD, 40);
  // Center is at the camera plane (z = d), but wide rotateY(60deg) puts the far edge well deeper than d - n
  const straddling = { x: 960, y: 540, w: 1200, h: 400, anchor: [0.5, 0.5], rotateY: 60, translateZ: d };
  const range1 = boardCameraDepthRange(straddling, HD, 40);
  assert.ok(range1.minDepth < 0 && range1.maxDepth > n);
  assert.equal(isBoardBehindCamera(straddling, HD, 40), false);

  // Pushing further past the camera until even the far edge crosses near -> culled
  const fullyPast = { ...straddling, translateZ: d + 800 };
  const range2 = boardCameraDepthRange(fullyPast, HD, 40);
  assert.ok(range2.maxDepth <= n);
  assert.equal(isBoardBehindCamera(fullyPast, HD, 40), true);
});

test("isBoardBehindCamera respects custom walk-through / orbited CameraPose3D and cropped subBox", () => {
  const n = boardNearDistance(HD, 40);
  // Camera walked forward past z=0 to z=-300 looking toward -z: a board at z=0 is now behind the camera
  const walkedPose = { position: [0, 0, -300], forward: [0, 0, -1], near: n };
  assert.equal(isBoardBehindCamera({ translateZ: 0 }, HD, 40, walkedPose), true);
  assert.equal(isBoardBehindCamera({ translateZ: -700 }, HD, 40, walkedPose), false);

  // Cropped subBox restricts depth range to the opaque content region of a tilted full-stage board
  const tiltedFull = { x: 960, y: 540, w: 1920, h: 1080, anchor: [0.5, 0.5], rotateY: 45, translateZ: 1100 };
  // Left edge (subBox x in [0, 0.1]) is swung toward +z (closer than near), while right edge (x in [0.85, 0.95]) is swung inward
  assert.equal(isBoardBehindCamera(tiltedFull, HD, 40, undefined, { x: 0.0, y: 0.4, w: 0.1, h: 0.2 }), true);
  assert.equal(isBoardBehindCamera(tiltedFull, HD, 40, undefined, { x: 0.85, y: 0.4, w: 0.1, h: 0.2 }), false);

  const corners = boardWorldCorners(tiltedFull, HD, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  assert.equal(corners.length, 4);
});
