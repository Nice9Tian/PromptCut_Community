/**
 * 推送队列遇到被淘汰的键(存储占用计划 `docs/plan/storage-plan.md`;`server/artifact-push.mjs`):
 * 段的键目录被帧库淘汰或「清理缓存」删掉(或推到一半文件读不到)时,丢掉这一段、记 `push.evicted`,
 * 不无限重试、不挡队列里别的段。键目录还在时的失败照旧退避重试。
 *
 * 管线是假的(只有帧库根、`snapshots()` 与空的 `entries`),素材服务是内存里的假客户端,不起服务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SnapshotStore } from '../snapshot-store.mjs';
import { createPushQueue, unitDirOf, unitEvicted } from '../artifact-push.mjs';

const hex = seed => crypto.createHash('sha256').update(String(seed)).digest('hex');

async function rig(t) {
  const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-push-evicted-')), 'frame-library');
  await fs.mkdir(root, { recursive: true });
  t.after(() => fs.rm(path.dirname(root), { recursive: true, force: true, maxRetries: 3 }));
  const pipeline = { root, entries: new Map(), snapshots: () => new SnapshotStore(root) };
  return { root, pipeline };
}

/** 在共享档写 `count` 帧快照,回这一段的 unit */
async function seedShared(pipeline, seed, count = 3) {
  const key = hex(seed);
  const dir = pipeline.snapshots().dir({ tier: 'shared', key });
  await fs.mkdir(dir, { recursive: true });
  for (let f = 0; f < count; f++) await fs.writeFile(path.join(dir, `${f}.html`), `<div>${seed}-${f}</div>`);
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ count, frames: [[0, count - 1]] }));
  return { unit: { kind: 'snapshot', tier: 'shared', resultKey: key, dirKey: key, range: { from: 0, to: count - 1 } }, dir };
}

function fakeClient({ onPut } = {}) {
  const puts = [];
  return {
    puts,
    async put(ns, bytes, opts) {
      if (onPut) await onPut(puts.length, { ns, bytes, opts });
      puts.push({ ns, hash: crypto.createHash('sha256').update(bytes).digest('hex') });
      return { uploaded: true };
    },
    async has() { return false; },
    async get() { return null; },
  };
}

function queueOf(t, pipeline, client, options = {}) {
  const logs = [];
  const queue = createPushQueue({ pipeline, client, gate: false, attach: false, concurrency: 1, log: (event, fields) => logs.push([event, fields]), ...options });
  t.after(() => queue.stop());
  return { queue, logs };
}

const withTimeout = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}:${ms} ms 还没完`)), ms).unref())]);

test('unitDirOf:共享档、本地档、流各指向帧库里自己的键目录', async t => {
  const { root, pipeline } = await rig(t);
  const k = hex('a'), e = hex('e');
  assert.equal(unitDirOf(pipeline, { kind: 'snapshot', tier: 'shared', dirKey: k }), path.join(root, 'controls-html', k));
  assert.equal(unitDirOf(pipeline, { kind: 'snapshot', tier: 'local', entryKey: e, dirKey: k }), path.join(root, 'controls-local', e, k));
  assert.equal(unitDirOf(pipeline, { kind: 'stream', resultKey: k }), path.join(root, 'streams', k));
  assert.equal(await unitEvicted(pipeline, { kind: 'stream', resultKey: k }), true);
  assert.equal(await unitEvicted({ root: null, snapshots: () => { throw new Error('x'); } }, { kind: 'snapshot', dirKey: k }), false, '算不出目录的不判');
});

test('键目录在进队后被淘汰:这一段丢掉、记 push.evicted,不重试,也不挡队里别的段', async t => {
  const { pipeline } = await rig(t);
  const gone = await seedShared(pipeline, 'gone');
  const kept = await seedShared(pipeline, 'kept');
  const client = fakeClient();
  const { queue, logs } = queueOf(t, pipeline, client);
  await queue.enqueue(gone.unit);
  await queue.enqueue(kept.unit);
  // 淘汰:整个键目录没了(帧库淘汰是先改名进垃圾目录、再删,对这里来说就是目录不在了)
  await fs.rm(gone.dir, { recursive: true, force: true });
  queue.start();
  await withTimeout(queue.drain(), 10_000, '队列没排空');
  const stats = queue.stats();
  assert.equal(stats.evicted, 1);
  assert.equal(stats.failures, 0, '不算失败、不退避');
  assert.equal(stats.pushed, 1, '别的段照推');
  assert.equal(client.puts.length, 3, '只推了留下那一段的 3 帧');
  const line = logs.find(([event]) => event === 'push.evicted');
  assert.ok(line, `记一行 push.evicted:${JSON.stringify(logs.map(l => l[0]))}`);
  assert.match(line[1].id, new RegExp(gone.unit.resultKey));
  assert.equal(logs.some(([event]) => event === 'push.retry'), false);
});

test('流的键目录被淘汰(没有 stream.json):丢掉,不按 no-stream-manifest 无限重试', async t => {
  const { pipeline } = await rig(t);
  const client = fakeClient();
  const { queue, logs } = queueOf(t, pipeline, client, { backoff: [60_000] });
  await queue.enqueue({ kind: 'stream', resultKey: hex('stream'), range: { from: 0, to: 3 } });
  queue.start();
  await withTimeout(queue.drain(), 10_000, '队列没排空');
  assert.equal(queue.stats().evicted, 1);
  assert.equal(queue.stats().failures, 0);
  assert.deepEqual(logs.map(([event]) => event).filter(e => e.startsWith('push.')), ['push.evicted']);
});

test('推到一半键目录被淘汰(块读不到):丢掉这一段,不重试', async t => {
  const { pipeline } = await rig(t);
  const seg = await seedShared(pipeline, 'mid', 12);
  // 推第一块时把键目录删掉:之后的块读不到
  const client = fakeClient({ onPut: async index => { if (index === 0) await fs.rm(seg.dir, { recursive: true, force: true }); } });
  const { queue, logs } = queueOf(t, pipeline, client, { backoff: [60_000] });
  await queue.enqueue(seg.unit);
  queue.start();
  await withTimeout(queue.drain(), 10_000, '队列没排空');
  const stats = queue.stats();
  assert.equal(stats.evicted, 1);
  assert.equal(stats.failures, 0);
  assert.equal(stats.pushed, 0);
  assert.ok(logs.some(([event]) => event === 'push.evicted'));
  assert.equal(logs.some(([event]) => event === 'push.retry'), false);
});

test('键目录还在时的失败照旧退避重试(不当成淘汰)', async t => {
  const { pipeline } = await rig(t);
  const seg = await seedShared(pipeline, 'flaky');
  const client = fakeClient({ onPut: async () => { throw Object.assign(new Error('素材服务不在'), { code: 'ECONNREFUSED' }); } });
  const { queue, logs } = queueOf(t, pipeline, client, { backoff: [60_000] });
  await queue.enqueue(seg.unit);
  queue.start();
  for (let i = 0; i < 200 && !queue.stats().failures; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const stats = queue.stats();
  assert.equal(stats.failures, 1);
  assert.equal(stats.evicted, 0);
  assert.equal(stats.backingOff, 1, '还在队里、退避中');
  assert.ok(logs.some(([event]) => event === 'push.retry'));
});

test('一次淘汰带走很多段:push.evicted 只记前几条和之后每 100 条一条', async t => {
  const { pipeline } = await rig(t);
  const client = fakeClient();
  const { queue, logs } = queueOf(t, pipeline, client);
  for (let i = 0; i < 205; i++) await queue.enqueue({ kind: 'stream', resultKey: hex(`s${i}`), range: { from: 0, to: 0 } });
  queue.start();
  await withTimeout(queue.drain(), 20_000, '队列没排空');
  assert.equal(queue.stats().evicted, 205);
  const lines = logs.filter(([event]) => event === 'push.evicted');
  assert.deepEqual(lines.map(([, f]) => f.count), [1, 2, 3, 100, 200]);
});
