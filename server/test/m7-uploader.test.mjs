/**
 * M7 页面上传器(`src/online/snapUploader.ts`,契约第 4.5 节、D7):对着真的素材服务 HTTP 层(`fake-asset-service.mjs` 转译的
 * `asset-service.ts`,memory 存储)推 `snap` / `px` 块。
 *   - 对账 → 缺的分片 PUT(每片带大小与扩展名)→ complete,之后 `has` 为真;已有的跳过;
 *   - 写入凭 rw 票据,手里那张被拒(401)就强制换一张、这一步重试一次;
 *   - 哈希对不上 complete 回 409,抛出(可重试);
 *   - 同一哈希按单飞推;收尾回 incomplete 时重查 chunks 补传一次(探针 P4)。
 * 跑:node --test server/test/m7-uploader.test.mjs
 */
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createAssetHarness } from './fake-asset-service.mjs';
import { createSnapUploader, sha256Hex, CHUNK_SIZE } from '../../src/online/snapUploader.ts';

const harness = createAssetHarness();
after(() => harness.cleanup());
const { assetTicketKit } = await import('./fake-shared-env.mjs');
const KIT = await assetTicketKit();

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('M7-UP-01 推 snap 与 px:对账、PUT、complete;已有的跳过;401 换票据重试一次;哈希与 WebCrypto 算的一致', async () => {
  const srv = await harness.serve({ tickets: KIT.tickets, isTrusted: () => false });
  const issued = [];
  const ticket = async (force) => {
    issued.push(!!force);
    // 第一张是坏的(模拟过期),强制换时给真的
    return force ? KIT.issue('rw') : 'v1.bad.ticket';
  };
  const up = createSnapUploader({ base: () => srv.base, ticket });
  const html = Buffer.from('<div class="pc-snap">hello 快照</div>', 'utf8');
  const webp = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 fake-bytes', 'latin1');
  const h1 = await sha256Hex(new Uint8Array(html));
  assert.equal(h1, sha256(html));
  const h2 = await sha256Hex(new Uint8Array(webp));
  assert.equal(await up.has('snap', h1), false);
  assert.equal(await up.put('snap', h1, new Uint8Array(html), 'html'), 'pushed');
  assert.equal(await up.put('px', h2, new Uint8Array(webp), 'webp'), 'pushed');
  assert.equal(await up.has('snap', h1), true);
  assert.equal(await up.has('px', h2), true);
  assert.equal(await up.put('snap', h1, new Uint8Array(html), 'html'), 'skipped');
  const st = up.stats();
  assert.deepEqual([st.pushed, st.skipped, st.failed], [2, 1, 0]);
  assert.equal(st.pushedBytes, html.length + webp.length);
  assert.ok(st.reauth >= 1 && issued.includes(true), '401 之后强制换了票据');
  // 取回来的字节就是推上去的
  const got = await fetch(`${srv.base}/snap/${h1}`, { headers: { Authorization: `Bearer ${KIT.issue('r')}` } });
  assert.equal(got.status, 200);
  assert.equal(Buffer.from(await got.arrayBuffer()).equals(html), true);
  assert.equal(JSON.stringify(st).includes(KIT.issue('rw').slice(0, 20)), false, '诊断里没有票据');
  await srv.close();
});

test('M7-UP-02 哈希不符 complete 回 409 抛出(可重试);没有素材服务抛出', async () => {
  const chunk = 1024;
  const srv = await harness.serve({ chunkSize: chunk, tickets: KIT.tickets, isTrusted: () => false });
  assert.equal(CHUNK_SIZE, 8 * 1024 * 1024);
  const up = createSnapUploader({ base: () => srv.base, ticket: async () => KIT.issue('rw') });
  const small = Buffer.alloc(600, 7);
  const wrong = sha256(Buffer.from('other'));
  await assert.rejects(up.put('snap', wrong, new Uint8Array(small), 'html'), (e) => e.retryable === true && /409/.test(e.message));
  assert.equal(up.stats().failed, 1);
  const none = createSnapUploader({ base: () => null, ticket: async () => null });
  await assert.rejects(none.put('snap', sha256(small), new Uint8Array(small), 'html'), /还没有远程素材服务/);
  assert.equal(await none.has('snap', sha256(small)), false);
  await srv.close();
});

test('M7-UP-03 同一哈希并发推只推一次(单飞),另一个等它的结果;对着真素材服务', async () => {
  const srv = await harness.serve({ tickets: KIT.tickets, isTrusted: () => false });
  const puts = [];
  const f = async (url, init) => { if (init?.method === 'PUT') puts.push(url); return fetch(url, init); };
  const up = createSnapUploader({ base: () => srv.base, ticket: async () => KIT.issue('rw'), fetch: f });
  const body = Buffer.from('<p>同一块</p>', 'utf8');
  const h = sha256(body);
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => up.put('snap', h, new Uint8Array(body), 'html')));
  assert.deepEqual([a, b, c].sort(), ['pushed', 'skipped', 'skipped']);
  assert.equal(puts.length, 1, '只 PUT 了一次');
  assert.equal(await up.has('snap', h), true);
  await srv.close();
});

test('M7-UP-04 收尾回 400 incomplete:重查 chunks、补传一次再收尾', async () => {
  const body = new Uint8Array(Buffer.from('<p>x</p>', 'utf8'));
  const h = sha256(Buffer.from(body));
  let completes = 0, puts = 0, chunkCalls = 0;
  const json = (status, obj) => ({ ok: status < 300, status, json: async () => obj });
  const f = async (url, init) => {
    if (url.endsWith('/chunks')) { chunkCalls++; return json(200, { size: null, chunkSize: 8388608, received: [], complete: false }); }
    if (init?.method === 'PUT') { puts++; return json(200, { ok: true }); }
    if (url.endsWith('/complete')) { completes++; return completes === 1 ? json(400, { error: 'incomplete', missing: [0] }) : json(200, { ok: true, complete: true }); }
    return json(404, {});
  };
  const up = createSnapUploader({ base: () => 'https://h.example/api/asset', ticket: async () => 't', fetch: f });
  assert.equal(await up.put('snap', h, body, 'html'), 'pushed');
  assert.deepEqual({ completes, puts, chunkCalls, recheck: up.stats().recheck }, { completes: 2, puts: 2, chunkCalls: 2, recheck: 1 });
  // 第二次还是 incomplete:抛(可重试),不无限重来
  completes = 0;
  const f2 = async (url, init) => (url.endsWith('/complete') ? json(400, { error: 'incomplete', missing: [0] }) : f(url, init));
  const up2 = createSnapUploader({ base: () => 'https://h.example/api/asset', ticket: async () => 't', fetch: f2 });
  await assert.rejects(up2.put('snap', h, body, 'html'), (e) => e.retryable === true && /incomplete/.test(e.message));
});
