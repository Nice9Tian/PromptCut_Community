/**
 * Project version module (contract `docs/plan/docservice-contract.md` sections 1 and 3,
 * test cases P1 to P7).
 * Run: node --test server/test/docservice-project.test.mjs
 *
 * Written strictly against contract, ignoring implementation. Tested module is retrieved via
 * dynamic import; each test case fails individually when module is missing.
 * `createDocService` standalone mode, port 0, `autoTick: false`; clock injected via `now`; storage
 * uses memory or temporary directory.
 * principal is provided by test `authenticate` based on query string `?user=`
 * (see `fake-docservice-env.mjs`).
 * All responses from this module return the request's `reqId` as is (contract section 1); tests
 * retrieve responses by `reqId`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { byType } from './fake-ws-kit.mjs';
import { loadStore, loadProject, tempDir, startStandalone, ask } from './fake-docservice-env.mjs';

const T0 = 1_700_000_000_000;
/** 64-character hexadecimal digest */
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

test('P1 project.open on a project never seen: projectRev 0, digest null, at null, and the reply carries reqId; the module name appears in /healthz', async (t) => {
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
  assert.ok(Array.isArray(h.modules) && h.modules.includes('project'), `/healthz.modules must include project: ${JSON.stringify(h.modules)}`);

  // Contract section 10 item 5: does not add fields to /healthz, only provides describe()
  const bare = await startStandalone({ modules: [] });
  t.after(bare.cleanup);
  assert.deepEqual(Object.keys(h).sort(), Object.keys(await bare.health()).sort(), 'the /healthz field set is unchanged after mounting the project module');
  const d = env.service.describe();
  assert.ok(Object.hasOwn(d.modules, 'project'), 'describe().modules contains project');
  assert.notEqual(d.modules.project, null, 'the project module provides describe()');
});

// ------------------------------------------------------------------ P2

test('P2 announce a new digest: projectRev increments by one; only connections subscribed to this project receive project.rev, and subscribers of other projects get 0 messages', async (t) => {
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
  assert.deepEqual(pick(await b.next(byType('project.rev'))), expected, 'another subscriber of the same project receives project.rev');
  assert.deepEqual(pick(await a.next(byType('project.rev'))), expected, 'the originator is also among the subscribers');
  // Contract section 10 item 2: for the same request, respond first, then broadcast
  const iAck = a.all.findIndex((m) => m.type === 'project.announced');
  const iRev = a.all.findIndex((m) => m.type === 'project.rev');
  assert.ok(iAck >= 0 && iRev > iAck, `project.announced comes before project.rev: announced@${iAck}, rev@${iRev}`);
  assert.deepEqual(await revs(other), [], 'subscribers of other projects get 0 messages');
  assert.deepEqual(await revs(idle), [], 'connections that have not opened get 0 messages');
  assert.equal(idle.all.filter(byType('project.announced')).length, 0, 'project.announced is not sent to connections other than the originator');
  assert.equal(b.all.filter(byType('project.announced')).length, 0, 'project.announced is not sent to connections other than the originator');

  // Second change: add one more
  env.clock.t = T0 + 2000;
  const ack2 = await announce(b, { projectId: 'proj-A', digest: dg(2) });
  assert.equal(ack2.projectRev, 2);
  assert.equal(ack2.changed, true);
  const r2 = await a.next(byType('project.rev'));
  assert.deepEqual(pick(r2), { type: 'project.rev', projectId: 'proj-A', projectRev: 2, digest: dg(2), actor: { userId: 'bob', session: null }, at: T0 + 2000 },
    'actor.session is null when no session is given');
  await b.next(byType('project.rev'));

  // Connections without open can also announce: get announced, but do not receive broadcasts
  const ack3 = await announce(idle, { projectId: 'proj-A', digest: dg(3) });
  assert.equal(ack3.projectRev, 3);
  assert.deepEqual(await revs(idle), [], 'the originator does not receive project.rev when not subscribed');
  assert.equal((await a.next(byType('project.rev'))).projectRev, 3);

  // State
  const st = await open(other, 'proj-A');
  assert.deepEqual({ projectRev: st.projectRev, digest: st.digest, at: st.at }, { projectRev: 3, digest: dg(3), at: T0 + 2000 });
  // project.close unsubscribe
  const closedAck = await ask(b, { type: 'project.close', projectId: 'proj-A' });
  assert.deepEqual({ type: closedAck.type, projectId: closedAck.projectId }, { type: 'project.closed', projectId: 'proj-A' });
  await announce(a, { projectId: 'proj-A', digest: dg(4) });
  assert.equal((await a.next(byType('project.rev'))).projectRev, 4);
  assert.deepEqual(await revs(b), [], 'nothing is received after close');
});

// ------------------------------------------------------------------ P3

test('P3 identical digest: no increment, changed: false, no broadcast, nothing written to the log', async (t) => {
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
  assert.deepEqual(await revs(w), [], 'no broadcast');
  assert.deepEqual(await revs(a, 0), [], 'the originator gets none either');
  assert.equal(env.store.read('projects/p3').length, before, 'an identical digest writes nothing to the log');
  const st = await open(w, 'p3');
  assert.deepEqual({ projectRev: st.projectRev, digest: st.digest, at: st.at }, { projectRev: 1, digest: dg('x'), at: T0 }, 'at unchanged');
});

// ------------------------------------------------------------------ P4

test('P4 file storage: after the service is shut down and created anew in the same directory, projectRev and digest are restored, and the next announce continues upward from the restored value', async (t) => {
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
  // Valid projectId may contain ':' (regex in contract section 1); filename mapping is
  // implementation-defined, only recoverability is required here
  assert.equal((await announce(a, { projectId: 'scene:p4', digest: dg('c1') })).projectRev, 1);
  assert.equal((await announce(a, { projectId: 'scene:p4', digest: dg('c2') })).projectRev, 2);
  // Two projects differing only by case (contract section 10 item 9: may land on the same file on
  // Windows, replay filters by projectId)
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
  assert.equal((await open(b, 'p4-other')).projectRev, 1, 'each project is restored separately');
  const colon = await open(b, 'scene:p4');
  assert.deepEqual({ projectRev: colon.projectRev, digest: colon.digest }, { projectRev: 2, digest: dg('c2') }, 'a projectId containing a colon is also restored');
  const upper = await open(b, 'CaseP4');
  const lower = await open(b, 'casep4');
  assert.deepEqual([upper.projectRev, upper.digest, lower.projectRev, lower.digest], [1, dg('U1'), 2, dg('l2')], 'projects differing only in case are restored separately');

  const same = await announce(b, { projectId: 'p4', digest: dg(3) });
  assert.deepEqual({ projectRev: same.projectRev, changed: same.changed }, { projectRev: 3, changed: false }, 'the restored digest takes part in the comparison');
  const next = await announce(b, { projectId: 'p4', digest: dg(4) });
  assert.deepEqual({ projectRev: next.projectRev, changed: next.changed }, { projectRev: 4, changed: true });
  assert.equal((await b.next(byType('project.rev'))).projectRev, 4);
});

// ------------------------------------------------------------------ P5

test('P5 every line of the log file is valid JSON with all fields present, and actor.userId comes from principal, not from the message', async (t) => {
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
  await announce(a, { projectId: 'p5', digest: dg(2) }); // Identical, do not write

  const file = join(dir, 'projects', 'p5.ndjson');
  assert.ok(existsSync(file), `log file is at <dir>/projects/<projectId>.ndjson: ${JSON.stringify(readdirSync(dir, { recursive: true }))}`);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'), 'every line ends with a newline');
  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2, 'two changes give two lines');
  const records = lines.map((l, i) => {
    try { return JSON.parse(l); } catch { assert.fail(`line ${i + 1} is not valid JSON: ${l}`); }
  });
  for (const r of records) {
    for (const k of ['projectId', 'rev', 'digest', 'actor', 'at']) assert.ok(Object.hasOwn(r, k), `missing field ${k}: ${JSON.stringify(r)}`);
  }
  const pick = (r) => ({ projectId: r.projectId, rev: r.rev, digest: r.digest, actor: r.actor, at: r.at });
  assert.deepEqual(records.map(pick), [
    { projectId: 'p5', rev: 1, digest: dg(1), actor: { userId: 'alice', session: 'tab-9' }, at: T0 + 10 },
    { projectId: 'p5', rev: 2, digest: dg(2), actor: { userId: 'alice', session: null }, at: T0 + 20 },
  ]);
  assert.ok(!text.includes('mallory'), 'a self-reported userId in a message is never honored and does not go into the log');
});

// ------------------------------------------------------------------ P6

test('P6 validation: an invalid projectId, digest or session → bad-message (carrying reqId), state unchanged', async (t) => {
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
    // Wait by reqId or error type to avoid waiting until timeout when reqId is not returned; reqId
    // asserted separately
    const reqId = `p6-${++n}`;
    a.send({ ...msg, reqId });
    const reply = await a.next((m) => m.reqId === reqId || m.type === 'error');
    assert.equal(reply.reqId, reqId, `the error reply must carry the reqId back unchanged: ${JSON.stringify(reply)}`);
    assert.equal(reply.type, 'error', `should be rejected: ${JSON.stringify(msg)} → ${JSON.stringify(reply)}`);
    assert.equal(reply.reason, 'bad-message', `should be bad-message: ${JSON.stringify(msg)} → ${JSON.stringify(reply)}`);
  }
  assert.deepEqual(await revs(w), [], 'no broadcast');
  assert.deepEqual(a.all.filter(byType('project.rev')), [], 'a rejected open subscribes to nothing');
  assert.equal(env.store.read('projects/p6').length, 1, 'no extra writes to the log');
  const st = await open(w, 'p6');
  assert.deepEqual({ projectRev: st.projectRev, digest: st.digest }, { projectRev: 1, digest: dg(1) }, 'state unchanged');

  // Borderline valid values pass as usual
  const ok = await announce(a, { projectId: 'A-z.0_:9', digest: '0123456789abcdef', session: 'x'.repeat(128) });
  assert.deepEqual({ type: ok.type, projectRev: ok.projectRev }, { type: 'project.announced', projectRev: 1 });
  const ok2 = await announce(a, { projectId: 'y'.repeat(128), digest: 'f'.repeat(128), session: 's' });
  assert.deepEqual({ type: ok2.type, projectRev: ok2.projectRev }, { type: 'project.announced', projectRev: 1 });
});

// ------------------------------------------------------------------ P7

test('P7 the last line of the log is truncated (a half line written by hand): that line is dropped on recovery without crashing, and the earlier records are all there', async (t) => {
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
  assert.ok(existsSync(file), 'log file is at <dir>/projects/p7.ndjson');
  appendFileSync(file, `{"projectId":"p7","rev":3,"digest":"${dg(3).slice(0, 20)}`); // Half line, no newline

  const env2 = await start({ store: createFileStore({ dir }), clock });
  t.after(env2.cleanup);
  const b = await env2.connect('bob');
  const st = await open(b, 'p7');
  assert.deepEqual({ projectRev: st.projectRev, digest: st.digest }, { projectRev: 2, digest: dg(2) }, 'the half line is dropped, the earlier records are all there');

  const recs = createFileStore({ dir }).read('projects/p7');
  assert.deepEqual(recs.map((r) => r.rev), [1, 2], 'Store.read drops the broken last line');
});

test('P7 after truncation recovery, append again and restart again: new records are not corrupted by the half line, and projectRev continues upward', async (t) => {
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
  assert.deepEqual({ projectRev: st.projectRev, digest: st.digest }, { projectRev: 3, digest: dg(3) }, 'the line appended after truncation is intact');
  const recs = createFileStore({ dir }).read('projects/p7b');
  assert.deepEqual(recs.map((r) => r.rev), [1, 2, 3]);
});

test('P7 storage layer: both the memory and the file Store read back in order; path traversal is rejected and nothing is written outside the directory', async (t) => {
  const { createFileStore, createMemoryStore } = await loadStore();
  const root = tempDir(t);
  const dir = join(root, 'store');
  for (const [name, store] of [['memory', createMemoryStore()], ['file', createFileStore({ dir })]]) {
    assert.deepEqual(store.read('projects/none'), [], `${name}: a stream never written to reads back as an empty array`);
    store.append('projects/s1', { n: 1, s: '中文' });
    store.append('projects/s1', { n: 2 });
    store.append('content/card-source', { n: 3 });
    assert.deepEqual(store.read('projects/s1'), [{ n: 1, s: '中文' }, { n: 2 }], `${name}: read back in append order`);
    assert.deepEqual(store.read('content/card-source'), [{ n: 3 }], `${name}: streams do not bleed into each other`);
  }
  assert.ok(existsSync(join(dir, 'projects', 's1.ndjson')), 'file maps to <dir>/projects/<id>.ndjson');
  assert.ok(existsSync(join(dir, 'content', 'card-source.ndjson')), 'file maps to <dir>/content/<kind>.ndjson');

  const fileStore = createFileStore({ dir });
  for (const bad of ['../evil', 'projects/../../evil', '..\\evil', 'projects/..\\..\\evil']) {
    let threw = false;
    try { fileStore.append(bad, { bad: true }); } catch { threw = true; }
    const outside = readdirSync(root, { recursive: true }).filter((p) => String(p).includes('evil'));
    assert.deepEqual(outside, [], `path traversal ${bad} must not write a file outside the directory (threw=${threw})`);
  }
});
