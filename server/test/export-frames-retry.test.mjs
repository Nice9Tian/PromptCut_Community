/**
 * 导出位图「重新做」那几处(审查后补的;`server/export-frames.mjs` 的 `exportSaltOf`、`render-node/export-plan.mjs` 的索引、
 * `frame-stream.mjs` 的 `produceExportRange`)。跑:node --test server/test/export-frames-retry.test.mjs
 *
 *   EFR-01 重新做的标识换导出键:带了标识键就换(任务是新任务),不带和原来相同;形状不对的标识当没带
 *   EFR-02 标识一路带到:清单计划的 `input.exportSalt` → 执行器算计划 → 切出的任务的 `input.exportSalt`、结果键
 *   EFR-03 计划完成时的索引带着每条流的任务原样一份(页面核对任务状态、任务被删后重建用),队列的入站校验收它
 *   EFR-04 差分取层判过失败的记录不跨任务留着:新的一份任务重新试(E)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exportFramesKey, exportSaltOf, exportSpecOf, exportStreamOf } from '../export-frames.mjs';
import { exportIndexOf } from '../render-node/export-plan.mjs';
import { splitPlan } from '../render-node/split.mjs';
import { listPlanOverrides } from '../render-node/local-node.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { parseInbound } from '../render-queue/messages.mjs';
import { StreamProducer } from '../frame-stream.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const FP = 'a'.repeat(16);
const STREAM_KEY = sha256('stream-content');
const specOf = (over = {}) => ({
  streamKey: resultKeyOf(STREAM_KEY, FP), contentKey: STREAM_KEY, envFingerprint: FP, kind: 'card', plane: 'local', clipIds: ['c1'], topClipId: 'c1',
  offset: { x: 0, y: 0 }, bound: { x: 0, y: 0, w: 64, h: 32 }, fps: 30, originFrame: 12, lastFrame: 20, firstSegment: 0, lastSegment: 0, mountFrame: 12, ...over,
});
const planTask = { id: 'plan:p1@7#clips:abc', kind: 'plan', resultKey: 'p1@7#clips:abc', source: { projectId: 'p1', projectRev: 7 }, input: { clips: ['c1'], exportOnly: true, exportSalt: 'r1abc' } };
const base = { planTask, entryKey: 'e1', cardPlan: [], prerenderSet: new Set(), streams: [], envFingerprint: FP, codeVersion: 'cv1' };

test('EFR-01 重新做的标识换导出键', () => {
  const plain = exportFramesKey(STREAM_KEY);
  assert.equal(exportFramesKey(STREAM_KEY, ''), plain);
  assert.equal(exportFramesKey(STREAM_KEY, 'Bad Salt!'), plain, '形状不对的标识当没带');
  assert.notEqual(exportFramesKey(STREAM_KEY, 'r1abc'), plain);
  assert.notEqual(exportFramesKey(STREAM_KEY, 'r1abc'), exportFramesKey(STREAM_KEY, 'r2abc'));
  assert.equal(exportSaltOf('r1abc'), 'r1abc');
  assert.equal(exportSaltOf('x'.repeat(33)), '');
  assert.equal(exportSaltOf(undefined), '');
  const a = exportSpecOf(specOf(), FP), b = exportSpecOf(specOf(), FP, 'r1abc');
  assert.notEqual(a.exportResultKey, b.exportResultKey);
  assert.equal(a.exportSalt, undefined);
  assert.equal(exportStreamOf(a).salt, undefined);
  assert.equal(exportStreamOf(b).salt, 'r1abc');
});

test('EFR-02 标识从计划一路带到任务', () => {
  let got = null;
  const over = listPlanOverrides(planTask, { exportStreamsFor: (clips, salt) => { got = salt; return { streams: [exportStreamOf(exportSpecOf(specOf(), FP, salt))], unsupported: [] }; } });
  assert.equal(got, 'r1abc');
  const [task] = splitPlan({ ...base, exportStreams: over.exportStreams });
  assert.equal(task.input.exportSalt, 'r1abc');
  assert.equal(task.resultKey, resultKeyOf(exportFramesKey(STREAM_KEY, 'r1abc'), FP));
  // 不带标识的计划:任务里没有这一项,键和原来相同
  const plainOver = listPlanOverrides({ ...planTask, input: { clips: ['c1'], exportOnly: true } }, { exportStreamsFor: (clips, salt) => ({ streams: [exportStreamOf(exportSpecOf(specOf(), FP, salt))], unsupported: [] }) });
  const [plain] = splitPlan({ ...base, exportStreams: plainOver.exportStreams });
  assert.equal(plain.input.exportSalt, undefined);
  assert.equal(plain.resultKey, resultKeyOf(exportFramesKey(STREAM_KEY), FP));
  assert.notEqual(plain.id, task.id);
});

test('EFR-03 索引带着每条流的任务原样一份', () => {
  const stream = exportStreamOf(exportSpecOf(specOf({ lastFrame: 143, lastSegment: 8 }), FP));
  const tasks = splitPlan({ ...base, exportStreams: [stream] });
  const index = exportIndexOf({ exportStreams: [stream], published: tasks, projectRev: 7, segmentsPerTask: 8 });
  assert.equal(index.streams[0].tasks.length, 2);
  assert.deepEqual(index.streams[0].tasks.map(t => t.id), tasks.map(t => t.id));
  assert.deepEqual(index.streams[0].tasks[0].input, tasks[0].input);
  assert.deepEqual(index.streams[0].tasks[0].requires, tasks[0].requires);
  // 页面原样再发布:队列收它,id 不变(已有的任务只回状态,不在了的重建)
  const parsed = parseInbound({ type: 'task.publish', tasks: index.streams[0].tasks });
  assert.equal(parsed.ok, true, parsed.detail);
  assert.deepEqual(parsed.body.tasks.map(t => t.id), tasks.map(t => t.id));
  assert.equal(parsed.body.tasks[0].input.exportFrames, true);
});

test('EFR-04 差分取层判过失败的记录不跨任务留着', async () => {
  const spec = exportSpecOf(specOf({ kind: 'below', plane: 'stage', belowClipIds: ['v0'] }), FP);
  const calls = [];
  const state = { spec: { ...spec, streamKey: spec.exportResultKey }, manifest: {}, isolated: {}, reserved: new Set(), failures: new Map(), exportOnly: true, below: { failed: 'upper-changed' } };
  const fake = {
    closed: false, stats: { failures: 0 }, note() {},
    exportStates: new Map([[spec.exportResultKey, state]]),
    pipeline: { leaseStreamBakery: async () => ({}), returnStreamBakery() {} },
    freshManifest: () => ({}),
    async runSegment(bakery, task) { calls.push(task.segment); return true; },
  };
  const frames = [];
  const out = await StreamProducer.prototype.produceExportRange.call(fake, { project: {} }, spec, { from: 0, to: 0 }, { onFrame: f => frames.push(f) });
  assert.deepEqual(calls, [0], '上一份任务判过失败,这一份照样重新试');
  assert.equal(state.below, null);
  assert.equal(out.frames, 9);
  // 这一份任务里又判失败:本任务尽早停、不可重试
  fake.runSegment = async () => { state.below = { failed: 'upper-changed' }; throw Object.assign(new Error('差分取层没过'), { code: 'below-capture-failed', retryable: false }); };
  await assert.rejects(StreamProducer.prototype.produceExportRange.call(fake, { project: {} }, spec, { from: 0, to: 0 }, { onFrame() {} }), e => e.code === 'below-capture-failed' && e.retryable === false);
});

/* ---------------------------------------------------------------- 对着真的队列 */

const { createRenderQueue } = await import('../render-queue/index.mjs');
const { createQueueHarness } = await import('./fake-render-queue-env.mjs');
const { QUEUE_DEFAULTS } = await import('../render-queue/constants.mjs');

test('EFR-05 真队列:失败的导出位图任务原样再发布只回 failed、不重开;带新标识的是新任务', () => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('page', 'page-1');
  h.node('node', 'n1', { profile: 'host', hello: { envFingerprint: FP, codeVersions: ['cv1'], capabilities: {} } });
  const page = { ...planTask, source: { projectId: 'p1', projectRev: 7 } };
  void page;
  const [task] = splitPlan({ ...base, planTask: { ...planTask, id: null }, exportStreams: [exportStreamOf(exportSpecOf(specOf(), FP))] });
  const first = h.publish('page', [task]).one('page', 'task.published').results[0];
  assert.equal(first.created, true);
  const claimed = h.claim('node', task.id, first.version).one('node', 'task.claimed');
  const failedStep = h.fail('node', task.id, claimed.token, { error: 'below-capture-failed', retryable: false });
  assert.equal(failedStep.one('page', 'task.failed').error, 'below-capture-failed');
  // 页面(早就是订阅者)原样再发布:回包说 failed,不重开,也不再补发通知 —— 页面只能靠回包知道
  const again = h.publish('page', [task]);
  assert.deepEqual(again.one('page', 'task.published').results.map(r => [r.state, r.created]), [['failed', false]]);
  assert.equal(again.of('page', 'task.failed').length, 0);
  assert.equal(h.task(task.id).state, 'failed');
  // 带新标识:键换了,是新任务,节点可以重新认领
  const [retry] = splitPlan({ ...base, planTask: { ...planTask, id: null }, exportStreams: [exportStreamOf(exportSpecOf(specOf(), FP, 'r1abc'))] });
  assert.notEqual(retry.id, task.id);
  const fresh = h.publish('page', [retry]).one('page', 'task.published').results[0];
  assert.deepEqual([fresh.state, fresh.created], ['open', true]);
});

test('EFR-06 真队列:页面断线超过宽限,没人认领的任务被删;重连后原样再发布就重建', () => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('page', 'page-1');
  const [task] = splitPlan({ ...base, planTask: { ...planTask, id: null }, exportStreams: [exportStreamOf(exportSpecOf(specOf(), FP))] });
  h.publish('page', [task]);
  h.disconnect('page');
  h.advance(QUEUE_DEFAULTS.RECONNECT_GRACE_MS + 1);
  assert.equal(h.task(task.id), null, '订阅被清、还 open 的任务删掉了');
  h.publisher('page2', 'page-1');
  const back = h.publish('page2', [task]).one('page2', 'task.published').results[0];
  assert.deepEqual([back.state, back.created], ['open', true]);
});
