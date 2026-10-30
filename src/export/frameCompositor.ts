/**
 * 浏览器逐帧导出的合成(`docs/plan/c10a-contract.md` 第 11.1 节「逐帧」)。
 *
 * # 做法
 *
 * 1. **场景**:页面里开一个同源的导出页(`?export=1`,`src/ExportView.tsx`,和预渲染进程、桌面导出同一份页面与钉时间的办法),
 *    灌进项目,每一帧照 `server/bakery/bake.mjs` 的步子推:`__pcSetT` → 排空 → 等一拍 → `__pcSyncAnims` → 排空 → `__pcFrameReady`,
 *    再生成整场景快照(`__pcCreateSnapshot`:样式内联、画布换成图、素材层只留占位)。
 * 2. **卡片的画面**(语义 `product/platforms.md`「在线浏览器」的「导出」,2026-10-13 起分「快速导出」「完整导出」):本页能运行的卡就是
 *    场景里的活组件,逐帧渲;调用方给了 `layers`(`exportLayers.ts`)时,它每一帧说哪几张卡要贴现成的画面 —— 轨道流里的这一帧
 *    (快速导出,只取满密度的分段)、或渲染节点为这次导出逐帧渲好的位图(本页不执行的卡)—— 贴的规矩同预览一侧:
 *    单卡的画面放进这张卡的包裹层(包裹层的位置、缩放、旋转、不透明度、层序照常作用在它上面),按舞台坐标产的画面
 *    (依赖下层的卡)放在包裹层旁边、层序同它,包裹层里原来的东西去掉。
 *    〔分界〕`originals`(逐帧取每张卡存好的 HTML 快照)是 2026-10-13 之前的做法,两种新导出都不再传它;代码留到撤快照那一块一并删。
 * 3. **素材**:导出页按素材原尺寸的地址装素材(`__pcPrepareFrameMedia`:`<video>` 按 Range 取当前需要的那一段,不整片读进内存),
 *    装好后把这一帧的画面画成图、替进快照里素材的占位(层序、框、裁切、滤镜都跟着占位元素走)。
 * 4. **栅格化**:整张快照包成 SVG `foreignObject`,以 `data:` 地址载成图画到复用的原尺寸画布上。
 *    Chrome 实测:`data:` 地址的 foreignObject 图不污染画布(能 `new VideoFrame(canvas)`),`blob:` 地址的会污染。
 *    快照里只用系统字体、图片全是 `data:`(`createSnapshot` 的约定),SVG 图里取不到外部资源也不缺东西;
 *    卡片自带的外部字体(如 KaTeX)在这条路上会退回系统字体 —— 误差见报告。
 *
 * 一次只合成一帧,画布复用(原尺寸一张);素材帧转成 JPEG(质量 0.95)的 data 地址,用完即丢。
 */
import type { Project } from "../kernel/project";
import { renameSnapshotIds } from "../render/snapshotRename";
import { withTicket } from "./ticketRenewal";
import { getCard, syncedUserCards } from "../kernel/registry";
import type { FrameLayer, FrameLayers } from "./exportLayers";
import { stageOrigins } from "../editor/previewMode";
import { ONLINE } from "../online/mode";
import { STAGE_ENTRY_FILE } from "../online/isolation/stageGuard";
import { activeCardSourceReader } from "../editor/sync/onlineCardSources";

type ExportWindow = Window & typeof globalThis & {
  __pcReady?: boolean;
  __pcSetT?: (sec: number, directSec?: number) => void;
  __bfSettle?: () => Promise<void>;
  __pcSyncAnims?: () => void;
  __pcStaticProbe?: () => { finished?: number } | null;
  __pcFrameReady?: () => Promise<void>;
  __pcCreateSnapshot?: () => { html: string; lossy?: number | boolean };
  __pcPrepareFrameMedia?: () => Promise<void>;
  __pcHideFrameMedia?: () => void;
  __pcLoadProject?: (p: unknown, o?: unknown) => Promise<void>;
  /** 导出页:接同步来的用户卡的表(在线导出把它们的包裹层挂出来,好换成预渲染原尺寸) */
  __pcSetSyncedUserCards?: (entries: unknown[]) => void;
  __pcRealRaf?: (cb: FrameRequestCallback) => number;
  /** `?rafControl=1` 时由 `src/render/stageClockEntry.ts` 装:跑一轮排着的 rAF 回调(一拍),回跑了几个 */
  __pcBrowserBeginFrame?: () => number;
  __pcRafFallbacks?: number;
  __pcSetFrameWindow?: (clipIds: string[] | null, startTime: number, directTime?: number) => void;
  __pcRestartCards?: () => void;
  __pcResetAnims?: () => void;
};

export interface HeavyOriginals {
  /** 这一刻(全局帧)这张卡要用的预渲染原尺寸 HTML 快照;不在预渲染集合里给 undefined(照活渲) */
  htmlFor(clipId: string, globalFrame: number): Promise<string | undefined>;
}

export interface CompositorOptions {
  project: Project;
  /** 导出页地址(同源,`?export=1`);不给就按当前页面拼 */
  exportUrl?: string;
  /** 〔分界〕旧做法:重卡逐帧换成存好的 HTML 快照。两种新导出都不传它(见文件头第 2 条) */
  originals?: HeavyOriginals | null;
  /** 卡片画面的现成来源(轨道流、渲染节点逐帧渲的位图);不给 = 全部由导出页活渲 */
  layers?: FrameLayers | null;
  /** 素材帧的 JPEG 质量 */
  mediaQuality?: number;
  /** 背景色(成片不透明) */
  background?: string;
  signal?: AbortSignal;
  /**
   * 当前的只读票据(C10 契约第 12 节:导出途中按时限续签)。给了就在每一帧装素材之前,把导出页里素材地址的 `?t=` 换成这一张 ——
   * 导出页每一帧都按 `data-pc-media-src` 重新装素材(`frameMedia.ts`),所以跨过票据时限也照常取得到。
   */
  freshTicket?: () => string | null;
}

const EMPTY = (p: Project) => ({ width: p.width, height: p.height, fps: p.fps, duration: 1, tracks: [], media: [] });

/**
 * 整段的画面都由合成器贴的卡(`FrameLayers.wrapperOnly`)在导出页里只要一个包裹层,组件不用跑(快速导出快就快在这里)。
 * 导出页本来就有「没有定义的同步卡只挂包裹层」这条路(`placeholderHost.exportSyncedMountFor`,给同步来的用户卡用);
 * 所以交给导出页的那份项目里,把这些片段的卡片 id 换成一个只在同步表里、没有定义的占位 id —— 导出页的代码一个字不用改
 * (舞台那几份文件在好几张卡的源码版本里,改了它们的预渲染结果要重产一遍)。包裹层上的位置、缩放、旋转、不透明度、层序都不看卡片 id。
 * 只换内置的 DOM 卡:同步来的卡本来就走这条路;挂着节点的片段(素材效果卡)别的卡可能拿它当输入,照旧挂着,有画面的帧照样贴上去。
 */
export const WRAPPER_ONLY_CARD = "pc-export-wrapper-only";
export function withWrapperOnly(project: Project, clipIds: readonly string[]): { project: Project; replaced: number } {
  const only = new Set(clipIds);
  if (!only.size) return { project, replaced: 0 };
  let replaced = 0;
  const tracks = project.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => {
    if (!only.has(c.id) || !c.cardId || c.nodeId || !getCard(c.cardId)) return c;
    replaced++;
    return { ...c, cardId: WRAPPER_ONLY_CARD };
  }) }));
  return replaced ? { project: { ...project, tracks }, replaced } : { project, replaced: 0 };
}

/**
 * 同源导出页的地址:当前页面的路径 + `?export=1&rafControl=1` + 空项目(项目随后经 `__pcLoadProject` 灌进去)。
 * `rafControl=1`:导出页的 rAF 由这里手动推(`src/render/stageClockEntry.ts`),一拍对应桌面导出的一次 beginFrame。
 */
export function exportPageUrl(project: Project, loc: Pick<Location, "origin" | "pathname"> = location): string {
  const timeline = "data:application/json," + encodeURIComponent(JSON.stringify(EMPTY(project)));
  return `${loc.origin}${loc.pathname}?export=1&rafControl=1&timeline=${encodeURIComponent(timeline)}`;
}

/** 快照 HTML → 放进 SVG foreignObject 的 XHTML(外面包一层和舞台同尺寸的根) */
export function sceneToSvg(nodes: Iterable<Node>, width: number, height: number, css = ""): string {
  const ser = new XMLSerializer();
  let body = "";
  for (const n of nodes) body += ser.serializeToString(n);
  const style = css ? `<style><![CDATA[${css.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]></style>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width}px;height:${height}px;overflow:hidden">${style}${body}</div></foreignObject></svg>`;
}

/**
 * 导出页的样式表全文(读得到规则的那些)。快照的样式内联按「和同标签基线比、相等就省」的口径
 * (`src/render/snapshot/inlineStyles.ts`),基线含页面的全局样式(Tailwind 的 preflight:`box-sizing: border-box`、
 * `margin: 0`、`border: 0 solid` 等),所以快照要挂在带同一套样式的页面里重放(舞台页就是这样)。
 * SVG foreignObject 里没有页面样式,省掉的这些会退回浏览器缺省值 —— 实测 `box-sizing` 退回 `content-box`,
 * 药丸、章节条的内边距被加在内联的宽高之外,整块变大。所以栅格化时把导出页的样式表一并放进去。
 */
export function pageCssText(doc: Document): string {
  let out = "";
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; } // 跨源样式表读不到规则
    for (const r of Array.from(rules)) out += r.cssText + "\n";
  }
  return out;
}

/**
 * 把一层现成的画面贴进快照里这张卡的包裹层(规矩同预览一侧的流平面,`src/render/Stage.tsx`):
 *   - `local`:包裹层里原来的东西去掉,图是包裹层的子元素,放在包裹层自己的坐标系里 —— 包裹层的框、缩放、旋转、三维变形、
 *     不透明度、强调、层序都照常作用在它上面;
 *   - `stage`:画面按舞台坐标产,包裹层的外观已经画在里面。包裹层里原来的东西去掉,图放在包裹层后面(同一个父元素、同一个层序),
 *     照普通的叠加盖在下面的层上。
 * 图一律显式给位置和宽高、关掉页面样式里对 `<img>` 的限制(Tailwind 的 preflight 有 `max-width: 100%; height: auto`)。
 */
export function pasteLayer(wrap: HTMLElement, layer: FrameLayer): boolean {
  const { x, y, w, h } = layer.rect;
  if (!(w > 0 && h > 0) || !layer.url) return false;
  const img = wrap.ownerDocument.createElement("img");
  img.setAttribute("alt", "");
  img.setAttribute("src", layer.url);
  const base = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;max-width:none;max-height:none;margin:0;padding:0;border:0;display:block;pointer-events:none`;
  wrap.innerHTML = "";
  if (layer.plane === "stage") {
    img.setAttribute("style", `${base};z-index:${wrap.style.zIndex || "auto"}`);
    wrap.after(img);
  } else {
    img.setAttribute("style", base);
    wrap.appendChild(img);
  }
  return true;
}

/** 跨源导出舞台一条请求(装项目、预热、出一帧)最多等多久(真毫秒);只为防卡死,放宽到不会因机器慢而误报 */
export const EXPORT_STAGE_RPC_TIMEOUT_MS = 120_000;

export class ExportCompositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frameEl: HTMLIFrameElement;
  private w: ExportWindow;
  private opts: CompositorOptions;
  private scratch: HTMLCanvasElement;
  readonly crossOrigin: boolean;
  private rpcSeq = 0;
  private pendingRpc = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private messageListener: ((ev: MessageEvent) => void) | null = null;
  readonly stats = { frames: 0, stepMs: 0, snapshotMs: 0, mediaMs: 0, rasterMs: 0, heavyReplaced: 0, mediaFrames: 0, manualTicks: 0, rafFallbacks: 0, ticketSwaps: 0, layersPasted: 0, layerMs: 0 };

  private constructor(frameEl: HTMLIFrameElement, opts: CompositorOptions, crossOrigin = false) {
    this.frameEl = frameEl;
    this.w = frameEl.contentWindow as ExportWindow;
    this.opts = opts;
    this.crossOrigin = crossOrigin;
    this.canvas = document.createElement("canvas");
    this.canvas.width = opts.project.width;
    this.canvas.height = opts.project.height;
    this.ctx = this.canvas.getContext("2d", { alpha: false, willReadFrequently: true })!;
    this.scratch = document.createElement("canvas");
    if (crossOrigin) {
      this.messageListener = (ev: MessageEvent) => {
        if (ev.source !== this.frameEl.contentWindow) return;
        const data = ev.data;
        if (!data || typeof data !== "object") return;
        if (typeof data.id === "number") {
          const handler = this.pendingRpc.get(data.id);
          if (handler) {
            this.pendingRpc.delete(data.id);
            if (data.error) handler.reject(new Error(data.error));
            else handler.resolve(data);
          }
        }
      };
      window.addEventListener("message", this.messageListener);
    }
  }

  /**
   * 给跨源导出舞台发一条请求、等它回。导出舞台没回(页面卡住、崩溃、初始化等不到头)时不无限等:`EXPORT_STAGE_RPC_TIMEOUT_MS`
   * 真毫秒后报错;取消导出时当场拒掉。
   */
  private sendRpc<T = any>(msg: Record<string, unknown>, transfer?: Transferable[]): Promise<T> {
    this.throwIfAborted();
    const id = ++this.rpcSeq;
    return new Promise<T>((resolve, reject) => {
      const signal = this.opts.signal;
      const settle = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); this.pendingRpc.delete(id); };
      const onAbort = () => { settle(); reject(Object.assign(new Error("已取消"), { cancelled: true })); };
      const timer = setTimeout(() => {
        settle();
        reject(new Error(`导出舞台 ${Math.round(EXPORT_STAGE_RPC_TIMEOUT_MS / 1000)} 秒没有回应(${String(msg.type)})`));
      }, EXPORT_STAGE_RPC_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingRpc.set(id, { resolve: (v) => { settle(); resolve(v); }, reject: (e) => { settle(); reject(e); } });
      try {
        const w = this.frameEl.contentWindow;
        if (!w) throw new Error("导出舞台 iframe 已脱落");
        if (transfer && transfer.length) {
          w.postMessage({ id, ...msg }, "*", transfer);
        } else {
          w.postMessage({ id, ...msg }, "*");
        }
      } catch (e) {
        settle();
        reject(e);
      }
    });
  }

  /** 开导出页、灌项目、等就绪 */
  static async open(opts: CompositorOptions): Promise<ExportCompositor> {
    // 整段的画面都由这里贴的卡:导出页只挂包裹层,不跑组件(见 `withWrapperOnly`)
    const wrapped = withWrapperOnly(opts.project, opts.layers?.wrapperOnly ?? []);
    const p = wrapped.project;
    const origins = stageOrigins();
    const stageHost = origins ? (origins.B || origins.A) : null;
    let url: string;
    if (opts.exportUrl) {
      url = opts.exportUrl;
    } else if (stageHost) {
      const base = typeof import.meta.env !== "undefined" && import.meta.env.BASE_URL ? import.meta.env.BASE_URL : "/";
      const path = ONLINE && origins ? `${base.endsWith("/") ? base : `${base}/`}${STAGE_ENTRY_FILE}` : location.pathname;
      url = `${stageHost}${path}?export=1&rafControl=1&id=export`;
    } else {
      url = exportPageUrl(p);
    }
    const isCrossOrigin = (u: string) => {
      try {
        return new URL(u, location.href).origin !== location.origin;
      } catch {
        return false;
      }
    };
    const crossOrigin = isCrossOrigin(url);

    const el = document.createElement("iframe");
    el.setAttribute("aria-hidden", "true");
    el.title = "逐帧导出";
    el.dataset.pc = "browser-export-frame";
    // 只能 opacity:0 藏:display:none / visibility:hidden 会停掉里面的 rAF 与 <video>(和后台舞台同一个理由)
    el.style.cssText = `position:fixed;left:0;top:0;width:${p.width}px;height:${p.height}px;border:0;opacity:0;pointer-events:none;z-index:-1`;
    if (crossOrigin) {
      el.setAttribute("sandbox", "allow-scripts allow-same-origin");
    }
    el.src = url;
    document.body.appendChild(el);
    const c = new ExportCompositor(el, opts, crossOrigin);
    try {
      if (crossOrigin) {
        let ready = false;
        const onReady = (ev: MessageEvent) => {
          if (ev.source === c.frameEl.contentWindow && ev.data?.type === "pc-export-ready") ready = true;
        };
        window.addEventListener("message", onReady);
        try {
          const t0 = performance.now();
          while (!ready) {
            c.throwIfAborted();
            try { c.frameEl.contentWindow?.postMessage({ type: "pc-export-ping" }, "*"); } catch { /* ignore */ }
            if (performance.now() - t0 > 60_000) throw new Error("导出舞台 60 秒没就绪");
            await new Promise((r) => setTimeout(r, 50));
          }
        } finally {
          window.removeEventListener("message", onReady);
        }
        const synced = [...syncedUserCards().values(), ...(wrapped.replaced ? [{ id: WRAPPER_ONLY_CARD, name: "" }] : [])];
        const reader = activeCardSourceReader();
        let cardSources: { entries: string[]; files: Record<string, { body: string; hash: string }> } | null = null;
        if (reader) {
          const entries = reader.entries();
          const files: Record<string, { body: string; hash: string }> = {};
          const visited = new Set<string>();
          const queue = [...entries];
          while (queue.length > 0) {
            const key = queue.shift()!;
            if (visited.has(key)) continue;
            visited.add(key);
            const item = reader.read(key);
            if (item) {
              files[key] = item;
              const re = /(?:import|from)\s*['"](\.[^'"]+)['"]/g;
              let match: RegExpExecArray | null;
              while ((match = re.exec(item.body)) !== null) {
                const spec = match[1];
                const parts = key.split("/").slice(0, -1);
                let ok = true;
                for (const p of spec.split("/")) {
                  if (p === "" || p === ".") continue;
                  if (p === "..") { if (!parts.length) { ok = false; break; } parts.pop(); continue; }
                  parts.push(p);
                }
                if (ok) {
                  const resolved = parts.join("/");
                  for (const ext of ["", ".tsx", ".ts", ".js", ".mjs", ".css"]) {
                    const candidate = resolved + ext;
                    if (!visited.has(candidate) && reader.read(candidate)) {
                      queue.push(candidate);
                      break;
                    }
                  }
                }
              }
            }
          }
          cardSources = { entries, files };
        }
        await c.sendRpc({
          type: "pc-export-init",
          project: p,
          syncedCards: synced,
          cardSources,
          freshTicket: opts.freshTicket?.() ?? null,
        });
      } else {
        await c.waitFor(() => c.w?.__pcReady === true && typeof c.w.__pcLoadProject === "function", 60_000, "导出页 60 秒没就绪");
        // 同步来的用户卡在导出页里没有定义:把同步表交给它,让这些卡的包裹层挂出来,逐帧换成预渲染原尺寸
        const synced = [...syncedUserCards().values(), ...(wrapped.replaced ? [{ id: WRAPPER_ONLY_CARD, name: "" }] : [])];
        if (synced.length) c.w.__pcSetSyncedUserCards?.(synced);
        await c.w.__pcLoadProject!(p);
        await c.waitFor(() => c.w.__pcReady === true && typeof c.w.__pcSetT === "function", 60_000, "导出页 60 秒没装好项目");
      }
    } catch (e) {
      c.close();
      throw e;
    }
    return c;
  }

  private async waitFor(ok: () => boolean, ms: number, message: string): Promise<void> {
    const t0 = performance.now();
    for (;;) {
      this.throwIfAborted();
      try { if (ok()) return; } catch { /* 页面还没起来 */ }
      if (performance.now() - t0 > ms) throw new Error(message);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private throwIfAborted() {
    if (this.opts.signal?.aborted) throw Object.assign(new Error("已取消"), { cancelled: true });
  }

  /**
   * 导出页里推一拍。导出页带 `rafControl=1` 时手动跑一轮 rAF 回调,不等真 vsync —— Motion 的帧循环不会在合成期间自己多走;
   * 没有手动推的口子(外部给的 exportUrl)时退回等一次真 rAF。
   */
  private raf(): Promise<void> {
    const begin = this.w.__pcBrowserBeginFrame;
    if (typeof begin === "function") {
      begin();
      this.stats.manualTicks++;
      this.stats.rafFallbacks = this.w.__pcRafFallbacks ?? 0;
      // 回调里排的宏任务(React 调度器的 MessageChannel 等)让它落地,和等过一次真 rAF 之后的状态一致
      return new Promise((resolve) => setTimeout(resolve, 0));
    }
    const raf = this.w.__pcRealRaf ?? this.w.requestAnimationFrame.bind(this.w);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      raf(() => finish());
      // 页面被判不可见时 rAF 可能停:封一个上限,不让导出挂死
      setTimeout(finish, 250);
    });
  }

  private async settle() { await this.w.__bfSettle?.(); }

  /** 推到这一帧(照 `bake.mjs` 的 `createStepper`,拍由 rAF 给) */
  private async stepTo(frame: number, fps: number) {
    const sec = frame / fps;
    this.w.__pcHideFrameMedia?.();
    this.w.__pcSetT!(sec, sec);
    await this.settle();
    await this.raf();
    await this.settle();
    this.w.__pcSyncAnims?.();
    await this.settle();
    const probe = this.w.__pcStaticProbe?.();
    if (probe?.finished) {
      for (let pass = 0; pass < 2; pass++) {
        await this.raf();
        await this.settle();
        this.w.__pcSyncAnims?.();
        await this.settle();
      }
    }
    await this.w.__pcFrameReady?.();
    await this.w.document.fonts.ready;
    // 生成快照之前画两拍:Motion 的 JS 帧循环只在真画一帧时把新值写进 style(`bake.mjs` 的 flushFrameLoop)
    await this.raf();
    await this.raf();
    await this.settle();
    this.w.__pcSyncAnims?.();
  }

  /** 素材元素的这一帧画成 JPEG 的 data 地址;画不出(没载上、跨源被污染)给 null */
  private mediaFrameUrl(el: HTMLVideoElement | HTMLImageElement): string | null {
    const isVideo = el.tagName === "VIDEO";
    const w = isVideo ? (el as HTMLVideoElement).videoWidth : (el as HTMLImageElement).naturalWidth;
    const h = isVideo ? (el as HTMLVideoElement).videoHeight : (el as HTMLImageElement).naturalHeight;
    if (!w || !h) return null;
    this.scratch.width = w;
    this.scratch.height = h;
    const g = this.scratch.getContext("2d")!;
    g.clearRect(0, 0, w, h);
    try {
      g.drawImage(el, 0, 0, w, h);
      return isVideo ? this.scratch.toDataURL("image/jpeg", this.opts.mediaQuality ?? 0.95) : this.scratch.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  private warmed = -1;
  /** 导出页的样式表全文,第一帧读一次(`pageCssText`) */
  private css: string | null = null;
  /**
   * 从 `startFrame` 起一趟连续出帧之前的预热(照 `bake.mjs` 的 `__pcSetFrameWindow` + `warmUpAt`):全部卡按活跃判据挂载、
   * 时钟拨到起点、推 3 拍、重挂载卡片并清动画锚点、再推一拍。少了这一步,Motion 的弹簧等动画的锚点落在载入项目那一刻,
   * 和桌面导出差出相位。
   */
  private async warmUp(startFrame: number, fps: number) {
    if (this.crossOrigin) {
      await this.sendRpc({ type: "pc-export-warmup", startFrame, fps });
      this.warmed = startFrame;
      return;
    }
    const sec = startFrame / fps;
    this.w.__pcSetFrameWindow?.(null, sec, sec);
    for (let i = 0; i < 3; i++) { await this.stepTo(startFrame, fps); await this.raf(); }
    this.w.__pcRestartCards?.();
    this.w.__pcResetAnims?.();
    await this.stepTo(startFrame, fps);
    await this.raf();
    this.w.__pcResetAnims?.();
    this.warmed = startFrame;
  }

  /** 合成第 `frame` 帧到 `canvas`,回画布(同一张,下一帧会被覆盖)。帧号要从起点逐帧递增(和桌面导出一样顺推) */
  async frame(frame: number): Promise<HTMLCanvasElement> {
    this.throwIfAborted();
    const p = this.opts.project;
    const fps = Math.max(1, p.fps || 30);
    if (this.warmed < 0) await this.warmUp(frame, fps);

    if (this.crossOrigin) {
      const t0 = performance.now();
      let layers: FrameLayer[] = [];
      if (this.opts.layers) {
        const activeClipIds = this.opts.layers.wrapperOnly;
        layers = await this.opts.layers.at(frame, activeClipIds);
        if (layers.length) this.stats.layersPasted += layers.length;
      }
      const ticket = this.opts.freshTicket?.() ?? null;
      const res = await this.sendRpc<{
        type: "pc-export-frame-result";
        bitmap: ImageBitmap;
        stats?: Record<string, number>;
      }>({
        type: "pc-export-render-frame",
        frame,
        fps,
        layers,
        freshTicket: ticket,
        background: this.opts.background ?? "#000",
      });
      const bitmap = res.bitmap;
      this.ctx.fillStyle = this.opts.background ?? "#000";
      this.ctx.fillRect(0, 0, p.width, p.height);
      this.ctx.drawImage(bitmap, 0, 0, p.width, p.height);
      bitmap.close();
      if (res.stats) {
        this.stats.stepMs += res.stats.stepMs ?? 0;
        this.stats.snapshotMs += res.stats.snapshotMs ?? 0;
        this.stats.mediaMs += res.stats.mediaMs ?? 0;
        this.stats.rasterMs += res.stats.rasterMs ?? 0;
        this.stats.mediaFrames += res.stats.mediaFrames ?? 0;
        this.stats.ticketSwaps += res.stats.ticketSwaps ?? 0;
      }
      this.stats.rasterMs += performance.now() - t0;
      this.stats.frames++;
      return this.canvas;
    }

    const doc = this.w.document;
    let t0 = performance.now();
    await this.stepTo(frame, fps);
    this.stats.stepMs += performance.now() - t0;

    t0 = performance.now();
    const snap = this.w.__pcCreateSnapshot!();
    if (snap.lossy) throw new Error("这一帧有读不出像素的画布,导不出来");
    const tpl = document.createElement("template");
    tpl.innerHTML = snap.html;
    // 重卡:包裹层里换成预渲染原尺寸
    if (this.opts.originals) {
      for (const wrap of tpl.content.querySelectorAll<HTMLElement>("[data-pc-clip]")) {
        if (wrap.hasAttribute("data-pc-media")) continue;
        const clipId = wrap.getAttribute("data-pc-clip")!;
        const html = await this.opts.originals.htmlFor(clipId, frame);
        if (html === undefined) continue;
        wrap.innerHTML = renameSnapshotIds(html, clipId);
        this.stats.heavyReplaced++;
      }
    }
    this.stats.snapshotMs += performance.now() - t0;
    // 素材的占位先按文档顺序记下来(和导出页里活的素材元素一一对应);下面贴卡片画面时可能把某个包裹层里的占位一起换掉
    const holes = [...tpl.content.querySelectorAll<HTMLElement>("video[data-pc-media-src], img[data-pc-media-src]")];

    // 卡片的现成画面:轨道流里的这一帧、渲染节点逐帧渲的位图(见文件头第 2 条)
    if (this.opts.layers) {
      t0 = performance.now();
      const wraps = new Map<string, HTMLElement>();
      for (const wrap of tpl.content.querySelectorAll<HTMLElement>("[data-pc-clip]")) {
        if (wrap.hasAttribute("data-pc-media")) continue;
        const id = wrap.getAttribute("data-pc-clip")!;
        if (!wraps.has(id)) wraps.set(id, wrap);
      }
      for (const layer of await this.opts.layers.at(frame, [...wraps.keys()])) {
        const wrap = wraps.get(layer.clipId);
        if (wrap && pasteLayer(wrap, layer)) this.stats.layersPasted++;
      }
      this.stats.layerMs += performance.now() - t0;
    }

    // 素材:原尺寸按这一帧装好,画成图替进占位(跨源素材要按 CORS 取,否则画布被污染)
    t0 = performance.now();
    const live = [...doc.querySelectorAll<HTMLVideoElement | HTMLImageElement>("[data-pc-scene] video[data-pc-media-src], [data-pc-scene] img[data-pc-media-src]")];
    if (live.length) {
      for (const el of live) if (!el.crossOrigin) el.crossOrigin = "anonymous";
      const ticket = this.opts.freshTicket?.() ?? null;
      if (ticket) {
        for (const el of live) {
          const src = el.getAttribute("data-pc-media-src") ?? "";
          const next = withTicket(src, ticket);
          if (next !== src) { el.setAttribute("data-pc-media-src", next); this.stats.ticketSwaps++; }
        }
      }
      await this.w.__pcPrepareFrameMedia?.();
      holes.forEach((hole, i) => {
        const el = live[i];
        // 占位所在的包裹层已经整个换成现成的画面:这一处素材不用画
        if (!el || !tpl.content.contains(hole)) return;
        const shown = el.style.visibility !== "hidden" && hole.getAttribute("data-pc-media-hidden") !== "true";
        const url = shown ? this.mediaFrameUrl(el) : null;
        const img = document.createElement("img");
        for (const attr of [...hole.attributes]) if (attr.name !== "src" && !attr.name.startsWith("data-pc-media")) img.setAttribute(attr.name, attr.value);
        img.style.visibility = url ? "visible" : "hidden";
        if (url) { img.setAttribute("src", url); this.stats.mediaFrames++; }
        hole.replaceWith(img);
      });
      this.w.__pcHideFrameMedia?.();
    }
    this.stats.mediaMs += performance.now() - t0;

    // 栅格化:整张快照 → SVG foreignObject(data 地址,不污染画布)→ 原尺寸画布
    t0 = performance.now();
    this.css ??= pageCssText(doc);
    const svg = sceneToSvg(tpl.content.childNodes, p.width, p.height, this.css);
    const img = new Image();
    img.decoding = "sync";
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode();
    this.ctx.fillStyle = this.opts.background ?? "#000";
    this.ctx.fillRect(0, 0, p.width, p.height);
    this.ctx.drawImage(img, 0, 0, p.width, p.height);
    this.stats.rasterMs += performance.now() - t0;
    this.stats.frames++;
    return this.canvas;
  }

  close(): void {
    if (this.crossOrigin) {
      if (this.messageListener) {
        window.removeEventListener("message", this.messageListener);
        this.messageListener = null;
      }
      for (const handler of [...this.pendingRpc.values()]) {
        handler.reject(new Error("导出合成器已关闭"));
      }
      this.pendingRpc.clear();
      try {
        this.frameEl.contentWindow?.postMessage({ type: "pc-export-close" }, "*");
      } catch { /* 已经关了 */ }
    }
    try { this.opts.layers?.close(); } catch { /* 已经关了 */ }
    try { this.frameEl.remove(); } catch { /* 已经摘了 */ }
    this.scratch.width = this.scratch.height = 0;
  }
}
