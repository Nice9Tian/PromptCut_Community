/**
 * Prerender output push and pull (contract `docs/plan/artifact-transfer-contract.md` Sections 3-6,
 * Section 7 test cases T1-T8).
 * Run: node --experimental-test-module-mocks --test server/test/artifact-transfer.test.mjs
 *
 * Written strictly against the contract, without looking at the implementation.
 *
 * Conventions:
 *   - Two temporary frame stores A and B, each with a real `FramePipeline`: injects `environment`
 *     (without probing), `dataRoot` points to temporary directory; `server/bakery/index.mjs`
 *     replaced entirely with a mock (using `mock.module` just like
 *     `card-lock-pipeline.test.mjs`), does not launch Chrome. Only uses its frame store
 *     (`snapshots()`), snapshot writing (`commitSnapshots`), ready index (`ready`), and stream
 *     storage (`streamProducer()`). Snapshot test cases use `interactive: false`; stream test cases
 *     use `interactive: true` (producers exist only in this kind of instance), manually call
 *     `attachRoute()`, and set `encoderName` to a fixed name (does not probe encoders, does not
 *     spawn workers).
 *   - A shared asset service (`fake-asset-service.mjs`, port 0, memory implementation), client uses
 *     `server/asset-store/client.mjs`.
 *   - A's outputs are created directly using write functions: snapshots go through
 *     `commitSnapshots`; streams are handwritten in `frame-stream.mjs` format as
 *     `streams/<streamKey>/stream.json` + `init-<sha16>.mp4` + `<n>-<sha16>.m4s` (bytes are
 *     fabricated, not real fMP4).
 *   - Tasks (`TaskView`) are created in the shape of `render-queue-contract.md` B.4 / E.5 / F.1:
 *     result key = `resultKeyOf(input.contentKey, requires.envFingerprint)`; the task's lock
 *     fingerprint (`requires.envFingerprint`) is intentionally different from the two
 *     `FramePipeline` instances' own environment fingerprints, verifying that the on-disk key uses
 *     the task's fingerprint.
 *   - `result` is passed to `applyResult` after a JSON round-trip (simulating crossing the wire
 *     with `task.done`).
 *   - Section 4 of the contract states that `collect*` "also returns a `readBlob`" without defining
 *     the shape: both forms are accepted here: returning `{ result, readBlob }`, or returning the
 *     manifest itself with `readBlob` attached to it (see `unpack`).
 *
 * When implementation modules (`server/artifact-transfer.mjs`, `server/asset-store/client.mjs`) do
 * not exist yet, each test case fails individually and reports the reason.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAssetHarness } from './fake-asset-service.mjs';

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('Unit test does not open Chrome'); },
    findFfmpeg: async () => { throw new Error('Unit test does not look for ffmpeg'); },
    streamPngVideo: () => { throw new Error('Unit test does not encode'); },
    bakeFrames: async () => { throw new Error('Unit test does not prerender'); },
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { snapshotDir } = await import('../snapshot-store.mjs');
const { segmentSignature } = await import('../frame-stream.mjs');
const { describeEnvironment, resultKeyOf } = await import('../render-node/fingerprint.mjs');

let transfer = null, transferError = null;
try { transfer = await import('../artifact-transfer.mjs'); } catch (err) { transferError = err; }
let clientMod = null, clientError = null;
try { clientMod = await import('../asset-store/client.mjs'); } catch (err) { clientError = err; }
function T() {
  if (transferError) throw new Error(`Cannot load server/artifact-transfer.mjs: ${transferError.message}`);
  return transfer;
}
function newClient(base) {
  if (clientError) throw new Error(`Cannot load server/asset-store/client.mjs: ${clientError.message}`);
  return clientMod.createAssetClient({ base });
}

const harness = createAssetHarness();
after(() => harness.cleanup());

/* ------------------------------------------------------------------ Constants and helpers */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha16 = (buf) => sha256(buf).slice(0, 16);
const HEX64 = /^[0-9a-f]{64}$/;
const RESULT_LIMIT = 256 * 1024;

const OWN_ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
/**
 * Task lock fingerprint: a machine with NVIDIA installed (different from both FramePipeline
 * instances' own fingerprints)
 */
const TASK_FP = describeEnvironment({
  platform: 'Win32', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', vendor: 'Google Inc. (NVIDIA)',
  chromeVersion: 'HeadlessChrome/138.0.7204.49',
}).fingerprint;
assert.notEqual(TASK_FP, OWN_ENV.fingerprint);

const SHARED_CAPS = { compositing: 'independent', frameMode: 'stateful' };
const LOCAL_CAPS = { compositing: 'belowDependent', frameMode: 'stateful' };

async function withRoots(n, fn) {
  const roots = [];
  for (let i = 0; i < n; i++) roots.push(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-c62-lib-')));
  const pipelines = [];
  const make = (root, { interactive = false } = {}) => {
    const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive });
    pipelines.push(p);
    return p;
  };
  try { return await fn(roots, make); } finally {
    await Promise.allSettled(pipelines.map((p) => p.close()));
    await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
  }
}

/** Snapshot task (shape of B.4 / E.5 / E.9 / F.1) */
function snapshotTask({ tier = 'shared', contentKey, entryKey = null, from, to, clipId = 'clip-x', fp = TASK_FP }) {
  const inputKey = tier === 'local' ? `${entryKey}/${contentKey}` : contentKey;
  const resultKey = resultKeyOf(inputKey, fp);
  return {
    id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier, resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: 'plan:p1@1' },
    input: { clipId, cardId: null, entryKey: tier === 'local' ? entryKey : null, contentKey: inputKey },
    weight: { class: 'heavy', estMs: null, frames: to - from + 1 },
    requires: { envFingerprint: fp, codeVersion: 'c', cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: tier === 'local' },
    priority: 10, state: 'claimed', version: 1, attempts: 1,
  };
}
/**
 * On-disk key for shared tier = result key; local tier = resultKeyOf(content key stripped of
 * entryKey prefix, task lock fingerprint) (E.9)
 */
const dirKeyOf = (task) => (task.tier === 'local' ? resultKeyOf(task.input.contentKey.slice(task.input.entryKey.length + 1), task.requires.envFingerprint) : task.resultKey);

function streamTask({ streamKey, contentKey, from, to, clipId = 'clip-s', fp = TASK_FP }) {
  return {
    id: `stream:${streamKey}:${from}-${to}`, kind: 'stream', resultKey: streamKey,
    range: { unit: 'segment', from, to },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: 'plan:p1@1' },
    input: { clipId, cardId: null, entryKey: null, contentKey },
    weight: { class: 'heavy', estMs: null, frames: (to - from + 1) * 15 },
    requires: { envFingerprint: fp, codeVersion: 'c', cardSources: {}, transcode: true, userCards: false, graphCards: false, belowDependent: false },
    priority: 10, state: 'claimed', version: 1, attempts: 1,
  };
}

const htmlOf = (n, tag = 'A') => `<div data-pc-scene="" data-f="${n}">${tag} frame ${n} ${'·'.repeat(n % 7)}</div>`;
const BIG = 17;
const bigHtml = () => `<div data-pc-scene="">${'x'.repeat(310 * 1024)}</div>`;

/** Writes the `frames` frames into A's shared tier / local tier (where the BIG frame exceeds 300 KB) */
async function seedSnapshots(pipeline, task, frames, { tag = 'A', big = true, capabilities } = {}) {
  const caps = capabilities ?? (task.tier === 'local' ? LOCAL_CAPS : SHARED_CAPS);
  const items = frames.map((n) => ({ localFrame: n, html: big && n === BIG ? bigHtml() : htmlOf(n, tag) }));
  return pipeline.snapshots().commitSnapshots({
    tier: task.tier, entryKey: task.input.entryKey ?? undefined, key: dirKeyOf(task), clipId: task.input.clipId, capabilities: caps, items,
  });
}

/**
 * Unpacks the return value of `collect*` into { result, readBlob }; result undergoes a JSON
 * round-trip (dropping function properties) to reflect what crosses the wire
 */
function unpack(out) {
  assert.ok(out && typeof out === 'object', 'collect* must return an object');
  const direct = out.v !== undefined || out.kind !== undefined;
  const result = direct ? out : out.result;
  const readBlob = direct ? out.readBlob : (out.readBlob ?? out.result?.readBlob);
  assert.ok(result && typeof result === 'object', 'Cannot get the manifest (result)');
  assert.equal(typeof readBlob, 'function', 'collect* must also provide readBlob(hash)');
  return { result: JSON.parse(JSON.stringify(result)), readBlob, raw: result };
}
const wire = (result) => JSON.parse(JSON.stringify(result));

async function filesOf(dir) {
  let names = [];
  try { names = await fs.readdir(dir); } catch { return {}; }
  const out = {};
  for (const name of names.sort()) out[name] = await fs.readFile(path.join(dir, name));
  return out;
}
const expectedFrameList = async (dir, frames) => Promise.all(frames.map(async (n) => {
  const buf = await fs.readFile(path.join(dir, `${n}.html`));
  return [n, sha256(buf), buf.length];
}));
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Client wrapper that counts get calls */
function countingClient(client) {
  const gets = [];
  const puts = [];
  return {
    gets, puts,
    put: (ns, bytes, opts) => { puts.push({ ns, size: bytes.length }); return client.put(ns, bytes, opts); },
    get: (ns, hash) => { gets.push({ ns, hash }); return client.get(ns, hash); },
    has: (ns, hash) => client.has(ns, hash),
  };
}

/**
 * Attaches a mock entry and a page session to B: used to check whether claimSessions emitted a layer
 * after adoptResult
 */
function watchEntry(pipeline, { entryKey, controls }) {
  const entry = { key: entryKey, project: { fps: 30 }, cardPlan: controls };
  pipeline.entries.set(entryKey, entry);
  const seen = [];
  pipeline.ready.subscribe('page', (m) => seen.push(m));
  pipeline.ready.adopt('page', entryKey, 1);
  return { entry, seen, layers: () => seen.filter((m) => m.type === 'layer') };
}
const staged = (pipeline, kind, key) => pipeline.ready.stagedKeys().find((s) => s.kind === kind && s.key === key) ?? null;

/* ------------------------------------------------------------------ T1 */

test('T1 A\'s shared tier writes 60 frames (including 1 frame over 300 KB): the frame count and hashes from collectSnapshotResult match the files; after pushResult every chunk is present in snap', async () => {
  await withRoots(1, async ([rootA], make) => {
    const A = make(rootA);
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const task = snapshotTask({ contentKey: sha256('card-T1'), from: 0, to: 59 });
    const idx = await seedSnapshots(A, task, range(0, 59));
    assert.deepEqual(idx.oversize, [[BIG, BIG]], 'Fixture: frame 17 is oversize');
    assert.deepEqual(idx.frames, [[0, BIG - 1], [BIG + 1, 59]]);

    const { result, readBlob, raw } = unpack(await T().collectSnapshotResult(A, task));
    const dir = snapshotDir(rootA, { tier: 'shared', key: task.resultKey });
    assert.equal(result.v, 1);
    assert.equal(result.kind, 'snapshot');
    assert.equal(result.tier, 'shared');
    assert.equal(result.resultKey, task.resultKey);
    assert.equal(result.dirKey, task.resultKey, 'Shared tier dirKey = resultKey');
    assert.equal(result.entryKey, null, 'Shared tier entryKey is null');
    assert.deepEqual({ from: result.range.from, to: result.range.to }, { from: 0, to: 59 });
    assert.equal(result.canvasHeavy, false, 'DOM card canvasHeavy is false');
    assert.equal(result.frames.length, 60, 'The oversize frame is in the manifest too');
    assert.deepEqual(result.frames, await expectedFrameList(dir, range(0, 59)), '[localFrame, sha256, bytes], in ascending frame order');
    assert.ok(result.frames.every(([, h]) => HEX64.test(h)));
    assert.ok(JSON.stringify(raw).length <= RESULT_LIMIT, 'Manifest ≤ 256 KiB');
    for (const [n, h] of [result.frames[0], result.frames[BIG], result.frames[59]]) {
      const buf = await readBlob(h);
      assert.ok(Buffer.isBuffer(buf), `readBlob(${n}) returns a Buffer`);
      assert.equal(sha256(buf), h, `The bytes from readBlob(${n}) match the hash`);
    }

    const pushed = await T().pushResult(client, raw, readBlob);
    const distinct = new Set(result.frames.map(([, h]) => h)).size;
    assert.equal(pushed.uploaded + pushed.skipped, distinct, `uploaded + skipped = chunk count: ${JSON.stringify({ uploaded: pushed.uploaded, skipped: pushed.skipped })}`);
    assert.equal(pushed.uploaded, distinct, 'The asset service was empty: everything is uploaded');
    assert.deepEqual(wire(pushed.result), result, 'pushResult returns the manifest as is');
    for (const [n, h, bytes] of result.frames) {
      const st = await srv.stores.snap.stat(h);
      assert.ok(st, `The chunk of frame ${n} is in snap`);
      assert.equal(st.size, bytes);
      assert.equal(await srv.stores.px.stat(h), null, `The chunk of frame ${n} is not in px`);
      assert.equal(await srv.stores.media.stat(h), null, `The chunk of frame ${n} is not in media`);
    }
    // Push again: skip all
    const again = await T().pushResult(client, raw, readBlob);
    assert.deepEqual([again.uploaded, again.skipped], [0, distinct], 'Chunks that already exist are not uploaded again');
  });
});

/* ------------------------------------------------------------------ T2 */

test('T2 B applyResult: controls-html/<dirKey>/ is byte-for-byte identical to A\'s and index.json matches (including oversize); the ready index did stageByKey for this key, and the session received layer', async () => {
  await withRoots(2, async ([rootA, rootB], make) => {
    const A = make(rootA), B = make(rootB);
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const task = snapshotTask({ contentKey: sha256('card-T2'), from: 0, to: 59 });
    await seedSnapshots(A, task, range(0, 59));
    const { result, readBlob, raw } = unpack(await T().collectSnapshotResult(A, task));
    await T().pushResult(client, raw, readBlob);

    const watch = watchEntry(B, { entryKey: sha256('entry-T2'), controls: [{ clipId: 'clip-x', snapshotKey: result.dirKey, tier: 'shared', capabilities: SHARED_CAPS, count: 60 }] });
    const out = await T().applyResult(B, client, wire(result));
    assert.equal(out.fetched, 60, `Fetched 60 chunks: ${JSON.stringify(out)}`);
    assert.equal(out.skipped, 0);
    assert.ok(out.written >= 59, `written ${out.written}`);

    const dirA = snapshotDir(rootA, { tier: 'shared', key: result.dirKey });
    const dirB = snapshotDir(rootB, { tier: 'shared', key: result.dirKey });
    const fa = await filesOf(dirA), fb = await filesOf(dirB);
    const htmlNames = (f) => Object.keys(f).filter((n) => n.endsWith('.html'));
    assert.deepEqual(htmlNames(fb), htmlNames(fa), 'The frame files are the same set');
    for (const name of htmlNames(fa)) assert.ok(fb[name].equals(fa[name]), `${name} is byte-for-byte identical`);
    assert.deepEqual(Object.keys(fb).sort(), [...htmlNames(fa), 'index.json'].sort(), 'B\'s directory has no other files (no half-written .tmp)');
    const ia = JSON.parse(fa['index.json'].toString('utf8')), ib = JSON.parse(fb['index.json'].toString('utf8'));
    assert.deepEqual(ib, ia, 'index.json matches');
    assert.deepEqual(ib.oversize, [[BIG, BIG]], 'B\'s commitSnapshots determines the oversize frames by itself');
    assert.deepEqual(await B.snapshots().snapshotIndex({ tier: 'shared', key: result.dirKey }), await A.snapshots().snapshotIndex({ tier: 'shared', key: result.dirKey }));

    const hit = staged(B, 'html', result.dirKey);
    assert.ok(hit, `B's ready index has this key attached: ${JSON.stringify(B.ready.stagedKeys())}`);
    assert.deepEqual(hit.ranges, ib.frames, 'The ranges match the frames in index.json (excluding oversize frames)');
    const layer = watch.layers().find((m) => m.clipId === 'clip-x');
    assert.ok(layer, `The session that uses this key received layer: ${JSON.stringify(watch.seen)}`);
    assert.deepEqual({ kind: layer.kind, key: layer.key, ranges: layer.ranges }, { kind: 'html', key: result.dirKey, ranges: ib.frames });
    // A was not touched
    assert.equal(staged(A, 'html', result.dirKey), null, 'A\'s index is unaffected by B\'s fetch');
  });
});

/* ------------------------------------------------------------------ T3 */

test('T3 Local tier: the conversion between dirKey and entryKey follows E.9; B lands in controls-local/<entryKey>/<dirKey>/', async () => {
  await withRoots(2, async ([rootA, rootB], make) => {
    const A = make(rootA), B = make(rootB);
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const entryKey = sha256('entry-T3');
    const contentKey = sha256('card-T3');
    const task = snapshotTask({ tier: 'local', entryKey, contentKey, from: 10, to: 29, clipId: 'clip-l' });
    const expectDir = resultKeyOf(contentKey, TASK_FP);
    assert.equal(dirKeyOf(task), expectDir);
    assert.notEqual(task.resultKey, expectDir, 'The local tier\'s task identity is not equal to the on-disk key (E.9)');
    await seedSnapshots(A, task, range(10, 29), { big: false });

    const { result, readBlob, raw } = unpack(await T().collectSnapshotResult(A, task));
    assert.equal(result.tier, 'local');
    assert.equal(result.resultKey, task.resultKey);
    assert.equal(result.entryKey, entryKey, 'Local tier entryKey is required');
    assert.equal(result.dirKey, expectDir, 'dirKey = resultKeyOf(content key with the "<entryKey>/" prefix removed, the task\'s lock fingerprint)');
    assert.notEqual(result.dirKey, resultKeyOf(contentKey, OWN_ENV.fingerprint), 'It uses the task\'s lock fingerprint, not this machine\'s fingerprint');
    assert.deepEqual({ from: result.range.from, to: result.range.to }, { from: 10, to: 29 });
    const dirA = snapshotDir(rootA, { tier: 'local', entryKey, key: expectDir });
    assert.deepEqual(result.frames, await expectedFrameList(dirA, range(10, 29)));
    await T().pushResult(client, raw, readBlob);

    const watch = watchEntry(B, { entryKey, controls: [{ clipId: 'clip-l', snapshotKey: expectDir, tier: 'local', capabilities: LOCAL_CAPS, count: 40 }] });
    const out = await T().applyResult(B, client, wire(result));
    assert.equal(out.fetched, 20);
    const dirB = path.join(rootB, 'controls-local', entryKey, expectDir);
    assert.equal(dirB, snapshotDir(rootB, { tier: 'local', entryKey, key: expectDir }));
    const fa = await filesOf(dirA), fb = await filesOf(dirB);
    assert.deepEqual(Object.keys(fb), Object.keys(fa));
    for (const name of Object.keys(fa)) {
      if (name === 'index.json') assert.deepEqual(JSON.parse(fb[name]), JSON.parse(fa[name]));
      else assert.ok(fb[name].equals(fa[name]), `${name} is byte-for-byte identical`);
    }
    assert.deepEqual(await filesOf(path.join(rootB, 'controls-html')), {}, 'The local tier does not land in the shared-tier directory');
    const hit = staged(B, 'local', `${entryKey}/${expectDir}`);
    assert.ok(hit, `the live key is <entryKey>/<dirKey>: ${JSON.stringify(B.ready.stagedKeys())}`);
    assert.deepEqual(hit.ranges, [[10, 29]]);
    const layer = watch.layers().find((m) => m.clipId === 'clip-l');
    assert.ok(layer, 'the session using this key received a layer');
    assert.deepEqual({ kind: layer.kind, key: layer.key, ranges: layer.ranges }, { kind: 'local', key: `${entryKey}/${expectDir}`, ranges: [[10, 29]] });
  });
});

/* ------------------------------------------------------------------ T4 */

test('T4 B already has some frames: download only the missing ones (count get calls), do not overwrite existing ones', async () => {
  await withRoots(2, async ([rootA, rootB], make) => {
    const A = make(rootA), B = make(rootB);
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const task = snapshotTask({ contentKey: sha256('card-T4'), from: 0, to: 59 });
    await seedSnapshots(A, task, range(0, 59));
    // B initially has 0-29 (contents differ from A: shows whether they were overwritten)
    await seedSnapshots(B, task, range(0, 29), { tag: 'B', big: false });
    const dirB = snapshotDir(rootB, { tier: 'shared', key: task.resultKey });
    const before = await filesOf(dirB);

    const { result, readBlob, raw } = unpack(await T().collectSnapshotResult(A, task));
    await T().pushResult(client, raw, readBlob);
    const counting = countingClient(client);
    const out = await T().applyResult(B, counting, wire(result));

    const want = new Set(result.frames.filter(([n]) => n >= 30).map(([, h]) => h));
    assert.equal(counting.gets.length, want.size, `download only the 30 missing frames: actual ${counting.gets.length} get calls`);
    assert.ok(counting.gets.every((g) => g.ns === 'snap' && want.has(g.hash)), 'everything downloaded is a chunk of a missing frame');
    assert.equal(counting.puts.length, 0, 'pull does not upload');
    assert.deepEqual([out.fetched, out.skipped], [30, 30], JSON.stringify(out));

    const after_ = await filesOf(dirB);
    for (const n of range(0, 29)) assert.ok(after_[`${n}.html`].equals(before[`${n}.html`]), `frame ${n} (B already has it) is not overwritten`);
    const dirA = snapshotDir(rootA, { tier: 'shared', key: task.resultKey });
    const fa = await filesOf(dirA);
    for (const n of range(30, 59)) assert.ok(after_[`${n}.html`].equals(fa[`${n}.html`]), `frame ${n} (pulled) is identical to A's`);
    const idx = await B.snapshots().snapshotIndex({ tier: 'shared', key: task.resultKey });
    assert.deepEqual(idx.frames, [[0, 59]], 'B\'s own frame 17 is within the limit; all pulled frames made it into the index');
    assert.deepEqual(staged(B, 'html', task.resultKey)?.ranges, [[0, 59]]);

    // Apply again: none are downloaded
    const again = countingClient(client);
    const out2 = await T().applyResult(B, again, wire(result));
    assert.equal(again.gets.length, 0, 'everything is already present: no download');
    assert.equal(out2.fetched, 0);
  });
});

/* ------------------------------------------------------------------ T5 */

const A_ENCODER = 'h264_nvenc';
const B_ENCODER = 'libx264';

/**
 * Manually constructs a stream under root following the `frame-stream.mjs` format: segments in
 * `segments` use init1, segments in `extra` use init2 (for "only list init used by this segment").
 * Returns { manifest, files: { name: Buffer } }.
 */
async function writeStreamFixture(root, { streamKey, segments, extra = [], encoder = A_ENCODER, seed = 1 }) {
  const dir = path.join(root, 'streams', streamKey);
  await fs.mkdir(dir, { recursive: true });
  const bound = { x: 0, y: 0, w: 64, h: 64 };
  const tight = { x: 8, y: 8, w: 48, h: 48 };
  const init1 = Buffer.concat([Buffer.from('....ftypiso6'), crypto.createHash('sha512').update(`init1-${seed}`).digest()]);
  const init2 = Buffer.concat([Buffer.from('....ftypiso6'), crypto.createHash('sha512').update(`init2-${seed}`).digest()]);
  const id1 = sha16(init1), id2 = sha16(init2);
  const files = { [`init-${id1}.mp4`]: init1 };
  const manifest = {
    // `originFrame`: this stream's own first frame (segment counting starts from it); results without
    // it in the manifest are not accepted elsewhere (`streamAdoption`)
    version: 1, streamKey, kind: 'card', plane: 'local', clipIds: ['clip-s'], fps: 30, originFrame: 45, bound, offset: { x: 32, y: 32 }, tight,
    inits: { [id1]: { codec: 'avc1.64001f', width: 48, height: 96, timescale: 15360, rect: tight, encoder, bytes: init1.length } },
    segments: {},
  };
  if (extra.length) {
    files[`init-${id2}.mp4`] = init2;
    manifest.inits[id2] = { codec: 'avc1.64001f', width: 64, height: 128, timescale: 15360, rect: bound, encoder, bytes: init2.length };
  }
  for (const n of [...segments, ...extra]) {
    const useExtra = extra.includes(n);
    const bytes = Buffer.concat([Buffer.from('....moof'), crypto.createHash('sha512').update(`seg-${seed}-${n}`).digest(), Buffer.alloc(200 + n, n)]);
    const file = `${n}-${sha16(bytes)}.m4s`;
    files[file] = bytes;
    const stride = useExtra ? 3 : 1;
    const rect = useExtra ? bound : tight;
    manifest.segments[n] = {
      file, init: useExtra ? id2 : id1, stride, samples: 15, bytes: bytes.length, encodeMs: 20, tailMs: 5,
      sig: segmentSignature({ streamKey, segment: n, stride, encoder, rect }), dropped: [], at: 1,
    };
  }
  for (const [name, buf] of Object.entries(files)) await fs.writeFile(path.join(dir, name), buf);
  await fs.writeFile(path.join(dir, 'stream.json'), JSON.stringify(manifest));
  return { manifest, files, dir };
}

function producerOf(pipeline) {
  const p = typeof pipeline.streams === 'function' ? pipeline.streams() : pipeline.streamProducer();
  assert.ok(p, 'cannot get the stream producer (streams() / streamProducer())');
  p.attachRoute();
  p.encoderName = B_ENCODER; // Local encoder name differs from A (scenario in survey conclusion Item 2); does not probe
  return p;
}

test('T5 stream: collectStreamResult, pushResult, B adoptSegments: segment files are identical, the manifest is merged into the producer state, pulled segments are not judged stale, ready publishes the stream range', async () => {
  await withRoots(3, async ([rootA, rootB, rootC], make) => {
    const A = make(rootA, { interactive: true });
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const contentKey = sha256('stream-T5');
    const streamKey = resultKeyOf(contentKey, TASK_FP);
    const fx = await writeStreamFixture(rootA, { streamKey, segments: [0, 1, 2, 3], extra: [4] });
    const task = streamTask({ streamKey, contentKey, from: 0, to: 3 });

    const { result, readBlob, raw } = unpack(await T().collectStreamResult(A, task));
    assert.equal(result.v, 1);
    assert.equal(result.kind, 'stream');
    assert.equal(result.resultKey, streamKey);
    assert.deepEqual({ from: result.range.from, to: result.range.to }, { from: 0, to: 3 });
    const top = fx.manifest;
    assert.deepEqual(result.header, { kind: top.kind, plane: top.plane, clipIds: top.clipIds, fps: top.fps, originFrame: 45, bound: top.bound, offset: top.offset, tight: top.tight }, 'header comes from the top level of stream.json (including the first frame of this stream)');
    const [id1, id2] = Object.keys(top.inits);
    assert.deepEqual(Object.keys(result.inits), [id1], 'list only the inits used by the segments in this range (segment 4\'s init is not included)');
    const init1 = fx.files[`init-${id1}.mp4`];
    assert.deepEqual(result.inits[id1], { hash: sha256(init1), bytes: init1.length, codec: top.inits[id1].codec, width: 48, height: 96, timescale: 15360, rect: top.tight, encoder: A_ENCODER });
    assert.deepEqual(Object.keys(result.segments).map(Number).sort((a, b) => a - b), [0, 1, 2, 3], 'list only the segments within this range');
    for (const n of [0, 1, 2, 3]) {
      const s = top.segments[n];
      const bytes = fx.files[s.file];
      assert.deepEqual(result.segments[n], { hash: sha256(bytes), bytes: bytes.length, init: id1, stride: 1, samples: 15, sig: s.sig, encoder: A_ENCODER }, `segment ${n}`);
    }
    assert.equal(id2 in result.inits, false);

    const pushed = await T().pushResult(client, raw, readBlob);
    assert.equal(pushed.uploaded + pushed.skipped, 5, '1 init + 4 segments');
    for (const h of [result.inits[id1].hash, ...[0, 1, 2, 3].map((n) => result.segments[n].hash)]) {
      assert.ok(await srv.stores.px.stat(h), `${h.slice(0, 8)} is in px`);
      assert.equal(await srv.stores.snap.stat(h), null, 'stream chunks do not go into snap');
    }

    // B: this stream has no state on B
    const B = make(rootB, { interactive: true });
    const prodB = producerOf(B);
    assert.equal(prodB.streams.get(streamKey), undefined, 'fixture: B has no state for this stream');
    await T().applyResult(B, client, wire(result));
    const dirA = fx.dir, dirB = path.join(rootB, 'streams', streamKey);
    const fb = await filesOf(dirB);
    for (const name of [`init-${id1}.mp4`, ...[0, 1, 2, 3].map((n) => top.segments[n].file)]) {
      assert.ok(fb[name], `B has ${name}`);
      assert.ok(fb[name].equals(await fs.readFile(path.join(dirA, name))), `${name} is identical to A's`);
    }
    assert.equal(fb[top.segments[4].file], undefined, 'segments outside the range are not pulled');
    assert.equal(fb[`init-${id2}.mp4`], undefined, 'inits outside the range are not pulled');
    assert.ok(Object.keys(fb).every((n) => !n.endsWith('.tmp')), 'no partial files');

    const state = prodB.streams.get(streamKey);
    assert.ok(state?.manifest, 'the manifest was merged into the producer\'s in-memory state (created if absent)');
    const disk = JSON.parse(fb['stream.json'].toString('utf8'));
    for (const m of [state.manifest, disk]) {
      assert.equal(m.streamKey, streamKey);
      assert.deepEqual(Object.keys(m.segments).map(Number).sort((a, b) => a - b), [0, 1, 2, 3]);
      for (const n of [0, 1, 2, 3]) {
        const seg = m.segments[n];
        assert.equal(seg.file, top.segments[n].file, `segment ${n} file name follows the existing naming`);
        assert.equal(seg.init, id1);
        assert.equal(seg.adopted, true, `segment ${n} is marked adopted: true`);
        assert.equal(seg.sig, top.segments[n].sig, `segment ${n} carries the peer's sig`);
        assert.equal(seg.encoder, A_ENCODER, `segment ${n} carries the peer's encoder`);
      }
      assert.ok(m.inits[id1], 'init is in the manifest');
    }
    assert.deepEqual(disk.segments, JSON.parse(JSON.stringify(state.manifest.segments)), 'stream.json is written to disk via StreamStore.save, consistent with memory');
    for (const n of [0, 1, 2, 3]) assert.notEqual(prodB.segmentState(state, n), 'stale', `segment ${n} (A encoded with ${A_ENCODER}, B's encoder is ${B_ENCODER}) is not judged stale`);
    const hit = staged(B, 'stream', streamKey);
    assert.ok(hit, `ready has kind: 'stream' attached: ${JSON.stringify(B.ready.stagedKeys())}`);
    assert.deepEqual(hit.ranges, [[0, 3]], 'the unit is the segment number');

    // C: this stream already has state on C; segment 0 was encoded by C itself and is not stale: skip,
    // do not overwrite; pull the rest; merge into the same state
    const C = make(rootC, { interactive: true });
    const prodC = producerOf(C);
    const own = await writeStreamFixture(rootC, { streamKey, segments: [0], encoder: B_ENCODER, seed: 99 });
    const spec = { streamKey, contentKey, envFingerprint: TASK_FP, kind: 'card', plane: 'local', clipIds: ['clip-s'], topClipId: 'clip-s', fps: 30,
      bound: own.manifest.bound, offset: own.manifest.offset, firstSegment: 0, lastSegment: 4, total: 75, members: [] };
    const cState = { spec, manifest: JSON.parse(JSON.stringify(own.manifest)), aliases: new Set(), entryKey: sha256('entry-T5'), reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set() };
    prodC.streams.set(streamKey, cState);
    prodC.entryKey = cState.entryKey;
    assert.equal(prodC.segmentState(cState, 0), 'dense', 'fixture: C\'s segment 0 is fresh');
    const watch = watchEntry(C, { entryKey: cState.entryKey, controls: [] });
    await T().applyResult(C, client, wire(result));
    assert.equal(prodC.streams.get(streamKey), cState, 'merged into the existing state, the object is not replaced');
    const mc = cState.manifest;
    assert.equal(mc.segments[0].file, own.manifest.segments[0].file, 'segment 0 (already present locally, not stale) is not overwritten');
    assert.notEqual(mc.segments[0].adopted, true);
    assert.equal(mc.segments[0].sig, own.manifest.segments[0].sig);
    const fc = await filesOf(path.join(rootC, 'streams', streamKey));
    assert.ok(fc[own.manifest.segments[0].file].equals(own.files[own.manifest.segments[0].file]), 'segment 0\'s file was not modified');
    for (const n of [1, 2, 3]) {
      assert.equal(mc.segments[n].adopted, true, `segment ${n} was pulled`);
      assert.ok(fc[top.segments[n].file]?.equals(fx.files[top.segments[n].file]), `segment ${n} file is identical to A's`);
      assert.notEqual(prodC.segmentState(cState, n), 'stale');
    }
    assert.deepEqual(JSON.parse(fc['stream.json']).segments, JSON.parse(JSON.stringify(mc.segments)), 'on-disk state matches memory');
    const layer = watch.layers().filter((m) => m.kind === 'stream' && m.key === streamKey).at(-1);
    assert.ok(layer, `published the stream layer through the existing publish(state): ${JSON.stringify(watch.seen)}`);
    assert.deepEqual({ clipId: layer.clipId, ranges: layer.ranges }, { clipId: 'clip-s', ranges: [[0, 3]] });
  });
});

/* ------------------------------------------------------------------ T6 */

test('T6 createAssetSink: has is true when the local frame store covers the full range; put returns { complete: true, result }; with a missing frame / failed push it returns { complete: false }', async () => {
  await withRoots(3, async ([rootA, rootA2, rootS], make) => {
    const A = make(rootA), A2 = make(rootA2), S = make(rootS, { interactive: true });
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const task = snapshotTask({ contentKey: sha256('card-T6'), from: 0, to: 59 });
    await seedSnapshots(A, task, range(0, 59));
    // A2 is missing frame 30
    await seedSnapshots(A2, task, [...range(0, 29), ...range(31, 59)]);
    const ref = (t) => ({ resultKey: t.resultKey, kind: t.kind, tier: t.tier, range: t.range, input: t.input, requires: t.requires });
    const meta = (t) => ({ taskId: t.id, nodeId: 'node-1', token: 'lease-token' });

    const sink = T().createAssetSink({ pipeline: A, client });
    assert.equal(await sink.has(ref(task)), true, 'this machine covers the whole range (over-limit frames also count as present)');
    const r = await sink.put({ ...ref(task), artifacts: null, meta: meta(task) });
    assert.equal(r.complete, true);
    const expected = unpack(await T().collectSnapshotResult(A, task)).result;
    assert.deepEqual(wire(r.result), expected, 'result is the manifest from section 3');
    assert.ok(JSON.stringify(r.result).length <= RESULT_LIMIT);
    for (const [n, h] of expected.frames) assert.ok(await srv.stores.snap.stat(h), `put pushed frame ${n}`);

    const sink2 = T().createAssetSink({ pipeline: A2, client });
    assert.equal(await sink2.has(ref(task)), false, 'one frame missing: has is false');
    const sub = snapshotTask({ contentKey: sha256('card-T6'), from: 0, to: 29 });
    assert.equal(await sink2.has(ref(sub)), true, 'asking only 0-29: covered');
    const r2 = await sink2.put({ ...ref(task), artifacts: null, meta: meta(task) });
    assert.equal(r2.complete, false, 'one frame missing: put returns complete: false');

    // Chunk push failed: complete: false
    const broken = { ...client, put: async () => { throw Object.assign(new Error('push failed'), { status: 503 }); }, has: client.has, get: client.get };
    const other = snapshotTask({ contentKey: sha256('card-T6'), from: 0, to: 59, fp: OWN_ENV.fingerprint });
    await seedSnapshots(A, other, range(0, 59), { tag: 'A-own' });
    const r3 = await T().createAssetSink({ pipeline: A, client: broken }).put({ ...ref(other), artifacts: null, meta: meta(other) });
    assert.equal(r3.complete, false, 'push failed: put returns complete: false');
    // HR26 (`docs/plan/hosted-render-contract.md` Section 6): asset service returns 507 service-quota
    // (render service artifacts reached capacity limit): does not return incomplete (which is
    // retryable), throws a non-retryable error
    const overQuota = { ...client, put: async () => { throw Object.assign(new Error('asset 507'), { status: 507, body: { error: 'service-quota' } }); }, has: client.has, get: client.get };
    await assert.rejects(
      () => T().createAssetSink({ pipeline: A, client: overQuota }).put({ ...ref(other), artifacts: null, meta: meta(other) }),
      (e) => e.code === 'service-quota' && e.retryable === false && e.status === 507,
      'capacity limit reached: throws service-quota, not retryable',
    );

    // Stream: has / put
    const contentKey = sha256('stream-T6');
    const streamKey = resultKeyOf(contentKey, TASK_FP);
    await writeStreamFixture(rootS, { streamKey, segments: [0, 1, 2] });
    const st = streamTask({ streamKey, contentKey, from: 0, to: 2 });
    const ssink = T().createAssetSink({ pipeline: S, client });
    assert.equal(await ssink.has(ref(st)), true, 'stream: segments 0-2 are all present');
    assert.equal(await ssink.has(ref(streamTask({ streamKey, contentKey, from: 0, to: 4 }))), false, 'stream: missing 3, 4');
    const r4 = await ssink.put({ ...ref(st), artifacts: null, meta: meta(st) });
    assert.equal(r4.complete, true);
    assert.equal(r4.result.kind, 'stream');
    assert.deepEqual(Object.keys(r4.result.segments).map(Number).sort(), [0, 1, 2]);
    for (const n of [0, 1, 2]) assert.ok(await srv.stores.px.stat(r4.result.segments[n].hash));
    const r5 = await ssink.put({ ...ref(streamTask({ streamKey, contentKey, from: 0, to: 4 })), artifacts: null, meta: meta(st) });
    assert.equal(r5.complete, false, 'stream missing segments: complete: false');
  });
});

/* ------------------------------------------------------------------ T7 */

test('T7 result exceeds 256 KiB (artificially enlarged): error, no truncation', async () => {
  await withRoots(1, async ([rootA], make) => {
    const A = make(rootA);
    const srv = await harness.serve();
    const client = newClient(srv.base);
    // Each frame entry is about 80 bytes: a manifest for 3600 frames is about 290 KB. Frame contents are
    // identical (only one chunk during push, saving time)
    const N = 3600;
    const task = snapshotTask({ contentKey: sha256('card-T7'), from: 0, to: N - 1 });
    await A.snapshots().commitSnapshots({ tier: 'shared', key: task.resultKey, clipId: 'clip-x', capabilities: SHARED_CAPS,
      items: range(0, N - 1).map((n) => ({ localFrame: n, html: '<div>same</div>' })) });

    let collected = null, collectError = null;
    try { collected = unpack(await T().collectSnapshotResult(A, task)); } catch (err) { collectError = err; }
    if (collected) {
      assert.equal(collected.result.frames.length, N, 'when collect does not error, the manifest must not be truncated');
      await assert.rejects(T().pushResult(client, collected.raw, collected.readBlob), 'collect does not error, pushResult must still error');
    } else {
      assert.ok(collectError instanceof Error, 'collectSnapshotResult errors');
      assert.doesNotMatch(String(collectError.message), /^cannot load/, collectError.message);
    }
    // The sink must not treat it as fully received
    const r = await T().createAssetSink({ pipeline: A, client }).put({ resultKey: task.resultKey, kind: 'snapshot', tier: 'shared', range: task.range, input: task.input, requires: task.requires, artifacts: null, meta: { taskId: task.id, nodeId: 'n', token: 't' } })
      .then((v) => v, (e) => ({ error: e }));
    assert.ok(r.error instanceof Error || r.complete === false, `sink.put must error or return complete: false, never complete: true: ${JSON.stringify(r).slice(0, 200)}`);
    if (!r.error) assert.equal(r.result, undefined);
  });
});

/* ------------------------------------------------------------------ T8 */

test('T8 applyResult hits a chunk missing from the asset service (404): fails as a whole and throws; frames already written are all in the index, no partial files left', async () => {
  await withRoots(2, async ([rootA, rootB], make) => {
    const A = make(rootA), B = make(rootB);
    const srv = await harness.serve();
    const client = newClient(srv.base);
    const task = snapshotTask({ contentKey: sha256('card-T8'), from: 0, to: 59 });
    await seedSnapshots(A, task, range(0, 59));
    const { result, readBlob } = unpack(await T().collectSnapshotResult(A, task));
    // Omit frame 40 while pushing
    const MISSING = 40;
    await T().pushResult(client, { ...result, frames: result.frames.filter(([n]) => n !== MISSING) }, readBlob);
    const lost = result.frames.find(([n]) => n === MISSING)[1];
    assert.equal(await client.has('snap', lost), false, 'fixture: frame 40\'s chunk is not on the asset service');

    await assert.rejects(T().applyResult(B, client, wire(result)), 'missing chunk: fails as a whole');

    const dirB = snapshotDir(rootB, { tier: 'shared', key: result.dirKey });
    const files = await filesOf(dirB);
    const names = Object.keys(files);
    assert.ok(names.every((n) => n === 'index.json' || /^\d+\.html$/.test(n)), `no partial files left: ${names.filter((n) => n !== 'index.json' && !/^\d+\.html$/.test(n))}`);
    assert.equal(files[`${MISSING}.html`], undefined, 'the missing frame has no file');
    const idx = await B.snapshots().snapshotIndex({ tier: 'shared', key: result.dirKey });
    const inIndex = new Set([...idx.frames, ...idx.oversize].flatMap(([a, b]) => range(a, b)));
    const onDisk = new Set(names.filter((n) => n.endsWith('.html')).map((n) => Number(n.slice(0, -5))));
    assert.deepEqual([...onDisk].sort((a, b) => a - b), [...inIndex].sort((a, b) => a - b), 'frames on disk match index.json (written via commitSnapshots)');
    assert.equal(inIndex.has(MISSING), false);
    const fa = await filesOf(snapshotDir(rootA, { tier: 'shared', key: result.dirKey }));
    for (const n of onDisk) assert.ok(files[`${n}.html`].equals(fa[`${n}.html`]), `already-written frame ${n} is complete`);
  });
});
