/**
 * Measure both complete desktop app export paths once each (render refactor "Xin"; measure only, no replacement).
 *
 *   node scripts/probes/export-paths-measure.mjs [--runs 3] [--projects demo,heavy] [--frames 0-59]
 *        [--workers auto] [--port 7460] [--work <dir>] [--json <summary-file>] [--assets <small-asset-dir>]
 *        [--no-split] [--keep] [--retries 3]
 *
 * Two paths (on the same machine, with the same project, run alternately: desktop, online, desktop,
 * online..., each for `--runs` passes, default 3):
 *
 *   desktop  Desktop app: Chrome (chrome-headless-shell) beginFrame full-frame screenshot -> ffmpeg
 *            encodes intermediate ProRes 4444 file with transparency -> composite with assets,
 *            libx264 encodes preview.mp4 (`server/bakery/export.mjs`, `export-unified.mjs`,
 *            `server/export-compose.mjs`). Follows the same approach as `/api/export`
 *            (`server/vite-plugin-export.ts`): launches `scripts/export-frames.mjs` with identical
 *            parameters; the probe launches it directly, timestamps each line of output, and
 *            segments by line.
 *   online   Online browser: wraps whole scene snapshot into SVG, draws to canvas -> converts to
 *            YUV -> WebCodecs encodes -> muxes MP4 directly (`src/export/browserExport.ts`,
 *            `frameCompositor.ts`). Entry point is the existing probe hook in desktop runtime
 *            `window.__pcIo.exportVideoBrowser`, no flag required. Segment durations are measured
 *            by a timing shim on the probe side (installed in page, wrapping methods of
 *            ExportCompositor / Mp4Muxer / VideoEncoder / VideoFrame / getImageData without
 *            modifying production code).
 *
 * Two projects (fixture recipes in `scripts/probes/fixtures/export-paths/projects.mjs`):
 *   demo   Demo project for pixel baseline; heavy  Project with heavy cards (WebGL) and canvas cards (particles).
 *
 * Records for each project:
 *   - Total duration and per-segment durations for each pass of each path, final video size and
 *     bitrate, full-machine CPU usage before running, and average usage during the run;
 *   - Whether passes of the same path yield identical final videos frame-by-frame (decodes final
 *     video to rgb24, compares sha1 frame-by-frame);
 *   - Frame-by-frame visual differences between final videos of both paths (mean difference 0-255,
 *     max channel difference, ratio of pixels differing by > 8 and 32, PSNR); captures select frames
 *     to save "desktop | online | diff×8" comparison images;
 *   - Isolated segment tests (one desktop pass, excluded from total duration): screenshot only
 *     without encoding (PNG), encode PNG to ProRes, decode ProRes, decode ProRes plus libx264.
 *     Used to cross-check segments split from logs in the main flow (default path writes PNG first
 *     and encodes ProRes after capturing; only --workers 1 full segments capture and encode
 *     concurrently, when the two cannot be separated);
 *   - Machine configuration: CPU, core count, memory, GPU, OS, Chrome version.
 * Summary is written as a JSON file (`--json`, default in work directory), with the last line also
 * printed to stdout. Non-zero exit code on export failure, missing frames, unreadable final video, etc.
 *
 * Spawns a dev server (three consecutive ports starting at `--port`, default 7460); export
 * directory and asset directory point to work directory, leaving user directories and ports untouched.
 * Work directory defaults to `out/export-paths-measure/<timestamp>` (not stored); `--keep` retains
 * intermediate files (ProRes, frame-by-frame PNG), cleaned up by default.
 * Duration may be affected when the machine is running other tasks concurrently: the probe measures
 * normally and records usage faithfully; rerun when the machine is idle to obtain official numbers.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external export directory or data directory
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { REPO, startDevServer, killTree, sleep, stamp } from '../lib/dev-server.mjs';
import { assertNoUserExportDir } from '../lib/user-dirs.mjs';
import { findFfmpeg, ffprobeOf } from '../../server/bakery/ffmpeg.mjs';
import { expectedHeadlessShellVersion } from '../../server/bakery/chrome.mjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { PROJECTS, FIXTURE_VIDEO } from './fixtures/export-paths/projects.mjs';

/* ---------------- Parameters ---------------- */

function parseArgs(argv) {
  const o = { runs: 3, projects: ['demo', 'heavy'], frames: null, workers: 'auto', port: 7460, work: null, json: null, assets: null, split: true, keep: false, retries: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} must be followed by a value`); return argv[++i]; };
    if (a === '--runs') o.runs = Math.max(1, Math.floor(Number(next())));
    else if (a === '--projects') o.projects = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--frames') o.frames = next();
    else if (a === '--workers') o.workers = next();
    else if (a === '--port') o.port = Number(next());
    else if (a === '--work') o.work = path.resolve(next());
    else if (a === '--json') o.json = path.resolve(next());
    else if (a === '--assets') o.assets = path.resolve(next());
    else if (a === '--no-split') o.split = false;
    else if (a === '--keep') o.keep = true;
    else if (a === '--retries') o.retries = Math.max(1, Math.floor(Number(next())));
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  for (const p of o.projects) if (!PROJECTS[p]) throw new Error(`No such project ${p} (available: ${Object.keys(PROJECTS).join(', ')})`);
  if (!Number.isInteger(o.runs) || o.runs < 1) throw new Error('--runs must be a positive integer');
  if (o.frames && !/^\d+-\d+$/.test(o.frames)) throw new Error('--frames must be written as a-b');
  return o;
}

const log = (m) => console.error(`[export-paths] ${m}`);
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => { const s = xs.filter(Number.isFinite); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };

/* ---------------- Machine and usage ---------------- */

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; }
  return { idle, total };
}
const cpuBusy = (a, b) => { const dt = b.total - a.total; return dt > 0 ? round((1 - (b.idle - a.idle) / dt) * 100, 1) : null; };

/** Measure full-machine CPU usage for 1s before run; also note counts of process types (quick glance at what else is running) */
async function loadBefore() {
  const a = cpuTimes();
  await sleep(1000);
  const cpu = cpuBusy(a, cpuTimes());
  let procs = null;
  try {
    const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const names = String(r.stdout || '').split(/\r?\n/).map((l) => (l.match(/^"([^"]+)"/) || [])[1]?.toLowerCase()).filter(Boolean);
    const count = (re) => names.filter((n) => re.test(n)).length;
    procs = { node: count(/^node\.exe$/), chrome: count(/^chrome(-headless-shell)?\.exe$/), ffmpeg: count(/^ffmpeg\.exe$/), python: count(/^python/) };
  } catch { /* Do not record if unreadable */ }
  return { cpuPct: cpu, freeMemGB: round(os.freemem() / 2 ** 30, 1), procs };
}

/** Sample full-machine usage every 500 ms during the run */
function startCpuSampler() {
  const samples = [];
  let last = cpuTimes();
  const t = setInterval(() => { const now = cpuTimes(); const v = cpuBusy(last, now); if (v !== null) samples.push(v); last = now; }, 500);
  return () => { clearInterval(t); return { meanPct: round(mean(samples), 1), maxPct: samples.length ? Math.max(...samples) : null, samples: samples.length }; };
}

function psJson(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `${cmd} | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  try { return JSON.parse(String(r.stdout)); } catch { return null; }
}

async function machineInfo({ ffmpeg, onlineChrome }) {
  const cpus = os.cpus();
  const gpu = process.platform === 'win32' ? psJson('Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion') : null;
  const ff = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true });
  return {
    cpu: cpus[0]?.model?.trim(), logicalCores: cpus.length, ramGB: round(os.totalmem() / 2 ** 30, 1),
    gpu: gpu ? [].concat(gpu).map((g) => `${g.Name} (driver ${g.DriverVersion})`) : null,
    os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version,
    ffmpeg: String(ff.stdout || '').split(/\r?\n/)[0] || null,
    onlineChrome, desktopChromeHeadlessShell: await expectedHeadlessShellVersion(),
    puppeteer: (await import('puppeteer/package.json', { with: { type: 'json' } }).catch(() => ({ default: {} }))).default.version ?? null,
  };
}

/** Check for visible terminal, console, node, chrome, ffmpeg windows (troubleshoot dialog popups); checked before and after probe */
function visibleWindows() {
  if (process.platform !== 'win32') return [];
  const r = psJson("Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'WindowsTerminal|OpenConsole|cmd|powershell|conhost|node|chrome|ffmpeg' } | Select-Object Id,ProcessName,MainWindowTitle");
  return r ? [].concat(r).map((w) => `${w.Id} ${w.ProcessName} ${w.MainWindowTitle}`) : [];
}

/* ---------------- ffmpeg utilities ---------------- */

function runSync(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'buffer', windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exit code ${r.status}: ${String(r.stderr).slice(-500)}`);
  return r.stdout;
}

/** Spawn an external command, wait for it to exit, and return wall-clock ms; output discarded */
function timeProc(cmd, args) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      code === 0 ? resolve(ms) : reject(new Error(`${path.basename(cmd)} exit code ${code}: ${err}`));
    });
  });
}

function probeVideo(ffprobe, file) {
  const j = JSON.parse(String(runSync(ffprobe, ['-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_type,codec_name,profile,width,height,pix_fmt,nb_read_frames,duration,bit_rate,r_frame_rate,color_range,color_space,color_primaries,color_transfer:format=duration,size,bit_rate',
    '-of', 'json', file])));
  const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
  const bytes = Number(j.format?.size) || fs.statSync(file).size;
  const dur = Number(j.format?.duration) || Number(v.duration) || null;
  return {
    bytes, durationSec: dur ? round(dur, 3) : null,
    bitrateKbps: dur ? round((bytes * 8) / dur / 1000, 0) : null,
    codec: v.codec_name, profile: v.profile, pixFmt: v.pix_fmt, width: v.width, height: v.height,
    frames: Number(v.nb_read_frames) || null, fps: v.r_frame_rate,
    color: { range: v.color_range ?? null, space: v.color_space ?? null, primaries: v.color_primaries ?? null, transfer: v.color_transfer ?? null },
    audioStreams: (j.streams || []).filter((s) => s.codec_type === 'audio').length,
  };
}

/** Decode final video to rgb24, yielding a Buffer for each frame */
async function* frameStream(ffmpeg, file, w, h) {
  const p = spawn(ffmpeg, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let err = '';
  p.stderr.on('data', (d) => { err = (err + d).slice(-1000); });
  const size = w * h * 3;
  let pending = [], have = 0;
  const closed = new Promise((resolve) => p.on('close', resolve));
  for await (const chunk of p.stdout) {
    pending.push(chunk); have += chunk.length;
    while (have >= size) {
      const all = pending.length === 1 ? pending[0] : Buffer.concat(pending);
      yield all.subarray(0, size);
      const rest = all.subarray(size);
      pending = rest.length ? [rest] : []; have = rest.length;
    }
  }
  const code = await closed;
  if (code !== 0) throw new Error(`Decoding ${path.basename(file)} failed (ffmpeg ${code}): ${err}`);
}

async function frameHashes(ffmpeg, file, w, h) {
  const hashes = [];
  for await (const f of frameStream(ffmpeg, file, w, h)) hashes.push(crypto.createHash('sha1').update(f).digest('hex').slice(0, 16));
  return hashes;
}

/** Frame-by-frame comparison across passes of the same path: compared against pass 1 */
async function sameRoute(runs, ffmpeg, w, h) {
  const base = runs[0];
  const out = [];
  for (const r of runs.slice(1)) {
    const n = Math.min(base.frameHashes.length, r.frameHashes.length);
    let diff = 0, first = null;
    for (let i = 0; i < n; i++) if (base.frameHashes[i] !== r.frameHashes[i]) { diff++; first ??= i; }
    const rec = { run: r.k, vsRun: base.k, frames: n, frameCountEqual: base.frameHashes.length === r.frameHashes.length, identicalFrames: n - diff, differentFrames: diff, firstDifferentFrame: first, fileSha256Equal: base.fileSha256 === r.fileSha256 };
    // When frames differ, measure difference magnitude (mean difference, max channel difference,
    // ratio of pixels differing by > 32) to distinguish last-digit anti-aliasing from genuinely differing frames
    if (diff) { const per = (await crossDiff(ffmpeg, base.file, r.file, w, h)).filter((q) => base.frameHashes[q.i] !== r.frameHashes[q.i]); rec.magnitudeOfDifferentFrames = per.length ? { meanAbsDiffMean: round(mean(per.map((q) => q.mean)), 3), maxChannelDiff: Math.max(...per.map((q) => q.max)), fracOver32MaxPct: round(Math.max(...per.map((q) => q.over32)) * 100, 3), worstFrame: per.reduce((x, y) => (y.mean > x.mean ? y : x)).i } : null; }
    out.push(rec);
  }
  return out;
}

/** Frame-by-frame visual differences between final videos of both paths */
export async function crossDiff(ffmpeg, fileA, fileB, w, h) {
  const per = [];
  const a = frameStream(ffmpeg, fileA, w, h), b = frameStream(ffmpeg, fileB, w, h);
  const px = w * h;
  for (let i = 0; ; i++) {
    const [ra, rb] = await Promise.all([a.next(), b.next()]);
    if (ra.done || rb.done) {
      // Drain unread side as well to avoid leaving ffmpeg subprocess hanging
      if (!ra.done) for await (const _ of a) { /* drain */ }
      if (!rb.done) for await (const _ of b) { /* drain */ }
      break;
    }
    const A = ra.value, B = rb.value;
    let sum = 0, sq = 0, max = 0, o8 = 0, o32 = 0;
    for (let p = 0, j = 0; p < px; p++, j += 3) {
      const d0 = Math.abs(A[j] - B[j]), d1 = Math.abs(A[j + 1] - B[j + 1]), d2 = Math.abs(A[j + 2] - B[j + 2]);
      sum += d0 + d1 + d2; sq += d0 * d0 + d1 * d1 + d2 * d2;
      const m = d0 > d1 ? (d0 > d2 ? d0 : d2) : (d1 > d2 ? d1 : d2);
      if (m > max) max = m;
      if (m > 8) o8++;
      if (m > 32) o32++;
    }
    const mse = sq / (px * 3);
    per.push({ i, mean: sum / (px * 3), max, over8: o8 / px, over32: o32 / px, psnr: mse ? 10 * Math.log10((255 * 255) / mse) : 99 });
  }
  return per;
}

export function summarizeDiff(per, framesA, framesB) {
  if (!per.length) return { frames: 0 };
  const worst = per.reduce((x, y) => (y.mean > x.mean ? y : x));
  const sortedMean = per.map((p) => p.mean).sort((x, y) => x - y);
  return {
    framesCompared: per.length, framesA, framesB, frameCountEqual: framesA === framesB,
    meanAbsDiff: round(mean(per.map((p) => p.mean)), 3), medianMeanAbsDiff: round(sortedMean[sortedMean.length >> 1], 3),
    maxChannelDiff: Math.max(...per.map((p) => p.max)),
    fracPixelsOver8: round(mean(per.map((p) => p.over8)) * 100, 3), fracPixelsOver32: round(mean(per.map((p) => p.over32)) * 100, 3),
    worstFrameFracOver32: round(Math.max(...per.map((p) => p.over32)) * 100, 3),
    meanPsnr: round(mean(per.map((p) => p.psnr)), 2), minPsnr: round(Math.min(...per.map((p) => p.psnr)), 2),
    worstFrame: { i: worst.i, meanAbsDiff: round(worst.mean, 3), maxChannelDiff: worst.max, fracOver32: round(worst.over32 * 100, 3) },
  };
}

/** Sample select frames to save "desktop | online | |diff|×8" comparison images */
async function saveDiffTiles(ffmpeg, fileA, fileB, w, h, frames, dir, prefix) {
  const PW = 400, PH = Math.round((400 * h) / w);
  const files = [];
  for (const i of frames) {
    const grab = (file) => runSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${i}),scale=${PW}:${PH}:flags=area`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const A = grab(fileA), B = grab(fileB);
    if (A.length < PW * PH * 3 || B.length < PW * PH * 3) continue;
    const png = new PNG({ width: PW * 3 + 8, height: PH });
    png.data.fill(255);
    for (let y = 0; y < PH; y++) {
      for (let x = 0; x < PW; x++) {
        const s = (y * PW + x) * 3;
        for (const [panel, buf] of [[0, A], [1, B]]) {
          const d = (y * png.width + panel * (PW + 4) + x) * 4;
          png.data[d] = buf[s]; png.data[d + 1] = buf[s + 1]; png.data[d + 2] = buf[s + 2]; png.data[d + 3] = 255;
        }
        const d = (y * png.width + 2 * (PW + 4) + x) * 4;
        for (let c = 0; c < 3; c++) png.data[d + c] = Math.min(255, Math.abs(A[s + c] - B[s + c]) * 8);
        png.data[d + 3] = 255;
      }
    }
    const file = path.join(dir, `${prefix}-f${String(i).padStart(3, '0')}.png`);
    await fsp.writeFile(file, PNG.sync.write(png, { colorType: 2, deflateLevel: 9 }));
    files.push({ frame: i, file, bytes: fs.statSync(file).size });
  }
  return files;
}

/* ---------------- Build project (using store actions in editor page) ---------------- */

async function buildProject(page, spec, mediaFile) {
  const bytes = await fsp.readFile(mediaFile);
  return page.evaluate(async (spec, b64, fixtureName) => {
    const { actions, getState } = await import('/src/store/project.ts');
    const { createEmptyProject } = await import('/src/kernel/project.ts');
    const base = createEmptyProject(spec.name);
    actions.loadProject({ ...base, width: spec.width, height: spec.height, fps: spec.fps, duration: spec.duration, tracks: [] });
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const io = await import('/src/editor/io/index.ts');
    await io.importVideoFiles([new File([arr], `${spec.name}-${fixtureName}`, { type: 'video/mp4' })]);
    for (let i = 0; i < 150 && getState().project.media.some((m) => m.pending || !m.url); i++) await new Promise((r) => setTimeout(r, 200));
    const media = getState().project.media[0];
    if (!media || media.pending || !media.url) throw new Error('The media import did not finish');
    // After import, asset service still remuxes and generates small size (ffmpeg) in the background:
    // wait for them to finish before proceeding, avoiding CPU contention with the first measurement pass
    for (let i = 0; i < 300 && !getState().project.media[0]?.tiers?.small; i++) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 1500));
    // Import may have placed a media clip on its own: clear it first, then place according to recipe
    const p0 = getState().project;
    actions.loadProject({ ...p0, tracks: [], width: spec.width, height: spec.height, fps: spec.fps, duration: spec.duration });
    const added = [];
    for (const layer of spec.layers) {
      let clip;
      if (layer.media) {
        clip = actions.addClipOnNewTrack({ index: 0, mediaId: getState().project.media[0].id, start: layer.start, duration: layer.end - layer.start });
      } else {
        clip = actions.addClipOnNewTrack({ index: 0, cardId: layer.cardId, start: layer.start, duration: layer.end - layer.start });
        if (clip && layer.params) actions.setClipParams(clip.id, layer.params);
      }
      if (!clip) throw new Error(`Could not place clip ${layer.cardId || 'media'}`);
      added.push(layer.cardId || 'media');
    }
    const p = getState().project;
    if (p.width !== spec.width || p.height !== spec.height || p.fps !== spec.fps || Math.abs(p.duration - spec.duration) > 1e-6) {
      actions.loadProject({ ...p, width: spec.width, height: spec.height, fps: spec.fps, duration: spec.duration });
    }
    const out = getState().project;
    return { project: JSON.parse(JSON.stringify(out)), layers: added };
  }, spec, bytes.toString('base64'), FIXTURE_VIDEO.name);
}

/** Following `normalizeExportMedia` (server/vite-plugin-export.ts): hashed asset URLs are written as /@media/<hash> */
function exportJsonOf(project) {
  const p = JSON.parse(JSON.stringify(project));
  for (const m of p.media || []) {
    const hash = m.hash || m.tiers?.original;
    if (hash) m.url = `/@media/${hash}`;
  }
  return p;
}

/* ---------------- Desktop path ---------------- */

const T = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

async function runDesktop({ origin, work, id, project, frames, workers, keepFrames, noVideo = false }) {
  const dir = path.join(work, `export-${id}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(exportJsonOf(project), null, 2));
  const url = `${origin}/?export=1&timeline=/@export/${id}/project.json`;
  const args = [path.join(REPO, 'scripts', 'export-frames.mjs'), '--url', url, '--out', dir, '--workers', String(workers)];
  if (frames) args.push('--frames', frames);
  if (noVideo) args.push('--no-video');
  const marks = [];
  const t0 = process.hrtime.bigint();
  const cpuStop = startCpuSampler();
  const child = spawn(process.execPath, args, { cwd: REPO, env: { ...process.env, PROMPTCUT_EXPORT_DIR: work }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let tail = '';
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream.on('data', (chunk) => {
      const at = T(t0);
      const lines = (rest + chunk.toString()).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) { marks.push({ t: at, line }); tail = (tail + line + '\n').slice(-3000); }
    });
    stream.on('end', () => { if (rest) marks.push({ t: T(t0), line: rest }); });
  }
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const wallMs = T(t0);
  const cpu = cpuStop();
  if (code !== 0) throw new Error(`Desktop export exit code ${code}: ${tail.slice(-1500)}`);

  const first = (re) => marks.find((m) => re.test(m.line));
  const last = (re) => [...marks].reverse().find((m) => re.test(m.line));
  const frameMarks = marks.filter((m) => /^Exported frame \d+ \(\d+\/\d+\)/.test(m.line));
  const shardLine = first(/^Sharded export:/);
  const shards = shardLine ? (shardLine.line.match(/(\d+) segments/) || [])[1] : '1';
  const tFirstFrame = frameMarks[0]?.t ?? null;
  const tLastFrame = frameMarks.at(-1)?.t ?? null;
  const tRunning = first(/^Running ffmpeg to generate video files/)?.t ?? null;
  const tCreating = first(/^Creating preview\.mp4/)?.t ?? null;
  const composed = last(/^Composited \d+ frames in [\d.]+s/);
  const tComposedEnd = composed?.t ?? null;
  const composedSec = composed ? Number(composed.line.match(/in ([\d.]+)s/)[1]) : null;
    // Default (workers=auto) full-segment export: writes each frame PNG into frames/ first;
    // after capture, runs a pass of ffmpeg to encode PNGs into ProRes (log contains "Creating overlay.mov...");
  // Only in "single process and full segment" mode (--workers 1 without --frames) does it stream PNG
  // to ffmpeg to encode ProRes while capturing (log lacks this line); in that case capture and ProRes
  // run concurrently and cannot be separated
  const tOverlay = first(/^Creating overlay\.mov/)?.t ?? null;
  const proresMode = noVideo ? null : (tOverlay !== null ? 'png-files-then-encode' : 'streamed-during-capture');
  const segments = noVideo ? { startupToFirstFrameMs: tFirstFrame, captureMs: tFirstFrame !== null && tLastFrame !== null ? tLastFrame - tFirstFrame : null } : {
    // Process starts -> first frame captured (includes Node startup, launching Chrome, page load, warmup)
    startupToFirstFrameMs: tFirstFrame,
    // First frame -> last frame: capture (including writing PNGs).
    // Under streamed mode, this also includes concurrent ProRes encoding
    captureMs: tFirstFrame !== null && tLastFrame !== null ? tLastFrame - tFirstFrame : null,
    // Last frame -> "Running ffmpeg": capture finalization, (merging shards when multiple shards)
    captureEndToFfmpegMs: tRunning !== null && tLastFrame !== null ? tRunning - tLastFrame : null,
    // PNG -> ProRes 4444 intermediate file (only in png-files-then-encode mode):
    // "Creating overlay.mov" -> "Creating preview.mp4"
    proresEncodeMs: tOverlay !== null && tCreating !== null ? tCreating - tOverlay : null,
    // "Creating preview.mp4" -> "Composited N frames": one pass of ffmpeg, decodes ProRes +
    // overlays asset layers (assets already in Chrome screenshot in default path, 0 layers here) +
    // libx264 encoding, inseparable
    composeAndX264Ms: composedSec !== null ? composedSec * 1000 : (tComposedEnd !== null && tCreating !== null ? tComposedEnd - tCreating : null),
    // Composition finishes -> process exits: audio mixing (virtually 0 if no audio), finalization
    afterComposeMs: tComposedEnd !== null ? wallMs - tComposedEnd : null,
  };
  const out = path.join(dir, 'preview.mp4');
  return { dir, out, wallMs, cpu, shards: Number(shards), proresMode, segments, sizes: {
    overlayMovBytes: fs.existsSync(path.join(dir, 'overlay.mov')) ? fs.statSync(path.join(dir, 'overlay.mov')).size : null,
  }, marks: marks.map((m) => ({ t: round(m.t, 0), line: m.line })).filter((m) => /^(Shard|Warm-up|Export finished|Running ffmpeg|Creating|Composited \d+ frames|No audio|Audio muxed|Video synthesis|Launching|Navigating|Waiting for)/.test(m.line)).slice(0, 40), frameLines: frameMarks.length };
}

/* ---------------- Online path ---------------- */

/** Install timing shim in page: wraps several methods to record time without modifying production code. Calls outside top window (export page iframe) are excluded */
async function installShim(page) {
  await page.evaluate(async () => {
    const now = () => performance.now();
    const M = window.__pcM = { frames: 0, frameMs: 0, openMs: 0, getImageDataMs: 0, yuvMs: 0, encodeMs: 0, encodeCalls: 0, flushMs: 0, muxMs: 0, queueWaitMs: 0, tOpenStart: null, tOpenEnd: null, tFirstGetImage: null, tLastFrameEnd: null, tFlushEnd: null, tGid: null, tCap: null, chunks: 0 };
    const { ExportCompositor } = await import('/src/export/frameCompositor.ts');
    const { Mp4Muxer } = await import('/src/export/mp4Mux.ts');

    const open = ExportCompositor.open.bind(ExportCompositor);
    ExportCompositor.open = async (o) => { const t = now(); M.tOpenStart = t; try { return await open(o); } finally { M.tOpenEnd = now(); M.openMs += M.tOpenEnd - t; } };
    const frame = ExportCompositor.prototype.frame;
    ExportCompositor.prototype.frame = async function (i) {
      const t = now();
      try { return await frame.call(this, i); } finally { M.tLastFrameEnd = now(); M.frameMs += M.tLastFrameEnd - t; M.frames++; }
    };
    const gid = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...a) {
      if (window.top !== window) return gid.apply(this, a);
      const t = now();
      if (M.tLastFrameEnd !== null) { M.queueWaitMs += t - M.tLastFrameEnd; M.tLastFrameEnd = null; }
      if (M.tFirstGetImage === null) M.tFirstGetImage = t;
      try { return gid.apply(this, a); } finally { M.tGid = now(); M.getImageDataMs += M.tGid - t; }
    };
    const RealVF = window.VideoFrame;
    window.VideoFrame = new Proxy(RealVF, { construct(target, args, nt) { if (M.tGid !== null) { M.yuvMs += now() - M.tGid; M.tGid = null; } return Reflect.construct(target, args, nt); } });
    const enc = VideoEncoder.prototype.encode;
    VideoEncoder.prototype.encode = function (...a) { const t = now(); try { return enc.apply(this, a); } finally { M.encodeMs += now() - t; M.encodeCalls++; } };
    const flush = VideoEncoder.prototype.flush;
    VideoEncoder.prototype.flush = async function (...a) { const t = now(); try { return await flush.apply(this, a); } finally { M.tFlushEnd = now(); M.flushMs += M.tFlushEnd - t; } };
    const timed = (name) => {
      const f = Mp4Muxer.prototype[name];
      Mp4Muxer.prototype[name] = function (...a) {
        const t = now();
        const r = f.apply(this, a);
        if (r && typeof r.then === 'function') return r.then((v) => { M.muxMs += now() - t; return v; });
        M.muxMs += now() - t; if (name === 'addVideoChunk') M.chunks++;
        return r;
      };
    };
    for (const n of ['addVideoChunk', 'addAudioChunk', 'finalize']) if (typeof Mp4Muxer.prototype[n] === 'function') timed(n);
    const ics = VideoEncoder.isConfigSupported.bind(VideoEncoder);
    VideoEncoder.isConfigSupported = (...a) => { if (M.tCap === null) M.tCap = now(); return ics(...a); };
  });
}

async function runOnline({ browser, origin, project, frames, outFile }) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1600, height: 1000 });
    page.on('pageerror', (e) => log(`Page error: ${String(e).slice(0, 200)}`));
    await page.goto(`${origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(async () => !!(await import('/src/editor/stageBridge.ts')).frontStage(), { timeout: 180000, polling: 500 });
    await page.evaluate(async (p) => { const { actions } = await import('/src/store/project.ts'); actions.loadProject(p); }, project);
    await installShim(page);
    const maxFrames = frames ? Number(frames.split('-')[1]) + 1 : undefined;
    const cpuStop = startCpuSampler();
    const t0 = process.hrtime.bigint();
    const r = await page.evaluate(async (n) => {
      window.__pcM.tCall = performance.now();
      const res = await window.__pcIo.exportVideoBrowser({ maxFrames: n });
      window.__pcM.tReturn = performance.now();
      return res;
    }, maxFrames);
    const evalWallMs = T(t0);
    const cpu = cpuStop();
    if (!r.result) throw new Error(`Online export failed: ${r.error || 'no result'}${r.waits?.length ? '; wait hints: ' + r.waits.join('|').slice(0, 200) : ''}`);
    await fsp.writeFile(outFile, Buffer.from(r.base64, 'base64'));
    const M = await page.evaluate(() => window.__pcM);
    const total = r.result.ms;
    const st = r.result.stats || {};
    // Segments measured by shim: all wall-clock on main thread. Encoder itself runs in another browser
    // thread and overlaps with frame rendering; only the "waiting for it" part is visible
    const startupBeforeOpen = M.tOpenStart !== null && M.tCall !== undefined ? M.tOpenStart - M.tCall : null;
    const segments = {
      startupBeforeOpenMs: startupBeforeOpen, // Before export: capability check, pre-export verification
      openExportPageMs: M.openMs,             // Open same-origin export page, inject project, wait until ready
      stepMs: st.stepMs,                      // Visuals: advance to this frame (including warmup for first frame)
      snapshotMs: st.snapshotMs,              // Visuals: generate whole scene snapshot
      mediaMs: st.mediaMs,                    // Visuals: mount asset frame, render into image, and replace into snapshot
      rasterMs: st.rasterMs,                  // Visuals: wrap snapshot as SVG and draw to canvas
      getImageDataMs: M.getImageDataMs,       // Read pixels
      toYuvMs: M.yuvMs,                       // Convert RGBA to I420
      encodeSubmitMs: M.encodeMs,             // VideoEncoder.encode() call itself
      waitEncodeQueueMs: M.queueWaitMs,       // Wait for available slot in encoding queue (only when encoder is slower than frame rendering)
      flushMs: M.flushMs,                     // Wait for encoder to finish outputting after all frames are submitted
      muxMs: M.muxMs,                         // Muxing (writing boxes chunk by chunk + finalize)
    };
    const known = Object.values(segments).reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0);
    segments.otherMs = total - known;          // Remainder: inter-frame overhead (between onProgress and await), shim error
    return { totalMs: total, evalWallMs, cpu, frames: r.result.frames, bytes: r.result.bytes, videoCodec: r.result.videoCodec, audio: r.result.audio,
      segments, frameStats: { frames: st.frames, heavyReplaced: st.heavyReplaced, mediaFrames: st.mediaFrames, manualTicks: st.manualTicks, rafFallbacks: st.rafFallbacks }, chunks: M.chunks };
  } finally {
    await page.close().catch(() => {});
  }
}

/* ---------------- Summary ---------------- */

function segStats(runs, pick) {
  const keys = new Set(runs.flatMap((r) => Object.keys(pick(r) || {})));
  const out = {};
  for (const k of keys) {
    const xs = runs.map((r) => pick(r)?.[k]).filter(Number.isFinite);
    out[k] = xs.length ? { median: round(median(xs), 0), min: round(Math.min(...xs), 0), max: round(Math.max(...xs), 0) } : null;
  }
  return out;
}
const walls = (runs, f) => { const xs = runs.map(f).filter(Number.isFinite); return xs.length ? { median: round(median(xs), 0), min: round(Math.min(...xs), 0), max: round(Math.max(...xs), 0), spreadPct: round(((Math.max(...xs) - Math.min(...xs)) / median(xs)) * 100, 1) } : null; };

/* ---------------- Main workflow ---------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(fs.readFileSync(import.meta.filename, 'utf8').split('*/')[0]); return 0; }
  const work = opts.work || path.join(REPO, 'out', 'export-paths-measure', stamp());
  assertNoUserExportDir({ PROMPTCUT_EXPORT_DIR: work }, 'working directory of export-paths-measure');
  await fsp.mkdir(work, { recursive: true });
  const jsonFile = opts.json || path.join(work, 'summary.json');
  const assetsDir = opts.assets || path.join(work, 'assets');
  await fsp.mkdir(assetsDir, { recursive: true });
  log(`Working directory ${work}`);

  const ffmpeg = await findFfmpeg();
  const ffprobe = ffprobeOf(ffmpeg);
  const failures = [];
  const windowsBefore = visibleWindows();
  const result = { ok: false, probe: 'export-paths-measure', startedAt: new Date().toISOString(), argv: process.argv.slice(2), work, options: { runs: opts.runs, projects: opts.projects, frames: opts.frames, workers: opts.workers, split: opts.split }, projects: {}, failures };

  // Asset: 320x180 testsrc2, no audio (fixture with the same pixel baseline)
  const mediaFile = path.join(work, FIXTURE_VIDEO.name);
  runSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${FIXTURE_VIDEO.width}x${FIXTURE_VIDEO.height}:r=${FIXTURE_VIDEO.fps}:d=${FIXTURE_VIDEO.seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-an', mediaFile]);

  const env = { PROMPTCUT_EXPORT_DIR: work };
  let server = null, browser = null;
  const cleanup = () => { try { if (server) server.stop(); } catch { /* Already stopped */ } };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { cleanup(); process.exit(130); });

  try {
    server = await startDevServer({ env, logFile: path.join(work, 'vite.log'), port: opts.port, log });
    log(`dev server ready ${server.origin} (stage ${server.stagePorts.join(' / ')})`);
    browser = await puppeteer.launch({ headless: true, protocolTimeout: 1800000,
      args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
    result.machine = await machineInfo({ ffmpeg, onlineChrome: await browser.version() });
    // Encoder used by the online path: whether hardware can be used, WebGL renderer (which GPU is used).
    // The page can only query "which preference is supported", not which one was ultimately selected.
    {
      const pg = await browser.newPage();
      await pg.goto(`${server.origin}/api/mcp/status`, { waitUntil: 'domcontentloaded' });
      result.machine.onlineBrowserEncoder = await pg.evaluate(async () => {
        const base = { codec: 'avc1.640028', width: 1280, height: 720, framerate: 30, bitrate: 2764800, avc: { format: 'avc' }, latencyMode: 'quality' };
        const sup = async (pref) => { try { return !!(await VideoEncoder.isConfigSupported({ ...base, hardwareAcceleration: pref })).supported; } catch { return null; } };
        let gl = null;
        try { const c = document.createElement('canvas').getContext('webgl'); const e = c.getExtension('WEBGL_debug_renderer_info'); gl = e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : null; } catch { /* No WebGL */ }
        return { secureContext: isSecureContext, preferHardware: await sup('prefer-hardware'), preferSoftware: await sup('prefer-software'), noPreference: await sup('no-preference'), webglRenderer: gl, config: 'avc1.640028 1280x720@30 about 2.76 Mbps, latencyMode quality (videoConfigOf in src/export/capability.ts, no hardware preference specified)' };
      });
      await pg.close();
    }

    for (const name of opts.projects) {
      const spec = PROJECTS[name];
      log(`Project ${name}: ${spec.note}`);
      // Set up project
      const setupPage = await browser.newPage();
      await setupPage.setViewport({ width: 1600, height: 1000 });
      await setupPage.goto(`${server.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180000 });
      await setupPage.waitForFunction(async () => !!(await import('/src/editor/stageBridge.ts')).frontStage(), { timeout: 180000, polling: 500 });
      const built = await buildProject(setupPage, spec, mediaFile);
      await setupPage.close();
      const project = built.project;
      const fps = project.fps || 30;
      const [fa, fb] = opts.frames ? opts.frames.split('-').map(Number) : [0, Math.floor(project.duration * fps) - 1];
      const expectFrames = fb - fa + 1;
      const P = result.projects[name] = { spec: { name: spec.name, note: spec.note, layers: built.layers, width: project.width, height: project.height, fps, duration: project.duration, frames: expectFrames, frameRange: `${fa}-${fb}` },
        desktop: { runs: [] }, online: { runs: [] } };
      await fsp.writeFile(path.join(work, `${name}-project.json`), JSON.stringify(project, null, 2));

      // Warmup (not included in statistics): the newly started dev server must compile a batch of modules
      // on the fly when loading the export page for the first time; in testing, the first desktop export
      // was not ready on the warmup frame for 20 seconds.
      // Desktop runs a PNG-only pass of the full segment (mounting each card once), online runs the first
      // 60 frames, and each retries on failure as usual.
      P.warmup = {};
      for (const route of ['desktop', 'online']) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            if (route === 'desktop') {
              const d = await runDesktop({ origin: server.origin, work, id: `${name}-warm`, project, frames: opts.frames, workers: opts.workers, noVideo: true });
              P.warmup.desktopNoVideoMs = round(d.wallMs, 0);
              if (!opts.keep) await fsp.rm(d.dir, { recursive: true, force: true });
            } else {
              const t0 = process.hrtime.bigint();
              await runOnline({ browser, origin: server.origin, project, frames: `0-${Math.min(fb, 59)}`, outFile: path.join(work, `${name}-warm.mp4`) });
              P.warmup.onlineFirst60Ms = round(T(t0), 0);
              await fsp.rm(path.join(work, `${name}-warm.mp4`), { force: true });
            }
            break;
          } catch (e) {
            log(`Warm-up ${route} attempt ${attempt} failed: ${String(e.message || e).slice(0, 160).replace(/\s+/g, ' ')}`);
            P.warmup[`${route}Failures`] = (P.warmup[`${route}Failures`] || 0) + 1;
            if (attempt === 3) failures.push(`${name} warm-up ${route} failed all 3 attempts: ${String(e.message || e).slice(-600)}`);
            else await sleep(3000 * attempt);
          }
        }
      }

      // Run alternately: desktop, online, desktop, online…
      for (let k = 1; k <= opts.runs; k++) {
        for (const route of ['desktop', 'online']) {
          const before = await loadBefore();
          log(`${name} ${route} pass ${k}/${opts.runs} (whole-machine usage before the run ${before.cpuPct}%, free memory ${before.freeMemGB} GB)`);
          const id = `${name}-${route[0]}${k}`;
          const file = route === 'desktop' ? null : path.join(work, `${name}-online-${k}.mp4`);
          // Retry transient failures (e.g. machine overloaded by other tasks, export page not ready for 20
          // seconds), up to 3 times; record each failure, and consider this pass failed only after 3 failures.
          const attempts = [];
          let done = false;
          for (let attempt = 1; attempt <= opts.retries && !done; attempt++) {
            try {
              let rec;
              if (route === 'desktop') {
                const d = await runDesktop({ origin: server.origin, work, id, project, frames: opts.frames, workers: opts.workers });
                const info = probeVideo(ffprobe, d.out);
                const keep = path.join(work, `${name}-desktop-${k}.mp4`);
                await fsp.copyFile(d.out, keep);
                rec = { k, before, totalMs: d.wallMs, cpuDuring: d.cpu, shards: d.shards, proresMode: d.proresMode, segments: d.segments, intermediateBytes: d.sizes, video: info, file: keep, log: d.marks, progressLines: d.frameLines };
                if (P.desktop.runs.length > 0 || !opts.split) { if (!opts.keep) await fsp.rm(d.dir, { recursive: true, force: true }); }
                else rec.keepDir = d.dir;
              } else {
                const o = await runOnline({ browser, origin: server.origin, project, frames: opts.frames, outFile: file });
                const info = probeVideo(ffprobe, file);
                rec = { k, before, totalMs: o.totalMs, evalWallMs: o.evalWallMs, cpuDuring: o.cpu, segments: o.segments, frameStats: o.frameStats, video: info, file, videoCodec: o.videoCodec, chunks: o.chunks };
              }
              rec.fileSha256 = crypto.createHash('sha256').update(await fsp.readFile(rec.file || file)).digest('hex');
              if (attempts.length) rec.failedAttempts = attempts;
              if (rec.video.frames !== expectFrames) failures.push(`${name} ${route} pass ${k} final video frame count ${rec.video.frames}, expected ${expectFrames}`);
              P[route].runs.push(rec);
              done = true;
              log(`  Done in ${round(rec.totalMs / 1000, 1)} s, ${rec.video.frames} frames, ${round(rec.video.bytes / 1e6, 2)} MB, ${rec.video.bitrateKbps} kbps, average usage during the run ${rec.cpuDuring.meanPct}%${attempts.length ? `(failed ${attempts.length} times before)` : ''}`);
            } catch (e) {
              const msg = String(e.message || e).slice(-1500);
              attempts.push((msg.length > 500 ? msg.slice(0, 200) + ' … ' + msg.slice(-250) : msg));
              log(`  Attempt ${attempt} failed: ${msg.slice(0, 200).replace(/\s+/g, ' ')}`);
              if (attempt === opts.retries) failures.push(`${name} ${route} pass ${k} failed (tried ${opts.retries} times): ${msg}`);
              else await sleep(3000 * attempt);
            }
          }
          await sleep(1500);
        }
      }

      // Are all passes on the same path identical frame by frame; visual difference between the two paths
      const w = project.width, h = project.height;
      for (const route of ['desktop', 'online']) {
        const runs = P[route].runs;
        for (const r of runs) r.frameHashes = await frameHashes(ffmpeg, r.file, w, h);
        P[route].repeatability = runs.length > 1 ? await sameRoute(runs, ffmpeg, w, h) : null;
      }
      const d1 = P.desktop.runs[0], o1 = P.online.runs[0];
      if (d1 && o1) {
        log(`${name}: frame-by-frame comparison of the final video from the two paths (desktop pass 1 vs online pass 1)`);
        const per = await crossDiff(ffmpeg, d1.file, o1.file, w, h);
        P.crossPathDiff = summarizeDiff(per, d1.frameHashes.length, o1.frameHashes.length);
        const sorted = [...per].sort((a, b) => a.mean - b.mean);
        const pick = [...new Set([sorted[sorted.length >> 1]?.i, per.reduce((x, y) => (y.mean > x.mean ? y : x)).i, Math.max(0, Math.floor(per.length * 0.25))])].filter((v) => v !== undefined);
        P.crossPathDiff.images = (await saveDiffTiles(ffmpeg, d1.file, o1.file, w, h, pick, assetsDir, name)).map((x) => ({ frame: x.frame, file: path.relative(REPO, x.file).replace(/\\/g, '/'), bytes: x.bytes }));
        P.crossPathDiff.perFrameSample = per.filter((p) => p.i % 30 === 0).map((p) => ({ i: p.i, mean: round(p.mean, 3), max: p.max, over32Pct: round(p.over32 * 100, 3), psnr: round(p.psnr, 2) }));
        if (!P.crossPathDiff.frameCountEqual) failures.push(`${name} the two paths produced different final video frame counts: ${P.crossPathDiff.framesA} vs ${P.crossPathDiff.framesB}`);
      } else failures.push(`${name} the final video from one path is missing, so the picture difference cannot be compared`);

      // Segment-split unit tests
      if (opts.split && d1?.keepDir) {
        log(`${name}: stage-split test`);
        P.split = {};
        try {
          let nv = null;
          for (let attempt = 1; attempt <= 3 && !nv; attempt++) {
            try { nv = await runDesktop({ origin: server.origin, work, id: `${name}-split`, project, frames: opts.frames, workers: opts.workers, noVideo: true }); }
            catch (e) { log(`  Stage-split test attempt ${attempt} failed: ${String(e.message || e).slice(0, 160).replace(/\s+/g, ' ')}`); if (attempt === 3) throw e; await sleep(3000 * attempt); }
          }
          const nPng = fs.readdirSync(path.join(nv.dir, 'frames')).filter((f) => f.endsWith('.png')).length;
          P.split.captureOnlyPng = { wallMs: round(nv.wallMs, 0), frames: nPng, startupToFirstFrameMs: round(nv.segments.startupToFirstFrameMs, 0), captureMs: round(nv.segments.captureMs, 0), note: 'Screenshots to PNG only (--no-video), no encoding; wall-clock time of the screenshots themselves, including disk writes' };
          const pngDir = path.join(nv.dir, 'frames');
          const mov = path.join(work, `${name}-split-prores.mov`);
          const first = Math.min(...fs.readdirSync(pngDir).filter((f) => f.endsWith('.png')).map((f) => parseInt(f, 10)));
          P.split.pngToProres = { wallMs: round(await timeProc(ffmpeg, ['-y', '-v', 'error', '-framerate', String(fps), '-start_number', String(first), '-i', path.join(pngDir, '%06d.png'), '-an', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', mov]), 0), bytes: fs.statSync(mov).size, note: 'Read the PNG sequence and encode ProRes 4444 (run on its own; in the main flow encoding happens while capturing)' };
          const overlay = path.join(d1.keepDir, 'overlay.mov');
          P.split.proresDecodeOnly = { wallMs: round(await timeProc(ffmpeg, ['-v', 'error', '-i', overlay, '-an', '-f', 'null', '-']), 0), note: 'Decode ProRes only, to a null output' };
          const x264Out = path.join(work, `${name}-split-x264.mp4`);
          P.split.proresDecodeAndX264 = { wallMs: round(await timeProc(ffmpeg, ['-y', '-v', 'error', '-i', overlay, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', x264Out]), 0), bytes: fs.statSync(x264Out).size, note: 'Decode ProRes plus libx264 (same encoding parameters as the main flow, no media layer); subtracting the previous item approximates libx264 itself' };
          P.split.x264Approx = { wallMs: round(P.split.proresDecodeAndX264.wallMs - P.split.proresDecodeOnly.wallMs, 0), note: 'Approximate value: the difference of two tests; both include overlapping disk reads and decoding, so use it as an order of magnitude only' };
          if (!opts.keep) { await fsp.rm(nv.dir, { recursive: true, force: true }); await fsp.rm(mov, { force: true }); await fsp.rm(x264Out, { force: true }); }
        } catch (e) { failures.push(`${name} stage-split test failed: ${String(e.message || e).slice(-1500)}`); }
        if (!opts.keep) await fsp.rm(d1.keepDir, { recursive: true, force: true });
        delete d1.keepDir;
      }

      // Summary
      for (const route of ['desktop', 'online']) {
        const runs = P[route].runs;
        P[route].summary = {
          runs: runs.length,
          totalMs: walls(runs, (r) => r.totalMs),
          msPerFrame: walls(runs, (r) => r.totalMs / expectFrames),
          segments: segStats(runs, (r) => r.segments),
          videoBytes: walls(runs, (r) => r.video.bytes), bitrateKbps: walls(runs, (r) => r.video.bitrateKbps),
          cpuBeforePct: walls(runs, (r) => r.before.cpuPct), cpuDuringMeanPct: walls(runs, (r) => r.cpuDuring.meanPct),
          shards: route === 'desktop' ? runs.map((r) => r.shards) : undefined,
        };
        for (const r of runs) delete r.frameHashes;
      }
      const dm = P.desktop.summary.totalMs?.median, om = P.online.summary.totalMs?.median;
      P.faster = dm && om ? { faster: om < dm ? 'online' : 'desktop', ratio: round(Math.max(dm, om) / Math.min(dm, om), 2), desktopMedianMs: dm, onlineMedianMs: om } : null;
    }
  } catch (e) {
    failures.push(`Probe exception: ${e?.stack || e}`);
  } finally {
    await browser?.close().catch(() => {});
    cleanup();
  }

  const windowsAfter = visibleWindows();
  result.visibleWindows = { before: windowsBefore, after: windowsAfter, newAfter: windowsAfter.filter((w) => !windowsBefore.includes(w)) };
  if (result.visibleWindows.newAfter.length) failures.push(`Extra visible windows after the run: ${result.visibleWindows.newAfter.join(' | ')}`);
  result.finishedAt = new Date().toISOString();
  result.ok = failures.length === 0;
  await fsp.writeFile(jsonFile, JSON.stringify(result, null, 2));
  log(`Summary ${jsonFile}`);
  console.log(JSON.stringify({ ok: result.ok, json: jsonFile, failures, faster: Object.fromEntries(Object.entries(result.projects).map(([k, v]) => [k, v.faster])) }));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
