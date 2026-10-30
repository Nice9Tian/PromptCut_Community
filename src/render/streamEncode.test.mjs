/**
 * 浏览器侧轨道流生成的单测。跑:node --test src/render/streamEncode.test.mjs
 *
 * 真的编码要浏览器(`VideoEncoder`),端到端在 `scripts/probes/browser-stream-encode-probe.mjs`;
 * 这里用假的编码器和画布钉住这几件纯算的事:画面怎么拼、级别怎么挑、怎么分段、顺序与出错怎么处理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packedSize, avcCodecFor, streamBitrateFor, drawPackedFrame, probeStreamEncoder, openStreamEncoder, STREAM_HALF_PAD } from './streamEncode.ts';
import { parseInit, parseSegment, chunkTimestamp, SEGMENT_FRAMES } from './streamPlayer.ts';

const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x32, 0xff, 0xe1, 0x00, 0x02, 0x67, 0x64, 0x01, 0x00, 0x02, 0x68, 0xee]);
const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/** 记下每一笔画的假画布 */
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
 * 假的编码环境。`behave` 可以改:不认量化模式、重排帧、漏掉关键帧、报错。
 * 每个样本的字节 = [帧序号, 是否关键帧, 量化参数或 255]。
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
      if (behave.throwAt === n) { this.init.error(new Error('编码器坏了')); return; }
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

test('编码画面的尺寸:宽不变,高 = 2H + 16;奇数宽高拒收', () => {
  assert.equal(STREAM_HALF_PAD, 8);
  assert.deepEqual(packedSize(1920, 1080), { width: 1920, height: 2176 });
  assert.deepEqual(packedSize(960, 540), { width: 960, height: 1096 });
  assert.throws(() => packedSize(321, 160), /偶数/);
  assert.throws(() => packedSize(320, 161), /偶数/);
  assert.throws(() => packedSize(0, 160), /正整数/);
});

test('级别按像素数挑:960×1096 用 4.0,整幅 1080p 拼合后用 5.0', () => {
  assert.equal(avcCodecFor(960, 1096), 'avc1.640028');
  assert.equal(avcCodecFor(1920, 2176), 'avc1.640032');
  assert.equal(avcCodecFor(320, 336), 'avc1.64001e');
  assert.equal(avcCodecFor(1280, 720), 'avc1.64001f');
  assert.equal(avcCodecFor(3840, 4336), 'avc1.640034');
});

test('码率下限 1 Mbps,往上按像素数涨', () => {
  assert.equal(streamBitrateFor(320, 336, 30), 1_000_000);
  assert.equal(streamBitrateFor(1920, 2176, 30), Math.round(1920 * 2176 * 30 * 0.2));
});

test('一帧怎么拼:色半区画在最上面,透明度半区画在 H + 8,透明度靠 source-in 铺白取出', () => {
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
  assert.equal(scratch.ctx.globalCompositeOperation, 'source-over', '草稿画布用完改回常规合成');
});

test('能力查询:优先量化模式;不认就退到按码率;都不认或没有编码器就报不支持', async () => {
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

test('能力查询先在主线程之外问(Worker):答案照用、主线程的编码器一次都不问;问不了才退回本线程', async () => {
  const called = [];
  const counting = (inner) => ({ ...inner, VideoEncoder: Object.assign(function () {}, { isConfigSupported: async (c) => { called.push(c.bitrateMode); return inner.VideoEncoder.isConfigSupported(c); } }) });
  const env = counting(fakeEnv().env);
  // Worker 说量化模式不认、按码率的认:用按码率的那一份配置,本线程不再问
  const asked = [];
  const r1 = await probeStreamEncoder({ width: 320, height: 160, fps: 30, env, askOffThread: async (configs) => { asked.push(configs.map((c) => c.bitrateMode)); return [false, true]; } });
  assert.deepEqual(asked, [['quantizer', 'variable']], '两种配置一次问完');
  assert.equal(r1.supported, true);
  assert.equal(r1.mode, 'variable');
  assert.equal(r1.config.bitrate, 1_000_000);
  assert.equal(r1.config.height, 336);
  assert.deepEqual(called, [], '本线程的 isConfigSupported 没有被调用');
  // 都不认:报不支持,也不退回本线程(Worker 的答案是算数的)
  assert.equal((await probeStreamEncoder({ width: 320, height: 160, fps: 30, env, askOffThread: async () => [false, false] })).supported, false);
  assert.deepEqual(called, []);
  // 问不了(回 null、抛错):退回本线程,结果与原来相同
  const r2 = await probeStreamEncoder({ width: 320, height: 160, fps: 30, env, askOffThread: async () => null });
  assert.equal(r2.mode, 'quantizer');
  assert.deepEqual(called, ['quantizer']);
  const r3 = await probeStreamEncoder({ width: 320, height: 160, fps: 30, env, askOffThread: async () => { throw new Error('boom'); } });
  assert.equal(r3.mode, 'quantizer');
  // 这个运行环境没有 Worker(Node):缺省的问法回 null
  const { askConfigSupportInWorker } = await import('./streamEncode.ts');
  if (typeof globalThis.Worker !== 'function') assert.equal(await askConfigSupportInWorker([{}]), null);
});

test('37 帧 → 3 段(15、15、7):段号、样本数、关键帧位置、时间戳都对,页面侧的解封装读得回来', async () => {
  const { inits, segs, done, state } = await collect({}, 37);
  assert.deepEqual(done, { frames: 37, segments: 3, mode: 'quantizer', codec: 'avc1.640032' });
  assert.equal(inits.length, 1, '初始化段只交一次');
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
      assert.deepEqual([...bytes], [n & 0xff, i === 0 ? 1 : 0, 20], `第 ${n} 帧的样本`);
      assert.equal(s.isSync, i === 0);
      n += 1;
    });
  }
  // 送进编码器的:每 15 帧要一个关键帧;时间戳按整条流的帧号,和播放器取帧用的算法相同
  state.encoded.forEach((e, i) => {
    assert.equal(e.keyFrame, i % SEGMENT_FRAMES === 0);
    assert.equal(e.timestamp, chunkTimestamp(i, 30));
    assert.equal(e.quantizer, 20);
  });
  assert.equal(state.closed, 1, '编完关掉编码器');
});

test('从第 4 段续编:段号从 4 起,时间戳从第 60 帧起', async () => {
  const { segs, state } = await collect({ firstSegment: 4 }, 16);
  assert.deepEqual(segs.map((s) => [s.index, s.samples]), [[4, 15], [5, 1]]);
  assert.equal(state.encoded[0].timestamp, chunkTimestamp(60, 30));
  assert.equal(state.encoded[15].timestamp, chunkTimestamp(75, 30));
  assert.equal(state.encoded[15].keyFrame, true);
});

test('按码率的模式:不给每帧量化参数', async () => {
  const { done, state } = await collect({}, 3, { noQuantizer: true });
  assert.equal(done.mode, 'variable');
  assert.equal(state.encoded.every((e) => e.quantizer === undefined), true);
  assert.equal(state.configs[0].bitrateMode, 'variable');
});

test('量化参数可调,并夹在 0 ～ 51 之间', async () => {
  assert.equal((await collect({ quantizer: 12 }, 1)).state.encoded[0].quantizer, 12);
  assert.equal((await collect({ quantizer: 99 }, 1)).state.encoded[0].quantizer, 51);
  assert.equal((await collect({ quantizer: -3 }, 1)).state.encoded[0].quantizer, 0);
});

test('编码器攒到最后才吐(flush 时一起出):照样按段交、不丢帧', async () => {
  const { segs, done } = await collect({}, 20, { holdUntilFlush: true });
  assert.equal(done.frames, 20);
  assert.deepEqual(segs.map((s) => [s.index, s.samples]), [[0, 15], [1, 5]]);
});

test('onSegment 是异步的(比如上传):段按顺序交,finish 等它们都交完', async () => {
  const f = fakeEnv();
  const order = [];
  const enc = await openStreamEncoder({ width: 320, height: 160, fps: 30, env: f.env,
    onInit: async () => { await new Promise((r) => setTimeout(r, 5)); order.push('init'); },
    onSegment: async (s) => { await new Promise((r) => setTimeout(r, s.index === 0 ? 10 : 1)); order.push(`seg${s.index}`); } });
  for (let i = 0; i < 31; i++) await enc.add({ name: i });
  await enc.finish();
  assert.deepEqual(order, ['init', 'seg0', 'seg1', 'seg2']);
});

test('编码器重排了帧(B 帧):报错,不交乱序的流', async () => {
  await assert.rejects(collect({}, 5, { reorder: true, holdUntilFlush: true }), /重排/);
});

test('段首没拿到关键帧:报错', async () => {
  await assert.rejects(collect({}, 20, { dropKeyAt: 15 }), /关键帧/);
});

test('编码器中途报错:add 或 finish 抛出来,编码器被关掉', async () => {
  const f = fakeEnv({ throwAt: 3 });
  const enc = await openStreamEncoder({ width: 320, height: 160, fps: 30, env: f.env, onInit() {}, onSegment() {} });
  await assert.rejects((async () => { for (let i = 0; i < 6; i++) await enc.add({ name: i }); await enc.finish(); })(), /编码器坏了/);
  assert.equal(f.state.closed, 1);
});

test('onSegment 抛错:finish 抛同一个错', async () => {
  const f = fakeEnv();
  const enc = await openStreamEncoder({ width: 320, height: 160, fps: 30, env: f.env, onInit() {}, onSegment() { throw new Error('传不上去'); } });
  for (let i = 0; i < 15; i++) await enc.add({ name: i });
  await assert.rejects(enc.finish(), /传不上去/);
});

test('取消之后不能再送帧;浏览器压不了时一开始就报错', async () => {
  const f = fakeEnv();
  const enc = await openStreamEncoder({ width: 320, height: 160, fps: 30, env: f.env, onInit() {}, onSegment() {} });
  await enc.add({ name: 0 });
  enc.abort();
  await assert.rejects(enc.add({ name: 1 }), /已经关了/);
  assert.equal(f.state.closed, 1);
  await assert.rejects(openStreamEncoder({ width: 320, height: 160, fps: 30, env: fakeEnv({ unsupported: true }).env, onInit() {}, onSegment() {} }), /压不了/);
});

test('每一帧用完就关掉(不占着显存)', async () => {
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
