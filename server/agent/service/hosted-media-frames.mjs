/**
 * 云端 Agent 的素材抽帧拼图提供者（`see_frames({ source: 'media', ... })`；拆包表 P1 素材拼图那一半）。
 *
 * 规矩：
 *   - 每次调用前用 `resources.authorize(context, 'read')`（或 `contextAccess.authorize(context, 'read')`）核验当前 `runGrant` 与 `fenceRevision`；
 *   - 通过 `project.getMedia(context, mediaId)` 与 `assets.openRead(context, mediaId)` 读取受权项目素材，绝不接受路径或跨项目 `mediaId`；
 *   - 遵循桌面版 `visionTools` 对 `source: 'media'` 的 schema 与拼图网格契约（默认 6 帧/镜头、最多 12，支持 `grid: 4` / `grid: 9`，图片直出，音频拒绝）；
 *   - 缺 `ffmpeg` 或起不来时返回 `{ ok: false, cloudUnavailable: true, error: ... }`；
 *   - 抽帧/拼图子进程经 `perception/runner.mjs` 的 `spawnTree` + `superviseChild` 登记到 `resources.register(context, { kind: 'child', ... })`，
 *     本轮取消（`abortForFence`）或 `close()` 时真实终止子进程树并清理临时文件。
 *
 * 纯 Node 模块，不直接 import `src/`。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnTree, superviseChild } from './perception/runner.mjs';
import {
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
  FALLBACK_STEP_SEC,
  FRAME_EPS,
  scenesOf,
  planSequences,
  frameTimes,
  transcriptFor,
  sheetFfmpegArgs,
  probeImageDimensions,
} from '../../vision/media-sheet.mjs';

export {
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
  FALLBACK_STEP_SEC,
  FRAME_EPS,
  scenesOf,
  planSequences,
  frameTimes,
  transcriptFor,
  sheetFfmpegArgs,
  probeImageDimensions,
};

export const MEDIA_FRAMES_TOOL_NAMES = Object.freeze(['see_frames', 'see_media']);

export const MEDIA_FRAMES_DEFAULTS = Object.freeze({
  versionMs: 15_000,
  statusCacheMs: 15_000,
  probeMs: 30_000,
  sheetMs: 60_000,
  fetchMs: 120_000,
  maxFetchBytes: 1024 * 1024 * 1024,
  maxImageBytes: 64 * 1024 * 1024,
  maxConcurrency: 3,
});

export class MediaFramesToolError extends Error {
  constructor(message, code = 'media-frames-error', status = 400) {
    super(message);
    this.name = 'MediaFramesToolError';
    this.code = code;
    this.status = status;
  }
}

const MEDIA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/;
const KIND_NAME = { image: '图片', audio: '音频', video: '视频' };
const NOT_CONFIGURED = '这台云节点没有配置 ffmpeg，云端 Agent 无法对视频素材抽帧拼图（see_frames source:"media"）。请改看时间轴画面或请用户在电脑上的 PromptCut 里查看。';
const NO_FFMPEG = '这台云节点上 ffmpeg 起不来，云端 Agent 无法对视频素材抽帧拼图（see_frames source:"media"）。请改看时间轴画面或请用户在电脑上的 PromptCut 里查看。';

function topBoxes(boxes, limit = 4) {
  return [...boxes]
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, limit)
    .map((b) => ({
      label: b.label,
      x: Math.round(b.x),
      y: Math.round(b.y),
      w: Math.round(b.w),
      h: Math.round(b.h),
      conf: Math.round(b.conf * 100) / 100,
    }));
}

function subjectDigest(k, info, stage) {
  if (!k || !info) return null;
  const round2 = (v) => Math.round(v * 100) / 100;
  const sug = typeof k.suggestPosition === 'function' ? k.suggestPosition(info.safeSide, info.occupancy) : { suggestedPosition: null };
  return {
    safeSide: info.safeSide,
    ...sug,
    ...(stage && typeof k.rectForSafeSide === 'function'
      ? { suggestedRect: sug.suggestedPosition == null ? null : k.rectForSafeSide(info.safeSide, stage, 40) }
      : null),
    occupancy: {
      left: round2(info.occupancy.left),
      right: round2(info.occupancy.right),
      top: round2(info.occupancy.top),
      bottom: round2(info.occupancy.bottom),
    },
    sampledAt: info.times,
    boxCount: info.boxes.length,
    boxes: topBoxes(info.boxes),
    ...(info.approximate ? { approximate: true, note: '这段区间里没有采样点,数字来自时间上最近的一次采样,只是近似' } : null),
  };
}

function resolveBinaries({ ffmpeg, ffprobe, config }) {
  const ff = typeof ffmpeg === 'string' && ffmpeg ? ffmpeg : (typeof config?.ffmpeg === 'string' && config.ffmpeg ? config.ffmpeg : null);
  let fp = typeof ffprobe === 'string' && ffprobe ? ffprobe : (typeof config?.ffprobe === 'string' && config.ffprobe ? config.ffprobe : null);
  if (!fp && ff && path.isAbsolute(ff)) {
    const ext = path.extname(ff);
    const candidate = path.join(path.dirname(ff), `ffprobe${ext}`);
    if (fs.existsSync(candidate)) fp = candidate;
  }
  return {
    ffmpeg: ff,
    ffprobe: fp,
    ffmpegArgs: Array.isArray(config?.ffmpegArgs) ? config.ffmpegArgs : [],
    ffprobeArgs: Array.isArray(config?.ffprobeArgs) ? config.ffprobeArgs : [],
  };
}

/**
 * @param {object} d
 * @param {object} [d.contextAccess] F0 `createToolRunContextAccess`
 * @param {object} d.resources F0 `createRunResources`
 * @param {object} d.assets F0 `createProjectAssets`
 * @param {((context: object) => object | Promise<object>) | object} [d.workspace] 对话工作区（函数或实例；缺省用系统临时目录下的受控子目录）
 * @param {object} d.project `{ getMedia(context, mediaId), getStage?(context) }`
 * @param {string | null} [d.ffmpeg] ffmpeg 可执行文件路径
 * @param {string | null} [d.ffprobe] ffprobe 可执行文件路径
 * @param {object | null} [d.config] 可选 `{ ffmpeg, ffprobe, ffmpegArgs?, ffprobeArgs? }`
 * @param {object | null} [d.kernel] 可选 `{ subjectForRange, suggestPosition, rectForSafeSide }`
 */
export function createMediaFramesTools({
  contextAccess = null,
  resources = null,
  assets,
  workspace = null,
  project,
  ffmpeg = null,
  ffprobe = null,
  config = null,
  kernel = null,
  limits: limitsIn = {},
  now = Date.now,
  log = () => {},
} = {}) {
  const authProvider = resources && typeof resources.authorize === 'function'
    ? resources
    : (contextAccess && typeof contextAccess.authorize === 'function' ? contextAccess : null);
  if (!authProvider) throw new MediaFramesToolError('素材拼图缺少依赖:resources/contextAccess', 'media-frames-unconfigured');
  if (!assets || typeof assets.openRead !== 'function') throw new MediaFramesToolError('素材拼图缺少依赖:assets', 'media-frames-unconfigured');
  if (!project || typeof project.getMedia !== 'function') throw new MediaFramesToolError('素材拼图缺少依赖:project.getMedia', 'media-frames-unconfigured');

  const limits = { ...MEDIA_FRAMES_DEFAULTS, ...limitsIn };
  const bins = resolveBinaries({ ffmpeg, ffprobe, config });
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* ignore */ } };

  let closing = false;
  let ffmpegCache = null;
  const children = new Set();
  const activeStreams = new Set();
  const activeDirs = new Set();
  const inFlight = new Set();

  async function authorize(context, action = 'read') {
    if (closing) throw new MediaFramesToolError('云端 Agent 服务正在关闭,不再接新活。', 'media-frames-closing', 503);
    if (!context || typeof context !== 'object' || typeof context.projectId !== 'string' || typeof context.runGrantId !== 'string') {
      throw new MediaFramesToolError('缺少可信的运行上下文', 'tool-context-untrusted', 403);
    }
    try {
      return await authProvider.authorize(context, action);
    } catch (error) {
      if (error instanceof MediaFramesToolError) throw error;
      if (['run-authority-unavailable', 'tool-instance-unavailable', 'fence-unavailable', 'authorization-unavailable'].includes(error?.code)) {
        throw new MediaFramesToolError('文档服务暂时联系不上,没法确认这一轮的权限。稍后再试。', 'authority-unavailable', 503);
      }
      throw new MediaFramesToolError('这一轮没有读项目的权限(被停止、转私有或权限已撤)。', 'media-frames-forbidden', 403);
    }
  }

  function scrub(text, wsDir = null) {
    let out = String(text ?? '');
    if (wsDir) out = out.split(wsDir).join('<工作目录>');
    for (const secret of [bins.ffmpeg, bins.ffprobe].filter(Boolean)) {
      out = out.split(secret).join('<节点目录>');
    }
    return out.replace(/[A-Za-z]:\\[^\s'",)]+/g, '<节点目录>');
  }

  /*
   * `assets.openRead` 的报错翻成模型看得懂的话。图片和视频两条路都走这里,免得其中一条
   * 把 `project-assets-read-failed` 这种代号原样丢给模型 —— 它看不出该不该重试,只会再试一遍。
   * 通道整个不可用时明说「重试没用」,模型才会改走别的路。
   */
  function mediaFetchError(error, wsDir = null) {
    const code = error?.code ?? error?.message;
    const gone = error?.status === 404 || code === 'asset-missing';
    const shut = ['project-assets-read-failed', 'project-assets-unconfigured', 'project-assets-closed',
      'run-asset-transport-unconfigured', 'run-asset-response-invalid'].includes(code);
    const msg = gone ? '素材的字节在素材服务上找不到(上传没完成或已被清理)'
      : shut ? `这台云节点现在读不了项目素材的字节(素材服务没放行 Agent 读取:${scrub(code, wsDir).slice(0, 60)}),重试也没用。请改看时间轴画面(see_frames 不传 mediaId),或请用户检查云节点上的素材服务。`
      : error?.status === 403 ? '这一轮没有读这份素材的权限(被停止、转私有或权限已撤)。'
      : ['asset-size-mismatch', 'asset-hash-mismatch'].includes(code) ? '素材的字节和登记的大小/哈希对不上,这份素材在素材服务上坏了。'
      : `取素材失败(${scrub(code ?? error, wsDir).slice(0, 120)})`;
    return new MediaFramesToolError(msg, 'media-fetch-failed', error?.status === 403 ? 403 : shut ? 503 : 404);
  }

  async function resolveWorkspace(context) {
    if (typeof workspace === 'function') return await workspace(context);
    if (workspace && typeof workspace === 'object') return workspace;
    return null;
  }

  async function runChild(context, ws, command, args, { timeoutMs, cwd = null, onStdout = () => {}, onStderr = () => {} } = {}) {
    await authorize(context, 'read');
    const child = ws && typeof ws.spawn === 'function'
      ? ws.spawn(command, args, {})
      : spawnTree(command, args, { cwd: cwd || os.tmpdir() });
    const stderrTail = [];
    let run;
    try {
      run = await superviseChild(child, {
        resources: resources && typeof resources.register === 'function' ? resources : null,
        context,
        timeoutMs,
        onStdout: (d) => onStdout(d.toString('utf8')),
        onStderr: (d) => {
          const text = d.toString('utf8');
          onStderr(text);
          for (const l of text.split(/\r?\n/)) {
            if (l.trim()) {
              stderrTail.push(l.trim().slice(0, 300));
              if (stderrTail.length > 20) stderrTail.shift();
            }
          }
        },
      });
    } catch {
      throw new MediaFramesToolError('这一轮已经没有权限继续(被停止、转私有或 Agent 关闭),抽帧进程没有启动。', 'media-frames-forbidden', 403);
    }
    const done = run.done.then((end) => ({
      code: end.spawnError ? -1 : (end.code ?? -1),
      timedOut: end.timedOut,
      aborted: end.aborted,
      stderrTail,
      spawnError: end.spawnError ?? null,
    }));
    const entry = { kill: run.kill, closed: done.then(() => undefined) };
    children.add(entry);
    void entry.closed.then(() => children.delete(entry));
    if (closing) entry.kill();
    return { done, kill: entry.kill, signal: run.signal, closed: entry.closed };
  }

  async function checkFfmpeg(context, ws) {
    if (!bins.ffmpeg) return { ok: false, reason: NOT_CONFIGURED };
    if (ffmpegCache && now() - ffmpegCache.at < (ffmpegCache.value.ok ? limits.statusCacheMs : 2000)) {
      return ffmpegCache.value;
    }
    let value;
    try {
      let out = '';
      const run = await runChild(context, ws, bins.ffmpeg, [...bins.ffmpegArgs, '-hide_banner', '-nostdin', '-version'], {
        timeoutMs: limits.versionMs,
        onStdout: (t) => { if (out.length < 400) out += t; },
      });
      const end = await run.done;
      await run.closed;
      if (end.aborted || closing) throw new MediaFramesToolError('抽帧已取消', 'cancelled', 499);
      const version = out.split(/\r?\n/)[0]?.match(/ffmpeg version (\S+)/)?.[1];
      value = end.code === 0 && (version || bins.ffmpegArgs.length > 0) ? { ok: true, version: version ?? 'stub' } : { ok: false, reason: NO_FFMPEG };
    } catch (error) {
      if (error instanceof MediaFramesToolError) throw error;
      value = { ok: false, reason: NO_FFMPEG };
    }
    ffmpegCache = { at: now(), value };
    return value;
  }

  async function probeDuration(context, ws, filePath, cwd) {
    if (!bins.ffprobe) return 0;
    let out = '';
    try {
      const run = await runChild(context, ws, bins.ffprobe, [
        ...bins.ffprobeArgs,
        '-v', 'error', '-protocol_whitelist', 'file',
        '-show_entries', 'format=duration', '-of', 'json', filePath,
      ], {
        timeoutMs: limits.probeMs,
        cwd,
        onStdout: (t) => { if (out.length < 32 * 1024) out += t; },
      });
      const end = await run.done;
      await run.closed;
      if (end.aborted || closing) throw new MediaFramesToolError('抽帧已取消', 'cancelled', 499);
      if (end.code !== 0) return 0;
      const parsed = JSON.parse(out);
      const dur = Number(parsed?.format?.duration);
      return Number.isFinite(dur) && dur > 0 ? dur : 0;
    } catch (error) {
      if (error instanceof MediaFramesToolError) throw error;
      return 0;
    }
  }

  async function readImageMedia(context, media) {
    let read;
    try {
      read = await assets.openRead(context, media.id);
    } catch (error) {
      throw mediaFetchError(error);
    }
    activeStreams.add(read.stream);
    const chunks = [];
    let total = 0;
    const timer = setTimeout(() => read.stream.destroy(new MediaFramesToolError('读取图片超时', 'fetch-timeout')), limits.fetchMs);
    timer.unref?.();
    try {
      for await (const chunk of read.stream) {
        if (closing) throw new MediaFramesToolError('抽帧已取消', 'cancelled', 499);
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > limits.maxImageBytes) {
          throw new MediaFramesToolError('图片文件太大,无法直出', 'too-large');
        }
        chunks.push(buf);
      }
    } catch (error) {
      read.stream.destroy();
      await read.closed?.catch?.(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      activeStreams.delete(read.stream);
    }
    await read.closed?.catch?.(() => {});
    await authorize(context, 'read');
    const full = Buffer.concat(chunks);
    const probed = probeImageDimensions(full);
    const ext = String(media.ext || path.extname(media.name || '').slice(1)).toLowerCase();
    const mime = probed?.mime
      || (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg');
    const width = (probed?.width && probed.width > 0 ? probed.width : null) ?? media.width ?? null;
    const height = (probed?.height && probed.height > 0 ? probed.height : null) ?? media.height ?? null;
    const cardUrl = media.url || (media.hash ? `/@media/${media.hash}` : null);
    return {
      ok: true,
      mediaId: media.id,
      name: media.name,
      kind: 'image',
      width,
      height,
      cardUrl,
      note: '这是一张图片,下面就是它本身(长边缩到 1280 以内)。卡片参数里要用它就填 cardUrl。',
      __images: [{ sceneIndex: 1, label: '原图', mime, base64: full.toString('base64') }],
    };
  }

  async function seeMediaFrames(context, args) {
    await authorize(context, 'read');
    if (args?.source !== undefined && args.source !== 'media') {
      throw new MediaFramesToolError('hosted-media-frames 只处理 source: "media" 的素材抽帧拼图', 'unsupported-source');
    }
    const mediaId = args?.mediaId;
    if (typeof mediaId !== 'string' || !MEDIA_ID_RE.test(mediaId)) {
      throw new MediaFramesToolError('mediaId 必填,是素材的 id(可用 list_media 查看)', 'bad-args');
    }
    const media = await project.getMedia(context, mediaId);
    if (!media) {
      throw new MediaFramesToolError(`找不到素材 ${String(mediaId).slice(0, 80)}(没有这个 id,或它不在当前项目里)`, 'media-not-found', 404);
    }
    if (media.kind === 'audio') {
      throw new MediaFramesToolError(`${media.name} 不是视频(是音频),没有画面可看`, 'media-kind');
    }
    if (media.pending) {
      throw new MediaFramesToolError(`${media.name} 还没进素材服务(上传没完成或失败),稍后再试或重新导入`, 'media-pending');
    }
    if (media.kind === 'image') {
      return await readImageMedia(context, media);
    }
    if (media.kind !== 'video') {
      throw new MediaFramesToolError(`${media.name} 不是视频${KIND_NAME[media.kind] ? `(是${KIND_NAME[media.kind]})` : ''},没有画面可看`, 'media-kind');
    }

    const ws = await resolveWorkspace(context);
    const ff = await checkFfmpeg(context, ws);
    if (!ff.ok) {
      return { ok: false, cloudUnavailable: true, error: ff.reason };
    }

    const callId = `mf_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const relDir = `media-frames/${callId}`;
    const absDir = ws && typeof ws.resolve === 'function'
      ? ws.resolve(relDir)
      : fs.mkdtempSync(path.join(os.tmpdir(), `pc-media-frames-${callId}-`));
    fs.mkdirSync(absDir, { recursive: true });
    activeDirs.add(absDir);
    const wsDir = ws && typeof ws.dir === 'function' ? ws.dir() : absDir;

    try {
      // 1. 从受权 ProjectAssets 流式读取视频到对话工作区临时目录
      let read;
      try {
        read = await assets.openRead(context, mediaId);
      } catch (error) {
        throw mediaFetchError(error, wsDir);
      }
      const ext = typeof read.assetRef?.ext === 'string' && /^[a-z0-9]{1,8}$/.test(read.assetRef.ext) ? read.assetRef.ext : 'mp4';
      const relMedia = `${relDir}/media.${ext}`;
      const absMedia = ws && typeof ws.resolve === 'function' ? ws.resolve(relMedia) : path.join(absDir, `media.${ext}`);
      activeStreams.add(read.stream);
      const writer = ws && typeof ws.writer === 'function' ? ws.writer(relMedia) : null;
      const fd = !writer ? fs.openSync(absMedia, 'w') : null;
      let fetched = 0;
      let fetchError = null;
      const fetchTimer = setTimeout(() => {
        fetchError = new MediaFramesToolError('取素材超时', 'fetch-timeout');
        read.stream.destroy();
      }, limits.fetchMs);
      fetchTimer.unref?.();
      try {
        for await (const piece of read.stream) {
          if (closing) throw new MediaFramesToolError('抽帧已取消', 'cancelled', 499);
          const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
          fetched += buf.length;
          if (fetched > limits.maxFetchBytes) throw new MediaFramesToolError('素材太大,云端抽帧取不下来', 'too-large');
          if (writer) writer.write(buf);
          else fs.writeSync(fd, buf);
        }
        if (fetchError) throw fetchError;
        if (writer) writer.end();
        else if (fd !== null) fs.closeSync(fd);
      } catch (error) {
        if (writer) writer.abort();
        else if (fd !== null) { try { fs.closeSync(fd); } catch {} try { fs.rmSync(absMedia, { force: true }); } catch {} }
        read.stream.destroy();
        await read.closed?.catch?.(() => {});
        throw error;
      } finally {
        clearTimeout(fetchTimer);
        activeStreams.delete(read.stream);
      }
      await read.closed?.catch?.(() => {});

      // 2. 确定时长与镜头规划
      let duration = Number(media.duration);
      if (!(duration > 0)) {
        duration = await probeDuration(context, ws, absMedia, absDir);
      }
      const shots = media.shots ?? null;
      const { scenes: all, fallback } = scenesOf(shots, duration);
      if (!all.length) {
        throw new MediaFramesToolError(`${media.name} 没有可看的画面(时长为 0?)`, 'empty-media');
      }
      let plan;
      try {
        plan = planSequences(all, args);
      } catch (error) {
        throw new MediaFramesToolError(error?.message || String(error), 'bad-args');
      }

      // 3. 按镜头并发抽帧拼图（最多 maxConcurrency 个 ffmpeg 子进程，均经 superviseChild 登记到 resources）
      const results = new Array(plan.scenes.length);
      let cursor = 0;
      const workerCount = Math.min(limits.maxConcurrency, Math.max(1, plan.scenes.length));
      const runSheetWorker = async () => {
        for (;;) {
          if (closing) throw new MediaFramesToolError('抽帧已取消', 'cancelled', 499);
          const i = cursor++;
          if (i >= plan.scenes.length) return;
          const sc = plan.scenes[i];
          const outFile = path.join(absDir, `sheet-${sc.index}-${plan.grid}.jpg`);
          try {
            const spec = sheetFfmpegArgs({
              file: absMedia,
              start: sc.start,
              end: sc.end,
              grid: plan.grid,
              out: outFile,
              localOnly: true,
            });
            const run = await runChild(context, ws, bins.ffmpeg, [...bins.ffmpegArgs, ...spec.args], {
              timeoutMs: limits.sheetMs,
              cwd: absDir,
            });
            const end = await run.done;
            await run.closed;
            if (end.aborted || closing) {
              throw new MediaFramesToolError('抽帧已取消', 'cancelled', 499);
            }
            if (end.timedOut) {
              throw new Error('ffmpeg 拼图超时');
            }
            if (end.code !== 0 || !fs.existsSync(outFile)) {
              const tail = scrub(end.stderrTail.slice(-3).join(' '), wsDir).slice(0, 240);
              throw new Error(`ffmpeg 退出码 ${end.code}${tail ? `:${tail}` : ''}`);
            }
            const base64 = fs.readFileSync(outFile).toString('base64');
            results[i] = { ok: true, frames: spec.frames, __image: { mime: 'image/jpeg', base64 } };
          } catch (error) {
            if (error instanceof MediaFramesToolError && (error.code === 'cancelled' || error.code === 'media-frames-forbidden')) {
              throw error;
            }
            results[i] = { error: scrub(error?.message || String(error), wsDir) };
          } finally {
            try { fs.rmSync(outFile, { force: true }); } catch {}
          }
        }
      };
      await Promise.all(Array.from({ length: workerCount }, () => runSheetWorker()));

      // 4. 返回前重验当前授权与 fenceRevision
      await authorize(context, 'read');

      let stage = null;
      if (typeof project.getStage === 'function') {
        try {
          const s = await project.getStage(context);
          if (s && s.width > 0 && s.height > 0) stage = { width: s.width, height: s.height };
        } catch { stage = null; }
      }

      const images = [];
      const scenesOut = plan.scenes.map((sc, i) => {
        const r = results[i];
        if (r?.__image?.base64) {
          images.push({ sceneIndex: sc.index, mime: r.__image.mime || 'image/jpeg', base64: r.__image.base64 });
        }
        const text = transcriptFor(media.transcript, sc.start, sc.end);
        const subj = kernel && typeof kernel.subjectForRange === 'function' && media.subjects
          ? subjectDigest(kernel, kernel.subjectForRange(media.subjects, sc.start, sc.end), stage)
          : null;
        return {
          index: sc.index,
          start: sc.start,
          end: sc.end,
          duration: Math.round((sc.end - sc.start) * 100) / 100,
          in: sc.inTransition,
          out: sc.outTransition,
          frames: r?.frames ?? frameTimes(sc.start, sc.end, plan.grid),
          ...(text ? { transcript: text } : {}),
          subject: subj,
          ...(r?.error ? { imageError: r.error } : {}),
        };
      });

      if (plan.scenes.length > 0 && images.length === 0) {
        const firstErr = results.find((r) => r?.error)?.error ?? '抽帧失败';
        throw new MediaFramesToolError(`素材抽帧拼图失败:${firstErr}`, 'sheet-failed');
      }

      const notes = [];
      if (fallback) {
        notes.push('这个素材还没跑镜头识别,下面按每 10 秒一段切,边界不是真镜头。');
      }
      notes.push('每张拼图对应 scenes 里同序号的镜头,格子按行从左到右对应 frames 里的秒数。');
      notes.push(plan.nextPage ? `还有 ${plan.pages - plan.page} 页:see_frames({ source: "media", mediaId, page: ${plan.nextPage} })。` : '这是最后一页。');
      notes.push("某个镜头看不清:see_frames({ source: 'media', mediaId, scene: 序号, grid: 9 })。");
      if (!media.transcript) {
        notes.push('这个素材还没转写,想对照说了什么先 transcribe_media。');
      }

      return {
        ok: true,
        mediaId: media.id,
        name: media.name,
        engine: shots?.engine ?? null,
        ...(fallback ? { fallback } : {}),
        page: plan.page,
        pages: plan.pages,
        perPage: plan.perPage,
        grid: plan.grid,
        nextPage: plan.nextPage,
        prevPage: plan.prevPage,
        matched: plan.matched,
        totalScenes: plan.totalScenes,
        scenes: scenesOut,
        note: notes.filter(Boolean).join(' '),
        __images: images,
      };
    } finally {
      activeDirs.delete(absDir);
      try { fs.rmSync(absDir, { recursive: true, force: true }); } catch {
        say('agent.media-frames.cleanup-failed', { dir: '<temp>' });
      }
    }
  }

  return Object.freeze({
    handles: new Set(MEDIA_FRAMES_TOOL_NAMES),
    call(name, args, context, _options = {}) {
      if (!MEDIA_FRAMES_TOOL_NAMES.includes(name)) {
        return Promise.reject(new MediaFramesToolError(`素材拼图不处理 ${String(name).slice(0, 60)}`, 'unknown-tool'));
      }
      const p = Promise.resolve().then(() => seeMediaFrames(context, args ?? {}));
      inFlight.add(p);
      void p.then(() => inFlight.delete(p), () => inFlight.delete(p));
      return p;
    },
    async close(reason = 'close') {
      closing = true;
      for (const s of activeStreams) {
        try { s.destroy(); } catch {}
      }
      for (const child of children) {
        try { child.kill(); } catch {}
      }
      const outcomes = await Promise.allSettled([
        ...[...children].map((c) => c.closed),
        ...inFlight,
      ]);
      for (const dir of activeDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
      activeDirs.clear();
      return {
        childrenClosed: outcomes.every((o) => o.status === 'fulfilled') && children.size === 0,
        streamsClosed: activeStreams.size === 0,
        workPending: inFlight.size,
        reason,
      };
    },
  });
}
