/**
 * Crop rectangle geometry of the crop dialog (cropRect.ts). Run: node --test src/editor/timeline/cropRect.test.mjs
 *
 * Pinned: the rectangle never leaves the picture or shrinks below the minimum; the opposite edge or
 * corner stays put; a fixed aspect ratio holds through every handle; the mirror conversion is its own
 * inverse.
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { FULL_RECT, fitRatio, fractionRatio, mirrorRect, moveRect, resizeRect } = await import(srcUrl("editor/timeline/cropRect.ts"));
const { CROP_MIN } = await import(srcUrl("kernel/mediaPicture.mjs"));

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} expected ${b}, got ${a}`);
const inside = (r) => {
  assert.ok(r.x >= -1e-12 && r.y >= -1e-12 && r.x + r.w <= 1 + 1e-12 && r.y + r.h <= 1 + 1e-12, JSON.stringify(r));
  assert.ok(r.w >= CROP_MIN - 1e-12 && r.h >= CROP_MIN - 1e-12, JSON.stringify(r));
};
const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

test("mirrorRect: flips x and is its own inverse", () => {
  const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  close(mirrorRect(r, true).x, 0.6);
  const twice = mirrorRect(mirrorRect(r, true), true);
  for (const k of ["x", "y", "w", "h"]) close(twice[k], r[k], k);
  assert.equal(mirrorRect(r, false), r);
});

test("moveRect: kept inside the picture", () => {
  const r = { x: 0.5, y: 0.5, w: 0.4, h: 0.4 };
  assert.deepEqual(moveRect(r, 0.5, -1), { x: 0.6, y: 0, w: 0.4, h: 0.4 });
});

test("resizeRect, free: the dragged edges move, the others stay; never outside, never below the minimum", () => {
  const r = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
  const se = resizeRect(r, "se", 0.1, -0.1, null);
  close(se.x, 0.2); close(se.y, 0.2); close(se.w, 0.6); close(se.h, 0.4);
  const w = resizeRect(r, "w", -0.5, 0.3, null);
  close(w.x, 0); close(w.w, 0.7); close(w.y, 0.2); close(w.h, 0.5);
  for (const h of HANDLES) for (const d of [-2, -0.3, 0.3, 2]) inside(resizeRect(r, h, d, d, null));
});

test("resizeRect, fixed ratio: every handle keeps the shape, stays inside, keeps the opposite side", () => {
  const ratio = fractionRatio(1, 16 / 9); // a square crop on a 16:9 picture
  const r = fitRatio({ x: 0.3, y: 0.3, w: 0.2, h: 0.2 }, ratio);
  close(r.w / r.h, ratio);
  for (const h of HANDLES) for (const [dx, dy] of [[0.1, 0.05], [-0.4, 0.2], [2, 2], [-2, -2], [0, 0]]) {
    const out = resizeRect(r, h, dx, dy, ratio);
    inside(out);
    close(out.w / out.h, ratio, `${h} ${dx},${dy}`);
  }
  const se = resizeRect(r, "se", -0.1, -0.1, ratio);
  close(se.x, r.x, "the north-west corner stays");
  close(se.y, r.y);
  const n = resizeRect(r, "n", 0, -0.1, ratio);
  close(n.y + n.h, r.y + r.h, "the bottom edge stays");
});

test("fitRatio: the largest rectangle of that shape, centered where the old one was", () => {
  const sq = fitRatio(FULL_RECT, fractionRatio(1, 16 / 9));
  close(sq.h, 1);
  close(sq.w, 9 / 16);
  close(sq.x, (1 - 9 / 16) / 2);
  const wide = fitRatio({ x: 0.9, y: 0, w: 0.1, h: 0.1 }, 2);
  assert.deepEqual(wide, { x: 0, y: 0, w: 1, h: 0.5 }, "pushed back inside from the corner");
});
