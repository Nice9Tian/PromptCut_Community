/**
 * Placeholder size on screen (`placeholderFit.ts`). Run: node --test src/render/placeholderFit.test.mjs
 *
 *   PF-01 viewInverse: 1 / preview zoom, clamped to [1/8, 16]; bad values return 1
 *   PF-02 Hourglass: keeps original size on screen (only offsets preview zoom, ignoring this
 *         layer's scale); shrinks to box if it cannot fit; noise (fill mode) is not here
 *   PF-03 Layout for former "Requires local PC render assistance" icon was removed with the icon
 *         (user decision, 2026-10-21): module no longer exports `unsupportedFit`
 *   PF-04 Two adjacent small clips: hourglasses do not intersect on screen (each in its own box)
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
  assert.equal(F.viewInverse(2), 0.5, "Scaled back proportionally when the preview is zoomed in (keeps its original size on screen)");
  assert.equal(F.viewInverse(0.01), 16, "Capped at 16");
  assert.equal(F.viewInverse(100), 1 / 8, "Floored at 1/8");
  for (const bad of [0, -1, NaN, Infinity, undefined, null, "x"]) assert.equal(F.viewInverse(bad), 1, String(bad));
  assert.equal(F.viewInverse("0.5"), 2);
});

test("PF-02 hourglass: only cancels the preview scale; if it does not fit the box, scales to the box", () => {
  const box = { width: 1920, height: 1080 };
  // 27% preview: 28 pixels on screen
  const a = F.hourglassFit({ box, viewScale: 0.27, layerScale: 1 });
  assert.ok(Math.abs(screenOf(a, null, 0.27, 1).w - 28) < 1e-9, JSON.stringify(a));
  // This layer scaled down to half: hourglass scales with this layer
  // (semantics: inherits this layer's scale), multiplier unchanged
  const b = F.hourglassFit({ box, viewScale: 0.27, layerScale: 0.5 });
  assert.equal(b.scale, a.scale, "Does not cancel this layer's scaling");
  assert.ok(Math.abs(screenOf(b, null, 0.27, 0.5).w - 14) < 1e-9);
  // Box is very small: scale down to fit the box (preserving margins)
  const c = F.hourglassFit({ box: { width: 40, height: 40 }, viewScale: 0.25, layerScale: 1 });
  assert.ok(c.scale * F.HOURGLASS_SIZE <= 40 - 2 * Math.min(4 * 4, 0.08 * 40) + 1e-9, JSON.stringify(c));
  assert.ok(c.scale < 4);
  // Preview 100%, box is large enough: as-is
  assert.deepEqual(F.hourglassFit({ box, viewScale: 1 }), { scale: 1 });
  // Box is 0: do not render as 0
  assert.equal(F.hourglassFit({ box: { width: 0, height: 0 }, viewScale: 0.3 }).scale, F.FIT_MIN_SCALE);
});

test("PF-03 no layout for the \"Needs local PC render assist\" icon anymore", () => {
  assert.equal(F.unsupportedFit, undefined);
  assert.equal(F.UNSUPPORTED_SIZES, undefined);
});

test("PF-04 two adjacent small clips: each hourglass sits in its own box, no overlap on screen", () => {
  const view = 0.27;
  // Two adjacent 40×40 clips (stage x 0~40, 40~80), hourglasses are both centered in their boxes
  const boxes = [{ x: 0, w: 40 }, { x: 40, w: 40 }];
  const rects = boxes.map(({ x, w }) => {
    const fit = F.hourglassFit({ box: { width: w, height: 40 }, viewScale: view, layerScale: 1 });
    const cw = F.HOURGLASS_SIZE * fit.scale;
    return { left: x + w / 2 - cw / 2, right: x + w / 2 + cw / 2, fit };
  });
  assert.ok(rects[0].right <= rects[1].left, JSON.stringify(rects));
  assert.ok(rects[0].left >= 0 && rects[1].right <= 80);
});
