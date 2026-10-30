/**
 * 活着、在干活的节点不该被判停滞(`docs/archive/agent-reports/AGENT-stall-phases.md`;契约 `docs/plan/render-queue-contract.md` A.12〔裁〕)。
 * 跑:npm test,或 node --test server/test/stall-phases.test.mjs
 *
 * M8 的 C1(放云端)里,连接活着、续约照发的两台独立渲染主机各丢了 6、7 次认领,一个任务满 3 次尝试永久失败。
 * 队列的停滞规则(A.8 第 2 项)只看帧数 `done`:节点在「排队等预渲染间」「推产物」这些帧数不变的阶段超过 STALL_MS,
 * 就被当成卡死收回。这里用真队列 + 真节点编排(`createLocalNode` / `createRenderHost`)+ 真执行器(`prerender-executor.mjs`,
 * 管线换成按假时钟走、只有一条串行 lane 的替身)+ 按假时钟推块的产物库,复现并验证:
 *
 *   S1  推产物超过 STALL_MS(60 块、每块 10 s、并发 4 ≈ 150 s):改前按停滞收回、满 3 次永久失败;改后推送中每推完一块
 *       算进度(`task.progress.step`),一次完成、没有 lease-lost
 *   S2  主机 maxConcurrent 2、一条串行 lane:第二段排在第一段后面(第一段 135 s),改前排队中被判停滞;
 *       改后主机只在 lane 空出来时认领快照(闲时认领),两段都一次完成
 *   S3  S2 的主机:前一段推产物时,下一段照样认领、渲染(推送与渲染重叠)
 *   S4  卡死仍被收回(I8 的延伸):产物库的 put 永不报进度、永不返回 → STALL_MS 后按 stalled 收回
 *   S5  新节点对旧队列(丢掉 step 字段)照旧工作
 *   Q1  队列:step 变了重起停滞计时;step 不变(只有续约)照旧按停滞收回;不带 step 的旧节点行为不变;step 不是数回 bad-message
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createRenderQueue } from '../render-queue/index.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { createRenderHost } from '../render-node/host.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { createPrerenderExecutor } from '../prerender-executor.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { createTimerClock } from './fake-render-executor.mjs';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const FP = 'fedcba9876543210';
const CV = 'c0de-stall';
const STEP_MS = 500;
const STALL_MS = 120_000;

/* ------------------------------------------------------------------ 夹具 */

const CONTENT_KEY = sha256('ck:title');
const RESULT_KEY = resultKeyOf(CONTENT_KEY, FP);

function fineTask(from, to, { projectId = 'proj-a' } = {}) {
  return {
    id: `snapshot:${RESULT_KEY}:${from}-${to}`, kind: 'snapshot', tier: 'shared', resultKey: RESULT_KEY,
    range: { unit: 'localFrame', from, to },
    source: { projectId, projectRev: 1 },
    input: { clipId: 'clip-title', cardId: 'title', entryKey: null, contentKey: CONTENT_KEY },
    weight: { class: 'heavy', estMs: null, frames: to - from + 1 },
    requires: { envFingerprint: FP, codeVersion: CV, cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false },
    priority: 10,
  };
}

/**
 * 管线替身:只有 `'queue'` 那一条串行 lane(同 `FramePipeline.runQueueTask`:等前一个 → 干活 → 还),每 4 帧一批、
 * 每批 `batchMs`(假时钟),每批报一次进度。`laneLog` 记每段进 lane / 出 lane 的时刻。
 */
function fakePipeline(clock, { batchMs }) {
  let chain = Promise.resolve();
  const laneLog = [];
  const control = {
    clipId: 'clip-title', tier: 'shared', snapshotKey: RESULT_KEY, contentKey: CONTENT_KEY, count: 300, cacheable: true,
    capabilities: { frameMode: 'stateful', compositing: 'independent' },
  };
  return {
    laneLog,
    envFingerprint: FP,
    queueHandles: () => true,
    prerenderPicked: () => true,
    async planForQueue(project) {
      return { entry: { key: 'entry-1', project, cardPlan: [control] }, context: { entryKey: 'entry-1', cardPlan: [control] }, streamSpecs: [] };
    },
    renderCardSnapshotRange(entry, ctl, range, { signal, progress } = {}) {
      const work = chain.catch(() => {}).then(async () => {
        if (signal?.aborted) throw Object.assign(new Error('Queue task cancelled'), { cancelled: true });
        const rec = { range: `${range.from}-${range.to}`, in: clock.now(), out: null };
        laneLog.push(rec);
        try {
          let done = 0;
          for (let f = range.from; f <= range.to; f += 4) {
            await clock.sleep(batchMs, signal);
            done += Math.min(4, range.to - f + 1);
            progress?.(done);
          }
        } finally { rec.out = clock.now(); }
      });
      chain = work.catch(() => {});
      return work.then(() => null);
    },
  };
}

/**
 * 产物库替身:`has` 看自己收全过没有;`put` 按块推(每块 `blockMs`,并发 4,假时钟),每推完一块经 `report` 报一次。
 * `hang: true` 时 put 永不报进度、永不返回。`puts` 记每次推送的开始与结束。
 */
function fakeSink(clock, { blocks = 60, blockMs = 10_000, hang = false } = {}) {
  const stored = new Set();
  const puts = [];
  return {
    puts,
    async has(ref) { return stored.has(`${ref.resultKey}:${ref.range.from}-${ref.range.to}`); },
    async put(entry, { signal, report } = {}) {
      const rec = { id: entry.meta.taskId, nodeId: entry.meta.nodeId, start: clock.now(), end: null };
      puts.push(rec);
      if (hang) return new Promise(() => {});
      report?.({ stage: 'push' });
      let pushed = 0;
      report?.({ blocks, pushed, bytes: 0 });
      const lanes = Array.from({ length: 4 }, async (_, lane) => {
        for (let b = lane; b < blocks; b += 4) {
          await clock.sleep(blockMs, signal);
          pushed += 1;
          report?.({ blocks, pushed, bytes: pushed * 1000 });
        }
      });
      await Promise.all(lanes);
      rec.end = clock.now();
      stored.add(`${entry.resultKey}:${entry.range.from}-${entry.range.to}`);
      return { complete: true, result: { v: 1 } };
    },
  };
}

function projectsStub() {
  return { get: async () => ({ id: 'proj-a', tracks: [{ clips: [] }], duration: 10, fps: 30 }) };
}

/** 一个项目空间:队列 + 环回 + 页面发布方 */
function space(clock, { transformIn = null } = {}) {
  const lb = createLoopback();
  const queue = createRenderQueue({
    now: clock.now, send: lb.queueSend, epoch: 'epoch-stall',
  });
  // S5:模拟旧队列 —— 入站消息先丢掉它不认的字段再交给队列
  if (transformIn) lb.attach({ ...queue, handle: (connId, message) => queue.handle(connId, transformIn(message)) });
  else lb.attach(queue);
  const page = lb.connect('page', { userId: 'alice', tenantId: 'proj-a' });
  const inbox = [];
  page.onMessage((m) => inbox.push(m));
  page.send({ type: 'publisher.hello', publisherId: 'page-a' });
  const log = () => lb.log();
  return {
    lb, queue, inbox,
    publish: (tasks) => page.send({ type: 'task.publish', tasks }),
    doneCount: (id) => inbox.filter((m) => m.type === 'task.done' && m.id === id).length,
    failed: () => inbox.filter((m) => m.type === 'task.failed'),
    leaseLost: () => log().filter((e) => e.dir === 'out' && e.message.type === 'task.lease-lost').map((e) => e.message),
    claims: () => log().map((e, index) => ({ ...e, index })).filter((e) => e.dir === 'out' && e.message.type === 'task.claimed'),
    task: (id) => queue.describe().tasks.find((t) => t.id === id),
  };
}

async function settle(sp) {
  for (let round = 0; round < 1000; round++) {
    sp.lb.flush();
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
    if (sp.lb.pending() === 0) return;
  }
  throw new Error('消息往返不收敛');
}

/** 驱动:settle → 节点 tick → 队列 tick → 推进假时钟,直到 until() 或步数上限 */
async function drive(sp, clock, tick, until, maxSteps = 4000) {
  for (let i = 0; i < maxSteps; i++) {
    await settle(sp);
    tick();
    await settle(sp);
    sp.queue.tick();
    await settle(sp);
    if (until()) return clock.now();
    clock.advance(STEP_MS);
  }
  return null;
}

function pcNode(sp, clock, { executor, sink, nodeId = 'pc-1' }) {
  const ep = sp.lb.connect(`conn-${nodeId}`, { userId: 'alice', tenantId: 'proj-a' });
  const events = [];
  const local = createLocalNode({
    nodeId,
    node: { profile: 'pc', envFingerprint: FP, codeVersions: [CV], cardSourceVersions: {}, capabilities: { transcode: false, userCards: true, graphCards: false } },
    endpoint: ep, now: clock.now, random: () => 0, maxConcurrent: 1, codeVersion: CV, executor, sink,
    onEvent: (e) => events.push(e),
  });
  local.start();
  return { local, events };
}

/* ================================================================== S1 */

test('S1 推产物超过 STALL_MS(约 150 s):推送中每推完一块算进度,一次完成、没有 lease-lost', async () => {
  const clock = createTimerClock();
  const sp = space(clock);
  const pipeline = fakePipeline(clock, { batchMs: 1_000 });
  const executor = createPrerenderExecutor({ pipeline, projects: projectsStub() });
  const sink = fakeSink(clock, { blocks: 60, blockMs: 10_000 });
  const node = pcNode(sp, clock, { executor, sink });
  const task = fineTask(0, 59);
  sp.publish([task]);
  const endedAt = await drive(sp, clock, () => node.local.tick(), () => sp.doneCount(task.id) === 1 || sp.failed().length > 0);
  const view = sp.task(task.id);
  const lost = node.events.filter((e) => e.type === 'lost');
  assert.deepEqual(sp.leaseLost().map((m) => m.reason), [], `不该丢认领;节点的 lost 事件:${JSON.stringify(lost)}`);
  assert.ok(endedAt !== null, '应在步数上限内收尾');
  assert.equal(view.state, 'done', `应完成(实际 ${view.state},lastError ${view.lastError})`);
  assert.equal(view.attempts, 0, '一次完成');
  assert.equal(sink.puts.length, 1, '只推了一遍');
  assert.ok(sink.puts[0].end - sink.puts[0].start > STALL_MS, `推送本身就超过 STALL_MS(${sink.puts[0].end - sink.puts[0].start} ms)`);
  await node.local.stop();
});

/* ================================================================== S2 / S3 */

async function hostRun({ cap = 2, batchMs, push, tasks }) {
  const clock = createTimerClock();
  const sp = space(clock);
  const pipeline = fakePipeline(clock, { batchMs });
  const sink = fakeSink(clock, push);
  const events = [];
  const host = createRenderHost({
    entries: [{ projectId: 'proj-a', url: 'ws://unused.invalid/docservice' }],
    connect: () => ({
      endpoint: sp.lb.connect('host-0', { userId: 'renderbox', tenantId: 'proj-a' }),
      executor: createPrerenderExecutor({ pipeline, projects: projectsStub() }),
      sink,
    }),
    nodeIdOf: () => 'host:test/p0',
    envFingerprint: FP, codeVersion: CV, maxConcurrent: cap, now: clock.now, random: () => 0,
    onEvent: (e) => events.push({ ...e, at: clock.now() }),
  });
  host.start();
  sp.publish(tasks);
  const ids = tasks.map((t) => t.id);
  const endedAt = await drive(sp, clock, () => host.tick(), () => ids.every((id) => sp.doneCount(id) >= 1) || sp.failed().length > 0, 6000);
  host.shutdown('test-end');
  return { clock, sp, pipeline, sink, events, ids, endedAt };
}

test('S2 主机 maxConcurrent 2、一条串行 lane(每段 135 s):排队的那段不被判停滞,全部一次完成', async () => {
  const tasks = [fineTask(0, 59), fineTask(60, 119), fineTask(120, 179)];
  const { sp, pipeline, events, ids, endedAt } = await hostRun({ batchMs: 9_000, push: { blocks: 8, blockMs: 1_000 }, tasks });
  const lost = events.filter((e) => e.type === 'lost').map((e) => ({ id: e.id.slice(-8), reason: e.reason, phase: e.phase, detail: e.detail, sinceDoneMs: e.sinceDoneMs }));
  assert.deepEqual(sp.leaseLost().map((m) => m.reason), [], `不该丢认领;lost:${JSON.stringify(lost)}`);
  assert.ok(endedAt !== null, '应在步数上限内收尾');
  for (const id of ids) {
    const view = sp.task(id);
    assert.equal(view.state, 'done', `${id.slice(-8)}:${view.state} ${view.lastError}`);
    assert.equal(view.attempts, 0, `${id.slice(-8)} 一次完成`);
  }
  assert.equal(pipeline.laneLog.length, ids.length, '每段只渲一遍');
});

test('S3 主机:前一段推产物时,下一段照样认领、渲染(推送与渲染重叠)', async () => {
  const tasks = [fineTask(0, 59), fineTask(60, 119)];
  // 渲一段 15 s、推一段 60 s(8 块、每块 30 s、并发 4)
  const { sp, sink, pipeline, ids } = await hostRun({ batchMs: 1_000, push: { blocks: 8, blockMs: 30_000 }, tasks });
  for (const id of ids) assert.equal(sp.task(id).state, 'done');
  const first = sink.puts.find((p) => p.id === ids[0]) ?? sink.puts[0];
  const secondLane = pipeline.laneLog.find((r) => r.range !== first.id.split(':').at(-1));
  assert.ok(secondLane, '第二段进过 lane');
  assert.ok(secondLane.in < first.end, `第二段在第一段推完之前就开渲(进 lane ${secondLane.in},第一段推完 ${first.end})`);
});

/* ================================================================== S4 */

test('S4 卡死仍被收回:产物库 put 永不报进度、永不返回 → STALL_MS 后按 stalled 收回', async () => {
  const clock = createTimerClock();
  const sp = space(clock);
  const pipeline = fakePipeline(clock, { batchMs: 500 });
  const executor = createPrerenderExecutor({ pipeline, projects: projectsStub() });
  const sink = fakeSink(clock, { hang: true });
  const node = pcNode(sp, clock, { executor, sink });
  const task = fineTask(0, 59);
  sp.publish([task]);
  const t0 = clock.now();
  await drive(sp, clock, () => node.local.tick(), () => sp.leaseLost().length > 0, 1000);
  const lost = sp.leaseLost();
  assert.equal(lost.length, 1, '应被收回一次');
  assert.equal(lost[0].reason, 'stalled');
  const at = clock.now() - t0;
  assert.ok(at > STALL_MS && at < STALL_MS + 20_000, `STALL_MS 过后不久收回(实际 ${at} ms)`);
  const ev = node.events.find((e) => e.type === 'lost');
  assert.equal(ev.phase, 'push', '收回时在推送阶段');
  await node.local.stop();
});

/* ================================================================== S5 */

test('S5 新节点对旧队列(队列丢掉 step 字段):照旧完成,不报错', async () => {
  const clock = createTimerClock();
  // 旧队列只认 id / token / done:把 step 去掉
  const sp = space(clock, { transformIn: (m) => { if (m?.type !== 'task.progress') return m; const { step, ...rest } = m; return rest; } });
  const pipeline = fakePipeline(clock, { batchMs: 500 });
  const executor = createPrerenderExecutor({ pipeline, projects: projectsStub() });
  const sink = fakeSink(clock, { blocks: 8, blockMs: 1_000 });
  const node = pcNode(sp, clock, { executor, sink });
  const task = fineTask(0, 59);
  sp.publish([task]);
  await drive(sp, clock, () => node.local.tick(), () => sp.doneCount(task.id) === 1);
  assert.equal(sp.task(task.id).state, 'done', '推送快时照常完成');
  assert.deepEqual(sp.leaseLost(), []);
  await node.local.stop();
});

/* ================================================================== Q1 */

test('Q1 队列:step 变了重起停滞计时;续约不带新 step 照旧停滞;不带 step 的旧节点不变;step 不是数回 bad-message', () => {
  let t = 1_000_000;
  const sent = [];
  const q = createRenderQueue({ now: () => t, send: (connId, msg) => sent.push({ connId, msg }), epoch: 'q1' });
  q.connect('n', { userId: 'u', tenantId: 't' });
  q.connect('p', { userId: 'u', tenantId: 't' });
  q.handle('n', { type: 'node.hello', nodeId: 'N', profile: 'pc' });
  q.handle('p', { type: 'publisher.hello', publisherId: 'P' });
  const a = fineTask(0, 59);
  const b = fineTask(60, 119);
  q.handle('p', { type: 'task.publish', tasks: [a, b] });
  q.handle('n', { type: 'task.claim', id: a.id, expectVersion: 1 });
  q.handle('n', { type: 'task.claim', id: b.id, expectVersion: 1 });
  const at = (v) => { t = v; q.tick(); };
  const T0 = 1_000_000;
  // a:新节点,帧数停在 60,step 每 10 s 加一(在推块);b:旧节点,只续约不带 step
  q.handle('n', { type: 'task.progress', id: a.id, token: 2, done: 60, step: 1 });
  q.handle('n', { type: 'task.progress', id: b.id, token: 2, done: 60 });
  for (let s = 10; s <= 300; s += 10) {
    at(T0 + s * 1000);
    if (q.describe().tasks.find((x) => x.id === a.id).state === 'claimed') q.handle('n', { type: 'task.progress', id: a.id, token: 2, done: 60, step: 1 + s / 10 });
    if (q.describe().tasks.find((x) => x.id === b.id).state === 'claimed') q.handle('n', { type: 'task.progress', id: b.id, token: 2, done: 60 });
  }
  const view = (id) => q.describe().tasks.find((x) => x.id === id);
  assert.equal(view(a.id).state, 'claimed', 'step 一直在变:300 s 不收回');
  assert.equal(view(a.id).claim.progress.step, 31);
  assert.equal(view(b.id).state, 'open', '旧节点帧数不动:照旧按停滞收回');
  assert.equal(view(b.id).lastError, 'stalled');
  // a 之后只续约、step 不再变:STALL_MS 之后收回
  const since = t;
  for (let s = 10; s <= 130; s += 10) {
    at(since + s * 1000);
    if (view(a.id).state === 'claimed') q.handle('n', { type: 'task.progress', id: a.id, token: 2, done: 60, step: 31 });
  }
  assert.equal(view(a.id).state, 'open', 'step 不动就按停滞收回(卡死仍被收回)');
  assert.equal(view(a.id).lastError, 'stalled');
  // 格式
  sent.length = 0;
  q.handle('n', { type: 'task.progress', id: a.id, token: 2, done: 1, step: 'x', reqId: 'bad' });
  assert.equal(sent.at(-1).msg.type, 'error');
  assert.equal(sent.at(-1).msg.reason, 'bad-message');
});

