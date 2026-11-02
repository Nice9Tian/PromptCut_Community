/**
 * Node-side unit tests for direct canvas capture (render refactor "Ji-1",
 * `docs/plan/prerender-products-contract.md` Sections 6.1 and 6.2):
 * `server/bakery/capture-canvas.mjs`. Run: `npm test -- server/test/capture-canvas.test.mjs`
 *
 *   - Decode PNG into RGBA: five filter types, RGB / RGBA two color types, byte-for-byte identical
 *     to pngjs decoding output; returns null if unrecognized;
 *   - Page compresses fully transparent runs (`packTransparentRuns` from
 *     `src/render/gl/canvasGrab.ts`) then restores them, byte-for-byte identical; throws on
 *     out-of-bounds data;
 *   - Difference between two images: average difference in premultiplied color and opacity,
 *     number of distinctly different pixels; RGB in fully transparent areas does not count;
 *   - Entity box: measures the exact same box as `pngAlphaBox` on the screenshot path;
 *   - How a segment determines which path to take (`directSegmentCapture`): **grab canvas first,
 *     screenshot second**; if it passes actual measurement, use direct capture; if there are
 *     objects outside the canvas (differences detected), this stream switches to screenshot from
 *     then on and records diagnostics; segments not faster than screenshot continue using
 *     screenshot and pause for several segments; if a frame cannot be captured midway, fall back
 *     to screenshot instead of returning an empty image; `always` tier ignores speed.
 * No Chrome needed: prerender room is fake, and page hook responses are provided by tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import {
  decodePngRgba, unpackCanvasPixels, compareRgba, rgbaAlphaBox, grabCanvas, directSegmentCapture, newDirectRecord,
  directCaptureMode, directBadLimit, DIRECT_BAD_DIFF, DIRECT_COOLDOWN_SEGMENTS, DIRECT_MAX_FILL,
} from '../bakery/capture-canvas.mjs';
import { packTransparentRuns } from '../../src/render/gl/canvasGrab.ts';
import { pngAlphaBox } from '../frame-stream.mjs';

/**
 * Synthesize a straight RGBA image: several opaque / translucent color blocks, the rest fully
 * transparent (RGB is 0 in fully transparent areas, same as what getImageData returns)
 */
function synth(width, height, seed = 1, fill = 0.2) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 16) & 255; };
  const data = Buffer.alloc(width * height * 4);
  const blocks = Math.max(1, Math.round(fill * 10));
  for (let b = 0; b < blocks; b++) {
    const x0 = rnd() % Math.max(1, width - 8), y0 = rnd() % Math.max(1, height - 6);
    const w = 3 + (rnd() % 12), h = 2 + (rnd() % 8);
    for (let y = y0; y < Math.min(height, y0 + h); y++) for (let x = x0; x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * 4;
      const a = b % 2 ? 255 : 1 + (rnd() % 254);
      data[i] = rnd(); data[i + 1] = rnd(); data[i + 2] = rnd(); data[i + 3] = a;
    }
  }
  return data;
}
const pngOf = (data, width, height, options = {}) => {
  const png = new PNG({ width, height });
  data.copy(png.data);
  return PNG.sync.write(png, options);
};
const pack = (rgba) => {
  // The page side receives a Uint8ClampedArray aligned to 4 bytes; Buffer may land at any offset
  // in the pool, make a copy first
  const packed = packTransparentRuns(new Uint8ClampedArray(rgba));
  return packed ? Buffer.from(packed) : null;
};

test('decodePngRgba: all five filter types, RGBA and RGB are byte-for-byte identical to what pngjs decodes; anything it cannot recognize returns null', () => {
  const width = 37, height = 23;
  const data = synth(width, height, 7, 0.9);
  for (const filterType of [0, 1, 2, 3, 4, -1]) {
    const decoded = decodePngRgba(pngOf(data, width, height, { filterType }));
    assert.ok(decoded, `filter type ${filterType} decodes`);
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    assert.equal(Buffer.compare(decoded.data, data), 0, `filter type ${filterType} is byte-for-byte identical`);
  }
  // RGB (color type 2): pad opacity with 255
  const opaque = Buffer.from(data);
  for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
  const rgb = decodePngRgba(pngOf(opaque, width, height, { colorType: 2, inputHasAlpha: true }));
  assert.equal(Buffer.compare(rgb.data, opaque), 0, 'an RGB PNG decodes to opaque RGBA');
  // Unrecognized: not PNG, truncated, 16-bit
  assert.equal(decodePngRgba(Buffer.from('not a png at all, definitely not a png')), null);
  assert.equal(decodePngRgba(pngOf(data, width, height).subarray(0, 60)), null);
  assert.equal(decodePngRgba('string'), null);
});

test('packTransparentRuns ↔ unpackCanvasPixels: the restored output is byte-for-byte identical; returns null if the packed result is not smaller than the original; out-of-bounds data throws', () => {
  const width = 64, height = 48;
  for (const seed of [1, 2, 3]) {
    const rgba = synth(width, height, seed, 0.3);
    const packed = pack(rgba);
    assert.ok(packed, 'a sparse frame can be packed');
    assert.ok(packed.length < rgba.length / 2, `clearly smaller after packing (${packed.length} / ${rgba.length})`);
    assert.equal(Buffer.compare(unpackCanvasPixels(packed, width, height), rgba), 0);
  }
  // Entirely fully transparent: one run header, restores to all zeros
  const empty = Buffer.alloc(width * height * 4);
  const packedEmpty = pack(empty);
  assert.equal(packedEmpty.length, 8);
  assert.equal(Buffer.compare(unpackCanvasPixels(packedEmpty, width, height), empty), 0);
  // Entirely opaque: cannot be compressed, delivered as-is
  const full = Buffer.alloc(width * height * 4, 200);
  assert.equal(pack(full), null);
  // Pixel-by-pixel alternation: more headers than pixels, also delivered as-is
  const alt = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 2) alt.fill(255, i * 4, i * 4 + 4);
  assert.equal(pack(alt), null);
  // Out of bounds / incomplete
  const bad = Buffer.alloc(16);
  bad.writeUInt32LE(width * height - 1, 0); bad.writeUInt32LE(2, 4);
  assert.throws(() => unpackCanvasPixels(bad, width, height), /out of bounds/);
  assert.throws(() => unpackCanvasPixels(Buffer.alloc(5), width, height), /incomplete/);
});

test('compareRgba: compares premultiplied color and opacity; RGB does not count where fully transparent; clearly different pixels are counted separately', () => {
  const width = 10, height = 10;
  const a = Buffer.alloc(width * height * 4), b = Buffer.alloc(width * height * 4);
  assert.deepEqual(compareRgba(a, b, width, height), { color: 0, alpha: 0, bad: 0, pixels: 100 });
  // Different RGB in fully transparent areas: not counted as difference
  b[0] = 255; b[1] = 255; b[2] = 255;
  assert.equal(compareRgba(a, b, width, height).color, 0);
  // One pixel changes from fully transparent to opaque white: opacity difference 255 / 100,
  // premultiplied color difference 255 × 3 / 300
  b[3] = 255;
  const one = compareRgba(a, b, width, height);
  assert.equal(one.alpha, 2.55);
  assert.equal(one.color, 2.55);
  assert.equal(one.bad, 1);
  // Color difference in translucent areas calculated using premultiplied color: for straight
  // color with same difference of 100, premultiplied difference is 20 when opacity is 51 (one fifth)
  const c = Buffer.alloc(width * height * 4), d = Buffer.alloc(width * height * 4);
  c[4] = 100; c[7] = 51; d[4] = 200; d[7] = 51;
  const half = compareRgba(c, d, width, height);
  assert.equal(half.alpha, 0);
  assert.ok(Math.abs(half.color - 20 / 300) < 1e-9);
  assert.equal(half.bad, 0, `a difference of 20 does not reach ${DIRECT_BAD_DIFF}, so it is not clearly different`);
  assert.throws(() => compareRgba(a.subarray(0, 8), b, width, height));
  assert.equal(directBadLimit(1920, 1080), 103);
  assert.equal(directBadLimit(64, 64), 4, 'small rectangles have a floor value');
});

test('rgbaAlphaBox: measures the same box as pngAlphaBox on the screenshot path', () => {
  const width = 80, height = 60;
  for (const seed of [11, 12, 13]) {
    const rgba = synth(width, height, seed, 0.2);
    assert.deepEqual(rgbaAlphaBox(rgba, width, height), pngAlphaBox(pngOf(rgba, width, height)));
  }
  assert.equal(rgbaAlphaBox(Buffer.alloc(width * height * 4), width, height), null);
});

test('directCaptureMode: defaults to always; 0 / off turns it off; auto decides by speed', () => {
  assert.equal(directCaptureMode({}), 'always');
  assert.equal(directCaptureMode({ PROMPTCUT_STREAM_DIRECT: '1' }), 'always');
  assert.equal(directCaptureMode({ PROMPTCUT_STREAM_DIRECT: '0' }), 'off');
  assert.equal(directCaptureMode({ PROMPTCUT_STREAM_DIRECT: 'off' }), 'off');
  assert.equal(directCaptureMode({ PROMPTCUT_STREAM_DIRECT: 'auto' }), 'auto');
  assert.equal(directCaptureMode({ PROMPTCUT_STREAM_DIRECT: 'always' }), 'always');
});

/* ------------------------------------------------------------ Fake prerender room */

const RECT = { x: 40, y: 20, w: 64, h: 48 };

/**
 * Page hook responses are provided by `answer(frame, opts)`: returns `{ rgba }` (pixels in the
 * canvas for this frame) or `{ reason }` (cannot capture).
 * `log` records the order of each step (`grab` / `shot`), verifying "grab canvas first,
 * screenshot second".
 */
function fakeBakery(answer, log) {
  let frame = 0;
  return {
    setFrame: (n) => { frame = n; },
    page: {
      evaluate: async (_fn, clipId, rect, opts) => {
        log.push(`grab:${frame}`);
        assert.equal(clipId, 'clip-c');
        assert.deepEqual(rect, RECT);
        const a = answer(frame, opts);
        if (a.reason) return { ok: false, reason: a.reason, bytes: a.bytes, readMs: 1, packMs: 0 };
        const packed = pack(a.rgba);
        const bytes = packed ?? a.rgba;
        if (opts.maxBytes !== undefined && bytes.length > opts.maxBytes) return { ok: false, reason: 'dense', bytes: bytes.length, readMs: 1, packMs: 0 };
        return { ok: true, w: rect.w, h: rect.h, packed: !!packed, b64: bytes.toString('base64'), bytes: bytes.length, readMs: a.readMs ?? 1, packMs: 0 };
      },
    },
  };
}
/**
 * Run a segment: `shots(frame)` is pixels captured by screenshot for this frame;
 * `delay` slows down screenshot (used to measure speed).
 */
async function runSegment(capture, bakery, log, { frames, shots, primed = () => false, shotDelayMs = 0 }) {
  const out = [];
  for (const frame of frames) {
    bakery.setFrame(frame);
    const shoot = async () => {
      log.push(`shot:${frame}`);
      if (shotDelayMs) await new Promise((r) => setTimeout(r, shotDelayMs));
      return pngOf(shots(frame), RECT.w, RECT.h);
    };
    out.push(await capture(frame, shoot, { primed: primed(frame) }));
  }
  return out;
}
const frameOf = (n) => synth(RECT.w, RECT.h, 100 + n, 0.2);

test('grabCanvas: packed pixels are restored into a full RGBA frame; a size mismatch or corrupt data does not count as grabbed', async () => {
  const log = [];
  const rgba = frameOf(1);
  const ok = await grabCanvas(fakeBakery(() => ({ rgba }), log), 'clip-c', RECT);
  assert.equal(ok.ok, true);
  assert.equal(Buffer.compare(ok.rgba, rgba), 0);
  assert.equal(ok.width, RECT.w);
  assert.ok(ok.readMs >= 0 && ok.moveMs >= 0);
  const miss = await grabCanvas(fakeBakery(() => ({ reason: 'gl-frame' }), log), 'clip-c', RECT);
  assert.deepEqual([miss.ok, miss.reason], [false, 'gl-frame']);
  const noHook = await grabCanvas({ page: { evaluate: async () => ({ ok: false, reason: 'no-hook' }) } }, 'clip-c', RECT);
  assert.equal(noHook.reason, 'no-hook');
  const wrong = await grabCanvas({ page: { evaluate: async () => ({ ok: true, w: 2, h: 2, packed: false, b64: '', bytes: 0 }) } }, 'clip-c', RECT);
  assert.equal(wrong.reason, 'bad-size');
  const garbage = await grabCanvas({ page: { evaluate: async () => ({ ok: true, w: RECT.w, h: RECT.h, packed: true, b64: Buffer.alloc(5).toString('base64'), bytes: 5 }) } }, 'clip-c', RECT);
  assert.equal(garbage.reason, 'bad-data');
});

test('one segment: the first frame grabs the canvas first and then takes a screenshot, and once compared, the remaining frames only grab the canvas without taking screenshots', async () => {
  const log = [], record = newDirectRecord();
  const bakery = fakeBakery((frame) => ({ rgba: frameOf(frame) }), log);
  const capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: true });
  const out = await runSegment(capture, bakery, log, { frames: [30, 31, 32, 33], shots: frameOf });
  assert.deepEqual(log, ['grab:30', 'shot:30', 'grab:31', 'grab:32', 'grab:33'], 'only the first frame takes a screenshot, and it comes after grabbing the canvas');
  for (const [i, frame] of [30, 31, 32, 33].entries()) {
    assert.equal(out[i].width, RECT.w);
    assert.equal(Buffer.compare(out[i].rgba, frameOf(frame)), 0, `frame ${frame} hands over the canvas pixels`);
  }
  assert.equal(record.failed, null);
  assert.deepEqual([record.segments, record.frames, record.checks, record.misses], [1, 4, 1, 0]);
  assert.deepEqual([record.last.frame, record.last.pass, record.last.color, record.last.bad], [30, true, 0, 0]);
});

test('there are other elements outside the canvas (the screenshot has an extra piece beyond the canvas): this stream uses screenshots from now on, records a diagnostic, and hands over a PNG', async () => {
  const log = [], record = newDirectRecord(), notes = [];
  const withExtra = (frame) => {
    const rgba = Buffer.from(frameOf(frame));
    // An element outside the canvas: a 20×10 opaque color block
    for (let y = 30; y < 40; y++) for (let x = 5; x < 25; x++) rgba.fill(255, (y * RECT.w + x) * 4, (y * RECT.w + x) * 4 + 4);
    return rgba;
  };
  const bakery = fakeBakery((frame) => ({ rgba: frameOf(frame) }), log);
  const capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, note: (m) => notes.push(m) });
  const out = await runSegment(capture, bakery, log, { frames: [0, 1, 2], shots: withExtra });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'shot:1', 'shot:2'], 'after the first frame shows a difference, the remaining frames no longer ask the canvas');
  for (const [i, frame] of [0, 1, 2].entries()) {
    assert.ok(Buffer.isBuffer(out[i]), 'what is handed over is a screenshot');
    assert.equal(Buffer.compare(decodePngRgba(out[i]).data, withExtra(frame)), 0);
  }
  assert.equal(record.failed, 'differs');
  assert.equal(record.last.pass, false);
  assert.ok(record.last.bad > record.last.badLimit, 'the number of clearly different pixels exceeded the limit');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Direct canvas capture failed.*screenshots as before/);
  assert.deepEqual([record.segments, record.frames], [0, 0]);
});

test('the average difference is within 1 but a small patch is clearly different (a small element in a sparse frame): still fails', async () => {
  const log = [], record = newDirectRecord();
  const withDot = (frame) => {
    const rgba = Buffer.from(frameOf(frame));
    // 3×3 opaque small block: average opacity difference 255 × 9 / 3072 = 0.75, less than 1
    for (let y = 0; y < 3; y++) for (let x = 60; x < 63; x++) rgba.fill(255, (y * RECT.w + x) * 4, (y * RECT.w + x) * 4 + 4);
    return rgba;
  };
  const bakery = fakeBakery((frame) => ({ rgba: frameOf(frame) }), log);
  const capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record });
  // Make those 9 pixels originally fully transparent (replacing with a base image that did not
  // draw to top right corner is hard to guarantee; verify conclusion directly)
  await runSegment(capture, bakery, log, { frames: [0], shots: withDot });
  assert.ok(record.last.alpha <= 1 && record.last.color <= 1, `the average difference is within limits (color ${record.last.color}, opacity ${record.last.alpha})`);
  assert.ok(record.last.bad > record.last.badLimit, 'but the number of clearly different pixels exceeded the limit');
  assert.equal(record.failed, 'differs');
});

test('the canvas cannot be identified (more than one): this stream does not use direct capture; a frame that happens to fail to be grabbed (plane frame number mismatch) only makes this segment use screenshots', async () => {
  // More than one canvas: permanently disqualify
  let log = [], record = newDirectRecord();
  let bakery = fakeBakery(() => ({ reason: 'canvas-count:2' }), log);
  let capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record });
  let out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: frameOf });
  assert.equal(record.failed, 'canvas-count:2');
  assert.ok(out.every(Buffer.isBuffer));
  // Frame number mismatch: do not permanently disqualify
  log = []; record = newDirectRecord();
  bakery = fakeBakery(() => ({ reason: 'gl-frame' }), log);
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record });
  out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: frameOf });
  assert.equal(record.failed, null, 'the next segment will try again');
  assert.equal(record.misses, 1);
  assert.deepEqual(log, ['grab:0', 'shot:0', 'shot:1']);
  assert.ok(out.every(Buffer.isBuffer), 'everything this segment hands over is a screenshot, with no empty images');
});

test('a frame in the middle of a segment cannot be grabbed: that frame falls back to a screenshot, decoded to RGBA and then handed over, with no empty image handed over and no format change; if the screenshot cannot be decoded either, it throws', async () => {
  const log = [], record = newDirectRecord();
  const bakery = fakeBakery((frame) => (frame === 2 ? { reason: 'gl-frame' } : { rgba: frameOf(frame) }), log);
  const capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: true });
  const out = await runSegment(capture, bakery, log, { frames: [0, 1, 2, 3], shots: frameOf });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'grab:1', 'grab:2', 'shot:2', 'grab:3']);
  assert.ok(out.every((x) => x.rgba && x.width === RECT.w), 'all four frames are raw pixels');
  assert.equal(Buffer.compare(out[2].rgba, frameOf(2)), 0, 'the frame that could not be grabbed was decoded from a screenshot, not an empty image');
  assert.deepEqual([record.misses, record.frames, record.segments], [1, 3, 1]);
  // Screenshot cannot be decoded either
  const bakery2 = fakeBakery((frame) => (frame === 1 ? { reason: 'gl-frame' } : { rgba: frameOf(frame) }), []);
  const capture2 = directSegmentCapture(bakery2, { clipId: 'clip-c', rect: RECT, record: newDirectRecord(), always: true });
  bakery2.setFrame(0);
  await capture2(0, async () => pngOf(frameOf(0), RECT.w, RECT.h), { primed: false });
  bakery2.setFrame(1);
  await assert.rejects(capture2(1, async () => Buffer.from('broken'), { primed: false }), /screenshot cannot be decoded either/);
});

test('auto mode: a segment where direct capture is no faster than a screenshot still uses a screenshot, then pauses direct capture for a few segments; a frame that is too full is not even transferred', async () => {
  // Direct capture is slow (page reports 500 ms reading pixels), screenshot is fast: this
  // segment uses screenshot
  let log = [], record = newDirectRecord();
  let bakery = fakeBakery((frame) => ({ rgba: frameOf(frame), readMs: 500 }), log);
  let capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: false });
  let out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: frameOf });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'shot:1']);
  assert.ok(out.every(Buffer.isBuffer));
  assert.equal(record.failed, null, 'passed the measurement, just not worthwhile, so not counted as failed');
  assert.deepEqual([record.slowSegments, record.cooldown, record.segments], [1, DIRECT_COOLDOWN_SEGMENTS, 0]);
  assert.equal(record.last.pass, true);
  assert.ok(record.last.grabMs >= 500 && record.last.shotMs < 500);
  // Direct capture is fast, screenshot is slow: use direct capture
  log = []; record = newDirectRecord();
  bakery = fakeBakery((frame) => ({ rgba: frameOf(frame), readMs: 0 }), log);
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: false });
  out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: frameOf, shotDelayMs: 120 });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'grab:1']);
  assert.deepEqual([record.slowSegments, record.cooldown, record.segments, record.frames], [0, 0, 1, 2]);
  // Direct capture is faster per frame than screenshot, but this segment has only one frame
  // left to save, which cannot offset the extra screenshot spent on actual measurement:
  // continue using screenshot
  log = []; record = newDirectRecord();
  bakery = fakeBakery((frame) => ({ rgba: frameOf(frame), readMs: 0 }), log);
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, captures: 2, always: false });
  out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: frameOf, shotDelayMs: 40 });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'shot:1']);
  assert.ok(record.last.grabMs < record.last.shotMs, 'per frame alone, direct capture is faster');
  assert.deepEqual([record.slowSegments, record.segments], [1, 0], 'but the savings do not offset the extra time spent on the measurement');
  // Screenshot discarded one frame first (primed): screenshot duration per frame is counted at
  // half; sparse segments must discard one frame first for each frame, counted at double
  log = []; record = newDirectRecord();
  bakery = fakeBakery((frame) => ({ rgba: frameOf(frame), readMs: 0 }), log);
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: false });
  await runSegment(capture, bakery, log, { frames: [0], shots: frameOf, shotDelayMs: 100, primed: () => true });
  const halved = record.last.shotMs;
  record = newDirectRecord();
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, stride: 15, always: false });
  await runSegment(capture, bakery, log, { frames: [0], shots: frameOf, shotDelayMs: 100, primed: () => true });
  assert.ok(record.last.shotMs > halved * 1.5, `a sparse segment is counted at double (${record.last.shotMs} vs ${halved})`);
  // Frame too full: after compression exceeds DIRECT_MAX_FILL of original size; do not
  // transfer or compare, this segment uses screenshot
  log = []; record = newDirectRecord();
  const full = Buffer.alloc(RECT.w * RECT.h * 4, 200);
  bakery = fakeBakery(() => ({ rgba: full }), log);
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: false });
  out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: () => full });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'shot:1']);
  assert.deepEqual([record.checks, record.slowSegments, record.cooldown, record.last.reason], [0, 1, DIRECT_COOLDOWN_SEGMENTS, 'dense']);
  assert.ok(full.length > RECT.w * RECT.h * 4 * DIRECT_MAX_FILL);
  // always tier: transfer even if too full, ignore speed
  log = []; record = newDirectRecord();
  bakery = fakeBakery(() => ({ rgba: full }), log);
  capture = directSegmentCapture(bakery, { clipId: 'clip-c', rect: RECT, record, always: true });
  out = await runSegment(capture, bakery, log, { frames: [0, 1], shots: () => full });
  assert.deepEqual(log, ['grab:0', 'shot:0', 'grab:1']);
  assert.ok(out.every((x) => x.rgba));
});
