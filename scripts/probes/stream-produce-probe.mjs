/**
 * End-to-end probe for R8 track stream **production side** (encoding / splitting and indexing /
 * continuous production / isolation items in "Acceptance check" of task brief `docs/plan/r8-streams-task.md`).
 *
 *   node scripts/probes/stream-produce-probe.mjs [--origin http://127.0.0.1:5230] [--out <dir>] [--keep] [--json <file>]
 *
 * Directly spins up a `FramePipeline` in this process (same code as prerender process, `interactive: true`),
 * store root placed in temp directory, export page hitting the dev server at `--origin` (defaults to
 * `dev-test` in `.claude/launch.json`, or `PC_STAGE_TEST_URL`). Feeds a project containing three heavy cards,
 * waits for all track streams to finish production (sparse first, then full density), then checks each item:
 *
 *   1. Exactly 15 samples per segment (except the last segment of each stream: segments count from
 *      the stream's own first frame to its last frame); first frame is IDR; only one moof; `mfra` not
 *      written to disk;
 *   2. `init.mp4` is written only once per variant, and subsequent segments calculate `ftyp + moov`
 *      byte-for-byte identical to it;
 *   3. Sparse segment (each segment captures only the first frame and repeats it for remaining frames)
 *      size ≤ 1.0× full density; after sparse segments are replaced by full density, old files are
 *      deleted within 5 seconds;
 *   4. Encoding time for a 15-frame segment (recorded only, not a pass condition; original gate was
 *      1080p full-frame stream p50 ≤ 300 ms), segment size (≤ 512 KB);
 *   5. Continuous production pays only one page turn: remount count in `bakeStream` ≤ stream count × 2
 *      (one sparse pass + one full-density pass); concurrent active segment encoders ≤ 2 × streamPool;
 *   6. One `kind: 'stream'` layer per stream in ready index, unit is segment number; group streams
 *      (`--group` squeezes decoder budget to 1) carry `groupClipIds`;
 *   7. **Isolation**: color of another card overlapping with the particle card does not appear in
 *      particle stream segments (decoded with ffmpeg and checked pixel-by-pixel);
 *   8. Tight rectangle: for cards with bounding box smaller than frame, after measurement in the sparse
 *      pass, full-density segments use the tightened rectangle (new variant);
 *   9. Mean alpha error ≤ 0.5 / 255 (encode a segment from the same batch of 15 PNGs, decode back with
 *      ffmpeg and compare lower half alpha);
 *  10. Reproduce segment 5 alone (outdate its signature): redo only this segment, index interval unchanged,
 *      old file deleted within 5 seconds (G6);
 *  11. F5: shut down this FramePipeline, start a new one on the same store root: scan disk and mount keys,
 *      claim by key after project arrives, emit each stream's layers as-is, without reproducing any segment;
 *  12. Group stream (`--group`): group stream segments contain exactly those cards in the group (both
 *      particle green and pill blue are present);
 *  13. Environment fingerprint goes into result key (M4, contract E.7): fingerprint in diagnostics is
 *      16-character hex, snapshot key and stream key both equal `resultKeyOf(content key, fingerprint)`.
 *
 * Outputs JSON conclusion; exits non-zero if any item fails. `--keep` does not delete store root
 * (keeps it for `stream-play-probe.mjs`).
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { devOrigin, flagArg } from './probe-connect.mjs';
import { createTimings } from './probe-timings.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { splitFmp4, segmentInfo, topLevelBoxes, SEGMENT_FRAMES } from '../../server/frame-stream.mjs';
import { bakeStream } from '../../server/bakery/bake.mjs';
import { openStreamSegmentEncoder } from '../../server/bakery/ffmpeg.mjs';
import { PROJECT, until as untilIn } from './stream-probe-project.mjs';
import { segmentSignature } from '../../server/frame-stream.mjs';
import { streamSegmentFrameCount } from '../../src/render/streamSegments.mjs';
import { resultKeyOf } from '../../server/render-node/fingerprint.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const origin = flagArg('port', null, args) ? `http://127.0.0.1:${flagArg('port', null, args)}` : devOrigin(args);
const KEEP = args.includes('--keep');
const GROUP = args.includes('--group');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-probe-${Date.now().toString(36)}`));
const JSON_OUT = flagArg('json', null, args);
if (GROUP) process.env.PROMPTCUT_STREAM_DECODERS = '1';

const fails = [];
const timings = createTimings('stream-produce-probe');
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); return cond; };

async function until(label, fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); return null; }
    await new Promise(r => setTimeout(r, everyMs));
  }
}

/** ffmpeg decodes init + one segment into frame-by-frame RGBA (top-bottom stacked encoded frame) */
async function decodeSegment(init, seg, dir, name) {
  const file = path.join(dir, `${name}.mp4`);
  await fs.writeFile(file, Buffer.concat([init, seg]));
  const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { windowsHide: true, encoding: 'buffer', maxBuffer: 1 << 30 });
  return stdout;
}

const out = { origin, library: OUT, group: GROUP };
await fs.mkdir(OUT, { recursive: true });
const pipeline = new FramePipeline({ root: OUT, origin: () => origin, interactive: true, playhead: () => null });
// Read endpoint: this probe does not fetch bytes over HTTP (verifies disk directly), but producer only
// starts after read endpoint is connected (see `routeAttached`)
pipeline.streamProducer().attachRoute();
const layers = [];
const off = pipeline.readyIndex.subscribe(message => { if (message.type === 'layer' && message.kind === 'stream') layers.push(message); });
const started = Date.now();
try {
  await pipeline.preload(PROJECT);
  const producer = await until('producer is up', () => pipeline._streams?.streams.size ? pipeline._streams : null, 120000);
  if (!producer) throw new Error('The producer did not start');
  const expect = GROUP ? 1 : 3;
  check(producer.streams.size === expect, `Stream count should be ${expect}`, producer.streams.size);
  // All segments full density, no running workers / encoding
  const done = await until('all segments at full density', () => {
    const status = producer.status();
    if (!status.streams.length) return null;
    for (const s of status.streams) {
      for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
    }
    return !producer.workers.size && !producer.encoding.size ? status : null;
  }, 600000, 1000);
  out.produceMs = Date.now() - started;
  timings.record('All segments at full density (from preload)', out.produceMs);
  if (!done) throw new Error('Production did not finish');
  // G6: old files deleted with 5-second delay: wait 6 seconds before inspecting disk
  await new Promise(r => setTimeout(r, 6000));
  const status = producer.status();
  // M4 (contract E.7 "Probes"): environment fingerprint is finalized, snapshot key and stream key
  // both = resultKeyOf(content key, fingerprint)
  {
    const diagnostics = pipeline.diagnostics();
    const fingerprint = diagnostics.environment?.fingerprint;
    out.environment = diagnostics.environment ?? null;
    check(typeof fingerprint === 'string' && /^[0-9a-f]{16}$/.test(fingerprint), 'M4: diagnostics.environment.fingerprint is 16 hex digits', out.environment);
    const badControls = (diagnostics.plans || []).flatMap(p => (p.controls || [])
      .filter(c => c.snapshotKey && !(typeof c.contentKey === 'string' && c.envFingerprint === fingerprint && c.snapshotKey === resultKeyOf(c.contentKey, c.envFingerprint)))
      .map(c => ({ clipId: c.clipId, snapshotKey: c.snapshotKey, contentKey: c.contentKey, envFingerprint: c.envFingerprint })));
    check((diagnostics.plans || []).some(p => (p.controls || []).some(c => c.snapshotKey)), 'M4: diagnostics include a control with snapshotKey', diagnostics.plans);
    check(badControls.length === 0, 'M4: snapshotKey of plans[].controls[] === resultKeyOf(contentKey, envFingerprint), and envFingerprint is this process\'s fingerprint', badControls);
    const listed = diagnostics.streams?.streams ?? [];
    const badStreams = listed.filter(s => !(typeof s.contentKey === 'string' && s.streamKey === resultKeyOf(s.contentKey, fingerprint)))
      .map(s => ({ clipIds: s.clipIds, streamKey: s.streamKey, contentKey: s.contentKey }));
    check(listed.length > 0 && badStreams.length === 0, 'M4: streamKey of streams.streams[] === resultKeyOf(contentKey, environment.fingerprint)', { listed: listed.length, badStreams });
  }
  out.stats = status.stats;
  out.encoder = status.encoder;
  out.pool = status.pool;
  out.log = status.log.map(l => l.message);
  out.streams = [];
  for (const state of producer.streams.values()) {
    const { spec, manifest } = state;
    const dir = producer.store.dir(spec.streamKey);
    const files = await fs.readdir(dir);
    const segFiles = files.filter(f => f.endsWith('.m4s'));
    const inits = files.filter(f => f.startsWith('init-'));
    check(Number.isInteger(spec.originFrame) && spec.originFrame === spec.firstFrame && spec.firstSegment === 0 && manifest.originFrame === spec.originFrame,
      `${spec.clipIds}: segments are counted from this stream's own first frame, and the manifest records that frame`, { originFrame: spec.originFrame, firstFrame: spec.firstFrame, firstSegment: spec.firstSegment, manifest: manifest.originFrame });
    const record = { streamKey: spec.streamKey, kind: spec.kind, clipIds: spec.clipIds, originFrame: spec.originFrame, lastFrame: spec.lastFrame, bound: manifest.bound, tight: manifest.tight,
      segments: spec.lastSegment - spec.firstSegment + 1, segFiles: segFiles.length, inits: inits.length, variants: Object.keys(manifest.inits).length,
      encodeMs: [], bytes: [], sparseBytes: {} };
    check(!files.some(f => f.includes('mfra')), 'mfra is not written to disk', files);
    check(segFiles.length === record.segments, `${spec.clipIds}: after replacement only one file per segment remains on disk`, { segFiles: segFiles.length, segments: record.segments });
    // Each variant's init is byte-for-byte identical: each segment finds its own init from manifest,
    // then compares with ftyp+moov in ffmpeg output: manifest's init itself is "the copy captured during
    // the first encode"; if subsequent segments encode differently it is recorded as a new variant, so
    // variant count is the criterion
    check(record.variants <= 2, `${spec.clipIds}: variant count (upper bound + tightened) ≤ 2`, record.variants);
    for (let n = spec.firstSegment; n <= spec.lastSegment; n++) {
      const seg = manifest.segments[n];
      const buf = await fs.readFile(path.join(dir, seg.file));
      const info = segmentInfo(buf);
      // Segments count from this stream's own first frame, last segment ends at its last frame
      // (`src/render/streamSegments.mjs`)
      const want = streamSegmentFrameCount(n, spec.originFrame, spec.lastFrame);
      check(want >= 1 && want <= SEGMENT_FRAMES && (n === spec.lastSegment || want === SEGMENT_FRAMES), `${spec.clipIds}#${n}: only the last segment may be partial`, want);
      check(info.sampleCount === want, `${spec.clipIds}#${n}: sample count`, { got: info.sampleCount, want });
      check(info.firstSampleIsSync === true, `${spec.clipIds}#${n}: first frame is IDR`);
      check(info.moofs === 1 && topLevelBoxes(buf).every(b => b.type === 'moof' || b.type === 'mdat'), `${spec.clipIds}#${n}: only moof + mdat`);
      check(buf.length <= 512 * 1024, `${spec.clipIds}#${n}: segment ≤ 512 KB`, buf.length);
      record.encodeMs.push(seg.encodeMs);
      record.bytes.push(seg.bytes);
    }
    out.streams.push(record);
  }
  // Sparse vs. full-density size: logs record each variant; sparse segment bytes cannot be obtained from
  // production logs here (already replaced and deleted), so running another sparse encoding for the same
  // segment is wasteful: recorded by status segment table at the end of the sparse pass (see sparseSnapshot)
  out.sparseSnapshot = producer.sparseBytes ?? null;
  // Continuous production pays only one page turn: 10-segment particle background remounts only once
  // each for sparse pass and full-density pass (failure retries counted separately)
  for (const s of status.streams) out[`resets_${s.clipIds.join('+')}`] = s.resets;
  const bgStatus = status.streams.find(s => s.clipIds.includes('clip-bg'));
  if (bgStatus && !GROUP) check(bgStatus.resets?.sparse === 1 && bgStatus.resets?.dense === 1 && bgStatus.lastSegment - bgStatus.firstSegment + 1 >= 10,
    'Stream of 10 segments: the sparse pass and the density-fill pass each pay for only one page swap', bgStatus.resets);
  check(status.stats.maxAliveEncoders <= 2 * status.pool, 'Concurrently alive segment encoders ≤ 2 × streamPool', status.stats);
  check(status.stats.replacedDeleted >= 1, 'Old segments are deleted within 5 seconds after replacement', status.stats.replacedDeleted);
  // Ready index
  const byClip = new Map();
  for (const m of layers) byClip.set(m.clipId, m);
  out.layers = [...byClip.values()];
  for (const state of producer.streams.values()) {
    const layer = byClip.get(state.spec.topClipId);
    check(!!layer && layer.key === state.spec.streamKey, `${state.spec.topClipId}: the index has a layer for this stream`, layer ?? null);
    if (layer) check(JSON.stringify(layer.ranges) === JSON.stringify([[state.spec.firstSegment, state.spec.lastSegment]]), `${state.spec.topClipId}: index ranges = all segments`, layer.ranges);
    if (layer) check(layer.originFrame === state.spec.originFrame, `${state.spec.topClipId}: the layer carries this stream's first frame`, { layer: layer.originFrame, spec: state.spec.originFrame });
    if (GROUP && layer) check(Array.isArray(layer.groupClipIds) && layer.groupClipIds.length === state.spec.clipIds.length, 'The group stream\'s layer carries groupClipIds', layer);
  }
  // Isolation: blue from punchline pill must not appear in green particle background stream
  // (single-card stream)
  if (!GROUP) {
    const bg = [...producer.streams.values()].find(s => s.spec.clipIds[0] === 'clip-bg');
    const pill = [...producer.streams.values()].find(s => s.spec.clipIds[0] === 'clip-pill');
    for (const [state, name] of [[bg, 'bg'], [pill, 'pill']]) {
      if (!state) continue;
      const seg = state.manifest.segments[1];
      const init = await fs.readFile(producer.store.initFile(state.spec.streamKey, seg.init));
      const raw = await decodeSegment(init, await fs.readFile(path.join(producer.store.dir(state.spec.streamKey), seg.file)), OUT, `decoded-${name}`);
      const meta = state.manifest.inits[seg.init];
      const W = meta.width, Hc = meta.height, H = Hc / 2 - 8;
      const frame = raw.subarray(0, W * Hc * 4);
      let blue = 0, opaque = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const a = frame[((y + H + 8) * W + x) * 4];
        if (a > 200) opaque++;
        // Pill blue: high B, low R, B significantly higher than G (premultiplied color ≤ a; green particle
        // is high G low B)
        if (a > 200 && frame[i + 2] > 180 && frame[i] < 140 && frame[i + 2] - frame[i + 1] > 50) blue++;
      }
      out[`isolation_${name}`] = { width: W, height: H, bluePixels: blue, opaquePixels: opaque, rect: meta.rect };
    }
    if (out.isolation_bg) check(out.isolation_bg.bluePixels === 0, 'No punchline pill pixels in the particle background stream', out.isolation_bg);
    if (out.isolation_pill) check(out.isolation_pill.bluePixels > 1000, 'The punchline pill stream has its own blue pixels', out.isolation_pill);
    if (pill) check(pill.manifest.tight && pill.manifest.tight.w * pill.manifest.tight.h < pill.manifest.bound.w * pill.manifest.bound.h, 'Card whose frame is smaller than the picture: the tight rectangle is smaller than the upper bound', { bound: pill.manifest.bound, tight: pill.manifest.tight });
  }
  // Encoding time (recorded only; original acceptance check gate "a 1080p stream 15-frame segment encodes
  // in ≤ 300 ms, given no other encoders competing for CPU" is no longer a pass condition):
  // Capture 15 PNGs in memory first, then feed all at once to encoder for timing (G0-b measurement
  // method, non-overlapping with frame output)
  out.bench = [];
  for (const clipId of GROUP ? [] : ['clip-bg', 'clip-pill']) {
    const state = [...producer.streams.values()].find(s => s.spec.clipIds[0] === clipId);
    if (!state) continue;
    const bakery = await pipeline.leaseStreamBakery();
    const pngs = [];
    try {
      await bakery.reset(state.isolated, pipeline.emptyUrl(state.isolated), { deferCards: true });
      bakery.streamLease = null;
      const rect = state.manifest.tight ?? state.manifest.bound;
      const clip = { x: rect.x + state.spec.offset.x, y: rect.y + state.spec.offset.y, w: rect.w, h: rect.h };
      const t0 = Date.now();
      await bakeStream(bakery, { streamSignature: 'bench', fromFrame: 30, toFrame: 44, stride: 1, fps: 30, mountFrame: state.spec.mountFrame, clip,
        onFrame: async (_f, png) => { pngs.push(png); } });
      const captureMs = Date.now() - t0;
      const runs = [];
      for (let k = 0; k < 3; k++) {
        const enc = openStreamSegmentEncoder('ffmpeg', { encoder: status.encoder, fps: 30 });
        const e0 = Date.now();
        for (const png of pngs) await enc.write(png);
        const result = await enc.finish();
        runs.push({ ms: Date.now() - e0, bytes: result.bytes.length });
      }
      runs.sort((a, b) => a.ms - b.ms);
      // Alpha error: encode these 15 images into a segment, decode back with ffmpeg, compare lower half
      // grayscale vs. original PNG alpha
      const enc = openStreamSegmentEncoder('ffmpeg', { encoder: status.encoder, fps: 30 });
      for (const png of pngs) await enc.write(png);
      const encoded = await enc.finish();
      const { init: initBuf, segments: segs } = splitFmp4(encoded.bytes);
      const raw = await decodeSegment(initBuf, segs[0], OUT, `alpha-${clipId}`);
      const W = rect.w, H = rect.h, Hc = 2 * (H + 8);
      let sum = 0, n = 0, max = 0;
      for (let k = 0; k < pngs.length; k++) {
        const ref = PNG.sync.read(pngs[k]);
        const frame = raw.subarray(k * W * Hc * 4, (k + 1) * W * Hc * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const d = Math.abs(frame[((y + H + 8) * W + x) * 4] - ref.data[(y * W + x) * 4 + 3]);
          sum += d; n++; if (d > max) max = d;
        }
      }
      const alpha = { mean: +(sum / n).toFixed(4), max };
      out.bench.push({ clipId, rect, captureMsFor15: captureMs, encodeMs: runs.map(r => r.ms), p50: runs[1].ms, bytes: runs[1].bytes, alpha });
      check(alpha.mean <= 0.5, `${clipId}: mean alpha error ≤ 0.5 / 255`, alpha);
    } finally { pipeline.returnStreamBakery(bakery); }
  }
  const bgBench = out.bench.find(b => b.clipId === 'clip-bg');
  // Elapsed time recorded only (verification.md "elapsed time recorded only, not used as gate"): encoding
  // p50 was originally a pass condition of ≤ 300 ms, now only recorded
  for (const b of out.bench) {
    timings.record(`${b.clipId} 15-frame segment encoding p50`, b.p50, b.clipId === 'clip-bg' ? { formerLimit: '1080p full-frame stream ≤ 300 ms' } : {});
    timings.record(`${b.clipId} 15-frame capture`, b.captureMsFor15);
  }
  for (const item of status.stats.sparseVsDense ?? []) {
    if (item.sameRect) check(item.sparse <= item.dense, 'Sparse segment (one frame per segment) ≤ 1.0× full density (same rectangle)', item);
  }
  // Group stream: segments contain exactly those cards in the group: both pill blue and particle green
  // are present
  if (GROUP) {
    const state = [...producer.streams.values()][0];
    const seg = state.manifest.segments[1];
    const init = await fs.readFile(producer.store.initFile(state.spec.streamKey, seg.init));
    const raw = await decodeSegment(init, await fs.readFile(path.join(producer.store.dir(state.spec.streamKey), seg.file)), OUT, 'decoded-group');
    const meta = state.manifest.inits[seg.init];
    const W = meta.width, H = meta.height / 2 - 8;
    // Pill blue (center of frame); particles: right strip of frame (x ≥ 1300) has only particle background,
    // opaque pixels there belong to it
    let blue = 0, particles = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = raw[((y + H + 8) * W + x) * 4];
      if (a > 200 && raw[i + 2] > 180 && raw[i] < 140 && raw[i + 2] - raw[i + 1] > 50) blue++;
      if (x >= 1300 && a > 100) particles++;
    }
    out.groupContent = { clipIds: state.spec.clipIds, blue, particles };
    check(blue > 1000 && particles > 100, 'The group stream contains exactly the cards in the group (the pill\'s blue and the particles in the strip on the right are both present)', out.groupContent);
  }
  // G6: reproduce segment 5 alone: outdate its signature, redo only this segment, index interval
  // unchanged, delete old file within 5 seconds
  if (!GROUP) {
    const bg = [...producer.streams.values()].find(s => s.spec.clipIds[0] === 'clip-bg');
    const before = { ...bg.manifest.segments[5] };
    const segmentsBefore = producer.stats.segments;
    bg.manifest.segments[5] = { ...before, sig: 'stale' };
    producer.kick();
    const redone = await untilIn(fails, 'Segment 5 re-produced', () => {
      const seg = bg.manifest.segments[5];
      return seg.sig !== 'stale' && !producer.workers.size && !producer.encoding.size ? seg : null;
    }, 120000);
    // Old file deleted with 5-second delay: originally waited a fixed 6 seconds before inspecting disk
    // (effectively using 6 seconds as a gate). Now waits until it is gone (up to 60 seconds to prevent
    // hanging), elapsed time recorded only
    const goneT0 = Date.now();
    const oldFile = path.join(producer.store.dir(bg.spec.streamKey), before.file);
    let oldGone = before.file === redone?.file;
    while (!oldGone && Date.now() - goneT0 < 60000) {
      oldGone = !(await fs.stat(oldFile).then(() => true, () => false));
      if (!oldGone) await new Promise(r => setTimeout(r, 500));
    }
    timings.record('G6 old segment file deleted after replacement', Date.now() - goneT0, { formerLimit: 'Fixed wait of 6 seconds, then check the disk (design value: deleted within 5 seconds)' });
    const lastLayer = [...layers].reverse().find(m => m.clipId === 'clip-bg');
    out.resegment = { before: before.file, after: redone?.file, produced: producer.stats.segments - segmentsBefore, oldGone, ranges: lastLayer?.ranges,
      sigOk: redone?.sig === segmentSignature({ streamKey: bg.spec.streamKey, segment: 5, stride: 1, encoder: status.encoder, rect: bg.manifest.tight ?? bg.manifest.bound }) };
    check(out.resegment.produced === 1 && out.resegment.sigOk, 'Only segment 5 was re-produced', out.resegment);
    check(JSON.stringify(out.resegment.ranges) === JSON.stringify([[bg.spec.firstSegment, bg.spec.lastSegment]]), 'Index ranges unchanged after segment 5 is re-produced', out.resegment);
    check(oldGone, 'Old file deleted after replacement (duration in timings)', out.resegment);
  }
  const checkExists = file => fs.access(file).then(() => true, () => false);
  check(!(await checkExists(path.join(OUT, 'controls-html'))), 'No controls-html snapshot directory is generated under the frame store anymore');
  check(!(await checkExists(path.join(OUT, 'controls-local'))), 'No controls-local snapshot directory is generated under the frame store anymore');
  // F5: restart a FramePipeline on the same store root (simulates restart after prerender process is killed)
  {
    const keys = [...producer.streams.keys()];
    await pipeline.close();
    const restarted = new FramePipeline({ root: OUT, origin: () => origin, interactive: true, playhead: () => null });
    restarted.streamProducer().attachRoute();
    const seen = [];
    restarted.readyIndex.subscribe(m => seen.push(m));
    try {
      await restarted.rescanSnapshots();
      const staged = restarted.readyIndex.stagedKeys().filter(k => k.kind === 'stream').map(k => k.key);
      const beforeProject = seen.filter(m => m.type === 'layer' && m.kind === 'stream').length;
      await restarted.preload(PROJECT);
      const back = await untilIn(fails, 'F5: after restart each stream\'s layer is re-emitted', () => {
        const got = new Set(seen.filter(m => m.type === 'layer' && m.kind === 'stream').map(m => m.key));
        return keys.every(k => got.has(k)) ? got : null;
      }, 120000);
      await new Promise(r => setTimeout(r, 3000));
      out.restart = { staged: staged.length, streams: keys.length, layersBeforeProject: beforeProject, republished: back ? back.size : 0,
        producedAfterRestart: restarted._streams?.stats.segments ?? null };
      check(staged.length === keys.length && keys.every(k => staged.includes(k)), 'F5: the disk scan attaches each stream to its key', out.restart);
      check(beforeProject === 0, 'F5: no layer is emitted before the project is in place', out.restart);
      check(out.restart.producedAfterRestart === 0, 'F5: no segment is re-produced after restart', out.restart);
    } finally { await restarted.close().catch(() => {}); }
  }
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
} finally {
  off();
  out.fails = fails;
  out.timings = timings.list;
  await pipeline.close().catch(() => {});
  if (!KEEP) await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
  const text = JSON.stringify(out, null, 2);
  if (JSON_OUT) await fs.writeFile(JSON_OUT, text);
  console.log(text);
  timings.print();
  console.log(fails.length ? `FAIL ${fails.length}` : 'PASS');
  process.exit(fails.length ? 1 : 0);
}
