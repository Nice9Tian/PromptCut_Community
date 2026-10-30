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
  assert.fail(`等不到:${label}`);
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
const drawn = (h, f) => until(() => h.track()?.lastDrawn === f, `画出第 ${f} 帧(现在 ${JSON.stringify(h.track()?.lastDrawn)})`);

beforeEach(() => { decoders.length = 0; frames.open = 0; frames.maxOpen = 0; now = 1_000_000; timers = []; decoderGate.hold = false; });

/* ---------------------------------------------------------------- 取任意一帧 */

test('暂停着把时间设到任意一帧:片段从第 100 帧开始(不是 15 的倍数),非关键帧、往回、跨分段,每次画出来的都是这一帧,从本段关键帧一帧不缺解过来', async () => {
  const stream = streamOf(100, 189);   // 6 个分段
  const h = playerFor(stream);
  for (const f of [137, 152, 108, 185, 187, 160, 159, 100, 189, 114, 115]) {
    h.seek(f);
    await drawn(h, f);
    const seg = Math.floor((f - 100) / 15), sample = (f - 100) % 15;
    const shot = h.last();
    assert.deepEqual(shot.mark, [seg, sample, 1], `第 ${f} 帧是第 ${seg} 段的第 ${sample} 个样本`);
    assert.equal(frameOfTimestamp(shot.timestamp, FPS), f, `第 ${f} 帧:画上去的那一帧记在它自己的项目帧号上`);
    assert.equal(shot.intact, true, `第 ${f} 帧:从关键帧一帧不缺解过来`);
    assert.equal(h.track().stale, false);
    assert.equal(h.track().picture, f, '满密度的分段:画面就是这一帧自己');
  }
  assert.ok(frames.maxOpen <= MAX_FRAMES_PER_DECODER + 1, `同时开着的帧 ${frames.maxOpen} 不超过解码器上限(另加画布上那一张)`);
  h.player.stop();
  assert.equal(frames.open, 0, '停下以后帧全部关掉');
});

test('随机跳到一帧:只取它所在的那个分段,从这一段的第一个样本喂起', async () => {
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

test('这一帧还没解出来:留着上一张,最多留一个分段的时长;到时还没有新画面才清空,并叫宿主一次(暂停着没有下一拍)', async () => {
  const stream = streamOf(100, 189);
  let calls = 0;
  const h = playerFor(stream, { onShowingChange: () => { calls++; } });
  h.seek(105);
  await drawn(h, 105);
  await flush();
  assert.equal(calls, 1, '第一张画面异步画出来:叫宿主一次');
  // 往回跳到很远、往前跳到很远都一样:那一段的字节迟迟不到
  stream.hold('4-s1.m4s');
  h.seek(170);
  await flush();
  assert.equal(h.track().lastDrawn, 105, '留着上一张');
  assert.equal(h.track().stale, true);
  assert.deepEqual([...h.player.showingClips()], ['a']);
  await advance(HOLD_MS - 30);
  assert.equal(h.track().lastDrawn, 105, `还没到 ${HOLD_MS} 毫秒:照旧留着`);
  assert.equal(calls, 1);
  await advance(60);
  await flush();
  assert.equal(h.track().lastDrawn, null, '到时了:清空,这一层落到占位符');
  assert.deepEqual([...h.player.showingClips()], []);
  assert.equal(calls, 2, '画面从有到无:叫宿主一次');
  // 字节到了:要的那一帧自己画上,再叫宿主一次(占位符靠它撤)
  stream.release('4-s1.m4s');
  await drawn(h, 170);
  await flush();
  assert.equal(calls, 3);
  assert.equal(h.track().stale, false);
  h.player.stop();
});

test('往回跳也留着上一张(以前往回跳当场清空,靠下面垫着的快照)', async () => {
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

test('这一段不在就绪区间里:已经画着的留着、限时;本来没有画面的不画', async () => {
  const stream = streamOf(100, 189);
  stream.plane = { ...stream.plane, ranges: [[0, 1]] };
  const h = playerFor(stream);
  h.seek(170);
  await flush();
  assert.equal(h.track().lastDrawn, null);
  assert.deepEqual(stream.asked, [], '没就绪的分段不取');
  h.seek(110);
  await drawn(h, 110);
  h.seek(170);
  await flush();
  assert.equal(h.track().lastDrawn, 110, '留着上一张');
  await advance(HOLD_MS + 40);
  await flush();
  assert.equal(h.track().lastDrawn, null);
  h.player.stop();
});

/* ---------------------------------------------------------------- 连着跳 */

test('拖得快:不打断在途的那一次寻帧,它解到了先画上,再解此刻要的那一帧;中间经过的帧所在的分段不取', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  h.seek(104);
  await drawn(h, 104);
  const before = decoders[0].resets;
  stream.asked.length = 0;
  decoderGate.hold = true;
  h.seek(140);            // 第 2 段:在途
  await until(() => decoders[0].fed.some((c) => c.segment === 2), '在途的那一次已经喂进去了');
  h.seek(155);            // 第 3 段:经过,不解
  h.seek(125);            // 第 1 段:经过,不解
  h.seek(186);            // 第 5 段:此刻要的
  await flush(4);
  assert.equal(decoders[0].resets, before + 1, '连着四步只重置了一次解码器');
  assert.ok(h.track().deferred >= 3);
  assert.equal(h.track().lastDrawn, 104, '在途的还没解出来:留着上一张');
  decoderGate.hold = false;
  await until(() => h.track().lastDrawn === 140 || h.track().lastDrawn === 186, '在途的那一帧先画上');
  await drawn(h, 186);
  assert.deepEqual(h.last().mark, [5, 11, 1]);
  assert.equal(h.last().intact, true);
  assert.ok(!stream.asked.includes('1-s1.m4s') && !stream.asked.includes('3-s1.m4s'), `中间经过的分段没有取:${stream.asked}`);
  assert.ok(stream.asked.includes('2-s1.m4s') && stream.asked.includes('5-s1.m4s'));
  assert.ok(!decoders[0].fed.some((c) => c.segment === 3 || c.segment === 1), '中间经过的帧一块都没喂给解码器');
  h.player.stop();
});

test('在途的寻帧超过耐心时限还没解到:新的目标照样重置解码器', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  h.seek(104);
  await drawn(h, 104);
  decoderGate.hold = true;   // 解码器收了块、迟迟不出帧
  h.seek(140);
  await until(() => decoders[0].fed.some((c) => c.segment === 2), '在途的那一次已经喂进去了');
  const resets = decoders[0].resets;
  h.seek(186);
  await flush(4);
  assert.equal(decoders[0].resets, resets, '时限内不打断');
  now += SEEK_PATIENCE_MS + 1;
  h.seek(186);
  assert.equal(decoders[0].resets, resets + 1, '过了时限:照样重置,换成此刻要的那一帧');
  decoderGate.hold = false;
  await drawn(h, 186);
  h.player.stop();
});

test('在途的那一次连字节都还没到(一块都没喂给解码器):不让着它,直接换成此刻要的那一帧', async () => {
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

test('还没有画面时,在途寻帧解出来的旧帧过了时限不当第一张(宿主等第一张出来才藏活子树)', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  decoderGate.hold = true;
  h.seek(125);
  await until(() => decoders[0]?.fed.length > 0, '在途的那一次已经喂进去了');
  now += FIRST_PICTURE_LAG_MS + 5;
  h.seek(186);
  await flush(2);
  assert.ok(h.track().deferred >= 1, '在途的那一次没有被打断');
  decoderGate.hold = false;
  await drawn(h, 186);
  assert.ok(!h.dom.canvas.draws.some((d) => frameOfTimestamp(d.timestamp, FPS) === 125), '第 125 帧太旧,没有画');
  h.player.stop();
});

/* ---------------------------------------------------------------- 稀疏分段 */

test('稀疏分段每段只有一张重复的画面:贴的是不晚于这一帧的最近一张(这一段的第一帧),只解一个样本就画上;只往回找', async () => {
  const stream = streamOf(100, 189, { stride: SEGMENT_FRAMES });
  const h = playerFor(stream);
  for (const f of [137, 115, 189, 100, 129]) {
    decoders.forEach((d) => { d.fed.length = 0; });
    h.dom.canvas.draws.length = 0;
    h.seek(f);
    const seg = Math.floor((f - 100) / 15), first = 100 + seg * 15;
    await until(() => h.track().picture === first, `第 ${f} 帧画出第 ${first} 帧那一张`);
    const shot = h.dom.canvas.draws[0];
    assert.equal(frameOfTimestamp(shot.timestamp, FPS), first, `第 ${f} 帧:先画上的是第 ${first} 帧那个样本(不用解到第 ${f} 帧)`);
    assert.deepEqual(shot.mark, [seg, 0, SEGMENT_FRAMES]);
    assert.ok(h.track().picture <= f, '不拿后面的');
    assert.equal(h.track().level, 'sparse');
    assert.equal(h.track().stale, false, '这一张就是这一帧该有的画面,不算旧');
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

test('稀疏分段每 3 帧一张:第 F 帧贴第 floor((F−起点)/3)×3 张;在同一张里挪动不算缺画面', async () => {
  const stream = streamOf(100, 189, { stride: 3 });
  const h = playerFor(stream);
  h.seek(122);   // 第 1 段(115 起)的第 7 个样本 → 第 6 张(第 121 帧)
  await until(() => h.track().picture === 121, '画出第 121 帧那一张');
  assert.deepEqual(h.last().mark, [1, 6, 3]);
  await drawn(h, 122);
  h.seek(123);
  await flush();
  assert.equal(h.track().stale, false);
  assert.equal(h.track().picture, 121, '第 123 帧和第 121、122 帧是同一张');
  h.seek(124);
  await until(() => h.track().picture === 124, '第 124 帧是下一张');
  h.player.stop();
});

test('停在稀疏段上,这一段换成了满密度的文件:过了清单的刷新间隔自己换上这一帧的精确画面,不等用户操作', async () => {
  const stream = streamOf(100, 189, { stride: SEGMENT_FRAMES });
  const h = playerFor(stream);
  h.seek(110);                 // 先在别处停一下:刷新的定时器从这里就排上了
  await drawn(h, 110);
  await advance(MANIFEST_REFRESH_MS - 300);
  h.seek(137);
  await until(() => h.track().picture === 130, '稀疏:第 130 帧那一张');
  await drawn(h, 137);
  assert.deepEqual(h.last().mark, [2, 0, SEGMENT_FRAMES], '稀疏的那份文件:这一段只有第 0 张');
  stream.densify(2);
  // 刷新的定时器是早先(拖到别的帧时)排的、到点时播放头刚停下不久:它接着排,不能就此断了
  await advance(MANIFEST_REFRESH_MS + 100);
  await advance(MANIFEST_REFRESH_MS + 100);
  await until(() => h.last().mark[1] === 7 && h.last().mark[2] === 1, '满密度的那份文件:第 2 段的第 7 个样本');
  assert.equal(h.last().mark[0] === 2 && h.last().intact, true);
  assert.equal(h.track().level, 'dense');
  assert.equal(h.track().picture, 137);
  h.player.stop();
});

/* ---------------------------------------------------------------- 画布、流键 */

test('画布换了一块(包裹层按片段重挂载):把刚才那张原样画回去,不等解码,画面有无不变', async () => {
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
  assert.ok(fresh.draws.length >= 1, '同一个任务里就画上了');
  assert.ok(fresh.draws.every((d) => frameOfTimestamp(d.timestamp, FPS) === 150));
  assert.equal(h.track().lastDrawn, 150);
  await flush();
  assert.equal(calls, callsBefore, '一直有画面:不叫宿主');
  decoderGate.hold = false;
  h.player.stop();
  assert.equal(frames.open, 0);
});

test('同一块画布上换了流键(输入变了):旧画面当场清空,不留', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  h.seek(150);
  await drawn(h, 150);
  h.player.setPlanes([{ ...stream.plane, originFrame: 130 }], FPS);
  stream.hold('1-s1.m4s');
  h.seek(150);
  assert.equal(h.track().lastDrawn, null, '帧号对不上的旧画面不留');
  stream.release('1-s1.m4s');
  h.player.stop();
});

/* ---------------------------------------------------------------- 起播 */

test('暂停着把这一帧和后面几帧先解好:按下播放,头几拍当场就有,不用再等解码', async () => {
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  h.seek(143);
  await drawn(h, 143);
  await flush();
  const draws = h.dom.canvas.draws.length;
  decoderGate.hold = true;   // 起播以后解码器一帧都不出
  h.seek(144);
  assert.equal(h.track().lastDrawn, 144, '下一帧同步画上');
  assert.equal(h.dom.canvas.draws.length, draws + 1);
  h.seek(145);
  assert.equal(h.track().lastDrawn, 145);
  decoderGate.hold = false;
  h.player.stop();
});

/* ---------------------------------------------------------------- 全部流平面共用一个 WebGL 上下文 */

test('流平面共用一个 WebGL 上下文:建在离屏画布上,只建一次;平面换了一块画布也不另建', async () => {
  const before = sharedGl.contexts;
  const stream = streamOf(100, 189);
  const h = playerFor(stream);
  assert.equal(sharedGl.contexts, before, '还没画:不建上下文(back 角色的舞台从不画,也就从不建)');
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
  assert.equal(sharedGl.contexts, before + 1, '换了画布不另建上下文');
  assert.deepEqual({ state: h.player.diag().gl.state, creates: h.player.diag().gl.creates }, { state: 'ready', creates: 1 });
  h.player.stop();
  assert.equal(sharedGl.canvases.at(-1).width, 2, '退到 back:离屏画布缩回最小,上下文留着');
  assert.equal(frames.open, 0);
});

test('共用的上下文丢了:这一拍画不上、留着上一张;浏览器还回来就把这一帧画上;迟迟不还到时另建一块', async () => {
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
  await until(() => track()?.lastDrawn === 150, '画出第 150 帧');
  const gl = sharedGl.canvases.at(-1);
  const contexts = sharedGl.contexts;

  gl.lose();
  assert.equal(lost, 1, '告诉宿主一次(在线页面据此报「运行中出事了」)');
  const draws = dom.canvas.draws.length;
  seek(151);
  await flush();
  assert.equal(track().lastDrawn, 150, '第 151 帧解出来了也画不上:留着上一张');
  assert.equal(dom.canvas.draws.length, draws);
  assert.equal(player.diag().gl.state, 'lost');

  gl.restore();
  await until(() => track()?.lastDrawn === 151, '上下文还回来以后自己把这一帧画上(暂停着没有下一拍)');
  assert.equal(sharedGl.contexts, contexts, '还回来的是原来那个,不另建');
  assert.equal(player.diag().gl.restores, 1);

  // 再丢一次,这回浏览器不还(名额被别的画布挤掉):到 GL_RETRY_MS 另建一块,这一帧自己画上
  gl.lose();
  seek(152);
  await flush();
  assert.equal(track().lastDrawn, 151);
  await advance(GL_RETRY_MS + 60);
  await until(() => track()?.lastDrawn === 152, '另建上下文以后把这一帧画上');
  assert.equal(sharedGl.contexts, contexts + 1);
  assert.equal(player.diag().gl.creates, 2);
  player.stop();
  assert.equal(frames.open, 0);
});

test('上下文丢着的时候清单的矩形上界变了:画布的尺寸不动、上一张还在;画得上了才改尺寸', async () => {
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
  assert.equal(h.dom.canvas.width, 64, '画不了的时候不改画布的尺寸');
  assert.equal(h.dom.canvas.clears, clears, '也不清空');
  assert.equal(h.track().lastDrawn, 150, '账上记的和画布上的一致:还是上一张');
  gl.restore();
  await drawn(h, 151);
  assert.equal(h.dom.canvas.width, 128, '画上了,尺寸跟着新清单');
  h.player.stop();
  assert.equal(frames.open, 0);
});

test('共用的上下文建不出来:暂停着也会自己再试,间隔每次加倍;建出来以后把这一帧画上', async () => {
  const stream = streamOf(100, 189);
  const attempts = sharedGl.attempts;
  sharedGl.fail = 2;
  const h = playerFor(stream);
  h.seek(150);
  await until(() => sharedGl.attempts === attempts + 1, '头一次建上下文(没建出来)');
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
  assert.equal(sharedGl.attempts, attempts + 2, '间隔加倍了,还没到');
  await advance(GL_RETRY_MS + 60);
  await until(() => h.track()?.lastDrawn === 150, '第三次建出来,这一帧自己画上');
  assert.equal(sharedGl.attempts, attempts + 3);
  assert.deepEqual({ creates: h.player.diag().gl.creates, failures: h.player.diag().gl.failures }, { creates: 1, failures: 2 });
  // 停了以后不再排:没有流要画就不空转
  sharedGl.fail = 0;
  h.player.stop();
  const pending = timers.length;
  await advance(GL_RETRY_MAX_MS * 2);
  assert.ok(timers.length <= pending, '停了以后没有新排的定时器');
  assert.equal(frames.open, 0);
});
