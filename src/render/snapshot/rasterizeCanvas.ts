/**
 * Step 3 of snapshot generation: **canvas rasterization** (task brief 3.8).
 *
 * The cloned `<canvas>` is empty: particles and 3D graphics disappear completely. Therefore,
 * read pixels, compress to an image, replace the canvas with an `<img>` of the same dimensions,
 * and annotate with an entity box. The bottleneck is **canvas area and encoder**: high `rasterMs`
 * means the canvas is too large. If pixels cannot be read (tainted, WebGL without
 * `preserveDrawingBuffer`), leave the canvas empty and count it in `lossy` in the return value.
 *
 * This file **does not import `inlineStyles`** (a constraint named in task brief 3.8): the
 * swapped-in `<img>` needs a separate diff style string computed against the **IMG baseline**
 * (IMG-specific `overflow: clip` / replaced element default sizing rules differ from CANVAS;
 * reusing the CANVAS string misses properties). That string is passed in via the `styleOf`
 * callback by the caller (`createSnapshot.ts`).
 *
 * Bitmaps **are still PNG `toDataURL()` for now**; switching to webp or async `convertToBlob` is
 * for later and will only touch this file (3.8 "hook left for the future"). Once the shared WebGL
 * renderer lands, pixels for canvas cards will come from bitmaps returned by Workers, and this
 * file is still the only one to change.
 */

import { canvasPaintedBox } from "../solid";

export interface RasterizeResult {
  /** Number of canvases whose pixels could not be read and can only be left blank */
  lossy: number;
}

/**
 * Replace `<canvas>` in the clone with `<img>`.
 *
 * @param orig  Array of live elements
 * @param copy  Array of clone elements in 1:1 correspondence with `orig` (mutated in place)
 * @param styleOf  Computes style string for a live element against IMG baseline (including
 *   `animation:none`)
 */
export function rasterizeCanvas(
  orig: Element[],
  copy: Element[],
  styleOf: (el: Element) => string,
): RasterizeResult {
  let lossy = 0;
  for (let i = 0; i < orig.length; i++) {
    const from = orig[i];
    if (from.tagName !== "CANVAS") continue;
    const canvas = from as HTMLCanvasElement;
    /*
     * gl plane (R9 M4): bitmaps come from the shared renderer and `bitmaprenderer` context, so
     * `toDataURL` can always read them: **yet empty canvases still succeed** (even `src.length > 22`
     * below cannot catch it). Therefore, verify by frame number: each time `glHost` pastes a bitmap,
     * it writes `data-pc-gl-frame`, using the same formula as `data-pc-local-frame` on the wrapper
     * layer; if absent or mismatched, this frame's bitmap has not been pasted yet (or belongs to
     * another frame). Record `lossy` so `if (lossy) throw` in `bake.mjs` can catch the empty image.
     * Compare strings directly, no fps needed.
     */
    if (canvas.hasAttribute("data-pc-gl-plane")) {
      const got = canvas.getAttribute("data-pc-gl-frame");
      const want = canvas.closest("[data-pc-local-frame]")?.getAttribute("data-pc-local-frame");
      if (got === null || want == null || got !== want) { lossy++; continue; }
    }
    let src: string | null = null;
    try {
      src = canvas.toDataURL("image/png");
    } catch {
      src = null;
    }
    if (!(src && src.length > 22)) { lossy++; continue; }
    const img = document.createElement("img");
    img.setAttribute("style", styleOf(from));
    img.setAttribute("width", String(canvas.width));
    img.setAttribute("height", String(canvas.height));
    /*
     * A2(4): entity box is written as data-pc-painted-box="x,y,w,h", in **canvas pixel coordinates**
     * (expanded by one grid step and clamped within canvas), not viewport coordinates: the same
     * shared snapshot will be attached to clips at different positions and with different boxes;
     * consumers convert via the ratio of the <img>'s current outer frame to its width / height
     * attributes (paintedBoxRect in solid.ts). Directly import solid.ts to compute, without going
     * through window.__pcCanvasBox. If pixel scanning yields nothing (entirely blank / tainted),
     * omit the attribute, and consumers fall back to the element rectangle.
     */
    const painted = canvasPaintedBox(canvas);
    if (painted) img.setAttribute("data-pc-painted-box", [painted.x, painted.y, painted.w, painted.h].map((v) => String(Math.round(v))).join(","));
    img.src = src;
    copy[i].replaceWith(img);
  }
  return { lossy };
}
