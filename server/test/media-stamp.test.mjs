/*
 * 帧管线的素材戳(`server/media-stamp.mjs`,原 `card-media-path.mjs` 的本地 stat 那一套):
 * 有哈希用哈希、没有就问素材服务的 HEAD,不读素材服务的存储目录。
 * 跑法:`node --test server/test/media-stamp.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createMediaStamper, exportMediaFile, mediaHashOf, MEDIA_STAMP_TTL_MS } from '../media-stamp.mjs';

const H = 'ab'.repeat(32);

test('有内容哈希的素材:戳就是哈希,不发任何请求', async () => {
  const stamper = createMediaStamper({ mediaUrl: () => { throw new Error('不该问地址'); }, fetch: () => { throw new Error('不该发请求'); } });
  assert.equal(await stamper.stamp({ hash: H.toUpperCase(), url: '/@media/whatever.mp4' }), H);
  assert.equal(await stamper.stamp({ url: `/@media/${H}.mp4` }), H);
  assert.equal(mediaHashOf({ url: `/@media/${H}?x=1` }), H);
  assert.equal(mediaHashOf({ url: '/@media/clip.mp4' }), null);
});

test('没有哈希的素材:HEAD 素材服务,戳 = Content-Length:Last-Modified;按 URL 缓存,TTL 过了再问', async () => {
  const calls = [];
  let t = 1000;
  const fakeFetch = async (url, init) => {
    calls.push([url, init.method]);
    return { ok: true, headers: new Map([['content-length', '1234'], ['last-modified', 'Wed, 23 Sep 2026 10:00:00 GMT']]) };
  };
  const stamper = createMediaStamper({ mediaUrl: m => `http://asset.test${m.url}`, fetch: fakeFetch, now: () => t });
  const legacy = { url: '/@media/clip%20one.mp4' };
  assert.equal(await stamper.stamp(legacy), '1234:Wed, 23 Sep 2026 10:00:00 GMT');
  // 同一条、同一个 TTL 窗口里并发和先后再问:不再发请求
  await Promise.all([stamper.stamp(legacy), stamper.stamp(legacy)]);
  t += MEDIA_STAMP_TTL_MS - 1;
  await stamper.stamp(legacy);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['http://asset.test/@media/clip%20one.mp4', 'HEAD']);
  t += 2;
  await stamper.stamp(legacy);
  assert.equal(calls.length, 2, 'TTL 过了重新问');
});

test('素材服务不可达 / HEAD 失败 → missing;不该打戳的地址不打', async () => {
  const unreachable = createMediaStamper({ mediaUrl: () => null });
  assert.equal(await unreachable.stamp({ url: '/api/media/file?path=C%3A%2Fa.mp4' }), 'missing');
  assert.equal(await unreachable.stamp({ path: 'C:/a.mp4', url: '' }), 'missing');
  const failing = createMediaStamper({ mediaUrl: () => 'http://asset.test/x', fetch: async () => ({ ok: false, headers: new Map() }) });
  assert.equal(await failing.stamp({ url: '/@media/gone.mp4' }), 'missing');
  const throwing = createMediaStamper({ mediaUrl: () => 'http://asset.test/x', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(await throwing.stamp({ url: '/@media/gone.mp4' }), 'missing');
  // blob: / data: / 外部地址:和以前一样不打戳
  for (const url of ['blob:http://x/1', 'data:video/mp4;base64,AA', 'https://cdn.example/a.mp4']) {
    assert.equal(await unreachable.stamp({ url }), undefined, url);
  }
});

test('/@export/<id>/media/:导出自己的产物目录,照旧本地 stat;越界的地址不认', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-media-stamp-'));
  try {
    const file = path.join(root, 'export-job-7', 'media', 'replaced.png');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'png');
    const stat = await fs.stat(file);
    const stamper = createMediaStamper({ exportRoot: () => root, fetch: () => { throw new Error('不该发请求'); } });
    assert.equal(await stamper.stamp({ url: '/@export/job-7/media/replaced.png' }), `${stat.size}:${stat.mtimeMs}`);
    assert.equal(await stamper.stamp({ url: '/@export/job-7/media/absent.png' }), 'missing');
    assert.equal(exportMediaFile('/@export/job-7/media/../escape.png', root), null);
    assert.equal(exportMediaFile('/@export/job-7/media/replaced.png', root), file);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('真 HTTP:对一个答 HEAD 的素材服务打戳,内容变了戳跟着变', async () => {
  let body = Buffer.from('first');
  let mtime = new Date('2026-09-23T10:00:00Z');
  const heads = [];
  const server = http.createServer((req, res) => {
    heads.push(req.method);
    res.writeHead(200, { 'Content-Length': body.length, 'Last-Modified': mtime.toUTCString() });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let t = 0;
  const stamper = createMediaStamper({ mediaUrl: () => `${origin}/@media/clip.mp4`, now: () => t });
  try {
    const first = await stamper.stamp({ url: '/@media/clip.mp4' });
    assert.equal(first, `5:${mtime.toUTCString()}`);
    body = Buffer.from('second, longer'); mtime = new Date('2026-09-24T10:00:00Z');
    t += MEDIA_STAMP_TTL_MS;
    const second = await stamper.stamp({ url: '/@media/clip.mp4' });
    assert.notEqual(second, first);
    assert.deepEqual(heads, ['HEAD', 'HEAD']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('frame-pipeline 不再 import card-media-path,也不直接 stat 素材目录', async () => {
  const src = await fs.readFile(new URL('../frame-pipeline.mjs', import.meta.url), 'utf8');
  assert.ok(!/card-media-path|cardMediaPath/.test(src));
  assert.ok(/createMediaStamper/.test(src));
});
