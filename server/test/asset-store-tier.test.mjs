/**
 * 数据层的档位与清单（`blob-store.mjs`「档位」，2026-10-23 游客视频条数用，按「原尺寸几个、小档几个取多的」数）：fs（两种布局）与 memory 同一套规则。
 *
 * - 档位只认 `small`，缺失、拼错一律 `original`；同一个哈希只要有一片没说 `small` 就改记 `original`，不会反过来；
 * - 收尾时档位随全件入库，`inventory()` 列出来；`remove` 一起删；同一个哈希后来按原尺寸入库，旧的小档标记清掉；
 * - `inventory().stored` 与 `usage().blobs` 同数；
 * - fs：没人报档位时 `meta.json` 与原来逐字节一致、也不建 `.tiers/` 目录。
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

/** 按片写完，每一片的 info 由 `infoOf(n)` 给 */
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
    await putAll(store, b, n => ({ ext: 'mp4', tier: n === 0 ? 'small' : undefined })); // 后面的片没带头
    await putAll(store, c, n => ({ ext: 'mp4', tier: n === 0 ? 'original' : 'small' })); // 先原件后小档：不退回
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
    // 已入库的再传：数据层回 complete，不改档位
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
    // 暂存也一起删
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
  // `.tiers/` 不被当成全件或分片目录数进去
  assert.equal((await store.usage()).blobs, 2);
  assert.equal((await store.list()).length, 2);

  // 全件不经 remove 被删（例如别的代码直接删了文件），小档标记留在 `.tiers/` 里；同一个哈希后来按原尺寸传进来
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
