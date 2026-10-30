/**
 * 「依赖下层的流」两支探针(`below-diff-measure-probe.mjs`、`stream-below-probe.mjs`)共用的东西:
 * 两个场景的项目、素材视频和发它的小服务、开发服务器、把流盖回下层再比的那几种算法。
 *
 * 场景(`docs/plan/render-refactor-task.md`「戊二」的验收,契约 `docs/plan/prerender-products-contract.md` 第 13.2 节「下层二」):
 *
 *   甲  毛玻璃卡(里程表 `odometer`,审阅表里依赖下层)压在一张会动的卡(粒子 `particles`)和一段视频上面;
 *   乙  下层是半透明的:一枚不透明度 0.6、带阴影的药丸(`punch-pill`),底下什么都没有(透明),上面压同一张毛玻璃卡。
 *
 * 毛玻璃卡从 0.2 秒入场(不在分段边界上),所以头一个分段里有几帧页面上还没有它。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:这里会起开发服务器,不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
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
/** `edit: 'above'` 时加在毛玻璃卡上面的那张卡 */
export const ABOVE = 'clip-above';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const round2 = (n) => (n === null || n === undefined || Number.isNaN(n) ? null : +Number(n).toFixed(2));
export const round3 = (n) => (n === null || n === undefined || Number.isNaN(n) ? null : +Number(n).toFixed(3));
export const median = (list) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** 里程表按 1920×1080 设计:小画幅时整张卡按比例缩 */
const glassFrame = (width, height) => (width === 1920 && height === 1080 ? {} : { frame: { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: width / 1920 } });

/**
 * 场景项目。`kind`:`'a'`(甲)或 `'b'`(乙);`mediaUrl`:甲的视频地址。
 * `edit`:`'below'` 时把下层那张卡的参数改一处(验「下层改了键就变」用);`'above'` 时在毛玻璃卡上面多加一张卡
 * (验「上面的层怎么改键都不变」用)。
 */
export function scenarioProject(kind, { width, height, mediaUrl = '', edit = null } = {}) {
  const glass = { id: 'tr-glass', name: 'glass', hidden: false, clips: [
    { id: TARGET, kind: 'card', cardId: 'odometer', start: 0.2, end: DURATION, params: { position: 'left', value: 86420, label: '下层二探针' }, ...glassFrame(width, height) },
  ] };
  const base = { name: '依赖下层的流探针', width, height, fps: FPS, duration: DURATION, themeId: 'dark', filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {} };
  // 上面的层:右上角一枚小药丸,在毛玻璃卡上面
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

/** 场景里除目标卡以外的片段(都是它的下层) */
export const lowerClipIds = (kind) => (kind === 'a' ? ['clip-move', 'clip-video'] : ['clip-block']);

export function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

/** 在检出根起一台开发服务器(另占 +1、+2 当舞台端口)。回 `{ origin, stop() }`;只收自己起的这棵进程树 */
export async function startDevServer({ port, dataDir, tag = 'below' }) {
  if ([5190, 5191, 5192].some((p) => p >= port && p <= port + 2)) throw new Error('这一段是用户常驻的开发服务器的端口,换一个');
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
    if (child.exitCode !== null) throw new Error(`dev server 退出了:${log.join('').slice(-600)}`);
    if (await fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false)) break;
    if (Date.now() > deadline) { await stop(); throw new Error(`dev server 没起来:${log.join('').slice(-600)}`); }
    await sleep(300);
  }
  return { origin, pid: child.pid, stop };
}

/** 甲的视频:ffmpeg 的测试图样(有清晰的边、有连续的运动),每种画幅一份 */
export async function ensureVideo(ffmpeg, dir, width, height) {
  const file = path.join(dir, `below-probe-${width}x${height}.mp4`);
  if (!fsSync.existsSync(file)) {
    await fs.mkdir(dir, { recursive: true });
    await execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${FPS}:duration=${DURATION + 1}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-crf', '18', '-movflags', '+faststart', file], { windowsHide: true });
  }
  return file;
}

/** 发素材文件的小服务(认 Range,视频要能拖)。回 `{ url(name), close() }` */
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

/** 导出页的空项目地址(`FramePipeline.emptyUrl` 的写法) */
export const emptyUrlOf = (origin, { width, height }) => `${origin}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify({ width, height, fps: FPS, duration: 1, tracks: [], media: [] }))}`)}`;

/** ffmpeg 把 init + 一个分段解成逐帧 RGB(上下拼合的编码画面:上半预乘色,下半不透明度,各垫 8 行) */
export async function decodeSegment(ffmpeg, init, seg, dir, name) {
  const file = path.join(dir, `${name}.mp4`);
  await fs.writeFile(file, Buffer.concat([init, seg]));
  const { stdout } = await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1 << 30, windowsHide: true });
  await fs.rm(file, { force: true });
  return stdout;
}

/**
 * 误差的累计器:逐像素比「盖回去的画面」和「真画面」(都按预乘色,满分 255),四个通道一起算。
 * `mean`:平均差;`max`:最大差;`p999`:千分之九百九十九的像素不超过这个数;`bad`:最大通道差超过 `BAD` 的像素数。
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
 * 把一层 S(straight RGBA,`rect` 那么大)按普通的叠加盖在 `lower`(整幅,straight RGBA)上,和 `truth`(整幅)比,只比 `rect` 里面。
 * `frameWidth`:整幅的宽。误差记进 `e`。
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
 * 同上,S 是解码出来的编码画面(`decoded`:RGB,宽 `rect.w`,上半 `rect.h` 行是预乘色,隔 8 行以后是不透明度)。
 * 照页面的着色器(`src/render/streamPlayer.ts`)钳一次:颜色不超过不透明度。
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
 * 编码本身的误差:解码出来的编码画面直接和 `truth`(整幅,straight RGBA)在 `rect` 里比(预乘色和不透明度),不盖任何东西。
 * 把真画面原样编一遍再这样比,得到的就是「同一幅画面过一遍这个编码器会差多少」,当误差的参照。
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

/** 把解码出来的一帧盖回 `lower` 以后的画面裁出来(straight RGBA,`rect` 那么大),存图自己看用 */
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

/** 整幅 straight RGBA 里裁一块 */
export function cropRgba(data, frameWidth, rect) {
  const out = Buffer.alloc(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) data.copy(out, y * rect.w * 4, ((y + rect.y) * frameWidth + rect.x) * 4, ((y + rect.y) * frameWidth + rect.x + rect.w) * 4);
  return out;
}

/** straight RGBA 垫在深灰底上存成 PNG(给人看的) */
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
