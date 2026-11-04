/**
 * WebGL2 backend for pixel maps.
 *
 * Why this file exists: pixel maps originally used `getImageData` → evaluate expressions per
 * pixel → `putImageData`, measured at 416-483 ms per frame at 1080p
 * (docs/archive/restructure_planning/render_pipeline_restructure.md 2.1(b)), exceeding the per-tick
 * budget for 30 fps by about twenty times, heavy on any machine. After translating expressions
 * into fragment shaders, this step is moved entirely to the GPU, and the main thread only uploads
 * textures and submits. **The pixel-by-pixel CPU loop has been deleted entirely, leaving no runtime
 * fallback**; `mapRgba` is retained only for unit tests and GPU / CPU comparisons.
 *
 * One context per document: offscreen `OffscreenCanvas` + WebGL2; programs are cached by content
 * hash of fragment source code (compiled only once no matter how many clips the same definition is
 * attached to). After drawing, `transferToImageBitmap` hands it over to the asset layer's own
 * `<canvas>` (that canvas uses the `bitmaprenderer` context).
 *
 * Why `transferToImageBitmap` rather than `drawImage`:
 *   1. It is a **transfer of the entire bitmap**, where pixels land on the target canvas as-is
 *      pixel-by-pixel; `drawImage` goes through 2D composition, where straight alpha from the
 *      source canvas (premultipliedAlpha:false) must first be premultiplied and then
 *      un-premultiplied on the target canvas, losing one or two levels for low-alpha pixels each
 *      round trip: chroma keying is precisely the task that generates lots of low-alpha pixels.
 *   2. The offscreen canvas does not enter the DOM, avoiding an extra canvas that would need to
 *      be serialized by HTML snapshots.
 *   3. Target canvas dimensions are determined by the bitmap, without needing separate
 *      width / height synchronization.
 * The trade-off is that the target canvas can only have the `bitmaprenderer` context (a canvas can
 * only have one type), so that canvas in the asset layer can no longer use 2D. Reading
 * `canvasPixels` of an entity box uses `drawImage` to an offscreen 2D canvas and is unaffected.
 *
 * Shared across preview, export page, and see_frames: all three render the same FrameScene.
 * When the shared WebGL renderer (R9) lands later, simply merge this context into it; the contract
 * remains unchanged.
 */
import { compilePixelMapGlsl, type PixelMapDef } from "../kernel/pixelMap.mjs";

export interface PixelMapDrawOpts {
  def: PixelMapDef;
  /** Source: video / image element, or intermediate canvas with filters already applied */
  source: TexImageSource;
  /** Second texture when to is another asset clip; pass null if none or not yet decoded */
  target?: TexImageSource | null;
  width: number;
  height: number;
  /** Seconds within the clip, uT in the shader */
  t: number;
}

interface Prog {
  program: WebGLProgram;
  uTex: WebGLUniformLocation | null;
  uTarget: WebGLUniformLocation | null;
  uHasTarget: WebGLUniformLocation | null;
  uT: WebGLUniformLocation | null;
  uSize: WebGLUniformLocation | null;
}

let canvas: OffscreenCanvas | null = null;
let gl: WebGL2RenderingContext | null = null;
let texSrc: WebGLTexture | null = null;
let texTgt: WebGLTexture | null = null;
let programs = new Map<string, Prog>();

export class PixelMapGlError extends Error {}

/** If context is lost (or not yet created), redo everything: programs and textures are gone along with the context */
function dropContext() {
  canvas = null;
  gl = null;
  texSrc = null;
  texTgt = null;
  programs = new Map();
}

/** Manually cleared during unit tests / document switching */
export function resetPixelMapGl() {
  dropContext();
}

function newTexture(g: WebGL2RenderingContext): WebGLTexture {
  const tex = g.createTexture();
  g.bindTexture(g.TEXTURE_2D, tex);
  // When source and frame have the same dimensions, uv lands right on texel centers, and LINEAR gets
  // the same value as nearest neighbor; bilinear is only done when dimensions differ, matching the
  // scaling behavior of drawImage(s, 0, 0, w, h) in the original CPU pipeline.
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  return tex;
}

function ensure(): WebGL2RenderingContext {
  if (gl && !gl.isContextLost()) return gl;
  if (gl) dropContext();
  if (typeof OffscreenCanvas === "undefined") {
    throw new PixelMapGlError("This runtime has no OffscreenCanvas, so pixel maps cannot be drawn (requires Chrome / WebView2)");
  }
  const c = new OffscreenCanvas(1, 1);
  const g = c.getContext("webgl2", {
    alpha: true,
    // Straight alpha: the shader writes out the four numbers of mapRgba directly, without round-trip premultiplication
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    desynchronized: false,
  }) as WebGL2RenderingContext | null;
  if (!g) throw new PixelMapGlError("Could not get a WebGL2 context, so pixel maps cannot be drawn");
  // Do not let browser give up directly on context loss: rebuilding is only possible after preventDefault
  (c as unknown as EventTarget).addEventListener("webglcontextlost", (e) => { e.preventDefault(); dropContext(); });
  g.disable(g.BLEND);
  g.disable(g.DEPTH_TEST);
  g.disable(g.SCISSOR_TEST);
  g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
  g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  // Browsers by default convert using the asset's color profile; pixel maps need raw asset values
  g.pixelStorei(g.UNPACK_COLORSPACE_CONVERSION_WEBGL, g.NONE);
  canvas = c;
  gl = g;
  texSrc = newTexture(g);
  texTgt = newTexture(g);
  return g;
}

function compileShader(g: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = g.createShader(type)!;
  g.shaderSource(sh, src);
  g.compileShader(sh);
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
    const log = g.getShaderInfoLog(sh);
    g.deleteShader(sh);
    throw new PixelMapGlError(`Shader compile failed: ${log}`);
  }
  return sh;
}

function programOf(g: WebGL2RenderingContext, def: PixelMapDef): Prog {
  const { fragment, vertex, key } = compilePixelMapGlsl(def);
  const hit = programs.get(key);
  if (hit) return hit;
  const vs = compileShader(g, g.VERTEX_SHADER, vertex);
  const fs = compileShader(g, g.FRAGMENT_SHADER, fragment);
  const program = g.createProgram()!;
  g.attachShader(program, vs);
  g.attachShader(program, fs);
  g.linkProgram(program);
  g.deleteShader(vs);
  g.deleteShader(fs);
  if (!g.getProgramParameter(program, g.LINK_STATUS)) {
    const log = g.getProgramInfoLog(program);
    g.deleteProgram(program);
    throw new PixelMapGlError(`Shader link failed: ${log}`);
  }
  const prog: Prog = {
    program,
    uTex: g.getUniformLocation(program, "uTex"),
    uTarget: g.getUniformLocation(program, "uTarget"),
    uHasTarget: g.getUniformLocation(program, "uHasTarget"),
    uT: g.getUniformLocation(program, "uT"),
    uSize: g.getUniformLocation(program, "uSize"),
  };
  programs.set(key, prog);
  return prog;
}

/** Draw a frame to offscreen canvas (synchronous; after drawArrays the image stays on GPU, settles only when fetched) */
function render(opts: PixelMapDrawOpts): WebGL2RenderingContext {
  const g = ensure();
  const w = Math.max(1, Math.round(opts.width));
  const h = Math.max(1, Math.round(opts.height));
  if (canvas!.width !== w || canvas!.height !== h) { canvas!.width = w; canvas!.height = h; }
  const prog = programOf(g, opts.def);
  g.viewport(0, 0, w, h);
  g.useProgram(prog.program);

  g.activeTexture(g.TEXTURE0);
  g.bindTexture(g.TEXTURE_2D, texSrc);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, opts.source as TexImageSource);
  g.uniform1i(prog.uTex, 0);

  const hasTarget = !!opts.target;
  g.activeTexture(g.TEXTURE1);
  g.bindTexture(g.TEXTURE_2D, texTgt);
  // Provide a valid texture even without a second asset: sampling an uninitialized sampler is
  // undefined behavior on some drivers
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, (hasTarget ? opts.target : opts.source) as TexImageSource);
  g.uniform1i(prog.uTarget, 1);
  g.uniform1i(prog.uHasTarget, hasTarget ? 1 : 0);

  g.uniform1f(prog.uT, opts.t);
  g.uniform2f(prog.uSize, w, h);

  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT);
  // Three vertices are calculated from gl_VertexID, without vertex buffers or VAOs
  g.drawArrays(g.TRIANGLES, 0, 3);
  return g;
}

/**
 * Draws a frame and transfers the entire result to the asset layer's own canvas.
 * `out` can only have the `bitmaprenderer` context (this function retrieves it on its behalf).
 */
export function drawPixelMap(out: HTMLCanvasElement, opts: PixelMapDrawOpts): void {
  render(opts);
  const ctx = out.getContext("bitmaprenderer");
  if (!ctx) throw new PixelMapGlError("Could not get a bitmaprenderer context for the media layer canvas (does this canvas already have another context?)");
  ctx.transferFromImageBitmap(canvas!.transferToImageBitmap());
}

/**
 * Draws a frame and reads pixels back, arranged **top-down** (matching ImageData row order),
 * straight alpha. Used only for acceptance check comparisons and probes: it bypasses canvas
 * transfers and measures values computed by the shader itself.
 */
export function readPixelMap(opts: PixelMapDrawOpts): Uint8ClampedArray {
  const g = render(opts);
  const w = Math.max(1, Math.round(opts.width));
  const h = Math.max(1, Math.round(opts.height));
  const flipped = new Uint8Array(w * h * 4);
  g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, flipped);
  const out = new Uint8ClampedArray(w * h * 4);
  const rowBytes = w * 4;
  for (let row = 0; row < h; row++) {
    out.set(flipped.subarray((h - 1 - row) * rowBytes, (h - row) * rowBytes), row * rowBytes);
  }
  return out;
}

/**
 * Probe only: exposes this document's WebGL2 context to wrap drawPixelMap with
 * EXT_disjoint_timer_query_webgl2 to measure actual GPU duration. The render path does not use it.
 */
export function pixelMapGlContext(): WebGL2RenderingContext {
  return ensure();
}

/** Does it really run on GPU: write renderer string into report during acceptance check to avoid mistaking software rendering for GPU */
export function pixelMapGlInfo(): { vendor: string; renderer: string; version: string } | null {
  try {
    const g = ensure();
    const ext = g.getExtension("WEBGL_debug_renderer_info");
    return {
      vendor: String(ext ? g.getParameter(ext.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR)),
      renderer: String(ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)),
      version: String(g.getParameter(g.VERSION)),
    };
  } catch {
    return null;
  }
}

// The export page and see_frames run the same scene tree in their own Chrome context; probe scripts
// rely on these hooks to fetch data.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__pcPixelMapGl = { drawPixelMap, readPixelMap, pixelMapGlInfo, resetPixelMapGl };
}
