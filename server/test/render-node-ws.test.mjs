/**
 * 节点侧 WebSocket 端点与端点解析（契约 `docs/plan/render-queue-contract.md` G.7、G.11，用例 T1～T9）。
 * 跑：node --test server/test/render-node-ws.test.mjs
 *
 * 只照契约写，不看实现。对真文档服务（端口 0）跑；「服务端强行断开」「连不上」「换一台服务」
 * 用测试里的 TCP 代理（`fake-ws-kit.mjs` 的 createTcpProxy）做：cutAll 断开、mode = 'reject' 让新连接
 * 一接上就断、retarget 换目标。
 *
 * 重连等待按 G.7 公式、G.11「抖动乘在封顶之后」核对：第 n 次（从 0 起）等
 * `min(maxMs, baseMs × factor^n) × (1 + jitter × (2·random() − 1))`。计时器注入：
 *   manualTimers  重连计时器攒着不跑，测试手动 fire（T2、T3、T7）；
 *   fastTimers    记下请求的毫秒数，实际只等几毫秒（T4、T5、T8）。
 * 毫秒数 ≤ 0 的计时器不当作重连等待，照常马上跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocService } from '../docservice/service.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { createArtifactSink } from './fake-artifact-sink.mjs';
import {
  wsClient, byReq, byType, waitFor, sleep, randomToken, createTcpProxy, createSleepExecutor,
  snapshotTaskInput, healthServer, refusingPort,
} from './fake-ws-kit.mjs';
import { startSharedService, createProject, deviceId as newDeviceId } from './fake-shared-env.mjs';
import { buildAuthProtocols } from '../auth/client.mjs';

const BACKOFF = { baseMs: 500, factor: 2, maxMs: 15_000, jitter: 0.2 };
// M6c X3：host 的 watch 'all' 只收摘要（按扫描周期发现项目），T 系列测的是传输，节点改用 pc 照旧收全量（原为 host）
const NODE = Object.freeze({ profile: 'pc', envFingerprint: 'fp-ws-test', codeVersions: [], capabilities: {} });

const loadTransport = () => import('../render-node/ws-transport.mjs');
const loadResolver = () => import('../render-node/endpoint.mjs');

const approx = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-6, `${what}：期望 ${expected}，实际 ${actual}`);
const expectedDelay = (n, r, b = BACKOFF) => Math.min(b.maxMs, b.baseMs * b.factor ** n) * (1 + b.jitter * (2 * r - 1));

/** 起文档服务（端口 0）并挂真队列；token 给了就是令牌模式 */
async function startQueueService({ token, modules } = {}) {
  const options = { log: () => {} };
  if (token !== undefined) {
    const { createClusterAuth } = await import('../docservice/auth.mjs');
    const auth = createClusterAuth({ token, allowAnonymous: false });
    options.authenticate = auth.authenticate;
  }
  if (modules) options.modules = modules;
  const service = createDocService(options);
  const queue = createRenderQueue({ now: Date.now, send: service.send });
  service.mountRenderQueue(queue);
  const { port } = await service.listen(0, '127.0.0.1');
  return { service, queue, port, url: `ws://127.0.0.1:${port}` };
}

/** 重连计时器攒着，测试手动 fire */
function manualTimers() {
  const pending = [];
  const delays = [];
  return {
    pending,
    delays,
    setTimeout(fn, ms, ...args) {
      const h = { fn: () => fn(...args), ms, unref() { return h; }, ref() { return h; }, hasRef: () => false };
      if (!(ms > 0)) { h.real = setTimeout(h.fn, 0); return h; }
      delays.push(ms);
      pending.push(h);
      return h;
    },
    clearTimeout(h) {
      if (!h) return;
      if (h.real) clearTimeout(h.real);
      const i = pending.indexOf(h);
      if (i >= 0) pending.splice(i, 1);
    },
    async waitPending(ms = 3000) {
      await waitFor(() => pending.length > 0, ms, '重连计时器');
      return pending[0].ms;
    },
    fire() {
      const h = pending.shift();
      h.fn();
      return h.ms;
    },
  };
}

/** 记下请求的毫秒数，实际只等 realMs */
function fastTimers(realMs = 5) {
  const delays = [];
  return {
    delays,
    setTimeout(fn, ms, ...args) {
      if (ms > 0) delays.push(ms);
      return setTimeout(fn, ms > 0 ? realMs : 0, ...args);
    },
    clearTimeout: (h) => clearTimeout(h),
  };
}

/** 建端点并记下事件 */
async function endpoint(options) {
  const { createWsEndpoint } = await loadTransport();
  const ep = createWsEndpoint({ log: () => {}, ...options });
  const rec = { opens: 0, closes: [], messages: [] };
  ep.onOpen(() => { rec.opens += 1; });
  ep.onClose((info) => { rec.closes.push(info); });
  ep.onMessage((m) => { rec.messages.push(m); });
  return { ep, rec };
}

/** 本机节点接到端点上（G.7 的约定写法），并起节拍 */
function attachNode(ep, { nodeId, executor = createSleepExecutor({ taskMs: 30 }), sink = createArtifactSink(), maxConcurrent = 1, tickMs = 10 }) {
  const events = [];
  const node = createLocalNode({
    nodeId, node: NODE, endpoint: ep, now: Date.now, maxConcurrent, executor, sink,
    onEvent: (e) => events.push(e),
  });
  ep.onOpen(() => node.start(node.session.held().map(({ id, token }) => ({ id, token }))));
  if (ep.connected) node.start([]);
  const timer = setInterval(() => { try { node.tick(); } catch { /* 断线时发送失败由端点吞掉 */ } }, tickMs);
  return { node, events, executor, sink, stop() { clearInterval(timer); node.stop(); } };
}

/** 页面发布方：直连服务 */
async function publisher(url, publisherId = 'page-1') {
  const c = wsClient(url);
  await c.opened;
  c.send({ type: 'publisher.hello', reqId: 'ph', publisherId });
  await c.next(byReq('ph'));
  return c;
}

// ------------------------------------------------------------------ T1

// M6a：原来的「令牌模式」测的是「带凭证握手的端点也能连上、报到」。集群令牌退出数据面之后，改成凭共享项目的证明
// 进入（`protocols()` 每次连之前现取挑战，auth-contract 第 11 节），角色 render；principal 是这个成员身份。
for (const mode of ['anonymous', 'shared']) {
  test(`T1 对真文档服务建 createWsEndpoint（${mode === 'shared' ? '共享项目凭证' : '匿名模式'}）：onOpen 触发，local-node 收到 node.welcome`, async (t) => {
    let env;
    let options;
    if (mode === 'shared') {
      const shared = await startSharedService({ mode: 'hosted' });
      t.after(() => shared.close());
      const { projectId } = await createProject(shared.base, { password: 'pw-t1' });
      const dev = newDeviceId('t1');
      const queueOf = () => shared.service.describe().modules['render-queue'].spaces?.[projectId];
      env = { service: shared.service, url: shared.url, get queue() { return { epoch: queueOf()?.epoch }; }, projectId, dev };
      options = { url: shared.url, protocols: () => buildAuthProtocols({ base: shared.base, projectId, username: 'bob', deviceId: dev, deviceName: 'Bob', password: 'pw-t1', role: 'render' }) };
    } else {
      env = await startQueueService({});
      t.after(() => env.service.close());
      options = { url: env.url };
    }
    const { ep, rec } = await endpoint(options);
    t.after(() => ep.close());
    const n = attachNode(ep, { nodeId: `n-${mode}` });
    t.after(() => n.stop());

    await waitFor(() => rec.opens === 1, 3000, 'onOpen');
    assert.equal(ep.connected, true);
    assert.equal(ep.closed, false);
    const welcome = await waitFor(() => rec.messages.find(byType('node.welcome')), 3000, 'node.welcome');
    assert.equal(welcome.nodeId, `n-${mode}`);
    assert.equal(welcome.epoch, env.queue.epoch);
    assert.equal(n.node.session.epoch, env.queue.epoch, 'local-node 的会话收到了 welcome');
    const d = env.service.describe();
    assert.equal(d.conns.length, 1);
    assert.deepEqual(d.conns[0].roles.sort(), ['node', 'publisher'], 'local-node.start 先 publisher.hello 再 node.hello');
    if (mode === 'shared') {
      assert.deepEqual(d.conns[0].principal, {
        userId: `bob@${env.dev}`, tenantId: env.projectId, scope: 'member', username: 'bob', deviceId: env.dev, deviceName: 'Bob',
        creator: false, role: 'render', conversation: null, owner: null,
      });
    }
    const s = ep.stats();
    assert.equal(s.opens, 1);
    assert.equal(s.closes, 0);
    assert.ok(s.sent >= 2 && s.received >= 1, JSON.stringify(s));
    assert.equal(s.dropped, 0);
    assert.equal(s.badFrames, 0);
  });
}

test('T1 出口与参数：index.mjs 加出这些名字；BACKOFF_DEFAULTS；参数不合法同步抛 TypeError', async () => {
  const idx = await import('../render-node/index.mjs');
  for (const name of ['createWsEndpoint', 'BACKOFF_DEFAULTS', 'resolveDocservice', 'watchServiceEndpoints']) {
    assert.equal(name in idx, true, `index.mjs 缺 ${name}`);
  }
  const { createWsEndpoint, BACKOFF_DEFAULTS } = await loadTransport();
  assert.deepEqual({ ...BACKOFF_DEFAULTS }, BACKOFF);
  assert.throws(() => createWsEndpoint({}), TypeError);
  assert.throws(() => createWsEndpoint({ url: 'not a url' }), TypeError);
});

// ------------------------------------------------------------------ T2

test('T2 服务端断开：重连等待按 G.7 公式（固定 random），连上后清零；握手失败不算断开', async (t) => {
  const env = await startQueueService();
  t.after(() => env.service.close());
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const timers = manualTimers();
  const r = 0.75;
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => r });
  t.after(() => ep.close());
  await waitFor(() => rec.opens === 1, 3000, '首次连上');
  assert.equal(timers.pending.length, 0);

  proxy.mode = 'reject';
  proxy.cutAll();
  approx(await timers.waitPending(), expectedDelay(0, r), '第 0 次');
  await waitFor(() => rec.closes.length === 1, 2000, 'onClose');
  assert.equal(typeof rec.closes[0].code, 'number');
  assert.equal(ep.connected, false);
  timers.fire();
  approx(await timers.waitPending(), expectedDelay(1, r), '第 1 次');
  timers.fire();
  approx(await timers.waitPending(), expectedDelay(2, r), '第 2 次');
  assert.equal(rec.closes.length, 1, '握手失败不调 onClose（G.11）');
  assert.equal(ep.stats().closes, 1, '握手失败不计 closes（G.11）');

  proxy.mode = 'pass';
  timers.fire();
  await waitFor(() => rec.opens === 2, 3000, '重新连上');
  assert.equal(ep.connected, true);
  assert.equal(timers.pending.length, 0);

  proxy.cutAll();
  approx(await timers.waitPending(), expectedDelay(0, r), '连上后清零');
  await waitFor(() => rec.closes.length === 2, 2000, '第二次 onClose');
  assert.deepEqual({ opens: ep.stats().opens, closes: ep.stats().closes }, { opens: 2, closes: 2 });
});

// ------------------------------------------------------------------ T3

test('T3 断线期间 send 回 false，stats().dropped 计数正确；连上时 send 回 true、计入 sent', async (t) => {
  const env = await startQueueService();
  t.after(() => env.service.close());
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const timers = manualTimers();
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  t.after(() => ep.close());
  await waitFor(() => rec.opens === 1, 3000, '连上');

  const sent0 = ep.stats().sent;
  assert.equal(ep.send({ type: 'publisher.hello', reqId: 'x', publisherId: 'p' }), true);
  assert.equal(ep.stats().sent, sent0 + 1);
  await waitFor(() => rec.messages.find(byReq('x')), 2000, '回包');

  proxy.mode = 'reject';
  proxy.cutAll();
  await timers.waitPending();
  assert.equal(ep.connected, false);
  const before = ep.stats();
  for (let i = 0; i < 3; i++) assert.equal(ep.send({ type: 'queue.watch', projects: 'all' }), false);
  const after = ep.stats();
  assert.equal(after.dropped, before.dropped + 3);
  assert.equal(after.sent, before.sent, '丢弃的不计入 sent');

  // 重连后不重放断线期间的消息
  proxy.mode = 'pass';
  const seen = rec.messages.length;
  timers.fire();
  await waitFor(() => rec.opens === 2, 3000, '重连');
  await sleep(150);
  // 断线期间丢的是没报到就发的 queue.watch：若被重放，队列会回 error { reason: 'not-registered' }
  assert.deepEqual(rec.messages.slice(seen), [], '断线期间的消息一律丢弃，不缓存重放');
  assert.equal(ep.stats().sent, after.sent, '重连后没有补发');
});

test('T3 收到的非 JSON / 非对象的文本不交给处理器，计入 badFrames', async (t) => {
  const junk = {
    name: 'junk', types: ['junk.'],
    handle(ctx, connId, message) {
      ctx.send(connId, 42);
      ctx.send(connId, [1, 2]);
      ctx.send(connId, 'text');
      ctx.send(connId, { type: 'junk.ok', reqId: message.reqId });
    },
  };
  const env = await startQueueService({ modules: [junk] });
  t.after(() => env.service.close());
  const { ep, rec } = await endpoint({ url: env.url });
  t.after(() => ep.close());
  await waitFor(() => rec.opens === 1, 3000, '连上');
  const r0 = ep.stats().received;
  ep.send({ type: 'junk.go', reqId: 'j' });
  await waitFor(() => rec.messages.find(byReq('j')), 2000, 'junk.ok');
  await sleep(50);
  assert.deepEqual(rec.messages.filter((m) => m?.reqId === 'j').map((m) => m.type), ['junk.ok']);
  assert.ok(rec.messages.every((m) => m && typeof m === 'object' && !Array.isArray(m)), '处理器只收到对象');
  assert.equal(ep.stats().badFrames, 3);
  assert.equal(ep.stats().received, r0 + 1, 'received 只数交给处理器的消息');
});

// ------------------------------------------------------------------ T4

test('T4 节点认领后服务端强行断开（宽限期内）：重连后以 resume 接续，令牌不变，任务照常完成', { timeout: 20_000 }, async (t) => {
  const env = await startQueueService();
  t.after(() => env.service.close());
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const timers = fastTimers(20);
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  t.after(() => ep.close());
  const n = attachNode(ep, { nodeId: 'n-t4', executor: createSleepExecutor({ taskMs: 1500 }) });
  t.after(() => n.stop());
  await waitFor(() => rec.opens === 1, 3000, '连上');

  const page = await publisher(env.url);
  t.after(() => page.close());
  const task = snapshotTaskInput({ resultKey: `rk-t4-${Date.now()}` });
  page.send({ type: 'task.publish', reqId: 'pub', tasks: [task] });
  await page.next(byReq('pub'));

  const held = await waitFor(() => n.node.session.held().find((h) => h.id === task.id), 3000, '认领');
  await waitFor(() => n.executor.calls.includes(task.id), 2000, '开工');
  proxy.cutAll();
  await waitFor(() => rec.opens === 2, 3000, '重连');
  const welcomes = rec.messages.filter(byType('node.welcome'));
  await waitFor(() => rec.messages.filter(byType('node.welcome')).length === 2, 2000, '第二条 welcome');
  const w2 = rec.messages.filter(byType('node.welcome'))[1];
  assert.deepEqual(w2.resumed, [task.id], `重连后接续：${JSON.stringify(w2)}；之前 ${welcomes.length} 条 welcome`);
  assert.deepEqual(w2.lost, []);
  const heldAfter = n.node.session.held().find((h) => h.id === task.id);
  assert.ok(heldAfter, '仍持有');
  assert.equal(heldAfter.token, held.token, '令牌不变');

  const done = await page.next((m) => m.type === 'task.done' && m.id === task.id, 8000);
  assert.equal(done.resultKey, task.resultKey);
  await sleep(100);
  assert.equal(page.all.filter((m) => m.type === 'task.done' && m.id === task.id).length, 1);
  const qt = env.queue.describe().tasks.find((x) => x.id === task.id);
  assert.equal(qt.state, 'done');
  assert.equal(qt.attempts, 0, '没有被回收重做');
  assert.deepEqual(n.executor.calls, [task.id], '只渲染了一次');
});

// ------------------------------------------------------------------ T5

test('T5 换一个新的文档服务实例（新 epoch）：原持有的任务收到 lease-lost { reason: epoch }，onLost 被调', { timeout: 20_000 }, async (t) => {
  const a = await startQueueService();
  t.after(() => a.service.close());
  const b = await startQueueService();
  t.after(() => b.service.close());
  assert.notEqual(a.queue.epoch, b.queue.epoch);
  const proxy = await createTcpProxy({ target: a.port });
  t.after(() => proxy.close());
  const timers = fastTimers(20);
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  t.after(() => ep.close());
  const n = attachNode(ep, { nodeId: 'n-t5', executor: createSleepExecutor({ taskMs: 5000 }) });
  t.after(() => n.stop());
  await waitFor(() => rec.opens === 1, 3000, '连上');

  const page = await publisher(a.url);
  t.after(() => page.close());
  const task = snapshotTaskInput({ resultKey: `rk-t5-${Date.now()}` });
  page.send({ type: 'task.publish', reqId: 'pub', tasks: [task] });
  await page.next(byReq('pub'));
  await waitFor(() => n.node.session.held().some((h) => h.id === task.id), 3000, '认领');

  proxy.retarget(b.port);
  proxy.cutAll();
  await waitFor(() => rec.opens === 2, 3000, '连到新实例');
  const lost = await waitFor(() => rec.messages.find((m) => m.type === 'task.lease-lost' && m.id === task.id), 3000, 'task.lease-lost');
  assert.equal(lost.reason, 'epoch');
  assert.equal(lost.epoch, b.queue.epoch);
  await waitFor(() => n.events.some((e) => e.type === 'lost' && e.id === task.id), 2000, 'onLost');
  assert.equal(n.node.session.held().some((h) => h.id === task.id), false);
  assert.equal(n.node.session.epoch, b.queue.epoch);
});

// ------------------------------------------------------------------ T6

test('T6 resolveDocservice：环境变量地址可用 → remote；不可用、回环可用 → local；都不可用 → offline；protocol 不符记 protocol-mismatch', { timeout: 20_000 }, async (t) => {
  const { resolveDocservice } = await loadResolver();
  const good = await healthServer({ ok: true, protocol: 'promptcut.v1', service: 'promptcut-docservice' });
  const good2 = await healthServer({ ok: true, protocol: 'promptcut.v1' });
  const mismatch = await healthServer({ ok: true, protocol: 'promptcut.v0' });
  const notOk = await healthServer({ ok: false, protocol: 'promptcut.v1' });
  const hang = await healthServer(null);
  const deadServer = await refusingPort();
  const deadServer2 = await refusingPort();
  t.after(() => Promise.all([good, good2, mismatch, notOk, hang, deadServer, deadServer2].map((s) => s.close())));
  const dead = deadServer.port;
  const dead2 = deadServer2.port;
  const ws = (p, path = '') => `ws://127.0.0.1:${p}${path}`;
  // 能回响应的服务器放宽到 5000 ms：全量 npm test 时 CPU 被并行的测试文件占满，本机 /healthz 偶尔超过 1 s 才回。
  // 只有专门测超时的 hang 一项（第 8 项）单独传较短的超时。
  const run = (env, extra = {}) => resolveDocservice({ env, timeoutMs: 5000, ...extra });

  // 1. 环境变量地址可用
  const r1 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(good.port), PROMPTCUT_DOCSERVICE_PORT: String(good2.port) });
  assert.equal(r1.mode, 'remote');
  assert.equal(r1.url, ws(good.port));
  assert.equal(r1.health.ok, true);
  assert.equal(r1.tried.length, 1, '第 1 项可用就不再试');
  assert.deepEqual([r1.tried[0].url, r1.tried[0].ok], [ws(good.port), true]);

  // 2. 环境变量地址不可用、回环可用
  const r2 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(dead), PROMPTCUT_DOCSERVICE_PORT: String(good2.port) });
  assert.equal(r2.mode, 'local');
  assert.equal(r2.url, `ws://127.0.0.1:${good2.port}`);
  assert.deepEqual(r2.tried.map((x) => x.ok), [false, true]);
  assert.equal(typeof r2.tried[0].reason, 'string');

  // 3. 都不可用
  const r3 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(dead), PROMPTCUT_DOCSERVICE_PORT: String(dead2) });
  assert.equal(r3.mode, 'offline');
  assert.equal(r3.url, undefined);
  assert.deepEqual(r3.tried.map((x) => x.ok), [false, false]);

  // 4. protocol 不符 → 跳过并记 protocol-mismatch
  const r4 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(mismatch.port), PROMPTCUT_DOCSERVICE_PORT: String(good2.port) });
  assert.equal(r4.mode, 'local');
  assert.equal(r4.tried[0].ok, false);
  assert.equal(r4.tried[0].reason, 'protocol-mismatch');

  // 5. ok 不是 true → 不可用
  const r5 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(notOk.port), PROMPTCUT_DOCSERVICE_PORT: String(dead) });
  assert.equal(r5.mode, 'offline');

  // 6. 没设环境变量地址（包括空串，G.11）→ 只试回环
  for (const env of [{ PROMPTCUT_DOCSERVICE_PORT: String(good2.port) }, { PROMPTCUT_DOCSERVICE_URL: '', PROMPTCUT_DOCSERVICE_PORT: String(good2.port) }]) {
    const r = await run(env);
    assert.equal(r.mode, 'local', JSON.stringify(env));
    assert.equal(r.tried.length, 1, JSON.stringify(r.tried));
  }

  // 7. 不是 ws: / wss: → bad-url，继续试下一项（G.11）
  const r7 = await run({ PROMPTCUT_DOCSERVICE_URL: `http://127.0.0.1:${good.port}`, PROMPTCUT_DOCSERVICE_PORT: String(good2.port) });
  assert.equal(r7.mode, 'local');
  assert.deepEqual([r7.tried[0].ok, r7.tried[0].reason], [false, 'bad-url']);

  // 8. 探活超时 → 不可用，继续下一项
  // 慢的那个（hang）照旧用 1000 ms 超时、照旧要在 3 s 内判掉；只放宽「好的那个」（回环 good2）：机器忙时它的 /healthz
  // 可能超过 1 s 才回（见上面 run 的注释），所以注入的 fetch 对 good2 不传探活的 abort 信号，让它不受 1 s 限制。
  // hang 的请求原样带信号，计时只算 hang 这一次探活。
  let hangMs = null;
  const f8 = async (target, init = {}) => {
    const port = new URL(target).port;
    if (port === String(good2.port)) {
      const { signal, ...rest } = init;
      void signal;
      return globalThis.fetch(target, rest);
    }
    const s = Date.now();
    try { return await globalThis.fetch(target, init); } finally { if (port === String(hang.port)) hangMs = Date.now() - s; }
  };
  const r8 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(hang.port), PROMPTCUT_DOCSERVICE_PORT: String(good2.port) }, { timeoutMs: 1000, fetch: f8 });
  assert.deepEqual([r8.tried[0].ok, r8.tried[0].reason], [false, 'timeout'], `hang 按超时判掉：${JSON.stringify(r8.tried)}`);
  assert.equal(r8.mode, 'local', '超时后继续试下一项');
  assert.ok(hangMs !== null && hangMs < 3000, `超时要按 timeoutMs：hang 的探活用了 ${hangMs} ms`);

  // 9. /healthz 取在源站根上（G.11）
  const r9 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(good.port, '/some/path'), PROMPTCUT_DOCSERVICE_PORT: String(dead) });
  assert.equal(r9.mode, 'remote');
});

test('T6 resolveDocservice 用注入的 fetch：ws→http、wss→https，GET /healthz', async () => {
  const { resolveDocservice } = await loadResolver();
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ ok: true, protocol: 'promptcut.v1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const r = await resolveDocservice({ env: { PROMPTCUT_DOCSERVICE_URL: 'wss://docs.example.invalid:8443/ws' }, fetch, timeoutMs: 500 });
  assert.equal(r.mode, 'remote');
  assert.equal(r.url, 'wss://docs.example.invalid:8443/ws');
  assert.deepEqual(calls.map((c) => [c.url, c.method.toUpperCase()]), [['https://docs.example.invalid:8443/healthz', 'GET']]);

  calls.length = 0;
  const r2 = await resolveDocservice({ env: { PROMPTCUT_DOCSERVICE_PORT: '8799' }, fetch, timeoutMs: 500 });
  assert.equal(r2.mode, 'local');
  assert.equal(r2.url, 'ws://127.0.0.1:8799');
  assert.deepEqual(calls.map((c) => c.url), ['http://127.0.0.1:8799/healthz']);
});

test('T6 watchServiceEndpoints：已连上时立即订阅，每次 onOpen 重新订阅，收到 service.endpoints 调 onChange；stop 之后不再调', { timeout: 20_000 }, async (t) => {
  const { endpointsModule } = await import('../docservice/modules/endpoints.mjs');
  const env = await startQueueService({ modules: [endpointsModule()] });
  t.after(() => env.service.close());
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const timers = fastTimers(10);
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  t.after(() => ep.close());
  await waitFor(() => rec.opens === 1, 3000, '连上');

  const announcer = wsClient(env.url);
  t.after(() => announcer.close());
  await announcer.opened;
  announcer.send({ type: 'service.announce', announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] });
  await announcer.next(byType('service.announced'));

  const { watchServiceEndpoints } = await loadResolver();
  const changes = [];
  const stop = watchServiceEndpoints(ep, ['asset'], (list) => changes.push(list));
  await waitFor(() => changes.length === 1, 2000, '立即订阅的回包（G.11）');
  assert.deepEqual(changes[0].map((e) => e.announcerId), ['pc-1']);

  announcer.send({ type: 'service.announce', announcerId: 'host-1', kind: 'asset', urls: ['http://10.0.0.3:8790/'] });
  await waitFor(() => changes.length === 2, 2000, '变化推送');
  assert.equal(changes[1].length, 2);

  proxy.cutAll();
  await waitFor(() => rec.opens === 2, 3000, '重连');
  await waitFor(() => changes.length === 3, 2000, '重连后重新订阅');
  assert.equal(changes[2].length, 2);

  stop();
  announcer.send({ type: 'service.announce', announcerId: 'nb-1', kind: 'asset', urls: ['http://10.0.0.4:8790/'] });
  await announcer.next(byType('service.announced'));
  await sleep(150);
  assert.equal(changes.length, 3, 'stop 之后不再调 onChange');
});

// ------------------------------------------------------------------ T7

test('T7 close() 之后不再重连：connected 立即变 false，onClose 带 { code: 1000, reason: closed }', async (t) => {
  const env = await startQueueService();
  t.after(() => env.service.close());
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const timers = manualTimers();
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  await waitFor(() => rec.opens === 1, 3000, '连上');
  const accepted = proxy.accepted;

  ep.close();
  assert.equal(ep.closed, true);
  assert.equal(ep.connected, false, 'close() 之后 connected 立即为 false（G.11）');
  await waitFor(() => rec.closes.length === 1, 3000, 'onClose');
  assert.deepEqual(rec.closes[0], { code: 1000, reason: 'closed' });
  await sleep(200);
  assert.equal(timers.pending.length, 0, 'close() 之后不排重连');
  assert.equal(proxy.accepted, accepted, '没有新的连接');
  assert.equal(ep.send({ type: 'x' }), false);
  ep.close(); // 重复调用无害
});

test('T7 在退避等待中 close()：计时器到点也不再连', async (t) => {
  const env = await startQueueService();
  t.after(() => env.service.close());
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const timers = manualTimers();
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  await waitFor(() => rec.opens === 1, 3000, '连上');
  proxy.cutAll();
  await timers.waitPending();
  const accepted = proxy.accepted;
  ep.close();
  assert.equal(ep.closed, true);
  if (timers.pending.length > 0) timers.fire(); // 实现没清计时器时，到点的回调也不能再连
  await sleep(200);
  assert.equal(proxy.accepted, accepted, 'close() 之后不再重连');
  assert.equal(rec.opens, 1);
});

// ------------------------------------------------------------------ T8

test('T8 令牌错误：连续连不上时退避增长到 maxMs 封顶，opens === 0，也不算断开', { timeout: 20_000 }, async (t) => {
  const token = randomToken();
  const env = await startQueueService({ token });
  t.after(() => env.service.close());

  // random 固定 0.5：抖动为 0，封顶恰好等于 maxMs
  const timers = fastTimers(2);
  const { ep, rec } = await endpoint({ url: env.url, token: randomToken(), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  t.after(() => ep.close());
  await waitFor(() => timers.delays.length >= 9, 8000, '9 次重连等待');
  ep.close();
  assert.deepEqual(timers.delays.slice(0, 9), [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000]);
  assert.equal(ep.stats().opens, 0);
  assert.equal(rec.opens, 0);
  assert.equal(ep.stats().closes, 0, '握手失败不计 closes（G.11）');
  assert.equal(rec.closes.filter((c) => c.reason !== 'closed').length, 0, '握手失败不调 onClose（G.11）');

  // random 取上界：单次等待的上限是 maxMs × (1 + jitter)（G.11）
  const timers2 = fastTimers(2);
  const { ep: ep2 } = await endpoint({ url: env.url, token: randomToken(), setTimeout: timers2.setTimeout, clearTimeout: timers2.clearTimeout, random: () => 1 });
  t.after(() => ep2.close());
  await waitFor(() => timers2.delays.length >= 8, 8000, '8 次重连等待');
  ep2.close();
  const cap = BACKOFF.maxMs * (1 + BACKOFF.jitter);
  assert.ok(timers2.delays.every((ms) => ms <= cap + 1e-6), `超过上限：${timers2.delays}`);
  approx(timers2.delays[7], cap, '封顶后');
  approx(timers2.delays[0], 600, '第 0 次');
  assert.equal(ep2.stats().opens, 0);
});

// ------------------------------------------------------------------ T9

test('T9 两个节点经真 WebSocket（回环）抢 50 个假任务：每个任务恰好完成一次，两个节点各至少一个', { timeout: 60_000 }, async (t) => {
  const env = await startQueueService();
  t.after(() => env.service.close());
  const nodes = [];
  for (const nodeId of ['n-a', 'n-b']) {
    const { ep, rec } = await endpoint({ url: env.url });
    t.after(() => ep.close());
    const n = attachNode(ep, { nodeId, executor: createSleepExecutor({ taskMs: 20 }), maxConcurrent: 2, tickMs: 5 });
    t.after(() => n.stop());
    nodes.push({ nodeId, ep, rec, n });
  }
  await waitFor(() => nodes.every((x) => x.rec.messages.some(byType('node.welcome'))), 3000, '两个节点报到');

  const page = await publisher(env.url);
  t.after(() => page.close());
  const run = `t9-${Date.now()}`;
  const tasks = Array.from({ length: 50 }, (_, i) => snapshotTaskInput({ resultKey: `rk-${run}-${i}`, projectId: run }));
  page.send({ type: 'task.publish', reqId: 'pub', tasks });
  const published = await page.next(byReq('pub'));
  assert.equal(published.results.filter((r) => r.created).length, 50);

  const doneOf = () => page.all.filter(byType('task.done'));
  await waitFor(() => new Set(doneOf().map((m) => m.id)).size === 50, 40_000, '50 个 task.done');
  await sleep(300);
  const counts = new Map();
  for (const m of doneOf()) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
  assert.equal(counts.size, 50);
  assert.ok([...counts.values()].every((c) => c === 1), `有任务完成了不止一次：${JSON.stringify([...counts].filter(([, c]) => c > 1))}`);

  const completedBy = nodes.map((x) => x.n.events.filter((e) => e.type === 'completed' || e.type === 'dedup').map((e) => e.id));
  assert.equal(completedBy[0].length + completedBy[1].length, 50, `两节点完成数：${completedBy.map((l) => l.length)}`);
  assert.equal(new Set([...completedBy[0], ...completedBy[1]]).size, 50);
  assert.ok(completedBy[0].length >= 1 && completedBy[1].length >= 1, `每个节点至少一个：${completedBy.map((l) => l.length)}`);
  assert.ok(env.queue.describe().tasks.filter((x) => x.projectId === run).every((x) => x.state === 'done'));
  for (const x of nodes) assert.equal(x.ep.stats().badFrames, 0);
});
