/**
 * 素材按项目隔离：`asset-project-http.test.mjs` 没点到的入口（设计 `docs/plan/three-versions-018-design.md`「素材协议」表）。
 * 实际的素材服务、媒体路由与镜头缩略图模块架在回环 HTTP 上，权威是注入的夹具（项目 A、B 各一张读写票据）。
 * 同一个哈希先只进 A：B 在每个入口都读不到、排不进、收不了尾；撤销 A 后 A 正在读的流被关，B 的不受影响。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { startAssetProjectFixture } from './fixtures/asset-project-service.mjs';

const bytes = Buffer.from('project owned media for the remaining entries');
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
const request = (f, project, url, options = {}) => fetch(`${f.base}${url}`, { ...options, headers: { Authorization: `Bearer ${project}-rw`, ...options.headers } });
const status = async (f, project, url, options) => { const r = await request(f, project, url, options); await r.arrayBuffer(); return r.status; };
const post = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function upload(f, project, ns, content = bytes, ext = 'wav') {
  const key = crypto.createHash('sha256').update(content).digest('hex'), url = `/api/asset/${ns}/${key}`, chunk = 8 * 1024 * 1024;
  for (let n = 0; n * chunk < Math.max(1, content.length); n++)
    assert.equal(await status(f, project, `${url}/${n}`, { method: 'PUT', headers: { 'X-Media-Size': String(content.length), 'X-Media-Ext': ext }, body: content.subarray(n * chunk, (n + 1) * chunk) }), 200);
  assert.equal(await status(f, project, `${url}/complete`, { method: 'POST' }), 200);
  return key;
}
/** 读到第一块就停住：服务端那条流被背压顶住一直开着；`resume()` 之后 `closed` 兑现成 `{ complete, bytes }` */
function stalledRead(f, project, url) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${f.base}${url}`, { headers: { Authorization: `Bearer ${project}-rw` }, agent: false }, res => {
      let got = 0, ended = false, stalled = true, settle;
      const closed = new Promise(done => { settle = done; });
      res.on('data', chunk => { got += chunk.length; if (stalled) res.pause(); });
      res.on('end', () => { ended = true; }); res.on('error', () => {});
      res.on('close', () => settle({ complete: ended && res.complete, bytes: got }));
      res.once('data', () => resolve({ status: res.statusCode, closed, resume() { stalled = false; res.resume(); } }));
    });
    req.on('error', reject);
  });
}

test('真实HTTP：小尺寸补转、上传队列、预取、原尺寸检查、带扩展名的旧读口都不越项目', async t => {
  const f = await startAssetProjectFixture(); t.after(() => f.close());
  await upload(f, 'A', 'media');
  assert.equal(await status(f, 'A', `/@media/${hash}.wav`), 200);
  assert.equal(await status(f, 'B', `/@media/${hash}.wav`), 404);
  const backfill = project => request(f, project, '/api/media/tiers/backfill', post({ items: [{ hash, name: 'x.wav' }] })).then(r => r.json());
  assert.equal((await backfill('B')).items[hash].state, 'absent');
  assert.notEqual((await backfill('A')).items[hash].state, 'absent');
  const enqueued = await (await request(f, 'B', '/api/media/upload-queue/enqueue', post({ hashes: [hash] }))).json();
  assert.deepEqual(enqueued.queued ?? [], []); assert.ok(enqueued.ok === false || enqueued.missing.includes(hash));
  const queue = await request(f, 'B', '/api/media/upload-queue'); assert.equal(queue.status, 200); assert.ok(!(await queue.text()).includes(hash));
  assert.equal(await status(f, 'B', '/api/media/upload-queue/target', post({ base: `${f.base}/api/asset`, ticket: 'A-rw' })), 403);
  assert.equal((await (await request(f, 'B', '/api/media/prefetch', post({ items: [{ hash, name: 'x.wav' }] }))).json()).queued, 0);
  assert.equal(await status(f, 'B', `/@media/${hash}`), 404, '预取之后仍读不到');
  const originals = await (await request(f, 'B', '/api/media/originals', post({ hashes: [hash] }))).json();
  assert.equal(originals.remote, null); assert.deepEqual(originals.missing, [hash]);
});

test('真实HTTP：A 传了一片没收尾的，B 看不到也收不了尾；只读票据与查询串票据不能写', async t => {
  const f = await startAssetProjectFixture(); t.after(() => f.close());
  for (const ns of ['media', 'snap', 'px']) {
    const url = `/api/asset/${ns}/${hash}`;
    assert.equal(await status(f, 'A', `${url}/0`, { method: 'PUT', headers: { 'X-Media-Size': String(bytes.length), 'X-Media-Ext': 'wav' }, body: bytes }), 200);
    const seen = await (await request(f, 'B', `${url}/chunks`)).json();
    assert.equal(seen.size, null); assert.deepEqual(seen.received, []);
    assert.equal(await status(f, 'B', `${url}/complete`, { method: 'POST' }), 404);
    assert.equal(await status(f, 'A', `${url}/chunks`), 200);
    assert.equal((await fetch(`${f.base}${url}/complete`, { method: 'POST', headers: { Authorization: 'Bearer A-r' } })).status, 403);
    // 查询串票据在这个夹具里按只读票据拒（403）；真实的独立素材服务更早一步，非 GET/HEAD 不认查询串（401，探针里验）
    assert.equal((await fetch(`${f.base}${url}/complete?t=A-r`, { method: 'POST' })).status, 403);
    assert.equal(await status(f, 'A', `${url}/complete`, { method: 'POST' }), 200);
    assert.equal(await status(f, 'B', url), 404);
  }
});

test('真实HTTP：撤销后 A 在 /api/asset 三命名空间与 /@media 上正在读的流都被关，B 同哈希的流读完整件', { timeout: 60000 }, async t => {
  const f = await startAssetProjectFixture(); t.after(() => f.close());
  const big = Buffer.alloc(20 * 1024 * 1024); for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE((i * 2654435761) >>> 0, i);
  let key;
  for (const ns of ['media', 'snap', 'px']) key = await upload(f, 'A', ns, big, 'bin');
  await upload(f, 'B', 'media', big, 'bin');
  const routes = [`/api/asset/media/${key}`, `/api/asset/snap/${key}`, `/api/asset/px/${key}`, `/@media/${key}`];
  const reads = []; for (const url of routes) reads.push(await stalledRead(f, 'A', url));
  const other = await stalledRead(f, 'B', `/@media/${key}`);
  for (const read of [...reads, other]) assert.equal(read.status, 200);
  await f.revoke('A'); // 夹具等每个订阅者的回调返回：回调要等服务端那条流真的关掉
  for (const [n, read] of reads.entries()) {
    read.resume(); const end = await read.closed;
    assert.equal(end.complete, false, `${routes[n]} 没有被关`); assert.ok(end.bytes < big.length);
  }
  for (const url of routes) assert.equal(await status(f, 'A', url, { headers: { Range: 'bytes=0-1' } }), 403);
  other.resume(); assert.deepEqual(await other.closed, { complete: true, bytes: big.length });
});
