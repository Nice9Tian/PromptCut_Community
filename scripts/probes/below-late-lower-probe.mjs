/**
 * Whether stream is produced correctly when a below-dependent card sits on top of a **mid-entry**
 * motion-style card (`BELOW_DISCARD_SHOT` in `server/frame-stream.mjs`).
 *
 *   node scripts/probes/below-late-lower-probe.mjs (--origin http://127.0.0.1:<dev server> | --port 26980)
 *        [--pill-start 1] [--pill-text "control card"] [--out <dir>] [--json <file>] [--keep]
 *
 * Project (960x540, 4 seconds): frosted-glass card on top (odometer, enters at frame 6),
 * `punch-pill` below, entering at `--pill-start` seconds (defaults to 1 second, frame 30). Spawns a
 * `FramePipeline` in this process (same code as prerender process), pinning only the frosted-glass
 * card as a heavy card.
 *
 * Issue identified in this scenario (2026-10-14, pre-fix): when frosted glass sits on top of the
 * lower card, its animation does not advance on screen during ticks where frames are stepped
 * without capturing screenshots (the animation timestamp in the page is correct, but synthesized
 * pixels remain frozen at the mount frame), so:
 *   - In the sparse version (only the first frame of each segment is captured), the pill lags 5 to
 *     7 frames behind expected;
 *   - In full density segments re-produced individually after breaking lease (replaying forward from
 *     the mount frame), the pill stays frozen at its initial entrance state;
 *   - While frames are catching up tick by tick, differential layer extraction self-checks (hiding
 *     then revealing target card; shot with target card must remain unchanged) sometimes fail,
 *     causing the entire stream to be marked dead and produce no further frames.
 * The fix is to draw and discard a frame on every tick stepped by this stream. This probe pins down
 * all three points, leaving nothing to chance: points 2 and 3 are reliably measurable every time.
 *
 * Item-by-item verification (baseline is the export page: full-canvas image R and lower-layer-only
 * image L; overlaying the layer decoded from the stream onto L and comparing against R within the
 * stream rectangle, using premultiplied color, out of 255):
 *   1. Both the sparse pass and the full density pass finish producing; differential layer
 *      extraction is not marked dead.
 *   2. Full density (produced continuously holding lease): average difference of each overlaid
 *      frame against the same frame on the export page is within the order of codec error.
 *   3. Sparse version: the single shot for each segment, overlaid onto the lower layer at its
 *      frame, also matches (pre-fix, segments after the pill entered did not match).
 *   4. Invalidate trailing segments and re-produce one by one in reverse (each breaking lease and
 *      replaying forward from the mount frame): re-produced results are frame-for-frame identical to
 *      item 2 (average difference after decoding near 0), and overlaid results match as well
 *      (pre-fix, remained frozen at the pill's initial entrance).
 * Control: comparing the same overlaid frame with the export image 6 frames prior shows noticeably
 * worse results during the pill's entrance (this comparison method successfully quantifies "lagging
 * by how many frames").
 *
 * Outputs JSON conclusion, writes progress to stderr; exits non-zero if any item fails. Elapsed time
 * is recorded only.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { isolatedBelowProject } from '../../server/frame-stream.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { decodePngRgba } from '../../server/bakery/capture-canvas.mjs';
import { streamSegmentFirstFrame } from '../../src/render/streamSegments.mjs';
import { startDevServer, emptyUrlOf, decodeSegment, newError, errorSummary, tallyDecoded, sleep, round2 } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
if (!ORIGIN && !PORT) { console.error('Pass --origin <dev server> or --port <start your own>'); process.exit(2); }
const pillStart = Number(flagArg('pill-start', '1', args));
const pillText = String(flagArg('pill-text', '对照卡', args));
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-below-late-lower-${Date.now().toString(36)}`));
process.env.PROMPTCUT_STREAM_POOL = '1';

const W = 960, H = 540, FPS = 30, SECONDS = 4, N = SECONDS * FPS, TARGET = 'clip-t';
const PILL_FIRST = Math.ceil(pillStart * FPS - 1e-9);
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 700))); say('FAIL', { label, extra }); } return !!cond; };

const project = { id: `below-late-lower-${pillStart}-${pillText.length}`, name: 'Layer below enters midway', width: W, height: H, fps: FPS, duration: SECONDS,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-t', name: 't', hidden: false, clips: [{ id: TARGET, kind: 'card', cardId: 'odometer', start: 0.2, end: SECONDS, params: { position: 'left', value: 86420, label: 'x' },
      frame: { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: 0.5 } }] },
    { id: 'tr-p', name: 'p', hidden: false, clips: [{ id: 'clip-p', kind: 'card', cardId: 'punch-pill', start: pillStart, end: SECONDS, params: { text: pillText }, frame: { x: 320, y: 150, w: 560, h: 200, anchor: [0.5, 0.5] } }] },
  ] };

const out = { out: OUT, pillStart, pillText, pillFirstFrame: PILL_FIRST };
await fs.mkdir(OUT, { recursive: true });
let dev = null, pipeline = null, bakery = null;
const started = Date.now();
try {
  const ffmpeg = await findFfmpeg();
  let origin = ORIGIN;
  if (!origin) {
    process.env.PROMPTCUT_EXPORT_DIR = path.join(OUT, 'export');
    await fs.mkdir(process.env.PROMPTCUT_EXPORT_DIR, { recursive: true });
    dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'belowlate' });
    origin = dev.origin;
    say('spawn', { pid: dev.pid, port: PORT });
  }
  origin = origin.replace(/\/+$/, '');

  /* ---------- Stream production: produce only the sparse pass first */
  pipeline = new FramePipeline({ root: path.join(OUT, 'lib'), origin: () => origin, interactive: true, playhead: () => null });
  pipeline.streamPicked = (_entry, clipId) => clipId === TARGET;
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  let holdDense = true;
  const nextTask = producer.nextTask.bind(producer);
  producer.nextTask = (b) => { const task = nextTask(b); return task && task.stride === 1 && holdDense ? null : task; };
  await pipeline.preload(project);
  const stateNow = () => [...producer.streams.values()].find((s) => s.spec.kind === 'below') ?? null;
  const strides = () => { const s = stateNow(); return s ? Array.from({ length: s.spec.lastSegment + 1 }, (_, n) => s.manifest.segments[n]?.stride ?? 0) : []; };
  const idle = () => !producer.workers.size && !producer.encoding.size;
  /** Waits until `done(interval between segments)` is satisfied, or this stream is marked dead; also returns on timeout (recorded as-is) */
  const wait = async (done, ms = 240_000) => {
    const t0 = Date.now();
    for (;;) {
      await sleep(400);
      const s = stateNow();
      if (s?.below?.failed) return 'failed';
      if (s && idle() && done(strides())) return 'ok';
      if (Date.now() - t0 > ms) return 'timeout';
    }
  };
  const sparse = await wait((st) => st.length > 0 && st.every((x) => x >= 1));
  const state = stateNow();
  out.sparse = { result: sparse, strides: strides(), below: state?.below ? { failed: state.below.failed, checks: state.below.checks, last: state.below.last } : null };
  say('sparse', out.sparse);
  if (!check(sparse === 'ok' && out.sparse.strides.every((x) => x > 1), 'The sparse pass finished producing and diff-based layer extraction was not declared dead', out.sparse)) throw new Error('The sparse pass did not finish producing');
  const { spec } = state;
  out.stream = { originFrame: spec.originFrame, lastSegment: spec.lastSegment, mountFrame: spec.mountFrame, replay: spec.replay, belowClipIds: spec.belowClipIds };
  check(spec.replay === true && spec.belowClipIds.includes('clip-p'), 'This stream must be replayed (the layer below is a motion-style card)', out.stream);

  /** Decodes segment n: one block per frame (premultiplied color on top, opacity on bottom), along with the rectangle it uses */
  const decodeOf = async (n, tag) => {
    const seg = stateNow().manifest.segments[n];
    const meta = stateNow().manifest.inits[seg.init];
    const rect = { x: meta.rect.x + spec.offset.x, y: meta.rect.y + spec.offset.y, w: meta.rect.w, h: meta.rect.h };
    const init = await fs.readFile(producer.store.initFile(spec.streamKey, seg.init));
    const bytes = await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file));
    const decoded = await decodeSegment(ffmpeg, init, bytes, OUT, `${tag}-${n}`);
    const frameBytes = rect.w * 2 * (rect.h + 8) * 3;
    return { seg, rect, frames: Array.from({ length: Math.floor(decoded.length / frameBytes) }, (_, k) => decoded.subarray(k * frameBytes, (k + 1) * frameBytes)) };
  };
  const sparseDecoded = [];
  for (let n = 0; n <= spec.lastSegment; n++) sparseDecoded.push(await decodeOf(n, 'sparse'));

  holdDense = false;
  producer.kick();
  const dense = await wait((st) => st.every((x) => x === 1));
  out.dense = { result: dense, strides: strides(), below: { failed: stateNow().below.failed, checks: stateNow().below.checks, last: stateNow().below.last }, capture: stateNow().capture ?? null };
  say('dense', out.dense);
  if (!check(dense === 'ok', 'The full-density pass finished producing and diff-based layer extraction was not declared dead', out.dense)) throw new Error('The full-density pass did not finish producing');
  const denseDecoded = [];
  for (let n = 0; n <= spec.lastSegment; n++) denseDecoded.push(await decodeOf(n, 'dense'));

  /* ---------- Baseline: the two images from the export page */
  const emptyUrl = emptyUrlOf(origin, { width: W, height: H });
  bakery = await openBakery({ url: emptyUrl });
  const exportAll = async (proj) => {
    await bakery.reset(proj, emptyUrl);
    bakery.streamLease = null;
    const frames = new Map();
    await bakeFrames(bakery, { out: path.join(OUT, 'ref'), fps: FPS, frames: `0-${N - 1}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
      onFrame: async (i, buf) => { frames.set(i, decodePngRgba(Buffer.from(buf)).data); } });
    return frames;
  };
  const whole = await exportAll(project);
  const lower = await exportAll(isolatedBelowProject(project, spec, { withTarget: false }));
  say('exported', { frames: whole.size });
  /** Overlays the layer at frame f back onto the lower layer at frame `lowerAt`, compared against the full canvas at frame `truthAt`: average difference */
  const meanOf = (picture, rect, lowerAt, truthAt) => { const e = newError(); tallyDecoded(e, picture, rect, lower.get(lowerAt), whole.get(truthAt), W); return errorSummary(e).mean; };
  const LAG = 6;

  /* ---------- 2. Full density (produced continuously holding lease) */
  {
    const rows = [];
    for (let n = 0; n <= spec.lastSegment; n++) {
      const first = streamSegmentFirstFrame(n, spec.originFrame);
      denseDecoded[n].frames.forEach((picture, k) => { const f = first + k; rows.push({ f, same: meanOf(picture, denseDecoded[n].rect, f, f), lagged: f - LAG >= 0 ? meanOf(picture, denseDecoded[n].rect, f, f - LAG) : null }); });
    }
    const worst = rows.reduce((a, b) => (b.same > a.same ? b : a));
    const entering = rows.filter((r) => r.f >= PILL_FIRST + LAG && r.f < PILL_FIRST + 14);
    out.denseCheck = { frames: rows.length, average: round2(rows.reduce((s, r) => s + r.same, 0) / rows.length), worstFrame: worst,
      pillEntranceVsSameFrame: round2(entering.reduce((s, r) => s + r.same, 0) / Math.max(1, entering.length)), controlVsSixFramesEarlier: round2(entering.reduce((s, r) => s + r.lagged, 0) / Math.max(1, entering.length)) };
    say('2-dense', out.denseCheck);
    check(rows.length === spec.lastFrame - spec.originFrame + 1 && worst.same < 3, 'Full density: for every frame, the composited-back result differs from the export page\'s same frame only on the order of encoding error (mean difference under 3)', out.denseCheck);
    check(out.denseCheck.controlVsSixFramesEarlier > out.denseCheck.pillEntranceVsSameFrame * 1.5 + 0.3, 'Control: during the pill entrance, comparing against the export frame from six frames earlier is clearly worse (the lag in frames can be measured)', out.denseCheck);
  }

  /* ---------- 3. Sparse version: the single shot for each segment */
  {
    const rows = [];
    for (let n = 0; n <= spec.lastSegment; n++) {
      const f = streamSegmentFirstFrame(n, spec.originFrame);
      rows.push({ segment: n, frame: f, same: meanOf(sparseDecoded[n].frames[0], sparseDecoded[n].rect, f, f), lagged: f - LAG >= 0 ? meanOf(sparseDecoded[n].frames[0], sparseDecoded[n].rect, f, f - LAG) : null });
    }
    out.sparseCheck = rows;
    say('3-sparse', { rows });
    check(rows.every((r) => r.same < 3), 'Sparse version: the one image of each segment, composited back onto the layer below at its frame, matches the export page\'s same frame (mean difference under 3)', rows.filter((r) => r.same >= 3));
  }

  /* ---------- 4. Re-produce with broken lease: one by one in reverse */
  {
    const picks = [...new Set([spec.lastSegment - 1, Math.max(2, Math.ceil((PILL_FIRST - spec.originFrame) / 15) + 1), Math.max(1, Math.ceil((PILL_FIRST - spec.originFrame) / 15))])]
      .filter((n) => n >= 1 && n <= spec.lastSegment).sort((a, b) => b - a);
    const rows = [];
    const before = stateNow().replayedFrames ?? 0;
    for (const n of picks) {
      delete stateNow().manifest.segments[n];
      stateNow().failures?.delete?.(n);
      producer.kick();
      const again = await wait((st) => st.every((x) => x === 1));
      if (!check(again === 'ok', `Segment ${n} was produced again after being invalidated`, { again, failed: stateNow().below.failed })) break;
      const redo = await decodeOf(n, 'redo');
      const first = streamSegmentFirstFrame(n, spec.originFrame);
      let diff = 0, same = 0;
      redo.frames.forEach((picture, k) => {
        const a = denseDecoded[n].frames[k];
        let sum = 0;
        for (let i = 0; i < picture.length; i++) sum += Math.abs(picture[i] - a[i]);
        diff = Math.max(diff, sum / picture.length);
        same = Math.max(same, meanOf(picture, redo.rect, first + k, first + k));
      });
      rows.push({ segment: n, firstFrame: first, maxPerFrameMeanDiffVsLeaseContinued: round2(diff), worstCompositedBackVsExportSameFrame: round2(same) });
    }
    out.redo = { segments: rows, replayedFrames: (stateNow().replayedFrames ?? 0) - before, capture: stateNow().capture ?? null };
    say('4-redo', out.redo);
    check(rows.length === picks.length && out.redo.replayedFrames > 0, 'Re-produced segments had their lease broken and were replayed from the mount frame', out.redo);
    check(rows.every((r) => r.maxPerFrameMeanDiffVsLeaseContinued < 0.5), 'The re-produced output matches the lease-continued output frame by frame', rows);
    check(rows.every((r) => r.worstCompositedBackVsExportSameFrame < 3), 'The re-produced output composited back matches the export page\'s same frame', rows);
  }
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await pipeline?.close(); } catch { /* ignore */ }
  try { await bakery?.close(); } catch { /* ignore */ }
  dropStreamEncoderSpares();
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) { try { for (const name of await fs.readdir(OUT)) if (!/\.json$/.test(name)) await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ } }
}
out.elapsedMs = Date.now() - started;
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(out.ok ? 'PASS' : `FAIL ${fails.length}`);
process.exit(out.ok ? 0 : 1);
