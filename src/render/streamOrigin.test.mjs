/**
 * 轨道流的分段从这条流自己的第一帧起数(`streamSegments.mjs`)在播放器一侧(`streamPlayer.ts`)的单测:
 * 片段不从 15 的倍数帧开始、时长不是 15 的倍数时,**逐帧核对**「项目的第 F 帧取的是哪个分段的第几个样本」。
 * 跑:npm test -- src/render/streamOrigin.test.mjs
 *
 * 分段是真的(`streamMux.ts` 封的 fMP4),每个样本的字节里写着「第几段、第几个样本」;解码器是假的,只记下喂给它的每一块
 * (时间戳、是不是关键帧、字节)并立刻吐一帧。合成要 WebGL,这里没有,所以只核到「喂进去的是哪一个样本、记在哪个项目帧号上」——
 * 画到画布上的那一步由浏览器里的探针(`scripts/probes/stream-origin-probe.mjs`)用像素核对。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer, chunkTimestamp, frameOfTimestamp, SEGMENT_FRAMES } from './streamPlayer.ts';
import { buildStreamInit, buildStreamSegment } from './streamMux.ts';
import { streamSegmentFrameCount, streamSegmentSpan } from './streamSegments.mjs';

const FPS = 30;
const AVCC = Uint8Array.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x03, 0x68, 0xee, 0x3c]);
const INIT_ID = 'i'.repeat(16);

/** 假的解码器:喂进来的每一块都记下,下一个微任务吐一帧(时间戳原样带回) */
const decoders = [];
class FakeDecoder {
  constructor(init) { this.init = init; this.state = 'unconfigured'; this.fed = []; this.resets = 0; decoders.push(this); }
  configure(config) { this.config = config; this.state = 'configured'; }
  decode(chunk) {
    this.fed.push(chunk);
    queueMicrotask(() => { if (this.state !== 'closed') this.init.output({ timestamp: chunk.timestamp, close() {} }); });
  }
  reset() { this.resets++; this.state = 'unconfigured'; }
  close() { this.state = 'closed'; }
  get decodeQueueSize() { return 0; }
}
globalThis.VideoDecoder = FakeDecoder;
globalThis.EncodedVideoChunk = class { constructor(o) { this.type = o.type; this.timestamp = o.timestamp; this.duration = o.duration; this.data = Uint8Array.from(o.data); } };
globalThis.CSS = { escape: (s) => s };

const fakeCanvas = () => ({ getContext: () => null, style: { getPropertyValue: () => '', setProperty() {} }, width: 0, height: 0, parentElement: null });
const fakeRoot = (canvases) => ({ querySelector(sel) { const m = /^\[data-pc-clip="(.+?)"\] > canvas\[data-pc-stream-plane\]$/.exec(sel); return m ? canvases[m[1]] ?? null : null; } });
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/**
 * 一条盖住项目帧 `firstFrame .. lastFrame` 的流:清单 + 字节源。每个样本 4 个字节 `[0xAB, 分段号, 样本序号, 0xCD]`。
 * `asked` 记下向字节源要过哪些分段文件。
 */
function streamOf(firstFrame, lastFrame) {
  const { originFrame, lastSegment } = streamSegmentSpan(firstFrame, lastFrame);
  const init = buildStreamInit({ width: 64, height: 144, fps: FPS, avcC: AVCC });
  const files = new Map();
  const segments = {};
  for (let n = 0; n <= lastSegment; n++) {
    const count = streamSegmentFrameCount(n, originFrame, lastFrame);
    const samples = Array.from({ length: count }, (_, i) => ({ data: Uint8Array.from([0xab, n, i, 0xcd]), isSync: i === 0 }));
    const file = `${n}-seg.m4s`;
    files.set(file, buildStreamSegment({ sequence: n + 1, baseDecodeTime: n * SEGMENT_FRAMES, samples }));
    segments[n] = { init: INIT_ID, file, stride: 1, samples: count };
  }
  const manifest = { streamKey: 'K', kind: 'card', plane: 'local', clipIds: ['a'], fps: FPS, segmentFrames: SEGMENT_FRAMES, originFrame,
    bound: { x: 0, y: 0, w: 64, h: 64 }, tight: null, inits: { [INIT_ID]: { codec: 'avc1.64001f', width: 64, height: 144, rect: { x: 0, y: 0, w: 64, h: 64 } } }, segments };
  const asked = [];
  const copy = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const source = {
    manifest: async () => manifest,
    init: async () => copy(init),
    segment: async (_key, file) => { asked.push(file); return copy(files.get(file)); },
  };
  return { originFrame, lastSegment, manifest, source, asked, plane: { clipIds: ['a'], key: 'K', ranges: [[0, lastSegment]], originFrame } };
}

function playerFor(stream, plane = stream.plane) {
  const player = new StreamPlayer({ root: () => fakeRoot({ a: fakeCanvas() }), source: stream.source });
  player.setPlanes([plane], FPS);
  return player;
}
/** 喂给解码器的每一块 → `[项目帧号, 分段号, 样本序号, 是不是关键帧]` */
const fedOf = (decoder) => decoder.fed.map((c) => [frameOfTimestamp(c.timestamp, FPS), c.data[1], c.data[2], c.type === 'key']);

beforeEach(() => { decoders.length = 0; });

test('随机访问逐帧核对:片段从第 100 帧开始、共 50 帧 —— 项目的第 F 帧取的是第 floor((F−100)/15) 段的第 (F−100)%15 个样本', async () => {
  const stream = streamOf(100, 149);
  assert.deepEqual([stream.originFrame, stream.lastSegment], [100, 3], '第 100～149 帧:分段 0～3,末段 5 帧');
  for (let f = 100; f <= 149; f++) {
    decoders.length = 0;
    stream.asked.length = 0;
    const player = playerFor(stream);
    player.present(f / FPS);
    await flush();
    const seg = Math.floor((f - 100) / 15), index = (f - 100) % 15;
    assert.equal(stream.asked[0], `${seg}-seg.m4s`, `第 ${f} 帧先要第 ${seg} 段`);
    assert.equal(decoders.length, 1);
    const fed = fedOf(decoders[0]);
    // 从这一段的关键帧起一路解到目标帧:每一块的时间戳都是它自己的项目帧号,字节是这一段里对应序号的那个样本
    const upTo = fed.filter(([frame]) => frame <= f);
    assert.deepEqual(upTo, Array.from({ length: index + 1 }, (_, i) => [100 + seg * 15 + i, seg, i, i === 0]), `第 ${f} 帧`);
    // 目标帧解出来以后记在它自己的项目帧号上,分段号是这条流自己的
    const track = [...player.tracks.values()][0];
    assert.equal(track.frames.get(f)?.segment, seg, `第 ${f} 帧记在第 ${seg} 段`);
    assert.ok([...track.frames.keys()].every((k) => k >= f), '目标之前的帧一出来就关');
    player.stop();
  }
});

test('顺序播放逐帧核对:从第 100 帧播到第 149 帧,每一帧恰好喂一次,帧号、分段、样本序号一一对上;末段只有 5 个样本,不越界', async () => {
  const stream = streamOf(100, 149);
  const player = playerFor(stream);
  for (let f = 100; f <= 149; f++) { player.present(f / FPS); await flush(2); }
  await flush();
  const fed = decoders.flatMap(fedOf);
  assert.deepEqual(fed, Array.from({ length: 50 }, (_, k) => [100 + k, Math.floor(k / 15), k % 15, k % 15 === 0]));
  assert.deepEqual(stream.asked, ['0-seg.m4s', '1-seg.m4s', '2-seg.m4s', '3-seg.m4s']);
  assert.equal(decoders.reduce((n, d) => n + d.resets, 0), 0, '顺着播不跳段:不重置解码器');
  player.stop();
});

test('早于这条流第一帧的帧没有分段:不取字节、不建解码器、这一拍没有流画面;按项目帧号数的分段(原来的做法)不会被取到', async () => {
  const stream = streamOf(100, 149);
  for (const f of [0, 14, 85, 99]) {
    const player = playerFor(stream);
    player.present(f / FPS);
    await flush();
    assert.deepEqual(stream.asked, [], `第 ${f} 帧`);
    assert.equal(decoders.length, 0);
    assert.deepEqual([...player.showingClips()], []);
    player.stop();
  }
  // 第 105 帧:原来是 floor(105 / 15) = 第 7 段(这条流没有第 7 段);现在是第 0 段的第 5 个样本
  const player = playerFor(stream);
  player.present(105 / FPS);
  await flush();
  assert.deepEqual(stream.asked, ['0-seg.m4s']);
  assert.deepEqual(fedOf(decoders[0]).filter(([frame]) => frame <= 105).at(-1), [105, 0, 5, false]);
  player.stop();
});

test('第一帧是 0 的流和原来按项目帧号分段是同一回事', async () => {
  const stream = streamOf(0, 44);
  for (const f of [0, 1, 14, 15, 29, 30, 44]) {
    decoders.length = 0;
    stream.asked.length = 0;
    const player = playerFor(stream);
    player.present(f / FPS);
    await flush();
    assert.equal(stream.asked[0], `${Math.floor(f / 15)}-seg.m4s`);
    assert.deepEqual(fedOf(decoders[0]).filter(([frame]) => frame <= f).at(-1), [f, Math.floor(f / 15), f % 15, f % 15 === 0]);
    player.stop();
  }
});

test('没带第一帧的流平面播放器不收(没法把帧号换成分段号);同一条流换了第一帧(被摆到别的帧上)就从头来', async () => {
  const stream = streamOf(100, 149);
  const { originFrame: _dropped, ...noOrigin } = stream.plane;
  const none = playerFor(stream, noOrigin);
  assert.equal(none.diag().planes, 0);
  none.present(105 / FPS);
  await flush();
  assert.equal(decoders.length, 0);
  assert.deepEqual(stream.asked, []);
  none.stop();

  // 同一个流键、同一份字节,第一帧从 100 换成 200(给「片段挪动以后流不失效」留的口子:读的一侧只认流平面带来的第一帧)
  const player = playerFor(stream);
  player.present(105 / FPS);
  await flush();
  assert.deepEqual(fedOf(decoders[0]).filter(([frame]) => frame <= 105).at(-1), [105, 0, 5, false]);
  const track = [...player.tracks.values()][0];
  player.setPlanes([{ ...stream.plane, originFrame: 200 }], FPS);
  player.present(205 / FPS);
  await flush();
  assert.equal([...player.tracks.values()][0], track, '还是同一条轨道');
  assert.ok(![...track.frames.keys()].some((k) => k < 200), '按旧位置记的帧都放掉了');
  const fed = decoders.flatMap(fedOf).filter(([frame]) => frame >= 200 && frame <= 205);
  assert.deepEqual(fed, Array.from({ length: 6 }, (_, i) => [200 + i, 0, i, i === 0]), '第 205 帧现在是第 0 段的第 5 个样本,时间戳按新位置给');
  assert.equal(chunkTimestamp(205, FPS), Math.round(205 * 1e6 / FPS));
  player.stop();
});
