/**
 * 画布直取(渲染重构「己一」,`docs/plan/prerender-products-contract.md` 第 6.1、6.2 节)—— 页面一侧。
 *
 * 画布与 WebGL 的卡产轨道流时,预渲染进程不截图,直接问页面要「这张卡的画布此刻的像素」:
 * 页面把包裹层里唯一的那张 `<canvas>` 按它在舞台上的位置画进一张和截图矩形一样大的草稿画布,
 * 读出 straight RGBA(和截图出来的 PNG 同一种口径),交给 Node(`server/bakery/capture-canvas.mjs`)。
 * 只由导出页挂成 `window.__pcGrabCanvas`(`src/ExportView.tsx`),别处不用。
 *
 * # 画布怎么认
 *
 * 包裹层(`[data-pc-clip="<片段 id>"]`)里**唯一**的 `<canvas>`;一张都没有或不止一张就不取。
 * 共享 WebGL 渲染器的平面(`[data-pc-gl-plane]`)取之前照 `snapshot/rasterizeCanvas.ts` 的办法核帧号:
 * `data-pc-gl-frame` 必须等于包裹层的 `data-pc-local-frame`,对不上就是这一帧的位图还没贴上(或贴的是别的帧),
 * 回 `gl-frame`,**不交出空图**。
 *
 * 这里不判「卡片的画面是不是全在画布里」(画布外面还有别的元素、祖先带不透明度或滤镜、像素尺寸和排版尺寸不一致):
 * 那一道由 Node 拿这里交出的像素和同一帧的截图比(契约第 6.1 节第 2 道)。
 *
 * # 像素怎么交
 *
 * 经 CDP 回一个 base64 字符串。CDP 搬大字符串很慢(实测 1080p 一帧原始像素 8.3 MB 要 90 毫秒左右,比截图慢几倍),
 * 所以先把**全透明的像素游程**压掉:输出是一串 `[跳过几个像素, 接着几个像素, 这些像素的 RGBA…]`(小端 32 位),
 * 画布卡多数画面大半透明,压完只剩几十到几百 KB。压完不比原样小就原样交。
 * `maxBytes`:压完超过这么多字节就不交(回 `dense`),由调用方改走截图。
 */

export interface CanvasGrabRect { x: number; y: number; w: number; h: number }

export type CanvasGrab =
  | { ok: true; w: number; h: number; packed: boolean; b64: string; bytes: number; readMs: number; packMs: number }
  | { ok: false; reason: string; bytes?: number; readMs?: number; packMs?: number };

/** 导出页的 `performance.now` 被钉在导出毫秒上(`kernel/exportClock.ts`),量真实耗时要绕开实例上的那一层 */
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
    // 只读不显示:让它留在内存里,`getImageData` 不必从显存读回
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  }
  return scratchCtx;
}

let packBuffer: Uint32Array | null = null;

/** 把全透明的像素游程压掉。回压好的字节(下一次调用会改写它);不比原样小回 null */
export function packTransparentRuns(rgba: Uint8ClampedArray | Uint8Array): Uint8Array | null {
  if (rgba.byteOffset % 4 || rgba.byteLength % 4) return null;
  const px = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >> 2);
  const n = px.length;
  // 最坏情况(透明与不透明逐像素交替)每个像素多带两个头,只按原样大小留地方,写不下就放弃。
  // 缓冲区留着下一帧接着用(调用方拿到结果立刻转成 base64,不留引用)
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
  // 旧内核没有 `Uint8Array.prototype.toBase64`:分块拼字符串再 `btoa`(慢,但结果相同)
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

/**
 * 取片段 `clipId` 的画布在舞台矩形 `rect`(整数,场景坐标)里的像素。
 * 回 `{ ok: true, w, h, packed, b64, … }`,或 `{ ok: false, reason }`(`no-wrapper` / `canvas-count:<n>` /
 * `gl-frame` / `empty-canvas` / `no-context` / `unreadable` / `dense`)。
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
    // 画布按它的排版框摆:像素尺寸和排版尺寸不一致时这里会缩放,和合成器缩得一不一样由 Node 那一侧的实测判
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
