/**
 * M6c X1:轨道流走队列(`docs/plan/m6c-contract.md` X1)。用例名以 `X1-` 开头。
 * 跑:node --experimental-test-module-mocks --test server/test/stream-queue.test.mjs
 *
 * 不用 Chrome、不用 ffmpeg:
 *   - `bakery/index.mjs` 整个换成假的(同 `prerender-executor.test.mjs`):`openBakery` 回一个假预渲染间,
 *     `page.evaluate` 回这一套场景的 browserPlan;
 *   - `bakery/bake.mjs` 换成假的 `bakeStream`:按 stride 逐帧交出一张「图」(字节由流键与帧号决定),并照真的那样
 *     记下租约;`dirtyStreamLease` 照真的写;
 *   - `bakery/ffmpeg.mjs` 用真的导出,只换掉 `findFfmpeg`、`pickStreamEncoder`、`openStreamSegmentEncoder`:
 *     假编码器把收到的帧数与字节做成一个结构合法的 fMP4(`ftyp + moov` 与一对 `moof + mdat`,
 *     `trun` 的样本数就是帧数、首帧是同步帧),字节由输入与编码器名决定 —— 两台编码器不同的机器产的分段字节不同、
 *     流键相同。
 *
 * 管线是 `interactive: true` 的 `FramePipeline`(有轨道流生产者),注入环境指纹,不探测。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------------ 假的预渲染间 / 截图 / 编码器 */

let scene = null;
/** 每次 bakeStream 开始时调用(用来在产的途中卡住) */
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
      streamBakes.push({ streamSignature, fromFrame, toFrame, stride });
      if (onBakeStream) await onBakeStream({ streamSignature, fromFrame, toFrame, stride });
      const lease = bakery.streamLease;
      const continues = !!lease && !lease.dirty && lease.page === bakery.page && lease.streamSignature === streamSignature && fromFrame === lease.lastFrame + 1;
      let captured = 0;
      for (let frame = fromFrame; frame <= toFrame; frame += stride) {
        if (signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
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
/** 结构合法的一段 fMP4:init(ftyp + moov)随编码器名变,分段(moof + mdat)随输入字节与编码器名变 */
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

/* ------------------------------------------------------------------ 场景 */

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
 * 三个片段(5 秒,150 帧):
 *   clip-a  独立卡(independent,有状态),0～5 秒 → 进流,分段 0～9,切成两个流任务(0-7、8-9)
 *   clip-c  独立卡、canvasHeavy,1～2 秒 → 进流
 *   clip-b  毛玻璃(belowDependent,本地档),1～4 秒 → 一条依赖下层的流(只有切分方自己的一份,一个流任务);
 *           这种流经队列怎么走在 `below-stream-queue.test.mjs` 里验,这里只核它在计划和任务表里
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

/** 有轨道流生产者的管线;`encoder` 是这台「机器」探到的编码器名 */
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

/** 内存里的素材服务客户端(`put` / `get` / `has`,按 sha256 寻址) */
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
/** 内存里的内容库(`put` / `get`) */
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
/** 这条流里某个分段(和它的 init)在磁盘上的 sha256 */
async function segmentHashes(pipeline, key, n) {
  const manifest = await manifestOf(pipeline, key);
  const seg = manifest.segments[n];
  if (!seg) return null;
  const segBytes = await fs.readFile(path.join(streamDir(pipeline, key), seg.file));
  const initBytes = await fs.readFile(path.join(streamDir(pipeline, key), `init-${seg.init}.mp4`));
  return { seg: sha256(segBytes), init: sha256(initBytes), stride: seg.stride, samples: seg.samples };
}

/* ================================================================== 过滤与切分 */

test('X1-filter 流任务要求 capabilities.streams:报 true 的节点收,报 false 的不收(规则 2 streams);没报这一项的旧节点按 transcode;纯浏览器不收', () => {
  const task = {
    id: 'stream:k:0-7', kind: 'stream', resultKey: 'k', range: { unit: 'segment', from: 0, to: 7 }, source: { projectId: PID, projectRev: REV },
    weight: { class: 'heavy', frames: 120 },
    requires: { envFingerprint: OWN, codeVersion: CV, cardSources: {}, transcode: true, userCards: false, graphCards: false, belowDependent: false, capabilities: { streams: true } },
  };
  const node = (profile, capabilities, extra = {}) => ({ profile, envFingerprint: OWN, codeVersions: [CV], capabilities, ...extra });
  assert.deepEqual(checkClaimable(task, node('pc', { userCards: true, graphCards: false, transcode: true, streams: true })), { ok: true });
  assert.deepEqual(checkClaimable(task, node('host', { userCards: true, graphCards: false, transcode: true, streams: true })), { ok: true });
  assert.deepEqual(checkClaimable(task, node('pc', { userCards: true, graphCards: false, transcode: false, streams: false })), { ok: false, rule: 2, reason: 'streams' });
  assert.deepEqual(checkClaimable(task, node('pc', { userCards: true, transcode: true, streams: false })), { ok: false, rule: 2, reason: 'streams' }, '报了 false 就不收,不看 transcode');
  assert.deepEqual(checkClaimable(task, node('pc', { userCards: true, transcode: true })), { ok: true }, '没报 streams 的旧形状按 transcode');
  assert.deepEqual(checkClaimable(task, node('pc', { userCards: true })), { ok: false, rule: 2, reason: 'streams' });
  const browser = node('browser', { userCards: false, graphCards: false, transcode: false, streams: false }, { userId: 'u1' });
  assert.equal(checkClaimable({ ...task, source: { ...task.source, userId: 'u1' } }, browser).ok, false, '纯浏览器一律不收流任务');
  // 快照任务不受这一条影响
  const snap = { ...task, kind: 'snapshot', requires: { ...task.requires, transcode: false, capabilities: undefined } };
  assert.equal(checkClaimable(snap, node('pc', { userCards: true, streams: false })).ok, true);
});

test('X1-split 流任务带 requires.capabilities.streams = true;快照任务不带;结果键 = 内容键 × 指纹', () => {
  const tasks = splitPlan({
    planTask: planTaskOf({ projectId: PID, projectRev: REV }), entryKey: 'e'.repeat(64), envFingerprint: OWN, codeVersion: CV,
    cardPlan: [{ clipId: 'clip-a', snapshotKey: 's'.repeat(64), contentKey: 'c'.repeat(64), tier: 'shared', capabilities: CAPS['clip-a'], count: 60 }],
    streams: [{ streamKey: resultKeyOf('d'.repeat(64), OWN), contentKey: 'd'.repeat(64), topClipId: 'clip-a', firstSegment: 0, lastSegment: 9 }],
  });
  const streams = tasks.filter((t) => t.kind === 'stream');
  const snaps = tasks.filter((t) => t.kind === 'snapshot');
  assert.deepEqual(streams.map((t) => [t.range.from, t.range.to]), [[0, 9]], 'motion 卡不足 30s(60段)整张一口气做完');
  for (const t of streams) {
    assert.deepEqual(t.requires.capabilities, { streams: true });
    assert.equal(t.requires.transcode, true);
    assert.equal(t.resultKey, resultKeyOf('d'.repeat(64), OWN));
  }
  for (const t of snaps) assert.equal(t.requires.capabilities, undefined);

  // 补测：remotion 卡仍按 8 段切分
  const remotionTasks = splitPlan({
    planTask: planTaskOf({ projectId: PID, projectRev: REV }), entryKey: 'e'.repeat(64), envFingerprint: OWN, codeVersion: CV,
    cardPlan: [{ clipId: 'clip-r', snapshotKey: 's'.repeat(64), contentKey: 'c'.repeat(64), tier: 'shared', capabilities: { writing: 'remotion', frameMode: 'direct' }, count: 60 }],
    streams: [{ streamKey: resultKeyOf('d'.repeat(64), OWN), contentKey: 'd'.repeat(64), topClipId: 'clip-r', firstSegment: 0, lastSegment: 9 }],
  });
  const remotionStreams = remotionTasks.filter((t) => t.kind === 'stream');
  assert.deepEqual(remotionStreams.map((t) => [t.range.from, t.range.to]), [[0, 7], [8, 9]], 'remotion 卡保持 8 段切分');
});

/* ================================================================== plan 出流 */

test('X1-plan 开关开着、探到编码器:plan 的 streams 是这一版的全部流(流键 = 内容键 × 本机指纹,与生产者算的相同);PROMPTCUT_STREAMS=0 时为空、不能产流', { timeout: 30_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const ctx = await executorFor(A).plan(planView(), { signal: signalNone() });
  const clips = ctx.streams.map((s) => s.topClipId).sort();
  assert.deepEqual(clips, ['clip-a', 'clip-b', 'clip-c'], '独立卡各一条单卡流,毛玻璃一条依赖下层的流');
  assert.deepEqual(ctx.streams.map((s) => `${s.kind}:${s.topClipId}`).sort(), ['below:clip-b', 'card:clip-a', 'card:clip-c']);
  for (const s of ctx.streams) {
    assert.equal(s.streamKey, resultKeyOf(s.contentKey, OWN), '流键 = 内容键 × 本机指纹');
    assert.ok(Number.isInteger(s.firstSegment) && s.lastSegment >= s.firstSegment);
  }
  const a = ctx.streams.find((s) => s.topClipId === 'clip-a');
  assert.deepEqual([a.firstSegment, a.lastSegment], [0, 9]);
  assert.equal(await A.streamCapable(), true);
  assert.deepEqual(streamTasksOf(ctx).map((x) => x.input.clipId).sort(), ['clip-a', 'clip-b', 'clip-c']);
  assert.deepEqual(streamTasksOf(ctx).filter((x) => x.requires.belowDependent === true).map((x) => x.input.clipId), ['clip-b']);

  const off = await streamPipeline({ env: { PROMPTCUT_STREAMS: '0' } });
  assert.equal(off.streamProducer().enabled, false);
  assert.equal(await off.streamCapable(), false, 'PROMPTCUT_STREAMS=0:streams 能力为 false');
  const offCtx = await executorFor(off).plan(planView(), { signal: signalNone() });
  assert.deepEqual(offCtx.streams, [], 'PROMPTCUT_STREAMS=0:不发布流任务(与 M5b 相同)');
  const err = await executorFor(off).render(view(streamTasksOf(ctx)[0]), { signal: signalNone(), progress: () => {} }).then(() => null, (e) => e);
  assert.equal(err?.code, 'no-streams');
  assert.equal(err?.retryable, false);
});

test('X1-encoder-probe 探不到编码器:streamCapable 为 false,plan 不出流,生产者关掉', { timeout: 30_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const producer = A.streamProducer();
  producer.encoderName = undefined;
  producer.encoder = async () => { throw new Error('没有能用的 H.264 编码器(假)'); };
  assert.equal(await A.streamCapable(), false);
  assert.equal(producer.enabled, false);
  const ctx = await executorFor(A).plan(planView(), { signal: signalNone() });
  assert.deepEqual(ctx.streams, []);
});

/* ================================================================== 执行器产流、推送、另一节点取用 */

test('X1-render 执行器按段产出流任务的分段(满密度)、报进度;sink 推 px、写每段清单(<resultKey>:<from>-<to>)、回 StreamResult;另一节点 applyResult 经 adoptSegments 落地,逐段 sha256 一致、不判旧', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline({ encoder: 'h264_nvenc' });
  const B = await streamPipeline({ encoder: 'libx264' });
  const executor = executorFor(A);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  // 依赖下层的那一条(clip-b)不在这一条用例里产:它每帧截两张,走的取帧钩子在 `below-capture.test.mjs`、`below-stream-queue.test.mjs` 里验
  const tasks = streamTasksOf(ctx).filter((x) => x.requires.belowDependent !== true);
  assert.equal(tasks.length, 2);
  const client = memoryClient();
  const content = memoryContent();
  const sink = createAssetSink({ pipeline: A, client, content });

  for (const task of tasks) {
    const ref = { resultKey: task.resultKey, kind: 'stream', tier: null, range: task.range, input: task.input, requires: task.requires };
    assert.equal(await sink.has(ref), false, '开工前本机、内容库都没有');
    const progress = [];
    const out = await executor.render(view(task), { signal: signalNone(), progress: (n) => progress.push(n) });
    assert.equal(out, null, 'render 回 null:产物在流库里');
    const segs = task.range.to - task.range.from + 1;
    assert.equal(progress.length, segs, '每个分段报一次进度');
    assert.ok(progress.every((n, i) => i === 0 || n > progress[i - 1]), '进度单调增');
    // 满密度、样本数对、签名带本机编码器
    const manifest = await manifestOf(A, task.resultKey);
    for (let n = task.range.from; n <= task.range.to; n++) {
      const seg = manifest.segments[n];
      assert.ok(seg, `分段 ${n} 在清单里`);
      assert.equal(seg.stride, 1, '队列产的是满密度分段');
      assert.equal(manifest.inits[seg.init].encoder, 'h264_nvenc');
      assert.equal(seg.sig, segmentSignature({ streamKey: task.resultKey, segment: n, stride: 1, encoder: 'h264_nvenc', rect: manifest.tight ?? manifest.bound }));
    }
    assert.equal(A.streamProducer().segmentState(A.streamProducer().streams.get(task.resultKey), task.range.from), 'dense');
    // sink:推 px、写清单
    const put = await sink.put({ ...ref, artifacts: null, meta: { taskId: task.id, nodeId: 'A', token: 1 } });
    assert.equal(put.complete, true);
    const result = put.result;
    assert.equal(result.v, 1);
    assert.equal(result.kind, 'stream');
    assert.equal(result.resultKey, task.resultKey);
    assert.deepEqual(result.range, { from: task.range.from, to: task.range.to });
    assert.deepEqual(Object.keys(result.segments).map(Number).sort((x, y) => x - y), Array.from({ length: segs }, (_, i) => task.range.from + i));
    for (const seg of Object.values(result.segments)) {
      assert.equal(seg.encoder, 'h264_nvenc', '编码器只进清单');
      assert.ok(client.blobs.has(`px/${seg.hash}`), '分段在素材服务的 px 里');
      assert.ok(client.blobs.has(`px/${result.inits[seg.init].hash}`), 'init 在 px 里');
    }
    const key = `${task.resultKey}:${task.range.from}-${task.range.to}`;
    assert.deepEqual(content.items.get(`render-manifest\u0000${key}`), result, '每段清单写进内容库,键 <resultKey>:<from>-<to>');

    // 另一节点(编码器不同)取用
    const applied = await applyResult(B, client, structuredClone(result));
    assert.equal(applied.written, segs, 'B 落地了这一段的全部分段');
    const bManifest = await manifestOf(B, task.resultKey);
    for (let n = task.range.from; n <= task.range.to; n++) {
      const a = await segmentHashes(A, task.resultKey, n);
      const b = await segmentHashes(B, task.resultKey, n);
      assert.deepEqual(b, a, `分段 ${n}:两边 sha256 一致(分段与 init)`);
      assert.equal(bManifest.segments[n].adopted, true);
      assert.equal(bManifest.segments[n].encoder, 'h264_nvenc', 'B 记着对方的编码器');
      const state = B.streamProducer().streams.get(task.resultKey);
      assert.equal(B.streamProducer().segmentState(state, n), 'dense', `分段 ${n}:编码器不同也不判旧`);
    }
    // B 再拉同一份:全部跳过、不下载
    const before = client.calls.get;
    const again = await applyResult(B, client, structuredClone(result));
    assert.equal(again.written, 0);
    assert.equal(client.calls.get, before, '已有的不再下载');
  }
  // 编码器不进结果键:B 用自己的编码器(libx264)算的这一版流键与 A 相同
  const bCtx = await executorFor(B).plan(planView(), { signal: signalNone() });
  assert.deepEqual(bCtx.streams.map((s) => s.streamKey).sort(), ctx.streams.map((s) => s.streamKey).sort(), '编码器不同,流键相同');
  // 而分段签名带编码器
  assert.notEqual(segmentSignature({ streamKey: tasks[0].resultKey, segment: 0, stride: 1, encoder: 'h264_nvenc', rect: { x: 0, y: 0, w: 2, h: 2 } }),
    segmentSignature({ streamKey: tasks[0].resultKey, segment: 0, stride: 1, encoder: 'libx264', rect: { x: 0, y: 0, w: 2, h: 2 } }));
});

test('X1-render-skip 已经是满密度、不旧的分段不重产;本机只有稀疏分段时补成满密度', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const [task] = streamTasksOf(ctx).filter((x) => x.input.clipId === 'clip-a');
  await executor.render(view(task), { signal: signalNone(), progress: () => {} });
  const mark = streamBakes.length;
  const first = await segmentHashes(A, task.resultKey, 8);
  await executor.render(view(task), { signal: signalNone(), progress: () => {} });
  assert.equal(streamBakes.length, mark, '第二次一帧都不截');
  assert.deepEqual(await segmentHashes(A, task.resultKey, 8), first);
  // 把分段 9 改成稀疏版的样子:要补成满密度
  const producer = A.streamProducer();
  const state = producer.streams.get(task.resultKey);
  state.manifest.segments[9] = { ...state.manifest.segments[9], stride: SPARSE_STRIDE,
    sig: segmentSignature({ streamKey: task.resultKey, segment: 9, stride: SPARSE_STRIDE, encoder: producer.encoderName, rect: state.manifest.bound }) };
  assert.equal(producer.segmentState(state, 9), 'sparse');
  await executor.render(view(task), { signal: signalNone(), progress: () => {} });
  assert.equal(producer.segmentState(state, 9), 'dense');
  assert.deepEqual(streamBakes.slice(mark).map((b) => [b.fromFrame, b.stride]), [[9 * SEGMENT_FRAMES, 1]], '只补产分段 9');
});

test('X1-sparse 稀疏流任务:每个分段只截第一帧、清单与满密度同一个键;sink 认它完成、不拿它当满密度任务的结果;满密度任务随后在同一个键上补成满密度;晚到的稀疏流任务不降级', { timeout: 60_000 }, async (t) => {
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
  assert.ok(sparse.priority > dense.priority, '稀疏流任务排在满密度任务前面');
  // 同一条流里稀疏流任务排在满密度任务前面发
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

  // 稀疏流任务:每个分段一趟、stride 是一个分段的帧数;清单里这几段记着稀疏
  let mark = streamBakes.length;
  await executor.render(view(sparse), { signal: signalNone(), progress: () => {} });
  assert.deepEqual(streamBakes.slice(mark).map((b) => b.stride), Array(segs).fill(SPARSE_STRIDE));
  const state = producer.streams.get(dense.resultKey);
  for (let n = dense.range.from; n <= dense.range.to; n++) {
    assert.equal(producer.segmentState(state, n), 'sparse');
    assert.equal(state.manifest.segments[n].stride, SPARSE_STRIDE);
    assert.equal(state.manifest.segments[n].samples, SEGMENT_FRAMES, '样本数照满:一张重复到整段');
  }
  // sink:稀疏流任务算完成、写清单;同一份本机产物不能当满密度任务的结果
  assert.equal(await sink.has(refOf(dense)), false, '只有稀疏版:满密度任务不走去重');
  const put = await sink.put({ ...refOf(sparse), artifacts: null, meta: { taskId: sparse.id, nodeId: 'A', token: 1 } });
  assert.equal(put.complete, true);
  assert.ok(Object.values(content.items.get(key).segments).every((seg) => seg.stride === SPARSE_STRIDE), '内容库里这个键下是稀疏版');
  assert.equal(await sink.has(refOf(sparse)), true, '稀疏流任务:有一版就算有');
  assert.equal(await sink.has(refOf(dense)), false, '内容库里只有稀疏版:满密度任务仍不走去重');
  const densePutEarly = await sink.put({ ...refOf(dense), artifacts: null, meta: { taskId: dense.id, nodeId: 'A', token: 1 } });
  assert.equal(densePutEarly.complete, false, '满密度任务拿稀疏版交不了差');
  // 再做一次稀疏流任务:一帧都不截
  mark = streamBakes.length;
  await executor.render(view(sparse), { signal: signalNone(), progress: () => {} });
  assert.equal(streamBakes.length, mark);

  // 满密度任务:同一个键上补成满密度
  await executor.render(view(dense), { signal: signalNone(), progress: () => {} });
  assert.deepEqual(streamBakes.slice(mark).map((b) => b.stride), Array(streamBakes.length - mark).fill(1));
  for (let n = dense.range.from; n <= dense.range.to; n++) assert.equal(producer.segmentState(state, n), 'dense');
  const putDense = await sink.put({ ...refOf(dense), artifacts: null, meta: { taskId: dense.id, nodeId: 'A', token: 1 } });
  assert.equal(putDense.complete, true);
  assert.ok(Object.values(content.items.get(key).segments).every((seg) => seg.stride === 1), '同一个键换成了满密度的');
  assert.equal(await sink.has(refOf(dense)), true);
  assert.equal(await sink.has(refOf(sparse)), true);
  // 稀疏流任务晚到(本机已经是满密度):不截、不降级
  mark = streamBakes.length;
  await executor.render(view(sparse), { signal: signalNone(), progress: () => {} });
  assert.equal(streamBakes.length, mark, '已经有满密度的:稀疏流任务一帧都不截');

  // 不降级:别的节点(同指纹)晚到的稀疏清单写同一个键,已有的满密度分段留着;它多出来的分段并进去
  const denseBody = content.items.get(key);
  const first = dense.range.from;
  const lateSparse = structuredClone(denseBody);
  for (const seg of Object.values(lateSparse.segments)) { seg.stride = SPARSE_STRIDE; seg.hash = 'e'.repeat(64); }
  const merged = mergeStreamResult(denseBody, lateSparse);
  assert.deepEqual(merged.segments, denseBody.segments, '已有的满密度分段一个都没被稀疏的换掉');
  assert.equal(await writeManifest(content, lateSparse), true);
  assert.deepEqual(content.items.get(key).segments, denseBody.segments);
  // 新清单只列了一段(边产边写):已有清单里别的分段留着;新的满密度分段盖掉已有的稀疏分段
  const partial = structuredClone(denseBody);
  for (const n of Object.keys(partial.segments)) if (Number(n) !== first) delete partial.segments[n];
  const sparseBody = structuredClone(lateSparse);
  const up = mergeStreamResult(sparseBody, partial);
  assert.equal(up.segments[first].stride, 1);
  assert.equal(Object.keys(up.segments).length, segs);
  assert.ok(Object.entries(up.segments).every(([n, seg]) => (Number(n) === first ? seg.stride === 1 : seg.stride === SPARSE_STRIDE)));
  // 对不上的(键不同、范围不同、不是流)原样用新的
  assert.equal(mergeStreamResult({ ...denseBody, resultKey: 'f'.repeat(64) }, lateSparse), lateSparse);
  assert.equal(mergeStreamResult({ ...denseBody, range: { from: 0, to: 7 } }, lateSparse), lateSparse);
  assert.equal(mergeStreamResult(null, lateSparse), lateSparse);

  // 另一台同指纹的节点本机只有稀疏版:拉稀疏的清单不换(两边都是稀疏),拉满密度的清单升成满密度
  const B = await streamPipeline();
  const executorB = executorFor(B);
  await executorB.plan(planView(), { signal: signalNone() });
  await executorB.render(view(sparse), { signal: signalNone(), progress: () => {} });
  const stateB = B.streamProducer().streams.get(dense.resultKey);
  assert.equal(B.streamProducer().segmentState(stateB, first), 'sparse');
  assert.equal((await applyResult(B, client, structuredClone(put.result))).written, 0, '对方也是稀疏的:不收');
  assert.equal((await applyResult(B, client, structuredClone(denseBody))).written, segs, '对方是满密度的:升上去');
  for (let n = dense.range.from; n <= dense.range.to; n++) {
    assert.equal(B.streamProducer().segmentState(stateB, n), 'dense');
    assert.equal(stateB.manifest.segments[n].adopted, true);
  }
});

test('X1-mismatch 流任务对不上这一版的流:内容键、结果键(别的指纹)、分段范围越界 → plan-mismatch(不可重试),不截图', { timeout: 30_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const [task] = streamTasksOf(ctx);
  const mut = (fn) => { const copy = view(task); fn(copy); return copy; };
  const cases = [
    ['内容键不同', mut((x) => { x.input.contentKey = 'f'.repeat(64); })],
    ['结果键是别的指纹的', mut((x) => { x.resultKey = resultKeyOf(x.input.contentKey, 'aaaaaaaaaaaaaaaa'); })],
    ['分段越界', mut((x) => { x.range = { unit: 'segment', from: 8, to: 12 }; })],
  ];
  const mark = streamBakes.length;
  for (const [what, bad] of cases) {
    const err = await executor.render(bad, { signal: signalNone(), progress: () => {} }).then(() => null, (e) => e);
    assert.equal(err?.code, 'plan-mismatch', `${what}:${err?.code} ${err?.message}`);
    assert.equal(err?.retryable, false);
  }
  assert.equal(streamBakes.length, mark);
});

test('X1-abort 中途中止:拒绝(cancelled),不再产后面的分段;之后用新信号重做能补齐', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const [task] = streamTasksOf(ctx).filter((x) => x.input.clipId === 'clip-a' && x.range.from === 0);
  const controller = new AbortController();
  onBakeStream = async ({ fromFrame }) => { if (fromFrame === 2 * SEGMENT_FRAMES) controller.abort(); };
  const err = await executor.render(view(task), { signal: controller.signal, progress: () => {} }).then(() => null, (e) => e);
  assert.ok(err, '中止要拒绝');
  onBakeStream = null;
  const manifest = await manifestOf(A, task.resultKey).catch(() => ({ segments: {} }));
  assert.ok(!manifest.segments[3], '中止之后的分段没产');
  await executor.render(view(task), { signal: signalNone(), progress: () => {} });
  const full = await manifestOf(A, task.resultKey);
  for (let n = 0; n <= 7; n++) assert.equal(full.segments[n]?.stride, 1, `分段 ${n} 补齐`);
});

/* ================================================================== 队列模式与自动生产 */

test('X1-owned 队列模式的 entry(queueSnapshots)的流不自动产;退回本机(queueSnapshots=false)后自动生产接手', { timeout: 30_000 }, async (t) => {
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
  assert.ok(producer.streams.size >= 2, '流的 state 照常建(读回、发层要用)');
  assert.equal(producer.nextTask(null), null, '归队列的流:自动生产没有活');
  await producer.drain();
  assert.equal(streamBakes.length, mark, '一帧都没自己截');
  entry.queueSnapshots = false;
  assert.ok(producer.nextTask(null), '退回本机后自动生产有活');
});

test('X1-local-fallback 切分方没切出流任务:releaseQueueStreams 把这一版的流交还本机自动生产,快照仍归队列;不是队列模式 / 重复调用回 0', { timeout: 30_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  await executor.plan(planView(), { signal: signalNone() });
  const entry = await A.entry(projectJson());
  const producer = A.streamProducer();
  assert.equal(A.releaseQueueStreams(entry.key), 0, '不是队列模式的 entry:不动');
  entry.queueSnapshots = true;
  await producer.update(entry);
  assert.equal(producer.nextTask(null), null, '归队列的流:自动生产没有活');
  assert.equal(A.releaseQueueStreams('no-such-entry'), 0, '没有这个 entry:不动');
  assert.equal(A.releaseQueueStreams(entry.key), 1, '交还一个 entry');
  assert.equal(entry.queueSnapshots, true, '快照照旧归队列');
  assert.equal(entry.queueStreamsLocal, true);
  assert.ok(producer.nextTask(null), '交还之后自动生产有活');
  assert.equal(A.releaseQueueStreams(entry.key), 0, '重复调用:不动');
});

test('X1-hold 队列正在产的流:换一版(新计划里没有它)时 state 不丢,在产的分段照常落盘', { timeout: 60_000 }, async (t) => {
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
  // 换一版:只剩毛玻璃那一张,而且这一版的卡片计划是空的(一条流都不出)
  const other = projectJson();
  other.tracks = other.tracks.filter((tr) => tr.clips[0].id === 'clip-b');
  const otherEntry = await A.entry(other);
  otherEntry.cardPlan = [];
  await producer.update(otherEntry);
  assert.ok(producer.streams.has(task.resultKey), '在产的流留在生产者里');
  onBakeStream = null;
  release();
  await running;
  const manifest = await manifestOf(A, task.resultKey);
  for (let n = task.range.from; n <= task.range.to; n++) assert.equal(manifest.segments[n]?.stride, 1, `分段 ${n} 落盘`);
});

test('X1-attempts 一个分段连续失败 QUEUE_SEGMENT_ATTEMPTS 次:任务以可重试的错误失败', { timeout: 30_000 }, async (t) => {
  t.after(cleanup);
  const A = await streamPipeline();
  const executor = executorFor(A);
  const ctx = await executor.plan(planView(), { signal: signalNone() });
  const [task] = streamTasksOf(ctx).filter((x) => x.input.clipId === 'clip-c');
  let calls = 0;
  onBakeStream = async () => { calls++; throw new Error('截图坏了(假)'); };
  const err = await executor.render(view(task), { signal: signalNone(), progress: () => {} }).then(() => null, (e) => e);
  assert.equal(err?.code, 'stream-segment-failed');
  assert.notEqual(err?.retryable, false);
  assert.equal(calls, QUEUE_SEGMENT_ATTEMPTS);
});
