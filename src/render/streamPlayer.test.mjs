/**
 * 页面侧轨道流的纯函数单测。跑:node --test src/render/streamPlayer.test.mjs
 *
 * 解码、合成要浏览器(`VideoDecoder` / WebGL),端到端在 `scripts/probes/stream-play-probe.mjs`;
 * 这里钉住解封装、时间戳、平面合成和帧预算这几件纯算的事。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInit, parseSegment, chunkTimestamp, frameOfTimestamp, rangesHave, streamPlanesFor, streamLayerHas, StreamPlayer,
  MAX_FRAMES_PER_DECODER, MIN_FRAMES_PER_STREAM, DECODED_BYTES_BUDGET, DECODER_BUDGET, SEGMENT_FRAMES,
} from './streamPlayer.ts';

const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const box = (type, ...parts) => { const body = cat(...parts); return cat(u32(8 + body.length), new TextEncoder().encode(type), body); };
const full = (v, f) => u32(((v & 0xff) << 24) | (f & 0xffffff));

function init({ width = 704, height = 864, level = 0x1f } = {}) {
  const avcC = box('avcC', new Uint8Array([1, 0x64, 0x00, level, 0xff, 0xe1, 0, 0, 1, 0, 0]));
  const entry = new Uint8Array(78);
  const dv = new DataView(entry.buffer);
  dv.setUint16(6, 1); dv.setUint16(24, width); dv.setUint16(26, height);
  const stsd = box('stsd', full(0, 0), u32(1), box('avc1', entry, avcC));
  return cat(box('ftyp', new TextEncoder().encode('isom'), u32(512)), box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd))))));
}

function segment(sizes) {
  const tfhd = box('tfhd', full(0, 0x020020), u32(1), u32(0x01010000));
  const body = (off) => cat(full(0, 0x000205), u32(sizes.length), u32(off), u32(0x02000000), ...sizes.map(u32));
  const probe = box('moof', box('traf', tfhd, box('trun', body(0))));
  const moof = box('moof', box('traf', tfhd, box('trun', body(probe.length + 8))));
  const mdat = box('mdat', cat(...sizes.map((n, i) => new Uint8Array(n).fill(i + 1))));
  return cat(moof, mdat);
}

const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

test('parseInit builds the codec string from avcC (never hard-coded) and reads the coded size', () => {
  const out = parseInit(ab(init({ level: 0x32 })));
  assert.equal(out.codec, 'avc1.640032');
  assert.equal(out.width, 704);
  assert.equal(out.height, 864);
  assert.equal(out.description[0], 1, 'description = avcC 原样');
  assert.throws(() => parseInit(ab(box('ftyp', u32(0)))), /avcC/);
});

test('parseSegment: sample offsets are relative to moof (default-base-is-moof), only the first sample is sync', () => {
  const buf = segment([7, 3, 5]);
  const samples = parseSegment(ab(buf));
  assert.equal(samples.length, 3);
  assert.deepEqual(samples.map((s) => s.isSync), [true, false, false]);
  assert.deepEqual(samples.map((s) => s.size), [7, 3, 5]);
  // 样本数据确实落在 mdat 里、按顺序排
  for (let i = 0; i < samples.length; i++) assert.equal(buf[samples[i].offset], i + 1);
});

test('timestamps are the global frame number × 1e6 / fps and round-trip at 24 / 25 / 30 / 60', () => {
  for (const fps of [24, 25, 30, 60]) {
    for (const frame of [0, 1, 14, 15, 29, 1234, 17999]) assert.equal(frameOfTimestamp(chunkTimestamp(frame, fps), fps), frame, `${fps}@${frame}`);
  }
  // G5:(分段号 × 15 + 样本序号)× 1e6 / fps
  assert.equal(chunkTimestamp(3 * SEGMENT_FRAMES + 4, 30), Math.round(49 * 1e6 / 30));
});

test('streamPlanesFor: only suppressed cards whose current segment is ready; a group needs every member suppressed', () => {
  const layers = [
    { clipId: 'a', key: 'KA', ranges: [[0, 3]], originFrame: 0 },
    { clipId: 'c', key: 'KG', ranges: [[0, 9]], groupClipIds: ['b', 'c'], originFrame: 0 },
    { clipId: 'd', key: 'KD', ranges: [[5, 9]], originFrame: 0 },
  ];
  const planes = streamPlanesFor(layers, new Set(['a', 'b', 'c', 'd']), 20);
  assert.deepEqual(planes, [
    { clipIds: ['a'], key: 'KA', ranges: [[0, 3]], originFrame: 0 },
    { clipIds: ['b', 'c'], key: 'KG', ranges: [[0, 9]], originFrame: 0 },
  ], 'd 的第 1 段还没就绪:不挂平面(父页给它投最近快照)');
  assert.deepEqual(streamPlanesFor(layers, new Set(['a', 'c']), 20).map((p) => p.clipIds), [['a']], '组里有一张没被抑制就不贴组流');
  assert.equal(rangesHave([[0, 3], [7, 7]], 7), true);
  assert.equal(rangesHave([[0, 3]], 4), false);
  assert.equal(rangesHave(undefined, 0), false);
});

test('streamPlanesFor / streamLayerHas: 每一层按它自己的第一帧把项目帧号换成分段号;没带第一帧的层不出流平面', () => {
  // a 从第 100 帧开始、d 从第 7 帧开始,两条流都只有第 1 段就绪
  const layers = [
    { clipId: 'a', key: 'KA', ranges: [[1, 1]], originFrame: 100 },
    { clipId: 'd', key: 'KD', ranges: [[1, 1]], originFrame: 7 },
    { clipId: 'old', key: 'KO', ranges: [[0, 99]] },
  ];
  const all = new Set(['a', 'd', 'old']);
  const at = (frame) => streamPlanesFor(layers, all, frame).map((p) => p.clipIds[0]);
  assert.deepEqual(at(21), [], 'd 的第 1 段是第 22～36 帧');
  assert.deepEqual(at(22), ['d']);
  assert.deepEqual(at(36), ['d']);
  assert.deepEqual(at(37), []);
  assert.deepEqual(at(114), [], 'a 的第 1 段是第 115～129 帧');
  assert.deepEqual(at(115), ['a']);
  assert.deepEqual(at(129), ['a']);
  assert.deepEqual(at(130), []);
  assert.equal(streamPlanesFor(layers, all, 115)[0].originFrame, 100, '流平面带着第一帧交给舞台');
  assert.equal(streamLayerHas(layers[0], 99), false, '早于第一帧:没有分段');
  assert.equal(streamLayerHas({ ranges: [[0, 0]], originFrame: 100 }, 99), false);
  assert.equal(streamLayerHas({ ranges: [[0, 0]], originFrame: 100 }, 100), true);
  assert.equal(streamLayerHas(layers[2], 0), false, '没带第一帧的层一律算没有');
});

test('capFor: bytes budget shared between streams, clamped to [3, 8] frames per decoder', () => {
  const player = new StreamPlayer({ root: () => null, source: { manifest: async () => { throw new Error('x'); }, init: async () => new ArrayBuffer(0), segment: async () => new ArrayBuffer(0) } });
  const full1080 = { bytesPerFrame: 1920 * 2176 * 1.5 };
  // 一条:80 MB 够 12 帧,但单解码器硬上限 8
  player.tracks = new Map([['a', full1080]]);
  assert.equal(player.capFor(full1080), MAX_FRAMES_PER_DECODER);
  // 六条 1080p 全幅:每条 80/6 MB ≈ 2 帧,保底 3
  player.tracks = new Map(Array.from({ length: 6 }, (_, i) => [String(i), full1080]));
  assert.equal(player.capFor(full1080), MIN_FRAMES_PER_STREAM);
  // 裁剪很小的流:字节远没到预算也照样不超过 8(G0-b (4):卡死的是帧数,不是字节)
  assert.equal(player.capFor({ bytesPerFrame: 612 * 916 * 1.5 }), MAX_FRAMES_PER_DECODER);
  assert.equal(DECODED_BYTES_BUDGET, 80 * 1024 * 1024);
});

test('a stopped player ignores present(); planes without a key are placeholders only', () => {
  const player = new StreamPlayer({ root: () => null });
  player.setPlanes([{ clipIds: ['a'] }, { clipIds: ['b'], key: 'K', originFrame: 0 }, { clipIds: ['c'], key: 'L' }], 30);
  assert.equal(player.diag().planes, 1, '没有流键、没带第一帧的平面都只占位');
  player.stop();
  player.present(1);
  assert.equal(player.diag().stopped, true);
  assert.equal(player.diag().tracks.length, 0);
});

test('setPlanes drops the streams that are no longer wanted right away (pause sends an empty list)', () => {
  const player = new StreamPlayer({ root: () => null });
  const disposed = [];
  const fake = (id) => ({ dispose: () => disposed.push(id) });
  player.tracks = new Map([['a#K', fake('a')], ['b#L', fake('b')]]);
  player.setPlanes([{ clipIds: ['b'], key: 'L', originFrame: 0 }], 30);
  assert.deepEqual(disposed, ['a']);
  assert.deepEqual([...player.tracks.keys()], ['b#L']);
  player.setPlanes([], 30);
  assert.deepEqual(disposed, ['a', 'b']);
  assert.equal(player.tracks.size, 0);
});
