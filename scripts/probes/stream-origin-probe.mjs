/**
 * Track stream segments count from this stream's own first frame: end-to-end probe for stream
 * generation, playback, and scrubbing, **comparing pixels frame by frame**
 * (`docs/plan/html-snapshot-removal-dryrun.md` section 10.5; conversion in `src/render/streamSegments.mjs`).
 *
 *   node scripts/probes/stream-origin-probe.mjs (--origin http://127.0.0.1:27860 | --port 27860) [--host-port <port>] [--group] [--out <dir>] [--keep] [--json <file>]
 *
 * If `--origin` is given, uses that dev server; if `--port` is given, starts one at the checkout root
 * (also taking +1 and +2 as stage ports), torn down by process ID when finished.
 * `--host-port`: which port to serve the test page acting as parent page and stream bytes from
 * (if omitted, the system picks one).
 * Directly starts `FramePipeline` in this process (same code as prerender process), store root in a
 * temp directory. Two animated cards in the project, **neither starting on a multiple of 15 frames**:
 *
 *   clip-b  probe card `r6-stateful` (a block of text, shifts 10 px horizontally per frame), frames 40-129 (90 frames)
 *   clip-a  the same card, frames 100-149 (50 frames, duration is also not a multiple of 15: last segment has only 5 frames)
 *
 * Without `--group`: one single-card stream each (first frames are 40 and 100 respectively).
 * With `--group`: decoder budget clamped to 1, merged into one group stream (first frame is 40, the earliest
 * among members, up to frame 149). Below-dependent streams are checked by `stream-below-probe.mjs`
 * (its target card enters at frame 6).
 *
 * Check item by item:
 *
 *   1. Plan: each stream's `originFrame` is its own first frame, `firstSegment` is 0, manifest and ready
 *      messages carry this frame; sample count of each segment = number of frames covered by this
 *      segment (only the last segment may have fewer than 15).
 *   2. **Stream generation, frame by frame**: decode each segment; the kth sample of segment n should be
 *      project frame `originFrame + n × 15 + k`. Reference is the isolated project of this stream
 *      stepped through sequentially from the start, capturing one frame per frame (independent of
 *      segmentation). Each frame compares the decoded image against itself, two frames before, and two
 *      frames after: **it must be most similar to itself**; cumulative difference must not exceed the
 *      difference of "passing the same frame through the same encoder as is";
 *      Control: compared against the next frame and against the frame matched under "count segments by
 *      project frame number" (the previous behavior), differences are significantly larger.
 *   3. **Stage stream paste, frame by frame (scrubbing)**: test page acts as parent page, stream plane
 *      is composited using `streamPlanesFor` from the product according to ready messages (with `originFrame`).
 *      For every frame where these two cards are present: set time to this frame, wait for stream plane
 *      to draw this frame, capture the stage, and compare against the same frame on the export page;
 *      similarly compare it against one frame before and after: it must be most similar to itself.
 *      Stream frames are decoded asynchronously; while paused there is no next tick: the moment it is
 *      drawn, the stage must not still have a placeholder (parent page does not resend any message;
 *      previously a resend was needed before stream plane was dismissed).
 *   4. **Real playback**: start playback from before cards enter, pause; no dropped frames; compare the
 *      paused frame in the same way.
 *   5. Frames earlier than the stream's first frame: stream plane draws nothing (no segments).
 *
 * Outputs JSON conclusion, writes progress to stderr; exits with non-zero if any check fails. Duration is only recorded.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { handleStreamRequest, splitFmp4 } from '../../server/frame-stream.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, openStreamSegmentEncoder, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { decodePngRgba } from '../../server/bakery/capture-canvas.mjs';
import { startDevServer, emptyUrlOf, decodeSegment, newError, errorSummary, tallyDecodedDirect, cropRgba, savePreview, sleep, round2 } from './below-stream-common.mjs';
import { streamPlanesFor } from '../../src/render/streamPlayer.ts';
import { STREAM_SEGMENT_FRAMES, streamSegmentFirstFrame, streamSegmentFrameCount, streamSegmentOf } from '../../src/render/streamSegments.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const GROUP = args.includes('--group');
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const HOST_PORT = Number(flagArg('host-port', '0', args)) || 0;
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-origin-probe-${Date.now().toString(36)}`));
if (GROUP) process.env.PROMPTCUT_STREAM_DECODERS = '1';
process.env.PROMPTCUT_STREAM_POOL = '1';
if (!ORIGIN && !PORT) { console.error('Pass --origin <dev server> or --port <start your own>'); process.exit(2); }

const FPS = 30, WIDTH = 1280, HEIGHT = 720, DURATION = 6;
/**
 * Frames of the two cards on the timeline (closed interval). In points and out points are written in
 * seconds, falling between two frames (frame numbers divided by 30 are mostly not finite decimals;
 * converting directly to seconds would be off by one frame).
 */
const CLIPS = {
  'clip-b': { frames: [40, 129], start: 1.32, end: 4.32, frame: { x: 0, y: 380, w: WIDTH, h: 300 } },
  'clip-a': { frames: [100, 149], start: 3.32, end: 4.99, frame: { x: 0, y: 40, w: WIDTH, h: 300 } },
};
const PROJECT = {
  id: 'stream-origin-probe', name: 'Stream segment origin probe', width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  // The first track is on top; the two are adjacent with no other layers in between
  // (group stream only merges adjacent ones)
  tracks: [
    { id: 'tr-a', name: 'a', hidden: false, clips: [{ id: 'clip-a', kind: 'card', cardId: 'r6-stateful', start: CLIPS['clip-a'].start, end: CLIPS['clip-a'].end, params: {}, frame: CLIPS['clip-a'].frame }] },
    { id: 'tr-b', name: 'b', hidden: false, clips: [{ id: 'clip-b', kind: 'card', cardId: 'r6-stateful', start: CLIPS['clip-b'].start, end: CLIPS['clip-b'].end, params: {}, frame: CLIPS['clip-b'].frame }] },
  ],
};
const FIRST = 40, LAST = 149;

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } return cond; };
async function until(label, fn, timeoutMs, everyMs = 500) {
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
    has: (frame) => png.has(frame),
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
 * Step through export page sequentially, capturing a full frame per frame (transparent background):
 * reference, independent of how segments are split.
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

/** RGBA PNG → RGB underlaid with test page background color (full frame of export page has transparent background, stage screenshot is overlaid on test page background color) */
function rgbOver(buf, bg = [0x20, 0x20, 0x20]) {
  const png = PNG.sync.read(buf);
  const out = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
    const a = png.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) out[j + k] = Math.round(png.data[i + k] * a + bg[k] * (1 - a));
  }
  return { width: png.width, height: png.height, rgb: out };
}
/**
 * Difference between two RGB images: average difference, and number of pixels with difference > 48
 * (pixels "clearly not the same image").
 */
function rgbDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { mean: Infinity, bad: Infinity };
  let sum = 0, bad = 0;
  for (let i = 0; i < a.rgb.length; i += 3) {
    const d0 = Math.abs(a.rgb[i] - b.rgb[i]), d1 = Math.abs(a.rgb[i + 1] - b.rgb[i + 1]), d2 = Math.abs(a.rgb[i + 2] - b.rgb[i + 2]);
    sum += d0 + d1 + d2;
    if (d0 > 48 || d1 > 48 || d2 > 48) bad++;
  }
  return { mean: sum / a.rgb.length, bad };
}

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>stream origin probe host</title></head>
<body style="margin:0;background:#202020">
<iframe id="a" src="${oa}/?stage=1&id=A&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block"></iframe>
<iframe id="b" src="${ob}/?stage=1&id=B&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block;opacity:0;pointer-events:none;position:absolute;left:0;top:0"></iframe>
<script type="module">
function createStageRpc(target, targetOrigin) {
  let nextId = 1; const pending = new Map(); const listeners = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); return; }
    if (d && typeof d.type === 'string' && ['mediaReady', 'frame', 'ended', 'settled', 'probe', 'demote', 'probe-frame'].includes(d.type)) for (const l of listeners) l(d);
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, targetOrigin); });
  const c = { onEvent: (l) => { listeners.add(l); return () => listeners.delete(l); } };
  for (const m of ['setProject', 'setTime', 'setRole', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setPlaying']) c[m] = call(m);
  return c;
}
window.__frames = [];
const waitReady = (frame, targetOrigin) => new Promise((res) => {
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    res(createStageRpc(frame.contentWindow, targetOrigin));
  });
});
window.__ready = Promise.all([waitReady(document.getElementById('a'), '${oa}'), waitReady(document.getElementById('b'), '${ob}')])
  .then(([a, b]) => { window.__rpc = a; window.__rpcB = b; a.onEvent((ev) => { if (ev.type === 'frame') window.__frames.push({ sec: ev.sec, at: performance.now() }); }); return true; });
</script></body></html>`;

const out = { group: GROUP, out: OUT, project: { width: WIDTH, height: HEIGHT, fps: FPS, clips: Object.fromEntries(Object.entries(CLIPS).map(([id, c]) => [id, c.frames])) } };
await fs.mkdir(OUT, { recursive: true });
let dev = null, bakery = null, pipeline = null, browser = null, hostServer = null;
const started = Date.now();
try {
  const ffmpeg = await findFfmpeg();
  let origin = ORIGIN;
  if (!origin) { dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'originprobe' }); origin = dev.origin; say('spawn', { pid: dev.pid, port: PORT }); }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;

  // ---------- 1. Produce stream
  pipeline = new FramePipeline({ root: path.join(OUT, 'library'), origin: () => origin, interactive: true, playhead: () => null });
  pipeline.streamPicked = () => true; // Pin as heavy cards
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  const layerLog = [];
  pipeline.readyIndex.subscribe((message) => { if (message.type === 'layer' && message.kind === 'stream') layerLog.push(message); });
  const t0 = Date.now();
  await pipeline.preload(PROJECT);
  const status = await until('all segments at full density', () => {
    const s = producer.status();
    if (!s.streams.length) return null;
    for (const row of s.streams) for (let n = row.firstSegment; n <= row.lastSegment; n++) if (row.segments[n]?.stride !== 1) return null;
    return !producer.workers.size && !producer.encoding.size ? s : null;
  }, 900_000, 500);
  if (!status) throw new Error(`production did not finish: ${JSON.stringify(producer.status().log.slice(-8))}`);
  out.produceMs = Date.now() - t0;
  out.encoder = status.encoder;
  const states = [...producer.streams.values()];
  say('produced', { ms: out.produceMs, streams: states.map((s) => ({ kind: s.spec.kind, clipIds: s.spec.clipIds, originFrame: s.spec.originFrame, lastFrame: s.spec.lastFrame })) });

  // Plan: first frame of each stream
  const expectStreams = GROUP
    ? [{ kind: 'group', clipIds: ['clip-b', 'clip-a'], origin: 40, last: 149 }]
    : [{ kind: 'card', clipIds: ['clip-a'], origin: 100, last: 149 }, { kind: 'card', clipIds: ['clip-b'], origin: 40, last: 129 }];
  check(states.length === expectStreams.length, `has ${expectStreams.length} streams`, states.map((s) => `${s.spec.kind}:${s.spec.clipIds.join('+')}`));
  const byClip = new Map();
  for (const m of layerLog) byClip.set(m.clipId, m);
  const layers = [...byClip.values()];
  out.layers = layers.map((l) => ({ clipId: l.clipId, key: l.key.slice(0, 12), ranges: l.ranges, originFrame: l.originFrame ?? null, groupClipIds: l.groupClipIds ?? null }));
  out.streams = [];

  // ---------- 2. Stream generation, frame by frame
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  bakery = await openBakery({ url: emptyUrl });
  for (const want of expectStreams) {
    const state = states.find((s) => s.spec.kind === want.kind && [...s.spec.clipIds].sort().join() === [...want.clipIds].sort().join());
    const tag = `${want.kind}:${want.clipIds.join('+')}`;
    if (!check(!!state, `${tag}: has this stream`)) continue;
    const { spec, manifest } = state;
    const lastSegment = Math.floor((want.last - want.origin) / STREAM_SEGMENT_FRAMES);
    check(spec.originFrame === want.origin && spec.firstFrame === want.origin && spec.lastFrame === want.last && spec.firstSegment === 0 && spec.lastSegment === lastSegment,
      `${tag}: first frame ${want.origin}, last frame ${want.last}, segments 0-${lastSegment}`, { originFrame: spec.originFrame, firstFrame: spec.firstFrame, lastFrame: spec.lastFrame, firstSegment: spec.firstSegment, lastSegment: spec.lastSegment });
    check(want.origin % STREAM_SEGMENT_FRAMES !== 0, `${tag}: the first frame is not a multiple of 15 (which is what this probe needs)`, want.origin);
    check(manifest.originFrame === want.origin, `${tag}: the manifest records this stream's first frame`, manifest.originFrame);
    const layer = byClip.get(spec.topClipId);
    check(!!layer && layer.key === spec.streamKey && layer.originFrame === want.origin && JSON.stringify(layer.ranges) === JSON.stringify([[0, lastSegment]]),
      `${tag}: the ready message carries the first frame, and the ranges cover all segments`, layer && { originFrame: layer.originFrame, ranges: layer.ranges });

    const dir = path.join(OUT, `ref-${want.clipIds.join('+')}`);
    await fs.mkdir(dir, { recursive: true });
    const truth = await exportFrames(bakery, state.isolated, emptyUrl, want.last, dir);
    const record = { tag, streamKey: spec.streamKey, originFrame: spec.originFrame, lastFrame: spec.lastFrame, segments: lastSegment + 1, samples: [], tight: manifest.tight, bound: manifest.bound };
    const got = newError(), floor = newError(), next = newError(), old = newError();
    let frames = 0, wrong = [], minMargin = Infinity, oldCompared = 0;
    for (let n = 0; n <= lastSegment; n++) {
      const seg = manifest.segments[n];
      if (!check(seg?.stride === 1, `${tag}#${n}: full density`, seg)) continue;
      const count = streamSegmentFrameCount(n, want.origin, want.last);
      record.samples.push(seg.samples);
      check(seg.samples === count && (n === lastSegment || count === STREAM_SEGMENT_FRAMES), `${tag}#${n}: sample count = number of frames this segment covers (only the last segment may be short)`, { samples: seg.samples, count });
      const meta = manifest.inits[seg.init];
      const rect = { x: meta.rect.x + spec.offset.x, y: meta.rect.y + spec.offset.y, w: meta.rect.w, h: meta.rect.h };
      const init = await fs.readFile(producer.store.initFile(spec.streamKey, seg.init));
      const bytes = await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file));
      const decoded = await decodeSegment(ffmpeg, init, bytes, dir, `seg-${n}`);
      const frameBytes = rect.w * 2 * (rect.h + 8) * 3;
      if (!check(decoded.length === seg.samples * frameBytes, `${tag}#${n}: decoded ${seg.samples} frames`, decoded.length / frameBytes)) continue;
      // Reference baseline: same real frames cropped to same rectangle, passed through same encoder as is
      const first = streamSegmentFirstFrame(n, want.origin);
      const plain = openStreamSegmentEncoder(ffmpeg, { encoder: status.encoder, fps: FPS, raw: { width: rect.w, height: rect.h } });
      for (let k = 0; k < count; k++) await plain.write(cropRgba(truth.rgba(first + k), WIDTH, rect));
      const plainParts = splitFmp4((await plain.finish()).bytes);
      const plainDecoded = await decodeSegment(ffmpeg, plainParts.init, plainParts.segments[0], dir, `plain-${n}`);
      for (let k = 0; k < count; k++) {
        const f = first + k;
        const picture = decoded.subarray(k * frameBytes, (k + 1) * frameBytes);
        // Which frame this frame is most similar to: itself, two frames before, and two frames after
        const scores = [];
        for (let c = f - 2; c <= f + 2; c++) if (c >= 0 && c <= want.last) scores.push([c, decodedDiff(picture, rect, truth.rgba(c))]);
        scores.sort((x, y) => x[1] - y[1]);
        if (scores[0][0] !== f) wrong.push({ frame: f, segment: n, sample: k, best: scores[0][0], scores: scores.map(([c, d]) => [c, round2(d)]) });
        else if (scores[1]) minMargin = Math.min(minMargin, scores[1][1] / Math.max(scores[0][1], 1e-6));
        tallyDecodedDirect(got, picture, rect, truth.rgba(f), WIDTH);
        tallyDecodedDirect(floor, plainDecoded.subarray(k * frameBytes, (k + 1) * frameBytes), rect, truth.rgba(f), WIDTH);
        tallyDecodedDirect(next, picture, rect, truth.rgba(f < want.last ? f + 1 : f - 1), WIDTH);
        // Previous behavior: sample k of segment n is project frame n × 15 + k
        const legacy = n * STREAM_SEGMENT_FRAMES + k;
        if (legacy <= want.last) { tallyDecodedDirect(old, picture, rect, truth.rgba(legacy), WIDTH); oldCompared++; }
        frames++;
        if (f === want.origin + 7) {
          await savePreview(path.join(OUT, 'previews', `${want.clipIds.join('+')}-truth-${f}.png`), cropRgba(truth.rgba(f), WIDTH, rect), rect.w, rect.h);
        }
      }
    }
    record.frames = frames;
    record.error = { vsItsOwnFrame: errorSummary(got), referenceSamePictureThroughEncoderAsIs: errorSummary(floor), controlNextFrame: errorSummary(next), controlFrameByProjectFrameNumber: { ...errorSummary(old), frames: oldCompared } };
    record.wrongFrames = wrong.slice(0, 6);
    record.minMargin = Number.isFinite(minMargin) ? round2(minMargin) : null;
    out.streams.push(record);
    say('produce-compare', { tag, frames, wrong: wrong.length, minMargin: record.minMargin, ...record.error });
    const g = record.error.vsItsOwnFrame, ref = record.error.referenceSamePictureThroughEncoderAsIs, nx = record.error.controlNextFrame, od = record.error.controlFrameByProjectFrameNumber;
    check(frames === want.last - want.origin + 1, `${tag}: every frame from frame ${want.origin} to frame ${want.last} was compared`, frames);
    check(wrong.length === 0, `${tag}: frame-by-frame stream production, each sample is most similar to the frame it should be (frame originFrame + n × 15 + k)`, { wrong: wrong.length, first: wrong.slice(0, 3) });
    check(g.mean <= ref.mean + 0.5 && g.bad <= ref.bad * 1.25 + g.pixels * 0.001, `${tag}: the difference from its own frame is within encoding error`, { got: g, ref });
    // After encoding, text edges of this card already have many pixels differing > 16 (just as many
    // in reference row), so "significantly larger" mainly looks at average difference, only requiring
    // bad pixel count to double
    check(nx.mean > 3 * g.mean && nx.bad > 2 * (g.bad + 1), `${tag}: the control (next frame) is clearly larger`, { got: g, next: nx });
    check(oldCompared > 0 && od.mean > 3 * g.mean && od.bad > 2 * (g.bad + 1), `${tag}: the control (the frame that would match if segments were counted by project frame number) is clearly larger`, { got: g, old: od });
    if (!KEEP) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  // ---------- 3. Stage stream paste, frame by frame
  const refDir = path.join(OUT, 'ref-project');
  await fs.mkdir(refDir, { recursive: true });
  const exported = await exportFrames(bakery, PROJECT, emptyUrl, LAST + 1, refDir);
  const exportRgb = new Map();
  const exportOf = (f) => { if (!exportRgb.has(f)) { exportRgb.set(f, rgbOver(exported.png(f))); if (exportRgb.size > 16) exportRgb.delete(exportRgb.keys().next().value); } return exportRgb.get(f); };

  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  if (!ports.ok || !Array.isArray(ports.ports) || ports.ports.length < 2) throw new Error(`Stage ports did not come up: ${JSON.stringify(ports)}`);
  const u = new URL(origin);
  const [originA, originB] = ports.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
  const HOST_PATH = '/__stream-origin-probe-host';
  hostServer = await serve(HOST_PORT, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === HOST_PATH) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(hostHtml(originA, originB)); return; }
    if (url.pathname.startsWith('/api/frames/') && handleStreamRequest(producer.store, req, res, url.pathname.slice('/api/frames'.length))) return;
    res.statusCode = 404; res.end();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  await page.goto(base + HOST_PATH);
  await page.waitForFunction(() => window.__ready, { timeout: 120000 });
  await page.evaluate(() => window.__ready);
  const frameA = () => page.frames().find((f) => f.url().startsWith(originA));
  const frameB = () => page.frames().find((f) => f.url().startsWith(originB));
  for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base);
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const rpcB = (method, ...a) => page.evaluate((m, a2) => window.__rpcB[m](...a2), method, a);
  const diagA = () => frameA().evaluate(() => window.__pcStageDiag());
  await rpc('setProject', PROJECT, { reset: true });
  await rpcB('setProject', PROJECT, { reset: true });
  await rpc('setRole', 'front');
  await rpcB('setRole', 'back', { job: 'probe' });

  // Parent page side: cards with streams are suppressed; stream plane is composited via product's
  // `streamPlanesFor` from ready messages (each layer converted by its own first frame)
  const heavy = [...new Set(layers.flatMap((l) => (l.groupClipIds?.length ? l.groupClipIds : [l.clipId])))];
  const planesAt = (f) => streamPlanesFor(layers, new Set(heavy), f);
  await rpc('setTime', FIRST / FPS);
  await rpc('setPlaying', true);
  await rpc('setSuppressed', heavy);
  const iframeBox = await (await page.$('#a')).boundingBox();
  const shotStage = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } });
    return page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } });
  };
  /**
   * Set time to frame f, wait for each present stream to draw this frame. Following parent page's
   * behavior: send stream plane first, then suppress cards pasting streams on this frame, then set time.
   */
  const seekTo = async (f) => {
    const planes = planesAt(f);
    await rpc('setStreamPlanes', planes);
    await rpc('setSuppressed', [...new Set(planes.flatMap((p) => p.clipIds))]);
    const got = await frameA().evaluate(async (frame, fps, want) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const t0 = now();
      await window.__pcStage.setTime(frame / fps + 1e-4);
      for (;;) {
        const d = window.__pcStageDiag();
        const tracks = d.streams.tracks;
        /*
         * Stream frames are decoded asynchronously; while paused there is no next tick. The moment it
         * draws, the stage recalculates placeholders on its own (`StreamPlayer`'s `onShowingChange`),
         * without parent page sending another message: here we **do not resend** stream plane; when drawn,
         * return "cards currently displaying placeholders" along with it, and assert below that it is empty.
         * (Previously without resending, 7 out of 110 frames captured placeholders.)
         */
        if (tracks.length === want && tracks.every((t) => t.lastDrawn === frame)) {
          await wait(0);
          return { ms: +(now() - t0).toFixed(1), drawn: tracks.map((t) => t.lastDrawn), errors: tracks.map((t) => t.errors), placeholders: window.__pcStageDiag().placeholders };
        }
        if (now() - t0 > 8000) return { ms: null, drawn: tracks.map((t) => t.lastDrawn), errors: tracks.map((t) => t.lastError), tracks: tracks.length };
        await wait(2);
      }
    }, f, FPS, planes.length);
    return { planes, got };
  };
  const scrub = { frames: 0, wrong: [], notDrawn: [], retried: [], placeholders: [], minMargin: Infinity, seekMs: [], same: { mean: 0, bad: 0 }, next: { mean: 0, bad: 0 } };
  const toPng = (img) => { const png = new PNG({ width: img.width, height: img.height }); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) { png.data[i] = img.rgb[j]; png.data[i + 1] = img.rgb[j + 1]; png.data[i + 2] = img.rgb[j + 2]; png.data[i + 3] = 255; } return PNG.sync.write(png); };
  const scoreStage = (stage, f) => { const scores = [f - 1, f, f + 1].map((c) => [c, rgbDiff(stage, exportOf(c))]); return { scores, best: [...scores].sort((x, y) => x[1].mean - y[1].mean)[0][0] }; };
  // Scrubbing order: going sequentially first is too much like "continuous playback"; here we jump
  // out of order (every step jumps frames, often jumps segments, with backwards jumps)
  const order = [];
  for (let f = FIRST; f <= LAST; f++) order.push(f);
  for (let i = 0; i < order.length; i++) { const j = (i * 37 + 11) % order.length; [order[i], order[j]] = [order[j], order[i]]; }
  for (const f of order) {
    const { planes, got } = await seekTo(f);
    const expectPlanes = (GROUP ? 1 : (f >= 100 ? 1 : 0) + (f <= 129 ? 1 : 0));
    if (planes.length !== expectPlanes) { scrub.wrong.push({ frame: f, planes: planes.length, expectPlanes }); continue; }
    if (got.ms === null) { scrub.notDrawn.push({ frame: f, ...got }); continue; }
    scrub.seekMs.push(got.ms);
    if (got.placeholders?.length) scrub.placeholders.push({ frame: f, placeholders: got.placeholders });
    let stage = rgbOver(await shotStage());
    let { scores, best } = scoreStage(stage, f);
    if (best !== f || scores[1][1].mean >= 3) {
      /*
       * This frame did not match. Save it first, then distinguish whether "the stage had not finished
       * compositing at screenshot time" (stream status already claims this frame is drawn; waiting a moment
       * and capturing again as is matches) or "what was pasted is simply not this frame" (capturing again
       * or resetting time and capturing again still fails). Record the former into `retried` and report
       * truthfully; only the latter counts as failing this check.
       */
      await fs.writeFile(path.join(OUT, `stage-mismatch-${f}${GROUP ? '-group' : ''}.png`), toPng(stage));
      const first = { best, scores: scores.map(([c, d]) => [c, round2(d.mean), d.bad]), tracks: (await diagA()).streams.tracks.map((t) => ({ id: t.id.slice(0, 14), lastDrawn: t.lastDrawn, held: t.held })) };
      await sleep(400);
      stage = rgbOver(await shotStage());
      ({ scores, best } = scoreStage(stage, f));
      let how = 'reshoot';
      if (best !== f || scores[1][1].mean >= 3) { how = 'reseek'; await seekTo(f); await sleep(200); stage = rgbOver(await shotStage()); ({ scores, best } = scoreStage(stage, f)); }
      scrub.retried.push({ frame: f, first, fixedBy: best === f && scores[1][1].mean < 3 ? how : null });
    }
    const same = scores[1][1], other = scores[2][1];
    if (best !== f) scrub.wrong.push({ frame: f, best, scores: scores.map(([c, d]) => [c, round2(d.mean), d.bad]) });
    else scrub.minMargin = Math.min(scrub.minMargin, Math.min(scores[0][1].mean, scores[2][1].mean) / Math.max(same.mean, 1e-6));
    scrub.same.mean += same.mean; scrub.same.bad += same.bad; scrub.next.mean += other.mean; scrub.next.bad += other.bad;
    scrub.frames++;
    if (f === 105 || f === 47) {
      await fs.writeFile(path.join(OUT, `stage-scrub-${f}${GROUP ? '-group' : ''}.png`), toPng(stage));
      await fs.writeFile(path.join(OUT, `export-${f}.png`), toPng(exportOf(f)));
    }
  }
  const n = Math.max(1, scrub.frames);
  out.scrub = { frames: scrub.frames, wrong: scrub.wrong.slice(0, 6), wrongCount: scrub.wrong.length, notDrawn: scrub.notDrawn.slice(0, 6), notDrawnCount: scrub.notDrawn.length,
    retried: scrub.retried, retriedCount: scrub.retried.length,
    placeholdersLeft: scrub.placeholders.slice(0, 6), placeholdersLeftCount: scrub.placeholders.length,
    seekMsMax: scrub.seekMs.length ? Math.max(...scrub.seekMs) : null,
    minMargin: Number.isFinite(scrub.minMargin) ? round2(scrub.minMargin) : null,
    seekMsMedian: scrub.seekMs.length ? [...scrub.seekMs].sort((a, b) => a - b)[scrub.seekMs.length >> 1] : null,
    vsExportSameFrame: { mean: round2(scrub.same.mean / n), bad: Math.round(scrub.same.bad / n) }, controlExportNextFrame: { mean: round2(scrub.next.mean / n), bad: Math.round(scrub.next.bad / n) } };
  say('scrub', out.scrub);
  check(scrub.notDrawn.length === 0, 'drag: for every frame the stream plane drew that frame', out.scrub.notDrawn);
  check(scrub.placeholders.length === 0, 'drag: at the moment the stream\'s frame is drawn, the placeholder has already removed itself (the parent page sent no extra message)', out.scrub.placeholdersLeft);
  check(scrub.retried.length === 0, 'drag: no frame needed a re-capture to match', scrub.retried.slice(0, 3));
  check(scrub.frames === LAST - FIRST + 1, `drag: all frames ${FIRST}-${LAST} were compared`, scrub.frames);
  check(scrub.wrong.length === 0, 'frame-by-frame drag, the picture pasted on the stage is most similar to the same frame of the export page (not the previous or next frame)', { wrong: scrub.wrong.length, first: scrub.wrong.slice(0, 3) });
  check(out.scrub.vsExportSameFrame.mean < 3, 'drag: mean difference between the stage (stream paste) and the same export frame < 3/255', out.scrub.vsExportSameFrame);
  check(out.scrub.controlExportNextFrame.bad > 5 * (out.scrub.vsExportSameFrame.bad + 1), 'drag: the control (the next export frame) is clearly larger', out.scrub);

  // Earlier than the stream's first frame: no segments, stream plane draws nothing
  {
    const early = [];
    for (const f of [0, 25, 39]) {
      const planes = planesAt(f);
      await rpc('setStreamPlanes', planes);
      await rpc('setTime', f / FPS + 1e-4);
      await sleep(150);
      const d = await diagA();
      early.push({ frame: f, planes: planes.length, drawn: d.streams.tracks.map((t) => t.lastDrawn) });
    }
    // Parent page does not send (no ready segments in this span); even if the whole stream plane
    // is forced, the stage cannot draw it
    const forced = layers.map((l) => ({ clipIds: l.groupClipIds?.length ? l.groupClipIds : [l.clipId], key: l.key, ranges: l.ranges, originFrame: l.originFrame }));
    await rpc('setStreamPlanes', forced);
    await rpc('setTime', 39 / FPS + 1e-4);
    await sleep(300);
    const d = await diagA();
    out.early = { byParent: early, forcedAt39: d.streams.tracks.map((t) => ({ id: t.id.slice(0, 14), lastDrawn: t.lastDrawn })) };
    check(early.every((e) => e.planes === 0), 'before the first frame: the parent page produces no stream plane', early);
    check(d.streams.tracks.every((t) => t.lastDrawn === null), 'before the first frame: even if a stream plane is forced in, the stage draws nothing (there is no such segment)', out.early.forcedAt39);
  }

  // ---------- 4. Real playback: start playback before clip-a enters (frame 95), play past its
  // first two segments, pause
  {
    const forced = layers.map((l) => ({ clipIds: l.groupClipIds?.length ? l.groupClipIds : [l.clipId], key: l.key, ranges: l.ranges, originFrame: l.originFrame }));
    await rpc('setTime', 95 / FPS + 1e-4);
    await rpc('setStreamPlanes', forced);
    await rpc('setSuppressed', heavy);
    await page.evaluate(() => { window.__frames = []; });
    await rpc('play', 95 / FPS + 1e-4);
    await sleep(900);
    const stop = await rpc('pause');
    const frames = await page.evaluate(() => window.__frames);
    const steps = frames.slice(1).map((f, i) => +(f.sec - frames[i].sec).toFixed(6));
    const stopped = Math.round(stop.stoppedAt * FPS);
    await sleep(120);
    const d = await diagA();
    const stage = rgbOver(await shotStage());
    const scores = [stopped - 1, stopped, stopped + 1].map((c) => [c, rgbDiff(stage, exportOf(Math.min(c, LAST + 1)))]);
    const best = [...scores].sort((x, y) => x[1].mean - y[1].mean)[0][0];
    out.play = { from: 95, stoppedAt: stopped, beats: frames.length, noSkip: steps.every((s) => Math.abs(s - 1 / FPS) < 1e-6),
      tracks: d.streams.tracks.map((t) => ({ id: t.id.slice(0, 14), lastDrawn: t.lastDrawn, drawn: t.drawn, errors: t.errors, seeks: t.seeks })),
      scores: scores.map(([c, x]) => [c, round2(x.mean), x.bad]), best };
    say('play', out.play);
    check(out.play.noSkip && frames.length > 5, 'playback: no frame skipping (the sec difference between frames is always 1/fps)', { beats: frames.length, steps: [...new Set(steps)] });
    check(stopped > 100 && stopped <= LAST, 'playback: reached clip-a (after frame 100)', stopped);
    check(d.streams.tracks.length > 0 && d.streams.tracks.every((t) => t.errors === 0 && t.drawn > 3), 'playback: the stream plane kept drawing all the way, and the decoder reported no errors', out.play.tracks);
    check(d.streams.tracks.every((t) => t.lastDrawn === stopped || t.lastDrawn === null), 'playback: when paused, the stream plane stops on the paused frame', out.play.tracks);
    check(best === stopped && scores[1][1].mean < 3, 'playback: at the paused frame, the stage (stream paste) is most similar to the same frame of the export page', out.play.scores);
  }
  await rpc('setRole', 'back', { job: 'probe' });
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); } catch { /* ignore */ }
  try { await pipeline?.close(); } catch { /* ignore */ }
  try { await bakery?.close(); } catch { /* ignore */ }
  dropStreamEncoderSpares();
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (!/\.(json|png)$/.test(name) && name !== 'previews') await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
