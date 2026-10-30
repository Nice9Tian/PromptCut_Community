/**
 * 画布卡的轨道流不经过 PNG(渲染重构「己一」,`docs/plan/prerender-products-contract.md` 第 6.1、6.2、9.3 节)接到生产者上的单测。
 * 跑:`npm test -- server/test/stream-direct.test.mjs`
 *
 *   - `bakeStream` 的 `capture`:这一帧怎么取由调用方定,不调 `shoot()` 就不截图;不给 `capture` 时和原来一样每帧截图;
 *   - `StreamProducer.runSegment`(真的 `bakeStream`、真的 ffmpeg,预渲染间是假的):登记为画布卡的单卡流走直取,
 *     产出的分段和关掉直取(每帧截图)产出的**逐字节相同**;画布外面还有别的元素的卡退回截图、有诊断;
 *     没登记成画布卡的卡、组流不问画布;稀疏那一趟量出的实体框和截图那条路量的相同;
 *   - 键:`STREAM_CODE_VERSION` 是 2;`CardFrameCache.plan()` 多算一份不带生成快照的代码指纹的内容键 `streamMemberKey`,
 *     `planStreams` 的单卡流用它;取像素的两个新文件进截图代码的指纹、不进生成快照的代码指纹。
 * 需要 ffmpeg 的几条在没有 ffmpeg 的机器上跳过。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { bakeStream } from '../bakery/bake.mjs';
import { dropStreamEncoderSpares } from '../bakery/ffmpeg.mjs';
import { StreamProducer, planStreams, STREAM_CODE_VERSION, SEGMENT_FRAMES, SPARSE_STRIDE } from '../frame-stream.mjs';
import { CardFrameCache } from '../card-cache.mjs';
import { cardSnapshotIdentity, cardSampling } from '../card-identity.mjs';
import { captureCode, snapshotCode, invalidateFrameCode } from '../frame-code.mjs';
import { createReadyHub } from '../ready-index.mjs';
import { packTransparentRuns } from '../../src/render/gl/canvasGrab.ts';

const ffmpegOk = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
after(() => dropStreamEncoderSpares());

const ENV_FP = '0123456789abcdef';
const STAGE = { width: 320, height: 180 };
const control = (clipId, start, end, caps, extra = {}) => ({
  clipId, key: `K-${clipId}`, snapshotKey: `S-${clipId}`, capabilities: caps, compositing: 'independent', frameMode: caps.frameMode,
  start, end, count: Math.ceil((end - start) * 30), sampling: { firstFrame: Math.ceil(start * 30), fps: { numerator: '30', denominator: '1' }, phase: { numerator: '0', denominator: '1' } },
  ...extra,
});
const CANVAS_CAPS = { compositing: 'independent', frameMode: 'stateful', canvasHeavy: true };
const DOM_CAPS = { compositing: 'independent', frameMode: 'stateful', canvasHeavy: false };
const projectOf = (clips) => ({ ...STAGE, fps: 30, duration: 2, media: [], tracks: clips.map((c, i) => ({ id: `t${i}`, clips: [c] })) });

/** 第 `frame` 帧画布里的像素(整个舞台那么大的 straight RGBA):一个随帧移动的色块,其余全透明 */
function canvasPixels(frame) {
  const data = Buffer.alloc(STAGE.width * STAGE.height * 4);
  const x0 = 20 + frame * 3, y0 = 30 + (frame % 7);
  for (let y = y0; y < y0 + 40; y++) for (let x = x0; x < x0 + 60; x++) {
    const i = (y * STAGE.width + x) * 4;
    data[i] = (x * 5) & 255; data[i + 1] = (y * 3 + frame) & 255; data[i + 2] = 180; data[i + 3] = x % 9 === 0 ? 128 : 255;
  }
  return data;
}
/** 画布外面的一个元素:左下角一块不透明的色块(只有截图截得到) */
function withOutsideElement(data) {
  const out = Buffer.from(data);
  for (let y = 150; y < 170; y++) for (let x = 10; x < 60; x++) out.fill(255, (y * STAGE.width + x) * 4, (y * STAGE.width + x) * 4 + 4);
  return out;
}
const cropOf = (data, rect) => {
  const out = Buffer.alloc(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) data.copy(out, y * rect.w * 4, ((rect.y + y) * STAGE.width + rect.x) * 4, ((rect.y + y) * STAGE.width + rect.x + rect.w) * 4);
  return out;
};
const pngOf = (data, width, height) => { const png = new PNG({ width, height }); data.copy(png.data); return PNG.sync.write(png); };

/**
 * 假的预渲染间,配真的 `bakeStream`:记着当前帧(`__pcSetT`)和截图矩形(设备度量的 `viewport`),
 * 截图回这一帧这个矩形里的 PNG,`__pcGrabCanvas` 回画布里的像素。`outside` 为真时截图比画布多出一个元素。
 */
function fakeBakery({ outside = false } = {}) {
  const log = { grabs: [], shots: [], primes: 0 };
  let frame = 0, clip = { x: 0, y: 0, w: STAGE.width, h: STAGE.height };
  const bakery = {
    log,
    page: {
      async evaluate(fn, ...args) {
        const src = String(fn);
        if (src.includes('__pcGrabCanvas')) {
          const [clipId, rect] = args;
          log.grabs.push({ frame, clipId, rect });
          const rgba = cropOf(canvasPixels(frame), rect);
          const packed = packTransparentRuns(new Uint8ClampedArray(rgba));
          const bytes = packed ? Buffer.from(packed) : rgba;
          return { ok: true, w: rect.w, h: rect.h, packed: !!packed, b64: bytes.toString('base64'), bytes: bytes.length, readMs: 0, packMs: 0 };
        }
        if (src.includes('__pcTimeline')) return { fps: 30, ...STAGE, duration: 2 };
        if (src.includes('__pcSetT')) { frame = Math.round(args[0].sec * 30); return { raf: 0, mut: 0 }; }
        return null;
      },
      async setViewport() {},
      viewport: () => ({ ...STAGE, deviceScaleFactor: 1 }),
    },
    client: { async send(method, params) { if (method === 'Emulation.setDeviceMetricsOverride' && params.viewport) clip = { x: params.viewport.x, y: params.viewport.y, w: params.viewport.width, h: params.viewport.height }; } },
    async beginFrame(extra = {}) {
      if (extra.screenshot?.format !== 'png') return {};
      log.shots.push(frame);
      const full = outside ? withOutsideElement(canvasPixels(frame)) : canvasPixels(frame);
      return { screenshotData: pngOf(cropOf(full, clip), clip.w, clip.h).toString('base64') };
    },
    async waitNet() {},
    async reset() { bakery.page = { ...bakery.page }; },
  };
  return bakery;
}

/* ------------------------------------------------------------ bakeStream 的 capture */

test('bakeStream 的 capture:回什么 onFrame 就收到什么;不调 shoot 就不截图;primed 说下一次截图会不会先丢一张', async () => {
  const bakery = fakeBakery();
  const seen = [], primed = [];
  const opts = { streamSignature: 'S', fromFrame: 0, toFrame: 5, stride: 1, fps: 30, mountFrame: 0, clip: { x: 0, y: 0, w: 64, h: 32 } };
  const stats = await bakeStream(bakery, { ...opts,
    capture: async (frame, shoot, info) => {
      primed.push(info.primed);
      if (frame === 0 || frame === 4) return shoot();
      return { rgba: Buffer.alloc(4), width: 1, height: 1, frame };
    },
    onFrame: async (frame, shot) => { seen.push(Buffer.isBuffer(shot) ? 'png' : `raw:${shot.frame}`); } });
  assert.deepEqual(seen, ['png', 'raw:1', 'raw:2', 'raw:3', 'png', 'raw:5']);
  assert.equal(stats.captured, 6);
  // 截图只发生在调了 shoot 的两帧:第 0 帧(前面没截过,先丢一张)和第 4 帧(第 3 帧没截,也先丢一张)
  assert.deepEqual([...new Set(bakery.log.shots)], [0, 4]);
  assert.equal(bakery.log.shots.length, 4, '两帧各截两张(先丢一张)');
  assert.deepEqual(primed, [true, false, true, true, true, false], '紧挨着的上一帧截过图才不用先丢一张');
  // 不给 capture:和原来一样,每帧截图
  const plain = fakeBakery();
  const kinds = [];
  await bakeStream(plain, { ...opts, onFrame: async (_f, shot) => { kinds.push(Buffer.isBuffer(shot)); } });
  assert.deepEqual(kinds, [true, true, true, true, true, true]);
  assert.equal(plain.log.shots.length, 7, '第一帧先丢一张,之后每帧一张');
  assert.equal(plain.log.grabs.length, 0);
});

/* ------------------------------------------------------------ StreamProducer.runSegment */

async function produce({ mode, caps = CANVAS_CAPS, outside = false, stride = 1, segments = [0, 1] }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-stream-direct-'));
  const pipeline = { root, ready: createReadyHub(), prerenderPicked: () => true, captureCode: () => 'C', emptyUrl: () => 'about:blank' };
  const producer = new StreamProducer(pipeline, { env: { PROMPTCUT_STREAM_DIRECT: mode, PROMPTCUT_STREAM_PREWARM: '0' } });
  producer.attachRoute();
  producer.ffmpeg = 'ffmpeg';
  producer.encoderName = 'libx264';
  const project = projectOf([{ id: 'c', cardId: 'x', start: 0, end: 2 }]);
  const [spec] = planStreams({ key: 'E', project, cardPlan: [control('c', 0, 2, caps)] }, { envFingerprint: ENV_FP });
  const state = { spec, manifest: producer.freshManifest(spec), isolated: {}, generation: 0, entryKey: 'E', aliases: new Set(),
    reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set() };
  producer.streams.set(spec.streamKey, state);
  const bakery = fakeBakery({ outside });
  const bytes = [];
  for (const segment of segments) {
    const task = { state, segment, stride };
    assert.equal(await producer.runSegment(bakery, task), true);
    await task.job;
    const seg = state.manifest.segments[segment];
    assert.ok(seg, `分段 ${segment} 落盘了(${producer.log.map(l => l.message).join(' | ')})`);
    bytes.push(await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file)));
  }
  const status = producer.status().streams[0];
  await producer.close();
  await fs.rm(root, { recursive: true, force: true });
  return { bytes, bakery, state, status, producer, spec };
}

test('登记为画布卡的单卡流走直取:每个分段第一帧先取画布再截图,余下的帧不截图;产出和每帧截图逐字节相同', { skip: !ffmpegOk }, async () => {
  const off = await produce({ mode: 'off' });
  assert.equal(off.bakery.log.grabs.length, 0, '关掉以后不问画布');
  assert.equal(off.status.direct, null);
  const on = await produce({ mode: 'always' });
  assert.deepEqual(on.bakery.log.grabs.map(g => g.frame), Array.from({ length: 30 }, (_, i) => i), '每一帧都取了画布');
  assert.deepEqual([...new Set(on.bakery.log.shots)], [0, 15], '只有两个分段的第一帧截图(实测用)');
  assert.deepEqual(on.bakery.log.grabs[0].rect, { x: on.spec.bound.x + on.spec.offset.x, y: on.spec.bound.y + on.spec.offset.y, w: on.spec.bound.w, h: on.spec.bound.h }, '问的是截图那个矩形');
  assert.equal(on.bakery.log.grabs[0].clipId, 'c');
  assert.equal(on.bytes.length, 2);
  for (const n of [0, 1]) assert.equal(Buffer.compare(on.bytes[n], off.bytes[n]), 0, `分段 ${n}:直取和截图产出逐字节相同`);
  assert.deepEqual([on.status.direct.failed, on.status.direct.segments, on.status.direct.frames, on.status.direct.checks], [null, 2, 30, 2]);
  assert.deepEqual([on.status.direct.last.pass, on.status.direct.last.color, on.status.direct.last.alpha, on.status.direct.last.bad], [true, 0, 0, 0]);
  // 分段签名和清单里的东西不因为走了直取而不同(编码器名、矩形都一样)
  assert.deepEqual(on.state.manifest.segments[0].sig, off.state.manifest.segments[0].sig);
  assert.deepEqual(Object.keys(on.state.manifest.inits), Object.keys(off.state.manifest.inits));
});

test('缺省(always 档)与 auto 档也能产出同样的分段:走哪条路只看快慢,不改画面', { skip: !ffmpegOk }, async () => {
  const off = await produce({ mode: 'off', segments: [0] });
  const def = await produce({ mode: undefined, segments: [0] });
  assert.equal(def.producer.direct, 'always');
  assert.equal(Buffer.compare(def.bytes[0], off.bytes[0]), 0);
  assert.equal(def.status.direct.failed, null);
  assert.equal(def.status.direct.checks, 1);
  const auto = await produce({ mode: 'auto', segments: [0] });
  assert.equal(auto.producer.direct, 'auto');
  assert.equal(Buffer.compare(auto.bytes[0], off.bytes[0]), 0);
  assert.equal(auto.status.direct.failed, null);
  assert.equal(auto.status.direct.checks, 1);
});

test('画布外面还有别的元素的卡:实测比出差别,这条流退回截图、有诊断;产出和每帧截图逐字节相同', { skip: !ffmpegOk }, async () => {
  const off = await produce({ mode: 'off', outside: true });
  const on = await produce({ mode: 'always', outside: true });
  assert.deepEqual(on.bakery.log.grabs.map(g => g.frame), [0], '只在第一个分段的第一帧问过画布,之后不再问');
  assert.equal(on.status.direct.failed, 'differs');
  assert.deepEqual([on.status.direct.segments, on.status.direct.frames], [0, 0]);
  assert.ok(on.status.direct.last.bad > on.status.direct.last.badLimit);
  assert.ok(on.producer.log.some(l => /画布直取没过\(differs/.test(l.message)), '诊断里记了一条');
  for (const n of [0, 1]) assert.equal(Buffer.compare(on.bytes[n], off.bytes[n]), 0, `分段 ${n}:退回截图以后和原来的产出相同`);
});

test('没登记成画布卡的卡不问画布;稀疏那一趟直取量出的实体框和截图量的相同', { skip: !ffmpegOk }, async () => {
  const dom = await produce({ mode: 'always', caps: DOM_CAPS, segments: [0] });
  assert.equal(dom.bakery.log.grabs.length, 0);
  assert.equal(dom.status.direct, null);
  const all = [0, 1, 2, 3];
  const off = await produce({ mode: 'off', stride: SPARSE_STRIDE, segments: all });
  const on = await produce({ mode: 'always', stride: SPARSE_STRIDE, segments: all });
  assert.equal(on.bakery.log.grabs.length, all.length * (SEGMENT_FRAMES / SPARSE_STRIDE), '稀疏的分段只取分段的第一帧');
  assert.equal(SPARSE_STRIDE, SEGMENT_FRAMES);
  assert.ok(on.state.measured, '量到了实体框');
  assert.deepEqual(on.state.measured, off.state.measured);
  assert.deepEqual(on.state.manifest.tight, off.state.manifest.tight, '收紧出同一个矩形');
  assert.ok(on.state.manifest.tight && on.state.manifest.tight.w < on.spec.bound.w, '确实收紧了');
  for (const n of all) assert.equal(Buffer.compare(on.bytes[n], off.bytes[n]), 0, `稀疏分段 ${n} 逐字节相同`);
});

test('directOf:只有单卡流、成员登记为画布卡才走;组流、实测没过的、正在歇的分段不走;缺省 always 不歇', () => {
  const pipeline = { root: os.tmpdir(), ready: createReadyHub() };
  const producer = new StreamProducer(pipeline, { env: {} });
  assert.equal(producer.direct, 'always');
  const card = { spec: { kind: 'card', members: [{ capabilities: CANVAS_CAPS }] } };
  assert.ok(producer.directOf(card));
  assert.equal(producer.directOf({ spec: { kind: 'card', members: [{ capabilities: DOM_CAPS }] } }), null);
  assert.equal(producer.directOf({ spec: { kind: 'group', members: [{ capabilities: CANVAS_CAPS }, { capabilities: CANVAS_CAPS }] } }), null);
  assert.equal(producer.directOf({ spec: { kind: 'below', members: [{ capabilities: CANVAS_CAPS }] } }), null, '别的种类的流不走');
  assert.equal(producer.directOf({ spec: { kind: 'card' } }), null, '拉来的流没有成员信息');
  // 缺省 always 档:不因 cooldown 歇
  card.direct.cooldown = 2;
  assert.ok(producer.directOf(card));
  card.direct.failed = 'differs';
  assert.equal(producer.directOf(card), null);
  const off = new StreamProducer(pipeline, { env: { PROMPTCUT_STREAM_DIRECT: '0' } });
  assert.equal(off.directOf({ spec: { kind: 'card', members: [{ capabilities: CANVAS_CAPS }] } }), null);
  // 显式传 PROMPTCUT_STREAM_DIRECT: 'auto' 时保留 cooldown 退避
  const auto = new StreamProducer(pipeline, { env: { PROMPTCUT_STREAM_DIRECT: 'auto' } });
  assert.equal(auto.direct, 'auto');
  const autoCard = { spec: { kind: 'card', members: [{ capabilities: CANVAS_CAPS }] } };
  assert.ok(auto.directOf(autoCard));
  // 歇两个分段:这两次不走,第三次再试
  autoCard.direct.cooldown = 2;
  assert.equal(auto.directOf(autoCard), null);
  assert.equal(auto.directOf(autoCard), null);
  assert.ok(auto.directOf(autoCard));
  autoCard.direct.failed = 'differs';
  assert.equal(auto.directOf(autoCard), null);
  // 显式传 always 档也不歇
  const always = new StreamProducer(pipeline, { env: { PROMPTCUT_STREAM_DIRECT: 'always' } });
  const hot = { spec: { kind: 'card', members: [{ capabilities: CANVAS_CAPS }] } };
  always.directOf(hot);
  hot.direct.cooldown = 5;
  assert.ok(always.directOf(hot));
});

/* ------------------------------------------------------------ 键(契约第 9.3 节) */

test('STREAM_CODE_VERSION 是 4(2:画布直取与成员键;3:分段从流自己的第一帧起数;4:稀疏版每段只截第一帧、清单带位置矩形);单卡流的成员键用 streamMemberKey,不再跟着快照的内容键变', () => {
  assert.equal(STREAM_CODE_VERSION, 4);
  const project = projectOf([{ id: 'a', cardId: 'x', start: 0, end: 2 }]);
  const key = (ctl, budget = 6) => planStreams({ key: 'E', project, cardPlan: [ctl] }, { budget, envFingerprint: ENV_FP })[0]?.streamKey;
  const base = control('a', 0, 2, DOM_CAPS, { contentKey: 'C-with-snapshot-code', streamMemberKey: 'M-content-only' });
  assert.equal(key(base), key({ ...base, contentKey: 'C-snapshot-code-changed', snapshotKey: 'S-changed' }), '生成快照的代码变了(快照的内容键变了),流键不变');
  assert.notEqual(key(base), key({ ...base, streamMemberKey: 'M-other-params' }), '内容变了流键才变');
  // 没有 streamMemberKey 的旧形状输入:照旧退回内容键
  const legacy = control('a', 0, 2, DOM_CAPS, { contentKey: 'C1' });
  assert.notEqual(key(legacy), key({ ...legacy, contentKey: 'C2' }));
  // 代码版本进键
  const spec = (codeVersion) => planStreams({ key: 'E', project, cardPlan: [base] }, { envFingerprint: ENV_FP, codeVersion })[0].streamKey;
  assert.notEqual(spec('1:C'), spec('2:C'));
});

test('CardFrameCache.plan:streamMemberKey 是同一份内容身份去掉生成快照的代码指纹;和 contentKey 不同', () => {
  const project = { fps: 30, width: 320, height: 180, style: {}, themeId: 'dark' };
  const node = { id: 'card', adapter: 'chrome', cardId: 'demo', params: { n: 1 }, capabilities: { compositing: 'independent', need_prerendering: true, frameMode: 'stateful' }, inputs: {} };
  const graph = { definitions: [], nodes: [node], outputs: [{ nodeId: 'card', clipId: 'clip', start: 0, end: 1, opacity: 1, frame: { x: 0 } }] };
  const cache = new CardFrameCache({ root: os.tmpdir(), project, envFingerprint: ENV_FP });
  const [ctl] = cache.plan(graph);
  assert.match(ctl.streamMemberKey, /^[a-f0-9]{64}$/);
  assert.notEqual(ctl.streamMemberKey, ctl.contentKey, '内容键带着生成快照的代码指纹,成员键不带');
  const identity = (code) => cardSnapshotIdentity(node, { definition: undefined, style: {}, environment: {}, sourceVersions: {}, inputKeys: {},
    fps: 30, sampling: cardSampling(0, 30), duration: 1, stage: { width: 320, height: 180, camera3dFov: undefined }, frame: { x: 0 }, themeId: 'dark', fontFingerprint: '', snapshotCode: code });
  assert.equal(ctl.streamMemberKey, identity(''));
  assert.equal(ctl.contentKey, identity(snapshotCode()));
  // 参数变了成员键跟着变
  const [other] = cache.plan({ ...graph, nodes: [{ ...node, params: { n: 2 } }] });
  assert.notEqual(other.streamMemberKey, ctl.streamMemberKey);
});

test('取像素的两个新文件进截图代码的指纹(流的 codeVersion),不进生成快照的代码指纹', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-frame-code-'));
  try {
    const files = ['server/bakery/capture-canvas.mjs', 'src/render/gl/canvasGrab.ts'];
    for (const file of files) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), 'a'); }
    const capture0 = captureCode(root), snapshot0 = snapshotCode(root);
    for (const file of files) {
      fsSync.writeFileSync(path.join(root, file), 'b');
      invalidateFrameCode(root);
      assert.notEqual(captureCode(root), capture0, `${file} 改了,流的代码指纹跟着变`);
      assert.equal(snapshotCode(root), snapshot0, `${file} 改了,生成快照的代码指纹不变`);
      fsSync.writeFileSync(path.join(root, file), 'a');
      invalidateFrameCode(root);
      assert.equal(captureCode(root), capture0);
    }
  } finally { invalidateFrameCode(root); await fs.rm(root, { recursive: true, force: true }); }
});
