/**
 * 产流时 remotion 式的卡不从挂载帧回放(`docs/plan/prerender-products-contract.md` 第 4.2 节)的服务端一半:
 * `planStreams` 带「要不要回放」,`StreamProducer.runSegment` 对不要回放的流不传 `mountFrame`、预热帧数传 0。
 * 跑:node --experimental-test-module-mocks --test server/test/stream-noreplay.test.mjs
 *
 * 不用 Chrome、不用 ffmpeg,假的预渲染间 / `bakeStream` / 编码器同 `stream-queue.test.mjs`;
 * 这里的假 `bakeStream` 把收到的选项原样记下,并照真的那样算 `replayed`:接不上租约时从
 * `min(fromFrame, mountFrame)` 起挂载(没给 `mountFrame` 就是 `fromFrame`),`replayed = fromFrame - 起点`。
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
    streamPngVideo: () => { throw new Error('单测不编码 MOV'); },
    bakeFrames: async () => { throw new Error('这个测试不渲快照'); },
  },
});

mock.module(new URL('../bakery/bake.mjs', import.meta.url).href, {
  exports: {
    bakeFrames: async () => { throw new Error('这个测试不渲快照'); },
    dirtyStreamLease: (bakery) => { if (bakery?.streamLease) bakery.streamLease.dirty = true; },
    bakeStream: async (bakery, opts) => {
      const { streamSignature, fromFrame, toFrame, signal } = opts;
      const stride = Math.max(1, Math.round(Number(opts.stride) || 1));
      const lease = bakery.streamLease;
      const continues = !!lease && !lease.dirty && lease.page === bakery.page && lease.streamSignature === streamSignature && fromFrame === lease.lastFrame + 1;
      // 真的 `bakeStream` 接不上租约时的挂载起点
      const startFrame = continues ? lease.lastFrame + 1 : Math.max(0, Math.min(fromFrame, Number.isInteger(opts.mountFrame) ? opts.mountFrame : fromFrame));
      const replayed = continues ? 0 : fromFrame - startFrame;
      bakes.push({ streamSignature, fromFrame, toFrame, stride, continues, hasMountFrame: Object.hasOwn(opts, 'mountFrame'), mountFrame: opts.mountFrame, warm: opts.warm, replayed });
      let captured = 0;
      for (let frame = fromFrame; frame <= toFrame; frame += stride) {
        if (signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
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
 * 三个片段(0.5 秒入点到 6 秒:第 15～179 帧,165 帧):clip-d 独立卡 remotion 式,clip-s 独立卡 motion 式,clip-x 独立卡但写法没带。
 * 分段从每条流自己的第一帧(第 15 帧)起数:第 n 段是第 `15 + n × 15` 帧起的 15 帧,分段 0～10。
 */
const ORIGIN = 15;
/** 第 n 段的第一帧(项目帧号) */
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
  // remotion 式的卡声明上是轻卡、不进预渲染集合;这里把它钉成重卡,让它有流可产
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

test('noreplay:按段产流时,remotion 式的流不传 mountFrame、预热传 0,replayed 恒为 0;motion 式和写法没带的流照旧传挂载帧', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  const planTask = planTaskOf({ projectId: PID, projectRev: REV });
  const ctx = await executor.plan(view(planTask), { signal: signalNone() });
  assert.deepEqual(ctx.streams.map((s) => s.topClipId).sort(), [...CLIPS].sort(), '三张独立卡各一条流');
  const keyOf = Object.fromEntries(ctx.streams.map((s) => [s.topClipId, s.streamKey]));
  const streamTasks = splitPlan({ ...ctx, planTask, envFingerprint: OWN, codeVersion: 'cv' }).filter((x) => x.kind === 'stream');
  const taskOf = (clipId, n) => {
    const task = streamTasks.find((x) => x.input.clipId === clipId && x.range.from <= n && n <= x.range.to);
    assert.ok(task, `${clipId} 有覆盖分段 ${n} 的流任务`);
    return task;
  };
  // 分段不按顺序产:先 7、再 3、再 9、再 10(接得上 9 的租约),每次只产这一段
  const order = [7, 3, 9, 10];
  const done = Object.fromEntries(CLIPS.map((c) => [c, []]));
  for (const clipId of CLIPS) {
    for (const n of order) {
      const narrowed = { ...taskOf(clipId, n), range: { unit: 'segment', from: n, to: n } };
      const mark = bakes.length;
      await executor.render(view(narrowed), { signal: signalNone(), progress: () => {} });
      const mine = bakes.slice(mark).filter((b) => b.streamSignature === keyOf[clipId]);
      assert.equal(mine.length, 1, `${clipId}#${n}:产了一次`);
      done[clipId].push(mine[0]);
    }
  }
  // remotion 式:从不传 mountFrame、预热传 0,哪怕接不上租约(7、3、9 都是跳段)也不回放
  for (const b of done['clip-d']) {
    assert.equal(b.hasMountFrame, false, `clip-d#${(b.fromFrame - ORIGIN) / SEGMENT_FRAMES}:不传 mountFrame`);
    assert.equal(b.warm, 0, 'clip-d:预热 0');
    assert.equal(b.replayed, 0, 'clip-d:replayed 为 0');
  }
  assert.deepEqual(done['clip-d'].map((b) => b.continues), [false, false, false, true], '7、3、9 是跳段(重灌一次页面),10 接着 9 的租约');
  // 每一段从这条流自己的第一帧起数:第 7 段是第 120～134 帧(不是按项目帧号的 105～119)
  assert.deepEqual(done['clip-d'].map((b) => [b.fromFrame, b.toFrame]), order.map((n) => [segStart(n), segStart(n) + 14]), '分段盖住的帧从流的第一帧起数');
  // motion 式 / 写法没带:照旧传挂载帧,预热用缺省(不传),跳段时回放
  for (const clipId of ['clip-s', 'clip-x']) {
    for (const b of done[clipId]) {
      assert.equal(b.hasMountFrame, true, `${clipId}:传 mountFrame`);
      assert.equal(b.mountFrame, 14, '挂载帧含 LEAD:0.5 秒入点 → 第 14 帧');
      assert.equal(b.warm, undefined, `${clipId}:预热帧数不传(用缺省)`);
    }
    assert.deepEqual(done[clipId].map((b) => b.replayed), [segStart(7) - 14, segStart(3) - 14, segStart(9) - 14, 0], `${clipId}:跳段从挂载帧回放,接得上租约的不回放`);
  }
  // 诊断:每条流的 replay 与累计回放帧数
  const status = A.streamProducer().status();
  const row = (clipId) => status.streams.find((s) => s.clipIds[0] === clipId);
  assert.equal(row('clip-d').replay, false);
  assert.equal(row('clip-d').replayedFrames, 0);
  assert.equal(row('clip-s').replay, true);
  assert.equal(row('clip-s').replayedFrames, (segStart(7) - 14) + (segStart(3) - 14) + (segStart(9) - 14));
  assert.equal(row('clip-x').replay, true);
  assert.equal(status.stats.replayedFrames, row('clip-s').replayedFrames + row('clip-x').replayedFrames);
});
