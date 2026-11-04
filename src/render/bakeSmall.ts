/**
 * Prerender small size for pure browser nodes (M7 contract section 4.4, D5 option a): the background
 * stage wraps this frame's HTML snapshot into an SVG `foreignObject`, draws it onto the canvas using
 * a `data:` URL, and outputs WebP (quality 80). The original-size HTML remains unchanged.
 *
 * Same dimensions as desktop `server/bakery/small-bitmap.mjs` (unit test cross-check): scale factor
 * `s = min(1, 800 / project width, 600 / project height)`, drawing the content inside the wrapper
 * layer box (clip box w×h; if no box is set, the entire stage), with pixel dimensions rounded down
 * to at least 1. Snapshot mounting also follows desktop: the box sized to the clip box has
 * `scale(s)` overall, the snapshot plane has `inset: 0`, and scripts and event attributes are stripped
 * (snapshots are data, not executable pages).
 *
 * **Must inline the page's global stylesheets** (Tailwind base layer, etc.): snapshot inline styles
 * only specify values "different from the baseline of the same tag", and the baseline relies on
 * the replay page's global styles; an SVG image is an independent document, and without them it
 * falls back to browser defaults (`box-sizing` becomes `content-box`, the pill becomes fatter, probe
 * P3). With them included, the difference between built-in cards and small bitmaps captured via
 * desktop CDP is ≤ 0.9% pixels (text antialiasing and blurred edges). External resources cannot be
 * fetched inside SVG images, so external fonts fall back to system fonts: built-in cards only use
 * system fonts, so this only affects user cards (user cards do not enter the browser). Chrome
 * testing confirms that foreignObject images with `data:` URLs do not taint the canvas (probe P3,
 * `frameCompositor.ts`).
 *
 * # A block of original-size pixels (`renderSnapshotBitmap`, section 3 of `docs/plan/browser-stream-task.md`)
 *
 * Browser nodes producing track streams require pixels for every frame. The same approach: wrap
 * the snapshot into an SVG, embed the page stylesheet, and draw onto the canvas, except **without
 * scaling**, translating a rectangle in wrapper layer coordinates (track stream `bound`: leaves extra
 * margin outside the box for shadows and strokes, so x and y can be negative) to the top-left of
 * the canvas to yield a bitmap with transparency. Streams produced this way are drawn in the wrapper
 * layer's own coordinate system, using the same standard as desktop single-card streams
 * (`plane: 'local'` in `server/frame-stream.mjs`).
 *
 * This module belongs to the render layer; used only in stage pages (requires DOM and canvas).
 * The conversion part is a pure function, loaded directly by Node unit tests.
 */

export const SMALL_MAX_WIDTH = 800;
export const SMALL_MAX_HEIGHT = 600;
/** WebP quality (c10a contract section 9; canvas API quality takes 0-1) */
export const SMALL_WEBP_QUALITY = 0.8;

/** Project aspect ratio → scale factor (no upscale; matches `smallScale` in `small-bitmap.mjs`) */
export function smallScale(projectWidth: number, projectHeight: number): number {
  const w = Number(projectWidth), h = Number(projectHeight);
  if (!(w > 0) || !(h > 0)) return 1;
  return Math.min(1, SMALL_MAX_WIDTH / w, SMALL_MAX_HEIGHT / h);
}

/** Pixel dimensions of a box scaled down by the project scale factor (matches `smallSize` in `small-bitmap.mjs`) */
export function smallSize({ projectWidth, projectHeight, boxWidth = projectWidth, boxHeight = projectHeight }: {
  projectWidth: number; projectHeight: number; boxWidth?: number; boxHeight?: number;
}): { scale: number; width: number; height: number } {
  const scale = smallScale(projectWidth, projectHeight);
  const px = (v: number) => Math.max(1, Math.floor(Number(v) * scale + 1e-9));
  return { scale, width: px(boxWidth), height: px(boxHeight) };
}

const XHTML = "http://www.w3.org/1999/xhtml";

/** Sanitized node from snapshot HTML (same sanitization pass as desktop `small-bitmap.mjs` and `capture-snapshot.mjs`) */
function sanitizedNodes(doc: Document, html: string): Node[] {
  const template = doc.createElement("template");
  template.innerHTML = String(html ?? "");
  template.content.querySelectorAll("script,iframe,object,embed,base,meta,link").forEach((el) => el.remove());
  for (const element of template.content.querySelectorAll("*")) {
    for (const attr of [...element.attributes]) {
      if (/^on/i.test(attr.name) || /^(?:javascript|vbscript):/i.test(attr.value.trim())) element.removeAttribute(attr.name);
    }
  }
  return [...template.content.childNodes];
}

/** Full text of stylesheets in this document (those whose rules are readable; skips unreadable cross-origin ones) */
export function documentCss(doc: Document): string {
  let out = "";
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of Array.from(rules)) out += r.cssText + "\n";
  }
  return out;
}

/**
 * SVG of this frame (inside foreignObject: page styles, box of the clip box size scaled overall,
 * snapshot plane with `inset: 0`). `left` / `top` is the position of the box in this image
 * (always 0 for small size; the negation of the rectangle top-left when cropping a block at
 * original size).
 */
function snapshotSvg(doc: Document, { html, boxWidth, boxHeight, scale, width, height, css = "", left = 0, top = 0 }: {
  html: string; boxWidth: number; boxHeight: number; scale: number; width: number; height: number; css?: string; left?: number; top?: number;
}): string {
  const ser = new XMLSerializer();
  let body = "";
  for (const n of sanitizedNodes(doc, html)) body += ser.serializeToString(n);
  const style = css ? `<style><![CDATA[${css.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]></style>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">`
    + `<div xmlns="${XHTML}" style="position:relative;width:${width}px;height:${height}px;overflow:hidden">${style}`
    + `<div style="position:absolute;left:${left ? `${left}px` : "0"};top:${top ? `${top}px` : "0"};width:${boxWidth}px;height:${boxHeight}px;transform:scale(${scale});transform-origin:0 0;isolation:isolate;overflow:visible">`
    + `<div style="position:absolute;inset:0">${body}</div></div></div></foreignObject></svg>`;
}

/** Small-size SVG for this frame (box at top-left, scaled overall) */
export function smallSvg(doc: Document, o: { html: string; boxWidth: number; boxHeight: number; scale: number; width: number; height: number; css?: string }): string {
  return snapshotSvg(doc, o);
}

/** Maximum length of a side of the rectangle requesting pixels (only to block bad data: even expanded 8K aspect ratio cannot reach this) */
export const PIXELS_MAX_SIDE = 8192;

/** Rectangle requesting pixels: integers, even width and height (4:2:0 sampling), within upper limit; returns null if invalid */
export function pixelRect(rect: unknown): { x: number; y: number; w: number; h: number } | null {
  const r = rect as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
  if (!r || typeof r !== "object") return null;
  const x = r.x as number, y = r.y as number, w = r.w as number, h = r.h as number;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h)) return null;
  if (w < 2 || h < 2 || w % 2 || h % 2 || w > PIXELS_MAX_SIDE || h > PIXELS_MAX_SIDE) return null;
  if (Math.abs(x) > PIXELS_MAX_SIDE || Math.abs(y) > PIXELS_MAX_SIDE) return null;
  return { x, y, w, h };
}

/** SVG for cropping a block at original size: image size is rectangle size, box of clip box size is unscaled and moved to (-rect.x, -rect.y) */
export function pixelsSvg(doc: Document, { html, boxWidth, boxHeight, rect, css = "" }: {
  html: string; boxWidth: number; boxHeight: number; rect: { x: number; y: number; w: number; h: number }; css?: string;
}): string {
  return snapshotSvg(doc, { html, boxWidth, boxHeight, scale: 1, width: rect.w, height: rect.h, css, left: -rect.x, top: -rect.y });
}

let cssCache: { doc: Document; count: number; text: string } | null = null;
/** Cached copy of full stylesheet text (reread only when the number of stylesheets changes) */
function cachedCss(doc: Document): string {
  const count = doc.styleSheets.length;
  if (cssCache && cssCache.doc === doc && cssCache.count === count) return cssCache.text;
  cssCache = { doc, count, text: documentCss(doc) };
  return cssCache.text;
}

/**
 * Single-frame HTML snapshot → small-size WebP bytes. Canvas is transparent (with alpha);
 * returns null when the browser cannot output WebP (`toBlob` falls back to PNG).
 */
export async function renderSmallWebp({ html, projectWidth, projectHeight, boxWidth = projectWidth, boxHeight = projectHeight, doc = document }: {
  html: string; projectWidth: number; projectHeight: number; boxWidth?: number; boxHeight?: number; doc?: Document;
}): Promise<ArrayBuffer | null> {
  const size = smallSize({ projectWidth, projectHeight, boxWidth, boxHeight });
  const svg = smallSvg(doc, { html, boxWidth, boxHeight, scale: size.scale, width: size.width, height: size.height, css: cachedCss(doc) });
  const img = new Image(size.width, size.height);
  img.decoding = "async";
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const canvas = doc.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.drawImage(img, 0, 0, size.width, size.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", SMALL_WEBP_QUALITY));
  if (!blob || blob.type !== "image/webp") return null;
  return await blob.arrayBuffer();
}

/**
 * Single-frame HTML snapshot → a block of original-size bitmap (with transparency). `rect` is
 * the rectangle in wrapper layer coordinates (passed through `pixelRect`); bitmap size is the
 * rectangle size. Throws on draw failure (SVG decode failed, unable to get canvas); caller handles
 * as frame failure. Close bitmap via `close()` after use.
 */
export async function renderSnapshotBitmap({ html, boxWidth, boxHeight, rect, doc = document }: {
  html: string; boxWidth: number; boxHeight: number; rect: { x: number; y: number; w: number; h: number }; doc?: Document;
}): Promise<ImageBitmap> {
  const svg = pixelsSvg(doc, { html, boxWidth, boxHeight, rect, css: cachedCss(doc) });
  const img = new Image(rect.w, rect.h);
  img.decoding = "async";
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const Offscreen = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas }).OffscreenCanvas;
  if (Offscreen) {
    const canvas = new Offscreen(rect.w, rect.h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Cannot get a 2D canvas");
    ctx.clearRect(0, 0, rect.w, rect.h);
    ctx.drawImage(img, 0, 0, rect.w, rect.h);
    return canvas.transferToImageBitmap();
  }
  const canvas = doc.createElement("canvas");
  canvas.width = rect.w;
  canvas.height = rect.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot get a 2D canvas");
  ctx.clearRect(0, 0, rect.w, rect.h);
  ctx.drawImage(img, 0, 0, rect.w, rect.h);
  return await createImageBitmap(canvas);
}
