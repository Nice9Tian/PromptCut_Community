/**
 * The desktop side of "Check first, produce only if missing" (task brief
 * `docs/plan/render-refactor-task.md` "Jia-2"): single-card streams produced by the online page
 * itself when there is no splitter node are not re-produced by the desktop prerender process that
 * comes online later; it pulls them back to this machine and uses them per their keys.
 *
 *   FSA-01  `relockStreams`: single-card stream content keys in the lock output keys per that
 *           fingerprint; group streams do not swap; as-is when unlocked; `planStreams` reads
 *           the lock on entry
 *   FSA-02  `adoptForeignStreams`: layer table lists another fingerprint, and that fingerprint's
 *           manifest has full density for the entire stream → pull back from asset service to
 *           stream store, record lock, persist to disk; afterward, local stream plan, stream used
 *           for splitting, and layer table candidates all use that fingerprint's key; producer
 *           treats it as a ready-made full-density stream (no re-producing)
 *   FSA-03  Cases not locked: manifest missing one copy, has sparse segments, layer table lacks
 *           a row with the same content key, or this machine already has the entire stream for
 *           its own key
 *   FSA-04  Lock persisted to disk: new pipeline after restart still outputs keys per lock; if
 *           pulled stream is incomplete (cleared), unlocks and reverts to own key
 *   FSA-05  Splitting: outputs only one copy per lock, with both key and fingerprint belonging
 *           to the locking party; when the browser is online, that copy has the browser's shape
 *           (completes upon deduplication); this machine does not output its own copy
 *
 * Run: npm test -- server/test/foreign-stream-adopt.test.mjs
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
const { planStreams, relockStreams, queueStreamOf, STREAM_CODE_VERSION } = await import('../frame-stream.mjs');
const { pushResult, layerMapOf, layerMapKeyOf } = await import('../artifact-transfer.mjs');
const { createAssetClient } = await import('../asset-store/client.mjs');
const { resultKeyOf } = await import('../render-node/fingerprint.mjs');
const { splitPlan } = await import('../render-node/split.mjs');
const F = await import('./fake-artifact-fixtures.mjs');
const { streamManifest, streamTaskFrames, BROWSER_STREAM_ENCODER, STREAM_SEGMENT_FRAMES } = await import('../../src/online/browserNode.ts');
const { buildStreamInit, buildStreamSegment, codecOfAvcC } = await import('../../src/render/streamMux.ts');
const { packedSize } = await import('../../src/render/streamEncode.ts');

const harness = createAssetHarness();
after(() => harness.cleanup());

const BROWSER = '2222222222222222';
const CAPTURE = 'capture-code-for-test';
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x03, 0x68, 0xee, 0x3c]);
const sample = (n, fill) => { const d = new Uint8Array(n); d.fill(fill); new DataView(d.buffer).setUint32(0, n - 4); return d; };

const project = () => ({
  id: 'proj-foreign', width: 1280, height: 720, fps: 30, duration: 6, themeId: 'dark', style: {}, media: [], filters: [], pixelMaps: [], cardNodes: [],
  tracks: [
    { id: 't-a', clips: [{ id: 'clip-a', cardId: 'punch-pill', start: 0, end: 5, params: { text: 'a' }, frame: { x: 100, y: 100, w: 400, h: 240 } }] },
    { id: 't-b', clips: [{ id: 'clip-b', cardId: 'focus-card', start: 1, end: 3, params: {} }] },
  ],
});
const control = (own, clipId, firstFrame, count) => ({
  clipId, key: `key-${clipId}`, snapshotKey: resultKeyOf(`ck-${clipId}`, own), contentKey: `ck-${clipId}`, envFingerprint: own, tier: 'shared', cardId: 'punch-pill',
  frameMode: 'stateful', sampling: { firstFrame }, count, start: firstFrame / 30, end: (firstFrame + count) / 30, capabilities: { compositing: 'independent', frameMode: 'stateful' }, compositing: 'independent',
});
const entryOf = (pipeline) => {
  const own = pipeline.envFingerprint;
  return { key: 'entry-foreign', project: project(), cardPlan: [control(own, 'clip-a', 0, 150), control(own, 'clip-b', 30, 60)], streamLocks: pipeline.streamLocks };
};
const ownSpecs = (pipeline, entry) => planStreams({ ...entry, streamLocks: null }, { budget: Infinity, codeVersion: `${STREAM_CODE_VERSION}:${CAPTURE}`, envFingerprint: pipeline.envFingerprint });

/**
 * The page side: outputs tasks for this stream in the shape of `pageStreamTasks`, packages head
 * file and segments, pushes to asset service, and writes manifest into content store (mock)
 */
function pageProduce(spec, { stride = () => 1 } = {}) {
  const resultKey = resultKeyOf(spec.contentKey, BROWSER);
  const size = packedSize(spec.bound.w, spec.bound.h);
  const init = Buffer.from(buildStreamInit({ width: size.width, height: size.height, fps: 30, avcC: AVCC }));
  const initHash = F.sha256(init), initId = initHash.slice(0, 16);
  const blobs = new Map([[initHash, init]]);
  const manifests = [];
  for (let from = spec.firstSegment; from <= spec.lastSegment; from += 8) {
    const to = Math.min(spec.lastSegment, from + 7);
    const task = { id: `stream:${resultKey}:${from}-${to}`, kind: 'stream', resultKey, range: { unit: 'segment', from, to },
      input: { clipId: spec.topClipId, contentKey: spec.contentKey, stream: { kind: 'card', plane: 'local', clipIds: [spec.topClipId], fps: 30, bound: spec.bound, offset: spec.offset, firstFrame: spec.firstFrame, count: spec.members[0].count, total: spec.total, originFrame: spec.originFrame, lastFrame: spec.lastFrame } } };
    const plan = streamTaskFrames(task);
    const inits = { [initId]: { hash: initHash, bytes: init.length, codec: codecOfAvcC(AVCC), width: size.width, height: size.height, timescale: 30, rect: { ...spec.bound }, encoder: BROWSER_STREAM_ENCODER } };
    const segments = {};
    for (const seg of plan.segments) {
      const samples = seg.frames.map((_, i) => ({ data: sample(40 + seg.index + i, seg.index), isSync: i === 0 }));
      const bytes = Buffer.from(buildStreamSegment({ sequence: seg.index + 1, baseDecodeTime: seg.index * STREAM_SEGMENT_FRAMES, samples }));
      const hash = F.sha256(bytes);
      blobs.set(hash, bytes);
      segments[seg.index] = { hash, bytes: bytes.length, init: initId, stride: stride(seg.index), samples: samples.length, sig: null, encoder: BROWSER_STREAM_ENCODER };
    }
    manifests.push(streamManifest(task, { inits, segments }));
  }
  return { resultKey, manifests, blobs };
}

/** Mock content store: only has `get(kind, key)`; records which keys were fetched */
function fakeContent() {
  const items = new Map();
  const gets = [];
  return { items, gets, put: (kind, key, body) => items.set(`${kind}\u0000${key}`, body),
    get: async (kind, key) => { gets.push(`${kind}:${key}`); const body = items.get(`${kind}\u0000${key}`); return body === undefined ? { missing: true } : { body: structuredClone(body) }; } };
}

/**
 * A scenario: a real pipeline, mock content store, and real (local) asset service; page produces
 * and pushes the clip-a stream, and writes its row into the layer table
 */
async function scene(t, { produce = true, rowFor = null, stride } = {}) {
  const roots = F.makeRoots(FramePipeline, 'pc-foreign-');
  t.after(() => roots.cleanup());
  const svc = await F.startServices(harness, base => createAssetClient({ base }));
  t.after(() => svc.cleanup());
  const root = await roots.root();
  const make = () => {
    const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: F.OWN_ENV, dataRoot: root, interactive: true, captureCode: () => CAPTURE });
    t.after(() => p.close());
    return p;
  };
  const pipeline = make();
  const producer = F.producerOf(pipeline, 'libx264');
  const entry = entryOf(pipeline);
  const specs = ownSpecs(pipeline, entry);
  const a = specs.find(s => s.topClipId === 'clip-a'), b = specs.find(s => s.topClipId === 'clip-b');
  const content = fakeContent();
  let page = null;
  if (produce) {
    page = pageProduce(a, { stride });
    for (const m of page.manifests) {
      await pushResult(svc.client, m, async hash => page.blobs.get(hash));
      content.put('render-manifest', `${m.resultKey}:${m.range.from}-${m.range.to}`, m);
    }
  }
  const row = { topClipId: 'clip-a', clipIds: ['clip-a'], kind: 'card', plane: 'local', contentKey: rowFor ?? a.contentKey,
    candidates: [{ envFingerprint: BROWSER, resultKey: resultKeyOf(rowFor ?? a.contentKey, BROWSER) }], originFrame: a.originFrame, lastSegment: a.lastSegment, segmentsPerTask: 8 };
  content.put('snapshot-manifest', layerMapKeyOf(entry.project.id), { v: 3, kind: 'layer-map', projectId: entry.project.id, layers: [], streams: [row] });
  return { pipeline, producer, entry, specs, a, b, content, client: svc.client, page, root, make };
}

test('FSA-01 relockStreams: a single-card stream is keyed per the lock, a group stream is not swapped, and with no lock it is returned unchanged; planStreams reads the lock on the entry', () => {
  const OWN = '1111111111111111';
  const entry = { key: 'e', project: project(), cardPlan: [control(OWN, 'clip-a', 0, 150), control(OWN, 'clip-b', 30, 60)] };
  const opts = { budget: 6, codeVersion: '1:x', envFingerprint: OWN };
  const plain = planStreams(entry, opts);
  assert.equal(plain.length, 2);
  assert.equal(relockStreams(plain, null), plain, 'no lock: the same array');
  assert.equal(relockStreams(plain, new Map()), plain);
  const a = plain.find(s => s.topClipId === 'clip-a');
  const locks = new Map([[a.contentKey, BROWSER]]);
  const locked = planStreams({ ...entry, streamLocks: locks }, opts);
  const la = locked.find(s => s.topClipId === 'clip-a'), lb = locked.find(s => s.topClipId === 'clip-b');
  assert.equal(la.streamKey, resultKeyOf(a.contentKey, BROWSER), 'stream key = content key × the locking side\'s fingerprint');
  assert.equal(la.envFingerprint, BROWSER);
  assert.equal(la.ownEnvFingerprint, OWN);
  assert.equal(la.contentKey, a.contentKey, 'content key unchanged');
  assert.deepEqual({ ...la, streamKey: 0, envFingerprint: 0, ownEnvFingerprint: 0 }, { ...a, streamKey: 0, envFingerprint: 0, ownEnvFingerprint: 0 }, 'other fields unchanged');
  assert.deepEqual(lb, plain.find(s => s.topClipId === 'clip-b'), 'streams without a lock are left alone');
  // Locked on own fingerprint: do not swap
  assert.deepEqual(planStreams({ ...entry, streamLocks: new Map([[a.contentKey, OWN]]) }, opts), plain);
  // Budget squeezed to 1: two cards merge into group stream; group streams do not swap per lock
  const grouped = planStreams({ ...entry, streamLocks: locks }, { ...opts, budget: 1 });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, 'group');
  assert.equal(grouped[0].envFingerprint, OWN);
});

test('FSA-02 the layer table lists another fingerprint and the whole stream is at full density: pull it back into the stream store and record a lock; later stream plans, layer tables and producers all use that key', async (t) => {
  const { pipeline, producer, entry, a, b, content, client, page, root } = await scene(t);
  const report = await pipeline.adoptForeignStreams(entry, content, client);
  assert.deepEqual({ checked: report.checked, locked: report.locked, unlocked: report.unlocked, error: report.error }, { checked: 1, locked: 1, unlocked: 0, error: null });
  assert.equal(pipeline.streamLocks.get(a.contentKey), BROWSER);
  assert.equal(pipeline.streamLocks.has(b.contentKey), false, 'the one nobody has produced is not locked');
  // Stored into stream store: manifest, head file, and each segment have identical bytes to what the
  // page pushed
  const dir = path.join(root, 'streams', page.resultKey);
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'stream.json'), 'utf8'));
  assert.equal(onDisk.streamKey, page.resultKey);
  assert.deepEqual(Object.keys(onDisk.segments).map(Number).sort((x, y) => x - y), Array.from({ length: a.lastSegment - a.firstSegment + 1 }, (_, i) => a.firstSegment + i));
  for (const m of page.manifests) for (const [n, seg] of Object.entries(m.segments)) {
    assert.ok((await fs.readFile(path.join(dir, onDisk.segments[n].file))).equals(page.blobs.get(seg.hash)), `Segment ${n} is byte-for-byte identical`);
    assert.equal(onDisk.segments[n].adopted, true);
  }
  // Local stream plan (same parameters as producer and splitting) outputs keys per lock
  const planned = planStreams(entry, { budget: 6, codeVersion: `${STREAM_CODE_VERSION}:${CAPTURE}`, envFingerprint: pipeline.envFingerprint });
  const pa = planned.find(s => s.topClipId === 'clip-a');
  assert.equal(pa.streamKey, page.resultKey);
  assert.equal(planned.find(s => s.topClipId === 'clip-b').streamKey, b.streamKey, 'other streams keep their own keys as before');
  // Producer: this stream is in this plan version; pulled segments count as full density and not
  // stale: nothing to produce
  await producer.update(entry);
  const state = producer.streams.get(page.resultKey);
  assert.ok(state && !state.adoptedOnly, 'the pulled-in stream entered this version\'s plan');
  for (let n = a.firstSegment; n <= a.lastSegment; n++) assert.equal(producer.segmentState(state, n), 'dense', `segment ${n}`);
  assert.equal(producer.streams.has(a.streamKey), false, 'the stream with this machine\'s own fingerprint is not in the plan (not produced)');
  assert.deepEqual(producer.claimLayers(entry.key).filter(l => l.clipId === 'clip-a'), [{ clipId: 'clip-a', kind: 'stream', key: page.resultKey, originFrame: 0 }], 'the layer sent to the stage is the one pulled back (carrying the first frame of this stream)');
  // Layer table: candidate for this row is the locking party's fingerprint
  const map = layerMapOf(entry, { fingerprint: pipeline.envFingerprint, streams: planned });
  assert.deepEqual(map.streams.find(r => r.topClipId === 'clip-a').candidates, [{ envFingerprint: BROWSER, resultKey: page.resultKey }]);
  // Visible in diagnostics
  assert.deepEqual(pipeline.diagnostics().foreignStreams.locks, [[a.contentKey, BROWSER]]);
  // Check again: already locked, no longer reads manifest or downloads
  const before = content.gets.length;
  const again = await pipeline.adoptForeignStreams(entry, content, client);
  assert.deepEqual({ checked: again.checked, locked: again.locked }, { checked: 0, locked: 0 }, 'locked ones are no longer checked; the one nobody has produced has no candidate');
  assert.equal(content.gets.slice(before).some(k => k.startsWith('render-manifest:')), false);
});

test('FSA-03 cases where no lock is made: a manifest is missing, there are sparse segments, the layer table has no row with the same content key, or this machine\'s own key already has the whole stream', async (t) => {
  // Manifest missing one copy (page only produced the first 8 segments)
  const part = await scene(t);
  part.content.items.delete(`render-manifest\u0000${part.page.manifests.at(-1).resultKey}:${part.page.manifests.at(-1).range.from}-${part.page.manifests.at(-1).range.to}`);
  assert.ok(part.page.manifests.length >= 2, 'this stream has more than one manifest');
  const r1 = await part.pipeline.adoptForeignStreams(part.entry, part.content, part.client);
  assert.equal(r1.locked, 0);
  assert.equal(part.pipeline.streamLocks.size, 0);
  await assert.rejects(fs.access(path.join(part.root, 'streams', part.page.resultKey)), 'not pulled unless it is the whole stream');
  // Has sparse segments
  const sparse = await scene(t, { stride: n => (n === 2 ? 15 : 1) });
  assert.equal((await sparse.pipeline.adoptForeignStreams(sparse.entry, sparse.content, sparse.client)).locked, 0);
  // That row in layer table has a different content key (stream with old parameters)
  const other = await scene(t, { rowFor: 'some-old-content-key' });
  const r3 = await other.pipeline.adoptForeignStreams(other.entry, other.content, other.client);
  assert.deepEqual({ checked: r3.checked, locked: r3.locked }, { checked: 0, locked: 0 });
  // This machine already has its own key for the entire stream: do not check
  const mine = await scene(t);
  const own = pageProduce(mine.a);
  await mine.producer.adoptSegments({ ...own.manifests[0], resultKey: mine.a.streamKey }, own.blobs).catch(() => {});
  for (const m of own.manifests) await mine.producer.adoptSegments({ ...m, resultKey: mine.a.streamKey }, own.blobs);
  const r4 = await mine.pipeline.adoptForeignStreams(mine.entry, mine.content, mine.client);
  assert.equal(r4.locked, 0, 'already has the whole stream itself, so it does not switch to someone else\'s');
  assert.equal(mine.pipeline.streamLocks.size, 0);
  // No content store, no asset service client: do nothing
  assert.deepEqual((await mine.pipeline.adoptForeignStreams(mine.entry, null, mine.client)).locked, 0);
});

test('FSA-04 the lock is persisted to disk: a new pipeline after restart keys per the lock; if the pulled-back stream is no longer complete, unlock', async (t) => {
  const { pipeline, entry, a, content, client, page, root, make } = await scene(t);
  await pipeline.adoptForeignStreams(entry, content, client);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'stream-locks.json'), 'utf8')).entries, [[a.contentKey, BROWSER]]);
  const again = make();
  F.producerOf(again, 'libx264');
  assert.equal(again.streamLocks.get(a.contentKey), BROWSER, 'the lock is still there after restart');
  const entry2 = entryOf(again);
  const planned = planStreams(entry2, { budget: 6, codeVersion: `${STREAM_CODE_VERSION}:${CAPTURE}`, envFingerprint: again.envFingerprint });
  assert.equal(planned.find(s => s.topClipId === 'clip-a').streamKey, page.resultKey);
  // Recheck: stream in stream store is still complete, lock remains (does not read content store)
  const r = await again.adoptForeignStreams(entry2, fakeContent(), client);
  assert.equal(r.unlocked, 0);
  assert.equal(again.streamLocks.get(a.contentKey), BROWSER);
  // Stream in stream store was cleared: unlock and revert to own key
  const fresh = make();
  F.producerOf(fresh, 'libx264');
  await fs.rm(path.join(root, 'streams', page.resultKey), { recursive: true, force: true });
  const entry3 = entryOf(fresh);
  const r2 = await fresh.adoptForeignStreams(entry3, fakeContent(), client);
  assert.equal(r2.unlocked, 1);
  assert.equal(fresh.streamLocks.size, 0);
  assert.equal(planStreams(entry3, { budget: 6, codeVersion: `${STREAM_CODE_VERSION}:${CAPTURE}`, envFingerprint: fresh.envFingerprint }).find(s => s.topClipId === 'clip-a').streamKey, a.streamKey);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'stream-locks.json'), 'utf8')).entries, []);
});

test('FSA-05 splitting: emit only one copy per the lock, with both the key and the fingerprint belonging to the locking side; when the browser is online it takes the browser\'s shape, and this machine does not emit its own copy', async (t) => {
  const { pipeline, entry, a, b, content, client, page } = await scene(t);
  await pipeline.adoptForeignStreams(entry, content, client);
  const own = pipeline.envFingerprint;
  const streams = planStreams(entry, { budget: 6, codeVersion: `${STREAM_CODE_VERSION}:${CAPTURE}`, envFingerprint: own }).map(queueStreamOf);
  const cardLocks = new Map([...pipeline.streamLocks].map(([k, fp]) => [`stream:${k}`, fp]));
  const base = { planTask: { id: 'plan:p@1', source: { projectId: 'p', projectRev: 1 } }, entryKey: entry.key, cardPlan: entry.cardPlan, prerenderSet: new Set(['clip-a', 'clip-b']), streams,
    envFingerprint: own, codeVersion: 'cv', weightOf: () => ({ class: 'medium', estMs: null }), cardLocks };
  const tasksOf = (extra) => splitPlan({ ...base, ...extra }).filter(x => x.kind === 'stream');
  // Browser (locking party) is online
  const online = tasksOf({ browserFingerprints: [BROWSER] });
  const forA = online.filter(x => x.input.clipId === 'clip-a');
  assert.ok(forA.length >= 1);
  assert.ok(forA.every(x => x.resultKey === page.resultKey && x.requires.envFingerprint === BROWSER && x.requires.transcode === false && x.input.stream && !('dual' in x.input)),
    'only the locking side\'s copy, in the browser\'s shape, not paired');
  assert.equal(online.some(x => x.input.clipId === 'clip-a' && x.requires.envFingerprint === own), false, 'this machine does not emit its own copy');
  // Unlocked stream pairs as usual (own, browser's)
  const forB = online.filter(x => x.input.clipId === 'clip-b');
  assert.deepEqual([...new Set(forB.map(x => x.requires.envFingerprint))].sort(), [BROWSER, own].sort());
  assert.ok(forB.every(x => x.input.dual === true));
  assert.ok(forB.some(x => x.resultKey === b.streamKey));
  // Browser offline: outputs one copy per lock (fingerprint still belongs to locking party, this
  // machine cannot claim it, so does not re-produce)
  const offline = tasksOf({});
  assert.ok(offline.filter(x => x.input.clipId === 'clip-a').every(x => x.requires.envFingerprint === BROWSER && x.resultKey === page.resultKey));
  assert.equal(a.contentKey, forA[0].input.contentKey);
});
