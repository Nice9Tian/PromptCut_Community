/**
 * Asset service client `server/asset-store/client.mjs` (contract
 * `docs/plan/artifact-transfer-contract.md` section 2, section 7 test cases L1-L5).
 * Run: node --test server/test/asset-client.test.mjs
 *
 * Written strictly against the contract, ignoring implementation. Real HTTP: asset service
 * (`fake-asset-service.mjs`, port 0, all three namespaces use memory implementations).
 * Client `fetch` injects a logging layer (rewriting responses when necessary) to count
 * requests, inspect request headers, and simulate 5xx / network errors / tampering.
 *
 * When `client.mjs` does not yet exist, each test case fails individually and reports the reason.
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
 * A fetch that logs each request. `hook(info)` can return a Response (or throw an error)
 * instead of the real request; returning undefined sends as usual.
 * Each entry in the returned `log` is `{ method, url, path, headers }`, with lowercased
 * `headers` keys.
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
    // Extension is passed along with X-Media-Ext
    assert.equal((await srv.stores[ns].stat(hash))?.ext, ext, `${ns} extension`);
    // Only entered this one namespace
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
  // Requests all fall under base, addressed by <ns>/<hash>…
  for (const info of rec.log) assert.ok(info.url.startsWith(`${srv.base}/`), info.url);
});

/* ------------------------------------------------------------------ L2 */

test('L2 object larger than one chunk: re-upload only the missing chunks (pre-seed received to simulate an interrupted upload), every chunk carries X-Media-Size and X-Media-Ext', async () => {
  const CHUNK = 1024;
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null });
  const size = CHUNK * 5 + 123; // 6 chunks
  const buf = bytesOf(size, 7);
  const hash = sha256(buf);
  // Preset: chunks 0, 2, 5 have already arrived (hit HTTP directly)
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

  // Large object with no chunks present: upload all chunks
  const b2 = bytesOf(CHUNK * 3, 8);
  const rec2 = recordingFetch();
  const c2 = createAssetClient({ base: srv.base, fetch: rec2.fetch, chunkSize: CHUNK });
  assert.equal((await c2.put('snap', b2, { ext: 'html' })).uploaded, true);
  assert.deepEqual(rec2.log.filter(isChunkPut).map(chunkNo).sort((a, b) => a - b), [0, 1, 2]);

  // Contract section 10 item 4: chunk size follows chunkSize in server chunks response;
  // client option is only a fallback
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

  // Network error (thrown by fetch itself): likewise retry per chunk
  const b2 = bytesOf(CHUNK + 1, 10);
  let dropped = 0;
  const rec2 = recordingFetch((info) => {
    if (isChunkPut(info) && chunkNo(info) === 0 && dropped < 1) { dropped++; throw new TypeError('fetch failed'); }
    return undefined;
  });
  const c2 = createAssetClient({ base: srv.base, fetch: rec2.fetch, chunkSize: CHUNK, retries: 3 });
  assert.equal((await c2.put('px', b2, { ext: 'm4s' })).uploaded, true, 'succeeds after one network error');
  assert.equal(rec2.log.filter((i) => isChunkPut(i) && chunkNo(i) === 0).length, 2);

  // Contract section 10 item 5: retries also apply to chunks, complete, get
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

  // Retries exhausted: throw
  const b3 = bytesOf(100, 11);
  const rec3 = recordingFetch((info) => (isChunkPut(info)
    ? new Response(JSON.stringify({ ok: false, error: 'down' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    : undefined));
  const c3 = createAssetClient({ base: srv.base, fetch: rec3.fetch, chunkSize: CHUNK, retries: 2 });
  await assert.rejects(c3.put('px', b3), '5xx persists: throws once retries are used up');
  assert.equal(rec3.log.filter(isChunkPut).length, 3, 'retries: 2 → first attempt + 2 retries');

  // 4xx: do not retry, throw directly, error includes status and response (real service:
  // ticket verifier configured, non-local, client brings no ticket → 401)
  // M6a: reads also require tickets, so 401 occurs on the first request (reconcile GET chunks);
  // previously occurred on the first chunk PUT; the "send only once, do not retry" assertion is unchanged
  const lockKit = await assetTicketKit();
  const locked = await harness.serve({ chunkSize: CHUNK, isTrusted: () => false, tickets: lockKit.tickets });
  const rec4 = recordingFetch();
  // "Not waiting for retry interval" only checks time spent by client itself: total elapsed time
  // minus time spent in fetch (real HTTP round-trip, server ticket verification).
  // When the machine is busy, round-trip itself is slow, but that is not the retry interval;
  // if client slept for first retry interval (200 ms), this duration is at least 200 ms, still caught.
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
  // Write with read-only ticket: 403 likewise does not retry (on first chunk PUT)
  const rec4b = recordingFetch();
  const readOnly = lockKit.issue('r');
  const c4b = createAssetClient({ base: locked.base, fetch: rec4b.fetch, chunkSize: CHUNK, retries: 3, ticket: () => readOnly });
  const err4b = await c4b.put('snap', bytesOf(300, 12)).then(() => null, (e) => e);
  assert.equal(err4b?.status, 403);
  assert.equal(rec4b.log.filter(isChunkPut).length, 1, '403 is not retried');

  // Same if 4xx returned by server is not 401 (fake response 409)
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
  // Flip one byte
  const flip = recordingFetch(async (info) => {
    if (!isBlobGet(info)) return undefined;
    const real = Buffer.from(await (await globalThis.fetch(info.url)).arrayBuffer());
    real[10] ^= 0xff;
    return new Response(real, { status: 200, headers: { 'Content-Type': 'text/html', 'Content-Length': String(real.length) } });
  });
  await assert.rejects(createAssetClient({ base: srv.base, fetch: flip.fetch, chunkSize: 1024 }).get('snap', hash), 'bytes altered: throws when the sha256 check fails');
  // Truncated
  const cut = recordingFetch(() => undefined);
  const cutFetch = async (url, init) => {
    const info = { method: String(init?.method || 'GET').toUpperCase(), path: new URL(url).pathname };
    if (isBlobGet(info)) return new Response(buf.subarray(0, 1000), { status: 200 });
    return cut.fetch(url, init);
  };
  await assert.rejects(createAssetClient({ base: srv.base, fetch: cutFetch, chunkSize: 1024 }).get('snap', hash), 'also throws when bytes are missing');
  // Replace with different content
  const other = recordingFetch((info) => (isBlobGet(info) ? new Response(bytesOf(1500, 15), { status: 200 }) : undefined));
  await assert.rejects(createAssetClient({ base: srv.base, fetch: other.fetch, chunkSize: 1024 }).get('snap', hash));

  // 404: return null, do not throw
  const missing = sha256(Buffer.from('never uploaded'));
  assert.equal(await plain.get('snap', missing), null);
  assert.equal(await plain.get('px', hash), null, 'not present in the other namespace: null');
  assert.equal(await plain.has('px', hash), false);
});

/* ------------------------------------------------------------------ L5 */

// M6a (auth-contract sections 8, 11): cluster token replaced with `ticket()`. Originally tested
// "every write request has Bearer when token is passed, exceptions contain no raw token";
// now both reads and writes require tickets, so test that every request has Bearer <ticket>;
// also test retrying once with refreshed ticket on 401, and throwing if token option is passed.
// Assertion that exceptions do not contain raw ticket is unchanged.
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

  // Client without ticket: does not send Authorization (server returns 401)
  const rec0 = recordingFetch();
  const bare = createAssetClient({ base: srv.base, fetch: rec0.fetch, chunkSize: 1024 });
  const e0 = await bare.put('snap', bytesOf(10, 17)).then(() => null, (e) => e);
  assert.equal(e0?.status, 401);
  for (const info of rec0.log) assert.equal(info.headers.authorization, undefined);
  // ticket() returns null: likewise omitted
  const recNull = recordingFetch();
  const eNull = await createAssetClient({ base: srv.base, fetch: recNull.fetch, chunkSize: 1024, ticket: () => null }).put('snap', bytesOf(10, 17)).then(() => null, (e) => e);
  assert.equal(eNull?.status, 401);
  for (const info of recNull.log) assert.equal(info.headers.authorization, undefined);

  // 401 → ticket({ refresh: true }) to refresh and retry once: after old ticket is invalidated
  // (passphrase changed, generation incremented by 1), the new ticket works
  const stale = kit.issue('rw');
  kit.bump((d) => { d.generation += 1; });
  const calls = [];
  const renew = createAssetClient({ base: srv.base, fetch: recordingFetch().fetch, chunkSize: 1024, ticket: (opts) => { calls.push(opts?.refresh === true); return opts?.refresh ? kit.issue('rw') : stale; } });
  const b2 = bytesOf(500, 21);
  assert.equal((await renew.put('snap', b2)).uploaded, true, 'succeeds after swapping the ticket');
  assert.ok(calls.includes(true), `a ticket swap is required after 401: ${JSON.stringify(calls)}`);
  // Still 401 after refresh: retry only once and then throw
  const recBad = recordingFetch();
  const wrong = `${kit.issue('rw')}x`;
  const bad = createAssetClient({ base: srv.base, ticket: () => wrong, fetch: recBad.fetch, chunkSize: 1024 });
  const e1 = await bad.put('snap', bytesOf(20, 18)).then(() => null, (e) => e);
  assert.equal(e1?.status, 401);
  assert.equal(recBad.log.length, 2, '401 swaps the ticket and retries only once');

  // 5xx retries exhausted: likewise does not contain raw ticket
  const good = kit.issue('rw');
  const down = recordingFetch((info) => (isWrite(info) ? new Response('{"ok":false}', { status: 500, headers: { 'Content-Type': 'application/json' } }) : undefined));
  const e2 = await createAssetClient({ base: srv.base, ticket: () => good, fetch: down.fetch, chunkSize: 1024, retries: 1 }).put('snap', bytesOf(30, 19)).then(() => null, (e) => e);
  assert.ok(e2 instanceof Error, '5xx must throw once retries are used up');
  // Network errors: same
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

  // Cluster tokens are no longer used for asset service: passing token option throws directly
  assert.throws(() => createAssetClient({ base: srv.base, token: randomToken() }), TypeError);
});

/* ------------------------------------------------------------------ L6 (contract section 10 item 5) */

test('L6 a fake fetch never returns: timeoutMs aborts on time and the request is retried as a network error; once retries are used up it throws code: timeout, sending retries + 1 requests in total', async () => {
  const srv = await harness.serve({ chunkSize: 1024, isTrusted: () => true, token: null });
  /** Never-returning fetch: rejects only on receiving abort signal (real fetch responds to AbortSignal this way) */
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
    // Timeout counts as network error, retry interval as usual (starts at 200 ms)
    assert.ok(Date.now() - t0 >= 40 * (retries + 1) + 150, `${what}: took ${Date.now() - t0} ms`);
  }
});
