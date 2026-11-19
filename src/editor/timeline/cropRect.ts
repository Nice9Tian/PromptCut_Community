/**
 * Geometry of the crop rectangle in the crop dialog (`CropDialog.tsx`): pure functions, unit-tested
 * (`cropRect.test.mjs`).
 *
 * Rectangles are in fractions of the picture **as the dialog shows it**: a mirrored clip is shown
 * mirrored, so the person crops what they see; `mirrorRect` converts to and from the stored crop,
 * which is in source coordinates (kernel/mediaPicture.mjs).
 *
 * A fixed shape is given as `ratio`, the rectangle's width / height **in these fraction units**: a
 * pixel aspect ratio R on a picture of aspect A is R / A (`fractionRatio`).
 */
import { CROP_MIN, type ClipCrop } from "../../kernel/mediaPicture.mjs";

export type CropRect = ClipCrop;
export type CropHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const FULL_RECT: CropRect = { x: 0, y: 0, w: 1, h: 1 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Stored crop ↔ what the dialog shows. Mirroring flips x; applying it twice gives the rectangle back */
export function mirrorRect(r: CropRect, mirrored: boolean): CropRect {
  return mirrored ? { ...r, x: 1 - r.x - r.w } : r;
}

/** Pixel aspect ratio `px` (width / height) of a crop on a picture of aspect `pictureAspect`, in fraction units */
export function fractionRatio(px: number, pictureAspect: number): number {
  return px / pictureAspect;
}

/** Move by (dx, dy) fractions, kept inside the picture */
export function moveRect(r: CropRect, dx: number, dy: number): CropRect {
  return { ...r, x: clamp(r.x + dx, 0, 1 - r.w), y: clamp(r.y + dy, 0, 1 - r.h) };
}

/**
 * The largest rectangle of shape `ratio` that fits in the picture, centered where `r` is centered
 * (moved back inside when that center is near an edge): what picking an aspect ratio does.
 */
export function fitRatio(r: CropRect, ratio: number): CropRect {
  const w = ratio >= 1 ? 1 : ratio;
  const h = ratio >= 1 ? 1 / ratio : 1;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

/**
 * Drag a handle by (dx, dy) fractions, starting from `r` (pass the rectangle from when the drag began,
 * not the last result, so rounding does not pile up). The opposite edge or corner stays put; the
 * rectangle stays inside the picture and at least `CROP_MIN` wide and high.
 *
 * With a fixed `ratio`: a corner follows whichever of the two directions moved further, the other side
 * follows the ratio; an edge sets one side and the other follows, centered on the rectangle's middle.
 * Both are cut back to the room left in the picture.
 */
export function resizeRect(r: CropRect, handle: CropHandle, dx: number, dy: number, ratio: number | null): CropRect {
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  if (ratio === null) {
    let x1 = r.x, x2 = r.x + r.w, y1 = r.y, y2 = r.y + r.h;
    if (west) x1 = clamp(x1 + dx, 0, x2 - CROP_MIN);
    if (east) x2 = clamp(x2 + dx, x1 + CROP_MIN, 1);
    if (north) y1 = clamp(y1 + dy, 0, y2 - CROP_MIN);
    if (south) y2 = clamp(y2 + dy, y1 + CROP_MIN, 1);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  // Smallest width that keeps both sides at CROP_MIN under this ratio
  const minW = Math.max(CROP_MIN, CROP_MIN * ratio);
  if ((west || east) && (north || south)) {
    // Corner: the opposite corner is the anchor
    const ax = west ? r.x + r.w : r.x;
    const ay = north ? r.y + r.h : r.y;
    const room = Math.min(west ? ax : 1 - ax, (north ? ay : 1 - ay) * ratio);
    const wantW = Math.max(r.w + (west ? -dx : dx), (r.h + (north ? -dy : dy)) * ratio);
    const w = clamp(wantW, Math.min(minW, room), room);
    const h = w / ratio;
    return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
  }
  if (west || east) {
    // Left / right edge: width from the drag, height follows, centered vertically
    const ax = west ? r.x + r.w : r.x;
    const room = Math.min(west ? ax : 1 - ax, ratio);
    const w = clamp(r.w + (west ? -dx : dx), Math.min(minW, room), room);
    const h = w / ratio;
    return { x: west ? ax - w : ax, y: clamp(r.y + r.h / 2 - h / 2, 0, 1 - h), w, h };
  }
  // Top / bottom edge: height from the drag, width follows, centered horizontally
  const ay = north ? r.y + r.h : r.y;
  const room = Math.min(north ? ay : 1 - ay, 1 / ratio);
  const h = clamp(r.h + (north ? -dy : dy), Math.min(minW / ratio, room), room);
  const w = h * ratio;
  return { x: clamp(r.x + r.w / 2 - w / 2, 0, 1 - w), y: north ? ay - h : ay, w, h };
}
