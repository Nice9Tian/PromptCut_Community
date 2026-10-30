/**
 * 项目版本模块（契约 `docs/plan/docservice-contract.md` 第 1 节、第 3 节，用例 P1～P7）。
 * 跑：node --test server/test/docservice-project.test.mjs
 *
 * 只照契约写，不看实现。被测模块用动态 import 取，模块缺失时每条用例各自失败。
 * `createDocService` 独立模式、端口 0、`autoTick: false`；时钟用 `now` 注入；存储用 memory 或临时目录。
 * principal 由测试的 `authenticate` 按查询串 `?user=` 给出（见 `fake-docservice-env.mjs`）。
 * 本模块的回包都原样带回请求的 `reqId`（契约第 1 节），测试按 `reqId` 取回包。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { byType } from './fake-ws-kit.mjs';
import { loadStore, loadProject, tempDir, startStandalone, ask } from './fake-docservice-env.mjs';

const T0 = 1_700_000_000_000;
/** 64 位十六进制摘要 */
const dg = (seed) => createHash('sha256').update(String(seed)).digest('hex');

async function start({ store, clock = { t: T0 } } = {}) {
  const { createMemoryStore } = await loadStore();
  const makeProject = await loadProject();
  const s = store ?? createMemoryStore();
  const now = () => clock.t;
  const env = await startStandalone({ modules: [makeProject({ store: s, now })], now });
  return { ...env, store: s, clock };
}

const open = (c, projectId) => ask(c, { type: 'project.open', projectId });
const announce = (c, fields) => ask(c, { type: 'project.announce', ...fields });
const revs = (c, ms = 150) => c.quiet(byType('project.rev'), ms);

// ------------------------------------------------------------------ P1

test('P1 project.open 没见过的项目：projectRev 0、digest null、at null，回包带 reqId；模块名进 /healthz', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const reqId = 'open-1';
  c.send({ type: 'project.open', projectId: 'never-seen', reqId });
  const st = await c.next((m) => m.reqId === reqId);
  assert.equal(st.type, 'project.state');
  assert.deepEqual(
    { projectId: st.projectId, projectRev: st.projectRev, digest: st.digest, at: st.at },
    { projectId: 'never-seen', projectRev: 0, digest: null, at: null },
  );
  const h = await env.health();
  assert.ok(Array.isArray(h.modules) && h.modules.includes('project'), `/healthz.modules 要含 project：${JSON.stringify(h.modules)}`);

  // 契约第 10 节第 5 条：不往 /healthz 加字段，只提供 describe()
  const bare = await startStandalone({ modules: [] });
  t.after(bare.cleanup);
  assert.deepEqual(Object.keys(h).sort(), Object.keys(await bare.health()).sort(), '挂上项目模块后 /healthz 的字段集不变');
  const d = env.service.describe();
  assert.ok(Object.hasOwn(d.modules, 'project'), 'describe().modules 里有 project');
  assert.notEqual(d.modules.project, null, '项目模块提供 describe()');
});

// ------------------------------------------------------------------ P2

test('P2 announce 新摘要：projectRev 加一；只有订阅了这个项目的连接收到 project.rev，别的项目的订阅者 0 条', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const a = await env.connect('alice');
  const b = await env.connect('bob');
  const other = await env.connect('carol');
  const idle = await env.connect('dave');
  assert.equal((await open(a, 'proj-A')).projectRev, 0);
  assert.equal((await open(b, 'proj-A')).projectRev, 0);
  assert.equal((await open(other, 'proj-B')).projectRev, 0);

  env.clock.t = T0 + 1000;
  const ack = await announce(a, { projectId: 'proj-A', digest: dg(1), session: 'tab-1' });
  assert.deepEqual(
    { type: ack.type, projectId: ack.projectId, projectRev: ack.projectRev, changed: ack.changed },
    { type: 'project.announced', projectId: 'proj-A', projectRev: 1, changed: true },
  );

  const expected = { type: 'project.rev', projectId: 'proj-A', projectRev: 1, digest: dg(1), actor: { userId: 'alice', session: 'tab-1' }, at: T0 + 1000 };
  const pick = (m) => ({ type: m.type, projectId: m.projectId, projectRev: m.projectRev, digest: m.digest, actor: m.actor, at: m.at });
  assert.deepEqual(pick(await b.next(byType('project.rev'))), expected, '同项目的另一个订阅者收到 project.rev');
  assert.deepEqual(pick(await a.next(byType('project.rev'))), expected, '发起方自己也在订阅者之列');
  // 契约第 10 节第 2 条：同一条请求先回包、后广播
  const iAck = a.all.findIndex((m) => m.type === 'project.announced');
  const iRev = a.all.findIndex((m) => m.type === 'project.rev');
  assert.ok(iAck >= 0 && iRev > iAck, `project.announced 先于 project.rev：announced@${iAck}、rev@${iRev}`);
  assert.deepEqual(await revs(other), [], '别的项目的订阅者 0 条');
  assert.deepEqual(await revs(idle), [], '没 open 的连接 0 条');
  assert.equal(idle.all.filter(byType('project.announced')).length, 0, '不向发起方以外的连接回 project.announced');
  assert.equal(b.all.filter(byType('project.announced')).length, 0, '不向发起方以外的连接回 project.announced');

  // 第二次变化：再加一
  env.clock.t = T0 + 2000;
  const ack2 = await announce(b, { projectId: 'proj-A', digest: dg(2) });
  assert.equal(ack2.projectRev, 2);
  assert.equal(ack2.changed, true);
  const r2 = await a.next(byType('project.rev'));
  assert.deepEqual(pick(r2), { type: 'project.rev', projectId: 'proj-A', projectRev: 2, digest: dg(2), actor: { userId: 'bob', session: null }, at: T0 + 2000 },
    '没带 session 时 actor.session 为 null');
  await b.next(byType('project.rev'));

  // 没 open 的连接也能 announce：拿到 announced，但收不到广播
  const ack3 = await announce(idle, { projectId: 'proj-A', digest: dg(3) });
  assert.equal(ack3.projectRev, 3);
  assert.deepEqual(await revs(idle), [], '发起方没订阅就收不到 project.rev');
  assert.equal((await a.next(byType('project.rev'))).projectRev, 3);

  // 状态
  const st = await open(other, 'proj-A');
  assert.deepEqual({ projectRev: st.projectRev, digest: st.digest, at: st.at }, { projectRev: 3, digest: dg(3), at: T0 + 2000 });
  // project.close 退订
  const closedAck = await ask(b, { type: 'project.close', projectId: 'proj-A' });
  assert.deepEqual({ type: closedAck.type, projectId: closedAck.projectId }, { type: 'project.closed', projectId: 'proj-A' });
  await announce(a, { projectId: 'proj-A', digest: dg(4) });
  assert.equal((await a.next(byType('project.rev'))).projectRev, 4);
  assert.deepEqual(await revs(b), [], 'close 之后收不到');
});

// ------------------------------------------------------------------ P3

test('P3 相同摘要：不加，changed: false，没有广播，不写日志', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const a = await env.connect('alice');
  const w = await env.connect('bob');
  await open(a, 'p3');
  await open(w, 'p3');
  assert.equal((await announce(a, { projectId: 'p3', digest: dg('x') })).projectRev, 1);
  await w.next(byType('project.rev'));
  await a.next(byType('project.rev'));
  const before = env.store.read('projects/p3').length;

  env.clock.t = T0 + 5000;
  const ack = await announce(a, { projectId: 'p3', digest: dg('x'), session: 's' });
  assert.deepEqual(
    { type: ack.type, projectId: ack.projectId, projectRev: ack.projectRev, changed: ack.changed },
    { type: 'project.announced', projectId: 'p3', projectRev: 1, changed: false },
  );
  assert.deepEqual(await revs(w), [], '没有广播');
  assert.deepEqual(await revs(a, 0), [], '发起方也没有');
  assert.equal(env.store.read('projects/p3').length, before, '相同摘要不写日志');
  const st = await open(w, 'p3');
  assert.deepEqual({ projectRev: st.projectRev, digest: st.digest, at: st.at }, { projectRev: 1, digest: dg('x'), at: T0 }, 'at 不变');
});

// ------------------------------------------------------------------ P4

test('P4 文件存储：服务关掉后在同一目录新建，projectRev 与 digest 恢复，下一次 announce 从恢复值往上加', async (t) => {
  const dir = tempDir(t);
  const { createFileStore } = await loadStore();
  const clock = { t: T0 };
  const env1 = await start({ store: createFileStore({ dir }), clock });
  t.after(env1.cleanup);
  const a = await env1.connect('alice');
  for (let i = 1; i <= 3; i++) {
    clock.t = T0 + i;
    assert.equal((await announce(a, { projectId: 'p4', digest: dg(i) })).projectRev, i);
  }
  assert.equal((await announce(a, { projectId: 'p4-other', digest: dg('o') })).projectRev, 1);
  // 合法的 projectId 可以含 ':'（契约第 1 节的正则）；文件名怎么映射由实现决定，这里只要求能恢复
  assert.equal((await announce(a, { projectId: 'scene:p4', digest: dg('c1') })).projectRev, 1);
  assert.equal((await announce(a, { projectId: 'scene:p4', digest: dg('c2') })).projectRev, 2);
  // 只差大小写的两个项目（契约第 10 节第 9 条：Windows 上可能落到同一个文件，回放按 projectId 过滤）
  assert.equal((await announce(a, { projectId: 'CaseP4', digest: dg('U1') })).projectRev, 1);
  assert.equal((await announce(a, { projectId: 'casep4', digest: dg('l1') })).projectRev, 1);
  assert.equal((await announce(a, { projectId: 'casep4', digest: dg('l2') })).projectRev, 2);
  await env1.cleanup();

  clock.t = T0 + 100;
  const env2 = await start({ store: createFileStore({ dir }), clock });
  t.after(env2.cleanup);
  const b = await env2.connect('bob');
  const st = await open(b, 'p4');
  assert.deepEqual({ projectRev: st.projectRev, digest: st.digest, at: st.at }, { projectRev: 3, digest: dg(3), at: T0 + 3 });
  assert.equal((await open(b, 'p4-other')).projectRev, 1, '各项目各自恢复');
  const colon = await open(b, 'scene:p4');
  assert.deepEqual({ projectRev: colon.projectRev, digest: colon.digest }, { projectRev: 2, digest: dg('c2') }, '含冒号的 projectId 也能恢复');
  const upper = await open(b, 'CaseP4');
  const lower = await open(b, 'casep4');
  assert.deepEqual([upper.projectRev, upper.digest, lower.projectRev, lower.digest], [1, dg('U1'), 2, dg('l2')], '只差大小写的项目各自恢复');

  const same = await announce(b, { projectId: 'p4', digest: dg(3) });
  assert.deepEqual({ projectRev: same.projectRev, changed: same.changed }, { projectRev: 3, changed: false }, '恢复出的摘要参与比较');
  const next = await announce(b, { projectId: 'p4', digest: dg(4) });
  assert.deepEqual({ projectRev: next.projectRev, changed: next.changed }, { projectRev: 4, changed: true });
  assert.equal((await b.next(byType('project.rev'))).projectRev, 4);
});

// ------------------------------------------------------------------ P5

test('P5 日志文件逐行是合法 JSON，字段齐全，actor.userId 来自 principal，不来自消息', async (t) => {
  const dir = tempDir(t);
  const { createFileStore } = await loadStore();
  const clock = { t: T0 };
  const env = await start({ store: createFileStore({ dir }), clock });
  t.after(env.cleanup);
  const a = await env.connect('alice');
  clock.t = T0 + 10;
  await announce(a, { projectId: 'p5', digest: dg(1), session: 'tab-9', userId: 'mallory', actor: { userId: 'mallory', session: 'x' } });
  clock.t = T0 + 20;
  await announce(a, { projectId: 'p5', digest: dg(2), userId: 'mallory' });
  clock.t = T0 + 30;
  await announce(a, { projectId: 'p5', digest: dg(2) }); // 相同，不写

  const file = join(dir, 'projects', 'p5.ndjson');
  assert.ok(existsSync(file), `日志文件在 <dir>/projects/<projectId>.ndjson：${JSON.stringify(readdirSync(dir, { recursive: true }))}`);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'), '每行以换行结束');
  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2, '两次变更两行');
  const records = lines.map((l, i) => {
    try { return JSON.parse(l); } catch { assert.fail(`第 ${i + 1} 行不是合法 JSON：${l}`); }
  });
  for (const r of records) {
    for (const k of ['projectId', 'rev', 'digest', 'actor', 'at']) assert.ok(Object.hasOwn(r, k), `缺字段 ${k}：${JSON.stringify(r)}`);
  }
  const pick = (r) => ({ projectId: r.projectId, rev: r.rev, digest: r.digest, actor: r.actor, at: r.at });
  assert.deepEqual(records.map(pick), [
    { projectId: 'p5', rev: 1, digest: dg(1), actor: { userId: 'alice', session: 'tab-9' }, at: T0 + 10 },
    { projectId: 'p5', rev: 2, digest: dg(2), actor: { userId: 'alice', session: null }, at: T0 + 20 },
  ]);
  assert.ok(!text.includes('mallory'), '消息里自报的 userId 一律不认，也不进日志');
});

// ------------------------------------------------------------------ P6

test('P6 校验：projectId、digest、session 不合法 → bad-message（带 reqId），状态不变', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const a = await env.connect('alice');
  const w = await env.connect('bob');
  await open(w, 'p6');
  await announce(a, { projectId: 'p6', digest: dg(1) });
  await w.next(byType('project.rev'));

  const badIds = ['', 'a b', 'x'.repeat(129), '../etc', 'p/6', 'p\\6', 42, null, undefined, { id: 'p6' }];
  const badDigests = [dg(2).slice(0, 15), dg(2).toUpperCase(), 'g'.repeat(16), '0'.repeat(129), '', 1234567890123456, null, undefined];
  const badSessions = ['', 'x'.repeat(129), 5, { s: 1 }, ['s']];

  const cases = [];
  for (const projectId of badIds) {
    cases.push({ type: 'project.open', projectId });
    cases.push({ type: 'project.announce', projectId, digest: dg(2) });
    cases.push({ type: 'project.close', projectId });
  }
  for (const digest of badDigests) cases.push({ type: 'project.announce', projectId: 'p6', digest });
  for (const session of badSessions) cases.push({ type: 'project.announce', projectId: 'p6', digest: dg(2), session });

  let n = 0;
  for (const msg of cases) {
    // 按 reqId 或 error 类型等，免得 reqId 没带回时每条都等到超时；reqId 另行断言
    const reqId = `p6-${++n}`;
    a.send({ ...msg, reqId });
    const reply = await a.next((m) => m.reqId === reqId || m.type === 'error');
    assert.equal(reply.reqId, reqId, `错误回包要原样带回 reqId：${JSON.stringify(reply)}`);
    assert.equal(reply.type, 'error', `应拒绝：${JSON.stringify(msg)} → ${JSON.stringify(reply)}`);
    assert.equal(reply.reason, 'bad-message', `应为 bad-message：${JSON.stringify(msg)} → ${JSON.stringify(reply)}`);
  }
  assert.deepEqual(await revs(w), [], '没有广播');
  assert.deepEqual(a.all.filter(byType('project.rev')), [], '被拒的 open 没有订阅上任何东西');
  assert.equal(env.store.read('projects/p6').length, 1, '日志没多写');
  const st = await open(w, 'p6');
  assert.deepEqual({ projectRev: st.projectRev, digest: st.digest }, { projectRev: 1, digest: dg(1) }, '状态不变');

  // 边界上合法的值照常通过
  const ok = await announce(a, { projectId: 'A-z.0_:9', digest: '0123456789abcdef', session: 'x'.repeat(128) });
  assert.deepEqual({ type: ok.type, projectRev: ok.projectRev }, { type: 'project.announced', projectRev: 1 });
  const ok2 = await announce(a, { projectId: 'y'.repeat(128), digest: 'f'.repeat(128), session: 's' });
  assert.deepEqual({ type: ok2.type, projectRev: ok2.projectRev }, { type: 'project.announced', projectRev: 1 });
});

// ------------------------------------------------------------------ P7

test('P7 日志最后一行被截断（手工写半行）：恢复时丢掉这一行、不崩，之前的记录都在', async (t) => {
  const dir = tempDir(t);
  const { createFileStore } = await loadStore();
  const clock = { t: T0 };
  const env1 = await start({ store: createFileStore({ dir }), clock });
  t.after(env1.cleanup);
  const a = await env1.connect('alice');
  await announce(a, { projectId: 'p7', digest: dg(1) });
  await announce(a, { projectId: 'p7', digest: dg(2) });
  await env1.cleanup();

  const file = join(dir, 'projects', 'p7.ndjson');
  assert.ok(existsSync(file), '日志文件在 <dir>/projects/p7.ndjson');
  appendFileSync(file, `{"projectId":"p7","rev":3,"digest":"${dg(3).slice(0, 20)}`); // 半行，没有换行

  const env2 = await start({ store: createFileStore({ dir }), clock });
  t.after(env2.cleanup);
  const b = await env2.connect('bob');
  const st = await open(b, 'p7');
  assert.deepEqual({ projectRev: st.projectRev, digest: st.digest }, { projectRev: 2, digest: dg(2) }, '半行丢弃，之前的记录都在');

  const recs = createFileStore({ dir }).read('projects/p7');
  assert.deepEqual(recs.map((r) => r.rev), [1, 2], 'Store.read 丢掉坏掉的最后一行');
});

test('P7 截断恢复之后再追加、再重启：新记录不被半行污染，projectRev 接着往上加', async (t) => {
  const dir = tempDir(t);
  const { createFileStore } = await loadStore();
  const clock = { t: T0 };
  const env1 = await start({ store: createFileStore({ dir }), clock });
  t.after(env1.cleanup);
  const a = await env1.connect('alice');
  await announce(a, { projectId: 'p7b', digest: dg(1) });
  await announce(a, { projectId: 'p7b', digest: dg(2) });
  await env1.cleanup();
  appendFileSync(join(dir, 'projects', 'p7b.ndjson'), '{"projectId":"p7b","rev":3,"dig');

  const env2 = await start({ store: createFileStore({ dir }), clock });
  t.after(env2.cleanup);
  const b = await env2.connect('bob');
  const ack = await announce(b, { projectId: 'p7b', digest: dg(3) });
  assert.deepEqual({ projectRev: ack.projectRev, changed: ack.changed }, { projectRev: 3, changed: true });
  await env2.cleanup();

  const env3 = await start({ store: createFileStore({ dir }), clock });
  t.after(env3.cleanup);
  const c = await env3.connect('carol');
  const st = await open(c, 'p7b');
  assert.deepEqual({ projectRev: st.projectRev, digest: st.digest }, { projectRev: 3, digest: dg(3) }, '截断之后追加的那一行完好');
  const recs = createFileStore({ dir }).read('projects/p7b');
  assert.deepEqual(recs.map((r) => r.rev), [1, 2, 3]);
});

test('P7 存储层：memory 与文件两种 Store 都按顺序读回；路径穿越被拒，不在目录外写文件', async (t) => {
  const { createFileStore, createMemoryStore } = await loadStore();
  const root = tempDir(t);
  const dir = join(root, 'store');
  for (const [name, store] of [['memory', createMemoryStore()], ['file', createFileStore({ dir })]]) {
    assert.deepEqual(store.read('projects/none'), [], `${name}：没写过的 stream 读出空数组`);
    store.append('projects/s1', { n: 1, s: '中文' });
    store.append('projects/s1', { n: 2 });
    store.append('content/card-source', { n: 3 });
    assert.deepEqual(store.read('projects/s1'), [{ n: 1, s: '中文' }, { n: 2 }], `${name}：按追加顺序读回`);
    assert.deepEqual(store.read('content/card-source'), [{ n: 3 }], `${name}：stream 之间互不串`);
  }
  assert.ok(existsSync(join(dir, 'projects', 's1.ndjson')), '文件映射为 <dir>/projects/<id>.ndjson');
  assert.ok(existsSync(join(dir, 'content', 'card-source.ndjson')), '文件映射为 <dir>/content/<kind>.ndjson');

  const fileStore = createFileStore({ dir });
  for (const bad of ['../evil', 'projects/../../evil', '..\\evil', 'projects/..\\..\\evil']) {
    let threw = false;
    try { fileStore.append(bad, { bad: true }); } catch { threw = true; }
    const outside = readdirSync(root, { recursive: true }).filter((p) => String(p).includes('evil'));
    assert.deepEqual(outside, [], `路径穿越 ${bad} 不能在目录外写文件（threw=${threw}）`);
  }
});
