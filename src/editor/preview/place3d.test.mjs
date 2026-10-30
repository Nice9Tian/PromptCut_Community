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
  ["纯平面:rotate + scale", { x: 700, y: 400, w: 600, h: 300, anchor: [0.5, 0.5], rotate: 20, scale: 1.3 }],
  ["rotateY 正值(右边往里转)", { x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], rotateY: 35 }],
  ["rotateY 负值", { x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], rotateY: -35 }],
  ["rotateX 正值(顶边往里倒)", { x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], rotateX: 30 }],
  ["rotateX 负值", { x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], rotateX: -30 }],
  ["translateZ 朝观众", { x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], translateZ: 400 }],
  ["translateZ 往里", { x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], translateZ: -400 }],
  ["三项齐上,而且锚点不在中心", { x: 400, y: 300, w: 700, h: 400, anchor: [0, 0], rotateX: 12, rotateY: -28, translateZ: 180, scale: 0.9, rotate: -8 }],
  ["没有 frame(铺满舞台)", undefined],
];

test("3D 视图的板子和 2D 的 CSS 投影朝向一致(逐条对四条边)", () => {
  for (const [label, frame] of CASES) {
    const vb = visualBox(frame, STAGE, FOV);
    const th = projectViaThree(frame);
    const d = Math.max(
      Math.abs(vb.left - th.left),
      Math.abs(vb.top - th.top),
      Math.abs(vb.left + vb.width - th.right),
      Math.abs(vb.top + vb.height - th.bottom),
    );
    assert.ok(d < 0.5, `${label}:两边差了 ${d.toFixed(2)}px\n  CSS   ${JSON.stringify(vb)}\n  three ${JSON.stringify(th)}`);
  }
});

test("正负号是真的分得开:rotateY 的正负给出不同的方向", () => {
  const plus = placeClip3D({ x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], rotateY: 35 }, STAGE);
  const minus = placeClip3D({ x: 960, y: 540, w: 800, h: 450, anchor: [0.5, 0.5], rotateY: -35 }, STAGE);
  assert.ok(plus.spinY > 0 && minus.spinY < 0, "绕 y 和 CSS 同号");
  // 绕 x 和绕 z 要取反 —— 这两条写反了上面那条对账测试会红,这里再单独钉一次意图
  const tilt = placeClip3D({ x: 0, y: 0, rotateX: 30 }, STAGE);
  assert.ok(tilt.tiltX < 0, "绕 x 要取反(CSS 的 y 朝下,three 朝上)");
  const roll = placeClip3D({ x: 0, y: 0, rotate: 30 }, STAGE);
  assert.ok(roll.rollZ < 0, "绕 z 要取反");
});
