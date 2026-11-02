/**
 * Track streams produced by browser nodes: manifest shape is field-by-field isomorphic with
 * desktop, and desktop can pull them back and adopt them (`docs/plan/browser-stream-task.md`
 * section 4).
 *
 *   BM-01  Manifest shape: `streamManifest` (`src/online/browserNode.ts`) is field-by-field
 *          isomorphic with desktop `collectStreamResult`; passes `manifestMatches`, `streamAdoption`
 *   BM-02  Desktop pulls back: `applyResult` pulls chunks from the asset service according to the
 *          browser manifest and puts them into the stream store via `adoptSegments`; recognizes
 *          both encoder name `webcodecs-avc` and `sig: null`; bytes written to disk are
 *          byte-for-byte identical to those pushed by the browser; pulling again skips all
 *   BM-03  Byte level: for head files and segments packaged by the browser, server-side `initInfo` /
 *          `segmentInfo` can read the items written in the manifest
 *
 * Run: node --experimental-test-module-mocks --test server/test/browser-stream-manifest.test.mjs
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAssetHarness } from './fake-asset-service.mjs';

const refuse = (name) => () => { throw new Error(`Unit test does not render (${name})`); };
mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: { openBakery: async () => refuse('openBakery')(), findFfmpeg: async () => refuse('findFfmpeg')(), streamPngVideo: refuse('streamPngVideo'), bakeFrames: async () => refuse('bakeFrames')() },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { initInfo, segmentInfo, streamAdoption } = await import('../frame-stream.mjs');
const { collectStreamResult, manifestMatches, manifestKeyOf, manifestKindOf, applyResult, pushResult, RESULT_VERSION, PX_NS } = await import('../artifact-transfer.mjs');
const { createAssetClient } = await import('../asset-store/client.mjs');
const { resultKeyOf } = await import('../render-node/fingerprint.mjs');
const F = await import('./fake-artifact-fixtures.mjs');
const { streamManifest, streamManifestCovers, streamManifestBlocks, streamTaskFrames, BROWSER_STREAM_ENCODER, STREAM_SEGMENT_FRAMES,
  alphaBoxOf, mergeStreamManifest, streamTaskStride, isSparseStreamTask } = await import('../../src/online/browserNode.ts');
const { mergeStreamResult } = await import('../artifact-transfer.mjs');
const { rgbaAlphaBox } = await import('../bakery/capture-canvas.mjs');
const { buildStreamInit, buildStreamSegment, codecOfAvcC } = await import('../../src/render/streamMux.ts');
const { packedSize } = await import('../../src/render/streamEncode.ts');

const harness = createAssetHarness();
after(() => harness.cleanup());

const BROWSER_FP = '2222222222222222';
const CONTENT_KEY = F.sha256('browser-stream-content');
const RESULT_KEY = resultKeyOf(CONTENT_KEY, BROWSER_FP);
const BOUND = { x: -32, y: -32, w: 464, h: 304 };
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x03, 0x68, 0xee, 0x3c]);
const sample = (n, fill) => { const d = new Uint8Array(n); d.fill(fill); new DataView(d.buffer).setUint32(0, n - 4); return d; };

/** The stream task copy given to the browser by the splitter (shape of `split.mjs`) */
function browserTask({ from = 3, to = 5, total = 300, lastFrame = 164 } = {}) {
  return {
    id: `stream:${RESULT_KEY}:${from}-${to}`, kind: 'stream', resultKey: RESULT_KEY, range: { unit: 'segment', from, to },
    source: { projectId: 'p1', projectRev: 1, derivedFrom: 'plan:p1@1#clips:x' },
    input: { clipId: 'clip-a', cardId: 'punch-pill', entryKey: null, contentKey: CONTENT_KEY, canvasHeavy: false, compositing: 'independent',
      bake: { start: 1.5, end: 5.5, count: 120, sampling: { firstFrame: 45, phase: { numerator: 0, denominator: 1 } } },
      // Clip spans frames 45~164: segments count from frame 45 (0~7), task range 3~5 spans frames 90~134
      stream: { kind: 'card', plane: 'local', clipIds: ['clip-a'], fps: 30, bound: BOUND, offset: { x: 760, y: 420 }, firstFrame: 45, count: 120, total, originFrame: 45, lastFrame } },
    weight: { class: 'medium', estMs: null, frames: (to - from + 1) * 15 },
    requires: { envFingerprint: BROWSER_FP, codeVersion: 'c', cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false, capabilities: { streams: true } },
    priority: 10,
  };
}

/**
 * Follow host `bakeStream`: package head file and each segment, compute hashes, register (no real
 * frames encoded here, samples are padding bytes)
 */
function browserParts(task) {
  const plan = streamTaskFrames(task);
  const size = packedSize(BOUND.w, BOUND.h);
  const init = Buffer.from(buildStreamInit({ width: size.width, height: size.height, fps: 30, avcC: AVCC }));
  const initHash = F.sha256(init);
  const initId = initHash.slice(0, 16);
  const blobs = new Map([[initHash, init]]);
  const inits = { [initId]: { hash: initHash, bytes: init.length, codec: codecOfAvcC(AVCC), width: size.width, height: size.height, timescale: 30, rect: { ...BOUND }, encoder: BROWSER_STREAM_ENCODER } };
  const segments = {};
  for (const seg of plan.segments) {
    const samples = seg.frames.map((_, i) => ({ data: sample(40 + seg.index + i, seg.index), isSync: i === 0 }));
    const bytes = Buffer.from(buildStreamSegment({ sequence: seg.index + 1, baseDecodeTime: seg.index * STREAM_SEGMENT_FRAMES, samples }));
    const hash = F.sha256(bytes);
    blobs.set(hash, bytes);
    segments[seg.index] = { hash, bytes: bytes.length, init: initId, stride: 1, samples: samples.length, sig: null, encoder: BROWSER_STREAM_ENCODER };
  }
  return { inits, segments, blobs, init, initId };
}

/**
 * Shape of a value: objects record keys (ascending) and shapes of each key; otherwise only
 * records types other than "is null"
 */
function shapeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return ['array', v.length ? shapeOf(v[0]) : 'empty'];
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, shapeOf(v[k])]));
  return typeof v;
}
const keysOf = v => Object.keys(v).sort();

test('BM-01 manifest shape matches the desktop collectStreamResult field by field; passes manifestMatches and streamAdoption', async (t) => {
  const roots = F.makeRoots(FramePipeline, 'pc-bstream-');
  t.after(() => roots.cleanup());
  // Desktop copy: writes a stream into the stream store (fixture), lists manifest by task range
  const rootA = await roots.root();
  const A = roots.make(rootA, { interactive: true });
  const deskKey = F.sha256('desk-stream');
  await F.writeStreamFixture(rootA, { streamKey: deskKey, segments: [3, 4, 5], lastFrame: 164 });
  const desk = (await collectStreamResult(A, F.streamTask({ streamKey: deskKey, contentKey: 'x', from: 3, to: 5 }))).result;

  const task = browserTask();
  const parts = browserParts(task);
  const mine = streamManifest(task, parts);

  // Top level, header, each head file, each segment: exactly the same keys, none added, none missing
  assert.deepEqual(keysOf(mine), keysOf(desk), 'Top-level keys');
  assert.deepEqual(keysOf(mine.header), keysOf(desk.header), 'header keys');
  assert.deepEqual(keysOf(Object.values(mine.inits)[0]), keysOf(Object.values(desk.inits)[0]), 'Keys of the init file entry');
  assert.deepEqual(keysOf(mine.segments[3]), keysOf(desk.segments[3]), 'Keys of the segment entry');
  assert.deepEqual(keysOf(mine.segments), keysOf(desk.segments), 'Segment numbers');
  // Field types are also identical; desktop has values in only two places where browser writes null
  // per task brief: header.tight (browser does not tighten), segments[].sig (browser does not
  // compute segment signature)
  const a = shapeOf(mine), b = shapeOf(desk);
  assert.equal(a.header.tight, 'null');
  assert.equal(a.segments[3].sig, 'null');
  a.header.tight = b.header.tight;
  for (const n of Object.keys(a.segments)) a.segments[n].sig = b.segments[n].sig;
  // The key for head files is the first 16 characters of the hash; names differ on both sides:
  // compared by value
  assert.deepEqual({ ...a, inits: Object.values(a.inits) }, { ...b, inits: Object.values(b.inits) });

  // Values: per task brief section 4
  assert.equal(mine.v, RESULT_VERSION);
  assert.deepEqual(mine.header, { kind: 'card', plane: 'local', clipIds: ['clip-a'], fps: 30, originFrame: 45, lastFrame: 164, bound: BOUND, offset: { x: 760, y: 420 }, tight: null });
  // Manifest missing the first frame of this stream (produced by a node before segment rules
  // changed): neither side accepts it
  const { originFrame: _dropped, ...oldHeader } = mine.header;
  assert.equal(manifestMatches({ ...mine, header: oldHeader }, { kind: 'stream', resultKey: RESULT_KEY, range: { from: 3, to: 5 } }), false);
  assert.throws(() => streamAdoption({ ...mine, header: oldHeader }), /originFrame/);
  assert.equal(streamManifestCovers({ ...mine, header: oldHeader }, task), false);
  const [initId] = Object.keys(mine.inits);
  assert.equal(initId, mine.inits[initId].hash.slice(0, 16), 'Init file key = first 16 characters of the hash');
  assert.equal(mine.inits[initId].encoder, 'webcodecs-avc');
  assert.deepEqual(mine.inits[initId].rect, BOUND, 'rect always uses bound');
  for (const n of [3, 4, 5]) assert.deepEqual({ ...mine.segments[n], hash: 'h', bytes: 0 }, { hash: 'h', bytes: 0, init: initId, stride: 1, samples: 15, sig: null, encoder: 'webcodecs-avc' });

  const ref = { kind: 'stream', resultKey: RESULT_KEY, range: { from: 3, to: 5 } };
  assert.equal(manifestMatches(mine, ref), true, 'The desktop manifestMatches accepts it');
  assert.equal(manifestMatches(mine, { ...ref, range: { from: 3, to: 6 } }), false);
  assert.equal(manifestKeyOf(mine), `${RESULT_KEY}:3-5`, 'Content store key <result key>:<from>-<to>');
  assert.equal(manifestKindOf(mine.kind), 'render-manifest');
  const adoption = streamAdoption(mine);
  assert.deepEqual(adoption.segments.map(([n]) => n), [3, 4, 5]);
  assert.equal(adoption.key, RESULT_KEY);

  // Deduplication predicate and chunks to check
  assert.equal(streamManifestCovers(mine, task), true);
  assert.equal(streamManifestCovers(mine, browserTask({ from: 3, to: 6 })), false, 'Different range');
  assert.equal(streamManifestCovers({ ...mine, segments: { 3: mine.segments[3], 4: mine.segments[4] } }, task), false, 'One segment missing');
  assert.equal(streamManifestCovers({ ...mine, inits: {} }, task), false, 'Init file missing');
  assert.equal(streamManifestCovers(desk, { resultKey: deskKey, range: { from: 3, to: 5 } }), true, 'A manifest produced by the desktop is accepted too (dedup does not care who produced it)');
  assert.deepEqual(streamManifestBlocks(mine).map(x => x.ns), ['px', 'px', 'px', 'px'], 'The init file and the three segments are all in the pixel category');

  // Only list those within the task range; when only partially pushed after yielding, missing ones
  // are not listed (do not fabricate)
  const partial = streamManifest(task, { inits: parts.inits, segments: { 3: parts.segments[3], 9: parts.segments[4] } });
  assert.deepEqual(Object.keys(partial.segments), ['3']);
  assert.equal(streamManifestCovers(partial, task), false);
  assert.throws(() => streamManifest({ ...task, input: { ...task.input, stream: undefined } }, parts), /input\.stream/);
});

test('BM-02 the desktop pulls back the stream produced by the browser and adopts it: applyResult → adoptSegments, bytes are identical byte for byte; pulling again skips everything', async (t) => {
  const roots = F.makeRoots(FramePipeline, 'pc-bstream-');
  t.after(() => roots.cleanup());
  const svc = await F.startServices(harness, base => createAssetClient({ base }));
  t.after(() => svc.cleanup());
  const task = browserTask();
  const parts = browserParts(task);
  const manifest = streamManifest(task, parts);
  // Browser side: chunks are pushed to the asset service's pixel category (the page uses an
  // uploader; here the same manifest goes through server-side pushResult, pushing the same chunks)
  const pushed = await pushResult(svc.client, manifest, async hash => parts.blobs.get(hash));
  assert.equal(pushed.uploaded, 4);
  for (const { ns, hash } of streamManifestBlocks(manifest)) assert.equal(await svc.client.has(ns, hash), true, `${ns}/${hash.slice(0, 8)} is on the asset service`);
  assert.equal(PX_NS, 'px');

  // Desktop side: receives the manifest carried by task.done, pulls and adopts it
  const rootB = await roots.root();
  const B = roots.make(rootB, { interactive: true });
  const producer = F.producerOf(B, 'libx264');   // Desktop's own encoder has a different name: pulled segments do not recompute signatures with it
  const applied = await applyResult(B, svc.client, { ...manifest });
  assert.deepEqual({ written: applied.written, skipped: applied.skipped, fetched: applied.fetched }, { written: 3, skipped: 0, fetched: 4 });

  const dir = path.join(rootB, 'streams', RESULT_KEY);
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'stream.json'), 'utf8'));
  assert.equal(onDisk.streamKey, RESULT_KEY);
  assert.deepEqual([onDisk.kind, onDisk.plane, onDisk.clipIds, onDisk.fps, onDisk.bound], ['card', 'local', ['clip-a'], 30, BOUND]);
  assert.equal(onDisk.inits[parts.initId].encoder, 'webcodecs-avc');
  assert.equal(onDisk.inits[parts.initId].adopted, true);
  assert.ok((await fs.readFile(path.join(dir, `init-${parts.initId}.mp4`))).equals(parts.init), 'Init file is byte-for-byte identical');
  for (const n of [3, 4, 5]) {
    const seg = onDisk.segments[n];
    assert.deepEqual([seg.adopted, seg.stride, seg.samples, seg.sig, seg.encoder, seg.init], [true, 1, 15, null, 'webcodecs-avc', parts.initId], `Entry of segment ${n}`);
    assert.ok((await fs.readFile(path.join(dir, seg.file))).equals(parts.blobs.get(parts.segments[n].hash)), `Segment ${n} is byte-for-byte identical`);
  }
  // After adoption it is "full density, not stale": desktop will not classify it as stale and
  // re-produce it
  const state = producer.streams.get(RESULT_KEY);
  assert.ok(state, 'The producer holds this stream');
  for (const n of [3, 4, 5]) assert.equal(producer.segmentState(state, n), 'dense', `segment ${n}`);
  assert.deepEqual(F.staged(B, 'stream', RESULT_KEY)?.ranges, [[3, 5]], 'The ready index attaches this range under the key');
  // Desktop lists it as a manifest again (for pushing out and deduplication): hash matches
  // browser's manifest, encoder name included
  const again = (await collectStreamResult(B, task)).result;
  assert.deepEqual(Object.fromEntries(Object.entries(again.segments).map(([n, s]) => [n, [s.hash, s.encoder, s.stride, s.samples]])),
    Object.fromEntries(Object.entries(manifest.segments).map(([n, s]) => [n, [s.hash, s.encoder, s.stride, s.samples]])));
  assert.equal(again.inits[parts.initId].hash, manifest.inits[parts.initId].hash);
  // Pull again: already exists locally, skip all, do not download
  const second = await applyResult(B, svc.client, { ...manifest });
  assert.deepEqual({ written: second.written, skipped: second.skipped, fetched: second.fetched }, { written: 0, skipped: 3, fetched: 0 });
});

test('BM-03 from the bytes the browser muxed, the server can read the items written in the manifest (codec string, stitched width and height, timescale, samples per segment, and the keyframe at the start of each segment)', () => {
  // The last frame of this stream is frame 154: segment 7 (starting at frame 150) is not full,
  // having only frames 150~154 (5 frames total)
  const task = browserTask({ from: 7, to: 7, lastFrame: 154 });
  const parts = browserParts(task);
  const meta = parts.inits[parts.initId];
  const info = initInfo(parts.init);
  assert.deepEqual(info, { codec: meta.codec, width: meta.width, height: meta.height, timescale: meta.timescale });
  assert.deepEqual([info.width, info.height], [464, 2 * 304 + 16], 'Stitched frame: width unchanged, height = 2H + 16');
  const seg = parts.segments[7];
  assert.equal(seg.samples, 5);
  assert.deepEqual(segmentInfo(parts.blobs.get(seg.hash)), { moofs: 1, sampleCount: 5, firstSampleIsSync: true });
});

test('BM-04 sparse stream task: how many frames pass between captures is set by the task\'s density; the manifest\'s segments carry a position rect; a full-density task does not accept a sparse-version manifest; merging does not downgrade and gives the same result as the desktop mergeStreamResult', () => {
  const h = c => c.repeat(64);
  const input = { stream: { kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, bound: { x: -8, y: -8, w: 64, h: 48 }, offset: { x: 10, y: 20 }, firstFrame: 30, count: 60, total: 300, originFrame: 30, lastFrame: 89 } };
  const dense = { kind: 'stream', resultKey: h('a'), range: { unit: 'segment', from: 0, to: 3 }, input };
  const sparse = { ...dense, input: { ...input, density: 'sparse' } };
  assert.equal(isSparseStreamTask(sparse), true);
  assert.equal(isSparseStreamTask(dense), false);
  assert.equal(isSparseStreamTask({ ...sparse, kind: 'snapshot' }), false);
  assert.equal(streamTaskStride(sparse), STREAM_SEGMENT_FRAMES, 'Sparse stream task: only one capture per segment');
  assert.equal(streamTaskStride(dense), 1);

  const inits = { i1: { hash: h('1'), bytes: 10, codec: 'avc1.640020', width: 64, height: 96, timescale: 30, rect: { x: -8, y: -8, w: 64, h: 48 }, encoder: BROWSER_STREAM_ENCODER } };
  const seg = (c, stride, box) => ({ hash: h(c), bytes: 5, init: 'i1', stride, samples: 15, sig: null, encoder: BROWSER_STREAM_ENCODER, ...(box !== undefined ? { box } : {}) });
  const sparseParts = { inits, segments: { 0: seg('b', 15, { x: 2, y: 3, w: 20, h: 10 }), 1: seg('c', 15, null), 2: seg('d', 15, { x: 0, y: 0, w: 4, h: 4 }), 3: seg('e', 15) } };
  const sparseManifest = streamManifest(sparse, sparseParts);
  assert.deepEqual(sparseManifest.segments[0].box, { x: 2, y: 3, w: 20, h: 10 }, 'The position rect goes into the manifest (plane coordinates)');
  assert.equal(sparseManifest.segments[1].box, null, 'The fully transparent capture is recorded as null');
  assert.equal('box' in sparseManifest.segments[3], false, 'Segments that were not measured do not carry this field');
  assert.equal(sparseManifest.segments[0].stride, 15);
  // Manifest of sparse version: recognized by sparse stream tasks, not recognized by full density
  // tasks
  assert.equal(streamManifestCovers(sparseManifest, sparse), true);
  assert.equal(streamManifestCovers(sparseManifest, dense), true, 'When density is not required, it still only checks whether the segments are present');
  assert.equal(streamManifestCovers(sparseManifest, dense, { dense: true }), false);

  const denseParts = { inits, segments: { 0: seg('f', 1), 1: seg('0', 1), 2: seg('2', 1), 3: seg('3', 1) } };
  const denseManifest = streamManifest(dense, denseParts);
  assert.equal(streamManifestCovers(denseManifest, dense, { dense: true }), true);
  // Merge: existing full density, new sparse → keep existing; existing sparse, new full density →
  // use new; segments not in the new manifest are retained
  assert.deepEqual(mergeStreamManifest(denseManifest, sparseManifest).segments, denseManifest.segments);
  // Existing sparse, new full density: use new segments, bring over position rectangles measured in
  // the sparse pass (segments not measured are not brought over)
  const upgraded = mergeStreamManifest(sparseManifest, denseManifest);
  assert.deepEqual(Object.values(upgraded.segments).map((x) => [x.hash, x.stride]), Object.values(denseManifest.segments).map((x) => [x.hash, x.stride]));
  assert.deepEqual([upgraded.segments[0].box, upgraded.segments[1].box, 'box' in upgraded.segments[3]], [{ x: 2, y: 3, w: 20, h: 10 }, null, false]);
  assert.deepEqual(mergeStreamResult(sparseManifest, denseManifest), upgraded);
  assert.equal(mergeStreamManifest(denseManifest, denseManifest), denseManifest, 'Nothing to keep: return the new one as is');
  const partial = { ...denseManifest, segments: { 1: denseManifest.segments[1] } };
  const up = mergeStreamManifest(sparseManifest, partial);
  assert.deepEqual(Object.keys(up.segments).sort(), ['0', '1', '2', '3']);
  assert.deepEqual([up.segments[0].stride, up.segments[1].stride, up.segments[2].stride], [15, 1, 15]);
  assert.deepEqual(up.segments[0].box, { x: 2, y: 3, w: 20, h: 10 });
  assert.equal(mergeStreamManifest({ ...denseManifest, resultKey: h('z') }, sparseManifest), sparseManifest);
  assert.equal(mergeStreamManifest(null, sparseManifest), sparseManifest);
  // Produces the same result as desktop merge
  assert.deepEqual(mergeStreamResult(denseManifest, sparseManifest), mergeStreamManifest(denseManifest, sparseManifest));
  assert.deepEqual(mergeStreamResult(sparseManifest, partial), up);
});

test('BM-05 how the position rect is measured: the bounding box of non-transparent pixels (alpha > 0), null when fully transparent; same result as the desktop rgbaAlphaBox', () => {
  const W = 9, H = 7;
  const blank = () => new Uint8ClampedArray(W * H * 4);
  const dot = (data, x, y, a = 255) => { data[(y * W + x) * 4 + 3] = a; };
  assert.equal(alphaBoxOf(blank(), W, H), null);
  const one = blank(); dot(one, 4, 3, 1);
  assert.deepEqual(alphaBoxOf(one, W, H), { x: 4, y: 3, w: 1, h: 1 }, 'An alpha of just 1 counts too');
  const many = blank(); dot(many, 2, 1); dot(many, 7, 5, 9); dot(many, 0, 4, 200);
  assert.deepEqual(alphaBoxOf(many, W, H), { x: 0, y: 1, w: 8, h: 5 });
  const full = blank(); for (let i = 3; i < full.length; i += 4) full[i] = 255;
  assert.deepEqual(alphaBoxOf(full, W, H), { x: 0, y: 0, w: W, h: H });
  for (const data of [one, many]) {
    const desk = rgbaAlphaBox(Buffer.from(data.buffer), W, H);
    assert.deepEqual(alphaBoxOf(data, W, H), { x: desk.x, y: desk.y, w: desk.w, h: desk.h });
  }
});
