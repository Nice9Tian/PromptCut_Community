/**
 * M7-T：E5（纯浏览器只见本人任务，分发与认领两层）与 B2（纯浏览器只认领 light / medium 共享档快照任务）。
 * 依据：`docs/plan/m7-contract.md` 第 3.1、3.2 节，验收 M7-A1～A3；`render-queue-contract.md` A.9、B.2。
 * 这两条的零件已在代码里（契约第 0 节第 1～3 行），所以本文件不设门、现在就跑，守回归；D9、D4 的加严在各自的门后面。
 * 跑：node --experimental-test-module-mocks --test server/test/m7-e5-b2.test.mjs
 *
 * 时钟一律是假时钟，没有真实计时断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeSession } from '../render-node/session.mjs';
import { checkClaimable } from '../render-node/filter.mjs';
import {
  createDocQueueRig, createDirectQueue, memberPrincipal, snapTask, streamTask, clipsPlan,
  filterIndependentGate, gateOpts,
} from './m7-kit.mjs';

const FP = 'aaaaaaaaaaaaaaaa';
const OTHER_FP = 'bbbbbbbbbbbbbbbb';
const TASK_MSGS = ['queue.snapshot', 'task.opened', 'task.taken', 'task.closed'];

/** 某连接收到的、提到这些任务 id 的消息（快照里列出的也算） */
function mentions(rig, connId, ids) {
  const set = new Set(ids);
  const out = [];
  for (const m of rig.of(connId, TASK_MSGS)) {
    if (m.type === 'queue.snapshot') {
      for (const t of m.tasks ?? []) if (set.has(t.id)) out.push({ type: m.type, id: t.id });
    } else {
      const id = m.task?.id ?? m.id;
      if (set.has(id)) out.push({ type: m.type, id });
    }
  }
  return out;
}

/* ================================================================== E5 分发（M7-A1） */

test('E5 distribution: during A\'s whole round of publishing, splitting, claiming and completing, other people\'s (another user\'s, or one with the same name on a different device) browser-only nodes receive 0 task messages from A; A\'s own browser-only node can see them (control)', () => {
  const rig = createDocQueueRig();
  // A 的页面（发布方）与 A 的桌面节点（切分、执行）
  rig.connect('pageA', memberPrincipal({ username: 'zoe', device: 'devA', role: 'page' }));
  rig.send('pageA', { type: 'publisher.hello', publisherId: 'pub-A' });
  rig.connect('pcA', memberPrincipal({ username: 'zoe', device: 'devA' }));
  rig.send('pcA', { type: 'node.hello', nodeId: 'pc-A', profile: 'pc', envFingerprint: FP });
  rig.send('pcA', { type: 'publisher.hello', publisherId: 'pc-A' });
  // 三个纯浏览器节点：别的用户 B、与 A 同名不同设备的 B'、A 自己（对照）
  const browsers = [
    ['brB', memberPrincipal({ username: 'bob', device: 'devB' }), 'n-bob'],
    ['brB2', memberPrincipal({ username: 'zoe', device: 'devB' }), 'n-zoe-b'],
    ['brA', memberPrincipal({ username: 'zoe', device: 'devA' }), 'n-zoe-a'],
  ];
  for (const [conn, p, nodeId] of browsers) {
    rig.connect(conn, p);
    rig.send(conn, { type: 'node.hello', nodeId, profile: 'browser', envFingerprint: FP });
    rig.send(conn, { type: 'queue.watch', projects: ['p1'] });
  }

  // 发布清单计划 → pc 认领 → 切出两段细任务（继承 A 的身份）→ 认领、续约、完成
  const plan = clipsPlan();
  rig.send('pageA', { type: 'task.publish', tasks: [plan] });
  rig.send('pcA', { type: 'queue.watch', projects: ['p1'] });
  const planClaim = rig.ask('pcA', { type: 'task.claim', id: plan.id, expectVersion: 1 });
  assert.equal(planClaim?.type, 'task.claimed', JSON.stringify(planClaim));
  const fine = [0, 1].map((seg) => snapTask({ fp: FP, seg, derivedFrom: plan.id }));
  rig.send('pcA', { type: 'task.publish', tasks: fine });
  for (const t of fine) {
    const c = rig.ask('pcA', { type: 'task.claim', id: t.id, expectVersion: 1 });
    assert.equal(c?.type, 'task.claimed', JSON.stringify(c));
    rig.send('pcA', { type: 'task.progress', id: t.id, token: c.token, done: 30 });
    rig.send('pcA', { type: 'task.complete', id: t.id, token: c.token, result: { v: 1 } });
  }
  rig.send('pcA', { type: 'task.complete', id: plan.id, token: planClaim.token });
  rig.advance(5_000); rig.tick();

  const ids = [plan.id, ...fine.map((t) => t.id)];
  assert.deepEqual(mentions(rig, 'brB', ids), [], 'Another user\'s browser-only node should not receive A\'s task messages');
  assert.deepEqual(mentions(rig, 'brB2', ids), [], 'A browser-only node with the same name on a different device (different userId) should not receive A\'s task messages');
  // 对照：A 自己的纯浏览器看得见细任务（身份继承自 plan，契约 A.4 末段）
  const own = new Set(mentions(rig, 'brA', ids).map((m) => m.id));
  for (const t of fine) assert.ok(own.has(t.id), `A's own browser-only node should see ${t.id}`);
});

test('E5 distribution: for another user\'s browser-only node that watches later, queue.snapshot has none of A\'s open tasks; A\'s own has them', () => {
  const rig = createDocQueueRig();
  rig.connect('pageA', memberPrincipal({ username: 'zoe', device: 'devA', role: 'page' }));
  rig.send('pageA', { type: 'publisher.hello', publisherId: 'pub-A' });
  const tasks = [0, 1, 2].map((seg) => snapTask({ fp: FP, seg }));
  rig.send('pageA', { type: 'task.publish', tasks });
  const snapOf = (conn, username, device) => {
    rig.connect(conn, memberPrincipal({ username, device }));
    rig.send(conn, { type: 'node.hello', nodeId: `n-${conn}`, profile: 'browser', envFingerprint: FP });
    return rig.ask(conn, { type: 'queue.watch', projects: ['p1'] });
  };
  assert.deepEqual(snapOf('b1', 'bob', 'devB').tasks, []);
  assert.deepEqual(snapOf('b2', 'zoe', 'devB').tasks, []);
  assert.deepEqual(snapOf('b3', 'zoe', 'devA').tasks.map((t) => t.id).sort(), tasks.map((t) => t.id).sort());
});

/* ================================================================== E5 认领（M7-A2） */

test('E5 claim: another user\'s browser-only node claiming with A\'s task id always gets forbidden, without state / version; A\'s own claim of a plan returns plan-profile', () => {
  const rig = createDocQueueRig();
  rig.connect('pageA', memberPrincipal({ username: 'zoe', device: 'devA', role: 'page' }));
  rig.send('pageA', { type: 'publisher.hello', publisherId: 'pub-A' });
  const snap = snapTask({ fp: FP });
  const plan = clipsPlan();
  rig.send('pageA', { type: 'task.publish', tasks: [snap, plan] });

  for (const [conn, username, device] of [['b1', 'bob', 'devB'], ['b2', 'zoe', 'devB']]) {
    rig.connect(conn, memberPrincipal({ username, device }));
    rig.send(conn, { type: 'node.hello', nodeId: `n-${conn}`, profile: 'browser', envFingerprint: FP });
    for (const t of [snap, plan]) {
      const r = rig.ask(conn, { type: 'task.claim', id: t.id, expectVersion: 1 });
      assert.equal(r?.type, 'task.claim-rejected', JSON.stringify(r));
      assert.equal(r.reason, 'forbidden', `${username}@${device} claims ${t.kind}: ${JSON.stringify(r)}`);
      assert.equal('state' in r, false, `forbidden carries no state: ${JSON.stringify(r)}`);
      assert.equal('version' in r, false, `forbidden carries no version: ${JSON.stringify(r)}`);
    }
  }
  // 任务仍 open、没人认领
  const d = rig.describe();
  for (const t of [snap, plan]) assert.equal(d.tasks.find((x) => x.id === t.id).state, 'open');

  rig.connect('a', memberPrincipal({ username: 'zoe', device: 'devA' }));
  rig.send('a', { type: 'node.hello', nodeId: 'n-a', profile: 'browser', envFingerprint: FP });
  const r = rig.ask('a', { type: 'task.claim', id: plan.id, expectVersion: 1 });
  assert.deepEqual([r?.type, r?.reason], ['task.claim-rejected', 'plan-profile'], JSON.stringify(r));
  const own = rig.ask('a', { type: 'task.claim', id: snap.id, expectVersion: 1 });
  assert.equal(own?.type, 'task.claimed', `The user's own medium snapshot is claimed as usual: ${JSON.stringify(own)}`);
});

test("E5: browser-only watch 'all' and summary subscriptions are always forbidden", () => {
  const rig = createDocQueueRig();
  rig.connect('b', memberPrincipal({ username: 'bob', device: 'devB' }));
  rig.send('b', { type: 'node.hello', nodeId: 'n-b', profile: 'browser', envFingerprint: FP });
  const all = rig.ask('b', { type: 'queue.watch', projects: 'all' });
  assert.deepEqual([all?.type, all?.reason], ['error', 'forbidden'], JSON.stringify(all));
  const sum = rig.ask('b', { type: 'queue.watch', projects: 'all', mode: 'summary' });
  assert.deepEqual([sum?.type, sum?.reason], ['error', 'forbidden'], JSON.stringify(sum));
});

/* ================================================================== B2（M7-A3） */

const BROWSER_NODE = (userId) => ({
  profile: 'browser', userId, envFingerprint: FP, codeVersions: ['cv-1'], cardSourceVersions: {},
  capabilities: { transcode: false, streams: false, userCards: false, graphCards: false },
});

/** B2 的任务表：[任务, 该不该被纯浏览器认领, 说明] —— 全是本人（zoe@devA）的任务，除非另写 */
function b2Tasks() {
  return [
    [snapTask({ contentKey: 'light', fp: FP, weight: 'light' }), true, 'light shared-tier snapshot'],
    [snapTask({ contentKey: 'medium', fp: FP, weight: 'medium' }), true, 'medium shared-tier snapshot'],
    [snapTask({ contentKey: 'heavy', fp: FP, weight: 'heavy' }), false, 'heavy snapshot'],
    [snapTask({ contentKey: 'canvas', fp: FP, weight: 'heavy', input: { canvasHeavy: true } }), false, 'canvasHeavy (the splitter records heavy)'],
    [snapTask({ contentKey: 'local', fp: FP, weight: 'heavy', tier: 'local', input: { entryKey: 'e1', contentKey: 'e1/local' } }), false, 'local tier (the splitter records heavy)'],
    [streamTask({ fp: FP }), false, '轨道流'],
    [clipsPlan(), false, 'plan'],
    [snapTask({ contentKey: 'usercard', fp: FP, requires: { userCards: true } }), false, 'user card'],
    [snapTask({ contentKey: 'graph', fp: FP, requires: { graphCards: true } }), false, '素材效果卡'],
    [snapTask({ contentKey: 'modded', fp: FP, requires: { cardSources: { motion: 'user:abc' } } }), false, 'card with modified source'],
    [snapTask({ contentKey: 'oldcode', fp: FP, requires: { codeVersion: 'cv-0' } }), false, 'different code version'],
    [snapTask({ contentKey: 'otherfp', fp: OTHER_FP }), false, 'other environment fingerprint'],
    [snapTask({ contentKey: 'transcode', fp: FP, requires: { transcode: true } }), false, 'needs transcoding'],
  ];
}

test('B2 node-side filter: a browser-only node accepts only light / medium shared-tier snapshots; heavy, streams, plans, local tier, user cards, media effect cards and cards with modified source are never accepted', () => {
  const node = BROWSER_NODE('zoe@devA');
  for (const [task, want, what] of b2Tasks()) {
    const withUser = { ...task, source: { ...task.source, userId: 'zoe@devA' } };
    assert.equal(checkClaimable(withUser, node).ok, want, `${what}: ${JSON.stringify(checkClaimable(withUser, node))}`);
  }
  // 别人的 medium 快照：规则 0 挡
  const other = { ...snapTask({ fp: FP }), source: { projectId: 'p1', projectRev: 1, userId: 'zoe@devB' } };
  assert.equal(checkClaimable(other, node).ok, false);
});

test('B2 full 60 s run: real queue + browser-only node session, forbidden tasks are claimed 0 times, the user\'s own light / medium tasks are claimed and completed as usual, and others\' tasks are claimed 0 times', () => {
  const dq = createDirectQueue();
  const claims = new Map();
  const node = BROWSER_NODE('zoe@devA');
  let session = null;
  const toQueue = (m) => {
    if (m.type === 'task.claim') claims.set(m.id, (claims.get(m.id) ?? 0) + 1);
    dq.q.handle('br', m);
  };
  session = createNodeSession({
    nodeId: 'n-br', node, now: dq.now, send: toQueue, projects: ['p1'],
    // 认领到就立刻做完（B2 只看认领了什么）
    onTask: (task, { token }) => queueMicrotask(() => session.complete(task.id, { v: 1 })),
  });
  dq.route('br', (m) => session.receive(m));
  dq.q.connect('br', { userId: 'zoe@devA', tenantId: 'p1' });

  // 发布方：本人的全部任务，外加别人的两段 medium（同一项目）
  dq.q.connect('pageA', { userId: 'zoe@devA', tenantId: 'p1' });
  dq.q.handle('pageA', { type: 'publisher.hello', publisherId: 'pub-A' });
  dq.q.connect('pageB', { userId: 'zoe@devB', tenantId: 'p1' });
  dq.q.handle('pageB', { type: 'publisher.hello', publisherId: 'pub-B' });
  const table = b2Tasks();
  dq.q.handle('pageA', { type: 'task.publish', tasks: table.map(([t]) => t) });
  const others = [0, 1].map((seg) => snapTask({ contentKey: 'others', fp: FP, seg }));
  dq.q.handle('pageB', { type: 'task.publish', tasks: others });
  session.start();

  return (async () => {
    // 60 s，每 500 ms 一拍；每拍后让出一次，让 onTask 里排的 complete 落定
    for (let t = 0; t <= 60_000; t += 500) {
      session.tick();
      await new Promise((r) => setImmediate(r));
      dq.advance(500);
      if (t % 5_000 === 0) dq.q.tick();
    }
    const d = dq.q.describe();
    for (const [task, want, what] of table) {
      const n = claims.get(task.id) ?? 0;
      if (want) {
        assert.equal(n, 1, `${what} should be claimed exactly once, actual ${n}`);
        assert.equal(d.tasks.find((x) => x.id === task.id)?.state, 'done', `${what} should complete`);
      } else {
        assert.equal(n, 0, `${what} should be claimed 0 times by the browser-only node, actual ${n}`);
      }
    }
    for (const t of others) assert.equal(claims.get(t.id) ?? 0, 0, 'Other users\' tasks are claimed 0 times');
  })();
});

/* ================================================================== D4（节点自选：只收独立卡） */

test('D4 a browser-only node accepts only independent cards: medium snapshots whose compositing is not independent are not accepted (K7)', gateOpts(filterIndependentGate()), () => {
  const node = BROWSER_NODE('zoe@devA');
  const mk = (compositing) => {
    const t = snapTask({ contentKey: `c-${compositing}`, fp: FP, input: compositing === undefined ? {} : { compositing } });
    if (compositing === undefined) delete t.input.compositing;
    return { ...t, source: { ...t.source, userId: 'zoe@devA' } };
  };
  assert.equal(checkClaimable(mk('independent'), node).ok, true, 'independent is accepted');
  for (const c of ['sourceDependent', 'belowDependent', 'unknown', undefined]) {
    assert.equal(checkClaimable(mk(c), node).ok, false, `compositing=${c} is not accepted`);
  }
  // 只对纯浏览器加严：pc 照旧
  const pc = { ...node, profile: 'pc', editing: false };
  assert.equal(checkClaimable(mk('sourceDependent'), pc).ok, true, 'pc is not affected by D4');
});

// 主会话裁定（2026-09-28，对测试方的问题 1）：节点侧 filter.mjs 补「纯浏览器只收 tier: shared」一条（规则 7），这条改成真跑
test('D4 a browser-only node accepts only tier: shared: a local-tier task marked medium is not accepted either (filter.mjs rule 7)', gateOpts(filterIndependentGate()), () => {
  const node = BROWSER_NODE('zoe@devA');
  const t = snapTask({ contentKey: 'local-m', fp: FP, weight: 'medium', tier: 'local', input: { entryKey: 'e1', contentKey: 'e1/local-m' } });
  assert.equal(checkClaimable({ ...t, source: { ...t.source, userId: 'zoe@devA' } }, node).ok, false);
});
