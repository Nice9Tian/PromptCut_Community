/**
 * 画布直取(渲染重构「己一」,`docs/plan/prerender-products-contract.md` 第 6.1、6.2 节)—— Node 一侧。
 *
 * 画布与 WebGL 的卡产轨道流时,这一帧的像素不经过截图和 PNG:问页面要画布的 RGBA
 * (`src/render/gl/canvasGrab.ts`,导出页挂成 `window.__pcGrabCanvas`),原样交给 ffmpeg 的 `rawvideo` 输入
 * (`./ffmpeg.mjs` 的 `openStreamSegmentEncoder({ raw })`)。只有 `bakeStream` 的调用方(`server/frame-stream.mjs`)用它,
 * 导出和快照那几条路不经过这里。
 *
 * # 什么时候走直取(契约第 6.1 节的第二道:产流时实测)
 *
 * 每个分段的第一帧(挂好以后的第一帧也是某个分段的第一帧)两样都取:先取画布的像素,再照旧截一张图,
 * 把两张按预乘色和不透明度逐像素比。平均差都不超过 `DIRECT_MEAN_LIMIT`、明显不同的像素也没有超过
 * `directBadLimit` 才算过,这个分段余下的帧只取画布;不过的,这条流从此照旧走截图,记一条诊断。
 * **先取画布、后截图**这个顺序不能换:截图那一拍会让合成器真画一帧,画布要靠这一拍才更新的卡
 * (平时直取的帧没有这一拍)在这里会被比出来,不会混过去。
 *
 * 过了实测也不一定走直取:像素是经 CDP 搬的,画面里不透明的像素一多,搬比截图还慢(实测数字在
 * `docs/reports/AGENT-rr-canvas-direct.md`)。所以同一帧上两条路各花了多少毫秒也量着,直取省下的抵不过实测多花的,这个分段照旧截图,
 * 并且接下来 `DIRECT_COOLDOWN_SEGMENTS` 个分段不再试;压掉全透明像素以后仍超过原始大小 `DIRECT_MAX_FILL` 的,连搬都不搬。
 * 走哪条路不改画面(过了实测才有得选),只改快慢。
 *
 * # 取不到的那一帧
 *
 * 分段中途某一帧取不到(共享 WebGL 渲染器的平面帧号对不上等):这一帧改截图,解成 RGBA 再喂,
 * 不交出空图,也不换编码器的输入格式。截图也解不开就让这个分段失败重产。
 */
import zlib from 'node:zlib';

/** 契约第 6.1 节:预乘色、不透明度的平均差上限(满分 255) */
export const DIRECT_MEAN_LIMIT = 1;
/** 「明显不同」的像素:预乘色任一分量或不透明度差超过这个数 */
export const DIRECT_BAD_DIFF = 48;
/** 明显不同的像素最多占矩形面积的这个比例(另有一个不随面积变的底数,见 `directBadLimit`) */
export const DIRECT_BAD_RATIO = 1 / 20000;
/** 压掉全透明像素以后,搬运量超过原始 RGBA 的这个比例就不搬来试了(经 CDP 搬这么多一定比截图慢) */
export const DIRECT_MAX_FILL = 0.25;
/** 一个分段因为「直取不比截图快」照旧截图以后,接下来这么多个分段不再试(试一次要多取一遍、多比一遍) */
export const DIRECT_COOLDOWN_SEGMENTS = 8;

/**
 * 画布直取的三种档(`PROMPTCUT_STREAM_DIRECT`):
 *   - `always`(缺省):过了实测就走,不管快慢(推翻旧 auto,2026-10-14 决定 2.5);
 *   - `auto`:过了实测、而且这个分段量出来比截图快才走(旧的缺省);
 *   - `off`(写 `0` 也行):不走,和改之前一样每帧截图(探针拿它产对照)。
 */
export function directCaptureMode(env = process.env) {
  const want = String(env.PROMPTCUT_STREAM_DIRECT ?? '').trim().toLowerCase();
  if (want === '0' || want === 'off') return 'off';
  if (want === 'auto') return 'auto';
  return 'always';
}

/** 一个矩形里允许多少个明显不同的像素 */
export function directBadLimit(width, height) {
  return Math.max(4, Math.floor(width * height * DIRECT_BAD_RATIO));
}

/**
 * 解 PNG 成 straight RGBA。只认截图会给的那两种:8 位、不隔行的 RGBA(颜色类型 6)和 RGB(颜色类型 2,不透明度补 255)。
 * 认不了、数据不完整回 null。回 `{ width, height, data }`(`data` 是 `width × height × 4` 字节的 Buffer)。
 */
export function decodePngRgba(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  let off = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > buf.length) return null;
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = color === 6 ? 4 : color === 2 ? 3 : 0;
  if (depth !== 8 || interlace || !bpp || !width || !height) return null;
  let raw;
  try { raw = zlib.inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat)); } catch { return null; }
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;
  // 就地还原滤波:每行的结果写回 `raw` 自己(行首那个滤波字节之后),上一行已经是还原好的
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1) + 1;
    const up = base - (stride + 1);
    const f = raw[base - 1];
    if (f === 0) continue;
    if (f === 1) {
      for (let i = bpp; i < stride; i++) raw[base + i] = (raw[base + i] + raw[base + i - bpp]) & 255;
    } else if (f === 2) {
      if (y > 0) for (let i = 0; i < stride; i++) raw[base + i] = (raw[base + i] + raw[up + i]) & 255;
    } else if (f === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? raw[base + i - bpp] : 0, b = y > 0 ? raw[up + i] : 0;
        raw[base + i] = (raw[base + i] + ((a + b) >> 1)) & 255;
      }
    } else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? raw[base + i - bpp] : 0, b = y > 0 ? raw[up + i] : 0, c = i >= bpp && y > 0 ? raw[up + i - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        raw[base + i] = (raw[base + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    } else return null;
  }
  const data = Buffer.allocUnsafe(width * height * 4);
  if (bpp === 4) {
    for (let y = 0; y < height; y++) raw.copy(data, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  } else {
    for (let y = 0, o = 0; y < height; y++) {
      let i = y * (stride + 1) + 1;
      for (let x = 0; x < width; x++, i += 3, o += 4) { data[o] = raw[i]; data[o + 1] = raw[i + 1]; data[o + 2] = raw[i + 2]; data[o + 3] = 255; }
    }
  }
  return { width, height, data };
}

/**
 * 把页面压过的像素还原成整张 straight RGBA(`width × height × 4` 字节)。
 * 压法见 `src/render/gl/canvasGrab.ts` 的 `packTransparentRuns`:一串 `[跳过几个像素, 接着几个像素, 像素…]`,小端 32 位。
 * 数据越界或不完整就抛。
 */
export function unpackCanvasPixels(bytes, width, height) {
  const total = width * height;
  const out = Buffer.alloc(total * 4);
  let i = 0, o = 0;
  while (i < bytes.length) {
    if (i + 8 > bytes.length) throw new Error('画布像素的游程数据不完整');
    const skip = bytes.readUInt32LE(i), count = bytes.readUInt32LE(i + 4);
    i += 8;
    o += skip;
    if (o + count > total || i + count * 4 > bytes.length) throw new Error('画布像素的游程数据越界');
    bytes.copy(out, o * 4, i, i + count * 4);
    i += count * 4;
    o += count;
  }
  return out;
}

/**
 * 两张 straight RGBA 的差。颜色按预乘色比(进流的就是预乘色;全透明处 RGB 不算数)。
 * 回 `{ color, alpha, bad, pixels }`:预乘色平均差(三个分量一起平均)、不透明度平均差、明显不同的像素数、像素总数。
 */
export function compareRgba(a, b, width, height) {
  const pixels = width * height;
  if (a.length < pixels * 4 || b.length < pixels * 4) throw new Error('compareRgba:数据比矩形小');
  let color = 0, alpha = 0, bad = 0;
  for (let i = 0, end = pixels * 4; i < end; i += 4) {
    const aa = a[i + 3], ba = b[i + 3];
    if (!aa && !ba) continue;
    let da = aa - ba; if (da < 0) da = -da;
    let dr = (a[i] * aa - b[i] * ba) / 255; if (dr < 0) dr = -dr;
    let dg = (a[i + 1] * aa - b[i + 1] * ba) / 255; if (dg < 0) dg = -dg;
    let db = (a[i + 2] * aa - b[i + 2] * ba) / 255; if (db < 0) db = -db;
    alpha += da;
    color += dr + dg + db;
    if (da > DIRECT_BAD_DIFF || dr > DIRECT_BAD_DIFF || dg > DIRECT_BAD_DIFF || db > DIRECT_BAD_DIFF) bad++;
  }
  return { color: color / (pixels * 3), alpha: alpha / pixels, bad, pixels };
}

/** straight RGBA 里不透明度大于 `threshold` 的像素的包围盒(图片像素坐标);一个都没有回 null */
export function rgbaAlphaBox(data, width, height, threshold = 0) {
  let minX = width, minY = -1, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4 + 3;
    let first = -1, last = -1;
    for (let x = 0, i = row; x < width; x++, i += 4) if (data[i] > threshold) { if (first < 0) first = x; last = x; }
    if (first < 0) continue;
    if (minY < 0) minY = y;
    maxY = y;
    if (first < minX) minX = first;
    if (last > maxX) maxX = last;
  }
  return maxY < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * 问页面要片段 `clipId` 的画布在截图矩形 `rect`(场景坐标,整数)里的像素。
 * 回 `{ ok: true, rgba, width, height, bytes, readMs, moveMs }`(`readMs`:页面里读像素;`moveMs`:压、搬到 Node、还原),
 * 或 `{ ok: false, reason, bytes?, readMs?, moveMs? }`(原因见 `canvasGrab.ts`;另有 `no-hook`、`bad-size`、`bad-data`)。
 */
export async function grabCanvas(bakery, clipId, rect, { maxBytes } = {}) {
  const started = performance.now();
  const r = await bakery.page.evaluate((id, rc, o) => (typeof window.__pcGrabCanvas === 'function'
    ? window.__pcGrabCanvas(id, rc, o) : { ok: false, reason: 'no-hook' }), clipId, rect, maxBytes === undefined ? {} : { maxBytes });
  const readMs = Number(r?.readMs) || 0;
  const fail = (reason) => ({ ok: false, reason, bytes: r?.bytes, readMs, moveMs: Math.max(0, performance.now() - started - readMs) });
  if (!r?.ok) return fail(r?.reason || 'no-result');
  if (r.w !== rect.w || r.h !== rect.h || typeof r.b64 !== 'string') return fail('bad-size');
  let rgba;
  try {
    const bytes = Buffer.from(r.b64, 'base64');
    rgba = r.packed ? unpackCanvasPixels(bytes, r.w, r.h) : bytes;
  } catch { return fail('bad-data'); }
  if (rgba.length !== r.w * r.h * 4) return fail('bad-data');
  return { ok: true, rgba, width: r.w, height: r.h, bytes: r.bytes, readMs, moveMs: Math.max(0, performance.now() - started - readMs) };
}

/** 实测没过时,哪些原因算「这张卡不能直取」(其余的只是这一帧碰巧取不到) */
const PERMANENT_REASONS = /^(differs|canvas-count:\d+|unreadable|no-hook|png)$/;

/** 一条流的直取记录(挂在 `StreamProducer` 的流状态上,`status()` 原样给出去) */
export function newDirectRecord() {
  return {
    /** 实测没过的原因;有值以后这条流不再试直取 */
    failed: null,
    /** 还有几个分段不试直取(上一次试出来不比截图快) */
    cooldown: 0,
    /** 走直取的分段数 / 帧数;试过以后因为不比截图快(或画面太满)照旧截图的分段数;做过几次实测;碰巧取不到、改截图的帧数 */
    segments: 0, frames: 0, slowSegments: 0, checks: 0, misses: 0,
    /** 累计耗时(毫秒):页面里读像素、压和搬到 Node、实测(那一张截图加解码加比对) */
    readMs: 0, moveMs: 0, checkMs: 0,
    /** 最近一次实测的结果 `{ frame, pass, reason, color, alpha, bad, badLimit, bytes, grabMs, shotMs }`(`bytes`:搬了多少字节) */
    last: null,
  };
}

/**
 * 给 `bakeStream` 的 `capture` 用:一个分段一个。`capture(frame, shoot, { primed })` 回这一帧交给 `onFrame` 的东西 ——
 * 直取的是 `{ rgba, width, height }`,照旧截图的是 PNG 的 Buffer(`shoot()` 就是原来那次截图)。
 * 一个分段里要么全是前一种、要么全是后一种(由这个分段第一帧定),编码器的输入格式不会半路变。
 *
 * `record`:这条流的直取记录(`newDirectRecord`);`stride`:这个分段每隔几帧取一张;`captures`:这个分段一共取几张;
 * `always`:过了实测就走直取,不看快慢(`directCaptureMode` 的 `always` 档);`note(message)`:记一条诊断。
 */
export function directSegmentCapture(bakery, { clipId, rect, record, stride = 1, captures = 15, always = directCaptureMode() === 'always', note = () => {} }) {
  let mode = null;
  const shotAsRgba = async (shoot, why) => {
    const decoded = decodePngRgba(await shoot());
    if (!decoded || decoded.width !== rect.w || decoded.height !== rect.h) throw new Error(`画布直取:这一帧取不到(${why}),截图也解不开`);
    record.misses++;
    return { rgba: decoded.data, width: rect.w, height: rect.h };
  };
  return async (frame, shoot, { primed = true } = {}) => {
    if (mode === 'shot') return shoot();
    if (mode === 'direct') {
      const got = await grabCanvas(bakery, clipId, rect);
      record.readMs += got.readMs ?? 0;
      record.moveMs += got.moveMs ?? 0;
      if (!got.ok) return shotAsRgba(shoot, got.reason);
      record.frames++;
      return { rgba: got.rgba, width: got.width, height: got.height };
    }
    // 这个分段的第一帧:先取画布,再截图,比过了、而且不比截图慢才走直取
    const got = await grabCanvas(bakery, clipId, rect, always ? {} : { maxBytes: Math.floor(rect.w * rect.h * 4 * DIRECT_MAX_FILL) });
    if (!got.ok && got.reason === 'dense') {
      mode = 'shot';
      record.slowSegments++;
      record.cooldown = DIRECT_COOLDOWN_SEGMENTS;
      record.last = { frame, pass: null, reason: 'dense', bytes: got.bytes };
      return shoot();
    }
    const started = performance.now();
    const png = await shoot();
    const shotMs = performance.now() - started;
    record.checks++;
    let verdict;
    if (!got.ok) verdict = { pass: false, reason: got.reason };
    else {
      const ref = decodePngRgba(png);
      if (!ref || ref.width !== rect.w || ref.height !== rect.h) verdict = { pass: false, reason: 'png' };
      else if (ref.data.equals(got.rgba)) verdict = { pass: true, reason: null, color: 0, alpha: 0, bad: 0, badLimit: directBadLimit(rect.w, rect.h) };
      else {
        const diff = compareRgba(got.rgba, ref.data, rect.w, rect.h);
        const badLimit = directBadLimit(rect.w, rect.h);
        const pass = diff.color <= DIRECT_MEAN_LIMIT && diff.alpha <= DIRECT_MEAN_LIMIT && diff.bad <= badLimit;
        verdict = { pass, reason: pass ? null : 'differs', color: +diff.color.toFixed(4), alpha: +diff.alpha.toFixed(4), bad: diff.bad, badLimit };
      }
    }
    const checkMs = performance.now() - started;
    record.checkMs += checkMs;
    record.last = { frame, ...verdict, bytes: got.bytes };
    if (!verdict.pass) {
      mode = 'shot';
      // 这一帧碰巧取不到(平面的帧号对不上、卡还没挂上)只让这个分段走截图;比出差别、画布认不出来的,这条流从此走截图
      if (PERMANENT_REASONS.test(verdict.reason)) {
        record.failed = verdict.reason;
        note(`画布直取没过(${verdict.reason}${verdict.color === undefined ? '' : `:颜色差 ${verdict.color}、不透明度差 ${verdict.alpha}、明显不同的像素 ${verdict.bad} 个`}),这条流照旧走截图`);
      } else record.misses++;
      return png;
    }
    /*
     * 划不划算:截图那条路稳定下来每帧花多少 —— 满密度的分段相邻两帧都截,不用先丢一张(`primed` 为真时这一次多截了一张,减半);
     * 稀疏的分段每一帧前面都要先丢一张(翻倍)。直取每帧省下的,乘上这个分段余下的帧数,要抵得过这一次实测多花的
     * (那张截图加解码加比对);抵不过,这个分段就照旧截图。
     */
    const grabMs = got.readMs + got.moveMs;
    const perShot = (primed ? shotMs / 2 : shotMs) * (stride > 1 ? 2 : 1);
    record.last.grabMs = +grabMs.toFixed(2);
    record.last.shotMs = +perShot.toFixed(2);
    if (!always && (perShot - grabMs) * Math.max(0, captures - 1) <= checkMs) {
      mode = 'shot';
      record.slowSegments++;
      record.cooldown = DIRECT_COOLDOWN_SEGMENTS;
      return png;
    }
    mode = 'direct';
    record.segments++;
    record.frames++;
    record.readMs += got.readMs;
    record.moveMs += got.moveMs;
    return { rgba: got.rgba, width: got.width, height: got.height };
  };
}
