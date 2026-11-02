/**
 * Frame-by-frame bitmaps dedicated for export (`server/export-frames.mjs`,
 * `server/render-node/export-plan.mjs`; visuals of cards not executed on this page during online
 * browser export).
 * Run: node --test server/test/export-frames.test.mjs
 *
 *   EF-01 Keys: export bitmap content key derived from stream content key, differs from it;
 *     identical input yields identical key
 *   EF-02 PNG: PNG encoded from raw pixels decodes back byte-for-byte identical; accepts both
 *     shapes passed by frame capture hook
 *   EF-03 Slicing: export-only plan only slices export bitmap tasks: adopts stream task type and
 *     range, with `exportFrames`, without `contentKey` (does not take fingerprint lock),
 *     result key = export key × own fingerprint, ranked first; queue inbound validation accepts
 *     as-is; without `exportStreams`, slicing identical to original
 *   EF-04 Manifest plan coverage: prerender set for export-only plan is empty, does not slice track
 *     streams; when executor provides no `exportStreamsFor`, records all as cannot produce
 *   EF-05 Index: lists only streams whose tasks were all published successfully; incomplete or
 *     node-rejected ones go to `unsupported`
 *   EF-06 Artifact store: frames persisted locally → manifest → push `px` → write to content store
 *     → delete local frames; missing frames not considered complete; if manifest and chunks exist,
 *     directly considered existing
 *   EF-07 Node-side recognition: export bitmap task is not a sparse stream task, not treated as a
 *     stream requiring full-density segmentation
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectExportResult, createExportFramesSink, exportFramesKey, exportResultComplete, exportSpecOf, exportStreamOf, exportTaskFrames,
  rgbaToPng, shotToPng, storeExportFrame, exportFramesDir, EXPORT_FRAMES_KIND, sweepExpiredExportFrames, releaseExportFrames, EXPORT_FRAMES_TTL_MS } from '../export-frames.mjs';
import { exportIndexOf, isExportFramesTask, isExportOnlyPlan, EXPORT_FRAMES_PRIORITY } from '../render-node/export-plan.mjs';
import { splitPlan, SPARSE_STREAM_PRIORITY } from '../render-node/split.mjs';
import { listPlanOverrides } from '../render-node/local-node.mjs';
import { checkClaimable } from '../render-node/filter.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { parseInbound, lockKeyOf, isSparseStreamTask, clipsPlanTaskOf, backfillSig, CLIPS_KEY_MARK } from '../render-queue/messages.mjs';
import { decodePngRgba } from '../bakery/capture-canvas.mjs';
import { wantsDenseStream } from '../artifact-transfer.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const FP = 'a'.repeat(16);
const STREAM_KEY = sha256('stream-content');

/** Shape of an item in `planStreams` (only with fields used here) */
const specOf = (over = {}) => ({
  streamKey: resultKeyOf(STREAM_KEY, FP), contentKey: STREAM_KEY, envFingerprint: FP, kind: 'card', plane: 'local', clipIds: ['c1'], topClipId: 'c1',
  offset: { x: 320, y: 180 }, bound: { x: -32, y: -32, w: 704, h: 424 }, fps: 30, originFrame: 12, lastFrame: 143, firstSegment: 0, lastSegment: 8, mountFrame: 12, ...over,
});
const planTask = { id: 'plan:p1@7#clips:abc', kind: 'plan', resultKey: 'p1@7#clips:abc', source: { projectId: 'p1', projectRev: 7 }, input: { clips: ['c1'], exportOnly: true } };

test('EF-01 the content key of an export bitmap is derived from the stream\'s content key', () => {
  const key = exportFramesKey(STREAM_KEY);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(key, STREAM_KEY);
  assert.equal(exportFramesKey(STREAM_KEY), key);
  assert.notEqual(exportFramesKey(sha256('other')), key);
  const spec = exportSpecOf(specOf(), FP);
  assert.equal(spec.exportKey, key);
  assert.equal(spec.exportResultKey, resultKeyOf(key, FP), 'the result key uses the same formula as the resultKeyOf used for splitting');
  assert.equal(exportSpecOf(specOf({ kind: 'group', clipIds: ['c1', 'c2'] }), FP), null, 'a group stream produces no export bitmap');
  assert.equal(exportSpecOf(specOf(), ''), null, 'nothing is produced without an environment fingerprint');
  assert.equal(exportSpecOf(specOf({ kind: 'below', plane: 'stage', belowClipIds: ['v0'] }), FP).kind, 'below', 'a stream that depends on the layers below is produced with its shape unchanged');
});

test('EF-02 raw pixels are encoded as PNG and decode back identically', () => {
  const w = 5, h = 3;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + 11) & 0xff;
  const png = rgbaToPng(rgba, w, h);
  const back = decodePngRgba(png);
  assert.equal(back.width, w);
  assert.equal(back.height, h);
  assert.deepEqual(Buffer.from(back.data ?? back.rgba), rgba);
  assert.deepEqual(shotToPng({ rgba, width: w, height: h }), png);
  assert.equal(shotToPng(png), png, 'PNG unchanged');
  assert.throws(() => rgbaToPng(rgba, w, h + 1));
  assert.throws(() => shotToPng(null));
});

test('EF-03 an export-only plan splits out only export bitmap tasks', () => {
  const spec = exportSpecOf(specOf(), FP);
  const base = { planTask, entryKey: 'e1', cardPlan: [{ clipId: 'c1', cardId: 'user-x', snapshotKey: 'sk', contentKey: 'ck', count: 132, tier: 'shared', capabilities: { compositing: 'independent' } }],
    prerenderSet: new Set(), streams: [], envFingerprint: FP, codeVersion: 'cv1', cardSourceVersions: { 'user-x': 'v1' } };
  const tasks = splitPlan({ ...base, exportStreams: [exportStreamOf(spec)] });
  // Segments 0..8, 8 segments per task → two tasks
  assert.equal(tasks.length, 2);
  const [a, b] = tasks;
  assert.equal(a.kind, 'stream');
  assert.equal(a.resultKey, spec.exportResultKey);
  assert.deepEqual(a.range, { unit: 'segment', from: 0, to: 7 });
  assert.deepEqual(b.range, { unit: 'segment', from: 8, to: 8 });
  assert.equal(a.id, `stream:${spec.exportResultKey}:0-7`);
  assert.equal(a.input.exportFrames, true);
  assert.equal(a.input.exportKey, spec.exportKey);
  assert.equal(a.input.contentKey, undefined, 'no content key: does not hold a per-card fingerprint lock');
  assert.equal(lockKeyOf(a), null);
  assert.deepEqual(a.input.stream, { clipId: 'c1', kind: 'card', plane: 'local', fps: 30, originFrame: 12, lastFrame: 143, rect: spec.bound, offset: spec.offset });
  assert.equal(a.requires.envFingerprint, FP);
  assert.equal(a.requires.transcode, false, 'does not require transcoding on this machine');
  assert.equal(a.requires.capabilities, undefined, 'does not require the ability to produce streams: capturing a bitmap needs no encoder');
  // Who can claim: standalone render hosts without --streams (cannot transcode, do not report being
  // able to produce streams) can; pure browser nodes cannot (they only accept browser-shaped stream
  // tasks with input.bake)
  const node = over => ({ nodeId: 'n1', userId: 'u1', envFingerprint: FP, codeVersions: ['cv1'], cardSourceVersions: { 'user-x': ['v1'] }, ...over });
  const mine = { ...a, source: { ...a.source, userId: 'u1' } };
  assert.equal(checkClaimable(mine, node({ profile: 'host', capabilities: { userCards: true, graphCards: false, transcode: false, streams: false } })).ok, true);
  assert.equal(checkClaimable(mine, node({ profile: 'pc', capabilities: { transcode: true, streams: true } })).ok, true);
  assert.deepEqual(checkClaimable({ ...mine, weight: { class: 'medium' } }, node({ profile: 'browser', capabilities: { streams: true, userCards: true } })), { ok: false, rule: 7, reason: 'no-bake-input' });
  assert.equal(checkClaimable(mine, node({ profile: 'browser', capabilities: { streams: true, userCards: true } })).ok, false);
  assert.equal(checkClaimable(mine, node({ profile: 'host', capabilities: {}, cardSourceVersions: {} })).ok, false, 'a node that does not hold this card\'s code does not claim it');
  assert.deepEqual(a.requires.cardSources, { 'user-x': 'v1' });
  assert.equal(a.priority, EXPORT_FRAMES_PRIORITY);
  assert.ok(EXPORT_FRAMES_PRIORITY > 50 && EXPORT_FRAMES_PRIORITY > SPARSE_STREAM_PRIORITY, 'ranks ahead of anchor frame and sparse stream tasks');
  assert.equal(a.weight.frames, 120);
  assert.equal(b.weight.frames, 12, 'the last segment uses the actual frame count');
  assert.equal(a.source.derivedFrom, planTask.id);
  assert.ok(isExportFramesTask(a));
  // Queue inbound validation accepts it as is (queue needs no changes)
  const parsed = parseInbound({ type: 'task.publish', tasks });
  assert.equal(parsed.ok, true, parsed.detail);
  assert.equal(parsed.body.tasks[0].input.exportFrames, true);
  assert.deepEqual(parsed.body.tasks[0].input.stream, a.input.stream);
  // Without exportStreams: not a single extra task
  assert.deepEqual(splitPlan(base), []);
  // The below-dependent kind: render the whole scene, classify as heavy
  const below = exportSpecOf(specOf({ kind: 'below', plane: 'stage', belowClipIds: ['v0'], offset: { x: 0, y: 0 }, bound: { x: 0, y: 0, w: 1280, h: 720 } }), FP);
  const belowTasks = splitPlan({ ...base, exportStreams: [exportStreamOf(below)] });
  assert.equal(belowTasks[0].requires.belowDependent, true);
  assert.equal(belowTasks[0].weight.class, 'heavy');
  assert.equal(belowTasks[0].input.stream.plane, 'stage');
});

test('EF-04 overrides of the manifest plan: export-only plan', () => {
  const page = { ...clipsPlanTaskOf({ projectId: 'p1', projectRev: 7, clips: ['c1', 'c2'] }) };
  const resultKey = `p1@7${CLIPS_KEY_MARK}${backfillSig(['c1', 'c2'], 'export=1')}`;
  const task = { ...page, id: `plan:${resultKey}`, resultKey, input: { clips: ['c1', 'c2'], exportOnly: true } };
  const parsed = parseInbound({ type: 'task.publish', tasks: [task] });
  assert.equal(parsed.ok, true, parsed.detail);
  assert.equal(parsed.body.tasks[0].input.exportOnly, true, 'the queue keeps this field unchanged');
  assert.ok(isExportOnlyPlan(parsed.body.tasks[0]));
  assert.equal(isExportOnlyPlan(page), false);
  let asked = null;
  const spec = exportStreamOf(exportSpecOf(specOf(), FP));
  const over = listPlanOverrides(task, {
    browserStreamsFor: () => { throw new Error('an export-only plan must not split track streams'); },
    exportStreamsFor: clips => { asked = [...clips].sort(); return { streams: [spec], unsupported: [{ clipId: 'c2', reason: 'no-card' }] }; },
  });
  assert.deepEqual(asked, ['c1', 'c2']);
  assert.equal(over.prerenderSet.size, 0, 'no snapshots are split out');
  assert.deepEqual(over.streams, []);
  assert.deepEqual(over.exportStreams, [spec]);
  assert.deepEqual(over.exportUnsupported, [{ clipId: 'c2', reason: 'no-card' }]);
  const old = listPlanOverrides(task, {});
  assert.deepEqual(old.exportStreams, []);
  assert.deepEqual(old.exportUnsupported, [{ clipId: 'c1', reason: 'no-executor' }, { clipId: 'c2', reason: 'no-executor' }]);
  // Usual manifest plans are unaffected: without those two export items
  const normal = listPlanOverrides(page, {});
  assert.equal(normal.exportStreams, undefined);
  assert.deepEqual([...normal.prerenderSet].sort(), ['c1', 'c2']);
});

test('EF-05 the index returned to the page when the plan completes', () => {
  const s1 = exportStreamOf(exportSpecOf({ ...specOf(), inputSig: 's1-abc' }, FP));
  const s2 = exportStreamOf(exportSpecOf(specOf({ clipIds: ['c2'], topClipId: 'c2', contentKey: sha256('other') }), FP));
  const base = { planTask, entryKey: 'e1', cardPlan: [], prerenderSet: new Set(), streams: [], envFingerprint: FP, codeVersion: 'cv1' };
  const tasks = splitPlan({ ...base, exportStreams: [s1, s2] });
  // The second task for c2 failed to send
  const published = tasks.filter(t => !(t.input.clipId === 'c2' && t.range.from === 8));
  const index = exportIndexOf({ exportStreams: [s1, s2], exportUnsupported: [{ clipId: 'c3', reason: 'no-card' }], published, projectRev: 9, segmentsPerTask: 8 });
  assert.equal(index.projectRev, 9);
  assert.equal(index.streams.length, 1);
  const { tasks: indexTasks, ...row } = index.streams[0];
  assert.equal(indexTasks.length, 2, 'each stream\'s tasks are carried as one unchanged copy');
  assert.deepEqual(row, { clipId: 'c1', kind: 'card', plane: 'local', resultKey: resultKeyOf(s1.exportKey, FP), envFingerprint: FP,
    originFrame: 12, lastFrame: 143, lastSegment: 8, segmentsPerTask: 8, fps: 30, rect: s1.rect, offset: s1.offset, inputSig: 's1-abc' });
  assert.deepEqual(index.unsupported, [{ clipId: 'c3', reason: 'no-card' }, { clipId: 'c2', reason: 'publish-failed' }]);
});

test('EF-06 artifact store: frames on disk → manifest → push px → write to the content store → delete the local frames', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-export-frames-'));
  try {
    const spec = exportSpecOf(specOf({ originFrame: 12, lastFrame: 20, lastSegment: 0 }), FP);
    const [task] = splitPlan({ planTask, entryKey: 'e1', cardPlan: [], prerenderSet: new Set(), streams: [], envFingerprint: FP, codeVersion: 'cv1', exportStreams: [exportStreamOf(spec)] });
    assert.deepEqual(exportTaskFrames(task), [12, 20]);
    const ref = { resultKey: task.resultKey, kind: task.kind, tier: null, range: task.range, input: task.input, requires: task.requires };
    const stored = new Map(), manifests = new Map();
    const client = {
      async has(ns, hash) { return stored.has(`${ns}/${hash}`); },
      async put(ns, bytes, { ext }) { const hash = sha256(bytes); const fresh = !stored.has(`${ns}/${hash}`); stored.set(`${ns}/${hash}`, { bytes, ext }); return { hash, uploaded: fresh }; },
    };
    const content = {
      async get(kind, key) { const body = manifests.get(`${kind}|${key}`); return body ? { body } : null; },
      async put(kind, key, body) { manifests.set(`${kind}|${key}`, structuredClone(body)); },
    };
    const sink = createExportFramesSink({ root, client, content });
    assert.equal(await sink.has(ref), false, 'the content store does not have the manifest yet');
    // Only some frames were written: not considered complete, nothing is written
    const png = n => rgbaToPng(Buffer.from([n, n, n, 255]), 1, 1);
    for (let f = 12; f <= 18; f++) await storeExportFrame(root, task.resultKey, f, png(f));
    const partial = await sink.put(ref);
    assert.equal(partial.complete, false);
    assert.equal(partial.reason, 'range-missing');
    assert.equal(manifests.size, 0);
    // Fill in: frames 19 and 20 are the same image as frame 18 (static picture) → the same chunk
    await storeExportFrame(root, task.resultKey, 19, png(18));
    await storeExportFrame(root, task.resultKey, 20, png(18));
    const { result } = await collectExportResult(root, ref);
    assert.equal(result.kind, EXPORT_FRAMES_KIND);
    assert.equal(result.frames.length, 9);
    assert.deepEqual(result.header, { kind: 'card', plane: 'local', clipIds: ['c1'], fps: 30, originFrame: 12, lastFrame: 20, rect: spec.bound, offset: spec.offset });
    assert.ok(exportResultComplete(result, ref));
    const done = await sink.put(ref);
    assert.equal(done.complete, true);
    assert.equal(done.stats.blocks, 7, 'identical frames are pushed as only one chunk');
    assert.equal(stored.size, 7);
    assert.ok([...stored.keys()].every(k => k.startsWith('px/')));
    assert.ok([...stored.values()].every(v => v.ext === 'png'));
    const body = manifests.get(`render-manifest|${task.resultKey}:0-0`);
    assert.deepEqual(body.frames.map(f => f[0]), [12, 13, 14, 15, 16, 17, 18, 19, 20]);
    assert.equal(body.frames[6][1], body.frames[8][1]);
    // Used only for this export: not kept on this machine
    await assert.rejects(fs.stat(exportFramesDir(root, task.resultKey)));
    // Resent plan: manifest present, chunks present → treat directly as already present,
    // return that manifest
    assert.equal(await sink.has(ref), true);
    assert.deepEqual(await sink.resultFor(ref), body);
    // Missing a chunk on the asset service: not considered already present
    stored.delete([...stored.keys()][0]);
    assert.equal(await sink.has(ref), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('EF-07 an export bitmap task is not treated as a sparse stream task, nor as a stream that needs full-density segments', () => {
  const spec = exportSpecOf(specOf(), FP);
  const [task] = splitPlan({ planTask, entryKey: 'e1', cardPlan: [], prerenderSet: new Set(), streams: [], envFingerprint: FP, codeVersion: 'cv1', sparseStreams: true, exportStreams: [exportStreamOf(spec)] });
  assert.equal(isSparseStreamTask(task), false);
  assert.equal(task.input.density, undefined, 'no sparse part');
  // The artifact sink branches off first by `isExportFramesTask`, never reaching the stream rules
  // to check full density
  assert.equal(isExportFramesTask(task), true);
  assert.equal(wantsDenseStream(task), true, 'its kind is still stream task (the queue and node filtering handle it as a stream task)');
});

test('EF-08 expiry cleanup and explicit release: a 24-hour TTL cleans up expired bitmaps and manifests, and leaves them untouched within the retention period', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-export-sweep-'));
  try {
    const expiredKey = '1'.repeat(64);
    const freshKey = '2'.repeat(64);
    const now = Date.now();

    // Construct expired bitmap files (mtime 25 hours ago) and unexpired files (mtime now)
    const expiredDir = exportFramesDir(root, expiredKey);
    const freshDir = exportFramesDir(root, freshKey);
    await fs.mkdir(expiredDir, { recursive: true });
    await fs.mkdir(freshDir, { recursive: true });
    await fs.writeFile(path.join(expiredDir, '1.png'), Buffer.from('png-old'));
    await fs.writeFile(path.join(freshDir, '2.png'), Buffer.from('png-fresh'));

    const oldTime = (now - EXPORT_FRAMES_TTL_MS - 3600_000) / 1000;
    await fs.utimes(expiredDir, oldTime, oldTime);

    const manifests = new Map();
    manifests.set(`render-manifest|${expiredKey}:0-0`, {
      body: { kind: EXPORT_FRAMES_KIND, createdAt: now - EXPORT_FRAMES_TTL_MS - 3600_000, frames: [[1, 'hash-old', 10]] },
    });
    manifests.set(`render-manifest|${freshKey}:0-0`, {
      body: { kind: EXPORT_FRAMES_KIND, createdAt: now - 1000, frames: [[2, 'hash-fresh', 10]] },
    });
    const droppedBlocks = [];
    const content = {
      async list(kind, prefix) {
        const items = [];
        for (const k of manifests.keys()) {
          const [mKind, mKey] = k.split('|');
          if (mKind === kind && (!prefix || mKey.startsWith(prefix))) items.push({ key: mKey });
        }
        return { items };
      },
      async get(kind, key) { return manifests.get(`${kind}|${key}`) ?? null; },
      async del(kind, key) { manifests.delete(`${kind}|${key}`); },
    };
    const client = {
      async drop(ns, hash) { droppedBlocks.push(`${ns}/${hash}`); },
    };

    // Run cleanup
    const stats = await sweepExpiredExportFrames(root, { maxAgeMs: EXPORT_FRAMES_TTL_MS, now, content, client });
    assert.equal(stats.cleanedDirs, 1, 'cleaned up 1 expired local directory');
    assert.equal(stats.cleanedFrames, 1, 'cleaned up 1 local frame file');
    assert.equal(stats.cleanedManifests, 1, 'cleaned up 1 expired manifest');
    assert.deepEqual(droppedBlocks, ['px/hash-old'], 'the client was notified to release the expired chunks');

    // Check that expired directories have been deleted, and unexpired directories remain
    await assert.rejects(fs.stat(expiredDir));
    const freshStat = await fs.stat(freshDir);
    assert.ok(freshStat.isDirectory());
    assert.ok(manifests.has(`render-manifest|${freshKey}:0-0`));

    // Explicitly release unexpired result keys
    await releaseExportFrames(root, freshKey, { content, client });
    await assert.rejects(fs.stat(freshDir));
    assert.equal(manifests.has(`render-manifest|${freshKey}:0-0`), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

