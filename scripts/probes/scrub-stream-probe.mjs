/**
 * Heavy card track stream paste on pause and scrub: end-to-end probe in the **real editor**
 * (task brief "Ji-3"; contract `prerender-products-contract.md` Section 3.7).
 * Stage-side details for frame-by-frame, sparse version, retaining old visuals and placeholders
 * are in `stream-scrub-stage-probe.mjs`; here we check whether parent page integration is correct:
 * which cards use stream paste, when to send stream plane and suppression, do not read snapshots
 * when stream exists, how to withdraw after catching up to exact live render, first tick on
 * playback start.
 *
 *   node scripts/probes/scrub-stream-probe.mjs --port 26960 [--tilt] [--out <dir>] [--json <file>] [--keep]
 *   node scripts/probes/scrub-stream-probe.mjs --origin http://127.0.0.1:26960 …   # Connect to an already running dev server
 *
 * When `--port` is given, launch an isolated editor (stage ports are +1, +2, all three consecutive
 * numbers must be free; data dir and artifact dir point under `--out`), cleaned up by PID after run.
 *
 * Process:
 *   0. Editor `?editor&nosetup=1&preview=stage`; create a new project, place a card shifting
 *      10px per frame (`r6-stateful`), **starting at frame 40** (not a multiple of 15),
 *      duration 3 seconds. Wait for its cost record, pin as heavy card, trigger prerender, wait
 *      for all segments of its track stream to reach full density.
 *      Launch another browser for rendering to export the same project frame by frame as reference.
 *      **Reference for live render** (step 5): Finally release this card back to light card (no
 *      stream paste), click several places, measure which frame of the export page the preview's
 *      live render looks most like. This probe card is a CSS animation running from mount, so the
 *      live render preview on `main` runs one frame ahead of the export page (unrelated to stream,
 *      see report "Incidental findings"); record each "frame after stopping" earlier, and evaluate
 *      together at this point against the measured delta: what needs to be verified is that the
 *      live render obtained from "stream paste then stop" and the live render without stream paste
 *      are the same frame, not judging whether live render or export is right here.
 *   1. **Click timeline to seek** (paused, with "stop"): several places. Sample across animation
 *      frames throughout: this card has no moments where "live subtree is hidden and stream has
 *      no frame", placeholders are not displayed, and **not a single snapshot is mounted** (with
 *      stream, do not read snapshots). After stopping, return to exact live render: no longer
 *      suppressed, live subtree visible, stream plane hidden and already decoded this frame
 *      (parent page continues sending stream plane); screenshot looks most like the same frame in
 *      the export page.
 *   2. **Hold ruler and scrub** (real pointer events): a dozen places, including backwards,
 *      non-keyframes, across segments, moving only one or two frames. At each place: this card is
 *      suppressed, live subtree hidden, stream plane visible, player renders exactly this frame,
 *      no placeholders, no snapshots; **screenshot looks most like the same frame in export page**
 *      (more like it than previous or next frame).
 *      Release: return to exact live render (same as 1).
 *   3. **Start playback while paused**: in tick-by-tick records, every tick of this card from the
 *      first tick shows stream frames (no empty ticks, no placeholders, no snapshots);
 *      **pause during playback**: after stopping, return to exact live render, screenshot looks
 *      most like the frame where export page stopped.
 *   4. Temporarily change this card's cost record to "global clock only" and click again: take the
 *      path of background whole scene catch-up run and swap with visible stage;
 *      after swap, it is likewise exact live render, stream plane hidden on the new visible stage,
 *      and this frame is already decoded.
 *
 * Acceptance check: exit code 0, `fails: []` in results. Duration is only recorded. Timeout is
 * only to prevent hangs.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { startDevServer, emptyUrlOf, sleep, round2 } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const GIVEN_ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
/**
 * `--tilt`: adds 3D transform (rotateY, rotateX) to this card's outer frame; project enables
 * perspective. The outer frame uses 3D standalone card to form a separate stream; the stream
 * contains flat visuals prior to transformation, transformed by the wrapper layer during paste
 * (`soloStreamKind` in `server/frame-stream.mjs`); here we verify the real editor uses the same
 * mechanism: click, scrub, start playback, and pause all use stream paste; screenshot looks most
 * like the same frame in export page (live 3D transform).
 */
const TILT = args.includes('--tilt');
const JSON_OUT = flagArg('json', null, args);
const RUN = Date.now().toString(36);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-scrub-stream-${RUN}`));
if (!GIVEN_ORIGIN && !PORT) { console.error('Pass --origin <dev server> or --port <start your own>'); process.exit(2); }

const FPS = 30, SEG = 15;
/** This card: starts at frame 40, 90 frames (frames 40-129); in point written in seconds, falls between two frames */
const CLIP_START = 1.32, CLIP_SECONDS = 3;
const FIRST = 40, LAST = 129;
/** Several points jumped to by clicking the timeline */
const CLICKS = [57, 100, 43, 128, 85];
/** Frames reached in scrub sequence: first is press position. 72 spans forward a segment; 48 back;
 *  115 far jump; 117 moves only two frames; 100 back, first frame of its segment (40 + 4 × 15);
 *  99 back one frame, landing on last frame of previous segment; 126 forward; 44 far back;
 *  84 non-keyframe */
const STEPS = [57, 72, 48, 115, 117, 100, 99, 126, 44, 84];

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const notes = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 900))); say('FAIL', { label, extra }); } return !!cond; };
const frameOf = (t) => Math.round(t * FPS);
async function until(label, fn, timeoutMs, everyMs = 100, soft = false) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { (soft ? notes : fails).push(`Timeout: ${label}`); say('TIMEOUT', { label, soft }); return null; }
    await sleep(everyMs);
  }
}

/* ---------------------------------------------------------------- Pixels */

/** RGBA image → RGBA of specified size (each target pixel averages covered area; premultiplied alpha) */
function resized(png, width, height) {
  const out = new Float32Array(width * height * 4);
  const sx = png.width / width, sy = png.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < png.height; yy++) {
        for (let xx = x0; xx < x1 && xx < png.width; xx++) {
          const i = (yy * png.width + xx) * 4, k = png.data[i + 3] / 255;
          r += png.data[i] * k; g += png.data[i + 1] * k; b += png.data[i + 2] * k; a += k; n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = a ? r / a : 0; out[o + 1] = a ? g / a : 0; out[o + 2] = a ? b / a : 0; out[o + 3] = a / n;
    }
  }
  return { width, height, data: out };
}
/**
 * How similar preview screenshot (checkerboard underneath, background color unknown) is to a frame
 * in export page (transparent background): compare colors only on **fully opaque pixels of this
 * exported frame**.
 * For the correct frame, its opaque area covers exactly the card in screenshot, difference is very
 * small; off by one frame (this card moves 10px per frame), a strip of that area sits on the
 * checkerboard and shifted text, difference is noticeably larger.
 */
function opaqueDiff(shot, ref) {
  let sum = 0, n = 0;
  for (let i = 0; i < ref.data.length; i += 4) {
    if (ref.data[i + 3] < 0.995) continue;
    sum += Math.abs(shot.data[i] - ref.data[i]) + Math.abs(shot.data[i + 1] - ref.data[i + 1]) + Math.abs(shot.data[i + 2] - ref.data[i + 2]);
    n += 3;
  }
  return n ? sum / n : Infinity;
}

const out = { out: OUT, clip: { first: FIRST, last: LAST }, clicks: CLICKS, steps: STEPS };
await fs.mkdir(OUT, { recursive: true });
let dev = null, bakery = null, browser = null;
const started = Date.now();
try {
  let origin = GIVEN_ORIGIN;
  if (!origin) {
    process.env.PROMPTCUT_EXPORT_DIR = path.join(OUT, 'export');
    await fs.mkdir(process.env.PROMPTCUT_EXPORT_DIR, { recursive: true });
    dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'scrube2e' });
    origin = dev.origin;
    say('spawn', { pid: dev.pid, port: PORT });
  }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;

  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 2560, height: 1600 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  const stagePorts = (ports.ports ?? []).slice(0, 2).map(String);
  const store = (fn, ...a) => page.evaluate(async (src, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src)(actions, getState, a2);
  }, fn, a);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && stagePorts.some((p) => f.url().includes(`:${p}/`)));
  const frontId = () => page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
  const frontFrame = async () => { const id = await frontId(); return stageFrames().find((f) => f.url().includes(`id=${id}`)) ?? null; };
  const parentDiag = () => page.evaluate(() => {
    const d = window.__pcPreviewDiag?.();
    return d ? { frontId: d.frontId, suppressed: d.suppressed, streamPlanes: d.streamPlanes, setTimeLog: d.setTimeLog, swapInFlight: d.swapInFlight,
      heavy: d.snapshotFeed?.heavy ?? [], scrub: d.snapshotFeed?.scrub ?? [], streams: d.snapshotFeed?.streams ?? [], picks: (d.snapshotFeed?.picks ?? []).map((p) => p.clipId), mounted: (d.snapshotFeed?.mounted ?? []).map((p) => p.clipId) } : null;
  });
  const storeT = () => page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);

  /* ---------------------------------------------------------------- 0. Project */
  const clipId = await store(`actions.newProject('scrub-stream-${RUN}');
    const c = actions.addCardClip('r6-stateful', args[0], { duration: args[1], params: {} });
    if (c && args[2]) {
      const p = getState().project;
      actions.setProjectMeta({ camera3dFov: 50 });
      actions.setClipFrame(c.id, { x: p.width / 2, y: p.height / 2, w: Math.round(p.width * 0.7), h: Math.round(p.height * 0.36), anchor: [0.5, 0.5], rotateY: 35, rotateX: 12 });
    }
    actions.seek(0);
    return c?.id;`, CLIP_START, CLIP_SECONDS, TILT);
  out.clipId = clipId;
  if (!check(!!clipId, 'Card added')) throw new Error('No card');
  const project = await page.evaluate(async () => JSON.parse(JSON.stringify((await import('/src/store/project.ts')).getState().project)));
  out.project = { width: project.width, height: project.height, fps: project.fps, duration: project.duration };
  if (TILT) {
    const placed = project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    out.tilt = { camera3dFov: project.camera3dFov ?? null, frame: placed?.frame ?? null };
    check(project.camera3dFov === 50 && placed?.frame?.rotateY === 35, '--tilt: this card\'s frame carries a 3D transform and the project has perspective enabled', out.tilt);
  }
  check(project.fps === FPS, 'the project is 30 frames per second', project.fps);
  const pinHeavy = (persist = false, patch = {}) => page.evaluate(async (id, persist, patch) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const keys = clipIdentityOf(getState().project).identityKeys;
    const costs = pd.currentCosts();
    const device = costs[0]?.device ?? 'probe';
    const rec = { ...(costs.find((r) => r.identityKey === keys[id]) ?? { identityKey: keys[id], device }), pinnedHeavy: true, ...patch };
    pd.mergePlanCosts([rec]);
    if (persist && typeof rec.stepMs === 'number') await fetch('/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [rec] }) });
    return { vtOk: rec.vtOk ?? null, seekOk: rec.seekOk ?? null, stepMs: rec.stepMs ?? null };
  }, clipId, persist, patch);
  await until('This card\'s cost record', () => page.evaluate(async (id) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const key = clipIdentityOf(getState().project).identityKeys[id];
    return pd.currentCosts().some((r) => r.identityKey === key && typeof r.stepMs === 'number');
  }, clipId), 180000, 500, true);
  out.costRecord = await pinHeavy(true);
  const prerender = await (await fetch(origin + '/api/prerender/info')).json();
  const segCount = Math.ceil((LAST - FIRST + 1) / SEG);
  const layersNow = () => page.evaluate(async (id) => {
    const m = await import('/src/editor/snapshotFeed.ts');
    const byKind = m.currentReadyIndex().get(id);
    return byKind ? Object.fromEntries([...byKind].map(([k, v]) => [k, { key: v.key, ranges: v.ranges, originFrame: v.originFrame ?? null }])) : null;
  }, clipId);
  const startedPrerender = Date.now();
  const ready = await until('All segments of this card\'s track stream at full density', async () => {
    const k = await page.evaluate(async () => (await import('/src/render/dataMirror.ts')).mirrorKey());
    if (!k) return null;
    // Re-pin and re-save in every round: after the page finishes the second pass of testing, it rewrites
    // this entire cost record, the bit for pinning as heavy card gets wiped, and the prerender process
    // no longer produces it
    await pinHeavy(true);
    await fetch(prerender.url + '/api/frames/preload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: k.session, localRev: k.localRev, lane: 'background' }) }).catch(() => {});
    const layers = await layersNow();
    if (!layers?.stream || !(layers.stream.ranges ?? []).some((r) => r[0] <= 0 && r[1] >= segCount - 1)) return null;
    const manifest = await fetch(`${prerender.url}/api/frames/stream/${encodeURIComponent(layers.stream.key)}/manifest`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null), () => null);
    if (!manifest) return null;
    for (let n = 0; n < segCount; n++) if ((manifest.segments?.[n]?.stride ?? 0) !== 1) return null;
    return { layers, manifest };
  }, 900000, 2000);
  if (!ready) throw new Error('Track stream was not produced');
  out.produceMs = Date.now() - startedPrerender;
  out.ready = { stream: ready.layers.stream, hasSnapshotLayer: !!(ready.layers.html || ready.layers.local), snapshotFrames: (ready.layers.html?.ranges ?? ready.layers.local?.ranges ?? []).reduce((n, r) => n + r[1] - r[0] + 1, 0),
    bound: ready.manifest.bound, tight: ready.manifest.tight };
  say('stream-ready', { ms: out.produceMs, ...out.ready });
  check(ready.layers.stream.originFrame === FIRST, `The first frame of this stream is frame ${FIRST} (not a multiple of 15)`, ready.layers.stream);
  await pinHeavy();
  await sleep(500);
  check((await parentDiag())?.heavy.includes(clipId) || true, 'This card is classified as heavy in the parent page\'s dispatch table');

  /* ---------------------------------------------------------------- Reference: export page frame by frame */
  const emptyUrl = emptyUrlOf(origin, { width: project.width, height: project.height });
  bakery = await openBakery({ url: emptyUrl });
  await bakery.reset(project, emptyUrl);
  bakery.streamLease = null;
  const exported = new Map();
  const refDir = path.join(OUT, 'ref');
  await fs.mkdir(refDir, { recursive: true });
  await bakeFrames(bakery, { out: refDir, fps: FPS, frames: `0-${LAST + 2}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
    onFrame: async (i, buf) => { exported.set(i, PNG.sync.read(Buffer.from(buf))); } });
  say('exported', { frames: exported.size });

  /* ---------------------------------------------------------------- Observations on the stage side */
  const stageBox = () => page.evaluate(() => {
    const f = [...document.querySelectorAll('iframe')].filter((el) => /stage=1/.test(el.src) && getComputedStyle(el).opacity !== '0')
      .map((el) => el.getBoundingClientRect()).find((r) => r.width > 100);
    return f ? { x: Math.round(f.left), y: Math.round(f.top), width: Math.round(f.width), height: Math.round(f.height) } : null;
  });
  /**
   * Capture visible stage in preview and compare with several export page frames (export frames
   * scaled to screenshot size, comparing only opaque region of export frame, see `opaqueDiff`):
   * return the most similar frame
   */
  const refCache = new Map();
  const shootAndScore = async (candidates, saveAs = null) => {
    const f = await frontFrame();
    await f?.evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r())))).catch(() => {});
    const box = await stageBox();
    if (!box) return { error: 'Visible stage not found' };
    const buf = await page.screenshot({ clip: box });
    if (saveAs) await fs.writeFile(path.join(OUT, saveAs), buf);
    const png = PNG.sync.read(buf);
    const shot = { width: png.width, height: png.height, data: png.data };
    const scores = [...new Set(candidates)].filter((c) => exported.has(c)).map((c) => {
      const key = `${c}|${png.width}x${png.height}`;
      if (!refCache.has(key)) { refCache.set(key, resized(exported.get(c), png.width, png.height)); if (refCache.size > 80) refCache.delete(refCache.keys().next().value); }
      return [c, round2(opaqueDiff(shot, refCache.get(key)))];
    });
    const sorted = [...scores].sort((x, y) => x[1] - y[1]);
    return { best: sorted[0]?.[0] ?? null, mean: sorted[0]?.[1] ?? null, runnerUp: sorted[1]?.[1] ?? null, scores, size: [png.width, png.height] };
  };
  /** Current appearance of this card in the visible stage */
  const cardState = async () => {
    const f = await frontFrame();
    if (!f) return null;
    return f.evaluate((id) => {
      const d = window.__pcStageDiag();
      const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
      const track = d.streams.tracks.find((t) => t.id.split('#')[0] === id) ?? null;
      const plane = wrap?.querySelector(':scope > canvas[data-pc-stream-plane]') ?? null;
      const live = wrap ? [...wrap.children].filter((el) => !el.hasAttribute('data-pc-stream-plane') && !el.hasAttribute('data-pc-snapshot-plane')
        && !el.hasAttribute('data-pc-placeholder-slot') && !el.hasAttribute('data-pc-proxy-plane')) : [];
      const hiddenEl = (el) => { const cs = getComputedStyle(el); return cs.display === 'none' || cs.visibility === 'hidden'; };
      const slot = wrap?.querySelector(':scope > [data-pc-placeholder-slot]') ?? null;
      return {
        t: d.t, role: d.role, cls: wrap?.className ?? null, mounted: !!wrap,
        suppressed: d.suppressed.includes(id), named: d.parentSuppressed.includes(id), waiting: d.streamWaiting.includes(id), settling: d.settling.includes(id), awaiting: d.awaiting.includes(id),
        snapshot: d.snapshots.includes(id) || !!wrap?.querySelector(':scope > [data-pc-snapshot-plane]'),
        planes: d.streamPlanes.length, track: track && { lastDrawn: track.lastDrawn, want: track.want, stale: track.stale, level: track.level, lastSeek: track.lastSeek, seeks: track.seeks, deferred: track.deferred, errors: track.errors, lastError: track.lastError },
        planeShown: !!plane && getComputedStyle(plane).display !== 'none', liveCount: live.length, liveHidden: live.length > 0 && live.every(hiddenEl),
        placeholder: d.placeholders.includes(id) || (!!slot && !slot.hidden),
      };
    }, clipId).catch((e) => ({ error: String(e).slice(0, 200) }));
  };
  /**
   * Frame-by-frame sampler (installed on both stages; records only the visible one): whether this
   * card has moments where "live subtree is hidden and stream has no visuals", moments where live
   * visuals and stream overlap, placeholders, or snapshots; records an entry when state changes.
   */
  const installSampler = async () => {
    for (const f of stageFrames()) {
      await f.evaluate((id) => {
        const now = () => (window.__pcRealNow ?? (() => Date.now()))();
        const raf = window.__pcRealRaf ?? window.requestAnimationFrame.bind(window);
        const st = window.__probeSampler = { on: true, samples: 0, empty: 0, emptyRuns: [], both: 0, placeholder: 0, snapshot: 0, waitingRuns: [], drawn: new Set(), log: [] };
        let eStart = null, wStart = null, lastKey = '';
        const began = now();
        const tick = () => {
          if (!st.on) return;
          const d = window.__pcStageDiag?.();
          if (d && d.role === 'front') {
            const at = now();
            const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
            if (wrap) {
              st.samples++;
              const track = d.streams.tracks.find((t) => t.id.split('#')[0] === id);
              const plane = wrap.querySelector(':scope > canvas[data-pc-stream-plane]');
              const streamOn = !!track && track.lastDrawn !== null && !!plane && getComputedStyle(plane).display !== 'none';
              const hidden = /\bpc-(suppressed|settling|awaiting|snapshot)\b/.test(wrap.className);
              const snap = d.snapshots.includes(id);
              const slot = wrap.querySelector(':scope > [data-pc-placeholder-slot]');
              const ph = d.placeholders.includes(id) || (!!slot && !slot.hidden);
              if (streamOn) st.drawn.add(track.lastDrawn);
              const empty = hidden && !streamOn && !snap;
              if (empty) { st.empty++; if (eStart === null) eStart = at; } else if (eStart !== null) { st.emptyRuns.push(Math.round(at - eStart)); eStart = null; }
              if (!hidden && streamOn) st.both++;
              if (ph) st.placeholder++;
              if (snap) st.snapshot++;
              const waiting = d.streamWaiting.includes(id);
              if (waiting) { if (wStart === null) wStart = at; } else if (wStart !== null) { st.waitingRuns.push(Math.round(at - wStart)); wStart = null; }
              const key = `f${Math.round(d.t * 30)}|${track ? track.lastDrawn : '-'}|${hidden ? 'hid' : 'live'}|${streamOn ? 'stream' : '-'}|${waiting ? 'wait' : '-'}|${d.settling.includes(id) ? 'settling' : '-'}|${snap ? 'snap' : '-'}|${ph ? 'ph' : '-'}`;
              if (key !== lastKey && st.log.length < 400) { lastKey = key; st.log.push(`${Math.round(at - began)}ms ${key}`); }
            }
            st.flush = () => { if (eStart !== null) { st.emptyRuns.push(Math.round(now() - eStart)); eStart = null; } if (wStart !== null) { st.waitingRuns.push(Math.round(now() - wStart)); wStart = null; } };
          }
          raf(tick);
        };
        raf(tick);
      }, clipId).catch(() => {});
    }
  };
  const collectSampler = async () => {
    const total = { samples: 0, empty: 0, emptyRuns: [], both: 0, placeholder: 0, snapshot: 0, waitingRuns: [], drawn: [], log: [] };
    for (const f of stageFrames()) {
      const s = await f.evaluate(() => {
        const st = window.__probeSampler;
        if (!st) return null;
        st.flush?.();
        st.on = false;
        return { samples: st.samples, empty: st.empty, emptyRuns: st.emptyRuns, both: st.both, placeholder: st.placeholder, snapshot: st.snapshot, waitingRuns: st.waitingRuns, drawn: [...st.drawn], log: st.log };
      }).catch(() => null);
      if (!s) continue;
      for (const k of ['samples', 'empty', 'both', 'placeholder', 'snapshot']) total[k] += s[k];
      total.emptyRuns.push(...s.emptyRuns); total.waitingRuns.push(...s.waitingRuns); total.drawn.push(...s.drawn); total.log.push(...s.log);
    }
    total.drawn = [...new Set(total.drawn)].sort((a, b) => a - b);
    return total;
  };
  /**
   * Common assertion for this sampling segment: no blank moments, no placeholders, no snapshots,
   * live visuals and stream do not overlap
   */
  const checkSampler = (label, s) => {
    check(s.samples > 0, `${label}: samples were collected`, s.samples);
    check(s.empty === 0, `${label}: this card never has a moment when "the live subtree is hidden and the stream has no picture"`, { empty: s.empty, runs: s.emptyRuns, log: s.log.slice(0, 40) });
    check(s.placeholder === 0, `${label}: the placeholder was not shown`, { placeholder: s.placeholder, log: s.log.slice(0, 40) });
    check(s.snapshot === 0, `${label}: no snapshot is mounted at all (with a stream, snapshots are not read)`, { snapshot: s.snapshot, log: s.log.slice(0, 40) });
    check(s.both === 0, `${label}: there is no moment when the live picture and the stream are stacked together`, { both: s.both, log: s.log.slice(0, 40) });
  };

  /**
   * After stopping: this card returns to exact live render: unsuppressed, live subtree visible,
   * no snapshots, no placeholders; stream plane hidden, this frame already decoded; parent page
   * continues sending stream plane
   */
  const waitSettled = async (label, frame) => {
    const began = Date.now();
    const state = await until(`${label}: back to the exact live render after stopping`, async () => {
      const s = await cardState();
      const p = await parentDiag();
      if (!s || s.error || !p || !s.mounted) return null;
      const exact = !s.suppressed && !s.named && !s.waiting && !s.settling && !s.awaiting && !s.snapshot && !s.liveHidden && s.liveCount > 0 && !s.placeholder
        && !p.swapInFlight && !p.suppressed.length && Math.abs(s.t - frame / FPS) < 0.5 / FPS;
      return exact ? { s, p } : null;
    }, 60000, 40);
    if (!state) { say('not-settled', { card: await cardState(), parent: await parentDiag() }); return { ok: false, ms: Date.now() - began }; }
    // Decode this frame first (stream plane hidden): wait briefly for it to decode
    const warm = await until(`${label}: after stopping, the stream plane is hidden and this frame is already decoded`, async () => {
      const s = await cardState();
      return s && s.track && s.track.lastDrawn === frame && !s.planeShown && s.planes === 1 ? s : null;
    }, 8000, 40);
    const p = await parentDiag();
    check(!!warm, `${label}: after stopping, the stream plane is hidden and the frame under the playhead is already decoded`, await cardState());
    check(p.streams.length === 1 && p.scrub.length === 0 && p.picks.length === 0 && p.mounted.length === 0, `${label}: after stopping, the parent page still emits the stream plane, does not suppress, and picks no snapshot`, p);
    return { ok: true, ms: Date.now() - began, frontId: p.frontId };
  };

  /**
   * For the visual after stopping (exact live render), initially only record which frame of the
   * export page it looks most like; wait until the end when this card is released back to a light
   * card and the delta "how many frames live render differs from export page without stream paste"
   * is measured, then evaluate together (see "Reference for live render" in header).
   */
  const liveChecks = [];
  const noteLive = (label, frame, score) => { liveChecks.push({ label, frame, best: score.best ?? null, mean: score.mean ?? null, runnerUp: score.runnerUp ?? null, scores: score.scores }); };

  /* ---------------------------------------------------------------- 1. Click timeline to jump across */
  await store(`actions.pause(); actions.seek(args[0]);`, (FIRST + 5) / FPS);
  await waitSettled('Start', FIRST + 5);
  out.click = [];
  for (const f of CLICKS) {
    await installSampler();
    const began = Date.now();
    await store(`actions.pause(); actions.seek(args[0]);`, f / FPS);
    const settled = await waitSettled(`Click to frame ${f}`, f);
    const sampler = await collectSampler();
    checkSampler(`Click to frame ${f}`, sampler);
    const score = await shootAndScore([f - 1, f, f + 1, f + 2], f === CLICKS[0] ? `click-${f}-settled.png` : null);
    noteLive(`Click to frame ${f}`, f, score);
    out.click.push({ frame: f, settledMs: settled.ms, wallMs: Date.now() - began, waitingRuns: sampler.waitingRuns, streamDrawn: sampler.drawn, best: score.best, mean: score.mean, runnerUp: score.runnerUp, log: sampler.log.slice(0, 14) });
  }
  say('1-click', { clicks: out.click.map((c) => ({ frame: c.frame, settledMs: c.settledMs, drawn: c.streamDrawn, best: c.best })) });

  /* ---------------------------------------------------------------- 2. Hold ruler and scrub */
  const ruler = await page.evaluate(() => {
    const el = document.querySelector('[data-pc="ruler"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const ticks = [...el.querySelectorAll('.pc-tl-tick.is-major')].map((t) => {
      const label = t.querySelector('.pc-tl-tick-label')?.textContent ?? '';
      const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(label.trim());
      return m ? { sec: Number(m[1]) * 60 + Number(m[2]), x: t.getBoundingClientRect().left } : null;
    }).filter(Boolean);
    return { left: r.left, right: r.right, y: r.top + r.height / 2, ticks };
  });
  if (!ruler || ruler.ticks.length < 2) throw new Error('Cannot measure the ruler ticks');
  const tk0 = ruler.ticks[0], tk1 = ruler.ticks[ruler.ticks.length > 2 ? 2 : 1];
  const pxPerSec = (tk1.x - tk0.x) / (tk1.sec - tk0.sec);
  await store(`actions.pause(); actions.seek(args[0]);`, 2);
  await sleep(300);
  const head = await page.evaluate(async () => {
    const el = document.querySelector('[data-pc="playhead"]');
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, t: (await import('/src/store/project.ts')).getState().t } : null;
  });
  let xZero = head ? head.x - head.t * pxPerSec : tk0.x - tk0.sec * pxPerSec;
  out.ruler = { pxPerSec: +pxPerSec.toFixed(3), xZero: +xZero.toFixed(2) };
  check(pxPerSec / FPS >= 2, 'At least 2 pixels per frame on the ruler (the pointer lands accurately)', out.ruler);
  // Target center of the cell for this frame: converting pointer position to time rounds down to
  // the frame cell
  const xOf = (frame) => xZero + ((frame + 0.5) / FPS) * pxPerSec;
  const moveToFrame = async (frame, { down = false } = {}) => {
    let landed = null;
    for (const dx of [0, 1, -1, 2, -2]) {
      await page.mouse.move(Math.round(xOf(frame)) + dx, ruler.y);
      if (down && landed === null) await page.mouse.down();
      const deadline = Date.now() + 600;
      while (Date.now() < deadline && frameOf(await storeT()) !== frame) await sleep(30);
      landed = frameOf(await storeT());
      if (landed === frame) { if (dx) xZero += dx; break; }
    }
    return landed;
  };
  {
    await waitSettled('Before drag', 60);
    await installSampler();
    await page.keyboard.down('Alt');   // Does not snap to whole seconds / clip boundaries; which frame it lands on is determined by coordinates
    const steps = [];
    let prev = frameOf(await storeT());
    for (let i = 0; i < STEPS.length; i++) {
      const target = STEPS[i];
      const sent = Date.now();
      const landed = await moveToFrame(target, { down: i === 0 });
      const step = { i, target, landed, from: prev, sample: (target - FIRST) % SEG, backwards: target < prev };
      prev = landed;
      steps.push(step);
      if (!check(landed === target, `Drag step ${i} lands on frame ${target}`, { landed })) continue;
      const state = await until(`Drag step ${i} (frame ${target}): the stream draws this frame`, async () => {
        const s = await cardState();
        return s && !s.error && s.track && s.track.lastDrawn === target && !s.track.stale && Math.abs(s.t - target / FPS) < 1e-6 ? s : null;
      }, 15000, 15);
      step.wallMs = Date.now() - sent;
      const s = state ?? await cardState();
      const p = await parentDiag();
      step.seekMs = s?.track?.lastSeek?.frame === target ? s.track.lastSeek.ms : null;
      if (s && !s.error) {
        check(s.suppressed && /\bpc-suppressed\b/.test(s.cls ?? '') && s.liveHidden, `Drag step ${i}: this card is suppressed and the live subtree is hidden`, s);
        check(s.planeShown && s.track?.level === 'dense', `Drag step ${i}: the stream plane is exposed, showing this frame at full density`, s);
        check(!s.placeholder && !s.snapshot && !s.awaiting, `Drag step ${i}: no placeholder, no snapshot, not waiting for a snapshot`, s);
        check((s.track?.errors ?? 0) === 0, `Drag step ${i}: no decode errors`, s.track);
      }
      check(p.suppressed.includes(clipId) && p.streams.length === 1 && p.picks.length === 0 && p.mounted.length === 0, `Drag step ${i}: the parent page suppresses it, emits its stream plane, and picks no snapshot`, p);
      check(p.setTimeLog.at(-1)?.settle === false, `Drag step ${i}: this setTime call does not carry "settle"`, p.setTimeLog.at(-1));
      const score = await shootAndScore([target - 1, target, target + 1], [57, 115, 99].includes(target) ? `drag-${target}-stream.png` : null);
      step.best = score.best; step.mean = score.mean; step.runnerUp = score.runnerUp;
      check(score.best === target, `Drag step ${i}: the screenshot is closest to frame ${target} of the export page (closer than both the previous and the next frame)`, score);
    }
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const last = STEPS.at(-1);
    const settled = await waitSettled('Release', last);
    const sampler = await collectSampler();
    checkSampler('Entire drag', sampler);
    const score = await shootAndScore([last - 1, last, last + 1, last + 2], `drag-${last}-settled.png`);
    noteLive('Drag release', last, score);
    out.drag = { steps, releaseMs: settled.ms, waitingRuns: sampler.waitingRuns, samples: sampler.samples, drawn: sampler.drawn, settledBest: score.best, log: sampler.log.slice(0, 60) };
    say('2-drag', { steps: steps.map((s) => ({ target: s.target, landed: s.landed, wallMs: s.wallMs, seekMs: s.seekMs, best: s.best, mean: s.mean, runnerUp: s.runnerUp })), releaseMs: settled.ms, waitingRuns: sampler.waitingRuns });
  }

  /* ---------------------------------------------------------------- 3. Start playback while paused; pause during playback (several rounds, different start points and durations) */
  out.play = [];
  for (const [round, [from, playMs]] of [[60, 900], [45, 500], [72, 1100], [50, 700]].entries()) {
    await store(`actions.pause(); actions.seek(args[0]);`, from / FPS);
    await waitSettled(`Before playback starts in round ${round}`, from);
    await installSampler();
    for (const f of stageFrames()) await f.evaluate(() => { window.__pcFallbackTrace = []; }).catch(() => {});
    await store(`actions.play();`);
    await sleep(playMs);
    await store(`actions.pause();`);
    await sleep(60);
    const traces = [];
    for (const f of stageFrames()) {
      const t = await f.evaluate(() => (Array.isArray(window.__pcFallbackTrace) ? window.__pcFallbackTrace.splice(0) : null)).catch(() => null);
      if (t?.length) traces.push(...t);
      await f.evaluate(() => { delete window.__pcFallbackTrace; }).catch(() => {});
    }
    const beats = traces.map((b) => ({ frame: Math.round(b.sec * FPS), level: b.levels[clipId] ?? null, snapshots: b.snapshots }));
    const stopped = frameOf(await storeT());
    const settled = await waitSettled(`Pause during playback in round ${round}`, stopped);
    const sampler = await collectSampler();
    checkSampler(`Round ${round}, entire run from playback start to pause`, sampler);
    const notDense = beats.filter((b) => b.level !== 'dense');
    check(beats.length >= 8, `Round ${round}: played a stretch`, beats.length);
    check(beats[0]?.frame === from + 1 && beats[0]?.level === 'dense', `Round ${round} playback start: on the first tick this card already shows the stream's picture (this frame was already decoded while paused)`, beats.slice(0, 3));
    check(notDense.length === 0, `Round ${round} playback: every tick shows the full-density stream picture (no empty ticks, no placeholders, no snapshots)`, notDense.slice(0, 5));
    check(beats.every((b) => b.snapshots === 0), `Round ${round} playback: there is not a single snapshot on the stage`, beats.filter((b) => b.snapshots).slice(0, 3));
    const score = await shootAndScore([stopped - 1, stopped, stopped + 1, stopped + 2], round === 0 ? `pause-${stopped}-settled.png` : null);
    noteLive(`Pause during playback in round ${round}`, stopped, score);
    const entry = { from, stoppedAt: stopped, beats: beats.length, firstBeat: beats[0] ?? null, notDense: notDense.length, settleMs: settled.ms, waitingRuns: sampler.waitingRuns, best: score.best, mean: score.mean };
    if (!(score.mean < 12 && score.runnerUp > 1.8 * score.mean)) {
      // Matches no frame: save image, expand to 12 frames before and after to find which frame it
      // actually resembles, and preserve how the stage and parent page looked at that moment
      await sleep(400);
      const wide = await shootAndScore(Array.from({ length: 25 }, (_, i) => stopped - 12 + i), `pause-${stopped}-mismatch.png`);
      Object.assign(entry, { wideBest: [...wide.scores].sort((x, y) => x[1] - y[1]).slice(0, 3), setTimeLog: (await parentDiag()).setTimeLog.slice(-4), logTail: sampler.log.slice(-16), card: await cardState() });
    }
    out.play.push(entry);
    say('3-play', entry);
  }

  /* ---------------------------------------------------------------- 4. Global-clock-only cards: swap after background whole scene catch-up run */
  {
    const before = await frontId();
    await pinHeavy(false, { vtOk: false });
    await sleep(300);
    await installSampler();
    const f = 96;
    await store(`actions.pause(); actions.seek(args[0]);`, f / FPS);
    const swapped = await until('Swap after the background catch-up run', async () => ((await frontId()) !== before && !(await parentDiag())?.swapInFlight ? true : null), 60000, 50, true);
    const settled = await waitSettled('After the swap', f);
    const sampler = await collectSampler();
    const after = await frontId();
    const score = await shootAndScore([f - 1, f, f + 1, f + 2], `swap-${f}-settled.png`);
    out.swap = { frame: f, before, after, swapped: !!swapped, settleMs: settled.ms, best: score.best, empty: sampler.empty, placeholder: sampler.placeholder, snapshot: sampler.snapshot, both: sampler.both, log: sampler.log.slice(0, 30) };
    say('4-swap', out.swap);
    check(!!swapped && after !== before, 'Heavy card that follows only the global clock: after stopping, the visible stage was swapped for the other one', out.swap);
    check(sampler.empty === 0 && sampler.placeholder === 0 && sampler.snapshot === 0, 'Swap path: no empty moment, no placeholder, no snapshot throughout', { empty: sampler.empty, placeholder: sampler.placeholder, snapshot: sampler.snapshot, log: sampler.log.slice(0, 40) });
    check(sampler.both === 0, 'Swap path: the stream did not cover the already-exact live picture', { both: sampler.both, log: sampler.log.slice(0, 40) });
    noteLive('After the background catch-up swap', f, score);
    await pinHeavy(false, { vtOk: out.costRecord.vtOk ?? true });
  }
  /* ---------------------------------------------------------------- 5. Reference for live render: release back to light card (no stream paste), measure frame delta between live render and export page, then evaluate each recorded place above */
  {
    await pinHeavy(false, { pinnedHeavy: false, vtOk: out.costRecord.vtOk ?? true });
    await until('This card is back to a light card (the parent page no longer classifies it as heavy)', async () => { const p = await parentDiag(); return p && !p.heavy.includes(clipId) ? true : null; }, 20000, 100);
    const seen = [];
    let shift = null;
    for (const f of [85, 110, 64, 97, 73, 118, 52, 104]) {
      await store(`actions.pause(); actions.seek(args[0]);`, f / FPS);
      const score = await until(`Light card: the live render at frame ${f} matches some frame of the export page`, async () => {
        const st = await cardState();
        if (!st || st.error || st.suppressed || st.settling || st.liveHidden) return null;
        const r = await shootAndScore([f - 2, f - 1, f, f + 1, f + 2]);
        return r.best !== null && r.mean < 12 && r.runnerUp > 1.8 * r.mean ? r : null;
      }, 8000, 300, true);
      seen.push({ frame: f, best: score?.best ?? null, mean: score?.mean ?? null });
      // If three consecutive locations have the same delta, settle on it
      const last3 = seen.slice(-3).map((x) => (x.best === null ? null : x.best - x.frame));
      if (last3.length === 3 && last3[0] !== null && last3.every((d) => d === last3[0])) { shift = last3[0]; break; }
    }
    out.liveReference = { seen, shift };
    say('5-live-reference', out.liveReference);
    if (check(shift !== null && Math.abs(shift) <= 1, 'When the stream is not applied (light card), the offset between the preview\'s live render and the export page is a constant, at most one frame', seen)) {
      const wrong = liveChecks.filter((c) => c.best !== c.frame + shift);
      out.liveChecks = { total: liveChecks.length, shift, wrong: wrong.slice(0, 6), wrongCount: wrong.length, means: liveChecks.map((c) => c.mean) };
      say('5-live-checks', out.liveChecks);
      check(liveChecks.length >= 8 && wrong.length === 0, `After the stream is applied and playback stops, every picture is the one the live render shows without the stream (${liveChecks.length} places in total; the ${shift}-frame offset from the export page already exists for this probe card on main)`, wrong.slice(0, 4));
    }
  }
  out.pageErrors = pageErrors.slice(0, 5);
  check(pageErrors.length === 0, 'Page has no uncaught errors', pageErrors.slice(0, 3));
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await bakery?.close(); } catch { /* ignore */ }
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (!/\.(json|png|log|err)$/.test(name)) await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.elapsedMs = Date.now() - started;
out.notes = notes;
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(out.ok ? 'PASS' : `FAIL ${fails.length}`);
process.exit(out.ok ? 0 : 1);
