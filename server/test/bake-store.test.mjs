/**
 * Card snapshots of `bake_card` (prerender output) are accessed via asset service
 * (`server/bake-store.mjs`; report `docs/reports/AGENT-bake-asset.md`; semantics
 * `docs/semantics/product/asset-service.md` "Prerender output" "Responsibilities",
 * `product/agent.md` "Assets and output").
 *
 * Test cases (BKA = bake asset, card snapshots via asset service):
 *   BKA-1  Write and read-back: PNG written to `px` via asset service, address
 *          `/api/asset/px/<sha256>`, bytes retrieved via HTTP are identical; same key hits again on
 *          lookup; files directly written by it do not appear in asset catalog (no `bake-*.png`),
 *          only `<key>.json` in index directory;
 *   BKA-2  Hits must query asset service: present in index, but chunk missing on asset service →
 *          treat as never rendered, delete index entry;
 *   BKA-3  Legacy address: `bake-<clip>-<key>.png` previously left in asset catalog can still be
 *          fetched via legacy read route of asset service; read-time migration pushes it to `px`
 *          (identical bytes) and records into index, old files untouched; non-PNG not migrated;
 *   BKA-4  Asset service unreachable / rejected: cannot get address, connection failure, HTTP 401
 *          all throw BakeStoreError, message states asset service address and reason;
 *   BKA-5  Inventory and eviction: inventory only reports fully received items; eviction only deletes
 *          matching keys in index (path-like keys do not touch other files), bytes stay in asset
 *          service;
 *   BKA-6  Shared project: when remote asset service is registered, push a copy over after writing,
 *          record `pushed` in index; if push fails, catch-up push on next hit;
 *   BKA-7  Source gatekeeper: bake.ts / bake-cache.ts no longer references asset catalog
 *          (`mediaDir`), no longer directly reads/writes file system (`node:fs/promises`).
 *
 * Run: node --test server/test/bake-store.test.mjs (starts real HTTP asset service, fs
 * implementation placed in temp directory; no Chrome, no ffmpeg needed)
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createAssetHarness, ROOT } from './fake-asset-service.mjs';
import { BakeStoreError, bakeUrlOf, createBakeStore, setBakeRemote, bakeRemote } from '../bake-store.mjs';
import { createAssetClient } from '../asset-store/client.mjs';
import { refusingPort } from './fake-ws-kit.mjs';

const harness = createAssetHarness();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bake-store-test-'));
after(async () => {
  setBakeRemote(null);
  await harness.cleanup();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const indexDir = () => path.join(TMP, `index-${++seq}`);
/** A decent PNG: 8-byte signature + random trailer (asset service does not decode, only inspects bytes) */
const png = (n = 2048) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(n)]);
const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve({ server: s, origin: `http://127.0.0.1:${s.address().port}` }));
});
const closeServer = (s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); });
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(25);
  }
}
/** File names recursively listed in the directory */
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

test('BKA-1 write and read back: the PNG goes into px through the asset service, the address is by content hash, the retrieved bytes are identical; the asset catalog has no file it wrote directly', async () => {
  const srv = await harness.serve({ stores: 'default' }); // fs implementation: media → <root>/out/media, px → <root>/out/asset-store/px
  const dir = indexDir();
  const store = createBakeStore({ indexDir: dir, origin: () => srv.origin, remote: () => null });
  const key = 'a1b2c3d4e5f6';
  assert.equal(await store.lookup(key), null, 'Never rendered');
  const bytes = png();
  const e = await store.put(key, bytes, { width: 512, height: 512, clipId: 'c1', name: `bake-c1-${key}.png` });
  assert.equal(e.hash, sha256(bytes));
  assert.equal(e.url, bakeUrlOf(e.hash));
  assert.match(e.url, /^\/api\/asset\/px\/[0-9a-f]{64}$/);
  assert.equal(e.bytes, bytes.length);

  const res = await fetch(`${srv.origin}${e.url}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes, 'The bytes retrieved through the asset service are identical');

  const hit = await store.lookup(key);
  assert.equal(hit?.hash, e.hash, 'A second lookup hits');
  assert.equal(hit.url, e.url);

  const mediaFiles = walk(path.join(srv.root, 'out', 'media')).map((f) => path.basename(f));
  assert.deepEqual(mediaFiles.filter((n) => /^bake-/.test(n)), [], 'No bake-*.png in the asset catalog');
  assert.ok(!mediaFiles.some((n) => n.startsWith(e.hash)), 'Not in the asset (media) namespace either');
  assert.deepEqual(fs.readdirSync(dir), [`${key}.json`], 'Only <key>.json in the index directory');
  const idx = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8'));
  assert.equal(idx.hash, e.hash);
  assert.equal(idx.clipId, 'c1');
  // Asset service side indeed received completely (reconcile is the single source of truth)
  const st = await (await fetch(`${srv.base}/px/${e.hash}/chunks`)).json();
  assert.equal(st.complete, true);
  await srv.close();
});

test('BKA-2 a hit must be confirmed with the asset service: in the index but not on the asset service → treat as never rendered, delete the index entry', async () => {
  const srv = await harness.serve(); // Memory implementation
  const dir = indexDir();
  const store = createBakeStore({ indexDir: dir, origin: () => srv.origin, remote: () => null });
  fs.mkdirSync(dir, { recursive: true });
  const key = 'bbbbbbbbbbbb';
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ key, hash: 'cd'.repeat(32), bytes: 10 }));
  assert.equal(await store.lookup(key), null);
  assert.ok(!fs.existsSync(path.join(dir, `${key}.json`)), 'The stale index entry is deleted');
  // Bad entries (not JSON / key mismatch) treated as non-existent
  fs.writeFileSync(path.join(dir, `${key}.json`), '{oops');
  assert.equal(await store.lookup(key), null);
  assert.equal(await store.lookup('../../etc/x'), null, 'An invalid key does not touch the file system');
  await srv.close();
});

test('BKA-3 old addresses can still be fetched as usual; migrate on read pushes the old file into px through the asset service and leaves the old file alone; non-PNG files are not migrated', async () => {
  const srv = await harness.serve({ stores: 'default' });
  const media = path.join(srv.root, 'out', 'media');
  const key = 'c0ffee123456';
  const name = `bake-clip_1-${key}.png`;
  const old = png(4096);
  fs.writeFileSync(path.join(media, name), old); // Files left behind by previous bake_card (test fixture setup, not written by code under test)

  // /@media/bake-….png stored in legacy project parameters: asset service legacy read route responds as usual
  const legacy = await fetch(`${srv.origin}/@media/${encodeURIComponent(name)}`);
  assert.equal(legacy.status, 200);
  assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), old);

  const seen = [];
  const counting = (url, init) => { seen.push(String(url)); return fetch(url, init); };
  const store = createBakeStore({ indexDir: indexDir(), origin: () => srv.origin, fetchImpl: counting, remote: () => null });
  assert.equal(await store.lookup(key), null, 'Not in the index yet');
  const moved = await store.migrateLegacy(key, name, { width: 800, height: 450, clipId: 'clip_1' });
  assert.ok(moved?.migrated, 'Migrated');
  assert.equal(moved.hash, sha256(old));
  assert.ok(seen.some((u) => u.endsWith(`/@media/${encodeURIComponent(name)}`)), 'The old file is fetched through the asset service\'s legacy read route');
  const back = await fetch(`${srv.origin}${moved.url}`);
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), old, 'The bytes in px are identical to the old file');
  assert.ok(fs.existsSync(path.join(media, name)), 'The old file is not deleted');
  assert.equal((await store.lookup(key))?.hash, moved.hash, 'Hits directly afterwards');
  const again = await fetch(`${srv.origin}/@media/${encodeURIComponent(name)}`);
  assert.equal(again.status, 200, 'The old address can still be fetched after migration');

  // No old file: return null; not a PNG: do not migrate
  assert.equal(await store.migrateLegacy('dddddddddddd', 'bake-x-dddddddddddd.png'), null);
  fs.writeFileSync(path.join(media, 'bake-x-eeeeeeeeeeee.png'), 'not a png');
  assert.equal(await store.migrateLegacy('eeeeeeeeeeee', 'bake-x-eeeeeeeeeeee.png'), null);
  // Do not fetch names that do not look like old format (do not treat it as arbitrary file read endpoint)
  assert.equal(await store.migrateLegacy('ffffffffffff', '../secret.png'), null);
  assert.equal(await store.migrateLegacy('ffffffffffff', 'foo.mp4'), null);
  await srv.close();
});

test('BKA-4 asset service unreachable / rejecting: return a clear error (stating the address and the reason)', async () => {
  const none = createBakeStore({ indexDir: indexDir(), origin: () => null, remote: () => null });
  await assert.rejects(none.put('aaaaaaaaaaaa', png()), (e) => e instanceof BakeStoreError && e.kind === 'asset-service' && /Asset service unreachable.*cannot get the asset service address/.test(e.message));

  const s = await refusingPort();
  after(() => s.close());
  const closed = `http://127.0.0.1:${s.port}`;
  const down = createBakeStore({ indexDir: indexDir(), origin: () => closed, remote: () => null, retries: 0, timeoutMs: 3000 });
  await assert.rejects(down.put('aaaaaaaaaaaa', png()), (e) => e instanceof BakeStoreError && e.message.includes(`Asset service unreachable (${closed}/api/asset)`) && /write/.test(e.message));
  await assert.rejects(down.migrateLegacy('aaaaaaaaaaaa', 'bake-a-aaaaaaaaaaaa.png'), (e) => e instanceof BakeStoreError && e.message.includes(closed));
  // Key exists in index, but connection fails when querying reconcile: clear error as well, do not
  // treat as "never rendered"
  const dir = indexDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'aaaaaaaaaaaa.json'), JSON.stringify({ key: 'aaaaaaaaaaaa', hash: 'ab'.repeat(32), bytes: 5 }));
  const down2 = createBakeStore({ indexDir: dir, origin: () => closed, remote: () => null, retries: 0, timeoutMs: 3000 });
  await assert.rejects(down2.lookup('aaaaaaaaaaaa'), (e) => e instanceof BakeStoreError && /Asset service unreachable/.test(e.message));
  assert.ok(fs.existsSync(path.join(dir, 'aaaaaaaaaaaa.json')), 'The index is not deleted when the connection fails');

  // Reject (non-local, no ticket → 401)
  const srv = await harness.serve({ isTrusted: () => false, tickets: null });
  const denied = createBakeStore({ indexDir: indexDir(), origin: () => srv.origin, remote: () => null, retries: 0 });
  await assert.rejects(denied.put('aaaaaaaaaaaa', png()), (e) => e instanceof BakeStoreError && e.status === 401 && e.message.includes(`Asset service rejected the write (${srv.base}, HTTP 401)`));
  await srv.close();
});

test('BKA-5 the inventory reports only complete entries; eviction only deletes keys that match entries in the index, and the bytes stay in the asset service', async () => {
  const srv = await harness.serve();
  const dir = indexDir();
  const store = createBakeStore({ indexDir: dir, origin: () => srv.origin, remote: () => null });
  const a = await store.put('111111111111', png(100));
  const b = await store.put('222222222222', png(200));
  fs.writeFileSync(path.join(dir, '333333333333.json'), JSON.stringify({ key: '333333333333', hash: 'ef'.repeat(32), bytes: 7 }));
  const st = await store.status(['111111111111', '222222222222', '333333333333', '444444444444', 'nope']);
  assert.deepEqual([...st.keys()].sort(), ['111111111111', '222222222222']);
  assert.equal(st.get('111111111111').url, a.url);
  assert.ok(!fs.existsSync(path.join(dir, '333333333333.json')), 'An index entry with nothing behind it in the asset service is deleted on the spot');

  const list = await store.list();
  assert.equal(list.length, 2);
  fs.writeFileSync(path.join(TMP, 'victim.txt'), 'keep me');
  const ev = await store.evict(['111111111111', '../victim', '/etc/passwd', 42, 'zzzzzzzzzzzz']);
  assert.deepEqual(ev.deleted, ['111111111111']);
  assert.equal(ev.freedBytes, a.bytes);
  assert.ok(fs.existsSync(path.join(TMP, 'victim.txt')), 'A path-like key cannot touch other files');
  assert.equal(await store.lookup('111111111111'), null, 'No longer hits after eviction');
  assert.equal((await store.lookup('222222222222'))?.hash, b.hash);
  const still = await fetch(`${srv.origin}${a.url}`);
  assert.equal(still.status, 200, 'The bytes stay in the asset service (there is no delete endpoint)');
  // Write the same image again: only one reconcile, do not retransmit
  const client = createAssetClient({ base: srv.base });
  assert.equal((await client.put('px', await (await fetch(`${srv.origin}${a.url}`)).arrayBuffer().then((x) => Buffer.from(x)))).uploaded, false);
  await srv.close();
});

test('BKA-6 shared project: when a remote asset service is registered, push a copy over after writing; a failed push is re-pushed on the next hit', async () => {
  const local = await harness.serve();
  const remote = await harness.serve();
  const dir = indexDir();
  const events = [];
  let remoteClient = createAssetClient({ base: remote.base });
  setBakeRemote(() => remoteClient);
  assert.equal(bakeRemote(), remoteClient);
  const store = createBakeStore({ indexDir: dir, origin: () => local.origin, log: (ev, f) => events.push({ ev, ...f }) });
  const bytes = png(300);
  const e = await store.put('555555555555', bytes);
  const pushed = await until(async () => (await fetch(`${remote.base}/px/${e.hash}/chunks`).then((r) => r.json())).complete === true);
  assert.ok(pushed, 'The remote asset service received everything');
  const got = await fetch(`${remote.origin}${e.url}`);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes, 'The bytes retrieved from the remote are identical');
  assert.ok(await until(() => JSON.parse(fs.readFileSync(path.join(dir, '555555555555.json'), 'utf8')).pushed === remote.base), 'The index records which machine it was pushed to');

  // Push failed (remote unreachable): write succeeds as usual; after switching back to reachable
  // remote, catch-up push on next hit
  const s = await refusingPort();
  after(() => s.close());
  const closed = `http://127.0.0.1:${s.port}`;
  remoteClient = createAssetClient({ base: `${closed}/api/asset`, retries: 0, timeoutMs: 2000 });
  const f = await store.put('666666666666', png(400));
  assert.ok(await until(() => events.some((x) => x.ev === 'bake.push-failed' && x.key === '666666666666')), 'A failed push is logged, not thrown');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '666666666666.json'), 'utf8')).pushed, undefined);
  remoteClient = createAssetClient({ base: remote.base });
  assert.equal((await store.lookup('666666666666'))?.hash, f.hash);
  assert.ok(await until(async () => (await fetch(`${remote.base}/px/${f.hash}/chunks`).then((r) => r.json())).complete === true), 'Re-pushed on hit');
  setBakeRemote(null);
  assert.equal(bakeRemote(), null);
  await local.close();
  await remote.close();
});

test('BKA-7 source gatekeeper: bake.ts / bake-cache.ts no longer reference the asset catalog or read and write the file system directly', () => {
  for (const f of ['server/vision/bake.ts', 'server/vision/bake-cache.ts']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /\bmediaDir\b/, `${f} does not reference mediaDir`);
    assert.doesNotMatch(src, /from "node:fs(\/promises)?"/, `${f} does not read or write the file system directly`);
    assert.doesNotMatch(src, /vite-plugin-media/, `${f} does not import the media plugin`);
  }
  const bake = fs.readFileSync(path.join(ROOT, 'server/vision/bake.ts'), 'utf8');
  assert.match(bake, /store\.put\(key, r\.buf/, 'Rendered bytes are stored through bake-store');
  assert.match(bake, /store\.lookup\(key\)/, 'Hits are looked up through bake-store');
  assert.match(bake, /store\.migrateLegacy\(key, name/, 'The single-item path migrates on read');
  assert.match(bake, /store\.migrateLegacy\(tg\.key, tg\.name/, 'The batch path migrates on read');
});

test('BKA-8 another member of a shared project: when the local asset service does not have this px block, fetch it once from the currently connected remote asset service, verify and store it, then answer', async () => {
  const pull = await import('../media-pull.mjs');
  const a = await harness.asset();
  const remote = await harness.serve();
  const bytes = png(1500);
  const { hash } = await createAssetClient({ base: remote.base }).put('px', bytes, { ext: 'png' });

  /** Local asset service: memory data layer, pullArtifact uses default (current remote of media-pull) */
  const stores = { media: await harness.memoryStore(), snap: await harness.memoryStore(), px: await harness.memoryStore() };
  const serveWith = async (opts) => {
    const mw = a.assetServiceMiddleware(path.join(TMP, `local-${++seq}`), { stores, ...opts });
    const s = await listen((req, res) => { void mw(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
    return s;
  };
  const local = await serveWith({});
  try {
    pull.resetPullStateForTest();
    // Not connected to remote: 404 as usual
    assert.equal((await fetch(`${local.origin}/api/asset/px/${hash}`)).status, 404);

    pull.setRemoteAssetService({ base: remote.base });
    const res = await fetch(`${local.origin}/api/asset/px/${hash}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes, 'The retrieved bytes are identical');
    assert.equal((await stores.px.chunks(hash)).complete, true, 'Stored in the local asset service');
    const pulls = () => pull.pullLog().filter((e) => e.event === 'artifact.pull' && e.hash === hash).length;
    assert.equal(pulls(), 1);
    assert.equal((await fetch(`${local.origin}/api/asset/px/${hash}`)).status, 200);
    assert.equal(pulls(), 1, 'The second time is a local hit and the remote is no longer asked');
    // Also missing on remote: 404 (media-pull on remote machine also points to itself: header carried
    // by on-demand pull stops it from pulling further down, preventing loops and waiting for timeout)
    assert.equal((await fetch(`${local.origin}/api/asset/px/${'ab'.repeat(32)}`)).status, 404);
  } finally {
    pull.resetPullStateForTest();
    await closeServer(local.server);
  }

  // Retrieved bytes incorrect (content hash mismatch): not stored, 404
  const liar = await serveWith({ pullArtifact: async () => ({ bytes: png(10), contentType: 'image/png' }) });
  const other = 'cd'.repeat(32);
  assert.equal((await fetch(`${liar.origin}/api/asset/px/${other}`)).status, 404);
  assert.equal((await stores.px.chunks(other)).complete, false);
  await closeServer(liar.server);
  // pullArtifact: null disabled
  let asked = 0;
  const off = await serveWith({ pullArtifact: null });
  pull.setRemoteAssetService({ base: remote.base });
  const fresh = png(20);
  const fh = (await createAssetClient({ base: remote.base }).put('px', fresh)).hash;
  assert.equal((await fetch(`${off.origin}/api/asset/px/${fh}`)).status, 404);
  pull.resetPullStateForTest();
  await closeServer(off.server);
  // Read from non-local without ticket: reject first (401), will not pull from remote on its behalf
  const guarded = await serveWith({ isTrusted: () => false, tickets: null, pullArtifact: async () => { asked++; return null; } });
  assert.equal((await fetch(`${guarded.origin}/api/asset/px/${fh}`)).status, 401);
  assert.equal(asked, 0);
  await closeServer(guarded.server);
  await remote.close();
});

test('BKA-9 no push when the registered "remote" is the local asset service', async () => {
  const local = await harness.serve();
  let puts = 0;
  const client = createAssetClient({ base: local.base });
  setBakeRemote(() => ({ base: `${local.base}/`, put: (...x) => { puts++; return client.put(...x); } }));
  try {
    const store = createBakeStore({ indexDir: indexDir(), origin: () => local.origin });
    const e = await store.put('777777777777', png(50));
    await sleep(100);
    assert.equal(puts, 0);
    assert.equal((await store.lookup('777777777777'))?.hash, e.hash);
    await sleep(100);
    assert.equal(puts, 0);
  } finally {
    setBakeRemote(null);
    await local.close();
  }
});

/* ------------------------------------------------------------------ px capacity eviction (asset-store/px-evict.mjs) */

test('BKA-10 eviction plan: when over the cap, delete from oldest to newest by last use down to 90% of the cap; entries within the protection period are not deleted; nothing is deleted when not over the cap', async () => {
  const { planPxEviction, pxCapBytes, PX_EVICT_DEFAULTS } = await import('../asset-store/px-evict.mjs');
  const now = 10_000_000;
  const blobs = [
    { hash: 'a', size: 30, lastUsed: now - 5_000_000 },
    { hash: 'b', size: 30, lastUsed: now - 4_000_000 },
    { hash: 'c', size: 30, lastUsed: now - 3_000_000 },
    { hash: 'd', size: 30, lastUsed: now - 10 }, // Just used
  ];
  const p = planPxEviction(blobs, { capBytes: 100, now, protectMs: 60_000 });
  assert.equal(p.total, 120);
  assert.equal(p.target, 90);
  assert.deepEqual(p.victims.map((v) => v.hash), ['a'], 'Deleting the oldest one gets it below 90');
  const q = planPxEviction(blobs, { capBytes: 40, now, protectMs: 60_000 });
  assert.deepEqual(q.victims.map((v) => v.hash), ['a', 'b', 'c'], 'd is within the protection period and is not deleted even if over the cap');
  assert.deepEqual(planPxEviction(blobs, { capBytes: 120, now }).victims, [], 'Nothing is deleted when not over the cap');
  // Limit: environment variable takes precedence; if disk is under 500 GiB use 2%; otherwise 10 GiB
  assert.equal(pxCapBytes({ env: { PROMPTCUT_PX_CAP_BYTES: '1234' } }), 1234);
  assert.equal(pxCapBytes({ env: {}, diskTotal: 100 * 1024 ** 3 }), Math.floor(100 * 1024 ** 3 * 0.02));
  assert.equal(pxCapBytes({ env: {}, diskTotal: 2048 * 1024 ** 3 }), PX_EVICT_DEFAULTS.capBytes);
  assert.equal(pxCapBytes({ env: {}, diskTotal: null }), 10 * 1024 ** 3);
});

/** Real asset service (fs data layer, px with evictor, does not start automatically) mounted on http */
async function serveWithEvict(pxEvict) {
  const a = await harness.asset();
  const root = path.join(TMP, `evict-${++seq}`);
  fs.mkdirSync(path.join(root, 'out', 'media'), { recursive: true });
  const saved = process.env.PROMPTCUT_EXPORT_DIR;
  delete process.env.PROMPTCUT_EXPORT_DIR;
  // These cases drive eviction explicitly; onStored must not race the pre-eviction assertion.
  const mw = a.assetServiceMiddleware(root, { pxEvict: { start: false, ...pxEvict, options: { ...pxEvict.options, minIntervalMs: Number.MAX_SAFE_INTEGER } } });
  if (saved !== undefined) process.env.PROMPTCUT_EXPORT_DIR = saved;
  const s = await listen((req, res) => { void mw(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
  const evictor = await mw.pxEvictor();
  after(async () => { await evictor?.stop(); await closeServer(s.server); });
  return { ...s, root, base: `${s.origin}/api/asset`, pxDir: path.join(root, 'out', 'asset-store', 'px'), evictor };
}

test('BKA-11 when px on the local asset service exceeds the cap, delete by last use down to 90%: media is not touched by a single byte, recently used entries stay', async () => {
  const srv = await serveWithEvict({ capBytes: 10_000, options: { protectMs: 0 } });
  assert.ok(srv.evictor, 'The evictor is on with the default fs data layer');
  const client = createAssetClient({ base: srv.base });
  // Original asset: much larger than limit, never allowed to be deleted
  const movie = crypto.randomBytes(50_000);
  const { hash: mediaHash } = await client.put('media', movie, { ext: 'mp4' });
  const hashes = [];
  for (let i = 0; i < 5; i++) { hashes.push((await client.put('px', png(3000 - 8))).hash); await sleep(15); } // 5 × 3000 = 15000 > 10000
  await sleep(15);
  // Earliest written chunk was just fetched once: it becomes the most recently used
  assert.equal((await fetch(`${srv.base}/px/${hashes[0]}`)).status, 200);
  const r = await srv.evictor.evictNow();
  assert.equal(r.ran, true);
  assert.equal(r.total, 15000);
  assert.deepEqual(r.removed, [hashes[1], hashes[2]], 'Delete starting from the least recently used, until below 9000 (15000 → 9000)');
  for (const h of r.removed) assert.equal((await fetch(`${srv.base}/px/${h}/chunks`).then((x) => x.json())).complete, false);
  for (const h of [hashes[0], hashes[3], hashes[4]]) assert.equal((await fetch(`${srv.base}/px/${h}`)).status, 200, 'The remaining ones can still be fetched as usual');
  const m = await fetch(`${srv.base}/media/${mediaHash}`);
  assert.equal(m.status, 200);
  assert.deepEqual(Buffer.from(await m.arrayBuffer()), movie, 'media is not deleted');
  assert.ok(fs.existsSync(path.join(srv.pxDir, '.usage.json')), 'Usage times are recorded in .usage.json in the px directory');
  assert.equal((await srv.evictor.evictNow()).removed.length, 0, 'Already under the cap, nothing more is deleted');
  await srv.evictor.stop();
  await closeServer(srv.server);
});

test('BKA-12 entries used within the protection period are not deleted; at any moment only the one holding the lock evicts, and a stale lock is taken over after 3 minutes', async () => {
  const srv = await serveWithEvict({ capBytes: 1000 }); // Default grace period 30 minutes
  const client = createAssetClient({ base: srv.base });
  const h = (await client.put('px', png(3000))).hash;
  let r = await srv.evictor.evictNow();
  assert.deepEqual(r.removed, [], 'Just-written entries (used within 30 minutes) are not deleted, even when over the cap');
  assert.equal((await fetch(`${srv.base}/px/${h}`)).status, 200);
  // Lock: held by another process → skip this round
  const lock = path.join(srv.pxDir, '.evict-lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now() }));
  r = await srv.evictor.evictNow();
  assert.equal(r.ran, false, 'Skip when the lock cannot be obtained');
  assert.ok(fs.existsSync(lock), 'Someone else\'s lock is left alone');
  // Lock not updated for over 3 minutes: considered deadlock, delete and take over
  const old = new Date(Date.now() - 4 * 60_000);
  fs.utimesSync(lock, old, old);
  r = await srv.evictor.evictNow();
  assert.equal(r.ran, true, 'Stale lock taken over');
  assert.ok(!fs.existsSync(lock), 'Release the lock when done');
  await srv.evictor.stop();
  await closeServer(srv.server);
});

test('BKA-13 requesting a snapshot again after it was evicted: reconciling the index gets "none", the index entry is deleted, and it falls back to the re-render path', async () => {
  const srv = await serveWithEvict({ capBytes: 0, options: { protectMs: 0 } });
  const dir = indexDir();
  const store = createBakeStore({ indexDir: dir, origin: () => srv.origin, remote: () => null });
  const e = await store.put('888888888888', png(500));
  assert.equal((await store.lookup('888888888888'))?.hash, e.hash, 'Hits before eviction');
  const r = await srv.evictor.evictNow();
  assert.deepEqual(r.removed, [e.hash]);
  assert.equal(await store.lookup('888888888888'), null, 'No longer hits after eviction (bakeOne gets null and goes to render)');
  assert.ok(!fs.existsSync(path.join(dir, '888888888888.json')), 'The index entry is deleted');
  // Write back after re-render: hits again
  const again = await store.put('888888888888', png(500));
  assert.equal((await store.lookup('888888888888'))?.hash, again.hash);
  await srv.evictor.stop();
  await closeServer(srv.server);
});

test('BKA-14 eviction is not turned on when a custom px data layer is injected, or pxEvict: null, or PROMPTCUT_PX_EVICT=0', async () => {
  const a = await harness.asset();
  const root = path.join(TMP, `noevict-${++seq}`);
  const own = a.assetServiceMiddleware(root, { stores: { px: await harness.memoryStore() } });
  assert.equal(await own.pxEvictor(), null);
  assert.equal(await a.assetServiceMiddleware(root, { pxEvict: null }).pxEvictor(), null);
  process.env.PROMPTCUT_PX_EVICT = '0';
  try { assert.equal(await a.assetServiceMiddleware(root, {}).pxEvictor(), null); } finally { delete process.env.PROMPTCUT_PX_EVICT; }
});
