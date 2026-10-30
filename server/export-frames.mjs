/**
 * 导出专用的逐帧位图(在线浏览器的「完整导出」「快速导出」里,本页不执行的卡的画面来源;
 * 语义 `docs/semantics/product/platforms.md`「在线浏览器」的「导出」,用户 2026-10-13 定)—— 渲染节点这一侧。
 *
 * 在线页面的导出页不执行同步来的用户卡与素材效果卡。导出开始时页面发一个**只为导出**的清单计划(`input.exportOnly: true`),
 * 认领它的节点按清单里的片段各算一条流的计划(和轨道流同一个算法、同一个隔离工程、同一个取帧办法),但**不压成视频**:
 * 每一帧存成一张带透明的 PNG(原尺寸、无损),推到素材服务的像素那一类(`px/<哈希>`),清单写进内容库。页面按清单逐帧取。
 *
 * 和轨道流的区别:
 *   - 只给这一次导出用,不进层表,预览不读它;节点本机也不留(推完就删);
 *   - 没有稀疏版、没有收紧矩形:每帧都按这条流的矩形上界取;
 *   - 键另算:`exportKey = sha256("export-frames:<版本>\n<流的内容键>")`,结果键 = `exportKey × 环境指纹`。和这张卡的轨道流不是一个键,
 *     不占轨道流的卡片级指纹锁(任务的 `input` 里不带 `contentKey`,队列不给它建锁)。
 *
 * 任务沿用队列里的流任务(`kind: 'stream'`,范围单位是分段号),靠 `input.exportFrames: true` 认;队列和文档服务不用改。
 *
 * # 清单(内容库 `render-manifest`,键 `<结果键>:<起>-<止>`)
 *
 *   { v: 1, kind: 'export-frames', resultKey, range: { from, to },          // 范围是分段号(这条流自己的,从它的第一帧起每 15 帧一段)
 *     header: { kind: 'card' | 'below', plane: 'local' | 'stage', clipIds, fps, originFrame, lastFrame, rect, offset },
 *     frames: [[项目帧号, PNG 的 sha256, 字节数], ...] }                    // 帧号升序;`rect` 是每张图盖住的矩形(平面坐标)
 *
 * 本机落盘:`<库根>/export-frames/<结果键>/<项目帧号>.png`,推送成功后整段删掉。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { isStreamOrigin, streamSegmentFirstFrame, streamSegmentLastFrame } from '../src/render/streamSegments.mjs';

export { EXPORT_FRAMES_PRIORITY, isExportFramesTask, isExportOnlyPlan, exportIndexOf } from './render-node/export-plan.mjs';

/** 这种产物的版本:改了取帧办法或清单形状就加一,旧的结果键全部不再认 */
export const EXPORT_FRAMES_VERSION = 1;
/** 清单的 `kind` */
export const EXPORT_FRAMES_KIND = 'export-frames';
/** 清单的版本(同 `artifact-transfer.mjs` 的 `RESULT_VERSION`) */
export const EXPORT_RESULT_VERSION = 1;
/** 导出专用位图与清单的默认保留期:24 小时 */
export const EXPORT_FRAMES_TTL_MS = 24 * 60 * 60 * 1000;
/** 推块的并发 */
const PUSH_CONCURRENCY = 4;
const KEY_RE = /^[a-f0-9]{64}$/;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

/**
 * 重新做的标识(`salt`):页面上一次导出失败之后再点导出,计划里带一个新的标识(`input.exportSalt`),导出键跟着换,
 * 这一次的任务就是新任务 —— 队列里失败的任务在保留期内不会重开,不换键的话重新导出也只会拿到上一次的失败。
 * 只认小写字母与数字、最多 32 位;别的当没带。平时(没失败过)不带,同一份内容的结果键不变、再导出时直接用。
 */
export const exportSaltOf = value => (typeof value === 'string' && /^[0-9a-z]{1,32}$/.test(value) ? value : '');

/** 流的内容键 → 导出位图的内容键 */
export function exportFramesKey(streamContentKey, salt = '') {
  const tail = exportSaltOf(salt);
  return sha256(`export-frames:${EXPORT_FRAMES_VERSION}\n${streamContentKey ?? ''}${tail ? `\n${tail}` : ''}`);
}

/* ------------------------------------------------------------------ PNG */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** straight RGBA 原始像素 → PNG(8 位 RGBA,每行滤波 0)。画布直取与差分取层交出来的是原始像素,不是 PNG */
export function rgbaToPng(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('rgbaToPng 要正整数宽高');
  if (!rgba || rgba.length !== width * height * 4) throw new Error(`rgbaToPng 像素长度不对:${rgba?.length} ≠ ${width}×${height}×4`);
  const src = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) src.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}
/** 取帧钩子交来的一帧(PNG 的 Buffer,或 `{ rgba, width, height }`)→ PNG 字节 */
export function shotToPng(shot) {
  if (shot && typeof shot === 'object' && shot.rgba) return rgbaToPng(shot.rgba, shot.width, shot.height);
  if (Buffer.isBuffer(shot) || shot instanceof Uint8Array) return Buffer.isBuffer(shot) ? shot : Buffer.from(shot);
  throw new Error('取到的这一帧既不是 PNG 也不是原始像素');
}

/* ------------------------------------------------------------------ 计划 */

/**
 * 一条流的计划(`frame-stream.mjs` 的 `planStreams` 的一项)→ 导出位图的计划。只认单卡流(平面的独立卡、源依赖卡、三维外框的卡)
 * 和依赖下层的流;组流不认(导出位图一张卡一份,调用方算流时不合并)。回 null = 这条流出不了导出位图。
 */
export function exportSpecOf(spec, envFingerprint, salt = '') {
  if (!spec || typeof spec !== 'object') return null;
  if (!(spec.kind === 'card' || spec.kind === 'below') || !Array.isArray(spec.clipIds) || spec.clipIds.length !== 1) return null;
  if (typeof spec.contentKey !== 'string' || !spec.contentKey || typeof envFingerprint !== 'string' || !envFingerprint) return null;
  if (!isStreamOrigin(spec.originFrame) || !Number.isInteger(spec.lastFrame) || !Number.isInteger(spec.lastSegment) || spec.lastSegment < 0) return null;
  const tail = exportSaltOf(salt);
  const exportKey = exportFramesKey(spec.contentKey, tail);
  return { ...spec, exportKey, exportResultKey: sha256(`${exportKey}\n${envFingerprint}`), ...(tail ? { exportSalt: tail } : {}) };
}

/** 交给切分和回给页面的那一份(不带成员卡的控件等大对象) */
export function exportStreamOf(spec) {
  return {
    clipId: spec.clipIds[0], kind: spec.kind, plane: spec.plane, ...(spec.solo ? { solo: spec.solo } : {}),
    exportKey: spec.exportKey, originFrame: spec.originFrame, lastFrame: spec.lastFrame, firstSegment: 0, lastSegment: spec.lastSegment,
    fps: spec.fps, rect: spec.bound ? { ...spec.bound } : null, offset: spec.offset ? { ...spec.offset } : null,
    ...(spec.kind === 'below' ? { belowClipIds: [...(spec.belowClipIds ?? [])] } : {}),
    ...(spec.inputSig ? { inputSig: spec.inputSig } : {}),
    ...(spec.exportSalt ? { salt: spec.exportSalt } : {}),
  };
}

/* ------------------------------------------------------------------ 本机落盘 */

export const exportFramesDir = (root, resultKey) => path.join(root, 'export-frames', resultKey);
const frameFile = (dir, frame) => path.join(dir, `${frame}.png`);

/** 存一帧(先写临时名再改名,读的一侧不会读到半张) */
export async function storeExportFrame(root, resultKey, frame, png) {
  if (!KEY_RE.test(String(resultKey))) throw fail(`导出位图的结果键不对:${resultKey}`, { retryable: false });
  const dir = exportFramesDir(root, resultKey);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${frame}.${process.pid}.tmp`);
  await fs.writeFile(tmp, png);
  await fs.rename(tmp, frameFile(dir, frame));
}

/** 任务的范围(分段号)→ 它盖住的项目帧 `[from, to]`;`header` 是任务 `input.stream` 里带的那几项 */
export function exportTaskFrames(task) {
  const s = task?.input?.stream;
  const from = task?.range?.from, to = task?.range?.to;
  if (!s || !isStreamOrigin(s.originFrame) || !Number.isInteger(s.lastFrame) || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
  const first = streamSegmentFirstFrame(from, s.originFrame);
  const last = streamSegmentLastFrame(to, s.originFrame, s.lastFrame);
  return last >= first ? [first, last] : null;
}

const headerOf = task => {
  const s = task.input.stream;
  return { kind: s.kind, plane: s.plane, clipIds: [s.clipId], fps: s.fps, originFrame: s.originFrame, lastFrame: s.lastFrame, rect: s.rect, offset: s.offset ?? null };
};

/** 本机这一段已有的帧 → 清单(缺的帧不列)。回 `{ result, readBlob }` */
export async function collectExportResult(root, task) {
  const key = task?.resultKey;
  if (!KEY_RE.test(String(key))) throw fail(`导出位图任务的 resultKey 不对:${key}`, { retryable: false });
  const span = exportTaskFrames(task);
  if (!span) throw fail('导出位图任务缺流的形状', { retryable: false });
  const dir = exportFramesDir(root, key);
  const files = new Map();
  const frames = [];
  for (let f = span[0]; f <= span[1]; f++) {
    let buf;
    try { buf = await fs.readFile(frameFile(dir, f)); } catch { continue; }
    const hash = sha256(buf);
    files.set(hash, frameFile(dir, f));
    frames.push([f, hash, buf.length]);
  }
  const result = {
    v: EXPORT_RESULT_VERSION, kind: EXPORT_FRAMES_KIND, resultKey: key, range: { from: task.range.from, to: task.range.to },
    header: headerOf(task), frames, createdAt: Date.now(), exportOnly: true, ttlSec: Math.floor(EXPORT_FRAMES_TTL_MS / 1000),
  };
  return { result, readBlob: async hash => (files.has(hash) ? fs.readFile(files.get(hash)) : null) };
}

/** 清单是不是这一段的、而且每一帧都列了 */
export function exportResultComplete(body, task) {
  if (!body || typeof body !== 'object' || body.v !== EXPORT_RESULT_VERSION || body.kind !== EXPORT_FRAMES_KIND) return false;
  if (body.resultKey !== task?.resultKey || body.range?.from !== task?.range?.from || body.range?.to !== task?.range?.to) return false;
  const span = exportTaskFrames(task);
  if (!span || !Array.isArray(body.frames)) return false;
  const have = new Set();
  for (const item of body.frames) {
    if (!Array.isArray(item) || !Number.isInteger(item[0]) || !KEY_RE.test(String(item[1]))) return false;
    have.add(item[0]);
  }
  for (let f = span[0]; f <= span[1]; f++) if (!have.has(f)) return false;
  return true;
}

/** 推送成功后删掉本机这一段的帧(只给这一次导出用,不留);目录空了一并删 */
export async function dropExportFrames(root, task) {
  const span = exportTaskFrames(task);
  if (!span || !KEY_RE.test(String(task?.resultKey))) return;
  const dir = exportFramesDir(root, task.resultKey);
  for (let f = span[0]; f <= span[1]; f++) { try { await fs.rm(frameFile(dir, f), { force: true }); } catch { /* 已经没了 */ } }
  try { await fs.rmdir(dir); } catch { /* 还有别的段的帧 */ }
}

/**
 * 清理过期的导出位图（按保留期 TTL 24 小时清理落盘帧目录与内容库清单；素材服务上的块若支持也一并释放）。
 * 写入新导出位图时顺带触发，也可在定时任务或维护中调用。
 */
export async function sweepExpiredExportFrames(root, { maxAgeMs = EXPORT_FRAMES_TTL_MS, now = Date.now(), content = null, client = null, log = () => {} } = {}) {
  let cleanedDirs = 0, cleanedFrames = 0, cleanedManifests = 0;
  const baseDir = path.join(root, 'export-frames');
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(baseDir, entry.name);
      try {
        const stat = await fs.stat(dirPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          const files = await fs.readdir(dirPath).catch(() => []);
          cleanedFrames += files.length;
          await fs.rm(dirPath, { recursive: true, force: true });
          cleanedDirs++;
        }
      } catch { /* 忽略单个目录的错误 */ }
    }
  } catch { /* 目录可能不存在 */ }

  if (content && typeof content.list === 'function' && typeof content.del === 'function') {
    try {
      const listing = await content.list('render-manifest', '');
      for (const item of listing?.items ?? []) {
        if (!item?.key) continue;
        try {
          const manifest = await content.get('render-manifest', item.key);
          const body = manifest?.body;
          if (body && body.kind === EXPORT_FRAMES_KIND && body.createdAt && (now - body.createdAt > maxAgeMs)) {
            await content.del('render-manifest', item.key);
            cleanedManifests++;
            if (client && typeof client.drop === 'function' && Array.isArray(body.frames)) {
              for (const f of body.frames) {
                if (f && f[1]) await client.drop('px', f[1]).catch(() => {});
              }
            }
          }
        } catch { /* 单项失败不中断 */ }
      }
    } catch { /* list 不支持时不处理 */ }
  }

  log?.('export-frames.sweep', { cleanedDirs, cleanedFrames, cleanedManifests });
  return { cleanedDirs, cleanedFrames, cleanedManifests };
}

/** 导出完成或释放时显式释放特定结果键的本地临时帧与清单 */
export async function releaseExportFrames(root, resultKey, { content = null, client = null } = {}) {
  if (!KEY_RE.test(String(resultKey))) return;
  const dir = exportFramesDir(root, resultKey);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
  if (content && typeof content.list === 'function' && typeof content.del === 'function') {
    try {
      const listing = await content.list('render-manifest', `${resultKey}:`);
      for (const item of listing?.items ?? []) {
        if (item?.key) await content.del('render-manifest', item.key).catch(() => {});
      }
    } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ sink(推素材服务、写内容库) */

const manifestKey = task => `${task.resultKey}:${task.range.from}-${task.range.to}`;

async function settleLimited(items, limit, work) {
  let next = 0, failed = null;
  const lane = async () => {
    while (next < items.length && !failed) {
      const item = items[next++];
      try { await work(item); } catch (error) { failed ||= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failed) throw failed;
}

/**
 * 导出位图任务在产物库这一侧的三件事(形状同 `artifact-transfer.mjs` 的 `createAssetSink`,由它转过来):
 *   - `has`:内容库里有这一段的清单、每一帧都列了、块都在素材服务上 → 真(重发的计划不重渲);
 *   - `put`:按本机落盘的帧列清单、逐块推 `px`、清单写内容库,推完删本机的帧;缺帧或推失败回 `{ complete: false }`;
 *   - `resultFor`:`has` 认下的那一份清单。
 */
export function createExportFramesSink({ root, client, content = null, log = () => {} }) {
  const remembered = new Map();
  const say = (event, fields) => { try { log?.(event, fields); } catch { /* 日志出错不影响推送 */ } };
  let lastSweep = 0;
  const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
  return {
    async has(ref) {
      if (!content || typeof content.get !== 'function') return false;
      let item;
      try { item = await content.get('render-manifest', manifestKey(ref)); } catch { return false; }
      const body = item?.body;
      if (!exportResultComplete(body, ref)) return false;
      const hashes = [...new Set(body.frames.map(f => f[1]))];
      try {
        for (const hash of hashes) if (!(await client.has('px', hash))) return false;
      } catch { return false; }
      remembered.set(manifestKey(ref), body);
      return true;
    },
    async resultFor(ref) {
      return remembered.get(manifestKey(ref)) ?? null;
    },
    async put(ref, { report } = {}) {
      const started = Date.now();
      if (started - lastSweep > SWEEP_INTERVAL_MS) {
        lastSweep = started;
        sweepExpiredExportFrames(root, { maxAgeMs: EXPORT_FRAMES_TTL_MS, now: started, content, client, log }).catch(() => {});
      }
      const tell = fields => { try { report?.(fields); } catch { /* 诊断回调出错不影响推送 */ } };
      let pushed = 0, bytes = 0, blocks = null;
      const incomplete = (reason, extra = {}) => {
        const out = { complete: false, reason, stats: { blocks, pushed, bytes, ms: Date.now() - started } };
        say('sink.incomplete', { resultKey: String(ref?.resultKey ?? '').slice(0, 16), range: ref?.range ?? null, reason, exportFrames: true, ...out.stats, ...extra });
        return out;
      };
      let stage = 'collect';
      try {
        tell({ stage });
        const { result, readBlob } = await collectExportResult(root, ref);
        if (!exportResultComplete(result, ref)) return incomplete('range-missing', { listed: result.frames.length });
        const unique = [...new Map(result.frames.map(f => [f[1], f])).values()];
        blocks = unique.length;
        stage = 'push';
        tell({ stage, blocks, pushed, bytes });
        await settleLimited(unique, PUSH_CONCURRENCY, async ([, hash]) => {
          const buf = await readBlob(hash);
          if (!buf || sha256(buf) !== hash) throw fail(`块 ${hash} 的内容和清单对不上`);
          const put = await client.put('px', buf, { ext: 'png' });
          if (put?.hash && put.hash !== hash) throw fail(`素材服务回的哈希 ${put.hash} 和清单里的 ${hash} 不同`);
          pushed++; bytes += buf.length;
          tell({ stage, blocks, pushed, bytes });
        });
        if (content && typeof content.put === 'function') {
          try { await content.put('render-manifest', manifestKey(ref), result); }
          catch (error) { return incomplete('manifest-put-failed', { message: String(error?.message ?? error).slice(0, 200) }); }
        }
        await dropExportFrames(root, ref);
        return { complete: true, result, stats: { blocks, pushed, bytes, ms: Date.now() - started } };
      } catch (error) {
        // 素材服务说托管方渲染服务的产物到了容量上限:重试也没用(同 `createAssetSink`)
        if (error?.status === 507 && error?.body?.error === 'service-quota') throw Object.assign(new Error('service-quota'), { code: 'service-quota', status: 507, retryable: false });
        const code = error?.code ?? error?.status ?? null;
        return incomplete(`${stage}-failed${code !== null ? `:${String(code).slice(0, 40)}` : ''}`, { message: String(error?.message ?? error).slice(0, 200) });
      }
    },
  };
}
