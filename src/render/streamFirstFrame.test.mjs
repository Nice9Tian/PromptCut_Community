/**
 * 最低一档贴轨道流:每个分段只解第一帧(`streamPlayer.ts` 的 `presentFirst`;用户 2026-10-13 定「性能不足时只贴稀疏版、同时活着的解码器给得少」,
 * 2026-10-22 起归最低一档)。
 * 跑:npm test -- src/render/streamFirstFrame.test.mjs
 *
 * 真解码要浏览器,端到端在 `scripts/probes/page-stream-probe.mjs --only lowest`。这里解码器、画布、时钟是假的,分段是真的
 * (`streamMux.ts` 封的 fMP4),钉住:
 *
 *   - 帧号换算只有一处(`streamSegments.mjs` 的 `streamFirstFrameOf`),片段不从 15 的倍数帧开始也对;
 *   - 带 `first` 的流平面:满密度的分段也只喂第一个样本(关键帧)那一块,这一段的每一帧贴的都是它;稀疏的分段同样;
 *   - 播放、往回跳、跨分段跳都是「一个分段解一块」,不重置解码器;同一个解码器同时只有一块在解;
 *   - 解码帧:稳态每条流只留画布上那一张,换分段的那一下两张;停下全部关掉;
 *   - 这一段的字节没到:留着上一张,最多一个分段的时长,到时清空;
 *   - 浏览器没有 `VideoDecoder`、解码器连着报错:不贴(不再试),不抛错;
 *   - 最低一档的预算(`streamBudget.mjs` 的 `sparseStreamBudget`):条数、画幅之和、头一条不看像素;
 *   - 父页给舞台发流平面时 `first` 原样带到(`StreamPlaneSender`)。
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

/* ---------------------------------------------------------------- 假的时钟、解码器、画布(同 `streamScrub.test.mjs` 的那一套,另加 `flush` 和报错) */

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
/** `hold`:输出先压着;`failNext`:接下来这么多次 `decode` 之后解码器报错关掉(模拟这台设备解不了这条流) */
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
  assert.fail(`等不到:${label}`);
}

/* ---------------------------------------------------------------- 一条流:每个样本 4 字节 [0xAB, 分段号, 第几张画面, 文件版本] */

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

/* ---------------------------------------------------------------- 帧号换算 */

test('分段第一帧的换算:从流自己的第一帧起每 15 帧一段,片段不从 15 的倍数帧开始也对', () => {
  assert.equal(streamFirstFrameOf(12, 12), 12);
  assert.equal(streamFirstFrameOf(26, 12), 12);
  assert.equal(streamFirstFrameOf(27, 12), 27);
  assert.equal(streamFirstFrameOf(41, 12), 27);
  assert.equal(streamFirstFrameOf(42, 12), 42);
  assert.equal(streamFirstFrameOf(0, 0), 0);
  assert.equal(streamFirstFrameOf(SEGMENT_FRAMES * 3 + 5, 0), SEGMENT_FRAMES * 3);
  // 早于流的第一帧:回的也早于第一帧(那一段不在就绪区间里,不会真的去解)
  assert.ok(streamFirstFrameOf(5, 12) < 12);
});

/* ---------------------------------------------------------------- 只解分段第一帧 */

test('满密度的流带 first:停在段中间的一帧,只喂那一段的关键帧一块,画的是分段第一帧那一张', async () => {
  const s = streamOf(12, 12 + 59);   // 第一帧是第 12 帧,4 个分段,每段 15 个样本(满密度)
  const p = playerFor(s);
  p.seek(12 + 15 + 7);               // 第 1 段的第 7 个样本
  await until(() => p.last(), '画出来');
  assert.deepEqual(p.last().mark, [1, 0, 1], '画的是第 1 段的第 0 个样本');
  assert.equal(decoders.length, 1);
  assert.deepEqual(decoders[0].fed, [{ frame: 27, segment: 1, sample: 0, key: true }], '只喂了一块:第 1 段的关键帧(项目的第 27 帧)');
  assert.equal(decoders[0].flushes, 1, '喂完叫解码器把这一块吐出来');
  assert.deepEqual(s.asked, ['1-s1.m4s'], '只取了这一段,没有往后预取');
  const t = p.track();
  assert.equal(t.first, true);
  assert.equal(t.lastDrawn, 27);
  assert.equal(t.picture, 27);
  assert.equal(t.level, 'sparse', '照稀疏版的样子贴');
  assert.equal(t.held, 0, '画上以后解码输出当场关掉');
  assert.equal(frames.open, 1, '只留画布上那一张的引用');
  assert.equal(p.player.heldBytes(), 64 * 144 * 1.5, '解码帧内存 = 一帧');
});

test('播放一遍:每个分段解一块,每一帧贴的都是所在分段的第一帧;解码帧稳态 1 张、瞬时不超过 2 张', async () => {
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
        assert.ok(t.lastDrawn <= f, '只往回找,不拿后面的');
        // 解码是异步的:换分段的头一两拍可以还留着上一段的那一张
        assert.ok(f - t.lastDrawn < 2 * SEGMENT_FRAMES);
      }
      assert.ok(t.maxHeld <= 2, `单条流占着的解码帧不超过 2(第 ${f} 帧时 ${t.maxHeld})`);
    }
    assert.equal(p.track().lastDrawn, streamFirstFrameOf(12 + 59, 12), '最后停在最后一段的第一帧那一张上');
    assert.deepEqual(decoders[0].fed.map((x) => [x.segment, x.sample, x.key]), [[0, 0, true], [1, 0, true], [2, 0, true], [3, 0, true]], `stride ${stride}:四个分段各喂一块关键帧`);
    assert.equal(decoders.length, 1, '一条流一个解码器');
    assert.equal(decoders[0].resets, 0, '跨分段不重置解码器');
    assert.equal(decoders[0].maxQueued, 1, '同时只有一块在解');
    assert.equal(p.dom.canvas.draws.length, 4, '画布只在换分段时重画');
    assert.equal(frames.open, 1);
    assert.ok(frames.maxOpen <= 3, `开着的帧句柄瞬时不超过 3(新一张、它的引用、上一张的引用),实际 ${frames.maxOpen}`);
    p.player.stop();
    assert.equal(frames.open, 0, '停下全部关掉');
  }
});

test('暂停着往回跳、跨分段跳:各解一块关键帧;同一段里挪动不再解', async () => {
  const s = streamOf(100, 100 + 89);   // 6 个分段
  const p = playerFor(s);
  p.seek(100 + 70);   // 第 4 段
  await until(() => p.track().lastDrawn === 160, '第 4 段');
  p.seek(100 + 20);   // 往回到第 1 段
  await until(() => p.track().lastDrawn === 115, '第 1 段');
  p.seek(100 + 22);   // 同一段
  p.seek(100 + 29);
  await flush();
  assert.equal(p.track().lastDrawn, 115);
  p.seek(100 + 89);   // 最后一段
  await until(() => p.track().lastDrawn === 175, '第 5 段');
  assert.deepEqual(decoders[0].fed.map((x) => x.frame), [160, 115, 175]);
  assert.equal(decoders[0].resets, 0);
  assert.deepEqual(p.last().mark, [5, 0, 1]);
});

test('连着拖:在途的那一块出来时已经不是此刻要的,不画它,按此刻要的再解一块', async () => {
  const s = streamOf(0, 89);
  const p = playerFor(s);
  p.seek(5);
  await until(() => p.track().lastDrawn === 0, '第 0 段');
  decoderGate.hold = true;
  p.seek(20);            // 第 1 段送去解,压着
  await flush();
  p.seek(50);            // 又拖到第 3 段:第 1 段那一块还在解,不再送
  await flush();
  assert.deepEqual(decoders[0].fed.map((x) => x.frame), [0, 15], '同一个解码器同时只解一块');
  decoderGate.hold = false;
  await until(() => p.track().lastDrawn === 45, '第 3 段');
  assert.deepEqual(decoders[0].fed.map((x) => x.frame), [0, 15, 45]);
  assert.deepEqual(p.dom.canvas.draws.map((d) => d.mark[0]), [0, 3], '第 1 段那一张没有画上去(画面不往回跳)');
  assert.equal(frames.open, 1);
});

test('这一段的字节没到:留着上一张,最多一个分段的时长,到时清空并告诉宿主', async () => {
  const s = streamOf(0, 59);
  let changes = 0;
  const p = playerFor(s, { onShowingChange: () => { changes++; } });
  p.seek(3);
  await until(() => p.track().lastDrawn === 0, '第 0 段');
  await flush();
  const before = changes;
  s.hold('1-s1.m4s');
  p.seek(17);
  await flush();
  assert.equal(p.track().lastDrawn, 0, '留着上一张');
  assert.equal(p.track().stale, true);
  await advance(HOLD_MS + 60);
  await flush();
  assert.equal(p.track().lastDrawn, null, '到时清空');
  assert.equal(p.player.showingClips().size, 0);
  assert.ok(changes > before, '画面没了要告诉宿主(占位符靠它)');
  s.release('1-s1.m4s');
  await until(() => p.track().lastDrawn === 15, '字节到了自己画上');
});

test('送去解的那一块一直不出来:过了时限重置解码器再送', async () => {
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
  assert.equal(decoders[0].fed.length, 2, '重置以后又送了一次');
  decoderGate.hold = false;
  await until(() => p.track().lastDrawn === 0, '画出来');
});

/* ---------------------------------------------------------------- 解不了的退路 */

test('浏览器没有 VideoDecoder:不贴、不抛错、不再试', async () => {
  globalThis.VideoDecoder = undefined;
  const s = streamOf(0, 29);
  const p = playerFor(s);
  for (let i = 0; i < 5; i++) { p.seek(2 + i); await flush(); }
  assert.equal(p.track().lastDrawn, null);
  assert.equal(p.player.showingClips().size, 0, '这一层没有流画面,宿主照没有流办(小尺寸 / 占位符)');
  assert.equal(p.track().firstFailures, FIRST_FRAME_MAX_FAILURES);
  assert.equal(decoders.length, 0);
});

test('解码器连着报错(这台设备解不了这条流):试到上限就不再建解码器', async () => {
  decoderGate.failNext = 99;
  const s = streamOf(0, 59);
  const p = playerFor(s);
  for (let f = 0; f < 40; f++) { p.seek(f); await flush(4); }
  assert.equal(decoders.length, FIRST_FRAME_MAX_FAILURES, `只建过 ${FIRST_FRAME_MAX_FAILURES} 个解码器`);
  assert.equal(p.track().lastDrawn, null);
  assert.equal(p.track().firstFailures, FIRST_FRAME_MAX_FAILURES);
  assert.equal(frames.open, 0);
});

test('报错一次以后解出来了:失败次数清零,照常贴', async () => {
  decoderGate.failNext = 1;
  const s = streamOf(0, 59);
  const p = playerFor(s);
  p.seek(1);
  await until(() => p.track().lastDrawn === 0, '第二次解出来');
  assert.equal(decoders.length, 2);
  assert.equal(p.track().firstFailures, 0);
});

test('不带 first 的流平面照旧逐帧解(别的档不受影响)', async () => {
  const s = streamOf(0, 44, { first: false });
  const p = playerFor(s);
  p.seek(7);
  await until(() => p.track().lastDrawn === 7, '第 7 帧');
  assert.deepEqual(p.last().mark, [0, 7, 1]);
  assert.equal(p.track().first, false);
  assert.ok(decoders[0].fed.length > 8, '从关键帧一路解到目标帧,还往后多解');
  assert.equal(decoders[0].flushes, 0);
  p.player.stop();
});

/* ---------------------------------------------------------------- 预算 */

test('最低一档的预算:解码器不超过 4 个;画幅之和不超过两张 1080p 满屏卡;头一条不看像素', () => {
  const budget = sparseStreamBudget();
  assert.deepEqual(budget, { count: SPARSE_STREAM_COUNT, pixelRate: SPARSE_STREAM_PIXELS * STREAM_BUDGET_MIN_FPS, free: SPARSE_STREAM_FREE });
  assert.equal(SPARSE_STREAM_COUNT, 4);
  assert.ok(SPARSE_STREAM_COUNT < STREAM_COUNT_BUDGET);
  const plane = (id) => ({ clipIds: [id], key: `k-${id}`, originFrame: 0 });
  const pass = (list, px) => planesWithinBudget(list, STREAM_BUDGET_MIN_FPS, (p) => px[p.clipIds[0]], budget).map((p) => p.clipIds[0]);
  const small = streamCodedPixels(704, 864);
  const full = STREAM_DEFAULT_PIXELS;
  // 六张小卡:条数上限 4
  assert.deepEqual(pass(['a', 'b', 'c', 'd', 'e', 'f'].map(plane), { a: small, b: small, c: small, d: small, e: small, f: small }), ['a', 'b', 'c', 'd']);
  // 三张满屏卡:放两张
  assert.deepEqual(pass(['a', 'b', 'c'].map(plane), { a: full, b: full, c: full }), ['a', 'b']);
  // 两张满屏卡之后小卡也放不下(画幅之和已满)
  assert.deepEqual(pass(['a', 'b', 'c'].map(plane), { a: full, b: full, c: small }), ['a', 'b']);
  // 满屏卡放不下时跳过它,后面的小卡照放
  assert.deepEqual(pass(['a', 'b', 'c', 'd'].map(plane), { a: full, b: small, c: full, d: small }), ['a', 'b', 'd']);
  // 4K 的满屏卡:头一条不看像素,照放;之后一条都加不进
  const uhd = streamCodedPixels(3840, 2160);
  assert.deepEqual(pass(['a', 'b'].map(plane), { a: uhd, b: small }), ['a']);
  // 项目帧率不进这一档的开销:60 帧的项目放的和 30 帧一样多(调用方传的是 STREAM_BUDGET_MIN_FPS)
  assert.deepEqual(planesWithinBudget(['a', 'b', 'c'].map(plane), STREAM_BUDGET_MIN_FPS, () => full, budget).length, 2);
  // 不给预算就是别的档的那一组数(6 条以内不看像素)
  assert.equal(planesWithinBudget(['a', 'b', 'c', 'd', 'e', 'f'].map(plane), 60, () => full).length, 6);
});

test('父页给舞台发流平面:first 原样带到;超出预算的平面不带字节', () => {
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
