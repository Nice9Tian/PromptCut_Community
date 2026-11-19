/**
 * The picture of a video / image clip inside its box: **crop** and **mirror** (the "Crop" and
 * "Mirror" buttons of the timeline toolbar; stored as `TrackClip.crop` / `TrackClip.flipX`, see
 * kernel/project.ts).
 *
 * Why a standalone .mjs: media is drawn by three kinds of code, and they must agree pixel for pixel
 * ("same moment, same frame", product/rendering.md):
 *   - the page (preview stage and the export page) places the <video> / <img> inside the box with
 *     CSS (`src/render/mediaPicture.ts`);
 *   - 3D cuts paint the picture onto a board texture with canvas drawImage (`render/Cut3DScene.tsx`,
 *     `editor/preview/Scene3DView.tsx`);
 *   - the ffmpeg compatibility export builds a filter graph (`server/export-compose.mjs`), and Node
 *     cannot import .ts.
 * The numbers live here once and every path imports them.
 *
 * Coordinates: a crop is a rectangle of the **source picture** in fractions of its width and height
 * (origin top-left), measured before mirroring, so mirroring a cropped clip shows the same part of
 * the picture, flipped. The cropped part covers the box exactly the way an uncropped picture does
 * (object-fit: cover): aspect ratio kept, centered, the overflow cut off by the box.
 */

/** Smallest crop side, as a fraction of the source side: anything smaller is a slip of the mouse */
export const CROP_MIN = 0.01;

/** Tolerance for values computed by the crop dialog (pixel ↔ fraction round trips) */
const EPS = 1e-6;
const round6 = (n) => Math.round(n * 1e6) / 1e6 + 0;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Validate a crop and bring it to its stored shape (six decimals, inside the picture).
 * Returns `{ ok: true, crop }`, where `crop` is null for "the whole picture" (the caller deletes the
 * field rather than storing a no-op), or `{ ok: false, error }` with a plain-language reason: the
 * Agent reads it.
 */
export function normalizeCrop(value) {
  if (value === null || value === undefined) return { ok: true, crop: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `crop must be an object { x, y, w, h } in fractions of the source picture (0~1), or null for the whole picture; got ${JSON.stringify(value)}` };
  }
  for (const k of ["x", "y", "w", "h"]) {
    const v = value[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, error: `crop.${k} must be a finite number between 0 and 1, got ${JSON.stringify(v)}` };
  }
  const { x, y, w, h } = value;
  if (x < -EPS || y < -EPS || w < CROP_MIN - EPS || h < CROP_MIN - EPS || x + w > 1 + EPS || y + h > 1 + EPS) {
    return { ok: false, error: `crop must stay inside the picture: x ≥ 0, y ≥ 0, w and h at least ${CROP_MIN}, x + w ≤ 1, y + h ≤ 1; got x=${x} y=${y} w=${w} h=${h}` };
  }
  const nx = round6(clamp(x, 0, 1 - CROP_MIN));
  const ny = round6(clamp(y, 0, 1 - CROP_MIN));
  const nw = round6(clamp(w, CROP_MIN, 1 - nx));
  const nh = round6(clamp(h, CROP_MIN, 1 - ny));
  if (nx === 0 && ny === 0 && nw === 1 && nh === 1) return { ok: true, crop: null };
  return { ok: true, crop: { x: nx, y: ny, w: nw, h: nh } };
}

/** Width / height of a media asset's picture, or null when the asset did not record its size */
export function mediaAspect(media) {
  const w = Number(media?.width);
  const h = Number(media?.height);
  return w > 0 && h > 0 && Number.isFinite(w / h) ? w / h : null;
}

/** Width / height, in pixels, of the cropped part of a picture whose own width / height is `sourceAspect` */
export function cropAspect(crop, sourceAspect) {
  return crop ? (sourceAspect * crop.w) / crop.h : sourceAspect;
}

/**
 * Where to draw the **whole** source picture so that its cropped part covers the box, in fractions
 * of the box: `{ left, top, width, height }` (they reach outside 0~1; the box clips the overflow).
 *
 *   - `sourceAspect`: the picture's width / height. When it is unknown (null) the cropped part is
 *     stretched onto the box instead. That gives the same picture whenever the box has the cropped
 *     part's own aspect ratio, which is how `frameForCrop` shapes it; a box reshaped by hand
 *     afterwards then stretches instead of cutting.
 *   - `boxAspect`: the box's width / height (before scale and rotation).
 * No crop = the whole picture covers the box, the same as object-fit: cover.
 * Mirroring is not applied here: the page mirrors this rectangle inside the box, canvas flips its
 * context, ffmpeg adds hflip; all three mirror about the box's center.
 */
export function pictureRect(crop, sourceAspect, boxAspect) {
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  let width;
  let height;
  if (!(sourceAspect > 0) || !(boxAspect > 0)) {
    width = 1 / c.w;
    height = 1 / c.h;
  } else if ((sourceAspect * c.w) / c.h >= boxAspect) {
    // The cropped part is wider than the box: its height fills the box, the sides overflow
    height = 1 / c.h;
    width = sourceAspect / boxAspect / c.h;
  } else {
    width = 1 / c.w;
    height = boxAspect / sourceAspect / c.w;
  }
  // The cropped part's center sits on the box's center
  return { left: 0.5 - (c.x + c.w / 2) * width, top: 0.5 - (c.y + c.h / 2) * height, width, height };
}

/**
 * The box size a crop gives the clip (`{ w, h }`, unscaled stage pixels), so that the cropped part
 * shows whole at its own aspect ratio instead of being cut by the old box.
 *
 * Rule: the box is the cropped part fitted into the stage (contain), times how big the clip is now
 * relative to the same fit of its current picture. So a clip that fills the stage keeps filling it
 * (cropping a 16:9 video to 1:1 gives a 1080×1080 box on a 1920×1080 stage, and choosing the whole
 * picture again gives 1920×1080 back), and a picture-in-picture keeps its size relative to the
 * stage. `min` of the two ratios: a box that covers the stage with overflow (a 4:3 video on a 16:9
 * stage) counts as "fills the stage", not as "bigger than the stage".
 *
 * `box` is the clip's current box size, `prevCrop` / `nextCrop` the crops before and after,
 * `sourceAspect` the picture's width / height (required: the dialog reads it from the media element).
 */
export function boxForCrop({ box, prevCrop, nextCrop, sourceAspect, stage }) {
  const fit = (aspect) =>
    aspect >= stage.width / stage.height
      ? { w: stage.width, h: stage.width / aspect }
      : { w: stage.height * aspect, h: stage.height };
  const before = fit(cropAspect(prevCrop, sourceAspect));
  const ratio = Math.min(box.w / before.w, box.h / before.h);
  const after = fit(cropAspect(nextCrop, sourceAspect));
  return { w: round6(after.w * ratio), h: round6(after.h * ratio) };
}

/**
 * ffmpeg filter that cuts the crop out of the decoded source picture. Place it **before** the cover
 * scaling (`scale=…:force_original_aspect_ratio=increase,crop=…`), which then makes the cut part
 * cover the box as on the page. "" when there is no crop.
 * `exact=1`: without it ffmpeg moves odd offsets to even ones on 4:2:0 video. `round()` instead of
 * ffmpeg's truncation: 0.333333 of 1920 is 639.9994 px, which the page draws as 640.
 */
export function ffmpegCropFilter(crop) {
  if (!crop) return "";
  const f = (v) => String(+Number(v).toFixed(6));
  return `crop=w=round(iw*${f(crop.w)}):h=round(ih*${f(crop.h)}):x=round(iw*${f(crop.x)}):y=round(ih*${f(crop.y)}):exact=1`;
}

/**
 * Whether crop and mirror apply to this clip; null when they do, otherwise why not:
 *   - "not-media": not a video or image clip (a card, a cut segment, an audio clip);
 *   - "effect-card": a media effect card draws this clip's picture. The card reads the media
 *     itself (`render/cards/GraphCard.tsx`), so a crop or mirror of the media layer would never
 *     reach the screen; it is refused instead of being stored and silently ignored. Audio effect
 *     cards leave the picture alone and do not count.
 */
export function pictureEditBlock(project, clip) {
  const media = clip?.mediaId && !clip.cutId ? (project?.media ?? []).find((m) => m?.id === clip.mediaId) : undefined;
  if (!media || media.kind === "audio") return "not-media";
  if (clip.nodeId) {
    const raw = project?.cardNodes;
    const nodes = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
    const node = nodes.find((n) => n?.id === clip.nodeId);
    if (node && node.adapter === "card" && node.kind !== "audio") return "effect-card";
  }
  return null;
}
