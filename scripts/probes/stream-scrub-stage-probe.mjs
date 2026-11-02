/**
 * Heavy cards paste track streams during pause and scrub: probe on the **stage side** (task brief
 * "Ji-3"; semantics `mechanism/rendering.md` "Fallback order"). Test page acts as parent page,
 * sending messages the way product's parent page does (send stream planes first, then suppression,
 * then set time; stream planes synthesized with product's `streamPlanesFor`). The parent-page side
 * (which cards paste streams, when to send) end-to-end is in `scrub-stream-probe.mjs` (real editor).
 *
 *   node scripts/probes/stream-scrub-stage-probe.mjs (--origin http://127.0.0.1:26940 | --port 26940) [--host-port 26950]
 *        [--size 1280x720] [--out <dir>] [--json <file>] [--keep]
 *   node scripts/probes/stream-scrub-stage-probe.mjs --port 26940 --timing particles --size 1920x1080   # Measure random jump elapsed time only
 *
 * `--timing <card id>`: only runs the half of C measuring elapsed time. Project is replaced with
 * one such card filling the whole frame (canvas card streams are full-frame, decoding a frame is
 * much more expensive than those two small cards), does not compare pixels, does not run the other
 * checks; used to measure "worst-case time to randomly jump to a frame".
 *
 * If `--port` is given, starts a dev server at checkout root itself (occupying +1 and +2 as stage
 * ports), torn down by process ID after use. Directly starts `FramePipeline` in this process (same
 * code as prerender process), with store root in a temporary directory. Project is same as
 * `stream-origin-probe.mjs`: two cards moving horizontally by 10 pixels per frame, **neither starting
 * at a frame multiple of 15** (clip-b frames 40-129, clip-a frames 100-149).
 *
 * Check item by item (the reference is always the full-frame image of the same frame on export
 * page; each card compares its own strip, and the closest match must be the frame it should be):
 *
 *   A. **Sparse version only** (first only produce the sparse pass): set time to each frame while
 *      paused; what is pasted is the nearest image no later than this frame (only looks back, does
 *      not take later ones). How dense the sparse version is is read from manifest, not hardcoded.
 *   B. **Stopped on a sparse segment, auto-swaps after full-density version is produced**: parent page
 *      sends not a single message.
 *   C. **Full density, random frame jumping**: jump in shuffled order while paused; each frame
 *      pasted is exactly this frame; measure time from requesting this frame to drawing (first time
 *      needs to fetch bytes, repeating does not), worst case is jumping to the last frame of a
 *      segment (decodes 15 frames from keyframe). Elapsed time is recorded only.
 *   D. **This frame fails to decode for a long time** (segment bytes held back): keep previous image,
 *      clear and replace with placeholder after about one segment duration; after bytes arrive,
 *      **the frame draws itself and the placeholder removes itself**, parent page sends not a
 *      single message.
 *   E. **Decoded ahead of time while paused**: after stopping and removing suppression, stream plane
 *      is hidden and live image is visible, and this frame is already decoded; press play, and the
 *      very first tick is the stream image (no empty ticks in tick-by-tick records). Not decoded
 *      ahead of time (stream plane just arrived): do not hide card's original image before first
 *      stream frame is drawn; if it keeps failing to decode, only hide on timeout and replace with
 *      placeholder.
 *   F. **Fast scrubbing** (one step every 16 ms, does not wait for drawing): does not reset decoder
 *      on every step; after stopping, the last frame is drawn.
 *   G. **Pause during playback**: the frame where playback stops pastes this exact frame.
 *
 * Outputs JSON conclusion, writes progress to stderr; exits non-zero if any check fails. Elapsed
 * time is recorded only.
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
import { handleStreamRequest } from '../../server/frame-stream.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { startDevServer, emptyUrlOf, sleep, round2 } from './below-stream-common.mjs';
import { streamPlanesFor } from '../../src/render/streamPlayer.ts';
import { STREAM_SEGMENT_FRAMES, streamSegmentFirstFrame, streamSegmentOf } from '../../src/render/streamSegments.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const HOST_PORT = Number(flagArg('host-port', '0', args)) || 0;
const KEEP = args.includes('--keep');
const TIMING = flagArg('timing', null, args);
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-scrub-stage-${Date.now().toString(36)}`));
const [WIDTH, HEIGHT] = String(flagArg('size', '1280x720', args)).split('x').map(Number);
process.env.PROMPTCUT_STREAM_POOL = '1';
if (!ORIGIN && !PORT) { console.error('Pass --origin <dev server> or --port <start your own>'); process.exit(2); }
if (!(WIDTH > 0 && HEIGHT > 0)) { console.error('--size must be written like 1280x720'); process.exit(2); }

const FPS = 30, DURATION = 6, SEG = STREAM_SEGMENT_FRAMES;
const K = HEIGHT / 720;
const band = (y, h) => ({ x: 0, y: Math.round(y * K), w: WIDTH, h: Math.round(h * K) });
/**
 * Frames of the two cards on the timeline (closed interval). In points and out points are written in
 * seconds, falling between two frames (frame numbers divided by 30 are mostly not finite decimals;
 * converting directly to seconds would be off by one frame).
 */
const CLIPS = {
  'clip-b': { frames: [40, 129], start: 1.32, end: 4.32, frame: band(380, 300) },
  'clip-a': { frames: [100, 149], start: 3.32, end: 4.99, frame: band(40, 300) },
};
if (TIMING) {
  delete CLIPS['clip-a'];
  CLIPS['clip-b'].frame = { x: 0, y: 0, w: WIDTH, h: HEIGHT };
}
const TIMING_PARAMS = { particles: { color: '#30ff60', quantity: 120, links: 'yes', seed: 5 } };
const PROJECT = TIMING ? {
  id: 'stream-scrub-stage-probe-timing', name: 'Random frame-jump timing', width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [{ id: 'tr-b', name: 'b', hidden: false, clips: [{ id: 'clip-b', kind: 'card', cardId: TIMING, start: CLIPS['clip-b'].start, end: CLIPS['clip-b'].end, params: TIMING_PARAMS[TIMING] ?? {}, frame: CLIPS['clip-b'].frame }] }],
} : {
  id: 'stream-scrub-stage-probe', name: 'Pause and scrub stream display probe', width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-a', name: 'a', hidden: false, clips: [{ id: 'clip-a', kind: 'card', cardId: 'r6-stateful', start: CLIPS['clip-a'].start, end: CLIPS['clip-a'].end, params: {}, frame: CLIPS['clip-a'].frame }] },
    { id: 'tr-b', name: 'b', hidden: false, clips: [{ id: 'clip-b', kind: 'card', cardId: 'r6-stateful', start: CLIPS['clip-b'].start, end: CLIPS['clip-b'].end, params: {}, frame: CLIPS['clip-b'].frame }] },
  ],
};
const FIRST = 40, LAST = TIMING ? 129 : 149;
const clipsAt = (f) => Object.keys(CLIPS).filter((id) => CLIPS[id].frames[0] <= f && f <= CLIPS[id].frames[1]);

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 900))); say('FAIL', { label, extra }); } return !!cond; };
async function until(label, fn, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); say('TIMEOUT', { label }); return null; }
    await sleep(everyMs);
  }
}
const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[list.length >> 1] : null);
const stats = (list) => (list.length ? { n: list.length, median: median(list), max: Math.max(...list), min: Math.min(...list) } : { n: 0 });

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
/** Difference between two RGB images within a horizontal strip (this card's box): average difference, and pixel count with difference exceeding 48 */
function bandDiff(a, b, rect) {
  if (a.width !== b.width || a.height !== b.height) return { mean: Infinity, bad: Infinity };
  let sum = 0, bad = 0, n = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let i = (y * a.width + rect.x) * 3, end = i + rect.w * 3; i < end; i += 3) {
      const d0 = Math.abs(a.rgb[i] - b.rgb[i]), d1 = Math.abs(a.rgb[i + 1] - b.rgb[i + 1]), d2 = Math.abs(a.rgb[i + 2] - b.rgb[i + 2]);
      sum += d0 + d1 + d2; n += 3;
      if (d0 > 48 || d1 > 48 || d2 > 48) bad++;
    }
  }
  return { mean: sum / Math.max(1, n), bad };
}
const toPng = (img) => { const png = new PNG({ width: img.width, height: img.height }); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) { png.data[i] = img.rgb[j]; png.data[i + 1] = img.rgb[j + 1]; png.data[i + 2] = img.rgb[j + 2]; png.data[i + 3] = 255; } return PNG.sync.write(png); };

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>stream scrub stage probe host</title></head>
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
  for (const m of ['setProject', 'setTime', 'setRole', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setPlaying', 'setScrubbing']) c[m] = call(m);
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

const out = { out: OUT, project: { width: WIDTH, height: HEIGHT, fps: FPS, clips: Object.fromEntries(Object.entries(CLIPS).map(([id, c]) => [id, c.frames])) } };
await fs.mkdir(OUT, { recursive: true });
let dev = null, bakery = null, pipeline = null, browser = null, hostServer = null;
const started = Date.now();
try {
  let origin = ORIGIN;
  if (!origin) { dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'scrubstage' }); origin = dev.origin; say('spawn', { pid: dev.pid, port: PORT }); }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;

  /* ------------------------------------------------------------ Stream generation: first only produce the sparse pass */
  pipeline = new FramePipeline({ root: path.join(OUT, 'library'), origin: () => origin, interactive: true, playhead: () => null });
  pipeline.streamPicked = () => true; // Pin as heavy cards
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  let holdDense = !TIMING;
  const nextTask = producer.nextTask.bind(producer);
  producer.nextTask = (b) => { const task = nextTask(b); return task && task.stride === 1 && holdDense ? null : task; };
  const layerByClip = new Map();
  pipeline.readyIndex.subscribe((message) => { if (message.type === 'layer' && message.kind === 'stream') layerByClip.set(message.clipId, message); });
  const t0 = Date.now();
  await pipeline.preload(PROJECT);
  const idle = () => !producer.workers.size && !producer.encoding.size;
  const stateOf = (clipId) => [...producer.streams.values()].find((s) => s.spec.clipIds.length === 1 && s.spec.clipIds[0] === clipId) ?? null;
  const segmentsOf = (clipId) => { const s = stateOf(clipId); return s ? Array.from({ length: s.spec.lastSegment + 1 }, (_, n) => s.manifest.segments[n]?.stride ?? 0) : []; };
  await until(TIMING ? 'All stream segments at full density' : 'Sparse versions of both streams cover all segments', () => {
    if (producer.streams.size < Object.keys(CLIPS).length || !idle()) return null;
    if (TIMING) return Object.keys(CLIPS).every((id) => { const st = segmentsOf(id); return st.length && st.every((s) => s === 1); }) ? true : null;
    return Object.keys(CLIPS).every((id) => { const st = segmentsOf(id); return st.length && st.every((s) => s >= 1); }) ? true : null;
  }, 600_000, 300);
  out.sparseMs = Date.now() - t0;
  out.sparse = Object.fromEntries(Object.keys(CLIPS).map((id) => [id, { originFrame: stateOf(id)?.spec.originFrame, strides: segmentsOf(id) }]));
  say('sparse-ready', { ms: out.sparseMs, ...out.sparse });
  const sparseStrides = Object.values(out.sparse).flatMap((s) => s.strides);
  if (!TIMING && !check(sparseStrides.length > 0 && sparseStrides.every((s) => s > 1), 'Sparse version only at first (every segment\'s stride is greater than 1)', out.sparse)) throw new Error('Did not reach a state with only the sparse version');
  if (TIMING) { const st = stateOf('clip-b'); out.timingStream = { card: TIMING, bound: st?.manifest.bound, tight: st?.manifest.tight, inits: Object.values(st?.manifest.inits ?? {}).map((i) => ({ width: i.width, height: i.height })) }; say('timing-stream', out.timingStream); }
  const layers = () => [...layerByClip.values()];
  /** Which image this card pastes at frame f: full density is itself; sparse is the nearest image no later than it (interval is read from manifest) */
  const pictureOf = (clipId, f) => {
    const state = stateOf(clipId);
    const o = state.spec.originFrame;
    const n = streamSegmentOf(f, o);
    const stride = state.manifest.segments[n]?.stride ?? 1;
    const start = streamSegmentFirstFrame(n, o);
    return stride > 1 && SEG % stride === 0 ? start + Math.floor((f - start) / stride) * stride : f;
  };

  /* ------------------------------------------------------------ Reference: export page frame by frame */
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  const exported = new Map();
  if (!TIMING) {
    bakery = await openBakery({ url: emptyUrl });
    await bakery.reset(PROJECT, emptyUrl);
    bakery.streamLease = null;
    const refDir = path.join(OUT, 'ref-project');
    await fs.mkdir(refDir, { recursive: true });
    await bakeFrames(bakery, { out: refDir, fps: FPS, frames: `0-${LAST + 1}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
      onFrame: async (i, buf) => { exported.set(i, Buffer.from(buf)); } });
  }
  const exportRgb = new Map();
  const exportOf = (f) => { if (!exportRgb.has(f)) { exportRgb.set(f, rgbOver(exported.get(f))); if (exportRgb.size > 24) exportRgb.delete(exportRgb.keys().next().value); } return exportRgb.get(f); };
  say('exported', { frames: exported.size });

  /* ------------------------------------------------------------ Stage */
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  if (!ports.ok || !Array.isArray(ports.ports) || ports.ports.length < 2) throw new Error(`Stage ports did not come up: ${JSON.stringify(ports)}`);
  const u = new URL(origin);
  const [originA, originB] = ports.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
  const HOST_PATH = '/__stream-scrub-stage-probe-host';
  /** Held-back segment requests: segment bytes whose URLs start with `/slow<n>/` are suspended when `slow.hold` is true and released together on `slow.release()`; `slow.delayMs` is a fixed extra wait */
  const slow = { hold: false, delayMs: 0, waiting: [], asked: 0, release() { const w = this.waiting; this.waiting = []; this.hold = false; for (const go of w) go(); } };
  hostServer = await serve(HOST_PORT, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === HOST_PATH) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(hostHtml(originA, originB)); return; }
    const m = /^\/(?:(slow|cold)\d*\/)?api\/frames(\/.*)$/.exec(url.pathname);
    if (!m) { res.statusCode = 404; res.end(); return; }
    const go = () => { if (!handleStreamRequest(producer.store, req, res, m[2])) { res.statusCode = 404; res.end(); } };
    if (m[1] === 'slow' && /\/seg\//.test(m[2])) {
      slow.asked++;
      if (slow.hold) { slow.waiting.push(go); return; }
      if (slow.delayMs > 0) { setTimeout(go, slow.delayMs); return; }
    }
    go();
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
  const setBase = async (prefix = '') => { for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base + prefix); };
  await setBase();
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const rpcB = (method, ...a) => page.evaluate((m, a2) => window.__rpcB[m](...a2), method, a);
  const diagA = () => frameA().evaluate(() => {
    const d = window.__pcStageDiag();
    return { t: d.t, suppressed: d.suppressed, parentSuppressed: d.parentSuppressed, streamWaiting: d.streamWaiting, settling: d.settling, placeholders: d.placeholders, snapshots: d.snapshots,
      planes: d.streamPlanes.map((p) => p.clipIds.join(',')),
      tracks: d.streams.tracks.map((t) => ({ id: t.id.split('#')[0], lastDrawn: t.lastDrawn, picture: t.picture, want: t.want, level: t.level, stale: t.stale, seeks: t.seeks, deferred: t.deferred, decoded: t.decoded,
        standIns: t.standIns, errors: t.errors, lastError: t.lastError, lastSeek: t.lastSeek, seekMaxMs: t.seekMaxMs, held: t.held })) };
  });
  /** What each card's wrapper layer looks like right now: class names, whether stream plane canvas is visible */
  const domA = () => frameA().evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-pc-clip]:not([data-pc-media])')].map((el) => {
    const canvas = el.querySelector(':scope > canvas[data-pc-stream-plane]');
    return [el.getAttribute('data-pc-clip'), { cls: el.className, canvas: canvas ? getComputedStyle(canvas).display : null }];
  })));
  await rpc('setProject', PROJECT, { reset: true });
  await rpcB('setProject', PROJECT, { reset: true });
  await rpc('setRole', 'front');
  await rpcB('setRole', 'back', { job: 'probe' });
  await rpc('setTime', FIRST / FPS);
  const iframeBox = await (await page.$('#a')).boundingBox();
  const shotStage = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } });
    return rgbOver(await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } }));
  };
  const planesAt = (f) => streamPlanesFor(layers(), new Set(Object.keys(CLIPS)), f);
  const membersOf = (planes) => [...new Set(planes.flatMap((p) => p.clipIds))].sort();
  /**
   * Set time to frame f following parent page practice: send stream planes first, then
   * suppression, then set time. Then **send no further messages**, wait in the stage for each stream
   * to draw the image it should draw (`want`: clipId → frame number), and return milliseconds from
   * setting time to drawing, plus the placeholder displayed at that moment.
   */
  const seekTo = async (f, { settle = false } = {}) => {
    const planes = planesAt(f);
    const want = Object.fromEntries(membersOf(planes).map((id) => [id, pictureOf(id, f)]));
    await rpc('setStreamPlanes', planes);
    await rpc('setSuppressed', membersOf(planes));
    const got = await frameA().evaluate(async (frame, fps, want, settle) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const t0 = now();
      await window.__pcStage.setTime(frame / fps + 1e-4, settle ? { settle: true } : {});
      const ids = Object.keys(want);
      for (;;) {
        const d = window.__pcStageDiag();
        const tracks = d.streams.tracks;
        const of = (id) => tracks.find((t) => t.id.split('#')[0] === id);
        if (ids.every((id) => of(id) && of(id).picture === want[id] && !of(id).stale)) {
          const ms = +(now() - t0).toFixed(1);
          await wait(0);
          const after = window.__pcStageDiag();
          return { ms, placeholders: after.placeholders, levels: Object.fromEntries(ids.map((id) => [id, of(id).level])), waiting: after.streamWaiting,
            standIns: Object.fromEntries(ids.map((id) => [id, of(id).standIns])) };
        }
        if (now() - t0 > 8000) return { ms: null, tracks: tracks.map((t) => ({ id: t.id.split('#')[0], lastDrawn: t.lastDrawn, picture: t.picture, stale: t.stale, err: t.lastError })) };
        await wait(2);
      }
    }, f, FPS, want, settle);
    return { planes, want, got };
  };
  /** In stage screenshots, which export page frame each card's strip is closest to (`candidates`: clipId → candidate frames) */
  const scoreBands = (stage, candidates) => Object.fromEntries(Object.entries(candidates).map(([id, list]) => {
    const scores = [...new Set(list)].filter((c) => c >= 0 && c <= LAST + 1).map((c) => [c, bandDiff(stage, exportOf(c), CLIPS[id].frame)]);
    const sorted = [...scores].sort((x, y) => x[1].mean - y[1].mean);
    return [id, { best: sorted[0][0], mean: round2(sorted[0][1].mean), bad: sorted[0][1].bad, runnerUp: sorted[1] ? round2(sorted[1][1].mean) : null, scores: scores.map(([c, d]) => [c, round2(d.mean)]) }];
  }));
  const shuffled = (from, to) => { const order = []; for (let f = from; f <= to; f++) order.push(f); for (let i = 0; i < order.length; i++) { const j = (i * 37 + 11) % order.length; [order[i], order[j]] = [order[j], order[i]]; } return order; };

  /* ------------------------------------------------------------ A. Sparse version only */
  if (!TIMING) {
    const rec = { frames: 0, wrong: [], notDrawn: [], later: [], placeholders: [], levels: new Set(), seekMs: [], sameMean: 0, n: 0, standIns: {} };
    for (const f of shuffled(FIRST, LAST)) {
      const { want, got } = await seekTo(f);
      if (got.ms === null) { rec.notDrawn.push({ frame: f, ...got }); continue; }
      rec.seekMs.push(got.ms);
      for (const [id, n] of Object.entries(got.standIns)) rec.standIns[id] = Math.max(rec.standIns[id] ?? 0, n);
      if (got.placeholders.length) rec.placeholders.push({ frame: f, placeholders: got.placeholders });
      for (const level of Object.values(got.levels)) rec.levels.add(level);
      const stage = await shotStage();
      const stride = (id) => { const s = stateOf(id); return s.manifest.segments[streamSegmentOf(f, s.spec.originFrame)].stride; };
      const result = scoreBands(stage, Object.fromEntries(Object.entries(want).map(([id, p]) => [id, [p - stride(id), p - 1, p, p + 1, p + stride(id), f]])));
      for (const [id, r] of Object.entries(result)) {
        if (want[id] > f) rec.later.push({ frame: f, clip: id, picture: want[id] });
        if (r.best !== want[id]) rec.wrong.push({ frame: f, clip: id, want: want[id], ...r });
        rec.sameMean += r.mean; rec.n++;
      }
      rec.frames++;
      if (f === 107 || f === 52) await fs.writeFile(path.join(OUT, `sparse-stage-${f}.png`), toPng(stage));
    }
    out.sparseScrub = { frames: rec.frames, wrongCount: rec.wrong.length, wrong: rec.wrong.slice(0, 5), notDrawn: rec.notDrawn.slice(0, 5), later: rec.later.slice(0, 5), placeholdersLeft: rec.placeholders.slice(0, 5),
      levels: [...rec.levels], seekMs: stats(rec.seekMs), meanDiffToExpectedFrame: round2(rec.sameMean / Math.max(1, rec.n)), standInDrawsBeforeTargetDecoded: rec.standIns };
    say('A-sparse', out.sparseScrub);
    check(rec.notDrawn.length === 0 && rec.frames === LAST - FIRST + 1, `Sparse version only: every frame from ${FIRST} to ${LAST} had a picture shown`, { frames: rec.frames, notDrawn: rec.notDrawn.slice(0, 3) });
    check(rec.wrong.length === 0, 'Sparse version only: each frame shows the nearest picture not later than itself (the most similar to that frame on the export page)', { wrong: rec.wrong.length, first: rec.wrong.slice(0, 3) });
    check(rec.later.length === 0, 'Sparse version only: look backward only, never take a later one', rec.later.slice(0, 3));
    check([...rec.levels].every((l) => l === 'sparse'), 'Sparse version only: the stage reports the sparse level', [...rec.levels]);
    check(rec.placeholders.length === 0, 'Sparse version only: no placeholder is up at the moment the picture is drawn', rec.placeholders.slice(0, 3));
  }

  /* ------------------------------------------------------------ B. Stopped on sparse segment, auto-swaps after full-density version is produced */
  if (!TIMING) {
    // Find a frame: both cards are present, and in the sparse version it is not "its own image"
    let park = null;
    for (let f = 104; f <= 128 && park === null; f++) if (clipsAt(f).every((id) => pictureOf(id, f) !== f)) park = f;
    if (check(park !== null, 'There is a frame for which the sparse version shows a picture other than its own (used to check whether it changes after switching to full density)')) {
      const { want } = await seekTo(park);
      const before = scoreBands(await shotStage(), Object.fromEntries(clipsAt(park).map((id) => [id, [want[id], park]])));
      holdDense = false;
      producer.kick();
      const t1 = Date.now();
      await until('all segments at full density', () => (idle() && Object.keys(CLIPS).every((id) => segmentsOf(id).every((s) => s === 1)) ? true : null), 900_000, 500);
      out.denseMs = Date.now() - t1;
      // Parent page sends not a single message: stage polls manifest periodically on its own and swaps in this frame's own image
      const swapped = await until('The frame parked on a sparse segment swapped itself to full density', async () => {
        const d = await diagA();
        return d.tracks.length === clipsAt(park).length && d.tracks.every((t) => t.level === 'dense' && t.picture === park && !t.stale) ? d : null;
      }, 30_000, 250);
      const after = scoreBands(await shotStage(), Object.fromEntries(clipsAt(park).map((id) => [id, [want[id], park, park - 1, park + 1]])));
      out.upgrade = { frame: park, sparsePicture: want, before: Object.fromEntries(Object.entries(before).map(([id, r]) => [id, r.best])), after: Object.fromEntries(Object.entries(after).map(([id, r]) => [id, r.best])),
        waitedMs: Date.now() - t1 - out.denseMs, ok: !!swapped };
      say('B-upgrade', out.upgrade);
      check(Object.entries(before).every(([id, r]) => r.best === want[id]), 'Before the swap, the sparse picture was shown', before);
      check(!!swapped && Object.values(after).every((r) => r.best === park), 'Once the full-density version was produced, the frame swapped itself to its own picture without waiting for any message', after);
    } else {
      holdDense = false;
      producer.kick();
      await until('all segments at full density', () => (idle() && Object.keys(CLIPS).every((id) => segmentsOf(id).every((s) => s === 1)) ? true : null), 900_000, 500);
    }
  }

  /* ------------------------------------------------------------ C. Full density: jump in shuffled order, compare frame by frame; measure time from requesting this frame to drawing */
  {
    await setBase('/cold1');   // Use a different URL prefix: browser cache misses, each segment must be truly fetched on the first run
    await rpc('setStreamPlanes', []);
    await rpc('setSuppressed', []);
    const rec = { frames: 0, wrong: [], notDrawn: [], placeholders: [], sameMean: 0, nextMean: 0, n: 0, coldMs: [], warmMs: [], bySample: {} };
    const pass = async (label, order, shoot) => {
      for (const f of order) {
        const { want, got } = await seekTo(f);
        if (got.ms === null) { rec.notDrawn.push({ frame: f, pass: label, ...got }); continue; }
        (label === 'cold' ? rec.coldMs : rec.warmMs).push(got.ms);
        // Record separately by "which sample in its segment this frame is" (when both cards are present, pick the one requiring more decoding)
        const sample = Math.max(...Object.keys(want).map((id) => (f - stateOf(id).spec.originFrame) % SEG));
        ((rec.bySample[label] ||= {})[sample] ||= []).push(got.ms);
        if (got.placeholders.length) rec.placeholders.push({ frame: f, pass: label, placeholders: got.placeholders });
        if (!shoot) continue;
        const stage = await shotStage();
        const result = scoreBands(stage, Object.fromEntries(Object.keys(want).map((id) => [id, [f - 1, f, f + 1]])));
        for (const [id, r] of Object.entries(result)) {
          if (r.best !== f) rec.wrong.push({ frame: f, clip: id, ...r });
          rec.sameMean += r.mean; rec.nextMean += r.runnerUp ?? 0; rec.n++;
        }
        rec.frames++;
        if (f === 105 || f === 47) { await fs.writeFile(path.join(OUT, `dense-stage-${f}.png`), toPng(stage)); await fs.writeFile(path.join(OUT, `export-${f}.png`), toPng(exportOf(f))); }
      }
    };
    await pass('cold', shuffled(FIRST, LAST), !TIMING);
    await pass('warm', shuffled(FIRST, LAST).reverse(), false);
    if (TIMING) { await pass('warm', shuffled(FIRST, LAST), false); rec.frames = LAST - FIRST + 1; rec.sameMean = 0; rec.nextMean = 1; rec.n = 1; }
    const worst = (label) => stats((rec.bySample[label] ?? {})[SEG - 1] ?? []);
    const tracks = (await diagA()).tracks;
    out.denseScrub = { frames: rec.frames, wrongCount: rec.wrong.length, wrong: rec.wrong.slice(0, 5), notDrawn: rec.notDrawn.slice(0, 5), placeholdersLeft: rec.placeholders.slice(0, 5),
      vsExportSameFrame: round2(rec.sameMean / Math.max(1, rec.n)), controlSecondMostSimilarFrame: round2(rec.nextMean / Math.max(1, rec.n)),
      randomFrameJumpMs: { firstPassBytesToFetch: stats(rec.coldMs), secondPassBytesInHand: stats(rec.warmMs),
        jumpToSegmentLastFrameFirstPass: worst('cold'), jumpToSegmentLastFrameSecondPass: worst('warm'),
        jumpToSegmentFirstFrameSecondPass: stats((rec.bySample.warm ?? {})[0] ?? []) },
      playerRecordedWorst: tracks.map((t) => ({ id: t.id, seekMaxMs: t.seekMaxMs, seeks: t.seeks })) };
    say('C-dense', out.denseScrub);
    check(rec.notDrawn.length === 0 && rec.frames === LAST - FIRST + 1, `Full density: every frame from ${FIRST} to ${LAST} showed its own frame`, { frames: rec.frames, notDrawn: rec.notDrawn.slice(0, 3) });
    check(rec.wrong.length === 0, 'Full density: when paused and jumping to any frame, the picture shown is always most similar to the same frame on the export page', { wrong: rec.wrong.length, first: rec.wrong.slice(0, 3) });
    if (!TIMING) check(out.denseScrub.vsExportSameFrame < 3 && out.denseScrub.controlSecondMostSimilarFrame > 3 * out.denseScrub.vsExportSameFrame, 'Full density: small difference to the same frame, clearly larger difference to the second-most-similar frame', out.denseScrub);
    check(rec.placeholders.length === 0, 'Full density: no placeholder is up at the moment the picture is drawn (the frame arrives asynchronously and the parent page sends no follow-up message)', rec.placeholders.slice(0, 3));
  }

  /* ------------------------------------------------------------ D. Fails to decode: keep previous image → placeholder on timeout → frame auto-swaps and placeholder auto-dismisses once bytes arrive */
  if (!TIMING) {
    await setBase('/slow1');
    await rpc('setStreamPlanes', []);
    await rpc('setSuppressed', []);
    await seekTo(47);                 // Segment 0 (only clip-b present), fetched from /slow1, not held back
    slow.hold = true;
    const target = 92;                // Segment 3: bytes held back
    const planes = planesAt(target);
    await rpc('setStreamPlanes', planes);
    await rpc('setSuppressed', membersOf(planes));
    // Send not a single message after setting time, record millisecond by millisecond in stage: which frame is drawn, whether it is retained old image, placeholder
    const watch = frameA().evaluate(async (frame, fps) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const t0 = now();
      await window.__pcStage.setTime(frame / fps + 1e-4);
      const log = [];
      let last = '';
      for (;;) {
        const d = window.__pcStageDiag();
        const t = d.streams.tracks.find((x) => x.id.split('#')[0] === 'clip-b');
        const slot = document.querySelector('[data-pc-clip="clip-b"] > [data-pc-placeholder-slot]');
        const key = `${t ? t.lastDrawn : '-'}|${t && t.stale ? 1 : 0}|${d.placeholders.includes('clip-b') ? 1 : 0}|${slot && !slot.hidden ? 1 : 0}`;
        const at = Math.round(now() - t0);
        if (key !== last) { last = key; log.push({ at, drawn: t ? t.lastDrawn : null, stale: !!(t && t.stale), placeholder: d.placeholders.includes('clip-b'), slotShown: !!(slot && !slot.hidden) }); }
        if (t && t.lastDrawn === frame) return { log, doneAt: at };
        if (at > 20000) return { log, doneAt: null };
        await wait(3);
      }
    }, target, FPS);
    await sleep(1500);
    const held = slow.waiting.length;
    const mid = await diagA();
    slow.release();
    const seen = await watch;
    const blankAt = seen.log.find((e) => e.drawn === null)?.at ?? null;
    const placeholderAt = seen.log.find((e) => e.placeholder)?.at ?? null;
    const end = seen.log.at(-1);
    const stage = await shotStage();
    const result = scoreBands(stage, { 'clip-b': [target - 1, target, target + 1, 47] });
    out.hold = { from: 47, target, heldRequests: held, log: seen.log, blankAtMs: blankAt, placeholderAtMs: placeholderAt, releasedAtMs: 1500, drawnAtMs: seen.doneAt, midway: { placeholders: mid.placeholders, tracks: mid.tracks.map((t) => [t.lastDrawn, t.stale]) }, best: result['clip-b'].best };
    say('D-hold', out.hold);
    const holdMs = (SEG * 1000) / FPS;
    check(held > 0, 'This segment\'s bytes were indeed held back', slow.asked);
    check(seen.log[0]?.drawn === 47 && seen.log[0].stale && !seen.log[0].placeholder, 'This frame cannot be decoded: keep the previous picture for now, do not show a placeholder', seen.log.slice(0, 3));
    check(blankAt !== null && blankAt >= holdMs - 60 && blankAt <= holdMs + 400, `The retained old picture is cleared after about one segment's duration (${holdMs} ms)`, { blankAt });
    check(placeholderAt !== null && placeholderAt >= blankAt - 5, 'After clearing, the placeholder takes over', { blankAt, placeholderAt });
    check(seen.doneAt !== null && end.drawn === target && !end.placeholder && !end.slotShown, 'The bytes arrived: this frame draws itself and the placeholder removes itself (the parent page sent no message at all)', end);
    check(result['clip-b'].best === target, 'After arrival, this frame is the one shown', result);
    await setBase('/cold1');
  }

  /* ------------------------------------------------------------ E. Decoded ahead while paused; first tick on play; do not hide original image before stream draws */
  if (!TIMING) {
    const f0 = 110;
    const both = ['clip-a', 'clip-b'];
    await seekTo(f0);
    // After stopping and catching up to exact live render, parent page removes suppression, while stream planes are sent as usual
    await rpc('setSuppressed', []);
    await sleep(120);
    const idleDom = await domA();
    const idleDiag = await diagA();
    // (Live images here are not compared for pixels: test page only removes suppression without going through "stop and catch up to exact live render" step: that step and post-stop pixels are verified in scrub-stream-probe)
    out.prewarm = { frame: f0, dom: idleDom, tracks: idleDiag.tracks.map((t) => ({ id: t.id, lastDrawn: t.lastDrawn })) };
    check(both.every((id) => idleDom[id] && idleDom[id].canvas === 'none' && !/pc-suppressed/.test(idleDom[id].cls)), 'When not suppressed, the stream plane is hidden (takes no frame) and the live picture is visible', idleDom);
    check(idleDiag.tracks.length === 2 && idleDiag.tracks.every((t) => t.lastDrawn === f0), 'While paused: the frame under the playhead is already decoded and drawn on the hidden stream plane', out.prewarm.tracks);
    // Start playback: stream planes (unchanged) → suppression → play; record tick by tick which tier each card lands on
    await frameA().evaluate(() => { window.__pcFallbackTrace = []; });
    await page.evaluate(() => { window.__frames = []; });
    await rpc('setStreamPlanes', planesAt(f0));
    await rpc('setSuppressed', both);
    const atStart = await diagA();
    const startDom = await domA();
    await rpc('play', f0 / FPS + 1e-4);
    await sleep(500);
    const stop = await rpc('pause');
    const trace = await frameA().evaluate(() => { const t = window.__pcFallbackTrace.splice(0); delete window.__pcFallbackTrace; return t; });
    const beats = trace.map((b) => ({ frame: Math.round(b.sec * 30), levels: b.levels }));
    const bad = beats.filter((b) => both.some((id) => CLIPS[id].frames[1] >= b.frame && b.levels[id] !== 'dense'));
    out.playStart = { frame: f0, waitingAtStart: atStart.streamWaiting, suppressedAtStart: atStart.suppressed, dom: startDom, beats: beats.length, firstBeat: beats[0] ?? null, notDense: bad.slice(0, 5), stoppedAt: Math.round(stop.stoppedAt * FPS) };
    say('E-play-start', out.playStart);
    check(atStart.streamWaiting.length === 0 && both.every((id) => atStart.suppressed.includes(id)), 'Playback start: this frame is decoded first, so as soon as suppression applies it switches to the stream with no wait', { waiting: atStart.streamWaiting, suppressed: atStart.suppressed });
    check(both.every((id) => startDom[id]?.canvas !== 'none' && /pc-suppressed/.test(startDom[id]?.cls ?? '')), 'Playback start: the stream plane is revealed and the live subtree is hidden, in the same commit', startDom);
    check(beats.length >= 5 && bad.length === 0, 'Playback start: from the first tick on, every tick shows the stream\'s picture (no empty ticks, no placeholders)', { beats: beats.length, first: beats[0], bad: bad.slice(0, 3) });

    // Not decoded ahead of time: stream planes just arrived, bytes are 180 ms slow. Do not hide original image before first stream frame is drawn
    await rpc('setSuppressed', []);
    await rpc('setStreamPlanes', []);
    await rpc('setTime', f0 / FPS + 1e-4);
    await setBase('/slow2');
    slow.delayMs = 180;
    const sampler = frameA().evaluate(async (ids) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const t0 = now();
      const log = [];
      let last = '';
      for (;;) {
        const d = window.__pcStageDiag();
        const showing = ids.filter((id) => d.streams.tracks.some((t) => t.id.split('#')[0] === id && t.lastDrawn !== null));
        const hidden = ids.filter((id) => document.querySelector(`[data-pc-clip="${id}"]`)?.classList.contains('pc-suppressed'));
        // "Draw nothing": live subtree is hidden, stream has no image
        const empty = hidden.filter((id) => !showing.includes(id));
        const key = `${d.parentSuppressed.join()}|${d.streamWaiting.join()}|${hidden.join()}|${showing.join()}|${d.placeholders.join()}`;
        const at = Math.round(now() - t0);
        if (key !== last) { last = key; log.push({ at, named: d.parentSuppressed, waiting: d.streamWaiting, hidden, showing, empty, placeholders: d.placeholders }); }
        if (at > 1500) return log;
        await wait(3);
      }
    }, both);
    await sleep(30);
    await rpc('setStreamPlanes', planesAt(f0));
    await rpc('setSuppressed', both);
    const coldLog = await sampler;
    slow.delayMs = 0;
    const named = coldLog.filter((e) => e.named.length === 2);
    const waitingSpan = named.filter((e) => e.waiting.length);
    const firstHidden = named.find((e) => e.hidden.length === 2);
    out.coldStart = { log: coldLog, waitedMs: waitingSpan.length && firstHidden ? firstHidden.at - waitingSpan[0].at : null };
    say('E-cold-start', out.coldStart);
    check(waitingSpan.length > 0 && named.every((e) => e.waiting.every((id) => !e.hidden.includes(id))), 'Card whose stream has not drawn its first frame yet: even when explicitly suppressed, the original picture is not hidden for now', coldLog.slice(0, 4));
    check(!!firstHidden && firstHidden.showing.length === 2 && named.every((e) => e.hidden.every((id) => e.showing.includes(id))), 'The live subtree is hidden only at the moment the stream is drawn (every hidden card\'s stream already has a picture)', firstHidden);
    check(coldLog.every((e) => e.empty.length === 0 && e.placeholders.length === 0), 'At no point is there a moment of "live subtree hidden and stream has no picture", and no placeholders either', coldLog.filter((e) => e.empty.length || e.placeholders.length).slice(0, 3));

    // Consistently fails to draw: hide only on timeout, replaced with placeholder
    await rpc('setSuppressed', []);
    await rpc('setStreamPlanes', []);
    await setBase('/slow3');
    slow.hold = true;
    await rpc('setStreamPlanes', planesAt(f0));
    await rpc('setSuppressed', both);
    const early = await diagA();
    await sleep(900);
    const late = await diagA();
    const lateDom = await domA();
    slow.release();
    await until('After the bytes are released, the stream draws and the placeholder is removed', async () => { const d = await diagA(); return d.tracks.length === 2 && d.tracks.every((t) => t.lastDrawn === f0) && !d.placeholders.length ? d : null; }, 10_000, 100);
    out.waitTimeout = { early: { waiting: early.streamWaiting, suppressed: early.suppressed }, late: { waiting: late.streamWaiting, suppressed: late.suppressed, placeholders: late.placeholders }, dom: lateDom };
    say('E-wait-timeout', out.waitTimeout);
    check(early.streamWaiting.length === 2 && early.suppressed.length === 0, 'Stream cannot draw: wait for now, do not hide', out.waitTimeout.early);
    check(late.streamWaiting.length === 0 && late.suppressed.length === 2 && late.placeholders.length === 2, 'Still nothing at the deadline: hide it and let the placeholder take over', out.waitTimeout.late);
    await setBase('/cold1');
  }

  /* ------------------------------------------------------------ F. Fast scrubbing */
  if (!TIMING) {
    const path16 = [...Array.from({ length: 20 }, (_, i) => 41 + i * 3), ...Array.from({ length: 16 }, (_, i) => 98 - i * 3), 77, 45, 96, 52, 88, 63];
    await seekTo(41);
    const before = (await diagA()).tracks.find((t) => t.id === 'clip-b');
    const fast = await frameA().evaluate(async (steps, fps) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const track = () => window.__pcStageDiag().streams.tracks.find((t) => t.id.split('#')[0] === 'clip-b');
      const seen = new Set();
      let empty = 0;
      const t0 = now();
      for (const f of steps) {
        void window.__pcStage.setTime(f / fps + 1e-4);
        await wait(16);
        const t = track();
        if (t && t.lastDrawn !== null) seen.add(t.lastDrawn); else empty++;
      }
      const last = steps[steps.length - 1];
      const dragMs = now() - t0;
      let settleMs = null;
      for (;;) {
        const t = track();
        if (t && t.lastDrawn === last && !t.stale) { settleMs = +(now() - t0 - dragMs).toFixed(1); break; }
        if (now() - t0 > 8000) break;
        await wait(2);
      }
      return { steps: steps.length, dragMs: Math.round(dragMs), distinctDrawn: seen.size, emptySamples: empty, settleMs, placeholders: window.__pcStageDiag().placeholders };
    }, path16, FPS);
    const after = (await diagA()).tracks.find((t) => t.id === 'clip-b');
    const stage = await shotStage();
    const last = path16.at(-1);
    const result = scoreBands(stage, { 'clip-b': [last - 1, last, last + 1] });
    out.fastDrag = { ...fast, seeks: after.seeks - before.seeks, deferred: after.deferred - before.deferred, decoded: after.decoded - before.decoded, best: result['clip-b'].best, last };
    say('F-fast-drag', out.fastDrag);
    check(fast.settleMs !== null && result['clip-b'].best === last, 'Fast scrub: after stopping, the last frame is the one drawn', out.fastDrag);
    check(out.fastDrag.seeks < path16.length, 'Fast scrub: the decoder is not reset at every step (let the in-flight one finish and decode only the latest one requested)', out.fastDrag);
    check(fast.distinctDrawn >= 5 && fast.emptySamples === 0, 'Fast scrub: the picture follows along the whole way, with no empty moments', out.fastDrag);
    check(fast.placeholders.length === 0, 'Fast scrub: no placeholders', fast.placeholders);
  }

  /* ------------------------------------------------------------ G. Pause during playback */
  if (!TIMING) {
    await rpc('setStreamPlanes', planesAt(100));
    await rpc('setSuppressed', ['clip-a', 'clip-b']);
    await rpc('setTime', 95 / FPS + 1e-4);
    await page.evaluate(() => { window.__frames = []; });
    await rpc('play', 95 / FPS + 1e-4);
    await sleep(700);
    const stop = await rpc('pause');
    const stopped = Math.round(stop.stoppedAt * FPS);
    await until('The paused frame is drawn', async () => { const d = await diagA(); return d.tracks.every((t) => t.lastDrawn === stopped || t.lastDrawn === null) ? d : null; }, 5000, 50);
    const frames = await page.evaluate(() => window.__frames);
    const steps = frames.slice(1).map((f, i) => +(f.sec - frames[i].sec).toFixed(6));
    const stage = await shotStage();
    const result = scoreBands(stage, Object.fromEntries(clipsAt(stopped).map((id) => [id, [stopped - 1, stopped, stopped + 1]])));
    out.playPause = { from: 95, stoppedAt: stopped, beats: frames.length, noSkip: steps.every((s) => Math.abs(s - 1 / FPS) < 1e-6), best: Object.fromEntries(Object.entries(result).map(([id, r]) => [id, r.best])) };
    say('G-play-pause', out.playPause);
    check(out.playPause.noSkip && frames.length > 5 && stopped > 100, 'Playback: no skipped frames, and it reached the stretch where both cards are present', out.playPause);
    check(Object.values(result).every((r) => r.best === stopped), 'Pause during playback: the frame it stopped on shows that frame', result);
  }
  await rpc('setRole', 'back', { job: 'probe' });
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); hostServer?.closeAllConnections?.(); } catch { /* ignore */ }
  try { await pipeline?.close(); } catch { /* ignore */ }
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
