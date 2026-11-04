/**
 * Prerender small size on browser-only nodes (M7 contract Section 4.4): size conversion is
 * identical one by one to desktop `server/bakery/small-bitmap.mjs`; quality 80.
 * Rasterization itself requires a browser (`foreignObject` → canvas → WebP), inspected by online
 * build end-to-end tests and probe P3.
 * Run: node --test src/render/bakeSmall.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { smallScale, smallSize, SMALL_MAX_WIDTH, SMALL_MAX_HEIGHT, SMALL_WEBP_QUALITY } from "./bakeSmall.ts";
import * as desk from "../../server/bakery/small-bitmap.mjs";

test("M7-SM-01 small-size scale ratio and pixel size are the same as desktop; WebP quality 80", () => {
  assert.equal(SMALL_MAX_WIDTH, desk.SMALL_MAX_WIDTH);
  assert.equal(SMALL_MAX_HEIGHT, desk.SMALL_MAX_HEIGHT);
  assert.equal(Math.round(SMALL_WEBP_QUALITY * 100), desk.SMALL_WEBP_QUALITY);
  const cases = [
    [1920, 1080], [1080, 1920], [3840, 2160], [640, 360], [800, 600], [1000, 100], [0, 1080], [1920, -1],
  ];
  for (const [w, h] of cases) assert.equal(smallScale(w, h), desk.smallScale(w, h), `${w}x${h}`);
  const boxes = [
    { projectWidth: 1920, projectHeight: 1080 },
    { projectWidth: 1920, projectHeight: 1080, boxWidth: 960, boxHeight: 540 },
    { projectWidth: 1080, projectHeight: 1920, boxWidth: 333, boxHeight: 777 },
    { projectWidth: 1280, projectHeight: 720, boxWidth: 1, boxHeight: 1 },
  ];
  for (const b of boxes) assert.deepEqual(smallSize(b), desk.smallSize(b), JSON.stringify(b));
  assert.deepEqual(smallSize({ projectWidth: 1920, projectHeight: 1080 }), { scale: 800 / 1920, width: 800, height: 450 });
});
