/**
 * ffmpeg 这一层:去哪儿找它、怎么把 Chrome 的 PNG 流直接喂给它、怎么读它的进度。
 *
 * 从 scripts/export-frames.mjs 拆出来(纯重构,逐字搬运)。
 */

import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { spawn } from 'child_process';

/** 本机的 ffmpeg:PATH 上有就用它,没有就退到 winget 装的那一份 */
export async function findFfmpeg() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const ffmpegFallback = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build', 'bin', 'ffmpeg.exe');
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-version'], { windowsHide: true });
      proc.on('close', code => code === 0 ? resolve() : reject());
      proc.on('error', reject);
    });
    return 'ffmpeg';
  } catch {
    return ffmpegFallback;
  }
}

const ffprobeOf = (ffmpegCmd) => ffmpegCmd.replace(/ffmpeg(.exe)?$/i, (m) => m.toLowerCase().startsWith('ffmpeg.exe') ? 'ffprobe.exe' : 'ffprobe');

/** Encode incoming screenshots immediately so Node retains at most one PNG.
 * The movie must hold exactly the frames written: a shorter file shifts every
 * later shard in the concatenated export, so a mismatch is an error.
 */
export function streamPngVideo(ffmpeg, file, fps) {
  const proc = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-f', 'image2pipe', '-vcodec', 'png',
    '-framerate', String(fps), '-i', 'pipe:0', '-an', '-c:v', 'prores_ks', '-profile:v', '4444',
    '-pix_fmt', 'yuva444p10le', file], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '', partial = '', inputError = null, written = 0;
  const progress = {};
  proc.stderr.on('data', d => {
    const lines = (partial + d).split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) {
      const m = /^(frame|drop_frames|dup_frames|progress)=(\S*)$/.exec(line);
      if (m) progress[m[1]] = m[2];
      else if (!/^[a-z_0-9]+=/.test(line)) stderr = (stderr + line + '\n').slice(-8000);
    }
  });
  proc.stdin.on('error', e => { inputError = e; });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => {
      if (partial && !/^[a-z_0-9]+=/.test(partial)) stderr = (stderr + partial).slice(-8000);
      code === 0 ? resolve() : reject(inputError || new Error(`ffmpeg ${code}: ${stderr}`));
    });
  });
  done.catch(() => {});
  return {
    async write(buffer) {
      if (inputError) throw inputError;
      await new Promise((resolve, reject) => proc.stdin.write(buffer, e => e ? reject(e) : resolve()));
      written++;
    },
    async finish() {
      proc.stdin.end();
      await done;
      const encoded = Number(progress.frame);
      if (process.env.PC_STREAM_DEBUG) console.log(`[stream-png] ${file}: written=${written} encoded=${progress.frame} drop=${progress.drop_frames} dup=${progress.dup_frames}`);
      if (encoded !== written) {
        throw new Error(`${file}: wrote ${written} frames but ffmpeg encoded ${progress.frame ?? 'unknown'} (drop=${progress.drop_frames}, dup=${progress.dup_frames}) ${stderr}`);
      }
    },
    async abort() { proc.stdin.destroy(); proc.kill(); await done.catch(() => {}); },
  };
}

/**
 * 跑一趟 ffmpeg,用 -progress 读出已出的帧数回调给 onFrame。
 * 看门狗:stallMs 内帧数一直不动就杀掉报错。ffmpeg 真卡住时 CPU 归零、不报错也不退出(实测过:卡片 PNG 中途变格式
 * 触发滤镜图重建,见 buildComposeArgs 里 -reinit_filter 那段),不设这道闸,导出会在界面上永远停在某个进度。
 */
function runFfmpegProgress(ffmpegCmd, args, onFrame, stallMs = Number(process.env.PC_COMPOSE_STALL_MS) || 45000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegCmd, ['-progress', 'pipe:1', '-nostats', '-loglevel', 'warning', ...args], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let buf = '';
    let last = -1;
    let lastChange = Date.now();
    let stalled = false;
    const dog = setInterval(() => {
      if (Date.now() - lastChange > stallMs) {
        stalled = true;
        proc.kill();
      }
    }, 2000);
    proc.stdout.on('data', (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim();
        buf = buf.slice(k + 1);
        const m = /^frame=(\d+)$/.exec(line);
        if (!m) continue;
        const n = Number(m[1]);
        if (n !== last) {
          last = n;
          lastChange = Date.now();
          onFrame(n);
        }
      }
    });
    proc.on('close', (code) => {
      clearInterval(dog);
      if (stalled) reject(Object.assign(new Error(`ffmpeg 合成 ${stallMs / 1000} 秒没有任何进展(停在第 ${Math.max(0, last)} 帧),已中止`), { stalled: true }));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg(素材合成)exited with code ${code}`));
    });
    proc.on('error', (e) => {
      clearInterval(dog);
      reject(e);
    });
  });
}

export { ffprobeOf, runFfmpegProgress };

/* ======================================================================== *
 * 轨道流(R8 / G3)的分段编码器
 *
 * 一个分段 = 一次 ffmpeg 调用:PNG 经 image2pipe 从 stdin 喂进去,fMP4 字节从 stdout 收回来。
 * 切 init / 分段、丢 mfra 在 Node 端(`server/frame-stream.mjs`),这里只管「编」。
 * ======================================================================== */

/** 每个分段恰好这么多个样本(G2;末段除外) */
export const STREAM_SEGMENT_FRAMES = 15;

/**
 * 每个编码器一行参数(G3 的表):**不要拿公共块去拼** —— `-sc_threshold` 这类不是所有编码器都认。
 * `pixFmt`:滤镜链尾巴的像素格式。`h264_mf` 的硬件路径只收 `nv12`(G0-b (7):写 `yuv420p`
 * 直接 `format negotiation failed`)。
 *
 * nvenc / qsv / amf 三行本机没跑成(G0-b (7):驱动 / 硬件缺席),是照任务书原样保留的,不是实测结论;
 * nvenc 的 `-tune ll` 与 `-rc vbr -cq` 二选一也没测成,这里保留任务书写的 `-rc vbr -cq` 那一组。
 */
export const STREAM_ENCODERS = {
  libx264: { pixFmt: 'yuv420p', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-bf', '0'] },
  h264_nvenc: { pixFmt: 'yuv420p', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '16', '-b:v', '0', '-g', '15', '-bf', '0', '-no-scenecut', '1', '-forced-idr', '1', '-strict_gop', '1'] },
  h264_qsv: { pixFmt: 'yuv420p', args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '16', '-g', '15', '-bf', '0'] },
  h264_amf: { pixFmt: 'yuv420p', args: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '16', '-qp_p', '16'] },
  h264_mf: { pixFmt: 'nv12', args: ['-c:v', 'h264_mf', '-hw_encoding', '1', '-rate_control', 'quality', '-quality', '90', '-g', '15', '-bf', '0'] },
};

/** 探测顺序(G0-b 结论 4):硬件优先,`libx264` 排在 `h264_mf` 前面(后者慢一倍、只出 Baseline) */
export const STREAM_ENCODER_ORDER = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264', 'h264_mf'];

/**
 * 缺省编码器是 `libx264`(G0-b 结论 4:本机唯一实测全过,耗时、体积、profile 三项都最好)。
 * 硬件编码器**只在显式点名时才先试**(`PROMPTCUT_STREAM_ENCODER=auto` 按上面的顺序探测,
 * 或直接写编码器名):本机四个硬件编码器全是「列着但跑不了」,而 nvenc 那一行的参数没实测过。
 */
export function streamEncoderPreference(env = process.env) {
  const want = String(env.PROMPTCUT_STREAM_ENCODER || '').trim();
  if (!want) return ['libx264', 'h264_mf'];
  if (want === 'auto') return [...STREAM_ENCODER_ORDER];
  return [want, ...STREAM_ENCODER_ORDER.filter(name => name !== want)].filter(name => STREAM_ENCODERS[name]);
}

/**
 * G3 的滤镜链。**色半区存预乘色**(`premultiply=inplace=1`,透明处 RGB 恒为纯黑);
 * **`out_range=tv`**(G0-b 结论 2:`pc` 在 Chrome 上会被当成限定范围再展开一次,alpha 平均误差 8.4/255)。
 * 宽高已经是 G1 外扩过的偶数,滤镜链不再取整。
 *
 * 和 `streamFilterIdentity` 那条旧写法逐字节等价(送进编码器的每一帧 YUV 都相同,见
 * `server/test/stream-encode-fast.test.mjs`),只是少做几趟整帧的活:
 *   - 预乘之后不再转回 `rgba` 再分叉(`docs/reports/AGENT-perf-encode.md`);
 *   - **alpha 半区在预乘之前分出去**:预乘只改色平面、不动 alpha 平面,所以取出来的 alpha 相同;
 *     而 ffmpeg 8 起帧上带 alpha 模式,预乘后的帧标成「已预乘」,`alphaextract` 只收「未预乘」的,
 *     分叉在预乘之后时滤镜图会自动插一个 `premultiply_dynamic` 把整帧反预乘回去(白算一趟、结果还被丢掉);
 *   - 两半用平面 `gbrp` 拼(`gbrap → gbrp`、`gray → gbrp` 只是搬平面),最后一趟 `gbrp → yuv` 比 `rgb24 → yuv` 省;
 * 单线程下这条链比上一版省约四分之一(`docs/reports/AGENT-perf-encode-2.md`)。
 */
export function streamFilter(pixFmt = 'yuv420p') {
  return '[0:v]format=gbrap,split=2[p][a];'
    + '[p]premultiply=inplace=1,format=gbrp,pad=iw:ih+8:0:0:black[rgb];'
    + '[a]alphaextract,format=gbrp,pad=iw:ih+8:0:0:black[mask];'
    + `[rgb][mask]vstack=inputs=2,scale=out_range=tv:out_color_matrix=bt709,format=${pixFmt}`;
}

/**
 * 滤镜链的**身份**:分段签名里的编码参数哈希按它算(`encoderParamsHash`),不按 `streamFilter` 的字面。
 * 这是改写前的那条链;现在的链和它产出逐字节相同,所以盘上已有的分段照旧有效、不必重产。
 * **改滤镜链、使产出变了时,必须同时改这里**(否则新旧分段会被当成同一套参数的产物)。
 */
export function streamFilterIdentity(pixFmt = 'yuv420p') {
  return '[0:v]format=gbrap,premultiply=inplace=1,format=rgba,split=2[c][a];'
    + '[c]format=rgb24,pad=iw:ih+8:0:0:black[rgb];'
    + '[a]alphaextract,format=gray,format=rgb24,pad=iw:ih+8:0:0:black[mask];'
    + `[rgb][mask]vstack=inputs=2,scale=out_range=tv:out_color_matrix=bt709,format=${pixFmt}`;
}

/**
 * 输入端的三个选项,**只改什么时候开工、不改产出**(同样输入逐字节相同,见 `stream-encode-fast.test.mjs`):
 *   - `-probesize 32 -analyzeduration 0`:ffmpeg 开输入时缺省要先读够 5 MB(或 5 秒)才开工;一张 PNG 两三百 KB,
 *     一段 15 帧整段都凑不够,于是**不等 stdin 关掉什么都不做**。帧率由 `-framerate` 给定、宽高与像素格式
 *     从第一张 PNG 解出来,不需要多读;
 *   - `-threads 1`(PNG 解码):帧级多线程解码要先攒够「线程数 − 1」个包才出第一帧(16 线程的机器上正好一整段)。
 *     单线程解一张 1080p 截图只要一两毫秒,远快于后面的滤镜和编码,不成瓶颈。
 * 两者合起来,帧一到就进滤镜和编码器,喂完最后一张之后只剩最后几帧和收尾(按出帧节奏喂时,
 * 1080p 一段喂完到出完字节从约 270 ms 降到约 70 ms)。
 */
const STREAM_INPUT_ARGS = ['-probesize', '32', '-analyzeduration', '0', '-threads', '1'];

/**
 * 滤镜图的切片线程数:缺省(0)是逻辑核数,这里封顶 8。滤镜和 x264(auto 线程是核数 × 1.5)抢同一批核,
 * 16 线程的笔记本上切 16 片反而比 8 片慢约 15 ms / 段(`docs/reports/AGENT-perf-encode-2.md`);8 核以下不变。
 * 切几片**不改产出**:swscale / premultiply / vstack 按行切片,1～16 片输出逐字节相同(单测里比 1 片和 3 片)。
 */
export function streamFilterThreads(cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length, env = process.env) {
  // PROMPTCUT_STREAM_FILTER_THREADS:手动指定(0 = 交给 ffmpeg,即逻辑核数),给别的机器调参用
  const forced = String(env.PROMPTCUT_STREAM_FILTER_THREADS ?? '').trim();
  if (/^\d+$/.test(forced)) return Number(forced);
  return Math.max(1, Math.min(8, Math.floor(Number(cpus)) || 1));
}

/**
 * 一个分段的完整命令行(输出 fMP4 到 stdout)。
 *
 * `raw: { width, height }`(画布直取,`./capture-canvas.mjs`):输入不是 PNG,是一帧接一帧的 straight RGBA 原始像素
 * (`rawvideo`、`rgba`,每帧 `width × height × 4` 字节)。只换输入这一段,后面的滤镜链和编码参数一个字不变 ——
 * PNG 解出来也是同一种 `rgba` 帧,同样的像素两种输入编出来逐字节相同(`server/test/stream-encode-raw.test.mjs`)。
 */
export function streamSegmentArgs({ encoder = 'libx264', fps, raw = null }) {
  const spec = STREAM_ENCODERS[encoder];
  if (!spec) throw new Error(`未知的轨道流编码器 ${encoder}`);
  if (!(Number(fps) > 0)) throw new Error('轨道流编码要帧率');
  if (raw && !(Number.isInteger(raw.width) && Number.isInteger(raw.height) && raw.width > 0 && raw.height > 0)) throw new Error('原始像素输入要整数宽高');
  const input = raw ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${raw.width}x${raw.height}`] : ['-f', 'image2pipe', '-c:v', 'png'];
  return ['-y', '-hide_banner', '-loglevel', 'error', '-filter_complex_threads', String(streamFilterThreads()),
    '-reinit_filter', '0', ...STREAM_INPUT_ARGS, ...input, '-framerate', String(fps), '-i', 'pipe:0',
    '-filter_complex', streamFilter(spec.pixFmt),
    ...spec.args,
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-video_track_timescale', String(fps),
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-an',
    '-f', 'mp4', 'pipe:1'];
}

/* ------------------------------------------------------------ 预先拉起的编码进程 */

/**
 * 每种命令行留一个**预先拉起、空等输入**的 ffmpeg(`openStreamSegmentEncoder` 领走它,再补拉一个)。
 * 同一条命令行、同一个可执行文件,产出与现拉的逐字节相同;省下的是进程装载和初始化那一截
 * (`docs/reports/AGENT-perf-encode.md` 的耗时拆分)。
 * 空等的进程不拖住 Node 退出(`unref`),空等超过 `SPARE_IDLE_MS` 就收掉;Node 退出时它的 stdin 断开,
 * 读到 EOF 自己退出,`exit` 时也会再杀一遍。`PROMPTCUT_STREAM_PREWARM=0` 关掉。
 */
const SPARE_IDLE_MS = 60_000;
const spareSegmentProcs = new Map();
let spareExitHook = false;

export function streamPrewarmEnabled(env = process.env) {
  return String(env.PROMPTCUT_STREAM_PREWARM ?? '').trim() !== '0';
}

function spareKey(ffmpeg, args) { return `${ffmpeg}\u0000${args.join('\u0000')}`; }

function spawnSegmentProc(ffmpeg, args) {
  return spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function setRef(proc, on) {
  for (const handle of [proc, proc.stdin, proc.stdout, proc.stderr]) {
    try { if (on) handle?.ref?.(); else handle?.unref?.(); } catch { /* 句柄已关 */ }
  }
}

function parkSpare(ffmpeg, args) {
  const key = spareKey(ffmpeg, args);
  if (spareSegmentProcs.has(key)) return;
  let proc;
  try { proc = spawnSegmentProc(ffmpeg, args); } catch { return; }
  const entry = { proc, dead: false, timer: null, onGone: null };
  // 空等期间出错或退出只是把它从池里拿掉;被领走之后由领的人接管(`takeSpare` 摘掉这个监听)
  entry.onGone = () => {
    entry.dead = true;
    clearTimeout(entry.timer);
    if (spareSegmentProcs.get(key) === entry) spareSegmentProcs.delete(key);
  };
  proc.on('error', entry.onGone);
  proc.on('exit', entry.onGone);
  proc.stdin.on('error', entry.onGone);
  entry.timer = setTimeout(() => { entry.onGone(); try { proc.stdin.destroy(); } catch {} proc.kill(); }, SPARE_IDLE_MS);
  entry.timer.unref?.();
  setRef(proc, false);
  spareSegmentProcs.set(key, entry);
  if (!spareExitHook) {
    spareExitHook = true;
    process.once('exit', () => { for (const e of spareSegmentProcs.values()) { try { e.proc.kill(); } catch {} } });
  }
}

function takeSpare(ffmpeg, args) {
  const key = spareKey(ffmpeg, args);
  const entry = spareSegmentProcs.get(key);
  if (!entry) return null;
  spareSegmentProcs.delete(key);
  clearTimeout(entry.timer);
  const { proc } = entry;
  proc.off('error', entry.onGone);
  proc.off('exit', entry.onGone);
  proc.stdin.off('error', entry.onGone);
  // 空等时 ffmpeg 不输出、不退出;已经退了(或被杀)就不要它
  if (entry.dead || proc.exitCode !== null || proc.signalCode !== null || proc.killed || !proc.pid) {
    try { proc.kill(); } catch {}
    return null;
  }
  setRef(proc, true);
  return proc;
}

/**
 * 原始像素输入的命令行带着宽高,每种矩形是自己的一种命令行:空等的进程会比 PNG 那一种(只按编码器和帧率分)多。
 * 留最近的 `SPARE_MAX` 个,更早的收掉(`Map` 按放进去的先后排)。
 */
const SPARE_MAX = 3;
function trimSpares() {
  while (spareSegmentProcs.size > SPARE_MAX) {
    const [key, entry] = spareSegmentProcs.entries().next().value;
    spareSegmentProcs.delete(key);
    clearTimeout(entry.timer);
    entry.dead = true;
    try { entry.proc.stdin.destroy(); } catch {}
    try { entry.proc.kill(); } catch {}
  }
}

/** 收掉全部空等的编码进程(测试和关停用) */
export function dropStreamEncoderSpares() {
  for (const [key, entry] of spareSegmentProcs) {
    spareSegmentProcs.delete(key);
    clearTimeout(entry.timer);
    entry.dead = true;
    try { entry.proc.stdin.destroy(); } catch {}
    try { entry.proc.kill(); } catch {}
  }
}

/** 池里空等的进程数(测试用) */
export function streamEncoderSpareCount() { return spareSegmentProcs.size; }

/**
 * `buf` 是否恰好以一个完整的 `mfra` 顶层盒子收尾(mov 分片封装的 trailer 最后写的就是它)。
 * 看到它就说明 ffmpeg 已经把整段写完,不必再等进程退出(退出前释放编码器内存还要几十毫秒)。
 */
export function endsWithCompleteMfra(buf) {
  let off = 0, last = null;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size === 1) {
      if (off + 16 > buf.length) return false;
      size = Number(buf.readBigUInt64BE(off + 8));
    } else if (size === 0) return false;
    if (size < 8 || off + size > buf.length) return false;
    last = type;
    off += size;
  }
  return off === buf.length && last === 'mfra';
}

/**
 * 开一个分段编码器。`write(png)` 按到达顺序喂(背压:等 stdin 收下),`finish()` 回 ffmpeg 输出的
 * 整段 fMP4 字节(`ftyp moov moof mdat mfra`),`abort()` 丢掉。
 * 喂进去几帧、ffmpeg 就该编出几帧 —— 对不上由切分那一侧按样本数判(G2「少一帧就重拍」)。
 *
 * `prewarm`(缺省看 `streamPrewarmEnabled`):优先领一个预先拉起的进程,并补拉下一个。
 * `raw: { width, height }`:喂的是原始 RGBA 帧,`write` 每次给恰好一帧(见 `streamSegmentArgs`)。
 * `finish()` 在输出以完整的 `mfra` 收尾时就交字节,不等进程退出;没收尾而进程退出码非零,照旧报错。
 */
export function openStreamSegmentEncoder(ffmpeg, { encoder = 'libx264', fps, prewarm = streamPrewarmEnabled(), raw = null }) {
  const args = streamSegmentArgs({ encoder, fps, raw });
  const proc = (prewarm && takeSpare(ffmpeg, args)) || spawnSegmentProc(ffmpeg, args);
  if (prewarm) setImmediate(() => { parkSpare(ffmpeg, args); if (raw) trimSpares(); });
  const chunks = [];
  let stderr = '', inputError = null, written = 0, received = 0, onTrailer = null;
  const startedAt = Date.now();
  const checkTrailer = () => {
    if (!onTrailer) return;
    const buf = Buffer.concat(chunks, received);
    if (endsWithCompleteMfra(buf)) onTrailer(buf);
  };
  proc.stdout.on('data', d => { chunks.push(d); received += d.length; checkTrailer(); });
  proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  proc.stdin.on('error', e => { inputError = e; });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve(Buffer.concat(chunks))
      : reject(inputError || new Error(`ffmpeg(${encoder})退出码 ${code}:${stderr.trim()}`)));
  });
  done.catch(() => {});
  return {
    encoder,
    get written() { return written; },
    /** 已经从 stdout 收到的字节数(喂帧期间就开始增长:编码器在第一帧到时就开工,见 `STREAM_INPUT_ARGS`) */
    get received() { return received; },
    async write(buffer) {
      if (inputError) throw inputError;
      await new Promise((resolve, reject) => proc.stdin.write(buffer, e => e ? reject(e) : resolve()));
      written++;
    },
    async finish() {
      const endedAt = Date.now();
      const trailer = new Promise(resolve => { onTrailer = resolve; });
      proc.stdin.end();
      checkTrailer();
      const bytes = await Promise.race([done, trailer]);
      // encodeMs:从开编码器到出完字节(和出帧重叠);tailMs:喂完最后一帧之后还要等多久
      return { bytes, encodeMs: Date.now() - startedAt, tailMs: Date.now() - endedAt, written };
    },
    async abort() { try { proc.stdin.destroy(); } catch {} proc.kill(); await done.catch(() => {}); },
  };
}

/** 探测用的一小段:两张 320×240 的半透明 PNG(内联,不依赖任何素材文件;`h264_mf` 太小的画面直接拒编) */
function probePngs() {
  // RGBA,左半不透明红、右半全透明;两张内容相同即可 —— 只看能不能编出来
  const width = 320, height = 240;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4;
      if (x < width / 2) { raw[i] = 255; raw[i + 3] = 255; }
    }
  }
  return [pngOf(raw, width, height), pngOf(raw, width, height)];
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function pngOf(raw, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * 这台机器上哪些 H.264 编码器**真的能编**(G0-b 结论 4:必须真编一小段再判定 ——
 * 本机四个硬件编码器全是「`ffmpeg -encoders` 里列着但跑不了」)。
 *
 * 走的是和分段一模一样的命令行(同一条滤镜链、同一组参数、同样输出 fMP4),
 * 编出来的字节里要有 `moof` 才算过。按 `order` 顺序逐个试,回全部结果。
 */
export async function probeEncoders(ffmpeg, { order = STREAM_ENCODER_ORDER, fps = 30, timeoutMs = 15000 } = {}) {
  const pngs = probePngs();
  const results = [];
  for (const name of order) {
    if (!STREAM_ENCODERS[name]) { results.push({ name, ok: false, error: '未知编码器' }); continue; }
    const started = Date.now();
    const enc = openStreamSegmentEncoder(ffmpeg, { encoder: name, fps, prewarm: false });
    const timer = setTimeout(() => { void enc.abort(); }, timeoutMs);
    try {
      for (const png of pngs) await enc.write(png);
      const { bytes } = await enc.finish();
      const ok = bytes.includes(Buffer.from('moof', 'latin1')) && bytes.includes(Buffer.from('avcC', 'latin1'));
      results.push({ name, ok, ms: Date.now() - started, error: ok ? null : '输出里没有 moof / avcC' });
    } catch (e) {
      results.push({ name, ok: false, ms: Date.now() - started, error: String(e?.message || e).split(/\r?\n/).slice(-2).join(' ') });
    } finally { clearTimeout(timer); }
  }
  return results;
}

/** 按 `preference` 找第一个真能编的编码器;一个都不行就抛。结果按 ffmpeg 路径缓存 */
const pickedEncoders = new Map();
export async function pickStreamEncoder(ffmpeg, preference = streamEncoderPreference()) {
  const key = `${ffmpeg}\u0000${preference.join(',')}`;
  if (!pickedEncoders.has(key)) {
    pickedEncoders.set(key, (async () => {
      const results = await probeEncoders(ffmpeg, { order: preference });
      const hit = results.find(r => r.ok);
      if (!hit) throw Object.assign(new Error(`没有能用的 H.264 编码器:${results.map(r => `${r.name}(${r.error})`).join('; ')}`), { code: 'NO_STREAM_ENCODER', results });
      return { encoder: hit.name, results };
    })());
    pickedEncoders.get(key).catch(() => pickedEncoders.delete(key));
  }
  return pickedEncoders.get(key);
}
