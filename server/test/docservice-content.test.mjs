/**
 * 内容库模块（契约 `docs/plan/docservice-contract.md` 第 2 节、第 3 节，用例 N1～N8）。
 * 跑：node --test server/test/docservice-content.test.mjs
 *
 * 只照契约写，不看实现。被测模块用动态 import 取，模块缺失时每条用例各自失败。
 * `createDocService` 独立模式、端口 0、`autoTick: false`；存储用 memory 或临时目录。
 * principal 由测试的 `authenticate` 按查询串 `?user=` 给出（见 `fake-docservice-env.mjs`）。
 * 契约没要求本模块的回包带 `reqId`，测试按回包类型等（同一连接上按顺序一问一答）。
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
/** 发一条带 reqId 的请求，按回包类型等（reqId 没带回时不至于等到超时），再断言 reqId 原样带回（契约第 10 节第 6 条） */
async function call(c, message, replyType) {
  const reqId = `n-${++reqSeq}`;
  c.send({ ...message, reqId });
  const reply = await untilType(c, [replyType, 'error']);
  assert.equal(reply.reqId, reqId, `回包要带请求的 reqId：${JSON.stringify(reply).slice(0, 200)}`);
  return reply;
}
const put = (c, kind, key, body, extra = {}) => call(c, { type: 'content.put', kind, key, body, ...extra }, 'content.stored');
const get = (c, kind, key) => call(c, { type: 'content.get', kind, key }, 'content.item');
const list = (c, kind, prefix) => call(c, { type: 'content.list', kind, ...(prefix === undefined ? {} : { prefix }) }, 'content.listing');
const watch = (c, kinds) => call(c, { type: 'content.watch', kinds }, 'content.watching');
const changes = (c, ms = 150) => c.quiet(byType('content.changed'), ms);

// ------------------------------------------------------------------ N1

test('N1 put 后 get 取回相同的 body，hash = sha256(JSON.stringify(body))；模块名进 /healthz', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const bodies = [
    { title: '标题', layers: [{ id: 1, x: 0.5 }, { id: 2, nested: { deep: [true, false, null] } }] },
    '一段纯文本',
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
  // 各 kind 互不串：同一个 key 在别的 kind 下没有
  assert.equal((await get(c, 'render-manifest', 'scene/1.json')).missing, true);
  const h = await env.health();
  assert.ok(Array.isArray(h.modules) && h.modules.includes('content'), `/healthz.modules 要含 content：${JSON.stringify(h.modules)}`);

  // 契约第 10 节第 5 条：不往 /healthz 加字段，只提供 describe()
  const bare = await startStandalone({ modules: [] });
  t.after(bare.cleanup);
  assert.deepEqual(Object.keys(h).sort(), Object.keys(await bare.health()).sort(), '挂上内容库模块后 /healthz 的字段集不变');
  const d = env.service.describe();
  assert.ok(Object.hasOwn(d.modules, 'content'), 'describe().modules 里有 content');
  assert.notEqual(d.modules.content, null, '内容库模块提供 describe()');
});

// ------------------------------------------------------------------ N2

test('N2 card-source 同一键连续 put 三次：rev 为 1、2、3，内容相同也加；其它 kind 没有 rev', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const body = { code: 'export default () => null' };
  const revs = [];
  for (let i = 0; i < 3; i++) revs.push((await put(c, 'card-source', 'cards/title', body)).rev);
  assert.deepEqual(revs, [1, 2, 3], '内容相同也加');
  assert.equal((await put(c, 'card-source', 'cards/other', body)).rev, 1, 'rev 按 key 各自从 1 起');

  const item = await get(c, 'card-source', 'cards/title');
  assert.equal(item.rev, 3, 'get 带当前 rev');
  const listing = await list(c, 'card-source');
  assert.deepEqual(listing.items.map((x) => [x.key, x.rev]), [['cards/other', 1], ['cards/title', 3]], 'list 带 rev');

  for (const kind of KINDS.filter((k) => k !== 'card-source')) {
    for (let i = 0; i < 2; i++) {
      const stored = await put(c, kind, 'k', { i });
      assert.equal(stored.type, 'content.stored');
      assert.ok(!('rev' in stored) || stored.rev === undefined, `${kind} 的 content.stored 没有 rev：${JSON.stringify(stored)}`);
    }
    const it = await get(c, kind, 'k');
    assert.ok(!('rev' in it), `${kind} 的 content.item 没有 rev：${JSON.stringify(it)}`);
    assert.deepEqual(it.body, { i: 1 }, '后写的赢');
    const ls = await list(c, kind);
    assert.ok(ls.items.every((x) => !('rev' in x)), `${kind} 的 listing 项没有 rev：${JSON.stringify(ls.items)}`);
  }
});

// ------------------------------------------------------------------ N3

test('N3 list 按 prefix 过滤、按 key 升序；恰好 1000 条 truncated: false，超过 1000 条 truncated: true', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  for (const key of ['b/2', 'a/2', 'a/10', 'a/1', 'c', 'ab']) await put(c, 'event-detail', key, { key });
  await put(c, 'render-manifest', 'a/9', {}); // 别的 kind 不出现

  const all = await list(c, 'event-detail');
  assert.deepEqual(all.items.map((x) => x.key), ['a/1', 'a/10', 'a/2', 'ab', 'b/2', 'c'], '按 key 升序（字符串比较）');
  assert.equal(all.truncated, false);
  assert.deepEqual(all.kind, 'event-detail');
  assert.equal(all.items[0].hash, sha({ key: 'a/1' }), '每项带 hash');
  const a = await list(c, 'event-detail', 'a/');
  assert.deepEqual(a.items.map((x) => x.key), ['a/1', 'a/10', 'a/2']);
  assert.deepEqual((await list(c, 'event-detail', 'a')).items.map((x) => x.key), ['a/1', 'a/10', 'a/2', 'ab']);
  assert.deepEqual((await list(c, 'event-detail', 'zzz')).items, []);

  // 1000 条边界：流水线发，逐条收
  const keys = Array.from({ length: 1001 }, (_, i) => `bulk/${String(i).padStart(4, '0')}`);
  for (const key of keys.slice(0, 1000)) c.send({ type: 'content.put', kind: 'snapshot-manifest', key, body: 1 });
  for (let i = 0; i < 1000; i++) assert.equal((await untilType(c, ['content.stored', 'error'], 5000)).type, 'content.stored');
  const exact = await list(c, 'snapshot-manifest');
  assert.equal(exact.items.length, 1000);
  assert.equal(exact.truncated, false, '恰好 1000 条不算截断');

  await put(c, 'snapshot-manifest', keys[1000], 1);
  const over = await list(c, 'snapshot-manifest');
  assert.equal(over.items.length, 1000, '最多 1000 条');
  assert.equal(over.truncated, true);
  assert.deepEqual(over.items.map((x) => x.key), keys.slice(0, 1000), '截断时给出升序的前 1000 条');
  const filtered = await list(c, 'snapshot-manifest', 'bulk/100');
  assert.deepEqual(filtered.items.map((x) => x.key), ['bulk/1000'], '先按 prefix 过滤再截断');
  assert.equal(filtered.truncated, false);
});

// ------------------------------------------------------------------ N4

test('N4 没有的键回 content.item { kind, key, missing: true }', async (t) => {
  const env = await start();
  t.after(env.cleanup);
  const c = await env.connect('alice');
  for (const kind of KINDS) {
    const item = await get(c, kind, 'nope/none');
    assert.deepEqual({ type: item.type, kind: item.kind, key: item.key, missing: item.missing }, { type: 'content.item', kind, key: 'nope/none', missing: true });
    assert.ok(!('body' in item) || item.body === undefined, '没有 body');
  }
  await put(c, 'card-source', 'exists', { a: 1 });
  assert.equal((await get(c, 'card-source', 'exists2')).missing, true, '键精确匹配，不按前缀');
  assert.notEqual((await get(c, 'card-source', 'exists')).missing, true);
});

// ------------------------------------------------------------------ N5

test('N5 body 超过 maxBodyBytes 回 too-large，不落任何状态（按 UTF-8 字节数计）', async (t) => {
  const env = await start({ maxBodyBytes: 100 });
  t.after(env.cleanup);
  const c = await env.connect('alice');
  const w = await env.connect('bob');
  await watch(w, KINDS);

  const exact = 'a'.repeat(98); // JSON.stringify 后 100 字节
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 100);
  assert.equal((await put(c, 'card-source', 'edge', exact)).type, 'content.stored', '正好等于上限可以');
  await w.next(byType('content.changed'));

  const tooLong = 'a'.repeat(99);
  const multiByte = '中'.repeat(33); // 35 个字符、101 字节
  assert.equal(Buffer.byteLength(JSON.stringify(multiByte)), 101);
  const before = env.store.read('content/card-source').length;
  for (const body of [tooLong, multiByte, { big: 'x'.repeat(200) }]) {
    const r1 = await put(c, 'card-source', 'fresh', body);
    assert.deepEqual({ type: r1.type, reason: r1.reason }, { type: 'error', reason: 'too-large' }, `新键：${JSON.stringify(body).slice(0, 40)}`);
    const r2 = await put(c, 'card-source', 'edge', body);
    assert.deepEqual({ type: r2.type, reason: r2.reason }, { type: 'error', reason: 'too-large' }, '已有键');
  }
  assert.equal((await get(c, 'card-source', 'fresh')).missing, true, '新键没落');
  const edge = await get(c, 'card-source', 'edge');
  assert.deepEqual({ body: edge.body, rev: edge.rev }, { body: exact, rev: 1 }, '已有键的 body 与 rev 都不变');
  assert.deepEqual((await list(c, 'card-source')).items.map((x) => x.key), ['edge']);
  assert.equal(env.store.read('content/card-source').length, before, '不写日志');
  assert.deepEqual(await changes(w), [], '不广播');
  assert.equal((await put(c, 'card-source', 'edge', 'ok')).rev, 2, '之后的正常写入 rev 接着 1 往上');
});

test('N5 缺省 maxBodyBytes 是 256 KiB', async (t) => {
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

test('N6 content.watch 的连接在覆盖时收到 content.changed，previousActor 正确；没 watch 的收不到', async (t) => {
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
  assert.deepEqual(c1.actor, { userId: 'alice', session: null }, 'actor 来自 principal，没给 session 为 null（契约第 10 节第 4 条）');
  assert.equal(c1.previousActor, null, '第一次写入 previousActor 为 null');
  await alice.next(byType('content.changed'));
  // 契约第 10 节第 2 条：同一条请求先回包、后广播
  const iStored = alice.all.findIndex((m) => m.type === 'content.stored');
  const iChanged = alice.all.findIndex((m) => m.type === 'content.changed');
  assert.ok(iStored >= 0 && iChanged > iStored, `content.stored 先于 content.changed：stored@${iStored}、changed@${iChanged}`);

  // bob 覆盖 alice（带 session；正文里自报的 userId 不算数）
  const b2 = { v: 2 };
  const s2 = await put(bob, 'card-source', 'cards/x', { ...b2, userId: 'mallory' }, { session: 'tab-b', userId: 'mallory' });
  const c2 = await w.next(byType('content.changed'));
  assert.deepEqual(pick(c2), { type: 'content.changed', kind: 'card-source', key: 'cards/x', hash: s2.hash, rev: 2 });
  assert.deepEqual(c2.actor, { userId: 'bob', session: 'tab-b' });
  assert.deepEqual(c2.previousActor, c1.actor, 'previousActor 是被覆盖的那次写入的 actor');
  // 被覆盖方（alice）在频道里看到自己被覆盖
  const seenByAlice = await alice.next(byType('content.changed'));
  assert.equal(seenByAlice.previousActor?.userId, 'alice');
  assert.equal(seenByAlice.actor?.userId, 'bob');
  // session: null 视为没给
  await put(alice, 'card-source', 'cards/x', { v: 3 }, { session: null });
  const c3null = await w.next(byType('content.changed'));
  assert.deepEqual(c3null.actor, { userId: 'alice', session: null }, 'session: null 视为没给');
  assert.deepEqual(c3null.previousActor, { userId: 'bob', session: 'tab-b' });
  await alice.next(byType('content.changed'));
  assert.equal(s2.type, 'content.stored', '覆盖方看 content.stored');

  assert.deepEqual(await changes(otherKind), [], 'watch 别的 kind 的收不到');
  assert.deepEqual(await changes(idle, 0), [], '没 watch 的收不到');
  assert.deepEqual(await changes(bob, 0), [], '覆盖方没 watch 也收不到');

  // 别的 kind：content.changed 没有 rev；只到 watch 了那个 kind 的连接
  await put(bob, 'snapshot-manifest', 'm', { a: 1 });
  const c3 = await otherKind.next(byType('content.changed'));
  assert.deepEqual({ kind: c3.kind, key: c3.key, previousActor: c3.previousActor }, { kind: 'snapshot-manifest', key: 'm', previousActor: null });
  assert.ok(!('rev' in c3), `非 card-source 的 content.changed 没有 rev：${JSON.stringify(c3)}`);
  assert.deepEqual(await changes(w), [], 'watch card-source 的收不到 snapshot-manifest');
});

test('N6 content.watch 以最后一条为准：是替换，不是累加（契约第 10 节第 3 条）', async (t) => {
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
  assert.deepEqual(await changes(w), [], '换订阅之后，旧的 kind 不再收到');
  assert.deepEqual(w.all.filter((m) => m.type === 'content.changed' && m.kind !== 'snapshot-manifest' && m.kind !== 'event-detail'), [], 'card-source 一条都没收到');
  assert.equal(w.all.filter((m) => m.type === 'content.changed' && m.kind === 'event-detail').length, 1, 'event-detail 只收到换订阅之前的那一条');
});

// ------------------------------------------------------------------ N7

test('N7 文件存储重启恢复每个键的最后状态与 rev', async (t) => {
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
    assert.ok(existsSync(file), `日志文件在 <dir>/content/<kind>.ndjson：${kind}`);
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const r of lines) {
      for (const k of ['kind', 'key', 'hash', 'actor', 'at', 'body']) assert.ok(Object.hasOwn(r, k), `日志行缺 ${k}：${JSON.stringify(r)}`);
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
  assert.equal((await put(b, 'card-source', 'k1', { v: 3 })).rev, 3, 'rev 从恢复值往上加');
  const ch = await b.next(byType('content.changed'));
  assert.equal(ch.previousActor?.userId, 'alice', '恢复出的最后写入者作为 previousActor');
});

// ------------------------------------------------------------------ N8

test('N8 不认识的 kind 回 bad-message；key、kinds 不合法同样拒绝，状态不变', async (t) => {
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
  // key：1～512 个字符的字符串
  for (const key of ['', 'k'.repeat(513), 5, null, undefined, { k: 1 }]) {
    const r = await put(c, 'card-source', key, 1);
    assert.deepEqual({ type: r.type, reason: r.reason }, { type: 'error', reason: 'bad-message' }, `key=${JSON.stringify(key)?.slice(0, 20)}`);
  }
  assert.equal((await put(c, 'card-source', 'k'.repeat(512), 1)).type, 'content.stored', '512 个字符可以');
  assert.deepEqual((await list(c, 'card-source')).items.map((x) => x.key.length), [512], '被拒的都没落');
  assert.equal(env.store.read('content/card-source').length, 1);
});
