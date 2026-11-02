/**
 * Unit tests for differential layer extraction of below-dependent streams (render refactor "Wu-2",
 * "lower layer 2", `docs/plan/prerender-products-contract.md` section 5.3).
 * Run: `npm test -- server/test/below-capture.test.mjs`
 *
 *   - Formula for calculating that layer (`diffLayer`): two identical images, fully transparent lower
 *     layer, fully opaque lower layer, translucent lower layer, quantization noise, frosted-glass
 *     mask, clipping;
 *   - Guarantee of consistent lower layer state when taking two captures (`belowSegmentCapture`, with
 *     real `bakeStream` and fake prerender room): ordering of upper capture, hide, lower capture,
 *     and revert, no time advancement in between; revert guaranteed after hide; two sanity checks
 *     on first frame of each segment, and what to do if they fail; frames where target card is not
 *     on page; frames modified outside the rectangle;
 *   - Connecting to producer (`StreamProducer.runSegment`, real ffmpeg): screenshot rectangle for
 *     `kind: 'below'` stream is always full frame, wait for assets to be ready, sparse pass measures
 *     entity box, second pass tightens; decoded and composited back onto lower layer equals image
 *     with target card; expand and retry when tight rectangle is not large enough; single-card
 *     stream code path unchanged;
 *   - Keys: `BELOW_STREAM_VERSION` is 1; `capture-below.mjs` enters screenshot code fingerprint, does
 *     not enter code fingerprint for generating snapshots.
 * Tests requiring ffmpeg are skipped on machines without ffmpeg.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { bakeStream } from '../bakery/bake.mjs';
import { dropStreamEncoderSpares } from '../bakery/ffmpeg.mjs';
import { diffLayer, glassMask, changedOutside, layerOutside, belowSegmentCapture, newBelowRecord, pageHideTarget, pageShowTarget, DIFF_TOLERANCE } from '../bakery/capture-below.mjs';
import { StreamProducer, planStreams, SEGMENT_FRAMES, SPARSE_STRIDE } from '../frame-stream.mjs';
import { BELOW_STREAM_VERSION } from '../card-identity.mjs';
import { captureCode, snapshotCode, invalidateFrameCode } from '../frame-code.mjs';
import { createReadyHub } from '../ready-index.mjs';

const ffmpegOk = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
after(() => dropStreamEncoderSpares());

/* ------------------------------------------------------------ Reference implementation (written independently from production code) */

/** Deterministic pseudorandom numbers */
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const px = (r, g, b, a) => [r, g, b, a];
const image = (pixels) => Buffer.from(pixels.flat());
/** Composites a layer (premultiplied color, 0-1) over a straight RGBA pixel via normal blend, returns premultiplied color result (out of 255) */
function over(layer, lower) {
  const la = lower[3] / 255, keep = 1 - layer.a;
  return [0, 1, 2].map(k => (layer.c[k] + lower[k] / 255 * la * keep) * 255).concat([(layer.a + la * keep) * 255]);
}
const premul = (p) => [p[0] * p[3] / 255, p[1] * p[3] / 255, p[2] * p[3] / 255, p[3]];
/** Rounds premultiplied color (out of 255) to an 8-bit straight RGBA pixel (as provided by screenshots) */
function toStraight(q) {
  const a = Math.round(q[3]);
  if (a <= 0) return [0, 0, 0, 0];
  return [0, 1, 2].map(k => Math.max(0, Math.min(255, Math.round(q[k] / a * 255)))).concat([Math.min(255, a)]);
}
/** Composites computed S (straight RGBA, 8-bit) back onto `lower`, compares with `upper`: returns maximum channel difference (premultiplied color, out of 255) */
function backError(layerPx, lowerPx, upperPx) {
  const a = layerPx[3] / 255;
  const got = over({ a, c: [0, 1, 2].map(k => layerPx[k] / 255 * a) }, lowerPx);
  const want = premul(upperPx);
  return Math.max(...got.map((v, k) => Math.abs(v - want[k])));
}
const pixelAt = (buf, i) => [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], buf[i * 4 + 3]];
/** Computes across a row of pixels, returns S for each pixel and maximum difference when composited back */
function solve(upperPixels, lowerPixels, options = {}) {
  const n = upperPixels.length;
  const out = diffLayer(image(upperPixels), image(lowerPixels), n, 1, options);
  const layer = Array.from({ length: n }, (_, i) => pixelAt(out.rgba, i));
  return { out, layer, errors: layer.map((s, i) => backError(s, lowerPixels[i], upperPixels[i])) };
}
/** Original formula from contract section 5.3 (opacity takes maximum among lower bounds), computes opacity only */
function contractAlpha(upperPx, lowerPx) {
  const ra = upperPx[3] / 255, la = lowerPx[3] / 255;
  let a = la < 1 ? (ra - la) / (1 - la) : 0;
  for (let k = 0; k < 3; k++) {
    const rc = upperPx[k] / 255 * ra, lc = lowerPx[k] / 255 * la;
    if (lc > 0) a = Math.max(a, 1 - rc / lc);
    if (lc < 1) a = Math.max(a, (rc - lc) / (1 - lc));
  }
  return Math.max(0, Math.min(1, a));
}

/* ------------------------------------------------------------ Formulas */

test('BD-same the two screenshots are identical: that layer is fully transparent', () => {
  const rand = rng(1);
  const pixels = Array.from({ length: 400 }, () => px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)));
  const { out } = solve(pixels, pixels);
  assert.equal(out.changed, 0);
  assert.ok(out.rgba.every(v => v === 0));
  assert.deepEqual([out.width, out.height], [400, 1]);
});

test('BD-lower-clear lower layer fully transparent: that layer is simply the frame with the target card', () => {
  const rand = rng(2);
  const upper = Array.from({ length: 300 }, () => px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 1 + Math.floor(rand() * 255)));
  // When lower layer is fully transparent, its color in screenshots is always 0; same if color is another value (colors at fully transparent points do not count)
  for (const lowerColor of [0, 200]) {
    const lower = upper.map(() => px(lowerColor, lowerColor, lowerColor, 0));
    const { out } = solve(upper, lower);
    assert.equal(Buffer.compare(out.rgba, image(upper)), 0);
    assert.equal(out.changed, 300);
  }
  // Pixels where image with target card is also fully transparent: transparent
  assert.ok(solve([px(9, 9, 9, 0)], [px(0, 0, 0, 0)]).out.rgba.every(v => v === 0));
});

test('BD-lower-solid lower layer fully opaque, target card is a patch of shadow: that layer is black, its opacity is the depth of the shadow, and compositing it back is off by at most one level', () => {
  const rand = rng(3);
  const shade = 0.3;
  const lower = [], upper = [];
  for (let i = 0; i < 2000; i++) {
    const l = px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255);
    lower.push(l);
    upper.push(toStraight(over({ a: shade, c: [0, 0, 0] }, l)));
  }
  const { layer, errors } = solve(upper, lower);
  assert.ok(Math.max(...errors) <= 1.5, `Maximum difference after compositing back ${Math.max(...errors)}`);
  // On pixels where at least one channel is bright enough, opacity is measured accurately: within 3 levels of 0.3 × 255 = 76.5
  const bright = layer.filter((_, i) => Math.max(lower[i][0], lower[i][1], lower[i][2]) >= 128);
  assert.ok(bright.length > 1000);
  for (const s of bright) assert.ok(Math.abs(s[3] - shade * 255) <= 3, `Opacity ${s[3]}`);
  // Color is black (no more than 2 levels after premultiplication)
  for (const s of bright) assert.ok(Math.max(s[0], s[1], s[2]) * s[3] / 255 <= 2, `Color ${s}`);
});

test('BD-noise-solid quantization noise (opaque lower layer): a very dark channel that is off by one level must not push the whole pixel to opaque', () => {
  // Pure green lower layer, red and blue channels only have 1 or 2 levels; after darkening by 30%, they round to 0 or 1
  const lower = [px(1, 255, 1, 255), px(2, 255, 0, 255), px(1, 250, 2, 255), px(0, 255, 0, 255)];
  const upper = lower.map(l => toStraight(over({ a: 0.3, c: [0, 0, 0] }, l)));
  assert.deepEqual(upper[0], [1, 179, 1, 255]);
  // Same image with different rounding (truncating decimals instead of rounding): 1 × 0.7 = 0.7 becomes 0, difference is less than one level
  const noisy = lower.map(l => px(Math.floor(l[0] * 0.7), Math.floor(l[1] * 0.7), Math.floor(l[2] * 0.7), 255));
  assert.deepEqual(noisy[0], [0, 178, 0, 255]);
  for (const set of [upper, noisy]) {
    const { layer, errors } = solve(set, lower);
    for (const s of layer) assert.ok(Math.abs(s[3] - 76.5) <= 3, `Opacity ${s[3]} should be around 76`);
    assert.ok(Math.max(...errors) <= 1.5, `Maximum difference after compositing back ${Math.max(...errors)}`);
  }
  // Control: without relaxation (tolerance 0, i.e. contract's original formula), the same pixel is pushed to fully opaque
  const strict = solve(noisy, lower, { tolerance: 0 }).layer;
  assert.equal(strict[0][3], 255);
  assert.equal(contractAlpha(noisy[0], lower[0]), 1);
});

test('BD-contract with an opaque lower layer and tolerance 0, the opacity is the formula in section 5.3 of the contract (the largest of the individual lower bounds)', () => {
  const rand = rng(4);
  for (let i = 0; i < 500; i++) {
    const l = px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255);
    const u = px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255);
    const got = solve([u], [l], { tolerance: 0 }).layer[0][3];
    const same = u.every((v, k) => v === l[k]);
    assert.equal(got, same ? 0 : Math.round(contractAlpha(u, l) * 255), `R ${u} L ${l}`);
  }
  // After relaxation it can only be smaller, and will not become too small: composited color differs by just over one level at most
  for (let i = 0; i < 500; i++) {
    const l = px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255);
    const u = px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255);
    const relaxed = solve([u], [l]);
    assert.ok(relaxed.layer[0][3] <= Math.round(contractAlpha(u, l) * 255));
    assert.ok(relaxed.errors[0] <= 1.5, `R ${u} L ${l} diff ${relaxed.errors[0]}`);
  }
  assert.equal(DIFF_TOLERANCE, 1 / 255);
});

test('BD-overlay any layer over any lower layer (opaque, semi-transparent and fully transparent all included): the computed layer, composited back, differs from the original frame by at most two levels', () => {
  const rand = rng(5);
  const lower = [], upper = [];
  for (let i = 0; i < 6000; i++) {
    const kind = i % 3;
    const la = kind === 0 ? 255 : kind === 1 ? 1 + Math.floor(rand() * 254) : Math.floor(rand() * 40);
    const l = la ? px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), la) : px(0, 0, 0, 0);
    const a = rand() < 0.15 ? 1 : rand();
    const layer = { a, c: [rand() * a, rand() * a, rand() * a] };
    lower.push(l);
    upper.push(toStraight(over(layer, l)));
  }
  const { layer, errors } = solve(upper, lower);
  let worst = 0, at = -1;
  errors.forEach((e, i) => { if (e > worst) { worst = e; at = i; } });
  assert.ok(worst <= 2, `Maximum difference ${worst.toFixed(2)}: R ${upper[at]} L ${lower[at]} S ${layer[at]}`);
  const mean = errors.reduce((s, e) => s + e, 0) / errors.length;
  assert.ok(mean <= 0.6, `Mean ${mean}`);
});

test('BD-noise-faint quantization noise (lower layer almost fully transparent): a color mismatch must not produce an opaque pixel', () => {
  // Pixel encountered in live testing: lower layer is blue with 1/255 opacity, image with target card is black with 1/255 opacity (both are 0 after premultiplication)
  const lower = [px(0, 0, 255, 1), px(0, 64, 128, 4), px(10, 10, 10, 128)];
  const upper = [px(0, 0, 0, 1), px(0, 60, 128, 4), px(9, 9, 9, 128)];
  const { layer, errors } = solve(upper, lower);
  for (const s of layer) assert.ok(s[3] <= 2, `Opacity ${s[3]}`);
  assert.ok(Math.max(...errors) <= 1.5);
  // Control: contract's original formula yields fully opaque on the first pixel (opacity differs by 254 levels when composited back)
  assert.equal(contractAlpha(upper[0], lower[0]), 1);
});

test('BD-lower-half semi-transparent lower layer, the target card is a layer that is really laid on top: when the opacity formula and the color lower bound do not conflict, both hold', () => {
  // Dark translucent layer over white text (opacity 0.6): R opacity = a + 0.6 × (1 - a)
  const l = px(255, 255, 255, 153);
  const layer = { a: 0.676, c: [0.04, 0.045, 0.06] };
  const u = toStraight(over(layer, l));
  const got = solve([u], [l]);
  assert.ok(Math.abs(got.layer[0][3] - 0.676 * 255) <= 2, `Opacity ${got.layer[0][3]}`);
  assert.ok(got.errors[0] <= 1.5);
});

test('BD-glass pixels inside the outer frame of the frosted glass where the lower layer is fully opaque: that layer is the frame with the target card (opaque); pixels outside the frame and pixels where the lower layer is not opaque are computed as usual', () => {
  // Row of 8 pixels, glass covers the middle 4 (pixels 2-5)
  const lower = [px(200, 30, 30, 255), px(200, 30, 30, 255), px(200, 30, 30, 255), px(40, 200, 40, 255), px(40, 200, 40, 255), px(90, 90, 90, 128), px(40, 200, 40, 255), px(40, 200, 40, 255)];
  const upper = lower.map((l, i) => (i === 2 ? l : toStraight(over({ a: 0.4, c: [0, 0, 0] }, l))));
  const glass = [{ x: 2, y: 0, w: 4, h: 1 }];
  const { layer, errors, out } = solve(upper, lower, { glass });
  // Inside box, opaque lower layer: pixel 2 (both images identical), pixels 3 and 4: all are R itself, opacity 255
  for (const i of [2, 3, 4]) assert.deepEqual(layer[i], [upper[i][0], upper[i][1], upper[i][2], 255], `Item ${i}`);
  // Inside box, translucent lower layer (pixel 5): cannot take 1, compute normally
  assert.ok(layer[5][3] < 255 && layer[5][3] > 0);
  // Outside box: use minimum opacity (here a 0.4 black layer, minimum is itself)
  for (const i of [0, 1, 6, 7]) assert.ok(Math.abs(layer[i][3] - 0.4 * 255) <= 4, `Item ${i} opacity ${layer[i][3]}`);
  assert.ok(Math.max(...errors) <= 1.5);
  assert.equal(out.changed, 8);
  // Without mask, pixel 2 is transparent
  assert.equal(solve(upper, lower).layer[2][3], 0);
});

test('BD-mask frosted glass mask: a rounded rectangle, a pixel counts only if its center is inside; when the radius exceeds the side length it is scaled down proportionally', () => {
  const area = { x: 10, y: 20, w: 40, h: 30 };
  const mask = glassMask([{ x: 20, y: 25, w: 20, h: 20, radii: [[8, 8], [8, 8], [8, 8], [8, 8]] }], area);
  const at = (x, y) => mask[(y - area.y) * area.w + (x - area.x)];
  assert.equal(at(30, 35), 1, 'Center');
  assert.equal(at(20, 35), 1, 'Left edge midpoint');
  assert.equal(at(39, 35), 1, 'Last column on the right');
  assert.equal(at(40, 35), 0, 'Outside the right edge');
  assert.equal(at(20, 25), 0, 'Top-left corner cut off by the rounded corner');
  assert.equal(at(39, 44), 0, 'Bottom-right corner cut off by the rounded corner');
  assert.equal(at(23, 27), 1, 'Inside the rounded corner');
  assert.equal(at(19, 35), 0);
  // No rounded corners: entire block
  const square = glassMask([{ x: 20, y: 25, w: 20, h: 20 }], area);
  assert.equal(square.reduce((s, v) => s + v, 0), 400);
  // Radius larger than half the side length: collapses into a circle
  const round = glassMask([{ x: 20, y: 25, w: 20, h: 20, radii: [[50, 50], [50, 50], [50, 50], [50, 50]] }], area);
  const filled = round.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(filled - Math.PI * 100) <= 12, `Circle area ${filled}`);
  // Portions extending outside the region are clipped; fractional coordinates do not go out of bounds
  const partial = glassMask([{ x: 0.5, y: 10.25, w: 20.5, h: 15.5 }], area);
  assert.equal(partial.reduce((s, v) => s + v, 0), 11 * 6);
});

test('BD-crop hand out only one region: byte-for-byte identical to computing the whole image and then cropping; throws if the rectangle is not in the frame', () => {
  const rand = rng(6);
  const W = 24, H = 16;
  const lower = Buffer.alloc(W * H * 4), upper = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const l = px(Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), i % 5 === 0 ? 0 : i % 3 === 0 ? 120 : 255);
    const u = i % 4 === 0 ? l : toStraight(over({ a: 0.5, c: [0.1, 0.2, 0.3] }, l));
    lower.set(l, i * 4); upper.set(u, i * 4);
  }
  const glass = [{ x: 6, y: 4, w: 10, h: 8 }];
  const whole = diffLayer(upper, lower, W, H, { glass });
  const crop = { x: 5, y: 3, w: 12, h: 10 };
  const part = diffLayer(upper, lower, W, H, { crop, glass });
  const expected = Buffer.alloc(crop.w * crop.h * 4);
  for (let y = 0; y < crop.h; y++) whole.rgba.copy(expected, y * crop.w * 4, ((y + crop.y) * W + crop.x) * 4, ((y + crop.y) * W + crop.x + crop.w) * 4);
  assert.equal(Buffer.compare(part.rgba, expected), 0);
  assert.deepEqual([part.width, part.height], [12, 10]);
  assert.throws(() => diffLayer(upper, lower, W, H, { crop: { x: 20, y: 0, w: 8, h: 4 } }), /outside the frame/);
  assert.throws(() => diffLayer(upper.subarray(0, 100), lower, W, H), /smaller than the frame/);
});

test('BD-outside whether the two screenshots differ outside the handed-out rectangle: returns the bounding box of those pixels', () => {
  const W = 20, H = 12;
  const lower = Buffer.alloc(W * H * 4, 7);
  const crop = { x: 6, y: 4, w: 8, h: 4 };
  const upper = Buffer.from(lower);
  assert.equal(changedOutside(upper, lower, W, H, crop), null);
  // Modifications inside the rectangle: do not count
  upper[(5 * W + 8) * 4] = 99;
  assert.equal(changedOutside(upper, lower, W, H, crop), null);
  // One above, one to the left on the same row, one to the right
  upper[(1 * W + 15) * 4 + 3] = 99;
  upper[(6 * W + 2) * 4 + 1] = 99;
  upper[(7 * W + 17) * 4 + 2] = 99;
  assert.deepEqual(changedOutside(upper, lower, W, H, crop), { x: 2, y: 1, w: 16, h: 7 });
});

test('BD-outside-layer pixels outside the rectangle that differ byte for byte but still compute to fully transparent do not count as changed outside; only pixels with real content count', () => {
  const W = 20, H = 12;
  const crop = { x: 6, y: 4, w: 8, h: 4 };
  // Lower layer is blue with 1/255 opacity (almost fully transparent)
  const lower = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) lower.set([0, 0, 255, 1], i * 4);
  // Several pixels outside turned black (still 0 after premultiplication as before): bytes differ, but computed layer is transparent
  const faint = Buffer.from(lower);
  for (const [x, y] of [[2, 1], [17, 7], [3, 10]]) faint.set([0, 0, 0, 1], (y * W + x) * 4);
  assert.ok(changedOutside(faint, lower, W, H, crop));
  assert.equal(layerOutside(faint, lower, W, H, crop), null);
  // One pixel outside actually covered by content: counts
  const real = Buffer.from(faint);
  real.set([200, 200, 200, 180], (9 * W + 16) * 4);
  assert.deepEqual(layerOutside(real, lower, W, H, crop), { x: 16, y: 9, w: 1, h: 1 });
  // Changes inside the rectangle do not count no matter how they change
  const inside = Buffer.from(lower);
  inside.set([10, 10, 10, 255], (5 * W + 8) * 4);
  assert.equal(layerOutside(inside, lower, W, H, crop), null);
});

/* ------------------------------------------------------------ Two captures */

const STAGE = { width: 96, height: 64 };
const pngOf = (data, width, height) => { const png = new PNG({ width, height }); data.copy(png.data); return PNG.sync.write(png); };
const cropOf = (data, rect) => {
  const out = Buffer.alloc(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) data.copy(out, y * rect.w * 4, ((rect.y + y) * STAGE.width + rect.x) * 4, ((rect.y + y) * STAGE.width + rect.x + rect.w) * 4);
  return out;
};
/** Lower layer image at frame `frame`: opaque vertical stripes move right, translucent block in bottom-left; shifts by several columns when `drift` is non-zero (simulating "taking an extra step") */
function lowerPixels(frame, drift = 0) {
  const data = Buffer.alloc(STAGE.width * STAGE.height * 4);
  for (let y = 0; y < STAGE.height; y++) for (let x = 0; x < STAGE.width; x++) {
    const i = (y * STAGE.width + x) * 4, band = Math.floor((x + frame * 2 + drift * 5) / 8) % 3;
    data[i] = band === 0 ? 230 : 20; data[i + 1] = band === 1 ? 230 : 30; data[i + 2] = band === 2 ? 230 : 40; data[i + 3] = 255;
    if (x < 16 && y >= 48) { data[i + 3] = 100; }
  }
  return data;
}
/** Target card box for this frame (shifts slightly right each frame when `slide` is true) */
const targetBox = (frame, slide) => ({ x: 30 + (slide ? frame * 2 : 0), y: 20, w: 24, h: 16 });
/** Image with target card: inside box is "filtered lower layer" (here average color of whole block darkened) plus a line of white text, 4-pixel shadow outside box */
function upperPixels(frame, { drift = 0, slide = false } = {}) {
  const data = lowerPixels(frame, drift);
  const box = targetBox(frame, slide);
  for (let y = box.y - 4; y < box.y + box.h + 4; y++) for (let x = box.x - 4; x < box.x + box.w + 4; x++) {
    if (x < 0 || y < 0 || x >= STAGE.width || y >= STAGE.height) continue;
    const i = (y * STAGE.width + x) * 4;
    const inside = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
    if (inside) {
      const text = y === box.y + 6 && x % 3 === 0, tone = (frame % 5) * 12;
      data[i] = text ? 255 : 60 + tone; data[i + 1] = text ? 255 : 62 + tone; data[i + 2] = text ? 255 : 70 + tone; data[i + 3] = 255;
    } else {
      data[i] = Math.round(data[i] * 0.7); data[i + 1] = Math.round(data[i + 1] * 0.7); data[i + 2] = Math.round(data[i + 2] * 0.7);
    }
  }
  return data;
}

/**
 * Fake prerender room, paired with real `bakeStream`. Page state only includes: current frame,
 * whether target card is hidden, screenshot count.
 *   present(frame)  whether target card is on page at this frame
 *   stale           first screenshot after hiding still returns pre-hide image (stale image from
 *                   previous tick in compositor)
 *   drifting        lower layer takes an extra step per screenshot (invalid page)
 *   stuck           cannot hide (computed opacity is not 0)
 *   failLower       throws error when taking screenshot while hidden
 *   slide           target card moves right each frame
 */
function fakeBakery({ present = () => true, stale = false, drifting = false, stuck = false, failLower = false, slide = false } = {}) {
  const log = [];
  let frame = 0, hidden = false, shots = 0, staleNext = false, clip = { x: 0, y: 0, ...{ w: STAGE.width, h: STAGE.height } };
  const bakery = {
    log,
    page: {
      async evaluate(fn, ...args) {
        if (fn === pageHideTarget) {
          log.push(`hide:${frame}:${args[0]}`);
          if (!present(frame)) return { ok: true, absent: true, reason: null, glass: [] };
          if (stuck) return { ok: false, absent: false, reason: 'not-hidden', glass: [] };
          hidden = true; staleNext = stale;
          const box = targetBox(frame, slide);
          return { ok: true, absent: false, reason: null, glass: [{ x: box.x, y: box.y, w: box.w, h: box.h }] };
        }
        if (fn === pageShowTarget) { log.push(`show:${frame}`); hidden = false; return true; }
        const src = String(fn);
        if (src.includes('__pcTimeline')) return { fps: 30, ...STAGE, duration: 2 };
        if (src.includes('__pcSetT')) { frame = Math.round(args[0].sec * 30); log.push(`step:${frame}`); return { raf: 0, mut: 0 }; }
        if (src.includes('__pcPrepareFrameMedia')) { log.push(`media:${frame}`); return null; }
        return null;
      },
      async setViewport() {},
      viewport: () => ({ ...STAGE, deviceScaleFactor: 1 }),
    },
    client: { async send(method, params) { if (method === 'Emulation.setDeviceMetricsOverride') clip = params.viewport ? { x: params.viewport.x, y: params.viewport.y, w: params.viewport.width, h: params.viewport.height } : { x: 0, y: 0, w: STAGE.width, h: STAGE.height }; } },
    async beginFrame(extra = {}) {
      // Renders a discarded frame (`BELOW_DISCARD_SHOT` in `frame-stream.mjs`): only records which frame it was rendered on
      if (extra.screenshot?.format === 'jpeg') {
        if (extra.screenshot?.quality === 1) log.push(`draw:${frame}`);
        return { screenshotData: 'ok' };
      }
      if (extra.screenshot?.format !== 'png') return {};
      if (hidden && failLower) throw new Error('Screenshot failed');
      const drift = drifting ? shots : 0;
      shots++;
      let visible = present(frame) && !hidden;
      if (hidden && staleNext) { visible = true; staleNext = false; }
      log.push(`shot:${frame}:${visible ? 'upper' : 'lower'}:${clip.w}x${clip.h}`);
      const full = visible ? upperPixels(frame, { drift, slide }) : lowerPixels(frame, drift);
      return { screenshotData: pngOf(cropOf(full, clip), clip.w, clip.h).toString('base64') };
    },
    async waitNet() {},
    async reset() { bakery.page = { ...bakery.page }; hidden = false; },
  };
  return bakery;
}
const VIEW = { x: 0, y: 0, w: STAGE.width, h: STAGE.height };
/** A segment: real `bakeStream` plus `belowSegmentCapture`. Returns what is yielded for each frame */
async function capture(bakery, { from = 0, to = 4, stride = 1, rect = VIEW, record = newBelowRecord(), verify = true, signature = 'S', notes = [] } = {}) {
  const frames = new Map();
  await bakeStream(bakery, { streamSignature: signature, fromFrame: from, toFrame: to, stride, fps: 30, mountFrame: 0, clip: VIEW,
    capture: belowSegmentCapture(bakery, { clipId: 'target', view: VIEW, rect, record, verify, note: m => notes.push(m) }),
    onFrame: async (frame, shot) => { frames.set(frame, shot); } });
  return { frames, record, notes };
}
/** Operations from `mark` onwards (excluding warmup) */
const opsOf = (bakery, frame) => {
  const start = bakery.log.lastIndexOf(`step:${frame}`);
  const next = bakery.log.indexOf(`step:${frame + 1}`, start + 1);
  return bakery.log.slice(start + 1, next < 0 ? undefined : next);
};

test('BD-order the order of taking the two screenshots: upper, hide, lower, unhide; time is not advanced between the two; the first frame of each segment takes two extra screenshots for a real measurement', async () => {
  const bakery = fakeBakery();
  const { frames, record } = await capture(bakery, { from: 0, to: 4 });
  // Frame 0 (first frame of segment): upper capture (none captured before, discard one first) → hide → lower capture → capture another (sanity check) → revert → capture another (sanity check)
  assert.deepEqual(opsOf(bakery, 0), ['shot:0:upper:96x64', 'shot:0:upper:96x64', 'hide:0:target', 'shot:0:lower:96x64', 'shot:0:lower:96x64', 'show:0', 'shot:0:upper:96x64']);
  // Subsequent frames: upper capture → hide → lower capture → revert
  for (const f of [1, 2, 3, 4]) assert.deepEqual(opsOf(bakery, f), [`shot:${f}:upper:96x64`, `hide:${f}:target`, `shot:${f}:lower:96x64`, `show:${f}`], `Frame ${f}`);
  // Time is not stepped between the two captures: no step between each hide and its immediate following revert
  const hideAt = bakery.log.map((op, i) => (op.startsWith('hide:') ? i : -1)).filter(i => i >= 0);
  for (const i of hideAt) {
    const until = bakery.log.findIndex((op, j) => j > i && op.startsWith('show:'));
    assert.ok(until > i);
    assert.ok(bakery.log.slice(i, until).every(op => !op.startsWith('step:')), 'Time was advanced while hidden');
  }
  assert.equal(bakery.log.filter(op => op.startsWith('hide:')).length, bakery.log.filter(op => op.startsWith('show:')).length);
  assert.deepEqual([record.frames, record.checks, record.absent, record.failed, record.primeLower], [5, 1, 0, null, false]);
  assert.deepEqual(record.last, { frame: 0, lowerStable: true, upperStable: true });
  // Each yielded frame composited back onto this frame's lower layer equals this frame's image with target card
  for (const [f, shot] of frames) {
    assert.deepEqual([shot.width, shot.height], [96, 64]);
    const lower = lowerPixels(f), upper = upperPixels(f);
    let worst = 0;
    for (let i = 0; i < 96 * 64; i++) worst = Math.max(worst, backError(pixelAt(shot.rgba, i), pixelAt(lower, i), pixelAt(upper, i)));
    assert.ok(worst <= 1.5, `Frame ${f} maximum difference after compositing back ${worst}`);
    // Areas untouched by target card are fully transparent: not a single opaque pixel outside box and shadow
    const box = targetBox(f, false);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
      const near = x >= box.x - 4 && x < box.x + box.w + 4 && y >= box.y - 4 && y < box.y + box.h + 4;
      if (!near) assert.equal(shot.rgba[(y * 96 + x) * 4 + 3], 0, `(${x},${y}) should be transparent`);
    }
    // Inside the frosted-glass box (opaque lower layer) is opaque
    assert.equal(shot.rgba[((box.y + 2) * 96 + box.x + 2) * 4 + 3], 255);
  }
  // Without sanity checks, the first frame also has only four steps
  const plain = fakeBakery();
  await capture(plain, { from: 0, to: 0, verify: false });
  assert.deepEqual(opsOf(plain, 0), ['shot:0:upper:96x64', 'shot:0:upper:96x64', 'hide:0:target', 'shot:0:lower:96x64', 'show:0']);
});

test('BD-absent frames where the target card has not entered yet: hide nothing, hand out a fully transparent one; the real measurement is left to the first frame where it is present', async () => {
  const bakery = fakeBakery({ present: frame => frame >= 3 });
  const { frames, record } = await capture(bakery, { from: 0, to: 4 });
  for (const f of [0, 1, 2]) {
    assert.ok(frames.get(f).rgba.every(v => v === 0));
    assert.ok(!opsOf(bakery, f).some(op => op.startsWith('show:')), 'No need to unhide if nothing was hidden');
    assert.equal(opsOf(bakery, f).filter(op => op.includes(':lower:')).length, f === 0 ? 2 : 1, 'Only the one screenshot that bakeStream takes itself');
  }
  assert.deepEqual(opsOf(bakery, 3), ['shot:3:upper:96x64', 'hide:3:target', 'shot:3:lower:96x64', 'shot:3:lower:96x64', 'show:3', 'shot:3:upper:96x64']);
  assert.deepEqual([record.frames, record.absent, record.checks], [5, 3, 1]);
  assert.equal(record.last.frame, 3);
  assert.ok(frames.get(3).rgba.some(v => v !== 0));
});

test('BD-stale the first screenshot after hiding shows the stale frame: the real measurement detects it and this segment fails; from then on this stream discards one screenshot before each lower screenshot', async () => {
  const record = newBelowRecord(), notes = [];
  const bakery = fakeBakery({ stale: true });
  await assert.rejects(capture(bakery, { from: 0, to: 4, record, notes }), e => e.code === 'lower-unstable');
  assert.equal(record.primeLower, true);
  assert.equal(record.failed, null, 'Do not mark this stream as dead');
  assert.deepEqual(record.last, { frame: 0, lowerStable: false, upperStable: true });
  assert.ok(notes.some(m => /two consecutive captures differ/.test(m)));
  assert.equal(bakery.log.filter(op => op.startsWith('hide:')).length, bakery.log.filter(op => op.startsWith('show:')).length, 'Unhidden even on failure');
  // Retry: discard one frame before each lower capture, sanity check passes, yielded layer is correct
  const again = fakeBakery({ stale: true });
  const { frames } = await capture(again, { from: 0, to: 2, record, signature: 'S2' });
  assert.deepEqual(opsOf(again, 1), ['shot:1:upper:96x64', 'hide:1:target', 'shot:1:upper:96x64', 'shot:1:lower:96x64', 'show:1']);
  assert.equal(record.last.lowerStable, true);
  const lower = lowerPixels(1), upper = upperPixels(1);
  let worst = 0;
  for (let i = 0; i < 96 * 64; i++) worst = Math.max(worst, backError(pixelAt(frames.get(1).rgba, i), pixelAt(lower, i), pixelAt(upper, i)));
  assert.ok(worst <= 1.5);
});

test('BD-drift a page whose lower layer advances one more step with every extra tick: after unhiding, the upper screenshot has changed, this stream is marked dead, and no wrongly computed frame is handed out', async () => {
  const record = newBelowRecord(), notes = [];
  const bakery = fakeBakery({ drifting: true });
  await assert.rejects(capture(bakery, { from: 0, to: 4, record, notes }), e => e.code === 'upper-changed');
  assert.equal(record.failed, 'upper-changed');
  assert.ok(notes.some(m => /no longer produce/.test(m)));
  assert.equal(bakery.log.filter(op => op.startsWith('hide:')).length, bakery.log.filter(op => op.startsWith('show:')).length);
  // Retry after marked dead: throws on the first frame, no longer hides
  const again = fakeBakery({ drifting: true });
  await assert.rejects(capture(again, { from: 15, to: 16, record, signature: 'S2' }), e => e.code === 'upper-changed');
  assert.equal(again.log.filter(op => op.startsWith('hide:')).length, 0);
});

test('BD-stuck cannot hide, or the screenshot errors while hidden: throw; anything hidden is always unhidden', async () => {
  const stuck = fakeBakery({ stuck: true });
  await assert.rejects(capture(stuck, { from: 0, to: 1 }), e => e.code === 'not-hidden');
  const broken = fakeBakery({ failLower: true });
  await assert.rejects(capture(broken, { from: 0, to: 1 }), /Screenshot failed/);
  assert.deepEqual(broken.log.filter(op => /^(hide|show):/.test(op)), ['hide:0:target', 'show:0']);
});

test('BD-rect the handed-out rectangle is smaller than the screenshot rectangle: both screenshots still capture the whole frame and what is handed out is cropped; throws if the target card changes anything outside the rectangle, carrying the position of that region', async () => {
  const rect = { x: 24, y: 14, w: 40, h: 30 };
  const bakery = fakeBakery();
  const { frames } = await capture(bakery, { from: 0, to: 2, rect });
  assert.ok(bakery.log.filter(op => op.startsWith('shot:')).every(op => op.endsWith(':96x64')), 'Screenshots are always the whole frame');
  const whole = await capture(fakeBakery(), { from: 0, to: 2 });
  for (const f of [0, 1, 2]) {
    assert.deepEqual([frames.get(f).width, frames.get(f).height], [40, 30]);
    assert.equal(Buffer.compare(frames.get(f).rgba, cropOf(whole.frames.get(f).rgba, rect)), 0, `Frame ${f} is identical to computing the whole frame and then cropping`);
  }
  // Target card moves 2 pixels right each frame: by frame 4 shadow right edge exceeds rectangle (rectangle right bound is 64, shadow right edge reaches 30 + 8 + 24 + 4 = 66)
  const record = newBelowRecord();
  const sliding = fakeBakery({ slide: true });
  await assert.rejects(capture(sliding, { from: 0, to: 6, rect, record }), (e) => {
    assert.equal(e.code, 'below-overflow');
    assert.deepEqual(e.box, { x: 64, y: 16, w: 2, h: 24 });
    return true;
  });
  assert.equal(record.overflows, 1);
  assert.equal(record.failed, null);
  assert.throws(() => belowSegmentCapture(fakeBakery(), { clipId: 'target', view: rect, rect: VIEW }), /not inside the screenshot rectangle/);
});

/* ------------------------------------------------------------ Connecting to producer */

const ENV_FP = '0123456789abcdef';
const control = (clipId, start, end, caps) => ({
  clipId, key: `K-${clipId}`, snapshotKey: `S-${clipId}`, cacheContentKey: `C-${clipId}`, capabilities: caps, compositing: caps.compositing, frameMode: caps.frameMode,
  start, end, count: Math.ceil((end - start) * 30), sampling: { firstFrame: Math.ceil(start * 30), fps: { numerator: '30', denominator: '1' }, phase: { numerator: '0', denominator: '1' } },
});
const GLASS_CAPS = { compositing: 'belowDependent', frameMode: 'direct', canvasHeavy: false };
const PLAIN_CAPS = { compositing: 'independent', frameMode: 'stateful', canvasHeavy: false };
const projectOf = ({ media = false } = {}) => ({ ...STAGE, fps: 30, duration: 2, media: media ? [{ id: 'm', kind: 'video', name: 'v.mp4', url: '/v.mp4' }] : [],
  tracks: [
    { id: 't-top', clips: [{ id: 'target', cardId: 'glass', start: 0, end: 2 }] },
    { id: 't-low', clips: [{ id: 'low', cardId: 'plain', start: 0, end: 2 }, ...(media ? [{ id: 'video', mediaId: 'm', start: 0, end: 2 }] : [])] },
  ] });

async function producerFor(project, { below = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-below-capture-'));
  const pipeline = { root, ready: createReadyHub(), prerenderPicked: () => true, captureCode: () => 'C', emptyUrl: () => 'about:blank' };
  const producer = new StreamProducer(pipeline, { env: { PROMPTCUT_STREAM_PREWARM: '0', PROMPTCUT_STREAM_DIRECT: 'off' } });
  producer.attachRoute();
  producer.ffmpeg = 'ffmpeg';
  producer.encoderName = 'libx264';
  const clipIds = project.tracks.flatMap(track => track.clips.map(c => c.id));
  const cardPlan = clipIds.map(id => control(id, 0, 2, id === 'target' ? GLASS_CAPS : PLAIN_CAPS));
  const specs = planStreams({ key: 'E', project, cardPlan }, { envFingerprint: ENV_FP, below });
  const stateOf = (spec) => {
    // `queueOnly`: auto-production does not touch this stream (tests have no real prerender room to borrow), segments are produced one by one by `run` below
    const state = { spec, manifest: producer.freshManifest(spec), isolated: {}, generation: 0, entryKey: 'E', aliases: new Set(), reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set(), queueOnly: true };
    producer.streams.set(spec.streamKey, state);
    return state;
  };
  const run = async (bakery, state, segment, stride) => {
    const task = { state, segment, stride };
    assert.equal(await producer.runSegment(bakery, task), true);
    await task.job;
    const seg = state.manifest.segments[segment];
    assert.ok(seg, `Segment ${segment} was written to disk (${producer.log.map(l => l.message).join(' | ')})`);
    return seg;
  };
  const close = async () => { await producer.close(); await fs.rm(root, { recursive: true, force: true }); };
  return { producer, specs, stateOf, run, close, root };
}
/** ffmpeg decodes a segment into RGB (top half premultiplied color, 8-row gap, bottom half opacity) */
function decode(dir, init, seg) {
  const file = path.join(dir, 'dec.mp4');
  fsSync.writeFileSync(file, Buffer.concat([init, seg]));
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 1 << 28, windowsHide: true });
}

test('BD-produce the producer produces a below-dependent stream: screenshots are always the whole frame and wait for media to be in place; the sparse pass measures the content box and the second pass tightens it; the decoded result composited back over the lower layer equals the frame with the target card', { skip: !ffmpegOk }, async () => {
  const project = projectOf({ media: true });
  const { producer, specs, stateOf, run, close } = await producerFor(project);
  try {
    const spec = specs.find(s => s.kind === 'below');
    assert.ok(spec, 'The plan contains this stream');
    assert.equal(spec.hasMedia, true);
    assert.deepEqual(spec.clipIds, ['target']);
    const state = stateOf(spec);
    const bakery = fakeBakery();
    const segments = [0, 1, 2, 3];
    for (const n of segments) await run(bakery, state, n, SPARSE_STRIDE);
    // Entity box: target card box plus shadow is x 26..57, y 16..39; expanded by 8, clamped to frame, padded to even numbers
    assert.deepEqual(state.measured, { x: 26, y: 16, w: 32, h: 24 });
    assert.deepEqual(state.manifest.tight, { x: 18, y: 8, w: 48, h: 40 });
    assert.ok(bakery.log.filter(op => op.startsWith('shot:')).every(op => op.endsWith(':96x64')), 'The sparse pass captures the whole frame');
    assert.ok(bakery.log.some(op => op.startsWith('media:')), 'Waited for media before the screenshot');
    // The sparse pass only captures the first frame of each segment: frames 1 and 3 are not captured, frame 15 (first frame of segment 1) is captured
    assert.ok(!bakery.log.includes('hide:1:target') && !bakery.log.includes('hide:3:target') && bakery.log.includes('hide:0:target') && bakery.log.includes('hide:15:target'));
    const sparseHides = bakery.log.filter(op => op.startsWith('hide:')).length;
    assert.equal(sparseHides, 4, 'One for each of the four segments');
    // Each segment's position rectangle is recorded in manifest (plane coordinates: this stream uses stage coordinates), which is the region modified by target card in that frame
    for (const n of segments) assert.deepEqual(state.manifest.segments[n].box, { x: 26, y: 16, w: 32, h: 24 }, `Position rectangle of segment ${n}`);
    assert.ok(segments.every(n => state.manifest.segments[n].stride === SEGMENT_FRAMES), 'The stride of a sparse segment records the segment\'s frame count');
    for (const n of segments) await run(bakery, state, n, 1);
    assert.ok(bakery.log.filter(op => op.startsWith('shot:')).every(op => op.endsWith(':96x64')), 'The second pass still captures the whole frame (the screenshot rectangle is not tightened)');
    const status = producer.status().streams[0];
    assert.equal(status.kind, 'below');
    assert.deepEqual([status.below.failed, status.below.primeLower, status.below.overflows, status.below.absent], [null, false, 0, 0]);
    assert.equal(status.below.checks, 8, 'Two passes, each segment gets one real measurement');
    assert.equal(status.below.frames, 4 + 60);
    assert.equal(status.below.glassFrames, 64);
    // Position rectangle remains after densification (reusing sparse segment's)
    for (const n of segments) assert.deepEqual(state.manifest.segments[n].box, { x: 26, y: 16, w: 32, h: 24 });
    // Decodes segment 1: each frame composited back onto this frame's lower layer, compared against this frame's image with target card (inside tight rectangle)
    const seg = state.manifest.segments[1];
    const init = state.manifest.inits[seg.init];
    assert.deepEqual(init.rect, { x: 18, y: 8, w: 48, h: 40 });
    assert.deepEqual([init.width, init.height], [48, 2 * (40 + 8)]);
    const dir = producer.store.dir(spec.streamKey);
    const raw = decode(dir, await fs.readFile(producer.store.initFile(spec.streamKey, seg.init)), await fs.readFile(path.join(dir, seg.file)));
    const rect = init.rect, frameBytes = rect.w * 2 * (rect.h + 8) * 3;
    assert.equal(raw.length, SEGMENT_FRAMES * frameBytes);
    /** The k-th decoded frame composited back onto frame `f` lower layer, compared with frame `truth` image with target card (average difference) */
    const errorAgainst = (k, f, truth = f) => {
      const picture = raw.subarray(k * frameBytes, (k + 1) * frameBytes), lower = lowerPixels(f), upper = upperPixels(truth);
      let sum = 0, n = 0;
      for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
        const o = (y * rect.w + x) * 3, i = ((y + rect.y) * STAGE.width + x + rect.x) * 4;
        const a = picture[(rect.h + 8) * rect.w * 3 + o], keep = 1 - a / 255;
        for (let c = 0; c < 3; c++) { sum += Math.abs(Math.min(picture[o + c], a) + lower[i + c] * keep - upper[i + c]); n++; }
      }
      return sum / n;
    };
    for (let k = 0; k < SEGMENT_FRAMES; k++) {
      const same = errorAgainst(k, 15 + k), other = errorAgainst(k, 15 + k, 15 + ((k + 7) % SEGMENT_FRAMES));
      assert.ok(same <= 6, `Frame ${15 + k} mean difference after compositing back ${same.toFixed(2)}`);
      assert.ok(other > 3 * same && other > 15, `The control (a different moment) is clearly larger: ${other.toFixed(2)} vs ${same.toFixed(2)}`);
    }
  } finally { await close(); }
});

test('BD-widen the tight rectangle is not big enough (in frames the sparse pass did not measure, the target card moved outside): widen the rectangle and redo this segment, which does not count as a failure', { skip: !ffmpegOk }, async () => {
  const { producer, specs, stateOf, run, close } = await producerFor(projectOf());
  try {
    const spec = specs.find(s => s.kind === 'below');
    assert.equal(spec.hasMedia, false);
    const state = stateOf(spec);
    // Target card moves 2 pixels right each frame; sparse pass only measures first frame of segment (frame 0), frame 14 exceeds measured right edge by 28 pixels. Set tight rectangle small to expose it
    const bakery = fakeBakery({ slide: true });
    await run(bakery, state, 0, SPARSE_STRIDE);
    assert.deepEqual(state.measured, { x: 26, y: 16, w: 32, h: 24 });
    state.manifest.tight = { x: 24, y: 14, w: 60, h: 28 };
    const before = producer.stats.failures;
    await assert.rejects(producer.runSegment(bakery, { state, segment: 0, stride: 1 }), e => e.code === 'below-overflow' && e.cancelled === true);
    assert.equal(producer.stats.failures, before, 'Not recorded as a failure');
    assert.ok(state.manifest.tight.x + state.manifest.tight.w >= 86 + 8, `Widened to ${JSON.stringify(state.manifest.tight)}`);
    assert.ok(producer.log.some(l => /tight rectangle widened to/.test(l.message)));
    assert.equal(state.below.overflows >= 1, true);
    assert.equal(bakery.streamLease, null, 'The lease is voided, and the page is reloaded the next time');
    // Retry: keep expanding until it fits (seeing only one more frame each time), finally produce it
    let seg = null;
    for (let attempt = 0; attempt < 8 && !seg; attempt++) {
      const task = { state, segment: 0, stride: 1 };
      try { if (await producer.runSegment(bakery, task)) { await task.job; seg = state.manifest.segments[0]; } } catch (error) { if (error.code !== 'below-overflow') throw error; }
    }
    assert.ok(seg && seg.stride === 1, 'Produced after widening');
    assert.deepEqual(state.manifest.inits[seg.init].rect, state.manifest.tight);
    assert.ok(state.manifest.tight.x + state.manifest.tight.w >= 30 + 28 + 24 + 4, 'Fits the shadow of frame 14');
  } finally { await close(); }
});

test('BD-noreplay the member and the lower layers are all remotion-style (`replay: false`): even when it cannot continue from the previous segment it does not replay from the mount frame; with a motion-style lower layer it does replay', { skip: !ffmpegOk }, async () => {
  // Lower layer is a motion-style card: replay
  const stateful = await producerFor(projectOf());
  try {
    const spec = stateful.specs.find(s => s.kind === 'below');
    assert.equal(spec.replay, true);
    const bakery = fakeBakery();
    await stateful.run(bakery, stateful.stateOf(spec), 2, SPARSE_STRIDE);
    assert.ok(bakery.log.includes('step:0') && bakery.log.includes('step:29'), 'Advanced from the mount frame to this segment');
    assert.equal(stateful.producer.status().streams[0].replayedFrames, 30);
  } finally { await stateful.close(); }
  // Lower layer has only assets (pure asset segments fetch frames directly by time), target card is remotion-style: do not replay
  const direct = await producerFor({ ...STAGE, fps: 30, duration: 2, media: [{ id: 'm', kind: 'video', name: 'v.mp4', url: '/v.mp4' }],
    tracks: [{ id: 't-top', clips: [{ id: 'target', cardId: 'glass', start: 0, end: 2 }] }, { id: 't-low', clips: [{ id: 'video', mediaId: 'm', start: 0, end: 2 }] }] });
  try {
    const spec = direct.specs.find(s => s.kind === 'below');
    assert.equal(spec.replay, false);
    assert.deepEqual(spec.belowClipIds, ['video']);
    const bakery = fakeBakery();
    await direct.run(bakery, direct.stateOf(spec), 2, SPARSE_STRIDE);
    const stepped = bakery.log.filter(op => op.startsWith('step:')).map(op => Number(op.slice(5)));
    assert.equal(Math.min(...stepped), 30, 'Lands directly on the first frame of this segment');
    assert.equal(direct.producer.status().streams.find(s => s.kind === 'below').replayedFrames, 0);
    // Two captures are taken as usual, sanity checks performed as usual
    assert.equal(direct.producer.status().streams.find(s => s.kind === 'below').below.checks, 1);
  } finally { await direct.close(); }
});

test('BD-failed a stream marked dead by the real measurement: automatic production records it as a failure and no longer wastes another reload, and the queue task is reported as non-retryable', { skip: !ffmpegOk }, async () => {
  const { producer, specs, stateOf, close } = await producerFor(projectOf());
  try {
    const spec = specs.find(s => s.kind === 'below');
    const state = stateOf(spec);
    const bakery = fakeBakery({ drifting: true });
    await assert.rejects(producer.runSegment(bakery, { state, segment: 0, stride: SPARSE_STRIDE }), e => e.code === 'upper-changed');
    assert.equal(state.below.failed, 'upper-changed');
    assert.equal(producer.status().streams[0].below.failed, 'upper-changed');
    let resets = 0;
    const counting = { ...bakery, reset: async () => { resets++; } };
    await assert.rejects(producer.runSegment(counting, { state, segment: 1, stride: SPARSE_STRIDE }), e => e.code === 'below-capture-failed' && e.retryable === false);
    assert.equal(resets, 0);
    producer.pipeline.leaseStreamBakery = async () => counting;
    producer.pipeline.returnStreamBakery = () => {};
    await assert.rejects(producer.produceRange({ key: 'E', project: projectOf() }, spec, { from: 0, to: 0 }), e => e.code === 'below-capture-failed' && e.retryable === false);
  } finally { await close(); }
});

test('BD-draw a below-dependent stream that needs replay: every tick that is advanced without capturing an image draws one and discards it (frames other than the first frame in a sparse segment, frames replayed after the lease was broken), not fed to the encoder; streams that do not replay draw nothing', { skip: !ffmpegOk }, async () => {
  const { producer, specs, stateOf, run, close } = await producerFor(projectOf({ media: true }));
  try {
    const spec = specs.find(s => s.kind === 'below');
    assert.equal(spec.replay, true, 'The lower layer is a motion-style card: needs replay');
    const state = stateOf(spec);
    const bakery = fakeBakery();
    // Rendered one discarded frame. When changing screenshot rectangle, `bakeStream` itself also renders
    // one (before pushing first frame, frame number left from previous pass), not counted: count from
    // after first frame pushed in this pass
    const draws = from => { const ops = bakery.log.slice(from); const first = ops.findIndex(op => op.startsWith('step:')); return ops.slice(Math.max(0, first)).filter(op => op.startsWith('draw:')).map(op => Number(op.split(':')[1])); };
    const hides = from => bakery.log.slice(from).filter(op => op.startsWith('hide:')).map(op => Number(op.split(':')[1]));
    // Sparse: segments 0 and 1. Each segment captures only first frame; remaining 14 frames each render and discard
    let mark = bakery.log.length;
    await run(bakery, state, 0, SPARSE_STRIDE);
    await run(bakery, state, 1, SPARSE_STRIDE);
    assert.deepEqual(hides(mark), [0, 15], 'Only the first frames of the two segments capture an image');
    assert.deepEqual(draws(mark), [...Array.from({ length: 14 }, (_, i) => 1 + i), ...Array.from({ length: 14 }, (_, i) => 16 + i)], 'Every other frame draws one');
    assert.deepEqual([state.manifest.segments[0].samples, state.manifest.segments[1].samples], [15, 15], 'The discarded ones do not go into the segments: the sample count is unchanged');
    // Full density, continuing lease: every frame is captured, none need to be discarded
    for (const n of [0, 1]) delete state.manifest.segments[n];
    bakery.streamLease = null;
    mark = bakery.log.length;
    await run(bakery, state, 0, 1);
    await run(bakery, state, 1, 1);
    assert.equal(hides(mark).length, 30);
    // Full density, broken lease producing segment 2 standalone: replays from mount frame to frame 29, rendering one per tick; captures images only from frame 30
    bakery.streamLease = null;
    mark = bakery.log.length;
    const before = state.replayedFrames ?? 0;
    await run(bakery, state, 2, 1);
    assert.deepEqual(draws(mark), Array.from({ length: 30 - spec.mountFrame }, (_, i) => spec.mountFrame + i), 'Every replayed frame was drawn; from frame 30 on nothing is discarded');
    assert.deepEqual(hides(mark), Array.from({ length: 15 }, (_, i) => 30 + i));
    assert.equal(state.manifest.segments[2].samples, 15);
    assert.equal((state.replayedFrames ?? 0) - before, 30 - spec.mountFrame, 'The replayed frame count is recorded as before (the discarded ones do not count as captured frames)');
    assert.ok(bakery.log.slice(mark).filter(op => op.startsWith('media:')).every(op => Number(op.split(':')[1]) >= 30), 'Media is waited for only before frames that are really captured');
    assert.equal(producer.status().streams[0].capture.discarded, 28 + 30 - spec.mountFrame);
  } finally { await close(); }
});

test('BD-card the single-card stream takes the same path as before: only one screenshot per frame, nothing is hidden, no waiting for media, and the screenshot rectangle is still its own rectangle', { skip: !ffmpegOk }, async () => {
  const { producer, specs, stateOf, run, close } = await producerFor(projectOf({ media: true }));
  try {
    const spec = specs.find(s => s.kind === 'card');
    assert.deepEqual(spec.clipIds, ['low']);
    const state = stateOf(spec);
    const bakery = fakeBakery();
    await run(bakery, state, 0, 1);
    assert.equal(bakery.log.filter(op => /^(hide|show|media):/.test(op)).length, 0);
    assert.equal(bakery.log.filter(op => op.startsWith('shot:')).length, 16, 'Discard one on the first frame first, then one per frame afterwards');
    assert.equal(producer.status().streams.find(s => s.kind === 'card').below, null);
    // Toggle is off: no below-dependent streams in the plan
    const off = await producerFor(projectOf({ media: true }), { below: false });
    assert.deepEqual(off.specs.map(s => s.kind), ['card']);
    await off.close();
  } finally { await close(); }
});

/* ------------------------------------------------------------ Keys */

test('BD-keys BELOW_STREAM_VERSION is 2; capture-below.mjs goes into the screenshot code fingerprint (the stream\'s codeVersion) but not into the code fingerprint for generating snapshots', async () => {
  assert.equal(BELOW_STREAM_VERSION, 2);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-frame-code-below-'));
  try {
    const file = 'server/bakery/capture-below.mjs';
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), 'a');
    const capture0 = captureCode(root), snapshot0 = snapshotCode(root);
    fsSync.writeFileSync(path.join(root, file), 'b');
    invalidateFrameCode(root);
    assert.notEqual(captureCode(root), capture0, 'Changing it changes the stream\'s code fingerprint too');
    assert.equal(snapshotCode(root), snapshot0, 'The code fingerprint for generating snapshots does not change');
  } finally { invalidateFrameCode(root); await fs.rm(root, { recursive: true, force: true }); }
});
