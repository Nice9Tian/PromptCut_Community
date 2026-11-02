/**
 * Pixel work on the rendered frame before handing it over: composite asset layers, flatten background
 * color, count transparent pixels, downscale image.
 *
 * # Why kept separately here
 *
 * These are all synchronous pngjs decoding / encoding plus per-pixel loops. Originally written in
 * vite-plugin-vision.ts, running on the event loop of **the Vite process serving modules to the editor**:
 * benchmarked on a 1080p frame with content, decoding took 54 ms and encoding took 94 ms; see_frames
 * decoded twice and encoded twice per frame, blocking the event loop for ~300 ms per frame, during which
 * none of the modules, assets, or endpoints needed by the editor could be served
 * (docs/archive/topics/decoupling-plan.md section 1.1).
 *
 * Now completed by the render worker (scripts/render-worker.mjs) in its own process; the parent process
 * only reads bytes from the result file without decoding. Pure functions live in .mjs, testable with
 * node --test without going through vite.
 */
import fs from "node:fs/promises";
import { PNG } from "pngjs";
import { composeFrame } from "./vision-compose.mjs";

/** Long-edge ceiling for downscaling: enough for model to see clearly; larger only wastes context */
export const MAX_EDGE = 768;
/** Transparent areas drawn as checkerboard so model can distinguish "transparent" from "black" */
const CHECKER_A = [0x6b, 0x70, 0x7b];
const CHECKER_B = [0x8b, 0x91, 0x9c];
const CHECKER_PX = 16;

/**
 * Scales down proportionally within maxEdge while compositing the transparent background onto a
 * checkerboard.
 *
 * Hand-rolled with pngjs instead of pulling in sharp or spawning another ffmpeg: this step only
 * shrinks an image, so introducing a native dependency or another child process is not worth it.
 * Box averaging is sufficient for "seeing clearly what is on screen", and when downscaling it is less
 * prone to jittering away fine text than point sampling.
 */
export function shrink(png, maxEdge = MAX_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(png.width, png.height));
  const w = Math.max(1, Math.round(png.width * scale));
  const h = Math.max(1, Math.round(png.height * scale));
  const out = new PNG({ width: w, height: h });

  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * png.height) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * png.height) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * png.width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * png.width) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * png.width + sx) << 2;
          // Premultiply by alpha before averaging; otherwise garbage colors in transparent pixels stain edges
          const al = png.data[i + 3] / 255;
          r += png.data[i] * al; g += png.data[i + 1] * al; b += png.data[i + 2] * al;
          a += al; n++;
        }
      }
      const o = (y * w + x) << 2;
      const cover = a / n;
      // Composite onto checkerboard: out = foreground (premultiplied) + grid color × (1 - coverage).
      // Where covered by a card, cover=1 and no grid shows through; grid is visible only where truly transparent.
      const matte = (((x / CHECKER_PX) | 0) + ((y / CHECKER_PX) | 0)) % 2 === 0 ? CHECKER_A : CHECKER_B;
      out.data[o] = Math.round(r / n + matte[0] * (1 - cover));
      out.data[o + 1] = Math.round(g / n + matte[1] * (1 - cover));
      out.data[o + 2] = Math.round(b / n + matte[2] * (1 - cover));
      out.data[o + 3] = 255;
    }
  }
  return { png: out, width: w, height: h };
}

/**
 * Flattens transparent background onto a background color (in-place). `hex` is 6-digit hex (without #).
 *
 * This choice should only be made once **during prerender**: omitted = transparent background, objects
 * show through where the card has not drawn (cutout look, suitable for logos / signs); passed = solid
 * object with this card printed on its surface.
 */
export function flatten(png, hex) {
  const v = parseInt(hex, 16);
  const [br, bgc, bb] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  for (let i = 0; i < png.data.length; i += 4) {
    const a = png.data[i + 3] / 255;
    png.data[i] = Math.round(png.data[i] * a + br * (1 - a));
    png.data[i + 1] = Math.round(png.data[i + 1] * a + bgc * (1 - a));
    png.data[i + 2] = Math.round(png.data[i + 2] * a + bb * (1 - a));
    png.data[i + 3] = 255;
  }
  return png;
}

/** Transparent pixel ratio (3 decimals). 1 for an empty render: bake_card uses it to warn "this card drew nothing at this moment" */
export function transparentRatio(png) {
  let clear = 0;
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] === 0) clear++;
  return Math.round((clear / (png.width * png.height)) * 1000) / 1000;
}

/**
 * Post-processing for a single frame.
 *
 * item:
 *   cards   : card layer PNG rendered from page (transparent background)
 *   layers  : asset layer PNGs, bottom to top (frames extracted by ffmpeg, see extractArgs in vision-compose)
 *   out     : destination path
 *   bg      : 6-digit hex background color; keeps transparency if omitted
 *   stats   : whether to count transparent pixels
 *   shrink  : whether to shrink to MAX_EDGE and overlay checkerboard (the kind for models to inspect)
 *
 * **Skip decoding when nothing to do**: copy over as-is. Previously read and wrote again even when
 * there were no asset layers, which was completely wasted work.
 */
export async function postFrame(item) {
  const layers = Array.isArray(item.layers) ? item.layers : [];
  const needDecode = layers.length > 0 || !!item.bg || !!item.stats || !!item.shrink;
  if (!needDecode) {
    if (item.out !== item.cards) await fs.copyFile(item.cards, item.out);
    return { width: null, height: null };
  }
  let img = PNG.sync.read(await fs.readFile(item.cards));
  if (layers.length) {
    const decoded = [];
    for (const f of layers) decoded.push(PNG.sync.read(await fs.readFile(f)));
    img = composeFrame(img.width, img.height, decoded, img);
  }
  if (item.bg) flatten(img, item.bg);
  const ratio = item.stats ? transparentRatio(img) : undefined;
  const fin = item.shrink ? shrink(img) : { png: img, width: img.width, height: img.height };
  await fs.writeFile(item.out, PNG.sync.write(fin.png));
  return { width: fin.width, height: fin.height, ...(ratio === undefined ? {} : { transparentRatio: ratio }) };
}
