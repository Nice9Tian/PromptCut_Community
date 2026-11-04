/**
 * Track stream segments count from the stream's own first frame (`src/render/streamSegments.mjs`;
 * `docs/plan/html-snapshot-removal-dryrun.md` section 10.5), unit test on the stream generation side:
 * plan → split → executor → `StreamProducer.runSegment` → manifest, verifying "which project frames
 * segment n covers" all the way through.
 * Run: npm test -- server/test/stream-origin.test.mjs
 *
 * Clips **do not start on multiple-of-15 frames**, and some durations are not multiples of 15.
 * One of each of the three stream types: single-card stream, group stream (decoder budget clamped to
 * 1), below-dependent stream (enabled by default in product; cases for the first two set
 * `PROMPTCUT_TEST_BELOW_STREAMS` to 0 to disable it and test only their own type). No Chrome, no
 * ffmpeg: mock prerender room / `bakeStream` / encoder same as `stream-noreplay.test.mjs`; mock
 * `bakeStream` records frame range to output for each pass, encoder records each fed frame into
 * segment bytes. Real visuals (frame-by-frame pixel diff) verified by probe
 * `scripts/probes/stream-origin-probe.mjs`.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

/**
 * A real PNG (4×4, center 2×2 opaque): sparse pass needs to measure entity box from screenshot,
 * mock screenshot must be readable too. Each frame is suffixed with `<<f frame number>>`
 */
const SHOT = (() => {
  const png = new PNG({ width: 4, height: 4 });
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) png.data.fill(255, (y * 4 + x) * 4, (y * 4 + x) * 4 + 4);
  return PNG.sync.write(png);
})();
const shotOf = (frame) => Buffer.concat([SHOT, Buffer.from(`<<f${frame}>>`)]);

let scene = null;
const bakes = [];

function fakeBakery() {
  const bakery = {
    closed: false,
    page: { setViewport: async () => {}, evaluate: async () => structuredClone(scene.browserPlan) },
    client: { send: async () => {} },
    loadProject: async () => {},
    reset: async () => { bakery.page = { ...bakery.page }; },
    close: async () => { bakery.closed = true; },
  };
  return bakery;
}

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => fakeBakery(),
    findFfmpeg: async () => 'ffmpeg-fake',
    streamPngVideo: () => { throw new Error('Unit tests do not encode MOV'); },
    bakeFrames: async () => { throw new Error('This test does not render snapshots'); },
  },
});

mock.module(new URL('../bakery/bake.mjs', import.meta.url).href, {
  exports: {
    bakeFrames: async () => { throw new Error('This test does not render snapshots'); },
    dirtyStreamLease: (bakery) => { if (bakery?.streamLease) bakery.streamLease.dirty = true; },
    // Following real `bakeStream`: captures one frame every `stride` frames starting from `fromFrame`
    // (counted relative to `fromFrame`), delivering to `onFrame` one by one
    bakeStream: async (bakery, opts) => {
      const { streamSignature, fromFrame, toFrame, signal } = opts;
      const stride = Math.max(1, Math.round(Number(opts.stride) || 1));
      const lease = bakery.streamLease;
      const continues = !!lease && !lease.dirty && lease.page === bakery.page && lease.streamSignature === streamSignature && fromFrame === lease.lastFrame + 1;
      const shots = [];
      for (let frame = fromFrame; frame <= toFrame; frame += stride) {
        if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        shots.push(frame);
        await opts.onFrame?.(frame, shotOf(frame));
      }
      bakes.push({ streamSignature, fromFrame, toFrame, stride, continues, shots, hasMountFrame: Object.hasOwn(opts, 'mountFrame'), warm: opts.warm, clip: opts.clip });
      bakery.streamLease = { streamSignature, lastFrame: toFrame, lastShot: toFrame, dirty: false, page: bakery.page };
      return { reset: !continues, replayed: 0, captured: shots.length, captureMs: shots.length, stepMs: 0 };
    },
  },
});

const realFfmpeg = await import('../bakery/ffmpeg.mjs');
const box = (type, payload = Buffer.alloc(0)) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
};
/**
 * Structurally valid fMP4 segment; `mdat` contains each frame fed to encoder (mock screenshot,
 * suffixed with `<<f frame number>>`; same frame written repeatedly in sparse segments)
 */
function fakeFmp4(written, encoder) {
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomavc1', 'latin1'));
  const moov = box('moov', box('udta', Buffer.from(`enc:${encoder}`, 'latin1')));
  const tfhd = Buffer.alloc(8); tfhd.writeUInt32BE(0, 0); tfhd.writeUInt32BE(1, 4);
  const trun = Buffer.alloc(12); trun.writeUInt32BE(0x000004, 0); trun.writeUInt32BE(written.length, 4); trun.writeUInt32BE(0x02000000, 8);
  const moof = box('moof', box('traf', Buffer.concat([box('tfhd', tfhd), box('trun', trun)])));
  const mdat = box('mdat', Buffer.concat(written));
  return Buffer.concat([ftyp, moov, moof, mdat]);
}
mock.module(new URL('../bakery/ffmpeg.mjs', import.meta.url).href, {
  exports: {
    ...realFfmpeg,
    findFfmpeg: async () => 'ffmpeg-fake',
    pickStreamEncoder: async () => ({ encoder: 'libx264', results: [] }),
    openStreamSegmentEncoder: (ffmpeg, { encoder = 'libx264' }) => {
      const written = [];
      return {
        write: async (png) => { written.push(Buffer.from(png)); },
        finish: async () => ({ bytes: fakeFmp4(written, encoder), encodeMs: 1, tailMs: 0 }),
        abort: async () => {},
      };
    },
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { describeEnvironment } = await import('../render-node/fingerprint.mjs');
const { planTaskOf, splitPlan } = await import('../render-node/split.mjs');
const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
const { SPARSE_STRIDE, publicManifest, tightOverflowSides, extendSides, MEASURE_PAD_PX, TIGHT_WIDEN_MARGIN_PX, StreamProducer } = await import('../frame-stream.mjs');
const { layerStreamsOf } = await import('../artifact-transfer.mjs');
const { streamSegmentFirstFrame, streamSegmentLastFrame, streamSegmentOf } = await import('../../src/render/streamSegments.mjs');

const FPS = 30;
const OWN_ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
const OWN = OWN_ENV.fingerprint;
const PID = 'stream-origin';
const REV = 5;

/**
 * Four tracks from top to bottom (8 s, 240 frames). In points given by frame, none is multiple of 15:
 *   clip-top  standalone card, frames 0-239: on top, present throughout
 *   clip-g    frosted glass (below-dependent), frames 55-99: 45 frames
 *   clip-a    standalone card, frames 100-149: 50 frames, duration not multiple of 15 (last segment 5 frames)
 *   clip-b    standalone card, frames 40-129: 90 frames
 */
const FRAMES = { 'clip-top': [0, 239], 'clip-g': [55, 99], 'clip-a': [100, 149], 'clip-b': [40, 129] };
const CLIPS = Object.keys(FRAMES);
/**
 * In points and out points written in seconds, falling between two frames (first frame is first
 * integer frame after in point, sampling phase non-zero): most frame numbers divided by 30 are not
 * terminating decimals; using `frame / 30` directly as seconds would add an extra frame to first
 * frame due to floating-point error. Converting each pair below into frames yields `FRAMES` above.
 */
const START = { 'clip-top': 0, 'clip-g': 1.82, 'clip-a': 3.32, 'clip-b': 1.32 };
const END = { 'clip-top': 8, 'clip-g': 3.32, 'clip-a': 4.99, 'clip-b': 4.32 };
const CARD = { 'clip-top': 'demo-top', 'clip-g': 'glass', 'clip-a': 'demo-a', 'clip-b': 'demo-b' };
const CAPS = {
  'clip-top': { compositing: 'independent', frameMode: 'stateful' },
  'clip-g': { compositing: 'belowDependent', frameMode: 'stateful' },
  'clip-a': { compositing: 'independent', frameMode: 'stateful' },
  // clip-b is remotion-style (visuals determined solely by time and parameters): does not replay from
  // mount frame during stream generation
  'clip-b': { compositing: 'independent', frameMode: 'direct', need_prerendering: false },
};
function projectJson() {
  return {
    id: PID, fps: FPS, width: 320, height: 180, duration: 8, style: {}, media: [],
    tracks: CLIPS.map((clipId, i) => ({ id: `t${i + 1}`, clips: [{ id: clipId, cardId: CARD[clipId], start: START[clipId], end: END[clipId] }] })),
  };
}
scene = {
  browserPlan: {
    graph: {
      definitions: [],
      nodes: CLIPS.map((clipId) => ({ id: `n:${clipId}`, adapter: 'chrome', cardId: CARD[clipId], capabilities: { ...CAPS[clipId] }, inputs: {} })),
      outputs: CLIPS.map((clipId) => ({ nodeId: `n:${clipId}`, clipId, start: START[clipId], end: END[clipId], opacity: 1 })),
    },
    sourceVersions: { 'demo-top': 'builtin:1', glass: 'builtin:2', 'demo-a': 'builtin:3', 'demo-b': 'builtin:4' },
    environment: { width: 320, height: 180, fps: FPS },
  },
};

const roots = [];
const pipes = [];
async function cleanup() {
  await Promise.allSettled(pipes.splice(0).map((p) => p.close()));
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
}
async function streamPipeline({ budget = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-stream-origin-'));
  roots.push(root);
  const saved = process.env.PROMPTCUT_STREAMS;
  delete process.env.PROMPTCUT_STREAMS;
  let pipeline;
  try {
    pipeline = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive: true });
    pipes.push(pipeline);
    // These cards are not necessarily classified as heavy by declaration; all pinned here to produce
    // streams
    pipeline.streamPicked = () => true;
    const producer = pipeline.streamProducer();
    producer.encoderName = 'libx264';
    producer.ffmpeg = 'ffmpeg-fake';
    if (budget !== null) producer.budget = budget;
    producer.attachRoute();
  } finally {
    if (saved !== undefined) process.env.PROMPTCUT_STREAMS = saved;
  }
  return pipeline;
}
const executorFor = (pipeline) => createPrerenderExecutor({
  pipeline, projects: { get: async (projectId, projectRev) => (projectId === PID && projectRev === REV ? projectJson() : null) },
  prepareProject: (json) => structuredClone(json),
});
const view = (task) => ({ ...structuredClone(task), state: 'claimed', version: 1, attempts: 1 });
const signalNone = () => new AbortController().signal;
async function withBelow(on, fn) {
  const saved = process.env.PROMPTCUT_TEST_BELOW_STREAMS;
  process.env.PROMPTCUT_TEST_BELOW_STREAMS = on ? '1' : '0';
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.PROMPTCUT_TEST_BELOW_STREAMS; else process.env.PROMPTCUT_TEST_BELOW_STREAMS = saved;
  }
}
const manifestOf = async (pipeline, key) => JSON.parse(await fs.readFile(path.join(pipeline.root, 'streams', key, 'stream.json'), 'utf8'));
/** Every frame fed into encoder is recorded in segment file `mdat` → frame number array */
async function framesInSegment(pipeline, key, file) {
  const bytes = await fs.readFile(path.join(pipeline.root, 'streams', key, file));
  return [...bytes.toString('latin1').matchAll(/<<f(\d+)>>/g)].map((m) => Number(m[1]));
}

/**
 * Complete all queue tasks for this stream and verify segment by segment: frame range received by
 * mock `bakeStream`, every frame in segment written to disk, sample count in manifest, are all
 * "15 frames per segment from `origin`, last segment ending at `last`". Returns manifest.
 */
async function produceAndCheck(pipeline, executor, ctx, spec, { origin, last }) {
  const planTask = planTaskOf({ projectId: PID, projectRev: REV });
  const tasks = splitPlan({ ...ctx, planTask, envFingerprint: OWN, codeVersion: 'cv' }).filter((x) => x.kind === 'stream' && x.resultKey === spec.streamKey);
  const lastSegment = Math.floor((last - origin) / 15);
  assert.deepEqual([spec.originFrame, spec.firstFrame, spec.lastFrame, spec.firstSegment, spec.lastSegment], [origin, origin, last, 0, lastSegment], `${spec.kind}: plan for ${spec.topClipId}`);
  assert.equal(tasks[0].range.from, 0, 'Task segment numbers start at 0');
  assert.equal(tasks.at(-1).range.to, lastSegment);
  assert.equal(tasks.reduce((n, x) => n + x.weight.frames, 0), last - origin + 1, 'The tasks\' frame counts add up exactly to the stream\'s frame count');
  const mark = bakes.length;
  for (const task of tasks) await executor.render(view(task), { signal: signalNone(), progress: () => {} });
  const mine = bakes.slice(mark).filter((b) => b.streamSignature === spec.streamKey);
  const expectRuns = Array.from({ length: lastSegment + 1 }, (_, n) => [origin + n * 15, Math.min(origin + n * 15 + 14, last)]);
  // Below-dependent stream that needs replay: cannot resume lease on first pass, renders one frame
  // every tick from replay start point (mount frame); frames before first frame are discarded after
  // rendering (not included in segment, verified frame by frame below)
  const firstRun = spec.kind === 'below' && spec.replay !== false ? [Math.min(origin, spec.mountFrame), expectRuns[0][1]] : expectRuns[0];
  assert.deepEqual(mine.map((b) => [b.fromFrame, b.toFrame]), [firstRun, ...expectRuns.slice(1)], `${spec.topClipId}: frame range produced by each run`);
  assert.ok(mine.every((b) => b.stride === 1));
  const manifest = await manifestOf(pipeline, spec.streamKey);
  assert.equal(manifest.originFrame, origin, 'The manifest records the first frame of this stream');
  assert.deepEqual(Object.keys(manifest.segments).map(Number).sort((x, y) => x - y), Array.from({ length: lastSegment + 1 }, (_, n) => n));
  let covered = 0;
  for (let n = 0; n <= lastSegment; n++) {
    const [from, to] = expectRuns[n];
    assert.equal(manifest.segments[n].samples, to - from + 1, `Sample count of segment ${n}`);
    assert.deepEqual(await framesInSegment(pipeline, spec.streamKey, manifest.segments[n].file), Array.from({ length: to - from + 1 }, (_, i) => from + i),
      `Segment ${n} holds project frames ${from}-${to}: no extra frames, no missing frames, order intact`);
    // Same conversion: every frame in this segment maps back to segment n
    for (let f = from; f <= to; f++) assert.equal(streamSegmentOf(f, manifest.originFrame), n);
    assert.equal(streamSegmentFirstFrame(n, manifest.originFrame), from);
    assert.equal(streamSegmentLastFrame(n, manifest.originFrame, last), to);
    covered += to - from + 1;
  }
  assert.equal(covered, last - origin + 1);
  assert.equal(publicManifest(manifest).originFrame, origin, 'The manifest the page reads carries it too');
  return manifest;
}

test('SO-01 single-card stream: the clip starts at frame 100 and is 50 frames long, so the segments are 100-114, 115-129, 130-144, 145-149; the one that starts at frame 40 is split from its own first frame', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(false, async () => {
    const A = await streamPipeline();
    const executor = executorFor(A);
    const ctx = await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    assert.deepEqual(ctx.streams.map((s) => `${s.kind}:${s.topClipId}`).sort(), ['card:clip-a', 'card:clip-b', 'card:clip-top']);
    const specs = await A.queueStreamSpecs([...A.entries.values()][0]);
    const of = (id) => specs.find((s) => s.topClipId === id);
    const a = await produceAndCheck(A, executor, ctx, of('clip-a'), { origin: 100, last: 149 });
    assert.equal(a.segments[3].samples, 5, 'The last segment has fewer than 15 frames');
    await produceAndCheck(A, executor, ctx, of('clip-b'), { origin: 40, last: 129 });
    await produceAndCheck(A, executor, ctx, of('clip-top'), { origin: 0, last: 239 });
    // Layers handed to page by producer (claim table) and diagnostic endpoint both carry the first
    // frame
    const producer = A.streamProducer();
    assert.deepEqual(producer.claimLayers().map((l) => [l.clipId, l.originFrame]).sort(), [['clip-a', 100], ['clip-b', 40], ['clip-top', 0]]);
    assert.deepEqual(producer.status().streams.map((s) => [s.clipIds[0], s.originFrame, s.firstSegment, s.lastSegment]).sort(),
      [['clip-a', 100, 0, 3], ['clip-b', 40, 0, 5], ['clip-top', 0, 0, 15]]);
    // That row in layer table: carries first frame, does not write firstSegment
    const entry = [...A.entries.values()][0];
    const rows = layerStreamsOf(entry, A.layerMapStreamOptions(entry));
    assert.deepEqual(rows.map((r) => [r.topClipId, r.originFrame, r.lastSegment, 'firstSegment' in r]).sort(), [['clip-a', 100, 3, false], ['clip-b', 40, 5, false], ['clip-top', 0, 15, false]]);
  });
});

test('SO-02 group stream: with the decoder budget squeezed to 1, clip-b and clip-a merge into one: the first frame is the earliest among the members (frame 40), and the last segment runs to the latest frame (frame 149)', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(false, async () => {
    const A = await streamPipeline({ budget: 1 });
    const executor = executorFor(A);
    const ctx = await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    const specs = await A.queueStreamSpecs([...A.entries.values()][0]);
    const group = specs.find((s) => s.kind === 'group');
    assert.ok(group, `There is a group stream (${specs.map((s) => `${s.kind}:${s.clipIds.join('+')}`).join(' ')})`);
    assert.deepEqual([...group.clipIds].sort(), ['clip-a', 'clip-b']);
    // 40-149: 110 frames, segments 0-7, last segment is frames 145-149
    const manifest = await produceAndCheck(A, executor, ctx, group, { origin: 40, last: 149 });
    assert.equal(manifest.kind, 'group');
    assert.equal(manifest.segments[7].samples, 5);
    // Each member's own first frame in the group does not participate in segmentation:
    // frame 100 (first frame of clip-a) is sample 0 of segment 4 in the group stream
    assert.equal(streamSegmentOf(100, manifest.originFrame), 4);
    assert.equal(streamSegmentFirstFrame(4, manifest.originFrame), 100);
    assert.equal(streamSegmentOf(99, manifest.originFrame), 3);
  });
});

test('SO-03 stream that depends on the layer below (switch on): the first frame is the target card\'s first frame (frame 55), the segments are 55-69, 70-84, 85-99', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(true, async () => {
    const A = await streamPipeline();
    const executor = executorFor(A);
    const ctx = await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    const specs = await A.queueStreamSpecs([...A.entries.values()][0]);
    const below = specs.find((s) => s.kind === 'below');
    assert.ok(below, 'This kind of stream exists once the switch is on');
    assert.equal(below.topClipId, 'clip-g');
    const manifest = await produceAndCheck(A, executor, ctx, below, { origin: 55, last: 99 });
    assert.equal(manifest.kind, 'below');
    // Lower-layer cards each have their own first frame (clip-b starts from frame 40);
    // this stream is calculated based on the target card
    assert.deepEqual(below.belowClipIds.includes('clip-b'), true);
  });
});

test('SO-04 sparse segments: each segment captures only its first frame and repeats it to fill the segment; motion-style streams still push every frame through (the lease continues into the next segment); the position rectangle is recorded in the manifest; the tight rectangle is settled only once all the sparse segments are in, and densifying reuses the position rectangle', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(false, async () => {
    assert.equal(SPARSE_STRIDE, 15, 'Sparse has only one tier: the stride is the number of frames in a segment');
    const A = await streamPipeline();
    const executor = executorFor(A);
    await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    const entry = [...A.entries.values()][0];
    const spec = (await A.queueStreamSpecs(entry)).find((s) => s.topClipId === 'clip-a');
    assert.equal(spec.replay, true, 'clip-a is motion-style');
    const producer = A.streamProducer();
    const state = await producer.queueState(entry, spec);
    const bakery = await A.leaseStreamBakery();
    try {
      // Fake capture is 4×4 with middle 2×2 opaque: position rectangle =
      // top-left of capture rectangle (upper bound) + (1, 1), 2×2
      const bound = state.manifest.bound;
      const expectBox = { x: bound.x + 1, y: bound.y + 1, w: 2, h: 2 };
      const resets0 = producer.stats.resets;
      for (const segment of [0, 1, 2, 3]) {
        const mark = bakes.length;
        const task = { state, segment, stride: SPARSE_STRIDE };
        assert.equal(await producer.runSegment(bakery, task), true);
        await task.job;
        const [run] = bakes.slice(mark);
        const from = 100 + segment * 15, to = Math.min(from + 14, 149);
        assert.deepEqual([run.fromFrame, run.toFrame, run.stride], [from, to, 15], 'motion-style: every frame of this segment is pushed through');
        assert.deepEqual(run.shots, [from], `Segment ${segment} captures only the first frame`);
        assert.equal(run.continues, segment > 0, 'Continues pushing on the previous segment\'s lease, without a reset');
        const seg = state.manifest.segments[segment];
        assert.deepEqual([seg.stride, seg.samples], [15, to - from + 1]);
        assert.deepEqual(await framesInSegment(A, spec.streamKey, seg.file), Array(to - from + 1).fill(from), `Every sample in segment ${segment} is the first frame's picture`);
        assert.deepEqual(seg.box, expectBox, `Position rectangle of segment ${segment} (plane coordinates)`);
        if (segment < 3) assert.equal(state.manifest.tight, null, 'No tightening until the sparse segments are all in');
      }
      assert.equal(producer.stats.resets - resets0, 1, 'Four segments reset the page only once');
      // Sparse is complete: tight rectangle = union of position rectangles of each segment,
      // expanded by 8, clamped to upper bound, rounded to even
      const tight = state.manifest.tight;
      assert.ok(tight && tight.w <= 2 + 16 + 2 && tight.h <= 2 + 16 + 2 && tight.w % 2 === 0 && tight.h % 2 === 0, `Tightened to ${JSON.stringify(tight)}`);
      assert.ok(tight.x <= expectBox.x && tight.x + tight.w >= expectBox.x + expectBox.w);
      assert.deepEqual(publicManifest(state.manifest).segments[2], { init: state.manifest.segments[2].init, file: state.manifest.segments[2].file, stride: 15, samples: 15, box: expectBox }, 'Each segment in the manifest the page reads carries the stride and position rectangle');
      // Fill density: capture by tight rectangle, one image per frame;
      // position rectangle reuses the one measured in the sparse pass
      const mark = bakes.length;
      const dense = { state, segment: 3, stride: 1 };
      assert.equal(await producer.runSegment(bakery, dense), true);
      await dense.job;
      assert.deepEqual(bakes.slice(mark).map((b) => [b.fromFrame, b.toFrame, b.stride, b.shots.length]), [[145, 149, 1, 5]]);
      assert.deepEqual([state.manifest.segments[3].stride, state.manifest.segments[3].samples], [1, 5]);
      assert.deepEqual(state.manifest.segments[3].box, expectBox);
      // (Fake encoder's head file does not change with size, which cannot be seen from rectangle
      // registered in manifest; check capture rectangle: width and height are from tight rectangle,
      // position is it plus offset in isolated project)
      const denseClip = bakes.slice(mark)[0].clip;
      assert.deepEqual(denseClip, { x: tight.x + spec.offset.x, y: tight.y + spec.offset.y, w: tight.w, h: tight.h }, 'Full-density segments are captured with the tight rectangle');
      assert.deepEqual(await framesInSegment(A, spec.streamKey, state.manifest.segments[3].file), [145, 146, 147, 148, 149]);
      // "Lease connects" is judged by this stream's own segment boundaries
      // (clear segments 1 and 2 as if they do not exist yet)
      delete state.manifest.segments[1]; delete state.manifest.segments[2];
      delete state.queueOnly;   // This stream was created as a queue task; remove this flag, and automatic production will pick it
      const leaseAt = (lastFrame) => { bakery.streamLease = { streamSignature: spec.streamKey, lastFrame, dirty: false, page: bakery.page }; return producer.nextTask(bakery); };
      const mine = (task) => (task?.state === state ? [task.segment, task.stride] : null);
      assert.deepEqual(mine(leaseAt(129)), [2, 15], 'Frame 129 is the last frame of segment 1: continue with segment 2; some segments do not even have a sparse version yet, so do the sparse ones first');
      assert.deepEqual(mine(leaseAt(128)), [1, 15], 'Frame 128 is not on a segment boundary: does not count as a continuation');
      assert.deepEqual(mine(leaseAt(134)), [1, 15], 'Frame 134 is a segment boundary counted by project frame number, not this stream\'s');
    } finally { A.returnStreamBakery(bakery); }
  });
});

test('SO-05 sparse segments, remotion-style stream: pushes only up to the segment\'s first frame and stops, the next segment jumps straight over without resetting the page', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(false, async () => {
    const A = await streamPipeline();
    const executor = executorFor(A);
    await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    const entry = [...A.entries.values()][0];
    const spec = (await A.queueStreamSpecs(entry)).find((s) => s.topClipId === 'clip-b');
    assert.equal(spec.replay, false, 'clip-b is remotion-style');
    const producer = A.streamProducer();
    const state = await producer.queueState(entry, spec);
    const bakery = await A.leaseStreamBakery();
    try {
      const resets0 = producer.stats.resets;
      // Out of order is fine too: 0, 1, 5, 2
      for (const segment of [0, 1, 5, 2]) {
        const mark = bakes.length;
        const task = { state, segment, stride: SPARSE_STRIDE };
        assert.equal(await producer.runSegment(bakery, task), true);
        await task.job;
        const [run] = bakes.slice(mark);
        const from = 40 + segment * 15;
        assert.deepEqual([run.fromFrame, run.toFrame, run.shots, run.hasMountFrame, run.warm], [from, from, [from], false, 0], `Segment ${segment}: pushes only to the first frame, does not pass the mount frame`);
        const seg = state.manifest.segments[segment];
        assert.deepEqual([seg.stride, seg.samples], [15, 15]);
        assert.deepEqual(await framesInSegment(A, spec.streamKey, seg.file), Array(15).fill(from));
      }
      assert.equal(producer.stats.resets - resets0, 1, 'The page is reset only once, at the first segment, and after that it jumps within the same page');
      // Another call touched this session (lease is dirty): re-prime as usual
      bakery.streamLease.dirty = true;
      const again = { state, segment: 3, stride: SPARSE_STRIDE };
      assert.equal(await producer.runSegment(bakery, again), true);
      await again.job;
      assert.equal(producer.stats.resets - resets0, 2);
      // Full-density segments do not take the "skip" path:
      // if the lease does not connect, re-prime once as usual (behavior matches before)
      const dense = { state, segment: 0, stride: 1 };
      assert.equal(await producer.runSegment(bakery, dense), true);
      await dense.job;
      assert.equal(producer.stats.resets - resets0, 3);
    } finally { A.returnStreamBakery(bakery); }
  });
});

test('SO-06 tight rectangle: which sides the picture presses against (only sides not yet at the upper bound count); if it presses against a side, that side is grown; no tightening if full-density segments produced at the upper bound already exist, or if some segment never had its position rectangle measured', () => {
  const bound = { x: -32, y: -32, w: 464, h: 304 };
  const rect = { x: 100, y: 50, w: 120, h: 80 };
  assert.equal(tightOverflowSides({ x: 10, y: 10, w: 50, h: 40 }, rect, bound), null, 'The picture is inside the rectangle, with space left on all four sides');
  assert.deepEqual(tightOverflowSides({ x: 0, y: 10, w: 50, h: 40 }, rect, bound), { left: true });
  assert.deepEqual(tightOverflowSides({ x: 70, y: 0, w: 50, h: 80 }, rect, bound), { top: true, right: true, bottom: true });
  // This side already touches upper bound: further out is outside this stream's range, does not count
  assert.equal(tightOverflowSides({ x: 0, y: 0, w: 464, h: 304 }, bound, bound), null);
  assert.equal(tightOverflowSides({ x: 0, y: 5, w: 60, h: 20 }, { x: -32, y: 50, w: 120, h: 80 }, bound), null, 'The left side touches the upper bound');

  const producer = new StreamProducer({ root: os.tmpdir(), ready: { stageByKey() {}, publish() {} } }, { env: {} });
  const state = { spec: { streamKey: 'k'.repeat(64), firstSegment: 0, lastSegment: 2 }, manifest: { bound, tight: { ...rect }, segments: {} } };
  // Capture rectangle used by re-measurement pass:
  // edges that hit boundary are set to upper bound; other edges do not move
  assert.deepEqual(extendSides(rect, { right: true }, bound), { x: 100, y: 50, w: 332, h: 80 });
  assert.deepEqual(extendSides(rect, { left: true, top: true }, bound), { x: -32, y: -32, w: 252, h: 162 });
  assert.deepEqual(extendSides(rect, {}, bound), rect);
  // Re-measured: right edge actually reaches 350
  // (tight rectangle originally reached 220, exceeding by 130)
  // → set to 350 + 8 expansion + 64 extra (cap) = 422; other edges do not move
  const reach = MEASURE_PAD_PX + TIGHT_WIDEN_MARGIN_PX;
  assert.deepEqual(producer.settleTight(state, { x: 120, y: 60, w: 230, h: 40 }, { right: true }), { x: 100, y: 50, w: 250 + reach, h: 80 });
  assert.deepEqual(state.manifest.tight, { x: 100, y: 50, w: 322, h: 80 });
  assert.equal(state.widened, 1);
  // Do not expand pointlessly when exceeding only a little:
  // left edge measured starting from 90 (exceeding by 10) → 90 - 8 - 10 = 72;
  // top edge measured starting from 44 (exceeding by 6) → 44 - 8 - 6 = 30;
  // only expand, do not shrink (right and bottom do not move)
  assert.deepEqual(producer.settleTight(state, { x: 90, y: 44, w: 100, h: 60 }, { left: true, top: true }), { x: 72, y: 30, w: 350, h: 100 });
  // Measured range exceeding upper bound is clamped to upper bound
  // (top edge did not hit boundary, does not move)
  const wide = { x: -32, y: 30, w: 464, h: 242 };
  assert.deepEqual(producer.settleTight(state, { x: -20, y: -20, w: 440, h: 280 }, { left: true, right: true, bottom: true }), wide);
  assert.deepEqual(producer.settleTight(state, { x: 0, y: 40, w: 10, h: 10 }, { left: true }), wide, 'This side is already at the upper bound: no further growth');
  assert.equal(state.widened, 3);
  // If expansion saves less than TIGHTEN_MIN_SAVING: just use the upper bound
  const flat = { spec: state.spec, manifest: { bound, tight: { x: -32, y: -32, w: 464, h: 100 }, segments: {} } };
  assert.deepEqual(producer.settleTight(flat, { x: 0, y: 0, w: 10, h: 160 }, { bottom: true }), bound);
  // Nothing measured (this segment is fully transparent):
  // keep a bit extra toward edge that hit boundary based on original rectangle
  const blank = { spec: state.spec, manifest: { bound, tight: { ...rect }, segments: {} } };
  assert.deepEqual(producer.settleTight(blank, null, { right: true }), { x: 100, y: 50, w: 120 + reach, h: 80 });
  // Measured boundary is flush with original edge (not exceeding): keep up to the cap
  const flush = { spec: state.spec, manifest: { bound, tight: { ...rect }, segments: {} } };
  assert.deepEqual(producer.settleTight(flush, { x: 100, y: 60, w: 50, h: 40 }, { left: true }), { x: 100 - reach, y: 50, w: 120 + reach, h: 80 });

  // maybeTighten: union of position rectangles of each segment
  const seg = (box, extra = {}) => ({ file: 'f', init: 'i', stride: 15, samples: 15, sig: null, adopted: true, ...(box !== undefined ? { box } : {}), ...extra });
  const fresh = (segments) => ({ spec: { streamKey: 'k'.repeat(64), firstSegment: 0, lastSegment: 2 }, manifest: { streamKey: 'k'.repeat(64), bound, tight: null, segments } });
  const ok = fresh({ 0: seg({ x: 100, y: 60, w: 40, h: 30 }), 1: seg(null), 2: seg({ x: 180, y: 70, w: 40, h: 30 }) });
  producer.maybeTighten(ok);
  assert.deepEqual(ok.manifest.tight, { x: 92, y: 52, w: 136, h: 56 }, 'Union 100..220 × 60..100 expanded outward by 8; the fully transparent segment does not take part');
  const missing = fresh({ 0: seg({ x: 100, y: 60, w: 40, h: 30 }), 1: seg(undefined), 2: seg({ x: 180, y: 70, w: 40, h: 30 }) });
  producer.maybeTighten(missing);
  assert.deepEqual(missing.manifest.tight, bound, 'A segment has no measured position rectangle: no tightening');
  const hasDense = fresh({ 0: seg({ x: 100, y: 60, w: 40, h: 30 }, { stride: 1, adopted: false }), 1: seg(null), 2: seg({ x: 180, y: 70, w: 40, h: 30 }) });
  producer.maybeTighten(hasDense);
  assert.deepEqual(hasDense.manifest.tight, bound, 'This machine already has full-density segments produced at the upper bound: no tightening (tightening would mark them stale and regenerate them)');
  const partial = fresh({ 0: seg({ x: 100, y: 60, w: 40, h: 30 }), 2: seg({ x: 180, y: 70, w: 40, h: 30 }) });
  producer.maybeTighten(partial);
  assert.equal(partial.manifest.tight, null, 'Sparse segments not all in yet: not decided for now');
  const allClear = fresh({ 0: seg(null), 1: seg(null), 2: seg(null) });
  producer.maybeTighten(allClear);
  assert.deepEqual(allClear.manifest.tight, bound, 'The whole stream is transparent: no tightening');
});
