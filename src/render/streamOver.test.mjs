/**
 * Over-budget stream planes (`OverPlane` in `streamPlayer.ts`): stage does not create decoders for
 * them, only fetches manifests, positioning placeholders according to the position rectangle of
 * the segment containing this frame in the manifest (mechanism/rendering.md "Heavy pipeline:
 * prerender": placeholder position takes the position rectangle from stream manifest).
 * Run: npm test -- src/render/streamOver.test.mjs
 *
 *   - Position rectangle of a single-card stream is wrapper layer's own coordinates (`boxOf`);
 *     group streams and below-dependent streams use stage coordinates (`stageBoxOf`, plus manifest
 *     `offset`);
 *   - No manifest or this segment was not measured: returns null (placeholder positioned via old
 *     method);
 *   - Playhead enters next segment, manifest arrives: notify host once (placeholder geometry is
 *     retrieved at render time);
 *   - Online page: over-budget planes carry only manifests, no bytes;
 *   - Convert stage coordinates to wrapper layer coordinates (`stageBoxToLocal` in
 *     `placeholderHost.ts`).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer, StreamPlaneSender, MANIFEST_REFRESH_MS } from './streamPlayer.ts';
import { stageBoxToLocal, keepTopOfGroups, geometryFor, resetPlaceholderGeometry, setOverBoxSource, setStreamBoxSource } from './placeholderHost.ts';

globalThis.CSS = { escape: (s) => s };
let now = 1_000_000;
globalThis.__pcRealNow = () => now;
globalThis.__pcRealSetTimeout = () => 0;

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const never = () => new Promise(() => {});
const FPS = 30;

/** A manifest: first frame at `originFrame`, each segment with (or without) a position rectangle */
function manifestOf({ kind = 'card', plane = 'local', clipIds = ['a'], boxes = {}, offset = { x: 0, y: 0 } } = {}) {
  const segments = {};
  for (const [n, box] of Object.entries(boxes)) segments[n] = { init: 'i', file: `${n}.m4s`, stride: 15, samples: 15, ...(box ? { box } : {}) };
  return { streamKey: 'K', kind, plane, clipIds, fps: FPS, segmentFrames: 15, bound: { x: -32, y: -32, w: 704, h: 424 }, tight: null, offset, inits: {}, segments };
}
function sourceOf(manifests) {
  const src = { calls: [], manifest: async (key) => { src.calls.push(key); const m = manifests[key]; if (!m) throw new Error('404'); return typeof m === 'function' ? m() : m; }, init: never, segment: never };
  return src;
}
const root = { querySelector: () => null, contains: () => false };

beforeEach(() => { now = 1_000_000; });

test('single-card stream over budget: no decoder is created; the placeholder rectangle is the box of the segment containing this frame in the manifest (wrapper layer coordinates) and follows the playhead; the host is notified once when it changes', async () => {
  const boxes = { 0: { x: 10, y: 20, w: 300, h: 200 }, 1: { x: 40, y: 20, w: 300, h: 200 }, 2: null };
  const source = sourceOf({ S: manifestOf({ boxes }) });
  let changed = 0;
  const player = new StreamPlayer({ root: () => root, source, onBoxChange: () => { changed++; } });
  // Clip starts from frame 100: segment 0 is 100-114, segment 1 is 115-129
  player.setPlanes([], FPS, [{ clipIds: ['a'], key: 'S', ranges: [[0, 2]], originFrame: 100, over: true }]);
  assert.equal(player.hasOver, true);
  assert.equal(player.overBoxOf('a'), null, 'no tick has run yet and the manifest has not arrived');
  assert.equal(player.boxOf('a'), null, 'boxOf only handles streams within budget');
  player.present(107 / FPS);
  await flush();
  assert.deepEqual(source.calls, ['S'], 'fetch the manifest only');
  assert.equal(player.diag().tracks.length, 0, 'no decoder and no track created');
  assert.deepEqual(player.overBoxOf('a'), boxes[0]);
  assert.equal(player.stageBoxOf('a'), null, 'the rectangle of a single-card stream is not in stage coordinates');
  assert.equal(changed, 1, 'manifest arrived: notify the host to refetch once');

  player.present(114 / FPS);
  await flush();
  assert.deepEqual(player.overBoxOf('a'), boxes[0]);
  assert.equal(changed, 1, 'still in the same segment: no notification');

  player.present(115 / FPS);
  await flush();
  assert.deepEqual(player.overBoxOf('a'), boxes[1], 'entered the next segment');
  assert.equal(changed, 2);
  assert.deepEqual(source.calls, ['S'], 'This segment has a rect: do not ask for the manifest again');

  // Segment 2 is in manifest, just unmeasured (unmeasured segments on desktop won't have rectangles
  // later either): returns null (placeholder positioned via old method), **never queries manifest
  // again**
  player.present(130 / FPS);
  await flush();
  assert.equal(player.overBoxOf('a'), null);
  assert.equal(changed, 3);
  for (let f = 131; f < 140; f++) { now += MANIFEST_REFRESH_MS + 1; player.present(f / FPS); await flush(); }
  assert.equal(source.calls.length, 1, 'The manifest already has this segment but no rect: do not fetch the manifest again while playing');
  // Segment 3 not yet in manifest (manifest in hand is stale): query again after a bit; once
  // obtained, it will have a rectangle
  boxes[3] = { x: 70, y: 20, w: 300, h: 200 };
  const fresh = manifestOf({ boxes });
  const stale = manifestOf({ boxes: { 0: boxes[0], 1: boxes[1], 2: null } });
  let served = stale;
  source.manifest = async (key) => { source.calls.push(key); return served; };
  player.setPlanes([], FPS, []);
  await flush();
  const player2 = new StreamPlayer({ root: () => root, source });
  player2.setPlanes([], FPS, [{ clipIds: ['a'], key: 'S', ranges: [[0, 3]], originFrame: 100, over: true }]);
  player2.present(146 / FPS);
  await flush();
  assert.equal(source.calls.length, 2);
  assert.equal(player2.overBoxOf('a'), null, 'The old manifest has no segment 3');
  player2.present(147 / FPS);
  await flush();
  assert.equal(source.calls.length, 2, 'Interval not reached: do not ask');
  served = fresh;
  now += MANIFEST_REFRESH_MS + 1;
  player2.present(148 / FPS);
  await flush();
  assert.equal(source.calls.length, 3, 'The manifest does not have this segment yet: ask again after a while');
  assert.deepEqual(player2.overBoxOf('a'), boxes[3]);
  player2.stop();

  // This tick is no longer over budget (parent page no longer flags over): clear, notify host once
  player.setPlanes([], FPS, []);
  await flush();
  assert.equal(player.hasOver, false);
  assert.equal(player.overBoxOf('a'), null);
  assert.equal(changed, 3, 'There was no rect to begin with: no need for the host to refetch');
});

test('Group streams over budget and streams that depend on a lower layer: the rect is in stage coordinates and every member can get it; ignore it when the coordinate system in the manifest does not match the plane', async () => {
  const box = { x: 500, y: 300, w: 640, h: 360 };
  const source = sourceOf({
    G: manifestOf({ kind: 'group', plane: 'stage', clipIds: ['a', 'b'], boxes: { 0: box } }),
    B: manifestOf({ kind: 'below', plane: 'stage', clipIds: ['glass'], boxes: { 0: box }, offset: { x: 4, y: 6 } }),
    W: manifestOf({ kind: 'card', plane: 'local', clipIds: ['wrong'], boxes: { 0: box } }),
  });
  const player = new StreamPlayer({ root: () => root, source });
  player.setPlanes([
    { clipIds: ['a', 'b'], key: 'G', ranges: [[0, 0]], originFrame: 0, over: true },
    { clipIds: ['glass'], key: 'B', ranges: [[0, 0]], originFrame: 0, plane: 'stage', over: true },
    { clipIds: ['wrong'], key: 'W', ranges: [[0, 0]], originFrame: 0, plane: 'stage', over: true },   // Parent page indicates stage coordinates, manifest indicates wrapper layer coordinates
  ], FPS);
  player.present(0);
  await flush();
  assert.equal(player.diag().tracks.length, 0, 'Even if one marked over arrives mixed into the stream planes, no decoder is created');
  assert.equal(player.overBoxOf('a'), null, 'A rect in stage coordinates is not returned as wrapper-layer coordinates');
  assert.deepEqual(player.stageBoxOf('a'), box);
  assert.deepEqual(player.stageBoxOf('b'), box);
  assert.deepEqual(player.stageBoxOf('glass'), { x: 504, y: 306, w: 640, h: 360 }, 'Add the manifest offset');
  assert.equal(player.stageBoxOf('wrong'), null);
  assert.equal(player.overBoxOf('wrong'), null);
  assert.deepEqual(player.diag().over.map((o) => o.key).sort(), ['B', 'G', 'W']);
  // The whole group has only one rectangle: host accordingly lets only one member (topmost, last
  // in list) display the placeholder
  assert.deepEqual(player.overGroups(), [['a', 'b']], 'List only group streams that have a position rect; a stream that depends on a lower layer has just one card, so it is not listed');
  player.stop();
  assert.equal(player.hasOver, false, 'Fall back to back: cleared');
});

test('When the parent page brings a manifest (online page): use it directly without asking the byte source; when it brings a new manifest, switch immediately', async () => {
  const source = sourceOf({});
  let changed = 0;
  const player = new StreamPlayer({ root: () => root, source, onBoxChange: () => { changed++; } });
  const first = manifestOf({ boxes: { 0: { x: 1, y: 2, w: 30, h: 40 } } });
  player.setPlanes([], FPS, [{ clipIds: ['a'], key: 'S', ranges: [[0, 0]], originFrame: 0, over: true, manifest: first }]);
  player.present(0);
  await flush();
  assert.deepEqual(player.overBoxOf('a'), { x: 1, y: 2, w: 30, h: 40 });
  assert.deepEqual(source.calls, []);
  const next = manifestOf({ boxes: { 0: { x: 5, y: 2, w: 30, h: 40 } } });
  player.setPlanes([], FPS, [{ clipIds: ['a'], key: 'S', ranges: [[0, 0]], originFrame: 0, over: true, manifest: next }]);
  await flush();
  assert.deepEqual(player.overBoxOf('a'), { x: 5, y: 2, w: 30, h: 40 });
  assert.equal(changed, 2);
  assert.deepEqual(source.calls, []);
});

test('Online page sends stream planes: a plane over budget carries only the manifest, not the bytes, and is not recorded in "chunks held by the stage"', () => {
  const hash = (c) => c.repeat(64);
  const manifest = (seg, init) => ({ ...manifestOf({}), inits: { i: { codec: 'avc1.640028', width: 64, height: 144, rect: { x: 0, y: 0, w: 64, h: 64 }, hash: init } },
    segments: { 0: { init: 'i', file: seg, stride: 15, samples: 15, box: { x: 0, y: 0, w: 8, h: 8 } } } });
  const data = {
    IN: { manifest: manifest(hash('a'), hash('b')), blocks: new Map([[hash('a'), new Uint8Array(4)], [hash('b'), new Uint8Array(4)]]) },
    OV: { manifest: manifest(hash('c'), hash('d')), blocks: new Map([[hash('c'), new Uint8Array(4)], [hash('d'), new Uint8Array(4)]]) },
  };
  const sender = new StreamPlaneSender((key) => data[key] ?? null);
  const out = sender.decorate([
    { clipIds: ['in'], key: 'IN', ranges: [[0, 0]], originFrame: 0 },
    { clipIds: ['ov'], key: 'OV', ranges: [[0, 0]], originFrame: 0, over: true },
  ]);
  assert.deepEqual(Object.keys(out[0].blocks).sort(), [hash('a'), hash('b')]);
  assert.equal(out[1].over, true);
  assert.equal(out[1].manifest, data.OV.manifest, 'Manifest carried: the placeholder is laid out by its position rect');
  assert.equal(out[1].blocks, undefined, 'Bytes not carried');
  assert.equal(sender.heldCount, 2, 'The stage holds only the chunks of the one within budget');
});

test('stageBoxToLocal: converts a rect in stage coordinates to the wrapper layer\'s own coordinates; only wrapper layers with translation plus uniform scaling are supported', () => {
  const box = { x: 500, y: 300, w: 640, h: 360 };
  // Preview is unscaled, wrapper layer is at (400, 200) on stage, unscaled
  assert.deepEqual(stageBoxToLocal(box, { ref: { left: 0, top: 0, width: 1920 }, refWidth: 1920, wrap: { left: 400, top: 200, width: 640 }, wrapWidth: 640, transform: 'none' }),
    { x: 100, y: 100, w: 640, h: 360 });
  // Preview scaled to half, stage at (50, 20) on screen
  assert.deepEqual(stageBoxToLocal(box, { ref: { left: 50, top: 20, width: 960 }, refWidth: 1920, wrap: { left: 250, top: 120, width: 320 }, wrapWidth: 640 }),
    { x: 100, y: 100, w: 640, h: 360 });
  // Wrapper layer itself scales to 0.5 (around center): width 320 on screen, top-left at (560, 290)
  // on stage
  assert.deepEqual(stageBoxToLocal(box, { ref: { left: 0, top: 0, width: 1920 }, refWidth: 1920, wrap: { left: 560, top: 290, width: 320 }, wrapWidth: 640, transform: 'matrix(0.5, 0, 0, 0.5, 0, 0)' }),
    { x: -120, y: 20, w: 1280, h: 720 });
  // Rotated, with 3D: cannot convert, position using old method
  const at = { ref: { left: 0, top: 0, width: 1920 }, refWidth: 1920, wrap: { left: 400, top: 200, width: 640 }, wrapWidth: 640 };
  assert.equal(stageBoxToLocal(box, { ...at, transform: 'matrix(0.866, 0.5, -0.5, 0.866, 0, 0)' }), null);
  assert.equal(stageBoxToLocal(box, { ...at, transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)' }), null);
  assert.equal(stageBoxToLocal(box, { ...at, wrapWidth: 0 }), null);
});

test('Placeholder geometry: a layer over budget uses this frame\'s position rect and does not record it; when no rect can be derived, position the old way and do not reuse the previous segment\'s', () => {
  resetPlaceholderGeometry();
  const size = { width: 640, height: 360 };
  let over = { x: 10, y: 20, w: 300, h: 200 };
  let stream = null;
  setOverBoxSource(() => over);
  setStreamBoxSource(() => stream);
  assert.deepEqual(geometryFor('a', size), { kind: 'solid', box: { left: 10, top: 20, width: 300, height: 200 } });
  // Next segment unmeasured (or wrapper layer rotated, stage coordinates cannot be converted):
  // fall back to old method: if there is no other box, it is a badge, not the previous segment's
  // rectangle
  over = null;
  assert.deepEqual(geometryFor('a', size), { kind: 'badge', center: { x: 320, y: 180 } });
  // Boxes for streams within budget are kept as before (retained even when the stream stops);
  // when the rectangle for that over-budget frame is present, use it first
  stream = { x: 1, y: 2, w: 30, h: 40 };
  assert.deepEqual(geometryFor('a', size), { kind: 'solid', box: { left: 1, top: 2, width: 30, height: 40 } });
  stream = null;
  assert.deepEqual(geometryFor('a', size).box, { left: 1, top: 2, width: 30, height: 40 }, 'The box of a stream within budget is kept');
  over = { x: 50, y: 60, w: 70, h: 80 };
  assert.deepEqual(geometryFor('a', size).box, { left: 50, top: 60, width: 70, height: 80 });
  over = null;
  assert.deepEqual(geometryFor('a', size).box, { left: 1, top: 2, width: 30, height: 40 }, 'The over-budget rect is gone: go back to the one recorded originally, not the one from the frame just now');
  setOverBoxSource(() => null);
  setStreamBoxSource(() => null);
  resetPlaceholderGeometry();
});

test('Group stream over budget: the whole group has only one rect, so show only the topmost one among the members that need to show a placeholder on this beat', () => {
  const wanted = (ids) => new Map(ids.map((id) => [id, 'pending']));
  assert.deepEqual([...keepTopOfGroups(wanted(['a', 'b', 'c', 'x']), [['a', 'b', 'c']]).keys()], ['c', 'x'], 'The last one is on top; those outside the group are untouched');
  assert.deepEqual([...keepTopOfGroups(wanted(['a', 'b', 'x']), [['a', 'b', 'c']]).keys()], ['b', 'x'], 'The topmost card is not shown on this beat (not mounted): keep the nearest one below it');
  assert.deepEqual([...keepTopOfGroups(wanted(['a', 'x']), [['a', 'b']]).keys()], ['a', 'x']);
  assert.deepEqual([...keepTopOfGroups(wanted(['a', 'b', 'c', 'd']), [['a', 'b'], ['c', 'd']]).keys()], ['b', 'd']);
  assert.deepEqual([...keepTopOfGroups(wanted(['a', 'b']), []).keys()], ['a', 'b'], 'A group with no position rect in this frame is not in the table: each is positioned the old way');
});
