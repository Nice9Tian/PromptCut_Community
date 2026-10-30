/**
 * Agent 读素材的路径的端到端探针(`docs/archive/agent-reports/AGENT-asset-path.md`;语义 `docs/semantics/product/agent.md`「素材与产物」):
 * 证明 `measure_audio` 与 `measure_audio_js`,以及三个感知工具 `detect_shots` / `track_points` / `detect_subjects`
 * (`docs/archive/agent-reports/AGENT-asset-path-2.md`)在编辑器进程里是**经素材服务的接口**取的字节,不是按素材目录找文件。
 *
 *   node scripts/probes/asset-path-probe.mjs [--port 5920] [--keep]
 *
 * 自己起一个编辑器 dev server(`--port`,缺省 5920,舞台另占 +1、+2;带 PROMPTCUT_NO_PORT_FILE=1),产物与素材落在新建的临时目录;
 * 再在 `--port + 5` 上起一台计数的「远程素材服务」(只实现 `GET/HEAD <base>/media/<hash>`,支持 Range),充当共享项目登记的那一台。
 * 两段测试音频**只放在这台远程素材服务上**,编辑器的素材目录里一开始什么都没有;项目里素材记录的 `path` 指向不存在的目录。
 *
 *   P1 编辑器经 `POST /api/media/remote` 连上这台远程素材服务(共享项目时页面做的事);
 *   P2 `measure_audio` 测噪声素材:integrated / truePeak / LRA / threshold / duration 与探针自己用 ffmpeg 直接读本地文件
 *      (改前的读法)算出来的逐项相同;远程素材服务被请求过这份素材 —— 字节确实是经素材服务的接口来的;
 *   P3 `measure_audio_js`(登记为「高」的对话)测正弦波素材:RMS / 峰值与理论值一致;沙箱里算的 PCM 指纹与探针自己解码
 *      本地文件的相同;远程素材服务被请求过这份素材;
 *   P4 断开远程(回到本机空间):这时素材只在本地内容库里、按哈希存(`<hash>.<ext>`),素材记录的 url 不带扩展名,
 *      按目录拼文件名(改前的 `mediaFileOf`)找不到它,只有素材服务按哈希能找到;两条工具照常出结果、数值不变,远程一次也没被打到;
 *   P5 一份哪儿都没有的素材:两条工具回清楚的错(素材文件不存在 / no-media),不崩。
 *   ── 下面是感知工具(视频也只放在远程素材服务上;P7～P11 要一个带 numpy 的 Python,编辑器经 PROMPTCUT_PYTHON 用它) ──
 *   P6 detect_shots(scdet 兜底档):转场时刻与直接对本地文件跑 scdet 的相同;远程素材服务被请求过这段视频;
 *   P7 track_points(模板匹配档):经素材服务追出来的与直接对本地文件跑 promptcut_track 的逐项相同;
 *   P8 detect_subjects:地址过得了 Python 的入口检查(这台机器没装模型,停在「未就绪」,不是「找不到视频文件」);
 *   P9 三个 Python 包都答 ACCEPTS_URL;
 *   P10 老包(没有 ACCEPTS_URL)拒绝地址,Node 改走临时文件:字节相同、结果相同、用完删;
 *   P11 主体检测抽帧那一步:经地址与读本地文件解出的像素逐字节相同。
 *   这台机器没有 TransNetV2 / BootsTAPIR / YuNet 等模型,真的模型推理不在探针里跑。
 *
 * 结束时只停自己起的进程(编辑器进程树、计数服务、探针的 puppeteer Chrome);`--keep` 不关、不删临时目录。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,并设 PROMPTCUT_NO_PORT_FILE=1
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
  throw new Error(`--port ${PORT} 不行:占 PORT～PORT+2 与 PORT+5,要落在同一个 10 口段里(PORT 的个位 ≤ 4),且不碰 5190～5192、5580～5599`);
}
const EDITOR = `http://127.0.0.1:${PORT}`;
const EXPORT_DIR = path.join(os.tmpdir(), `pc-asset-path-probe-${Date.now().toString(36)}`);
const DATA_DIR = path.join(EXPORT_DIR, 'data');
const MEDIA_DIR = path.join(EXPORT_DIR, 'media');
const SRC_DIR = path.join(EXPORT_DIR, 'remote-src'); // 远程素材服务的字节(编辑器不知道这个目录)
const GONE = path.join(EXPORT_DIR, '不存在的素材目录');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(SRC_DIR, { recursive: true });

/* ---- P6～P11 用的 Python 辅助(claude/asset-path-2)---- */
/** 带 numpy 的 Python:PROMPTCUT_TEST_PYTHON,或 PATH 上的 python / python3;找不到时 P7～P11 记为失败(探针不静默跳过) */
function findTestPython() {
  for (const cmd of [process.env.PROMPTCUT_TEST_PYTHON, 'python', 'python3'].filter(Boolean)) {
    try {
      const r = spawnSync(cmd, ['-c', 'import sys, numpy; sys.stdout.write(sys.executable)'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      const exe = String(r.stdout || '').trim();
      if (r.status === 0 && exe && fs.existsSync(exe)) return exe;
    } catch { /* 下一个 */ }
  }
  return null;
}
const PY = findTestPython();
const PYLIBS = path.join(EXPORT_DIR, 'pylibs');
const MODELS = path.join(EXPORT_DIR, 'models');
fs.mkdirSync(PYLIBS, { recursive: true });
/** 让 Python 找得到仓库里的包(和 vite-plugin-stt 的 buildEnv 对普通解释器的做法相同) */
const pyEnv = (pylibs) => ({ ...process.env, PYTHONPATH: pylibs + path.delimiter + path.join(ROOT, 'python'), PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PROMPTCUT_PYLIBS: pylibs, PROMPTCUT_MODELS: MODELS });
const spawnPy = (python, a, env) => spawn(python, a, { env, windowsHide: true });
/** 异步跑子进程:计数的远程素材服务就在探针进程里,spawnSync 会卡住事件循环、ffmpeg 发来的请求没人答 */
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
/** promptcut_track 的 result 事件 → 与 get_track(full) 比对的那几项 */
function trackResult(r) {
  const line = String(r.stdout).split(/\r?\n/).find((l) => /"event":\s*"result"/.test(l));
  if (!line) return { error: (r.stdout + r.stderr).slice(-400) };
  const ev = JSON.parse(line);
  return { engine: ev.engine, width: ev.width, height: ev.height, frames: ev.frames, points: ev.points };
}
/** 造一份「老包」:照仓库里的 promptcut_track 拷一份,去掉 ACCEPTS_URL 与地址放行(桌面版只打 Node 补丁时运行时里的包就是这样) */
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
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
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
  return until('编辑器进程起来', async () => (await fetch(EDITOR + '/api/prerender/info').then((r) => r.ok, () => false)) || null, 120000);
}
function stopEditor() {
  if (!editor || editor.exitCode !== null || !editor.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editor.kill('SIGKILL');
}

/* ---- 计数的远程素材服务:GET/HEAD /api/asset/media/<hash>,Range ---- */
const remoteFiles = new Map(); // hash → 文件
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
/** 登记这个对话的等级:真的走 /api/ai/chat,provider 不存在,登记之后起模型那一步直接报错,不花额度 */
const register = (conv, creativity) => fetch(`${EDITOR}/api/ai/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ provider: 'probe-none', prompt: 'x', conversationId: conv, creativity, projectCreativity: 'high' }),
}).then((r) => r.text()).catch(() => '');

/** 沙箱里算:每声道 RMS / 峰值,加上全部样本字节的 FNV-1a 指纹 */
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

/** 探针自己按改前的读法(ffmpeg 直接读本地文件)测响度 */
function loudnessDirect(ffmpeg, file) {
  const r = spawnSync(ffmpeg, measureArgs({ file }), { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return parseEbur128(r.stderr);
}

let browser = null;
try {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('找不到 ffmpeg(把它放进 PATH 或设 PROMPTCUT_FFMPEG)');
  const gen = (name, lavfi) => {
    const file = path.join(SRC_DIR, name);
    const r = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...lavfi, file], { windowsHide: true });
    if (r.status !== 0) throw new Error(`生成 ${name} 失败:${String(r.stderr).slice(0, 200)}`);
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
  if (!(await startEditor())) throw new Error('编辑器进程没起来');
  check(fs.readdirSync(MEDIA_DIR).length === 0, '开始时编辑器的素材目录是空的', fs.readdirSync(MEDIA_DIR));

  browser = await puppeteer.launch({ headless: true, pipe: true, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(EDITOR + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => { const m = await import('/src/store/project.ts'); return !!m.getState().project; }, { timeout: 180000, polling: 500 });
  const placed = await page.evaluate(async ({ sine, noise, ghost, gone }) => {
    const m = await import('/src/store/project.ts');
    m.actions.newProject?.();
    // url 不带扩展名、path 指向不存在的目录:按目录拼文件名找不到,只能经素材服务按哈希找
    const a = m.actions.addMedia({ id: 'm-sine', kind: 'audio', name: 'sine.wav', url: `/@media/${sine}`, hash: sine, path: `${gone}\\sine.wav`, duration: 3 });
    const b = m.actions.addMedia({ id: 'm-noise', kind: 'audio', name: 'noise.wav', url: `/@media/${noise}`, hash: noise, path: `${gone}\\noise.wav`, duration: 20 });
    const c = m.actions.addMedia({ id: 'm-ghost', kind: 'audio', name: 'ghost.wav', url: `/@media/${ghost}`, hash: ghost, path: `${gone}\\ghost.wav`, duration: 3 });
    const clip = m.actions.addMediaClip(a.id, 1, { duration: 2 });
    return { sine: a.id, noise: b.id, ghost: c.id, clipId: clip?.id ?? null, hashes: m.getState().project.media.map((x) => x.hash ?? null) };
  }, { sine: sine.hash, noise: noise.hash, ghost: ghostHash, gone: GONE });
  out.placed = placed;
  check(!!placed.clipId && placed.hashes.includes(sine.hash), '素材记录进了项目(带哈希)、正弦波放上了时间轴', placed);

  /* ---- P1 连上远程素材服务 ---- */
  const base = `http://127.0.0.1:${REMOTE_PORT}/api/asset`;
  const set = await fetch(EDITOR + '/api/media/remote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base }) }).then((r) => r.json()).catch(() => null);
  const status = await fetch(EDITOR + '/api/media/remote').then((r) => r.json()).catch(() => null);
  check(set?.ok && status?.base === base, 'P1 编辑器连上了这台远程素材服务', status);

  /* ---- P2 measure_audio ---- */
  const direct = loudnessDirect(ffmpeg, noise.file);
  out.loudDirect = pick(direct);
  const loud = await until('measure_audio 测噪声素材', async () => {
    const r = await mcpCall('measure_audio', { mediaId: placed.noise });
    return r && typeof r.integrated === 'number' ? r : (r && !/找不到素材|编辑台没有打开/.test(String(r.error || '')) ? r : null);
  }, 90000, 1000);
  out.loud = loud && { ...pick(loud), error: loud.error };
  check(loud && JSON.stringify(pick(loud)) === JSON.stringify(pick(direct)), 'P2 measure_audio 的数值与直接读本地文件(改前的读法)逐项相同', { now: pick(loud), direct: pick(direct) });
  const noiseHits = hitsOf(noise.hash);
  check(noiseHits >= 1, `P2 远程素材服务被请求过噪声素材(${noiseHits} 次 GET):字节经素材服务的接口来`, remoteLog.filter((e) => e.hash === noise.hash).slice(0, 8));

  /* ---- P3 measure_audio_js ---- */
  const conv = `approbe${Date.now().toString(36)}`;
  await register(conv, 'high');
  const pcmDirect = await decodePcm(ffmpeg, filePcmArgs({ file: sine.file, sampleRate: 16000, channels: 2 }), { channels: 2, sampleRate: 16000 });
  const js = await mcpCall('measure_audio_js', { mediaId: placed.sine, code: RMS_PEAK_FNV }, conv);
  out.js = js;
  check(js?.ok === true && js.value?.channels?.length === 2 && js.value.channels.every((ch) => near(ch.rmsDb, RMS, 0.05) && near(ch.peakDb, PEAK, 0.1)),
    'P3 measure_audio_js:两个声道的 RMS / 峰值与理论值一致', js);
  check(js?.value?.fnv === fnvOf(pcmDirect) && js?.value?.frames === pcmDirect[0].length, 'P3 沙箱拿到的 PCM 与直接解码本地文件的逐字节相同(FNV 指纹、帧数)', { now: js?.value?.fnv, direct: fnvOf(pcmDirect), frames: js?.value?.frames, directFrames: pcmDirect[0].length });
  check(hitsOf(sine.hash) >= 1, `P3 远程素材服务被请求过正弦波素材(${hitsOf(sine.hash)} 次 GET)`);
  const clipJs = await mcpCall('measure_audio_js', { clipId: placed.clipId, mono: true, sampleRate: 48000, code: RMS_PEAK_FNV }, conv);
  check(clipJs?.ok === true && near(clipJs.value?.channels?.[0]?.rmsDb, RMS, 0.05), 'P3 片段档(mono、48 kHz)照常', clipJs && { ok: clipJs.ok, error: clipJs.error, v: clipJs.value?.channels });

  /* ---- P6～P11 三个感知工具(claude/asset-path-2):字节经素材服务来,结果与直接读本地文件相同 ---- */
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

  // P6 detect_shots(编辑器没有 Python 模型,走 scdet 兜底档):转场时刻与直接对本地文件跑 scdet 的相同
  const scdetDirect = [...String(spawnSync(ffmpeg, ['-hide_banner', '-i', cuts.file, '-vf', 'scdet=threshold=10', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true }).stderr)
    .matchAll(/lavfi\.scd\.time:\s*([0-9.]+)/g)].map((x) => Number(x[1]));
  const started = await mcpCall('detect_shots', { mediaId: vids.cuts });
  const shots = await until('list_shots 出结果', async () => {
    const r = await mcpCall('list_shots', { mediaId: vids.cuts });
    return r && (r.running === false || r.error) ? r : null;
  }, 120000, 1000);
  out.shots = shots && { engine: shots.engine, transitions: shots.transitions?.map((t) => t.time), error: shots.error, started };
  check(shots?.running === false && JSON.stringify(shots.transitions.map((t) => t.time)) === JSON.stringify(scdetDirect) && scdetDirect.length === 2,
    'P6 detect_shots:转场时刻与直接对本地文件跑 scdet 的相同(两次硬切)', { now: shots?.transitions?.map((t) => t.time), direct: scdetDirect, error: shots?.error });
  check(hitsOf(cuts.hash) >= 1, `P6 远程素材服务被请求过这段视频(${hitsOf(cuts.hash)} 次 GET)`);

  if (!PY) {
    fails.push('P7～P11 要一个带 numpy 的 Python(PATH 上的 python,或 PROMPTCUT_TEST_PYTHON),这台机器上没找到');
  } else {
    // P7 track_points(模板匹配档):追出来的与直接对本地文件跑 promptcut_track 的逐项相同
    const POINTS = [[0, 28, 58]];
    const direct = trackResult(await runAsync(PY, ['-m', 'promptcut_track', 'track', '--video', move.file, '--points', JSON.stringify(POINTS)], pyEnv(PYLIBS)));
    const moveHits0 = hitsOf(move.hash);
    const tStart = await mcpCall('track_points', { mediaId: vids.move, points: POINTS });
    const track = await until('get_track 出结果', async () => {
      const r = await mcpCall('get_track', { mediaId: vids.move, full: true });
      return r && (r.running === false || r.error) ? r : null;
    }, 120000, 1000);
    const trackNow = track && { engine: track.engine, width: track.width, height: track.height, frames: track.frames, points: track.points };
    check(track?.engine === 'template' && JSON.stringify(trackNow) === JSON.stringify(direct),
      'P7 track_points(模板匹配档):经素材服务追出来的与直接读本地文件的逐项相同', { now: trackNow && { ...trackNow, points: trackNow.points?.map((p) => [p.xy[0], p.xy.at(-1)]) }, direct: direct && direct.points?.map((p) => [p.xy[0], p.xy.at(-1)]), error: track?.error, started: tStart });
    // 页面登记素材后,本地素材服务可能已经按预取清单把整份从远程拉进本地内容库(P7 开始前),所以这里只看远程总共被请求过没有:
    // 编辑器的素材目录一开始是空的、素材记录的 path 指向不存在的目录,字节只可能经素材服务来
    check(hitsOf(move.hash) >= 1, `P7 远程素材服务被请求过这段视频(共 ${hitsOf(move.hash)} 次 GET,其中 P7 期间 ${hitsOf(move.hash) - moveHits0} 次)`);

    // P8 detect_subjects:这台机器没有主体检测的模型;地址要过得了 Python 的入口检查,停在「未就绪」而不是「找不到视频文件」
    const sStart = await mcpCall('detect_subjects', { mediaId: vids.move, times: [0.5, 1.2] });
    const subj = await until('list_subjects 结束', async () => {
      const r = await mcpCall('list_subjects', { mediaId: vids.move });
      return r && (r.running === false || r.error) ? r : null;
    }, 180000, 1000);
    out.subjects = { started: sStart, result: subj && (subj.error || { engine: subj.engine, samples: subj.samples?.length }) };
    check(subj && !/找不到视频文件/.test(String(subj.error || '')) && (subj.running === false ? subj.samples?.length === 2 : /未就绪/.test(String(subj.error))),
      'P8 detect_subjects:地址过了入口检查(装了模型就出两个样本;没装停在「未就绪」)', out.subjects);

    // P9 三个 Python 包都答 ACCEPTS_URL(Node 据此递地址)
    for (const pkg of ['promptcut_shots', 'promptcut_track', 'promptcut_subject']) {
      check(await pythonAcceptsUrl({ python: PY, env: pyEnv(PYLIBS), pkg, spawnPython: spawnPy }), `P9 ${pkg} 答 ACCEPTS_URL`);
    }

    // P10 老包(拷一份仓库里的 promptcut_track,去掉 ACCEPTS_URL 与地址放行):拒绝地址;Node 改走临时文件,结果相同,临时文件用完删
    const oldLibs = path.join(EXPORT_DIR, 'pylibs-old');
    makeOldTrackPackage(oldLibs);
    const url = `http://127.0.0.1:${REMOTE_PORT}/api/asset/media/${move.hash}`;
    const refused = await runAsync(PY, ['-m', 'promptcut_track', 'track', '--video', url, '--points', JSON.stringify(POINTS)], pyEnv(oldLibs));
    check(/找不到视频文件/.test(refused.stdout), 'P10 老包确实拒绝地址', refused.stdout.slice(-300));
    const input = await pythonInput({ src: url, ref: { name: 'move.mp4' }, python: PY, env: pyEnv(oldLibs), pkg: 'promptcut_track', spawnPython: spawnPy, tmpRoot: EXPORT_DIR });
    check(input.via === 'temp' && fs.readFileSync(input.input).equals(fs.readFileSync(move.file)), 'P10 老包:Node 先把字节流到临时文件(与原文件逐字节相同)', { via: input.via });
    const viaTemp = trackResult(await runAsync(PY, ['-m', 'promptcut_track', 'track', '--video', input.input, '--points', JSON.stringify(POINTS)], pyEnv(oldLibs)));
    input.cleanup();
    check(JSON.stringify(viaTemp) === JSON.stringify(direct) && !fs.existsSync(input.input), 'P10 老包经临时文件追出来的与直接读文件相同,临时文件已删');

    // P11 主体检测取字节那一步:frames.probe_size + grab_frame 经地址与读本地文件,宽高与 BGR 像素逐字节相同
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
    try { pair = JSON.parse(fc.stdout.trim().split(/\r?\n/).at(-1)); } catch { /* 下面报 */ }
    check(pair && JSON.stringify(pair[0]) === JSON.stringify(pair[1]) && JSON.stringify(pair[0].size) === '[160,120]',
      'P11 主体检测抽帧:经素材服务地址与读本地文件解出的像素逐字节相同', pair ?? fc.stderr.slice(-400));
  }

  /* ---- P4 回到本机空间:只剩本地内容库,按哈希存 ---- */
  await until('远程拉完、进了本地内容库', async () => {
    const s = await fetch(EDITOR + '/api/media/remote').then((r) => r.json());
    return s.jobs.every((j) => j.done) ? s : null;
  }, 30000, 500);
  await fetch(EDITOR + '/api/media/remote', { method: 'DELETE' });
  const lib = fs.readdirSync(MEDIA_DIR);
  out.localLibrary = lib;
  check(lib.some((f) => f.startsWith(noise.hash + '.')) && !lib.includes(noise.hash) && !lib.includes('noise.wav'),
    'P4 本地内容库里是 <hash>.<ext>:按目录拼 url 的最后一段(<hash>)或文件名都找不到', lib);
  const before = remoteLog.length;
  const loud2 = await mcpCall('measure_audio', { mediaId: placed.noise });
  check(loud2 && JSON.stringify(pick(loud2)) === JSON.stringify(pick(direct)), 'P4 本机空间:measure_audio 照常、数值不变', loud2 && { ...pick(loud2), error: loud2.error });
  const js2 = await mcpCall('measure_audio_js', { mediaId: placed.sine, code: RMS_PEAK_FNV }, conv);
  check(js2?.ok === true && js2.value?.fnv === fnvOf(pcmDirect), 'P4 本机空间:measure_audio_js 照常、PCM 不变', js2 && { ok: js2.ok, error: js2.error, fnv: js2.value?.fnv });
  check(remoteLog.length === before, 'P4 远程素材服务一次也没被打到', remoteLog.slice(before, before + 5));

  /* ---- P5 哪儿都没有的素材 ---- */
  const g1 = await mcpCall('measure_audio', { mediaId: placed.ghost });
  check(g1 && typeof g1.integrated !== 'number' && /素材文件不存在/.test(String(g1.error || '')), 'P5 measure_audio 对哪儿都没有的素材回「素材文件不存在」', g1);
  const g2 = await mcpCall('measure_audio_js', { mediaId: placed.ghost, code: 'return 1' }, conv);
  check(g2?.ok === false && g2.kind === 'no-media', 'P5 measure_audio_js 回 kind no-media', g2);
  const alive = await fetch(EDITOR + '/api/prerender/info').then((r) => r.ok, () => false);
  check(alive, '编辑器照常应答');
  check(pageErrors.length === 0, '页面没有未捕获的异常', pageErrors.slice(0, 5));
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
console.log(fails.length ? `探针未过:${fails.length} 项失败,${passes.length} 项通过` : `探针通过:${passes.length} 项`);
process.exit(fails.length ? 1 : 0);
