/** Part of the source picture shown by a clip, in fractions of the picture's width and height (0~1, origin top-left) */
export interface ClipCrop { x: number; y: number; w: number; h: number }
/** Rectangle in fractions of a box */
export interface PictureRect { left: number; top: number; width: number; height: number }
export type PictureEditBlock = "not-media" | "effect-card";

export const CROP_MIN: number;
export function normalizeCrop(value: unknown): { ok: true; crop: ClipCrop | null } | { ok: false; error: string };
export function mediaAspect(media: { width?: number; height?: number } | null | undefined): number | null;
export function cropAspect(crop: ClipCrop | null | undefined, sourceAspect: number): number;
export function pictureRect(crop: ClipCrop | null | undefined, sourceAspect: number | null | undefined, boxAspect: number): PictureRect;
export function boxForCrop(args: {
  box: { w: number; h: number };
  prevCrop: ClipCrop | null | undefined;
  nextCrop: ClipCrop | null | undefined;
  sourceAspect: number;
  stage: { width: number; height: number };
}): { w: number; h: number };
export function ffmpegCropFilter(crop: ClipCrop | null | undefined): string;
export function pictureEditBlock(
  project: { media?: { id: string; kind?: string }[]; cardNodes?: unknown } | null | undefined,
  clip: { mediaId?: string; cutId?: string; nodeId?: string } | null | undefined,
): PictureEditBlock | null;
