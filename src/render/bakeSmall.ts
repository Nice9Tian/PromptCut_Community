/**
 * 纯浏览器节点的预渲染小尺寸(M7 契约第 4.4 节,D5 选项 a):后台舞台把这一帧的 HTML 快照包进 SVG `foreignObject`,
 * 以 `data:` 地址画上画布,出 WebP(质量 80)。原尺寸 HTML 不变。
 *
 * 尺寸与桌面 `server/bakery/small-bitmap.mjs` 同一套(单测对拍):缩放比 `s = min(1, 800 / 项目宽, 600 / 项目高)`,
 * 画的是包裹层的框(片段框 w×h,没设框就是整个舞台)里的内容,像素尺寸向下取整、至少 1。快照挂法也照桌面:
 * 框大小的盒子整体 `scale(s)`、快照平面 `inset: 0`、清掉脚本与事件属性(快照是数据,不是能执行的页面)。
 *
 * **必须内嵌页面的全局样式表**(Tailwind 的基础层等):快照的样式内联只写「与同标签基线不同」的值,基线靠重放页的全局样式;
 * SVG 图是独立文档,不带就退回浏览器缺省值(`box-sizing` 成了 `content-box`,药丸胖一圈,探针 P3)。带上之后内置卡与桌面
 * CDP 截的小位图差 ≤ 0.9% 像素(文字抗锯齿与模糊边缘)。SVG 图里取不到外部资源,外部字体会退回系统字体 —— 内置卡只用系统字体,
 * 这一条只影响用户卡(用户卡不进浏览器)。Chrome 实测 `data:` 地址的 foreignObject 图不污染画布(探针 P3、`frameCompositor.ts`)。
 *
 * # 原尺寸的一块像素(`renderSnapshotBitmap`,`docs/plan/browser-stream-task.md` 第三处)
 *
 * 浏览器节点产轨道流要每一帧的像素。同一条路:快照包进 SVG、内嵌页面样式表、画上画布,只是**不缩放**,把包裹层坐标里的一个矩形
 * (轨道流的 `bound`:框外留了一圈给阴影、描边,所以 x、y 可以为负)平移到画布左上角,交出带透明的位图。
 * 这样产出的流画在包裹层自己的坐标系里,与桌面单卡流(`server/frame-stream.mjs` 的 `plane: 'local'`)同一个口径。
 *
 * 本模块属于 render 这一层;只在舞台页里用(要 DOM 与画布)。换算部分是纯函数,Node 单测直接载。
 */

export const SMALL_MAX_WIDTH = 800;
export const SMALL_MAX_HEIGHT = 600;
/** WebP 质量(c10a 契约第 9 节;画布 API 的质量取 0～1) */
export const SMALL_WEBP_QUALITY = 0.8;

/** 项目画幅 → 缩放比(不放大;同 `small-bitmap.mjs` 的 `smallScale`) */
export function smallScale(projectWidth: number, projectHeight: number): number {
  const w = Number(projectWidth), h = Number(projectHeight);
  if (!(w > 0) || !(h > 0)) return 1;
  return Math.min(1, SMALL_MAX_WIDTH / w, SMALL_MAX_HEIGHT / h);
}

/** 一个框按项目的缩放比缩下来的像素尺寸(同 `small-bitmap.mjs` 的 `smallSize`) */
export function smallSize({ projectWidth, projectHeight, boxWidth = projectWidth, boxHeight = projectHeight }: {
  projectWidth: number; projectHeight: number; boxWidth?: number; boxHeight?: number;
}): { scale: number; width: number; height: number } {
  const scale = smallScale(projectWidth, projectHeight);
  const px = (v: number) => Math.max(1, Math.floor(Number(v) * scale + 1e-9));
  return { scale, width: px(boxWidth), height: px(boxHeight) };
}

const XHTML = "http://www.w3.org/1999/xhtml";

/** 快照 HTML 清洗后的节点(与桌面 `small-bitmap.mjs`、`capture-snapshot.mjs` 同一道清洗) */
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

/** 这个文档的样式表全文(读得到规则的那些;跨源的读不到就跳过) */
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
 * 这一帧的 SVG(foreignObject 里:页面样式、框大小整体缩放的盒子、`inset: 0` 的快照平面)。`left` / `top` 是盒子在这张图里的位置
 * (小尺寸恒为 0;原尺寸取一块时是矩形左上角的相反数)。
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

/** 这一帧的小尺寸 SVG(盒子在左上角、整体缩放) */
export function smallSvg(doc: Document, o: { html: string; boxWidth: number; boxHeight: number; scale: number; width: number; height: number; css?: string }): string {
  return snapshotSvg(doc, o);
}

/** 要像素的矩形一边最长多少(只为挡坏数据:8K 画幅再外扩也到不了) */
export const PIXELS_MAX_SIDE = 8192;

/** 要像素的矩形:整数、宽高为偶数(4:2:0 取样)、不超过上限;不合格回 null */
export function pixelRect(rect: unknown): { x: number; y: number; w: number; h: number } | null {
  const r = rect as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
  if (!r || typeof r !== "object") return null;
  const x = r.x as number, y = r.y as number, w = r.w as number, h = r.h as number;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h)) return null;
  if (w < 2 || h < 2 || w % 2 || h % 2 || w > PIXELS_MAX_SIDE || h > PIXELS_MAX_SIDE) return null;
  if (Math.abs(x) > PIXELS_MAX_SIDE || Math.abs(y) > PIXELS_MAX_SIDE) return null;
  return { x, y, w, h };
}

/** 原尺寸取一块的 SVG:图的大小是矩形的大小,框大小的盒子不缩放、挪到 (-rect.x, -rect.y) */
export function pixelsSvg(doc: Document, { html, boxWidth, boxHeight, rect, css = "" }: {
  html: string; boxWidth: number; boxHeight: number; rect: { x: number; y: number; w: number; h: number }; css?: string;
}): string {
  return snapshotSvg(doc, { html, boxWidth, boxHeight, scale: 1, width: rect.w, height: rect.h, css, left: -rect.x, top: -rect.y });
}

let cssCache: { doc: Document; count: number; text: string } | null = null;
/** 样式表全文缓存一份(样式表数目变了才重读) */
function cachedCss(doc: Document): string {
  const count = doc.styleSheets.length;
  if (cssCache && cssCache.doc === doc && cssCache.count === count) return cssCache.text;
  cssCache = { doc, count, text: documentCss(doc) };
  return cssCache.text;
}

/**
 * 一帧 HTML 快照 → 小尺寸 WebP 字节。画布透明(带 alpha);浏览器出不了 WebP(`toBlob` 退回 PNG)时回 null。
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
 * 一帧 HTML 快照 → 原尺寸的一块位图(带透明)。`rect` 是包裹层坐标里的矩形(过 `pixelRect`);位图的大小就是矩形的大小。
 * 画不出来(SVG 解码失败、拿不到画布)抛错,调用方按这一帧没成处理。位图用完要 `close()`。
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
    if (!ctx) throw new Error("拿不到 2D 画布");
    ctx.clearRect(0, 0, rect.w, rect.h);
    ctx.drawImage(img, 0, 0, rect.w, rect.h);
    return canvas.transferToImageBitmap();
  }
  const canvas = doc.createElement("canvas");
  canvas.width = rect.w;
  canvas.height = rect.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("拿不到 2D 画布");
  ctx.clearRect(0, 0, rect.w, rect.h);
  ctx.drawImage(img, 0, 0, rect.w, rect.h);
  return await createImageBitmap(canvas);
}
