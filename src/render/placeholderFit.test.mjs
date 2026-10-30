/**
 * 占位符在屏幕上多大(`placeholderFit.ts`)。跑:node --test src/render/placeholderFit.test.mjs
 *
 *   PF-01 viewInverse:1 / 预览缩放,夹在 [1/8, 16];坏值回 1
 *   PF-02 沙漏:屏幕上保持原大小(只抵消预览缩放,不管这一层的缩放);放不进框按框缩小;噪点(铺满形态)不在这里
 *   PF-03 原先「需要本地 PC 渲染辅助」图标的排法已随图标撤掉(2026-10-21 用户定):模块不再导出 `unsupportedFit`
 *   PF-04 相邻两个小片段:沙漏在屏幕上不相交(各自在自己的框里)
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const F = await import("./placeholderFit.ts");
const screenOf = (fit, _layout, view, layer) => {
  const size = { w: F.HOURGLASS_SIZE, h: F.HOURGLASS_SIZE };
  const k = fit.scale * view * layer;
  return { w: size.w * k, h: size.h * k };
};

test("PF-01 viewInverse", () => {
  assert.equal(F.viewInverse(0.25), 4);
  assert.equal(F.viewInverse(1), 1);
  assert.equal(F.viewInverse(2), 0.5, "放大预览时按比例缩回(屏幕上保持原大小)");
  assert.equal(F.viewInverse(0.01), 16, "封顶 16");
  assert.equal(F.viewInverse(100), 1 / 8, "封底 1/8");
  for (const bad of [0, -1, NaN, Infinity, undefined, null, "x"]) assert.equal(F.viewInverse(bad), 1, String(bad));
  assert.equal(F.viewInverse("0.5"), 2);
});

test("PF-02 沙漏:只抵消预览缩放;放不进框按框缩", () => {
  const box = { width: 1920, height: 1080 };
  // 27% 预览:屏幕上 28 像素
  const a = F.hourglassFit({ box, viewScale: 0.27, layerScale: 1 });
  assert.ok(Math.abs(screenOf(a, null, 0.27, 1).w - 28) < 1e-9, JSON.stringify(a));
  // 这一层缩到一半:沙漏跟着这一层缩(语义:继承该层的缩放),倍数不变
  const b = F.hourglassFit({ box, viewScale: 0.27, layerScale: 0.5 });
  assert.equal(b.scale, a.scale, "不抵消这一层的缩放");
  assert.ok(Math.abs(screenOf(b, null, 0.27, 0.5).w - 14) < 1e-9);
  // 框很小:按框缩(留边距)
  const c = F.hourglassFit({ box: { width: 40, height: 40 }, viewScale: 0.25, layerScale: 1 });
  assert.ok(c.scale * F.HOURGLASS_SIZE <= 40 - 2 * Math.min(4 * 4, 0.08 * 40) + 1e-9, JSON.stringify(c));
  assert.ok(c.scale < 4);
  // 预览 100%、框够大:原样
  assert.deepEqual(F.hourglassFit({ box, viewScale: 1 }), { scale: 1 });
  // 框是 0:不画成 0
  assert.equal(F.hourglassFit({ box: { width: 0, height: 0 }, viewScale: 0.3 }).scale, F.FIT_MIN_SCALE);
});

test("PF-03 没有「需要本地 PC 渲染辅助」图标的排法了", () => {
  assert.equal(F.unsupportedFit, undefined);
  assert.equal(F.UNSUPPORTED_SIZES, undefined);
});

test("PF-04 相邻两个小片段:沙漏各在自己的框里,屏幕上不相交", () => {
  const view = 0.27;
  // 两个 40×40 的片段挨着(舞台 x 0～40、40～80),沙漏都在框中心
  const boxes = [{ x: 0, w: 40 }, { x: 40, w: 40 }];
  const rects = boxes.map(({ x, w }) => {
    const fit = F.hourglassFit({ box: { width: w, height: 40 }, viewScale: view, layerScale: 1 });
    const cw = F.HOURGLASS_SIZE * fit.scale;
    return { left: x + w / 2 - cw / 2, right: x + w / 2 + cw / 2, fit };
  });
  assert.ok(rects[0].right <= rects[1].left, JSON.stringify(rects));
  assert.ok(rects[0].left >= 0 && rects[1].right <= 80);
});
