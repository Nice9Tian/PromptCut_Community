/**
 * 「依赖下层的流」在播放器一侧(`streamPlayer.ts`)的单测:这种流只有目标卡一张,但按舞台坐标产,画布挂在舞台根下
 * (`Stage` 的 `[data-pc-group-plane]`),不在包裹层里(契约 `prerender-products-contract.md` 第 5.4 节)。
 * 跑:npm test -- src/render/streamBelowPlane.test.mjs
 *
 * 钉住:
 *   - 父页发来的平面带 `plane: "stage"` 时,播放器到舞台根下找画布、按清单的矩形(舞台坐标)摆,包裹层里的那块不碰;
 *   - 任意一帧都画得出来(片段不从 15 的倍数帧开始),和单卡流同一套取帧;
 *   - 清单说的坐标系和画布对不上时不画:清单是 `stage` 而平面没带标记(会被画进包裹层),或者反过来;
 *   - 实体框(`boxOf`)不回舞台坐标的框;`streamPlanesFor` 把那一层的 `plane` 原样带到流平面上。
 *
 * 分段是真的(`streamMux.ts` 封的 fMP4);解码器和 WebGL 是假的(只记下画了哪一帧)。真的画面由探针
 * `scripts/probes/stream-below-stage-probe.mjs` 用像素核对。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer, frameOfTimestamp, SEGMENT_FRAMES, stagePlane, streamPlanesFor, planesWithinBudget } from './streamPlayer.ts';
import { buildStreamInit, buildStreamSegment } from './streamMux.ts';
import { streamSegmentFrameCount, streamSegmentSpan } from './streamSegments.mjs';

const FPS = 30;
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x03, 0x68, 0xee, 0x3c]);
const INIT_ID = 'i'.repeat(16);

/* 假的解码器:一个宏任务出一帧,带着喂进来的那一块的标记 */
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
 * 全部流平面共用一个 WebGL 上下文,建在一块离屏画布上(`streamPlayer.ts` 的 `SharedGl`):假的只记下最近上传的是哪一帧;
 * 平面自己是 2D 画布,`drawImage` 取走时把那一帧记成它画的。
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
  assert.fail(`等不到:${label}`);
}

/** 目标卡 `g` 的流,盖住项目帧 `firstFrame .. lastFrame`。`plane` / `kind` 是清单里写的 */
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
  // 舞台坐标:上界是整个画面,收紧矩形是目标卡改动过的那一块(不在原点)
  const tight = { x: 400, y: 200, w: 64, h: 64 };
  const manifest = { streamKey: 'K', kind, plane, clipIds: ['g'], fps: FPS, segmentFrames: SEGMENT_FRAMES, originFrame,
    bound: { x: 0, y: 0, w: 1920, h: 1080 }, tight,
    inits: { [INIT_ID]: { codec: 'avc1.64001f', width: 64, height: 144, rect: tight } }, segments };
  const copy = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  return { originFrame, lastSegment, manifest,
    source: { manifest: async () => manifest, init: async () => copy(init), segment: async (_k, file) => copy(files.get(file)) },
    request: (extra = {}) => ({ clipIds: ['g'], key: 'K', ranges: [[0, lastSegment]], originFrame, ...extra }) };
}

/** 舞台上两块画布都在:包裹层里的那块(单卡流用)和舞台根下的那块(组流、依赖下层的流用) */
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

test('带 plane: stage 的平面画在舞台根下的画布上、按清单的舞台坐标摆;包裹层里的那块不碰;任意一帧都是它自己', async () => {
  const stream = streamOf(55, 99);                  // 第 55 帧起 45 帧:分段是 55～69、70～84、85～99
  assert.deepEqual([stream.originFrame, stream.lastSegment], [55, 2]);
  const h = stageWith(stream, stream.request({ plane: 'stage' }));
  for (const f of [77, 55, 69, 70, 99, 84, 61]) {
    h.player.present(f / FPS);
    await until(() => h.track()?.lastDrawn === f, `画出第 ${f} 帧`);
    const shot = h.staged.draws.at(-1);
    assert.deepEqual(shot.mark, [Math.floor((f - 55) / 15), (f - 55) % 15], `第 ${f} 帧`);
    assert.equal(frameOfTimestamp(shot.timestamp, FPS), f);
  }
  assert.equal(h.local.draws.length, 0, '包裹层里的画布一帧都没画');
  assert.ok(h.asked.some((sel) => sel.includes('data-pc-group-plane')), '到舞台根下找画布');
  assert.equal(h.asked.some((sel) => sel.includes('data-pc-stream-plane')), false, '不去找包裹层里的那块');
  // 画布按清单的上界摆(舞台坐标,整个画面),不是包裹层的框
  assert.deepEqual([h.staged.width, h.staged.height], [1920, 1080]);
  assert.deepEqual(h.staged.style.props, { left: '0px', top: '0px', width: '1920px', height: '1080px' });
  assert.deepEqual([...h.player.showingClips()], ['g']);
  assert.equal(h.player.boxOf('g'), null, '实体框在舞台坐标里,不当包裹层坐标回');
  const d = h.track();
  assert.deepEqual([d.plane, d.kind, d.fits], ['stage', 'below', true]);
  // 早于这条流第一帧的帧没有流
  h.player.present(54 / FPS);
  await flush();
  assert.notEqual(h.track().lastDrawn, 54);
  h.player.stop();
});

test('清单是 stage、平面没带标记(会被当成单卡流画进包裹层):一帧都不画,这一拍没有流画面', async () => {
  const stream = streamOf(55, 99);
  const h = stageWith(stream, stream.request());
  h.player.present(77 / FPS);
  await flush(40);
  assert.equal(h.local.draws.length, 0);
  assert.equal(h.staged.draws.length, 0);
  assert.equal(h.track().lastDrawn, null);
  assert.equal(h.track().fits, false);
  assert.deepEqual([...h.player.showingClips()], [], '舞台据此落到占位符');
  h.player.stop();
});

test('反过来:清单是 local(单卡流)、平面带了 stage 标记:同样不画', async () => {
  const stream = streamOf(55, 99, { plane: 'local', kind: 'card' });
  const h = stageWith(stream, stream.request({ plane: 'stage' }));
  h.player.present(77 / FPS);
  await flush(40);
  assert.equal(h.local.draws.length + h.staged.draws.length, 0);
  assert.equal(h.track().fits, false);
  // 不带标记:照单卡流画在包裹层里
  const ok = stageWith(stream, stream.request());
  ok.player.present(77 / FPS);
  await until(() => ok.track()?.lastDrawn === 77, '单卡流画出第 77 帧');
  assert.equal(ok.staged.draws.length, 0);
  assert.ok(ok.local.draws.length > 0);
  assert.deepEqual([ok.track().plane, ok.track().kind, ok.track().fits], ['local', 'card', true]);
  h.player.stop(); ok.player.stop();
});

test('同一张卡的流从单卡流换成依赖下层的流(同一个键不会,但平面种类变了就是另一条):旧的关掉、新的在舞台根下重建', async () => {
  const stream = streamOf(55, 99);
  const h = stageWith(stream, stream.request());
  h.player.present(77 / FPS);
  await flush(20);
  const before = h.track().id;
  h.player.setPlanes([stream.request({ plane: 'stage' })], FPS);
  h.player.present(77 / FPS);
  await until(() => h.track()?.lastDrawn === 77, '换成舞台平面以后画出第 77 帧');
  assert.notEqual(h.track().id, before);
  assert.equal(h.player.diag().tracks.length, 1);
  assert.ok(h.staged.draws.length > 0);
  assert.equal(h.local.draws.length, 0);
  h.player.stop();
});

test('stagePlane / streamPlanesFor / planesWithinBudget:组流和带标记的单张算舞台平面;那一层的 plane 原样带到流平面上,占一个预算位', () => {
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
  ], '组流本来就是舞台坐标,不另带标记');
  assert.equal(planesWithinBudget(planes).length, 3);
  // 第 100 帧:依赖下层的那条(第 55～99 帧)已经结束
  assert.deepEqual(streamPlanesFor(layers, new Set(['g', 'c']), 100).map((p) => p.clipIds[0]), ['c']);
});
