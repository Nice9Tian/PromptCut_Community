/**
 * Below-dependent streams (`kind: 'below'`, `docs/plan/prerender-products-contract.md` section 5.1)
 * pass through the queue:
 * Pipeline plan (`planForQueue`) → split → executor matches stream task back to this version's
 * stream (`matchStream` in `prerender-executor.mjs`) → producer outputs segments per isolated project.
 * Test case names start with `BLQ-`. Run: npm test -- server/test/below-stream-queue.test.mjs
 *
 * Toggle (`PROMPTCUT_TEST_BELOW_STREAMS`) is set and restored in each test case: enabled by default
 * in production; set to 0 to simulate "an old node that does not recognize this stream yet", in which
 * case this path outputs nothing.
 * No Chrome, no ffmpeg; mocks follow `stream-queue.test.mjs` (prerender room, `bakeStream`, segment
 * encoder).
 * Validates here "whether it is recognized, matches up, and which kind the isolated project provides";
 * how pixels in the stream are extracted is not in this scope.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { streamInputSig } from '../../src/render/streamInputSig.mjs';

/* ------------------------------------------------------------------ Fake prerender room / screenshots / encoder */

let scene = null;
const streamBakes = [];
/** Records an entry each time an isolated project is loaded into the prerender room */
const resets = [];

function fakeBakery() {
  const bakery = {
    closed: false,
    page: { setViewport: async () => {}, evaluate: async () => structuredClone(scene.browserPlan) },
    client: { send: async () => {} },
    loadProject: async () => {},
    reset: async (project) => { resets.push(structuredClone(project)); bakery.page = { ...bakery.page }; },
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
      streamBakes.push({ streamSignature, fromFrame, toFrame, stride, mountFrame: opts.mountFrame, clip: opts.clip });
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
/** Structurally valid fMP4 segment: `ftyp + moov` and a pair of `moof + mdat`, `trun` sample count is frame count, first frame is a sync frame */
function fakeFmp4(samples, digest, encoder) {
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomavc1', 'latin1'));
  const moov = box('moov', box('udta', Buffer.from(`enc:${encoder}`, 'latin1')));
  const tfhd = Buffer.alloc(8); tfhd.writeUInt32BE(0, 0); tfhd.writeUInt32BE(1, 4);
  const trun = Buffer.alloc(12); trun.writeUInt32BE(0x000004, 0); trun.writeUInt32BE(samples, 4); trun.writeUInt32BE(0x02000000, 8);
  const moof = box('moof', box('traf', Buffer.concat([box('tfhd', tfhd), box('trun', trun)])));
  const mdat = box('mdat', Buffer.from(`${encoder}:${digest}`, 'latin1'));
  return Buffer.concat([ftyp, moov, moof, mdat]);
}
mock.module(new URL('../bakery/ffmpeg.mjs', import.meta.url).href, {
  exports: {
    ...realFfmpeg,
    findFfmpeg: async () => 'ffmpeg-fake',
    pickStreamEncoder: async () => ({ encoder: 'libx264', results: [] }),
    openStreamSegmentEncoder: (ffmpeg, { encoder = 'libx264' }) => {
      const hash = crypto.createHash('sha256');
      let count = 0;
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
const { createPrerenderExecutor } = await import('../prerender-executor.mjs');

/* ------------------------------------------------------------------ Scenario */

const FPS = 30;
const OWN_ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
const OWN = OWN_ENV.fingerprint;
const CV = 'cv-below-q';
const PID = 'below-queue';
const REV = 4;

/**
 * Three tracks from top to bottom (5 seconds, 150 frames):
 *   clip-top  standalone card, 0-5 seconds: above the frosted glass
 *   clip-g    frosted glass (below-dependent), 1-4 seconds: target card; stream is segmented from
 *             its first frame (frame 30), segments 0-5
 *   clip-a    standalone card, 0-5 seconds: lower layer of the frosted glass
 */
const START = { 'clip-top': 0, 'clip-g': 1, 'clip-a': 0 };
const END = { 'clip-top': 5, 'clip-g': 4, 'clip-a': 5 };
const CLIPS = Object.keys(START);
const CARD = { 'clip-top': 'demo-top', 'clip-g': 'glass', 'clip-a': 'demo-a' };
const CAPS = {
  'clip-top': { compositing: 'independent', frameMode: 'stateful' },
  'clip-g': { compositing: 'belowDependent', frameMode: 'stateful' },
  'clip-a': { compositing: 'independent', frameMode: 'stateful' },
};
function projectJson() {
  return {
    id: PID, fps: FPS, width: 320, height: 180, duration: 5, style: {}, media: [],
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
    sourceVersions: { 'demo-top': 'builtin:1', glass: 'builtin:2', 'demo-a': 'builtin:3' },
    environment: { width: 320, height: 180, fps: FPS },
  },
};

const roots = [];
const pipes = [];
async function cleanup() {
  await Promise.allSettled(pipes.splice(0).map((p) => p.close()));
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
}
async function streamPipeline() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-below-q-'));
  roots.push(root);
  const saved = process.env.PROMPTCUT_STREAMS;
  delete process.env.PROMPTCUT_STREAMS;
  let pipeline;
  try {
    pipeline = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive: true });
    pipes.push(pipeline);
    const producer = pipeline.streamProducer();
    producer.encoderName = 'libx264';
    producer.ffmpeg = 'ffmpeg-fake';
    producer.attachRoute();
  } finally {
    if (saved !== undefined) process.env.PROMPTCUT_STREAMS = saved;
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
async function manifestOf(pipeline, key) {
  return JSON.parse(await fs.readFile(path.join(pipeline.root, 'streams', key, 'stream.json'), 'utf8'));
}
/** In this block, set the "below-dependent stream" toggle to `on`, and restore it when exiting */
async function withBelow(on, fn) {
  const saved = process.env.PROMPTCUT_TEST_BELOW_STREAMS;
  process.env.PROMPTCUT_TEST_BELOW_STREAMS = on ? '1' : '0';
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.PROMPTCUT_TEST_BELOW_STREAMS; else process.env.PROMPTCUT_TEST_BELOW_STREAMS = saved;
  }
}

/* ================================================================== Test cases */

test('BLQ-off off (the way an old node behaves): the plan has no such stream, no such task can be split out, and the layer table has no such row', { timeout: 30_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(false, async () => {
    const A = await streamPipeline();
    const ctx = await executorFor(A).plan(planView(), { signal: signalNone() });
    assert.deepEqual(ctx.streams.map((s) => `${s.kind}:${s.topClipId}`).sort(), ['card:clip-a', 'card:clip-top'], 'Only single-card streams of independent cards; frosted glass is not included');
    assert.ok(ctx.streams.every((s) => !('belowClipIds' in s)));
    const tasks = streamTasksOf(ctx);
    assert.ok(tasks.length > 0);
    assert.ok(tasks.every((x) => x.requires.belowDependent === false));
    const entry = [...A.entries.values()][0];
    const options = A.layerMapStreamOptions(entry);
    assert.deepEqual((options.streams ?? []).map((s) => s.kind).sort(), ['card', 'card']);
  });
});

test('BLQ-on once turned on: the plan gains the frosted glass stream; the split-out task carries belowDependent; the executor can match the task back to this version\'s stream, and produces it with the "hide only the layers above" isolated project', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(true, async () => {
    const A = await streamPipeline();
    const executor = executorFor(A);
    const ctx = await executor.plan(planView(), { signal: signalNone() });
    assert.deepEqual(ctx.streams.map((s) => `${s.kind}:${s.topClipId}`).sort(), ['below:clip-g', 'card:clip-a', 'card:clip-top']);
    const q = ctx.streams.find((s) => s.kind === 'below');
    assert.equal(q.plane, 'stage');
    assert.deepEqual(q.clipIds, ['clip-g']);
    assert.deepEqual(q.belowClipIds, ['clip-a'], 'The card below counts into the key; the card above does not');
    assert.equal(q.streamKey, resultKeyOf(q.contentKey, OWN));
    assert.deepEqual([q.originFrame, q.firstSegment, q.lastSegment], [30, 0, 5]);
    const tasks = streamTasksOf(ctx).filter((x) => x.input.contentKey === q.contentKey);
    assert.deepEqual(tasks.map((x) => [x.range.from, x.range.to]), [[0, 5]]);
    const [task] = tasks;
    assert.equal(task.requires.belowDependent, true);
    assert.equal(task.requires.transcode, true);
    assert.equal(task.resultKey, q.streamKey);

    const markBakes = streamBakes.length, markResets = resets.length;
    await executor.render(view(task), { signal: signalNone(), progress: () => {} });
    const bakes = streamBakes.slice(markBakes);
    assert.ok(bakes.length > 0 && bakes.every((b) => b.streamSignature === q.streamKey), 'What was produced is exactly this stream');
    // Every tick pushed by this stream must render a frame (lower-layer animations do not advance
    // without being rendered): the first segment cannot resume a lease, so every frame starting from
    // the playback origin (frame 0) is passed to the frame capture hook; frames before frame 30 are
    // discarded after rendering and do not enter the encoder; subsequent segments continue the lease,
    // starting from their respective first frames
    assert.deepEqual(bakes.map((b) => b.fromFrame), [0, 45, 60, 75, 90, 105], 'Segments 0 to 5 (one segment per 15 frames from frame 30), full density; the first segment is drawn from the start of the replay');
    assert.ok(bakes.every((b) => b.stride === 1));
    assert.deepEqual(bakes[0].clip, { x: 0, y: 0, w: 320, h: 180 }, 'Captured in stage coordinates (the upper bound is the whole frame)');
    assert.equal(bakes[0].mountFrame, 0, 'The lower card is motion-style and is advanced from its mount frame');
    // Isolated project fed into the prerender room: the target card and lower layers are rendered,
    // while layers above are hidden
    const iso = resets.slice(markResets)[0];
    assert.ok(iso, 'The project was reloaded once');
    assert.deepEqual(iso.tracks.filter((tr) => !tr.hidden).map((tr) => tr.clips.map((c) => c.id)), [['clip-g'], ['clip-a']]);
    assert.deepEqual(iso.tracks.filter((tr) => tr.hidden).map((tr) => [tr.clips.map((c) => c.id), tr.sourceOnly]), [[['clip-top'], true]]);
    // The manifest records what kind of stream this is
    const manifest = await manifestOf(A, q.streamKey);
    assert.equal(manifest.kind, 'below');
    assert.equal(manifest.plane, 'stage');
    assert.deepEqual(manifest.clipIds, ['clip-g']);
    assert.equal(manifest.originFrame, 30, 'The manifest records the first frame of this stream');
    assert.deepEqual(Object.keys(manifest.segments).map(Number).sort((x, y) => x - y), [0, 1, 2, 3, 4, 5]);
    for (let n = 0; n <= 5; n++) assert.equal(manifest.segments[n]?.stride, 1, `Segment ${n} was produced`);
    // That row in the layer table
    const entry = [...A.entries.values()][0];
    const rows = (A.layerMapStreamOptions(entry).streams ?? []).filter((s) => s.kind === 'below');
    assert.deepEqual(rows.map((s) => s.contentKey), [q.contentKey]);
    // The layer sent to the page (ready index): includes "this is a below-dependent stream" and the
    // input signature of this project version; single-card stream layers carry nothing extra
    const sig = streamInputSig(entry.project, { clipIds: ['clip-g'], kind: 'below' });
    assert.match(sig, /^s1-/);
    const layers = A.streamProducer().claimLayers(entry.key);
    assert.deepEqual(layers.find((l) => l.clipId === 'clip-g'), { clipId: 'clip-g', kind: 'stream', key: q.streamKey, originFrame: 30, streamKind: 'below', inputSig: sig });
    for (const l of layers.filter((x) => x.clipId !== 'clip-g')) assert.equal('streamKind' in l || 'inputSig' in l, false);
    const sent = [];
    const realPublish = A.ready.publish;
    A.ready.publish = (key, layer) => { sent.push(layer); return realPublish.call(A.ready, key, layer); };
    try { A.streamProducer().republish(); } finally { A.ready.publish = realPublish; }
    const mine = sent.find((l) => l.clipId === 'clip-g');
    assert.equal(mine?.streamKind, 'below');
    assert.equal(mine?.inputSig, sig);
    assert.deepEqual(mine?.ranges, [[0, 5]]);

    // Mismatched cases: segment out of bounds, result key belongs to another fingerprint, or kind
    // does not match what the task specifies
    const mut = (fn) => { const copy = view(task); fn(copy); return copy; };
    const cardTask = streamTasksOf(ctx).find((x) => x.input.clipId === 'clip-a');
    const cases = [
      ['Segment out of range', mut((x) => { x.range = { unit: 'segment', from: 2, to: 9 }; })],
      ['The result key belongs to a different fingerprint', mut((x) => { x.resultKey = resultKeyOf(x.input.contentKey, 'aaaaaaaaaaaaaaaa'); })],
      ['The task does not require the lower layer, but this version\'s stream is below-dependent', mut((x) => { x.requires.belowDependent = false; })],
      ['The task requires the lower layer, but this version\'s stream is a single-card stream', (() => { const copy = view(cardTask); copy.requires.belowDependent = true; return copy; })()],
    ];
    const mark = streamBakes.length;
    for (const [what, bad] of cases) {
      const err = await executor.render(bad, { signal: signalNone(), progress: () => {} }).then(() => null, (e) => e);
      assert.equal(err?.code, 'plan-mismatch', `${what}:${err?.code} ${err?.message}`);
      assert.equal(err?.retryable, false);
    }
    assert.equal(streamBakes.length, mark, 'No screenshots for ones that do not match');
    // Single-card stream tasks can still be produced as usual (this kind of stream did not affect it)
    await executor.render(view(cardTask), { signal: signalNone(), progress: () => {} });
    assert.ok(streamBakes.length > mark);
    return task;
  });
});

test('BLQ-foreign a task of this kind split out by another node (with the feature on) arrives at a node with it off: it does not match this version\'s stream, is not retryable, and takes no screenshots', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  const task = await withBelow(true, async () => {
    const B = await streamPipeline();
    const ctx = await executorFor(B).plan(planView(), { signal: signalNone() });
    return streamTasksOf(ctx).find((x) => x.requires.belowDependent === true);
  });
  assert.ok(task);
  await withBelow(false, async () => {
    const A = await streamPipeline();
    const executor = executorFor(A);
    const mark = streamBakes.length;
    const err = await executor.render(view(task), { signal: signalNone(), progress: () => {} }).then(() => null, (e) => e);
    assert.equal(err?.code, 'plan-mismatch');
    assert.equal(err?.retryable, false);
    assert.match(err.message, /stream that depends on the lower layer/);
    assert.equal(streamBakes.length, mark);
  });
});
