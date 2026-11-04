/**
 * Direct canvas grab (render refactor "Ji-1", `docs/plan/prerender-products-contract.md` sections
 * 6.1 and 6.2): Node side.
 *
 * When canvas and WebGL cards produce track streams, pixel data for this frame bypasses
 * screenshots and PNG: requests canvas RGBA from the page (`src/render/gl/canvasGrab.ts`, mounted
 * on the export page as `window.__pcGrabCanvas`) and delivers it directly to ffmpeg's `rawvideo`
 * input (`openStreamSegmentEncoder({ raw })` in `./ffmpeg.mjs`). Only callers of `bakeStream`
 * (`server/frame-stream.mjs`) use this; the export and snapshot pipelines do not pass through here.
 *
 * # When to use direct grab (the second check in contract section 6.1: stream generation verification)
 *
 * The first frame of each segment (the first frame after mounting is also the first frame of some
 * segment) fetches both: first grabs the canvas pixels, then takes a screenshot as usual, and
 * compares the two pixel-by-pixel by premultiplied color and opacity. Only when mean differences do
 * not exceed `DIRECT_MEAN_LIMIT` and noticeably different pixels do not exceed `directBadLimit` is
 * it considered passed, and remaining frames in this segment fetch only the canvas; if not passed,
 * this stream falls back to screenshots from then on and logs a diagnostic. The order **canvas first,
 * screenshot second** cannot be swapped: the screenshot tick makes the compositor actually draw a
 * frame, so cards that rely on this tick to update canvas (normally direct-grabbed frames lack this
 * tick) will be detected here rather than slipping through.
 *
 * Passing verification does not guarantee using direct grab: pixels are transferred over CDP, and
 * when the picture has many opaque pixels, transferring is even slower than screenshotting
 * (measured numbers in `docs/reports/AGENT-rr-canvas-direct.md`). Therefore, elapsed milliseconds
 * for both paths on the same frame are also measured; if savings from direct grab do not offset extra
 * verification costs, this segment uses screenshots as usual, and the next `DIRECT_COOLDOWN_SEGMENTS`
 * segments will not try it; if pixel data after compressing fully transparent pixels still exceeds
 * `DIRECT_MAX_FILL` of the original size, it is not transferred at all. Which path is chosen does not
 * alter visuals (there is only a choice after passing verification), only speed.
 *
 * # When a frame cannot be grabbed
 *
 * If a frame cannot be grabbed mid-segment (shared WebGL renderer plane frame number mismatch,
 * etc.): fall back to screenshot for this frame, decode into RGBA and feed it, never delivering
 * empty frames or changing the encoder input format. If screenshot decoding also fails, mark this
 * segment failed to re-produce.
 */
import zlib from 'node:zlib';

/**
 * Contract section 6.1: upper limit for mean difference in premultiplied color and opacity
 * (out of 255).
 */
export const DIRECT_MEAN_LIMIT = 1;
/**
 * "Noticeably different" pixels: difference in any premultiplied color component or opacity
 * exceeds this value.
 */
export const DIRECT_BAD_DIFF = 48;
/**
 * Maximum ratio of noticeably different pixels to rectangle area (plus an area-independent base
 * count, see `directBadLimit`).
 */
export const DIRECT_BAD_RATIO = 1 / 20000;
/**
 * After compressing fully transparent pixels, if transfer size exceeds this ratio of original RGBA,
 * do not attempt transfer (transferring this much over CDP is definitely slower than screenshots).
 */
export const DIRECT_MAX_FILL = 0.25;
/**
 * After a segment falls back to screenshots because "direct grab is not faster than screenshots",
 * skip trying for this many subsequent segments (trying once requires an extra fetch and compare).
 */
export const DIRECT_COOLDOWN_SEGMENTS = 8;

/**
 * Three tiers of direct canvas grab (`PROMPTCUT_STREAM_DIRECT`):
 *   - `always` (default): use whenever verification passes, regardless of speed (replaces legacy
 *     auto, 2026-10-14 decision 2.5);
 *   - `auto`: use when verification passes and this segment measures faster than screenshots
 *     (legacy default);
 *   - `off` (also accepts `0`): do not use; screenshot every frame as before (probes use it to
 *     produce comparisons).
 */
export function directCaptureMode(env = process.env) {
  const want = String(env.PROMPTCUT_STREAM_DIRECT ?? '').trim().toLowerCase();
  if (want === '0' || want === 'off') return 'off';
  if (want === 'auto') return 'auto';
  return 'always';
}

/** How many noticeably different pixels are allowed in a rectangle */
export function directBadLimit(width, height) {
  return Math.max(4, Math.floor(width * height * DIRECT_BAD_RATIO));
}

/**
 * Decodes PNG into straight RGBA. Only recognizes the two types given by screenshots: 8-bit,
 * non-interlaced RGBA (color type 6) and RGB (color type 2, opacity padded with 255). Returns null
 * if unrecognized or data is incomplete. Returns `{ width, height, data }` (`data` is a Buffer of
 * `width × height × 4` bytes).
 */
export function decodePngRgba(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  let off = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > buf.length) return null;
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = color === 6 ? 4 : color === 2 ? 3 : 0;
  if (depth !== 8 || interlace || !bpp || !width || !height) return null;
  let raw;
  try { raw = zlib.inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat)); } catch { return null; }
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;
  // In-place unfiltering: each row's result is written back into `raw` itself (after the filter byte
  // at row start); the previous row is already reconstructed.
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1) + 1;
    const up = base - (stride + 1);
    const f = raw[base - 1];
    if (f === 0) continue;
    if (f === 1) {
      for (let i = bpp; i < stride; i++) raw[base + i] = (raw[base + i] + raw[base + i - bpp]) & 255;
    } else if (f === 2) {
      if (y > 0) for (let i = 0; i < stride; i++) raw[base + i] = (raw[base + i] + raw[up + i]) & 255;
    } else if (f === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? raw[base + i - bpp] : 0, b = y > 0 ? raw[up + i] : 0;
        raw[base + i] = (raw[base + i] + ((a + b) >> 1)) & 255;
      }
    } else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? raw[base + i - bpp] : 0, b = y > 0 ? raw[up + i] : 0, c = i >= bpp && y > 0 ? raw[up + i - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        raw[base + i] = (raw[base + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    } else return null;
  }
  const data = Buffer.allocUnsafe(width * height * 4);
  if (bpp === 4) {
    for (let y = 0; y < height; y++) raw.copy(data, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  } else {
    for (let y = 0, o = 0; y < height; y++) {
      let i = y * (stride + 1) + 1;
      for (let x = 0; x < width; x++, i += 3, o += 4) { data[o] = raw[i]; data[o + 1] = raw[i + 1]; data[o + 2] = raw[i + 2]; data[o + 3] = 255; }
    }
  }
  return { width, height, data };
}

/**
 * Decompresses pixels compressed by the page into full straight RGBA (`width × height × 4` bytes).
 * Compression scheme is in `packTransparentRuns` of `src/render/gl/canvasGrab.ts`: a series of
 * `[skip_count, run_count, pixels...]`, little-endian 32-bit. Throws if data is out of bounds or
 * incomplete.
 */
export function unpackCanvasPixels(bytes, width, height) {
  const total = width * height;
  const out = Buffer.alloc(total * 4);
  let i = 0, o = 0;
  while (i < bytes.length) {
    if (i + 8 > bytes.length) throw new Error('canvas pixel run-length data is incomplete');
    const skip = bytes.readUInt32LE(i), count = bytes.readUInt32LE(i + 4);
    i += 8;
    o += skip;
    if (o + count > total || i + count * 4 > bytes.length) throw new Error('canvas pixel run-length data is out of bounds');
    bytes.copy(out, o * 4, i, i + count * 4);
    i += count * 4;
    o += count;
  }
  return out;
}

/**
 * Difference between two straight RGBA images. Colors are compared as premultiplied color
 * (what enters the stream is premultiplied color; RGB does not count where fully transparent).
 * Returns `{ color, alpha, bad, pixels }`: average difference in premultiplied color (averaged
 * across all three components), average opacity difference, visibly different pixels, total pixels.
 */
export function compareRgba(a, b, width, height) {
  const pixels = width * height;
  if (a.length < pixels * 4 || b.length < pixels * 4) throw new Error('compareRgba: data is smaller than the rectangle');
  let color = 0, alpha = 0, bad = 0;
  for (let i = 0, end = pixels * 4; i < end; i += 4) {
    const aa = a[i + 3], ba = b[i + 3];
    if (!aa && !ba) continue;
    let da = aa - ba; if (da < 0) da = -da;
    let dr = (a[i] * aa - b[i] * ba) / 255; if (dr < 0) dr = -dr;
    let dg = (a[i + 1] * aa - b[i + 1] * ba) / 255; if (dg < 0) dg = -dg;
    let db = (a[i + 2] * aa - b[i + 2] * ba) / 255; if (db < 0) db = -db;
    alpha += da;
    color += dr + dg + db;
    if (da > DIRECT_BAD_DIFF || dr > DIRECT_BAD_DIFF || dg > DIRECT_BAD_DIFF || db > DIRECT_BAD_DIFF) bad++;
  }
  return { color: color / (pixels * 3), alpha: alpha / pixels, bad, pixels };
}

/**
 * Bounding box of pixels with opacity greater than `threshold` in straight RGBA
 * (image pixel coordinates); returns null if there are none
 */
export function rgbaAlphaBox(data, width, height, threshold = 0) {
  let minX = width, minY = -1, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4 + 3;
    let first = -1, last = -1;
    for (let x = 0, i = row; x < width; x++, i += 4) if (data[i] > threshold) { if (first < 0) first = x; last = x; }
    if (first < 0) continue;
    if (minY < 0) minY = y;
    maxY = y;
    if (first < minX) minX = first;
    if (last > maxX) maxX = last;
  }
  return maxY < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Asks the page for pixels of clip `clipId`'s canvas within screenshot rectangle `rect`
 * (scene coordinates, integers).
 * Returns `{ ok: true, rgba, width, height, bytes, readMs, moveMs }` (`readMs`: read pixels in page;
 * `moveMs`: compress, move to Node, restore),
 * or `{ ok: false, reason, bytes?, readMs?, moveMs? }` (see `canvasGrab.ts` for reasons;
 * also `no-hook`, `bad-size`, `bad-data`).
 */
export async function grabCanvas(bakery, clipId, rect, { maxBytes } = {}) {
  const started = performance.now();
  const r = await bakery.page.evaluate((id, rc, o) => (typeof window.__pcGrabCanvas === 'function'
    ? window.__pcGrabCanvas(id, rc, o) : { ok: false, reason: 'no-hook' }), clipId, rect, maxBytes === undefined ? {} : { maxBytes });
  const readMs = Number(r?.readMs) || 0;
  const fail = (reason) => ({ ok: false, reason, bytes: r?.bytes, readMs, moveMs: Math.max(0, performance.now() - started - readMs) });
  if (!r?.ok) return fail(r?.reason || 'no-result');
  if (r.w !== rect.w || r.h !== rect.h || typeof r.b64 !== 'string') return fail('bad-size');
  let rgba;
  try {
    const bytes = Buffer.from(r.b64, 'base64');
    rgba = r.packed ? unpackCanvasPixels(bytes, r.w, r.h) : bytes;
  } catch { return fail('bad-data'); }
  if (rgba.length !== r.w * r.h * 4) return fail('bad-data');
  return { ok: true, rgba, width: r.w, height: r.h, bytes: r.bytes, readMs, moveMs: Math.max(0, performance.now() - started - readMs) };
}

/**
 * When the test run fails, which reasons count as "this card cannot use direct capture"
 * (the rest are just this frame happening to be uncapturable)
 */
const PERMANENT_REASONS = /^(differs|canvas-count:\d+|unreadable|no-hook|png)$/;

/**
 * Direct capture record for a stream (attached to `StreamProducer`'s stream state, returned as-is
 * by `status()`)
 */
export function newDirectRecord() {
  return {
    /** Reason why the test run failed; once set, this stream will no longer attempt direct capture */
    failed: null,
    /**
     * Number of remaining segments that will not attempt direct capture (the last test showed
     * it was not faster than screenshots)
     */
    cooldown: 0,
    /**
     * Segments / frames using direct capture; segments keeping screenshots after testing because
     * direct capture was not faster than screenshots (or frame too full); number of test runs;
     * frames falling back to screenshots when capture happened to fail
     */
    segments: 0, frames: 0, slowSegments: 0, checks: 0, misses: 0,
    /**
     * Cumulative time spent (ms): reading pixels in page, compressing and transferring to Node,
     * and test run (that single screenshot plus decode plus comparison)
     */
    readMs: 0, moveMs: 0, checkMs: 0,
    /**
     * Result of the latest test run `{ frame, pass, reason, color, alpha, bad, badLimit, bytes, grabMs, shotMs }`
     * (`bytes`: how many bytes were transferred)
     */
    last: null,
  };
}

/**
 * Used by `bakeStream`'s `capture`: one per segment. `capture(frame, shoot, { primed })` returns
 * what to pass to `onFrame` for this frame:
 * direct capture returns `{ rgba, width, height }`, while screenshot as before returns a PNG
 * Buffer (`shoot()` is that original screenshot).
 * Within a segment, it is either all the former or all the latter (determined by the first frame
 * of this segment); the encoder's input format will not change midway.
 *
 * `record`: direct capture record for this stream (`newDirectRecord`); `stride`: capture every
 * N frames in this segment; `captures`: total captures in this segment;
 * `always`: use direct capture once it passes the test run, regardless of speed (`always` tier
 * of `directCaptureMode`); `note(message)`: record a diagnostic note.
 */
export function directSegmentCapture(bakery, { clipId, rect, record, stride = 1, captures = 15, always = directCaptureMode() === 'always', note = () => {} }) {
  let mode = null;
  const shotAsRgba = async (shoot, why) => {
    const decoded = decodePngRgba(await shoot());
    if (!decoded || decoded.width !== rect.w || decoded.height !== rect.h) throw new Error(`Direct canvas capture: this frame cannot be read (${why}), and the screenshot cannot be decoded either`);
    record.misses++;
    return { rgba: decoded.data, width: rect.w, height: rect.h };
  };
  return async (frame, shoot, { primed = true } = {}) => {
    if (mode === 'shot') return shoot();
    if (mode === 'direct') {
      const got = await grabCanvas(bakery, clipId, rect);
      record.readMs += got.readMs ?? 0;
      record.moveMs += got.moveMs ?? 0;
      if (!got.ok) return shotAsRgba(shoot, got.reason);
      record.frames++;
      return { rgba: got.rgba, width: got.width, height: got.height };
    }
    // First frame of this segment: grab the canvas first, then take a screenshot; use direct capture
    // only if comparison passes and it is not slower than screenshots
    const got = await grabCanvas(bakery, clipId, rect, always ? {} : { maxBytes: Math.floor(rect.w * rect.h * 4 * DIRECT_MAX_FILL) });
    if (!got.ok && got.reason === 'dense') {
      mode = 'shot';
      record.slowSegments++;
      record.cooldown = DIRECT_COOLDOWN_SEGMENTS;
      record.last = { frame, pass: null, reason: 'dense', bytes: got.bytes };
      return shoot();
    }
    const started = performance.now();
    const png = await shoot();
    const shotMs = performance.now() - started;
    record.checks++;
    let verdict;
    if (!got.ok) verdict = { pass: false, reason: got.reason };
    else {
      const ref = decodePngRgba(png);
      if (!ref || ref.width !== rect.w || ref.height !== rect.h) verdict = { pass: false, reason: 'png' };
      else if (ref.data.equals(got.rgba)) verdict = { pass: true, reason: null, color: 0, alpha: 0, bad: 0, badLimit: directBadLimit(rect.w, rect.h) };
      else {
        const diff = compareRgba(got.rgba, ref.data, rect.w, rect.h);
        const badLimit = directBadLimit(rect.w, rect.h);
        const pass = diff.color <= DIRECT_MEAN_LIMIT && diff.alpha <= DIRECT_MEAN_LIMIT && diff.bad <= badLimit;
        verdict = { pass, reason: pass ? null : 'differs', color: +diff.color.toFixed(4), alpha: +diff.alpha.toFixed(4), bad: diff.bad, badLimit };
      }
    }
    const checkMs = performance.now() - started;
    record.checkMs += checkMs;
    record.last = { frame, ...verdict, bytes: got.bytes };
    if (!verdict.pass) {
      mode = 'shot';
      // If capture happens to fail for this frame (plane frame mismatch, card not mounted yet), only
      // this segment falls back to screenshots; if differences are found or canvas is unrecognized,
      // this stream uses screenshots from now on
      if (PERMANENT_REASONS.test(verdict.reason)) {
        record.failed = verdict.reason;
        note(`Direct canvas capture failed (${verdict.reason}${verdict.color === undefined ? '' : `: color difference ${verdict.color}, opacity difference ${verdict.alpha}, clearly different pixels ${verdict.bad}`}), this stream falls back to screenshots as before`);
      } else record.misses++;
      return png;
    }
    /*
     * Cost-effectiveness: how much screenshot costs per frame once settled: full-density segments
     * capture both adjacent frames without dropping one first (when `primed` is true, one extra frame
     * was captured this time, halved); sparse segments must drop a frame before every frame (doubled).
     * Time saved per frame by direct capture, multiplied by remaining frames in this segment, must
     * outweigh the extra time spent on this test run (that screenshot plus decode plus comparison);
     * if not, this segment falls back to screenshots as before.
     */
    const grabMs = got.readMs + got.moveMs;
    const perShot = (primed ? shotMs / 2 : shotMs) * (stride > 1 ? 2 : 1);
    record.last.grabMs = +grabMs.toFixed(2);
    record.last.shotMs = +perShot.toFixed(2);
    if (!always && (perShot - grabMs) * Math.max(0, captures - 1) <= checkMs) {
      mode = 'shot';
      record.slowSegments++;
      record.cooldown = DIRECT_COOLDOWN_SEGMENTS;
      return png;
    }
    mode = 'direct';
    record.segments++;
    record.frames++;
    record.readMs += got.readMs;
    record.moveMs += got.moveMs;
    return { rgba: got.rgba, width: got.width, height: got.height };
  };
}
