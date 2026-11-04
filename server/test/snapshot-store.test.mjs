/**
 * Unit tests for A3a snapshot store. Run: node --test server/test/snapshot-store.test.mjs
 *
 * Directory layout is the only external contract for this layer (the cloud side will retrieve
 * files using the same layout in the future), so paths are nailed down verbatim instead of
 * relying on "as long as it can be read back": shared tier has a one-level key directory,
 * local tier has two levels (entry.key / shared key), and files are raw UTF-8 HTML. index.json
 * is queried by playback scheduling on every tick for "which local frames are already available";
 * an off-by-one interval merge will try to paste a non-existent snapshot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnapshotStore, snapshotTier, snapshotDir, mergeRanges, rangeCount, rangeHas, SHARED_DIR, LOCAL_DIR,
  snapshotLimit, snapshotBytes, overSnapshotLimit, DOM_SNAPSHOT_LIMIT, CANVAS_SNAPSHOT_LIMIT } from '../snapshot-store.mjs';

const withRoot = async body => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-snapshot-store-'));
  try { return await body(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
};

test('directory shape: shared is one level, local is two (entry key / shared key)', () => {
  assert.equal(snapshotDir('R', { tier: 'shared', key: 'K' }), path.join('R', SHARED_DIR, 'K'));
  assert.equal(snapshotDir('R', { tier: 'local', entryKey: 'E', key: 'K' }), path.join('R', LOCAL_DIR, 'E', 'K'));
  // Two-level directory, not joined into a single name: when switching projects, the entire
  // <entry.key>/ tree can be dropped together, while the shared key layer shares the same name
  // across both tiers; promoting an entry to shared tier in the future is just moving directories.
  assert.notEqual(snapshotDir('R', { tier: 'local', entryKey: 'E', key: 'K' }), path.join('R', LOCAL_DIR, 'E-K'));
  assert.throws(() => snapshotDir('R', { tier: 'local', key: 'K' }), /entry key/);
  assert.throws(() => snapshotDir('R', { tier: 'shared' }), /key is required/);
  assert.throws(() => snapshotDir('R', { tier: 'none', key: 'K' }), /Unknown snapshot tier/);
});

test('tier follows the contract: all cards return none (2026-10-13 contract 1.1: the HTML snapshot of every card is void)', () => {
  const caps = (compositing, frameMode = 'stateful') => ({ compositing, frameMode });
  assert.equal(snapshotTier(caps('independent')), 'none');
  assert.equal(snapshotTier(caps('sourceDependent')), 'none');
  assert.equal(snapshotTier(caps('belowDependent')), 'none');
  assert.equal(snapshotTier(caps('context')), 'none');
  assert.equal(snapshotTier(caps('unknown')), 'none');
  assert.equal(snapshotTier(caps(undefined)), 'none');
  assert.equal(snapshotTier(caps('independent', 'direct')), 'none');
  assert.equal(snapshotTier(caps('unknown', 'direct')), 'none');
  assert.equal(snapshotTier({ compositing: 'independent', need_prerendering: true }), 'none');
  assert.equal(snapshotTier({ compositing: 'belowDependent', needPrerendering: true }), 'none');
  assert.equal(snapshotTier(undefined), 'none');
});

test('A3c size cap: DOM 300 KB, canvas 1 MB; over-limit frames are diagnosed, not indexed', async () => withRoot(async root => {
  assert.equal(snapshotLimit({ compositing: 'independent' }), DOM_SNAPSHOT_LIMIT);
  // Most bytes of a canvas card are toDataURL bitmaps; differential style inlining is ineffective on it: counted under the bitmap tier.
  assert.equal(snapshotLimit({ canvasHeavy: true }), CANVAS_SNAPSHOT_LIMIT);
  assert.equal(snapshotBytes('数'), 3, 'UTF-8 basis, exactly the same as the bytes written to disk');
  assert.equal(overSnapshotLimit('x'.repeat(10), {}), null);
  assert.deepEqual(overSnapshotLimit('x'.repeat(DOM_SNAPSHOT_LIMIT + 1), {}), { bytes: DOM_SNAPSHOT_LIMIT + 1, limit: DOM_SNAPSHOT_LIMIT });
  // The same over-limit DOM snapshot does not exceed the limit on a canvas card
  assert.equal(overSnapshotLimit('x'.repeat(DOM_SNAPSHOT_LIMIT + 1), { canvasHeavy: true }), null);

  const store = new SnapshotStore(root);
  const huge = 'x'.repeat(DOM_SNAPSHOT_LIMIT + 1);
  // Written to disk as usual (no need to re-render next time), but does not enter the ready index
  await store.writeSnapshot({ tier: 'shared', key: 'BIG', localFrame: 0, html: huge });
  assert.equal(store.noteSnapshotSize({ clipId: 'clip-big', key: 'BIG', localFrame: 0, html: huge, capabilities: {} }), false);
  assert.equal((await store.readSnapshot({ tier: 'shared', key: 'BIG', localFrame: 0 })).length, huge.length);
  assert.equal(store.oversize.length, 1);
  assert.equal(store.oversize[0].clipId, 'clip-big');
  assert.equal(store.oversize[0].bytes, DOM_SNAPSHOT_LIMIT + 1);
  assert.equal(store.noteSnapshotSize({ clipId: 'clip-ok', key: 'OK', localFrame: 0, html: 'small', capabilities: {} }), true);
  assert.equal(store.oversize.length, 1, 'Frames within the limit record no diagnostics');
}));

test('mergeRanges sorts, merges overlaps and closes one-frame gaps', () => {
  assert.deepEqual(mergeRanges([[3, 4], [0, 1], [2, 2]]), [[0, 4]], 'adjacent ranges are one range');
  assert.deepEqual(mergeRanges([[0, 5], [2, 3]]), [[0, 5]]);
  assert.deepEqual(mergeRanges([[0, 1], [3, 4]]), [[0, 1], [3, 4]], 'a real hole stays a hole');
  // Raw frame numbers and intervals mixed together.
  assert.deepEqual(mergeRanges([7, [0, 2], 3, 9, 8]), [[0, 3], [7, 9]]);
  // Bad values are discarded directly to prevent them from corrupting the entire interval.
  assert.deepEqual(mergeRanges([[5, 1], ['a', 'b'], [1.5, 2], null, [0, 0]]), [[0, 0]]);
  assert.deepEqual(mergeRanges(undefined), []);
  assert.equal(rangeCount([[0, 3], [7, 9]]), 7, 'closed intervals: both ends count');
  assert.equal(rangeHas([[0, 3], [7, 9]], 3), true);
  assert.equal(rangeHas([[0, 3], [7, 9]], 5), false);
});

test('put/get round-trips raw UTF-8 HTML in the shared tier and misses return null', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const html = '<div data-pc-clip="a">Price &amp; <span style="width:800px">42</span></div>';
  const file = await store.writeSnapshot({ tier: 'shared', key: 'KEY1', localFrame: 0, html });
  assert.equal(file, path.join(root, SHARED_DIR, 'KEY1', '0.html'));
  // Raw UTF-8, no base64, no deflate: this file on disk is the snapshot itself.
  assert.equal(await fs.readFile(file, 'utf8'), html);
  assert.equal(await store.readSnapshot({ tier: 'shared', key: 'KEY1', localFrame: 0 }), html);
  // Missing frame returns null (does not throw): missing layer is transparent, playhead does not stop.
  assert.equal(await store.readSnapshot({ tier: 'shared', key: 'KEY1', localFrame: 9 }), null);
  assert.equal(await store.readSnapshot({ tier: 'shared', key: 'NOPE', localFrame: 0 }), null);
  await assert.rejects(store.writeSnapshot({ tier: 'shared', key: 'KEY1', localFrame: -1, html }), /Invalid local frame/);
}));

test('local tier writes under <root>/controls-local/<entry.key>/<shared key>/ and never collides with shared', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  await store.writeSnapshot({ tier: 'local', entryKey: 'ENTRY', key: 'KEY1', localFrame: 2, html: 'local' });
  await store.writeSnapshot({ tier: 'shared', key: 'KEY1', localFrame: 2, html: 'shared' });
  assert.equal(await fs.readFile(path.join(root, LOCAL_DIR, 'ENTRY', 'KEY1', '2.html'), 'utf8'), 'local');
  assert.equal(await fs.readFile(path.join(root, SHARED_DIR, 'KEY1', '2.html'), 'utf8'), 'shared');
  // Same shared key, two projects: each has its own subtree.
  await store.writeSnapshot({ tier: 'local', entryKey: 'OTHER', key: 'KEY1', localFrame: 2, html: 'other' });
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: 'ENTRY', key: 'KEY1', localFrame: 2 }), 'local');
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: 'OTHER', key: 'KEY1', localFrame: 2 }), 'other');
}));

test('index.json is per key dir, updated per batch, and merges across batches', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'shared', key: 'KEY1' };
  assert.deepEqual(await store.snapshotIndex(target), { count: 0, frames: [], oversize: [] }, 'no index yet is not an error');
  // Batch size for fillCardControls is 4: updated once after writing each batch.
  for (const frame of [0, 1, 2, 3]) await store.writeSnapshot({ ...target, localFrame: frame, html: `f${frame}` });
  assert.deepEqual(await store.updateIndex({ ...target, frames: [0, 1, 2, 3] }), { count: 4, frames: [[0, 3]], oversize: [] });
  for (const frame of [4, 5, 6, 7]) await store.writeSnapshot({ ...target, localFrame: frame, html: `f${frame}` });
  await store.updateIndex({ ...target, frames: [4, 5, 6, 7] });
  // Adjacent batches merged into a single interval, not two.
  assert.deepEqual(await store.snapshotIndex(target), { count: 8, frames: [[0, 7]], oversize: [] });
  // A hole that was canceled and backfilled later: first 12-13, then backfilled 8-11, finally merged into one.
  for (const frame of [12, 13]) await store.writeSnapshot({ ...target, localFrame: frame, html: `f${frame}` });
  await store.updateIndex({ ...target, frames: [12, 13] });
  assert.deepEqual(await store.snapshotIndex(target), { count: 10, frames: [[0, 7], [12, 13]], oversize: [] });
  for (const frame of [8, 9, 10, 11]) await store.writeSnapshot({ ...target, localFrame: frame, html: `f${frame}` });
  await store.updateIndex({ ...target, frames: [8, 9, 10, 11] });
  assert.deepEqual(await store.snapshotIndex(target), { count: 14, frames: [[0, 13]], oversize: [] });
  const raw = JSON.parse(await fs.readFile(path.join(root, SHARED_DIR, 'KEY1', 'index.json'), 'utf8'));
  // When the on-disk file has no oversize frames, **do not write** the `oversize` field: legacy index.json can be read back as-is
  assert.deepEqual(raw, { count: 14, frames: [[0, 13]] });
  // index.json lives in the key directory, alongside frame files: reading one small JSON is
  // enough to find "which frames exist" for a key, without needing to readdir thousands of files.
  const names = (await fs.readdir(path.join(root, SHARED_DIR, 'KEY1'))).filter(name => !name.startsWith('.'));
  assert.equal(names.includes('index.json'), true);
  assert.equal(names.filter(name => name.endsWith('.html')).length, 14);
  assert.equal(await store.readSnapshot({ ...target, localFrame: 13 }), 'f13');
}));

test('R6-14: over-limit frames are recorded in oversize in index.json and persist across processes', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'shared', key: 'BIGK' };
  // A batch of 4 frames: two frames pass, two frames oversize
  const index = await store.updateIndex({ ...target, frames: [0, 1], oversize: [2, 3] });
  assert.deepEqual(index, { count: 2, frames: [[0, 1]], oversize: [[2, 3]] });
  // The two lists are independent; subsequent batches are merged separately
  await store.updateIndex({ ...target, frames: [4], oversize: [5] });
  assert.deepEqual(await store.snapshotIndex(target), { count: 3, frames: [[0, 1], [4, 4]], oversize: [[2, 3], [5, 5]] });
  // The on-disk copy includes oversize: switching to another SnapshotStore (restarting the prerender process) can still read it back
  const raw = JSON.parse(await fs.readFile(path.join(root, SHARED_DIR, 'BIGK', 'index.json'), 'utf8'));
  assert.deepEqual(raw.oversize, [[2, 3], [5, 5]]);
  assert.deepEqual(await new SnapshotStore(root).snapshotIndex(target), { count: 3, frames: [[0, 1], [4, 4]], oversize: [[2, 3], [5, 5]] });
  // rebuildIndex rebuilds frames from frame files on disk, but **keeps** the oversize list:
  // having frame files on disk does not mean they pass (write file first, classify oversize later);
  // losing the list would cause the next pass to render again in vain
  for (const frame of [0, 1, 2, 3, 4, 5]) await store.writeSnapshot({ ...target, localFrame: frame, html: 'x' });
  assert.deepEqual(await store.rebuildIndex(target), { count: 6, frames: [[0, 5]], oversize: [[2, 3], [5, 5]] });
}));

test('concurrent batches on one key never lose a range', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'local', entryKey: 'E', key: 'K' };
  // Interleaving another batch during read-modify-write causes lost segments; `updateIndex` is serialized per directory.
  await Promise.all([[0, 1], [2, 3], [4, 5], [10, 11]].map(frames => store.updateIndex({ ...target, frames })));
  assert.deepEqual(await store.snapshotIndex(target), { count: 8, frames: [[0, 5], [10, 11]], oversize: [] });
}));

test('rebuildIndex recovers the index from the frame files on disk', async () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'shared', key: 'KEY2' };
  for (const frame of [0, 1, 2, 5]) await store.writeSnapshot({ ...target, localFrame: frame, html: 'x' });
  // Power loss occurred and index.json was not written: rebuild from actual <localFrame>.html on disk.
  assert.deepEqual(await store.rebuildIndex(target), { count: 4, frames: [[0, 2], [5, 5]], oversize: [] });
  assert.deepEqual(await store.snapshotIndex(target), { count: 4, frames: [[0, 2], [5, 5]], oversize: [] });
  assert.deepEqual(await store.rebuildIndex({ tier: 'shared', key: 'ABSENT' }), { count: 0, frames: [], oversize: [] });
}));

/**
 * The whole-scene path (`record`) must write to the snapshot store while writing control HTML.
 * This is the only safeguard while "target" and "current state" coexist: the legacy
 * `entry.controls` → `html-manifest.json` remains, but the new directory must grow in sync,
 * otherwise the disk will be empty when switching the read side in step 4.
 *
 * Run directly with three methods on `FramePipeline.prototype` configured with a minimal mock
 * entry: this section touches neither Chrome nor ffmpeg, not worth launching a whole pipeline for.
 */
test('record routes control HTML into the snapshot store, shared and local side by side', async () => withRoot(async root => {
  const { FramePipeline } = await import('../frame-pipeline.mjs');
  const pipeline = { root, _snapshots: new SnapshotStore(root),
    snapshots: FramePipeline.prototype.snapshots,
    snapshotTargets: FramePipeline.prototype.snapshotTargets,
    prerenderPicked: FramePipeline.prototype.prerenderPicked,
    recordSnapshots: FramePipeline.prototype.recordSnapshots,
    flushSnapshots: FramePipeline.prototype.flushSnapshots };
  const entry = { key: 'ENTRY', cardPlan: [
    { clipId: 'clip-shared', snapshotKey: 'SHARED-KEY', tier: 'shared', capabilities: { compositing: 'independent', frameMode: 'stateful' } },
    // Frosted glass: can only be produced by the whole-scene path, uses local tier, nesting entry.key under the key directory.
    { clipId: 'clip-blur', snapshotKey: 'BLUR-KEY', tier: 'local', capabilities: { compositing: 'belowDependent', frameMode: 'stateful' } },
    // Uncertain cards are treated as below-dependent cards: local tier (plan 3.1(2)).
    { clipId: 'clip-unknown', snapshotKey: 'U-KEY', tier: 'local', capabilities: { compositing: 'unknown', frameMode: 'stateful' } },
    // Cards classified as light at all positions do not produce snapshots (render 9).
    { clipId: 'clip-direct', snapshotKey: 'D-KEY', tier: 'none', capabilities: { compositing: 'independent', frameMode: 'direct' } },
    // Entries with no shared key in the plan (manually constructed / callers not yet wired to a key) are skipped directly, not writing a single frame.
    { clipId: 'clip-nokey', capabilities: { compositing: 'independent', frameMode: 'stateful' } },
  ] };
  for (const frame of [0, 1]) {
    pipeline.recordSnapshots(entry, [
      { id: 'clip-shared', frame, html: `<i>shared ${frame}</i>` },
      { id: 'clip-blur', frame, html: `<i>blur ${frame}</i>` },
      { id: 'clip-unknown', frame, html: `<i>unknown ${frame}</i>` },
      { id: 'clip-direct', frame, html: 'never' },
      { id: 'clip-nokey', frame, html: 'never' },
      { id: 'clip-absent', frame, html: 'never' },        // Clip not in the graph
      { id: 'clip-shared', frame: undefined, html: 'no' }, // Cannot address without a local frame number
    ]);
  }
  await pipeline.flushSnapshots(entry);
  const store = pipeline.snapshots();
  assert.equal(await store.readSnapshot({ tier: 'shared', key: 'SHARED-KEY', localFrame: 1 }), '<i>shared 1</i>');
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: 'ENTRY', key: 'BLUR-KEY', localFrame: 1 }), '<i>blur 1</i>');
  assert.deepEqual(await store.snapshotIndex({ tier: 'shared', key: 'SHARED-KEY' }), { count: 2, frames: [[0, 1]], oversize: [] });
  assert.deepEqual(await store.snapshotIndex({ tier: 'local', entryKey: 'ENTRY', key: 'BLUR-KEY' }), { count: 2, frames: [[0, 1]], oversize: [] });
  // Unknown card enters the local tier, in the same tree as frosted glass.
  assert.equal(await store.readSnapshot({ tier: 'local', entryKey: 'ENTRY', key: 'U-KEY', localFrame: 0 }), '<i>unknown 0</i>');
  // The entry.key layer should not appear under the shared tier directory; the local tier has no
  // cards classified as light and no keyless cards.
  assert.deepEqual((await fs.readdir(path.join(root, SHARED_DIR))).sort(), ['SHARED-KEY']);
  assert.deepEqual((await fs.readdir(path.join(root, LOCAL_DIR, 'ENTRY'))).sort(), ['BLUR-KEY', 'U-KEY']);
  // The next batch continues merging, without starting a new segment.
  pipeline.recordSnapshots(entry, [{ id: 'clip-shared', frame: 2, html: '<i>shared 2</i>' }]);
  await pipeline.flushSnapshots(entry);
  assert.deepEqual(await store.snapshotIndex({ tier: 'shared', key: 'SHARED-KEY' }), { count: 3, frames: [[0, 2]], oversize: [] });
  // Entries without cardPlan (foreground single-frame path) write nothing and report no error.
  const bare = { key: 'BARE' };
  bare.cardPlan = undefined;
  pipeline.recordSnapshots(bare, [{ id: 'clip-shared', frame: 0, html: 'x' }]);
  await pipeline.flushSnapshots(bare);
  assert.deepEqual((await fs.readdir(path.join(root, LOCAL_DIR))).sort(), ['ENTRY']);
}));

// ── T1a review #9: sole entry point for writing snapshots ─────────────────────────────────────────

test('commitSnapshots: writing frames, checking size and merging the index are done in one step, and over-limit frames are written to disk but go into oversize', () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'shared', key: 'COMMIT' };
  const huge = 'x'.repeat(DOM_SNAPSHOT_LIMIT + 1);
  const out = await store.commitSnapshots({ ...target, clipId: 'c', capabilities: {}, items: [
    { localFrame: 0, html: 'a' }, { localFrame: 1, html: huge }, { localFrame: 2, html: 'c' },
  ] });
  assert.deepEqual(out.written, [0, 2]);
  assert.deepEqual(out.oversized, [1]);
  assert.deepEqual(out.frames, [[0, 0], [2, 2]]);
  assert.deepEqual(out.oversize, [[1, 1]]);
  // All three frames are on disk (over-limit frames written to disk as usual), index matches return value
  assert.equal(await store.readSnapshot({ ...target, localFrame: 1 }), huge);
  assert.deepEqual(await store.snapshotIndex(target), { count: 2, frames: [[0, 0], [2, 2]], oversize: [[1, 1]] });
  // Empty batch does not touch index, returns the current index
  const empty = await store.commitSnapshots({ ...target, items: [] });
  assert.deepEqual({ count: empty.count, written: empty.written }, { count: 2, written: [] });
}));

test('batch: hands over once size frames have accumulated; each frame is either still in memory or already on disk and in the index', () => withRoot(async root => {
  const store = new SnapshotStore(root);
  const target = { tier: 'local', entryKey: 'E', key: 'B' };
  const batch = store.batch({ ...target, clipId: 'c', capabilities: {} }, { size: 2 });
  await batch.add(0, 'f0');
  // Not full: not on disk and not in index (no case of "on disk, but not in index")
  assert.equal(await store.readSnapshot({ ...target, localFrame: 0 }), null);
  assert.deepEqual(await store.snapshotIndex(target), { count: 0, frames: [], oversize: [] });
  await batch.add(1, 'f1');
  assert.deepEqual(await store.snapshotIndex(target), { count: 2, frames: [[0, 1]], oversize: [] });
  await batch.add(2, 'f2');
  const index = await batch.close();
  assert.deepEqual(index.frames, [[0, 2]]);
  assert.equal(batch.written, 3);
  // Every frame on disk is in index
  const names = (await fs.readdir(snapshotDir(root, target))).filter(n => n.endsWith('.html')).map(n => Number(n.slice(0, -5))).sort();
  assert.deepEqual(names, [0, 1, 2]);
  // A batch close that submitted nothing returns null
  assert.equal(await store.batch({ ...target, key: 'NONE' }).close(), null);
}));

test('Production code does not call writeSnapshot / updateIndex directly (only via commitSnapshots / batch)', async () => {
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const offenders = [];
  const walk = async dir => {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) { if (item.name !== 'test' && item.name !== 'node_modules') await walk(file); continue; }
      if (!/\.(mjs|ts)$/.test(item.name) || item.name === 'snapshot-store.mjs') continue;
      const text = await fs.readFile(file, 'utf8');
      if (/\.(writeSnapshot|updateIndex)\(/.test(text)) offenders.push(path.relative(serverDir, file));
    }
  };
  await walk(serverDir);
  assert.deepEqual(offenders, []);
});
