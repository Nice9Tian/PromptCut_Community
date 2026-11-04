/**
 * Clips whose output node has upstream nodes (card clips with emphasis attached) run through real
 * prerender pipeline: do two different cards with same emphasis have distinct frames?
 * (Report `docs/archive/agent-reports/AGENT-rr-emphasis-key.md`; unit test
 * `server/test/card-cache-upstream-key.test.mjs`).
 *
 *   node scripts/probes/emphasis-key-probe.mjs [--port 27840] [--out <dir>] [--keep] [--json <file>]
 *
 * Starts a dev server in this checkout root (`--port`, occupying +1 and +2 as stage ports and +5
 * for test page; with `PROMPTCUT_NO_PORT_FILE=1`, not touching 5190-5192), directly starts a
 * `FramePipeline` in this process (same code as prerender process, `interactive: true`), with store
 * root at `--out`. Feeds a project where all four clips have the same stroke emphasis, identical
 * frame size, 3-second duration, and in points aligned to whole frames (identical sampling phase):
 *
 *   clip-l     punchline pill `punch-pill`, text AAA          0-3s   top-left of video
 *   clip-r     focus card `focus-card`, key points ZZZ…     0-3s   bottom-right of video  different card from clip-l
 *   clip-late  punchline pill, text LATE                      4-7s   top-left of video      same card as clip-l, different parameters
 *   clip-twin  punchline pill, text AAA (identical to clip-l) 4-7s   bottom-right of video  identical to clip-l inside and out
 *
 * Recorded (conclusion JSON's `plan`, `streams`, `layers`): output node, tier, whether independently
 * prerenderable, whether entering prerender set, and three keys for each clip; streams produced by
 * `planStreams` for each clip; which key is used for each layer sent to the page by ready index.
 *
 * Verification:
 *   1. Output nodes of all four clips are emphasis nodes, classified as shared tier, can be
 *      independently prerendered, entered prerender set, and each has a single-card stream (the
 *      prerequisite for "whether stream pasting could actually go wrong");
 *   2. Pairwise among clip-l, clip-r, and clip-late: snapshot content key, stream member key, and
 *      result key are all different; stream keys of clip-l and clip-r are different;
 *   3. clip-l and clip-twin: snapshot content key and result key are identical (shared between the
 *      two clips of the same card); in points differ, so stream keys differ;
 *   4. Snapshots: each clip reads existing first frame snapshot HTML under its own result key
 *      (used for `html` layer sent to page), verifying it contains its own text and no text from
 *      other clips (text is in DOM, regardless of entrance animation progress);
 *   5. Stage: one stage iframe pastes streams following parent page practice (`setSuppressed` +
 *      `setStreamPlanes`, planes taken from `stream` layer of ready index), stops at 1.7s and 5.7s to
 *      take screenshots; then detaches streams and live renders same frame for these cards to take
 *      a screenshot. For each clip's frame area, pixels with large differences between stream paste
 *      and live render (max difference across three channels > 64) are under 0.3% (see `regionDiff`
 *      for criterion origin). Screenshots saved under `shots/` in `--out`.
 *
 * Outputs JSON conclusion, writes progress to stderr; exits with non-zero on any failure.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { handleStreamRequest } from '../../server/frame-stream.mjs';
import { rangeCount } from '../../server/snapshot-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '27840', args));
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-emphasis-key-probe-${Date.now().toString(36)}`));
if (!(PORT >= 20000)) throw new Error('The port must be 20000 or above');

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const EMPHASIS = { kind: 'outline', color: '#ffd400', size: 8, opacity: 1 };
const BOX_L = { x: 80, y: 60, w: 800, h: 450 };
const BOX_R = { x: 1040, y: 570, w: 800, h: 450 };
const TEXT = { 'clip-l': 'AAA', 'clip-r': 'ZZZ', 'clip-late': 'LATE', 'clip-twin': 'AAA' };
const PROJECT = {
  id: 'emphasis-key-probe', name: 'Emphasis key probe', width: 1920, height: 1080, fps: 30, duration: 8,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-l', name: 'l', hidden: false, clips: [
      { id: 'clip-l', kind: 'card', cardId: 'punch-pill', start: 0, end: 3, params: { text: 'AAA' }, frame: { ...BOX_L }, emphasis: { ...EMPHASIS } },
      { id: 'clip-late', kind: 'card', cardId: 'punch-pill', start: 4, end: 7, params: { text: 'LATE' }, frame: { ...BOX_L }, emphasis: { ...EMPHASIS } },
    ] },
    { id: 'tr-r', name: 'r', hidden: false, clips: [
      { id: 'clip-r', kind: 'card', cardId: 'focus-card', start: 0, end: 3, params: { items: 'ZZZ 一|ZZZ 二|ZZZ 三', bg: 'dark' }, frame: { ...BOX_R }, emphasis: { ...EMPHASIS } },
      { id: 'clip-twin', kind: 'card', cardId: 'punch-pill', start: 4, end: 7, params: { text: 'AAA' }, frame: { ...BOX_R }, emphasis: { ...EMPHASIS } },
    ] },
  ],
};
const CLIPS = ['clip-l', 'clip-r', 'clip-late', 'clip-twin'];
const BOX_OF = { 'clip-l': BOX_L, 'clip-r': BOX_R, 'clip-late': BOX_L, 'clip-twin': BOX_R };
const DISTINCT = [['clip-l', 'clip-r'], ['clip-l', 'clip-late'], ['clip-r', 'clip-late']];

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

/**
 * Minimal stand-in for parent page side: a stage iframe driven only via postMessage RPC
 * (same as `stream-play-probe.mjs`).
 */
const hostHtml = (stage) => `<!doctype html><html><head><meta charset="utf-8"><title>emphasis key probe host</title></head>
<body style="margin:0;background:#202020">
<iframe id="a" src="${stage}/?stage=1&id=A&preview=stage&prerender=1" style="width:1920px;height:1080px;border:0;display:block"></iframe>
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
window.__ready = new Promise((res) => {
  const frame = document.getElementById('a');
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    window.__rpc = createStageRpc(frame.contentWindow, '${stage}'); res(true);
  });
});
</script></body></html>`;

/** Region of screenshot → RGB (screenshot is opaque, sampled directly) */
function regionRgb(pngBuf, box) {
  const png = PNG.sync.read(pngBuf);
  const x0 = Math.max(0, box.x), y0 = Math.max(0, box.y), x1 = Math.min(png.width, box.x + box.w), y1 = Math.min(png.height, box.y + box.h);
  const out = new Uint8Array((x1 - x0) * (y1 - y0) * 3);
  let j = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * png.width + x) * 4; out[j++] = png.data[i]; out[j++] = png.data[i + 1]; out[j++] = png.data[i + 2]; }
  return out;
}
/**
 * How much two image regions differ: `meanAbs` is mean absolute difference across three channels;
 * `bigRatio` is proportion of "significantly different" pixels (max difference across three
 * channels > 64). Lossy encoding errors fall on the former number (measured at 0.2-0.8), producing
 * almost no significantly different pixels (measured at 0.002%-0.02%); when pasted with a different
 * image, the latter number reaches a few percent to tens of percent (measured: 2.4% for same card
 * with different text, 77% for different card). Therefore, judgments are based on the latter number.
 */
function regionDiff(a, b) {
  if (a.length !== b.length || !a.length) return { meanAbs: null, bigRatio: null };
  let sum = 0, big = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d0 = Math.abs(a[i] - b[i]), d1 = Math.abs(a[i + 1] - b[i + 1]), d2 = Math.abs(a[i + 2] - b[i + 2]);
    sum += d0 + d1 + d2;
    if (Math.max(d0, d1, d2) > 64) big++;
  }
  return { meanAbs: +(sum / a.length).toFixed(3), bigRatio: +(big / (a.length / 3)).toFixed(6) };
}
const BIG_RATIO_MAX = 0.003;
async function cropPng(pngBuf, box, file) {
  const png = PNG.sync.read(pngBuf);
  const out = new PNG({ width: box.w, height: box.h });
  PNG.bitblt(png, out, box.x, box.y, box.w, box.h, 0, 0);
  await fs.writeFile(file, PNG.sync.write(out));
}

const out = { port: PORT, library: OUT, project: PROJECT.id };
await fs.mkdir(OUT, { recursive: true });
const SHOTS = path.join(OUT, 'shots');
await fs.mkdir(SHOTS, { recursive: true });
const RUN = Date.now().toString(36);
const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pc-emphasis-key-dev-'));
let child = null, pipeline = null, browser = null, hostServer = null;
try {
  // ---------- 0. dev server (this checkout root, temporary data dir, does not write shared port file)
  const log = [];
  child = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: {
      ...process.env, BROWSER: 'none', PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_DATA_DIR: path.join(TMP, 'data'), PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0',
      PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: `emphkey-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'emphasis-key-probe',
    },
  });
  const keep = (c) => { log.push(c.toString()); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  say('spawn', { pid: child.pid, port: PORT });
  const origin = `http://127.0.0.1:${PORT}`;
  const up = await until('dev server is up', async () => {
    if (child.exitCode !== null) throw new Error(`dev server exited: ${log.join('').slice(-600)}`);
    return fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, 300);
  if (!up) throw new Error(`dev server did not start: ${log.join('').slice(-600)}`);
  out.origin = origin;

  // ---------- 1. Pipeline: feed project, wait for all streams to reach full density and
  // shared-tier snapshots to finish producing. Do not pin prerender set: whether to enter set is
  // judged by product logic itself
  pipeline = new FramePipeline({ root: path.join(OUT, 'library'), origin: () => origin, interactive: true, playhead: () => null });
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  const layerLog = [];
  pipeline.readyIndex.subscribe((message) => { if (message.type === 'layer') layerLog.push(message); });
  const t0 = Date.now();
  const entry = await pipeline.preload(PROJECT);
  const dense = () => {
    const status = producer.status();
    if (!status.streams.length) return null;
    for (const s of status.streams) for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
    return !producer.workers.size && !producer.encoding.size ? status : null;
  };
  await until('card plan is computed', () => (Array.isArray(entry.cardPlan) && entry.cardPlan.length ? entry.cardPlan : null), 180_000);
  const status = await until('all segments at full density', dense, 900_000, 1000);
  if (!status) throw new Error('The streams were not fully produced');
  const plan = entry.cardPlan ?? [];
  const controlOf = Object.fromEntries(plan.map((control) => [control.clipId, control]));
  // Snapshots are produced slowly in background card by card in batches of 4 frames (measured at
  // ~10+s per batch), first frame of each card produced first: wait until at least one frame exists
  // under each clip's key (not requiring full card completion), record progress in conclusion
  out.snapshotProgress = [];
  const snapshotsDone = async () => {
    const row = { ms: Date.now() - t0 };
    let done = true;
    for (const clipId of CLIPS) {
      const control = controlOf[clipId];
      if (!control?.snapshotKey || control.tier !== 'shared') continue;
      const index = await pipeline.snapshots().snapshotIndex({ tier: 'shared', key: control.snapshotKey });
      row[clipId] = `${index.count}+${rangeCount(index.oversize)}/${control.count}`;
      if (!index.count) done = false;
    }
    const last = out.snapshotProgress.at(-1);
    if (!last || CLIPS.some((clipId) => last[clipId] !== row[clipId])) out.snapshotProgress.push(row);
    return done ? true : null;
  };
  await until('every clip\'s key has a snapshot', snapshotsDone, 1_200_000, 2000);
  out.produceMs = Date.now() - t0;

  // ---------- 2. Record plan, streams, layers
  const short = (key) => (typeof key === 'string' ? key.slice(0, 12) : key ?? null);
  out.plan = {};
  for (const clipId of CLIPS) {
    const c = controlOf[clipId];
    out.plan[clipId] = c ? {
      nodeId: c.nodeId, tier: c.tier, compositing: c.compositing, cacheable: c.cacheable, needPrerendering: c.needPrerendering, frameMode: c.frameMode ?? null,
      picked: pipeline.prerenderPicked(entry, clipId), streamPicked: pipeline.streamPicked(entry, clipId),
      contentKey: short(c.contentKey), streamMemberKey: short(c.streamMemberKey), snapshotKey: short(c.snapshotKey), cacheContentKey: short(c.cacheContentKey),
      firstFrame: c.sampling?.firstFrame, count: c.count,
    } : null;
  }
  const states = [...producer.streams.values()];
  const stateOf = (clipId) => states.find((s) => s.spec.clipIds.includes(clipId) || s.aliases?.has(clipId)) ?? null;
  out.streams = states.map((s) => ({ streamKey: short(s.spec.streamKey), contentKey: short(s.spec.contentKey), kind: s.spec.kind, clipIds: s.spec.clipIds, aliases: [...(s.aliases ?? [])], replay: s.spec.replay }));
  const lastLayer = (clipId, kind) => layerLog.filter((m) => m.clipId === clipId && m.kind === kind).at(-1) ?? null;
  out.layers = {};
  for (const clipId of CLIPS) {
    const stream = lastLayer(clipId, 'stream'), html = lastLayer(clipId, 'html');
    out.layers[clipId] = { stream: stream ? { key: short(stream.key), ranges: stream.ranges } : null, html: html ? { key: short(html.key), ranges: html.ranges } : null };
  }
  say('plan', out.plan);
  say('streams', { streams: out.streams, layers: out.layers });

  // ---------- 3. Prerequisites and keys
  for (const clipId of CLIPS) {
    const c = controlOf[clipId];
    if (!check(!!c, `${clipId}: it is in the card plan`)) continue;
    check(/\/emphasis$/.test(c.nodeId), `${clipId}: the output node is the emphasis node`, c.nodeId);
    check(c.tier === 'shared' && c.cacheable === true, `${clipId}: shared tier, can be prerendered on its own`, { tier: c.tier, cacheable: c.cacheable });
    check(pipeline.prerenderPicked(entry, clipId), `${clipId}: it is in the prerender set`);
    check(!!stateOf(clipId), `${clipId}: has a single-card stream (its own, or one shared with other clips)`);
  }
  for (const [a, b] of DISTINCT) {
    const ca = controlOf[a], cb = controlOf[b];
    if (!ca || !cb) continue;
    for (const name of ['contentKey', 'streamMemberKey', 'snapshotKey']) check(ca[name] !== cb[name], `${a} and ${b}: ${name} must not be the same`, short(ca[name]));
  }
  {
    const sl = stateOf('clip-l'), sr = stateOf('clip-r');
    check(!!sl && !!sr && sl !== sr && sl.spec.streamKey !== sr.spec.streamKey, 'clip-l and clip-r: each has its own stream (stream keys differ)', { l: short(sl?.spec.streamKey), r: short(sr?.spec.streamKey) });
    const l = controlOf['clip-l'], twin = controlOf['clip-twin'];
    if (l && twin) {
      check(l.contentKey === twin.contentKey && l.snapshotKey === twin.snapshotKey && l.streamMemberKey === twin.streamMemberKey, 'clip-l and clip-twin: identical inside and out, so the snapshot keys are the same (one shared copy)',
        { l: short(l.contentKey), twin: short(twin.contentKey) });
      check(stateOf('clip-l')?.spec.streamKey !== stateOf('clip-twin')?.spec.streamKey, 'clip-l and clip-twin: different in points, so the stream keys differ');
    }
  }

  // ---------- 4. Snapshots: read one frame by key sent to page, check whose text is inside
  out.snapshots = {};
  for (const clipId of CLIPS) {
    const c = controlOf[clipId];
    if (!c?.snapshotKey) continue;
    const index = await pipeline.snapshots().snapshotIndex({ tier: 'shared', key: c.snapshotKey });
    const localFrame = index.frames[0]?.[0] ?? 0; // Existing first frame under this key
    const html = await pipeline.snapshots().readSnapshot({ tier: 'shared', key: c.snapshotKey, localFrame });
    const has = Object.fromEntries(['AAA', 'ZZZ', 'LATE'].map((text) => [text, typeof html === 'string' && html.includes(text)]));
    out.snapshots[clipId] = { key: short(c.snapshotKey), localFrame, frames: index.frames, bytes: typeof html === 'string' ? html.length : null, has };
    if (typeof html === 'string') await fs.writeFile(path.join(SHOTS, `snapshot-${clipId}.html`), html);
    if (!check(typeof html === 'string', `${clipId}: there is a snapshot under its key`)) continue;
    const own = TEXT[clipId];
    check(has[own] && Object.entries(has).every(([text, hit]) => text === own || !hit), `${clipId}: the snapshot contains its own text ${own}`, has);
  }
  say('snapshots', out.snapshots);

  // ---------- 5. Stage: stream-paste screenshots vs live-render screenshots
  const ports = await (await fetch(`${origin}/api/stage/ports`)).json();
  if (!ports.ok || !Array.isArray(ports.ports) || !ports.ports.length) throw new Error(`Stage ports did not come up: ${JSON.stringify(ports)}`);
  const stageOrigin = `http://127.0.0.1:${ports.ports[0]}`;
  out.stageOrigin = stageOrigin;
  hostServer = await serve(PORT + 5, (req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (u.pathname === '/__emphasis-key-probe-host') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(hostHtml(stageOrigin));
      return;
    }
    if (u.pathname.startsWith('/api/frames/') && handleStreamRequest(producer.store, req, res, u.pathname.slice('/api/frames'.length))) return;
    res.statusCode = 404; res.end();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(`${base}/__emphasis-key-probe-host`);
  await page.waitForFunction(() => window.__ready, { timeout: 120000 });
  await page.evaluate(() => window.__ready);
  const stageFrame = () => page.frames().find((f) => f.url().startsWith(stageOrigin));
  await stageFrame().evaluate((b) => { window.__pcStreamBase = b; }, base);
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const settleShot = async () => {
    await stageFrame().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    return page.screenshot({ clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  };
  // Plane: the last `stream` layer for each clip in the ready index
  // (parent page `streamPlanesFor` standard: one layer per plane)
  const planes = CLIPS.map((clipId) => lastLayer(clipId, 'stream')).filter(Boolean)
    .map((l) => ({ clipIds: l.groupClipIds?.length ? l.groupClipIds : [l.clipId], key: l.key, ranges: l.ranges }));
  const heavy = [...new Set(planes.flatMap((p) => p.clipIds))];
  out.planes = planes.map((p) => ({ clipIds: p.clipIds, key: short(p.key), ranges: p.ranges }));
  await rpc('setProject', PROJECT, { reset: true });
  await rpc('setRole', 'front');
  out.stage = [];
  for (const { label, from, clips } of [{ label: 'first', from: 0, clips: ['clip-l', 'clip-r'] }, { label: 'second', from: 4, clips: ['clip-late', 'clip-twin'] }]) {
    await rpc('setTime', from);
    await rpc('setPlaying', true);
    await rpc('setSuppressed', heavy);
    await rpc('setStreamPlanes', planes);
    await rpc('play', from);
    await sleep(1700);
    const stop = await rpc('pause');
    const at = Number(stop?.stoppedAt ?? from + 1.7);
    const streamShot = await settleShot();
    const diag = await stageFrame().evaluate(() => window.__pcStageDiag?.().streams?.tracks?.map((t) => ({ id: String(t.id).slice(0, 12), drawn: t.drawn, errors: t.errors, lastError: t.lastError })) ?? null);
    await rpc('setPlaying', false);
    await rpc('setSuppressed', []);
    await rpc('setStreamPlanes', []);
    await rpc('setTime', at);
    await sleep(1000);
    const liveShot = await settleShot();
    const name = at.toFixed(3);
    await fs.writeFile(path.join(SHOTS, `stage-${label}-streams-${name}.png`), streamShot);
    await fs.writeFile(path.join(SHOTS, `stage-${label}-live-${name}.png`), liveShot);
    const rec = { label, stoppedAt: at, tracks: diag, regions: {} };
    for (const clipId of clips) {
      const box = BOX_OF[clipId];
      const diff = regionDiff(regionRgb(streamShot, box), regionRgb(liveShot, box));
      rec.regions[clipId] = { box, ...diff };
      await cropPng(streamShot, box, path.join(SHOTS, `crop-${label}-${clipId}-streams.png`));
      await cropPng(liveShot, box, path.join(SHOTS, `crop-${label}-${clipId}-live.png`));
      check(diff.bigRatio !== null && diff.bigRatio < BIG_RATIO_MAX, `${clipId}: the stream-attached frame matches its own live rendered frame (pixels with large differences < ${BIG_RATIO_MAX * 100}%)`, diff);
    }
    out.stage.push(rec);
    say('stage', rec);
  }
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); } catch { /* ignore */ }
  try { await pipeline?.close(); } catch { /* ignore */ }
  if (child && child.exitCode === null) {
    // Only terminate the process tree it spawned
    if (process.platform === 'win32') {
      await new Promise((resolve) => { const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); k.on('close', resolve); k.on('error', resolve); });
    } else child.kill('SIGKILL');
  }
  try { fsSync.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
  if (!KEEP) {
    // Keep shots and conclusion JSON; delete the rest (stores)
    try {
      for (const name of await fs.readdir(OUT)) if (name !== 'shots' && name !== 'result.json') await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
