/**
 * 渲染任务队列（M1）容错表用例 F1.1～F9.3。
 * 跑：node --test server/test/render-queue-fault.test.mjs
 *
 * 依据：`docs/plan/distributed-prerender-queue.md` 第 5 节容错表与 5.1 节 C1～C6（设计）、
 * `docs/plan/render-queue-contract.md` A 节（契约）、`docs/plan/TASK-distributed-prerender-queue.md` 5.2 节（矩阵）。
 * 编号 F<行>.<序> 对应设计第 5 节容错表的行序。
 *
 * 每条用例断言三样：任务状态（state / version / claim / attempts）、这一步发给每条连接的消息、
 * `describe()` 与前两者一致。只经契约 A.3 的公开接口驱动；常量用基线值，时钟用假时钟，`tick()` 手动调。
 *
 * 公共布置（`setup`）：发布方 P（连接 p，身份 pub-1，用户 u1）发布任务 T；
 * 节点 A、B、C（连接 a、b、c，profile pc）和只看不做的 W（连接 w，profile pc；M6c X3 之前是 host）都 `queue.watch('all')`。
 * T 新建时 version = 1；A 以 expectVersion 1 认领后 version = token = 2（契约 A.7.2 第 5 步）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createQueueHarness, makeTaskInput, T0 } from './fake-render-queue-env.mjs';

// 设计第 8 节 Q4 的基线值（契约 A.2）
const LEASE = 30_000;
const GRACE = 10_000;
const STALL = 120_000;
const TTL = 600_000;

const WATCHERS = ['a', 'b', 'c', 'w'];
const T_IN = makeTaskInput({ resultKey: 'rk1' });           // snapshot:rk1:0-59
const T1_IN = makeTaskInput({ resultKey: 'rk1', range: [0, 59] });
const T2_IN = makeTaskInput({ resultKey: 'rk1', range: [60, 119] });

function setup({ tasks = [T_IN], ...options } = {}) {
  const h = createQueueHarness(createRenderQueue, options);
  h.publisher('p', 'pub-1');
  h.node('a', 'node-A');
  h.node('b', 'node-B');
  h.node('c', 'node-C');
  h.node('w', 'node-W', { profile: 'pc' });   // M6c X3：host 的 watch 'all' 只收摘要，只看不做的 W 改用 pc（原为 host）
  const out = h.publish('p', tasks);
  for (const r of out.one('p', 'task.published').results) assert.equal(r.created, true, '布置：任务应新建');
  h.bus.clear();
  return { h, id: tasks[0].id, ids: tasks.map(t => t.id) };
}

/** 认领成功：回 `task.claimed`，token = version = expectVersion + 1，租约从现在起算（契约 A.7.2 第 5 步）。 */
function claimOk(h, conn, id, expectVersion) {
  const out = h.claim(conn, id, expectVersion);
  const m = out.one(conn, 'task.claimed');
  assert.equal(m.id, id);
  assert.equal(m.version, expectVersion + 1, 'claimed.version');
  assert.equal(m.token, m.version, 'token 取认领那一刻的 version');
  assert.equal(m.leaseUntil, h.now() + LEASE, 'leaseUntil = now + LEASE_MS');
  assert.equal(m.task.id, id);
  // 其它可见的 watch 者各收到一条 task.taken，认领者自己不收
  for (const w of WATCHERS) {
    if (w === conn) assert.equal(out.of(w, 'task.taken').length, 0, '认领者自己不收 task.taken');
  }
  return { msg: m, out };
}

/** 按 `describe()` 断言任务；`exp === null` 表示应已删除。 */
function assertTask(h, id, exp) {
  const t = h.task(id);
  if (exp === null) { assert.equal(t, null, `${id} 应已删除`); return null; }
  assert.ok(t, `${id} 应存在`);
  for (const k of ['state', 'version', 'attempts', 'lastError', 'finishedAt', 'projectId']) {
    if (k in exp) assert.deepEqual(t[k], exp[k], `${id}.${k}`);
  }
  if ('subscribers' in exp) assert.deepEqual(t.subscribers, exp.subscribers, `${id}.subscribers`);
  if ('claim' in exp) {
    if (exp.claim === null) assert.equal(t.claim, null, `${id}.claim 应为 null`);
    else {
      assert.ok(t.claim, `${id}.claim 不应为 null`);
      for (const [k, v] of Object.entries(exp.claim)) assert.deepEqual(t.claim[k], v, `${id}.claim.${k}`);
    }
  }
  return t;
}

/** `conns` 每条各恰好收到一条关于 `id` 的 `task.opened`，其中的任务视图是 open、version、attempts。 */
function assertOpened(out, conns, id, { version, attempts }) {
  for (const c of conns) {
    const list = out.of(c, 'task.opened').filter(m => m.task?.id === id);
    assert.equal(list.length, 1, `${c} 应收到一条 ${id} 的 task.opened`);
    assert.equal(list[0].task.state, 'open');
    assert.equal(list[0].task.version, version);
    assert.equal(list[0].task.attempts, attempts);
    assert.equal('claim' in list[0].task, false, 'TaskView 不含 claim');
    assert.equal('subscribers' in list[0].task, false, 'TaskView 不含 subscribers');
  }
}

function assertClosed(out, conns, id, state) {
  for (const c of conns) {
    const list = out.of(c, 'task.closed').filter(m => m.id === id);
    assert.equal(list.length, 1, `${c} 应收到一条 ${id} 的 task.closed`);
    assert.equal(list[0].state, state);
  }
}

function assertLeaseLost(out, conn, { id, token, reason }) {
  const m = out.one(conn, 'task.lease-lost');
  assert.equal(m.id, id);
  assert.equal(m.token, token);
  if (reason !== undefined) assert.equal(m.reason, reason);
  return m;
}

/** 契约 A.9：节点报到的回包 `node.welcome { nodeId, resumed, lost }`。 */
function assertWelcome(out, conn, { nodeId, resumed, lost }) {
  const m = out.one(conn, 'node.welcome');
  assert.equal(m.nodeId, nodeId);
  assert.deepEqual([...m.resumed].sort(), [...resumed].sort(), 'welcome.resumed');
  assert.deepEqual([...m.lost].sort(), [...lost].sort(), 'welcome.lost');
  return m;
}

/** 把 T 做成 failed：A、B、C 各认领一次再 `fail`（MAX_ATTEMPTS = 3）。返回进入 failed 的时刻。 */
function failThrice(h, id) {
  let v = h.task(id).version;
  for (const [conn, err] of [['a', 'e1'], ['b', 'e2'], ['c', 'e3']]) {
    const { msg } = claimOk(h, conn, id, v);
    h.fail(conn, id, msg.token, { error: err });
    v = h.task(id).version;
  }
  assertTask(h, id, { state: 'failed', attempts: 3, version: 7 });
  return h.now();
}

/* ============================================================ F1 认领者 WebSocket 断开 */

test('F1.1 认领者 WebSocket 断开：宽限期内（9.9 s）T 仍由 A 持有，无广播', () => {
  const { h, id } = setup();
  const { msg } = claimOk(h, 'a', id, 1);
  assert.equal(msg.token, 2);

  h.disconnect('a').assertSilent('断开');
  const n = h.nodeInfo('node-A');
  assert.equal(n.connected, false);
  assert.equal(n.disconnectedAt, T0);

  h.advance(9_900).assertSilent('宽限期内的 tick');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2, leaseUntil: T0 + LEASE } });

  // 恰好 10 s：比较是严格大于（契约 A.8），仍不回收
  h.at(T0 + GRACE).assertSilent('宽限恰好到点的 tick');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2 } });
  assert.equal(h.nodeInfo('node-A').connected, false);
});

test('F1.2 认领者 WebSocket 断开：5 s 后同一 nodeId 重连并 resume，接续成功，令牌与租约不变，之后的 progress 被接受', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.disconnect('a');

  h.clock.set(T0 + 5_000);
  const out = h.node('a2', 'node-A', { resume: [{ id, token: 2 }], watch: null });
  assertWelcome(out, 'a2', { nodeId: 'node-A', resumed: [id], lost: [] });
  assert.deepEqual(out.types('a2'), ['node.welcome'], '接续成功不发 lease-lost');
  assert.deepEqual(out.conns(), ['a2'], '别的连接什么都不收');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2, leaseUntil: T0 + LEASE } });
  assert.deepEqual(h.nodeInfo('node-A'), { ...h.nodeInfo('node-A'), connected: true, disconnectedAt: null });

  const p = h.progress('a2', id, 2, 5);
  const r = p.one('a2', 'task.renewed');
  assert.deepEqual([r.id, r.token, r.leaseUntil], [id, 2, T0 + 5_000 + LEASE]);
  assert.deepEqual(p.conns(), ['a2']);
  assertTask(h, id, { state: 'claimed', version: 2, claim: { token: 2, leaseUntil: T0 + 5_000 + LEASE, progress: { done: 5, changedAt: T0 + 5_000 } } });

  // 原来的宽限期已清掉：过了 T0 + 10 s 也不回收
  h.at(T0 + GRACE + 100).assertSilent('重连之后的 tick');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2 } });
});

test('F1.3 认领者 WebSocket 断开：宽限到期（10.1 s）T 回 open，version +1，claim 清空，attempts = 1，watch 者收到 task.opened', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.disconnect('a');

  const out = h.at(T0 + 10_100);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, subscribers: ['pub-1'], lastError: 'disconnected' });
  assertOpened(out, ['b', 'c', 'w'], id, { version: 3, attempts: 1 });
  assert.deepEqual(out.conns(), ['b', 'c', 'w'], 'A 已断开不收（lease-lost 也不发）；发布方不收');
  for (const c of ['b', 'c', 'w']) assert.deepEqual(out.types(c), ['task.opened']);
  assert.equal(h.nodeInfo('node-A'), null, '宽限到期后删掉节点记录（契约 A.8 第 3 项）');
});

test('F1.4 认领者 WebSocket 断开：宽限过后再带旧令牌 resume，回 lease-lost，T 不变（仍 open 或已被别人认领）', () => {
  // 情形一：T 仍 open
  {
    const { h, id } = setup();
    claimOk(h, 'a', id, 1);
    h.disconnect('a');
    h.at(T0 + 10_100);
    h.clock.advance(1_000);
    const out = h.node('a2', 'node-A', { resume: [{ id, token: 2 }], watch: null });
    assertWelcome(out, 'a2', { nodeId: 'node-A', resumed: [], lost: [id] });
    // 任务存在、不是 claimed → reason 'token'（契约 A.9「其余（不是 claimed、令牌不符）」）
    assertLeaseLost(out, 'a2', { id, token: 2, reason: 'token' });
    assert.deepEqual(out.sortedTypes('a2'), ['node.welcome', 'task.lease-lost']);
    assert.deepEqual(out.conns(), ['a2'], '别的连接什么都不收');
    assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null });
  }
  // 情形二：T 已被 B 认领
  {
    const { h, id } = setup();
    claimOk(h, 'a', id, 1);
    h.disconnect('a');
    h.at(T0 + 10_100);
    claimOk(h, 'b', id, 3);
    const out = h.node('a2', 'node-A', { resume: [{ id, token: 2 }], watch: null });
    assertWelcome(out, 'a2', { nodeId: 'node-A', resumed: [], lost: [id] });
    // 任务存在但认领者是 B → reason 'not-owner'（契约 A.9）
    assertLeaseLost(out, 'a2', { id, token: 2, reason: 'not-owner' });
    assert.deepEqual(out.conns(), ['a2']);
    assertTask(h, id, { state: 'claimed', version: 4, attempts: 1, claim: { nodeId: 'node-B', token: 4 } });
  }
});

test('F1.5 认领者 WebSocket 断开：A 持有 T1、T2，宽限到期两者都回 open，各自 version +1', () => {
  const { h, ids: [id1, id2] } = setup({ tasks: [T1_IN, T2_IN] });
  claimOk(h, 'a', id1, 1);
  claimOk(h, 'a', id2, 1);
  h.disconnect('a');
  h.at(T0 + GRACE).assertSilent('恰好到点');

  const out = h.at(T0 + GRACE + 1);
  for (const id of [id1, id2]) {
    assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'disconnected' });
    assertOpened(out, ['b', 'c', 'w'], id, { version: 3, attempts: 1 });
  }
  assert.deepEqual(out.conns(), ['b', 'c', 'w']);
  for (const c of ['b', 'c', 'w']) assert.deepEqual(out.types(c), ['task.opened', 'task.opened']);
});

test('F1.6 认领者 WebSocket 断开：宽限期内另一个 nodeId 拿着 A 的令牌 resume，回 lease-lost（not-owner），T 仍归 A', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.disconnect('a');

  h.clock.set(T0 + 3_000);
  const out = h.node('x', 'node-X', { resume: [{ id, token: 2 }], watch: null });
  assertWelcome(out, 'x', { nodeId: 'node-X', resumed: [], lost: [id] });
  assertLeaseLost(out, 'x', { id, token: 2, reason: 'not-owner' });  // C4
  assert.deepEqual(out.conns(), ['x']);
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2, leaseUntil: T0 + LEASE } });

  // A 本人在宽限期内回来仍能接续：别人的 resume 没有破坏认领
  h.clock.set(T0 + 5_000);
  const back = h.node('a2', 'node-A', { resume: [{ id, token: 2 }], watch: null });
  assertWelcome(back, 'a2', { nodeId: 'node-A', resumed: [id], lost: [] });
  assertTask(h, id, { state: 'claimed', version: 2, claim: { nodeId: 'node-A', token: 2 } });
});

/* ============================================================ F2 处理超时 */

test('F2.1 处理超时：leaseUntil = t0 + 30 s，推进 29.9 s（以及恰好 30 s）T 仍 claimed', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  assertTask(h, id, { claim: { leaseUntil: T0 + LEASE } });

  h.advance(29_900).assertSilent('租约未到期');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2, leaseUntil: T0 + LEASE } });

  h.at(T0 + LEASE).assertSilent('恰好到期：严格大于才回收');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0 });
});

test('F2.2 处理超时：推进 30.1 s，T 回 open，attempts = 1，version +1；A 收到 lease-lost，watch 者收到 task.opened', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);

  const out = h.advance(30_100);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'lease-expired' });
  assertLeaseLost(out, 'a', { id, token: 2, reason: 'lease-expired' });
  // A 自己也是 watch 者，同样收到 task.opened
  assertOpened(out, WATCHERS, id, { version: 3, attempts: 1 });
  assert.deepEqual(out.sortedTypes('a'), ['task.lease-lost', 'task.opened']);
  for (const c of ['b', 'c', 'w']) assert.deepEqual(out.types(c), ['task.opened']);
  assert.deepEqual(out.conns(), WATCHERS, '发布方不收');
});

test('F2.3 处理超时：每 10 s 一次 progress（done 递增）共 5 次，leaseUntil 每次顺延到 now + 30 s，50 s 后仍 claimed', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);

  for (let i = 1; i <= 5; i++) {
    h.clock.advance(10_000);
    const now = h.now();
    const out = h.progress('a', id, 2, i * 10);
    const r = out.one('a', 'task.renewed');
    assert.deepEqual([r.id, r.token, r.leaseUntil], [id, 2, now + LEASE], `第 ${i} 次续约`);
    assert.deepEqual(out.conns(), ['a'], '续约不广播');
    h.tick().assertSilent(`第 ${i} 次续约后的 tick`);
    // progress 不是状态转移，version 不变（契约 A.7）
    assertTask(h, id, { state: 'claimed', version: 2, attempts: 0,
      claim: { token: 2, leaseUntil: now + LEASE, progress: { done: i * 10, changedAt: now } } });
  }
  assert.equal(h.now(), T0 + 50_000);
  assertTask(h, id, { state: 'claimed', claim: { nodeId: 'node-A' } });
});

test('F2.4 处理超时：推进 20 s 后续约一次，再推进 25 s，T 仍 claimed；到新租约之后才回收', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.advance(20_000).assertSilent();
  const r = h.progress('a', id, 2, 1).one('a', 'task.renewed');
  assert.equal(r.leaseUntil, T0 + 20_000 + LEASE);

  h.advance(25_000).assertSilent('续约后未超时');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { leaseUntil: T0 + 50_000 } });

  h.at(T0 + 50_000).assertSilent('新租约恰好到点');
  const out = h.at(T0 + 50_001);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'lease-expired' });
  assertLeaseLost(out, 'a', { id, token: 2, reason: 'lease-expired' });
});

/* ============================================================ F3 进度停滞 */

test('F3.1 进度停滞：从 t=10 s 起每 10 s 报 done=24，停滞从 t=10 s 起算，t=130 s 之前不回收，之后第一次 tick 回收', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);

  for (let s = 10; s <= 130; s += 10) {
    h.clock.set(T0 + s * 1000);
    h.progress('a', id, 2, 24).one('a', 'task.renewed');
    h.tick().assertSilent(`t=${s} s`);
    assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { progress: { done: 24, changedAt: T0 + 10_000 } } });
  }

  const out = h.at(T0 + 130_001);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'stalled' });
  assertLeaseLost(out, 'a', { id, token: 2, reason: 'stalled' });
  assertOpened(out, WATCHERS, id, { version: 3, attempts: 1 });
  assert.deepEqual(out.conns(), WATCHERS);
});

test('F3.2 进度停滞：done 在 t=100 s 变成 25 之后不变，停滞从 t=100 s 重新起算，t=220 s 之前不回收，之后第一次 tick 回收', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);

  for (let s = 10; s <= 220; s += 10) {
    h.clock.set(T0 + s * 1000);
    const done = s < 100 ? 24 : 25;
    h.progress('a', id, 2, done).one('a', 'task.renewed');
    h.tick().assertSilent(`t=${s} s`);
    assertTask(h, id, { state: 'claimed', version: 2, attempts: 0,
      claim: { progress: { done, changedAt: T0 + (s < 100 ? 10_000 : 100_000) } } });
  }

  const out = h.at(T0 + 220_001);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'stalled' });
  assertLeaseLost(out, 'a', { id, token: 2, reason: 'stalled' });
  assertOpened(out, WATCHERS, id, { version: 3, attempts: 1 });
});

test('F3.3 进度停滞：从未报过进度的任务只受租约管，30.1 s 按租约回收，不看 STALL', () => {
  {
    const { h, id } = setup();
    claimOk(h, 'a', id, 1);
    assertTask(h, id, { claim: { progress: { done: null, changedAt: T0 } } });
    const out = h.advance(30_100);
    assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'lease-expired' });
    assertLeaseLost(out, 'a', { id, token: 2, reason: 'lease-expired' });
    assertOpened(out, WATCHERS, id, { version: 3, attempts: 1 });
  }
  // 把 STALL 调得比租约短，更能看出 done === null 时停滞扫描不管它（契约 A.8 第 2 项）
  {
    const { h, id } = setup({ constants: { STALL_MS: 1_000 } });
    claimOk(h, 'a', id, 1);
    h.at(T0 + 5_000).assertSilent('STALL 已过但从未报进度');
    h.at(T0 + LEASE).assertSilent('租约恰好到点');
    assertTask(h, id, { state: 'claimed', version: 2, attempts: 0 });
    const out = h.at(T0 + LEASE + 1);
    assertTask(h, id, { state: 'open', version: 3, attempts: 1, lastError: 'lease-expired' });
    assertLeaseLost(out, 'a', { id, token: 2, reason: 'lease-expired' });
  }
});

/* ============================================================ F4 反复失败的任务 */

test('F4.1 反复失败的任务：A、B、C 依次认领后 fail，前两次回 open（attempts 1、2），第三次进 failed，订阅者收到带 lastError 的失败通知', () => {
  const { h, id } = setup();

  const steps = [
    { conn: 'a', expect: 1, error: 'e1', retryable: true, state: 'open', version: 3, attempts: 1 },
    { conn: 'b', expect: 3, error: 'e2', retryable: undefined, state: 'open', version: 5, attempts: 2 },
    { conn: 'c', expect: 5, error: 'e3', retryable: true, state: 'failed', version: 7, attempts: 3 },
  ];
  for (const s of steps) {
    const { msg } = claimOk(h, s.conn, id, s.expect);
    h.clock.advance(1_000);
    const out = h.fail(s.conn, id, msg.token, { error: s.error, retryable: s.retryable });
    const ack = out.one(s.conn, 'task.fail-ack');
    assert.deepEqual([ack.id, ack.state], [id, s.state]);
    if (s.state === 'open') {
      assertTask(h, id, { state: 'open', version: s.version, attempts: s.attempts, claim: null, lastError: s.error });
      assertOpened(out, WATCHERS, id, { version: s.version, attempts: s.attempts });
      assert.equal(out.of('p').length, 0, '回 open 时不通知订阅者');
    } else {
      assertTask(h, id, { state: 'failed', version: 7, attempts: 3, claim: null, lastError: 'e3', finishedAt: h.now() });
      const f = out.one('p', 'task.failed');
      assert.deepEqual([f.id, f.error], [id, 'e3']);
      assert.deepEqual(out.types('p'), ['task.failed']);
      assertClosed(out, WATCHERS, id, 'failed');
      assert.equal(out.ofType('task.opened').length, 0);
    }
  }
  assert.equal(h.bus.ofType('task.failed').length, 1, '失败通知只发一次');

  // failed 之后谁来认领都是 taken
  const rej = h.claim('a', id, 7).one('a', 'task.claim-rejected');
  assert.deepEqual([rej.reason, rej.state, rej.version], ['taken', 'failed', 7]);
});

test('F4.2 反复失败的任务：超时、断开、停滞和 fail 共用一个 attempts（C3），第三次回收把 T 推进 failed', () => {
  // 矩阵原样：前两次超时回收，第三次认领后又超时
  {
    const { h, id } = setup();
    let v = 1;
    for (let i = 1; i <= 2; i++) {
      claimOk(h, 'a', id, v);
      h.advance(LEASE + 1);
      v = h.task(id).version;
      assertTask(h, id, { state: 'open', attempts: i, version: 1 + 2 * i });
    }
    claimOk(h, 'a', id, 5);
    h.bus.clear();
    const out = h.advance(LEASE + 1);
    assertTask(h, id, { state: 'failed', version: 7, attempts: 3, claim: null, lastError: 'lease-expired', finishedAt: h.now() });
    assertLeaseLost(out, 'a', { id, token: 6, reason: 'lease-expired' });
    const f = out.one('p', 'task.failed');
    assert.deepEqual([f.id, f.error], [id, 'lease-expired']);
    assertClosed(out, WATCHERS, id, 'failed');
    assert.equal(out.ofType('task.opened').length, 0);
  }
  // 混合：fail → 断开宽限 → 停滞
  {
    const { h, id } = setup();
    const { msg: m1 } = claimOk(h, 'a', id, 1);
    assert.equal(h.fail('a', id, m1.token, { error: 'e1' }).one('a', 'task.fail-ack').state, 'open');
    assertTask(h, id, { state: 'open', version: 3, attempts: 1, lastError: 'e1' });

    claimOk(h, 'b', id, 3);
    h.disconnect('b');
    h.advance(GRACE + 1);
    assertTask(h, id, { state: 'open', version: 5, attempts: 2, lastError: 'disconnected' });

    const { msg: m3 } = claimOk(h, 'c', id, 5);
    const x = h.now();
    h.progress('c', id, m3.token, 1);
    for (let s = 10; s <= 120; s += 10) {
      h.clock.set(x + s * 1000);
      h.progress('c', id, m3.token, 1).one('c', 'task.renewed');
      h.tick().assertSilent(`停滞计时 ${s} s`);
    }
    h.bus.clear();
    const out = h.at(x + STALL + 1);
    assertTask(h, id, { state: 'failed', version: 7, attempts: 3, claim: null, lastError: 'stalled' });
    assertLeaseLost(out, 'c', { id, token: 6, reason: 'stalled' });
    assert.equal(out.one('p', 'task.failed').error, 'stalled');
    assertClosed(out, ['a', 'c', 'w'], id, 'failed');
  }
});

test('F4.3 反复失败的任务：failed 在 DONE_TTL 内再发布仍是 failed、不重开（C1）；过了 TTL 旧任务删除，再发布是新的 open 任务', () => {
  const { h, id } = setup();
  const tf = failThrice(h, id);
  h.bus.clear();

  h.clock.set(tf + TTL);
  const again = h.publish('p', [T_IN]);
  const [r] = again.one('p', 'task.published').results;
  assert.deepEqual(r, { id, state: 'failed', version: 7, created: false });
  assert.deepEqual(again.conns(), ['p'], '不广播 task.opened');
  assert.deepEqual(again.types('p'), ['task.published'], 'failed 的重复发布不另发通知');
  assertTask(h, id, { state: 'failed', version: 7, attempts: 3, finishedAt: tf });

  h.tick().assertSilent('TTL 恰好到点');
  assertTask(h, id, { state: 'failed' });

  h.at(tf + TTL + 1).assertSilent('TTL 删除不发消息');
  assertTask(h, id, null);

  const fresh = h.publish('p', [T_IN]);
  assert.deepEqual(fresh.one('p', 'task.published').results[0], { id, state: 'open', version: 1, created: true });
  assertOpened(fresh, WATCHERS, id, { version: 1, attempts: 0 });
  assertTask(h, id, { state: 'open', version: 1, attempts: 0, claim: null, subscribers: ['pub-1'], finishedAt: null, lastError: null });
});

test('F4.4 反复失败的任务：换了结果键的新 id 正常 open，与 failed 的 T 无关', () => {
  const { h, id } = setup();
  failThrice(h, id);
  h.bus.clear();
  const T2 = makeTaskInput({ resultKey: 'rk2' });
  const out = h.publish('p', [T2]);
  assert.deepEqual(out.one('p', 'task.published').results[0], { id: T2.id, state: 'open', version: 1, created: true });
  assertOpened(out, WATCHERS, T2.id, { version: 1, attempts: 0 });
  assertTask(h, T2.id, { state: 'open', version: 1, attempts: 0 });
  assertTask(h, id, { state: 'failed', version: 7, attempts: 3 });
});

test('F4.5 反复失败的任务：A 主动 release，T 回 open，attempts 不加（C2）', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  const out = h.release('a', id, 2, 'busy');
  assert.equal(out.one('a', 'task.released').id, id);
  // release 不写 lastError（契约 A.10a）：新任务的 null 保持不变
  assertTask(h, id, { state: 'open', version: 3, attempts: 0, claim: null, lastError: null });
  assertOpened(out, WATCHERS, id, { version: 3, attempts: 0 });
  assert.deepEqual(out.sortedTypes('a'), ['task.opened', 'task.released']);
  assert.equal(out.of('p').length, 0);
});

/* ============================================================ F5 晚到的完成报告 */

/** A 认领（t1 = 2）→ 超时回收（v3）→ B 认领（t2 = 4）。 */
function lateSetup() {
  const s = setup();
  claimOk(s.h, 'a', s.id, 1);
  s.h.advance(LEASE + 1);
  claimOk(s.h, 'b', s.id, 3);
  s.h.bus.clear();
  return s;
}

test('F5.1 晚到的完成报告：A 用过期令牌 t1 complete，回 lease-lost；T 仍由 B 以 t2 持有，订阅者没收到 task.done', () => {
  const { h, id } = lateSetup();
  const out = h.complete('a', id, 2, { ranges: [[0, 59]] });
  assertLeaseLost(out, 'a', { id, token: 2, reason: 'token' });
  assert.deepEqual(out.conns(), ['a']);
  assertTask(h, id, { state: 'claimed', version: 4, attempts: 1, claim: { nodeId: 'node-B', token: 4 } });
  assert.equal(h.bus.ofType('task.done').length, 0);
});

test('F5.2 晚到的完成报告：B 用 t2 complete，T 进 done；订阅者收到一次 task.done，watch 者收到 task.closed', () => {
  const { h, id } = lateSetup();
  h.complete('a', id, 2);
  const out = h.complete('b', id, 4, { ranges: [[0, 59]] });
  assert.equal(out.one('b', 'task.completed').id, id);
  assertTask(h, id, { state: 'done', version: 5, attempts: 1, claim: null, finishedAt: h.now() });
  const d = out.one('p', 'task.done');
  assert.deepEqual({ id: d.id, resultKey: d.resultKey, projectId: d.projectId, projectRev: d.projectRev, result: d.result },
    { id, resultKey: 'rk1', projectId: 'proj-1', projectRev: 1, result: { ranges: [[0, 59]] } });
  assertClosed(out, WATCHERS, id, 'done');
  assert.equal(h.bus.ofType('task.done').length, 1);
});

test('F5.3 晚到的完成报告：T 已 done，任何节点再 complete（任何令牌）都回 lease-lost，不重复通知', () => {
  const { h, id } = lateSetup();
  h.complete('b', id, 4, { ranges: [[0, 59]] });
  h.bus.clear();
  for (const [conn, token] of [['a', 2], ['b', 4], ['c', 5], ['w', 5]]) {
    const out = h.complete(conn, id, token);
    assertLeaseLost(out, conn, { id, token, reason: 'token' });
    assert.deepEqual(out.conns(), [conn]);
  }
  assertTask(h, id, { state: 'done', version: 5, claim: null });
  assert.equal(h.bus.ofType('task.done').length, 0);
});

test('F5.4 晚到的完成报告：T 被回收后 open，A 拿 t1 发 progress / release，回 lease-lost，T 仍 open、version 不变', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.advance(LEASE + 1);
  h.bus.clear();
  const p = h.progress('a', id, 2, 10);
  assertLeaseLost(p, 'a', { id, token: 2, reason: 'token' });
  assert.deepEqual(p.conns(), ['a']);
  const r = h.release('a', id, 2, 'busy');
  assertLeaseLost(r, 'a', { id, token: 2, reason: 'token' });
  assert.deepEqual(r.conns(), ['a']);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null });
});

/* ============================================================ F6 节点推产物推到一半就崩了 */

test('F6.1 节点推产物推到一半就崩了：报过进度后既不完成也不断开，租约到期回 open，可被重新认领', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.clock.set(T0 + 5_000);
  h.progress('a', id, 2, 10);
  h.at(T0 + 5_000 + LEASE).assertSilent('新租约恰好到点');
  assertTask(h, id, { state: 'claimed', version: 2 });

  const out = h.at(T0 + 5_000 + LEASE + 1);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'lease-expired' });
  assertLeaseLost(out, 'a', { id, token: 2, reason: 'lease-expired' });
  assertOpened(out, WATCHERS, id, { version: 3, attempts: 1 });
  assert.equal(h.bus.ofType('task.done').length, 0, '没有 complete 就不算完成');

  claimOk(h, 'b', id, 3);
  assertTask(h, id, { state: 'claimed', version: 4, claim: { nodeId: 'node-B', token: 4 } });
});

test('F6.2 节点推产物推到一半就崩了：A 断开不回来，宽限到期回收（同 F1.3），没有中间态', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.progress('a', id, 2, 10);
  h.disconnect('a');
  for (const t of [T0 + 1, T0 + 5_000, T0 + GRACE]) {
    h.at(t).assertSilent();
    assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2 } });
  }
  const out = h.at(T0 + GRACE + 1);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'disconnected' });
  assertOpened(out, ['b', 'c', 'w'], id, { version: 3, attempts: 1 });
  assert.deepEqual(out.conns(), ['b', 'c', 'w']);
  assert.equal(h.nodeInfo('node-A'), null);
  claimOk(h, 'b', id, 3);
});

/* ============================================================ F7 发布方断开 */

test('F7.1 发布方断开：宽限到期后，只有 P 订阅的 open 任务 T1 删除（watch 者收到 task.closed），被认领的 T2 保留', () => {
  const { h, ids: [id1, id2] } = setup({ tasks: [T1_IN, T2_IN] });
  claimOk(h, 'a', id2, 1);
  h.disconnect('p').assertSilent('发布方断开');
  assert.deepEqual(h.publisherInfo('pub-1'), { publisherId: 'pub-1', connected: false, disconnectedAt: T0 });

  h.at(T0 + GRACE).assertSilent('宽限恰好到点');
  assertTask(h, id1, { state: 'open', subscribers: ['pub-1'] });

  const out = h.at(T0 + GRACE + 1);
  assertTask(h, id1, null);
  assertClosed(out, WATCHERS, id1, 'removed');
  for (const c of WATCHERS) assert.deepEqual(out.types(c), ['task.closed']);
  assert.equal(out.ofType(['task.opened', 'task.taken', 'task.done']).length, 0);
  assertTask(h, id2, { state: 'claimed', version: 2, attempts: 0, subscribers: [], claim: { nodeId: 'node-A', token: 2 } });
  assert.equal(h.publisherInfo('pub-1'), null, '宽限到期后删掉发布方记录');
});

test('F7.2 发布方断开：之后 A 完成 T2，T2 进 done，不发 task.done（没有订阅者），DONE_TTL 后删除', () => {
  const { h, ids: [, id2] } = setup({ tasks: [T1_IN, T2_IN] });
  claimOk(h, 'a', id2, 1);
  h.disconnect('p');
  h.at(T0 + GRACE + 1);
  h.bus.clear();

  const out = h.complete('a', id2, 2, { ranges: [[60, 119]] });
  const tc = h.now();
  assert.equal(out.one('a', 'task.completed').id, id2);
  assertClosed(out, WATCHERS, id2, 'done');
  assert.equal(out.ofType('task.done').length, 0);
  assertTask(h, id2, { state: 'done', version: 3, subscribers: [], claim: null, finishedAt: tc });

  h.at(tc + TTL).assertSilent();
  assertTask(h, id2, { state: 'done' });
  h.at(tc + TTL + 1).assertSilent('TTL 删除不发消息');
  assertTask(h, id2, null);
  assert.equal(h.bus.ofType('task.done').length, 0);
});

test('F7.3 发布方断开：T 有 P、Q 两个订阅者，P 宽限到期后 T 保留、订阅者只剩 Q，完成时只通知 Q', () => {
  const { h, id } = setup();
  h.publisher('q', 'pub-2', { userId: 'u2' });
  h.publish('q', [T_IN]);
  assertTask(h, id, { subscribers: ['pub-1', 'pub-2'] });
  h.bus.clear();

  h.disconnect('p');
  h.at(T0 + GRACE + 1).assertSilent('T 还有订阅者，不删');
  assertTask(h, id, { state: 'open', version: 1, subscribers: ['pub-2'] });
  assert.equal(h.publisherInfo('pub-1'), null);
  assert.equal(h.publisherInfo('pub-2').connected, true);

  // P 以同一身份再连上：记录已删，是新的发布方，不再是 T 的订阅者
  h.publisher('p2', 'pub-1');
  claimOk(h, 'a', id, 1);
  const out = h.complete('a', id, 2, { ranges: [[0, 59]] });
  assert.equal(out.one('q', 'task.done').id, id);
  assert.equal(out.of('p2', 'task.done').length, 0);
  assert.equal(out.ofType('task.done').length, 1);
});

test('F7.4 发布方断开：宽限期内以同一身份重连，订阅保留，不删任务', () => {
  const { h, id } = setup();
  h.disconnect('p');
  h.clock.set(T0 + 5_000);
  const hello = h.publisher('p2', 'pub-1');
  assert.equal(hello.one('p2', 'publisher.welcome').publisherId, 'pub-1');
  assert.deepEqual(h.publisherInfo('pub-1'), { publisherId: 'pub-1', connected: true, disconnectedAt: null });

  h.at(T0 + GRACE + 1).assertSilent('已重连，不删');
  assertTask(h, id, { state: 'open', version: 1, subscribers: ['pub-1'] });

  claimOk(h, 'a', id, 1);
  const out = h.complete('a', id, 2, { ranges: [[0, 59]] });
  assert.equal(out.one('p2', 'task.done').id, id, '完成通知发到新连接');
  assert.equal(out.ofType('task.done').length, 1);
});

/* ============================================================ F8 文档服务重启 */

/** Q1：P 发布 T，A 认领（t1 = 2）。Q2：新实例（新 epoch），同一批身份重连。 */
function restartSetup({ q1Done = false } = {}) {
  const h1 = createQueueHarness(createRenderQueue);
  h1.publisher('p', 'pub-1');
  h1.node('a', 'node-A');
  h1.publish('p', [T_IN]);
  claimOk(h1, 'a', T_IN.id, 1);
  if (q1Done) h1.complete('a', T_IN.id, 2, { ranges: [[0, 59]] });
  const h2 = createQueueHarness(createRenderQueue);
  return { h1, h2, id: T_IN.id };
}

test('F8.1 文档服务重启：新实例的 epoch 与旧的不同，hello 回包带新 epoch，任务表为空', () => {
  const { h1, h2 } = restartSetup();
  assert.equal(typeof h1.q.epoch, 'string');
  assert.equal(typeof h2.q.epoch, 'string');
  assert.ok(h2.q.epoch.length > 0);
  assert.notEqual(h2.q.epoch, h1.q.epoch);

  const ph = h2.publisher('p', 'pub-1');
  assert.equal(ph.one('p', 'publisher.welcome').epoch, h2.q.epoch);
  const nh = h2.node('a', 'node-A', { watch: null });
  const w = assertWelcome(nh, 'a', { nodeId: 'node-A', resumed: [], lost: [] });
  assert.equal(w.epoch, h2.q.epoch);
  assert.notEqual(w.epoch, h1.q.epoch);

  const d = h2.describe();
  assert.equal(d.epoch, h2.q.epoch);
  assert.deepEqual(d.tasks, []);
  const snap = h2.watch('a').one('a', 'queue.snapshot');
  assert.deepEqual(snap.tasks, []);
});

test('F8.2 文档服务重启：A 在新实例上 resume 旧认领，回 lease-lost（reason epoch）', () => {
  const { h2, id } = restartSetup();
  const out = h2.node('a', 'node-A', { resume: [{ id, token: 2 }], watch: null });
  assertWelcome(out, 'a', { nodeId: 'node-A', resumed: [], lost: [id] });
  const ll = assertLeaseLost(out, 'a', { id, token: 2, reason: 'epoch' });
  assert.equal(ll.epoch, h2.q.epoch);
  assert.deepEqual(h2.describe().tasks, []);
});

test('F8.3 文档服务重启：P 在新实例上重新发布 T，T 是 open、version 从 1 起，A 能正常认领', () => {
  const { h2, id } = restartSetup();
  h2.publisher('p', 'pub-1');
  h2.node('a', 'node-A');
  const out = h2.publish('p', [T_IN]);
  assert.deepEqual(out.one('p', 'task.published').results[0], { id, state: 'open', version: 1, created: true });
  assert.equal(out.one('a', 'task.opened').task.version, 1);
  assertTask(h2, id, { state: 'open', version: 1, attempts: 0, claim: null, subscribers: ['pub-1'] });
  const { msg } = claimOk(h2, 'a', id, 1);
  assert.equal(msg.token, 2);
  assertTask(h2, id, { state: 'claimed', version: 2, claim: { nodeId: 'node-A', token: 2 } });
});

test('F8.4 文档服务重启：T 在旧实例上已 done，新实例上重新发布是 open（新实例不知道旧的完成）', () => {
  const { h1, h2, id } = restartSetup({ q1Done: true });
  assertTask(h1, id, { state: 'done' });
  h2.publisher('p', 'pub-1');
  const out = h2.publish('p', [T_IN]);
  assert.deepEqual(out.one('p', 'task.published').results[0], { id, state: 'open', version: 1, created: true });
  assert.deepEqual(out.types('p'), ['task.published'], '不回 task.done');
  assertTask(h2, id, { state: 'open', version: 1, attempts: 0 });
});

/* ============================================================ F9 宽限期里两个节点都以为持有同一个任务 */

test('F9.1 宽限期里两个节点都以为持有同一个任务：A 断开的宽限期内 B 按当前 version 认领，回 taken，T 仍 claimed', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.disconnect('a');
  h.clock.set(T0 + 5_000);
  const out = h.claim('b', id, h.task(id).version);
  const rej = out.one('b', 'task.claim-rejected');
  assert.deepEqual([rej.id, rej.reason, rej.state, rej.version], [id, 'taken', 'claimed', 2]);
  assert.deepEqual(out.conns(), ['b']);
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2 } });
});

test('F9.2 宽限期里两个节点都以为持有同一个任务：宽限到期后 B 认领得 t2，A 带 t1 重连 resume 收到 lease-lost，只有 B 持有', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.disconnect('a');
  h.at(T0 + GRACE + 1);
  const { msg } = claimOk(h, 'b', id, 3);
  assert.equal(msg.token, 4);

  const out = h.node('a2', 'node-A', { resume: [{ id, token: 2 }], watch: null });
  assertWelcome(out, 'a2', { nodeId: 'node-A', resumed: [], lost: [id] });
  assertLeaseLost(out, 'a2', { id, token: 2, reason: 'not-owner' });
  assert.deepEqual(out.conns(), ['a2']);
  assertTask(h, id, { state: 'claimed', version: 4, attempts: 1, claim: { nodeId: 'node-B', token: 4 } });
  assert.equal(h.progress('b', id, 4, 1).one('b', 'task.renewed').token, 4, 'B 的令牌仍有效');
});

test('F9.3 宽限期里两个节点都以为持有同一个任务：A 用 t1 complete 回 lease-lost，只有 B 的 complete 生效，订阅者只收到一次 task.done', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.disconnect('a');
  h.at(T0 + GRACE + 1);
  claimOk(h, 'b', id, 3);
  h.node('a2', 'node-A', { resume: [{ id, token: 2 }], watch: null });

  const late = h.complete('a2', id, 2, { ranges: [[0, 59]] });
  assertLeaseLost(late, 'a2', { id, token: 2, reason: 'token' });
  assert.deepEqual(late.conns(), ['a2']);
  assertTask(h, id, { state: 'claimed', version: 4, claim: { nodeId: 'node-B', token: 4 } });

  const ok = h.complete('b', id, 4, { ranges: [[0, 59]] });
  assert.equal(ok.one('b', 'task.completed').id, id);
  assertTask(h, id, { state: 'done', version: 5, claim: null });
  assert.equal(h.bus.of('p', 'task.done').length, 1);
  assert.equal(h.bus.ofType('task.done').length, 1);
});
