/**
 * ai-visual.mjs
 * 
 * Pure Node ESM module for "AI panel tool result visualization".
 * Contains logic for random ID generation, file access, object comparison formatting,
 * and exporting GIFs / grid images using ffmpeg.
 */
import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';

/** pngjs is only in devDependencies and may not be in package: load on demand; if missing, skip crop (encode full screen) instead of failing to start module */
let pngLib;
async function loadPng() {
  if (pngLib === undefined) pngLib = await import('pngjs').then((m) => m.default || m, () => null);
  return pngLib;
}

/** On Windows, renaming when target file is open causes EPERM; retry at most this many times (see atomicWrite) */
const RENAME_ATTEMPTS = 40;

/**
 * The storage directory is shared across several processes (T1a review #13): the editor process
 * and prerender processes (including both `user` and `agent` when split) all read and write to
 * `ai-visual/` under the same `PROMPTCUT_EXPORT_DIR` (defaults to `<root>/out`): render specs and
 * records written by the model's `get_gif` in one process can be read and rendered by another
 * process (cloud-task.md resolution 12: the model's `get_gif` only writes Spec in the `'agent'`
 * process, while user-clicked GET requests and model-requested `/render` have pixels rendered by
 * the `user` process).
 *
 * Therefore, every write here **writes to a temporary file first then renames**: another process
 * might be reading the same file concurrently, and a direct `writeFile` could cause it to read
 * half-written JSON (`readJson` returns null, turning GET into a 404) or a half-written GIF.
 * On Windows, renaming when the other process happens to have the file open briefly causes
 * EPERM / EBUSY / EACCES; retry (up to `RENAME_ATTEMPTS` times, see function body).
 */
export async function atomicWrite(file, data) {
  await fsPromises.mkdir(path.dirname(file), { recursive: true });
  const ext = path.extname(file);
  // Temporary name keeps original extension: ffmpeg selects format by extension (encodeGif names here too)
  const temp = `${file.slice(0, file.length - ext.length)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp${ext}`;
  try {
    // When `data` is a function, it writes content to the temporary name (ffmpeg outputs directly there)
    if (typeof data === 'function') await data(temp);
    else await fsPromises.writeFile(temp, data);
  } catch (error) {
    await fsPromises.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  // When the other process keeps reading (holding the file open for a few ms each time), renaming can
  // only land in the gap between its reads: retry multiple times, waiting randomly 5-25 ms each time
  // to desync from the reader's rhythm; up to ~1 second. A fixed 5-retry backoff (~0.3 s) was tested
  // to exhaust when faced with another process reading continuously.
  for (let attempt = 0; ; attempt++) {
    try { await fsPromises.rename(temp, file); return; }
    catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) {
        await fsPromises.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 20));
    }
  }
}

/** Matches the grid tile=4x2, exactly 8 cells per image; fewer frames ensure fast rendering */
export const GIF_FRAMES = 8;

/** 
 * Taking the midpoint of each segment avoids black frames occurring right at the start or end;
 * keeping 3 decimal places ensures multiple samplings of the same clip produce identical timestamps,
 * guaranteeing cache key stability.
 */
export function sampleTimes(clip, n = GIF_FRAMES) {
  const { start, end } = clip;
  if (end <= start) return [start];
  const times = [];
  const duration = end - start;
  for (let i = 0; i < n; i++) {
    times.push(Math.round((start + (i + 0.5) * duration / n) * 1000) / 1000);
  }
  return times;
}

/** 
 * Filter out undefined keys while keeping original array order, ensuring objects with identical
 * content but different key order format consistently.
 */
export function stableStringify(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => v === undefined ? 'null' : stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  const pairs = keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${pairs.join(',')}}`;
}

/** 
 * Hashing the stableStringify result ensures projects with identical content but different key
 * order hit the same cached GIF.
 */
export function specKey(project, clipId) {
  const str = stableStringify({ project, clipId });
  return crypto.createHash('sha1').update(str).digest('hex').substring(0, 16);
}

/** 
 * Randomly generate an AI visualization identifier with a v- prefix for easy distinction.
 */
export function newVisualId() {
  return 'v-' + crypto.randomBytes(8).toString('hex');
}

/** 
 * Validate whether a string is a valid AI visualization identifier to prevent injection.
 */
export function isVisualId(s) {
  return typeof s === 'string' && /^v-[0-9a-z]{6,40}$/.test(s);
}

/** 
 * Ensure file names are just a simple hash + image extension to prevent path traversal
 * attacks (such as ../).
 */
export function safeFileName(name) {
  if (typeof name !== 'string') return null;
  if (/^[0-9a-f]{16,40}\.(png|jpg|gif|webp)$/.test(name)) return name;
  return null;
}

/** 
 * Format numeric values for user-friendly display, truncating overly long strings and
 * prettifying decimals.
 */
export function formatValue(v) {
  if (v === undefined) return '(none)';
  let str;
  if (typeof v === 'string') {
    str = v;
  } else if (typeof v === 'number') {
    str = String(Number(v.toFixed(3)));
  } else {
    str = JSON.stringify(v);
    if (str === undefined) str = String(v);
  }
  if (str.length > 80) {
    str = str.substring(0, 80) + '…';
  }
  return str;
}

/** 
 * The fixed order arranges items in the UI by importance or conventional practice;
 * `parts` only outputs a single line because the parts tree is too large to fit the UI,
 * so it is replaced with a brief description.
 */
export function diffClips(before, after) {
  if (!before || !after) return [];
  const diffs = [];
  
  const topKeys = ['cardId', 'start', 'end', 'trackId', 'label', 'opacity', 'fadeIn', 'fadeOut'];
  for (const k of topKeys) {
    if (stableStringify(before[k]) !== stableStringify(after[k])) {
      diffs.push({ key: k, from: formatValue(before[k]), to: formatValue(after[k]) });
    }
  }

  const pBefore = before.params || {};
  const pAfter = after.params || {};
  const pKeys = Array.from(new Set([...Object.keys(pBefore), ...Object.keys(pAfter)])).sort();
  for (const k of pKeys) {
    if (stableStringify(pBefore[k]) !== stableStringify(pAfter[k])) {
      diffs.push({ key: `params.${k}`, from: formatValue(pBefore[k]), to: formatValue(pAfter[k]) });
    }
  }

  const fBefore = before.frame || {};
  const fAfter = after.frame || {};
  const fKeys = Array.from(new Set([...Object.keys(fBefore), ...Object.keys(fAfter)])).sort();
  for (const k of fKeys) {
    if (stableStringify(fBefore[k]) !== stableStringify(fAfter[k])) {
      diffs.push({ key: `frame.${k}`, from: formatValue(fBefore[k]), to: formatValue(fAfter[k]) });
    }
  }

  if (stableStringify(before.parts) !== stableStringify(after.parts)) {
    diffs.push({ key: 'parts', from: '(original parts)', to: '(parts changed)' });
  }

  return diffs;
}

/** 
 * Save as image from base64 content, named by content sha1 to prevent duplicate names
 * and repeated writes.
 */
export async function saveImage(dir, { mime, base64 }) {
  await fsPromises.mkdir(dir, { recursive: true });
  const buffer = Buffer.from(base64, 'base64');
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').substring(0, 20);
  let ext = 'png';
  if (mime === 'image/jpeg') ext = 'jpg';
  else if (mime === 'image/gif') ext = 'gif';
  else if (mime === 'image/webp') ext = 'webp';
  
  const name = `${hash}.${ext}`;
  const file = path.join(dir, name);
  try {
    await fsPromises.stat(file);
  } catch {
    await atomicWrite(file, buffer);
  }
  return { name, url: '/api/ai/visual/file/' + name };
}

/**
 * Write JSON after ensuring storage directory exists, encapsulating common operations.
 * Write to a temporary file first then rename (see `atomicWrite`): when another process reads
 * this spec / record concurrently, it either reads the complete old copy or the complete new copy.
 */
export async function writeJson(dir, name, data) {
  await atomicWrite(path.join(dir, name), JSON.stringify(data));
}

/** 
 * Returning null on read failure allows callers to treat "no record" and "corrupted file" as
 * the same case, avoiding try/catch everywhere.
 */
export async function readJson(dir, name) {
  try {
    const text = await fsPromises.readFile(path.join(dir, name), 'utf-8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 
 * spec only provides the file name without dir, because it is passed as the name parameter
 * to writeJson/readJson.
 */
export function gifPaths(dir, key) {
  return { 
    gif: path.join(dir, `gif-${key}.gif`), 
    grid: path.join(dir, `gif-${key}-grid.png`), 
    spec: `spec-${key}.json` 
  };
}

/**
 * Cards often occupy only a small portion of the 1920×1080 stage; each GIF in the before/after
 * comparison row in the chat panel is only around a hundred pixels wide, so scaling down the full
 * screen makes text unreadable. Therefore, GIFs only capture the region where this card appears
 * across 8 frames (taking the union: including paths traversed during entrance), adding margins,
 * and expanding to the stage's aspect ratio to avoid differing aspect ratios across GIFs.
 * Width is at least 1/4 of the stage (= GIF output width 480); never upscale however small the crop,
 * as upscaling only blurs. Returns null when frames have no transparent pixels (full screen is
 * opaque), are completely empty, or the crop covers almost the whole screen, encoding the full screen.
 */
export async function contentCrop(frames, { pad = 0.06, alphaMin = 8 } = {}) {
  const lib = await loadPng();
  if (!lib) return null;
  let W = 0, H = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (const buf of frames) {
    const png = lib.PNG.sync.read(buf);
    W = png.width; H = png.height;
    const d = png.data;
    for (let y = 0; y < H; y++) {
      const row = y * W * 4 + 3;
      for (let x = 0; x < W; x++) {
        if (d[row + x * 4] < alphaMin) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0 || !W || !H) return null;
  const aspect = W / H;
  const m = Math.round(pad * Math.min(W, H));
  let w = x1 - x0 + 1 + 2 * m;
  let h = y1 - y0 + 1 + 2 * m;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  if (w < W / 4) { w = W / 4; h = w / aspect; }
  if (w > W) { w = W; h = w / aspect; }
  if (h > H) { h = H; w = h * aspect; }
  w = Math.round(w / 2) * 2;
  h = Math.round(h / 2) * 2;
  if (w >= W * 0.95) return null;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const x = Math.round(clamp((x0 + x1) / 2 - w / 2, 0, W - w));
  const y = Math.round(clamp((y0 + y1) / 2 - h / 2, 0, H - h));
  return { x, y, w, h };
}

/**
 * Two passes of palettegen/paletteuse are used because GIFs only have 256 colors; generating the
 * palette before applying colors prevents blurring; writing to a temporary directory and deleting
 * in finally is because ffmpeg's %02d sequence input requires real files, and concurrent calls do
 * not interfere with each other. crop only crops user-facing GIFs; the grid passed to the Agent
 * remains full screen, as it needs to evaluate the card's position and composition in the frame.
 */
export async function encodeGif({ ffmpeg, frames, outGif, outGrid, width = 480, fps = 4, crop = null }) {
  const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'encode-gif-'));
  try {
    for (let i = 0; i < frames.length; i++) {
      const p = path.join(tmp, `f${String(i).padStart(2, '0')}.png`);
      await fsPromises.writeFile(p, frames[i]);
    }

    if (outGif) await fsPromises.mkdir(path.dirname(outGif), { recursive: true });
    if (outGrid) await fsPromises.mkdir(path.dirname(outGrid), { recursive: true });

    const runFfmpeg = (args) => {
      return new Promise((resolve, reject) => {
        const cp = child_process.spawn(ffmpeg, args, { cwd: tmp, windowsHide: true });
        let stderr = '';
        cp.stderr.on('data', d => stderr += d.toString());
        
        let timeoutId = setTimeout(() => {
          cp.kill('SIGKILL');
          reject(new Error(`Timeout: ` + stderr.slice(-300)));
        }, 60000);

        cp.on('error', err => {
          clearTimeout(timeoutId);
          reject(err);
        });

        cp.on('close', code => {
          clearTimeout(timeoutId);
          if (code !== 0) {
            reject(new Error(`Exit ${code}: ` + stderr.slice(-300)));
          } else {
            resolve();
          }
        });
      });
    };

    const argsGif = [
      '-y', '-framerate', String(fps), '-i', 'f%02d.png',
      '-vf', `${crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : ''}scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
    ];
    const argsGrid = [
      '-y', '-framerate', String(fps), '-i', 'f%02d.png',
      '-vf', `scale=${width}:-2,tile=4x2:padding=4:margin=4:color=0x111318`,
      '-frames:v', '1'
    ];
    // Grid first, then GIF; both are renamed into place via temporary names (#13): other processes
    // determine cache hits by "both gif and grid exist". gif appears last; seeing it indicates both are
    // fully written to disk, avoiding half-written files. ffmpeg's cwd is temp dir, outputs must be absolute.
    await atomicWrite(path.resolve(outGrid), temp => runFfmpeg([...argsGrid, temp]));
    await atomicWrite(path.resolve(outGif), temp => runFfmpeg([...argsGif, '-loop', '0', temp]));

    return { gif: outGif, grid: outGrid };
  } finally {
    await fsPromises.rm(tmp, { recursive: true, force: true });
  }
}

/** 
 * Trying winget's fixed path is because right after installing ffmpeg with winget, the PATH of
 * already running processes has not refreshed and might fail to find ffmpeg.
 */
export function findFfmpeg() {
  const cands = [];
  if (process.env.PROMPTCUT_FFMPEG) cands.push(process.env.PROMPTCUT_FFMPEG);
  cands.push('ffmpeg');
  if (process.env.LOCALAPPDATA) {
    cands.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build', 'bin', 'ffmpeg.exe'));
  }

  for (const cand of cands) {
    const res = child_process.spawnSync(cand, ['-version'], { timeout: 5000, windowsHide: true });
    if (res.status === 0 && !res.error) return cand;
  }
  return null;
}
