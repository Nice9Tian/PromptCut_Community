/**
 * Shot segmentation, pagination planning, sheet ffmpeg arguments, and image dimension probing for
 * see_frames({ source: "media" }). Pure Node module; does not import src/, touch network, or
 * access global store.
 */

export const DEFAULT_PER_PAGE = 6;
export const MAX_PER_PAGE = 12;
/** Splits into segments at fixed intervals when shot detection was not run (or failed) */
export const FALLBACK_STEP_SEC = 10;
/** Shifts frame extraction slightly past shot start to avoid the frame landing right on a transition */
export const FRAME_EPS = 0.05;

/** Shot detection results → shot list; falls back to fixed intervals if no results, marked fallback */
export function scenesOf(shots, durationSec, step = FALLBACK_STEP_SEC) {
  if (shots?.shots?.length) {
    return {
      scenes: shots.shots.map((s, i) => ({
        index: i + 1,
        start: s.start,
        end: s.end,
        inTransition: s.inTransition ?? null,
        outTransition: s.outTransition ?? null,
      })),
    };
  }
  const total = Math.max(0, Number(durationSec) || 0);
  const scenes = [];
  if (total <= 0) return { scenes, fallback: 'fixed-interval' };
  const n = Math.max(1, Math.ceil(total / step));
  for (let i = 0; i < n; i++) {
    const start = i * step;
    scenes.push({
      index: i + 1,
      start,
      end: Math.min(total, start + step),
      inTransition: null,
      outTransition: null,
    });
  }
  return { scenes, fallback: 'fixed-interval' };
}

/** Filter + pagination. If scene is specified, inspects only that one (default 9-grid), ignoring pagination */
export function planSequences(all, opts = {}) {
  const totalScenes = all.length;
  if (opts.scene !== undefined) {
    const n = Number(opts.scene);
    if (!Number.isInteger(n) || n < 1 || n > totalScenes) {
      throw new Error(`scene must be between 1 and ${totalScenes}, got ${JSON.stringify(opts.scene)}`);
    }
    const grid = opts.grid === 4 ? 4 : 9;
    return {
      scenes: [all[n - 1]],
      page: 1,
      pages: 1,
      perPage: 1,
      grid,
      matched: 1,
      totalScenes,
      nextPage: null,
      prevPage: null,
    };
  }
  const from = opts.from !== undefined ? Number(opts.from) : -Infinity;
  const to = opts.to !== undefined ? Number(opts.to) : Infinity;
  if (opts.from !== undefined && !Number.isFinite(from)) throw new Error('from must be a number of seconds');
  if (opts.to !== undefined && !Number.isFinite(to)) throw new Error('to must be a number of seconds');
  if (from > to) throw new Error('from must not be greater than to');
  const matched = all.filter((s) => s.end > from && s.start < to);
  const perPage = Math.max(1, Math.min(MAX_PER_PAGE, Math.round(Number(opts.perPage) || DEFAULT_PER_PAGE)));
  const grid = opts.grid === 9 ? 9 : 4;
  const pages = Math.max(1, Math.ceil(matched.length / perPage));
  const page = Math.max(1, Math.min(pages, Math.round(Number(opts.page) || 1)));
  const scenes = matched.slice((page - 1) * perPage, page * perPage);
  return {
    scenes,
    page,
    pages,
    perPage,
    grid,
    matched: matched.length,
    totalScenes,
    nextPage: page < pages ? page + 1 : null,
    prevPage: page > 1 ? page - 1 : null,
  };
}

/** Frames (seconds) to extract for a shot: even intervals, start shifted slightly; matches server ffmpeg fps filter */
export function frameTimes(start, end, grid) {
  const dur = Math.max(0, end - start - FRAME_EPS);
  const n = Math.max(1, grid | 0);
  const out = [];
  for (let k = 0; k < n; k++) out.push(Math.round((start + FRAME_EPS + (dur * k) / n) * 100) / 100);
  return out;
}

/** Caption text during this period (only if transcribed); includes all segments intersecting the interval */
export function transcriptFor(transcript, start, end) {
  if (!transcript?.segments?.length) return '';
  return transcript.segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => String(s.text ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Generates ffmpeg CLI arguments for a single shot sheet (consistent with /api/vision/sheet).
 * @param {{ file: string, start: number, end: number, grid?: number, out: string, localOnly?: boolean }} p
 */
export function sheetFfmpegArgs({ file, start, end, grid = 4, out, localOnly = true }) {
  const s0 = Number(start);
  const s1 = Number(end);
  if (!Number.isFinite(s0) || !Number.isFinite(s1) || s1 <= s0) {
    throw new Error('start / end must be numbers of seconds and end > start');
  }
  const g = grid === 9 ? 9 : 4;
  const cols = g === 9 ? 3 : 2;
  const dur = Math.max(0.1, s1 - s0 - FRAME_EPS);
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', (s0 + FRAME_EPS).toFixed(3),
    '-t', dur.toFixed(3),
    ...(localOnly ? ['-protocol_whitelist', 'file'] : []),
    '-i', file,
    '-vf', `fps=${(g / dur).toFixed(6)},scale=480:-2:flags=fast_bilinear,tile=${cols}x${cols}:padding=2:margin=2:color=0x111318`,
    '-frames:v', '1', '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', out,
  ];
  return { grid: g, cols, frames: frameTimes(s0, s1, g), args };
}

/**
 * Parses width, height, and MIME from headers of common image formats (PNG / JPEG / GIF / WebP).
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, mime: string } | null}
 */
export function probeImageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR at offset 8
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height, mime: 'image/png' };
  }
  // GIF: GIF87a / GIF89a
  if (buf.length >= 10 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    if (width > 0 && height > 0) return { width, height, mime: 'image/gif' };
  }
  // WebP: RIFF....WEBP
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      if (width > 0 && height > 0) return { width, height, mime: 'image/webp' };
    } else if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      if (width > 0 && height > 0) return { width, height, mime: 'image/webp' };
    } else if (chunk === 'VP8X' && buf.length >= 30) {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      if (width > 0 && height > 0) return { width, height, mime: 'image/webp' };
    }
  }
  // JPEG: FF D8 ... SOF markers
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 8 < buf.length) {
      if (buf[off] !== 0xff) { off += 1; continue; }
      while (off < buf.length && buf[off] === 0xff) off += 1;
      if (off >= buf.length) break;
      const marker = buf[off++];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
      if (off + 2 > buf.length) break;
      const segLen = buf.readUInt16BE(off);
      if (segLen < 2 || off + segLen > buf.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        if (segLen >= 7) {
          const height = buf.readUInt16BE(off + 3);
          const width = buf.readUInt16BE(off + 5);
          if (width > 0 && height > 0) return { width, height, mime: 'image/jpeg' };
        }
      }
      off += segLen;
    }
    return { width: 0, height: 0, mime: 'image/jpeg' };
  }
  return null;
}
