/**
 * 轨道流分段编码器的原始像素输入(渲染重构「己一」,`docs/plan/prerender-products-contract.md` 第 6.2 节左栏):
 * `server/bakery/ffmpeg.mjs` 的 `streamSegmentArgs({ raw })` / `openStreamSegmentEncoder({ raw })`。
 * 跑:`npm test -- server/test/stream-encode-raw.test.mjs`
 *
 *   - 命令行只换输入那一段(`rawvideo`、`rgba`、宽高),后面的滤镜链和编码参数一个字不变;PNG 那一种命令行逐项不变;
 *   - 同样的像素,喂原始 RGBA 和喂 PNG 编出来的 fMP4 逐字节相同(所以画布直取和截图那条路在像素相同时产出同一个分段);
 *   - 预先拉起的进程按宽高各算一种,空等的最多留 3 个。
 * 需要 ffmpeg 的几条在没有 ffmpeg 的机器上跳过。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { streamSegmentArgs, openStreamSegmentEncoder, dropStreamEncoderSpares, streamEncoderSpareCount } from '../bakery/ffmpeg.mjs';
import { splitFmp4, segmentInfo } from '../frame-stream.mjs';

const ffmpegOk = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
after(() => dropStreamEncoderSpares());
const settle = () => new Promise((r) => setTimeout(r, 50));

/** 合成帧(straight RGBA):随机带、渐变带、半透明块、全透明区 */
function synthFrames(width, height, count) {
  let seed = 9;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 16) & 255; };
  const out = [];
  for (let f = 0; f < count; f++) {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const band = Math.floor((y * 4) / height);
      if (band === 0) { data[i] = rnd(); data[i + 1] = rnd(); data[i + 2] = rnd(); data[i + 3] = rnd(); }
      else if (band === 1) { data[i] = (x * 3 + f * 7) & 255; data[i + 1] = (y * 5) & 255; data[i + 2] = (x ^ y) & 255; data[i + 3] = x & 255; }
      else if (band === 2) { if (x >= width / 2) { data[i] = 200; data[i + 1] = 30; data[i + 2] = 90 + f; data[i + 3] = 255; } }
      // band 3:全透明
    }
    out.push(data);
  }
  return out;
}
const pngOf = (data, width, height) => { const png = new PNG({ width, height }); data.copy(png.data); return PNG.sync.write(png); };

test('Command line: raw pixels only swap the input section, the filter chain and encoding parameters are unchanged; the PNG variant stays unchanged item by item', () => {
  const png = streamSegmentArgs({ encoder: 'libx264', fps: 30 });
  const raw = streamSegmentArgs({ encoder: 'libx264', fps: 30, raw: { width: 640, height: 360 } });
  assert.match(png.join(' '), /-probesize 32 -analyzeduration 0 -threads 1 -f image2pipe -c:v png -framerate 30 -i pipe:0/);
  assert.match(raw.join(' '), /-probesize 32 -analyzeduration 0 -threads 1 -f rawvideo -pix_fmt rgba -video_size 640x360 -framerate 30 -i pipe:0/);
  const at = (args) => args.indexOf('-framerate');
  assert.deepEqual(raw.slice(at(raw)), png.slice(at(png)), 'From -framerate onward (input, filter chain, encoder, muxing) identical item by item');
  const head = (args) => args.slice(0, args.indexOf('-f'));
  assert.deepEqual(head(raw), head(png), 'The options before the input format are identical item by item');
  assert.deepEqual(streamSegmentArgs({ encoder: 'libx264', fps: 30, raw: null }), png, 'Without raw it is the original command line');
  assert.throws(() => streamSegmentArgs({ encoder: 'libx264', fps: 30, raw: { width: 0, height: 10 } }), /integer width and height/);
  assert.throws(() => streamSegmentArgs({ encoder: 'libx264', fps: 30, raw: { width: 10.5, height: 10 } }), /integer width and height/);
});

test('Same pixels: the fMP4 encoded from raw RGBA and from PNG is byte-identical', { skip: !ffmpegOk }, async () => {
  const width = 96, height = 64, count = 15;
  const frames = synthFrames(width, height, count);
  const viaPng = openStreamSegmentEncoder('ffmpeg', { encoder: 'libx264', fps: 30, prewarm: false });
  for (const frame of frames) await viaPng.write(pngOf(frame, width, height));
  const a = await viaPng.finish();
  const viaRaw = openStreamSegmentEncoder('ffmpeg', { encoder: 'libx264', fps: 30, prewarm: false, raw: { width, height } });
  for (const frame of frames) await viaRaw.write(frame);
  const b = await viaRaw.finish();
  assert.equal(b.written, count);
  const sa = splitFmp4(a.bytes), sb = splitFmp4(b.bytes);
  assert.equal(sb.segments.length, 1);
  assert.equal(segmentInfo(sb.segments[0]).sampleCount, count, 'As many frames are encoded as raw-pixel frames were fed');
  assert.equal(segmentInfo(sb.segments[0]).firstSampleIsSync, true);
  assert.equal(Buffer.compare(sa.init, sb.init), 0, 'init (ftyp + moov) is byte-identical');
  assert.equal(Buffer.compare(sa.segments[0], sb.segments[0]), 0, 'Segment (moof + mdat) is byte-identical');
});

test('Raw pixel data does not make up a whole frame: ffmpeg encodes only the complete frames (the sample count then does not match, which the splitter side judges)', { skip: !ffmpegOk }, async () => {
  const width = 32, height = 32;
  const frames = synthFrames(width, height, 3);
  const enc = openStreamSegmentEncoder('ffmpeg', { encoder: 'libx264', fps: 30, prewarm: false, raw: { width, height } });
  await enc.write(frames[0]);
  await enc.write(frames[1]);
  await enc.write(frames[2].subarray(0, 100));
  const out = await enc.finish();
  assert.equal(segmentInfo(splitFmp4(out.bytes).segments[0]).sampleCount, 2);
});

test('Pre-started process: each width and height of raw pixels counts as its own kind, output matches the on-demand one; at most 3 idle ones are kept', { skip: !ffmpegOk }, async () => {
  dropStreamEncoderSpares();
  const frames = synthFrames(48, 32, 4);
  const run = async (prewarm) => {
    const enc = openStreamSegmentEncoder('ffmpeg', { encoder: 'libx264', fps: 30, prewarm, raw: { width: 48, height: 32 } });
    for (const frame of frames) await enc.write(frame);
    return (await enc.finish()).bytes;
  };
  const cold = await run(false);
  assert.equal(streamEncoderSpareCount(), 0);
  const first = await run(true);
  await settle();
  assert.equal(streamEncoderSpareCount(), 1, 'After one is taken, another with the same width and height is started to replace it');
  const warm = await run(true);
  assert.equal(Buffer.compare(cold, first), 0);
  assert.equal(Buffer.compare(cold, warm), 0, 'Output of the pre-started process is byte-identical to the on-demand one');
  // 换五种宽高各开一次:空等的不超过 3 个
  for (const w of [50, 52, 54, 56, 58]) {
    const enc = openStreamSegmentEncoder('ffmpeg', { encoder: 'libx264', fps: 30, prewarm: true, raw: { width: w, height: 32 } });
    await enc.abort();
    await settle();
  }
  assert.ok(streamEncoderSpareCount() <= 3, `${streamEncoderSpareCount()} idle processes`);
  dropStreamEncoderSpares();
  assert.equal(streamEncoderSpareCount(), 0);
});
