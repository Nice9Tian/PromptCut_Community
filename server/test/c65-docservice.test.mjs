/**
 * C6.5 文档服务的项目真身（设计稿 `docs/plan/c65-design.md` 第 3 节；验收 V3、V4 的服务端部分）。
 * 跑：node --test server/test/c65-docservice.test.mjs
 *
 * 只照设计稿写，不看实现。服务用 `createDocService` 独立模式 + 项目模块（假设 A3），消息字段见假设 A4～A6。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  startProjectService, openProject, submit, seedProject, serverState, isOk, isRejected, byType, byIs,
  fixedProject, clipOf, tempDir, T0, MIN, rng, newOpId,
} from './c65-kit.mjs';

const PID = 'c65-proj';
const quietOps = (c, ms = 150) => c.quiet(byType('project.ops'), ms);
const quietOverwritten = (c, ms = 150) => c.quiet(byType('project.overwritten'), ms);

/** 种子（根替换）在一小时前写入，免得种子的写入身份在 10 分钟窗口里、干扰覆盖通知的断言 */
async function withSeed(t, opts = {}) {
  const env = await startProjectService(opts);
  t.after(env.cleanup);
  const t0 = env.clock.t;
  env.clock.t = t0 - 60 * MIN;
  const rev = await seedProject(env, PID, fixedProject({ clips: 4 }));
  env.clock.t = t0;
  return { env, rev };
}

// ------------------------------------------------------------------ 打开与提交

test('C65-V3-01 project.open 回 project.state { projectId, rev, project, writers }；根替换种子后 rev 为 1、project 逐项相同', async (t) => {
  const env = await startProjectService();
  t.after(env.cleanup);
  const c = await env.connect({ user: 'alice', dev: 'd-a' });
  const st0 = await openProject(c, 'fresh-proj');
  assert.equal(st0.rev, 0, `没写过的项目 rev 为 0：${JSON.stringify(st0)}`);
  assert.ok('project' in st0, 'project.state 带 project 字段');
  assert.ok('writers' in st0, 'project.state 带 writers 字段');

  const p = fixedProject({ clips: 3 });
  const ok = await submit(c, { projectId: 'fresh-proj', ops: [{ op: 'set', path: '', value: p }], session: 's-a' });
  assert.ok(isOk(ok), JSON.stringify(ok));
  assert.equal(ok.rev, 1);
  const st = await serverState(env, 'fresh-proj');
  assert.equal(st.rev, 1);
  assert.deepEqual(st.project, p);
});

test('C65-V3-02 提交成功回 project.op.ok { opId, rev }，rev 逐次加一；项目内容按操作变化', async (t) => {
  const { env, rev } = await withSeed(t);
  const c = await env.connect({ user: 'alice', dev: 'd-a' });
  await openProject(c, PID);
  for (let i = 1; i <= 5; i++) {
    const opId = newOpId('v3-02');
    const r = await submit(c, { projectId: PID, opId, ops: [{ op: 'set', path: '/tracks/@t1/clips/@c1/frame/x', value: 100 + i }], session: 's-a' });
    assert.ok(isOk(r), JSON.stringify(r));
    assert.equal(r.opId, opId, 'ok 带回 opId');
    assert.equal(r.rev, rev + i, 'rev 每次加一');
  }
  const st = await serverState(env, PID);
  assert.equal(st.rev, rev + 5);
  assert.equal(clipOf(st.project, 'c1').frame.x, 105);
});

test('C65-V3-03 广播 project.ops { rev, opId, ops, actor, undoOf }：发给除提交者外的订阅者；actor 取自连接，不认消息自报', async (t) => {
  const { env, rev } = await withSeed(t);
  const a = await env.connect({ user: 'alice', dev: 'd-a' });
  const b = await env.connect({ user: 'bob', dev: 'd-b' });
  const c = await env.connect({ user: 'carol', dev: 'd-c' });
  const idle = await env.connect({ user: 'dave', dev: 'd-d' }); // 没打开项目
  for (const x of [a, b, c]) await openProject(x, PID);

  const ops = [{ op: 'set', path: '/tracks/@t1/clips/@c2/frame/x', value: 7 }, { op: 'remove', path: '/tracks/@t1/clips/@c4' }];
  const opId = newOpId('v3-03');
  a.send({ type: 'project.op', projectId: PID, opId, session: 's-a', ops, actor: { userId: 'mallory', session: 'x' }, userId: 'mallory' });
  const ok = await a.next((m) => (isOk(m) || isRejected(m)) && m.opId === opId);
  assert.ok(isOk(ok), JSON.stringify(ok));

  for (const [who, x] of [['bob', b], ['carol', c]]) {
    const m = await x.next(byType('project.ops'));
    assert.equal(m.rev, rev + 1, `${who} 收到的 rev`);
    assert.equal(m.opId, opId);
    assert.deepEqual(m.ops, ops, `${who} 收到的 ops 原样`);
    assert.ok(byIs(m.actor, { user: 'alice', session: 's-a' }), `actor 取自连接：${JSON.stringify(m.actor)}`);
    assert.ok(!JSON.stringify(m).includes('mallory'), '消息里自报的身份一律不认');
    assert.equal(m.undoOf ?? undefined, undefined, '不是撤销时不带 undoOf');
  }
  assert.deepEqual(await quietOps(a), [], '提交者靠 ok 就知道落地，不再收 project.ops');
  assert.deepEqual(await quietOps(idle, 0), [], '没打开项目的连接收不到');

  // undoOf 原样广播
  const r2 = await submit(b, { projectId: PID, ops: [{ op: 'set', path: '/tracks/@t1/clips/@c2/frame/x', value: 20 }], session: 's-b', undoOf: opId });
  assert.ok(isOk(r2));
  const m2 = await a.next(byType('project.ops'));
  assert.equal(m2.undoOf, opId, '撤销提交的 undoOf 原样广播');
  assert.equal(m2.rev, rev + 2);
});

test('C65-V3-04 页面提交不带 expectRev：按到达顺序落地，后到的赢', async (t) => {
  const { env, rev } = await withSeed(t);
  const a = await env.connect({ user: 'alice', dev: 'd-a' });
  const b = await env.connect({ user: 'bob', dev: 'd-b' });
  await openProject(a, PID);
  await openProject(b, PID);
  const ra = await submit(a, { projectId: PID, ops: [{ op: 'set', path: '/tracks/@t1/clips/@c1/frame/x', value: 1 }], session: 's-a' });
  const rb = await submit(b, { projectId: PID, ops: [{ op: 'set', path: '/tracks/@t1/clips/@c1/frame/x', value: 2 }], session: 's-b' });
  assert.deepEqual([ra.type, ra.rev, rb.type, rb.rev], ['project.op.ok', rev + 1, 'project.op.ok', rev + 2]);
  assert.equal(clipOf((await serverState(env, PID)).project, 'c1').frame.x, 2);
});

test('C65-V3-05 Agent 带 expectRev：不符回 stale，since 精确列出其间每次提交 { rev, actor, paths }；状态不变；重读后再写成功', async (t) => {
  const { env, rev } = await withSeed(t);
  const agent = await env.connect({ user: 'alice', dev: 'd-a', role: 'agent', conv: 'conv-1' });
  const page = await env.connect({ user: 'bob', dev: 'd-b', role: 'page' });
  const watch = await env.connect({ user: 'carol', dev: 'd-c' });
  for (const x of [agent, page, watch]) await openProject(x, PID);
  const read = rev; // Agent 读到的版本

  const p1 = [{ op: 'set', path: '/tracks/@t1/clips/@c1/frame/x', value: 11 }, { op: 'set', path: '/fps', value: 25 }];
  const p2 = [{ op: 'remove', path: '/tracks/@t1/clips/@c3' }];
  assert.ok(isOk(await submit(page, { projectId: PID, ops: p1, session: 'page-b' })));
  assert.ok(isOk(await submit(page, { projectId: PID, ops: p2, session: 'page-b' })));
  await watch.next(byType('project.ops'));
  await watch.next(byType('project.ops'));
  const before = await serverState(env, PID);

  const rej = await submit(agent, { projectId: PID, ops: [{ op: 'set', path: '/tracks/@t1/clips/@c1/frame/x', value: 999 }], expectRev: read, session: 'conv-1' });
  assert.ok(isRejected(rej), `期望版本不符应被拒：${JSON.stringify(rej)}`);
  assert.equal(rej.reason, 'stale');
  assert.equal(rej.currentRev, rev + 2);
  assert.ok(Array.isArray(rej.since), 'since 是数组');
  assert.deepEqual(rej.since.map((s) => s.rev), [rev + 1, rev + 2], 'since 恰好是其间落地的每次提交');
  assert.deepEqual(rej.since.map((s) => s.paths), [p1.map((o) => o.path), p2.map((o) => o.path)], 'paths 与实际改动一致');
  for (const s of rej.since) assert.ok(byIs(s.actor, { user: 'bob', session: 'page-b' }), `actor：${JSON.stringify(s.actor)}`);
  assert.deepEqual(await quietOps(watch), [], '被拒的提交不广播');
  const after = await serverState(env, PID);
  assert.deepEqual(after, before, '被拒后状态与版本不变');

  // 重读后再写
  const ok = await submit(agent, { projectId: PID, ops: [{ op: 'set', path: '/tracks/@t1/clips/@c1/frame/x', value: 999 }], expectRev: rej.currentRev, session: 'conv-1' });
  assert.ok(isOk(ok), JSON.stringify(ok));
  assert.equal(ok.rev, rev + 3);
  assert.equal(clipOf((await serverState(env, PID)).project, 'c1').frame.x, 999);

  // expectRev 恰好等于当前版本：接受；只差一版的 since 只有一条
  assert.ok(isOk(await submit(page, { projectId: PID, ops: [{ op: 'set', path: '/name', value: 'n' }], session: 'page-b' })));
  const rej2 = await submit(agent, { projectId: PID, ops: [{ op: 'set', path: '/name', value: 'm' }], expectRev: rev + 3, session: 'conv-1' });
  assert.equal(rej2.reason, 'stale');
  assert.deepEqual(rej2.since.map((s) => [s.rev, s.paths]), [[rev + 4, ['/name']]]);
});

test('C65-V1-30 服务端整批原子：一条 bad-path，整批拒绝、rev 不加、不广播、内容不变', async (t) => {
  const { env, rev } = await withSeed(t);
  const a = await env.connect({ user: 'alice', dev: 'd-a' });
  const w = await env.connect({ user: 'bob', dev: 'd-b' });
  await openProject(a, PID);
  await openProject(w, PID);
  const before = await serverState(env, PID);
  const r = await submit(a, {
    projectId: PID,
    session: 's-a',
    ops: [
      { op: 'set', path: '/tracks/@t1/clips/@c1/frame/x', value: 555 },
      { op: 'insert', path: '/tracks/@t1/clips', index: 0, value: { id: 'new', start: 0, duration: 1 } },
      { op: 'remove', path: '/tracks/@t404/clips/@c1' },
    ],
  });
  assert.ok(isRejected(r), JSON.stringify(r));
  assert.equal(r.reason, 'bad-path');
  assert.equal(r.currentRev, rev);
  assert.deepEqual(await quietOps(w), []);
  assert.deepEqual(await serverState(env, PID), before);
  // 之后的提交照常从 rev + 1 起
  const ok = await submit(a, { projectId: PID, ops: [{ op: 'set', path: '/name', value: 'x' }], session: 's-a' });
  assert.equal(ok.rev, rev + 1);
});

test('C65-V3-06 too-large：单次提交超过 256 KiB 被拒，rev 不变；百来 KiB 的照常接受', async (t) => {
  const { env, rev } = await withSeed(t);
  const a = await env.connect({ user: 'alice', dev: 'd-a' });
  await openProject(a, PID);
  const big = 'x'.repeat(300 * 1024);
  const r = await submit(a, { projectId: PID, ops: [{ op: 'set', path: '/blob', value: big }], session: 's-a' });
  assert.ok(isRejected(r), `300 KiB 应被拒：${r.type}`);
  assert.equal(r.reason, 'too-large');
  assert.equal(r.currentRev, rev);
  const ok = await submit(a, { projectId: PID, ops: [{ op: 'set', path: '/blob', value: 'y'.repeat(100 * 1024) }], session: 's-a' });
  assert.ok(isOk(ok), JSON.stringify({ type: ok.type, reason: ok.reason }));
  assert.equal(ok.rev, rev + 1);
});

// ------------------------------------------------------------------ 覆盖通知

const C1 = '/tracks/@t1/clips/@c1';
const setX = (clip, x) => [{ op: 'set', path: `/tracks/@t1/clips/@${clip}/frame/x`, value: x }];

async function twoWriters(t, clockStart = T0) {
  const clock = { t: clockStart };
  const { env } = await withSeed(t, { clock });
  const a = await env.connect({ user: 'alice', dev: 'd-a' });
  const b = await env.connect({ user: 'bob', dev: 'd-b' });
  await openProject(a, PID);
  await openProject(b, PID);
  return { env, clock, a, b };
}

test('C65-V4-01 10 分钟内另一写入身份覆盖同一片段：覆盖方 ok 带 overwrote，被覆盖方收一条 project.overwritten', async (t) => {
  const { clock, a, b } = await twoWriters(t);
  clock.t = T0 + 1000;
  assert.ok(isOk(await submit(a, { projectId: PID, ops: setX('c1', 1), session: 's-a' })));
  clock.t = T0 + 1000 + 9 * MIN;
  const okB = await submit(b, { projectId: PID, ops: setX('c1', 2), session: 's-b' });
  assert.ok(isOk(okB));
  assert.ok(Array.isArray(okB.overwrote), `覆盖方的 ok 带 overwrote：${JSON.stringify(okB)}`);
  assert.equal(okB.overwrote.length, 1, '一条');
  assert.equal(okB.overwrote[0].entity, C1);
  assert.ok(byIs(okB.overwrote[0].by, { user: 'alice', session: 's-a' }), `by 是被覆盖方：${JSON.stringify(okB.overwrote[0].by)}`);

  const n = await a.next(byType('project.overwritten'));
  assert.equal(n.entity, C1);
  assert.ok(byIs(n.by, { user: 'bob', session: 's-b' }), `by 是覆盖方：${JSON.stringify(n.by)}`);
  assert.equal(n.rev, okB.rev);
  assert.deepEqual(await quietOverwritten(a), [], '被覆盖方只收一条');
  assert.deepEqual(await quietOverwritten(b, 0), [], '覆盖方不另收 project.overwritten');
});

test('C65-V4-02 超过 10 分钟：不通知', async (t) => {
  const { clock, a, b } = await twoWriters(t);
  assert.ok(isOk(await submit(a, { projectId: PID, ops: setX('c1', 1), session: 's-a' })));
  clock.t = T0 + 10 * MIN + 1;
  const okB = await submit(b, { projectId: PID, ops: setX('c1', 2), session: 's-b' });
  assert.ok(isOk(okB));
  assert.ok(!okB.overwrote || okB.overwrote.length === 0, `超过 10 分钟不带 overwrote：${JSON.stringify(okB.overwrote)}`);
  assert.deepEqual(await quietOverwritten(a), []);
});

test('C65-V4-03 写入身份：同一身份不通知；同一用户同一设备、不同页面会话算不同身份', async (t) => {
  const { env, a } = await twoWriters(t);
  assert.ok(isOk(await submit(a, { projectId: PID, ops: setX('c1', 1), session: 's-a' })));
  const again = await submit(a, { projectId: PID, ops: setX('c1', 2), session: 's-a' });
  assert.ok(!again.overwrote || again.overwrote.length === 0, '自己覆盖自己不通知');

  const a2 = await env.connect({ user: 'alice', dev: 'd-a' }); // 同用户同设备，另一个页面
  await openProject(a2, PID);
  const other = await submit(a2, { projectId: PID, ops: setX('c1', 3), session: 's-a2' });
  assert.equal(other.overwrote?.length, 1, `另一个页面会话算另一个写入身份：${JSON.stringify(other)}`);
  const n = await a.next(byType('project.overwritten'));
  assert.ok(byIs(n.by, { user: 'alice', session: 's-a2' }));
});

// 集成对账（B 类，2026-09-26 裁定改了实体粒度）：原断言「width / fps 同归 /meta」改为「顶层字段各算一个实体
// /meta/<键>」——别人改了 fps 不该让我撤不回自己改的 name。见 c65-design.md 第 13 节。
test('C65-V4-04 顶层实体：不同片段互不相干；width / fps 各算一个实体（/meta/width、/meta/fps）', async (t) => {
  const { a, b } = await twoWriters(t);
  assert.ok(isOk(await submit(a, { projectId: PID, ops: setX('c1', 1), session: 's-a' })));
  const r = await submit(b, { projectId: PID, ops: setX('c2', 1), session: 's-b' });
  assert.ok(!r.overwrote || r.overwrote.length === 0, '不同片段不算覆盖');
  assert.deepEqual(await quietOverwritten(a), []);

  assert.ok(isOk(await submit(a, { projectId: PID, ops: [{ op: 'set', path: '/fps', value: 25 }], session: 's-a' })));
  const r2 = await submit(b, { projectId: PID, ops: [{ op: 'set', path: '/width', value: 1280 }], session: 's-b' });
  assert.ok(!r2.overwrote || r2.overwrote.length === 0, `width 与 fps 是两个实体，不算覆盖：${JSON.stringify(r2.overwrote)}`);
  assert.deepEqual(await quietOverwritten(a), []);
  const r3 = await submit(b, { projectId: PID, ops: [{ op: 'set', path: '/fps', value: 60 }], session: 's-b' });
  assert.deepEqual(r3.overwrote?.map((o) => o.entity), ['/meta/fps'], `同一个 fps 才算覆盖：${JSON.stringify(r3.overwrote)}`);
  const n = await a.next(byType('project.overwritten'));
  assert.equal(n.entity, '/meta/fps');
});

test('C65-V4-05 根替换也是一次普通写入：照样记版本、照样通知覆盖', async (t) => {
  const { a, b } = await twoWriters(t);
  const okA = await submit(a, { projectId: PID, ops: setX('c1', 1), session: 's-a' });
  const next = fixedProject({ clips: 4 });
  clipOf(next, 'c1').frame.x = 77;
  const okB = await submit(b, { projectId: PID, ops: [{ op: 'set', path: '', value: next }], session: 's-b' });
  assert.ok(isOk(okB));
  assert.equal(okB.rev, okA.rev + 1);
  assert.ok(okB.overwrote?.some((o) => o.entity === C1), `根替换改到 c1，overwrote 里有 c1：${JSON.stringify(okB.overwrote)}`);
  const n = await a.next((m) => m.type === 'project.overwritten' && m.entity === C1);
  assert.equal(n.rev, okB.rev);
});

// ------------------------------------------------------------------ 重启回放

test('C65-V3-07 文件存储：230 次提交后重启，读快照再回放日志，rev 与内容一致；日志按快照截断', async (t) => {
  const dir = tempDir(t);
  const clock = { t: T0 };
  const env1 = await startProjectService({ dir, clock });
  t.after(env1.cleanup);
  const seedRev = await seedProject(env1, PID, fixedProject({ clips: 5 }));
  const a = await env1.connect({ user: 'alice', dev: 'd-a' });
  await openProject(a, PID);
  const r = rng(65);
  let last;
  for (let i = 0; i < 230; i++) {
    clock.t += 1000;
    const k = r.int(4);
    let ops;
    if (k === 0) ops = [{ op: 'insert', path: '/tracks/@t1/clips', index: 0, value: { id: `n${i}`, start: i, duration: 1 } }];
    else if (k === 1 && i > 10) ops = [{ op: 'move', path: `/tracks/@t1/clips/@c${1 + r.int(5)}`, index: r.int(3) }];
    else if (k === 2) ops = [{ op: 'set', path: '/name', value: `名字 ${i}` }];
    else ops = setX(`c${1 + r.int(5)}`, i);
    last = await submit(a, { projectId: PID, ops, session: 's-a' });
    assert.ok(isOk(last), `#${i} ${JSON.stringify(last)}`);
  }
  assert.equal(last.rev, seedRev + 230);
  const before = await serverState(env1, PID);
  await env1.cleanup();

  const file = join(dir, 'projects', `${PID}.ops.ndjson`);
  assert.ok(existsSync(file), `操作日志在 <dir>/projects/<projectId>.ops.ndjson（假设 A8）`);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const l of lines) JSON.parse(l);
  assert.ok(lines.length <= 200, `每 200 次提交落一次快照、日志截断到快照之后：现有 ${lines.length} 行`);

  const env2 = await startProjectService({ dir, clock });
  t.after(env2.cleanup);
  const after = await serverState(env2, PID);
  assert.equal(after.rev, before.rev, 'rev 恢复');
  assert.deepEqual(after.project, before.project, '内容恢复');
  assert.equal(JSON.stringify(after.project), JSON.stringify(before.project), '逐字节相同');

  const b = await env2.connect({ user: 'bob', dev: 'd-b' });
  await openProject(b, PID);
  const ok = await submit(b, { projectId: PID, ops: setX('c1', -1), session: 's-b' });
  assert.equal(ok.rev, before.rev + 1, '重启后接着往上加');
});
