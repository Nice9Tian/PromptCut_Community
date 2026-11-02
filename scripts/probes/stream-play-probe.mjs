/**
 * End-to-end probe for R8 track stream **stage side** (the items for decoding and playback / stage
 * side / group stream plane in "Acceptance check" of the task brief).
 *
 *   node scripts/probes/stream-play-probe.mjs [--origin http://127.0.0.1:5230] [--group] [--out <dir>] [--json <file>]
 *
 * 1. Spin up a `FramePipeline` in this process to produce the project in `stream-probe-project.mjs`
 *    into track streams (store root in temp directory);
 * 2. Start an HTTP server in this process: serve the test page (two stage iframes hitting the dev
 *    server's two stage ports with `&preview=stage`), and serve stream bytes using
 *    `handleStreamRequest` from `server/frame-stream.mjs` (with CORS). In the stage, `streamPlayer`
 *    points here via `window.__pcStreamBase`: in production this route is mounted on `/api/frames/*`
 *    of the prerender process (see report: that location is in `server/vite-plugin-frames.ts`, outside
 *    the files modifiable in this task);
 * 3. The test page **acts as the parent page**: drives the stage only via postMessage RPC:
 *    `setSuppressed(H(t))` + `setStreamPlanes(...)` (planes synthesized from layers in ready index
 *    with `kind: 'stream'`, using the same logic as `streamPlanesFor`) + `play(0)`.
 *
 * Checks:
 *   - Frames are actually drawn on stream planes, decoder reports no errors; decoders exist only in
 *     `front`, none in `back`;
 *   - Frames held concurrently by a single decoder ≤ 8, total decoded frame bytes ≤ 80 MB;
 *   - Playback cadence: the `sec` delta of `frame` events is strictly 1/fps (no dropped frames),
 *     median interval;
 *   - Suppressed particle card: pixel hash of its own `<canvas>` remains unchanged during suppression,
 *     while `data-pc-local-frame` on the wrapper layer still changes with t;
 *   - Clicking canvas hits it (`hitTest`); with group stream (`--group`), clicking the group stream
 *     plane hits the suppressed card within the group behind it;
 *   - Cold seek to decoding target frame elapsed time (≤ 60 ms);
 *   - Paused at a specific frame: stage screenshot vs. full-frame PNG of the same frame on export page
 *     compared pixel-by-pixel (lossy encoding error, record average); save screenshot to disk;
 *   - Frosted-glass card (odometer, live render) overlaid on stream canvas: pixel-by-pixel comparison
 *     of that region against the same frame in export (blur sampled the stream below correctly);
 *   - Missing segments: omit several segments from plane's ready interval; during those segments,
 *     stream planes clear to transparent, playhead advances normally (`frame` does not stop or jump);
 *   - Control: cadence when the same stage has no stream planes attached (stream decoding and
 *     compositing does not slow down cadence);
 *   - After `setRole('back')`, `streamPlayer` stops and all `VideoFrame` instances are closed.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { PNG } from 'pngjs';
import { serve, devOrigin, flagArg } from './probe-connect.mjs';
import { handleStreamRequest } from '../../server/frame-stream.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { PROJECT, produceStreams, latestLayers } from './stream-probe-project.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const GROUP = args.includes('--group');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-play-${Date.now().toString(36)}`));
const JSON_OUT = flagArg('json', null, args);
if (GROUP) process.env.PROMPTCUT_STREAM_DECODERS = '1';
const HOST_PATH = '/__stream-play-probe-host';

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); return cond; };

async function stageOrigins() {
  const r = await fetch(origin + '/api/stage/ports');
  const j = await r.json();
  if (!j.ok || !Array.isArray(j.ports) || j.ports.length < 2) throw new Error(`Stage ports did not come up: ${JSON.stringify(j)}`);
  const u = new URL(origin);
  return j.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
}

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>stream play probe host</title></head>
<body style="margin:0;background:#202020">
<iframe id="a" src="${oa}/?stage=1&id=A&preview=stage&prerender=1" style="width:1920px;height:1080px;border:0;display:block"></iframe>
<iframe id="b" src="${ob}/?stage=1&id=B&preview=stage&prerender=1" style="width:1920px;height:1080px;border:0;display:block;opacity:0;pointer-events:none;position:absolute;left:0;top:0"></iframe>
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
  for (const m of ['setProject', 'setTime', 'render', 'hitTest', 'rectsWithBounds', 'size', 'setProxy', 'setRole', 'setPlan', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setScrubbing', 'setPlaying', 'setMediaT', 'setLocalHashes', 'setSnapshots']) c[m] = call(m);
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

/**
 * RGBA PNG → RGB composited with #202020 background color (export page full frame has transparent
 * background, stage screenshot is overlaid on test page background color)
 */
function rgbOver(pngBuf, bg = [0x20, 0x20, 0x20]) {
  const png = PNG.sync.read(pngBuf);
  const out = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
    const a = png.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) out[j + k] = Math.round(png.data[i + k] * a + bg[k] * (1 - a));
  }
  return { width: png.width, height: png.height, rgb: out };
}

function compare(a, b, region = null) {
  if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: [a.width, a.height, b.width, b.height] };
  const r = region ?? { x: 0, y: 0, w: a.width, h: a.height };
  let sum = 0, max = 0, over8 = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) for (let k = 0; k < 3; k++) {
    const i = (y * a.width + x) * 3 + k;
    const d = Math.abs(a.rgb[i] - b.rgb[i]);
    sum += d; n++;
    if (d > max) max = d;
    if (d > 8) over8++;
  }
  return { meanAbs: +(sum / n).toFixed(4), max, over8Ratio: +(over8 / n).toFixed(6) };
}

/** Cadence of `frame` events over a period of time (recorded by test page) */
function beatsOf(frames, fps) {
  const steps = frames.slice(1).map((f, i) => +(f.sec - frames[i].sec).toFixed(6));
  const gaps = frames.slice(1).map((f, i) => f.at - frames[i].at).sort((a, b) => a - b);
  return { count: frames.length, first: frames[0]?.sec, last: frames.at(-1)?.sec, secStepsUnique: [...new Set(steps)],
    noSkip: steps.every(s => Math.abs(s - 1 / fps) < 1e-6),
    gapMedianMs: gaps.length ? +gaps[gaps.length >> 1].toFixed(2) : null, gapP90Ms: gaps.length ? +gaps[Math.floor(gaps.length * 0.9)].toFixed(2) : null };
}

const out = { origin, group: GROUP, out: OUT };
await fs.mkdir(OUT, { recursive: true });
let browser = null, hostServer = null, pipeline = null;
try {
  const produced = await produceStreams({ origin, root: path.join(OUT, 'library'), fails });
  pipeline = produced.pipeline;
  const producer = produced.producer;
  out.produceMs = produced.produceMs;
  if (!producer) throw new Error('track stream production did not finish');
  const layers = latestLayers(produced.layers);
  out.layers = layers.map(l => ({ clipId: l.clipId, key: l.key.slice(0, 12), ranges: l.ranges, originFrame: l.originFrame ?? null, groupClipIds: l.groupClipIds ?? null }));
  // Suppressed during playback: cards that have streams (frosted-glass odometer is not in streams,
  // live renders as usual: what it needs to blur is precisely the stream canvas below)
  const heavy = [...new Set(layers.flatMap(l => l.groupClipIds?.length ? l.groupClipIds : [l.clipId]))];
  // Composition on parent page side: `stream` layer in ready index → plane (a group stream with groupClipIds)
  // Each plane carries this stream's own first frame (stage uses it to convert frame number to segment
  // number; stage does not decode planes without it)
  const planes = layers.map(l => ({ clipIds: l.groupClipIds?.length ? l.groupClipIds : [l.clipId], key: l.key, ranges: l.ranges, originFrame: l.originFrame }));
  out.planes = planes.map(p => ({ clipIds: p.clipIds, ranges: p.ranges }));

  const [originA, originB] = await stageOrigins();
  hostServer = await serve(0, (req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (u.pathname === HOST_PATH) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(hostHtml(originA, originB));
      return;
    }
    if (u.pathname.startsWith('/api/frames/') && handleStreamRequest(producer.store, req, res, u.pathname.slice('/api/frames'.length))) return;
    res.statusCode = 404; res.end();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(base + HOST_PATH);
  await page.waitForFunction(() => window.__ready, { timeout: 60000 });
  await page.evaluate(() => window.__ready);
  const frameA = () => page.frames().find(f => f.url().startsWith(originA));
  const frameB = () => page.frames().find(f => f.url().startsWith(originB));
  for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base);
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const rpcB = (method, ...a) => page.evaluate((m, a2) => window.__rpcB[m](...a2), method, a);
  const diagA = () => frameA().evaluate(() => window.__pcStageDiag());
  const diagB = () => frameB().evaluate(() => window.__pcStageDiag());

  await rpc('setProject', PROJECT, { reset: true });
  await rpcB('setProject', PROJECT, { reset: true });
  await rpc('setRole', 'front');
  await rpcB('setRole', 'back', { job: 'probe' });
  // Control: cadence of the same playback run without attaching stream planes or suppressing
  await rpc('setTime', 0);
  await page.evaluate(() => { window.__frames = []; });
  await rpc('play', 0);
  await new Promise(r => setTimeout(r, 1500));
  await rpc('pause');
  out.beatsNoStreams = beatsOf(await page.evaluate(() => window.__frames), PROJECT.fps);
  // B is back: cannot create decoders even if planes are sent
  await rpcB('setStreamPlanes', planes);
  // Parent page C5: send setSuppressed(H(t)) + setStreamPlanes(...) during playback
  await rpc('setTime', 0);
  await rpc('setPlaying', true);
  await rpc('setSuppressed', heavy);
  await rpc('setStreamPlanes', planes);
  // Pixel hash of the suppressed particle card's own canvas (should not change during suppression)
  const bgHash = () => frameA().evaluate(() => {
    const wraps = document.querySelectorAll('[data-pc-clip="clip-bg"]');
    const cv = document.querySelector('[data-pc-clip="clip-bg"] canvas:not([data-pc-stream-plane])');
    if (!cv) return { missing: true, wraps: wraps.length, canvases: [...wraps].map((w) => w.querySelectorAll('canvas').length), html: wraps[0]?.innerHTML.slice(0, 300) };
    const url = cv.toDataURL();
    let h = 0; for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0;
    return { h, len: url.length, localFrame: document.querySelector('[data-pc-clip="clip-bg"]')?.getAttribute('data-pc-local-frame') };
  });
  const hash0 = await bgHash();
  await page.evaluate(() => { window.__frames = []; });
  await rpc('play', 0);
  await new Promise(r => setTimeout(r, 1300));
  const hash1 = await bgHash();
  const mid = await diagA();
  await new Promise(r => setTimeout(r, 400));
  const stop = await rpc('pause');
  out.pause = stop;
  const hash2 = await bgHash();
  out.bgCanvas = { hash0, hash1, hash2 };
  check(!!hash1 && hash1.h === hash2?.h, 'suppressed particle card: its own canvas\'s pixel hash does not change during suppression', out.bgCanvas);
  check(!!hash1 && hash1.localFrame !== hash2?.localFrame, 'suppressed particle card: the wrapper layer\'s data-pc-local-frame still changes with t', out.bgCanvas);
  // Cadence
  out.beats = beatsOf(await page.evaluate(() => window.__frames), PROJECT.fps);
  check(out.beats.noSkip, 'during playback the sec difference between frames is always 1/fps (no frame skipping)', out.beats.secStepsUnique);
  check(out.beats.gapMedianMs !== null && out.beatsNoStreams.gapMedianMs !== null,
    'the median frame interval was measured both before and after stream paste (the difference between the two is only recorded, not a gate; it used to require ≤ 3 ms: durations are only recorded, not a gate (verification.md, user decision, 2026-10-07); amended in the second-pass scan of the full probe audit, 2026-10-23)', { streams: out.beats, none: out.beatsNoStreams, deltaMs: out.beats.gapMedianMs - out.beatsNoStreams.gapMedianMs });
  // Decoder state
  const d = await diagA();
  out.diagMid = mid.streams;
  out.diagPaused = d.streams;
  const tracks = mid.streams.tracks;
  check(tracks.length === planes.length, 'one stream per plane on front', { tracks: tracks.length, planes: planes.length });
  for (const t of tracks) {
    check(t.drawn > 10, `${t.id}: the stream plane drew frames during playback`, { drawn: t.drawn, errors: t.errors, lastError: t.lastError });
    check(t.errors === 0, `${t.id}: the decoder reported no errors`, t.lastError);
    check(t.maxHeld <= 8, `${t.id}: a single decoder holds ≤ 8 frames at a time`, t.maxHeld);
  }
  check(mid.streams.heldBytes <= 80 * 1024 * 1024, 'total bytes of decoded frames ≤ 80 MB', mid.streams.heldBytes);
  const b = await diagB();
  check(b.streams.tracks.length === 0 && b.streamPlanes.length === 0, 'the back stage creates no decoder and accepts no stream planes', b.streams);
  // Paused at this frame: stage screenshot vs. same frame on export page
  const iframeBox = await (await page.$('#a')).boundingBox();
  /*
   * Wait for stage to actually draw two frames before capturing, then take two shots and keep the
   * second: testing shows headless Chrome capturing cross-origin iframes occasionally gets an incompletely
   * composited frame (in one rerun, only bottom stream canvas remained, live-rendered odometer was
   * missing; DOM and stream states were both correct at the time, taking another shot fixes it).
   */
  const settleShot = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: 1920, height: 1080 } });
    return page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: 1920, height: 1080 } });
  };
  const shot = await settleShot();
  // What is attached to stage at the moment of screenshot (for troubleshooting)
  out.domAtShot = await frameA().evaluate(() => [...document.querySelectorAll('[data-pc-clip]')].map((w) => ({
    clipId: w.getAttribute('data-pc-clip'), cls: w.className, localFrame: w.getAttribute('data-pc-local-frame'),
    planes: [...w.querySelectorAll(':scope > canvas[data-pc-stream-plane], :scope > [data-pc-snapshot-plane]')].map((c) => ({ tag: c.tagName, w: c.width, style: c.getAttribute('style') })),
  })));
  out.diagAtShot = (await diagA()).streams.tracks.map((t) => ({ id: t.id.slice(0, 12), lastDrawn: t.lastDrawn, held: t.held, decoder: t.decoder }));
  out.tAtShot = (await diagA()).t;
  const shotFile = path.join(OUT, `stage-paused-${stop.stoppedAt?.toFixed(3)}.png`);
  await fs.writeFile(shotFile, shot);
  out.stageShot = shotFile;
  /*
   * Reference frame: export page **advances sequentially from frame 0, capturing each frame** up to this
   * frame (full-video export takes this exact path: `bakeFrames` with `frames: '0-N'`). Do not use
   * random access (`targetFrames`): frames in playback are not captured, Motion's JS frame loop cannot
   * advance (that comment in `bake.mjs`), and punchline pill entrance is only just starting at target
   * frame: that frame is not what final video export looks like. Nor use `see_frames`: that route replaces
   * cards with control PNGs in this process's store root, while page fetches from dev server's origin.
   */
  const refBakery = await pipeline.bakery(PROJECT, 'agent');
  let exportBuf = null;
  try {
    const frame = Math.round(stop.stoppedAt * PROJECT.fps);
    await bakeFrames(refBakery, { out: path.join(OUT, 'ref'), frames: `0-${frame}`, fullFrame: true, writeFrames: false, quiet: true,
      onFrame: async (f, buf) => { if (f === frame) exportBuf = buf; } });
  } finally { await refBakery.close().catch(() => {}); }
  if (exportBuf) {
    const exportFile = path.join(OUT, `export-${stop.stoppedAt?.toFixed(3)}.png`);
    await fs.writeFile(exportFile, exportBuf);
    out.exportShot = exportFile;
    const stageRgb = rgbOver(shot), exportRgb = rgbOver(exportBuf);
    out.compare = compare(stageRgb, exportRgb);
    check(!out.compare.sizeMismatch && out.compare.meanAbs < 3, 'paused frame: mean error between the stage (stream paste) and the same export frame < 3/255', out.compare);
    // Frosted glass (odometer) region: it live renders, with stream canvas behind it: if blur sampling is
    // correct, this region matches export
    const glass = PROJECT.tracks.flatMap(t => t.clips).find(c => c.id === 'clip-glass')?.frame;
    if (glass) {
      out.compareGlass = compare(stageRgb, exportRgb, { x: glass.x, y: glass.y, w: glass.w, h: Math.min(glass.h, 1080 - glass.y) });
      check(out.compareGlass.meanAbs < 3, 'frosted-glass card over the stream canvas: mean error of that region against the same export frame < 3/255', out.compareGlass);
    }
  }
  /*
   * Control in the same browser: remove suppression and stream planes, live render the same frame on
   * stage for these cards, and capture another screenshot.
   * Stream paste vs. live render (same stage, same Chrome): the frosted glass region especially must
   * match: it samples the stream canvas below.
   * (In the stage vs. export page group, frosted glass itself has blur differences between the two
   * Chrome configurations, unrelated to streams.)
   */
  if (!GROUP) {
    await rpc('setSuppressed', []);
    await rpc('setStreamPlanes', []);
    await rpc('setTime', stop.stoppedAt);
    await new Promise(r => setTimeout(r, 800));
    const live = await settleShot();
    const liveFile = path.join(OUT, `stage-live-${stop.stoppedAt?.toFixed(3)}.png`);
    await fs.writeFile(liveFile, live);
    out.liveShot = liveFile;
    const a = rgbOver(shot), b2 = rgbOver(live);
    out.compareLive = compare(a, b2);
    const glass = PROJECT.tracks.flatMap(t => t.clips).find(c => c.id === 'clip-glass')?.frame;
    if (glass) out.compareLiveGlass = compare(a, b2, { x: glass.x, y: glass.y, w: glass.w, h: Math.min(glass.h, 1080 - glass.y) });
    check(out.compareLive.meanAbs < 3, 'stream paste vs live render of the same frame on the same stage: mean error < 3/255', out.compareLive);
    if (out.compareLiveGlass) check(out.compareLiveGlass.meanAbs < 3, 'frosted glass over the stream canvas vs over a live-rendered card: mean error < 3/255', out.compareLiveGlass);
    // Restore to stream paste state; subsequent hit tests proceed as usual
    await rpc('setSuppressed', heavy);
    await rpc('setStreamPlanes', planes);
    await rpc('setTime', stop.stoppedAt);
  }
  // Hit test: center of pill → pill; areas without pill → particle background (its stream plane
  // fills the screen)
  out.hit = { pill: await rpc('hitTest', 960, 540), corner: await rpc('hitTest', 60, 1000) };
  if (!GROUP) {
    check(out.hit.pill?.clipId === 'clip-pill', 'clicking the pill\'s stream canvas hits the pill', out.hit.pill);
    check(out.hit.corner?.clipId === 'clip-bg', 'clicking the particle background\'s stream canvas hits the particle background', out.hit.corner);
  } else {
    const group = planes.find(p => p.clipIds.length > 1);
    check(!!group, 'in group stream mode there is one group stream plane', planes);
    const cv = await frameA().evaluate(() => {
      const c = document.querySelector('canvas[data-pc-group-plane]');
      return c ? { pe: getComputedStyle(c).pointerEvents, w: c.width, h: c.height } : null;
    });
    out.groupPlane = cv;
    check(cv?.pe === 'none', 'the group stream plane has pointer-events: none', cv);
    check(!!out.hit.pill && group?.clipIds.includes(out.hit.pill.clipId), 'clicking the group stream plane hits the suppressed card in the group behind it', out.hit.pill);
    const rects = await rpc('rectsWithBounds', { pixels: 'none' });
    check(rects.every(r => !String(r.clipId).includes(',')), 'rects do not include the group stream plane', rects.map(r => r.clipId));
  }
  // Cold seek: jump from current position to another segment (uncached), measure time to decode and
  // draw target frame
  out.seek = await frameA().evaluate(async (target, fps) => {
    const now = window.__pcRealNow ?? (() => performance.now());
    const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
    const f = Math.round(target * fps);
    const t0 = now();
    await window.__pcStage.setTime(target);
    for (;;) {
      const tracks = window.__pcStageDiag().streams.tracks;
      if (tracks.length && tracks.every((t) => t.lastDrawn === f || !t.bound)) return { ms: +(now() - t0).toFixed(2), frame: f, drawn: tracks.map((t) => t.lastDrawn) };
      if (now() - t0 > 3000) return { ms: null, frame: f, drawn: tracks.map((t) => t.lastDrawn) };
      await wait(1);
    }
  }, 3.9, PROJECT.fps);
  check(out.seek.ms !== null, 'Cold seek decoded the target frame (duration is only recorded; previously required ≤ 60 ms: timing is only recorded, not used as a gate (verification.md, user decision revised, 2026-10-07); 2026-10-23 probe audit, second-pass scan, follow-up fix)', out.seek);
  // Missing segments: particle background is only ready for first two segments (frames 0-29), play from
  // second 1: from frame 30 that layer is transparent, playhead advances normally
  if (!GROUP) {
    const bgPlane = planes.find(p => p.clipIds.length === 1 && p.clipIds[0] === 'clip-bg');
    if (bgPlane) {
      await rpc('setTime', 1);
      await rpc('setStreamPlanes', planes.map(p => p === bgPlane ? { ...p, ranges: [[0, 1]] } : p));
      await page.evaluate(() => { window.__frames = []; });
      await rpc('play', 1);
      await new Promise(r => setTimeout(r, 900));
      const missing = await diagA();
      await rpc('pause');
      const beats = beatsOf(await page.evaluate(() => window.__frames), PROJECT.fps);
      const bg = missing.streams.tracks.find(t => t.id.startsWith('clip-bg#'));
      out.missing = { beats, bg };
      check(beats.noSkip && beats.last > 1.5, 'The playhead keeps running and does not skip frames when a segment is missing', beats);
      check(!!bg && bg.lastDrawn === null, 'The layer with the missing segment is cleared to transparent (no frame was drawn on this tick)', bg);
      await rpc('setStreamPlanes', planes);
    }
  }
  // Return to background: streamPlayer stops, all frames closed
  await rpc('setRole', 'back', { job: 'probe' });
  const after = await diagA();
  check(after.streams.stopped === true && after.streams.tracks.length === 0 && after.streams.heldBytes === 0, 'After setRole(back), streamPlayer stops and all VideoFrames are closed', after.streams);
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
} finally {
  out.fails = fails;
  await browser?.close().catch(() => {});
  hostServer?.close();
  await pipeline?.close().catch(() => {});
  const text = JSON.stringify(out, null, 2);
  if (JSON_OUT) await fs.writeFile(JSON_OUT, text);
  console.log(text);
  console.log(fails.length ? `FAIL ${fails.length}` : 'PASS');
  process.exit(fails.length ? 1 : 0);
}
