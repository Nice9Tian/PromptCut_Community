/**
 * Direct canvas grab (render refactor "Ji-1", `docs/plan/prerender-products-contract.md`
 * sections 6.1 and 6.2): page side.
 *
 * When canvas and WebGL cards produce track streams, the prerender process does not take
 * screenshots, but directly asks the page for "pixels of this card's canvas at this moment":
 * the page draws the sole `<canvas>` in the wrapper layer into a draft canvas of the same size
 * as the screenshot rectangle based on its position on the stage, reads out straight RGBA (same
 * format as the screenshot PNG), and hands it to Node (`server/bakery/capture-canvas.mjs`).
 * Only attached as `window.__pcGrabCanvas` by the export page (`src/ExportView.tsx`); not used
 * anywhere else.
 *
 * # How to identify the canvas
 *
 * The **sole** `<canvas>` inside wrapper layer (`[data-pc-clip="<clip id>"]`); if there is none
 * or more than one, skip grabbing. Before grabbing a plane sharing the WebGL renderer
 * (`[data-pc-gl-plane]`), verify frame number following `snapshot/rasterizeCanvas.ts`:
 * `data-pc-gl-frame` must equal the wrapper layer's `data-pc-local-frame`; a mismatch means this
 * frame's bitmap has not been pasted yet (or another frame was pasted), returning `gl-frame`
 * and **not handing over an empty image**.
 *
 * This does not check "whether the card's graphics are entirely within the canvas" (elements
 * exist outside canvas, ancestors have opacity or filters, pixel and layout sizes mismatch):
 * that check is performed by Node comparing handed-over pixels with the screenshot of the same
 * frame (contract section 6.1, check 2).
 *
 * # How to hand over pixels
 *
 * Returns a base64 string via CDP. Transferring large strings over CDP is slow (measured at
 * ~90 ms for 8.3 MB raw pixels of a 1080p frame, several times slower than screenshots), so
 * **runs of fully transparent pixels** are compressed away first: output is a sequence of
 * `[skip N pixels, next N pixels, RGBA of these pixels...]` (little-endian 32-bit). Most canvas
 * card graphics are largely transparent, leaving only tens to hundreds of KB after compression.
 * If compressed size is not smaller than original, deliver as-is.
 * `maxBytes`: if compressed size exceeds this many bytes, do not deliver (return `dense`),
 * letting the caller fall back to screenshots.
 */

export interface CanvasGrabRect { x: number; y: number; w: number; h: number }

export type CanvasGrab =
  | { ok: true; w: number; h: number; packed: boolean; b64: string; bytes: number; readMs: number; packMs: number }
  | { ok: false; reason: string; bytes?: number; readMs?: number; packMs?: number };

/** The export page's `performance.now` is pinned to export milliseconds (`kernel/exportClock.ts`); measuring real elapsed time must bypass that layer on the instance */
const realNow = (): number => {
  try { return Performance.prototype.now.call(performance); } catch { return 0; }
};

let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

function scratchFor(w: number, h: number): CanvasRenderingContext2D | null {
  if (!scratch || !scratchCtx || scratch.width !== w || scratch.height !== h) {
    scratch = document.createElement("canvas");
    scratch.width = w;
    scratch.height = h;
    // Read-only, not displayed: keep it in memory so `getImageData` does not need to read back from VRAM
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  }
  return scratchCtx;
}

let packBuffer: Uint32Array | null = null;

/** Compress away runs of fully transparent pixels. Returns compressed bytes (overwritten by the next call); returns null if not smaller than original */
export function packTransparentRuns(rgba: Uint8ClampedArray | Uint8Array): Uint8Array | null {
  if (rgba.byteOffset % 4 || rgba.byteLength % 4) return null;
  const px = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >> 2);
  const n = px.length;
  // In the worst case (transparent and opaque alternate pixel-by-pixel), each pixel carries two extra
  // headers; only reserve space for original size, and abort if it does not fit.
  // The buffer is retained for reuse in the next frame (caller converts result to base64 immediately
  // without retaining references).
  if (!packBuffer || packBuffer.length < n) packBuffer = new Uint32Array(n);
  const out = packBuffer;
  let o = 0, i = 0;
  while (i < n) {
    let s = i;
    while (i < n && px[i] === 0) i++;
    const skip = i - s;
    s = i;
    while (i < n && px[i] !== 0) i++;
    const count = i - s;
    if (o + 2 + count >= n) return null;
    out[o++] = skip;
    out[o++] = count;
    out.set(px.subarray(s, i), o);
    o += count;
  }
  return new Uint8Array(out.buffer, 0, o * 4);
}

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(bytes);
  // Older engines lack `Uint8Array.prototype.toBase64`: chunk and concatenate strings then `btoa` (slow, but identical result)
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

/**
 * Grab pixels of clip `clipId`'s canvas within stage rectangle `rect` (integers, scene
 * coordinates). Returns `{ ok: true, w, h, packed, b64, … }`, or `{ ok: false, reason }`
 * (`no-wrapper` / `canvas-count:<n>` / `gl-frame` / `empty-canvas` / `no-context` /
 * `unreadable` / `dense`).
 */
export function grabCanvasPixels(clipId: string, rect: CanvasGrabRect, opts: { maxBytes?: number } = {}): CanvasGrab {
  const t0 = realNow();
  const w = Math.round(rect.w), h = Math.round(rect.h);
  if (!(w > 0 && h > 0)) return { ok: false, reason: "bad-rect" };
  let wrapper: Element | null = null;
  for (const el of document.querySelectorAll("[data-pc-clip]")) if (el.getAttribute("data-pc-clip") === clipId) { wrapper = el; break; }
  if (!wrapper) return { ok: false, reason: "no-wrapper" };
  const canvases = wrapper.querySelectorAll("canvas");
  if (canvases.length !== 1) return { ok: false, reason: `canvas-count:${canvases.length}` };
  const canvas = canvases[0];
  if (canvas.hasAttribute("data-pc-gl-plane")) {
    const got = canvas.getAttribute("data-pc-gl-frame");
    const want = canvas.closest("[data-pc-local-frame]")?.getAttribute("data-pc-local-frame");
    if (got === null || want == null || got !== want) return { ok: false, reason: "gl-frame" };
  }
  if (!(canvas.width > 0 && canvas.height > 0)) return { ok: false, reason: "empty-canvas" };
  const ctx = scratchFor(w, h);
  if (!ctx) return { ok: false, reason: "no-context" };
  const scene = document.querySelector("[data-pc-scene]")?.getBoundingClientRect();
  const box = canvas.getBoundingClientRect();
  let data: Uint8ClampedArray;
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    // Canvas is placed according to its layout box: scaled here when pixel and layout sizes mismatch;
    // whether scaling matches compositor is verified by tests on Node side.
    ctx.drawImage(canvas, box.left - (scene?.left ?? 0) - rect.x, box.top - (scene?.top ?? 0) - rect.y, box.width, box.height);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const t1 = realNow();
  const packedBytes = packTransparentRuns(data);
  const bytes = packedBytes ?? new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (opts.maxBytes !== undefined && bytes.length > opts.maxBytes) {
    return { ok: false, reason: "dense", bytes: bytes.length, readMs: t1 - t0, packMs: realNow() - t1 };
  }
  const b64 = toBase64(bytes);
  return { ok: true, w, h, packed: !!packedBytes, b64, bytes: bytes.length, readMs: t1 - t0, packMs: realNow() - t1 };
}
