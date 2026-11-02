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

test("Fully transparent: no box", () => {
  assert.equal(alphaBox(img(10, 10, () => 0), 10, 10), null);
});

test("Fully opaque: the box is the whole image", () => {
  const b = alphaBox(img(10, 10, () => 255), 10, 10);
  assert.deepEqual(b, { x: 0, y: 0, w: 1, h: 1 });
});

test("A block in the middle: the box encloses it and is **expanded outward by one ring** (better one ring too big than ever cutting content)", () => {
  // 10×10 的图,内容在 x=4..5, y=2..3
  const b = alphaBox(img(10, 10, (x, y) => (x >= 4 && x <= 5 && y >= 2 && y <= 3 ? 255 : 0)), 10, 10);
  // 外扩一圈之后是 x=3..6, y=1..4 → 起点 0.3/0.1,宽高 0.4/0.4
  assert.ok(near(b.x, 0.3), `x got ${b.x}`);
  assert.ok(near(b.y, 0.1), `y got ${b.y}`);
  assert.ok(near(b.w, 0.4), `w got ${b.w}`);
  assert.ok(near(b.h, 0.4), `h got ${b.h}`);
});

test("Content touching the edge: the outward expansion does not go outside the image", () => {
  const b = alphaBox(img(10, 10, (x, y) => (x === 0 && y === 0 ? 255 : 0)), 10, 10);
  assert.equal(b.x, 0, "The left edge is already at its limit, so it cannot be negative");
  assert.equal(b.y, 0);
  // 右下各扩一格 → 2×2
  assert.ok(near(b.w, 0.2), `w got ${b.w}`);
  assert.ok(near(b.h, 0.2));
});

test("The box never cuts off content: verified image by image on random images", () => {
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
      assert.ok(x / w >= b.x - 1e-9 && (x + 1) / w <= b.x + b.w + 1e-9, `Round ${round}: x=${x} was cut off by the box`);
      assert.ok(y / h >= b.y - 1e-9 && (y + 1) / h <= b.y + b.h + 1e-9, `Round ${round}: y=${y} was cut off by the box`);
    }
  }
});

test("Threshold: whether a semi-transparent edge counts as content is up to the caller", () => {
  const d = img(10, 10, (x) => (x === 5 ? 10 : 0));   // 一列很淡的
  assert.notEqual(alphaBox(d, 10, 10), null, "By default anything that is not fully transparent counts");
  assert.equal(alphaBox(d, 10, 10, { threshold: 20 }), null, "A higher threshold makes it not count");
});

test("A card that covers the whole screen is not worth cropping: the cropped result is as large as the whole", () => {
  assert.equal(worthCropping({ x: 0, y: 0, w: 1, h: 1 }), false);
  assert.equal(worthCropping({ x: 0, y: 0, w: 0.99, h: 0.99 }), false, "Just slightly smaller is not worth it either");
  assert.equal(worthCropping(null), false, "Fully transparent has nothing to crop");
  assert.equal(worthCropping({ x: 0.2, y: 0.3, w: 0.66, h: 0.28 }), true, "This is one that should be cropped");
  // 只有一个方向瘦下来也值得(比如一条横幅)
  assert.equal(worthCropping({ x: 0, y: 0.4, w: 1, h: 0.2 }), true);
});

test("An empty image does not crash", () => {
  assert.equal(alphaBox(new Uint8ClampedArray(0), 0, 0), null);
});
