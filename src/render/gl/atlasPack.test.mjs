/**
 * Unit test for R9 atlas packing. Run: node --test src/render/gl/atlasPack.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ATLAS_MAX, ATLAS_MAX_COMPACT, layoutKeyOf, packAtlas } from "./atlasPack.mjs";

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("regions do not overlap and all lie within the page; the page size is exactly the used area (not fixed at 4096)", () => {
  const cards = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, w: 300 + (i % 5) * 37, h: 200 + (i % 3) * 51 }));
  const { pages } = packAtlas(cards);
  assert.equal(pages.length, 1);
  const p = pages[0];
  assert.ok(p.w <= ATLAS_MAX && p.h <= ATLAS_MAX);
  assert.ok(p.w < ATLAS_MAX || p.h < ATLAS_MAX, "does not fill up to the limit");
  assert.equal(p.items.length, 20);
  for (const it of p.items) assert.ok(it.x >= 0 && it.y >= 0 && it.x + it.w <= p.w && it.y + it.h <= p.h);
  for (let i = 0; i < p.items.length; i++) for (let j = i + 1; j < p.items.length; j++) assert.ok(!overlaps(p.items[i], p.items[j]));
});

test("split into tabs when it does not fit; with only one stage (compact) the limit is 2048", () => {
  const cards = Array.from({ length: 8 }, (_, i) => ({ id: `big${i}`, w: 1920, h: 1080 }));
  const hi = packAtlas(cards, ATLAS_MAX);
  const lo = packAtlas(cards, ATLAS_MAX_COMPACT);
  // A 4096² page holds 2 × 3 = 6 1080p frames; 8 frames require a second page
  assert.equal(hi.pages.length, 2);
  for (const p of lo.pages) assert.ok(p.w <= 2048 && p.h <= 2048);
  assert.equal(lo.pages.length, 8);
  assert.equal(hi.pages.reduce((n, p) => n + p.items.length, 0), 8);
});

test("The same set in a different order yields the same table; layoutKey is order-independent", () => {
  const a = [{ id: "x", w: 100, h: 50 }, { id: "y", w: 80, h: 90 }, { id: "z", w: 100, h: 50 }];
  const b = [a[2], a[0], a[1]];
  assert.deepEqual(packAtlas(a), packAtlas(b));
  assert.equal(layoutKeyOf(a), layoutKeyOf(b));
  assert.notEqual(layoutKeyOf(a), layoutKeyOf([{ id: "x", w: 101, h: 50 }, a[1], a[2]]));
});

test("Cards larger than the limit are clamped to the limit and flagged clamped; sizes are rounded, at least 1", () => {
  const { pages } = packAtlas([{ id: "huge", w: 5000, h: 10 }, { id: "tiny", w: 0.2, h: 0.4 }]);
  const huge = pages.flatMap((p) => p.items).find((i) => i.id === "huge");
  const tiny = pages.flatMap((p) => p.items).find((i) => i.id === "tiny");
  assert.equal(huge.w, ATLAS_MAX);
  assert.equal(huge.clamped, true);
  assert.equal(tiny.w, 1);
  assert.equal(tiny.h, 1);
  assert.equal(tiny.clamped, false);
});
