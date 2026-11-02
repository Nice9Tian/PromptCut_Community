/**
 * M7 page uploader (`src/online/snapUploader.ts`, contract Section 4.5, D7): pushes `snap` / `px`
 * chunks against real asset service HTTP layer (`asset-service.ts` transpiled from
 * `fake-asset-service.mjs`, memory storage).
 *   - Reconcile → PUT missing parts (each with size and extension) → complete, after which `has` is
 *     true; skip existing;
 *   - Writes require rw ticket; if current ticket is rejected (401), force-replace it and retry this
 *     step once;
 *   - Hash mismatch returns 409 on complete, throws (retryable);
 *   - Same hash pushed via single-flight; when finalize returns incomplete, recheck chunks and
 *     re-upload once (probe P4).
 * Run: node --test server/test/m7-uploader.test.mjs
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

test('M7-UP-01 push snap and px: reconcile, PUT, complete; skip what already exists; on 401 get a fresh ticket and retry once; the hash matches what WebCrypto computes', async () => {
  const srv = await harness.serve({ tickets: KIT.tickets, isTrusted: () => false });
  const issued = [];
  const ticket = async (force) => {
    issued.push(!!force);
    // First ticket is broken (simulating expiration); gives a valid one upon forced replacement
    return force ? KIT.issue('rw') : 'v1.bad.ticket';
  };
  const up = createSnapUploader({ base: () => srv.base, ticket });
  const html = Buffer.from('<div class="pc-snap">hello snapshot</div>', 'utf8');
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
  assert.ok(st.reauth >= 1 && issued.includes(true), 'The ticket was force-refreshed after the 401');
  // Retrieved bytes match what was pushed
  const got = await fetch(`${srv.base}/snap/${h1}`, { headers: { Authorization: `Bearer ${KIT.issue('r')}` } });
  assert.equal(got.status, 200);
  assert.equal(Buffer.from(await got.arrayBuffer()).equals(html), true);
  assert.equal(JSON.stringify(st).includes(KIT.issue('rw').slice(0, 20)), false, 'No ticket in the diagnostics');
  await srv.close();
});

test('M7-UP-02 hash mismatch: complete answers 409 and throws (retryable); throws when there is no asset service', async () => {
  const chunk = 1024;
  const srv = await harness.serve({ chunkSize: chunk, tickets: KIT.tickets, isTrusted: () => false });
  assert.equal(CHUNK_SIZE, 8 * 1024 * 1024);
  const up = createSnapUploader({ base: () => srv.base, ticket: async () => KIT.issue('rw') });
  const small = Buffer.alloc(600, 7);
  const wrong = sha256(Buffer.from('other'));
  await assert.rejects(up.put('snap', wrong, new Uint8Array(small), 'html'), (e) => e.retryable === true && /409/.test(e.message));
  assert.equal(up.stats().failed, 1);
  const none = createSnapUploader({ base: () => null, ticket: async () => null });
  await assert.rejects(none.put('snap', sha256(small), new Uint8Array(small), 'html'), /no remote asset service/);
  assert.equal(await none.has('snap', sha256(small)), false);
  await srv.close();
});

test('M7-UP-03 concurrent pushes of the same hash push only once (single-flight), and the other waits for its result; runs against a real asset service', async () => {
  const srv = await harness.serve({ tickets: KIT.tickets, isTrusted: () => false });
  const puts = [];
  const f = async (url, init) => { if (init?.method === 'PUT') puts.push(url); return fetch(url, init); };
  const up = createSnapUploader({ base: () => srv.base, ticket: async () => KIT.issue('rw'), fetch: f });
  const body = Buffer.from('<p>same chunk</p>', 'utf8');
  const h = sha256(body);
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => up.put('snap', h, new Uint8Array(body), 'html')));
  assert.deepEqual([a, b, c].sort(), ['pushed', 'skipped', 'skipped']);
  assert.equal(puts.length, 1, 'PUT only once');
  assert.equal(await up.has('snap', h), true);
  await srv.close();
});

test('M7-UP-04 finalize answers 400 incomplete: re-check chunks, upload the missing ones once, then finalize again', async () => {
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
  // Second attempt is still incomplete: throws (retryable), does not retry infinitely
  completes = 0;
  const f2 = async (url, init) => (url.endsWith('/complete') ? json(400, { error: 'incomplete', missing: [0] }) : f(url, init));
  const up2 = createSnapUploader({ base: () => 'https://h.example/api/asset', ticket: async () => 't', fetch: f2 });
  await assert.rejects(up2.put('snap', h, body, 'html'), (e) => e.retryable === true && /incomplete/.test(e.message));
});
