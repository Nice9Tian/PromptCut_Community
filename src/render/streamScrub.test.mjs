/**
 * 轨道流播放器在**暂停和拖动**时取任意一帧的单测(`streamPlayer.ts`;任务书「己三:暂停和拖动贴流」)。
 * 跑:npm test -- src/render/streamScrub.test.mjs
 *
 * 真解码要浏览器(`VideoDecoder` / WebGL),端到端在 `scripts/probes/scrub-stream-probe.mjs`。这里解码器、画布、时钟是假的,
 * 分段是真的(`streamMux.ts` 封的 fMP4)、寻帧逻辑是真的,钉住:
 *
 *   - 不播放时把时间设到任意一帧(非关键帧、往回、跨分段、片段不从 15 的倍数帧开始):画出来的就是这一帧,
 *     而且是从它所在分段的关键帧一帧不缺解过来的(假解码器查依赖链);
 *   - 这一帧还没解出来时留着上一张,最多留一个分段的时长,到时清空;画面有无变了回调宿主(暂停着没有下一拍);
 *   - 连着跳(拖动)不打断在途的那一次寻帧,它解到了先画上,再去解此刻要的那一帧,中间经过的帧不解;
 *     在途太久(`SEEK_PATIENCE_MS`)照样打断;还没有画面时不拿过旧的帧当第一张;
 *   - 稀疏分段(每个分段只有一张重复的画面,或每 3 帧一张):贴的是不晚于这一帧的最近一张,只解到那一张就画;
 *     停在稀疏段上、这一段换成了满密度的文件:自己换上;
 *   - 画布换了一块(包裹层重挂载)把刚才那张原样画回去;换了流键当场清空;
 *   - 暂停着把后面几帧先解好:下一帧来的时候当场就有;
 *   - 单个解码器同时持有的帧不超过 8,停下以后全部关掉。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer, frameOfTimestamp, SEGMENT_FRAMES, HOLD_FRAMES, MAX_FRAMES_PER_DECODER, SEEK_PATIENCE_MS, FIRST_PICTURE_LAG_MS, MANIFEST_REFRESH_MS, GL_RETRY_MS, GL_RETRY_MAX_MS } from './streamPlayer.ts';
import { buildStreamInit, buildStreamSegment } from './streamMux.ts';
import { streamSegmentFrameCount, streamSegmentSpan } from './streamSegments.mjs';

const FPS = 30;
const HOLD_MS = (HOLD_FRAMES * 1000) / FPS;
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x03, 0x68, 0xee, 0x3c]);
const INIT_ID = 'i'.repeat(16);

/* ---------------------------------------------------------------- 假的时钟(舞台留的两个口子) */

let now = 1_000_000;
let timers = [];
globalThis.__pcRealNow = () => now;
globalThis.__pcRealSetTimeout = (fn, ms = 0) => { timers.push({ at: now + ms, fn }); return timers.length; };
/** 走过 `ms` 毫秒,到点的定时器按时刻依次响 */
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

/* ---------------------------------------------------------------- 假的解码器 */

const frames = { open: 0, maxOpen: 0 };
const decoders = [];
/** 解码器的输出要不要先压着(`decoderGate.hold = true` 时一帧都不出,放开后接着出) */
const decoderGate = { hold: false };

/**
 * 假解码器:一个宏任务出一帧,按喂的顺序。照真解码器的规矩查:配置 / 重置之后第一块必须是关键帧;差分帧必须紧跟着上一块
 * (同一个分段里一帧不缺),否则这一帧记成坏的(`intact: false`)。每帧可以 `clone()`,开着的份数都算。
 */
class FakeDecoder {
  constructor({ output }) {
    this.output = output; this.state = 'unconfigured'; this.gen = 0; this.queue = []; this.draining = false;
    this.needKey = true; this.prev = null; this.chainOk = false; this.resets = 0; this.fed = [];
    decoders.push(this);
  }
  get decodeQueueSize() { return this.queue.length; }
  configure() { this.state = 'configured'; this.needKey = true; this.prev = null; this.gen++; this.queue = []; }
  reset() { this.state = 'unconfigured'; this.resets++; this.gen++; this.queue = []; }
  close() { this.state = 'closed'; this.gen++; this.queue = []; }
  decode(chunk) {
    if (this.state !== 'configured') throw new Error('not configured');
    if (this.needKey && chunk.type !== 'key') throw new Error('A key frame is required after configure() or flush()');
    const f = frameOfTimestamp(chunk.timestamp, FPS);
    if (chunk.type === 'key') this.chainOk = true;
    else if (this.prev === null || f !== this.prev + 1) this.chainOk = false;
    this.needKey = false;
    this.prev = f;
    this.fed.push({ frame: f, segment: chunk.data[1], sample: chunk.data[2], file: chunk.data[3], key: chunk.type === 'key' });
    this.queue.push({ gen: this.gen, timestamp: chunk.timestamp, intact: this.chainOk, mark: [chunk.data[1], chunk.data[2], chunk.data[3]] });
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
  const body = { timestamp: info.timestamp, intact: info.intact, mark: info.mark, displayHeight: 144, codedHeight: 144 };
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

/* ---------------------------------------------------------------- 假的画布(只记下画了哪一帧) */

/*
 * 全部流平面共用一个 WebGL 上下文,建在一块离屏画布上(`streamPlayer.ts` 的 `SharedGl`):假的只记下最近上传的是哪一帧;
 * 平面自己是 2D 画布,`drawImage` 取走时把那一帧记成它画的。
 */
const sharedGl = { last: null, contexts: 0, canvases: [], fail: 0, attempts: 0 };
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; this.lost = false; this.listeners = {}; sharedGl.canvases.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  /** 丢上下文 / 浏览器还回来(用例里手动触发) */
  lose() { this.lost = true; for (const fn of this.listeners.webglcontextlost ?? []) fn({ preventDefault() {} }); }
  restore() { this.lost = false; for (const fn of this.listeners.webglcontextrestored ?? []) fn({}); }
  getContext() {
    sharedGl.attempts++;
    // 用例里让接下来的几次建不出上下文(`sharedGl.fail`)
    if (sharedGl.fail > 0) { sharedGl.fail--; return null; }
    sharedGl.contexts++;
    return new Proxy({
      getShaderParameter: () => true, getProgramParameter: () => true, createShader: () => ({}), createProgram: () => ({}),
      createBuffer: () => ({}), createTexture: () => ({}), getAttribLocation: () => 0, getUniformLocation: () => ({}), getExtension: () => null,
      isContextLost: () => this.lost,
      texImage2D: (...a) => { if (!this.lost) sharedGl.last = a[a.length - 1]; },
    }, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => {}) });
  }
};

function fakeCanvas() {
  const canvas = { draws: [], clears: 0, width: 0, height: 0, parentElement: null,
    style: { props: {}, getPropertyValue(k) { return this.props[k] ?? ''; }, setProperty(k, v) { this.props[k] = v; } } };
  const gl = new Proxy({
    getShaderParameter: () => true, getProgramParameter: () => true, createShader: () => ({}), createProgram: () => ({}),
    createBuffer: () => ({}), createTexture: () => ({}), getAttribLocation: () => 0, getUniformLocation: () => ({}), getExtension: () => null,
    drawImage: () => { canvas.draws.push(sharedGl.last); },
    clearRect: () => { canvas.clears++; },
  }, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => {}) });
  canvas.getContext = () => gl;
  return canvas;
}
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
/** 等到条件成立(每轮让出一个宏任务);等不到就照实断言失败 */
async function until(fn, label, rounds = 400) {
  for (let i = 0; i < rounds; i++) { if (fn()) return; await new Promise((r) => setImmediate(r)); }
  assert.fail(`Timed out waiting for: ${label}`);
}

/* ---------------------------------------------------------------- 一条流 */

/**
 * 盖住项目帧 `firstFrame .. lastFrame` 的流。每个样本 4 个字节 `[0xAB, 分段号, 这个样本里是第几张画面, 文件版本]`:
 * 满密度(`stride` 1)时「第几张画面」就是样本序号;稀疏时每 `stride` 个样本是同一张(不晚于它的最近一张)。
 * `version` 区分同一段的两份文件(稀疏的那份和后来换上的满密度那份)。
 */
function segmentFile(n, count, stride, version) {
  const samples = Array.from({ length: count }, (_, i) => ({ data: Uint8Array.from([0xab, n, Math.floor(i / stride) * stride, version]), isSync: i === 0 }));
  return buildStreamSegment({ sequence: n + 1, baseDecodeTime: n * SEGMENT_FRAMES, samples });
}
function streamOf(firstFrame, lastFrame, { stride = 1 } = {}) {
  const { originFrame, lastSegment } = streamSegmentSpan(firstFrame, lastFrame);
  const init = buildStreamInit({ width: 64, height: 144, fps: FPS, avcC: AVCC });
  const files = new Map();
  const segments = {};
  const countOf = (n) => streamSegmentFrameCount(n, originFrame, lastFrame);
  for (let n = 0; n <= lastSegment; n++) {
    const file = `${n}-s${stride}.m4s`;
    files.set(file, segmentFile(n, countOf(n), stride, stride));
    segments[n] = { init: INIT_ID, file, stride, samples: countOf(n) };
  }
  const manifest = { streamKey: 'K', kind: 'card', plane: 'local', clipIds: ['a'], fps: FPS, segmentFrames: SEGMENT_FRAMES, originFrame,
    bound: { x: 0, y: 0, w: 64, h: 64 }, tight: null, inits: { [INIT_ID]: { codec: 'avc1.64001f', width: 64, height: 144, rect: { x: 0, y: 0, w: 64, h: 64 } } }, segments };
  const asked = [];
  const held = new Map();
  const copy = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const stream = {
    originFrame, lastSegment, manifest, asked, manifestCalls: 0,
    source: {
      manifest: async () => { stream.manifestCalls++; return { ...stream.manifest, segments: { ...stream.manifest.segments } }; },
      init: async () => copy(init),
      segment: async (_key, file) => { asked.push(file); if (held.has(file)) await held.get(file).promise; return copy(files.get(file)); },
    },
    /** 这一段的字节先不到货,`release` 才到 */
    hold(file) { let open; const promise = new Promise((r) => { open = r; }); held.set(file, { promise, open }); },
    release(file) { held.get(file)?.open(); held.delete(file); },
    /** 把第 n 段换成满密度的文件(生产者补密以后清单里换了文件名) */
    densify(n) {
      const file = `${n}-s1.m4s`;
      files.set(file, segmentFile(n, countOf(n), 1, 1));
      stream.manifest = { ...stream.manifest, segments: { ...stream.manifest.segments, [n]: { init: INIT_ID, file, stride: 1, samples: countOf(n) } } };
    },
    plane: { clipIds: ['a'], key: 'K', ranges: [[0, lastSegment]], originFrame },
  };
  return stream;
}

function playerFor(stream, { onShowingChange } = {}) {
  const dom = { canvas: fakeCanvas() };
  const root = { querySelector(sel) { return /^\[data-pc-clip="a"\] > canvas\[data-pc-stream-plane\]$/.test(sel) ? dom.canvas : null; }, contains: (el) => el === dom.canvas };
  dom.canvas.isConnected = true;
  dom.canvas.parentElement = { getAttribute: (k) => (k === 'data-pc-clip' ? 'a' : null), querySelector: () => null };
  const player = new StreamPlayer({ root: () => root, source: stream.source, onShowingChange });
  player.setPlanes([stream.plane], FPS);
  const track = () => player.diag().tracks[0];
  /** 画布上最后画的那一帧:`[分段号, 第几张画面, 文件版本]` 与它是不是从关键帧一帧不缺解过来的 */
  const last = () => dom.canvas.draws.at(-1) ?? null;
  return { player, dom, track, last, seek: (f) => player.present(f / FPS) };
}
/** 等播放器把要的那一帧画出来 */
const drawn = (h, f) => until(() => h.track()?.lastDrawn === f, `draw frame ${f} (currently ${JSON.stringify(h.track()?.lastDrawn)})`);

beforeEach(() => { decoders.length = 0; frames.open = 0; frames.maxOpen = 0; now = 1_000_000; timers = []; decoderGate.hold = false; });

/* ---------------------------------------------------------------- 取任意一帧 */

test('while paused, set the time to any frame: the clip starts at frame 100 (not a multiple of 15), non-keyframes, backward, across segments; every time the frame drawn is exactly this one, decoded from the segment\'s keyframe with no frame missing', async () => {
  const stream = streamOf(100, 189);   // 6 个分段
  const h = playerFor(stream);
  for (const f of [137, 152, 108, 185, 187, 160, 159, 100, 189, 114, 115]) {
    h.seek(f);
    await drawn(h, f);
    const seg = Math.floor((f - 100) / 15), sample = (f - 100) % 15;
    const shot = h.last();
    assert.deepEqual(shot.mark, [seg, sample, 1], `frame ${f} is sample ${sample} of segment ${seg}`);
    assert.equal(frameOfTimestamp(shot.timestamp, FPS), f, `frame ${f}: the drawn frame is recorded under its own project frame number`);
    assert.equal(shot.intact, true, `frame ${f}: decoded from the keyframe with no frame missing`);
    assert.equal(h.track().stale, false);
    assert.equal(h.track().picture, f, 'full-density segment: the picture is this frame itself');
  }
  assert.ok(frames.maxOpen <= MAX_FRAMES_PER_DECODER + 1, `frames open at the same time (${frames.maxOpen}) do not exceed the decoder limit (plus the one on the canvas)`);
  h.player.stop();
  assert.equal(frames.open, 0, 'all frames are closed after stopping');
});

test('random jump to a frame: fetch only the segment it is in, feeding from the first sample of that segment', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  h.seek(149);   // 第 3 段的第 4 个样本
  await drawn(h, 149);
  assert.equal(stream.asked[0], '3-s1.m4s');
  const fed = decoders[0].fed.filter((c) => c.frame <= 149);
  assert.deepEqual(fed.map((c) => [c.frame, c.segment, c.sample, c.key]), Array.from({ length: 5 }, (_, i) => [145 + i, 3, i, i === 0]));
  h.player.stop();
});

/* ---------------------------------------------------------------- 留着上一张 */

test('this frame is not decoded yet: keep the previous one, for at most one segment duration; clear only if there is still no new picture by then, and call the host once (no next tick while paused)', async () => {
  const stream = streamOf(100, 189);
  let calls = 0;
  const h = playerFor(stream, { onShowingChange: () => { calls++; } });
  h.seek(105);
  await drawn(h, 105);
  await flush();
  assert.equal(calls, 1, 'first picture drawn asynchronously: call the host once');
  // 往回跳到很远、往前跳到很远都一样:那一段的字节迟迟不到
  stream.hold('4-s1.m4s');
  h.seek(170);
  await flush();
  assert.equal(h.track().lastDrawn, 105, 'keeps the previous frame');
  assert.equal(h.track().stale, true);
  assert.deepEqual([...h.player.showingClips()], ['a']);
  await advance(HOLD_MS - 30);
  assert.equal(h.track().lastDrawn, 105, `${HOLD_MS} ms not reached yet: keep holding as before`);
  assert.equal(calls, 1);
  await advance(60);
  await flush();
  assert.equal(h.track().lastDrawn, null, 'time is up: clear, this layer falls back to the placeholder');
  assert.deepEqual([...h.player.showingClips()], []);
  assert.equal(calls, 2, 'picture goes from present to absent: call the host once');
  // 字节到了:要的那一帧自己画上,再叫宿主一次(占位符靠它撤)
  stream.release('4-s1.m4s');
  await drawn(h, 170);
  await flush();
  assert.equal(calls, 3);
  assert.equal(h.track().stale, false);
  h.player.stop();
});

test('jumping backward also keeps the previous picture (previously a backward jump cleared immediately, relying on the snapshot underneath)', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  h.seek(160);
  await drawn(h, 160);
  decoderGate.hold = true;
  h.seek(120);
  await flush(4);
  assert.equal(h.track().lastDrawn, 160);
  assert.deepEqual([...h.player.showingClips()], ['a']);
  decoderGate.hold = false;
  await drawn(h, 120);
  h.player.stop();
});

test('this segment is not in the ready range: what is already drawn is kept, time-limited; what had no picture is not drawn', async () => {
  const stream = streamOf(100, 189);
  stream.plane = { ...stream.plane, ranges: [[0, 1]] };
  const h = playerFor(stream);
  h.seek(170);
  await flush();
  assert.equal(h.track().lastDrawn, null);
  assert.deepEqual(stream.asked, [], 'segments that are not ready are not fetched');
  h.seek(110);
  await drawn(h, 110);
  h.seek(170);
  await flush();
  assert.equal(h.track().lastDrawn, 110, 'keeps the previous frame');
  await advance(HOLD_MS + 40);
  await flush();
  assert.equal(h.track().lastDrawn, null);
  h.player.stop();
});

/* ---------------------------------------------------------------- 连着跳 */

test('fast drag: do not interrupt the in-flight seek, draw it first once decoded, then decode the frame wanted now; segments of frames passed over in between are not fetched', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  h.seek(104);
  await drawn(h, 104);
  const before = decoders[0].resets;
  stream.asked.length = 0;
  decoderGate.hold = true;
  h.seek(140);            // 第 2 段:在途
  await until(() => decoders[0].fed.some((c) => c.segment === 2), 'the in-flight one has already been fed');
  h.seek(155);            // 第 3 段:经过,不解
  h.seek(125);            // 第 1 段:经过,不解
  h.seek(186);            // 第 5 段:此刻要的
  await flush(4);
  assert.equal(decoders[0].resets, before + 1, 'four consecutive steps reset the decoder only once');
  assert.ok(h.track().deferred >= 3);
  assert.equal(h.track().lastDrawn, 104, 'the in-flight one is not decoded yet: keep the previous picture');
  decoderGate.hold = false;
  await until(() => h.track().lastDrawn === 140 || h.track().lastDrawn === 186, 'the in-flight frame is drawn first');
  await drawn(h, 186);
  assert.deepEqual(h.last().mark, [5, 11, 1]);
  assert.equal(h.last().intact, true);
  assert.ok(!stream.asked.includes('1-s1.m4s') && !stream.asked.includes('3-s1.m4s'), `segments passed over in between were not fetched: ${stream.asked}`);
  assert.ok(stream.asked.includes('2-s1.m4s') && stream.asked.includes('5-s1.m4s'));
  assert.ok(!decoders[0].fed.some((c) => c.segment === 3 || c.segment === 1), 'not a single chunk of the frames passed over in between was fed to the decoder');
  h.player.stop();
});

test('in-flight seek not decoded within the patience limit: a new target still resets the decoder', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  h.seek(104);
  await drawn(h, 104);
  decoderGate.hold = true;   // 解码器收了块、迟迟不出帧
  h.seek(140);
  await until(() => decoders[0].fed.some((c) => c.segment === 2), 'the in-flight one has already been fed');
  const resets = decoders[0].resets;
  h.seek(186);
  await flush(4);
  assert.equal(decoders[0].resets, resets, 'no interruption within the limit');
  now += SEEK_PATIENCE_MS + 1;
  h.seek(186);
  assert.equal(decoders[0].resets, resets + 1, 'past the limit: reset anyway, switching to the frame wanted now');
  decoderGate.hold = false;
  await drawn(h, 186);
  h.player.stop();
});

test('the in-flight one has not even received its bytes yet (no chunk fed to the decoder): do not yield to it, switch directly to the frame wanted now', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  h.seek(104);
  await drawn(h, 104);
  stream.hold('2-s1.m4s');
  h.seek(140);
  await flush(4);
  h.seek(186);
  await drawn(h, 186);
  assert.equal(h.track().deferred, 0);
  stream.release('2-s1.m4s');
  h.player.stop();
});

test('when there is no picture yet, an old frame decoded by an in-flight seek past the limit does not count as the first one (the host waits for the first one before hiding the live subtree)', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  decoderGate.hold = true;
  h.seek(125);
  await until(() => decoders[0]?.fed.length > 0, 'the in-flight one has already been fed');
  now += FIRST_PICTURE_LAG_MS + 5;
  h.seek(186);
  await flush(2);
  assert.ok(h.track().deferred >= 1, 'the in-flight one was not interrupted');
  decoderGate.hold = false;
  await drawn(h, 186);
  assert.ok(!h.dom.canvas.draws.some((d) => frameOfTimestamp(d.timestamp, FPS) === 125), 'frame 125 is too old, not drawn');
  h.player.stop();
});

/* ---------------------------------------------------------------- 稀疏分段 */

test('a sparse segment has only one repeated picture per segment: the one pasted is the nearest one not later than this frame (the first frame of this segment), drawn after decoding just one sample; only looks backward', async () => {
  const stream = streamOf(100, 189, { stride: SEGMENT_FRAMES });
  const h = playerFor(stream);
  for (const f of [137, 115, 189, 100, 129]) {
    decoders.forEach((d) => { d.fed.length = 0; });
    h.dom.canvas.draws.length = 0;
    h.seek(f);
    const seg = Math.floor((f - 100) / 15), first = 100 + seg * 15;
    await until(() => h.track().picture === first, `frame ${f} draws the picture of frame ${first}`);
    const shot = h.dom.canvas.draws[0];
    assert.equal(frameOfTimestamp(shot.timestamp, FPS), first, `frame ${f}: what is drawn first is the sample of frame ${first} (no need to decode up to frame ${f})`);
    assert.deepEqual(shot.mark, [seg, 0, SEGMENT_FRAMES]);
    assert.ok(h.track().picture <= f, 'does not take a later one');
    assert.equal(h.track().level, 'sparse');
    assert.equal(h.track().stale, false, 'this picture is exactly what this frame should have, not stale');
    await drawn(h, f);   // 后面接着解到这一帧自己(同一张画面),再做下一处
  }
  assert.ok(h.track().standIns >= 3);
  // 在同一个分段里挪:还是那一张,不用重画、不算缺
  const draws = h.dom.canvas.draws.length;
  h.seek(121);
  assert.equal(h.track().picture, 115);
  assert.equal(h.track().stale, false);
  assert.ok(h.dom.canvas.draws.length <= draws + 1);
  h.player.stop();
});

test('sparse segment with one picture every 3 frames: frame F uses picture floor((F-start)/3)×3; moving within the same picture does not count as a missing picture', async () => {
  const stream = streamOf(100, 189, { stride: 3 });
  const h = playerFor(stream);
  h.seek(122);   // 第 1 段(115 起)的第 7 个样本 → 第 6 张(第 121 帧)
  await until(() => h.track().picture === 121, 'draw the picture of frame 121');
  assert.deepEqual(h.last().mark, [1, 6, 3]);
  await drawn(h, 122);
  h.seek(123);
  await flush();
  assert.equal(h.track().stale, false);
  assert.equal(h.track().picture, 121, 'frame 123 is the same picture as frames 121 and 122');
  h.seek(124);
  await until(() => h.track().picture === 124, 'frame 124 is the next picture');
  h.player.stop();
});

test('parked on a sparse segment, this segment is replaced by a full-density file: after the manifest refresh interval it swaps in the exact picture of this frame by itself, without waiting for user action', async () => {
  const stream = streamOf(100, 189, { stride: SEGMENT_FRAMES });
  const h = playerFor(stream);
  h.seek(110);                 // 先在别处停一下:刷新的定时器从这里就排上了
  await drawn(h, 110);
  await advance(MANIFEST_REFRESH_MS - 300);
  h.seek(137);
  await until(() => h.track().picture === 130, 'sparse: the picture of frame 130');
  await drawn(h, 137);
  assert.deepEqual(h.last().mark, [2, 0, SEGMENT_FRAMES], 'the sparse file: this segment has only frame 0');
  stream.densify(2);
  // 刷新的定时器是早先(拖到别的帧时)排的、到点时播放头刚停下不久:它接着排,不能就此断了
  await advance(MANIFEST_REFRESH_MS + 100);
  await advance(MANIFEST_REFRESH_MS + 100);
  await until(() => h.last().mark[1] === 7 && h.last().mark[2] === 1, 'the full-density file: sample 7 of segment 2');
  assert.equal(h.last().mark[0] === 2 && h.last().intact, true);
  assert.equal(h.track().level, 'dense');
  assert.equal(h.track().picture, 137);
  h.player.stop();
});

/* ---------------------------------------------------------------- 画布、流键 */

test('canvas swapped (wrapper remounted per clip): redraw the previous frame as is, without waiting for decode, so what is visible does not change', async () => {
  const stream = streamOf(100, 189);
  let calls = 0;
  const h = playerFor(stream, { onShowingChange: () => { calls++; } });
  h.seek(150);
  await drawn(h, 150);
  await flush();
  const callsBefore = calls;
  const old = h.dom.canvas;
  old.isConnected = false;
  const fresh = fakeCanvas();
  fresh.isConnected = true;
  fresh.parentElement = old.parentElement;
  h.dom.canvas = fresh;
  decoderGate.hold = true;   // 解码器一帧都不出:画回去靠的是手里那一份
  h.seek(150);
  assert.ok(fresh.draws.length >= 1, 'drawn within the same task');
  assert.ok(fresh.draws.every((d) => frameOfTimestamp(d.timestamp, FPS) === 150));
  assert.equal(h.track().lastDrawn, 150);
  await flush();
  assert.equal(calls, callsBefore, 'always has a picture: does not call the host');
  decoderGate.hold = false;
  h.player.stop();
  assert.equal(frames.open, 0);
});

test('stream key changed on the same canvas (input changed): the old picture is cleared immediately, not kept', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  h.seek(150);
  await drawn(h, 150);
  h.player.setPlanes([{ ...stream.plane, originFrame: 130 }], FPS);
  stream.hold('1-s1.m4s');
  h.seek(150);
  assert.equal(h.track().lastDrawn, null, 'an old picture with a mismatched frame number is not kept');
  stream.release('1-s1.m4s');
  h.player.stop();
});

/* ---------------------------------------------------------------- 起播 */

test('while paused, decode this frame and the next few first: on play, the first few ticks have a picture immediately, with no wait for decode', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  h.seek(143);
  await drawn(h, 143);
  await flush();
  const draws = h.dom.canvas.draws.length;
  decoderGate.hold = true;   // 起播以后解码器一帧都不出
  h.seek(144);
  assert.equal(h.track().lastDrawn, 144, 'next frame is drawn synchronously');
  assert.equal(h.dom.canvas.draws.length, draws + 1);
  h.seek(145);
  assert.equal(h.track().lastDrawn, 145);
  decoderGate.hold = false;
  h.player.stop();
});

/* ---------------------------------------------------------------- 全部流平面共用一个 WebGL 上下文 */

test('the stream plane shares one WebGL context: created on an offscreen canvas, only once; no new one when the plane switches canvas', async () => {
  const before = sharedGl.contexts;
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  assert.equal(sharedGl.contexts, before, 'not drawn yet: no context created (the stage of the back role never draws, so never creates one)');
  h.seek(150);
  await drawn(h, 150);
  assert.equal(sharedGl.contexts, before + 1);
  const fresh = fakeCanvas();
  fresh.isConnected = true;
  fresh.parentElement = h.dom.canvas.parentElement;
  h.dom.canvas.isConnected = false;
  h.dom.canvas = fresh;
  h.seek(151);
  await drawn(h, 151);
  assert.ok(fresh.draws.length >= 1);
  assert.equal(sharedGl.contexts, before + 1, 'switching canvas does not create a new context');
  assert.deepEqual({ state: h.player.diag().gl.state, creates: h.player.diag().gl.creates }, { state: 'ready', creates: 1 });
  h.player.stop();
  assert.equal(sharedGl.canvases.at(-1).width, 2, 'moved to back: the offscreen canvas shrinks to the minimum, the context is kept');
  assert.equal(frames.open, 0);
});

test('shared context lost: this tick cannot draw and keeps the previous frame; when the browser restores it, this frame is drawn; if it is not restored in time, a new one is created', async () => {
  const stream = streamOf(100, 189);
  let lost = 0;
  const dom = { canvas: fakeCanvas() };
  const root = { querySelector(sel) { return /^\[data-pc-clip="a"\] > canvas\[data-pc-stream-plane\]$/.test(sel) ? dom.canvas : null; }, contains: (el) => el === dom.canvas };
  dom.canvas.isConnected = true;
  dom.canvas.parentElement = { getAttribute: (k) => (k === 'data-pc-clip' ? 'a' : null), querySelector: () => null };
  const player = new StreamPlayer({ root: () => root, source: stream.source, onContextLost: () => { lost++; } });
  player.setPlanes([stream.plane], FPS);
  const track = () => player.diag().tracks[0];
  const seek = (f) => player.present(f / FPS);
  seek(150);
  await until(() => track()?.lastDrawn === 150, 'frame 150 is drawn');
  const gl = sharedGl.canvases.at(-1);
  const contexts = sharedGl.contexts;

  gl.lose();
  assert.equal(lost, 1, 'tell the host once (the online page reports "something went wrong while running" based on this)');
  const draws = dom.canvas.draws.length;
  seek(151);
  await flush();
  assert.equal(track().lastDrawn, 150, 'frame 151 is decoded but cannot be drawn: keeps the previous frame');
  assert.equal(dom.canvas.draws.length, draws);
  assert.equal(player.diag().gl.state, 'lost');

  gl.restore();
  await until(() => track()?.lastDrawn === 151, 'after the context is restored, draws this frame by itself (no next tick while paused)');
  assert.equal(sharedGl.contexts, contexts, 'the restored one is the original, no new one is created');
  assert.equal(player.diag().gl.restores, 1);

  // 再丢一次,这回浏览器不还(名额被别的画布挤掉):到 GL_RETRY_MS 另建一块,这一帧自己画上
  gl.lose();
  seek(152);
  await flush();
  assert.equal(track().lastDrawn, 151);
  await advance(GL_RETRY_MS + 60);
  await until(() => track()?.lastDrawn === 152, 'after a new context is created, this frame is drawn');
  assert.equal(sharedGl.contexts, contexts + 1);
  assert.equal(player.diag().gl.creates, 2);
  player.stop();
  assert.equal(frames.open, 0);
});

test('manifest rectangle upper bound changed while the context is lost: canvas size stays, the previous frame stays; the size changes only once drawing works', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  h.seek(150);
  await drawn(h, 150);
  await flush();
  assert.equal(h.dom.canvas.width, 64);
  const gl = sharedGl.canvases.at(-1);
  gl.lose();
  // 父页带来一份新清单,矩形上界大了一圈(改 2D 画布的宽高会把它清空)
  const bigger = { ...stream.manifest, bound: { x: 0, y: 0, w: 128, h: 128 } };
  h.player.setPlanes([{ ...stream.plane, manifest: bigger }], FPS);
  const clears = h.dom.canvas.clears;
  h.seek(151);
  await flush();
  assert.equal(h.dom.canvas.width, 64, 'canvas size is not changed when drawing is impossible');
  assert.equal(h.dom.canvas.clears, clears, 'and not cleared either');
  assert.equal(h.track().lastDrawn, 150, 'the recorded state matches the canvas: still the previous frame');
  gl.restore();
  await drawn(h, 151);
  assert.equal(h.dom.canvas.width, 128, 'drawn, size follows the new manifest');
  h.player.stop();
  assert.equal(frames.open, 0);
});

test('shared context cannot be created: retries by itself even while paused, with the interval doubling each time; once created, this frame is drawn', async () => {
  const stream = streamOf(100, 189);
  const attempts = sharedGl.attempts;
  sharedGl.fail = 2;
  const h = playerFor(stream);
  h.seek(150);
  await until(() => sharedGl.attempts === attempts + 1, 'first context creation attempt (failed)');
  await flush();
  assert.equal(h.track().lastDrawn, null);
  assert.equal(h.player.diag().gl.state, 'none');
  // 没有任何一拍再来(暂停着)。过 GL_RETRY_MS:自己再试一次,又没建出来
  await advance(GL_RETRY_MS + 60);
  await flush();
  assert.equal(sharedGl.attempts, attempts + 2);
  assert.equal(h.track().lastDrawn, null);
  // 第二次失败以后间隔加倍:再过 GL_RETRY_MS 还不试
  await advance(GL_RETRY_MS + 60);
  await flush();
  assert.equal(sharedGl.attempts, attempts + 2, 'interval doubled, not reached yet');
  await advance(GL_RETRY_MS + 60);
  await until(() => h.track()?.lastDrawn === 150, 'created on the third attempt, this frame draws by itself');
  assert.equal(sharedGl.attempts, attempts + 3);
  assert.deepEqual({ creates: h.player.diag().gl.creates, failures: h.player.diag().gl.failures }, { creates: 1, failures: 2 });
  // 停了以后不再排:没有流要画就不空转
  sharedGl.fail = 0;
  h.player.stop();
  const pending = timers.length;
  await advance(GL_RETRY_MAX_MS * 2);
  assert.ok(timers.length <= pending, 'no newly scheduled timers after stopping');
  assert.equal(frames.open, 0);
});
