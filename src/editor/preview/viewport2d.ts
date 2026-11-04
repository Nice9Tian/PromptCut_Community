/**
 * How the 2D preview "views the canvas": how much zoom, where it is panned to. **Pure computation,
 * doesn't touch the DOM.**
 *
 * # Why a separate file
 *
 * A miscalculated zoom or pan doesn't throw an error, it just "clicks inaccurately": you click on
 * a card, but the one next to it gets selected. And this conversion must share the same scale with
 * the existing coordinate conversions in Preview.tsx; if it is mixed into the component, it's easy
 * to produce a version that "looks right but clicks off". So it is pulled out and can be unit tested.
 *
 * # How the canvas is laid out
 *
 * `.pc-pv-stage` is `display:grid; place-items:center`, so the picture is **centered by default**;
 * the pan amount (tx, ty) is **an offset relative to this centered position**, written directly
 * as a CSS transform. This has two benefits:
 *   - With no pan, tx = ty = 0, pixel-identical to the old behavior (there was no panning before);
 *   - After the window is resized, the picture is still centered, with no need to recompute the pan.
 *
 * Zoom is not written into the transform; instead the frame's width/height are multiplied by scale
 * directly. This is how it was done originally, so that the border and corner marks of
 * `.pc-pv-frame` don't get scaled thicker or thinner along with it.
 */

export interface View2D {
  scale: number;
  /** Offset relative to "centered" (screen pixels) */
  tx: number;
  ty: number;
  /**
   * true = automatically fit to the window (resizing the window recomputes scale, pan stays 0).
   * It becomes false as soon as the user zooms or pans on their own: otherwise the next window change
   * would wipe out the view they just set up.
   */
  auto: boolean;
}

export interface Size { width: number; height: number }

/** Zoom lower and upper limits. The lower limit must be small enough that a wide aspect ratio is fully visible even in a small window */
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 8;
/** However far the picture is dragged, at least this many pixels must stay in view: otherwise once it's dragged out of sight it can't be found again */
const MIN_VISIBLE_PX = 48;
/** Margin left around the picture when fitting to the window */
const FIT_PAD_PX = 16;

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** The zoom ratio that fits exactly into the window */
export function fitScale(project: Size, box: Size, pad = FIT_PAD_PX): number {
  const w = Math.max(1, box.width - pad);
  const h = Math.max(1, box.height - pad);
  return clampScale(Math.min(w / Math.max(1, project.width), h / Math.max(1, project.height)));
}

export const fitView = (project: Size, box: Size, pad = FIT_PAD_PX): View2D => ({ scale: fitScale(project, box, pad), tx: 0, ty: 0, auto: true });

/**
 * Position of the frame's top-left corner in the window (relative to the stage's top-left corner).
 * It is laid out centered plus an offset, so it is `(window - frame) / 2 + offset`.
 */
export function frameOrigin(view: View2D, project: Size, box: Size) {
  return {
    x: (box.width - project.width * view.scale) / 2 + view.tx,
    y: (box.height - project.height * view.scale) / 2 + view.ty,
  };
}

/** Which pixel of the picture a point in the window (relative to the stage's top-left corner) falls on */
export function toStagePoint(view: View2D, project: Size, box: Size, pt: { x: number; y: number }) {
  const o = frameOrigin(view, project, box);
  return { x: (pt.x - o.x) / view.scale, y: (pt.y - o.y) / view.scale };
}

/**
 * Where dragging counts as reaching the limit.
 *
 * The rule is "keep at least MIN_VISIBLE_PX in view", not "not allowed to drag out of the window":
 * when zoomed larger than the window, you should naturally be able to drag the edges and corners
 * into view, and it must not trap the user in the middle from the start.
 */
export function clampPan(view: View2D, project: Size, box: Size): View2D {
  const fw = project.width * view.scale;
  const fh = project.height * view.scale;
  const maxTx = Math.max(0, (box.width + fw) / 2 - MIN_VISIBLE_PX);
  const maxTy = Math.max(0, (box.height + fh) / 2 - MIN_VISIBLE_PX);
  return {
    ...view,
    tx: Math.min(maxTx, Math.max(-maxTx, view.tx)),
    ty: Math.min(maxTy, Math.max(-maxTy, view.ty)),
  };
}

/**
 * Zoom anchored at the cursor: whichever pixel of the picture is under the cursor **stays that
 * same pixel** after zooming.
 *
 * This is the whole feel of zooming: anchored at the center, to see the bottom-right corner you'd
 * have to "zoom a bit, drag a bit, zoom a bit more", whereas anchored at the cursor it's "zoom
 * where you point".
 */
export function zoomAt(
  view: View2D,
  project: Size,
  box: Size,
  cursor: { x: number; y: number },
  nextScale: number,
): View2D {
  const scale = clampScale(nextScale);
  if (scale === view.scale) return view;
  // The picture pixel under the cursor before zooming
  const p = toStagePoint(view, project, box, cursor);
  // To keep it under the cursor after zooming: work back out where the frame's top-left corner should be, then convert back to an offset
  const originX = cursor.x - p.x * scale;
  const originY = cursor.y - p.y * scale;
  return clampPan(
    {
      scale,
      tx: originX - (box.width - project.width * scale) / 2,
      ty: originY - (box.height - project.height * scale) / 2,
      auto: false,
    },
    project,
    box,
  );
}

/**
 * Convert one wheel notch into a zoom factor.
 *
 * Use an **exponential** rather than adding or subtracting a fixed value: zooming in and out are
 * then symmetric (scroll up and back down returns to the same spot), and the feel is the same at
 * any zoom level. Linear steps multiply the zoom several times per notch at low zoom and barely
 * move at high zoom.
 *
 * deltaMode matters: a mouse wheel reports pixels (0), but some browsers / devices report lines (1).
 * Count one line as 16 pixels, otherwise the same notch differs by a factor of ten or more
 * between devices.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  // Zoom 1.2x per 120 pixels (one standard wheel notch); clamp so some trackpads can't fling thousands at once
  const steps = Math.max(-4, Math.min(4, -px / 120));
  return Math.pow(1.2, steps);
}

/** Drag the canvas */
export function panBy(view: View2D, project: Size, box: Size, dx: number, dy: number): View2D {
  return clampPan({ ...view, tx: view.tx + dx, ty: view.ty + dy, auto: false }, project, box);
}
