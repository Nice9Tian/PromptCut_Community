/**
 * Online page reads track streams (`OnlineSnapshotSource` in `snapshotSource.ts`;
 * `docs/plan/browser-stream-task.md` item 6):
 * Read layer table's `streams` table → fetch stream manifests (`render-manifest`) by segments
 * near the playhead → fetch chunks in manifest by hash from asset service to this page →
 * Segments whose bytes arrived assemble ready intervals, delivered to subscribers per C3's
 * `layer` message (`kind: 'stream'`); manifests and bytes carried when `streamPlane` sends
 * stream plane to parent page.
 * Run: node --test src/render/onlineStreams.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  OnlineSnapshotSource, parseLayerMap, parseLayerStreams, streamSpansInWindow, applyReadyMessage, BlockLru,
  LAYER_MAP_PREFIX, MANIFEST_POLL_MS, STREAM_RETRY_MS, LAYER_MAP_POLL_MS,
  browserDecodeSupport, SPARSE_STREAM_CACHE_MAX_BYTES, STREAM_CACHE_MAX_BYTES,
} from './snapshotSource.ts';
import { streamPlanesFor, SEGMENT_FRAMES } from './streamPlayer.ts';
import { streamInputSig } from './streamInputSig.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const RK = (n) => n.toString(16).padStart(64, '0');
const bytesOf = (text) => new TextEncoder().encode(text);

/** A fake content store + fake asset service (with an advancing clock and a renewable ticket) */
function world() {
  const w = {
    content: new Map(), requests: [], fetches: [], bytes: new Map(), now: 1_000_000, ticket: 'T1', accepts: () => true,
  };
  w.deps = {
    async request(msg) {
      w.requests.push(msg);
      if (msg.type !== 'content.get') throw new Error('only content.get is recognized');
      if (!w.content.has(msg.key)) return { type: 'content.item', kind: msg.kind, key: msg.key, missing: true };
      return { type: 'content.item', kind: msg.kind, key: msg.key, body: structuredClone(w.content.get(msg.key)), hash: 'x' };
    },
    assetBase: () => 'https://h.example/media/api/asset/',
    authHeaders: async () => ({ Authorization: `Bearer ${w.ticket}` }),
    async fetch(url, init) {
      const auth = init?.headers?.Authorization;
      w.fetches.push({ url, auth });
      const fail = (status) => ({ ok: false, status, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
      if (!w.accepts(auth)) return fail(401);
      const hash = url.split('/').pop();
      if (!w.bytes.has(hash)) return fail(404);
      const b = w.bytes.get(hash);
      return { ok: true, status: 200, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    },
    now: () => w.now,
    setTimer: () => 0,
    clearTimer: () => {},
  };
  /** Put a chunk into asset service, return its hash */
  w.block = (text) => { const b = bytesOf(text); const h = sha(b); w.bytes.set(h, b); return h; };
  /** Put a stream manifest into content store; `segs` are segment numbers in this manifest (defaults to all) */
  w.putStream = (rk, from, to, { segs = null, stride = 1, tag = 'v1', clipIds = ['c1'], kind = 'card', upload = true } = {}) => {
    const initBytes = bytesOf(`init ${rk.slice(-4)} ${tag}`);
    const initHash = sha(initBytes);
    if (upload) w.bytes.set(initHash, initBytes);
    const id = initHash.slice(0, 16);
    const segments = {};
    const hashes = {};
    for (let n = from; n <= to; n++) {
      if (segs && !segs.includes(n)) continue;
      const body = bytesOf(`seg ${rk.slice(-4)} ${n} ${tag}`);
      const hash = sha(body);
      if (upload) w.bytes.set(hash, body);
      hashes[n] = hash;
      segments[n] = { hash, bytes: body.length, init: id, stride, samples: Math.ceil(SEGMENT_FRAMES / stride), sig: null, encoder: 'libx264' };
    }
    w.content.set(`${rk}:${from}-${to}`, {
      v: 1, kind: 'stream', resultKey: rk, range: { from, to },
      header: { kind, plane: kind === 'group' ? 'stage' : 'local', clipIds, fps: 30, bound: { x: -32, y: -32, w: 704, h: 424 }, offset: { x: 640, y: 360 }, tight: null },
      inits: { [id]: { hash: initHash, bytes: initBytes.length, codec: 'avc1.640028', width: 704, height: 864, timescale: 15360, rect: { x: -32, y: -32, w: 704, h: 424 }, encoder: 'libx264' } },
      segments,
    });
    return { initHash, id, hashes };
  };
  w.putMap = (streams, { layers = [], v = 3 } = {}) => {
    w.content.set(`${LAYER_MAP_PREFIX}p1`, { v, kind: 'layer-map', projectId: 'p1', entryKey: 'e', fps: 30, span: 60, at: 1, layers, ...(streams ? { streams } : {}) });
  };
  w.source = (opts = { tier: 'original' }) => {
    const src = new OnlineSnapshotSource(w.deps, opts);
    const messages = [];
    src.subscribeReady('online', 0, (m) => messages.push(m));
    src.setProject('p1');
    return { src, messages, streamMessages: () => messages.filter((m) => m.type === 'layer' && m.kind === 'stream') };
  };
  /** Run one round: fetch layer table, manifests, and chunks, wait to settle */
  w.settle = async (src) => { await src.tickNow(); await src.idle(); await src.tickNow(); await src.idle(); };
  return w;
}

/**
 * A row in layer table: this stream starts from project frame 30 (`originFrame`), segments are
 * counted from its own first frame, 0-18 (frames 30-314).
 * Row does not specify `firstSegment` (always 0); manifests are split by "every 8 segments from 0":
 * `0-7`, `8-15`, `16-18`.
 */
const row = (over = {}) => ({ topClipId: 'c1', clipIds: ['c1'], kind: 'card', plane: 'local', contentKey: 'sk-1',
  candidates: [{ envFingerprint: 'fp-a', resultKey: RK(0xa) }], originFrame: 30, lastSegment: 18, segmentsPerTask: 8, ...over });
const last = (list) => list[list.length - 1];

test('How manifests are split: starting from firstSegment, one part per segmentsPerTask segments, the last part runs to lastSegment', () => {
  const r = { firstSegment: 2, lastSegment: 20, segmentsPerTask: 8 };
  assert.deepEqual(streamSpansInWindow(r, 0, 100), [[2, 9], [10, 17], [18, 20]]);
  assert.deepEqual(streamSpansInWindow(r, 0, 4), [[2, 9]]);
  assert.deepEqual(streamSpansInWindow(r, 9, 10), [[2, 9], [10, 17]]);
  assert.deepEqual(streamSpansInWindow(r, 18, 18), [[18, 20]]);
  assert.deepEqual(streamSpansInWindow(r, 21, 30), []);
  assert.deepEqual(streamSpansInWindow(r, 0, 1), []);
});

test('Parse the streams table: rows with a wrong shape are skipped; layer maps below v 2 do not read this table', () => {
  const good = row();
  // Row written by a node before segment rule change: has `firstSegment`, no `originFrame`
  // (segments counted by project frame numbers). Pasting per current conversion will misalign, reject it
  const { originFrame: _origin, ...oldShape } = good;
  const parsed = parseLayerStreams([good, null, { ...good, clipIds: [] }, { ...good, kind: 'x' }, { ...good, candidates: [] }, { ...good, candidates: [{ envFingerprint: 'f' }] },
    { ...good, lastSegment: -1 }, { ...good, segmentsPerTask: 0 }, { ...good, contentKey: '' }, { ...good, topClipId: undefined, inputSig: 's1-abc' },
    { ...oldShape, firstSegment: 2, lastSegment: 20 }, { ...good, originFrame: -1 }, { ...good, originFrame: 1.5 }, { ...good, originFrame: '30' }]);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { ...good, firstSegment: 0 }, 'Segment numbers always start from 0');
  assert.equal(parsed[0].originFrame, 30);
  assert.equal(parsed[1].topClipId, 'c1', 'When topClipId is not written, the last member is taken');
  assert.equal(parsed[1].inputSig, 's1-abc');
  assert.deepEqual(parseLayerStreams(undefined), []);
  const base = { kind: 'layer-map', projectId: 'p1', fps: 30, span: 60, layers: [], streams: [good] };
  assert.equal(parseLayerMap({ ...base, v: 3 }).streams.length, 1);
  assert.deepEqual(parseLayerMap({ ...base, v: 2 }).streams, []);
  assert.deepEqual(parseLayerMap({ kind: 'layer-map', v: 3, layers: [] }).streams, [], 'A layer map written by an old node has no streams: empty table');
});

test('Old-shape layer map (no streams): no stream manifests are fetched and no stream layers are sent, the snapshot half stays as before', async () => {
  const w = world();
  const layer = { clipId: 'c1', kind: 'html', key: 'k1', tier: 'shared', resultKey: 'r1', dirKey: 'r1', entryKey: null, firstFrame: 0, count: 60, contentKey: 'ck1', envFingerprint: 'fp-a',
    candidates: [{ envFingerprint: 'fp-a', resultKey: 'r1', key: 'k1', dirKey: 'r1' }] };
  const snap = w.block('<div>snap</div>');
  w.content.set('r1:0-59', { v: 1, kind: 'snapshot', tier: 'shared', resultKey: 'r1', dirKey: 'r1', range: { from: 0, to: 59 }, frames: [[0, snap, 10]] });
  w.putMap(null, { layers: [layer] });
  const { src, messages, streamMessages } = w.source();
  await w.settle(src);
  assert.equal(w.requests.some((r) => r.kind === 'render-manifest'), false);
  assert.deepEqual(streamMessages(), []);
  assert.equal(src.streamPlane(RK(0xa)), null);
  assert.deepEqual(last(messages.filter((m) => m.type === 'layer')), { type: 'layer', clipId: 'c1', kind: 'html', key: 'k1', ranges: [[0, 0]] }, 'Snapshot layers are sent as before');
  assert.equal(src.debug().streams.length, 0);
  src.stop();
});

test('Segment number → ready range: only manifests and chunks near the playhead are fetched; a segment counts as ready once its bytes arrive on this page', async () => {
  const w = world();
  const rk = RK(0xa);
  const a = w.putStream(rk, 0, 7);
  w.putStream(rk, 8, 15);
  w.putStream(rk, 16, 18);
  w.putMap([row()]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  // Playhead at 0: window is project frames 0-60 (2s ahead). This stream starts from frame 30;
  // segments 0-2 (frames 30-74) fall into the window, all in the first manifest
  const asked = w.requests.filter((r) => r.kind === 'render-manifest').map((r) => r.key);
  assert.deepEqual(asked, [`${rk}:0-7`], 'Only the one manifest part the window falls in was fetched');
  assert.deepEqual(last(streamMessages()), { type: 'layer', clipId: 'c1', kind: 'stream', key: rk, ranges: [[0, 2]], originFrame: 30 }, 'The ready message carries the first frame of this stream');
  const fetched = w.fetches.map((f) => f.url);
  assert.ok(fetched.every((u) => u.startsWith('https://h.example/media/api/asset/px/')), 'Chunks are fetched from px/');
  assert.deepEqual(new Set(fetched.map((u) => u.split('/').pop())), new Set([a.initHash, a.hashes[0], a.hashes[1], a.hashes[2]]), 'Init file + the three segments in the window, each fetched once');
  assert.equal(fetched.length, 4);
  assert.ok(w.fetches.every((f) => f.auth === 'Bearer T1'), 'Carries the read-only ticket');
  // Playhead moved to 3s (frame 90, segment 4 of this stream): window is its segments 3-8,
  // crossing into the second manifest
  src.focus(3, 30);
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 8]], '0..2 fetched earlier is still on this page, joined with the newly fetched 3..8');
  assert.ok(w.requests.some((r) => r.kind === 'render-manifest' && r.key === `${rk}:8-15`));
  assert.equal(w.requests.some((r) => r.key === `${rk}:16-18`), false, 'segment the window has not reached is not fetched');
  // Full manifests are no longer fetched
  const before = w.requests.length;
  w.now += MANIFEST_POLL_MS * 3;
  await w.settle(src);
  assert.equal(w.requests.filter((r, i) => i >= before && r.kind === 'render-manifest' && r.key === `${rk}:0-7`).length, 0);
  // Ready message entered ready index; pure computation on parent page can assemble stream plane
  // (without changing a single line of snapshotFeed)
  const index = new Map();
  for (const m of streamMessages()) applyReadyMessage(index, m);
  const layers = [...index].map(([clipId, byKind]) => ({ clipId, ...byKind.get('stream') }));
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1']), 90), [{ clipIds: ['c1'], key: rk, ranges: [[0, 8]], originFrame: 30 }]);
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1']), 30 + 8 * 15 + 14).length, 1, 'last frame of segment 8 (frame 164)');
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1']), 30 + 9 * 15), [], 'segment 9 (from frame 165) is not fetched yet: no stream plane on this tick (this layer still swaps snapshots as before)');
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1']), 29), [], 'frame 29 is before the first frame of this stream: no segments');
  const d = src.debug();
  assert.equal(d.streams[0].ready, 9);
  assert.equal(d.streamFetches, 4 + 6);
  src.stop();
});

test('refetch when the manifest is not full: the range grows once the missing segments are filled in; the file is swapped once sparse segments become full density', async () => {
  const w = world();
  const rk = RK(0xa);
  w.putStream(rk, 0, 7, { segs: [0, 1] });
  w.putMap([row()]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 1]]);
  const count = () => w.requests.filter((r) => r.key === `${rk}:0-7`).length;
  const n0 = count();
  await w.settle(src);
  assert.equal(count(), n0, `no refetch before ${MANIFEST_POLL_MS} ms`);
  // Node produced segment 2 again (sparse)
  const sparse = w.putStream(rk, 0, 7, { segs: [0, 1, 2], tag: 'v1' });
  const body = w.content.get(`${rk}:0-7`);
  const sparseBytes = bytesOf('seg sparse 2');
  body.segments[2] = { ...body.segments[2], hash: sha(sparseBytes), stride: 3, samples: 5 };
  w.bytes.set(sha(sparseBytes), sparseBytes);
  w.now += MANIFEST_POLL_MS;
  await w.settle(src);
  assert.ok(count() > n0, 'refetch when due');
  assert.deepEqual(last(streamMessages()).ranges, [[0, 2]]);
  assert.equal(src.streamPlane(rk).manifest.segments['2'].stride, 3);
  assert.equal(src.streamPlane(rk).manifest.segments['2'].file, sha(sparseBytes));
  const revSparse = src.streamRev;
  // Sparse segment replaced by full density: ready interval does not change by a word, file changed,
  // streamRev changes accordingly (parent page resends stream plane based on this)
  w.putStream(rk, 0, 7, { segs: [0, 1, 2] });
  w.now += MANIFEST_POLL_MS;
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 2]]);
  assert.equal(src.streamPlane(rk).manifest.segments['2'].stride, 1);
  assert.equal(src.streamPlane(rk).manifest.segments['2'].file, sparse.hashes[2]);
  assert.ok(src.streamRev > revSparse);
  src.stop();
});

test('candidate switching: the copy that task.done marks as live comes first; the copy voided by superseded is not used', async () => {
  const w = world();
  const rkA = RK(0xa), rkB = RK(0xb);
  w.putStream(rkA, 0, 7, { segs: [0] });
  w.putStream(rkB, 0, 7, { segs: [0, 1, 2], tag: 'browser' });
  w.putMap([row({ candidates: [{ envFingerprint: 'fp-a', resultKey: rkA }, { envFingerprint: 'fp-b', resultKey: rkB }] })]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.equal(last(streamMessages()).key, rkA, 'take the first candidate when none is marked');
  assert.deepEqual(last(streamMessages()).ranges, [[0, 0]]);
  // Browser node copy reports completion (fine-grained task id: stream:<result key>:<start>-<end>)
  src.noteQueueEvent({ type: 'task.done', id: `stream:${rkB}:0-7` });
  await w.settle(src);
  assert.equal(last(streamMessages()).key, rkB, 'switch the whole stream to the live candidate');
  assert.deepEqual(last(streamMessages()).ranges, [[0, 2]]);
  assert.equal(src.debug().streams[0].envFingerprint, 'fp-b');
  assert.equal(src.streamPlane(rkA), null, 'unselected candidate gets no stage');
  src.stop();

  // Another page: only received "A's copy was invalidated"
  const w2 = world();
  w2.putStream(rkA, 0, 7, { segs: [0] });
  w2.putStream(rkB, 0, 7, { segs: [0, 1], tag: 'browser' });
  w2.putMap([row({ candidates: [{ envFingerprint: 'fp-a', resultKey: rkA }, { envFingerprint: 'fp-b', resultKey: rkB }] })]);
  const two = w2.source();
  // Sparse stream task ID has an extra `:sparse` at the end, but still recognizes the result key
  two.src.noteQueueEvent({ type: 'task.failed', id: `stream:${rkA}:0-7:sparse`, error: 'superseded' });
  await w2.settle(two.src);
  assert.equal(last(two.streamMessages()).key, rkB);
  two.src.stop();
});

test('stale signature: the row\'s inputSig does not match what the page computes for the current project; this stream is withdrawn and no longer fetched; once it matches again it is sent as before', async () => {
  const w = world();
  const rk = RK(0xa);
  const project = (text) => ({ id: 'p1', width: 1920, height: 1080, fps: 30, duration: 10, tracks: [{ id: 't', clips: [{ id: 'c1', cardId: 'punch-pill', start: 1, end: 9, params: { text } }] }] });
  const v1 = project('one');   // Clip starts at 1s (frame 30), which is exactly this row's originFrame
  w.putStream(rk, 0, 7);
  w.putMap([row({ inputSig: streamInputSig(v1, { clipIds: ['c1'], kind: 'card' }) })]);
  const { src, streamMessages } = w.source();
  src.setInputs(v1);
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 2]]);
  // Page changed parameters: old stream retracted immediately (sends empty layer)
  src.setInputs(project('two'));
  assert.deepEqual(last(streamMessages()), { type: 'layer', clipId: 'c1', kind: 'stream', key: rk, ranges: [] });
  assert.equal(src.streamPlane(rk), null);
  assert.deepEqual(src.debug().staleStreams, ['c1']);
  const asked = w.requests.length, got = w.fetches.length;
  src.focus(3, 30);
  await w.settle(src);
  assert.equal(w.requests.filter((r, i) => i >= asked && r.kind === 'render-manifest').length, 0, 'stale stream no longer fetches the manifest');
  assert.equal(w.fetches.length, got, 'nor fetches chunks');
  // Translating clip by whole frames also counts as expired: clip position on timeline is still in
  // input signature ("streams do not expire after moving" recorded as TODO, not done this time)
  src.setInputs({ ...v1, tracks: [{ id: 't', clips: [{ ...v1.tracks[0].clips[0], start: 2, end: 10 }] }] });
  assert.equal(src.streamPlane(rk), null);
  // Changed back to original: send as usual
  src.setInputs(project('one'));
  assert.equal(last(streamMessages()).key, rk);
  assert.ok(last(streamMessages()).ranges.length > 0);
  // Row without signature (written by node that cannot calculate signature): play as usual
  w.putMap([row()]);
  w.now += LAYER_MAP_POLL_MS;
  src.setInputs(project('three'));
  await w.settle(src);
  assert.ok(last(streamMessages()).ranges.length > 0);
  src.stop();
});

test('missing chunk: a segment that the asset service does not have is not ready, fetch again after a while; connect once it is filled in', async () => {
  const w = world();
  const rk = RK(0xa);
  const a = w.putStream(rk, 0, 7);
  const lost = w.bytes.get(a.hashes[1]);
  w.bytes.delete(a.hashes[1]);
  w.putMap([row()]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 0], [2, 2]], 'segment 1 cannot be fetched: the range breaks here');
  assert.equal(Object.keys(src.streamPlane(rk).manifest.segments).join(), '0,2', 'the manifest given to the stage does not list it either');
  assert.ok(src.debug().streamFailures >= 1);
  const tries = () => w.fetches.filter((f) => f.url.endsWith(a.hashes[1])).length;
  const n0 = tries();
  await w.settle(src);
  assert.equal(tries(), n0, `no refetch within ${STREAM_RETRY_MS} ms after a failure`);
  w.bytes.set(a.hashes[1], lost);
  w.now += STREAM_RETRY_MS;
  await w.settle(src);
  assert.ok(tries() > n0);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 2]]);
  src.stop();
});

test('head file cannot be fetched: segments that use it are not ready', async () => {
  const w = world();
  const rk = RK(0xa);
  const a = w.putStream(rk, 0, 7);
  w.bytes.delete(a.initHash);
  w.putMap([row()]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.deepEqual(streamMessages(), [], 'no segment is ready: layer that sends no stream');
  assert.equal(src.streamPlane(rk), null);
  src.stop();
});

test('ticket expired: after the chunk fetch is rejected, refetch with the new ticket', async () => {
  const w = world();
  const rk = RK(0xa);
  w.putStream(rk, 0, 7, { segs: [0] });
  w.putMap([row()]);
  w.accepts = (auth) => auth === 'Bearer T2';   // Asset service only accepts new ticket, page still holds the old one
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.deepEqual(streamMessages(), []);
  assert.ok(w.fetches.length >= 2 && w.fetches.every((f) => f.auth === 'Bearer T1'));
  w.ticket = 'T2';   // Ticket renewed (in the page, `assetAuthHeaders` renews itself)
  w.now += STREAM_RETRY_MS;
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 0]]);
  assert.ok(w.fetches.some((f) => f.auth === 'Bearer T2'));
  src.stop();
});

test('bytes do not match the hash: not accepted, not ready', async () => {
  const w = world();
  const rk = RK(0xa);
  const a = w.putStream(rk, 0, 7, { segs: [0, 1] });
  w.bytes.set(a.hashes[1], bytesOf('not the bytes of this segment'));
  w.putMap([row()]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 0]]);
  src.stop();
});

test('streamPlane: the manifest given to the stage lists only segments whose bytes are on this page, the segment\'s file is a hash, the head file carries a hash; blocks are exactly the chunks in use', async () => {
  const w = world();
  const rk = RK(0xa);
  const a = w.putStream(rk, 0, 7);
  w.putMap([row()]);
  const { src } = w.source();
  await w.settle(src);
  const plane = src.streamPlane(rk);
  assert.equal(plane.manifest.streamKey, rk);
  assert.equal(plane.manifest.kind, 'card');
  assert.equal(plane.manifest.plane, 'local');
  assert.deepEqual(plane.manifest.clipIds, ['c1']);
  assert.equal(plane.manifest.fps, 30);
  assert.equal(plane.manifest.segmentFrames, SEGMENT_FRAMES);
  assert.equal(plane.manifest.originFrame, 30, 'the first frame in the manifest comes from that row of the layer table (as given for the current project)');
  assert.deepEqual(plane.manifest.bound, { x: -32, y: -32, w: 704, h: 424 });
  assert.equal(plane.manifest.tight, null);
  assert.deepEqual(plane.manifest.inits, { [a.id]: { codec: 'avc1.640028', width: 704, height: 864, rect: { x: -32, y: -32, w: 704, h: 424 }, hash: a.initHash } });
  assert.deepEqual(plane.manifest.segments, Object.fromEntries([0, 1, 2].map((n) => [n, { init: a.id, file: a.hashes[n], stride: 1, samples: 15 }])));
  assert.deepEqual(new Set(plane.blocks.keys()), new Set([a.initHash, a.hashes[0], a.hashes[1], a.hashes[2]]));
  assert.deepEqual([...plane.blocks.get(a.hashes[1])], [...w.bytes.get(a.hashes[1])], 'bytes unchanged');
  assert.equal(src.streamPlane(rk), plane, 'returns the same instance when unchanged (not rebuilt every tick)');
  assert.equal(src.streamPlane(RK(0xdead)), null);
  src.stop();
});

test('group stream: the ready message carries groupClipIds, attached to the topmost card', async () => {
  const w = world();
  const rk = RK(0xc);
  w.putStream(rk, 0, 7, { clipIds: ['c1', 'c2'], kind: 'group' });
  w.putMap([row({ topClipId: 'c2', clipIds: ['c1', 'c2'], kind: 'group', plane: 'stage', candidates: [{ envFingerprint: 'fp-a', resultKey: rk }], originFrame: 0, lastSegment: 7 })]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.deepEqual(last(streamMessages()), { type: 'layer', clipId: 'c2', kind: 'stream', key: rk, ranges: [[0, 4]], originFrame: 0, groupClipIds: ['c1', 'c2'] });
  assert.equal(src.streamPlane(rk).manifest.kind, 'group');
  assert.equal(src.streamPlane(rk).manifest.plane, 'stage');
  // Pure computation on parent page: this plane exists only when both members are suppressed
  const index = new Map();
  for (const m of streamMessages()) applyReadyMessage(index, m);
  const layers = [...index].map(([clipId, byKind]) => ({ clipId, ...byKind.get('stream') }));
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1', 'c2']), 0).map((p) => p.clipIds), [['c1', 'c2']]);
  assert.deepEqual(streamPlanesFor(layers, new Set(['c2']), 0), []);
  src.stop();
});

test('new subscriber: reset first, then send in full the layers of all streams held; streams withdrawn from the layer table send empty layers', async () => {
  const w = world();
  const rk = RK(0xa);
  w.putStream(rk, 0, 7);
  w.putMap([row()]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  const late = [];
  src.subscribeReady('online', 0, (m) => late.push(m));
  assert.deepEqual(late, [{ type: 'reset', localRev: 0 }, { type: 'layer', clipId: 'c1', kind: 'stream', key: rk, ranges: [[0, 2]], originFrame: 30 }]);
  // Render node rewrote layer table, this stream no longer exists (this card reclassified as light)
  w.putMap([]);
  w.now += LAYER_MAP_POLL_MS;
  await w.settle(src);
  assert.deepEqual(last(streamMessages()), { type: 'layer', clipId: 'c1', kind: 'stream', key: rk, ranges: [] });
  assert.equal(src.streamPlane(rk), null);
  src.stop();
});

test('lowest tier, browser has no VideoDecoder: streams are not consumed. Even with a streams table, no stream manifest is fetched and no stream layers are sent (treated as no streams)', async () => {
  const w = world();
  const rk = RK(0xa);
  w.putStream(rk, 0, 7);
  w.putMap([row()]);
  // Node has no VideoDecoder, default `browserDecodeSupport` returns "none"; explicitly inject
  // the same once again
  assert.equal(browserDecodeSupport.available(), false);
  assert.equal(await browserDecodeSupport.supports({ codec: 'avc1.640028', codedWidth: 704, codedHeight: 864 }), false);
  for (const opts of [{ tier: 'small' }, { tier: 'small', decodeSupport: { available: () => false, supports: async () => true } }]) {
    const before = w.requests.length;
    const { src, streamMessages } = w.source(opts);
    await w.settle(src);
    assert.equal(w.requests.slice(before).some((r) => r.kind === 'render-manifest'), false);
    assert.deepEqual(streamMessages(), []);
    assert.equal(w.fetches.length, 0);
    assert.deepEqual(src.debug().streams, []);
    src.stop();
  }
});

test('lowest tier, browser can decode: fetch streams the same way as other tiers (layer table, manifest, segments) and send the same ready messages; the smaller memory cap is used for stream bytes', async () => {
  const w = world();
  const rk = RK(0xa);
  const put = w.putStream(rk, 0, 7);
  w.putMap([row()]);
  const asked = [];
  const decodeSupport = { available: () => true, supports: async (c) => { asked.push(c); return true; } };
  const low = w.source({ tier: 'small', decodeSupport });
  low.src.focus(1, 30);   // Playhead at frame 30 = segment 0 of this stream
  await w.settle(low.src);
  await w.settle(low.src);
  const msg = last(low.streamMessages());
  assert.equal(msg.key, rk);
  assert.equal(msg.originFrame, 30);
  assert.ok(msg.ranges.length && msg.ranges[0][0] === 0, 'segments near the playhead are ready');
  assert.deepEqual(asked, [{ codec: 'avc1.640028', codedWidth: 704, codedHeight: 864 }], 'ask the browser only once per head file');
  const plane = low.src.streamPlane(rk);
  assert.ok(plane && plane.blocks.has(put.initHash) && plane.blocks.has(put.hashes[0]));
  assert.equal(plane.manifest.segments['0'].file, put.hashes[0], 'segments are fetched whole (chunks stored and read by hash)');
  // Fetched the same items as other tiers
  const w2 = world();
  w2.putStream(rk, 0, 7);
  w2.putMap([row()]);
  const normal = w2.source();
  normal.src.focus(1, 30);
  await w2.settle(normal.src);
  await w2.settle(normal.src);
  assert.deepEqual(last(low.streamMessages()), last(normal.streamMessages()));
  assert.deepEqual(w.fetches.map((f) => f.url).sort(), w2.fetches.map((f) => f.url).sort());
  assert.ok(SPARSE_STREAM_CACHE_MAX_BYTES < STREAM_CACHE_MAX_BYTES);
  low.src.stop();
  normal.src.stop();
});

test('lowest tier, browser does not support this stream\'s codec configuration: the manifest is still fetched, but segment bytes are not fetched and not ready (parent page treats it as no stream: falls back to the placeholder)', async () => {
  const w = world();
  const rk = RK(0xa);
  const put = w.putStream(rk, 0, 7);
  w.putMap([row()]);
  for (const supports of [async () => false, async () => { throw new Error('boom'); }]) {
    const before = w.fetches.length;
    const { src, streamMessages } = w.source({ tier: 'small', decodeSupport: { available: () => true, supports } });
    src.focus(1, 30);
    await w.settle(src);
    await w.settle(src);
    assert.deepEqual(streamMessages().filter((m) => m.ranges.length), [], 'no ready segments');
    assert.equal(src.streamPlane(rk), null);
    assert.equal(w.fetches.slice(before).some((f) => f.url.endsWith(put.hashes[0])), false, 'undecodable stream does not fetch bytes');
    src.stop();
  }
});

test('BlockLru: counts by bytes, evicts the least recently used, returns the evicted keys', () => {
  const lru = new BlockLru(10);
  assert.deepEqual(lru.set('a', new Uint8Array(4)), []);
  assert.deepEqual(lru.set('b', new Uint8Array(4)), []);
  lru.get('a');
  assert.deepEqual(lru.set('c', new Uint8Array(4)), ['b'], 'a was just used, so b is evicted');
  assert.equal(lru.total, 8);
  assert.equal(lru.has('a') && lru.has('c') && !lru.has('b'), true);
  assert.deepEqual(lru.set('big', new Uint8Array(64)), ['a', 'c'], 'a single chunk exceeds the limit: keep that one chunk');
  assert.equal(lru.size, 1);
});

test('which segments to fetch is computed from each stream\'s own first frame: not fetched while the playhead has not reached the stream; two streams under the same playhead each fetch their own segments', async () => {
  const w = world();
  const far = RK(0xf1), near = RK(0xf2);
  // far starts at frame 400 (not a multiple of 15), near starts at frame 7
  w.putStream(far, 0, 7, { clipIds: ['c1'] });
  w.putStream(near, 0, 7, { clipIds: ['c2'] });
  w.putMap([
    row({ candidates: [{ envFingerprint: 'fp-a', resultKey: far }], originFrame: 400, lastSegment: 7 }),
    row({ topClipId: 'c2', clipIds: ['c2'], contentKey: 'sk-2', candidates: [{ envFingerprint: 'fp-a', resultKey: near }], originFrame: 7, lastSegment: 7 }),
  ]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  const lastOf = (key) => last(streamMessages().filter((m) => m.key === key));
  // Playhead at frame 0: window is frames 0-60. near (from frame 7) falls into its segments 0-3
  // (frames 7-66); far is still distant, do not fetch any segment
  assert.deepEqual(lastOf(near), { type: 'layer', clipId: 'c2', kind: 'stream', key: near, ranges: [[0, 3]], originFrame: 7 });
  assert.equal(lastOf(far), undefined, 'even 2 seconds ahead of the playhead cannot reach frame 400: not fetched, not sent');
  assert.equal(w.requests.some((r) => r.key === `${far}:0-7`), false);
  // Playhead at frame 405: 5th sample of segment 0 of far (frames 400-414); window is its
  // segments 0-4 (up to frame 465). near finished playing long ago
  src.focus(405 / 30, 30);
  await w.settle(src);
  assert.deepEqual(lastOf(far), { type: 'layer', clipId: 'c1', kind: 'stream', key: far, ranges: [[0, 4]], originFrame: 400 });
  const index = new Map();
  for (const m of streamMessages()) applyReadyMessage(index, m);
  const layers = [...index].map(([clipId, byKind]) => ({ clipId, ...byKind.get('stream') }));
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1', 'c2']), 405).map((p) => [p.clipIds[0], p.originFrame]), [['c1', 400]]);
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1', 'c2']), 399).map((p) => p.clipIds[0]), [], 'frame 399: far has not started, near\'s segment 26 does not exist');
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1', 'c2']), 7 + 3 * 15 + 14).map((p) => p.clipIds[0]), ['c2'], 'last frame of near\'s segment 3 (frame 66)');
  src.stop();
});

/* ---------------- Below-dependent stream (`kind: 'below'`; task brief `render-refactor-task.md` "Wu-2" "Lower layer 4") ---------------- */

/** Three tracks (first on top): title, frosted-glass card `glass` (from frame 30), animated card below */
const belowProject = (edit = (p) => p) => edit({ id: 'p1', width: 1920, height: 1080, fps: 30, duration: 20, media: [], tracks: [
  { id: 'top', clips: [{ id: 'title', cardId: 'c', start: 0, end: 10, params: { text: 'Title' } }] },
  { id: 'mid', clips: [{ id: 'glass', cardId: 'c', start: 1, end: 9, params: {}, frame: { x: 100, y: 100, w: 600, h: 300 } }] },
  { id: 'low', clips: [{ id: 'mover', cardId: 'c', start: 0, end: 10, params: { speed: 1 } }] },
] });
const belowRow = (p, over = {}) => row({ topClipId: 'glass', clipIds: ['glass'], kind: 'below', plane: 'stage', contentKey: 'sk-below',
  ...(p ? { inputSig: streamInputSig(p, { clipIds: ['glass'], kind: 'below' }) } : {}), ...over });

test('BO-parse parses the streams table: rows of streams that depend on a lower layer are recognized (one member, stage coordinates); malformed ones are skipped', () => {
  const good = belowRow(null);
  const parsed = parseLayerStreams([good, { ...good, plane: 'local' }, { ...good, clipIds: ['glass', 'mover'] }, { ...good, inputSig: 's1-x' }]);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { ...good, firstSegment: 0 });
  assert.equal(parsed[0].kind, 'below');
  assert.equal(parsed[0].plane, 'stage');
  assert.equal(parsed[1].inputSig, 's1-x');
});

test('BO-ready depends on the stream below: the ready message carries streamKind: below and the signature of that row in the layer table; the manifest kind given to the stage is below and plane is stage; the stream plane composed by the parent page carries plane: stage', async () => {
  const w = world();
  const rk = RK(0xb);
  const p = belowProject();
  const sig = streamInputSig(p, { clipIds: ['glass'], kind: 'below' });
  assert.ok(sig);
  w.putStream(rk, 0, 7, { clipIds: ['glass'], kind: 'below' });
  w.content.get(`${rk}:0-7`).header.plane = 'stage';
  w.putMap([belowRow(p, { candidates: [{ envFingerprint: 'fp-a', resultKey: rk }] })]);
  const { src, streamMessages } = w.source();
  src.setInputs(p);
  await w.settle(src);
  // Same shape as the layer sent by desktop prerender process (`belowLayerMark` in
  // `server/frame-stream.mjs`; fed to parent page by `src/editor/snapshotFeedBelow.test.mjs`)
  assert.deepEqual(last(streamMessages()), { type: 'layer', clipId: 'glass', kind: 'stream', key: rk, ranges: [[0, 2]], originFrame: 30, streamKind: 'below', inputSig: sig });
  const plane = src.streamPlane(rk);
  assert.equal(plane.manifest.kind, 'below');
  assert.equal(plane.manifest.plane, 'stage');
  assert.deepEqual(plane.manifest.clipIds, ['glass']);
  assert.equal(plane.manifest.originFrame, 30);
  // Pure computation on parent page: that layer in ready index carries streamKind, assembled
  // stream plane carries plane: stage (stage mounts canvas under stage root)
  const index = new Map();
  for (const m of streamMessages()) applyReadyMessage(index, m);
  const layer = index.get('glass').get('stream');
  assert.equal(layer.streamKind, 'below');
  assert.equal(layer.inputSig, sig);
  const planes = streamPlanesFor([{ clipId: 'glass', ...layer, plane: 'stage' }], new Set(['glass']), 40);
  assert.deepEqual(planes, [{ clipIds: ['glass'], key: rk, ranges: [[0, 2]], originFrame: 30, plane: 'stage' }]);
  assert.equal(src.debug().streams[0].kind, 'below');
  // Row without signature: message does not carry inputSig (parent page does not compare, pastes as usual)
  const w2 = world();
  w2.putStream(rk, 0, 7, { clipIds: ['glass'], kind: 'below' });
  w2.putMap([belowRow(null, { candidates: [{ envFingerprint: 'fp-a', resultKey: rk }] })]);
  const two = w2.source();
  two.src.setInputs(p);
  await w2.settle(two.src);
  assert.deepEqual(last(two.streamMessages()), { type: 'layer', clipId: 'glass', kind: 'stream', key: rk, ranges: [[0, 2]], originFrame: 30, streamKind: 'below' });
  src.stop(); two.src.stop();
});

test('BO-stale: the stream that depends on the lower layer goes stale: when the lower layer or the target card changes, the old stream is withdrawn and no longer fetched; changes to layers above never count; changing it back re-sends it', async () => {
  const w = world();
  const rk = RK(0xb);
  const p = belowProject();
  w.putStream(rk, 0, 7, { clipIds: ['glass'], kind: 'below' });
  w.putMap([belowRow(p, { candidates: [{ envFingerprint: 'fp-a', resultKey: rk }] })]);
  const { src, streamMessages } = w.source();
  src.setInputs(p);
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 2]]);
  const stale = {
    'lower layer changed one parameter': (q) => { q.tracks[2].clips[0].params = { speed: 2 }; return q; },
    'lower layer moved position': (q) => { q.tracks[2].clips[0].frame = { x: 10, y: 0, w: 1920, h: 1080 }; return q; },
    'A layer was added below': (q) => { q.tracks.push({ id: 'bg', clips: [{ id: 'bg', cardId: 'c', start: 0, end: 10, params: {} }] }); return q; },
    'A layer was removed below': (q) => { q.tracks.pop(); return q; },
    'The target card itself was moved': (q) => { q.tracks[1].clips[0].frame = { x: 300, y: 100, w: 600, h: 300 }; return q; },
  };
  for (const [what, edit] of Object.entries(stale)) {
    src.setInputs(belowProject(edit));
    assert.deepEqual(last(streamMessages()), { type: 'layer', clipId: 'glass', kind: 'stream', key: rk, ranges: [] }, what);
    assert.equal(src.streamPlane(rk), null, what);
    assert.deepEqual(src.debug().staleStreams, ['glass'], what);
    src.setInputs(belowProject());
    assert.deepEqual(last(streamMessages()).ranges, [[0, 2]], `${what}: re-sent after changing back`);
    assert.equal(last(streamMessages()).streamKind, 'below');
  }
  // Do not fetch manifests or chunks during this expired period
  src.setInputs(belowProject(stale['lower layer changed one parameter']));
  const asked = w.requests.length, got = w.fetches.length;
  src.focus(3, 30);
  await w.settle(src);
  assert.equal(w.requests.filter((r, i) => i >= asked && r.kind === 'render-manifest').length, 0);
  assert.equal(w.fetches.length, got);
  src.setInputs(belowProject());
  // Any changes to layers above do not count as expired
  const before = streamMessages().length;
  src.setInputs(belowProject((q) => { q.tracks[0].clips[0].params = { text: 'Other' }; q.tracks[0].clips[0].frame = { x: 5, y: 5, w: 100, h: 100 }; return q; }));
  src.setInputs(belowProject((q) => { q.tracks.shift(); return q; }));
  src.setInputs(belowProject((q) => { q.tracks.unshift({ id: 'over', clips: [{ id: 'over', cardId: 'c', start: 0, end: 10, params: {} }] }); return q; }));
  assert.ok(last(streamMessages()).ranges.length > 0);
  assert.equal(streamMessages().slice(before).some((m) => m.ranges.length === 0), false, 'never withdrawn');
  assert.deepEqual(src.debug().staleStreams, []);
  src.stop();
});

test('BO-lowest lowest tier: when the browser has no VideoDecoder, the stream that depends on the lower layer is not consumed; when it can be decoded, it follows the same flow as the other tiers (with streamKind and input signature)', async () => {
  const w = world();
  const rk = RK(0xb);
  w.putStream(rk, 0, 7, { clipIds: ['glass'], kind: 'below' });
  w.putMap([belowRow(null, { candidates: [{ envFingerprint: 'fp-a', resultKey: rk }] })]);
  const none = w.source({ tier: 'small' });
  await w.settle(none.src);
  assert.deepEqual(none.streamMessages(), []);
  assert.equal(w.requests.some((r) => r.kind === 'render-manifest'), false);
  none.src.stop();
  const low = w.source({ tier: 'small', decodeSupport: { available: () => true, supports: async () => true } });
  await w.settle(low.src);
  await w.settle(low.src);
  const normal = w.source();
  await w.settle(normal.src);
  await w.settle(normal.src);
  const a = last(low.streamMessages()), b = last(normal.streamMessages());
  assert.ok(a && a.ranges.length, 'the lowest tier fetched the stream that depends on the lower layer');
  assert.equal(a.streamKind, 'below');
  assert.deepEqual(a, b, 'sends the same ready message as the other tiers');
  low.src.stop();
  normal.src.stop();
});
