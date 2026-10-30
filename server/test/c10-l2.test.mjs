/**
 * C10 页面内快照库 L2（`docs/plan/c10-contract.md` 第 4 节，第 3 节的成本记录）。
 * 跑：node --test server/test/c10-l2.test.mjs
 *
 *   C10-L2-01 一个库、三张表（costs、snapshots、ranges），没有 backups（浏览器本地只放能重新拉回的缓存）；
 *   C10-L2-02 软上限按环境分配的几个数（32 MiB、1 GiB、128 MiB）由 L2 模块导出（2026-10-22 起不按档定固定数，原来是 256 / 64 MiB）；
 *   C10-L2-03 软上限取「剩余额度的 10%」夹在 [32 MiB, 1 GiB]，由页面自己的 LRU 守住（剩余 320 MiB → 32 MiB）；
 *   C10-L2-04 拿不到额度时按内存：报 2 GB → 64 MiB；
 *   C10-L2-05 LRU：读过的块比没读过的晚淘汰；留下的总是最近用过的；
 *   C10-L2-06 costs 不参与淘汰；
 *   C10-L2-07/08 QuotaExceededError（请求报错 / 只有事务 abort 两种）：一个事务回收 16～64 MiB 再试一次，成功；
 *   C10-L2-09/10 回收之后仍失败（两种）：这一块只放内存（读得回来），不再写库，写库只试两次；
 *   C10-L2-11 ranges 写入即通知订阅方，且落进 ranges 表；
 *   C10-L2-12 costs 关掉再开还在（成本记录持久）。
 *
 * IndexedDB 用自写的内存桩（`c10-fake-idb.mjs`）；块用同一块缓冲的不同长度视图，几十 MiB 不真占内存。
 * 假设见 `c10-kit.mjs` 的 K1、K2。实现不在时整组 skip。
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeIDBFactory, installFakeIndexedDB } from './c10-fake-idb.mjs';
import {
  MiB, L2_TABLES, L2_SOFT_LIMIT, L2_RECLAIM, l2Gate, openL2, snapKey, blockRecords, storedBlockBytes, putsOf,
  exportedNumbers, l2DbName, stubGlobal, importRepo, within, bytesIn,
} from './c10-kit.mjs';

const gate = l2Gate();
const it = (name, fn) => test(name, { skip: gate.ok ? false : gate.reason, timeout: 60_000 }, fn);

const BUF = new ArrayBuffer(8 * MiB);
const block = (size) => new Uint8Array(BUF, 0, size);

const restores = [];
afterEach(() => { while (restores.length) restores.pop()(); });

/** 装桩并打开 L2；`remaining` 是 `estimate()` 报的剩余额度 */
async function setup({ deviceMemory, remaining = 10 * 1024 * MiB, noEstimate = false, quotaBytes = Infinity, quotaMode = 'request' } = {}) {
  const factory = new FakeIDBFactory({ quotaBytes, quotaMode });
  restores.push(installFakeIndexedDB(factory));
  const estimate = noEstimate ? undefined : async () => ({ quota: factory.usage() + remaining, usage: factory.usage() });
  const nav = { ...(globalThis.navigator ?? {}), ...(deviceMemory ? { deviceMemory } : {}), storage: noEstimate ? { persist: async () => false } : { estimate, persist: async () => false, persisted: async () => false } };
  restores.push(stubGlobal('navigator', nav));
  let clock = 1_000_000;
  const now = () => (clock += 1);
  const l2 = await openL2(gate, { indexedDB: factory, deviceMemory, estimate, now });
  restores.push(() => { try { l2.close(); } catch { /* 忽略 */ } });
  return { factory, l2 };
}

/** 读回来的块字节数 */
const lenOf = (v) => (v === null ? -1 : bytesIn(v) || (typeof v === 'string' ? v.length : -1));

it('C10-L2-01 一个库、三张表：costs、snapshots、ranges；没有 backups', async () => {
  const { factory, l2 } = await setup();
  await l2.putCost('card-a|env-1', { stepMs: 3 });
  await l2.putBlock(snapKey(1), block(1024));
  await l2.putRange('layer-a', 0, 29);
  assert.equal(factory.dbNames().length, 1, `应只有一个库，实际 ${JSON.stringify(factory.dbNames())}`);
  assert.deepEqual(factory.storeNamesOf(l2DbName(factory)), L2_TABLES);
});

it('C10-L2-02 软上限按环境分配的几个数由 L2 模块导出（不按档定固定数）', async () => {
  const mod = await importRepo(gate.file);
  const nums = exportedNumbers(mod);
  for (const [name, v] of Object.entries(L2_SOFT_LIMIT)) assert.ok(nums.includes(v), `L2 模块导出里没有 ${name}（${v / MiB} MiB）：${JSON.stringify(nums)}`);
});

it('C10-L2-03 剩余 320 MiB 时软上限是 32 MiB（剩余 10%，夹在 [32 MiB, 1 GiB]），LRU 守住', async () => {
  const { factory, l2 } = await setup({ remaining: 320 * MiB });
  const limit = 32 * MiB;
  const keys = [];
  for (let i = 0; i < 12; i++) {
    keys.push(snapKey(i));
    await l2.putBlock(keys[i], block(4 * MiB));
    assert.ok(storedBlockBytes(factory) <= limit, `写第 ${i + 1} 块之后库里 ${storedBlockBytes(factory) / MiB} MiB，超过软上限 32 MiB`);
  }
  assert.ok(blockRecords(factory, keys.at(-1)).length > 0, '最新写的块在库里');
  assert.ok(storedBlockBytes(factory) >= 24 * MiB, `淘汰过头：只剩 ${storedBlockBytes(factory) / MiB} MiB（软上限 32 MiB，4 MiB 一块至少该留 6 块）`);
  // 留下的是最近写的一段后缀
  const kept = keys.map((k) => blockRecords(factory, k).length > 0);
  const firstKept = kept.indexOf(true);
  assert.ok(kept.slice(firstKept).every(Boolean), `留下的不是最近写的那一段：${JSON.stringify(kept)}`);
});

it('C10-L2-04 拿不到额度（没有 storage.estimate）时按内存：报 2 GB → 64 MiB', async () => {
  const { factory, l2 } = await setup({ deviceMemory: 2, noEstimate: true });
  for (let i = 0; i < 20; i++) {
    await l2.putBlock(snapKey(i), block(4 * MiB));
    assert.ok(storedBlockBytes(factory) <= L2_SOFT_LIMIT.memoryMin, `写第 ${i + 1} 块之后库里 ${storedBlockBytes(factory) / MiB} MiB，超过 64 MiB`);
  }
  assert.ok(storedBlockBytes(factory) >= 48 * MiB, `淘汰过头：只剩 ${storedBlockBytes(factory) / MiB} MiB`);
});

it('C10-L2-05 LRU：读过的块比没读过的晚淘汰', async () => {
  const { factory, l2 } = await setup({ remaining: 320 * MiB }); // 软上限 32 MiB
  const k = (i) => snapKey(i, 'c');
  for (let i = 0; i < 8; i++) await l2.putBlock(k(i), block(4 * MiB)); // 正好 32 MiB
  assert.equal(lenOf(await l2.getBlock(k(0))), 4 * MiB, '第 0 块读得回来');
  await l2.putBlock(k(8), block(4 * MiB));
  assert.ok(blockRecords(factory, k(0)).length > 0, '刚读过的第 0 块不该被淘汰');
  assert.equal(blockRecords(factory, k(1)).length, 0, '最久没用的第 1 块该先被淘汰');
  assert.ok(blockRecords(factory, k(8)).length > 0);
});

it('C10-L2-06 costs 不参与淘汰', async () => {
  const { factory, l2 } = await setup({ remaining: 320 * MiB });
  for (let i = 0; i < 40; i++) await l2.putCost(`card-${i}|env-1`, { stepMs: i, kind: 'random' });
  for (let i = 0; i < 12; i++) await l2.putBlock(snapKey(i, 'd'), block(4 * MiB));
  assert.equal(factory.records(l2DbName(factory), 'costs').length, 40, 'costs 表 40 条一条不少');
  for (let i = 0; i < 40; i += 13) {
    const rec = await l2.getCost(`card-${i}|env-1`);
    assert.equal(rec?.stepMs ?? rec?.record?.stepMs, i, `card-${i} 的成本记录读得回来`);
  }
});

/**
 * 配额错误后回收：桩的配额 41 MiB、软上限远大于它（剩余额度报 10 GiB），2 MiB 一块写 30 块。
 * 每一次因配额失败的写入之后，到同一块重试写入为止：只有一个事务删了块、删掉的字节在 16～64 MiB，且重试成功。
 */
async function quotaReclaim(quotaMode) {
  const { factory, l2 } = await setup({ quotaBytes: 41 * MiB, quotaMode });
  const keys = [];
  for (let i = 0; i < 30; i++) {
    keys.push(snapKey(i, quotaMode === 'abort' ? 'e' : 'f'));
    await l2.putBlock(keys[i], block(2 * MiB));
  }
  const failed = factory.log.filter((tx) => tx.outcome === 'abort' && tx.error === 'QuotaExceededError');
  assert.ok(failed.length > 0, '桩的配额应被撞到至少一次（否则这条用例没测到东西）');
  for (const tx of failed) {
    const put = tx.ops.find((o) => o.store === 'snapshots' && (o.op === 'put' || o.op === 'add'));
    if (!put) continue;
    const key = keys.find((k) => putsOf(factory, k).some((p) => p.tx === tx));
    assert.ok(key, '认得出失败的是哪一块');
    const attempts = putsOf(factory, key);
    assert.equal(attempts.length, 2, `${key.slice(0, 16)}… 应写两次（失败一次、再试一次），实际 ${attempts.length} 次`);
    const retry = attempts[1].tx;
    assert.equal(retry.outcome, 'complete', '再试一次成功');
    const between = factory.log.filter((t) => t.id > tx.id && t.id <= retry.id && t.ops.some((o) => o.store === 'snapshots' && o.op === 'delete'));
    assert.equal(between.length, 1, `回收应在一个事务里做完，实际 ${between.length} 个删除事务`);
    assert.equal(between[0].outcome, 'complete');
    const freed = between[0].ops.filter((o) => o.store === 'snapshots' && o.op === 'delete').reduce((s, o) => s + o.bytes, 0);
    assert.ok(freed >= L2_RECLAIM.min && freed <= L2_RECLAIM.max + MiB, `回收了 ${(freed / MiB).toFixed(2)} MiB，应在 16～64 MiB`);
  }
  assert.ok(blockRecords(factory, keys.at(-1)).length > 0, '最后一块写进了库');
  assert.equal(lenOf(await l2.getBlock(keys.at(-1))), 2 * MiB);
}

it('C10-L2-07 QuotaExceededError（请求报错 → 事务 error → abort）：一个事务回收 16～64 MiB 再试一次', () => quotaReclaim('request'));
it('C10-L2-08 QuotaExceededError（只有事务 abort，没有 error 事件）：同样回收再试一次', () => quotaReclaim('abort'));

async function quotaStillFails(quotaMode) {
  const { factory, l2 } = await setup({ quotaMode });
  const salt = quotaMode === 'abort' ? '1' : '2';
  for (let i = 0; i < 12; i++) await l2.putBlock(snapKey(i, salt), block(2 * MiB)); // 24 MiB，回收够得着 16 MiB
  factory.forceQuota = true;
  const x = snapKey(99, salt);
  await within(l2.putBlock(x, block(3 * MiB)), 5000, '回收后仍失败的写入');
  assert.equal(putsOf(factory, x).length, 2, `写库只试两次（失败、回收后再试一次），实际 ${putsOf(factory, x).length} 次`);
  assert.equal(blockRecords(factory, x).length, 0, '库里没有这一块');
  assert.equal(lenOf(await l2.getBlock(x)), 3 * MiB, '这一块放在内存里，读得回来');
  factory.forceQuota = false;
  await l2.putBlock(snapKey(100, salt), block(MiB));
  assert.equal(lenOf(await l2.getBlock(x)), 3 * MiB, '之后照样从内存读得回来');
  assert.equal(putsOf(factory, x).length, 2, '之后不再为这一块写库');
}

it('C10-L2-09 回收之后仍失败（请求报错）：这一块只放内存，不再写库', () => quotaStillFails('request'));
it('C10-L2-10 回收之后仍失败（只有 abort）：这一块只放内存，不再写库', () => quotaStillFails('abort'));

it('C10-L2-11 ranges 写入即通知订阅方，并落进 ranges 表', async () => {
  const { factory, l2 } = await setup();
  const seen = [];
  const off = l2.subscribe((...args) => seen.push(args));
  await l2.putBlock(snapKey(1, 'g'), block(1024));
  await l2.putRange('layer-g', 0, 59);
  await within(new Promise((resolve) => {
    const poll = () => (seen.length ? resolve() : setTimeout(poll, 5));
    poll();
  }), 1000, 'ranges 写入后的通知');
  assert.ok(factory.records(l2DbName(factory), 'ranges').length > 0, 'ranges 表里有记录');
  if (typeof off === 'function') off();
});

it('C10-L2-12 成本记录关掉再开还在（已有记录的卡不再测）', async () => {
  const factory = new FakeIDBFactory();
  restores.push(installFakeIndexedDB(factory));
  const estimate = async () => ({ quota: 10 * 1024 * MiB, usage: factory.usage() });
  const first = await openL2(gate, { indexedDB: factory, estimate });
  await first.putCost('card-z|env-9', { stepMs: 7, kind: 'random' });
  await first.close();
  const second = await openL2(gate, { indexedDB: factory, estimate });
  const rec = await second.getCost('card-z|env-9');
  assert.equal(rec?.stepMs ?? rec?.record?.stepMs, 7);
  await second.close();
});
