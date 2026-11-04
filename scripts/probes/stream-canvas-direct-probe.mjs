/**
 * End-to-end probe for producing track streams without going through PNG for canvas and WebGL
 * cards (render refactor "Ji-1") (acceptance check for "Ji" in `docs/plan/render-refactor-task.md`;
 * `docs/plan/prerender-products-contract.md` sections 6.1, 6.2).
 *
 *   node scripts/probes/stream-canvas-direct-probe.mjs [--origin http://127.0.0.1:27700 | --port 27700]
 *        [--sizes 960x540,1920x1080] [--rounds 2] [--all-cards] [--out <dir>] [--keep] [--json <file>]
 *
 * If `--origin` is given, use that dev server; if omitted, start one at the checkout root (`--port`,
 * taking +1 and +2 as stage ports; does not touch 5190-5192), and terminate it by PID when done.
 * Start `FramePipeline` directly in this process (same code as prerender process), with library
 * root placed in temporary directory. Seed one project for each aspect ratio:
 *
 *   clip-particles  generic particle card `particles` (2D canvas, drawn by tsParticles)
 *   clip-3d         3D scene `scene-3d` (plane sharing WebGL renderer)
 *   clip-outside    probe card `r6-canvas`, where probe adds a pseudo-element color block to its
 *                   wrapper layer on export page: card with "other elements outside canvas"
 *
 * All three cards are pinned as heavy cards (`pipeline.streamPicked` all selected). Verify item by
 * item:
 *
 *   1. Default tier (`auto`) completes production as usual: particle card and 3D card pass
 *      verification (`direct.last.pass`) and are not classified as unable to direct capture;
 *      the card with "other elements outside canvas" falls back to screenshots
 *      (`direct.failed === 'differs'`), with one entry in producer diagnostics;
 *   2. Produce once for each of the new and old paths (same stream, same session; first `off`
 *      screenshotting each frame, then `always` direct capture once passing verification): compare
 *      segments byte-by-byte; then decode both sides with ffmpeg and compare frame-by-frame, with
 *      average color difference under 1 and average opacity difference under 0.5 (out of 255); with
 *      control: compared with frames at other timestamps in the same segment, the difference is
 *      significantly larger (proving this comparison method can distinguish whether frames are
 *      correct);
 *   3. The card with "other elements outside canvas": also falls back to screenshots under `always`
 *      tier, producing segments byte-identical to `off`;
 *   4. Per-frame duration, before and after changes (recorded only, not a pass condition):
 *      wall-clock time for each of sparse pass and full-density pass; image capture section split
 *      into reading pixels and transferring to Node (after) vs. screenshots (before); additionally,
 *      capture 15 frames into memory first and feed to encoder separately to measure encoding
 *      section (PNG input vs. raw pixel input);
 *   5. `--all-cards`: verify all 56 built-in cards registered as canvas cards (`particles`, 53
 *      `particles-*` cards, `scene-3d`, `r6-canvas`) card by card, recording whether content is
 *      entirely within canvas (whether it passed verification and by how much) and transfer volume
 *      ratio relative to raw pixels into conclusion; registration itself is also checked (those with
 *      `canvasHeavy` in review table match exactly these, and page capability objects have
 *      `canvasHeavy: true` for all of them).
 *
 * Output JSON conclusion, write progress to stderr; exit non-zero if any check fails.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { SEGMENT_FRAMES, SPARSE_STRIDE } from '../../server/frame-stream.mjs';
import { bakeStream } from '../../server/bakery/bake.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { openStreamSegmentEncoder, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { directSegmentCapture, grabCanvas, newDirectRecord, DIRECT_BAD_DIFF } from '../../server/bakery/capture-canvas.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '27700', args));
const SIZES = String(flagArg('sizes', '960x540,1920x1080', args)).split(',').map((s) => s.trim().split('x').map(Number)).filter(([w, h]) => w > 0 && h > 0);
const ROUNDS = Math.max(1, Number(flagArg('rounds', '2', args)) || 2);
const ALL_CARDS = args.includes('--all-cards');
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-canvas-direct-probe-${Date.now().toString(36)}`));
if (!ORIGIN && [5190, 5191, 5192].some((p) => p >= PORT && p <= PORT + 2)) throw new Error('This port range belongs to the user\'s resident dev servers; use another one');
// One session, produce one by one: measured wall-clock time is not mixed with other streams
process.env.PROMPTCUT_STREAM_POOL = '1';

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (list) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const round2 = (n) => (n === null || n === undefined ? null : +Number(n).toFixed(2));
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

const DURATION = 3; // Seconds: 6 segments
const projectOf = (width, height) => ({
  id: `canvas-direct-${width}x${height}`, name: 'Canvas direct capture probe', width, height, fps: 30, duration: DURATION,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-particles', name: 'particles', hidden: false, clips: [{ id: 'clip-particles', kind: 'card', cardId: 'particles', start: 0, end: DURATION, params: {} }] },
    { id: 'tr-3d', name: '3d', hidden: false, clips: [{ id: 'clip-3d', kind: 'card', cardId: 'scene-3d', start: 0, end: DURATION, params: {} }] },
    { id: 'tr-outside', name: 'outside', hidden: false, clips: [{ id: 'clip-outside', kind: 'card', cardId: 'r6-canvas', start: 0, end: DURATION, params: {},
      frame: { x: 0, y: 0, w: Math.min(640, width), h: Math.min(480, height), anchor: [0, 0] } }] },
  ],
});
/** "Elements outside canvas": a pseudo-element color block on wrapper layer, unreadable by canvas, captured by screenshot */
const OUTSIDE_CSS = '[data-pc-clip="clip-outside"]::after{content:"";position:absolute;left:24px;top:24px;width:120px;height:40px;background:rgba(255,51,102,.9);border-radius:8px}';
const REAL = ['clip-particles', 'clip-3d'];

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

/** ffmpeg decodes init + one segment into frame-by-frame RGB (vertically stacked encoded image: upper half premultiplied color, lower half opacity) */
async function decodeSegment(init, seg, dir, name) {
  const file = path.join(dir, `${name}.mp4`);
  await fs.writeFile(file, Buffer.concat([init, seg]));
  const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1 << 30, windowsHide: true });
  await fs.rm(file, { force: true });
  return stdout;
}
/** Difference between decoded encoded frames of two frames: average color difference (upper RGB), average opacity difference (lower half), visibly different pixel count */
function frameDiff(a, b, width, codedHeight) {
  const h = codedHeight / 2 - 8;
  let color = 0, alpha = 0, bad = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3, j = ((y + h + 8) * width + x) * 3;
    const dr = Math.abs(a[i] - b[i]), dg = Math.abs(a[i + 1] - b[i + 1]), db = Math.abs(a[i + 2] - b[i + 2]), da = Math.abs(a[j] - b[j]);
    color += dr + dg + db;
    alpha += da;
    if (dr > DIRECT_BAD_DIFF || dg > DIRECT_BAD_DIFF || db > DIRECT_BAD_DIFF || da > DIRECT_BAD_DIFF) bad++;
  }
  return { color: color / (width * h * 3), alpha: alpha / (width * h), bad };
}

const out = { library: OUT, sizes: [], rounds: ROUNDS };
await fs.mkdir(OUT, { recursive: true });
const RUN = Date.now().toString(36);
const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pc-canvas-direct-dev-'));
let child = null;
const pipelines = [];
try {
  // ---------- 0. dev server
  let origin = ORIGIN;
  if (!origin) {
    const log = [];
    child = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, BROWSER: 'none', PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_DATA_DIR: path.join(TMP, 'data'), PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0',
        PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: `canvasdirect-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'canvas-direct-probe' },
    });
    const keep = (c) => { log.push(c.toString()); if (log.length > 400) log.shift(); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    say('spawn', { pid: child.pid, port: PORT });
    origin = `http://127.0.0.1:${PORT}`;
    const up = await until('dev server is up', async () => {
      if (child.exitCode !== null) throw new Error(`dev server exited: ${log.join('').slice(-600)}`);
      return fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    }, 180_000, 300);
    if (!up) throw new Error(`dev server did not start: ${log.join('').slice(-600)}`);
  }
  out.origin = origin;

  for (const [width, height] of SIZES) {
    const tag = `${width}x${height}`;
    const size = { size: tag, auto: {}, compare: [], outside: null, timing: {} };
    out.sizes.push(size);
    const cmpDir = path.join(OUT, `cmp-${tag}`);
    await fs.mkdir(cmpDir, { recursive: true });

    // ---------- 1. Default tier (auto) completes production as usual
    const pipeline = new FramePipeline({ root: path.join(OUT, `lib-${tag}`), origin: () => origin, interactive: true, playhead: () => null });
    pipelines.push(pipeline);
    pipeline.streamPicked = () => true; // Pin as heavy cards
    // After each page navigation, add that pseudo-element to export page (only affects wrapper layer of clip-outside)
    const lease = pipeline.leaseStreamBakery.bind(pipeline);
    pipeline.leaseStreamBakery = async () => {
      const bakery = await lease();
      if (!bakery.__probeOutside) {
        bakery.__probeOutside = true;
        const reset = bakery.reset;
        bakery.reset = async (...a) => {
          await reset.apply(bakery, a);
          await bakery.page.evaluate((css) => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); }, OUTSIDE_CSS);
        };
      }
      return bakery;
    };
    const producer = pipeline.streamProducer();
    check(producer.direct === 'always', `${tag}: the producer's default is the always tier`, producer.direct);
    producer.attachRoute();
    const dense = () => {
      const status = producer.status();
      if (status.streams.length < 3) return null;
      for (const s of status.streams) for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
      return !producer.workers.size && !producer.encoding.size ? status : null;
    };
    const t0 = Date.now();
    await pipeline.preload(projectOf(width, height));
    const first = await until(`${tag}: all segments at full density`, dense, 900_000, 500);
    if (!first) throw new Error(`${tag}: the first production round did not finish: ${JSON.stringify(producer.status().log.slice(-8))}`);
    size.autoProduceMs = Date.now() - t0;
    out.encoder = first.encoder;
    const rowOf = (status, clipId) => status.streams.find((s) => s.clipIds.length === 1 && s.clipIds[0] === clipId);
    const stateOf = (clipId) => [...producer.streams.values()].find((s) => s.spec.clipIds.length === 1 && s.spec.clipIds[0] === clipId);
    for (const clipId of [...REAL, 'clip-outside']) {
      const row = rowOf(first, clipId);
      if (!check(!!row, `${tag} ${clipId}: has a stream`)) continue;
      size.auto[clipId] = { direct: row.direct, capture: row.capture, bound: row.bound, tight: row.tight, segments: row.lastSegment - row.firstSegment + 1 };
      if (REAL.includes(clipId)) {
        check(!!row.direct && row.direct.failed === null, `${tag} ${clipId}(always): not judged unable to capture directly`, row.direct);
        check(row.direct?.checks >= 1 && (row.direct.segments + row.direct.slowSegments) >= 1, `${tag} ${clipId}(always): measured, and passed`, row.direct);
      } else {
        check(row.direct?.failed === 'differs', `${tag} ${clipId}(always): other elements outside the canvas, falls back to screenshots`, row.direct);
        check(row.direct?.segments === 0 && row.direct?.frames === 0, `${tag} ${clipId}(always): not a single frame took the direct path`, row.direct);
      }
    }
    check(first.log.some((l) => /canvas direct capture did not pass\(differs/.test(l.message)), `${tag}: the diagnostics contain the "canvas direct capture did not pass" entry`, first.log.map((l) => l.message).slice(-6));
    say('auto', { size: tag, ms: size.autoProduceMs, direct: Object.fromEntries(Object.entries(size.auto).map(([k, v]) => [k, v.direct && { failed: v.direct.failed, segments: v.direct.segments, slow: v.direct.slowSegments, last: v.direct.last }])) });

    // ---------- 2. After other background work wraps up, produce one by one: off vs always
    for (let quiet = 0; quiet < 3;) { const before = pipeline.background; await before.catch(() => {}); await sleep(700); quiet = pipeline.background === before ? quiet + 1 : 0; }
    producer.enabled = false; // Prevent automatic production from taking over the stream state swapped in below
    await producer.drain();
    const bakery = await pipeline.leaseStreamBakery();
    /** Produce this stream from scratch once (sparse pass, full-density pass), return duration, segment bytes, direct capture record */
    const produce = async (orig, mode) => {
      const { spec } = orig;
      producer.direct = mode;
      const state = { ...orig, manifest: producer.freshManifest(spec), reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set(),
        measureFailed: false, direct: undefined, capture: undefined, resets: undefined, replayedFrames: 0 };
      producer.streams.set(spec.streamKey, state);
      bakery.streamLease = null;
      const pass = async (stride) => {
        state.capture = undefined;
        const started = performance.now();
        const jobs = [];
        for (let n = spec.firstSegment; n <= spec.lastSegment; n++) {
          const task = { state, segment: n, stride };
          if (!(await producer.runSegment(bakery, task))) throw new Error(`${spec.topClipId}#${n} was not produced`);
          jobs.push(task.job);
        }
        await Promise.all(jobs);
        const wallMs = performance.now() - started;
        for (let n = spec.firstSegment; n <= spec.lastSegment; n++) if (state.manifest.segments[n]?.stride !== stride) throw new Error(`${spec.topClipId}#${n} was not written to disk: ${JSON.stringify(producer.status().log.slice(-4))}`);
        return { wallMs, ...state.capture };
      };
      const sparse = await pass(SPARSE_STRIDE);
      const sparseDirect = state.direct ? { ...state.direct } : null;
      const denseRun = await pass(1);
      const segs = [];
      for (let n = spec.firstSegment; n <= spec.lastSegment; n++) {
        const seg = state.manifest.segments[n];
        segs.push({ n, init: seg.init, samples: seg.samples, bytes: await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file)) });
      }
      const inits = {};
      for (const id of new Set(segs.map((s) => s.init))) inits[id] = { meta: state.manifest.inits[id], bytes: await fs.readFile(producer.store.initFile(spec.streamKey, id)) };
      return { mode, sparse, dense: denseRun, segs, inits, direct: state.direct ? { ...state.direct } : null, sparseDirect, tight: state.manifest.tight, bound: state.manifest.bound, log: producer.status().log.map((l) => l.message) };
    };

    for (const clipId of [...REAL, 'clip-outside']) {
      const orig = stateOf(clipId);
      if (!orig) continue;
      const runs = { off: [], always: [] };
      for (let r = 0; r < (clipId === 'clip-outside' ? 1 : ROUNDS); r++) for (const mode of ['off', 'always']) {
        const run = await produce(orig, mode);
        runs[mode].push(run);
        say('produce', { size: tag, clipId, mode, round: r, sparseMs: round2(run.sparse.wallMs), denseMs: round2(run.dense.wallMs), direct: run.direct && { failed: run.direct.failed, segments: run.direct.segments, frames: run.direct.frames, checks: run.direct.checks, misses: run.direct.misses } });
      }
      const a = runs.off[0], b = runs.always[0];
      const frames = a.segs.reduce((n, s) => n + s.samples, 0);
      const sameBytes = a.segs.every((s, i) => Buffer.compare(s.bytes, b.segs[i].bytes) === 0);
      const rect = b.tight ?? b.bound;

      if (clipId === 'clip-outside') {
        size.outside = { direct: b.direct, sameBytesAsOff: sameBytes, rect };
        check(b.direct?.failed === 'differs', `${tag} clip-outside(always): other elements outside the canvas, falls back to screenshots`, b.direct);
        check(b.direct?.segments === 0 && b.direct?.frames === 0, `${tag} clip-outside(always): not a single frame took the direct path`, b.direct);
        check((b.direct?.last?.bad ?? 0) > (b.direct?.last?.badLimit ?? Infinity), `${tag} clip-outside: the measurement found clearly different pixels`, b.direct?.last);
        check(sameBytes, `${tag} clip-outside: after falling back to screenshots, the produced segments are byte-identical to off`);
        check(b.log.some((m) => /canvas direct capture did not pass\(differs/.test(m)), `${tag} clip-outside(always): has a diagnostic`);
        continue;
      }

      // Whether direct capture was used
      // Direct capture record combines sparse and full-density passes: segment count doubles, frames = fetched in sparse pass + fetched in full-density pass
      check(b.sparseDirect?.failed === null && b.sparseDirect.segments === a.segs.length && b.sparseDirect.frames === b.sparse.frames,
        `${tag} ${clipId}(always): in the sparse pass, every segment and every frame took the direct path`, b.sparseDirect);
      check(b.direct?.failed === null && b.direct.segments === 2 * a.segs.length && b.direct.frames === b.sparse.frames + frames && b.direct.misses === 0,
        `${tag} ${clipId}(always): in the full-density pass, every segment and every frame also took the direct path`, b.direct);
      check(JSON.stringify(a.tight) === JSON.stringify(b.tight), `${tag} ${clipId}: both paths measure the same tight rectangle`, [a.tight, b.tight]);

      // Decode and compare frame-by-frame + control
      const cmp = { clipId, rect, frames, sameBytes, color: [], alpha: [], bad: [], otherColor: [], otherAlpha: [], otherBad: [], ink: [] };
      for (let i = 0; i < a.segs.length; i++) {
        const sa = a.segs[i], sb = b.segs[i];
        const ia = a.inits[sa.init], ib = b.inits[sb.init];
        const W = ia.meta.width, Hc = ia.meta.height;
        if (!check(ib.meta.width === W && ib.meta.height === Hc, `${tag} ${clipId}#${sa.n}: the encoded pictures of both paths are the same size`, [ia.meta, ib.meta])) continue;
        const da = await decodeSegment(ia.bytes, sa.bytes, cmpDir, `off-${clipId}-${sa.n}`);
        const db = await decodeSegment(ib.bytes, sb.bytes, cmpDir, `always-${clipId}-${sb.n}`);
        const frameBytes = W * Hc * 3;
        if (!check(da.length === sa.samples * frameBytes && db.length === da.length, `${tag} ${clipId}#${sa.n}: both sides decoded ${sa.samples} frames`, [da.length / frameBytes, db.length / frameBytes])) continue;
        for (let k = 0; k < sa.samples; k++) {
          const fa = da.subarray(k * frameBytes, (k + 1) * frameBytes), fb = db.subarray(k * frameBytes, (k + 1) * frameBytes);
          const same = frameDiff(fb, fa, W, Hc);
          cmp.color.push(same.color); cmp.alpha.push(same.alpha); cmp.bad.push(same.bad);
          // Control: the frame 7 frames apart in the same segment (from the other path)
          const o = (k + 7) % sa.samples;
          const other = frameDiff(fb, da.subarray(o * frameBytes, (o + 1) * frameBytes), W, Hc);
          cmp.otherColor.push(other.color); cmp.otherAlpha.push(other.alpha); cmp.otherBad.push(other.bad);
          // Image is not empty: opacity half has content
          if (k === 0) { let ink = 0; const h = Hc / 2 - 8; for (let p = (h + 8) * W * 3; p < (2 * h + 8) * W * 3; p += 3) if (fb[p] > 32) ink++; cmp.ink.push(ink); }
        }
      }
      const max = (l) => (l.length ? Math.max(...l) : null), min = (l) => (l.length ? Math.min(...l) : null);
      const summary = { clipId, rect, frames: cmp.color.length, sameBytes, colorMax: round2(max(cmp.color)), alphaMax: round2(max(cmp.alpha)), badMax: max(cmp.bad),
        otherColorMin: round2(min(cmp.otherColor)), otherColorMedian: round2(median(cmp.otherColor)), otherAlphaMin: round2(min(cmp.otherAlpha)), otherBadMin: min(cmp.otherBad), inkMin: min(cmp.ink) };
      size.compare.push(summary);
      say('compare', { size: tag, ...summary });
      check(cmp.color.length === frames, `${tag} ${clipId}: all ${frames} frames were compared`, cmp.color.length);
      check(max(cmp.color) < 1, `${tag} ${clipId}: comparing the streams of the old and new paths frame by frame, the mean color difference is under 1`, max(cmp.color));
      check(max(cmp.alpha) < 0.5, `${tag} ${clipId}: comparing the streams of the old and new paths frame by frame, the mean opacity difference is under 0.5`, max(cmp.alpha));
      check(min(cmp.ink) > 0, `${tag} ${clipId}: the picture is not empty`, cmp.ink);
      // Control: frames at other timestamps differ significantly more: hundreds or thousands of visibly different pixels, almost none for the same frame
      check(min(cmp.otherBad) >= 50 && min(cmp.otherBad) > 20 * (max(cmp.bad) + 1), `${tag} ${clipId}: the control (frames from another time) is clearly larger`, { otherBadMin: min(cmp.otherBad), badMax: max(cmp.bad), otherColorMin: min(cmp.otherColor), colorMax: max(cmp.color) });

      // Per-frame duration (median across multiple rounds)
      const per = (list, pick) => round2(median(list.map(pick)));
      const stage = (mode) => {
        const rs = runs[mode];
        const sparseFrames = rs[0].sparse.frames, denseFrames = rs[0].dense.frames;
        const d = rs.map((r) => r.direct);
        return {
          sparse: { wallMs: per(rs, (r) => r.sparse.wallMs), frames: sparseFrames, wallPerFrame: per(rs, (r) => r.sparse.wallMs / r.sparse.frames),
            capturePerFrame: per(rs, (r) => r.sparse.captureMs / r.sparse.frames), stepPerCaptured: per(rs, (r) => r.sparse.stepMs / r.sparse.frames) },
          dense: { wallMs: per(rs, (r) => r.dense.wallMs), frames: denseFrames, wallPerFrame: per(rs, (r) => r.dense.wallMs / r.dense.frames),
            capturePerFrame: per(rs, (r) => r.dense.captureMs / r.dense.frames), stepPerFrame: per(rs, (r) => r.dense.stepMs / r.dense.frames) },
          ...(mode === 'always' ? { direct: {
            // Direct capture record combines sparse and full-density passes
            readPerFrame: round2(median(d.map((x) => x.readMs / x.frames))), movePerFrame: round2(median(d.map((x) => x.moveMs / x.frames))),
            checkPerSegment: round2(median(d.map((x) => x.checkMs / x.checks))), lastCheck: d[0].last } } : {}),
        };
      };
      size.timing[clipId] = { rect, off: stage('off'), always: stage('always') };

      // Measure encoding section separately: same batch of 15 frames, PNG input vs raw pixel input (captured in memory first, does not overlap with image capture)
      const spec = orig.spec;
      const clip = { x: rect.x + spec.offset.x, y: rect.y + spec.offset.y, w: rect.w, h: rect.h };
      await bakery.reset(orig.isolated, pipeline.emptyUrl(orig.isolated), { deferCards: true });
      bakery.streamLease = null;
      const pngs = [], raws = [];
      await bakeStream(bakery, { streamSignature: `bench:${spec.streamKey}`, fromFrame: 30, toFrame: 44, stride: 1, fps: spec.fps, mountFrame: spec.mountFrame, clip, hasMedia: false,
        capture: async (_f, shoot) => { const g = await grabCanvas(bakery, clipId, clip); if (!g.ok) throw new Error(`cannot grab: ${g.reason}`); raws.push(g.rgba); return shoot(); },
        onFrame: async (_f, png) => { pngs.push(png); } });
      bakery.streamLease = null;
      const bench = async (frames15, raw) => {
        const times = [];
        for (let r = 0; r < 4; r++) {
          const started = performance.now();
          const enc = openStreamSegmentEncoder(producer.ffmpeg, { encoder: producer.encoderName, fps: spec.fps, ...(raw ? { raw: { width: clip.w, height: clip.h } } : {}) });
          for (const f of frames15) await enc.write(f);
          await enc.finish();
          if (r > 0) times.push((performance.now() - started) / frames15.length);
          await sleep(60); // Let the pre-spawned next encoding process finish starting up
        }
        return round2(median(times));
      };
      size.timing[clipId].encodePerFrame = { png: await bench(pngs, false), raw: await bench(raws, true), pngKB: round2(median(pngs.map((p) => p.length / 1024))), rawKB: round2(clip.w * clip.h * 4 / 1024) };
      say('timing', { size: tag, clipId, ...size.timing[clipId] });
      // Restore this stream's state
      producer.streams.set(spec.streamKey, orig);
    }
    producer.direct = 'always';
    pipeline.returnStreamBakery(bakery);
    await pipeline.close();
    pipelines.splice(pipelines.indexOf(pipeline), 1);
    dropStreamEncoderSpares();
  }

  // ---------- 5. Verify built-in cards registered as canvas cards card by card
  if (ALL_CARDS) {
    const table = JSON.parse(await fs.readFile(path.join(ROOT, 'src', 'cards', 'capabilities.json'), 'utf8'));
    const registered = Object.entries(table).filter(([, v]) => v && ['canvas2d', 'webgl'].includes(v.surface)).map(([k]) => k).sort();
    out.registered = registered;
    check(JSON.stringify(registered) === JSON.stringify(['particles', 'particles-*', 'r6-canvas', 'scene-3d']), 'the cards registered as canvas cards in the review table are exactly particles, particles-*, r6-canvas, scene-3d', registered);
    check(Object.values(table).every((v) => !v || !Object.hasOwn(v, 'canvasHeavy')), 'the review table no longer writes canvasHeavy (derived from surface)', registered.map((id) => table[id].surface));
    const catalog = JSON.parse(await fs.readFile(path.join(ROOT, 'server', 'catalog', 'particles', 'index.json'), 'utf8'));
    const ids = ['particles', ...catalog.items.map((a) => `particles-${a.name}`), 'scene-3d', 'r6-canvas'];
    check(ids.length === 56, '56 canvas cards in total', ids.length);
    const [width, height] = [960, 540];
    const emptyUrl = `${origin}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify({ width, height, fps: 30, duration: 1, tracks: [], media: [] }))}`)}`;
    const bakery = await openBakery({ url: emptyUrl });
    out.cards = [];
    try {
      const rect = { x: 0, y: 0, w: width, h: height };
      for (const cardId of ids) {
        const project = { id: 'one', name: 'one', width, height, fps: 30, duration: 2, themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
          tracks: [{ id: 'tr', name: 'a', hidden: false, clips: [{ id: 'clip-a', kind: 'card', cardId, start: 0, end: 2, params: {} }] }], _cardRender: { mode: 'final', frames: {}, missing: {} } };
        const row = { cardId };
        try {
          await bakery.reset(project, emptyUrl, { deferCards: true });
          bakery.streamLease = null;
          const caps = await bakery.page.evaluate(() => {
            const plan = window.__pcCardPlan?.();
            const output = plan?.graph?.outputs?.find((o) => o.clipId === 'clip-a');
            const node = plan?.graph?.nodes?.find((n) => n.id === output?.nodeId);
            return output?.capabilities ?? node?.capabilities ?? null;
          });
          row.canvasHeavy = caps?.canvasHeavy === true;
          row.compositing = caps?.compositing ?? null;
          const record = newDirectRecord();
          const checks = [];
          // 4 segments (verified once each at frames 0, 15, 30, 45), a new capture for each segment, same as producer
          for (let n = 0; n < 4; n++) {
            await bakeStream(bakery, { streamSignature: `all:${cardId}`, fromFrame: n * SEGMENT_FRAMES, toFrame: n * SEGMENT_FRAMES + SEGMENT_FRAMES - 1, stride: 1, fps: 30, mountFrame: 0, clip: rect, hasMedia: false,
              capture: directSegmentCapture(bakery, { clipId: 'clip-a', rect, record, always: true }), onFrame: async () => {} });
            if (record.last) checks.push({ ...record.last });
            if (record.failed) break;
          }
          const passed = checks.filter((c) => c.pass);
          row.pass = !record.failed && passed.length === checks.length && checks.length > 0;
          row.failed = record.failed;
          row.checks = checks.length;
          row.colorMax = round2(Math.max(0, ...checks.map((c) => c.color ?? 0)));
          row.alphaMax = round2(Math.max(0, ...checks.map((c) => c.alpha ?? 0)));
          row.badMax = Math.max(0, ...checks.map((c) => c.bad ?? 0));
          row.fillPct = round2(Math.max(0, ...checks.map((c) => c.bytes ?? 0)) / (width * height * 4) * 100);
          row.grabMs = round2(median(passed.map((c) => c.grabMs))); row.shotMs = round2(median(passed.map((c) => c.shotMs)));
          row.frames = record.frames; row.misses = record.misses;
          if (record.failed) row.last = record.last;
        } catch (error) { row.error = String(error?.message || error).split('\n')[0]; }
        out.cards.push(row);
        say('card', row);
        check(row.canvasHeavy === true, `${cardId}: it is canvasHeavy in the capability object the page returns`, row);
      }
    } finally { await bakery.close().catch(() => {}); }
    out.cardsSummary = { total: out.cards.length, pass: out.cards.filter((c) => c.pass).length, failed: out.cards.filter((c) => !c.pass).map((c) => [c.cardId, c.failed ?? c.error ?? 'miss']) };
    check(out.cards.every((c) => !c.error), 'per-card measurements all completed', out.cards.filter((c) => c.error));
  }
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  for (const pipeline of pipelines) { try { await pipeline.close(); } catch { /* ignore */ } }
  dropStreamEncoderSpares();
  if (child && child.exitCode === null) {
    // Only terminate the process tree it spawned
    if (process.platform === 'win32') {
      await new Promise((resolve) => { const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); k.on('close', resolve); k.on('error', resolve); });
    } else child.kill('SIGKILL');
  }
  try { fsSync.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (name !== 'result.json') await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
