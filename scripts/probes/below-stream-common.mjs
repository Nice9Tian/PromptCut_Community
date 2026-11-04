/**
 * Shared elements for the two "below-dependent stream" probes (`below-diff-measure-probe.mjs`,
 * `stream-below-probe.mjs`): projects for the two scenes, asset video and the small service serving
 * it, dev server, and several algorithms for pasting stream back over lower layer and comparing.
 *
 * Scenes (acceptance check for "Wu-2" in `docs/plan/render-refactor-task.md`, section 13.2 "Lower
 * layer 2" of contract `docs/plan/prerender-products-contract.md`):
 *
 *   A  A frosted-glass card (odometer `odometer`, below-dependent in review table) placed over an
 *      animated card (particles `particles`) and a video clip;
 *   B  The lower layer is translucent: a pill (`punch-pill`) with opacity 0.6 and shadow, with
 *      nothing underneath (transparent), covered by the same frosted-glass card on top.
 *
 * The frosted-glass card enters from 0.2s (not on segment boundary), so there are several frames in
 * the first segment where it is not yet on the page.
 */
import '../lib/no-user-dirs.mjs'; // First import: a dev server will be started here, not inheriting external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DURATION = 3;
export const FPS = 30;
export const TARGET = 'clip-glass';
/** The card added on top of frosted-glass card when `edit: 'above'` */
export const ABOVE = 'clip-above';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round2 = (n) => (n === null || n === undefined || Number.isNaN(n) ? null : +Number(n).toFixed(2));
export const round3 = (n) => (n === null || n === undefined || Number.isNaN(n) ? null : +Number(n).toFixed(3));
export const median = (list) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Odometer is designed for 1920×1080: scales entire card proportionally on smaller aspect ratios */
const glassFrame = (width, height) => (width === 1920 && height === 1080 ? {} : { frame: { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: width / 1920 } });

/**
 * Scene project. `kind`: `'a'` (A) or `'b'` (B); `mediaUrl`: video URL for A.
 * When `edit`: `'below'`, changes one parameter of the card in lower layer (used to verify "key
 * changes when lower layer changes"); when `'above'`, adds an extra card on top of frosted-glass card
 * (used to verify "key never changes no matter how layers above are modified").
 */
export function scenarioProject(kind, { width, height, mediaUrl = '', edit = null } = {}) {
  const glass = { id: 'tr-glass', name: 'glass', hidden: false, clips: [
    { id: TARGET, kind: 'card', cardId: 'odometer', start: 0.2, end: DURATION, params: { position: 'left', value: 86420, label: '下层二探针' }, ...glassFrame(width, height) },
  ] };
  const base = { name: 'Below-dependent stream probe', width, height, fps: FPS, duration: DURATION, themeId: 'dark', filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {} };
  // Upper layer: a small pill in top-right corner, above frosted-glass card
  const above = edit === 'above' ? [{ id: 'tr-above', name: 'above', hidden: false, clips: [
    { id: ABOVE, kind: 'card', cardId: 'punch-pill', start: 0.5, end: 2, params: { text: '上面的层' },
      frame: { x: Math.round(width * 0.75), y: Math.round(height * 0.25), w: 1280, h: 720, anchor: [0.5, 0.5], scale: width / 1920 * 0.6 } },
  ] }] : [];
  if (kind === 'a') {
    return { ...base, id: `below-a-${width}x${height}`,
      media: [{ id: 'm-video', kind: 'video', name: 'below-probe.mp4', url: mediaUrl, duration: DURATION }],
      tracks: [
        ...above,
        glass,
        { id: 'tr-move', name: 'move', hidden: false, clips: [
          { id: 'clip-move', kind: 'card', cardId: 'particles', start: 0, end: DURATION, params: { color: edit === 'below' ? '#ff5a30' : '#30ff60', quantity: 120, speed: 1.5, size: 4, links: 'yes', seed: 3 } },
        ] },
        { id: 'tr-video', name: 'video', hidden: false, clips: [{ id: 'clip-video', mediaId: 'm-video', start: 0, end: DURATION, params: {} }] },
      ] };
  }
  return { ...base, id: `below-b-${width}x${height}`, media: [],
    tracks: [
      ...above,
      glass,
      { id: 'tr-block', name: 'block', hidden: false, clips: [
        { id: 'clip-block', kind: 'card', cardId: 'punch-pill', start: 0, end: DURATION, params: { text: edit === 'below' ? '半透明的下层(改过)' : '半透明的下层' },
          frame: { x: Math.round(width * 0.36), y: Math.round(height * 0.5), w: 1280, h: 720, anchor: [0.5, 0.5], scale: width / 1920 * 1.5 },
          opacity: 0.6, emphasis: { kind: 'shadow', color: '#000000', size: 36, opacity: 0.7, dx: 0, dy: 18 } },
      ] },
    ] };
}

/** Clips in scene other than the target card (all of which are its lower layer) */
export const lowerClipIds = (kind) => (kind === 'a' ? ['clip-move', 'clip-video'] : ['clip-block']);

export function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

/**
 * Start a dev server at checkout root (additionally taking +1 and +2 as stage ports). Returns
 * `{ origin, stop() }`; cleans up only this process tree started by itself
 */
export async function startDevServer({ port, dataDir, tag = 'below' }) {
  if ([5190, 5191, 5192].some((p) => p >= port && p <= port + 2)) throw new Error('This port range belongs to the user\'s resident dev servers; use another one');
  const log = [];
  const child = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, BROWSER: 'none', PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_DATA_DIR: dataDir, PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0',
      PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: `${tag}-${Date.now().toString(36)}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: `${tag}-probe` },
  });
  const keep = (c) => { log.push(c.toString()); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32') {
      await new Promise((resolve) => { const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); k.on('close', resolve); k.on('error', resolve); });
    } else child.kill('SIGKILL');
  };
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`dev server exited: ${log.join('').slice(-600)}`);
    if (await fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false)) break;
    if (Date.now() > deadline) { await stop(); throw new Error(`dev server did not start: ${log.join('').slice(-600)}`); }
    await sleep(300);
  }
  return { origin, pid: child.pid, stop };
}

/**
 * Video for A: ffmpeg test pattern (with clear edges and continuous motion), one for each aspect
 * ratio
 */
export async function ensureVideo(ffmpeg, dir, width, height) {
  const file = path.join(dir, `below-probe-${width}x${height}.mp4`);
  if (!fsSync.existsSync(file)) {
    await fs.mkdir(dir, { recursive: true });
    await execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${FPS}:duration=${DURATION + 1}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-crf', '18', '-movflags', '+faststart', file], { windowsHide: true });
  }
  return file;
}

/**
 * Small service serving asset files (recognizes Range, video must be scrubbable). Returns
 * `{ url(name), close() }`
 */
export function serveMedia(port, dir) {
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(String(req.url || '').split('?')[0]));
    const file = path.join(dir, name);
    if (!name || !fsSync.existsSync(file)) { res.writeHead(404).end(); return; }
    const size = fsSync.statSync(file).size;
    const head = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      fsSync.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...head, 'Content-Length': size });
    fsSync.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      url: (name) => `http://127.0.0.1:${port}/${encodeURIComponent(name)}`,
      close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
    }));
  });
}

/** Empty project URL for export page (written as `FramePipeline.emptyUrl`) */
export const emptyUrlOf = (origin, { width, height }) => `${origin}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify({ width, height, fps: FPS, duration: 1, tracks: [], media: [] }))}`)}`;

/**
 * ffmpeg decodes init + one segment into frame-by-frame RGB (vertically stitched encoded frame:
 * top half premultiplied color, bottom half opacity, each padded with 8 rows)
 */
export async function decodeSegment(ffmpeg, init, seg, dir, name) {
  const file = path.join(dir, `${name}.mp4`);
  await fs.writeFile(file, Buffer.concat([init, seg]));
  const { stdout } = await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1 << 30, windowsHide: true });
  await fs.rm(file, { force: true });
  return stdout;
}

/**
 * Error accumulator: compares the "pasted-back visuals" and "ground-truth visuals" pixel by pixel
 * (both in premultiplied color, full scale 255), calculated across all four channels together.
 * `mean`: average difference; `max`: maximum difference; `p999`: 99.9% of pixels do not exceed this
 * number; `bad`: number of pixels whose maximum channel difference exceeds `BAD`.
 */
export const BAD = 16;
export function newError() { return { sum: 0, count: 0, max: 0, bad: 0, hist: new Float64Array(256) }; }
export function errorSummary(e) {
  let p999 = 0, seen = 0;
  const pixels = e.count / 4;
  for (let v = 0; v < 256; v++) { seen += e.hist[v]; if (seen >= pixels * 0.999) { p999 = v; break; } }
  return { mean: round3(e.count ? e.sum / e.count : 0), max: round2(e.max), p999, bad: e.bad, pixels };
}
const tally = (e, d0, d1, d2, d3) => {
  d0 = d0 < 0 ? -d0 : d0; d1 = d1 < 0 ? -d1 : d1; d2 = d2 < 0 ? -d2 : d2; d3 = d3 < 0 ? -d3 : d3;
  e.sum += d0 + d1 + d2 + d3;
  e.count += 4;
  let m = d0 > d1 ? d0 : d1; if (d2 > m) m = d2; if (d3 > m) m = d3;
  if (m > e.max) e.max = m;
  if (m > BAD) e.bad++;
  e.hist[m >= 255 ? 255 : Math.round(m)]++;
};

/**
 * Overlays a layer S (straight RGBA, size of `rect`) onto `lower` (full frame, straight RGBA) using
 * standard blending, and compares with `truth` (full frame), comparing only inside `rect`.
 * `frameWidth`: width of full frame. Error is recorded into `e`.
 */
export function tallyStraight(e, layer, rect, lower, truth, frameWidth) {
  for (let y = 0; y < rect.h; y++) {
    let i = ((y + rect.y) * frameWidth + rect.x) * 4, o = y * rect.w * 4;
    for (let x = 0; x < rect.w; x++, i += 4, o += 4) {
      const a = layer[o + 3], keep = 1 - a / 255;
      const la = lower[i + 3], ta = truth[i + 3];
      tally(e,
        layer[o] * a / 255 + lower[i] * la / 255 * keep - truth[i] * ta / 255,
        layer[o + 1] * a / 255 + lower[i + 1] * la / 255 * keep - truth[i + 1] * ta / 255,
        layer[o + 2] * a / 255 + lower[i + 2] * la / 255 * keep - truth[i + 2] * ta / 255,
        a + la * keep - ta);
    }
  }
}

/**
 * Same as above, where S is the decoded encoded frame (`decoded`: RGB, width `rect.w`, top `rect.h`
 * rows are premultiplied color, followed by opacity after 8 rows of spacing). Clamped once following
 * the page shader (`src/render/streamPlayer.ts`): color does not exceed opacity.
 */
export function tallyDecoded(e, decoded, rect, lower, truth, frameWidth) {
  const alphaTop = (rect.h + 8) * rect.w * 3;
  for (let y = 0; y < rect.h; y++) {
    let i = ((y + rect.y) * frameWidth + rect.x) * 4, o = y * rect.w * 3;
    for (let x = 0; x < rect.w; x++, i += 4, o += 3) {
      const a = decoded[alphaTop + o], keep = 1 - a / 255;
      const la = lower[i + 3], ta = truth[i + 3];
      const c0 = decoded[o] < a ? decoded[o] : a, c1 = decoded[o + 1] < a ? decoded[o + 1] : a, c2 = decoded[o + 2] < a ? decoded[o + 2] : a;
      tally(e,
        c0 + lower[i] * la / 255 * keep - truth[i] * ta / 255,
        c1 + lower[i + 1] * la / 255 * keep - truth[i + 1] * ta / 255,
        c2 + lower[i + 2] * la / 255 * keep - truth[i + 2] * ta / 255,
        a + la * keep - ta);
    }
  }
}

/**
 * Error of encoding itself: decoded encoded frame is directly compared with `truth` (full frame,
 * straight RGBA) within `rect` (premultiplied color and opacity), without overlaying anything.
 * Encoding the ground-truth frame as-is and comparing this way yields "how much the same frame
 * differs after passing through this encoder", serving as an error reference.
 */
export function tallyDecodedDirect(e, decoded, rect, truth, frameWidth) {
  const alphaTop = (rect.h + 8) * rect.w * 3;
  for (let y = 0; y < rect.h; y++) {
    let i = ((y + rect.y) * frameWidth + rect.x) * 4, o = y * rect.w * 3;
    for (let x = 0; x < rect.w; x++, i += 4, o += 3) {
      const a = decoded[alphaTop + o], ta = truth[i + 3];
      tally(e,
        (decoded[o] < a ? decoded[o] : a) - truth[i] * ta / 255,
        (decoded[o + 1] < a ? decoded[o + 1] : a) - truth[i + 1] * ta / 255,
        (decoded[o + 2] < a ? decoded[o + 2] : a) - truth[i + 2] * ta / 255,
        a - ta);
    }
  }
}

/**
 * Crop out the visuals after overlaying a decoded frame back onto `lower` (straight RGBA, size of
 * `rect`), saving the image for visual inspection
 */
export function composeDecoded(decoded, rect, lower, frameWidth) {
  const out = Buffer.alloc(rect.w * rect.h * 4);
  const alphaTop = (rect.h + 8) * rect.w * 3;
  for (let y = 0; y < rect.h; y++) {
    let i = ((y + rect.y) * frameWidth + rect.x) * 4, o = y * rect.w * 3, p = y * rect.w * 4;
    for (let x = 0; x < rect.w; x++, i += 4, o += 3, p += 4) {
      const a = decoded[alphaTop + o], keep = 1 - a / 255, la = lower[i + 3];
      const oa = a + la * keep;
      for (let k = 0; k < 3; k++) {
        const c = Math.min(decoded[o + k], a) + lower[i + k] * la / 255 * keep;
        out[p + k] = oa > 0 ? Math.max(0, Math.min(255, Math.round(c / oa * 255))) : 0;
      }
      out[p + 3] = Math.max(0, Math.min(255, Math.round(oa)));
    }
  }
  return out;
}

/** Crop a region from a full straight RGBA frame */
export function cropRgba(data, frameWidth, rect) {
  const out = Buffer.alloc(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) data.copy(out, y * rect.w * 4, ((y + rect.y) * frameWidth + rect.x) * 4, ((y + rect.y) * frameWidth + rect.x + rect.w) * 4);
  return out;
}

/** Save straight RGBA over dark gray background as PNG (for human viewing) */
export async function savePreview(file, rgba, width, height) {
  const { PNG } = await import('pngjs');
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    const a = rgba[i + 3] / 255;
    png.data[i] = Math.round(rgba[i] * a + 40 * (1 - a));
    png.data[i + 1] = Math.round(rgba[i + 1] * a + 44 * (1 - a));
    png.data[i + 2] = Math.round(rgba[i + 2] * a + 52 * (1 - a));
    png.data[i + 3] = 255;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, PNG.sync.write(png));
}
