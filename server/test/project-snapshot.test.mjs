/**
 * Project snapshots (contract `docs/plan/render-queue-contract.md` J.1, J.2; J.7 test cases J1–J4).
 * Run: node --test server/test/project-snapshot.test.mjs
 *
 * Written strictly against contract, without looking at implementation.
 *
 * Conventions:
 *   - Real document service: standalone mode, port 0, `autoTick: false`, mounts C6.3 project module
 *     `projectModule({ store, now })`;
 *     storage uses memory, or file storage in a temporary directory (J3 restart).
 *   - Wire protocol follows J.1:
 *       `project.snapshot.put { projectId, projectRev, digest, index, count, data }`
 *         → `project.snapshot.stored { projectId, projectRev, received, count, complete }` or `error { reason }`;
 *       `project.snapshot.get { projectId, projectRev }`
 *         → multiple `project.snapshot.part { …, index, count, data }` (ascending index),
 *           finally `project.snapshot.end { …, digest }`;
 *         returns `project.snapshot.part { …, missing: true }` when this snapshot does not exist.
 *     Responses include request `reqId`, test receives by `reqId`.
 *   - digest = SHA-256 hex of the full project JSON; version registered via `project.announce` first (C6.3 Section 1).
 *   - Client `createProjectClient(endpoint, { timeoutMs })` (J.2), endpoint uses M5a `createWsEndpoint`.
 *     "Server does not reply" uses a mock module swallowing `project.*`, or a mock endpoint only
 *     recording outgoing messages.
 *
 * When the module under test (snapshot part of project module, `project-client.mjs`) does not exist yet,
 * each test case fails individually and reports the reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadStore, loadProject, tempDir, startStandalone, ask } from './fake-docservice-env.mjs';
import { connectEndpoint, until } from './fake-manifest-env.mjs';

const T0 = 1_700_000_000_000;
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const CHUNK_MAX = 512 * 1024;

/** Start a document service that only mounts the project module */
async function start({ store, dir } = {}) {
  const { createMemoryStore, createFileStore } = await loadStore();
  const makeProject = await loadProject();
  const s = store ?? (dir ? createFileStore({ dir }) : createMemoryStore());
  const now = () => T0;
  const env = await startStandalone({ modules: [makeProject({ store: s, now })], now });
  return { ...env, store: s };
}

/** Project JSON text snippet (`size` approx char count; `seed` varies content) */
function projectText(seed, size = 2000, { cjk = false } = {}) {
  const filler = cjk ? '字幕轨道卡片'.repeat(Math.ceil(size / 6)).slice(0, size) : 'x'.repeat(size);
  return JSON.stringify({ id: `proj-${seed}`, seed, fps: 30, width: 1920, height: 1080, tracks: [{ id: 't1', clips: [] }], note: filler });
}

/** Split into n chunks by character (BMP characters only, will not split surrogate pairs) */
function chunksOf(text, n) {
  const size = Math.ceil(text.length / n);
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

let seq = 0;
const put = (c, fields) => ask(c, { type: 'project.snapshot.put', ...fields });

/** Send get, receive all responses by reqId: part…end, or a missing; returns { parts, end, missing, replies } */
async function getSnapshot(c, projectId, projectRev, ms = 5000) {
  const reqId = `get-${++seq}`;
  c.send({ type: 'project.snapshot.get', projectId, projectRev, reqId });
  const replies = [];
  for (;;) {
    const m = await c.next((x) => x?.reqId === reqId, ms);
    replies.push(m);
    if (m.type === 'project.snapshot.part' && m.missing === true) return { parts: [], end: null, missing: true, replies };
    if (m.type === 'project.snapshot.end') {
      return { parts: replies.filter((r) => r.type === 'project.snapshot.part'), end: m, missing: false, replies };
    }
    if (m.type === 'error') return { parts: [], end: null, missing: false, error: m, replies };
    assert.equal(m.type, 'project.snapshot.part', `the reply to get can only be part / end: ${JSON.stringify(m).slice(0, 300)}`);
  }
}

/** Assemble chunks from get, and check J.1 shape along the way */
function assemble(got, projectId, projectRev) {
  assert.equal(got.missing, false, 'get finds it');
  assert.ok(got.end, 'the last one is project.snapshot.end');
  const { parts, end } = got;
  assert.ok(parts.length >= 1, 'at least one part');
  parts.forEach((p, i) => {
    assert.equal(p.index, i, `parts are in ascending index order, start at 0 and are contiguous: entry ${i} has index ${p.index}`);
    assert.equal(p.count, parts.length, `each part's count equals the number of parts: ${p.count} / ${parts.length}`);
    assert.equal(p.projectId, projectId);
    assert.equal(p.projectRev, projectRev);
    assert.equal(typeof p.data, 'string');
  });
  assert.equal(end.projectId, projectId);
  assert.equal(end.projectRev, projectRev);
  const text = parts.map((p) => p.data).join('');
  assert.equal(end.digest, sha256(text), 'end.digest is the sha256 of the full text');
  assert.ok(got.replies.indexOf(end) === got.replies.length - 1, 'end comes last');
  return text;
}

/** announce the digest of this text, returns projectRev */
async function announce(c, projectId, text) {
  const ack = await ask(c, { type: 'project.announce', projectId, digest: sha256(text) });
  assert.equal(ack.type, 'project.announced', `announce succeeded: ${JSON.stringify(ack)}`);
  return ack.projectRev;
}

/** Upload chunks in given order (`order` is index list, may repeat); returns each response */
async function upload(c, projectId, projectRev, text, chunks, order = chunks.map((_, i) => i), digest = sha256(text)) {
  const replies = [];
  for (const index of order) {
    replies.push(await put(c, { projectId, projectRev, digest, index, count: chunks.length, data: chunks[index] }));
  }
  return replies;
}

/* ------------------------------------------------------------------ J1 */

test('J1 after upload in parts, get receives all parts and end in order, and joined together they are byte-for-byte identical to the original; replies carry reqId', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const text = projectText('j1', 6000, { cjk: true });
  const rev = await announce(c, 'proj-j1', text);
  assert.equal(rev, 1);
  const chunks = chunksOf(text, 3);
  const replies = await upload(c, 'proj-j1', rev, text, chunks);
  replies.forEach((r, i) => {
    assert.equal(r.type, 'project.snapshot.stored', `part ${i} responds stored: ${JSON.stringify(r)}`);
    assert.deepEqual(
      { projectId: r.projectId, projectRev: r.projectRev, received: r.received, count: r.count, complete: r.complete },
      { projectId: 'proj-j1', projectRev: 1, received: i + 1, count: 3, complete: i === 2 },
      `reply to part ${i}`,
    );
  });

  const got = await getSnapshot(c, 'proj-j1', 1);
  const back = assemble(got, 'proj-j1', 1);
  assert.equal(Buffer.compare(Buffer.from(back, 'utf8'), Buffer.from(text, 'utf8')), 0, 'joined together, byte-for-byte identical to the original');
  assert.ok(got.replies.every((m) => typeof m.reqId === 'string'), 'every reply to get carries reqId');

  // Also retrievable from another connection (another node)
  const d = await env.connect('bob');
  assert.equal(assemble(await getSnapshot(d, 'proj-j1', 1), 'proj-j1', 1), text);
});

test('J1 out-of-order upload and re-upload of the same part: the result is the same as an in-order upload; before all parts have arrived get responds missing', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const text = projectText('j1-shuffle', 9000);
  const rev = await announce(c, 'proj-j1b', text);
  const chunks = chunksOf(text, 4);

  const first = await upload(c, 'proj-j1b', rev, text, chunks, [2, 0]);
  assert.ok(first.every((r) => r.type === 'project.snapshot.stored' && r.complete === false), `not all parts have arrived: ${JSON.stringify(first)}`);
  assert.deepEqual(first.map((r) => r.received), [1, 2]);
  assert.equal((await getSnapshot(c, 'proj-j1b', rev)).missing, true, 'this snapshot does not exist before all parts have arrived');

  const dup = await put(c, { projectId: 'proj-j1b', projectRev: rev, digest: sha256(text), index: 2, count: 4, data: chunks[2] });
  assert.equal(dup.type, 'project.snapshot.stored', `re-uploading the same part still responds stored: ${JSON.stringify(dup)}`);
  assert.equal(dup.received, 2, 're-upload is not counted twice');
  assert.equal(dup.complete, false);

  const rest = await upload(c, 'proj-j1b', rev, text, chunks, [3, 1]);
  assert.deepEqual(rest.map((r) => [r.received, r.complete]), [[3, false], [4, true]]);
  assert.equal(assemble(await getSnapshot(c, 'proj-j1b', rev), 'proj-j1b', rev), text, 'the text assembled after out-of-order upload and re-upload is the same as the original');

  // Next version of the same project: each version stores one copy, without overwriting each other
  const text2 = projectText('j1-shuffle-v2', 3000);
  const rev2 = await announce(c, 'proj-j1b', text2);
  assert.equal(rev2, rev + 1);
  await upload(c, 'proj-j1b', rev2, text2, chunksOf(text2, 2), [1, 1, 0]);
  assert.equal(assemble(await getSnapshot(c, 'proj-j1b', rev2), 'proj-j1b', rev2), text2);
  assert.equal(assemble(await getSnapshot(c, 'proj-j1b', rev), 'proj-j1b', rev), text, 'the previous version\'s snapshot is still there (snapshots are immutable)');
});

test('J1 large snapshot (about 1.5 MiB, each part ≤ 512 KiB): get sends it back in several parts, joined together they are identical, and the connection is not closed by backpressure', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const text = projectText('j1-big', Math.floor(1.5 * 1024 * 1024));
  const rev = await announce(c, 'proj-big', text);
  const chunks = chunksOf(text, 4);
  assert.ok(chunks.every((s) => Buffer.byteLength(s, 'utf8') <= CHUNK_MAX), 'fixture: each part ≤ 512 KiB');
  const replies = await upload(c, 'proj-big', rev, text, chunks);
  assert.equal(replies.at(-1).complete, true, `all parts received: ${JSON.stringify(replies.at(-1))}`);

  const closedEarly = { v: false };
  const whenClosed = c.closed.then((e) => { closedEarly.v = true; throw new Error(`connection closed while fetching the snapshot: ${e?.code}/${e?.reason} (the outbound backpressure limit is 1 MiB, H.2)`); });
  whenClosed.catch(() => {});
  const got = await Promise.race([getSnapshot(c, 'proj-big', rev, 8_000), whenClosed]);
  const back = assemble(got, 'proj-big', rev);
  assert.equal(back.length, text.length);
  assert.equal(back, text, 'joined together, identical to the original');
  for (const p of got.parts) assert.ok(Buffer.byteLength(p.data, 'utf8') <= CHUNK_MAX, `each part from get is also ≤ 512 KiB: ${Buffer.byteLength(p.data, 'utf8')}`);
  assert.equal(closedEarly.v, false, 'the connection was not closed while fetching a large snapshot (contract J.1 allows up to 32 MiB in total)');
});

/* ------------------------------------------------------------------ J2 */

test('J2 a digest mismatch responds digest-mismatch and all parts received so far are discarded; afterwards, re-uploading with the correct content can complete', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const text = projectText('j2', 5000);
  const rev = await announce(c, 'proj-j2', text);
  const chunks = chunksOf(text, 3);

  // 1. Data was modified: full-text sha256 does not match digest
  const tampered = [...chunks];
  tampered[1] = tampered[1].replace(/x/, 'y');
  const r1 = await upload(c, 'proj-j2', rev, text, tampered);
  assert.deepEqual(r1.slice(0, 2).map((r) => r.type), ['project.snapshot.stored', 'project.snapshot.stored']);
  assert.equal(r1[2].type, 'error', `a failed check after all parts are received responds error: ${JSON.stringify(r1[2])}`);
  assert.equal(r1[2].reason, 'digest-mismatch');
  assert.equal((await getSnapshot(c, 'proj-j2', rev)).missing, true, 'snapshots that fail validation are not kept');

  // All received chunks are discarded: re-upload counts from received 1
  const again = await put(c, { projectId: 'proj-j2', projectRev: rev, digest: sha256(text), index: 0, count: 3, data: chunks[0] });
  assert.equal(again.type, 'project.snapshot.stored');
  assert.equal(again.received, 1, `earlier parts were discarded: ${JSON.stringify(again)}`);
  const rest = await upload(c, 'proj-j2', rev, text, chunks, [1, 2]);
  assert.equal(rest.at(-1).complete, true);
  assert.equal(assemble(await getSnapshot(c, 'proj-j2', rev), 'proj-j2', rev), text);

  // 2. Data matches self-reported digest, but digest is not the one registered by announce for this version
  const other = projectText('j2-other', 4000);
  const rev2 = await announce(c, 'proj-j2b', text);
  const r2 = await upload(c, 'proj-j2b', rev2, other, chunksOf(other, 2));
  // Contract only specifies "validate after receiving all"; implementation may also reject on first chunk.
  // Both are accepted, but must report digest-mismatch and must not complete reception
  const errors = r2.filter((r) => r.type === 'error');
  assert.ok(errors.length >= 1, `digest differs from the digest registered by announce: must respond error: ${JSON.stringify(r2)}`);
  assert.ok(errors.every((e) => e.reason === 'digest-mismatch'), JSON.stringify(errors));
  assert.ok(!r2.some((r) => r.complete === true), 'must not complete');
  assert.equal((await getSnapshot(c, 'proj-j2b', rev2)).missing, true);
});

test('J2 a version that was never announced responds unknown-rev (a nonexistent project, a version newer than the current one)', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const text = projectText('j2-rev', 1000);
  const r0 = await put(c, { projectId: 'never-announced', projectRev: 1, digest: sha256(text), index: 0, count: 1, data: text });
  assert.equal(r0.type, 'error', JSON.stringify(r0));
  assert.equal(r0.reason, 'unknown-rev');

  const rev = await announce(c, 'proj-j2c', text);
  const r1 = await put(c, { projectId: 'proj-j2c', projectRev: rev + 1, digest: sha256(text), index: 0, count: 1, data: text });
  assert.equal(r1.type, 'error', JSON.stringify(r1));
  assert.equal(r1.reason, 'unknown-rev');
  // The registered version behaves as usual
  const ok = await put(c, { projectId: 'proj-j2c', projectRev: rev, digest: sha256(text), index: 0, count: 1, data: text });
  assert.deepEqual([ok.type, ok.complete], ['project.snapshot.stored', true]);
});

/* ------------------------------------------------------------------ J3 */

test('J3 file storage: after the service is shut down and recreated in the same directory, snapshots can still be fetched; fetching a nonexistent version responds missing; no leftover temporary files', async (t) => {
  const dir = tempDir(t, 'pc-m5b-snap-');
  const env1 = await start({ dir });
  t.after(env1.cleanup);
  const a = await env1.connect('alice');
  const text = projectText('j3', 7000, { cjk: true });
  const rev = await announce(a, 'scene:j3', text);
  const replies = await upload(a, 'scene:j3', rev, text, chunksOf(text, 3), [1, 0, 2]);
  assert.equal(replies.at(-1).complete, true);
  const text2 = projectText('j3-v2', 500);
  const rev2 = await announce(a, 'scene:j3', text2);
  await upload(a, 'scene:j3', rev2, text2, [text2]);
  await env1.cleanup();

  const env2 = await start({ dir });
  t.after(env2.cleanup);
  const b = await env2.connect('bob');
  assert.equal(assemble(await getSnapshot(b, 'scene:j3', rev), 'scene:j3', rev), text, 'the first version is still there after the restart');
  assert.equal(assemble(await getSnapshot(b, 'scene:j3', rev2), 'scene:j3', rev2), text2, 'the second version is still there after the restart');

  const miss = await getSnapshot(b, 'scene:j3', rev2 + 5);
  assert.equal(miss.missing, true, 'fetching a nonexistent version responds missing');
  const m = miss.replies[0];
  assert.deepEqual({ type: m.type, projectId: m.projectId, projectRev: m.projectRev, missing: m.missing },
    { type: 'project.snapshot.part', projectId: 'scene:j3', projectRev: rev2 + 5, missing: true });
  assert.equal((await getSnapshot(b, 'no-such-project', 1)).missing, true, 'a nonexistent project also responds missing');

  const files = readdirSync(join(dir, 'projects'));
  assert.ok(files.some((f) => f.endsWith('.json')), `snapshot files land under <dir>/projects/ with the extension .json: ${JSON.stringify(files)}`);
  assert.ok(files.every((f) => f.endsWith('.json') || f.endsWith('.ndjson')), `no leftover temporary files (writes go through a temporary file plus rename): ${JSON.stringify(files)}`);
});

test('J3 storage layer: both the memory and the file store have writeBlob / readBlob, read back the original text, and return null for anything never written', async (t) => {
  const { createMemoryStore, createFileStore } = await loadStore();
  const dir = tempDir(t, 'pc-m5b-blob-');
  const text = projectText('blob', 3000, { cjk: true });
  for (const [name, store] of [['memory', createMemoryStore()], ['file', createFileStore({ dir })]]) {
    assert.equal(typeof store.writeBlob, 'function', `${name}: has writeBlob`);
    assert.equal(typeof store.readBlob, 'function', `${name}: has readBlob`);
    assert.equal(await store.readBlob('projects/p@1'), null, `${name}: returns null for anything never written`);
    await store.writeBlob('projects/p@1', text);
    assert.equal(await store.readBlob('projects/p@1'), text, `${name}: reads back the original text`);
    await store.writeBlob('projects/p@1', `${text}!`);
    assert.equal(await store.readBlob('projects/p@1'), `${text}!`, `${name}: writing again overwrites`);
    assert.equal(await store.readBlob('projects/p@2'), null, `${name}: different names do not interfere with each other`);
  }
});

/* ------------------------------------------------------------------ J4 */

let clientMod = null, clientErr = null;
async function loadProjectClient() {
  if (!clientMod && !clientErr) {
    try { clientMod = await import('../render-node/project-client.mjs'); } catch (err) { clientErr = err; }
  }
  if (clientErr) throw new Error(`cannot load server/render-node/project-client.mjs: ${clientErr.message}`);
  assert.equal(typeof clientMod.createProjectClient, 'function', `project-client.mjs must export createProjectClient; exports: ${Object.keys(clientMod).join(', ')}`);
  return clientMod;
}

/** Start service, connect endpoint, create client */
async function clientRig(t, { modules, timeoutMs } = {}) {
  const { createProjectClient } = await loadProjectClient();
  let env;
  if (modules) env = await startStandalone({ modules });
  else env = await start();
  const endpoints = new Set();
  t.after(async () => { for (const ep of endpoints) { try { ep.close(); } catch { /* Closed */ } } await env.cleanup(); });
  const url = `ws://127.0.0.1:${env.port}/?user=node-a`;
  const endpoint = await connectEndpoint(url, { env: { endpoints } });
  const sent = [];
  const send = endpoint.send.bind(endpoint);
  const wrapped = {
    send: (m) => { sent.push(m); return send(m); },
    onMessage: endpoint.onMessage, onOpen: endpoint.onOpen, onClose: endpoint.onClose, close: endpoint.close, stats: endpoint.stats,
    get connected() { return endpoint.connected; }, get closed() { return endpoint.closed; },
  };
  const client = createProjectClient(wrapped, timeoutMs === undefined ? undefined : { timeoutMs });
  return { env, endpoint, client, sent };
}

async function settleOf(promise) {
  const t0 = Date.now();
  try { return { ok: true, value: await promise, ms: Date.now() - t0 }; } catch (error) { return { ok: false, error, ms: Date.now() - t0 }; }
}

test('J4 createProjectClient: announce, putSnapshot, get round trip; large text is split into parts automatically (each part ≤ 512 KiB); get returns null for a version that does not exist; re-exported from index.mjs', async (t) => {
  const { client, sent } = await clientRig(t);
  const project = { id: 'proj-j4', fps: 30, tracks: [{ id: 't', clips: [{ id: 'c1', start: 0, end: 1 }] }], big: 'z'.repeat(1_200_000), cjk: '中文项目' };
  const text = JSON.stringify(project);
  const digest = sha256(text);

  const a1 = await client.announce('proj-j4', digest, 'tab-1');
  assert.deepEqual({ projectRev: a1.projectRev, changed: a1.changed }, { projectRev: 1, changed: true });
  const a2 = await client.announce('proj-j4', digest);
  assert.deepEqual({ projectRev: a2.projectRev, changed: a2.changed }, { projectRev: 1, changed: false }, 'the same digest does not add a version');

  await client.putSnapshot('proj-j4', 1, digest, text);
  const puts = sent.filter((m) => m.type === 'project.snapshot.put');
  assert.ok(puts.length >= 3, `1.2 MB of text is split into at least 3 parts: ${puts.length}`);
  assert.ok(puts.length <= 64, 'count ≤ 64');
  for (const m of puts) {
    assert.ok(Buffer.byteLength(m.data, 'utf8') <= CHUNK_MAX, `each part ≤ 512 KiB: ${Buffer.byteLength(m.data, 'utf8')}`);
    assert.equal(m.count, puts.length);
    assert.equal(m.digest, digest);
    assert.equal(m.projectRev, 1);
  }
  assert.deepEqual(puts.map((m) => m.index).sort((x, y) => x - y), puts.map((_, i) => i), 'one part for each index 0..count-1');

  const back = await client.get('proj-j4', 1);
  assert.deepEqual(back, project, 'after get assembles, verifies and runs JSON.parse, the result equals the original object');
  assert.equal(await client.get('proj-j4', 2), null, 'a version that does not exist returns null');
  assert.equal(await client.get('no-such', 1), null, 'a project that does not exist returns null');

  const reqIds = sent.map((m) => m.reqId);
  assert.ok(reqIds.every((id) => typeof id === 'string' && id.length > 0), 'every request carries a string reqId');
  assert.equal(new Set(reqIds).size, reqIds.length, 'reqIds are all different');
  assert.ok(reqIds.every((id) => !id.startsWith('content#')), `reqId carries its own prefix, different from the content store client's: ${reqIds[0]}`);

  const idx = await import('../render-node/index.mjs');
  assert.equal(idx.createProjectClient, (await loadProjectClient()).createProjectClient, 'render-node/index.mjs re-exports createProjectClient');
});

test('J4 two concurrent snapshots do not get mixed up: two projects announce, putSnapshot and get at the same time, and each gets back its own', async (t) => {
  const { client } = await clientRig(t);
  const make = (seed) => ({ id: `proj-${seed}`, seed, pad: `${seed}-`.repeat(5_000) });
  const projects = [make('left'), make('right')];
  const texts = projects.map((p) => JSON.stringify(p));
  const revs = await Promise.all(projects.map((p, i) => client.announce(p.id, sha256(texts[i]))));
  await Promise.all(projects.map((p, i) => client.putSnapshot(p.id, revs[i].projectRev, sha256(texts[i]), texts[i])));
  const [l, r] = await Promise.all(projects.map((p, i) => client.get(p.id, revs[i].projectRev)));
  assert.deepEqual(l, projects[0]);
  assert.deepEqual(r, projects[1]);
  // Two concurrent versions of the same project
  const v2 = { ...projects[0], seed: 'left-v2' };
  const t2 = JSON.stringify(v2);
  const rev2 = (await client.announce(v2.id, sha256(t2))).projectRev;
  await client.putSnapshot(v2.id, rev2, sha256(t2), t2);
  const [old, cur] = await Promise.all([client.get(v2.id, revs[0].projectRev), client.get(v2.id, rev2)]);
  assert.deepEqual(old, projects[0]);
  assert.deepEqual(cur, v2);
});

test('J4 putSnapshot rejected by the server (digest mismatch): throws, and the error carries a reason', async (t) => {
  const { client } = await clientRig(t);
  const text = JSON.stringify({ id: 'p', v: 1 });
  const { projectRev } = await client.announce('proj-j4-bad', sha256(text));
  const other = JSON.stringify({ id: 'p', v: 2 });
  const r = await settleOf(client.putSnapshot('proj-j4-bad', projectRev, sha256(other), other));
  assert.equal(r.ok, false, 'digest does not match the one registered by announce: fails');
  assert.equal(r.error.reason, 'digest-mismatch', `Error carries reason: ${r.error?.message}`);
  const u = await settleOf(client.putSnapshot('proj-j4-bad', projectRev + 3, sha256(text), text));
  assert.equal(u.ok, false);
  assert.equal(u.error.reason, 'unknown-rev');
});

/** Module swallowing project.*: does not reply to anything received */
const silentProject = () => ({ name: 'silent-project', types: ['project.'], channels: [], handle() {} });

test('J4 the server does not reply: a timeout throws code: timeout (for announce, putSnapshot and get alike)', async (t) => {
  const { client } = await clientRig(t, { modules: [silentProject()], timeoutMs: 300 });
  for (const [what, call] of [
    ['announce', () => client.announce('p', sha256('x'))],
    ['putSnapshot', () => client.putSnapshot('p', 1, sha256('x'), 'x')],
    ['get', () => client.get('p', 1)],
  ]) {
    const r = await settleOf(call());
    assert.equal(r.ok, false, `${what}: fails if no reply comes`);
    assert.equal(r.error.code, 'timeout', `${what}: code is timeout: ${r.error?.message}`);
    assert.ok(r.ms >= 250 && r.ms < 5000, `${what}: timed by timeoutMs: ${r.ms} ms`);
  }
});

test('J4 disconnect: in-flight requests fail immediately with code: disconnected without waiting for the timeout; nothing is replayed after reconnecting', async (t) => {
  const { env, endpoint, client, sent } = await clientRig(t, { modules: [silentProject()], timeoutMs: 20_000 });
  const inflight = [client.announce('p', sha256('y')), client.get('p', 1), client.putSnapshot('p', 1, sha256('y'), 'y')].map(settleOf);
  await until(() => sent.length >= 3, { timeoutMs: 2000 });
  const closedSeen = new Promise((resolve) => endpoint.onClose(resolve));
  await env.service.close();
  await closedSeen;
  const t0 = Date.now();
  const results = await Promise.all(inflight);
  assert.ok(Date.now() - t0 < 3000, 'fails immediately after the disconnect, without waiting 20 s');
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'disconnected', `code is disconnected: ${r.error?.message}`);
  }
  const before = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(sent.length, before, 'not replayed after the disconnect');
});

/** Mock endpoint: only records outgoing messages; test decides what to return */
function fakeEndpoint() {
  const handlers = { message: [], open: [], close: [] };
  const sent = [];
  return {
    sent,
    send(m) { sent.push(JSON.parse(JSON.stringify(m))); return true; },
    onMessage(h) { handlers.message.push(h); },
    onOpen(h) { handlers.open.push(h); },
    onClose(h) { handlers.close.push(h); },
    close() {},
    connected: true,
    closed: false,
    stats: () => ({}),
    deliver(m) { for (const h of [...handlers.message]) h(JSON.parse(JSON.stringify(m))); },
  };
}

test('J4 get verifies the digest: rejects when the full text assembled from the parts does not match end.digest; when replies arrive out of order with messages for other reqIds mixed in, they are paired by reqId', async () => {
  const { createProjectClient } = await loadProjectClient();
  const ep = fakeEndpoint();
  const client = createProjectClient(ep, { timeoutMs: 3000 });
  const good = { id: 'g', n: 1 };
  const goodText = JSON.stringify(good);

  const pBad = settleOf(client.get('bad', 1));
  const pGood = client.get('good', 1);
  await until(() => ep.sent.length === 2, { timeoutMs: 2000 });
  const [reqBad, reqGood] = ep.sent;
  assert.notEqual(reqBad.reqId, reqGood.reqId);
  // Unrelated message
  ep.deliver({ type: 'project.snapshot.part', projectId: 'good', projectRev: 1, index: 0, count: 1, data: '{"wrong":true}', reqId: 'not-mine' });
  ep.deliver({ type: 'project.rev', projectId: 'good', projectRev: 2 });
  // Interleaving good chunks and bad chunks
  const half = Math.ceil(goodText.length / 2);
  ep.deliver({ type: 'project.snapshot.part', projectId: 'good', projectRev: 1, index: 0, count: 2, data: goodText.slice(0, half), reqId: reqGood.reqId });
  ep.deliver({ type: 'project.snapshot.part', projectId: 'bad', projectRev: 1, index: 0, count: 1, data: '{"a":1}', reqId: reqBad.reqId });
  ep.deliver({ type: 'project.snapshot.part', projectId: 'good', projectRev: 1, index: 1, count: 2, data: goodText.slice(half), reqId: reqGood.reqId });
  ep.deliver({ type: 'project.snapshot.end', projectId: 'bad', projectRev: 1, digest: sha256('{"a":2}'), reqId: reqBad.reqId });
  ep.deliver({ type: 'project.snapshot.end', projectId: 'good', projectRev: 1, digest: sha256(goodText), reqId: reqGood.reqId });

  assert.deepEqual(await pGood, good, 'assembles its own snapshot by reqId');
  const bad = await pBad;
  assert.equal(bad.ok, false, 'digest mismatch: rejected, no wrong content is returned');
});
