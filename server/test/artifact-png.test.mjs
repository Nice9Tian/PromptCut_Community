/**
 * X7(`docs/plan/m6c-contract.md`): cards produced by remote nodes, local PNG cache.
 *
 *   Push side: snapshot manifest (C6.2 `SnapshotResult`) additionally carries PNG cache frames
 *              for this segment `pngs: [{ key, fps, frames: [[frame, hash, bytes]] }]`,
 *              chunks pushed into `px` of asset service;
 *   Pull side: when `applyResult` lands snapshot, manifest carrying `pngs` is retrieved together,
 *              written as-is into local PNG cache (`CardFrameCache`'s `controls/<key>/mov/frames/`);
 *              those without `pngs` remain as-is (legacy channel draws placeholder as usual),
 *              without prerender retries locally.
 *
 * Two temporary frame stores A (remote, produce), B (local, retrieve), each with a real
 * `FramePipeline` (`bakery/index.mjs` replaced with a mock, does not start Chrome); one real HTTP
 * asset service (memory, port 0). A and B entries use real `CardFrameCache`, PNGs generated on the
 * fly with pngjs.
 *
 * Run: node --experimental-test-module-mocks --test server/test/artifact-png.test.mjs
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
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
const { CardFrameCache, cardControlPngPath } = await import('../card-cache.mjs');
const { describeEnvironment, resultKeyOf } = await import('../render-node/fingerprint.mjs');
const { readRenderRecord } = await import('../png-record.mjs');
const T = await import('../artifact-transfer.mjs');
const { createAssetClient } = await import('../asset-store/client.mjs');

const harness = createAssetHarness();
after(() => harness.cleanup());

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const wire = (v) => JSON.parse(JSON.stringify(v));

const ENV = describeEnvironment({
  platform: 'win32', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/152.0.0.0',
});
const FP = ENV.fingerprint;
const CAPTURE = 'capture-v1';
const SHARED_CAPS = { compositing: 'independent', frameMode: 'stateful' };

/**
 * 4×4 PNG: frame n has one color; when `clear` is true, all zeros (fully transparent, like empty
 * frames captured by Chrome)
 */
function pngOf(n, clear = false) {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < 16 && !clear; i++) {
    png.data[i * 4] = (n * 37) & 255; png.data[i * 4 + 1] = (n * 11) & 255; png.data[i * 4 + 2] = 200; png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** Control of a shared tier card (fields that are useful among those produced by `plan` in `card-cache.mjs`) */
function controlFor(tag, { clipId = `clip-${tag}` } = {}) {
  const contentKey = sha256(`content-${tag}`);
  return {
    key: resultKeyOf(sha256(`png-${tag}-${clipId}`), FP), snapshotKey: resultKeyOf(contentKey, FP), contentKey, envFingerprint: FP,
    tier: 'shared', capabilities: SHARED_CAPS, compositing: 'independent', cacheable: true, needPrerendering: true,
    clipId, start: 0, end: 2, count: 60, sampling: { firstFrame: 0, phase: { numerator: 0, denominator: 1 } },
  };
}
const taskFor = (control, from = 0, to = 59) => ({
  id: `snapshot:${control.snapshotKey}:${from}-${to}`, kind: 'snapshot', tier: 'shared', resultKey: control.snapshotKey,
  range: { unit: 'localFrame', from, to }, source: { projectId: 'p1', projectRev: 1 },
  input: { clipId: control.clipId, cardId: null, entryKey: null, contentKey: control.contentKey },
  requires: { envFingerprint: FP }, state: 'claimed', version: 1, attempts: 1,
});

async function withLibs(fn) {
  const roots = [];
  const pipelines = [];
  const make = async ({ capture = CAPTURE } = {}) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-x7-lib-'));
    roots.push(root);
    const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: ENV, dataRoot: root, interactive: false, captureCode: () => capture });
    pipelines.push(p);
    return p;
  };
  try { return await fn(make); } finally {
    await Promise.allSettled(pipelines.map((p) => p.close()));
    await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
  }
}

/**
 * Mount an entry on the pipeline: card plan has these controls, PNG cache is a real
 * `CardFrameCache` (capture takes from the pipeline)
 */
function attachEntry(pipeline, controls, key = `entry-${Math.random().toString(36).slice(2, 8)}`) {
  const project = { fps: 30, width: 64, height: 64 };
  const cardCache = new CardFrameCache({ root: pipeline.root, project, capture: () => pipeline.captureCode(), scale: () => 1, envFingerprint: FP });
  const entry = { key, project, cardPlan: controls, cardCache };
  pipeline.entries.set(key, entry);
  return entry;
}

/**
 * A produces a segment: 60-frame snapshot + PNG cache. Frame 0 is fully transparent and
 * reconfirmed, frame 1 is fully transparent unconfirmed, frame 5 has no PNG
 */
async function produce(A, control) {
  const entry = attachEntry(A, [control]);
  await A.snapshots().commitSnapshots({ tier: 'shared', key: control.snapshotKey, clipId: control.clipId, capabilities: SHARED_CAPS,
    items: range(0, 59).map((n) => ({ localFrame: n, html: `<div data-pc-scene="">card ${control.clipId} frame ${n}</div>` })) });
  for (const n of range(0, 59)) {
    if (n === 5) continue;
    const clear = n === 0 || n === 1;
    await entry.cardCache.put(control.key, n, pngOf(n, clear));
    if (n === 0) await entry.cardCache.put(control.key, n, pngOf(n, clear));   // Same producer renders again to confirm it is indeed empty
  }
  return entry;
}

function countingClient(client) {
  const gets = [];
  return { gets, put: (...a) => client.put(...a), has: (...a) => client.has(...a), get: (ns, hash) => { gets.push({ ns, hash }); return client.get(ns, hash); } };
}

async function pushed(A, control) {
  const srv = await harness.serve();
  const client = createAssetClient({ base: srv.base });
  const { result, readBlob } = await T.collectSnapshotResult(A, taskFor(control));
  await T.pushResult(client, result, readBlob);
  return { srv, client, result: wire(result) };
}

/* ------------------------------------------------------------------ Test cases */

test('X7-1 Push side: the snapshot manifest carries this segment\'s cached PNG frames (valid ones only), and the chunks are pushed into px', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const control = controlFor('x71');
    await produce(A, control);
    const { client, result } = await pushed(A, control);
    assert.equal(result.frames.length, 60, 'The snapshot still has 60 frames');
    assert.ok(Array.isArray(result.pngs) && result.pngs.length === 1, 'Carries one pngs entry');
    const [item] = result.pngs;
    assert.equal(item.key, control.key);
    assert.equal(item.fps, 30);
    const listed = item.frames.map(([f]) => f);
    assert.deepEqual(listed, range(0, 59).filter((n) => n !== 1 && n !== 5), 'Unconfirmed fully transparent frames (1) and frames without a PNG (5) are not listed');
    for (const [f, hash, bytes] of item.frames) {
      const buf = await fs.readFile(cardControlPngPath(A.root, control.key, f));
      assert.equal(hash, sha256(buf), `The hash of frame ${f} is that of the bytes on disk`);
      assert.equal(bytes, buf.length);
      assert.equal(await client.has('px', hash), true, `Frame ${f} is in px`);
      assert.equal(await client.has('snap', hash), false, 'PNGs do not go into snap');
    }
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= T.RESULT_MAX_BYTES);
  });
});

test('X7-2 Fetch side: applyResult writes the PNGs as is into the local PNG cache, and legacy\'s renderState gives real PNGs instead of marking the frames missing', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const B = await make();
    const control = controlFor('x72');
    await produce(A, control);
    const { client, result } = await pushed(A, control);
    const bEntry = attachEntry(B, [structuredClone(control)]);
    const before = await bEntry.cardCache.renderState(bEntry.cardPlan, range(0, 59));
    assert.equal(Object.keys(before.frames).length, 0, 'Before the fetch B has no PNGs');
    assert.equal(Object.keys(before.missing).length, 60, 'Before the fetch all 60 frames are missing (legacy draws a placeholder)');

    const counting = countingClient(client);
    const applied = await T.applyResult(B, counting, result);
    assert.equal(applied.written, 60, 'The snapshot still has 60 frames');
    assert.equal(applied.png?.written, 58, '58 PNG frames were written');
    assert.equal(counting.gets.filter((g) => g.ns === 'px').length, 58, '58 chunks were downloaded from px');
    for (const [f] of result.pngs[0].frames) {
      const a = await fs.readFile(cardControlPngPath(A.root, control.key, f));
      const b = await fs.readFile(cardControlPngPath(B.root, control.key, f));
      assert.ok(a.equals(b), `Frame ${f} is byte-for-byte identical to A's`);
    }
    assert.equal(readRenderRecord(await fs.readFile(cardControlPngPath(B.root, control.key, 0))).renders, 2, 'A fully transparent frame that was confirmed a second time lands with its render pass count');
    const after_ = await bEntry.cardCache.renderState(bEntry.cardPlan, range(0, 59));
    assert.deepEqual(Object.keys(after_.frames[control.clipId]).map(Number).sort((a, b) => a - b), range(0, 59).filter((n) => n !== 1 && n !== 5));
    assert.deepEqual(Object.keys(after_.missing).map(Number).sort((a, b) => a - b), [1, 5], 'Only the two frames the other side does not have either are still missing');
  });
});

test('X7-3 No pngs in the manifest: stays as it is (missing, placeholder), downloads no pixel chunks, and does not retry prerendering locally', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const B = await make();
    const control = controlFor('x73');
    await produce(A, control);
    const { client, result } = await pushed(A, control);
    delete result.pngs;
    const bEntry = attachEntry(B, [structuredClone(control)]);
    const counting = countingClient(client);
    const applied = await T.applyResult(B, counting, result);
    assert.equal(applied.written, 60);
    assert.equal(applied.png, undefined, 'No pngs means no png count');
    assert.equal(counting.gets.filter((g) => g.ns === 'px').length, 0);
    await assert.rejects(fs.access(path.join(B.root, 'controls', control.key)), 'This machine has no PNG directory for this key');
    const state = await bEntry.cardCache.renderState(bEntry.cardPlan, range(0, 59));
    assert.equal(Object.keys(state.missing).length, 60, 'Still missing');
  });
});

test('X7-4 Valid frames that already exist locally are skipped and not downloaded; those whose capture does not match (different frame-capture code) are not accepted', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const B = await make();
    const C = await make({ capture: 'capture-v2' });
    const control = controlFor('x74');
    await produce(A, control);
    const { client, result } = await pushed(A, control);
    const bEntry = attachEntry(B, [structuredClone(control)]);
    for (const n of range(10, 19)) await bEntry.cardCache.put(control.key, n, pngOf(n));
    const counting = countingClient(client);
    const applied = await T.applyResult(B, counting, result);
    assert.equal(applied.png.skipped, 10);
    assert.equal(applied.png.written, 48);
    assert.equal(counting.gets.filter((g) => g.ns === 'px').length, 48, 'The 10 existing frames are not downloaded');

    attachEntry(C, [structuredClone(control)]);
    const other = await T.applyResult(C, client, result);
    assert.equal(other.png.written, 0);
    assert.equal(other.png.mismatched, 58, 'The capture in the output record differs from this machine\'s: not a single frame is accepted');
  });
});

test('X7-5 No entry on this machine uses this key: it is still written into controls/<key>/, and a CardFrameCache opened later can find it', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const B = await make();
    const control = controlFor('x75');
    await produce(A, control);
    const { client, result } = await pushed(A, control);
    const applied = await T.applyResult(B, client, result);
    assert.equal(applied.png.written, 58);
    const later = attachEntry(B, [structuredClone(control)]);
    const state = await later.cardCache.renderState(later.cardPlan, range(0, 59));
    assert.equal(Object.keys(state.frames[control.clipId] ?? {}).length, 58);
  });
});

test('X7-6 The PNG chunks are gone from the asset service: the snapshot still lands as usual without throwing, and the PNG is recorded as failed', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const B = await make();
    const control = controlFor('x76');
    await produce(A, control);
    const { client, result } = await pushed(A, control);
    const gone = new Set(result.pngs[0].frames.slice(0, 3).map(([, hash]) => hash));
    const lossy = { ...client, get: (ns, hash) => (ns === 'px' && gone.has(hash) ? Promise.resolve(null) : client.get(ns, hash)) };
    attachEntry(B, [structuredClone(control)]);
    const applied = await T.applyResult(B, lossy, result);
    assert.equal(applied.written, 60);
    assert.equal(applied.png.failed, 3);
    assert.equal(applied.png.written, 55);
  });
});

test('X7-7 When including PNGs would push the manifest past 256 KiB, the PNGs are left out and the snapshot manifest is still delivered as usual', async () => {
  await withLibs(async (make) => {
    const A = await make();
    const base = controlFor('x77');
    // Same card placed 70 times: share one snapshot, each has a PNG cache (different keys).
    // PNG entries for 70 × 60 frames exceed 256 KiB
    const controls = range(0, 69).map((i) => ({ ...base, clipId: `clip-x77-${i}`, key: resultKeyOf(sha256(`png-x77-${i}`), FP) }));
    const entry = attachEntry(A, controls);
    await A.snapshots().commitSnapshots({ tier: 'shared', key: base.snapshotKey, clipId: base.clipId, capabilities: SHARED_CAPS,
      items: range(0, 59).map((n) => ({ localFrame: n, html: `<div>${n}</div>` })) });
    // PNG cache only checks by directory: 70 key frames directories each hold the same 60 files
    // (written directly to disk, bypassing 70 × 60 put calls)
    const oneStore = await entry.cardCache.store(controls[0].key);
    for (const n of range(0, 59)) await entry.cardCache.put(controls[0].key, n, pngOf(n));
    const files = await fs.readdir(oneStore.frameDir);
    for (const c of controls.slice(1)) {
      const dir = path.join(A.root, 'controls', c.key, 'mov', 'frames');
      await fs.mkdir(dir, { recursive: true });
      for (const name of files) {
        const src = await fs.readFile(path.join(oneStore.frameDir, name));
        // The card key in the production record must be its own, otherwise it is not considered valid
        const { withRenderRecord } = await import('../png-record.mjs');
        const record = readRenderRecord(src);
        await fs.writeFile(path.join(dir, name), withRenderRecord(src, { ...record, signature: { ...record.signature, cards: c.key } }));
      }
    }
    const { result } = await T.collectSnapshotResult(A, taskFor(base));
    assert.equal(result.frames.length, 60);
    assert.equal(result.pngs, undefined, 'Over the limit: no pngs');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= T.RESULT_MAX_BYTES);
  });
});
