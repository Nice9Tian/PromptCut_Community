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

test('frame-by-frame random access check: the clip starts at frame 100 and has 50 frames; project frame F takes sample (F−100)%15 of segment floor((F−100)/15)', async () => {
  const stream = streamOf(100, 149);
  assert.deepEqual([stream.originFrame, stream.lastSegment], [100, 3], 'frames 100~149: segments 0~3, last segment has 5 frames');
  for (let f = 100; f <= 149; f++) {
    decoders.length = 0;
    stream.asked.length = 0;
    const player = playerFor(stream);
    player.present(f / FPS);
    await flush();
    const seg = Math.floor((f - 100) / 15), index = (f - 100) % 15;
    assert.equal(stream.asked[0], `${seg}-seg.m4s`, `frame ${f} requests segment ${seg} first`);
    assert.equal(decoders.length, 1);
    const fed = fedOf(decoders[0]);
    // 从这一段的关键帧起一路解到目标帧:每一块的时间戳都是它自己的项目帧号,字节是这一段里对应序号的那个样本
    const upTo = fed.filter(([frame]) => frame <= f);
    assert.deepEqual(upTo, Array.from({ length: index + 1 }, (_, i) => [100 + seg * 15 + i, seg, i, i === 0]), `Frame ${f}`);
    // 目标帧解出来以后记在它自己的项目帧号上,分段号是这条流自己的
    const track = [...player.tracks.values()][0];
    assert.equal(track.frames.get(f)?.segment, seg, `frame ${f} is recorded under segment ${seg}`);
    assert.ok([...track.frames.keys()].every((k) => k >= f), 'frames before the target are closed as soon as they come out');
    player.stop();
  }
});

test('sequential playback frame-by-frame check: playing from frame 100 to frame 149, each frame is fed exactly once, and frame number, segment and sample index match one to one; the last segment has only 5 samples and does not go out of bounds', async () => {
  const stream = streamOf(100, 149);
  const player = playerFor(stream);
  for (let f = 100; f <= 149; f++) { player.present(f / FPS); await flush(2); }
  await flush();
  const fed = decoders.flatMap(fedOf);
  assert.deepEqual(fed, Array.from({ length: 50 }, (_, k) => [100 + k, Math.floor(k / 15), k % 15, k % 15 === 0]));
  assert.deepEqual(stream.asked, ['0-seg.m4s', '1-seg.m4s', '2-seg.m4s', '3-seg.m4s']);
  assert.equal(decoders.reduce((n, d) => n + d.resets, 0), 0, 'playing forward does not skip segments: the decoder is not reset');
  player.stop();
});

test('frames earlier than the first frame of this stream have no segment: no bytes fetched, no decoder created, no stream picture on this tick; segments numbered by project frame number (the old behavior) would not be fetched', async () => {
  const stream = streamOf(100, 149);
  for (const f of [0, 14, 85, 99]) {
    const player = playerFor(stream);
    player.present(f / FPS);
    await flush();
    assert.deepEqual(stream.asked, [], `Frame ${f}`);
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

test('a stream whose first frame is 0 is the same as the old segmenting by project frame number', async () => {
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

test('the stream plane player does not accept a stream without a first frame (frame numbers cannot be converted to segment numbers); when the same stream changes its first frame (moved to another frame) it starts over', async () => {
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
  assert.equal([...player.tracks.values()][0], track, 'still the same track');
  assert.ok(![...track.frames.keys()].some((k) => k < 200), 'frames recorded at the old position were all released');
  const fed = decoders.flatMap(fedOf).filter(([frame]) => frame >= 200 && frame <= 205);
  assert.deepEqual(fed, Array.from({ length: 6 }, (_, i) => [200 + i, 0, i, i === 0]), 'frame 205 is now sample 5 of segment 0, and the timestamp is given by the new position');
  assert.equal(chunkTimestamp(205, FPS), Math.round(205 * 1e6 / FPS));
  player.stop();
});
