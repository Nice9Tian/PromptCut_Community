/**
 * `c10-fake-idb.mjs`（C10 契约测试自写的内存 IndexedDB 桩）本身的单测：桩不对，L2 的用例就没有意义。
 * 跑：node --test server/test/c10-fake-idb.test.mjs
 *
 * 钉的是 L2 用例依赖的那几条浏览器行为：升级建表、读写、游标与索引、事务自动提交、事务不活跃时发请求抛错、
 * 两种配额错误的事件顺序（请求 error → 事务 error → 事务 abort；只有 abort）、中止回滚、`forceQuota`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeIDBFactory, FakeIDBKeyRange, MiB } from './c10-fake-idb.mjs';

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = (e) => { e.preventDefault?.(); reject(req.error); };
});
const txDone = (tx) => new Promise((resolve) => {
  const events = [];
  tx.addEventListener('error', () => events.push('error'));
  tx.addEventListener('complete', () => { events.push('complete'); resolve(events); });
  tx.addEventListener('abort', () => { events.push('abort'); resolve(events); });
});

async function openDb(factory, stores = ['a']) {
  const req = factory.open('db', 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    for (const s of stores) {
      const os = db.createObjectStore(s);
      if (s === 'a') os.createIndex('byAt', 'at');
    }
  };
  return reqP(req);
}

test('FIDB-01 升级建表、读写、getAll 按键排序、count', async () => {
  const f = new FakeIDBFactory();
  const db = await openDb(f, ['a', 'b']);
  assert.deepEqual([...db.objectStoreNames], ['a', 'b']);
  const tx = db.transaction(['a'], 'readwrite');
  const os = tx.objectStore('a');
  os.put({ at: 3, v: 'z' }, 'k3');
  os.put({ at: 1, v: 'x' }, 'k1');
  os.put({ at: 2, v: 'y' }, 'k2');
  assert.deepEqual(await txDone(tx), ['complete']);
  const r = db.transaction('a').objectStore('a');
  assert.deepEqual((await reqP(r.getAll())).map((x) => x.v), ['x', 'y', 'z']);
  assert.equal(await reqP(db.transaction('a').objectStore('a').count()), 3);
  assert.deepEqual(await reqP(db.transaction('a').objectStore('a').get('k2')), { at: 2, v: 'y' });
  assert.deepEqual(f.storeNamesOf('db'), ['a', 'b']);
  assert.deepEqual(f.dbNames(), ['db']);
});

test('FIDB-02 索引游标按 at 升序，游标里删除；同一事务里 await 微任务之后仍可发请求', async () => {
  const f = new FakeIDBFactory();
  const db = await openDb(f);
  const tx = db.transaction('a', 'readwrite');
  for (let i = 5; i >= 1; i--) tx.objectStore('a').put({ at: i }, `k${i}`);
  await txDone(tx);
  const tx2 = db.transaction('a', 'readwrite');
  const seen = [];
  const cur = tx2.objectStore('a').index('byAt').openCursor();
  cur.onsuccess = () => {
    const c = cur.result;
    if (!c) return;
    seen.push(c.value.at);
    if (c.value.at <= 2) c.delete();
    c.continue();
  };
  await txDone(tx2);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  const keys = await reqP(db.transaction('a').objectStore('a').getAllKeys());
  assert.deepEqual(keys, ['k3', 'k4', 'k5']);
  // 微任务里接着发请求：事务仍活跃（浏览器的行为，idb 这类封装靠它）
  const tx3 = db.transaction('a', 'readwrite');
  const os3 = tx3.objectStore('a');
  await reqP(os3.get('k3'));
  await Promise.resolve();
  os3.put({ at: 9 }, 'k9');
  assert.deepEqual(await txDone(tx3), ['complete']);
});

test('FIDB-03 事务提交之后再发请求抛 TransactionInactiveError', async () => {
  const f = new FakeIDBFactory();
  const db = await openDb(f);
  const tx = db.transaction('a', 'readwrite');
  const os = tx.objectStore('a');
  await txDone(tx);
  assert.throws(() => os.put({ at: 1 }, 'x'), (e) => e.name === 'TransactionInactiveError');
});

test('FIDB-04 配额 request 模式：请求 error → 事务 error → 事务 abort，写入回滚', async () => {
  const f = new FakeIDBFactory({ quotaBytes: 3 * MiB, quotaMode: 'request' });
  const db = await openDb(f);
  const buf = new ArrayBuffer(4 * MiB);
  const t1 = db.transaction('a', 'readwrite');
  t1.objectStore('a').put(new Uint8Array(buf, 0, 2 * MiB), 'one');
  assert.deepEqual(await txDone(t1), ['complete']);
  const t2 = db.transaction('a', 'readwrite');
  t2.objectStore('a').put(new Uint8Array(buf, 0, MiB / 2), 'small');
  const r = t2.objectStore('a').put(new Uint8Array(buf, 0, 2 * MiB), 'two');
  const reqEvents = [];
  r.onerror = () => reqEvents.push(r.error.name);
  assert.deepEqual(await txDone(t2), ['error', 'abort']);
  assert.deepEqual(reqEvents, ['QuotaExceededError']);
  assert.equal(t2.error.name, 'QuotaExceededError');
  // 同一事务里先成功的那条也回滚了
  assert.deepEqual(await reqP(db.transaction('a').objectStore('a').getAllKeys()), ['one']);
  assert.equal(f.log.at(-2).outcome, 'abort');
});

test('FIDB-05 配额 abort 模式：只有事务 abort（tx.error 是 QuotaExceededError），没有 error 事件', async () => {
  const f = new FakeIDBFactory({ quotaBytes: 3 * MiB, quotaMode: 'abort' });
  const db = await openDb(f);
  const buf = new ArrayBuffer(4 * MiB);
  const t = db.transaction('a', 'readwrite');
  const r = t.objectStore('a').put(new Uint8Array(buf, 0, 4 * MiB), 'big');
  let reqOk = false;
  r.onsuccess = () => { reqOk = true; };
  assert.deepEqual(await txDone(t), ['abort']);
  assert.equal(reqOk, true);
  assert.equal(t.error.name, 'QuotaExceededError');
  assert.equal(f.usage(), 0);
});

test('FIDB-06 forceQuota：含写入的事务失败，只删除的事务照常提交', async () => {
  for (const quotaMode of ['request', 'abort']) {
    const f = new FakeIDBFactory({ quotaMode });
    const db = await openDb(f);
    const t = db.transaction('a', 'readwrite');
    t.objectStore('a').put({ at: 1 }, 'x');
    await txDone(t);
    f.forceQuota = true;
    const t2 = db.transaction('a', 'readwrite');
    t2.objectStore('a').put({ at: 2 }, 'y');
    assert.ok((await txDone(t2)).includes('abort'), quotaMode);
    const t3 = db.transaction('a', 'readwrite');
    t3.objectStore('a').delete('x');
    assert.deepEqual(await txDone(t3), ['complete'], quotaMode);
    assert.equal(f.usage(), 0);
  }
});

test('FIDB-07 键范围与只读事务不能写', async () => {
  const f = new FakeIDBFactory();
  const db = await openDb(f);
  const t = db.transaction('a', 'readwrite');
  for (const k of ['a1', 'a2', 'b1']) t.objectStore('a').put({ at: 0 }, k);
  await txDone(t);
  const keys = await reqP(db.transaction('a').objectStore('a').getAllKeys(FakeIDBKeyRange.bound('a', 'a￿')));
  assert.deepEqual(keys, ['a1', 'a2']);
  assert.throws(() => db.transaction('a').objectStore('a').put({}, 'z'), (e) => e.name === 'ReadOnlyError');
});
