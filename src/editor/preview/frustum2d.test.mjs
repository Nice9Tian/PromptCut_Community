/**
 * 「2D 视角框」的几何。跑:node --test src/editor/preview/frustum2d.test.mjs
 *
 * 要钉两样东西:
 *   - **形状**:它必须是一个尖在相机、底在画幅的四角锥,而不是几条戳出去的平行线;
 *   - **朝向**:y 翻没翻、相机在 +z 还是 -z。写反了不报错,只是框和卡对不上,
 *     而 3D 页正是靠这个框判断"哪边是正面",框自己是反的就全乱了。
 *
 * 判据不是把公式再抄一遍,而是拿 space3d 的 stageToWorld / cameraFor 当基准。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { frustum2d } from "./frustum2d.ts";
import { cameraFor, stageToWorld, perspectivePx, DEFAULT_FOV_DEG } from "../../kernel/space3d.ts";

const STAGE = { width: 1920, height: 1080 };
/** positions 每 6 个数一条线,拆回点对好断言 */
const segments = (f) => {
  const out = [];
  for (let i = 0; i < f.positions.length; i += 6) out.push([f.positions.slice(i, i + 3), f.positions.slice(i + 3, i + 6)]);
  return out;
};
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

test("The four corners of the aspect-ratio frame are the four stage corners, and match stageToWorld value by value", () => {
  const f = frustum2d(STAGE, 40);
  assert.deepEqual(f.corners[0], stageToWorld({ x: 0, y: 0 }, STAGE), "Top left");
  assert.deepEqual(f.corners[1], stageToWorld({ x: 1920, y: 0 }, STAGE), "Top right");
  assert.deepEqual(f.corners[2], stageToWorld({ x: 1920, y: 1080 }, STAGE), "Bottom right");
  assert.deepEqual(f.corners[3], stageToWorld({ x: 0, y: 1080 }, STAGE), "Bottom left");
});

test("y is flipped: the stage \"up\" has a positive y in world coordinates", () => {
  const f = frustum2d(STAGE, 40);
  const [tl, tr, br, bl] = f.corners;
  assert.equal(tl[1], 540, "The y of the top-left corner should be +H/2");
  assert.equal(bl[1], -540, "The y of the bottom-left corner should be -H/2");
  assert.ok(tl[1] > bl[1], "The top edge must be above the bottom edge: if reversed, the whole frame is upside down");
  assert.equal(tl[0], -960, "The x of the left side is negative");
  assert.equal(tr[0], 960, "The x of the right side is positive");
  for (const c of f.corners) assert.equal(c[2], 0, "The aspect-ratio frame is at z=0");
  assert.deepEqual([tr[1], br[1]], [540, -540]);
});

test("The camera is on +z, and the distance matches what space3d derives", () => {
  const f = frustum2d(STAGE, 40);
  assert.deepEqual(f.apex, cameraFor(STAGE, 40).position);
  assert.ok(f.apex[2] > 0, "The camera must be on +z (the side facing the viewer); written as negative, the camera would face away from the screen");
  assert.equal(f.apex[2], perspectivePx(STAGE, 40));
  assert.deepEqual([f.apex[0], f.apex[1]], [0, 0], "The camera is directly in front of the center of the picture");
});

test("The shape is a rectangular pyramid: four base edges + four lateral edges, all converging at the camera", () => {
  const f = frustum2d(STAGE, 40);
  const segs = segments(f);
  assert.equal(segs.length, 8, "4 base edges + 4 lateral edges");
  assert.equal(f.positions.length, 8 * 6);

  // 底面:首尾相接绕一圈,而且全在 z=0
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(segs[i][0], f.corners[i]);
    assert.deepEqual(segs[i][1], f.corners[(i + 1) % 4]);
    assert.equal(segs[i][0][2], 0);
  }
  // 四条棱:都从相机出发,分别落到四个角
  const edges = segs.slice(4);
  for (const [a] of edges) assert.deepEqual(a, f.apex, "Every lateral edge should start from the apex");
  assert.deepEqual(edges.map(([, b]) => b), f.corners, "The four lateral edges land exactly on the four corners, with no duplicates or omissions");
});

test("There **must not** be parallel lines: that is what was drawn before when \"no perspective camera\" was treated as orthographic, and it is not a pyramid", () => {
  for (const fov of [undefined, null, 40, NaN, 0]) {
    const f = frustum2d(STAGE, fov);
    const edges = segments(f).slice(4);
    const dirs = edges.map(([a, b]) => [b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    // 四条棱两两不平行:锥的棱必然是发散的
    for (let i = 0; i < dirs.length; i++) {
      for (let j = i + 1; j < dirs.length; j++) {
        const cross = [
          dirs[i][1] * dirs[j][2] - dirs[i][2] * dirs[j][1],
          dirs[i][2] * dirs[j][0] - dirs[i][0] * dirs[j][2],
          dirs[i][0] * dirs[j][1] - dirs[i][1] * dirs[j][0],
        ];
        assert.ok(Math.hypot(...cross) > 1e-6, `At fov=${fov}, lateral edges ${i} and ${j} are parallel: that is not a pyramid`);
      }
    }
    // 而且都指向 -z(从相机看向屏幕)
    for (const d of dirs) assert.ok(d[2] < 0, "The lateral edges should go from the camera toward the screen");
  }
});

test("When fov is not set, the default 40° is used, consistent with how Scene3DView picks the initial camera position", () => {
  const def = frustum2d(STAGE, undefined);
  assert.deepEqual(def.apex, cameraFor(STAGE, DEFAULT_FOV_DEG).position);
  assert.deepEqual(frustum2d(STAGE, null).apex, def.apex, "null also counts as not set");
  assert.deepEqual(frustum2d(STAGE, NaN).apex, def.apex, "A non-number also counts as not set");
  /*
   * 这条是防一个具体的坑:clampFov(null) 会把 null 当成 0,再夹到下限 5° ——
   * 那是极窄的长焦,相机被推到十几倍画幅远,锥细得像根针,看着就像四条平行线。
   */
  assert.notDeepEqual(def.apex, cameraFor(STAGE, 5).position, "null must not be treated as 0 and then clamped to 5°");
  assert.ok(def.apex[2] < perspectivePx(STAGE, 5) / 2, "The default camera position should be at a normal distance, not as far as a telephoto");
});

test("The larger the field of view, the closer the camera and the fatter the pyramid: it is the same quantity as CSS perspective", () => {
  const near = frustum2d(STAGE, 90).apex[2];
  const far = frustum2d(STAGE, 20).apex[2];
  assert.ok(near < far, `90° should be closer than 20°, got ${near} vs ${far}`);
  assert.equal(far, perspectivePx(STAGE, 20));
});

test("All eight lines belong to the same pyramid: no point other than the camera and the four corners should appear", () => {
  const f = frustum2d(STAGE, 40);
  const known = [f.apex, ...f.corners];
  for (const [a, b] of segments(f)) {
    for (const p of [a, b]) {
      assert.ok(known.some((k) => same(k, p)), `A point appeared that is neither the camera nor a corner of the aspect-ratio frame: ${p}`);
    }
  }
});

test("Portrait is also correct: the pyramid follows the aspect-ratio frame instead of being hard-coded to 16:9", () => {
  const vertical = { width: 1080, height: 1920 };
  const f = frustum2d(vertical, 40);
  assert.equal(f.corners[0][0], -540);
  assert.equal(f.corners[0][1], 960);
  assert.equal(f.apex[2], perspectivePx(vertical, 40), "The camera distance for portrait is derived from its own height");
});

test("NaN must not be computed even when the aspect-ratio frame degenerates to 0", () => {
  for (const s of [{ width: 0, height: 0 }, { width: -5, height: 10 }]) {
    const f = frustum2d(s, 40);
    for (const v of f.positions) assert.ok(Number.isFinite(v), `Computed ${v}`);
    assert.ok(Number.isFinite(f.apex[2]));
  }
});
