/**
 * Three namespaces of the asset service: `media` / `snap` / `px` (contract
 * `docs/plan/artifact-transfer-contract.md` section 1, section 7 test cases S1-S4).
 * Run: node --test server/test/asset-namespaces.test.mjs
 *
 * Written strictly against the contract, ignoring implementation. `asset-service.ts` is imported
 * after transpilation following C5 (`fake-asset-service.mjs`), all three namespaces are injected
 * with memory implementations (`assetServiceMiddleware(root, { stores: { media, snap, px } })`),
 * and chunk size is reduced to 1 KiB to avoid transferring tens of MB in each test case.
 *
 * The bulk of S3 (all `media` behaviors unchanged) is covered by `npm test`: the two files
 * `asset-service.test.mjs` and `asset-store-http.test.mjs` are not modified in this branch and pass
 * as usual. Here we supplement the last clause of contract section 1: legacy `opts.store` syntax
 * is still recognized as `stores.media`.
 */
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createAssetHarness } from './fake-asset-service.mjs';
import { isAssetServicePath } from '../http-guard.mjs';

const harness = createAssetHarness();
after(() => harness.cleanup());

const NS = ['media', 'snap', 'px'];
const CHUNK = 1024;
// M6a: non-local origins require asset tickets for reads and writes (auth-contract section 8).
// Previously this was a cluster token, covering only writes; now TOKEN is an rw asset ticket,
// reads in the script also include it, plus an added step: "read without ticket returns 401"
const { assetTicketKit } = await import('./fake-shared-env.mjs');
const KIT = await assetTicketKit();
const TOKEN = KIT.issue('rw');
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const LAN = 'http://192.168.1.50:8080';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function bytesOf(size, seed) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}
const sliceOf = (buf, n) => buf.subarray(n * CHUNK, Math.min(buf.length, (n + 1) * CHUNK));

const put = (base, ns, hash, n, body, headers = {}) => fetch(`${base}/${ns}/${hash}/${n}`, {
  method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream', ...headers },
});
const complete = (base, ns, hash, headers = {}) => fetch(`${base}/${ns}/${hash}/complete`, { method: 'POST', headers });
const chunks = async (base, ns, hash) => (await fetch(`${base}/${ns}/${hash}/chunks`)).json();

/** Snapshot of a response: status code, response headers, response body (JSON parsed; binary gets sha256 and length) */
const HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control',
  'access-control-allow-origin', 'access-control-expose-headers', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-allow-private-network', 'access-control-max-age',
];
async function snap(resPromise) {
  const r = await resPromise;
  const headers = {};
  for (const k of HEADERS) headers[k] = r.headers.get(k);
  headers['last-modified?'] = r.headers.get('last-modified') !== null;
  const buf = Buffer.from(await r.arrayBuffer());
  let body;
  if (String(r.headers.get('content-type') || '').startsWith('application/json')) {
    try { body = JSON.parse(buf.toString('utf8')); } catch { body = buf.toString('utf8'); }
  } else {
    body = { bytes: buf.length, sha256: buf.length ? sha256(buf) : null };
  }
  return { status: r.status, headers, body };
}

/**
 * S2 script: chunks, reconcile, finalize, Range, HEAD, CORS, 401. Run once for a namespace,
 * returning a list of [step name, snapshot]. Server is configured with a ticket verifier,
 * and `isTrusted` is always false: both reads and writes must bring a ticket (M6a;
 * previously only writes required a token).
 */
async function script(base, ns) {
  const out = [];
  const step = async (name, p) => { out.push([name, await snap(p)]); };

  const size = CHUNK * 2 + 321; // 3 chunks
  const buf = bytesOf(size, 11);
  const hash = sha256(buf);
  const h = { 'X-Media-Size': String(size), 'X-Media-Ext': 'bin', ...AUTH };

  await step('preflight (LAN origin)', fetch(`${base}/${ns}/${hash}/0`, {
    method: 'OPTIONS',
    headers: { Origin: LAN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-media-size, authorization', 'Access-Control-Request-Private-Network': 'true' },
  }));
  await step('preflight (public network origin)', fetch(`${base}/${ns}/${hash}/chunks`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' },
  }));
  await step('reconcile without ticket 401', fetch(`${base}/${ns}/${hash}/chunks`, { headers: { Origin: LAN } }));
  await step('reconcile: never seen', fetch(`${base}/${ns}/${hash}/chunks`, { headers: { Origin: LAN, ...AUTH } }));
  await step('PUT without token 401', put(base, ns, hash, 0, sliceOf(buf, 0), { 'X-Media-Size': String(size), Origin: LAN }));
  await step('PUT wrong token 401', put(base, ns, hash, 0, sliceOf(buf, 0), { 'X-Media-Size': String(size), Authorization: `Bearer ${TOKEN}x` }));
  await step('reconcile: rejected ones do not count', fetch(`${base}/${ns}/${hash}/chunks`, { headers: AUTH }));
  await step('PUT chunk 0', put(base, ns, hash, 0, sliceOf(buf, 0), { ...h, Origin: LAN }));
  await step('PUT chunk 2', put(base, ns, hash, 2, sliceOf(buf, 2), h));
  await step('reconcile: received 0, 2', fetch(`${base}/${ns}/${hash}/chunks`, { headers: AUTH }));
  await step('finalize: missing chunk', complete(base, ns, hash, { ...AUTH, Origin: LAN }));
  await step('re-upload chunk 1', put(base, ns, hash, 1, sliceOf(buf, 1), h));
  await step('finalize without token 401', complete(base, ns, hash));
  await step('finalize: all chunks present', complete(base, ns, hash, { ...AUTH, Origin: LAN }));
  await step('reconcile: already stored', fetch(`${base}/${ns}/${hash}/chunks`, { headers: AUTH }));
  await step('re-upload after storing', put(base, ns, hash, 0, sliceOf(buf, 0), h));
  await step('finalize again after storing', complete(base, ns, hash, AUTH));

  await step('GET without ticket 401', fetch(`${base}/${ns}/${hash}`, { headers: { Origin: LAN } }));
  await step('GET whole file', fetch(`${base}/${ns}/${hash}`, { headers: { Origin: LAN, ...AUTH } }));
  await step('GET uppercase hash', fetch(`${base}/${ns}/${hash.toUpperCase()}`, { headers: AUTH }));
  await step('Range 100-199', fetch(`${base}/${ns}/${hash}`, { headers: { Range: 'bytes=100-199', Origin: LAN, ...AUTH } }));
  await step('Range across chunks', fetch(`${base}/${ns}/${hash}`, { headers: { Range: `bytes=${CHUNK - 10}-${CHUNK + 9}`, ...AUTH } }));
  await step('Range last 10', fetch(`${base}/${ns}/${hash}`, { headers: { Range: 'bytes=-10', ...AUTH } }));
  await step('Range open-ended', fetch(`${base}/${ns}/${hash}`, { headers: { Range: `bytes=${size - 5}-`, ...AUTH } }));
  await step('Range out of bounds 416', fetch(`${base}/${ns}/${hash}`, { headers: { Range: `bytes=${size + 10}-${size + 20}`, ...AUTH } }));
  await step('HEAD', fetch(`${base}/${ns}/${hash}`, { method: 'HEAD', headers: AUTH }));
  await step('HEAD with Range', fetch(`${base}/${ns}/${hash}`, { method: 'HEAD', headers: { Range: 'bytes=0-9', ...AUTH } }));
  await step('GET query-string read-only ticket', fetch(`${base}/${ns}/${hash}?t=${encodeURIComponent(KIT.issue('r'))}`));
  await step('PUT read-only ticket 403', put(base, ns, hash, 0, sliceOf(buf, 0), { ...h, Authorization: `Bearer ${KIT.issue('r')}` }));

  // 409: whole file hash mismatch
  const small = bytesOf(300, 12);
  const claimed = sha256(Buffer.from('not the same bytes'));
  await step('PUT (content that does not match the hash)', put(base, ns, claimed, 0, small, { 'X-Media-Size': '300', ...AUTH }));
  await step('finalize: hash-mismatch', complete(base, ns, claimed, AUTH));
  await step('reconcile: after discard', fetch(`${base}/${ns}/${claimed}/chunks`, { headers: AUTH }));
  await step('finalize: after discard it is never seen', complete(base, ns, claimed, AUTH));
  await step('GET not stored', fetch(`${base}/${ns}/${claimed}`, { headers: AUTH }));

  // Chunk verification
  const s2 = CHUNK + 10;
  const b2 = bytesOf(s2, 13);
  const h2 = sha256(b2);
  const hh = { 'X-Media-Size': String(s2), ...AUTH };
  await step('out of range 416', put(base, ns, h2, 2, Buffer.alloc(10), hh));
  await step('wrong length 400', put(base, ns, h2, 1, Buffer.alloc(11), hh));
  await step('missing size 400', put(base, ns, h2, 1, Buffer.alloc(10), AUTH));
  await step('chunk number with leading zero 400', put(base, ns, h2, '01', Buffer.alloc(10), hh));
  await step('PUT chunk 1', put(base, ns, h2, 1, sliceOf(b2, 1), hh));
  await step('size mismatch 409', put(base, ns, h2, 0, sliceOf(b2, 0), { 'X-Media-Size': String(s2 + 1), ...AUTH }));
  await step('reconcile: after validation', fetch(`${base}/${ns}/${h2}/chunks`, { headers: AUTH }));
  await step('bad hash 400', fetch(`${base}/${ns}/xyz/chunks`));
  await step('wrong method 405 (chunks)', fetch(`${base}/${ns}/${h2}/chunks`, { method: 'POST' }));
  await step('wrong method 405 (complete)', fetch(`${base}/${ns}/${h2}/complete`));
  await step('wrong method 405 (whole file)', fetch(`${base}/${ns}/${h2}`, { method: 'DELETE' }));
  return { out, hash, size };
}

/* ------------------------------------------------------------------ S1 */

test('S1 the same bytes are uploaded into media, snap and px separately: the three namespaces are invisible to each other, present in one and 404 in another', async () => {
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null });
  const { base, stores } = srv;
  const buf = bytesOf(CHUNK + 77, 1);
  const hash = sha256(buf);
  const upload = async (ns) => {
    for (let n = 0; n < 2; n++) {
      const r = await put(base, ns, hash, n, sliceOf(buf, n), { 'X-Media-Size': String(buf.length) });
      assert.equal(r.status, 200, `${ns} chunk ${n}`);
      await r.arrayBuffer();
    }
    const c = await complete(base, ns, hash);
    assert.equal(c.status, 200, `${ns} finalize`);
    await c.arrayBuffer();
  };
  const visible = async (ns) => {
    const r = await fetch(`${base}/${ns}/${hash}`);
    const body = Buffer.from(await r.arrayBuffer());
    const st = await chunks(base, ns, hash);
    const head = await fetch(`${base}/${ns}/${hash}`, { method: 'HEAD' });
    return { status: r.status, same: r.status === 200 && body.equals(buf), complete: st.complete, received: st.received, head: head.status };
  };
  const expectState = async (have) => {
    for (const ns of NS) {
      const v = await visible(ns);
      if (have.includes(ns)) {
        assert.deepEqual(v, { status: 200, same: true, complete: true, received: [0, 1], head: 200 }, `${ns} should have it`);
        assert.notEqual(await stores[ns].stat(hash), null, `the ${ns} store should have it`);
      } else {
        assert.deepEqual(v, { status: 404, same: false, complete: false, received: [], head: 404 }, `${ns} should not have it`);
        assert.equal(await stores[ns].stat(hash), null, `the ${ns} store should not have it`);
      }
    }
  };

  await expectState([]);
  await upload('media');
  await expectState(['media']);
  await upload('snap');
  await expectState(['media', 'snap']);
  await upload('px');
  await expectState(['media', 'snap', 'px']);

  // Chunk statuses are likewise mutually invisible: for another set of bytes where only one chunk
  // was received in px, reconciliation in media and snap reports "never seen"
  const other = bytesOf(CHUNK + 5, 2);
  const oh = sha256(other);
  assert.equal((await put(base, 'px', oh, 0, sliceOf(other, 0), { 'X-Media-Size': String(other.length) })).status, 200);
  assert.deepEqual(await chunks(base, 'px', oh), { size: other.length, chunkSize: CHUNK, received: [0], complete: false });
  for (const ns of ['media', 'snap']) assert.deepEqual(await chunks(base, ns, oh), { size: null, chunkSize: CHUNK, received: [], complete: false }, ns);
  // Registering another size in a different namespace does not conflict (each has its own registration)
  const r = await put(base, 'snap', oh, 0, Buffer.alloc(10), { 'X-Media-Size': '10' });
  assert.equal(r.status, 200, 'in snap the same hash is registered with its own size and does not conflict with px');
  await r.arrayBuffer();
});

/* ------------------------------------------------------------------ S2 */

test('S2 snap and px chunks, reconcile, finalize, Range, HEAD, CORS and 401 rules are the same as media, compared field by field', async () => {
  const runs = {};
  for (const ns of NS) {
    // A new service for each namespace; scripts start from the same empty state
    const srv = await harness.serve({ chunkSize: CHUNK, tickets: KIT.tickets, isTrusted: () => false });
    runs[ns] = await script(srv.base, ns);
    await srv.close();
  }
  const ref = runs.media.out;
  // media first checks several places per C5 contract, to avoid all three failing together
  const get = (name) => ref.find(([n]) => n === name)[1];
  assert.deepEqual(get('reconcile: never seen').body, { size: null, chunkSize: CHUNK, received: [], complete: false });
  assert.deepEqual([get('PUT without token 401').status, get('PUT without token 401').body], [401, { ok: false, error: 'unauthorized' }]);
  assert.deepEqual([get('reconcile without ticket 401').status, get('reconcile without ticket 401').body], [401, { ok: false, error: 'unauthorized' }]);
  assert.equal(get('GET without ticket 401').status, 401);
  assert.equal(get('GET query-string read-only ticket').status, 200);
  assert.equal(get('GET query-string read-only ticket').headers['cache-control'], 'no-store');
  assert.deepEqual([get('PUT read-only ticket 403').status, get('PUT read-only ticket 403').body], [403, { ok: false, error: 'forbidden' }]);
  assert.deepEqual(get('reconcile: received 0, 2').body.received, [0, 2]);
  assert.deepEqual([get('finalize: missing chunk').status, get('finalize: missing chunk').body.missing], [400, [1]]);
  assert.equal(get('finalize: all chunks present').status, 200);
  assert.equal(get('GET whole file').status, 200);
  assert.equal(get('GET whole file').headers['access-control-allow-origin'], '*');
  assert.equal(get('Range 100-199').status, 206);
  assert.equal(get('Range out of bounds 416').status, 416);
  assert.equal(get('preflight (LAN origin)').status, 204);
  assert.equal(get('preflight (LAN origin)').headers['access-control-allow-private-network'], 'true');
  assert.equal(get('preflight (public network origin)').headers['access-control-allow-private-network'], null);
  assert.deepEqual([get('finalize: hash-mismatch').status, get('finalize: hash-mismatch').body.error], [409, 'hash-mismatch']);

  for (const ns of ['snap', 'px']) {
    const got = runs[ns].out;
    assert.equal(got.length, ref.length);
    for (let i = 0; i < ref.length; i++) {
      const [name, a] = ref[i];
      const [name2, b] = got[i];
      assert.equal(name2, name);
      assert.equal(b.status, a.status, `${ns} "${name}" status code`);
      // Response length with url varies with url; do not compare content-length
      const hasUrl = a.body && typeof a.body === 'object' && 'url' in a.body;
      for (const k of Object.keys(a.headers)) {
        if (hasUrl && k === 'content-length') continue;
        assert.equal(b.headers[k], a.headers[k], `${ns} "${name}" response header ${k}`);
      }
      // `url` in finalize response is the retrieval address, checked separately by namespace (see below);
      // remaining fields are compared one by one
      const strip = (body) => (body && typeof body === 'object' && 'url' in body ? { ...body, url: typeof body.url } : body);
      assert.deepEqual(strip(b.body), strip(a.body), `${ns} "${name}" response body`);
    }
    // Contract section 10 item 2: snap / px url is `/api/asset/<ns>/<hash>`; media remains `/@media/<hash>`
    const fin = got.find(([n]) => n === 'finalize: all chunks present')[1].body;
    assert.equal(fin.url, `/api/asset/${ns}/${runs[ns].hash}`, `${ns} url in the finalize response body`);
    const again = got.find(([n]) => n === 'finalize again after storing')[1].body;
    assert.equal(again.url, `/api/asset/${ns}/${runs[ns].hash}`, `${ns} url when finalizing again after storing`);
  }
  assert.equal(get('finalize: all chunks present').body.url, `/@media/${runs.media.hash}`, 'media\'s url stays as before');
});

test('S2b the MIME table dedicated to snap / px recognizes text/html → html and video/iso.segment → m4s, media\'s table is unchanged; X-Media-Ext takes precedence', async () => {
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null });
  const { base, stores } = srv;
  let seed = 100;
  const one = async (ns, headers) => {
    const buf = bytesOf(200, ++seed);
    const hash = sha256(buf);
    assert.equal((await put(base, ns, hash, 0, buf, { 'X-Media-Size': '200', ...headers })).status, 200);
    assert.equal((await complete(base, ns, hash)).status, 200);
    return (await stores[ns].stat(hash))?.ext;
  };
  for (const ns of ['snap', 'px']) {
    assert.equal(await one(ns, { 'X-Media-Type': 'text/html' }), 'html', `${ns} text/html`);
    assert.equal(await one(ns, { 'X-Media-Type': 'text/html; charset=utf-8' }), 'html', `${ns} text/html; charset`);
    assert.equal(await one(ns, { 'X-Media-Type': 'video/iso.segment' }), 'm4s', `${ns} video/iso.segment`);
    assert.equal(await one(ns, { 'X-Media-Type': 'video/mp4' }), 'mp4', `${ns} video/mp4`);
  }
  for (const ns of NS) {
    assert.equal(await one(ns, { 'X-Media-Ext': 'mp4', 'X-Media-Type': 'video/iso.segment' }), 'mp4', `${ns} extension takes precedence`);
    assert.equal(await one(ns, { 'X-Media-Ext': 'm4s' }), 'm4s', `${ns} extension given directly`);
    assert.equal(await one(ns, {}), '', `${ns} neither given`);
  }
  // Contract section 10 items 8, 10: snap / px only stores candidate extensions (html, mp4, m4s,
  // all extensions in the dedicated MIME table, htm, m4v, jpeg); anything not in the table is stored
  // without an extension; media is unaffected
  for (const ns of ['snap', 'px']) {
    assert.equal(await one(ns, { 'X-Media-Ext': 'bin' }), '', `${ns} bin is not in the candidate list`);
    assert.equal(await one(ns, { 'X-Media-Ext': 'xyz' }), '', `${ns} xyz is not in the candidate list`);
    assert.equal(await one(ns, { 'X-Media-Ext': 'html' }), 'html', `${ns} html is in the candidate list`);
    for (const ext of ['htm', 'm4v', 'jpeg']) assert.equal(await one(ns, { 'X-Media-Ext': ext }), ext, `${ns} ${ext} is in the candidate list`);
    // png is in dedicated MIME table: stored as <hash>.png, retrievable via candidate
    const png = bytesOf(200, ++seed);
    const ph = sha256(png);
    assert.equal((await put(base, ns, ph, 0, png, { 'X-Media-Size': '200', 'X-Media-Ext': 'png' })).status, 200);
    assert.equal((await complete(base, ns, ph)).status, 200);
    assert.equal((await stores[ns].stat(ph))?.ext, 'png', `${ns} png is stored as <hash>.png`);
    assert.equal((await chunks(base, ns, ph)).complete, true, `${ns} png counts as stored by candidate`);
    const back = await fetch(`${base}/${ns}/${ph}`);
    assert.equal(back.status, 200, `${ns} png can be retrieved`);
    assert.ok(Buffer.from(await back.arrayBuffer()).equals(png), `${ns} png bytes are identical`);
    assert.equal(await one(ns, { 'X-Media-Type': 'image/png' }), 'png', `${ns} image/png reverse-maps to png, which is in the candidate list`);
  }
  assert.equal(await one('media', { 'X-Media-Ext': 'png' }), 'png', 'media still stores png as before');
  assert.equal(await one('media', { 'X-Media-Ext': 'bin' }), 'bin', 'media still stores bin as before');
  // Contract section 10 item 1: do not modify shared MIME_TO_EXT; media filename written to disk is unchanged
  assert.equal(await one('media', { 'X-Media-Type': 'text/html' }), '', 'media does not recognize text/html');
  assert.equal(await one('media', { 'X-Media-Type': 'video/iso.segment' }), '', 'media does not recognize video/iso.segment');
  assert.equal(await one('media', { 'X-Media-Type': 'video/mp4' }), 'mp4', 'media\'s original table is unchanged');
});

test('S2c the default snap and px are the fs implementation, with the directory fixed at <root>/out/asset-store/<ns>, ignoring PROMPTCUT_EXPORT_DIR and not writing the media index; existing files are found by candidate file name', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const exportDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-c62-export-'));
  const before = process.env.PROMPTCUT_EXPORT_DIR;
  process.env.PROMPTCUT_EXPORT_DIR = exportDir;
  try {
    const srv = await harness.serve({ stores: 'default', isTrusted: () => true, token: null });
    const { base, root } = srv;
    const html = Buffer.from('<div data-pc-scene="">snapshot</div>', 'utf8');
    const seg = bytesOf(900, 41);
    const hh = sha256(html), hs = sha256(seg);
    assert.equal((await put(base, 'snap', hh, 0, html, { 'X-Media-Size': String(html.length), 'X-Media-Type': 'text/html' })).status, 200);
    assert.equal((await complete(base, 'snap', hh)).status, 200);
    assert.equal((await put(base, 'px', hs, 0, seg, { 'X-Media-Size': String(seg.length), 'X-Media-Ext': 'm4s' })).status, 200);
    assert.equal((await complete(base, 'px', hs)).status, 200);

    const snapDir = path.join(root, 'out', 'asset-store', 'snap');
    const pxDir = path.join(root, 'out', 'asset-store', 'px');
    assert.ok((await fsp.readFile(path.join(snapDir, `${hh}.html`))).equals(html), 'snap lands at <root>/out/asset-store/snap/<hash>.html');
    assert.ok((await fsp.readFile(path.join(pxDir, `${hs}.m4s`))).equals(seg), 'px lands at <root>/out/asset-store/px/<hash>.m4s');
    const walk = async (dir) => {
      const out = [];
      let items = [];
      try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
      for (const item of items) {
        const p = path.join(dir, item.name);
        if (item.isDirectory()) out.push(...await walk(p)); else out.push(p);
      }
      return out;
    };
    for (const file of await walk(exportDir)) {
      assert.ok(!file.includes(hh) && !file.includes(hs), `PROMPTCUT_EXPORT_DIR must not contain snap / px files: ${file}`);
      if (file.endsWith('.json')) {
        const text = await fsp.readFile(file, 'utf8');
        assert.ok(!text.includes(hh) && !text.includes(hs), `the media index must not record snap / px chunks: ${file}`);
      }
    }
    assert.equal((await fetch(`${base}/media/${hh}`)).status, 404, 'media has no snap chunk');

    // Retrieval (Content-Type not defined in contract, do not compare)
    const g = await fetch(`${base}/snap/${hh}`);
    assert.equal(g.status, 200);
    assert.ok(Buffer.from(await g.arrayBuffer()).equals(html));

    // Candidate filenames: <hash>.mp4 placed directly into directory and <hash> without extension
    // are both found, counted as stored
    const init = bytesOf(333, 42);
    const hi = sha256(init);
    await fsp.writeFile(path.join(pxDir, `${hi}.mp4`), init);
    const bare = bytesOf(222, 43);
    const hb = sha256(bare);
    await fsp.writeFile(path.join(snapDir, hb), bare);
    assert.equal((await chunks(base, 'px', hi)).complete, true, 'px/<hash>.mp4 counts as stored');
    const gi = await fetch(`${base}/px/${hi}`);
    assert.equal(gi.status, 200);
    assert.ok(Buffer.from(await gi.arrayBuffer()).equals(init));
    assert.equal((await chunks(base, 'snap', hb)).complete, true, 'an extensionless <hash> also counts as stored');
    assert.equal((await fetch(`${base}/snap/${hb}`)).status, 200);

    // Item 8: extensions not in candidate table are stored as extensionless <hash>, still found afterwards
    const odd = bytesOf(444, 44);
    const ho = sha256(odd);
    assert.equal((await put(base, 'px', ho, 0, odd, { 'X-Media-Size': String(odd.length), 'X-Media-Ext': 'bin' })).status, 200);
    assert.equal((await complete(base, 'px', ho)).status, 200);
    assert.ok((await fsp.readFile(path.join(pxDir, ho))).equals(odd), 'bin is stored as <root>/out/asset-store/px/<hash>');
    await assert.rejects(fsp.stat(path.join(pxDir, `${ho}.bin`)), '<hash>.bin is not stored');
    assert.equal((await chunks(base, 'px', ho)).complete, true);
    const go = await fetch(`${base}/px/${ho}`);
    assert.equal(go.status, 200);
    assert.equal(go.headers.get('content-type'), 'application/octet-stream');
    assert.ok(Buffer.from(await go.arrayBuffer()).equals(odd));

    // Item 10: png is in candidate table, stored as <hash>.png, retrievable by candidate filename
    const pic = bytesOf(555, 45);
    const hp = sha256(pic);
    assert.equal((await put(base, 'snap', hp, 0, pic, { 'X-Media-Size': String(pic.length), 'X-Media-Ext': 'png' })).status, 200);
    assert.equal((await complete(base, 'snap', hp)).status, 200);
    assert.ok((await fsp.readFile(path.join(snapDir, `${hp}.png`))).equals(pic), 'png is stored as <root>/out/asset-store/snap/<hash>.png');
    assert.equal((await chunks(base, 'snap', hp)).complete, true, '<hash>.png counts as stored by candidate');
    const gp = await fetch(`${base}/snap/${hp}`);
    assert.equal(gp.status, 200);
    assert.ok(Buffer.from(await gp.arrayBuffer()).equals(pic));
  } finally {
    if (before === undefined) delete process.env.PROMPTCUT_EXPORT_DIR; else process.env.PROMPTCUT_EXPORT_DIR = before;
    await fsp.rm(exportDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ S3 */

test('S3 the old form opts.store is still accepted and treated as stores.media; when only stores.media is given, media behaves the same as C5', async () => {
  // Legacy syntax: only pass opts.store
  const legacy = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null, legacyStore: true });
  const buf = bytesOf(CHUNK + 3, 21);
  const hash = sha256(buf);
  for (let n = 0; n < 2; n++) assert.equal((await put(legacy.base, 'media', hash, n, sliceOf(buf, n), { 'X-Media-Size': String(buf.length), 'X-Media-Ext': 'png' })).status, 200);
  const fin = await complete(legacy.base, 'media', hash);
  assert.equal(fin.status, 200);
  assert.deepEqual(await fin.json(), { ok: true, hash, size: buf.length, complete: true, url: `/@media/${hash}` });
  assert.notEqual(await legacy.stores.media.stat(hash), null, 'opts.store is the media store');
  const got = await fetch(`${legacy.base}/media/${hash}`);
  assert.equal(got.status, 200);
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(buf));
  assert.equal(got.headers.get('content-type'), 'image/png');

  // New syntax: media response is identical to legacy syntax field by field
  const a =await script((await harness.serve({ chunkSize: CHUNK, tickets: KIT.tickets, isTrusted: () => false, legacyStore: true })).base, 'media');
  const b = await script((await harness.serve({ chunkSize: CHUNK, tickets: KIT.tickets, isTrusted: () => false })).base, 'media');
  assert.deepEqual(b.out, a.out, 'stores.media and opts.store give the same media behavior');
});

/* ------------------------------------------------------------------ S4 */

test('S4 unknown namespace: the asset service does not handle it (hands off to next, this test\'s fallback returns 404), returns 4xx, and persists no state; isAssetServicePath accepts only the three namespaces', async () => {
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null });
  const { base, stores } = srv;
  const buf = bytesOf(100, 31);
  const hash = sha256(buf);
  const is4xx = (s) => s >= 400 && s < 500;
  for (const ns of ['foo', 'snaps', 'pix', 'mediax', 'asset', 'png', 'x']) {
    const p = await put(base, ns, hash, 0, buf, { 'X-Media-Size': '100' });
    assert.ok(is4xx(p.status), `${ns} PUT returns ${p.status}`);
    // Contract section 10 item 3: middleware passes to next(); response comes from fallback of this
    // test (plain text no route), not JSON from asset service, and contains no cross-origin headers
    assert.equal(await p.text(), 'no route', `${ns} PUT should fall through to the fallback`);
    assert.equal(p.headers.get('access-control-allow-origin'), null, `${ns} the asset service did not take over, so it adds no CORS headers`);
    const c = await complete(base, ns, hash);
    assert.ok(is4xx(c.status), `${ns} complete returns ${c.status}`);
    assert.equal(await c.text(), 'no route');
    for (const tail of ['/chunks', '']) {
      const g = await fetch(`${base}/${ns}/${hash}${tail}`);
      assert.ok(is4xx(g.status), `${ns} GET${tail} returns ${g.status}`);
      assert.equal(await g.text(), 'no route');
    }
  }
  for (const ns of NS) {
    assert.deepEqual(await stores[ns].chunks(hash), { size: null, chunkSize: CHUNK, received: [], complete: false }, `${ns} persisted no state`);
    assert.equal(await stores[ns].stat(hash), null);
    assert.deepEqual((await stores[ns].usage()).blobs, 0, `nothing was stored in ${ns}`);
  }

  const h = 'ab'.repeat(32);
  for (const ns of NS) {
    for (const tail of ['', '/chunks', '/complete', '/0', '/12']) {
      assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}${tail}`), true, `${ns}${tail}`);
    }
    assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}?x=1`), true, `${ns} with query string`);
    assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}/bogus`), false, `${ns}/bogus`);
    assert.equal(isAssetServicePath(`/api/asset/${ns}`), false, `${ns} without hash`);
    assert.equal(isAssetServicePath(`/api/asset/${ns}/xyz`), false, `${ns} bad hash`);
  }
  for (const ns of ['foo', 'snaps', 'pix', 'mediax', 'asset', 'png', 'x', '']) {
    assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}`), false, `does not accept ${JSON.stringify(ns)}`);
    assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}/0`), false, `does not accept ${JSON.stringify(ns)}/0`);
  }
  assert.equal(isAssetServicePath(`/api/asset/snap/px/${h}`), false);
  assert.equal(isAssetServicePath(`/api/ai/snap/${h}`), false);
  assert.equal(isAssetServicePath(`/@media/${h}`), false);
});
