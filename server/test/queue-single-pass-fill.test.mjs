/**
 * Arrangement of queue fine-grained tasks with one pass per segment forward push
 * (`fillCardControls`'s `singlePass`, `docs/archive/agent-reports/AGENT-uc-latency.md`):
 * check page switch count, frame set passed to frame-push, granularity of storage and progress,
 * and final snapshots on disk item by item against identical parts in the original batch mode.
 * Run: node --experimental-test-module-mocks --test server/test/queue-single-pass-fill.test.mjs
 *
 * Without starting Chrome: replace `server/bakery/index.mjs` with a mock (same as
 * `card-lock-pipeline.test.mjs`), mock `bakeFrames` records each call, for `targetFrames` in
 * sequence first call `onSnapshot` (for those in `snapshotFrames`) then call `onFrame`:
 * same as the real one, a frame's snapshot precedes its screenshot.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const bakeLog = [];
mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('Unit test does not open Chrome'); },
    findFfmpeg: async () => 'ffmpeg',
    streamPngVideo: () => { throw new Error('Unit test does not encode'); },
    bakeFrames: async (bakery, opts = {}) => {
      const rec = { targetFrames: [...(opts.targetFrames ?? [])], snapshotFrames: [...(opts.snapshotFrames ?? [])], events: [] };
      bakeLog.push(rec);
      for (const frame of rec.targetFrames) {
        if (rec.snapshotFrames.includes(frame)) {
          await opts.onSnapshot?.(frame, '<div data-pc-scene=""></div>', [{ id: 'clip-a', frame, html: `<p>a ${frame}</p>` }]);
          rec.events.push(`snap ${frame}`);
        }
        await opts.onFrame?.(frame, Buffer.from(`png-${frame}`));
        rec.events.push(`shot ${frame}`);
      }
      return { advancedFrames: rec.targetFrames.length };
    },
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { describeEnvironment } = await import('../render-node/fingerprint.mjs');

const ENV = describeEnvironment({
  platform: 'win32', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
const N = 30;   // 1 second @ 30 fps
const project = { id: 'qsp-fill', fps: 30, width: 320, height: 180, duration: 1, style: {}, media: [],
  tracks: [{ id: 't1', clips: [{ id: 'clip-a', cardId: 'demo-a', start: 0, end: 1 }] }] };
const graph = { definitions: [], nodes: [{ id: 'n-a', adapter: 'chrome', cardId: 'demo-a', capabilities: { compositing: 'independent', frameMode: 'stateful' }, inputs: {} }],
  outputs: [{ nodeId: 'n-a', clipId: 'clip-a', start: 0, end: 1, opacity: 1 }] };

async function run(root, { singlePass, range }) {
  bakeLog.length = 0;
  const pipeline = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: ENV, dataRoot: root, interactive: false });
  await pipeline.ensureCardLocks();
  // When storing, record an entry in the event stream of the current frame-push
  // (check the relative order of storing vs frame-push)
  const store = pipeline.snapshots();
  const commit = store.commitSnapshots.bind(store);
  store.commitSnapshots = (args) => { bakeLog.at(-1)?.events.push(`commit ${args.items.map(i => i.localFrame).join(',')}`); return commit(args); };
  const entry = await pipeline.entry(project);
  pipeline.recordCardPlan(entry, entry.cardCache.plan(graph).map(c => ({ ...c, tier: 'shared' })));
  entry.cardCache.hasComplete = async () => false;
  entry.cardCache.put = async () => true;
  entry.cardCache.finish = async () => {};
  const control = entry.cardPlan.find(c => c.clipId === 'clip-a');
  const resets = [];
  const bakery = { page: { setViewport: async () => {}, evaluate: async () => graph }, reset: async (p) => { resets.push(p?.tracks?.length ?? null); } };
  const batches = [];
  await pipeline.fillCardControls(entry, bakery, null, [control], { range, singlePass, onBatch: ({ first, frames, snapshotFrames }) => batches.push({ first, frames: [...frames], snapshotFrames: [...snapshotFrames] }) });
  const index = await pipeline.snapshots().snapshotIndex({ tier: 'shared', key: control.snapshotKey });
  const dir = pipeline.snapshots().dir({ tier: 'shared', key: control.snapshotKey });
  const files = {};
  for (let n = 0; n < N; n++) { try { files[n] = await fs.readFile(path.join(dir, `${n}.html`), 'utf8'); } catch { /* None */ } }
  await pipeline.close().catch(() => {});
  return { resets, batches, index, files, bakes: bakeLog.map(r => ({ ...r })) };
}

const withTmp = async (fn) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-qsp-fill-'));
  try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
};

test('QSP4 one segment (frames 6-25) in a sequential pass: one page switch + one wrap-up; the frame set equals the union of the per-batch runs; commit once and report progress once per 4 frames; the snapshots on disk are the same', async () => {
  const range = { from: 6, to: 25 };
  const batch = await withTmp(root => run(root, { singlePass: false, range }));
  const single = await withTmp(root => run(root, { singlePass: true, range }));
  // Batch-by-batch: batch heads 4, 8, …, 24, switch page once per batch, plus finalize once
  assert.deepEqual(batch.bakes.map(b => b.targetFrames[0]), [4, 8, 12, 16, 20, 24]);
  assert.equal(batch.resets.length, 6 + 1);
  // Forward push: one frame-push, frame set = union of each batch from batch mode;
  // switch page 1 time + finalize 1 time
  assert.equal(single.bakes.length, 1);
  assert.deepEqual(single.bakes[0].targetFrames, batch.bakes.flatMap(b => b.targetFrames));
  assert.deepEqual(single.bakes[0].snapshotFrames, batch.bakes.flatMap(b => b.snapshotFrames));
  assert.equal(single.resets.length, 1 + 1);
  // Progress: once every 4 frames, total frames add up to the same as batch mode
  assert.deepEqual(single.batches.map(b => b.frames.length), [4, 4, 4, 4, 4, 4]);
  assert.deepEqual(single.batches.flatMap(b => b.frames), batch.batches.flatMap(b => b.frames));
  assert.deepEqual(single.batches.flatMap(b => b.snapshotFrames), batch.batches.flatMap(b => b.snapshotFrames));
  // On disk: same set of frames, same content, same index
  assert.deepEqual(single.index.frames, batch.index.frames);
  assert.deepEqual(single.index.frames, [[6, 25]]);
  assert.deepEqual(single.files, batch.files);
});

test('QSP5 in a sequential pass, every 4 frames are committed before the next frame is captured: committing follows the pushing of frames, rather than handing everything over at once after all are pushed', async () => {
  const single = await withTmp(root => run(root, { singlePass: true, range: { from: 0, to: 11 } }));
  assert.equal(single.bakes.length, 1);
  assert.deepEqual(single.batches.map(b => b.first), [0, 4, 8]);
  const ev = single.bakes[0].events;
  assert.deepEqual(ev.filter(e => e.startsWith('commit')), ['commit 0,1,2,3', 'commit 4,5,6,7', 'commit 8,9,10,11']);
  assert.ok(ev.indexOf('commit 0,1,2,3') > ev.indexOf('snap 3') && ev.indexOf('commit 0,1,2,3') < ev.indexOf('snap 4'), 'the first batch of 4 frames is committed before frame 5 is pushed');
});

test('QSP6 only one batch (a segment of fewer than 5 frames) or no range given: proceeds batch by batch as before', async () => {
  const one = await withTmp(root => run(root, { singlePass: true, range: { from: 0, to: 3 } }));
  assert.equal(one.bakes.length, 1);
  assert.deepEqual(one.bakes[0].targetFrames, [0, 1, 2, 3]);
  const whole = await withTmp(root => run(root, { singlePass: true, range: null }));
  assert.equal(whole.bakes.length, Math.ceil(N / 4), 'no range given (the background pass): batch by batch');
});
