// Shared utilities for "merged stream" evaluation probe (docs/archive/agent-reports/AGENT-rr-merged-eval.md).
// Merged stream: tiles multiple grids in one video, one grid per heavy card (inside each grid, top half
// is color, bottom half opacity); one decoder decodes it, then distributes to each layer by grid.
//
// Here are probe-only utilities: create test streams using production encoding parameters, segment fMP4,
// extract Annex-B bitstreams, launch headless browser, start local static server. Does not change a line
// of production code; large files go to system temp directory pc-merged-eval/, not into the repository.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { findFfmpeg, splitFmp4, initInfo, findBox, codecStringFromAvcC } from './stream-common.mjs';
import { STREAM_ENCODERS } from '../../server/bakery/ffmpeg.mjs';

export { findFfmpeg, splitFmp4, initInfo, findBox, codecStringFromAvcC };

export const WORK_ROOT = path.join(os.tmpdir(), 'pc-merged-eval');
export const workDir = (name) => {
  const dir = path.join(WORK_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export function arg(name, fallback = null, argv = process.argv.slice(2)) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

/** Encoding parameters currently used by the product for track streams (`STREAM_ENCODERS.libx264` in `server/bakery/ffmpeg.mjs`), taken as is. */
export const PRODUCT_X264 = STREAM_ENCODERS.libx264.args;
export const COLOR_TAGS = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
export const FMP4_FLAGS = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-an', '-f', 'mp4'];

/**
 * Runs ffmpeg once, returning { code, ms, cpuMs, stdout(Buffer), stderr }. Silent (windowsHide).
 * `ms` is wall clock (including process launch); `cpuMs` is user + kernel processor time reported
 * by ffmpeg itself (`-benchmark`), which is much more stable than wall clock when the machine is busy.
 */
export function runFfmpeg(args, { input = null, ffmpeg = findFfmpeg(), collect = true, bench = false } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const proc = spawn(ffmpeg, ['-y', '-hide_banner', ...(bench ? ['-benchmark', '-loglevel', 'info'] : ['-loglevel', 'error']), ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let err = '';
    proc.stdout.on('data', (d) => { if (collect) chunks.push(d); });
    proc.stderr.on('data', (d) => { err += d; });
    proc.stdin.on('error', () => {});
    proc.on('error', reject);
    proc.on('close', (code) => {
      const b = /bench: utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(err);
      resolve({ code, ms: +(performance.now() - t0).toFixed(1), cpuMs: b ? Math.round((Number(b[1]) + Number(b[2])) * 1000) : null, stdout: Buffer.concat(chunks), stderr: err.trim() });
    });
    if (input) proc.stdin.end(input); else proc.stdin.end();
  });
}

/**
 * Creates a test stream: lavfi's testsrc2 (with motion and detail) is directly encoded into W×H
 * H.264 (product parameters), output as fMP4. Here W×H is the **encoded dimensions** (already the
 * size after "stitching top and bottom halves together"). Returns { init, segments[], codec, ms,
 * bytes, stderr }.
 */
export async function makeStream({ width, height, frames = 30, fps = 30, source = 'testsrc2', extra = [], encoder = PRODUCT_X264 }) {
  const res = await runFfmpeg(['-f', 'lavfi', '-i', `${source}=s=${width}x${height}:r=${fps}`, '-frames:v', String(frames),
    '-vf', 'scale=out_range=tv:out_color_matrix=bt709,format=yuv420p', ...encoder, ...extra, ...COLOR_TAGS,
    '-video_track_timescale', String(fps), ...FMP4_FLAGS, 'pipe:1']);
  if (res.code !== 0) return { ok: false, error: res.stderr.split(/\r?\n/).slice(-3).join(' | '), ms: res.ms };
  const split = splitFmp4(res.stdout);
  const info = initInfo(split.init);
  return { ok: true, init: split.init, segments: split.segments, codec: info.codec ?? codecStringFromAvcC(findBox(split.init, 'avcC').payload), ms: res.ms, bytes: res.stdout.length, stderr: res.stderr };
}

/** H.264 level table (ITU-T H.264 Table A-1): MaxFS (macroblocks), MaxMBPS (macroblocks / s), MaxDpbMbs. Sourced from documentation, not measured. */
export const H264_LEVELS = [
  { level: '3.1', idc: 31, maxFS: 3600, maxMBPS: 108000 },
  { level: '4.0', idc: 40, maxFS: 8192, maxMBPS: 245760 },
  { level: '4.1', idc: 41, maxFS: 8192, maxMBPS: 245760 },
  { level: '4.2', idc: 42, maxFS: 8704, maxMBPS: 522240 },
  { level: '5.0', idc: 50, maxFS: 22080, maxMBPS: 589824 },
  { level: '5.1', idc: 51, maxFS: 36864, maxMBPS: 983040 },
  { level: '5.2', idc: 52, maxFS: 36864, maxMBPS: 2073600 },
  { level: '6.0', idc: 60, maxFS: 139264, maxMBPS: 4177920 },
  { level: '6.1', idc: 61, maxFS: 139264, maxMBPS: 8355840 },
  { level: '6.2', idc: 62, maxFS: 139264, maxMBPS: 16711680 },
];
export function levelFor(width, height, fps) {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const maxDim = (l) => Math.floor(Math.sqrt(8 * l.maxFS)) * 16;
  return H264_LEVELS.find((l) => mbs <= l.maxFS && mbs * fps <= l.maxMBPS && width <= maxDim(l) && height <= maxDim(l)) ?? null;
}

/** Local static server: binds to 127.0.0.1 only. routes: { '/path': Buffer | string | () => Buffer } */
export function serveLocal(port, routes) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      let body = routes[url.pathname];
      if (typeof body === 'function') body = body(url);
      if (body == null) { res.writeHead(404); res.end('no'); return; }
      const type = url.pathname.endsWith('.html') || url.pathname === '/' ? 'text/html; charset=utf-8'
        : url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : url.pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
export const closeServer = (s) => new Promise((r) => { s.close(r); s.closeAllConnections?.(); });

/** Chromium executables on this machine (listed only if present). All launched headless with temporary user directories, without touching user browser data. */
export function browserChoices() {
  const out = { puppeteer: null };
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const chrome = path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe');
  const edge = path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  if (fs.existsSync(chrome)) out.chrome = chrome;
  if (fs.existsSync(edge)) out.edge = edge;
  return out;
}

/**
 * Launch a **headless** browser (new headless mode: same executable and same GPU process path as
 * headed, just without creating a window).
 * `which`: 'puppeteer' (bundled Chrome for Testing) | 'chrome' | 'edge' | executable path.
 */
export async function launchHeadless(which = 'puppeteer', extraArgs = []) {
  const choices = browserChoices();
  const executablePath = which === 'puppeteer' ? undefined : (choices[which] ?? which);
  const userDataDir = fs.mkdtempSync(path.join(workDir('profiles'), `${which === 'puppeteer' ? 'cft' : path.basename(String(which)).replace(/\W+/g, '')}-`));
  const browser = await puppeteer.launch({ headless: true, executablePath, userDataDir,
    args: [...PROBE_CHROME_ARGS, '--no-first-run', '--no-default-browser-check', ...extraArgs] });
  return { browser, userDataDir, async close() { await browser.close().catch(() => {}); fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } };
}

/** GPU and hardware video decoding capabilities reported by the browser itself (CDP `SystemInfo.getInfo`). */
export async function gpuInfo(browser) {
  const cdp = await browser.target().createCDPSession();
  try {
    const info = await cdp.send('SystemInfo.getInfo');
    const version = await cdp.send('Browser.getVersion');
    return {
      product: version.product,
      gpu: info.gpu?.devices?.map((d) => `${d.vendorString} ${d.deviceString} (${d.driverVersion})`),
      angle: info.gpu?.auxAttributes?.glRenderer ?? null,
      featureStatus: info.gpu?.featureStatus ?? null,
      videoDecoding: (info.gpu?.videoDecoding ?? []).map((v) => ({ profile: v.profile, max: `${v.maxResolution.width}x${v.maxResolution.height}`, min: `${v.minResolution.width}x${v.minResolution.height}` })),
      driverBugWorkarounds: info.gpu?.driverBugWorkarounds ?? null,
    };
  } finally { await cdp.detach().catch(() => {}); }
}

/** Whether the machine is busy right now: samples os.cpus() twice, returning total usage percentage over this period. Time-measuring probes record once before and once after. */
export async function cpuBusy(ms = 500) {
  const snap = () => os.cpus().map((c) => c.times);
  const a = snap();
  await new Promise((r) => setTimeout(r, ms));
  const b = snap();
  let idle = 0, total = 0;
  for (let i = 0; i < a.length; i++) {
    for (const k of Object.keys(a[i])) total += b[i][k] - a[i][k];
    idle += b[i].idle - a[i].idle;
  }
  return total > 0 ? +(100 * (1 - idle / total)).toFixed(1) : null;
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
export const pctl = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null; };
export const round = (n, d = 2) => (n == null ? null : +Number(n).toFixed(d));
