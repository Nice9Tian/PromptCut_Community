/**
 * C4 的服务端消费侧(4 帧批次边界读 `wanted`、把含它的批提前)和预渲染集合的
 * 窄接口。跑:node --test server/test/prerender-schedule.test.mjs
 *
 * `nextBatchStart` 只在批与批之间被调 —— 它**不打断正在跑的那一批**,只决定
 * 下一批从哪儿开始。直接拿 `FramePipeline.prototype` 上的那两个方法配一个最小
 * 假对象跑:这一段不碰 Chrome。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePipeline } from '../frame-pipeline.mjs';
import { declaredHeavy, prerenderSetOf, prerenderSetOfPlan } from '../prerender-set.mjs';
import { createReadyHub } from '../ready-index.mjs';

const control = (clipId, count, firstFrame = 0) => ({ clipId, count, sampling: { firstFrame } });
const scheduler = wanted => ({
  playhead: () => ({ t: 0, playing: true, wanted }),
  playheadWanted: FramePipeline.prototype.playheadWanted,
  notePromotion: FramePipeline.prototype.notePromotion,
  nextBatchStart: FramePipeline.prototype.nextBatchStart,
});

test('没有 wanted 时就是顺序批', () => {
  const pipeline = scheduler(undefined);
  const pending = new Set([0, 4, 8, 12]);
  assert.equal(pipeline.nextBatchStart(pending, control('a', 16)), 0);
  pending.delete(0);
  assert.equal(pipeline.nextBatchStart(pending, control('a', 16)), 4);
});

test('wanted 落在哪一批,哪一批就提前(本地帧 = 全局帧 - firstFrame)', () => {
  // 片段从全局第 100 帧开始;播放头想要全局第 1000 帧 → 本地 900 → 第 900 批
  const pipeline = scheduler([{ clipId: 'a', frame: 1000 }]);
  const pending = new Set(Array.from({ length: 250 }, (_, i) => i * 4));
  assert.equal(pipeline.nextBatchStart(pending, control('a', 1000, 100)), 900);
  // 901 / 902 / 903 都落在同一批里
  assert.equal(scheduler([{ clipId: 'a', frame: 1003 }]).nextBatchStart(pending, control('a', 1000, 100)), 900);
  // 别的片段的 wanted 不动这张卡的顺序
  assert.equal(scheduler([{ clipId: 'other', frame: 1000 }]).nextBatchStart(pending, control('a', 1000, 100)), 0);
  // 已经产过的那一批不在 pending 里 —— 不重排,回到顺序批
  const done = new Set([0, 4, 8]);
  assert.equal(pipeline.nextBatchStart(done, control('a', 1000, 100)), 0);
  // 片段还没挂载 / 已经退场的帧号丢掉
  assert.equal(scheduler([{ clipId: 'a', frame: 50 }]).nextBatchStart(pending, control('a', 1000, 100)), 0);
  assert.equal(scheduler([{ clipId: 'a', frame: 99999 }]).nextBatchStart(pending, control('a', 1000, 100)), 0);
  // 读不到播放头(编辑器还没推过)时不抛
  const blind = { playhead: () => { throw new Error('没有镜像'); }, playheadWanted: FramePipeline.prototype.playheadWanted,
    notePromotion: FramePipeline.prototype.notePromotion, nextBatchStart: FramePipeline.prototype.nextBatchStart };
  assert.equal(blind.nextBatchStart(pending, control('a', 1000, 100)), 0);
});

test('插队记进诊断(预渲染进程的 stdout 被编辑器进程收走了,探针只能从这里看)', () => {
  const pipeline = scheduler([{ clipId: 'a', frame: 1000 }]);
  const pending = new Set(Array.from({ length: 250 }, (_, i) => i * 4));
  pipeline.nextBatchStart(pending, control('a', 1000, 100));
  assert.equal(pipeline.promotions.length, 1);
  assert.equal(pipeline.promotions[0].clipId, 'a');
  assert.equal(pipeline.promotions[0].start, 900);
  assert.equal(pipeline.promotions[0].instead, 0);
  // 留最近 32 条,不无限长
  for (let n = 0; n < 40; n++) pipeline.nextBatchStart(pending, control('a', 1000, 100));
  assert.equal(pipeline.promotions.length, 32);
});

test('wanted 指向的正是顺序批时不重排(也就不会刷日志)', () => {
  const pipeline = scheduler([{ clipId: 'a', frame: 2 }]);
  const pending = new Set([0, 4, 8]);
  assert.equal(pipeline.nextBatchStart(pending, control('a', 12)), 0);
});

test('prerenderSetOf 的兜底口径:direct 不产,其余都产(TODO(R4a) 接真的那份)', () => {
  assert.equal(declaredHeavy({ frameMode: 'direct' }), false);
  assert.equal(declaredHeavy({ frameMode: 'stateful' }), true);
  // unknown 也照测照产(计划 3.1(2):按下层依赖卡处理)
  assert.equal(declaredHeavy({ frameMode: 'stateful', compositing: 'unknown' }), true);
  assert.equal(declaredHeavy({ need_prerendering: true }), true);
  assert.equal(declaredHeavy({ needPrerendering: true }), true);
  assert.equal(declaredHeavy({ need_prerendering: true, frameMode: 'direct' }), false, '声明冲突时以 frameMode 为准');
  assert.equal(declaredHeavy(undefined), false);

  assert.deepEqual([...prerenderSetOfPlan([
    { clipId: 'a', capabilities: { frameMode: 'stateful' } },
    { clipId: 'b', capabilities: { frameMode: 'direct' } },
    { clipId: 'c', capabilities: { frameMode: 'stateful', compositing: 'unknown' } },
    { capabilities: { frameMode: 'stateful' } },
  ])], ['a', 'c']);

  const project = { fps: 30, tracks: [{ clips: [
    { id: 'card-1', cardId: 'particles', mode: 'stateful' },
    { id: 'card-2', cardId: 'caption', mode: 'direct' },
    { id: 'media-1' },
  ] }] };
  assert.deepEqual([...prerenderSetOf(project)], ['card-1'], '素材段不进预渲染集合');
});

/* ------------------------------------------------------------------------ *
 * pinned 渲染 9:预渲染集合是**消费方** —— 在所有位置都判轻的卡不产快照、
 * 不进就绪索引。集合压根没算过(没走过 `adoptCardPlan`)时不过滤。
 * ------------------------------------------------------------------------ */

const statefulControl = (clipId, count = 8) => ({
  clipId, count, snapshotKey: `key-${clipId}`, sampling: { firstFrame: 0 }, end: 100, tier: 'shared',
  capabilities: { frameMode: 'stateful', compositing: 'independent' },
});
const picker = (entry, index = { count: 0, frames: [], oversize: [] }) => ({
  entries: new Map([[entry.key, entry]]),
  prerenderPicked: FramePipeline.prototype.prerenderPicked,
  snapshotTargets: FramePipeline.prototype.snapshotTargets,
  planDiagnostics: FramePipeline.prototype.planDiagnostics,
  missingSnapshotFrames: FramePipeline.prototype.missingSnapshotFrames,
  publishLayer() {},
  snapshots: () => ({ snapshotIndex: async () => index }),
});

test('渲染 9:不在预渲染集合里的卡拿不到快照 target', () => {
  const entry = { key: 'E', project: { fps: 30 }, cardPlan: [statefulControl('heavy'), statefulControl('light')],
    prerenderSet: new Set(['heavy']) };
  const targets = picker(entry).snapshotTargets(entry);
  assert.deepEqual([...targets.keys()], ['heavy'], '判轻的卡不产快照');
  assert.equal(targets.get('heavy').tier, 'shared');
});

test('渲染 9:集合没算过(undefined)时不过滤,行为和接上之前一致', () => {
  const entry = { key: 'E', project: { fps: 30 }, cardPlan: [statefulControl('a'), statefulControl('b')] };
  assert.deepEqual([...picker(entry).snapshotTargets(entry).keys()], ['a', 'b']);
});

test('渲染 9:空集合(全判轻)就一张快照都不产', () => {
  const entry = { key: 'E', project: { fps: 30 }, cardPlan: [statefulControl('a')], prerenderSet: new Set() };
  assert.equal(picker(entry).snapshotTargets(entry).size, 0);
});

test('渲染 9:集合换了之后 snapshotTargets 的缓存跟着换', () => {
  const plan = [statefulControl('a'), statefulControl('b')];
  const entry = { key: 'E', project: { fps: 30 }, cardPlan: plan, prerenderSet: new Set(['a', 'b']) };
  const pipeline = picker(entry);
  assert.equal(pipeline.snapshotTargets(entry).size, 2);
  entry.prerenderSet = new Set(['a']);            // K6 降级 / 重算之后集合变了,cardPlan 没变
  assert.deepEqual([...pipeline.snapshotTargets(entry).keys()], ['a']);
});

test('渲染 9:判轻的卡不算「缺帧」,整场景那一趟不会为它多渲', async () => {
  const entry = { key: 'E', project: { fps: 30, duration: 1 },
    cardPlan: [statefulControl('heavy', 3), statefulControl('light', 3)], prerenderSet: new Set(['heavy']) };
  const frames = await picker(entry).missingSnapshotFrames(entry, { tiers: ['shared'] });
  assert.deepEqual(frames, [0, 1, 2], '只有 heavy 那张卡缺的帧');
  entry.prerenderSet = new Set();
  assert.deepEqual(await picker(entry).missingSnapshotFrames(entry, { tiers: ['shared'] }), []);
});

test('R6-7:会话换一版项目时先让页面清表(reset),旧层不残留;同一版不重复 reset', () => {
  const pipeline = Object.create(FramePipeline.prototype);
  pipeline.ready = createReadyHub();
  const messages = [];
  pipeline.ready.subscribe('s', m => messages.push(m));
  messages.length = 0;
  const plan = [{ clipId: 'a', snapshotKey: 'KA', tier: 'shared', capabilities: { frameMode: 'stateful', compositing: 'independent' } }];
  const entryA = { key: 'E1', project: { fps: 30 } };
  pipeline.adoptSession('s', entryA, 3);
  pipeline.adoptCardPlan(entryA, plan);
  pipeline.publishLayer(entryA, plan[0], 'shared', [[0, 1]]);
  assert.deepEqual(messages.map(m => m.type), ['reset', 'layer'], '换版本先 reset');
  assert.equal(messages[0].localRev, 3, 'reset 带 preload 的 localRev');

  // 同一版项目再来一次(比如重新 preload):不重复 reset
  messages.length = 0;
  pipeline.adoptSession('s', entryA, 4);
  pipeline.adoptCardPlan(entryA, plan);
  assert.deepEqual(messages.map(m => m.type), []);

  // 换一版项目(entry.key 是内容寻址的):再 reset 一次
  messages.length = 0;
  const entryB = { key: 'E2', project: { fps: 30 } };
  pipeline.adoptSession('s', entryB, 5);
  assert.deepEqual(messages.map(m => m.type), [], '计划还没算出来:先不清页面的表(沿用旧结果)');
  pipeline.adoptCardPlan(entryB, []);
  assert.deepEqual(messages.map(m => m.type), ['reset']);
  assert.equal(messages[0].localRev, 5);
  assert.deepEqual(pipeline.ready.peek('s').index.list(), [], '旧层不残留');
});

test('R6-14:超限被丢掉的帧不再算「缺」,下一趟不重渲', async () => {
  const entry = { key: 'E', project: { fps: 30, duration: 1 },
    cardPlan: [statefulControl('heavy', 3)], prerenderSet: new Set(['heavy']) };
  // 第 1 帧上一趟判了超限:剩下第 0、2 帧才算缺
  const index = { count: 0, frames: [], oversize: [[1, 1]] };
  assert.deepEqual(await picker(entry, index).missingSnapshotFrames(entry, { tiers: ['shared'] }), [0, 2]);
  // 三帧全判过(一帧就绪、两帧超限)= 这张卡处理完了,一帧都不用再渲
  const done = { count: 1, frames: [[0, 0]], oversize: [[1, 2]] };
  assert.deepEqual(await picker(entry, done).missingSnapshotFrames(entry, { tiers: ['shared'] }), []);
});

test('渲染 9:诊断露出集合和 costKey(探针的读口)', () => {
  const entry = { key: 'E', project: { fps: 30 },
    cardPlan: [{ ...statefulControl('heavy'), costKey: 'ck-heavy' }, { ...statefulControl('light'), costKey: 'ck-light' }],
    prerenderSet: new Set(['heavy']) };
  const [plan] = picker(entry).planDiagnostics();
  assert.deepEqual(plan.prerenderSet, ['heavy']);
  assert.deepEqual(plan.controls.map(c => [c.clipId, c.costKey, c.picked]),
    [['heavy', 'ck-heavy', true], ['light', 'ck-light', false]]);
});
