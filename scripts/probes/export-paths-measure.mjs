/**
 * 桌面版导出的两条整路各量一遍(渲染重构「辛」；只量，不换)。
 *
 *   node scripts/probes/export-paths-measure.mjs [--runs 3] [--projects demo,heavy] [--frames 0-59]
 *        [--workers auto] [--port 7460] [--work <目录>] [--json <汇总文件>] [--assets <小图目录>]
 *        [--no-split] [--keep] [--retries 3]
 *
 * 两条路(同一台机器、同一个项目，交替跑：桌面、在线、桌面、在线……，各 `--runs` 遍，缺省 3)：
 *
 *   desktop  桌面版：Chrome(chrome-headless-shell)beginFrame 整帧截图 -> ffmpeg 编成带透明的 ProRes 4444 中间文件
 *            -> 和素材合成、libx264 编成 preview.mp4(`server/bakery/export.mjs`、`export-unified.mjs`、`server/export-compose.mjs`)。
 *            做法同 `/api/export`(`server/vite-plugin-export.ts`)：起 `scripts/export-frames.mjs`，参数相同；探针直接起它，
 *            给每一行输出打时间，按行分段。
 *   online   在线浏览器：整场景快照包成 SVG 画到画布 -> 转 YUV -> WebCodecs 编码 -> 自己封装 MP4(`src/export/browserExport.ts`、
 *            `frameCompositor.ts`)。入口是桌面运行环境里已有的探针入口 `window.__pcIo.exportVideoBrowser`，不加开关。
 *            各段耗时靠探针一侧的计时垫片量(装在页面里，包住 ExportCompositor / Mp4Muxer / VideoEncoder / VideoFrame /
 *            getImageData 的方法，不改产品代码)。
 *
 * 两个项目(夹具配方在 `scripts/probes/fixtures/export-paths/projects.mjs`)：
 *   demo   像素基线的演示项目；heavy  带重卡(WebGL)和画布卡(粒子)的项目。
 *
 * 每个项目记：
 *   - 每条路每一遍的总耗时和各段耗时、成片大小和码率、开跑前整机处理器占用、跑的过程中的平均占用；
 *   - 同一条路各遍成片是否逐帧相同(把成片解成 rgb24 逐帧比 sha1)；
 *   - 两条路的成片逐帧画面差(平均差 0～255、最大通道差、差超过 8 和 32 的像素比例、PSNR)，抽几帧存「桌面 | 在线 | 差×8」对比图；
 *   - 拆段单测(桌面一遍，不进总耗时)：只截图不编码(PNG)、PNG 编 ProRes、ProRes 解码、ProRes 解码加 libx264。
 *     用来交叉核对主流程里按日志分出来的各段(默认路径是先写 PNG、截完再编 ProRes；--workers 1 整段才边截边编，那时两段并行分不开)；
 *   - 机器配置：处理器、核数、内存、显卡、系统、Chrome 版本。
 * 汇总写成一份 JSON(`--json`，缺省在工作目录里)，最后一行也打到标准输出。导出失败、少帧、读不出成片等，退出码非 0。
 *
 * 自己起一台 dev server(端口 `--port` 起连号三个，缺省 7460)，导出目录与素材目录指向工作目录，不碰用户的目录和端口。
 * 工作目录缺省 `out/export-paths-measure/<时间>`(不入库)；`--keep` 保留中间文件(ProRes、逐帧 PNG)，缺省收掉。
 * 机器同时有别的任务在跑时耗时会被干扰：探针照量并如实记占用；要拿正式数字，在机器空闲时重跑。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import：不继承外部的导出目录与数据目录
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

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const o = { runs: 3, projects: ['demo', 'heavy'], frames: null, workers: 'auto', port: 7460, work: null, json: null, assets: null, split: true, keep: false, retries: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} 后面要跟一个值`); return argv[++i]; };
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
    else throw new Error(`不认识的参数 ${a}`);
  }
  for (const p of o.projects) if (!PROJECTS[p]) throw new Error(`没有这个项目 ${p}(有：${Object.keys(PROJECTS).join('、')})`);
  if (!Number.isInteger(o.runs) || o.runs < 1) throw new Error('--runs 要是正整数');
  if (o.frames && !/^\d+-\d+$/.test(o.frames)) throw new Error('--frames 要写成 a-b');
  return o;
}

const log = (m) => console.error(`[export-paths] ${m}`);
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => { const s = xs.filter(Number.isFinite); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };

/* ---------------- 机器与占用 ---------------- */

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; }
  return { idle, total };
}
const cpuBusy = (a, b) => { const dt = b.total - a.total; return dt > 0 ? round((1 - (b.idle - a.idle) / dt) * 100, 1) : null; };

/** 开跑前量一秒整机处理器占用，另记几类进程的个数(别人在跑什么，粗看) */
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
  } catch { /* 读不到就不记 */ }
  return { cpuPct: cpu, freeMemGB: round(os.freemem() / 2 ** 30, 1), procs };
}

/** 跑的过程中每 500 ms 采一次整机占用 */
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
    gpu: gpu ? [].concat(gpu).map((g) => `${g.Name} (驱动 ${g.DriverVersion})`) : null,
    os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version,
    ffmpeg: String(ff.stdout || '').split(/\r?\n/)[0] || null,
    onlineChrome, desktopChromeHeadlessShell: await expectedHeadlessShellVersion(),
    puppeteer: (await import('puppeteer/package.json', { with: { type: 'json' } }).catch(() => ({ default: {} }))).default.version ?? null,
  };
}

/** 有没有可见的终端、控制台、node、chrome、ffmpeg 窗口(排查有没有哪一环弹窗)；探针开跑前后各查一次 */
function visibleWindows() {
  if (process.platform !== 'win32') return [];
  const r = psJson("Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'WindowsTerminal|OpenConsole|cmd|powershell|conhost|node|chrome|ffmpeg' } | Select-Object Id,ProcessName,MainWindowTitle");
  return r ? [].concat(r).map((w) => `${w.Id} ${w.ProcessName} ${w.MainWindowTitle}`) : [];
}

/* ---------------- ffmpeg 小工具 ---------------- */

function runSync(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'buffer', windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}：${String(r.stderr).slice(-500)}`);
  return r.stdout;
}

/** 起一个外部命令，等它结束，回墙钟毫秒；输出不留 */
function timeProc(cmd, args) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      code === 0 ? resolve(ms) : reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${err}`));
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

/** 把成片解成 rgb24，逐帧给出一块 Buffer */
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
  if (code !== 0) throw new Error(`解码 ${path.basename(file)} 失败(ffmpeg ${code})：${err}`);
}

async function frameHashes(ffmpeg, file, w, h) {
  const hashes = [];
  for await (const f of frameStream(ffmpeg, file, w, h)) hashes.push(crypto.createHash('sha1').update(f).digest('hex').slice(0, 16));
  return hashes;
}

/** 同一条路各遍成片逐帧比：和第 1 遍比 */
async function sameRoute(runs, ffmpeg, w, h) {
  const base = runs[0];
  const out = [];
  for (const r of runs.slice(1)) {
    const n = Math.min(base.frameHashes.length, r.frameHashes.length);
    let diff = 0, first = null;
    for (let i = 0; i < n; i++) if (base.frameHashes[i] !== r.frameHashes[i]) { diff++; first ??= i; }
    const rec = { run: r.k, vsRun: base.k, frames: n, frameCountEqual: base.frameHashes.length === r.frameHashes.length, identicalFrames: n - diff, differentFrames: diff, firstDifferentFrame: first, fileSha256Equal: base.fileSha256 === r.fileSha256 };
    // 有不同的帧时量一下差多大(平均差、最大通道差、差超过 32 的像素比例)，分清是抗锯齿末位还是画面真不一样
    if (diff) { const per = (await crossDiff(ffmpeg, base.file, r.file, w, h)).filter((q) => base.frameHashes[q.i] !== r.frameHashes[q.i]); rec.magnitudeOfDifferentFrames = per.length ? { meanAbsDiffMean: round(mean(per.map((q) => q.mean)), 3), maxChannelDiff: Math.max(...per.map((q) => q.max)), fracOver32MaxPct: round(Math.max(...per.map((q) => q.over32)) * 100, 3), worstFrame: per.reduce((x, y) => (y.mean > x.mean ? y : x)).i } : null; }
    out.push(rec);
  }
  return out;
}

/** 两条路成片逐帧画面差 */
export async function crossDiff(ffmpeg, fileA, fileB, w, h) {
  const per = [];
  const a = frameStream(ffmpeg, fileA, w, h), b = frameStream(ffmpeg, fileB, w, h);
  const px = w * h;
  for (let i = 0; ; i++) {
    const [ra, rb] = await Promise.all([a.next(), b.next()]);
    if (ra.done || rb.done) {
      // 另一边没读完的也要排空，免得 ffmpeg 子进程挂着
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

/** 抽几帧存「桌面 | 在线 | |差|×8」对比图 */
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

/* ---------------- 搭项目(在编辑器页面里用 store 的动作搭) ---------------- */

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
    if (!media || media.pending || !media.url) throw new Error('素材导入没完成');
    // 导入后素材服务还会在后台重封装、生成小尺寸(ffmpeg)：等它们做完再往下，免得和第一遍测量抢处理器
    for (let i = 0; i < 300 && !getState().project.media[0]?.tiers?.small; i++) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 1500));
    // 导入可能自己放了一段素材片段：先清掉，再按配方放
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
      if (!clip) throw new Error(`放不进片段 ${layer.cardId || 'media'}`);
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

/** 照 `normalizeExportMedia`(server/vite-plugin-export.ts)：有哈希的素材地址写成 /@media/<哈希> */
function exportJsonOf(project) {
  const p = JSON.parse(JSON.stringify(project));
  for (const m of p.media || []) {
    const hash = m.hash || m.tiers?.original;
    if (hash) m.url = `/@media/${hash}`;
  }
  return p;
}

/* ---------------- 桌面那条路 ---------------- */

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
  if (code !== 0) throw new Error(`桌面导出退出码 ${code}：${tail.slice(-1500)}`);

  const first = (re) => marks.find((m) => re.test(m.line));
  const last = (re) => [...marks].reverse().find((m) => re.test(m.line));
  const frameMarks = marks.filter((m) => /^Exported frame \d+ \(\d+\/\d+\)/.test(m.line));
  const shardLine = first(/^分片导出:/);
  const shards = shardLine ? (shardLine.line.match(/(\d+) 段/) || [])[1] : '1';
  const tFirstFrame = frameMarks[0]?.t ?? null;
  const tLastFrame = frameMarks.at(-1)?.t ?? null;
  const tRunning = first(/^Running ffmpeg to generate video files/)?.t ?? null;
  const tCreating = first(/^Creating preview\.mp4/)?.t ?? null;
  const composed = last(/^Composited \d+ frames in [\d.]+s/);
  const tComposedEnd = composed?.t ?? null;
  const composedSec = composed ? Number(composed.line.match(/in ([\d.]+)s/)[1]) : null;
    // 默认(workers=auto)的整段导出：先把每帧 PNG 写进 frames/，截完再起一趟 ffmpeg 把 PNG 编成 ProRes(日志有「Creating overlay.mov...」)；
  // 只有「单进程且整段」(--workers 1 且没有 --frames)时才边截边把 PNG 流给 ffmpeg 编 ProRes(日志没有这一行)，那时截图和 ProRes 并行，分不开
  const tOverlay = first(/^Creating overlay\.mov/)?.t ?? null;
  const proresMode = noVideo ? null : (tOverlay !== null ? 'png-files-then-encode' : 'streamed-during-capture');
  const segments = noVideo ? { startupToFirstFrameMs: tFirstFrame, captureMs: tFirstFrame !== null && tLastFrame !== null ? tLastFrame - tFirstFrame : null } : {
    // 进程起来 -> 第一帧截图出来(含 Node 启动、开 Chrome、载页、预热)
    startupToFirstFrameMs: tFirstFrame,
    // 第一帧 -> 最后一帧：截图(含写 PNG)。streamed 模式下这里还含并行的 ProRes 编码
    captureMs: tFirstFrame !== null && tLastFrame !== null ? tLastFrame - tFirstFrame : null,
    // 最后一帧 -> 「Running ffmpeg」：截图收尾、(多分片时合并分片)
    captureEndToFfmpegMs: tRunning !== null && tLastFrame !== null ? tRunning - tLastFrame : null,
    // PNG -> ProRes 4444 中间文件(png-files-then-encode 模式才有)：「Creating overlay.mov」 -> 「Creating preview.mp4」
    proresEncodeMs: tOverlay !== null && tCreating !== null ? tCreating - tOverlay : null,
    // 「Creating preview.mp4」 -> 「Composited N frames」：一趟 ffmpeg，解 ProRes + 铺素材层(默认路径里素材已在 Chrome 截图里，这里 0 层)+ libx264 编码，分不开
    composeAndX264Ms: composedSec !== null ? composedSec * 1000 : (tComposedEnd !== null && tCreating !== null ? tComposedEnd - tCreating : null),
    // 合成结束 -> 进程退出：混音(没有声音就几乎是 0)、收尾
    afterComposeMs: tComposedEnd !== null ? wallMs - tComposedEnd : null,
  };
  const out = path.join(dir, 'preview.mp4');
  return { dir, out, wallMs, cpu, shards: Number(shards), proresMode, segments, sizes: {
    overlayMovBytes: fs.existsSync(path.join(dir, 'overlay.mov')) ? fs.statSync(path.join(dir, 'overlay.mov')).size : null,
  }, marks: marks.map((m) => ({ t: round(m.t, 0), line: m.line })).filter((m) => /^(分片|Warm-up|Export finished|Running ffmpeg|Creating|Composited \d+ frames|No audio|Audio muxed|Video synthesis|Launching|Navigating|Waiting for)/.test(m.line)).slice(0, 40), frameLines: frameMarks.length };
}

/* ---------------- 在线那条路 ---------------- */

/** 页面里装计时垫片：包住几处方法记时间，不改产品代码。top 窗口之外(导出页 iframe)的调用不计 */
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
    page.on('pageerror', (e) => log(`页面错误：${String(e).slice(0, 200)}`));
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
    if (!r.result) throw new Error(`在线导出失败：${r.error || '没有结果'}${r.waits?.length ? '；等待提示：' + r.waits.join('|').slice(0, 200) : ''}`);
    await fsp.writeFile(outFile, Buffer.from(r.base64, 'base64'));
    const M = await page.evaluate(() => window.__pcM);
    const total = r.result.ms;
    const st = r.result.stats || {};
    // 垫片量到的段：都是主线程上的墙钟。编码器本身在浏览器的另一个线程里跑，与画帧重叠，能看到的只有「等它」的部分
    const startupBeforeOpen = M.tOpenStart !== null && M.tCall !== undefined ? M.tOpenStart - M.tCall : null;
    const segments = {
      startupBeforeOpenMs: startupBeforeOpen, // 导出前：能力探测、导出前核对
      openExportPageMs: M.openMs,             // 开同源导出页、灌项目、等就绪
      stepMs: st.stepMs,                      // 画面：推到这一帧(含第一帧的预热)
      snapshotMs: st.snapshotMs,              // 画面：生成整场景快照
      mediaMs: st.mediaMs,                    // 画面：素材帧装好、画成图替进快照
      rasterMs: st.rasterMs,                  // 画面：快照包成 SVG 画到画布
      getImageDataMs: M.getImageDataMs,       // 读像素
      toYuvMs: M.yuvMs,                       // RGBA 转 I420
      encodeSubmitMs: M.encodeMs,             // VideoEncoder.encode() 调用本身
      waitEncodeQueueMs: M.queueWaitMs,       // 等编码队列有空位(编码器比画帧慢时才有)
      flushMs: M.flushMs,                     // 全部帧送完后等编码器吐完
      muxMs: M.muxMs,                         // 封装(逐块写盒子 + 收尾)
    };
    const known = Object.values(segments).reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0);
    segments.otherMs = total - known;          // 其余：帧间的零碎(onProgress、await 之间)、垫片误差
    return { totalMs: total, evalWallMs, cpu, frames: r.result.frames, bytes: r.result.bytes, videoCodec: r.result.videoCodec, audio: r.result.audio,
      segments, frameStats: { frames: st.frames, heavyReplaced: st.heavyReplaced, mediaFrames: st.mediaFrames, manualTicks: st.manualTicks, rafFallbacks: st.rafFallbacks }, chunks: M.chunks };
  } finally {
    await page.close().catch(() => {});
  }
}

/* ---------------- 汇总 ---------------- */

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

/* ---------------- 主流程 ---------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(fs.readFileSync(import.meta.filename, 'utf8').split('*/')[0]); return 0; }
  const work = opts.work || path.join(REPO, 'out', 'export-paths-measure', stamp());
  assertNoUserExportDir({ PROMPTCUT_EXPORT_DIR: work }, 'export-paths-measure 的工作目录');
  await fsp.mkdir(work, { recursive: true });
  const jsonFile = opts.json || path.join(work, 'summary.json');
  const assetsDir = opts.assets || path.join(work, 'assets');
  await fsp.mkdir(assetsDir, { recursive: true });
  log(`工作目录 ${work}`);

  const ffmpeg = await findFfmpeg();
  const ffprobe = ffprobeOf(ffmpeg);
  const failures = [];
  const windowsBefore = visibleWindows();
  const result = { ok: false, probe: 'export-paths-measure', startedAt: new Date().toISOString(), argv: process.argv.slice(2), work, options: { runs: opts.runs, projects: opts.projects, frames: opts.frames, workers: opts.workers, split: opts.split }, projects: {}, failures };

  // 素材：320x180 testsrc2，没有声音(同像素基线的夹具)
  const mediaFile = path.join(work, FIXTURE_VIDEO.name);
  runSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${FIXTURE_VIDEO.width}x${FIXTURE_VIDEO.height}:r=${FIXTURE_VIDEO.fps}:d=${FIXTURE_VIDEO.seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-an', mediaFile]);

  const env = { PROMPTCUT_EXPORT_DIR: work };
  let server = null, browser = null;
  const cleanup = () => { try { if (server) server.stop(); } catch { /* 已经停了 */ } };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { cleanup(); process.exit(130); });

  try {
    server = await startDevServer({ env, logFile: path.join(work, 'vite.log'), port: opts.port, log });
    log(`dev server 就绪 ${server.origin}(舞台 ${server.stagePorts.join(' / ')})`);
    browser = await puppeteer.launch({ headless: true, protocolTimeout: 1800000,
      args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
    result.machine = await machineInfo({ ffmpeg, onlineChrome: await browser.version() });
    // 在线那条路用的编码器：能不能走硬件、WebGL 渲染器(用的是哪块显卡)。页面里只能问到「支持哪种偏好」，问不到最终选了哪个
    {
      const pg = await browser.newPage();
      await pg.goto(`${server.origin}/api/mcp/status`, { waitUntil: 'domcontentloaded' });
      result.machine.onlineBrowserEncoder = await pg.evaluate(async () => {
        const base = { codec: 'avc1.640028', width: 1280, height: 720, framerate: 30, bitrate: 2764800, avc: { format: 'avc' }, latencyMode: 'quality' };
        const sup = async (pref) => { try { return !!(await VideoEncoder.isConfigSupported({ ...base, hardwareAcceleration: pref })).supported; } catch { return null; } };
        let gl = null;
        try { const c = document.createElement('canvas').getContext('webgl'); const e = c.getExtension('WEBGL_debug_renderer_info'); gl = e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : null; } catch { /* 没有 WebGL */ }
        return { secureContext: isSecureContext, preferHardware: await sup('prefer-hardware'), preferSoftware: await sup('prefer-software'), noPreference: await sup('no-preference'), webglRenderer: gl, config: 'avc1.640028 1280x720@30 约 2.76 Mbps，latencyMode quality(src/export/capability.ts 的 videoConfigOf，不指定硬件偏好)' };
      });
      await pg.close();
    }

    for (const name of opts.projects) {
      const spec = PROJECTS[name];
      log(`—— 项目 ${name}：${spec.note}`);
      // 搭项目
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

      // 预热(不进统计)：刚起的 dev server 第一次载导出页要现场编译一批模块，实测第一次桌面导出会在预热帧上 20 秒没就绪。
      // 桌面跑一趟只出 PNG 的整段(各卡都挂一遍)，在线跑前 60 帧，各自失败了照样重试
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
            log(`预热 ${route} 第 ${attempt} 次失败：${String(e.message || e).slice(0, 160).replace(/\s+/g, ' ')}`);
            P.warmup[`${route}Failures`] = (P.warmup[`${route}Failures`] || 0) + 1;
            if (attempt === 3) failures.push(`${name} 预热 ${route} 3 次都失败：${String(e.message || e).slice(-600)}`);
            else await sleep(3000 * attempt);
          }
        }
      }

      // 交替跑：桌面、在线、桌面、在线……
      for (let k = 1; k <= opts.runs; k++) {
        for (const route of ['desktop', 'online']) {
          const before = await loadBefore();
          log(`${name} ${route} 第 ${k}/${opts.runs} 遍(开跑前整机占用 ${before.cpuPct}%，空闲内存 ${before.freeMemGB} GB)`);
          const id = `${name}-${route[0]}${k}`;
          const file = route === 'desktop' ? null : path.join(work, `${name}-online-${k}.mp4`);
          // 暂时性故障(机器被别的任务压住、导出页 20 秒没就绪这类)重试，最多 3 次；每次失败都记下，3 次都失败才算这一遍失败
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
              if (rec.video.frames !== expectFrames) failures.push(`${name} ${route} 第 ${k} 遍成片帧数 ${rec.video.frames}，应为 ${expectFrames}`);
              P[route].runs.push(rec);
              done = true;
              log(`  完成 ${round(rec.totalMs / 1000, 1)} s，${rec.video.frames} 帧，${round(rec.video.bytes / 1e6, 2)} MB，${rec.video.bitrateKbps} kbps，跑的过程平均占用 ${rec.cpuDuring.meanPct}%${attempts.length ? `(前面失败了 ${attempts.length} 次)` : ''}`);
            } catch (e) {
              const msg = String(e.message || e).slice(-1500);
              attempts.push((msg.length > 500 ? msg.slice(0, 200) + ' … ' + msg.slice(-250) : msg));
              log(`  第 ${attempt} 次失败：${msg.slice(0, 200).replace(/\s+/g, ' ')}`);
              if (attempt === opts.retries) failures.push(`${name} ${route} 第 ${k} 遍失败(试了 ${opts.retries} 次)：${msg}`);
              else await sleep(3000 * attempt);
            }
          }
          await sleep(1500);
        }
      }

      // 同一条路各遍逐帧相同吗；两条路的画面差
      const w = project.width, h = project.height;
      for (const route of ['desktop', 'online']) {
        const runs = P[route].runs;
        for (const r of runs) r.frameHashes = await frameHashes(ffmpeg, r.file, w, h);
        P[route].repeatability = runs.length > 1 ? await sameRoute(runs, ffmpeg, w, h) : null;
      }
      const d1 = P.desktop.runs[0], o1 = P.online.runs[0];
      if (d1 && o1) {
        log(`${name}：两条路成片逐帧比较(桌面第 1 遍 vs 在线第 1 遍)`);
        const per = await crossDiff(ffmpeg, d1.file, o1.file, w, h);
        P.crossPathDiff = summarizeDiff(per, d1.frameHashes.length, o1.frameHashes.length);
        const sorted = [...per].sort((a, b) => a.mean - b.mean);
        const pick = [...new Set([sorted[sorted.length >> 1]?.i, per.reduce((x, y) => (y.mean > x.mean ? y : x)).i, Math.max(0, Math.floor(per.length * 0.25))])].filter((v) => v !== undefined);
        P.crossPathDiff.images = (await saveDiffTiles(ffmpeg, d1.file, o1.file, w, h, pick, assetsDir, name)).map((x) => ({ frame: x.frame, file: path.relative(REPO, x.file).replace(/\\/g, '/'), bytes: x.bytes }));
        P.crossPathDiff.perFrameSample = per.filter((p) => p.i % 30 === 0).map((p) => ({ i: p.i, mean: round(p.mean, 3), max: p.max, over32Pct: round(p.over32 * 100, 3), psnr: round(p.psnr, 2) }));
        if (!P.crossPathDiff.frameCountEqual) failures.push(`${name} 两条路成片帧数不同：${P.crossPathDiff.framesA} vs ${P.crossPathDiff.framesB}`);
      } else failures.push(`${name} 缺一条路的成片，没法比画面差`);

      // 拆段单测
      if (opts.split && d1?.keepDir) {
        log(`${name}：拆段单测`);
        P.split = {};
        try {
          let nv = null;
          for (let attempt = 1; attempt <= 3 && !nv; attempt++) {
            try { nv = await runDesktop({ origin: server.origin, work, id: `${name}-split`, project, frames: opts.frames, workers: opts.workers, noVideo: true }); }
            catch (e) { log(`  拆段单测第 ${attempt} 次失败：${String(e.message || e).slice(0, 160).replace(/\s+/g, ' ')}`); if (attempt === 3) throw e; await sleep(3000 * attempt); }
          }
          const nPng = fs.readdirSync(path.join(nv.dir, 'frames')).filter((f) => f.endsWith('.png')).length;
          P.split.captureOnlyPng = { wallMs: round(nv.wallMs, 0), frames: nPng, startupToFirstFrameMs: round(nv.segments.startupToFirstFrameMs, 0), captureMs: round(nv.segments.captureMs, 0), note: '只截图落 PNG(--no-video)，不编码；截图自身的墙钟，含写盘' };
          const pngDir = path.join(nv.dir, 'frames');
          const mov = path.join(work, `${name}-split-prores.mov`);
          const first = Math.min(...fs.readdirSync(pngDir).filter((f) => f.endsWith('.png')).map((f) => parseInt(f, 10)));
          P.split.pngToProres = { wallMs: round(await timeProc(ffmpeg, ['-y', '-v', 'error', '-framerate', String(fps), '-start_number', String(first), '-i', path.join(pngDir, '%06d.png'), '-an', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', mov]), 0), bytes: fs.statSync(mov).size, note: '读 PNG 序列再编 ProRes 4444(单独跑；主流程里是边截边编)' };
          const overlay = path.join(d1.keepDir, 'overlay.mov');
          P.split.proresDecodeOnly = { wallMs: round(await timeProc(ffmpeg, ['-v', 'error', '-i', overlay, '-an', '-f', 'null', '-']), 0), note: '只解 ProRes 到空输出' };
          const x264Out = path.join(work, `${name}-split-x264.mp4`);
          P.split.proresDecodeAndX264 = { wallMs: round(await timeProc(ffmpeg, ['-y', '-v', 'error', '-i', overlay, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', x264Out]), 0), bytes: fs.statSync(x264Out).size, note: '解 ProRes 加 libx264(同主流程的编码参数，没有素材层)；减去上一项近似 libx264 本身' };
          P.split.x264Approx = { wallMs: round(P.split.proresDecodeAndX264.wallMs - P.split.proresDecodeOnly.wallMs, 0), note: '近似值：两次单测相减，两次读盘与解码有重叠，仅作量级' };
          if (!opts.keep) { await fsp.rm(nv.dir, { recursive: true, force: true }); await fsp.rm(mov, { force: true }); await fsp.rm(x264Out, { force: true }); }
        } catch (e) { failures.push(`${name} 拆段单测失败：${String(e.message || e).slice(-1500)}`); }
        if (!opts.keep) await fsp.rm(d1.keepDir, { recursive: true, force: true });
        delete d1.keepDir;
      }

      // 汇总
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
    failures.push(`探针异常：${e?.stack || e}`);
  } finally {
    await browser?.close().catch(() => {});
    cleanup();
  }

  const windowsAfter = visibleWindows();
  result.visibleWindows = { before: windowsBefore, after: windowsAfter, newAfter: windowsAfter.filter((w) => !windowsBefore.includes(w)) };
  if (result.visibleWindows.newAfter.length) failures.push(`跑完后多出可见窗口：${result.visibleWindows.newAfter.join(' | ')}`);
  result.finishedAt = new Date().toISOString();
  result.ok = failures.length === 0;
  await fsp.writeFile(jsonFile, JSON.stringify(result, null, 2));
  log(`汇总 ${jsonFile}`);
  console.log(JSON.stringify({ ok: result.ok, json: jsonFile, failures, faster: Object.fromEntries(Object.entries(result.projects).map(([k, v]) => [k, v.faster])) }));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
