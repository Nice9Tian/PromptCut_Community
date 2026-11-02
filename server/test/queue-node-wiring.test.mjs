/**
 * 本机节点的接线（契约 `docs/plan/render-queue-contract.md` J.3，J.7 用例 J5～J7）。
 * 跑：node --experimental-test-module-mocks --test server/test/queue-node-wiring.test.mjs
 *
 * 只照契约写，不看实现。
 *
 *   J5  `local-node.mjs`：细任务的 sink `ref` 带 `input` 与 `requires`；走 `put` 完成时 `task.complete` 的
 *       `result` 是 `{ ranges, ...put 回的 result }`，走去重时是 `{ ranges, dedup: true, ...(await sink.resultFor?.(ref)) }`；
 *       sink 没有 `resultFor` 时照旧只有 `{ ranges, dedup: true }`（与 D.2 兼容）。
 *       拓扑照 M3 的进程内集成（`render-queue-inproc.test.mjs`）：真队列 + 环回传输 + 一个本机节点 + 一个页面发布方，
 *       页面直接发布细任务，收它的 `task.done`。先用记账的假 sink 测接口，再用 C6.2 的真 sink
 *       （`createAssetSink`，真帧库 + memory 素材服务 + 内容库）各走一遍 put 与去重。
 *   J6  `split.mjs`：快照任务 `input.canvasHeavy = control.capabilities?.canvasHeavy === true`；
 *       `planTaskOf` 接受 `{ codeVersion, envFingerprint }` 写进 `requires`。
 *   J7  `endpoint.mjs` 的 `resolveDocservice`：顺序是 环境变量地址 → 编辑器里挂的文档服务 → 回环 8787 → 离线；
 *       编辑器那一项从 `PROMPTCUT_EDITOR_URL` 推出 `ws://<编辑器源>/docservice`，探活 `GET <编辑器源>/api/docservice/healthz`，
 *       回 `mode: 'editor'`。用注入的 `fetch`，不起真服务器。
 *
 * 真 sink 那两条要 `FramePipeline`：`server/bakery/index.mjs` 整个换成假的（`mock.module`），单测不开 Chrome。
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('Unit test does not open Chrome'); },
    findFfmpeg: async () => { throw new Error('Unit test does not look for ffmpeg'); },
    streamPngVideo: () => { throw new Error('Unit test does not encode'); },
    bakeFrames: async () => { throw new Error('Unit tests do not render'); },
  },
});

const { createRenderQueue } = await import('../render-queue/index.mjs');
const { createLocalNode } = await import('../render-node/local-node.mjs');
const { createLoopback } = await import('./fake-loopback-transport.mjs');
const { createTimerClock } = await import('./fake-render-executor.mjs');
const { createAssetHarness } = await import('./fake-asset-service.mjs');

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const wire = (v) => JSON.parse(JSON.stringify(v));
const STEP_MS = 250;

/* ================================================================== 进程内的小拓扑 */

function pcNode(fp, cv) {
  return {
    profile: 'pc', userId: 'u1', envFingerprint: fp, codeVersions: [cv], cardSourceVersions: {},
    capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 16_000 },
  };
}

/** TaskView → TaskInput（去掉队列加的字段） */
function inputOf(task) {
  const { state, version, attempts, ...rest } = task;
  void state; void version; void attempts;
  const source = { projectId: rest.source.projectId, projectRev: rest.source.projectRev };
  return { ...rest, source };
}

/**
 * 一个队列、一个页面、一个本机节点。`executor`、`sink` 由调用方给。
 * 节点的指纹、代码版本要和任务的 `requires` 对得上。
 */
function createRig({ executor, sink, fp, cv }) {
  const clock = createTimerClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch: 'epoch-j5' });
  lb.attach(queue);
  const pageEp = lb.connect('conn-page', { userId: 'u1', tenantId: 't1' });
  const inbox = [];
  pageEp.onMessage((m) => inbox.push(m));
  pageEp.send({ type: 'publisher.hello', publisherId: 'page-1' });
  const nodeEp = lb.connect('conn-node', { userId: 'u1', tenantId: 't1' });
  const events = [];
  const local = createLocalNode({
    nodeId: 'node-1', node: pcNode(fp, cv), endpoint: nodeEp, now: clock.now, random: () => 0.5,
    isIdle: () => true, maxConcurrent: 1, codeVersion: cv, executor, sink,
    onEvent: (e) => events.push(e),
  });
  local.start();
  return {
    clock, lb, queue, local, inbox, events,
    publish(tasks) { pageEp.send({ type: 'task.publish', tasks }); },
    done: (id) => inbox.find((m) => m.type === 'task.done' && m.id === id),
    doneCount: (id) => inbox.filter((m) => m.type === 'task.done' && m.id === id).length,
    completes: () => lb.log().filter((e) => e.dir === 'in' && e.message.type === 'task.complete').map((e) => e.message),
  };
}

async function settle(rig) {
  for (let round = 0; round < 1_000; round++) {
    rig.lb.flush();
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
    if (rig.lb.pending() === 0) {
      await new Promise((resolve) => setImmediate(resolve));
      if (rig.lb.pending() === 0) return;
    }
  }
  throw new Error('message round trips do not converge');
}

/**
 * 驱动到条件成立：flush → 节点 tick → queue.tick → 推进假时钟。
 *
 * 纯内存（`realMs` 为 0）：每步把假时钟推 STEP_MS，最多 `maxSteps` 步。
 * 带真 I/O（真 sink，`realMs` > 0）：每步先等 `realMs` 真时间，假时钟按这一步实际经过的真时间推进（至少 1 ms），
 * 不按步数判失败，而是到 `realDeadlineMs` 这段真时间用完才判。这样机器忙时 I/O 慢，只是多走几步；
 * 假时钟与真时间同步，租约（30 s）、停滞（120 s）这些按假时钟算的时限不会因为「步数多了」被提前触发。
 */
async function drive(rig, until, { maxSteps = 400, realMs = 0, realDeadlineMs = 20_000 } = {}) {
  const t0 = Date.now();
  let last = t0;
  for (let step = 0; realMs ? Date.now() - t0 < realDeadlineMs : step < maxSteps; step++) {
    await settle(rig);
    rig.local.tick();
    await settle(rig);
    rig.queue.tick();
    await settle(rig);
    if (until()) return step;
    if (realMs) {
      await new Promise((resolve) => setTimeout(resolve, realMs));
      const now = Date.now();
      rig.clock.advance(Math.max(1, now - last));
      last = now;
    } else {
      rig.clock.advance(STEP_MS);
    }
  }
  const limit = realMs ? `${realDeadlineMs} ms real time` : `${maxSteps} steps`;
  assert.fail(`condition still not met after ${limit}; queue.describe(): ${JSON.stringify(rig.queue.describe()).slice(0, 2000)}\nnode events: ${JSON.stringify(rig.events).slice(0, 2000)}`);
}

function hygiene(rig) {
  assert.deepEqual(rig.lb.errors().map((e) => String(e?.stack ?? e)), [], 'The endpoint handler / queue.handle threw an exception');
  assert.deepEqual(rig.lb.nonJson(), [], 'some message cannot round-trip through JSON');
  const errors = rig.lb.log().filter((e) => e.dir === 'out' && e.message.type === 'error').map((e) => e.message);
  assert.deepEqual(errors, [], 'the queue replied with an error');
}

/* ------------------------------------------------------------------ 夹具任务 */

const FP = '0123456789abcdef';
const CV = 'c0de-j5';

function fineTask({ kind = 'snapshot', tier = 'shared', label, from, to, entryKey = null, canvasHeavy }) {
  const contentKey = tier === 'local' && kind === 'snapshot' ? `${entryKey}/${sha256(`ck:${label}`)}` : sha256(`ck:${label}`);
  const resultKey = sha256(`${contentKey}\n${FP}`);
  const unit = kind === 'stream' ? 'segment' : 'localFrame';
  const range = { unit, from, to };
  const input = { clipId: `clip-${label}`, cardId: kind === 'stream' ? null : `card-${label}`, entryKey: kind === 'snapshot' && tier === 'local' ? entryKey : null, contentKey };
  if (canvasHeavy !== undefined) input.canvasHeavy = canvasHeavy;
  const task = {
    id: `${kind}:${resultKey}:${from}-${to}`, kind, resultKey, range,
    source: { projectId: 'proj-j5', projectRev: 1 },
    input,
    weight: { class: 'medium', estMs: null, frames: kind === 'stream' ? (to - from + 1) * 15 : to - from + 1 },
    requires: { envFingerprint: FP, codeVersion: CV, cardSources: {}, transcode: kind === 'stream', userCards: false, graphCards: false, belowDependent: tier === 'local' },
    priority: 10,
  };
  if (kind === 'snapshot') task.tier = tier;
  return task;
}

/** 一段的假清单（C6.2 SnapshotResult 的形状，内容不重要） */
function manifestOf(task, tag = 'm') {
  const n = task.range.to - task.range.from + 1;
  return {
    v: 1, kind: task.kind, tier: task.kind === 'stream' ? null : task.tier, resultKey: task.resultKey, dirKey: task.resultKey,
    entryKey: task.input.entryKey, range: { from: task.range.from, to: task.range.to }, canvasHeavy: false,
    frames: Array.from({ length: Math.min(n, 4) }, (_, i) => [task.range.from + i, sha256(`${tag}:${task.id}:${i}`), 100 + i]),
  };
}

/** 记账的假 sink：`hasAnswer(ref)`、`putAnswer(ref)`、`resultFor`（可不给） */
function recordingSink({ hasAnswer = () => false, putAnswer, resultFor } = {}) {
  const calls = { has: [], put: [], resultFor: [] };
  const sink = {
    calls,
    async has(ref) { calls.has.push(wire(ref)); return hasAnswer(ref); },
    async put(entry) { calls.put.push(wire({ ...entry, artifacts: entry.artifacts ?? null })); return putAnswer(entry); },
  };
  if (resultFor) sink.resultFor = async (ref) => { calls.resultFor.push(wire(ref)); return resultFor(ref); };
  return sink;
}

function recordingExecutor() {
  const renders = [];
  return {
    renders,
    async plan() { throw Object.assign(new Error('this test case sends no plan'), { retryable: false }); },
    async render(task, { progress }) { renders.push(task.id); progress?.(task.range.to - task.range.from + 1); return { fake: task.id }; },
  };
}

/** ref 带任务的 input 与 requires（J.3），以及 D.1 原有的四个字段 */
function assertRef(ref, task, what) {
  assert.equal(ref.resultKey, task.resultKey, `${what}: resultKey`);
  assert.equal(ref.kind, task.kind, `${what}: kind`);
  assert.equal(ref.tier ?? null, task.kind === 'stream' ? null : task.tier, `${what}: tier`);
  assert.deepEqual(ref.range, task.range, `${what}: range`);
  assert.deepEqual(ref.input, task.input, `${what}: ref.input is the input of the task`);
  assert.deepEqual(ref.requires, task.requires, `${what}: ref.requires is the requires of the task`);
}

/* ================================================================== J5（假 sink） */

test('J5 put path: result of task.done = { ranges, ...manifest returned by put } (with fields such as frames); the ref of has / put carries input and requires', async () => {
  const shared = fineTask({ label: 'j5-put', from: 0, to: 59 });
  const local = fineTask({ tier: 'local', label: 'j5-put-local', from: 60, to: 89, entryKey: sha256('entry-j5') });
  const stream = fineTask({ kind: 'stream', label: 'j5-put-stream', from: 0, to: 7 });
  const tasks = [shared, local, stream];
  const manifests = new Map(tasks.map((t) => [t.resultKey, manifestOf(t, 'put')]));
  const sink = recordingSink({ putAnswer: (e) => ({ complete: true, result: manifests.get(e.resultKey) }) });
  const exec = recordingExecutor();
  const rig = createRig({ executor: exec, sink, fp: FP, cv: CV });
  rig.publish(tasks);
  await drive(rig, () => tasks.every((t) => rig.doneCount(t.id) >= 1));

  for (const t of tasks) {
    assert.equal(rig.doneCount(t.id), 1, `${t.id}: exactly one task.done`);
    const done = rig.done(t.id);
    assert.deepEqual(done.result, { ranges: [[t.range.from, t.range.to]], ...manifests.get(t.resultKey) },
      `${t.id}: result is { ranges, ...result returned by put }`);
    assert.ok(Array.isArray(done.result.frames) && done.result.frames.length > 0, `${t.id}: carries frames`);
    assert.equal(done.result.dedup, undefined, `${t.id}: the put path carries no dedup`);
    const hasRef = sink.calls.has.find((r) => r.resultKey === t.resultKey);
    const putRef = sink.calls.put.find((r) => r.resultKey === t.resultKey);
    assert.ok(hasRef && putRef, `${t.id}: both has and put were called`);
    assertRef(hasRef, t, `${t.id} has`);
    assertRef(putRef, t, `${t.id} put`);
    assert.equal(putRef.meta.taskId, t.id, 'put\'s meta is unchanged (D.1)');
    assert.equal(putRef.meta.nodeId, 'node-1');
    assert.deepEqual(putRef.artifacts, { fake: t.id }, 'artifacts are passed to sink.put as is');
  }
  assert.deepEqual([...exec.renders].sort(), tasks.map((t) => t.id).sort());
  hygiene(rig);
});

test('J5 put returns { complete: true } without result: still reports only { ranges } as before (compatible with D.2)', async () => {
  const t = fineTask({ label: 'j5-put-bare', from: 0, to: 29 });
  const sink = recordingSink({ putAnswer: () => ({ complete: true }) });
  const rig = createRig({ executor: recordingExecutor(), sink, fp: FP, cv: CV });
  rig.publish([t]);
  await drive(rig, () => rig.doneCount(t.id) >= 1);
  assert.deepEqual(rig.done(t.id).result, { ranges: [[0, 29]] });
  hygiene(rig);
});

test('J5 dedup path: when has is true, the result of task.done = { ranges, dedup: true, ...resultFor(ref) }; the ref resultFor receives carries input and requires; nothing is rendered or pushed', async () => {
  const shared = fineTask({ label: 'j5-dedup', from: 60, to: 119 });
  const local = fineTask({ tier: 'local', label: 'j5-dedup-local', from: 0, to: 44, entryKey: sha256('entry-j5-dedup') });
  const tasks = [shared, local];
  const manifests = new Map(tasks.map((t) => [t.resultKey, manifestOf(t, 'dedup')]));
  const sink = recordingSink({
    hasAnswer: () => true,
    putAnswer: () => { throw new Error('the dedup path must not put'); },
    resultFor: (ref) => manifests.get(ref.resultKey),
  });
  const exec = recordingExecutor();
  const rig = createRig({ executor: exec, sink, fp: FP, cv: CV });
  rig.publish(tasks);
  await drive(rig, () => tasks.every((t) => rig.doneCount(t.id) >= 1));

  for (const t of tasks) {
    assert.deepEqual(rig.done(t.id).result, { ranges: [[t.range.from, t.range.to]], dedup: true, ...manifests.get(t.resultKey) },
      `${t.id}: result is { ranges, dedup: true, ...resultFor }`);
    const ref = sink.calls.resultFor.find((r) => r.resultKey === t.resultKey);
    assert.ok(ref, `${t.id}: resultFor was called`);
    assertRef(ref, t, `${t.id} resultFor`);
    assertRef(sink.calls.has.find((r) => r.resultKey === t.resultKey), t, `${t.id} has`);
  }
  assert.deepEqual(exec.renders, [], 'deduplicated tasks are not rendered');
  assert.deepEqual(sink.calls.put, [], 'deduplicated tasks are not pushed');
  assert.deepEqual(rig.events.filter((e) => e.type === 'dedup').map((e) => e.id).sort(), tasks.map((t) => t.id).sort(), 'onEvent still reports dedup as before');
  hygiene(rig);
});

test('J5 dedup path: when the sink has no resultFor, it still reports only { ranges, dedup: true } as before (compatible with D.2)', async () => {
  const a = fineTask({ label: 'j5-no-resultfor', from: 0, to: 59 });
  const sinkA = recordingSink({ hasAnswer: () => true, putAnswer: () => ({ complete: false }) });
  assert.equal(sinkA.resultFor, undefined);
  const rigA = createRig({ executor: recordingExecutor(), sink: sinkA, fp: FP, cv: CV });
  rigA.publish([a]);
  await drive(rigA, () => rigA.doneCount(a.id) >= 1);
  assert.deepEqual(rigA.done(a.id).result, { ranges: [[0, 59]], dedup: true });
  hygiene(rigA);
});

test('J5 dedup path: when resultFor returns null, only { ranges, dedup: true } is reported', async () => {
  const b = fineTask({ label: 'j5-resultfor-null', from: 0, to: 59 });
  const sinkB = recordingSink({ hasAnswer: () => true, putAnswer: () => ({ complete: false }), resultFor: () => null });
  const rigB = createRig({ executor: recordingExecutor(), sink: sinkB, fp: FP, cv: CV });
  rigB.publish([b]);
  await drive(rigB, () => rigB.doneCount(b.id) >= 1);
  assert.deepEqual(rigB.done(b.id).result, { ranges: [[0, 59]], dedup: true });
  assert.equal(sinkB.calls.resultFor.length, 1);
  hygiene(rigB);
});

/* ================================================================== J5（C6.2 的真 sink） */

const harness = createAssetHarness();
after(() => harness.cleanup());

let F = null, FramePipeline = null, transfer = null, clientMod = null;
async function loadReal() {
  F ||= await import('./fake-artifact-fixtures.mjs');
  FramePipeline ||= (await import('../frame-pipeline.mjs')).FramePipeline;
  transfer ||= await import('../artifact-transfer.mjs');
  clientMod ||= await import('../asset-store/client.mjs');
  return { F, FramePipeline, transfer, newClient: (base) => clientMod.createAssetClient({ base }) };
}

test('J5 real sink (createAssetSink): A renders locally and goes through put, with task.done carrying the C6.2 manifest; B has an empty frame store but the content store has the manifest, so it goes through dedup, and task.done carries the same manifest', { timeout: 45_000 }, async (t) => {
  const { F: fx, FramePipeline: FP_, transfer: T, newClient } = await loadReal();
  const roots = fx.makeRoots(FP_, 'pc-m5b-j5-');
  t.after(() => roots.cleanup());
  const svc = await fx.startServices(harness, newClient);
  t.after(() => svc.cleanup());

  const view = fx.snapshotTask({ contentKey: sha256('card-j5-real'), from: 0, to: 59 });
  const task = inputOf(view);
  const A = roots.make(await roots.root());

  // A：帧库起初是空的（has 为假）；执行器「渲染」时把这一段写进帧库，sink.put 读出清单、推上去
  const execA = {
    renders: [], async plan() { throw new Error('no plan'); },
    async render(tk) { execA.renders.push(tk.id); await fx.seedSnapshots(A, view, fx.range(0, 59)); return null; },
  };
  const sinkA = T.createAssetSink({ pipeline: A, client: svc.client, content: svc.content });
  const rigA = createRig({ executor: execA, sink: sinkA, fp: fx.TASK_FP, cv: 'c' });
  rigA.publish([task]);
  await drive(rigA, () => rigA.doneCount(task.id) >= 1, { realMs: 5 });
  const doneA = rigA.done(task.id);
  assert.deepEqual(execA.renders, [task.id], 'A rendered this segment');
  const expected = fx.unpack(await T.collectSnapshotResult(A, view)).result;
  assert.equal(doneA.result.dedup, undefined, 'A goes through put, not dedup');
  assert.deepEqual(wire(doneA.result), { ranges: [[0, 59]], ...wire(expected) }, 'A\'s task.done carries the C6.2 manifest (the result returned by put)');
  hygiene(rigA);
  for (const [, hash] of doneA.result.frames) assert.ok(await svc.client.has('snap', hash), 'chunks have been pushed to the asset service');

  // B：另一台机器，帧库为空；内容库里有 A 写的清单、块都在素材服务上 → 去重
  const B = roots.make(await roots.root());
  const contentB = await svc.another('node-b');
  const execB = { renders: [], async plan() { throw new Error('no plan'); }, async render(tk) { execB.renders.push(tk.id); return null; } };
  const sinkB = T.createAssetSink({ pipeline: B, client: svc.client, content: contentB });
  // 内容库的清单在 A 的 put 回包之后才写完也允许：等它出现（按条件等，15 s 真时间封顶；机器忙时也够）
  const t0 = Date.now();
  while (!(await contentB.get('snapshot-manifest', fx.manifestKey(view))) && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 20));
  const rigB = createRig({ executor: execB, sink: sinkB, fp: fx.TASK_FP, cv: 'c' });
  rigB.publish([task]);
  await drive(rigB, () => rigB.doneCount(task.id) >= 1, { realMs: 5 });
  const doneB = rigB.done(task.id);
  assert.deepEqual(wire(doneB.result), { ranges: [[0, 59]], dedup: true, ...wire(expected) }, 'B\'s task.done carries the manifest from resultFor');
  assert.deepEqual(execB.renders, [], 'B did not render');
  hygiene(rigB);
});

/* ================================================================== J6 */

let splitMod = null;
const loadSplit = async () => (splitMod ||= await import('../render-node/split.mjs'));

function control({ clipId, label, caps, count = 60, entryTier }) {
  const tier = entryTier ?? ((caps.compositing === 'independent' || caps.compositing === 'sourceDependent') ? 'shared' : 'local');
  const contentKey = sha256(`content:${label}`);
  return {
    key: sha256(`png:${label}`), snapshotKey: sha256(`${contentKey}\n${FP}`), contentKey, envFingerprint: FP,
    frameMode: 'stateful', tier, capabilities: caps, clipId, nodeId: `n:${clipId}`, cardId: `card-${label}`,
    start: 0, end: count / 30, count, sampling: { firstFrame: 0, fps: { numerator: 30, denominator: 1 }, phase: { numerator: 0, denominator: 1 } },
    compositing: caps.compositing, cacheable: caps.compositing === 'independent', needPrerendering: false,
  };
}

test('J6 split: snapshot tasks carry input.canvasHeavy (true only when capabilities.canvasHeavy === true; both the shared tier and the local tier carry it)', async () => {
  const { splitPlan, planTaskOf } = await loadSplit();
  const planTask = planTaskOf({ projectId: 'proj-j6', projectRev: 2 });
  const cardPlan = [
    control({ clipId: 'c-canvas', label: 'canvas', caps: { frameMode: 'stateful', compositing: 'independent', canvasHeavy: true }, count: 90 }),
    control({ clipId: 'c-dom', label: 'dom', caps: { frameMode: 'stateful', compositing: 'independent', canvasHeavy: false } }),
    control({ clipId: 'c-plain', label: 'plain', caps: { frameMode: 'stateful', compositing: 'independent' } }),
    control({ clipId: 'c-truthy', label: 'truthy', caps: { frameMode: 'stateful', compositing: 'independent', canvasHeavy: 'yes' } }),
    control({ clipId: 'c-local-canvas', label: 'local-canvas', caps: { frameMode: 'stateful', compositing: 'belowDependent', canvasHeavy: true } }),
    control({ clipId: 'c-local', label: 'local', caps: { frameMode: 'stateful', compositing: 'belowDependent' } }),
  ];
  const tasks = splitPlan({ planTask, entryKey: sha256('entry-j6'), cardPlan, envFingerprint: FP, codeVersion: CV, streams: [] });
  const want = { 'c-canvas': true, 'c-dom': false, 'c-plain': false, 'c-truthy': false, 'c-local-canvas': true, 'c-local': false };
  for (const [clipId, flag] of Object.entries(want)) {
    const mine = tasks.filter((x) => x.input.clipId === clipId);
    assert.ok(mine.length >= 1, `tasks were split out for ${clipId}`);
    for (const x of mine) {
      assert.equal(x.kind, 'snapshot');
      assert.equal(x.input.canvasHeavy, flag, `${clipId} ${x.range.from}-${x.range.to}: input.canvasHeavy === ${flag} (only === true counts)`);
    }
  }
  assert.equal(tasks.filter((x) => x.input.clipId === 'c-canvas').length, 2, '90 frames split into two segments, each segment carries it');
  // 其它 input 字段照旧
  const one = tasks.find((x) => x.input.clipId === 'c-local');
  assert.equal(one.input.entryKey, sha256('entry-j6'));
  assert.equal(one.input.contentKey, `${sha256('entry-j6')}/${sha256('content:local')}`);
});

test('J6 split: planTaskOf accepts { codeVersion, envFingerprint } and writes them into requires; when not given, requires stays empty as before and the id does not change', async () => {
  const { planTaskOf } = await loadSplit();
  const bare = planTaskOf({ projectId: 'proj-j6', projectRev: 7 });
  assert.deepEqual(wire(bare.requires), {}, 'when not given, requires is empty (same as the M3 plan task)');
  const withReq = planTaskOf({ projectId: 'proj-j6', projectRev: 7, codeVersion: 'code-abc', envFingerprint: 'fedcba9876543210' });
  assert.equal(withReq.requires.codeVersion, 'code-abc');
  assert.equal(withReq.requires.envFingerprint, 'fedcba9876543210');
  assert.equal(withReq.id, bare.id, 'the id is determined only by kind and resultKey and does not change with requires');
  assert.equal(withReq.id, 'plan:proj-j6@7');
  assert.equal(withReq.kind, 'plan');
  assert.equal(withReq.resultKey, 'proj-j6@7');
  assert.deepEqual(withReq.source, { projectId: 'proj-j6', projectRev: 7 });
  const onlyCode = planTaskOf({ projectId: 'proj-j6', projectRev: 8, codeVersion: 'code-abc' });
  assert.equal(onlyCode.requires.codeVersion, 'code-abc');
  assert.ok(onlyCode.requires.envFingerprint === undefined || onlyCode.requires.envFingerprint === null, 'items not given are not written');
  // 能过 JSON（要上线）
  assert.deepEqual(wire(withReq), withReq);
});

test('J6 split: a plan task with requires can be published through a real queue; a node with a different code version cannot claim it, a node with the same one claims and completes it', async () => {
  // 注意：plan 的 requires.envFingerprint 不参与认领过滤（B 节 filter.mjs 规则 1、I.2 都把 plan 排除在外，
  // 「谁认领谁的指纹就是这一版的指纹」）。所以这里只断言代码版本这一条，不断言别的指纹认领不到。
  const { planTaskOf } = await loadSplit();
  const plan = planTaskOf({ projectId: 'proj-j6q', projectRev: 1, codeVersion: CV, envFingerprint: FP });
  const plans = [];
  const executor = {
    async plan(task) { plans.push(task); return { entryKey: sha256('e'), cardPlan: [], streams: [] }; },
    async render() { return null; },
  };
  const sink = recordingSink({ putAnswer: () => ({ complete: true }) });
  const other = createRig({ executor, sink, fp: FP, cv: 'another-code' });
  other.publish([plan]);
  await drive(other, () => false, { maxSteps: 12 }).catch(() => {});
  assert.deepEqual(plans, [], 'a node with a different code version cannot claim it');
  assert.deepEqual(other.lb.log().filter((e) => e.dir === 'out' && e.message.type === 'error').map((e) => e.message), [], 'the queue accepts a plan with requires');
  const same = createRig({ executor, sink, fp: FP, cv: CV });
  same.publish([plan]);
  await drive(same, () => same.doneCount(plan.id) >= 1);
  assert.equal(plans.length, 1, 'a node with the same code version claims and completes it');
  assert.equal(plans[0].requires.codeVersion, CV, 'the claimed plan carries requires.codeVersion');
  assert.equal(plans[0].requires.envFingerprint, FP, 'the claimed plan carries requires.envFingerprint');
  hygiene(same);
});

/* ================================================================== J7 */

let endpointMod = null;
const loadEndpoint = async () => (endpointMod ||= await import('../render-node/endpoint.mjs'));

/** 注入的 fetch：`routes` 是 目标 URL → 健康检查的 JSON（null = 连不上）。记下每次请求的目标 */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (target) => {
    const url = String(target);
    calls.push(url);
    const body = routes[url];
    if (body === undefined || body === null) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const HEALTHY = { ok: true, protocol: 'promptcut.v1', service: 'promptcut-docservice' };

test('J7 resolveDocservice: with PROMPTCUT_EDITOR_URL set and the editor\'s health check passing → mode: editor, and url is ws://<editor origin>/docservice', async () => {
  const { resolveDocservice } = await loadEndpoint();
  const { fetch, calls } = fakeFetch({
    'http://127.0.0.1:5173/api/docservice/healthz': HEALTHY,
    'http://127.0.0.1:8787/healthz': HEALTHY,
  });
  const r = await resolveDocservice({ env: { PROMPTCUT_EDITOR_URL: 'http://127.0.0.1:5173' }, fetch, timeoutMs: 1000 });
  assert.equal(r.mode, 'editor', JSON.stringify(r));
  assert.equal(r.url, 'ws://127.0.0.1:5173/docservice');
  assert.equal(r.health?.ok, true);
  assert.deepEqual(calls, ['http://127.0.0.1:5173/api/docservice/healthz'], 'once the editor entry is reachable, loopback is not tried');
  assert.equal(r.tried.length, 1);
  assert.equal(r.tried[0].ok, true);

  // 编辑器地址带路径、结尾斜杠：只取源
  const f2 = fakeFetch({ 'http://localhost:5190/api/docservice/healthz': HEALTHY });
  const r2 = await resolveDocservice({ env: { PROMPTCUT_EDITOR_URL: 'http://localhost:5190/some/page/?x=1' }, fetch: f2.fetch, timeoutMs: 1000 });
  assert.deepEqual([r2.mode, r2.url], ['editor', 'ws://localhost:5190/docservice']);
  assert.deepEqual(f2.calls, ['http://localhost:5190/api/docservice/healthz']);

  // https 的编辑器 → wss
  const f3 = fakeFetch({ 'https://editor.example.invalid:8443/api/docservice/healthz': HEALTHY });
  const r3 = await resolveDocservice({ env: { PROMPTCUT_EDITOR_URL: 'https://editor.example.invalid:8443' }, fetch: f3.fetch, timeoutMs: 1000 });
  assert.deepEqual([r3.mode, r3.url], ['editor', 'wss://editor.example.invalid:8443/docservice']);
});

test('J7 resolveDocservice order: environment variable address → editor → loopback 8787 → offline', async () => {
  const { resolveDocservice } = await loadEndpoint();
  const REMOTE = 'ws://10.0.0.5:8787';
  const REMOTE_H = 'http://10.0.0.5:8787/healthz';
  const EDITOR_H = 'http://127.0.0.1:5173/api/docservice/healthz';
  const LOCAL_H = 'http://127.0.0.1:8787/healthz';
  const env = { PROMPTCUT_DOCSERVICE_URL: REMOTE, PROMPTCUT_EDITOR_URL: 'http://127.0.0.1:5173' };
  const run = (routes) => { const f = fakeFetch(routes); return resolveDocservice({ env, fetch: f.fetch, timeoutMs: 1000 }).then((r) => ({ r, calls: f.calls })); };

  // 1. 环境变量地址可用：remote，别的不试
  let { r, calls } = await run({ [REMOTE_H]: HEALTHY, [EDITOR_H]: HEALTHY, [LOCAL_H]: HEALTHY });
  assert.deepEqual([r.mode, r.url], ['remote', REMOTE]);
  assert.deepEqual(calls, [REMOTE_H]);

  // 2. 环境变量地址不通、编辑器通：editor
  ({ r, calls } = await run({ [EDITOR_H]: HEALTHY, [LOCAL_H]: HEALTHY }));
  assert.deepEqual([r.mode, r.url], ['editor', 'ws://127.0.0.1:5173/docservice']);
  assert.deepEqual(calls, [REMOTE_H, EDITOR_H]);
  assert.deepEqual(r.tried.map((x) => x.ok), [false, true]);

  // 3. 编辑器也不通：回环
  ({ r, calls } = await run({ [LOCAL_H]: HEALTHY }));
  assert.deepEqual([r.mode, r.url], ['local', 'ws://127.0.0.1:8787']);
  assert.deepEqual(calls, [REMOTE_H, EDITOR_H, LOCAL_H]);
  assert.deepEqual(r.tried.map((x) => x.ok), [false, false, true]);

  // 4. 全不通：离线，三项都试过
  ({ r, calls } = await run({}));
  assert.equal(r.mode, 'offline');
  assert.equal(r.url, undefined);
  assert.deepEqual(calls, [REMOTE_H, EDITOR_H, LOCAL_H]);
  assert.equal(r.tried.length, 3);

  // 5. 编辑器回的健康检查不合格（ok 不是 true、protocol 不对）：跳过
  ({ r } = await run({ [EDITOR_H]: { ok: false, protocol: 'promptcut.v1' }, [LOCAL_H]: HEALTHY }));
  assert.equal(r.mode, 'local');
  ({ r } = await run({ [EDITOR_H]: { ok: true, protocol: 'promptcut.v0' }, [LOCAL_H]: HEALTHY }));
  assert.equal(r.mode, 'local');

  // 6. 没设 PROMPTCUT_EDITOR_URL（含空串）：不试编辑器，行为与 M5a 相同
  for (const e of [{ PROMPTCUT_DOCSERVICE_URL: REMOTE }, { PROMPTCUT_DOCSERVICE_URL: REMOTE, PROMPTCUT_EDITOR_URL: '' }]) {
    const f = fakeFetch({ [EDITOR_H]: HEALTHY, [LOCAL_H]: HEALTHY });
    const rr = await resolveDocservice({ env: e, fetch: f.fetch, timeoutMs: 1000 });
    assert.equal(rr.mode, 'local');
    assert.deepEqual(f.calls, [REMOTE_H, LOCAL_H]);
  }

  // 7. 回环端口照旧可配
  const f7 = fakeFetch({ 'http://127.0.0.1:8799/healthz': HEALTHY });
  const r7 = await resolveDocservice({ env: { PROMPTCUT_EDITOR_URL: 'http://127.0.0.1:5173', PROMPTCUT_DOCSERVICE_PORT: '8799' }, fetch: f7.fetch, timeoutMs: 1000 });
  assert.deepEqual([r7.mode, r7.url], ['local', 'ws://127.0.0.1:8799']);
  assert.deepEqual(f7.calls, [EDITOR_H, 'http://127.0.0.1:8799/healthz']);
});
