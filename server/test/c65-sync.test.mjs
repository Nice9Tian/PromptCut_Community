/**
 * C6.5 page sync (design doc `docs/plan/c65-design.md` Sections 3, 4, 6; acceptance check V2,
 * page side of V4, loopback latency of V6, V7, V8).
 * Run: node --test server/test/c65-sync.test.mjs
 *
 * Written only against the design doc without looking at the implementation. Page sync instances
 * are wrapped by `createPage` in `c65-kit.mjs` (assumption A7), document service is a real
 * in-memory service (assumption A3), and network disconnection is simulated via a TCP proxy
 * (`createLink`).
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
  env.clock.t -= 60 * MIN; // Seed is earlier than the coverage window
  await seedProject(env, PID, fixedProject({ clips }));
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

/** Wait until page project matches the server (others' project.ops takes time to arrive) */
async function converged(env, pages, ms = 10_000) {
  for (const p of pages) await p.settled(ms);
  let st;
  await waitFor(async () => {
    st = await serverState(env, PID);
    return pages.every((p) => JSON.stringify(p.project) === JSON.stringify(st.project));
  }, ms, 'all pages match the document service').catch(() => {});
  return st ?? serverState(env, PID);
}

/** A random edit on the page (only touches locally existing clips) */
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
      p.name = `${tag} renamed ${n}`;
      p.fps = r.pick([24, 25, 30]);
    }
  });
}

// ------------------------------------------------------------------ V2

test('C65-V2-01 two pages each make 200 random edits and commit interleaved: both pages and the document service are byte-for-byte identical (all three copies)', async (t) => {
  const { env, open } = await setup(t);
  const A = await open({ user: 'alice', session: 'page-a' });
  const B = await open({ user: 'bob', session: 'page-b' });
  const r = rng(0xc65_2);
  const left = { a: 200, b: 200 };
  let n = 0;
  while (left.a + left.b > 0) {
    const useA = left.b === 0 || (left.a > 0 && r.chance(0.5));
    if (useA) { left.a -= 1; randomEdit(r, A, 'a', ++n); } else { left.b -= 1; randomEdit(r, B, 'b', ++n); }
    // Interleaved: sometimes edit several times consecutively before letting network proceed,
    // sometimes let peer operations in after each edit
    if (r.chance(0.4)) await sleep(r.int(3));
    else if (r.chance(0.5)) await new Promise((res) => setImmediate(res));
  }
  const st = await converged(env, [A, B], 20_000);
  assertSameBytes(A.project, st.project, 'page A and the document service');
  assertSameBytes(B.project, st.project, 'page B and the document service');
  assert.equal(A.pending(), 0);
  assert.equal(B.pending(), 0);
});

// ------------------------------------------------------------------ V6

test('C65-V6-01 20 edits made while disconnected land in order after reconnecting (one commit each, and others receive them in order)', async (t) => {
  const { env, open } = await setup(t);
  const link = await createLink(env);
  t.after(link.close);
  const A = await open({ user: 'alice', session: 'page-a', via: link });
  const w = await observer(env, PID);
  const rev0 = (await serverState(env, PID)).rev;

  await link.offline(A);
  for (let i = 1; i <= 20; i++) A.edit((p) => { clipOf(p, 'c1').frame.x = 1000 + i; });
  assert.equal(clipOf(A.project, 'c1').frame.x, 1020, 'edits still land locally while offline');
  assert.equal(A.pending(), 20, 'the 20 edits go into the outgoing queue');
  await sleep(200);
  assert.deepEqual(w.ops(), [], 'the server received nothing while disconnected');

  link.online();
  await A.settled(20_000);
  const mine = w.ops().filter((m) => byIs(m.actor, { user: 'alice', session: 'page-a' }));
  assert.equal(mine.length, 20, `each of the 20 commits landed: ${mine.length}`);
  assert.deepEqual(mine.map((m) => m.rev), Array.from({ length: 20 }, (_, i) => rev0 + 1 + i), 'version numbers are consecutive');
  const xs = mine.map((m) => m.ops.find((o) => o.path.endsWith('/frame/x'))?.value);
  assert.deepEqual(xs, Array.from({ length: 20 }, (_, i) => 1001 + i), 'landed in the order made while offline');
  const st = await serverState(env, PID);
  assertSameBytes(A.project, st.project, 'page and document service after recovery');
});

/** Others also edited while offline: A edits 5 times offline, B edits c1 and c2 online, A recovers */
async function offlineConflict(t) {
  const { env, open } = await setup(t);
  const link = await createLink(env);
  t.after(link.close);
  const A = await open({ user: 'alice', session: 'page-a', via: link });
  const B = await open({ user: 'bob', session: 'page-b' });
  await link.offline(A);
  for (let i = 1; i <= 5; i++) A.edit((p) => { clipOf(p, 'c1').frame.x = 100 + i; clipOf(p, 'c3').params = { text: `Offline ${i}` }; });
  B.edit((p) => { clipOf(p, 'c1').frame.x = -5; clipOf(p, 'c2').frame.x = 555; });
  await B.settled();
  const afterB = await serverState(env, PID);

  link.online();
  await waitFor(() => A.conflicts.length > 0, 15_000, 'the page is notified after the first one is rejected (onOfflineConflict)');
  await sleep(300);
  assert.equal(A.conflicts.length, 1, 'notified only once');
  assert.equal(A.pending(), 5, 'the whole batch stops: all 5 are still in the outgoing queue');
  const still = await serverState(env, PID);
  assert.equal(still.rev, afterB.rev, 'no further commits after the rejection');
  assert.deepEqual(still.project, afterB.project);
  return { env, A, B, afterB };
}

test('C65-V6-02 others also edited during the offline period: the first one is rejected and the whole batch stops; after choosing "Replay", the expected version is dropped and the edits are committed one by one', async (t) => {
  const { env, A, B, afterB } = await offlineConflict(t);
  await A.resolveOffline('replay');
  await A.settled(15_000);
  const st = await converged(env, [A, B]);
  assert.equal(st.rev, afterB.rev + 5, 'the 5 edits land one after another');
  assert.equal(clipOf(st.project, 'c1').frame.x, 105, 'after replay, the last writer (A) wins');
  assert.equal(clipOf(st.project, 'c2').frame.x, 555, 'c2, which A did not touch, keeps B\'s');
  assert.deepEqual(clipOf(st.project, 'c3').params, { text: 'Offline 5' });
  assertSameBytes(A.project, st.project, 'page A');
  assertSameBytes(B.project, st.project, 'page B');
});

test('C65-V6-03 others also edited during the offline period: after choosing "Discard", local state returns to the server version, and the discarded batch is first saved as a local backup', async (t) => {
  const { env, A, afterB } = await offlineConflict(t);
  const nBackups = A.backups.length;
  await A.resolveOffline('discard');
  await waitFor(() => A.pending() === 0, 5000, 'outgoing queue cleared');
  await sleep(200);
  const st = await serverState(env, PID);
  assert.equal(st.rev, afterB.rev, 'discarding commits nothing');
  assertSameBytes(A.project, st.project, 'page A returns to the server version');
  assert.equal(clipOf(A.project, 'c1').frame.x, -5);
  assert.ok(A.backups.length > nBackups, 'before discarding, that batch of local changes is saved to a local backup (design draft section 8 ruling)');

  // Edit online as usual after discarding
  A.edit((p) => { clipOf(p, 'c4').frame.x = 44; });
  await A.settled();
  assert.equal(clipOf((await serverState(env, PID)).project, 'c4').frame.x, 44);
});

// ------------------------------------------------------------------ V7

test('C65-V7-01 saving .proc while operations are unacknowledged: it writes only after all operations are acknowledged, and the written content matches the document service\'s rev', async (t) => {
  const { env, open } = await setup(t);
  const link = await createLink(env);
  t.after(link.close);
  const A = await open({ user: 'alice', session: 'page-a', via: link });
  await link.offline(A);
  A.edit((p) => { clipOf(p, 'c1').frame.x = 71; });
  A.edit((p) => { p.name = 'Before save'; });
  const writes = [];
  const saving = A.save((project, rev) => { writes.push({ project: structuredClone(project), rev }); });
  saving.catch(() => {}); // May prompt timeout during disconnection; here only check whether it was written
  await sleep(400);
  assert.deepEqual(writes, [], 'does not write while operations are still unacknowledged');

  link.online();
  await waitFor(() => writes.length > 0, 15_000, 'writes .proc after acknowledgement');
  assert.equal(writes.length, 1, 'written only once');
  const st = await serverState(env, PID);
  assert.equal(writes[0].rev, st.rev, 'the rev carried when writing is the document service\'s current version');
  assertSameBytes(writes[0].project, st.project, 'the written content is identical to this version in the document service');
  assert.equal(writes[0].project.name, 'Before save');
});

test('C65-V7-02 no unacknowledged operations: save writes immediately, and rev is the latest', async (t) => {
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

// ------------------------------------------------------------------ V4 page side

test('C65-V4-10 an overwritten page: first saves its own version of that entity as a local backup, then applies the new version', async (t) => {
  const { open } = await setup(t);
  const A = await open({ user: 'alice', session: 'page-a' });
  const B = await open({ user: 'bob', session: 'page-b' });
  A.edit((p) => { clipOf(p, 'c1').frame.x = 1; clipOf(p, 'c1').params = { text: 'A\'s version' }; });
  await A.settled();
  const mine = structuredClone(clipOf(A.project, 'c1'));
  await waitFor(() => clipOf(B.project, 'c1').frame.x === 1, 5000, 'B receives A\'s change');
  B.edit((p) => { clipOf(p, 'c1').frame.x = 2; clipOf(p, 'c1').params = { text: 'B\'s version' }; });
  await B.settled();
  await waitFor(() => clipOf(A.project, 'c1').frame.x === 2, 5000, 'A applied B\'s new version');
  const bk = A.backups.filter((b) => b.entity === '/tracks/@t1/clips/@c1');
  assert.equal(bk.length, 1, `the overwritten side saved one backup: ${JSON.stringify(A.backups).slice(0, 400)}`);
  assert.deepEqual(bk[0].value, mine, 'the backup holds its original version');
  assert.equal(B.backups.length, 0, 'the overwriting side saves no backup');
});

// ------------------------------------------------------------------ V8 loopback latency

test('C65-V8-02 local loopback: from one page\'s edit to the other page seeing the change ≤ 300 ms', async (t) => {
  const { open } = await setup(t, { clips: 50 });
  const A = await open({ user: 'alice', session: 'page-a' });
  const B = await open({ user: 'bob', session: 'page-b' });
  const lat = [];
  for (let i = 0; i < 12; i++) {
    const x = 5000 + i;
    const t0 = performance.now();
    A.edit((p) => { clipOf(p, `c${1 + (i % 50)}`).start = x; }); // Drag and release = one commit
    await waitFor(() => clipOf(B.project, `c${1 + (i % 50)}`).start === x, 3000, `change ${i} reaches B`);
    lat.push(performance.now() - t0);
  }
  const warm = lat.slice(2);
  assert.ok(Math.max(...warm) <= 300, `latency (ms): ${lat.map((x) => x.toFixed(1)).join(', ')}`);
});
