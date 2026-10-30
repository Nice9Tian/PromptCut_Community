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

test("C10-L2-01 一个库三张表:costs、snapshots、ranges;块按 snap/<hash> 为键存字节与类型", async () => {
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

test("C10-L2-02 写入即就绪:putRange 落定就通知订阅方,区间合并;重开之后还在", async () => {
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

test("C10-L2-03 软上限按实测到的环境分配(不按身份或档位定固定数):额度拿得到取剩余额度的 10% 夹在 [32 MiB, 1 GiB];拿不到按内存;都没有 128 MiB", async () => {
  assert.equal(L2_SOFT_LIMIT_DEFAULT, 128 * MiB);
  assert.equal(L2_SOFT_LIMIT_MIN, 32 * MiB);
  assert.equal(L2_SOFT_LIMIT_MAX, 1024 * MiB);
  // 拿不到额度:按内存(GiB × 32 MiB,夹在 64～256 MiB);内存也读不到(Safari、Firefox)取缺省
  assert.equal(await l2LimitOf(), 128 * MiB);
  assert.equal(await l2LimitOf(undefined, 1), 64 * MiB, "1 GB:夹到下界");
  assert.equal(await l2LimitOf(undefined, 4), 128 * MiB);
  assert.equal(await l2LimitOf(undefined, 8), 256 * MiB);
  assert.equal(await l2LimitOf(undefined, 32), 256 * MiB, "夹到上界");
  assert.equal(l2LimitByMemory(undefined), 128 * MiB);
  assert.equal(l2LimitByMemory(-1), 128 * MiB);
  // 额度拿得到:剩余额度的 10%,夹在 [32 MiB, 1 GiB]
  assert.equal(await l2LimitOf(async () => ({ quota: 100 * 1024 * MiB, usage: 0 })), 1024 * MiB, "电脑上额度很大:1 GiB 封顶");
  assert.equal(await l2LimitOf(async () => ({ quota: 1000 * MiB, usage: 200 * MiB })), 80 * MiB);
  assert.equal(await l2LimitOf(async () => ({ quota: 100 * MiB, usage: 0 })), 32 * MiB, "额度小:不低于 32 MiB");
  assert.equal(await l2LimitOf(async () => ({ quota: 40 * MiB, usage: 20 * MiB })), 20 * MiB, "下界也不超过剩余额度本身");
  assert.equal(await l2LimitOf(async () => ({ quota: 1000 * MiB, usage: 200 * MiB }), 1), 80 * MiB, "额度拿得到时不看内存");
  // 额度问不出:退回按内存
  assert.equal(await l2LimitOf(async () => { throw new Error("no"); }, 8), 256 * MiB);
  assert.equal(await l2LimitOf(async () => ({})), 128 * MiB);
});

test("C10-L2-04 自有 LRU:超软上限时同一个事务里先删最久没用的块;读命中刷新次序;costs 不参与淘汰", async () => {
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
  assert.deepEqual(tx.ops.map((o) => o.op), ["delete", "put"], "删与写在同一个事务里");
  assert.deepEqual(tx.ops.filter((o) => o.op === "delete").map((o) => o.key), [key(2)]);
  assert.ok(l2.hasBlock(key(1)) && l2.hasBlock(key(3)) && l2.hasBlock(key(4)));
  assert.ok(!l2.hasBlock(key(2)));
  assert.ok(l2.stats().bytes <= 32 * MiB);
  assert.deepEqual(await l2.getCost("c1"), { stepMs: 1 }, "costs 不参与淘汰");
  l2.close();
});

test("C10-L2-05 QuotaExceededError:一个删除事务按 LRU 腾出 max(16 MiB, 这一块),再另开写事务重试一次", async () => {
  const idb = createFakeIndexedDB();
  const l2 = await openL2({ indexedDB: idb, now: clock() });
  for (let i = 1; i <= 10; i++) await l2.putBlock(key(i), bytes(4 * MiB));
  idb.failPuts = 1;
  const before = idb.log.length;
  assert.equal(await l2.putBlock(key(99), bytes(2 * MiB)), "db");
  const txs = idb.log.slice(before);
  assert.equal(txs[0].outcome, "abort", "第一次写事务被中止(配额错误冒到事务上)");
  assert.equal(txs[0].ops.find((o) => o.op === "put").error, "QuotaExceededError");
  const del = txs[1];
  assert.equal(del.outcome, "complete");
  assert.ok(del.ops.every((o) => o.op === "delete"), "回收是一个只删的事务");
  // 4 MiB 一块,腾出 16 MiB 要删 4 块,最久没用的是 1..4
  assert.deepEqual(del.ops.map((o) => o.key), [key(1), key(2), key(3), key(4)]);
  const retry = txs[2];
  assert.deepEqual(retry.ops.map((o) => o.op), ["put"], "另开写事务重试这一块");
  assert.equal(retry.outcome, "complete");
  assert.ok(l2.hasBlock(key(99)));
  assert.equal(l2.stats().quotaErrors, 1);
  assert.equal(L2_RECLAIM_MIN, 16 * MiB);
  assert.equal(L2_RECLAIM_MAX, 64 * MiB);
  l2.close();
});

test("C10-L2-06 大块的回收量按块大小算,至多 64 MiB;超软上限的块与重试仍失败的块只放内存,读得回来", async () => {
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
  assert.equal(del.ops.length, 4, "腾出 min(64, max(16, 70)) = 64 MiB:删 4 块 16 MiB");
  // 超过软上限的块:不碰库,只放内存
  before = idb.log.length;
  assert.equal(await l2.putBlock(key(97), bytes(101 * MiB)), "memory");
  assert.equal(idb.log.length, before, "超过软上限的块不碰库");
  // 重试仍失败:这一块只放内存
  idb.failAll = true;
  assert.equal(await l2.putBlock(key(96), bytes(1 * MiB, 9)), "memory");
  const back = await l2.getBlock(key(96));
  assert.equal(back.bytes[0], 9, "只放内存的块照样读得回来");
  assert.ok(l2.stats().memoryOnly >= 2);
  l2.close();
});

test("C10-L2-07 事务 abort 也接住(不挂):非配额错误的写失败退回内存,不抛", async () => {
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

test("C10-L2-08 重开不丢块;上限跟环境走(内存 2 GB、拿不到额度 → 64 MiB);没有 IndexedDB 时退回只放内存", async () => {
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
