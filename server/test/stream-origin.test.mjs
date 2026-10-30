/**
 * 轨道流的分段从这条流自己的第一帧起数(`src/render/streamSegments.mjs`;`docs/plan/html-snapshot-removal-dryrun.md` 第 10.5 节)
 * 在产流一侧的单测:计划 → 切分 → 执行器 → `StreamProducer.runSegment` → 清单,一路核对「第 n 段盖住项目的哪几帧」。
 * 跑:npm test -- server/test/stream-origin.test.mjs
 *
 * 片段都**不从 15 的倍数帧开始**,有的时长也不是 15 的倍数。三种流各一条:单卡流、组流(解码器预算压到 1)、
 * 依赖下层的流(产品里缺省开着;前两种的用例把 `PROMPTCUT_TEST_BELOW_STREAMS` 设成 0 关掉它,只看自己那一种)。不用 Chrome、不用 ffmpeg:假的预渲染间 / `bakeStream` / 编码器同
 * `stream-noreplay.test.mjs`,假 `bakeStream` 把每一趟要出的帧区间记下来,编码器把喂进来的每一帧记进分段的字节里。
 * 真的画面(逐帧比像素)由探针 `scripts/probes/stream-origin-probe.mjs` 核对。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

/** 一张真的 PNG(4×4,中间 2×2 不透明):稀疏那一趟要从截图里量实体框,假截图也得读得懂。每一帧在它后面缀上 `<<f帧号>>` */
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
    streamPngVideo: () => { throw new Error('单测不编码 MOV'); },
    bakeFrames: async () => { throw new Error('这个测试不渲快照'); },
  },
});

mock.module(new URL('../bakery/bake.mjs', import.meta.url).href, {
  exports: {
    bakeFrames: async () => { throw new Error('这个测试不渲快照'); },
    dirtyStreamLease: (bakery) => { if (bakery?.streamLease) bakery.streamLease.dirty = true; },
    // 照真的 `bakeStream`:从 `fromFrame` 起每 `stride` 帧截一张(相对 `fromFrame` 数),逐张交给 `onFrame`
    bakeStream: async (bakery, opts) => {
      const { streamSignature, fromFrame, toFrame, signal } = opts;
      const stride = Math.max(1, Math.round(Number(opts.stride) || 1));
      const lease = bakery.streamLease;
      const continues = !!lease && !lease.dirty && lease.page === bakery.page && lease.streamSignature === streamSignature && fromFrame === lease.lastFrame + 1;
      const shots = [];
      for (let frame = fromFrame; frame <= toFrame; frame += stride) {
        if (signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
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
/** 结构合法的一段 fMP4;`mdat` 里是喂进编码器的每一帧(假截图,末尾缀着 `<<f帧号>>`;稀疏的分段里同一帧连着写几遍) */
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
 * 从上到下四条序列(8 秒,240 帧)。入点都按帧给,没有一个是 15 的倍数:
 *   clip-top  独立卡,第 0～239 帧            —— 盖在最上面,整段都在
 *   clip-g    毛玻璃(依赖下层),第 55～99 帧   —— 45 帧
 *   clip-a    独立卡,第 100～149 帧          —— 50 帧,时长不是 15 的倍数(末段 5 帧)
 *   clip-b    独立卡,第 40～129 帧           —— 90 帧
 */
const FRAMES = { 'clip-top': [0, 239], 'clip-g': [55, 99], 'clip-a': [100, 149], 'clip-b': [40, 129] };
const CLIPS = Object.keys(FRAMES);
/**
 * 入点、出点按秒写,落在两帧之间(第一帧是入点之后的第一个整帧,采样相位不为 0):帧号除以 30 多数不是有限小数,
 * 直接拿 `帧号 / 30` 当秒数,第一帧会因为浮点误差多出一帧。下面每一对换成帧就是上面 `FRAMES` 那一行。
 */
const START = { 'clip-top': 0, 'clip-g': 1.82, 'clip-a': 3.32, 'clip-b': 1.32 };
const END = { 'clip-top': 8, 'clip-g': 3.32, 'clip-a': 4.99, 'clip-b': 4.32 };
const CARD = { 'clip-top': 'demo-top', 'clip-g': 'glass', 'clip-a': 'demo-a', 'clip-b': 'demo-b' };
const CAPS = {
  'clip-top': { compositing: 'independent', frameMode: 'stateful' },
  'clip-g': { compositing: 'belowDependent', frameMode: 'stateful' },
  'clip-a': { compositing: 'independent', frameMode: 'stateful' },
  // clip-b 是 remotion 式(画面只由时间和参数决定):产流时不从挂载帧回放
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
    // 这几张卡声明上不一定判重;这里都钉成要产流的
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
/** 分段文件的 `mdat` 里记着喂进编码器的每一帧 → 帧号数组 */
async function framesInSegment(pipeline, key, file) {
  const bytes = await fs.readFile(path.join(pipeline.root, 'streams', key, file));
  return [...bytes.toString('latin1').matchAll(/<<f(\d+)>>/g)].map((m) => Number(m[1]));
}

/**
 * 把这条流的全部队列任务做完,逐段核对:假 `bakeStream` 收到的帧区间、落盘分段里的每一帧、清单里的样本数,
 * 都是「从 `origin` 起每 15 帧一段,末段到 `last` 为止」。回清单。
 */
async function produceAndCheck(pipeline, executor, ctx, spec, { origin, last }) {
  const planTask = planTaskOf({ projectId: PID, projectRev: REV });
  const tasks = splitPlan({ ...ctx, planTask, envFingerprint: OWN, codeVersion: 'cv' }).filter((x) => x.kind === 'stream' && x.resultKey === spec.streamKey);
  const lastSegment = Math.floor((last - origin) / 15);
  assert.deepEqual([spec.originFrame, spec.firstFrame, spec.lastFrame, spec.firstSegment, spec.lastSegment], [origin, origin, last, 0, lastSegment], `${spec.kind}:${spec.topClipId} 的计划`);
  assert.equal(tasks[0].range.from, 0, '任务的分段号从 0 起');
  assert.equal(tasks.at(-1).range.to, lastSegment);
  assert.equal(tasks.reduce((n, x) => n + x.weight.frames, 0), last - origin + 1, '任务的帧数加起来正好是这条流的帧数');
  const mark = bakes.length;
  for (const task of tasks) await executor.render(view(task), { signal: signalNone(), progress: () => {} });
  const mine = bakes.slice(mark).filter((b) => b.streamSignature === spec.streamKey);
  const expectRuns = Array.from({ length: lastSegment + 1 }, (_, n) => [origin + n * 15, Math.min(origin + n * 15 + 14, last)]);
  // 依赖下层、要回放的流:头一趟接不上租约,从回放的起点(挂载帧)起每一拍都画一张,第一帧之前的画完就丢(不进分段,下面逐帧核)
  const firstRun = spec.kind === 'below' && spec.replay !== false ? [Math.min(origin, spec.mountFrame), expectRuns[0][1]] : expectRuns[0];
  assert.deepEqual(mine.map((b) => [b.fromFrame, b.toFrame]), [firstRun, ...expectRuns.slice(1)], `${spec.topClipId}:每一趟出的帧区间`);
  assert.ok(mine.every((b) => b.stride === 1));
  const manifest = await manifestOf(pipeline, spec.streamKey);
  assert.equal(manifest.originFrame, origin, '清单记着这条流的第一帧');
  assert.deepEqual(Object.keys(manifest.segments).map(Number).sort((x, y) => x - y), Array.from({ length: lastSegment + 1 }, (_, n) => n));
  let covered = 0;
  for (let n = 0; n <= lastSegment; n++) {
    const [from, to] = expectRuns[n];
    assert.equal(manifest.segments[n].samples, to - from + 1, `分段 ${n} 的样本数`);
    assert.deepEqual(await framesInSegment(pipeline, spec.streamKey, manifest.segments[n].file), Array.from({ length: to - from + 1 }, (_, i) => from + i),
      `分段 ${n} 里是项目的第 ${from}～${to} 帧,一帧不多、一帧不少、顺序不乱`);
    // 同一处换算:这一段的每一帧换回去都是第 n 段
    for (let f = from; f <= to; f++) assert.equal(streamSegmentOf(f, manifest.originFrame), n);
    assert.equal(streamSegmentFirstFrame(n, manifest.originFrame), from);
    assert.equal(streamSegmentLastFrame(n, manifest.originFrame, last), to);
    covered += to - from + 1;
  }
  assert.equal(covered, last - origin + 1);
  assert.equal(publicManifest(manifest).originFrame, origin, '页面读到的清单也带着');
  return manifest;
}

test('SO-01 单卡流:片段从第 100 帧开始、共 50 帧 —— 分段是 100～114、115～129、130～144、145～149;从第 40 帧开始的那条照它自己的第一帧分', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(false, async () => {
    const A = await streamPipeline();
    const executor = executorFor(A);
    const ctx = await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    assert.deepEqual(ctx.streams.map((s) => `${s.kind}:${s.topClipId}`).sort(), ['card:clip-a', 'card:clip-b', 'card:clip-top']);
    const specs = await A.queueStreamSpecs([...A.entries.values()][0]);
    const of = (id) => specs.find((s) => s.topClipId === id);
    const a = await produceAndCheck(A, executor, ctx, of('clip-a'), { origin: 100, last: 149 });
    assert.equal(a.segments[3].samples, 5, '末段不满 15 帧');
    await produceAndCheck(A, executor, ctx, of('clip-b'), { origin: 40, last: 129 });
    await produceAndCheck(A, executor, ctx, of('clip-top'), { origin: 0, last: 239 });
    // 生产者交给页面的层(认领表)和诊断口都带着第一帧
    const producer = A.streamProducer();
    assert.deepEqual(producer.claimLayers().map((l) => [l.clipId, l.originFrame]).sort(), [['clip-a', 100], ['clip-b', 40], ['clip-top', 0]]);
    assert.deepEqual(producer.status().streams.map((s) => [s.clipIds[0], s.originFrame, s.firstSegment, s.lastSegment]).sort(),
      [['clip-a', 100, 0, 3], ['clip-b', 40, 0, 5], ['clip-top', 0, 0, 15]]);
    // 层表的那一行:带第一帧,不写 firstSegment
    const entry = [...A.entries.values()][0];
    const rows = layerStreamsOf(entry, A.layerMapStreamOptions(entry));
    assert.deepEqual(rows.map((r) => [r.topClipId, r.originFrame, r.lastSegment, 'firstSegment' in r]).sort(), [['clip-a', 100, 3, false], ['clip-b', 40, 5, false], ['clip-top', 0, 15, false]]);
  });
});

test('SO-02 组流:解码器预算压到 1,clip-b 和 clip-a 并成一条 —— 第一帧是成员里最早的(第 40 帧),末段到最晚的那一帧(第 149 帧)', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(false, async () => {
    const A = await streamPipeline({ budget: 1 });
    const executor = executorFor(A);
    const ctx = await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    const specs = await A.queueStreamSpecs([...A.entries.values()][0]);
    const group = specs.find((s) => s.kind === 'group');
    assert.ok(group, `有一条组流(${specs.map((s) => `${s.kind}:${s.clipIds.join('+')}`).join(' ')})`);
    assert.deepEqual([...group.clipIds].sort(), ['clip-a', 'clip-b']);
    // 40～149:110 帧,分段 0～7,末段是第 145～149 帧
    const manifest = await produceAndCheck(A, executor, ctx, group, { origin: 40, last: 149 });
    assert.equal(manifest.kind, 'group');
    assert.equal(manifest.segments[7].samples, 5);
    // 组里各成员自己的第一帧不参与分段:第 100 帧(clip-a 的第一帧)在组流的第 4 段的第 0 个样本
    assert.equal(streamSegmentOf(100, manifest.originFrame), 4);
    assert.equal(streamSegmentFirstFrame(4, manifest.originFrame), 100);
    assert.equal(streamSegmentOf(99, manifest.originFrame), 3);
  });
});

test('SO-03 依赖下层的流(开关打开):第一帧是目标卡的第一帧(第 55 帧),分段是 55～69、70～84、85～99', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(true, async () => {
    const A = await streamPipeline();
    const executor = executorFor(A);
    const ctx = await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    const specs = await A.queueStreamSpecs([...A.entries.values()][0]);
    const below = specs.find((s) => s.kind === 'below');
    assert.ok(below, '开关打开以后有这种流');
    assert.equal(below.topClipId, 'clip-g');
    const manifest = await produceAndCheck(A, executor, ctx, below, { origin: 55, last: 99 });
    assert.equal(manifest.kind, 'below');
    // 下层的卡各有各的第一帧(clip-b 从第 40 帧起),这条流照目标卡的算
    assert.deepEqual(below.belowClipIds.includes('clip-b'), true);
  });
});

test('SO-04 稀疏的分段:每个分段只截分段的第一帧、重复写满这一段;motion 式的流照旧把每一帧都推过去(租约接得上下一段);位置矩形记进清单;稀疏的齐了才定收紧矩形,补密沿用位置矩形', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(false, async () => {
    assert.equal(SPARSE_STRIDE, 15, '稀疏只有一档:间隔就是分段的帧数');
    const A = await streamPipeline();
    const executor = executorFor(A);
    await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    const entry = [...A.entries.values()][0];
    const spec = (await A.queueStreamSpecs(entry)).find((s) => s.topClipId === 'clip-a');
    assert.equal(spec.replay, true, 'clip-a 是 motion 式');
    const producer = A.streamProducer();
    const state = await producer.queueState(entry, spec);
    const bakery = await A.leaseStreamBakery();
    try {
      // 假截图是 4×4、中间 2×2 不透明:位置矩形 = 截图矩形(上界)的左上角 + (1, 1),2×2
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
        assert.deepEqual([run.fromFrame, run.toFrame, run.stride], [from, to, 15], 'motion 式:这一段的每一帧都推过去');
        assert.deepEqual(run.shots, [from], `分段 ${segment} 只截第一帧`);
        assert.equal(run.continues, segment > 0, '接着上一段的租约推,不重灌');
        const seg = state.manifest.segments[segment];
        assert.deepEqual([seg.stride, seg.samples], [15, to - from + 1]);
        assert.deepEqual(await framesInSegment(A, spec.streamKey, seg.file), Array(to - from + 1).fill(from), `分段 ${segment} 里每个样本都是第一帧的画面`);
        assert.deepEqual(seg.box, expectBox, `分段 ${segment} 的位置矩形(平面坐标)`);
        if (segment < 3) assert.equal(state.manifest.tight, null, '稀疏的没齐之前不收紧');
      }
      assert.equal(producer.stats.resets - resets0, 1, '四个分段只重灌一次页面');
      // 稀疏的齐了:收紧矩形 = 各分段位置矩形的并集外扩 8、夹回上界、凑偶数
      const tight = state.manifest.tight;
      assert.ok(tight && tight.w <= 2 + 16 + 2 && tight.h <= 2 + 16 + 2 && tight.w % 2 === 0 && tight.h % 2 === 0, `收紧到 ${JSON.stringify(tight)}`);
      assert.ok(tight.x <= expectBox.x && tight.x + tight.w >= expectBox.x + expectBox.w);
      assert.deepEqual(publicManifest(state.manifest).segments[2], { init: state.manifest.segments[2].init, file: state.manifest.segments[2].file, stride: 15, samples: 15, box: expectBox }, '页面读到的清单每个分段带着间隔和位置矩形');
      // 补密:按收紧矩形截,每帧一张;位置矩形沿用稀疏那一趟量的
      const mark = bakes.length;
      const dense = { state, segment: 3, stride: 1 };
      assert.equal(await producer.runSegment(bakery, dense), true);
      await dense.job;
      assert.deepEqual(bakes.slice(mark).map((b) => [b.fromFrame, b.toFrame, b.stride, b.shots.length]), [[145, 149, 1, 5]]);
      assert.deepEqual([state.manifest.segments[3].stride, state.manifest.segments[3].samples], [1, 5]);
      assert.deepEqual(state.manifest.segments[3].box, expectBox);
      // (假编码器的开头文件不随尺寸变,清单里登记的矩形看不出来;看截图矩形:宽高是收紧矩形的,位置是它加上隔离工程里的偏移)
      const denseClip = bakes.slice(mark)[0].clip;
      assert.deepEqual(denseClip, { x: tight.x + spec.offset.x, y: tight.y + spec.offset.y, w: tight.w, h: tight.h }, '满密度的分段按收紧矩形截');
      assert.deepEqual(await framesInSegment(A, spec.streamKey, state.manifest.segments[3].file), [145, 146, 147, 148, 149]);
      // 「接得上租约」按这条流自己的分段边界判(把第 1、2 段清掉当作还没有)
      delete state.manifest.segments[1]; delete state.manifest.segments[2];
      delete state.queueOnly;   // 这条流是按队列任务建的;去掉这个标记,自动生产才会挑它
      const leaseAt = (lastFrame) => { bakery.streamLease = { streamSignature: spec.streamKey, lastFrame, dirty: false, page: bakery.page }; return producer.nextTask(bakery); };
      const mine = (task) => (task?.state === state ? [task.segment, task.stride] : null);
      assert.deepEqual(mine(leaseAt(129)), [2, 15], '第 129 帧是第 1 段的最后一帧:接着做第 2 段;还有分段连稀疏的都没有,先做稀疏');
      assert.deepEqual(mine(leaseAt(128)), [1, 15], '第 128 帧不在分段边界上:不算接得上');
      assert.deepEqual(mine(leaseAt(134)), [1, 15], '第 134 帧是按项目帧号数的分段边界,不是这条流的');
    } finally { A.returnStreamBakery(bakery); }
  });
});

test('SO-05 稀疏的分段,remotion 式的流:只推到分段的第一帧就停,下一段直接跳过去、不重灌页面', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(false, async () => {
    const A = await streamPipeline();
    const executor = executorFor(A);
    await executor.plan(view(planTaskOf({ projectId: PID, projectRev: REV })), { signal: signalNone() });
    const entry = [...A.entries.values()][0];
    const spec = (await A.queueStreamSpecs(entry)).find((s) => s.topClipId === 'clip-b');
    assert.equal(spec.replay, false, 'clip-b 是 remotion 式');
    const producer = A.streamProducer();
    const state = await producer.queueState(entry, spec);
    const bakery = await A.leaseStreamBakery();
    try {
      const resets0 = producer.stats.resets;
      // 不按顺序也行:0、1、5、2
      for (const segment of [0, 1, 5, 2]) {
        const mark = bakes.length;
        const task = { state, segment, stride: SPARSE_STRIDE };
        assert.equal(await producer.runSegment(bakery, task), true);
        await task.job;
        const [run] = bakes.slice(mark);
        const from = 40 + segment * 15;
        assert.deepEqual([run.fromFrame, run.toFrame, run.shots, run.hasMountFrame, run.warm], [from, from, [from], false, 0], `分段 ${segment}:只推到第一帧,不传挂载帧`);
        const seg = state.manifest.segments[segment];
        assert.deepEqual([seg.stride, seg.samples], [15, 15]);
        assert.deepEqual(await framesInSegment(A, spec.streamKey, seg.file), Array(15).fill(from));
      }
      assert.equal(producer.stats.resets - resets0, 1, '只在头一段重灌一次页面,之后都是在同一个页面上跳');
      // 别的调用动过这个会话(租约脏了):照旧重灌
      bakery.streamLease.dirty = true;
      const again = { state, segment: 3, stride: SPARSE_STRIDE };
      assert.equal(await producer.runSegment(bakery, again), true);
      await again.job;
      assert.equal(producer.stats.resets - resets0, 2);
      // 满密度的分段不走「跳」这条路:接不上租约照旧重灌一次(行为和原来相同)
      const dense = { state, segment: 0, stride: 1 };
      assert.equal(await producer.runSegment(bakery, dense), true);
      await dense.job;
      assert.equal(producer.stats.resets - resets0, 3);
    } finally { A.returnStreamBakery(bakery); }
  });
});

test('SO-06 收紧矩形:画面顶到哪几边(只算还没到上界的边);顶到了就往那几边放大;已有按上界产的满密度分段、或有分段没量过位置矩形时不收紧', () => {
  const bound = { x: -32, y: -32, w: 464, h: 304 };
  const rect = { x: 100, y: 50, w: 120, h: 80 };
  assert.equal(tightOverflowSides({ x: 10, y: 10, w: 50, h: 40 }, rect, bound), null, '画面在矩形里面,四边都留着空');
  assert.deepEqual(tightOverflowSides({ x: 0, y: 10, w: 50, h: 40 }, rect, bound), { left: true });
  assert.deepEqual(tightOverflowSides({ x: 70, y: 0, w: 50, h: 80 }, rect, bound), { top: true, right: true, bottom: true });
  // 这一边已经贴着上界:再往外不是这条流的范围,不算
  assert.equal(tightOverflowSides({ x: 0, y: 0, w: 464, h: 304 }, bound, bound), null);
  assert.equal(tightOverflowSides({ x: 0, y: 5, w: 60, h: 20 }, { x: -32, y: 50, w: 120, h: 80 }, bound), null, '左边贴着上界');

  const producer = new StreamProducer({ root: os.tmpdir(), ready: { stageByKey() {}, publish() {} } }, { env: {} });
  const state = { spec: { streamKey: 'k'.repeat(64), firstSegment: 0, lastSegment: 2 }, manifest: { bound, tight: { ...rect }, segments: {} } };
  // 重量的一趟用的截图矩形:顶到的那几边放到上界,别的边不动
  assert.deepEqual(extendSides(rect, { right: true }, bound), { x: 100, y: 50, w: 332, h: 80 });
  assert.deepEqual(extendSides(rect, { left: true, top: true }, bound), { x: -32, y: -32, w: 252, h: 162 });
  assert.deepEqual(extendSides(rect, {}, bound), rect);
  // 重量过:右边实际到 350(收紧矩形原来到 220,超出 130)→ 放到 350 + 外扩 8 + 多留 64(封顶)= 422;别的边不动
  const reach = MEASURE_PAD_PX + TIGHT_WIDEN_MARGIN_PX;
  assert.deepEqual(producer.settleTight(state, { x: 120, y: 60, w: 230, h: 40 }, { right: true }), { x: 100, y: 50, w: 250 + reach, h: 80 });
  assert.deepEqual(state.manifest.tight, { x: 100, y: 50, w: 322, h: 80 });
  assert.equal(state.widened, 1);
  // 只超出一点的不白放大:左边量到从 90 起(超出 10)→ 90 − 8 − 10 = 72;上边量到从 44 起(超出 6)→ 44 − 8 − 6 = 30;只放大不缩小(右、下不动)
  assert.deepEqual(producer.settleTight(state, { x: 90, y: 44, w: 100, h: 60 }, { left: true, top: true }), { x: 72, y: 30, w: 350, h: 100 });
  // 量到的范围超出上界的夹回上界(上边没顶到,不动)
  const wide = { x: -32, y: 30, w: 464, h: 242 };
  assert.deepEqual(producer.settleTight(state, { x: -20, y: -20, w: 440, h: 280 }, { left: true, right: true, bottom: true }), wide);
  assert.deepEqual(producer.settleTight(state, { x: 0, y: 40, w: 10, h: 10 }, { left: true }), wide, '这一边已经到上界:不再放大');
  assert.equal(state.widened, 3);
  // 放大以后省不到 TIGHTEN_MIN_SAVING:干脆用上界
  const flat = { spec: state.spec, manifest: { bound, tight: { x: -32, y: -32, w: 464, h: 100 }, segments: {} } };
  assert.deepEqual(producer.settleTight(flat, { x: 0, y: 0, w: 10, h: 160 }, { bottom: true }), bound);
  // 没量到东西(这一段全透明):照原来的矩形往顶到的那一边多留一点
  const blank = { spec: state.spec, manifest: { bound, tight: { ...rect }, segments: {} } };
  assert.deepEqual(producer.settleTight(blank, null, { right: true }), { x: 100, y: 50, w: 120 + reach, h: 80 });
  // 量到的边界正好贴着原来的边(没超出):按封顶留
  const flush = { spec: state.spec, manifest: { bound, tight: { ...rect }, segments: {} } };
  assert.deepEqual(producer.settleTight(flush, { x: 100, y: 60, w: 50, h: 40 }, { left: true }), { x: 100 - reach, y: 50, w: 120 + reach, h: 80 });

  // maybeTighten:各分段位置矩形的并集
  const seg = (box, extra = {}) => ({ file: 'f', init: 'i', stride: 15, samples: 15, sig: null, adopted: true, ...(box !== undefined ? { box } : {}), ...extra });
  const fresh = (segments) => ({ spec: { streamKey: 'k'.repeat(64), firstSegment: 0, lastSegment: 2 }, manifest: { streamKey: 'k'.repeat(64), bound, tight: null, segments } });
  const ok = fresh({ 0: seg({ x: 100, y: 60, w: 40, h: 30 }), 1: seg(null), 2: seg({ x: 180, y: 70, w: 40, h: 30 }) });
  producer.maybeTighten(ok);
  assert.deepEqual(ok.manifest.tight, { x: 92, y: 52, w: 136, h: 56 }, '并集 100..220 × 60..100 外扩 8;全透明的那一段不参与');
  const missing = fresh({ 0: seg({ x: 100, y: 60, w: 40, h: 30 }), 1: seg(undefined), 2: seg({ x: 180, y: 70, w: 40, h: 30 }) });
  producer.maybeTighten(missing);
  assert.deepEqual(missing.manifest.tight, bound, '有一段没量过位置矩形:不收紧');
  const hasDense = fresh({ 0: seg({ x: 100, y: 60, w: 40, h: 30 }, { stride: 1, adopted: false }), 1: seg(null), 2: seg({ x: 180, y: 70, w: 40, h: 30 }) });
  producer.maybeTighten(hasDense);
  assert.deepEqual(hasDense.manifest.tight, bound, '本机已经有按上界产的满密度分段:不收紧(收紧会把它判旧重产)');
  const partial = fresh({ 0: seg({ x: 100, y: 60, w: 40, h: 30 }), 2: seg({ x: 180, y: 70, w: 40, h: 30 }) });
  producer.maybeTighten(partial);
  assert.equal(partial.manifest.tight, null, '稀疏的还没齐:先不定');
  const allClear = fresh({ 0: seg(null), 1: seg(null), 2: seg(null) });
  producer.maybeTighten(allClear);
  assert.deepEqual(allClear.manifest.tight, bound, '整条流都透明:不收紧');
});
