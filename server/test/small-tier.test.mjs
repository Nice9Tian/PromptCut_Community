/**
 * Prerender small size (`docs/plan/c10a-contract.md` Section 9): size rules, separate readiness
 * for both tiers, manifest and push, layer table for online pages.
 * Run: node --experimental-test-module-mocks --test server/test/small-tier.test.mjs
 *
 * Does not launch Chrome (`bakery/index.mjs` is mocked to record calls and throw): generating
 * small bitmaps itself is verified by `scripts/probes/small-tier-probe.mjs` in a real prerender
 * Chrome; this verifies everything else: size, manifest, push, completion conditions, layer
 * table, and when not to generate.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const bakeryCalls = [];
const refuse = (name) => (...args) => { bakeryCalls.push(name); void args; throw new Error(`Unit test does not render (${name})`); };
mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async (...a) => refuse('openBakery')(...a),
    findFfmpeg: async (...a) => refuse('findFfmpeg')(...a),
    streamPngVideo: refuse('streamPngVideo'),
    bakeFrames: async (...a) => refuse('bakeFrames')(...a),
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { describeEnvironment, resultKeyOf } = await import('../render-node/fingerprint.mjs');
const T = await import('../artifact-transfer.mjs');
const { createPushQueue } = await import('../artifact-push.mjs');
const { smallScale, smallSize, webpSize, isWebp, SMALL_SUFFIX, SMALL_WEBP_QUALITY } = await import('../bakery/small-bitmap.mjs');

const OWN_ENV = describeEnvironment({
  platform: 'win32', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const roots = [];
const pipelines = [];
after(async () => {
  await Promise.allSettled(pipelines.map((p) => p.close()));
  await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});
async function makePipeline() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-c10a-small-'));
  roots.push(root);
  const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive: false });
  pipelines.push(p);
  return p;
}
/** Fake asset service client: stored by (ns, hash) */
function memClient() {
  const blobs = new Map();
  const puts = [];
  return {
    blobs, puts,
    async put(ns, bytes, { ext } = {}) {
      const hash = sha256(bytes);
      const id = `${ns}/${hash}`;
      puts.push({ ns, hash, ext });
      const uploaded = !blobs.has(id);
      blobs.set(id, { bytes: Buffer.from(bytes), ext });
      return { hash, uploaded };
    },
    async has(ns, hash) { return blobs.has(`${ns}/${hash}`); },
    async get(ns, hash) { return blobs.get(`${ns}/${hash}`)?.bytes ?? null; },
  };
}
/** A decent WebP header (VP8X with alpha flag), size w×h; subsequent bytes are arbitrary */
function fakeWebp(w, h, salt = 0) {
  const b = Buffer.alloc(40 + salt);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(b.length - 8, 4); b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii'); b.writeUInt32LE(10, 16); b[20] = 0x10;
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}
const html = (n) => `<div style="position:absolute;left:${n}px;top:0;width:10px;height:10px;background:red"></div>`;

/* ------------------------------------------------------------------ Size rules */

test('ST1 size: scaled proportionally to fit within 800×600, never enlarged, keeping the aspect ratio (16:9 → 800×450, 9:16 → 337×600)', () => {
  assert.deepEqual(smallSize({ projectWidth: 1920, projectHeight: 1080 }), { scale: 800 / 1920, width: 800, height: 450 });
  assert.deepEqual(smallSize({ projectWidth: 1080, projectHeight: 1920 }), { scale: 600 / 1920, width: 337, height: 600 });
  assert.deepEqual(smallSize({ projectWidth: 3840, projectHeight: 2160 }), { scale: 800 / 3840, width: 800, height: 450 });
  assert.deepEqual(smallSize({ projectWidth: 1000, projectHeight: 1000 }), { scale: 0.6, width: 600, height: 600 });
  assert.deepEqual(smallSize({ projectWidth: 640, projectHeight: 360 }), { scale: 1, width: 640, height: 360 }, 'No upscaling');
  assert.equal(smallScale(0, 0), 1);
  // Cards with a box configured: the box scales by the same project scale ratio (small bitmap fills the snapshot plane in the wrapper layer on the page)
  assert.deepEqual(smallSize({ projectWidth: 1920, projectHeight: 1080, boxWidth: 600, boxHeight: 300 }), { scale: 800 / 1920, width: 250, height: 125 });
  assert.deepEqual(smallSize({ projectWidth: 1920, projectHeight: 1080, boxWidth: 1, boxHeight: 1 }), { scale: 800 / 1920, width: 1, height: 1 }, 'At least 1 pixel');
  assert.equal(SMALL_WEBP_QUALITY, 80);
});

test('ST2 WebP header: recognized, size can be read', () => {
  const w = fakeWebp(800, 450);
  assert.equal(isWebp(w), true);
  assert.deepEqual(webpSize(w), { width: 800, height: 450 });
  assert.equal(isWebp(Buffer.from('not a webp at all')), false);
  assert.equal(webpSize(Buffer.from('RIFF')), null);
});

/* ------------------------------------------------------------------ Manifest: tracked separately for both tiers */

async function seed(p, key, frames) {
  await p.snapshots().commitSnapshots({ tier: 'shared', key, clipId: 'c1', capabilities: {}, items: frames.map((f) => ({ localFrame: f, html: html(f) })) });
  return p.snapshots().dir({ tier: 'shared', key });
}
const task = (key, from, to) => ({ kind: 'snapshot', tier: 'shared', resultKey: key, range: { from, to }, input: {} });

test('ST3 manifest: with no small bitmaps it is identical to C6.4 down to the character (no small entry); frames that have one are listed in a separate small table, and frames is unchanged', async () => {
  const p = await makePipeline();
  const key = 'k'.repeat(64).replace(/k/g, 'a');
  const dir = await seed(p, key, [0, 1, 2, 3]);
  const before = (await T.collectSnapshotResult(p, task(key, 0, 3))).result;
  assert.equal('small' in before, false, 'No small bitmaps means no such entry');
  await fs.writeFile(path.join(dir, `1${SMALL_SUFFIX}`), fakeWebp(800, 450, 1));
  await fs.writeFile(path.join(dir, `3${SMALL_SUFFIX}`), fakeWebp(800, 450, 3));
  const after = (await T.collectSnapshotResult(p, task(key, 0, 3))).result;
  assert.deepEqual(after.frames, before.frames, 'The original-size table is not affected by the small size');
  assert.deepEqual(after.small.map(([f]) => f), [1, 3]);
  assert.equal(after.small[0][1], sha256(fakeWebp(800, 450, 1)));
  // Small size ready cannot be treated as original size ready: frames with only small bitmaps and no HTML do not enter any table
  await fs.writeFile(path.join(dir, `5${SMALL_SUFFIX}`), fakeWebp(800, 450, 5));
  const wider = (await T.collectSnapshotResult(p, task(key, 0, 7))).result;
  assert.deepEqual(wider.frames.map(([f]) => f), [0, 1, 2, 3]);
  assert.deepEqual(wider.small.map(([f]) => f), [1, 3], 'Frames without an original size do not list a small size');
  assert.ok(T.manifestMatches(after, task(key, 0, 3)));
  assert.deepEqual(T.smallFramesOf(after).length, 2);
});

test('ST4 manifest shape: a manifest whose small table has the wrong shape is not accepted', () => {
  const ok = { v: 1, kind: 'snapshot', resultKey: 'x', range: { from: 0, to: 1 }, frames: [[0, 'a'.repeat(64), 1]], small: [[0, 'b'.repeat(64), 1]] };
  assert.equal(T.manifestMatches(ok, { kind: 'snapshot', resultKey: 'x', range: { from: 0, to: 1 } }), true);
  assert.equal(T.manifestMatches({ ...ok, small: [[0, 'nothex', 1]] }, { kind: 'snapshot', resultKey: 'x', range: { from: 0, to: 1 } }), false);
  assert.equal(T.manifestMatches({ ...ok, small: 'x' }, { kind: 'snapshot', resultKey: 'x', range: { from: 0, to: 1 } }), false);
  assert.deepEqual(T.smallFramesOf({ small: [[0, 'nothex']] }), []);
});

test('ST5 push: both tiers are pushed to the asset service (HTML goes to snap, small bitmap WebP goes to px), and the push itself does not render', async () => {
  const p = await makePipeline();
  const key = 'b'.repeat(64);
  const dir = await seed(p, key, [0, 1]);
  await fs.writeFile(path.join(dir, `0${SMALL_SUFFIX}`), fakeWebp(800, 450, 0));
  await fs.writeFile(path.join(dir, `1${SMALL_SUFFIX}`), fakeWebp(800, 450, 1));
  const client = memClient();
  const calls = bakeryCalls.length;
  const { result, readBlob } = await T.collectSnapshotResult(p, task(key, 0, 1));
  await T.pushResult(client, result, readBlob);
  const px = client.puts.filter((x) => x.ns === 'px');
  const snap = client.puts.filter((x) => x.ns === 'snap');
  assert.equal(snap.length, 2);
  assert.equal(px.length, 2);
  assert.ok(px.every((x) => x.ext === 'webp'));
  for (const [, hash] of result.small) assert.ok(await client.has('px', hash), `Small bitmap ${hash} is on the asset service`);
  assert.equal(bakeryCalls.length, calls, 'Pushing does not trigger rendering');
});

test('ST6 completion condition: before listing the manifest, wait for the small sizes being generated to settle, and both tiers go into this segment manifest', async () => {
  const p = await makePipeline();
  const key = 'c'.repeat(64);
  const dir = await seed(p, key, [0, 1]);
  // Simulate "small size is still generating": attach a task to the chain that writes the file only after 60 ms
  p.smallChain = new Promise((resolve) => setTimeout(async () => {
    await fs.writeFile(path.join(dir, `0${SMALL_SUFFIX}`), fakeWebp(800, 450, 0));
    await fs.writeFile(path.join(dir, `1${SMALL_SUFFIX}`), fakeWebp(800, 450, 1));
    resolve();
  }, 60));
  const { result } = await T.collectSnapshotResult(p, task(key, 0, 1));
  assert.deepEqual(result.small.map(([f]) => f), [0, 1]);
  // Even if tasks on the chain fail, original size is not blocked
  p.smallChain = Promise.reject(new Error('Broken'));
  const again = (await T.collectSnapshotResult(p, task(key, 0, 1))).result;
  assert.deepEqual(again.frames.map(([f]) => f), [0, 1]);
});

/* ------------------------------------------------------------------ When not to generate */

test('ST7 when to schedule: not scheduled without a push queue configured; if configured, it is noted and drawn later when the page is switched between prerenders (Chrome is not opened); pulled-in frames are not scheduled', async () => {
  const p = await makePipeline();
  const calls = bakeryCalls.length;
  const args = { tier: 'shared', key: 'd'.repeat(64), clipId: 'c1', items: [{ localFrame: 0, html: html(0) }] };
  assert.equal(p.scheduleSmallSnapshots(args), false, 'No push queue configured');
  p.pushQueue = { enqueue: async () => {} };
  assert.equal(p.smallTierEnabled(), false, 'F2: the small tier is discontinued, and defaults to false even with a push queue configured');
  p.smallTierEnabled = () => true; // Explicitly enabled in unit tests to test scheduling logic
  assert.equal(p.scheduleSmallSnapshots(args), true, 'Recorded');
  assert.equal(p.smallPending.length, 1);
  assert.equal(p.scheduleSmallSnapshots({ ...args, adopted: true }), false, 'Pulled-in frames');
  // If too many accumulate, keep only the latest
  for (let i = 0; i < 600; i++) p.scheduleSmallSnapshots({ ...args, items: [{ localFrame: i, html: html(i) }] });
  assert.ok(p.smallPending.reduce((n, j) => n + j.items.length, 0) <= 480);
  assert.ok(p.smallStats.dropped > 0);
  p.smallPending = [];
  // commitSnapshots hook enters the push queue as usual, but does not launch Chrome
  await p.snapshots().commitSnapshots(args);
  assert.equal(bakeryCalls.length, calls, 'openBakery was never called');
  p.smallPending = [];
  p.smallTierEnabled = FramePipeline.prototype.smallTierEnabled;
  assert.equal(p.smallTierEnabled(), false);
  p.pushQueue = null;
});

/* ------------------------------------------------------------------ Layer table */

test('ST8 layer table: lists the cards in the prerender set that produce snapshots; the shared tier result key = the shared key, and the local tier is computed per E.9; cards classified as light or that produce no snapshots are not listed', () => {
  const fp = OWN_ENV.fingerprint;
  const entry = {
    key: 'entry1', project: { id: 'proj-1', fps: 30, width: 1920, height: 1080 },
    cardPlan: [
      { clipId: 'a', snapshotKey: 'S'.repeat(8), tier: 'shared', sampling: { firstFrame: 30 }, count: 90 },
      { clipId: 'b', snapshotKey: 'L'.repeat(8), contentKey: 'ck-b', envFingerprint: fp, tier: 'local', sampling: { firstFrame: 0 }, count: 45 },
      { clipId: 'c', snapshotKey: 'X'.repeat(8), tier: 'shared', sampling: { firstFrame: 0 }, count: 10 },
      { clipId: 'd', snapshotKey: null, tier: 'none', sampling: { firstFrame: 0 }, count: 10 },
    ],
  };
  const body = T.layerMapOf(entry, { picked: (id) => id !== 'c', fingerprint: fp, now: 123 });
  assert.equal(body.kind, 'layer-map');
  assert.equal(body.projectId, 'proj-1');
  assert.equal(body.span, 60);
  assert.equal(body.at, 123);
  assert.deepEqual(body.layers.map((l) => l.clipId), ['a', 'b']);
  // C10 contract Section 18, Item 3: layer table v 2, each layer includes contentKey (shared tier
  // content key, null if unavailable) and envFingerprint;
  // M7 contract D12 bumps to v 3: also carries a candidate table; when there is no split record,
  // it only has itself as a single candidate, matching the layer fields
  assert.equal(body.v, 3);
  assert.deepEqual(body.layers[0], { clipId: 'a', kind: 'html', key: 'S'.repeat(8), tier: 'shared', resultKey: 'S'.repeat(8), dirKey: 'S'.repeat(8), entryKey: null, firstFrame: 30, count: 90,
    contentKey: null, envFingerprint: fp, candidates: [{ envFingerprint: fp, resultKey: 'S'.repeat(8), key: 'S'.repeat(8), dirKey: 'S'.repeat(8) }] });
  assert.equal(body.layers[1].contentKey, 'ck-b');
  assert.equal(body.layers[1].envFingerprint, fp);
  assert.equal(body.layers[1].kind, 'local');
  assert.equal(body.layers[1].key, `entry1/${'L'.repeat(8)}`);
  assert.equal(body.layers[1].resultKey, resultKeyOf('entry1/ck-b', fp));
  assert.equal(T.layerMapKeyOf('proj-1'), 'layers:proj-1');
  assert.equal(T.layerMapKeyOf(''), null);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 256 * 1024);
});

test('ST9 the layer table is written to the content store: briefly batched, the later write wins, identical content is not rewritten, failures retry with backoff', async () => {
  const p = await makePipeline();
  let t = 0;
  const timers = [];
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  };
  const advance = async (ms) => {
    t += ms;
    for (;;) {
      const due = timers.filter((h) => h.at <= t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await new Promise((r) => setImmediate(r));
    }
    await new Promise((r) => setImmediate(r));
  };
  const writes = [];
  let fail = 1;
  const content = {
    async put(kind, key, body) {
      if (fail > 0) { fail--; throw Object.assign(new Error('broken'), { code: 'disconnected' }); }
      writes.push({ kind, key, body });
      return { hash: 'h' };
    },
  };
  const queue = createPushQueue({ pipeline: p, client: memClient(), content, dir: roots.at(-1), clock, backoff: [1000], gate: false });
  const body = (n) => ({ v: 1, kind: 'layer-map', projectId: 'p', at: n, layers: [{ clipId: `c${n}` }] });
  assert.equal(queue.putLayerMap('p', body(1)), true);
  assert.equal(queue.putLayerMap('p', body(2)), true, 'A batched write is replaced by a later one');
  await advance(300);
  assert.equal(writes.length, 0, 'The first write failed');
  await advance(1000);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, 'snapshot-manifest');
  assert.equal(writes[0].key, 'layers:p');
  assert.deepEqual(writes[0].body.layers, [{ clipId: 'c2' }]);
  queue.putLayerMap('p', { ...body(2), at: 999 });
  await advance(300);
  assert.equal(writes.length, 1, 'Identical content (not counting at) is not rewritten');
  queue.putLayerMap('p', body(3));
  await advance(300);
  assert.equal(writes.length, 2);
  assert.equal(queue.putLayerMap('', body(4)), false, 'The project has no id');
  assert.equal(queue.stats().layerMaps, 2);
  await queue.stop();
  p.pushQueue = null;
});

/* ------------------------------------------------------------------ Completion condition: both tiers pushed successfully (Alibaba Cloud 295/300, 2026-09-27) */

/** A shared-tier card control (the items required by `scheduleMissingSmall` / `writeSmallSnapshots`) */
const controlOf = (key, count) => ({ clipId: 'c1', snapshotKey: key, tier: 'shared', capabilities: {}, count, appearance: { width: 1920, height: 1080 } });
/** Connects the pipeline to a fake push queue (enabling small size) and replaces small bitmap rendering with writing fake WebP directly (unit tests do not launch Chrome) */
function withSmallTier(p) {
  p.pushQueue = { enqueue: async () => {} };
  p.smallTierEnabled = () => true;
  const drawn = [];
  p.writeSmallSnapshots = async (job) => {
    const dir = p.snapshots().dir({ tier: job.tier, entryKey: job.entryKey, key: job.key });
    for (const item of job.items) {
      drawn.push(item.localFrame);
      await fs.writeFile(path.join(dir, `${item.localFrame}${SMALL_SUFFIX}`), fakeWebp(800, 450, item.localFrame));
    }
    return job.items.length;
  };
  return drawn;
}

test('ST10 frames that have the original size but lack the small size (rendered before the push queue, or whose process exited before drawing) are queued for the small size, reading the original HTML back from the frame store; nothing is read if the small size is off', async () => {
  const p = await makePipeline();
  const key = 'e'.repeat(64);
  const dir = await seed(p, key, [0, 1, 2, 3, 28, 29, 30, 31]);
  // These frames have small size: 1, 2, 3; 0 and 28-31 do not: same as that Alibaba Cloud round
  // (anchor frame 0 and playhead batch 28-31 were rendered before the push queue was configured)
  for (const f of [1, 2, 3]) await fs.writeFile(path.join(dir, `${f}${SMALL_SUFFIX}`), fakeWebp(800, 450, f));
  const control = controlOf(key, 60);
  const entry = { key: 'entry-e', project: { width: 1920, height: 1080, fps: 30 } };
  assert.equal(await p.scheduleMissingSmall(entry, control, { from: 0, to: 59 }), 0, 'Small size off: not scheduled');
  assert.equal(p.smallPending?.length ?? 0, 0);
  p.pushQueue = { enqueue: async () => {} };
  p.smallTierEnabled = () => true;
  assert.equal(await p.scheduleMissingSmall(entry, control, { from: 0, to: 59 }), 5);
  assert.deepEqual(p.smallPending.flatMap((j) => j.items.map((i) => i.localFrame)), [0, 28, 29, 30, 31]);
  assert.equal(p.smallPending[0].items[0].html, html(0), 'The original HTML is read back from the frame store');
  assert.equal(p.smallPending[0].key, key);
  // Only inspect this segment: 28-31 are not in [0, 3]
  p.smallPending = [];
  assert.equal(await p.scheduleMissingSmall(entry, control, { from: 0, to: 3 }), 1);
  p.smallPending = [];
  p.pushQueue = null;
});

test('ST11 end of a queue sub-task: if there are small sizes noted but not yet drawn, switch the page once to draw them (the pre-switch hook); if there are none, do not switch the page', async () => {
  const p = await makePipeline();
  const drawn = withSmallTier(p);
  const key = 'f'.repeat(64);
  await seed(p, key, [0, 1]);
  p.smallPending = []; // The batch conveniently recorded by the frame writing hook does not count: what is needed here is "has original size, missing small size"
  const resets = [];
  const bakery = {
    page: { setViewport: async () => {} },
    client: { send: async () => {} },
    async reset(project, url) { resets.push(url); await this.beforeReset?.(this); },
  };
  bakery.beforeReset = (b) => p.flushSmallOn(b);
  const project = { width: 1920, height: 1080, fps: 30, duration: 2, tracks: [], media: [] };
  assert.equal(await p.flushPendingSmall(bakery, project), false, 'Nothing pending to draw: no page switch');
  assert.equal(resets.length, 0);
  await p.scheduleMissingSmall({ key: 'x', project }, controlOf(key, 2), { from: 0, to: 1 });
  assert.equal(await p.flushPendingSmall(bakery, project), true);
  assert.equal(resets.length, 1);
  await p.whenSmallSettled();
  assert.deepEqual(drawn, [0, 1]);
  assert.equal(p.smallPending.length, 0);
  p.pushQueue = null;
});

test('ST12 sink: with the small size on, a missing small size means incomplete (put returns incomplete, has returns false, a manifest in the content store lacking the small size is not accepted); after filling in, both tiers are pushed together', async () => {
  const p = await makePipeline();
  const key = '9'.repeat(64);
  const dir = await seed(p, key, [0, 1, 2, 3]);
  for (const f of [1, 2, 3]) await fs.writeFile(path.join(dir, `${f}${SMALL_SUFFIX}`), fakeWebp(800, 450, f));
  const client = memClient();
  const manifests = new Map();
  const content = {
    async get(kind, k) { return manifests.has(k) ? { body: manifests.get(k) } : null; },
    async put(kind, k, body) { manifests.set(k, body); return { hash: 'h' }; },
  };
  const sink = T.createAssetSink({ pipeline: p, client, content });
  const ref = task(key, 0, 3);
  // Small size not enabled (no push queue configured): same as C6.4, completes when original size is complete
  assert.equal(await sink.has(ref), true);
  assert.equal((await sink.put(ref)).complete, true);
  assert.equal(T.smallComplete((await sink.put(ref)).result), false, 'This manifest really lacks the small size of frame 0');
  // Small size enabled: missing small size for frame 0 → not considered existing, not considered
  // complete (retryable), even if the content store already has a manifest with complete original size
  p.pushQueue = { enqueue: async () => {} };
  p.smallTierEnabled = () => true;
  assert.ok(manifests.size, 'The content store already has the manifest above (original size complete, small size missing)');
  assert.equal(await sink.has(ref), false);
  assert.equal(await sink.resultFor(ref), null);
  const miss = await sink.put(ref);
  assert.equal(miss.complete, false);
  assert.equal(miss.reason, 'small-missing', 'The reply explains why it was not fully received (diagnostics for AGENT-stall-phases)');
  // Backfill that frame: push both tiers together, manifest has small size for every frame
  await fs.writeFile(path.join(dir, `0${SMALL_SUFFIX}`), fakeWebp(800, 450, 0));
  assert.equal(await sink.has(ref), true);
  const done = await sink.put(ref);
  assert.equal(done.complete, true);
  assert.equal(T.smallComplete(done.result), true);
  assert.deepEqual(done.result.small.map(([f]) => f), [0, 1, 2, 3]);
  for (const [, hash] of done.result.small) assert.ok(await client.has('px', hash));
  // Streams do not have small size: always considered complete
  assert.equal(T.smallComplete({ kind: 'stream', segments: {} }), true);
  p.pushQueue = null;
});

test('ST13 queue sub-task (shared tier / local tier) also fills in when this segment is only missing the small size: when the task returns, both tiers of every frame are in the frame store', async () => {
  const p = await makePipeline();
  const drawn = withSmallTier(p);
  const project = { width: 1920, height: 1080, fps: 30, duration: 2, tracks: [], media: [] };
  const resets = [];
  const bakery = {
    page: { setViewport: async () => {} },
    client: { send: async () => {} },
    async reset(_project, url) { resets.push(url); await this.beforeReset?.(this); },
  };
  bakery.beforeReset = (b) => p.flushSmallOn(b);
  p.acquire = async () => bakery;
  p.release = () => {};
  // Original size was already complete (fillCardControls renders nothing and does not switch pages: worst-case scenario)
  p.fillCardControls = async () => [];
  const key = '7'.repeat(64);
  const dir = await seed(p, key, [0, 1, 2, 3]);
  p.smallPending = [];
  await fs.writeFile(path.join(dir, `2${SMALL_SUFFIX}`), fakeWebp(800, 450, 2));
  const control = controlOf(key, 4);
  const entry = { key: 'entry-7', project, cardPlan: [control] };
  await p.renderCardSnapshotRange(entry, control, { from: 0, to: 3 });
  assert.deepEqual(drawn.sort((a, b) => a - b), [0, 1, 3]);
  assert.equal(resets.length, 1, 'Switch the page once at the end to draw them');
  const { result } = await T.collectSnapshotResult(p, task(key, 0, 3));
  assert.equal(T.smallComplete(result), true);
  // Local tier: no frames need to be rendered, only missing small size, also backfilled during prerendering
  drawn.length = 0;
  const lkey = '6'.repeat(64);
  await p.snapshots().commitSnapshots({ tier: 'local', entryKey: entry.key, key: lkey, clipId: 'c2', capabilities: {}, items: [0, 1].map((f) => ({ localFrame: f, html: html(f) })) });
  p.smallPending = [];
  const local = { clipId: 'c2', snapshotKey: lkey, tier: 'local', capabilities: {}, count: 2, sampling: { firstFrame: 0 }, end: 2, appearance: { width: 1920, height: 1080 } };
  await p.renderSceneSnapshotRange({ ...entry, cardPlan: [local] }, local, { from: 0, to: 1 });
  assert.deepEqual(drawn.sort((a, b) => a - b), [0, 1]);
  p.pushQueue = null;
});
