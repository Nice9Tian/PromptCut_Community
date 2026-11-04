/**
 * From a prerendered texture, measure "the block where this card actually drew something": the
 * bounding box of alpha.
 *
 * # Why the 3D side has to measure this itself
 *
 * 2D layout does **not** use the content box: a card is placed by its `frame`, and without
 * `frame.w/h` it fills the stage. The project's `measureContentBox` (render/contentBox.ts) measures
 * the DOM and is used to draw color blocks in solid mode, whereas the 3D view has no card DOM, only
 * the prerendered PNG.
 *
 * Fortunately, once the prerender's layout size is fixed (see bakeTarget's renderBox), the PNG's
 * canvas and the card's box are **1:1**. So the bounding box measured on this image, once normalized,
 * is "the relative position of the four corners within the card's box", and can be used directly to
 * crop a small piece out of that screen plane.
 *
 * # One **deliberate difference** from measureContentBox
 *
 * That one skips elements that take up more than ninety percent of the card as background, because
 * solid mode has to answer "is this block laid on too heavily?", and a full-screen backdrop does not
 * count as content. This one does not skip them: 3D has to answer "how big should this board be?",
 * and a backdrop that fills the screen **should** be a board that fills the screen. Same word, two
 * different accounts.
 */

/** A box normalized to 0..1, with its origin at the top-left (consistent with image coordinates) */
export interface NormBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Scan RGBA pixels, find the bounding box of pixels whose alpha exceeds the threshold, and return it
 * normalized. Return null if fully transparent.
 *
 * **The box expands outward by one pixel.** Callers mostly shrink a large image to a few hundred
 * pixels before scanning (scanning millions of pixels at full size is too slow), and after shrinking
 * the edge row may fall between sampling cells; without the expansion the content would be clipped a
 * little, and a board clipping content is a visible error. Expanding at most makes the board one ring
 * larger, which is not noticeable.
 */
export function alphaBox(
  data: ArrayLike<number>,
  width: number,
  height: number,
  opts: { threshold?: number } = {},
): NormBox | null {
  const th = opts.threshold ?? 0;
  if (width <= 0 || height <= 0) return null;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= th) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  // Expand outward by one pixel (see the note above), then clamp back into the image
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1);
  x1 = Math.min(width - 1, x1 + 1); y1 = Math.min(height - 1, y1 + 1);
  return {
    x: x0 / width,
    y: y0 / height,
    w: (x1 - x0 + 1) / width,
    h: (y1 - y0 + 1) / height,
  };
}

/**
 * Whether this box is worth using to crop the board.
 *
 * If it almost fills the whole image (for example a full-screen gradient backdrop), do not crop: the
 * result is as big as the whole piece, costs an extra geometry rebuild for nothing, and may differ by
 * half a pixel in floating point. Leave some margin before judging.
 */
export function worthCropping(box: NormBox | null, minSaving = 0.04): boolean {
  if (!box) return false;
  return box.w < 1 - minSaving || box.h < 1 - minSaving;
}

/** Reuse one offscreen canvas: creating a new one for every texture would mean hundreds of allocations for a video with hundreds of them */
let probe: HTMLCanvasElement | null = null;

/**
 * Draw an already loaded image, shrunk to within `maxEdge`, onto an offscreen canvas and measure its
 * content box.
 *
 * Shrinking before scanning is for speed: 1024×576 at full size is over half a million pixels, while
 * after shrinking to 256 only about thirty thousand remain, one to two milliseconds per run. The loss
 * of precision is covered by `alphaBox`'s "expand outward by one cell": a board one ring larger is
 * not noticeable, while clipped content is.
 *
 * If pixels cannot be read, return null (callers treat it as "do not crop"): this happens when the
 * canvas has been tainted by a cross-origin image, or when the browser does not provide a 2d context;
 * in that case better to use the whole board than to crop blindly.
 */
export function measureImageBox(
  img: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number },
  maxEdge = 256,
): NormBox | null {
  const iw = img.naturalWidth || img.width || 0;
  const ih = img.naturalHeight || img.height || 0;
  if (!iw || !ih) return null;
  const scale = Math.min(1, maxEdge / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  try {
    probe ??= document.createElement("canvas");
    if (probe.width !== w || probe.height !== h) { probe.width = w; probe.height = h; }
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return alphaBox(ctx.getImageData(0, 0, w, h).data, w, h);
  } catch {
    return null;
  }
}
