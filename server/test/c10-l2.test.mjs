/**
 * C10 in-page snapshot store L2 (`docs/plan/c10-contract.md` Section 4, Section 3 cost records).
 * Run: node --test server/test/c10-l2.test.mjs
 *
 *   C10-L2-01 One store, three tables (costs, snapshots, ranges), no backups (browser local
 *             storage only holds cache that can be refetched);
 *   C10-L2-02 Values for soft limit allocated by environment (32 MiB, 1 GiB, 128 MiB) exported by
 *             L2 module (from 2026-10-22, no fixed numbers by tier, originally 256 / 64 MiB);
 *   C10-L2-03 Soft limit takes "10% of remaining quota" clamped to [32 MiB, 1 GiB], guarded by
 *             page's own LRU (remaining 320 MiB → 32 MiB);
 *   C10-L2-04 By memory when quota unavailable: report 2 GB → 64 MiB;
 *   C10-L2-05 LRU: read chunks evicted later than unread chunks; what remains is always recently
 *             used;
 *   C10-L2-06 costs does not participate in eviction;
 *   C10-L2-07/08 QuotaExceededError (request error / transaction abort only, two types): one
 *                transaction reclaims 16-64 MiB and retries once, succeeds;
 *   C10-L2-09/10 Still fails after reclamation (two types): this chunk stored in memory only (can
 *                be read back), no longer written to store, store write only tried twice;
 *   C10-L2-11 ranges notifies subscribers on write, and is committed to ranges table;
 *   C10-L2-12 costs persists after close and reopen (cost records durable).
 *
 * IndexedDB uses custom in-memory stub (`c10-fake-idb.mjs`); chunks use views of different lengths
 * on the same buffer, tens of MiB do not actually occupy memory.
 * Assumptions see K1 and K2 in `c10-kit.mjs`. Skip entire group when implementation is absent.
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

/** Install stub and open L2; `remaining` is remaining quota reported by `estimate()` */
async function setup({ deviceMemory, remaining = 10 * 1024 * MiB, noEstimate = false, quotaBytes = Infinity, quotaMode = 'request' } = {}) {
  const factory = new FakeIDBFactory({ quotaBytes, quotaMode });
  restores.push(installFakeIndexedDB(factory));
  const estimate = noEstimate ? undefined : async () => ({ quota: factory.usage() + remaining, usage: factory.usage() });
  const nav = { ...(globalThis.navigator ?? {}), ...(deviceMemory ? { deviceMemory } : {}), storage: noEstimate ? { persist: async () => false } : { estimate, persist: async () => false, persisted: async () => false } };
  restores.push(stubGlobal('navigator', nav));
  let clock = 1_000_000;
  const now = () => (clock += 1);
  const l2 = await openL2(gate, { indexedDB: factory, deviceMemory, estimate, now });
  restores.push(() => { try { l2.close(); } catch { /* Ignore */ } });
  return { factory, l2 };
}

/** Byte count of chunk read back */
const lenOf = (v) => (v === null ? -1 : bytesIn(v) || (typeof v === 'string' ? v.length : -1));

it('C10-L2-01 one database, three object stores: costs, snapshots, ranges; no backups', async () => {
  const { factory, l2 } = await setup();
  await l2.putCost('card-a|env-1', { stepMs: 3 });
  await l2.putBlock(snapKey(1), block(1024));
  await l2.putRange('layer-a', 0, 29);
  assert.equal(factory.dbNames().length, 1, `Expected only one database, got ${JSON.stringify(factory.dbNames())}`);
  assert.deepEqual(factory.storeNamesOf(l2DbName(factory)), L2_TABLES);
});

it('C10-L2-02 the figures behind the environment-based soft limit are exported by the L2 module (no fixed number per tier)', async () => {
  const mod = await importRepo(gate.file);
  const nums = exportedNumbers(mod);
  for (const [name, v] of Object.entries(L2_SOFT_LIMIT)) assert.ok(nums.includes(v), `The L2 module exports do not include ${name} (${v / MiB} MiB): ${JSON.stringify(nums)}`);
});

it('C10-L2-03 with 320 MiB remaining the soft limit is 32 MiB (10% of the remaining, clamped to [32 MiB, 1 GiB]), and LRU enforces it', async () => {
  const { factory, l2 } = await setup({ remaining: 320 * MiB });
  const limit = 32 * MiB;
  const keys = [];
  for (let i = 0; i < 12; i++) {
    keys.push(snapKey(i));
    await l2.putBlock(keys[i], block(4 * MiB));
    assert.ok(storedBlockBytes(factory) <= limit, `After writing chunk ${i + 1}, the database holds ${storedBlockBytes(factory) / MiB} MiB, exceeding the soft limit of 32 MiB`);
  }
  assert.ok(blockRecords(factory, keys.at(-1)).length > 0, 'The most recently written chunk is in the database');
  assert.ok(storedBlockBytes(factory) >= 24 * MiB, `Evicted too much: only ${storedBlockBytes(factory) / MiB} MiB left (soft limit 32 MiB, at 4 MiB per chunk at least 6 chunks should remain)`);
  // What remains is a recently written suffix
  const kept = keys.map((k) => blockRecords(factory, k).length > 0);
  const firstKept = kept.indexOf(true);
  assert.ok(kept.slice(firstKept).every(Boolean), `The chunks that remain are not the most recently written ones: ${JSON.stringify(kept)}`);
});

it('C10-L2-04 when no quota is available (no storage.estimate), the limit is based on memory: 2 GB reported → 64 MiB', async () => {
  const { factory, l2 } = await setup({ deviceMemory: 2, noEstimate: true });
  for (let i = 0; i < 20; i++) {
    await l2.putBlock(snapKey(i), block(4 * MiB));
    assert.ok(storedBlockBytes(factory) <= L2_SOFT_LIMIT.memoryMin, `After writing chunk ${i + 1}, the database holds ${storedBlockBytes(factory) / MiB} MiB, exceeding 64 MiB`);
  }
  assert.ok(storedBlockBytes(factory) >= 48 * MiB, `Evicted too much: only ${storedBlockBytes(factory) / MiB} MiB left`);
});

it('C10-L2-05 LRU: chunks that were read are evicted later than chunks that were not', async () => {
  const { factory, l2 } = await setup({ remaining: 320 * MiB }); // Soft limit 32 MiB
  const k = (i) => snapKey(i, 'c');
  for (let i = 0; i < 8; i++) await l2.putBlock(k(i), block(4 * MiB)); // Exactly 32 MiB
  assert.equal(lenOf(await l2.getBlock(k(0))), 4 * MiB, 'Chunk 0 can be read back');
  await l2.putBlock(k(8), block(4 * MiB));
  assert.ok(blockRecords(factory, k(0)).length > 0, 'Chunk 0, just read, should not be evicted');
  assert.equal(blockRecords(factory, k(1)).length, 0, 'Chunk 1, the least recently used, should be evicted first');
  assert.ok(blockRecords(factory, k(8)).length > 0);
});

it('C10-L2-06 costs do not take part in eviction', async () => {
  const { factory, l2 } = await setup({ remaining: 320 * MiB });
  for (let i = 0; i < 40; i++) await l2.putCost(`card-${i}|env-1`, { stepMs: i, kind: 'random' });
  for (let i = 0; i < 12; i++) await l2.putBlock(snapKey(i, 'd'), block(4 * MiB));
  assert.equal(factory.records(l2DbName(factory), 'costs').length, 40, 'The costs store has all 40 records, none missing');
  for (let i = 0; i < 40; i += 13) {
    const rec = await l2.getCost(`card-${i}|env-1`);
    assert.equal(rec?.stepMs ?? rec?.record?.stepMs, i, `The cost record of card-${i} can be read back`);
  }
});

/**
 * Reclamation after quota error: stub quota 41 MiB, soft limit far exceeds it (remaining quota
 * reports 10 GiB), write 30 chunks of 2 MiB each.
 * After each write failed due to quota, up until retry write of the same chunk: only one
 * transaction deleted chunks, deleted bytes in 16-64 MiB, and retry succeeds.
 */
async function quotaReclaim(quotaMode) {
  const { factory, l2 } = await setup({ quotaBytes: 41 * MiB, quotaMode });
  const keys = [];
  for (let i = 0; i < 30; i++) {
    keys.push(snapKey(i, quotaMode === 'abort' ? 'e' : 'f'));
    await l2.putBlock(keys[i], block(2 * MiB));
  }
  const failed = factory.log.filter((tx) => tx.outcome === 'abort' && tx.error === 'QuotaExceededError');
  assert.ok(failed.length > 0, 'The stub\'s quota should be hit at least once (otherwise this case tests nothing)');
  for (const tx of failed) {
    const put = tx.ops.find((o) => o.store === 'snapshots' && (o.op === 'put' || o.op === 'add'));
    if (!put) continue;
    const key = keys.find((k) => putsOf(factory, k).some((p) => p.tx === tx));
    assert.ok(key, 'Can tell which chunk failed');
    const attempts = putsOf(factory, key);
    assert.equal(attempts.length, 2, `${key.slice(0, 16)}… should be written twice (one failure, one retry), got ${attempts.length}`);
    const retry = attempts[1].tx;
    assert.equal(retry.outcome, 'complete', 'The retry succeeds');
    const between = factory.log.filter((t) => t.id > tx.id && t.id <= retry.id && t.ops.some((o) => o.store === 'snapshots' && o.op === 'delete'));
    assert.equal(between.length, 1, `Reclaiming should finish in one transaction, got ${between.length} delete transactions`);
    assert.equal(between[0].outcome, 'complete');
    const freed = between[0].ops.filter((o) => o.store === 'snapshots' && o.op === 'delete').reduce((s, o) => s + o.bytes, 0);
    assert.ok(freed >= L2_RECLAIM.min && freed <= L2_RECLAIM.max + MiB, `Reclaimed ${(freed / MiB).toFixed(2)} MiB, should be within 16-64 MiB`);
  }
  assert.ok(blockRecords(factory, keys.at(-1)).length > 0, 'The last chunk was written to the database');
  assert.equal(lenOf(await l2.getBlock(keys.at(-1))), 2 * MiB);
}

it('C10-L2-07 QuotaExceededError (request error → transaction error → abort): one transaction reclaims 16-64 MiB, then retries once', () => quotaReclaim('request'));
it('C10-L2-08 QuotaExceededError (only the transaction abort, no error event): reclaims and retries once in the same way', () => quotaReclaim('abort'));

async function quotaStillFails(quotaMode) {
  const { factory, l2 } = await setup({ quotaMode });
  const salt = quotaMode === 'abort' ? '1' : '2';
  for (let i = 0; i < 12; i++) await l2.putBlock(snapKey(i, salt), block(2 * MiB)); // 24 MiB, reclamation reaches 16 MiB
  factory.forceQuota = true;
  const x = snapKey(99, salt);
  await within(l2.putBlock(x, block(3 * MiB)), 5000, 'A write that still fails after reclaiming');
  assert.equal(putsOf(factory, x).length, 2, `Database writes are attempted only twice (a failure, then one retry after reclaiming), got ${putsOf(factory, x).length}`);
  assert.equal(blockRecords(factory, x).length, 0, 'This chunk is not in the database');
  assert.equal(lenOf(await l2.getBlock(x)), 3 * MiB, 'This chunk is kept in memory and can be read back');
  factory.forceQuota = false;
  await l2.putBlock(snapKey(100, salt), block(MiB));
  assert.equal(lenOf(await l2.getBlock(x)), 3 * MiB, 'It can still be read back from memory afterwards');
  assert.equal(putsOf(factory, x).length, 2, 'No more database writes for this chunk afterwards');
}

it('C10-L2-09 still failing after reclaiming (request error): this chunk stays in memory only and is no longer written to the database', () => quotaStillFails('request'));
it('C10-L2-10 still failing after reclaiming (abort only): this chunk stays in memory only and is no longer written to the database', () => quotaStillFails('abort'));

it('C10-L2-11 a write to ranges notifies subscribers immediately and lands in the ranges store', async () => {
  const { factory, l2 } = await setup();
  const seen = [];
  const off = l2.subscribe((...args) => seen.push(args));
  await l2.putBlock(snapKey(1, 'g'), block(1024));
  await l2.putRange('layer-g', 0, 59);
  await within(new Promise((resolve) => {
    const poll = () => (seen.length ? resolve() : setTimeout(poll, 5));
    poll();
  }), 1000, 'Notification after a ranges write');
  assert.ok(factory.records(l2DbName(factory), 'ranges').length > 0, 'The ranges store has records');
  if (typeof off === 'function') off();
});

it('C10-L2-12 cost records survive closing and reopening (cards that already have a record are not measured again)', async () => {
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
