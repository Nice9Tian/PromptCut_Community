/**
 * Full-video export arrangement: open prerender room / sharding / unified pipeline → card layer →
 * asset compositing → audio tracks.
 *
 * Split out from scripts/export-frames.mjs (pure refactoring, ported verbatim). The CLI entry
 * point is in scripts/export-frames.mjs.
 */

import path from 'path';
import fs from 'fs/promises';
import fsSync from 'node:fs';
import { spawn } from 'child_process';
import { buildComposeArgs, clipFrameRange } from '../export-compose.mjs';
import { buildAudioPlan, buildFfmpegArgs, playableAudioPlan } from './mux-audio.mjs';
import { findFfmpeg, ffprobeOf, runFfmpegProgress, streamPngVideo } from './ffmpeg.mjs';
import { DEFAULT_URL, openBakery } from './chrome.mjs';
import { bakeFrames } from './bake.mjs';
import { bakeSharded, resolveWorkers } from './shards.mjs';
import { fillGlassGaps, loadProject, mediaSourceOf, planMedia } from './media.mjs';
import { mixAudioInChrome } from './audio-mix.mjs';
// Unified pipeline. Previously a dynamic import in exportFrames solely to bypass the runtime
// cycle of export-frames ↔ export-unified; the cycle is now resolved (export-unified only depends
// on chrome / bake / shards / ffmpeg), statically imported here.
import { exportUnified } from './export-unified.mjs';
import { reachableCutContents } from '../../src/kernel/cutIdentity.mjs';

const MISSING_MATERIAL_FONT_CANDIDATES = Object.freeze({
  win32: (windir) => [
    path.join(windir, 'Fonts', 'msyh.ttc'),
    path.join(windir, 'Fonts', 'msyhbd.ttc'),
    path.join(windir, 'Fonts', 'simhei.ttf'),
    path.join(windir, 'Fonts', 'simsun.ttc'),
  ],
  linux: () => [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf',
  ],
});

/** Resolve only from trusted platform font locations; project fields never participate. */
export function findMissingMaterialFontFile({ platform = process.platform, windir = process.env.WINDIR || process.env.SystemRoot || 'C:/Windows', exists = fsSync.existsSync } = {}) {
  const candidates = platform === 'win32'
    ? MISSING_MATERIAL_FONT_CANDIDATES.win32(windir)
    : platform === 'linux'
      ? MISSING_MATERIAL_FONT_CANDIDATES.linux()
      : [];
  const fontFile = candidates.find((candidate) => exists(candidate));
  if (!fontFile) {
    const platformName = platform === 'win32' ? 'Windows Fonts' : platform === 'linux' ? 'Noto Sans CJK' : 'supported platform font locations';
    throw new Error(`Confirmed missing media needs a Chinese fallback font, but no usable font was found (${platformName}).`);
  }
  return fontFile;
}

/**
 * One-off export: opens its own bakery, renders frames, composites video, and closes it. CLI and
 * existing /api/export take this path.
 * opts.workers: number / 'auto' (default). Discrete sampling (targetFrames) and externally passed
 * bakery always run single-process.
 * opts.media: how assets enter the final video.
 *   'chrome' (default): preview, see_frames, and export share the FramePipeline/Chrome page, and
 *     video assets are loaded only on screenshot frames.
 *   'ffmpeg': compatibility bypass: the page only renders the card transparent layer
 *     (?cardsOnly=1), and video / images are composited into preview.mp4 by ffmpeg
 *     (server/export-compose.mjs). frames/ and overlay.mov therefore only contain cards.
 *   Externally passed bakery is already navigated to a URL and cannot change the page; treated as
 *     'chrome'.
 * opts.audio: how audio is mixed. Default is in Chrome (OfflineAudioContext, with audio effects,
 *   see mixAudioInChrome);
 *   'ffmpeg' mixes directly via the filtergraph in scripts/mux-audio.mjs (without effects), used
 *     for reconciliation and fallback.
 */
/**
 * Whether there are videos / images inside cut segments (at any depth). The compatibility bypass
 * ffmpeg compositing can only lay out media clips in the active cut; assets inside cut segments
 * must be laid out nested through the segment's box, cropping, and group opacity, which this path
 * cannot lay out.
 */
export function cutSegmentsHaveVisualMedia(project) {
  if (!project) return false;
  const visual = new Set((project.media ?? []).filter((m) => m && m.kind !== 'audio').map((m) => m.id));
  return reachableCutContents(project).some((c) => (c.tracks ?? []).some((t) => !t.hidden && (t.clips ?? []).some((cl) => cl.mediaId && visual.has(cl.mediaId))));
}

export async function exportFrames(opts) {
  const outDir = opts.out || 'out';
  const noVideo = opts.noVideo || false;
  const workers = (opts.bakery || opts.targetFrames) ? 1 : await resolveWorkers(opts.workers);
  let mediaMode = opts.media === 'ffmpeg' && !opts.bakery ? 'ffmpeg' : 'chrome';
  // Cut segments contain videos / images: the compatibility bypass cannot render them, so switch to
  // the default full-frame route (FrameScene renders along with assets), still present in the final
  // video (`mechanism/rendering.md` compatibility bypass item under "Cut segment")
  if (mediaMode === 'ffmpeg' && cutSegmentsHaveVisualMedia(await loadProject(opts.url || DEFAULT_URL, outDir).catch(() => null))) {
    console.log('[export] The cut segment contains videos or images: the --media=ffmpeg compatibility bypass cannot lay out nested media, so this run uses the default full whole-frame path');
    mediaMode = 'chrome';
  }
  const ffmpegCmd = await findFfmpeg();
  let plan = null;
  let bakeOpts = opts;
  if (mediaMode === 'ffmpeg') {
    const url = opts.url || DEFAULT_URL;
    bakeOpts = { ...opts, url: url + (url.includes('?') ? '&' : '?') + 'cardsOnly=1' };
    // No video output (--no-video) and discrete sampling do not composite, so asset planning and masks
    // are not needed
    if (!noVideo && !opts.targetFrames) {
      plan = await planMedia(opts, outDir, ffmpegCmd);
      if (plan?.glassFrames.size) bakeOpts.glassFrames = plan.glassFrames;
    }
  }
  let baked;
  // Full single-worker exports stream Chrome PNGs directly into local ffmpeg.
  // No frame buffer list or PNG directory is needed for the compositor.
  // Stream only a complete timeline.  A --frames segment starts its PNG
  // sequence at an arbitrary absolute frame; keeping that path file-backed
  // preserves the segment's start_number and avoids treating a partial stream
  // as a timeline that begins at frame zero.
  const streamCards = !opts.bakery && workers === 1 && !opts.targetFrames && !opts.frames && !noVideo;
  await fs.mkdir(outDir, { recursive: true });
  const streamedCards = streamCards ? streamPngVideo(ffmpegCmd, path.join(outDir, 'overlay.mov'), opts.fps || 30) : null;
  try {
    const unifiedProject = mediaMode === 'chrome' && !opts.bakery ? await loadProject(opts.url || DEFAULT_URL, outDir) : null;
    if (unifiedProject) {
      baked = await exportUnified(unifiedProject, { ...opts, url: opts.url || DEFAULT_URL,
        ...(streamedCards ? { onFrame: (_frame, buf) => streamedCards.write(buf), writeFrames: false } : {}) });
    } else if (workers > 1) {
      baked = await bakeSharded(bakeOpts, workers);
    } else {
      const bakery = opts.bakery || await openBakery(bakeOpts);
      try { baked = await bakeFrames(bakery, { ...bakeOpts, ...(streamedCards ? { onFrame: (_frame, buf) => streamedCards.write(buf), writeFrames: false } : {}) }); }
      finally { if (!opts.bakery) await bakery.close(); }
    }
    if (streamedCards) await streamedCards.finish();
  } catch (error) {
    await streamedCards?.abort();
    throw error;
  }
  const { framesDir, ext, fps, width, height, startFrame, endFrame, durationSec } = baked;

  if (!noVideo) {
    console.log('Running ffmpeg to generate video files...');
    const runFfmpeg = (args) => new Promise((resolve, reject) => {
      const proc = spawn(ffmpegCmd, args, { stdio: 'inherit', windowsHide: true });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)));
      proc.on('error', reject);
    });
    try {
      // Card transparent layer. When assets go through ffmpeg, there are only cards here: that is what
      // the name refers to: the layer used to overlay onto other visuals
      const bakedCardsVideo = baked.cardsVideo || null;
      if (streamCards || bakedCardsVideo) {
        console.log(`${bakedCardsVideo ? 'Sharded overlay.mov merged' : 'overlay.mov streamed from Chrome frames'} via local ffmpeg.`);
      }
      else {
        console.log('Creating overlay.mov...');
        await runFfmpeg(['-y', '-framerate', String(fps), '-start_number', String(startFrame),
          '-i', path.join(framesDir, `%06d.${ext}`), '-c:v', 'prores_ks', '-profile:v', '4444',
          '-pix_fmt', 'yuva444p10le', path.join(outDir, 'overlay.mov')]);
      }
      /*
       * Projects without assets also follow the same compositing path (0 asset layers = gray background +
       * cards). Previously a legacy command was kept here alone, which fell into the exact same trap:
       * card PNGs opaque for the entire frame lack alpha, causing ffmpeg to rebuild the filtergraph
       * midstream, randomly dropping frames and potentially hanging (measured on legacy preview.mp4 at
       * 1792/1800). Every input in buildComposeArgs carries -reinit_filter 0, plus a watchdog; routing
       * through it fixes both paths together.
       */
      const layers = (plan?.layers || []).filter((l) => clipFrameRange(l.clip, fps, startFrame, endFrame));
      await composePreview({ ffmpegCmd, baked, layers, outDir,
        cardsVideo: bakedCardsVideo || (streamCards ? path.join(outDir, 'overlay.mov') : null) });
      // Audio track: frame-by-frame screenshots only have visuals; audio is assembled back here
      // (soundtrack + audio that came with the video + audio effects)
      try {
        // Mix whichever project the page loaded (the same loadProject as planMedia): previously it only
        // recognized <out>/project.json, so when CLI --out pointed elsewhere it was silently without sound
        const proj = await loadProject(opts.url || DEFAULT_URL, outDir);
        if (proj) {
          const ffprobeCmd = ffprobeOf(ffmpegCmd);
          // Same asset lookup rules as the visual layer: /@media/<file> must also be reachable via the asset
          // service's HTTP, otherwise soundtrack / voiceover will all be skipped
          const sourceOf = (m) => mediaSourceOf(m, { outDir, pageUrl: opts.url || DEFAULT_URL });
          const plan = playableAudioPlan(buildAudioPlan(proj, outDir, undefined, sourceOf), ffprobeCmd);
          if (plan.length > 0) {
            const preview = path.join(outDir, 'preview.mp4');
            const withAudio = path.join(outDir, 'preview-audio.mp4');
            /*
             * Mixed in Chrome by default (OfflineAudioContext, same effect chain as editor preview, see
             * src/audio/renderMix.ts): audio effects are only available via this path. If it fails (mix page
             * fails to launch, page URL lacks /@export/<id>), fall back to mixing directly with ffmpeg:
             * effects will be gone, but soundtrack / voiceover / original audio are all preserved;
             * --audio ffmpeg forces the legacy path (for reconciliation).
             */
            let mixed = false;
            if (opts.audio !== 'ffmpeg') {
              try {
                const r = await mixAudioInChrome({ ffmpegCmd, outDir, plan, project: proj, pageUrl: opts.url || DEFAULT_URL, durationSec });
                await runFfmpeg(['-y', '-i', preview, '-i', r.mixWav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(durationSec), withAudio]);
                mixed = true;
                // Trimmed float32 wav and the entire mix.wav amount to 1-2 GB per hour, useless once composited
                // into the final video
                await fs.rm(path.join(outDir, 'audio'), { recursive: true, force: true }).catch(() => {});
              } catch (e) {
                if (plan.some(c => c.cardAudio || c.soundEffect)) throw e;
                const fx = plan.filter((c) => c.fx).length;
                console.error('Chrome mixing failed, falling back to direct ffmpeg mixing' + (fx ? '(' + fx + ' segments with audio effects attached will be lost)' : '') + ':', e.message);
              }
            }
            if (!mixed) {
              console.log('Muxing ' + plan.length + ' audio clip(s) with ffmpeg...');
              await runFfmpeg(buildFfmpegArgs(preview, plan, withAudio, durationSec));
            }
            fsSync.rmSync(preview);
            fsSync.renameSync(withAudio, preview);
            console.log('Audio muxed into preview.mp4');
          } else {
            console.log('No audio clips; preview.mp4 stays silent.');
          }
        }
      } catch (e) {
        throw new Error('Audio mux failed: ' + e.message, { cause: e });
      }
      console.log('Video synthesis complete.');
    } catch (e) {
      console.error('FFmpeg failed:', e.message);
      // Previously errors were swallowed here with a normal exit 0; the UI reported "Export complete",
      // and only upon retrieving the output did users find no preview.mp4
      process.exitCode = 1;
    }
  }
}

/**
 * The asset compositing step: gray background + asset layer (+ frosted glass) + card layer →
 * preview.mp4, in one ffmpeg pass.
 * Progress is read using -progress and logged as `Composited frame n/N`, forwarded to the UI by
 * vite-plugin-export.
 */
async function composePreview({ ffmpegCmd, baked, layers, outDir, cardsVideo = null }) {
  const { framesDir, ext, fps, width, height, startFrame, endFrame } = baked;
  const total = endFrame - startFrame + 1;
  const glassList = baked.glass?.list || [];
  const blurs = baked.glass?.blurs || [];
  const blur = blurs.length ? Math.max(...blurs) : 0;
  if (blurs.length > 1) console.warn(`Frosted glass has more than one blur amount (${blurs.join(' / ')} px), compositing with the largest, ${blur}px`);
  let mask = null;
  if (glassList.length && blur > 0) {
    await fillGlassGaps(baked.glass.dir, startFrame, endFrame, width, height);
    mask = { pattern: path.join(baked.glass.dir, '%06d.png'), blur };
  }
  const fontFile = layers.some((layer) => layer.missingMaterial)
    ? findMissingMaterialFontFile()
    : undefined;
  const { args, graph, notes, sidecars = [] } = buildComposeArgs({
    width, height, fps, startFrame, endFrame, layers, mask,
    cardsPattern: path.join(framesDir, `%06d.${ext}`),
    cardsVideo,
    out: path.join(outDir, 'preview.mp4'),
    fontFile,
    // Time-varying filters have one sendcmd script per clip, written into the export directory; use
    // absolute paths so as not to depend on ffmpeg's working directory
    sidecarDir: path.resolve(outDir),
  });
  await Promise.all(sidecars.map((s) => fs.writeFile(s.file, s.text, 'utf8')));
  for (const n of notes) console.warn('Compositing:', n);
  let finalArgs = args;
  // When there are many clips or with emphasis, the filter graph can be very long; the Windows
  // command line limit is 32K characters, passed via file if too long
  if (graph.length > 8000) {
    const f = path.join(outDir, 'compose-filter.txt');
    await fs.writeFile(f, graph, 'utf8');
    const k = args.indexOf('-filter_complex');
    finalArgs = [...args.slice(0, k), '-/filter_complex', f, ...args.slice(k + 2)];
  }
  console.log(`Creating preview.mp4: compositing ${layers.length} media clip(s)${mask ? ` + glass blur ${blur}px on ${glassList.length} frame(s)` : ''} with ffmpeg...`);
  const t0 = Date.now();
  let printed = -1;
  await runFfmpegProgress(ffmpegCmd, finalArgs, (n) => {
    const k = Math.min(total, n);
    if (k !== printed) {
      printed = k;
      console.log(`Composited frame ${k}/${total}`);
    }
  });
  console.log(`Composited ${total} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}
