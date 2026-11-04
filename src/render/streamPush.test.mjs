/**
 * How stream bytes reach the stage on the online page (`StreamPlaneSender` / `PushedStreamSource`
 * in `streamPlayer.ts`; `docs/plan/browser-stream-task.md` item 7):
 * When parent page sends stream planes, it includes manifests and chunks not yet on this stage;
 * stage only takes from pushed chunks, without querying prerender process.
 * Run: node --test src/render/streamPush.test.mjs
 *
 * Decoding and compositing require a browser; fake root / canvas is used here, only pinning down
 * "bytes retrieved by hash", "what to do on missing chunks", "whether both sides reconcile", and
 * "planes with manifests do not touch other byte sources".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer, StreamPlaneSender, PushedStreamSource, manifestBlockHashes } from './streamPlayer.ts';

globalThis.CSS = { escape: (s) => s };

const H = (n) => n.toString(16).padStart(64, '0');
const buf = (...bytes) => new Uint8Array(bytes);
const flush = () => new Promise((r) => setTimeout(r, 0));

const INIT = H(0x1), INIT_ID = INIT.slice(0, 16);
/**
 * What a stream looks like in parent page's hands: manifest lists only `segs` segments, and
 * `blocks` are bytes for these segments and head file
 */
function planeData(key, segs, { drop = [] } = {}) {
  const segments = {};
  const blocks = new Map([[INIT, buf(9, 9)]]);
  for (const n of segs) {
    const hash = H(0x100 + n);
    segments[n] = { init: INIT_ID, file: hash, stride: 1, samples: 15 };
    blocks.set(hash, buf(n, n, n));
  }
  for (const hash of drop) blocks.delete(hash);
  return {
    manifest: { streamKey: key, kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, segmentFrames: 15, bound: { x: 0, y: 0, w: 300, h: 200 }, tight: null,
      inits: { [INIT_ID]: { codec: 'avc1.640028', width: 300, height: 416, rect: { x: 0, y: 0, w: 300, h: 200 }, hash: INIT } }, segments },
    blocks,
  };
}
const plane = (segs) => ({ clipIds: ['a'], key: 'K', ranges: segs.length ? [[segs[0], segs[segs.length - 1]]] : [], originFrame: 0 });

test('manifestBlockHashes: init file + segments; a desktop manifest (file names, no hash) lists no chunk at all', () => {
  assert.deepEqual(new Set(manifestBlockHashes(planeData('K', [0, 1]).manifest)), new Set([INIT, H(0x100), H(0x101)]));
  assert.deepEqual(manifestBlockHashes({ inits: { i: { codec: 'x', width: 1, height: 1, rect: { x: 0, y: 0, w: 1, h: 1 } } }, segments: { 0: { init: 'i', file: '0-abc.m4s', stride: 1, samples: 15 } } }), []);
  assert.deepEqual(manifestBlockHashes(null), []);
});

test('Fetch by hash: the first time carries the manifest and all chunks; the stage takes the init file and segments from the pushed chunks', async () => {
  let data = planeData('K', [0, 1]);
  const sender = new StreamPlaneSender((key) => (key === 'K' ? data : null));
  const stage = new PushedStreamSource();
  const sent = sender.decorate([plane([0, 1])]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].clipIds, ['a']);
  assert.equal(sent[0].key, 'K');
  assert.deepEqual(sent[0].ranges, [[0, 1]]);
  assert.equal(sent[0].manifest, data.manifest);
  assert.deepEqual(new Set(Object.keys(sent[0].blocks)), new Set([INIT, H(0x100), H(0x101)]));
  assert.ok(sent[0].blocks[INIT] instanceof ArrayBuffer, 'Chunks are ArrayBuffer (cloned to the stage via postMessage)');
  stage.accept(sent);
  assert.equal(await stage.manifest('K'), data.manifest);
  assert.deepEqual([...new Uint8Array(await stage.init('K', INIT_ID))], [9, 9]);
  assert.deepEqual([...new Uint8Array(await stage.segment('K', H(0x101)))], [1, 1, 1]);
  assert.equal(stage.size, 3);
  // Next tick unchanged: manifest included as usual, not a single chunk re-sent
  const again = sender.decorate([plane([0, 1])]);
  assert.equal(again[0].manifest, data.manifest);
  assert.equal('blocks' in again[0], false);
  stage.accept(again);
  assert.equal(stage.size, 3, 'The chunks held by the stage are still there');
  // Fetched one more segment: only send that new chunk
  data = planeData('K', [0, 1, 2]);
  const more = sender.decorate([plane([0, 1, 2])]);
  assert.deepEqual(Object.keys(more[0].blocks), [H(0x102)]);
  stage.accept(more);
  assert.deepEqual([...new Uint8Array(await stage.segment('K', H(0x102)))], [2, 2, 2]);
  assert.equal(sender.heldCount, 4);
});

test('Bookkeeping on both sides: chunks the manifest no longer uses are dropped by the stage immediately; when used again later, the parent page resends them', async () => {
  let data = planeData('K', [0, 1]);
  const sender = new StreamPlaneSender(() => data);
  const stage = new PushedStreamSource();
  stage.accept(sender.decorate([plane([0, 1])]));
  // Playhead advanced, only segments 1 and 2 remain in parent page's window
  data = planeData('K', [1, 2]);
  const next = sender.decorate([plane([1, 2])]);
  assert.deepEqual(Object.keys(next[0].blocks), [H(0x102)]);
  stage.accept(next);
  assert.equal(stage.has(H(0x100)), false, 'Segment 0 is no longer used by anyone: dropped');
  assert.equal(stage.has(H(0x101)) && stage.has(H(0x102)) && stage.has(INIT), true);
  // Scrub backwards: segment 0 needed again, parent page knows stage does not have it
  data = planeData('K', [0, 1]);
  const back = sender.decorate([plane([0, 1])]);
  assert.deepEqual(Object.keys(back[0].blocks), [H(0x100)]);
  stage.accept(back);
  assert.equal(stage.has(H(0x100)), true);
  // Pause: parent page sends empty list, stage drops all; re-sends all when playback resumes
  stage.accept(sender.decorate([]));
  assert.equal(stage.size, 0);
  assert.equal(sender.heldCount, 0);
  assert.equal(Object.keys(sender.decorate([plane([0, 1])])[0].blocks).length, 3);
});

test('Missing chunks: a manifest, init file or segment the stage does not hold is rejected immediately on fetch (that beat falls back to the snapshot), without waiting', async () => {
  const data = planeData('K', [0, 1], { drop: [H(0x101)] });   // Manifest lists segment 1, but bytes are not in parent page's hands
  const sender = new StreamPlaneSender(() => data);
  const stage = new PushedStreamSource();
  const sent = sender.decorate([plane([0, 1])]);
  assert.equal(H(0x101) in sent[0].blocks, false);
  stage.accept(sent);
  await assert.rejects(stage.segment('K', H(0x101)), (e) => e.status === 404);
  await assert.rejects(stage.manifest('nope'), (e) => e.status === 404);
  await assert.rejects(stage.init('K', 'ffffffffffffffff'), (e) => e.status === 404);
  await assert.rejects(new PushedStreamSource().init('K', INIT_ID), (e) => e.status === 404);
  assert.deepEqual([...new Uint8Array(await stage.segment('K', H(0x100)))], [0, 0, 0], 'Other segments are fetched as usual');
  // Parent page considers stage missing this chunk: re-sent after bytes arrive
  data.blocks.set(H(0x101), buf(1, 1, 1));
  assert.deepEqual(Object.keys(sender.decorate([plane([0, 1])])[0].blocks), [H(0x101)]);
});

test('The parent page has no manifest for this stream (not fetched yet): the plane is sent as is, without a manifest; after a failed call, the bookkeeping is cleared and everything is resent', () => {
  let data = null;
  const sender = new StreamPlaneSender(() => data);
  assert.deepEqual(sender.decorate([plane([0])]), [{ clipIds: ['a'], key: 'K', ranges: [[0, 0]], originFrame: 0 }]);
  assert.deepEqual(sender.decorate([{ clipIds: ['x'] }]), [{ clipIds: ['x'] }], 'A plane with no stream key (placeholder only) is not queried');
  data = planeData('K', [0]);
  assert.equal(Object.keys(sender.decorate([plane([0])])[0].blocks).length, 2);
  assert.equal('blocks' in sender.decorate([plane([0])])[0], false);
  sender.reset();   // Not delivered this time (stage is reloading)
  assert.equal(Object.keys(sender.decorate([plane([0])])[0].blocks).length, 2);
});

test('Two planes use the same chunk (the same stream attached to two cards): send only one copy at a time', () => {
  const data = planeData('K', [0]);
  const sender = new StreamPlaneSender(() => data);
  const sent = sender.decorate([{ clipIds: ['a'], key: 'K', ranges: [[0, 0]], originFrame: 0 }, { clipIds: ['b'], key: 'K', ranges: [[0, 0]], originFrame: 0 }]);
  assert.equal(Object.keys(sent[0].blocks).length, 2);
  assert.equal('blocks' in sent[1], false);
  const stage = new PushedStreamSource();
  stage.accept(sent);
  assert.equal(stage.size, 2);
});

/* ---------------- Player: planes with manifests do not touch other byte sources ---------------- */

const fakeCanvas = () => ({ getContext: () => null, style: { getPropertyValue: () => '', setProperty() {} }, width: 0, height: 0, parentElement: null });
const fakeRoot = (canvases) => ({ querySelector(sel) { const m = /^\[data-pc-clip="(.+?)"\] > canvas\[data-pc-stream-plane\]$/.exec(sel); return m ? canvases[m[1]] ?? null : null; } });
function spySource() {
  const calls = [];
  const never = () => new Promise(() => {});
  return { calls, manifest: (k) => { calls.push(['manifest', k]); return never(); }, init: (k, id) => { calls.push(['init', k, id]); return never(); }, segment: (k, f) => { calls.push(['segment', k, f]); return never(); } };
}

test('Stream plane with a manifest: the manifest takes effect immediately, segments are requested from the pushed chunks by hash; the prerender process\'s byte source is never asked', async () => {
  const data = planeData('K', [0, 1]);
  const http = spySource();
  const player = new StreamPlayer({ root: () => fakeRoot({ a: fakeCanvas() }), source: http });
  const asked = [];
  const segment = player.pushed.segment.bind(player.pushed);
  player.pushed.segment = (key, file) => { asked.push(file); return segment(key, file); };
  player.setPlanes(new StreamPlaneSender(() => data).decorate([plane([0, 1])]), 30);
  player.present(0);
  await flush();
  const [track] = player.diag().tracks;
  assert.equal(track.pushed, true);
  assert.equal(track.manifest, true, 'No need to wait for a manifest request');
  assert.deepEqual(track.bound, { x: 0, y: 0, w: 300, h: 200 });
  assert.deepEqual(asked, [H(0x100)], 'segment 0 asks for the pushed chunk by hash');
  assert.deepEqual(http.calls, [], 'a plane that carries a manifest does not touch the prerender process address');
  assert.deepEqual(player.diag().pushed, { blocks: 3, bytes: 2 + 3 + 3 });
  // Pause: parent page sends empty list, stream closed, pushed chunks all dropped
  player.setPlanes([], 30);
  assert.deepEqual(player.diag().pushed, { blocks: 0, bytes: 0 });
  assert.equal(player.diag().tracks.length, 0);
});

test('parent page brings a new manifest (more segments): the same track is swapped in place, not rebuilt', async () => {
  let data = planeData('K', [0]);
  const sender = new StreamPlaneSender(() => data);
  const player = new StreamPlayer({ root: () => fakeRoot({ a: fakeCanvas() }), source: spySource() });
  const asked = [];
  const segment = player.pushed.segment.bind(player.pushed);
  player.pushed.segment = (key, file) => { asked.push(file); return segment(key, file).catch((e) => { asked.push('rejected'); throw e; }); };
  player.setPlanes(sender.decorate([plane([0])]), 30);
  player.present(0);
  await flush();
  const seeks = player.diag().tracks[0].seeks;
  // Play reaches segment 1: not yet in manifest (parent page not fetched yet) → no stream frame this
  // tick, no error
  player.setPlanes(sender.decorate([{ clipIds: ['a'], key: 'K', ranges: [[0, 1]], originFrame: 0 }]), 30);
  player.present(15 / 30);
  await flush();
  assert.deepEqual([...player.showingClips()], []);
  // Parent page fetched segment 1, re-sends with new manifest
  data = planeData('K', [0, 1]);
  player.setPlanes(sender.decorate([{ clipIds: ['a'], key: 'K', ranges: [[0, 1]], originFrame: 0 }]), 30);
  player.present(16 / 30);
  await flush();
  assert.ok(asked.includes(H(0x101)), 'the new manifest has segment 1: go request its bytes');
  assert.equal(asked.includes('rejected'), false);
  assert.equal(player.diag().tracks.length, 1);
  assert.ok(player.diag().tracks[0].seeks >= seeks, 'still the same track as before');
});

test('desktop stream plane (no manifest) still asks the player\'s byte source', async () => {
  const http = spySource();
  const player = new StreamPlayer({ root: () => fakeRoot({ a: fakeCanvas() }), source: http });
  player.setPlanes([{ clipIds: ['a'], key: 'K', ranges: [[0, 0]], originFrame: 0 }], 30);
  player.present(0);
  await flush();
  assert.deepEqual(http.calls, [['manifest', 'K']]);
  assert.equal(player.diag().tracks[0].pushed, false);
});
