/**
 * Zoom of the full mobile app timeline (semantics `workflow/editing.md`, "Mobile app UI"; demo script round 10).
 * Pixels per second range from 6 to 120; "-" and "+" each scale by about 1.25x, centered on the playhead; pinch with two fingers is centered on the midpoint of the two fingers; on entry the default is "fit width".
 * Pure functions, unit tests in `zoom.test.mjs`.
 */

export const PX_MIN = 6;
export const PX_MAX = 120;
export const ZOOM_STEP = 1.25;
/** Width (px) left at the left of the timeline content for track labels; second 0 is drawn here */
export const TL_PAD = 30;
/** Leave a little margin on the right for "fit width" */
export const FIT_MARGIN = 12;
/** Tick labels must be at least this far apart (px) */
const RULER_MIN_GAP = 44;
const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

export const clampPx = (v: number): number => Math.max(PX_MIN, Math.min(PX_MAX, v));

/** Fit the whole duration exactly into the visible width */
export function fitPx(viewWidth: number, total: number): number {
  return clampPx((viewWidth - TL_PAD - FIT_MARGIN) / Math.max(total, 0.1));
}

/** The tick interval adapts to the scale: one tick every 0.5 seconds ... 5 minutes, with labels not overlapping */
export function rulerStep(px: number): number {
  for (const t of RULER_STEPS) if (t * px >= RULER_MIN_GAP) return t;
  return 600;
}

/**
 * Zoom centered on the position `anchorX` (relative to the left of the scroll container) in the visible area on screen: the time it points at stays the same before and after zooming.
 * Returns the new pixels per second and the new horizontal scroll position.
 */
export function zoomAround(px: number, scrollLeft: number, anchorX: number, nextPx: number): { px: number; scrollLeft: number } {
  const np = clampPx(nextPx);
  const t = (scrollLeft + anchorX - TL_PAD) / px;
  return { px: np, scrollLeft: Math.max(0, t * np + TL_PAD - anchorX) };
}

/** The playhead's horizontal coordinate in the visible area (used to zoom centered on it) */
export function playheadX(px: number, scrollLeft: number, t: number): number {
  return t * px + TL_PAD - scrollLeft;
}

export const timeToX = (px: number, t: number): number => t * px + TL_PAD;
export const xToTime = (px: number, x: number): number => (x - TL_PAD) / px;
