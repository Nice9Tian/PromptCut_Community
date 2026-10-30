/**
 * 两档素材的生成(C6.6,`docs/plan/c66-design.md` 第 2 节与第 8 节查资料结论;语义 `docs/semantics/product/asset-service.md`「两档素材」)。
 *
 * 在**导入方本机的编辑器进程**里做,用 `findFfmpeg`;素材服务从不转码。只对视频做,图片、音频不生成素材小尺寸。
 *
 * # 素材原尺寸:不转码,缺 faststart 才重封装
 *
 * - 只看普通 MP4 / MOV(扩展名 `mp4` / `m4v` / `mov`):按 ISO BMFF 顶层 box 逐个跳读(`scanTopLevelBoxes`),
 *   比较首个 `moov` 与 `mdat` 的位置;`mdat` 在前才算缺 faststart。有 `moof` 的分片 MP4、box 长度不合法、
 *   找不到 `moov` / `mdat` 的一律不动。MKV、WebM、AVI 没有 `moov`,不需要。
 * - 重封装:`ffmpeg -i <源> -map 0 -c copy -movflags +faststart -f <mp4|mov> <临时文件>`,同容器;
 *   写完先校验(box 顺序已是 faststart、各流的类型与编码逐一相同、时长相差不超过 0.05 s),通过了才按**输出文件**的
 *   哈希入库,算作新的素材原尺寸;任何一步失败都删掉临时文件、保留源文件当素材原尺寸,并记下原因。不转码、不删轨。
 * - 重封装前的那份文件是这次导入刚写进库的(不是去重命中的)就从库里删掉,免得库里留一份没人引用的;
 *   同时记下「源哈希 → 重封装后的哈希」,同一个文件再导入一次直接复用,不再跑一遍 ffmpeg。
 *
 * # 素材小尺寸:本机转码
 *
 * 照第 8 节的命令(`smallVideoArgs`):
 *   - 保留 VFR 时间戳,`select` 只丢间隔不足 1/60 s 的帧(留 0.2 ms 的容差:时间戳换算成秒有舍入,
 *     正好 1/60 s 的间隔按浮点比较会被误丢 —— 实测 120 fps 的源不加容差只剩 44.7 fps);
 *   - `scale` 不放大、保持显示比例、限 800×600、偶数尺寸、`reset_sar=1`;`format=yuv420p`;
 *   - `-map 0:v:0 -map 0:a:0?`:容忍没有音轨;`-autorotate` 是 ffmpeg 的缺省,旋转落进像素;
 *   - H.264 `-preset veryfast -crf 26`,AAC 64k,`-movflags +faststart`;
 *   - HDR:只对标签完整的 BT.2020 + PQ(`smpte2084`)源走 `zscale` + `tonemap` 分支,输出标 BT.709;
 *     其余(含 HLG、无标签)照 SDR 走〔裁〕。本机 ffmpeg 没有 `zscale` / `tonemap` 时 PQ 源不生成素材小尺寸(不拿普通
 *     8 bit 转换冒充 SDR 素材小尺寸),只有素材原尺寸一档。
 * - 转码在后台、一次一个、低于正常的进程优先级,不挡导入的回包,也不挡编辑。
 *
 * # 登记与上传
 *
 * - 本机内容库里「素材原尺寸 → 素材小尺寸」的对应记在 `<素材目录>/tiers.json`(本机缓存,不进项目);项目里的记录
 *   `project.media[i].tiers = { small?, original }` 由页面写(导入回包带素材原尺寸哈希,素材小尺寸好了之后页面经
 *   `GET /api/media/tiers` 取到素材小尺寸哈希再写进去)。同步状态不进项目。
 * - 素材小尺寸好了(或确定没有素材小尺寸)就把这个素材的两档交给上传队列(`upload-queue.mjs`):先小后大。
 * - 进程重启:`tiers.json` 里还是 `pending` 的接着转。
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { publishProjectFile } from './asset-store/project-io.mjs';
const tierJobContext = new AsyncLocalStorage();

export const SMALL_MAX_WIDTH = 800;
export const SMALL_MAX_HEIGHT = 600;
export const SMALL_MAX_FPS = 60;
/** 丢帧判据的容差(秒):见文件头 */
export const SMALL_FPS_EPSILON = 0.0002;
export const VIDEO_EXTS = Object.freeze(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'wmv', 'flv', '3gp']);
export const REMUX_EXTS = Object.freeze(['mp4', 'm4v', 'mov']);
export const TIERS_FILE = 'tiers.json';
const TIERS_VERSION = 1;
const HASH = /^[0-9a-f]{64}$/;

export const isVideoExt = (ext) => VIDEO_EXTS.includes(String(ext || '').toLowerCase());

/* ------------------------------------------------------------------ *
 * ISO BMFF 顶层 box
 * ------------------------------------------------------------------ */

/**
 * 逐个跳读顶层 box 的头(只读头,不读 `mdat` 的内容)。处理 32 位长度、`size = 1` 的 64 位长度、
 * `size = 0`(延伸到文件尾,只能是最后一个)。长度不合法就停下,`ok: false`。
 * @param {string} file
 * @returns {Promise<{ ok: boolean, size: number, boxes: { type: string, offset: number, size: number }[] }>}
 */
export async function scanTopLevelBoxes(file, { maxBoxes = 100_000 } = {}) {
  const fh = await fs.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const boxes = [];
    const head = Buffer.alloc(16);
    let offset = 0;
    while (offset < size && boxes.length < maxBoxes) {
      if (size - offset < 8) return { ok: false, size, boxes };
      const { bytesRead } = await fh.read(head, 0, 16, offset);
      if (bytesRead < 8) return { ok: false, size, boxes };
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let header = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) return { ok: false, size, boxes };
        const big = head.readBigUInt64BE(8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, size, boxes };
        boxSize = Number(big);
        header = 16;
      } else if (boxSize === 0) {
        boxSize = size - offset;
      }
      if (boxSize < header || offset + boxSize > size) return { ok: false, size, boxes: [...boxes, { type, offset, size: boxSize }] };
      boxes.push({ type, offset, size: boxSize });
      offset += boxSize;
    }
    return { ok: offset === size, size, boxes };
  } finally {
    await fh.close();
  }
}

/**
 * faststart 的判定:`'faststart'`(moov 在 mdat 前)、`'needs'`(mdat 在 moov 前)、
 * `'fragmented'`(有 moof,不动)、`'unknown'`(box 不合法或缺 moov / mdat,不动)。
 */
export async function faststartState(file) {
  let scan;
  try { scan = await scanTopLevelBoxes(file); } catch { return 'unknown'; }
  const types = scan.boxes.map((b) => b.type);
  if (types.includes('moof')) return 'fragmented';
  const moov = types.indexOf('moov');
  const mdat = types.indexOf('mdat');
  if (moov < 0 || mdat < 0) return 'unknown';
  return moov < mdat ? 'faststart' : 'needs';
}

/* ------------------------------------------------------------------ *
 * ffmpeg / ffprobe
 * ------------------------------------------------------------------ */

export const ffprobeOf = (ffmpegCmd) => String(ffmpegCmd).replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase() === 'ffmpeg.exe' ? 'ffprobe.exe' : 'ffprobe'));

/** 跑一个子进程,收 stdout / stderr;`low` 时把它降到低于正常的优先级 */
function run(cmd, args, { low = false, max = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { return resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) }); }
    tierJobContext.getStore()?.trackProcess(child);
    if (low && child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 调不了就算了 */ }
    }
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { if (stdout.length < max) stdout += d; });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: stderr + String(error?.message ?? error) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** ffprobe 一个文件:流与格式。读不了回 null */
export async function probeMedia(ffprobe, file) {
  const r = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  if (r.code !== 0) return null;
  try {
    const data = JSON.parse(r.stdout);
    const streams = Array.isArray(data.streams) ? data.streams : [];
    // 封面图(attached_pic)不算视频流
    const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition?.attached_pic)) ?? null;
    const audio = streams.find((s) => s.codec_type === 'audio') ?? null;
    const duration = Number(data.format?.duration);
    return { streams, format: data.format ?? {}, video, audio, duration: Number.isFinite(duration) ? duration : null };
  } catch { return null; }
}

/** 标签完整的 BT.2020 + PQ 源才走 HDR 分支〔裁〕 */
export function isHdrPq(video) {
  return !!video && video.color_transfer === 'smpte2084' && video.color_primaries === 'bt2020';
}

/** 素材小尺寸的视频滤镜串(传给 spawn 的一个参数,不经 shell) */
export function smallVideoFilter({ hdr = false, video = null } = {}) {
  const select = `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,1/${SMALL_MAX_FPS}-${SMALL_FPS_EPSILON})'`;
  const scale = `scale=w='min(iw\\,${SMALL_MAX_WIDTH})':h='min(ih\\,${SMALL_MAX_HEIGHT})':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1`;
  if (!hdr) return `${select},${scale},format=yuv420p`;
  const matrix = video?.color_space === 'bt2020c' ? 'bt2020c' : 'bt2020nc';
  const range = video?.color_range === 'pc' ? 'full' : 'limited';
  return `${select},zscale=tin=smpte2084:pin=bt2020:min=${matrix}:rin=${range}:t=linear:npl=100,format=gbrpf32le,`
    + `tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,${scale},format=yuv420p`;
}

/** 素材小尺寸的完整 ffmpeg 参数 */
export function smallVideoArgs(input, output, { hdr = false, video = null } = {}) {
  const args = ['-y', '-hide_banner', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', smallVideoFilter({ hdr, video }), '-fps_mode:v', 'vfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p'];
  if (hdr) args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  args.push('-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-f', 'mp4', output);
  return args;
}

/** 重封装的 ffmpeg 参数:同容器、全部流、只拷贝 */
export function remuxArgs(input, output, ext) {
  const format = String(ext).toLowerCase() === 'mov' ? 'mov' : 'mp4';
  return ['-y', '-hide_banner', '-v', 'error', '-i', input, '-map', '0', '-c', 'copy', '-movflags', '+faststart', '-f', format, output];
}

const streamSignature = (probe) => (probe?.streams ?? []).map((s) => `${s.codec_type}:${s.codec_name ?? '?'}`).join(',');

/** 本机 ffmpeg 有没有这几个滤镜(HDR 分支要 zscale、tonemap) */
const filterCache = new Map();
export async function hasFilters(ffmpeg, names) {
  let set = filterCache.get(ffmpeg);
  if (!set) {
    const r = await run(ffmpeg, ['-hide_banner', '-filters']);
    set = new Set();
    for (const line of String(r.stdout).split(/\r?\n/)) {
      const m = /^\s*[A-Z.|]{2,4}\s+(\S+)\s/.exec(line);
      if (m) set.add(m[1]);
    }
    filterCache.set(ffmpeg, set);
  }
  return names.every((n) => set.has(n));
}

/**
 * 缺 faststart 的普通 MP4 / MOV 做一次同容器重封装,写到 `output`(调用方给的临时路径)。
 * 回 `{ state: 'faststart' | 'skipped' | 'remuxed' | 'failed', reason? }`;`remuxed` 时 `output` 已写好并校验过,
 * 其余情况 `output` 不存在。
 */
export async function remuxIfNeeded({ ffmpeg, ffprobe = ffprobeOf(ffmpeg), input, ext, output }) {
  const e = String(ext || '').toLowerCase();
  if (!REMUX_EXTS.includes(e)) return { state: 'skipped', reason: 'container' };
  const before = await faststartState(input);
  if (before === 'faststart') return { state: 'faststart' };
  if (before !== 'needs') return { state: 'skipped', reason: before };
  const fail = async (reason) => { await fs.rm(output, { force: true }); return { state: 'failed', reason }; };
  const r = await run(ffmpeg, remuxArgs(input, output, e), { low: true });
  if (r.code !== 0) return fail(`ffmpeg ${r.code}: ${r.stderr.trim().slice(-400)}`);
  if (await faststartState(output) !== 'faststart') return fail('output-not-faststart');
  const [a, b] = await Promise.all([probeMedia(ffprobe, input), probeMedia(ffprobe, output)]);
  if (!a || !b) return fail('probe-failed');
  if (streamSignature(a) !== streamSignature(b)) return fail(`streams-differ: ${streamSignature(a)} vs ${streamSignature(b)}`);
  if (a.duration !== null && b.duration !== null && Math.abs(a.duration - b.duration) > 0.05) return fail(`duration-differ: ${a.duration} vs ${b.duration}`);
  return { state: 'remuxed' };
}

/**
 * 生成素材小尺寸到 `output`。回 `{ ok: true, hdr, width, height }` 或 `{ ok: false, reason }`(`reason: 'no-video'` 表示没有视频流)。
 */
export async function makeSmallVersion({ ffmpeg, ffprobe = ffprobeOf(ffmpeg), input, output, probe = null }) {
  const info = probe ?? await probeMedia(ffprobe, input);
  if (!info) return { ok: false, reason: 'probe-failed' };
  if (!info.video) return { ok: false, reason: 'no-video' };
  const hdr = isHdrPq(info.video);
  if (hdr && !(await hasFilters(ffmpeg, ['zscale', 'tonemap']))) return { ok: false, reason: 'no-zscale' };
  const r = await run(ffmpeg, smallVideoArgs(input, output, { hdr, video: info.video }), { low: true });
  if (r.code !== 0) { await fs.rm(output, { force: true }); return { ok: false, reason: `ffmpeg ${r.code}: ${r.stderr.trim().slice(-400)}` }; }
  const out = await probeMedia(ffprobe, output);
  if (!out?.video) { await fs.rm(output, { force: true }); return { ok: false, reason: 'output-probe-failed' }; }
  return { ok: true, hdr, width: out.video.width, height: out.video.height, codec: out.video.codec_name };
}

/* ------------------------------------------------------------------ *
 * 管理器:导入时的处理、后台转码、登记、交给上传队列
 * ------------------------------------------------------------------ */

async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, text);
  try { await fs.rename(tmp, file); }
  catch (error) { await fs.rm(tmp, { force: true }); throw error; }
}

const exists = async (file) => { try { await fs.stat(file); return true; } catch { return false; } };

/**
 * @param {object} options
 * @param {string} options.dir  本地内容库(素材目录)
 * @param {{ hashFile(file: string): Promise<string>, writeIndex(hash: string, entry: object): Promise<void>, contentTypeForExt(ext: string): string, forget?: (hash: string) => Promise<void> }} options.lib
 * @param {() => Promise<string>} options.ffmpeg  取 ffmpeg 命令(惰性,`findFfmpeg`)
 * @param {any} [options.queue]  上传队列(`createUploadQueue`);不给就只生成、不上传
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function createTierManager({ dir, lib, ffmpeg, queue = null, log = () => {}, ownership = null }) {
  const file = path.join(dir, TIERS_FILE);
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志出错不影响 */ } };
  /** 素材原尺寸哈希 → { state: 'pending' | 'ready' | 'failed' | 'none', small?, name?, ext?, reason? } */
  let items = {};
  /** 重封装前的哈希 → 重封装后的哈希 */
  let remuxed = {};
  try {
    const saved = JSON.parse(fsSync.readFileSync(file, 'utf8'));
    if (saved?.v === TIERS_VERSION && (!ownership || saved.projectId === ownership.projectId)) {
      if (saved.items && typeof saved.items === 'object') items = saved.items;
      if (saved.remuxed && typeof saved.remuxed === 'object') remuxed = saved.remuxed;
    }
  } catch { /* 没有就是空的 */ }

  let chain = Promise.resolve();
  const persist = () => {
    chain = chain.then(async () => { await ownership?.assert(); return atomicWrite(file, JSON.stringify({ v: TIERS_VERSION, items, remuxed, ...(ownership ? { projectId: ownership.projectId } : {}) }, null, 1)); })
      .catch((error) => say('tiers.persist-failed', { message: String(error?.message ?? error) }));
    return chain;
  };

  let cmd = null;
  const ffmpegCmd = async () => (cmd ??= await ffmpeg());

  /** 把库外(同一卷上)的临时文件按内容哈希挪进库;库里已有就删掉临时文件 */
  async function adoptTemp(tmp, { ext, name }) {
    try {
    const hash = await lib.hashFile(tmp);
    const fileName = ext ? `${hash}.${ext}` : hash;
    const dest = path.join(dir, fileName);
    const had = await exists(dest);
    await ownership?.assert();
    tierJobContext.getStore()?.signal.throwIfAborted();
    let size;
    if (ownership) {
      const existing = await lib.entry?.(hash), lease = tierJobContext.getStore();
      await publishProjectFile({ temp: tmp, target: dest, lease, assert: async () => { await ownership.assert(); await lease?.assert(); }, afterCommit: async () => { size = (await fs.stat(dest)).size; await lib.writeIndex(hash, { file: fileName, name, ext, size, contentType: lib.contentTypeForExt(ext) }); }, rollback: async () => { if (existing) await lib.writeIndex(hash, existing); else await lib.forget?.(hash); } });
    } else { if (had) await fs.rm(tmp, { force: true }); else await fs.rename(tmp, dest); size = (await fs.stat(dest)).size; await lib.writeIndex(hash, { file: fileName, name, ext, size, contentType: lib.contentTypeForExt(ext) }); }
    return { hash, ext, name, bytes: size, path: dest, url: `/@media/${hash}`, contentType: lib.contentTypeForExt(ext), deduped: had, ...(ownership ? { projectId: ownership.projectId } : {}) };
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  }

  /* ---------- 后台转码:一次一个 ---------- */
  const jobs = [];
  let busy = false;
  const idle = [];
  async function worker() {
    if (busy) return;
    busy = true;
    try {
      while (jobs.length) {
        const hash = jobs.shift();
        let lease;
        try {
          lease = await ownership?.acquire?.();
          await ownership?.assert();
          if (lease) await lease.run(() => tierJobContext.run(lease, () => buildSmall(hash)));
          else await tierJobContext.run(null, () => buildSmall(hash));
        } catch (error) { say('tiers.ownership-rejected', { hash, projectId: ownership?.projectId, code: error?.code ?? 'access-revoked' }); }
        finally { lease?.release(); }
      }
    } finally {
      busy = false;
      for (const resolve of idle.splice(0)) resolve();
    }
  }
  function schedule(hash) {
    if (!jobs.includes(hash)) jobs.push(hash);
    void worker();
  }

  async function buildSmall(hash) {
    const rec = items[hash];
    if (!rec || rec.state !== 'pending') return;
    const source = path.join(dir, rec.ext ? `${hash}.${rec.ext}` : hash);
    if (!(await exists(source))) {
      rec.state = 'failed';
      rec.reason = 'source-missing';
      await persist();
      return;
    }
    const tmp = path.join(dir, `.small-${crypto.randomBytes(8).toString('hex')}.mp4`);
    const started = Date.now();
    say('tiers.small-start', { hash });
    let result;
    try { result = await makeSmallVersion({ ffmpeg: await ffmpegCmd(), input: source, output: tmp }); }
    catch (error) { result = { ok: false, reason: String(error?.message ?? error) }; }
    if (result.ok) {
      const baseName = String(rec.name || hash).replace(/\.[^.]*$/, '');
      const stored = await adoptTemp(tmp, { ext: 'mp4', name: `${baseName}.small.mp4` });
      rec.state = 'ready';
      rec.small = stored.hash;
      rec.smallExt = 'mp4';
      rec.width = result.width;
      rec.height = result.height;
      if (result.hdr) rec.hdr = true;
      delete rec.reason;
      say('tiers.small-done', { hash, small: stored.hash, width: result.width, height: result.height, hdr: !!result.hdr, ms: Date.now() - started });
    } else {
      await fs.rm(tmp, { force: true });
      rec.state = result.reason === 'no-video' ? 'none' : 'failed';
      rec.reason = result.reason;
      say('tiers.small-failed', { hash, reason: result.reason });
    }
    await persist();
    await handToQueue(hash);
  }

  async function handToQueue(hash) {
    const rec = items[hash];
    if (!queue || !rec) return;
    const tiers = [];
    if (rec.state === 'ready' && rec.small) tiers.push({ tier: 'small', hash: rec.small, ext: rec.smallExt || 'mp4' });
    tiers.push({ tier: 'original', hash, ext: rec.ext || '' });
    try { await ownership?.assert(); await queue.enqueue({ name: rec.name || '', tiers, ...(ownership ? { projectId: ownership.projectId } : {}) }); }
    catch (error) { say('tiers.enqueue-failed', { hash, message: String(error?.message ?? error) }); }
  }

  /** 不是视频的素材(图片、音频):没有素材小尺寸,只把素材原尺寸交给上传队列;不登记进 items(那是两档的转码状态) */
  async function handOriginalToQueue(stored) {
    if (!queue) return;
    const hash = String(stored.hash).toLowerCase();
    const ext = String(stored.ext || '').toLowerCase().replace(/^\./, '');
    try { await ownership?.assert(); await queue.enqueue({ name: stored.name || '', tiers: [{ tier: 'original', hash, ext }], ...(ownership ? { projectId: ownership.projectId } : {}) }); }
    catch (error) { say('tiers.enqueue-failed', { hash, message: String(error?.message ?? error) }); }
  }

  return {
    get file() { return file; },
    /**
     * 导入之后调(`stored` 是 `storeMediaStream` / `adoptMediaFile` 的结果)。视频:缺 faststart 就重封装(原地等它做完,
     * 回包里的哈希就是重封装后的),再排素材小尺寸;不是视频(图片、音频)原样回,只把素材原尺寸交给上传队列(连远程素材服务时传过去,共享项目别的成员才取得到)。
     * 回 `{ stored, tiers: { original, small } | null, small: 'pending' | 'ready' | 'failed' | 'none' | null, remux }`。
     */
    async prepareImport(stored, { remux = true } = {}) {
      const lease = await ownership?.acquire?.();
      try { return lease ? await lease.run(() => tierJobContext.run(lease, prepare)) : await prepare(); }
      finally { await lease?.release(); }
      async function prepare() {
      await ownership?.assert();
      if (ownership && ((stored?.projectId && stored.projectId !== ownership.projectId) || !String(path.resolve(stored?.path ?? '')).startsWith(path.resolve(dir) + path.sep))) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch', status: 403 });
      const ext = String(stored?.ext || '').toLowerCase();
      if (!stored || !HASH.test(String(stored.hash))) return { stored, tiers: null, small: null, remux: null };
      if (!isVideoExt(ext)) {
        // 图片、音频只有素材原尺寸一档:照样交给上传队列(连远程素材服务时传过去,别的成员才取得到;连本机时队列是空操作)
        await handOriginalToQueue(stored);
        return { stored, tiers: null, small: null, remux: null };
      }
      let current = stored;
      let remuxInfo = { state: 'skipped', reason: 'disabled' };
      if (remux && REMUX_EXTS.includes(ext)) {
        const known = remuxed[stored.hash];
        const knownFile = known ? path.join(dir, `${known}.${ext}`) : null;
        if (known && knownFile && await exists(knownFile)) {
          // 同一个源文件之前重封装过:直接用那一份
          if (!stored.deduped) { await fs.rm(stored.path, { force: true }); await lib.forget?.(stored.hash); }
          current = { ...stored, hash: known, path: knownFile, url: `/@media/${known}`, bytes: (await fs.stat(knownFile)).size, deduped: true };
          remuxInfo = { state: 'remuxed', from: stored.hash, reused: true };
        } else {
          const tmp = path.join(dir, `.remux-${crypto.randomBytes(8).toString('hex')}.${ext}`);
          let r;
          try { r = await remuxIfNeeded({ ffmpeg: await ffmpegCmd(), input: stored.path, ext, output: tmp }); }
          catch (error) { await fs.rm(tmp, { force: true }); r = { state: 'failed', reason: String(error?.message ?? error) }; }
          if (r.state === 'remuxed') {
            const out = await adoptTemp(tmp, { ext, name: stored.name });
            if (!stored.deduped && out.hash !== stored.hash) { await fs.rm(stored.path, { force: true }); await lib.forget?.(stored.hash); }
            remuxed[stored.hash] = out.hash;
            await persist();
            current = out;
            remuxInfo = { state: 'remuxed', from: stored.hash };
            say('tiers.remuxed', { from: stored.hash, to: out.hash });
          } else {
            remuxInfo = r;
            if (r.state === 'failed') say('tiers.remux-failed', { hash: stored.hash, reason: r.reason });
          }
        }
      } else if (!REMUX_EXTS.includes(ext)) {
        remuxInfo = { state: 'skipped', reason: 'container' };
      }
      const hash = current.hash;
      let rec = items[hash];
      if (rec && rec.state === 'ready' && !(await exists(path.join(dir, `${rec.small}.${rec.smallExt || 'mp4'}`)))) rec = null;
      if (!rec || rec.state === 'failed') {
        rec = items[hash] = { state: 'pending', name: current.name || stored.name || '', ext };
        await persist();
        schedule(hash);
      } else if (rec.state === 'pending') {
        schedule(hash);
      } else {
        // 素材小尺寸早就有了(或确定没有):照样交给上传队列,远端已有的它会跳过
        await handToQueue(hash);
      }
      return {
        stored: current,
        tiers: { original: hash, small: rec.state === 'ready' ? rec.small : null },
        small: rec.state,
        remux: remuxInfo,
      };
      }
    },
    /**
     * 打开项目时补转素材小尺寸(设计稿第 9 节第 2 条):项目里缺 `tiers.small`、本地内容库里有这份素材原尺寸的视频,
     * 排进后台转码(不重封装 —— 哈希就是项目引用的那个,`.procp` 还原的素材同样)。
     * 已有素材小尺寸(文件还在)或确定没有视频流的不动;上次失败的再试一次。转好之后照常交给上传队列。
     * `ext` 是库里那份文件的扩展名。回 `{ state, small? }`,同 `status`。
     */
    async backfill({ hash, ext, name = '' }) {
      await ownership?.assert();
      const h = String(hash || '').toLowerCase();
      const e = String(ext || '').toLowerCase();
      if (!HASH.test(h) || !isVideoExt(e)) return { state: 'skipped' };
      let rec = items[h];
      if (rec && rec.state === 'ready' && !(await exists(path.join(dir, `${rec.small}.${rec.smallExt || 'mp4'}`)))) rec = null;
      if (rec && (rec.state === 'ready' || rec.state === 'none')) return this.status([h])[h];
      if (!rec || rec.state === 'failed') {
        rec = items[h] = { state: 'pending', name: String(name || ''), ext: e, backfill: true };
        await persist();
        say('tiers.backfill', { hash: h });
      }
      schedule(h);
      return { state: 'pending' };
    },
    /** 这些素材原尺寸哈希的素材小尺寸情况:`{ [hash]: { state, small? } }`;没登记过的是 `state: 'unknown'` */
    status(hashes) {
      const out = {};
      for (const raw of hashes ?? []) {
        const h = String(raw || '').toLowerCase();
        if (!HASH.test(h)) continue;
        const rec = items[h];
        out[h] = rec ? { state: rec.state, ...(rec.small ? { small: rec.small } : {}), ...(rec.reason ? { reason: rec.reason } : {}) } : { state: 'unknown' };
      }
      return out;
    },
    /** 进程重启后:还是 pending 的接着转 */
    resume() {
      for (const [hash, rec] of Object.entries(items)) if (rec?.state === 'pending') schedule(hash);
    },
    /** 等转码队列空(测试、探针用) */
    idle() {
      if (!busy && !jobs.length) return Promise.resolve();
      return new Promise((resolve) => idle.push(resolve));
    },
  };
}
