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

test('D9 normalizeOwner accepts { kind: "browser" } and does not accept extra keys (K2)', gateOpts(authOwnerGate()), () => {
  assert.deepEqual(normalizeOwner({ kind: 'browser' }), { kind: 'browser' });
  assert.equal(normalizeOwner({ kind: 'browser', c: 1 }), null);
  // 原有两种照旧
  assert.deepEqual(normalizeOwner({ kind: 'user' }), { kind: 'user' });
  assert.deepEqual(normalizeOwner({ kind: 'agent', c: 2 }), { kind: 'agent', c: 2 });
});

test('D9 render connections owned by a browser: checking in as pc / host returns forbidden and is not registered; checking in as browser works as usual', gateOpts(ownerGate()), () => {
  const rig = createDocQueueRig();
  for (const profile of ['pc', 'host']) {
    const conn = `b-${profile}`;
    browserConn(rig, conn, 'bob', 'devB');
    const r = hello(rig, conn, { nodeId: `n-${profile}`, profile, environment: ENV.winNvidiaChrome });
    assert.ok(isForbidden(r), `Checking in as ${profile} should be forbidden: ${JSON.stringify(r)}`);
    assert.equal(rig.describe().nodes.some((n) => n.nodeId === `n-${profile}`), false, `The rejected ${profile} should not be registered as a node`);
    const w = rig.ask(conn, { type: 'queue.watch', projects: ['p1'] });
    assert.equal(w?.type, 'error', `An unregistered connection's watch should error: ${JSON.stringify(w)}`);
  }
  browserConn(rig, 'b-ok', 'bob', 'devB');
  const ok = hello(rig, 'b-ok', { nodeId: 'n-ok', profile: 'browser', environment: ENV.winNvidiaChrome });
  assert.equal(ok?.type, 'node.welcome', JSON.stringify(ok));
});

test('D9 M7-A2: member B\'s browser credential posing as pc cannot get A\'s tasks (check-in is rejected, and a claim returns not-registered instead of claimed)', gateOpts(ownerGate()), () => {
  const rig = createDocQueueRig();
  rig.connect('pageA', memberPrincipal({ username: 'zoe', device: 'devA', role: 'page' }));
  rig.send('pageA', { type: 'publisher.hello', publisherId: 'pub-A' });
  const t = snapTask({ fp: serverFingerprintOf(ENV.winNvidiaChrome) });
  rig.send('pageA', { type: 'task.publish', tasks: [t] });
  browserConn(rig, 'b', 'bob', 'devB');
  hello(rig, 'b', { nodeId: 'n-b', profile: 'pc', envFingerprint: t.requires.envFingerprint });
  const w = rig.ask('b', { type: 'queue.watch', projects: 'all' });
  assert.notEqual(w?.type, 'queue.snapshot', `Should not get the full snapshot: ${JSON.stringify(w)}`);
  const c = rig.ask('b', { type: 'task.claim', id: t.id, expectVersion: 1 });
  assert.notEqual(c?.type, 'task.claimed', JSON.stringify(c));
  assert.equal(rig.describe().tasks.find((x) => x.id === t.id).state, 'open');
});

test('D9 nodeId is bound to the userId that first checked in: another userId (same name on a different device, another user, another kind of owner) checking in with the same nodeId gets forbidden, and the original node is unaffected', gateOpts(ownerGate()), () => {
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
    assert.ok(isForbidden(r), `${p.userId} (owner ${p.owner?.kind}) spoofing the nodeId should be forbidden: ${JSON.stringify(r)}`);
  }
  // 原节点还连着、还收本人任务的增量
  const node = rig.describe().nodes.find((n) => n.nodeId === 'n-shared');
  assert.equal(node?.connected, true, JSON.stringify(node));
  rig.connect('pageA', memberPrincipal({ username: 'zoe', device: 'devA', role: 'page' }));
  rig.send('pageA', { type: 'publisher.hello', publisherId: 'pub-A' });
  const t = snapTask({ fp: fpA });
  rig.clear('a');
  rig.send('pageA', { type: 'task.publish', tasks: [t] });
  assert.ok(rig.of('a', 'task.opened').some((m) => m.task.id === t.id), 'The original node still receives its owner\'s tasks as usual');
  for (const [conn] of intruders) assert.equal(rig.of(conn, 'task.opened').length, 0, `${conn} should not receive any tasks`);
});

test('D9 the same userId checking in again with the same nodeId on a different connection works as usual (reconnecting after a drop is not affected by the binding)', gateOpts(ownerGate()), () => {
  const rig = createDocQueueRig();
  browserConn(rig, 'a1', 'zoe', 'devA');
  assert.equal(hello(rig, 'a1', { nodeId: 'n-a', profile: 'browser', environment: ENV.winNvidiaChrome })?.type, 'node.welcome');
  rig.router.disconnect('a1');
  browserConn(rig, 'a2', 'zoe', 'devA');
  assert.equal(hello(rig, 'a2', { nodeId: 'n-a', profile: 'browser', environment: ENV.winNvidiaChrome })?.type, 'node.welcome');
});

test('D9 regression: render connections without browser ownership (desktop, standalone host) can still check in as pc / host', gateOpts(ownerGate()), () => {
  const rig = createDocQueueRig();
  rig.connect('pc', memberPrincipal({ username: 'pat', device: 'devP', owner: 'user' }));
  assert.equal(hello(rig, 'pc', { nodeId: 'n-pc', profile: 'pc', envFingerprint: 'aaaaaaaaaaaaaaaa' })?.type, 'node.welcome');
  rig.connect('host', memberPrincipal({ username: 'rig', device: 'devH' }));
  assert.equal(hello(rig, 'host', { nodeId: 'n-host', profile: 'host', envFingerprint: 'aaaaaaaaaaaaaaaa' })?.type, 'node.welcome');
});

/* ================================================================== D10 */

test('D10 the fingerprint is computed by the server from the raw values: node.welcome returns the result of describeEnvironment', gateOpts(serverFpGate()), () => {
  const rig = createDocQueueRig();
  browserConn(rig, 'a', 'zoe', 'devA');
  const w = hello(rig, 'a', { nodeId: 'n-a', profile: 'browser', environment: ENV.winNvidiaChrome });
  assert.equal(w?.type, 'node.welcome', JSON.stringify(w));
  assert.equal(w.envFingerprint, serverFingerprintOf(ENV.winNvidiaChrome), JSON.stringify(w));
  assert.match(w.envFingerprint, /^[0-9a-f]{16}$/);
});

test('D10 a self-reported envFingerprint does not count: visibility and claiming both use the fingerprint computed by the server', gateOpts(serverFpGate()), () => {
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
  assert.equal(w?.envFingerprint, real, `Self-reported ${fake} does not count: ${JSON.stringify(w)}`);
  const snap = rig.ask('a', { type: 'queue.watch', projects: ['p1'] });
  assert.deepEqual((snap?.tasks ?? []).map((t) => t.id), [tReal.id], JSON.stringify(snap));
  assert.notEqual(rig.ask('a', { type: 'task.claim', id: tFake.id, expectVersion: 1 })?.type, 'task.claimed', 'A task with a self-reported fingerprint cannot be claimed');
  assert.equal(rig.ask('a', { type: 'task.claim', id: tReal.id, expectVersion: 1 })?.type, 'task.claimed', 'A task with the server\'s fingerprint is claimed as usual');
});

test('D10 a browser connection that reports only envFingerprint and not the raw values cannot claim a task with the self-reported fingerprint', gateOpts(serverFpGate()), () => {
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

test('D14 a non-Chromium (Firefox, Safari) browser node cannot claim a single snapshot task, even if the task key happens to be the fingerprint it would run into', gateOpts(serverFpGate()), () => {
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
    assert.notEqual(c?.type, 'task.claimed', `${name} should not act as a node: ${JSON.stringify(c)}`);
    assert.equal(rig.describe().tasks.find((x) => x.id === t.id).state, 'open');
  }
});
