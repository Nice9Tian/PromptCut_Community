/**
 * M6c X2～X5（`docs/plan/m6c-contract.md`）实现方的单测：本地档能力闸、`watch: 'all'` 收紧、`plan` 就近认领、
 * 本机队列节点的闲时门槛。用例名以编号开头（X2-*～X5-*），与契约验收表逐项对应。
 *
 * 队列单测用 `fake-render-queue-env.mjs` 的假时钟与收集器；端到端用环回（`fake-loopback-transport.mjs`）、
 * 假执行器（`fake-render-executor.mjs`，按假时钟推进）与假产物库，全部在一个进程里、不开真实计时器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRenderQueue, QUEUE_DEFAULTS, QUEUE_ENV } from '../render-queue/index.mjs';
import { createNodeSession } from '../render-node/session.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { checkClaimable } from '../render-node/filter.mjs';
import { planTaskOf, splitPlan } from '../render-node/split.mjs';
import { hashlessMedia, localMediaGate, withLocalMedia } from '../queue-local-media.mjs';
import { createQueueIdleGate, interactionReason, INTERACTION_QUIET_MS } from '../queue-idle.mjs';
import { createQueueHarness, makeTaskInput, T0 } from './fake-render-queue-env.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { createFakeExecutor, createTimerClock } from './fake-render-executor.mjs';
import { createArtifactSink } from './fake-artifact-sink.mjs';

const FP = 'aaaaaaaaaaaaaaaa';
const FP_B = 'bbbbbbbbbbbbbbbb';
const CV = 'code-v1';
const HASH = 'c'.repeat(64);
const DELTAS = new Set(['task.opened', 'task.taken', 'task.closed']);

const pcNode = (fp = FP, extra = {}) => ({
  profile: 'pc', envFingerprint: fp, codeVersions: [CV],
  capabilities: { transcode: true, userCards: true, graphCards: true }, ...extra,
});

/* ================================================================== 端到端的小装置 */

/**
 * 一个真队列、一条环回、若干 `createLocalNode`，假时钟驱动。
 * `step(ms)`：投递 → 各节点 tick → 投递 → 队列 tick → 投递 → 推进时钟。
 */
function createRig({ constants, planContext, planMs = 100, durationMs = 300 } = {}) {
  const clock = createTimerClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, ...(constants ? { constants } : {}) });
  lb.attach(queue);
  const exec = createFakeExecutor({ clock, planContext, planMs, durationMs, progressEveryMs: 100 });
  const sink = createArtifactSink();
  const nodes = [];

  async function settle() {
    for (let round = 0; round < 500; round++) {
      lb.flush();
      for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
      if (lb.pending() === 0) return;
    }
    throw new Error('消息往返不收敛');
  }
  async function step(ms = 100) {
    await settle();
    for (const n of nodes) if (!n.stopped) n.local.tick();
    await settle();
    queue.tick();
    await settle();
    clock.advance(ms);
    await settle();
  }
  function addNode(nodeId, { node = pcNode(), isIdle = () => true, wrapExecutor = e => e, projects, maxConcurrent = 1 } = {}) {
    const endpoint = lb.connect(`conn-${nodeId}`, { userId: 'u1', tenantId: 't1' });
    const rec = { nodeId, endpoint, connId: endpoint.connId, stopped: false, events: [] };
    rec.local = createLocalNode({
      nodeId, node, endpoint, now: clock.now, random: () => 0, isIdle, maxConcurrent,
      codeVersion: CV, executor: wrapExecutor(exec.forNode(nodeId)), sink,
      ...(projects ? { projects } : {}),
      onEvent: event => rec.events.push(event),
    });
    nodes.push(rec);
    return rec;
  }
  /** 连接 `connId` 发给队列的某类消息 */
  const sent = (connId, type) => lb.log().filter(e => e.dir === 'in' && e.connId === connId && e.message.type === type).map(e => e.message);
  /** 队列发给连接 `connId` 的某类消息 */
  const received = (connId, type) => lb.log().filter(e => e.dir === 'out' && e.connId === connId && e.message.type === type).map(e => e.message);
  const task = id => queue.describe().tasks.find(t => t.id === id) ?? null;
  const hygiene = () => {
    assert.deepEqual(lb.errors().map(e => String(e?.stack ?? e)), [], '端点处理器 / queue.handle 抛出了异常');
  };
  return { clock, lb, queue, exec, sink, nodes, settle, step, addNode, sent, received, task, hygiene };
}

/* ================================================================== X2 本地档能力闸 */

/** 一版项目：一条没有哈希的本地素材、一条有哈希的素材；三个片段 */
const MEDIA_PROJECT = {
  media: [
    { id: 'm-local', name: 'clip.mp4', url: '/@media/clip.mp4' },
    { id: 'm-hash', name: 'b.png', hash: HASH, url: `/@media/${HASH}.png` },
  ],
  tracks: [{
    id: 'tr', clips: [
      { id: 'clip-local', kind: 'card', cardId: 'glass', start: 0, end: 2, params: {} },
      { id: 'clip-media', kind: 'card', cardId: 'video-card', start: 0, end: 2, params: { mediaId: 'm-local' } },
      { id: 'clip-plain', kind: 'card', cardId: 'title', start: 0, end: 4, params: { mediaId: 'm-hash' } },
    ],
  }],
};
const control = (clipId, tier, count, extra = {}) => ({
  clipId, tier, count, snapshotKey: `sk-${clipId}`, contentKey: `ck-${clipId}`, cardId: null,
  capabilities: { frameMode: 'stateful', compositing: tier === 'local' ? 'belowDependent' : 'independent' },
  sampling: { firstFrame: 0 }, ...extra,
});
const MEDIA_PLAN = {
  entryKey: 'e'.repeat(64),
  cardPlan: [control('clip-local', 'local', 60), control('clip-media', 'shared', 60), control('clip-plain', 'shared', 120)],
  streams: [],
};

test('X2-1 localMediaGate：没有内容哈希、按本机地址取的素材才算本地；本地档与流一律算，共享档看片段引用，找不到片段保守地算', () => {
  assert.deepEqual(hashlessMedia(MEDIA_PROJECT).map(m => m.id), ['m-local']);
  assert.deepEqual(hashlessMedia({ media: [
    { id: 'a', path: 'C:/x.mp4' }, { id: 'b', url: '/api/media/file?path=x' }, { id: 'c', url: '/@export/e1/media/x.mp4' },
    { id: 'd', url: `/@media/${HASH}` }, { id: 'e', hash: HASH, url: '/@media/name.mp4' }, { id: 'f', url: 'https://cdn.example/x.png' },
    { id: 'g', url: 'blob:abc' },
  ] }).map(m => m.id), ['a', 'b', 'c'], 'path、/api/media/file、/@export 算；有哈希的、外部地址、blob 不算');
  assert.equal(localMediaGate({ media: [{ id: 'h', hash: HASH }], tracks: [] }), null, '全是有哈希的素材：不设闸');
  assert.equal(localMediaGate({}), null);

  const uses = localMediaGate(MEDIA_PROJECT);
  assert.equal(uses(control('clip-local', 'local', 60)), true, '本地档整场景渲：算');
  assert.equal(uses(control('clip-media', 'shared', 60)), true, '共享档片段引用了本地素材：算');
  assert.equal(uses(control('clip-plain', 'shared', 120)), false, '共享档片段只引用有哈希的素材：不算');
  assert.equal(uses(control('clip-gone', 'shared', 10)), true, '找不到片段：保守地算');
  assert.equal(uses({ clipId: 'clip-plain', kind: 'stream' }), true, '流：算');
  // 档位缺省按 capabilities 判
  assert.equal(uses({ clipId: 'clip-plain', capabilities: { frameMode: 'stateful', compositing: 'unknown' } }), true, 'unknown 是本地档');

  const ctx = { entryKey: 'k', cardPlan: [] };
  assert.equal(withLocalMedia(ctx, { project: { media: [] }, owner: 'node-A' }), ctx, '没有本地素材：原样返回');
  assert.equal(withLocalMedia(ctx, { project: MEDIA_PROJECT, owner: '' }), ctx, '没有 owner：原样返回');
  const gated = withLocalMedia(ctx, { project: MEDIA_PROJECT, owner: 'node-A' });
  assert.equal(gated.localMedia, 'node-A');
  assert.equal(typeof gated.usesLocalMedia, 'function');
  assert.equal(ctx.localMedia, undefined, '不改入参');
});

test('X2-2 splitPlan：给了 localMedia，usesLocalMedia 判真的快照与流任务写 requires.localMedia；没给时任务形状不变', () => {
  const planTask = planTaskOf({ projectId: 'p1', projectRev: 3 });
  const base = { planTask, ...MEDIA_PLAN, envFingerprint: FP, codeVersion: CV,
    streams: [{ streamKey: 'stream-k', contentKey: 'stream-ck', topClipId: 'clip-plain', firstSegment: 0, lastSegment: 3 }] };
  const plain = splitPlan(base);
  assert.ok(plain.every(t => !('localMedia' in t.requires)), '没给 localMedia：requires 里没有这一项');

  const uses = localMediaGate(MEDIA_PROJECT);
  const gated = splitPlan({ ...base, localMedia: 'node-A', usesLocalMedia: uses });
  assert.deepEqual(gated.map(t => t.id), plain.map(t => t.id), '任务 id 不变（localMedia 不进结果键）');
  const byClip = Object.groupBy(gated, t => t.input.clipId);
  assert.ok(byClip['clip-local'].every(t => t.requires.localMedia === 'node-A'), '本地档');
  assert.ok(byClip['clip-media'].every(t => t.requires.localMedia === 'node-A'), '引用本地素材的共享档');
  const plainShared = byClip['clip-plain'].filter(t => t.kind === 'snapshot');
  assert.equal(plainShared.length, 2);
  assert.ok(plainShared.every(t => !('localMedia' in t.requires)), '只引用有哈希素材的共享档不设闸');
  const streams = gated.filter(t => t.kind === 'stream');
  assert.ok(streams.length > 0 && streams.every(t => t.requires.localMedia === 'node-A'), '流任务');
  // 缺省 usesLocalMedia：给了 localMedia 就全部设闸
  assert.ok(splitPlan({ ...base, localMedia: 'node-A' }).every(t => t.requires.localMedia === 'node-A'));
  // 其余字段与不设闸时一样
  for (let i = 0; i < gated.length; i++) {
    const { localMedia: _drop, ...rest } = gated[i].requires;
    assert.deepEqual({ ...gated[i], requires: rest }, plain[i]);
  }
});

test('X2-3 节点侧过滤规则 1：requires.localMedia 不等于本节点 nodeId 就跳过；会话把 nodeId 补进过滤', () => {
  const task = makeTaskInput({ requires: { envFingerprint: FP, codeVersion: CV, localMedia: 'node-A' } });
  const view = { ...task, source: { ...task.source, userId: 'u1' } };
  assert.deepEqual(checkClaimable(view, { ...pcNode(), nodeId: 'node-A' }), { ok: true });
  assert.deepEqual(checkClaimable(view, { ...pcNode(), nodeId: 'node-B' }), { ok: false, rule: 1, reason: 'local-media' });
  assert.deepEqual(checkClaimable(view, pcNode()), { ok: false, rule: 1, reason: 'local-media' }, '不知道 nodeId：不接');

  // 会话：node 描述里没有 nodeId，用会话自己的 nodeId 过滤
  const sentA = [];
  const sentB = [];
  const mk = (nodeId, out) => createNodeSession({ nodeId, node: pcNode(), send: m => out.push(m), now: () => T0 });
  const a = mk('node-A', sentA);
  const b = mk('node-B', sentB);
  for (const s of [a, b]) {
    s.start();
    s.receive({ type: 'queue.snapshot', tasks: [{ ...view, state: 'open', version: 1, attempts: 0 }] });
    s.tick();
  }
  assert.deepEqual(sentA.filter(m => m.type === 'task.claim').map(m => m.id), [task.id], 'node-A 认领');
  assert.deepEqual(sentB.filter(m => m.type === 'task.claim'), [], 'node-B 不认领');
});

test('X2-4 队列：前置过滤里别的节点看不见 localMedia 任务（snapshot 与 task.opened 都没有），认领回 local-media；PREFILTER 关时看得见但照样认领不了', t => {
  for (const prefilter of [true, false]) {
    const h = createQueueHarness(createRenderQueue, { constants: { PREFILTER: prefilter } });
    h.publisher('p', 'node-A');
    const T1 = makeTaskInput({ resultKey: 'x2-before', requires: { envFingerprint: FP, localMedia: 'node-A' } });
    h.publish('p', [T1]);
    const snapA = h.node('a', 'node-A', { hello: { envFingerprint: FP } }).one('a', 'queue.snapshot');
    const snapB = h.node('b', 'node-B', { hello: { envFingerprint: FP } }).one('b', 'queue.snapshot');
    const snapN = h.node('n', 'node-N').one('n', 'queue.snapshot');   // 不带指纹的节点：localMedia 照样挡
    assert.deepEqual(snapA.tasks.map(x => x.id), [T1.id]);
    assert.deepEqual(snapB.tasks.map(x => x.id), prefilter ? [] : [T1.id], `过滤${prefilter ? '开' : '关'}：B 的快照`);
    assert.deepEqual(snapN.tasks.map(x => x.id), prefilter ? [] : [T1.id]);

    const T2 = makeTaskInput({ resultKey: 'x2-after', requires: { envFingerprint: FP, localMedia: 'node-A' } });
    const T3 = makeTaskInput({ resultKey: 'x2-free', requires: { envFingerprint: FP } });
    const out = h.publish('p', [T2, T3]);
    assert.deepEqual(out.of('a', 'task.opened').map(m => m.task.id).sort(), [T2.id, T3.id].sort());
    assert.deepEqual(out.of('b', 'task.opened').map(m => m.task.id), prefilter ? [T3.id] : [T2.id, T3.id]);

    const r = h.claim('b', T2.id, 1).one('b', 'task.claim-rejected');
    assert.deepEqual([r.reason, r.localMedia, r.state, r.version], ['local-media', 'node-A', 'open', 1]);
    assert.equal(h.task(T2.id).state, 'open', '拒绝不改状态');
    assert.equal(h.claim('a', T2.id, 1).one('a', 'task.claimed').id, T2.id, '发布方节点能认领');
    t.diagnostic(`PREFILTER=${prefilter}：B 快照 ${snapB.tasks.length} 条，B 收到 localMedia 任务的 opened ${out.of('b', 'task.opened').filter(m => m.task.requires.localMedia).length} 条`);
  }
});

test('X2-5 含本地档素材的项目端到端：别的节点对这类任务认领 0 次、收到的 task.opened 0 条；发布方节点把它们全部完成', async () => {
  const rig = createRig({ planContext: MEDIA_PLAN, durationMs: 400 });
  // 执行器之后按这一版项目加闸（vite-plugin-frames 的做法：owner = plan 的发布方）
  const gate = e => ({ ...e, plan: async (task, opts) => withLocalMedia(await e.plan(task, opts), { project: MEDIA_PROJECT, owner: task.source.publisher.id }) });
  const a = rig.addNode('node-A', { wrapExecutor: gate });
  const b = rig.addNode('node-B', { wrapExecutor: gate });
  a.local.start();
  b.local.start();
  await rig.settle();
  // 发布方就是 node-A 自己（预渲染进程替页面发布，契约 J.5）
  const plan = planTaskOf({ projectId: 'p1', projectRev: 1, codeVersion: CV, envFingerprint: FP, preferNode: 'node-A' });
  a.endpoint.send({ type: 'task.publish', tasks: [plan] });

  let derived = null;
  for (let i = 0; i < 400; i++) {
    await rig.step(100);
    derived = rig.task(plan.id)?.state === 'done' ? rig.queue.describe().tasks.filter(x => x.id !== plan.id) : null;
    if (derived && derived.length > 0 && derived.every(x => x.state === 'done')) break;
  }
  assert.ok(derived && derived.every(x => x.state === 'done'), `全部完成：${JSON.stringify(rig.queue.describe().tasks.map(x => [x.id, x.state]))}`);
  const gated = new Set(rig.lb.log().filter(e => e.dir === 'in' && e.message.type === 'task.publish')
    .flatMap(e => e.message.tasks).filter(x => x.requires?.localMedia === 'node-A').map(x => x.id));
  assert.equal(gated.size, 2, '本地档一段 + 引用本地素材的共享档一段');
  assert.equal(rig.sent(b.connId, 'task.claim').filter(m => gated.has(m.id)).length, 0, 'B 对这类任务认领 0 次');
  assert.equal(rig.received(b.connId, 'task.opened').filter(m => gated.has(m.task.id)).length, 0, 'B 收到这类任务的 task.opened 0 条');
  assert.equal(rig.received(b.connId, 'queue.snapshot').flatMap(m => m.tasks).filter(x => gated.has(x.id)).length, 0);
  const doneByA = new Set(a.events.filter(e => e.type === 'completed' || e.type === 'dedup').map(e => e.id));
  for (const id of gated) assert.ok(doneByA.has(id), `${id} 由发布方节点完成`);
  rig.hygiene();
  a.local.stop(); b.local.stop();
});

/* ================================================================== X3 watch: 'all' 收紧 */

test('X3-1 browser 用 watch all 回 forbidden，原来的 watch 不变；列出本人的项目照常', () => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('p', 'pub', { userId: 'u1' });
  const T1 = makeTaskInput({ resultKey: 'x3-1', projectId: 'p1' });
  h.publish('p', [T1]);
  const out = h.node('br', 'node-BR', { profile: 'browser', userId: 'u1', watch: ['p1'] });
  assert.deepEqual(out.one('br', 'queue.snapshot').tasks.map(x => x.id), [T1.id]);
  const e = h.watch('br', 'all').one('br', 'error');
  assert.equal(e.reason, 'forbidden');
  assert.equal(h.watch('br', 'all').of('br', 'queue.snapshot').length, 0, '不回快照');
  const T2 = makeTaskInput({ resultKey: 'x3-1b', projectId: 'p1' });
  assert.equal(h.publish('p', [T2]).of('br', 'task.opened').length, 1, '原来 watch 的项目照常收增量');
  const T3 = makeTaskInput({ resultKey: 'x3-1c', projectId: 'p2' });
  assert.equal(h.publish('p', [T3]).of('br', 'task.opened').length, 0, '没有变成全量');
  // 带 reqId 回显
  const withReq = h.handle('br', { type: 'queue.watch', projects: 'all', reqId: 'w1' }).one('br', 'error');
  assert.deepEqual([withReq.reason, withReq.reqId], ['forbidden', 'w1']);
});

test('X3-2 host 用 watch all：只收项目摘要，单任务增量 0 条；摘要每个扫描周期至多 1 条、变了才发，内容与任务表一致', t => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('p', 'pub');
  h.node('a', 'node-A', { hello: { envFingerprint: FP } });
  const first = h.node('w', 'node-W', { profile: 'host' });
  const s0 = first.one('w', 'queue.summary');
  assert.deepEqual(s0.projects, [], '开始时没有任务');
  assert.equal(s0.at, h.now());
  assert.equal(first.of('w', 'queue.snapshot').length, 0, '不回快照');

  const expected = () => {
    const d = h.describe();
    const byProject = new Map();
    for (const task of d.tasks) {
      if (task.state !== 'open' && task.state !== 'claimed') continue;
      const p = byProject.get(task.projectId) ?? { projectId: task.projectId, open: 0, claimed: 0 };
      p[task.state] += 1;
      byProject.set(task.projectId, p);
    }
    return [...byProject.values()].sort((x, y) => (x.projectId < y.projectId ? -1 : 1));
  };
  let deltas = 0;
  let summaries = 0;
  const tokens = [];
  for (let round = 0; round < 6; round++) {
    const m = h.bus.mark();
    // 每轮：3 个项目各发布 2 个（其中一个带指纹）、认领一个、完成上一轮认领的
    for (let k = 0; k < 3; k++) {
      h.publish('p', [
        makeTaskInput({ projectId: `proj-${k}`, resultKey: `x3-2-${round}-${k}`, priority: round + k }),
        makeTaskInput({ projectId: `proj-${k}`, resultKey: `x3-2f-${round}-${k}`, requires: { envFingerprint: FP } }),
      ]);
    }
    const open = h.describe().tasks.find(x => x.state === 'open');
    tokens.push({ id: open.id, token: h.claim('a', open.id, open.version).one('a', 'task.claimed').token });
    if (tokens.length > 1) { const { id, token } = tokens.shift(); h.complete('a', id, token, { ranges: [[0, 59]] }); }
    const beforeTick = h.bus.since(m);
    assert.equal(beforeTick.of('w').length, 0, `第 ${round} 轮：tick 之前 host 什么都不收`);
    const tick = h.tick();
    const got = tick.of('w');
    deltas += h.bus.since(m).of('w').filter(x => DELTAS.has(x.type)).length;
    summaries += got.length;
    assert.equal(got.length, 1, `第 ${round} 轮有变化：tick 发 1 条摘要`);
    assert.equal(got[0].type, 'queue.summary');
    assert.deepEqual(got[0].projects.map(({ projectId, open: o, claimed }) => ({ projectId, open: o, claimed })), expected());
    for (const p of got[0].projects) {
      const openTasks = h.describe().tasks.filter(x => x.projectId === p.projectId && x.state === 'open');
      assert.equal(Object.values(p.openByFingerprint).reduce((x, y) => x + y, 0), p.open, 'openByFingerprint 的和是 open');
      assert.ok(p.topPriority === null || openTasks.length > 0);
    }
    assert.equal(h.tick().of('w').length, 0, `第 ${round} 轮没有变化的 tick 不再发`);
  }
  t.diagnostic(`host watch all：单任务增量 ${deltas} 条，摘要 ${summaries} 条（6 个周期）`);
  assert.equal(deltas, 0, '单任务增量 0 条');
  assert.equal(h.bus.of('w').filter(x => DELTAS.has(x.type)).length, 0);
  // 同一时刻 pc 的 watch all 照旧：收增量、不收摘要
  assert.ok(h.bus.of('a').some(x => x.type === 'task.opened'), 'pc 照旧收全量');
  assert.equal(h.bus.of('a').filter(x => x.type === 'queue.summary').length, 0);
});

test('X3-3 host 在摘要之外 watch 具体项目：收这些项目的快照与增量，摘要照发；空列表连摘要一起停；重新报到成别的 profile 摘要停', () => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('p', 'pub');
  h.node('w', 'node-W', { profile: 'host' });
  const T1 = makeTaskInput({ projectId: 'proj-1', resultKey: 'x3-3a' });
  h.publish('p', [T1]);
  const s = h.tick().one('w', 'queue.summary');
  assert.deepEqual(s.projects.map(p => [p.projectId, p.open]), [['proj-1', 1]]);
  assert.deepEqual(h.watch('w', ['proj-1']).one('w', 'queue.snapshot').tasks.map(x => x.id), [T1.id]);
  const T2 = makeTaskInput({ projectId: 'proj-1', resultKey: 'x3-3b' });
  const T3 = makeTaskInput({ projectId: 'proj-2', resultKey: 'x3-3c' });
  const out = h.publish('p', [T2, T3]);
  assert.deepEqual(out.of('w', 'task.opened').map(m => m.task.id), [T2.id], '只收 watch 的项目');
  assert.deepEqual(h.tick().one('w', 'queue.summary').projects.map(p => p.projectId), ['proj-1', 'proj-2'], '摘要照发');
  h.watch('w', []);
  h.publish('p', [makeTaskInput({ projectId: 'proj-3', resultKey: 'x3-3d' })]);
  assert.equal(h.tick().of('w').length, 0, '空列表：摘要也停');
  // 摘要中的 host 以 pc 重新报到：摘要停
  h.watch('w', 'all');
  h.hello('w', 'node-W', { profile: 'pc' });
  h.publish('p', [makeTaskInput({ projectId: 'proj-4', resultKey: 'x3-3e' })]);
  assert.equal(h.tick().of('w', 'queue.summary').length, 0);
});

test('X3-4 host 会话按摘要改 watch：接到有活的项目就 watch 它们、认领细任务；plan 看得见也不认领', async () => {
  const rig = createRig({ planContext: MEDIA_PLAN, durationMs: 200 });
  const host = rig.addNode('host-1', { node: { ...pcNode(), profile: 'host' } });
  host.local.start();
  await rig.settle();
  assert.deepEqual(rig.received(host.connId, 'queue.summary').length, 1, '报到后 watch all 回一条摘要');
  const pub = rig.lb.connect('pub', { userId: 'u1', tenantId: 't1' });
  pub.send({ type: 'publisher.hello', publisherId: 'pub' });
  const fine = makeTaskInput({ projectId: 'p9', resultKey: 'x3-4', requires: { envFingerprint: FP, codeVersion: CV } });
  const plan = makeTaskInput({ projectId: 'p9', projectRev: 2, kind: 'plan', requires: { codeVersion: CV } });
  pub.send({ type: 'task.publish', tasks: [fine, plan] });
  for (let i = 0; i < 40 && rig.task(fine.id)?.state !== 'done'; i++) await rig.step(100);
  assert.equal(rig.task(fine.id)?.state, 'done', '细任务被 host 做完');
  assert.deepEqual(host.local.session.watching(), ['p9']);
  assert.equal(rig.sent(host.connId, 'task.claim').filter(m => m.id === plan.id).length, 0, 'plan 不认领');
  assert.equal(rig.task(plan.id).state, 'open');
  assert.deepEqual(rig.sent(host.connId, 'queue.watch').map(m => m.projects), ['all', ['p9']]);
  rig.hygiene();
  host.local.stop();
});

/* ================================================================== X4 plan 就近认领 */

function planScene(constants) {
  const h = createQueueHarness(createRenderQueue, constants ? { constants } : {});
  h.publisher('p', 'node-A');
  h.node('a', 'node-A', { hello: { envFingerprint: FP } });
  h.node('b', 'node-B', { hello: { envFingerprint: FP } });
  h.node('c', 'node-C', { hello: { envFingerprint: FP_B } });
  h.node('ho', 'node-HO', { profile: 'host', hello: { envFingerprint: FP } });
  h.node('br', 'node-BR', { profile: 'browser', watch: ['p1'], hello: { envFingerprint: FP } });
  const plan = planTaskOf({ projectId: 'p1', projectRev: 1, codeVersion: CV, envFingerprint: FP, preferNode: 'node-A' });
  const r = h.publish('p', [plan]).one('p', 'task.published').results[0];
  assert.equal(r.created, true);
  return { h, plan };
}

test('X4-1 常量与 planTaskOf：PLAN_PREFER_MS 缺省 5000、环境变量名；planTaskOf 给了 preferNode 才写进 requires', () => {
  assert.equal(QUEUE_DEFAULTS.PLAN_PREFER_MS, 5_000);
  assert.equal(QUEUE_ENV.PLAN_PREFER_MS, 'PROMPTCUT_QUEUE_PLAN_PREFER_MS');
  assert.deepEqual(planTaskOf({ projectId: 'p', projectRev: 1, preferNode: 'n1' }).requires, { preferNode: 'n1' });
  assert.deepEqual(planTaskOf({ projectId: 'p', projectRev: 1 }).requires, {});
  assert.deepEqual(planTaskOf({ projectId: 'p', projectRev: 1, codeVersion: CV, envFingerprint: FP, preferNode: 'n1' }).requires,
    { codeVersion: CV, envFingerprint: FP, preferNode: 'n1' });
});

test('X4-2 窗口内别的 pc 认领 plan 回 preferred（带 retryInMs，状态不变）；preferNode 自己能认领', () => {
  const { h, plan } = planScene();
  h.clock.advance(4_000);
  const r = h.claim('b', plan.id, 1).one('b', 'task.claim-rejected');
  assert.deepEqual([r.reason, r.preferNode, r.state, r.version, r.retryInMs], ['preferred', 'node-A', 'open', 1, 1_001]);
  h.clock.set(T0 + 5_000);   // 恰好 PLAN_PREFER_MS：仍在窗口里（过期按严格大于判）
  assert.equal(h.claim('b', plan.id, 1).one('b', 'task.claim-rejected').reason, 'preferred');
  assert.equal(h.task(plan.id).state, 'open');
  assert.equal(h.claim('a', plan.id, 1).one('a', 'task.claimed').id, plan.id, 'preferNode 在窗口里能认领');
});

test('X4-6（集成裁定）preferNode 断开：独占窗口立即结束，别的 pc 马上能认领；重连也不恢复窗口', () => {
  const { h, plan } = planScene();
  h.clock.advance(1_000);
  assert.equal(h.claim('b', plan.id, 1).one('b', 'task.claim-rejected').reason, 'preferred', '断开前：窗口在');
  h.disconnect('a');
  // 发布方与节点常在同一条连接；这里节点 a 单独断开，发布方 p 还在，plan 不会因为没人要被删
  h.node('a2', 'node-A', { hello: { envFingerprint: FP } });   // 同一 nodeId 重连
  h.clock.advance(1_000);   // 仍在原来的 5 s 窗口里
  assert.equal(h.claim('b', plan.id, 1).one('b', 'task.claimed').id, plan.id, '断开之后窗口结束，别的 pc 能认领');
});

test('X4-3 窗口过后任何指纹符合的 pc 能认领；指纹不符的回 fingerprint-mismatch；PLAN_PREFER_MS 可覆盖', () => {
  const { h, plan } = planScene();
  h.clock.set(T0 + 5_001);
  assert.equal(h.claim('c', plan.id, 1).one('c', 'task.claim-rejected').reason, 'fingerprint-mismatch', '指纹不符');
  assert.equal(h.claim('b', plan.id, 1).one('b', 'task.claimed').id, plan.id, '窗口过后别的 pc 能认领');

  const { h: h2, plan: plan2 } = planScene({ PLAN_PREFER_MS: 100 });
  h2.clock.advance(101);
  assert.equal(h2.claim('b', plan2.id, 1).one('b', 'task.claimed').id, plan2.id, '覆盖的窗口');
  // 过滤开时，带 preferNode 的 plan 对指纹不符的节点也看不见（和细任务同一处前置过滤）
  const { h: h3 } = planScene();
  const snapC = h3.watch('c', 'all').one('c', 'queue.snapshot');
  assert.equal(snapC.tasks.length, 0);
});

test('X4-4 host 与 browser 认领 plan 一律回 plan-profile（窗口内外都是），认领 0 次；节点侧规则 6 本来就跳过', () => {
  const { h, plan } = planScene();
  let claims = 0;
  for (const at of [T0 + 1, T0 + 5_001, T0 + 60_000]) {
    h.clock.set(at);
    for (const conn of ['ho', 'br']) {
      const out = h.claim(conn, plan.id, 1);
      claims += out.of(conn, 'task.claimed').length;
      assert.equal(out.one(conn, 'task.claim-rejected').reason, 'plan-profile', `${conn} @${at - T0}`);
    }
  }
  assert.equal(claims, 0);
  assert.equal(h.task(plan.id).state, 'open');
  const view = { ...plan, source: { ...plan.source, userId: 'u1' } };
  assert.deepEqual(checkClaimable(view, { ...pcNode(), profile: 'host' }), { ok: false, rule: 6, reason: 'plan-on-host' });
  assert.equal(checkClaimable(view, { ...pcNode(), profile: 'browser', userId: 'u1' }).ok, false);
  // 节点侧：带 preferNode 的 plan 查指纹（规则 1）；没带的旧形状不查
  assert.deepEqual(checkClaimable(view, pcNode(FP_B)), { ok: false, rule: 1, reason: 'env-fingerprint' });
  const legacy = { ...view, requires: { codeVersion: CV, envFingerprint: FP } };
  assert.deepEqual(checkClaimable(legacy, pcNode(FP_B)), { ok: true });
});

test('X4-5 会话端到端：发布方节点忙时，别的 pc 在窗口内被回 preferred、候选搁到窗口过后才认领；发布方闲时窗口内由它认领', async () => {
  for (const busyPublisher of [true, false]) {
    const rig = createRig({ planContext: { entryKey: 'e'.repeat(64), cardPlan: [], streams: [] } });
    const a = rig.addNode('node-A', { isIdle: () => !busyPublisher });
    const b = rig.addNode('node-B');
    a.local.start();
    b.local.start();
    await rig.settle();
    const plan = planTaskOf({ projectId: 'p1', projectRev: 1, codeVersion: CV, envFingerprint: FP, preferNode: 'node-A' });
    const publishedAt = rig.clock.now();
    a.endpoint.send({ type: 'task.publish', tasks: [plan] });
    let claimedAt = null;
    for (let i = 0; i < 120 && claimedAt === null; i++) {
      await rig.step(100);
      if (rig.task(plan.id)?.state !== 'open' && claimedAt === null) claimedAt = rig.clock.now();
    }
    const winner = [a, b].find(n => rig.received(n.connId, 'task.claimed').some(m => m.id === plan.id));
    const preferred = rig.received(b.connId, 'task.claim-rejected').filter(m => m.reason === 'preferred');
    if (busyPublisher) {
      assert.equal(winner, b, '发布方忙：窗口过后别的 pc 认领');
      assert.ok(claimedAt - publishedAt > QUEUE_DEFAULTS.PLAN_PREFER_MS, `窗口过后才认领到（${claimedAt - publishedAt} ms）`);
      assert.ok(preferred.length >= 1 && preferred.length <= 2, `窗口里只被回过一两次 preferred（候选搁置，不是每拍都撞）：${preferred.length}`);
    } else {
      assert.equal(winner, a, '发布方闲：它自己在窗口内认领');
      assert.ok(claimedAt - publishedAt <= QUEUE_DEFAULTS.PLAN_PREFER_MS);
    }
    rig.hygiene();
    a.local.stop(); b.local.stop();
  }
});

/* ================================================================== X5 闲时门槛 */

/** 假管线：preload 的一个代际还在 html（没 ready），其余安静 */
function fakePipeline(extra = {}) {
  const controller = new AbortController();
  return {
    closed: false, _streams: null, backgroundYielding: false, backgroundLeaseUntil: 0, playback: null,
    streamBusy: () => false, playhead: () => null,
    generations: new Map([['g1', { key: 'entry-1', controller }]]),
    entries: new Map([['entry-1', { status: 'html' }]]),
    ...extra,
  };
}

test('X5-1 闲时门槛：最近 500 ms 有交互帧请求不认领，满 500 ms 才认领；播放、让路、拖动的播放头、在播都算忙', () => {
  let now = 50_000;
  const pipeline = fakePipeline();
  let outside = -Infinity;
  const gate = createQueueIdleGate({ pipeline, now: () => now, lastInteractionAt: () => outside });
  assert.equal(INTERACTION_QUIET_MS, 500);
  assert.equal(gate.idle(), true, '安静：能认领');
  gate.note();
  now += 499;
  assert.equal(gate.reason(), 'interaction');
  now += 1;
  assert.equal(gate.idle(), true, '满 500 ms');
  outside = now - 100;   // 路由记下的交互（/see user、/playback）
  assert.equal(gate.idle(), false);
  outside = -Infinity;

  const at = now;
  assert.equal(interactionReason({ ...pipeline, playback: { playing: true } }, at), 'playback');
  assert.equal(interactionReason({ ...pipeline, backgroundYielding: true }, at), 'yield');
  assert.equal(interactionReason({ ...pipeline, backgroundLeaseUntil: at + 1 }, at), 'yield');
  assert.equal(interactionReason({ ...pipeline, playhead: () => ({ at: at - 300, playing: false }) }, at), 'scrub');
  assert.equal(interactionReason({ ...pipeline, playhead: () => ({ at: at - 600, playing: false }) }, at), null, '拖动停下 600 ms');
  assert.equal(interactionReason({ ...pipeline, playhead: () => ({ at: at - 3_000, playing: true }) }, at), 'playing');
  assert.equal(interactionReason({ ...pipeline, playhead: () => ({ at: at - 6_000, playing: true }) }, at), null, '在播但 5 秒没音讯');
  assert.equal(interactionReason({ ...pipeline, playhead: () => { throw new Error('x'); } }, at), null);
  assert.equal(interactionReason({ ...pipeline, closed: true }, at), 'closed');
});

test('X5-2 preload 未 ready 时门槛放行（M5b 的执行器 isIdle 在这时不放行；集成时 isIdle 已删）', () => {
  const pipeline = fakePipeline();
  assert.equal(createQueueIdleGate({ pipeline }).idle(), true, 'X5：preload 没 ready 也能认领');
  // 流在忙同样不挡（执行器有空位由会话守）
  const busyStreams = fakePipeline({ _streams: { workers: new Set([1]), encoding: new Set() } });
  assert.equal(createQueueIdleGate({ pipeline: busyStreams }).idle(), true);
});

test('X5-3 模拟拖动期间新认领 0 次，手里在做的做完（不放回）；停手满 500 ms 恢复认领', async t => {
  const rig = createRig({ planContext: { entryKey: 'e', cardPlan: [] }, durationMs: 2_500 });
  let dragging = false;
  const gate = createQueueIdleGate({ now: rig.clock.now });
  const n = rig.addNode('node-A', { isIdle: () => gate.idle() });
  n.local.start();
  await rig.settle();
  const pub = rig.lb.connect('pub', { userId: 'u1', tenantId: 't1' });
  pub.send({ type: 'publisher.hello', publisherId: 'pub' });
  const tasks = Array.from({ length: 6 }, (_, i) => makeTaskInput({ resultKey: `x5-3-${i}`, requires: { envFingerprint: FP, codeVersion: CV } }));
  pub.send({ type: 'task.publish', tasks });
  // 先让它认领到一个、开工
  for (let i = 0; i < 10 && n.local.running().length === 0; i++) await rig.step(100);
  const holding = n.local.running();
  assert.equal(holding.length, 1, '拖动之前手里有一个在做');
  const claimsBefore = rig.sent(n.connId, 'task.claim').length;

  // 拖动 3 秒：每 100 ms 一次交互帧请求
  dragging = true;
  for (let i = 0; i < 30; i++) { if (dragging) gate.note(); await rig.step(100); }
  dragging = false;
  const claimsDuring = rig.sent(n.connId, 'task.claim').length - claimsBefore;
  t.diagnostic(`拖动 3 s 期间新认领 ${claimsDuring} 次；拖动前在做的 ${holding[0]} 状态 ${rig.task(holding[0])?.state}`);
  assert.equal(claimsDuring, 0, '拖动期间新认领 0 次');
  assert.equal(rig.sent(n.connId, 'task.release').length, 0, '手里在做的不放回');
  assert.equal(rig.task(holding[0]).state, 'done', '手里在做的做完');

  // 停手：400 ms 内仍不认领，满 500 ms 之后恢复
  await rig.step(100); await rig.step(100); await rig.step(100);
  assert.equal(rig.sent(n.connId, 'task.claim').length - claimsBefore, 0, '停手不到 500 ms 仍不认领');
  for (let i = 0; i < 5; i++) await rig.step(100);
  assert.ok(rig.sent(n.connId, 'task.claim').length - claimsBefore >= 1, '停手满 500 ms 恢复认领');
  rig.hygiene();
  n.local.stop();
});
