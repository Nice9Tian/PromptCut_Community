/**
 * M7-T：切分侧的 D1（浏览器可做的卡按两种指纹各出一份）与 D2（锁闲置超 30 s 才接手的判定）。
 * 依据：`docs/plan/m7-contract.md` 第 3.3、3.4 节，第 13 节裁定 D1、D2、D4；`render-queue-contract.md` B.1、B.4、F.2。
 * 假设见 `m7-kit.mjs` 的 K6、K8；实现不在时 skip。
 * 跑：node --experimental-test-module-mocks --test server/test/m7-split.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPlan } from '../render-node/split.mjs';
import { CARD_LOCK_IDLE_MS } from '../card-lock.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createQueueHarness } from './fake-render-queue-env.mjs';
import { rk, clipsPlan, splitDualGate, idleTakeoverGate, importRepo, gateOpts } from './m7-kit.mjs';

const OWN = '1111111111111111';
const BR = '2222222222222222';
const THIRD = '3333333333333333';

/** 一张卡（card plan 的一项）。缺省是浏览器可做的：共享档、独立、非 canvasHeavy、内置卡 */
function control(clipId, extra = {}) {
  return {
    clipId, cardId: `card-${clipId}`, snapshotKey: rk(`ck-${clipId}`, OWN), contentKey: `ck-${clipId}`, tier: 'shared',
    count: 120, sampling: { firstFrame: 0, step: 1 }, compositing: 'independent', capabilities: { compositing: 'independent' },
    ...extra,
  };
}
/** 切分方的 weightOf：照 `frame-pipeline.mjs` 的 queueWeightClass——本地档、canvasHeavy、belowDependent、unknown 记 heavy，其余 medium */
function weightOf(c) {
  const comp = c.compositing ?? c.capabilities?.compositing;
  if (c.tier === 'local' || c.capabilities?.canvasHeavy === true || comp === 'belowDependent' || comp === 'unknown') return { class: 'heavy', estMs: null };
  return { class: 'medium', estMs: null };
}
const BROWSER = { nodeId: 'n-br', envFingerprint: BR };

function split({ cardPlan, browser = BROWSER, cardLocks = {}, cardSourceVersions = {}, isUserCard, isGraphCard }) {
  const planTask = clipsPlan({ clips: cardPlan.map((c) => c.clipId), input: browser ? { browser } : {} });
  return splitPlan({
    planTask, entryKey: 'entry-1', cardPlan, prerenderSet: null, envFingerprint: OWN, codeVersion: 'cv-1',
    cardSourceVersions, anchorFrames: [0], weightOf, cardLocks,
    ...(isUserCard ? { isUserCard } : {}), ...(isGraphCard ? { isGraphCard } : {}),
    ...(browser ? { browser } : {}),
  });
}
const byClip = (tasks, clipId) => tasks.filter((t) => t.input.clipId === clipId);

test('D1 浏览器可做的卡：每段两份（切分方指纹、浏览器指纹），键按 B.1 各自算，都 dual、都不带 takeover；浏览器那份带 bake 与 compositing', gateOpts(splitDualGate()), () => {
  const tasks = split({ cardPlan: [control('m1')] });
  const mine = byClip(tasks, 'm1');
  assert.equal(mine.length, 4, `120 帧两段 × 两份：${JSON.stringify(mine.map((t) => t.id))}`);
  const own = mine.filter((t) => t.requires.envFingerprint === OWN);
  const br = mine.filter((t) => t.requires.envFingerprint === BR);
  assert.equal(own.length, 2);
  assert.equal(br.length, 2);
  for (const t of own) assert.equal(t.resultKey, rk('ck-m1', OWN));
  for (const t of br) assert.equal(t.resultKey, rk('ck-m1', BR));
  assert.equal(new Set(mine.map((t) => t.id)).size, 4, '四个任务 id 互不相同');
  for (const t of mine) {
    assert.equal(t.input.dual, true, `${t.id} 应带 input.dual`);
    assert.equal('takeover' in t, false, `${t.id} 不带 takeover`);
    assert.equal(t.input.contentKey, 'ck-m1', '两份同一个内容键（同一把锁）');
  }
  for (const t of br) {
    assert.equal(t.input.compositing, 'independent');
    assert.ok(t.input.bake && typeof t.input.bake === 'object', `浏览器那份要 input.bake：${JSON.stringify(t.input)}`);
    assert.ok('count' in t.input.bake && 'sampling' in t.input.bake, `input.bake 要带 count 与 sampling：${JSON.stringify(t.input.bake)}`);
  }
  // 两份的段与优先级一一对应（锚帧段 50、其余 10）
  const seg = (list) => list.map((t) => [t.range.from, t.range.to, t.priority]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(seg(br), seg(own));
  assert.deepEqual(seg(own).map((s) => s[2]), [50, 10]);
});

test('D1 浏览器做不了的卡只出切分方一份、不带 dual：heavy、本地档、非独立、用户卡、素材效果卡、改过源码、锁在第三种环境上', gateOpts(splitDualGate()), () => {
  const cardPlan = [
    control('heavy', { capabilities: { compositing: 'independent', canvasHeavy: true } }),
    control('srcdep', { compositing: 'sourceDependent', capabilities: { compositing: 'sourceDependent' } }),
    control('below', { compositing: 'belowDependent', capabilities: { compositing: 'belowDependent' } }),
    control('user'),
    control('graph'),
    control('modded'),
    control('locked3'),
    control('ok'),
  ];
  const tasks = split({
    cardPlan,
    isUserCard: (c) => c.clipId === 'user',
    isGraphCard: (c) => c.clipId === 'graph',
    cardSourceVersions: { 'card-modded': 'user:abc' },
    cardLocks: { 'snapshot:ck-locked3': THIRD },
  });
  for (const c of cardPlan) {
    const list = byClip(tasks, c.clipId);
    assert.ok(list.length > 0, `${c.clipId} 应有任务`);
    if (c.clipId === 'ok') {
      assert.ok(list.some((t) => t.requires.envFingerprint === BR), '对照：ok 有浏览器那份');
      continue;
    }
    assert.equal(list.some((t) => t.requires.envFingerprint === BR), false, `${c.clipId} 不该出浏览器那份`);
    assert.equal(list.some((t) => t.input.dual === true), false, `${c.clipId} 不该带 dual`);
    if (c.clipId === 'locked3') assert.ok(list.every((t) => t.requires.envFingerprint === THIRD), '锁在第三种环境上的照锁出键（F.2）');
  }
  // 本地档：只要有 entryKey，照旧出一份切分方指纹的
  const local = split({ cardPlan: [control('loc', { tier: 'local' })] });
  assert.equal(local.some((t) => t.requires.envFingerprint === BR || t.input.dual === true), false, '本地档不出浏览器那份');
});

test('D1 清单计划不带浏览器意向时，切分结果与今天相同：没有浏览器那份、没有 dual', gateOpts(splitDualGate()), () => {
  const tasks = split({ cardPlan: [control('m1'), control('m2')], browser: null });
  assert.equal(tasks.length, 4);
  assert.ok(tasks.every((t) => t.requires.envFingerprint === OWN && t.input.dual !== true));
});

test('D1 端到端：切分出的两份经切分节点发布，页面的纯浏览器（本人）看得见浏览器那份并先认领得卡，切分方那份作废', gateOpts(splitDualGate()), () => {
  const h = createQueueHarness(createRenderQueue);
  const USER = 'zoe@devA';
  h.publisher('page', 'pub-page', { userId: USER });
  h.node('pc', 'n-pc', { profile: 'pc', userId: 'rig@pc', watch: ['p1'], hello: { envFingerprint: OWN } });
  h.handle('pc', { type: 'publisher.hello', publisherId: 'pub-pc' });
  h.node('br', 'n-br', { profile: 'browser', userId: USER, watch: ['p1'], hello: { envFingerprint: BR } });
  const plan = clipsPlan({ clips: ['m1'], input: { browser: BROWSER } });
  h.publish('page', [plan]);
  const pc = h.claim('pc', plan.id, 1).last('pc', ['task.claimed', 'task.claim-rejected']);
  assert.equal(pc.type, 'task.claimed', JSON.stringify(pc));
  const tasks = splitPlan({
    planTask: pc.task, entryKey: 'entry-1', cardPlan: [control('m1')], prerenderSet: null, envFingerprint: OWN,
    codeVersion: 'cv-1', anchorFrames: [0], weightOf, browser: BROWSER,
  });
  const res = h.publish('pc', tasks).one('pc', 'task.published').results;
  for (const r of res) assert.equal(r.error, undefined, JSON.stringify(r));
  // 浏览器看得见的只有浏览器那份（身份继承自页面的 plan，前置过滤只给同指纹）
  const seen = h.bus.of('br', 'task.opened').map((m) => m.task).filter((t) => t.kind === 'snapshot');   // 页面自己的清单计划它也看得见（本人任务），只看细任务
  assert.ok(seen.length === 2 && seen.every((t) => t.requires.envFingerprint === BR), JSON.stringify(seen.map((t) => t.id)));
  const brTask = seen.find((t) => t.range.from === 0);
  const c = h.claim('br', brTask.id, brTask.version).last('br', ['task.claimed', 'task.claim-rejected']);
  assert.equal(c.type, 'task.claimed', JSON.stringify(c));
  const d = h.describe();
  for (const t of tasks.filter((x) => x.requires.envFingerprint === OWN)) {
    const s = d.tasks.find((x) => x.id === t.id);
    assert.deepEqual([s.state, s.lastError], ['failed', 'superseded'], `${t.id}：${JSON.stringify(s)}`);
  }
});

/* ================================================================== D2 判定（K8） */

test('D2 切分方的接手判定：锁闲置严格超过 30 s（CARD_LOCK_IDLE_MS）才接手，没有 lockIdleMs 不接手', gateOpts(idleTakeoverGate()), async () => {
  assert.equal(CARD_LOCK_IDLE_MS, 30_000, '与本机锁库同一个数');
  const gate = idleTakeoverGate();
  const fn = (await importRepo(gate.file))[gate.name];
  const key = 'snapshot:ck-1';
  assert.equal(fn(key, BR, { lockIdleMs: 30_000, lockedByProfile: 'browser' }), false, '恰好 30 s 不接手（严格大于）');
  assert.equal(fn(key, BR, { lockIdleMs: 30_001, lockedByProfile: 'browser' }), true);
  assert.equal(fn(key, BR, { lockIdleMs: 5_000, lockedByProfile: 'browser' }), false);
  assert.equal(fn(key, BR, { lockIdleMs: 120_000, lockedByProfile: 'pc' }), true, '闲置的 pc 锁同样接手（语义不分 profile）');
  assert.equal(fn(key, BR, {}), false, '回包里没有 lockIdleMs（旧队列）不接手');
  assert.equal(fn(key, BR), false);
});
