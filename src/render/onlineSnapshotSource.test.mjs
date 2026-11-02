/**
 * Snapshot source for online page (`OnlineSnapshotSource` in `snapshotSource.ts`;
 * `docs/plan/c10a-contract.md` sections 8 and 9): pulls prerendered small sizes based on layer
 * table and manifest; only pulls small size, only pulls 2 seconds around playhead, in-memory
 * LRU 64 MiB.
 * Run: node --test src/render/onlineSnapshotSource.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OnlineSnapshotSource, ByteLru, parseLayerMap, segmentsInWindow, framesToRanges, smallSnapshotHtml,
  ONLINE_CACHE_MAX_BYTES, PREFETCH_SEC, LAYER_MAP_PREFIX, applyReadyMessage, layerOf,
} from './snapshotSource.ts';
import { pickLayerSnapshot } from './snapshotPick.mjs';

const H = (n) => n.toString(16).padStart(64, '0');

/** Mock content store + mock asset service */
function world({ fps = 30 } = {}) {
  const content = new Map();
  const requests = [];
  const fetches = [];
  const bytes = new Map();
  const deps = {
    async request(msg) {
      requests.push(msg);
      if (msg.type !== 'content.get') throw new Error('only content.get is recognized');
      if (!content.has(msg.key)) return { type: 'content.item', kind: msg.kind, key: msg.key, missing: true };
      return { type: 'content.item', kind: msg.kind, key: msg.key, body: structuredClone(content.get(msg.key)), hash: 'x' };
    },
    assetBase: () => 'https://h.example/media/api/asset/',
    authHeaders: async () => ({ Authorization: 'Bearer RT' }),
    async fetch(url, init) {
      fetches.push({ url, auth: init?.headers?.Authorization });
      const hash = url.split('/').pop();
      if (!bytes.has(hash)) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
      const b = bytes.get(hash);
      return { ok: true, status: 200, headers: { get: () => 'image/webp' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    },
    setTimer: () => 0,
    clearTimer: () => {},
  };
  const layerMap = (layers) => content.set(`${LAYER_MAP_PREFIX}p1`, { v: 1, kind: 'layer-map', projectId: 'p1', fps, span: 60, at: 1, layers });
  /** A manifest segment: frames cover [from,to], frames given in small column */
  const manifest = (resultKey, from, to, smallFrames, salt = 0) => {
    const frames = [];
    for (let f = from; f <= to; f++) frames.push([f, H(1000 + f), 10]);
    const small = smallFrames.map((f) => [f, H(5000 + f + salt), 20]);
    for (const [, h] of small) bytes.set(h, new Uint8Array([82, 73, 70, 70, salt & 255, 0, 0, 0]));
    content.set(`${resultKey}:${from}-${to}`, { v: 1, kind: 'snapshot', resultKey, range: { from, to }, frames, small });
  };
  return { deps, content, requests, fetches, layerMap, manifest, bytes };
}

test('OS1 pure functions: layer table parsing, segments in the window, merging frame numbers into ranges, wrapping a small bitmap into an img that fills the plane', () => {
  const map = parseLayerMap({ kind: 'layer-map', projectId: 'p', fps: 30, span: 60, layers: [
    { clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 30, count: 150 },
    { clipId: 'b', kind: 'stream', key: 'S', resultKey: 'R2', firstFrame: 0, count: 10 },
    { clipId: 'c', kind: 'html', key: 'K', resultKey: 'R', firstFrame: -1, count: 5 },
  ] });
  assert.deepEqual(map.layers.map((l) => l.clipId), ['a'], 'streams and bad entries are not accepted');
  assert.equal(parseLayerMap({ kind: 'snapshot' }), null);
  const layer = map.layers[0];
  // Global frames 60-120 → local 30-90 → segments [0,59] and [60,119]
  assert.deepEqual(segmentsInWindow(layer, 60, 60, 120), [[0, 59], [60, 119]]);
  assert.deepEqual(segmentsInWindow(layer, 60, 0, 10), [], 'this layer has not been reached yet');
  assert.deepEqual(segmentsInWindow(layer, 60, 170, 400), [[120, 149]], 'the last segment goes up to count - 1');
  assert.deepEqual(framesToRanges([5, 1, 2, 3, 9, 9, 10]), [[1, 3], [5, 5], [9, 10]]);
  const html = smallSnapshotHtml('data:image/webp;base64,AAAA');
  assert.match(html, /^<img [^>]*src="data:image\/webp;base64,AAAA"/);
  assert.match(html, /width:100%;height:100%/);
  assert.equal(ONLINE_CACHE_MAX_BYTES, 64 * 1024 * 1024);
  assert.equal(PREFETCH_SEC, 2);
});

test('OS2 ready: per the layer table, fetch only the manifests of the segments within 2 seconds around the playhead; ready ranges = frames that have a small bitmap, sent as the full layer per C3', async () => {
  const w = world();
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 0, count: 600 }]);
  w.manifest('R', 0, 59, [0, 1, 2, 3, 10]);
  w.manifest('R', 60, 119, [60, 61]);
  w.manifest('R', 300, 359, [300]);
  const src = new OnlineSnapshotSource(w.deps);
  const index = new Map();
  const seen = [];
  src.subscribeReady('s', 0, (m) => { seen.push(m); applyReadyMessage(index, m); });
  src.setProject('p1');
  src.focus(1, 30);
  await src.tickNow();
  const keys = w.requests.filter((r) => r.key !== `${LAYER_MAP_PREFIX}p1`).map((r) => r.key).sort();
  assert.deepEqual(keys, ['R:0-59', 'R:60-119'], 'fetch only segments in the window (playhead at 1 s → global frames 0-90)');
  assert.deepEqual(layerOf(index, 'a', 'html'), { clipId: 'a', kind: 'html', key: 'K', ranges: [[0, 3], [10, 10], [60, 61]] });
  // Frame selection: local frame 5 backtracks to 3 (within same interval), same path as local mode
  const pick = pickLayerSnapshot({ layer: layerOf(index, 'a', 'html'), globalFrame: 5, firstFrame: 0, count: 600, anchors: [] });
  assert.equal(pick.localFrame, 3);
  assert.equal(seen[0].type, 'reset');
});

test('OS3 fetch bytes: pull only px/<hash> (small size), with a read-only ticket; a cache hit makes no further request; throw if there is no small size for this frame', async () => {
  const w = world();
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 0, count: 60 }]);
  w.manifest('R', 0, 59, [0, 1]);
  const src = new OnlineSnapshotSource(w.deps);
  src.subscribeReady('s', 0, () => {});
  src.setProject('p1');
  src.focus(0, 30);
  // Snapshot prefetching retired: refresh no longer prefetches small size, only pulled on demand
  // during fetchSnapshot
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.fetches.length, 0, 'does not prefetch snapshot small sizes');
  const html = await src.fetchSnapshot('html', 'K', 1);
  assert.match(html, /data:image\/webp;base64,/);
  assert.equal(w.fetches.length, 1);
  assert.ok(w.fetches.every((f) => /^https:\/\/h\.example\/media\/api\/asset\/px\/[0-9a-f]{64}$/.test(f.url)), 'only pulls small bitmaps under px');
  assert.ok(w.fetches.every((f) => f.auth === 'Bearer RT'));
  const htmlCached = await src.fetchSnapshot('html', 'K', 1);
  assert.equal(w.fetches.length, 1, 'cache hit');
  await assert.rejects(src.fetchSnapshot('html', 'K', 5), /No small-size prerender for this frame/);
  assert.ok(src.cacheBytes > 0);
  src.clearCache();
  assert.equal(src.cacheBytes, 0, 'release the small-size cache before export');
});

test('OS4 key change (after a render node re-renders): the layer table changed, frames of the old key no longer count as ready; a card no longer in the layer table sends an empty layer to remove it', async () => {
  const w = world();
  w.layerMap([
    { clipId: 'a', kind: 'html', key: 'K1', resultKey: 'R1', firstFrame: 0, count: 60 },
    { clipId: 'b', kind: 'html', key: 'KB', resultKey: 'RB', firstFrame: 0, count: 60 },
  ]);
  w.manifest('R1', 0, 59, [0, 1, 2]);
  w.manifest('RB', 0, 59, [0]);
  let now = 0;
  const src = new OnlineSnapshotSource({ ...w.deps, now: () => now });
  const index = new Map();
  src.subscribeReady('s', 0, (m) => applyReadyMessage(index, m));
  src.setProject('p1');
  await src.tickNow();
  assert.deepEqual(layerOf(index, 'a', 'html').ranges, [[0, 2]]);
  // Modified card a: render node changed key, manifest for the new key does not exist yet
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K2', resultKey: 'R2', firstFrame: 0, count: 60 }]);
  now += 10_000;
  await src.tickNow();
  assert.deepEqual(layerOf(index, 'a', 'html'), { clipId: 'a', kind: 'html', key: 'K2', ranges: [] }, 'new key has no data yet: ranges empty (page shows a placeholder)');
  assert.deepEqual(layerOf(index, 'b', 'html').ranges, [], 'b is no longer in the layer table: empty layer removes it');
  // New small size has returned
  w.manifest('R2', 0, 59, [0, 1]);
  now += 10_000;
  await src.tickNow();
  assert.deepEqual(layerOf(index, 'a', 'html'), { clipId: 'a', kind: 'html', key: 'K2', ranges: [[0, 1]] });
});

test('OS5 segments whose manifest is not full yet are fetched again after a while; once full they are not fetched again', async () => {
  const w = world();
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 0, count: 4 }]);
  w.manifest('R', 0, 3, [0]);
  let now = 0;
  const src = new OnlineSnapshotSource({ ...w.deps, now: () => now });
  const index = new Map();
  src.subscribeReady('s', 0, (m) => applyReadyMessage(index, m));
  src.setProject('p1');
  await src.tickNow();
  assert.deepEqual(layerOf(index, 'a', 'html').ranges, [[0, 0]]);
  w.manifest('R', 0, 3, [0, 1, 2, 3]);
  now += 500;
  await src.tickNow();
  assert.deepEqual(layerOf(index, 'a', 'html').ranges, [[0, 0]], 'no refetch within 2 seconds');
  now += 2500;
  await src.tickNow();
  assert.deepEqual(layerOf(index, 'a', 'html').ranges, [[0, 3]]);
  const count = w.requests.filter((r) => r.key === 'R:0-3').length;
  now += 5000;
  await src.tickNow();
  assert.equal(w.requests.filter((r) => r.key === 'R:0-3').length, count, 'once full, no more fetching');
});

test('OS6 LRU by bytes, within the limit; least recently used leaves first', () => {
  const lru = new ByteLru(10);
  lru.set('a', '1234');
  lru.set('b', '1234');
  lru.get('a');
  lru.set('c', '1234');
  assert.equal(lru.has('b'), false, 'b is least recently used');
  assert.equal(lru.has('a'), true);
  assert.ok(lru.total <= 10);
  lru.set('huge', 'x'.repeat(50));
  assert.equal(lru.size, 1, 'a single item over the limit still keeps the newest one');
});

test('OS7 not connected to the document service / no asset service: does not throw, only records the error, tries again next round', async () => {
  const w = world();
  const src = new OnlineSnapshotSource({ ...w.deps, request: async () => { throw new Error('Not connected to the document service'); }, assetBase: () => null });
  src.subscribeReady('s', 0, () => {});
  src.setProject('p1');
  await src.tickNow();
  assert.ok(src.stats.errors >= 1);
  assert.equal(w.fetches.length, 0);
});

test('OS8 can still fetch the new key after one layer table request hangs forever', async () => {
  const w = world();
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K2', resultKey: 'R2', firstFrame: 0, count: 2 }]);
  w.manifest('R2', 0, 1, [0, 1]);
  let calls = 0;
  const src = new OnlineSnapshotSource({ ...w.deps, request: (msg) => {
    if (msg.key === 'layers:p1' && ++calls === 1) return new Promise(() => {});
    return w.deps.request(msg);
  }, requestTimeoutMs: 20 });
  const index = new Map();
  src.subscribeReady('s', 0, (m) => applyReadyMessage(index, m));
  src.setProject('p1');
  await Promise.race([src.tickNow(), new Promise((_, reject) => setTimeout(() => reject(new Error('polling stuck on a hanging request')), 100))]);
  assert.equal(calls, 1);
  await src.tickNow();
  assert.equal(layerOf(index, 'a', 'html')?.key, 'K2');
  src.stop();
});

test('OS9 after one small bitmap request hangs forever, the queue is released and the fetch is retried', async () => {
  const w = world();
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 0, count: 1 }]);
  w.manifest('R', 0, 0, [0]);
  let calls = 0;
  const src = new OnlineSnapshotSource({ ...w.deps, assetTimeoutMs: 20, fetch: (...args) => {
    if (++calls === 1) return new Promise(() => {});
    return w.deps.fetch(...args);
  } });
  src.setProject('p1');
  await src.tickNow();
  await assert.rejects(src.fetchSnapshot('html', 'K', 0), /Asset request timed out/);
  assert.match(await src.fetchSnapshot('html', 'K', 0), /data:image\/webp;base64,/);
  assert.equal(calls, 2);
  src.stop();
});

test('OS10 manifest is missing a few small-size frames (Aliyun 2026-09-27: 295/300, missing frame 0 and 28~31): frames that exist become ready and are fetched as usual; a missing frame falls back within the same range, and only a missing segment start gets a placeholder', async () => {
  const w = world();
  w.layerMap([{ clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 0, count: 300 }]);
  const all = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  w.manifest('R', 0, 59, all(0, 59).filter((f) => f !== 0 && (f < 28 || f > 31)));
  w.manifest('R', 60, 119, all(60, 119));
  const src = new OnlineSnapshotSource(w.deps);
  const index = new Map();
  src.subscribeReady('s', 0, (m) => applyReadyMessage(index, m));
  src.setProject('p1');
  src.focus(0, 30);
  await src.tickNow();
  const layer = layerOf(index, 'a', 'html');
  assert.deepEqual(layer.ranges, [[1, 27], [32, 119]], 'An incomplete segment is not dropped as a whole: every frame that has a small size counts as ready');
  assert.equal(src.debug().layers[0].ready, 115, 'Same as ready 115 on the Aliyun phone');
  const pick = (g) => pickLayerSnapshot({ layer, globalFrame: g, firstFrame: 0, count: 300, anchors: [0, 300] })?.localFrame ?? null;
  assert.equal(pick(0), null, 'Segment-start frame is missing: nothing earlier to fall back to, so this layer shows a placeholder in fallback order');
  assert.equal(pick(5), 5, 'Existing frames are applied as usual');
  assert.equal(pick(30), 27, 'A missing frame falls back to the nearest frame in the same range');
  assert.equal(pick(90), 90);
  assert.match(await src.fetchSnapshot('html', 'K', 5), /data:image\/webp;base64,/);
  await assert.rejects(src.fetchSnapshot('html', 'K', 0), /No small-size prerender for this frame/);
  // After render node fills in those frames (manifest replaced with full one), next round ready
  // interval is filled out, and segment start can also be pasted
  w.manifest('R', 0, 59, all(0, 59));
  src.stop();
  const later = new OnlineSnapshotSource({ ...w.deps });
  const index2 = new Map();
  later.subscribeReady('s', 0, (m) => applyReadyMessage(index2, m));
  later.setProject('p1');
  later.focus(0, 30);
  await later.tickNow();
  assert.deepEqual(layerOf(index2, 'a', 'html').ranges, [[0, 119]]);
});

test('C10 section 9: layers of user cards and media effect cards fetch manifests and bytes as usual (no longer exempt); a layer named by coverageLayer fetches manifests for the whole segment range, and coverage judges whole-range coverage', async () => {
  const w = world();
  let T = 1_000_000;
  const all = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  w.layerMap([
    { clipId: 'a', kind: 'html', key: 'K', resultKey: 'R', firstFrame: 0, count: 180 },
    { clipId: 'u', kind: 'html', key: 'KU', resultKey: 'RU', firstFrame: 0, count: 180 },
  ]);
  w.manifest('R', 0, 59, [0, 1]);
  w.manifest('RU', 0, 59, all(0, 59), 7);
  w.manifest('RU', 60, 119, all(60, 119), 7);
  w.manifest('RU', 120, 179, [120], 7);
  const src = new OnlineSnapshotSource({ ...w.deps, now: () => T, coverageLayer: (clipId) => clipId === 'u' });
  let notified = 0;
  src.subscribeCoverage(() => notified++);
  src.subscribeReady('s', 0, () => {});
  src.setProject('p1');
  src.focus(0, 30);
  await src.tickNow();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(w.requests.some((r) => r.key === 'R:0-59') && w.requests.some((r) => r.key === 'RU:0-59'), 'Window manifests of both layers are fetched');
  assert.ok(w.requests.some((r) => r.key === 'RU:120-179'), 'Segments outside the window of the coverageLayer layer are fetched too');
  await src.fetchSnapshot('html', 'KU', 0);
  assert.ok(w.fetches.some((f) => f.url.includes(H(5000 + 0 + 7))), 'Bytes of the user card layer are pulled as usual');
  assert.equal(src.coverage('u'), 'partial', 'The last segment is incomplete');
  assert.equal(src.coverage('a'), 'unknown', 'A layer that is not named fetches only the window: the manifest of the segment outside the window was never fetched → still unknown');
  assert.equal(src.coverage('nobody'), 'none', 'This layer is not in the layer map');
  assert.ok(notified > 0, 'Coverage change is notified when a manifest arrives');
  // Fill out the last segment: fetch again after COVERAGE_POLL_MS, covering the whole segment
  w.manifest('RU', 120, 179, all(120, 179), 7);
  T += 5_001;
  const before = notified;
  await src.tickNow();
  assert.equal(src.coverage('u'), 'full');
  assert.ok(notified > before);
  // Completed segments are not fetched again
  const n = w.requests.filter((r) => r.key === 'RU:0-59').length;
  T += 60_000;
  await src.tickNow();
  assert.equal(w.requests.filter((r) => r.key === 'RU:0-59').length, n, 'A full manifest is not fetched again');
  src.stop();
});

test('C10 section 9: no flicker right after opening the page: while the layer map has not arrived, coverage is "unknown" and a frame is not counted as confirmed missing; only once the layer map arrives is it confirmed from the layer map and manifests', async () => {
  const w = world();
  let T = 1_000_000;
  const all = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  w.layerMap([{ clipId: 'u', kind: 'html', key: 'KU', resultKey: 'RU', firstFrame: 0, count: 120 }]);
  w.manifest('RU', 0, 59, all(0, 50));
  // Manifest for the second segment does not exist (content store returns "no such item")
  let gate = null;
  const deps = { ...w.deps, now: () => T, coverageLayer: () => true,
    async request(msg) { if (gate) await gate; return w.deps.request(msg); } };
  let release;
  gate = new Promise((r) => { release = r; });
  const src = new OnlineSnapshotSource(deps);
  src.subscribeReady('s', 0, () => {});
  src.setProject('p1');
  src.focus(0, 30);
  // Layer table is still on the way
  assert.equal(src.coverage('u'), 'unknown', 'Layer map not fetched: still unknown');
  assert.equal(src.coverage('s2'), 'unknown', 'A clip with no layer is still unknown too');
  assert.equal(src.frameConfirmedMissing('u', 0), false, 'Layer map not fetched: not counted as confirmed missing');
  assert.equal(src.frameConfirmedMissing('s2', 0), false);
  gate = null;
  release();
  await src.tickNow();
  await src.tickNow();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(src.coverage('s2'), 'none', 'Layer map fetched, no such layer: confirmed none');
  assert.equal(src.frameConfirmedMissing('s2', 10), true, 'Layer map fetched, no such layer: this frame is confirmed missing');
  assert.equal(src.frameConfirmedMissing('u', 10), false, 'The manifest has this frame (whether the bytes are on this page does not matter)');
  assert.equal(src.frameConfirmedMissing('u', 55), true, 'Manifest fetched, this frame is not in it');
  assert.equal(src.frameConfirmedMissing('u', 90), true, 'The content store replying "no manifest for this segment" also counts as fetched');
  assert.equal(src.frameConfirmedMissing('u', -3), false, 'Clamped to frame 0');
  assert.equal(src.frameConfirmedMissing('u', 999), true, 'Clamped to the last frame (that segment is confirmed missing)');
  assert.equal(src.coverage('u'), 'partial', 'Every segment was fetched but frames are incomplete: confirmed not covering the whole range');
  src.stop();
});

test('C10 section 9: for a segment whose manifest is not fetched yet, this frame is not counted as confirmed missing (shows a loading placeholder)', async () => {
  const w = world();
  w.layerMap([{ clipId: 'u', kind: 'html', key: 'KU', resultKey: 'RU', firstFrame: 0, count: 600 }]);
  w.manifest('RU', 0, 59, [0]);
  const src = new OnlineSnapshotSource({ ...w.deps, now: () => 1_000_000 });
  src.subscribeReady('s', 0, () => {});
  src.setProject('p1');
  src.focus(0, 30);
  await src.tickNow();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(src.frameConfirmedMissing('u', 1), true, 'The segment in the window was fetched');
  assert.equal(src.frameConfirmedMissing('u', 500), false, 'The segment outside the window was never fetched: still unknown');
  assert.equal(src.coverage('u'), 'unknown', 'When whole-range coverage is not named, segments outside the window are not fetched: still unknown');
  src.stop();
});
