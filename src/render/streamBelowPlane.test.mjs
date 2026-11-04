/**
 * Unit tests for "below-dependent stream" on the player side (`streamPlayer.ts`): this kind of
 * stream has only one target card, but is produced in stage coordinates, with the canvas mounted
 * under the stage root (`[data-pc-group-plane]` of `Stage`), not inside the wrapper layer (section
 * 5.4 of contract `prerender-products-contract.md`).
 * Run: npm test -- src/render/streamBelowPlane.test.mjs
 *
 * Pin:
 *   - When the plane sent by the parent page has `plane: "stage"`, the player looks for the canvas
 *     under the stage root, places it according to the manifest rectangle (stage coordinates), and
 *     leaves the one in the wrapper layer untouched;
 *   - Any frame can be drawn (clip does not start at a multiple-of-15 frame), using the same frame
 *     fetching as single-card streams;
 *   - Do not draw when the coordinate system in the manifest does not match the canvas: manifest is
 *     `stage` while the plane has no marker (would be drawn into wrapper layer), or vice versa;
 *   - Entity box (`boxOf`) does not return stage-coordinate boxes; `streamPlanesFor` carries that
 *     layer's `plane` as-is onto the stream plane.
 *
 * Segments are real (fMP4 muxed by `streamMux.ts`); decoder and WebGL are mocked (only record which
 * frame was drawn). Real frames are verified pixel-by-pixel by probe
 * `scripts/probes/stream-below-stage-probe.mjs`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer, frameOfTimestamp, SEGMENT_FRAMES, stagePlane, streamPlanesFor, planesWithinBudget } from './streamPlayer.ts';
import { buildStreamInit, buildStreamSegment } from './streamMux.ts';
import { streamSegmentFrameCount, streamSegmentSpan } from './streamSegments.mjs';

const FPS = 30;
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x03, 0x68, 0xee, 0x3c]);
const INIT_ID = 'i'.repeat(16);

/* Mock decoder: outputs one frame per macrotask, carrying the marker of the chunk fed in */
const decoders = [];
class FakeDecoder {
  constructor({ output }) { this.output = output; this.state = 'unconfigured'; this.gen = 0; this.queue = []; this.draining = false; decoders.push(this); }
  get decodeQueueSize() { return this.queue.length; }
  configure() { this.state = 'configured'; this.gen++; this.queue = []; }
  reset() { this.state = 'unconfigured'; this.gen++; this.queue = []; }
  close() { this.state = 'closed'; this.gen++; this.queue = []; }
  decode(chunk) {
    this.queue.push({ gen: this.gen, timestamp: chunk.timestamp, mark: [chunk.data[1], chunk.data[2]] });
    if (this.draining) return;
    this.draining = true;
    const step = () => {
      const next = this.queue.shift();
      if (!next) { this.draining = false; return; }
      if (next.gen === this.gen) this.output({ timestamp: next.timestamp, mark: next.mark, displayHeight: 144, codedHeight: 144, close() {}, clone() { return this; } });
      setImmediate(step);
    };
    setImmediate(step);
  }
}
globalThis.VideoDecoder = FakeDecoder;
globalThis.EncodedVideoChunk = class { constructor(o) { this.type = o.type; this.timestamp = o.timestamp; this.duration = o.duration; this.data = Uint8Array.from(o.data); } };
globalThis.CSS = { escape: (s) => s };

/*
 * All stream planes share a single WebGL context, built on an offscreen canvas (`SharedGl` of
 * `streamPlayer.ts`): the mock only records which frame was most recently uploaded; the plane
 * itself is a 2D canvas, and when taken by `drawImage`, records that frame as drawn by it.
 */
const sharedGl = { last: null, contexts: 0 };
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() {
    sharedGl.contexts++;
    return new Proxy({
      getShaderParameter: () => true, getProgramParameter: () => true, createShader: () => ({}), createProgram: () => ({}),
      createBuffer: () => ({}), createTexture: () => ({}), getAttribLocation: () => 0, getUniformLocation: () => ({}), getExtension: () => null,
      texImage2D: (...a) => { sharedGl.last = a[a.length - 1]; },
    }, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => {}) });
  }
};

function fakeCanvas(name) {
  const canvas = { name, draws: [], width: 0, height: 0, parentElement: null, isConnected: true, attrs: {},
    getAttribute(k) { return this.attrs[k] ?? null; },
    style: { props: {}, getPropertyValue(k) { return this.props[k] ?? ''; }, setProperty(k, v) { this.props[k] = v; } } };
  const gl = new Proxy({
    getShaderParameter: () => true, getProgramParameter: () => true, createShader: () => ({}), createProgram: () => ({}),
    createBuffer: () => ({}), createTexture: () => ({}), getAttribLocation: () => 0, getUniformLocation: () => ({}), getExtension: () => null,
    drawImage: () => { canvas.draws.push(sharedGl.last); },
  }, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => {}) });
  canvas.getContext = () => gl;
  return canvas;
}
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function until(fn, label, rounds = 400) {
  for (let i = 0; i < rounds; i++) { if (fn()) return; await new Promise((r) => setImmediate(r)); }
  assert.fail(`Timed out waiting for: ${label}`);
}

/** Stream of target card `g`, covering project frames `firstFrame .. lastFrame`. `plane` / `kind` are written in the manifest */
function streamOf(firstFrame, lastFrame, { plane = 'stage', kind = 'below' } = {}) {
  const { originFrame, lastSegment } = streamSegmentSpan(firstFrame, lastFrame);
  const init = buildStreamInit({ width: 64, height: 144, fps: FPS, avcC: AVCC });
  const files = new Map();
  const segments = {};
  for (let n = 0; n <= lastSegment; n++) {
    const count = streamSegmentFrameCount(n, originFrame, lastFrame);
    const samples = Array.from({ length: count }, (_, i) => ({ data: Uint8Array.from([0xab, n, i, 0xcd]), isSync: i === 0 }));
    files.set(`${n}.m4s`, buildStreamSegment({ sequence: n + 1, baseDecodeTime: n * SEGMENT_FRAMES, samples }));
    segments[n] = { init: INIT_ID, file: `${n}.m4s`, stride: 1, samples: count };
  }
  // Stage coordinates: upper bound is the whole video, tight rectangle is the chunk modified by
  // the target card (not at origin)
  const tight = { x: 400, y: 200, w: 64, h: 64 };
  const manifest = { streamKey: 'K', kind, plane, clipIds: ['g'], fps: FPS, segmentFrames: SEGMENT_FRAMES, originFrame,
    bound: { x: 0, y: 0, w: 1920, h: 1080 }, tight,
    inits: { [INIT_ID]: { codec: 'avc1.64001f', width: 64, height: 144, rect: tight } }, segments };
  const copy = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  return { originFrame, lastSegment, manifest,
    source: { manifest: async () => manifest, init: async () => copy(init), segment: async (_k, file) => copy(files.get(file)) },
    request: (extra = {}) => ({ clipIds: ['g'], key: 'K', ranges: [[0, lastSegment]], originFrame, ...extra }) };
}

/** Both canvases are on stage: the one in wrapper layer (for single-card streams) and the one under stage root (for group streams and below-dependent streams) */
function stageWith(stream, request) {
  const local = fakeCanvas('local');
  local.parentElement = { getAttribute: (k) => (k === 'data-pc-clip' ? 'g' : null), querySelector: () => null };
  const staged = fakeCanvas('stage');
  staged.attrs['data-pc-stream-group'] = 'g';
  const asked = [];
  const root = {
    querySelector(sel) {
      asked.push(sel);
      if (sel === '[data-pc-clip="g"] > canvas[data-pc-stream-plane]') return local;
      if (sel === 'canvas[data-pc-group-plane][data-pc-stream-group="g"]') return staged;
      return null;
    },
    contains: (el) => el === local || el === staged,
  };
  const player = new StreamPlayer({ root: () => root, source: stream.source });
  player.setPlanes([request], FPS);
  return { player, local, staged, asked, track: () => player.diag().tracks[0] };
}

beforeEach(() => { decoders.length = 0; });

test('a plane with plane: stage is drawn on the canvas under the stage root, placed by the manifest\'s stage coordinates; the one inside the wrapper layer is untouched; any frame is its own', async () => {
  const stream = streamOf(55, 99);                  // 45 frames starting from frame 55: segments are 55-69, 70-84, 85-99
  assert.deepEqual([stream.originFrame, stream.lastSegment], [55, 2]);
  const h = stageWith(stream, stream.request({ plane: 'stage' }));
  for (const f of [77, 55, 69, 70, 99, 84, 61]) {
    h.player.present(f / FPS);
    await until(() => h.track()?.lastDrawn === f, `drew frame ${f}`);
    const shot = h.staged.draws.at(-1);
    assert.deepEqual(shot.mark, [Math.floor((f - 55) / 15), (f - 55) % 15], `Frame ${f}`);
    assert.equal(frameOfTimestamp(shot.timestamp, FPS), f);
  }
  assert.equal(h.local.draws.length, 0, 'the canvas inside the wrapper layer drew no frames');
  assert.ok(h.asked.some((sel) => sel.includes('data-pc-group-plane')), 'look for the canvas under the stage root');
  assert.equal(h.asked.some((sel) => sel.includes('data-pc-stream-plane')), false, 'do not look for the one inside the wrapper layer');
  // Canvas is placed by manifest upper bound (stage coordinates, whole video), not wrapper layer box
  assert.deepEqual([h.staged.width, h.staged.height], [1920, 1080]);
  assert.deepEqual(h.staged.style.props, { left: '0px', top: '0px', width: '1920px', height: '1080px' });
  assert.deepEqual([...h.player.showingClips()], ['g']);
  assert.equal(h.player.boxOf('g'), null, 'entity box is in stage coordinates, not returned as wrapper layer coordinates');
  const d = h.track();
  assert.deepEqual([d.plane, d.kind, d.fits], ['stage', 'below', true]);
  // Frames earlier than the first frame of this stream have no stream
  h.player.present(54 / FPS);
  await flush();
  assert.notEqual(h.track().lastDrawn, 54);
  h.player.stop();
});

test('manifest is stage, plane carries no marker (would be treated as a single-card stream and drawn into the wrapper layer): draw no frames, no stream picture this tick', async () => {
  const stream = streamOf(55, 99);
  const h = stageWith(stream, stream.request());
  h.player.present(77 / FPS);
  await flush(40);
  assert.equal(h.local.draws.length, 0);
  assert.equal(h.staged.draws.length, 0);
  assert.equal(h.track().lastDrawn, null);
  assert.equal(h.track().fits, false);
  assert.deepEqual([...h.player.showingClips()], [], 'the stage falls back to the placeholder accordingly');
  h.player.stop();
});

test('conversely: manifest is local (single-card stream), plane carries a stage marker: likewise not drawn', async () => {
  const stream = streamOf(55, 99, { plane: 'local', kind: 'card' });
  const h = stageWith(stream, stream.request({ plane: 'stage' }));
  h.player.present(77 / FPS);
  await flush(40);
  assert.equal(h.local.draws.length + h.staged.draws.length, 0);
  assert.equal(h.track().fits, false);
  // Unmarked: drawn in wrapper layer like single-card streams
  const ok = stageWith(stream, stream.request());
  ok.player.present(77 / FPS);
  await until(() => ok.track()?.lastDrawn === 77, 'single-card stream drew frame 77');
  assert.equal(ok.staged.draws.length, 0);
  assert.ok(ok.local.draws.length > 0);
  assert.deepEqual([ok.track().plane, ok.track().kind, ok.track().fits], ['local', 'card', true]);
  h.player.stop(); ok.player.stop();
});

test('the stream of the same card switches from a single-card stream to one that depends on the lower layer (the same key would not, but a changed plane kind makes it a different one): the old one is closed, the new one is rebuilt under the stage root', async () => {
  const stream = streamOf(55, 99);
  const h = stageWith(stream, stream.request());
  h.player.present(77 / FPS);
  await flush(20);
  const before = h.track().id;
  h.player.setPlanes([stream.request({ plane: 'stage' })], FPS);
  h.player.present(77 / FPS);
  await until(() => h.track()?.lastDrawn === 77, 'drew frame 77 after switching to the stage plane');
  assert.notEqual(h.track().id, before);
  assert.equal(h.player.diag().tracks.length, 1);
  assert.ok(h.staged.draws.length > 0);
  assert.equal(h.local.draws.length, 0);
  h.player.stop();
});

test('stagePlane / streamPlanesFor / planesWithinBudget: group streams and marked single cards count as stage planes; that layer\'s plane is carried to the stream plane as is, taking one budget slot', () => {
  assert.equal(stagePlane({ clipIds: ['a'] }), false);
  assert.equal(stagePlane({ clipIds: ['a'], plane: 'stage' }), true);
  assert.equal(stagePlane({ clipIds: ['a', 'b'] }), true);
  assert.equal(stagePlane(null), false);
  const layers = [
    { clipId: 'g', key: 'KB', ranges: [[0, 2]], originFrame: 55, plane: 'stage' },
    { clipId: 'c', key: 'KC', ranges: [[0, 9]], originFrame: 0 },
    { clipId: 'b', key: 'KG', ranges: [[0, 9]], originFrame: 0, groupClipIds: ['a', 'b'], plane: 'stage' },
  ];
  const planes = streamPlanesFor(layers, new Set(['g', 'c', 'a', 'b']), 77);
  assert.deepEqual(planes, [
    { clipIds: ['g'], key: 'KB', ranges: [[0, 2]], originFrame: 55, plane: 'stage' },
    { clipIds: ['c'], key: 'KC', ranges: [[0, 9]], originFrame: 0 },
    { clipIds: ['a', 'b'], key: 'KG', ranges: [[0, 9]], originFrame: 0 },
  ], 'a group stream is already in stage coordinates, no extra marker');
  assert.equal(planesWithinBudget(planes).length, 3);
  // Frame 100: the below-dependent one (frames 55-99) has already ended
  assert.deepEqual(streamPlanesFor(layers, new Set(['g', 'c']), 100).map((p) => p.clipIds[0]), ['c']);
});
