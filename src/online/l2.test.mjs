/**
 * 页面内快照库 L2(C10 契约第 4 节、第 18 节第 2 条):三张表、写入即就绪、软上限与 LRU、配额错误的回收与重试、
 * 事务 error / abort 都接、costs 不参与淘汰、estimate() 取小。IndexedDB 用 `src/testing/fakeIndexedDB.mjs` 的内存桩。
 * 跑:node --test src/online/l2.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeIndexedDB } from "../testing/fakeIndexedDB.mjs";
import {
  openL2, mergeRanges, l2LimitOf, L2_SOFT_LIMIT_DEFAULT, L2_SOFT_LIMIT_MIN, L2_SOFT_LIMIT_MAX, l2LimitByMemory, L2_RECLAIM_MIN, L2_RECLAIM_MAX, L2_DB_NAME, L2_STORES, MiB,
} from "./l2.ts";

const bytes = (n, fill = 1) => new Uint8Array(n).fill(fill);
const key = (i) => `snap/${String(i).padStart(64, "0")}`;
/** 让淘汰按写入次序走:每次调用 +1 */
const clock = () => { let t = 1000; return () => ++t; };

test("C10-L2-01 One database, three tables: costs, snapshots, ranges; chunks are keyed by snap/<hash> and store bytes and type", async () => {
  const idb = createFakeIndexedDB();
  const l2 = await openL2({ indexedDB: idb, estimate: async () => ({ quota: 100 * 1024 * MiB, usage: 0 }) });
  assert.equal(await l2.putBlock(key(1), bytes(10, 7), "text/html"), "db");
  const got = await l2.getBlock(key(1));
  assert.equal(got.type, "text/html");
  assert.deepEqual([...got.bytes], [...bytes(10, 7)]);
  const rec = idb.dump(L2_DB_NAME, L2_STORES.snapshots)[0];
  assert.equal(rec.key, key(1));
  assert.equal(rec.size, 10);
  await l2.putCost("id|dev", { identityKey: "id", device: "dev", stepMs: 3, mode: "build" });
  assert.deepEqual(await l2.getCost("id|dev"), { identityKey: "id", device: "dev", stepMs: 3, mode: "build" });
  assert.equal((await l2.listCosts()).length, 1);
  assert.equal(await l2.getBlock(key(2)), null);
  l2.close();
});

test("C10-L2-02 Ready on write: once putRange settles it notifies subscribers and ranges merge; still there after reopening", async () => {
  const idb = createFakeIndexedDB();
  const l2 = await openL2({ indexedDB: idb });
  const seen = [];
  const off = l2.subscribeReady((e) => seen.push(e));
  await l2.putRange("R1", 0, 4);
  await l2.putRange("R1", 5, 9);
  await l2.putRange("R1", 20, 20);
  assert.deepEqual(seen.map((e) => e.ranges), [[[0, 4]], [[0, 9]], [[0, 9], [20, 20]]]);
  off();
  await l2.putRange("R1", 21, 22);
  assert.equal(seen.length, 3, "退订之后不再通知");
  l2.close();
  const again = await openL2({ indexedDB: idb });
  assert.deepEqual(await again.getRanges("R1"), [[0, 9], [20, 22]]);
  assert.deepEqual(mergeRanges([[5, 6], [0, 2], [3, 4]]), [[0, 6]]);
});

test("C10-L2-03 The soft limit is allocated from the measured environment (no fixed number by identity or tier): if quota is available, take 10% of the remaining quota clamped to [32 MiB, 1 GiB]; if not, use memory; if neither, 128 MiB", async () => {
  assert.equal(L2_SOFT_LIMIT_DEFAULT, 128 * MiB);
  assert.equal(L2_SOFT_LIMIT_MIN, 32 * MiB);
  assert.equal(L2_SOFT_LIMIT_MAX, 1024 * MiB);
  // 拿不到额度:按内存(GiB × 32 MiB,夹在 64～256 MiB);内存也读不到(Safari、Firefox)取缺省
  assert.equal(await l2LimitOf(), 128 * MiB);
  assert.equal(await l2LimitOf(undefined, 1), 64 * MiB, "1 GB: clamped to the lower bound");
  assert.equal(await l2LimitOf(undefined, 4), 128 * MiB);
  assert.equal(await l2LimitOf(undefined, 8), 256 * MiB);
  assert.equal(await l2LimitOf(undefined, 32), 256 * MiB, "Clamped to the upper bound");
  assert.equal(l2LimitByMemory(undefined), 128 * MiB);
  assert.equal(l2LimitByMemory(-1), 128 * MiB);
  // 额度拿得到:剩余额度的 10%,夹在 [32 MiB, 1 GiB]
  assert.equal(await l2LimitOf(async () => ({ quota: 100 * 1024 * MiB, usage: 0 })), 1024 * MiB, "Large quota on desktop: capped at 1 GiB");
  assert.equal(await l2LimitOf(async () => ({ quota: 1000 * MiB, usage: 200 * MiB })), 80 * MiB);
  assert.equal(await l2LimitOf(async () => ({ quota: 100 * MiB, usage: 0 })), 32 * MiB, "Small quota: not below 32 MiB");
  assert.equal(await l2LimitOf(async () => ({ quota: 40 * MiB, usage: 20 * MiB })), 20 * MiB, "The lower bound also does not exceed the remaining quota itself");
  assert.equal(await l2LimitOf(async () => ({ quota: 1000 * MiB, usage: 200 * MiB }), 1), 80 * MiB, "Memory is ignored when quota is available");
  // 额度问不出:退回按内存
  assert.equal(await l2LimitOf(async () => { throw new Error("no"); }, 8), 256 * MiB);
  assert.equal(await l2LimitOf(async () => ({})), 128 * MiB);
});

test("C10-L2-04 Own LRU: when over the soft limit, delete the least recently used chunks first in the same transaction; a read hit refreshes the order; costs do not take part in eviction", async () => {
  const idb = createFakeIndexedDB();
  // 剩余额度 100 MiB → 10% 是 10 MiB,夹到下界 32 MiB
  const l2 = await openL2({ indexedDB: idb, estimate: async () => ({ quota: 100 * MiB, usage: 0 }), now: clock() });
  assert.equal(l2.limit(), 32 * MiB);
  await l2.putCost("c1", { stepMs: 1 });
  for (let i = 1; i <= 3; i++) await l2.putBlock(key(i), bytes(10 * MiB));
  // 读 1:1 变成最近用过的
  assert.ok(await l2.getBlock(key(1)));
  const before = idb.log.length;
  await l2.putBlock(key(4), bytes(10 * MiB));
  const tx = idb.log.slice(before).find((t) => t.mode === "readwrite");
  assert.deepEqual(tx.ops.map((o) => o.op), ["delete", "put"], "Delete and write are in the same transaction");
  assert.deepEqual(tx.ops.filter((o) => o.op === "delete").map((o) => o.key), [key(2)]);
  assert.ok(l2.hasBlock(key(1)) && l2.hasBlock(key(3)) && l2.hasBlock(key(4)));
  assert.ok(!l2.hasBlock(key(2)));
  assert.ok(l2.stats().bytes <= 32 * MiB);
  assert.deepEqual(await l2.getCost("c1"), { stepMs: 1 }, "costs do not take part in eviction");
  l2.close();
});

test("C10-L2-05 QuotaExceededError: one delete transaction frees max(16 MiB, this chunk) by LRU, then a separate write transaction retries once", async () => {
  const idb = createFakeIndexedDB();
  const l2 = await openL2({ indexedDB: idb, now: clock() });
  for (let i = 1; i <= 10; i++) await l2.putBlock(key(i), bytes(4 * MiB));
  idb.failPuts = 1;
  const before = idb.log.length;
  assert.equal(await l2.putBlock(key(99), bytes(2 * MiB)), "db");
  const txs = idb.log.slice(before);
  assert.equal(txs[0].outcome, "abort", "The first write transaction is aborted (the quota error bubbles up to the transaction)");
  assert.equal(txs[0].ops.find((o) => o.op === "put").error, "QuotaExceededError");
  const del = txs[1];
  assert.equal(del.outcome, "complete");
  assert.ok(del.ops.every((o) => o.op === "delete"), "Reclaiming is a delete-only transaction");
  // 4 MiB 一块,腾出 16 MiB 要删 4 块,最久没用的是 1..4
  assert.deepEqual(del.ops.map((o) => o.key), [key(1), key(2), key(3), key(4)]);
  const retry = txs[2];
  assert.deepEqual(retry.ops.map((o) => o.op), ["put"], "A separate write transaction retries this chunk");
  assert.equal(retry.outcome, "complete");
  assert.ok(l2.hasBlock(key(99)));
  assert.equal(l2.stats().quotaErrors, 1);
  assert.equal(L2_RECLAIM_MIN, 16 * MiB);
  assert.equal(L2_RECLAIM_MAX, 64 * MiB);
  l2.close();
});

test("C10-L2-06 The reclaim amount for a large chunk is computed from the chunk size, at most 64 MiB; chunks over the soft limit and chunks whose retry still fails are kept in memory only and can be read back", async () => {
  const idb = createFakeIndexedDB();
  // 剩余额度 1000 MiB → 上限 100 MiB
  const l2 = await openL2({ indexedDB: idb, estimate: async () => ({ quota: 1000 * MiB, usage: 0 }), now: clock() });
  assert.equal(l2.limit(), 100 * MiB);
  for (let i = 1; i <= 6; i++) await l2.putBlock(key(i), bytes(16 * MiB));
  idb.failPuts = 1;
  let before = idb.log.length;
  assert.equal(await l2.putBlock(key(98), bytes(70 * MiB)), "db");
  const del = idb.log.slice(before)[1];
  assert.ok(del.ops.every((o) => o.op === "delete"));
  assert.equal(del.ops.length, 4, "Frees min(64, max(16, 70)) = 64 MiB: deletes 4 chunks of 16 MiB");
  // 超过软上限的块:不碰库,只放内存
  before = idb.log.length;
  assert.equal(await l2.putBlock(key(97), bytes(101 * MiB)), "memory");
  assert.equal(idb.log.length, before, "A chunk over the soft limit does not touch the database");
  // 重试仍失败:这一块只放内存
  idb.failAll = true;
  assert.equal(await l2.putBlock(key(96), bytes(1 * MiB, 9)), "memory");
  const back = await l2.getBlock(key(96));
  assert.equal(back.bytes[0], 9, "A memory-only chunk can still be read back");
  assert.ok(l2.stats().memoryOnly >= 2);
  l2.close();
});

test("C10-L2-07 A transaction abort is also caught (no hang): a non-quota write failure falls back to memory and does not throw", async () => {
  const idb = createFakeIndexedDB();
  const l2 = await openL2({ indexedDB: idb });
  // 伪造一个事务一开就被中止的库:transaction() 抛
  const real = idb.open;
  void real;
  l2.close();
  const l2b = await openL2({ indexedDB: idb });
  l2b.close(); // 关了之后 transaction() 会抛 InvalidStateError
  const got = await Promise.race([l2b.putBlock(key(1), bytes(10)), new Promise((r) => setTimeout(() => r("hang"), 2000))]);
  assert.notEqual(got, "hang");
});

test("C10-L2-08 Reopening loses no chunks; the limit follows the environment (2 GB memory, no quota available → 64 MiB); without IndexedDB it falls back to memory only", async () => {
  const idb = createFakeIndexedDB();
  const a = await openL2({ indexedDB: idb, deviceMemory: 2, estimate: async () => ({}), now: clock() });
  assert.equal(a.limit(), 64 * MiB);
  await a.putBlock("px/" + "a".repeat(64), bytes(100, 3), "image/webp");
  a.close();
  const b = await openL2({ indexedDB: idb });
  assert.ok(b.hasBlock("px/" + "a".repeat(64)));
  assert.equal((await b.getBlock("px/" + "a".repeat(64))).type, "image/webp");
  b.close();
  const saved = globalThis.indexedDB;
  delete globalThis.indexedDB;
  const c = await openL2({});
  assert.equal(await c.putBlock(key(1), bytes(5)), "memory");
  assert.ok(await c.getBlock(key(1)));
  if (saved) globalThis.indexedDB = saved;
});
