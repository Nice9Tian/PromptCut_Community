/**
 * Signs for board placement in 3D view. Run: node --test src/editor/preview/place3d.test.mjs
 *
 * This is the easiest place in the entire project to invert, and the hardest to discover:
 * CSS y-axis points down while three's points up, so rotations around x and z must be inverted,
 * while rotation around y **does not**. Inverting them throws no error; the image just "looks off".
 *
 * The criterion is not calculating by formula again, but using `visualBox` in `kernel/layout.ts` as
 * the baseline: that function has already reconciled bit-for-bit with real Chrome (see the test
 * "Reconcile with real browser" in space3d.test.mjs). As long as boards projected from three match
 * it, 3D view and 2D frame have the same orientation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { placeClip3D, sortBoardsByDepth } from "./place3d.ts";
import { visualBox } from "../../kernel/layout.ts";
import { boardWorldCorners, cameraFor } from "../../kernel/space3d.ts";

const STAGE = { width: 1920, height: 1080 };
const FOV = 40;

/**
 * Arrange according to Scene3DView's chain of groups, then project the four corners back to
 * stage pixels with the same camera
 */
function projectViaThree(frame) {
  const cam = cameraFor(STAGE, FOV);
  const camera = new THREE.PerspectiveCamera(cam.fovDeg, STAGE.width / STAGE.height, cam.near, cam.far);
  camera.position.set(...cam.position);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const pl = placeClip3D(frame, STAGE);
  const pivot = new THREE.Group();
  pivot.position.set(...pl.pivot);
  const tilt = new THREE.Group();
  tilt.rotation.x = pl.tiltX;
  tilt.position.z = pl.translateZ;
  const spin = new THREE.Group();
  spin.rotation.y = pl.spinY;
  const inner = new THREE.Group();
  inner.rotation.z = pl.rollZ;
  inner.scale.setScalar(pl.scale);
  const mesh = new THREE.Object3D();
  mesh.position.set(...pl.meshOffset);
  inner.add(mesh); spin.add(inner); tilt.add(spin); pivot.add(tilt);
  const scene = new THREE.Scene();
  scene.add(pivot);
  scene.updateMatrixWorld(true);

  const hw = pl.size.width / 2;
  const hh = pl.size.height / 2;
  const pts = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => {
    const v = new THREE.Vector3(sx * hw, sy * hh, 0);
    mesh.localToWorld(v);
    v.project(camera);
    return { x: ((v.x + 1) / 2) * STAGE.width, y: ((1 - v.y) / 2) * STAGE.height };
  });
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

const CASES = [
  ["Flat only: rotate + scale", { x: 700, y: 400, w: 600, h: 300, anchor: [0.5, 0.5], rotate: 20, scale: 1.3 }],
  ["rotateY positive (right side turns inward)", { x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], rotateY: 35 }],
  ["rotateY negative", { x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], rotateY: -35 }],
  ["rotateX positive (top edge tilts inward)", { x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], rotateX: 30 }],
  ["rotateX negative", { x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], rotateX: -30 }],
  ["translateZ toward the viewer", { x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], translateZ: 400 }],
  ["translateZ inward", { x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], translateZ: -400 }],
  ["All three applied together, and the anchor is not at the center", { x: 400, y: 300, w: 700, h: 400, anchor: [0, 0], rotateX: 12, rotateY: -28, translateZ: 180, scale: 0.9, rotate: -8 }],
  ["No frame (fills the stage)", undefined],
];

test("The board in the 3D view has the same orientation as the 2D CSS projection (compared edge by edge across all four edges)", () => {
  for (const [label, frame] of CASES) {
    const vb = visualBox(frame, STAGE, FOV);
    const th = projectViaThree(frame);
    const d = Math.max(
      Math.abs(vb.left - th.left),
      Math.abs(vb.top - th.top),
      Math.abs(vb.left + vb.width - th.right),
      Math.abs(vb.top + vb.height - th.bottom),
    );
    assert.ok(d < 0.5, `${label}: the two sides differ by ${d.toFixed(2)}px\n  CSS   ${JSON.stringify(vb)}\n  three ${JSON.stringify(th)}`);
  }
});

test("The sign is really distinguishable: positive and negative rotateY give different directions", () => {
  const plus = placeClip3D({ x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], rotateY: 35 }, STAGE);
  const minus = placeClip3D({ x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], rotateY: -35 }, STAGE);
  assert.ok(plus.spinY > 0 && minus.spinY < 0, "Rotation about y has the same sign as CSS");
  // Rotations around x and z must be inverted: if inverted, the reconciliation test above turns
  // red; pinning down the intent separately here once more
  const tilt = placeClip3D({ x: 0, y: 0, rotateX: 30 }, STAGE);
  assert.ok(tilt.tiltX < 0, "Rotation about x must be negated (CSS y points down, three points up)");
  const roll = placeClip3D({ x: 0, y: 0, rotate: 30 }, STAGE);
  assert.ok(roll.rollZ < 0, "Rotation about z must be negated");
});

test("boardWorldCorners matches Three.js group hierarchy corner-by-corner (including cropped subBox)", () => {
  for (const [label, frame] of CASES) {
    const pl = placeClip3D(frame, STAGE);
    const pivot = new THREE.Group();
    pivot.position.set(...pl.pivot);
    const tilt = new THREE.Group();
    tilt.rotation.x = pl.tiltX;
    tilt.position.z = pl.translateZ;
    const spin = new THREE.Group();
    spin.rotation.y = pl.spinY;
    const inner = new THREE.Group();
    inner.rotation.z = pl.rollZ;
    inner.scale.setScalar(pl.scale);
    const mesh = new THREE.Object3D();
    mesh.position.set(...pl.meshOffset);
    inner.add(mesh); spin.add(inner); tilt.add(spin); pivot.add(tilt);
    const scene = new THREE.Scene();
    scene.add(pivot);
    scene.updateMatrixWorld(true);

    const hw = pl.size.width / 2;
    const hh = pl.size.height / 2;
    // Top-left, top-right, bottom-right, bottom-left in Three.js plane coordinates (y up)
    const threeCorners = [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]].map(([lx, ly]) => {
      const v = new THREE.Vector3(lx, ly, 0);
      mesh.localToWorld(v);
      return [v.x, v.y, v.z];
    });
    const kernelCorners = boardWorldCorners(frame, STAGE);
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < 3; k++) {
        assert.ok(
          Math.abs(threeCorners[i][k] - kernelCorners[i][k]) < 1e-6,
          `${label} corner ${i} axis ${k}: three=${threeCorners[i][k]} vs kernel=${kernelCorners[i][k]}`,
        );
      }
    }
  }
});

test("sortBoardsByDepth orders overlapping translucent boards by camera-space depth, independent of trackOrder", () => {
  // Bottom track (trackOrder 0) vs top track (trackOrder 1)
  const frontBottomBackTop = sortBoardsByDepth(
    [
      { id: "bottom", frame: { x: 960, y: 540, w: 600, h: 400, anchor: [0.5, 0.5], translateZ: 300 }, trackOrder: 0 },
      { id: "top", frame: { x: 960, y: 540, w: 600, h: 400, anchor: [0.5, 0.5], translateZ: -200 }, trackOrder: 1 },
    ],
    STAGE,
    FOV,
  );
  assert.deepEqual(frontBottomBackTop.map((b) => b.id), ["top", "bottom"]);
  assert.ok(
    frontBottomBackTop.find((b) => b.id === "bottom").renderOrder >
      frontBottomBackTop.find((b) => b.id === "top").renderOrder,
    "Closer board on bottom track must draw after (on top of) farther board on top track",
  );

  // Swap depths without changing trackOrder -> draw order flips immediately
  const swapped = sortBoardsByDepth(
    [
      { id: "bottom", frame: { x: 960, y: 540, w: 600, h: 400, anchor: [0.5, 0.5], translateZ: -200 }, trackOrder: 0 },
      { id: "top", frame: { x: 960, y: 540, w: 600, h: 400, anchor: [0.5, 0.5], translateZ: 300 }, trackOrder: 1 },
    ],
    STAGE,
    FOV,
  );
  assert.deepEqual(swapped.map((b) => b.id), ["bottom", "top"]);
  assert.ok(
    swapped.find((b) => b.id === "top").renderOrder >
      swapped.find((b) => b.id === "bottom").renderOrder,
  );
});

test("sortBoardsByDepth breaks equal-depth ties by trackOrder ascending (higher track stays in front)", () => {
  const coplanar = sortBoardsByDepth(
    [
      { id: "upperTrack", frame: { translateZ: 120 }, trackOrder: 2 },
      { id: "lowerTrack", frame: { translateZ: 120 }, trackOrder: 0 },
      { id: "midTrack", frame: { translateZ: 120 }, trackOrder: 1 },
    ],
    STAGE,
    FOV,
  );
  assert.deepEqual(coplanar.map((b) => b.id), ["lowerTrack", "midTrack", "upperTrack"]);
});

test("sortBoardsByDepth resolves tilted parallel planes accurately via plane separation and follows orbited camera pose", () => {
  // Two parallel planes tilted by rotateY: 45deg, separated by 40px along z, with opposite subBox crops so
  // the back plane's cropped center is actually closer in z than the front plane's cropped center, yet
  // wherever their rays overlap the front plane is strictly closer to the camera!
  const backPlane = {
    id: "backPlane",
    frame: { x: 960, y: 540, w: 1920, h: 1080, anchor: [0.5, 0.5], rotateY: 45, translateZ: 0 },
    subBox: { x: 0.1, y: 0.2, w: 0.55, h: 0.6 },
    trackOrder: 1,
  };
  const frontPlane = {
    id: "frontPlane",
    frame: { x: 960, y: 540, w: 1920, h: 1080, anchor: [0.5, 0.5], rotateY: 45, translateZ: 40 },
    subBox: { x: 0.35, y: 0.2, w: 0.55, h: 0.6 },
    trackOrder: 0,
  };
  const forwardView = sortBoardsByDepth([backPlane, frontPlane], STAGE, FOV);
  assert.deepEqual(forwardView.map((b) => b.id), ["backPlane", "frontPlane"]);

  // Orbiting behind the stage (looking from -z toward +z) flips which plane faces closer to the viewer
  const rearView = sortBoardsByDepth([backPlane, frontPlane], STAGE, FOV, {
    position: [0, 0, -1500],
    forward: [0, 0, 1],
  });
  assert.deepEqual(rearView.map((b) => b.id), ["frontPlane", "backPlane"]);
});
