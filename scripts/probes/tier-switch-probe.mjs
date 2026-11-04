/**
 * End-to-end probe for two-tier asset tier switch (`docs/plan/c66-design.md` section 4, acceptance
 * checks T5 / T6 / T7): real editor in real Chrome, assets come from a "remote asset service",
 * pulled on demand via local asset service read routing.
 *
 *   node scripts/probes/tier-switch-probe.mjs --origin http://127.0.0.1:5570 [--remote-port 5575] [--out <dir>]
 *
 * dev server starts per allocated port range: `npx vite --port 5570 --strictPort --host 127.0.0.1`
 * (stage ports 5571 / 5572). The "remote asset service" is started by this probe itself on
 * `--remote-port` (only implements endpoints used by this probe in contract: `GET media/<hash>`
 * (including Range), `GET media/<hash>/chunks`, cross-origin preflight); whether each tier is
 * `complete` is controlled by the probe.
 *
 * Test assets are generated on the fly with ffmpeg (design doc section 8 "Test assets"): 1280×720,
 * 30 fps, 6 seconds, a 10-block black-and-white bar at top of video encodes frame numbers in
 * binary (block k lit = bit k of frame number is 1); small-size asset is converted per design
 * doc small-size asset command (800×450), ProRes original-size asset converts same video with
 * `prores_ks`. Writes a random string in metadata on each run so hash differs each time, avoiding
 * hitting files left in local content store from previous runs.
 *
 * Scenarios:
 *   T5a (tier switch while paused): asset layer transparent at first (not connected to remote yet,
 *        neither tier arrived, "Waiting for uploader" in corner) -> connected to remote, only
 *        small-size asset arrived: small-size asset appears -> original-size asset arrived: switch
 *        to original-size asset within next polling interval; decoded frame numbers before and after
 *        tier switch at same target time (2.5 s) differ by no more than one frame, frame-by-frame
 *        sampling during tier switch has no black frames.
 *   T5b (tier switch during playback): small-size asset is playing, original-size asset arrives
 *        midway; at tier switch moment, frame number jump between adjacent frames matches time
 *        difference (error ≤ 1 frame), no black frames.
 *   T6 : Original-size asset is ProRes: local probe detects it cannot be played (recorded as 0 in
 *        device local cache), stays on small-size asset even when both tiers arrive.
 *   T7 : Export when original-size asset has not arrived: `exportVideo` rejects with "Waiting for
 *        uploader", clicking export in top bar pops up the same notice, no export request is sent.
 *   T5c (paused, original-size asset arrives slowly; `docs/archive/agent-reports/AGENT-tier-reload-seek.md`):
 *        Same as beginning of T5a (waiting for uploader first, original-size asset URL attach failed
 *        previously); after original-size asset is reported ready, remote holds bytes for `--hold-ms`
 *        (headers returned, no bytes served), playability probe therefore times out (recorded as
 *        "unknown"); after that probe no longer touches any page state (playhead stopped, set
 *        unchanged), must still switch to original-size asset. In cross-machine T9 `ht9a0927`,
 *        observing side stayed on small-size asset like this.
 *   T5e (paused, playability already determined, warmup slot needs reload): Same as beginning of
 *        T5a, but local machine already recorded "original-size asset can be played"; in the round
 *        original-size asset is reported ready, the slot that failed to attach before directly becomes
 *        a warmup slot and is reloaded by `load()`: reload clears freshly applied seek back to 0;
 *        after that, even without re-render, must still return to 2.5 s, yield an aligned frame,
 *        and switch tiers.
 *
 *   `--only T5a,T5c` only runs listed scenarios (runs all by default).
 *
 * Duration recorded only (verification.md "record duration only, do not use as gate"): T5a "how long
 * after complete turns true it is observed by page polling" (original gate ≤ 2600 ms) and time
 * taken by each scenario to switch to original-size asset are only written to `TIMINGS` line and
 * `timings` in result, without deciding pass/fail. Black frame count, frame numbers and frame error
 * (no more than one frame), and "Waiting for uploader" prompt remain pass conditions as before.
 * Wait timeouts are only to prevent hangs, never less than 120 seconds.
 *
 * Output: The last line is a JSON line (`ok`, key metrics for each scenario), screenshots in
 * `--out` directory.
 * How to read frame numbers: Call `drawImage` on the **visible** `<video>` in visible stage, and
 * read the 10 blocks on the top bar.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { devOrigin, flagArg } from './probe-connect.mjs';
import { createTimings } from './probe-timings.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const REMOTE_PORT = Number(flagArg('remote-port', '5575', args));
const RUN = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-tier-probe-${RUN}`));
const FPS = 30;
const ONLY = flagArg('only', null, args);
const want = (scene) => !ONLY || ONLY.split(',').map((x) => x.trim()).includes(scene);
/** T5c: How long remote holds bytes after original-size asset is reported ready (must exceed 10 s limit of remote playability probe, plus 2 s for polling) */
const HOLD_MS = Number(flagArg('hold-ms', '16000', args));
const fails = [];
const notes = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait timeout is only to prevent hangs (verification.md "record duration only, do not use as gate"): anything below WAIT_FLOOR_MS is raised to it; timing out with no result still fails */
const WAIT_FLOOR_MS = 120000;
const timings = createTimings('tier-switch-probe');
async function until(label, fn, timeoutMs, everyMs = 200) {
  const deadline = Date.now() + Math.max(timeoutMs, WAIT_FLOOR_MS);
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); return null; }
    await sleep(everyMs);
  }
}

/* ------------------------------------------------------------------ Assets */
await fs.mkdir(OUT, { recursive: true });
const ffmpeg = await findFfmpeg();
function ff(argv) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', ...argv], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}
/** A pair of assets (original-size asset + small-size asset). When `prores`, original-size asset is converted to ProRes MOV */
async function makePair(tag, { prores = false } = {}) {
  const src = path.join(OUT, `${tag}-src.mp4`);
  ff(['-f', 'lavfi', '-i', `color=c=gray:s=1280x720:r=${FPS}:d=6`,
    '-vf', "geq=lum='if(lt(Y,96),255*mod(floor(N/pow(2,floor(X/128))),2),96+64*sin(X/40+N/5))':cb=128:cr=128",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-g', '150', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-metadata', `comment=${RUN}-${tag}`, src]);
  const orig = prores ? path.join(OUT, `${tag}-orig.mov`) : src;
  if (prores) ff(['-i', src, '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-an', '-metadata', `comment=${RUN}-${tag}-p`, orig]);
  const small = path.join(OUT, `${tag}-small.mp4`);
  // Small-size asset command from section 8 of design doc (preserves VFR timestamps, drops only frames with interval < 1/60 s, limits to 800×600, even dimensions)
  ff(['-i', orig, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,1/60)',scale=w='min(iw\\,800)':h='min(ih\\,600)':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,format=yuv420p",
    '-fps_mode:v', 'vfr', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', small]);
  const read = async (f, type) => {
    const bytes = await fs.readFile(f);
    return { bytes, hash: crypto.createHash('sha256').update(bytes).digest('hex'), type };
  };
  return { orig: await read(orig, prores ? 'video/quicktime' : 'video/mp4'), small: await read(small, 'video/mp4'), ext: prores ? 'mov' : 'mp4' };
}

/* ------------------------------------------------------------------ Remote asset service */
const remoteFiles = new Map(); // hash → { bytes, type, complete }
const remoteLog = [];
/** T5c: Headers returned, bytes withheld until `holdUntil` before serving ("original-size asset still in transit" on slow links) */
function later(f, req, res, body) {
  if (req.method === 'HEAD') return res.end();
  const wait = (f.holdUntil ?? 0) - Date.now();
  if (wait > 0) setTimeout(() => res.end(body), wait);
  else res.end(body);
}
const remote = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  const m = /^\/api\/asset\/media\/([0-9a-f]{64})(\/chunks)?$/.exec(req.url.split('?')[0]);
  const f = m ? remoteFiles.get(m[1]) : null;
  remoteLog.push({ at: Date.now(), path: m ? `${m[1].slice(0, 8)}${m[2] ?? ''}` : req.url, auth: !!req.headers.authorization, range: req.headers.range ?? null });
  if (m && m[2]) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(f ? { size: f.bytes.length, chunkSize: 8388608, received: f.complete ? [0] : [], complete: !!f.complete } : { size: null, chunkSize: 8388608, received: [], complete: false }));
  }
  if (!f || !f.complete) { res.statusCode = 404; return res.end('Not found'); }
  const range = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), f.bytes.length - 1) : f.bytes.length - 1;
    res.writeHead(206, { 'Content-Type': f.type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${f.bytes.length}`, 'Accept-Ranges': 'bytes' });
    return later(f, req, res, f.bytes.subarray(start, end + 1));
  }
  res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.bytes.length, 'Accept-Ranges': 'bytes' });
  later(f, req, res, f.bytes);
});
await new Promise((r) => remote.listen(REMOTE_PORT, '127.0.0.1', r));
const REMOTE_BASE = `http://127.0.0.1:${REMOTE_PORT}/api/asset`;
const publish = (x, complete, holdUntil = 0) => remoteFiles.set(x.hash, { bytes: x.bytes, type: x.type, complete, holdUntil });

/* ------------------------------------------------------------------ Page */
const out = { ok: false, origin, run: RUN, out: OUT, T5a: {}, T5b: {}, T5c: {}, T5e: {}, T6: {}, T7: {} };
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const exportRequests = [];
  page.on('request', (r) => { if (/\/api\/export(\/|$)/.test(r.url())) exportRequests.push(r.url()); });
  // When running other Chrome tasks in parallel, Vite initial module transform occasionally times out; only retry stage initialization.
  let booted = false;
  for (let attempt = 0; attempt < 3 && !booted; attempt++) {
    try {
      await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForFunction(async () => {
        const m = await import('/src/editor/stageBridge.ts');
        return !!m.frontStage() && m.backRole() === 'back';
      }, { timeout: 45000, polling: 500 });
      booted = true;
      out.bootstrapRetries = attempt;
      pageErrors.length = 0;
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(1000);
    }
  }
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  const stagePorts = (ports.ports ?? []).slice(0, 2).map(String);
  const store = (fn, ...a) => page.evaluate(async (src, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src)(actions, getState, a2);
  }, fn, a);
  const tiers = (fn, ...a) => page.evaluate(async (src, a2) => {
    const T = await import('/src/editor/media/assetTiers.ts');
    const AsyncFunction = (async () => {}).constructor;
    return new AsyncFunction('T', 'args', src)(T, a2);
  }, fn, a);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && stagePorts.some((p) => f.url().includes(`:${p}/`)));
  const front = async () => {
    const id = await page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
    return stageFrames().find((f) => f.url().includes(`id=${id}`)) ?? null;
  };
  const preview = async (name) => {
    const el = await page.$('[data-pc="stage-frame"]');
    const box = el ? await el.boundingBox() : null;
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, clip: box ? { x: Math.max(0, box.x - 4), y: Math.max(0, box.y - 4), width: box.width + 8, height: box.height + 8 } : undefined });
    return file;
  };
  /** What the displayed asset layer currently is: which tier, decoded frame number, whether ready, whether "Waiting for uploader" is in corner */
  const layer = async () => (await front())?.evaluate((F) => {
    const v = document.querySelector('[data-pc-media] > video');
    const awaiting = !!document.querySelector('[data-pc-media-awaiting]');
    if (!v) return { shown: false, awaiting };
    const r = { shown: true, awaiting, src: v.currentSrc || v.getAttribute('src') || '', rs: v.readyState, ct: v.currentTime, err: v.error?.code ?? null };
    if (v.readyState >= 2 && v.videoWidth) {
      const cv = document.createElement('canvas');
      cv.width = v.videoWidth; cv.height = v.videoHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0);
      const y = Math.round(cv.height * (48 / 720));
      let idx = 0;
      for (let k = 0; k < 10; k++) {
        const x = Math.round(cv.width * ((k + 0.5) / 10));
        if (ctx.getImageData(x, y, 1, 1).data[0] > 128) idx |= 1 << k;
      }
      r.idx = idx;
      r.expect = Math.round(v.currentTime * F);
    }
    return r;
  }, FPS);
  /** Sample the displayed layer frame by frame (real rAF) in visible stage until stopSampler */
  const startSampler = async () => (await front()).evaluate((F) => {
    window.__tierSamples = [];
    window.__tierSampling = true;
    window.__pcTierTrace = [];
    const cv = document.createElement('canvas');
    cv.width = 100; cv.height = 72;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const now = () => (window.__pcRealNow ?? (() => performance.now()))();
    const raf = window.__pcRealRaf ?? window.requestAnimationFrame.bind(window);
    const loop = () => {
      if (!window.__tierSampling) return;
      const v = document.querySelector('[data-pc-media] > video');
      const s = { at: now(), shown: !!v, t: window.__pcStageDiag?.().t ?? null };
      if (v) {
        s.src = (v.currentSrc || '').split('/@media/')[1]?.slice(0, 8) ?? '';
        s.rs = v.readyState;
        s.ct = v.currentTime;
        if (v.readyState >= 2 && v.videoWidth) {
          ctx.drawImage(v, 0, 0, cv.width, cv.height);
          const y = 5;
          let idx = 0;
          for (let k = 0; k < 10; k++) if (ctx.getImageData(Math.round(cv.width * ((k + 0.5) / 10)), y, 1, 1).data[0] > 128) idx |= 1 << k;
          s.idx = idx;
          // Average luminance of the lower half: fully black (< 16) is a black frame
          const d = ctx.getImageData(0, Math.round(cv.height * 0.5), cv.width, 1).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += d[i];
          s.luma = sum / (d.length / 4);
        }
      }
      window.__tierSamples.push(s);
      raf(loop);
    };
    raf(loop);
  }, FPS);
  const stopSampler = async () => (await front()).evaluate(() => {
    window.__tierSampling = false;
    const trace = window.__pcTierTrace ?? [];
    delete window.__pcTierTrace;
    const samples = window.__tierSamples.splice(0);
    samples.trace = trace;
    return { samples, trace };
  });
  /** T5b: Read actual frame when display element delivers frame; immediately subscribe to new element after DOM swaps slot. */
  const startFrameSampler = async () => (await front()).evaluate(() => {
    const frames = [];
    const watched = new Map();
    const cv = document.createElement('canvas');
    cv.width = 100; cv.height = 72;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const visible = () => document.querySelector('[data-pc-media] > video');
    const watch = () => {
      const v = visible();
      if (!v || watched.has(v)) return;
      const onFrame = (_now, meta) => {
        if (!window.__tierFrameSampler || visible() !== v) return;
        const s = { src: (v.currentSrc || '').split('/@media/')[1]?.slice(0, 8) ?? '',
          at: meta.expectedDisplayTime, mediaTime: meta.mediaTime, t: window.__pcStageDiag?.().t ?? null,
          rs: v.readyState };
        if (v.readyState >= 2 && v.videoWidth) {
          ctx.drawImage(v, 0, 0, cv.width, cv.height);
          const y = 5;
          let idx = 0;
          for (let k = 0; k < 10; k++) if (ctx.getImageData(Math.round(cv.width * ((k + 0.5) / 10)), y, 1, 1).data[0] > 128) idx |= 1 << k;
          s.idx = idx;
          const d = ctx.getImageData(0, Math.round(cv.height * 0.5), cv.width, 1).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += d[i];
          s.luma = sum / (d.length / 4);
        }
        frames.push(s);
        watched.set(v, v.requestVideoFrameCallback(onFrame));
      };
      watched.set(v, v.requestVideoFrameCallback(onFrame));
    };
    const observer = new MutationObserver(watch);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-pc-media', 'style'], subtree: true });
    window.__tierFrameSampler = { frames, watched, observer };
    watch();
  });
  const stopFrameSampler = async () => (await front()).evaluate(() => {
    const sampler = window.__tierFrameSampler;
    if (!sampler) return [];
    delete window.__tierFrameSampler;
    sampler.observer.disconnect();
    for (const [v, id] of sampler.watched) v.cancelVideoFrameCallback(id);
    return sampler.frames;
  });
  const blackOf = (samples, fromAt) => samples.filter((s) => s.at >= fromAt && (!s.shown || s.rs < 2 || !(s.luma > 16)));

  /**
   * New project + a 6-second video clip, asset record has two tiers.
   * Note: loading another project = returning to local space (syncManager's switchToLocal), and
   * current remote asset service is cleared accordingly: aligned with "loading another project in
   * a shared project = leaving shared project". Therefore, when `remote` is true, reconnect to remote
   * after creating project.
   */
  const setupProject = async (pair, name, remote = true) => {
    const r = await setupProjectOnly(pair, name);
    if (remote) await tiers(`T.setRemoteAssets({ base: args[0], ticket: async () => 'probe-ticket' });`, REMOTE_BASE);
    return r;
  };
  const setupProjectOnly = async (pair, name) => {
    await store('actions.newProject(args[0]);', name);
    // Remote assets come from a shared project. Only changing asset service address while staying in
    // local space causes local missing check to clear unfetched original-size URLs per normal rules,
    // interfering with tier switch observation. Use real collaboration entry to create an isolated
    // shared project, then let scenario control remote asset service.
    const shared = await page.evaluate(async (name) => {
      const { enableCollab } = await import('/src/editor/sync/collab.ts');
      const result = await enableCollab({ where: 'lan', mode: 'free', name,
        creator: { username: 'tier-probe', password: 'isolated-tier-probe-creator' },
        projectPassword: 'isolated-tier-probe-project' });
      return { ok: result.ok, error: result.ok ? null : result.error };
    }, name);
    if (!shared.ok) throw new Error(`Tier-switch probe shared project initialization failed: ${shared.error}`);
    return store(`
    const m = actions.addMedia({ kind: 'video', name: args[0] + '.' + args[4], url: '/@media/' + args[1], hash: args[1], ext: args[4], size: args[3],
      tiers: { original: args[1], small: args[2] }, duration: 6, width: 1280, height: 720 });
    const c = actions.addMediaClip(m.id, 0, { duration: 6 });
    actions.seek(2.5);
    return { mediaId: m.id, clipId: c && c.id };`, name, pair.orig.hash, pair.small.hash, pair.orig.bytes.length, pair.ext);
  };

  /* ============================================================ T5a: Tier switch while paused */
  if (want('T5a')) {
  const A = await makePair('a');
  publish(A.small, false);
  publish(A.orig, false);
  await tiers('T.setRemoteAssets(null);');
  const setupA = await setupProject(A, `tier-a-${RUN}`, false);
  check(setupA?.clipId, 'T5a: video clip added');
  // 1) Not connected to remote yet: neither tier on local asset service → transparent + "Waiting for uploader"
  const transparent = await until('T5a: asset layer is transparent and the corner shows "Waiting for uploader"', async () => {
    const l = await layer();
    return l && l.awaiting && !(l.shown && l.rs >= 2) ? l : null;
  }, 15000);
  out.T5a.transparent = transparent ? { awaiting: transparent.awaiting, shown: transparent.shown, rs: transparent.rs ?? null } : null;
  out.T5a.shotTransparent = await preview('t5a-1-transparent');
  // 2) Connected to remote, only small-size asset arrived → small-size asset appears
  publish(A.small, true);
  const tConnect = Date.now();
  await tiers(`T.setRemoteAssets({ base: args[0], ticket: async () => 'probe-ticket' });`, REMOTE_BASE);
  const smallUp = await until('T5a: asset small size appears', async () => {
    const l = await layer();
    return l && l.shown && l.rs >= 2 && l.src.includes(A.small.hash) && Number.isInteger(l.idx) ? l : null;
  }, 20000);
  out.T5a.smallMs = Date.now() - tConnect;
  out.T5a.small = smallUp ? { idx: smallUp.idx, expect: smallUp.expect, awaiting: smallUp.awaiting } : null;
  check(smallUp && !smallUp.awaiting, 'T5a: "Waiting for uploader" is removed after the asset small size appears', smallUp);
  check(smallUp && Math.abs(smallUp.idx - 75) <= 1, 'T5a: asset small size parks at 2.5 s (frame number 75 ± 1)', smallUp);
  out.T5a.shotSmall = await preview('t5a-2-small');
  // 3) Original-size asset arrived → switch to original-size asset within next polling interval (polling 2 s + on-demand fetch + playability probe + warmup alignment)
  await startSampler();
  const samplerStart = await (await front()).evaluate(() => (window.__pcRealNow ?? (() => performance.now()))());
  publish(A.orig, true);
  const tOrig = Date.now();
  const polled = await until('T5a: the page poll sees the asset original size fully arrived', () => tiers(`return T.tierHashes().includes(args[0]);`, A.orig.hash), 10000, 50);
  out.T5a.pollMs = polled ? Date.now() - tOrig : null;
  // Duration recorded only: originally ≤ 2600 ms was pass condition; "seen" is determined by until above (times out if not reached)
  timings.record('T5a from complete turning true to the page poll seeing the asset original size', out.T5a.pollMs, { formerLimit: '≤ 2600 ms (2 s poll + margin)' });
  const origUp = await until('T5a: switched to asset original size', async () => {
    const l = await layer();
    return l && l.shown && l.rs >= 2 && l.src.includes(A.orig.hash) && Number.isInteger(l.idx) ? l : null;
  }, 20000);
  out.T5a.switchMs = Date.now() - tOrig;
  timings.record('T5a from asset original size fully arrived to switch to asset original size (while paused)', origUp ? out.T5a.switchMs : null, { formerLimit: 'Wait limit 20 seconds' });
  await sleep(300);
  const { samples: samplesA, trace: traceA } = await stopSampler();
  out.T5a.trace = traceA.map((x) => ({ mediaTime: +x.mediaTime.toFixed(4), ref: +x.ref.toFixed(4), errFrames: +((x.mediaTime - x.ref) * x.fps).toFixed(2), playing: x.playing }));
  check(traceA.length >= 1 && traceA.every((x) => Math.abs(x.mediaTime - x.ref) * x.fps <= 1.03), 'T5a: at the tier-switch frame, the frame callback\'s mediaTime differs from the target by no more than one frame', out.T5a.trace);
  out.T5a.original = origUp ? { idx: origUp.idx, expect: origUp.expect } : null;
  check(origUp && smallUp && Math.abs(origUp.idx - smallUp.idx) <= 1, 'T5a: for the same target time before and after the tier switch, the frame numbers differ by no more than one frame', { small: smallUp?.idx, orig: origUp?.idx });
  const blackA = blackOf(samplesA, samplerStart);
  out.T5a.samples = samplesA.length;
  out.T5a.black = blackA.length;
  check(samplesA.length > 10 && blackA.length === 0, 'T5a: per-frame sampling during the tier switch shows no black frames / no gaps', blackA.slice(0, 3));
  const idxsA = [...new Set(samplesA.filter((s) => Number.isInteger(s.idx)).map((s) => s.idx))];
  out.T5a.idxSeen = idxsA;
  check(idxsA.every((i) => Math.abs(i - 75) <= 1), 'T5a: tier switch while paused, the picture stays at 2.5 s (frame number 75 ± 1) the whole time, with no jump back to the start', idxsA);
  out.T5a.shotOriginal = await preview('t5a-3-original');
  out.T5a.playable = await (await front()).evaluate((h) => Object.keys(localStorage).filter((k) => k.endsWith(h)).map((k) => [k.split('.').slice(0, 3).join('.'), localStorage.getItem(k)]), A.orig.hash);

  }
  /* ============================================================ T5b: Tier switch during playback */
  if (want('T5b')) {
  const B = await makePair('b');
  publish(B.small, true);
  publish(B.orig, false);
  await setupProject(B, `tier-b-${RUN}`);
  await store('actions.seek(0.3);');
  const readyB = await until('T5b: asset small size ready', async () => { const l = await layer(); return l && l.rs >= 2 && l.src.includes(B.small.hash) ? l : null; }, 20000);
  if (!readyB) {
    out.T5b.debug = { layer: await layer(), tiers: await tiers('return T.assetTiersDebug();'), small: B.small.hash.slice(0, 8), orig: B.orig.hash.slice(0, 8),
      remoteLog: remoteLog.slice(-12), status: await (await fetch(origin + '/api/media/remote')).json() };
  }
  await startSampler();
  await startFrameSampler();
  const bStart = await (await front()).evaluate(() => (window.__pcRealNow ?? (() => performance.now()))());
  await store('actions.play();');
  await sleep(800);
  publish(B.orig, true);
  const tB = Date.now();
  const switchedB = await until('T5b: switched to asset original size during playback', async () => { const l = await layer(); return l && l.rs >= 2 && l.src.includes(B.orig.hash) ? l : null; }, 15000, 100);
  out.T5b.switchMs = switchedB ? Date.now() - tB : null;
  timings.record('T5b from asset original size fully arrived to switch to asset original size (during playback)', out.T5b.switchMs, { formerLimit: 'Wait limit 15 seconds' });
  await sleep(600);
  const { samples: samplesB, trace: traceB } = await stopSampler();
  const framesB = await stopFrameSampler();
  out.T5b.trace = traceB.map((x) => ({ mediaTime: +x.mediaTime.toFixed(4), ref: +x.ref.toFixed(4), errFrames: +((x.mediaTime - x.ref) * x.fps).toFixed(2), playing: x.playing }));
  const swapTrace = traceB.find((x) => x.playing);
  check(swapTrace && Math.abs(swapTrace.mediaTime - swapTrace.ref) * swapTrace.fps <= 1.03,
    'T5b: during playback the error between the tier-switch frame and the foreground handed-off frame, extrapolated to the same display time, is no more than one frame', out.T5b.trace);
  await store('actions.pause();');
  const shotB = await preview('t5b-after-switch');
  out.T5b.shot = shotB;
  const decB = framesB.filter((s) => s.at >= bStart && Number.isInteger(s.idx));
  const k = decB.findIndex((s, i) => i > 0 && decB[i - 1].src === B.small.hash.slice(0, 8) && s.src === B.orig.hash.slice(0, 8));
  if (k > 0) {
    const a = decB[k - 1], b = decB[k];
    // Display times of the two per-frame callbacks are not identical, extrapolate earlier frame to
    // display time of later frame before comparing. Probe itself may miss intermediate rVFC due to load;
    // for exact swap frames, compare warmup callback and foreground callback at same display time.
    // Frame-by-frame image reading of display element additionally verifies that both sides indeed render
    // frames; when callback is delayed, canvas may have already moved to next frame, therefore do not
    // forcibly match canvas frame number to mediaTime of this callback.
    const frameError = swapTrace ? (swapTrace.mediaTime - swapTrace.ref) * FPS : NaN;
    const observedGap = (b.mediaTime - (a.mediaTime + (b.at - a.at) / 1000)) * FPS;
    out.T5b.swap = { before: { idx: a.idx, mediaTime: a.mediaTime, displayTime: a.at },
      after: { idx: b.idx, mediaTime: b.mediaTime, displayTime: b.at }, frameError: +frameError.toFixed(2), observedGap: +observedGap.toFixed(2) };
    check(Math.abs(out.T5b.swap.frameError) <= 1, 'T5b: frame error at the moment of the tier switch during playback is no more than one frame', out.T5b.swap);
    check(b.idx >= a.idx - 1, 'T5b: the tier switch does not jump backward', out.T5b.swap);
    // Every frame renders within 300 ms after tier switch (aligned frame was already delivered when swapping to new tier)
    const after = framesB.filter((s) => s.at >= b.at && s.at <= b.at + 300);
    out.T5b.afterSwapBlack = after.filter((s) => s.rs < 2 || !(s.luma > 16)).length;
    check(after.length > 0 && out.T5b.afterSwapBlack === 0, 'T5b: no black frames / no gaps within 300 ms from the moment of the tier switch', after.slice(0, 4));
  } else check(false, 'T5b: the tier-switch moment from asset small size → asset original size was found in the samples', { n: decB.length, srcs: [...new Set(samplesB.map((s) => s.src))] });
  // None of the decoded frames is black (average luminance of lower half < 16)
  const lumaBlack = decB.filter((s) => !(s.luma > 16));
  out.T5b.samples = samplesB.length;
  out.T5b.decoded = decB.length;
  out.T5b.lumaBlack = lumaBlack.length;
  check(decB.length > 10 && lumaBlack.length === 0, 'T5b: no black frames among the frames that could be decoded throughout playback', lumaBlack.slice(0, 3));
  // Buffering unrelated to tier switch (readyState drops to 1 during correction seek while playing, screen still shows previous frame): count only, do not judge
  out.T5b.bufferingSamples = blackOf(samplesB, bStart).length;
  const errs = decB.map((s) => s.idx - Math.round(s.t * FPS));
  out.T5b.frameErrVsStage = { min: Math.min(...errs), max: Math.max(...errs) };

  }
  /**
   * Shared by T5c / T5e: paused at 2.5 s, first "Waiting for uploader" (original-size asset URL was
   * attached previously and failed) → small-size asset arrives and displays → original-size asset
   * is reported ready. After original-size asset is reported ready, probe **no longer touches any
   * page state** (no seek, no set changes, no clicks), only observing whether it can switch to
   * original-size asset on its own.
   */
  const pausedSwapAfterFailedOriginal = async (scene, tag, { holdMs = 0, cachePlayable = false, timeoutMs }) => {
    const o = out[scene];
    const X = await makePair(tag);
    publish(X.small, false);
    publish(X.orig, false);
    await tiers('T.setRemoteAssets(null);');
    const setup = await setupProject(X, `tier-${tag}-${RUN}`, false);
    check(setup?.clipId, `${scene}: video clip added`);
    const awaiting = await until(`${scene}: first waiting for uploader (asset original size URL rigged to fail)`, async () => {
      const l = await layer();
      return l && l.awaiting && !(l.shown && l.rs >= 2) ? l : null;
    }, 15000);
    o.awaitingFirst = !!awaiting;
    if (cachePlayable) {
      // This machine already probed that "original-size asset can be played" (the two stages are each a page origin, each recording one copy)
      for (const f of stageFrames()) await f.evaluate(async (h) => { (await import('/src/render/playability.ts')).rememberPlayable(h, true); }, X.orig.hash);
    }
    publish(X.small, true);
    await tiers(`T.setRemoteAssets({ base: args[0], ticket: async () => 'probe-ticket' });`, REMOTE_BASE);
    const small = await until(`${scene}: asset small size appears`, async () => {
      const l = await layer();
      return l && l.shown && l.rs >= 2 && l.src.includes(X.small.hash) && Number.isInteger(l.idx) ? l : null;
    }, 20000);
    o.small = small ? { idx: small.idx } : null;
    check(small && Math.abs(small.idx - 75) <= 1, `${scene}: asset small size parks at 2.5 s (frame number 75 ± 1)`, small);
    const els = () => [...document.querySelectorAll('video')].map((v) => ({ src: (v.currentSrc || v.getAttribute('src') || '').split('/@media/')[1]?.slice(0, 8) ?? '',
      rs: v.readyState, net: v.networkState, err: v.error?.code ?? null, ct: +v.currentTime.toFixed(3), shown: getComputedStyle(v.parentElement).visibility === 'visible' }));
    o.elsBefore = await (await front()).evaluate(els);
    // Element event timeline (load() calls, seeking / seeked), record only, do not judge
    await (await front()).evaluate(() => {
      window.__tierEv = [];
      const now = () => (window.__pcRealNow ?? (() => performance.now()))();
      window.__tierT0 = now();
      const rec = (v, type) => window.__tierEv.push({ at: Math.round(now() - window.__tierT0), type, src: (v.currentSrc || v.getAttribute('src') || '').split('/@media/')[1]?.slice(0, 8) ?? '', rs: v.readyState, ct: +v.currentTime.toFixed(3) });
      for (const v of document.querySelectorAll('video')) {
        // Slot elements reused across scenarios: each element is attached only once
        if (v.__tierHooked) continue;
        v.__tierHooked = true;
        for (const type of ['loadstart', 'loadedmetadata', 'loadeddata', 'seeking', 'seeked', 'emptied', 'error']) v.addEventListener(type, () => rec(v, type));
        const load = v.load.bind(v);
        v.load = () => { rec(v, 'load()'); return load(); };
      }
    });
    await startSampler();
    const samplerStart = await (await front()).evaluate(() => (window.__pcRealNow ?? (() => performance.now()))());
    const tOrig = Date.now();
    publish(X.orig, true, holdMs ? tOrig + holdMs : 0);
    const orig = await until(`${scene}: switched to asset original size (no other state change after the asset original size was reported complete)`, async () => {
      const l = await layer();
      return l && l.shown && l.rs >= 2 && l.src.includes(X.orig.hash) && Number.isInteger(l.idx) ? l : null;
    }, timeoutMs, 250);
    o.switchMs = orig ? Date.now() - tOrig : null;
    timings.record(`${scene} from asset original size reported complete to switch to asset original size`, o.switchMs, { formerLimit: `Wait limit ${Math.round(timeoutMs / 1000)} seconds` });
    await sleep(300);
    const { samples, trace } = await stopSampler();
    o.trace = trace.map((x) => ({ mediaTime: +x.mediaTime.toFixed(4), ref: +x.ref.toFixed(4), errFrames: +((x.mediaTime - x.ref) * x.fps).toFixed(2), playing: x.playing }));
    o.events = await (await front()).evaluate(() => (window.__tierEv ?? []).slice(0, 40));
    o.elsAfter = await (await front()).evaluate(els);
    o.playable = await (await front()).evaluate((h) => Object.keys(localStorage).filter((k) => k.endsWith(h)).map((k) => localStorage.getItem(k)), X.orig.hash);
    o.original = orig ? { idx: orig.idx } : null;
    check(orig && small && Math.abs(orig.idx - small.idx) <= 1, `${scene}: for the same target time before and after the tier switch, the frame numbers differ by no more than one frame`, { small: small?.idx, orig: orig?.idx });
    check(!orig || (trace.length >= 1 && trace.every((x) => Math.abs(x.mediaTime - x.ref) * x.fps <= 1.03)), `${scene}: at the tier-switch frame, the frame callback's mediaTime differs from the target by no more than one frame`, o.trace);
    const black = blackOf(samples, samplerStart);
    o.samples = samples.length;
    o.black = black.length;
    check(samples.length > 10 && black.length === 0, `${scene}: per-frame sampling during the tier switch shows no black frames / no gaps`, black.slice(0, 3));
    const idxs = [...new Set(samples.filter((s) => Number.isInteger(s.idx)).map((s) => s.idx))];
    o.idxSeen = idxs;
    check(idxs.every((i) => Math.abs(i - 75) <= 1), `${scene}: the picture stays at 2.5 s (frame number 75 ± 1) the whole time`, idxs);
    o.shot = await preview(`${scene.toLowerCase()}-original`);
  };

  /* ============================================================ T5c: Paused, original-size asset arrives slowly (playability probe timeout) */
  if (want('T5c')) await pausedSwapAfterFailedOriginal('T5c', 'e', { holdMs: HOLD_MS, timeoutMs: HOLD_MS + 30000 });

  /* ============================================================ T5e: Paused, playability already concluded, warmup slot reloaded */
  if (want('T5e')) await pausedSwapAfterFailedOriginal('T5e', 'f', { cachePlayable: true, timeoutMs: 20000 });

  /* ============================================================ T6: Original-size asset unplayable (ProRes) */
  if (want('T6')) {
  const C = await makePair('c', { prores: true });
  publish(C.small, true);
  publish(C.orig, true);
  await setupProject(C, `tier-c-${RUN}`);
  const verdict = await until('T6: this machine detected that the ProRes asset original size cannot be played (device-local cache records 0)', async () => {
    const v = await (await front()).evaluate((h) => { const k = Object.keys(localStorage).find((x) => x.startsWith('pc.playable.') && x.endsWith(h)); return k ? { key: k.replace(h, '<hash>'), value: localStorage.getItem(k) } : null; }, C.orig.hash);
    return v;
  }, 25000, 300);
  out.T6.cache = verdict;
  check(verdict && verdict.value === '0', 'T6: the cached verdict is that it cannot be played', verdict);
  // Observe for 5 more seconds after conclusion is reached: remains on small-size asset throughout
  const stay = [];
  for (let i = 0; i < 10; i++) { const l = await layer(); stay.push(l?.src.includes(C.small.hash) ? 'small' : l?.src.includes(C.orig.hash) ? 'orig' : 'none'); await sleep(500); }
  out.T6.stay = [...new Set(stay)];
  check(stay.every((s) => s === 'small'), 'T6: with both tiers fully arrived, the preview still stays on asset small size the whole time', stay);
  const lc = await layer();
  out.T6.idx = lc?.idx ?? null;
  out.T6.shot = await preview('t6-prores-stays-small');
  const projectHasNoPlayable = await store(`return JSON.stringify(getState().project).includes('playable');`);
  check(!projectHasNoPlayable, 'T6: the project document has no playability field');
  // Export side still uses original-size asset: export intercept queries hash of original-size asset (both tiers arrived → allow, do not substitute with small-size asset)
  const gateC = await tiers(`return (await T.exportGate((await import('/src/store/project.ts')).getState().project)).map((m) => m.hash);`);
  out.T6.exportGate = gateC;
  check(Array.isArray(gateC) && gateC.length === 0, 'T6: asset original size has fully arrived, so export is not blocked (export only recognizes asset original size)', gateC);

  }
  /* ============================================================ T7: Export when original-size asset has not arrived */
  if (want('T7')) {
  const D = await makePair('d');
  publish(D.small, true);
  publish(D.orig, false);
  await setupProject(D, `tier-d-${RUN}`);
  await until('T7: asset small size ready', async () => { const l = await layer(); return l && l.rs >= 2 && l.src.includes(D.small.hash) ? l : null; }, 20000);
  exportRequests.length = 0;
  const viaIo = await page.evaluate(async () => {
    try { await window.__pcIo.exportVideo(); return { resolved: true }; } catch (e) { return { message: String(e?.message ?? e), code: e?.code ?? null, missing: (e?.missing ?? []).length }; }
  });
  out.T7.exportVideo = viaIo;
  check(viaIo.code === 'awaiting-uploader' && /Waiting for uploader/.test(viaIo.message) && viaIo.missing === 1, 'T7: exportVideo refuses and shows "Waiting for uploader", listing the missing assets', viaIo);
  // Click "Export" in top bar: does not pop up Save As, gives the same notice directly
  await sleep(2200); // Let polling record "original-size asset has not arrived" into set
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Export/.test(x.textContent || '') || /Export/.test(x.getAttribute('title') || '') || /Export/.test(x.getAttribute('aria-label') || ''));
    if (!b) return false;
    b.click();
    return true;
  });
  const dialog = clicked ? await until('T7: prompt in the export dialog', () => page.evaluate(() => { const t = document.body.innerText; return /Waiting for uploader/.test(t) ? t.split('\n').find((l) => /Waiting for uploader/.test(l)) : null; }), 5000) : null;
  out.T7.dialog = dialog;
  check(clicked, 'T7: found the export button in the top bar');
  check(dialog && dialog.includes(`tier-d-${RUN}`), 'T7: the dialog shows "Waiting for uploader" and lists the asset names', dialog);
  await sleep(300);
  out.T7.shot = path.join(OUT, 't7-export-blocked.png');
  await page.screenshot({ path: out.T7.shot });
  out.T7.exportRequests = exportRequests.length;
  check(exportRequests.length === 0, 'T7: no export request was sent (no video produced)', exportRequests);

  }
  /* ============================================================ Finalize */
  const status = await (await fetch(origin + '/api/media/remote')).json();
  out.remoteAuthSeen = remoteLog.some((e) => e.auth);
  out.pull = { base: status.base, jobs: status.jobs.length };
  out.pageErrors = pageErrors.slice(0, 5);
  check(pageErrors.length === 0, 'Page has no uncaught errors', pageErrors.slice(0, 3));
  await tiers('T.setRemoteAssets(null);');
} catch (err) {
  fails.push(`Probe error: ${err?.stack ?? err}`);
} finally {
  await browser.close().catch(() => {});
  remote.close();
}
out.fails = fails;
out.notes = notes;
out.ok = fails.length === 0;
out.timings = timings.list;
timings.print();
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
