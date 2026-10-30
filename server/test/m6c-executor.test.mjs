/**
 * M6c 契约（`docs/plan/m6c-contract.md`）里要用执行器与预渲染管线的两项：
 *   MC-X1-exec-*  执行器接受 `kind: 'stream'` 的细任务，不再抛 `stream-not-supported`（烟测，〔假设 A-X1-1〕）
 *   MC-X5-*       本机队列节点的闲时门槛：执行器有空位、且最近 500 ms 没有交互帧请求就认领；
 *                 preload 没到 ready 也照样认领；拖动期间新认领 0 次，手里在做的做完
 * 跑：node --experimental-test-module-mocks --test server/test/m6c-executor.test.mjs
 *
 * 只照契约写，不看实现。`server/bakery/index.mjs` 整个换成假的（`mock.module`），单测不开 Chrome、不找 ffmpeg。
 * X5 用真的 `FramePipeline`（`interactive: false`、注入 `environment` 与 `playhead`）和真的 `createPrerenderExecutor`；
 * Date 由 `mock.timers` 接管。preload 与交互的模拟方式见 `m6c-kit.mjs` 的〔假设 A-X5-1〕〔A-X5-2〕〔A-X5-3〕。
 * 实现不在测试分支上：新行为的用例在这里失败是预期的。
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('单测不开 Chrome'); },
    findFfmpeg: async () => { throw new Error('单测不找 ffmpeg'); },
    streamPngVideo: () => { throw new Error('单测不编码'); },
    bakeFrames: async () => { throw new Error('单测不渲染'); },
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
const { createRenderQueue } = await import('../render-queue/index.mjs');
const { createLocalNode } = await import('../render-node/local-node.mjs');
const { describeEnvironment } = await import('../render-node/fingerprint.mjs');
const { createLoopback } = await import('./fake-loopback-transport.mjs');
const { streamTask, snapTask, nodeDescriptor, createPlayhead, simulatePreloadRunning, queueIdle } = await import('./m6c-kit.mjs');

const ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});

const temps = [];
const pipelines = [];
after(async () => {
  for (const p of pipelines) { try { await p.closeNow?.(); } catch { /* 收尾出错不影响结果 */ } }
  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function makePipeline(playhead) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm6c-exec-'));
  temps.push(root);
  const pipeline = new FramePipeline({
    root, origin: 'http://127.0.0.1:1', interactive: false, playhead, dataRoot: root, environment: ENV,
  });
  pipelines.push(pipeline);
  return pipeline;
}

const noProjects = { get: async () => null };

/* ================================================================== X1 执行器接受流任务 */

test('MC-X1-exec：执行器 render 流任务不再以 stream-not-supported 拒绝（烟测）', async () => {
  // 假管线：流生产者的任何方法都是异步空操作；真产流（ffmpeg）归 queue-mode-probe / stream-produce-probe
  const producer = new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : async () => ({})) });
  const pipeline = {
    closed: false, envFingerprint: ENV.fingerprint, entries: new Map(), generations: new Map(),
    streams: () => producer, streamProducer: () => producer,
    queueHandles: () => true,
    planForQueue: async () => ({ entry: { key: 'e1', cardPlan: [] }, context: { entryKey: 'e1', cardPlan: [], streams: [] } }),
  };
  const projects = { get: async () => ({ id: 'p1', fps: 30, width: 16, height: 16, duration: 5, tracks: [{ id: 't1', clips: [] }], media: [] }) };
  const executor = createPrerenderExecutor({ pipeline, projects });
  const task = { ...streamTask(), source: { projectId: 'p1', projectRev: 1, userId: 'u1' }, state: 'claimed', version: 2, attempts: 0 };
  const controller = new AbortController();
  const outcome = await Promise.race([
    Promise.resolve().then(() => executor.render(task, { signal: controller.signal, progress: () => {} }))
      .then(() => ({ ok: true }), (error) => ({ ok: false, error })),
    new Promise(resolve => setTimeout(() => resolve({ ok: 'pending' }), 300)),
  ]);
  controller.abort('test-end');
  if (outcome.ok === false) {
    assert.notEqual(outcome.error?.code, 'stream-not-supported', `执行器仍拒绝流任务：${outcome.error?.message}`);
  }
});

/* ================================================================== X5 闲时门槛 */

test('MC-X5-idle：preload 没到 ready、500 ms 内没有交互时，执行器算闲', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const playhead = createPlayhead();
  const pipeline = await makePipeline(playhead);
  const executor = createPrerenderExecutor({ pipeline, projects: noProjects });
  simulatePreloadRunning(pipeline);
  assert.equal(queueIdle(pipeline, Date.now()), true, 'preload 在跑、没有交互：应算闲');
  playhead.stop(Date.now() - 2000);
  assert.equal(queueIdle(pipeline, Date.now()), true, '2 秒前停下的播放头：应算闲');
});

test('MC-X5-drag：100 ms 前拖过不闲；拖动停下 500 ms 之后又闲', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const playhead = createPlayhead();
  const pipeline = await makePipeline(playhead);
  const executor = createPrerenderExecutor({ pipeline, projects: noProjects });
  playhead.drag(Date.now());
  t.mock.timers.tick(100);
  assert.equal(queueIdle(pipeline, Date.now()), false, '100 ms 前拖过：不闲');
  t.mock.timers.tick(500);
  assert.equal(queueIdle(pipeline, Date.now()), true, '最后一次拖动在 600 ms 前：按契约 500 ms 应算闲');
});

test('MC-X5-play：播放中不闲', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const playhead = createPlayhead();
  const pipeline = await makePipeline(playhead);
  const executor = createPrerenderExecutor({ pipeline, projects: noProjects });
  playhead.play(Date.now());
  t.mock.timers.tick(50);
  assert.equal(queueIdle(pipeline, Date.now()), false);
});

/**
 * 真队列 + 环回 + 本机节点：`isIdle` 接真执行器的闲时门槛，`render` 由测试控制（手动放行）。
 * 页面发布 4 段快照，preload 一直在跑。
 */
async function idleRig(t) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const playhead = createPlayhead();
  const pipeline = await makePipeline(playhead);
  const real = createPrerenderExecutor({ pipeline, projects: noProjects });
  simulatePreloadRunning(pipeline);

  const lb = createLoopback();
  const queue = createRenderQueue({ now: () => Date.now(), send: lb.queueSend });
  lb.attach(queue);
  const page = lb.connect('conn-page', { userId: 'u1', tenantId: 't1' });
  const pageInbox = [];
  page.onMessage(m => pageInbox.push(m));
  page.send({ type: 'publisher.hello', publisherId: 'page-1' });

  const claims = [];
  const gates = new Map();   // id → 放行函数
  const ep = lb.connect('conn-node', { userId: 'u1', tenantId: 't1' });
  const endpoint = {
    send: (m) => { if (m?.type === 'task.claim') claims.push({ id: m.id, at: Date.now() }); ep.send(m); },
    onMessage: (h) => ep.onMessage(h),
  };
  const executor = {
    plan: async () => { throw new Error('这里不切分'); },
    render: (task) => new Promise((resolve) => gates.set(task.id, resolve)),
    isIdle: (now) => queueIdle(pipeline, now),
  };
  const sink = { has: async () => false, put: async () => ({ complete: true, result: {} }) };
  const node = nodeDescriptor({ nodeId: 'node-local', capabilities: { streams: false } });
  const local = createLocalNode({
    nodeId: 'node-local', node, endpoint, now: () => Date.now(), random: () => 0.5, maxConcurrent: 1,
    isIdle: () => queueIdle(pipeline, Date.now()), executor, sink,
  });
  local.start();
  lb.flush();
  const tasks = [0, 1, 2, 3].map(seg => snapTask({ seg, key: 'rk-idle' }));
  page.send({ type: 'task.publish', tasks });
  lb.flush();

  const settle = () => new Promise(resolve => setImmediate(resolve));
  const step = async (ms) => {
    t.mock.timers.tick(ms);
    queue.tick();
    local.tick();
    lb.flush();
    await settle();
    lb.flush();
  };
  return { playhead, claims, gates, tasks, step, settle, lb, pageInbox, local };
}

test('MC-X5-claim-before-ready：preload 没到 ready 时本机节点已开始认领细任务', async (t) => {
  const rig = await idleRig(t);
  for (let i = 0; i < 4; i += 1) await rig.step(250);
  assert.ok(rig.claims.length >= 1, `preload 在跑时也应认领；认领：${JSON.stringify(rig.claims)}`);
});

test('MC-X5-drag-no-claim：模拟拖动期间新认领 0 次，手里在做的做完；拖动停下后恢复认领', async (t) => {
  const rig = await idleRig(t);
  for (let i = 0; i < 4 && rig.gates.size === 0; i += 1) await rig.step(250);
  assert.equal(rig.gates.size, 1, `先认领到一段并开工：${JSON.stringify(rig.claims)}`);
  const [heldId] = [...rig.gates.keys()];

  // 拖动 2 秒：每 100 ms 报一次播放头
  const dragStart = Date.now();
  rig.playhead.drag(Date.now());
  let released = false;
  for (let i = 0; i < 20; i += 1) {
    rig.playhead.drag(Date.now());
    if (i === 5 && !released) { rig.gates.get(heldId)(null); released = true; }   // 手里这段在拖动中途做完
    await rig.step(100);
  }
  const during = rig.claims.filter(c => c.at > dragStart);
  assert.equal(during.length, 0, `拖动期间不该有新认领：${JSON.stringify(during)}`);
  const done = rig.pageInbox.filter(m => m.type === 'task.done').map(m => m.id);
  assert.ok(done.includes(heldId), `手里在做的那段应做完：${JSON.stringify(done)}`);

  // 停下 500 ms 之后恢复
  const stopAt = Date.now();
  for (let i = 0; i < 10; i += 1) await rig.step(100);
  assert.ok(rig.claims.some(c => c.at > stopAt), `拖动停下后应恢复认领：${JSON.stringify(rig.claims)}`);
  for (const resolve of rig.gates.values()) resolve(null);
  rig.local.stop();
});
