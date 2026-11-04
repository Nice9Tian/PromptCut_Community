/**
 * Content store module (contract `docs/plan/docservice-contract.md` sections 2 and 3, test
 * cases N1-N8).
 * Run: node --test server/test/docservice-content.test.mjs
 *
 * Written strictly against the contract, ignoring implementation. Module under test is loaded via
 * dynamic import; each test case fails individually if module is missing.
 * `createDocService` standalone mode, port 0, `autoTick: false`; storage uses memory or temporary
 * directory.
 * principal is provided by test `authenticate` via query string `?user=` (see
 * `fake-docservice-env.mjs`).
 * The contract does not require responses from this module to include `reqId`; tests wait by
 * response type (sequential request-response on the same connection).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { byType } from './fake-ws-kit.mjs';
import { loadStore, loadContent, tempDir, startStandalone, untilType } from './fake-docservice-env.mjs';

const T0 = 1_700_000_000_000;
const KINDS = ['card-source', 'snapshot-manifest', 'render-manifest', 'event-detail'];
const sha = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

async function start({ store, clock = { t: T0 }, ...moduleOptions } = {}) {
  const { createMemoryStore } = await loadStore();
  const makeContent = await loadContent();
  const s = store ?? createMemoryStore();
  const now = () => clock.t;
  const env = await startStandalone({ modules: [makeContent({ store: s, now, ...moduleOptions })], now });
  return { ...env, store: s, clock };
}

let reqSeq = 0;
/** Send request with reqId, wait by response type (avoids timing out if reqId is not returned), then assert reqId is returned as is (contract section 10 item 6) */
async function call(c, message, replyType) {
  const reqId = `n-${++reqSeq}`;
  c.send({ ...message, reqId });
  const reply = await untilType(c, [replyType, 'error']);
  assert.equal(reply.reqId, reqId, `the reply must carry the reqId of the request: ${JSON.stringify(reply).slice(0, 200)}`);
  return reply;
}
const put = (c, kind, key, body, extra = {}) => call(c, { type: 'content.put', kind, key, body, ...extra }, 'content.stored');
const get = (c, kind, key) => call(c, { type: 'content.get', kind, key }, 'content.item');
const list = (c, kind, prefix) => call(c, { type: 'content.list', kind, ...(prefix === undefined ? {} : { prefix }) }, 'content.listing');
const watch = (c, kinds) => call(c, { type: 'content.watch', kinds }, 'content.watching');
const changes = (c, ms = 150) => c.quiet(byType('content.changed'), ms);

// ------------------------------------------------------------------ N1

test('N1 get after put returns the same body, hash = sha256(JSON.stringify(body)); the module name appears in /healthz', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const bodies = [
    { title: 'Title', layers: [{ id: 1, x: 0.5 }, { id: 2, nested: { deep: [true, false, null] } }] },
    'A piece of plain text',
    12345.5,
    [1, 'two', { three: 3 }],
    true,
    null,
  ];
  let i = 0;
  for (const body of bodies) {
    const key = `scene/${++i}.json`;
    const stored = await put(c, 'snapshot-manifest', key, body);
    assert.deepEqual(
      { type: stored.type, kind: stored.kind, key: stored.key, hash: stored.hash },
      { type: 'content.stored', kind: 'snapshot-manifest', key, hash: sha(body) },
      `put ${JSON.stringify(body)}`,
    );
    const item = await get(c, 'snapshot-manifest', key);
    assert.deepEqual(
      { type: item.type, kind: item.kind, key: item.key, body: item.body, hash: item.hash, missing: item.missing },
      { type: 'content.item', kind: 'snapshot-manifest', key, body, hash: sha(body), missing: undefined },
      `get ${key}`,
    );
  }
  // Kinds do not cross-contaminate: same key does not exist under other kinds
  assert.equal((await get(c, 'render-manifest', 'scene/1.json')).missing, true);
  const h = await env.health();
  assert.ok(Array.isArray(h.modules) && h.modules.includes('content'), `/healthz.modules must include content: ${JSON.stringify(h.modules)}`);

  // Contract section 10 item 5: does not add fields to /healthz, only provides describe()
  const bare = await startStandalone({ modules: [] });
  t.after(bare.cleanup);
  assert.deepEqual(Object.keys(h).sort(), Object.keys(await bare.health()).sort(), 'the /healthz field set is unchanged after mounting the content store module');
  const d = env.service.describe();
  assert.ok(Object.hasOwn(d.modules, 'content'), 'describe().modules contains content');
  assert.notEqual(d.modules.content, null, 'the content store module provides describe()');
});

// ------------------------------------------------------------------ N2

test('N2 putting the same card-source key three times in a row: rev is 1, 2, 3, incrementing even when the content is identical; other kinds have no rev', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const body = { code: 'export default () => null' };
  const revs = [];
  for (let i = 0; i < 3; i++) revs.push((await put(c, 'card-source', 'cards/title', body)).rev);
  assert.deepEqual(revs, [1, 2, 3], 'increments even when the content is identical');
  assert.equal((await put(c, 'card-source', 'cards/other', body)).rev, 1, 'rev starts from 1 separately for each key');

  const item = await get(c, 'card-source', 'cards/title');
  assert.equal(item.rev, 3, 'get carries the current rev');
  const listing = await list(c, 'card-source');
  assert.deepEqual(listing.items.map((x) => [x.key, x.rev]), [['cards/other', 1], ['cards/title', 3]], 'list carries rev');

  for (const kind of KINDS.filter((k) => k !== 'card-source')) {
    for (let i = 0; i < 2; i++) {
      const stored = await put(c, kind, 'k', { i });
      assert.equal(stored.type, 'content.stored');
      assert.ok(!('rev' in stored) || stored.rev === undefined, `content.stored of ${kind} has no rev: ${JSON.stringify(stored)}`);
    }
    const it = await get(c, kind, 'k');
    assert.ok(!('rev' in it), `content.item of ${kind} has no rev: ${JSON.stringify(it)}`);
    assert.deepEqual(it.body, { i: 1 }, 'the later write wins');
    const ls = await list(c, kind);
    assert.ok(ls.items.every((x) => !('rev' in x)), `listing items of ${kind} have no rev: ${JSON.stringify(ls.items)}`);
  }
});

// ------------------------------------------------------------------ N3

test('N3 list filters by prefix and sorts by key ascending; exactly 1000 items gives truncated: false, more than 1000 gives truncated: true', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  for (const key of ['b/2', 'a/2', 'a/10', 'a/1', 'c', 'ab']) await put(c, 'event-detail', key, { key });
  await put(c, 'render-manifest', 'a/9', {}); // Other kinds do not appear

  const all = await list(c, 'event-detail');
  assert.deepEqual(all.items.map((x) => x.key), ['a/1', 'a/10', 'a/2', 'ab', 'b/2', 'c'], 'ascending by key (string comparison)');
  assert.equal(all.truncated, false);
  assert.deepEqual(all.kind, 'event-detail');
  assert.equal(all.items[0].hash, sha({ key: 'a/1' }), 'each item carries hash');
  const a = await list(c, 'event-detail', 'a/');
  assert.deepEqual(a.items.map((x) => x.key), ['a/1', 'a/10', 'a/2']);
  assert.deepEqual((await list(c, 'event-detail', 'a')).items.map((x) => x.key), ['a/1', 'a/10', 'a/2', 'ab']);
  assert.deepEqual((await list(c, 'event-detail', 'zzz')).items, []);

  // 1,000-item boundary: send pipelined, receive one by one
  const keys = Array.from({ length: 1001 }, (_, i) => `bulk/${String(i).padStart(4, '0')}`);
  for (const key of keys.slice(0, 1000)) c.send({ type: 'content.put', kind: 'snapshot-manifest', key, body: 1 });
  for (let i = 0; i < 1000; i++) assert.equal((await untilType(c, ['content.stored', 'error'], 5000)).type, 'content.stored');
  const exact = await list(c, 'snapshot-manifest');
  assert.equal(exact.items.length, 1000);
  assert.equal(exact.truncated, false, 'exactly 1000 items does not count as truncated');

  await put(c, 'snapshot-manifest', keys[1000], 1);
  const over = await list(c, 'snapshot-manifest');
  assert.equal(over.items.length, 1000, 'at most 1000 items');
  assert.equal(over.truncated, true);
  assert.deepEqual(over.items.map((x) => x.key), keys.slice(0, 1000), 'when truncated, the first 1000 items in ascending order are returned');
  const filtered = await list(c, 'snapshot-manifest', 'bulk/100');
  assert.deepEqual(filtered.items.map((x) => x.key), ['bulk/1000'], 'filter by prefix first, then truncate');
  assert.equal(filtered.truncated, false);
});

// ------------------------------------------------------------------ N4

test('N4 a missing key replies content.item { kind, key, missing: true }', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  for (const kind of KINDS) {
    const item = await get(c, kind, 'nope/none');
    assert.deepEqual({ type: item.type, kind: item.kind, key: item.key, missing: item.missing }, { type: 'content.item', kind, key: 'nope/none', missing: true });
    assert.ok(!('body' in item) || item.body === undefined, 'no body');
  }
  await put(c, 'card-source', 'exists', { a: 1 });
  assert.equal((await get(c, 'card-source', 'exists2')).missing, true, 'keys match exactly, not by prefix');
  assert.notEqual((await get(c, 'card-source', 'exists')).missing, true);
});

// ------------------------------------------------------------------ N5

test('N5 a body over maxBodyBytes replies too-large and persists no state (counted in UTF-8 bytes)', async (t) => {
  const env = await start({ maxBodyBytes: 100 });
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const w = await env.connect('bob');
  await watch(w, KINDS);

  const exact = 'a'.repeat(98); // 100 bytes after JSON.stringify
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 100);
  assert.equal((await put(c, 'card-source', 'edge', exact)).type, 'content.stored', 'exactly at the limit is allowed');
  await w.next(byType('content.changed'));

  const tooLong = 'a'.repeat(99);
  const multiByte = '中'.repeat(33); // i18n-allow: 35 characters, 101 bytes
  assert.equal(Buffer.byteLength(JSON.stringify(multiByte)), 101);
  const before = env.store.read('content/card-source').length;
  for (const body of [tooLong, multiByte, { big: 'x'.repeat(200) }]) {
    const r1 = await put(c, 'card-source', 'fresh', body);
    assert.deepEqual({ type: r1.type, reason: r1.reason }, { type: 'error', reason: 'too-large' }, `new key: ${JSON.stringify(body).slice(0, 40)}`);
    const r2 = await put(c, 'card-source', 'edge', body);
    assert.deepEqual({ type: r2.type, reason: r2.reason }, { type: 'error', reason: 'too-large' }, 'existing key');
  }
  assert.equal((await get(c, 'card-source', 'fresh')).missing, true, 'the new key was not persisted');
  const edge = await get(c, 'card-source', 'edge');
  assert.deepEqual({ body: edge.body, rev: edge.rev }, { body: exact, rev: 1 }, 'body and rev of the existing key are both unchanged');
  assert.deepEqual((await list(c, 'card-source')).items.map((x) => x.key), ['edge']);
  assert.equal(env.store.read('content/card-source').length, before, 'nothing written to the log');
  assert.deepEqual(await changes(w), [], 'no broadcast');
  assert.equal((await put(c, 'card-source', 'edge', 'ok')).rev, 2, 'a normal write afterwards continues rev upward from 1');
});

test('N5 default maxBodyBytes is 256 KiB', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const limit = 256 * 1024;
  const ok = 'a'.repeat(limit - 2);
  assert.equal((await put(c, 'render-manifest', 'big', ok)).type, 'content.stored');
  const r = await put(c, 'render-manifest', 'big2', ok + 'a');
  assert.deepEqual({ type: r.type, reason: r.reason }, { type: 'error', reason: 'too-large' });
});

// ------------------------------------------------------------------ N6

test('N6 a connection with content.watch receives content.changed on overwrite, with the correct previousActor; a connection that did not watch receives nothing', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const alice = await env.connect('alice');
  const bob = await env.connect('bob');
  const w = await env.connect('watcher');
  const otherKind = await env.connect('carol');
  const idle = await env.connect('dave');
  const ack = await watch(w, ['card-source']);
  assert.deepEqual({ type: ack.type, kinds: ack.kinds }, { type: 'content.watching', kinds: ['card-source'] });
  await watch(alice, ['card-source']);
  await watch(otherKind, ['snapshot-manifest']);

  const b1 = { v: 1 };
  const s1 = await put(alice, 'card-source', 'cards/x', b1);
  const pick = (m) => ({ type: m.type, kind: m.kind, key: m.key, hash: m.hash, rev: m.rev });
  const c1 = await w.next(byType('content.changed'));
  assert.deepEqual(pick(c1), { type: 'content.changed', kind: 'card-source', key: 'cards/x', hash: s1.hash, rev: 1 });
  assert.deepEqual(c1.actor, { userId: 'alice', session: null }, 'actor comes from principal, and session is null when not given (contract section 10, item 4)');
  assert.equal(c1.previousActor, null, 'previousActor is null on the first write');
  await alice.next(byType('content.changed'));
  // Contract section 10 item 2: for the same request, respond first, then broadcast
  const iStored = alice.all.findIndex((m) => m.type === 'content.stored');
  const iChanged = alice.all.findIndex((m) => m.type === 'content.changed');
  assert.ok(iStored >= 0 && iChanged > iStored, `content.stored comes before content.changed: stored@${iStored}, changed@${iChanged}`);

  // bob overwrites alice (with session; self-reported userId in body does not count)
  const b2 = { v: 2 };
  const s2 = await put(bob, 'card-source', 'cards/x', { ...b2, userId: 'mallory' }, { session: 'tab-b', userId: 'mallory' });
  const c2 = await w.next(byType('content.changed'));
  assert.deepEqual(pick(c2), { type: 'content.changed', kind: 'card-source', key: 'cards/x', hash: s2.hash, rev: 2 });
  assert.deepEqual(c2.actor, { userId: 'bob', session: 'tab-b' });
  assert.deepEqual(c2.previousActor, c1.actor, 'previousActor is the actor of the write that was overwritten');
  // Overwritten party (alice) sees itself overwritten in the channel
  const seenByAlice = await alice.next(byType('content.changed'));
  assert.equal(seenByAlice.previousActor?.userId, 'alice');
  assert.equal(seenByAlice.actor?.userId, 'bob');
  // session: null is treated as not provided
  await put(alice, 'card-source', 'cards/x', { v: 3 }, { session: null });
  const c3null = await w.next(byType('content.changed'));
  assert.deepEqual(c3null.actor, { userId: 'alice', session: null }, 'session: null counts as not given');
  assert.deepEqual(c3null.previousActor, { userId: 'bob', session: 'tab-b' });
  await alice.next(byType('content.changed'));
  assert.equal(s2.type, 'content.stored', 'the overwriting side sees content.stored');

  assert.deepEqual(await changes(otherKind), [], 'a connection watching another kind receives nothing');
  assert.deepEqual(await changes(idle, 0), [], 'a connection that did not watch receives nothing');
  assert.deepEqual(await changes(bob, 0), [], 'the overwriting side, which is not watching, receives nothing either');

  // Other kinds: content.changed has no rev; only goes to connections watching that kind
  await put(bob, 'snapshot-manifest', 'm', { a: 1 });
  const c3 = await otherKind.next(byType('content.changed'));
  assert.deepEqual({ kind: c3.kind, key: c3.key, previousActor: c3.previousActor }, { kind: 'snapshot-manifest', key: 'm', previousActor: null });
  assert.ok(!('rev' in c3), `content.changed of a non-card-source kind has no rev: ${JSON.stringify(c3)}`);
  assert.deepEqual(await changes(w), [], 'a connection watching card-source does not receive snapshot-manifest');
});

test('N6 content.watch: the last one wins, it replaces rather than accumulates (contract section 10, item 3)', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const writer = await env.connect('alice');
  const w = await env.connect('bob');
  assert.deepEqual((await watch(w, ['card-source', 'event-detail'])).kinds, ['card-source', 'event-detail']);
  await put(writer, 'event-detail', 'e', 1);
  assert.equal((await w.next(byType('content.changed'))).kind, 'event-detail');

  assert.deepEqual((await watch(w, ['snapshot-manifest'])).kinds, ['snapshot-manifest']);
  await put(writer, 'card-source', 'c', 1);
  await put(writer, 'event-detail', 'e', 2);
  await put(writer, 'snapshot-manifest', 's', 1);
  const got = await w.next(byType('content.changed'));
  assert.equal(got.kind, 'snapshot-manifest');
  assert.deepEqual(await changes(w), [], 'after switching the subscription, the old kind is no longer received');
  assert.deepEqual(w.all.filter((m) => m.type === 'content.changed' && m.kind !== 'snapshot-manifest' && m.kind !== 'event-detail'), [], 'not a single card-source message received');
  assert.equal(w.all.filter((m) => m.type === 'content.changed' && m.kind === 'event-detail').length, 1, 'only the one event-detail from before the subscription switch is received');
});

// ------------------------------------------------------------------ N7

test('N7 file storage restores the last state and rev of every key after a restart', async (t) => {
  const dir = tempDir(t);
  const { createFileStore } = await loadStore();
  const clock = { t: T0 };
  const env1 = await start({ store: createFileStore({ dir }), clock });
  t.after(env1.cleanup);
  const a = await env1.connect('alice');
  await put(a, 'card-source', 'k1', { v: 1 });
  await put(a, 'card-source', 'k1', { v: 2 });
  await put(a, 'card-source', 'k2', 'only');
  await put(a, 'snapshot-manifest', 'm1', [1]);
  await put(a, 'snapshot-manifest', 'm1', [1, 2]);
  await env1.cleanup();

  for (const kind of ['card-source', 'snapshot-manifest']) {
    const file = join(dir, 'content', `${kind}.ndjson`);
    assert.ok(existsSync(file), `log file is at <dir>/content/<kind>.ndjson: ${kind}`);
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const r of lines) {
      for (const k of ['kind', 'key', 'hash', 'actor', 'at', 'body']) assert.ok(Object.hasOwn(r, k), `log line is missing ${k}: ${JSON.stringify(r)}`);
      assert.deepEqual(r.actor, { userId: 'alice', session: null });
      assert.equal(r.hash, sha(r.body));
    }
  }

  const env2 = await start({ store: createFileStore({ dir }), clock });
  t.after(env2.cleanup);
  const b = await env2.connect('bob');
  const k1 = await get(b, 'card-source', 'k1');
  assert.deepEqual({ body: k1.body, rev: k1.rev, hash: k1.hash }, { body: { v: 2 }, rev: 2, hash: sha({ v: 2 }) });
  const k2 = await get(b, 'card-source', 'k2');
  assert.deepEqual({ body: k2.body, rev: k2.rev }, { body: 'only', rev: 1 });
  const m1 = await get(b, 'snapshot-manifest', 'm1');
  assert.deepEqual(m1.body, [1, 2]);
  assert.ok(!('rev' in m1));
  assert.deepEqual((await list(b, 'card-source')).items.map((x) => [x.key, x.rev]), [['k1', 2], ['k2', 1]]);

  await watch(b, ['card-source']);
  assert.equal((await put(b, 'card-source', 'k1', { v: 3 })).rev, 3, 'rev continues upward from the restored value');
  const ch = await b.next(byType('content.changed'));
  assert.equal(ch.previousActor?.userId, 'alice', 'the restored last writer is used as previousActor');
});

// ------------------------------------------------------------------ N8

test('N8 an unknown kind replies bad-message; an invalid key or kinds is rejected the same way, state unchanged', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const badKinds = ['card', 'Card-Source', '', 'content', 'card-source ', 42, null, undefined, ['card-source']];
  for (const kind of badKinds) {
    for (const [type, extra] of [['content.put', { key: 'k', body: 1 }], ['content.get', { key: 'k' }], ['content.list', {}]]) {
      c.send({ type, kind, ...extra });
      const r = await untilType(c, ['error', 'content.stored', 'content.item', 'content.listing']);
      assert.deepEqual({ type: r.type, reason: r.reason }, { type: 'error', reason: 'bad-message' }, `${type} kind=${JSON.stringify(kind)}`);
    }
  }
  for (const kinds of [['nope'], ['card-source', 'nope'], 'card-source', null, 7]) {
    const r = await watch(c, kinds);
    assert.deepEqual({ type: r.type, reason: r.reason }, { type: 'error', reason: 'bad-message' }, `content.watch kinds=${JSON.stringify(kinds)}`);
  }
  // key: string of 1-512 characters
  for (const key of ['', 'k'.repeat(513), 5, null, undefined, { k: 1 }]) {
    const r = await put(c, 'card-source', key, 1);
    assert.deepEqual({ type: r.type, reason: r.reason }, { type: 'error', reason: 'bad-message' }, `key=${JSON.stringify(key)?.slice(0, 20)}`);
  }
  assert.equal((await put(c, 'card-source', 'k'.repeat(512), 1)).type, 'content.stored', '512 characters is allowed');
  assert.deepEqual((await list(c, 'card-source')).items.map((x) => x.key.length), [512], 'none of the rejected ones were persisted');
  assert.equal(env.store.read('content/card-source').length, 1);
});
