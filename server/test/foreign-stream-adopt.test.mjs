/**
 * 「先查,没有才产」的桌面一侧(任务书 `docs/plan/render-refactor-task.md`「甲二」):在线页面在没有切分节点时自己产的单卡流,
 * 之后上线的桌面预渲染进程不重产、把它拉回本机并照它的键用。
 *
 *   FSA-01  `relockStreams`:单卡流的内容键在锁里就照那个指纹出键;组流不换;没有锁时原样;`planStreams` 读 entry 上的锁
 *   FSA-02  `adoptForeignStreams`:层表里列着别的指纹、那个指纹的清单整条满密度 → 从素材服务拉回流库、记锁、落盘;
 *           之后本机的流计划、切分用的流、层表的候选都是那个指纹的键;生产者把它当满密度的现成流(不重产)
 *   FSA-03  不锁的情形:清单缺一份、有稀疏的分段、层表里没有同内容键的行、本机自己的键已经整条都有
 *   FSA-04  锁落盘:重启后的新管线照样照锁出键;拉回来的流不齐了(被清掉)就解锁,回到自己的键
 *   FSA-05  切分:照锁只出一份,键与指纹都是锁定方的;浏览器在线时那一份是浏览器的形状(它去重即完成),本机不出自己的那一份
 *
 * 跑:npm test -- server/test/foreign-stream-adopt.test.mjs
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
const { planStreams, relockStreams, queueStreamOf, STREAM_CODE_VERSION } = await import('../frame-stream.mjs');
const { pushResult, layerMapOf, layerMapKeyOf } = await import('../artifact-transfer.mjs');
const { createAssetClient } = await import('../asset-store/client.mjs');
const { resultKeyOf } = await import('../render-node/fingerprint.mjs');
const { splitPlan } = await import('../render-node/split.mjs');
const F = await import('./fake-artifact-fixtures.mjs');
const { streamManifest, streamTaskFrames, BROWSER_STREAM_ENCODER, STREAM_SEGMENT_FRAMES } = await import('../../src/online/browserNode.ts');
const { buildStreamInit, buildStreamSegment, codecOfAvcC } = await import('../../src/render/streamMux.ts');
const { packedSize } = await import('../../src/render/streamEncode.ts');

const harness = createAssetHarness();
after(() => harness.cleanup());

const BROWSER = '2222222222222222';
const CAPTURE = 'capture-code-for-test';
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x03, 0x68, 0xee, 0x3c]);
const sample = (n, fill) => { const d = new Uint8Array(n); d.fill(fill); new DataView(d.buffer).setUint32(0, n - 4); return d; };

const project = () => ({
  id: 'proj-foreign', width: 1280, height: 720, fps: 30, duration: 6, themeId: 'dark', style: {}, media: [], filters: [], pixelMaps: [], cardNodes: [],
  tracks: [
    { id: 't-a', clips: [{ id: 'clip-a', cardId: 'punch-pill', start: 0, end: 5, params: { text: 'a' }, frame: { x: 100, y: 100, w: 400, h: 240 } }] },
    { id: 't-b', clips: [{ id: 'clip-b', cardId: 'focus-card', start: 1, end: 3, params: {} }] },
  ],
});
const control = (own, clipId, firstFrame, count) => ({
  clipId, key: `key-${clipId}`, snapshotKey: resultKeyOf(`ck-${clipId}`, own), contentKey: `ck-${clipId}`, envFingerprint: own, tier: 'shared', cardId: 'punch-pill',
  frameMode: 'stateful', sampling: { firstFrame }, count, start: firstFrame / 30, end: (firstFrame + count) / 30, capabilities: { compositing: 'independent', frameMode: 'stateful' }, compositing: 'independent',
});
const entryOf = (pipeline) => {
  const own = pipeline.envFingerprint;
  return { key: 'entry-foreign', project: project(), cardPlan: [control(own, 'clip-a', 0, 150), control(own, 'clip-b', 30, 60)], streamLocks: pipeline.streamLocks };
};
const ownSpecs = (pipeline, entry) => planStreams({ ...entry, streamLocks: null }, { budget: Infinity, codeVersion: `${STREAM_CODE_VERSION}:${CAPTURE}`, envFingerprint: pipeline.envFingerprint });

/** 页面那一侧:照 `pageStreamTasks` 的形状出这条流的任务,封开头文件与分段、推素材服务、把清单写进内容库(假的) */
function pageProduce(spec, { stride = () => 1 } = {}) {
  const resultKey = resultKeyOf(spec.contentKey, BROWSER);
  const size = packedSize(spec.bound.w, spec.bound.h);
  const init = Buffer.from(buildStreamInit({ width: size.width, height: size.height, fps: 30, avcC: AVCC }));
  const initHash = F.sha256(init), initId = initHash.slice(0, 16);
  const blobs = new Map([[initHash, init]]);
  const manifests = [];
  for (let from = spec.firstSegment; from <= spec.lastSegment; from += 8) {
    const to = Math.min(spec.lastSegment, from + 7);
    const task = { id: `stream:${resultKey}:${from}-${to}`, kind: 'stream', resultKey, range: { unit: 'segment', from, to },
      input: { clipId: spec.topClipId, contentKey: spec.contentKey, stream: { kind: 'card', plane: 'local', clipIds: [spec.topClipId], fps: 30, bound: spec.bound, offset: spec.offset, firstFrame: spec.firstFrame, count: spec.members[0].count, total: spec.total, originFrame: spec.originFrame, lastFrame: spec.lastFrame } } };
    const plan = streamTaskFrames(task);
    const inits = { [initId]: { hash: initHash, bytes: init.length, codec: codecOfAvcC(AVCC), width: size.width, height: size.height, timescale: 30, rect: { ...spec.bound }, encoder: BROWSER_STREAM_ENCODER } };
    const segments = {};
    for (const seg of plan.segments) {
      const samples = seg.frames.map((_, i) => ({ data: sample(40 + seg.index + i, seg.index), isSync: i === 0 }));
      const bytes = Buffer.from(buildStreamSegment({ sequence: seg.index + 1, baseDecodeTime: seg.index * STREAM_SEGMENT_FRAMES, samples }));
      const hash = F.sha256(bytes);
      blobs.set(hash, bytes);
      segments[seg.index] = { hash, bytes: bytes.length, init: initId, stride: stride(seg.index), samples: samples.length, sig: null, encoder: BROWSER_STREAM_ENCODER };
    }
    manifests.push(streamManifest(task, { inits, segments }));
  }
  return { resultKey, manifests, blobs };
}

/** 假的内容库:只有 `get(kind, key)`;记下取过哪些键 */
function fakeContent() {
  const items = new Map();
  const gets = [];
  return { items, gets, put: (kind, key, body) => items.set(`${kind}\u0000${key}`, body),
    get: async (kind, key) => { gets.push(`${kind}:${key}`); const body = items.get(`${kind}\u0000${key}`); return body === undefined ? { missing: true } : { body: structuredClone(body) }; } };
}

/** 一套场景:一条真的管线、假的内容库、真的(本机的)素材服务;页面把 clip-a 的流产好、推好,层表里写了它的那一行 */
async function scene(t, { produce = true, rowFor = null, stride } = {}) {
  const roots = F.makeRoots(FramePipeline, 'pc-foreign-');
  t.after(() => roots.cleanup());
  const svc = await F.startServices(harness, base => createAssetClient({ base }));
  t.after(() => svc.cleanup());
  const root = await roots.root();
  const make = () => {
    const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: F.OWN_ENV, dataRoot: root, interactive: true, captureCode: () => CAPTURE });
    t.after(() => p.close());
    return p;
  };
  const pipeline = make();
  const producer = F.producerOf(pipeline, 'libx264');
  const entry = entryOf(pipeline);
  const specs = ownSpecs(pipeline, entry);
  const a = specs.find(s => s.topClipId === 'clip-a'), b = specs.find(s => s.topClipId === 'clip-b');
  const content = fakeContent();
  let page = null;
  if (produce) {
    page = pageProduce(a, { stride });
    for (const m of page.manifests) {
      await pushResult(svc.client, m, async hash => page.blobs.get(hash));
      content.put('render-manifest', `${m.resultKey}:${m.range.from}-${m.range.to}`, m);
    }
  }
  const row = { topClipId: 'clip-a', clipIds: ['clip-a'], kind: 'card', plane: 'local', contentKey: rowFor ?? a.contentKey,
    candidates: [{ envFingerprint: BROWSER, resultKey: resultKeyOf(rowFor ?? a.contentKey, BROWSER) }], originFrame: a.originFrame, lastSegment: a.lastSegment, segmentsPerTask: 8 };
  content.put('snapshot-manifest', layerMapKeyOf(entry.project.id), { v: 3, kind: 'layer-map', projectId: entry.project.id, layers: [], streams: [row] });
  return { pipeline, producer, entry, specs, a, b, content, client: svc.client, page, root, make };
}

test('FSA-01 relockStreams:单卡流照锁出键,组流不换,没有锁时原样;planStreams 读 entry 上的锁', () => {
  const OWN = '1111111111111111';
  const entry = { key: 'e', project: project(), cardPlan: [control(OWN, 'clip-a', 0, 150), control(OWN, 'clip-b', 30, 60)] };
  const opts = { budget: 6, codeVersion: '1:x', envFingerprint: OWN };
  const plain = planStreams(entry, opts);
  assert.equal(plain.length, 2);
  assert.equal(relockStreams(plain, null), plain, '没有锁:同一个数组');
  assert.equal(relockStreams(plain, new Map()), plain);
  const a = plain.find(s => s.topClipId === 'clip-a');
  const locks = new Map([[a.contentKey, BROWSER]]);
  const locked = planStreams({ ...entry, streamLocks: locks }, opts);
  const la = locked.find(s => s.topClipId === 'clip-a'), lb = locked.find(s => s.topClipId === 'clip-b');
  assert.equal(la.streamKey, resultKeyOf(a.contentKey, BROWSER), '流键 = 内容键 × 锁定方的指纹');
  assert.equal(la.envFingerprint, BROWSER);
  assert.equal(la.ownEnvFingerprint, OWN);
  assert.equal(la.contentKey, a.contentKey, '内容键不变');
  assert.deepEqual({ ...la, streamKey: 0, envFingerprint: 0, ownEnvFingerprint: 0 }, { ...a, streamKey: 0, envFingerprint: 0, ownEnvFingerprint: 0 }, '别的字段不变');
  assert.deepEqual(lb, plain.find(s => s.topClipId === 'clip-b'), '没锁的流不动');
  // 锁在自己的指纹上:不换
  assert.deepEqual(planStreams({ ...entry, streamLocks: new Map([[a.contentKey, OWN]]) }, opts), plain);
  // 预算压到 1:两张卡并成组流,组流不照锁换
  const grouped = planStreams({ ...entry, streamLocks: locks }, { ...opts, budget: 1 });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, 'group');
  assert.equal(grouped[0].envFingerprint, OWN);
});

test('FSA-02 层表里列着别的指纹、整条满密度:拉回流库、记锁;之后的流计划、层表、生产者都照那个键', async (t) => {
  const { pipeline, producer, entry, a, b, content, client, page, root } = await scene(t);
  const report = await pipeline.adoptForeignStreams(entry, content, client);
  assert.deepEqual({ checked: report.checked, locked: report.locked, unlocked: report.unlocked, error: report.error }, { checked: 1, locked: 1, unlocked: 0, error: null });
  assert.equal(pipeline.streamLocks.get(a.contentKey), BROWSER);
  assert.equal(pipeline.streamLocks.has(b.contentKey), false, '没人产过的那条不锁');
  // 落进了流库:清单、开头文件、每个分段,字节与页面推的相同
  const dir = path.join(root, 'streams', page.resultKey);
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'stream.json'), 'utf8'));
  assert.equal(onDisk.streamKey, page.resultKey);
  assert.deepEqual(Object.keys(onDisk.segments).map(Number).sort((x, y) => x - y), Array.from({ length: a.lastSegment - a.firstSegment + 1 }, (_, i) => a.firstSegment + i));
  for (const m of page.manifests) for (const [n, seg] of Object.entries(m.segments)) {
    assert.ok((await fs.readFile(path.join(dir, onDisk.segments[n].file))).equals(page.blobs.get(seg.hash)), `分段 ${n} 逐字节相同`);
    assert.equal(onDisk.segments[n].adopted, true);
  }
  // 本机的流计划(与生产者、与切分同一组参数)照锁出键
  const planned = planStreams(entry, { budget: 6, codeVersion: `${STREAM_CODE_VERSION}:${CAPTURE}`, envFingerprint: pipeline.envFingerprint });
  const pa = planned.find(s => s.topClipId === 'clip-a');
  assert.equal(pa.streamKey, page.resultKey);
  assert.equal(planned.find(s => s.topClipId === 'clip-b').streamKey, b.streamKey, '别的流照旧是自己的键');
  // 生产者:这条流进了这一版的计划,拉来的分段算满密度、不旧 —— 没有要产的
  await producer.update(entry);
  const state = producer.streams.get(page.resultKey);
  assert.ok(state && !state.adoptedOnly, '拉来的流进了这一版的计划');
  for (let n = a.firstSegment; n <= a.lastSegment; n++) assert.equal(producer.segmentState(state, n), 'dense', `分段 ${n}`);
  assert.equal(producer.streams.has(a.streamKey), false, '本机自己指纹的那条流不在计划里(不产)');
  assert.deepEqual(producer.claimLayers(entry.key).filter(l => l.clipId === 'clip-a'), [{ clipId: 'clip-a', kind: 'stream', key: page.resultKey, originFrame: 0 }], '发给舞台的层就是拉回来的那条(带着这条流的第一帧)');
  // 层表:这一行的候选是锁定方的指纹
  const map = layerMapOf(entry, { fingerprint: pipeline.envFingerprint, streams: planned });
  assert.deepEqual(map.streams.find(r => r.topClipId === 'clip-a').candidates, [{ envFingerprint: BROWSER, resultKey: page.resultKey }]);
  // 诊断里看得见
  assert.deepEqual(pipeline.diagnostics().foreignStreams.locks, [[a.contentKey, BROWSER]]);
  // 再查一次:已经锁着,不再读清单、不再下载
  const before = content.gets.length;
  const again = await pipeline.adoptForeignStreams(entry, content, client);
  assert.deepEqual({ checked: again.checked, locked: again.locked }, { checked: 0, locked: 0 }, '锁着的不再查;没人产过的那条没有候选');
  assert.equal(content.gets.slice(before).some(k => k.startsWith('render-manifest:')), false);
});

test('FSA-03 不锁的情形:清单缺一份、有稀疏的分段、层表里没有同内容键的行、本机自己的键已经整条都有', async (t) => {
  // 清单缺一份(页面只产了前 8 段)
  const part = await scene(t);
  part.content.items.delete(`render-manifest\u0000${part.page.manifests.at(-1).resultKey}:${part.page.manifests.at(-1).range.from}-${part.page.manifests.at(-1).range.to}`);
  assert.ok(part.page.manifests.length >= 2, '这条流不止一份清单');
  const r1 = await part.pipeline.adoptForeignStreams(part.entry, part.content, part.client);
  assert.equal(r1.locked, 0);
  assert.equal(part.pipeline.streamLocks.size, 0);
  await assert.rejects(fs.access(path.join(part.root, 'streams', part.page.resultKey)), '不整条就不拉');
  // 有稀疏的分段
  const sparse = await scene(t, { stride: n => (n === 2 ? 15 : 1) });
  assert.equal((await sparse.pipeline.adoptForeignStreams(sparse.entry, sparse.content, sparse.client)).locked, 0);
  // 层表里那一行是别的内容键(旧参数的流)
  const other = await scene(t, { rowFor: 'some-old-content-key' });
  const r3 = await other.pipeline.adoptForeignStreams(other.entry, other.content, other.client);
  assert.deepEqual({ checked: r3.checked, locked: r3.locked }, { checked: 0, locked: 0 });
  // 本机自己的键已经整条都有:不查
  const mine = await scene(t);
  const own = pageProduce(mine.a);
  await mine.producer.adoptSegments({ ...own.manifests[0], resultKey: mine.a.streamKey }, own.blobs).catch(() => {});
  for (const m of own.manifests) await mine.producer.adoptSegments({ ...m, resultKey: mine.a.streamKey }, own.blobs);
  const r4 = await mine.pipeline.adoptForeignStreams(mine.entry, mine.content, mine.client);
  assert.equal(r4.locked, 0, '自己已经有整条,不换成别人的');
  assert.equal(mine.pipeline.streamLocks.size, 0);
  // 没有内容库、没有素材服务客户端:什么都不做
  assert.deepEqual((await mine.pipeline.adoptForeignStreams(mine.entry, null, mine.client)).locked, 0);
});

test('FSA-04 锁落盘:重启后的新管线照锁出键;拉回来的流不齐了就解锁', async (t) => {
  const { pipeline, entry, a, content, client, page, root, make } = await scene(t);
  await pipeline.adoptForeignStreams(entry, content, client);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'stream-locks.json'), 'utf8')).entries, [[a.contentKey, BROWSER]]);
  const again = make();
  F.producerOf(again, 'libx264');
  assert.equal(again.streamLocks.get(a.contentKey), BROWSER, '重启后锁还在');
  const entry2 = entryOf(again);
  const planned = planStreams(entry2, { budget: 6, codeVersion: `${STREAM_CODE_VERSION}:${CAPTURE}`, envFingerprint: again.envFingerprint });
  assert.equal(planned.find(s => s.topClipId === 'clip-a').streamKey, page.resultKey);
  // 复核:流库里那条还齐,锁留着(不读内容库)
  const r = await again.adoptForeignStreams(entry2, fakeContent(), client);
  assert.equal(r.unlocked, 0);
  assert.equal(again.streamLocks.get(a.contentKey), BROWSER);
  // 流库里那条被清掉了:解锁,回到自己的键
  const fresh = make();
  F.producerOf(fresh, 'libx264');
  await fs.rm(path.join(root, 'streams', page.resultKey), { recursive: true, force: true });
  const entry3 = entryOf(fresh);
  const r2 = await fresh.adoptForeignStreams(entry3, fakeContent(), client);
  assert.equal(r2.unlocked, 1);
  assert.equal(fresh.streamLocks.size, 0);
  assert.equal(planStreams(entry3, { budget: 6, codeVersion: `${STREAM_CODE_VERSION}:${CAPTURE}`, envFingerprint: fresh.envFingerprint }).find(s => s.topClipId === 'clip-a').streamKey, a.streamKey);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'stream-locks.json'), 'utf8')).entries, []);
});

test('FSA-05 切分:照锁只出一份,键与指纹都是锁定方的;浏览器在线时是浏览器的形状,本机不出自己的那一份', async (t) => {
  const { pipeline, entry, a, b, content, client, page } = await scene(t);
  await pipeline.adoptForeignStreams(entry, content, client);
  const own = pipeline.envFingerprint;
  const streams = planStreams(entry, { budget: 6, codeVersion: `${STREAM_CODE_VERSION}:${CAPTURE}`, envFingerprint: own }).map(queueStreamOf);
  const cardLocks = new Map([...pipeline.streamLocks].map(([k, fp]) => [`stream:${k}`, fp]));
  const base = { planTask: { id: 'plan:p@1', source: { projectId: 'p', projectRev: 1 } }, entryKey: entry.key, cardPlan: entry.cardPlan, prerenderSet: new Set(['clip-a', 'clip-b']), streams,
    envFingerprint: own, codeVersion: 'cv', weightOf: () => ({ class: 'medium', estMs: null }), cardLocks };
  const tasksOf = (extra) => splitPlan({ ...base, ...extra }).filter(x => x.kind === 'stream');
  // 浏览器(锁定方)在线
  const online = tasksOf({ browserFingerprints: [BROWSER] });
  const forA = online.filter(x => x.input.clipId === 'clip-a');
  assert.ok(forA.length >= 1);
  assert.ok(forA.every(x => x.resultKey === page.resultKey && x.requires.envFingerprint === BROWSER && x.requires.transcode === false && x.input.stream && !('dual' in x.input)),
    '只有锁定方的那一份,浏览器的形状,不成对');
  assert.equal(online.some(x => x.input.clipId === 'clip-a' && x.requires.envFingerprint === own), false, '本机不出自己的那一份');
  // 没锁的那条照旧成对(自己的、浏览器的)
  const forB = online.filter(x => x.input.clipId === 'clip-b');
  assert.deepEqual([...new Set(forB.map(x => x.requires.envFingerprint))].sort(), [BROWSER, own].sort());
  assert.ok(forB.every(x => x.input.dual === true));
  assert.ok(forB.some(x => x.resultKey === b.streamKey));
  // 浏览器不在线:照锁出一份(指纹仍是锁定方的,本机认领不了它,也就不重产)
  const offline = tasksOf({});
  assert.ok(offline.filter(x => x.input.clipId === 'clip-a').every(x => x.requires.envFingerprint === BROWSER && x.resultKey === page.resultKey));
  assert.equal(a.contentKey, forA[0].input.contentKey);
});
