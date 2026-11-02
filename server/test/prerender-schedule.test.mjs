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

test('without wanted, the batches are sequential', () => {
  const pipeline = scheduler(undefined);
  const pending = new Set([0, 4, 8, 12]);
  assert.equal(pipeline.nextBatchStart(pending, control('a', 16)), 0);
  pending.delete(0);
  assert.equal(pipeline.nextBatchStart(pending, control('a', 16)), 4);
});

test('whichever batch wanted falls in moves earlier (local frame = global frame - firstFrame)', () => {
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
  const blind = { playhead: () => { throw new Error('no mirror'); }, playheadWanted: FramePipeline.prototype.playheadWanted,
    notePromotion: FramePipeline.prototype.notePromotion, nextBatchStart: FramePipeline.prototype.nextBatchStart };
  assert.equal(blind.nextBatchStart(pending, control('a', 1000, 100)), 0);
});

test('queue jumps are recorded in diagnostics (the prerender process\'s stdout is consumed by the editor process, so a probe can only see it here)', () => {
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

test('no reordering when wanted points exactly at the sequential batch (so the log is not flooded)', () => {
  const pipeline = scheduler([{ clipId: 'a', frame: 2 }]);
  const pending = new Set([0, 4, 8]);
  assert.equal(pipeline.nextBatchStart(pending, control('a', 12)), 0);
});

test('prerenderSetOf fallback rule: direct is not produced, all others are (TODO(R4a) wire up the real one)', () => {
  assert.equal(declaredHeavy({ frameMode: 'direct' }), false);
  assert.equal(declaredHeavy({ frameMode: 'stateful' }), true);
  // unknown 也照测照产(计划 3.1(2):按下层依赖卡处理)
  assert.equal(declaredHeavy({ frameMode: 'stateful', compositing: 'unknown' }), true);
  assert.equal(declaredHeavy({ need_prerendering: true }), true);
  assert.equal(declaredHeavy({ needPrerendering: true }), true);
  assert.equal(declaredHeavy({ need_prerendering: true, frameMode: 'direct' }), false, 'when declarations conflict, frameMode takes precedence');
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
  assert.deepEqual([...prerenderSetOf(project)], ['card-1'], 'media clips do not enter the prerender set');
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

test('Render 9: cards outside the prerender set get no snapshot target', () => {
  const entry = { key: 'E', project: { fps: 30 }, cardPlan: [statefulControl('heavy'), statefulControl('light')],
    prerenderSet: new Set(['heavy']) };
  const targets = picker(entry).snapshotTargets(entry);
  assert.deepEqual([...targets.keys()], ['heavy'], 'cards classified as light produce no snapshots');
  assert.equal(targets.get('heavy').tier, 'shared');
});

test('Render 9: when the set has not been computed (undefined), nothing is filtered, same behavior as before it was wired in', () => {
  const entry = { key: 'E', project: { fps: 30 }, cardPlan: [statefulControl('a'), statefulControl('b')] };
  assert.deepEqual([...picker(entry).snapshotTargets(entry).keys()], ['a', 'b']);
});

test('Render 9: an empty set (all classified as light) produces not a single snapshot', () => {
  const entry = { key: 'E', project: { fps: 30 }, cardPlan: [statefulControl('a')], prerenderSet: new Set() };
  assert.equal(picker(entry).snapshotTargets(entry).size, 0);
});

test('Render 9: after the set changes, the snapshotTargets cache is replaced along with it', () => {
  const plan = [statefulControl('a'), statefulControl('b')];
  const entry = { key: 'E', project: { fps: 30 }, cardPlan: plan, prerenderSet: new Set(['a', 'b']) };
  const pipeline = picker(entry);
  assert.equal(pipeline.snapshotTargets(entry).size, 2);
  entry.prerenderSet = new Set(['a']);            // K6 降级 / 重算之后集合变了,cardPlan 没变
  assert.deepEqual([...pipeline.snapshotTargets(entry).keys()], ['a']);
});

test('Render 9: a card classified as light does not count as "missing frames", so the whole-scene pass does not render extra for it', async () => {
  const entry = { key: 'E', project: { fps: 30, duration: 1 },
    cardPlan: [statefulControl('heavy', 3), statefulControl('light', 3)], prerenderSet: new Set(['heavy']) };
  const frames = await picker(entry).missingSnapshotFrames(entry, { tiers: ['shared'] });
  assert.deepEqual(frames, [0, 1, 2], 'only the frames missing from the heavy card');
  entry.prerenderSet = new Set();
  assert.deepEqual(await picker(entry).missingSnapshotFrames(entry, { tiers: ['shared'] }), []);
});

test('R6-7: when a session switches to a new project version, the page is first told to clear its table (reset) so no old layers remain; the same version is not reset again', () => {
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
  assert.deepEqual(messages.map(m => m.type), ['reset', 'layer'], 'reset first when the version changes');
  assert.equal(messages[0].localRev, 3, 'reset carries the preload\'s localRev');

  // 同一版项目再来一次(比如重新 preload):不重复 reset
  messages.length = 0;
  pipeline.adoptSession('s', entryA, 4);
  pipeline.adoptCardPlan(entryA, plan);
  assert.deepEqual(messages.map(m => m.type), []);

  // 换一版项目(entry.key 是内容寻址的):再 reset 一次
  messages.length = 0;
  const entryB = { key: 'E2', project: { fps: 30 } };
  pipeline.adoptSession('s', entryB, 5);
  assert.deepEqual(messages.map(m => m.type), [], 'plan not computed yet: do not clear the page\'s table for now (keep the old results)');
  pipeline.adoptCardPlan(entryB, []);
  assert.deepEqual(messages.map(m => m.type), ['reset']);
  assert.equal(messages[0].localRev, 5);
  assert.deepEqual(pipeline.ready.peek('s').index.list(), [], 'no old layers remain');
});

test('R6-14: frames dropped for exceeding the limit no longer count as "missing", so the next pass does not re-render them', async () => {
  const entry = { key: 'E', project: { fps: 30, duration: 1 },
    cardPlan: [statefulControl('heavy', 3)], prerenderSet: new Set(['heavy']) };
  // 第 1 帧上一趟判了超限:剩下第 0、2 帧才算缺
  const index = { count: 0, frames: [], oversize: [[1, 1]] };
  assert.deepEqual(await picker(entry, index).missingSnapshotFrames(entry, { tiers: ['shared'] }), [0, 2]);
  // 三帧全判过(一帧就绪、两帧超限)= 这张卡处理完了,一帧都不用再渲
  const done = { count: 1, frames: [[0, 0]], oversize: [[1, 2]] };
  assert.deepEqual(await picker(entry, done).missingSnapshotFrames(entry, { tiers: ['shared'] }), []);
});

test('Render 9: diagnostics expose the set and costKey (where probes read from)', () => {
  const entry = { key: 'E', project: { fps: 30 },
    cardPlan: [{ ...statefulControl('heavy'), costKey: 'ck-heavy' }, { ...statefulControl('light'), costKey: 'ck-light' }],
    prerenderSet: new Set(['heavy']) };
  const [plan] = picker(entry).planDiagnostics();
  assert.deepEqual(plan.prerenderSet, ['heavy']);
  assert.deepEqual(plan.controls.map(c => [c.clipId, c.costKey, c.picked]),
    [['heavy', 'ck-heavy', true], ['light', 'ck-light', false]]);
});
