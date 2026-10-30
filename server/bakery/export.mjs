/**
 * 整片导出编排:开预渲染间 / 分片 / 统一管线 → 卡片层 → 素材合成 → 音轨。
 *
 * 从 scripts/export-frames.mjs 拆出来(纯重构,逐字搬运)。命令行入口在 scripts/export-frames.mjs。
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
// 统一管线。以前是 exportFrames 里的动态 import,只为绕开 export-frames ↔ export-unified
// 的运行时环;环已经解开(export-unified 只依赖 chrome / bake / shards / ffmpeg),这里静态引。
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
    throw new Error(`确认缺失素材需要中文代理字体，但未找到可用字体（${platformName}）。`);
  }
  return fontFile;
}

/**
 * 一次性导出:自己开 bakery、渲帧、合成视频、关掉。CLI 和现有的 /api/export 走这条。
 * opts.workers:数字 / 'auto'（默认）。离散取样(targetFrames)和外部传进来的 bakery 一律单进程。
 * opts.media:素材怎么进成片。
 *   'chrome'(默认)—— 预览、see_frames、导出共用 FramePipeline/Chrome 页面，视频素材在截图帧才加载。
 *   'ffmpeg'       —— 兼容旁路:页面只渲卡片的透明层(?cardsOnly=1),视频 / 图片由 ffmpeg 合进 preview.mp4
 *                      (server/export-compose.mjs)。frames/ 和 overlay.mov 因此只有卡片。
 *   外部传进来的 bakery 已经导航到某个地址,改不了页面,按 'chrome' 处理。
 * opts.audio:声音怎么混。默认在 Chrome 里(OfflineAudioContext,带音频效果,见 mixAudioInChrome);
 *   'ffmpeg' 走 scripts/mux-audio.mjs 的滤镜图直接混(没有效果),对账和兜底用。
 */
/**
 * 剪辑段里有没有视频 / 图片(任意深度)。兼容旁路的 ffmpeg 合成只摆得了激活剪辑里的素材段,
 * 剪辑段里的素材要经段的框、裁切、组不透明度嵌套摆放,这一路摆不出来。
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
  // 剪辑段里有视频 / 图片:兼容旁路画不出它们,改走缺省的完整整帧路线(FrameScene 连素材一起渲),成片里照样有
  // (`mechanism/rendering.md`「剪辑段」的兼容旁路一条)
  if (mediaMode === 'ffmpeg' && cutSegmentsHaveVisualMedia(await loadProject(opts.url || DEFAULT_URL, outDir).catch(() => null))) {
    console.log('[export] 剪辑段里有视频或图片:--media=ffmpeg 的兼容旁路摆不出嵌套的素材,这次改走缺省的完整整帧路线');
    mediaMode = 'chrome';
  }
  const ffmpegCmd = await findFfmpeg();
  let plan = null;
  let bakeOpts = opts;
  if (mediaMode === 'ffmpeg') {
    const url = opts.url || DEFAULT_URL;
    bakeOpts = { ...opts, url: url + (url.includes('?') ? '&' : '?') + 'cardsOnly=1' };
    // 不出视频(--no-video)、离散取样都不合成,也就用不上素材规划和遮罩
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
      // 卡片透明层。素材走 ffmpeg 时这里只有卡片 —— 名字说的就是它:叠到别的画面上用的那一层
      const bakedCardsVideo = baked.cardsVideo || null;
      if (streamCards || bakedCardsVideo) {
        console.log(`${bakedCardsVideo ? '分片 overlay.mov 已合并' : 'overlay.mov 已由 Chrome 帧流式写入'}本地 ffmpeg。`);
      }
      else {
        console.log('Creating overlay.mov...');
        await runFfmpeg(['-y', '-framerate', String(fps), '-start_number', String(startFrame),
          '-i', path.join(framesDir, `%06d.${ext}`), '-c:v', 'prores_ks', '-profile:v', '4444',
          '-pix_fmt', 'yuva444p10le', path.join(outDir, 'overlay.mov')]);
      }
      /*
       * 没有素材的项目也走同一条合成(0 个素材层 = 灰底 + 卡片)。以前这里单留一条老命令,它踩的是同一个坑:
       * 整帧不透明的卡片 PNG 不带 alpha,ffmpeg 中途重建滤镜图,随机丢帧、还可能卡死(实测旧 preview.mp4 1792/1800)。
       * buildComposeArgs 每个输入都带 -reinit_filter 0,还有看门狗;走它两条路就一起好了。
       */
      const layers = (plan?.layers || []).filter((l) => clipFrameRange(l.clip, fps, startFrame, endFrame));
      await composePreview({ ffmpegCmd, baked, layers, outDir,
        cardsVideo: bakedCardsVideo || (streamCards ? path.join(outDir, 'overlay.mov') : null) });
      // 音轨:逐帧截图只有画面,声音在这里拼回去(配乐 + 视频自带的声音 + 音频效果)
      try {
        // 页面拿的是哪份项目就混哪份(和 planMedia 同一个 loadProject):以前只认 <out>/project.json,
        // 命令行 --out 指到别处时就静悄悄地没声音
        const proj = await loadProject(opts.url || DEFAULT_URL, outDir);
        if (proj) {
          const ffprobeCmd = ffprobeOf(ffmpegCmd);
          // 和画面层同一套找素材的规则:/@media/<文件> 也要经素材服务的 HTTP 找得到,不然配乐 / 配音全被跳过
          const sourceOf = (m) => mediaSourceOf(m, { outDir, pageUrl: opts.url || DEFAULT_URL });
          const plan = playableAudioPlan(buildAudioPlan(proj, outDir, undefined, sourceOf), ffprobeCmd);
          if (plan.length > 0) {
            const preview = path.join(outDir, 'preview.mp4');
            const withAudio = path.join(outDir, 'preview-audio.mp4');
            /*
             * 默认在 Chrome 里混(OfflineAudioContext,和编辑台预览同一套效果链,见 src/audio/renderMix.ts):
             * 音频效果只有这条路才有。失败(混音页起不来、页面地址没有 /@export/<id>)就退回 ffmpeg 直接混 ——
             * 那样效果没了,但配乐 / 配音 / 原声都在;--audio ffmpeg 强制走老路(对账用)。
             */
            let mixed = false;
            if (opts.audio !== 'ffmpeg') {
              try {
                const r = await mixAudioInChrome({ ffmpegCmd, outDir, plan, project: proj, pageUrl: opts.url || DEFAULT_URL, durationSec });
                await runFfmpeg(['-y', '-i', preview, '-i', r.mixWav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(durationSec), withAudio]);
                mixed = true;
                // 裁好的 float32 wav 和整条 mix.wav 一小时就是一两 GB,合进成片之后就没用了
                await fs.rm(path.join(outDir, 'audio'), { recursive: true, force: true }).catch(() => {});
              } catch (e) {
                if (plan.some(c => c.cardAudio || c.soundEffect)) throw e;
                const fx = plan.filter((c) => c.fx).length;
                console.error('Chrome 混音失败,退回 ffmpeg 直接混' + (fx ? '(' + fx + ' 段挂着的音频效果会丢)' : '') + ':', e.message);
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
      // 以前这里吞掉错误照常退出 0,界面报「导出完成」、取件时才发现没有 preview.mp4
      process.exitCode = 1;
    }
  }
}

/**
 * 素材合成那一步:灰底 + 素材层(+ 毛玻璃)+ 卡片层 → preview.mp4,一趟 ffmpeg。
 * 进度用 -progress 读出来,打成 `Composited frame n/N`,vite-plugin-export 转给界面。
 */
async function composePreview({ ffmpegCmd, baked, layers, outDir, cardsVideo = null }) {
  const { framesDir, ext, fps, width, height, startFrame, endFrame } = baked;
  const total = endFrame - startFrame + 1;
  const glassList = baked.glass?.list || [];
  const blurs = baked.glass?.blurs || [];
  const blur = blurs.length ? Math.max(...blurs) : 0;
  if (blurs.length > 1) console.warn(`毛玻璃的模糊量不止一种(${blurs.join(' / ')} px),统一按最大的 ${blur}px 合成`);
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
    // 随时间变化的滤镜每段一份 sendcmd 脚本,写进导出目录;给绝对路径,不依赖 ffmpeg 的工作目录
    sidecarDir: path.resolve(outDir),
  });
  await Promise.all(sidecars.map((s) => fs.writeFile(s.file, s.text, 'utf8')));
  for (const n of notes) console.warn('合成:', n);
  let finalArgs = args;
  // 片段多、带强调时 filter graph 会很长;Windows 命令行上限 32K 字符,长了改用文件传
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
