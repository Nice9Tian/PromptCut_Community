/**
 * c10a 契约第 17 节队列一侧的单测(编号 C10A-L17-Q…):语义 `mechanism/document-service.md`「渲染任务队列」的「优先级」。
 * 2026-10-07 起在线页面发布的任务一律普通优先级,`backfill` 档没有新的发布方;队列与节点照旧认它,只为部署切换期间的老页面,
 * 这些用例钉住的是这份兼容。
 *
 *   Q1 认领顺序:normal 先于 backfill,同一优先级按发布先后;节点挑候选时 normal 还有就不碰 backfill
 *   Q2 同一个结果键已有任务不另起(预渲染重试计划任务按片段清单定键;重复发布只合并)
 *   Q3 已有的是 backfill 而又有人按 normal 发布:升为 normal(节点视图收到新的 task.opened);反过来不降
 *   Q4 旧客户端:不带 priority / 带整数照旧按 normal;预渲染重试计划任务的形状校验
 *   Q5 认领预渲染重试计划任务的节点:清单里的片段当重卡切细任务,细任务标 backfill、不切流
 *   Q6 管线:预渲染重试登记按「项目 + 内容身份」并进预渲染集合,普通计划与轨道流不带它们
 *
 * 跑:node --test server/test/c10a-l17-queue.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue, backfillPlanTaskOf, backfillSig, priorityBand, isBackfillPlan } from '../render-queue/index.mjs';
import { parseInbound } from '../render-queue/messages.mjs';
import { rankCandidates, pickCandidate } from '../render-node/pick.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { splitPlan } from '../render-node/split.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';

const FP = '0123456789abcdef';
const CV = 'c0de5a';

/** 一个快照细任务的入站形状(id 由内容决定) */
function fineTask(resultKey, priority, projectId = 'p1') {
  const t = {
    id: `snapshot:${resultKey}:0-59`, kind: 'snapshot', tier: 'shared', resultKey, range: { unit: 'localFrame', from: 0, to: 59 },
    source: { projectId, projectRev: 1 }, input: { clipId: `clip-${resultKey}`, contentKey: `ck-${resultKey}` },
    weight: { class: 'heavy', estMs: null, frames: 60 }, requires: {},
  };
  if (priority !== undefined) t.priority = priority;
  return t;
}

/** 直接驱动队列:发布方 + 一个 pc 节点(watch 'all'),消息按连接收集 */
function rig() {
  let now = 1_000;
  const inbox = new Map();
  const q = createRenderQueue({ now: () => now, send: (connId, msg) => { if (!inbox.has(connId)) inbox.set(connId, []); inbox.get(connId).push(msg); }, epoch: 'e1' });
  q.connect('pub', { userId: 'member' });
  q.handle('pub', { type: 'publisher.hello', publisherId: 'P' });
  q.connect('node', { userId: 'creator' });
  q.handle('node', { type: 'node.hello', nodeId: 'N', profile: 'pc', envFingerprint: FP, codeVersions: [CV] });
  q.handle('node', { type: 'queue.watch', projects: 'all' });
  const take = (connId) => { const list = inbox.get(connId) ?? []; inbox.set(connId, []); return list; };
  return {
    q, take,
    tick(ms) { now += ms; },
    publish(tasks) { q.handle('pub', { type: 'task.publish', tasks, reqId: `r${now}` }); return take('pub').find((m) => m.type === 'task.published'); },
  };
}

test('C10A-L17-Q1 认领顺序:normal 先于 backfill,同一优先级按发布先后;normal 还有时节点一张 backfill 都不挑', () => {
  const r = rig();
  r.publish([fineTask('b1', 'backfill')]); r.tick(10);
  r.publish([fineTask('n1', 10)]); r.tick(10);
  r.publish([fineTask('b2', 'backfill')]); r.tick(10);
  r.publish([fineTask('n2')]); r.tick(10);            // 旧客户端:不带 priority
  r.publish([fineTask('n3', 'normal')]);
  const opened = r.take('node').filter((m) => m.type === 'task.opened').map((m) => m.task);
  assert.equal(opened.length, 5);
  // 排序:档(normal 先)→ 整数名次降序 → 发布先后
  assert.deepEqual(rankCandidates(opened).map((t) => t.resultKey), ['n1', 'n2', 'n3', 'b1', 'b2']);
  // 随机源取到最后一名也挑不到 backfill:只在排头那一档里挑
  for (const random of [() => 0, () => 0.5, () => 0.999]) {
    assert.equal(priorityBand(pickCandidate(opened, { k: 8, random }).priority), 'normal');
  }
  // 按节点的真实做法一张张认领(k = 1):normal 三张认完才轮到 backfill,backfill 按发布先后
  const order = [];
  let view = opened;
  while (view.length) {
    const pick = pickCandidate(view, { k: 1 });
    r.q.handle('node', { type: 'task.claim', id: pick.id, expectVersion: pick.version });
    assert.ok(r.take('node').some((m) => m.type === 'task.claimed' && m.id === pick.id), `认领 ${pick.id}`);
    order.push(pick.resultKey);
    view = view.filter((t) => t.id !== pick.id);
  }
  assert.deepEqual(order, ['n1', 'n2', 'n3', 'b1', 'b2']);
});

test('C10A-L17-Q2 同一个结果键已有任务不另起:细任务重复发布只合并;预渲染重试计划任务按片段清单定键', () => {
  const r = rig();
  const first = r.publish([fineTask('k1', 'backfill')]);
  assert.equal(first.results[0].created, true);
  const again = r.publish([fineTask('k1', 'backfill')]);
  assert.equal(again.results[0].created, false);
  assert.equal(r.q.describe().tasks.length, 1);

  // 预渲染重试计划任务:同一份清单(顺序、重复不影响)同一个键;不同清单不同键;都和普通 plan 的键不同
  const a = backfillPlanTaskOf({ projectId: 'p1', projectRev: 4, clips: ['c2', 'c1', 'c1'] });
  const b = backfillPlanTaskOf({ projectId: 'p1', projectRev: 4, clips: ['c1', 'c2'] });
  const c = backfillPlanTaskOf({ projectId: 'p1', projectRev: 4, clips: ['c1'] });
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.notEqual(a.id, 'plan:p1@4');
  assert.equal(backfillSig(['c2', 'c1']), backfillSig(['c1', 'c2', 'c1']));
  assert.deepEqual(a.input.clips, ['c1', 'c2']);
  assert.equal(a.priority, 'backfill');
  assert.ok(isBackfillPlan(a));
  assert.equal(r.publish([a]).results[0].created, true);
  assert.equal(r.publish([b]).results[0].created, false, '同一批还在等的不另起');
  assert.equal(r.publish([c]).results[0].created, true);
  assert.equal(r.q.describe().tasks.filter((t) => t.id.startsWith('plan:')).length, 2);
});

test('C10A-L17-Q3 已有的 backfill 被 normal 发布升为 normal;normal 不被 backfill 降级', () => {
  const r = rig();
  r.publish([fineTask('u1', 'backfill')]);
  const before = r.take('node').find((m) => m.type === 'task.opened');
  assert.equal(before.task.priority, 'backfill');
  const version = before.task.version;

  const up = r.publish([fineTask('u1', 10)]);
  assert.equal(up.results[0].created, false);
  const reopened = r.take('node').filter((m) => m.type === 'task.opened');
  assert.equal(reopened.length, 1, '升级后节点视图收到一条新的 task.opened');
  assert.equal(reopened[0].task.priority, 10);
  assert.equal(reopened[0].task.version, version, '升级不是状态转移,version 不变');
  assert.equal(priorityBand(reopened[0].task.priority), 'normal');

  // 反过来:已有 normal,再按 backfill 发布,不降
  r.publish([fineTask('u2', 'normal')]);
  r.take('node');
  r.publish([fineTask('u2', 'backfill')]);
  assert.equal(r.take('node').filter((m) => m.type === 'task.opened').length, 0);
  // 升级后的任务照常能认领
  r.q.handle('node', { type: 'task.claim', id: fineTask('u1').id, expectVersion: version });
  assert.ok(r.take('node').some((m) => m.type === 'task.claimed' && m.task.priority === 10));
});

test('C10A-L17-Q4 旧客户端照旧按 normal;priority 与预渲染重试计划任务的形状校验', () => {
  const parse = (task) => parseInbound({ type: 'task.publish', tasks: [task] });
  // 不带 priority → 0;整数原样;'normal' / 'backfill' 原样
  assert.equal(parse(fineTask('a')).body.tasks[0].priority, 0);
  assert.equal(parse(fineTask('a', 50)).body.tasks[0].priority, 50);
  assert.equal(parse(fineTask('a', 'backfill')).body.tasks[0].priority, 'backfill');
  assert.equal(priorityBand(0), 'normal');
  assert.equal(priorityBand(50), 'normal');
  assert.equal(priorityBand(undefined), 'normal');
  // 别的字符串、小数都是格式错误
  assert.equal(parse(fineTask('a', 'urgent')).ok, false);
  assert.equal(parse(fineTask('a', 1.5)).ok, false);
  // 预渲染重试计划任务:必须标 backfill、带非空片段清单、签名合法
  const plan = backfillPlanTaskOf({ projectId: 'p1', projectRev: 2, clips: ['x'] });
  assert.equal(parse(plan).ok, true);
  assert.equal(parse({ ...plan, priority: 'normal' }).ok, false);
  assert.equal(parse({ ...plan, input: {} }).ok, false);
  assert.equal(parse({ ...plan, input: { clips: [] } }).ok, false);
  assert.equal(parse({ ...plan, input: { clips: [''] } }).ok, false);
  const badSig = { ...plan, resultKey: 'p1@2#backfill:BAD!', id: 'plan:p1@2#backfill:BAD!' };
  assert.equal(parse(badSig).ok, false);
  // 普通 plan 照旧:结果键必须等于 projectId@projectRev
  assert.equal(parse({ ...plan, resultKey: 'p1@2', id: 'plan:p1@2', priority: 0, input: {} }).ok, true);
});

/** 预渲染重试测试用的 PlanContext:一张本机判重的卡(c-heavy)、一张本机判轻的卡(c-light)、一条流 */
function contextWithLight() {
  const control = (clipId, label) => ({
    clipId, cardId: 'card', key: `png-${label}`, snapshotKey: `snap-${label}`, contentKey: `snap-${label}`, tier: 'shared',
    capabilities: { frameMode: 'stateful', compositing: 'independent' }, cacheable: true, count: 90,
    sampling: { firstFrame: 0, fps: { numerator: 30, denominator: 1 }, phase: { numerator: 0, denominator: 1 } },
  });
  return {
    entryKey: 'entry-1',
    cardPlan: [control('c-heavy', 'h'), control('c-light', 'l')],
    prerenderSet: new Set(['c-heavy']),
    streams: [{ streamKey: 'stream-1', contentKey: 'stream-1', topClipId: 'c-heavy', firstSegment: 0, lastSegment: 3 }],
    anchorFrames: [0],
    cardSourceVersions: {},
    weightOf: () => ({ class: 'heavy', estMs: null }),
  };
}

test('C10A-L17-Q5 认领预渲染重试计划任务的节点:清单里的片段当重卡切细任务,细任务标 backfill、不切流', async () => {
  let now = 5_000;
  const lb = createLoopback();
  const q = createRenderQueue({ now: () => now, send: lb.queueSend, epoch: 'e1' });
  lb.attach(q);
  // 页面(发 backfill 档的老页面)只发布
  const page = lb.connect('page', { userId: 'member' });
  const pageMsgs = [];
  page.onMessage((m) => pageMsgs.push(m));
  page.send({ type: 'publisher.hello', publisherId: 'page' });
  // 渲染节点:创建者的 pc 节点;记下它发出的 task.publish
  const raw = lb.connect('node', { userId: 'creator' });
  const nodeOut = [];
  const endpoint = { send: (m) => { nodeOut.push(m); raw.send(m); }, onMessage: (h) => raw.onMessage(h) };
  const plans = [];
  const executor = {
    async plan(task) { plans.push(task.id); return contextWithLight(); },
    render: () => new Promise(() => {}),   // 本条只看切分
  };
  const sink = { has: async () => false, put: async () => ({ complete: true }) };
  const events = [];
  const node = createLocalNode({
    nodeId: 'N', endpoint, now: () => now, random: () => 0, codeVersion: CV, executor, sink, maxConcurrent: 1,
    node: { profile: 'pc', envFingerprint: FP, codeVersions: [CV], cardSourceVersions: {}, capabilities: { transcode: true, streams: true, userCards: true, graphCards: true } },
    onEvent: (e) => events.push(e),
  });
  node.start();
  lb.flush();
  const backfill = backfillPlanTaskOf({ projectId: 'p1', projectRev: 7, clips: ['c-light'] });
  page.send({ type: 'task.publish', tasks: [backfill], reqId: 'bf-1' });
  for (let i = 0; i < 200 && !events.some((e) => e.type === 'plan-split'); i++) {
    lb.flush();
    await new Promise((r) => setImmediate(r));
    node.tick();
    now += 250;
  }
  assert.deepEqual(plans, [backfill.id], '节点认领了预渲染重试计划任务');
  const derived = nodeOut.filter((m) => m.type === 'task.publish').flatMap((m) => m.tasks);
  assert.ok(derived.length > 0, '切出了细任务');
  assert.ok(derived.every((t) => t.input.clipId === 'c-light'), '只切清单里的片段(本机判重的卡不在这一批)');
  assert.ok(derived.every((t) => t.kind === 'snapshot'), '预渲染重试不切轨道流');
  assert.ok(derived.every((t) => t.priority === 'backfill'), '细任务同样标 backfill');
  assert.ok(derived.every((t) => t.source.derivedFrom === backfill.id));
  assert.equal(derived.length, 2, '90 帧按 60 帧一段切两段');
  // 页面只发布、不认领:它从没发过 node.hello,队列里也没有它的节点
  assert.ok(!q.describe().nodes.some((n) => n.nodeId === 'page'));
  node.stop();

  // 同一个 splitPlan,普通档(不带 lane)照旧给整数名次
  const normal = splitPlan({ ...contextWithLight(), planTask: { id: 'plan:p1@7', source: { projectId: 'p1', projectRev: 7 } }, envFingerprint: FP, codeVersion: CV });
  assert.ok(normal.every((t) => Number.isInteger(t.priority)));
});

test('C10A-L17-Q6 管线的预渲染重试登记:并进预渲染集合、按内容身份认;普通计划与轨道流不带预渲染重试的片段', async () => {
  const { FramePipeline } = await import('../frame-pipeline.mjs');
  const control = (clipId, label) => ({ clipId, snapshotKey: `snap-${label}`, contentKey: `ck-${label}`, tier: 'shared' });
  const entry = { key: 'e1', project: { id: 'doc-1' }, cardPlan: [control('c-heavy', 'h'), control('c-light', 'l')], basePrerenderSet: new Set(['c-heavy']) };
  entry.prerenderSet = entry.basePrerenderSet;
  const other = { key: 'e2', project: { id: 'doc-1' }, cardPlan: [control('c-heavy', 'h'), control('c-light', 'l')], basePrerenderSet: new Set(['c-heavy']) };
  other.prerenderSet = other.basePrerenderSet;
  const edited = { key: 'e3', project: { id: 'doc-1' }, cardPlan: [control('c-heavy', 'h'), control('c-light', 'l2')], basePrerenderSet: new Set(['c-heavy']) };
  edited.prerenderSet = edited.basePrerenderSet;
  const layerMaps = [];
  const pipe = Object.create(FramePipeline.prototype);
  pipe.entries = new Map([['e1', entry], ['e2', other], ['e3', edited]]);
  pipe.publishLayerMap = (e) => { layerMaps.push(e.key); return true; };

  assert.equal(pipe.prerenderPicked(entry, 'c-light'), false);
  assert.equal(pipe.addBackfill(entry, ['c-light']), 1);
  assert.equal(pipe.prerenderPicked(entry, 'c-light'), true, '进了预渲染集合');
  assert.equal(pipe.prerenderPicked(other, 'c-light'), true, '同一项目、同一内容的另一个 entry 也带上(谁写层表都列着它)');
  assert.equal(pipe.prerenderPicked(edited, 'c-light'), false, '内容改了的不算:新内容没有产物,页面会再发预渲染重试');
  assert.equal(pipe.streamPicked(entry, 'c-light'), false, '轨道流只给本机判重的卡');
  assert.equal(pipe.streamPicked(entry, 'c-heavy'), true);
  assert.deepEqual(layerMaps, ['e1'], '登记之后写一次层表');
  assert.equal(pipe.addBackfill(entry, ['c-light']), 0, '重复登记不再写');
  // 重算集合(新的成本记录)之后预渲染重试的片段仍在
  entry.prerenderSet = entry.basePrerenderSet;
  pipe.applyBackfill(entry);
  assert.equal(pipe.prerenderPicked(entry, 'c-light'), true);
});
