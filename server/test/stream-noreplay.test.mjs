/**
 * Server-side half of remotion-style cards not replaying from mount frame during stream generation
 * (`docs/plan/prerender-products-contract.md` section 4.2): `planStreams` carries "whether to replay",
 * `StreamProducer.runSegment` passes no `mountFrame` and 0 warmup frames for streams that do not replay.
 * Run: node --experimental-test-module-mocks --test server/test/stream-noreplay.test.mjs
 *
 * No Chrome, no ffmpeg; mock prerender room / `bakeStream` / encoder same as `stream-queue.test.mjs`;
 * mock `bakeStream` here records options as received, and calculates `replayed` like the real one:
 * when lease cannot be resumed, mounts from `min(fromFrame, mountFrame)` (defaults to `fromFrame`
 * if `mountFrame` omitted), `replayed = fromFrame - startPoint`.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
    bakeStream: async (bakery, opts) => {
      const { streamSignature, fromFrame, toFrame, signal } = opts;
      const stride = Math.max(1, Math.round(Number(opts.stride) || 1));
      const lease = bakery.streamLease;
      const continues = !!lease && !lease.dirty && lease.page === bakery.page && lease.streamSignature === streamSignature && fromFrame === lease.lastFrame + 1;
      // Mount start point when real `bakeStream` cannot resume lease
      const startFrame = continues ? lease.lastFrame + 1 : Math.max(0, Math.min(fromFrame, Number.isInteger(opts.mountFrame) ? opts.mountFrame : fromFrame));
      const replayed = continues ? 0 : fromFrame - startFrame;
      bakes.push({ streamSignature, fromFrame, toFrame, stride, continues, hasMountFrame: Object.hasOwn(opts, 'mountFrame'), mountFrame: opts.mountFrame, warm: opts.warm, replayed });
      let captured = 0;
      for (let frame = fromFrame; frame <= toFrame; frame += stride) {
        if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        await opts.onFrame?.(frame, Buffer.from(`png:${streamSignature}:${frame}`));
        captured++;
      }
      bakery.streamLease = { streamSignature, lastFrame: toFrame, lastShot: toFrame, dirty: false, page: bakery.page };
      return { reset: !continues, replayed, captured, captureMs: captured, stepMs: 0 };
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
const { describeEnvironment } = await import('../render-node/fingerprint.mjs');
const { planTaskOf, splitPlan } = await import('../render-node/split.mjs');
const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
const { SEGMENT_FRAMES } = await import('../frame-stream.mjs');

const FPS = 30;
const OWN_ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
const OWN = OWN_ENV.fingerprint;
const PID = 'stream-noreplay';
const REV = 3;

/**
 * Three clips (0.5 s in point to 6 s: frames 15-179, 165 frames): clip-d standalone card
 * remotion-style, clip-s standalone card motion-style, clip-x standalone card without specified style.
 * Segments count from each stream's own first frame (frame 15): segment n is 15 frames starting from
 * frame `15 + n × 15`, segments 0-10.
 */
const ORIGIN = 15;
/** First frame of segment n (project frame number) */
const segStart = (n) => ORIGIN + n * 15;
const CLIPS = ['clip-d', 'clip-s', 'clip-x'];
const START = { 'clip-d': 0.5, 'clip-s': 0.5, 'clip-x': 0.5 };
const END = { 'clip-d': 6, 'clip-s': 6, 'clip-x': 6 };
const CAPS = {
  'clip-d': { compositing: 'independent', frameMode: 'direct', need_prerendering: false },
  'clip-s': { compositing: 'independent', frameMode: 'stateful', need_prerendering: true },
  'clip-x': { compositing: 'independent' },
};
const CARD = { 'clip-d': 'demo-d', 'clip-s': 'demo-s', 'clip-x': 'demo-x' };
function projectJson() {
  return {
    id: PID, fps: FPS, width: 320, height: 180, duration: 6, style: {}, media: [],
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
    sourceVersions: { 'demo-d': 'builtin:1', 'demo-s': 'builtin:2', 'demo-x': 'builtin:3' },
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-noreplay-'));
  roots.push(root);
  const pipeline = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive: true });
  pipes.push(pipeline);
  // remotion-style cards are declared as light cards and do not enter the prerender set; here it is
  // pinned as a heavy card so that it has streams to produce
  pipeline.streamPicked = () => true;
  const producer = pipeline.streamProducer();
  producer.encoderName = 'libx264';
  producer.ffmpeg = 'ffmpeg-fake';
  producer.attachRoute();
  return pipeline;
}
const executorFor = (pipeline) => createPrerenderExecutor({
  pipeline, projects: { get: async (projectId, projectRev) => (projectId === PID && projectRev === REV ? projectJson() : null) },
  prepareProject: (json) => structuredClone(json),
});
const view = (task) => ({ ...structuredClone(task), state: 'claimed', version: 1, attempts: 1 });
const signalNone = () => new AbortController().signal;

test('noreplay: when producing streams segment by segment, remotion-style streams do not pass mountFrame, pass 0 for warm-up, and replayed is always 0; motion-style streams and streams whose style is not declared still pass the mount frame as before', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  const planTask = planTaskOf({ projectId: PID, projectRev: REV });
  const ctx = await executor.plan(view(planTask), { signal: signalNone() });
  assert.deepEqual(ctx.streams.map((s) => s.topClipId).sort(), [...CLIPS].sort(), 'Three independent cards, one stream each');
  const keyOf = Object.fromEntries(ctx.streams.map((s) => [s.topClipId, s.streamKey]));
  const streamTasks = splitPlan({ ...ctx, planTask, envFingerprint: OWN, codeVersion: 'cv' }).filter((x) => x.kind === 'stream');
  const taskOf = (clipId, n) => {
    const task = streamTasks.find((x) => x.input.clipId === clipId && x.range.from <= n && n <= x.range.to);
    assert.ok(task, `${clipId} has a stream task covering segment ${n}`);
    return task;
  };
  // Segments are produced out of order: 7 first, then 3, then 9, then 10 (can resume 9's lease),
  // producing only this segment each time
  const order = [7, 3, 9, 10];
  const done = Object.fromEntries(CLIPS.map((c) => [c, []]));
  for (const clipId of CLIPS) {
    for (const n of order) {
      const narrowed = { ...taskOf(clipId, n), range: { unit: 'segment', from: n, to: n } };
      const mark = bakes.length;
      await executor.render(view(narrowed), { signal: signalNone(), progress: () => {} });
      const mine = bakes.slice(mark).filter((b) => b.streamSignature === keyOf[clipId]);
      assert.equal(mine.length, 1, `${clipId}#${n}: produced once`);
      done[clipId].push(mine[0]);
    }
  }
  // remotion-style: never passes mountFrame and passes 0 warmup; does not replay even when lease
  // cannot be resumed (7, 3, 9 are all segment skips)
  for (const b of done['clip-d']) {
    assert.equal(b.hasMountFrame, false, `clip-d#${(b.fromFrame - ORIGIN) / SEGMENT_FRAMES}: does not pass mountFrame`);
    assert.equal(b.warm, 0, 'clip-d: warm-up 0');
    assert.equal(b.replayed, 0, 'clip-d: replayed is 0');
  }
  assert.deepEqual(done['clip-d'].map((b) => b.continues), [false, false, false, true], '7, 3, 9 are segment jumps (the page is reset once), 10 continues the lease of 9');
  // Each segment counts from this stream's own first frame: segment 7 is frames 120-134 (not 105-119
  // by project frame number)
  assert.deepEqual(done['clip-d'].map((b) => [b.fromFrame, b.toFrame]), order.map((n) => [segStart(n), segStart(n) + 14]), 'The frames a segment covers are counted from the stream\'s first frame');
  // motion-style / style omitted: passes mount frame as usual, default warmup (omitted), replays on
  // segment skip
  for (const clipId of ['clip-s', 'clip-x']) {
    for (const b of done[clipId]) {
      assert.equal(b.hasMountFrame, true, `${clipId}: passes mountFrame`);
      assert.equal(b.mountFrame, 14, 'The mount frame includes LEAD: 0.5 s in-point → frame 14');
      assert.equal(b.warm, undefined, `${clipId}: warm-up frame count not passed (default used)`);
    }
    assert.deepEqual(done[clipId].map((b) => b.replayed), [segStart(7) - 14, segStart(3) - 14, segStart(9) - 14, 0], `${clipId}: a jump replays from the mount frame, one that can continue the lease does not replay`);
  }
  // Diagnostics: replay and cumulative replayed frames for each stream
  const status = A.streamProducer().status();
  const row = (clipId) => status.streams.find((s) => s.clipIds[0] === clipId);
  assert.equal(row('clip-d').replay, false);
  assert.equal(row('clip-d').replayedFrames, 0);
  assert.equal(row('clip-s').replay, true);
  assert.equal(row('clip-s').replayedFrames, (segStart(7) - 14) + (segStart(3) - 14) + (segStart(9) - 14));
  assert.equal(row('clip-x').replay, true);
  assert.equal(status.stats.replayedFrames, row('clip-s').replayedFrames + row('clip-x').replayedFrames);
});
