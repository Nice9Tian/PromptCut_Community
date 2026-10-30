/**
 * C6.5 撤销 / 重做（设计稿 `docs/plan/c65-design.md` 第 8 节；验收 V5）。
 * 跑：node --test server/test/c65-undo.test.mjs
 *
 * 只照设计稿写，不看实现。撤销栈按写入身份分开：每个页面会话一个栈；撤销就是提交 inverse（带 undoOf）；
 * inverse 涉及的实体若在这一步之后被别的写入身份改过，这些实体不撤、其余照撤，并告诉用户谁改的。
 * 页面同步实例的撤销接口见 `c65-kit.mjs` 假设 A7：`undo()` / `redo()` → `{ skipped: [{ entity, by }] }`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startProjectService, seedProject, serverState, createPage, observer, assertSameBytes,
  fixedProject, clipOf, waitFor, sleep, byIs, MIN,
} from './c65-kit.mjs';

const PID = 'c65-undo';
const C1 = '/tracks/@t1/clips/@c1';
const C2 = '/tracks/@t1/clips/@c2';

async function setup(t) {
  const env = await startProjectService();
  t.after(env.cleanup);
  env.clock.t -= 60 * MIN;
  await seedProject(env, PID, fixedProject({ clips: 4 })); // c1..c4，frame.x = 10、20、30、40
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

const skippedOf = (res) => (Array.isArray(res?.skipped) ? res.skipped : []);

test('C65-V5-01 A 改片段 1、2，B 随后改片段 2，A 撤销：片段 1 回去，片段 2 保持 B 的，A 得知「片段 2 因 B 改过没撤」', async (t) => {
  const { env, open } = await setup(t);
  const A = await open({ user: 'alice', session: 'page-a' });
  const B = await open({ user: 'bob', session: 'page-b' });
  const w = await observer(env, PID);

  A.edit((p) => { clipOf(p, 'c1').frame.x = 111; clipOf(p, 'c2').frame.x = 222; }); // 一步
  await A.settled();
  const stepA = w.ops().find((m) => byIs(m.actor, { user: 'alice', session: 'page-a' }));
  await waitFor(() => clipOf(B.project, 'c2').frame.x === 222, 5000, 'B 收到 A 的改动');
  B.edit((p) => { clipOf(p, 'c2').frame.x = 500; });
  await B.settled();
  await waitFor(() => clipOf(A.project, 'c2').frame.x === 500, 5000, 'A 收到 B 的改动');

  const res = await A.undo();
  const skipped = skippedOf(res);
  assert.equal(skipped.length, 1, `只有片段 2 没撤：${JSON.stringify(res)}`);
  assert.equal(skipped[0].entity, C2);
  assert.ok(byIs(skipped[0].by, { user: 'bob', session: 'page-b' }), `告诉用户是 B 改的：${JSON.stringify(skipped[0].by)}`);

  await A.settled();
  const st = await serverState(env, PID);
  assert.equal(clipOf(st.project, 'c1').frame.x, 10, '片段 1 撤回原值');
  assert.equal(clipOf(st.project, 'c2').frame.x, 500, '片段 2 保持 B 的');
  assertSameBytes(A.project, st.project, '页面 A 与文档服务');
  await waitFor(() => clipOf(B.project, 'c1').frame.x === 10, 5000, 'B 照常收到这次撤销');

  // 撤销是一次新的写入：带 undoOf 指向被撤的那次提交，版本照常加一
  const undoMsg = w.ops().find((m) => m.undoOf !== undefined && m.undoOf !== null);
  assert.ok(undoMsg, '别人收到的撤销提交带 undoOf');
  assert.equal(undoMsg.undoOf, stepA.opId, 'undoOf 指向 A 那一步的 opId');
  assert.ok(undoMsg.rev > stepA.rev);
  assert.ok(!undoMsg.ops.some((o) => o.path.startsWith(C2)), '撤销提交不碰片段 2');
});

test('C65-V5-02 一步全部没撤成：出栈、不进重做栈；再按撤销撤的是更早的一步', async (t) => {
  const { env, open } = await setup(t);
  const A = await open({ user: 'alice', session: 'page-a' });
  const B = await open({ user: 'bob', session: 'page-b' });

  A.edit((p) => { clipOf(p, 'c3').frame.x = 333; }); // 第 1 步
  A.edit((p) => { clipOf(p, 'c2').frame.x = 222; }); // 第 2 步
  await A.settled();
  await waitFor(() => clipOf(B.project, 'c2').frame.x === 222, 5000);
  B.edit((p) => { clipOf(p, 'c2').frame.x = 500; });
  await B.settled();
  await waitFor(() => clipOf(A.project, 'c2').frame.x === 500, 5000);
  const revBefore = (await serverState(env, PID)).rev;

  const res = await A.undo();
  assert.deepEqual(skippedOf(res).map((s) => s.entity), [C2], `全部没撤成，列出没撤的：${JSON.stringify(res)}`);
  await A.settled();
  await sleep(150);
  const st = await serverState(env, PID);
  assert.equal(clipOf(st.project, 'c2').frame.x, 500, '保留了现在的样子');
  assert.equal(clipOf(st.project, 'c3').frame.x, 333, '第 1 步没被动到');
  assert.equal(st.rev, revBefore, '什么都没撤成时不产生提交');
  assert.equal(A.canRedo(), false, '全部没撤成的一步不进重做栈');
  assert.equal(A.canUndo(), true, '更早的一步还在');

  const res2 = await A.undo();
  assert.deepEqual(skippedOf(res2), [], '第 1 步完整撤回');
  await A.settled();
  assert.equal(clipOf((await serverState(env, PID)).project, 'c3').frame.x, 30);
  assert.equal(A.canUndo(), false, '全部出栈');
});

test('C65-V5-03 撤销栈按写入身份分开：别人的改动不进我的栈；自己后来的改动不挡撤销', async (t) => {
  const { env, open } = await setup(t);
  const A = await open({ user: 'alice', session: 'page-a' });
  const A2 = await open({ user: 'alice', session: 'page-a2' }); // 同一用户的另一个页面：另一个写入身份
  A2.edit((p) => { clipOf(p, 'c4').frame.x = 44; });
  await A2.settled();
  await waitFor(() => clipOf(A.project, 'c4').frame.x === 44, 5000);
  assert.equal(A.canUndo(), false, '别的页面会话的改动不进 A 的撤销栈');

  A.edit((p) => { clipOf(p, 'c1').frame.x = 1; });
  A.edit((p) => { clipOf(p, 'c1').frame.x = 2; });
  await A.settled();
  const res = await A.undo();
  assert.deepEqual(skippedOf(res), [], '在这一步之后只有自己改过，不算冲突');
  await A.settled();
  assert.equal(clipOf((await serverState(env, PID)).project, 'c1').frame.x, 1);
  assert.equal(clipOf((await serverState(env, PID)).project, 'c4').frame.x, 44, '撤销不碰别人的改动');
});

test('C65-V5-04 重做：重做撤销的 inverse；中间有新的本地操作时重做栈清空', async (t) => {
  const { env, open } = await setup(t);
  const A = await open({ user: 'alice', session: 'page-a' });
  A.edit((p) => { clipOf(p, 'c1').frame.x = 9; });
  await A.settled();
  await A.undo();
  await A.settled();
  assert.equal(clipOf(A.project, 'c1').frame.x, 10);
  assert.equal(A.canRedo(), true);
  const res = await A.redo();
  assert.deepEqual(skippedOf(res), []);
  await A.settled();
  assert.equal(clipOf((await serverState(env, PID)).project, 'c1').frame.x, 9, '重做回到改后的值');

  await A.undo();
  await A.settled();
  assert.equal(A.canRedo(), true);
  A.edit((p) => { clipOf(p, 'c2').frame.x = 1; });
  assert.equal(A.canRedo(), false, '新的本地操作清空重做栈');
});

test('C65-V5-05 数字框的连续输入 300 ms 内合并成一步', async (t) => {
  const { env, open } = await setup(t);
  const clock = { t: 5_000_000 };
  const A = await open({ user: 'alice', session: 'page-a', now: () => clock.t });
  const key = { coalesce: 'numbox:c1.frame.x' };
  A.edit((p) => { clipOf(p, 'c1').frame.x = 1; }, key);
  clock.t += 100;
  A.edit((p) => { clipOf(p, 'c1').frame.x = 12; }, key);
  clock.t += 100;
  A.edit((p) => { clipOf(p, 'c1').frame.x = 123; }, key); // 前三次两两相隔 100 ms：同一步
  clock.t += 600;
  A.edit((p) => { clipOf(p, 'c1').frame.x = 1234; }, key); // 隔了 600 ms：新的一步
  await A.settled();
  assert.equal(clipOf((await serverState(env, PID)).project, 'c1').frame.x, 1234);

  await A.undo();
  await A.settled();
  assert.equal(clipOf(A.project, 'c1').frame.x, 123, '第一次撤销只撤最后一步');
  await A.undo();
  await A.settled();
  assert.equal(clipOf(A.project, 'c1').frame.x, 10, '第二次撤销把合并的三次输入一起撤回原值');
  assert.equal(A.canUndo(), false, '一共两步');
  assert.equal(clipOf((await serverState(env, PID)).project, 'c1').frame.x, 10);
});
