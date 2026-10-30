import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { startAssetProjectFixture } from './fixtures/asset-project-service.mjs';
const bytes = Buffer.from('project owned media and artifact');
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
async function request(f, project, url, options = {}) { return fetch(`${f.base}${url}`, { ...options, headers: { Authorization: `Bearer ${project}-rw`, ...options.headers } }); }
async function upload(f, project, ns, content = bytes, key = hash) {
  const url = `/api/asset/${ns}/${key}`;
  assert.equal((await request(f, project, `${url}/0`, { method: 'PUT', headers: { 'X-Media-Size': String(content.length), 'X-Media-Ext': 'wav' }, body: content })).status, 200);
  assert.equal((await request(f, project, `${url}/complete`, { method: 'POST' })).status, 200);
}

test('真实HTTP：三命名空间GET/HEAD/Range/chunks/complete、query票据隔离，同hash分别上传', async t => {
  const f = await startAssetProjectFixture(); t.after(() => f.close());
  for (const ns of ['media', 'snap', 'px']) {
    await upload(f, 'A', ns);
    const url = `/api/asset/${ns}/${hash}`;
    for (const options of [{}, { method: 'HEAD' }, { headers: { Range: 'bytes=2-6' } }]) {
      assert.equal((await request(f, 'B', url, options)).status, 404);
      assert.equal((await request(f, 'A', url, options)).status, options.headers ? 206 : 200);
    }
    assert.equal((await (await request(f, 'B', `${url}/chunks`)).json()).size, null);
    assert.equal((await request(f, 'B', `${url}/complete`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${f.base}${url}?t=B-r`)).status, 404);
    assert.equal((await fetch(`${f.base}${url}?t=A-r`)).status, 200);
    await upload(f, 'B', ns);
    assert.deepEqual(Buffer.from(await (await request(f, 'B', url)).arrayBuffer()), bytes);
  }
  await f.factory.removeProject('A');
  for (const ns of ['media', 'snap', 'px']) assert.equal((await request(f, 'B', `/api/asset/${ns}/${hash}`)).status, 200);
});
test('真实HTTP：回环无证拒、旧media及PCM、local/tiers/私路径/adopt/remote目标不越项目', async t => {
  const f = await startAssetProjectFixture(); t.after(() => f.close());
  await upload(f, 'A', 'media');
  assert.equal((await fetch(`${f.base}/api/asset/media/${hash}`)).status, 401);
  assert.equal((await request(f, 'B', `/@media/${hash}`)).status, 404);
  assert.equal((await request(f, 'A', `/@media/${hash}`)).status, 200);
  assert.equal((await request(f, 'B', `/@media/${hash}/pcm?start=0&count=10&sampleRate=48000`)).status, 404);
  assert.deepEqual((await (await request(f, 'B', `/api/media/local?hashes=${hash}`)).json()).hashes, []);
  assert.equal((await (await request(f, 'B', `/api/media/tiers?hashes=${hash}`)).json()).items[hash].state, 'unknown');
  const file = path.join(f.factory.project('A').dirs.media, `${hash}.wav`);
  assert.equal((await request(f, 'B', `/api/media/file?path=${encodeURIComponent(file)}`)).status, 403);
  assert.equal((await request(f, 'B', `/api/media/adopt?path=${encodeURIComponent(file)}`, { method: 'POST' })).status, 403);
  const remote = await request(f, 'B', '/api/media/remote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: `${f.base}/api/asset`, ticket: 'A-r' }) });
  assert.equal(remote.status, 403); // 真实归属错误保留权限状态，不能配置跨项目remote
  assert.equal((await (await request(f, 'B', '/api/media/remote')).json()).base, null);
});
test('真实HTTP：上传流入独立项目目录，环境全局目录不能覆盖，输入不被改写', async t => {
  const f = await startAssetProjectFixture(); t.after(() => f.close());
  const old = process.env.PROMPTCUT_EXPORT_DIR;
  process.env.PROMPTCUT_EXPORT_DIR = path.join(f.out, 'wrong-global');
  t.after(() => { if (old === undefined) delete process.env.PROMPTCUT_EXPORT_DIR; else process.env.PROMPTCUT_EXPORT_DIR = old; });
  const res = await request(f, 'A', '/api/media/upload/demo.wav', { method: 'POST', body: bytes });
  assert.equal(res.status, 200);
  const result = await res.json(); assert.equal(result.projectId, 'A'); assert.equal(result.hash, hash);
  assert.equal((await request(f, 'B', `/@media/${hash}`)).status, 404);
  assert.deepEqual(await fs.readFile(path.join(f.factory.project('A').dirs.media, `${hash}.wav`)), bytes);
  const ownedFile = path.join(f.factory.project('A').dirs.media, 'already-local.wav'); await fs.writeFile(ownedFile, bytes);
  const adopted = await request(f, 'A', `/api/media/adopt?path=${encodeURIComponent(ownedFile)}`, { method: 'POST' }); assert.equal(adopted.status, 200); const adoptedBody = await adopted.json(); assert.equal(adoptedBody.projectId, 'A'); assert.equal(adoptedBody.hash, hash); assert.deepEqual(await fs.readFile(ownedFile), bytes);
});
test('真实HTTP：失权持续流立刻销毁、关闭确认后旧GET/Range/chunks拒绝，B不受影响', async t => {
  let stream;
  const f = await startAssetProjectFixture({ wrapStore: (_id, _ns, store) => new Proxy(store, { get(target, key) {
    if (key === 'read') return async () => { stream = new Readable({ read() {} }); stream.push(bytes.subarray(0, 2)); return stream; };
    return target[key];
  } }) }); t.after(() => f.close());
  await upload(f, 'A', 'media');
  const response = await request(f, 'A', `/api/asset/media/${hash}`);
  const body = response.arrayBuffer(); body.catch(() => {});
  await f.revoke('A');
  assert.equal(stream.closed, true);
  await assert.rejects(body);
  for (const suffix of ['', '/chunks']) assert.equal((await request(f, 'A', `/api/asset/media/${hash}${suffix}`)).status, 403);
  assert.equal((await request(f, 'B', `/api/asset/media/${hash}`)).status, 404);
});
test('真实shots缩略读口GET/HEAD按项目物理目录、已知文件名不跨读、失权拒', async t => {
  const f = await startAssetProjectFixture(); t.after(() => f.close());
  const a = f.shots.shotsDir(f.factory.project('A').root), b = f.shots.shotsDir(f.factory.project('B').root);
  await fs.mkdir(a, { recursive: true }); await fs.writeFile(path.join(a, 'same-thumb.jpg'), bytes);
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await request(f, 'A', '/api/shots/thumb/same-thumb.jpg', { method })).status, 200);
    assert.equal((await request(f, 'B', '/api/shots/thumb/same-thumb.jpg', { method })).status, 404);
  }
  await fs.mkdir(b, { recursive: true }); await fs.writeFile(path.join(b, 'same-thumb.jpg'), bytes);
  assert.equal((await request(f, 'B', '/api/shots/thumb/same-thumb.jpg')).status, 200);
  await f.revoke('A');
  assert.equal((await request(f, 'A', '/api/shots/thumb/same-thumb.jpg')).status, 403);
  assert.equal((await request(f, 'B', '/api/shots/thumb/same-thumb.jpg')).status, 200);
});
