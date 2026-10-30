/**
 * C10 契约第 7 节、第 18 节第 9 条〔裁〕:在线页面发布的清单计划,与对 M6c X4 的修改(编号 C10-LP-…)。
 *
 *   LP1 清单计划的形状:`plan:<projectId>@<projectRev>#clips:<sig>`,带片段清单、normal 档;`requires` 不带
 *       envFingerprint / preferNode,只可能带 codeVersion;同一份清单同一个键;入站校验(normal 档、清单非空、签名合法)
 *   LP2 队列:带清单的 plan(清单计划、预渲染重试计划)host 能认领;不带清单的桌面 plan host 认领 0 次(X4 保留);browser 一律不认领
 *   LP3 节点侧规则 6:host 见到带清单的 plan 放行,见到桌面 plan 跳过
 *   LP4 独立主机认领清单计划:用自己的指纹切分;清单里的片段当重卡、不切流、细任务 normal 档;
 *       锁在别的指纹上的卡按锁的指纹出任务(卡片级指纹锁照旧生效)
 *
 * 跑:node --test server/test/c10-list-plan.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue, clipsPlanTaskOf, backfillPlanTaskOf, isListPlan, isClipsPlan, isBackfillPlan, priorityBand } from '../render-queue/index.mjs';
import { parseInbound } from '../render-queue/messages.mjs';
import { planTaskOf } from '../render-node/split.mjs';
import { checkClaimable } from '../render-node/filter.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';

const FP_A = 'aaaaaaaaaaaaaaaa';
const FP_B = 'bbbbbbbbbbbbbbbb';
const CV = 'c0de5a';

test('C10-LP1 清单计划的形状与入站校验', () => {
  const a = clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips: ['c2', 'c1', 'c1'] });
  const b = clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips: ['c1', 'c2'] });
  assert.equal(a.id, b.id, '同一份清单同一个键');
  assert.match(a.id, /^plan:p1@3#clips:[0-9a-z]+$/);
  assert.equal(a.resultKey, a.id.slice('plan:'.length));
  assert.deepEqual(a.input.clips, ['c1', 'c2']);
  assert.equal(a.priority, 'normal');
  assert.equal(priorityBand(a.priority), 'normal');
  assert.deepEqual(a.requires, {}, '不带 envFingerprint、preferNode');
  assert.deepEqual(clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips: ['x'], codeVersion: CV }).requires, { codeVersion: CV });
  assert.ok(isClipsPlan(a) && isListPlan(a) && !isBackfillPlan(a));
  const bf = backfillPlanTaskOf({ projectId: 'p1', projectRev: 3, clips: ['c1', 'c2'] });
  assert.ok(isListPlan(bf) && !isClipsPlan(bf));
  assert.notEqual(bf.id, a.id, '预渲染重试计划与清单计划各用各的键');
  assert.ok(!isListPlan(planTaskOf({ projectId: 'p1', projectRev: 3 })));

  const parse = (task) => parseInbound({ type: 'task.publish', tasks: [task] });
  assert.equal(parse(a).ok, true);
  assert.equal(parse({ ...a, priority: 0 }).ok, true, '整数也是 normal 档');
  assert.equal(parse({ ...a, priority: 'backfill' }).ok, false, '预渲染重试用 #backfill: 的键');
  assert.equal(parse({ ...a, input: {} }).ok, false);
  assert.equal(parse({ ...a, input: { clips: [] } }).ok, false);
  assert.equal(parse({ ...a, resultKey: 'p1@3#clips:BAD!', id: 'plan:p1@3#clips:BAD!' }).ok, false);
  // 预渲染重试计划的旧规则不变
  assert.equal(parse({ ...bf, priority: 'normal' }).ok, false);
});

/** 直接驱动队列:页面(发布方)、pc、host、browser 各一条连接 */
function scene() {
  let now = 1_000;
  const inbox = new Map();
  const q = createRenderQueue({ now: () => now, send: (connId, msg) => { if (!inbox.has(connId)) inbox.set(connId, []); inbox.get(connId).push(msg); }, epoch: 'e1' });
  q.connect('page', { userId: 'member' });
  q.handle('page', { type: 'publisher.hello', publisherId: 'PAGE' });
  q.connect('pc', { userId: 'creator' });
  q.handle('pc', { type: 'node.hello', nodeId: 'PC', profile: 'pc', envFingerprint: FP_A, codeVersions: [CV] });
  q.connect('host', { userId: 'host-user' });
  q.handle('host', { type: 'node.hello', nodeId: 'HOST', profile: 'host', envFingerprint: FP_B, codeVersions: [CV] });
  q.connect('br', { userId: 'member' });
  q.handle('br', { type: 'node.hello', nodeId: 'BR', profile: 'browser', envFingerprint: FP_A, codeVersions: [CV] });
  const take = (connId) => { const list = inbox.get(connId) ?? []; inbox.set(connId, []); return list; };
  const publish = (task) => { q.handle('page', { type: 'task.publish', tasks: [task], reqId: `r${++now}` }); return take('page').find((m) => m.type === 'task.published').results[0]; };
  const claim = (conn, id) => { q.handle(conn, { type: 'task.claim', id, expectVersion: 1, reqId: `c${++now}` }); return take(conn).find((m) => m.type === 'task.claimed' || m.type === 'task.claim-rejected'); };
  return { q, take, publish, claim, advance: (ms) => { now += ms; } };
}

test('C10-LP2 队列:带清单的 plan host 能认领;桌面 plan host 认领 0 次;browser 一律不认领', () => {
  const s = scene();
  const clips = clipsPlanTaskOf({ projectId: 'p1', projectRev: 1, clips: ['c1'], codeVersion: CV });
  assert.equal(s.publish(clips).created, true);
  assert.equal(s.claim('br', clips.id).reason, 'plan-profile', 'browser 不认领 plan');
  const got = s.claim('host', clips.id);
  assert.equal(got.type, 'task.claimed', `host 认领清单计划:${JSON.stringify(got)}`);

  const bf = backfillPlanTaskOf({ projectId: 'p1', projectRev: 1, clips: ['c2'] });
  s.publish(bf);
  assert.equal(s.claim('host', bf.id).type, 'task.claimed', 'host 认领预渲染重试计划');

  // 桌面 plan(不带清单,有 preferNode):X4 照旧,窗口内外 host 都是 plan-profile
  const desk = planTaskOf({ projectId: 'p2', projectRev: 1, codeVersion: CV, envFingerprint: FP_A, preferNode: 'PC' });
  s.publish(desk);
  let hostClaims = 0;
  for (const wait of [0, 6_000, 60_000]) {
    s.advance(wait);
    const r = s.claim('host', desk.id);
    if (r.type === 'task.claimed') hostClaims++;
    else assert.equal(r.reason, 'plan-profile');
  }
  assert.equal(hostClaims, 0, '桌面 plan:host 认领 0 次');
  assert.equal(s.claim('pc', desk.id).type, 'task.claimed', '桌面 plan 照旧给 pc');
});

test('C10-LP3 节点侧规则 6:host 见到带清单的 plan 放行,见到桌面 plan 跳过', () => {
  const host = { profile: 'host', envFingerprint: FP_B, codeVersions: [CV], capabilities: { userCards: true } };
  const view = (t) => ({ ...t, source: { ...t.source, userId: 'u1' } });
  assert.deepEqual(checkClaimable(view(clipsPlanTaskOf({ projectId: 'p', projectRev: 1, clips: ['a'] })), host), { ok: true });
  assert.deepEqual(checkClaimable(view(backfillPlanTaskOf({ projectId: 'p', projectRev: 1, clips: ['a'] })), host), { ok: true });
  assert.deepEqual(checkClaimable(view(planTaskOf({ projectId: 'p', projectRev: 1 })), host), { ok: false, rule: 6, reason: 'plan-on-host' });
  // 清单计划的 codeVersion 照旧查
  const wrong = view(clipsPlanTaskOf({ projectId: 'p', projectRev: 1, clips: ['a'], codeVersion: 'other' }));
  assert.equal(checkClaimable(wrong, host).reason, 'code-version');
  assert.equal(checkClaimable(view(clipsPlanTaskOf({ projectId: 'p', projectRev: 1, clips: ['a'] })), { ...host, profile: 'browser', userId: 'u1' }).reason, 'plan-on-browser');
});

/** 切分用的 PlanContext:两张共享档的卡(c-free 没锁,c-locked 已锁在 FP_A 上)、一条流 */
function context() {
  const control = (clipId, ck) => ({
    clipId, cardId: 'card', key: `png-${clipId}`, snapshotKey: resultKeyOf(ck, FP_B), contentKey: ck, tier: 'shared',
    capabilities: { frameMode: 'stateful', compositing: 'independent' }, cacheable: true, count: 60,
    sampling: { firstFrame: 0, fps: { numerator: 30, denominator: 1 }, phase: { numerator: 0, denominator: 1 } },
  });
  return {
    entryKey: 'entry-1',
    cardPlan: [control('c-free', 'ck-free'.padEnd(64, '0')), control('c-locked', 'ck-lock'.padEnd(64, '0')), control('c-other', 'ck-other'.padEnd(64, '0'))],
    prerenderSet: new Set(['c-other']),
    streams: [{ streamKey: 'stream-1', contentKey: 'stream-1', topClipId: 'c-other', firstSegment: 0, lastSegment: 3 }],
    anchorFrames: [0],
    cardSourceVersions: {},
    weightOf: () => ({ class: 'heavy', estMs: null }),
  };
}

test('C10-LP4 独立主机认领清单计划:用自己的指纹切分、只切清单里的片段、不切流、normal 档;锁住的卡按锁的指纹出任务', async () => {
  let now = 5_000;
  const lb = createLoopback();
  const q = createRenderQueue({ now: () => now, send: lb.queueSend, epoch: 'e1' });
  lb.attach(q);
  // 先有人把 c-locked 的快照锁在 FP_A 上(桌面节点产过它)
  const locker = lb.connect('locker', { userId: 'creator' });
  locker.send({ type: 'publisher.hello', publisherId: 'LOCKER' });
  const lockedCk = 'ck-lock'.padEnd(64, '0');
  const lockedTask = {
    id: `snapshot:${resultKeyOf(lockedCk, FP_A)}:0-59`, kind: 'snapshot', tier: 'shared', resultKey: resultKeyOf(lockedCk, FP_A),
    range: { unit: 'localFrame', from: 0, to: 59 }, source: { projectId: 'p0', projectRev: 1 },
    input: { clipId: 'c-locked', contentKey: lockedCk }, weight: { class: 'heavy', estMs: null, frames: 60 },
    requires: { envFingerprint: FP_A, codeVersion: CV },
  };
  locker.send({ type: 'task.publish', tasks: [lockedTask], reqId: 'lock-1' });
  // 锁在第一次认领时建(F.1):桌面节点(FP_A)认领它
  locker.send({ type: 'node.hello', nodeId: 'LOCKER-NODE', profile: 'pc', envFingerprint: FP_A, codeVersions: [CV] });
  locker.send({ type: 'task.claim', id: lockedTask.id, expectVersion: 1, reqId: 'claim-1' });
  lb.flush();
  // 页面只发布
  const page = lb.connect('page', { userId: 'member' });
  page.send({ type: 'publisher.hello', publisherId: 'PAGE' });
  lb.flush();
  // 独立渲染主机:host 档、指纹 FP_B(与锁定方、与页面的环境都不同)
  const raw = lb.connect('host', { userId: 'host-user' });
  const out = [];
  const endpoint = { send: (m) => { out.push(m); raw.send(m); }, onMessage: (h) => raw.onMessage(h) };
  const plans = [];
  const executor = { async plan(task) { plans.push(task.id); return context(); }, render: () => new Promise(() => {}) };
  const sink = { has: async () => false, put: async () => ({ complete: true }) };
  const events = [];
  const node = createLocalNode({
    nodeId: 'HOST', endpoint, now: () => now, random: () => 0, codeVersion: CV, executor, sink, maxConcurrent: 1, projects: ['p1'],
    node: { profile: 'host', envFingerprint: FP_B, codeVersions: [CV], cardSourceVersions: {}, capabilities: { userCards: true, graphCards: false } },
    onEvent: (e) => events.push(e),
  });
  node.start();
  lb.flush();
  const plan = clipsPlanTaskOf({ projectId: 'p1', projectRev: 2, clips: ['c-free', 'c-locked'], codeVersion: CV });
  page.send({ type: 'task.publish', tasks: [plan], reqId: 'pub-1' });
  for (let i = 0; i < 400 && !events.some((e) => e.type === 'plan-split'); i++) {
    lb.flush();
    await new Promise((r) => setImmediate(r));
    node.tick();
    now += 250;
  }
  assert.deepEqual(plans, [plan.id], 'host 认领了清单计划');
  const derived = out.filter((m) => m.type === 'task.publish').flatMap((m) => m.tasks);
  const byClip = (id) => derived.filter((t) => t.input.clipId === id);
  assert.ok(derived.length > 0, '切出了细任务');
  assert.ok(derived.every((t) => t.kind === 'snapshot'), '不切流');
  assert.ok(derived.every((t) => t.input.clipId !== 'c-other'), '只切清单里的片段(本机判重、不在清单里的不切)');
  assert.ok(derived.every((t) => priorityBand(t.priority) === 'normal'), '细任务 normal 档');
  assert.ok(derived.every((t) => t.source.derivedFrom === plan.id));
  const free = byClip('c-free');
  assert.ok(free.length > 0 && free.every((t) => t.requires.envFingerprint === FP_B && t.resultKey === resultKeyOf('ck-free'.padEnd(64, '0'), FP_B)), '没锁的卡用主机自己的指纹');
  const locked = byClip('c-locked').filter((t) => t.requires.envFingerprint === FP_A);
  assert.ok(locked.length > 0, `锁住的卡改按锁的指纹出任务:${JSON.stringify(byClip('c-locked').map((t) => t.requires.envFingerprint))}`);
  assert.ok(locked.every((t) => t.resultKey === resultKeyOf(lockedCk, FP_A)));
  lb.flush();
  assert.equal(q.describe().tasks.find((t) => t.id === plan.id)?.state, 'done', 'plan 完成');
  node.stop();
});
