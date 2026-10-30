/**
 * 按哈希把本地内容库里已有的素材交给上传队列(C10a 集成返工:开启「放云端」时,开启前就在项目里的素材也要上云)。
 * 跑:node --test server/test/upload-enqueue-existing.test.mjs
 *
 * `enqueueLocalMedia`(`server/upload-queue.mjs`)接 `POST /api/media/upload-queue/enqueue` 的请求体;队列用真的
 * `createUploadQueue`(只在内存,目标是一个记录用的假素材服务客户端),看进队的档位、先小后大、只收本地有的、缺的回报。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createUploadQueue, enqueueLocalMedia } from '../upload-queue.mjs';

const h = (c) => c.repeat(64);
const V_ORIG = h('a'), V_SMALL = h('b'), IMG = h('c'), GONE = h('d'), GONE_SMALL = h('e');
const LOCAL = new Map([[V_ORIG, `/lib/${V_ORIG}.mp4`], [V_SMALL, `/lib/${V_SMALL}.mp4`], [IMG, `/lib/${IMG}.png`]]);
const resolveFile = (hash) => LOCAL.get(hash) ?? null;

function queueWith({ remote = true } = {}) {
  const client = { putFile: async () => ({ uploaded: true, sent: 1 }), chunks: async () => ({ complete: true }) };
  return createUploadQueue({ file: null, target: () => (remote ? { client, base: 'http://h/api/asset' } : null), resolveFile });
}

test('UQE-1 视频两档按先小后大进队,图片只有素材原尺寸一档;扩展名取本地文件的', async () => {
  const q = queueWith();
  const r = await enqueueLocalMedia(q, { items: [{ name: 'v.mp4', original: V_ORIG, small: V_SMALL }, { name: 'i.png', original: IMG }] }, resolveFile);
  assert.deepEqual(r, { queued: [V_ORIG, IMG], missing: [], bad: 0, local: false });
  const s = q.stats();
  assert.deepEqual(s.items.map((i) => [i.id, i.tiers]), [[V_ORIG, ['small', 'original']], [IMG, ['original']]]);
});

test('UQE-2 只收本地有的:素材原尺寸没有 → 整个素材不进队、回报缺失;素材小尺寸没有 → 只传素材原尺寸、回报素材小尺寸缺失', async () => {
  const q = queueWith();
  const r = await enqueueLocalMedia(q, { items: [{ original: GONE, small: V_SMALL }, { original: V_ORIG, small: GONE_SMALL }] }, resolveFile);
  assert.deepEqual(r.queued, [V_ORIG]);
  assert.deepEqual(r.missing, [GONE, GONE_SMALL]);
  assert.deepEqual(q.stats().items.map((i) => [i.id, i.tiers]), [[V_ORIG, ['original']]]);
});

test('UQE-3 也收 { hashes }(每个当素材原尺寸一档);形状不对的计 bad;同一素材原尺寸再进队只合并档位', async () => {
  const q = queueWith();
  const r = await enqueueLocalMedia(q, { hashes: [V_ORIG, 'not-a-hash', IMG] }, resolveFile);
  assert.deepEqual(r, { queued: [V_ORIG, IMG], missing: [], bad: 1, local: false });
  await enqueueLocalMedia(q, { items: [{ original: V_ORIG, small: V_SMALL }] }, resolveFile);
  const s = q.stats();
  assert.equal(s.merged, 1);
  assert.deepEqual(s.items[0].tiers, ['small', 'original'], '合并后仍先小后大');
});

test('UQE-4 当前连的是本机素材服务(队列空操作):回 local,什么都不进', async () => {
  const q = queueWith({ remote: false });
  const r = await enqueueLocalMedia(q, { items: [{ original: V_ORIG }, { original: IMG }] }, resolveFile);
  assert.equal(r.local, true);
  assert.deepEqual(r.queued, []);
  assert.equal(q.stats().items.length, 0);
});

test('UQE-5 小尺寸转码中补交原尺寸:等待持久两档管理器,不提前上传;生成后页面尚未写回也先小后大', async () => {
  const q = queueWith();
  let known = { state: 'pending' };
  const options = { getTiers: () => known };
  const body = { items: [{ original: V_ORIG }] };
  const pending = await enqueueLocalMedia(q, body, resolveFile, options);
  assert.deepEqual(pending, { queued: [], deferred: [V_ORIG], missing: [], bad: 0, local: false });
  assert.equal(q.stats().items.length, 0, '补交不能抢在两档管理器之前上传原尺寸');
  known = { state: 'ready', small: V_SMALL };
  await enqueueLocalMedia(q, body, resolveFile, options);
  assert.deepEqual(q.stats().items.map(i => i.tiers), [['small', 'original']]);
});

test('UQE-6 转码失败或没有两档登记的素材仍上传原尺寸,不无限等待', async () => {
  for (const state of ['failed', 'none', 'unknown']) {
    const q = queueWith();
    const r = await enqueueLocalMedia(q, { hashes: [V_ORIG] }, resolveFile, { getTiers: () => ({ state }) });
    assert.deepEqual(r.queued, [V_ORIG]);
    assert.deepEqual(q.stats().items.map(i => i.tiers), [['original']]);
  }
});

test('UQE-7 先报告原尺寸明确缺失;本机目标不记远程转码待办', async () => {
  const q = queueWith({ remote: false });
  const options = { isLocal: () => true, getTiers: () => ({ state: 'pending' }) };
  const r = await enqueueLocalMedia(q, { hashes: [GONE, V_ORIG] }, resolveFile, options);
  assert.deepEqual(r, { queued: [], missing: [GONE], bad: 0, local: true });
  assert.equal(q.stats().items.length, 0);
});

test('UQE-8 cancel: 撤回正在上传与排队中的素材，从队列移除；中止在途分片', async () => {
  let putAborted = false;
  let putStarted = false;
  const client = {
    putFile: async (_ns, _file, { signal, beforeChunk }) => {
      putStarted = true;
      try {
        await beforeChunk();
        await new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          setTimeout(resolve, 5000);
        });
        return { uploaded: true, sent: 1 };
      } catch (err) {
        putAborted = true;
        throw err;
      }
    },
    chunks: async () => ({ complete: true }),
  };
  const q = createUploadQueue({ file: null, target: () => ({ client, base: 'http://h/api/asset' }), resolveFile });
  await enqueueLocalMedia(q, { items: [{ original: V_ORIG, small: V_SMALL }, { original: IMG }] }, resolveFile);
  assert.equal(q.stats().items.length, 2);
  q.start();
  while (!putStarted) await new Promise((r) => setTimeout(r, 10));
  // 撤回正在上传的 V_ORIG
  const cancelRes = await q.cancel([V_ORIG]);
  assert.deepEqual(cancelRes, { ok: true, cancelled: [V_ORIG] });
  assert.equal(putAborted, true);
  assert.deepEqual(q.stats().items.map((i) => i.id), [IMG]);
  // 撤回排队中的 IMG
  const cancelAllRes = await q.cancel();
  assert.deepEqual(cancelAllRes, { ok: true, cancelled: [IMG] });
  assert.equal(q.stats().items.length, 0);
  await q.stop();
});

test('UQE-9 /api/media/upload-queue/cancel 接口: 撤回在途与队列文件并清理本地未登记文件，已传完出队的文件不删', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-uqe-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mediaDir = path.join(dir, 'out', 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const file1 = path.join(mediaDir, `${V_ORIG}.mp4`);
  const file2 = path.join(mediaDir, `${IMG}.png`);
  fs.writeFileSync(file1, 'data1');
  fs.writeFileSync(file2, 'data2');
  fs.writeFileSync(path.join(mediaDir, 'index.json'), JSON.stringify({
    version: 1, items: {
      [V_ORIG]: { file: `${V_ORIG}.mp4`, name: 'video.mp4', ext: 'mp4', size: 5 },
      [IMG]: { file: `${IMG}.png`, name: 'image.png', ext: 'png', size: 5 },
    },
  }));

  const { mediaMiddleware } = await import('../vite-plugin-media.ts');
  const m = mediaMiddleware(dir);
  const server = http.createServer((req, res) => { void m(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // 先设远端目标（连本机素材服务时队列是空操作，不进队）
  const setTarget = await fetch(`${base}/api/media/upload-queue/target`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: 'http://remote.asset.service/api' }),
  });
  assert.equal(setTarget.status, 200);

  // 把两项进队
  const enq = await fetch(`${base}/api/media/upload-queue/enqueue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: [V_ORIG, IMG] }),
  });
  assert.equal(enq.status, 200);

  // 1. POST /api/media/upload-queue/cancel 撤回 V_ORIG
  const c1 = await fetch(`${base}/api/media/upload-queue/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: [V_ORIG] }),
  });
  const j1 = await c1.json();
  assert.deepEqual(j1.cancelled, [V_ORIG]);
  assert.deepEqual(j1.cleaned, [V_ORIG]);
  assert.equal(fs.existsSync(file1), false, '在途/队列里的文件被删除');

  // 2. DELETE /api/media/upload-queue/<hash> 撤回 IMG
  const c2 = await fetch(`${base}/api/media/upload-queue/${IMG}`, { method: 'DELETE' });
  const j2 = await c2.json();
  assert.deepEqual(j2.cancelled, [IMG]);
  assert.deepEqual(j2.cleaned, [IMG]);
  assert.equal(fs.existsSync(file2), false, '被撤回的文件被删除');

  // 3. 不在队列里（已完整传完出队）的文件：cancel 不会删除它
  const doneFile = path.join(mediaDir, `${V_SMALL}.mp4`);
  fs.writeFileSync(doneFile, 'finished-data');
  fs.writeFileSync(path.join(mediaDir, 'index.json'), JSON.stringify({
    version: 1, items: { [V_SMALL]: { file: `${V_SMALL}.mp4`, name: 'done.mp4', ext: 'mp4', size: 13 } },
  }));
  const c3 = await fetch(`${base}/api/media/upload-queue/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: [V_SMALL] }),
  });
  const j3 = await c3.json();
  assert.deepEqual(j3.cancelled, [], '已不在队列里');
  assert.deepEqual(j3.cleaned, [], '未撤回任何项');
  assert.equal(fs.existsSync(doneFile), true, '已传完的文件不被误删');
});
