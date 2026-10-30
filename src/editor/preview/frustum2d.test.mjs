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

test("画幅四角就是舞台四角,而且和 stageToWorld 逐值一致", () => {
  const f = frustum2d(STAGE, 40);
  assert.deepEqual(f.corners[0], stageToWorld({ x: 0, y: 0 }, STAGE), "左上");
  assert.deepEqual(f.corners[1], stageToWorld({ x: 1920, y: 0 }, STAGE), "右上");
  assert.deepEqual(f.corners[2], stageToWorld({ x: 1920, y: 1080 }, STAGE), "右下");
  assert.deepEqual(f.corners[3], stageToWorld({ x: 0, y: 1080 }, STAGE), "左下");
});

test("y 是翻过来的:舞台的「上」在世界坐标里 y 为正", () => {
  const f = frustum2d(STAGE, 40);
  const [tl, tr, br, bl] = f.corners;
  assert.equal(tl[1], 540, "左上角的 y 该是 +H/2");
  assert.equal(bl[1], -540, "左下角的 y 该是 -H/2");
  assert.ok(tl[1] > bl[1], "上边必须在下边上面 —— 反了整个框就是倒的");
  assert.equal(tl[0], -960, "左边 x 为负");
  assert.equal(tr[0], 960, "右边 x 为正");
  for (const c of f.corners) assert.equal(c[2], 0, "画幅框在 z=0");
  assert.deepEqual([tr[1], br[1]], [540, -540]);
});

test("相机在 +z,距离和 space3d 推的一致", () => {
  const f = frustum2d(STAGE, 40);
  assert.deepEqual(f.apex, cameraFor(STAGE, 40).position);
  assert.ok(f.apex[2] > 0, "相机必须在 +z(朝观众那一侧);写成负的相机就背对屏幕了");
  assert.equal(f.apex[2], perspectivePx(STAGE, 40));
  assert.deepEqual([f.apex[0], f.apex[1]], [0, 0], "相机在画面正中的正前方");
});

test("形状是一个四角锥:底面四条边 + 四条棱,全都汇到相机", () => {
  const f = frustum2d(STAGE, 40);
  const segs = segments(f);
  assert.equal(segs.length, 8, "4 条底边 + 4 条棱");
  assert.equal(f.positions.length, 8 * 6);

  // 底面:首尾相接绕一圈,而且全在 z=0
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(segs[i][0], f.corners[i]);
    assert.deepEqual(segs[i][1], f.corners[(i + 1) % 4]);
    assert.equal(segs[i][0][2], 0);
  }
  // 四条棱:都从相机出发,分别落到四个角
  const edges = segs.slice(4);
  for (const [a] of edges) assert.deepEqual(a, f.apex, "每条棱都该从锥尖出发");
  assert.deepEqual(edges.map(([, b]) => b), f.corners, "四条棱正好落在四个角上,不重不漏");
});

test("**不能**出现平行线 —— 那是以前把「没开透视相机」当正交画出来的,不是锥", () => {
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
        assert.ok(Math.hypot(...cross) > 1e-6, `fov=${fov} 时第 ${i}、${j} 条棱平行了 —— 那就不是锥`);
      }
    }
    // 而且都指向 -z(从相机看向屏幕)
    for (const d of dirs) assert.ok(d[2] < 0, "棱应该从相机朝屏幕去");
  }
});

test("没设 fov 就用默认的 40°,和 Scene3DView 挑初始机位的口径一致", () => {
  const def = frustum2d(STAGE, undefined);
  assert.deepEqual(def.apex, cameraFor(STAGE, DEFAULT_FOV_DEG).position);
  assert.deepEqual(frustum2d(STAGE, null).apex, def.apex, "null 也当没设");
  assert.deepEqual(frustum2d(STAGE, NaN).apex, def.apex, "非数也当没设");
  /*
   * 这条是防一个具体的坑:clampFov(null) 会把 null 当成 0,再夹到下限 5° ——
   * 那是极窄的长焦,相机被推到十几倍画幅远,锥细得像根针,看着就像四条平行线。
   */
  assert.notDeepEqual(def.apex, cameraFor(STAGE, 5).position, "null 不能被当成 0 再夹成 5°");
  assert.ok(def.apex[2] < perspectivePx(STAGE, 5) / 2, "默认机位该在正常距离上,不是长焦那么远");
});

test("视场角越大相机越近,锥就越胖 —— 和 CSS 的 perspective 是同一个量", () => {
  const near = frustum2d(STAGE, 90).apex[2];
  const far = frustum2d(STAGE, 20).apex[2];
  assert.ok(near < far, `90° 该比 20° 近,实得 ${near} vs ${far}`);
  assert.equal(far, perspectivePx(STAGE, 20));
});

test("八条线全是同一个锥的:除了相机和四个角,不该冒出别的点", () => {
  const f = frustum2d(STAGE, 40);
  const known = [f.apex, ...f.corners];
  for (const [a, b] of segments(f)) {
    for (const p of [a, b]) {
      assert.ok(known.some((k) => same(k, p)), `冒出了一个既不是相机也不是画幅角的点:${p}`);
    }
  }
});

test("竖屏画幅也对:锥跟着画幅走,不是写死 16:9", () => {
  const vertical = { width: 1080, height: 1920 };
  const f = frustum2d(vertical, 40);
  assert.equal(f.corners[0][0], -540);
  assert.equal(f.corners[0][1], 960);
  assert.equal(f.apex[2], perspectivePx(vertical, 40), "竖屏的相机距离由它自己的高推");
});

test("画幅退化成 0 也不能算出 NaN", () => {
  for (const s of [{ width: 0, height: 0 }, { width: -5, height: 10 }]) {
    const f = frustum2d(s, 40);
    for (const v of f.positions) assert.ok(Number.isFinite(v), `算出了 ${v}`);
    assert.ok(Number.isFinite(f.apex[2]));
  }
});
