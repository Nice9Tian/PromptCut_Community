/**
 * 内容框(alpha 包围盒)的单测。跑:node --test src/editor/preview/alphaBox.test.mjs
 *
 * 这个框决定 3D 里那块板子有多大、贴图往哪儿映。错了有两种表现,都不报错:
 *   - 框小了 → 板子把卡片的内容**切掉一块**;
 *   - 框错位 → 贴图和板子对不上,画面整体偏移。
 * 所以把「宁可大一圈,绝不切内容」这条钉死。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { alphaBox, worthCropping } from "./alphaBox.ts";

/** 造一张 w×h 的 RGBA 图,fn(x,y) 返回 alpha */
const img = (w, h, fn) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[(y * w + x) * 4 + 3] = fn(x, y);
  return d;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("全透明:没有框", () => {
  assert.equal(alphaBox(img(10, 10, () => 0), 10, 10), null);
});

test("整张都不透明:框就是整张", () => {
  const b = alphaBox(img(10, 10, () => 255), 10, 10);
  assert.deepEqual(b, { x: 0, y: 0, w: 1, h: 1 });
});

test("中间一块:框把它围住,而且**向外扩了一圈**(宁可大一圈,绝不切内容)", () => {
  // 10×10 的图,内容在 x=4..5, y=2..3
  const b = alphaBox(img(10, 10, (x, y) => (x >= 4 && x <= 5 && y >= 2 && y <= 3 ? 255 : 0)), 10, 10);
  // 外扩一圈之后是 x=3..6, y=1..4 → 起点 0.3/0.1,宽高 0.4/0.4
  assert.ok(near(b.x, 0.3), `x 实得 ${b.x}`);
  assert.ok(near(b.y, 0.1), `y 实得 ${b.y}`);
  assert.ok(near(b.w, 0.4), `w 实得 ${b.w}`);
  assert.ok(near(b.h, 0.4), `h 实得 ${b.h}`);
});

test("内容贴着边:外扩不会跑出图外", () => {
  const b = alphaBox(img(10, 10, (x, y) => (x === 0 && y === 0 ? 255 : 0)), 10, 10);
  assert.equal(b.x, 0, "左边已经到头了,不能是负的");
  assert.equal(b.y, 0);
  // 右下各扩一格 → 2×2
  assert.ok(near(b.w, 0.2), `w 实得 ${b.w}`);
  assert.ok(near(b.h, 0.2));
});

test("框绝不切掉内容 —— 随机图上逐张验", () => {
  let rnd = 12345;
  const next = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 40; round++) {
    const w = 8 + Math.floor(next() * 24);
    const h = 8 + Math.floor(next() * 24);
    const pts = [];
    const data = img(w, h, (x, y) => {
      const on = next() < 0.06;
      if (on) pts.push([x, y]);
      return on ? 255 : 0;
    });
    const b = alphaBox(data, w, h);
    if (!pts.length) { assert.equal(b, null); continue; }
    for (const [x, y] of pts) {
      assert.ok(x / w >= b.x - 1e-9 && (x + 1) / w <= b.x + b.w + 1e-9, `第 ${round} 轮:x=${x} 被框切掉了`);
      assert.ok(y / h >= b.y - 1e-9 && (y + 1) / h <= b.y + b.h + 1e-9, `第 ${round} 轮:y=${y} 被框切掉了`);
    }
  }
});

test("阈值:半透明的边缘算不算内容,由调用方定", () => {
  const d = img(10, 10, (x) => (x === 5 ? 10 : 0));   // 一列很淡的
  assert.notEqual(alphaBox(d, 10, 10), null, "默认只要不是全透明就算");
  assert.equal(alphaBox(d, 10, 10, { threshold: 20 }), null, "阈值调高就不算了");
});

test("满屏铺底的卡不值得裁 —— 裁出来和整块一样大", () => {
  assert.equal(worthCropping({ x: 0, y: 0, w: 1, h: 1 }), false);
  assert.equal(worthCropping({ x: 0, y: 0, w: 0.99, h: 0.99 }), false, "差一点点也不值得");
  assert.equal(worthCropping(null), false, "全透明没什么可裁的");
  assert.equal(worthCropping({ x: 0.2, y: 0.3, w: 0.66, h: 0.28 }), true, "这才是该裁的");
  // 只有一个方向瘦下来也值得(比如一条横幅)
  assert.equal(worthCropping({ x: 0, y: 0.4, w: 1, h: 0.2 }), true);
});

test("空图不炸", () => {
  assert.equal(alphaBox(new Uint8ClampedArray(0), 0, 0), null);
});
