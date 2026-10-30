/**
 * M3 进程内集成：本机节点编排（`createLocalNode`）× 真队列（`createRenderQueue`），经环回传输、
 * 假执行器、内存产物库串成端到端链路（契约 `docs/plan/render-queue-contract.md` D 节，用例 I1～I10，另加 I11：版本更迭时已存在的细任务并入订阅、补发）。
 * 跑：node --test server/test/render-queue-inproc.test.mjs
 *
 * 只照契约 D 节、A 节（队列消息与行为）、B.4 / B.5 和设计 `docs/plan/distributed-prerender-queue.md`
 * 写，不看 `local-node.mjs` 的实现；被测模块只经 D.2 的公开接口驱动（start / tick / yieldAll / stop /
 * running / settled / session / onEvent）。
 *
 * 拓扑：一个队列、一条环回、若干本机节点、一到两个页面发布方（页面直接用环回端点发 `publisher.hello`
 * 和 `task.publish`）。全部用假时钟（`createTimerClock`），不用真实计时器等待。
 *
 * 驱动循环（D.4）：flush → 让出事件循环（setImmediate，让假执行器和假产物库的 Promise 落定）→
 * 各节点 tick → queue.tick → 条件不满足时推进假时钟。循环有步数上限，超了就失败并打印 `describe()`。
 *
 * 每条用例都检查（`hygiene`）：端点处理器没抛异常（`errors()` 为空）、投递过的每条消息都能 JSON 往返、
 * 队列没回过 `error`、产物库没收到不合 D.1 的调用、没有未处理的 Promise 拒绝。
 *
 * 断言只取契约 / 设计写明了的东西。几处契约没写死的，测试绕开：
 *   - 同一步里哪个节点先抢到哪个任务（随机源固定种子，但不断言具体归属，只断言「恰好一次」「谁不能认领」）；
 *   - 完成之后 `lastError` 还留不留（只在回收那一刻读 `describe()` 里的 `lastError`）；
 *   - 节点开工时的 `task.progress { done: 0 }`（D.2 裁定）之外还发了哪些进度，不断言消息的精确序列。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { createArtifactSink } from './fake-artifact-sink.mjs';
import { createFakeExecutor, createTimerClock } from './fake-render-executor.mjs';

// ---------------------------------------------------------------- 常量（契约 A.2 的缺省值，只用来推算时间窗口）

const LEASE_MS = 30_000;
const RECONNECT_GRACE_MS = 10_000;
const STALL_MS = 120_000;
const STEP_MS = 250;

const FP_A = '0123456789abcdef';
const FP_B = 'fedcba9876543210';
const CV = 'c0de5a';
const FPS = 30;

// ---------------------------------------------------------------- 未处理的 Promise 拒绝

const unhandled = [];
process.on('unhandledRejection', reason => { unhandled.push(reason); });

// ---------------------------------------------------------------- 小工具

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
/** 契约 B.1：resultKey = sha256(`${contentKey}\n${envFingerprint}`)，测试自己算，不借实现 */
const resultKeyOf = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);
const sorted = list => [...list].sort();
const counts = list => list.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());

/** 固定种子的伪随机数（mulberry32），[0, 1)。 */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** 页面发布的粗任务（契约 B.4 planTaskOf 的形状，测试自己写）。 */
function planTaskInput(projectId, projectRev, priority = 0) {
  return {
    id: `plan:${projectId}@${projectRev}`, kind: 'plan', resultKey: `${projectId}@${projectRev}`, range: null,
    source: { projectId, projectRev }, input: {}, weight: { class: 'medium', estMs: null, frames: null },
    requires: {}, priority,
  };
}
const planIdOf = (projectId, projectRev) => `plan:${projectId}@${projectRev}`;

// ---------------------------------------------------------------- PlanContext 夹具

/**
 * 按 `server/card-cache.mjs` 的 plan() 输出造一个 control（字段与它 push 的对象一致，另带 cardId）。
 * `tier` 按 `snapshotTier(capabilities)` 的规则手写：stateful + independent → shared，
 * stateful + belowDependent → local，stateless → none。
 */
function control({ clipId, cardId, label, capabilities, start, count }) {
  const compositing = capabilities.compositing ?? 'unknown';
  const stateful = capabilities.frameMode === 'stateful';
  const tier = !stateful ? 'none' : (compositing === 'independent' || compositing === 'sourceDependent') ? 'shared' : 'local';
  const firstFrame = Math.ceil(start * FPS - 1e-9);
  return {
    key: sha256(`png:${label}`), snapshotKey: sha256(`snap:${label}`), costKey: sha256(`cost:${label}`),
    frameMode: capabilities.frameMode, tier, capabilities, clipId, nodeId: `n:${clipId}`,
    start, end: start + count / FPS, count,
    sampling: { firstFrame, fps: { numerator: FPS, denominator: 1 }, phase: { numerator: 0, denominator: 1 } },
    compositing, cacheable: compositing === 'independent', needPrerendering: false,
    appearance: { frame: null, opacity: 1, width: 1920, height: 1080 },
    cardId,
  };
}

const WEIGHTS = { 'clip-title': 'heavy', 'clip-glass': 'medium', 'clip-lower': 'light', 'clip-video': 'heavy' };

/**
 * 一版项目的 PlanContext（D.1，原样喂给 splitPlan）：
 *   标题（粒子卡，共享档，130 帧 → 3 段，heavy）
 *   毛玻璃（本地档，45 帧 → 1 段，medium）
 *   下三分之一（共享档，70 帧 → 2 段，light）
 *   纯文本（无状态，档位 none → 不切）
 *   一条轨道流（第 0～11 段 → 2 个流任务，heavy）
 * 共 8 个细任务。`salt` 换一套内容键（别的项目用）。
 */
function planContextFor(salt = 'p1') {
  const stateful = { frameMode: 'stateful', compositing: 'independent' };
  return {
    entryKey: sha256(`entry:${salt}`),
    cardPlan: [
      control({ clipId: 'clip-title', cardId: 'particles', label: `${salt}:title`, capabilities: stateful, start: 0, count: 130 }),
      control({ clipId: 'clip-glass', cardId: 'glass', label: `${salt}:glass`, capabilities: { frameMode: 'stateful', compositing: 'belowDependent' }, start: 2, count: 45 }),
      control({ clipId: 'clip-lower', cardId: 'lowerThird', label: `${salt}:lower`, capabilities: stateful, start: 1, count: 70 }),
      control({ clipId: 'clip-text', cardId: 'text', label: `${salt}:text`, capabilities: { frameMode: 'stateless', compositing: 'independent' }, start: 0, count: 90 }),
    ],
    prerenderSet: new Set(['clip-title', 'clip-glass', 'clip-lower', 'clip-text']),
    streams: [{ streamKey: sha256(`stream:${salt}`), topClipId: 'clip-video', firstSegment: 0, lastSegment: 11 }],
    anchorFrames: [90],
    // 定制卡的代码身份：c66-host-cards 起只列用户卡与改动层里改过的卡，没改过的内置卡不在这里（由 codeVersion 覆盖）；
    // 原来写的 { particles: 'builtin:12', lowerThird: 'builtin:3' } 是那之前的形状。M7 D1 起切分方只给「cardSources 为空」的
    // 内置卡出浏览器那一份（写 input.compositing，纯浏览器的规则 7 要它），I5 的浏览器要靠它认领到本人的轻任务
    cardSourceVersions: {},
    weightOf: c => ({ class: WEIGHTS[c.clipId] ?? 'medium', estMs: null }),
    isUserCard: () => false,
    isGraphCard: () => false,
  };
}

/**
 * 同一项目的下一版（I11）：只改了「下三分之一」这张卡（它的共享键变了），其余卡的共享键、轨道流键不变。
 * entry.key 随版本变（真实情形），所以本地档的毛玻璃卡键也变、要重渲；共享档与流不受影响。
 */
function planContextV2(salt = 'p1') {
  const ctx = planContextFor(salt);
  ctx.entryKey = sha256(`entry:${salt}:v2`);
  ctx.cardPlan = ctx.cardPlan.map(c => (c.clipId !== 'clip-lower' ? c
    : control({ clipId: 'clip-lower', cardId: 'lowerThird', label: `${salt}:lower:v2`, capabilities: c.capabilities, start: c.start, count: c.count })));
  return ctx;
}

/** 按契约 B.4 自己算出这份 PlanContext 应当切出的细任务（只取断言用得到的字段）。 */
function expectedDerived(ctx, fp) {
  const out = [];
  for (const c of ctx.cardPlan) {
    if (!c.snapshotKey || !c.clipId) continue;
    if (ctx.prerenderSet && !ctx.prerenderSet.has(c.clipId)) continue;
    if (c.tier !== 'shared' && c.tier !== 'local') continue;
    const contentKey = c.tier === 'shared' ? c.snapshotKey : `${ctx.entryKey}/${c.snapshotKey}`;
    const resultKey = resultKeyOf(contentKey, fp);
    for (let from = 0; from < c.count; from += 60) {
      const to = Math.min(c.count - 1, from + 59);
      out.push({
        id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier: c.tier, resultKey, contentKey,
        range: { unit: 'localFrame', from, to }, weightClass: ctx.weightOf(c).class, clipId: c.clipId,
      });
    }
  }
  for (const s of ctx.streams) {
    const resultKey = resultKeyOf(s.streamKey, fp);
    // 稀疏流整条流一个任务(rr-motion-preempt 规则);满密度任务按 8 段切分
    out.push({
      id: `stream:${resultKey}:${s.firstSegment}-${s.lastSegment}:sparse`, kind: 'stream', tier: null, resultKey, contentKey: s.streamKey,
      range: { unit: 'segment', from: s.firstSegment, to: s.lastSegment }, weightClass: ctx.weightOf({ clipId: s.topClipId }).class, clipId: s.topClipId,
      density: 'sparse',
    });
    for (let from = s.firstSegment; from <= s.lastSegment; from += 8) {
      const to = Math.min(s.lastSegment, from + 7);
      out.push({
        id: `stream:${resultKey}:${from}-${to}`, kind: 'stream', tier: null, resultKey, contentKey: s.streamKey,
        range: { unit: 'segment', from, to }, weightClass: ctx.weightOf({ clipId: s.topClipId }).class, clipId: s.topClipId,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 节点描述（契约 B.2）

const CARD_VERSIONS = { particles: ['builtin:12'], lowerThird: ['builtin:3'] };

function pcNode(fp, userId) {
  return {
    profile: 'pc', userId, envFingerprint: fp, codeVersions: [CV], cardSourceVersions: CARD_VERSIONS,
    capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 16_000 },
  };
}
function browserNode(fp, userId) {
  return {
    profile: 'browser', userId, envFingerprint: fp, codeVersions: [CV], cardSourceVersions: CARD_VERSIONS,
    capabilities: { transcode: false, userCards: false, graphCards: false, memoryMB: 1_500 },
  };
}

// ---------------------------------------------------------------- 拼装

/**
 * 一套进程内环境。`clock`、`sink`、`exec` 可以从上一套沿用（I10 队列重启：产物库和执行器活得比队列久）。
 */
function createRig({ epoch = 'epoch-1', clock, sink, exec, planContext } = {}) {
  clock ??= createTimerClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch });
  lb.attach(queue);
  sink ??= createArtifactSink();
  exec ??= createFakeExecutor({ clock, planContext: planContext ?? (task => planContextFor(task.source.projectId)) });
  const nodes = [];
  const pages = [];

  function addPage(name, { userId = 'u1', tenantId = 't1', publisherId = `page-${name}` } = {}) {
    const ep = lb.connect(`conn-${name}`, { userId, tenantId });
    const inbox = [];
    ep.onMessage(m => { inbox.push(m); });
    ep.send({ type: 'publisher.hello', publisherId });
    const page = {
      name, ep, inbox, publisherId, connId: ep.connId,
      publishPlan(projectId, projectRev, priority = 0) { ep.send({ type: 'task.publish', tasks: [planTaskInput(projectId, projectRev, priority)] }); },
      of: type => inbox.filter(m => m.type === type),
      doneCount: id => inbox.filter(m => m.type === 'task.done' && m.id === id).length,
      done: id => inbox.find(m => m.type === 'task.done' && m.id === id),
      failedOf: id => inbox.filter(m => m.type === 'task.failed' && m.id === id),
    };
    pages.push(page);
    return page;
  }

  function addNode(nodeId, { fp = FP_A, profile = 'pc', userId = 'u9', tenantId = 't1', maxConcurrent = 1, seed = 1, node, projects } = {}) {
    const ep = lb.connect(`conn-${nodeId}`, { userId, tenantId });
    const rec = { nodeId, ep, connId: ep.connId, fp, idle: true, ticking: true, stopped: false, events: [] };
    rec.node = node ?? (profile === 'browser' ? browserNode(fp, userId) : pcNode(fp, userId));
    rec.local = createLocalNode({
      nodeId, node: rec.node, endpoint: ep,
      now: clock.now, random: seeded(seed), isIdle: () => rec.idle, maxConcurrent,
      codeVersion: CV, executor: exec.forNode(nodeId), sink,
      ...(projects ? { projects } : {}),   // M6c X3：纯浏览器不能 watch 'all'，要列出项目
      onEvent: event => { rec.events.push(event); },
    });
    rec.eventsOf = type => rec.events.filter(e => e.type === type);
    rec.stop = () => { rec.stopped = true; rec.local.stop(); };
    nodes.push(rec);
    return rec;
  }

  /** 已投递的队列 → 端点消息里，某类型的全部：[{ connId, message, index }] */
  function out(type) {
    return lb.log().map((e, index) => ({ ...e, index })).filter(e => e.dir === 'out' && e.message.type === type);
  }
  /** 已投递的端点 → 队列消息里，某类型的全部 */
  function inbound(type) {
    return lb.log().map((e, index) => ({ ...e, index })).filter(e => e.dir === 'in' && e.message.type === type);
  }
  const task = id => queue.describe().tasks.find(t => t.id === id) ?? null;

  return { clock, lb, queue, sink, exec, nodes, pages, addPage, addNode, out, inbound, task };
}

/** 投递到收敛：flush → 让出事件循环，直到没有待投消息（给异步续体留足机会）。 */
async function settle(rig) {
  for (let round = 0; round < 1_000; round++) {
    rig.lb.flush();
    await new Promise(resolve => setImmediate(resolve));
    if (rig.lb.pending() === 0) {
      await new Promise(resolve => setImmediate(resolve));
      if (rig.lb.pending() === 0) return;
    }
  }
  throw new Error('消息往返不收敛');
}

/** 等 `promise` 落定，最多让出 `turns` 轮事件循环（不推进假时钟）；到时还没落定就失败。 */
async function within(promise, what, turns = 50) {
  let settledFlag = false;
  const guarded = Promise.resolve(promise).finally(() => { settledFlag = true; });
  for (let i = 0; i < turns && !settledFlag; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(settledFlag, what);
  return guarded;
}

/** 一拍：flush / 让出 → 各节点 tick → queue.tick（每一步后都投递到收敛）。 */
async function beat(rig, onStep, step) {
  await settle(rig);
  if (onStep) {
    await onStep(step);
    await settle(rig);
  }
  for (const n of rig.nodes) if (n.ticking && !n.stopped) n.local.tick();
  await settle(rig);
  rig.queue.tick();
  await settle(rig);
}

/** 驱动到 `until()` 成立；条件不满足就推进假时钟。超过步数上限失败并打印 describe()。 */
async function drive(rig, until, { maxSteps = 4_000, stepMs = STEP_MS, onStep } = {}) {
  for (let step = 0; step < maxSteps; step++) {
    await beat(rig, onStep, step);
    if (until()) return step;
    rig.clock.advance(stepMs);
  }
  assert.fail(`超过 ${maxSteps} 步仍未满足条件；queue.describe()：\n${JSON.stringify(rig.queue.describe(), null, 1)}`
    + `\n节点在跑：${JSON.stringify(rig.nodes.map(n => [n.nodeId, n.stopped ? 'stopped' : n.local.running()]))}`);
}

/** 条件满足后再空转几拍，看有没有迟到的重复完成之类。 */
async function coast(rig, steps = 40, stepMs = STEP_MS) {
  for (let i = 0; i < steps; i++) {
    await beat(rig);
    rig.clock.advance(stepMs);
  }
  await beat(rig);
}

/** 节点都没活了（`except` 里的节点不算：它手里有卡住的执行，要等测试放开） */
const allRunningEmpty = (rig, except = []) => rig.nodes.every(n => n.stopped || except.includes(n) || n.local.running().length === 0);

/** 每条用例都要成立的卫生条件（D.4 末段）。 */
function hygiene(rig, { unhandledBefore = 0 } = {}) {
  assert.deepEqual(rig.lb.errors().map(e => String(e?.stack ?? e)), [], '端点处理器 / queue.handle 抛出了异常');
  assert.deepEqual(rig.lb.nonJson(), [], '有消息不能 JSON 往返');
  for (const e of rig.lb.log()) {
    assert.deepEqual(JSON.parse(JSON.stringify(e.message)), e.message, `消息 JSON 往返后变样：${JSON.stringify(e.message)}`);
  }
  const errors = rig.out('error').map(e => [e.connId, e.message]);
  assert.deepEqual(errors, [], '队列回过 error（格式错误或角色不对）');
  assert.deepEqual(rig.sink.misuse(), [], '产物库收到了不合 D.1 的调用');
  assert.deepEqual(rig.exec.errors().map(String), [], '执行器的 progress 回调抛出了异常');
  assert.deepEqual(unhandled.slice(unhandledBefore).map(e => String(e?.stack ?? e)), [], '有未处理的 Promise 拒绝');
}

/** 每个 id：页面恰好一条 task.done、队列恰好回过一次 task.completed、describe 里是 done。 */
function assertCompletedOnce(rig, page, ids) {
  const completed = counts(rig.out('task.completed').map(e => e.message.id));
  const view = new Map(rig.queue.describe().tasks.map(t => [t.id, t]));
  for (const id of ids) {
    assert.equal(page.doneCount(id), 1, `${id}：页面应恰好收到一条 task.done，实际 ${page.doneCount(id)}`);
    assert.equal(completed.get(id) ?? 0, 1, `${id}：队列应恰好确认一次完成，实际 ${completed.get(id) ?? 0}`);
    assert.equal(view.get(id)?.state, 'done', `${id}：describe 里应是 done`);
  }
}

/** 认领成功的记录：[{ connId, id, task }] */
const claimsOf = rig => rig.out('task.claimed').map(e => ({ connId: e.connId, id: e.message.id, task: e.message.task, index: e.index }));

/** 页面每个 id 都收到 task.done，且节点都没活了（`except` 见 allRunningEmpty）。 */
const allDone = (rig, page, ids, except = []) => () => ids.every(id => page.doneCount(id) >= 1) && allRunningEmpty(rig, except);

// ================================================================ I1

test('I1 全链路：页面发布 plan，两个 pc 节点认领、切分、执行、推产物、报完成；页面收到全部 task.done', async () => {
  const before = unhandled.length;
  const rig = createRig();
  const page = rig.addPage('page', { userId: 'u1', tenantId: 't1', publisherId: 'page-u1' });
  // 节点的连接凭证是另一个用户（同租户）：细任务的 userId 应继承 plan 的（页面的），而不是切分节点的
  const a = rig.addNode('node-a', { fp: FP_A, userId: 'u9', seed: 1 });
  const b = rig.addNode('node-b', { fp: FP_A, userId: 'u9', seed: 2 });
  a.local.start();
  b.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);

  const planId = planIdOf('p1', 1);
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  assert.equal(expected.length, 9, '夹具应切出 9 个细任务(6 个快照、1 个稀疏流、2 个满密度流)');
  assert.ok(expected.some(t => t.kind === 'snapshot') && expected.some(t => t.kind === 'stream'));
  const ids = [planId, ...expected.map(t => t.id)];

  await drive(rig, allDone(rig, page, ids));
  await coast(rig);

  // 恰有一个节点认领并切分 plan
  const planClaims = claimsOf(rig).filter(c => c.id === planId);
  assert.equal(planClaims.length, 1, 'plan 应恰好被认领一次');
  const splitter = rig.nodes.find(n => n.connId === planClaims[0].connId);
  const splits = rig.nodes.flatMap(n => n.eventsOf('plan-split').map(e => ({ nodeId: n.nodeId, e })));
  assert.equal(splits.length, 1, '应恰好切分一次');
  assert.equal(splits[0].nodeId, splitter.nodeId);
  assert.equal(splits[0].e.id, planId);
  assert.deepEqual(sorted(splits[0].e.derived), sorted(expected.map(t => t.id)));
  assert.equal(rig.exec.calls({ kind: 'plan' }).length, 1, 'executor.plan 只调一次');

  // plan 的 task.done：result = { ranges: null, derived }（D.2 第 4 步）
  const planDone = page.done(planId);
  assert.equal(planDone.result.ranges, null);
  assert.deepEqual(sorted(planDone.result.derived), sorted(expected.map(t => t.id)));

  // 每个任务恰好完成一次
  assertCompletedOnce(rig, page, ids);
  const view = rig.queue.describe();
  assert.deepEqual(sorted(view.tasks.map(t => t.id)), sorted(ids));
  for (const t of view.tasks) {
    assert.equal(t.state, 'done', t.id);
    assert.equal(t.attempts, 0, `${t.id} attempts`);
  }
  assert.equal(rig.out('task.lease-lost').length, 0, '顺利路径上不应丢认领');

  // 细任务：继承页面的用户与订阅；指纹、代码版本是切分节点的
  const derivedClaims = claimsOf(rig).filter(c => c.id !== planId);
  assert.deepEqual(sorted(derivedClaims.map(c => c.id)), sorted(expected.map(t => t.id)), '每个细任务恰好认领一次');
  for (const { id, task } of derivedClaims) {
    const exp = expected.find(t => t.id === id);
    assert.equal(task.kind, exp.kind, id);
    assert.equal(task.resultKey, exp.resultKey, id);
    assert.deepEqual(task.range, exp.range, id);
    assert.equal(task.source.userId, 'u1', `${id}：source.userId 应是页面的用户`);
    assert.equal(task.source.tenantId, 't1', id);
    assert.equal(task.source.projectId, 'p1', id);
    assert.equal(task.source.projectRev, 1, id);
    assert.equal(task.source.derivedFrom, planId, id);
    assert.equal(task.source.publisher.id, splitter.nodeId, `${id}：发布方是切分节点（publisherId 缺省等于 nodeId）`);
    assert.equal(task.requires.envFingerprint, FP_A, id);
    assert.equal(task.requires.codeVersion, CV, id);
  }
  for (const t of view.tasks.filter(t => t.id !== planId)) {
    assert.ok(t.subscribers.includes('page-u1'), `${t.id}：页面应继承订阅`);
  }

  // 产物库：每个结果键的每一段都在，每段恰好推了一次，记账信息对得上完成者
  const completer = new Map(rig.out('task.completed').map(e => [e.message.id, rig.nodes.find(n => n.connId === e.connId).nodeId]));
  for (const t of expected) {
    assert.ok(rig.sink.holds(t.resultKey, t.range), `${t.id}：产物库里应有这一段`);
    // 一条流的稀疏流任务和满密度任务推的是同一个键、同一段,各推一次:按任务 id 分开数
    const puts = rig.sink.puts().filter(p => p.resultKey === t.resultKey && p.range.from === t.range.from && p.range.to === t.range.to && p.meta?.taskId === t.id);
    assert.equal(puts.length, 1, `${t.id}：应恰好推一次`);
    assert.equal(puts[0].meta.taskId, t.id);
    assert.equal(puts[0].meta.nodeId, completer.get(t.id), `${t.id}：meta.nodeId 应是完成它的节点`);
    assert.ok(Number.isInteger(puts[0].meta.token));
    assert.equal(rig.exec.renderCount(t.id), 1, `${t.id}：应恰好渲染一次`);
    assert.deepEqual(page.done(t.id).result.ranges, [[t.range.from, t.range.to]], `${t.id}：ranges`);
    assert.equal(page.done(t.id).resultKey, t.resultKey);
  }
  // 产物库按「结果键 + 范围」存(同 writeManifest):每个任务自己的键一项;稀疏流整条流一个任务,另按 8 段一桶写,
  // 那几个桶与满密度任务的键相同、共用一项,满密度的盖掉稀疏的
  const keyOf = t => `${t.resultKey}#${t.range.from}-${t.range.to}`;
  assert.equal(rig.sink.entries().length, new Set(expected.map(keyOf)).size);
  for (const t of expected.filter(x => x.kind === 'stream' && !x.density)) {
    assert.ok(rig.sink.stores(t.resultKey, t.range), `${t.id}：满密度任务的键(也是桶)存着`);
    assert.notEqual(rig.sink.entries().find(e => keyOf(e) === keyOf(t)).sparse, true, `${t.id}：桶是满密度的那一版`);
  }
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I2

test('I2 产物库已有部分结果：这些段不调 executor.render，直接完成（dedup）；其余照常渲染', async () => {
  const before = unhandled.length;
  const rig = createRig();
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  // 预置三段：标题第一段、下三分之一第二段、轨道流第二段
  const seeded3 = [
    expected.find(t => t.clipId === 'clip-title' && t.range.from === 0),
    expected.find(t => t.clipId === 'clip-lower' && t.range.from === 60),
    expected.find(t => t.kind === 'stream' && t.range.from === 8 && !t.density),
  ];
  assert.ok(seeded3.every(Boolean));
  for (const t of seeded3) rig.sink.seed({ resultKey: t.resultKey, range: t.range });
  // 预置三段：标题第一段、下三分之一第二段、轨道流第二段(稀疏流整条流 0-11 与满密度 8-11 范围不同，此处匹配 3 项)
  const seededAll = expected.filter(t => seeded3.some(s => s.resultKey === t.resultKey && s.range.from === t.range.from && s.range.to === t.range.to));
  assert.equal(seededAll.length, 3);

  // 这一条先发布、后让节点报到：节点经 queue.snapshot 看到 plan
  const page = rig.addPage('page', { publisherId: 'page-u1' });
  await settle(rig);
  page.publishPlan('p1', 1);
  await settle(rig);
  const a = rig.addNode('node-a', { seed: 3 });
  const b = rig.addNode('node-b', { seed: 4 });
  a.local.start();
  b.local.start();

  const planId = planIdOf('p1', 1);
  const ids = [planId, ...expected.map(t => t.id)];
  await drive(rig, allDone(rig, page, ids));
  await coast(rig);

  assertCompletedOnce(rig, page, ids);
  const dedupIds = rig.nodes.flatMap(n => n.eventsOf('dedup').map(e => e.id));
  for (const t of seededAll) {
    assert.equal(rig.exec.renderCount(t.id), 0, `${t.id}：已在产物库里，不应渲染`);
    assert.equal(page.done(t.id).result.dedup, true, `${t.id}：task.done 的 result 应带 dedup: true`);
    assert.deepEqual(page.done(t.id).result.ranges, [[t.range.from, t.range.to]]);
    assert.equal(rig.sink.puts().filter(p => p.meta?.taskId === t.id).length, 0, `${t.id}：不应再推产物`);
    assert.ok(dedupIds.includes(t.id), `${t.id}：应报 dedup 事件`);
  }
  for (const t of expected.filter(t => !seededAll.includes(t))) {
    assert.equal(rig.exec.renderCount(t.id), 1, `${t.id}：应恰好渲染一次`);
    assert.notEqual(page.done(t.id).result.dedup, true, `${t.id}：不是去重完成的`);
    assert.ok(rig.sink.holds(t.resultKey, t.range));
  }
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I3

test('I3 执行中节点断开（partition 后 close）：宽限期后另一节点接手完成；断开节点的迟到结果被丢弃', async () => {
  const before = unhandled.length;
  const rig = createRig();
  // node-a 的细任务渲染一律卡住（直到测试放开），这样它断开时手里一定有一个在跑的任务
  rig.exec.on((task, { nodeId }) => nodeId === 'node-a' && task.kind !== 'plan', { hang: true });
  const page = rig.addPage('page', { publisherId: 'page-u1' });
  const a = rig.addNode('node-a', { seed: 5 });
  const b = rig.addNode('node-b', { seed: 6 });
  a.local.start();
  b.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);

  const planId = planIdOf('p1', 1);
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  const ids = [planId, ...expected.map(t => t.id)];

  // 1) 等 node-a 手里有一个卡住的细任务
  await drive(rig, () => rig.exec.hung().some(c => c.nodeId === 'node-a'));
  const victim = rig.exec.hung().find(c => c.nodeId === 'node-a').id;
  assert.ok(a.local.running().includes(victim));
  const token = a.local.session.held().find(h => h.id === victim)?.token;
  assert.ok(Number.isInteger(token), 'node-a 此刻应持有 victim');

  // 2) 分区：双向消息丢弃；2 秒后关闭连接
  rig.lb.partition(a.connId);
  const cutIndex = rig.lb.log().length;
  for (let i = 0; i < 8; i++) { await beat(rig); rig.clock.advance(STEP_MS); }
  a.ep.close();
  const closedAt = rig.clock.now();

  // 3) 宽限期后被回收、另一节点接手完成
  let reclaimedAt = null;
  let reclaimError = null;
  // node-a 卡住的执行要等第 4 步才放开，所以这里不等它的在跑表清空
  await drive(rig, allDone(rig, page, ids, [a]), {
    onStep: () => {
      const t = rig.task(victim);
      if (reclaimedAt === null && t && t.attempts === 1) {
        reclaimedAt = rig.clock.now();
        reclaimError = t.lastError;
      }
    },
  });
  assert.ok(reclaimedAt !== null, 'victim 应被回收过');
  assert.ok(reclaimedAt - closedAt > RECONNECT_GRACE_MS, `应在宽限期（${RECONNECT_GRACE_MS} ms）之后才回收，实际 ${reclaimedAt - closedAt} ms`);
  // 回收发生在某一拍的 queue.tick，下一拍开头才读到，所以上界放宽三拍
  assert.ok(reclaimedAt - closedAt <= RECONNECT_GRACE_MS + 3 * STEP_MS, '宽限期一过就应回收');
  assert.equal(reclaimError, 'disconnected');
  const finisher = rig.out('task.completed').filter(e => e.message.id === victim);
  assert.equal(finisher.length, 1);
  assert.equal(finisher[0].connId, b.connId, 'victim 应由另一节点完成');
  assert.equal(rig.task(victim).attempts, 1);

  // 4) 放开 node-a 卡住的渲染：它以为自己还持有，迟到的完成报告发到已关闭的连接上，被丢弃
  assert.equal(rig.exec.release({ nodeId: 'node-a' }), 1);
  await coast(rig);
  const lateFromA = rig.lb.log().slice(cutIndex).filter(e => e.dir === 'in' && e.connId === a.connId);
  assert.deepEqual(lateFromA, [], '分区之后 node-a 的消息一条都不应到达队列');
  assert.deepEqual(a.local.running(), [], '放开之后 node-a 的执行应落定');
  assertCompletedOnce(rig, page, ids);
  for (const t of rig.queue.describe().tasks) assert.equal(t.state, 'done', t.id);
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I4

test('I4 执行失败：可重试的失败一次后成功（attempts 1）；不可重试的进 failed，页面收到 task.failed', async () => {
  const before = unhandled.length;
  const rig = createRig();
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  const retryId = expected.find(t => t.kind === 'stream' && t.range.from === 0).id;
  const fatalId = expected.find(t => t.clipId === 'clip-glass').id;
  rig.exec.on(retryId, { fail: { retryable: true, message: 'gpu-hiccup' }, times: 1 });
  rig.exec.on(fatalId, { fail: { retryable: false, message: 'card-crashed' } });

  const page = rig.addPage('page', { publisherId: 'page-u1' });
  const a = rig.addNode('node-a', { seed: 7 });
  const b = rig.addNode('node-b', { seed: 8 });
  a.local.start();
  b.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);

  const planId = planIdOf('p1', 1);
  const okIds = [planId, ...expected.map(t => t.id).filter(id => id !== fatalId)];
  await drive(rig, () => allDone(rig, page, okIds)() && page.failedOf(fatalId).length > 0);
  await coast(rig);

  assertCompletedOnce(rig, page, okIds);
  // 可重试：失败一次、重试后完成
  assert.equal(rig.task(retryId).state, 'done');
  assert.equal(rig.task(retryId).attempts, 1);
  assert.equal(rig.exec.renderCount(retryId), 2);
  assert.equal(page.failedOf(retryId).length, 0, '可重试的失败不应通知 task.failed');
  const retryFails = rig.inbound('task.fail').filter(e => e.message.id === retryId);
  assert.equal(retryFails.length, 1);
  assert.equal(retryFails[0].message.error, 'gpu-hiccup');
  assert.notEqual(retryFails[0].message.retryable, false);

  // 不可重试：直接 failed，页面收到一条 task.failed
  const fatal = rig.task(fatalId);
  assert.equal(fatal.state, 'failed');
  assert.equal(fatal.attempts, 1);
  assert.equal(fatal.lastError, 'card-crashed');
  assert.equal(rig.exec.renderCount(fatalId), 1, '不可重试的不应再渲染');
  const failedMsgs = page.failedOf(fatalId);
  assert.equal(failedMsgs.length, 1);
  assert.equal(failedMsgs[0].error, 'card-crashed');
  assert.equal(page.doneCount(fatalId), 0);
  const fatalFails = rig.inbound('task.fail').filter(e => e.message.id === fatalId);
  assert.equal(fatalFails.length, 1);
  assert.equal(fatalFails[0].message.retryable, false);
  assert.ok(rig.nodes.some(n => n.eventsOf('failed').some(e => e.id === fatalId)), '应报 failed 事件');
  assert.ok(!rig.sink.holds(expected.find(t => t.id === fatalId).resultKey, expected.find(t => t.id === fatalId).range));

  // 其余照常：attempts 0
  for (const t of rig.queue.describe().tasks) {
    if (t.id !== retryId && t.id !== fatalId) assert.equal(t.attempts, 0, t.id);
  }
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I5

test('I5 纯浏览器节点 + pc 节点，另有别的用户的项目：浏览器只做本人的 light / medium 快照', async () => {
  const before = unhandled.length;
  const rig = createRig();
  const page1 = rig.addPage('page-u1', { userId: 'u1', tenantId: 't1', publisherId: 'page-u1' });
  const page2 = rig.addPage('page-u2', { userId: 'u2', tenantId: 't1', publisherId: 'page-u2' });
  // 浏览器排在前面 tick：同一拍里它的认领先到队列，保证它真的抢得到活
  // M6c X3：纯浏览器不能 watch 'all'（回 forbidden），列出两个项目（原为缺省的 'all'）
  const br = rig.addNode('node-br', { profile: 'browser', userId: 'u1', fp: FP_A, seed: 9, projects: ['p1', 'p2'] });
  const pc = rig.addNode('node-pc', { profile: 'pc', userId: 'u1', fp: FP_A, seed: 10 });
  br.local.start();
  pc.local.start();
  await settle(rig);
  page1.publishPlan('p1', 1);
  page2.publishPlan('p2', 1);

  const exp1 = expectedDerived(planContextFor('p1'), FP_A);
  const exp2 = expectedDerived(planContextFor('p2'), FP_A);
  const ids1 = [planIdOf('p1', 1), ...exp1.map(t => t.id)];
  const ids2 = [planIdOf('p2', 1), ...exp2.map(t => t.id)];
  assert.equal(new Set([...ids1, ...ids2]).size, ids1.length + ids2.length, '两个项目的任务 id 互不重叠');

  await drive(rig, () => allDone(rig, page1, ids1)() && ids2.every(id => page2.doneCount(id) >= 1));
  await coast(rig);

  assertCompletedOnce(rig, page1, ids1);
  assertCompletedOnce(rig, page2, ids2);

  // 浏览器可以做的：p1 的 light / medium 快照
  const eligible = new Set(exp1.filter(t => t.kind === 'snapshot' && (t.weightClass === 'light' || t.weightClass === 'medium')).map(t => t.id));
  assert.ok(eligible.size > 0);
  const brClaims = claimsOf(rig).filter(c => c.connId === br.connId);
  assert.ok(brClaims.length > 0, '浏览器节点应认领到本人的轻任务');
  for (const { id, task } of brClaims) {
    assert.equal(task.kind, 'snapshot', `${id}：浏览器不认领 plan / 流任务`);
    assert.ok(['light', 'medium'].includes(task.weight.class), `${id}：浏览器只认 light / medium`);
    assert.equal(task.source.userId, 'u1', `${id}：浏览器只认本人的任务`);
    assert.ok(eligible.has(id), id);
  }
  // 连认领都不该去试（节点本地过滤：规则 2、4、6；别人的任务它根本看不到）
  const brTries = rig.inbound('task.claim').filter(e => e.connId === br.connId).map(e => e.message.id);
  for (const id of brTries) assert.ok(eligible.has(id), `浏览器不应尝试认领 ${id}`);
  const brCompleted = rig.out('task.completed').filter(e => e.connId === br.connId).map(e => e.message.id);
  assert.ok(brCompleted.length > 0);
  for (const id of brCompleted) assert.ok(eligible.has(id), `浏览器完成的 ${id} 应是本人的 light / medium 快照`);

  // 别人的任务连看都看不到（契约 A.9 可见性、设计 Q2）
  const own = new Set(ids1);
  for (const e of rig.lb.log().filter(e => e.dir === 'out' && e.connId === br.connId)) {
    const m = e.message;
    const views = m.type === 'queue.snapshot' ? m.tasks : (m.type === 'task.opened' || m.type === 'task.claimed') ? [m.task] : [];
    for (const v of views) assert.equal(v.source.userId, 'u1', `浏览器收到了别人的任务 ${v.id}（${m.type}）`);
    if (['task.taken', 'task.closed', 'task.lease-lost', 'task.claim-rejected'].includes(m.type)) {
      assert.ok(own.has(m.id), `浏览器收到了别人任务的 ${m.type}：${m.id}`);
    }
  }
  // 别的用户的细任务继承 u2，全由 pc 完成
  for (const c of claimsOf(rig).filter(c => ids2.includes(c.id))) {
    assert.equal(c.connId, pc.connId);
    if (c.task.kind !== 'plan') assert.equal(c.task.source.userId, 'u2', c.id);
  }
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I6

test('I6 两种环境指纹的 pc 节点：第一轮细任务只被与 plan 认领者同指纹的节点认领；第二轮被第一轮锁住的卡照锁定方指纹出键、由锁定方指纹的节点做完（契约 F.7）；PlanContext 盖不掉切分节点与锁的指纹', async () => {
  const before = unhandled.length;
  // 执行器返回的 PlanContext 里夹带别的指纹和代码版本：D.2 规定切分节点自己的指纹、代码版本一定生效
  const rig = createRig({
    planContext: task => ({ ...planContextFor(task.source.projectId), envFingerprint: 'ffffffffffffffff', codeVersion: 'cv-bogus' }),
  });
  const page = rig.addPage('page', { publisherId: 'page-u1' });
  const b1 = rig.addNode('node-b1', { fp: FP_B, seed: 11 });
  const a1 = rig.addNode('node-a1', { fp: FP_A, seed: 12 });
  const a2 = rig.addNode('node-a2', { fp: FP_A, seed: 13 });
  const fpOf = new Map(rig.nodes.map(n => [n.connId, n.fp]));

  // 第一轮：只有 b1 在，plan 由 b1 认领 → 这一版的指纹是 FP_B
  b1.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);
  const plan1 = planIdOf('p1', 1);
  await drive(rig, () => claimsOf(rig).some(c => c.id === plan1));
  a1.local.start();
  a2.local.start();
  const exp1 = expectedDerived(planContextFor('p1'), FP_B);
  const ids1 = [plan1, ...exp1.map(t => t.id)];
  await drive(rig, allDone(rig, page, ids1));

  // 第二轮：b1 不空闲，新版本的 plan 由 a1 / a2 认领（切分节点指纹 FP_A）；认领之后 b1 恢复空闲。
  // 第一轮已经把每张卡、每条流锁给了 FP_B（卡片级指纹锁，契约 F.1 / F.7）：切分节点按 FP_A 发布被拒建，
  // 照锁定方的指纹 FP_B 重发 —— 内容没变，所以就是第一轮那批任务（已 done），页面照样收到全部 task.done。
  b1.idle = false;
  page.publishPlan('p1', 2);
  const plan2 = planIdOf('p1', 2);
  await drive(rig, () => claimsOf(rig).some(c => c.id === plan2));
  b1.idle = true;
  const exp2 = expectedDerived(planContextFor('p1'), FP_B);
  const ids2 = [plan2, ...exp2.map(t => t.id)];
  await drive(rig, allDone(rig, page, ids2));
  await coast(rig);

  assertCompletedOnce(rig, page, [...ids1, ...ids2]);
  const claims = claimsOf(rig);
  assert.equal(claims.find(c => c.id === plan1).connId, b1.connId);
  assert.notEqual(claims.find(c => c.id === plan2).connId, b1.connId);

  for (const [round, exp, fp] of [[1, exp1, FP_B], [2, exp2, FP_B]]) {
    const expIds = new Set(exp.map(t => t.id));
    const roundClaims = claims.filter(c => expIds.has(c.id));
    assert.deepEqual(sorted(roundClaims.map(c => c.id)), sorted(expIds), `第 ${round} 轮：每个细任务恰好认领一次`);
    for (const c of roundClaims) {
      assert.equal(fpOf.get(c.connId), fp, `第 ${round} 轮：${c.id} 被指纹不同的节点认领`);
      assert.equal(c.task.requires.envFingerprint, fp, c.id);
      assert.equal(c.task.requires.codeVersion, CV, c.id);
    }
    // 指纹不同的节点连试都不该试（规则 1）
    for (const e of rig.inbound('task.claim').filter(e => expIds.has(e.message.id))) {
      assert.equal(fpOf.get(e.connId), fp, `第 ${round} 轮：指纹不同的节点尝试认领 ${e.message.id}`);
    }
  }
  // 第二轮照锁定方指纹出键：与第一轮是同一批任务，不重渲（F.7 之前这里断言两轮的结果键互不相同、第二轮全是真渲染）
  assert.deepEqual(sorted(exp2.map(t => t.id)), sorted(exp1.map(t => t.id)));
  assert.deepEqual(sorted(page.done(plan2).result.derived), sorted(exp2.map(t => t.id)), '第二轮 plan 的 derived 是照锁指纹出键的那批');
  for (const t of [...exp1, ...exp2]) assert.ok(rig.sink.holds(t.resultKey, t.range), t.id);
  for (const t of exp2) assert.equal(rig.exec.renderCount(t.id), 1, t.id);
  assert.equal(rig.nodes.flatMap(n => n.eventsOf('dedup')).length, 0);
  // 按切分节点自己的指纹（FP_A）出键的任务被拒建，队列里不留谁也认领不了的死任务
  const deadIds = new Set(expectedDerived(planContextFor('p1'), FP_A).map(t => t.id));
  assert.deepEqual(rig.queue.describe().tasks.filter(t => deadIds.has(t.id)).map(t => t.id), []);
  assert.equal(claims.filter(c => deadIds.has(c.id)).length, 0);
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I7

test('I7 执行中节点转为不空闲并 yieldAll：任务放回（attempts 不加）、被另一节点完成；让路节点的执行被中止、结果丢弃', async () => {
  const before = unhandled.length;
  const rig = createRig();
  // node-a 渲染得慢，便于在执行中途让路
  rig.exec.on((task, { nodeId }) => nodeId === 'node-a', { durationMs: 4_000 });
  const page = rig.addPage('page', { publisherId: 'page-u1' });
  const a = rig.addNode('node-a', { seed: 14 });
  const b = rig.addNode('node-b', { seed: 15 });
  a.local.start();
  b.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);

  const planId = planIdOf('p1', 1);
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  const ids = [planId, ...expected.map(t => t.id)];

  let victim = null;
  let releaseIndex = null;
  await drive(rig, () => victim !== null && allDone(rig, page, ids)(), {
    onStep: async () => {
      if (victim !== null) return;
      const call = rig.exec.calls({ kind: 'render', nodeId: 'node-a' }).find(c => c.state === 'running');
      if (!call) return;
      victim = call.id;
      // 用户开始播放：不空闲，放回手里的全部任务
      a.idle = false;
      a.local.yieldAll('playing');
      await settle(rig);
      releaseIndex = rig.inbound('task.release').find(e => e.connId === a.connId && e.message.id === victim)?.index ?? null;
    },
  });

  assert.ok(victim, 'node-a 应在执行中途让过路');
  assert.ok(releaseIndex !== null, 'node-a 应对 victim 发 task.release');
  assert.equal(rig.inbound('task.release').find(e => e.index === releaseIndex).message.reason, 'playing');
  // 放回不算失败（C2）：attempts 不加；open(1) → claimed(2) → open(3) → claimed(4) → done(5)
  const t = rig.task(victim);
  assert.equal(t.state, 'done');
  assert.equal(t.attempts, 0);
  assert.equal(t.version, 5);
  const finisher = rig.out('task.completed').filter(e => e.message.id === victim);
  assert.equal(finisher.length, 1);
  assert.equal(finisher[0].connId, b.connId, 'victim 应由另一节点完成');

  // 让路节点：执行被中止，结果丢弃，不再为 victim 发任何消息，也没往产物库推
  const aCall = rig.exec.calls({ kind: 'render', nodeId: 'node-a', id: victim })[0];
  assert.equal(aCall.abortSeen, true, 'node-a 的执行应被中止');
  assert.ok(a.eventsOf('discarded').some(e => e.id === victim), 'node-a 应报 discarded');
  const afterRelease = rig.lb.log().slice(releaseIndex + 1).filter(e => e.dir === 'in' && e.connId === a.connId && e.message.id === victim);
  assert.deepEqual(afterRelease, [], 'node-a 放回之后不应再为 victim 发消息');
  assert.equal(rig.sink.puts().filter(p => p.meta?.taskId === victim && p.meta?.nodeId === 'node-a').length, 0);
  assert.ok(!a.local.running().includes(victim));
  assert.deepEqual(a.local.session.held(), []);
  await coast(rig);
  assertCompletedOnce(rig, page, ids);
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I8

/**
 * I8 的共用部分：node-a 的细任务渲染一律卡住（不报进度、不理中止），等它手里有一个卡住的任务后
 * `onHang(a)`，再驱动到被回收、另一节点完成；最后放开卡住的渲染，确认迟到的结果被丢弃。
 */
async function runHungNode({ seedA, seedB, onHang }) {
  const before = unhandled.length;
  const rig = createRig();
  rig.exec.on((task, { nodeId }) => nodeId === 'node-a' && task.kind !== 'plan', { hang: true });
  const page = rig.addPage('page', { publisherId: 'page-u1' });
  const a = rig.addNode('node-a', { seed: seedA });
  const b = rig.addNode('node-b', { seed: seedB });
  a.local.start();
  b.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);
  const planId = planIdOf('p1', 1);
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  const ids = [planId, ...expected.map(t => t.id)];

  await drive(rig, () => rig.exec.hung().some(c => c.nodeId === 'node-a'));
  const hungCall = rig.exec.hung().find(c => c.nodeId === 'node-a');
  const victim = hungCall.id;
  onHang(a);

  let reclaimedAt = null;
  let reclaimError = null;
  // 卡死节点的执行不理会中止，要等最后放开，所以这里不等它的在跑表清空
  await drive(rig, allDone(rig, page, ids, [a]), {
    onStep: () => {
      const t = rig.task(victim);
      if (reclaimedAt === null && t && t.attempts === 1) {
        reclaimedAt = rig.clock.now();
        reclaimError = t.lastError;
      }
    },
  });
  const lostMsgs = rig.out('task.lease-lost').filter(e => e.connId === a.connId && e.message.id === victim);
  assert.equal(lostMsgs.length, 1, '卡死节点应收到一条 lease-lost');
  assert.equal(lostMsgs[0].message.reason, reclaimError, 'lease-lost 的 reason 是回收原因（契约 A.12〔裁〕）');
  assert.ok(a.eventsOf('lost').some(e => e.id === victim), '卡死节点应报 lost');
  assert.equal(rig.exec.hung().find(c => c.id === victim)?.abortSeen, true, '丢认领后应中止对应的执行');
  const finisher = rig.out('task.completed').filter(e => e.message.id === victim);
  assert.equal(finisher.length, 1);
  assert.equal(finisher[0].connId, b.connId, 'victim 应由另一节点完成');
  assert.equal(rig.task(victim).attempts, 1);

  // 放开卡住的渲染：迟到的结果被丢弃，不发任何消息，也不往产物库推
  assert.equal(rig.exec.release({ nodeId: 'node-a' }), 1);
  await coast(rig);
  assert.ok(a.eventsOf('discarded').some(e => e.id === victim), '迟到的结果应报 discarded');
  const lateFromA = rig.lb.log().slice(lostMsgs[0].index + 1).filter(e => e.dir === 'in' && e.connId === a.connId && e.message.id === victim);
  assert.deepEqual(lateFromA, [], '丢认领之后卡死节点不应再为 victim 发消息');
  assert.equal(rig.sink.puts().filter(p => p.meta?.taskId === victim && p.meta?.nodeId === 'node-a').length, 0);
  assert.deepEqual(a.local.running(), [], '放开之后卡死节点的执行应落定');
  assertCompletedOnce(rig, page, ids);
  hygiene(rig, { unhandledBefore: before });
  return { hungCall, reclaimedAt, reclaimError };
}

test('I8 执行器卡死（不报进度），卡死节点照常 tick：开工时的 progress(0) 之后 STALL_MS 按停滞回收，另一节点完成；迟到结果被丢弃', async () => {
  const { hungCall, reclaimedAt, reclaimError } = await runHungNode({
    seedA: 16, seedB: 17,
    // 卡死节点照常 tick（续约照发），但不再认领新活：免得把放回的任务又抢回去卡住
    onHang: a => { a.idle = false; },
  });
  assert.equal(reclaimError, 'stalled');
  // 开工时 progress(0) 与开工同一时刻；此后进度不变，严格超过 STALL_MS 才回收（A.8 第 2 项）
  assert.ok(reclaimedAt - hungCall.startedAt > STALL_MS, `应在 STALL_MS 之后回收，实际 ${reclaimedAt - hungCall.startedAt} ms`);
  assert.ok(reclaimedAt - hungCall.startedAt <= STALL_MS + 3 * STEP_MS, 'STALL_MS 一过就应回收');
});

test('I8 补充：卡死节点连心跳也停了（不再 tick）：租约到期回收，另一节点完成；迟到结果被丢弃', async () => {
  const { hungCall, reclaimedAt, reclaimError } = await runHungNode({
    seedA: 18, seedB: 19,
    onHang: a => { a.ticking = false; },
  });
  assert.equal(reclaimError, 'lease-expired');
  // 认领、开工时的 progress(0)、卡住都在同一拍（同一时刻）；此后这个节点不再 tick、不再续约，
  // 所以租约恰在那一刻 + LEASE_MS 到期，严格超过才回收（A.8 第 1 项）
  assert.ok(reclaimedAt - hungCall.startedAt > LEASE_MS, `回收得太早：${reclaimedAt - hungCall.startedAt} ms`);
  assert.ok(reclaimedAt - hungCall.startedAt <= LEASE_MS + 3 * STEP_MS, `租约一过就应回收，实际 ${reclaimedAt - hungCall.startedAt} ms`);
});

// ================================================================ I9

test('I9 产物库推送没收全（failNextPut）：任务报失败后被重试完成；最终每段恰好完成一次', async () => {
  const before = unhandled.length;
  const rig = createRig();
  rig.sink.failNextPut(2);
  const page = rig.addPage('page', { publisherId: 'page-u1' });
  const a = rig.addNode('node-a', { seed: 20 });
  const b = rig.addNode('node-b', { seed: 21 });
  a.local.start();
  b.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);

  const planId = planIdOf('p1', 1);
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  const ids = [planId, ...expected.map(t => t.id)];
  await drive(rig, allDone(rig, page, ids));
  await coast(rig);

  assertCompletedOnce(rig, page, ids);
  const badPuts = rig.sink.puts().filter(p => !p.complete);
  assert.equal(badPuts.length, 2);
  const failures = counts(badPuts.map(p => p.meta.taskId));
  const fails = rig.inbound('task.fail');
  assert.equal(fails.length, 2, '每次没收全都应报一次失败');
  for (const e of fails) {
    assert.equal(e.message.error, 'sink-incomplete');
    assert.notEqual(e.message.retryable, false, '没收全按可重试处理');
  }
  assert.deepEqual(sorted(fails.map(e => e.message.id)), sorted(badPuts.map(p => p.meta.taskId)));
  for (const [id, n] of failures) {
    assert.equal(rig.task(id).state, 'done', id);
    assert.equal(rig.task(id).attempts, n, `${id}：attempts 应等于没收全的次数`);
    assert.equal(rig.exec.renderCount(id), n + 1, `${id}：没收全后要重新渲染`);
  }
  for (const t of expected) {
    assert.ok(rig.sink.holds(t.resultKey, t.range), t.id);
    if (!failures.has(t.id)) assert.equal(rig.task(t.id).attempts, 0, t.id);
  }
  assert.equal(page.of('task.failed').length, 0);
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I10

test('I10 队列重启（新实例、新 epoch）：页面重新发布后全部完成；已在产物库里的段走 dedup，不重复渲染', async () => {
  const before = unhandled.length;
  // 第一段：跑到一半（至少两个细任务已完成、还有在渲染的）
  const rig1 = createRig({ epoch: 'epoch-1' });
  rig1.exec.on(() => true, { durationMs: 2_000 });
  const page1 = rig1.addPage('page', { publisherId: 'page-u1' });
  const a1 = rig1.addNode('node-a', { seed: 22 });
  const b1 = rig1.addNode('node-b', { seed: 23 });
  a1.local.start();
  b1.local.start();
  await settle(rig1);
  page1.publishPlan('p1', 1);
  const planId = planIdOf('p1', 1);
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  const derivedIds = expected.map(t => t.id);
  await drive(rig1, () => derivedIds.filter(id => page1.doneCount(id) > 0).length >= 2
    && rig1.exec.calls({ kind: 'render' }).some(c => c.state === 'running'));
  hygiene(rig1, { unhandledBefore: before });

  // 文档服务重启：旧连接全断，节点实例停掉（在跑的任务被中止，不发任何消息）
  const heldBefore = a1.local.session.held();
  a1.stop();
  b1.stop();
  await settle(rig1);
  assert.equal(rig1.lb.pending(), 0, '停掉的节点不应再发消息');
  // stop 中止在跑的任务；假执行器对中止立即拒绝，所以 settled() 应在几轮事件循环内落定（不推进时钟）
  await within(Promise.all([a1.local.settled(), b1.local.settled()]), 'stop() 之后 settled() 应落定（在跑的任务被中止）');
  await settle(rig1);
  assert.equal(rig1.lb.pending(), 0, '停掉的节点不应再发消息');
  assert.deepEqual([...a1.local.running(), ...b1.local.running()], [], 'stop() 之后不应还有在跑的任务');
  const inSink = new Set(expected.filter(t => rig1.sink.holds(t.resultKey, t.range)).map(t => t.id));
  assert.ok(inSink.size >= 2, '重启前产物库里应已有段');
  assert.ok(inSink.size < expected.length, '重启前还应有没做完的段');
  const rendersBefore = new Map(derivedIds.map(id => [id, rig1.exec.renderCount(id)]));

  // 第二段：新队列（新 epoch），产物库与执行器沿用；页面以同一发布方身份重连并重新发布
  const rig2 = createRig({ epoch: 'epoch-2', clock: rig1.clock, sink: rig1.sink, exec: rig1.exec });
  const page2 = rig2.addPage('page', { publisherId: 'page-u1' });
  const a2 = rig2.addNode('node-a', { seed: 24 });
  const b2 = rig2.addNode('node-b', { seed: 25 });
  // 新进程的实例拿旧认领去 resume：在跑表是空的，resume' 为空（D.2 裁定）
  a2.local.start(heldBefore);
  b2.local.start();
  await settle(rig2);
  page2.publishPlan('p1', 1);
  const ids = [planId, ...derivedIds];
  await drive(rig2, allDone(rig2, page2, ids));
  await coast(rig2);

  assert.equal(rig2.queue.describe().epoch, 'epoch-2');
  assert.notEqual(rig1.queue.describe().epoch, rig2.queue.describe().epoch);
  for (const m of page2.inbox) assert.equal(m.epoch, 'epoch-2', `${m.type} 应带新 epoch`);
  const hello = rig2.inbound('node.hello').find(e => e.connId === a2.connId);
  assert.deepEqual(hello.message.resume ?? [], [], '新实例不接续旧队列的认领');

  assertCompletedOnce(rig2, page2, ids);
  for (const t of rig2.queue.describe().tasks) assert.equal(t.state, 'done', t.id);
  for (const t of expected) {
    const done = page2.done(t.id);
    if (inSink.has(t.id)) {
      assert.equal(done.result.dedup, true, `${t.id}：重启前已在产物库里，应走 dedup`);
      assert.equal(rig2.exec.renderCount(t.id), rendersBefore.get(t.id), `${t.id}：不应重复渲染`);
    } else {
      assert.notEqual(done.result.dedup, true, `${t.id}：重启前没收全，应重新渲染`);
      assert.equal(rig2.exec.renderCount(t.id), rendersBefore.get(t.id) + 1, `${t.id}：重启后恰好渲染一次`);
    }
    assert.ok(rig2.sink.holds(t.resultKey, t.range), t.id);
  }
  hygiene(rig2, { unhandledBefore: before });
});

// ================================================================ I11

/**
 * I11 的共用拼装：v1 / v2 两版 PlanContext，两个页面（同一用户的两个标签页）。
 * 页面 A 发布 v1 与 v2，页面 B 只发布 v2。
 *
 * 契约 A.4「已存在的同 id 任务」：已是订阅者的不重复发。页面 A 经 v1 的继承早已订阅了 v1 的细任务，
 * 所以 v2 里不变的那些它不会再收到第二条 task.done（它在 v1 时已经收到过一条）；「补发」落在只订阅了
 * v2 plan 的页面 B 身上。两个页面合起来覆盖：不重复（A）与补发 / 并入（B）。
 */
function createVersionRig() {
  const rig = createRig({ planContext: task => (task.source.projectRev === 2 ? planContextV2('p1') : planContextFor('p1')) });
  const pageA = rig.addPage('page-a', { userId: 'u1', publisherId: 'page-a' });
  const pageB = rig.addPage('page-b', { userId: 'u1', publisherId: 'page-b' });
  const v1 = expectedDerived(planContextFor('p1'), FP_A);
  const v2 = expectedDerived(planContextV2('p1'), FP_A);
  const v1Ids = new Set(v1.map(t => t.id));
  const unchanged = v2.filter(t => v1Ids.has(t.id));
  const changed = v2.filter(t => !v1Ids.has(t.id));
  // 夹具自检：标题（3 段）与轨道流（2 段）不变；下三分之一（共享键变了）与毛玻璃（本地档键含 entry.key）要重渲
  assert.deepEqual(sorted(new Set(unchanged.map(t => t.clipId))), ['clip-title', 'clip-video']);
  assert.deepEqual(sorted(new Set(changed.map(t => t.clipId))), ['clip-glass', 'clip-lower']);
  const ids1 = [planIdOf('p1', 1), ...v1.map(t => t.id)];
  const ids2 = [planIdOf('p1', 2), ...v2.map(t => t.id)];
  return { rig, pageA, pageB, v1, v2, unchanged, changed, ids1, ids2 };
}

/** I11 共同的收尾断言。 */
function assertVersions({ rig, pageA, pageB, v1, v2, unchanged, changed, ids1, ids2 }) {
  // 页面 A：v1、v2 的每个任务恰好一条 task.done（不变的那些是 v1 时收到的，不重复）
  for (const id of new Set([...ids1, ...ids2])) assert.equal(pageA.doneCount(id), 1, `页面 A 对 ${id} 应恰好一条 task.done`);
  // 页面 B：v2 的每个任务恰好一条（不变的那些靠并入订阅 / 补发）
  for (const id of ids2) assert.equal(pageB.doneCount(id), 1, `页面 B 对 ${id} 应恰好一条 task.done`);
  for (const id of ids1.filter(id => !ids2.includes(id))) assert.equal(pageB.doneCount(id), 0, `页面 B 没订阅 v1 的 ${id}`);
  assert.equal(pageA.of('task.failed').length + pageB.of('task.failed').length, 0);
  // v2 plan 的结果列出全部 v2 细任务（含已存在的）
  assert.deepEqual(sorted(pageB.done(planIdOf('p1', 2)).result.derived), sorted(v2.map(t => t.id)));
  // 每个任务在队列里恰好完成一次、恰好认领一次；不变的不重新渲染、不重新认领
  const completed = counts(rig.out('task.completed').map(e => e.message.id));
  const claimed = counts(claimsOf(rig).map(c => c.id));
  for (const t of [...v1, ...changed]) {
    assert.equal(completed.get(t.id), 1, `${t.id} 应恰好完成一次`);
    assert.equal(claimed.get(t.id), 1, `${t.id} 应恰好认领一次`);
    assert.equal(rig.exec.renderCount(t.id), 1, `${t.id} 应恰好渲染一次`);
    assert.ok(rig.sink.holds(t.resultKey, t.range), t.id);
  }
  for (const t of unchanged) {
    const d = rig.task(t.id);
    assert.deepEqual([d.state, d.version, d.attempts], ['done', 3, 0], `${t.id}：v2 不重新打开它`);
    assert.deepEqual(pageB.done(t.id).result.ranges, [[t.range.from, t.range.to]]);
    assert.equal(pageB.done(t.id).resultKey, t.resultKey);
    assert.ok(d.subscribers.includes('page-a') && d.subscribers.includes('page-b'), `${t.id} 应并入两个页面的订阅`);
  }
  for (const t of changed) assert.equal(rig.task(t.id).state, 'done', t.id);
}

test('I11 同一页面先发布 v1 并全部完成，再发布 v2（只改了一张卡）：v2 的细任务页面都有 task.done，不变的补发、不重渲，改了的照常渲染', async () => {
  const before = unhandled.length;
  const env = createVersionRig();
  const { rig, pageA, pageB, ids1, ids2 } = env;
  const a = rig.addNode('node-a', { seed: 26 });
  const b = rig.addNode('node-b', { seed: 27 });
  a.local.start();
  b.local.start();
  await settle(rig);

  pageA.publishPlan('p1', 1);
  await drive(rig, allDone(rig, pageA, ids1));
  const bBefore = pageB.inbox.length;

  pageA.publishPlan('p1', 2);
  pageB.publishPlan('p1', 2);
  await drive(rig, () => allDone(rig, pageA, ids2)() && allDone(rig, pageB, ids2)());
  await coast(rig);

  assert.equal(pageB.inbox.slice(0, bBefore).filter(m => m.type === 'task.done').length, 0, 'v2 之前页面 B 什么都没订阅');
  // 不变的在 v2 发布时都已 done：页面 B 收到的是补发（A.4「已存在的同 id 任务」）
  for (const t of env.unchanged) assert.equal(pageB.doneCount(t.id), 1, `${t.id}：页面 B 应收到补发的 task.done`);
  assertVersions(env);
  hygiene(rig, { unhandledBefore: before });
});

test('I11 v1 的细任务还 open / claimed 时 v2 的 plan 就被切分：页面最终收到它们的 task.done，且只一次', async () => {
  const before = unhandled.length;
  const env = createVersionRig();
  const { rig, pageA, pageB, ids1, ids2 } = env;
  rig.exec.on(() => true, { durationMs: 3_000 });
  const a = rig.addNode('node-a', { seed: 28 });
  const b = rig.addNode('node-b', { seed: 29 });
  a.local.start();
  b.local.start();
  await settle(rig);

  pageA.publishPlan('p1', 1);
  const plan1 = planIdOf('p1', 1);
  const plan2 = planIdOf('p1', 2);
  await drive(rig, () => pageA.doneCount(plan1) > 0);
  // v1 刚切完；v2 的 plan 插队（优先级 100，设计第 3 节「AI 栏预览插队」），趁 v1 的细任务还在做就切分
  pageA.publishPlan('p1', 2, 100);
  pageB.publishPlan('p1', 2, 100);
  let statesAtSplit = null;
  await drive(rig, () => {
    if (statesAtSplit === null && pageA.doneCount(plan2) > 0) {
      statesAtSplit = new Map(env.unchanged.map(t => [t.id, rig.task(t.id)?.state]));
    }
    return statesAtSplit !== null;
  });
  const inFlight = [...statesAtSplit].filter(([, s]) => s === 'open' || s === 'claimed').map(([id]) => id);
  assert.ok(inFlight.length > 0, `前提：v2 切分时应有不变的细任务还在 open / claimed，实际 ${JSON.stringify([...statesAtSplit])}`);

  await drive(rig, () => allDone(rig, pageA, [...ids1, ...ids2])() && allDone(rig, pageB, ids2)());
  await coast(rig);

  for (const id of inFlight) {
    assert.equal(pageA.doneCount(id), 1, `${id}：页面 A 只收到一条`);
    assert.equal(pageB.doneCount(id), 1, `${id}：页面 B（并入订阅）收到且只收到一条`);
  }
  assertVersions(env);
  hygiene(rig, { unhandledBefore: before });
});
