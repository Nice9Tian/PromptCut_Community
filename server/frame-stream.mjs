/**
 * Track streams (R8, G1-G6 of task brief `docs/plan/r8-streams-task.md`): the prerender process side.
 *
 * Produces "track streams" for cards in the prerender set: one H.264 stream per heavy card (or group),
 * top half premultiplied RGB, bottom half alpha grayscale, cropped to the entity box, sliced into an
 * fMP4 segment every 15 frames from the stream's own first frame (conversions exist only in
 * `src/render/streamSegments.mjs`). Demuxing, decoding, and compositing on the page side are in
 * `src/render/streamPlayer.ts`.
 *
 * # What is in this file
 *
 *   - fMP4 box slicing and validation (G2: `ftyp + moov` → init, `moof + mdat` → segment, drop `mfra`);
 *   - Stream partitioning (G1): which cards enter streams, upper bound of crop rectangles, merge
 *     into group streams when exceeding decoder budget, isolated project for each stream;
 *   - Stream store (`<storeRoot>/streams/<streamKey>/`): `stream.json` manifest + `init-<id>.mp4` +
 *     `<n>-<hash>.m4s`;
 *   - Production scheduling `StreamProducer` (G4): produce only when idle, `streamPool` sessions,
 *     sparse first then full-density catch-up, lease continuation; sparse version captures only the
 *     first frame of each segment, remaining frames repeat it, measuring this frame's position
 *     rectangle into the manifest (`segments[n].box`);
 *   - Verification and replacement (G6): re-produce segments with invalid signatures, swap in when
 *     new segments arrive, delete old files after a 5-second delay;
 *   - HTTP read endpoint for segment bytes `handleStreamRequest` (route mounted on
 *     `vite-plugin-frames.ts`, see report).
 *
 * # Coordinate systems of the two stream kinds
 *
 *   - **Single-card stream** (`plane: 'local'`): drawn in the **wrapper layer's own coordinate system**:
 *     just like the snapshot plane, x / y / scale / rotation / opacity / fade / motion / emphasis are
 *     not in the stream, added on stage by the wrapper layer as usual (E7 Item 5: "layer order,
 *     overflow, zIndex automatically follow the wrapper layer", "wrapper layer trajectory still
 *     changes with t"). In the isolated project, the card's box is placed in the scene (`offset`),
 *     capture rectangle = plane rectangle + `offset`.
 *   - **Group stream** (`plane: 'stage'`): stage coordinates, wrapper layer appearances of all cards
 *     in the group are drawn into the stream (G1), rendered by `Stage` on `[data-pc-group-plane]` at
 *     the same level as wrapper layers.
 *
 * In addition to planar standalone cards, single-card streams include two types of cards streamed
 * solo (`soloStreamKind`): source-dependent cards (transitions, media effect cards wrapped on videos,
 * rendered together with the video used) and standalone cards whose outer frame uses 3D transform
 * (stream contains the image before transform, wrapper layer transforms as usual when pasted).
 *
 * # Segment "variants"
 *
 * All segments of a stream do not necessarily share the same rectangle: the sparse pass uses the upper
 * bound rectangle, each segment measuring a position rectangle (bounding box of opaque pixels in this
 * frame); after the sparse version for the entire stream is complete, their union is set as the tight
 * rectangle, and the full-density pass uses the tightened rectangle (if the full-density pass finds
 * content hitting an edge of the tight rectangle, enlarge it and start over). If rectangle or encoder
 * differs, `init.mp4` differs: each segment records in the manifest which `init` it uses, and the page
 * configures decoders per segment. Within the same variant, subsequent segments must produce
 * `ftyp + moov` byte-for-byte identical to the stored one; any difference is a new variant (signature change).
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { bakeStream } from './bakery/bake.mjs';
import { directCaptureMode, directSegmentCapture, newDirectRecord, rgbaAlphaBox } from './bakery/capture-canvas.mjs';
import { belowSegmentCapture, newBelowRecord } from './bakery/capture-below.mjs';
import { prepareFrameMedia } from './bakery/frame-media.mjs';
import { findFfmpeg, openStreamSegmentEncoder, pickStreamEncoder, STREAM_ENCODERS, streamFilterIdentity, STREAM_SEGMENT_FRAMES } from './bakery/ffmpeg.mjs';
import { reachableMediaIds } from '../src/kernel/cutIdentity.mjs';
import { flatPlanProject, isolatedFlatProject } from '../src/kernel/cutFlatten.mjs';
import { stripOuterFrameExpr } from '../src/kernel/frameExpr.mjs';
import { mountFrameOf } from '../src/render/frameWindow.mjs';
import { resolveFrameSize } from '../src/kernel/frameSize.mjs';
import { cardStreamIdentity } from './card-identity.mjs';
import { resultKeyOf } from './render-node/fingerprint.mjs';
import { expandProject, streamNeed, multiProjectNode } from './render-node/expand.mjs';
import { planStreamSegments } from './frame-playback.mjs';
import { belowLayersOf, streamInputSig } from '../src/render/streamInputSig.mjs';
import { isStreamOrigin, streamSegmentFirstFrame, streamSegmentFrameCount, streamSegmentLastFrame, streamSegmentOf, streamSegmentSpan } from '../src/render/streamSegments.mjs';
import { belowStreamEligible, belowTargets, BELOW_STREAM_RULES, cardNodeOf, graphCardWithInputs, soloStreamKind, streamEligible } from '../src/render/streamPlanRules.mjs';
import { groupStreams, peakConcurrency, stageStreamPixels, streamCodedPixels, streamCost, STREAM_COUNT_BUDGET } from '../src/render/streamBudget.mjs';

import { StreamStore, readySegmentRanges, handleStreamRequest } from './asset-store/stream-store.mjs';
export { StreamStore, readySegmentRanges, publicManifest, handleStreamRequest } from './asset-store/stream-store.mjs';

export const SEGMENT_FRAMES = STREAM_SEGMENT_FRAMES;
/**
 * Interval for the sparse version: frame count of one segment: each segment captures only its first
 * frame, remaining frames repeat it (only this tier; the previous "one frame every 3 frames" tier was removed).
 * In the manifest, `stride` for sparse segments records this number, while full density records 1;
 * the reading side only checks whether it is greater than 1.
 */
export const SPARSE_STRIDE = STREAM_SEGMENT_FRAMES;
/**
 * Budget for concurrent on-screen track streams is in `src/render/streamBudget.mjs` (pixel count, plus
 * a hard cap on stream count; the page and this side share that copy). This name is the hard cap on
 * stream count, exported as before; `groupStreams` / `peakConcurrency` were also moved there and are
 * re-exported here as is.
 */
export const STREAM_DECODER_BUDGET = STREAM_COUNT_BUDGET;
export { groupStreams, peakConcurrency };
/** G0-b Conclusion 1: `streamPool` defaults to 1, at most 2 */
export const STREAM_POOL_DEFAULT = 1;
export const STREAM_POOL_MAX = 2;
/** G6: Delay deleting old files this long after replacement (there may still be an in-flight request on the page) */
export const REPLACED_DELETE_MS = 5000;
/**
 * Version of the code producing this stream (increment when segment format / coordinate convention
 * changes, invalidating all old streams).
 * 2: Canvas card frames take pixels directly from canvas (`./bakery/capture-canvas.mjs`); single-card
 * stream member keys no longer carry snapshot generation code fingerprints
 * (`docs/plan/prerender-products-contract.md` Section 9.3, both switched together).
 * 3: Segments are sliced every 15 frames from the stream's own first frame (previously from project
 * frame 0), ending at the stream's own last frame (`src/render/streamSegments.mjs`;
 * `docs/plan/html-snapshot-removal-dryrun.md` Section 10.5). Segment number semantics changed,
 * re-produce all old streams.
 * 4: Sparse version captures only the first frame per segment (previously one frame every 3 frames);
 * each segment in the manifest carries a position rectangle `box`; tight rectangle is now determined
 * by position rectangles of each segment, enlarged during full-density pass if content hits the edge.
 * Sparse segments in old manifests lack position rectangles and tight rectangles have a different
 * origin, so do not mix them; re-produce once (this version has not been released yet).
 */
export const STREAM_CODE_VERSION = 4;
/** Upper bound rectangle for single-card streams: leave this many extra pixels outside the box for overflow content (shadows, strokes) */
export const LOCAL_OVERFLOW_PX = 32;
/** Expand the union of segment position rectangles outward by this much (sparse version only measures the first frame of each segment, intermediate frames may slightly exceed; large overflows are caught and enlarged during the full-density pass) */
export const MEASURE_PAD_PX = 8;
/** When content hits an edge of the tight rectangle during full-density pass, after remeasuring: leave at most this many extra pixels on that edge beyond the measured boundary (content will likely keep moving in that direction) */
export const TIGHT_WIDEN_MARGIN_PX = 64;
/** If the tightened area exceeds this ratio of the upper bound, do not tighten (switching variants for nothing yields no gain) */
export const TIGHTEN_MIN_SAVING = 0.15;
/** X1: In queue stream tasks, maximum consecutive attempts to produce a segment (failing or invalidated midway) before abandoning this task (retryable) */
export const QUEUE_SEGMENT_ATTEMPTS = 3;

/** `streams` toggle (task brief: enabled by default; `PROMPTCUT_STREAMS=0` disables) */
export function streamsEnabled(env = process.env) {
  return String(env.PROMPTCUT_STREAMS ?? '1').trim() !== '0';
}

/**
 * Whether to emit "below-dependent streams" (`kind: 'below'`,
 * `docs/plan/prerender-products-contract.md` Section 5). **Enabled by default**.
 *
 * Planning, keys, isolated projects, splitting and claiming, how pixels in the stream are
 * retrieved (differential layer extraction, `./bakery/capture-below.mjs`), and how they are pasted
 * back onto the stage (the plane under the stage root in `src/render/Stage.tsx`) are all implemented
 * and always emitted in production.
 * Only unit tests and probes are given a way to **disable** it: environment variable
 * `PROMPTCUT_TEST_BELOW_STREAMS=0` (unset in production), or passing `below: false` to `planStreams`:
 * used to simulate "old nodes that do not yet recognize this stream" (when new and old nodes coexist
 * in the queue, an old node receiving such a task should report a mismatch and not retry).
 * When disabled, `planStreams` does not emit this stream, so such tasks are not partitioned out,
 * layer tables contain no such rows, and producers do not produce it.
 */
export const BELOW_STREAMS_DEFAULT = true;
export function belowStreamsEnabled(env = process.env) {
  const flag = String(env?.PROMPTCUT_TEST_BELOW_STREAMS ?? '').trim();
  if (flag === '0') return false;
  if (flag === '1') return true;
  return BELOW_STREAMS_DEFAULT;
}

/**
 * Below-dependent streams: frames pushed through without capturing images (playback frames, frames
 * other than the first in sparse pass segments) must still genuinely be drawn once, using this
 * discarded screenshot to draw.
 *
 * Reason (measured separately on the export page on 2026-10-14, bypassing stream production): when a
 * lower-layer motion-style card mounted midway is covered by frosted glass (`backdrop-filter`),
 * during ticks that only push frames without capturing screenshots (`beginFrame` without `screenshot`),
 * this card's animation does not advance on screen: animation time is correct on the page, but composited
 * pixels stay frozen on the frame where it mounted, only starting to move on the next genuine screenshot
 * and remaining behind by that many frames thereafter; this does not happen without frosted glass on top.
 * Capturing a screenshot on every tick (even the cheapest one) fixes it. Quality 1 JPEG at 960×540
 * takes ~4 ms per image.
 * Consequences of not doing this: in sparse versions and full-density segments re-produced after broken
 * leases, that lower-layer card lags by several frames (visuals in the stream are wrong); while the
 * display catches up tick by tick, differential layer extraction self-checks (hiding the target card
 * and revealing it again, where the frame with the target card should remain unchanged) sometimes fail,
 * causing the entire stream to be marked dead.
 */
const BELOW_DISCARD_SHOT = Object.freeze({ format: 'jpeg', quality: 1 });
/** Marker for the discarded frames above between `capture` → `onFrame` in `bakeStream` */
const BELOW_SKIPPED = Object.freeze({ skipped: true });

/**
 * Upper limit on concurrent on-screen streams. Only lowered for probes (`PROMPTCUT_STREAM_DECODERS`:
 * lowered to 1 to force group streams); in production this is just `STREAM_COUNT_BUDGET`; the pixel half
 * of the budget does not change with it (`src/render/streamBudget.mjs`).
 */
export function streamDecoderBudget(env = process.env) {
  const n = Math.round(Number(env.PROMPTCUT_STREAM_DECODERS));
  return Number.isInteger(n) && n >= 1 && n <= STREAM_DECODER_BUDGET ? n : STREAM_DECODER_BUDGET;
}

/** Upper limit for `streamPool`: `PROMPTCUT_STREAM_POOL=1|2`; unset = adapt starting from 1 based on measurements, at most 2 */
export function streamPoolLimit(env = process.env) {
  const n = Math.round(Number(env.PROMPTCUT_STREAM_POOL));
  return n === 1 || n === 2 ? { fixed: n } : { fixed: null };
}

const sha = (data, n = 64) => createHash('sha256').update(data).digest('hex').slice(0, n);
const zlibInflate = data => zlib.inflateSync(data);
const sleep = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });

/* ======================================================================== *
 * fMP4(G2)
 * ======================================================================== */

/** Top-level boxes: [{ type, start, end, header }] */
export function topLevelBoxes(buf) {
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    else if (size === 0) size = buf.length - off;
    if (size < header || off + size > buf.length) break;
    out.push({ type, start: off, end: off + size, header });
    off += size;
  }
  return out;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts']);

/** Recursively finds the first box of a given type, returns `{ payload, start, end }` */
export function findBox(buf, type, start = 0, end = buf.length) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const t = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    else if (size === 0) size = end - off;
    if (size < header || off + size > end) return null;
    if (t === type) return { payload: buf.subarray(off + header, off + size), start: off, end: off + size };
    let inner = null;
    if (CONTAINERS.has(t)) inner = off + header;
    else if (t === 'stsd') inner = off + header + 8;
    else if (t === 'avc1' || t === 'avc3') inner = off + header + 78;
    if (inner !== null) { const hit = findBox(buf, type, inner, off + size); if (hit) return hit; }
    off += size;
  }
  return null;
}

/**
 * Output of a single ffmpeg invocation → `{ init, segments, dropped }`. `ftyp + moov` is init,
 * each pair of `moof + mdat` is a segment, other top-level boxes (`mfra`) are dropped and not written to disk.
 */
export function splitFmp4(buf) {
  const boxes = topLevelBoxes(buf);
  let i = 0, initEnd = 0;
  for (; i < boxes.length && (boxes[i].type === 'ftyp' || boxes[i].type === 'moov'); i++) initEnd = boxes[i].end;
  const segments = [], dropped = [];
  let segStart = -1;
  for (; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.type === 'moof') {
      if (segStart >= 0) segments.push(buf.subarray(segStart, b.start));
      segStart = b.start;
    } else if (b.type !== 'mdat') {
      if (segStart >= 0) { segments.push(buf.subarray(segStart, b.start)); segStart = -1; }
      dropped.push(b.type);
    }
  }
  if (segStart >= 0) segments.push(buf.subarray(segStart));
  return { init: Buffer.from(buf.subarray(0, initEnd)), segments: segments.map(s => Buffer.from(s)), dropped };
}

/** `avcC` → `avc1.PPCCLL` (G5: **codec string assembled from avcC**, level varies with content, cannot be hardcoded) */
export function codecOfAvcC(avcC) {
  const hex = b => b.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}

/** init.mp4 → `{ codec, width, height, timescale }` */
export function initInfo(init) {
  const avcC = findBox(init, 'avcC');
  const avc1 = findBox(init, 'avc1');
  const mdhd = findBox(init, 'mdhd');
  let width = null, height = null, timescale = null;
  if (avc1) { width = avc1.payload.readUInt16BE(24); height = avc1.payload.readUInt16BE(26); }
  if (mdhd) timescale = mdhd.payload.readUInt8(0) === 1 ? mdhd.payload.readUInt32BE(20) : mdhd.payload.readUInt32BE(12);
  return { codec: avcC ? codecOfAvcC(avcC.payload) : null, width, height, timescale };
}

/** One segment → `{ moofs, sampleCount, firstSampleIsSync }` */
export function segmentInfo(seg) {
  const moofs = topLevelBoxes(seg).filter(b => b.type === 'moof').length;
  const tfhd = findBox(seg, 'tfhd');
  const trun = findBox(seg, 'trun');
  let defaultFlags = null, firstFlags = null, sampleCount = 0;
  if (tfhd) {
    const flags = tfhd.payload.readUInt32BE(0) & 0xffffff;
    let o = 8;
    if (flags & 0x1) o += 8;
    if (flags & 0x2) o += 4;
    if (flags & 0x8) o += 4;
    if (flags & 0x10) o += 4;
    if (flags & 0x20) defaultFlags = tfhd.payload.readUInt32BE(o);
  }
  if (trun) {
    const flags = trun.payload.readUInt32BE(0) & 0xffffff;
    sampleCount = trun.payload.readUInt32BE(4);
    let o = 8;
    if (flags & 0x1) o += 4;
    if (flags & 0x4) firstFlags = trun.payload.readUInt32BE(o);
    // Per-sample flags are in the sample table when first_sample_flags is missing
    if (firstFlags === null && (flags & 0x400)) {
      let p = o;
      if (flags & 0x100) p += 4;
      if (flags & 0x200) p += 4;
      firstFlags = trun.payload.readUInt32BE(p);
    }
  }
  const eff = firstFlags ?? defaultFlags;
  return { moofs, sampleCount, firstSampleIsSync: eff === null ? null : (eff & 0x00010000) === 0 };
}

/* ======================================================================== *
 * Measured entity box: bounding box of alpha > 0 in captured PNG
 * (G1 "use union of measured entity boxes"; measurement method from G0-b (10))
 *
 * Avoid entity boxes from `__pcSolid` on the page: that calculates based on element outer boxes,
 * and pixels drawn outside the box such as `box-shadow` / glow are excluded (in practice,
 * outer glow of punchline pills had a border cropped off).
 * Screenshots are already in hand, inspecting pixels directly is the most accurate.
 * ======================================================================== */

/**
 * Bounding box of pixels with alpha > `threshold` in PNG (8-bit, RGBA / grayscale + alpha,
 * non-interlaced), coordinates in image pixels; returns null if none; unrecognized formats
 * return `{ full: true }` (caller treats as "count whole image").
 *
 * PNG without alpha channel (truecolor, grayscale, and no `tRNS` transparent color): entirely
 * opaque, bounding box is the whole image. When content fills the capture rectangle and is opaque
 * (mostly the case for streams of source-dependent cards with video), Chrome delivers this kind of
 * PNG; previously treated as "unrecognized", segments of this stream lacked position rectangles,
 * and the full-density pass did not check whether content hit the edges of the tight rectangle.
 */
export function pngAlphaBox(buf, threshold = 0) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return { full: true };
  let off = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0, keyed = false;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === 'tRNS') keyed = true;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = color === 6 ? 4 : color === 4 ? 2 : 0;
  // Truecolor (2), grayscale (0) without transparency color: no alpha channel, every pixel is opaque
  if ((color === 2 || color === 0) && !keyed && width > 0 && height > 0) return { x: 0, y: 0, w: width, h: height };
  if (depth !== 8 || interlace || !bpp || !width || !height) return { full: true };
  let raw;
  try { raw = zlibInflate(Buffer.concat(idat)); } catch { return { full: true }; }
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return { full: true };
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let minX = width, minY = -1, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1) + 1;
    const f = raw[base - 1];
    if (f === 0) { for (let i = 0; i < stride; i++) cur[i] = raw[base + i]; }
    else if (f === 1) { for (let i = 0; i < stride; i++) cur[i] = (raw[base + i] + (i >= bpp ? cur[i - bpp] : 0)) & 255; }
    else if (f === 2) { for (let i = 0; i < stride; i++) cur[i] = (raw[base + i] + prev[i]) & 255; }
    else if (f === 3) { for (let i = 0; i < stride; i++) cur[i] = (raw[base + i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255; }
    else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[i] = (raw[base + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    } else return { full: true };
    let first = -1, last = -1;
    for (let x = 0, i = bpp - 1; x < width; x++, i += bpp) if (cur[i] > threshold) { if (first < 0) first = x; last = x; }
    if (first >= 0) {
      if (minY < 0) minY = y;
      maxY = y;
      if (first < minX) minX = first;
      if (last > maxX) maxX = last;
    }
    const t = prev; prev = cur; cur = t;
  }
  return maxY < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/* ======================================================================== *
 * Rectangles
 * ======================================================================== */

const rectOf = (x0, y0, x1, y1) => ({ x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) });
export const intersectRect = (a, b) => rectOf(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.min(a.x + a.w, b.x + b.w), Math.min(a.y + a.h, b.y + b.h));
export const unionRect = (a, b) => !a ? b : !b ? a : rectOf(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x + a.w, b.x + b.w), Math.max(a.y + a.h, b.y + b.h));
export const padRect = (r, pad) => rectOf(r.x - pad, r.y - pad, r.x + r.w + pad, r.y + r.h + pad);
export const rectArea = r => Math.max(0, r?.w || 0) * Math.max(0, r?.h || 0);
/** Whether this is a rectangle (four finite numbers, positive width and height); shape of position rectangle `box` */
export const isBox = r => !!r && typeof r === 'object' && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0;

/**
 * In an image captured according to `rect`, which edges of `rect` are hit by the bounding box `local`
 * (image pixel coordinates) of opaque pixels: only counting edges that have not reached the upper `bound`
 * (going beyond an edge already flush against the upper bound is outside this stream's scope).
 * Returns `{ left?, top?, right?, bottom? }` if any hit, null otherwise.
 */
/** Expand edges of the tight rectangle that are true in `sides` to the upper bound, leaving other edges unchanged (capture rectangle used for the remeasure pass) */
export function extendSides(tight, sides, bound) {
  const x0 = sides?.left ? bound.x : tight.x, y0 = sides?.top ? bound.y : tight.y;
  const x1 = sides?.right ? bound.x + bound.w : tight.x + tight.w, y1 = sides?.bottom ? bound.y + bound.h : tight.y + tight.h;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function tightOverflowSides(local, rect, bound) {
  const sides = {};
  if (local.x <= 0 && rect.x > bound.x) sides.left = true;
  if (local.y <= 0 && rect.y > bound.y) sides.top = true;
  if (local.x + local.w >= rect.w && rect.x + rect.w < bound.x + bound.w) sides.right = true;
  if (local.y + local.h >= rect.h && rect.y + rect.h < bound.y + bound.h) sides.bottom = true;
  return Object.keys(sides).length ? sides : null;
}

/**
 * Integerize and expand outward to **even width and even height** (G1: `format=yuv420p` strictly requires
 * both width and height to be even; rounding is applied to the capture rectangle, filter chain untouched),
 * result does not exceed `limit`. `limit`'s own width and height must be even. Prioritizes expanding right / down,
 * expanding left / up when hitting edges.
 */
export function evenRect(r, limit) {
  let x0 = Math.floor(r.x), y0 = Math.floor(r.y), x1 = Math.ceil(r.x + r.w), y1 = Math.ceil(r.y + r.h);
  const lx0 = limit.x, ly0 = limit.y, lx1 = limit.x + limit.w, ly1 = limit.y + limit.h;
  x0 = Math.max(x0, lx0); y0 = Math.max(y0, ly0); x1 = Math.min(x1, lx1); y1 = Math.min(y1, ly1);
  if (x1 - x0 < 2) { x1 = Math.min(lx1, x0 + 2); x0 = x1 - 2; }
  if (y1 - y0 < 2) { y1 = Math.min(ly1, y0 + 2); y0 = y1 - 2; }
  if ((x1 - x0) % 2) { if (x1 < lx1) x1++; else x0--; }
  if ((y1 - y0) % 2) { if (y1 < ly1) y1++; else y0--; }
  return rectOf(x0, y0, x1, y1);
}

/* ======================================================================== *
 * Stream partitioning (G1)
 * ======================================================================== */

/*
 * The criteria for which card produces which stream (`streamEligible` for plane standalone cards,
 * `soloStreamKind` for the two categories forming solo streams, `belowStreamEligible` / `belowTargets`
 * for below-dependent streams, `BELOW_STREAM_RULES`, and `graphCardWithInputs`) have been moved to
 * `src/render/streamPlanRules.mjs`: online pages must compute budgets (`src/online/pageStreamPlan.ts`)
 * against the same rules when calculating which single-card streams this page produces.
 * Re-exported here under original names; behavior is completely unchanged.
 */
export { streamEligible, graphCardWithInputs, soloStreamKind, BELOW_STREAM_RULES, belowStreamEligible };

/**
 * Whether a source-dependent card's stream needs replay from the mount frame: required if this
 * card itself is motion-style (`streamNeedsReplay`); also required if there are other media effect
 * cards in its input chain: the implementation of those upstream cards is not available here
 * (the card plan only contains capabilities of output nodes), so conservatively treat them as
 * carrying history. Those connecting only to assets do not need it: assets fetch frames directly by time.
 */
function sourceNeedsReplay(project, clip, control) {
  if (streamNeedsReplay([control])) return true;
  const top = cardNodeOf(project, clip?.nodeId);
  if (!top) return false;
  const seen = new Set([top.id]);
  const queue = [top];
  while (queue.length) {
    const node = queue.shift();
    for (const ref of Object.values(node?.inputs ?? {})) {
      const id = typeof ref === 'string' ? ref : ref?.nodeId;
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      // The clip's asset itself (`@clip/<id>/source`): fetches frames by time, with no history. When the
      // clip is not a media clip, this node is its card, but media effect cards do not connect to DOM cards
      if (/^@clip\/.+\/source$/.test(id)) continue;
      const upstream = cardNodeOf(project, id);
      if (upstream?.adapter === 'media') continue;
      if (!upstream || upstream.adapter === 'card') return true;
      queue.push(upstream);
    }
  }
  return false;
}

/**
 * All **visual layers** in the scene (card clips + visual media clips), sorted in painter's order:
 * like `FrameScene`, `project.tracks` are counted in reverse (the first track is on top),
 * and within the same track in clip order.
 * Group streams "consist only of cards adjacent in z-order": adjacency must take asset layers into account.
 */
export function paintLayers(project, fps) {
  const tracks = project?.tracks ?? [];
  const media = new Map((project?.media ?? []).map(m => [m.id, m]));
  const out = [];
  tracks.forEach((track, ti) => {
    if (track.hidden || track.sourceOnly) return;
    (track.clips ?? []).forEach((clip, ci) => {
      const card = !!clip.cardId;
      const m = clip.mediaId ? media.get(clip.mediaId) : null;
      if (!card && !(m && m.kind !== 'audio')) return;
      const from = card ? mountFrameOf(clip, fps) : Math.max(0, Math.floor(clip.start * fps));
      const to = Math.max(from, Math.ceil(clip.end * fps - 1e-9) - 1);
      out.push({ clipId: clip.id, card, order: (tracks.length - 1 - ti) * 1e6 + ci, from, to, trackIndex: ti, clipIndex: ci });
    });
  });
  return out.sort((a, b) => a.order - b.order);
}

/**
 * A card's wrapper layer box (expanded to integers) and where it is placed in the isolated
 * project (`offset`): centered when the box is smaller than the frame, leaving room on both sides
 * for overflow; aligned to the top-left corner when the box is the same size as the frame.
 */
export function localPlacement(clip, stage) {
  const size = resolveFrameSize(clip.frame, stage);
  const w = Math.max(2, Math.ceil(size.w)), h = Math.max(2, Math.ceil(size.h));
  const ox = Math.max(0, Math.floor((stage.width - w) / 2));
  const oy = Math.max(0, Math.floor((stage.height - h) / 2));
  // In the plane coordinate system, the range covered by the screenshot is [-ox, W - ox] × [-oy, H - oy]
  const view = { x: -ox || 0, y: -oy || 0, w: stage.width, h: stage.height };
  const bound = evenRect(intersectRect(view, padRect({ x: 0, y: 0, w, h }, LOCAL_OVERFLOW_PX)), view);
  return { box: { w, h }, offset: { x: ox, y: oy }, bound };
}

/**
 * Whether this stream needs replay from the mount frame when producing segments
 * (`docs/plan/prerender-products-contract.md` section 4.2).
 *
 * Required if any member is a motion-style (stateful) card: its visual carries the history of
 * preceding frames, and when a lease cannot be resumed, it can only be pushed frame-by-frame from
 * the mount frame. Omitted only when all members are remotion-style (`frameMode === 'direct'`:
 * visual is determined solely by time and parameters): landing directly on the target frame is
 * correct. The implementation reads `control.frameMode` carried in the card plan; inputs without
 * this field (legacy-shaped inputs) or those declaring `need_prerendering` are always treated as
 * stateful (better to replay more than to render incorrectly). The criteria match "stateful"
 * in `snapshotTier` of `snapshot-tier.mjs`.
 */
export function streamNeedsReplay(controls) {
  const list = Array.isArray(controls) ? controls : [];
  if (!list.length) return true;
  return list.some(control => {
    const caps = control?.capabilities;
    if ((control?.frameMode ?? caps?.frameMode) !== 'direct') return true;
    return caps?.need_prerendering === true || caps?.needPrerendering === true || control.needPrerendering === true;
  });
}

/**
 * Calculates all streams for this version based on entry (project + card plan + prerender
 * collection). Pure function (except `prerenderPicked` is provided by the caller). Returns
 * `[{ streamKey, contentKey, envFingerprint, kind, plane, clipIds, topClipId, offset, bound,
 * mountFrame, replay, firstFrame, lastFrame, originFrame, firstSegment, lastSegment, members }]`.
 * `replay`: whether segment production needs replay from the mount frame (`streamNeedsReplay`);
 * not included in any key: omitting replay does not alter the visual, as remotion-style card
 * visuals are determined solely by time and parameters.
 *
 * `originFrame`: this stream's own first frame (project frame number): for a single-card stream,
 * it is the clip's first frame; for a group stream, the earliest first frame among members; for
 * a below-dependent stream, the target card's first frame. Segments start from it every 15 frames
 * (`streamSegmentSpan`), so `firstSegment` is always 0; `originFrame` itself is not included in keys
 * (the keys already contain the sampling windows of members).
 *
 * M4 (contract E.4): `contentKey` is the stream content key (members take the **content key** from
 * the card plan, without environment), and `streamKey = resultKeyOf(contentKey, envFingerprint)` is
 * the result key for disk persistence and routing. For the same project across two environments,
 * `contentKey` is identical while `streamKey` differs. Without a fingerprint, no stream is produced
 * (returns `[]`), for the same reason as `CardFrameCache.plan()`.
 *
 * The two categories of cards that form solo streams (`soloStreamKind`: source-dependent cards, and
 * standalone cards whose box uses 3D) each produce a single-card stream with `kind: 'card'` and
 * `plane: 'local'`, also carrying `solo: 'source' | 'spatial'`, ordered after single-card streams
 * and group streams; they do not participate in group stream merging, but consume decoder budget.
 * When the project has neither category, the result is item-for-item identical to the original.
 *
 * `below` (defaults to `belowStreamsEnabled()`, **enabled by default**): heavy cards in the
 * prerender collection that are below-dependent, `context`, or unknown each produce a `kind: 'below'`
 * stream (`belowStreamSpec`), ordered after single-card streams and group streams; they do not
 * participate in group stream merging, but consume decoder budget. When passing `false`, the result
 * is item-for-item identical to having no such streams.
 */
export function planStreams(entry, { picked = () => true, budget = STREAM_DECODER_BUDGET, codeVersion = '', envFingerprint, below = belowStreamsEnabled(), projectId = null, projectScoped = false } = {}) {
  if (typeof envFingerprint !== 'string' || !envFingerprint) return [];
  // Replace cut segments with their internal cards (`src/kernel/cutFlatten.mjs`; unchanged when
  // there are no cut segments): virtual clips from the card plan can be found in this view
  const project = flatPlanProject(entry?.project);
  const plan = entry?.cardPlan;
  if (!project || !Array.isArray(plan) || !plan.length) return [];
  const scopeProjectId = typeof projectId === 'string' && projectId
    ? projectId
    : (projectScoped && typeof entry?.projectId === 'string' && entry.projectId ? entry.projectId : null);
  if (scopeProjectId && typeof entry?.projectId === 'string' && entry.projectId && entry.projectId !== scopeProjectId) {
    throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
  }
  const effectiveCodeVersion = scopeProjectId ? `${codeVersion}|project:${scopeProjectId}` : codeVersion;
  const projectTag = scopeProjectId ? { projectId: scopeProjectId } : {};
  const fps = Number(project.fps) || 30;
  const stage = { width: Number(project.width) || 1920, height: Number(project.height) || 1080, camera3dFov: project.camera3dFov };
  const total = Math.max(1, Math.floor((Number(project.duration) || 0) * fps));
  const where = new Map();
  (project.tracks ?? []).forEach((track, ti) => (track.clips ?? []).forEach((clip, ci) => where.set(clip.id, { track, clip, ti, ci })));
  const layers = paintLayers(project, fps);
  const orderOf = new Map(layers.map(l => [l.clipId, l.order]));
  const singles = [];
  // The two categories of cards forming solo streams (`soloStreamKind`: source-dependent cards,
  // standalone cards whose box uses 3D): each gets a single-card stream, not participating in
  // group stream merging, but each consumes one decoder
  const solos = [];
  const soloSeen = new Set();
  for (const control of plan) {
    if (!picked(control.clipId)) continue;
    const at = where.get(control.clipId);
    if (!at) continue;
    const flat = streamEligible(control, at.clip, at.track, project);
    const solo = flat ? null : soloStreamKind(control, at.clip, at.track, project);
    if (!flat && !solo) continue;
    if (solo && soloSeen.has(control.clipId)) continue;
    const firstFrame = control.sampling?.firstFrame ?? Math.ceil(at.clip.start * fps - 1e-9);
    const lastFrame = Math.min(total - 1, firstFrame + control.count - 1);
    if (lastFrame < firstFrame) continue;
    const mountFrame = mountFrameOf(mountClipOf(at.clip), fps);
    // Cost: pixels to decode per second (encoded aspect ratio × frame rate, `src/render/streamBudget.mjs`).
    // Single-card streams are calculated by their rectangle upper bound
    const bound = localPlacement(at.clip, stage).bound;
    const item = { control, clip: at.clip, clipIds: [control.clipId], order: orderOf.get(control.clipId) ?? 0, from: Math.min(mountFrame, firstFrame), to: lastFrame,
      cost: streamCost(streamCodedPixels(bound.w, bound.h), fps) };
    if (solo) { soloSeen.add(control.clipId); solos.push({ ...item, solo }); } else singles.push(item);
  }
  singles.sort((a, b) => a.order - b.order);
  solos.sort((a, b) => a.order - b.order);
  const byClip = new Map(singles.map(s => [s.clipIds[0], s]));
  // Target cards of below-dependent streams (empty when `below: false`): do not participate in
  // group stream merging, but each consumes one decoder. Cards that have already formed solo streams
  // no longer produce such streams
  const belows = below ? belowTargets(plan, { picked, where, fps, total, orderOf, taken: soloSeen, project }) : [];
  // For streams produced in stage coordinates (group streams, below-dependent streams),
  // the rectangle upper bound is the entire frame
  const stageCost = streamCost(stageStreamPixels(stage), fps);
  const fixed = [...solos, ...belows.map(b => ({ ...b, cost: stageCost }))];
  const grouped = groupStreams(singles, layers, budget, fixed, stageCost);
  const specs = [];
  /**
   * Single-card stream of a card (wrapper layer's own coordinate system; appearance is not in the
   * stream): plane standalone cards and the two categories of cards forming solo streams are of this kind
   */
  const cardSpec = (m, base) => {
    const placement = localPlacement(m.clip, stage);
    // Member keys take the content key without the code fingerprint for generate snapshots
    // (`streamMemberKey`: modifying generate snapshots code should not invalidate streams);
    // fallback after `??` is only for legacy-shaped inputs without this field (uses legacy
    // content key, then legacy `snapshotKey || key`)
    const contentKey = cardStreamIdentity({ kind: 'card', fps, stage, codeVersion: effectiveCodeVersion,
      members: [{ key: m.control.streamMemberKey ?? m.control.contentKey ?? (m.control.snapshotKey || m.control.key), sampling: m.control.sampling, count: m.control.count }] });
    const streamKey = resultKeyOf(contentKey, envFingerprint);
    return { ...base, ...projectTag, streamKey, contentKey, envFingerprint, kind: 'card', plane: 'local', offset: placement.offset, bound: placement.bound, box: placement.box, members: [m.control] };
  };
  for (const g of grouped) {
    const members = g.clipIds.map(id => byClip.get(id));
    const first = Math.min(...members.map(m => m.from));
    const last = Math.max(...members.map(m => m.to));
    const firstVisible = Math.min(...members.map(m => m.control.sampling?.firstFrame ?? m.from));
    const base = {
      clipIds: [...g.clipIds], topClipId: g.clipIds[g.clipIds.length - 1], mountFrame: first,
      firstFrame: firstVisible, lastFrame: last,
      ...streamSegmentSpan(firstVisible, last),
      fps, stage, total,
      replay: streamNeedsReplay(members.map(m => m.control)),
    };
    if (members.length === 1) {
      specs.push(cardSpec(members[0], base));
    } else {
      const view = { x: 0, y: 0, w: stage.width, h: stage.height };
      const contentKey = cardStreamIdentity({ kind: 'group', fps, stage, codeVersion: effectiveCodeVersion,
        members: members.map(m => ({ key: m.control.cacheContentKey ?? m.control.key, sampling: m.control.sampling, count: m.control.count })) });
      const streamKey = resultKeyOf(contentKey, envFingerprint);
      specs.push({ ...base, ...projectTag, streamKey, contentKey, envFingerprint, kind: 'group', plane: 'stage', offset: { x: 0, y: 0 }, bound: evenRect(view, view), members: members.map(m => m.control) });
    }
  }
  // The two categories of cards forming solo streams: same shape as single-card streams, with
  // an added `solo` (which category; the splitter uses this to omit the browser copy). Replay for
  // source-dependent cards additionally inspects their input chain
  for (const m of solos) {
    const firstVisible = m.control.sampling?.firstFrame ?? m.from;
    specs.push({ ...cardSpec(m, {
      clipIds: [...m.clipIds], topClipId: m.clipIds[0], mountFrame: m.from,
      firstFrame: firstVisible, lastFrame: m.to,
      ...streamSegmentSpan(firstVisible, m.to),
      fps, stage, total,
      replay: m.solo === 'source' ? sourceNeedsReplay(project, m.clip, m.control) : streamNeedsReplay([m.control]),
    }), solo: m.solo });
  }
  if (belows.length) {
    specs.push(...belowStreamSpecs(entry, belows, { fps, stage, total, codeVersion: effectiveCodeVersion, envFingerprint }).map(s => ({ ...s, ...projectTag })));
  }
  return relockStreams(specs, entry?.streamLocks);
}

/**
 * "Same stream produced with another fingerprint exists in stream store" (task brief
 * `render-refactor-task.md` "Jia-2"): when a single-card stream's content key is in `locks`
 * (content key → environment fingerprint), this stream's key is produced using that fingerprint
 * (`streamKey = content key × that fingerprint`, `envFingerprint` also replaced with it, and local
 * recorded in `ownEnvFingerprint`). Locks are recorded only after the pipeline pulls that entire stream
 * back to the local stream store (`FramePipeline.adoptForeignStreams`), recorded on each entry's
 * `streamLocks`; therefore, streams keyed according to locks are guaranteed complete locally:
 * the producer does not re-produce, the stage plays the pulled-back stream, and splitting emits only
 * one copy per lock. Group streams and below-dependent streams are not swapped (not produced in other
 * environments). Returns the same array unchanged when there are no locks.
 */
export function relockStreams(specs, locks) {
  if (!locks || typeof locks.get !== 'function' || !locks.size) return specs;
  return specs.map(spec => {
    const fingerprint = spec?.kind === 'card' ? locks.get(spec.contentKey) : null;
    if (typeof fingerprint !== 'string' || !fingerprint || fingerprint === spec.envFingerprint) return spec;
    return { ...spec, streamKey: resultKeyOf(spec.contentKey, fingerprint), envFingerprint: fingerprint, ownEnvFingerprint: spec.envFingerprint };
  });
}

/**
 * A stream passed to splitting (`streams` in `render-node/split.mjs`): besides stream key and
 * segment range, it carries this stream's shape: written into the task's `input.stream` when
 * splitting emits the browser copy of a single-card stream (`docs/plan/browser-stream-task.md`
 * section 1; the page does not calculate these itself). Member card information is not here:
 * splitting retrieves it from the same card plan by `topClipId` (where cardId and hypervolume
 * flags reside).
 */
export function queueStreamOf(spec) {
  return {
    streamKey: spec.streamKey, contentKey: spec.contentKey, topClipId: spec.topClipId,
    originFrame: spec.originFrame, firstSegment: spec.firstSegment, lastSegment: spec.lastSegment,
    kind: spec.kind, plane: spec.plane, clipIds: [...(spec.clipIds ?? [])], fps: spec.fps,
    bound: spec.bound ? { ...spec.bound } : null, offset: spec.offset ? { ...spec.offset } : null,
    firstFrame: spec.firstFrame, lastFrame: spec.lastFrame, total: spec.total,
    // Replay start point: the splitter expands the subset of this stream using it (`streamNeed`
    // in `render-node/expand.mjs`), calculating the same subset as the stream-producing node does
    // from the full stream
    ...(Number.isFinite(spec.mountFrame) ? { mountFrame: spec.mountFrame } : {}),
    ...(spec.projectId ? { projectId: spec.projectId } : {}),
    // Below-dependent streams additionally carry lower layers included in the key (the splitter uses
    // this to know that this stream requires whole-scene lower layers and assets); other streams omit
    // this field, retaining their original shape
    ...(spec.kind === 'below' ? { belowClipIds: [...(spec.belowClipIds ?? [])] } : {}),
    // The two categories of cards forming solo streams (`soloStreamKind`) include which category:
    // the splitter uses this to omit the browser copy
    ...(spec.solo ? { solo: spec.solo } : {}),
  };
}

/**
 * Used for the online page's manifest plan: calculates streams solely based on clips in the
 * manifest (`picked` = in the manifest), regardless of whether classified as heavy locally or
 * whether the local machine can produce streams: which streams emit the splitter's own copy and
 * which emit only for the browser is determined by `listPlanOverrides` in `render-node/local-node.mjs`
 * (single-card streams and below-dependent streams emit their own copies when capable of producing
 * streams locally; group streams are marked only as `browserOnly`). Returns `planStreams` result;
 * `clips` is a Set or array of clip IDs.
 */
export function planListStreams(entry, clips, options = {}) {
  const listed = clips instanceof Set ? clips : new Set(Array.isArray(clips) ? clips : []);
  return planStreams(entry, { ...options, picked: clipId => listed.has(clipId) });
}

/**
 * **Isolated project** for this stream (G4 "How single-card pixels are isolated": stream version
 * of `isolatedCardProject`).
 *
 * Keeps only this stream's cards visible (one card for a single-card stream, a group for a group
 * stream); other clips on the same track and other tracks become hidden `sourceOnly` tracks: they do
 * not render visuals, but media effect cards can still find them when resolving inputs by source clip.
 * **Time is not shifted** (clips remain at their original timeline positions in the isolated project,
 * pushing frames by project frame number when producing segments; segment indices are converted from
 * `originFrame`); transparent background is guaranteed by the export page itself.
 *
 * Single-card streams also strip the wrapper layer appearance (box placed at `offset`, no scaling
 * or rotation, opacity / fade / motion / emphasis are all removed): these are added by the wrapper
 * layer on stage. Group streams are preserved as-is (appearance is rendered into the stream).
 */
export function isolatedStreamProject(project, spec) {
  if (spec?.kind === 'below') return isolatedBelowProject(project, spec);
  // Cards flattened from cut segments (`solo: 'flat'`): isolated along with this cut segment chain,
  // nested scenes calculate preroll as usual (`isolatedFlatProject` in `src/kernel/cutFlatten.mjs`)
  if (spec?.solo === 'flat') {
    const isolated = isolatedFlatProject(project, spec.topClipId, c => localClip(c, spec));
    if (!isolated) throw new Error(`Isolated project: the project has no clip ${spec.topClipId} in its cut segments`);
    return isolated;
  }
  const members = new Set(spec.clipIds);
  const ids = new Set((project.tracks ?? []).map(t => t.id));
  const tracks = [];
  for (const track of project.tracks ?? []) {
    const own = (track.clips ?? []).filter(c => members.has(c.id));
    if (!own.length) { tracks.push({ ...structuredClone(track), hidden: true, sourceOnly: true }); continue; }
    const clips = own.map(c => spec.plane === 'local' ? localClip(c, spec) : structuredClone(c));
    tracks.push({ ...structuredClone(track), hidden: false, sourceOnly: false, clips });
    const siblings = (track.clips ?? []).filter(c => !members.has(c.id));
    if (siblings.length) {
      let id = `__pc_source_${track.id}`, n = 1;
      while (ids.has(id)) id = `__pc_source_${track.id}_${n++}`;
      ids.add(id);
      tracks.push({ ...structuredClone(track), id, hidden: true, sourceOnly: true, clips: structuredClone(siblings) });
    }
  }
  const cloned = structuredClone(project);
  if (spec.plane === 'local' && Array.isArray(cloned.cuts)) {
    delete cloned.cutKind;
    for (const c of cloned.cuts) {
      if (c && (!cloned.activeCutId || c.id === cloned.activeCutId)) {
        delete c.kind;
        delete c.cameras;
      }
    }
  }
  return { ...cloned, tracks, _cardRender: { mode: 'final', frames: {}, missing: {} } };
}

/**
 * Which moment replay mounts from: clips flattened from cut segments (carrying `flat`) mount from
 * the earliest moment the nested scene was mounted (`flat.mount`, preroll will not be earlier
 * than this); other clips use their own mount time.
 */
function mountClipOf(clip) {
  const mount = clip?.flat?.mount;
  return Number.isFinite(mount) ? { ...clip, start: Math.min(clip.start, mount) } : clip;
}

function localClip(clip, spec) {
  const out = structuredClone(clip);
  delete out.motion; delete out.opacity; delete out.fadeIn; delete out.fadeOut; delete out.emphasis;
  const sizeExpr = stripOuterFrameExpr(clip.frameExpr);
  if (sizeExpr) out.frameExpr = sizeExpr;
  else delete out.frameExpr;
  const size = resolveFrameSize(clip.frame, spec.stage);
  // Top-left of the box = (x, y) - anchor offset; when anchor is [0,0], it is (x, y) itself
  out.frame = clip.frame || spec.offset.x || spec.offset.y
    ? { x: spec.offset.x, y: spec.offset.y, w: size.w, h: size.h, anchor: [0, 0] }
    : undefined;
  if (out.frame === undefined) delete out.frame;
  return out;
}

/* ======================================================================== *
 * Below-dependent streams (`kind: 'below'`, `docs/plan/prerender-products-contract.md` sections 5.1 and 5.2)
 *
 * This section contains only planning, keys, and isolated projects. How pixels in the stream
 * are retrieved (section 5.3: differential layer extraction) is in `./bakery/capture-below.mjs`,
 * hooked up by `StreamProducer.runSegment`; how they are pasted back onto the stage (section 5.4)
 * is on the page side (`src/render/Stage.tsx`, `streamPlayer.ts`). Whether to emit such streams is
 * governed by `belowStreamsEnabled`, enabled by default.
 * ======================================================================== */

/**
 * Project data not covered by a layer's cached content key (`control.cacheContentKey`) that would
 * still alter the layer's visual; returns undefined if none (this entry will not appear in the digest).
 *
 * Currently there is only one such item: **pixel maps** attached to media clips (`clip.pixelMap`,
 * the corresponding definition in the project, and other assets referenced in the definition).
 * Cached content keys originate from the card graph (`projectCardGraph` in `src/kernel/cardGraph.mjs`),
 * which chains only filters, audio effects, and emphasis into nodes, leaving pixel maps out of the graph;
 * without supplementing this item, modifying a lower-layer asset's pixel map would leave the
 * below-dependent stream's key unchanged, causing the stale stream to keep being pasted.
 */
export function belowLayerExtra(project, clip) {
  const ref = clip?.pixelMap;
  if (!ref) return undefined;
  const def = (project?.pixelMaps ?? []).find(x => x?.id === ref.id) ?? null;
  const ids = new Set();
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const [name, inner] of Object.entries(value)) {
      if (name === 'mediaId' && typeof inner === 'string' && inner) ids.add(inner);
      else walk(inner);
    }
  };
  walk(def);
  const media = [...ids].sort().map(id => {
    const m = (project?.media ?? []).find(x => x?.id === id);
    return [id, m ? (m.hash ?? m.url ?? m.path ?? null) : null];
  });
  return { pixelMap: ref, def, media };
}

/**
 * One **below-dependent stream** per target card. `targets` is the result of `belowTargets`;
 * each returned item follows the shape of a group stream (stage coordinates, `plane: 'stage'`,
 * zero `offset`, `bound` covers the entire frame, leaving tightening to be measured during the
 * stream production pass), plus:
 *
 *   - `clipIds` has only the target card (this stream is attached to it); `belowClipIds` are the
 *     lower layers included in the key, in painter's order (bottom first);
 *   - Key: `cardStreamIdentity({ kind: 'below' })`. Lower layers use `belowLayersOf` (sharing
 *     the same determination as the page's input signature and isolated project), with each layer
 *     using its cached content key in the card plan plus its sampling window, plus `belowLayerExtra`.
 *     If any layer cannot find a key in the card plan (a card unrecognized by prerender), the
 *     entire stream falls back to whole-scene keys (`belowScene: true`; coarser, but never wrong):
 *     since 0.7.19, computed from the subset expanded by this stream (`entry.subsetKey`), while
 *     legacy entries without it fall back to `entry.key`; if neither exists, omit this stream;
 *   - `replay` / `mountFrame`: replay is required if the target card or any card clip in lower
 *     layers (including media effect card clips hosting nodes) is motion-style, starting from the
 *     earliest mount frame among these stateful cards (cards not found in the card plan are treated
 *     as stateful). Pure media clips fetch frames directly by time and do not count;
 *   - `hasMedia`: whether the project has visual assets (if so, the stream production pass must
 *     wait for assets to be ready before taking screenshots, `bakeStream`'s `hasMedia`; hidden
 *     source clips also count, as media effect cards may connect to them).
 */
function belowStreamSpecs(entry, targets, { fps, stage, total, codeVersion, envFingerprint }) {
  const project = flatPlanProject(entry.project);
  const controlOf = new Map();
  for (const control of entry.cardPlan ?? []) if (control?.clipId && !controlOf.has(control.clipId)) controlOf.set(control.clipId, control);
  const visualMedia = new Set((project.media ?? []).filter(m => m && m.kind !== 'audio').map(m => m.id));
  // Assets inside cut segments also count (`kernel/cutIdentity.mjs`): must wait for them
  // to be ready before capturing screenshots
  const hasMedia = [...reachableMediaIds(entry.project)].some(id => visualMedia.has(id));
  const view = { x: 0, y: 0, w: stage.width, h: stage.height };
  const specs = [];
  for (const target of targets) {
    const { control, clip } = target;
    const found = belowLayersOf(project, control.clipId);
    const targetKey = control.cacheContentKey ?? control.key;
    if (!found || typeof targetKey !== 'string' || !targetKey) continue;
    const layers = [];
    let whole = false;
    for (const layer of found.below) {
      const lower = controlOf.get(layer.id);
      const key = lower?.cacheContentKey ?? lower?.key;
      if (typeof key !== 'string' || !key) { whole = true; break; }
      layers.push({ key, sampling: lower.sampling, count: lower.count, extra: belowLayerExtra(project, layer.clip) });
    }
    // If a layer cannot find a key in the card plan: fall back to the whole-scene key. Since 0.7.19,
    // this key is calculated from the subset expanded by this stream (same algorithm across both modes,
    // publisher, and nodes; `entry.subsetKey`, attached when `frame-pipeline.mjs` creates an entry),
    // no longer using the whole project's `entry.key`: changes in the project unrelated to this stream
    // no longer invalidate it. Entries without `subsetKey` (legacy callers, test doubles) use
    // `entry.key` as before
    const sceneKey = !whole ? null : typeof entry.subsetKey === 'function'
      ? entry.subsetKey(streamNeed({ fps, mountFrame: target.from, firstFrame: target.firstFrame, lastFrame: target.to, clipIds: [control.clipId], belowClipIds: found.below.map(layer => layer.id) }))
      : entry.key;
    if (whole && (typeof sceneKey !== 'string' || !sceneKey)) continue;
    const contentKey = cardStreamIdentity({ kind: 'below', fps, stage, codeVersion,
      members: [{ key: targetKey, sampling: control.sampling, count: control.count, extra: belowLayerExtra(project, clip) }],
      below: whole ? { scene: sceneKey } : { layers } });
    let mountFrame = target.from;
    const stateful = [control];
    for (const layer of found.below) {
      if (!layer.clip.cardId && !layer.clip.nodeId) continue;
      const lower = controlOf.get(layer.id) ?? null;
      stateful.push(lower);
      // Layers flattened from cut segments are pushed starting from the earliest moment
      // the nested scene was mounted (`mountClipOf`)
      if (streamNeedsReplay([lower])) mountFrame = Math.min(mountFrame, mountFrameOf(mountClipOf(layer.clip), fps));
    }
    specs.push({
      clipIds: [control.clipId], topClipId: control.clipId, mountFrame,
      firstFrame: target.firstFrame, lastFrame: target.to,
      ...streamSegmentSpan(target.firstFrame, target.to),
      fps, stage, total,
      replay: streamNeedsReplay(stateful),
      streamKey: resultKeyOf(contentKey, envFingerprint), contentKey, envFingerprint,
      kind: 'below', plane: 'stage', offset: { x: 0, y: 0 }, bound: evenRect(view, view),
      members: [control],
      belowClipIds: found.below.map(layer => layer.id), belowScene: whole, hasMedia,
      // Input signature of this stream in this project version: passed to the page when publishing layers
      // (`StreamProducer.publish`); the page computes the same signature against its own project, and a
      // mismatch indicates that lower layers have changed while the prerender process has not yet switched
      // versions: stale streams are not pasted (`src/editor/snapshotFeed.ts`). Omitted if uncomputable
      inputSig: streamInputSig(project, { clipIds: [control.clipId], kind: 'below' }),
    });
  }
  return specs;
}

/**
 * Two additional fields on the layer emitted to the page for below-dependent streams (`layer`
 * in ready index, `kind: 'stream'`); other streams return an empty object, leaving emitted
 * layers completely unchanged.
 *
 *   - `streamKind: 'below'`: the page uses this to attach the stream's plane under the stage root
 *     and paste it in stage coordinates (contract section 5.4), without mounting into wrapper layers;
 *   - `inputSig`: input signature of the project version that produced this stream (computed by
 *     `belowStreamSpecs`). Provided only to this stream's own target card; omitted if uncomputable
 *     (the page skips comparison).
 */
export function belowLayerMark(spec, clipId) {
  if (spec?.kind !== 'below') return {};
  const sig = clipId === spec.topClipId && typeof spec.inputSig === 'string' && spec.inputSig ? { inputSig: spec.inputSig } : {};
  return { streamKind: 'below', ...sig };
}

/**
 * **Isolated project** for below-dependent streams (contract section 5.3 first paragraph): preserves
 * the target card and all layers ordered below it in painter's order, hiding only layers above it.
 * `isolatedStreamProject` branches here when encountering `kind: 'below'` streams; the single-card
 * and group stream approach (hiding all non-members) remains unchanged.
 *
 *   - Tracks above target card: entire track becomes a hidden `sourceOnly` track (does not render,
 *     but media effect cards can still find them when resolving inputs by source clip);
 *   - Track containing target card: clips before it (below it in painter's order) and target card
 *     itself are kept, clips after it are moved to a hidden `sourceOnly` track;
 *   - Tracks below target card: unchanged (originally hidden tracks remain hidden), cards, assets,
 *     and their appearances are untouched;
 *   - Target card's appearance is kept as-is (this stream is produced in stage coordinates, with
 *     appearance rendered into the stream); time is not shifted.
 * "Above / below" shares the same painter's order as stream keys and input signatures
 * (`belowLayersOf` in `src/render/streamInputSig.mjs`).
 *
 * `withTarget: false`: hides even the target card (moved into that hidden track), leaving only lower
 * layers: the frame "without target card" required for differential layer extraction.
 */
export function isolatedBelowProject(project, spec, { withTarget = true } = {}) {
  const targetId = spec?.topClipId ?? spec?.clipIds?.[0];
  const source = project.tracks ?? [];
  let ti = -1, ci = -1;
  source.forEach((track, i) => (track.clips ?? []).forEach((clip, j) => { if (ti < 0 && clip.id === targetId) { ti = i; ci = j; } }));
  if (ti < 0) throw new Error(`Isolated project: the project has no clip ${targetId}`);
  const ids = new Set(source.map(t => t.id));
  const tracks = [];
  source.forEach((track, i) => {
    if (i < ti) { tracks.push({ ...structuredClone(track), hidden: true, sourceOnly: true }); return; }
    if (i > ti) { tracks.push(structuredClone(track)); return; }
    const clips = track.clips ?? [];
    const kept = clips.filter((_, j) => j < ci || (j === ci && withTarget));
    const hiddenClips = clips.filter((_, j) => j > ci || (j === ci && !withTarget));
    tracks.push({ ...structuredClone(track), hidden: false, sourceOnly: false, clips: structuredClone(kept) });
    if (hiddenClips.length) {
      let id = `__pc_source_${track.id}`, n = 1;
      while (ids.has(id)) id = `__pc_source_${track.id}_${n++}`;
      ids.add(id);
      tracks.push({ ...structuredClone(track), id, hidden: true, sourceOnly: true, clips: structuredClone(hiddenClips) });
    }
  });
  return { ...structuredClone(project), tracks, _cardRender: { mode: 'final', frames: {}, missing: {} } };
}

/* ======================================================================== *
 * Stream store
 * ======================================================================== */

const KEY_RE = /^[a-f0-9]{64}$/;
const INIT_RE = /^[a-f0-9]{16}$/;
const SEG_RE = /^(\d{1,7})-([a-f0-9]{16})\.m4s$/;

/**
 * Hash of encoding parameters (part of segment signature, G2). Filter chain is computed by its
 * identity (`streamFilterIdentity`); equivalent rewrites do not invalidate existing segments.
 */
export function encoderParamsHash(encoder) {
  const spec = STREAM_ENCODERS[encoder];
  return sha(JSON.stringify({ args: spec?.args ?? null, filter: streamFilterIdentity(spec?.pixFmt) }), 16);
}

/**
 * Segment signature = stream signature + segment index + stride + encoder name + encoding parameter
 * hash (G2), plus rectangle (variant).
 * The segment index belongs to this stream itself (counted from its first frame); the signature
 * contains no project frame number: the stream's position on the timeline enters solely via stream keys.
 */
export function segmentSignature({ streamKey, segment, stride, encoder, rect, projectId = null }) {
  return sha(JSON.stringify({ streamKey, segment, stride, encoder, params: encoderParamsHash(encoder), rect, ...(projectId ? { projectId } : {}) }), 32);
}

/**
 * C6.2: Validates a task manifest `StreamResult` (`artifact-transfer-contract.md` section 3) and
 * reshapes it into the shape required by `adoptSegments`: `{ key, range, header, inits, segments: [[n, seg]…] }`.
 * Unknown fields are ignored; throws on invalid format.
 */
export function streamAdoption(result) {
  const bad = why => { throw Object.assign(new Error(`Invalid track stream manifest: ${why}`), { retryable: false }); };
  if (!result || typeof result !== 'object') bad('Not an object');
  if (result.v !== 1) bad(`v = ${result.v}`);
  if (result.kind !== 'stream') bad(`kind = ${result.kind}`);
  const key = result.resultKey;
  if (!KEY_RE.test(String(key))) bad('resultKey');
  const from = result.range?.from, to = result.range?.to;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) bad('range');
  const header = result.header;
  if (!header || typeof header !== 'object' || !Array.isArray(header.clipIds)) bad('header');
  // Segment indices are counted from this stream's own first frame: manifests omitting this frame
  // (produced by nodes prior to segmenting rule changes) are rejected, avoiding pasting segments
  // partitioned by project frame numbers as new ones
  if (!isStreamOrigin(header.originFrame)) bad('header.originFrame');
  const inits = {};
  for (const [id, meta] of Object.entries(result.inits ?? {})) {
    if (!INIT_RE.test(id) || !KEY_RE.test(String(meta?.hash)) || meta.hash.slice(0, 16) !== id) bad(`init ${id}`);
    inits[id] = meta;
  }
  const segments = [];
  for (const [name, seg] of Object.entries(result.segments ?? {})) {
    const n = Number(name);
    if (!Number.isInteger(n) || String(n) !== name || n < from || n > to) bad(`segment ${name}`);
    if (!KEY_RE.test(String(seg?.hash)) || !INIT_RE.test(String(seg?.init))) bad(`segment ${name}`);
    if (!Number.isInteger(seg.stride) || seg.stride < 1 || !Number.isInteger(seg.samples) || seg.samples < 1) bad(`segment ${name}`);
    segments.push([n, seg]);
  }
  segments.sort((a, b) => a[0] - b[0]);
  return { key, range: { from, to }, header, inits, segments };
}

/**
 * Updates the first frame recorded in the manifest to match this version's plan (`spec.originFrame`),
 * fills in the plan's last frame (`spec.lastFrame`) if unrecorded, and returns the same manifest object.
 *
 * The manifest's `originFrame` records "which frame in the project was its first frame when producing
 * this stream". Currently, the stream key carries the clip's timeline position, so this field in a
 * manifest with the same key will not mismatch the plan, and nothing is changed here. Keeping this step
 * is for "streams do not invalidate when clips move on the timeline" (logged as TODO, not done this time):
 * when position is removed from stream keys and input signatures, the same stream can be placed at
 * different frames, and the old position in the manifest will be replaced by the current one here;
 * the reader side never retrieved this frame from the manifest anyway (retrieving it instead from the
 * ready message / layer table row, provided by the planning side based on the current project), so neither
 * segment nor manifest formats need further changes.
 */
export function anchorManifest(manifest, spec) {
  if (manifest && isStreamOrigin(spec?.originFrame) && manifest.originFrame !== spec.originFrame) manifest.originFrame = spec.originFrame;
  // Last frame of this stream (`lastFrame` in manifest header on push): stream key carries sampling
  // window and remains unchanged for the same key; filled in if not previously recorded (persisted earlier)
  if (manifest && Number.isInteger(spec?.lastFrame) && manifest.lastFrame !== spec.lastFrame) manifest.lastFrame = spec.lastFrame;
  return manifest;
}

/* ======================================================================== *
 * Production scheduling (G4)
 * ======================================================================== */

/**
 * Track stream producer in the prerender process. One per `FramePipeline`.
 *
 *   - **Produce only when machine is idle** (G0-b conclusion 1): when `pipeline.streamBusy()` is
 *     true (user is playing / just scrubbed the playhead / legacy playback warm pool is in use),
 *     check every 250 ms and do not start a new segment;
 *   - **`streamPool` sessions**, default 1, at most 2, adapting based on measurements (stops
 *     adding when per-frame time with encoder exceeds 2x idle time); sessions are obtained via
 *     `pipeline.leaseStreamBakery()` / `returnStreamBakery()`, without going through
 *     `acquireUser` or entering `laneChains`;
 *   - **Sparse first, then fill density**: replace with full density segments only after sparse
 *     versions of all streams (capturing only the first frame of each segment) are fully populated;
 *   - Each worker rotates between streams by "unreadied segment closest to the playhead", **but
 *     prefers extending its own lease** (`planStreamSegments`);
 *   - **Concurrently active segment encoders ≤ 2 × streamPool** (double buffering).
 */
export class StreamProducer {
  constructor(pipeline, { env = process.env, ownership = null, projectAccess = null, projectId = null } = {}) {
    this.ownership = ownership;
    this.projectId = ownership?.projectId ?? projectId ?? null;
    this.pipeline = pipeline;
    this.enabled = streamsEnabled(env);
    /**
     * In multi-project mode (`profile: 'host'`: standalone render hosts, worker processes of host
     * render services), stream production only loads the portion used by this stream (semantics in
     * `product/rendering.md` "Two Modes of the Render Service", `document-service.md` "Render Queue"):
     * isolated projects are built from the subset expanded according to this stream (`streamNeed` /
     * `expandProject` in `render-node/expand.mjs`; splitter uses the same function when writing
     * `requires.cardSources`), and other clips and their assets do not enter the render page. Visuals
     * are pixel-identical to those built from the whole project
     * (`scripts/probes/multi-project-stream-probe.mjs`). The prerender process in the desktop app is
     * in single-project mode and builds from the whole project as before
     */
    this.subset = multiProjectNode(env);
    this.budget = streamDecoderBudget(env);
    this.poolLimit = streamPoolLimit(env);
    this.pool = this.poolLimit.fixed ?? STREAM_POOL_DEFAULT;
    const storeOwnership = ownership ?? (this.projectId ? { projectId: this.projectId, assert: async () => {} } : null);
    this.store = new StreamStore(path.join(pipeline.root, 'streams'), { ownership: storeOwnership, projectAccess });
    /**
     * Whether canvas card streams use direct canvas capture: `auto` (default) / `always` (used if
     * measurement passed, regardless of speed) / `off`; see `directOf`
     */
    this.direct = directCaptureMode(env);
    this.streams = new Map();
    this.workers = new Set();
    this.encoding = new Set();
    this.aliveEncoders = 0;
    this.encoderWaiters = [];
    this.generation = 0;
    this.closed = false;
    this.measure = { idle: [], busy: [] };
    this.stats = { segments: 0, resets: 0, replayedFrames: 0, replacedDeleted: 0, failures: 0, maxAliveEncoders: 0, setFrameWindowCalls: 0 };
    this.log = [];
    /**
     * Whether the read endpoint for segment bytes is connected (`attachRoute()`, called when creating
     * `FramePipeline` where `/api/frames/*` is mounted).
     *
     * **If not connected, produce nothing and emit no `stream` layers.** Reason: when the page receives
     * a `stream` layer but cannot fetch bytes, the current parent page (`src/editor/snapshotFeed.ts`)
     * treats the `stream` layer as a snapshot to fetch:
     * `/api/frames/snapshot/stream/…` falls back to the SPA fallback on the prerender process,
     * returning a full page of `index.html` (200, measured), causing heavy cards to paste an entire
     * application page on pause / scrub. The read endpoint and the parent page side must be connected
     * together (see the patch in the report); this gate ensures behavior matches R7 when only half is
     * connected.
     */
    this.routeAttached = false;
  }

  async assertProjectScope(entryOrObj, spec = null) {
    await this.ownership?.assert();
    if (!this.projectId) return;
    if (entryOrObj?.projectId && entryOrObj.projectId !== this.projectId) {
      throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
    }
    if (spec?.projectId && spec.projectId !== this.projectId) {
      throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
    }
  }

  /** Read endpoint connected: produce and emit layers from now on (see `routeAttached`) */
  attachRoute() {
    if (this.routeAttached) return;
    this.routeAttached = true;
    this.note('Segment read endpoint attached');
    if (this.pendingEntry) { const entry = this.pendingEntry; this.pendingEntry = null; void this.update(entry).catch(() => {}); }
  }

  /** Read endpoint: `handleStreamRequest` responds based on this producer's stream store */
  handle(req, res, pathname) {
    return handleStreamRequest(this.store, req, res, pathname);
  }

  /** Diagnostics endpoint (`/api/frames/diagnostics`): segment table for each stream (G4 `status()`) */
  status() {
    return {
      enabled: this.enabled, routeAttached: this.routeAttached, pool: this.pool, budget: this.budget, encoder: this.encoderName ?? null,
      stats: { ...this.stats, aliveEncoders: this.aliveEncoders },
      streams: [...this.streams.values()].map(state => ({
        streamKey: state.spec.streamKey, contentKey: state.spec.contentKey, kind: state.spec.kind, clipIds: state.spec.clipIds,
        ...(state.spec.solo ? { solo: state.spec.solo } : {}),
        originFrame: state.spec.originFrame ?? null, firstSegment: state.spec.firstSegment, lastSegment: state.spec.lastSegment,
        bound: state.spec.bound, tight: state.manifest?.tight ?? null, resets: state.resets ?? null,
        replay: state.spec.replay !== false, replayedFrames: state.replayedFrames ?? 0,
        direct: state.direct ? { ...state.direct } : null, capture: state.capture ? { ...state.capture } : null,
        below: state.below ? { ...state.below } : null,
        segments: Object.fromEntries(Object.entries(state.manifest?.segments ?? {}).map(([n, s]) => [n, { stride: s.stride, init: s.init, bytes: s.bytes, encodeMs: s.encodeMs, tailMs: s.tailMs,
          ...(s.box !== undefined ? { box: s.box } : {}), at: s.at ?? null }])),
        inits: Object.keys(state.manifest?.inits ?? {}),
      })),
      log: this.log.slice(-40),
    };
  }

  note(message) {
    this.log.push({ at: Date.now(), message });
    while (this.log.length > 200) this.log.shift();
  }

  /** Encoder (determined after `probeEncoders` actually encodes a short segment; probed once per process) */
  async encoder() {
    if (this.encoderName) return this.encoderName;
    this.ffmpeg ||= await findFfmpeg();
    const { encoder } = await pickStreamEncoder(this.ffmpeg);
    this.encoderName = encoder;
    this.note(`Encoder: ${encoder}`);
    return encoder;
  }

  /* ---------------------------------------------------------------------- *
   * X1: Track streams go through the queue (`docs/plan/m6c-contract.md` X1)
   *
   * In queue mode, stream segments are produced by fine-grained tasks in the render queue
   * (`kind: 'stream'`, `STREAM_SEGMENTS` segments per task): nodes that claim tasks call
   * `produceRange` via the executor to produce full density segments by segment here, write them
   * to disk, and emit layers. Automatic production on this machine (`runWorker`) skips streams
   * owned by the queue (`queueOwned`); otherwise all tasks would undergo deduplication.
   *
   * The encoder only enters segment signatures and manifests (`segmentSignature`,
   * `inits[].encoder`), not the stream key: stream key = content key × environment fingerprint
   * (`planStreams`), so nodes with different encoders produce segments under the same key, and
   * consumers accept them according to the manifest (`adoptSegments`).
   * ---------------------------------------------------------------------- */

  /**
   * Whether this machine can produce track streams (`capabilities.streams` in `node.hello`): returns
   * false if the switch is off (`PROMPTCUT_STREAMS=0`); if on, probes the encoder once (same
   * `encoder()` as `runWorker`, probed only once per process); returns false if not found, and shuts
   * down the producer following `runWorker`'s approach.
   */
  async capable() {
    if (!this.enabled || this.closed) return false;
    try {
      await this.encoder();
      return true;
    } catch (error) {
      this.enabled = false;
      this.note(`No usable H.264 encoder, track stream disabled: ${error?.message || error}`);
      return false;
    }
  }

  /**
   * Whether this stream is produced by the queue: created only for queue tasks (`queueOnly`), or its
   * belonging entry is in queue mode (`queueSnapshots`, set by `/preload` in queue mode, cleared by
   * `leaveQueueMode` when unable to connect to the document service: read fresh here, and automatic
   * production takes over immediately once cleared).
   */
  queueOwned(state) {
    if (state?.queueOnly === true) return true;
    const key = state?.entryKey ?? this.entryKey;
    const entry = key ? this.pipeline.entries?.get?.(key) : null;
    // Integration ruling (m6c-contract "Rulings during Integration" X1 gap): the node that split this
    // plan revision did not split out stream tasks (its streams are disabled);
    // `FramePipeline.releaseQueueStreams` returns this revision's streams to local automatic
    // production, while snapshots continue through the queue as usual
    return entry?.queueSnapshots === true && entry.queueStreamsLocal !== true;
  }

  /**
   * State in the producer for this stream to be produced by the queue task: use it if already on
   * hand (from automatic production or created by another task): a stream key can only have one
   * state, otherwise two in-memory manifests will overwrite `stream.json` with each other; if
   * absent (standalone render host, not yet preloaded to this revision, or only pulled
   * `adoptedOnly`), create a `queueOnly` one according to `spec`: has an isolated project and can
   * emit layers, but automatic production will not touch it.
   */
  async queueState(entry, spec) {
    await this.assertProjectScope?.(entry, spec);
    const usable = state => state && !state.adoptedOnly && (!this.projectId || !state.projectId || state.projectId === this.projectId);
    let state = this.streams.get(spec.streamKey);
    if (!usable(state)) {
      const loaded = await this.store.load(spec.streamKey);
      const validLoaded = loaded && (!this.projectId || !loaded.projectId || loaded.projectId === this.projectId) ? loaded : null;
      const manifest = (state && (!this.projectId || !state.projectId || state.projectId === this.projectId) ? state.manifest : null) ?? validLoaded ?? this.freshManifest(spec);
      state = this.streams.get(spec.streamKey);
      if (!usable(state)) {
        const base = state ?? { reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set() };
        delete base.adoptedOnly;
        base.queueOnly = true;
        if (this.projectId) base.projectId = this.projectId;
        base.spec = this.projectId && !spec.projectId ? { ...spec, projectId: this.projectId } : spec;
        base.manifest = anchorManifest(base.manifest ?? manifest, spec);
        base.aliases ||= new Set();
        base.generation = this.generation;
        base.entryKey = entry.key;
        state = base;
        this.streams.set(spec.streamKey, state);
      }
    }
    state.isolated ||= this.isolatedOf(entry, spec);
    return state;
  }

  /**
   * Which project this stream's isolated project is built from: the subset expanded according to
   * this stream in multi-project mode, or the entire project in single-project mode (see the
   * explanation of `subset` in the constructor)
   */
  isolatedOf(entry, spec) {
    if (!this.subset) return isolatedStreamProject(entry.project, spec);
    const need = streamNeed(spec);
    return isolatedStreamProject(need ? expandProject(entry.project, need).project : entry.project, spec);
  }

  /**
   * Queue stream task: produces segments `[from, to]` segment by segment, completing each segment
   * only after waiting for encoding to finalize, writing to disk, and emitting layers (`storeSegment`,
   * with C6.4 push hooks as usual). `density: 'sparse'` indicates a sparse stream task
   * (`SPARSE_STRIDE`, capturing only the first frame of each segment): skips if this segment
   * already has a sparse or full density version; omitted indicates a full density task
   * (`stride = 1`): skips segments that are already full density and not stale. If automatic
   * production is currently working on it (`reserved`), wait for it to finish. If a segment fails
   * to produce `QUEUE_SEGMENT_ATTEMPTS` consecutive times, throws a retryable error.
   * Prerendering shares the `leaseStreamBakery` pool with automatic production, borrowing only
   * once for the entire range: adjacent segments continue pushing with the lease without
   * re-injecting the project. `progress(done)`: number of frames already readied in this range
   * (each segment based on its actual frame count; the stream's final segment can have fewer than
   * 15 frames). Returns `{ produced, skipped }`.
   */
  async produceRange(entry, spec, range, { signal, progress, density = null } = {}) {
    await this.assertProjectScope?.(entry, spec);
    const sparse = density === 'sparse';
    const stride = sparse ? SPARSE_STRIDE : 1;
    /**
     * Whether this segment still needs to be produced: sparse tasks only fill in missing ones
     * (or those with mismatched signatures); full density tasks fill until full density
     */
    const pending = (state, n) => { const s = this.segmentState(state, n); return sparse ? (s === 'none' || s === 'stale') : s !== 'dense'; };
    const cancelled = () => Object.assign(new Error('Queue task cancelled'), { cancelled: true });
    if (!this.enabled || this.closed) throw Object.assign(new Error('The local track stream is disabled'), { code: 'streams-disabled', retryable: false });
    if (!this.routeAttached) throw Object.assign(new Error('The track stream segment read endpoint is not attached yet'), { code: 'streams-not-ready', retryable: true });
    if (!(await this.capable())) throw Object.assign(new Error('This machine has no usable H.264 encoder'), { code: 'no-stream-encoder', retryable: false });
    const from = Math.max(range.from, spec.firstSegment), to = Math.min(range.to, spec.lastSegment);
    const state = await this.queueState(entry, spec);
    state.queueHolds = (state.queueHolds ?? 0) + 1;
    let bakery = null, produced = 0, skipped = 0, frames = 0;
    const report = () => { try { progress?.(frames); } catch { /* Progress callback errors do not affect production */ } };
    try {
      for (let n = from; n <= to; n++) {
        let attempts = 0, made = false;
        while (pending(state, n)) {
          if (signal?.aborted || this.closed) throw cancelled();
          // Streams that failed differential layer extraction measurement (`belowSegmentCapture`): this
          // kind of stream cannot be produced for this card, and switching to another identical node will
          // be the same; do not retry
          if (state.below?.failed) throw Object.assign(new Error(`Differential layer capture failed for stream ${spec.streamKey.slice(0, 8)} (${state.below.failed})`), { code: 'below-capture-failed', retryable: false });
          if (state.reserved.has(n)) { await sleep(50); continue; }
          if (attempts++ >= QUEUE_SEGMENT_ATTEMPTS) {
            throw Object.assign(new Error(`Stream ${spec.streamKey.slice(0, 8)} segment ${n} failed to produce ${QUEUE_SEGMENT_ATTEMPTS} times in a row`), { code: 'stream-segment-failed', retryable: true });
          }
          const task = { state, segment: n, stride, queue: { signal } };
          state.reserved.add(n);
          let handedOff = false;
          try {
            bakery ||= await this.pipeline.leaseStreamBakery();
            handedOff = await this.runSegment(bakery, task);
          } catch (error) {
            if (signal?.aborted || this.closed) throw cancelled();
            // Passes requiring remeasuring the tight rectangle and re-producing (`runSegment` marked
            // `cancelled`, count is bounded: once per edge for all four edges) do not count as a failed production
            if (error?.cancelled) attempts = Math.max(0, attempts - 1);
            if (!error?.cancelled) {
              this.stats.failures++;
              state.failures.set(n, (state.failures.get(n) ?? 0) + 1);
              this.note(`Queue segment ${spec.streamKey.slice(0, 8)}#${n} failed: ${error?.message || error}`);
              // Session may be broken: switch to a new one (same as `runWorker`)
              if (bakery) { this.pipeline.returnStreamBakery(bakery, { dead: true }); bakery = null; }
            }
          } finally {
            if (!handedOff) state.reserved.delete(n);
          }
          // Encoding finalizes in the background (`storeSegment`), waiting for it to write to disk;
          // it swallows exceptions on its own, so retry in this while loop iteration on failure
          if (handedOff) { await task.job; made = true; }
        }
        if (made) produced++; else skipped++;
        frames += streamSegmentFrameCount(n, spec.originFrame, spec.lastFrame);
        report();
      }
    } finally {
      state.queueHolds = Math.max(0, (state.queueHolds ?? 1) - 1);
      if (bakery) this.pipeline.returnStreamBakery(bakery);
    }
    if (signal?.aborted) throw cancelled();
    return { produced, skipped };
  }

  /**
   * Frame-by-frame bitmaps dedicated to export (`./export-frames.mjs`; visuals of cards not executed
   * on this page during online browser export): captures one frame per frame covered by segments
   * `[from, to]` according to this stream's rectangular upper bound, handing them one by one to
   * `onFrame(frame, shot)` (`shot` is PNG, or `{ rgba, width, height }`), without compressing into
   * video or entering the stream store. Frame pushing, isolated projects, and differential layer
   * extraction all use the same pipeline as `runSegment` (the same code), so the visuals are
   * pixel-identical to full density segments of this card's track stream before compression. `spec`
   * is the result of `exportSpecOf`. This type of state is not registered in `streams` (not read by
   * preview), but recorded separately by the export result key, which is also used for the lease
   * signature so it will not connect to the same lease as track streams of the same card. If a
   * segment fails to capture `QUEUE_SEGMENT_ATTEMPTS` consecutive times, throws a retryable error.
   */
  async produceExportRange(entry, spec, range, { signal, progress, onFrame } = {}) {
    await this.assertProjectScope?.(entry, spec);
    const cancelled = () => Object.assign(new Error('Queue task cancelled'), { cancelled: true });
    if (this.closed) throw cancelled();
    if (typeof onFrame !== 'function') throw new Error('produceExportRange requires onFrame');
    const key = this.projectId ? `${this.projectId}:${spec.exportResultKey}` : spec.exportResultKey;
    this.exportStates ||= new Map();
    let state = this.exportStates.get(key);
    if (!state) {
      const own = { ...spec, streamKey: key, ...(this.projectId ? { projectId: this.projectId } : {}) };
      state = { spec: own, manifest: this.freshManifest(own), isolated: this.isolatedOf(entry, spec), reserved: new Set(), failures: new Map(), exportOnly: true };
      this.exportStates.set(key, state);
      while (this.exportStates.size > 16) this.exportStates.delete(this.exportStates.keys().next().value);
    }
    // Self-check records of differential layer extraction are not kept across tasks to permanently
    // fail: if the previous task judged it a failure, this task tries again (if it fails, this task
    // still stops as early as possible). If not cleared, the same content would stay
    // `below-capture-failed` forever until this process restarts, and re-exporting would not help
    if (state.below?.failed) state.below = null;
    const from = Math.max(range.from, 0), to = Math.min(range.to, spec.lastSegment);
    let bakery = null, frames = 0;
    try {
      for (let n = from; n <= to; n++) {
        for (let attempts = 0; ;) {
          if (signal?.aborted || this.closed) throw cancelled();
          if (state.below?.failed) throw Object.assign(new Error(`Differential layer capture failed for export bitmap ${key.slice(0, 8)} (${state.below.failed})`), { code: 'below-capture-failed', retryable: false });
          try {
            bakery ||= await this.pipeline.leaseStreamBakery();
            await this.runSegment(bakery, { state, segment: n, stride: 1, queue: { signal }, exportSink: onFrame });
            break;
          } catch (error) {
            if (signal?.aborted || this.closed) throw cancelled();
            if (error?.retryable === false) throw error;
            this.stats.failures++;
            this.note(`Export bitmap ${key.slice(0, 8)}#${n} failed: ${error?.message || error}`);
            if (bakery) { this.pipeline.returnStreamBakery(bakery, { dead: true }); bakery = null; }
            if (++attempts >= QUEUE_SEGMENT_ATTEMPTS) {
              throw Object.assign(new Error(`Export bitmap ${key.slice(0, 8)} segment ${n} failed to capture ${QUEUE_SEGMENT_ATTEMPTS} times in a row: ${error?.message || error}`), { code: 'export-frames-failed', retryable: true });
            }
          }
        }
        frames += streamSegmentFrameCount(n, spec.originFrame, spec.lastFrame);
        try { progress?.(frames); } catch { /* Progress callback errors do not affect production */ }
      }
    } finally {
      if (bakery) this.pipeline.returnStreamBakery(bakery);
    }
    if (signal?.aborted) throw cancelled();
    return { frames };
  }

  /**
   * New revision of project / card plan (`preload` is called after anchor frames are ready).
   * Recalculates expected streams (G6: recalculates expected signatures of affected streams when
   * `localRev` changes), reads back existing segments on disk, emits `layer`, and wakes up workers.
   */
  async update(entry) {
    if (!this.enabled || this.closed || !entry) return [];
    await this.assertProjectScope?.(entry);
    if (!this.routeAttached) { this.pendingEntry = entry; return []; }
    const specs = planStreams(entry, {
      // Section 17 of c10a contract: clips added to the set on prerender retry do not produce streams
      // (`streamPicked`); falls back to `prerenderPicked` when the old pipeline double lacks it
      picked: clipId => (this.pipeline.streamPicked ?? this.pipeline.prerenderPicked).call(this.pipeline, entry, clipId),
      budget: this.budget,
      codeVersion: `${STREAM_CODE_VERSION}:${this.pipeline.captureCode?.() || ''}`,
      // M4: Stream key multiplied by the environment fingerprint of this process's prerender Chrome
      // (null when not yet determined, planStreams returns [])
      envFingerprint: this.pipeline.envFingerprint,
      ...(this.projectId ? { projectId: this.projectId } : {}),
    });
    const generation = ++this.generation;
    // First read back all manifests that need disk reading (this section yields the event loop),
    // then update state **synchronously**: when two updates interleave, if the older one discovers
    // upon finishing reading that it is no longer the latest generation, it invalidates entirely
    // and does not modify the state shared by the newer generation (Item 4 review #5)
    const loaded = new Map();
    for (const spec of specs) {
      if (loaded.has(spec.streamKey) || this.streams.get(spec.streamKey)?.manifest) continue;
      loaded.set(spec.streamKey, await this.store.load(spec.streamKey));
      if (generation !== this.generation) return specs;
    }
    if (generation !== this.generation || this.closed) return specs;
    this.entryKey = entry.key;
    const next = new Map();
    for (const spec of specs) {
      // Two clips from the same card with the same parameters and in point (e.g., duplicated and
      // stacked on two tracks) are pixel-identical in content and share one stream
      if (next.has(spec.streamKey)) { next.get(spec.streamKey).aliases.add(spec.topClipId); continue; }
      const old = this.streams.get(spec.streamKey);
      const manifest = old?.manifest ?? loaded.get(spec.streamKey) ?? this.freshManifest(spec);
      const state = old ?? { reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set() };
      // C6.2: Streams newly created during pull (`adoptSegments`) entered this revision's plan and
      // are normal streams from now on (catch-up produce, emit layers, and claim as usual)
      delete state.adoptedOnly;
      // X1: Streams created only for queue tasks entered this revision's plan: whether they belong to
      // the queue is now determined by this revision entry's mode (`queueOwned`)
      delete state.queueOnly;
      if (this.projectId) state.projectId = this.projectId;
      state.spec = spec;
      state.aliases = new Set();
      state.manifest = anchorManifest(manifest, spec);
      state.isolated = this.isolatedOf(entry, spec);
      state.generation = generation;
      // Item 4: Layers of this stream are only sent to sessions whose current version is this entry
      state.entryKey = entry.key;
      next.set(spec.streamKey, state);
    }
    // X1: Streams currently being produced by queue tasks (`queueHolds > 0`) are kept even if not
    // in this revision's plan: stream keys are content-addressed and remain valid after production;
    // replacing them would invalidate segments of running queue tasks
    for (const [key, state] of this.streams) if (!next.has(key) && (state.queueHolds ?? 0) > 0) next.set(key, state);
    this.streams = next;
    if (generation !== this.generation) return specs;
    this.republish();
    this.kick();
    return specs;
  }

  freshManifest(spec) {
    // `lastFrame`: The stream's own last frame. Manifest headers include it on push, and writing to
    // the content store truncates buckets according to it (`src/render/streamBuckets.mjs`)
    return { version: STREAM_CODE_VERSION, streamKey: spec.streamKey, ...(this.projectId ? { projectId: this.projectId } : {}), kind: spec.kind, plane: spec.plane, clipIds: spec.clipIds,
      fps: spec.fps, originFrame: spec.originFrame, ...(Number.isInteger(spec.lastFrame) ? { lastFrame: spec.lastFrame } : {}),
      bound: spec.bound, offset: spec.offset, tight: null, inits: {}, segments: {} };
  }

  /**
   * Emits ready segments of each stream at this moment as C3 `layer` (`kind: 'stream'`, unit is
   * segment number; carries the stream's first frame `originFrame`, which the page uses to convert
   * project frame numbers to segment numbers; group streams carry `groupClipIds`, attached to the
   * topmost card in the group). Simultaneously attaches to `stageByKey`: when sessions switch
   * versions, the table is cleared first and restored later via claiming. Emitting layers passes
   * Item 4's gate: only enters sessions whose current version matches this stream's entry
   * (`state.entryKey`).
   */
  republish() {
    if (!this.routeAttached) return;
    for (const state of this.streams.values()) this.publish(state);
  }

  publish(state) {
    const ranges = readySegmentRanges(state.manifest);
    if (!ranges.length) return;
    const { spec } = state;
    const ready = this.pipeline.ready;
    try {
      ready.stageByKey({ kind: 'stream', key: spec.streamKey, ranges });
      // C6.2: Streams merely pulled and not yet belonging to any revision (`adoptedOnly`) have no known
      // session to send to: only attached to keys, waiting until they enter a revision's plan (`update`
      // takes over this state) before emitting layers as usual
      if (state.adoptedOnly) return;
      const entryKey = state.entryKey ?? this.entryKey;
      for (const clipId of [spec.topClipId, ...(state.aliases ?? [])]) {
        ready.publish(entryKey, { clipId, kind: 'stream', key: spec.streamKey, ranges, ...(isStreamOrigin(spec.originFrame) ? { originFrame: spec.originFrame } : {}),
          ...(spec.kind === 'group' ? { groupClipIds: spec.clipIds } : {}), ...belowLayerMark(spec, clipId) });
      }
    } catch {}
  }

  /** Current state of this segment: missing / signature mismatch / sparse / full density */
  segmentState(state, n) {
    const seg = state.manifest?.segments?.[n];
    if (!seg) return 'none';
    // C6.2 (Section 6 of contract): Segments produced by other nodes and pulled in do not recalculate
    // signatures using this machine's encoder name: machines with identical fingerprints but
    // different encoder names would classify them as stale and rerender. The manifest resides in this
    // stream's directory (stream key = content key × fingerprint); unchanged stream key means
    // unchanged content, considered fresh
    if (seg.adopted === true && state.manifest.streamKey === state.spec?.streamKey) return seg.stride > 1 ? 'sparse' : 'dense';
    const expectStride = seg.stride > 1 ? seg.stride : 1;
    const rect = expectStride > 1 ? state.manifest.bound : (state.manifest.tight ?? state.manifest.bound);
    const sig = this.encoderName ? segmentSignature({ streamKey: state.spec.streamKey, segment: n, stride: expectStride, encoder: this.encoderName, rect }) : seg.sig;
    if (seg.sig !== sig) return 'stale';
    return seg.stride > 1 ? 'sparse' : 'dense';
  }

  /**
   * Whether this machine should accept this segment produced elsewhere (`seg`, the item in the
   * manifest): this machine lacks it, has classified it as stale, or this machine only has the
   * sparse version while the other party is full density (upgrade). If this machine is already
   * full density, or both sides are sparse, do not accept.
   */
  adoptable(state, n, seg) {
    if (!state?.manifest?.segments?.[n]) return true;
    const mine = this.segmentState(state, n);
    if (mine === 'stale' || mine === 'none') return true;
    return mine === 'sparse' && !(Number(seg?.stride) > 1);
  }

  /** Whether to run the sparse pass (whether any segment in the stream lacks even a sparse version) */
  needsSparse(state, n) { return this.segmentState(state, n) === 'none'; }
  needsDense(state, n) { const s = this.segmentState(state, n); return s !== 'dense'; }

  /** Current playhead (global frame number) and playing state, read from mirror plugin */
  playheadFrame(fps) {
    let head = null;
    try { head = this.pipeline.playhead?.(); } catch {}
    return { frame: Math.max(0, Math.round((Number(head?.t) || 0) * fps)), playing: !!head?.playing };
  }

  /**
   * Select next task: sparse first, then fill density; the same worker prefers extending its own
   * lease; otherwise pick the stream closest to the playhead. Returns `{ state, segment, stride }`
   * or null.
   */
  nextTask(bakery) {
    const lease = bakery?.streamLease && !bakery.streamLease.dirty ? bakery.streamLease : null;
    // Sparse first, then fill density: if any segment lacks even a sparse version (including those
    // currently encoding), run only the sparse pass
    const sparsePhase = this.needsSparseAnywhere();
    for (const stride of sparsePhase ? [SPARSE_STRIDE] : [1]) {
      const need = stride > 1 ? (s, n) => this.needsSparse(s, n) : (s, n) => this.needsDense(s, n);
      let best = null;
      for (const state of this.streams.values()) {
        // C6.2: Streams merely pulled lack isolated projects; this machine does not catch-up produce for
        // them (produced only after entering a revision's plan)
        // X1: Streams owned by the queue (`queueOwned`) are not produced locally either; produced by the
        // executor per task (`produceRange`)
        if (state.adoptedOnly || this.queueOwned(state)) continue;
        const { spec } = state;
        const failures = state.failures;
        const ready = n => !need(state, n) || (failures.get(n) ?? 0) >= 3;
        const { frame, playing } = this.playheadFrame(spec.fps);
        // Only when the lease stops on the last frame of a segment is it considered "connecting to the next segment"
        const leaseSegment = lease && lease.streamSignature === spec.streamKey ? streamSegmentOf(lease.lastFrame, spec.originFrame) : null;
        const leaseLast = leaseSegment !== null && leaseSegment >= 0 && lease.lastFrame === streamSegmentLastFrame(leaseSegment, spec.originFrame, spec.lastFrame)
          ? leaseSegment : null;
        const pick = planStreamSegments({ playheadFrame: frame, originFrame: spec.originFrame, fps: spec.fps, rate: playing ? 1 : 0, stride,
          firstSegment: spec.firstSegment, lastSegment: spec.lastSegment, ready, reserved: state.reserved, leaseLastSegment: leaseLast });
        if (pick.segment === null) continue;
        if (pick.continues) return { state, segment: pick.segment, stride };
        const start = streamSegmentFirstFrame(pick.segment, spec.originFrame);
        const distance = start >= frame ? start - frame : (frame - start) + spec.total;
        if (!best || distance < best.distance) best = { state, segment: pick.segment, stride, distance };
      }
      if (best) return best;
    }
    return null;
  }

  needsSparseAnywhere() {
    for (const state of this.streams.values()) {
      if (state.adoptedOnly || this.queueOwned(state)) continue;
      for (let n = state.spec.firstSegment; n <= state.spec.lastSegment; n++) {
        if (this.needsSparse(state, n) && (state.failures.get(n) ?? 0) < 3) return true;
      }
    }
    return false;
  }

  /** Wake up workers (do not restart already running ones); at most `pool` */
  kick() {
    if (!this.enabled || this.closed || !this.routeAttached) return;
    while (this.workers.size < this.pool) {
      const worker = this.runWorker().catch(error => this.note(`worker error: ${error?.message || error}`)).finally(() => this.workers.delete(worker));
      this.workers.add(worker);
      if (!this.hasWork()) break;
    }
  }

  hasWork() { return !!this.nextTask(null); }

  async runWorker() {
    let bakery = null;
    try {
      for (;;) {
        if (this.closed || !this.enabled) return;
        if (this.pipeline.streamBusy?.()) { await sleep(250); continue; }
        // Encoders must be settled first: included in segment signatures. If none are usable, shut down
        // entirely (record a diagnostic entry) without probing repeatedly
        try { await this.encoder(); } catch (error) {
          this.enabled = false;
          this.note(`No usable H.264 encoder, track stream disabled: ${error?.message || error}`);
          return;
        }
        const task = this.nextTask(bakery);
        if (!task) return;
        task.state.reserved.add(task.segment);
        let handedOff = false;
        try {
          bakery ||= await this.pipeline.leaseStreamBakery();
          // Encoding finalizes in the background: reservation must be held until the segment writes to
          // disk, otherwise the same segment will be picked again
          handedOff = await this.runSegment(bakery, task);
        } catch (error) {
          if (error?.cancelled) { /* Cut off by a new version or shutdown: handle in the next round */ }
          else {
            this.stats.failures++;
            task.state.failures.set(task.segment, (task.state.failures.get(task.segment) ?? 0) + 1);
            this.note(`Segment ${task.state.spec.streamKey.slice(0, 8)}#${task.segment} failed: ${error?.message || error}`);
            // Session may be broken (page crashed / protocol timeout): switch to a new one
            if (bakery) { this.pipeline.returnStreamBakery(bakery, { dead: true }); bakery = null; }
          }
        } finally {
          if (!handedOff) task.state.reserved.delete(task.segment);
        }
        this.adaptPool();
      }
    } finally {
      if (bakery) this.pipeline.returnStreamBakery(bakery);
    }
  }

  /** Encoder slots: concurrently active ≤ 2 × streamPool (G4) */
  async encoderSlot() {
    while (this.aliveEncoders >= 2 * this.pool) await new Promise(resolve => this.encoderWaiters.push(resolve));
    this.aliveEncoders++;
    this.stats.maxAliveEncoders = Math.max(this.stats.maxAliveEncoders, this.aliveEncoders);
  }
  releaseEncoderSlot() {
    this.aliveEncoders = Math.max(0, this.aliveEncoders - 1);
    const next = this.encoderWaiters.shift();
    next?.();
  }

  /**
   * Whether this stream uses direct canvas capture (`docs/plan/prerender-products-contract.md`
   * Section 6.1 gate 1: registration). Returns the direct capture record for this stream, or null if
   * not used. Only single-card streams whose members are registered as canvas cards (`canvasHeavy` in
   * the review table) use it; group streams, other stream types, and streams that failed measurement
   * take screenshots as usual. Gate 2 (measurement during stream production) and "whether direct
   * capture is fast" are both in `directSegmentCapture`, performed on the first frame of each segment.
   */
  directOf(state) {
    const { spec } = state;
    if (this.direct === 'off' || spec.kind !== 'card' || spec.members?.length !== 1 || spec.members[0]?.capabilities?.canvasHeavy !== true) return null;
    const record = state.direct ||= newDirectRecord();
    if (record.failed) return null;
    // Last attempt showed it was not faster than taking screenshots: rest for several segments before retrying
    if (this.direct !== 'always' && record.cooldown > 0) { record.cooldown--; return null; }
    return record;
  }

  /**
   * Produces a segment (G4: production of an individual segment is its own run). Continues pushing
   * if the lease connects; if not, injects this stream's isolated project into the session and
   * replays from the mount frame. Emitted frames are fed frame by frame to this segment's encoder;
   * encoding finalizes in the background (double buffering).
   *
   * Below-dependent streams (`kind: 'below'`) capture two screenshots per frame and perform
   * differential layer extraction (`./bakery/capture-below.mjs`): the isolated project retains the
   * lower layer, and screenshot rectangles are always the upper bound (the entire frame, not
   * changing with tightening: frosted glass must sample surrounding lower layers); what is handed
   * to the encoder is that layer cropped to the rectangle of this pass. When the project contains
   * visual assets, wait for assets to be ready before taking screenshots. The paths taken by the
   * other two stream types remain item-for-item identical to before.
   */
  async runSegment(bakery, task) {
    const { state, segment, stride } = task;
    const { spec } = state;
    const below = spec.kind === 'below';
    // Streams that failed differential layer extraction measurement are no longer produced (avoids
    // paying for re-injection and replay in vain); automatic production records it as a failure for
    // this segment, and stops picking it after three times
    if (below && state.below?.failed) throw Object.assign(new Error(`Differential layer capture failed (${state.below.failed}); this stream will no longer be produced`), { code: 'below-capture-failed', retryable: false });
    // X1: Segments produced by queue tasks (`task.queue`) are not invalidated across revisions:
    // stream keys are content-addressed, so if a revision changes but the key remains unchanged,
    // segments remain valid; only invalidated when the task is aborted, the producer is shut down, or
    // this stream is replaced. `generation: null` prevents `storeSegment` from classifying as stale
    // by version
    const queue = task.queue ?? null;
    const generation = queue ? null : state.generation;
    const fps = spec.fps;
    // Project frames covered by this segment: counted from the stream's own first frame, with the
    // final segment ending at the stream's last frame (`streamSegments.mjs`)
    if (!isStreamOrigin(spec.originFrame)) throw Object.assign(new Error(`Stream ${spec.streamKey.slice(0, 8)} has no first frame, so segments cannot be produced`), { retryable: false });
    const fromFrame = streamSegmentFirstFrame(segment, spec.originFrame);
    const toFrame = streamSegmentLastFrame(segment, spec.originFrame, spec.lastFrame);
    const samples = toFrame - fromFrame + 1;
    if (segment < 0 || samples < 1) throw Object.assign(new Error(`Stream ${spec.streamKey.slice(0, 8)} has no segment ${segment}`), { retryable: false });
    // Frame-by-frame bitmaps dedicated to export (`produceExportRange`): same frame pushing and
    // frame capture, frames do not enter encoders and are passed to `exportSink`; always captured
    // by rectangular upper bound, without measuring or tightening, and without direct canvas capture
    const exportSink = typeof task.exportSink === 'function' ? task.exportSink : null;
    const encoder = exportSink ? null : await this.encoder();
    const manifest = state.manifest;
    /*
     * Remeasurement pass (`state.remeasure`): during the previous fill of this segment, visuals
     * touched the edges of the tight rectangle. This pass extends the touched edges to the upper
     * bound, measures every frame to determine where this segment actually reaches, and expands
     * the tight rectangle according to measurements (`settleTight`); if the expanded rectangle
     * differs from the one used in this pass, this segment is produced again using it.
     */
    const remeasure = !exportSink && stride === 1 && spec.kind !== 'below' && manifest.tight && state.remeasure?.segment === segment ? state.remeasure : null;
    const rect = stride > 1 || exportSink ? manifest.bound
      : remeasure ? evenRect(extendSides(manifest.tight, remeasure.sides, manifest.bound), manifest.bound)
        : (manifest.tight ?? manifest.bound);
    const captureRect = { x: rect.x + spec.offset.x, y: rect.y + spec.offset.y, w: rect.w, h: rect.h };
    // Below-dependent streams: both screenshots are captured by upper bound, and cropped to
    // `captureRect` after calculation
    const viewRect = below ? { x: manifest.bound.x + spec.offset.x, y: manifest.bound.y + spec.offset.y, w: manifest.bound.w, h: manifest.bound.h } : captureRect;
    const sparse = stride > 1;
    const replay = spec.replay !== false;
    /*
     * Sparse segments only capture the first frame of this segment. Streams that require replay
     * (motion-style) push every frame of this segment as before (the next segment continues pushing
     * with the lease; otherwise every segment would have to restart from the mount frame); streams
     * that do not require replay (remotion-style) only push up to the first frame and stop, and the next
     * segment jumps directly: jumping on the same stream and the same page, without reloading the project.
     */
    const bakeTo = sparse && !replay ? fromFrame : toFrame;
    const lease = bakery.streamLease;
    const samePage = !!lease && !lease.dirty && lease.page === bakery.page && lease.streamSignature === spec.streamKey;
    const continues = samePage && lease.lastFrame + 1 === fromFrame;
    if (!continues && !(sparse && !replay && samePage)) {
      await bakery.reset(state.isolated, this.pipeline.emptyUrl(state.isolated), { deferCards: true });
      bakery.streamLease = null;
      this.stats.resets++;
      this.stats.setFrameWindowCalls++;
      state.resets = state.resets ?? { sparse: 0, dense: 0 };
      state.resets[stride > 1 ? 'sparse' : 'dense']++;
    }
    /*
     * Below-dependent streams that require replay: draw on every tick (`BELOW_DISCARD_SHOT`
     * explanation). The approach is to have `bakeStream` also treat "pushed frames" as frames to capture
     * (starting from its original replay start point, with a step of 1), drawing and discarding frames
     * not needed by this segment inside the frame-capture hook; `bakeStream` and snapshot code remain
     * completely untouched.
     * `drawFrom`: when the lease can be resumed, it is the first frame of this segment; when it cannot
     * be resumed, it is the replay start point (the same number as `startFrame` computed by `bakeStream`
     * itself).
     */
    const drawAll = below && replay;
    const drawFrom = drawAll && !continues && Number.isInteger(spec.mountFrame) ? Math.max(0, Math.min(fromFrame, spec.mountFrame)) : fromFrame;
    const wanted = frame => frame >= fromFrame && (frame - fromFrame) % stride === 0;
    let discarded = 0, discardedBefore = 0;
    const abort = new AbortController();
    const stale = () => this.closed || (!exportSink && this.streams.get(spec.streamKey) !== state)
      || (queue ? queue.signal?.aborted === true : state.generation !== generation);
    const guard = setInterval(() => { if (stale()) abort.abort(); }, 100);
    guard.unref?.();
    let enc = null;
    let firstCapture = true;
    /**
     * Position rectangle of this segment (plane coordinates): `undefined` = not measured,
     * `null` = this frame is completely transparent
     */
    let segmentBox;
    /** Union of opaque regions across every frame in this segment during the remeasurement pass (plane coordinates) */
    let remeasured = null;
    // During densification, check every frame to see if the picture hits the edges of the tight
    // rectangle (below-dependent streams have their own approach, see `below-overflow`); no need to
    // check when the rectangle is already the upper bound
    const guardTight = !exportSink && !sparse && !below && JSON.stringify(rect) !== JSON.stringify(manifest.bound);
    try {
      /*
       * Streams that do not require replay (members are all remotion-style, `spec.replay === false`):
       * do not pass `mountFrame`, and pass 0 for warmup frames.
       * For "no `mountFrame` provided", `bakeStream` mounts starting from `fromFrame`; if the lease
       * cannot be resumed, it only pays the cost of reloading the page once, without pushing
       * frame-by-frame from the mount frame anymore; therefore segments do not need to be produced
       * in order. `server/bakery/bake.mjs` remains completely untouched (code fingerprint).
       */
      // Direct canvas fetch: frames of this segment are not captured via snapshot, but fetched as
      // pixels directly from the canvas (those failing the practical test still use snapshots as
      // before); `shot` is PNG, or `{ rgba, width, height }`
      const direct = exportSink ? null : this.directOf(state);
      const belowCapture = below ? belowSegmentCapture(bakery, { clipId: spec.topClipId, view: viewRect, rect: captureRect, record: state.below ||= newBelowRecord(), signal: abort.signal,
        note: message => this.note(`Stream ${spec.streamKey.slice(0, 8)} ${message}`) }) : null;
      const result = await bakeStream(bakery, {
        streamSignature: spec.streamKey, fromFrame: drawAll ? drawFrom : fromFrame, toFrame: bakeTo, stride: drawAll ? 1 : stride, fps,
        ...(replay ? { mountFrame: spec.mountFrame } : { warm: 0 }),
        // The type that draws on every tick: assets only wait before frames that are actually to be
        // captured (discarded frames do not need to wait for video to be ready), so it is not handed over
        // to `bakeStream` to wait frame by frame
        clip: viewRect, hasMedia: below && !drawAll && spec.hasMedia === true, signal: abort.signal,
        ...(drawAll ? { capture: async (frame, shoot, info) => {
          if (!wanted(frame)) {
            await bakery.beginFrame({ screenshot: BELOW_DISCARD_SHOT });
            discarded++;
            if (frame < fromFrame) discardedBefore++;
            return BELOW_SKIPPED;
          }
          if (spec.hasMedia === true) await prepareFrameMedia(bakery);
          return belowCapture(frame, shoot, info);
        } }
        : below ? { capture: belowCapture }
        : direct ? { capture: directSegmentCapture(bakery, { clipId: spec.topClipId, rect: captureRect, record: direct, stride, captures: Math.ceil(samples / stride), always: this.direct === 'always',
          note: message => this.note(`Stream ${spec.streamKey.slice(0, 8)} ${message}`) }) } : {}),
        onFrame: async (frame, shot) => {
          if (stale()) throw Object.assign(new Error('Stream is obsolete'), { cancelled: true });
          // Frames drawn and discarded (not needed by this segment) do not enter the encoder
          if (shot === BELOW_SKIPPED || (drawAll && !wanted(frame))) return;
          if (exportSink) { await exportSink(frame, shot); return; }
          const raw = shot?.rgba ? shot : null;
          if (sparse || frame === fromFrame || guardTight || remeasure) {
            // Bounding box of opaque pixels in this frame (pixel coordinates within the snapshot rectangle)
            const local = raw ? rgbaAlphaBox(raw.rgba, raw.width, raw.height) : pngAlphaBox(shot);
            if (sparse) segmentBox = this.measureBox(state, frame, local, rect);
            else if (frame === fromFrame && !local?.full) segmentBox = local ? { x: rect.x + local.x, y: rect.y + local.y, w: local.w, h: local.h } : null;
            // Remeasurement pass: record where each frame in this segment actually reaches (plane coordinates);
            // images that cannot be parsed are treated as covering the entire frame
            if (remeasure) remeasured = unionRect(remeasured, !local ? null : local.full ? rect : { x: rect.x + local.x, y: rect.y + local.y, w: local.w, h: local.h });
            if (guardTight && local && !local.full) {
              const sides = tightOverflowSides(local, rect, manifest.bound);
              if (sides) throw Object.assign(new Error(`The picture in frame ${frame} hit the edge of the tight rectangle (${Object.keys(sides).join(', ')})`), { code: 'tight-overflow', sides });
            }
          }
          if (!enc) {
            // When the first image comes out, no encoder for this segment is running yet: the image output
            // time for this frame is counted as an "idle" sample
            await this.encoderSlot();
            enc = openStreamSegmentEncoder(this.ffmpeg, { encoder, fps, ...(raw ? { raw: { width: raw.width, height: raw.height } } : {}) });
          }
          const repeat = Math.min(stride, toFrame - frame + 1);
          for (let k = 0; k < repeat; k++) await enc.write(raw ? raw.rgba : shot);
          firstCapture = false;
        },
      });
      if (result.reset) this.stats.bakeStreamResets = (this.stats.bakeStreamResets ?? 0) + 1;
      // Cumulative stats for the image capture section of this stream (diagnostic: `capture` for each
      // stream in `status()`; how many frames were captured, and how many milliseconds image capture and
      // frame pushing each took)
      // Frames drawn and discarded are not counted as captured frames; those before the first frame of
      // the segment are replayed frames (`bakeStream` counted them into `captured`)
      result.captured -= discarded;
      result.replayed = (result.replayed ?? 0) + discardedBefore;
      const taken = state.capture ||= { frames: 0, captureMs: 0, stepMs: 0 };
      taken.frames += result.captured; taken.captureMs += result.captureMs; taken.stepMs += result.stepMs;
      if (discarded) taken.discarded = (taken.discarded ?? 0) + discarded;
      // Number of replayed frames (`bakeStream`'s `replayed`): streams that do not replay are always 0;
      // probes read `status()` to verify
      this.stats.replayedFrames = (this.stats.replayedFrames ?? 0) + (result.replayed ?? 0);
      state.replayedFrames = (state.replayedFrames ?? 0) + (result.replayed ?? 0);
      if (result.captured) {
        const per = result.captureMs / result.captured;
        (this.aliveEncoders > 1 ? this.measure.busy : this.measure.idle).push(per);
        while (this.measure.busy.length > 50) this.measure.busy.shift();
        while (this.measure.idle.length > 50) this.measure.idle.shift();
      }
    } catch (error) {
      if (enc) { await enc.abort(); this.releaseEncoderSlot(); }
      bakery.streamLease = null;
      // Differential layer extraction discovered that the target card was modified outside the tight
      // rectangle (frames not measured in the sparse pass): expand the tight rectangle, restart this
      // segment with the new rectangle, not counted as failure
      if (below && error?.code === 'below-overflow' && this.widenTight(state, error.box)) error.cancelled = true;
      // Other streams: during densification, the picture hit the edges of the tight rectangle (sparse
      // version only measured the first frame of each segment). Restart this segment for one pass,
      // expanding those sides to the upper bound and measuring every frame (see above), not counted as failure
      if (error?.code === 'tight-overflow') {
        state.remeasure = { segment, sides: { ...(remeasure?.sides ?? {}), ...error.sides } };
        error.cancelled = true;
      }
      throw error;
    } finally { clearInterval(guard); }
    if (remeasure) {
      state.remeasure = null;
      const settled = this.settleTight(state, remeasured, remeasure.sides);
      if (JSON.stringify(settled) !== JSON.stringify(rect)) {
        // This pass was produced according to the rectangle expanded to the upper bound, which is larger
        // than the finalized tight rectangle: do not keep it, produce this segment once more with the
        // finalized rectangle (not counted as failure)
        if (enc) { await enc.abort(); this.releaseEncoderSlot(); }
        bakery.streamLease = null;
        throw Object.assign(new Error(`The tight rectangle of stream ${spec.streamKey.slice(0, 8)}#${segment} was re-measured; restarting with the new rectangle`), { cancelled: true });
      }
    }
    // Frame-by-frame bitmaps dedicated for export: frames have already been delivered frame by frame;
    // no encoder, does not enter the stream store
    if (exportSink) return true;
    if (!enc) return false;
    void firstCapture;
    const job = enc.finish()
      .then(out => this.storeSegment(state, generation, { segment, stride, rect, encoder, samples, out, box: segmentBox }))
      .catch(error => {
        this.stats.failures++;
        state.failures.set(segment, (state.failures.get(segment) ?? 0) + 1);
        this.note(`Segment ${spec.streamKey.slice(0, 8)}#${segment} encoding failed: ${error?.message || error}`);
      })
      .finally(() => { state.reserved.delete(segment); this.releaseEncoderSlot(); this.encoding.delete(job); this.kick(); });
    this.encoding.add(job);
    // X1: queue tasks must wait until this segment is actually written to disk to be considered
    // finished producing (`produceRange`); automatic production does not wait (double buffering)
    task.job = job;
    return true;
  }

  /**
   * In the sparse pass, measure a position rectangle for each segment: bounding box of pixels with
   * alpha > 0 in this frame (the first frame of the segment), converted back to plane coordinates,
   * without expansion. The snapshot rectangle is `rect` (plane coordinates), so image pixel (x, y)
   * on the plane is (rect.x + x, rect.y + y). `local` is the result of `pngAlphaBox` / `rgbaAlphaBox`.
   * Returns the position rectangle of this segment (`null` = completely transparent; images that
   * cannot be parsed return `undefined` and record `measureFailed`: this stream will not be tightened).
   * Incidentally merged into the union for the entire stream.
   */
  measureBox(state, frame, local, rect) {
    if (local?.full) { state.measureFailed = true; return undefined; }
    const box = local ? { x: rect.x + local.x, y: rect.y + local.y, w: local.w, h: local.h } : null;
    if (box) state.measured = unionRect(state.measured, box);
    state.measuredSegments.add(streamSegmentOf(frame, state.spec.originFrame));
    return box;
  }
  /**
   * Finalize the tight rectangle after the sparse version of the entire stream is complete: expand
   * the union of position rectangles of all segments (`box` in manifest) slightly, clamp back to the
   * upper bound, and expand to even numbers. If area savings do not reach `TIGHTEN_MIN_SAVING`, do not
   * tighten (to avoid switching variants pointlessly). If any segment lacks a position rectangle
   * (adopted old segments, unparseable images), the entire stream is transparent, or full-density
   * segments produced against the upper bound already exist (tightening would classify them as stale
   * and re-produce them), do not tighten.
   */
  maybeTighten(state) {
    const manifest = state.manifest;
    if (manifest.tight || state.measureFailed) return;
    const { spec } = state;
    for (let n = spec.firstSegment; n <= spec.lastSegment; n++) if (this.needsSparse(state, n)) return;
    const bound = manifest.bound;
    let union = null;
    for (let n = spec.firstSegment; n <= spec.lastSegment; n++) {
      const seg = manifest.segments[n];
      // The union must cover **every single** segment, and must not classify full-density segments
      // already produced against the upper bound as stale
      if (!seg || seg.box === undefined || (seg.stride === 1 && !seg.adopted)) { manifest.tight = bound; return; }
      if (seg.box) union = unionRect(union, seg.box);
    }
    if (!union) { manifest.tight = bound; return; }
    const tight = evenRect(intersectRect(padRect(union, MEASURE_PAD_PX), bound), bound);
    manifest.tight = rectArea(tight) <= rectArea(bound) * (1 - TIGHTEN_MIN_SAVING) ? tight : bound;
    this.note(`Stream ${spec.streamKey.slice(0, 8)} tightened to ${JSON.stringify(manifest.tight)} (upper bound ${JSON.stringify(bound)})`);
  }

  /**
   * The tight rectangle of the below-dependent stream is not large enough: in the full-density pass,
   * the target card was modified outside of it (`box`, scene coordinates). Merge it in, then expand,
   * and clamp back to the upper bound. Full-density segments already produced with the old rectangle
   * have mismatched signatures (`segmentState` marks `stale`) and will be re-produced with the new
   * rectangle. Returns whether it was actually enlarged.
   */
  widenTight(state, box) {
    const manifest = state.manifest;
    const { spec } = state;
    if (!manifest?.tight || !box) return false;
    const bound = manifest.bound;
    const plane = { x: box.x - spec.offset.x, y: box.y - spec.offset.y, w: box.w, h: box.h };
    const wider = evenRect(intersectRect(unionRect(manifest.tight, padRect(plane, MEASURE_PAD_PX)), bound), bound);
    if (rectArea(wider) <= rectArea(manifest.tight)) return false;
    state.measured = unionRect(state.measured, plane);
    this.note(`Stream ${spec.streamKey.slice(0, 8)}: tight rectangle widened to ${JSON.stringify(wider)} (was ${JSON.stringify(manifest.tight)}, the target card moved outside it)`);
    manifest.tight = wider;
    return true;
  }

  /**
   * During densification, the picture hit the edges of the tight rectangle (the true sides in
   * `sides`: `{ left, top, right, bottom }`), and a remeasurement pass was run, where the actual
   * extent of each frame in this segment is `measured` (the union in plane coordinates; completely
   * transparent is null). The tight rectangle expands on the sides that were hit to "measured boundary,
   * expanded by `MEASURE_PAD_PX`, plus extra margin": the extra margin equals the distance the
   * picture exceeded the original rectangle in this segment, up to `TIGHT_WIDEN_MARGIN_PX` (the picture
   * will likely keep moving in that direction, reducing retries; small exceedances are not enlarged
   * pointlessly). Other sides remain untouched, clamped back to the upper bound, and expanded to even
   * numbers; if savings after enlargement do not reach `TIGHTEN_MIN_SAVING`, simply use the upper bound.
   * Only enlarges, never shrinks. Full-density segments already produced with the old rectangle have
   * mismatched signatures and will be re-produced with the new rectangle. Returns the finalized tight
   * rectangle.
   */
  settleTight(state, measured, sides) {
    const manifest = state.manifest;
    if (!manifest?.tight || !sides) return manifest?.tight ?? null;
    const { tight, bound } = manifest;
    const m = measured ?? tight;
    /**
     * How much to expand this side: measured boundary exceeds original rectangle by `over` pixels →
     * padding + extra `over` margin (capped); if no exceedance was measured (touching the edge), use
     * the cap
     */
    const reach = over => MEASURE_PAD_PX + (over > 0 ? Math.min(TIGHT_WIDEN_MARGIN_PX, over) : TIGHT_WIDEN_MARGIN_PX);
    const x1 = tight.x + tight.w, y1 = tight.y + tight.h, mx1 = m.x + m.w, my1 = m.y + m.h;
    const grown = rectOf(
      sides.left ? Math.min(tight.x, m.x - reach(tight.x - m.x)) : tight.x,
      sides.top ? Math.min(tight.y, m.y - reach(tight.y - m.y)) : tight.y,
      sides.right ? Math.max(x1, mx1 + reach(mx1 - x1)) : x1,
      sides.bottom ? Math.max(y1, my1 + reach(my1 - y1)) : y1);
    let wider = evenRect(intersectRect(grown, bound), bound);
    if (rectArea(wider) > rectArea(bound) * (1 - TIGHTEN_MIN_SAVING)) wider = bound;
    if (rectArea(wider) <= rectArea(tight)) return tight;
    this.note(`Stream ${state.spec.streamKey.slice(0, 8)}: tight rectangle widened to ${JSON.stringify(wider)} (was ${JSON.stringify(tight)}, the picture hit the ${Object.keys(sides).filter(k => sides[k]).join(', ')} edge during backfill)`);
    manifest.tight = wider;
    state.widened = (state.widened ?? 0) + 1;
    return wider;
  }

  /**
   * Finished encoding a segment: split, verify, write to disk, update manifest, emit `layer`;
   * replaced old files deleted after 5 seconds (G6)
   */
  async storeSegment(state, generation, { segment, stride, rect, encoder, samples, out, box }) {
    await this.ownership?.assert();
    const { spec } = state;
    const { init, segments, dropped } = splitFmp4(out.bytes);
    if (segments.length !== 1) throw new Error(`One encode should produce exactly one segment, got ${segments.length}`);
    const info = segmentInfo(segments[0]);
    if (info.moofs !== 1) throw new Error(`A segment should contain exactly one moof, got ${info.moofs}`);
    // G2: sample count for a segment must be exactly 15 (except the last segment of this stream);
    // retake if short by even one frame
    if (info.sampleCount !== samples) throw new Error(`Segment sample count is ${info.sampleCount}, expected ${samples}`);
    if (info.firstSampleIsSync !== true) throw new Error('First frame of the segment is not an IDR');
    if (!init.length) throw new Error('Encoder output has no ftyp + moov');
    // `generation === null`: segments produced by queue tasks are not classified as stale by
    // version (see `runSegment`)
    if ((generation !== null && state.generation !== generation) || this.streams.get(spec.streamKey) !== state) return;
    const manifest = state.manifest;
    const initId = sha(init, 16);
    const dir = this.store.dir(spec.streamKey);
    await this.ownership?.assert();
    await fs.mkdir(dir, { recursive: true });
    if (!manifest.inits[initId]) {
      const meta = initInfo(init);
      await this.store.writeFile(this.store.initFile(spec.streamKey, initId), init);
      manifest.inits[initId] = { codec: meta.codec, width: meta.width, height: meta.height, timescale: meta.timescale, rect, encoder, bytes: init.length };
      this.note(`Stream ${spec.streamKey.slice(0, 8)}: new variant init-${initId} (${meta.codec} ${meta.width}×${meta.height})`);
    }
    const file = `${segment}-${sha(segments[0], 16)}.m4s`;
    await this.store.writeFile(this.store.segFile(spec.streamKey, file), segments[0]);
    const old = manifest.segments[segment];
    // Position rectangle: sparse segments record what was measured in this pass; full-density
    // segments reuse that of the sparse segment they replaced (if none, record what was measured on
    // the first frame of this pass)
    const kept = stride > 1 ? box : (old?.box !== undefined ? old.box : box);
    manifest.segments[segment] = { file, init: initId, stride, samples, bytes: segments[0].length, encodeMs: out.encodeMs, tailMs: out.tailMs,
      sig: segmentSignature({ streamKey: spec.streamKey, segment, stride, encoder, rect }), dropped, at: Date.now(), ...(kept !== undefined ? { box: kept } : {}) };
    if (stride > 1) this.maybeTighten(state);
    const oldRect = old ? manifest.inits[old.init]?.rect : null;
    this.pruneInits(state);
    await this.store.save(manifest);
    this.stats.segments++;
    this.publish(state);
    // Stream hook in C6.4 section 4: the segment containing this segment enters the push queue.
    // Only takes effect when a push queue is configured in the pipeline; when not configured, this
    // line does nothing
    if (this.pipeline.pushQueue) { try { this.pipeline.enqueueStreamPush?.(spec, segment); } catch {} }
    if (old && old.stride > 1 && stride === 1) {
      // Comparison required for acceptance check "sparse segment ≤ full density 1.0x": bytes and
      // rectangles for sparse and full density respectively on the same segment
      (this.stats.sparseVsDense ||= []).push({ stream: spec.streamKey.slice(0, 8), segment, sparse: old.bytes, dense: segments[0].length,
        sameRect: JSON.stringify(oldRect) === JSON.stringify(rect) });
      while (this.stats.sparseVsDense.length > 100) this.stats.sparseVsDense.shift();
    }
    if (old && old.file !== file) {
      const stalePath = this.store.segFile(spec.streamKey, old.file);
      const timer = setTimeout(() => {
        const still = Object.values(state.manifest?.segments ?? {}).some(s => s.file === old.file);
        if (still) return;
        void fs.rm(stalePath, { force: true }).then(() => { this.stats.replacedDeleted++; });
      }, REPLACED_DELETE_MS);
      timer.unref?.();
    }
  }

  /**
   * Remove variants no longer used by any segment in the manifest (caller then saves the manifest):
   * upper-bound variants after sparse versions are all replaced with full density, and variants from
   * before tight rectangles were enlarged. Its head file is deleted after `REPLACED_DELETE_MS` (in-flight
   * requests holding the old manifest may still exist on the page); if the manifest contains it again
   * by then (produced again with the same rectangle), do not delete it.
   */
  pruneInits(state) {
    const manifest = state.manifest, key = state.spec.streamKey;
    const used = new Set(Object.values(manifest.segments ?? {}).map(s => s.init));
    const gone = Object.keys(manifest.inits ?? {}).filter(id => !used.has(id));
    if (!gone.length) return 0;
    for (const id of gone) delete manifest.inits[id];
    const timer = setTimeout(() => {
      for (const id of gone) if (!state.manifest?.inits?.[id]) void fs.rm(this.store.initFile(key, id), { force: true }).catch(() => {});
    }, REPLACED_DELETE_MS);
    timer.unref?.();
    return gone.length;
  }

  /**
   * C6.2 pull side (contract section 6): ingest a track stream produced by another node (task
   * manifest `StreamResult` + bytes) into the local stream store.
   * `blobs`: hash → Buffer (`Map` or plain object), must include each init and segment in the manifest
   * not yet present locally.
   *
   *   - **Write files** only here: following existing naming `init-<sha16>.mp4`, `<n>-<sha16>.m4s`,
   *     via `atomic`;
   *   - **Merge manifest** into this stream's in-memory `state.manifest` (if there is no state,
   *     create a minimal one based on the manifest's `header`, marked with `adoptedOnly`: not in the
   *     plan of any version, this machine will not catch up production for it or claim it, and `publish`
   *     only binds the key without emitting layers; later when `update` schedules it into a version,
   *     remove this mark), then `StreamStore.save`: do not modify `stream.json` from the outside,
   *     otherwise it will be overwritten by the producer's in-memory manifest;
   *   - Adopted segments are marked with `adopted: true`, carrying the peer's `encoder` and `sig`
   *     (`segmentState` does not classify them as stale based on this);
   *   - Segments already present locally and not `stale` are skipped, not overwritten;
   *   - Publish: follow existing `publish(state)` (only `stageByKey` for `adoptedOnly`).
   *
   * Pulls on the same producer run serially. Returns `{ written, skipped, inits }` (number of segments
   * written, skipped, and new inits written).
   */
  adoptSegments(result, blobs) {
    const run = (this.adoptChain ?? Promise.resolve()).catch(() => {}).then(() => this.adoptSegmentsNow(result, blobs));
    this.adoptChain = run;
    return run;
  }

  /** Implementation of `adoptSegments` (serialized) */
  async adoptSegmentsNow(result, blobs) {
    await this.ownership?.assert();
    if (this.ownership && result?.projectId !== this.ownership.projectId) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
    const plan = streamAdoption(result);
    if (this.closed) throw Object.assign(new Error('Stream producer closed'), { cancelled: true });
    const { key } = plan;
    const blobOf = hash => {
      const buf = typeof blobs?.get === 'function' ? blobs.get(hash) : blobs?.[hash];
      if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) throw new Error(`Missing chunk ${hash}`);
      const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      if (sha(bytes) !== hash) throw new Error(`Content of chunk ${hash} does not match its hash`);
      return bytes;
    };
    let state = await this.adoptionState(key, plan);
    // First pick out segments to write (not present locally, or already classified as stale), verify
    // bytes; if a single chunk is invalid, write nothing at all
    const pending = [];
    for (const [n, seg] of plan.segments) {
      if (!this.adoptable(state, n, seg)) continue;
      const initMeta = plan.inits[seg.init] ?? state.manifest.inits?.[seg.init];
      if (!initMeta) throw new Error(`Init ${seg.init} used by segment ${n} is not in the manifest`);
      pending.push({ n, seg, bytes: blobOf(seg.hash) });
    }
    const initIds = [...new Set(pending.map(p => p.seg.init))].filter(id => !state.manifest.inits?.[id]);
    const initBytes = new Map(initIds.map(id => {
      if (!plan.inits[id]) throw new Error(`Init ${id} is not in the manifest`);
      return [id, blobOf(plan.inits[id].hash)];
    }));
    // Write file (content-addressed, repeatedly writing the same copy is harmless)
    await fs.mkdir(this.store.dir(key), { recursive: true });
    for (const [id, bytes] of initBytes) { await this.ownership?.assert(); await this.store.writeFile(this.store.initFile(key, id), bytes); }
    for (const p of pending) {
      await this.ownership?.assert();
      p.file = `${p.n}-${p.seg.hash.slice(0, 16)}.m4s`;
      await this.store.writeFile(this.store.segFile(key, p.file), p.bytes);
    }
    // During disk writes, `update()` may have switched to a new version: use `this.streams` at this
    // moment as source of truth, merge **synchronously**
    const live = this.streams.get(key);
    if (live) state = live;
    else if (!this.closed) this.streams.set(key, state);
    const manifest = state.manifest;
    manifest.inits ||= {};
    manifest.segments ||= {};
    let written = 0, skipped = plan.segments.length - pending.length, inits = 0;
    const replaced = [];
    for (const p of pending) {
      const old = manifest.segments[p.n];
      // During disk writes, this machine just finished producing this segment: do not overwrite,
      // delete the freshly written file if unreferenced
      if (old && old.file !== p.file && !this.adoptable(state, p.n, p.seg)) {
        skipped++;
        if (!Object.values(manifest.segments).some(s => s.file === p.file)) void fs.rm(this.store.segFile(key, p.file), { force: true }).catch(() => {});
        continue;
      }
      // The switched manifest lacks this init and its file was not written just now (rare: version
      // switched during disk write): do not accept this segment, pull again next time
      if (!manifest.inits[p.seg.init] && !initBytes.has(p.seg.init)) { skipped++; continue; }
      if (!manifest.inits[p.seg.init]) {
        const meta = plan.inits[p.seg.init];
        manifest.inits[p.seg.init] = { codec: meta.codec ?? null, width: meta.width ?? null, height: meta.height ?? null, timescale: meta.timescale ?? null,
          rect: meta.rect ?? null, encoder: meta.encoder ?? null, bytes: meta.bytes ?? initBytes.get(p.seg.init)?.length ?? null, adopted: true };
        inits++;
      }
      // Position rectangle: use peer's if included in peer's manifest; if not included, but local
      // segment being replaced has it, keep the local one
      const adoptedBox = isBox(p.seg.box) || p.seg.box === null ? p.seg.box : old?.box;
      manifest.segments[p.n] = { file: p.file, init: p.seg.init, stride: p.seg.stride, samples: p.seg.samples, bytes: p.bytes.length,
        // Segment's `encoder` takes the one from the init it uses (contract section 11 rule 6)
        sig: p.seg.sig ?? null, encoder: manifest.inits[p.seg.init]?.encoder ?? p.seg.encoder ?? null, adopted: true, at: Date.now(),
        ...(adoptedBox !== undefined ? { box: adoptedBox } : {}) };
      if (old && old.file !== p.file) replaced.push(old.file);
      written++;
    }
    // Peer has already tightened but local has not: use peer's tight rectangle (only switch when
    // local has no full-density segments produced against upper bound, to avoid classifying them as stale)
    if (!manifest.tight && plan.header.tight && !Object.values(manifest.segments).some(s => !s.adopted && s.stride === 1)) manifest.tight = plan.header.tight;
    if (state.adoptedOnly) {
      state.spec.firstSegment = Math.min(state.spec.firstSegment, plan.range.from);
      state.spec.lastSegment = Math.max(state.spec.lastSegment, plan.range.to);
    }
    await this.store.save(manifest);
    // Follow existing `publish(state)`: `adoptedOnly` state is built by `adoptionState` from manifest
    // header with all spec fields required for publish (streamKey / topClipId / kind / clipIds); only
    // binds keys and emits no layers there
    this.publish(state);
    for (const file of replaced) {
      const timer = setTimeout(() => {
        if (Object.values(state.manifest?.segments ?? {}).some(s => s.file === file)) return;
        void fs.rm(this.store.segFile(key, file), { force: true }).then(() => { this.stats.replacedDeleted++; }, () => {});
      }, REPLACED_DELETE_MS);
      timer.unref?.();
    }
    if (written) this.note(`Stream ${key.slice(0, 8)}: pulled in ${written} segments (skipped ${skipped})`);
    return { written, skipped, inits };
  }

  /**
   * Query before pulling: in this section of manifest, which segments are missing locally and which
   * chunks must be downloaded (`applyResult` only downloads missing ones accordingly).
   * Returns `{ segments: [n…], hashes: [hash…] }`. Read-only, does not modify state.
   */
  async adoptionNeeds(result) {
    await this.ownership?.assert();
    if (this.ownership && result?.projectId !== this.ownership.projectId) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
    const plan = streamAdoption(result);
    const state = this.streams.get(plan.key) ?? { spec: { streamKey: plan.key }, manifest: await this.store.load(plan.key) };
    const segments = [], hashes = new Set();
    for (const [n, seg] of plan.segments) {
      if (!this.adoptable(state, n, seg)) continue;
      segments.push(n);
      hashes.add(seg.hash);
      if (!state.manifest?.inits?.[seg.init] && plan.inits[seg.init]) hashes.add(plan.inits[seg.init].hash);
    }
    return { segments, hashes: [...hashes] };
  }

  /**
   * State to merge pull into: use producer's if available; otherwise create an `adoptedOnly` state
   * from manifest on disk (or new manifest)
   */
  async adoptionState(key, plan) {
    const live = this.streams.get(key);
    if (live) return live;
    const { header, range } = plan;
    const manifest = (await this.store.load(key)) ?? { version: STREAM_CODE_VERSION, streamKey: key, kind: header.kind, plane: header.plane,
      clipIds: header.clipIds, fps: header.fps, originFrame: header.originFrame, ...(Number.isInteger(header.lastFrame) ? { lastFrame: header.lastFrame } : {}),
      bound: header.bound, offset: header.offset ?? null, tight: header.tight ?? null, inits: {}, segments: {} };
    const again = this.streams.get(key);
    if (again) return again;
    const clipIds = Array.isArray(manifest.clipIds) ? manifest.clipIds : header.clipIds;
    return {
      adoptedOnly: true,
      spec: { streamKey: key, contentKey: null, kind: manifest.kind ?? header.kind, plane: manifest.plane ?? header.plane, clipIds, topClipId: clipIds[clipIds.length - 1] ?? null,
        fps: manifest.fps ?? header.fps, bound: manifest.bound ?? header.bound, offset: manifest.offset ?? header.offset ?? { x: 0, y: 0 },
        originFrame: manifest.originFrame ?? header.originFrame, firstSegment: range.from, lastSegment: range.to },
      manifest, aliases: new Set(), reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set(),
    };
  }

  /**
   * Adapt `streamPool` based on actual measurements (G0-b conclusion 1): increase to 2 only when
   * image output time per frame with encoder is no more than 2x idle time and more than one stream
   * is active; fall back to 1 when exceeding 2x. If `PROMPTCUT_STREAM_POOL` is set, do not adjust.
   */
  adaptPool() {
    if (this.poolLimit.fixed) return;
    const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
    const { idle, busy } = this.measure;
    if (idle.length < 3 || busy.length < 10) return;
    const ok = avg(busy) <= 2 * avg(idle);
    const want = ok && this.streams.size > 1 ? STREAM_POOL_MAX : STREAM_POOL_DEFAULT;
    if (want !== this.pool) {
      this.note(`streamPool ${this.pool} → ${want} (with encoder ${avg(busy).toFixed(1)} ms/frame, idle ${avg(idle).toFixed(1)} ms/frame)`);
      this.pool = want;
      this.kick();
    }
  }

  /** Wait for all segments currently encoding to finalize (for probes / tests) */
  async drain() {
    for (;;) {
      await Promise.allSettled([...this.workers, ...this.encoding]);
      if (!this.workers.size && !this.encoding.size) return;
    }
  }

  /** F5: scan disk and attach to "key → range", waiting for card plan to be in place before claiming */
  async rescan() {
    if (!this.routeAttached) return 0;
    const found = await this.store.scan();
    for (const item of found) {
      try { this.pipeline.ready.stageByKey({ kind: 'stream', key: item.key, ranges: item.ranges }); } catch {}
    }
    return found.length;
  }

  /**
   * Representation of streams already in the store inside the claim table (used by `claimSessions`):
   * `{ clipId, kind: 'stream', key }`. When `entryKey` is passed, only provide streams belonging to
   * that version: the producer may hold a version from another session.
   */
  claimLayers(entryKey) {
    // C6.2: streams that are merely pulled (`adoptedOnly`) do not belong to any version and are not claimed
    return [...this.streams.values()].filter(state => !state.adoptedOnly && (entryKey === undefined || (state.entryKey ?? this.entryKey) === entryKey))
      .flatMap(state => [state.spec.topClipId, ...(state.aliases ?? [])]
      .map(clipId => ({ clipId, kind: 'stream', key: state.spec.streamKey, ...(isStreamOrigin(state.spec.originFrame) ? { originFrame: state.spec.originFrame } : {}),
        ...belowLayerMark(state.spec, clipId) })));
  }

  async close() {
    this.closed = true;
    for (const resolve of this.encoderWaiters.splice(0)) resolve();
    await Promise.allSettled([...this.workers, ...this.encoding]);
  }
}

/** Whether a stream store exists under a given directory (used for F5 disk scan checks) */
export function hasStreamLibrary(root) {
  try { return fsSync.statSync(path.join(root, 'streams')).isDirectory(); } catch { return false; }
}
