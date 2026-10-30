// 轨道流（目标 G）编码原型的共用件：G0-b 的各支探针都从这里拿 ffmpeg 路径、G3 滤镜链、
// 严格 GOP 参数、fMP4 按 box 切分、以及生成 / 读取带透明的 PNG。
//
// 口径按 docs/archive/restructure_planning/r75/fold-notes.md 的 r75-05（已采纳）：
//   - 画面尺寸外扩到偶数宽高（yuv420p 要求）
//   - 色半区存**预乘**色：滤镜链开头 format=gbrap,premultiply=inplace=1
//   - Node 端按 MP4 box 切 init.mp4 / 分段、丢 mfra
//   - 编码器参数前要写 -c:v，各编码器的严格 GOP 参数分列
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── ffmpeg / ffprobe ─────────────────────────────────────────────────────────

/** 与 server/bakery/ffmpeg.mjs 的 findFfmpeg 同策略：PATH 上有就用，没有退到 winget 那份。 */
export function findFfmpeg() {
  const fallback = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages',
    'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build', 'bin', 'ffmpeg.exe');
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    return 'ffmpeg';
  } catch {
    return fallback;
  }
}

export const ffprobeOf = (ffmpeg) =>
  ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));

export async function ffmpegVersion(ffmpeg) {
  const { stdout } = await execFileAsync(ffmpeg, ['-version'], { windowsHide: true });
  return stdout.split(/\r?\n/)[0];
}

/** 这台机器上哪些 h264 编码器真的能跑（不是 -encoders 里列着就算）。 */
export async function probeEncoders(ffmpeg, names = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf']) {
  const out = [];
  for (const name of names) {
    const args = ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30', '-frames:v', '3',
      '-c:v', name, '-pix_fmt', 'yuv420p', '-f', 'null', '-'];
    const t0 = performance.now();
    try {
      await execFileAsync(ffmpeg, args, { windowsHide: true });
      out.push({ name, ok: true, ms: +(performance.now() - t0).toFixed(1), error: null });
    } catch (e) {
      out.push({ name, ok: false, ms: +(performance.now() - t0).toFixed(1), error: String(e.stderr || e.message).trim().split(/\r?\n/).slice(-2).join(' ') });
    }
  }
  return out;
}

// ── G3 滤镜链 ────────────────────────────────────────────────────────────────

/**
 * 上下拼合：上半预乘 RGB（H 行）+ 8 行填充 + 下半 alpha 灰度（H 行）+ 8 行填充。
 * `premultiplied: false` 只用来做对照（量渗边），线上口径是 true。
 */
export function stackFilter({ premultiplied = true, colorMatrix = 'bt709', pixFmt = 'yuv420p', range = 'pc', crop = null } = {}) {
  // 裁剪矩形。线上是 `captureFrame` 带 clip 只截这块（G1 / r75-05 第 3 条），这里在滤镜里裁，
  // 等价于拿到一张已经裁好的 PNG——用来量「裁剪矩形取大取小」对编码耗时和体积的影响。
  const cropF = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : '';
  const head = premultiplied
    ? `${cropF}format=gbrap,premultiply=inplace=1,format=rgba,split=2[c][a]`
    : `${cropF}format=rgba,split=2[c][a]`;
  const tail = colorMatrix
    ? `scale=out_range=${range}:out_color_matrix=${colorMatrix},format=${pixFmt}`
    : `scale=out_range=${range},format=${pixFmt}`;
  return `[0:v]${head};` +
    '[c]format=rgb24,pad=iw:ih+8:0:0:black[rgb];' +
    '[a]alphaextract,format=gray,format=rgb24,pad=iw:ih+8:0:0:black[mask];' +
    `[rgb][mask]vstack=inputs=2,${tail}`;
}

/** 各编码器的严格 GOP 参数（r75-05 非阻塞 3.2；具体值以 (7) 实测为准）。 */
export const ENCODER_ARGS = {
  libx264: (q = 16) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q),
    '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-bf', '0'],
  h264_nvenc: (q = 16) => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(q), '-b:v', '0',
    '-g', '15', '-bf', '0', '-no-scenecut', '1', '-forced-idr', '1', '-strict_gop', '1'],
  h264_nvenc_ll: (q = 16) => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'vbr', '-cq', String(q), '-b:v', '0',
    '-g', '15', '-bf', '0', '-no-scenecut', '1', '-forced-idr', '1', '-strict_gop', '1'],
  h264_qsv: (q = 16) => ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', String(q),
    '-g', '15', '-bf', '0'],
  h264_amf: (q = 16) => ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q),
    '-g', '15', '-bf', '0'],
  // MediaFoundation：本机 nvenc 被驱动的 nvenc API 版本卡住（见 (7) 报告）时，Windows 上
  // 唯一还能用的硬件编码路径（背后是 NVIDIA 的 MFT）。`-quality` 是 0..100，越大越好。
  h264_mf: (q = 90) => ['-c:v', 'h264_mf', '-hw_encoding', '1', '-rate_control', 'quality', '-quality', String(q),
    '-g', '15', '-bf', '0'],
  h264_mf_sw: (q = 90) => ['-c:v', 'h264_mf', '-rate_control', 'quality', '-quality', String(q),
    '-g', '15', '-bf', '0'],
};

/** 各编码器「质量」参数的量纲不同：x264/nvenc/qsv 是越小越好的 CRF/CQ，h264_mf 是 0..100 越大越好。 */
export const QUALITY_DEFAULT = {
  libx264: 16, h264_nvenc: 16, h264_nvenc_ll: 16, h264_qsv: 16, h264_amf: 16, h264_mf: 90, h264_mf_sw: 90,
};

/**
 * 各编码器接受的像素格式。h264_mf 的**硬件**路径只收 nv12——滤镜链尾巴写 `format=yuv420p`
 * 时它直接 `format negotiation failed (1/0)`（(7) 实测，见报告）。nv12 与 yuv420p 同为
 * 8 bit 4:2:0，只是 chroma 交织，不影响画质。
 */
export const PIX_FMT = { h264_mf: 'nv12', h264_mf_sw: 'nv12' };

/** G3 的整条命令行（不含 -i 之前的输入声明和最后的输出）。 */
export function encodeArgs({ encoder, fps, quality, premultiplied = true, colorMatrix = 'bt709', tagColor = true, pixFmt, range = 'pc', crop = null }) {
  const enc = ENCODER_ARGS[encoder];
  if (!enc) throw new Error(`未知编码器 ${encoder}`);
  if (quality == null) quality = QUALITY_DEFAULT[encoder] ?? 16;
  if (pixFmt == null) pixFmt = PIX_FMT[encoder] ?? 'yuv420p';
  return [
    '-reinit_filter', '0', '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(fps), '-i', 'pipe:0',
    '-filter_complex', stackFilter({ premultiplied, colorMatrix, pixFmt, range, crop }),
    ...enc(quality),
    ...(tagColor ? ['-color_range', range, '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'] : []),
    '-video_track_timescale', String(fps),
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-an',
  ];
}

/**
 * 一次 ffmpeg 调用 = 一个分段。PNG 从 stdin 喂进去，fMP4 从 stdout 收回来。
 * `stride` > 1 时每张 PNG 连续喂 stride 次（G2 的稀疏分段，timescale 不变）。
 */
export function encodeSegment(ffmpeg, pngs, opts) {
  const { stride = 1, format = 'mp4' } = opts;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', ...encodeArgs(opts), '-f', format, 'pipe:1'];
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let err = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { err += d; });
    proc.stdin.on('error', () => {});
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg ${code}: ${err.trim()}`));
      resolve({ buffer: Buffer.concat(chunks), ms: +(performance.now() - t0).toFixed(2), stderr: err.trim(), args });
    });
    (async () => {
      for (const png of pngs) {
        for (let k = 0; k < stride; k++) {
          if (!proc.stdin.writable) return;
          await new Promise((res) => proc.stdin.write(png, () => res()));
        }
      }
      proc.stdin.end();
    })().catch(() => {});
  });
}

// ── fMP4 按 box 切分（r75-05 非阻塞 3.4）──────────────────────────────────────

/** 顶层 box 列表：[{ type, start, end, size }]。 */
export function topLevelBoxes(buf) {
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    else if (size === 0) size = buf.length - off;
    if (size < header || off + size > buf.length) break;
    out.push({ type, start: off, end: off + size, size, header });
    off += size;
  }
  return out;
}

/**
 * ftyp+moov -> init.mp4；每对 moof+mdat -> 一个分段；mfra 丢弃。
 * 返回 { init, segments: Buffer[], dropped: string[], boxes }。
 */
export function splitFmp4(buf) {
  const boxes = topLevelBoxes(buf);
  const dropped = [];
  let initEnd = 0;
  let i = 0;
  for (; i < boxes.length; i++) {
    if (boxes[i].type === 'ftyp' || boxes[i].type === 'moov') initEnd = boxes[i].end;
    else break;
  }
  const init = buf.subarray(0, initEnd);
  const segments = [];
  let segStart = -1;
  for (; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.type === 'moof') {
      if (segStart >= 0) segments.push(buf.subarray(segStart, b.start));
      segStart = b.start;
    } else if (b.type === 'mdat') {
      // 跟在当前 moof 后面，留着
    } else {
      if (segStart >= 0) { segments.push(buf.subarray(segStart, b.start)); segStart = -1; }
      dropped.push(b.type);
    }
  }
  if (segStart >= 0) segments.push(buf.subarray(segStart));
  return { init: Buffer.from(init), segments: segments.map(Buffer.from), dropped, boxes: boxes.map((b) => b.type) };
}

/** 递归找第一个某类型的 box（返回它的 payload）。 */
export function findBox(buf, type, start = 0, end = buf.length) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const t = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    else if (size === 0) size = end - off;
    if (size < header || off + size > end) return null;
    if (t === type) return { payload: buf.subarray(off + header, off + size), start: off, end: off + size, header };
    // 这些是容器 box，往里找
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts'].includes(t)) {
      const inner = findBox(buf, type, off + header, off + size);
      if (inner) return inner;
    }
    // stsd 的 payload 前 8 字节是 version/flags + entry_count
    if (t === 'stsd') {
      const inner = findBox(buf, type, off + header + 8, off + size);
      if (inner) return inner;
    }
    // avc1 这类 sample entry：前 78 字节是固定头
    if (['avc1', 'avc3'].includes(t)) {
      const inner = findBox(buf, type, off + header + 78, off + size);
      if (inner) return inner;
    }
    off += size;
  }
  return null;
}

/** avcC -> `avc1.PPCCLL`（G0-a 实测 1920x2176 拿到的是 avc1.640033）。 */
export function codecStringFromAvcC(avcC) {
  const p = avcC.readUInt8(1), c = avcC.readUInt8(2), l = avcC.readUInt8(3);
  return `avc1.${[p, c, l].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 从 init.mp4 里取 avcC / 尺寸 / timescale。 */
export function initInfo(init) {
  const avcC = findBox(init, 'avcC');
  const avc1 = findBox(init, 'avc1');
  const mdhd = findBox(init, 'mdhd');
  let width = null, height = null;
  if (avc1) {
    // sample entry: 6 reserved + 2 dataRefIdx + 16 pre_defined/reserved = 24, 然后 width/height
    const p = avc1.payload;
    width = p.readUInt16BE(24); height = p.readUInt16BE(26);
  }
  let timescale = null;
  if (mdhd) {
    const v = mdhd.payload.readUInt8(0);
    timescale = v === 1 ? mdhd.payload.readUInt32BE(20) : mdhd.payload.readUInt32BE(12);
  }
  return {
    codec: avcC ? codecStringFromAvcC(avcC.payload) : null,
    avcCBytes: avcC ? avcC.payload.length : 0,
    width, height, timescale,
  };
}

/** 一个分段里的样本数与首样本是否同步样本（从 trun/tfhd 读）。 */
export function segmentInfo(seg) {
  const tfhd = findBox(seg, 'tfhd');
  const trun = findBox(seg, 'trun');
  const out = { sampleCount: 0, firstSampleIsSync: null, defaultSampleFlags: null, firstSampleFlags: null, baseDecodeTime: null };
  const tfdt = findBox(seg, 'tfdt');
  if (tfdt) {
    const v = tfdt.payload.readUInt8(0);
    out.baseDecodeTime = v === 1 ? Number(tfdt.payload.readBigUInt64BE(4)) : tfdt.payload.readUInt32BE(4);
  }
  if (tfhd) {
    const flags = tfhd.payload.readUInt32BE(0) & 0xffffff;
    let o = 8; // version/flags(4) + track_ID(4)
    if (flags & 0x000001) o += 8;  // base_data_offset
    if (flags & 0x000002) o += 4;  // sample_description_index
    if (flags & 0x000008) o += 4;  // default_sample_duration
    if (flags & 0x000010) o += 4;  // default_sample_size
    if (flags & 0x000020) { out.defaultSampleFlags = tfhd.payload.readUInt32BE(o); o += 4; }
  }
  if (trun) {
    const flags = trun.payload.readUInt32BE(0) & 0xffffff;
    out.sampleCount = trun.payload.readUInt32BE(4);
    let o = 8;
    if (flags & 0x000001) o += 4; // data_offset
    if (flags & 0x000004) { out.firstSampleFlags = trun.payload.readUInt32BE(o); o += 4; }
  }
  const eff = out.firstSampleFlags ?? out.defaultSampleFlags;
  // sample_is_non_sync_sample 是第 16 位（bit 0x00010000）
  if (eff != null) out.firstSampleIsSync = (eff & 0x00010000) === 0;
  return out;
}

// ── PNG（带 alpha）：生成与读取 ───────────────────────────────────────────────

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA（非预乘，straight alpha）字节 -> PNG 字节。 */
export function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', (() => { const b = Buffer.alloc(13); b.writeUInt32BE(width, 0); b.writeUInt32BE(height, 4); b[8] = 8; b[9] = 6; return b; })()),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNG 文件 -> 非预乘 RGBA 字节（交给 ffmpeg 解，省得自己写解码器）。 */
export async function pngToRgba(ffmpeg, file, width, height) {
  const { stdout } = await execFileAsync(ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: width * height * 4 * 4 + (1 << 20), windowsHide: true });
  return stdout;
}

/** PNG 的像素尺寸（只读 IHDR）。 */
export function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * 合成一张带透明的测试画面：软边圆、半透明渐变、硬边方块、细线。
 * 专门造 (5) 要看的那几种情形——半透明边缘、透明区里的彩色残留、硬边。
 */
export function syntheticFrame(width, height, t = 0) {
  const rgba = Buffer.alloc(width * height * 4);
  const cx = width * (0.35 + 0.2 * Math.sin(t * 0.21));
  const cy = height * (0.45 + 0.15 * Math.cos(t * 0.17));
  const r = Math.min(width, height) * 0.3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let R = 0, G = 0, B = 0, A = 0;
      // 软边圆：边缘 6 px 内 alpha 线性过渡（半透明边缘）
      const d = Math.hypot(x - cx, y - cy);
      if (d < r) {
        const a = Math.max(0, Math.min(1, (r - d) / 6));
        R = 240; G = 60 + ((x * 7 + t * 3) % 160); B = 200; A = Math.round(a * 255);
      }
      // 左上硬边方块：不透明，饱和色
      if (x > width * 0.05 && x < width * 0.05 + 120 && y > height * 0.05 && y < height * 0.05 + 80) {
        R = 255; G = 20; B = 20; A = 255;
      }
      // 右侧半透明渐变条：alpha 从 0 到 255，颜色恒定亮青
      if (x > width * 0.72) {
        const a = Math.round(((x - width * 0.72) / (width * 0.28)) * 255);
        R = 0; G = 220; B = 255; A = Math.max(A, a);
      }
      // 细横线（硬边 1 px）
      if (y % 37 === (Math.floor(t) % 37)) { R = 255; G = 255; B = 255; A = 255; }
      rgba[i] = R; rgba[i + 1] = G; rgba[i + 2] = B; rgba[i + 3] = A;
    }
  }
  return rgba;
}

// ── 统计 ─────────────────────────────────────────────────────────────────────

export const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};
export const stats = (a) => a.length ? ({
  n: a.length,
  min: +Math.min(...a).toFixed(2),
  p50: +median(a).toFixed(2),
  p90: +pct(a, 90).toFixed(2),
  max: +Math.max(...a).toFixed(2),
  mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2),
}) : { n: 0 };

export const even = (n) => (n % 2 ? n + 1 : n);

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/** `--flag value`；`--flag` 单独出现视为 true。 */
export function arg(name, fallback = null, argv = process.argv.slice(2)) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
