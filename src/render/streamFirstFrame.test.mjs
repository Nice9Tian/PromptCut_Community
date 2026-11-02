/**
 * Lowest tier track stream pasting: decode only the first frame of each segment (`presentFirst` in
 * `streamPlayer.ts`; (user decision, 2026-10-13: "when performance is insufficient, paste only
 * sparse versions and allocate fewer active decoders simultaneously", assigned to lowest tier since
 * 2026-10-22)).
 * Run: npm test -- src/render/streamFirstFrame.test.mjs
 *
 * Real decoding requires a browser, end-to-end in
 * `scripts/probes/page-stream-probe.mjs --only lowest`. Here decoders, canvases, and clocks are
 * mocked, segments are real (fMP4 muxed by `streamMux.ts`), pinning down:
 *
 *   - Frame number conversion in only one place (`streamFirstFrameOf` in `streamSegments.mjs`),
 *     correct even when clips do not start at a multiple-of-15 frame;
 *   - Stream planes with `first`: even full-density segments feed only the first sample (keyframe)
 *     chunk, every frame of this segment pastes it; same for sparse segments;
 *   - Playback, backward seek, cross-segment seek are all "decode one chunk per segment", without
 *     resetting decoder; only one chunk is decoding at a time per decoder;
 *   - Decoded frames: in steady state, keep only the one on canvas per stream, two during segment
 *     transition; close all upon stop;
 *   - Bytes of this segment not yet arrived: keep the previous frame for at most one segment
 *     duration, clear on timeout;
 *   - Browser has no `VideoDecoder` or decoder errors repeatedly: do not paste (no retry), do not
 *     throw;
 *   - Lowest tier budget (`sparseStreamBudget` in `streamBudget.mjs`): count, sum of aspect ratios,
 *     first stream ignores pixels;
 *   - When parent page sends stream planes to stage, `first` is carried through as-is
 *     (`StreamPlaneSender`).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer, StreamPlaneSender, planesWithinBudget, frameOfTimestamp, SEGMENT_FRAMES, HOLD_FRAMES, FIRST_FRAME_MAX_FAILURES, FIRST_FRAME_STALL_MS } from './streamPlayer.ts';
import { buildStreamInit, buildStreamSegment } from './streamMux.ts';
import { streamFirstFrameOf, streamSegmentFrameCount, streamSegmentSpan } from './streamSegments.mjs';
import { sparseStreamBudget, SPARSE_STREAM_COUNT, SPARSE_STREAM_PIXELS, SPARSE_STREAM_FREE, STREAM_BUDGET_MIN_FPS, STREAM_COUNT_BUDGET, STREAM_DEFAULT_PIXELS, streamCodedPixels } from './streamBudget.mjs';

const FPS = 30;
const HOLD_MS = (HOLD_FRAMES * 1000) / FPS;
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x03, 0x68, 0xee, 0x3c]);
const INIT_ID = 'i'.repeat(16);

/* ---------------------------------------------------------------- Mock clock, decoder, and canvas (same suite as `streamScrub.test.mjs`, plus `flush` and error handling) */

let now = 1_000_000;
let timers = [];
globalThis.__pcRealNow = () => now;
globalThis.__pcRealSetTimeout = (fn, ms = 0) => { timers.push({ at: now + ms, fn }); return timers.length; };
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function advance(ms) {
  const until = now + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers = timers.filter((t) => t !== due);
    now = Math.max(now, due.at);
    due.fn();
    await flush(2);
  }
  now = until;
}

const frames = { open: 0, maxOpen: 0 };
const decoders = [];
/** `hold`: hold output for now; `failNext`: decoder throws error and closes after this many subsequent `decode` calls (simulates device unable to decode this stream) */
const decoderGate = { hold: false, failNext: 0 };

class FakeDecoder {
  constructor({ output, error }) {
    this.output = output; this.onError = error; this.state = 'unconfigured'; this.gen = 0; this.queue = []; this.draining = false;
    this.needKey = true; this.resets = 0; this.flushes = 0; this.fed = []; this.maxQueued = 0; this.configs = [];
    decoders.push(this);
  }
  get decodeQueueSize() { return this.queue.length; }
  configure(config) { this.state = 'configured'; this.needKey = true; this.gen++; this.queue = []; this.configs.push(config); }
  reset() { this.state = 'unconfigured'; this.resets++; this.gen++; this.queue = []; }
  close() { this.state = 'closed'; this.gen++; this.queue = []; }
  async flush() { this.flushes++; this.needKey = true; }
  decode(chunk) {
    if (this.state !== 'configured') throw new Error('not configured');
    if (this.needKey && chunk.type !== 'key') throw new Error('A key frame is required after configure() or flush()');
    this.needKey = false;
    this.fed.push({ frame: frameOfTimestamp(chunk.timestamp, FPS), segment: chunk.data[1], sample: chunk.data[2], key: chunk.type === 'key' });
    if (decoderGate.failNext > 0) {
      decoderGate.failNext--;
      this.state = 'closed';
      setImmediate(() => this.onError(new Error('Unsupported configuration')));
      return;
    }
    this.queue.push({ gen: this.gen, timestamp: chunk.timestamp, mark: [chunk.data[1], chunk.data[2], chunk.data[3]] });
    this.maxQueued = Math.max(this.maxQueued, this.queue.length);
    this.drain();
  }
  drain() {
    if (this.draining) return;
    this.draining = true;
    const step = () => {
      if (decoderGate.hold) { setImmediate(step); return; }
      const next = this.queue.shift();
      if (!next) { this.draining = false; return; }
      if (next.gen === this.gen) this.output(makeFrame(next));
      setImmediate(step);
    };
    setImmediate(step);
  }
}
function makeFrame(info) {
  const body = { timestamp: info.timestamp, mark: info.mark, displayHeight: 144, codedHeight: 144 };
  const handle = () => {
    let closed = false;
    frames.open++;
    frames.maxOpen = Math.max(frames.maxOpen, frames.open);
    return { ...body, close() { if (!closed) { closed = true; frames.open--; } }, clone() { return handle(); } };
  };
  return handle();
}
globalThis.VideoDecoder = FakeDecoder;
globalThis.EncodedVideoChunk = class { constructor(o) { this.type = o.type; this.timestamp = o.timestamp; this.duration = o.duration; this.data = Uint8Array.from(o.data); } };
globalThis.CSS = { escape: (s) => s };

const sharedGl = { last: null };
const glProxy = (extra) => new Proxy({
  getShaderParameter: () => true, getProgramParameter: () => true, createShader: () => ({}), createProgram: () => ({}),
  createBuffer: () => ({}), createTexture: () => ({}), getAttribLocation: () => 0, getUniformLocation: () => ({}), getExtension: () => null, ...extra,
}, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => {}) });
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }
  addEventListener() {}
  getContext() { return glProxy({ isContextLost: () => false, texImage2D: (...a) => { sharedGl.last = a[a.length - 1]; } }); }
};
function fakeCanvas() {
  const canvas = { draws: [], clears: 0, width: 0, height: 0, parentElement: null, isConnected: true,
    style: { props: {}, getPropertyValue(k) { return this.props[k] ?? ''; }, setProperty(k, v) { this.props[k] = v; } } };
  const ctx = glProxy({ drawImage: () => { canvas.draws.push(sharedGl.last); }, clearRect: () => { canvas.clears++; } });
  canvas.getContext = () => ctx;
  return canvas;
}
async function until(fn, label, rounds = 400) {
  for (let i = 0; i < rounds; i++) { if (fn()) return; await new Promise((r) => setImmediate(r)); }
  assert.fail(`Timed out waiting for: ${label}`);
}

/* ---------------------------------------------------------------- One stream: 4 bytes per sample [0xAB, segment number, frame index, file version] */

function streamOf(firstFrame, lastFrame, { stride = 1, first = true } = {}) {
  const { originFrame, lastSegment } = streamSegmentSpan(firstFrame, lastFrame);
  const init = buildStreamInit({ width: 64, height: 144, fps: FPS, avcC: AVCC });
  const files = new Map();
  const segments = {};
  for (let n = 0; n <= lastSegment; n++) {
    const count = streamSegmentFrameCount(n, originFrame, lastFrame);
    const samples = Array.from({ length: count }, (_, i) => ({ data: Uint8Array.from([0xab, n, Math.floor(i / stride) * stride, stride]), isSync: i === 0 }));
    const file = `${n}-s${stride}.m4s`;
    files.set(file, buildStreamSegment({ sequence: n + 1, baseDecodeTime: n * SEGMENT_FRAMES, samples }));
    segments[n] = { init: INIT_ID, file, stride, samples: count };
  }
  const manifest = { streamKey: 'K', kind: 'card', plane: 'local', clipIds: ['a'], fps: FPS, segmentFrames: SEGMENT_FRAMES, originFrame,
    bound: { x: 0, y: 0, w: 64, h: 64 }, tight: null, inits: { [INIT_ID]: { codec: 'avc1.64001f', width: 64, height: 144, rect: { x: 0, y: 0, w: 64, h: 64 } } }, segments };
  const asked = [];
  const held = new Map();
  const copy = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  return {
    originFrame, lastSegment, asked,
    source: {
      manifest: async () => ({ ...manifest, segments: { ...manifest.segments } }),
      init: async () => copy(init),
      segment: async (_key, file) => { asked.push(file); if (held.has(file)) await held.get(file).promise; return copy(files.get(file)); },
    },
    hold(file) { let open; const promise = new Promise((r) => { open = r; }); held.set(file, { promise, open }); },
    release(file) { held.get(file)?.open(); held.delete(file); },
    plane: { clipIds: ['a'], key: 'K', ranges: [[0, lastSegment]], originFrame, ...(first ? { first: true } : {}) },
  };
}
function playerFor(stream, { onShowingChange } = {}) {
  const dom = { canvas: fakeCanvas() };
  const root = { querySelector(sel) { return /^\[data-pc-clip="a"\] > canvas\[data-pc-stream-plane\]$/.test(sel) ? dom.canvas : null; }, contains: (el) => el === dom.canvas };
  dom.canvas.parentElement = { getAttribute: (k) => (k === 'data-pc-clip' ? 'a' : null), querySelector: () => null };
  const player = new StreamPlayer({ root: () => root, source: stream.source, onShowingChange });
  player.setPlanes([stream.plane], FPS);
  return { player, dom, track: () => player.diag().tracks[0], last: () => dom.canvas.draws.at(-1) ?? null, seek: (f) => player.present(f / FPS) };
}

beforeEach(() => {
  now = 1_000_000; timers = []; frames.open = 0; frames.maxOpen = 0; decoders.length = 0; decoderGate.hold = false; decoderGate.failNext = 0; sharedGl.last = null;
  globalThis.VideoDecoder = FakeDecoder;
});

/* ---------------------------------------------------------------- Frame number conversion */

test('segment first-frame conversion: one segment every 15 frames from the stream\'s own first frame, correct even when the clip does not start on a multiple of 15', () => {
  assert.equal(streamFirstFrameOf(12, 12), 12);
  assert.equal(streamFirstFrameOf(26, 12), 12);
  assert.equal(streamFirstFrameOf(27, 12), 27);
  assert.equal(streamFirstFrameOf(41, 12), 27);
  assert.equal(streamFirstFrameOf(42, 12), 42);
  assert.equal(streamFirstFrameOf(0, 0), 0);
  assert.equal(streamFirstFrameOf(SEGMENT_FRAMES * 3 + 5, 0), SEGMENT_FRAMES * 3);
  // Earlier than stream's first frame: returned value is also earlier than first frame (that
  // segment is not in ready range, will not actually decode)
  assert.ok(streamFirstFrameOf(5, 12) < 12);
});

/* ---------------------------------------------------------------- Decode only first frame of segment */

test('a full-density stream carries first: stopped mid-segment, only that segment\'s keyframe chunk is fed, and what is drawn is the segment\'s first frame', async () => {
  const s = streamOf(12, 12 + 59);   // First frame is frame 12, 4 segments, 15 samples per segment (full density)
  const p = playerFor(s);
  p.seek(12 + 15 + 7);               // 7th sample of segment 1
  await until(() => p.last(), 'drawn');
  assert.deepEqual(p.last().mark, [1, 0, 1], 'draws sample 0 of segment 1');
  assert.equal(decoders.length, 1);
  assert.deepEqual(decoders[0].fed, [{ frame: 27, segment: 1, sample: 0, key: true }], 'only one chunk fed: the keyframe of segment 1 (frame 27 of the project)');
  assert.equal(decoders[0].flushes, 1, 'after feeding, the decoder is told to flush this chunk out');
  assert.deepEqual(s.asked, ['1-s1.m4s'], 'only this segment was fetched, no prefetch ahead');
  const t = p.track();
  assert.equal(t.first, true);
  assert.equal(t.lastDrawn, 27);
  assert.equal(t.picture, 27);
  assert.equal(t.level, 'sparse', 'pasted the way the sparse version is');
  assert.equal(t.held, 0, 'the decoder output is closed on the spot after drawing');
  assert.equal(frames.open, 1, 'only the reference to the one on the canvas is kept');
  assert.equal(p.player.heldBytes(), 64 * 144 * 1.5, 'decoded frame memory = one frame');
});

test('play through once: one chunk decoded per segment, every frame shows the first frame of its segment; decoded frames steady at 1, transiently no more than 2', async () => {
  for (const stride of [1, SEGMENT_FRAMES]) {
    decoders.length = 0; frames.open = 0; frames.maxOpen = 0;
    const s = streamOf(12, 12 + 59, { stride });
    const p = playerFor(s);
    for (let f = 12; f <= 12 + 59; f++) {
      p.seek(f);
      await flush(6);
      const t = p.track();
      if (t.lastDrawn !== null) {
        assert.equal(t.lastDrawn % 1, 0);
        assert.ok(t.lastDrawn <= f, 'only look backward, never take later ones');
        // Decoding is asynchronous: first one or two ticks of segment switch may still keep the frame from previous segment
        assert.ok(f - t.lastDrawn < 2 * SEGMENT_FRAMES);
      }
      assert.ok(t.maxHeld <= 2, `decoded frames held by a single stream do not exceed 2 (at frame ${f}: ${t.maxHeld})`);
    }
    assert.equal(p.track().lastDrawn, streamFirstFrameOf(12 + 59, 12), 'ends on the first frame of the last segment');
    assert.deepEqual(decoders[0].fed.map((x) => [x.segment, x.sample, x.key]), [[0, 0, true], [1, 0, true], [2, 0, true], [3, 0, true]], `stride ${stride}: one keyframe chunk fed for each of the four segments`);
    assert.equal(decoders.length, 1, 'one decoder per stream');
    assert.equal(decoders[0].resets, 0, 'the decoder is not reset across segments');
    assert.equal(decoders[0].maxQueued, 1, 'only one chunk is decoding at a time');
    assert.equal(p.dom.canvas.draws.length, 4, 'the canvas is redrawn only when the segment changes');
    assert.equal(frames.open, 1);
    assert.ok(frames.maxOpen <= 3, `open frame handles transiently do not exceed 3 (the new one, its reference, the previous one's reference), actual ${frames.maxOpen}`);
    p.player.stop();
    assert.equal(frames.open, 0, 'all closed on stop');
  }
});

test('seeking backward while paused and seeking across segments: one keyframe chunk decoded each; moving within the same segment does not decode again', async () => {
  const s = streamOf(100, 100 + 89);   // 6 segments
  const p = playerFor(s);
  p.seek(100 + 70);   // Segment 4
  await until(() => p.track().lastDrawn === 160, 'segment 4');
  p.seek(100 + 20);   // Back to segment 1
  await until(() => p.track().lastDrawn === 115, 'segment 1');
  p.seek(100 + 22);   // Same segment
  p.seek(100 + 29);
  await flush();
  assert.equal(p.track().lastDrawn, 115);
  p.seek(100 + 89);   // Last segment
  await until(() => p.track().lastDrawn === 175, 'segment 5');
  assert.deepEqual(decoders[0].fed.map((x) => x.frame), [160, 115, 175]);
  assert.equal(decoders[0].resets, 0);
  assert.deepEqual(p.last().mark, [5, 0, 1]);
});

test('continuous dragging: when the in-flight chunk comes out it is no longer what is wanted now, so it is not drawn, and another chunk is decoded for what is wanted now', async () => {
  const s = streamOf(0, 89);
  const p = playerFor(s);
  p.seek(5);
  await until(() => p.track().lastDrawn === 0, 'segment 0');
  decoderGate.hold = true;
  p.seek(20);            // Segment 1 sent to decode, held
  await flush();
  p.seek(50);            // Scrubbed to segment 3 again: chunk for segment 1 is still decoding, do not send again
  await flush();
  assert.deepEqual(decoders[0].fed.map((x) => x.frame), [0, 15], 'the same decoder decodes only one chunk at a time');
  decoderGate.hold = false;
  await until(() => p.track().lastDrawn === 45, 'segment 3');
  assert.deepEqual(decoders[0].fed.map((x) => x.frame), [0, 15, 45]);
  assert.deepEqual(p.dom.canvas.draws.map((d) => d.mark[0]), [0, 3], 'the one from segment 1 was not drawn (the picture does not jump back)');
  assert.equal(frames.open, 1);
});

test('this segment\'s bytes have not arrived: keep the previous frame for at most one segment duration, then clear it and tell the host', async () => {
  const s = streamOf(0, 59);
  let changes = 0;
  const p = playerFor(s, { onShowingChange: () => { changes++; } });
  p.seek(3);
  await until(() => p.track().lastDrawn === 0, 'segment 0');
  await flush();
  const before = changes;
  s.hold('1-s1.m4s');
  p.seek(17);
  await flush();
  assert.equal(p.track().lastDrawn, 0, 'keeps the previous frame');
  assert.equal(p.track().stale, true);
  await advance(HOLD_MS + 60);
  await flush();
  assert.equal(p.track().lastDrawn, null, 'cleared on timeout');
  assert.equal(p.player.showingClips().size, 0);
  assert.ok(changes > before, 'the host must be told when the picture is gone (the placeholder relies on it)');
  s.release('1-s1.m4s');
  await until(() => p.track().lastDrawn === 15, 'draws itself once the bytes arrive');
});

test('the chunk sent to decode never comes out: after the time limit, reset the decoder and send it again', async () => {
  const s = streamOf(0, 29);
  const p = playerFor(s);
  decoderGate.hold = true;
  p.seek(2);
  await flush();
  assert.equal(decoders[0].fed.length, 1);
  await advance(FIRST_FRAME_STALL_MS + 10);
  p.seek(2);
  await flush();
  assert.equal(decoders[0].resets, 1);
  assert.equal(decoders[0].fed.length, 2, 'sent again after the reset');
  decoderGate.hold = false;
  await until(() => p.track().lastDrawn === 0, 'drawn');
});

/* ---------------------------------------------------------------- Fallback when decoding fails */

test('the browser has no VideoDecoder: no drawing, no throw, no retry', async () => {
  globalThis.VideoDecoder = undefined;
  const s = streamOf(0, 29);
  const p = playerFor(s);
  for (let i = 0; i < 5; i++) { p.seek(2 + i); await flush(); }
  assert.equal(p.track().lastDrawn, null);
  assert.equal(p.player.showingClips().size, 0, 'this layer has no stream picture, the host handles it as if there were no stream (small size / placeholder)');
  assert.equal(p.track().firstFailures, FIRST_FRAME_MAX_FAILURES);
  assert.equal(decoders.length, 0);
});

test('the decoder keeps failing (this device cannot decode this stream): stop creating decoders once the limit is reached', async () => {
  decoderGate.failNext = 99;
  const s = streamOf(0, 59);
  const p = playerFor(s);
  for (let f = 0; f < 40; f++) { p.seek(f); await flush(4); }
  assert.equal(decoders.length, FIRST_FRAME_MAX_FAILURES, `only created ${FIRST_FRAME_MAX_FAILURES} decoders`);
  assert.equal(p.track().lastDrawn, null);
  assert.equal(p.track().firstFailures, FIRST_FRAME_MAX_FAILURES);
  assert.equal(frames.open, 0);
});

test('decoded after one error: the failure count resets, drawing continues as usual', async () => {
  decoderGate.failNext = 1;
  const s = streamOf(0, 59);
  const p = playerFor(s);
  p.seek(1);
  await until(() => p.track().lastDrawn === 0, 'decoded the second time');
  assert.equal(decoders.length, 2);
  assert.equal(p.track().firstFailures, 0);
});

test('a stream plane without first still decodes frame by frame (other tiers are unaffected)', async () => {
  const s = streamOf(0, 44, { first: false });
  const p = playerFor(s);
  p.seek(7);
  await until(() => p.track().lastDrawn === 7, 'frame 7');
  assert.deepEqual(p.last().mark, [0, 7, 1]);
  assert.equal(p.track().first, false);
  assert.ok(decoders[0].fed.length > 8, 'decodes from the keyframe all the way to the target frame, and keeps decoding past it');
  assert.equal(decoders[0].flushes, 0);
  p.player.stop();
});

/* ---------------------------------------------------------------- Budget */

test('lowest tier budget: at most 4 decoders; the total aspect ratio area does not exceed two 1080p full-screen cards; the first one ignores pixels', () => {
  const budget = sparseStreamBudget();
  assert.deepEqual(budget, { count: SPARSE_STREAM_COUNT, pixelRate: SPARSE_STREAM_PIXELS * STREAM_BUDGET_MIN_FPS, free: SPARSE_STREAM_FREE });
  assert.equal(SPARSE_STREAM_COUNT, 4);
  assert.ok(SPARSE_STREAM_COUNT < STREAM_COUNT_BUDGET);
  const plane = (id) => ({ clipIds: [id], key: `k-${id}`, originFrame: 0 });
  const pass = (list, px) => planesWithinBudget(list, STREAM_BUDGET_MIN_FPS, (p) => px[p.clipIds[0]], budget).map((p) => p.clipIds[0]);
  const small = streamCodedPixels(704, 864);
  const full = STREAM_DEFAULT_PIXELS;
  // Six small cards: count limit 4
  assert.deepEqual(pass(['a', 'b', 'c', 'd', 'e', 'f'].map(plane), { a: small, b: small, c: small, d: small, e: small, f: small }), ['a', 'b', 'c', 'd']);
  // Three full-screen cards: place two
  assert.deepEqual(pass(['a', 'b', 'c'].map(plane), { a: full, b: full, c: full }), ['a', 'b']);
  // Even small cards cannot fit after two full-screen cards (sum of aspect ratios is full)
  assert.deepEqual(pass(['a', 'b', 'c'].map(plane), { a: full, b: full, c: small }), ['a', 'b']);
  // Skip full-screen card when it cannot fit; subsequent small cards are still placed
  assert.deepEqual(pass(['a', 'b', 'c', 'd'].map(plane), { a: full, b: small, c: full, d: small }), ['a', 'b', 'd']);
  // 4K full-screen card: first stream ignores pixels, placed as usual; no further streams can be added afterward
  const uhd = streamCodedPixels(3840, 2160);
  assert.deepEqual(pass(['a', 'b'].map(plane), { a: uhd, b: small }), ['a']);
  // Project frame rate does not enter cost calculation of this tier: 60-fps project places as many
  // as 30-fps (caller passes STREAM_BUDGET_MIN_FPS)
  assert.deepEqual(planesWithinBudget(['a', 'b', 'c'].map(plane), STREAM_BUDGET_MIN_FPS, () => full, budget).length, 2);
  // Omitting budget uses numbers of other tiers (up to 6 streams ignore pixels)
  assert.equal(planesWithinBudget(['a', 'b', 'c', 'd', 'e', 'f'].map(plane), 60, () => full).length, 6);
});

test('the parent page sends stream planes to the stage: first is passed through unchanged; planes over budget carry no bytes', () => {
  const sender = new StreamPlaneSender(() => null);
  const out = sender.decorate([
    { clipIds: ['a'], key: 'ka', ranges: [[0, 3]], originFrame: 12, first: true },
    { clipIds: ['b'], key: 'kb', ranges: [[0, 3]], originFrame: 0 },
    { clipIds: ['c'], key: 'kc', originFrame: 0, over: true },
  ]);
  assert.equal(out[0].first, true);
  assert.equal('first' in out[1], false);
  assert.equal(out[2].over, true);
  assert.equal('first' in out[2], false);
});
