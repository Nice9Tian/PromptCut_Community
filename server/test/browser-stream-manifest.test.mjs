/**
 * 浏览器节点产的轨道流:清单形状与桌面逐字段同形,桌面拉得回去、采纳得了(`docs/plan/browser-stream-task.md` 第四处)。
 *
 *   BM-01  清单形状:`streamManifest`(`src/online/browserNode.ts`)与桌面 `collectStreamResult` 逐字段同形;过 `manifestMatches`、`streamAdoption`
 *   BM-02  桌面拉回去:`applyResult` 按浏览器的清单从素材服务拉块,经 `adoptSegments` 落进流库;编码器名 `webcodecs-avc`、`sig: null` 都认;
 *          落盘的字节与浏览器推的逐字节相同;再拉一次全部跳过
 *   BM-03  字节层面:浏览器封的开头文件与分段,服务端的 `initInfo` / `segmentInfo` 读得出清单里写的那几项
 *
 * 跑:node --experimental-test-module-mocks --test server/test/browser-stream-manifest.test.mjs
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAssetHarness } from './fake-asset-service.mjs';

const refuse = (name) => () => { throw new Error(`单测不渲染(${name})`); };
mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: { openBakery: async () => refuse('openBakery')(), findFfmpeg: async () => refuse('findFfmpeg')(), streamPngVideo: refuse('streamPngVideo'), bakeFrames: async () => refuse('bakeFrames')() },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { initInfo, segmentInfo, streamAdoption } = await import('../frame-stream.mjs');
const { collectStreamResult, manifestMatches, manifestKeyOf, manifestKindOf, applyResult, pushResult, RESULT_VERSION, PX_NS } = await import('../artifact-transfer.mjs');
const { createAssetClient } = await import('../asset-store/client.mjs');
const { resultKeyOf } = await import('../render-node/fingerprint.mjs');
const F = await import('./fake-artifact-fixtures.mjs');
const { streamManifest, streamManifestCovers, streamManifestBlocks, streamTaskFrames, BROWSER_STREAM_ENCODER, STREAM_SEGMENT_FRAMES,
  alphaBoxOf, mergeStreamManifest, streamTaskStride, isSparseStreamTask } = await import('../../src/online/browserNode.ts');
const { mergeStreamResult } = await import('../artifact-transfer.mjs');
const { rgbaAlphaBox } = await import('../bakery/capture-canvas.mjs');
const { buildStreamInit, buildStreamSegment, codecOfAvcC } = await import('../../src/render/streamMux.ts');
const { packedSize } = await import('../../src/render/streamEncode.ts');

const harness = createAssetHarness();
after(() => harness.cleanup());

const BROWSER_FP = '2222222222222222';
const CONTENT_KEY = F.sha256('browser-stream-content');
const RESULT_KEY = resultKeyOf(CONTENT_KEY, BROWSER_FP);
const BOUND = { x: -32, y: -32, w: 464, h: 304 };
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x03, 0x68, 0xee, 0x3c]);
const sample = (n, fill) => { const d = new Uint8Array(n); d.fill(fill); new DataView(d.buffer).setUint32(0, n - 4); return d; };

/** 切分方给浏览器的那一份流任务(`split.mjs` 的形状) */
function browserTask({ from = 3, to = 5, total = 300, lastFrame = 164 } = {}) {
  return {
    id: `stream:${RESULT_KEY}:${from}-${to}`, kind: 'stream', resultKey: RESULT_KEY, range: { unit: 'segment', from, to },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: 'plan:p1@1#clips:x' },
    input: { clipId: 'clip-a', cardId: 'punch-pill', entryKey: null, contentKey: CONTENT_KEY, canvasHeavy: false, compositing: 'independent',
      bake: { start: 1.5, end: 5.5, count: 120, sampling: { firstFrame: 45, phase: { numerator: 0, denominator: 1 } } },
      // 片段是第 45～164 帧:分段从第 45 帧起数(0～7),任务范围 3～5 是第 90～134 帧
      stream: { kind: 'card', plane: 'local', clipIds: ['clip-a'], fps: 30, bound: BOUND, offset: { x: 760, y: 420 }, firstFrame: 45, count: 120, total, originFrame: 45, lastFrame } },
    weight: { class: 'medium', estMs: null, frames: (to - from + 1) * 15 },
    requires: { envFingerprint: BROWSER_FP, codeVersion: 'c', cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false, capabilities: { streams: true } },
    priority: 10,
  };
}

/** 照宿主 `bakeStream` 的做法:封开头文件与每个分段、算哈希、登记(这里不压真的画面,样本是填充字节) */
function browserParts(task) {
  const plan = streamTaskFrames(task);
  const size = packedSize(BOUND.w, BOUND.h);
  const init = Buffer.from(buildStreamInit({ width: size.width, height: size.height, fps: 30, avcC: AVCC }));
  const initHash = F.sha256(init);
  const initId = initHash.slice(0, 16);
  const blobs = new Map([[initHash, init]]);
  const inits = { [initId]: { hash: initHash, bytes: init.length, codec: codecOfAvcC(AVCC), width: size.width, height: size.height, timescale: 30, rect: { ...BOUND }, encoder: BROWSER_STREAM_ENCODER } };
  const segments = {};
  for (const seg of plan.segments) {
    const samples = seg.frames.map((_, i) => ({ data: sample(40 + seg.index + i, seg.index), isSync: i === 0 }));
    const bytes = Buffer.from(buildStreamSegment({ sequence: seg.index + 1, baseDecodeTime: seg.index * STREAM_SEGMENT_FRAMES, samples }));
    const hash = F.sha256(bytes);
    blobs.set(hash, bytes);
    segments[seg.index] = { hash, bytes: bytes.length, init: initId, stride: 1, samples: samples.length, sig: null, encoder: BROWSER_STREAM_ENCODER };
  }
  return { inits, segments, blobs, init, initId };
}

/** 一个值的形状:对象记键(升序)与各键的形状,其余只记「是不是 null」之外的类型 */
function shapeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return ['array', v.length ? shapeOf(v[0]) : 'empty'];
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, shapeOf(v[k])]));
  return typeof v;
}
const keysOf = v => Object.keys(v).sort();

test('BM-01 清单形状与桌面 collectStreamResult 逐字段同形;过 manifestMatches 与 streamAdoption', async (t) => {
  const roots = F.makeRoots(FramePipeline, 'pc-bstream-');
  t.after(() => roots.cleanup());
  // 桌面那一份:流库里写一条流(夹具),照任务范围列清单
  const rootA = await roots.root();
  const A = roots.make(rootA, { interactive: true });
  const deskKey = F.sha256('desk-stream');
  await F.writeStreamFixture(rootA, { streamKey: deskKey, segments: [3, 4, 5], lastFrame: 164 });
  const desk = (await collectStreamResult(A, F.streamTask({ streamKey: deskKey, contentKey: 'x', from: 3, to: 5 }))).result;

  const task = browserTask();
  const parts = browserParts(task);
  const mine = streamManifest(task, parts);

  // 顶层、header、每个开头文件、每个分段:键一个不多、一个不少
  assert.deepEqual(keysOf(mine), keysOf(desk), '顶层的键');
  assert.deepEqual(keysOf(mine.header), keysOf(desk.header), 'header 的键');
  assert.deepEqual(keysOf(Object.values(mine.inits)[0]), keysOf(Object.values(desk.inits)[0]), '开头文件登记的键');
  assert.deepEqual(keysOf(mine.segments[3]), keysOf(desk.segments[3]), '分段登记的键');
  assert.deepEqual(keysOf(mine.segments), keysOf(desk.segments), '分段号');
  // 各字段的类型也相同;只有两处桌面有值、浏览器按任务书写 null:header.tight(浏览器不收紧)、segments[].sig(浏览器不算分段签名)
  const a = shapeOf(mine), b = shapeOf(desk);
  assert.equal(a.header.tight, 'null');
  assert.equal(a.segments[3].sig, 'null');
  a.header.tight = b.header.tight;
  for (const n of Object.keys(a.segments)) a.segments[n].sig = b.segments[n].sig;
  // 开头文件的键是哈希前 16 位,两边不同名:按值比
  assert.deepEqual({ ...a, inits: Object.values(a.inits) }, { ...b, inits: Object.values(b.inits) });

  // 值:照任务书第四处
  assert.equal(mine.v, RESULT_VERSION);
  assert.deepEqual(mine.header, { kind: 'card', plane: 'local', clipIds: ['clip-a'], fps: 30, originFrame: 45, lastFrame: 164, bound: BOUND, offset: { x: 760, y: 420 }, tight: null });
  // 清单不带这条流的第一帧(改分段规则之前的节点产的):两边都不认
  const { originFrame: _dropped, ...oldHeader } = mine.header;
  assert.equal(manifestMatches({ ...mine, header: oldHeader }, { kind: 'stream', resultKey: RESULT_KEY, range: { from: 3, to: 5 } }), false);
  assert.throws(() => streamAdoption({ ...mine, header: oldHeader }), /originFrame/);
  assert.equal(streamManifestCovers({ ...mine, header: oldHeader }, task), false);
  const [initId] = Object.keys(mine.inits);
  assert.equal(initId, mine.inits[initId].hash.slice(0, 16), '开头文件的键 = 哈希前 16 位');
  assert.equal(mine.inits[initId].encoder, 'webcodecs-avc');
  assert.deepEqual(mine.inits[initId].rect, BOUND, '矩形固定用 bound');
  for (const n of [3, 4, 5]) assert.deepEqual({ ...mine.segments[n], hash: 'h', bytes: 0 }, { hash: 'h', bytes: 0, init: initId, stride: 1, samples: 15, sig: null, encoder: 'webcodecs-avc' });

  const ref = { kind: 'stream', resultKey: RESULT_KEY, range: { from: 3, to: 5 } };
  assert.equal(manifestMatches(mine, ref), true, '桌面的 manifestMatches 认它');
  assert.equal(manifestMatches(mine, { ...ref, range: { from: 3, to: 6 } }), false);
  assert.equal(manifestKeyOf(mine), `${RESULT_KEY}:3-5`, '内容库的键 <结果键>:<起>-<止>');
  assert.equal(manifestKindOf(mine.kind), 'render-manifest');
  const adoption = streamAdoption(mine);
  assert.deepEqual(adoption.segments.map(([n]) => n), [3, 4, 5]);
  assert.equal(adoption.key, RESULT_KEY);

  // 去重判据与要查的块
  assert.equal(streamManifestCovers(mine, task), true);
  assert.equal(streamManifestCovers(mine, browserTask({ from: 3, to: 6 })), false, '范围不同');
  assert.equal(streamManifestCovers({ ...mine, segments: { 3: mine.segments[3], 4: mine.segments[4] } }, task), false, '缺一个分段');
  assert.equal(streamManifestCovers({ ...mine, inits: {} }, task), false, '缺开头文件');
  assert.equal(streamManifestCovers(desk, { resultKey: deskKey, range: { from: 3, to: 5 } }), true, '桌面产的清单同样认(去重不分谁产的)');
  assert.deepEqual(streamManifestBlocks(mine).map(x => x.ns), ['px', 'px', 'px', 'px'], '开头文件与三个分段都在像素那一类');

  // 只列任务范围里的;让路后只推了一部分时,缺的不列(不编造)
  const partial = streamManifest(task, { inits: parts.inits, segments: { 3: parts.segments[3], 9: parts.segments[4] } });
  assert.deepEqual(Object.keys(partial.segments), ['3']);
  assert.equal(streamManifestCovers(partial, task), false);
  assert.throws(() => streamManifest({ ...task, input: { ...task.input, stream: undefined } }, parts), /input\.stream/);
});

test('BM-02 桌面把浏览器产的流拉回去并采纳:applyResult → adoptSegments,字节逐字节相同;再拉一次全部跳过', async (t) => {
  const roots = F.makeRoots(FramePipeline, 'pc-bstream-');
  t.after(() => roots.cleanup());
  const svc = await F.startServices(harness, base => createAssetClient({ base }));
  t.after(() => svc.cleanup());
  const task = browserTask();
  const parts = browserParts(task);
  const manifest = streamManifest(task, parts);
  // 浏览器那一侧:块推到素材服务的像素那一类(页面用上传器;这里用同一份清单走服务端的 pushResult,推的是同样的块)
  const pushed = await pushResult(svc.client, manifest, async hash => parts.blobs.get(hash));
  assert.equal(pushed.uploaded, 4);
  for (const { ns, hash } of streamManifestBlocks(manifest)) assert.equal(await svc.client.has(ns, hash), true, `${ns}/${hash.slice(0, 8)} 在素材服务上`);
  assert.equal(PX_NS, 'px');

  // 桌面那一侧:收到 task.done 带的清单,拉取并采纳
  const rootB = await roots.root();
  const B = roots.make(rootB, { interactive: true });
  const producer = F.producerOf(B, 'libx264');   // 桌面自己的编码器是另一个名字:拉来的分段不按它重算签名
  const applied = await applyResult(B, svc.client, { ...manifest });
  assert.deepEqual({ written: applied.written, skipped: applied.skipped, fetched: applied.fetched }, { written: 3, skipped: 0, fetched: 4 });

  const dir = path.join(rootB, 'streams', RESULT_KEY);
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'stream.json'), 'utf8'));
  assert.equal(onDisk.streamKey, RESULT_KEY);
  assert.deepEqual([onDisk.kind, onDisk.plane, onDisk.clipIds, onDisk.fps, onDisk.bound], ['card', 'local', ['clip-a'], 30, BOUND]);
  assert.equal(onDisk.inits[parts.initId].encoder, 'webcodecs-avc');
  assert.equal(onDisk.inits[parts.initId].adopted, true);
  assert.ok((await fs.readFile(path.join(dir, `init-${parts.initId}.mp4`))).equals(parts.init), '开头文件逐字节相同');
  for (const n of [3, 4, 5]) {
    const seg = onDisk.segments[n];
    assert.deepEqual([seg.adopted, seg.stride, seg.samples, seg.sig, seg.encoder, seg.init], [true, 1, 15, null, 'webcodecs-avc', parts.initId], `分段 ${n} 的登记`);
    assert.ok((await fs.readFile(path.join(dir, seg.file))).equals(parts.blobs.get(parts.segments[n].hash)), `分段 ${n} 逐字节相同`);
  }
  // 采纳之后是「满密度、不旧」:桌面不会把它判旧重产
  const state = producer.streams.get(RESULT_KEY);
  assert.ok(state, '生产者手里有这条流');
  for (const n of [3, 4, 5]) assert.equal(producer.segmentState(state, n), 'dense', `分段 ${n}`);
  assert.deepEqual(F.staged(B, 'stream', RESULT_KEY)?.ranges, [[3, 5]], '就绪索引按键挂上了这一段');
  // 桌面再把它列成清单(往外推、去重用):哈希与浏览器的清单相同,编码器名带着
  const again = (await collectStreamResult(B, task)).result;
  assert.deepEqual(Object.fromEntries(Object.entries(again.segments).map(([n, s]) => [n, [s.hash, s.encoder, s.stride, s.samples]])),
    Object.fromEntries(Object.entries(manifest.segments).map(([n, s]) => [n, [s.hash, s.encoder, s.stride, s.samples]])));
  assert.equal(again.inits[parts.initId].hash, manifest.inits[parts.initId].hash);
  // 再拉一次:本机已有,全部跳过,不下载
  const second = await applyResult(B, svc.client, { ...manifest });
  assert.deepEqual({ written: second.written, skipped: second.skipped, fetched: second.fetched }, { written: 0, skipped: 3, fetched: 0 });
});

test('BM-03 浏览器封的字节,服务端读得出清单里写的那几项(编码串、拼合后的宽高、时间刻度、每段样本数与段首关键帧)', () => {
  // 这条流的最后一帧是第 154 帧:第 7 段(第 150 帧起)不满,只有第 150～154 帧共 5 帧
  const task = browserTask({ from: 7, to: 7, lastFrame: 154 });
  const parts = browserParts(task);
  const meta = parts.inits[parts.initId];
  const info = initInfo(parts.init);
  assert.deepEqual(info, { codec: meta.codec, width: meta.width, height: meta.height, timescale: meta.timescale });
  assert.deepEqual([info.width, info.height], [464, 2 * 304 + 16], '拼合后的画面:宽不变,高 = 2H + 16');
  const seg = parts.segments[7];
  assert.equal(seg.samples, 5);
  assert.deepEqual(segmentInfo(parts.blobs.get(seg.hash)), { moofs: 1, sampleCount: 5, firstSampleIsSync: true });
});

test('BM-04 稀疏流任务:每几帧截一张照任务的密度定;清单的分段带位置矩形;满密度任务不认稀疏版的清单;合并不降级,与桌面 mergeStreamResult 同一个结果', () => {
  const h = c => c.repeat(64);
  const input = { stream: { kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, bound: { x: -8, y: -8, w: 64, h: 48 }, offset: { x: 10, y: 20 }, firstFrame: 30, count: 60, total: 300, originFrame: 30, lastFrame: 89 } };
  const dense = { kind: 'stream', resultKey: h('a'), range: { unit: 'segment', from: 0, to: 3 }, input };
  const sparse = { ...dense, input: { ...input, density: 'sparse' } };
  assert.equal(isSparseStreamTask(sparse), true);
  assert.equal(isSparseStreamTask(dense), false);
  assert.equal(isSparseStreamTask({ ...sparse, kind: 'snapshot' }), false);
  assert.equal(streamTaskStride(sparse), STREAM_SEGMENT_FRAMES, '稀疏流任务:一个分段只截一张');
  assert.equal(streamTaskStride(dense), 1);

  const inits = { i1: { hash: h('1'), bytes: 10, codec: 'avc1.640020', width: 64, height: 96, timescale: 30, rect: { x: -8, y: -8, w: 64, h: 48 }, encoder: BROWSER_STREAM_ENCODER } };
  const seg = (c, stride, box) => ({ hash: h(c), bytes: 5, init: 'i1', stride, samples: 15, sig: null, encoder: BROWSER_STREAM_ENCODER, ...(box !== undefined ? { box } : {}) });
  const sparseParts = { inits, segments: { 0: seg('b', 15, { x: 2, y: 3, w: 20, h: 10 }), 1: seg('c', 15, null), 2: seg('d', 15, { x: 0, y: 0, w: 4, h: 4 }), 3: seg('e', 15) } };
  const sparseManifest = streamManifest(sparse, sparseParts);
  assert.deepEqual(sparseManifest.segments[0].box, { x: 2, y: 3, w: 20, h: 10 }, '位置矩形进清单(平面坐标)');
  assert.equal(sparseManifest.segments[1].box, null, '全透明的那一张记 null');
  assert.equal('box' in sparseManifest.segments[3], false, '没量过的不带这一项');
  assert.equal(sparseManifest.segments[0].stride, 15);
  // 稀疏版的清单:稀疏流任务认,满密度任务不认
  assert.equal(streamManifestCovers(sparseManifest, sparse), true);
  assert.equal(streamManifestCovers(sparseManifest, dense), true, '不要求密度时照旧只看分段在不在');
  assert.equal(streamManifestCovers(sparseManifest, dense, { dense: true }), false);

  const denseParts = { inits, segments: { 0: seg('f', 1), 1: seg('0', 1), 2: seg('2', 1), 3: seg('3', 1) } };
  const denseManifest = streamManifest(dense, denseParts);
  assert.equal(streamManifestCovers(denseManifest, dense, { dense: true }), true);
  // 合并:已有满密度、新的稀疏 → 留已有的;已有稀疏、新的满密度 → 用新的;新清单里没有的分段留着
  assert.deepEqual(mergeStreamManifest(denseManifest, sparseManifest).segments, denseManifest.segments);
  // 已有稀疏、新的满密度:用新的分段,稀疏的一趟量的位置矩形带过来(没量过的那一段不带)
  const upgraded = mergeStreamManifest(sparseManifest, denseManifest);
  assert.deepEqual(Object.values(upgraded.segments).map((x) => [x.hash, x.stride]), Object.values(denseManifest.segments).map((x) => [x.hash, x.stride]));
  assert.deepEqual([upgraded.segments[0].box, upgraded.segments[1].box, 'box' in upgraded.segments[3]], [{ x: 2, y: 3, w: 20, h: 10 }, null, false]);
  assert.deepEqual(mergeStreamResult(sparseManifest, denseManifest), upgraded);
  assert.equal(mergeStreamManifest(denseManifest, denseManifest), denseManifest, '没有可留的:原样回新的');
  const partial = { ...denseManifest, segments: { 1: denseManifest.segments[1] } };
  const up = mergeStreamManifest(sparseManifest, partial);
  assert.deepEqual(Object.keys(up.segments).sort(), ['0', '1', '2', '3']);
  assert.deepEqual([up.segments[0].stride, up.segments[1].stride, up.segments[2].stride], [15, 1, 15]);
  assert.deepEqual(up.segments[0].box, { x: 2, y: 3, w: 20, h: 10 });
  assert.equal(mergeStreamManifest({ ...denseManifest, resultKey: h('z') }, sparseManifest), sparseManifest);
  assert.equal(mergeStreamManifest(null, sparseManifest), sparseManifest);
  // 与桌面的合并同一个结果
  assert.deepEqual(mergeStreamResult(denseManifest, sparseManifest), mergeStreamManifest(denseManifest, sparseManifest));
  assert.deepEqual(mergeStreamResult(sparseManifest, partial), up);
});

test('BM-05 位置矩形的量法:不透明像素(alpha > 0)的外接框,全透明回 null;与桌面 rgbaAlphaBox 量出来的相同', () => {
  const W = 9, H = 7;
  const blank = () => new Uint8ClampedArray(W * H * 4);
  const dot = (data, x, y, a = 255) => { data[(y * W + x) * 4 + 3] = a; };
  assert.equal(alphaBoxOf(blank(), W, H), null);
  const one = blank(); dot(one, 4, 3, 1);
  assert.deepEqual(alphaBoxOf(one, W, H), { x: 4, y: 3, w: 1, h: 1 }, 'alpha 只有 1 也算');
  const many = blank(); dot(many, 2, 1); dot(many, 7, 5, 9); dot(many, 0, 4, 200);
  assert.deepEqual(alphaBoxOf(many, W, H), { x: 0, y: 1, w: 8, h: 5 });
  const full = blank(); for (let i = 3; i < full.length; i += 4) full[i] = 255;
  assert.deepEqual(alphaBoxOf(full, W, H), { x: 0, y: 0, w: W, h: H });
  for (const data of [one, many]) {
    const desk = rgbaAlphaBox(Buffer.from(data.buffer), W, H);
    assert.deepEqual(alphaBoxOf(data, W, H), { x: desk.x, y: desk.y, w: desk.w, h: desk.h });
  }
});
