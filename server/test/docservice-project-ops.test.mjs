/**
 * 项目真身（C6.5 设计稿 `docs/plan/c65-design.md` 第 2、3、10、11 节）：`project.open` / `project.op` / `project.ops` /
 * 覆盖通知 / `project.follow` / 快照与日志截断 / 大项目分片 / 与旧 `announce` 的关系。用例 DS-P1～DS-P12。
 * 设计稿验收的文档服务一侧：V2（DS-P11）、V3（DS-P5）、V4（DS-P7）。
 * 跑：node --test server/test/docservice-project-ops.test.mjs
 *
 * `createDocService` 独立模式、端口 0、`autoTick: false`；时钟注入。principal 由查询串给：
 * `?user=alice&dev=d1&role=page&conv=3`；不带 `role` 时是旧式身份 `{ userId, tenantId }`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { byType, wsClient } from './fake-ws-kit.mjs';
import { tempDir, startStandalone, ask } from './fake-docservice-env.mjs';
import { projectModule, stateBlobName } from '../docservice/modules/project.mjs';
import { contentModule } from '../docservice/modules/content.mjs';
import { eventsModule } from '../docservice/modules/events.mjs';
import { createMemoryStore, createFileStore } from '../docservice/store/index.mjs';
import { applyOps } from '../docservice/json-ops.mjs';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** 查询串 → principal：带 role 时是 M6a 形状，否则旧式 */
function authByQuery(req) {
  const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const user = q.get('user') ?? 'u-default';
  const role = q.get('role');
  if (!role) return { userId: user, tenantId: 't-test' };
  const dev = q.get('dev') ?? 'dev-1';
  return {
    userId: `${user}@${dev}`, tenantId: 't-test', scope: 'member', username: user, deviceId: dev, deviceName: dev,
    creator: false, role, conversation: q.get('conv') ? Number(q.get('conv')) : null, owner: null,
  };
}

async function start(t, { store, clock = { t: T0 }, options = {} } = {}) {
  const s = store ?? createMemoryStore();
  const now = () => clock.t;
  const project = projectModule({ store: s, now, ...options });
  const content = contentModule({ store: s, now });
  const events = eventsModule({ project, content, now });
  const env = await startStandalone({ modules: [project, content, events], now, authenticate: authByQuery });
  const clients = [];
  const cleanup = async () => {
    for (const c of clients) c.close();
    await env.cleanup();
  };
  t.after(cleanup);
  /** 按完整查询串连（`startStandalone.connect` 只认 user） */
  const connect = async (query) => {
    const c = wsClient(`${env.url()}?${query}`);
    clients.push(c);
    await c.opened;
    return c;
  };
  return { ...env, cleanup, store: s, clock, project, content, connect };
}

const open = (c, projectId = 'P') => ask(c, { type: 'project.open', projectId });
let opSeq = 0;
const op = (c, ops, extra = {}) => ask(c, { type: 'project.op', projectId: 'P', opId: `op-${++opSeq}`, ops, ...extra });
const opsOf = (c, ms = 150) => c.quiet(byType('project.ops'), ms);

const sample = () => ({
  width: 1920,
  fps: 30,
  tracks: [
    { id: 't1', name: 'A', clips: [{ id: 'c1', start: 0, end: 1 }, { id: 'c2', start: 1, end: 2 }] },
    { id: 't2', name: 'B', clips: [] },
  ],
  filters: [],
});

// ------------------------------------------------------------------ DS-P1

test('DS-P1 open 没有真身的项目：project null、rev 0、hasBody false、writers 空；旧字段 projectRev / digest / at 照旧', async (t) => {
  const env = await start(t);
  const a = await env.connect('user=alice&role=page');
  const st = await open(a, 'never');
  assert.equal(st.type, 'project.state');
  assert.deepEqual(
    { rev: st.rev, project: st.project, hasBody: st.hasBody, writers: st.writers, projectRev: st.projectRev, digest: st.digest, at: st.at },
    { rev: 0, project: null, hasBody: false, writers: [], projectRev: 0, digest: null, at: null },
  );
});

// ------------------------------------------------------------------ DS-P2

test('DS-P2 提交：ok 带 rev；project.ops 只发给提交者以外的订阅者，别的项目的订阅者 0 条；open 取回相同内容', async (t) => {
  const env = await start(t);
  const a = await env.connect('user=alice&role=page');
  const b = await env.connect('user=bob&role=page');
  const other = await env.connect('user=carol&role=page');
  await open(a);
  await open(b);
  await open(other, 'Q');

  env.clock.t = T0 + 1000;
  const ok = await op(a, [{ op: 'set', path: '', value: sample() }], { session: 'tab-a' });
  assert.deepEqual({ type: ok.type, rev: ok.rev, overwrote: ok.overwrote }, { type: 'project.op.ok', rev: 1, overwrote: [] });
  const seenB = await b.next(byType('project.ops'));
  assert.equal(seenB.rev, 1);
  assert.equal(seenB.opId, ok.opId);
  assert.deepEqual(seenB.ops, [{ op: 'set', path: '', value: sample() }]);
  assert.deepEqual(seenB.actor, { userId: 'alice@dev-1', deviceId: 'dev-1', role: 'page', conversation: null, session: 'tab-a' });
  assert.equal(seenB.at, T0 + 1000);
  assert.deepEqual(await opsOf(a), [], '提交者自己收不到 project.ops');
  assert.deepEqual(await opsOf(other), [], '别的项目的订阅者收不到');

  const ok2 = await op(b, [{ op: 'set', path: '/tracks/@t1/clips/@c2/end', value: 5 }, { op: 'insert', path: '/tracks/@t2/clips', index: 0, value: { id: 'c9', start: 0, end: 1 } }]);
  assert.equal(ok2.rev, 2);
  const seenA = await a.next(byType('project.ops'));
  assert.equal(seenA.rev, 2);
  const expected = applyOps(sample(), seenA.ops).root;
  const st = await open(await env.connect('user=dave&role=page'));
  assert.equal(st.rev, 2);
  assert.equal(st.hasBody, true);
  assert.equal(JSON.stringify(st.project), JSON.stringify(expected));
  assert.equal(st.digest, createHash('sha256').update(JSON.stringify(expected)).digest('hex'), 'digest 是真身的 sha256');
});

// ------------------------------------------------------------------ DS-P3

test('DS-P3 整批原子：后一条走不通 → rejected bad-path（带出错下标），版本不变、不广播；格式不对的操作同样 bad-path；缺 opId 回 bad-message', async (t) => {
  const env = await start(t);
  const a = await env.connect('user=alice&role=page');
  const b = await env.connect('user=bob&role=page');
  await open(a);
  await open(b);
  await op(a, [{ op: 'set', path: '', value: sample() }]);
  await b.next(byType('project.ops'));

  const r = await op(a, [{ op: 'set', path: '/width', value: 1 }, { op: 'remove', path: '/tracks/@nope/clips/@c1' }]);
  assert.equal(r.type, 'project.op.rejected');
  assert.equal(r.reason, 'bad-path');
  assert.equal(r.index, 1);
  assert.equal(r.currentRev, 1);
  const r2 = await op(a, [{ op: 'copy', path: '/width' }]);
  assert.deepEqual({ type: r2.type, reason: r2.reason, index: r2.index }, { type: 'project.op.rejected', reason: 'bad-path', index: 0 });
  const r3 = await op(a, []);
  assert.equal(r3.reason, 'bad-path', '空批');
  assert.deepEqual(await opsOf(b), [], '被拒的提交不广播');
  const st = await open(b);
  assert.equal(st.rev, 1);
  assert.equal(st.project.width, 1920, '状态不变');

  const e = await ask(a, { type: 'project.op', projectId: 'P', ops: [{ op: 'set', path: '/width', value: 2 }] });
  assert.deepEqual({ type: e.type, reason: e.reason }, { type: 'error', reason: 'bad-message' });
});

// ------------------------------------------------------------------ DS-P4

test('DS-P4 too-large：ops 序列化后超过 256 KiB；forbidden：渲染节点的连接', async (t) => {
  const env = await start(t);
  const a = await env.connect('user=alice&role=page');
  await open(a);
  const big = 'x'.repeat(256 * 1024);
  const r = await op(a, [{ op: 'set', path: '/blob', value: big }]);
  assert.deepEqual({ type: r.type, reason: r.reason, currentRev: r.currentRev }, { type: 'project.op.rejected', reason: 'too-large', currentRev: 0 });
  const ok = await op(a, [{ op: 'set', path: '/blob', value: 'x'.repeat(200 * 1024) }]);
  assert.equal(ok.type, 'project.op.ok', '256 KiB 以内可以');

  const n = await env.connect('user=node&role=render');
  const f = await op(n, [{ op: 'set', path: '/x', value: 1 }]);
  assert.deepEqual({ type: f.type, reason: f.reason, currentRev: f.currentRev }, { type: 'project.op.rejected', reason: 'forbidden', currentRev: 1 });
});

// ------------------------------------------------------------------ DS-P5（V3）

test('DS-P5（V3）期望版本：Agent 读后页面改了同一实体，Agent 的写回 stale，since 与实际改动逐条一致；重读后再写成功', async (t) => {
  const env = await start(t);
  const page = await env.connect('user=alice&dev=pc&role=page');
  const agent = await env.connect('user=alice&dev=pc&role=agent&conv=7');
  await open(page);
  await op(page, [{ op: 'set', path: '', value: sample() }], { session: 'tab-1' });
  const read = await open(agent);
  assert.equal(read.rev, 1);

  env.clock.t = T0 + 5000;
  const p1 = await op(page, [{ op: 'set', path: '/tracks/@t1/clips/@c1/start', value: 0.5 }], { session: 'tab-1' });
  env.clock.t = T0 + 6000;
  const p2 = await op(page, [
    { op: 'insert', path: '/tracks/@t2/clips', index: 0, value: { id: 'c7', start: 3, end: 4 } },
    { op: 'set', path: '/fps', value: 60 },
  ], { session: 'tab-1' });

  const w = await op(agent, [{ op: 'set', path: '/tracks/@t1/clips/@c1/end', value: 9 }], { expectRev: read.rev, session: 'conv-7' });
  assert.equal(w.type, 'project.op.rejected');
  assert.equal(w.reason, 'stale');
  assert.equal(w.currentRev, 3);
  assert.equal(w.expectRev, 1);
  assert.equal(w.sinceComplete, true);
  const pageActor = { userId: 'alice@pc', deviceId: 'pc', role: 'page', conversation: null, session: 'tab-1' };
  assert.deepEqual(w.since, [
    { rev: 2, opId: p1.opId, actor: pageActor, at: T0 + 5000, paths: ['/tracks/@t1/clips/@c1/start'], entities: ['/tracks/@t1/clips/@c1'] },
    { rev: 3, opId: p2.opId, actor: pageActor, at: T0 + 6000, paths: ['/tracks/@t2/clips/@c7', '/fps'], entities: ['/tracks/@t2/clips/@c7', '/meta/fps'] },
  ]);
  assert.deepEqual(await opsOf(page), [], '被拒的不广播');

  const reread = await open(agent);
  assert.equal(reread.rev, 3);
  const ok = await op(agent, [{ op: 'set', path: '/tracks/@t1/clips/@c1/end', value: 9 }], { expectRev: reread.rev, session: 'conv-7' });
  assert.deepEqual({ type: ok.type, rev: ok.rev }, { type: 'project.op.ok', rev: 4 });
  const seen = await page.next((m) => m.type === 'project.ops' && m.rev === 4);
  assert.deepEqual(seen.actor, { userId: 'alice@pc', deviceId: 'pc', role: 'agent', conversation: 7, session: 'conv-7' });

  // 期望版本等于当前：落地；不带期望版本：按到达顺序落地
  assert.equal((await op(page, [{ op: 'set', path: '/fps', value: 24 }])).rev, 5);
});

// ------------------------------------------------------------------ DS-P6

test('DS-P6 幂等：同一 opId 再提交回当初的 rev（duplicate），不再应用、不广播；先于 expectRev 检查', async (t) => {
  const env = await start(t);
  const a = await env.connect('user=alice&role=page');
  const b = await env.connect('user=bob&role=page');
  await open(a);
  await open(b);
  const first = await ask(a, { type: 'project.op', projectId: 'P', opId: 'fixed-1', ops: [{ op: 'set', path: '/n', value: 1 }] });
  await b.next(byType('project.ops'));
  await op(b, [{ op: 'set', path: '/m', value: 2 }]);
  const again = await ask(a, { type: 'project.op', projectId: 'P', opId: 'fixed-1', expectRev: 0, ops: [{ op: 'set', path: '/n', value: 99 }] });
  assert.deepEqual({ type: again.type, rev: again.rev, duplicate: again.duplicate }, { type: 'project.op.ok', rev: first.rev, duplicate: true });
  assert.deepEqual(await opsOf(b), []);
  const st = await open(b);
  assert.equal(st.rev, 2);
  assert.equal(st.project.n, 1);
});

// ------------------------------------------------------------------ DS-P7（V4）

test('DS-P7（V4）覆盖通知：覆盖方 ok 带 overwrote、被覆盖方先于 ops 收一条 overwritten；同一身份、超过 10 分钟、退出跟踪的都不通知被覆盖方', async (t) => {
  const env = await start(t);
  const a = await env.connect('user=alice&dev=pa&role=page');
  const b = await env.connect('user=bob&dev=pb&role=page');
  await open(a);
  await open(b);
  const actorA = { userId: 'alice@pa', deviceId: 'pa', role: 'page', conversation: null, session: 'sa' };
  const actorB = { userId: 'bob@pb', deviceId: 'pb', role: 'page', conversation: null, session: 'sb' };
  await op(a, [{ op: 'set', path: '', value: sample() }], { session: 'sa' });
  await b.next(byType('project.ops'));

  env.clock.t = T0 + 1 * MIN;
  const wa = await op(a, [{ op: 'set', path: '/tracks/@t1/clips/@c1/start', value: 0.25 }], { session: 'sa' });
  await b.next(byType('project.ops'));
  assert.deepEqual(wa.overwrote, [], '根替换之后同一身份再写：不算覆盖');

  env.clock.t = T0 + 5 * MIN;
  const wb = await op(b, [{ op: 'set', path: '/tracks/@t1/clips/@c1/start', value: 0.75 }], { session: 'sb' });
  assert.deepEqual(wb.overwrote, [{ entity: '/tracks/@t1/clips/@c1', by: actorA, rev: wa.rev, at: T0 + 1 * MIN }]);
  // 被覆盖方：overwritten 在这一版的 ops 之前到
  const first = await a.next((m) => m.type === 'project.overwritten' || m.type === 'project.ops');
  assert.equal(first.type, 'project.overwritten', '先收 overwritten 再收 ops');
  assert.deepEqual(
    { entity: first.entity, by: first.by, writer: first.writer, rev: first.rev },
    { entity: '/tracks/@t1/clips/@c1', by: actorB, writer: actorA, rev: wb.rev },
  );
  assert.equal((await a.next(byType('project.ops'))).rev, wb.rev);
  assert.deepEqual(await a.quiet(byType('project.overwritten'), 100), [], '被覆盖方只收一条');
  assert.deepEqual(await b.quiet(byType('project.overwritten'), 100), [], '覆盖方不收 overwritten');

  // 超过 10 分钟：不算覆盖
  env.clock.t = T0 + 16 * MIN;
  const late = await op(a, [{ op: 'set', path: '/tracks/@t1/clips/@c1/start', value: 0.1 }], { session: 'sa' });
  assert.deepEqual(late.overwrote, []);
  await b.next(byType('project.ops'));
  assert.deepEqual(await b.quiet(byType('project.overwritten'), 100), []);

  // 退出跟踪：a 对 c2 退出；b 覆盖 c2 时 b 仍知道，a 不收
  await op(a, [{ op: 'set', path: '/tracks/@t1/clips/@c2/end', value: 3 }], { session: 'sa' });
  await b.next(byType('project.ops'));
  const f = await ask(a, { type: 'project.follow', projectId: 'P', entity: '/tracks/@t1/clips/@c2/end', on: false, session: 'sa' });
  assert.deepEqual({ type: f.type, entity: f.entity, on: f.on }, { type: 'project.following', entity: '/tracks/@t1/clips/@c2', on: false });
  const wb2 = await op(b, [{ op: 'set', path: '/tracks/@t1/clips/@c2/end', value: 4 }], { session: 'sb' });
  assert.equal(wb2.overwrote.length, 1, '覆盖方照样知道');
  assert.equal((await a.next(byType('project.ops'))).rev, wb2.rev);
  assert.deepEqual(await a.quiet(byType('project.overwritten'), 100), [], '退出跟踪后不收');

  // 同一用户同一设备、不同页面会话：是另一个写入身份
  const a2 = await env.connect('user=alice&dev=pa&role=page');
  await open(a2);
  const x = await op(a2, [{ op: 'set', path: '/tracks/@t1/clips/@c1/start', value: 0.9 }], { session: 'sa-2' });
  assert.equal(x.overwrote.length, 1);
  assert.equal((await a.next(byType('project.overwritten'))).entity, '/tracks/@t1/clips/@c1');

  // open 的 writers：时间窗内的最近写入者
  const st = await open(b);
  const byEntity = Object.fromEntries(st.writers.map((w) => [w.entity, w.actor.session]));
  assert.equal(byEntity['/tracks/@t1/clips/@c1'], 'sa-2');
  assert.equal(byEntity['/tracks/@t1/clips/@c2'], 'sb');
});

// ------------------------------------------------------------------ DS-P8

test('DS-P8 落盘：每 N 次提交落快照、日志截断到快照之后；重启读快照再回放，版本、内容、幂等、最近写入者都接得上', async (t) => {
  const dir = tempDir(t, 'pc-c65-');
  const clock = { t: T0 };
  const env = await start(t, { store: createFileStore({ dir, log: () => {} }), clock, options: { snapshotEvery: 5 } });
  const a = await env.connect('user=alice&role=page');
  await open(a);
  await op(a, [{ op: 'set', path: '', value: sample() }], { session: 's' });
  for (let i = 1; i <= 11; i += 1) {
    clock.t = T0 + i * 1000;
    await ask(a, { type: 'project.op', projectId: 'P', opId: `k-${i}`, session: 's', ops: [{ op: 'set', path: '/tracks/@t1/clips/@c1/start', value: i }] });
  }
  const before = await open(a);
  assert.equal(before.rev, 12);
  assert.ok(existsSync(join(dir, stateBlobName('P'))), `快照文件在：${readdirSync(join(dir, 'projects')).join(', ')}`);
  const snap = JSON.parse(readFileSync(join(dir, stateBlobName('P')), 'utf8'));
  assert.equal(snap.rev, 10, '第 10 次提交时落的快照');
  const logLines = readFileSync(join(dir, 'projects', 'P.ops.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(logLines.map((r) => r.rev), [11, 12], '日志截断到快照之后');
  for (const r of logLines) for (const k of ['projectId', 'rev', 'opId', 'ops', 'actor', 'at', 'entities']) assert.ok(Object.hasOwn(r, k), `日志行缺 ${k}`);
  await env.cleanup();

  const env2 = await start(t, { store: createFileStore({ dir, log: () => {} }), clock, options: { snapshotEvery: 5 } });
  const b = await env2.connect('user=bob&role=page');
  const after = await open(b);
  assert.equal(after.rev, 12);
  assert.equal(JSON.stringify(after.project), JSON.stringify(before.project), '内容逐字节相同');
  const dup = await ask(b, { type: 'project.op', projectId: 'P', opId: 'k-3', ops: [{ op: 'set', path: '/x', value: 1 }] });
  assert.deepEqual({ rev: dup.rev, duplicate: dup.duplicate }, { rev: 4, duplicate: true }, '重启前的 opId 仍认得（快照里的）');
  const dup2 = await ask(b, { type: 'project.op', projectId: 'P', opId: 'k-11', ops: [{ op: 'set', path: '/x', value: 1 }] });
  assert.equal(dup2.rev, 12, '重启前的 opId 仍认得（日志回放的）');
  clock.t = T0 + 20_000;
  const w = await op(b, [{ op: 'set', path: '/tracks/@t1/clips/@c1/start', value: 100 }], { session: 'other' });
  assert.equal(w.rev, 13);
  assert.equal(w.overwrote.length, 1, '最近写入者跨重启保留');
});

// ------------------------------------------------------------------ DS-P9

test('DS-P9 与旧 announce 的关系：没有真身时 announce 照旧发号；有真身后 announce 不发号、摘要以真身为准；当前版本的 M5b 快照由真身发回', async (t) => {
  const env = await start(t);
  const a = await env.connect('user=alice');
  const b = await env.connect('user=bob');
  await open(a);
  await open(b);
  const dg = createHash('sha256').update('x').digest('hex');
  const an = await ask(a, { type: 'project.announce', projectId: 'P', digest: dg });
  assert.deepEqual({ projectRev: an.projectRev, changed: an.changed }, { projectRev: 1, changed: true });
  assert.equal((await b.next(byType('project.rev'))).projectRev, 1);

  const ok = await op(a, [{ op: 'set', path: '', value: sample() }]);
  assert.equal(ok.rev, 2, '版本号只有一个：接着 announce 的往上加');
  const text = JSON.stringify(sample());
  const bodyDigest = createHash('sha256').update(text).digest('hex');
  const an2 = await ask(a, { type: 'project.announce', projectId: 'P', digest: dg });
  assert.deepEqual(
    { projectRev: an2.projectRev, changed: an2.changed, digest: an2.digest, authoritative: an2.authoritative, matches: an2.matches },
    { projectRev: 2, changed: false, digest: bodyDigest, authoritative: true, matches: false },
  );
  const an3 = await ask(a, { type: 'project.announce', projectId: 'P', digest: bodyDigest });
  assert.equal(an3.matches, true);
  assert.deepEqual(await b.quiet(byType('project.rev'), 100), [], '有真身后 announce 不广播 project.rev');

  const reqId = 'snap-1';
  b.send({ type: 'project.snapshot.get', projectId: 'P', projectRev: 2, reqId });
  let got = '';
  for (;;) {
    const m = await b.next((x) => x.reqId === reqId);
    if (m.type === 'project.snapshot.end') { assert.equal(m.digest, bodyDigest); break; }
    assert.equal(m.missing, undefined, '当前版本能取回');
    got += m.data;
  }
  assert.equal(got, text);
  const st = await open(b);
  assert.deepEqual({ rev: st.rev, projectRev: st.projectRev, digest: st.digest }, { rev: 2, projectRev: 2, digest: bodyDigest });
});

// ------------------------------------------------------------------ DS-P10

test('DS-P10 大项目：project.upload 分片传整份、project.op 引用它做根替换；别的订阅者收 resync；open 分片发回，拼起来逐字节相同', async (t) => {
  const env = await start(t);
  const a = await env.connect('user=alice&role=page');
  const b = await env.connect('user=bob&role=page');
  await open(a);
  await open(b);
  const big = sample();
  big.tracks[0].clips = Array.from({ length: 6000 }, (_, i) => ({ id: `c${i}`, start: i, end: i + 1, params: { text: `片段 ${i} ${'z'.repeat(100)}` } }));
  const text = JSON.stringify(big);
  assert.ok(Buffer.byteLength(text) > 512 * 1024);
  const chunk = 200 * 1024;
  const count = Math.ceil(text.length / chunk);
  let last;
  for (let i = 0; i < count; i += 1) {
    last = await ask(a, { type: 'project.upload', projectId: 'P', uploadId: 'u1', index: i, count, data: text.slice(i * chunk, (i + 1) * chunk) });
  }
  assert.equal(last.complete, true);
  const ok = await op(a, [{ op: 'set', path: '', upload: 'u1' }]);
  assert.deepEqual({ type: ok.type, rev: ok.rev }, { type: 'project.op.ok', rev: 1 });
  const seen = await b.next(byType('project.ops'));
  assert.deepEqual({ rev: seen.rev, resync: seen.resync, ops: seen.ops }, { rev: 1, resync: true, ops: undefined });
  const reused = await op(a, [{ op: 'set', path: '', upload: 'u1' }]);
  assert.equal(reused.reason, 'bad-path', '上传用过一次就没了');

  const reqId = 'open-big';
  b.send({ type: 'project.open', projectId: 'P', reqId });
  const head = await b.next((m) => m.reqId === reqId && m.type === 'project.state');
  assert.equal(head.project, undefined);
  assert.ok(head.parts > 1);
  let got = '';
  for (;;) {
    const m = await b.next((x) => x.reqId === reqId, 5000);
    if (m.type === 'project.state.end') { assert.equal(m.digest, head.digest); break; }
    assert.equal(m.type, 'project.state.part');
    got += m.data;
  }
  assert.equal(got, text);
});

// ------------------------------------------------------------------ DS-P11（V2）

/** 可复现的随机数 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按本地副本随机造一批编辑（可能因为别人刚改过而走不通，那就被拒） */
function randomOps(view, rand, tag, n) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const tracks = view.tracks;
  const track = pick(tracks);
  const clips = track.clips;
  const k = rand();
  if (k < 0.35 || clips.length === 0) {
    return [{ op: 'insert', path: `/tracks/@${track.id}/clips`, index: Math.floor(rand() * (clips.length + 2)), value: { id: `${tag}-${n}`, start: n, end: n + 1 } }];
  }
  const clip = pick(clips);
  if (k < 0.7) return [{ op: 'set', path: `/tracks/@${track.id}/clips/@${clip.id}/start`, value: Math.round(rand() * 1000) / 10 }, { op: 'set', path: `/tracks/@${track.id}/name`, value: `${tag}${n}` }];
  if (k < 0.85) return [{ op: 'move', path: `/tracks/@${track.id}/clips/@${clip.id}`, index: Math.floor(rand() * clips.length) }];
  return [{ op: 'remove', path: `/tracks/@${track.id}/clips/@${clip.id}` }];
}

test('DS-P11（V2 服务端一侧）两个页面各 200 次随机编辑交错提交：两边按 rev 重建的副本、旁观者、文档服务三份逐字节相同', async (t) => {
  const env = await start(t);
  const init = await env.connect('user=init&role=page');
  await open(init);
  await op(init, [{ op: 'set', path: '', value: sample() }]);

  const watcher = await env.connect('user=watch&role=page');
  const w0 = await open(watcher);
  const watch = { view: w0.project, rev: w0.rev, order: [] };
  watcher.ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.type !== 'project.ops') return;
    assert.equal(m.rev, watch.rev + 1, '旁观者按 rev 连续收到');
    watch.view = applyOps(watch.view, m.ops).root;
    watch.rev = m.rev;
    watch.order.push(m.actor.session);
  });

  async function editor(name, seed) {
    const c = await env.connect(`user=${name}&role=page`);
    const st = await open(c);
    const me = { view: st.project, rev: st.rev, accepted: 0, rejected: 0 };
    let pending = null;
    c.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'project.ops') {
        assert.equal(m.rev, me.rev + 1, `${name} 收到的 ops 按 rev 连续`);
        me.view = applyOps(me.view, m.ops).root;
        me.rev = m.rev;
      } else if (m.type === 'project.op.ok' && pending && m.opId === pending.opId) {
        assert.equal(m.rev, me.rev + 1, `${name} 的 ok 排在它之前的 ops 之后`);
        me.view = applyOps(me.view, pending.ops).root;
        me.rev = m.rev;
      }
    });
    const rand = rng(seed);
    for (let n = 0; n < 200; n += 1) {
      const ops = randomOps(me.view, rand, name, n);
      pending = { opId: `${name}-${n}`, ops };
      const r = await ask(c, { type: 'project.op', projectId: 'P', opId: pending.opId, session: name, ops }, 5000);
      if (r.type === 'project.op.ok') me.accepted += 1;
      else {
        assert.equal(r.reason, 'bad-path', `${name} 只会因为别人刚改过而走不通：${JSON.stringify(r)}`);
        me.rejected += 1;
      }
      pending = null;
      if (n % 7 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    return me;
  }

  const [x, y] = await Promise.all([editor('ann', 11), editor('ben', 22)]);
  const finalRev = 1 + x.accepted + y.accepted;
  await (async () => {
    const until = Date.now() + 5000;
    while ((x.rev < finalRev || y.rev < finalRev || watch.rev < finalRev) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  })();
  const server = await open(await env.connect('user=check&role=page'));
  assert.equal(server.rev, finalRev);
  assert.ok(x.accepted > 100 && y.accepted > 100, `大部分落地：${x.accepted}、${y.accepted}（拒 ${x.rejected}、${y.rejected}）`);
  const s = JSON.stringify(server.project);
  assert.equal(JSON.stringify(x.view), s, 'ann 的副本与文档服务逐字节相同');
  assert.equal(JSON.stringify(y.view), s, 'ben 的副本与文档服务逐字节相同');
  assert.equal(JSON.stringify(watch.view), s, '旁观者的副本与文档服务逐字节相同');
  const switches = watch.order.slice(1).filter((who, i) => who !== watch.order[i]).length;
  assert.ok(switches >= 50, `两边的提交确实交错落地（相邻两次换人 ${switches} 次）`);
  t.diagnostic(`交错 ${switches} 次；rev ${finalRev}；ann 落地 ${x.accepted} 拒 ${x.rejected}；ben 落地 ${y.accepted} 拒 ${y.rejected}`);
});

// ------------------------------------------------------------------ DS-P12

test('DS-P12 日志与广播的 actor 取自 principal（M6a 形状 + session），消息里自报的不认；旧式身份照 M5 记 { userId, session }', async (t) => {
  const env = await start(t);
  const agent = await env.connect('user=zoe&dev=d9&role=agent&conv=4');
  const legacy = await env.connect('user=old');
  const watcher = await env.connect('user=w&role=page');
  await open(watcher);
  await ask(agent, { type: 'project.op', projectId: 'P', opId: 'a1', session: 's1', actor: { userId: 'forged' }, userId: 'forged', ops: [{ op: 'set', path: '/a', value: 1 }] });
  await ask(legacy, { type: 'project.op', projectId: 'P', opId: 'a2', ops: [{ op: 'set', path: '/b', value: 1 }] });
  const recs = env.store.read('projects/P.ops');
  assert.deepEqual(recs.map((r) => r.actor), [
    { userId: 'zoe@d9', deviceId: 'd9', role: 'agent', conversation: 4, session: 's1' },
    { userId: 'old', session: null },
  ]);
  const seen = await watcher.next(byType('project.ops'));
  assert.deepEqual(seen.actor, recs[0].actor);
});
