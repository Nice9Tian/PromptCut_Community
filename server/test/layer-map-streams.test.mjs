/**
 * 层表的 `streams` 表(`server/artifact-transfer.mjs` 的 `layerMapOf` / `layerStreamsOf` / `splitStreamCandidatesOf`;
 * `docs/plan/browser-stream-task.md` 第五处):每条轨道流一行,在线页面按它找流清单。
 * 跑:node --test server/test/layer-map-streams.test.mjs
 */
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { layerMapOf, layerStreamsOf, splitCandidatesOf, splitStreamCandidatesOf, streamCandidateKey, STREAM_CANDIDATE_PREFIX, LAYER_MAP_VERSION } from '../artifact-transfer.mjs';
import { resultKeyOf, describeEnvironment } from '../render-node/fingerprint.mjs';
import { planStreams, queueStreamOf, STREAM_CODE_VERSION } from '../frame-stream.mjs';
import { FramePipeline } from '../frame-pipeline.mjs';
import { splitPlan } from '../render-node/split.mjs';
import { createPrerenderExecutor } from '../prerender-executor.mjs';
import { clipsPlan } from './m7-kit.mjs';
import { QUEUE_DEFAULTS } from '../render-queue/constants.mjs';
import { streamInputSig } from '../../src/render/streamInputSig.mjs';

const OWN = 'fp-own-00000001';
const BROWSER = 'fp-browser-0002';

const project = () => ({
  id: 'proj-streams', width: 1920, height: 1080, fps: 30, duration: 6, themeId: 'dark', style: {}, media: [], filters: [], pixelMaps: [], cardNodes: [],
  tracks: [
    { id: 't-a', clips: [{ id: 'clip-a', cardId: 'punch-pill', start: 0, end: 2, params: { text: 'a' }, frame: { x: 100, y: 100, w: 640, h: 360 } }] },
    { id: 't-b', clips: [{ id: 'clip-b', cardId: 'particles', start: 1, end: 5, params: { seed: 3 } }] },
  ],
});
const control = (clipId, firstFrame, count, extra = {}) => ({
  clipId, key: `key-${clipId}`, snapshotKey: resultKeyOf(`ck-${clipId}`, OWN), contentKey: `ck-${clipId}`, envFingerprint: OWN, tier: 'shared',
  sampling: { firstFrame }, count, capabilities: { compositing: 'independent' }, ...extra,
});
const entryOf = (p = project()) => ({ key: 'entry-1', project: p, cardPlan: [control('clip-a', 0, 60), control('clip-b', 30, 120)] });
const specsOf = (entry, budget = 6) => planStreams(entry, { budget, codeVersion: '1:test', envFingerprint: OWN });

test('With no streams: the layer table has no streams, character for character identical to before', () => {
  const entry = entryOf();
  const before = layerMapOf(entry, { fingerprint: OWN, now: 1 });
  assert.equal('streams' in before, false);
  assert.equal(before.v, LAYER_MAP_VERSION, 'The version number is not bumped');
  assert.deepEqual(layerMapOf(entry, { fingerprint: OWN, now: 1, streams: [] }), before, 'Not carried even when given an empty stream table');
  assert.deepEqual(layerMapOf(entry, { fingerprint: OWN, now: 1, streams: null, streamCandidatesOf: () => [BROWSER] }), before);
});

test('Single-card streams: one row per stream, all fields present; the layers half is unaffected', () => {
  const entry = entryOf();
  const specs = specsOf(entry);
  assert.equal(specs.length, 2, 'planStreams produces two single-card streams');
  const map = layerMapOf(entry, { fingerprint: OWN, now: 1, streams: specs });
  assert.deepEqual(map.layers, layerMapOf(entry, { fingerprint: OWN, now: 1 }).layers);
  assert.equal(map.v, LAYER_MAP_VERSION);
  assert.equal(map.streams.length, 2);
  for (const spec of specs) {
    const row = map.streams.find((r) => r.topClipId === spec.topClipId);
    assert.ok(row, `There is a row for ${spec.topClipId}`);
    assert.deepEqual(row.clipIds, spec.clipIds);
    assert.equal(row.kind, 'card');
    assert.equal(row.plane, 'local');
    assert.equal(row.contentKey, spec.contentKey);
    assert.deepEqual(row.candidates, [{ envFingerprint: OWN, resultKey: spec.streamKey }], 'The only candidate is its own, and the result key is the stream key');
    // 行里带这条流自己的第一帧,不写 firstSegment(恒为 0;改分段规则之前的页面认它,不写它旧页面就跳过这一行)
    assert.equal(row.originFrame, spec.originFrame);
    assert.equal('firstSegment' in row, false);
    assert.equal(spec.firstSegment, 0);
    assert.equal(row.lastSegment, spec.lastSegment);
    assert.equal(row.segmentsPerTask, QUEUE_DEFAULTS.STREAM_SEGMENTS);
    assert.equal(row.inputSig, streamInputSig(entry.project, { clipIds: spec.clipIds, kind: 'card' }));
    assert.match(row.inputSig, /^s1-[0-9a-f]{16}$/);
  }
  // clip-b 从第 30 帧起:它的第一帧是 30,分段从那里起数
  assert.equal(map.streams.find((r) => r.topClipId === 'clip-b').originFrame, 30);
});

test('Group stream: when the decoder budget is squeezed to 1, two cards merge into one stream, and the row carries all members and is attached to the topmost card', () => {
  const entry = entryOf();
  const specs = specsOf(entry, 1);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].kind, 'group');
  const [row] = layerStreamsOf(entry, { streams: specs, fingerprint: OWN });
  assert.equal(row.kind, 'group');
  assert.equal(row.plane, 'stage');
  assert.deepEqual(row.clipIds, specs[0].clipIds);
  assert.equal(row.topClipId, specs[0].clipIds[specs[0].clipIds.length - 1]);
  assert.deepEqual(row.candidates, [{ envFingerprint: OWN, resultKey: specs[0].streamKey }]);
  assert.equal(row.inputSig, streamInputSig(entry.project, { clipIds: specs[0].clipIds, kind: 'group' }));
});

test('Candidates: the fingerprints the splitter actually issued keys for come first (in publish order), then its own is added; result key = content key × fingerprint', () => {
  const entry = entryOf();
  const [spec] = specsOf(entry);
  const row = (candidatesOf) => layerStreamsOf(entry, { streams: [spec], fingerprint: OWN, candidatesOf })[0];
  // 切分给浏览器另出了一份:切分方自己的在前
  assert.deepEqual(row(() => [OWN, BROWSER]).candidates, [
    { envFingerprint: OWN, resultKey: resultKeyOf(spec.contentKey, OWN) },
    { envFingerprint: BROWSER, resultKey: resultKeyOf(spec.contentKey, BROWSER) },
  ]);
  // 锁在浏览器指纹上(只出了浏览器那一份):它在前,自己的补在最后
  assert.deepEqual(row(() => [BROWSER]).candidates.map((c) => c.envFingerprint), [BROWSER, OWN]);
  // 没记过、回空、抛错:只有自己一个
  for (const fn of [() => null, () => [], () => { throw new Error('x'); }]) assert.deepEqual(row(fn).candidates.map((c) => c.envFingerprint), [OWN]);
  // 重复的、不是字符串的去掉
  assert.deepEqual(row(() => [BROWSER, BROWSER, '', 7, OWN]).candidates.map((c) => c.envFingerprint), [BROWSER, OWN]);
  // 经 layerMapOf 进来的是 streamCandidatesOf,不是快照层的 candidatesOf
  const map = layerMapOf(entry, { fingerprint: OWN, streams: [spec], candidatesOf: () => ['fp-snap-only'], streamCandidatesOf: () => [OWN, BROWSER] });
  assert.deepEqual(map.streams[0].candidates.map((c) => c.envFingerprint), [OWN, BROWSER]);
});

test('Segments per manifest: defaults to the queue constant and the caller can supply it; streams with the wrong shape are skipped without throwing', () => {
  const entry = entryOf();
  const [spec] = specsOf(entry);
  assert.equal(layerStreamsOf(entry, { streams: [spec], fingerprint: OWN, segmentsPerTask: 4 })[0].segmentsPerTask, 4);
  assert.equal(layerStreamsOf(entry, { streams: [spec], fingerprint: OWN, segmentsPerTask: 0 })[0].segmentsPerTask, QUEUE_DEFAULTS.STREAM_SEGMENTS);
  const bad = [
    null, {}, { ...spec, contentKey: '' }, { ...spec, clipIds: [] }, { ...spec, clipIds: ['a', 7] }, { ...spec, kind: 'video' }, { ...spec, plane: 'x' },
    { ...spec, firstSegment: 3, lastSegment: 2 }, { ...spec, firstSegment: -1 }, { ...spec, lastSegment: 1.5 },
    // 没有第一帧、第一帧不是非负整数,或分段不是从 0 起数的(改分段规则之前的计划):不列
    { ...spec, originFrame: undefined }, { ...spec, originFrame: -1 }, { ...spec, originFrame: 1.5 }, { ...spec, firstSegment: 2 },
  ];
  assert.deepEqual(layerStreamsOf(entry, { streams: bad, fingerprint: OWN }), []);
  // 一个指纹都没有(流自己没带、调用方也没给):凑不出候选,不列
  assert.deepEqual(layerStreamsOf(entry, { streams: [{ ...spec, envFingerprint: undefined }], fingerprint: null }), []);
  assert.deepEqual(layerStreamsOf(entry, { streams: 'nope', fingerprint: OWN }), []);
});

test('The same stream attached to two clips (same card, same parameters, same in point): two rows, same key, different topClipId', () => {
  const p = project();
  p.tracks.push({ id: 't-a2', clips: [{ ...p.tracks[0].clips[0], id: 'clip-a2' }] });
  const entry = { key: 'entry-1', project: p, cardPlan: [control('clip-a', 0, 60), control('clip-a2', 0, 60, { contentKey: 'ck-clip-a', snapshotKey: resultKeyOf('ck-clip-a', OWN) })] };
  const rows = layerStreamsOf(entry, { streams: specsOf(entry), fingerprint: OWN });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].contentKey, rows[1].contentKey);
  assert.deepEqual(rows.map((r) => r.topClipId).sort(), ['clip-a', 'clip-a2']);
});

test('splitStreamCandidatesOf: collects only stream tasks and records fingerprints by content key (publish order); the snapshot one still collects only snapshots', () => {
  const stream = (ck, fp, from, extra = {}) => ({ id: `stream:${resultKeyOf(ck, fp)}:${from}-${from + 7}`, kind: 'stream', resultKey: resultKeyOf(ck, fp),
    range: { unit: 'segment', from, to: from + 7 }, input: { clipId: 'clip-a', cardId: null, entryKey: null, contentKey: ck, ...extra }, requires: { envFingerprint: fp, transcode: true } });
  const snap = (ck, fp) => ({ id: `snapshot:${ck}:0-59`, kind: 'snapshot', tier: 'shared', resultKey: resultKeyOf(ck, fp), range: { from: 0, to: 59 }, input: { contentKey: ck }, requires: { envFingerprint: fp } });
  const tasks = [
    snap('ck-card', OWN), snap('ck-card', BROWSER),
    stream('sk-1', OWN, 0), stream('sk-1', OWN, 8),
    // 「产」那一半让切分给浏览器多出的一份单卡流:只认通用字段(kind、input.contentKey、requires.envFingerprint),别的字段不看
    stream('sk-1', BROWSER, 0, { dual: true, stream: { kind: 'card', plane: 'local' } }),
    stream('sk-2', BROWSER, 2),
    { kind: 'stream', input: {}, requires: { envFingerprint: OWN } }, { kind: 'stream', input: { contentKey: 'sk-3' }, requires: {} }, null,
  ];
  assert.deepEqual([...splitStreamCandidatesOf(tasks)], [['sk-1', [OWN, BROWSER]], ['sk-2', [BROWSER]]]);
  assert.deepEqual([...splitCandidatesOf(tasks)], [['ck-card', [OWN, BROWSER]]], 'Stream tasks do not mix into the snapshot candidates');
  assert.deepEqual([...splitStreamCandidatesOf(null)], []);
  assert.equal(streamCandidateKey('sk-1'), `${STREAM_CANDIDATE_PREFIX}sk-1`);
  assert.equal(streamCandidateKey(''), null);
});

test('Executor afterSplit: stream candidates are recorded in the same record (keys carry a stream: prefix); with no stream tasks it records only once', async () => {
  const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
  const recorded = [];
  const pipeline = { recordSplitCandidates: (m) => recorded.push([...m.entries()]) };
  const exec = createPrerenderExecutor({ pipeline, projects: { get: async () => ({ tracks: [], duration: 1 }) } });
  const planTask = { id: 'plan:x', kind: 'plan', resultKey: 'x', source: { projectId: 'proj-streams', projectRev: 1 }, input: {} };
  const snap = { kind: 'snapshot', tier: 'shared', input: { contentKey: 'ck-card' }, requires: { envFingerprint: OWN } };
  const str = (fp) => ({ kind: 'stream', input: { contentKey: 'sk-1' }, requires: { envFingerprint: fp } });
  await exec.afterSplit(planTask, { tasks: [snap] });
  assert.deepEqual(recorded, [[['ck-card', [OWN]]]], 'No stream tasks: records only once, as before');
  recorded.length = 0;
  await exec.afterSplit(planTask, { tasks: [snap, str(OWN), str(BROWSER)] });
  assert.deepEqual(recorded, [[['ck-card', [OWN]]], [['stream:sk-1', [OWN, BROWSER]]]]);
});

/* ------------------------------------------------------------------ 清单计划给浏览器出的流进层表(集成那一环) */

test('layerStreamsOf: a stream marked ownCandidate: false lists only the fingerprints the splitter actually issued keys for and does not add its own; it is not listed if no one was ever assigned it', () => {
  const entry = entryOf();
  const [spec] = specsOf(entry);
  const issued = { ...spec, ownCandidate: false };
  const [row] = layerStreamsOf(entry, { streams: [issued], fingerprint: OWN, candidatesOf: () => [BROWSER] });
  assert.deepEqual(row.candidates, [{ envFingerprint: BROWSER, resultKey: resultKeyOf(spec.contentKey, BROWSER) }], 'Only the one browser candidate');
  assert.equal(row.contentKey, spec.contentKey);
  assert.equal(row.inputSig, streamInputSig(entry.project, { clipIds: spec.clipIds, kind: 'card' }));
  assert.deepEqual(layerStreamsOf(entry, { streams: [issued], fingerprint: OWN, candidatesOf: () => [] }), [], 'Not in the record: not listed');
  assert.deepEqual(layerStreamsOf(entry, { streams: [issued], fingerprint: OWN }), [], 'candidatesOf not given: not listed');
  // 切分连自己的指纹也出过键(以后桌面替清单计划产流):照记录列
  assert.deepEqual(layerStreamsOf(entry, { streams: [issued], fingerprint: OWN, candidatesOf: () => [BROWSER, OWN] })[0].candidates.map((c) => c.envFingerprint), [BROWSER, OWN]);
});

/**
 * 管线一级:真的 `FramePipeline`(不开 Chrome)、真的切分(`splitPlan`)、真的执行器 `afterSplit`,层表经假的推送队列收下。
 * `streams`:'none' 没有生产者(编辑器进程、关着交互的渲染主机);'off' 有生产者但 `PROMPTCUT_STREAMS=0`;'on' 流开着。
 */
const PIPE_ENV = describeEnvironment({ platform: 'win32', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49' });
const PIPE_FP = PIPE_ENV.fingerprint;
const CAPTURE = 'cap-1';
const STREAM_CODE = `${STREAM_CODE_VERSION}:${CAPTURE}`;

async function withPipeline(streams, fn, { decoders = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-layer-streams-'));
  const saved = { streams: process.env.PROMPTCUT_STREAMS, decoders: process.env.PROMPTCUT_STREAM_DECODERS };
  const put = (name, value) => { if (value === undefined || value === null) delete process.env[name]; else process.env[name] = value; };
  put('PROMPTCUT_STREAMS', streams === 'off' ? '0' : null);
  put('PROMPTCUT_STREAM_DECODERS', decoders);
  const maps = [];
  const made = [];
  const make = (options = {}) => {
    const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: PIPE_ENV, dataRoot: root, interactive: streams !== 'none', captureCode: () => CAPTURE,
      pushQueue: { putLayerMap: (projectId, body) => { maps.push({ projectId, body }); return true; } }, ...options });
    made.push(p);
    return p;
  };
  try {
    const pipeline = make();
    if (streams === 'none') assert.equal(pipeline.streamProducer(), null, 'no producer');
    else assert.equal(pipeline.streamProducer().enabled, streams === 'on');
    return await fn({ pipeline, maps, make });
  } finally {
    put('PROMPTCUT_STREAMS', saved.streams);
    put('PROMPTCUT_STREAM_DECODERS', saved.decoders);
    await Promise.allSettled(made.map((p) => p.close()));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
/** 浏览器做得了的两张卡(共享档、独立卡、内置卡);`base` 是本机判重的片段,`listed` 是清单计划补进预渲染集合的 */
function pipelineEntry({ base = [], listed = [] } = {}) {
  const ctl = (clipId, firstFrame, count, start, end) => ({ ...control(clipId, firstFrame, count), cardId: `card-${clipId}`, snapshotKey: resultKeyOf(`ck-${clipId}`, PIPE_FP), envFingerprint: PIPE_FP,
    start, end, compositing: 'independent' });
  return { key: 'entry-1', project: project(), cardPlan: [ctl('clip-a', 0, 60, 0, 2), ctl('clip-b', 30, 120, 1, 5)],
    basePrerenderSet: new Set(base), prerenderSet: new Set([...base, ...listed]) };
}
/** 照清单计划那条路切一次(`listStreamSpecs` → `queueStreamOf` → `browserOnly`,同 `local-node.mjs` 的 `listPlanOverrides`),回细任务 */
function splitListPlan(pipeline, entry, clips) {
  const streams = pipeline.listStreamSpecs(entry, new Set(clips)).map(queueStreamOf).map((s) => ({ ...s, browserOnly: true }));
  return splitPlan({ planTask: clipsPlan({ clips }), entryKey: entry.key, cardPlan: entry.cardPlan, prerenderSet: new Set(clips), streams, envFingerprint: PIPE_FP, codeVersion: 'cv-1',
    weightOf: () => ({ class: 'medium', estMs: null }), browser: { nodeId: 'n-br', envFingerprint: BROWSER } });
}
/** 真的执行器 `afterSplit`(记候选、写层表)。没开 Chrome:`planForQueue` 由替身回这一版的 entry,其余方法都是真管线的 */
async function afterSplit(pipeline, entry, tasks) {
  const exec = executorOn(pipeline, entry);
  await exec.afterSplit(clipsPlan({ clips: [...entry.prerenderSet] }), { tasks });
  return exec;
}
/** 真的执行器接在真管线的候选记录与层表上;`planForQueue`、产流由替身代(不开 Chrome、不编码) */
function executorOn(pipeline, entry, { produced = [] } = {}) {
  return createPrerenderExecutor({
    pipeline: { get envFingerprint() { return pipeline.envFingerprint; }, recordSplitCandidates: (m) => pipeline.recordSplitCandidates(m), splitCandidatesFor: (k) => pipeline.splitCandidatesFor(k),
      publishLayerMap: (e) => pipeline.publishLayerMap(e), planForQueue: async () => ({ entry, context: { cardPlan: [] }, streamSpecs: [] }),
      listStreamSpecs: (e, clips) => pipeline.listStreamSpecs(e, clips), streamCapable: async () => true, prerenderPicked: (e, id) => pipeline.prerenderPicked(e, id),
      renderStreamRange: async (e, spec, range) => { produced.push({ streamKey: spec.streamKey, range }); return null; } },
    projects: { get: async () => entry.project },
  });
}

for (const mode of ['none', 'off']) {
  test(`The splitter itself produces no stream (${mode === 'none' ? 'no producer' : 'stream switch off'}): single-card streams that the manifest plan issues for the browser still go into the layer table, and the candidate is the browser fingerprint`, async () => {
    await withPipeline(mode, async ({ pipeline, maps, make }) => {
      const entry = pipelineEntry({ listed: ['clip-a', 'clip-b'] });
      // 切分之前(`addBackfill` 那一次写层表):没有人被派过流,层表不带 streams,与不认识流的时候逐字相同
      pipeline.publishLayerMap(entry);
      assert.equal(maps.length, 1);
      const plain = layerMapOf(entry, { picked: (id) => entry.prerenderSet.has(id), fingerprint: PIPE_FP, candidatesOf: () => null, now: maps[0].body.at });
      assert.deepEqual(maps[0].body, plain, 'With no streams the layer table is identical to before, character for character');
      assert.equal('streams' in maps[0].body, false);
      assert.deepEqual(pipeline.layerMapStreamOptions(entry), {});

      const tasks = splitListPlan(pipeline, entry, ['clip-a', 'clip-b']);
      const streamTasks = tasks.filter((t) => t.kind === 'stream');
      assert.equal(streamTasks.length, 2, 'One browser stream task for each of the two cards');
      assert.ok(streamTasks.every((t) => t.requires.envFingerprint === BROWSER && t.requires.transcode === false), 'Only the browser\'s copy');
      await afterSplit(pipeline, entry, tasks);
      assert.equal(maps.length, 2, 'The layer table was written once after the split completed');
      const map = maps[1].body;
      assert.equal(map.v, LAYER_MAP_VERSION);
      assert.deepEqual(map.layers.map((l) => l.clipId), ['clip-a', 'clip-b']);
      assert.equal(map.streams.length, 2);
      for (const task of streamTasks) {
        const row = map.streams.find((r) => r.topClipId === task.input.clipId);
        assert.ok(row, `The layer table has the stream for ${task.input.clipId}`);
        assert.equal(row.kind, 'card');
        assert.equal(row.plane, 'local');
        assert.deepEqual(row.clipIds, [task.input.clipId]);
        assert.equal(row.contentKey, task.input.contentKey, 'The content key is the one in the task');
        assert.deepEqual(row.candidates, [{ envFingerprint: BROWSER, resultKey: task.resultKey }], 'The only candidate is the browser fingerprint that actually issued the key, and the result key is the task\'s result key');
        assert.equal(task.range.from, 0, 'Segments count from 0');
        assert.equal(row.originFrame, task.input.stream.originFrame, 'The first frame in the row is the one the task gives the browser');
        assert.equal(row.lastSegment, task.range.to);
        assert.equal(row.segmentsPerTask, QUEUE_DEFAULTS.STREAM_SEGMENTS);
        assert.equal(row.inputSig, streamInputSig(entry.project, { clipIds: [task.input.clipId], kind: 'card' }));
      }
      // 进程重启(候选记录落在库根):新管线照样列得出
      const again = make({ pushQueue: null });
      assert.deepEqual(again.layerMapStreamOptions(entry).streams.map((s) => s.topClipId).sort(), ['clip-a', 'clip-b']);
      // 这张卡改了内容(内容键换了):旧记录对不上,不再列
      const edited = { ...entry, cardPlan: entry.cardPlan.map((c) => (c.clipId === 'clip-a' ? { ...c, contentKey: 'ck-clip-a-v2' } : c)) };
      assert.deepEqual(pipeline.layerMapStreamOptions(edited).streams.map((s) => s.topClipId), ['clip-b']);
    });
  });
}

test('Splitter streams on: cards this machine did not classify as heavy (added by the manifest plan) are still listed, with only the browser candidate; the card this machine classified as heavy stays as before (browser first, its own after)', async () => {
  await withPipeline('on', async ({ pipeline, maps }) => {
    const entry = pipelineEntry({ base: ['clip-b'], listed: ['clip-a'] });
    const before = pipeline.layerMapStreamOptions(entry);
    assert.deepEqual(before.streams.map((s) => s.topClipId), ['clip-b'], 'What existed before this step was added: only cards this machine classified as heavy are listed');
    await afterSplit(pipeline, entry, splitListPlan(pipeline, entry, ['clip-a', 'clip-b']));
    const map = maps[maps.length - 1].body;
    assert.deepEqual(map.streams.map((r) => r.topClipId), ['clip-b', 'clip-a'], 'This machine\'s own streams come first');
    const a = map.streams.find((r) => r.topClipId === 'clip-a'), b = map.streams.find((r) => r.topClipId === 'clip-b');
    assert.deepEqual(a.candidates.map((c) => c.envFingerprint), [BROWSER], 'Not classified as heavy on this machine and not produced by it: its own fingerprint is not listed');
    assert.deepEqual(b.candidates.map((c) => c.envFingerprint), [BROWSER, PIPE_FP], 'Classified as heavy on this machine: the ones the splitter actually issued keys for come first, then its own is added');
    assert.equal(b.candidates[1].resultKey, before.streams[0].streamKey);
  });
});

test('The manifest plan also issues the splitter\'s own copy (task brief "A3"): for streams of cards this machine did not classify as heavy, the candidates are the two "splitter, browser"; when off, only the browser', async () => {
  const { listPlanOverrides } = await import('../render-node/local-node.mjs');
  /** 照 local-node 的真路径切:`listPlanOverrides` 按 `ownListStreams` 决定出不出切分方自己的那一份 */
  const splitWith = (pipeline, entry, clips, ownListStreams) => {
    const planTask = clipsPlan({ clips });
    const overrides = listPlanOverrides(planTask, { ownListStreams, browserStreamsFor: (set) => pipeline.listStreamSpecs(entry, set).map(queueStreamOf) });
    return splitPlan({ planTask, entryKey: entry.key, cardPlan: entry.cardPlan, envFingerprint: PIPE_FP, codeVersion: 'cv-1',
      weightOf: () => ({ class: 'medium', estMs: null }), browser: { nodeId: 'n-br', envFingerprint: BROWSER }, ...overrides });
  };
  await withPipeline('on', async ({ pipeline, maps, make }) => {
    // 渲染服务不判重:两张卡都是清单计划补进预渲染集合的
    const entry = pipelineEntry({ listed: ['clip-a', 'clip-b'] });
    assert.deepEqual(pipeline.layerMapStreamOptions(entry), {}, 'Before the split: this machine produces no streams at all, and the layer table has no streams');
    const tasks = splitWith(pipeline, entry, ['clip-a', 'clip-b'], true);
    const streamTasks = tasks.filter((t) => t.kind === 'stream');
    assert.deepEqual(streamTasks.map((t) => [t.input.clipId, t.requires.envFingerprint, t.requires.transcode, t.input.dual]).sort(), [
      ['clip-a', BROWSER, false, true], ['clip-a', PIPE_FP, true, true], ['clip-b', BROWSER, false, true], ['clip-b', PIPE_FP, true, true],
    ].sort(), 'Two copies per card: the splitter\'s own (needs transcoding) and the browser\'s');
    const produced = [];
    const exec = executorOn(pipeline, entry, { produced });
    await exec.afterSplit(clipsPlan({ clips: [...entry.prerenderSet] }), { tasks });
    const map = maps[maps.length - 1].body;
    assert.deepEqual(map.streams.map((r) => r.topClipId).sort(), ['clip-a', 'clip-b']);
    const ownOf = (clipId) => streamTasks.find((t) => t.input.clipId === clipId && t.requires.envFingerprint === PIPE_FP);
    for (const row of map.streams) {
      // 两份成对,谁先认领谁得:切分完成时还不知道谁会赢,自己的先排在后面(之后才进来的页面取第一个候选)
      assert.deepEqual(row.candidates.map((c) => c.envFingerprint), [BROWSER, PIPE_FP], 'When the split completes: the browser\'s comes first, the splitter\'s own after');
      assert.equal(row.candidates[1].resultKey, ownOf(row.topClipId).resultKey, 'The result key is the result key of the splitter\'s copy of the task');
      assert.equal(row.contentKey, ownOf(row.topClipId).input.contentKey);
      assert.equal(row.kind, 'card');
    }
    // 本机真产出了 clip-a 的一段(流任务做完):这条流的候选里自己提到最前,层表重写一次;clip-b 没产,顺序不动
    const before = maps.length;
    await exec.render(ownOf('clip-a'), { progress: () => {} });
    assert.equal(produced.length, 1);
    assert.equal(maps.length, before + 1, 'The layer table was rewritten once');
    const after = maps[maps.length - 1].body;
    assert.deepEqual(after.streams.find((r) => r.topClipId === 'clip-a').candidates.map((c) => c.envFingerprint), [PIPE_FP, BROWSER], 'After production: its own comes first');
    assert.deepEqual(after.streams.find((r) => r.topClipId === 'clip-b').candidates.map((c) => c.envFingerprint), [BROWSER, PIPE_FP]);
    // 同一条流再做一段:顺序已经对了,不再重写
    await exec.render(ownOf('clip-a'), { progress: () => {} });
    assert.equal(maps.length, before + 1);
    // 之后同一条流又被切了一次(项目有别的改动、这张卡没变):已经是自己在前的不往后挪
    await exec.afterSplit(clipsPlan({ clips: [...entry.prerenderSet] }), { tasks });
    assert.deepEqual(maps[maps.length - 1].body.streams.find((r) => r.topClipId === 'clip-a').candidates.map((c) => c.envFingerprint), [PIPE_FP, BROWSER]);
    // 重启后照样列、顺序照旧(候选记录落盘)
    const again = make({ pushQueue: null });
    assert.deepEqual(again.layerMapStreamOptions(entry).streams.map((s) => s.topClipId).sort(), ['clip-a', 'clip-b']);
    assert.deepEqual(again.splitCandidatesFor(streamCandidateKey(ownOf('clip-a').input.contentKey)), [PIPE_FP, BROWSER]);
  });
  await withPipeline('on', async ({ pipeline, maps }) => {
    // 这一项关着(`ownListStreams: false`):与甲一相同,只有浏览器那一份
    const entry = pipelineEntry({ listed: ['clip-a', 'clip-b'] });
    const tasks = splitWith(pipeline, entry, ['clip-a', 'clip-b'], false);
    assert.ok(tasks.filter((t) => t.kind === 'stream').every((t) => t.requires.envFingerprint === BROWSER && !('dual' in t.input)));
    await afterSplit(pipeline, entry, tasks);
    assert.deepEqual(maps[maps.length - 1].body.streams.map((r) => r.candidates.map((c) => c.envFingerprint)), [[BROWSER], [BROWSER]]);
  });
});

test('Splitter streams on, no separately listed streams: the layer table is character for character the same as one written from this machine\'s stream plan only', async () => {
  await withPipeline('on', async ({ pipeline, maps }) => {
    const entry = pipelineEntry({ base: ['clip-a', 'clip-b'] });
    // 记录里只有快照的候选,和一条不属于这一版的流
    pipeline.recordSplitCandidates(new Map([['ck-clip-a', [PIPE_FP, BROWSER]], [streamCandidateKey('sk-else'), [BROWSER]]]));
    pipeline.publishLayerMap(entry);
    const specs = planStreams(entry, { picked: (id) => entry.basePrerenderSet.has(id), budget: pipeline.streamProducer().budget, codeVersion: STREAM_CODE, envFingerprint: PIPE_FP });
    assert.equal(specs.length, 2);
    assert.deepEqual(pipeline.layerMapStreamOptions(entry).streams, specs, 'What is handed to the layer table is this machine\'s stream plan, with no extra items');
    const expect = layerMapOf(entry, { picked: (id) => entry.prerenderSet.has(id), fingerprint: PIPE_FP, candidatesOf: (c) => pipeline.splitCandidatesFor(c?.contentKey), now: maps[0].body.at, streams: specs });
    assert.deepEqual(maps[0].body, expect);
    assert.deepEqual(maps[0].body.streams.map((r) => r.candidates.map((c) => c.envFingerprint)), [[PIPE_FP], [PIPE_FP]]);
  });
});

test('The project this version belongs to does not produce streams right now (the host follows the project\'s "Generate track streams", entry.ownStreamsOff): this machine\'s own streams for this version are not listed; those already dispatched are still listed per the candidate record', async () => {
  await withPipeline('on', async ({ pipeline }) => {
    const entry = pipelineEntry({ base: ['clip-a', 'clip-b'] });
    assert.deepEqual(pipeline.layerMapStreamOptions(entry).streams.map((s) => s.topClipId).sort(), ['clip-a', 'clip-b'], 'As before: the streams of all cards this machine classified as heavy are listed');
    entry.ownStreamsOff = true;
    assert.deepEqual(pipeline.layerMapStreamOptions(entry), {}, 'This item is off and no one was ever assigned it: the layer table has no streams');
    // clip-a 的单卡流以前派过(开着的时候产的,或者给浏览器的):照记录列,候选只有记录里的指纹
    const [a] = planStreams({ ...entry, cardPlan: entry.cardPlan.filter((c) => c.clipId === 'clip-a') }, { budget: Infinity, codeVersion: STREAM_CODE, envFingerprint: PIPE_FP });
    pipeline.recordSplitCandidates(new Map([[streamCandidateKey(a.contentKey), [PIPE_FP]]]));
    const off = pipeline.layerMapStreamOptions(entry);
    assert.deepEqual(off.streams.map((s) => [s.topClipId, s.ownCandidate]), [['clip-a', false]], 'Those already produced stay in the layer table; clip-b, which was never dispatched, is not listed');
    assert.deepEqual(layerStreamsOf(entry, { streams: off.streams, fingerprint: PIPE_FP, candidatesOf: off.streamCandidatesOf })[0].candidates.map((c) => c.envFingerprint), [PIPE_FP]);
    entry.ownStreamsOff = false;
    assert.deepEqual(pipeline.layerMapStreamOptions(entry).streams.map((s) => s.topClipId).sort(), ['clip-a', 'clip-b'], 'Turned on again: as before');
  });
});

test('Separately listed streams do not overlap with this machine\'s streams (a member card already in this machine\'s group stream is not listed again); cards outside the prerender set are not listed', async () => {
  const recordSingles = (pipeline, entry) => {
    const singles = planStreams(entry, { budget: Infinity, codeVersion: STREAM_CODE, envFingerprint: PIPE_FP });
    assert.equal(singles.length, 2);
    pipeline.recordSplitCandidates(new Map(singles.map((s) => [streamCandidateKey(s.contentKey), [BROWSER]])));
  };
  await withPipeline('on', async ({ pipeline }) => {
    const entry = pipelineEntry({ base: ['clip-a', 'clip-b'] });
    recordSingles(pipeline, entry);
    const { streams } = pipeline.layerMapStreamOptions(entry);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].kind, 'group', 'Decoder budget 1: this machine merges into one group stream, and the two member cards are no longer listed separately as single-card streams');
  }, { decoders: '1' });
  await withPipeline('none', async ({ pipeline }) => {
    const entry = pipelineEntry({ listed: ['clip-a'] });
    recordSingles(pipeline, entry);
    assert.deepEqual(pipeline.layerMapStreamOptions(entry).streams.map((s) => s.topClipId), ['clip-a'], 'clip-b is not in the prerender set (the layer table has no snapshot layer for it): not listed');
  });
});

/* ---------------- 清单计划里依赖下层的卡(任务书 `render-refactor-task.md`「戊二」的「下层四」) ---------------- */

/** 毛玻璃卡 `clip-g`(依赖下层)压在 `clip-a`、`clip-b` 上面;三张都是清单计划补进预渲染集合的(渲染服务、桌面预渲染进程自己不判重) */
function belowEntry({ base = [], listed = ['clip-a', 'clip-b', 'clip-g'], edit = (p) => p } = {}) {
  const p = edit({ ...project(), tracks: [
    { id: 't-g', clips: [{ id: 'clip-g', cardId: 'odometer', start: 0.5, end: 3, params: { value: 1 }, frame: { x: 200, y: 200, w: 600, h: 300 } }] },
    ...project().tracks,
  ] });
  const ctl = (clipId, firstFrame, count, start, end, extra = {}) => ({ ...control(clipId, firstFrame, count), cardId: `card-${clipId}`, snapshotKey: resultKeyOf(`ck-${clipId}`, PIPE_FP), envFingerprint: PIPE_FP,
    start, end, compositing: 'independent', ...extra });
  const text = p.tracks.find((t) => t.id === 't-a').clips[0].params.text;
  return { key: 'entry-1', project: p, cardPlan: [
    ctl('clip-g', 15, 75, 0.5, 3, { tier: 'local', compositing: 'belowDependent', capabilities: { compositing: 'belowDependent' } }),
    // 下层那张卡的缓存内容键跟着它的参数走(真的卡片计划里就是这样;这里手写)
    ctl('clip-a', 0, 60, 0, 2, { key: `key-clip-a-${text}` }), ctl('clip-b', 30, 120, 1, 5),
  ], basePrerenderSet: new Set(base), prerenderSet: new Set([...base, ...listed]) };
}

test('Cards in the manifest plan that depend on lower layers: the splitter issues this kind of stream under its own fingerprint and produces it itself; this kind of row is written into the layer table (with an input signature), the only candidate is the splitter; when the stream task comes back it can be matched to this version', async () => {
  const { listPlanOverrides } = await import('../render-node/local-node.mjs');
  const splitWith = (pipeline, entry, clips, plan) => {
    const planTask = clipsPlan({ clips });
    const overrides = listPlanOverrides(planTask, { ...plan, browserStreamsFor: (set) => pipeline.listStreamSpecs(entry, set).map(queueStreamOf) });
    return splitPlan({ planTask, entryKey: entry.key, cardPlan: entry.cardPlan, envFingerprint: PIPE_FP, codeVersion: 'cv-1', sparseStreams: true,
      weightOf: () => ({ class: 'medium', estMs: null }), browser: { nodeId: 'n-br', envFingerprint: BROWSER }, ...overrides });
  };
  const CLIPS = ['clip-a', 'clip-b', 'clip-g'];
  await withPipeline('on', async ({ pipeline, maps, make }) => {
    const entry = belowEntry();
    assert.deepEqual(pipeline.layerMapStreamOptions(entry), {}, 'Before the split: this machine produces no streams at all (this machine classified none of these three cards as heavy)');
    const tasks = splitWith(pipeline, entry, CLIPS, { ownListStreams: true });
    const belowTasks = tasks.filter((t) => t.kind === 'stream' && t.requires.belowDependent === true);
    assert.deepEqual(belowTasks.map((t) => [t.input.clipId, t.requires.envFingerprint, t.requires.transcode, t.input.density ?? 'dense', 'dual' in t.input]),
      [['clip-g', PIPE_FP, true, 'sparse', false], ['clip-g', PIPE_FP, true, 'dense', false]], 'Only the splitter\'s own fingerprint; sparse first, then full density; not paired with the browser');
    assert.ok(tasks.filter((t) => t.kind === 'stream' && t.requires.envFingerprint === BROWSER).every((t) => t.input.clipId !== 'clip-g'), 'No stream for this card under the browser\'s fingerprint');
    const produced = [];
    const exec = executorOn(pipeline, entry, { produced });
    await exec.afterSplit(clipsPlan({ clips: CLIPS }), { tasks });
    const map = maps[maps.length - 1].body;
    const row = map.streams.find((r) => r.topClipId === 'clip-g');
    const [dense] = belowTasks.filter((t) => !t.input.density);
    assert.deepEqual(row, {
      topClipId: 'clip-g', clipIds: ['clip-g'], kind: 'below', plane: 'stage', contentKey: dense.input.contentKey,
      candidates: [{ envFingerprint: PIPE_FP, resultKey: dense.resultKey }],
      originFrame: 15, lastSegment: dense.range.to, segmentsPerTask: QUEUE_DEFAULTS.STREAM_SEGMENTS,
      inputSig: streamInputSig(entry.project, { clipIds: ['clip-g'], kind: 'below' }),
    }, 'This kind of row in the layer table: stage coordinates, the only member is the target card, the only candidate is the splitter, and it carries the same input signature the page computed');
    assert.match(row.inputSig, /^s1-/);
    assert.deepEqual(map.streams.filter((r) => r.kind === 'card').map((r) => r.topClipId).sort(), ['clip-a', 'clip-b'], 'Other cards still each have one single-card stream row');
    // 流任务回来:本机这一版的流里没有它(没判重),执行器按任务的片段现算一条来对,稀疏、满密度两种都对得回同一条
    for (const task of belowTasks) await exec.render(task, { progress: () => {} });
    assert.deepEqual(produced.map((x) => x.streamKey), [dense.resultKey, dense.resultKey]);
    // 任务说的种类和现算出来的对不上(有人把 belowDependent 抹了):不产
    await assert.rejects(exec.render({ ...dense, requires: { ...dense.requires, belowDependent: false } }, { progress: () => {} }), /does not match this version's stream/);
    // 重启后照样列(候选记录落盘)
    const again = make({ pushQueue: null });
    assert.deepEqual(again.layerMapStreamOptions(entry).streams.map((s) => [s.topClipId, s.kind]).sort(), [['clip-a', 'card'], ['clip-b', 'card'], ['clip-g', 'below']]);
    // 下层改了(下面那张卡换了参数):这种流的内容键换了,旧记录对不上,不再列;页面按旧行的签名也判得出过期
    const edited = belowEntry({ edit: (p) => { p.tracks.find((t) => t.id === 't-a').clips[0].params = { text: 'changed' }; return p; } });
    assert.deepEqual(pipeline.layerMapStreamOptions(edited).streams.map((s) => s.topClipId).sort(), ['clip-a', 'clip-b'], 'The two lower-layer cards\' own single-card streams are still listed (the stand-in key here did not change), and the frosted-glass stream is no longer listed');
    assert.notEqual(streamInputSig(edited.project, { clipIds: ['clip-g'], kind: 'below' }), row.inputSig);
    // 旧任务到了新版本:对不回(内容键换了),不产
    const execNew = executorOn(pipeline, edited, { produced });
    await assert.rejects(execNew.render(dense, { progress: () => {} }), /does not match this version's stream/);
    // 新的一版再切一次:层表里是新键、新签名的行
    const tasks2 = splitWith(pipeline, edited, CLIPS, { ownListStreams: true });
    await execNew.afterSplit(clipsPlan({ clips: CLIPS }), { tasks: tasks2 });
    const row2 = maps[maps.length - 1].body.streams.find((r) => r.topClipId === 'clip-g');
    assert.notEqual(row2.contentKey, row.contentKey);
    assert.equal(row2.inputSig, streamInputSig(edited.project, { clipIds: ['clip-g'], kind: 'below' }));
    assert.deepEqual(row2.candidates.map((c) => c.envFingerprint), [PIPE_FP]);
  });
  await withPipeline('on', async ({ pipeline, maps }) => {
    // 切分方自己不出(`ownListStreams` 不为真):这种流一份都不出,层表里没有这种行;别的卡照旧只有浏览器候选
    const entry = belowEntry();
    const tasks = splitWith(pipeline, entry, CLIPS, { ownListStreams: false });
    assert.deepEqual(tasks.filter((t) => t.kind === 'stream' && (t.requires.belowDependent === true || t.input.clipId === 'clip-g')), []);
    await afterSplit(pipeline, entry, tasks);
    assert.deepEqual(maps[maps.length - 1].body.streams.map((r) => [r.topClipId, r.kind]).sort(), [['clip-a', 'card'], ['clip-b', 'card']]);
  });
  await withPipeline('on', async ({ pipeline, maps }) => {
    // 托管方的渲染节点、这个项目的「生成轨道流」关着:自己的那一份只出稀疏流任务;派出去了就列进层表
    const entry = belowEntry();
    entry.ownStreamsOff = true;
    const tasks = splitWith(pipeline, entry, ['clip-g'], { ownListSparseStreams: true });
    assert.deepEqual(tasks.filter((t) => t.kind === 'stream').map((t) => [t.input.clipId, t.requires.envFingerprint, t.input.density]), [['clip-g', PIPE_FP, 'sparse']]);
    await afterSplit(pipeline, entry, tasks);
    assert.deepEqual(maps[maps.length - 1].body.streams.map((r) => [r.topClipId, r.kind, r.candidates.map((c) => c.envFingerprint)]), [['clip-g', 'below', [PIPE_FP]]]);
  });
});
