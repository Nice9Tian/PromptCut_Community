/**
 * C10a prerender small size (`docs/plan/c10a-contract.md` Section 9, Section 12 "Prerender small
 * size: sizing rules, separate readiness across two tiers, completion conditions").
 * Run: node --test server/test/c10a-small-prerender.test.mjs
 *
 *   Size: scale down proportionally within 800×600, do not upscale, preserve project aspect ratio;
 *   16:9 → 800×450, 9:16 → 337×600.
 *   Store: small bitmaps (WebP) are pushed to asset service `px/<hash>` by content hash; for each
 *   segment, the manifest includes the small-size hash table in addition to the original size.
 *   Readiness: tracked separately across two tiers; small-size readiness cannot count as
 *   original-size readiness. Completion: both tiers pushed successfully.
 *
 * For assumed interfaces, see K4 in `c10a-kit.mjs` (location and name of sizing function, `small`
 * field in manifest, small-size `kind` in ready index).
 * Probe checks only the sizing function: if not found, skip the entire suite; if found, the
 * remaining tests actually run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { skipIf, findSmallSize, sizeOf, repoUrl, ORIGINALS_FILE } from './c10a-kit.mjs';

const found = await findSmallSize();
if (found?.error) {
  test('C10A-PS-00 the sizing function can be loaded in node', () => { assert.fail(`${found.file} exports the sizing function but it cannot be loaded: ${found.error?.stack ?? found.error}`); });
}
const skip = skipIf(!found?.fn, 'sizing function for the prerender small size (K4)');
const it = (name, fn) => test(name, { skip }, fn);

const size = (w, h) => sizeOf(found.fn(w, h));
const sha = (b) => createHash('sha256').update(b).digest('hex');

it('C10A-PS-01 sizing rule: the examples in the contract and common aspect ratios', () => {
  const cases = [
    [[1920, 1080], [800, 450]],
    [[1080, 1920], [337, 600]], // Original contract text: 9:16 is 337×600
    [[3840, 2160], [800, 450]],
    [[1280, 720], [800, 450]],
    [[2048, 1536], [800, 600]],
    [[800, 600], [800, 600]],
    [[1000, 1000], [600, 600]],
    [[4000, 1000], [800, 200]],
    [[1000, 4000], [150, 600]],
  ];
  for (const [[w, h], want] of cases) assert.deepEqual(size(w, h), { width: want[0], height: want[1] }, `${w}×${h}`);
});

it('C10A-PS-02 sizing rule: no upscaling (anything already within 800×600 stays as is)', () => {
  for (const [w, h] of [[640, 360], [450, 600], [800, 450], [320, 240], [1, 1], [600, 600], [337, 600]]) {
    assert.deepEqual(size(w, h), { width: w, height: h }, `${w}×${h}`);
  }
});

it('C10A-PS-03 properties of the sizing rule: integers, inside the box, no upscaling, aspect ratio error under 1 pixel, and a downscaled result touches the box on at least one side', () => {
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  for (let i = 0; i < 500; i++) {
    const w = rnd(16, 8192);
    const h = rnd(16, 8192);
    const s = size(w, h);
    assert.ok(Number.isInteger(s.width) && Number.isInteger(s.height) && s.width >= 1 && s.height >= 1, `${w}×${h} → ${JSON.stringify(s)}`);
    assert.ok(s.width <= 800 && s.height <= 600, `${w}×${h} → ${s.width}×${s.height} exceeds 800×600`);
    assert.ok(s.width <= w && s.height <= h, `${w}×${h} → ${s.width}×${s.height} was upscaled`);
    const k = Math.min(800 / w, 600 / h, 1);
    assert.ok(Math.abs(s.width - w * k) < 1 && Math.abs(s.height - h * k) < 1, `${w}×${h} → ${s.width}×${s.height}, expected about ${(w * k).toFixed(2)}×${(h * k).toFixed(2)}`);
    if (k < 1) assert.ok(s.width === 800 || s.height === 600 || Math.abs(s.width - 800) < 1 || Math.abs(s.height - 600) < 1, `${w}×${h} → ${s.width}×${s.height}: downscaled but no side touches the box`);
  }
});

// ------------------------------------------------------------------ Manifest, push, completion conditions

/**
 * One segment of snapshot manifest: 3 original-size HTML frames + 3 small WebP bitmaps
 * (K4: `small` and `frames` have the same shape)
 */
function snapshotResult() {
  const blobs = new Map();
  const add = (bytes) => { const h = sha(bytes); blobs.set(h, bytes); return [h, bytes.length]; };
  const frames = [];
  const small = [];
  for (let f = 0; f < 3; f++) {
    frames.push([f, ...add(Buffer.from(`<div data-frame="${f}">${randomBytes(8).toString('hex')}</div>`, 'utf8'))]);
    small.push([f, ...add(Buffer.concat([Buffer.from('RIFF'), randomBytes(4), Buffer.from('WEBPVP8L'), randomBytes(24)]))]);
  }
  const result = {
    v: 1, kind: 'snapshot', tier: 'shared', resultKey: 'k'.repeat(16), dirKey: 'k'.repeat(16), entryKey: null,
    range: { from: 0, to: 2 }, canvasHeavy: false, frames, small,
  };
  return { result, blobs, readBlob: async (h) => blobs.get(h) ?? null };
}

function fakeClient({ failPx = false, present = null } = {}) {
  const puts = [];
  return {
    puts,
    async put(ns, bytes, opts = {}) {
      const hash = sha(bytes);
      puts.push({ ns, hash, ext: opts.ext ?? null });
      if (failPx && ns === 'px') throw Object.assign(new Error('px push failed (test injection)'), { status: 503 });
      return { hash, uploaded: true };
    },
    async has(ns, hash) { return present ? present(ns, hash) : true; },
    async get() { return null; },
  };
}

it('C10A-PS-04 a manifest carrying a small-size hash table: both tiers are pushed, the original size goes to snap, and the small bitmaps go to px as WebP', async () => {
  const { pushResult } = await import(repoUrl('server/artifact-transfer.mjs'));
  const { result, readBlob } = snapshotResult();
  const client = fakeClient();
  await pushResult(client, result, readBlob);
  const snap = client.puts.filter((p) => p.ns === 'snap').map((p) => p.hash).sort();
  const px = client.puts.filter((p) => p.ns === 'px');
  assert.deepEqual(snap, result.frames.map(([, h]) => h).sort(), 'the three original-size frames go to snap');
  assert.deepEqual(px.map((p) => p.hash).sort(), result.small.map(([, h]) => h).sort(), 'the three small bitmaps go to px');
  assert.ok(px.every((p) => p.ext === 'webp'), `the extension of the small bitmaps is webp: ${JSON.stringify(px)}`);
});

it('C10A-PS-05 completion condition: if any one small-size chunk fails to push, this segment does not count as complete (pushResult throws)', async () => {
  const { pushResult } = await import(repoUrl('server/artifact-transfer.mjs'));
  const { result, readBlob } = snapshotResult();
  await assert.rejects(pushResult(fakeClient({ failPx: true }), result, readBlob), 'it is not complete even if all the original-size ones were pushed');
});

it('C10A-PS-06 dedup checks both tiers: the manifest lists small sizes but the asset service is missing a chunk, so blocksPresent returns false', async () => {
  const { blocksPresent } = await import(repoUrl('server/artifact-transfer.mjs'));
  const { result } = snapshotResult();
  const missing = result.small[1][1];
  assert.equal(await blocksPresent(fakeClient({ present: () => true }), result), true, 'both tiers present');
  assert.equal(await blocksPresent(fakeClient({ present: (ns, h) => h !== missing }), result), false, 'one small bitmap is missing');
});

// ------------------------------------------------------------------ Track readiness separately

/*
 * Integration reconciliation (K4) rewrote this: the implementation tracks the two tiers
 * separately in the **manifest** (`frames` lists only the original size, `small` is listed
 * separately); the prerender process's ready index (`server/ready-index.mjs`, SSE for desktop
 * pages) does not receive small size at all; online pages compute small-size readiness from
 * the `small` table, and pre-export verification (`src/export/originals.ts`) recognizes only
 * `frames`. Therefore, "small-size readiness cannot count as original-size readiness" is checked
 * in these two places, rather than adding a tier to the ready index.
 */
it('C10A-PS-07 the two tiers become ready separately: the manifest has small sizes covering the whole segment but only half of the original sizes, the pre-export check still counts the original size as missing, and the missing frames cannot get an original size', async () => {
  const ready = await import(repoUrl('server/ready-index.mjs'));
  assert.equal(ready.READY_KINDS.some((k) => /small/i.test(k)), false, `the ready index does not include small sizes: ${JSON.stringify(ready.READY_KINDS)}`);
  await import(repoUrl('src/testing/registerTs.mjs'));
  const { loadOriginalsIndex } = await import(repoUrl(ORIGINALS_FILE));
  const hex = (c) => c.repeat(64);
  const frames = Array.from({ length: 30 }, (_, f) => [f, hex('a'), 10]); // Original size only has 0~29
  const small = Array.from({ length: 60 }, (_, f) => [f, hex('b'), 5]); // Small size fully covers 0~59
  const content = {
    'layers:p1': { v: 1, kind: 'layer-map', projectId: 'p1', fps: 30, span: 60, layers: [{ clipId: 'c1', kind: 'html', key: 'K1', resultKey: 'R1', firstFrame: 100, count: 60 }] },
    'R1:0-59': { v: 1, kind: 'snapshot', resultKey: 'R1', range: { from: 0, to: 59 }, frames, small },
  };
  const deps = {
    request: async (m) => (m.type === 'content.get' && m.kind === 'snapshot-manifest' && content[m.key]
      ? { type: 'content.item', kind: m.kind, key: m.key, body: content[m.key] } : { type: 'content.item', kind: m.kind, key: m.key, missing: true }),
    assetBase: () => null,
    authHeaders: async () => ({}),
  };
  const idx = await loadOriginalsIndex('p1', deps);
  assert.deepEqual(idx.missing, ['c1'], 'small sizes covering everything still do not make the original size ready');
  assert.equal(idx.hashAt('c1', 100 + 10), hex('a'), 'a frame that has an original size uses the original size');
  assert.equal(idx.hashAt('c1', 100 + 40), null, 'a frame with only a small size: the original size counts as missing, and the small size does not stand in for it');
  content['R1:0-59'] = { ...content['R1:0-59'], frames: Array.from({ length: 60 }, (_, f) => [f, hex('a'), 10]) };
  assert.deepEqual((await loadOriginalsIndex('p1', deps)).missing, [], 'ready only after the original sizes are filled in');
});
