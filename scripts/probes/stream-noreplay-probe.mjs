/**
 * Remotion-style cards do not replay from mount frame during stream generation: server-side half
 * of the end-to-end probe (`docs/plan/prerender-products-contract.md` section 4.2; task brief
 * `docs/plan/render-refactor-task.md` "Wu").
 *
 *   node scripts/probes/stream-noreplay-probe.mjs [--port 27560] [--out <dir>] [--keep] [--json <file>]
 *
 * Starts a dev server at the checkout root (`--port`, also taking +1 and +2 as stage ports; does
 * not touch 5190-5192), directly starts a `FramePipeline` in this process (same code as prerender
 * process, `interactive: true`), and puts store root in a temp directory. Loads a project:
 *
 *   clip-av    audio-visual prompt pulse `av-pulse`    remotion-style (direct), ring spreads and fades over time (10 segments)
 *   clip-slow  probe card `probe-slow`                 remotion-style (direct), square translates over time
 *   clip-pill  punchline pill `punch-pill`             motion-style (stateful)
 *   clip-type  probe card `probe-typewriter`           motion-style (stateful), advances one slot every 100 ms
 *
 * remotion-style cards are independent in the review table, but declared as light cards and do not
 * enter the prerender set; the probe pins `pipeline.streamPicked` to select all ("pin as heavy cards"),
 * giving them streams to generate. Check item by item:
 *
 *   1. `replay` in `planStreams`: false for the two remotion-style streams, true for the two motion-style
 *      streams;
 *   2. After all are generated, `replayedFrames` for remotion-style streams in `status()` is consistently 0;
 *   3. Invalidate intermediate segments (7, 3, 5, out of order and non-adjacent) and re-generate, each
 *      breaking lease (`resets` increases): `replayedFrames` for remotion-style streams is still 0;
 *      `replayedFrames` for motion-style streams is greater than 0 (replays from mount frame as usual);
 *   4. Images are identical frame by frame (pixel comparison): for segments 2 and 6 of each stream,
 *      after reloading the page in the same session:
 *        Path A = no replay (do not pass mountFrame, warmup 0, runSegment's current behavior),
 *        Path B = replay as usual (pass mount frame, default warmup 3),
 *      compare PNG pixels frame by frame. The two paths for remotion-style streams must not differ by
 *      a single frame; motion-style streams serve as **control**: the two paths must show differences
 *      (proving this comparison detects "should replay but did not");
 *   5. Output stream is identical to generation with replay: encode Path B PNGs into a segment using
 *      the same encoder, and compare byte-for-byte against the segment generated without replay by
 *      runSegment in the stream store (if different, decode and compare pixel by pixel).
 *
 * Outputs JSON conclusion, writes progress to stderr; exits with non-zero if any check fails.
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
import { PNG } from 'pngjs';
import { flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { SEGMENT_FRAMES, splitFmp4 } from '../../server/frame-stream.mjs';
import { streamSegmentFirstFrame, streamSegmentLastFrame } from '../../src/render/streamSegments.mjs';
import { bakeStream } from '../../server/bakery/bake.mjs';
import { openStreamSegmentEncoder } from '../../server/bakery/ffmpeg.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '27560', args));
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-noreplay-probe-${Date.now().toString(36)}`));
if ([5190, 5191, 5192].some((p) => p >= PORT && p <= PORT + 2)) throw new Error('This port range belongs to the user\'s resident dev servers; use another one');

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

const PROJECT = {
  id: 'noreplay-probe', name: 'No-replay probe', width: 1920, height: 1080, fps: 30, duration: 5,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-av', name: 'av', hidden: false, clips: [
      { id: 'clip-av', kind: 'card', cardId: 'av-pulse', start: 0.5, end: 4.5, params: { color: '#ff7a1a', duration: 4 }, frame: { x: 480, y: 270, w: 960, h: 540 } },
    ] },
    { id: 'tr-slow', name: 'slow', hidden: false, clips: [
      { id: 'clip-slow', kind: 'card', cardId: 'probe-slow', start: 0, end: 5, params: { burnMs: 0, label: 'slow' } },
    ] },
    { id: 'tr-pill', name: 'pill', hidden: false, clips: [
      { id: 'clip-pill', kind: 'card', cardId: 'punch-pill', start: 0, end: 4, params: { text: '不回放' }, frame: { x: 960, y: 540, w: 640, h: 360, anchor: [0.5, 0.5] } },
    ] },
    { id: 'tr-type', name: 'type', hidden: false, clips: [
      { id: 'clip-type', kind: 'card', cardId: 'probe-typewriter', start: 0, end: 5, params: {} },
    ] },
  ],
};
const DIRECT = ['clip-av', 'clip-slow'];
const STATEFUL = ['clip-pill', 'clip-type'];
const REGEN = [7, 3, 5]; // Three segments out of order and non-adjacent
const COMPARE = [2, 6]; // Two segments compared frame by frame

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

/** ffmpeg decodes init + one segment into frame-by-frame RGBA (top-bottom stacked encoded frame) */
async function decodeSegment(init, seg, dir, name) {
  const file = path.join(dir, `${name}.mp4`);
  await fs.writeFile(file, Buffer.concat([init, seg]));
  const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1 << 30, windowsHide: true });
  return stdout;
}

/** How many pixels differ between two PNGs (any RGBA component unequal); returns -1 if dimensions differ */
function diffPixels(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return -1;
  let n = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2] || pa.data[i + 3] !== pb.data[i + 3]) n++;
  }
  return n;
}
/** How many pixels have opacity > 0 (whether the frame is empty) */
function inkPixels(png) {
  const p = PNG.sync.read(png);
  let n = 0;
  for (let i = 3; i < p.data.length; i += 4) if (p.data[i] > 0) n++;
  return n;
}

const out = { port: PORT, library: OUT, project: PROJECT.id };
await fs.mkdir(OUT, { recursive: true });
const RUN = Date.now().toString(36);
const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pc-noreplay-dev-'));
let child = null;
let pipeline = null;
try {
  // ---------- 0. dev server (this checkout root, temp data directory)
  const log = [];
  child = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: {
      ...process.env, BROWSER: 'none', PROMPTCUT_DATA_DIR: path.join(TMP, 'data'), PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0',
      PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: `noreplay-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'noreplay-probe',
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

  // ---------- 1. Pipeline: pin remotion-style cards as heavy cards, load project, wait for all
  // segments to reach full density
  pipeline = new FramePipeline({ root: OUT, origin: () => origin, interactive: true, playhead: () => null });
  pipeline.streamPicked = () => true; // Pin as heavy cards: remotion-style cards are declared as light cards; without pinning there is no stream
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  const dense = () => {
    const status = producer.status();
    if (!status.streams.length) return null;
    for (const s of status.streams) for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
    return !producer.workers.size && !producer.encoding.size ? status : null;
  };
  const t0 = Date.now();
  await pipeline.preload(PROJECT);
  const ready = await until('producer is up', () => (pipeline._streams?.streams.size >= 4 ? pipeline._streams : null), 180_000);
  if (!ready) throw new Error('The producer did not start');
  const first = await until('all segments at full density', dense, 900_000, 1000);
  if (!first) throw new Error('The first production round did not finish');
  out.produceMs = Date.now() - t0;
  const stateOf = (clipId) => [...producer.streams.values()].find((s) => s.spec.clipIds.length === 1 && s.spec.clipIds[0] === clipId);
  const rowOf = (status, clipId) => status.streams.find((s) => s.clipIds.length === 1 && s.clipIds[0] === clipId);
  check(producer.streams.size === 4, '4 streams', producer.streams.size);
  out.encoder = first.encoder;

  // ---------- 2. replay in planStreams and replayedFrames after the first round of output
  out.firstRound = {};
  for (const clipId of [...DIRECT, ...STATEFUL]) {
    const row = rowOf(first, clipId);
    const want = STATEFUL.includes(clipId);
    check(!!row, `${clipId}: has a stream`);
    if (!row) continue;
    check(row.replay === want, `${clipId}: replay should be ${want}`, row.replay);
    out.firstRound[clipId] = { replay: row.replay, replayedFrames: row.replayedFrames, resets: row.resets, segments: row.lastSegment - row.firstSegment + 1 };
    if (!want) check(row.replayedFrames === 0, `${clipId}: replayedFrames is 0 after the first round of production`, row.replayedFrames);
  }
  say('first-round', out.firstRound);

  // ---------- 3. Invalidate intermediate segments and re-generate: out of order, each breaks lease
  const before = Object.fromEntries([...DIRECT, ...STATEFUL].map((id) => {
    const r = rowOf(producer.status(), id);
    return [id, { replayedFrames: r.replayedFrames, resets: { ...(r.resets ?? { sparse: 0, dense: 0 }) } }];
  }));
  for (const clipId of [...DIRECT, ...STATEFUL]) {
    const state = stateOf(clipId);
    for (const n of REGEN) delete state.manifest.segments[n];
  }
  producer.kick();
  const second = await until('the invalidated segments are produced again', () => {
    const status = dense();
    return status && status.streams.every((s) => REGEN.every((n) => s.segments[n]?.stride === 1)) ? status : null;
  }, 900_000, 1000);
  if (!second) throw new Error('The second production round did not finish');
  out.regen = {};
  for (const clipId of [...DIRECT, ...STATEFUL]) {
    const row = rowOf(second, clipId);
    const delta = row.replayedFrames - before[clipId].replayedFrames;
    const resetsDelta = (row.resets?.sparse ?? 0) + (row.resets?.dense ?? 0) - before[clipId].resets.sparse - before[clipId].resets.dense;
    out.regen[clipId] = { replay: row.replay, replayedFramesDelta: delta, resetsDelta };
    check(resetsDelta >= REGEN.length, `${clipId}: all ${REGEN.length} invalidated segments had their lease broken (page reset ≥ ${REGEN.length} times)`, resetsDelta);
    if (DIRECT.includes(clipId)) check(delta === 0 && row.replayedFrames === 0, `${clipId}(remotion-style): replayedFrames is still 0 after the lease is broken and the segment is re-produced`, { delta, total: row.replayedFrames });
    else check(delta > 0, `${clipId}(motion-style): after the lease is broken and the segment is re-produced, it still replays from the mount frame (replayedFrames increases)`, delta);
  }
  say('regen', out.regen);

  // ---------- 4. Frame-by-frame comparison: no replay (Path A) vs replay as usual (Path B)
  out.compare = [];
  const bakery = await pipeline.leaseStreamBakery();
  const SHOTS = path.join(OUT, 'shots');
  await fs.mkdir(SHOTS, { recursive: true });
  const cmpDir = path.join(OUT, 'cmp');
  await fs.mkdir(cmpDir, { recursive: true });
  try {
    for (const clipId of [...DIRECT, ...STATEFUL]) {
      const state = stateOf(clipId);
      const { spec, manifest } = state;
      const rect = manifest.tight ?? manifest.bound;
      const clip = { x: rect.x + spec.offset.x, y: rect.y + spec.offset.y, w: rect.w, h: rect.h };
      /**
       * Generate all PNGs for this segment after reloading the page; replay = as usual (pass mount frame,
       * default warmup).
       */
      const shoot = async (segment, replay) => {
        // Frames covered by this segment: count from this stream's own first frame (`src/render/streamSegments.mjs`)
        const fromFrame = streamSegmentFirstFrame(segment, spec.originFrame), toFrame = streamSegmentLastFrame(segment, spec.originFrame, spec.lastFrame);
        await bakery.reset(state.isolated, pipeline.emptyUrl(state.isolated), { deferCards: true });
        bakery.streamLease = null;
        const pngs = [];
        const stats = await bakeStream(bakery, {
          streamSignature: `${spec.streamKey}:${replay ? 'replay' : 'direct'}`, fromFrame, toFrame, stride: 1, fps: spec.fps,
          ...(replay ? { mountFrame: spec.mountFrame } : { warm: 0 }), clip, hasMedia: false,
          onFrame: async (_f, png) => { pngs.push(png); },
        });
        bakery.streamLease = null;
        return { pngs, stats };
      };
      for (const segment of COMPARE) {
        if (segment < spec.firstSegment || segment > spec.lastSegment) continue;
        const direct = await shoot(segment, false); // Path A
        const replay = await shoot(segment, true); // Path B
        check(direct.stats.replayed === 0, `${clipId}#${segment}: replayed of path A's bakeStream is 0`, direct.stats.replayed);
        check(direct.pngs.length === replay.pngs.length && direct.pngs.length > 0, `${clipId}#${segment}: both paths have the same frame count`, [direct.pngs.length, replay.pngs.length]);
        const diffs = direct.pngs.map((png, i) => diffPixels(png, replay.pngs[i]));
        const ink = replay.pngs.map(inkPixels);
        const rec = { clipId, segment, mode: STATEFUL.includes(clipId) ? 'stateful(control)' : 'direct', frames: direct.pngs.length, replayedB: replay.stats.replayed,
          diffPixelsMax: Math.max(...diffs), diffPixelsSum: diffs.reduce((a, b) => a + Math.max(0, b), 0), inkMin: Math.min(...ink), inkMax: Math.max(...ink) };
        out.compare.push(rec);
        say('compare', rec);
        if (DIRECT.includes(clipId)) {
          check(rec.diffPixelsMax === 0, `${clipId}#${segment}: for remotion-style cards, producing without replay and with replay is identical frame by frame (pixels)`, diffs);
          check(rec.inkMax > 0, `${clipId}#${segment}: the image is not empty`, ink);
          check(replay.stats.replayed > 0, `${clipId}#${segment}: path B did replay (replayed > 0)`, replay.stats.replayed);
        } else {
          check(rec.diffPixelsSum > 0, `${clipId}#${segment}: control: motion-style cards without replay must show a difference (this comparison can detect it)`, diffs);
        }
        // Keep two images to inspect (first frame): Path A, Path B
        await fs.writeFile(path.join(SHOTS, `${clipId}-seg${segment}-A-direct.png`), direct.pngs[Math.min(7, direct.pngs.length - 1)]);
        await fs.writeFile(path.join(SHOTS, `${clipId}-seg${segment}-B-replay.png`), replay.pngs[Math.min(7, replay.pngs.length - 1)]);

        // ---------- 5. This segment generated by runSegment (no replay) in stream store vs encoded
        // from Path B PNGs with the same encoder
        if (DIRECT.includes(clipId)) {
          const seg = manifest.segments[segment];
          const stored = await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file));
          const storedInit = await fs.readFile(producer.store.initFile(spec.streamKey, seg.init));
          const enc = openStreamSegmentEncoder(producer.ffmpeg, { encoder: producer.encoderName, fps: spec.fps });
          for (const png of replay.pngs) await enc.write(png);
          const encoded = await enc.finish();
          const { init: refInit, segments: refSegs } = splitFmp4(encoded.bytes);
          const sameBytes = Buffer.compare(refSegs[0], stored) === 0;
          let sameDecoded = null;
          if (!sameBytes) {
            const a = await decodeSegment(storedInit, stored, cmpDir, `stored-${clipId}-${segment}`);
            const b = await decodeSegment(refInit, refSegs[0], cmpDir, `ref-${clipId}-${segment}`);
            sameDecoded = Buffer.compare(a, b) === 0;
          }
          const row = { clipId, segment, storedBytes: stored.length, refBytes: refSegs[0].length, sameBytes, sameDecoded, storedStride: seg.stride, storedRect: manifest.inits[seg.init]?.rect ?? null };
          out.compare.push({ ...row, kind: 'stream-vs-replay-encode' });
          say('stream-vs-replay', row);
          check(seg.stride === 1, `${clipId}#${segment}: this segment in the stream store is at full density`, seg.stride);
          check(sameBytes || sameDecoded === true, `${clipId}#${segment}: the segment produced without replay in the stream store has the same encoded result as the one produced with replay (bytes or decoded pixels)`, row);
        }
      }
    }
  } finally { pipeline.returnStreamBakery(bakery); }

  // ---------- 6. Keys unchanged: replay is not in any key (in the same plan, direct stream
  // key = content key × fingerprint, independent of replay)
  out.finalStatus = producer.status().streams.map((s) => ({ clipIds: s.clipIds, replay: s.replay, replayedFrames: s.replayedFrames, resets: s.resets }));
  out.stats = producer.status().stats;
  check(DIRECT.every((id) => rowOf(producer.status(), id).replayedFrames === 0), 'replayedFrames of remotion-style streams is always 0 (checked once more at the end)');
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await pipeline?.close(); } catch { /* ignore */ }
  if (child && child.exitCode === null) {
    // Only terminate the process tree it spawned
    if (process.platform === 'win32') {
      await new Promise((resolve) => { const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); k.on('close', resolve); k.on('error', resolve); });
    } else child.kill('SIGKILL');
  }
  try { fsSync.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
  if (!KEEP) {
    // Keep shots and conclusion JSON, delete the rest (stream store)
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
