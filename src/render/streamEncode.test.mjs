/**
 * Unit tests for browser-side track stream generation. Run: node --test src/render/streamEncode.test.mjs
 *
 * Real encoding requires a browser (`VideoEncoder`), end-to-end in
 * `scripts/probes/browser-stream-encode-probe.mjs`; here mock encoders and canvases are used to pin
 * down these purely computational concerns: how frames are composited, how tiers are selected,
 * how segmentation is done, and how ordering and errors are handled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packedSize, avcCodecFor, streamBitrateFor, drawPackedFrame, probeStreamEncoder, openStreamEncoder, STREAM_HALF_PAD } from './streamEncode.ts';
import { parseInit, parseSegment, chunkTimestamp, SEGMENT_FRAMES } from './streamPlayer.ts';

const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x32, 0xff, 0xe1, 0x00, 0x02, 0x67, 0x64, 0x01, 0x00, 0x02, 0x68, 0xee]);
const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/** Mock canvas recording every stroke */
function fakeCanvas(log, name) {
  const ctx = {
    globalCompositeOperation: 'source-over', fillStyle: '',
    fillRect: (...a) => log.push([name, 'fillRect', ctx.globalCompositeOperation, ctx.fillStyle, ...a]),
    clearRect: (...a) => log.push([name, 'clearRect', ...a]),
    drawImage: (img, ...a) => log.push([name, 'drawImage', ctx.globalCompositeOperation, img?.name ?? img, ...a]),
  };
  return { name, getContext: () => ctx, ctx };
}

/**
 * Mock encoding environment. `behave` can be configured: reject quantization mode, reorder frames,
 * drop keyframes, throw errors.
 * Bytes of each sample = [frame sequence number, is keyframe, quantization parameter or 255].
 */
function fakeEnv(behave = {}) {
  const log = [];
  const state = { configs: [], encoded: [], closed: 0, supportedCalls: [] };
  class VideoFrame {
    constructor(src, init) { this.src = src; this.timestamp = init.timestamp; this.duration = init.duration; this.closed = false; }
    close() { this.closed = true; }
  }
  class VideoEncoder {
    static async isConfigSupported(cfg) {
      state.supportedCalls.push(cfg);
      if (behave.unsupported) return { supported: false };
      if (cfg.bitrateMode === 'quantizer' && behave.noQuantizer) return { supported: false };
      return { supported: true };
    }
    constructor(init) { this.init = init; this.encodeQueueSize = 0; this.n = 0; this.queue = []; }
    configure(cfg) { state.configs.push(cfg); }
    encode(frame, opts) {
      const n = this.n++;
      state.encoded.push({ n, timestamp: frame.timestamp, keyFrame: opts.keyFrame, quantizer: opts.avc?.quantizer });
      if (behave.throwAt === n) { this.init.error(new Error('encoder broke')); return; }
      const key = behave.dropKeyAt === n ? false : !!opts.keyFrame;
      const chunk = { type: key ? 'key' : 'delta', timestamp: frame.timestamp, byteLength: 3, copyTo: (d) => d.set([n & 0xff, key ? 1 : 0, opts.avc?.quantizer ?? 255]) };
      this.queue.push({ chunk, meta: n === 0 ? { decoderConfig: { description: AVCC } } : {} });
      if (!behave.holdUntilFlush) this.drain();
    }
    drain() {
      let q = this.queue; this.queue = [];
      if (behave.reorder && q.length >= 4) q = [q[0], q[1], q[3], q[2], ...q.slice(4)];
      for (const { chunk, meta } of q) this.init.output(chunk, meta);
    }
    async flush() { this.drain(); }
    close() { state.closed += 1; }
  }
  const env = { VideoEncoder, VideoFrame, createCanvas: (w, h) => { const c = fakeCanvas(log, `canvas${w}x${h}`); c.width = w; c.height = h; return c; } };
  return { env, log, state };
}

async function collect(opts, frames, behave) {
  const f = fakeEnv(behave);
  const inits = [], segs = [];
  const enc = await openStreamEncoder({ width: 320, height: 160, fps: 30, ...opts, env: f.env, onInit: (i) => { inits.push(i); }, onSegment: (s) => { segs.push(s); } });
  for (let i = 0; i < frames; i++) await enc.add({ name: `frame${i}` });
  const done = await enc.finish();
  return { ...f, inits, segs, done };
}

test('encoded picture size: width unchanged, height = 2H + 16; odd width or height rejected', () => {
  assert.equal(STREAM_HALF_PAD, 8);
  assert.deepEqual(packedSize(1920, 1080), { width: 1920, height: 2176 });
  assert.deepEqual(packedSize(960, 540), { width: 960, height: 1096 });
  assert.throws(() => packedSize(321, 160), /even/);
  assert.throws(() => packedSize(320, 161), /even/);
  assert.throws(() => packedSize(0, 160), /positive integer/);
});

test('level chosen by pixel count: 960×1096 uses 4.0, a full 1080p after stitching uses 5.0', () => {
  assert.equal(avcCodecFor(960, 1096), 'avc1.640028');
  assert.equal(avcCodecFor(1920, 2176), 'avc1.640032');
  assert.equal(avcCodecFor(320, 336), 'avc1.64001e');
  assert.equal(avcCodecFor(1280, 720), 'avc1.64001f');
  assert.equal(avcCodecFor(3840, 4336), 'avc1.640034');
});

test('bitrate floor is 1 Mbps, rising with pixel count above that', () => {
  assert.equal(streamBitrateFor(320, 336, 30), 1_000_000);
  assert.equal(streamBitrateFor(1920, 2176, 30), Math.round(1920 * 2176 * 30 * 0.2));
});

test('how a frame is stitched: the color half is drawn at the top, the alpha half at H + 8, alpha extracted by filling white with source-in', () => {
  const log = [];
  const packed = fakeCanvas(log, 'packed'), scratch = fakeCanvas(log, 'scratch');
  drawPackedFrame(packed.ctx, scratch.ctx, scratch, { name: 'card' }, 320, 160);
  assert.deepEqual(log, [
    ['packed', 'fillRect', 'source-over', '#000', 0, 0, 320, 336],
    ['packed', 'drawImage', 'source-over', 'card', 0, 0, 320, 160],
    ['scratch', 'clearRect', 0, 0, 320, 160],
    ['scratch', 'drawImage', 'source-over', 'card', 0, 0, 320, 160],
    ['scratch', 'fillRect', 'source-in', '#fff', 0, 0, 320, 160],
    ['packed', 'drawImage', 'source-over', 'scratch', 0, 168, 320, 160],
  ]);
  assert.equal(scratch.ctx.globalCompositeOperation, 'source-over', 'scratch canvas is reset to normal compositing after use');
});

test('capability query: prefer quantizer mode; if unsupported fall back to bitrate mode; if neither is supported or there is no encoder, report unsupported', async () => {
  const a = fakeEnv();
  const ra = await probeStreamEncoder({ width: 320, height: 160, fps: 30, env: a.env });
  assert.equal(ra.supported, true);
  assert.equal(ra.mode, 'quantizer');
  assert.equal(ra.config.width, 320);
  assert.equal(ra.config.height, 336);
  assert.deepEqual(ra.config.avc, { format: 'avc' });

  const b = fakeEnv({ noQuantizer: true });
  const rb = await probeStreamEncoder({ width: 320, height: 160, fps: 30, hardwareAcceleration: 'prefer-software', env: b.env });
  assert.equal(rb.mode, 'variable');
  assert.equal(rb.config.bitrate, 1_000_000);
  assert.equal(rb.config.hardwareAcceleration, 'prefer-software');

  const c = fakeEnv({ unsupported: true });
  assert.equal((await probeStreamEncoder({ width: 320, height: 160, fps: 30, env: c.env })).supported, false);
  assert.equal((await probeStreamEncoder({ width: 320, height: 160, fps: 30, env: { VideoEncoder: undefined } })).supported, false);
});

test('capability query is asked outside the main thread first (Worker): the answer is used as is, the main thread\'s encoder is never asked; only if it cannot be asked does it fall back to this thread', async () => {
  const called = [];
  const counting = (inner) => ({ ...inner, VideoEncoder: Object.assign(function () {}, { isConfigSupported: async (c) => { called.push(c.bitrateMode); return inner.VideoEncoder.isConfigSupported(c); } }) });
  const env = counting(fakeEnv().env);
  // Worker rejects quantization mode but accepts bitrate mode: use bitrate configuration, do not
  // query again in this thread
  const asked = [];
  const r1 = await probeStreamEncoder({ width: 320, height: 160, fps: 30, env, askOffThread: async (configs) => { asked.push(configs.map((c) => c.bitrateMode)); return [false, true]; } });
  assert.deepEqual(asked, [['quantizer', 'variable']], 'both configs asked in one go');
  assert.equal(r1.supported, true);
  assert.equal(r1.mode, 'variable');
  assert.equal(r1.config.bitrate, 1_000_000);
  assert.equal(r1.config.height, 336);
  assert.deepEqual(called, [], 'this thread\'s isConfigSupported was not called');
  // Neither is accepted: report unsupported, and do not fall back to this thread (Worker answer is authoritative)
  assert.equal((await probeStreamEncoder({ width: 320, height: 160, fps: 30, env, askOffThread: async () => [false, false] })).supported, false);
  assert.deepEqual(called, []);
  // Cannot query (returns null, throws error): fall back to this thread, result is identical to original
  const r2 = await probeStreamEncoder({ width: 320, height: 160, fps: 30, env, askOffThread: async () => null });
  assert.equal(r2.mode, 'quantizer');
  assert.deepEqual(called, ['quantizer']);
  const r3 = await probeStreamEncoder({ width: 320, height: 160, fps: 30, env, askOffThread: async () => { throw new Error('boom'); } });
  assert.equal(r3.mode, 'quantizer');
  // This runtime environment has no Worker (Node): default query returns null
  const { askConfigSupportInWorker } = await import('./streamEncode.ts');
  if (typeof globalThis.Worker !== 'function') assert.equal(await askConfigSupportInWorker([{}]), null);
});

test('37 frames → 3 segments (15, 15, 7): segment number, sample count, keyframe positions and timestamps are all correct, and page-side demuxing can read them back', async () => {
  const { inits, segs, done, state } = await collect({}, 37);
  assert.deepEqual(done, { frames: 37, segments: 3, mode: 'quantizer', codec: 'avc1.640032' });
  assert.equal(inits.length, 1, 'init segment is delivered only once');
  assert.deepEqual({ codec: inits[0].codec, width: inits[0].width, height: inits[0].height }, { codec: 'avc1.640032', width: 320, height: 336 });
  const init = parseInit(ab(inits[0].bytes));
  assert.deepEqual([...init.description], [...AVCC]);
  assert.equal(init.width, 320);
  assert.equal(init.height, 336);

  assert.deepEqual(segs.map((s) => [s.index, s.samples]), [[0, 15], [1, 15], [2, 7]]);
  let n = 0;
  for (const seg of segs) {
    const table = parseSegment(ab(seg.bytes));
    assert.equal(table.length, seg.samples);
    table.forEach((s, i) => {
      const bytes = seg.bytes.subarray(s.offset, s.offset + s.size);
      assert.deepEqual([...bytes], [n & 0xff, i === 0 ? 1 : 0, 20], `sample of frame ${n}`);
      assert.equal(s.isSync, i === 0);
      n += 1;
    });
  }
  // Sent to encoder: require a keyframe every 15 frames; timestamps follow frame numbers of the
  // entire stream, using the same algorithm as player frame fetching
  state.encoded.forEach((e, i) => {
    assert.equal(e.keyFrame, i % SEGMENT_FRAMES === 0);
    assert.equal(e.timestamp, chunkTimestamp(i, 30));
    assert.equal(e.quantizer, 20);
  });
  assert.equal(state.closed, 1, 'encoder closed after encoding finishes');
});

test('resume encoding from segment 4: segment numbers start at 4, timestamps start at frame 60', async () => {
  const { segs, state } = await collect({ firstSegment: 4 }, 16);
  assert.deepEqual(segs.map((s) => [s.index, s.samples]), [[4, 15], [5, 1]]);
  assert.equal(state.encoded[0].timestamp, chunkTimestamp(60, 30));
  assert.equal(state.encoded[15].timestamp, chunkTimestamp(75, 30));
  assert.equal(state.encoded[15].keyFrame, true);
});

test('bitrate mode: no per-frame quantizer given', async () => {
  const { done, state } = await collect({}, 3, { noQuantizer: true });
  assert.equal(done.mode, 'variable');
  assert.equal(state.encoded.every((e) => e.quantizer === undefined), true);
  assert.equal(state.configs[0].bitrateMode, 'variable');
});

test('quantizer is adjustable and clamped to 0 ~ 51', async () => {
  assert.equal((await collect({ quantizer: 12 }, 1)).state.encoded[0].quantizer, 12);
  assert.equal((await collect({ quantizer: 99 }, 1)).state.encoded[0].quantizer, 51);
  assert.equal((await collect({ quantizer: -3 }, 1)).state.encoded[0].quantizer, 0);
});

test('encoder holds output until the end (all emitted at flush): still delivered by segment, no frames lost', async () => {
  const { segs, done } = await collect({}, 20, { holdUntilFlush: true });
  assert.equal(done.frames, 20);
  assert.deepEqual(segs.map((s) => [s.index, s.samples]), [[0, 15], [1, 5]]);
});

test('onSegment is async (e.g. upload): segments are delivered in order, finish waits until all are delivered', async () => {
  const f = fakeEnv();
  const order = [];
  const enc = await openStreamEncoder({ width: 320, height: 160, fps: 30, env: f.env,
    onInit: async () => { await new Promise((r) => setTimeout(r, 5)); order.push('init'); },
    onSegment: async (s) => { await new Promise((r) => setTimeout(r, s.index === 0 ? 10 : 1)); order.push(`seg${s.index}`); } });
  for (let i = 0; i < 31; i++) await enc.add({ name: i });
  await enc.finish();
  assert.deepEqual(order, ['init', 'seg0', 'seg1', 'seg2']);
});

test('encoder reordered frames (B-frames): error, no out-of-order stream delivered', async () => {
  await assert.rejects(collect({}, 5, { reorder: true, holdUntilFlush: true }), /reorder/);
});

test('no keyframe at segment start: error', async () => {
  await assert.rejects(collect({}, 20, { dropKeyAt: 15 }), /keyframe/);
});

test('encoder error midway: add or finish throws, encoder is closed', async () => {
  const f = fakeEnv({ throwAt: 3 });
  const enc = await openStreamEncoder({ width: 320, height: 160, fps: 30, env: f.env, onInit() {}, onSegment() {} });
  await assert.rejects((async () => { for (let i = 0; i < 6; i++) await enc.add({ name: i }); await enc.finish(); })(), /encoder broke/);
  assert.equal(f.state.closed, 1);
});

test('onSegment throws: finish throws the same error', async () => {
  const f = fakeEnv();
  const enc = await openStreamEncoder({ width: 320, height: 160, fps: 30, env: f.env, onInit() {}, onSegment() { throw new Error('cannot upload'); } });
  for (let i = 0; i < 15; i++) await enc.add({ name: i });
  await assert.rejects(enc.finish(), /cannot upload/);
});

test('no frames can be sent after cancel; errors immediately when the browser cannot compress', async () => {
  const f = fakeEnv();
  const enc = await openStreamEncoder({ width: 320, height: 160, fps: 30, env: f.env, onInit() {}, onSegment() {} });
  await enc.add({ name: 0 });
  enc.abort();
  await assert.rejects(enc.add({ name: 1 }), /already closed/);
  assert.equal(f.state.closed, 1);
  await assert.rejects(openStreamEncoder({ width: 320, height: 160, fps: 30, env: fakeEnv({ unsupported: true }).env, onInit() {}, onSegment() {} }), /cannot encode/);
});

test('each frame is closed as soon as it is used (no GPU memory held)', async () => {
  const f = fakeEnv();
  const frames = [];
  const Base = f.env.VideoFrame;
  f.env.VideoFrame = class extends Base { constructor(...a) { super(...a); frames.push(this); } };
  const enc = await openStreamEncoder({ width: 320, height: 160, fps: 30, env: f.env, onInit() {}, onSegment() {} });
  for (let i = 0; i < 4; i++) await enc.add({ name: i });
  await enc.finish();
  assert.equal(frames.length, 4);
  assert.equal(frames.every((x) => x.closed), true);
});
