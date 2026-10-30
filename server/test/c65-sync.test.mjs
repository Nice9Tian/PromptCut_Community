/**
 * C6.5 页面同步（设计稿 `docs/plan/c65-design.md` 第 3、4、6 节；验收 V2、V4 页面侧、V6、V7、V8 的回环延迟）。
 * 跑：node --test server/test/c65-sync.test.mjs
 *
 * 只照设计稿写，不看实现。页面同步实例由 `c65-kit.mjs` 的 `createPage` 包装（假设 A7），
 * 文档服务是内存存储的真服务（假设 A3），断网经 TCP 代理模拟（`createLink`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startProjectService, seedProject, serverState, createPage, createLink, observer, assertSameBytes,
  fixedProject, clipOf, rng, waitFor, sleep, byIs, MIN,
} from './c65-kit.mjs';

const PID = 'c65-sync';

async function setup(t, { clips = 6 } = {}) {
  const env = await startProjectService();
  t.after(env.cleanup);
  env.clock.t -= 60 * MIN; // 种子早于覆盖窗口
  await seedProject(env, PID, fixedProject({ clips }));
  env.clock.t += 60 * MIN;
  const pages = [];
  const open = async (opts) => {
    const p = await createPage(env, { projectId: PID, ...opts });
    pages.push(p);
    return p;
  };
  t.after(() => { for (const p of pages) { try { p.close(); } catch { /* 已关 */ } } });
  return { env, open };
}

/** 等页面的项目与服务端一致（别人的 project.ops 到达需要时间） */
async function converged(env, pages, ms = 10_000) {
  for (const p of pages) await p.settled(ms);
  let st;
  await waitFor(async () => {
    st = await serverState(env, PID);
    return pages.every((p) => JSON.stringify(p.project) === JSON.stringify(st.project));
  }, ms, '各页面与文档服务一致').catch(() => {});
  return st ?? serverState(env, PID);
}

/** 页面上的一次随机编辑（只动本地现有的片段） */
function randomEdit(r, page, tag, n) {
  const clips = page.project.tracks.flatMap((tr) => tr.clips.map((c) => [tr.id, c.id]));
  const k = r.int(8);
  page.edit((p) => {
    const track = (id) => p.tracks.find((x) => x.id === id);
    if (k <= 2 && clips.length) {
      const [, cid] = r.pick(clips);
      clipOf(p, cid).frame = { ...(clipOf(p, cid).frame ?? {}), x: r.int(2000) };
    } else if (k === 3 && clips.length) {
      clipOf(p, r.pick(clips)[1]).params = { text: `${tag}-${n}` };
    } else if (k === 4 || !clips.length) {
      const tr = r.pick(p.tracks);
      tr.clips.splice(r.int(tr.clips.length + 1), 0, { id: `${tag}-${n}`, start: n, duration: 1, cardId: 'title', params: {} });
    } else if (k === 5 && clips.length > 3) {
      const [tid, cid] = r.pick(clips);
      const tr = track(tid);
      tr.clips.splice(tr.clips.findIndex((c) => c.id === cid), 1);
    } else if (k === 6 && clips.length > 1) {
      const [tid, cid] = r.pick(clips);
      const tr = track(tid);
      const [c] = tr.clips.splice(tr.clips.findIndex((x) => x.id === cid), 1);
      tr.clips.splice(r.int(tr.clips.length + 1), 0, c);
    } else {
      p.name = `${tag} 改名 ${n}`;
      p.fps = r.pick([24, 25, 30]);
    }
  });
}

// ------------------------------------------------------------------ V2

test('C65-V2-01 两个页面各做 200 次随机编辑、交错提交：两边与文档服务三份逐字节相同', async (t) => {
  const { env, open } = await setup(t);
  const A = await open({ user: 'alice', session: 'page-a' });
  const B = await open({ user: 'bob', session: 'page-b' });
  const r = rng(0xc65_2);
  const left = { a: 200, b: 200 };
  let n = 0;
  while (left.a + left.b > 0) {
    const useA = left.b === 0 || (left.a > 0 && r.chance(0.5));
    if (useA) { left.a -= 1; randomEdit(r, A, 'a', ++n); } else { left.b -= 1; randomEdit(r, B, 'b', ++n); }
    // 交错：有时连着改几下再让网络走，有时每改一下都让对面的操作进来
    if (r.chance(0.4)) await sleep(r.int(3));
    else if (r.chance(0.5)) await new Promise((res) => setImmediate(res));
  }
  const st = await converged(env, [A, B], 20_000);
  assertSameBytes(A.project, st.project, '页面 A 与文档服务');
  assertSameBytes(B.project, st.project, '页面 B 与文档服务');
  assert.equal(A.pending(), 0);
  assert.equal(B.pending(), 0);
});

// ------------------------------------------------------------------ V6

test('C65-V6-01 断线期间改 20 次，恢复后按顺序落地（每次一条提交，别人按序收到）', async (t) => {
  const { env, open } = await setup(t);
  const link = await createLink(env);
  t.after(link.close);
  const A = await open({ user: 'alice', session: 'page-a', via: link });
  const w = await observer(env, PID);
  const rev0 = (await serverState(env, PID)).rev;

  await link.offline(A);
  for (let i = 1; i <= 20; i++) A.edit((p) => { clipOf(p, 'c1').frame.x = 1000 + i; });
  assert.equal(clipOf(A.project, 'c1').frame.x, 1020, '离线时照常本地落地');
  assert.equal(A.pending(), 20, '20 次进待发队列');
  await sleep(200);
  assert.deepEqual(w.ops(), [], '断线期间服务端什么都没收到');

  link.online();
  await A.settled(20_000);
  const mine = w.ops().filter((m) => byIs(m.actor, { user: 'alice', session: 'page-a' }));
  assert.equal(mine.length, 20, `20 次提交各自落地：${mine.length}`);
  assert.deepEqual(mine.map((m) => m.rev), Array.from({ length: 20 }, (_, i) => rev0 + 1 + i), '版本号连续');
  const xs = mine.map((m) => m.ops.find((o) => o.path.endsWith('/frame/x'))?.value);
  assert.deepEqual(xs, Array.from({ length: 20 }, (_, i) => 1001 + i), '按离线时的顺序落地');
  const st = await serverState(env, PID);
  assertSameBytes(A.project, st.project, '恢复后页面与文档服务');
});

/** 离线期间别人也改过：A 断线改 5 次，B 在线改 c1、c2，A 恢复 */
async function offlineConflict(t) {
  const { env, open } = await setup(t);
  const link = await createLink(env);
  t.after(link.close);
  const A = await open({ user: 'alice', session: 'page-a', via: link });
  const B = await open({ user: 'bob', session: 'page-b' });
  await link.offline(A);
  for (let i = 1; i <= 5; i++) A.edit((p) => { clipOf(p, 'c1').frame.x = 100 + i; clipOf(p, 'c3').params = { text: `离线 ${i}` }; });
  B.edit((p) => { clipOf(p, 'c1').frame.x = -5; clipOf(p, 'c2').frame.x = 555; });
  await B.settled();
  const afterB = await serverState(env, PID);

  link.online();
  await waitFor(() => A.conflicts.length > 0, 15_000, '第一条被拒后通知页面（onOfflineConflict）');
  await sleep(300);
  assert.equal(A.conflicts.length, 1, '只通知一次');
  assert.equal(A.pending(), 5, '整批停下：5 条都还在待发队列');
  const still = await serverState(env, PID);
  assert.equal(still.rev, afterB.rev, '被拒之后没有继续提交');
  assert.deepEqual(still.project, afterB.project);
  return { env, A, B, afterB };
}

test('C65-V6-02 离线期间别人也改过：第一条被拒、整批停下；选「重放」后去掉期望版本依次提交', async (t) => {
  const { env, A, B, afterB } = await offlineConflict(t);
  await A.resolveOffline('replay');
  await A.settled(15_000);
  const st = await converged(env, [A, B]);
  assert.equal(st.rev, afterB.rev + 5, '5 条依次落地');
  assert.equal(clipOf(st.project, 'c1').frame.x, 105, '重放后最后写的（A）赢');
  assert.equal(clipOf(st.project, 'c2').frame.x, 555, 'A 没碰的 c2 保留 B 的');
  assert.deepEqual(clipOf(st.project, 'c3').params, { text: '离线 5' });
  assertSameBytes(A.project, st.project, '页面 A');
  assertSameBytes(B.project, st.project, '页面 B');
});

test('C65-V6-03 离线期间别人也改过：选「丢弃」后本地回到服务端版本，丢掉的那批先存本地备份', async (t) => {
  const { env, A, afterB } = await offlineConflict(t);
  const nBackups = A.backups.length;
  await A.resolveOffline('discard');
  await waitFor(() => A.pending() === 0, 5000, '待发队列清空');
  await sleep(200);
  const st = await serverState(env, PID);
  assert.equal(st.rev, afterB.rev, '丢弃不提交任何东西');
  assertSameBytes(A.project, st.project, '页面 A 回到服务端版本');
  assert.equal(clipOf(A.project, 'c1').frame.x, -5);
  assert.ok(A.backups.length > nBackups, '丢弃前把那批本地修改存进本地备份（设计稿第 8 节裁定）');

  // 丢弃之后照常在线编辑
  A.edit((p) => { clipOf(p, 'c4').frame.x = 44; });
  await A.settled();
  assert.equal(clipOf((await serverState(env, PID)).project, 'c4').frame.x, 44);
});

// ------------------------------------------------------------------ V7

test('C65-V7-01 有未确认的操作时保存 .proc：等所有操作确认后才写，写出的内容与文档服务的 rev 一致', async (t) => {
  const { env, open } = await setup(t);
  const link = await createLink(env);
  t.after(link.close);
  const A = await open({ user: 'alice', session: 'page-a', via: link });
  await link.offline(A);
  A.edit((p) => { clipOf(p, 'c1').frame.x = 71; });
  A.edit((p) => { p.name = '保存前'; });
  const writes = [];
  const saving = A.save((project, rev) => { writes.push({ project: structuredClone(project), rev }); });
  saving.catch(() => {}); // 断线期间可能提示超时；这里只看写没写
  await sleep(400);
  assert.deepEqual(writes, [], '还有未确认的操作时不写');

  link.online();
  await waitFor(() => writes.length > 0, 15_000, '确认后写 .proc');
  assert.equal(writes.length, 1, '只写一次');
  const st = await serverState(env, PID);
  assert.equal(writes[0].rev, st.rev, '写出时带的 rev 就是文档服务的当前版本');
  assertSameBytes(writes[0].project, st.project, '写出的内容与文档服务的这一版相同');
  assert.equal(writes[0].project.name, '保存前');
});

test('C65-V7-02 没有未确认的操作：保存立即写，rev 是最新', async (t) => {
  const { env, open } = await setup(t);
  const A = await open({ user: 'alice', session: 'page-a' });
  A.edit((p) => { clipOf(p, 'c2').frame.x = 3; });
  await A.settled();
  const writes = [];
  await A.save((project, rev) => { writes.push({ project: structuredClone(project), rev }); });
  assert.equal(writes.length, 1);
  const st = await serverState(env, PID);
  assert.equal(writes[0].rev, st.rev);
  assert.deepEqual(writes[0].project, st.project);
});

// ------------------------------------------------------------------ V4 页面侧

test('C65-V4-10 被覆盖的页面：先把自己那一版的该实体存成本地备份，再应用新版本', async (t) => {
  const { open } = await setup(t);
  const A = await open({ user: 'alice', session: 'page-a' });
  const B = await open({ user: 'bob', session: 'page-b' });
  A.edit((p) => { clipOf(p, 'c1').frame.x = 1; clipOf(p, 'c1').params = { text: 'A 的版本' }; });
  await A.settled();
  const mine = structuredClone(clipOf(A.project, 'c1'));
  await waitFor(() => clipOf(B.project, 'c1').frame.x === 1, 5000, 'B 收到 A 的改动');
  B.edit((p) => { clipOf(p, 'c1').frame.x = 2; clipOf(p, 'c1').params = { text: 'B 的版本' }; });
  await B.settled();
  await waitFor(() => clipOf(A.project, 'c1').frame.x === 2, 5000, 'A 应用了 B 的新版本');
  const bk = A.backups.filter((b) => b.entity === '/tracks/@t1/clips/@c1');
  assert.equal(bk.length, 1, `被覆盖方存了一份备份：${JSON.stringify(A.backups).slice(0, 400)}`);
  assert.deepEqual(bk[0].value, mine, '备份的内容是它原来那一版');
  assert.equal(B.backups.length, 0, '覆盖方不存备份');
});

// ------------------------------------------------------------------ V8 回环延迟

test('C65-V8-02 本机回环：一个页面改完到另一页面看到变化 ≤ 300 ms', async (t) => {
  const { open } = await setup(t, { clips: 50 });
  const A = await open({ user: 'alice', session: 'page-a' });
  const B = await open({ user: 'bob', session: 'page-b' });
  const lat = [];
  for (let i = 0; i < 12; i++) {
    const x = 5000 + i;
    const t0 = performance.now();
    A.edit((p) => { clipOf(p, `c${1 + (i % 50)}`).start = x; }); // 拖动松手 = 一次提交
    await waitFor(() => clipOf(B.project, `c${1 + (i % 50)}`).start === x, 3000, `第 ${i} 次改动到达 B`);
    lat.push(performance.now() - t0);
  }
  const warm = lat.slice(2);
  assert.ok(Math.max(...warm) <= 300, `延迟（ms）：${lat.map((x) => x.toFixed(1)).join(', ')}`);
});
