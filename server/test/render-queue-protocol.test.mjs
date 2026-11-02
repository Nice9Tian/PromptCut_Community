/**
 * 渲染任务队列（M1）协议用例 P1～P14，另加 P15（契约 A.4 末段「派生任务的继承」，定稿后补充）、
 * P16（A.4「已存在的同 id 任务」，M3 裁定后补充）。
 * 跑：node --test server/test/render-queue-protocol.test.mjs
 *
 * 依据：`docs/plan/render-queue-contract.md` A 节（契约）、`docs/plan/distributed-prerender-queue.md` 第 3、4 节与 5.1 节
 * C1～C6（设计）、`docs/plan/TASK-distributed-prerender-queue.md` 5.2 节「协议用例」（矩阵）。
 * 只经契约 A.3 的公开接口驱动；`describe()` 是公开接口，用来核对状态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue, QUEUE_DEFAULTS, QUEUE_ENV, taskIdOf } from '../render-queue/index.mjs';
import { createFakeClock, createQueueHarness, makeTaskInput, T0 } from './fake-render-queue-env.mjs';

const LEASE = 30_000;
const GRACE = 10_000;
const TTL = 600_000;

const T_IN = makeTaskInput({ resultKey: 'rk1' });

/** 发布方 P（u1）、节点 A、B（pc）、W（pc；M6c X3 之前是 host），都 watch all；P 发布 `tasks`。 */
function setup({ tasks = [T_IN], ...options } = {}) {
  const h = createQueueHarness(createRenderQueue, options);
  h.publisher('p', 'pub-1');
  h.node('a', 'node-A');
  h.node('b', 'node-B');
  h.node('w', 'node-W', { profile: 'pc' });   // M6c X3：host 的 watch 'all' 只收摘要，只看不做的 W 改用 pc（原为 host）
  if (tasks.length) h.publish('p', tasks);
  h.bus.clear();
  return { h, id: tasks[0]?.id };
}

function claimOk(h, conn, id, expectVersion) {
  const m = h.claim(conn, id, expectVersion).one(conn, 'task.claimed');
  assert.equal(m.token, expectVersion + 1);
  return m;
}

function rejected(out, conn, id) {
  const m = out.one(conn, 'task.claim-rejected');
  assert.equal(m.id, id);
  return m;
}

/** 一条消息涉及的任务 id（可见性检查用）。 */
function taskIdsIn(m) {
  if (m.type === 'queue.snapshot') return m.tasks.map(t => t.id);
  if (m.type === 'task.opened') return [m.task.id];
  if (m.type === 'task.taken' || m.type === 'task.closed') return [m.id];
  return [];
}

/* ------------------------------------------------------------ P1～P4 认领 */

test('P1 Two nodes claim the same open task with the same expectVersion one after the other: the first to arrive gets claimed, the later one gets taken, and version is incremented only once', () => {
  const { h, id } = setup();
  const first = h.claim('a', id, 1);
  const c = first.one('a', 'task.claimed');
  assert.deepEqual([c.id, c.token, c.version, c.leaseUntil], [id, 2, 2, T0 + LEASE]);
  // TaskView：认领后的视图，不含 claim / subscribers（契约 A.4）
  assert.equal(c.task.id, id);
  assert.equal(c.task.state, 'claimed');
  assert.equal(c.task.version, 2);
  assert.equal('claim' in c.task, false);
  assert.equal('subscribers' in c.task, false);
  // 其它可见 watch 者收到 task.taken，认领者自己不收
  for (const conn of ['b', 'w']) {
    const t = first.one(conn, 'task.taken');
    assert.deepEqual([t.id, t.version], [id, 2]);
  }
  assert.equal(first.of('a', 'task.taken').length, 0);
  assert.deepEqual(first.conns(), ['a', 'b', 'w']);

  const second = h.claim('b', id, 1);
  const r = rejected(second, 'b', id);
  assert.deepEqual([r.reason, r.state, r.version], ['taken', 'claimed', 2]);
  assert.deepEqual(second.conns(), ['b'], 'A rejection is not broadcast');

  const t = h.task(id);
  assert.deepEqual([t.state, t.version, t.claim.nodeId, t.claim.token], ['claimed', 2, 'node-A', 2]);
});

test('P2 A node claims with an old expectVersion (the task was reclaimed and reopened): stale, the reply carries the current version; claiming again with the new version succeeds', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.at(T0 + LEASE + 1);
  assert.equal(h.task(id).version, 3);
  h.bus.clear();

  const out = h.claim('b', id, 1);
  const r = rejected(out, 'b', id);
  assert.deepEqual([r.reason, r.state, r.version], ['stale', 'open', 3]);
  assert.deepEqual(out.conns(), ['b']);
  const t = h.task(id);
  assert.deepEqual([t.state, t.version, t.claim], ['open', 3, null]);

  const ok = claimOk(h, 'b', id, 3);
  assert.equal(ok.version, 4);
  assert.equal(h.task(id).claim.nodeId, 'node-B');
});

test('P3 Claiming a nonexistent task: gone', () => {
  const { h } = setup();
  const ghost = 'snapshot:nope:0-59';
  const out = h.claim('a', ghost, 1);
  assert.equal(rejected(out, 'a', ghost).reason, 'gone');
  assert.deepEqual(out.conns(), ['a']);
  assert.equal(h.task(ghost), null);

  // TTL 删掉之后同样是 gone
  const { h: h2, id } = setup();
  claimOk(h2, 'a', id, 1);
  h2.complete('a', id, 2, { ranges: [[0, 59]] });
  h2.at(T0 + TTL + 1);
  assert.equal(h2.task(id), null);
  assert.equal(rejected(h2.claim('b', id, 3), 'b', id).reason, 'gone');
});

test('P4 A browser-only node claims a task of another user in the same tenant: forbidden, with no state / version, state unchanged', () => {
  const { h, id } = setup();
  h.node('br', 'node-BR', { profile: 'browser', userId: 'u2', tenantId: 't1' });
  h.node('bo', 'node-BO', { profile: 'browser', userId: 'u1', tenantId: 't1' });
  h.bus.clear();

  const before = h.describe();
  const out = h.claim('br', id, 1);
  const r = rejected(out, 'br', id);
  assert.equal(r.reason, 'forbidden');
  assert.equal('state' in r, false, 'forbidden carries no state');
  assert.equal('version' in r, false, 'forbidden carries no version');
  assert.deepEqual(out.conns(), ['br']);
  assert.deepEqual(h.describe(), before, 'state unchanged');

  // 不存在的任务先判 gone（契约 A.7.2 第 1 步在第 2 步之前）
  assert.equal(rejected(h.claim('br', 'snapshot:nope:0-1', 1), 'br', 'snapshot:nope:0-1').reason, 'gone');

  // 任务已被认领时仍是 forbidden：第 2 步在第 3 步（taken）之前
  claimOk(h, 'a', id, 1);
  const r2 = rejected(h.claim('br', id, 2), 'br', id);
  assert.equal(r2.reason, 'forbidden');
  assert.equal('state' in r2, false);

  // 同一用户的纯浏览器节点：按常规判（这里是 taken）；任务 open 时能认领
  assert.equal(rejected(h.claim('bo', id, 2), 'bo', id).reason, 'taken');
  const T2 = makeTaskInput({ resultKey: 'rk2' });
  h.publish('p', [T2]);
  claimOk(h, 'bo', T2.id, 1);
});

/* ------------------------------------------------------------ P5～P7 身份与可见性 */

test('P5 Browser-only node watch: queue.snapshot and incremental updates contain only the user\'s own tasks, and opened / taken / closed of other users\' tasks are never received', () => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('p1', 'pub-1', { userId: 'u1', tenantId: 't1' });
  h.publisher('p2', 'pub-2', { userId: 'u2', tenantId: 't1' });
  const U1a = makeTaskInput({ resultKey: 'u1a' });
  const U2a = makeTaskInput({ resultKey: 'u2a' });
  h.publish('p1', [U1a]);
  h.publish('p2', [U2a]);

  const br2 = h.node('br2', 'node-BR2', { profile: 'browser', userId: 'u2', watch: ['proj-1', 'proj-2'] });   // M6c X3：纯浏览器不能 watch 'all'，改列出本用例用到的两个项目（原为 'all'）
  assert.deepEqual(br2.one('br2', 'queue.snapshot').tasks.map(t => t.id), [U2a.id]);
  assert.equal(br2.one('br2', 'queue.snapshot').tasks[0].source.userId, 'u2');
  const a = h.node('a', 'node-A', { profile: 'pc', userId: 'u9' });
  assert.deepEqual(a.one('a', 'queue.snapshot').tasks.map(t => t.id).sort(), [U1a.id, U2a.id].sort(), 'pc does not filter by user');
  const br1 = h.node('br1', 'node-BR1', { profile: 'browser', userId: 'u1', watch: ['proj-1'] });
  assert.deepEqual(br1.one('br1', 'queue.snapshot').tasks.map(t => t.id), [U1a.id]);
  const x = h.node('x', 'node-X', { profile: 'host', userId: 'u9', watch: ['proj-2'] });
  assert.deepEqual(x.one('x', 'queue.snapshot').tasks, [], 'Contains only the watched projects');

  // 增量：opened
  const U1b = makeTaskInput({ resultKey: 'u1b' });
  let out = h.publish('p1', [U1b]);
  assert.deepEqual(out.conns().filter(c => c !== 'p1').sort(), ['a', 'br1']);
  const U2b = makeTaskInput({ resultKey: 'u2b' });
  out = h.publish('p2', [U2b]);
  assert.deepEqual(out.conns().filter(c => c !== 'p2').sort(), ['a', 'br2']);
  const U2c = makeTaskInput({ projectId: 'proj-2', resultKey: 'u2c' });
  out = h.publish('p2', [U2c]);
  assert.deepEqual(out.conns().filter(c => c !== 'p2').sort(), ['a', 'br2', 'x'], 'br1 watches only proj-1');

  // 增量：taken
  out = h.claim('a', U1a.id, 1);
  assert.deepEqual(out.conns().sort(), ['a', 'br1']);
  out = h.claim('a', U2a.id, 1);
  assert.deepEqual(out.conns().sort(), ['a', 'br2']);
  assert.equal(out.one('br2', 'task.taken').id, U2a.id);

  // 增量：closed（done）
  out = h.complete('a', U1a.id, 2, { ranges: [[0, 59]] });
  assert.equal(out.of('br2').length, 0);
  assert.equal(out.one('br1', 'task.closed').id, U1a.id);
  out = h.complete('a', U2a.id, 2, { ranges: [[0, 59]] });
  assert.equal(out.one('br2', 'task.closed').id, U2a.id);
  assert.equal(out.of('br1').length, 0);

  // 增量：closed（removed）
  out = h.unsubscribe('p1', { ids: [U1b.id] });
  assert.equal(out.one('br1', 'task.closed').state, 'removed');
  assert.equal(out.of('br2').length, 0);

  // 通篇：br2 收到的每条消息涉及的任务都是 u2 的
  const u2Ids = new Set([U2a.id, U2b.id, U2c.id]);
  for (const m of h.bus.of('br2')) for (const tid of taskIdsIn(m)) assert.ok(u2Ids.has(tid), `br2 received ${m.type} of another user's task ${tid}`);
  const u1Ids = new Set([U1a.id, U1b.id]);
  for (const m of h.bus.of('br1')) for (const tid of taskIdsIn(m)) assert.ok(u1Ids.has(tid), `br1 received ${m.type} of another user's task ${tid}`);
});

test('P6 A local PC / standalone host claims a task of another user in the same tenant: success', () => {
  const { h } = setup({ tasks: [makeTaskInput({ resultKey: 'k1' }), makeTaskInput({ resultKey: 'k2' })] });
  const [T1, T2] = [makeTaskInput({ resultKey: 'k1' }), makeTaskInput({ resultKey: 'k2' })];
  h.node('pc9', 'node-PC9', { profile: 'pc', userId: 'u9', tenantId: 't1' });
  h.node('host8', 'node-H8', { profile: 'host', userId: 'u8', tenantId: 't1' });
  const c1 = claimOk(h, 'pc9', T1.id, 1);
  assert.equal(c1.task.source.userId, 'u1');
  claimOk(h, 'host8', T2.id, 1);
  assert.equal(h.task(T1.id).claim.nodeId, 'node-PC9');
  assert.equal(h.task(T2.id).claim.nodeId, 'node-H8');
});

test('P7 The userId / tenantId self-reported in the message differ from the principal: the principal takes precedence', () => {
  const { h } = setup({ tasks: [] });
  const T = makeTaskInput({ resultKey: 'rk7', derivedFrom: 'plan:proj-1@1', priority: 5,
    input: { clipId: 'c7', cardId: 'particles' }, requires: { codeVersion: 'c0de', memoryMB: 900 },
    source: { userId: 'evil', tenantId: 'tenant-x' } });
  h.clock.set(T0 + 123);
  const out = h.publish('p', [T]);
  const v = out.one('w', 'task.opened').task;
  assert.equal(v.source.userId, 'u1');
  assert.equal(v.source.tenantId, 't1');
  assert.deepEqual(v.source.publisher, { id: 'pub-1' });
  assert.equal(v.source.publishedAt, T0 + 123);
  assert.equal(v.source.derivedFrom, 'plan:proj-1@1');
  assert.equal(v.source.projectId, 'proj-1');
  assert.equal(v.source.projectRev, 1);
  // TaskView 其余字段原样
  assert.deepEqual([v.id, v.kind, v.tier, v.resultKey, v.range], [T.id, 'snapshot', 'shared', 'rk7', T.range]);
  assert.deepEqual(v.input, T.input);
  assert.deepEqual(v.requires, T.requires);
  assert.deepEqual(v.weight, T.weight);
  assert.equal(v.priority, 5);
  assert.deepEqual([v.state, v.version, v.attempts], ['open', 1, 0]);

  // 缺省字段（契约 A.10a）：input → {}，requires → {}，weight → null，priority → 0，derivedFrom → null
  const { input: _i, weight: _w, requires: _r, ...D } = makeTaskInput({ resultKey: 'rk8' });
  const dv = h.publish('p', [D]).one('w', 'task.opened').task;
  assert.equal(dv.source.derivedFrom, null);
  assert.equal(dv.priority, 0);
  assert.deepEqual(dv.input, {});
  assert.deepEqual(dv.requires, {});
  assert.equal(dv.weight, null);

  // connect 的 principal：userId 不是字符串就抛 TypeError（契约 A.10a）
  assert.throws(() => h.q.connect('bad1', { tenantId: 't1' }), TypeError);
  assert.throws(() => h.q.connect('bad2', { userId: 7, tenantId: 't1' }), TypeError);

  // 纯浏览器节点在 hello 里自报 userId 也不作数
  h.node('br', 'node-BR', { profile: 'browser', userId: 'u2', tenantId: 't1', watch: ['proj-1'], hello: { userId: 'u1', tenantId: 't1' } });   // M6c X3：纯浏览器不能 watch 'all'
  const snap = h.bus.last('br', 'queue.snapshot');
  assert.deepEqual(snap.tasks, []);
  assert.equal(rejected(h.claim('br', T.id, 1), 'br', T.id).reason, 'forbidden');
});

/* ------------------------------------------------------------ P8～P11 发布与订阅 */

test('P8 Repeated publish of the same id: no new task, subscribers are merged, the number of open tasks is unchanged', () => {
  const { h, id } = setup({ tasks: [] });
  h.publisher('q', 'pub-2', { userId: 'u2' });
  h.publisher('r', 'pub-3', { userId: 'u3' });

  let out = h.publish('p', [T_IN]);
  assert.deepEqual(out.one('p', 'task.published').results, [{ id: T_IN.id, state: 'open', version: 1, created: true }]);
  assert.equal(out.ofType('task.opened').length, 3);

  out = h.publish('p', [T_IN]);
  assert.deepEqual(out.one('p', 'task.published').results, [{ id: T_IN.id, state: 'open', version: 1, created: false }]);
  assert.deepEqual(out.conns(), ['p'], 'A repeated publish is not broadcast');
  out = h.publish('q', [T_IN]);
  assert.deepEqual(out.one('q', 'task.published').results, [{ id: T_IN.id, state: 'open', version: 1, created: false }]);
  assert.deepEqual(out.conns(), ['q']);

  const d = h.describe();
  assert.equal(d.tasks.length, 1);
  assert.deepEqual(d.tasks[0].subscribers, ['pub-1', 'pub-2']);
  assert.equal(d.tasks[0].version, 1);

  // claimed 的任务：同样只加订阅者
  claimOk(h, 'a', T_IN.id, 1);
  out = h.publish('r', [T_IN]);
  assert.deepEqual(out.one('r', 'task.published').results, [{ id: T_IN.id, state: 'claimed', version: 2, created: false }]);
  assert.deepEqual(out.conns(), ['r']);
  const t = h.task(T_IN.id);
  assert.deepEqual([t.state, t.version, t.subscribers], ['claimed', 2, ['pub-1', 'pub-2', 'pub-3']]);

  // 完成时每个订阅者各一条
  out = h.complete('a', T_IN.id, 2, { ranges: [[0, 59]] });
  for (const c of ['p', 'q', 'r']) assert.equal(out.one(c, 'task.done').id, T_IN.id);
  void id;
});

test('P9 Republishing a task that is already done and within DONE_TTL: task.done is returned immediately; after the TTL, republishing creates a new open task', () => {
  const { h, id } = setup();
  h.publisher('q', 'pub-2', { userId: 'u2' });
  claimOk(h, 'a', id, 1);
  h.complete('a', id, 2, { ranges: [[0, 59]] });
  const tf = h.now();
  h.bus.clear();

  h.clock.set(tf + 1_000);
  const out = h.publish('q', [T_IN]);
  assert.deepEqual(out.one('q', 'task.published').results, [{ id, state: 'done', version: 3, created: false }]);
  const d = out.one('q', 'task.done');
  assert.deepEqual({ id: d.id, resultKey: d.resultKey, projectId: d.projectId, projectRev: d.projectRev, result: d.result },
    { id, resultKey: 'rk1', projectId: 'proj-1', projectRev: 1, result: { ranges: [[0, 59]] } });
  assert.deepEqual(out.conns(), ['q'], 'Replies only to this connection, no broadcast, and the original subscribers are not notified again');
  const t = h.task(id);
  assert.deepEqual([t.state, t.version, t.finishedAt, t.subscribers], ['done', 3, tf, ['pub-1']], 'done row: unchanged');

  h.at(tf + TTL).assertSilent();
  assert.equal(h.task(id).state, 'done');
  h.at(tf + TTL + 1).assertSilent('TTL deletion sends no message');
  assert.equal(h.task(id), null);

  const again = h.publish('q', [T_IN]);
  assert.deepEqual(again.one('q', 'task.published').results, [{ id, state: 'open', version: 1, created: true }]);
  assert.equal(again.of('q', 'task.done').length, 0);
  const n = h.task(id);
  assert.deepEqual([n.state, n.version, n.attempts, n.subscribers], ['open', 1, 0, ['pub-2']]);

  // 已过 TTL、还没被 tick 删掉的 done：发布时当作不存在（契约 A.10a）
  const { h: h2, id: id2 } = setup();
  claimOk(h2, 'a', id2, 1);
  h2.complete('a', id2, 2, { ranges: [[0, 59]] });
  const tf2 = h2.now();
  h2.clock.set(tf2 + TTL + 1);          // 不调 tick
  const late = h2.publish('p', [T_IN]);
  assert.deepEqual(late.one('p', 'task.published').results, [{ id: id2, state: 'open', version: 1, created: true }]);
  assert.equal(late.of('p', 'task.done').length, 0);
  assert.deepEqual([h2.task(id2).state, h2.task(id2).version], ['open', 1]);
});

test('P10 Unfinished tasks per project reach MAX_TASKS_PER_PROJECT: publishing again returns limit; done / failed are not counted', () => {
  const MAX = QUEUE_DEFAULTS.MAX_TASKS_PER_PROJECT;
  assert.equal(MAX, 5000);
  const h = createQueueHarness(createRenderQueue);
  h.publisher('p', 'pub-1');
  h.node('a', 'node-A', { watch: null });
  h.node('w', 'node-W', { profile: 'host', watch: ['proj-1'] });
  const seg = i => makeTaskInput({ resultKey: 'lim', range: [i, i] });
  const all = Array.from({ length: MAX }, (_, i) => seg(i));

  let out = h.publish('p', all);
  const res = out.one('p', 'task.published').results;
  assert.equal(res.length, MAX);
  assert.ok(res.every(r => r.created === true));
  h.bus.clear();

  // 第 MAX + 1 个：limit，不建、不广播
  const extra = seg(MAX);
  out = h.publish('p', [extra]);
  assert.deepEqual(out.one('p', 'task.published').results, [{ id: extra.id, error: 'limit' }]);
  assert.equal(out.of('w').length, 0);
  assert.equal(h.task(extra.id), null);

  // 已有的 id 照常合并；同一条消息里逐个处理
  out = h.publish('p', [all[0], seg(MAX + 1)]);
  const [r0, r1] = out.one('p', 'task.published').results;
  assert.deepEqual(r0, { id: all[0].id, state: 'open', version: 1, created: false });
  assert.deepEqual(r1, { id: seg(MAX + 1).id, error: 'limit' });

  // 别的项目不受影响
  const other = makeTaskInput({ projectId: 'proj-2', resultKey: 'lim2' });
  assert.equal(h.publish('p', [other]).one('p', 'task.published').results[0].created, true);

  // claimed 计数：认领不腾位置
  claimOk(h, 'a', all[0].id, 1);
  assert.equal(h.publish('p', [extra]).one('p', 'task.published').results[0].error, 'limit');
  // done 不计数
  h.complete('a', all[0].id, 2, { ranges: [[0, 0]] });
  assert.deepEqual(h.publish('p', [extra]).one('p', 'task.published').results[0], { id: extra.id, state: 'open', version: 1, created: true });
  assert.equal(h.publish('p', [seg(MAX + 2)]).one('p', 'task.published').results[0].error, 'limit');
  // failed 不计数（retryable: false 直接进 failed，契约 A.7.6〔裁〕）
  claimOk(h, 'a', all[1].id, 1);
  assert.equal(h.fail('a', all[1].id, 2, { error: 'x', retryable: false }).one('a', 'task.fail-ack').state, 'failed');
  assert.equal(h.publish('p', [seg(MAX + 2)]).one('p', 'task.published').results[0].created, true);
  assert.equal(h.publish('p', [seg(MAX + 3)]).one('p', 'task.published').results[0].error, 'limit');

  const live = h.describe().tasks.filter(t => t.projectId === 'proj-1' && (t.state === 'open' || t.state === 'claimed'));
  assert.equal(live.length, MAX);
});

test('P11 unsubscribe leaves an open task without subscribers: it is deleted and task.closed is broadcast; a claimed task is kept until it finishes, and no notice is sent after completion', () => {
  const T1 = makeTaskInput({ resultKey: 'rk', range: [0, 59] });
  const T2 = makeTaskInput({ resultKey: 'rk', range: [60, 119] });
  const { h } = setup({ tasks: [T1, T2] });
  claimOk(h, 'a', T2.id, 1);
  h.bus.clear();

  let out = h.unsubscribe('p', { ids: [T1.id, T2.id, 'snapshot:none:0-1'] });
  assert.deepEqual([...out.one('p', 'task.unsubscribed').ids].sort(), [T1.id, T2.id].sort());
  assert.equal(h.task(T1.id), null);
  for (const c of ['a', 'b', 'w']) {
    const m = out.one(c, 'task.closed');
    assert.deepEqual([m.id, m.state], [T1.id, 'removed']);
  }
  const t2 = h.task(T2.id);
  assert.deepEqual([t2.state, t2.subscribers], ['claimed', []]);

  out = h.complete('a', T2.id, 2, { ranges: [[60, 119]] });
  assert.equal(out.ofType('task.done').length, 0, 'No subscribers, so task.done is not sent');
  assert.equal(h.task(T2.id).state, 'done');

  // 再退一次：已经不是订阅者，ids 为空
  assert.deepEqual(h.unsubscribe('p', { ids: [T2.id] }).one('p', 'task.unsubscribed').ids, []);

  // 按项目 / 版本退
  h.publisher('q', 'pub-2', { userId: 'u2' });
  const R1 = makeTaskInput({ resultKey: 'r1', projectRev: 1 });
  const R2 = makeTaskInput({ resultKey: 'r2', projectRev: 2 });
  const X = makeTaskInput({ resultKey: 'x', projectId: 'proj-2' });
  h.publish('p', [R1, R2, X]);
  h.publish('q', [R1]);
  h.bus.clear();
  out = h.unsubscribe('p', { projectId: 'proj-1', projectRev: 1 });
  assert.deepEqual(out.one('p', 'task.unsubscribed').ids, [R1.id]);
  assert.deepEqual(h.task(R1.id).subscribers, ['pub-2'], 'Q is still subscribed, so it is not deleted');
  assert.equal(out.ofType('task.closed').length, 0);
  out = h.unsubscribe('p', { projectId: 'proj-1' });
  assert.deepEqual(out.one('p', 'task.unsubscribed').ids, [R2.id]);
  assert.equal(h.task(R2.id), null);
  assert.equal(out.one('w', 'task.closed').id, R2.id);
  assert.deepEqual(h.task(X.id).subscribers, ['pub-1'], 'Other projects are untouched');
});

/* ------------------------------------------------------------ P12～P14 格式、epoch、常量 */

test('P12 Inbound message with a missing field, a malformed id or an unknown type: bad-message is returned, the whole message has no effect, state unchanged', () => {
  const { h, id } = setup({ tasks: [T_IN, makeTaskInput({ resultKey: 'rk2' })] });
  claimOk(h, 'a', makeTaskInput({ resultKey: 'rk2' }).id, 1);
  h.bus.clear();

  const good = makeTaskInput({ resultKey: 'fresh' });
  const bad = patch => ({ ...makeTaskInput({ resultKey: 'bad' }), ...patch });
  const snapBad = makeTaskInput({ resultKey: 'bad' });
  const plan = makeTaskInput({ kind: 'plan', projectRev: 2 });   // plan:proj-1@2

  const cases = [
    // [连接, 消息, 说明]
    ['a', null, 'Message is null'],
    ['a', 'hello', 'Message is a string'],
    ['a', 42, 'Message is a number'],
    ['a', { reqId: 'r1' }, 'Missing type'],
    ['a', { type: 'task.nope', reqId: 'r2' }, 'Unknown type'],
    ['a', { type: 42, reqId: 'r3' }, 'type is not a string'],
    ['a', { type: 'task.claim', id, reqId: 'r4' }, 'claim is missing expectVersion'],
    ['a', { type: 'task.claim', id, expectVersion: '1', reqId: 'r5' }, 'expectVersion has the wrong type'],
    ['a', { type: 'task.claim', expectVersion: 1, reqId: 'r6' }, 'claim is missing id'],
    ['a', { type: 'task.progress', id, token: '2', done: 1, reqId: 'r7' }, 'token has the wrong type'],
    ['a', { type: 'task.progress', token: 2, done: 1, reqId: 'r8' }, 'progress is missing id'],
    ['a', { type: 'task.complete', id, reqId: 'r9' }, 'complete is missing token'],
    ['a', { type: 'task.release', id, reqId: 'r10' }, 'release is missing token'],
    ['a', { type: 'task.fail', id, token: 'x', reqId: 'r11' }, 'token of fail has the wrong type'],
    ['a', { type: 'node.hello', profile: 'pc', reqId: 'r12' }, 'hello is missing nodeId'],
    ['a', { type: 'node.hello', nodeId: 'node-A', profile: 'phone', reqId: 'r13' }, 'profile is not recognized'],
    ['a', { type: 'queue.watch', projects: 42, reqId: 'r14' }, 'projects has the wrong type'],
    ['p', { type: 'publisher.hello', reqId: 'r15' }, 'publisher.hello is missing publisherId'],
    ['p', { type: 'task.publish', reqId: 'r16' }, 'publish is missing tasks'],
    ['p', { type: 'task.publish', tasks: [], reqId: 'r17' }, 'tasks is empty'],
    ['p', { type: 'task.publish', tasks: 'x', reqId: 'r18' }, 'tasks is not an array'],
    ['p', { type: 'task.publish', tasks: [good, bad({ id: 'snapshot:bad:0-58' })], reqId: 'r19' }, 'id does not match taskIdOf (the whole message has no effect, good is not created either)'],
    ['p', { type: 'task.publish', tasks: [bad({ id: 'snapshot-bad-0-59' })], reqId: 'r20' }, 'id is malformed'],
    ['p', { type: 'task.publish', tasks: [bad({ kind: 'video', id: 'video:bad:0-59' })], reqId: 'r21' }, 'kind is not recognized'],
    ['p', { type: 'task.publish', tasks: [bad({ resultKey: '', id: 'snapshot::0-59' })], reqId: 'r22' }, 'resultKey is empty'],
    ['p', { type: 'task.publish', tasks: [(({ tier, ...rest }) => rest)(snapBad)], reqId: 'r23' }, 'snapshot is missing tier'],
    ['p', { type: 'task.publish', tasks: [bad({ tier: 'global' })], reqId: 'r24' }, 'tier is not recognized'],
    ['p', { type: 'task.publish', tasks: [bad({ range: null })], reqId: 'r25' }, 'range of snapshot is null'],
    ['p', { type: 'task.publish', tasks: [bad({ range: { unit: 'localFrame', from: 9, to: 3 }, id: 'snapshot:bad:9-3' })], reqId: 'r26' }, 'from > to'],
    ['p', { type: 'task.publish', tasks: [bad({ range: { unit: 'localFrame', from: -1, to: 3 }, id: 'snapshot:bad:-1-3' })], reqId: 'r27' }, 'from < 0'],
    ['p', { type: 'task.publish', tasks: [bad({ range: { unit: 'localFrame', from: 1.5, to: 3 }, id: 'snapshot:bad:1.5-3' })], reqId: 'r28' }, 'from is not an integer'],
    ['p', { type: 'task.publish', tasks: [bad({ range: { unit: 'second', from: 0, to: 59 } })], reqId: 'r29' }, 'unit is not recognized'],
    ['p', { type: 'task.publish', tasks: [{ ...plan, source: { projectId: 'proj-1', projectRev: 1 } }], reqId: 'r30' }, 'resultKey of plan does not match source'],
    ['p', { type: 'task.publish', tasks: [(({ source, ...rest }) => rest)(snapBad)], reqId: 'r31' }, 'Missing source'],
    ['p', { type: 'task.publish', tasks: [bad({ source: { projectId: 'proj-1', projectRev: '1' } })], reqId: 'r32' }, 'projectRev has the wrong type'],
    ['p', { type: 'task.publish', tasks: [bad({ priority: 'high' })], reqId: 'r33' }, 'priority has the wrong type'],
    ['p', { type: 'task.publish', tasks: [bad({ weight: { class: 'giant' } })], reqId: 'r34' }, 'weight.class is not recognized'],
    ['p', { type: 'task.unsubscribe', reqId: 'r35' }, 'unsubscribe has neither ids nor projectId'],
    ['p', { type: 'task.unsubscribe', ids: 'x', reqId: 'r36' }, 'ids is not an array'],
    // 契约 A.10a 补充的格式规则
    ['p', { type: 'task.publish', tasks: [{ ...plan, range: { unit: 'localFrame', from: 0, to: 1 } }], reqId: 'r37' }, 'range of plan is not null'],
    ['a', { type: 'node.hello', nodeId: '', profile: 'pc', reqId: 'r38' }, 'nodeId is an empty string'],
    ['p', { type: 'publisher.hello', publisherId: '', reqId: 'r39' }, 'publisherId is an empty string'],
    ['p', { type: 'task.publish', tasks: [makeTaskInput({ projectId: '', resultKey: 'e' })], reqId: 'r40' }, 'projectId is an empty string'],
    ['a', { type: 'task.claim', id, expectVersion: 1, reqId: { x: 1 } }, 'reqId is neither a string nor a number'],
    ['a', { type: 'task.claim', id, expectVersion: 1, reqId: [1] }, 'reqId is an array'],
  ];

  for (const [conn, msg, why] of cases) {
    const before = h.describe();
    const out = h.handle(conn, msg);
    assert.deepEqual(out.conns(), [conn], `${why}: replies only to this connection`);
    const e = out.one(conn, 'error');
    assert.equal(e.reason, 'bad-message', why);
    assert.equal(typeof e.detail, 'string', `${why}: detail is a string`);
    const validReqId = msg && typeof msg === 'object' && (typeof msg.reqId === 'string' || typeof msg.reqId === 'number');
    if (validReqId) assert.equal(e.reqId, msg.reqId, `${why}: carries back reqId`);
    assert.deepEqual(h.describe(), before, `${why}: state unchanged`);
  }
  assert.equal(h.task(good.id), null, 'The whole message has no effect');

  // progress.done 可为 null 或不给（契约 A.10a），不是格式错误
  const heldId = makeTaskInput({ resultKey: 'rk2' }).id;
  assert.equal(h.progress('a', heldId, 2, null).one('a', 'task.renewed').id, heldId);
  assert.equal(h.handle('a', { type: 'task.progress', id: heldId, token: 2 }).one('a', 'task.renewed').id, heldId);
  assert.deepEqual(h.task(heldId).claim.progress.done, null);

  // 未注册（契约 A.5〔裁〕）：连上但没报到
  h.connect('z');
  for (const [conn, msg] of [
    ['z', { type: 'task.claim', id, expectVersion: 1, reqId: 'n1' }],
    ['z', { type: 'task.publish', tasks: [good], reqId: 'n2' }],
    ['z', { type: 'queue.watch', projects: 'all', reqId: 'n3' }],
    ['a', { type: 'task.publish', tasks: [good], reqId: 'n4' }],
    ['a', { type: 'task.unsubscribe', ids: [id], reqId: 'n5' }],
    ['p', { type: 'task.claim', id, expectVersion: 1, reqId: 'n6' }],
    ['p', { type: 'task.progress', id, token: 2, done: 1, reqId: 'n7' }],
    ['p', { type: 'task.complete', id, token: 2, reqId: 'n8' }],
    ['p', { type: 'task.release', id, token: 2, reqId: 'n9' }],
    ['p', { type: 'task.fail', id, token: 2, reqId: 'n10' }],
    ['p', { type: 'queue.watch', projects: 'all', reqId: 'n11' }],
  ]) {
    const before = h.describe();
    const out = h.handle(conn, msg);
    assert.deepEqual(out.conns(), [conn]);
    const e = out.one(conn, 'error');
    assert.deepEqual([e.reason, e.reqId], ['not-registered', msg.reqId], `${conn} ${msg.type}`);
    assert.deepEqual(h.describe(), before);
  }
  // 校验顺序：先格式后角色（契约 A.10a）——没报到的连接发格式错误的消息，回 bad-message
  {
    const e = h.handle('z', { type: 'task.claim', id, reqId: 'fmt' }).one('z', 'error');
    assert.deepEqual([e.reason, e.reqId], ['bad-message', 'fmt']);
  }
  // 从没 connect 过的连接：忽略，什么都不发（契约 A.3）
  h.handle('ghost', { type: 'task.claim', id, expectVersion: 1 }).assertSilent('Unconnected connId');

  // 被新连接取代的旧连接：再发节点 / 发布方消息回 not-registered，它的 watch 一并取消（契约 A.10a）
  {
    const g = createQueueHarness(createRenderQueue);
    g.publisher('p', 'pub-1');
    g.node('old', 'node-A');
    g.node('new', 'node-A');                 // 同一 nodeId 的新连接取代旧连接
    g.publisher('p2', 'pub-1');              // 同一 publisherId 的新连接取代旧连接
    const T = makeTaskInput({ resultKey: 'sup' });
    const pub = g.publish('p2', [T]);
    assert.equal(pub.one('p2', 'task.published').results[0].created, true);
    assert.equal(pub.of('old').length, 0, 'The watch of the old connection has been canceled');
    assert.equal(pub.one('new', 'task.opened').task.id, T.id);
    for (const [conn, msg] of [
      ['old', { type: 'task.claim', id: T.id, expectVersion: 1, reqId: 's1' }],
      ['old', { type: 'queue.watch', projects: 'all', reqId: 's2' }],
      ['p', { type: 'task.publish', tasks: [makeTaskInput({ resultKey: 'sup2' })], reqId: 's3' }],
      ['p', { type: 'task.unsubscribe', ids: [T.id], reqId: 's4' }],
    ]) {
      const before = g.describe();
      const e = g.handle(conn, msg).one(conn, 'error');
      assert.deepEqual([e.reason, e.reqId], ['not-registered', msg.reqId], `Superseded ${conn} sends ${msg.type}`);
      assert.deepEqual(g.describe(), before);
    }
    // 旧连接断开不影响新连接代表的身份
    g.disconnect('old');
    g.disconnect('p');
    assert.deepEqual([g.nodeInfo('node-A').connected, g.nodeInfo('node-A').disconnectedAt], [true, null]);
    assert.deepEqual([g.publisherInfo('pub-1').connected, g.publisherInfo('pub-1').disconnectedAt], [true, null]);
  }

  // taskIdOf 的形状（契约 A.4）
  assert.equal(taskIdOf({ kind: 'plan', resultKey: 'proj-1@3', range: null }), 'plan:proj-1@3');
  assert.equal(taskIdOf({ kind: 'snapshot', resultKey: 'k', range: { unit: 'localFrame', from: 0, to: 59 } }), 'snapshot:k:0-59');
  assert.equal(taskIdOf({ kind: 'stream', resultKey: 'k', range: { unit: 'segment', from: 8, to: 15 } }), 'stream:k:8-15');
  // 合法的 plan / stream / local 快照都能发布
  const ok = h.publish('p', [makeTaskInput({ kind: 'plan', projectRev: 9 }), makeTaskInput({ kind: 'stream', resultKey: 'sk' }),
    makeTaskInput({ resultKey: 'lk', tier: 'local' })]);
  assert.deepEqual(ok.one('p', 'task.published').results.map(r => r.created), [true, true, true]);
});

test('P13 All outbound messages carry the current epoch; replies carry back the inbound reqId', () => {
  const h = createQueueHarness(createRenderQueue, { epoch: 'ep-fixed' });
  assert.equal(h.q.epoch, 'ep-fixed');
  assert.equal(h.describe().epoch, 'ep-fixed');

  const replies = [];   // [连接, reqId, 回包类型]
  const R = (conn, msg, type) => {
    const out = h.handle(conn, msg);
    replies.push([conn, msg.reqId, type, out]);
    return out;
  };
  h.connect('p');
  R('p', { type: 'publisher.hello', publisherId: 'pub-1', reqId: 1 }, 'publisher.welcome');
  h.connect('a');
  R('a', { type: 'node.hello', nodeId: 'node-A', profile: 'pc', reqId: 'h1' }, 'node.welcome');
  R('a', { type: 'queue.watch', projects: 'all', reqId: 'w1' }, 'queue.snapshot');
  h.node('b', 'node-B');
  const T1 = makeTaskInput({ resultKey: 'e1' });
  const T2 = makeTaskInput({ resultKey: 'e2' });
  const T3 = makeTaskInput({ resultKey: 'e3' });
  R('p', { type: 'task.publish', tasks: [T1, T2, T3], reqId: 'pub' }, 'task.published');
  R('a', { type: 'task.claim', id: T1.id, expectVersion: 1, reqId: 7 }, 'task.claimed');
  R('b', { type: 'task.claim', id: T1.id, expectVersion: 1, reqId: 8 }, 'task.claim-rejected');
  R('a', { type: 'task.progress', id: T1.id, token: 2, done: 3, reqId: 'pr' }, 'task.renewed');
  R('b', { type: 'task.progress', id: T1.id, token: 1, done: 3, reqId: 'bad-token' }, 'task.lease-lost');
  R('a', { type: 'task.complete', id: T1.id, token: 2, result: { ranges: [[0, 59]] }, reqId: 'cm' }, 'task.completed');
  h.claim('a', T2.id, 1);
  R('a', { type: 'task.release', id: T2.id, token: 2, reqId: 'rl' }, 'task.released');
  h.claim('a', T3.id, 1);
  R('a', { type: 'task.fail', id: T3.id, token: 2, error: 'boom', retryable: false, reqId: 'fl' }, 'task.fail-ack');
  R('p', { type: 'task.unsubscribe', ids: [T2.id], reqId: 'un' }, 'task.unsubscribed');
  R('a', { type: 'task.nope', reqId: 'err' }, 'error');

  for (const [conn, reqId, type, out] of replies) {
    const m = out.one(conn, type);
    assert.equal(m.reqId, reqId, `${type} carries back reqId`);
  }

  const all = h.bus.all().entries;
  const seen = new Set(all.map(e => e.message.type));
  for (const type of ['node.welcome', 'publisher.welcome', 'queue.snapshot', 'task.published', 'task.unsubscribed', 'task.claimed',
    'task.claim-rejected', 'task.renewed', 'task.completed', 'task.released', 'task.fail-ack', 'task.lease-lost', 'task.opened',
    'task.taken', 'task.closed', 'task.done', 'task.failed', 'error']) {
    assert.ok(seen.has(type), `The scenario should cover ${type}`);
  }
  for (const e of all) assert.equal(e.message.epoch, 'ep-fixed', `${e.message.type} should carry epoch`);

  // 缺省 epoch：随机字符串，所有消息都带它
  const h2 = createQueueHarness(createRenderQueue);
  assert.equal(typeof h2.q.epoch, 'string');
  assert.ok(h2.q.epoch.length > 0);
  h2.publisher('p', 'pub-1');
  h2.node('a', 'node-A');
  h2.publish('p', [T1]);
  h2.handle('a', 42);
  assert.ok(h2.bus.all().count >= 5);
  for (const e of h2.bus.all().entries) assert.equal(e.message.epoch, h2.q.epoch);

  // reqId 只在主回包里带（契约 A.10a）：hello 的 lost 附发的 lease-lost、重复发布已完成任务附发的 task.done 不带
  {
    const g = createQueueHarness(createRenderQueue);
    g.publisher('p', 'pub-1');
    g.node('a', 'node-A');
    g.publish('p', [T1]);
    g.claim('a', T1.id, 1);
    g.complete('a', T1.id, 2, { ranges: [[0, 59]] });
    g.connect('z');
    const hz = g.handle('z', { type: 'node.hello', nodeId: 'node-Z', profile: 'pc', resume: [{ id: 'snapshot:none:0-1', token: 3 }], reqId: 'hz' });
    assert.equal(hz.one('z', 'node.welcome').reqId, 'hz');
    assert.equal('reqId' in hz.one('z', 'task.lease-lost'), false);
    const pp = g.publish('p', [T1], { reqId: 'pp' });
    assert.equal(pp.one('p', 'task.published').reqId, 'pp');
    assert.equal('reqId' in pp.one('p', 'task.done'), false);
  }

  // send 抛异常时吞掉，状态照改（契约 A.10a）
  {
    const clock = createFakeClock();
    const got = [];
    const q = createRenderQueue({ now: clock.now, send: (connId, m) => { if (connId === 'boom') throw new Error('socket closed'); got.push([connId, m]); } });
    q.connect('boom', { userId: 'u1', tenantId: 't1' });
    assert.doesNotThrow(() => q.handle('boom', { type: 'publisher.hello', publisherId: 'pub-1' }));
    q.connect('a', { userId: 'u1', tenantId: 't1' });
    q.handle('a', { type: 'node.hello', nodeId: 'node-A', profile: 'pc' });
    q.handle('a', { type: 'queue.watch', projects: 'all' });
    assert.doesNotThrow(() => q.handle('boom', { type: 'task.publish', tasks: [T1] }));
    assert.equal(q.describe().tasks.find(t => t.id === T1.id)?.state, 'open');
    assert.ok(got.some(([c, m]) => c === 'a' && m.type === 'task.opened' && m.task.id === T1.id), 'Other connections still receive it as usual');
    assert.ok(got.every(([, m]) => m.epoch === q.epoch));
  }
});

test('P14 options.constants override: overridden values take effect, the rest keep the baseline', () => {
  // 常量表本身（契约 A.2）
  assert.deepEqual({ ...QUEUE_DEFAULTS }, {
    LEASE_MS: 30_000, RENEW_INTERVAL_MS: 10_000, SWEEP_INTERVAL_MS: 5_000,
    RECONNECT_GRACE_MS: 10_000, STALL_MS: 120_000, MAX_ATTEMPTS: 3,
    DONE_TTL: 600_000, MAX_TASKS_PER_PROJECT: 5000,
    SNAPSHOT_SPAN: 60, STREAM_SEGMENTS: 8, PICK_K: 4,
    PREFILTER: true, THROTTLE_REJECTS: 20,
    PLAN_PREFER_MS: 5_000,   // M6c X4 新增的常量
  });
  assert.deepEqual({ ...QUEUE_ENV }, {
    LEASE_MS: 'PROMPTCUT_QUEUE_LEASE_MS', RENEW_INTERVAL_MS: 'PROMPTCUT_QUEUE_RENEW_MS',
    SWEEP_INTERVAL_MS: 'PROMPTCUT_QUEUE_SWEEP_MS', RECONNECT_GRACE_MS: 'PROMPTCUT_QUEUE_GRACE_MS',
    STALL_MS: 'PROMPTCUT_QUEUE_STALL_MS', MAX_ATTEMPTS: 'PROMPTCUT_QUEUE_MAX_ATTEMPTS',
    DONE_TTL: 'PROMPTCUT_QUEUE_DONE_TTL_MS', MAX_TASKS_PER_PROJECT: 'PROMPTCUT_QUEUE_MAX_TASKS',
    SNAPSHOT_SPAN: 'PROMPTCUT_QUEUE_SNAPSHOT_SPAN', STREAM_SEGMENTS: 'PROMPTCUT_QUEUE_STREAM_SEGMENTS',
    PICK_K: 'PROMPTCUT_QUEUE_PICK_K',
    PREFILTER: 'PROMPTCUT_QUEUE_PREFILTER', THROTTLE_REJECTS: 'PROMPTCUT_QUEUE_THROTTLE_REJECTS',
    PLAN_PREFER_MS: 'PROMPTCUT_QUEUE_PLAN_PREFER_MS',
  });
  assert.ok(Object.isFrozen(QUEUE_DEFAULTS));
  assert.ok(Object.isFrozen(QUEUE_ENV));

  const constants = { LEASE_MS: 1_000, RECONNECT_GRACE_MS: 200 };
  // 覆盖的租约
  {
    const { h, id } = setup({ constants });
    const c = h.claim('a', id, 1).one('a', 'task.claimed');
    assert.equal(c.leaseUntil, T0 + 1_000);
    h.at(T0 + 1_000).assertSilent();
    h.at(T0 + 1_001);
    assert.deepEqual([h.task(id).state, h.task(id).attempts], ['open', 1]);
  }
  // 覆盖的宽限（节点与发布方共用，C5）
  {
    const { h, id } = setup({ constants });
    claimOk(h, 'a', id, 1);
    h.disconnect('a');
    h.disconnect('p');
    h.at(T0 + 200).assertSilent();
    assert.equal(h.task(id).state, 'claimed');
    h.at(T0 + 201);
    assert.equal(h.task(id), null, 'Tasks return to open when the node\'s grace period expires; open tasks left without subscribers are deleted when the publisher\'s grace period expires');
    assert.equal(h.nodeInfo('node-A'), null);
    assert.equal(h.publisherInfo('pub-1'), null);
  }
  // 没覆盖的保持基线：MAX_ATTEMPTS 3、DONE_TTL 600 s
  {
    const { h, id } = setup({ constants });
    for (const [conn, v, state] of [['a', 1, 'open'], ['b', 3, 'open'], ['w', 5, 'failed']]) {
      claimOk(h, conn, id, v);
      assert.equal(h.fail(conn, id, v + 1, { error: 'e' }).one(conn, 'task.fail-ack').state, state);
    }
    const tf = h.now();
    h.at(tf + TTL);
    assert.equal(h.task(id).state, 'failed');
    h.at(tf + TTL + 1);
    assert.equal(h.task(id), null);
  }
  // 其它键的覆盖：STALL_MS、MAX_ATTEMPTS、MAX_TASKS_PER_PROJECT、DONE_TTL
  {
    const { h, id } = setup({ constants: { STALL_MS: 5_000 } });
    claimOk(h, 'a', id, 1);
    h.progress('a', id, 2, 1);
    h.clock.set(T0 + 4_000);
    h.progress('a', id, 2, 1);
    h.at(T0 + 5_000).assertSilent();
    h.at(T0 + 5_001);
    assert.equal(h.task(id).state, 'open');
  }
  {
    const { h, id } = setup({ constants: { MAX_ATTEMPTS: 1 } });
    claimOk(h, 'a', id, 1);
    assert.equal(h.fail('a', id, 2, { error: 'e' }).one('a', 'task.fail-ack').state, 'failed');
  }
  {
    const { h } = setup({ tasks: [], constants: { MAX_TASKS_PER_PROJECT: 2 } });
    const res = h.publish('p', [0, 1, 2].map(i => makeTaskInput({ resultKey: 'm', range: [i, i] }))).one('p', 'task.published').results;
    assert.deepEqual(res.map(r => r.created ?? r.error), [true, true, 'limit']);
  }
  {
    const { h, id } = setup({ constants: { DONE_TTL: 50 } });
    claimOk(h, 'a', id, 1);
    h.complete('a', id, 2);
    h.at(T0 + 50);
    assert.equal(h.task(id).state, 'done');
    h.at(T0 + 51);
    assert.equal(h.task(id), null);
  }
  // 覆盖不改动导出的基线表
  assert.equal(QUEUE_DEFAULTS.LEASE_MS, 30_000);
  assert.equal(QUEUE_DEFAULTS.RECONNECT_GRACE_MS, 10_000);
});

/* ------------------------------------------------------------ P15 派生任务的继承（契约 A.4 末段〔裁〕） */

test('P15 Inheritance for derived tasks: when derivedFrom points to a plan task currently claimed by this node, the task inherits the plan\'s userId / tenantId and subscribers; if the condition is not met there is no inheritance and no error', () => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('pg', 'pub-page', { userId: 'u1', tenantId: 't1' });
  // 切分节点：同一条连接既是节点又是发布方，凭证是部署身份
  h.node('n', 'node-N', { profile: 'pc', userId: 'svc', tenantId: 't2' });   // M6c X3 / X4：host 不认领 plan、watch 'all' 只收摘要，切分节点改用 pc（原为 host）
  assert.equal(h.handle('n', { type: 'publisher.hello', publisherId: 'pub-node' }).one('n', 'publisher.welcome').publisherId, 'pub-node');
  h.node('m', 'node-M', { profile: 'pc', userId: 'svc2', tenantId: 't2' });
  h.handle('m', { type: 'publisher.hello', publisherId: 'pub-m' });
  h.node('br1', 'node-BR1', { profile: 'browser', userId: 'u1', tenantId: 't1', watch: ['proj-1'] });   // M6c X3：纯浏览器不能 watch 'all'
  h.node('brS', 'node-BRS', { profile: 'browser', userId: 'svc', tenantId: 't2', watch: ['proj-1'] });

  const PL = makeTaskInput({ kind: 'plan', projectRev: 1 });
  h.publish('pg', [PL]);
  assert.equal(claimOk(h, 'n', PL.id, 1).token, 2);

  // 继承：userId / tenantId 取 plan 的，订阅者 = {本发布方} ∪ plan 的订阅者
  const D = makeTaskInput({ resultKey: 'd1', derivedFrom: PL.id });
  let out = h.publish('n', [D]);
  assert.deepEqual(out.one('n', 'task.published').results, [{ id: D.id, state: 'open', version: 1, created: true }]);
  const dv = out.one('br1', 'task.opened').task;
  assert.deepEqual([dv.source.userId, dv.source.tenantId, dv.source.derivedFrom], ['u1', 't1', PL.id]);
  assert.deepEqual(dv.source.publisher, { id: 'pub-node' });
  assert.equal(out.of('brS').length, 0, 'A browser with the splitter node\'s identity sees nothing');
  assert.deepEqual(h.task(D.id).subscribers, ['pub-node', 'pub-page']);

  // 不继承 1：别的节点（不是 plan 的认领者）
  const F = makeTaskInput({ resultKey: 'f1', derivedFrom: PL.id });
  out = h.publish('m', [F]);
  assert.equal(out.one('m', 'task.published').results[0].created, true);
  assert.equal(out.one('n', 'task.opened').task.source.userId, 'svc2');
  assert.equal(out.of('br1').length, 0);
  assert.deepEqual(h.task(F.id).subscribers, ['pub-m']);
  // 不继承 2：derivedFrom 指向不存在的任务
  const G = makeTaskInput({ resultKey: 'g1', derivedFrom: 'plan:proj-9@1' });
  out = h.publish('n', [G]);
  assert.equal(out.one('n', 'task.published').results[0].created, true);
  assert.equal(out.one('m', 'task.opened').task.source.userId, 'svc');
  assert.equal(out.one('brS', 'task.opened').task.id, G.id);
  assert.deepEqual(h.task(G.id).subscribers, ['pub-node']);
  // 不继承 3：指向本节点认领中的非 plan 任务
  const S = makeTaskInput({ resultKey: 's1' });
  h.publish('pg', [S]);
  claimOk(h, 'n', S.id, 1);
  const H = makeTaskInput({ resultKey: 'h1', derivedFrom: S.id });
  out = h.publish('n', [H]);
  assert.equal(out.one('m', 'task.opened').task.source.userId, 'svc');
  assert.deepEqual(h.task(H.id).subscribers, ['pub-node']);

  // 之后 plan 的订阅者变化不再传给已建的细任务
  h.publisher('pg2', 'pub-page2', { userId: 'u1', tenantId: 't1' });
  h.publish('pg2', [PL]);
  assert.deepEqual(h.task(PL.id).subscribers, ['pub-page', 'pub-page2']);
  assert.deepEqual(h.task(D.id).subscribers, ['pub-node', 'pub-page']);

  // 切分节点断开：宽限后它的订阅被移除，细任务 D 仍有页面订阅，不被删；只有它订阅的 G、H 删除
  h.disconnect('n');
  h.clock.advance(GRACE + 1);
  h.tick();
  assert.deepEqual(h.task(D.id).subscribers, ['pub-page']);
  assert.equal(h.task(D.id).state, 'open');
  assert.equal(h.task(G.id), null);
  assert.equal(h.task(H.id), null);
  assert.deepEqual([h.task(PL.id).state, h.task(PL.id).version], ['open', 3]);

  // D 完成时页面收到 task.done
  claimOk(h, 'm', D.id, 1);
  out = h.complete('m', D.id, 2, { ranges: [[0, 59]] });
  assert.equal(out.one('pg', 'task.done').id, D.id);
  assert.equal(out.ofType('task.done').length, 1);

  // 不继承 4：plan 已不在 claimed（已完成）
  h.node('n2', 'node-N2', { profile: 'pc', userId: 'svc3', tenantId: 't2' });   // M6c X3 / X4：host 不认领 plan、watch 'all' 只收摘要，切分节点改用 pc（原为 host）
  h.handle('n2', { type: 'publisher.hello', publisherId: 'pub-n2' });
  claimOk(h, 'n2', PL.id, 3);
  h.complete('n2', PL.id, 4);
  const E = makeTaskInput({ resultKey: 'e1', derivedFrom: PL.id });
  out = h.publish('n2', [E]);
  assert.equal(out.one('m', 'task.opened').task.source.userId, 'svc3');
  assert.deepEqual(h.task(E.id).subscribers, ['pub-n2']);
});

test('P16 Fine-grained tasks that already exist when the inheritance condition is met: the plan\'s subscribers are merged in (userId unchanged); for done / failed, each newly merged subscriber gets one backfilled message; existing subscribers are not sent it again; if the condition is not met only this publisher is added', () => {
  const h = createQueueHarness(createRenderQueue);
  // 早先建任务的发布方（另一个用户）、两个页面、切分节点 n、另一个节点 m
  h.publisher('old', 'pub-old', { userId: 'u-old', tenantId: 't1' });
  h.publisher('pg', 'pub-page', { userId: 'u1', tenantId: 't1' });
  h.publisher('pg2', 'pub-page2', { userId: 'u1', tenantId: 't1' });
  h.node('n', 'node-N', { profile: 'pc', userId: 'svc', tenantId: 't2' });   // M6c X3 / X4：host 不认领 plan、watch 'all' 只收摘要，切分节点改用 pc（原为 host）
  h.handle('n', { type: 'publisher.hello', publisherId: 'pub-node' });
  h.node('m', 'node-M', { profile: 'pc', userId: 'svc2', tenantId: 't2' });
  h.handle('m', { type: 'publisher.hello', publisherId: 'pub-m' });

  // 已存在的四种任务（pub-old 建），外加两条 pub-page 早已订阅的 done / failed
  const O = makeTaskInput({ resultKey: 'rk-open' });
  const C = makeTaskInput({ resultKey: 'rk-claimed' });
  const D = makeTaskInput({ resultKey: 'rk-done' });
  const F = makeTaskInput({ resultKey: 'rk-failed' });
  const D2 = makeTaskInput({ resultKey: 'rk-done-sub' });
  const F2 = makeTaskInput({ resultKey: 'rk-failed-sub' });
  const ALL = [O, C, D, F, D2, F2];
  h.publish('old', [O, C, D, F]);
  h.publish('pg', [D2, F2]);
  claimOk(h, 'm', C.id, 1);
  claimOk(h, 'm', D.id, 1);
  h.complete('m', D.id, 2, { ranges: [[0, 59]] });
  claimOk(h, 'm', F.id, 1);
  h.fail('m', F.id, 2, { error: 'boom', retryable: false });
  claimOk(h, 'm', D2.id, 1);
  h.complete('m', D2.id, 2, { ranges: [[0, 59]] });
  claimOk(h, 'm', F2.id, 1);
  h.fail('m', F2.id, 2, { error: 'boom2', retryable: false });
  assert.deepEqual(ALL.map(t => h.task(t.id).state), ['open', 'claimed', 'done', 'failed', 'done', 'failed']);

  // plan：两个页面都订阅，n 认领
  const PL = makeTaskInput({ kind: 'plan', projectRev: 1 });
  h.publish('pg', [PL]);
  h.publish('pg2', [PL]);
  claimOk(h, 'n', PL.id, 1);
  assert.deepEqual(h.task(PL.id).subscribers, ['pub-page', 'pub-page2']);
  const before = new Map(ALL.map(t => [t.id, h.task(t.id)]));

  // n 切分出的细任务与已存在的同 id（id 只由 kind / resultKey / range 决定）
  const derivedOf = (t, from = PL.id) => ({ ...t, source: { ...t.source, derivedFrom: from } });
  const derived = ALL.map(t => derivedOf(t));
  const out = h.publish('n', derived);
  assert.deepEqual(out.one('n', 'task.published').results.map(r => [r.id, r.state, r.version, r.created]), [
    [O.id, 'open', 1, false], [C.id, 'claimed', 2, false], [D.id, 'done', 3, false],
    [F.id, 'failed', 3, false], [D2.id, 'done', 3, false], [F2.id, 'failed', 3, false],
  ]);

  // 订阅者：open / claimed = 原有 ∪ 本发布方 ∪ plan 的订阅者；
  // done / failed 至少并入 plan 的订阅者、原有的保留（本发布方加不加，A.7.1 的 done 行说「不变」，这里不断言）
  assert.deepEqual(h.task(O.id).subscribers, ['pub-node', 'pub-old', 'pub-page', 'pub-page2']);
  assert.deepEqual(h.task(C.id).subscribers, ['pub-node', 'pub-old', 'pub-page', 'pub-page2']);
  for (const t of [D, F, D2, F2]) {
    const subs = h.task(t.id).subscribers;
    for (const s of [...before.get(t.id).subscribers, 'pub-page', 'pub-page2']) assert.ok(subs.includes(s), `${t.id} should contain ${s}, actual ${subs}`);
  }
  // 状态、version、attempts 不变
  for (const t of ALL) {
    const [a, b] = [before.get(t.id), h.task(t.id)];
    assert.deepEqual([b.state, b.version, b.attempts], [a.state, a.version, a.attempts], t.id);
  }

  // 补发：新并入的订阅者各恰好一条；已是订阅者的（pub-page 之于 D2 / F2）不重复发
  const doneTo = conn => out.of(conn, 'task.done').map(m => m.id).sort();
  const failedTo = conn => out.of(conn, 'task.failed').map(m => m.id).sort();
  assert.deepEqual(doneTo('pg'), [D.id]);
  assert.deepEqual(failedTo('pg'), [F.id]);
  assert.deepEqual(doneTo('pg2'), [D.id, D2.id].sort());
  assert.deepEqual(failedTo('pg2'), [F.id, F2.id].sort());
  const d = out.of('pg', 'task.done')[0];
  assert.deepEqual({ id: d.id, resultKey: d.resultKey, projectId: d.projectId, projectRev: d.projectRev, result: d.result },
    { id: D.id, resultKey: 'rk-done', projectId: 'proj-1', projectRev: 1, result: { ranges: [[0, 59]] } });
  assert.equal(out.of('pg', 'task.failed')[0].error, 'boom');
  assert.equal(out.of('pg2', 'task.failed').find(m => m.id === F2.id).error, 'boom2');
  // 原有订阅者、无关的节点收不到补发；open / claimed 不补发任何东西
  assert.equal(out.of('old', ['task.done', 'task.failed']).length, 0);
  assert.equal(out.of('m', ['task.done', 'task.failed']).length, 0);
  assert.equal(out.ofType(['task.done', 'task.failed']).filter(e => e.message.id === O.id || e.message.id === C.id).length, 0);
  // 本连接（切分节点）：照 A.7.1 对每个 done 回一条 task.done，failed 不回，也不因并入再多发
  assert.deepEqual(doneTo('n'), [D.id, D2.id].sort());
  assert.equal(out.of('n', 'task.failed').length, 0);

  // userId / tenantId 不改：新 watch 的快照里 O 仍是 pub-old 的用户
  const ov = h.watch('n').one('n', 'queue.snapshot').tasks.find(t => t.id === O.id);
  assert.deepEqual([ov.source.userId, ov.source.tenantId], ['u-old', 't1']);

  // 再发一次同样的细任务：订阅者都已在，页面不再收到补发
  const again = h.publish('n', derived);
  assert.equal(again.of('pg', ['task.done', 'task.failed']).length, 0);
  assert.equal(again.of('pg2', ['task.done', 'task.failed']).length, 0);

  // 并入之后，claimed 的 C 完成时两个页面各收到一条 task.done
  const fin = h.complete('m', C.id, 2, { ranges: [[0, 59]] });
  assert.equal(fin.of('pg', 'task.done').length, 1);
  assert.equal(fin.of('pg2', 'task.done').length, 1);

  // 条件不满足 1：发布连接不是 plan 的认领者 → 只加本发布方，不补发
  const O3 = makeTaskInput({ resultKey: 'rk-open-3' });
  const D3 = makeTaskInput({ resultKey: 'rk-done-3' });
  h.publish('old', [O3, D3]);
  claimOk(h, 'm', D3.id, 1);
  h.complete('m', D3.id, 2, { ranges: [[0, 59]] });
  const viaM = h.publish('m', [derivedOf(O3), derivedOf(D3)]);
  assert.deepEqual(h.task(O3.id).subscribers, ['pub-m', 'pub-old']);
  assert.deepEqual(h.task(D3.id).subscribers, ['pub-old'], 'done row: unchanged (A.7.1)');
  assert.equal(viaM.of('pg', ['task.done', 'task.failed']).length, 0);
  assert.equal(viaM.of('pg2', ['task.done', 'task.failed']).length, 0);
  assert.deepEqual(viaM.of('m', 'task.done').map(m => m.id), [D3.id], 'A.7.1: done goes back to this connection');

  // 条件不满足 2：derivedFrom 指向不存在的 plan
  const O4 = makeTaskInput({ resultKey: 'rk-open-4' });
  h.publish('old', [O4]);
  const viaGhost = h.publish('n', [derivedOf(O4, 'plan:proj-9@1')]);
  assert.deepEqual(h.task(O4.id).subscribers, ['pub-node', 'pub-old']);
  assert.equal(viaGhost.of('pg').length + viaGhost.of('pg2').length, 0);

  // 条件不满足 3：plan 已不在 claimed（完成之后）
  h.complete('n', PL.id, 2);
  const O5 = makeTaskInput({ resultKey: 'rk-open-5' });
  h.publish('old', [O5]);
  const afterPlan = h.publish('n', [derivedOf(O5)]);
  assert.deepEqual(h.task(O5.id).subscribers, ['pub-node', 'pub-old']);
  assert.equal(afterPlan.of('pg', ['task.done', 'task.failed']).length, 0);
});