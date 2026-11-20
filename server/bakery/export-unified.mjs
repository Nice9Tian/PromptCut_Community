import path from 'node:path';
import fs from 'node:fs/promises';
import { bakeFrames } from './bake.mjs';
import { openBakery } from './chrome.mjs';
import { findFfmpeg, streamPngVideo } from './ffmpeg.mjs';
import { resolveWorkers } from './shards.mjs';
import { resumableSink, retryOnBrowserLoss, useBakery } from './browser-loss.mjs';
// Join independently encoded part movies without decoding them again (shared via ./children.mjs).
import { concatVideos } from './children.mjs';
import { planShardRanges, shardPushDrawFrom } from '../../src/render/shardPlan.mjs';

/** Card clips of a project with an unknown frame mode, which the planner treats
 * as stateful. Used only when the export page cannot report modes. */
export function projectCardClips(project) {
  return (project.tracks || []).filter(track => !track.hidden)
    .flatMap(track => (track.clips || []).filter(clip => clip.cardId || clip.nodeId))
    .map(clip => ({ id: clip.id, start: Number(clip.start), end: Number(clip.end) }));
}

async function openSingleShardStreams({ enabled, ffmpeg, out, project, fps, startFrame, endFrame, liveComposeFactory }) {
  if (!enabled) return null;
  const overlayFile = path.join(out, 'overlay.mov');
  const overlay = streamPngVideo(ffmpeg, overlayFile, fps);
  let compose = null;
  try {
    if (liveComposeFactory) {
      compose = await liveComposeFactory({
        width: project.width || 1920, height: project.height || 1080, fps,
        startFrame, endFrame, framesDir: path.join(out, 'frames'), ext: 'png',
      });
    }
  } catch (error) {
    await overlay.abort().catch(() => {});
    throw error;
  }
  return {
    overlayFile,
    hasCompose: !!compose,
    write: (buf) => Promise.all([overlay.write(buf), compose?.write(buf)]),
    finish: () => Promise.all([overlay.finish(), compose?.finish()]),
    abort: () => Promise.all([overlay.abort().catch(() => {}), compose?.abort().catch(() => {})]),
  };
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
  let planClips = null;
  let ranges = [[startFrame, endFrame]];
  let partVideos = false, singleOverlay = false, ffmpeg = null, partsDir = null;
  try {
    if (!targetFrames && requestedWorkers > 1) {
      plannerBakery = await openBakery({ ...opts, url: opts.url });
      planClips = (await plannerBakery.page.evaluate(() => window.__pcClipFrameModes?.() ?? null)) ?? projectCardClips(project);
      ranges = planShardRanges(planClips, startFrame, endFrame, fps, requestedWorkers);
      console.log(`Shard export: ${ranges.length} segments ${ranges.map(([a, b]) => `${a}-${b}`).join(' ')}`);
    }
    partVideos = !opts.noVideo && ranges.length > 1 && !targetFrames;
    singleOverlay = !!opts.streamSingleOverlay && ranges.length === 1 && !partVideos && !opts.noVideo && !targetFrames && !opts.frames && !opts.onFrame;
    ffmpeg = (partVideos || singleOverlay) ? await findFfmpeg() : null;
    partsDir = partVideos ? path.join(out, 'parts') : null;
    if (partsDir) await fs.mkdir(partsDir, { recursive: true });
  } catch (error) {
    await plannerBakery?.close().catch(() => {});
    throw error;
  }
  const started = Date.now();
  let completed = 0;
  let first = null;
  let singleStreams = null;
  const shardProgress = new Map();
  const { streamSingleOverlay: _sso, liveComposeFactory, ...bakePassOpts } = opts;
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
      if (partFile) stream = streamPngVideo(ffmpeg, partFile, fps);
      else if (singleOverlay) {
        singleStreams = await openSingleShardStreams({
          enabled: true, ffmpeg, out, project, fps, startFrame: a, endFrame: b, liveComposeFactory,
        });
      }
    } catch (error) {
      await releasePlanner();
      throw error;
    }
    // A lost Chrome (server/bakery/browser-loss.mjs) restarts the shard from its safe
    // cut in a new browser; frames already delivered are not written twice.
    const deliver = stream
      ? (_frame, buf) => stream.write(buf)
      : singleStreams
        ? (_frame, buf) => singleStreams.write(buf)
        : bakePassOpts.onFrame;
    const sink = deliver ? resumableSink(deliver) : null;
    let finished = false;
    try {
      const result = await retryOnBrowserLoss(async (attempt) => {
        sink?.begin();
        const usePlanner = attempt === 0 && shardIndex === 0 && plannerBakery && !plannerHandedOver;
        if (usePlanner) plannerHandedOver = true;
        const bakery = usePlanner ? plannerBakery : await openBakery({ ...bakePassOpts, url: bakePassOpts.url });
        // Frame-push catch-up drawing (header of `bake.mjs`): from the second shard onward, cuts with no
        // stateful cards spanning across them skip catch-up (`pushDraw: false`) because earlier cards have
        // already been unmounted; cuts within a newly mounted card's pre-mount lead (`shardPushDrawFrom`)
        // catch up only from `pushDrawFrom` instead of redrawing all earlier frames. The first shard runs
        // as usual (when exporting only one section, cards on frames before it might still be alive).
        const leadDrawFrom = shardIndex > 0 && typeof bakePassOpts.pushDraw !== 'boolean'
          ? shardPushDrawFrom(planClips, a, fps) : null;
        const pushOpts = shardIndex > 0 && typeof bakePassOpts.pushDraw !== 'boolean'
          ? (leadDrawFrom === null ? { pushDraw: false } : { pushDraw: true, pushDrawFrom: leadDrawFrom })
          : {};
        return useBakery(bakery, () => bakeFrames(bakery, {
          // This movie is the final browser composition. The HTML-only snapshot
          // path intentionally omits video sources and cannot produce its frames.
          ...bakePassOpts, fullFrame: true, out: partDir, url: bakePassOpts.url, frames: `${a}-${b}`, workers: 1, onProgressLog: false,
          // A static-skip mismatch re-runs the whole pass, which would stream
          // the frames before the mismatch a second time.
          ...(sink ? { onFrame: sink.write, staticSkip: false } : {}),
          ...(stream ? { writeFrames: false } : {}),
          ...pushOpts,
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
      }, { label: `Shard ${a}-${b}` });
      if (stream) { await stream.finish(); finished = true; }
      if (singleStreams) { await singleStreams.finish(); finished = true; }
      result.part = { startFrame: a, endFrame: b, file: partFile };
      first ||= result;
      return result;
    } catch (error) {
      if (stream && !finished) await stream.abort().catch(() => {});
      if (singleStreams && !finished) await singleStreams.abort().catch(() => {});
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
    console.log(`Shard videos merged: ${files.length} parts -> ${cardsVideo}`);
    // Shards are byte-for-byte duplicates of the merged overlay.mov, deleted once merged (Storage Plan
    // Part A: takes up an extra dozen+ GB in large exports)
    await fs.rm(partsDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
  return {
    ...(first || { framesDir: path.join(out, 'frames'), ext: 'png', width: project.width, height: project.height }),
    fps, startFrame: allFrames[0], endFrame: allFrames.at(-1), totalFrames: allFrames.length,
    durationSec: (allFrames.length / fps).toFixed(3), reused: results.reduce((n, r) => n + (r.reused || 0), 0),
    elapsed: ((Date.now() - started) / 1000).toFixed(1),
    cardsVideo,
    cardsVideoStreamed: singleStreams?.overlayFile ?? null,
    previewStreamed: !!singleStreams?.hasCompose,
    parts: results.map((r) => r.part).filter(Boolean),
    glass: { dir: first?.glass?.dir ?? null, list: results.flatMap(r => r.glass?.list || []), blurs: [...new Set(results.flatMap(r => r.glass?.blurs || []))] },
  };
}
