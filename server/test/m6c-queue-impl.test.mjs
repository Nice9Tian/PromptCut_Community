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
    throw new Error('message round trips do not converge');
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
    assert.deepEqual(lb.errors().map(e => String(e?.stack ?? e)), [], 'The endpoint handler / queue.handle threw an exception');
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

test('X2-1 localMediaGate: only media without a content hash that is fetched by a local address counts as local; the local tier and streams always count, the shared tier depends on clip references, and when the clip cannot be found it counts conservatively', () => {
  assert.deepEqual(hashlessMedia(MEDIA_PROJECT).map(m => m.id), ['m-local']);
  assert.deepEqual(hashlessMedia({ media: [
    { id: 'a', path: 'C:/x.mp4' }, { id: 'b', url: '/api/media/file?path=x' }, { id: 'c', url: '/@export/e1/media/x.mp4' },
    { id: 'd', url: `/@media/${HASH}` }, { id: 'e', hash: HASH, url: '/@media/name.mp4' }, { id: 'f', url: 'https://cdn.example/x.png' },
    { id: 'g', url: 'blob:abc' },
  ] }).map(m => m.id), ['a', 'b', 'c'], 'path, /api/media/file and /@export count; those with a hash, external addresses and blob do not');
  assert.equal(localMediaGate({ media: [{ id: 'h', hash: HASH }], tracks: [] }), null, 'All media have hashes: no gate is set');
  assert.equal(localMediaGate({}), null);

  const uses = localMediaGate(MEDIA_PROJECT);
  assert.equal(uses(control('clip-local', 'local', 60)), true, 'Local-tier whole-scene render: counts');
  assert.equal(uses(control('clip-media', 'shared', 60)), true, 'Shared-tier clip references local media: counts');
  assert.equal(uses(control('clip-plain', 'shared', 120)), false, 'Shared-tier clip references only media with hashes: does not count');
  assert.equal(uses(control('clip-gone', 'shared', 10)), true, 'Clip not found: counts conservatively');
  assert.equal(uses({ clipId: 'clip-plain', kind: 'stream' }), true, 'Stream: counts');
  // 档位缺省按 capabilities 判
  assert.equal(uses({ clipId: 'clip-plain', capabilities: { frameMode: 'stateful', compositing: 'unknown' } }), true, 'unknown is the local tier');

  const ctx = { entryKey: 'k', cardPlan: [] };
  assert.equal(withLocalMedia(ctx, { project: { media: [] }, owner: 'node-A' }), ctx, 'No local media: returned as is');
  assert.equal(withLocalMedia(ctx, { project: MEDIA_PROJECT, owner: '' }), ctx, 'No owner: returned as is');
  const gated = withLocalMedia(ctx, { project: MEDIA_PROJECT, owner: 'node-A' });
  assert.equal(gated.localMedia, 'node-A');
  assert.equal(typeof gated.usesLocalMedia, 'function');
  assert.equal(ctx.localMedia, undefined, 'The input argument is not modified');
});

test('X2-2 splitPlan: when localMedia is given, snapshot and stream tasks for which usesLocalMedia is true get requires.localMedia written; when it is not given the task shape is unchanged', () => {
  const planTask = planTaskOf({ projectId: 'p1', projectRev: 3 });
  const base = { planTask, ...MEDIA_PLAN, envFingerprint: FP, codeVersion: CV,
    streams: [{ streamKey: 'stream-k', contentKey: 'stream-ck', topClipId: 'clip-plain', firstSegment: 0, lastSegment: 3 }] };
  const plain = splitPlan(base);
  assert.ok(plain.every(t => !('localMedia' in t.requires)), 'localMedia not given: requires has no such entry');

  const uses = localMediaGate(MEDIA_PROJECT);
  const gated = splitPlan({ ...base, localMedia: 'node-A', usesLocalMedia: uses });
  assert.deepEqual(gated.map(t => t.id), plain.map(t => t.id), 'Task ids are unchanged (localMedia does not go into the result key)');
  const byClip = Object.groupBy(gated, t => t.input.clipId);
  assert.ok(byClip['clip-local'].every(t => t.requires.localMedia === 'node-A'), 'Local tier');
  assert.ok(byClip['clip-media'].every(t => t.requires.localMedia === 'node-A'), 'Shared tier referencing local media');
  const plainShared = byClip['clip-plain'].filter(t => t.kind === 'snapshot');
  assert.equal(plainShared.length, 2);
  assert.ok(plainShared.every(t => !('localMedia' in t.requires)), 'Shared tier referencing only media with hashes sets no gate');
  const streams = gated.filter(t => t.kind === 'stream');
  assert.ok(streams.length > 0 && streams.every(t => t.requires.localMedia === 'node-A'), 'stream tasks');
  // 缺省 usesLocalMedia：给了 localMedia 就全部设闸
  assert.ok(splitPlan({ ...base, localMedia: 'node-A' }).every(t => t.requires.localMedia === 'node-A'));
  // 其余字段与不设闸时一样
  for (let i = 0; i < gated.length; i++) {
    const { localMedia: _drop, ...rest } = gated[i].requires;
    assert.deepEqual({ ...gated[i], requires: rest }, plain[i]);
  }
});

test('X2-3 node-side filter rule 1: skip when requires.localMedia is not equal to this node\'s nodeId; the session fills nodeId into the filter', () => {
  const task = makeTaskInput({ requires: { envFingerprint: FP, codeVersion: CV, localMedia: 'node-A' } });
  const view = { ...task, source: { ...task.source, userId: 'u1' } };
  assert.deepEqual(checkClaimable(view, { ...pcNode(), nodeId: 'node-A' }), { ok: true });
  assert.deepEqual(checkClaimable(view, { ...pcNode(), nodeId: 'node-B' }), { ok: false, rule: 1, reason: 'local-media' });
  assert.deepEqual(checkClaimable(view, pcNode()), { ok: false, rule: 1, reason: 'local-media' }, 'nodeId unknown: does not take it');

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
  assert.deepEqual(sentA.filter(m => m.type === 'task.claim').map(m => m.id), [task.id], 'node-A claims');
  assert.deepEqual(sentB.filter(m => m.type === 'task.claim'), [], 'node-B does not claim');
});

test('X2-4 queue: under the pre-filter, other nodes cannot see localMedia tasks (neither in the snapshot nor in task.opened) and a claim returns local-media; with PREFILTER off they can see them but still cannot claim', t => {
  for (const prefilter of [true, false]) {
    const h = createQueueHarness(createRenderQueue, { constants: { PREFILTER: prefilter } });
    h.publisher('p', 'node-A');
    const T1 = makeTaskInput({ resultKey: 'x2-before', requires: { envFingerprint: FP, localMedia: 'node-A' } });
    h.publish('p', [T1]);
    const snapA = h.node('a', 'node-A', { hello: { envFingerprint: FP } }).one('a', 'queue.snapshot');
    const snapB = h.node('b', 'node-B', { hello: { envFingerprint: FP } }).one('b', 'queue.snapshot');
    const snapN = h.node('n', 'node-N').one('n', 'queue.snapshot');   // 不带指纹的节点：localMedia 照样挡
    assert.deepEqual(snapA.tasks.map(x => x.id), [T1.id]);
    assert.deepEqual(snapB.tasks.map(x => x.id), prefilter ? [] : [T1.id], `Filter ${prefilter ? 'on' : 'off'}: B's snapshot`);
    assert.deepEqual(snapN.tasks.map(x => x.id), prefilter ? [] : [T1.id]);

    const T2 = makeTaskInput({ resultKey: 'x2-after', requires: { envFingerprint: FP, localMedia: 'node-A' } });
    const T3 = makeTaskInput({ resultKey: 'x2-free', requires: { envFingerprint: FP } });
    const out = h.publish('p', [T2, T3]);
    assert.deepEqual(out.of('a', 'task.opened').map(m => m.task.id).sort(), [T2.id, T3.id].sort());
    assert.deepEqual(out.of('b', 'task.opened').map(m => m.task.id), prefilter ? [T3.id] : [T2.id, T3.id]);

    const r = h.claim('b', T2.id, 1).one('b', 'task.claim-rejected');
    assert.deepEqual([r.reason, r.localMedia, r.state, r.version], ['local-media', 'node-A', 'open', 1]);
    assert.equal(h.task(T2.id).state, 'open', 'A rejection does not change the state');
    assert.equal(h.claim('a', T2.id, 1).one('a', 'task.claimed').id, T2.id, 'The publisher node can claim');
    t.diagnostic(`PREFILTER=${prefilter}: B snapshot has ${snapB.tasks.length} entries, B received ${out.of('b', 'task.opened').filter(m => m.task.requires.localMedia).length} opened messages for localMedia tasks`);
  }
});

test('X2-5 end to end for a project with local-tier media: other nodes claim such tasks 0 times and receive 0 task.opened; the publisher node completes all of them', async () => {
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
  assert.ok(derived && derived.every(x => x.state === 'done'), `All completed: ${JSON.stringify(rig.queue.describe().tasks.map(x => [x.id, x.state]))}`);
  const gated = new Set(rig.lb.log().filter(e => e.dir === 'in' && e.message.type === 'task.publish')
    .flatMap(e => e.message.tasks).filter(x => x.requires?.localMedia === 'node-A').map(x => x.id));
  assert.equal(gated.size, 2, 'One local-tier segment + one shared-tier segment referencing local media');
  assert.equal(rig.sent(b.connId, 'task.claim').filter(m => gated.has(m.id)).length, 0, 'B claims such tasks 0 times');
  assert.equal(rig.received(b.connId, 'task.opened').filter(m => gated.has(m.task.id)).length, 0, 'B receives 0 task.opened for such tasks');
  assert.equal(rig.received(b.connId, 'queue.snapshot').flatMap(m => m.tasks).filter(x => gated.has(x.id)).length, 0);
  const doneByA = new Set(a.events.filter(e => e.type === 'completed' || e.type === 'dedup').map(e => e.id));
  for (const id of gated) assert.ok(doneByA.has(id), `${id} is completed by the publisher node`);
  rig.hygiene();
  a.local.stop(); b.local.stop();
});

/* ================================================================== X3 watch: 'all' 收紧 */

test('X3-1 browser with watch all returns forbidden, its earlier watch is unchanged; listing its own projects works as usual', () => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('p', 'pub', { userId: 'u1' });
  const T1 = makeTaskInput({ resultKey: 'x3-1', projectId: 'p1' });
  h.publish('p', [T1]);
  const out = h.node('br', 'node-BR', { profile: 'browser', userId: 'u1', watch: ['p1'] });
  assert.deepEqual(out.one('br', 'queue.snapshot').tasks.map(x => x.id), [T1.id]);
  const e = h.watch('br', 'all').one('br', 'error');
  assert.equal(e.reason, 'forbidden');
  assert.equal(h.watch('br', 'all').of('br', 'queue.snapshot').length, 0, 'No snapshot is returned');
  const T2 = makeTaskInput({ resultKey: 'x3-1b', projectId: 'p1' });
  assert.equal(h.publish('p', [T2]).of('br', 'task.opened').length, 1, 'The project watched earlier still receives deltas as usual');
  const T3 = makeTaskInput({ resultKey: 'x3-1c', projectId: 'p2' });
  assert.equal(h.publish('p', [T3]).of('br', 'task.opened').length, 0, 'Did not turn into the full set');
  // 带 reqId 回显
  const withReq = h.handle('br', { type: 'queue.watch', projects: 'all', reqId: 'w1' }).one('br', 'error');
  assert.deepEqual([withReq.reason, withReq.reqId], ['forbidden', 'w1']);
});

test('X3-2 host with watch all: receives only project summaries and 0 single-task deltas; at most 1 summary per scan cycle, sent only when changed, content consistent with the task table', t => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('p', 'pub');
  h.node('a', 'node-A', { hello: { envFingerprint: FP } });
  const first = h.node('w', 'node-W', { profile: 'host' });
  const s0 = first.one('w', 'queue.summary');
  assert.deepEqual(s0.projects, [], 'No tasks at the start');
  assert.equal(s0.at, h.now());
  assert.equal(first.of('w', 'queue.snapshot').length, 0, 'No snapshot is returned');

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
    assert.equal(beforeTick.of('w').length, 0, `Round ${round}: host receives nothing before the tick`);
    const tick = h.tick();
    const got = tick.of('w');
    deltas += h.bus.since(m).of('w').filter(x => DELTAS.has(x.type)).length;
    summaries += got.length;
    assert.equal(got.length, 1, `Round ${round} has changes: the tick sends 1 summary`);
    assert.equal(got[0].type, 'queue.summary');
    assert.deepEqual(got[0].projects.map(({ projectId, open: o, claimed }) => ({ projectId, open: o, claimed })), expected());
    for (const p of got[0].projects) {
      const openTasks = h.describe().tasks.filter(x => x.projectId === p.projectId && x.state === 'open');
      assert.equal(Object.values(p.openByFingerprint).reduce((x, y) => x + y, 0), p.open, 'The sum of openByFingerprint is open');
      assert.ok(p.topPriority === null || openTasks.length > 0);
    }
    assert.equal(h.tick().of('w').length, 0, `Round ${round}: a tick with no changes does not send again`);
  }
  t.diagnostic(`host watch all: ${deltas} single-task deltas, ${summaries} summaries (6 cycles)`);
  assert.equal(deltas, 0, '0 single-task deltas');
  assert.equal(h.bus.of('w').filter(x => DELTAS.has(x.type)).length, 0);
  // 同一时刻 pc 的 watch all 照旧：收增量、不收摘要
  assert.ok(h.bus.of('a').some(x => x.type === 'task.opened'), 'pc still receives the full set');
  assert.equal(h.bus.of('a').filter(x => x.type === 'queue.summary').length, 0);
});

test('X3-3 host also watches specific projects besides the summary: it receives snapshots and deltas for those projects while summaries are still sent; an empty list stops the summary too; checking in again as another profile stops the summary', () => {
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
  assert.deepEqual(out.of('w', 'task.opened').map(m => m.task.id), [T2.id], 'Receives only the watched projects');
  assert.deepEqual(h.tick().one('w', 'queue.summary').projects.map(p => p.projectId), ['proj-1', 'proj-2'], 'Summaries are still sent');
  h.watch('w', []);
  h.publish('p', [makeTaskInput({ projectId: 'proj-3', resultKey: 'x3-3d' })]);
  assert.equal(h.tick().of('w').length, 0, 'Empty list: summaries stop too');
  // 摘要中的 host 以 pc 重新报到：摘要停
  h.watch('w', 'all');
  h.hello('w', 'node-W', { profile: 'pc' });
  h.publish('p', [makeTaskInput({ projectId: 'proj-4', resultKey: 'x3-3e' })]);
  assert.equal(h.tick().of('w', 'queue.summary').length, 0);
});

test('X3-4 a host session changes its watch according to the summary: on receiving projects that have work it watches them and claims fine-grained tasks; it does not claim a plan even when it can see it', async () => {
  const rig = createRig({ planContext: MEDIA_PLAN, durationMs: 200 });
  const host = rig.addNode('host-1', { node: { ...pcNode(), profile: 'host' } });
  host.local.start();
  await rig.settle();
  assert.deepEqual(rig.received(host.connId, 'queue.summary').length, 1, 'After check-in, watch all returns one summary');
  const pub = rig.lb.connect('pub', { userId: 'u1', tenantId: 't1' });
  pub.send({ type: 'publisher.hello', publisherId: 'pub' });
  const fine = makeTaskInput({ projectId: 'p9', resultKey: 'x3-4', requires: { envFingerprint: FP, codeVersion: CV } });
  const plan = makeTaskInput({ projectId: 'p9', projectRev: 2, kind: 'plan', requires: { codeVersion: CV } });
  pub.send({ type: 'task.publish', tasks: [fine, plan] });
  for (let i = 0; i < 40 && rig.task(fine.id)?.state !== 'done'; i++) await rig.step(100);
  assert.equal(rig.task(fine.id)?.state, 'done', 'The fine-grained task is completed by host');
  assert.deepEqual(host.local.session.watching(), ['p9']);
  assert.equal(rig.sent(host.connId, 'task.claim').filter(m => m.id === plan.id).length, 0, 'plan is not claimed');
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

test('X4-1 constants and planTaskOf: PLAN_PREFER_MS defaults to 5000 and has its environment variable name; planTaskOf writes preferNode into requires only when it is given', () => {
  assert.equal(QUEUE_DEFAULTS.PLAN_PREFER_MS, 5_000);
  assert.equal(QUEUE_ENV.PLAN_PREFER_MS, 'PROMPTCUT_QUEUE_PLAN_PREFER_MS');
  assert.deepEqual(planTaskOf({ projectId: 'p', projectRev: 1, preferNode: 'n1' }).requires, { preferNode: 'n1' });
  assert.deepEqual(planTaskOf({ projectId: 'p', projectRev: 1 }).requires, {});
  assert.deepEqual(planTaskOf({ projectId: 'p', projectRev: 1, codeVersion: CV, envFingerprint: FP, preferNode: 'n1' }).requires,
    { codeVersion: CV, envFingerprint: FP, preferNode: 'n1' });
});

test('X4-2 within the window, another pc\'s claim of the plan returns preferred (with retryInMs, state unchanged); preferNode itself can claim', () => {
  const { h, plan } = planScene();
  h.clock.advance(4_000);
  const r = h.claim('b', plan.id, 1).one('b', 'task.claim-rejected');
  assert.deepEqual([r.reason, r.preferNode, r.state, r.version, r.retryInMs], ['preferred', 'node-A', 'open', 1, 1_001]);
  h.clock.set(T0 + 5_000);   // 恰好 PLAN_PREFER_MS：仍在窗口里（过期按严格大于判）
  assert.equal(h.claim('b', plan.id, 1).one('b', 'task.claim-rejected').reason, 'preferred');
  assert.equal(h.task(plan.id).state, 'open');
  assert.equal(h.claim('a', plan.id, 1).one('a', 'task.claimed').id, plan.id, 'preferNode can claim within the window');
});

test('X4-6 (integration ruling) preferNode disconnects: the exclusive window ends immediately and another pc can claim right away; reconnecting does not restore the window', () => {
  const { h, plan } = planScene();
  h.clock.advance(1_000);
  assert.equal(h.claim('b', plan.id, 1).one('b', 'task.claim-rejected').reason, 'preferred', 'Before the disconnect: the window is in place');
  h.disconnect('a');
  // 发布方与节点常在同一条连接；这里节点 a 单独断开，发布方 p 还在，plan 不会因为没人要被删
  h.node('a2', 'node-A', { hello: { envFingerprint: FP } });   // 同一 nodeId 重连
  h.clock.advance(1_000);   // 仍在原来的 5 s 窗口里
  assert.equal(h.claim('b', plan.id, 1).one('b', 'task.claimed').id, plan.id, 'After the disconnect the window ends, and another pc can claim');
});

test('X4-3 after the window, any pc with a matching fingerprint can claim; one with a mismatched fingerprint gets fingerprint-mismatch; PLAN_PREFER_MS can be overridden', () => {
  const { h, plan } = planScene();
  h.clock.set(T0 + 5_001);
  assert.equal(h.claim('c', plan.id, 1).one('c', 'task.claim-rejected').reason, 'fingerprint-mismatch', 'Fingerprint mismatch');
  assert.equal(h.claim('b', plan.id, 1).one('b', 'task.claimed').id, plan.id, 'Another pc can claim after the window');

  const { h: h2, plan: plan2 } = planScene({ PLAN_PREFER_MS: 100 });
  h2.clock.advance(101);
  assert.equal(h2.claim('b', plan2.id, 1).one('b', 'task.claimed').id, plan2.id, 'The overridden window');
  // 过滤开时，带 preferNode 的 plan 对指纹不符的节点也看不见（和细任务同一处前置过滤）
  const { h: h3 } = planScene();
  const snapC = h3.watch('c', 'all').one('c', 'queue.snapshot');
  assert.equal(snapC.tasks.length, 0);
});

test('X4-4 host and browser claims of the plan always return plan-profile (both inside and outside the window), 0 claims; node-side rule 6 skips them anyway', () => {
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

test('X4-5 session end to end: when the publisher node is busy, another pc gets preferred within the window and its candidate is set aside until after the window before claiming; when the publisher is idle it claims within the window itself', async () => {
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
      assert.equal(winner, b, 'Publisher busy: another pc claims after the window');
      assert.ok(claimedAt - publishedAt > QUEUE_DEFAULTS.PLAN_PREFER_MS, `Claimed only after the window (${claimedAt - publishedAt} ms)`);
      assert.ok(preferred.length >= 1 && preferred.length <= 2, `Got preferred only once or twice within the window (candidate set aside, not hitting it on every tick): ${preferred.length}`);
    } else {
      assert.equal(winner, a, 'Publisher idle: it claims within the window itself');
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

test('X5-1 idle gate: no claiming if there was an interactive frame request in the last 500 ms, claiming only after a full 500 ms; playback, yielding, a dragged playhead and playing all count as busy', () => {
  let now = 50_000;
  const pipeline = fakePipeline();
  let outside = -Infinity;
  const gate = createQueueIdleGate({ pipeline, now: () => now, lastInteractionAt: () => outside });
  assert.equal(INTERACTION_QUIET_MS, 500);
  assert.equal(gate.idle(), true, 'Quiet: can claim');
  gate.note();
  now += 499;
  assert.equal(gate.reason(), 'interaction');
  now += 1;
  assert.equal(gate.idle(), true, 'A full 500 ms');
  outside = now - 100;   // 路由记下的交互（/see user、/playback）
  assert.equal(gate.idle(), false);
  outside = -Infinity;

  const at = now;
  assert.equal(interactionReason({ ...pipeline, playback: { playing: true } }, at), 'playback');
  assert.equal(interactionReason({ ...pipeline, backgroundYielding: true }, at), 'yield');
  assert.equal(interactionReason({ ...pipeline, backgroundLeaseUntil: at + 1 }, at), 'yield');
  assert.equal(interactionReason({ ...pipeline, playhead: () => ({ at: at - 300, playing: false }) }, at), 'scrub');
  assert.equal(interactionReason({ ...pipeline, playhead: () => ({ at: at - 600, playing: false }) }, at), null, '600 ms after the drag stopped');
  assert.equal(interactionReason({ ...pipeline, playhead: () => ({ at: at - 3_000, playing: true }) }, at), 'playing');
  assert.equal(interactionReason({ ...pipeline, playhead: () => ({ at: at - 6_000, playing: true }) }, at), null, 'Playing but no update for 5 seconds');
  assert.equal(interactionReason({ ...pipeline, playhead: () => { throw new Error('x'); } }, at), null);
  assert.equal(interactionReason({ ...pipeline, closed: true }, at), 'closed');
});

test('X5-2 the gate lets claims through when preload is not ready (M5b\'s executor isIdle did not let them through at this point; isIdle was removed during integration)', () => {
  const pipeline = fakePipeline();
  assert.equal(createQueueIdleGate({ pipeline }).idle(), true, 'X5: can claim even when preload is not ready');
  // 流在忙同样不挡（执行器有空位由会话守）
  const busyStreams = fakePipeline({ _streams: { workers: new Set([1]), encoding: new Set() } });
  assert.equal(createQueueIdleGate({ pipeline: busyStreams }).idle(), true);
});

test('X5-3 during a simulated drag there are 0 new claims and the task in hand is finished (not released); claiming resumes after stopping for a full 500 ms', async t => {
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
  assert.equal(holding.length, 1, 'One task is in hand before the drag');
  const claimsBefore = rig.sent(n.connId, 'task.claim').length;

  // 拖动 3 秒：每 100 ms 一次交互帧请求
  dragging = true;
  for (let i = 0; i < 30; i++) { if (dragging) gate.note(); await rig.step(100); }
  dragging = false;
  const claimsDuring = rig.sent(n.connId, 'task.claim').length - claimsBefore;
  t.diagnostic(`${claimsDuring} new claims during the 3 s drag; the task in hand before the drag, ${holding[0]}, has state ${rig.task(holding[0])?.state}`);
  assert.equal(claimsDuring, 0, '0 new claims during the drag');
  assert.equal(rig.sent(n.connId, 'task.release').length, 0, 'The task in hand is not released');
  assert.equal(rig.task(holding[0]).state, 'done', 'The task in hand is finished');

  // 停手：400 ms 内仍不认领，满 500 ms 之后恢复
  await rig.step(100); await rig.step(100); await rig.step(100);
  assert.equal(rig.sent(n.connId, 'task.claim').length - claimsBefore, 0, 'Still no claiming less than 500 ms after stopping');
  for (let i = 0; i < 5; i++) await rig.step(100);
  assert.ok(rig.sent(n.connId, 'task.claim').length - claimsBefore >= 1, 'Claiming resumes after stopping for a full 500 ms');
  rig.hygiene();
  n.local.stop();
});
