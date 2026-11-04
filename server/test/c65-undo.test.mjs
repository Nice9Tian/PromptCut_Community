/**
 * C6.5 undo / redo (design doc `docs/plan/c65-design.md` Section 8; acceptance check V5).
 * Run: node --test server/test/c65-undo.test.mjs
 *
 * Written only against the design doc without looking at the implementation. Undo stacks are
 * separated by write identity: one stack per page session; undo is committing inverse (with
 * undoOf); if entities touched by inverse were modified by another write identity after this
 * step, those entities are not undone while the rest are undone as usual, and tell the user who
 * modified them.
 * Undo interface of page sync instances: see `c65-kit.mjs` assumption A7:
 * `undo()` / `redo()` → `{ skipped: [{ entity, by }] }`.
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
  await seedProject(env, PID, fixedProject({ clips: 4 })); // c1..c4, frame.x = 10, 20, 30, 40
  env.clock.t += 60 * MIN;
  const pages = [];
  const open = async (opts) => {
    const p = await createPage(env, { projectId: PID, ...opts });
    pages.push(p);
    return p;
  };
  t.after(() => { for (const p of pages) { try { p.close(); } catch { /* Closed */ } } });
  return { env, open };
}

const skippedOf = (res) => (Array.isArray(res?.skipped) ? res.skipped : []);

test('C65-V5-01 A edits clips 1 and 2, B then edits clip 2, A undoes: clip 1 goes back, clip 2 keeps B\'s, and A learns that "clip 2 was not undone because B changed it"', async (t) => {
  const { env, open } = await setup(t);
  const A = await open({ user: 'alice', session: 'page-a' });
  const B = await open({ user: 'bob', session: 'page-b' });
  const w = await observer(env, PID);

  A.edit((p) => { clipOf(p, 'c1').frame.x = 111; clipOf(p, 'c2').frame.x = 222; }); // One step
  await A.settled();
  const stepA = w.ops().find((m) => byIs(m.actor, { user: 'alice', session: 'page-a' }));
  await waitFor(() => clipOf(B.project, 'c2').frame.x === 222, 5000, 'B receives A\'s change');
  B.edit((p) => { clipOf(p, 'c2').frame.x = 500; });
  await B.settled();
  await waitFor(() => clipOf(A.project, 'c2').frame.x === 500, 5000, 'A receives B\'s change');

  const res = await A.undo();
  const skipped = skippedOf(res);
  assert.equal(skipped.length, 1, `only clip 2 was not undone: ${JSON.stringify(res)}`);
  assert.equal(skipped[0].entity, C2);
  assert.ok(byIs(skipped[0].by, { user: 'bob', session: 'page-b' }), `tells the user it was changed by B: ${JSON.stringify(skipped[0].by)}`);

  await A.settled();
  const st = await serverState(env, PID);
  assert.equal(clipOf(st.project, 'c1').frame.x, 10, 'clip 1 reverted to the original value');
  assert.equal(clipOf(st.project, 'c2').frame.x, 500, 'clip 2 keeps B\'s');
  assertSameBytes(A.project, st.project, 'page A and the document service');
  await waitFor(() => clipOf(B.project, 'c1').frame.x === 10, 5000, 'B receives this undo as usual');

  // Undo is a new write: with undoOf pointing to that undone commit, version increments by one as usual
  const undoMsg = w.ops().find((m) => m.undoOf !== undefined && m.undoOf !== null);
  assert.ok(undoMsg, 'the undo commit that others receive carries undoOf');
  assert.equal(undoMsg.undoOf, stepA.opId, 'undoOf points to the opId of A\'s step');
  assert.ok(undoMsg.rev > stepA.rev);
  assert.ok(!undoMsg.ops.some((o) => o.path.startsWith(C2)), 'the undo commit does not touch clip 2');
});

test('C65-V5-02 a step where nothing could be undone: it is popped and does not enter the redo stack; pressing undo again undoes an earlier step', async (t) => {
  const { env, open } = await setup(t);
  const A = await open({ user: 'alice', session: 'page-a' });
  const B = await open({ user: 'bob', session: 'page-b' });

  A.edit((p) => { clipOf(p, 'c3').frame.x = 333; }); // Step 1
  A.edit((p) => { clipOf(p, 'c2').frame.x = 222; }); // Step 2
  await A.settled();
  await waitFor(() => clipOf(B.project, 'c2').frame.x === 222, 5000);
  B.edit((p) => { clipOf(p, 'c2').frame.x = 500; });
  await B.settled();
  await waitFor(() => clipOf(A.project, 'c2').frame.x === 500, 5000);
  const revBefore = (await serverState(env, PID)).rev;

  const res = await A.undo();
  assert.deepEqual(skippedOf(res).map((s) => s.entity), [C2], `nothing could be undone, lists what was not undone: ${JSON.stringify(res)}`);
  await A.settled();
  await sleep(150);
  const st = await serverState(env, PID);
  assert.equal(clipOf(st.project, 'c2').frame.x, 500, 'the current state is kept');
  assert.equal(clipOf(st.project, 'c3').frame.x, 333, 'step 1 was not touched');
  assert.equal(st.rev, revBefore, 'no commit is produced when nothing could be undone');
  assert.equal(A.canRedo(), false, 'a step where nothing could be undone does not enter the redo stack');
  assert.equal(A.canUndo(), true, 'the earlier step is still there');

  const res2 = await A.undo();
  assert.deepEqual(skippedOf(res2), [], 'step 1 is fully undone');
  await A.settled();
  assert.equal(clipOf((await serverState(env, PID)).project, 'c3').frame.x, 30);
  assert.equal(A.canUndo(), false, 'all popped');
});

test('C65-V5-03 undo stacks are separate per writer identity: others\' changes do not enter my stack; my own later changes do not block undo', async (t) => {
  const { env, open } = await setup(t);
  const A = await open({ user: 'alice', session: 'page-a' });
  const A2 = await open({ user: 'alice', session: 'page-a2' }); // Another page of the same user: another write identity
  A2.edit((p) => { clipOf(p, 'c4').frame.x = 44; });
  await A2.settled();
  await waitFor(() => clipOf(A.project, 'c4').frame.x === 44, 5000);
  assert.equal(A.canUndo(), false, 'changes from other page sessions do not enter A\'s undo stack');

  A.edit((p) => { clipOf(p, 'c1').frame.x = 1; });
  A.edit((p) => { clipOf(p, 'c1').frame.x = 2; });
  await A.settled();
  const res = await A.undo();
  assert.deepEqual(skippedOf(res), [], 'after this step only the user\'s own edits were made, which is not a conflict');
  await A.settled();
  assert.equal(clipOf((await serverState(env, PID)).project, 'c1').frame.x, 1);
  assert.equal(clipOf((await serverState(env, PID)).project, 'c4').frame.x, 44, 'undo does not touch other people\'s changes');
});

test('C65-V5-04 redo: redoes the inverse of the undo; the redo stack is cleared when a new local operation happens in between', async (t) => {
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
  assert.equal(clipOf((await serverState(env, PID)).project, 'c1').frame.x, 9, 'redo returns to the changed value');

  await A.undo();
  await A.settled();
  assert.equal(A.canRedo(), true);
  A.edit((p) => { clipOf(p, 'c2').frame.x = 1; });
  assert.equal(A.canRedo(), false, 'a new local operation clears the redo stack');
});

test('C65-V5-05 consecutive input in a number box within 300 ms is merged into one step', async (t) => {
  const { env, open } = await setup(t);
  const clock = { t: 5_000_000 };
  const A = await open({ user: 'alice', session: 'page-a', now: () => clock.t });
  const key = { coalesce: 'numbox:c1.frame.x' };
  A.edit((p) => { clipOf(p, 'c1').frame.x = 1; }, key);
  clock.t += 100;
  A.edit((p) => { clipOf(p, 'c1').frame.x = 12; }, key);
  clock.t += 100;
  A.edit((p) => { clipOf(p, 'c1').frame.x = 123; }, key); // First three are 100 ms apart each: same step
  clock.t += 600;
  A.edit((p) => { clipOf(p, 'c1').frame.x = 1234; }, key); // 600 ms apart: a new step
  await A.settled();
  assert.equal(clipOf((await serverState(env, PID)).project, 'c1').frame.x, 1234);

  await A.undo();
  await A.settled();
  assert.equal(clipOf(A.project, 'c1').frame.x, 123, 'the first undo only undoes the last step');
  await A.undo();
  await A.settled();
  assert.equal(clipOf(A.project, 'c1').frame.x, 10, 'the second undo reverts the merged three inputs together to the original value');
  assert.equal(A.canUndo(), false, 'two steps in total');
  assert.equal(clipOf((await serverState(env, PID)).project, 'c1').frame.x, 10);
});
