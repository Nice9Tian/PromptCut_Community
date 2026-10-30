/**
 * M6b 独立渲染主机：契约测试（`docs/plan/render-host-contract.md` 第 2～4 节里能在单进程里验的行为，用例 RHC*）。
 * 跑：node --test server/test/render-host-contract.test.mjs
 *
 * 只照契约写，不看实现。主机本身的接口（配置解析、多项目编排、诊断）是测试方的假设，集中在
 * `render-host-kit.mjs` 文件头；节点会话、队列、文档服务、鉴权用的是 M5 / M6a 已有的公共接口。
 *
 * 分组：
 *   RHC1～RHC4    配置解析（第 2 节）
 *   RHC5～RHC8    节点侧过滤：plan 跳过、代码版本（第 3、4 节），内存传输 + 真队列
 *   RHC9～RHC10   队列侧：本空间任何成员的细任务可认领；没有凭证握手 401、收到本项目消息 0 条（H3）
 *   RHC11～RHC19  主机编排：多项目多连接、node.hello 字段、并发上限、plan 跳过、H2、H3、退出让掉认领、诊断
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createNodeSession, createLocalNode, checkClaimable } from '../render-node/index.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { createFakeClock, makeTaskInput } from './fake-render-queue-env.mjs';
import { rawHandshake } from './fake-ws-kit.mjs';
import {
  CODE_VERSION, FINGERPRINT, PROTOCOL,
  loadHostModule, withMaxConcurrent, startHost, createGateExecutor, createFakeSink,
  sharedService, hostEntry, member, publishAs, ask, queueOf, claimedCount, statesOf, fineTask,
  recordWebSocket, waitFor, sleep, wsClient,
} from './render-host-kit.mjs';

const TENANT = 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOST_NODE = Object.freeze({
  profile: 'host',
  envFingerprint: FINGERPRINT,
  capabilities: { userCards: true, graphCards: false },
  codeVersions: [CODE_VERSION],
});
const PC_NODE = Object.freeze({ ...HOST_NODE, profile: 'pc' });

const baseEntry = (over = {}) => ({
  url: 'ws://127.0.0.1:8787',
  projectId: 'sp_bbbbbbbbbbbbbbbbbbbbbbbbbb',
  username: 'rig',
  deviceId: 'render-host-device-0001',
  deviceName: 'RenderHost',
  as: 'member',
  password: 'secret-host-pw',
  role: 'render',
  ...over,
});

const isConfigError = (err) => /^bad-(host|shared)-config$/.test(String(err?.code));

// ================================================================== 配置解析（第 2 节）

test('RHC1 配置解析：单个对象 → 一项；maxConcurrent 缺省 1；字段照给的保留', async () => {
  const { parseHostConfig } = await loadHostModule();
  const raw = baseEntry();
  const r = parseHostConfig(raw);
  assert.equal(r.entries.length, 1);
  assert.equal(r.maxConcurrent, 1, 'maxConcurrent 缺省 1');
  const [e] = r.entries;
  for (const k of ['url', 'projectId', 'username', 'deviceId', 'deviceName', 'as', 'role']) assert.equal(e[k], raw[k], `字段 ${k}`);
  assert.equal(e.role, 'render');
  // 用 key（已派生的 K）代替口令也行
  const withKey = parseHostConfig(baseEntry({ password: undefined, key: 'A'.repeat(43) }));
  assert.equal(withKey.entries.length, 1);
  // 单个对象上给 maxConcurrent
  assert.equal(parseHostConfig(baseEntry({ maxConcurrent: 3 })).maxConcurrent, 3);
});

test('RHC2 配置解析：数组 → 按顺序每项一条；maxConcurrent 给在一项上即全局值', async () => {
  const { parseHostConfig } = await loadHostModule();
  const a = baseEntry({ projectId: 'sp_cccccccccccccccccccccccccc' });
  const b = baseEntry({ projectId: 'sp_dddddddddddddddddddddddddd', url: 'ws://10.0.0.2:5190/docservice', username: 'rig2' });
  const r = parseHostConfig([a, b]);
  assert.deepEqual(r.entries.map((e) => e.projectId), [a.projectId, b.projectId]);
  assert.deepEqual(r.entries.map((e) => e.url), [a.url, b.url]);
  assert.equal(r.maxConcurrent, 1);
  assert.equal(parseHostConfig(withMaxConcurrent([a, b], 2)).maxConcurrent, 2);
  assert.equal(parseHostConfig(withMaxConcurrent([a, b], 4)).maxConcurrent, 4, '上限 4 本身可以');
});

test('RHC3 配置解析：缺字段、空数组、角色不是 render、maxConcurrent 超上限 → 报错；错误里不带口令', async () => {
  const { parseHostConfig } = await loadHostModule();
  const secret = 'secret-host-pw';
  const cases = {
    '缺 url': baseEntry({ url: undefined }),
    'url 不是 ws': baseEntry({ url: 'http://127.0.0.1:8787' }),
    '缺 projectId': baseEntry({ projectId: undefined }),
    '缺 username': baseEntry({ username: undefined }),
    'password 与 key 都缺': baseEntry({ password: undefined }),
    'role 不是 render': baseEntry({ role: 'page' }),
    '不是对象': 'not-an-object',
    '数组里有一项缺字段': [baseEntry(), baseEntry({ url: undefined })],
    '空数组': [],
  };
  for (const [what, raw] of Object.entries(cases)) {
    assert.throws(() => parseHostConfig(raw), (err) => {
      assert.ok(isConfigError(err), `${what}：错误码应是 bad-host-config / bad-shared-config，实际 ${err?.code} ${err?.message}`);
      assert.ok(!String(err.message).includes(secret) && !String(err.stack ?? '').includes(secret), `${what}：错误信息里不该有口令`);
      return true;
    }, what);
  }
  // 上限 4：超出要么报错、要么压到 4，不能照收
  for (const over of [5, 64]) {
    let got;
    try {
      got = parseHostConfig(baseEntry({ maxConcurrent: over })).maxConcurrent;
    } catch (err) {
      assert.ok(isConfigError(err), `maxConcurrent ${over}：报错时错误码应是配置错误，实际 ${err?.code}`);
      continue;
    }
    assert.ok(got <= 4 && got >= 1, `maxConcurrent ${over} 不能照收：得到 ${got}`);
  }
  for (const bad of [0, -1, 1.5, '2']) {
    assert.throws(() => parseHostConfig(baseEntry({ maxConcurrent: bad })), isConfigError, `maxConcurrent ${JSON.stringify(bad)} 应报错`);
  }
});

test('RHC4 配置文件：loadHostConfig 读数组文件；文件不存在、不是 JSON 报错', async (t) => {
  const { loadHostConfig } = await loadHostModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-host-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'host.json');
  const a = baseEntry({ projectId: 'sp_cccccccccccccccccccccccccc' });
  const b = baseEntry({ projectId: 'sp_dddddddddddddddddddddddddd' });
  fs.writeFileSync(file, JSON.stringify(withMaxConcurrent([a, b], 2)));
  const r = await loadHostConfig(file);
  assert.deepEqual(r.entries.map((e) => e.projectId), [a.projectId, b.projectId]);
  assert.equal(r.maxConcurrent, 2);
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ not json');
  for (const f of [path.join(dir, 'missing.json'), broken]) {
    await assert.rejects(async () => loadHostConfig(f), isConfigError, f);
  }
});

// ================================================================== 节点侧过滤（第 3、4 节）

/**
 * 真队列 + 内存传输：一个发布方、若干节点会话。节点认领到就立即完成。
 * 回 { lb, q, publish, addNode, run, claimsOf }。
 */
function inprocQueue() {
  const clock = createFakeClock();
  const lb = createLoopback();
  const q = createRenderQueue({ now: clock.now, send: lb.queueSend });
  lb.attach(q);
  const pub = lb.connect('pub', { userId: 'alice@dev-alice-0001', tenantId: TENANT });
  pub.send({ type: 'publisher.hello', publisherId: 'P-alice' });
  lb.flush();
  const claims = new Map();
  const sessions = [];
  let reqSeq = 0;
  return {
    lb, q, clock,
    publish(tasks) {
      const reqId = `pub-${++reqSeq}`;
      let reply = null;
      pub.onMessage((m) => { if (m.reqId === reqId) reply = m; });
      pub.send({ type: 'task.publish', tasks, reqId });
      lb.flush();
      assert.equal(reply?.type, 'task.published', `发布回包：${JSON.stringify(reply)}`);
      for (const r of reply.results ?? []) assert.equal(r.error ?? null, null, `发布失败：${JSON.stringify(r)}`);
    },
    addNode(connId, nodeId, node, { userId = `${connId}@dev-${connId}-0001`, complete = true, maxConcurrent = 1 } = {}) {
      const ep = lb.connect(connId, { userId, tenantId: TENANT });
      const mine = [];
      claims.set(nodeId, mine);
      const session = createNodeSession({
        nodeId, node, now: clock.now, maxConcurrent,
        send: (m) => { if (m.type === 'task.claim') mine.push(m.id); ep.send(m); },
        onTask: (task) => { if (complete) queueMicrotask(() => { session.complete(task.id, { ranges: [[task.range?.from ?? 0, task.range?.to ?? 0]] }); lb.flush(); }); },
      });
      ep.onMessage((m) => session.receive(m));
      session.start();
      lb.flush();
      sessions.push(session);
      return session;
    },
    async run(rounds = 30) {
      for (let i = 0; i < rounds; i++) {
        for (const s of sessions) s.tick();
        lb.flush();
        await Promise.resolve();
        lb.flush();
      }
      assert.deepEqual(lb.errors(), [], '处理器不该抛错');
    },
    claimsOf: (nodeId) => claims.get(nodeId) ?? [],
    state: (id) => q.describe().tasks.find((x) => x.id === id)?.state ?? null,
  };
}

const planTask = (rev = 1) => makeTaskInput({ kind: 'plan', projectId: 'demo', projectRev: rev, requires: { codeVersion: CODE_VERSION } });
const snapTask = (from, codeVersion = CODE_VERSION) => makeTaskInput({
  kind: 'snapshot', projectId: 'demo', projectRev: 1, range: [from, from + 29], resultKey: 'rk-demo-1',
  requires: { codeVersion, envFingerprint: FINGERPRINT }, weight: { class: 'light', estMs: null, frames: 30 },
});

test('RHC5 过滤：profile host 的节点对 plan 任务判为不可认领；pc 节点可以；host 对细任务照常可以', () => {
  const plan = planTask();
  assert.equal(checkClaimable(plan, HOST_NODE).ok, false, `host 不认领 plan：${JSON.stringify(checkClaimable(plan, HOST_NODE))}`);
  assert.equal(checkClaimable(plan, PC_NODE).ok, true, '对照：pc 节点认领 plan');
  assert.equal(checkClaimable(snapTask(0), HOST_NODE).ok, true, 'host 认领 snapshot 细任务');
});

test('RHC6 队列 + 节点会话（内存传输）：host 节点收到 plan 不发认领、只认领细任务；plan 留给 pc 节点', async () => {
  const env = inprocQueue();
  const plan = planTask();
  const snaps = [snapTask(0), snapTask(30), snapTask(60)];
  env.publish([plan, ...snaps]);
  env.addNode('host', 'node-host', HOST_NODE);
  await env.run(40);
  const claims = env.claimsOf('node-host');
  assert.ok(!claims.includes(plan.id), `host 不该对 plan 发 task.claim：${JSON.stringify(claims)}`);
  assert.deepEqual([...new Set(claims)].sort(), snaps.map((x) => x.id).sort(), 'host 认领了全部细任务');
  for (const s of snaps) assert.equal(env.state(s.id), 'done', s.id);
  assert.equal(env.state(plan.id), 'open', 'plan 仍然 open');

  // 只有 plan 的队列：再多拍也 0 条认领
  const only = inprocQueue();
  only.publish([planTask(2)]);
  only.addNode('host', 'node-host', HOST_NODE);
  await only.run(40);
  assert.deepEqual(only.claimsOf('node-host'), [], 'host 对 plan 0 次认领');

  // 对照：pc 节点认领这个 plan
  env.addNode('pc', 'node-pc', PC_NODE, { complete: false });
  await env.run(5);
  assert.deepEqual(env.claimsOf('node-pc'), [plan.id], 'pc 节点认领 plan');
  assert.equal(env.state(plan.id), 'claimed');
});

test('RHC7 本机节点编排（createLocalNode，内存传输）：profile host 时 executor.plan 从不被调用，细任务照常完成', async () => {
  const clock = createFakeClock();
  const lb = createLoopback();
  const q = createRenderQueue({ now: clock.now, send: lb.queueSend });
  lb.attach(q);
  const pub = lb.connect('pub', { userId: 'alice@dev-alice-0001', tenantId: TENANT });
  pub.send({ type: 'publisher.hello', publisherId: 'P-alice' });
  const plan = planTask();
  const snap = snapTask(0);
  pub.send({ type: 'task.publish', tasks: [plan, snap], reqId: 'p1' });
  lb.flush();
  const ep = lb.connect('host', { userId: 'rig@dev-rig-0001', tenantId: TENANT });
  const sent = [];
  const endpoint = { send: (m) => { sent.push(m); ep.send(m); }, onMessage: (h) => ep.onMessage(h) };
  let planCalls = 0;
  const node = createLocalNode({
    nodeId: 'host-local', node: HOST_NODE, endpoint, now: clock.now, codeVersion: CODE_VERSION,
    executor: { plan: async () => { planCalls += 1; return { entryKey: 'x', cardPlan: [] }; }, render: async () => ({}) },
    sink: createFakeSink(),
  });
  node.start();
  lb.flush();
  for (let i = 0; i < 40; i++) {
    node.tick();
    lb.flush();
    await sleep(0);
    lb.flush();
  }
  await node.settled();
  lb.flush();
  node.stop();
  assert.equal(planCalls, 0, 'executor.plan 不该被调用');
  assert.ok(!sent.some((m) => m.type === 'task.claim' && m.id === plan.id), '不对 plan 发认领');
  assert.equal(q.describe().tasks.find((x) => x.id === snap.id)?.state, 'done', '细任务完成');
  assert.equal(q.describe().tasks.find((x) => x.id === plan.id)?.state, 'open', 'plan 仍 open');
});

test('RHC8 过滤：requires.codeVersion 不在 codeVersions 里的任务 0 次认领；版本相同的照常认领', async () => {
  const env = inprocQueue();
  const other = [snapTask(0, 'cv-other-version'), snapTask(30, 'cv-other-version')];
  env.publish(other);
  env.addNode('host', 'node-host', HOST_NODE);
  await env.run(40);
  assert.deepEqual(env.claimsOf('node-host'), [], `代码版本不同：0 次认领，实际 ${JSON.stringify(env.claimsOf('node-host'))}`);
  for (const x of other) assert.equal(env.state(x.id), 'open');
  const same = snapTask(90);
  env.publish([same]);
  await env.run(10);
  assert.deepEqual(env.claimsOf('node-host'), [same.id], '对照：同版本的认领');
});

// ================================================================== 队列侧（第 4 节，经真文档服务）

test('RHC9 队列侧：render 连接以 profile host 报到，能认领本空间里任何成员发布的细任务；别的项目的 host 认领不到', async (t) => {
  const { s, projects: [P, Q] } = await sharedService(t, { projects: 2 });
  const fromBob = fineTask({ tag: `bob-${Date.now()}` });
  const fromCarol = fineTask({ tag: `carol-${Date.now()}` });
  const bob = await publishAs(s, P, 'bob', [fromBob]);
  const carol = await publishAs(s, P, 'carol', [fromCarol]);
  t.after(() => { bob.conn.close(); carol.conn.close(); });

  const host = await member(s, P, { username: 'rig', role: 'render' });
  t.after(() => host.close());
  const hello = await ask(host, { type: 'node.hello', nodeId: 'rhc9-host', ...HOST_NODE, maxConcurrent: 2 }, 'node.welcome');
  assert.equal(hello.type, 'node.welcome', JSON.stringify(hello));
  for (const task of [fromBob, fromCarol]) {
    const r = await ask(host, { type: 'task.claim', id: task.id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
    assert.equal(r.type, 'task.claimed', `${task.id}：${JSON.stringify(r)}`);
  }
  const claimed = queueOf(s, P.projectId).tasks.filter((x) => x.state === 'claimed').map((x) => x.claim?.nodeId);
  assert.deepEqual(claimed, ['rhc9-host', 'rhc9-host']);

  const other = await member(s, Q, { username: 'rig', role: 'render' });
  t.after(() => other.close());
  await ask(other, { type: 'node.hello', nodeId: 'rhc9-other', ...HOST_NODE }, 'node.welcome');
  const task = fineTask({ tag: `bob2-${Date.now()}` });
  await publishAs(s, P, 'bob2', [task]).then((x) => t.after(() => x.conn.close()));
  const r = await ask(other, { type: 'task.claim', id: task.id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(r.type, 'task.claim-rejected', `别的项目的 host 认领不到：${JSON.stringify(r)}`);
});

test('RHC10 H3：没有项目凭证的连接握手 401、收到本项目消息 0 条；口令错同样 401；别的项目的成员收到 0 条', async (t) => {
  const { s, projects: [P, Q] } = await sharedService(t, { projects: 2 });
  // 只带 promptcut.v1（非回环来源）：401
  const bare = await rawHandshake(s.port, { protocols: [PROTOCOL], path: '/' });
  bare.sock.destroy();
  assert.equal(bare.status, 401, '不带凭证 401');
  // 什么都不带：401
  const none = await rawHandshake(s.port, { path: '/' });
  none.sock.destroy();
  assert.equal(none.status, 401, '什么都不带 401');

  // 口令错：401（经 client.mjs 拼证明）
  const { buildAuthProtocols } = await import('../auth/client.mjs');
  const wrong = await buildAuthProtocols({
    base: s.base, projectId: P.projectId, username: 'rig', deviceId: 'render-host-device-0009', deviceName: 'RH', as: 'member', password: 'wrong-pw', role: 'render',
  });
  const wr = await rawHandshake(s.port, { protocols: wrong, path: '/' });
  wr.sock.destroy();
  assert.equal(wr.status, 401, '口令错 401');

  // 连不上的客户端与别的项目的成员，在本项目发布、认领、完成的全过程里收到 0 条本项目的消息
  const outsider = wsClient(s.url, [PROTOCOL]);
  await assert.rejects(outsider.opened, '不带凭证的连接打不开');
  const q = await member(s, Q, { username: 'quinn', role: 'render' });
  t.after(() => q.close());
  await ask(q, { type: 'node.hello', nodeId: 'rhc10-q', ...HOST_NODE }, 'node.welcome');
  await ask(q, { type: 'queue.watch', projects: 'all' }, 'queue.snapshot');
  const qBefore = q.all.length;
  const task = fineTask({ tag: `h3-${Date.now()}` });
  const pub = await publishAs(s, P, 'bob', [task]);
  t.after(() => pub.conn.close());
  const node = await member(s, P, { username: 'rig', role: 'render' });
  t.after(() => node.close());
  await ask(node, { type: 'node.hello', nodeId: 'rhc10-p', ...HOST_NODE }, 'node.welcome');
  const c = await ask(node, { type: 'task.claim', id: task.id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(c.type, 'task.claimed', JSON.stringify(c));
  await sleep(200);
  assert.equal(outsider.all.length, 0, `没凭证的连接收到 0 条：${JSON.stringify(outsider.all)}`);
  const leaked = q.all.slice(qBefore).filter((m) => JSON.stringify(m).includes(task.id) || JSON.stringify(m).includes(P.projectId));
  assert.deepEqual(leaked, [], '别的项目的成员收到 0 条本项目的消息');
});

// ================================================================== 主机编排（第 2、3 节）

test('RHC11 多项目：两份配置 → 两条 render 连接、每条各一次 node.hello，各在各的空间；local 空间没有主机节点', async (t) => {
  const { s, projects: [P, Q] } = await sharedService(t, { projects: 2 });
  const rec = recordWebSocket(t);
  const executor = createGateExecutor({ autoMs: 5 });
  await startHost(t, { entries: [hostEntry(s, P), hostEntry(s, Q)], executor });

  for (const proj of [P, Q]) {
    await waitFor(() => queueOf(s, proj.projectId).nodes.some((n) => n.connected), 10000, `${proj.projectId} 的主机节点报到`);
  }
  await sleep(200);
  const renderSockets = rec.sockets.filter((x) => x.proof?.r === 'render');
  assert.deepEqual(renderSockets.map((x) => x.proof.p).sort(), [P.projectId, Q.projectId].sort(), '每个项目一条 render 连接');
  for (const proj of [P, Q]) {
    const hellos = rec.sentBy('render').filter((x) => x.projectId === proj.projectId && x.message.type === 'node.hello');
    assert.equal(hellos.length, 1, `${proj.projectId}：恰好一次 node.hello`);
    const nodes = queueOf(s, proj.projectId).nodes.filter((n) => n.connected);
    assert.equal(nodes.length, 1, `${proj.projectId} 的空间里恰好一个节点：${JSON.stringify(nodes)}`);
    assert.equal(nodes[0].profile, 'host');
  }
  const [nP] = queueOf(s, P.projectId).nodes;
  const [nQ] = queueOf(s, Q.projectId).nodes;
  assert.notEqual(nP.nodeId, nQ.nodeId, '两个节点身份不同');
  const local = s.service.describe().modules['render-queue'];
  assert.ok(!(local.nodes ?? []).some((n) => n.profile === 'host' && n.connected), 'local 空间里没有主机节点');
});

test('RHC12 node.hello：profile host、capabilities { userCards: true, graphCards: false }、codeVersions 只有本机 frameCode、envFingerprint 照给的', async (t) => {
  const { s, projects: [P] } = await sharedService(t);
  const rec = recordWebSocket(t);
  const { logs } = await startHost(t, { entries: [hostEntry(s, P)], executor: createGateExecutor({ autoMs: 5 }), codeVersion: 'cv-rhc12', envFingerprint: 'fp-rhc12' });
  // 「最终会发出 node.hello」：按 20 s 截止时间等（并行跑几份 npm test 时这里曾 10 s 没等到，原因未明），
  // 等不到时把主机与连接层的日志带进报错。发出的 hello 内容的断言不变。
  const hello = await waitFor(() => rec.sentBy('render').find((x) => x.message.type === 'node.hello')?.message, 20_000, 'node.hello')
    .catch((err) => { throw new Error(`${err.message}；主机日志：${JSON.stringify(logs).slice(0, 3000)}；已记录的连接：${JSON.stringify(rec.sockets.map((x) => ({ url: x.url, r: x.proof?.r, sent: x.sent.length })))}`); });
  assert.equal(hello.profile, 'host');
  assert.deepEqual(hello.capabilities, { userCards: true, graphCards: false });
  assert.deepEqual(hello.codeVersions, ['cv-rhc12']);
  assert.equal(hello.envFingerprint, 'fp-rhc12');
  // 主机不替任何页面发布 plan
  await sleep(200);
  const plans = rec.sentBy('render').filter((x) => x.message.type === 'task.publish');
  assert.deepEqual(plans, [], '主机不发布任务');
});

test('RHC13 多项目：每个项目的细任务（来自不同成员）都由主机完成，各记在各的空间，诊断按项目分开计数', async (t) => {
  const { s, projects: [P, Q] } = await sharedService(t, { projects: 2 });
  const tag = Date.now();
  const pTasks = [fineTask({ tag: `p1-${tag}` }), fineTask({ tag: `p2-${tag}` })];
  const qTasks = [fineTask({ tag: `q1-${tag}` }), fineTask({ tag: `q2-${tag}` }), fineTask({ tag: `q3-${tag}` })];
  for (const [proj, who, tasks] of [[P, 'bob', [pTasks[0]]], [P, 'carol', [pTasks[1]]], [Q, 'dave', qTasks]]) {
    const r = await publishAs(s, proj, who, tasks);
    t.after(() => r.conn.close());
  }
  const sinks = new Map();
  const executor = createGateExecutor({ autoMs: 5 });
  const { host } = await startHost(t, {
    entries: [hostEntry(s, P), hostEntry(s, Q)], executor, maxConcurrent: 2,
    sinkFor: ({ projectId }) => { const sk = createFakeSink(); sinks.set(projectId, sk); return sk; },
  });
  await waitFor(() => statesOf(s, P.projectId).done === 2 && statesOf(s, Q.projectId).done === 3, 15000, '五个任务全部完成');
  assert.deepEqual(statesOf(s, P.projectId), { done: 2 });
  assert.deepEqual(statesOf(s, Q.projectId), { done: 3 });
  assert.deepEqual([...sinks.keys()].sort(), [P.projectId, Q.projectId].sort(), '每个项目一个产物库');
  assert.deepEqual(sinks.get(P.projectId).puts.sort(), pTasks.map((x) => x.id).sort(), 'P 的产物推到 P 的产物库');
  assert.deepEqual(sinks.get(Q.projectId).puts.sort(), qTasks.map((x) => x.id).sort(), 'Q 的产物推到 Q 的产物库');
  const d = host.describe();
  const byProject = Object.fromEntries(d.nodes.map((n) => [n.projectId, n]));
  assert.equal(byProject[P.projectId]?.completed, 2);
  assert.equal(byProject[Q.projectId]?.completed, 3);
  assert.equal(byProject[P.projectId]?.claimed, 2);
  assert.equal(byProject[Q.projectId]?.claimed, 3);
});

/** 跑一轮并发实验：边放行边采样；回 { maxClaimed, maxRunning } */
async function concurrencyRun(t, { maxConcurrent, perProject = 4 }) {
  const { s, projects } = await sharedService(t, { projects: 2 });
  const tag = Date.now();
  for (const [i, proj] of projects.entries()) {
    const tasks = Array.from({ length: perProject }, (_, k) => fineTask({ tag: `c${i}-${k}-${tag}` }));
    const r = await publishAs(s, proj, `pub${i}`, tasks);
    t.after(() => r.conn.close());
  }
  const executor = createGateExecutor();
  await startHost(t, { entries: projects.map((p) => hostEntry(s, p)), executor, maxConcurrent });
  const ids = projects.map((p) => p.projectId);
  const limit = maxConcurrent ?? 1;
  const total = perProject * projects.length;
  let maxClaimed = 0;
  const doneCount = () => ids.reduce((n, pid) => n + (statesOf(s, pid).done ?? 0), 0);
  const until = Date.now() + 30000;
  while (doneCount() < total) {
    assert.ok(Date.now() < until, `并发实验超时：${JSON.stringify(ids.map((pid) => statesOf(s, pid)))}`);
    maxClaimed = Math.max(maxClaimed, claimedCount(s, ids));
    // 等所有空位都被占上（或者没有剩余任务）再放行一个，这样上限若被突破一定会被采样到
    const open = ids.reduce((n, pid) => n + (statesOf(s, pid).open ?? 0), 0);
    if (executor.waiting.length >= limit || (open === 0 && executor.waiting.length > 0)) {
      await sleep(60);
      maxClaimed = Math.max(maxClaimed, claimedCount(s, ids));
      executor.releaseOne();
    }
    await sleep(5);
  }
  return { maxClaimed, maxRunning: executor.stats.maxRunning };
}

test('RHC14 并发上限：两个项目、maxConcurrent 2 → 所有节点合计同时持有的认领 ≤ 2，且空位会被用上', async (t) => {
  const { maxClaimed, maxRunning } = await concurrencyRun(t, { maxConcurrent: 2 });
  assert.ok(maxClaimed <= 2, `合计同时持有 ${maxClaimed} > 2`);
  assert.ok(maxRunning <= 2, `执行器同时在跑 ${maxRunning} > 2`);
  assert.equal(maxRunning, 2, '有空位就认领：应当用满 2 个');
});

test('RHC15 并发上限：不给 maxConcurrent（缺省 1）→ 两个项目合计同时只持有 1 个认领', async (t) => {
  const { maxClaimed, maxRunning } = await concurrencyRun(t, { maxConcurrent: undefined, perProject: 3 });
  assert.ok(maxClaimed <= 1, `合计同时持有 ${maxClaimed} > 1`);
  assert.equal(maxRunning, 1);
});

test('RHC16 主机不认领 plan：同一项目里有 plan 与细任务，主机只完成细任务，plan 仍 open，executor.plan 0 次', async (t) => {
  const { s, projects: [P] } = await sharedService(t);
  const tag = Date.now();
  const plan = {
    id: `plan:demo@${tag}`, kind: 'plan', resultKey: `demo@${tag}`, range: null,
    source: { projectId: 'demo', projectRev: tag }, input: {}, weight: { class: 'light', estMs: null, frames: null },
    requires: { codeVersion: CODE_VERSION }, priority: 0,
  };
  const snap = fineTask({ tag: `s-${tag}` });
  const r = await publishAs(s, P, 'bob', [plan, snap]);
  t.after(() => r.conn.close());
  const executor = createGateExecutor({ autoMs: 5 });
  await startHost(t, { entries: [hostEntry(s, P)], executor });
  await waitFor(() => queueOf(s, P.projectId).tasks.find((x) => x.id === snap.id)?.state === 'done', 10000, '细任务完成');
  await sleep(300);
  assert.equal(queueOf(s, P.projectId).tasks.find((x) => x.id === plan.id)?.state, 'open', 'plan 仍 open');
  assert.equal(executor.stats.planCalls, 0);
});

test('RHC17 H2：主机的代码版本不在任务的 requires.codeVersion 上 → 0 次认领，诊断 claimed = 0', async (t) => {
  const { s, projects: [P] } = await sharedService(t);
  const tag = Date.now();
  const tasks = [fineTask({ tag: `h2a-${tag}` }), fineTask({ tag: `h2b-${tag}` })];
  const r = await publishAs(s, P, 'bob', tasks);
  t.after(() => r.conn.close());
  const executor = createGateExecutor({ autoMs: 5 });
  const { host } = await startHost(t, { entries: [hostEntry(s, P)], executor, codeVersion: 'cv-some-other-build' });
  await waitFor(() => queueOf(s, P.projectId).nodes.some((n) => n.connected), 10000, '主机节点报到');
  await sleep(600);
  assert.deepEqual(statesOf(s, P.projectId), { open: 2 }, '任务都还 open');
  assert.equal(executor.stats.rendered.length, 0);
  const [n] = host.describe().nodes;
  assert.equal(n.projectId, P.projectId);
  assert.equal(n.connected, true);
  assert.equal(n.claimed, 0);
});

test('RHC18 H3：口令错的主机实例连不上（握手 401），claimed = 0，空间里没有它的节点', async (t) => {
  const { s, projects: [P] } = await sharedService(t);
  const task = fineTask({ tag: `h3h-${Date.now()}` });
  const r = await publishAs(s, P, 'bob', [task]);
  t.after(() => r.conn.close());
  const executor = createGateExecutor({ autoMs: 5 });
  const { host } = await startHost(t, { entries: [hostEntry(s, P, { password: 'not-the-project-pw' })], executor });
  await sleep(800);
  const [n] = host.describe().nodes;
  assert.equal(n.projectId, P.projectId);
  assert.equal(n.connected, false);
  assert.equal(n.claimed, 0);
  assert.equal(executor.stats.rendered.length, 0);
  assert.deepEqual(queueOf(s, P.projectId).nodes.filter((x) => x.connected), [], '空间里没有已连上的节点');
  assert.deepEqual(statesOf(s, P.projectId), { open: 1 });
  assert.ok(s.logs.some((l) => l.event === 'auth.reject'), '服务端记了 auth.reject');
});

test('RHC19 退出：stop() 让掉手里的认领（不等租约过期，任务立即回到 open、别的节点能认领），连接关掉', async (t) => {
  const { s, projects: [P, Q] } = await sharedService(t, { projects: 2 });
  const tag = Date.now();
  const pt = fineTask({ tag: `stop-p-${tag}` });
  const qt = fineTask({ tag: `stop-q-${tag}` });
  for (const [proj, task] of [[P, pt], [Q, qt]]) {
    const r = await publishAs(s, proj, 'bob', [task]);
    t.after(() => r.conn.close());
  }
  const executor = createGateExecutor();
  const { stop } = await startHost(t, { entries: [hostEntry(s, P), hostEntry(s, Q)], executor, maxConcurrent: 2 });
  await waitFor(() => claimedCount(s, [P.projectId, Q.projectId]) === 2 && executor.waiting.length === 2, 10000, '主机持有两个认领');
  await stop();
  // 文档服务 autoTick 关着：租约不会过期，任务回到 open 只能是主机让掉的（或断开时队列回收的）
  await waitFor(() => statesOf(s, P.projectId).open === 1 && statesOf(s, Q.projectId).open === 1, 3000, '两个任务回到 open');
  await waitFor(() => [P, Q].every((p) => !queueOf(s, p.projectId).nodes.some((n) => n.connected)), 3000, '主机的连接都关了');
  assert.equal(executor.waiting.length, 0, '执行器里挂着的工作被中止');
  const other = await member(s, P, { username: 'rig2', role: 'render' });
  t.after(() => other.close());
  await ask(other, { type: 'node.hello', nodeId: 'rhc19-other', ...HOST_NODE }, 'node.welcome');
  const c = await ask(other, { type: 'task.claim', id: pt.id, expectVersion: queueOf(s, P.projectId).tasks.find((x) => x.id === pt.id).version }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(c.type, 'task.claimed', `别的节点能认领：${JSON.stringify(c)}`);
});

test('RHC20 诊断：describe() 形状 { nodes: [{ projectId, connected, claimed, completed, dedup, failed, lost }], codeVersion, envFingerprint, maxConcurrent }；去重完成计入 dedup', async (t) => {
  const { s, projects: [P] } = await sharedService(t);
  const tag = Date.now();
  const fresh = fineTask({ tag: `fresh-${tag}` });
  const dup = fineTask({ tag: `dup-${tag}` });
  const r = await publishAs(s, P, 'bob', [fresh, dup]);
  t.after(() => r.conn.close());
  const executor = createGateExecutor({ autoMs: 5 });
  const { host } = await startHost(t, {
    entries: [hostEntry(s, P)], executor, maxConcurrent: 3, codeVersion: CODE_VERSION, envFingerprint: FINGERPRINT,
    sinkFor: () => createFakeSink({ dedupKeys: new Set([dup.resultKey]) }),
  });
  await waitFor(() => statesOf(s, P.projectId).done === 2, 10000, '两个任务完成');
  const d = host.describe();
  assert.equal(d.codeVersion, CODE_VERSION);
  assert.equal(d.envFingerprint, FINGERPRINT);
  assert.equal(d.maxConcurrent, 3);
  assert.equal(d.nodes.length, 1);
  const [n] = d.nodes;
  for (const k of ['projectId', 'connected', 'claimed', 'completed', 'dedup', 'failed', 'lost']) assert.ok(k in n, `nodes[0] 缺 ${k}`);
  assert.equal(n.projectId, P.projectId);
  assert.equal(n.connected, true);
  assert.equal(n.claimed, 2);
  assert.equal(n.dedup, 1, '去重完成 1 个');
  assert.equal(n.completed + n.dedup >= 2, true, `完成计数：${JSON.stringify(n)}`);
  assert.equal(n.failed, 0);
  assert.equal(n.lost, 0);
  assert.deepEqual(executor.stats.rendered, [fresh.id], '去重的任务不渲染');
  // 诊断能过 JSON（HTTP 诊断口原样回它）
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
});
