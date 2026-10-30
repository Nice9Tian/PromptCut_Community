/**
 * 依赖下层的流(`kind: 'below'`,`docs/plan/prerender-products-contract.md` 第 5.1 节)经队列走一遍:
 * 管线的计划(`planForQueue`)→ 切分 → 执行器把流任务对回这一版的流(`prerender-executor.mjs` 的 `matchStream`)→ 生产者按隔离工程产分段。
 * 用例名以 `BLQ-` 开头。跑:npm test -- server/test/below-stream-queue.test.mjs
 *
 * 开关(`PROMPTCUT_TEST_BELOW_STREAMS`)在每条用例里自己设、自己还原:产品里缺省开着;设成 0 是扮「还不认识这种流的旧节点」,那时这一路什么都不出。
 * 不用 Chrome、不用 ffmpeg,假件照 `stream-queue.test.mjs` 的做法(预渲染间、`bakeStream`、分段编码器)。
 * 这里验的是「认不认得、对不对得上、隔离工程给的是哪一种」;流里的像素怎么取不在这一块。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { streamInputSig } from '../../src/render/streamInputSig.mjs';

/* ------------------------------------------------------------------ 假的预渲染间 / 截图 / 编码器 */

let scene = null;
const streamBakes = [];
/** 每次把隔离工程灌进预渲染间时记一笔 */
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
      streamBakes.push({ streamSignature, fromFrame, toFrame, stride, mountFrame: opts.mountFrame, clip: opts.clip });
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
/** 结构合法的一段 fMP4:`ftyp + moov` 与一对 `moof + mdat`,`trun` 的样本数就是帧数、首帧是同步帧 */
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

/* ------------------------------------------------------------------ 场景 */

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
 * 从上到下三条序列(5 秒,150 帧):
 *   clip-top  独立卡,0～5 秒   —— 在毛玻璃上面
 *   clip-g    毛玻璃(依赖下层),1～4 秒 —— 目标卡;流从它的第一帧(第 30 帧)起分段,分段 0～5
 *   clip-a    独立卡,0～5 秒   —— 毛玻璃的下层
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
/** 这一段里把「依赖下层的流」的开关设成 `on`,出去时还原 */
async function withBelow(on, fn) {
  const saved = process.env.PROMPTCUT_TEST_BELOW_STREAMS;
  process.env.PROMPTCUT_TEST_BELOW_STREAMS = on ? '1' : '0';
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.PROMPTCUT_TEST_BELOW_STREAMS; else process.env.PROMPTCUT_TEST_BELOW_STREAMS = saved;
  }
}

/* ================================================================== 用例 */

test('BLQ-off 关着(旧节点的样子):计划里没有这种流,切不出这种任务,层表里没有这种行', { timeout: 30_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(false, async () => {
    const A = await streamPipeline();
    const ctx = await executorFor(A).plan(planView(), { signal: signalNone() });
    assert.deepEqual(ctx.streams.map((s) => `${s.kind}:${s.topClipId}`).sort(), ['card:clip-a', 'card:clip-top'], '只有独立卡的单卡流,毛玻璃不进');
    assert.ok(ctx.streams.every((s) => !('belowClipIds' in s)));
    const tasks = streamTasksOf(ctx);
    assert.ok(tasks.length > 0);
    assert.ok(tasks.every((x) => x.requires.belowDependent === false));
    const entry = [...A.entries.values()][0];
    const options = A.layerMapStreamOptions(entry);
    assert.deepEqual((options.streams ?? []).map((s) => s.kind).sort(), ['card', 'card']);
  });
});

test('BLQ-on 打开以后:计划多出毛玻璃的那一条;切出的任务带 belowDependent;执行器对得回这一版的流,按「只藏上面的层」的隔离工程产', { timeout: 60_000 }, async (t) => {
  t.after(cleanup);
  await withBelow(true, async () => {
    const A = await streamPipeline();
    const executor = executorFor(A);
    const ctx = await executor.plan(planView(), { signal: signalNone() });
    assert.deepEqual(ctx.streams.map((s) => `${s.kind}:${s.topClipId}`).sort(), ['below:clip-g', 'card:clip-a', 'card:clip-top']);
    const q = ctx.streams.find((s) => s.kind === 'below');
    assert.equal(q.plane, 'stage');
    assert.deepEqual(q.clipIds, ['clip-g']);
    assert.deepEqual(q.belowClipIds, ['clip-a'], '下面那张卡算进键;上面那张不算');
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
    assert.ok(bakes.length > 0 && bakes.every((b) => b.streamSignature === q.streamKey), '产的就是这条流');
    // 这种流推过去的每一拍都要画一张(下层的动画不画就不往前走):头一段接不上租约,从回放的起点(第 0 帧)起每一帧都交给取帧钩子,
    // 第 30 帧之前的画完就丢、不进编码器;后面几段接着租约,从各自的第一帧起
    assert.deepEqual(bakes.map((b) => b.fromFrame), [0, 45, 60, 75, 90, 105], '分段 0～5(第 30 帧起每 15 帧一段),满密度;头一段从回放的起点画起');
    assert.ok(bakes.every((b) => b.stride === 1));
    assert.deepEqual(bakes[0].clip, { x: 0, y: 0, w: 320, h: 180 }, '按舞台坐标截(上界是整个画面)');
    assert.equal(bakes[0].mountFrame, 0, '下层那张卡是 motion 式,从它的挂载帧推过来');
    // 灌进预渲染间的隔离工程:目标卡和下面的层出画,上面的层藏起来
    const iso = resets.slice(markResets)[0];
    assert.ok(iso, '重灌过一次工程');
    assert.deepEqual(iso.tracks.filter((tr) => !tr.hidden).map((tr) => tr.clips.map((c) => c.id)), [['clip-g'], ['clip-a']]);
    assert.deepEqual(iso.tracks.filter((tr) => tr.hidden).map((tr) => [tr.clips.map((c) => c.id), tr.sourceOnly]), [[['clip-top'], true]]);
    // 清单里记着这是哪一种流
    const manifest = await manifestOf(A, q.streamKey);
    assert.equal(manifest.kind, 'below');
    assert.equal(manifest.plane, 'stage');
    assert.deepEqual(manifest.clipIds, ['clip-g']);
    assert.equal(manifest.originFrame, 30, '清单记着这条流的第一帧');
    assert.deepEqual(Object.keys(manifest.segments).map(Number).sort((x, y) => x - y), [0, 1, 2, 3, 4, 5]);
    for (let n = 0; n <= 5; n++) assert.equal(manifest.segments[n]?.stride, 1, `分段 ${n} 产了`);
    // 层表那一行
    const entry = [...A.entries.values()][0];
    const rows = (A.layerMapStreamOptions(entry).streams ?? []).filter((s) => s.kind === 'below');
    assert.deepEqual(rows.map((s) => s.contentKey), [q.contentKey]);
    // 发给页面的那一层(就绪索引):带着「这是依赖下层的流」和这一版项目的输入签名;单卡流的层什么都不多带
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

    // 对不上的:分段越界、结果键是别的指纹的、种类和任务说的不一样
    const mut = (fn) => { const copy = view(task); fn(copy); return copy; };
    const cardTask = streamTasksOf(ctx).find((x) => x.input.clipId === 'clip-a');
    const cases = [
      ['分段越界', mut((x) => { x.range = { unit: 'segment', from: 2, to: 9 }; })],
      ['结果键是别的指纹的', mut((x) => { x.resultKey = resultKeyOf(x.input.contentKey, 'aaaaaaaaaaaaaaaa'); })],
      ['任务不要下层、这一版的流是依赖下层的', mut((x) => { x.requires.belowDependent = false; })],
      ['任务要下层、这一版的流是单卡流', (() => { const copy = view(cardTask); copy.requires.belowDependent = true; return copy; })()],
    ];
    const mark = streamBakes.length;
    for (const [what, bad] of cases) {
      const err = await executor.render(bad, { signal: signalNone(), progress: () => {} }).then(() => null, (e) => e);
      assert.equal(err?.code, 'plan-mismatch', `${what}:${err?.code} ${err?.message}`);
      assert.equal(err?.retryable, false);
    }
    assert.equal(streamBakes.length, mark, '对不上的不截图');
    // 单卡流的任务照旧产得出来(这种流没有影响到它)
    await executor.render(view(cardTask), { signal: signalNone(), progress: () => {} });
    assert.ok(streamBakes.length > mark);
    return task;
  });
});

test('BLQ-foreign 别的节点(开着)切出来的这种任务,到了关着的节点:对不上这一版的流,不可重试,不截图', { timeout: 60_000 }, async (t) => {
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
    assert.match(err.message, /依赖下层的流/);
    assert.equal(streamBakes.length, mark);
  });
});
