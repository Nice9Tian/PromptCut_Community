/**
 * Composition for see_frames: card layer (transparent PNG rendered by the page) overlaid on top of
 * media layer (frame extracted by ffmpeg).
 *
 * Why not let the page render video together with cards: for determinism, export scripts
 * **advance virtual time frame by frame**; inspecting second t requires stepping all the way
 * from frame 0 to the frame at second t. When there is no media, every frame is classified as
 * static, taking a few milliseconds per frame; once a video layer is in the frame, each frame must
 * wait for <video> to actually finish seeking (1080p H.264 takes hundreds of milliseconds each
 * time, and a single frame waits two or three times). Second 12 means 360 frames, taking six or
 * seven minutes: in testing, see_frames timed out at 120 s because of this.
 * Therefore, the page only renders cards (every frame is static, finished within ten seconds),
 * while the media layer directly extracts that frame with ffmpeg, composited here following the
 * same rules as ExportView (object-fit: cover, stacking order, fade-in/fade-out opacity).
 *
 * Pure functions are placed in this .mjs so that node --test can test them without going through vite.
 */
import { PNG } from "pngjs";
import { clipFilterOpsAt, ffmpegStaticChain } from "../src/kernel/filters.mjs";
import { mediaTimeAt } from "../src/kernel/clipTime.mjs";

/** Strips all media clips, leaving only cards: no <video> in page, every frame classified as static */
export function cardsOnly(project) {
  return {
    ...project,
    media: [],
    tracks: (project.tracks || []).map((tr) => ({ ...tr, clips: (tr.clips || []).filter((c) => !c.mediaId) })),
  };
}

/** Same logic as opacityAt in src/kernel/project.ts: overall opacity × fade-in × fade-out */
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
 * Which media layers should be in the frame at second t (bottom to top), and which second of media
 * to extract for each layer. Same check as videoLayersAt in kernel/project.ts, except it also
 * calculates mediaTime.
 */
export function mediaLayersAt(project, t) {
  const layers = [];
  // Consistent with frontend: higher tracks on the timeline are on upper layers, so iterate
  // in reverse: the last produced layer sits on top
  for (const tr of [...(project.tracks || [])].reverse()) {
    if (tr.hidden) continue;
    for (const c of tr.clips || []) {
      if (!c.mediaId || t < c.start || t >= c.end) continue;
      const media = (project.media || []).find((m) => m.id === c.mediaId);
      if (!media || media.kind === "audio") continue;
      const opacity = opacityAt(c, t);
      if (opacity <= 0) continue;
      // Filters: values at this moment are translated into constant ffmpeg filters, sharing values with
      // preview and export (kernel/filters.mjs).
      // Here the media layer covers the full frame and ignores clip.frame (legacy issue), so blur is
      // calculated in canvas pixels without multiplying by the frame scale
      const ops = clipFilterOpsAt(project, c, t);
      const filter = ops ? ffmpegStaticChain(ops) : "";
      // Media time uses unified conversion from kernel/clipTime.mjs (including clip speed; default 1 is
      // bitwise identical to legacy off + (t − start))
      layers.push({ clip: c, media, opacity, mediaTime: mediaTimeAt(c, t), ...(filter ? { filter } : null) });
    }
  }
  return layers;
}

/**
 * ffmpeg filter parameters to extract a frame and cover w×h via object-fit: cover.
 * Videos seek with -ss (placed before -i, fast-seeking via keyframe then accurately decoding to
 * that frame); images have no timeline, omitted.
 * filter: filter string from mediaLayersAt, appended after rgba and before opacity (in CSS,
 * filter precedes opacity).
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

/**
 * Overlays src onto dst (non-premultiplied alpha over), both of same size; crops to dst bounds
 * if sizes differ
 */
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

/** Composites media layers (bottom to top) and card layer into a transparent-background PNG */
export function composeFrame(width, height, layerPngs, cardsPng) {
  const out = new PNG({ width, height });
  out.data.fill(0);
  for (const layer of layerPngs) if (layer) alphaOver(out, layer);
  if (cardsPng) alphaOver(out, cardsPng);
  return out;
}
