/**
 * End-to-end probe on the **production side** of track streams (`kind: 'below'`) for below-dependent
 * cards (the stream production half in acceptance check of `docs/plan/render-refactor-task.md`
 * "Wu-2"; `docs/plan/prerender-products-contract.md` sections 5.2 and 5.3).
 *
 *   node scripts/probes/stream-below-probe.mjs [--origin http://127.0.0.1:27800 | --port 27804] [--media-port 27811]
 *        [--scenes a,b] [--sizes 960x540] [--out <dir>] [--keep] [--json <file>]
 *
 * If `--origin` is given, use that dev server; if not, start one at the checkout root (`--port`,
 * also occupying +1 and +2; do not touch 5190-5192), and tear it down by PID when finished.
 * Start `FramePipeline` directly in this process (same code as prerender process), library root
 * in a temp directory; this stream is enabled by default in production (probe explicitly sets
 * `PROMPTCUT_TEST_BELOW_STREAMS=1` once more). The half pasted back to stage is in
 * `stream-below-stage-probe.mjs`. Two scenes (see `below-stream-common.mjs`):
 *
 *   Jia  A frosted-glass card pressed on top of a moving card (particles) and a video
 *   Yi   The lower layer is semi-transparent (opacity 0.6, pill with shadow), with the same
 *        frosted-glass card pressed on top
 *
 * Frosted-glass card pinned as a heavy card (`pipeline.streamPicked` select all). Verify item by item:
 *
 *   1. This stream can be produced: the plan has a stream with `kind: 'below'` and `plane: 'stage'`
 *      attached to the frosted-glass card, all segments at full density; differential layer
 *      extraction records show no failures in practice (`below.failed` is empty,
 *      "drop one first on next" not enabled);
 *   2. Stream contains only the area modified by the target card: the tight rectangle measured in
 *      the sparse pass is significantly smaller than the full frame; stream segments starting from
 *      the frosted-glass card's own first frame (frame 6, not a multiple of 15), with no frames
 *      prior to its entrance inside (previously when segmenting by project frame number, the first
 *      segment had 6 frames prior to entrance that were fully transparent); pixels in the tight
 *      rectangle where target card made no modifications (where the two exported frames with and
 *      without target card are pixel-by-pixel identical) are also transparent when decoded;
 *   3. Overlay each decoded frame back onto "the exported frame at the same time with lower layers
 *      only", and compare against "the full exported frame at the same time" (premultiplied color,
 *      out of 255): difference does not exceed the difference from "passing the full exported frame
 *      through the same encoder as-is" (this is the encoding error); with a control: difference is
 *      significantly larger when compared against the full frame 7 frames later;
 *   4. Modify a card in lower layer: key for this stream changes, this card's layer in the ready
 *      index is replaced with the new key, and the producer no longer holds the stream for the old
 *      key (old segments no longer recognized); revert the change, key returns to the original
 *      one, old segments on disk are recognized back as-is without re-producing any; add a card
 *      on top of it: key stays unchanged, no segments re-produced;
 *   5. Other streams are unaffected: the standalone card in the lower layer still has its own
 *      single-card stream as usual.
 *
 * Used subsequently by "Below-3" (paste back to stage): `--keep` keeps the store root (one
 * `lib-<scene>-<aspect-ratio>` per scene), summary contains stream key, tight rectangle, and files
 * for each segment; how to render both exported frames and how to overlay a frame back for
 * comparison are both in `below-stream-common.mjs`; on the playback side, simply replace "decoded
 * frames" with stage screenshots.
 *
 * Outputs JSON conclusion, writes progress to stderr; exits non-zero if any check fails.
 * Elapsed time is recorded only.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { SEGMENT_FRAMES, splitFmp4, isolatedBelowProject, belowStreamsEnabled, BELOW_STREAMS_DEFAULT } from '../../server/frame-stream.mjs';
import { BELOW_STREAM_VERSION } from '../../server/card-identity.mjs';
import { streamSegmentFirstFrame, streamSegmentFrameCount } from '../../src/render/streamSegments.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, openStreamSegmentEncoder, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { decodePngRgba } from '../../server/bakery/capture-canvas.mjs';
import { FPS, DURATION, TARGET, ABOVE, scenarioProject, lowerClipIds, startDevServer, ensureVideo, serveMedia, emptyUrlOf, decodeSegment,
  newError, errorSummary, tallyDecoded, tallyDecodedDirect, composeDecoded, cropRgba, savePreview, round2, sleep } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '27804', args));
const MEDIA_PORT = Number(flagArg('media-port', '27811', args));
const SCENES = String(flagArg('scenes', 'a,b', args)).split(',').map((s) => s.trim()).filter((s) => s === 'a' || s === 'b');
const SIZES = String(flagArg('sizes', '960x540', args)).split(',').map((s) => s.trim().split('x').map(Number)).filter(([w, h]) => w > 0 && h > 0);
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-below-probe-${Date.now().toString(36)}`));
// This stream is enabled by default in production; explicitly set it here once so it is unaffected
// by external environment variables. Produced one by one in a single session
process.env.PROMPTCUT_TEST_BELOW_STREAMS = '1';
process.env.PROMPTCUT_STREAM_POOL = '1';

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
const SCENE_NAME = { a: 'A', b: 'B' };
const N = DURATION * FPS;
const pad = (n) => String(n).padStart(4, '0');

const out = { library: OUT, switchDefault: BELOW_STREAMS_DEFAULT, belowStreamVersion: BELOW_STREAM_VERSION, runs: [] };
await fs.mkdir(OUT, { recursive: true });
let dev = null, media = null, bakery = null;
const pipelines = [];
try {
  check(BELOW_STREAMS_DEFAULT === true, 'this kind of stream is on by default', BELOW_STREAMS_DEFAULT);
  check(belowStreamsEnabled() === true, 'on in the probe');
  check(BELOW_STREAM_VERSION === 1, 'the version of what goes into the stream is 1', BELOW_STREAM_VERSION);
  const ffmpeg = await findFfmpeg();
  let origin = ORIGIN;
  if (!origin) { dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'belowprobe' }); origin = dev.origin; say('spawn', { pid: dev.pid, port: PORT }); }
  out.origin = origin;
  const mediaDir = path.join(OUT, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  media = await serveMedia(MEDIA_PORT, mediaDir);

  for (const kind of SCENES) for (const [width, height] of SIZES) {
    const tag = `${SCENE_NAME[kind]} ${width}x${height}`;
    const run = { scene: SCENE_NAME[kind], size: `${width}x${height}` };
    out.runs.push(run);
    const dir = path.join(OUT, `ref-${kind}-${width}x${height}`);
    await fs.mkdir(dir, { recursive: true });
    const mediaUrl = kind === 'a' ? media.url(path.basename(await ensureVideo(ffmpeg, mediaDir, width, height))) : '';
    const project = scenarioProject(kind, { width, height, mediaUrl });
    const edited = scenarioProject(kind, { width, height, mediaUrl, edit: 'below' });

    // ---------- 1. Produce stream
    const pipeline = new FramePipeline({ root: path.join(OUT, `lib-${kind}-${width}x${height}`), origin: () => origin, interactive: true, playhead: () => null });
    pipelines.push(pipeline);
    pipeline.streamPicked = () => true; // Pin as heavy cards
    const producer = pipeline.streamProducer();
    producer.attachRoute();
    const layers = [];
    pipeline.readyIndex.subscribe((message) => { if (message.type === 'layer' && message.kind === 'stream') layers.push({ at: Date.now(), ...message }); });
    const allDense = () => {
      const status = producer.status();
      if (!status.streams.some((s) => s.kind === 'below')) return null;
      for (const s of status.streams) for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
      return !producer.workers.size && !producer.encoding.size ? status : null;
    };
    const t0 = Date.now();
    await pipeline.preload(project);
    const status = await until(`${tag}: all segments at full density`, allDense, 900_000, 500);
    if (!status) throw new Error(`${tag}: production did not finish: ${JSON.stringify(producer.status().log.slice(-8))}`);
    run.produceMs = Date.now() - t0;
    out.encoder = status.encoder;
    const row = status.streams.find((s) => s.kind === 'below');
    const state = [...producer.streams.values()].find((s) => s.spec.kind === 'below');
    const { spec, manifest } = state;
    run.stream = { streamKey: spec.streamKey, contentKey: spec.contentKey, clipIds: spec.clipIds, belowClipIds: spec.belowClipIds, belowScene: spec.belowScene, hasMedia: spec.hasMedia,
      replay: spec.replay, mountFrame: spec.mountFrame, bound: manifest.bound, tight: manifest.tight, segments: spec.lastSegment - spec.firstSegment + 1,
      below: row.below, capture: row.capture, resets: row.resets, replayedFrames: row.replayedFrames,
      files: Object.fromEntries(Object.entries(manifest.segments).map(([n, s]) => [n, { file: s.file, init: s.init, bytes: s.bytes, stride: s.stride }])) };
    run.kinds = status.streams.map((s) => ({ kind: s.kind, clipIds: s.clipIds }));
    say('produced', { tag, ms: run.produceMs, kinds: run.kinds, tight: manifest.tight, below: row.below });
    check(status.streams.filter((s) => s.kind === 'below').length === 1 && spec.clipIds.length === 1 && spec.clipIds[0] === TARGET, `${tag}: there is one stream that depends on the layers below, attached to the frosted-glass card`, run.kinds);
    check(manifest.kind === 'below' && manifest.plane === 'stage', `${tag}: the manifest says below, stage coordinates`, { kind: manifest.kind, plane: manifest.plane });
    check(JSON.stringify(spec.belowClipIds) === JSON.stringify([...lowerClipIds(kind)].reverse()), `${tag}: the lower layers counted into the key are exactly those in the scene (painter's order, lower ones first)`, spec.belowClipIds);
    check(spec.belowScene === false, `${tag}: the key did not fall back to the whole-project key`);
    check(spec.hasMedia === (kind === 'a'), `${tag}: with visual media, waits for the media to be in place before the screenshot`, spec.hasMedia);
    check(row.below && row.below.failed === null && row.below.primeLower === false, `${tag}: none of the measured checks of the differential layer extraction failed`, row.below);
    check(row.below?.checks >= 2 * run.stream.segments, `${tag}: every segment in both the sparse and full-density passes was measured`, row.below?.checks);
    check(row.below?.glassFrames > 0, `${tag}: the frosted glass's outer frame was measured`, row.below?.glassFrames);
    // Segments are counted from the target card's own first frame (0.2 s entrance → frame 6), with no
    // frames prior to its entrance in the stream
    const ENTRY = Math.ceil(0.2 * FPS - 1e-9);
    check(spec.originFrame === ENTRY && spec.firstSegment === 0 && manifest.originFrame === ENTRY && ENTRY % SEGMENT_FRAMES !== 0,
      `${tag}: the stream's first frame is the frame where the frosted-glass card enters (frame ${ENTRY}, not a multiple of 15), and the manifest records it`, { originFrame: spec.originFrame, firstSegment: spec.firstSegment, manifest: manifest.originFrame });
    check(row.below?.absent === 0, `${tag}: none of the captured frames is a "target card not on the page" frame (the stream no longer contains frames before the entrance)`, row.below?.absent);
    const lowerCard = kind === 'a' ? 'clip-move' : 'clip-block';
    check(status.streams.some((s) => s.kind === 'card' && s.clipIds[0] === lowerCard), `${tag}: the standalone card below still has its own single-card stream`, run.kinds);
    // 2a. Only contains the area modified by the target card
    const tight = manifest.tight;
    run.tightShare = tight ? round2(tight.w * tight.h / (width * height)) : null;
    check(!!tight && tight.w * tight.h < width * height * 0.5, `${tag}: the tight rectangle is clearly smaller than the full frame`, { tight, share: run.tightShare });

    // ---------- 2. Two exported frames: full frame, and lower layers only
    const emptyUrl = emptyUrlOf(origin, { width, height });
    if (!bakery) bakery = await openBakery({ url: emptyUrl });
    const exportFrames = async (proj, name) => {
      await bakery.reset(proj, emptyUrl);
      bakery.streamLease = null;
      await bakeFrames(bakery, { out: path.join(dir, `export-${name}`), fps: FPS, frames: `0-${N - 1}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
        onFrame: async (i, buf) => { await fs.writeFile(path.join(dir, `${name}-${pad(i)}.png`), buf); } });
    };
    await exportFrames(project, 'whole');
    await exportFrames(isolatedBelowProject(project, spec, { withTarget: false }), 'lower');
    const cache = new Map();
    const load = async (name, frame) => {
      const key = `${name}-${frame}`;
      if (cache.has(key)) return cache.get(key);
      const data = decodePngRgba(await fs.readFile(path.join(dir, `${name}-${pad(frame)}.png`)))?.data;
      if (!data) throw new Error(`cannot decode ${name}-${frame}`);
      cache.set(key, data);
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      return data;
    };

    // ---------- 3. Decode segments one by one, overlay back and compare
    const after = newError(), other = newError(), floor = newError();
    const quiet = { before: { frames: 0, alphaMax: 0, alphaSum: 0, pixels: 0 }, unchanged: { pixels: 0, alphaSum: 0, over16: 0 } };
    const previewAt = 47;
    let streamBytes = 0;
    for (let n = spec.firstSegment; n <= spec.lastSegment; n++) {
      const seg = manifest.segments[n];
      if (!check(seg?.stride === 1, `${tag}#${n}: full density`, seg)) continue;
      const meta = manifest.inits[seg.init];
      const rect = { x: meta.rect.x + spec.offset.x, y: meta.rect.y + spec.offset.y, w: meta.rect.w, h: meta.rect.h };
      check(JSON.stringify(meta.rect) === JSON.stringify(tight), `${tag}#${n}: uses the tight rectangle`, meta.rect);
      const init = await fs.readFile(producer.store.initFile(spec.streamKey, seg.init));
      const bytes = await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file));
      streamBytes += bytes.length;
      const decoded = await decodeSegment(ffmpeg, init, bytes, dir, `seg-${n}`);
      const frameBytes = rect.w * 2 * (rect.h + 8) * 3;
      if (!check(decoded.length === seg.samples * frameBytes, `${tag}#${n}: decoded ${seg.samples} frames`, decoded.length / frameBytes)) continue;
      // Reference: full exported frame cropped to the same rectangle, passed through the same encoder as-is
      // Frames covered by segment n: counted from this stream's own first frame
      // (`src/render/streamSegments.mjs`), with the final segment ending at its last frame
      const firstFrame = streamSegmentFirstFrame(n, spec.originFrame);
      check(seg.samples === streamSegmentFrameCount(n, spec.originFrame, spec.lastFrame), `${tag}#${n}: sample count = number of frames this segment covers`, { samples: seg.samples, firstFrame, lastFrame: spec.lastFrame });
      const plain = openStreamSegmentEncoder(ffmpeg, { encoder: status.encoder, fps: FPS, raw: { width: rect.w, height: rect.h } });
      for (let k = 0; k < seg.samples; k++) await plain.write(cropRgba(await load('whole', firstFrame + k), width, rect));
      const plainParts = splitFmp4((await plain.finish()).bytes);
      const plainDecoded = await decodeSegment(ffmpeg, plainParts.init, plainParts.segments[0], dir, `plain-${n}`);
      for (let k = 0; k < seg.samples; k++) {
        const f = firstFrame + k;
        const picture = decoded.subarray(k * frameBytes, (k + 1) * frameBytes);
        const whole = await load('whole', f), lower = await load('lower', f);
        tallyDecoded(after, picture, rect, lower, whole, width);
        tallyDecoded(other, picture, rect, lower, await load('whole', (f + 7) % N), width);
        tallyDecodedDirect(floor, plainDecoded.subarray(k * frameBytes, (k + 1) * frameBytes), rect, whole, width);
        // 2b. Decoded opacity: entire frames prior to entrance, identical pixels between both exported
        // frames in remaining frames
        const alphaTop = (rect.h + 8) * rect.w * 3;
        const absent = f < Math.ceil(0.2 * FPS - 1e-9);
        if (absent) quiet.before.frames++;
        for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
          const a = picture[alphaTop + (y * rect.w + x) * 3];
          if (absent) { quiet.before.pixels++; quiet.before.alphaSum += a; if (a > quiet.before.alphaMax) quiet.before.alphaMax = a; continue; }
          const i = ((y + rect.y) * width + x + rect.x) * 4;
          if (whole[i] === lower[i] && whole[i + 1] === lower[i + 1] && whole[i + 2] === lower[i + 2] && whole[i + 3] === lower[i + 3]) {
            quiet.unchanged.pixels++; quiet.unchanged.alphaSum += a; if (a > 16) quiet.unchanged.over16++;
          }
        }
        if (f === previewAt) {
          await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-back.png`), composeDecoded(picture, rect, lower, width), rect.w, rect.h);
          await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-truth.png`), cropRgba(whole, width, rect), rect.w, rect.h);
          await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-whole.png`), whole, width, height);
        }
      }
    }
    run.streamBytes = streamBytes;
    run.error = { compositedBackVsFullExportFrame: errorSummary(after), referenceFullFramePassedThroughEncoderAsIs: errorSummary(floor), controlFullFrameSevenFramesLater: errorSummary(other) };
    run.transparent = {
      framesBeforeEntrance: { frames: quiet.before.frames, opacityMean: round2(quiet.before.alphaSum / Math.max(1, quiet.before.pixels)), opacityMax: quiet.before.alphaMax },
      unchangedPixelsInTightRect: { pixels: quiet.unchanged.pixels, opacityMean: round2(quiet.unchanged.alphaSum / Math.max(1, quiet.unchanged.pixels)), shareOver16: +(quiet.unchanged.over16 / Math.max(1, quiet.unchanged.pixels)).toFixed(4) },
    };
    say('compare', { tag, ...run.error, transparent: run.transparent });
    const got = run.error.compositedBackVsFullExportFrame, ref = run.error.referenceFullFramePassedThroughEncoderAsIs, ctl = run.error.controlFullFrameSevenFramesLater;
    const streamFrames = spec.lastFrame - spec.originFrame + 1;
    check(got.pixels === streamFrames * tight.w * tight.h, `${tag}: all ${streamFrames} frames of this stream (frames ${spec.originFrame}-${spec.lastFrame}) were compared`, got.pixels / (tight.w * tight.h));
    check(got.mean <= ref.mean + 0.5 && got.bad <= ref.bad * 1.25 + got.pixels * 0.001, `${tag}: the difference between the composited-back result and the full export frame is within encoding error (no more than the difference from passing the full frame through the encoder as is)`, { got, ref });
    check(ctl.mean > 3 * got.mean && ctl.bad > 5 * (got.bad + 1), `${tag}: the control (full frame from another time) is clearly larger`, { got, ctl });
    check(quiet.before.frames === 0, `${tag}: the stream has no frames before the entrance`, run.transparent.framesBeforeEntrance);
    check(quiet.unchanged.pixels > 0 && quiet.unchanged.alphaSum / quiet.unchanged.pixels < 1.5 && quiet.unchanged.over16 / quiet.unchanged.pixels < 0.01,
      `${tag}: pixels in the tight rectangle that the target card did not change decode as transparent`, run.transparent.unchangedPixelsInTightRect);

    // ---------- 4. Modify a card in lower layer: key changes, old segments no longer recognized; revert to recognize back as-is
    const oldKey = spec.streamKey;
    const keyOfTarget = () => [...producer.streams.values()].find((s) => s.spec.kind === 'below')?.spec.streamKey ?? null;
    const segmentsBefore = producer.stats.segments;
    const editedAt = Date.now();
    await pipeline.preload(edited);
    const newKey = await until(`${tag}: the plan switched to a new version after the lower layer was changed`, () => { const k = keyOfTarget(); return k && k !== oldKey ? k : null; }, 120_000, 100);
    run.edit = { oldKey, newKey };
    if (check(!!newKey, `${tag}: when one card in the lower layer is edited, this stream's key changes`, { oldKey, now: keyOfTarget() })) {
      check(!producer.streams.has(oldKey), `${tag}: the producer no longer holds the stream of the old key`);
      const fresh = producer.streams.get(newKey);
      const reused = Object.values(fresh.manifest.segments).filter((s) => Object.values(manifest.segments).some((o) => o.file === s.file));
      check(reused.length === 0, `${tag}: the manifest of the new key has no old segments`, reused.length);
      const firstLayer = await until(`${tag}: the layer of the new key is sent out`, () => layers.find((l) => l.at >= editedAt && l.clipId === TARGET && l.key === newKey), 300_000, 200);
      const oldAfter = layers.filter((l) => l.at >= editedAt && l.clipId === TARGET && l.key === oldKey);
      check(!!firstLayer && oldAfter.length === 0, `${tag}: after the edit, the ready index sends this card's layer only with the new key and no longer with the old key`, { newLayer: !!firstLayer, oldAfter: oldAfter.length });
      // Record only, not treated as pass condition: whether single-card stream key of modified lower-layer
      // card changed. In Yi, it carries emphasis (shadow); existing single-card stream keys do not inspect
      // parameters of card preceding emphasis, so it does not change (pre-existing issue on `main`,
      // see report); keys for below-dependent streams take cached content key with full input chain,
      // unaffected by it
      run.edit.lowerCardStreamKeyChanged = !producer.streams.has(status.streams.find((s) => s.kind === 'card' && s.clipIds[0] === lowerCard)?.streamKey);
    }
    // Revert: key returns to the original one, old segments on disk recognized back as-is, none re-produced
    const producedMid = producer.stats.segments;
    const backAt = Date.now();
    await pipeline.preload(project);
    const back = await until(`${tag}: after reverting, the key returns to the original one`, () => (keyOfTarget() === oldKey ? oldKey : null), 120_000, 100);
    if (check(!!back, `${tag}: when reverted, the key returns to the original one`, keyOfTarget())) {
      const again = producer.streams.get(oldKey);
      const sameFiles = Object.entries(manifest.segments).every(([n, s]) => again.manifest.segments[n]?.file === s.file && again.manifest.segments[n]?.stride === 1);
      check(sameFiles, `${tag}: old segments are recognized again as they were (same set of files)`);
      const layer = await until(`${tag}: after reverting, the layer of the old key is sent out again`, () => layers.find((l) => l.at >= backAt && l.clipId === TARGET && l.key === oldKey), 60_000, 200);
      check(!!layer, `${tag}: after reverting, the ready index has the original key again`);
      await sleep(1500);
      const remade = Object.entries(again.manifest.segments).filter(([n, s]) => manifest.segments[n]?.file !== s.file).length;
      check(remade === 0, `${tag}: after reverting, none of this stream's segments were re-produced`, remade);
    }
    run.edit.segmentsProducedWhileEdited = producedMid - segmentsBefore;
    // Add a card on top of it: key stays unchanged, old segments used as-is, none re-produced
    await pipeline.preload(scenarioProject(kind, { width, height, mediaUrl, edit: 'above' }));
    const withAbove = await until(`${tag}: the plan switched to a new version after a card was added above`, () => ([...producer.streams.values()].some((s) => s.spec.clipIds.includes(ABOVE)) ? keyOfTarget() : null), 120_000, 100);
    run.edit.keyWithLayerAbove = withAbove;
    if (check(withAbove === oldKey, `${tag}: adding a card above it does not change this stream's key`, { oldKey, withAbove })) {
      await sleep(1500);
      const kept = producer.streams.get(oldKey);
      const same = Object.entries(manifest.segments).every(([n, s]) => kept.manifest.segments[n]?.file === s.file);
      check(same, `${tag}: after a card was added above, none of this stream's segments were re-produced`);
    }

    cache.clear();
    run.log = producer.status().log.map((l) => l.message).filter((m) => /differential|tight|failed|did not pass/.test(m)).slice(-12);
    await pipeline.close();
    pipelines.splice(pipelines.indexOf(pipeline), 1);
    dropStreamEncoderSpares();
    if (!KEEP) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
} catch (error) {
  fails.push(`Exception: ${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  for (const pipeline of pipelines) { try { await pipeline.close(); } catch { /* ignore */ } }
  try { await bakery?.close(); } catch { /* ignore */ }
  dropStreamEncoderSpares();
  try { await media?.close(); } catch { /* ignore */ }
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (name !== 'result.json' && name !== 'previews') await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
