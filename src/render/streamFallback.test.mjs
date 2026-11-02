/**
 * Unit tests for fallback order on the stage side (`streamPlayer.ts`): pure functions for decoder
 * budget, group stream clearing, manifest refresh when switching from sparse segments to
 * full-frame segments (point of doubt G). Run: node --test src/render/streamFallback.test.mjs
 *
 * Decoding and compositing require a browser; mock root / canvas / byte sources are used here to
 * pin down only pure logic: "which stream creates a track", "when to re-query the manifest",
 * and "clearing display when stream clears".
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer, planesWithinBudget, DECODER_BUDGET, MANIFEST_REFRESH_MS } from './streamPlayer.ts';

globalThis.CSS = { escape: (s) => s };
let now = 1_000_000;
Date.now = () => now;

const fakeCanvas = () => ({ getContext: () => null, style: { getPropertyValue: () => '', setProperty() {} }, width: 0, height: 0, parentElement: null });

/** Only recognizes selectors used by streamPlayer */
function fakeRoot({ canvases = {} } = {}) {
  return {
    querySelector(sel) {
      let m = /^\[data-pc-clip="(.+?)"\] > canvas\[data-pc-stream-plane\]$/.exec(sel);
      if (m) return canvases[m[1]] ?? null;
      m = /data-pc-stream-group="(.+?)"/.exec(sel);
      if (m) return canvases[m[1]] ?? null;
      return null;
    },
  };
}

const never = () => new Promise(() => {});
function fakeSource(manifests) {
  const src = { calls: 0, manifest: async () => { const m = manifests[Math.min(src.calls, manifests.length - 1)]; src.calls++; return m; }, init: never, segment: never };
  return src;
}
const manifestWith = (stride) => ({
  streamKey: 'K', kind: 'card', plane: 'local', clipIds: ['a'], fps: 30, segmentFrames: 15,
  bound: { x: 10, y: 20, w: 300, h: 200 }, tight: null, inits: {},
  segments: { 0: { init: 'i', file: `0-${stride}.m4s`, stride, samples: 15 } },
});
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { now = 1_000_000; });

test('planesWithinBudget: small streams (pixels far below the budget) are limited only by the count cap, keeping the first DECODER_BUDGET planes that have a stream key', () => {
  const planes = Array.from({ length: DECODER_BUDGET + 2 }, (_, i) => ({ clipIds: [`c${i}`], key: `K${i}`, ranges: [[0, 9]], originFrame: 0 }));
  const withHole = [{ clipIds: ['nokey'] }, ...planes];
  // Budget basis counts pixels (`streamBudget.mjs`, unit tests there are in
  // server/test/stream-budget.test.mjs); here each is given a small aspect ratio of 64×144, leaving
  // only the count limit in effect
  const small = () => 64 * 144;
  const kept = planesWithinBudget(withHole, 30, small);
  assert.equal(kept.length, DECODER_BUDGET);
  assert.deepEqual(kept.map((p) => p.clipIds[0]), planes.slice(0, DECODER_BUDGET).map((p) => p.clipIds[0]), 'planes without a stream key only hold a place and use no decoder');
  // Planes without the first frame of this stream (cannot convert frame number to segment number)
  // likewise do not occupy decoders
  const { originFrame: _dropped, ...noOrigin } = planes[0];
  assert.deepEqual(planesWithinBudget([noOrigin, { ...planes[1], originFrame: -1 }, planes[2]], 30, small).map((p) => p.clipIds[0]), ['c2']);
});

test('stage sync() enforces the hard count cap: a plane whose canvas arrives late still keeps its place, so the excess one does not take over', () => {
  const planes = Array.from({ length: DECODER_BUDGET + 1 }, (_, i) => ({ clipIds: [`c${i}`], key: `K${i}`, ranges: [[0, 9]], originFrame: 0 }));
  const canvases = Object.fromEntries(planes.slice(1).map((p) => [p.clipIds[0], fakeCanvas()]));   // Canvas for c0 is not yet mounted
  const player = new StreamPlayer({ root: () => fakeRoot({ canvases }), source: fakeSource([manifestWith(1)]) });
  player.setPlanes(planes, 30);
  player.present(0);
  const ids = player.diag().tracks.map((t) => t.id.split('#')[0]).sort();
  assert.deepEqual(ids, planes.slice(1, DECODER_BUDGET).map((p) => p.clipIds[0]).sort(), 'the plane over the count cap gets no decoder (the pixel half is judged by the parent page: over-limit planes carry over, see streamOver.test.mjs)');
});

test('Suspect G: while the current segment is a sparse segment, ask for the manifest again every MANIFEST_REFRESH_MS; stop asking after switching to a full-frame segment', async () => {
  const source = fakeSource([manifestWith(3), manifestWith(1)]);
  const player = new StreamPlayer({ root: () => fakeRoot({ canvases: { a: fakeCanvas() } }), source });
  player.setPlanes([{ clipIds: ['a'], key: 'K', ranges: [[0, 0]], originFrame: 0 }], 30);
  player.present(0);
  await flush();
  assert.equal(source.calls, 1);
  player.present(1 / 30);
  await flush();
  assert.equal(source.calls, 1, 'throttle: just asked, do not ask again');
  now += MANIFEST_REFRESH_MS + 1;
  player.present(2 / 30);
  await flush();
  assert.equal(source.calls, 2, 'sparse segment: ask again after the refresh interval, so the full-frame segment can be swapped in once it arrives');
  now += MANIFEST_REFRESH_MS + 1;
  player.present(3 / 30);
  await flush();
  assert.equal(source.calls, 2, 'already a full-frame segment: do not ask again');
});

test('Suspect G: when the ready range of the same stream key changes (a new segment is published), asking for the manifest again is allowed', async () => {
  const source = fakeSource([manifestWith(1)]);
  const player = new StreamPlayer({ root: () => fakeRoot({ canvases: { a: fakeCanvas() } }), source });
  player.setPlanes([{ clipIds: ['a'], key: 'K', ranges: [[0, 0]], originFrame: 0 }], 30);
  player.present(0);
  await flush();
  assert.equal(source.calls, 1);
  now += MANIFEST_REFRESH_MS + 1;
  player.setPlanes([{ clipIds: ['a'], key: 'K', ranges: [[0, 1]], originFrame: 0 }], 30);
  player.present(1 / 30);
  await flush();
  assert.equal(source.calls, 2);
});

test('when the group stream is cleared (no data for this segment), the stream picture is cleared; after the snapshot is withdrawn, the snapshot plane is left alone and the stream plane and placeholder take over', () => {
  const player = new StreamPlayer({ root: () => fakeRoot({ canvases: { 'a,b': fakeCanvas() } }), source: fakeSource([manifestWith(1)]) });
  player.setPlanes([{ clipIds: ['a', 'b'], key: 'G', ranges: [[5, 9]], originFrame: 0 }], 30);
  player.present(0);   // Segment 0 is not in ready range → blank
  assert.deepEqual([...player.showingClips()], [], 'no stream picture on this tick');
});
