/**
 * 轨道流分段编码提速(`docs/archive/agent-reports/AGENT-perf-encode.md`)的单测:
 *   - 新滤镜链与旧写法(`streamFilterIdentity`)送进编码器的 YUV 逐字节相同(yuv420p、nv12 两种尾巴);
 *   - 分段签名里的编码参数哈希不变(盘上已有的分段不作废);
 *   - `endsWithCompleteMfra` 的判定;
 *   - 预先拉起的编码进程:领用后补拉、产出和现拉的逐字节相同、`finish()` 见到 mfra 就交字节;
 *     ffmpeg 出错时照旧报错;关掉开关不留进程。
 *   - 整条命令行(输入端不攒包 + 新滤镜链)编出的 fMP4 与改写前的命令行逐字节相同;帧一到就开工
 *     (`docs/archive/agent-reports/AGENT-perf-encode-2.md`)。
 * 需要 ffmpeg 的几条在没有 ffmpeg 的机器上跳过。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import {
  streamFilter, streamFilterIdentity, STREAM_ENCODERS, openStreamSegmentEncoder, endsWithCompleteMfra,
  dropStreamEncoderSpares, streamEncoderSpareCount, streamPrewarmEnabled, streamSegmentArgs, streamFilterThreads,
} from '../bakery/ffmpeg.mjs';
import { encoderParamsHash, splitFmp4, segmentInfo } from '../frame-stream.mjs';

const ffmpegOk = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
after(() => dropStreamEncoderSpares());

/** 合成帧:随机 RGBA(覆盖全部 alpha 值与颜色组合)+ 渐变 + 全透明 / 全不透明块 */
function synthPngs(width, height, count, seed0 = 7) {
  let seed = seed0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 16) & 255; };
  const out = [];
  for (let f = 0; f < count; f++) {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const band = Math.floor((y * 4) / height);
      if (band === 0) { png.data[i] = rnd(); png.data[i + 1] = rnd(); png.data[i + 2] = rnd(); png.data[i + 3] = rnd(); }
      else if (band === 1) { png.data[i] = (x * 3 + f) & 255; png.data[i + 1] = (y * 5) & 255; png.data[i + 2] = (x ^ y) & 255; png.data[i + 3] = x & 255; }
      else if (band === 2) { png.data[i] = 200; png.data[i + 1] = 30; png.data[i + 2] = 90; png.data[i + 3] = x < width / 2 ? 0 : 255; }
      else { png.data[i] = rnd(); png.data[i + 1] = rnd(); png.data[i + 2] = rnd(); png.data[i + 3] = (x + y + f) & 1 ? 255 : rnd(); }
    }
    out.push(PNG.sync.write(png));
  }
  return out;
}

/** 同一批 PNG 过一条滤镜链,拿送进编码器之前的原始 YUV(`threads`:滤镜图切片线程数,0 = ffmpeg 缺省) */
function filtered(filter, pngs, threads = 0) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-filter_complex_threads', String(threads), '-reinit_filter', '0', '-f', 'image2pipe', '-c:v', 'png',
    '-framerate', '30', '-i', 'pipe:0', '-filter_complex', filter, '-f', 'rawvideo', 'pipe:1'],
  { input: Buffer.concat(pngs), maxBuffer: 1 << 28, windowsHide: true });
}

test('新滤镜链只少了中间转换,字面上仍是 G3 的那几步', () => {
  const f = streamFilter('yuv420p');
  assert.match(f, /^\[0:v\]format=gbrap,split=2\[p\]\[a\];\[p\]premultiply=inplace=1,/);
  assert.doesNotMatch(f, /premultiply=inplace=1,split/, '分叉在预乘之后会让 alphaextract 前面自动插一趟反预乘');
  assert.match(f, /scale=out_range=tv:out_color_matrix=bt709,format=yuv420p$/);
  assert.match(streamFilter('nv12'), /format=nv12$/);
  assert.notEqual(streamFilter('yuv420p'), streamFilterIdentity('yuv420p'));
});

test('滤镜切片线程数:按核数封顶 8', () => {
  assert.equal(streamFilterThreads(16, {}), 8);
  assert.equal(streamFilterThreads(32), 8);
  assert.equal(streamFilterThreads(8), 8);
  assert.equal(streamFilterThreads(4), 4);
  assert.equal(streamFilterThreads(1), 1);
  assert.equal(streamFilterThreads(0), 1);
  assert.equal(streamFilterThreads(NaN), 1);
  assert.equal(streamFilterThreads(16, { PROMPTCUT_STREAM_FILTER_THREADS: '0' }), 0, '0 = 交给 ffmpeg');
  assert.equal(streamFilterThreads(16, { PROMPTCUT_STREAM_FILTER_THREADS: '12' }), 12);
  assert.equal(streamFilterThreads(16, { PROMPTCUT_STREAM_FILTER_THREADS: 'x' }), 8, '不是数字就不理');
});

test('分段签名里的编码参数哈希和改写前相同(已有分段不作废)', () => {
  // 改写前(main 2c7cee2)按 streamFilter 字面算出来的值
  assert.equal(encoderParamsHash('libx264'), 'de84562fd4660af1');
  assert.equal(encoderParamsHash('h264_mf'), 'e8429af745c908c0');
  assert.equal(encoderParamsHash('h264_nvenc'), '71b4b8bd213000a1');
});

test('新滤镜链与旧写法送进编码器的 YUV 逐字节相同', { skip: !ffmpegOk && '没有 ffmpeg', timeout: 120_000 }, () => {
  for (const [w, h] of [[256, 64], [330, 190]]) {
    const pngs = synthPngs(w, h, 3, w + h);
    for (const pixFmt of new Set(Object.values(STREAM_ENCODERS).map(s => s.pixFmt))) {
      const a = filtered(streamFilterIdentity(pixFmt), pngs);
      const b = filtered(streamFilter(pixFmt), pngs);
      assert.equal(a.length, 3 * w * 2 * (h + 8) * 1.5, `${w}x${h} ${pixFmt}: 帧大小`);
      assert.ok(a.equals(b), `${w}x${h} ${pixFmt}: 新旧滤镜链的输出不同`);
      // 切片线程数不改产出(命令行按核数封顶 8,机器不同片数不同)
      for (const threads of [1, 3]) assert.ok(filtered(streamFilter(pixFmt), pngs, threads).equals(a), `${w}x${h} ${pixFmt}: ${threads} 片的输出不同`);
    }
  }
});

/* ------------------------------------------------------------ mfra 收尾判定 */

const box = (type, size = 8) => { const b = Buffer.alloc(size); b.writeUInt32BE(size, 0); b.write(type, 4, 'latin1'); return b; };

test('endsWithCompleteMfra:恰好以完整的 mfra 收尾才算', () => {
  const body = [box('ftyp', 16), box('moov', 24), box('moof', 32), box('mdat', 40)];
  assert.equal(endsWithCompleteMfra(Buffer.concat([...body, box('mfra', 20)])), true);
  assert.equal(endsWithCompleteMfra(Buffer.concat(body)), false, '还没写 trailer');
  assert.equal(endsWithCompleteMfra(Buffer.concat([...body, box('mfra', 20)]).subarray(0, 16 + 24 + 32 + 40 + 12)), false, 'mfra 只到了一半');
  assert.equal(endsWithCompleteMfra(Buffer.concat([...body, box('mfra', 20), Buffer.from([0, 0])])), false, 'mfra 后面还有字节');
  assert.equal(endsWithCompleteMfra(Buffer.alloc(0)), false);
  const large = Buffer.alloc(24); large.writeUInt32BE(1, 0); large.write('mfra', 4, 'latin1'); large.writeBigUInt64BE(24n, 8);
  assert.equal(endsWithCompleteMfra(Buffer.concat([box('ftyp', 16), large])), true, '64 位尺寸');
  const zero = box('mfra', 8); zero.writeUInt32BE(0, 0);
  assert.equal(endsWithCompleteMfra(Buffer.concat([box('ftyp', 16), zero])), false, '尺寸 0(到文件尾)不算收尾');
});

/* ------------------------------------------------------------ 预先拉起的编码进程 */

async function encode(pngs, opts) {
  const enc = openStreamSegmentEncoder('ffmpeg', { encoder: 'libx264', fps: 30, ...opts });
  for (const png of pngs) await enc.write(png);
  return enc.finish();
}

test('开关:缺省开,PROMPTCUT_STREAM_PREWARM=0 关', () => {
  assert.equal(streamPrewarmEnabled({}), true);
  assert.equal(streamPrewarmEnabled({ PROMPTCUT_STREAM_PREWARM: '0' }), false);
  assert.equal(streamPrewarmEnabled({ PROMPTCUT_STREAM_PREWARM: '1' }), true);
});

test('预先拉起的进程:领用后补拉一个,产出和现拉的逐字节相同,finish 交的字节以 mfra 收尾', { skip: !ffmpegOk && '没有 ffmpeg', timeout: 120_000 }, async () => {
  dropStreamEncoderSpares();
  const pngs = synthPngs(320, 180, 15, 99);
  const cold = await encode(pngs, { prewarm: false });
  assert.equal(streamEncoderSpareCount(), 0, '关着开关不拉备用进程');
  const first = await encode(pngs, { prewarm: true });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(streamEncoderSpareCount(), 1, '开一个之后池里补了一个');
  const second = await encode(pngs, { prewarm: true });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(streamEncoderSpareCount(), 1, '领走一个又补一个,池里始终只留一个');
  for (const [name, out] of [['cold', cold], ['first', first], ['second', second]]) {
    assert.ok(endsWithCompleteMfra(out.bytes), `${name}: 以 mfra 收尾`);
    assert.equal(out.written, 15);
    const { init, segments } = splitFmp4(out.bytes);
    assert.ok(init.length > 0, `${name}: 有 init`);
    assert.equal(segments.length, 1);
    const info = segmentInfo(segments[0]);
    assert.equal(info.sampleCount, 15, `${name}: 15 个样本`);
    assert.equal(info.firstSampleIsSync, true);
  }
  assert.ok(first.bytes.equals(cold.bytes), '预拉的进程产出与现拉的相同');
  assert.ok(second.bytes.equals(cold.bytes), '领用的备用进程产出与现拉的相同');
  dropStreamEncoderSpares();
  assert.equal(streamEncoderSpareCount(), 0);
});

test('ffmpeg 出错时 finish 照旧报错(备用进程也一样)', { skip: !ffmpegOk && '没有 ffmpeg', timeout: 60_000 }, async () => {
  dropStreamEncoderSpares();
  for (const prewarm of [false, true, true]) {
    const enc = openStreamSegmentEncoder('ffmpeg', { encoder: 'libx264', fps: 30, prewarm });
    await enc.write(Buffer.from('this is not a png at all'.repeat(64))).catch(() => {});
    await assert.rejects(enc.finish(), /ffmpeg\(libx264\)退出码|EPIPE|EOF/, `prewarm=${prewarm}`);
  }
  dropStreamEncoderSpares();
});

/* ------------------------------------------------------------ 整条命令行 */

/** 改写前(main e27fa520)的完整命令行:输入端缺省探测 5 MB、帧级多线程解码,滤镜链是 `streamFilterIdentity` 那条 */
function legacySegmentArgs(fps = 30) {
  return ['-y', '-hide_banner', '-loglevel', 'error',
    '-reinit_filter', '0', '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(fps), '-i', 'pipe:0',
    '-filter_complex', streamFilterIdentity('yuv420p'),
    ...STREAM_ENCODERS.libx264.args,
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-video_track_timescale', String(fps),
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-an',
    '-f', 'mp4', 'pipe:1'];
}

test('整条命令行编出的 fMP4 与改写前逐字节相同', { skip: !ffmpegOk && '没有 ffmpeg', timeout: 180_000 }, () => {
  const run = (args, pngs) => execFileSync('ffmpeg', args, { input: Buffer.concat(pngs), maxBuffer: 1 << 28, windowsHide: true });
  for (const [w, h] of [[320, 180], [642, 362]]) {
    const pngs = synthPngs(w, h, 15, w * 7 + h);
    const before = run(legacySegmentArgs(30), pngs);
    const after = run(streamSegmentArgs({ encoder: 'libx264', fps: 30 }), pngs);
    assert.ok(before.length > 1000, `${w}x${h}: 旧命令行有产出`);
    assert.ok(after.equals(before), `${w}x${h}: 新旧命令行的 fMP4 不同(${after.length} vs ${before.length})`);
  }
});

test('帧一到就开工:还没关 stdin,编码器已经开始出字节', { skip: !ffmpegOk && '没有 ffmpeg', timeout: 60_000 }, async () => {
  dropStreamEncoderSpares();
  const pngs = synthPngs(320, 180, 15, 5);
  const enc = openStreamSegmentEncoder('ffmpeg', { encoder: 'libx264', fps: 30, prewarm: false });
  // 只喂 3 帧、不关 stdin:改写前 ffmpeg 要先读够 5 MB 才开工,整段凑不够,这里会一直是 0
  for (const png of pngs.slice(0, 3)) await enc.write(png);
  const deadline = Date.now() + 20_000;
  while (enc.received === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.ok(enc.received > 0, '喂了 3 帧、stdin 没关,ffmpeg 还一个字节都没出(输入端在攒包)');
  for (const png of pngs.slice(3)) await enc.write(png);
  const out = await enc.finish();
  const { segments } = splitFmp4(out.bytes);
  assert.equal(segmentInfo(segments[0]).sampleCount, 15);
});
