/**
 * 3D 视图摆板子的正负号。跑:node --test src/editor/preview/place3d.test.mjs
 *
 * 这是全项目最容易写反、又最难发现的一处:CSS 的 y 轴朝下、three 的朝上,
 * 于是绕 x 和绕 z 要取反,而绕 y **不用**。写反了不报错,画面只是"看着别扭"。
 *
 * 判据不是照公式再算一遍,而是拿 `kernel/layout.ts` 的 `visualBox` 当基准 ——
 * 那个函数已经和真 Chrome 逐位对过账(见 space3d.test.mjs 里那条"和真浏览器对账")。
 * 所以只要 three 这边的板子投影出来和它一致,就说明 3D 视图和 2D 画面朝向相同。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { placeClip3D } from "./place3d.ts";
import { visualBox } from "../../kernel/layout.ts";
import { cameraFor } from "../../kernel/space3d.ts";

const STAGE = { width: 1920, height: 1080 };
const FOV = 40;

/** 按 Scene3DView 的那串 group 摆好,再用同一台相机把四角投影回舞台像素 */
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
  // 绕 x 和绕 z 要取反 —— 这两条写反了上面那条对账测试会红,这里再单独钉一次意图
  const tilt = placeClip3D({ x: 0, y: 0, rotateX: 30 }, STAGE);
  assert.ok(tilt.tiltX < 0, "Rotation about x must be negated (CSS y points down, three points up)");
  const roll = placeClip3D({ x: 0, y: 0, rotate: 30 }, STAGE);
  assert.ok(roll.rollZ < 0, "Rotation about z must be negated");
});
