/**
 * M2 渲染节点会话状态机（契约 B.5），外加一条「会话 × 真队列」联调（契约 C 节最后一行）。
 * 跑：node --test server/test/render-node-session.test.mjs
 *
 * 只照 `docs/plan/render-queue-contract.md`（下称「契约」）B.5、A 节消息格式和
 * `docs/plan/distributed-prerender-queue.md` 第 4、4.4 节写，不看实现。
 *
 * 单元部分：会话的 `send` 收进数组，队列的回包由测试手写（形状照契约 A.6 / A.7）。
 * 时钟是局部的假时钟；会话的 `random` 注入常数或固定种子的伪随机数，结果确定。
 *
 * 只断言契约写明了的东西。几处契约没写死、实现可以二选一的地方，测试特意绕开：
 *   - 认领成功后，会话自己的 `known()` 里还留不留这个任务（队列的 `task.taken` 只发给「其它」
 *     watch 者，所以这取决于会话自己）——凡是会受它影响的场景，都让两种做法得出同一个结果；
 *   - 出站消息除契约列出的字段外还带不带 `reqId`——只比对列出的字段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeSession } from '../render-node/session.mjs';
import { createRenderQueue, taskIdOf } from '../render-queue/index.mjs';

const FP = '0123456789abcdef';
const CV = 'c0de5a';
const EPOCH = 'epoch-test';
const LEASE = 30_000;       // 契约 A.2 的 LEASE_MS 缺省值，只用来给手写的回包填 leaseUntil
const RENEW = 10_000;       // 契约 A.2 的 RENEW_INTERVAL_MS 缺省值

const NODE = Object.freeze({
  profile: 'host', userId: 'u1', envFingerprint: FP, codeVersions: [CV], cardSourceVersions: {},
  capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 8000 },
});

/** 造一个 open 的 TaskView（契约 A.4）。 */
function view(name, { projectId = 'p1', priority = 10, publishedAt = 1, version = 1, userId = 'u1', weight = 'medium', requires = {} } = {}) {
  return {
    id: `snapshot:${name}:0-59`, kind: 'snapshot', tier: 'shared', resultKey: name,
    range: { unit: 'localFrame', from: 0, to: 59 },
    source: { userId, tenantId: 't1', projectId, projectRev: 1, publisher: { id: 'P' }, publishedAt, derivedFrom: null },
    // M7 D4（filter.mjs 规则 7）：纯浏览器只收共享档的独立卡，切分方在浏览器那一份里写 input.compositing
    input: { compositing: 'independent' }, weight: { class: weight, estMs: null, frames: 60 },
    requires: { envFingerprint: FP, codeVersion: CV, ...requires },
    priority, state: 'open', version, attempts: 0,
  };
}

// 队列发来的消息（契约 A.6 / A.7；都带 epoch）
const msg = {
  snapshot: tasks => ({ type: 'queue.snapshot', epoch: EPOCH, tasks }),
  opened: task => ({ type: 'task.opened', epoch: EPOCH, task }),
  taken: (id, version) => ({ type: 'task.taken', epoch: EPOCH, id, version }),
  closed: (id, state) => ({ type: 'task.closed', epoch: EPOCH, id, state }),
  claimed: (task, token, at) => ({
    type: 'task.claimed', epoch: EPOCH, id: task.id, token, version: token, leaseUntil: at + LEASE,
    task: { ...task, state: 'claimed', version: token },
  }),
  rejected: (id, reason, extra = {}) => ({ type: 'task.claim-rejected', epoch: EPOCH, id, reason, ...extra }),
  leaseLost: (id, token, reason) => ({ type: 'task.lease-lost', epoch: EPOCH, id, token, reason }),
  welcome: (nodeId, resumed, lost) => ({ type: 'node.welcome', epoch: EPOCH, nodeId, resumed, lost }),
  renewed: (id, token, at) => ({ type: 'task.renewed', epoch: EPOCH, id, token, leaseUntil: at + LEASE }),
};

/** 只取出契约列出的字段来比对。 */
const fields = (m, keys) => Object.fromEntries(keys.map(k => [k, m[k]]));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 一个会话加上它的假时钟、发件箱、回调记录。缺省已经 start() 过、发件箱已清空。
 * `over` 覆盖 createNodeSession 的参数。
 */
function harness(over = {}, { start = true } = {}) {
  let t = 1_000;
  let idle = true;
  const sent = [], started = [], lost = [];
  const session = createNodeSession({
    nodeId: 'node-1', node: NODE, send: m => sent.push(m), now: () => t, random: () => 0,
    isIdle: () => idle,
    onTask: (task, info) => started.push({ task, info }),
    onLost: (id, reason) => lost.push({ id, reason }),
    ...over,
  });
  const h = {
    session, sent, started, lost,
    get now() { return t; },
    set: ms => { t = ms; },
    advance: ms => { t += ms; },
    setIdle: v => { idle = v; },
    /** 取出并清空发件箱里某种（或全部）消息。 */
    drain(type) {
      const out = type ? sent.filter(m => m.type === type) : sent.slice();
      sent.length = 0;
      return out;
    },
    of: type => sent.filter(m => m.type === type),
    /** tick 一次，回这次发出的 task.claim。 */
    tickClaims() { sent.length = 0; session.tick(); return sent.filter(m => m.type === 'task.claim'); },
    /** 按契约完成一次认领往返：tick → 必须恰好一条 task.claim → 回 task.claimed。回 token。 */
    claim(task, token) {
      const claims = h.tickClaims();
      assert.equal(claims.length, 1, '这次 tick 应当恰好发一条认领');
      assert.equal(claims[0].id, task.id, `应当认领 ${task.id}，实际 ${claims[0].id}`);
      session.receive(msg.claimed(task, token, t));
      sent.length = 0;
      return token;
    },
  };
  if (start) { session.start(); sent.length = 0; }
  return h;
}

// ---------------------------------------------------------------- start

test('B.5 start：先发 node.hello（带节点描述与 resume），紧接着发 queue.watch { projects: \'all\' }', () => {
  const h = harness({}, { start: false });
  h.session.start();
  assert.equal(h.sent.length, 2, '恰好两条');
  const [hello, watch] = h.sent;
  assert.equal(hello.type, 'node.hello');
  assert.deepEqual(fields(hello, ['nodeId', 'profile', 'envFingerprint', 'capabilities', 'codeVersions', 'maxConcurrent', 'resume']), {
    nodeId: 'node-1', profile: 'host', envFingerprint: FP, capabilities: NODE.capabilities, codeVersions: [CV], maxConcurrent: 1, resume: [],
  });
  assert.equal(watch.type, 'queue.watch');
  assert.equal(watch.projects, 'all');
});

test('B.5 start：resume 原样带上；maxConcurrent、projects 取自参数', () => {
  const h = harness({ maxConcurrent: 3, projects: ['p1', 'p2'] }, { start: false });
  const resume = [{ id: 'snapshot:a:0-59', token: 4 }, { id: 'snapshot:b:0-59', token: 9 }];
  h.session.start(resume);
  assert.deepEqual(h.sent.map(m => m.type), ['node.hello', 'queue.watch']);
  assert.deepEqual(h.sent[0].resume, resume);
  assert.equal(h.sent[0].maxConcurrent, 3);
  assert.deepEqual(h.sent[1].projects, ['p1', 'p2']);
});

// ---------------------------------------------------------------- 本地视图

test('B.5 本地视图：queue.snapshot 整体替换，known() 按 id 升序', () => {
  const { session } = harness();
  const a = view('a'), b = view('b'), c = view('c');
  session.receive(msg.snapshot([c, a]));
  assert.deepEqual(session.known().map(t => t.id), [a.id, c.id]);
  session.receive(msg.snapshot([b]));
  assert.deepEqual(session.known().map(t => t.id), [b.id], '旧的全部换掉');
  assert.deepEqual(session.known()[0], b);
  session.receive(msg.snapshot([]));
  assert.deepEqual(session.known(), []);
});

test('B.5 本地视图：task.opened 加入；同 id 再来一次是更新，不重复', () => {
  const { session } = harness();
  const a = view('a'), b = view('b');
  session.receive(msg.snapshot([b]));
  session.receive(msg.opened(a));
  assert.deepEqual(session.known().map(t => t.id), [a.id, b.id]);
  session.receive(msg.opened({ ...a, version: 3, priority: 50 }));
  assert.equal(session.known().length, 2);
  const got = session.known().find(t => t.id === a.id);
  assert.equal(got.version, 3);
  assert.equal(got.priority, 50);
});

test('B.5 本地视图：task.taken、task.closed（done / failed / removed）移除', () => {
  const { session } = harness();
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(n => view(n));
  session.receive(msg.snapshot([a, b, c, d, e]));
  session.receive(msg.taken(a.id, 2));
  session.receive(msg.closed(b.id, 'done'));
  session.receive(msg.closed(c.id, 'failed'));
  session.receive(msg.closed(d.id, 'removed'));
  assert.deepEqual(session.known().map(t => t.id), [e.id]);
  // 不认识的 id 不影响
  session.receive(msg.taken('snapshot:zz:0-59', 7));
  session.receive(msg.closed('snapshot:zz:0-59', 'done'));
  assert.deepEqual(session.known().map(t => t.id), [e.id]);
});

// ---------------------------------------------------------------- 认领

test('B.5 认领：tick 发 task.claim { id, expectVersion: task.version }；一次 tick 至多一条', () => {
  const h = harness({ maxConcurrent: 3 });
  const tasks = [view('a', { publishedAt: 1, version: 4, projectId: 'p1' }), view('b', { publishedAt: 2, projectId: 'p2' }), view('c', { publishedAt: 3, projectId: 'p3' })];
  h.session.receive(msg.snapshot(tasks));
  const claims = h.tickClaims();
  assert.equal(claims.length, 1);
  assert.deepEqual(fields(claims[0], ['type', 'id', 'expectVersion']), { type: 'task.claim', id: tasks[0].id, expectVersion: 4 });
});

test('B.5 认领：在 filterClaimable 通过的任务上按 pickCandidate 挑（优先级高的先）', () => {
  const h = harness();
  const low = view('low', { priority: 10, publishedAt: 1 });
  const high = view('high', { priority: 50, publishedAt: 9 });
  const wrongEnv = view('wrong-env', { priority: 100, requires: { envFingerprint: 'ffffffffffffffff' } });
  const wrongCode = view('wrong-code', { priority: 100, requires: { codeVersion: 'other' } });
  h.session.receive(msg.snapshot([low, wrongEnv, high, wrongCode]));
  const claims = h.tickClaims();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].id, high.id);
});

test('B.5 认领：没有可认领的任务时 tick 什么都不发', () => {
  const h = harness();
  h.session.tick();
  assert.deepEqual(h.drain(), []);
  h.session.receive(msg.snapshot([view('x', { requires: { envFingerprint: 'ffffffffffffffff' } })]));
  h.session.tick();
  assert.deepEqual(h.drain(), []);
});

test('B.5 认领：browser 节点不认领别的用户的、heavy 的、plan 的任务（经 filterClaimable）', () => {
  const browser = { ...NODE, profile: 'browser', userId: 'u1', capabilities: { transcode: false, userCards: false, graphCards: false } };
  const h = harness({ node: browser });
  const others = view('others', { priority: 100, userId: 'u2' });
  const heavy = view('heavy', { priority: 100, weight: 'heavy' });
  const plan = { ...view('plan'), id: 'plan:p1@1', kind: 'plan', resultKey: 'p1@1', range: null, priority: 100, requires: {} };
  delete plan.tier;
  const mine = view('mine', { priority: 1 });
  h.session.receive(msg.snapshot([others, heavy, plan, mine]));
  const claims = h.tickClaims();
  assert.deepEqual(claims.map(m => m.id), [mine.id]);
});

test('B.5 认领：有在飞的认领时 tick 不再认领，哪怕 maxConcurrent 还有余量', () => {
  const h = harness({ maxConcurrent: 3 });
  h.session.receive(msg.snapshot([view('a', { projectId: 'p1' }), view('b', { projectId: 'p2' }), view('c', { projectId: 'p3' })]));
  assert.equal(h.tickClaims().length, 1);
  assert.equal(h.tickClaims().length, 0, '在飞中');
  h.advance(5_000);
  assert.equal(h.tickClaims().length, 0, '时间过去了也还在飞');
});

test('B.5 认领结果 task.claimed：加入持有（lastSentAt = now）、清在飞、调 onTask(task, { token })', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  const [claim] = h.tickClaims();
  assert.equal(claim.id, a.id);
  h.advance(40);
  const reply = msg.claimed(a, 2, h.now);
  h.session.receive(reply);
  assert.deepEqual(h.session.held(), [{ id: a.id, token: 2, lastSentAt: h.now }]);
  assert.equal(h.started.length, 1);
  assert.deepEqual(h.started[0].task, reply.task);
  assert.equal(h.started[0].info.token, 2);
  // 在飞已清：还有余量就接着认领（第二条，且是别的项目）
  const next = h.tickClaims();
  assert.deepEqual(next.map(m => m.id), [b.id]);
});

test('B.5 认领：持有数达到 maxConcurrent（缺省 1）后不再认领', () => {
  const h = harness();
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  assert.equal(h.tickClaims().length, 0);
  h.advance(1_000);
  assert.equal(h.tickClaims().length, 0);
});

test('B.5 认领：maxConcurrent 为 2 时逐个认领到 2 个为止', () => {
  const h = harness({ maxConcurrent: 2 });
  const [a, b, c] = [['a', 'p1'], ['b', 'p2'], ['c', 'p3']].map(([n, p], i) => view(n, { projectId: p, publishedAt: i + 1 }));
  h.session.receive(msg.snapshot([a, b, c]));
  h.claim(a, 2);
  h.claim(b, 2);
  assert.equal(h.tickClaims().length, 0, '持有 2 个，满了');
  assert.deepEqual(h.session.held().map(x => x.id).sort(), [a.id, b.id].sort());
});

test('B.5 claim-rejected stale：把本地任务的 version 改成回包的 version，清在飞，下次 tick 按新版本再认领', () => {
  const h = harness();
  const a = view('a', { version: 1 });
  h.session.receive(msg.snapshot([a]));
  assert.deepEqual(h.tickClaims().map(m => [m.id, m.expectVersion]), [[a.id, 1]]);
  h.session.receive(msg.rejected(a.id, 'stale', { state: 'open', version: 4 }));
  assert.equal(h.session.known().find(t => t.id === a.id)?.version, 4);
  assert.deepEqual(h.tickClaims().map(m => [m.id, m.expectVersion]), [[a.id, 4]]);
  assert.equal(h.started.length, 0, '被拒不调 onTask');
});

for (const reason of ['taken', 'gone', 'forbidden']) {
  test(`B.5 claim-rejected ${reason}：从本地视图移除、清在飞，下次 tick 认领别的`, () => {
    const h = harness();
    const a = view('a', { publishedAt: 1 }), b = view('b', { publishedAt: 2, version: 3 });
    h.session.receive(msg.snapshot([a, b]));
    assert.deepEqual(h.tickClaims().map(m => m.id), [a.id]);
    const extra = reason === 'taken' ? { state: 'claimed', version: 2 } : {};
    h.session.receive(msg.rejected(a.id, reason, extra));
    assert.deepEqual(h.session.known().map(t => t.id), [b.id]);
    assert.deepEqual(h.tickClaims().map(m => [m.id, m.expectVersion]), [[b.id, 3]]);
    assert.equal(h.started.length, 0);
    assert.deepEqual(h.session.held(), []);
  });
}

test('B.5 认领：lastProjectId 取上一次认领成功的项目，同优先级里换项目', () => {
  const h = harness({ maxConcurrent: 2 });
  // 排名：A(p1) B(p1) C(p2)，同优先级；random 恒为 0
  const a = view('a', { projectId: 'p1', publishedAt: 1 });
  const b = view('b', { projectId: 'p1', publishedAt: 2 });
  const c = view('c', { projectId: 'p2', publishedAt: 3 });
  h.session.receive(msg.snapshot([a, b, c]));
  h.claim(a, 2);
  // 上次成功的是 p1：同优先级里只留 p2 的 C
  assert.deepEqual(h.tickClaims().map(m => m.id), [c.id]);
});

test('B.5 认领：被拒的那次不算「认领成功」，不改 lastProjectId', () => {
  const h = harness();
  const a = view('a', { projectId: 'p1', publishedAt: 1 });
  const b = view('b', { projectId: 'p1', publishedAt: 2 });
  const c = view('c', { projectId: 'p2', publishedAt: 3 });
  h.session.receive(msg.snapshot([a, b, c]));
  assert.deepEqual(h.tickClaims().map(m => m.id), [a.id]);
  h.session.receive(msg.rejected(a.id, 'taken', { state: 'claimed', version: 2 }));
  // 从没成功过：不按项目过滤，random 0 取第一名 B
  assert.deepEqual(h.tickClaims().map(m => m.id), [b.id]);
});

test('B.5 认领：候选数 k 取 constants.PICK_K（缺省 4），random 取自参数', () => {
  const five = [1, 2, 3, 4, 5].map(n => view(`t${n}`, { publishedAt: n }));
  const pickWith = (over) => {
    const h = harness({ random: () => 0.999999, ...over });
    h.session.receive(msg.snapshot(five));
    return h.tickClaims().map(m => m.id);
  };
  assert.deepEqual(pickWith({}), [five[3].id], '缺省 K = 4');
  assert.deepEqual(pickWith({ constants: { PICK_K: 1 } }), [five[0].id]);
  assert.deepEqual(pickWith({ constants: { PICK_K: 5 } }), [five[4].id]);
  const mid = harness({ random: () => 0.5 });
  mid.session.receive(msg.snapshot(five));
  assert.deepEqual(mid.tickClaims().map(m => m.id), [five[2].id]);
});

test('B.5 不空闲：tick 不认领；恢复空闲后认领', () => {
  const h = harness();
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.setIdle(false);
  h.session.tick();
  assert.deepEqual(h.drain(), []);
  h.advance(RENEW * 3);
  h.session.tick();
  assert.deepEqual(h.drain(), []);
  h.setIdle(true);
  assert.deepEqual(h.tickClaims().map(m => m.id), [a.id]);
});

// ---------------------------------------------------------------- 续约

test('B.5 续约：now - lastSentAt >= RENEW_INTERVAL_MS 时才发 task.progress，done 没报过就是 null', () => {
  const h = harness();
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 2);
  const claimedAt = h.now;
  h.set(claimedAt + RENEW - 1);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress'), [], '差 1 ms 不发');
  h.set(claimedAt + RENEW);
  h.session.tick();
  const [p] = h.drain('task.progress');
  assert.deepEqual(fields(p, ['type', 'id', 'token', 'done']), { type: 'task.progress', id: a.id, token: 2, done: null });
  assert.equal(h.session.held()[0].lastSentAt, claimedAt + RENEW);
  // 刚续过：同一时刻、下一毫秒都不再发
  h.session.tick();
  h.advance(1);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress'), []);
  // 下一个整间隔
  h.set(claimedAt + 2 * RENEW);
  h.session.tick();
  assert.equal(h.drain('task.progress').length, 1);
});

test('B.5 续约：一次 tick 对每个持有的任务至多续一次；各自按自己的 lastSentAt 算', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  const tA = h.now;
  h.advance(3_000);
  h.claim(b, 7);
  const tB = h.now;
  h.set(tA + RENEW);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress').map(m => [m.id, m.token]), [[a.id, 2]]);
  h.set(tB + RENEW);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress').map(m => [m.id, m.token]), [[b.id, 7]]);
  // 大跨度跳过好几个间隔：每个任务也只发一条
  h.advance(RENEW * 5);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress').map(m => m.id).sort(), [a.id, b.id].sort());
});

test('B.5 续约：间隔取 constants.RENEW_INTERVAL_MS', () => {
  const h = harness({ constants: { RENEW_INTERVAL_MS: 1_000 } });
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 2);
  const t0 = h.now;
  h.set(t0 + 999);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress'), []);
  h.set(t0 + 1_000);
  h.session.tick();
  assert.equal(h.drain('task.progress').length, 1);
});

test('B.5 不空闲：不认领新任务，但照常续约', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  const t0 = h.now;
  h.setIdle(false);
  h.set(t0 + RENEW);
  h.session.tick();
  const out = h.drain();
  assert.deepEqual(out.map(m => [m.type, m.id]), [['task.progress', a.id]], '只续约，不认领 B');
});

test('B.5 progress()：记下进度并立即发 task.progress，刷新 lastSentAt；之后的续约带最近一次的值', () => {
  const h = harness();
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 2);
  const t0 = h.now;
  h.set(t0 + 4_000);
  h.session.progress(a.id, 12);
  const [p] = h.drain('task.progress');
  assert.deepEqual(fields(p, ['type', 'id', 'token', 'done']), { type: 'task.progress', id: a.id, token: 2, done: 12 });
  assert.equal(h.session.held()[0].lastSentAt, t0 + 4_000);
  h.set(t0 + 5_000);
  h.session.progress(a.id, 20);
  assert.deepEqual(h.drain('task.progress').map(m => m.done), [20]);
  // 续约从最近一次 progress() 起算
  h.set(t0 + 5_000 + RENEW - 1);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress'), []);
  h.set(t0 + 5_000 + RENEW);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress').map(m => [m.token, m.done]), [[2, 20]]);
});

test('B.5 progress()：没持有这个任务时不发', () => {
  const h = harness();
  h.session.progress('snapshot:nope:0-59', 3);
  assert.deepEqual(h.drain(), []);
});

// ---------------------------------------------------------------- 完成、失败、让路

test('B.5 complete()：发 task.complete { id, token, result }，本地移除持有，此后不再续约', () => {
  const h = harness();
  const a = view('a', { publishedAt: 1 }), b = view('b', { publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  const t0 = h.now;
  const result = { ranges: [[0, 59]] };
  h.session.complete(a.id, result);
  const out = h.drain();
  assert.equal(out.length, 1);
  assert.deepEqual(fields(out[0], ['type', 'id', 'token', 'result']), { type: 'task.complete', id: a.id, token: 2, result });
  assert.deepEqual(h.session.held(), []);
  // 真队列随后会给所有可见 watch 者（含本节点）发 task.closed
  h.session.receive(msg.closed(a.id, 'done'));
  h.set(t0 + RENEW * 2);
  const next = h.tickClaims();
  assert.deepEqual(h.of('task.progress'), []);
  assert.deepEqual(next.map(m => m.id), [b.id], '持有空了，可以认领下一个');
});

test('B.5 fail()：发 task.fail { id, token, error, retryable }（retryable 缺省 true），本地移除持有', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  h.claim(b, 5);
  const t0 = h.now;
  h.session.fail(a.id, 'boom');
  h.session.fail(b.id, 'bad input', false);
  const out = h.drain();
  assert.deepEqual(out.map(m => fields(m, ['type', 'id', 'token', 'error', 'retryable'])), [
    { type: 'task.fail', id: a.id, token: 2, error: 'boom', retryable: true },
    { type: 'task.fail', id: b.id, token: 5, error: 'bad input', retryable: false },
  ]);
  assert.deepEqual(h.session.held(), []);
  h.set(t0 + RENEW);
  h.session.tick();
  assert.deepEqual(h.of('task.progress'), []);
});

test('B.5 yieldAll()：对每个持有的任务发 task.release（reason 缺省 busy），本地清空持有', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  h.claim(b, 5);
  const t0 = h.now;
  h.session.yieldAll();
  const out = h.drain();
  assert.deepEqual(out.map(m => fields(m, ['type', 'id', 'token', 'reason'])).sort(byId), [
    { type: 'task.release', id: a.id, token: 2, reason: 'busy' },
    { type: 'task.release', id: b.id, token: 5, reason: 'busy' },
  ]);
  assert.deepEqual(h.session.held(), []);
  h.set(t0 + RENEW);
  h.setIdle(false);
  h.session.tick();
  assert.deepEqual(h.drain(), [], '不空闲：既没有续约也没有认领');
});

test('B.5 yieldAll(reason)：带上给定的 reason；没有持有时什么都不发', () => {
  const h = harness();
  h.session.yieldAll('playing');
  assert.deepEqual(h.drain(), []);
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 2);
  h.session.yieldAll('playing');
  assert.deepEqual(h.drain().map(m => fields(m, ['type', 'id', 'token', 'reason'])), [{ type: 'task.release', id: a.id, token: 2, reason: 'playing' }]);
});

// ---------------------------------------------------------------- 丢认领

test('B.5 task.lease-lost：移除持有、调 onLost(id, reason)，此后不再续约；别的持有不受影响', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  h.claim(b, 5);
  const t0 = h.now;
  h.session.receive(msg.leaseLost(a.id, 2, 'expired'));
  assert.deepEqual(h.lost, [{ id: a.id, reason: 'expired' }]);
  assert.deepEqual(h.session.held().map(x => x.id), [b.id]);
  h.set(t0 + RENEW);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress').map(m => m.id), [b.id]);
});

test('B.5 node.welcome 的 lost：同样移除持有、调 onLost；resumed 的照常持有、照常续约', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  h.claim(b, 5);
  const t0 = h.now;
  // 重连：拿手里的认领去 resume
  const resume = h.session.held().map(({ id, token }) => ({ id, token }));
  h.session.start(resume);
  const hello = h.drain('node.hello')[0];
  assert.deepEqual([...hello.resume].sort(byId), [{ id: a.id, token: 2 }, { id: b.id, token: 5 }]);
  h.session.receive(msg.welcome('node-1', [a.id], [b.id]));
  assert.ok(h.lost.some(x => x.id === b.id), 'b 调了 onLost');
  assert.ok(!h.lost.some(x => x.id === a.id), 'a 没丢');
  assert.deepEqual(h.session.held().map(x => x.id), [a.id]);
  h.set(t0 + RENEW);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress').map(m => [m.id, m.token]), [[a.id, 2]]);
});

test('B.5 其它回包（task.renewed、task.completed、task.released、task.fail-ack）不改持有', () => {
  const h = harness();
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 2);
  h.advance(3_000);
  const before = h.session.held();
  h.session.receive(msg.renewed(a.id, 2, h.now));
  h.session.receive({ type: 'task.completed', epoch: EPOCH, id: a.id });
  h.session.receive({ type: 'task.released', epoch: EPOCH, id: a.id });
  h.session.receive({ type: 'task.fail-ack', epoch: EPOCH, id: a.id, state: 'open' });
  assert.deepEqual(h.session.held(), before);
  assert.deepEqual(h.lost, []);
  assert.deepEqual(h.drain(), [], '这些回包不引出任何消息');
});

test('B.5 node.welcome 的 resumed：lastSentAt 置为 now - RENEW_INTERVAL_MS，下一次 tick 立即续约；lost 为空时不调 onLost（B.5 补充细则）', () => {
  const h = harness();
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 2);
  const t0 = h.now;
  h.session.progress(a.id, 7);
  // 断线后 2 秒重连，远不到一个续约间隔
  h.set(t0 + 2_000);
  h.session.start([{ id: a.id, token: 2 }]);
  h.drain();
  h.session.receive(msg.welcome('node-1', [a.id], []));
  assert.deepEqual(h.lost, []);
  assert.deepEqual(h.session.held(), [{ id: a.id, token: 2, lastSentAt: t0 + 2_000 - RENEW }]);
  h.session.tick();
  const progress = h.drain('task.progress');
  assert.equal(progress.length, 1, '不等满间隔，立即续约');
  assert.deepEqual(fields(progress[0], ['id', 'token']), { id: a.id, token: 2 });
  assert.equal(h.session.held()[0].lastSentAt, t0 + 2_000);
});

test('B.5 welcome.lost 之后同 id 的 task.lease-lost 不再重复调 onLost；welcome.lost 的 reason 是 lost（B.5 补充细则）', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  h.claim(b, 5);
  h.session.start([{ id: a.id, token: 2 }, { id: b.id, token: 5 }]);
  h.session.receive(msg.welcome('node-1', [a.id], [b.id]));
  h.session.receive(msg.leaseLost(b.id, 5, 'token'));
  assert.deepEqual(h.lost, [{ id: b.id, reason: 'lost' }]);
  assert.deepEqual(h.session.held().map(x => x.id), [a.id]);
});

test('B.5 task.lease-lost 的 token 与持有的不符时忽略（旧认领的迟到消息，B.5 补充细则）', () => {
  const h = harness();
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 5);
  const before = h.session.held();
  h.session.receive(msg.leaseLost(a.id, 2, 'expired'));
  assert.deepEqual(h.lost, []);
  assert.deepEqual(h.session.held(), before);
  // 令牌相符的照常处理
  h.session.receive(msg.leaseLost(a.id, 5, 'expired'));
  assert.deepEqual(h.lost, [{ id: a.id, reason: 'expired' }]);
  assert.deepEqual(h.session.held(), []);
});

// ---------------------------------------------------------------- 联调：会话 × 真队列

/** 固定种子的伪随机数（mulberry32），[0, 1)。 */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** 20 个合法的 TaskInput（契约 A.4），两个项目交替，前 4 个高优先级。 */
function taskInputs(n = 20) {
  return Array.from({ length: n }, (_, i) => {
    const resultKey = `rk-${String(i).padStart(2, '0')}`;
    const range = { unit: 'localFrame', from: 0, to: 59 };
    return {
      id: taskIdOf({ kind: 'snapshot', resultKey, range }), kind: 'snapshot', tier: 'shared', resultKey, range,
      source: { projectId: i % 2 ? 'pA' : 'pB', projectRev: 1 },
      input: { clipId: `clip-${i}` },
      weight: { class: 'medium', estMs: null, frames: 60 },
      requires: { envFingerprint: FP, codeVersion: CV },
      priority: i < 4 ? 50 : 10,
    };
  });
}

/**
 * 一个真队列、一个发布方、两个节点会话，消息经「线路」（structuredClone）往返。
 * 每一步：时钟前进 → 队列 tick → 节点报进度 / 报完成 → 两个会话**都** tick 完再统一投递，
 * 这样两个节点常常基于同一份视图去抢同一个任务，撞出 taken。
 */
function jointRig({ workMs = i => 1_000 + (i % 5) * 250 } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const toQueue = [];          // [connId, message]
  const toConn = new Map();    // connId → message[]
  const publisherInbox = [];
  const queue = createRenderQueue({
    now, epoch: 'epoch-joint',
    send: (connId, m) => { if (!toConn.has(connId)) toConn.set(connId, []); toConn.get(connId).push(structuredClone(m)); },
  });
  const principal = { userId: 'u1', tenantId: 't1' };
  queue.connect('conn-pub', principal);
  queue.handle('conn-pub', { type: 'publisher.hello', publisherId: 'P' });

  const inputs = taskInputs();
  const indexOf = new Map(inputs.map((x, i) => [x.id, i]));
  const nodes = ['node-a', 'node-b'].map((nodeId, k) => {
    const connId = `conn-${nodeId}`;
    queue.connect(connId, principal);
    const rec = { nodeId, connId, idle: true, work: new Map(), started: [], completed: [], lost: [] };
    rec.session = createNodeSession({
      nodeId, node: NODE, now, random: seeded(k + 7), maxConcurrent: 2,
      isIdle: () => rec.idle,
      send: m => toQueue.push([connId, structuredClone(m)]),
      onTask: (task, { token }) => {
        rec.started.push(task.id);
        rec.work.set(task.id, { token, startedAt: t, finishAt: t + workMs(indexOf.get(task.id)) });
      },
      onLost: (id, reason) => { rec.lost.push({ id, reason }); rec.work.delete(id); },
    });
    return rec;
  });
  const byConn = new Map(nodes.map(n => [n.connId, n]));

  function pump() {
    for (let guard = 0; guard < 100_000; guard++) {
      if (toQueue.length) { const [connId, m] = toQueue.shift(); queue.handle(connId, m); continue; }
      let delivered = false;
      for (const [connId, box] of toConn) {
        while (box.length) {
          const m = box.shift();
          delivered = true;
          if (connId === 'conn-pub') publisherInbox.push(m);
          else byConn.get(connId).session.receive(m);
        }
      }
      if (!delivered) return;
    }
    throw new Error('消息往返不收敛');
  }
  const publish = tasks => { queue.handle('conn-pub', { type: 'task.publish', tasks }); pump(); };

  function step(ms = 250) {
    t += ms;
    queue.tick();
    pump();
    for (const n of nodes) {
      for (const [id, w] of [...n.work]) {
        if (t >= w.finishAt) {
          n.work.delete(id);
          n.completed.push(id);
          n.session.complete(id, { ranges: [[0, 59]] });
        } else {
          n.session.progress(id, Math.floor((t - w.startedAt) / 50));
        }
      }
    }
    pump();
    for (const n of nodes) n.session.tick();
    pump();
  }
  const doneIds = () => publisherInbox.filter(m => m.type === 'task.done').map(m => m.id);
  const finished = () => new Set(doneIds()).size === inputs.length && nodes.every(n => n.work.size === 0 && n.session.held().length === 0);
  return { queue, nodes, inputs, publish, pump, step, finished, doneIds, publisherInbox, get now() { return t; } };
}

/** 数组里每个元素出现几次。 */
const counts = list => list.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());

test('B.5 联调：两个会话对同一个真队列抢 20 个任务，每个任务恰好完成一次', () => {
  const rig = jointRig();
  // 一半在节点报到之前发布（经 queue.snapshot 到达），一半之后（经 task.opened 到达）
  rig.publish(rig.inputs.slice(0, 10));
  for (const n of rig.nodes) n.session.start();
  rig.pump();
  let steps = 0;
  for (; steps < 2_000 && !rig.finished(); steps++) {
    if (steps === 3) rig.publish(rig.inputs.slice(10));
    rig.step();
  }
  assert.ok(rig.finished(), `${steps} 步内没做完：完成 ${new Set(rig.doneIds()).size}/20`);

  const ids = rig.inputs.map(x => x.id).sort();
  // 发布方：每个任务恰好一条 task.done
  const doneCount = counts(rig.doneIds());
  assert.deepEqual([...doneCount.keys()].sort(), ids);
  for (const [id, c] of doneCount) assert.equal(c, 1, `${id} 收到 ${c} 条 task.done`);
  // 节点：合起来每个任务恰好开工一次、完成一次；没有丢认领
  const started = rig.nodes.flatMap(n => n.started), completed = rig.nodes.flatMap(n => n.completed);
  assert.deepEqual([...started].sort(), ids, '每个任务恰好 onTask 一次');
  assert.deepEqual([...completed].sort(), ids, '每个任务恰好 complete 一次');
  for (const n of rig.nodes) assert.deepEqual(n.lost, [], `${n.nodeId} 不应丢认领`);
  // 两个节点都干了活（各自 maxConcurrent 2，一个节点吃不下 20 个）
  for (const n of rig.nodes) assert.ok(n.completed.length > 0, `${n.nodeId} 一个都没做`);
  // 队列：全部 done；open(1) → claimed(2) → done(3)；attempts 0
  const view = rig.queue.describe();
  assert.equal(view.tasks.length, 20);
  for (const task of view.tasks) {
    assert.equal(task.state, 'done', task.id);
    assert.equal(task.version, 3, `${task.id} version`);
    assert.equal(task.attempts, 0, `${task.id} attempts`);
  }
});

test('B.5 联调：一个节点中途不空闲并 yieldAll，放回的任务被接手，每个任务仍恰好完成一次', () => {
  const rig = jointRig({ workMs: i => 2_000 + (i % 3) * 500 });
  rig.publish(rig.inputs);
  for (const n of rig.nodes) n.session.start();
  rig.pump();
  const [yielder] = rig.nodes;
  const yielded = [];
  let resumeAt = null, steps = 0;
  for (; steps < 2_000 && !rig.finished(); steps++) {
    rig.step();
    // 第一次看到让路节点手里有活时：用户开始播放 → 不空闲、放回全部、调用方丢弃手里的活
    if (resumeAt === null && steps >= 2 && yielder.session.held().length > 0) {
      yielder.idle = false;
      for (const h of yielder.session.held()) yielded.push(h.id);
      yielder.session.yieldAll('playing');
      yielder.work.clear();
      rig.pump();
      resumeAt = steps + 8;
    }
    if (steps === resumeAt) yielder.idle = true;
  }
  assert.ok(yielded.length > 0, '让路节点应当放回过任务');
  assert.ok(rig.finished(), `${steps} 步内没做完：完成 ${new Set(rig.doneIds()).size}/20`);

  const ids = rig.inputs.map(x => x.id).sort();
  const doneCount = counts(rig.doneIds());
  assert.deepEqual([...doneCount.keys()].sort(), ids);
  for (const [id, c] of doneCount) assert.equal(c, 1, `${id} 收到 ${c} 条 task.done`);
  const completed = rig.nodes.flatMap(n => n.completed);
  assert.deepEqual([...completed].sort(), ids, '每个任务恰好 complete 一次');
  // 放回的任务多开工一次，别的恰好一次
  const started = counts(rig.nodes.flatMap(n => n.started));
  for (const id of ids) assert.equal(started.get(id), yielded.includes(id) ? 2 : 1, `${id} 开工次数`);
  for (const n of rig.nodes) assert.deepEqual(n.lost, [], `${n.nodeId} 不应丢认领`);

  // 放回不算失败（C2）：attempts 全是 0；放回的多两次状态转移
  const view = rig.queue.describe();
  for (const task of view.tasks) {
    assert.equal(task.state, 'done', task.id);
    assert.equal(task.attempts, 0, `${task.id} attempts`);
    assert.equal(task.version, yielded.includes(task.id) ? 5 : 3, `${task.id} version`);
  }
});
