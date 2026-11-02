/**
 * Entity geometry: hit testing, entity bounds, clip rectangles: same code across stage page
 * (?stage=1), export page (?export=1), and snapshot DOM (`#pc-frame-snapshot [data-pc-scene]`) on
 * prerender page.
 *
 * **Root container is an input parameter, all queries start from the root**: on prerender page,
 * `#root` is merely `display:none` and not removed from DOM; whole-document queries first hit its
 * 0×0 node; export page has multiple Stage roots per screen (one per clip), so selecting across
 * the whole document by class name is also invalid. Root is that relative div with `data-pc-scene`.
 *
 * Coordinates: except for `canvasPaintedBox`, all return **stage coordinates** (relative to root's
 * top-left corner, in root layout pixels); `canvasPaintedBox` returns **canvas pixel coordinates**
 * (written into `data-pc-painted-box` when generating snapshots, converted by `<img>` actual box
 * when same shared snapshot is mounted on clips at different positions and boxes).
 */
import { canvasBox, canvasPixels, type CanvasPixels } from "./contentBox";
import { isPlaceholderNode } from "./placeholderHost.ts";
import { PLACEHOLDER_ATTR } from "./placeholder/contract.ts";

export { canvasBox };

export interface StageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface StageHit extends StageRect {
  clipId: string;
}
export interface PaintedBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Root: scene div with `data-pc-scene` */
export type SceneRoot = Element;

/** Position of stage top-left corner in document, converting element bounding box to stage coordinates */
export function stageOrigin(root: SceneRoot): DOMRect | null {
  const r = root.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

const toStage = (r: DOMRect, origin: DOMRect): StageRect => ({
  left: r.left - origin.left,
  top: r.top - origin.top,
  width: r.width,
  height: r.height,
});

const REPLACED = new Set(["IMG", "VIDEO", "CANVAS", "svg", "path", "rect", "circle", "ellipse", "line", "polygon", "polyline", "text", "use"]);

const paintedColor = (v: string) => {
  // Both rgba(0,0,0,0) / transparent count as unpainted; anything else counts as painted as long as
  // alpha > 0
  if (!v || v === "transparent") return false;
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (!m) return true; // Named colors, color(), etc., are treated as painted
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  return parts.length < 4 || parseFloat(parts[3]) > 0;
};

/**
 * `data-pc-painted-box="x,y,w,h"` (canvas pixel coordinates) carried by `<img>` that replaced
 * canvas in generated snapshots.
 */
export function paintedBoxAttr(el: Element): PaintedBox | null {
  const raw = el.getAttribute("data-pc-painted-box");
  if (!raw) return null;
  const n = raw.split(",").map((v) => Number(v));
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return null;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

/**
 * Convert entity box in canvas pixel coordinates to screen rectangle: based on ratio between
 * element's current bounding box and its width / height attributes. No one sets object-fit on
 * canvas in cards, so ratio holds under default fill; same applies to `<img>` replacing canvas.
 */
export function paintedBoxRect(el: Element, box: PaintedBox): DOMRect | null {
  const rect = el.getBoundingClientRect();
  const w = Number(el.getAttribute("width")) || (el as HTMLImageElement).naturalWidth || rect.width;
  const h = Number(el.getAttribute("height")) || (el as HTMLImageElement).naturalHeight || rect.height;
  if (!(w > 0) || !(h > 0) || !(rect.width > 0) || !(rect.height > 0)) return null;
  const sx = rect.width / w, sy = rect.height / h;
  return new DOMRect(rect.left + box.x * sx, rect.top + box.y * sy, box.w * sx, box.h * sy);
}

/**
 * Region in canvas where things are actually painted, in **canvas pixel coordinates**, expanded by
 * one cell according to sampling step and clamped back to 0..w / 0..h. Generating snapshots
 * (snapshot/rasterizeCanvas) writes it as `data-pc-painted-box`; null = entirely blank or unable to
 * read pixels. No viewport conversion: existing `canvasBox` returns viewport DOMRect, and writing
 * into attributes would bind snapshot to its position at prerender time.
 */
export function canvasPaintedBox(el: HTMLCanvasElement, px: CanvasPixels | null = canvasPixels(el)): PaintedBox | null {
  if (!px) return null;
  const { l, t, r, b, step, w, h } = px;
  const x0 = Math.max(0, l - step), y0 = Math.max(0, t - step);
  const x1 = Math.min(w, r + step), y1 = Math.min(h, b + step);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Whether this element counts as an "entity" at this point.
 * Entity = things visible to users and reasonable to click: text, image / video / canvas / SVG
 * graphics, or boxes that painted their own background color, background image, border, or shadow.
 * Transparent containers used only for layout do not count: card's wrapper layer is full-screen,
 * and without passing through it, cards underneath could never be clicked; same for scene root.
 * IMG / VIDEO without `src` or background image (media layer placeholder with src stripped in
 * snapshot) does not count as an entity.
 */
export function isSolid(el: Element, root: SceneRoot): boolean {
  if (el === document.documentElement || el === document.body || el === root) return false;
  if (el.hasAttribute("data-pc-scene") || el.hasAttribute("data-pc-clip")) return false;
  // Placeholder planes are not drawn by cards: entity bounds / pixel scanning do not count them
  // (hit testing recognizes them separately in `hitTest`)
  if (isPlaceholderNode(el)) return false;
  const cs = getComputedStyle(el);
  /*
   * Only check whether something was drawn, ignoring pointer-events: particle card canvases
   * (tsParticles sets pointer-events:none) are still entities with painted content; entity bounds /
   * contentBox must include them, otherwise the particle card box always falls back to the full
   * canvas. Hit testing is unaffected: elementsFromPoint already skips pointer-events:none elements.
   */
  if (cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
  if (el.tagName === "IMG" || el.tagName === "VIDEO") {
    const hasSrc = !!(el.getAttribute("src") || (el as HTMLImageElement).currentSrc);
    const hasBg = !!cs.backgroundImage && cs.backgroundImage !== "none";
    return hasSrc || hasBg;
  }
  if (REPLACED.has(el.tagName)) return true;
  // Directly holds non-whitespace text nodes → is the text itself
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim()) return true;
  }
  if (paintedColor(cs.backgroundColor)) return true;
  if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
  if (cs.boxShadow && cs.boxShadow !== "none") return true;
  const bw = ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"] as const;
  const bc = ["borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"] as const;
  for (let i = 0; i < 4; i++) {
    if (parseFloat(cs[bw[i]]) > 0 && paintedColor(cs[bc[i]])) return true;
  }
  return false;
}

/**
 * The entity element's own bounding box (screen coordinates): canvas can optionally scan pixels,
 * and `<img>` in snapshots uses the entity box it carries.
 */
function solidRect(el: Element, scanCanvas: boolean, cache?: Map<HTMLCanvasElement, CanvasPixels | null>): DOMRect {
  if (el.tagName === "CANVAS" && scanCanvas) {
    const cv = el as HTMLCanvasElement;
    let px = cache?.get(cv);
    if (px === undefined) {
      px = canvasPixels(cv);
      cache?.set(cv, px);
    }
    const painted = px ? canvasPaintedBox(cv, px) : null;
    const rc = painted ? paintedBoxRect(cv, painted) : null;
    if (rc) return rc;
  }
  if (el.tagName === "IMG") {
    const box = paintedBoxAttr(el);
    const rc = box ? paintedBoxRect(el, box) : null;
    if (rc) return rc;
  }
  return el.getBoundingClientRect();
}

/**
 * Entity hit test: at stage coordinates (x, y), finds the first element from top to bottom
 * with "painted content": transparent containers are passed right through. Returns which clip
 * it belongs to and that entity element's own bounding box; returns null if nothing was hit.
 */
export function hitTest(root: SceneRoot, x: number, y: number): StageHit | null {
  const origin = stageOrigin(root);
  if (!origin) return null;
  // elementsFromPoint returns elements from top to bottom in draw order; transparent containers
  // are passed right through
  const stack = document.elementsFromPoint(x + origin.left, y + origin.top);
  for (const el of stack) {
    if (!root.contains(el)) continue;
    /*
     * Group stream (R8 / G1): the `[data-pc-group-plane]` covering the top has `pointer-events: none`
     * and is not in this stack; card subtrees suppressed inside the group are hidden and have no
     * stream plane of their own: clicking its wrapper layer box counts as hitting it (falling back
     * to the wrapper layer box), and cannot penetrate through to other layers behind it.
     */
    if (el.hasAttribute("data-pc-stream-member") && el.classList.contains("pc-suppressed")) {
      const clipId = el.getAttribute("data-pc-clip");
      if (clipId) return { clipId, ...toStage(el.getBoundingClientRect(), origin) };
    }
    /*
     * Placeholder (product/rendering.md "Fallback order"): clicking it counts as hitting the card where
     * it belongs: that card is currently loading, which is what the user clicked; the box uses the
     * bounding box of the placeholder component's root element. The transparent slot holding it
     * (filling the wrapper layer) does not count and is passed through as usual.
     */
    const ph = el.closest(`[${PLACEHOLDER_ATTR}]`);
    if (ph) {
      const clipId = ph.closest("[data-pc-clip]")?.getAttribute("data-pc-clip");
      if (clipId) return { clipId, ...toStage(ph.getBoundingClientRect(), origin) };
      continue;
    }
    if (isPlaceholderNode(el)) continue;
    if (!isSolid(el, root)) continue;
    const wrap = el.closest("[data-pc-clip]");
    const clipId = wrap?.getAttribute("data-pc-clip");
    if (!clipId) continue;
    return { clipId, ...toStage(el.getBoundingClientRect(), origin) };
  }
  return null;
}

/**
 * Wrapper layer of a clip under root (multiple may exist for the same clipId: export page has one
 * Stage per clip, take the first).
 */
export function clipWrapper(root: SceneRoot, clipId: string): Element | null {
  return root.querySelector(`[data-pc-clip="${CSS.escape(clipId)}"]`);
}

/**
 * Clip entity bounds: union of the bounding boxes of all its entity elements (stage coordinates,
 * clamped back inside the stage). Used for selection outlines and get_layout contentBox: caption
 * card wrapper layers fill the entire screen, and the outline must hug the captions themselves.
 * `scanCanvas`: whether to read canvas pixels (a 1080p canvas takes tens of milliseconds, enabled
 * only for selected cards during heartbeat). If there are no entities at all (purely transparent
 * card), falls back to the wrapper layer bounding box so it can at least still be selected.
 */
export function bounds(root: SceneRoot, clipId: string, opts: { scanCanvas?: boolean; cache?: Map<HTMLCanvasElement, CanvasPixels | null> } = {}): StageRect | null {
  const origin = stageOrigin(root);
  if (!origin) return null;
  const wrap = clipWrapper(root, clipId);
  if (!wrap) return null;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  const take = (rc: DOMRect) => {
    if (rc.width > 0 && rc.height > 0) {
      l = Math.min(l, rc.left); t = Math.min(t, rc.top);
      r = Math.max(r, rc.right); b = Math.max(b, rc.bottom);
    }
  };
  const walk = (el: Element) => {
    // Group stream planes (R8) sit under the stage root and not in any wrapper layer, not participating
    // in `bounds` / `rects`; listed here as a fallback
    if (el.hasAttribute("data-pc-group-plane")) return;
    // Placeholder planes do not participate in entity bounds (their box is already positioned based on
    // this card's entity box; including them would only cause a self-referential loop)
    if (isPlaceholderNode(el)) return;
    if (el.hasAttribute("data-pc-proxy-plane") || el.hasAttribute("data-pc-snapshot-plane") || el.hasAttribute("data-pc-stream-plane")) {
      // Planes are pasted stand-ins; their boxes are the content boxes
      take(el.getBoundingClientRect());
      return;
    }
    if (isSolid(el, root)) {
      take(solidRect(el, opts.scanCanvas ?? true, opts.cache));
      return; // Descendants of an entity element are all within its bounding box, no need to go further down
    }
    for (const c of el.children) walk(c);
  };
  for (const c of wrap.children) walk(c);
  const rc = Number.isFinite(l) ? new DOMRect(l, t, r - l, b - t) : wrap.getBoundingClientRect();
  // Clamp back inside the stage: text animations often throw elements offscreen; outlines should not
  // follow them outside
  const cl = Math.max(rc.left, origin.left), ct = Math.max(rc.top, origin.top);
  const cr = Math.min(rc.right, origin.right), cb = Math.min(rc.bottom, origin.bottom);
  if (cr <= cl || cb <= ct) return toStage(wrap.getBoundingClientRect(), origin);
  return toStage(new DOMRect(cl, ct, cr - cl, cb - ct), origin);
}

/** Wrapper layer bounding boxes of active clips (stage coordinates), deduplicated by clipId */
export function rects(root: SceneRoot): { clipId: string; left: number; top: number; width: number; height: number }[] {
  const origin = stageOrigin(root);
  if (!origin) return [];
  const result: { clipId: string; left: number; top: number; width: number; height: number }[] = [];
  const seen = new Set<string>();
  for (const el of root.querySelectorAll("[data-pc-clip]")) {
    const clipId = el.getAttribute("data-pc-clip");
    if (!clipId || seen.has(clipId)) continue;
    seen.add(clipId);
    result.push({ clipId, ...toStage(el.getBoundingClientRect(), origin) });
  }
  return result;
}

export interface RectWithBounds {
  clipId: string;
  /** Wrapper layer bounding box */
  rect: StageRect;
  /** Entity bounds; null when unmeasurable */
  bounds: StageRect | null;
}

export interface RectsWithBoundsOptions {
  /**
   * Which clips have their canvas read for pixels: 'none' reads none (uses `data-pc-painted-box` or
   * element rectangles), 'selected' reads only those in `clipIds` (heartbeat: selection outline does
   * not fall back to the full canvas), 'all' reads all (that single user click).
   */
  pixels: "none" | "selected" | "all";
  /** Selected set when 'selected'; if provided for 'all' / 'none', returns only these clips */
  clipIds?: string[];
}

/**
 * Returns wrapper layer bounding boxes + entity bounds for all active clips in a single round-trip
 * (merging the N+1 of calling rects() then bounds() individually in Preview).
 */
export function rectsWithBounds(root: SceneRoot, opts: RectsWithBoundsOptions = { pixels: "none" }): RectWithBounds[] {
  const wanted = opts.clipIds ? new Set(opts.clipIds) : null;
  const cache = new Map<HTMLCanvasElement, CanvasPixels | null>();
  const list = rects(root);
  const out: RectWithBounds[] = [];
  for (const r of list) {
    if (wanted && opts.pixels !== "selected" && !wanted.has(r.clipId)) continue;
    const scan = opts.pixels === "all" || (opts.pixels === "selected" && !!wanted?.has(r.clipId));
    out.push({ clipId: r.clipId, rect: r, bounds: bounds(root, r.clipId, { scanCanvas: scan, cache }) });
  }
  return out;
}

/**
 * Export surface for puppeteer-side `page.evaluate` on export and prerender snapshot pages
 * (not used internally by the page).
 */
export const solidApi = { isSolid, bounds, rects, hitTest, stageOrigin, canvasBox, canvasPaintedBox, rectsWithBounds };
export type SolidApi = typeof solidApi;
