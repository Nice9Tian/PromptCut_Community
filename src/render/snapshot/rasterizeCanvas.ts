/**
 * 生成快照的第三步:**画布栅格化**(任务书 3.8)。
 *
 * 克隆出来的 `<canvas>` 是空的 —— 粒子和三维画面会整个消失。所以读像素、压成图片、
 * 把 canvas 换成同尺寸的 `<img>`,并写上实体框。瓶颈是**画布面积和编码器**:
 * `rasterMs` 高就是画布太大。读不出来(被污染、WebGL 没开 `preserveDrawingBuffer`)
 * 就留空画布,由返回值里的 `lossy` 计数。
 *
 * 本文件**不 import `inlineStyles`**(任务书 3.8 点名的约束):换上来的 `<img>` 要按
 * **IMG 的基线**另算一份差异样式串(IMG 独有的 `overflow: clip` / 替换元素默认尺寸规则
 * 和 CANVAS 不一样,复用 CANVAS 的串会漏属性),那个串由调用方(`createSnapshot.ts`)
 * 经 `styleOf` 回调给进来。
 *
 * 位图**现在还是 PNG `toDataURL()`**;换 webp / 改成异步 `convertToBlob` 是以后的事,
 * 只动本文件(3.8「给以后留的口子」)。共享 WebGL 渲染器落地后,画布卡的像素来自
 * Worker 交回的位图,要改的也只有本文件。
 */

import { canvasPaintedBox } from "../solid";

export interface RasterizeResult {
  /** 读不出像素、只能留空画布的 canvas 数 */
  lossy: number;
}

/**
 * 把克隆体里的 `<canvas>` 换成 `<img>`。
 *
 * @param orig  live 元素数组
 * @param copy  和 `orig` 一一对应的克隆体元素数组(就地改写)
 * @param styleOf  给某个 live 元素按 IMG 的基线算样式串(含 `animation:none` 那一条)
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
     * gl 平面(R9 M4):位图来自共享渲染器、`bitmaprenderer` 上下文,`toDataURL` 总能读出 ——
     * **可空画布照样成功**(下面 `src.length > 22` 也拦不住)。所以按帧号核对:`glHost` 每次贴上位图
     * 写 `data-pc-gl-frame`,和包裹层的 `data-pc-local-frame` 同一个算式;没有、或对不上,
     * 就是这一帧的位图还没贴上(或贴的是别的帧),记 `lossy`,`bake.mjs` 的 `if (lossy) throw` 才拦得住空图。
     * 直接比字符串,不需要 fps。
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
     * A2(4):实体框写成 data-pc-painted-box="x,y,w,h",**画布像素坐标**(已按取样步长外扩一格、夹回画布内),
     * 不是视口坐标 —— 同一份共享快照会挂到不同位置、不同框的片段上,消费方按 <img> 当前的外框和
     * width / height 属性之比换算(solid.ts 的 paintedBoxRect)。直接 import solid.ts 算,不经 window.__pcCanvasBox。
     * 扫像素读不出来(整块空白 / 污染)就不写属性,消费方退回元素矩形。
     */
    const painted = canvasPaintedBox(canvas);
    if (painted) img.setAttribute("data-pc-painted-box", [painted.x, painted.y, painted.w, painted.h].map((v) => String(Math.round(v))).join(","));
    img.src = src;
    copy[i].replaceWith(img);
  }
  return { lossy };
}
