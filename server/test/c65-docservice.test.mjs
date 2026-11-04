/**
 * C6.5 document service real project implementation (design doc `docs/plan/c65-design.md`
 * Section 3; server-side portion of acceptance checks V3, V4).
 * Run: node --test server/test/c65-docservice.test.mjs
 *
 * Written strictly to the design doc, without looking at the implementation. The service uses
 * `createDocService` standalone mode + project module (Assumption A3); for message fields,
 * see Assumptions A4~A6.
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

/**
 * Seed (root replacement) written one hour ago, so that the seed's write identity is not within
 * the 10-minute window and does not interfere with overwrite notification assertions
 */
async function withSeed(t, opts = {}) {
  const env = await startProjectService(opts);
  t.after(env.cleanup);
  const t0 = env.clock.t;
  env.clock.t = t0 - 60 * MIN;
  const rev = await seedProject(env, PID, fixedProject({ clips: 4 }));
  env.clock.t = t0;
  return { env, rev };
}

// ------------------------------------------------------------------ Open and submit

test('C65-V3-01 project.open returns project.state { projectId, rev, project, writers }; after a root replacement seed, rev is 1 and project is identical item by item', async (t) => {
  const env = await startProjectService();
  t.after(env.cleanup);
  const c = await env.connect({ user: 'alice', dev: 'd-a' });
  const st0 = await openProject(c, 'fresh-proj');
  assert.equal(st0.rev, 0, `a project that was never written has rev 0: ${JSON.stringify(st0)}`);
  assert.ok('project' in st0, 'project.state carries a project field');
  assert.ok('writers' in st0, 'project.state carries a writers field');

  const p = fixedProject({ clips: 3 });
  const ok = await submit(c, { projectId: 'fresh-proj', ops: [{ op: 'set', path: '', value: p }], session: 's-a' });
  assert.ok(isOk(ok), JSON.stringify(ok));
  assert.equal(ok.rev, 1);
  const st = await serverState(env, 'fresh-proj');
  assert.equal(st.rev, 1);
  assert.deepEqual(st.project, p);
});

test('C65-V3-02 a successful commit returns project.op.ok { opId, rev }, rev increases by one each time; the project content changes according to the operations', async (t) => {
  const { env, rev } = await withSeed(t);
  const c = await env.connect({ user: 'alice', dev: 'd-a' });
  await openProject(c, PID);
  for (let i = 1; i <= 5; i++) {
    const opId = newOpId('v3-02');
    const r = await submit(c, { projectId: PID, opId, ops: [{ op: 'set', path: '/tracks/@t1/clips/@c1/frame/x', value: 100 + i }], session: 's-a' });
    assert.ok(isOk(r), JSON.stringify(r));
    assert.equal(r.opId, opId, 'ok carries back the opId');
    assert.equal(r.rev, rev + i, 'rev increases by one each time');
  }
  const st = await serverState(env, PID);
  assert.equal(st.rev, rev + 5);
  assert.equal(clipOf(st.project, 'c1').frame.x, 105);
});

test('C65-V3-03 broadcast project.ops { rev, opId, ops, actor, undoOf }: sent to every subscriber except the committer; actor is taken from the connection, and an identity self-reported in the message is not trusted', async (t) => {
  const { env, rev } = await withSeed(t);
  const a = await env.connect({ user: 'alice', dev: 'd-a' });
  const b = await env.connect({ user: 'bob', dev: 'd-b' });
  const c = await env.connect({ user: 'carol', dev: 'd-c' });
  const idle = await env.connect({ user: 'dave', dev: 'd-d' }); // Project not opened
  for (const x of [a, b, c]) await openProject(x, PID);

  const ops = [{ op: 'set', path: '/tracks/@t1/clips/@c2/frame/x', value: 7 }, { op: 'remove', path: '/tracks/@t1/clips/@c4' }];
  const opId = newOpId('v3-03');
  a.send({ type: 'project.op', projectId: PID, opId, session: 's-a', ops, actor: { userId: 'mallory', session: 'x' }, userId: 'mallory' });
  const ok = await a.next((m) => (isOk(m) || isRejected(m)) && m.opId === opId);
  assert.ok(isOk(ok), JSON.stringify(ok));

  for (const [who, x] of [['bob', b], ['carol', c]]) {
    const m = await x.next(byType('project.ops'));
    assert.equal(m.rev, rev + 1, `rev received by ${who}`);
    assert.equal(m.opId, opId);
    assert.deepEqual(m.ops, ops, `ops received by ${who} are unchanged`);
    assert.ok(byIs(m.actor, { user: 'alice', session: 's-a' }), `actor is taken from the connection: ${JSON.stringify(m.actor)}`);
    assert.ok(!JSON.stringify(m).includes('mallory'), 'an identity self-reported in the message is never trusted');
    assert.equal(m.undoOf ?? undefined, undefined, 'no undoOf when it is not an undo');
  }
  assert.deepEqual(await quietOps(a), [], 'the committer knows it landed from ok and no longer receives project.ops');
  assert.deepEqual(await quietOps(idle, 0), [], 'a connection that has not opened the project receives nothing');

  // undoOf broadcast as is
  const r2 = await submit(b, { projectId: PID, ops: [{ op: 'set', path: '/tracks/@t1/clips/@c2/frame/x', value: 20 }], session: 's-b', undoOf: opId });
  assert.ok(isOk(r2));
  const m2 = await a.next(byType('project.ops'));
  assert.equal(m2.undoOf, opId, 'the undoOf of an undo commit is broadcast unchanged');
  assert.equal(m2.rev, rev + 2);
});

test('C65-V3-04 a page commit carries no expectRev: it lands in arrival order and the later one wins', async (t) => {
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

test('C65-V3-05 an Agent carries expectRev: a mismatch returns stale, and since lists exactly every commit in between { rev, actor, paths }; the state is unchanged; after re-reading, the write succeeds', async (t) => {
  const { env, rev } = await withSeed(t);
  const agent = await env.connect({ user: 'alice', dev: 'd-a', role: 'agent', conv: 'conv-1' });
  const page = await env.connect({ user: 'bob', dev: 'd-b', role: 'page' });
  const watch = await env.connect({ user: 'carol', dev: 'd-c' });
  for (const x of [agent, page, watch]) await openProject(x, PID);
  const read = rev; // Version read by Agent

  const p1 = [{ op: 'set', path: '/tracks/@t1/clips/@c1/frame/x', value: 11 }, { op: 'set', path: '/fps', value: 25 }];
  const p2 = [{ op: 'remove', path: '/tracks/@t1/clips/@c3' }];
  assert.ok(isOk(await submit(page, { projectId: PID, ops: p1, session: 'page-b' })));
  assert.ok(isOk(await submit(page, { projectId: PID, ops: p2, session: 'page-b' })));
  await watch.next(byType('project.ops'));
  await watch.next(byType('project.ops'));
  const before = await serverState(env, PID);

  const rej = await submit(agent, { projectId: PID, ops: [{ op: 'set', path: '/tracks/@t1/clips/@c1/frame/x', value: 999 }], expectRev: read, session: 'conv-1' });
  assert.ok(isRejected(rej), `a mismatched expected version should be rejected: ${JSON.stringify(rej)}`);
  assert.equal(rej.reason, 'stale');
  assert.equal(rej.currentRev, rev + 2);
  assert.ok(Array.isArray(rej.since), 'since is an array');
  assert.deepEqual(rej.since.map((s) => s.rev), [rev + 1, rev + 2], 'since is exactly every commit that landed in between');
  assert.deepEqual(rej.since.map((s) => s.paths), [p1.map((o) => o.path), p2.map((o) => o.path)], 'paths match the actual changes');
  for (const s of rej.since) assert.ok(byIs(s.actor, { user: 'bob', session: 'page-b' }), `actor: ${JSON.stringify(s.actor)}`);
  assert.deepEqual(await quietOps(watch), [], 'a rejected commit is not broadcast');
  const after = await serverState(env, PID);
  assert.deepEqual(after, before, 'state and version are unchanged after a rejection');

  // Re-read then write
  const ok = await submit(agent, { projectId: PID, ops: [{ op: 'set', path: '/tracks/@t1/clips/@c1/frame/x', value: 999 }], expectRev: rej.currentRev, session: 'conv-1' });
  assert.ok(isOk(ok), JSON.stringify(ok));
  assert.equal(ok.rev, rev + 3);
  assert.equal(clipOf((await serverState(env, PID)).project, 'c1').frame.x, 999);

  // expectRev equals current version exactly: accepted; since differing by only one version has only one entry
  assert.ok(isOk(await submit(page, { projectId: PID, ops: [{ op: 'set', path: '/name', value: 'n' }], session: 'page-b' })));
  const rej2 = await submit(agent, { projectId: PID, ops: [{ op: 'set', path: '/name', value: 'm' }], expectRev: rev + 3, session: 'conv-1' });
  assert.equal(rej2.reason, 'stale');
  assert.deepEqual(rej2.since.map((s) => [s.rev, s.paths]), [[rev + 4, ['/name']]]);
});

test('C65-V1-30 the server applies a whole batch atomically: one bad-path rejects the whole batch, rev does not increase, nothing is broadcast, and the content is unchanged', async (t) => {
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
  // Subsequent submissions start from rev + 1 as usual
  const ok = await submit(a, { projectId: PID, ops: [{ op: 'set', path: '/name', value: 'x' }], session: 's-a' });
  assert.equal(ok.rev, rev + 1);
});

test('C65-V3-06 too-large: a single commit over 256 KiB is rejected and rev is unchanged; one of about a hundred KiB is accepted as usual', async (t) => {
  const { env, rev } = await withSeed(t);
  const a = await env.connect({ user: 'alice', dev: 'd-a' });
  await openProject(a, PID);
  const big = 'x'.repeat(300 * 1024);
  const r = await submit(a, { projectId: PID, ops: [{ op: 'set', path: '/blob', value: big }], session: 's-a' });
  assert.ok(isRejected(r), `300 KiB should be rejected: ${r.type}`);
  assert.equal(r.reason, 'too-large');
  assert.equal(r.currentRev, rev);
  const ok = await submit(a, { projectId: PID, ops: [{ op: 'set', path: '/blob', value: 'y'.repeat(100 * 1024) }], session: 's-a' });
  assert.ok(isOk(ok), JSON.stringify({ type: ok.type, reason: ok.reason }));
  assert.equal(ok.rev, rev + 1);
});

// ------------------------------------------------------------------ Overwrite notifications

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

test('C65-V4-01 another writer identity overwrites the same clip within 10 minutes: the overwriting side\'s ok carries overwrote, and the overwritten side receives one project.overwritten', async (t) => {
  const { clock, a, b } = await twoWriters(t);
  clock.t = T0 + 1000;
  assert.ok(isOk(await submit(a, { projectId: PID, ops: setX('c1', 1), session: 's-a' })));
  clock.t = T0 + 1000 + 9 * MIN;
  const okB = await submit(b, { projectId: PID, ops: setX('c1', 2), session: 's-b' });
  assert.ok(isOk(okB));
  assert.ok(Array.isArray(okB.overwrote), `the overwriting side's ok carries overwrote: ${JSON.stringify(okB)}`);
  assert.equal(okB.overwrote.length, 1, 'one entry');
  assert.equal(okB.overwrote[0].entity, C1);
  assert.ok(byIs(okB.overwrote[0].by, { user: 'alice', session: 's-a' }), `by is the overwritten side: ${JSON.stringify(okB.overwrote[0].by)}`);

  const n = await a.next(byType('project.overwritten'));
  assert.equal(n.entity, C1);
  assert.ok(byIs(n.by, { user: 'bob', session: 's-b' }), `by is the overwriting side: ${JSON.stringify(n.by)}`);
  assert.equal(n.rev, okB.rev);
  assert.deepEqual(await quietOverwritten(a), [], 'the overwritten side receives only one');
  assert.deepEqual(await quietOverwritten(b, 0), [], 'the overwriting side does not additionally receive project.overwritten');
});

test('C65-V4-02 after more than 10 minutes: no notification', async (t) => {
  const { clock, a, b } = await twoWriters(t);
  assert.ok(isOk(await submit(a, { projectId: PID, ops: setX('c1', 1), session: 's-a' })));
  clock.t = T0 + 10 * MIN + 1;
  const okB = await submit(b, { projectId: PID, ops: setX('c1', 2), session: 's-b' });
  assert.ok(isOk(okB));
  assert.ok(!okB.overwrote || okB.overwrote.length === 0, `no overwrote after more than 10 minutes: ${JSON.stringify(okB.overwrote)}`);
  assert.deepEqual(await quietOverwritten(a), []);
});

test('C65-V4-03 writer identity: the same identity gets no notification; the same user on the same device in a different page session counts as a different identity', async (t) => {
  const { env, a } = await twoWriters(t);
  assert.ok(isOk(await submit(a, { projectId: PID, ops: setX('c1', 1), session: 's-a' })));
  const again = await submit(a, { projectId: PID, ops: setX('c1', 2), session: 's-a' });
  assert.ok(!again.overwrote || again.overwrote.length === 0, 'overwriting yourself sends no notification');

  const a2 = await env.connect({ user: 'alice', dev: 'd-a' }); // Same user and same device, another page
  await openProject(a2, PID);
  const other = await submit(a2, { projectId: PID, ops: setX('c1', 3), session: 's-a2' });
  assert.equal(other.overwrote?.length, 1, `another page session counts as another writer identity: ${JSON.stringify(other)}`);
  const n = await a.next(byType('project.overwritten'));
  assert.ok(byIs(n.by, { user: 'alice', session: 's-a2' }));
});

// Integration reconciliation (Category B, 2026-09-26 ruling changed entity granularity): original
// assertion "width / fps both belong to /meta" changed to "top-level fields each count as an
// entity /meta/<key>": someone else modifying fps shouldn't prevent me from undoing my own change
// to name. See c65-design.md Section 13.
test('C65-V4-04 top-level entities: different clips are independent; width / fps each count as one entity (/meta/width, /meta/fps)', async (t) => {
  const { a, b } = await twoWriters(t);
  assert.ok(isOk(await submit(a, { projectId: PID, ops: setX('c1', 1), session: 's-a' })));
  const r = await submit(b, { projectId: PID, ops: setX('c2', 1), session: 's-b' });
  assert.ok(!r.overwrote || r.overwrote.length === 0, 'different clips do not count as overwriting');
  assert.deepEqual(await quietOverwritten(a), []);

  assert.ok(isOk(await submit(a, { projectId: PID, ops: [{ op: 'set', path: '/fps', value: 25 }], session: 's-a' })));
  const r2 = await submit(b, { projectId: PID, ops: [{ op: 'set', path: '/width', value: 1280 }], session: 's-b' });
  assert.ok(!r2.overwrote || r2.overwrote.length === 0, `width and fps are two entities and do not count as overwriting: ${JSON.stringify(r2.overwrote)}`);
  assert.deepEqual(await quietOverwritten(a), []);
  const r3 = await submit(b, { projectId: PID, ops: [{ op: 'set', path: '/fps', value: 60 }], session: 's-b' });
  assert.deepEqual(r3.overwrote?.map((o) => o.entity), ['/meta/fps'], `only the same fps counts as overwriting: ${JSON.stringify(r3.overwrote)}`);
  const n = await a.next(byType('project.overwritten'));
  assert.equal(n.entity, '/meta/fps');
});

test('C65-V4-05 a root replacement is also an ordinary write: it still records a version and still notifies about overwriting', async (t) => {
  const { a, b } = await twoWriters(t);
  const okA = await submit(a, { projectId: PID, ops: setX('c1', 1), session: 's-a' });
  const next = fixedProject({ clips: 4 });
  clipOf(next, 'c1').frame.x = 77;
  const okB = await submit(b, { projectId: PID, ops: [{ op: 'set', path: '', value: next }], session: 's-b' });
  assert.ok(isOk(okB));
  assert.equal(okB.rev, okA.rev + 1);
  assert.ok(okB.overwrote?.some((o) => o.entity === C1), `the root replacement changes c1, so overwrote contains c1: ${JSON.stringify(okB.overwrote)}`);
  const n = await a.next((m) => m.type === 'project.overwritten' && m.entity === C1);
  assert.equal(n.rev, okB.rev);
});

// ------------------------------------------------------------------ Restart replay

test('C65-V3-07 file storage: after 230 commits and a restart, it reads the snapshot and then replays the log, rev and content match; the log is truncated at the snapshot', async (t) => {
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
    else if (k === 2) ops = [{ op: 'set', path: '/name', value: `Name ${i}` }];
    else ops = setX(`c${1 + r.int(5)}`, i);
    last = await submit(a, { projectId: PID, ops, session: 's-a' });
    assert.ok(isOk(last), `#${i} ${JSON.stringify(last)}`);
  }
  assert.equal(last.rev, seedRev + 230);
  const before = await serverState(env1, PID);
  await env1.cleanup();

  const file = join(dir, 'projects', `${PID}.ops.ndjson`);
  assert.ok(existsSync(file), `the operation log is at <dir>/projects/<projectId>.ops.ndjson (assumption A8)`);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const l of lines) JSON.parse(l);
  assert.ok(lines.length <= 200, `a snapshot is written every 200 commits and the log is truncated to after the snapshot: currently ${lines.length} lines`);

  const env2 = await startProjectService({ dir, clock });
  t.after(env2.cleanup);
  const after = await serverState(env2, PID);
  assert.equal(after.rev, before.rev, 'rev restored');
  assert.deepEqual(after.project, before.project, 'content restored');
  assert.equal(JSON.stringify(after.project), JSON.stringify(before.project), 'byte-for-byte identical');

  const b = await env2.connect({ user: 'bob', dev: 'd-b' });
  await openProject(b, PID);
  const ok = await submit(b, { projectId: PID, ops: setX('c1', -1), session: 's-b' });
  assert.equal(ok.rev, before.rev + 1, 'keeps counting up after the restart');
});
