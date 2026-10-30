/**
 * M6c 契约（`docs/plan/m6c-contract.md`）X1～X4 能在单进程里验的部分。X1 的执行器烟测与 X5 在 `m6c-executor.test.mjs`。
 * 跑：node --experimental-test-module-mocks --test server/test/m6c-contract.test.mjs
 *
 * 只照契约写，不看实现。契约没写死的接口名集中在 `m6c-kit.mjs`（〔假设 A-…〕），主会话集成时对账。
 * 实现不在测试分支上：新行为的用例在这里失败是预期的。
 *
 *   MC-X1-*  流任务的能力闸：`requires.capabilities.streams = true`，`streams: false` 的节点 0 次认领；
 *            切分出的流任务带这一项；流任务以 StreamResult 报完成、每个任务恰好一次 task.done
 *   MC-X2-*  本地档素材闸 `requires.localMedia`：别的节点认领 0、收到 task.opened 0；发布方节点能认领、全部完成
 *   MC-X3-*  `watch: 'all'`：browser → forbidden；host 只收摘要（单任务增量 0 条，每周期 ≤ 1 条、每项目 ≤ 1 项）；pc 照旧
 *   MC-X4-*  plan 就近认领：窗口内别的 pc 被拒、窗口后能认领、host 与 browser 始终 0 次
 *
 * 队列只经 A.3 的公开接口（connect / handle / tick / describe）驱动；节点会话只经 B.5 的公开接口驱动；
 * 会话与队列之间用 D.3 的环回传输（`fake-loopback-transport.mjs`），假时钟，不起网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue, QUEUE_DEFAULTS } from '../render-queue/index.mjs';
import { createNodeSession } from '../render-node/session.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { checkClaimable } from '../render-node/filter.mjs';
import { splitPlan, planTaskOf } from '../render-node/split.mjs';
import { createQueueHarness, createFakeClock, T0 } from './fake-render-queue-env.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import {
  FP, streamTask, snapTask, planTask, planTaskViaSplit, PLAN_PREFER_MS_DEFAULT, nodeDescriptor,
  createDocQueueRig, countBy,
} from './m6c-kit.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));

/* ================================================================== 进程内拓扑：真队列 + 环回 + 会话 / 本机节点 */

function createTopology({ constants } = {}) {
  const clock = createFakeClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, ...(constants ? { constants } : {}) });
  lb.attach(queue);
  /** nodeId → 这个节点发出的 task.claim 的 id */
  const claims = new Map();
  /** nodeId → 这个节点收到的（task.opened 或 queue.snapshot 里的）任务 id */
  const seen = new Map();
  /** nodeId → 收到的 task.claimed 的 id */
  const claimed = new Map();
  const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
  const taps = (nodeId, message) => {
    if (message?.type === 'task.opened' && message.task?.id) push(seen, nodeId, message.task.id);
    if (message?.type === 'queue.snapshot') for (const t of message.tasks ?? []) push(seen, nodeId, t.id);
    if (message?.type === 'task.claimed') push(claimed, nodeId, message.id);
  };
  const sessions = [];
  const locals = [];

  const topo = {
    clock, lb, queue, claims, seen, claimed,
    /** 纯会话节点：认领到的任务只拿着（不干活） */
    session(connId, nodeId, node, { projects = 'all', maxConcurrent = 8, isIdle } = {}) {
      const ep = lb.connect(connId, { userId: node.userId ?? 'u1', tenantId: 't1' });
      const s = createNodeSession({
        nodeId, node, now: clock.now, random: () => 0.5, maxConcurrent, projects,
        ...(isIdle ? { isIdle } : {}),
        send: (m) => { if (m?.type === 'task.claim') push(claims, nodeId, m.id); ep.send(m); },
      });
      ep.onMessage((m) => { taps(nodeId, m); s.receive(m); });
      s.start();
      lb.flush();
      sessions.push(s);
      return s;
    },
    /** 本机节点：假执行器、假产物库，`put` 回 `result` 给的清单 */
    local(connId, nodeId, node, { resultOf = () => ({}), maxConcurrent = 1, isIdle } = {}) {
      const ep = lb.connect(connId, { userId: node.userId ?? 'u1', tenantId: 't1' });
      const endpoint = {
        send: (m) => { if (m?.type === 'task.claim') push(claims, nodeId, m.id); ep.send(m); },
        onMessage: (h) => ep.onMessage((m) => { taps(nodeId, m); h(m); }),
      };
      const executor = { plan: async () => { throw new Error('这里不切分'); }, render: async () => null };
      const sink = {
        has: async () => false,
        put: async (entry) => ({ complete: true, result: resultOf(entry) }),
      };
      const local = createLocalNode({
        nodeId, node, endpoint, now: clock.now, random: () => 0.5, maxConcurrent, executor, sink,
        ...(isIdle ? { isIdle } : {}),
      });
      local.start();
      lb.flush();
      locals.push(local);
      return local;
    },
    /** 页面发布方：收它的 task.done */
    page(connId = 'conn-page', publisherId = 'page-1', userId = 'u1') {
      const ep = lb.connect(connId, { userId, tenantId: 't1' });
      const inbox = [];
      ep.onMessage((m) => inbox.push(m));
      ep.send({ type: 'publisher.hello', publisherId });
      lb.flush();
      return {
        inbox,
        publish(tasks) { ep.send({ type: 'task.publish', tasks }); lb.flush(); },
        done: () => inbox.filter(m => m.type === 'task.done'),
      };
    },
    /** 推进 `steps` 拍：每拍 tick 队列、会话、本机节点，投递，等异步执行落定 */
    async run(steps = 40, stepMs = 250) {
      for (let i = 0; i < steps; i += 1) {
        clock.advance(stepMs);
        queue.tick();
        for (const s of sessions) s.tick();
        for (const l of locals) l.tick();
        lb.flush();
        await settle();
        lb.flush();
      }
    },
    count: (map, nodeId, pred = () => true) => (map.get(nodeId) ?? []).filter(pred).length,
  };
  return topo;
}

/* ================================================================== X1 轨道流走队列 */

test('MC-X1-filter：流任务要 capabilities.streams，streams:false 的节点过滤掉、streams:true 的放行', () => {
  const task = { ...streamTask(), source: { projectId: 'p1', projectRev: 1, userId: 'u1' } };
  assert.equal(task.requires.capabilities.streams, true, '夹具：流任务带 requires.capabilities.streams = true');
  const no = checkClaimable(task, nodeDescriptor({ nodeId: 'n-no', capabilities: { transcode: true, streams: false } }));
  assert.equal(no.ok, false, `streams:false（即使有 transcode）不该能认领流任务：${JSON.stringify(no)}`);
  // 集成对账（B 类，按主会话裁定 X1 改）：「没有 streams 字段的节点回落 transcode」（m6c-contract「集成时的裁定」）。
  // 契约 X1 原文只说「节点侧过滤照此执行」，没说没报 streams 的旧节点怎么算；原断言按「不收」写，与裁定不符。
  const missing = checkClaimable(task, nodeDescriptor({ nodeId: 'n-missing', capabilities: { transcode: true } }));
  assert.equal(missing.ok, true, `没报 streams、有 transcode 的节点按 transcode 算，能认领：${JSON.stringify(missing)}`);
  const missingNoTranscode = checkClaimable(task, nodeDescriptor({ nodeId: 'n-missing-2', capabilities: { transcode: false } }));
  assert.equal(missingNoTranscode.ok, false, `没报 streams、也没有 transcode 的节点不能认领：${JSON.stringify(missingNoTranscode)}`);
  const yes = checkClaimable(task, nodeDescriptor({ nodeId: 'n-yes', capabilities: { transcode: true, streams: true } }));
  assert.equal(yes.ok, true, `streams:true 的节点应能认领：${JSON.stringify(yes)}`);
});

test('MC-X1-filter-snapshot：快照任务不受 streams 影响', () => {
  const task = { ...snapTask(), source: { projectId: 'p1', projectRev: 1, userId: 'u1' } };
  const r = checkClaimable(task, nodeDescriptor({ nodeId: 'n', capabilities: { streams: false } }));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('MC-X1-split：切分出的流任务 requires.capabilities.streams === true，快照任务不要求', () => {
  const planT = planTaskOf({ projectId: 'p1', projectRev: 1 });
  const out = splitPlan({
    planTask: planT, entryKey: 'e1', envFingerprint: FP, codeVersion: 'cv1',
    cardPlan: [{ clipId: 'c1', cardId: 'demo', snapshotKey: 'sk1', contentKey: 'ck1', tier: 'shared', count: 60, capabilities: {} }],
    streams: [{ streamKey: 'st1', contentKey: 'sck1', topClipId: 'c1', firstSegment: 0, lastSegment: 15 }],
  });
  const streams = out.filter(t => t.kind === 'stream');
  const snaps = out.filter(t => t.kind === 'snapshot');
  assert.equal(streams.length, 2, `16 个分段按 8 段一切应是 2 个流任务：${JSON.stringify(out.map(t => t.id))}`);
  for (const t of streams) assert.equal(t.requires?.capabilities?.streams, true, `${t.id} 的 requires：${JSON.stringify(t.requires)}`);
  assert.ok(snaps.length > 0);
  for (const t of snaps) assert.notEqual(t.requires?.capabilities?.streams, true, `快照任务不应要求 streams：${JSON.stringify(t.requires)}`);
});

test('MC-X1-queue-claims：真队列上 streams:false 的节点对流任务 0 次认领，streams:true 的节点全部认领', async () => {
  const topo = createTopology();
  topo.session('conn-no', 'node-no', nodeDescriptor({ nodeId: 'node-no', capabilities: { transcode: true, streams: false } }));
  const page = topo.page();
  const tasks = [0, 1, 2, 3].map(seg => streamTask({ seg }));
  page.publish(tasks);
  await topo.run(20);
  assert.equal(topo.count(topo.claims, 'node-no'), 0, `streams:false 节点的认领：${JSON.stringify(topo.claims.get('node-no'))}`);
  topo.session('conn-yes', 'node-yes', nodeDescriptor({ nodeId: 'node-yes', capabilities: { transcode: true, streams: true } }));
  await topo.run(40);
  assert.equal(topo.count(topo.claims, 'node-no'), 0);
  assert.deepEqual([...new Set(topo.claimed.get('node-yes') ?? [])].sort(), tasks.map(t => t.id).sort(), 'streams:true 节点认领到全部流任务');
});

test('MC-X1-hello：会话把 capabilities.streams 原样报进 node.hello', () => {
  const sent = [];
  const s = createNodeSession({
    nodeId: 'n1', node: nodeDescriptor({ nodeId: 'n1', capabilities: { streams: false } }),
    send: m => sent.push(m), now: () => 1,
  });
  s.start();
  const hello = sent.find(m => m.type === 'node.hello');
  assert.equal(hello?.capabilities?.streams, false, JSON.stringify(hello));
});

test('MC-X1-done：流任务经队列完成，task.complete 的 result 是 StreamResult，页面每个任务恰好一次 task.done', async () => {
  const topo = createTopology();
  // 〔假设 A-X1-2〕StreamResult 经 sink.put 的 result 进 task.complete
  const resultOf = (entry) => ({
    v: 1, kind: 'stream', resultKey: entry.resultKey, range: { from: entry.range.from, to: entry.range.to },
    header: { kind: 'bg', plane: 0, clipIds: ['clip-bg'], fps: 30, bound: null, offset: 0, tight: null },
    inits: { i0: { hash: 'h-init', bytes: 10, codec: 'avc1', width: 16, height: 16, timescale: 30, rect: null, encoder: 'libx264' } },
    segments: Object.fromEntries(Array.from({ length: entry.range.to - entry.range.from + 1 }, (_, i) => [
      String(entry.range.from + i),
      { hash: `h-${entry.range.from + i}`, bytes: 100, init: 'i0', stride: 1, samples: 15, sig: 's', encoder: 'libx264' },
    ])),
  });
  topo.local('conn-pc', 'node-pc', nodeDescriptor({ nodeId: 'node-pc', capabilities: { transcode: true, streams: true } }), { resultOf });
  const page = topo.page();
  const tasks = [0, 1, 2].map(seg => streamTask({ seg }));
  page.publish(tasks);
  await topo.run(60);
  const done = page.done();
  const perId = countBy(done.map(m => m.id));
  for (const t of tasks) {
    assert.equal(perId.get(t.id), 1, `${t.id} 的 task.done 次数：${perId.get(t.id) ?? 0}`);
    const r = done.find(m => m.id === t.id).result;
    assert.equal(r?.kind, 'stream', JSON.stringify(r));
    assert.equal(r?.v, 1);
    assert.equal(r?.resultKey, t.resultKey);
    assert.deepEqual([r?.range?.from, r?.range?.to], [t.range.from, t.range.to], '范围是分段号，与任务一致');
    for (const n of Object.keys(r?.segments ?? {})) {
      assert.ok(Number(n) >= t.range.from && Number(n) <= t.range.to, `分段 ${n} 落在任务范围内`);
    }
  }
});

/* ================================================================== X2 本地档素材闸 */

test('MC-X2-queue：带 localMedia 的任务，别的节点收到 task.opened 0 条、认领被拒；发布方节点能认领', () => {
  const h = createQueueHarness(createRenderQueue);
  h.node('conn-a', 'node-A', { hello: { envFingerprint: FP } });
  h.node('conn-b', 'node-B', { hello: { envFingerprint: FP } });
  h.publisher('conn-p', 'node-A');
  const local = snapTask({ key: 'rk-local', localMedia: 'node-A' });
  const shared = snapTask({ key: 'rk-plain' });
  const step = h.publish('conn-p', [local, shared]);
  const openedB = step.of('conn-b', 'task.opened').map(m => m.task.id);
  assert.ok(!openedB.includes(local.id), `node-B 不该收到 localMedia 任务的 task.opened：${JSON.stringify(openedB)}`);
  assert.ok(openedB.includes(shared.id), '没有 localMedia 的任务照常发给 node-B');
  assert.ok(step.of('conn-a', 'task.opened').some(m => m.task.id === local.id), 'node-A 收到 localMedia 任务');

  // 晚来的 watch 同样看不到
  const late = h.node('conn-c', 'node-C', { hello: { envFingerprint: FP } });
  const snapC = late.of('conn-c', 'queue.snapshot')[0]?.tasks.map(t => t.id) ?? [];
  assert.ok(!snapC.includes(local.id), `queue.snapshot 不该含 localMedia 任务：${JSON.stringify(snapC)}`);

  const rejB = h.claim('conn-b', local.id, 1);
  assert.equal(rejB.of('conn-b', 'task.claimed').length, 0, `node-B 认领应被拒：${JSON.stringify(rejB.messages())}`);
  assert.equal(rejB.of('conn-b', 'task.claim-rejected').length, 1);
  assert.equal(h.task(local.id).state, 'open');

  const okA = h.claim('conn-a', local.id, h.task(local.id).version);
  assert.equal(okA.of('conn-a', 'task.claimed').length, 1, `node-A 应能认领：${JSON.stringify(okA.messages())}`);
});

test('MC-X2-node：节点侧过滤跳过别人的 localMedia 任务（即使队列发过来了）', () => {
  const task = { ...snapTask({ localMedia: 'node-A' }), source: { projectId: 'p1', projectRev: 1, userId: 'u1' }, state: 'open', version: 1, attempts: 0 };
  // 会话层：直接喂 queue.snapshot，看它发不发认领
  const run = (nodeId) => {
    const sent = [];
    const s = createNodeSession({ nodeId, node: nodeDescriptor({ nodeId }), send: m => sent.push(m), now: () => 1, random: () => 0.5 });
    s.start();
    s.receive({ type: 'node.welcome', nodeId, resumed: [], lost: [] });
    s.receive({ type: 'queue.snapshot', tasks: [task] });
    s.tick();
    return sent.filter(m => m.type === 'task.claim').map(m => m.id);
  };
  assert.deepEqual(run('node-B'), [], 'node-B 的会话不认领');
  assert.deepEqual(run('node-A'), [task.id], 'node-A 的会话认领');
  // 纯函数层〔假设 A-X2-1〕
  assert.equal(checkClaimable(task, nodeDescriptor({ nodeId: 'node-B' })).ok, false);
  assert.equal(checkClaimable(task, nodeDescriptor({ nodeId: 'node-A' })).ok, true);
});

test('MC-X2-e2e：含本地档素材的项目，别的节点认领 0、收到 0 条；发布方节点把它们全部完成', async () => {
  const topo = createTopology();
  topo.local('conn-a', 'node-A', nodeDescriptor({ nodeId: 'node-A' }));
  topo.local('conn-b', 'node-B', nodeDescriptor({ nodeId: 'node-B' }), { maxConcurrent: 4 });
  const page = topo.page('conn-p', 'node-A');
  const tasks = [0, 1, 2, 3, 4].map(seg => snapTask({ seg, key: 'rk-lm', localMedia: 'node-A' }));
  page.publish(tasks);
  await topo.run(80);
  const ids = new Set(tasks.map(t => t.id));
  assert.equal(topo.count(topo.claims, 'node-B', id => ids.has(id)), 0, `node-B 的认领：${JSON.stringify(topo.claims.get('node-B'))}`);
  assert.equal(topo.count(topo.seen, 'node-B', id => ids.has(id)), 0, `node-B 收到的：${JSON.stringify(topo.seen.get('node-B'))}`);
  const doneIds = new Set(page.done().map(m => m.id));
  for (const t of tasks) assert.ok(doneIds.has(t.id), `${t.id} 应完成`);
  const byA = new Set(topo.claimed.get('node-A') ?? []);
  for (const t of tasks) assert.ok(byA.has(t.id), `${t.id} 应由 node-A 认领`);
});

/* ================================================================== X3 watch: 'all' 收紧 */

test('MC-X3-browser：browser 节点 watch all 回 forbidden，watch 指定项目照常', () => {
  const rig = createDocQueueRig();
  rig.node('conn-w', 'node-W', { profile: 'browser' });
  rig.clear('conn-w');
  rig.send('conn-w', { type: 'queue.watch', projects: 'all', reqId: 'w1' });
  const reply = rig.inbox('conn-w').find(m => m.reqId === 'w1');
  // 〔假设 A-X3-3〕
  assert.equal(reply?.type, 'error', JSON.stringify(rig.inbox('conn-w')));
  assert.equal(reply?.reason, 'forbidden');
  rig.send('conn-w', { type: 'queue.watch', projects: ['p1'], reqId: 'w2' });
  assert.equal(rig.inbox('conn-w').find(m => m.reqId === 'w2')?.type, 'queue.snapshot', '指定项目的 watch 不受影响');
});

test('MC-X3-host：host watch all 单任务增量 0 条，摘要每周期至多 1 条、每项目至多 1 项；pc 照旧收全量', () => {
  const rig = createDocQueueRig();
  rig.node('conn-h', 'node-H', { profile: 'host', watch: 'all' });
  rig.node('conn-pc', 'node-PC', { profile: 'pc', watch: 'all' });
  rig.publisher('conn-p', 'pub-1');
  const TASK_TYPES = ['task.opened', 'task.taken', 'task.closed', 'queue.snapshot'];
  const perTick = [];
  let seq = 0;
  for (let round = 0; round < 6; round += 1) {
    // 三个项目各发一批，pc 认领并完成其中一个：产生 opened / taken / closed
    const batch = ['p1', 'p2', 'p3'].map(projectId => snapTask({ projectId, key: `rk-${projectId}-${round}`, seg: seq++ }));
    rig.publish('conn-p', batch);
    const target = batch[0];
    rig.send('conn-pc', { type: 'task.claim', id: target.id, expectVersion: 1 });
    const claimed = rig.of('conn-pc', 'task.claimed').find(m => m.id === target.id);
    if (claimed) rig.send('conn-pc', { type: 'task.complete', id: target.id, token: claimed.token, result: { ranges: [[target.range.from, target.range.to]] } });
    const before = rig.of('conn-h', 'queue.summary').length;
    rig.advance(QUEUE_DEFAULTS.SWEEP_INTERVAL_MS);
    rig.tick();
    perTick.push(rig.of('conn-h', 'queue.summary').length - before);
  }
  const increments = rig.inbox('conn-h').filter(m => TASK_TYPES.includes(m.type) && !(m.type === 'queue.snapshot' && (m.tasks ?? []).length === 0));
  assert.equal(increments.length, 0, `host 不该收单任务增量：${JSON.stringify(increments.map(m => m.type))}`);
  const summaries = rig.of('conn-h', 'queue.summary');
  // 〔假设 A-X3-2〕
  assert.ok(summaries.length >= 1, `host watch all 应收到摘要；收件箱：${JSON.stringify(rig.inbox('conn-h').map(m => m.type))}`);
  for (const [i, n] of perTick.entries()) assert.ok(n <= 1, `第 ${i} 个周期收到 ${n} 条摘要`);
  for (const s of summaries) {
    const ids = (s.projects ?? []).map(p => p.projectId);
    assert.equal(new Set(ids).size, ids.length, `一条摘要里每项目至多 1 项：${JSON.stringify(ids)}`);
  }
  // pc 保持现状
  assert.ok(rig.of('conn-pc', 'task.opened').length >= 18, `pc 应收全量 task.opened：${rig.of('conn-pc', 'task.opened').length}`);
});

test('MC-X3-pc：pc 节点 watch all 照常回 queue.snapshot', () => {
  const rig = createDocQueueRig();
  rig.publisher('conn-p', 'pub-1');
  rig.publish('conn-p', [snapTask({ key: 'rk-x' })]);
  rig.node('conn-pc', 'node-PC', { profile: 'pc', watch: 'all' });
  const snap = rig.of('conn-pc', 'queue.snapshot')[0];
  assert.ok(snap, JSON.stringify(rig.inbox('conn-pc')));
  assert.equal(snap.tasks.length, 1);
});

/* ================================================================== X4 plan 就近认领 */

test('MC-X4-const：PLAN_PREFER_MS 在 constants.mjs 里，缺省 5000', () => {
  assert.equal(PLAN_PREFER_MS_DEFAULT(), 5000);
});

test('MC-X4-planTaskOf：发布方造 plan 时 requires.preferNode 是自己的 nodeId', () => {
  const t = planTaskViaSplit(planTaskOf, { projectId: 'p1', projectRev: 2, preferNode: 'node-A' });
  assert.equal(t.requires?.preferNode, 'node-A', JSON.stringify(t.requires));
  assert.equal(t.id, 'plan:p1@2', 'id 不随 preferNode 变');
});

function planHarness() {
  const h = createQueueHarness(createRenderQueue);
  h.node('conn-a', 'node-A', { profile: 'pc' });
  h.node('conn-b', 'node-B', { profile: 'pc' });
  h.node('conn-h', 'node-H', { profile: 'host' });
  h.node('conn-w', 'node-W', { profile: 'browser', watch: ['p1'] });
  h.publisher('conn-p', 'node-A');
  const plan = planTask({ projectId: 'p1', projectRev: 1, preferNode: 'node-A' });
  h.publish('conn-p', [plan]);
  return { h, plan };
}
const claimedBy = (step, connId) => step.of(connId, 'task.claimed').length;

test('MC-X4-window：窗口内别的 pc 认领 plan 被拒，任务仍 open', () => {
  const { h, plan } = planHarness();
  h.advance(1000);
  const step = h.claim('conn-b', plan.id, 1);
  assert.equal(claimedBy(step, 'conn-b'), 0, `窗口内 node-B 不该认领到：${JSON.stringify(step.messages())}`);
  assert.equal(step.of('conn-b', 'task.claim-rejected').length, 1);
  assert.equal(h.task(plan.id).state, 'open');
});

test('MC-X4-prefer：窗口内 preferNode 自己能认领', () => {
  const { h, plan } = planHarness();
  h.advance(1000);
  const step = h.claim('conn-a', plan.id, 1);
  assert.equal(claimedBy(step, 'conn-a'), 1, JSON.stringify(step.messages()));
});

test('MC-X4-after：窗口过后别的 pc 能认领', () => {
  const { h, plan } = planHarness();
  h.advance(5000 + 1);
  const version = h.task(plan.id).version;
  const step = h.claim('conn-b', plan.id, version);
  assert.equal(claimedBy(step, 'conn-b'), 1, `窗口过后 node-B 应能认领：${JSON.stringify(step.messages())}`);
});

test('MC-X4-host-browser：host 与 browser 窗口内外认领 plan 都被拒', () => {
  const { h, plan } = planHarness();
  for (const at of [1000, 6000, 60_000]) {
    h.at(T0 + at);
    const version = h.task(plan.id).version;
    for (const connId of ['conn-h', 'conn-w']) {
      const step = h.claim(connId, plan.id, version);
      assert.equal(claimedBy(step, connId), 0, `t+${at} ${connId} 不该认领 plan：${JSON.stringify(step.messages())}`);
    }
    assert.equal(h.task(plan.id).state, 'open');
  }
});

test('MC-X4-sessions：会话跑满 20 秒，host 与 browser 认领 plan 0 次；窗口内只有 preferNode 认领', async () => {
  const topo = createTopology();
  topo.session('conn-h', 'node-H', nodeDescriptor({ nodeId: 'node-H', profile: 'host' }));
  topo.session('conn-w', 'node-W', nodeDescriptor({ nodeId: 'node-W', profile: 'browser' }), { projects: ['p1'] });
  topo.session('conn-b', 'node-B', nodeDescriptor({ nodeId: 'node-B', profile: 'pc' }));
  const page = topo.page('conn-p', 'node-A');
  const plan = planTask({ projectId: 'p1', projectRev: 1, preferNode: 'node-A' });
  page.publish([plan]);
  await topo.run(16, 250);   // 4 秒，窗口内
  assert.equal(topo.count(topo.claimed, 'node-B', id => id === plan.id), 0, '窗口内 node-B 认领不到');
  await topo.run(64, 250);   // 再 16 秒
  assert.equal(topo.count(topo.claimed, 'node-H', id => id === plan.id), 0, 'host 认领 plan 0 次');
  assert.equal(topo.count(topo.claimed, 'node-W', id => id === plan.id), 0, 'browser 认领 plan 0 次');
  assert.equal(topo.count(topo.claimed, 'node-B', id => id === plan.id), 1, '窗口过后 node-B 认领到');
});
