/**
 * see_frames 的合成:卡片层(页面渲的透明 PNG)叠在素材层(ffmpeg 抽的帧)上面。
 *
 * 为什么不让页面连视频一起渲:导出脚本为了确定性是**逐帧推进虚拟时间**的,看第 t 秒
 * 就得从第 0 帧一路走到第 t 秒那一帧。没有素材时每一帧都判静止,几毫秒一帧;一旦有
 * 视频层在画面里,每一帧都要等 <video> 真的 seek 完(1080p 的 H.264 一次几百毫秒,
 * 一帧要等两三次),第 12 秒就是 360 帧、六七分钟 —— 实测 see_frames 因此 120 秒超时。
 * 所以页面里只渲卡片(帧帧静止,十秒内完),素材那一层用 ffmpeg 直接抽那一帧,
 * 按 ExportView 同样的规则(object-fit: cover、叠放顺序、淡入淡出的不透明度)在这里合成。
 *
 * 纯函数放在这个 .mjs 里,好让 node --test 不经 vite 就能测。
 */
import { PNG } from "pngjs";
import { clipFilterOpsAt, ffmpegStaticChain } from "../src/kernel/filters.mjs";
import { mediaTimeAt } from "../src/kernel/clipTime.mjs";

/** 把素材段全部拿掉,只剩卡片:页面里没有 <video>,每一帧都能判静止 */
export function cardsOnly(project) {
  return {
    ...project,
    media: [],
    tracks: (project.tracks || []).map((tr) => ({ ...tr, clips: (tr.clips || []).filter((c) => !c.mediaId) })),
  };
}

/** 和 src/kernel/project.ts 的 opacityAt 同一套:整体不透明度 × 淡入 × 淡出 */
export function opacityAt(clip, t) {
  if (t < clip.start || t >= clip.end) return 0;
  let a = clip.opacity ?? 1;
  const fin = clip.fadeIn ?? 0;
  const fout = clip.fadeOut ?? 0;
  if (fin > 0 && t < clip.start + fin) a *= (t - clip.start) / fin;
  if (fout > 0 && t > clip.end - fout) a *= (clip.end - t) / fout;
  return Math.max(0, Math.min(1, a));
}

/**
 * 第 t 秒画面里该有哪些素材层(从下到上),每层要抽素材的第几秒。
 * 和 kernel/project.ts 的 videoLayersAt 同一个判定,只是多算了 mediaTime。
 */
export function mediaLayersAt(project, t) {
  const layers = [];
  // 和前端一个口径:时间轴上靠上的序列在上层,所以倒着遍历 —— 产出的最后一层压在最上面
  for (const tr of [...(project.tracks || [])].reverse()) {
    if (tr.hidden) continue;
    for (const c of tr.clips || []) {
      if (!c.mediaId || t < c.start || t >= c.end) continue;
      const media = (project.media || []).find((m) => m.id === c.mediaId);
      if (!media || media.kind === "audio") continue;
      const opacity = opacityAt(c, t);
      if (opacity <= 0) continue;
      // 滤镜:这一刻的数值翻成常量 ffmpeg 滤镜,和预览、导出同一份数值(kernel/filters.mjs)。
      // 这里的素材层铺满全画面、不认 clip.frame(老问题),所以模糊按画布像素算、不乘框的缩放
      const ops = clipFilterOpsAt(project, c, t);
      const filter = ops ? ffmpegStaticChain(ops) : "";
      // 素材时刻按 kernel/clipTime.mjs 的统一换算(含片段速度;缺省 1 与原来 off + (t − start) 逐位相同)
      layers.push({ clip: c, media, opacity, mediaTime: mediaTimeAt(c, t), ...(filter ? { filter } : null) });
    }
  }
  return layers;
}

/**
 * ffmpeg 抽一帧并按 object-fit: cover 铺满 w×h 的滤镜参数。
 * 视频用 -ss 定位(放在 -i 前面,走关键帧快速定位再精确解码到那一帧);图片没有时间轴,不加。
 * filter:mediaLayersAt 给的滤镜串,接在 rgba 之后、不透明度之前(CSS 里 filter 先于 opacity)。
 */
export function extractArgs({ file, kind, seconds, width, height, opacity, filter, out }) {
  const filters = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "format=rgba",
  ];
  if (filter) filters.push(filter);
  if (opacity < 1) filters.push(`colorchannelmixer=aa=${opacity.toFixed(4)}`);
  return [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    ...(kind === "image" ? [] : ["-ss", seconds.toFixed(3)]),
    "-i", file,
    "-frames:v", "1",
    "-vf", filters.join(","),
    "-f", "image2", "-c:v", "png",
    out,
  ];
}

/** src 叠到 dst 上(非预乘 alpha 的 over),两张同尺寸;尺寸不同就按 dst 的范围裁 */
export function alphaOver(dst, src) {
  const w = Math.min(dst.width, src.width);
  const h = Math.min(dst.height, src.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * src.width + x) << 2;
      const di = (y * dst.width + x) << 2;
      const sa = src.data[si + 3] / 255;
      if (sa <= 0) continue;
      const da = dst.data[di + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let k = 0; k < 3; k++) {
        const sc = src.data[si + k];
        const dc = dst.data[di + k];
        dst.data[di + k] = oa > 0 ? Math.round((sc * sa + dc * da * (1 - sa)) / oa) : 0;
      }
      dst.data[di + 3] = Math.round(oa * 255);
    }
  }
  return dst;
}

/** 素材层(从下到上)和卡片层合成一张透明底的 PNG */
export function composeFrame(width, height, layerPngs, cardsPng) {
  const out = new PNG({ width, height });
  out.data.fill(0);
  for (const layer of layerPngs) if (layer) alphaOver(out, layer);
  if (cardsPng) alphaOver(out, cardsPng);
  return out;
}
