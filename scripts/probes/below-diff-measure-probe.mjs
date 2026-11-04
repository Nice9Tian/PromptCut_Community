/**
 * What goes into below-dependent streams: measure first, decide later (render refactor "Wu-2",
 * "Lower Layer 2", `docs/plan/prerender-products-contract.md` section 5.3).
 *
 *   node scripts/probes/below-diff-measure-probe.mjs [--origin http://127.0.0.1:27800 | --port 27804] [--media-port 27810]
 *        [--scenes a,b] [--sizes 960x540,1920x1080] [--frames 90] [--rounds 2] [--out <dir>] [--keep] [--json <file>]
 *
 * Bypasses producer and frame store: opens its own prerender room, capturing frames directly with
 * `bakeStream` and `server/bakery/capture-below.mjs`, so it runs even with the switch
 * (`BELOW_STREAMS_DEFAULT`) off. Two scenes and two aspect ratios (see `below-stream-common.mjs`),
 * measuring each:
 *
 *   1. **Overhead of capturing two shots per frame**: for the same frame range, single capture
 *      (current approach) vs. capturing two shots and computing that layer, alternating multiple
 *      passes to take the median, measuring milliseconds per frame for the capture phase (time
 *      waiting for assets to be ready is identical on both sides and listed separately); one set for
 *      a sparse pass (yielding full canvas) and one for a full density pass (yielding a tight
 *      rectangle). Also measures "how much faster it is when tightening the capture rectangle" and
 *      "whether tightening the capture rectangle changes the image" (it does, so in production
 *      both capture full canvas and then crop).
 *   2. **Capturing two shots does not disturb the page**: the upper shot from the two-shot pass is
 *      byte-for-byte identical to the single-capture pass; upper and lower shots are compared
 *      pixel-by-pixel against the same frame rendered via the export path for two projects: "with
 *      target card" and "lower layer only".
 *   3. **Error**: contents placed in the four stream types, each overlaid onto the "lower-layer-only
 *      export image" and compared against the "full-canvas export image" (premultiplied color, out
 *      of 255), one value before encoding, one after H.264 encoding and decoding:
 *        - Contract: formula from section 5.3 of the contract (opacity takes the minimum);
 *        - Dual compromise: when the lower layer is semi-transparent, error tolerances for opacity
 *          and color are relaxed slightly on both ends, without a frosted-glass mask;
 *        - Layer extraction: used in production: "dual compromise" plus setting opacity to 1 within
 *          the frosted-glass outer frame (`diffLayer`);
 *        - As-is: as-is overlay: crops directly from the image containing the lower layer.
 *      Includes control: overlaid image of the same frame compared against the true image 7 frames
 *      later. Also provides a baseline "codec error itself": encodes the true image as-is, decodes
 *      it, and compares directly with the true image.
 *   4. **Lower layer offset by one frame**: stream is at frame f, while the lower layer is already
 *      at frame f+1 (video and live-rendered cards often differ by this much when pasted back onto
 *      the stage); overlaid and compared against the true image at frame f+1.
 *
 * Elapsed time is recorded only, not used as a pass condition. If any invariant fails (capturing
 * two shots disturbs the page, overlay error exceeds order of magnitude, missing control), exits
 * with non-zero.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { flagArg } from './probe-connect.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeStream, bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, openStreamSegmentEncoder, dropStreamEncoderSpares, pickStreamEncoder } from '../../server/bakery/ffmpeg.mjs';
import { decodePngRgba, rgbaAlphaBox } from '../../server/bakery/capture-canvas.mjs';
import { belowSegmentCapture, diffLayer, glassMask, newBelowRecord } from '../../server/bakery/capture-below.mjs';
import { isolatedBelowProject, splitFmp4, evenRect, padRect, unionRect, intersectRect, SEGMENT_FRAMES, SPARSE_STRIDE, MEASURE_PAD_PX } from '../../server/frame-stream.mjs';
import { ROOT, FPS, TARGET, scenarioProject, startDevServer, ensureVideo, serveMedia, emptyUrlOf, decodeSegment,
  newError, errorSummary, tallyStraight, tallyDecoded, tallyDecodedDirect, composeDecoded, cropRgba, savePreview, round2, median } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '27804', args));
const MEDIA_PORT = Number(flagArg('media-port', '27810', args));
const SCENES = String(flagArg('scenes', 'a,b', args)).split(',').map((s) => s.trim()).filter((s) => s === 'a' || s === 'b');
const SIZES = String(flagArg('sizes', '960x540,1920x1080', args)).split(',').map((s) => s.trim().split('x').map(Number)).filter(([w, h]) => w > 0 && h > 0);
const FRAMES = Math.max(30, Math.min(90, Number(flagArg('frames', '90', args)) || 90));
const ROUNDS = Math.max(1, Number(flagArg('rounds', '2', args)) || 2);
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-below-measure-${Date.now().toString(36)}`));

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } return cond; };
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const pad = (n) => String(n).padStart(4, '0');
const SCENE_NAME = { a: 'A', b: 'B' };
const VARIANTS = ['contract', 'twoYield', 'extractLayer', 'asIs'];

/** Original formula from section 5.3 of the contract: opacity takes the maximum of the "opacity formula" and the two lower bounds across each color channel */
function diffContract(upper, lower, width, crop) {
  const out = Buffer.alloc(crop.w * crop.h * 4);
  for (let y = 0; y < crop.h; y++) {
    let i = ((y + crop.y) * width + crop.x) * 4, o = y * crop.w * 4;
    for (let x = 0; x < crop.w; x++, i += 4, o += 4) {
      const ra8 = upper[i + 3], la8 = lower[i + 3];
      if (ra8 === la8 && upper[i] === lower[i] && upper[i + 1] === lower[i + 1] && upper[i + 2] === lower[i + 2]) continue;
      if (ra8 === 0) continue;
      const ra = ra8 / 255, la = la8 / 255;
      let a = la8 < 255 ? (ra - la) / (1 - la) : 0;
      const rc = [0, 0, 0], lc = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        rc[k] = upper[i + k] / 255 * ra; lc[k] = lower[i + k] / 255 * la;
        if (lc[k] > 0) a = Math.max(a, 1 - rc[k] / lc[k]);
        if (lc[k] < 1) a = Math.max(a, (rc[k] - lc[k]) / (1 - lc[k]));
      }
      a = Math.max(0, Math.min(1, a));
      const a8 = Math.round(a * 255);
      if (!a8) continue;
      const aq = a8 / 255;
      for (let k = 0; k < 3; k++) out[o + k] = Math.round(Math.max(0, Math.min(aq, rc[k] - lc[k] * (1 - aq))) / aq * 255);
      out[o + 3] = a8;
    }
  }
  return out;
}

/** Pixel-by-pixel comparison of two straight RGBA images: differing pixel count, max channel difference; if `width` is given, also returns bounding box of differing pixels */
function pixelDiff(a, b, width = 0) {
  if (a.equals(b)) return { differ: 0, max: 0, box: null };
  let differ = 0, max = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < a.length; i += 4) {
    // Pixel colors are ignored if fully transparent on both sides
    if (!a[i + 3] && !b[i + 3]) continue;
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
    if (!d) continue;
    differ++;
    if (d > max) max = d;
    if (width) { const x = (i / 4) % width, y = Math.floor(i / 4 / width); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { differ, max, box: width && differ ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null };
}

const out = { library: OUT, frames: FRAMES, runs: [] };
await fs.mkdir(OUT, { recursive: true });
let dev = null, media = null, bakery = null;
try {
  const ffmpeg = await findFfmpeg();
  const { encoder } = await pickStreamEncoder(ffmpeg);
  out.encoder = encoder;
  let origin = ORIGIN;
  if (!origin) { dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'belowmeasure' }); origin = dev.origin; say('spawn', { pid: dev.pid, port: PORT }); }
  out.origin = origin;
  const mediaDir = path.join(OUT, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  media = await serveMedia(MEDIA_PORT, mediaDir);

  for (const kind of SCENES) for (const [width, height] of SIZES) {
    const tag = `${SCENE_NAME[kind]} ${width}x${height}`;
    const dir = path.join(OUT, `${kind}-${width}x${height}`);
    await fs.mkdir(dir, { recursive: true });
    const run = { scene: SCENE_NAME[kind], size: `${width}x${height}` };
    out.runs.push(run);
    const hasMedia = kind === 'a';
    const mediaUrl = hasMedia ? media.url(path.basename(await ensureVideo(ffmpeg, mediaDir, width, height))) : '';
    const project = scenarioProject(kind, { width, height, mediaUrl });
    const spec = { topClipId: TARGET, clipIds: [TARGET] };
    const withTarget = isolatedBelowProject(project, spec);
    const lowerOnly = isolatedBelowProject(project, spec, { withTarget: false });
    const view = { x: 0, y: 0, w: width, h: height };
    const emptyUrl = emptyUrlOf(origin, { width, height });
    if (!bakery) bakery = await openBakery({ url: emptyUrl });
    const N = FRAMES;

    // ---------- 1. Render both projects once via the export path (true image)
    const exportFrames = async (proj, name) => {
      await bakery.reset(proj, emptyUrl);
      bakery.streamLease = null;
      const started = performance.now();
      await bakeFrames(bakery, { out: path.join(dir, `export-${name}`), fps: FPS, frames: `0-${N - 1}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
        onFrame: async (i, buf) => { await fs.writeFile(path.join(dir, `${name}-${pad(i)}.png`), buf); } });
      return performance.now() - started;
    };
    run.exportMs = { full: round2(await exportFrames(withTarget, 'full')), lower: round2(await exportFrames(lowerOnly, 'lower')) };
    say('export', { tag, ...run.exportMs });

    // ---------- 2. Frame capture passes
    /** Runs a pass: first `count` frames, one `capture` per segment. Returns elapsed time per frame: `hook` is spent in capture hook, `media` waiting for assets to be ready, `step` advancing frames */
    const pass = async (label, { capture = null, clip = view, stride = 1, onFrame = null, count = N, hookMs = () => 0 }) => {
      await bakery.reset(withTarget, emptyUrl, { deferCards: true });
      bakery.streamLease = null;
      const sum = { captured: 0, captureMs: 0, stepMs: 0, stepped: 0 };
      const started = performance.now();
      for (let seg = 0; seg * SEGMENT_FRAMES < count; seg++) {
        const from = seg * SEGMENT_FRAMES, to = Math.min(count - 1, from + SEGMENT_FRAMES - 1);
        const r = await bakeStream(bakery, { streamSignature: `${label}:${tag}`, fromFrame: from, toFrame: to, stride, fps: FPS, mountFrame: 0, clip, hasMedia,
          ...(capture ? { capture: capture(seg) } : {}), onFrame: onFrame ?? (async () => {}) });
        sum.captured += r.captured; sum.captureMs += r.captureMs; sum.stepMs += r.stepMs; sum.stepped += to - from + 1 + r.replayed;
      }
      const hook = hookMs() / sum.captured;
      return { captured: sum.captured, wallMs: performance.now() - started, capture: sum.captureMs / sum.captured, hook, media: sum.captureMs / sum.captured - hook, step: sum.stepMs / sum.stepped };
    };
    const hookOf = (record) => record.upperMs + record.lowerMs + record.verifyMs + record.decodeMs + record.diffMs;
    const perFrame = (record) => ({ upper: round2(record.upperMs / record.frames), lower: round2(record.lowerMs / record.frames), decode: round2(record.decodeMs / record.frames),
      diff: round2(record.diffMs / record.frames), verify: round2(record.verifyMs / record.frames),
      frames: record.frames, absent: record.absent, same: record.same, glassFrames: record.glassFrames, checks: record.checks, last: record.last, failed: record.failed, primeLower: record.primeLower });
    /** Single capture: hook is just that original single screenshot */
    const singlePass = (label, options = {}) => { let ms = 0; return pass(label, { ...options, hookMs: () => ms, capture: () => async (_frame, shoot) => { const at = performance.now(); const png = await shoot(); ms += performance.now() - at; return png; } }); };
    /** Capture two shots and compute that layer (production hook) */
    const pairPass = (label, { rect = view, clip = view, ...options } = {}) => { const record = newBelowRecord(); return pass(label, { ...options, clip, hookMs: () => hookOf(record),
      capture: () => belowSegmentCapture(bakery, { clipId: TARGET, view: clip, rect, record }) }).then((r) => ({ ...r, record })); };

    // Run a single-capture pass first (record fingerprint for each frame), then a two-shot pass (save both shots, untimed)
    const singleSha = [];
    await pass('single', { onFrame: async (frame, png) => { singleSha[frame] = sha(png); } });
    const upperSha = [], absent = [], glassOf = [];
    let measured = null;
    const record = newBelowRecord();
    await pass('pair', {
      capture: () => belowSegmentCapture(bakery, { clipId: TARGET, view, rect: view, record,
        tap: async ({ frame, upperPng, lowerPng, glass, absent: gone }) => {
          upperSha[frame] = sha(upperPng); absent[frame] = gone; glassOf[frame] = glass;
          await fs.writeFile(path.join(dir, `up-${pad(frame)}.png`), upperPng);
          if (lowerPng) await fs.writeFile(path.join(dir, `lo-${pad(frame)}.png`), lowerPng);
        } }),
      onFrame: async (_frame, shot) => {
        const box = rgbaAlphaBox(shot.rgba, shot.width, shot.height);
        if (box) measured = unionRect(measured, box);
      } });
    run.pairRecord = perFrame(record);
    run.glass = glassOf.find((g) => g?.length) ?? null;
    check(!record.failed && record.checks >= 1 && record.last?.lowerStable && record.last?.upperStable && !record.primeLower, `${tag}: measurements of the first frame of every segment all passed (two identical shots hidden, upper shot unchanged after removal)`, run.pairRecord);
    check(record.checks === Math.ceil(N / SEGMENT_FRAMES), `${tag}: each segment measured once`, record.checks);
    check(record.frames === N, `${tag}: the two-shot pass captured ${N} frames`, record.frames);
    check(absent.filter(Boolean).length === 6, `${tag}: the target card is absent from the page in the 6 frames before entrance`, absent.filter(Boolean).length);
    check(record.glassFrames === N - 6, `${tag}: the frosted-glass bounding box was measured in every frame where the target card is present`, record.glassFrames);
    const upperSame = upperSha.filter((h, f) => h === singleSha[f]).length;
    run.upperSameAsSingle = `${upperSame}/${N}`;
    check(upperSame === N, `${tag}: the upper shot of the two-shot pass is byte-identical to the single-shot pass`, run.upperSameAsSingle);
    check(!!measured, `${tag}: that layer is not empty`);
    const tight = evenRect(intersectRect(padRect(measured ?? view, MEASURE_PAD_PX), view), view);
    run.measured = measured; run.tight = tight; run.tightShare = round2(tight.w * tight.h / (width * height));
    check(tight.w * tight.h < width * height * 0.85, `${tag}: areas of the target card without changes are fully transparent (the measured solid box is clearly smaller than the full frame)`, { tight, share: run.tightShare });

    // Timing: single capture vs. two-shot capture, alternating ROUNDS rounds to take median (first 60 frames)
    const COUNT = Math.min(N, 60);
    const rounds = { sparseSingle: [], sparsePair: [], denseSingle: [], densePair: [], densePairTightView: [] };
    for (let r = 0; r < ROUNDS; r++) {
      rounds.sparseSingle.push(await singlePass('t-sparse-single', { stride: SPARSE_STRIDE, count: COUNT }));
      rounds.sparsePair.push(await pairPass('t-sparse-pair', { stride: SPARSE_STRIDE, count: COUNT }));
      rounds.denseSingle.push(await singlePass('t-dense-single', { count: COUNT }));
      rounds.densePair.push(await pairPass('t-dense-pair', { rect: tight, count: COUNT }));
      if (r === 0) rounds.densePairTightView.push(await pairPass('t-dense-pair-tightview', { rect: tight, clip: tight, count: COUNT }));
    }
    const mid = (list) => ({ hook: round2(median(list.map((x) => x.hook))), media: round2(median(list.map((x) => x.media))), step: round2(median(list.map((x) => x.step))),
      wallPerFrame: round2(median(list.map((x) => x.wallMs / x.captured))), ...(list[0].record ? { breakdown: perFrame(list[0].record) } : {}) });
    const side = (single, pair) => { const a = mid(single), b = mid(pair); return { single: a, pair: b, extraHookPerFrame: round2(b.hook - a.hook), wallRatio: round2(b.wallPerFrame / a.wallPerFrame) }; };
    run.timing = {
      // Sparse pass: capture every 3 frames, yielding full canvas (measure entity box)
      sparse: side(rounds.sparseSingle, rounds.sparsePair),
      // Full density pass: capture every frame; both shots capture full canvas, yielding a tight rectangle
      dense: side(rounds.denseSingle, rounds.densePair),
      // For reference only: both shots captured to tight rectangle (image changes, unusable, see tightClip)
      densePairTightView: mid(rounds.densePairTightView),
    };
    // Whether image changes after tightening capture rectangle: single capture, cropped to tight
    // rectangle, compared against the same frame captured full-canvas
    const tightDiff = { frames: 0, differFrames: 0, differPixels: 0, max: 0, box: null };
    await pass('single-tight', { clip: tight, count: Math.min(N, 30), onFrame: async (frame, png) => {
      const small = decodePngRgba(png), full = decodePngRgba(await fs.readFile(path.join(dir, `up-${pad(frame)}.png`)));
      const d = pixelDiff(small.data, cropRgba(full.data, width, tight), tight.w);
      tightDiff.frames++; if (d.differ) tightDiff.differFrames++; tightDiff.differPixels += d.differ; tightDiff.max = Math.max(tightDiff.max, d.max);
      // Which region within tight rectangle differing pixels fall into (in rectangle's own coordinates)
      if (d.box) tightDiff.box = unionRect(tightDiff.box, d.box);
    } });
    run.tightClip = tightDiff;
    say('timing', { tag, ...run.timing, tightClip: tightDiff });

    // ---------- 3. Contents placed in the four stream types: before encoding, after encoding, offset by one frame
    const cache = new Map();
    const load = async (name, frame) => {
      const key = `${name}-${frame}`;
      if (cache.has(key)) return cache.get(key);
      const file = path.join(dir, `${name}-${pad(frame)}.png`);
      const data = decodePngRgba(await fs.readFile(file))?.data;
      if (!data) throw new Error(`Cannot decode ${file}`);
      cache.set(key, data);
      if (cache.size > 96) cache.delete(cache.keys().next().value);
      return data;
    };
    const pairVsExport = { upper: { differFrames: 0, differPixels: 0, max: 0 }, lower: { differFrames: 0, differPixels: 0, max: 0 } };
    const errors = Object.fromEntries(VARIANTS.map((v) => [v, { before: newError(), after: newError(), other: newError(), shifted: newError(), bytes: 0, covered: 0 }]));
    const floor = newError();
    const previewAt = Math.min(N - 2, 47);
    const segments = Math.ceil(N / SEGMENT_FRAMES);
    for (let seg = 0; seg < segments; seg++) {
      const from = seg * SEGMENT_FRAMES, to = Math.min(N - 1, from + SEGMENT_FRAMES - 1);
      const layers = Object.fromEntries(VARIANTS.map((v) => [v, []]));
      for (let f = from; f <= to; f++) {
        const upper = await load('up', f);
        const lower = absent[f] ? upper : await load('lo', f);
        const full = await load('full', f), below = await load('lower', f);
        const du = pixelDiff(upper, full), dl = pixelDiff(lower, below);
        if (du.differ) { pairVsExport.upper.differFrames++; pairVsExport.upper.differPixels += du.differ; pairVsExport.upper.max = Math.max(pairVsExport.upper.max, du.max); }
        if (dl.differ) { pairVsExport.lower.differFrames++; pairVsExport.lower.differPixels += dl.differ; pairVsExport.lower.max = Math.max(pairVsExport.lower.max, dl.max); }
        const glass = glassOf[f]?.length ? glassOf[f] : null;
        const made = {
          contract: absent[f] ? Buffer.alloc(tight.w * tight.h * 4) : diffContract(upper, lower, width, tight),
          twoYield: absent[f] ? Buffer.alloc(tight.w * tight.h * 4) : diffLayer(upper, lower, width, height, { crop: tight }).rgba,
          extractLayer: absent[f] ? Buffer.alloc(tight.w * tight.h * 4) : diffLayer(upper, lower, width, height, { crop: tight, mask: glass ? glassMask(glass, tight) : null }).rgba,
          asIs: cropRgba(upper, width, tight),
        };
        for (const v of VARIANTS) {
          tallyStraight(errors[v].before, made[v], tight, below, full, width);
          for (let i = 3; i < made[v].length; i += 4) if (made[v][i]) errors[v].covered++;
          layers[v].push(made[v]);
        }
        if (f === previewAt) for (const v of VARIANTS) await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-layer-${v}.png`), made[v], tight.w, tight.h);
      }
      for (const v of VARIANTS) {
        const enc = openStreamSegmentEncoder(ffmpeg, { encoder, fps: FPS, raw: { width: tight.w, height: tight.h } });
        for (const layer of layers[v]) await enc.write(layer);
        const done = await enc.finish();
        const { init, segments: parts } = splitFmp4(done.bytes);
        if (!check(parts.length === 1 && init.length > 0, `${tag} ${v}#${seg}: encoded one segment`, parts.length)) continue;
        errors[v].bytes += parts[0].length;
        const decoded = await decodeSegment(ffmpeg, init, parts[0], dir, `dec-${seg}`);
        const frameBytes = tight.w * (2 * (tight.h + 8)) * 3;
        if (!check(decoded.length === (to - from + 1) * frameBytes, `${tag} ${v}#${seg}: decoded ${to - from + 1} frames`, decoded.length / frameBytes)) continue;
        for (let f = from; f <= to; f++) {
          const picture = decoded.subarray((f - from) * frameBytes, (f - from + 1) * frameBytes);
          tallyDecoded(errors[v].after, picture, tight, await load('lower', f), await load('full', f), width);
          if (v === 'asIs') tallyDecodedDirect(floor, picture, tight, await load('full', f), width);
          // Control: overlaid image of the same frame, compared against true image 7 frames later (wrapped around)
          const g = (f + 7) % N;
          tallyDecoded(errors[v].other, picture, tight, await load('lower', f), await load('full', g), width);
          // Lower layer offset by one frame: stream is at frame f, lower layer and true image are both at frame f+1
          if (f + 1 < N) tallyDecoded(errors[v].shifted, picture, tight, await load('lower', f + 1), await load('full', f + 1), width);
          if (f === previewAt) {
            await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-back-${v}.png`), composeDecoded(picture, tight, await load('lower', f), width), tight.w, tight.h);
            await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-shifted-${v}.png`), composeDecoded(picture, tight, await load('lower', f + 1), width), tight.w, tight.h);
          }
        }
      }
    }
    await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-truth.png`), cropRgba(await load('full', previewAt), width, tight), tight.w, tight.h);
    await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-truth-next.png`), cropRgba(await load('full', previewAt + 1), width, tight), tight.w, tight.h);
    await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-whole.png`), await load('full', previewAt), width, height);
    run.pairVsExport = pairVsExport;
    check(pairVsExport.lower.differFrames === 0, `${tag}: the lower shot captured with the target card hidden is pixel-identical to the same frame rendered by the export method for a "lower layer only" project`, pairVsExport.lower);
    check(pairVsExport.upper.differFrames === 0, `${tag}: the upper shot is pixel-identical to the same frame rendered by the export method for a project "with the target card"`, pairVsExport.upper);
    run.errors = Object.fromEntries(VARIANTS.map((v) => [v, {
      beforeEncode: errorSummary(errors[v].before), afterEncode: errorSummary(errors[v].after), control_otherMoment: errorSummary(errors[v].other), lowerShiftedOneFrame: errorSummary(errors[v].shifted),
      streamBytes: errors[v].bytes, opaquePixelShareOfTightRect: round2(errors[v].covered / (N * tight.w * tight.h)),
    }]));
    for (const v of VARIANTS) say('errors', { tag, v, ...run.errors[v] });
    run.codecFloor = errorSummary(floor);
    say('floor', { tag, ...run.codecFloor });
    const mine = run.errors.extractLayer, asIs = run.errors.asIs;
    check(mine.beforeEncode.mean <= 0.5 && mine.beforeEncode.max <= 2.5, `${tag}: the extracted layer, composited back before encoding, differs from the real frame within quantization error`, mine.beforeEncode);
    // Baseline for "within codec error": error from passing the true image as-is through the same encoder
    check(mine.afterEncode.mean <= run.codecFloor.mean + 0.5 && mine.afterEncode.bad <= run.codecFloor.bad * 1.25 + mine.afterEncode.pixels * 0.001,
      `${tag}: the difference between the extracted layer composited back after encoding and the real frame does not exceed the difference of the real frame passed through the encoder as is`, { layer: mine.afterEncode, floor: run.codecFloor });
    check(mine.control_otherMoment.mean > 3 * mine.afterEncode.mean && mine.control_otherMoment.bad > 5 * (mine.afterEncode.bad + 1), `${tag}: the control (real frame from another moment) is clearly larger`, { same: mine.afterEncode, other: mine.control_otherMoment });
    run.verdict = { layerVsAsIs_meanDiffAfterEncode: [mine.afterEncode.mean, asIs.afterEncode.mean], layerVsAsIs_lowerShiftedOneFrame: [mine.lowerShiftedOneFrame.mean, asIs.lowerShiftedOneFrame.mean] };
    cache.clear();
    if (!KEEP) for (const name of await fs.readdir(dir)) await fs.rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await bakery?.close(); } catch { /* ignore */ }
  dropStreamEncoderSpares();
  try { await media?.close(); } catch { /* ignore */ }
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (name !== 'result.json' && name !== 'previews') await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
// Conclusion: one section per scene and aspect ratio
const brief = { ok: out.ok, fails, encoder: out.encoder, runs: out.runs.map((r) => ({ scene: r.scene, size: r.size, tight: r.tight, glass: r.glass, timing: r.timing, tightClip: r.tightClip, pairVsExport: r.pairVsExport, upperSameAsSingle: r.upperSameAsSingle, codecFloor: r.codecFloor, errors: r.errors, verdict: r.verdict })) };
console.log(JSON.stringify(brief, null, 2));
void ROOT; void fsSync;
process.exit(out.ok ? 0 : 1);
