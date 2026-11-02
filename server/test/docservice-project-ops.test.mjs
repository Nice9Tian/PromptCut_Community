/**
 * Authoritative project (C6.5 design draft `docs/plan/c65-design.md` sections 2, 3, 10, 11):
 * `project.open` / `project.op` / `project.ops` / overwrite notification / `project.follow` /
 * snapshot and log truncation / large project chunking / relationship with legacy `announce`.
 * Test cases DS-P1 to DS-P12.
 * Document service side of design draft acceptance check: V2 (DS-P11), V3 (DS-P5), V4 (DS-P7).
 * Run: node --test server/test/docservice-project-ops.test.mjs
 *
 * `createDocService` standalone mode, port 0, `autoTick: false`; clock injection. principal provided
 * by query string: `?user=alice&dev=d1&role=page&conv=3`; when without `role`, legacy identity
 * `{ userId, tenantId }`.
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

/** Query string → principal: with role, M6a shape; otherwise legacy */
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
  /** Connect by full query string (`startStandalone.connect` only recognizes user) */
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

test('DS-P1 open on a project with no body: project null, rev 0, hasBody false, writers empty; the old fields projectRev / digest / at unchanged', async (t) => {
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

test('DS-P2 submit: ok carries rev; project.ops goes only to subscribers other than the submitter, and subscribers of other projects get 0 messages; open returns the same content', async (t) => {
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
  assert.deepEqual(await opsOf(a), [], 'the submitter itself does not receive project.ops');
  assert.deepEqual(await opsOf(other), [], 'subscribers of other projects receive nothing');

  const ok2 = await op(b, [{ op: 'set', path: '/tracks/@t1/clips/@c2/end', value: 5 }, { op: 'insert', path: '/tracks/@t2/clips', index: 0, value: { id: 'c9', start: 0, end: 1 } }]);
  assert.equal(ok2.rev, 2);
  const seenA = await a.next(byType('project.ops'));
  assert.equal(seenA.rev, 2);
  const expected = applyOps(sample(), seenA.ops).root;
  const st = await open(await env.connect('user=dave&role=page'));
  assert.equal(st.rev, 2);
  assert.equal(st.hasBody, true);
  assert.equal(JSON.stringify(st.project), JSON.stringify(expected));
  assert.equal(st.digest, createHash('sha256').update(JSON.stringify(expected)).digest('hex'), 'digest is the sha256 of the body');
});

// ------------------------------------------------------------------ DS-P3

test('DS-P3 the whole batch is atomic: if a later op cannot be applied → rejected bad-path (with the index of the failing op), version unchanged, no broadcast; a malformed op is also bad-path; a missing opId replies bad-message', async (t) => {
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
  assert.equal(r3.reason, 'bad-path', 'empty batch');
  assert.deepEqual(await opsOf(b), [], 'a rejected commit is not broadcast');
  const st = await open(b);
  assert.equal(st.rev, 1);
  assert.equal(st.project.width, 1920, 'state unchanged');

  const e = await ask(a, { type: 'project.op', projectId: 'P', ops: [{ op: 'set', path: '/width', value: 2 }] });
  assert.deepEqual({ type: e.type, reason: e.reason }, { type: 'error', reason: 'bad-message' });
});

// ------------------------------------------------------------------ DS-P4

test('DS-P4 too-large: ops exceed 256 KiB once serialized; forbidden: a render node connection', async (t) => {
  const env = await start(t);
  const a = await env.connect('user=alice&role=page');
  await open(a);
  const big = 'x'.repeat(256 * 1024);
  const r = await op(a, [{ op: 'set', path: '/blob', value: big }]);
  assert.deepEqual({ type: r.type, reason: r.reason, currentRev: r.currentRev }, { type: 'project.op.rejected', reason: 'too-large', currentRev: 0 });
  const ok = await op(a, [{ op: 'set', path: '/blob', value: 'x'.repeat(200 * 1024) }]);
  assert.equal(ok.type, 'project.op.ok', 'up to 256 KiB is allowed');

  const n = await env.connect('user=node&role=render');
  const f = await op(n, [{ op: 'set', path: '/x', value: 1 }]);
  assert.deepEqual({ type: f.type, reason: f.reason, currentRev: f.currentRev }, { type: 'project.op.rejected', reason: 'forbidden', currentRev: 1 });
});

// ------------------------------------------------------------------ DS-P5 (V3)

test('DS-P5 (V3) expected version: after the Agent reads, the page changes the same entity, so the write-back of the Agent is stale and since matches the actual changes one by one; after re-reading, writing succeeds', async (t) => {
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
  assert.deepEqual(await opsOf(page), [], 'rejected ones are not broadcast');

  const reread = await open(agent);
  assert.equal(reread.rev, 3);
  const ok = await op(agent, [{ op: 'set', path: '/tracks/@t1/clips/@c1/end', value: 9 }], { expectRev: reread.rev, session: 'conv-7' });
  assert.deepEqual({ type: ok.type, rev: ok.rev }, { type: 'project.op.ok', rev: 4 });
  const seen = await page.next((m) => m.type === 'project.ops' && m.rev === 4);
  assert.deepEqual(seen.actor, { userId: 'alice@pc', deviceId: 'pc', role: 'agent', conversation: 7, session: 'conv-7' });

  // Expected version equals current: persist; without expected version: persist in arrival order
  assert.equal((await op(page, [{ op: 'set', path: '/fps', value: 24 }])).rev, 5);
});

// ------------------------------------------------------------------ DS-P6

test('DS-P6 idempotency: resubmitting the same opId returns the original rev (duplicate), is not applied again and not broadcast; checked before expectRev', async (t) => {
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

// ------------------------------------------------------------------ DS-P7 (V4)

test('DS-P7 (V4) overwrite notification: ok for the overwriting side carries overwrote, and the overwritten side receives one overwritten before the ops; the overwritten side is not notified when it has the same identity, when more than 10 minutes have passed, or when it has exited tracking', async (t) => {
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
  assert.deepEqual(wa.overwrote, [], 'writing again with the same identity after a root replacement: does not count as an overwrite');

  env.clock.t = T0 + 5 * MIN;
  const wb = await op(b, [{ op: 'set', path: '/tracks/@t1/clips/@c1/start', value: 0.75 }], { session: 'sb' });
  assert.deepEqual(wb.overwrote, [{ entity: '/tracks/@t1/clips/@c1', by: actorA, rev: wa.rev, at: T0 + 1 * MIN }]);
  // Overwritten party: overwritten arrives before the ops of this version
  const first = await a.next((m) => m.type === 'project.overwritten' || m.type === 'project.ops');
  assert.equal(first.type, 'project.overwritten', 'overwritten is received before ops');
  assert.deepEqual(
    { entity: first.entity, by: first.by, writer: first.writer, rev: first.rev },
    { entity: '/tracks/@t1/clips/@c1', by: actorB, writer: actorA, rev: wb.rev },
  );
  assert.equal((await a.next(byType('project.ops'))).rev, wb.rev);
  assert.deepEqual(await a.quiet(byType('project.overwritten'), 100), [], 'the overwritten side receives only one');
  assert.deepEqual(await b.quiet(byType('project.overwritten'), 100), [], 'the overwriting side does not receive overwritten');

  // Over 10 minutes: not counted as overwrite
  env.clock.t = T0 + 16 * MIN;
  const late = await op(a, [{ op: 'set', path: '/tracks/@t1/clips/@c1/start', value: 0.1 }], { session: 'sa' });
  assert.deepEqual(late.overwrote, []);
  await b.next(byType('project.ops'));
  assert.deepEqual(await b.quiet(byType('project.overwritten'), 100), []);

  // Stop tracking: a untracks c2; when b overwrites c2, b still knows, a does not receive it
  await op(a, [{ op: 'set', path: '/tracks/@t1/clips/@c2/end', value: 3 }], { session: 'sa' });
  await b.next(byType('project.ops'));
  const f = await ask(a, { type: 'project.follow', projectId: 'P', entity: '/tracks/@t1/clips/@c2/end', on: false, session: 'sa' });
  assert.deepEqual({ type: f.type, entity: f.entity, on: f.on }, { type: 'project.following', entity: '/tracks/@t1/clips/@c2', on: false });
  const wb2 = await op(b, [{ op: 'set', path: '/tracks/@t1/clips/@c2/end', value: 4 }], { session: 'sb' });
  assert.equal(wb2.overwrote.length, 1, 'the overwriting side still knows');
  assert.equal((await a.next(byType('project.ops'))).rev, wb2.rev);
  assert.deepEqual(await a.quiet(byType('project.overwritten'), 100), [], 'not received after exiting tracking');

  // Same user on same device, different page session: is another write identity
  const a2 = await env.connect('user=alice&dev=pa&role=page');
  await open(a2);
  const x = await op(a2, [{ op: 'set', path: '/tracks/@t1/clips/@c1/start', value: 0.9 }], { session: 'sa-2' });
  assert.equal(x.overwrote.length, 1);
  assert.equal((await a.next(byType('project.overwritten'))).entity, '/tracks/@t1/clips/@c1');

  // open's writers: recent writers within the time window
  const st = await open(b);
  const byEntity = Object.fromEntries(st.writers.map((w) => [w.entity, w.actor.session]));
  assert.equal(byEntity['/tracks/@t1/clips/@c1'], 'sa-2');
  assert.equal(byEntity['/tracks/@t1/clips/@c2'], 'sb');
});

// ------------------------------------------------------------------ DS-P8

test('DS-P8 persistence: a snapshot is written every N submissions and the log is truncated to after the snapshot; on restart the snapshot is read and then replayed, and version, content, idempotency and the most recent writer all carry over', async (t) => {
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
  assert.ok(existsSync(join(dir, stateBlobName('P'))), `snapshot file is at: ${readdirSync(join(dir, 'projects')).join(', ')}`);
  const snap = JSON.parse(readFileSync(join(dir, stateBlobName('P')), 'utf8'));
  assert.equal(snap.rev, 10, 'the snapshot written at the 10th submission');
  const logLines = readFileSync(join(dir, 'projects', 'P.ops.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(logLines.map((r) => r.rev), [11, 12], 'the log is truncated to after the snapshot');
  for (const r of logLines) for (const k of ['projectId', 'rev', 'opId', 'ops', 'actor', 'at', 'entities']) assert.ok(Object.hasOwn(r, k), `log line is missing ${k}`);
  await env.cleanup();

  const env2 = await start(t, { store: createFileStore({ dir, log: () => {} }), clock, options: { snapshotEvery: 5 } });
  const b = await env2.connect('user=bob&role=page');
  const after = await open(b);
  assert.equal(after.rev, 12);
  assert.equal(JSON.stringify(after.project), JSON.stringify(before.project), 'content is byte-for-byte identical');
  const dup = await ask(b, { type: 'project.op', projectId: 'P', opId: 'k-3', ops: [{ op: 'set', path: '/x', value: 1 }] });
  assert.deepEqual({ rev: dup.rev, duplicate: dup.duplicate }, { rev: 4, duplicate: true }, 'opIds from before the restart are still recognized (those in the snapshot)');
  const dup2 = await ask(b, { type: 'project.op', projectId: 'P', opId: 'k-11', ops: [{ op: 'set', path: '/x', value: 1 }] });
  assert.equal(dup2.rev, 12, 'opIds from before the restart are still recognized (those from log replay)');
  clock.t = T0 + 20_000;
  const w = await op(b, [{ op: 'set', path: '/tracks/@t1/clips/@c1/start', value: 100 }], { session: 'other' });
  assert.equal(w.rev, 13);
  assert.equal(w.overwrote.length, 1, 'the most recent writer is preserved across restarts');
});

// ------------------------------------------------------------------ DS-P9

test('DS-P9 relationship with the old announce: with no body, announce still issues rev numbers as before; once a body exists, announce issues none and the digest follows the body; the M5b snapshot of the current version is sent back from the body', async (t) => {
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
  assert.equal(ok.rev, 2, 'there is only one version number: it continues upward from the one issued by announce');
  const text = JSON.stringify(sample());
  const bodyDigest = createHash('sha256').update(text).digest('hex');
  const an2 = await ask(a, { type: 'project.announce', projectId: 'P', digest: dg });
  assert.deepEqual(
    { projectRev: an2.projectRev, changed: an2.changed, digest: an2.digest, authoritative: an2.authoritative, matches: an2.matches },
    { projectRev: 2, changed: false, digest: bodyDigest, authoritative: true, matches: false },
  );
  const an3 = await ask(a, { type: 'project.announce', projectId: 'P', digest: bodyDigest });
  assert.equal(an3.matches, true);
  assert.deepEqual(await b.quiet(byType('project.rev'), 100), [], 'once a body exists, announce does not broadcast project.rev');

  const reqId = 'snap-1';
  b.send({ type: 'project.snapshot.get', projectId: 'P', projectRev: 2, reqId });
  let got = '';
  for (;;) {
    const m = await b.next((x) => x.reqId === reqId);
    if (m.type === 'project.snapshot.end') { assert.equal(m.digest, bodyDigest); break; }
    assert.equal(m.missing, undefined, 'the current version can be fetched');
    got += m.data;
  }
  assert.equal(got, text);
  const st = await open(b);
  assert.deepEqual({ rev: st.rev, projectRev: st.projectRev, digest: st.digest }, { rev: 2, projectRev: 2, digest: bodyDigest });
});

// ------------------------------------------------------------------ DS-P10

test('DS-P10 large project: project.upload sends the whole thing in parts, and project.op references it to do a root replacement; other subscribers receive resync; open sends it back in parts, and joined together it is byte-for-byte identical', async (t) => {
  const env = await start(t);
  const a = await env.connect('user=alice&role=page');
  const b = await env.connect('user=bob&role=page');
  await open(a);
  await open(b);
  const big = sample();
  big.tracks[0].clips = Array.from({ length: 6000 }, (_, i) => ({ id: `c${i}`, start: i, end: i + 1, params: { text: `clip ${i} ${'z'.repeat(100)}` } }));
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
  assert.equal(reused.reason, 'bad-path', 'an upload is gone once used');

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

// ------------------------------------------------------------------ DS-P11 (V2)

/** Reproducible random numbers */
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

/**
 * Randomly generate a batch of edits based on local replica (may fail because someone else just
 * modified it, in which case it is rejected)
 */
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

test('DS-P11 (V2, server side) two pages each submit 200 random edits interleaved: the copies rebuilt by rev on both sides, the observer and the document service are byte-for-byte identical (all three)', async (t) => {
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
    assert.equal(m.rev, watch.rev + 1, 'the observer receives ops in consecutive rev order');
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
        assert.equal(m.rev, me.rev + 1, `ops received by ${name} are in consecutive rev order`);
        me.view = applyOps(me.view, m.ops).root;
        me.rev = m.rev;
      } else if (m.type === 'project.op.ok' && pending && m.opId === pending.opId) {
        assert.equal(m.rev, me.rev + 1, `the ok of ${name} comes after the ops before it`);
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
        assert.equal(r.reason, 'bad-path', `${name} can only fail because someone else just changed it: ${JSON.stringify(r)}`);
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
  assert.ok(x.accepted > 100 && y.accepted > 100, `most were applied: ${x.accepted}, ${y.accepted} (rejected ${x.rejected}, ${y.rejected})`);
  const s = JSON.stringify(server.project);
  assert.equal(JSON.stringify(x.view), s, 'the copy of ann is byte-for-byte identical to the document service');
  assert.equal(JSON.stringify(y.view), s, 'the copy of ben is byte-for-byte identical to the document service');
  assert.equal(JSON.stringify(watch.view), s, 'the copy of the observer is byte-for-byte identical to the document service');
  const switches = watch.order.slice(1).filter((who, i) => who !== watch.order[i]).length;
  assert.ok(switches >= 50, `the submissions of both sides really were interleaved (adjacent submissions switched sides ${switches} times)`);
  t.diagnostic(`interleaved ${switches} times; rev ${finalRev}; ann applied ${x.accepted} rejected ${x.rejected}; ben applied ${y.accepted} rejected ${y.rejected}`);
});

// ------------------------------------------------------------------ DS-P12

test('DS-P12 the actor in the log and broadcasts comes from principal (M6a shape + session), and a self-reported one in a message is ignored; old-style identities are recorded as { userId, session } per M5', async (t) => {
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
