/**
 * Sparse version and full density version of track streams (semantics
 * `docs/semantics/mechanism/rendering.md` "Heavy pipeline: prerender"): end-to-end probe with real
 * Chrome and real encoder, **comparing pixels**.
 *
 *   node scripts/probes/sparse-stream-probe.mjs (--origin http://127.0.0.1:27860 | --port 27860) [--out <dir>] [--keep] [--json <file>]
 *
 * If `--origin` is given, use that dev server; if `--port` is given, start one in the checkout root
 * (taking +1 and +2 as stage ports), tearing it down by PID when done. Start `FramePipeline`
 * directly in this process (same code as prerender process), placing store root in a temporary
 * directory. Start one pipeline for each of the three projects:
 *
 *   A  Two frame-push cards `r6-stateful` (a block of text, moving 10 pixels horizontally per
 *      frame): clip-b frames 40-219, clip-a frames 100-149 (neither starting on a multiple of 15)
 *   B  One card directly evaluated by time `probe-slow` (remotion-style; an orange block, moving 10
 *      pixels horizontally per second): clip-c frames 20-110
 *   C  Same as B, but without automatic production running; produced via the queued stream task path
 *      (`StreamProducer.produceRange`, which is what the executor calls upon claiming a stream task)
 *
 * The probe adds a gate to the pipeline: **blocks before filling full density once sparse versions
 * are all ready**, releasing after sparse versions are verified (the gate only takes effect after
 * the producer itself determines that "all sparse versions are ready", without changing its job
 * selection order). Verification items:
 *
 *   1. Order (on disk): each segment writes a sparse version to disk first; full-density segments
 *      start work only after all sparse versions have landed on disk.
 *   2. Sparse version (A, B): each segment's `stride` is the frame count of one segment, sample
 *      count = frame count covered by this segment; when decoding the segment, **every sample is the
 *      exact same frame**, and this frame is most similar to the first frame of this segment (A:
 *      compared with two frames before and after; B: visual moves only 1/3 pixel per frame,
 *      compared with the first frame of one segment before and after). B is remotion-style: jumps
 *      directly between segments without reloading the project (records reload count).
 *   3. Position rectangle: each segment's `box` (plane coordinates) in the manifest matches the
 *      "bounding box of opaque pixels in the reference frame of this segment's first frame"
 *      (difference on each side ≤ 1 pixel); the tight rectangle covers the `box` of all segments.
 *   4. Stage pasting sparse version (A): time is set to a frame in the middle of a segment; the
 *      strip for this card on stage draws the visual of **the first frame of the segment** (not this
 *      frame).
 *   5. Fill full density after release: each segment switches to `stride` 1 while keeping `box`
 *      as-is; one sample is taken from the head, middle, and tail of each segment, each most similar
 *      to its own frame; **no content clipping**: the opaque area of the reference frame for every
 *      frame in this segment falls inside this segment's rectangle (text shifts horizontally each
 *      frame; the sparse pass cannot measure positions between frames, so hitting the tight
 *      rectangle edge during density fill requires expanding and retrying; records expansion
 *      count).
 *   6. Stage switching to full density (A): when the stage is paused in the middle of a segment
 *      currently pasting the sparse version, full density completes. Without moving the playhead,
 *      wait for the stream player to re-query the manifest (it periodically re-queries per
 *      `MANIFEST_REFRESH_MS` when paused on a sparse segment): this frame switches from "the visual
 *      of the segment's first frame" to this frame's own visual. Then step forward frame-by-frame
 *      (each step is one tick of playback, crossing about a dozen segment boundaries): every tick
 *      draws this frame itself, with not a single tick drawn incorrectly or falling back to the
 *      sparse version. (The producer only deletes replaced sparse segment files after
 *      `REPLACED_DELETE_MS`; the probe keeps a copy of them and serves them even after deletion,
 *      preventing the player from requesting a freshly deleted file before re-querying the manifest.
 *      The served count is recorded in the results.)
 *   7. Queue path (C): sparse stream task produces sparse segments (with `box`); re-running it
 *      captures zero frames; full density task fills full density on the same stream; subsequent
 *      sparse stream tasks do not downgrade.
 *
 * Outputs JSON conclusion, writes progress to stderr; exits with non-zero if any item fails.
 * Elapsed time is only recorded.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { handleStreamRequest, SPARSE_STRIDE } from '../../server/frame-stream.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { decodePngRgba, rgbaAlphaBox } from '../../server/bakery/capture-canvas.mjs';
import { startDevServer, emptyUrlOf, decodeSegment, newError, tallyDecodedDirect, sleep, round2 } from './below-stream-common.mjs';
import { streamPlanesFor } from '../../src/render/streamPlayer.ts';
import { STREAM_SEGMENT_FRAMES, streamSegmentFirstFrame, streamSegmentFrameCount, streamSegmentOf } from '../../src/render/streamSegments.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-sparse-stream-probe-${Date.now().toString(36)}`));
process.env.PROMPTCUT_STREAM_POOL = '1';
if (!ORIGIN && !PORT) { console.error('Pass --origin <dev server> or --port <start your own>'); process.exit(2); }

const FPS = 30, WIDTH = 1280, HEIGHT = 720, DURATION = 9;
/**
 * In and out points are written in seconds, falling between two frames (frame numbers divided by 30
 * are mostly not finite decimals, converting directly to seconds would be off by one frame)
 */
const ROWS = { 'clip-a': [40, 340], 'clip-b': [380, 680] };
const card = (id, cardId, start, end, frame, params = {}) => ({ id, kind: 'card', cardId, start, end, params, frame });
const projectOf = (id, tracks) => ({ id, name: id, width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {}, tracks });
const PROJECT = projectOf('sparse-stream-probe', [
  { id: 'tr-a', name: 'a', hidden: false, clips: [card('clip-a', 'r6-stateful', 3.32, 4.99, { x: 0, y: 40, w: WIDTH, h: 300 })] },
  { id: 'tr-b', name: 'b', hidden: false, clips: [card('clip-b', 'r6-stateful', 1.32, 7.32, { x: 0, y: 380, w: WIDTH, h: 300 })] },
]);
const DIRECT = (id) => projectOf(id, [
  { id: 'tr-c', name: 'c', hidden: false, clips: [card('clip-c', 'probe-slow', 0.65, 3.69, { x: 0, y: 0, w: WIDTH, h: HEIGHT }, { burnMs: 0, label: 'direct' })] },
]);
const WANT = { 'clip-a': [100, 149], 'clip-b': [40, 219], 'clip-c': [20, 110] };

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } return cond; };
async function until(label, fn, timeoutMs, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); return null; }
    await sleep(everyMs);
  }
}

/**
 * A sequence of PNGs (frame number → bytes), decoded on demand to straight RGBA, keeping only
 * the most recently used dozens of images
 */
function frameStore() {
  const png = new Map(), cache = new Map();
  return {
    put: (frame, buf) => png.set(frame, Buffer.from(buf)),
    png: (frame) => png.get(frame),
    rgba(frame) {
      if (cache.has(frame)) return cache.get(frame);
      const data = decodePngRgba(png.get(frame))?.data;
      if (!data) throw new Error(`Could not resolve the reference for frame ${frame}`);
      cache.set(frame, data);
      if (cache.size > 48) cache.delete(cache.keys().next().value);
      return data;
    },
  };
}
/**
 * Advance sequentially on export page, capturing a full frame per frame (transparent background):
 * reference, independent of segments or whether sparse
 */
async function exportFrames(bakery, project, emptyUrl, last, dir) {
  const store = frameStore();
  await bakery.reset(project, emptyUrl);
  bakery.streamLease = null;
  await bakeFrames(bakery, { out: dir, fps: FPS, frames: `0-${last}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
    onFrame: async (i, buf) => { store.put(i, buf); } });
  return store;
}
/**
 * Difference between a decoded frame (encoded image) and a reference image (full straight RGBA)
 * within `rect`: average difference in premultiplied color and opacity (out of 255)
 */
function decodedDiff(picture, rect, truth) {
  const e = newError();
  tallyDecodedDirect(e, picture, rect, truth, WIDTH);
  return e.count ? e.sum / e.count : 0;
}
/** Byte-by-byte average difference between two decoded samples */
function sampleDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}
function rgbOver(buf, bg = [0x20, 0x20, 0x20]) {
  const png = PNG.sync.read(buf);
  const out = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
    const a = png.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) out[j + k] = Math.round(png.data[i + k] * a + bg[k] * (1 - a));
  }
  return { width: png.width, height: png.height, rgb: out };
}
/** Average difference between two RGB images in rows y0-y1 */
function rowsDiff(a, b, [y0, y1]) {
  let sum = 0;
  const from = y0 * a.width * 3, to = y1 * a.width * 3;
  for (let i = from; i < to; i++) sum += Math.abs(a.rgb[i] - b.rgb[i]);
  return sum / (to - from);
}
const toPng = (img) => { const png = new PNG({ width: img.width, height: img.height }); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) { png.data[i] = img.rgb[j]; png.data[i + 1] = img.rgb[j + 1]; png.data[i + 2] = img.rgb[j + 2]; png.data[i + 3] = 255; } return PNG.sync.write(png); };
const inside = (inner, outer, slack = 0) => inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;
const near = (a, b, slack = 1) => !!a && !!b && Math.abs(a.x - b.x) <= slack && Math.abs(a.y - b.y) <= slack && Math.abs(a.x + a.w - b.x - b.w) <= slack && Math.abs(a.y + a.h - b.y - b.h) <= slack;
/**
 * Bounding box of opaque pixels in the reference image (full frame), clipped to `sceneRect`,
 * converted to plane coordinates; returns null if none
 */
function truthBox(data, sceneRect, offset) {
  const b = rgbaAlphaBox(data, WIDTH, HEIGHT);
  if (!b) return null;
  const x0 = Math.max(b.x, sceneRect.x), y0 = Math.max(b.y, sceneRect.y), x1 = Math.min(b.x + b.w, sceneRect.x + sceneRect.w), y1 = Math.min(b.y + b.h, sceneRect.y + sceneRect.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0 - offset.x, y: y0 - offset.y, w: x1 - x0, h: y1 - y0 };
}

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>sparse stream probe host</title></head>
<body style="margin:0;background:#202020">
<iframe id="a" src="${oa}/?stage=1&id=A&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block"></iframe>
<iframe id="b" src="${ob}/?stage=1&id=B&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block;opacity:0;pointer-events:none;position:absolute;left:0;top:0"></iframe>
<script type="module">
function createStageRpc(target, targetOrigin) {
  let nextId = 1; const pending = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); }
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, targetOrigin); });
  const c = {};
  for (const m of ['setProject', 'setTime', 'setRole', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setPlaying']) c[m] = call(m);
  return c;
}
const waitReady = (frame, targetOrigin) => new Promise((res) => {
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    res(createStageRpc(frame.contentWindow, targetOrigin));
  });
});
window.__ready = Promise.all([waitReady(document.getElementById('a'), '${oa}'), waitReady(document.getElementById('b'), '${ob}')])
  .then(([a, b]) => { window.__rpc = a; window.__rpcB = b; return true; });
</script></body></html>`;

/**
 * Start a pipeline: pin as heavy card; add a gate to "block once all sparse versions are ready";
 * record start and disk write order for each segment
 */
function openPipeline(root, origin, { frozen = false } = {}) {
  const pipeline = new FramePipeline({ root, origin: () => origin, interactive: true, playhead: () => null });
  pipeline.streamPicked = () => true;
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  const gate = { hold: true, frozen };
  const busy = pipeline.streamBusy.bind(pipeline);
  pipeline.streamBusy = (now) => busy(now) || gate.frozen || (gate.hold && producer.streams.size > 0 && !producer.encoding.size && !producer.needsSparseAnywhere());
  const events = [];
  const run = producer.runSegment.bind(producer);
  producer.runSegment = (bakery, task) => { events.push({ ev: 'start', key: task.state.spec.streamKey, n: task.segment, stride: task.stride, at: Date.now(), seq: events.length }); return run(bakery, task); };
  const store = producer.storeSegment.bind(producer);
  producer.storeSegment = async (state, generation, o) => { const r = await store(state, generation, o); events.push({ ev: 'stored', key: state.spec.streamKey, n: o.segment, stride: o.stride, at: Date.now(), seq: events.length }); return r; };
  const layers = new Map();
  pipeline.readyIndex.subscribe((message) => { if (message.type === 'layer' && message.kind === 'stream') layers.set(message.clipId, message); });
  return { pipeline, producer, gate, events, layers };
}
const allAt = (producer, want) => {
  const s = producer.status();
  if (!s.streams.length) return null;
  for (const row of s.streams) for (let n = row.firstSegment; n <= row.lastSegment; n++) if (!want(row.segments[n])) return null;
  return !producer.encoding.size ? s : null;
};
const segmentsOf = (state) => { const out = []; for (let n = state.spec.firstSegment; n <= state.spec.lastSegment; n++) out.push(n); return out; };

const out = { out: OUT, project: { width: WIDTH, height: HEIGHT, fps: FPS, clips: WANT }, sparseStride: SPARSE_STRIDE };
await fs.mkdir(OUT, { recursive: true });
let dev = null, bakery = null, browser = null, hostServer = null;
const pipelines = [];
const started = Date.now();
try {
  check(SPARSE_STRIDE === STREAM_SEGMENT_FRAMES, 'The sparse version has only one tier: one image per segment');
  const ffmpeg = await findFfmpeg();
  let origin = ORIGIN;
  if (!origin) { dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'sparseprobe' }); origin = dev.origin; say('spawn', { pid: dev.pid, port: PORT }); }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  bakery = await openBakery({ url: emptyUrl });

  /** Decode a segment: returns visual and rectangle (scene coordinates) for each sample */
  const decodeOf = async (producer, state, n, dir, name) => {
    const { spec, manifest } = state;
    const seg = manifest.segments[n];
    const meta = manifest.inits[seg.init];
    const rect = { x: meta.rect.x + spec.offset.x, y: meta.rect.y + spec.offset.y, w: meta.rect.w, h: meta.rect.h };
    const init = await fs.readFile(producer.store.initFile(spec.streamKey, seg.init));
    const bytes = await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file));
    const decoded = await decodeSegment(ffmpeg, init, bytes, dir, name);
    const frameBytes = rect.w * 2 * (rect.h + 8) * 3;
    const samples = [];
    for (let k = 0; (k + 1) * frameBytes <= decoded.length; k++) samples.push(decoded.subarray(k * frameBytes, (k + 1) * frameBytes));
    return { seg, rect, samples, exact: decoded.length === seg.samples * frameBytes };
  };

  /**
   * Verify sparse version segment-by-segment (items 2 and 3). `direct`: visual moves only slightly
   * each frame, candidates switch to the first frame of one segment before and after
   */
  const checkSparse = async (tag, producer, state, truth, dir, { direct }) => {
    const { spec, manifest } = state;
    const [originFrame, lastFrame] = [spec.originFrame, spec.lastFrame];
    const boundScene = { x: manifest.bound.x + spec.offset.x, y: manifest.bound.y + spec.offset.y, w: manifest.bound.w, h: manifest.bound.h };
    const record = { tag, segments: [], wrong: [], notSame: [], boxOff: [] };
    let union = null;
    for (const n of segmentsOf(state)) {
      const first = streamSegmentFirstFrame(n, originFrame);
      const count = streamSegmentFrameCount(n, originFrame, lastFrame);
      const d = await decodeOf(producer, state, n, dir, `sparse-${n}`);
      if (!check(d.seg.stride === SPARSE_STRIDE && d.seg.samples === count && d.exact, `${tag}#${n}: sparse version, sample count = the number of frames this segment covers`, { stride: d.seg.stride, samples: d.seg.samples, count, decoded: d.samples.length })) continue;
      // Every sample is the exact same frame
      const worst = Math.max(0, ...d.samples.slice(1).map((s) => sampleDiff(s, d.samples[0])));
      if (worst > 1.5) record.notSame.push({ n, worst: round2(worst) });
      // This image is most similar to the first frame of the segment
      const candidates = direct
        ? [n - 1, n, n + 1].filter((m) => m >= 0 && m <= spec.lastSegment).map((m) => streamSegmentFirstFrame(m, originFrame))
        : [first - 2, first - 1, first, first + 1, first + 2].filter((c) => c >= originFrame && c <= lastFrame);
      for (const k of [0, d.samples.length - 1]) {
        const scores = candidates.map((c) => [c, decodedDiff(d.samples[k], d.rect, truth.rgba(c))]).sort((x, y) => x[1] - y[1]);
        if (scores[0][0] !== first) record.wrong.push({ n, sample: k, first, best: scores[0][0], scores: scores.map(([c, v]) => [c, round2(v)]) });
      }
      // Position rectangle
      const want = truthBox(truth.rgba(first), boundScene, spec.offset);
      const got = d.seg.box;
      const ok = want === null ? got === null : near(got, want, 1);
      if (!ok) record.boxOff.push({ n, first, got, want });
      if (got) union = union ? { x: Math.min(union.x, got.x), y: Math.min(union.y, got.y), w: Math.max(union.x + union.w, got.x + got.w) - Math.min(union.x, got.x), h: Math.max(union.y + union.h, got.y + got.h) - Math.min(union.y, got.y) } : { ...got };
      record.segments.push({ n, first, samples: d.seg.samples, box: got, sameWorst: round2(worst) });
    }
    record.bound = manifest.bound; record.tight = manifest.tight ?? null; record.union = union;
    check(record.segments.length === spec.lastSegment + 1, `${tag}: every segment has a sparse version`, record.segments.length);
    check(record.notSame.length === 0, `${tag}: all samples within each segment of the sparse version are the same image`, record.notSame);
    check(record.wrong.length === 0, `${tag}: the single sparse image most resembles the first frame of the segment`, record.wrong.slice(0, 4));
    check(record.boxOff.length === 0, `${tag}: the position rectangle matches the opaque area of the segment's first frame (each edge differs by ≤ 1 pixel)`, record.boxOff.slice(0, 4));
    check(!!manifest.tight && (!union || inside(union, manifest.tight)), `${tag}: once the sparse version is complete, a tight rectangle is fixed that covers the position rectangles of all segments`, { tight: manifest.tight, union });
    const rows = producer.status().streams.find((r) => r.streamKey === spec.streamKey || r.key === spec.streamKey);
    if (rows) check(Object.values(rows.segments).every((s) => 'box' in s), `${tag}: every segment in the status carries a position rectangle`);
    return record;
  };

  /** Full density segment-by-segment verification (item 5) */
  const checkDense = async (tag, producer, state, truth, dir, sparseRecord, { direct }) => {
    const { spec, manifest } = state;
    const [originFrame, lastFrame] = [spec.originFrame, spec.lastFrame];
    const record = { tag, wrong: [], clipped: [], boxChanged: [], rects: new Set() };
    for (const n of segmentsOf(state)) {
      const first = streamSegmentFirstFrame(n, originFrame);
      const count = streamSegmentFrameCount(n, originFrame, lastFrame);
      const d = await decodeOf(producer, state, n, dir, `dense-${n}`);
      if (!check(d.seg.stride === 1 && d.seg.samples === count && d.exact, `${tag}#${n}: full density`, { stride: d.seg.stride, samples: d.seg.samples, count })) continue;
      record.rects.add(JSON.stringify(d.rect));
      const before = sparseRecord.segments.find((s) => s.n === n)?.box;
      if (JSON.stringify(d.seg.box ?? null) !== JSON.stringify(before ?? null)) record.boxChanged.push({ n, before, after: d.seg.box });
      if (!direct) {
        for (const k of [...new Set([0, Math.floor(count / 2), count - 1])]) {
          const f = first + k;
          const scores = [f - 2, f - 1, f, f + 1, f + 2].filter((c) => c >= originFrame && c <= lastFrame).map((c) => [c, decodedDiff(d.samples[k], d.rect, truth.rgba(c))]).sort((x, y) => x[1] - y[1]);
          if (scores[0][0] !== f) record.wrong.push({ n, sample: k, frame: f, best: scores[0][0] });
        }
      }
      // No content clipping: opaque area of every frame in this segment lies within this segment's
      // rectangle
      const boundScene = { x: manifest.bound.x + spec.offset.x, y: manifest.bound.y + spec.offset.y, w: manifest.bound.w, h: manifest.bound.h };
      for (let k = 0; k < count; k++) {
        const box = truthBox(truth.rgba(first + k), boundScene, spec.offset);
        const rectPlane = { x: d.rect.x - spec.offset.x, y: d.rect.y - spec.offset.y, w: d.rect.w, h: d.rect.h };
        if (box && !inside(box, rectPlane)) record.clipped.push({ n, frame: first + k, box, rect: rectPlane });
      }
    }
    record.rects = [...record.rects].map((r) => JSON.parse(r));
    record.widened = state.widened ?? 0;
    record.tight = manifest.tight ?? null;
    check(record.wrong.length === 0, `${tag}: each full-density sample most resembles its own frame`, record.wrong.slice(0, 4));
    check(record.boxChanged.length === 0, `${tag}: after filling up to full density, the position rectangles stay as they were`, record.boxChanged.slice(0, 4));
    check(record.clipped.length === 0, `${tag}: full-density segments do not crop any content (every frame's opaque area lies within this segment's rectangle)`, record.clipped.slice(0, 4));
    return record;
  };

  /** Order (item 1): full density work starts only after all sparse versions land on disk */
  const checkOrder = (tag, events, total) => {
    const sparseStored = events.filter((e) => e.ev === 'stored' && e.stride > 1);
    const denseStart = events.filter((e) => e.ev === 'start' && e.stride === 1);
    const lastSparse = Math.max(-1, ...sparseStored.map((e) => e.seq));
    const firstDense = Math.min(Infinity, ...denseStart.map((e) => e.seq));
    const summary = { sparseStored: sparseStored.length, denseStarted: denseStart.length, lastSparseSeq: lastSparse, firstDenseSeq: Number.isFinite(firstDense) ? firstDense : null,
      strides: [...new Set(events.filter((e) => e.ev === 'start').map((e) => e.stride))] };
    check(new Set(sparseStored.map((e) => `${e.key}#${e.n}`)).size === total, `${tag}: every segment first had a sparse version stored`, summary);
    check(denseStart.length >= total && firstDense > lastSparse, `${tag}: full-density work starts only after all the sparse ones are written to disk`, summary);
    check(summary.strides.every((s) => s === 1 || s === SPARSE_STRIDE), `${tag}: only two densities (one per segment, one per frame)`, summary.strides);
    return summary;
  };

  // ================================================================ A: Two frame-push cards
  const A = openPipeline(path.join(OUT, 'library-a'), origin);
  pipelines.push(A.pipeline);
  let t0 = Date.now();
  await A.pipeline.preload(PROJECT);
  if (!(await until('A: sparse version complete', () => allAt(A.producer, (s) => !!s), 600_000))) throw new Error(`A's sparse version was not fully produced: ${JSON.stringify(A.producer.status().log.slice(-8))}`);
  await sleep(600);
  out.a = { sparseMs: Date.now() - t0 };
  const statesA = [...A.producer.streams.values()];
  check(statesA.length === 2 && statesA.every((s) => s.spec.kind === 'card'), 'A: two single-card streams', statesA.map((s) => s.spec.kind));
  check(statesA.every((s) => segmentsOf(s).every((n) => s.manifest.segments[n]?.stride === SPARSE_STRIDE)), 'A: while the gate is held, every segment is a sparse version (none at full density)');
  const truthA = new Map(), sparseA = new Map();
  for (const state of statesA) {
    const clip = state.spec.topClipId, [o, l] = WANT[clip];
    check(state.spec.originFrame === o && state.spec.lastFrame === l, `A ${clip}: frames ${o} to ${l}`, { originFrame: state.spec.originFrame, lastFrame: state.spec.lastFrame });
    const dir = path.join(OUT, `ref-${clip}`);
    await fs.mkdir(dir, { recursive: true });
    truthA.set(clip, await exportFrames(bakery, state.isolated, emptyUrl, l, dir));
    sparseA.set(clip, await checkSparse(`A ${clip}`, A.producer, state, truthA.get(clip), dir, { direct: false }));
  }
  out.a.sparse = [...sparseA.values()].map((r) => ({ tag: r.tag, bound: r.bound, tight: r.tight, union: r.union, segments: r.segments }));
  say('a-sparse', { ms: out.a.sparseMs, streams: out.a.sparse.map((r) => ({ tag: r.tag, tight: r.tight, boxes: r.segments.map((s) => s.box && [s.box.x, s.box.y, s.box.w, s.box.h]) })) });

  // ---------- Stage pasting sparse version (item 4)
  const refDir = path.join(OUT, 'ref-project');
  await fs.mkdir(refDir, { recursive: true });
  const exported = await exportFrames(bakery, PROJECT, emptyUrl, 221, refDir);
  const exportRgb = new Map();
  const exportOf = (f) => { if (!exportRgb.has(f)) { exportRgb.set(f, rgbOver(exported.png(f))); if (exportRgb.size > 24) exportRgb.delete(exportRgb.keys().next().value); } return exportRgb.get(f); };
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  if (!ports.ok || !Array.isArray(ports.ports) || ports.ports.length < 2) throw new Error(`Stage ports did not come up: ${JSON.stringify(ports)}`);
  const u = new URL(origin);
  const [originA, originB] = ports.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
  const HOST_PATH = '/__sparse-stream-probe-host';
  /**
   * Sparse segments retained before release (`<stream key>/<file name>` → bytes): still served after
   * files are replaced and deleted (reason in file header item 6)
   */
  const sparseKept = new Map();
  let servedKept = 0;
  hostServer = await serve(0, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === HOST_PATH) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(hostHtml(originA, originB)); return; }
    const parts = url.pathname.split('/');
    const keptId = `${parts.find((p) => /^[0-9a-f]{64}$/.test(p)) ?? ''}/${decodeURIComponent(parts.at(-1) ?? '')}`;
    if (sparseKept.has(keptId) && !existsSync(A.producer.store.segFile(...keptId.split('/')))) {
      servedKept++;
      const buf = sparseKept.get(keptId);
      res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Length', buf.length); res.end(req.method === 'HEAD' ? undefined : buf);
      return;
    }
    if (url.pathname.startsWith('/api/frames/') && handleStreamRequest(A.producer.store, req, res, url.pathname.slice('/api/frames'.length))) return;
    res.statusCode = 404; res.end();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  const frameA = () => page.frames().find((f) => f.url().startsWith(originA));
  const frameB = () => page.frames().find((f) => f.url().startsWith(originB));
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const rpcB = (method, ...a) => page.evaluate((m, a2) => window.__rpcB[m](...a2), method, a);
  const heavy = ['clip-a', 'clip-b'];
  const planesAt = (f) => streamPlanesFor([...A.layers.values()], new Set(heavy), f);
  /**
   * (Re)open parent page and two stages: stream player is rebuilt from scratch (its manifest query
   * throttling runs on stage virtual clock; scrubbing backward requires a long wait before
   * re-querying, changing page is cleanest)
   */
  const openStage = async () => {
    await page.goto(base + HOST_PATH);
    await page.waitForFunction(() => window.__ready, { timeout: 120000 });
    await page.evaluate(() => window.__ready);
    for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base);
    await rpc('setProject', PROJECT, { reset: true });
    await rpcB('setProject', PROJECT, { reset: true });
    await rpc('setRole', 'front');
    await rpcB('setRole', 'back', { job: 'probe' });
    await rpc('setTime', 40 / FPS);
    await rpc('setPlaying', true);
    await rpc('setSuppressed', heavy);
  };
  await openStage();
  const iframeBox = await (await page.$('#a')).boundingBox();
  const shotStage = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } });
    return rgbOver(await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } }));
  };
  /**
   * Set time to frame f (stream plane is provided for this frame), wait for each present stream to
   * draw this frame; once drawn, resend stream plane as parent page does every tick (prompting stage
   * to recompute placeholders)
   */
  const seekTo = async (f) => {
    const planes = planesAt(f);
    await rpc('setStreamPlanes', planes);
    const got = await frameA().evaluate(async (frame, fps, want) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const start = now();
      await window.__pcStage.setTime(frame / fps + 1e-4);
      for (;;) {
        const tracks = window.__pcStageDiag().streams.tracks;
        if (tracks.length === want && tracks.every((t) => t.lastDrawn === frame)) return { ms: +(now() - start).toFixed(1) };
        if (now() - start > 8000) return { ms: null, drawn: tracks.map((t) => t.lastDrawn), errors: tracks.map((t) => t.lastError), tracks: tracks.length };
        await wait(2);
      }
    }, f, FPS, onStage(f).length);
    await rpc('setStreamPlanes', planes);
    await sleep(60);
    return { planes, got };
  };
  /** Which frame on export page the strip (several rows) of this card on stage most resembles */
  const bestOf = (stage, clip, candidates) => {
    const scores = [...new Set(candidates)].map((c) => [c, rowsDiff(stage, exportOf(c), ROWS[clip])]).sort((x, y) => x[1] - y[1]);
    return { best: scores[0][0], scores: scores.map(([c, v]) => [c, round2(v)]) };
  };
  const segFirst = (clip, f) => streamSegmentFirstFrame(streamSegmentOf(f, WANT[clip][0]), WANT[clip][0]);
  const onStage = (f) => Object.keys(ROWS).filter((clip) => f >= WANT[clip][0] && f <= WANT[clip][1]);
  {
    const rows = [];
    for (const f of [47, 62, 96, 107, 112, 127]) {
      const { got } = await seekTo(f);
      if (!check(got.ms !== null, `Stage with sparse version: stream plane rendered frame ${f}`, got)) continue;
      const stage = await shotStage();
      for (const clip of onStage(f)) {
        const first = segFirst(clip, f);
        const r = bestOf(stage, clip, [first, f, f - 1]);
        rows.push({ frame: f, clip, segmentFirst: first, ...r });
        if (f === 47) await fs.writeFile(path.join(OUT, 'stage-sparse-47.png'), toPng(stage));
      }
    }
    out.a.stageSparse = rows;
    say('a-stage-sparse', { rows: rows.map((r) => [r.frame, r.clip, r.segmentFirst, r.best]) });
    check(rows.length >= 8, 'Stage with sparse version: several frames were all compared', rows.length);
    check(rows.every((r) => r.best === r.segmentFirst), 'Stage with sparse version: frames in the middle of a segment show the image of the segment\'s first frame', rows.filter((r) => r.best !== r.segmentFirst));
    await fs.writeFile(path.join(OUT, 'export-40.png'), toPng(exportOf(40)));
    await fs.writeFile(path.join(OUT, 'export-47.png'), toPng(exportOf(47)));
  }
  // Change page (stream player rebuilt from scratch), pause at frame 47 (middle of segment 0 for
  // clip-b, pasting sparse version), then release to fill full density
  await openStage();
  await seekTo(41);
  {
    const { got } = await seekTo(47);
    const r = got.ms === null ? null : bestOf(await shotStage(), 'clip-b', [40, 46, 47]);
    check(r?.best === 40, 'Stage: before release, parked at frame 47, showing the sparse version (the image of frame 40)', r ?? got);
  }

  for (const state of statesA) for (const n of segmentsOf(state)) {
    const file = state.manifest.segments[n].file;
    sparseKept.set(`${state.spec.streamKey}/${file}`, await fs.readFile(A.producer.store.segFile(state.spec.streamKey, file)));
  }

  // ---------- Release: fill full density (item 5)
  t0 = Date.now();
  A.gate.hold = false;
  A.producer.kick();
  if (!(await until('A: full density complete', () => (allAt(A.producer, (s) => s?.stride === 1) && !A.producer.workers.size ? true : null), 900_000))) throw new Error(`A's full density was not fully produced: ${JSON.stringify(A.producer.status().log.slice(-8))}`);
  out.a.denseMs = Date.now() - t0;
  out.a.order = checkOrder('A', A.events, statesA.reduce((sum, s) => sum + s.spec.lastSegment + 1, 0));
  out.a.dense = [];
  for (const state of statesA) {
    const clip = state.spec.topClipId;
    const dir = path.join(OUT, `ref-${clip}`);
    const r = await checkDense(`A ${clip}`, A.producer, state, truthA.get(clip), dir, sparseA.get(clip), { direct: false });
    out.a.dense.push({ tag: r.tag, widened: r.widened, tight: r.tight, rects: r.rects, clipped: r.clipped.length, wrong: r.wrong.length });
  }
  out.a.widenLog = A.producer.status().log.filter((line) => /enlarge/.test(String(line?.message ?? line))).length;
  say('a-dense', { ms: out.a.denseMs, order: out.a.order, dense: out.a.dense });

  // ---------- Stage switching to full density (item 6): leave playhead untouched first, waiting for
  // paused frame to update on its own; then step forward frame-by-frame from frame 48 (one tick per step)
  {
    // Stay paused at frame 47: stream player paused on a sparse segment periodically re-queries manifest,
    // switching this frame to its own visual once full density is returned
    const tWait = Date.now();
    let upgraded = null, lastSeen = null;
    while (Date.now() - tWait < 20_000) {
      await rpc('setStreamPlanes', planesAt(47));
      lastSeen = bestOf(await shotStage(), 'clip-b', [40, 46, 47, 48]);
      if (lastSeen.best === 47) { upgraded = Date.now() - tWait; break; }
      await sleep(400);
    }
    check(upgraded !== null, 'Stage switch to full density: the frame it is parked on (frame 47) changed from the sparse version to its own image by itself, without moving the playhead', lastSeen);
    if (upgraded !== null) { await fs.writeFile(path.join(OUT, 'stage-upgraded-47.png'), toPng(await shotStage())); }

    const rows = [];
    const LAST_STEP = 212;
    for (let f = 48; f <= LAST_STEP; f++) {
      const { got } = await seekTo(f);
      if (got.ms === null) { check(false, `Stage switch to full density: stream plane rendered frame ${f}`, got); break; }
      const stage = await shotStage();
      const first = segFirst('clip-b', f);
      const r = bestOf(stage, 'clip-b', [first, f - 1, f, f + 1]);
      // On the first frame of a segment, sparse version and full density have the identical visual and
      // cannot be distinguished (record either)
      rows.push({ frame: f, segmentFirst: first, best: r.best, shows: f === first ? 'either' : r.best === f ? 'dense' : r.best === first ? 'sparse' : `frame-${r.best}`, scores: r.scores });
      if (f === 116) { await fs.writeFile(path.join(OUT, 'stage-dense-116.png'), toPng(stage)); await fs.writeFile(path.join(OUT, 'export-116.png'), toPng(exportOf(116))); }
      if (onStage(f).includes('clip-a')) {
        const a = bestOf(stage, 'clip-a', [segFirst('clip-a', f), f - 1, f, f + 1]);
        rows[rows.length - 1].clipA = a.best;
      }
    }
    const wrong = rows.filter((r) => r.shows !== 'either' && r.shows !== 'dense');
    out.a.stageSwap = { upgradedAt47Ms: upgraded, from: 48, to: rows.at(-1)?.frame ?? null, boundaries: rows.filter((r) => r.shows === 'either').length,
      denseBeats: rows.filter((r) => r.shows === 'dense').length, sparseBeats: rows.filter((r) => r.shows === 'sparse').length,
      wrong: wrong.slice(0, 6).map((r) => ({ frame: r.frame, shows: r.shows, scores: r.scores })),
      clipA: rows.filter((r) => r.clipA !== undefined).map((r) => [r.frame, r.clipA]).filter(([f, b]) => f !== b), servedKeptSparse: servedKept };
    say('a-stage-swap', out.a.stageSwap);
    check(rows.length === LAST_STEP - 47, 'Stage switch to full density: every tick was compared', rows.length);
    check(wrong.length === 0 && out.a.stageSwap.denseBeats >= 140, 'Stage switch to full density: stepping forward frame by frame after the switch, every tick shows the frame\'s own image (none wrong, none fell back to the sparse version)', out.a.stageSwap);
    check(out.a.stageSwap.boundaries >= 10, 'Stage switch to full density: crossed about ten segment boundaries', out.a.stageSwap.boundaries);
    check(out.a.stageSwap.clipA.length === 0, 'Stage switch to full density: full density was already complete when clip-a entered, so from entry every frame is its own image', out.a.stageSwap.clipA);
  }
  await rpc('setRole', 'back', { job: 'probe' });
  await browser.close(); browser = null;
  hostServer.close(); hostServer = null;

  // ================================================================ B: Card directly evaluated by time (remotion-style)
  const B = openPipeline(path.join(OUT, 'library-b'), origin);
  pipelines.push(B.pipeline);
  t0 = Date.now();
  await B.pipeline.preload(DIRECT('sparse-stream-probe-direct'));
  if (!(await until('B: sparse version complete', () => allAt(B.producer, (s) => !!s), 600_000))) throw new Error(`B's sparse version was not fully produced: ${JSON.stringify(B.producer.status().log.slice(-8))}`);
  await sleep(600);
  const stateB = [...B.producer.streams.values()][0];
  out.b = { sparseMs: Date.now() - t0, replay: stateB.spec.replay !== false, resetsAfterSparse: B.producer.stats.resets, segments: stateB.spec.lastSegment + 1 };
  check(B.producer.streams.size === 1 && stateB.spec.replay === false, 'B: one stream without replay (remotion style)', { replay: stateB.spec.replay });
  check(stateB.spec.originFrame === WANT['clip-c'][0] && stateB.spec.lastFrame === WANT['clip-c'][1], 'B: frames 20 to 110', { originFrame: stateB.spec.originFrame, lastFrame: stateB.spec.lastFrame });
  check(out.b.resetsAfterSparse <= 2, 'B: during the sparse pass, jump straight between segments without reloading the project for each segment', { resets: out.b.resetsAfterSparse, segments: out.b.segments });
  const dirB = path.join(OUT, 'ref-clip-c');
  await fs.mkdir(dirB, { recursive: true });
  const truthB = await exportFrames(bakery, stateB.isolated, emptyUrl, WANT['clip-c'][1], dirB);
  const sparseB = await checkSparse('B clip-c', B.producer, stateB, truthB, dirB, { direct: true });
  out.b.sparse = { bound: sparseB.bound, tight: sparseB.tight, union: sparseB.union, segments: sparseB.segments };
  t0 = Date.now();
  B.gate.hold = false;
  B.producer.kick();
  if (!(await until('B: full density complete', () => (allAt(B.producer, (s) => s?.stride === 1) && !B.producer.workers.size ? true : null), 900_000))) throw new Error(`B's full density was not fully produced: ${JSON.stringify(B.producer.status().log.slice(-8))}`);
  out.b.denseMs = Date.now() - t0;
  out.b.order = checkOrder('B', B.events, stateB.spec.lastSegment + 1);
  const denseB = await checkDense('B clip-c', B.producer, stateB, truthB, dirB, sparseB, { direct: true });
  out.b.dense = { widened: denseB.widened, tight: denseB.tight, rects: denseB.rects, clipped: denseB.clipped.length };
  say('b', out.b);

  // ================================================================ C: Queued stream task path (produceRange called by executor)
  const C = openPipeline(path.join(OUT, 'library-c'), origin, { frozen: true });
  pipelines.push(C.pipeline);
  const entryC = await C.pipeline.preload(DIRECT('sparse-stream-probe-queue'));
  const stateC = await until('C: the stream plan reached the producer', () => [...C.producer.streams.values()][0] ?? null, 120_000);
  if (!stateC) throw new Error('C: the producer did not get a stream');
  await sleep(500);
  check(Object.keys(stateC.manifest.segments ?? {}).length === 0, 'C: automatic production did not run (no segment produced)');
  const specC = stateC.spec, range = { from: 1, to: 3 };
  const runQueue = async (density) => { const mark = C.events.length; const r = await C.producer.produceRange(entryC, specC, range, { density }); return { ...r, strides: C.events.slice(mark).filter((e) => e.ev === 'start').map((e) => e.stride) }; };
  const q1 = await runQueue('sparse');
  const afterSparse = [1, 2, 3].map((n) => ({ n, stride: stateC.manifest.segments[n]?.stride, box: stateC.manifest.segments[n]?.box }));
  check(q1.produced === 3 && q1.strides.every((s) => s === SPARSE_STRIDE), 'C: the sparse stream task produced the three segments of this range, one image each', q1);
  check(afterSparse.every((s) => s.stride === SPARSE_STRIDE && s.box && typeof s.box.w === 'number'), 'C: segments produced by the sparse stream task are recorded as sparse and carry a position rectangle', afterSparse);
  check(stateC.manifest.segments[0] === undefined && stateC.manifest.segments[4] === undefined, 'C: only the segments within the task\'s range were produced');
  const q2 = await runQueue('sparse');
  check(q2.produced === 0 && q2.skipped === 3 && q2.strides.length === 0, 'C: running the same sparse stream task again captures no frames', q2);
  const q3 = await runQueue(null);
  const afterDense = [1, 2, 3].map((n) => ({ n, stride: stateC.manifest.segments[n]?.stride, box: stateC.manifest.segments[n]?.box }));
  check(q3.produced === 3 && q3.strides.every((s) => s === 1) && afterDense.every((s) => s.stride === 1), 'C: a full-density task fills the same stream up to full density', { q3, afterDense });
  check(JSON.stringify(afterDense.map((s) => s.box)) === JSON.stringify(afterSparse.map((s) => s.box)), 'C: after filling up to full density, the position rectangles stay as they were');
  const q4 = await runQueue('sparse');
  check(q4.produced === 0 && q4.strides.length === 0 && [1, 2, 3].every((n) => stateC.manifest.segments[n]?.stride === 1), 'C: a sparse stream task after full density captures nothing and does not downgrade', q4);
  out.c = { sparse: q1, again: q2, dense: q3, late: q4, boxes: afterSparse.map((s) => s.box) };
  say('c', out.c);
} catch (error) {
  fails.push(`Probe error: ${error?.message || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); } catch { /* ignore */ }
  for (const p of pipelines) { try { await p.close(); } catch { /* ignore */ } }
  try { await bakery?.close(); } catch { /* ignore */ }
  dropStreamEncoderSpares();
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (!/\.(json|png)$/.test(name)) await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.elapsedMs = Date.now() - started;
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(out.ok ? 'PASS' : `FAIL ${fails.length}`);
process.exit(out.ok ? 0 : 1);
