/**
 * Size of the placeholder on screen (pure function, loaded directly by unit tests;
 * product/rendering.md "Fallback order").
 *
 * The stage iframe draws at project resolution (1920×1080), and the parent page scales it down into
 * the preview box using CSS `scale(preview scale)`; the wrapper layer itself may also have
 * `frame.scale`. The placeholder component draws in stage pixels; without compensation, at 27%
 * preview the hourglass is reduced to only seven or eight screen pixels. Here we calculate how much
 * the component should scale up in wrapper layer coordinates:
 *
 *   - **Hourglass** (regular loading placeholder, the one in the middle of badge and solid forms):
 *     maintains original size on screen (approx. 28 pixels): cancels out only preview scaling,
 *     **does not** cancel out this layer's own scale (semantics: placeholder inherits coordinates,
 *     rotation, scaling, and z-index of that layer); noise still fills the entity box as usual
 *     without scaling.
 *
 * **Does not exceed this layer's box** (badge form checks position box, solid form checks entity
 * box; leaving some margin around the edges), so hourglasses of two adjacent small clips will not
 * overlap. (Originally there was another layout for the "Local PC assisted rendering" icon,
 * removed along with the icon on 2026-10-21.) Coordinates are always wrapper layer local pixels
 * (stage pixels before multiplying by this layer's scale).
 */

/** Box width and height (wrapper layer local pixels) */
export interface FitBox { width: number; height: number }

/**
 * How to place the component: `scale` is the component's magnification factor in wrapper layer
 * coordinates (1 = drawn as-is in stage pixels). Same input returns the same values; caching is
 * managed by `placeholderHost.placeholderFitFor`.
 */
export interface PlaceholderFit {
  scale: number;
}

/** Unscaled side length of the hourglass (badge form circle, the middle one in solid form) (stage pixels) */
export const HOURGLASS_SIZE = 28;
/** Leave at least this many screen pixels from box edges (when box is too small, use `FIT_MARGIN_RATIO` of box shorter side instead, taking the smaller value) */
export const FIT_MARGIN_PX = 4;
export const FIT_MARGIN_RATIO = 0.08;
/** Scaled down no smaller than this factor even at minimum (not drawn as 0 when box is near 0) */
export const FIT_MIN_SCALE = 0.05;
/** Reciprocal of preview scale clamped within this range (bad values treated as 1) */
export const VIEW_INVERSE_MIN = 1 / 8;
export const VIEW_INVERSE_MAX = 16;

const positive = (v: unknown, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/** How much to scale up to offset preview scale: `1 / preview scale`, clamped to [1/8, 16]; returns 1 if not a positive finite number */
export function viewInverse(viewScale: unknown): number {
  const s = Number(viewScale);
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(VIEW_INVERSE_MAX, Math.max(VIEW_INVERSE_MIN, 1 / s));
}

/** Usable width and height within the box (deducting margins; `perScreenPx` = how many local pixels in one screen pixel) */
function available(box: FitBox, perScreenPx: number): { w: number; h: number } {
  const W = Math.max(0, Number(box?.width) || 0), H = Math.max(0, Number(box?.height) || 0);
  const m = Math.min(FIT_MARGIN_PX * perScreenPx, FIT_MARGIN_RATIO * Math.min(W, H));
  return { w: Math.max(0, W - 2 * m), h: Math.max(0, H - 2 * m) };
}

/**
 * Hourglass size: it keeps its original size on screen (only the preview scale is cancelled out),
 * and shrinks to fit the box if it does not fit.
 * `layerScale` is only used to convert margins in screen pixels to local pixels; it takes no part in
 * the magnification.
 */
export function hourglassFit(o: { box: FitBox; viewScale: unknown; layerScale?: unknown }): PlaceholderFit {
  const k = viewInverse(o.viewScale);
  const perScreenPx = viewInverse(o.viewScale) / positive(o.layerScale, 1);
  const a = available(o.box, perScreenPx);
  const fit = Math.min(a.w / HOURGLASS_SIZE, a.h / HOURGLASS_SIZE);
  return { scale: Math.max(FIT_MIN_SCALE, Math.min(k, fit)) };
}
