/**
 * M6c X1: track streams route through queue (`docs/plan/m6c-contract.md` X1). Case names start with `X1-`.
 * Run: node --experimental-test-module-mocks --test server/test/stream-queue.test.mjs
 *
 * No Chrome, no ffmpeg:
 *   - `bakery/index.mjs` is replaced entirely with a mock (same as `prerender-executor.test.mjs`):
 *     `openBakery` returns a fake prerender room, `page.evaluate` returns browserPlan for this scenario;
 *   - `bakery/bake.mjs` is replaced with a mock `bakeStream`: yields one "image" frame-by-frame by
 *     stride (bytes determined by stream key and frame number), and records lease as in real
 *     implementation; `dirtyStreamLease` is written like the real one;
 *   - `bakery/ffmpeg.mjs` uses real exports, replacing only `findFfmpeg`, `pickStreamEncoder`,
 *     `openStreamSegmentEncoder`: fake encoder turns received frame counts and bytes into a
 *     structurally valid fMP4 (`ftyp + moov` and a pair of `moof + mdat`, where `trun` sample count is
 *     frame count and first frame is sync frame), bytes determined by input and encoder name: two
 *     machines with different encoders produce different segment bytes, but the same stream key.
 *
 * Pipeline is `FramePipeline` with `interactive: true` (with track stream producer), injects
 * environment fingerprint, does not probe.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------------ Fake prerender room / screenshots / encoder */

let scene = null;
/** Called at start of each bakeStream (used to block mid-production) */
let onBakeStream = null;
const streamBakes = [];

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
    bakeStream: async (bakery, opts) => {
      const { streamSignature, fromFrame, toFrame, signal } = opts;
      const stride = Math.max(1, Math.round(Number(opts.stride) || 1));
      streamBakes.push({ streamSignature, fromFrame, toFrame, stride });
      if (onBakeStream) await onBakeStream({ streamSignature, fromFrame, toFrame, stride });
      const lease = bakery.streamLease;
      const continues = !!lease && !lease.dirty && lease.page === bakery.page && lease.streamSignature === streamSignature && fromFrame === lease.lastFrame + 1;
      let captured = 0;
      for (let frame = fromFrame; frame <= toFrame; frame += stride) {
        if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        await opts.onFrame?.(frame, Buffer.from(`png:${streamSignature}:${frame}`));
        captured++;
      }
      bakery.streamLease = { streamSignature, lastFrame: toFrame, lastShot: toFrame, dirty: false, page: bakery.page };
      return { reset: !continues, replayed: 0, captured, captureMs: captured, stepMs: 0 };
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
 * Structurally valid fMP4 segment: init (ftyp + moov) varies with encoder name, segment
 * (moof + mdat) varies with input bytes and encoder name
 */
function fakeFmp4(samples, digest, encoder) {
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomavc1', 'latin1'));
  const moov = box('moov', box('udta', Buffer.from(`enc:${encoder}`, 'latin1')));
  const tfhd = Buffer.alloc(8); tfhd.writeUInt32BE(0, 0); tfhd.writeUInt32BE(1, 4);
  const trun = Buffer.alloc(12); trun.writeUInt32BE(0x000004, 0); trun.writeUInt32BE(samples, 4); trun.writeUInt32BE(0x02000000, 8);
  const moof = box('moof', box('traf', Buffer.concat([box('tfhd', tfhd), box('trun', trun)])));
  const mdat = box('mdat', Buffer.from(`${encoder}:${digest}`, 'latin1'));
  return Buffer.concat([ftyp, moov, moof, mdat]);
}
const encoderRuns = [];
mock.module(new URL('../bakery/ffmpeg.mjs', import.meta.url).href, {
  exports: {
    ...realFfmpeg,
    findFfmpeg: async () => 'ffmpeg-fake',
    pickStreamEncoder: async () => ({ encoder: 'libx264', results: [] }),
    openStreamSegmentEncoder: (ffmpeg, { encoder = 'libx264', fps }) => {
      const hash = crypto.createHash('sha256');
      let count = 0;
      encoderRuns.push({ encoder, fps });
      return {
        write: async (png) => { count++; hash.update(png); },
        finish: async () => ({ bytes: fakeFmp4(count, hash.digest('hex'), encoder), encodeMs: 1, tailMs: 0 }),
        abort: async () => {},
      };
    },
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { describeEnvironment, resultKeyOf } = await import('../render-node/fingerprint.mjs');
const { splitPlan, planTaskOf } = await import('../render-node/split.mjs');
const { checkClaimable } = await import('../render-node/filter.mjs');
const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
const { createAssetSink, applyResult, mergeStreamResult, wantsDenseStream, writeManifest } = await import('../artifact-transfer.mjs');
const { segmentSignature, SEGMENT_FRAMES, QUEUE_SEGMENT_ATTEMPTS, SPARSE_STRIDE } = await import('../frame-stream.mjs');

/* ------------------------------------------------------------------ Scenario */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const FPS = 30;
const OWN_ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
const OWN = OWN_ENV.fingerprint;
const CV = 'cv-x1';
const PID = 'stream-queue';
const REV = 7;

/**
 * Three clips (5 seconds, 150 frames):
 *   clip-a  standalone card (independent, stateful), 0-5 seconds → enters stream, segments 0-9,
 *           split into two stream tasks (0-7, 8-9)
 *   clip-c  standalone card, canvasHeavy, 1-2 seconds → enters stream
 *   clip-b  frosted glass (belowDependent, local tier), 1-4 seconds → a below-dependent stream
 *           (only one copy for splitter itself, one stream task); how such streams route through
 *           the queue is verified in `below-stream-queue.test.mjs`; here we only verify it is in
 *           the plan and task table
 */
const START = { 'clip-a': 0, 'clip-c': 1, 'clip-b': 1 };
const END = { 'clip-a': 5, 'clip-c': 2, 'clip-b': 4 };
const CLIPS = Object.keys(START);
const CARD = { 'clip-a': 'demo-a', 'clip-c': 'demo-c', 'clip-b': 'glass' };
const CAPS = {
  'clip-a': { compositing: 'independent', frameMode: 'stateful' },
  'clip-c': { compositing: 'independent', frameMode: 'stateful', canvasHeavy: true },
  'clip-b': { compositing: 'belowDependent', frameMode: 'stateful' },
};
function projectJson() {
  return {
    id: PID, fps: FPS, width: 320, height: 180, duration: 5, style: {}, media: [],
    tracks: CLIPS.map((clipId, i) => ({ id: `t${i + 1}`, clips: [{ id: clipId, cardId: CARD[clipId], start: START[clipId], end: END[clipId] }] })),
  };
}
function browserPlanOf() {
  return {
    graph: {
      definitions: [],
      nodes: CLIPS.map((clipId) => ({ id: `n:${clipId}`, adapter: 'chrome', cardId: CARD[clipId], capabilities: { ...CAPS[clipId] }, inputs: {} })),
      outputs: CLIPS.map((clipId) => ({ nodeId: `n:${clipId}`, clipId, start: START[clipId], end: END[clipId], opacity: 1 })),
    },
    sourceVersions: { 'demo-a': 'builtin:1', 'demo-c': 'builtin:2', glass: 'builtin:3' },
    environment: { width: 320, height: 180, fps: FPS },
  };
}
scene = { browserPlan: browserPlanOf() };

const roots = [];
const pipes = [];
async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-x1-stream-'));
  roots.push(root);
  return root;
}
async function cleanup() {
  onBakeStream = null;
  await Promise.allSettled(pipes.splice(0).map((p) => p.close()));
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
}

/** Pipeline with track stream producer; `encoder` is the encoder name probed on this "machine" */
async function streamPipeline({ encoder = 'libx264', env } = {}) {
  const root = await tmpRoot();
  const saved = process.env.PROMPTCUT_STREAMS;
  if (env?.PROMPTCUT_STREAMS !== undefined) process.env.PROMPTCUT_STREAMS = env.PROMPTCUT_STREAMS;
  else delete process.env.PROMPTCUT_STREAMS;
  let pipeline;
  try {
    pipeline = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive: true });
    pipes.push(pipeline);
    const producer = pipeline.streamProducer();
    producer.encoderName = encoder;
    producer.ffmpeg = 'ffmpeg-fake';
    producer.attachRoute();
  } finally {
    if (saved === undefined) delete process.env.PROMPTCUT_STREAMS; else process.env.PROMPTCUT_STREAMS = saved;
  }
  return pipeline;
}

function executorFor(pipeline) {
  const projects = { get: async (projectId, projectRev) => (projectId === PID && projectRev === REV ? projectJson() : null) };
  return createPrerenderExecutor({ pipeline, projects, prepareProject: (json) => structuredClone(json) });
}

const view = (task) => ({ ...structuredClone(task), state: 'claimed', version: 1, attempts: 1 });
const planView = () => view(planTaskOf({ projectId: PID, projectRev: REV }));
const signalNone = () => new AbortController().signal;
const streamTasksOf = (ctx) => splitPlan({ ...ctx, planTask: planTaskOf({ projectId: PID, projectRev: REV }), envFingerprint: OWN, codeVersion: CV })
  .filter((t) => t.kind === 'stream');

/** In-memory asset service client (`put` / `get` / `has`, addressed by sha256) */
function memoryClient() {
  const blobs = new Map();
  const calls = { put: 0, get: 0 };
  return {
    blobs, calls,
    async put(ns, bytes) {
      calls.put++;
      const hash = sha256(bytes);
      const uploaded = !blobs.has(`${ns}/${hash}`);
      blobs.set(`${ns}/${hash}`, Buffer.from(bytes));
      return { hash, size: bytes.length, uploaded };
    },
    async get(ns, hash) { calls.get++; return blobs.get(`${ns}/${hash}`) ?? null; },
    async has(ns, hash) { return blobs.has(`${ns}/${hash}`); },
  };
}
/** In-memory content store (`put` / `get`) */
function memoryContent() {
  const items = new Map();
  return {
    items,
    async put(kind, key, body) { items.set(`${kind}\u0000${key}`, structuredClone(body)); return { hash: 'x' }; },
    async get(kind, key) { const body = items.get(`${kind}\u0000${key}`); return body ? { body: structuredClone(body), hash: 'x' } : null; },
  };
}

const streamDir = (pipeline, key) => path.join(pipeline.root, 'streams', key);
async function manifestOf(pipeline, key) {
  return JSON.parse(await fs.readFile(path.join(streamDir(pipeline, key), 'stream.json'), 'utf8'));
}
/** sha256 on disk for a segment (and its init) in this stream */
async function segmentHashes(pipeline, key, n) {
  const manifest = await manifestOf(pipeline, key);
  const seg = manifest.segments[n];
  if (!seg) return null;
  const segBytes = await fs.readFile(path.join(streamDir(pipeline, key), seg.file));
  const initBytes = await fs.readFile(path.join(streamDir(pipeline, key), `init-${seg.init}.mp4`));
  return { seg: sha256(segBytes), init: sha256(initBytes), stride: seg.stride, samples: seg.samples };
}

/* ================================================================== Filtering and splitting */

test('X1-filter stream tasks require capabilities.streams: nodes that report true accept them, nodes that report false do not (rule 2 streams); older nodes that do not report this item follow transcode; browser-only nodes do not accept them', () => {
  const task = {
    id: 'stream:k:0-7', kind: 'stream', resultKey: 'k', range: { unit: 'segment', from: 0, to: 7 }, source: { projectId: PID, projectRev: REV },
    weight: { class: 'heavy', frames: 120 },
    requires: { envFingerprint: OWN, codeVersion: CV, cardSources: {}, transcode: true, userCards: false, graphCards: false, belowDependent: false, capabilities: { streams: true } },
  };
  const node = (profile, capabilities, extra = {}) => ({ profile, envFingerprint: OWN, codeVersions: [CV], capabilities, ...extra });
  assert.deepEqual(checkClaimable(task, node('pc', { userCards: true, graphCards: false, transcode: true, streams: true })), { ok: true });
  assert.deepEqual(checkClaimable(task, node('host', { userCards: true, graphCards: false, transcode: true, streams: true })), { ok: true });
  assert.deepEqual(checkClaimable(task, node('pc', { userCards: true, graphCards: false, transcode: false, streams: false })), { ok: false, rule: 2, reason: 'streams' });
  assert.deepEqual(checkClaimable(task, node('pc', { userCards: true, transcode: true, streams: false })), { ok: false, rule: 2, reason: 'streams' }, 'Reporting false means not accepting, regardless of transcode');
  assert.deepEqual(checkClaimable(task, node('pc', { userCards: true, transcode: true })), { ok: true }, 'The old shape that does not report streams follows transcode');
  assert.deepEqual(checkClaimable(task, node('pc', { userCards: true })), { ok: false, rule: 2, reason: 'streams' });
  const browser = node('browser', { userCards: false, graphCards: false, transcode: false, streams: false }, { userId: 'u1' });
  assert.equal(checkClaimable({ ...task, source: { ...task.source, userId: 'u1' } }, browser).ok, false, 'Browser-only nodes never accept stream tasks');
  // Snapshot tasks are not affected by this rule
  const snap = { ...task, kind: 'snapshot', requires: { ...task.requires, transcode: false, capabilities: undefined } };
  assert.equal(checkClaimable(snap, node('pc', { userCards: true, streams: false })).ok, true);
});

test('X1-split stream tasks carry requires.capabilities.streams = true; snapshot tasks do not; result key = content key × fingerprint', () => {
  const tasks = splitPlan({
    planTask: planTaskOf({ projectId: PID, projectRev: REV }), entryKey: 'e'.repeat(64), envFingerprint: OWN, codeVersion: CV,
    cardPlan: [{ clipId: 'clip-a', snapshotKey: 's'.repeat(64), contentKey: 'c'.repeat(64), tier: 'shared', capabilities: CAPS['clip-a'], count: 60 }],
    streams: [{ streamKey: resultKeyOf('d'.repeat(64), OWN), contentKey: 'd'.repeat(64), topClipId: 'clip-a', firstSegment: 0, lastSegment: 9 }],
  });
  const streams = tasks.filter((t) => t.kind === 'stream');
  const snaps = tasks.filter((t) => t.kind === 'snapshot');
  assert.deepEqual(streams.map((t) => [t.range.from, t.range.to]), [[0, 9]], 'A motion card under 30s (60 segments) is done as a whole in one go');
  for (const t of streams) {
    assert.deepEqual(t.requires.capabilities, { streams: true });
    assert.equal(t.requires.transcode, true);
    assert.equal(t.resultKey, resultKeyOf('d'.repeat(64), OWN));
  }
  for (const t of snaps) assert.equal(t.requires.capabilities, undefined);

  // Catch-up test: remotion cards are still split into 8 segments
  const remotionTasks = splitPlan({
    planTask: planTaskOf({ projectId: PID, projectRev: REV }), entryKey: 'e'.repeat(64), envFingerprint: OWN, codeVersion: CV,
    cardPlan: [{ clipId: 'clip-r', snapshotKey: 's'.repeat(64), contentKey: 'c'.repeat(64), tier: 'shared', capabilities: { writing: 'remotion', frameMode: 'direct' }, count: 60 }],
    streams: [{ streamKey: resultKeyOf('d'.repeat(64), OWN), contentKey: 'd'.repeat(64), topClipId: 'clip-r', firstSegment: 0, lastSegment: 9 }],
  });
  const remotionStreams = remotionTasks.filter((t) => t.kind === 'stream');
  assert.deepEqual(remotionStreams.map((t) => [t.range.from, t.range.to]), [[0, 7], [8, 9]], 'a remotion card keeps the 8-segment split');
});

/* ================================================================== plan stream output */

test('X1-plan with the switch on and an encoder detected: the plan\'s streams are all the streams of this version (stream key = content key × local fingerprint, same as the producer computes); with PROMPTCUT_STREAMS=0 it is empty and cannot produce streams', { timeout: 30_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const ctx = await executorFor(A).plan(planView(), { signal: signalNone() });
  const clips = ctx.streams.map((s) => s.topClipId).sort();
  assert.deepEqual(clips, ['clip-a', 'clip-b', 'clip-c'], 'Each independent card gets one single-card stream, and the frosted glass gets one stream that depends on the layer below');
  assert.deepEqual(ctx.streams.map((s) => `${s.kind}:${s.topClipId}`).sort(), ['below:clip-b', 'card:clip-a', 'card:clip-c']);
  for (const s of ctx.streams) {
    assert.equal(s.streamKey, resultKeyOf(s.contentKey, OWN), 'Stream key = content key × local fingerprint');
    assert.ok(Number.isInteger(s.firstSegment) && s.lastSegment >= s.firstSegment);
  }
  const a = ctx.streams.find((s) => s.topClipId === 'clip-a');
  assert.deepEqual([a.firstSegment, a.lastSegment], [0, 9]);
  assert.equal(await A.streamCapable(), true);
  assert.deepEqual(streamTasksOf(ctx).map((x) => x.input.clipId).sort(), ['clip-a', 'clip-b', 'clip-c']);
  assert.deepEqual(streamTasksOf(ctx).filter((x) => x.requires.belowDependent === true).map((x) => x.input.clipId), ['clip-b']);

  const off = await streamPipeline({ env: { PROMPTCUT_STREAMS: '0' } });
  assert.equal(off.streamProducer().enabled, false);
  assert.equal(await off.streamCapable(), false, 'PROMPTCUT_STREAMS=0: streams capability is false');
  const offCtx = await executorFor(off).plan(planView(), { signal: signalNone() });
  assert.deepEqual(offCtx.streams, [], 'PROMPTCUT_STREAMS=0: no stream tasks are published (same as M5b)');
  const err = await executorFor(off).render(view(streamTasksOf(ctx)[0]), { signal: signalNone(), progress: () => {} }).then(() => null, (e) => e);
  assert.equal(err?.code, 'no-streams');
  assert.equal(err?.retryable, false);
});

test('X1-encoder-probe no encoder detected: streamCapable is false, the plan yields no streams, and the producer is turned off', { timeout: 30_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const producer = A.streamProducer();
  producer.encoderName = undefined;
  producer.encoder = async () => { throw new Error('No usable H.264 encoder (fake)'); };
  assert.equal(await A.streamCapable(), false);
  assert.equal(producer.enabled, false);
  const ctx = await executorFor(A).plan(planView(), { signal: signalNone() });
  assert.deepEqual(ctx.streams, []);
});

/* ================================================================== Executor produces streams, pushes, consumed by another node */

test('X1-render the executor produces the stream task\'s segments segment by segment (full density) and reports progress; the sink pushes px, writes each segment\'s manifest (<resultKey>:<from>-<to>), and returns StreamResult; another node\'s applyResult lands them via adoptSegments, with sha256 matching segment by segment and nothing marked stale', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline({ encoder: 'h264_nvenc' });
  const B = await streamPipeline({ encoder: 'libx264' });
  const executor = executorFor(A);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  // Below-dependent stream (clip-b) is not produced in this test case: it captures two images per frame;
  // the frame capture hook it uses is verified in `below-capture.test.mjs` and `below-stream-queue.test.mjs`
  const tasks = streamTasksOf(ctx).filter((x) => x.requires.belowDependent !== true);
  assert.equal(tasks.length, 2);
  const client = memoryClient();
  const content = memoryContent();
  const sink = createAssetSink({ pipeline: A, client, content });

  for (const task of tasks) {
    const ref = { resultKey: task.resultKey, kind: 'stream', tier: null, range: task.range, input: task.input, requires: task.requires };
    assert.equal(await sink.has(ref), false, 'Before starting, neither this machine nor the content store has it');
    const progress = [];
    const out = await executor.render(view(task), { signal: signalNone(), progress: (n) => progress.push(n) });
    assert.equal(out, null, 'render returns null: the output is in the stream store');
    const segs = task.range.to - task.range.from + 1;
    assert.equal(progress.length, segs, 'Progress is reported once per segment');
    assert.ok(progress.every((n, i) => i === 0 || n > progress[i - 1]), 'Progress increases monotonically');
    // Full density, correct sample count, signature includes local encoder
    const manifest = await manifestOf(A, task.resultKey);
    for (let n = task.range.from; n <= task.range.to; n++) {
      const seg = manifest.segments[n];
      assert.ok(seg, `Segment ${n} is in the manifest`);
      assert.equal(seg.stride, 1, 'The queue produces full-density segments');
      assert.equal(manifest.inits[seg.init].encoder, 'h264_nvenc');
      assert.equal(seg.sig, segmentSignature({ streamKey: task.resultKey, segment: n, stride: 1, encoder: 'h264_nvenc', rect: manifest.tight ?? manifest.bound }));
    }
    assert.equal(A.streamProducer().segmentState(A.streamProducer().streams.get(task.resultKey), task.range.from), 'dense');
    // sink: push px, write manifest
    const put = await sink.put({ ...ref, artifacts: null, meta: { taskId: task.id, nodeId: 'A', token: 1 } });
    assert.equal(put.complete, true);
    const result = put.result;
    assert.equal(result.v, 1);
    assert.equal(result.kind, 'stream');
    assert.equal(result.resultKey, task.resultKey);
    assert.deepEqual(result.range, { from: task.range.from, to: task.range.to });
    assert.deepEqual(Object.keys(result.segments).map(Number).sort((x, y) => x - y), Array.from({ length: segs }, (_, i) => task.range.from + i));
    for (const seg of Object.values(result.segments)) {
      assert.equal(seg.encoder, 'h264_nvenc', 'The encoder goes only into the manifest');
      assert.ok(client.blobs.has(`px/${seg.hash}`), 'The segment is in the asset service\'s px');
      assert.ok(client.blobs.has(`px/${result.inits[seg.init].hash}`), 'init is in px');
    }
    const key = `${task.resultKey}:${task.range.from}-${task.range.to}`;
    assert.deepEqual(content.items.get(`render-manifest\u0000${key}`), result, 'Each segment\'s manifest is written to the content store, with key <resultKey>:<from>-<to>');

    // Consumed by another node (different encoder)
    const applied = await applyResult(B, client, structuredClone(result));
    assert.equal(applied.written, segs, 'B landed all the segments of this range');
    const bManifest = await manifestOf(B, task.resultKey);
    for (let n = task.range.from; n <= task.range.to; n++) {
      const a = await segmentHashes(A, task.resultKey, n);
      const b = await segmentHashes(B, task.resultKey, n);
      assert.deepEqual(b, a, `Segment ${n}: sha256 matches on both sides (segment and init)`);
      assert.equal(bManifest.segments[n].adopted, true);
      assert.equal(bManifest.segments[n].encoder, 'h264_nvenc', 'B records the other side\'s encoder');
      const state = B.streamProducer().streams.get(task.resultKey);
      assert.equal(B.streamProducer().segmentState(state, n), 'dense', `Segment ${n}: a different encoder is not marked stale either`);
    }
    // B pulls the same copy again: all skipped, no download
    const before = client.calls.get;
    const again = await applyResult(B, client, structuredClone(result));
    assert.equal(again.written, 0);
    assert.equal(client.calls.get, before, 'Existing ones are not downloaded again');
  }
  // Encoder is not in result key: stream key calculated by B with its own encoder (libx264) matches A
  const bCtx = await executorFor(B).plan(planView(), { signal: signalNone() });
  assert.deepEqual(bCtx.streams.map((s) => s.streamKey).sort(), ctx.streams.map((s) => s.streamKey).sort(), 'Different encoders, same stream key');
  // While segment signature includes the encoder
  assert.notEqual(segmentSignature({ streamKey: tasks[0].resultKey, segment: 0, stride: 1, encoder: 'h264_nvenc', rect: { x: 0, y: 0, w: 2, h: 2 } }),
    segmentSignature({ streamKey: tasks[0].resultKey, segment: 0, stride: 1, encoder: 'libx264', rect: { x: 0, y: 0, w: 2, h: 2 } }));
});

test('X1-render-skip segments that are already full-density and not stale are not regenerated; when this machine has only sparse segments, they are topped up to full density', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const [task] = streamTasksOf(ctx).filter((x) => x.input.clipId === 'clip-a');
  await executor.render(view(task), { signal: signalNone(), progress: () => {} });
  const mark = streamBakes.length;
  const first = await segmentHashes(A, task.resultKey, 8);
  await executor.render(view(task), { signal: signalNone(), progress: () => {} });
  assert.equal(streamBakes.length, mark, 'The second time, not a single frame is captured');
  assert.deepEqual(await segmentHashes(A, task.resultKey, 8), first);
  // Change segment 9 to the sparse version: needs to be filled to full density
  const producer = A.streamProducer();
  const state = producer.streams.get(task.resultKey);
  state.manifest.segments[9] = { ...state.manifest.segments[9], stride: SPARSE_STRIDE,
    sig: segmentSignature({ streamKey: task.resultKey, segment: 9, stride: SPARSE_STRIDE, encoder: producer.encoderName, rect: state.manifest.bound }) };
  assert.equal(producer.segmentState(state, 9), 'sparse');
  await executor.render(view(task), { signal: signalNone(), progress: () => {} });
  assert.equal(producer.segmentState(state, 9), 'dense');
  assert.deepEqual(streamBakes.slice(mark).map((b) => [b.fromFrame, b.stride]), [[9 * SEGMENT_FRAMES, 1]], 'Only segment 9 is topped up');
});

test('X1-sparse sparse stream tasks: each segment captures only the first frame, and the manifest shares the same key as full density; the sink accepts it as done but does not take it as the result of a full-density task; the full-density task then tops up to full density under the same key; a late-arriving sparse stream task does not downgrade', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const all = splitPlan({ ...ctx, planTask: planTaskOf({ projectId: PID, projectRev: REV }), envFingerprint: OWN, codeVersion: CV, sparseStreams: true }).filter((x) => x.kind === 'stream');
  const dense = all.find((x) => x.input.clipId === 'clip-a' && !x.input.density);
  const sparse = all.find((x) => x.input.clipId === 'clip-a' && x.input.density === 'sparse');
  assert.ok(dense && sparse);
  assert.equal(sparse.id, `${dense.id}:sparse`);
  assert.equal(sparse.resultKey, dense.resultKey);
  assert.deepEqual(sparse.range, dense.range);
  assert.ok(sparse.priority > dense.priority, 'Sparse stream tasks rank ahead of full-density tasks');
  // Within the same stream, sparse stream tasks are dispatched before full-density tasks
  const order = all.filter((x) => x.resultKey === dense.resultKey).map((x) => x.input.density ?? 'dense');
  assert.deepEqual(order, [...order.filter((d) => d === 'sparse'), ...order.filter((d) => d === 'dense')]);
  assert.equal(wantsDenseStream(dense), true);
  assert.equal(wantsDenseStream(sparse), false);

  const client = memoryClient();
  const content = memoryContent();
  const sink = createAssetSink({ pipeline: A, client, content });
  const refOf = (task) => ({ resultKey: task.resultKey, kind: 'stream', tier: null, range: task.range, input: task.input, requires: task.requires });
  const key = `render-manifest\u0000${dense.resultKey}:${dense.range.from}-${dense.range.to}`;
  const segs = dense.range.to - dense.range.from + 1;
  const producer = A.streamProducer();

  // Sparse stream task: one pass per segment, stride is the frame count of one segment;
  // these segments are marked sparse in the manifest
  let mark = streamBakes.length;
  await executor.render(view(sparse), { signal: signalNone(), progress: () => {} });
  assert.deepEqual(streamBakes.slice(mark).map((b) => b.stride), Array(segs).fill(SPARSE_STRIDE));
  const state = producer.streams.get(dense.resultKey);
  for (let n = dense.range.from; n <= dense.range.to; n++) {
    assert.equal(producer.segmentState(state, n), 'sparse');
    assert.equal(state.manifest.segments[n].stride, SPARSE_STRIDE);
    assert.equal(state.manifest.segments[n].samples, SEGMENT_FRAMES, 'Sample count is the full count: one picture repeated across the whole segment');
  }
  // sink: sparse stream task is considered complete and writes manifest;
  // the same local artifact cannot serve as the result of a full-density task
  assert.equal(await sink.has(refOf(dense)), false, 'Sparse version only: the full-density task skips deduplication');
  const put = await sink.put({ ...refOf(sparse), artifacts: null, meta: { taskId: sparse.id, nodeId: 'A', token: 1 } });
  assert.equal(put.complete, true);
  assert.ok(Object.values(content.items.get(key).segments).every((seg) => seg.stride === SPARSE_STRIDE), 'Under this key the content store holds the sparse version');
  assert.equal(await sink.has(refOf(sparse)), true, 'Sparse stream task: having any version counts as having it');
  assert.equal(await sink.has(refOf(dense)), false, 'The content store has only the sparse version: the full-density task still skips deduplication');
  const densePutEarly = await sink.put({ ...refOf(dense), artifacts: null, meta: { taskId: dense.id, nodeId: 'A', token: 1 } });
  assert.equal(densePutEarly.complete, false, 'A full-density task cannot be satisfied with the sparse version');
  // Run the sparse stream task again: does not capture a single frame
  mark = streamBakes.length;
  await executor.render(view(sparse), { signal: signalNone(), progress: () => {} });
  assert.equal(streamBakes.length, mark);

  // Full-density task: filled to full density on the same key
  await executor.render(view(dense), { signal: signalNone(), progress: () => {} });
  assert.deepEqual(streamBakes.slice(mark).map((b) => b.stride), Array(streamBakes.length - mark).fill(1));
  for (let n = dense.range.from; n <= dense.range.to; n++) assert.equal(producer.segmentState(state, n), 'dense');
  const putDense = await sink.put({ ...refOf(dense), artifacts: null, meta: { taskId: dense.id, nodeId: 'A', token: 1 } });
  assert.equal(putDense.complete, true);
  assert.ok(Object.values(content.items.get(key).segments).every((seg) => seg.stride === 1), 'The same key was switched to full density');
  assert.equal(await sink.has(refOf(dense)), true);
  assert.equal(await sink.has(refOf(sparse)), true);
  // Sparse stream task arrives late (local is already full density): no capture, no downgrade
  mark = streamBakes.length;
  await executor.render(view(sparse), { signal: signalNone(), progress: () => {} });
  assert.equal(streamBakes.length, mark, 'Full density already exists: the sparse stream task captures no frames');

  // No downgrade: when late sparse manifest from another node (same fingerprint) writes same key,
  // existing full-density segments are kept; extra segments from it are merged in
  const denseBody = content.items.get(key);
  const first = dense.range.from;
  const lateSparse = structuredClone(denseBody);
  for (const seg of Object.values(lateSparse.segments)) { seg.stride = SPARSE_STRIDE; seg.hash = 'e'.repeat(64); }
  const merged = mergeStreamResult(denseBody, lateSparse);
  assert.deepEqual(merged.segments, denseBody.segments, 'None of the existing full-density segments was replaced by a sparse one');
  assert.equal(await writeManifest(content, lateSparse), true);
  assert.deepEqual(content.items.get(key).segments, denseBody.segments);
  // New manifest lists only one segment (written while producing): other segments in existing
  // manifest are kept; new full-density segment overwrites existing sparse segment
  const partial = structuredClone(denseBody);
  for (const n of Object.keys(partial.segments)) if (Number(n) !== first) delete partial.segments[n];
  const sparseBody = structuredClone(lateSparse);
  const up = mergeStreamResult(sparseBody, partial);
  assert.equal(up.segments[first].stride, 1);
  assert.equal(Object.keys(up.segments).length, segs);
  assert.ok(Object.entries(up.segments).every(([n, seg]) => (Number(n) === first ? seg.stride === 1 : seg.stride === SPARSE_STRIDE)));
  // Mismatched items (different key, different range, not a stream) use the new one as is
  assert.equal(mergeStreamResult({ ...denseBody, resultKey: 'f'.repeat(64) }, lateSparse), lateSparse);
  assert.equal(mergeStreamResult({ ...denseBody, range: { from: 0, to: 7 } }, lateSparse), lateSparse);
  assert.equal(mergeStreamResult(null, lateSparse), lateSparse);

  // Another node with same fingerprint locally only has sparse version: pulling sparse manifest
  // makes no change (both sides sparse), pulling full-density manifest upgrades to full density
  const B = await streamPipeline();
  const executorB = executorFor(B);
  await executorB.plan(planView(), { signal: signalNone() });
  await executorB.render(view(sparse), { signal: signalNone(), progress: () => {} });
  const stateB = B.streamProducer().streams.get(dense.resultKey);
  assert.equal(B.streamProducer().segmentState(stateB, first), 'sparse');
  assert.equal((await applyResult(B, client, structuredClone(put.result))).written, 0, 'The other side is also sparse: not accepted');
  assert.equal((await applyResult(B, client, structuredClone(denseBody))).written, segs, 'The other side is full-density: upgrade');
  for (let n = dense.range.from; n <= dense.range.to; n++) {
    assert.equal(B.streamProducer().segmentState(stateB, n), 'dense');
    assert.equal(stateB.manifest.segments[n].adopted, true);
  }
});

test('X1-mismatch a stream task that does not match this version\'s streams: content key, result key (another fingerprint), segment range out of bounds → plan-mismatch (not retryable), no screenshots taken', { timeout: 30_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const [task] = streamTasksOf(ctx);
  const mut = (fn) => { const copy = view(task); fn(copy); return copy; };
  const cases = [
    ['Content keys differ', mut((x) => { x.input.contentKey = 'f'.repeat(64); })],
    ['The result key belongs to a different fingerprint', mut((x) => { x.resultKey = resultKeyOf(x.input.contentKey, 'aaaaaaaaaaaaaaaa'); })],
    ['Segment out of range', mut((x) => { x.range = { unit: 'segment', from: 8, to: 12 }; })],
  ];
  const mark = streamBakes.length;
  for (const [what, bad] of cases) {
    const err = await executor.render(bad, { signal: signalNone(), progress: () => {} }).then(() => null, (e) => e);
    assert.equal(err?.code, 'plan-mismatch', `${what}:${err?.code} ${err?.message}`);
    assert.equal(err?.retryable, false);
  }
  assert.equal(streamBakes.length, mark);
});

test('X1-abort aborting midway: rejects (cancelled) and no longer produces the later segments; redoing with a new signal afterward can fill the gaps', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const [task] = streamTasksOf(ctx).filter((x) => x.input.clipId === 'clip-a' && x.range.from === 0);
  const controller = new AbortController();
  onBakeStream = async ({ fromFrame }) => { if (fromFrame === 2 * SEGMENT_FRAMES) controller.abort(); };
  const err = await executor.render(view(task), { signal: controller.signal, progress: () => {} }).then(() => null, (e) => e);
  assert.ok(err, 'Abort must reject');
  onBakeStream = null;
  const manifest = await manifestOf(A, task.resultKey).catch(() => ({ segments: {} }));
  assert.ok(!manifest.segments[3], 'Segments after the abort were not produced');
  await executor.render(view(task), { signal: signalNone(), progress: () => {} });
  const full = await manifestOf(A, task.resultKey);
  for (let n = 0; n <= 7; n++) assert.equal(full.segments[n]?.stride, 1, `Segment ${n} filled in`);
});

/* ================================================================== Queue mode and automatic production */

test('X1-owned streams of an entry in queue mode (queueSnapshots) are not produced automatically; after falling back to this machine (queueSnapshots=false), automatic production takes over', { timeout: 30_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  await executor.plan(planView(), { signal: signalNone() });
  const entry = await A.entry(projectJson());
  assert.ok(Array.isArray(entry.cardPlan));
  const producer = A.streamProducer();
  entry.queueSnapshots = true;
  const mark = streamBakes.length;
  await producer.update(entry);
  assert.ok(producer.streams.size >= 2, 'The stream\'s state is still created as usual (needed for reading back and sending layers)');
  assert.equal(producer.nextTask(null), null, 'Streams assigned to the queue: automatic production has no work');
  await producer.drain();
  assert.equal(streamBakes.length, mark, 'It captured no frames itself');
  entry.queueSnapshots = false;
  assert.ok(producer.nextTask(null), 'After falling back to this machine, automatic production has work');
});

test('X1-local-fallback the splitter produced no stream tasks: releaseQueueStreams hands this version\'s streams back to this machine\'s automatic production while snapshots stay with the queue; not in queue mode / repeated calls return 0', { timeout: 30_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  await executor.plan(planView(), { signal: signalNone() });
  const entry = await A.entry(projectJson());
  const producer = A.streamProducer();
  assert.equal(A.releaseQueueStreams(entry.key), 0, 'An entry not in queue mode: left untouched');
  entry.queueSnapshots = true;
  await producer.update(entry);
  assert.equal(producer.nextTask(null), null, 'Streams assigned to the queue: automatic production has no work');
  assert.equal(A.releaseQueueStreams('no-such-entry'), 0, 'No such entry: left untouched');
  assert.equal(A.releaseQueueStreams(entry.key), 1, 'One entry handed back');
  assert.equal(entry.queueSnapshots, true, 'Snapshots stay with the queue as before');
  assert.equal(entry.queueStreamsLocal, true);
  assert.ok(producer.nextTask(null), 'After handing back, automatic production has work');
  assert.equal(A.releaseQueueStreams(entry.key), 0, 'Repeated call: left untouched');
});

test('X1-hold a stream the queue is producing: when switching to another version (it is not in the new plan), state is not dropped and the segments in production are still written to disk as usual', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const [task] = streamTasksOf(ctx).filter((x) => x.input.clipId === 'clip-c');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let hit = null;
  const reached = new Promise((resolve) => { hit = resolve; });
  onBakeStream = async () => { hit(); await gate; };
  const running = executor.render(view(task), { signal: signalNone(), progress: () => {} });
  await reached;
  const producer = A.streamProducer();
  // Switch version: only the frosted-glass one remains,
  // and the card plan for this version is empty (outputs zero streams)
  const other = projectJson();
  other.tracks = other.tracks.filter((tr) => tr.clips[0].id === 'clip-b');
  const otherEntry = await A.entry(other);
  otherEntry.cardPlan = [];
  await producer.update(otherEntry);
  assert.ok(producer.streams.has(task.resultKey), 'The stream in production stays in the producer');
  onBakeStream = null;
  release();
  await running;
  const manifest = await manifestOf(A, task.resultKey);
  for (let n = task.range.from; n <= task.range.to; n++) assert.equal(manifest.segments[n]?.stride, 1, `Segment ${n} written to disk`);
});

test('X1-attempts a segment fails QUEUE_SEGMENT_ATTEMPTS times in a row: the task fails with a retryable error', { timeout: 30_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const [task] = streamTasksOf(ctx).filter((x) => x.input.clipId === 'clip-c');
  let calls = 0;
  onBakeStream = async () => { calls++; throw new Error('Screenshot failed (fake)'); };
  const err = await executor.render(view(task), { signal: signalNone(), progress: () => {} }).then(() => null, (e) => e);
  assert.equal(err?.code, 'stream-segment-failed');
  assert.notEqual(err?.retryable, false);
  assert.equal(calls, QUEUE_SEGMENT_ATTEMPTS);
});
