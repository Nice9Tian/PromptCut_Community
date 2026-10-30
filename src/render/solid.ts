/**
 * 实体几何:命中测试、实体范围、片段矩形 —— 舞台页(?stage=1)、导出页(?export=1)和
 * 预渲染页上的快照 DOM(`#pc-frame-snapshot [data-pc-scene]`)三处同一份代码。
 *
 * **根容器是入参,所有查询都从根出发**:预渲染页上 `#root` 只是 `display:none`、没有移出 DOM,
 * 全文档查询会先命中它的 0×0 节点;导出页一屏有多个 Stage 根(每个片段一个),
 * 按类名做全文档选择也不成立。根就是带 `data-pc-scene` 的那个 relative div。
 *
 * 坐标:除 `canvasPaintedBox` 外都返回**舞台坐标**(相对根的左上角、按根的布局像素);
 * `canvasPaintedBox` 返回**画布像素坐标**(生成快照时写进 `data-pc-painted-box` 用,
 * 同一份共享快照挂到不同位置和框的片段上时各自按 `<img>` 的实际框换算)。
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

/** 根:带 `data-pc-scene` 的场景 div */
export type SceneRoot = Element;

/** 舞台左上角在文档里的位置,把元素外框换算成舞台坐标 */
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
  // rgba(0,0,0,0) / transparent 都算没画;其余只要 alpha > 0 就算画了
  if (!v || v === "transparent") return false;
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (!m) return true; // 关键字色、color() 等,当作画了
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  return parts.length < 4 || parseFloat(parts[3]) > 0;
};

/** 生成的快照里 canvas 换成的 `<img>` 带的 `data-pc-painted-box="x,y,w,h"`(画布像素坐标) */
export function paintedBoxAttr(el: Element): PaintedBox | null {
  const raw = el.getAttribute("data-pc-painted-box");
  if (!raw) return null;
  const n = raw.split(",").map((v) => Number(v));
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return null;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

/**
 * 把画布像素坐标的实体框换算成屏幕矩形:按元素当前外框和它的 width / height 属性之比。
 * 卡片里的 canvas 无人设 object-fit,默认 fill 下比例成立;canvas 换成的 `<img>` 同理。
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
 * 画布里真正画了东西的那块,**画布像素坐标**,已按取样步长外扩一格并夹回 0..w / 0..h。
 * 生成快照(snapshot/rasterizeCanvas)把它写成 `data-pc-painted-box`;null = 整块空白或读不到像素。
 * 不做视口换算 —— 现有 `canvasBox` 返回的是视口 DOMRect,写进属性会让快照绑死在预渲染时的位置。
 */
export function canvasPaintedBox(el: HTMLCanvasElement, px: CanvasPixels | null = canvasPixels(el)): PaintedBox | null {
  if (!px) return null;
  const { l, t, r, b, step, w, h } = px;
  const x0 = Math.max(0, l - step), y0 = Math.max(0, t - step);
  const x1 = Math.min(w, r + step), y1 = Math.min(h, b + step);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 这个元素在这一点上算不算「实体」。
 * 实体 = 用户看得见、点下去合理的东西:文字、图片 / 视频 / 画布 / SVG 图形,
 * 或者自己画了底色、背景图、描边、阴影的盒子。只做布局用的透明容器不算——
 * 卡片的包裹层是整屏的,不穿过它就永远点不到下面那张卡;场景根同理。
 * 没有 `src` 也没有背景图的 IMG / VIDEO(快照里剥掉了 src 的素材层占位)不算实体。
 */
export function isSolid(el: Element, root: SceneRoot): boolean {
  if (el === document.documentElement || el === document.body || el === root) return false;
  if (el.hasAttribute("data-pc-scene") || el.hasAttribute("data-pc-clip")) return false;
  // 占位平面不是卡片画的东西:实体范围 / 像素扫描不算它(命中测试在 `hitTest` 里单独认它)
  if (isPlaceholderNode(el)) return false;
  const cs = getComputedStyle(el);
  /*
   * 只看画没画,不看 pointer-events:粒子卡的 canvas(tsParticles 设了 pointer-events:none)照样是画了东西的实体,
   * 实体范围 / contentBox 必须算上它,否则粒子卡的框永远退回整块画布。命中测试那边不受影响:
   * elementsFromPoint 本来就跳过 pointer-events:none 的元素。
   */
  if (cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
  if (el.tagName === "IMG" || el.tagName === "VIDEO") {
    const hasSrc = !!(el.getAttribute("src") || (el as HTMLImageElement).currentSrc);
    const hasBg = !!cs.backgroundImage && cs.backgroundImage !== "none";
    return hasSrc || hasBg;
  }
  if (REPLACED.has(el.tagName)) return true;
  // 直接持有非空白文本节点 → 是文字本身
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

/** 实体元素自己的外框(屏幕坐标):canvas 可选扫像素,快照里的 `<img>` 用它带的实体框 */
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
 * 实体命中测试:舞台坐标 (x, y) 处,从最上层往下找第一个「画了东西」的元素——
 * 透明的容器一律穿过去。返回它属于哪个片段,以及那个实体元素自己的外框;什么都没点到返回 null。
 */
export function hitTest(root: SceneRoot, x: number, y: number): StageHit | null {
  const origin = stageOrigin(root);
  if (!origin) return null;
  // elementsFromPoint 按绘制顺序从最上层往下给;透明容器一路穿过去
  const stack = document.elementsFromPoint(x + origin.left, y + origin.top);
  for (const el of stack) {
    if (!root.contains(el)) continue;
    /*
     * 组流(R8 / G1):盖在上面的 `[data-pc-group-plane]` 是 `pointer-events: none`,不在这一摞里;
     * 组内被抑制的卡子树藏着、自己没有流平面 —— 点到它的包裹层框就算点中它(退回包裹层框),
     * 不能穿透到背后别的图层去。
     */
    if (el.hasAttribute("data-pc-stream-member") && el.classList.contains("pc-suppressed")) {
      const clipId = el.getAttribute("data-pc-clip");
      if (clipId) return { clipId, ...toStage(el.getBoundingClientRect(), origin) };
    }
    /*
     * 占位符(product/rendering.md「兜底顺序」):点中它就算点中它所在的那张卡 —— 那张卡此刻正在加载,
     * 用户点的就是它;框取占位组件根元素的框。托着它的透明槽位(铺满包裹层)不算,照常穿过去。
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

/** 根下某片段的包裹层(同一 clipId 可能有多个:导出页每个片段一个 Stage,取第一个) */
export function clipWrapper(root: SceneRoot, clipId: string): Element | null {
  return root.querySelector(`[data-pc-clip="${CSS.escape(clipId)}"]`);
}

/**
 * 片段的实体范围:它所有实体元素外框的并集(舞台坐标,夹回舞台内)。
 * 给选中描边和 get_layout 的 contentBox 用 —— 字幕卡包裹层占满整屏,描边要贴着字幕本身。
 * `scanCanvas`:要不要读 canvas 像素(一张 1080p 画布十几毫秒,心跳里只对选中的卡开)。
 * 一个实体都没有(纯透明卡)退回包裹层外框,至少还能选中。
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
    // 组流平面(R8)落在舞台根下、不在任何包裹层里,不参与 `bounds` / `rects`;列在这里是兜底
    if (el.hasAttribute("data-pc-group-plane")) return;
    // 占位平面不参与实体范围(它的框本来就是按这张卡的实体框摆的,算进来只会自我循环)
    if (isPlaceholderNode(el)) return;
    if (el.hasAttribute("data-pc-proxy-plane") || el.hasAttribute("data-pc-snapshot-plane") || el.hasAttribute("data-pc-stream-plane")) {
      // 平面是贴上去的替身,它们的框就是内容框
      take(el.getBoundingClientRect());
      return;
    }
    if (isSolid(el, root)) {
      take(solidRect(el, opts.scanCanvas ?? true, opts.cache));
      return; // 实体元素的子孙都在它外框里,不用再往下
    }
    for (const c of el.children) walk(c);
  };
  for (const c of wrap.children) walk(c);
  const rc = Number.isFinite(l) ? new DOMRect(l, t, r - l, b - t) : wrap.getBoundingClientRect();
  // 夹回舞台内:文字动画常把元素甩到屏幕外,描边不该跟着跑出去
  const cl = Math.max(rc.left, origin.left), ct = Math.max(rc.top, origin.top);
  const cr = Math.min(rc.right, origin.right), cb = Math.min(rc.bottom, origin.bottom);
  if (cr <= cl || cb <= ct) return toStage(wrap.getBoundingClientRect(), origin);
  return toStage(new DOMRect(cl, ct, cr - cl, cb - ct), origin);
}

/** 活跃片段的包裹层外框(舞台坐标),按 clipId 去重 */
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
  /** 包裹层外框 */
  rect: StageRect;
  /** 实体范围;量不到时为 null */
  bounds: StageRect | null;
}

export interface RectsWithBoundsOptions {
  /**
   * 哪些片段的 canvas 要读像素:'none' 都不读(用 `data-pc-painted-box` 或元素矩形),
   * 'selected' 只读 `clipIds` 里的(心跳:选中描边不回退到整块画布),'all' 全读(用户点击那一次)。
   */
  pixels: "none" | "selected" | "all";
  /** 'selected' 时是选中集;'all' / 'none' 时若给了就只返回这些片段 */
  clipIds?: string[];
}

/**
 * 一次往返给全部活跃片段的包裹层外框 + 实体范围(合并 Preview 里 rects() 后逐个 bounds() 的 N+1)。
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

/** 导出页 / 预渲染快照页给 puppeteer 侧 `page.evaluate` 用的导出面(页面内部不经它) */
export const solidApi = { isSolid, bounds, rects, hitTest, stageOrigin, canvasBox, canvasPaintedBox, rectsWithBounds };
export type SolidApi = typeof solidApi;
