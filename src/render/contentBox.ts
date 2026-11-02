/**
 * Measures the bounding box (stage coordinates) of rendered card content.
 *
 * Cards have no static "where I draw": without a frame they fill the entire aspect ratio,
 * while content is usually just a small area in the middle. Preview cards scale proportionally
 * to the entire aspect ratio; when 1920×1080 is squeezed into a 130px square, text in a title card
 * turns into a tiny speck. So we actually measure: union the rectangles of **visible elements**
 * in the stage (text, images, svg, canvas, boxes with background color / border), and preview scales
 * according to this box. Elements filling the entire stage (backgrounds, outer containers used for
 * centering) do not count; otherwise the union would always be the full screen.
 *
 * Text is measured with Range: a block element's rectangle spans the full row width, whereas
 * Range gives the box of the text itself.
 * canvas is measured by scanning pixels: the DOM only knows how large the canvas is, not what
 * is drawn inside.
 */
import { isPlaceholderNode } from "./placeholderHost.ts";

export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

/**
 * A card's "ink color": solid mode (low-fidelity preview) uses it to color proxy swatches.
 *
 * Two values, neither can be missing:
 *   - `rgb` is the average color **weighted by alpha**: only counting areas where something was
 *     actually drawn. If averaged across the whole box directly, title cards are 90% transparent,
 *     so all text cards would be diluted into the same blob of gray.
 *   - `cover` indicates how "solid" this card is (0~1): ratio of drawn area to the box.
 *     A full-bleed panel card is close to 1, while a title card with just a few words is
 *     zero point something.
 *
 * The proxy plane is drawn with `rgba(rgb, cover)`, so panel cards and title cards **look different**
 * in solid mode: and "is this block too heavy when placed on top?" is precisely what needs to be
 * judged when browsing. Colors hashed from IDs cannot provide this.
 */
export interface Ink {
  rgb: [number, number, number];
  cover: number;
}

const REPLACED = new Set(["IMG", "SVG", "CANVAS", "VIDEO", "PICTURE"]);
/**
 * Maximum sampling steps per side when scanning canvas pixels; beyond this,
 * stride-sample; tens of thousands of points are enough to define bounds
 */
const CANVAS_SAMPLES = 200;
/** Pixels with opacity lower than this value are treated as unpainted */
const ALPHA_MIN = 8;

function hasOwnText(el: Element): boolean {
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim()) return true;
  }
  return false;
}

function paintsItself(el: Element): boolean {
  const cs = getComputedStyle(el);
  if (cs.backgroundImage !== "none") return true;
  const bg = cs.backgroundColor;
  if (bg && bg !== "transparent" && !/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(bg)) return true;
  if ((parseFloat(cs.borderTopWidth) || 0) > 0 || (parseFloat(cs.borderLeftWidth) || 0) > 0) return true;
  if (cs.boxShadow && cs.boxShadow !== "none") return true;
  return false;
}

function textRect(el: Element): DOMRect | null {
  const range = document.createRange();
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const n of el.childNodes) {
    if (n.nodeType !== Node.TEXT_NODE || !(n.textContent ?? "").trim()) continue;
    range.selectNodeContents(n);
    const rc = range.getBoundingClientRect();
    if (rc.width <= 0 || rc.height <= 0) continue;
    l = Math.min(l, rc.left); t = Math.min(t, rc.top); r = Math.max(r, rc.right); b = Math.max(b, rc.bottom);
  }
  range.detach();
  return r > l && b > t ? new DOMRect(l, t, r - l, b - t) : null;
}

/**
 * What is drawn in a canvas is invisible to the DOM: the element rectangle is always the entire
 * canvas, so cards like particle backgrounds or charts are all judged as "filling the whole frame",
 * and preview can only fall back to scaling the entire frame. Here we read pixels directly to box
 * the area where content was actually drawn.
 *
 * Both 2D and WebGL canvases are supported (via drawImage to an offscreen canvas, see explanation
 * below). Canvases tainted by cross-origin images throw when reading pixels: in that case, null is
 * returned, and callers fall back to the element rectangle. Returned in **screen coordinates**,
 * consistent with other measurement methods.
 */
export function canvasBox(el: HTMLCanvasElement): DOMRect | null {
  return canvasRect(el, canvasPixels(el));
}

/** Drawn region in canvas pixels; step is sampling stride. null = entirely blank or pixels unreadable */
export interface CanvasPixels {
  l: number;
  t: number;
  r: number;
  b: number;
  step: number;
  w: number;
  h: number;
}

/**
 * Reads canvas pixels once and boxes the region with drawn content (canvas pixel coordinates).
 *
 * This is the most expensive step in the entire measurement: a 1920×1080 canvas requires
 * drawImage + getImageData to read back 8 million bytes, taking tens of milliseconds each time.
 * One pass of measureAcrossTime scrubs dozens of steps; if read at every step, a 3D card becomes
 * a long task of several hundred milliseconds. So it is split into two halves: "read pixels" and
 * "convert to screen": in the same pass, canvas content does not change (scrubbing Web Animations
 * does not run JS; canvas redraws only in requestAnimationFrame), reading pixel bounds once is
 * enough, and each step only re-fetches the element rectangle.
 */
/**
 * Only **one** offscreen canvas is kept for reading pixels, enlarged on demand and cleared first
 * each time. If a new 1920×1080 canvas is createElement-ed every time, GC cannot collect them in time
 * between consecutive reads (selection marquee heartbeat, generate snapshots, probe).
 * Once Chrome's canvas memory budget is reached, getContext("2d") starts returning null:
 * in benchmarks, starting from the third snapshot generation, the canvas entity box could no longer
 * be measured, without throwing any error (just falling back to the entire canvas).
 */
let scratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
function scratchContext(w: number, h: number): CanvasRenderingContext2D | null {
  if (!scratch) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    scratch = { canvas, ctx };
  }
  const { canvas, ctx } = scratch;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;   // Resizing automatically clears the canvas
    canvas.height = h;
  } else {
    ctx.clearRect(0, 0, w, h);
  }
  return ctx;
}

export function canvasPixels(el: HTMLCanvasElement): CanvasPixels | null {
  const w = el.width, h = el.height;
  if (!w || !h) return null;
  let data: Uint8ClampedArray;
  try {
    /*
     * Cannot use `el.getContext("2d")`: **a canvas can only have one context type**, and it returns null
     * on WebGL canvases, causing 3D cards (scene-3d) to fall back to "element rectangle" = entire canvas,
     * which is usually full-screen and completely transparent around the edges. As a result,
     * get_layout's contentBox reports "this card occupies full 1920×1080", whereas the tool description
     * explicitly states "check contentBox to determine if people will be covered", leading the Agent
     * to think there is no room and move things that didn't need moving.
     *
     * Drawing via `drawImage` onto an offscreen 2D canvas works for both contexts (WebGL relies on
     * preserveDrawingBuffer:true when scene-3d initializes the renderer to ensure content can be read).
     */
    const ctx = scratchContext(w, h);
    if (!ctx) return null;
    ctx.drawImage(el, 0, 0);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
  const step = Math.max(1, Math.ceil(Math.max(w, h) / CANVAS_SAMPLES));
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (let y = 0; y < h; y += step) {
    const row = y * w * 4;
    for (let x = 0; x < w; x += step) {
      if (data[row + x * 4 + 3] < ALPHA_MIN) continue;
      if (x < l) l = x;
      if (x > r) r = x;
      if (y < t) t = y;
      if (y > b) b = y;
    }
  }
  if (r < l || b < t) return null; // Entirely blank
  return { l, t, r, b, step, w, h };
}

/** Converts pixel bounds to screen coordinates: sampling strides, expand bounds by 1 step to avoid clipping */
function canvasRect(el: HTMLCanvasElement, px: CanvasPixels | null): DOMRect | null {
  if (!px) return null;
  const { l, t, r, b, step, w, h } = px;
  const rect = el.getBoundingClientRect();
  const sx = rect.width / w, sy = rect.height / h;
  const x0 = Math.max(0, l - step), y0 = Math.max(0, t - step);
  const x1 = Math.min(w, r + step), y1 = Math.min(h, b + step);
  return new DOMRect(rect.left + x0 * sx, rect.top + y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy);
}

/**
 * @param stage  Stage element (.pc-stage), whose screen rectangle is the origin and scale of
 *   the stage coordinate system
 * @param canvasCache  Pass the same Map when measuring across multiple steps in the same pass:
 *   reads pixels of each canvas only once (see canvasPixels)
 * @returns Bounding box in stage coordinates; returns null if nothing was measured or content fills the stage
 *
 * Scale is not passed from outside: while the stage is undergoing transform transitions,
 * the target scale specified in styles differs from the scale actually rendered on screen
 * at this moment; dividing by target scale would distort coordinates. Screen rectangle /
 * layout width is the true current scale, captured in the exact same moment as element
 * rectangles, so they always match.
 */
export function measureContentBox(stage: HTMLElement, canvasCache?: Map<HTMLCanvasElement, CanvasPixels | null>): Box | null {
  const sr = stage.getBoundingClientRect();
  const scale = stage.offsetWidth > 0 ? sr.width / stage.offsetWidth : 0;
  if (sr.width <= 0 || sr.height <= 0 || scale <= 0) return null;
  const stageArea = sr.width * sr.height;
  let box: Box | null = null;
  const add = (r: DOMRect) => {
    if (r.width <= 0 || r.height <= 0) return;
    // Elements filling the stage count as background, not content
    if ((r.width * r.height) / stageArea >= 0.9) return;
    const l = Math.max(0, (r.left - sr.left) / scale);
    const t = Math.max(0, (r.top - sr.top) / scale);
    const rr = Math.min(sr.width / scale, (r.right - sr.left) / scale);
    const bb = Math.min(sr.height / scale, (r.bottom - sr.top) / scale);
    if (rr <= l || bb <= t) return;
    box = box ? { l: Math.min(box.l, l), t: Math.min(box.t, t), r: Math.max(box.r, rr), b: Math.max(box.b, bb) } : { l, t, r: rr, b: bb };
  };
  for (const el of stage.querySelectorAll<HTMLElement>("*")) {
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    // Placeholder planes are not drawn by the card (product/rendering.md "Fallback order"):
    // measuring them mistakes the placeholder box for an ink box
    if (isPlaceholderNode(el)) continue;
    // No need to measure child elements inside svg individually; a single box for the whole svg suffices
    if (el.namespaceURI === "http://www.w3.org/2000/svg" && el.tagName !== "svg") continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
    if (REPLACED.has(el.tagName.toUpperCase())) {
      // Scan canvas pixels first: canvases mostly fill the full frame, while content is drawn in only a portion
      let painted: DOMRect | null = null;
      if (el.tagName.toUpperCase() === "CANVAS") {
        const cv = el as HTMLCanvasElement;
        let px = canvasCache?.get(cv);
        if (px === undefined) {
          px = canvasPixels(cv);
          canvasCache?.set(cv, px);
        }
        painted = canvasRect(cv, px);
      }
      add(painted ?? el.getBoundingClientRect());
      continue;
    }
    if (hasOwnText(el)) {
      const tr = textRect(el);
      if (tr) add(tr);
    }
    if (paintsItself(el)) add(el.getBoundingClientRect());
  }
  if (!box) return null;
  const b: Box = box;
  const stageW = sr.width / scale;
  const stageH = sr.height / scale;
  // If the union is still almost the full frame, treat as full frame without clipping
  if (((b.r - b.l) * (b.b - b.t)) / (stageW * stageH) >= 0.85) return null;
  return b;
}

/** Parses computed style colors. Returns null when uncertain, letting callers skip rather than record a guess */
function parseColor(v: string): { rgb: [number, number, number]; a: number } | null {
  if (!v || v === "transparent" || v === "none") return null;
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return null;
  const a = p.length >= 4 ? p[3] : 1;
  if (a <= 0) return null;
  return { rgb: [p[0], p[1], p[2]], a };
}

/**
 * Canvas ink color: read pixels directly.
 *
 * Uses `drawImage` to a small offscreen 2D canvas rather than `getContext("2d")` on the original
 * canvas: the latter returns null for WebGL canvases (a canvas can only have one context type),
 * preventing 3D cards from ever getting a color. In addition, downsamples to 64×64: a few thousand
 * points are sufficient to determine an average color while avoiding the readback overhead of a large
 * canvas.
 *
 * Returns null if unavailable: canvases tainted by cross-origin images will throw, and WebGL without
 * preserveDrawingBuffer enabled may yield an empty image: neither should be recorded as "this card
 * is transparent".
 */
function canvasInk(el: HTMLCanvasElement): { sum: [number, number, number]; weight: number; samples: number } | null {
  const w = el.width, h = el.height;
  if (!w || !h) return null;
  const n = 64;
  try {
    const off = document.createElement("canvas");
    off.width = Math.min(n, w);
    off.height = Math.min(n, h);
    const ctx = off.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(el, 0, 0, off.width, off.height);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    const sum: [number, number, number] = [0, 0, 0];
    let weight = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      if (d[i + 3] < ALPHA_MIN) continue;
      sum[0] += d[i] * a; sum[1] += d[i + 1] * a; sum[2] += d[i + 2] * a;
      weight += a;
    }
    return weight > 0 ? { sum, weight, samples: (d.length / 4) || 1 } : null;
  } catch {
    return null;
  }
}

/**
 * Measures ink color of this card. Traversed elements use **the same filter** as measureContentBox,
 * except that rectangles are unioned over there, while colors are accumulated here.
 *
 * Colors do not come from pixels (DOM cannot read its own pixels), but from computed style:
 * Background color takes `background-color`, text takes `color`, each weighted by "area × alpha".
 * `getComputedStyle` gives resolved final values; variables like `--pc-glass-bg` automatically
 * resolve into concrete colors, and **not a single card needs to change**. canvas is an exception;
 * it actually reads pixels.
 *
 * Nested boxes are counted repeatedly (both outer and inner background colors are counted once),
 * so cover is clamped to 1: what it expresses is "how solid this block is", not exact coverage;
 * double-counting only makes what is solid even more solid, which is in the right direction.
 */
export function measureInk(stage: HTMLElement, box: Box | null): Ink | null {
  const sr = stage.getBoundingClientRect();
  const scale = stage.offsetWidth > 0 ? sr.width / stage.offsetWidth : 0;
  if (sr.width <= 0 || scale <= 0) return null;
  // Reference area: use the content box if present; otherwise use the entire stage (cards that fill the stage)
  const refArea = box ? Math.max(1, (box.r - box.l) * (box.b - box.t)) : (sr.width / scale) * (sr.height / scale);
  const stageArea = sr.width * sr.height;

  const sum: [number, number, number] = [0, 0, 0];
  let weight = 0;

  /** Record one entry: color + how much area it covers (screen area, converted back to stage area) */
  const add = (c: { rgb: [number, number, number]; a: number }, screenArea: number, opacity: number) => {
    if (screenArea <= 0) return;
    // What fills the stage counts as background, not content: the same rule as measureContentBox
    if (screenArea / stageArea >= 0.9) return;
    const w = (screenArea / (scale * scale)) * c.a * opacity;
    if (w <= 0) return;
    sum[0] += c.rgb[0] * w; sum[1] += c.rgb[1] * w; sum[2] += c.rgb[2] * w;
    weight += w;
  };

  for (const el of stage.querySelectorAll<HTMLElement>("*")) {
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    if (isPlaceholderNode(el)) continue;
    if (el.namespaceURI === "http://www.w3.org/2000/svg" && el.tagName !== "svg") continue;
    const cs = getComputedStyle(el);
    const op = parseFloat(cs.opacity);
    if (cs.display === "none" || cs.visibility === "hidden" || op === 0) continue;

    if (el.tagName.toUpperCase() === "CANVAS") {
      const ink = canvasInk(el as HTMLCanvasElement);
      const rect = el.getBoundingClientRect();
      if (ink && rect.width > 0) {
        // Area on canvas where "something was drawn": ratio of valid pixels × area of canvas on screen
        const painted = (ink.weight / ink.samples) * rect.width * rect.height;
        add({ rgb: [ink.sum[0] / ink.weight, ink.sum[1] / ink.weight, ink.sum[2] / ink.weight], a: 1 }, painted, op);
      }
      continue;
    }
    if (REPLACED.has(el.tagName.toUpperCase())) {
      // Average color cannot be read from images / videos (cross-origin taints canvas); record as
      // neutral gray just to let cover reflect "something is here"
      const r = el.getBoundingClientRect();
      add({ rgb: [128, 128, 128], a: 1 }, r.width * r.height, op);
      continue;
    }
    if (hasOwnText(el)) {
      const tr = textRect(el);
      const c = parseColor(cs.color);
      // Text is not solid; only about 30% of a character box is strokes: without this discount,
      // a line of text would be heavier than an entire solid background block
      if (tr && c) add(c, tr.width * tr.height * 0.3, op);
    }
    const bg = parseColor(cs.backgroundColor);
    if (bg) {
      const r = el.getBoundingClientRect();
      add(bg, r.width * r.height, op);
    }
  }

  if (weight <= 0) return null;
  return {
    rgb: [Math.round(sum[0] / weight), Math.round(sum[1] / weight), Math.round(sum[2] / weight)],
    cover: Math.min(1, weight / refArea),
  };
}

/**
 * Same measurement method as `measureContentBox`, but the result is converted to **the wrapper
 * layer's own local coordinates** (layout pixels without rotation / scaling), used for positioning
 * boxes on the placeholder plane (product/rendering.md "Fallback order": placeholders are on
 * entity boxes, inheriting the wrapper layer's rotation and scaling).
 *
 * `measureContentBox` converts via "screen rectangle ÷ scale"; when the wrapper layer has
 * rotation, that is a bounding box, which skews when placed back into local coordinates.
 * Here it is first restored to the bounding box on screen, then inversely solved using the wrapper
 * layer's rotation angle and uniform scale: reverse-rotate the center point, and solve a 2×2
 * equation for width and height (after a locally axis-aligned rectangle is rotated by θ, bounding
 * box width = w|cos| + h|sin|, height = w|sin| + h|cos|).
 * Near 45°, the equation is ill-conditioned, falling back to bounding box dimensions (biased
 * larger, not smaller). Results are clamped within the wrapper layer; returns null if unmeasurable.
 */
export function measureLocalContentBox(wrap: HTMLElement, canvasCache?: Map<HTMLCanvasElement, CanvasPixels | null>): { left: number; top: number; width: number; height: number } | null {
  /*
   * Exact path (Item 7): temporarily override the wrapper layer's **own** transform to
   * `none !important` within the same task, and restore it immediately after measuring:
   * during measurement, the wrapper layer has no rotation / skew / non-uniform scaling, so
   * `measureContentBox`'s "screen rectangle ÷ equivalent scale" is precisely local coordinates;
   * the browser does not paint between synchronous reads and writes, invisible to users.
   * `!important` suppresses animations on the wrapper layer; if still not suppressed (computed value
   * is still not none), follow the inverse solution below.
   */
  const exact = measureWithoutOwnTransform(wrap, canvasCache);
  if (exact !== undefined) return exact;
  return measureLocalByInversion(wrap, canvasCache);
}

/** Temporarily remove wrapper layer's own transform before measuring; return `undefined` if unremovable (caller falls back to inverse solve) */
function measureWithoutOwnTransform(wrap: HTMLElement, canvasCache?: Map<HTMLCanvasElement, CanvasPixels | null>): { left: number; top: number; width: number; height: number } | null | undefined {
  const before = getComputedStyle(wrap).transform;
  if (!before || before === "none") return clampLocal(wrap, measureContentBox(wrap, canvasCache));
  const value = wrap.style.getPropertyValue("transform");
  const priority = wrap.style.getPropertyPriority("transform");
  wrap.style.setProperty("transform", "none", "important");
  try {
    if (getComputedStyle(wrap).transform !== "none") return undefined;
    return clampLocal(wrap, measureContentBox(wrap, canvasCache));
  } finally {
    if (value) wrap.style.setProperty("transform", value, priority);
    else wrap.style.removeProperty("transform");
  }
}

/** Clamp `measureContentBox` result (local coordinates when wrapper layer has no self-transform) inside wrapper layer */
function clampLocal(wrap: HTMLElement, b: Box | null): { left: number; top: number; width: number; height: number } | null {
  if (!b) return null;
  const w = wrap.offsetWidth, h = wrap.offsetHeight;
  if (!(w > 0) || !(h > 0)) return null;
  const left = Math.max(0, b.l), top = Math.max(0, b.t);
  const right = Math.min(w, b.r), bottom = Math.min(h, b.b);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** Fallback path: solve inversely by wrapper layer rotation angle and uniform scale (original algorithm; falls back to bounding box near 45°) */
function measureLocalByInversion(wrap: HTMLElement, canvasCache?: Map<HTMLCanvasElement, CanvasPixels | null>): { left: number; top: number; width: number; height: number } | null {
  const b = measureContentBox(wrap, canvasCache);
  if (!b) return null;
  const sr = wrap.getBoundingClientRect();
  const w = wrap.offsetWidth, h = wrap.offsetHeight;
  if (!(w > 0) || !(h > 0) || !(sr.width > 0)) return null;
  const k = sr.width / w;
  // Restore to bounding box on screen (inverse conversion of measureContentBox)
  const u = { l: sr.left + b.l * k, t: sr.top + b.t * k, r: sr.left + b.r * k, b: sr.top + b.b * k };
  const raw = getComputedStyle(wrap).transform;
  let theta = 0;
  try { if (raw && raw !== "none") { const m = new DOMMatrixReadOnly(raw); theta = Math.atan2(m.b, m.a); } } catch { theta = 0; }
  const c = Math.abs(Math.cos(theta)), s = Math.abs(Math.sin(theta));
  // Equivalent scale of wrapper layer (including ancestors): bounding box width = S × (w|cos| + h|sin|)
  const S = sr.width / (w * c + h * s);
  if (!(S > 0)) return null;
  const uw = (u.r - u.l) / S, uh = (u.b - u.t) / S;
  const det = c * c - s * s;
  let cw = uw, ch = uh;
  if (Math.abs(det) > 0.2) {
    cw = (c * uw - s * uh) / det;
    ch = (c * uh - s * uw) / det;
    if (!(cw > 0) || !(ch > 0)) { cw = uw; ch = uh; }
  }
  // Center point: screen offset relative to wrapper layer bounding box center, counter-rotated,
  // divided by scale, then shifted back to local coordinates
  const dx = (u.l + u.r) / 2 - (sr.left + sr.right) / 2;
  const dy = (u.t + u.b) / 2 - (sr.top + sr.bottom) / 2;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const cx = (cos * dx + sin * dy) / S + w / 2;
  const cy = (-sin * dx + cos * dy) / S + h / 2;
  const left = Math.max(0, cx - cw / 2), top = Math.max(0, cy - ch / 2);
  const right = Math.min(w, cx + cw / 2), bottom = Math.min(h, cy + ch / 2);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return { l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) };
}

/**
 * Scrub animations in the stage from start to finish, measuring the bounding box at each step
 * to take their union: the maximum extent occupied by the motion graphics across the whole segment.
 *
 * Scrub synchronously via Web Animations currentTime without relying on requestAnimationFrame:
 * it can still be measured when the window is in the background and animations are throttled
 * by the browser, and produces results in a single call without actually waiting for playback
 * to finish. Non-scrubbable parts (such as Lottie driven by t, typewriters) are calculated based
 * on the current frame. After measuring, scrub animations back to 0.
 */
export function measureAcrossTime(stage: HTMLElement, totalMs: number, stepMs = 100): Box | null {
  const anims = stage.getAnimations({ subtree: true });
  const seek = (t: number) => {
    for (const a of anims) {
      try {
        a.pause();
        a.currentTime = t;
      } catch {
        // Animations that are already finished / read-only cannot be modified; skip
      }
    }
  };
  let union: Box | null = null;
  // Canvas pixels are read only once in this pass: scrubbing animations does not cause the canvas
  // to repaint (see canvasPixels); each step only re-fetches element rectangles
  const canvasCache = new Map<HTMLCanvasElement, CanvasPixels | null>();
  for (let t = 0; t <= totalMs; t += stepMs) {
    seek(t);
    union = unionBox(union, measureContentBox(stage, canvasCache));
  }
  seek(0);
  return union;
}
