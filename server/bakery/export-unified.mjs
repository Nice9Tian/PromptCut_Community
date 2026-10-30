import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bakeFrames } from './bake.mjs';
import { openBakery } from './chrome.mjs';
import { findFfmpeg, streamPngVideo } from './ffmpeg.mjs';
import { resolveWorkers } from './shards.mjs';
import { resumableSink, retryOnBrowserLoss, useBakery } from './browser-loss.mjs';
import { planShardRanges } from '../../src/render/shardPlan.mjs';

function concatPath(file) {
  return String(file).replace(/\\/g, '/').replace(/'/g, "'\\''");
}

/** Join independently encoded part movies without decoding them again. */
async function concatVideos(ffmpeg, parts, output) {
  if (!parts.length) throw new Error('没有可合并的导出分片');
  const list = output + '.concat.txt';
  await fs.writeFile(list, parts.map((file) => `file '${concatPath(path.resolve(file))}'`).join('\n') + '\n', 'utf8');
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
        '-c', 'copy', output], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
      proc.on('error', reject);
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`合并导出分片失败(ffmpeg ${code}): ${stderr}`)));
    });
  } finally { await fs.rm(list, { force: true }); }
}

/** Card clips of a project with an unknown frame mode, which the planner treats
 * as stateful. Used only when the export page cannot report modes. */
export function projectCardClips(project) {
  return (project.tracks || []).filter(track => !track.hidden)
    .flatMap(track => (track.clips || []).filter(clip => clip.cardId || clip.nodeId))
    .map(clip => ({ id: clip.id, start: Number(clip.start), end: Number(clip.end) }));
}

/** Stream each shard through Chrome/bakeFrames without retaining the HTML archive. */
export async function exportUnified(project, opts) {
  const fps = opts.fps || project.fps || 30;
  project = { ...project, fps };
  let startFrame = 0;
  let endFrame = Math.max(0, Math.floor(project.duration * fps) - 1);
  if (opts.frames) [startFrame, endFrame] = opts.frames.split('-').map(Number);
  const targetFrames = opts.targetFrames?.length ? [...new Set(opts.targetFrames)].sort((a, b) => a - b) : null;
  const allFrames = targetFrames || Array.from({ length: endFrame - startFrame + 1 }, (_, i) => i + startFrame);
  const out = opts.out || 'out';
  const requestedWorkers = targetFrames ? 1 : await resolveWorkers(opts.workers);
  // Only the export page knows each card's frame mode, so it plans the cuts.
  // That page then renders the first shard instead of costing another Chrome.
  let plannerBakery = null;
  let ranges = [[startFrame, endFrame]];
  let partVideos = false, ffmpeg = null, partsDir = null;
  try {
    if (!targetFrames && requestedWorkers > 1) {
      plannerBakery = await openBakery({ ...opts, url: opts.url });
      const clips = await plannerBakery.page.evaluate(() => window.__pcClipFrameModes?.() ?? null);
      ranges = planShardRanges(clips ?? projectCardClips(project), startFrame, endFrame, fps, requestedWorkers);
      console.log(`分片导出:${ranges.length} 段 ${ranges.map(([a, b]) => `${a}-${b}`).join(' ')}`);
    }
    partVideos = !opts.noVideo && ranges.length > 1 && !targetFrames;
    ffmpeg = partVideos ? await findFfmpeg() : null;
    partsDir = partVideos ? path.join(out, 'parts') : null;
    if (partsDir) await fs.mkdir(partsDir, { recursive: true });
  } catch (error) {
    await plannerBakery?.close().catch(() => {});
    throw error;
  }
  const started = Date.now();
  let completed = 0;
  let first = null;
  const shardProgress = new Map();
  const render = async ([a, b], shardIndex) => {
    // Shard 0 owns the planner's Chrome until it hands it to useBakery. If the
    // shard fails before that (e.g. its part directory cannot be created), close it.
    let plannerHandedOver = false;
    const releasePlanner = async () => {
      if (shardIndex !== 0 || !plannerBakery || plannerHandedOver) return;
      plannerHandedOver = true;
      await plannerBakery.close().catch(() => {});
    };
    const partDir = partsDir ? path.join(partsDir, String(shardIndex).padStart(3, '0')) : out;
    const partFile = partsDir ? path.join(partDir, 'overlay.mov') : null;
    let stream = null;
    try {
      if (partsDir) await fs.mkdir(partDir, { recursive: true });
      stream = partFile ? streamPngVideo(ffmpeg, partFile, fps) : null;
    } catch (error) {
      await releasePlanner();
      throw error;
    }
    // A lost Chrome (server/bakery/browser-loss.mjs) restarts the shard from its safe
    // cut in a new browser; frames already delivered are not written twice.
    const deliver = stream ? (_frame, buf) => stream.write(buf) : opts.onFrame;
    const sink = deliver ? resumableSink(deliver) : null;
    let finished = false;
    try {
      const result = await retryOnBrowserLoss(async (attempt) => {
        sink?.begin();
        const usePlanner = attempt === 0 && shardIndex === 0 && plannerBakery && !plannerHandedOver;
        if (usePlanner) plannerHandedOver = true;
        const bakery = usePlanner ? plannerBakery : await openBakery({ ...opts, url: opts.url });
        return useBakery(bakery, () => bakeFrames(bakery, {
          // This movie is the final browser composition. The HTML-only snapshot
          // path intentionally omits video sources and cannot produce its frames.
          ...opts, fullFrame: true, out: partDir, url: opts.url, frames: `${a}-${b}`, workers: 1, onProgressLog: false,
          // A static-skip mismatch re-runs the whole pass, which would stream
          // the frames before the mismatch a second time.
          ...(sink ? { onFrame: sink.write, staticSkip: false } : {}),
          ...(stream ? { writeFrames: false } : {}),
          // 推帧补画(`bake.mjs` 文件头):第二片起不补 —— 切点只落在没有有状态的卡跨着的帧上,前面推过去的卡到切点都已卸掉;
          // 补的话每一片要把前面的帧真的再画一遍。第一片照常(只导一段时它前面那些帧上的卡可能还活着)。
          ...(shardIndex > 0 && typeof opts.pushDraw !== 'boolean' ? { pushDraw: false } : {}),
          quiet: true,
          onProgress: (frame) => {
            const local = Math.max(0, Math.min(b, frame) - a + 1);
            const previous = shardProgress.get(a) || 0;
            if (local <= previous) return;
            shardProgress.set(a, local);
            completed += local - previous;
            console.log(`Exported frame ${frame} (${completed}/${allFrames.length})`);
          },
        }));
      }, { label: `分片 ${a}-${b}` });
      if (stream) { await stream.finish(); finished = true; }
      result.part = { startFrame: a, endFrame: b, file: partFile };
      first ||= result;
      return result;
    } catch (error) {
      if (stream && !finished) await stream.abort().catch(() => {});
      await releasePlanner();
      throw error;
    }
  };
  const results = await Promise.all(ranges.map((range, index) => render(range, index)));
  let cardsVideo = null;
  if (partVideos) {
    const files = results.map((r) => r.part.file);
    cardsVideo = path.join(out, 'overlay.mov');
    await concatVideos(ffmpeg, files, cardsVideo);
    console.log(`分片视频已合并: ${files.length} 个 part -> ${cardsVideo}`);
    // 分片是合并后 overlay.mov 的逐字节重复,合完就删(存储计划 A 部分:大的导出里多占十几 GB)
    await fs.rm(partsDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
  return {
    ...(first || { framesDir: path.join(out, 'frames'), ext: 'png', width: project.width, height: project.height }),
    fps, startFrame: allFrames[0], endFrame: allFrames.at(-1), totalFrames: allFrames.length,
    durationSec: (allFrames.length / fps).toFixed(3), reused: results.reduce((n, r) => n + (r.reused || 0), 0),
    elapsed: ((Date.now() - started) / 1000).toFixed(1),
    cardsVideo,
    parts: results.map((r) => r.part).filter(Boolean),
    glass: { dir: first?.glass?.dir ?? null, list: results.flatMap(r => r.glass?.list || []), blurs: [...new Set(results.flatMap(r => r.glass?.blurs || []))] },
  };
}
