// Shared utilities for track stream (Target G) encoding prototype: all G0-b probes get ffmpeg path,
// G3 filter chain, strict GOP parameters, fMP4 splitting by box, and generating / reading
// transparent PNGs from here.
//
// Spec follows r75-05 (accepted) in docs/archive/restructure_planning/r75/fold-notes.md:
//   - Expand frame dimensions to even width and height (required by yuv420p)
//   - Store **premultiplied** color in color half: filter chain starts with format=gbrap,premultiply=inplace=1
//   - Node side splits init.mp4 / segments by MP4 box, discards mfra
//   - Prepend -c:v before encoder parameters, list strict GOP parameters for each encoder separately
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── ffmpeg / ffprobe ─────────────────────────────────────────────────────────

/** Same strategy as findFfmpeg in server/bakery/ffmpeg.mjs: use PATH if available, otherwise fall back to winget copy. */
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

/** Which h264 encoders can actually run on this machine (not just listed in -encoders). */
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

// ── G3 filter chain ───────────────────────────────────────────────────────────

/**
 * Vertically stacked: upper half premultiplied RGB (H lines) + 8 lines padding + lower half alpha
 * grayscale (H lines) + 8 lines padding.
 * `premultiplied: false` is only used as a control (measuring color bleeding), production spec is true.
 */
export function stackFilter({ premultiplied = true, colorMatrix = 'bt709', pixFmt = 'yuv420p', range = 'pc', crop = null } = {}) {
  // Crop rectangle. In production, `captureFrame` with clip only captures this area (G1 / r75-05
  // item 3); here it is cropped in the filter, equivalent to getting an already-cropped PNG: used to
  // measure the impact of "crop rectangle size" on encoding duration and file size.
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

/** Strict GOP parameters for each encoder (r75-05 non-blocking 3.2; specific values subject to actual measurements in (7)). */
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
  // MediaFoundation: when local nvenc is stuck on driver nvenc API version (see report (7)),
  // the only usable hardware encoding path on Windows (backed by NVIDIA MFT). `-quality` is 0..100,
  // higher is better.
  h264_mf: (q = 90) => ['-c:v', 'h264_mf', '-hw_encoding', '1', '-rate_control', 'quality', '-quality', String(q),
    '-g', '15', '-bf', '0'],
  h264_mf_sw: (q = 90) => ['-c:v', 'h264_mf', '-rate_control', 'quality', '-quality', String(q),
    '-g', '15', '-bf', '0'],
};

/** Different encoders use different scales for "quality" parameter: x264/nvenc/qsv use lower-is-better CRF/CQ, h264_mf is 0..100 where higher is better. */
export const QUALITY_DEFAULT = {
  libx264: 16, h264_nvenc: 16, h264_nvenc_ll: 16, h264_qsv: 16, h264_amf: 16, h264_mf: 90, h264_mf_sw: 90,
};

/**
 * Pixel formats accepted by each encoder. The **hardware** path of h264_mf only accepts nv12: when
 * `format=yuv420p` is at the end of the filter chain, it fails directly with `format negotiation failed (1/0)`
 * ((7) live test, see report). Both nv12 and yuv420p are 8 bit 4:2:0, differing only in chroma
 * interleaving, without affecting image quality.
 */
export const PIX_FMT = { h264_mf: 'nv12', h264_mf_sw: 'nv12' };

/** Entire command line for G3 (excluding input declaration before -i and final output). */
export function encodeArgs({ encoder, fps, quality, premultiplied = true, colorMatrix = 'bt709', tagColor = true, pixFmt, range = 'pc', crop = null }) {
  const enc = ENCODER_ARGS[encoder];
  if (!enc) throw new Error(`unknown encoder ${encoder}`);
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
 * One ffmpeg invocation = one segment. PNG is fed from stdin, fMP4 is collected from stdout.
 * When `stride` > 1, each PNG is fed stride consecutive times (G2 sparse segment, timescale unchanged).
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

// ── fMP4 split by box (r75-05 non-blocking 3.4) ───────────────────────────────────

/** Top-level box list: [{ type, start, end, size }]. */
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
 * ftyp+moov -> init.mp4; each moof+mdat pair -> one segment; mfra discarded.
 * Returns { init, segments: Buffer[], dropped: string[], boxes }.
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
      // Follows current moof, kept
    } else {
      if (segStart >= 0) { segments.push(buf.subarray(segStart, b.start)); segStart = -1; }
      dropped.push(b.type);
    }
  }
  if (segStart >= 0) segments.push(buf.subarray(segStart));
  return { init: Buffer.from(init), segments: segments.map(Buffer.from), dropped, boxes: boxes.map((b) => b.type) };
}

/** Recursively find the first box of a given type (returns its payload). */
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
    // These are container boxes, look inside
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts'].includes(t)) {
      const inner = findBox(buf, type, off + header, off + size);
      if (inner) return inner;
    }
    // The first 8 bytes of the stsd payload are version/flags + entry_count
    if (t === 'stsd') {
      const inner = findBox(buf, type, off + header + 8, off + size);
      if (inner) return inner;
    }
    // Sample entries like avc1: the first 78 bytes are a fixed header
    if (['avc1', 'avc3'].includes(t)) {
      const inner = findBox(buf, type, off + header + 78, off + size);
      if (inner) return inner;
    }
    off += size;
  }
  return null;
}

/** avcC -> `avc1.PPCCLL` (G0-a measured 1920x2176 returned avc1.640033). */
export function codecStringFromAvcC(avcC) {
  const p = avcC.readUInt8(1), c = avcC.readUInt8(2), l = avcC.readUInt8(3);
  return `avc1.${[p, c, l].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Extract avcC / dimensions / timescale from init.mp4. */
export function initInfo(init) {
  const avcC = findBox(init, 'avcC');
  const avc1 = findBox(init, 'avc1');
  const mdhd = findBox(init, 'mdhd');
  let width = null, height = null;
  if (avc1) {
    // sample entry: 6 reserved + 2 dataRefIdx + 16 pre_defined/reserved = 24, then width/height
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

/** Sample count in a segment and whether the first sample is a sync sample (read from trun/tfhd). */
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
  // sample_is_non_sync_sample is bit 16 (bit 0x00010000)
  if (eff != null) out.firstSampleIsSync = (eff & 0x00010000) === 0;
  return out;
}

// ── PNG (with alpha): generation and reading ──────────────────────────────────────────

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

/** RGBA (non-premultiplied, straight alpha) bytes -> PNG bytes. */
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

/** PNG file -> non-premultiplied RGBA bytes (let ffmpeg decode, saving us writing a decoder). */
export async function pngToRgba(ffmpeg, file, width, height) {
  const { stdout } = await execFileAsync(ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: width * height * 4 * 4 + (1 << 20), windowsHide: true });
  return stdout;
}

/** PNG pixel dimensions (reads only IHDR). */
export function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Synthesize a test frame with transparency: soft-edged circle, semi-transparent gradient,
 * hard-edged square, thin line.
 * Specifically crafts the cases to inspect in (5): semi-transparent edges, color residue in
 * transparent areas, hard edges.
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
      // Soft-edged circle: linear alpha transition within 6 px of edge (semi-transparent edge)
      const d = Math.hypot(x - cx, y - cy);
      if (d < r) {
        const a = Math.max(0, Math.min(1, (r - d) / 6));
        R = 240; G = 60 + ((x * 7 + t * 3) % 160); B = 200; A = Math.round(a * 255);
      }
      // Top-left hard-edged square: opaque, saturated color
      if (x > width * 0.05 && x < width * 0.05 + 120 && y > height * 0.05 && y < height * 0.05 + 80) {
        R = 255; G = 20; B = 20; A = 255;
      }
      // Right semi-transparent gradient bar: alpha from 0 to 255, constant bright cyan color
      if (x > width * 0.72) {
        const a = Math.round(((x - width * 0.72) / (width * 0.28)) * 255);
        R = 0; G = 220; B = 255; A = Math.max(A, a);
      }
      // Thin horizontal line (hard edge 1 px)
      if (y % 37 === (Math.floor(t) % 37)) { R = 255; G = 255; B = 255; A = 255; }
      rgba[i] = R; rgba[i + 1] = G; rgba[i + 2] = B; rgba[i + 3] = A;
    }
  }
  return rgba;
}

// ── Statistics ───────────────────────────────────────────────────────────────

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

/** `--flag value`; `--flag` appearing alone is treated as true. */
export function arg(name, fallback = null, argv = process.argv.slice(2)) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
