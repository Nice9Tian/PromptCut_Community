/**
 * ai-visual.mjs
 * 
 * 用于「AI 栏工具结果可视化」的纯 Node ESM 模块。
 * 包含随机 ID 生成、文件存取、对象比对格式化，以及使用 ffmpeg 导出 GIF / 拼图的逻辑。
 */
import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';

/** pngjs 只在 devDependencies 里,安装包里未必有:按需加载,加载不到就不裁(照整屏编),而不是整个模块起不来 */
let pngLib;
async function loadPng() {
  if (pngLib === undefined) pngLib = await import('pngjs').then((m) => m.default || m, () => null);
  return pngLib;
}

/** Windows 上对方开着目标文件时改名会 EPERM,最多重试这么多次(见 atomicWrite) */
const RENAME_ATTEMPTS = 40;

/**
 * 存储目录由几个进程共用(T1a 审查 #13):编辑器进程、预渲染进程(拆分时的 `user` / `agent` 两个也一样)
 * 都从同一个 `PROMPTCUT_EXPORT_DIR`(缺省 `<root>/out`)下的 `ai-visual/` 读写 —— 模型的 `get_gif` 在
 * 一个进程里写的渲染规格和记录,由另一个进程读得到、在那里渲
 * (cloud-task.md 决议 12:模型的 `get_gif` 在 `'agent'` 进程里只写 Spec,用户点开的 GET 和模型要的 `/render`
 * 都由 `user` 进程渲像素)。
 *
 * 所以这里的每一次写都**先写临时文件再改名**:另一个进程可能正在读同一个文件,直接 `writeFile`
 * 会让它读到半截 JSON(`readJson` 回 null,GET 就成了 404)或半张 GIF。
 * Windows 上对方刚好开着文件时改名会短暂 EPERM / EBUSY / EACCES,重试(最多 `RENAME_ATTEMPTS` 次,见函数体)。
 */
export async function atomicWrite(file, data) {
  await fsPromises.mkdir(path.dirname(file), { recursive: true });
  const ext = path.extname(file);
  // 临时名保留原扩展名:ffmpeg 按扩展名选输出格式(encodeGif 也走这里起临时名)
  const temp = `${file.slice(0, file.length - ext.length)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp${ext}`;
  try {
    // `data` 是函数时由它把内容写到临时名上(ffmpeg 直接输出到那里)
    if (typeof data === 'function') await data(temp);
    else await fsPromises.writeFile(temp, data);
  } catch (error) {
    await fsPromises.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  // 对方一直在读(每次开着文件几毫秒)时,改名只能落在它两次读之间的空档里:多试几次、每次随机等 5～25 ms,
  // 不和读者的节奏同步;最多约 1 秒。固定退避 5 次(约 0.3 秒)在连续读的另一个进程面前实测会耗尽。
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

/** 和拼图的 tile=4x2 对上，一张图正好 8 格；帧数少可以保证渲染快。 */
export const GIF_FRAMES = 8;

/** 
 * 取每段中点是因为这样能避开紧贴头尾产生的黑帧；
 * 保留 3 位小数是为了让同一片段多次采样得到完全相同的时刻，从而保证缓存 key 的稳定。
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
 * 过滤掉 undefined 的键，数组保持原本顺序，确保内容相同但键顺序不同的对象格式化一致。
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
 * 对 stableStringify 结果做哈希，是因为键顺序不同但内容相同的工程也应当命中同一份缓存动图。
 */
export function specKey(project, clipId) {
  const str = stableStringify({ project, clipId });
  return crypto.createHash('sha1').update(str).digest('hex').substring(0, 16);
}

/** 
 * 随机生成 AI 可视化标识符，加 v- 前缀便于区分。
 */
export function newVisualId() {
  return 'v-' + crypto.randomBytes(8).toString('hex');
}

/** 
 * 校验字符串是否为合法的 AI 可视化标识符，防注入。
 */
export function isVisualId(s) {
  return typeof s === 'string' && /^v-[0-9a-z]{6,40}$/.test(s);
}

/** 
 * 确保文件名只是简单的哈希+图片扩展名，防止路径穿越攻击（如 ../）。
 */
export function safeFileName(name) {
  if (typeof name !== 'string') return null;
  if (/^[0-9a-f]{16,40}\.(png|jpg|gif|webp)$/.test(name)) return name;
  return null;
}

/** 
 * 格式化数值用于友好展示，对过长字符串进行截断并美化小数。
 */
export function formatValue(v) {
  if (v === undefined) return '(无)';
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
 * 顺序固定是为了在界面上按照重要程度或固定习惯进行排布；
 * parts 只出一行是因为部件树太大，塞不下界面，所以用简短说明代替。
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
    diffs.push({ key: 'parts', from: '(原部件)', to: '(改动了部件)' });
  }

  return diffs;
}

/** 
 * 根据 base64 内容存为图片，用内容 sha1 命名，防重名与重复写入。
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
 * 确保存储目录存在后写入 JSON，封装通用操作。先写临时文件再改名(见 `atomicWrite`):
 * 另一个进程同时读这份规格 / 记录时,要么读到旧的完整一份,要么读到新的完整一份。
 */
export async function writeJson(dir, name, data) {
  await atomicWrite(path.join(dir, name), JSON.stringify(data));
}

/** 
 * 读不到返回 null 是因为调用方把「没有记录」和「文件坏了」当同一种情况处理，不用到处 try/catch。
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
 * spec 只给文件名不带 dir，因为它要作为参数传给 writeJson/readJson 的 name 参数。
 */
export function gifPaths(dir, key) {
  return { 
    gif: path.join(dir, `gif-${key}.gif`), 
    grid: path.join(dir, `gif-${key}-grid.png`), 
    spec: `spec-${key}.json` 
  };
}

/**
 * 卡片在 1920×1080 的舞台上往往只占一小块,聊天栏里前后对比那一行每张动图只有一百来像素宽,整屏缩下去字都看不清。
 * 所以动图只取这张卡 8 帧里出现过的区域(取并集:进场飞过的路也算进去),四周留边,再扩成和舞台一样的比例,
 * 免得每张动图长宽比不一。宽度不小于舞台的 1/4(= 动图输出宽 480),裁得再小也不放大,放大只会糊。
 * 帧没有透明像素(整屏不透明)、全空、或者裁完几乎就是整屏时返回 null,照整屏编。
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
 * 两遍 palettegen/paletteuse 是因为 GIF 只有 256 色，先生成调色板再上色才不糊；
 * 写临时目录并在 finally 里删是因为 ffmpeg 的 %02d 序列输入需要真实文件，且不同并发调用互不干扰。
 * crop 只裁给用户看的动图;交给 Agent 的拼图保持整屏,它要判断这张卡在画面里的位置和构图。
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
    // 先拼图、后动图,两个都经临时名改名到位(#13):别的进程按「gif 和 grid 都在」判缓存命中,
    // gif 最后一个出现,见到它就说明两份都已经完整落盘,不会读到 ffmpeg 写了一半的文件。
    // ffmpeg 的工作目录是临时目录,输出一律给绝对路径
    await atomicWrite(path.resolve(outGrid), temp => runFfmpeg([...argsGrid, temp]));
    await atomicWrite(path.resolve(outGif), temp => runFfmpeg([...argsGif, '-loop', '0', temp]));

    return { gif: outGif, grid: outGrid };
  } finally {
    await fsPromises.rm(tmp, { recursive: true, force: true });
  }
}

/** 
 * 试 winget 的固定路径是因为刚用 winget 装完 ffmpeg 时，已经在运行的进程 PATH 没刷新，可能找不到 ffmpeg。
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
