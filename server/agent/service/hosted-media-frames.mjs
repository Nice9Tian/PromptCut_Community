/**
 * Media frame extraction and collage provider for Cloud Agent (`see_frames({ source: 'media', ... })`;
 * the media collage half of package breakdown table P1).
 *
 * Rules:
 *   - Before each call, verify current `runGrant` and `fenceRevision` using
 *     `resources.authorize(context, 'read')` (or `contextAccess.authorize(context, 'read')`);
 *   - Read authorized project media via `project.getMedia(context, mediaId)` and
 *     `assets.openRead(context, mediaId)`; never accept paths or cross-project `mediaId`;
 *   - Follow desktop app `visionTools` schema and collage grid contract for `source: 'media'`
 *     (default 6 frames/shot, max 12, supports `grid: 4` / `grid: 9`, images output directly, audio rejected);
 *   - When `ffmpeg` is missing or fails to start, return
 *     `{ ok: false, cloudUnavailable: true, error: ... }`;
 *   - Frame extraction/collage child processes are registered via `perception/runner.mjs`
 *     `spawnTree` + `superviseChild` to `resources.register(context, { kind: 'child', ... })`;
 *     on cancellation of this round (`abortForFence`) or `close()`, actually terminate the child
 *     process tree and clean up temporary files.
 *
 * Pure Node module, does not directly import `src/`.
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
const KIND_NAME = { image: 'Image', audio: 'audio', video: 'Video' };
const NOT_CONFIGURED = 'This cloud node has no ffmpeg configured, so the Cloud Agent cannot extract frames into a contact sheet from video media (see_frames source:"media"). View the timeline picture instead, or ask the user to check in PromptCut on their computer.';
const NO_FFMPEG = 'ffmpeg cannot start on this cloud node, so the Cloud Agent cannot extract frames into a contact sheet from video media (see_frames source:"media"). View the timeline picture instead, or ask the user to check in PromptCut on their computer.';

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
    ...(info.approximate ? { approximate: true, note: 'There are no sample points in this range; the numbers come from the nearest sample in time and are only approximate' } : null),
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
 * @param {((context: object) => object | Promise<object>) | object} [d.workspace] Chat workspace (function or instance; defaults to controlled subdirectory under system temp directory)
 * @param {object} d.project `{ getMedia(context, mediaId), getStage?(context) }`
 * @param {string | null} [d.ffmpeg] Path to ffmpeg executable
 * @param {string | null} [d.ffprobe] Path to ffprobe executable
 * @param {object | null} [d.config] Optional `{ ffmpeg, ffprobe, ffmpegArgs?, ffprobeArgs? }`
 * @param {object | null} [d.kernel] Optional `{ subjectForRange, suggestPosition, rectForSafeSide }`
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
  if (!authProvider) throw new MediaFramesToolError('Media contact sheet is missing a dependency: resources/contextAccess', 'media-frames-unconfigured');
  if (!assets || typeof assets.openRead !== 'function') throw new MediaFramesToolError('Media contact sheet is missing a dependency: assets', 'media-frames-unconfigured');
  if (!project || typeof project.getMedia !== 'function') throw new MediaFramesToolError('Media contact sheet is missing a dependency: project.getMedia', 'media-frames-unconfigured');

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
    if (closing) throw new MediaFramesToolError('The Cloud Agent service is shutting down and no longer accepts new work.', 'media-frames-closing', 503);
    if (!context || typeof context !== 'object' || typeof context.projectId !== 'string' || typeof context.runGrantId !== 'string') {
      throw new MediaFramesToolError('Missing trusted run context', 'tool-context-untrusted', 403);
    }
    try {
      return await authProvider.authorize(context, action);
    } catch (error) {
      if (error instanceof MediaFramesToolError) throw error;
      if (['run-authority-unavailable', 'tool-instance-unavailable', 'fence-unavailable', 'authorization-unavailable'].includes(error?.code)) {
        throw new MediaFramesToolError('The document service is temporarily unreachable, so permissions for this turn cannot be confirmed. Try again later.', 'authority-unavailable', 503);
      }
      throw new MediaFramesToolError('This turn has no permission to read the project (stopped, made private, or permission revoked).', 'media-frames-forbidden', 403);
    }
  }

  function scrub(text, wsDir = null) {
    let out = String(text ?? '');
    if (wsDir) out = out.split(wsDir).join('<working directory>');
    for (const secret of [bins.ffmpeg, bins.ffprobe].filter(Boolean)) {
      out = out.split(secret).join('<node directory>');
    }
    return out.replace(/[A-Za-z]:\\[^\s'",)]+/g, '<node directory>');
  }

  /*
   * Translate `assets.openRead` errors into text that the model can understand. Both image and video
   * paths go through here, preventing either path from passing raw codes like
   * `project-assets-read-failed` to the model: the model cannot tell if it should retry and would
   * just try again. When the channel is completely unavailable, state clearly that "retrying will
   * not help", so the model switches to another path.
   */
  function mediaFetchError(error, wsDir = null) {
    const code = error?.code ?? error?.message;
    const gone = error?.status === 404 || code === 'asset-missing';
    const shut = ['project-assets-read-failed', 'project-assets-unconfigured', 'project-assets-closed',
      'run-asset-transport-unconfigured', 'run-asset-response-invalid'].includes(code);
    const msg = gone ? 'The media bytes were not found on the asset service (upload incomplete or already cleaned up)'
      : shut ? `This cloud node cannot read the project media bytes right now (the asset service did not allow the Agent to read: ${scrub(code, wsDir).slice(0, 60)}), and retrying will not help. View the timeline picture instead (see_frames without mediaId), or ask the user to check the asset service on the cloud node.`
      : error?.status === 403 ? 'This turn has no permission to read this media (stopped, made private, or permission revoked).'
      : ['asset-size-mismatch', 'asset-hash-mismatch'].includes(code) ? 'The media bytes do not match the registered size/hash; this media is corrupted on the asset service.'
      : `Failed to fetch media (${scrub(code ?? error, wsDir).slice(0, 120)})`;
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
      throw new MediaFramesToolError('This turn no longer has permission to continue (stopped, made private, or Agent closed). The frame extraction process was not started.', 'media-frames-forbidden', 403);
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
      if (end.aborted || closing) throw new MediaFramesToolError('Frame extraction cancelled', 'cancelled', 499);
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
      if (end.aborted || closing) throw new MediaFramesToolError('Frame extraction cancelled', 'cancelled', 499);
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
    const timer = setTimeout(() => read.stream.destroy(new MediaFramesToolError('Image read timed out', 'fetch-timeout')), limits.fetchMs);
    timer.unref?.();
    try {
      for await (const chunk of read.stream) {
        if (closing) throw new MediaFramesToolError('Frame extraction cancelled', 'cancelled', 499);
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > limits.maxImageBytes) {
          throw new MediaFramesToolError('Image file is too large to return directly', 'too-large');
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
      note: 'This is an image, shown below as is (long edge scaled down to within 1280). To use it in card parameters, fill in cardUrl.',
      __images: [{ sceneIndex: 1, label: 'Original image', mime, base64: full.toString('base64') }],
    };
  }

  async function seeMediaFrames(context, args) {
    await authorize(context, 'read');
    if (args?.source !== undefined && args.source !== 'media') {
      throw new MediaFramesToolError('hosted-media-frames only handles frame contact sheets for source: "media" media', 'unsupported-source');
    }
    const mediaId = args?.mediaId;
    if (typeof mediaId !== 'string' || !MEDIA_ID_RE.test(mediaId)) {
      throw new MediaFramesToolError('mediaId is required, it is the id of the media (see list_media)', 'bad-args');
    }
    const media = await project.getMedia(context, mediaId);
    if (!media) {
      throw new MediaFramesToolError(`Media ${String(mediaId).slice(0, 80)} not found (no such id, or it is not in the current project)`, 'media-not-found', 404);
    }
    if (media.kind === 'audio') {
      throw new MediaFramesToolError(`${media.name} is not a video (it is audio), so there is no picture to view`, 'media-kind');
    }
    if (media.pending) {
      throw new MediaFramesToolError(`${media.name} is not in the asset service yet (upload incomplete or failed), try again later or re-import`, 'media-pending');
    }
    if (media.kind === 'image') {
      return await readImageMedia(context, media);
    }
    if (media.kind !== 'video') {
      throw new MediaFramesToolError(`${media.name} is not a video${KIND_NAME[media.kind] ? `(is ${KIND_NAME[media.kind]})` : ''}, so there is no picture to view`, 'media-kind');
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
      // 1. Stream video from authorized ProjectAssets to chat workspace temp directory
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
        fetchError = new MediaFramesToolError('Media fetch timed out', 'fetch-timeout');
        read.stream.destroy();
      }, limits.fetchMs);
      fetchTimer.unref?.();
      try {
        for await (const piece of read.stream) {
          if (closing) throw new MediaFramesToolError('Frame extraction cancelled', 'cancelled', 499);
          const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
          fetched += buf.length;
          if (fetched > limits.maxFetchBytes) throw new MediaFramesToolError('Media is too large, cloud frame extraction cannot fetch it', 'too-large');
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

      // 2. Determine duration and shot plan
      let duration = Number(media.duration);
      if (!(duration > 0)) {
        duration = await probeDuration(context, ws, absMedia, absDir);
      }
      const shots = media.shots ?? null;
      const { scenes: all, fallback } = scenesOf(shots, duration);
      if (!all.length) {
        throw new MediaFramesToolError(`${media.name} has no picture to view (duration is 0?)`, 'empty-media');
      }
      let plan;
      try {
        plan = planSequences(all, args);
      } catch (error) {
        throw new MediaFramesToolError(error?.message || String(error), 'bad-args');
      }

      // 3. Concurrently extract frames and build collages per shot (up to maxConcurrency ffmpeg child
      // processes, all registered with resources via superviseChild)
      const results = new Array(plan.scenes.length);
      let cursor = 0;
      const workerCount = Math.min(limits.maxConcurrency, Math.max(1, plan.scenes.length));
      const runSheetWorker = async () => {
        for (;;) {
          if (closing) throw new MediaFramesToolError('Frame extraction cancelled', 'cancelled', 499);
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
              throw new MediaFramesToolError('Frame extraction cancelled', 'cancelled', 499);
            }
            if (end.timedOut) {
              throw new Error('ffmpeg contact sheet timed out');
            }
            if (end.code !== 0 || !fs.existsSync(outFile)) {
              const tail = scrub(end.stderrTail.slice(-3).join(' '), wsDir).slice(0, 240);
              throw new Error(`ffmpeg exit code ${end.code}${tail ? `:${tail}` : ''}`);
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

      // 4. Re-verify current authorization and fenceRevision before returning
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
        const firstErr = results.find((r) => r?.error)?.error ?? 'Frame extraction failed';
        throw new MediaFramesToolError(`Media frame contact sheet failed: ${firstErr}`, 'sheet-failed');
      }

      const notes = [];
      if (fallback) {
        notes.push('Shot detection has not been run on this media, so it is split into 10-second segments below; the boundaries are not real shots.');
      }
      notes.push('Each contact sheet corresponds to the shot with the same index in scenes; cells, row by row from left to right, correspond to the seconds in frames.');
      notes.push(plan.nextPage ? `${plan.pages - plan.page} more pages: see_frames({ source: "media", mediaId, page: ${plan.nextPage} }).` : 'This is the last page.');
      notes.push("If a shot is hard to see: see_frames({ source: 'media', mediaId, scene: index, grid: 9 }).");
      if (!media.transcript) {
        notes.push('This media has not been transcribed yet; to check what is said, run transcribe_media first.');
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
        return Promise.reject(new MediaFramesToolError(`Media contact sheet does not handle ${String(name).slice(0, 60)}`, 'unknown-tool'));
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
