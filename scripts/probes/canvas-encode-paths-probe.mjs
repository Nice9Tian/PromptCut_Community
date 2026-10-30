#!/usr/bin/env node
/**
 * 己零:量「画布的像素怎么到编码器」的三条路。出处:`docs/plan/prerender-products-contract.md` 第 6.2、6.3 节与第 13.2 节「己零」。
 *
 * 单文件、零依赖:只用 Node 内置模块和 Node 22 以上自带的全局 WebSocket、fetch(按 Node 24 写)。
 * 不引 puppeteer,不引仓库里任何模块;页面的 HTML 和脚本内嵌在本文件里。把这一个文件拷到别的机器(例如 Linux 渲染节点)的
 * 临时目录就能跑。自己起无头 Chrome、自己说 CDP(Chrome DevTools Protocol)。
 *
 *   node canvas-encode-paths-probe.mjs --chrome <chrome 或 chrome-headless-shell 的可执行文件> [选项]
 *
 *   --chrome <路径>        必填。节点上是 chrome-headless-shell 152
 *   --no-gpu               给 Chrome 加 --disable-gpu 系列(与 server/bakery/chrome.mjs 一致),模拟节点没有显卡
 *   --no-sandbox           给 Chrome 加 --no-sandbox(以 root 跑要它)
 *   --ffmpeg <路径>        缺省 ffmpeg(在 PATH 里找)
 *   --out <目录>           缺省 ./canvas-encode-paths-out;summary.json、各路产物、临时 Chrome 用户目录都在它下面
 *   --frames <数>          缺省 90
 *   --sizes 960x540,1920x1080   画面尺寸(偶数),缺省这两种
 *   --scenes particles,three    缺省两种
 *   --fps <数>             缺省 30
 *   --hw no-preference,prefer-software   浏览器编码器额外按哪几种 hardwareAcceleration 各跑一遍;缺省两种
 *   --chrome-arg <参数>    追加给 Chrome 的启动参数,可重复
 *   --timeout <秒>         每条路每个场景的时限(防卡死),缺省 300
 *
 * 量什么(契约第 6.3 节的五项),每种场景 × 每种尺寸:
 *   1. Chrome 版本、是不是无头壳、WebGL 的渲染器(UNMASKED_RENDERER)。
 *   2. VideoEncoder.isConfigSupported:avc1 基线 / 主 / 高三个档次 × 拼合后的两种尺寸 × hardwareAcceleration 取「不限」和「只用软件」。
 *   3. 浏览器自带的编码器:画布拼成上半颜色、下半不透明度(streamEncode.ts 的拼法),VideoEncoder,每 15 帧一个关键帧;
 *      记每秒压多少帧、字节数;VideoDecoder 解回来的帧数;解回来和原画比的颜色、不透明度平均差(满分 255,抽若干帧比全图)。
 *   4. 原始像素交给 ffmpeg:页面里读出画布的 RGBA(2D 用 getImageData,WebGL 用 readPixels 并翻转、反预乘),用 fetch POST 到探针在
 *      127.0.0.1 上起的 HTTP 口,探针喂给 ffmpeg(rawvideo + rgba,滤镜链和 libx264 参数抄 server/bakery/ffmpeg.mjs)。
 *      分段记每帧毫秒数:读像素、搬到 Node、编码;再把 ffmpeg 的产物解回来和原画比同样两个差。
 *   5. 现在的办法作基线:CDP Page.captureScreenshot(PNG、背景透明、clip 到画布),PNG 交给 ffmpeg(image2pipe)。同样分段、同样比差。
 *
 * 判据(契约第 6.3 节):某条路在这台机器上「可用」= 编得出来、解回来帧数对、颜色平均差不到 1、不透明度平均差不到 0.5。
 * 探针只给数字和「可用 / 不可用」标记,不替人下「用哪条」的结论。
 *
 * 输出:`--out` 下的 summary.json(全部数字和机器信息);标准输出最后一行是它的路径。
 * 退出码:任一场景(某个尺寸)三条路全都跑不出来 → 1;参数不对或 Chrome 起不来 → 2;其余 0(某条路「不可用」不影响退出码)。
 *
 * 场景是真实卡片的替身,不是卡片本身:
 *   粒子 = 2D 画布上几百个半透明小圆点(像 particles 卡);
 *   三维 = WebGL 画布上带光照的转动球体加一圈环(像 scene-3d)。两者都带透明背景,按帧号直接算(不靠真实时间)。
 *
 * 耗时的口径:
 *   - 「画」(把这一帧画到画布上)三条路都一样,不算进对比;截图那条还要等两次 requestAnimationFrame 让合成器出帧,也归入「画」。
 *   - 「端到端每帧」= (从第一帧开始到最后一个字节产出的总墙钟 − 画的总耗时) / 帧数。读、搬、编码在流水线上是重叠的,
 *     所以三段之和可能大于端到端;「编码」另有一个单独量的数(同一批已缓存的 15 帧反复喂 ffmpeg 凑 90 帧,没有页面参与)。
 *   - ffmpeg 那两条路按生产的做法:每 15 帧一个 ffmpeg 进程(openStreamSegmentEncoder 的一个分段),并预先拉起下一个进程。
 *   - 浏览器那条路的「搬」是最后把全部编码块一次 POST 给 Node 的耗时。
 *
 * ffmpeg 兼容:节点上是 4.4.2,不用 -vsync / -fps_mode 之类新旧版本不一的选项。
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PROBE_VERSION = 1;
const SEGMENT_FRAMES = 15;
const COLOR_MEAN_MAX = 1;      // 判据:颜色平均差(0~255)要小于它
const ALPHA_MEAN_MAX = 0.5;    // 判据:不透明度平均差要小于它
const HALF_PAD = 8;            // 拼合后两个半区下面各垫的黑边行数(streamEncode.ts 的 STREAM_HALF_PAD)

/* ====================================================================== 参数 */

function parseArgs(argv) {
  const o = { chrome: null, noGpu: false, noSandbox: false, ffmpeg: 'ffmpeg', out: null, frames: 90, sizes: '960x540,1920x1080',
    scenes: 'particles,three', fps: 30, hw: 'no-preference,prefer-software', chromeArg: [], timeoutSec: 300, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} 缺少取值`); return argv[++i]; };
    switch (a) {
      case '--chrome': o.chrome = val(); break;
      case '--no-gpu': o.noGpu = true; break;
      case '--no-sandbox': o.noSandbox = true; break;
      case '--ffmpeg': o.ffmpeg = val(); break;
      case '--out': o.out = val(); break;
      case '--frames': o.frames = Number(val()); break;
      case '--sizes': o.sizes = val(); break;
      case '--scenes': o.scenes = val(); break;
      case '--fps': o.fps = Number(val()); break;
      case '--hw': o.hw = val(); break;
      case '--chrome-arg': o.chromeArg.push(val()); break;
      case '--timeout': o.timeoutSec = Number(val()); break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`不认识的参数 ${a}`);
    }
  }
  if (o.help) return o;
  if (!o.chrome) throw new Error('要 --chrome <可执行文件路径>');
  if (!fs.existsSync(o.chrome)) throw new Error(`--chrome 指的文件不存在:${o.chrome}`);
  if (!Number.isInteger(o.frames) || o.frames < 1) throw new Error('--frames 要是正整数');
  if (!(o.fps > 0)) throw new Error('--fps 要是正数');
  o.sizeList = o.sizes.split(',').map(s => s.trim()).filter(Boolean).map((s) => {
    const m = /^(\d+)x(\d+)$/.exec(s);
    if (!m) throw new Error(`--sizes 里的 ${s} 不是 宽x高`);
    const w = Number(m[1]), h = Number(m[2]);
    if (w % 2 || h % 2) throw new Error(`尺寸要是偶数:${s}`);
    return { w, h, label: `${w}x${h}` };
  });
  o.sceneList = o.scenes.split(',').map(s => s.trim()).filter(Boolean);
  for (const s of o.sceneList) if (!['particles', 'three'].includes(s)) throw new Error(`不认识的场景 ${s}(particles / three)`);
  o.hwList = o.hw.split(',').map(s => s.trim()).filter(Boolean);
  o.out = path.resolve(o.out || 'canvas-encode-paths-out');
  return o;
}

/* ====================================================================== 小工具 */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const round = (x, n = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** n) / 10 ** n : null);
const log = (...a) => console.error('[探针]', ...a);

function withTimeout(promise, ms, label) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${label} 超时(${Math.round(ms / 1000)} 秒)`), { timeout: true })), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

/** 自己起的子进程都登记在这里,结束时(包括出错)统统收掉 */
const children = new Set();
function track(proc) { children.add(proc); proc.once('exit', () => children.delete(proc)); return proc; }
function killTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else { try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } }
  } catch { /* 已经没了 */ }
}
function killAllChildren() { for (const p of [...children]) killTree(p); }
/** 兜底:命令行里带着我们这个临时用户目录的进程(Chrome 的各个子进程)统统结束。目录名是随机的,不会误伤别人的进程。回结束了几个 */
function killByProfileDir(dir) {
  const leaf = path.basename(dir);
  let n = 0;
  try {
    if (process.platform === 'win32') {
      const out = tryExec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `$n=0; Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome|headless' -and $_.CommandLine -like '*${leaf}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; $n`], 20000);
      n = Number(out) || 0;
    } else {
      for (const pid of fs.readdirSync('/proc').filter(x => /^d+$/.test(x))) {
        try {
          if (fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes(leaf)) { process.kill(Number(pid), 'SIGKILL'); n++; }
        } catch { /* 进程已没了或读不了 */ }
      }
    }
  } catch { /* 兜底而已 */ }
  return n;
}

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const k of Object.keys(c.times)) total += c.times[k]; idle += c.times.idle; }
  return { idle, total };
}
async function sampleCpuBusy(ms = 1000) {
  const a = cpuTimes(); await sleep(ms); const b = cpuTimes();
  const total = b.total - a.total;
  return total > 0 ? round(100 * (1 - (b.idle - a.idle) / total), 1) : null;
}

function tryExec(cmd, args, timeout = 8000) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

function hostInfo() {
  const cpus = os.cpus();
  let gpus = null;
  if (process.platform === 'win32') {
    const t = tryExec('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join "|"']);
    gpus = t ? t.split('|').filter(Boolean) : null;
  } else {
    const lines = [];
    const lspci = tryExec('lspci', []);
    if (lspci) for (const l of lspci.split('\n')) if (/VGA|3D controller|Display controller/i.test(l)) lines.push(l.replace(/^\S+\s+/, ''));
    const nv = tryExec('nvidia-smi', ['-L']);
    if (nv) lines.push(...nv.split('\n').filter(Boolean));
    gpus = lines.length ? lines : [];
  }
  let dri = null;
  if (process.platform !== 'win32') { try { dri = fs.readdirSync('/dev/dri'); } catch { dri = []; } }
  return {
    cpu: cpus[0]?.model?.trim() ?? null, logicalCores: cpus.length, availableParallelism: typeof os.availableParallelism === 'function' ? os.availableParallelism() : null,
    memGiB: round(os.totalmem() / 2 ** 30, 1), platform: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version,
    gpuAdapters: gpus, hasGpu: gpus === null ? null : gpus.length > 0, devDri: dri,
  };
}

/* ====================================================================== ffmpeg 命令行(抄自 server/bakery/ffmpeg.mjs,提交 37d5ce4f) */

const STREAM_X264_ARGS = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-bf', '0'];
const STREAM_INPUT_ARGS = ['-probesize', '32', '-analyzeduration', '0', '-threads', '1'];

function streamFilterThreads() {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, Math.floor(Number(cpus)) || 1));
}
function streamFilter(pixFmt = 'yuv420p') {
  return '[0:v]format=gbrap,split=2[p][a];'
    + '[p]premultiply=inplace=1,format=gbrp,pad=iw:ih+8:0:0:black[rgb];'
    + '[a]alphaextract,format=gbrp,pad=iw:ih+8:0:0:black[mask];'
    + `[rgb][mask]vstack=inputs=2,scale=out_range=tv:out_color_matrix=bt709,format=${pixFmt}`;
}
/** 输出端:滤镜链之后到 pipe:1 */
function streamOutputArgs(fps) {
  return ['-filter_complex', streamFilter('yuv420p'), ...STREAM_X264_ARGS,
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-video_track_timescale', String(fps),
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-an', '-f', 'mp4', 'pipe:1'];
}
const COMMON_HEAD = (threads) => ['-y', '-hide_banner', '-loglevel', 'error', '-filter_complex_threads', String(threads), '-reinit_filter', '0'];
/** 现在的办法:PNG 经 image2pipe 进 stdin(streamSegmentArgs 原样) */
function pngSegmentArgs(fps) {
  return [...COMMON_HEAD(streamFilterThreads()), ...STREAM_INPUT_ARGS, '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(fps), '-i', 'pipe:0', ...streamOutputArgs(fps)];
}
/** 新的一种输入:rawvideo + rgba,后面的滤镜链和编码器不变 */
function rawSegmentArgs(w, h, fps) {
  return [...COMMON_HEAD(streamFilterThreads()), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${w}x${h}`, '-framerate', String(fps), '-i', 'pipe:0', ...streamOutputArgs(fps)];
}

/** 一个分段 = 一个 ffmpeg 进程:帧从 stdin 喂,fMP4 字节从 stdout 收 */
class SegmentProc {
  constructor(ffmpeg, args) {
    this.proc = track(spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    this.out = []; this.outLen = 0; this.err = ''; this.inputError = null; this.ended = false;
    this.proc.stdout.on('data', (d) => { this.out.push(d); this.outLen += d.length; });
    this.proc.stderr.on('data', (d) => { this.err = (this.err + d).slice(-3000); });
    this.proc.stdin.on('error', (e) => { this.inputError = e; });
    this.done = new Promise((resolve, reject) => {
      this.proc.on('error', reject);
      this.proc.on('close', (code) => (code === 0 ? resolve(Buffer.concat(this.out, this.outLen))
        : reject(new Error(`ffmpeg 退出码 ${code}:${this.err.trim().split(/\r?\n/).slice(-3).join(' | ')}`))));
    });
    this.done.catch(() => {});
  }
  async write(buf) {
    try {
      if (this.inputError) throw this.inputError;
      await new Promise((resolve, reject) => this.proc.stdin.write(buf, (e) => (e ? reject(e) : resolve())));
    } catch (e) {
      // 管道断了多半是 ffmpeg 自己退了:把它的报错原文带出来
      await Promise.race([this.done, sleep(500)]);
      throw e;
    }
  }
  end() { if (!this.ended) { this.ended = true; try { this.proc.stdin.end(); } catch { /* 已断 */ } } return this.done; }
  kill() { this.ended = true; killTree(this.proc); }
}

/**
 * 按分段喂帧的流水线(生产里 openStreamSegmentEncoder 的用法):每 15 帧换一个 ffmpeg 进程,下一个进程预先拉起。
 * `write(i, buf)` 按帧号顺序喂;`finish()` 回每段的 fMP4 字节。段与段之间不互相等(上一段在后台收尾)。
 */
class SegmentPipeline {
  constructor(ffmpeg, args) { this.ffmpeg = ffmpeg; this.args = args; this.cur = null; this.spare = null; this.pending = []; this.frames = 0; this.firstWriteAt = null; }
  async write(i, buf) {
    if (this.firstWriteAt === null) this.firstWriteAt = performance.now();
    if (i % SEGMENT_FRAMES === 0) {
      this.cur = this.spare || new SegmentProc(this.ffmpeg, this.args);
      this.spare = new SegmentProc(this.ffmpeg, this.args);
    }
    await this.cur.write(buf);
    this.frames++;
    if (i % SEGMENT_FRAMES === SEGMENT_FRAMES - 1) { this.pending.push(this.cur.end()); this.cur = null; }
  }
  async finish() {
    if (this.cur) { this.pending.push(this.cur.end()); this.cur = null; }
    if (this.spare) { this.spare.kill(); this.spare = null; }
    const t = performance.now();
    const segments = await Promise.all(this.pending);
    return { segments, tailMs: performance.now() - t, wallMs: performance.now() - (this.firstWriteAt ?? t) };
  }
  abort() { if (this.cur) this.cur.kill(); if (this.spare) this.spare.kill(); }
}

/** 只量编码:拿已缓存的一批帧(≤15)循环喂满 `frames` 帧,没有页面参与。回每帧毫秒数 */
async function isolatedEncodeMs(ffmpeg, args, cached, frames) {
  const pipe = new SegmentPipeline(ffmpeg, args);
  const t = performance.now();
  try {
    for (let i = 0; i < frames; i++) await pipe.write(i, cached[i % SEGMENT_FRAMES % cached.length]);
    await pipe.finish();
  } catch (e) { pipe.abort(); throw e; }
  return (performance.now() - t) / frames;
}

/* ====================================================================== 解回来比对(Node 一侧,给 ffmpeg 的产物用) */

/** 把一个 fMP4 分段用 ffmpeg 解成 rgb24 的原始帧,逐帧回调。色彩按 bt709 限定范围展开 */
function decodeSegment(ffmpeg, bytes, frameSize, onFrame) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-an',
      '-vf', 'scale=in_range=tv:in_color_matrix=bt709:out_range=pc,format=rgb24', '-f', 'rawvideo', 'pipe:1'];
    const proc = track(spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    let err = '', pend = [], pendLen = 0, n = 0, fail = null;
    proc.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    proc.stdin.on('error', () => { /* 看退出码 */ });
    proc.stdout.on('data', (d) => {
      pend.push(d); pendLen += d.length;
      while (pendLen >= frameSize) {
        const all = pend.length === 1 ? pend[0] : Buffer.concat(pend, pendLen);
        try { onFrame(all.subarray(0, frameSize), n++); } catch (e) { fail = fail || e; }
        const rest = all.subarray(frameSize);
        pend = rest.length ? [rest] : []; pendLen = rest.length;
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (fail) return reject(fail);
      if (code !== 0) return reject(new Error(`ffmpeg 解码退出码 ${code}:${err.trim().split(/\r?\n/).slice(-3).join(' | ')}`));
      resolve(n);
    });
    proc.stdin.end(bytes);
  });
}

/** 一帧解出来的 rgb24(拼合画面)对原画(straight RGBA)的差:色半区对预乘色,透明度半区对 alpha */
function compareDecoded(dec, ref, w, h, acc) {
  const alphaTop = h + HALF_PAD;
  for (let y = 0; y < h; y++) {
    let p = y * w;
    let t = p * 3;
    let b = ((y + alphaTop) * w) * 3;
    for (let x = 0; x < w; x++, p++, t += 3, b += 3) {
      const q = p * 4;
      const a = ref[q + 3];
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(dec[t + c] - Math.round((ref[q + c] * a) / 255));
        acc.colorSum += d; if (d > acc.colorMax) acc.colorMax = d;
      }
      const da = Math.abs(dec[b] - a);
      acc.alphaSum += da; if (da > acc.alphaMax) acc.alphaMax = da;
    }
  }
  acc.colorN += w * h * 3; acc.alphaN += w * h; acc.compared++;
}

async function decodeAndCompare(ffmpeg, segments, w, h, refs) {
  const frameSize = w * (2 * h + 2 * HALF_PAD) * 3;
  const acc = { colorSum: 0, colorN: 0, colorMax: 0, alphaSum: 0, alphaN: 0, alphaMax: 0, compared: 0 };
  let decoded = 0;
  for (let s = 0; s < segments.length; s++) {
    const n = await decodeSegment(ffmpeg, segments[s], frameSize, (frame, k) => {
      const ref = refs.get(s * SEGMENT_FRAMES + k);
      if (ref) compareDecoded(frame, ref, w, h, acc);
    });
    decoded += n;
  }
  return { decoded, compared: acc.compared, colorMean: acc.colorN ? round(acc.colorSum / acc.colorN, 3) : null, alphaMean: acc.alphaN ? round(acc.alphaSum / acc.alphaN, 3) : null, colorMax: acc.colorMax, alphaMax: acc.alphaMax };
}

/* ====================================================================== 预览图(把参照帧垫在棋盘格上存成 PNG,人眼核对场景画得对不对) */

const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
async function zlibDeflate(buf) { const { deflateSync } = await import('node:zlib'); return deflateSync(buf); }
async function writePreviewPng(file, rgba, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4, a = rgba[q + 3] / 255, bg = ((x >> 4) + (y >> 4)) & 1 ? 200 : 140;
      for (let c = 0; c < 3; c++) raw[row + 1 + x * 3 + c] = Math.round(rgba[q + c] * a + bg * (1 - a));
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', await zlibDeflate(raw)), pngChunk('IEND', Buffer.alloc(0))]));
}

/* ====================================================================== CDP(自己说,不用库) */

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.ws = null; }
  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('连不上 Chrome 的调试口')), { once: true });
      ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
        if (m.id === undefined) return;
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${p.method}:${m.error.message}`)); else p.resolve(m.result);
      });
      ws.addEventListener('close', () => { for (const p of this.pending.values()) p.reject(new Error('调试连接已关闭')); this.pending.clear(); });
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 120000) {
    const id = ++this.id;
    const msg = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)); }, timeoutMs);
      this.pending.set(id, { method, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify(msg));
    });
  }
  close() { try { this.ws?.close(); } catch { /* 已关 */ } }
}

async function launchChrome(opts, userDataDir) {
  const args = ['--headless', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-field-trial-config', '--force-device-scale-factor=1', '--window-position=-32000,-32000',
    ...(opts.noGpu ? ['--disable-gpu', '--disable-gpu-rasterization', '--disable-gpu-compositing', '--enable-unsafe-swiftshader'] : []),
    ...(opts.noSandbox ? ['--no-sandbox'] : []),
    ...opts.chromeArg, 'about:blank'];
  const proc = track(spawn(opts.chrome, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }));
  let stderr = '';
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome 30 秒内没给出调试地址。stderr:${stderr.slice(-600)}`)), 30000);
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome 退出了(${code})。stderr:${stderr.slice(-600)}`)); });
  });
  return { proc, wsUrl, args };
}

/* ====================================================================== 页面(内嵌;下面这个函数的源码原样塞进 <script>) */

function pageMain() {
  const P = (window.P = {});
  const S = { scene: null, kind: null, w: 0, h: 0, canvas: null, ctx: null, gl: null, drawFn: null, refs: new Map(), rb: null, sb: null };
  const now = () => performance.now();
  const SEG = 15, PAD = 8;

  function mulberry32(a) {
    return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  /* ---------------------------------------------------------------- 信息 */
  P.info = () => {
    const out = { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, secureContext: isSecureContext,
      videoEncoder: typeof VideoEncoder === 'function', videoDecoder: typeof VideoDecoder === 'function', offscreenCanvas: typeof OffscreenCanvas === 'function',
      webgl: null, webgl2Available: false };
    try {
      const c = document.createElement('canvas');
      out.webgl2Available = !!c.getContext('webgl2');
    } catch { /* 记 false */ }
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl');
      if (!gl) out.webgl = { available: false };
      else {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        out.webgl = { available: true, version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(gl.RENDERER),
          unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null, unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null };
        const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      }
    } catch (e) { out.webgl = { available: false, error: String(e) }; }
    return out;
  };

  /* ---------------------------------------------------------------- 场景 */
  P.setup = (scene, w, h) => {
    if (S.canvas) {
      try { if (S.gl) { const l = S.gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); } } catch { /* 忽略 */ }
      S.canvas.remove();
    }
    Object.assign(S, { scene, w, h, ctx: null, gl: null, drawFn: null, kind: null, rb: null, sb: null });
    S.refs.clear();
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.style.cssText = `position:absolute;left:0;top:0;width:${w}px;height:${h}px`;
    document.body.appendChild(c);
    S.canvas = c;
    if (scene === 'particles') setupParticles(c, w, h);
    else if (scene === 'three') setupThree(c, w, h);
    else throw new Error('不认识的场景 ' + scene);
    return { ok: true, kind: S.kind };
  };

  function setupParticles(c, w, h) {
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('拿不到 2D 上下文');
    S.ctx = ctx; S.kind = '2d';
    const rnd = mulberry32(20261013), sc = h / 540, ps = [];
    for (let k = 0; k < 400; k++) {
      ps.push({ x0: rnd() * w, y0: rnd() * h, vx: (rnd() - 0.5) * 5 * sc, vy: (rnd() - 0.5) * 4 * sc, r: (1.5 + rnd() * 6) * sc, hue: Math.floor(rnd() * 360), a0: 0.15 + rnd() * 0.5, ph: rnd() * 6.283 });
    }
    S.drawFn = (i) => {
      ctx.clearRect(0, 0, w, h);
      for (const p of ps) {
        let x = (p.x0 + p.vx * i) % w; if (x < 0) x += w;
        let y = (p.y0 + p.vy * i + Math.sin(i * 0.07 + p.ph) * 12 * sc) % h; if (y < 0) y += h;
        const r = p.r * (1 + 0.25 * Math.sin(i * 0.11 + p.ph));
        ctx.fillStyle = `hsla(${p.hue},85%,65%,${(p.a0 * (0.6 + 0.4 * Math.sin(i * 0.05 + p.ph))).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283185307); ctx.fill();
      }
    };
  }

  function setupThree(c, w, h) {
    const gl = c.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, depth: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL 不可用(getContext 返回 null)');
    S.gl = gl; S.kind = 'webgl';
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('着色器编译失败:' + gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, `
      attribute vec3 aPos; attribute vec3 aNrm;
      uniform mat4 uMVP; uniform mat4 uMV; uniform mat3 uRot;
      varying vec3 vN; varying vec3 vV; varying vec3 vM;
      void main(){ gl_Position = uMVP * vec4(aPos,1.0); vN = uRot * aNrm; vV = (uMV * vec4(aPos,1.0)).xyz; vM = aPos; }`));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, `
      precision highp float;
      varying vec3 vN; varying vec3 vV; varying vec3 vM;
      uniform vec3 uBase; uniform float uStripe;
      void main(){
        vec3 n = normalize(vN); vec3 l = normalize(vec3(0.45,0.7,0.55));
        float d = max(dot(n,l),0.0);
        vec3 hv = normalize(l + normalize(-vV)); float s = pow(max(dot(n,hv),0.0), 40.0);
        float st = 0.5 + 0.5 * sin(vM.y * uStripe + vM.x * 2.0);
        vec3 base = mix(uBase, uBase.bgr * 0.8 + 0.1, st);
        vec3 col = base * (0.2 + 0.8 * d) + vec3(0.8) * s * 0.6;
        gl_FragColor = vec4(col, 1.0);
      }`));
    gl.bindAttribLocation(prog, 0, 'aPos'); gl.bindAttribLocation(prog, 1, 'aNrm');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('着色器链接失败:' + gl.getProgramInfoLog(prog));
    const U = {}; for (const n of ['uMVP', 'uMV', 'uRot', 'uBase', 'uStripe']) U[n] = gl.getUniformLocation(prog, n);

    const makeMesh = (pos, nrm, idx) => {
      const mk = (target, data) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
      return { p: mk(gl.ARRAY_BUFFER, new Float32Array(pos)), n: mk(gl.ARRAY_BUFFER, new Float32Array(nrm)), i: mk(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx)), count: idx.length };
    };
    const grid = (nu, nv, fn) => {
      const pos = [], nrm = [], idx = [];
      for (let u = 0; u <= nu; u++) for (let v = 0; v <= nv; v++) { const r = fn(u / nu * 6.283185307, v / nv * 6.283185307); pos.push(...r.p); nrm.push(...r.n); }
      for (let u = 0; u < nu; u++) for (let v = 0; v < nv; v++) { const a = u * (nv + 1) + v, b = a + nv + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
      return makeMesh(pos, nrm, idx);
    };
    const sphere = grid(96, 48, (th, ph) => { const lat = ph / 2; const x = Math.sin(lat) * Math.cos(th), y = Math.cos(lat), z = Math.sin(lat) * Math.sin(th); return { p: [x * 1.05, y * 1.05, z * 1.05], n: [x, y, z] }; });
    const ring = grid(96, 24, (th, ph) => { const R = 1.75, r = 0.16; const cx = Math.cos(ph), sx = Math.sin(ph); return { p: [(R + r * cx) * Math.cos(th), (R + r * cx) * Math.sin(th), r * sx], n: [cx * Math.cos(th), cx * Math.sin(th), sx] }; });

    const mul = (a, b) => { const o = new Float32Array(16); for (let cc = 0; cc < 4; cc++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[cc * 4 + k]; o[cc * 4 + r] = s; } return o; };
    const persp = (fovy, asp, n, f) => { const t = 1 / Math.tan(fovy / 2); return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]); };
    const rotX = (a) => { const c2 = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c2, s, 0, 0, -s, c2, 0, 0, 0, 0, 1]); };
    const rotY = (a) => { const c2 = Math.cos(a), s = Math.sin(a); return new Float32Array([c2, 0, -s, 0, 0, 1, 0, 0, s, 0, c2, 0, 0, 0, 0, 1]); };
    const rotZ = (a) => { const c2 = Math.cos(a), s = Math.sin(a); return new Float32Array([c2, s, 0, 0, -s, c2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); };
    const trans = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
    const proj = persp(40 * Math.PI / 180, w / h, 0.1, 20), view = trans(0, 0, -3.1);

    const drawMesh = (m, model, base, stripe) => {
      const mv = mul(view, model), mvp = mul(proj, mv);
      gl.uniformMatrix4fv(U.uMVP, false, mvp); gl.uniformMatrix4fv(U.uMV, false, mv);
      gl.uniformMatrix3fv(U.uRot, false, new Float32Array([model[0], model[1], model[2], model[4], model[5], model[6], model[8], model[9], model[10]]));
      gl.uniform3fv(U.uBase, base); gl.uniform1f(U.uStripe, stripe);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.p); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.n); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.i);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
    };
    const tiny = new Uint8Array(4);
    S.drawFn = (i) => {
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.useProgram(prog);
      drawMesh(sphere, mul(rotZ(0.4), rotY(i * 0.06)), new Float32Array([0.25, 0.55, 0.95]), 7.0);
      drawMesh(ring, mul(mul(rotY(0.35 * Math.sin(i * 0.04)), rotX(1.25 + 0.2 * Math.sin(i * 0.06))), rotZ(i * 0.05)), new Float32Array([0.95, 0.7, 0.2]), 14.0);
      // 软件 WebGL 的命令是拖到有人读像素时才执行的:不等它画完,「画」的耗时会漏到第一个取像素的那一步里,三条路的对比就不干净
      gl.finish();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, tiny);   // 读一个像素逼它现在就画完(finish 在软件 WebGL 上不一定等)
    };
    S.rb = new Uint8Array(w * h * 4); S.sb = new Uint8Array(w * h * 4);
  }

  P.draw = (i) => { S.drawFn(i); };
  P.drawSettle = async (i) => {
    S.drawFn(i);
    await new Promise((r) => requestAnimationFrame(() => r()));
    await new Promise((r) => requestAnimationFrame(() => r()));
  };

  /** 读出这一帧画布的 straight-alpha RGBA(上到下)。回 { data, gpuMs, convMs } */
  function readStraight() {
    const w = S.w, h = S.h;
    if (S.kind === '2d') {
      const a = now(); const img = S.ctx.getImageData(0, 0, w, h);
      return { data: new Uint8Array(img.data.buffer), gpuMs: now() - a, convMs: 0 };
    }
    const gl = S.gl, src = S.rb, dst = S.sb;
    const a = now(); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src); const b = now();
    // readPixels 是下到上、预乘:翻转并反预乘(给 ffmpeg 的 rgba 要 straight)
    const rowB = w * 4;
    for (let y = 0; y < h; y++) {
      let s = (h - 1 - y) * rowB, d = y * rowB;
      for (let x = 0; x < w; x++, s += 4, d += 4) {
        const al = src[s + 3];
        if (al === 255) { dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = 255; }
        else if (al === 0) { dst[d] = 0; dst[d + 1] = 0; dst[d + 2] = 0; dst[d + 3] = 0; }
        else {
          const k = 255 / al;
          dst[d] = Math.min(255, Math.round(src[s] * k)); dst[d + 1] = Math.min(255, Math.round(src[s + 1] * k)); dst[d + 2] = Math.min(255, Math.round(src[s + 2] * k)); dst[d + 3] = al;
        }
      }
    }
    return { data: dst, gpuMs: b - a, convMs: now() - b };
  }

  const post = async (url, body) => { const r = await fetch(url, { method: 'POST', body }); if (!r.ok) throw new Error(`POST ${url}:${r.status} ${(await r.text()).slice(0, 300)}`); };

  /** 抽样帧的参照:画一遍、读出 straight RGBA,留一份在页面里,也 POST 给 Node */
  P.makeRefs = async (indices) => {
    let covered = 0, total = 0;
    for (const i of indices) {
      S.drawFn(i);
      const r = readStraight();
      const copy = r.data.slice();
      S.refs.set(i, copy);
      for (let p = 3; p < copy.length; p += 4) { total++; if (copy[p] > 0) covered++; }
      await post('/ref/' + i, copy);
    }
    return { count: indices.length, opaqueFraction: total ? covered / total : 0 };
  };

  /* ---------------------------------------------------------------- 编码器能力 */
  const levelOf = (pw, ph) => { const px = pw * ph; return px <= 414720 ? 0x1e : px <= 921600 ? 0x1f : px <= 2088960 ? 0x28 : px <= 5652480 ? 0x32 : px <= 9437184 ? 0x33 : 0x34; };
  const avcCodec = (profileHex, pw, ph) => `avc1.${profileHex}${levelOf(pw, ph).toString(16).padStart(2, '0')}`;
  const bitrateFor = (pw, ph, fps) => Math.max(1000000, Math.round(pw * ph * fps * 0.2));

  P.supportMatrix = async (w, h, fps) => {
    const ph = 2 * h + 2 * PAD;
    const rows = [];
    if (typeof VideoEncoder !== 'function') return { packed: `${w}x${ph}`, rows, error: '没有 VideoEncoder' };
    for (const [profile, hex] of [['baseline', '4200'], ['main', '4D00'], ['high', '6400']]) {
      for (const hw of ['no-preference', 'prefer-software']) {
        for (const mode of ['quantizer', 'variable']) {
          const config = { codec: avcCodec(hex, w, ph), width: w, height: ph, framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality', hardwareAcceleration: hw, bitrateMode: mode, ...(mode === 'variable' ? { bitrate: bitrateFor(w, ph, fps) } : {}) };
          const row = { profile, codec: config.codec, hardwareAcceleration: hw, bitrateMode: mode, supported: false };
          try { const r = await VideoEncoder.isConfigSupported(config); row.supported = !!r.supported; } catch (e) { row.error = String(e && e.message || e).slice(0, 200); }
          rows.push(row);
        }
      }
    }
    return { packed: `${w}x${ph}`, rows };
  };

  /* ---------------------------------------------------------------- 浏览器自带的编码器 */
  P.runBrowserEncoder = async ({ frames, fps, hw, quantizer, indices }) => {
    const w = S.w, h = S.h, ph = 2 * h + 2 * PAD;
    if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function') throw new Error('这个浏览器没有 VideoEncoder / VideoFrame');
    // 配置:高档,先按固定量化,不认再按码率(照 streamEncode.ts 的 probeStreamEncoder)
    const base = { codec: avcCodec('6400', w, ph), width: w, height: ph, framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality', ...(hw && hw !== 'no-preference' ? { hardwareAcceleration: hw } : {}) };
    let cfg = null, mode = null;
    for (const [m, extra] of [['quantizer', { bitrateMode: 'quantizer' }], ['variable', { bitrateMode: 'variable', bitrate: bitrateFor(w, ph, fps) }]]) {
      const c = { ...base, ...extra };
      try { const r = await VideoEncoder.isConfigSupported(c); if (r && r.supported) { cfg = c; mode = m; break; } } catch { /* 下一种 */ }
    }
    if (!cfg) throw new Error(`编码器不认 ${w}x${ph} 的 ${base.codec}(hardwareAcceleration=${hw})`);

    const packedC = new OffscreenCanvas(w, ph), pg = packedC.getContext('2d', { alpha: false });
    const scrC = new OffscreenCanvas(w, h), sg = scrC.getContext('2d');
    const drawPacked = (src) => {
      pg.globalCompositeOperation = 'source-over'; pg.fillStyle = '#000'; pg.fillRect(0, 0, w, ph);
      pg.drawImage(src, 0, 0, w, h);
      sg.globalCompositeOperation = 'source-over'; sg.clearRect(0, 0, w, h); sg.drawImage(src, 0, 0, w, h);
      sg.globalCompositeOperation = 'source-in'; sg.fillStyle = '#fff'; sg.fillRect(0, 0, w, h);
      sg.globalCompositeOperation = 'source-over';
      pg.drawImage(scrC, 0, h + PAD, w, h);
    };

    const chunks = []; let decCfg = null, encErr = null;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && !decCfg) {
          const d = meta.decoderConfig.description;
          const desc = d ? (ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d)).slice() : undefined;
          decCfg = { codec: meta.decoderConfig.codec, description: desc };
        }
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        chunks.push({ type: chunk.type, timestamp: chunk.timestamp, data });
      },
      error: (e) => { encErr = e; },
    });
    enc.configure(cfg);

    let paintMs = 0, packMs = 0, waitMs = 0;
    const t0 = now();
    for (let i = 0; i < frames; i++) {
      if (encErr) throw new Error('编码器出错:' + encErr);
      let a = now(); S.drawFn(i); paintMs += now() - a;
      a = now();
      drawPacked(S.canvas);
      const vf = new VideoFrame(packedC, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      try { enc.encode(vf, { keyFrame: i % SEG === 0, ...(mode === 'quantizer' ? { avc: { quantizer } } : {}) }); } finally { vf.close(); }
      packMs += now() - a;
      a = now();
      while (!encErr && enc.encodeQueueSize > 3) await new Promise((r) => enc.addEventListener('dequeue', r, { once: true }));
      waitMs += now() - a;
    }
    let a2 = now(); await enc.flush(); waitMs += now() - a2;
    const loopMs = now() - t0;
    enc.close();
    if (encErr) throw new Error('编码器出错:' + encErr);

    const problems = [];
    if (chunks.length !== frames) problems.push(`送进去 ${frames} 帧,出来 ${chunks.length} 个样本`);
    let keyOk = true, orderOk = true, lastTs = -1;
    chunks.forEach((c, k) => { if ((c.type === 'key') !== (k % SEG === 0)) keyOk = false; if (c.timestamp <= lastTs) orderOk = false; lastTs = c.timestamp; });
    if (!keyOk) problems.push('关键帧位置不是每 15 帧一个');
    if (!orderOk) problems.push('出来的样本时间戳不单调(有 B 帧重排)');
    const bytes = chunks.reduce((s, c) => s + c.data.length, 0);

    // 交给 Node(把全部编码块一次 POST 过去,量搬运)
    a2 = now();
    const all = new Uint8Array(bytes); let off = 0; for (const c of chunks) { all.set(c.data, off); off += c.data.length; }
    await post('/seg', all);
    const handoffMs = now() - a2;

    // 解回来
    const out = { frames, mode, codec: cfg.codec, hardwareAcceleration: hw || 'no-preference', packed: `${w}x${ph}`, bytes, kbps: Math.round(bytes * 8 / (frames / fps) / 1000),
      paintMs, packMs, waitMs, loopMs, handoffMs, problems, decoded: 0, compared: 0, colorMean: null, alphaMean: null, colorMax: null, alphaMax: null, decodeMs: null };
    if (!decCfg) { problems.push('编码器没有给出 decoderConfig'); return out; }
    let decSupported = false;
    try { const r = await VideoDecoder.isConfigSupported({ codec: decCfg.codec, codedWidth: w, codedHeight: ph, description: decCfg.description }); decSupported = !!r.supported; } catch { /* 记 false */ }
    if (!decSupported) { problems.push('VideoDecoder 不认这个配置(' + decCfg.codec + ')'); return out; }
    const og = new OffscreenCanvas(w, ph).getContext('2d', { willReadFrequently: true });
    const acc = { cs: 0, cn: 0, cm: 0, as: 0, an: 0, am: 0, n: 0 };
    let decErr = null, decoded = 0;
    const compare = (frame, idx) => {
      const ref = S.refs.get(idx); if (!ref) return;
      og.drawImage(frame, 0, 0);
      const top = og.getImageData(0, 0, w, h).data, bot = og.getImageData(0, h + PAD, w, h).data;
      for (let p = 0; p < w * h; p++) {
        const q = p * 4, al = ref[q + 3];
        for (let cc = 0; cc < 3; cc++) { const d = Math.abs(top[q + cc] - Math.round(ref[q + cc] * al / 255)); acc.cs += d; if (d > acc.cm) acc.cm = d; }
        const da = Math.abs(bot[q] - al); acc.as += da; if (da > acc.am) acc.am = da;
      }
      acc.cn += w * h * 3; acc.an += w * h; acc.n++;
    };
    const dec = new VideoDecoder({
      output: (f) => { try { decoded++; compare(f, Math.round(f.timestamp * fps / 1e6)); } catch (e) { decErr = decErr || e; } finally { f.close(); } },
      error: (e) => { decErr = decErr || e; },
    });
    dec.configure({ codec: decCfg.codec, codedWidth: w, codedHeight: ph, description: decCfg.description });
    const td = now();
    for (let k = 0; k < chunks.length; k++) {
      const c = chunks[k];
      dec.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, data: c.data }));
      if (k % SEG === SEG - 1 || k === chunks.length - 1) await dec.flush();   // 一段一段解,手里不留一堆没关的帧
    }
    try { dec.close(); } catch { /* 已关 */ }
    out.decodeMs = now() - td;
    if (decErr) problems.push('解码出错:' + decErr);
    out.decoded = decoded; out.compared = acc.n;
    out.colorMean = acc.cn ? acc.cs / acc.cn : null; out.alphaMean = acc.an ? acc.as / acc.an : null; out.colorMax = acc.cm; out.alphaMax = acc.am;
    return out;
  };

  /* ---------------------------------------------------------------- 只量搬运:同一帧原始像素 POST 给一个收下就丢的口 */
  P.measureTransfer = async (n) => {
    S.drawFn(0);
    const r = readStraight();
    const t0 = now();
    for (let k = 0; k < n; k++) await post('/null', r.data);
    return { msPerFrame: (now() - t0) / n, bytes: r.data.length };
  };

  /* ---------------------------------------------------------------- ffmpeg 的产物交给浏览器的 VideoDecoder 解(播放端就是这么解的),和原画比 */
  function parseFmp4(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const boxesIn = (start, end) => {
      const out = []; let o = start;
      while (o + 8 <= end) {
        let size = dv.getUint32(o), hdr = 8;
        const type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
        if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
        if (size < hdr) break;
        out.push({ type, start: o, hdr, end: o + size }); o += size;
      }
      return out;
    };
    const kids = (b, skip = 0) => boxesIn(b.start + b.hdr + skip, b.end);
    const pick = (list, t) => list.find((b) => b.type === t);
    const top = boxesIn(0, buf.length);
    let description = null, codec = null;
    const moov = pick(top, 'moov');
    if (moov) {
      const trak = pick(kids(moov), 'trak'), mdia = trak && pick(kids(trak), 'mdia'), minf = mdia && pick(kids(mdia), 'minf'), stbl = minf && pick(kids(minf), 'stbl');
      const stsd = stbl && pick(kids(stbl), 'stsd');
      const avc1 = stsd && pick(kids(stsd, 8), 'avc1');
      const avcC = avc1 && pick(kids(avc1, 78), 'avcC');
      if (avcC) { description = buf.slice(avcC.start + avcC.hdr, avcC.end); codec = 'avc1.' + [1, 2, 3].map((k) => description[k].toString(16).padStart(2, '0')).join(''); }
    }
    const samples = [];
    for (const moof of top.filter((b) => b.type === 'moof')) {
      const traf = pick(kids(moof), 'traf'); if (!traf) continue;
      const tk = kids(traf), tfhd = pick(tk, 'tfhd'), trun = pick(tk, 'trun'); if (!tfhd || !trun) continue;
      const tf = dv.getUint32(tfhd.start + tfhd.hdr) & 0xffffff; let o = tfhd.start + tfhd.hdr + 8;
      if (tf & 0x1) o += 8;
      if (tf & 0x2) o += 4;
      if (tf & 0x8) o += 4;
      const defSize = (tf & 0x10) ? dv.getUint32(o) : 0;
      const rf = dv.getUint32(trun.start + trun.hdr) & 0xffffff, count = dv.getUint32(trun.start + trun.hdr + 4);
      o = trun.start + trun.hdr + 8;
      let dataOff = 0; if (rf & 0x1) { dataOff = dv.getInt32(o); o += 4; }
      if (rf & 0x4) o += 4;
      let pos = moof.start + dataOff;
      for (let k = 0; k < count; k++) {
        if (rf & 0x100) o += 4;
        let size = defSize; if (rf & 0x200) { size = dv.getUint32(o); o += 4; }
        if (rf & 0x400) o += 4;
        if (rf & 0x800) o += 4;
        samples.push({ key: k === 0, data: buf.subarray(pos, pos + size) }); pos += size;
      }
    }
    return { description, codec, samples };
  }

  P.decodeFfmpegSegments = async ({ runId, count, fps }) => {
    const w = S.w, h = S.h, ph = 2 * h + 2 * PAD;
    const og = new OffscreenCanvas(w, ph).getContext('2d', { willReadFrequently: true });
    const acc = { cs: 0, cn: 0, as: 0, an: 0, n: 0 };
    let decoded = 0, decErr = null, cfg = null, dec = null;
    const compare = (frame, idx) => {
      const ref = S.refs.get(idx); if (!ref) return;
      og.drawImage(frame, 0, 0);
      const top = og.getImageData(0, 0, w, h).data, bot = og.getImageData(0, h + PAD, w, h).data;
      for (let p = 0; p < w * h; p++) {
        const q = p * 4, al = ref[q + 3];
        for (let cc = 0; cc < 3; cc++) acc.cs += Math.abs(top[q + cc] - Math.round(ref[q + cc] * al / 255));
        acc.as += Math.abs(bot[q] - al);
      }
      acc.cn += w * h * 3; acc.an += w * h; acc.n++;
    };
    for (let s = 0; s < count; s++) {
      const r = await fetch(`/segout/${runId}/${s}`); if (!r.ok) throw new Error('取不到分段 ' + s);
      const m = parseFmp4(new Uint8Array(await r.arrayBuffer()));
      if (!cfg) {
        if (!m.description) throw new Error('分段里找不到 avcC');
        cfg = { codec: m.codec, codedWidth: w, codedHeight: ph, description: m.description };
        const sup = await VideoDecoder.isConfigSupported(cfg); if (!sup.supported) throw new Error('VideoDecoder 不认 ' + m.codec);
        dec = new VideoDecoder({ output: (f) => { try { decoded++; compare(f, Math.round(f.timestamp * fps / 1e6)); } catch (e) { decErr = decErr || e; } finally { f.close(); } }, error: (e) => { decErr = decErr || e; } });
        dec.configure(cfg);
      }
      m.samples.forEach((sm, k) => dec.decode(new EncodedVideoChunk({ type: sm.key ? 'key' : 'delta', timestamp: Math.round((s * SEG + k) * 1e6 / fps), data: sm.data })));
      await dec.flush();
    }
    try { dec.close(); } catch { /* 已关 */ }
    if (decErr) throw new Error('解码出错:' + decErr);
    return { decoded, compared: acc.n, colorMean: acc.cn ? acc.cs / acc.cn : null, alphaMean: acc.an ? acc.as / acc.an : null };
  };

  /* ---------------------------------------------------------------- 原始像素 POST 给 Node */
  P.runRaw = async ({ frames, runId }) => {
    let paintMs = 0, readMs = 0, gpuReadMs = 0, convertMs = 0, transferMs = 0, bytes = 0;
    const t0 = now();
    for (let i = 0; i < frames; i++) {
      let a = now(); S.drawFn(i); paintMs += now() - a;
      a = now(); const r = readStraight(); readMs += now() - a; gpuReadMs += r.gpuMs; convertMs += r.convMs;
      a = now();
      await post(`/raw/${runId}?i=${i}`, r.data);
      transferMs += now() - a; bytes += r.data.length;
    }
    return { loopMs: now() - t0, paintMs, readMs, gpuReadMs, convertMs, transferMs, bytes };
  };
}

function pageHtml() {
  return `<!doctype html><meta charset="utf-8"><title>canvas encode paths probe</title>
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>
<script>(${pageMain.toString()})();</script>`;
}

/* ====================================================================== 编排 */

function sampleIndices(frames) {
  const s = new Set([0, frames - 1, Math.min(SEGMENT_FRAMES, frames - 1)]);
  for (let k = 1; k <= 6; k++) s.add(Math.floor((k * frames) / 7));
  return [...s].filter(i => i >= 0 && i < frames).sort((a, b) => a - b);
}

const verdictOf = (r, frames) => {
  const reasons = [];
  if (!r.ran) reasons.push(r.error || '没跑出来');
  else {
    if (!(r.bytes > 0)) reasons.push('没编出字节');
    if (r.decodedFrames !== frames) reasons.push(`解回 ${r.decodedFrames} 帧,应为 ${frames}`);
    if (!(r.colorMeanDiff < COLOR_MEAN_MAX)) reasons.push(`颜色平均差 ${r.colorMeanDiff} 不小于 ${COLOR_MEAN_MAX}`);
    if (!(r.alphaMeanDiff < ALPHA_MEAN_MAX)) reasons.push(`不透明度平均差 ${r.alphaMeanDiff} 不小于 ${ALPHA_MEAN_MAX}`);
    if (r.problems?.length) reasons.push(...r.problems);
  }
  return { available: r.ran && reasons.length === 0, verdict: r.ran && reasons.length === 0 ? '可用' : '不可用', reasons };
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '')); return 0; }
  fs.mkdirSync(opts.out, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(opts.out, 'chrome-profile-'));
  const summary = { probe: 'canvas-encode-paths', probeVersion: PROBE_VERSION, when: new Date().toISOString(),
    options: { chrome: opts.chrome, noGpu: opts.noGpu, noSandbox: opts.noSandbox, ffmpeg: opts.ffmpeg, frames: opts.frames, fps: opts.fps, sizes: opts.sizeList.map(s => s.label), scenes: opts.sceneList, hw: opts.hwList, chromeArgExtra: opts.chromeArg },
    criteria: { colorMeanMax: COLOR_MEAN_MAX, alphaMeanMax: ALPHA_MEAN_MAX, note: '可用 = 编得出来、解回来帧数对、颜色平均差 < colorMeanMax、不透明度平均差 < alphaMeanMax' },
    proxies: { particles: '2D 画布,400 个半透明小圆点(粒子卡的替身)', three: 'WebGL 画布,带光照的转动球体加一圈环(scene-3d 的替身)' },
    host: null, ffmpeg: null, chrome: null, encoderSupport: {}, results: [], comparison: [], failures: [], exit: { code: 0, reason: null } };

  let server = null, chrome = null, cdp = null;
  const state = { refs: new Map(), rawSinks: new Map(), segOut: new Map(), seg: null, port: 0 };
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return; cleaned = true;
    try { cdp?.close(); } catch { /* 忽略 */ }
    killAllChildren();
    if (chrome?.proc) { killTree(chrome.proc); await sleep(300); }
    const left = killByProfileDir(profileDir);
    if (left) { log(`兜底结束了 ${left} 个残留的 Chrome 进程`); await sleep(500); }
    try { server?.closeAllConnections?.(); server?.close(); } catch { /* 忽略 */ }
    let rmErr = null;
    for (let k = 0; k < 15; k++) { try { fs.rmSync(profileDir, { recursive: true, force: true }); rmErr = null; break; } catch (e) { rmErr = e; await sleep(400); } }
    if (rmErr) log(`临时 Chrome 用户目录没删掉(${rmErr.code}):${profileDir}`);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup().finally(() => process.exit(130)); });
  process.on('exit', () => { killAllChildren(); if (chrome?.proc) killTree(chrome.proc); });

  try {
    log(`载入前处理器占用(1 秒采样)…`);
    const busyBefore = await sampleCpuBusy(1000);
    summary.host = { ...hostInfo(), cpuBusyPercentBefore: busyBefore };

    // ffmpeg
    const ver = tryExec(opts.ffmpeg, ['-hide_banner', '-version'], 10000);
    const encoders = tryExec(opts.ffmpeg, ['-hide_banner', '-encoders'], 10000) || '';
    summary.ffmpeg = { path: opts.ffmpeg, version: ver ? ver.split('\n')[0] : null, usable: !!ver, libx264: /\blibx264\b/.test(encoders) };
    if (!ver) log(`找不到可用的 ffmpeg(${opts.ffmpeg}):两条 ffmpeg 的路都会记「不可用」`);
    else if (!summary.ffmpeg.libx264) log('这个 ffmpeg 没有 libx264:两条 ffmpeg 的路都会记「不可用」');
    const ffmpegOk = summary.ffmpeg.usable && summary.ffmpeg.libx264;

    // HTTP 口
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://x');
        const so = /^\/segout\/([^/]+)\/(\d+)$/.exec(url.pathname);
        if (req.method === 'GET' && so) {
          const buf = state.segOut.get(so[1])?.[Number(so[2])];
          if (!buf) { res.statusCode = 404; res.end(); return; }
          res.setHeader('content-type', 'application/octet-stream'); res.end(buf); return;
        }
        if (req.method === 'GET' && url.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.end(pageHtml()); return; }
        if (req.method === 'POST') {
          const chunks = []; let len = 0;
          const m = /^\/(ref|raw|seg|null)(?:\/([^/]+))?$/.exec(url.pathname);
          if (!m) { res.statusCode = 404; res.end(); return; }
          for await (const c of req) { chunks.push(c); len += c.length; }
          const body = Buffer.concat(chunks, len);
          if (m[1] === 'ref') { state.refs.set(Number(m[2]), body); }
          else if (m[1] === 'seg') { state.seg = { bytes: body.length }; }
          else if (m[1] === 'null') { /* 只量搬运:收下就丢 */ }
          else {
            const sink = state.rawSinks.get(m[2]);
            if (!sink) throw new Error('没有这个 runId 的接收口');
            const i = Number(url.searchParams.get('i'));
            if (body.length !== sink.expect) throw new Error(`第 ${i} 帧收到 ${body.length} 字节,应为 ${sink.expect}`);
            await sink.pipeline.write(i, body);
            if (i < SEGMENT_FRAMES) sink.first.push(body);
            sink.count++;
          }
          res.statusCode = 204; res.end(); return;
        }
        res.statusCode = 404; res.end();
      } catch (e) { res.statusCode = 500; res.end(String(e?.message || e)); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.port = server.address().port;
    const origin = `http://127.0.0.1:${state.port}`;

    // Chrome
    log(`起 Chrome:${opts.chrome}`);
    chrome = await launchChrome(opts, profileDir);
    cdp = new Cdp(chrome.wsUrl);
    await cdp.open();
    const version = await cdp.send('Browser.getVersion');
    let systemInfo = null;
    try {
      const si = await cdp.send('SystemInfo.getInfo');
      systemInfo = { gpuDevices: (si.gpu?.devices || []).map(d => ({ vendorId: d.vendorId, deviceId: d.deviceId, vendorString: d.vendorString, deviceString: d.deviceString, driverVendor: d.driverVendor, driverVersion: d.driverVersion })),
        featureStatus: si.gpu?.featureStatus ?? null, videoEncoding: (si.gpu?.videoEncoding || []).map(v => v.profile), videoDecoding: (si.gpu?.videoDecoding || []).map(v => v.profile) };
    } catch (e) { systemInfo = { error: String(e.message || e) }; }
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p, t) => cdp.send(m, p, sid, t);
    await call('Page.enable');
    await call('Runtime.enable');

    const evalPage = async (expression, timeoutMs = opts.timeoutSec * 1000) => {
      const r = await withTimeout(call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs + 5000), timeoutMs, '页面脚本');
      if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本出错').split('\n')[0]);
      return r.result.value;
    };
    const loadPage = async () => {
      await call('Page.navigate', { url: origin + '/' });
      for (let k = 0; k < 100; k++) { try { if (await evalPage('typeof window.P === "object" && document.readyState !== "loading"', 5000)) return; } catch { /* 还没好 */ } await sleep(100); }
      throw new Error('页面没有载入');
    };
    await loadPage();
    const pageInfo = await evalPage('P.info()');
    summary.chrome = { executable: opts.chrome, product: version.product, userAgent: version.userAgent, isHeadlessShell: /headless[-_]?shell/i.test(path.basename(opts.chrome)) || /headless[-_]?shell/i.test(opts.chrome),
      launchArgs: chrome.args.filter(a => !a.startsWith('--user-data-dir')), page: pageInfo, systemInfo };
    log(`${version.product};WebGL:${pageInfo.webgl?.available ? pageInfo.webgl.unmaskedRenderer || pageInfo.webgl.renderer : '不可用'};VideoEncoder:${pageInfo.videoEncoder}`);

    const frames = opts.frames, fps = opts.fps;
    const indices = sampleIndices(frames);

    for (const size of opts.sizeList) {
      const { w, h } = size;
      await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await call('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

      // 第 2 项:编码器能力(每种尺寸一份)
      try { summary.encoderSupport[size.label] = await evalPage(`P.supportMatrix(${w},${h},${fps})`, 60000); }
      catch (e) { summary.encoderSupport[size.label] = { error: String(e.message || e) }; }

      for (const scene of opts.sceneList) {
        log(`—— ${scene} ${size.label}`);
        const row = { scene, size: size.label, frames, sampleFrames: indices, setup: null, opaqueFraction: null, paths: {} };
        summary.results.push(row);

        const prepare = async () => {
          state.refs = new Map();
          row.setup = await evalPage(`P.setup(${JSON.stringify(scene)},${w},${h})`, 120000);
          const mk = await evalPage(`P.makeRefs(${JSON.stringify(indices)})`);
          row.opaqueFraction = round(mk.opaqueFraction, 3);
          const pi = indices[Math.floor(indices.length / 2)];
          if (state.refs.has(pi)) { row.previewPng = `preview-${scene}-${size.label}-f${pi}.png`; await writePreviewPng(path.join(opts.out, row.previewPng), state.refs.get(pi), w, h).catch(() => { row.previewPng = null; }); }
        };
        try { await prepare(); }
        catch (e) {
          const msg = String(e.message || e);
          log(`  场景起不来:${msg}`);
          row.setup = { ok: false, error: msg };
          for (const k of ['browserEncoder', ...opts.hwList.filter(x => x !== 'no-preference').map(x => `browserEncoder:${x}`), 'ffmpegRaw', 'ffmpegScreenshot']) row.paths[k] = { ran: false, error: `场景「不可用」:${msg}`, ...verdictOf({ ran: false, error: `场景「不可用」:${msg}` }, frames) };
          continue;
        }

        /** ffmpeg 的产物交给页面里的 VideoDecoder 解(播放端就是这么解的),和原画比;只作旁证,出错不影响判定 */
        const browserDecodeOf = async (runId, segments) => {
          state.segOut.set(runId, segments);
          try {
            const r = await evalPage(`P.decodeFfmpegSegments(${JSON.stringify({ runId, count: segments.length, fps })})`, 120000);
            return { decoded: r.decoded, comparedFrames: r.compared, colorMeanDiff: round(r.colorMean, 3), alphaMeanDiff: round(r.alphaMean, 3) };
          } catch (e) { return { error: String(e.message || e) }; }
          finally { state.segOut.delete(runId); }
        };

        /** 跑一条路:失败(含超时)记「不可用」和原因,超时则重载页面再把场景准备好 */
        const runPath = async (key, fn) => {
          const t = performance.now();
          let r;
          try { r = await withTimeout(fn(), opts.timeoutSec * 1000, key); r.ran = true; }
          catch (e) {
            r = { ran: false, error: String(e.message || e) };
            log(`  ${key} 失败:${r.error}`);
            if (e.timeout) { try { await loadPage(); await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await prepare(); } catch (e2) { log(`  重载页面失败:${e2.message}`); } }
          }
          Object.assign(r, verdictOf(r, frames));
          r.secondsSpent = round((performance.now() - t) / 1000, 1);
          row.paths[key] = r;
          log(`  ${key}:${r.verdict}${r.available ? '' : '(' + r.reasons.join(';') + ')'} 端到端 ${r.e2ePerFrameMs ?? '-'} ms/帧`);
        };

        // 3. 浏览器自带的编码器(默认「不限」一遍,另按 --hw 里的其它取值各一遍)
        for (const hw of opts.hwList) {
          const key = hw === 'no-preference' ? 'browserEncoder' : `browserEncoder:${hw}`;
          await runPath(key, async () => {
            const b = await evalPage(`P.runBrowserEncoder(${JSON.stringify({ frames, fps, hw, quantizer: 20, indices })})`);
            const net = b.loopMs - b.paintMs + b.handoffMs;
            return {
              bytes: b.bytes, kbps: b.kbps, decodedFrames: b.decoded, comparedFrames: b.compared, colorMeanDiff: round(b.colorMean, 3), alphaMeanDiff: round(b.alphaMean, 3), colorMaxDiff: b.colorMax, alphaMaxDiff: b.alphaMax,
              problems: b.problems, codec: b.codec, bitrateMode: b.mode, hardwareAcceleration: b.hardwareAcceleration, packed: b.packed,
              encodeFps: round(frames / ((b.loopMs - b.paintMs) / 1000), 1), decodeMs: round(b.decodeMs, 0),
              timingMsPerFrame: { paint: round(b.paintMs / frames), pack: round(b.packMs / frames), encodeWait: round(b.waitMs / frames), handoff: round(b.handoffMs / frames) },
              e2ePerFrameMs: round(net / frames),
            };
          });
        }

        // 4. 原始像素交给 ffmpeg
        await runPath('ffmpegRaw', async () => {
          if (!ffmpegOk) throw new Error('ffmpeg 不可用(找不到或没有 libx264)');
          const args = rawSegmentArgs(w, h, fps);
          const runId = crypto.randomBytes(6).toString('hex');
          const sink = { pipeline: new SegmentPipeline(opts.ffmpeg, args), first: [], count: 0, expect: w * h * 4 };
          state.rawSinks.set(runId, sink);
          try {
            const p = await evalPage(`P.runRaw(${JSON.stringify({ frames, runId })})`);
            const fin = await sink.pipeline.finish();
            const bytes = fin.segments.reduce((s, b) => s + b.length, 0);
            fs.writeFileSync(path.join(opts.out, `${scene}-${size.label}-ffmpegRaw-seg0.mp4`), fin.segments[0]);
            const cmp = await decodeAndCompare(opts.ffmpeg, fin.segments, w, h, state.refs);
            const bd = await browserDecodeOf(runId, fin.segments);
            const tp = await evalPage('P.measureTransfer(15)').catch(() => null);
            const encMs = await isolatedEncodeMs(opts.ffmpeg, args, sink.first, frames);
            const net = p.loopMs - p.paintMs + fin.tailMs;
            return {
              bytes, kbps: Math.round(bytes * 8 / (frames / fps) / 1000), segments: fin.segments.length, receivedFrames: sink.count, decodedFrames: cmp.decoded, comparedFrames: cmp.compared,
              colorMeanDiff: cmp.colorMean, alphaMeanDiff: cmp.alphaMean, colorMaxDiff: cmp.colorMax, alphaMaxDiff: cmp.alphaMax, browserDecode: bd,
              timingMsPerFrame: { transferPure: tp ? round(tp.msPerFrame) : null, paint: round(p.paintMs / frames), read: round(p.readMs / frames), readGpu: round(p.gpuReadMs / frames), readConvert: round(p.convertMs / frames), transfer: round(p.transferMs / frames), encodeIsolated: round(encMs), tail: round(fin.tailMs / frames) },
              e2ePerFrameMs: round(net / frames), rawBytesPerFrame: w * h * 4,
            };
          } catch (e) { sink.pipeline.abort(); throw e; } finally { state.rawSinks.delete(runId); }
        });

        // 5. 现在的办法:截图 → PNG → ffmpeg
        await runPath('ffmpegScreenshot', async () => {
          if (!ffmpegOk) throw new Error('ffmpeg 不可用(找不到或没有 libx264)');
          const args = pngSegmentArgs(fps);
          const pipe = new SegmentPipeline(opts.ffmpeg, args);
          const firstPngs = [];
          let paintMs = 0, shotMs = 0, xferMs = 0, pngBytes = 0;
          const t0 = performance.now();
          try {
            for (let i = 0; i < frames; i++) {
              let a = performance.now(); await evalPage(`P.drawSettle(${i})`, 60000); paintMs += performance.now() - a;
              a = performance.now();
              const shot = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 }, fromSurface: true, captureBeyondViewport: false }, 60000);
              shotMs += performance.now() - a;
              a = performance.now();
              const png = Buffer.from(shot.data, 'base64');
              pngBytes += png.length;
              if (i < SEGMENT_FRAMES) firstPngs.push(png);
              await pipe.write(i, png);
              xferMs += performance.now() - a;
            }
            const loopMs = performance.now() - t0;
            const fin = await pipe.finish();
            const bytes = fin.segments.reduce((s, b) => s + b.length, 0);
            fs.writeFileSync(path.join(opts.out, `${scene}-${size.label}-ffmpegScreenshot-seg0.mp4`), fin.segments[0]);
            const cmp = await decodeAndCompare(opts.ffmpeg, fin.segments, w, h, state.refs);
            const bd = await browserDecodeOf(crypto.randomBytes(6).toString('hex'), fin.segments);
            const encMs = await isolatedEncodeMs(opts.ffmpeg, args, firstPngs, frames);
            const net = loopMs - paintMs + fin.tailMs;
            return {
              bytes, kbps: Math.round(bytes * 8 / (frames / fps) / 1000), segments: fin.segments.length, decodedFrames: cmp.decoded, comparedFrames: cmp.compared,
              colorMeanDiff: cmp.colorMean, alphaMeanDiff: cmp.alphaMean, colorMaxDiff: cmp.colorMax, alphaMaxDiff: cmp.alphaMax, browserDecode: bd,
              timingMsPerFrame: { paintAndSettle: round(paintMs / frames), screenshot: round(shotMs / frames), transfer: round(xferMs / frames), encodeIsolated: round(encMs), tail: round(fin.tailMs / frames) },
              e2ePerFrameMs: round(net / frames), pngBytesPerFrame: Math.round(pngBytes / frames),
            };
          } catch (e) { pipe.abort(); throw e; }
        });

        // 清掉这个场景的参照,省内存
        state.refs = new Map();
      }
    }

    // 机器级汇总:每条路在这台机器上是否「可用」(所有跑了的场景 × 尺寸都可用才算),以及三条路端到端每帧耗时的对比
    const pathKeys = new Set(); for (const r of summary.results) for (const k of Object.keys(r.paths)) pathKeys.add(k);
    summary.pathVerdicts = {};
    for (const k of pathKeys) {
      const rows = summary.results.filter(r => r.paths[k]);
      const ok = rows.length > 0 && rows.every(r => r.paths[k].available);
      summary.pathVerdicts[k] = { verdict: ok ? '可用' : '不可用', availableIn: rows.filter(r => r.paths[k].available).map(r => `${r.scene} ${r.size}`), unavailableIn: rows.filter(r => !r.paths[k].available).map(r => `${r.scene} ${r.size}:${r.paths[k].reasons.join(';')}`) };
    }
    for (const r of summary.results) {
      const g = (k) => r.paths[k]?.e2ePerFrameMs ?? null;
      summary.comparison.push({ scene: r.scene, size: r.size, e2eMsPerFrame: { browserEncoder: g('browserEncoder'), ffmpegRaw: g('ffmpegRaw'), ffmpegScreenshot: g('ffmpegScreenshot') },
        available: { browserEncoder: r.paths.browserEncoder?.available ?? false, ffmpegRaw: r.paths.ffmpegRaw?.available ?? false, ffmpegScreenshot: r.paths.ffmpegScreenshot?.available ?? false } });
      const ran = Object.values(r.paths).some(p => p.ran);
      if (!ran) summary.failures.push(`${r.scene} ${r.size}:三条路全都跑不出来`);
    }
    summary.host.cpuBusyPercentAfter = await sampleCpuBusy(1000);
    if (summary.failures.length) { summary.exit = { code: 1, reason: summary.failures.join(';') }; }
  } catch (e) {
    summary.fatal = String(e?.stack || e);
    summary.exit = { code: 2, reason: `探针自己出错:${String(e?.message || e)}` };
    log(summary.exit.reason);
  } finally {
    await cleanup();
  }

  const summaryPath = path.join(opts.out, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  printTable(summary);
  console.log(summaryPath);
  return summary.exit.code;
}

function printTable(s) {
  const out = [];
  out.push(`机器:${s.host?.cpu},${s.host?.logicalCores} 个逻辑核,${s.host?.memGiB} GiB,${s.host?.platform};显卡:${s.host?.gpuAdapters === null ? '未知' : s.host?.gpuAdapters.length ? s.host.gpuAdapters.join(' / ') : '无'};处理器占用(开跑前)${s.host?.cpuBusyPercentBefore}%`);
  out.push(`Chrome:${s.chrome?.product};无头壳:${s.chrome?.isHeadlessShell};WebGL:${s.chrome?.page?.webgl?.available ? s.chrome.page.webgl.unmaskedRenderer || s.chrome.page.webgl.renderer : '不可用'};${s.options.noGpu ? '--no-gpu' : '缺省(有显卡就用)'}`);
  out.push(`ffmpeg:${s.ffmpeg?.version ?? '不可用'}`);
  for (const [size, m] of Object.entries(s.encoderSupport)) {
    if (!m.rows) { out.push(`isConfigSupported ${size}:${m.error}`); continue; }
    const cell = (p, hw) => { const rs = m.rows.filter(r => r.profile === p && r.hardwareAcceleration === hw); return rs.map(r => `${r.bitrateMode[0]}:${r.supported ? '是' : '否'}`).join(','); };
    out.push(`isConfigSupported ${size}(拼合 ${m.packed}):` + ['baseline', 'main', 'high'].map(p => `${p}[不限 ${cell(p, 'no-preference')} | 软件 ${cell(p, 'prefer-software')}]`).join(' '));
  }
  out.push('场景 尺寸 路径 | 判定 | 解回帧 | 颜色差 | 透明差 | (浏览器解)颜色差/透明差 | 读(截图那条是截图) | 搬(单量) | 编码(单量;浏览器那条是每秒帧数) | 端到端 ms/帧');
  for (const r of s.results) {
    out.push(`  [${r.scene} ${r.size}] 不透明像素占比 ${r.opaqueFraction ?? '-'}`);
    for (const [k, p] of Object.entries(r.paths)) {
      const t = p.timingMsPerFrame || {};
      const bd = p.browserDecode && !p.browserDecode.error ? `${p.browserDecode.colorMeanDiff}/${p.browserDecode.alphaMeanDiff}` : '-';
      out.push(`${r.scene} ${r.size} ${k} | ${p.verdict}${p.available ? '' : '(' + p.reasons.join(';') + ')'} | ${p.decodedFrames ?? '-'}/${r.frames} | ${p.colorMeanDiff ?? '-'} | ${p.alphaMeanDiff ?? '-'} | ${bd} | ${t.read ?? t.pack ?? t.screenshot ?? '-'} | ${t.transferPure ?? t.handoff ?? t.transfer ?? '-'} | ${t.encodeIsolated ?? (p.encodeFps ? `${p.encodeFps} 帧/秒` : '-')} | ${p.e2ePerFrameMs ?? '-'}`);
    }
  }
  console.log(out.join('\n'));
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(e?.message || e); process.exitCode = 2; });
