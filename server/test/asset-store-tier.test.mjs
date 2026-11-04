/**
 * Data layer tiers and inventory (`blob-store.mjs` "tier", for guest video counts, 2026-10-23,
 * counted as "whichever is greater between original-size and small-tier count"): same rules for fs
 * (both layouts) and memory.
 *
 * - Tier only recognizes `small`; missing or misspelled are all `original`; if any chunk for the
 *   same hash does not specify `small`, it switches to `original`, never the reverse;
 * - On finalization, tier is stored with the whole file and listed by `inventory()`; removed
 *   together with `remove`; if the same hash is later stored at original size, the old small-tier
 *   marker is cleared;
 * - `inventory().stored` matches `usage().blobs` count;
 * - fs: when no tier is reported, `meta.json` is byte-for-byte identical to before and no `.tiers/`
 *   directory is created.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFsStore } from '../asset-store/fs-store.mjs';
import { createMemoryStore } from '../asset-store/memory-store.mjs';
import { normalizeTier } from '../asset-store/blob-store.mjs';

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const blob = (label, size = 40) => { const bytes = Buffer.alloc(size, 1); bytes.write(`${label} ${crypto.randomUUID()}`); return { bytes, hash: sha(bytes) }; };
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-asset-store-tier-'));
after(() => fsp.rm(root, { recursive: true, force: true }));

const CHUNK = 16;
const kinds = {
  memory: () => ({ store: createMemoryStore({ chunkSize: CHUNK }), dir: null }),
  fs: () => { const dir = path.join(root, crypto.randomUUID()); return { store: createFsStore({ dir, chunkSize: CHUNK }), dir }; },
  'fs shard': () => { const dir = path.join(root, crypto.randomUUID()); return { store: createFsStore({ dir, chunkSize: CHUNK, shard: true }), dir }; },
};

/** Written chunk by chunk; info for each chunk is provided by `infoOf(n)` */
async function putAll(store, { bytes, hash }, infoOf) {
  const count = Math.max(1, Math.ceil(bytes.length / CHUNK));
  for (let n = 0; n < count; n++) {
    const r = await store.putChunk(hash, n, { size: bytes.length, ...infoOf(n) }, [bytes.subarray(n * CHUNK, Math.min(bytes.length, (n + 1) * CHUNK))]);
    assert.equal(r.status, 'ok', `chunk ${n}`);
  }
}
const tierOf = async (store, hash, where = 'stored') => (await store.inventory())[where].find(e => e.hash === hash)?.tier;

test('normalizeTier: only small counts as the small tier', () => {
  for (const v of ['small', 'SMALL', ' Small ']) assert.equal(normalizeTier(v), 'small', JSON.stringify(v));
  for (const v of [undefined, null, '', 'original', 'smal', 'small,original', 'thumb', 1, {}]) assert.equal(normalizeTier(v), 'original', JSON.stringify(v));
});

for (const [kind, make] of Object.entries(kinds)) {
  test(`${kind}: tier registration, falls back only to original, stored with the whole file, inventory and usage report the same count`, async () => {
    const { store } = make();
    const a = blob('a'), b = blob('b'), c = blob('c'), d = blob('d');
    await putAll(store, a, () => ({ ext: 'mp4', tier: 'small' }));
    await putAll(store, b, n => ({ ext: 'mp4', tier: n === 0 ? 'small' : undefined })); // Subsequent chunks do not include headers
    await putAll(store, c, n => ({ ext: 'mp4', tier: n === 0 ? 'original' : 'small' })); // Original first, then small tier: does not revert
    await putAll(store, d, () => ({ ext: 'png' }));
    assert.equal(await tierOf(store, a.hash, 'staging'), 'small');
    assert.equal(await tierOf(store, b.hash, 'staging'), 'original');
    assert.equal(await tierOf(store, c.hash, 'staging'), 'original');
    assert.equal(await tierOf(store, d.hash, 'staging'), 'original');
    for (const it of [a, b, c, d]) assert.equal((await store.complete(it.hash)).status, 'ok');
    const inv = await store.inventory();
    assert.deepEqual(inv.staging, []);
    assert.deepEqual(Object.fromEntries(inv.stored.map(e => [e.hash, `${e.ext}/${e.tier}`])),
      { [a.hash]: 'mp4/small', [b.hash]: 'mp4/original', [c.hash]: 'mp4/original', [d.hash]: 'png/original' });
    assert.equal(inv.stored.length, (await store.usage()).blobs);
    // Re-uploading what is already stored: data layer returns complete without changing tier
    assert.equal((await store.putChunk(a.hash, 0, { size: a.bytes.length, ext: 'mp4' }, [a.bytes.subarray(0, CHUNK)])).status, 'complete');
    assert.equal(await tierOf(store, a.hash), 'small');
  });

  test(`${kind}: remove deletes the tier too; storing the same hash again at original size does not carry over the old small-tier marker`, async () => {
    const { store } = make();
    const a = blob('ra');
    await putAll(store, a, () => ({ ext: 'mp4', tier: 'small' }));
    await store.complete(a.hash);
    assert.equal(await tierOf(store, a.hash), 'small');
    assert.equal(await store.remove(a.hash), true);
    assert.deepEqual((await store.inventory()).stored, []);
    await putAll(store, a, () => ({ ext: 'mp4' }));
    await store.complete(a.hash);
    assert.equal(await tierOf(store, a.hash), 'original', 'no stale marker overriding it');
    // Staging is also deleted
    const s = blob('rs');
    await store.putChunk(s.hash, 0, { size: s.bytes.length, ext: 'mp4', tier: 'small' }, [s.bytes.subarray(0, CHUNK)]);
    assert.equal((await store.inventory()).staging.length, 1);
    assert.equal(await store.remove(s.hash), true);
    assert.deepEqual((await store.inventory()).staging, []);
  });
}

test('fs: a lost small-tier marker is treated as original size; a stale marker left after the whole file was deleted elsewhere is cleared when the same hash is stored again at original size; when nobody reports a tier, meta.json is the same as before and .tiers/ is not created', async () => {
  const { store, dir } = kinds.fs();
  const a = blob('fa');
  await store.putChunk(a.hash, 0, { size: a.bytes.length, ext: 'mp4' }, [a.bytes.subarray(0, CHUNK)]);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(dir, '.chunks', a.hash, 'meta.json'), 'utf8')), { size: a.bytes.length, ext: 'mp4' }, 'original size does not write the tier field');
  await putAll(store, a, () => ({ ext: 'mp4' }));
  await store.complete(a.hash);
  await assert.rejects(fsp.stat(path.join(dir, '.tiers')), { code: 'ENOENT' });

  const s = blob('fs');
  await putAll(store, s, () => ({ ext: 'mp4', tier: 'small' }));
  assert.equal(JSON.parse(await fsp.readFile(path.join(dir, '.chunks', s.hash, 'meta.json'), 'utf8')).tier, 'small');
  await store.complete(s.hash);
  assert.equal(await tierOf(store, s.hash), 'small');
  await fsp.rm(path.join(dir, '.tiers', s.hash));
  assert.equal(await tierOf(store, s.hash), 'original', 'without the marker it is counted as original size');
  // `.tiers/` is not counted as a whole file or chunk directory
  assert.equal((await store.usage()).blobs, 2);
  assert.equal((await store.list()).length, 2);

  // Whole file deleted without going through remove (e.g., other code deleted the file directly),
  // small-tier marker remains in `.tiers/`; same hash is later uploaded at original size
  const o = blob('orphan');
  await putAll(store, o, () => ({ ext: 'mp4', tier: 'small' }));
  await store.complete(o.hash);
  await fsp.rm(path.join(dir, `${o.hash}.mp4`));
  await fsp.stat(path.join(dir, '.tiers', o.hash));
  assert.equal(await tierOf(store, o.hash), undefined, 'the whole file is gone, so the stale marker must not make it appear in the manifest');
  await putAll(store, o, () => ({ ext: 'mp4', tier: 'original' }));
  await store.complete(o.hash);
  assert.equal(await tierOf(store, o.hash), 'original', 'the stale marker was cleared on finalize');
  await assert.rejects(fsp.stat(path.join(dir, '.tiers', o.hash)), { code: 'ENOENT' });
});
