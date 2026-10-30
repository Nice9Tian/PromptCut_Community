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

test('命令行:原始像素只换输入那一段,滤镜链和编码参数不变;PNG 那一种逐项不变', () => {
  const png = streamSegmentArgs({ encoder: 'libx264', fps: 30 });
  const raw = streamSegmentArgs({ encoder: 'libx264', fps: 30, raw: { width: 640, height: 360 } });
  assert.match(png.join(' '), /-probesize 32 -analyzeduration 0 -threads 1 -f image2pipe -c:v png -framerate 30 -i pipe:0/);
  assert.match(raw.join(' '), /-probesize 32 -analyzeduration 0 -threads 1 -f rawvideo -pix_fmt rgba -video_size 640x360 -framerate 30 -i pipe:0/);
  const at = (args) => args.indexOf('-framerate');
  assert.deepEqual(raw.slice(at(raw)), png.slice(at(png)), '从 -framerate 往后(输入口、滤镜链、编码器、封装)逐项相同');
  const head = (args) => args.slice(0, args.indexOf('-f'));
  assert.deepEqual(head(raw), head(png), '输入格式之前的选项逐项相同');
  assert.deepEqual(streamSegmentArgs({ encoder: 'libx264', fps: 30, raw: null }), png, '不给 raw 就是原来那条命令行');
  assert.throws(() => streamSegmentArgs({ encoder: 'libx264', fps: 30, raw: { width: 0, height: 10 } }), /整数宽高/);
  assert.throws(() => streamSegmentArgs({ encoder: 'libx264', fps: 30, raw: { width: 10.5, height: 10 } }), /整数宽高/);
});

test('同样的像素:喂原始 RGBA 和喂 PNG 编出来的 fMP4 逐字节相同', { skip: !ffmpegOk }, async () => {
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
  assert.equal(segmentInfo(sb.segments[0]).sampleCount, count, '喂几帧原始像素就编出几帧');
  assert.equal(segmentInfo(sb.segments[0]).firstSampleIsSync, true);
  assert.equal(Buffer.compare(sa.init, sb.init), 0, 'init(ftyp + moov)逐字节相同');
  assert.equal(Buffer.compare(sa.segments[0], sb.segments[0]), 0, '分段(moof + mdat)逐字节相同');
});

test('原始像素的帧不够整帧:ffmpeg 只编出完整的那几帧(样本数对不上,由切分那一侧判)', { skip: !ffmpegOk }, async () => {
  const width = 32, height = 32;
  const frames = synthFrames(width, height, 3);
  const enc = openStreamSegmentEncoder('ffmpeg', { encoder: 'libx264', fps: 30, prewarm: false, raw: { width, height } });
  await enc.write(frames[0]);
  await enc.write(frames[1]);
  await enc.write(frames[2].subarray(0, 100));
  const out = await enc.finish();
  assert.equal(segmentInfo(splitFmp4(out.bytes).segments[0]).sampleCount, 2);
});

test('预先拉起的进程:原始像素按宽高各算一种,产出和现拉的相同;空等的最多留 3 个', { skip: !ffmpegOk }, async () => {
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
  assert.equal(streamEncoderSpareCount(), 1, '领走以后补拉一个同样宽高的');
  const warm = await run(true);
  assert.equal(Buffer.compare(cold, first), 0);
  assert.equal(Buffer.compare(cold, warm), 0, '预先拉起的进程产出和现拉的逐字节相同');
  // 换五种宽高各开一次:空等的不超过 3 个
  for (const w of [50, 52, 54, 56, 58]) {
    const enc = openStreamSegmentEncoder('ffmpeg', { encoder: 'libx264', fps: 30, prewarm: true, raw: { width: w, height: 32 } });
    await enc.abort();
    await settle();
  }
  assert.ok(streamEncoderSpareCount() <= 3, `空等的进程 ${streamEncoderSpareCount()} 个`);
  dropStreamEncoderSpares();
  assert.equal(streamEncoderSpareCount(), 0);
});
