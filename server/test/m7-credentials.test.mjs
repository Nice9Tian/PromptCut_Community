/**
 * M7-T：凭证一侧。D9（profile 与 nodeId 绑到凭证，自报不作数）、D10（环境指纹由服务端按原始值算）、D14（非 Chromium 不当节点）。
 * 依据：`docs/plan/m7-contract.md` 第 5 节与第 13 节裁定；验收 M7-A2 末句（D9：B 以 pc 报到回 forbidden）。
 * 经真路由 + 真队列模块 + 真队列驱动（两层任一实现都覆盖），不起网络。假设见 `m7-kit.mjs` 的 K2、K3。
 * 跑：node --experimental-test-module-mocks --test server/test/m7-credentials.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOwner } from '../auth/protocol.mjs';
import {
  createDocQueueRig, memberPrincipal, snapTask, ENV, serverFingerprintOf,
  ownerGate, authOwnerGate, serverFpGate, gateOpts,
} from './m7-kit.mjs';

const browserConn = (rig, conn, username, device) => rig.connect(conn, memberPrincipal({ username, device, owner: 'browser' }));
const hello = (rig, conn, fields) => rig.ask(conn, { type: 'node.hello', ...fields });
const isForbidden = (m) => m?.type === 'error' && m.reason === 'forbidden';

/* ================================================================== D9 */

test('D9 normalizeOwner 认 { kind: "browser" }，多带键不认（K2）', gateOpts(authOwnerGate()), () => {
  assert.deepEqual(normalizeOwner({ kind: 'browser' }), { kind: 'browser' });
  assert.equal(normalizeOwner({ kind: 'browser', c: 1 }), null);
  // 原有两种照旧
  assert.deepEqual(normalizeOwner({ kind: 'user' }), { kind: 'user' });
  assert.deepEqual(normalizeOwner({ kind: 'agent', c: 2 }), { kind: 'agent', c: 2 });
});

test('D9 浏览器归属的 render 连接：以 pc / host 报到回 forbidden 且不登记；以 browser 报到照常', gateOpts(ownerGate()), () => {
  const rig = createDocQueueRig();
  for (const profile of ['pc', 'host']) {
    const conn = `b-${profile}`;
    browserConn(rig, conn, 'bob', 'devB');
    const r = hello(rig, conn, { nodeId: `n-${profile}`, profile, environment: ENV.winNvidiaChrome });
    assert.ok(isForbidden(r), `以 ${profile} 报到应 forbidden：${JSON.stringify(r)}`);
    assert.equal(rig.describe().nodes.some((n) => n.nodeId === `n-${profile}`), false, `被拒的 ${profile} 不该登记成节点`);
    const w = rig.ask(conn, { type: 'queue.watch', projects: ['p1'] });
    assert.equal(w?.type, 'error', `没登记的连接 watch 应出错：${JSON.stringify(w)}`);
  }
  browserConn(rig, 'b-ok', 'bob', 'devB');
  const ok = hello(rig, 'b-ok', { nodeId: 'n-ok', profile: 'browser', environment: ENV.winNvidiaChrome });
  assert.equal(ok?.type, 'node.welcome', JSON.stringify(ok));
});

test('D9 M7-A2：成员 B 的浏览器凭证自称 pc 拿不到 A 的任务（报到被拒，认领回 not-registered 而不是 claimed）', gateOpts(ownerGate()), () => {
  const rig = createDocQueueRig();
  rig.connect('pageA', memberPrincipal({ username: 'zoe', device: 'devA', role: 'page' }));
  rig.send('pageA', { type: 'publisher.hello', publisherId: 'pub-A' });
  const t = snapTask({ fp: serverFingerprintOf(ENV.winNvidiaChrome) });
  rig.send('pageA', { type: 'task.publish', tasks: [t] });
  browserConn(rig, 'b', 'bob', 'devB');
  hello(rig, 'b', { nodeId: 'n-b', profile: 'pc', envFingerprint: t.requires.envFingerprint });
  const w = rig.ask('b', { type: 'queue.watch', projects: 'all' });
  assert.notEqual(w?.type, 'queue.snapshot', `不该拿到全量快照：${JSON.stringify(w)}`);
  const c = rig.ask('b', { type: 'task.claim', id: t.id, expectVersion: 1 });
  assert.notEqual(c?.type, 'task.claimed', JSON.stringify(c));
  assert.equal(rig.describe().tasks.find((x) => x.id === t.id).state, 'open');
});

test('D9 nodeId 绑到第一次报到的 userId：别的 userId（同名不同设备、别的用户、另一种 owner）拿同一个 nodeId 报到回 forbidden，原节点不受影响', gateOpts(ownerGate()), () => {
  const rig = createDocQueueRig();
  const fpA = serverFingerprintOf(ENV.winNvidiaChrome);
  browserConn(rig, 'a', 'zoe', 'devA');
  assert.equal(hello(rig, 'a', { nodeId: 'n-shared', profile: 'browser', environment: ENV.winNvidiaChrome })?.type, 'node.welcome');
  rig.send('a', { type: 'queue.watch', projects: ['p1'] });

  const intruders = [
    ['x1', memberPrincipal({ username: 'zoe', device: 'devB', owner: 'browser' }), 'browser'],
    ['x2', memberPrincipal({ username: 'bob', device: 'devC', owner: 'browser' }), 'browser'],
    ['x3', memberPrincipal({ username: 'bob', device: 'devC', owner: 'user' }), 'pc'],
  ];
  for (const [conn, p, profile] of intruders) {
    rig.connect(conn, p);
    const r = hello(rig, conn, { nodeId: 'n-shared', profile, environment: ENV.winNvidiaChrome, envFingerprint: fpA });
    assert.ok(isForbidden(r), `${p.userId}（owner ${p.owner?.kind}）冒用 nodeId 应 forbidden：${JSON.stringify(r)}`);
  }
  // 原节点还连着、还收本人任务的增量
  const node = rig.describe().nodes.find((n) => n.nodeId === 'n-shared');
  assert.equal(node?.connected, true, JSON.stringify(node));
  rig.connect('pageA', memberPrincipal({ username: 'zoe', device: 'devA', role: 'page' }));
  rig.send('pageA', { type: 'publisher.hello', publisherId: 'pub-A' });
  const t = snapTask({ fp: fpA });
  rig.clear('a');
  rig.send('pageA', { type: 'task.publish', tasks: [t] });
  assert.ok(rig.of('a', 'task.opened').some((m) => m.task.id === t.id), '原节点照常收到本人任务');
  for (const [conn] of intruders) assert.equal(rig.of(conn, 'task.opened').length, 0, `${conn} 不该收到任何任务`);
});

test('D9 同一 userId 换连接用同一个 nodeId 重新报到照常（断线重连不受绑定影响）', gateOpts(ownerGate()), () => {
  const rig = createDocQueueRig();
  browserConn(rig, 'a1', 'zoe', 'devA');
  assert.equal(hello(rig, 'a1', { nodeId: 'n-a', profile: 'browser', environment: ENV.winNvidiaChrome })?.type, 'node.welcome');
  rig.router.disconnect('a1');
  browserConn(rig, 'a2', 'zoe', 'devA');
  assert.equal(hello(rig, 'a2', { nodeId: 'n-a', profile: 'browser', environment: ENV.winNvidiaChrome })?.type, 'node.welcome');
});

test('D9 回归：不带浏览器归属的 render 连接（桌面、独立主机）照旧能以 pc / host 报到', gateOpts(ownerGate()), () => {
  const rig = createDocQueueRig();
  rig.connect('pc', memberPrincipal({ username: 'pat', device: 'devP', owner: 'user' }));
  assert.equal(hello(rig, 'pc', { nodeId: 'n-pc', profile: 'pc', envFingerprint: 'aaaaaaaaaaaaaaaa' })?.type, 'node.welcome');
  rig.connect('host', memberPrincipal({ username: 'rig', device: 'devH' }));
  assert.equal(hello(rig, 'host', { nodeId: 'n-host', profile: 'host', envFingerprint: 'aaaaaaaaaaaaaaaa' })?.type, 'node.welcome');
});

/* ================================================================== D10 */

test('D10 指纹由服务端按原始值算：node.welcome 回 describeEnvironment 的结果', gateOpts(serverFpGate()), () => {
  const rig = createDocQueueRig();
  browserConn(rig, 'a', 'zoe', 'devA');
  const w = hello(rig, 'a', { nodeId: 'n-a', profile: 'browser', environment: ENV.winNvidiaChrome });
  assert.equal(w?.type, 'node.welcome', JSON.stringify(w));
  assert.equal(w.envFingerprint, serverFingerprintOf(ENV.winNvidiaChrome), JSON.stringify(w));
  assert.match(w.envFingerprint, /^[0-9a-f]{16}$/);
});

test('D10 自报的 envFingerprint 不作数：可见与认领都按服务端算的指纹', gateOpts(serverFpGate()), () => {
  const rig = createDocQueueRig();
  const real = serverFingerprintOf(ENV.winNvidiaChrome);
  const fake = 'ffffffffffffffff';
  rig.connect('pageA', memberPrincipal({ username: 'zoe', device: 'devA', role: 'page' }));
  rig.send('pageA', { type: 'publisher.hello', publisherId: 'pub-A' });
  const tFake = snapTask({ contentKey: 'ck-fake', fp: fake });
  const tReal = snapTask({ contentKey: 'ck-real', fp: real });
  rig.send('pageA', { type: 'task.publish', tasks: [tFake, tReal] });

  browserConn(rig, 'a', 'zoe', 'devA');
  const w = hello(rig, 'a', { nodeId: 'n-a', profile: 'browser', environment: ENV.winNvidiaChrome, envFingerprint: fake });
  assert.equal(w?.envFingerprint, real, `自报的 ${fake} 不作数：${JSON.stringify(w)}`);
  const snap = rig.ask('a', { type: 'queue.watch', projects: ['p1'] });
  assert.deepEqual((snap?.tasks ?? []).map((t) => t.id), [tReal.id], JSON.stringify(snap));
  assert.notEqual(rig.ask('a', { type: 'task.claim', id: tFake.id, expectVersion: 1 })?.type, 'task.claimed', '自报指纹的任务认领不到');
  assert.equal(rig.ask('a', { type: 'task.claim', id: tReal.id, expectVersion: 1 })?.type, 'task.claimed', '服务端指纹的任务照常认领');
});

test('D10 只自报 envFingerprint、不报原始值的浏览器连接，拿自报指纹的任务认领不到', gateOpts(serverFpGate()), () => {
  const rig = createDocQueueRig();
  const fake = 'eeeeeeeeeeeeeeee';
  rig.connect('pageA', memberPrincipal({ username: 'zoe', device: 'devA', role: 'page' }));
  rig.send('pageA', { type: 'publisher.hello', publisherId: 'pub-A' });
  const t = snapTask({ fp: fake });
  rig.send('pageA', { type: 'task.publish', tasks: [t] });
  browserConn(rig, 'a', 'zoe', 'devA');
  hello(rig, 'a', { nodeId: 'n-a', profile: 'browser', envFingerprint: fake });
  assert.notEqual(rig.ask('a', { type: 'task.claim', id: t.id, expectVersion: 1 })?.type, 'task.claimed');
});

/* ================================================================== D14（服务端这一侧，见 K3 末段） */

test('D14 非 Chromium（Firefox、Safari）的浏览器节点一个快照任务也认领不到，哪怕任务键正好是它会撞上的指纹', gateOpts(serverFpGate()), () => {
  const rig = createDocQueueRig();
  rig.connect('pageA', memberPrincipal({ username: 'zoe', device: 'devA', role: 'page' }));
  rig.send('pageA', { type: 'publisher.hello', publisherId: 'pub-A' });
  for (const [name, env] of [['firefox', ENV.winNvidiaFirefox], ['safari', ENV.macSafari]]) {
    // 今天的 chromeMajorOf 对这两种 UA 取到 5（Mozilla/5.0），这就是会撞的指纹
    const collide = serverFingerprintOf(env);
    const t = snapTask({ contentKey: `ck-${name}`, fp: collide });
    rig.send('pageA', { type: 'task.publish', tasks: [t] });
    browserConn(rig, name, 'zoe', 'devA');
    hello(rig, name, { nodeId: `n-${name}`, profile: 'browser', environment: env });
    rig.send(name, { type: 'queue.watch', projects: ['p1'] });
    const c = rig.ask(name, { type: 'task.claim', id: t.id, expectVersion: 1 });
    assert.notEqual(c?.type, 'task.claimed', `${name} 不该当节点：${JSON.stringify(c)}`);
    assert.equal(rig.describe().tasks.find((x) => x.id === t.id).state, 'open');
  }
});
