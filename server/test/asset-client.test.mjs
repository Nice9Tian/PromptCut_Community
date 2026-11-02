/**
 * 素材服务客户端 `server/asset-store/client.mjs`（契约 `docs/plan/artifact-transfer-contract.md` 第 2 节，
 * 第 7 节用例 L1～L5）。
 * 跑：node --test server/test/asset-client.test.mjs
 *
 * 只照契约写，不看实现。真 HTTP：素材服务（`fake-asset-service.mjs`，端口 0，三个命名空间都是 memory 实现）。
 * 客户端的 `fetch` 注入一层记录（必要时改写回包），用来数请求、看请求头、模拟 5xx / 网络错 / 篡改。
 *
 * `client.mjs` 还不存在时每条用例各自失败、报原因。
 */
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createAssetHarness } from './fake-asset-service.mjs';

const harness = createAssetHarness();
after(() => harness.cleanup());

let clientMod = null, clientError = null;
try { clientMod = await import('../asset-store/client.mjs'); } catch (err) { clientError = err; }
function createAssetClient(opts) {
  if (clientError) throw new Error(`Cannot load server/asset-store/client.mjs: ${clientError.message}`);
  return clientMod.createAssetClient(opts);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function bytesOf(size, seed) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}
const randomToken = () => crypto.randomBytes(24).toString('base64url');
const { assetTicketKit } = await import('./fake-shared-env.mjs');

/**
 * 记录每个请求的 fetch。`hook(info)` 可以返回一个 Response（或抛错）来代替真的请求；返回 undefined 就照常发。
 * 回的 `log` 每项 `{ method, url, path, headers }`，`headers` 的键小写。
 */
function recordingFetch(hook = () => undefined) {
  const log = [];
  const fn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const headers = {};
    new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined) || {}).forEach((v, k) => { headers[k] = v; });
    const info = { method, url, path: new URL(url).pathname, headers };
    log.push(info);
    const replaced = await hook(info, log);
    if (replaced !== undefined) return replaced;
    return globalThis.fetch(input, init);
  };
  return { fetch: fn, log };
}
const isChunkPut = (info) => info.method === 'PUT' && /\/\d+$/.test(info.path);
const isWrite = (info) => info.method === 'PUT' || info.method === 'POST';
const chunkNo = (info) => Number(info.path.split('/').pop());

/* ------------------------------------------------------------------ L1 */

test('L1 after put, has is true and the bytes returned by get are identical; putting the same content again gives uploaded: false and sends no PUT at all', async () => {
  const srv = await harness.serve({ chunkSize: 1024, isTrusted: () => true, token: null });
  const rec = recordingFetch();
  const client = createAssetClient({ base: srv.base, fetch: rec.fetch, chunkSize: 1024 });
  for (const [ns, size, ext] of [['snap', 700, 'html'], ['px', 2500, 'm4s'], ['media', 1, 'png']]) {
    const buf = bytesOf(size, size);
    const hash = sha256(buf);
    assert.equal(await client.has(ns, hash), false, `${ns} is absent before upload`);
    assert.equal(await client.get(ns, hash), null, `${ns} get returns null before upload`);
    const first = await client.put(ns, buf, { ext });
    assert.deepEqual(first, { hash, size, uploaded: true }, `${ns} first put`);
    assert.equal(await client.has(ns, hash), true, `${ns} has after put`);
    const got = await client.get(ns, hash);
    assert.ok(Buffer.isBuffer(got), `${ns} get returns a Buffer`);
    assert.ok(got.equals(buf), `${ns} retrieved bytes are identical`);
    // 扩展名随 X-Media-Ext 带上
    assert.equal((await srv.stores[ns].stat(hash))?.ext, ext, `${ns} extension`);
    // 只进了这一个命名空间
    for (const other of ['media', 'snap', 'px'].filter((x) => x !== ns)) {
      assert.equal(await srv.stores[other].stat(hash), null, `${ns}'s chunk must not appear in ${other}`);
    }

    const before = rec.log.length;
    const again = await client.put(ns, buf, { ext });
    assert.deepEqual(again, { hash, size, uploaded: false }, `${ns} put the same content again`);
    const second = rec.log.slice(before);
    assert.deepEqual(second.filter((i) => i.method === 'PUT'), [], `${ns} second put sends no PUT`);
    assert.deepEqual(second.filter((i) => i.method === 'POST'), [], `${ns} second put sends no finalize`);
    assert.ok(second.some((i) => i.method === 'GET' && i.path.endsWith(`/${ns}/${hash}/chunks`)), `${ns} second put queried chunks first`);
  }
  // 请求都落在 base 下、按 <ns>/<hash>… 寻址
  for (const info of rec.log) assert.ok(info.url.startsWith(`${srv.base}/`), info.url);
});

/* ------------------------------------------------------------------ L2 */

test('L2 object larger than one chunk: re-upload only the missing chunks (pre-seed received to simulate an interrupted upload), every chunk carries X-Media-Size and X-Media-Ext', async () => {
  const CHUNK = 1024;
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null });
  const size = CHUNK * 5 + 123; // 6 片
  const buf = bytesOf(size, 7);
  const hash = sha256(buf);
  // 预置：第 0、2、5 片已经到了（直接打 HTTP）
  for (const n of [0, 2, 5]) {
    const r = await fetch(`${srv.base}/px/${hash}/${n}`, { method: 'PUT', body: buf.subarray(n * CHUNK, Math.min(size, (n + 1) * CHUNK)), headers: { 'X-Media-Size': String(size), 'X-Media-Ext': 'm4s' } });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  }
  const rec = recordingFetch();
  const client = createAssetClient({ base: srv.base, fetch: rec.fetch, chunkSize: CHUNK });
  const out = await client.put('px', buf, { ext: 'm4s' });
  assert.deepEqual(out, { hash, size, uploaded: true });
  const puts = rec.log.filter(isChunkPut);
  assert.deepEqual(puts.map(chunkNo).sort((a, b) => a - b), [1, 3, 4], 're-upload only the missing chunks');
  for (const info of puts) {
    assert.equal(info.headers['x-media-size'], String(size), `chunk ${chunkNo(info)} carries X-Media-Size`);
    assert.equal(info.headers['x-media-ext'], 'm4s', `chunk ${chunkNo(info)} carries X-Media-Ext`);
    assert.ok(info.path.endsWith(`/px/${hash}/${chunkNo(info)}`), info.path);
  }
  const posts = rec.log.filter((i) => i.method === 'POST');
  assert.equal(posts.length, 1, 'finalize once');
  assert.ok(posts[0].path.endsWith(`/px/${hash}/complete`));
  assert.ok(rec.log.indexOf(posts[0]) > rec.log.indexOf(puts.at(-1)), 'finalize comes after all chunks');
  assert.ok(rec.log[0].method === 'GET' && rec.log[0].path.endsWith(`/px/${hash}/chunks`), 'query chunks first');
  const got = await client.get('px', hash);
  assert.ok(got.equals(buf));

  // 一片都没有的大对象：全部分片都传一遍
  const b2 = bytesOf(CHUNK * 3, 8);
  const rec2 = recordingFetch();
  const c2 = createAssetClient({ base: srv.base, fetch: rec2.fetch, chunkSize: CHUNK });
  assert.equal((await c2.put('snap', b2, { ext: 'html' })).uploaded, true);
  assert.deepEqual(rec2.log.filter(isChunkPut).map(chunkNo).sort((a, b) => a - b), [0, 1, 2]);

  // 契约第 10 节第 4 条：切片大小以服务端 chunks 回包的 chunkSize 为准，客户端的选项只作兜底
  for (const clientChunk of [4096, 256, undefined]) {
    const b3 = bytesOf(CHUNK * 2 + 50, 30 + (clientChunk ?? 0));
    const rec3 = recordingFetch();
    const c3 = createAssetClient({ base: srv.base, fetch: rec3.fetch, ...(clientChunk ? { chunkSize: clientChunk } : {}) });
    assert.equal((await c3.put('px', b3)).uploaded, true, `client chunkSize ${clientChunk}`);
    assert.deepEqual(rec3.log.filter(isChunkPut).map(chunkNo).sort((a, b) => a - b), [0, 1, 2], `client chunkSize ${clientChunk}: split into 3 chunks by the server's 1 KiB`);
    assert.ok((await c3.get('px', sha256(b3))).equals(b3));
  }
});

/* ------------------------------------------------------------------ L3 */

test('L3 a chunk returns 500 twice, then succeeds: succeeds after retries; network errors are retried the same way; 4xx throws immediately, and the error carries the status and response body', async () => {
  const CHUNK = 1024;
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null });
  const size = CHUNK * 3 + 9;
  const buf = bytesOf(size, 9);
  const hash = sha256(buf);
  let failed = 0;
  const rec = recordingFetch((info) => {
    if (isChunkPut(info) && chunkNo(info) === 1 && failed < 2) {
      failed++;
      return new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return undefined;
  });
  const client = createAssetClient({ base: srv.base, fetch: rec.fetch, chunkSize: CHUNK, retries: 3 });
  const t0 = Date.now();
  const out = await client.put('snap', buf, { ext: 'html' });
  const took = Date.now() - t0;
  assert.deepEqual(out, { hash, size, uploaded: true });
  const tries1 = rec.log.filter((i) => isChunkPut(i) && chunkNo(i) === 1).length;
  assert.equal(tries1, 3, 'chunk 1: two 500s + one success');
  for (const n of [0, 2, 3]) assert.equal(rec.log.filter((i) => isChunkPut(i) && chunkNo(i) === n).length, 1, `chunk ${n} is sent only once (retries are per chunk, not the whole file again)`);
  assert.ok(took >= 550, `intervals 200 ms, 400 ms: two retries wait at least about 600 ms, actual ${took} ms`);
  assert.ok((await client.get('snap', hash)).equals(buf));

  // 网络错误（fetch 本身抛）：同样按片重试
  const b2 = bytesOf(CHUNK + 1, 10);
  let dropped = 0;
  const rec2 = recordingFetch((info) => {
    if (isChunkPut(info) && chunkNo(info) === 0 && dropped < 1) { dropped++; throw new TypeError('fetch failed'); }
    return undefined;
  });
  const c2 = createAssetClient({ base: srv.base, fetch: rec2.fetch, chunkSize: CHUNK, retries: 3 });
  assert.equal((await c2.put('px', b2, { ext: 'm4s' })).uploaded, true, 'succeeds after one network error');
  assert.equal(rec2.log.filter((i) => isChunkPut(i) && chunkNo(i) === 0).length, 2);

  // 契约第 10 节第 5 条：重试也用于 chunks、complete、get
  const b6 = bytesOf(CHUNK + 40, 21);
  const h6 = sha256(b6);
  const hits = { chunks: 0, complete: 0, get: 0 };
  const rec6 = recordingFetch((info) => {
    const kind = info.method === 'GET' && info.path.endsWith('/chunks') ? 'chunks'
      : info.method === 'POST' && info.path.endsWith('/complete') ? 'complete'
        : info.method === 'GET' && info.path.endsWith(`/${h6}`) ? 'get' : null;
    if (!kind) return undefined;
    hits[kind]++;
    if (hits[kind] === 1) return new Response('{"ok":false,"error":"flaky"}', { status: 502, headers: { 'Content-Type': 'application/json' } });
    return undefined;
  });
  const c6 = createAssetClient({ base: srv.base, fetch: rec6.fetch, retries: 3 });
  assert.equal((await c6.put('snap', b6)).uploaded, true, 'succeeds after chunks and complete each return 502 once');
  assert.ok((await c6.get('snap', h6)).equals(b6), 'get succeeds after returning 502 once');
  assert.ok(hits.chunks >= 2 && hits.complete === 2 && hits.get === 2, `each retried once: ${JSON.stringify(hits)}`);

  // 重试用完：抛出
  const b3 = bytesOf(100, 11);
  const rec3 = recordingFetch((info) => (isChunkPut(info)
    ? new Response(JSON.stringify({ ok: false, error: 'down' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    : undefined));
  const c3 = createAssetClient({ base: srv.base, fetch: rec3.fetch, chunkSize: CHUNK, retries: 2 });
  await assert.rejects(c3.put('px', b3), '5xx persists: throws once retries are used up');
  assert.equal(rec3.log.filter(isChunkPut).length, 3, 'retries: 2 → first attempt + 2 retries');

  // 4xx：不重试，直接抛，错误带 status 和回包（真服务：配了票据核对器、非本机、客户端不带票据 → 401）
  // M6a：读也要票据，所以 401 出在第一个请求（对账 GET chunks）上，原来出在第一片 PUT 上；「只发一次、不重试」的断言不变
  const lockKit = await assetTicketKit();
  const locked = await harness.serve({ chunkSize: CHUNK, isTrusted: () => false, tickets: lockKit.tickets });
  const rec4 = recordingFetch();
  // 「不等重试间隔」只看客户端自己花的时间：总耗时减去花在 fetch（真 HTTP 往返、服务端核票）里的时间。
  // 机器忙时往返本身会慢，但那不是重试间隔；客户端若睡了第一次重试间隔（200 ms），这段时间至少 200 ms，照样拦得住。
  let inFetchMs = 0;
  const timedFetch = async (...args) => {
    const s = Date.now();
    try { return await rec4.fetch(...args); } finally { inFetchMs += Date.now() - s; }
  };
  const c4 = createAssetClient({ base: locked.base, fetch: timedFetch, chunkSize: CHUNK, retries: 3 });
  const t1 = Date.now();
  const err = await c4.put('snap', bytesOf(300, 12)).then(() => null, (e) => e);
  assert.ok(err instanceof Error, '4xx throws');
  assert.equal(err.status, 401, 'error carries status');
  const own = Object.fromEntries(Object.getOwnPropertyNames(err).filter((k) => k !== 'stack' && k !== 'message' && k !== 'status').map((k) => [k, err[k]]));
  assert.match(JSON.stringify(own), /unauthorized/, `error carries the response body: ${JSON.stringify(own)}`);
  assert.equal(rec4.log.length, 1, '4xx is not retried');
  const ownMs = Date.now() - t1 - inFetchMs;
  assert.ok(ownMs < 150, `4xx does not wait for the retry interval: the client itself spent ${ownMs} ms outside fetch (${inFetchMs} ms inside fetch)`);
  // 只读票据写入：403 同样不重试（第一片 PUT 上）
  const rec4b = recordingFetch();
  const readOnly = lockKit.issue('r');
  const c4b = createAssetClient({ base: locked.base, fetch: rec4b.fetch, chunkSize: CHUNK, retries: 3, ticket: () => readOnly });
  const err4b = await c4b.put('snap', bytesOf(300, 12)).then(() => null, (e) => e);
  assert.equal(err4b?.status, 403);
  assert.equal(rec4b.log.filter(isChunkPut).length, 1, '403 is not retried');

  // 服务端回的 4xx 不是 401 也一样（假回包 409）
  const rec5 = recordingFetch((info) => (isChunkPut(info)
    ? new Response(JSON.stringify({ ok: false, error: 'size-mismatch', size: 1 }), { status: 409, headers: { 'Content-Type': 'application/json' } })
    : undefined));
  const c5 = createAssetClient({ base: srv.base, fetch: rec5.fetch, chunkSize: CHUNK, retries: 3 });
  const e5 = await c5.put('snap', bytesOf(50, 13)).then(() => null, (e) => e);
  assert.equal(e5?.status, 409);
  assert.equal(rec5.log.filter(isChunkPut).length, 1);
});

/* ------------------------------------------------------------------ L4 */

test('L4 bytes returned by get are tampered with: throws; 404 returns null', async () => {
  const srv = await harness.serve({ chunkSize: 1024, isTrusted: () => true, token: null });
  const buf = bytesOf(1500, 14);
  const hash = sha256(buf);
  const plain = createAssetClient({ base: srv.base, chunkSize: 1024 });
  await plain.put('snap', buf, { ext: 'html' });
  assert.ok((await plain.get('snap', hash)).equals(buf));

  const isBlobGet = (info) => info.method === 'GET' && info.path.endsWith(`/${hash}`);
  // 翻一个字节
  const flip = recordingFetch(async (info) => {
    if (!isBlobGet(info)) return undefined;
    const real = Buffer.from(await (await globalThis.fetch(info.url)).arrayBuffer());
    real[10] ^= 0xff;
    return new Response(real, { status: 200, headers: { 'Content-Type': 'text/html', 'Content-Length': String(real.length) } });
  });
  await assert.rejects(createAssetClient({ base: srv.base, fetch: flip.fetch, chunkSize: 1024 }).get('snap', hash), 'bytes altered: throws when the sha256 check fails');
  // 少一截
  const cut = recordingFetch(() => undefined);
  const cutFetch = async (url, init) => {
    const info = { method: String(init?.method || 'GET').toUpperCase(), path: new URL(url).pathname };
    if (isBlobGet(info)) return new Response(buf.subarray(0, 1000), { status: 200 });
    return cut.fetch(url, init);
  };
  await assert.rejects(createAssetClient({ base: srv.base, fetch: cutFetch, chunkSize: 1024 }).get('snap', hash), 'also throws when bytes are missing');
  // 换成别的内容
  const other = recordingFetch((info) => (isBlobGet(info) ? new Response(bytesOf(1500, 15), { status: 200 }) : undefined));
  await assert.rejects(createAssetClient({ base: srv.base, fetch: other.fetch, chunkSize: 1024 }).get('snap', hash));

  // 404：回 null，不抛
  const missing = sha256(Buffer.from('never uploaded'));
  assert.equal(await plain.get('snap', missing), null);
  assert.equal(await plain.get('px', hash), null, 'not present in the other namespace: null');
  assert.equal(await plain.has('px', hash), false);
});

/* ------------------------------------------------------------------ L5 */

// M6a（auth-contract 第 8、11 节）：集群令牌换成 `ticket()`。原来测「带令牌时每个写请求都有 Bearer、异常里没有令牌原文」；
// 现在读写都要票据，所以测每个请求都带 Bearer <票据>；另测 401 时换票重试一次、给 token 选项就抛。异常里不带票据原文的断言不变。
test('L5 with a ticket, every request carries Authorization: Bearer <ticket>; on 401 it swaps in a new ticket and retries once; the error message contains no raw ticket', async () => {
  const kit = await assetTicketKit();
  const ticket = kit.issue('rw');
  const srv = await harness.serve({ chunkSize: 1024, isTrusted: () => false, tickets: kit.tickets });
  const rec = recordingFetch();
  let asked = 0;
  const client = createAssetClient({ base: srv.base, ticket: () => { asked += 1; return ticket; }, fetch: rec.fetch, chunkSize: 1024 });
  const buf = bytesOf(3000, 16);
  const hash = sha256(buf);
  assert.deepEqual(await client.put('px', buf, { ext: 'm4s' }), { hash, size: 3000, uploaded: true });
  assert.ok((await client.get('px', hash)).equals(buf));
  assert.equal(await client.has('px', hash), true);
  const writes = rec.log.filter(isWrite);
  assert.ok(writes.length >= 4, `3 chunks + finalize, actual ${writes.length}`);
  for (const info of rec.log) assert.equal(info.headers.authorization, `Bearer ${ticket}`, `${info.method} ${info.path}`);
  assert.equal(asked, rec.log.length, 'one ticket fetched per request');

  // 没给 ticket 的客户端：不发 Authorization（服务端回 401）
  const rec0 = recordingFetch();
  const bare = createAssetClient({ base: srv.base, fetch: rec0.fetch, chunkSize: 1024 });
  const e0 = await bare.put('snap', bytesOf(10, 17)).then(() => null, (e) => e);
  assert.equal(e0?.status, 401);
  for (const info of rec0.log) assert.equal(info.headers.authorization, undefined);
  // ticket() 回 null：同样不带
  const recNull = recordingFetch();
  const eNull = await createAssetClient({ base: srv.base, fetch: recNull.fetch, chunkSize: 1024, ticket: () => null }).put('snap', bytesOf(10, 17)).then(() => null, (e) => e);
  assert.equal(eNull?.status, 401);
  for (const info of recNull.log) assert.equal(info.headers.authorization, undefined);

  // 401 → ticket({ refresh: true }) 换一张再试一次：旧票据作废（改口令，代数加一）之后换来的新票据能用
  const stale = kit.issue('rw');
  kit.bump((d) => { d.generation += 1; });
  const calls = [];
  const renew = createAssetClient({ base: srv.base, fetch: recordingFetch().fetch, chunkSize: 1024, ticket: (opts) => { calls.push(opts?.refresh === true); return opts?.refresh ? kit.issue('rw') : stale; } });
  const b2 = bytesOf(500, 21);
  assert.equal((await renew.put('snap', b2)).uploaded, true, 'succeeds after swapping the ticket');
  assert.ok(calls.includes(true), `a ticket swap is required after 401: ${JSON.stringify(calls)}`);
  // 换了还是 401：只重试这一次就抛
  const recBad = recordingFetch();
  const wrong = `${kit.issue('rw')}x`;
  const bad = createAssetClient({ base: srv.base, ticket: () => wrong, fetch: recBad.fetch, chunkSize: 1024 });
  const e1 = await bad.put('snap', bytesOf(20, 18)).then(() => null, (e) => e);
  assert.equal(e1?.status, 401);
  assert.equal(recBad.log.length, 2, '401 swaps the ticket and retries only once');

  // 5xx 重试用完：同样不带票据原文
  const good = kit.issue('rw');
  const down = recordingFetch((info) => (isWrite(info) ? new Response('{"ok":false}', { status: 500, headers: { 'Content-Type': 'application/json' } }) : undefined));
  const e2 = await createAssetClient({ base: srv.base, ticket: () => good, fetch: down.fetch, chunkSize: 1024, retries: 1 }).put('snap', bytesOf(30, 19)).then(() => null, (e) => e);
  assert.ok(e2 instanceof Error, '5xx must throw once retries are used up');
  // 网络错：同样
  const net = async () => { throw new TypeError(`fetch failed`); };
  const e3 = await createAssetClient({ base: srv.base, ticket: () => good, fetch: net, chunkSize: 1024, retries: 1 }).put('snap', bytesOf(40, 20)).then(() => null, (e) => e);
  assert.ok(e3 instanceof Error, 'network error must throw once retries are used up');

  const dump = (err) => {
    const parts = [String(err), err?.message, err?.stack];
    for (const k of Object.getOwnPropertyNames(err ?? {})) { try { parts.push(JSON.stringify(err[k])); } catch { parts.push(String(err[k])); } }
    if (err?.cause) parts.push(dump(err.cause));
    return parts.join('\n');
  };
  assert.ok(!dump(e1).includes(wrong), 'the 401 exception contains the raw ticket');
  assert.ok(!dump(e2).includes(good), 'the 5xx exception contains the raw ticket');
  assert.ok(!dump(e3).includes(good), 'the network error exception contains the raw ticket');

  // 集群令牌不再用于素材服务：给 token 选项直接抛
  assert.throws(() => createAssetClient({ base: srv.base, token: randomToken() }), TypeError);
});

/* ------------------------------------------------------------------ L6（契约第 10 节第 5 条） */

test('L6 a fake fetch never returns: timeoutMs aborts on time and the request is retried as a network error; once retries are used up it throws code: timeout, sending retries + 1 requests in total', async () => {
  const srv = await harness.serve({ chunkSize: 1024, isTrusted: () => true, token: null });
  /** 永不返回的 fetch：只在收到中止信号时拒绝（真 fetch 也是这样响应 AbortSignal 的） */
  const hanging = () => {
    const calls = [];
    const fn = (url, init = {}) => {
      calls.push({ url: String(url), method: String(init.method || 'GET').toUpperCase() });
      return new Promise((_, reject) => {
        const signal = init.signal;
        if (signal?.aborted) return reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        signal?.addEventListener?.('abort', () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
      });
    };
    return { fetch: fn, calls };
  };
  const hash = sha256(Buffer.from('whatever'));
  for (const [what, run, retries] of [
    ['get', (c) => c.get('snap', hash), 2],
    ['has', (c) => c.has('px', hash), 1],
    ['put', (c) => c.put('snap', bytesOf(64, 51)), 2],
  ]) {
    const h = hanging();
    const client = createAssetClient({ base: srv.base, fetch: h.fetch, timeoutMs: 40, retries });
    const t0 = Date.now();
    const err = await Promise.race([
      run(client).then(() => new Error('should not have succeeded'), (e) => e),
      new Promise((resolve) => setTimeout(() => resolve('hang'), 8000).unref()),
    ]);
    assert.notEqual(err, 'hang', `${what}: not aborted on time, hangs forever`);
    assert.ok(err instanceof Error, `${what}: throws`);
    assert.equal(err.code, 'timeout', `${what}: error carries code: 'timeout' (actual ${err.code} / ${err.message})`);
    assert.equal(h.calls.length, retries + 1, `${what}: sent retries + 1 requests`);
    // 超时算网络错误，重试间隔照常（200 ms 起）
    assert.ok(Date.now() - t0 >= 40 * (retries + 1) + 150, `${what}: took ${Date.now() - t0} ms`);
  }
});
