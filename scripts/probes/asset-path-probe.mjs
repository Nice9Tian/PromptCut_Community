/**
 * End-to-end probe for Agent asset-reading paths (`docs/archive/agent-reports/AGENT-asset-path.md`;
 * semantics `docs/semantics/product/agent.md` "Media and Artifacts"):
 * Proves that `measure_audio` and `measure_audio_js`, plus three perception tools `detect_shots` /
 * `track_points` / `detect_subjects` (`docs/archive/agent-reports/AGENT-asset-path-2.md`), fetch bytes
 * in the editor process **via the asset service interface**, not by finding files via asset catalog.
 *
 *   node scripts/probes/asset-path-probe.mjs [--port 5920] [--keep]
 *
 * Starts an editor dev server itself (`--port`, defaults to 5920; stages occupy +1 and +2; with
 * PROMPTCUT_NO_PORT_FILE=1), placing artifacts and assets in a newly created temporary directory;
 * then starts a counting "remote asset service" on `--port + 5` (only implements
 * `GET/HEAD <base>/media/<hash>`, supporting Range), acting as the one registered for shared project.
 * The two test audio clips are **only placed on this remote asset service**, and the editor's asset
 * catalog is initially empty; the asset record's `path` in the project points to a nonexistent directory.
 *
 *   P1 The editor connects to this remote asset service via `POST /api/media/remote` (what the page
 *      does when sharing a project);
 *   P2 `measure_audio` tests noise asset: integrated / truePeak / LRA / threshold / duration are
 *      item-by-item identical to those calculated by the probe itself reading the local file directly
 *      with ffmpeg (pre-change reading method); the remote asset service was requested for this
 *      asset: bytes indeed came via the asset service interface;
 *   P3 `measure_audio_js` (chat registered as "high") tests sine wave asset: RMS / peak match
 *      theoretical values; PCM fingerprint calculated in sandbox matches probe's own decoding of
 *      local file; remote asset service was requested for this asset;
 *   P4 Disconnect remote (return to local space): asset now exists only in local content store,
 *      stored by hash (`<hash>.<ext>`), and asset record url has no extension; splicing filename by
 *      directory (pre-change `mediaFileOf`) cannot find it, only asset service finds it by hash;
 *      both tools return results as usual with unchanged values, remote was not hit once;
 *   P5 Asset that exists nowhere: both tools return clear errors (asset file does not exist /
 *      no-media) without crashing.
 *   ── Below are perception tools (video also only on remote asset service; P7~P11 require Python
 *      with numpy, used by editor via PROMPTCUT_PYTHON) ──
 *   P6 detect_shots (scdet fallback tier): transition timestamps match running scdet directly on
 *      local file; remote asset service was requested for this video;
 *   P7 track_points (template matching tier): tracking results via asset service are item-by-item
 *      identical to running promptcut_track directly on local file;
 *   P8 detect_subjects: URL passes Python entry check (this machine has no models installed, stops
 *      at "not ready" rather than "video file not found");
 *   P9 All three Python packages return ACCEPTS_URL;
 *   P10 Legacy package (without ACCEPTS_URL) rejects URL, Node falls back to temp files: bytes
 *       identical, results identical, deleted after use;
 *   P11 Subject detection frame extraction step: pixels decoded via URL vs reading local file are
 *       byte-by-byte identical.
 *   This machine does not have TransNetV2 / BootsTAPIR / YuNet models; real model inference is not
 *   run in the probe.
 *
 * On exit, only stop processes started by itself (editor process tree, counting service, probe's
 * puppeteer Chrome); `--keep` does not close them or delete temporary directories.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR, and set PROMPTCUT_NO_PORT_FILE=1
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { findFfmpeg } from '../../server/ai-visual.mjs';
import { measureArgs, parseEbur128 } from '../../server/audio-measure.mjs';
import { filePcmArgs, decodePcm } from '../../server/audio-pcm.mjs';
import { pythonAcceptsUrl, pythonInput } from '../../server/perception-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 5920);
const KEEP = args.includes('--keep');
const REMOTE_PORT = PORT + 5;
const clashes = (p) => (p >= 5190 && p <= 5192) || (p >= 5580 && p <= 5599);
if (!(PORT >= 1024 && PORT % 10 <= 4) || [PORT, PORT + 1, PORT + 2, REMOTE_PORT].some(clashes)) {
  throw new Error(`--port ${PORT} is not allowed: it uses PORT~PORT+2 and PORT+5, which must fall within the same block of 10 ports (PORT's last digit ≤ 4), and must not touch 5190~5192 or 5580~5599`);
}
const EDITOR = `http://127.0.0.1:${PORT}`;
const EXPORT_DIR = path.join(os.tmpdir(), `pc-asset-path-probe-${Date.now().toString(36)}`);
const DATA_DIR = path.join(EXPORT_DIR, 'data');
const MEDIA_DIR = path.join(EXPORT_DIR, 'media');
const SRC_DIR = path.join(EXPORT_DIR, 'remote-src'); // Bytes from the remote asset service (the editor does not know about this directory)
const GONE = path.join(EXPORT_DIR, 'nonexistent-asset-dir');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(SRC_DIR, { recursive: true });

/* ---- Python helpers for P6~P11 (claude/asset-path-2) ---- */
/** Python with numpy: PROMPTCUT_TEST_PYTHON, or python / python3 on PATH; when not found, record P7~P11 as failures (probe does not silently skip) */
function findTestPython() {
  for (const cmd of [process.env.PROMPTCUT_TEST_PYTHON, 'python', 'python3'].filter(Boolean)) {
    try {
      const r = spawnSync(cmd, ['-c', 'import sys, numpy; sys.stdout.write(sys.executable)'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      const exe = String(r.stdout || '').trim();
      if (r.status === 0 && exe && fs.existsSync(exe)) return exe;
    } catch { /* Next */ }
  }
  return null;
}
const PY = findTestPython();
const PYLIBS = path.join(EXPORT_DIR, 'pylibs');
const MODELS = path.join(EXPORT_DIR, 'models');
fs.mkdirSync(PYLIBS, { recursive: true });
/** Let Python find packages in the repository (same approach as buildEnv in vite-plugin-stt for ordinary interpreters) */
const pyEnv = (pylibs) => ({ ...process.env, PYTHONPATH: pylibs + path.delimiter + path.join(ROOT, 'python'), PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PROMPTCUT_PYLIBS: pylibs, PROMPTCUT_MODELS: MODELS });
const spawnPy = (python, a, env) => spawn(python, a, { env, windowsHide: true });
/** Run child process asynchronously: counting remote asset service is in probe process; spawnSync blocks event loop, leaving ffmpeg requests unanswered */
function runAsync(cmd, a, env, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, a, { env, windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += String(e); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
/** promptcut_track's result event -> fields compared against get_track(full) */
function trackResult(r) {
  const line = String(r.stdout).split(/\r?\n/).find((l) => /"event":\s*"result"/.test(l));
  if (!line) return { error: (r.stdout + r.stderr).slice(-400) };
  const ev = JSON.parse(line);
  return { engine: ev.engine, width: ev.width, height: ev.height, frames: ev.frames, points: ev.points };
}
/** Create a "legacy package": copy promptcut_track from repository, remove ACCEPTS_URL and URL allowlisting (what package in runtime looks like when desktop app only patches Node) */
function makeOldTrackPackage(pylibs) {
  const dst = path.join(pylibs, 'promptcut_track');
  fs.cpSync(path.join(ROOT, 'python', 'promptcut_track'), dst, { recursive: true, filter: (s) => !s.includes('__pycache__') });
  const init = path.join(dst, '__init__.py');
  fs.writeFileSync(init, fs.readFileSync(init, 'utf8').replace('ACCEPTS_URL = True', ''));
  const main = path.join(dst, '__main__.py');
  fs.writeFileSync(main, fs.readFileSync(main, 'utf8')
    .replace('from . import __version__, is_media_url', 'from . import __version__')
    .replace('if not (is_media_url(args.video) or os.path.isfile(args.video)):', 'if not os.path.isfile(args.video):'));
}

const fails = [];
const passes = [];
const out = { port: PORT, remotePort: REMOTE_PORT, exportDir: EXPORT_DIR };
const check = (cond, label, extra) => {
  (cond ? passes : fails).push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600)));
  return cond;
};

async function until(label, fn, timeoutMs = 120000, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); return null; }
    await delay(everyMs);
  }
}

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

let editor = null;
const editorLog = [];
async function startEditor() {
  editor = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PROMPTCUT_EXPORT_DIR: EXPORT_DIR, PROMPTCUT_DATA_DIR: DATA_DIR, PROMPTCUT_NO_PORT_FILE: '1',
        PROMPTCUT_PYLIBS: PYLIBS, PROMPTCUT_MODELS: MODELS, ...(PY ? { PROMPTCUT_PYTHON: PY } : {}) } });
  const keep = (c) => { editorLog.push(c.toString()); if (editorLog.length > 400) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  return until('editor process is up', async () => (await fetch(EDITOR + '/api/prerender/info').then((r) => r.ok, () => false)) || null, 120000);
}
function stopEditor() {
  if (!editor || editor.exitCode !== null || !editor.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editor.kill('SIGKILL');
}

/* ---- Counting remote asset service: GET/HEAD /api/asset/media/<hash>, Range ---- */
const remoteFiles = new Map(); // hash -> file
const remoteLog = [];
const remote = http.createServer((req, res) => {
  const m = /^\/api\/asset\/media\/([0-9a-f]{64})$/.exec(String(req.url).split('?')[0]);
  remoteLog.push({ method: req.method, url: req.url, range: req.headers.range || null, hash: m?.[1] ?? null });
  const file = m && remoteFiles.get(m[1]);
  if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) { res.statusCode = 404; return res.end('Not found'); }
  const size = fs.statSync(file).size;
  const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  const head = { 'Content-Type': file.endsWith('.mp4') ? 'video/mp4' : 'audio/wav', 'Accept-Ranges': 'bytes' };
  if (r) {
    const start = r[1] === '' ? Math.max(0, size - Number(r[2])) : Number(r[1]);
    const end = r[1] !== '' && r[2] !== '' ? Math.min(size - 1, Number(r[2])) : size - 1;
    if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});
const hitsOf = (hash) => remoteLog.filter((e) => e.hash === hash && e.method === 'GET').length;

const mcpCall = async (tool, callArgs, agent) => {
  const res = await fetch(`${EDITOR}/api/mcp/call`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args: callArgs, ...(agent ? { agent } : {}) }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await res.json().catch(() => null);
  return body?.result ?? body;
};
/** Register this chat's tier: actually hits /api/ai/chat; provider does not exist, so starting model right after registration directly throws error without spending quota */
const register = (conv, creativity) => fetch(`${EDITOR}/api/ai/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ provider: 'probe-none', prompt: 'x', conversationId: conv, creativity, projectCreativity: 'high' }),
}).then((r) => r.text()).catch(() => '');

/** Compute in sandbox: per-channel RMS / peak, plus FNV-1a fingerprint of all sample bytes */
const RMS_PEAK_FNV = [
  'const out = []; let h = 2166136261 >>> 0;',
  'for (const x of input.channels) {',
  '  let s = 0, pk = 0;',
  '  for (let i = 0; i < x.length; i++) { s += x[i] * x[i]; const a = Math.abs(x[i]); if (a > pk) pk = a; }',
  '  out.push({ rmsDb: 10 * Math.log10(s / x.length), peakDb: 20 * Math.log10(pk) });',
  '  const u = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);',
  '  for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }',
  '}',
  'return { channels: out, frames: input.frames, sampleRate: input.sampleRate, fnv: h };',
].join('\n');
function fnvOf(channels) {
  let h = 2166136261 >>> 0;
  for (const x of channels) {
    const u = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
  }
  return h;
}
const RMS = 20 * Math.log10(0.5 / Math.SQRT2); // -9.031
const PEAK = 20 * Math.log10(0.5); // -6.021
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) < tol;
const LOUD_KEYS = ['integrated', 'truePeak', 'lra', 'lraLow', 'lraHigh', 'threshold', 'duration'];
const pick = (o) => Object.fromEntries(LOUD_KEYS.map((k) => [k, o?.[k]]));

/** Probe measures loudness itself using pre-change reading method (ffmpeg directly reading local file) */
function loudnessDirect(ffmpeg, file) {
  const r = spawnSync(ffmpeg, measureArgs({ file }), { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return parseEbur128(r.stderr);
}

let browser = null;
try {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found (put it on PATH or set PROMPTCUT_FFMPEG)');
  const gen = (name, lavfi) => {
    const file = path.join(SRC_DIR, name);
    const r = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...lavfi, file], { windowsHide: true });
    if (r.status !== 0) throw new Error(`Failed to generate ${name}: ${String(r.stderr).slice(0, 200)}`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    remoteFiles.set(hash, file);
    return { file, hash };
  };
  const wave = '0.5*sin(2*PI*1000*t)';
  const sine = gen('sine.wav', ['-f', 'lavfi', '-i', `aevalsrc=${wave}|${wave}:s=48000:d=3`, '-c:a', 'pcm_s24le']);
  const noise = gen('noise.wav', ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.25:duration=20:sample_rate=48000:seed=3', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=20',
    '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[a]', '-map', '[a]', '-c:a', 'pcm_s16le']);
  const ghostHash = 'ee'.repeat(32);
  out.hashes = { sine: sine.hash, noise: noise.hash };

  await new Promise((resolve, reject) => { remote.once('error', reject); remote.listen(REMOTE_PORT, '127.0.0.1', resolve); });
  if (!(await startEditor())) throw new Error('The editor process did not start');
  check(fs.readdirSync(MEDIA_DIR).length === 0, 'The editor\'s asset directory is empty at the start', fs.readdirSync(MEDIA_DIR));

  browser = await puppeteer.launch({ headless: true, pipe: true, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(EDITOR + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => { const m = await import('/src/store/project.ts'); return !!m.getState().project; }, { timeout: 180000, polling: 500 });
  const placed = await page.evaluate(async ({ sine, noise, ghost, gone }) => {
    const m = await import('/src/store/project.ts');
    m.actions.newProject?.();
    // url has no extension and path points to nonexistent directory: splicing filename by directory cannot find it, can only find by hash via asset service
    const a = m.actions.addMedia({ id: 'm-sine', kind: 'audio', name: 'sine.wav', url: `/@media/${sine}`, hash: sine, path: `${gone}\\sine.wav`, duration: 3 });
    const b = m.actions.addMedia({ id: 'm-noise', kind: 'audio', name: 'noise.wav', url: `/@media/${noise}`, hash: noise, path: `${gone}\\noise.wav`, duration: 20 });
    const c = m.actions.addMedia({ id: 'm-ghost', kind: 'audio', name: 'ghost.wav', url: `/@media/${ghost}`, hash: ghost, path: `${gone}\\ghost.wav`, duration: 3 });
    const clip = m.actions.addMediaClip(a.id, 1, { duration: 2 });
    return { sine: a.id, noise: b.id, ghost: c.id, clipId: clip?.id ?? null, hashes: m.getState().project.media.map((x) => x.hash ?? null) };
  }, { sine: sine.hash, noise: noise.hash, ghost: ghostHash, gone: GONE });
  out.placed = placed;
  check(!!placed.clipId && placed.hashes.includes(sine.hash), 'The asset was recorded in the project (with hash) and the sine wave was placed on the timeline', placed);

  /* ---- P1 Connect to remote asset service ---- */
  const base = `http://127.0.0.1:${REMOTE_PORT}/api/asset`;
  const set = await fetch(EDITOR + '/api/media/remote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base }) }).then((r) => r.json()).catch(() => null);
  const status = await fetch(EDITOR + '/api/media/remote').then((r) => r.json()).catch(() => null);
  check(set?.ok && status?.base === base, 'P1 The editor connected to this remote asset service', status);

  /* ---- P2 measure_audio ---- */
  const direct = loudnessDirect(ffmpeg, noise.file);
  out.loudDirect = pick(direct);
  const loud = await until('measure_audio measures the noise asset', async () => {
    const r = await mcpCall('measure_audio', { mediaId: placed.noise });
    return r && typeof r.integrated === 'number' ? r : (r && !/asset not found|editor is not open/.test(String(r.error || '')) ? r : null);
  }, 90000, 1000);
  out.loud = loud && { ...pick(loud), error: loud.error };
  check(loud && JSON.stringify(pick(loud)) === JSON.stringify(pick(direct)), 'P2 measure_audio values match reading the local file directly (the pre-change way), item by item', { now: pick(loud), direct: pick(direct) });
  const noiseHits = hitsOf(noise.hash);
  check(noiseHits >= 1, `P2 The remote asset service was asked for the noise asset (${noiseHits} GETs): the bytes came through the asset service's API`, remoteLog.filter((e) => e.hash === noise.hash).slice(0, 8));

  /* ---- P3 measure_audio_js ---- */
  const conv = `approbe${Date.now().toString(36)}`;
  await register(conv, 'high');
  const pcmDirect = await decodePcm(ffmpeg, filePcmArgs({ file: sine.file, sampleRate: 16000, channels: 2 }), { channels: 2, sampleRate: 16000 });
  const js = await mcpCall('measure_audio_js', { mediaId: placed.sine, code: RMS_PEAK_FNV }, conv);
  out.js = js;
  check(js?.ok === true && js.value?.channels?.length === 2 && js.value.channels.every((ch) => near(ch.rmsDb, RMS, 0.05) && near(ch.peakDb, PEAK, 0.1)),
    'P3 measure_audio_js: RMS / peak of both channels match the theoretical values', js);
  check(js?.value?.fnv === fnvOf(pcmDirect) && js?.value?.frames === pcmDirect[0].length, 'P3 The PCM the sandbox gets is byte-for-byte identical to decoding the local file directly (FNV fingerprint, frame count)', { now: js?.value?.fnv, direct: fnvOf(pcmDirect), frames: js?.value?.frames, directFrames: pcmDirect[0].length });
  check(hitsOf(sine.hash) >= 1, `P3 The remote asset service was asked for the sine wave asset (${hitsOf(sine.hash)} GETs)`);
  const clipJs = await mcpCall('measure_audio_js', { clipId: placed.clipId, mono: true, sampleRate: 48000, code: RMS_PEAK_FNV }, conv);
  check(clipJs?.ok === true && near(clipJs.value?.channels?.[0]?.rmsDb, RMS, 0.05), 'P3 Clip tier (mono, 48 kHz) works as usual', clipJs && { ok: clipJs.ok, error: clipJs.error, v: clipJs.value?.channels });

  /* ---- P6~P11 Three perception tools (claude/asset-path-2): bytes come via asset service, results identical to reading local file directly ---- */
  const cuts = gen('cuts.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=25:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25:d=1',
    '-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=25:d=1', '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const move = gen('move.mp4', ['-f', 'lavfi', '-i', 'color=c=black:s=160x120:r=10:d=2', '-f', 'lavfi', '-i', 'color=c=white:s=16x16:r=10:d=2',
    '-filter_complex', "[0][1]overlay=x='20+t*30':y=50", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '5']);
  out.hashes.cuts = cuts.hash;
  out.hashes.move = move.hash;
  const vids = await page.evaluate(async ({ cuts, move, gone }) => {
    const m = await import('/src/store/project.ts');
    const a = m.actions.addMedia({ id: 'm-cuts', kind: 'video', name: 'cuts.mp4', url: `/@media/${cuts}`, hash: cuts, path: `${gone}\\cuts.mp4`, duration: 3, width: 160, height: 90 });
    const b = m.actions.addMedia({ id: 'm-move', kind: 'video', name: 'move.mp4', url: `/@media/${move}`, hash: move, path: `${gone}\\move.mp4`, duration: 2, width: 160, height: 120 });
    return { cuts: a.id, move: b.id };
  }, { cuts: cuts.hash, move: move.hash, gone: GONE });

  // P6 detect_shots (editor has no Python model, uses scdet fallback tier): transition timestamps match running scdet directly on local file
  const scdetDirect = [...String(spawnSync(ffmpeg, ['-hide_banner', '-i', cuts.file, '-vf', 'scdet=threshold=10', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true }).stderr)
    .matchAll(/lavfi\.scd\.time:\s*([0-9.]+)/g)].map((x) => Number(x[1]));
  const started = await mcpCall('detect_shots', { mediaId: vids.cuts });
  const shots = await until('list_shots returns a result', async () => {
    const r = await mcpCall('list_shots', { mediaId: vids.cuts });
    return r && (r.running === false || r.error) ? r : null;
  }, 120000, 1000);
  out.shots = shots && { engine: shots.engine, transitions: shots.transitions?.map((t) => t.time), error: shots.error, started };
  check(shots?.running === false && JSON.stringify(shots.transitions.map((t) => t.time)) === JSON.stringify(scdetDirect) && scdetDirect.length === 2,
    'P6 detect_shots: transition times match running scdet directly on the local file (two hard cuts)', { now: shots?.transitions?.map((t) => t.time), direct: scdetDirect, error: shots?.error });
  check(hitsOf(cuts.hash) >= 1, `P6 The remote asset service was asked for this video (${hitsOf(cuts.hash)} GETs)`);

  if (!PY) {
    fails.push('P7-P11 need a Python with numpy (python on PATH, or PROMPTCUT_TEST_PYTHON), none was found on this machine');
  } else {
    // P7 track_points (template matching tier): tracking results via asset service are item-by-item identical to running promptcut_track directly on local file
    const POINTS = [[0, 28, 58]];
    const direct = trackResult(await runAsync(PY, ['-m', 'promptcut_track', 'track', '--video', move.file, '--points', JSON.stringify(POINTS)], pyEnv(PYLIBS)));
    const moveHits0 = hitsOf(move.hash);
    const tStart = await mcpCall('track_points', { mediaId: vids.move, points: POINTS });
    const track = await until('get_track returns a result', async () => {
      const r = await mcpCall('get_track', { mediaId: vids.move, full: true });
      return r && (r.running === false || r.error) ? r : null;
    }, 120000, 1000);
    const trackNow = track && { engine: track.engine, width: track.width, height: track.height, frames: track.frames, points: track.points };
    check(track?.engine === 'template' && JSON.stringify(trackNow) === JSON.stringify(direct),
      'P7 track_points (template-matching tier): tracking through the asset service matches reading the local file directly, item by item', { now: trackNow && { ...trackNow, points: trackNow.points?.map((p) => [p.xy[0], p.xy.at(-1)]) }, direct: direct && direct.points?.map((p) => [p.xy[0], p.xy.at(-1)]), error: track?.error, started: tStart });
    // After page registers asset, local asset service may have pulled the whole file from remote into local content store per prefetch manifest (before P7 starts), so here only check if remote was requested overall:
    // Editor's asset catalog is empty initially, and asset record's path points to a nonexistent directory; bytes could only come via asset service
    check(hitsOf(move.hash) >= 1, `P7 The remote asset service was asked for this video (${hitsOf(move.hash)} GETs in total, ${hitsOf(move.hash) - moveHits0} of them during P7)`);

    // P8 detect_subjects: this machine has no subject detection model; URL must pass Python entry check, stopping at "not ready" rather than "video file not found"
    const sStart = await mcpCall('detect_subjects', { mediaId: vids.move, times: [0.5, 1.2] });
    const subj = await until('list_subjects finishes', async () => {
      const r = await mcpCall('list_subjects', { mediaId: vids.move });
      return r && (r.running === false || r.error) ? r : null;
    }, 180000, 1000);
    out.subjects = { started: sStart, result: subj && (subj.error || { engine: subj.engine, samples: subj.samples?.length }) };
    check(subj && !/video file not found/.test(String(subj.error || '')) && (subj.running === false ? subj.samples?.length === 2 : /not ready/.test(String(subj.error))),
      'P8 detect_subjects: the URL passed the entry check (with the model installed it yields two samples; without it, it stops at "not ready")', out.subjects);

    // P9 All three Python packages return ACCEPTS_URL (Node passes URL accordingly)
    for (const pkg of ['promptcut_shots', 'promptcut_track', 'promptcut_subject']) {
      check(await pythonAcceptsUrl({ python: PY, env: pyEnv(PYLIBS), pkg, spawnPython: spawnPy }), `P9 ${pkg} answers ACCEPTS_URL`);
    }

    // P10 Legacy package (copy promptcut_track from repository, remove ACCEPTS_URL and URL allowlisting): rejects URL; Node falls back to temporary files, results identical, temporary files deleted after use
    const oldLibs = path.join(EXPORT_DIR, 'pylibs-old');
    makeOldTrackPackage(oldLibs);
    const url = `http://127.0.0.1:${REMOTE_PORT}/api/asset/media/${move.hash}`;
    const refused = await runAsync(PY, ['-m', 'promptcut_track', 'track', '--video', url, '--points', JSON.stringify(POINTS)], pyEnv(oldLibs));
    check(/video file not found/.test(refused.stdout), 'P10 The old package does reject URLs', refused.stdout.slice(-300));
    const input = await pythonInput({ src: url, ref: { name: 'move.mp4' }, python: PY, env: pyEnv(oldLibs), pkg: 'promptcut_track', spawnPython: spawnPy, tmpRoot: EXPORT_DIR });
    check(input.via === 'temp' && fs.readFileSync(input.input).equals(fs.readFileSync(move.file)), 'P10 Old package: Node first streams the bytes to a temp file (byte-for-byte identical to the original file)', { via: input.via });
    const viaTemp = trackResult(await runAsync(PY, ['-m', 'promptcut_track', 'track', '--video', input.input, '--points', JSON.stringify(POINTS)], pyEnv(oldLibs)));
    input.cleanup();
    check(JSON.stringify(viaTemp) === JSON.stringify(direct) && !fs.existsSync(input.input), 'P10 Tracking via the temp file with the old package matches reading the file directly, and the temp file is deleted');

    // P11 Subject detection byte-fetching step: frames.probe_size + grab_frame via URL vs reading local file, width/height and BGR pixels are byte-by-byte identical
    const script = path.join(EXPORT_DIR, 'frames_check.py');
    fs.writeFileSync(script, [
      'import sys, json, hashlib',
      'from promptcut_subject import frames as F',
      'ff = sys.argv[1]',
      'out = []',
      'for v in sys.argv[2:]:',
      '    w, h = F.probe_size(ff, v)',
      '    fw, fh = F.target_size(w, h, 640)',
      '    rows = []',
      '    for t in (0.0, 0.5, 1.2):',
      '        fr = F.grab_frame(ff, v, t, fw, fh)',
      '        rows.append([list(fr.shape), hashlib.sha256(fr.tobytes()).hexdigest()])',
      '    out.append({"size": [w, h], "frames": rows})',
      'print(json.dumps(out))',
    ].join('\n'));
    const fc = await runAsync(PY, [script, ffmpeg, url, move.file], pyEnv(PYLIBS));
    let pair = null;
    try { pair = JSON.parse(fc.stdout.trim().split(/\r?\n/).at(-1)); } catch { /* Report below */ }
    check(pair && JSON.stringify(pair[0]) === JSON.stringify(pair[1]) && JSON.stringify(pair[0].size) === '[160,120]',
      'P11 Subject detection frame extraction: pixels decoded via the asset service URL are byte-for-byte identical to those from reading the local file', pair ?? fc.stderr.slice(-400));
  }

  /* ---- P4 Return to local space: only local content store remains, stored by hash ---- */
  await until('Remote fetch finished and the asset is in the local content store', async () => {
    const s = await fetch(EDITOR + '/api/media/remote').then((r) => r.json());
    return s.jobs.every((j) => j.done) ? s : null;
  }, 30000, 500);
  await fetch(EDITOR + '/api/media/remote', { method: 'DELETE' });
  const lib = fs.readdirSync(MEDIA_DIR);
  out.localLibrary = lib;
  check(lib.some((f) => f.startsWith(noise.hash + '.')) && !lib.includes(noise.hash) && !lib.includes('noise.wav'),
    'P4 The local content store holds <hash>.<ext>: not found by the last URL segment (<hash>) joined to the directory, nor by file name', lib);
  const before = remoteLog.length;
  const loud2 = await mcpCall('measure_audio', { mediaId: placed.noise });
  check(loud2 && JSON.stringify(pick(loud2)) === JSON.stringify(pick(direct)), 'P4 Local space: measure_audio works as usual, values unchanged', loud2 && { ...pick(loud2), error: loud2.error });
  const js2 = await mcpCall('measure_audio_js', { mediaId: placed.sine, code: RMS_PEAK_FNV }, conv);
  check(js2?.ok === true && js2.value?.fnv === fnvOf(pcmDirect), 'P4 Local space: measure_audio_js works as usual, PCM unchanged', js2 && { ok: js2.ok, error: js2.error, fnv: js2.value?.fnv });
  check(remoteLog.length === before, 'P4 The remote asset service was never hit', remoteLog.slice(before, before + 5));

  /* ---- P5 Asset that exists nowhere ---- */
  const g1 = await mcpCall('measure_audio', { mediaId: placed.ghost });
  check(g1 && typeof g1.integrated !== 'number' && /asset file does not exist/.test(String(g1.error || '')), 'P5 measure_audio on an asset that exists nowhere returns "asset file does not exist"', g1);
  const g2 = await mcpCall('measure_audio_js', { mediaId: placed.ghost, code: 'return 1' }, conv);
  check(g2?.ok === false && g2.kind === 'no-media', 'P5 measure_audio_js returns kind no-media', g2);
  const alive = await fetch(EDITOR + '/api/prerender/info').then((r) => r.ok, () => false);
  check(alive, 'The editor still responds as usual');
  check(pageErrors.length === 0, 'Page has no uncaught exceptions', pageErrors.slice(0, 5));
  out.remoteRequests = remoteLog.length;
} catch (error) {
  fails.push('exception: ' + (error?.stack || error));
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise((resolve) => { remote.closeAllConnections?.(); remote.close(() => resolve()); });
  if (!KEEP) {
    stopEditor();
    await delay(500);
    fs.rmSync(EXPORT_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } else {
    out.kept = EXPORT_DIR;
  }
}
console.log(JSON.stringify(out, null, 1).slice(0, 6000));
for (const p of passes) console.log('PASS', p);
for (const f of fails) console.log('FAIL', f);
if (fails.length) console.log(editorLog.join('').slice(-3000));
console.log(fails.length ? `Probe failed: ${fails.length} failed, ${passes.length} passed` : `Probe passed: ${passes.length} checks`);
process.exit(fails.length ? 1 : 0);
