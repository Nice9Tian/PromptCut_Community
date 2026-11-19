/**
 * Crop and mirror of a video / image clip on the page: how the media element (<video>, <img>, the
 * pixel-map <canvas>) sits inside the clip box. Used by every page path that draws media layers, so
 * the preview stage and the export page (which also serves see_frames and the online export) place
 * the picture the same way: `VideoTrack.tsx` (live) and `FrameScene.tsx` (export, pixel maps).
 * The numbers come from kernel/mediaPicture.mjs, shared with the 3D canvas path and the ffmpeg
 * export.
 *
 * Structure: the box (frameCss, overflow hidden) keeps a single media element, whether or not the
 * clip is cropped or mirrored. The live stage reuses its two <video> elements from clip to clip
 * (`VideoTrack.tsx`), and a wrapper that came and went with the crop would remount them.
 */
import type { CSSProperties } from "react";
import type { MediaAsset, TrackClip } from "../kernel/project";
import type { ClipFrame } from "../kernel/types";
import type { FilterDef } from "../kernel/filters.mjs";
import { resolveFrameSize } from "../kernel/frameSize.mjs";
import { mediaAspect, pictureRect } from "../kernel/mediaPicture.mjs";
import { filterOf } from "./mediaDrive";

/** No crop, no mirror: the style media elements always had (fill the box, cover) */
const COVER: CSSProperties = { display: "block", width: "100%", height: "100%", objectFit: "cover" };
const MIRROR = "scaleX(-1)";
/** Percent of the box, 4 decimals (1/10000 % of a 1920 px box is 0.0002 px) */
const pct = (f: number) => `${+(f * 100).toFixed(4)}%`;

/**
 * Placement of the media element inside the clip box (`frame`: the clip's frame at this moment, after
 * frame expressions; `stage`: the stage size). The caller adds opacity and filter.
 *
 *   - Neither crop nor mirror: exactly the old style, so projects without them render byte for byte as
 *     before.
 *   - Mirror only: the element still fills the box; `scaleX(-1)` flips it about its center, which is
 *     the box's center.
 *   - Crop: the element is sized and placed so the cropped part covers the box (`pictureRect`), with
 *     object-fit: fill (the element already has the picture's aspect ratio). Mirrored, the rectangle
 *     is mirrored about the box's center and the element flipped about its own, which together flip
 *     the box's content. `max-width: none`: the page's base styles cap media at 100% of their parent.
 */
export function mediaFitCss(clip: TrackClip | null, media: Pick<MediaAsset, "width" | "height"> | undefined, frame: ClipFrame | undefined, stage: { width: number; height: number }): CSSProperties {
  // No clip: an idle <video> slot of the live stage (VideoTrack), styled as before
  if (!clip?.crop) return clip?.flipX ? { ...COVER, transform: MIRROR } : COVER;
  const box = resolveFrameSize(frame, stage);
  const r = pictureRect(clip.crop, mediaAspect(media), box.w / box.h);
  return {
    display: "block",
    position: "absolute",
    left: pct(clip.flipX ? 1 - r.left - r.width : r.left),
    top: pct(r.top),
    width: pct(r.width),
    height: pct(r.height),
    maxWidth: "none",
    maxHeight: "none",
    objectFit: "fill",
    ...(clip.flipX ? { transform: MIRROR } : null),
  };
}

/**
 * CSS filter of the media element: the clip's filters and emphasis (`filterOf`), except that on a
 * mirrored element the emphasis shadow's horizontal offset is turned around first. CSS applies an
 * element's filter before its transform, so the mirror would otherwise carry a shadow cast to the
 * right over to the left; the shadow belongs to the box, not to the picture, and the 3D canvas path
 * and the ffmpeg export (which flip the picture before casting it) keep it where it was. Outline
 * strokes go round in all eight directions and need nothing.
 */
export function mediaFilterCss(clip: TrackClip, filters: FilterDef[] | undefined, t: number): string | undefined {
  const e = clip.emphasis;
  const turned = clip.flipX && e?.kind === "shadow" && typeof e.dx === "number" && e.dx !== 0 ? { ...clip, emphasis: { ...e, dx: -e.dx } } : clip;
  return filterOf(turned, filters, t);
}

/**
 * Paint a media picture onto a box-sized canvas the way the page shows it in the box: cover, with the
 * clip's crop and mirror. Used for the board textures of 3D cuts (`Cut3DScene.tsx` for export and
 * see_frames, `editor/preview/Scene3DView.tsx` for the live 3D preview).
 *
 * `natural`: the source element's own size (video / image natural size, or the pixel-map canvas).
 * A crop is measured against the picture's aspect ratio as the asset recorded it, falling back to
 * `natural`, as on the page (`mediaFitCss`); without a crop the element covers the box by its own
 * size, like object-fit: cover on the page, so a mirror alone changes nothing but the direction.
 * The mirror flips the context about the box's center. Canvas filters work in canvas pixels and do
 * not follow the transform, so a shadow set on the context keeps its direction without the turn
 * `mediaFilterCss` gives it on the page; set the filter as usual before calling.
 * Neither crop nor mirror: the cover arithmetic both callers used before, unchanged.
 */
export function drawMediaPicture(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  natural: { width: number; height: number },
  box: { width: number; height: number },
  clip: { crop?: TrackClip["crop"]; flipX?: boolean; media?: Pick<MediaAsset, "width" | "height"> },
): void {
  const { width: sw, height: sh } = natural;
  const { width: bw, height: bh } = box;
  if (!clip.crop && !clip.flipX) {
    const sc = Math.max(bw / sw, bh / sh);
    const dw = sw * sc;
    const dh = sh * sc;
    ctx.drawImage(source, (bw - dw) / 2, (bh - dh) / 2, dw, dh);
    return;
  }
  const r = pictureRect(clip.crop, clip.crop ? mediaAspect(clip.media) ?? sw / sh : sw / sh, bw / bh);
  ctx.save();
  if (clip.flipX) {
    ctx.translate(bw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, r.left * bw, r.top * bh, r.width * bw, r.height * bh);
  ctx.restore();
}
