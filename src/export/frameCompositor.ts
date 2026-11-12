/**
 * Browser frame-by-frame export composition (`docs/plan/c10a-contract.md` section 11.1 "Frame by frame").
 *
 * # Approach
 *
 * 1. **Scene**: Open a same-origin export page (`?export=1`, `src/ExportView.tsx`, same page and
 *    time-pinning method as prerender process and desktop export), load the project, step each frame
 *    following `server/bakery/bake.mjs`: `__pcSetT` → flush → wait one tick → `__pcSyncAnims` →
 *    flush → `__pcFrameReady`, then generate whole-scene snapshots (`__pcCreateSnapshot`: inline styles,
 *    replace canvas with image, leave only placeholders for media layers).
 * 2. **Card visuals** (semantics: "Export" under "Online browser" in `product/platforms.md`, split into
 *    "Fast export" and "Full export" starting 2026-10-13): Cards runnable on this page are live
 *    components in the scene, rendered frame-by-frame; when the caller provides `layers`
 *    (`exportLayers.ts`), it specifies which cards paste ready-made visuals for each frame: this frame
 *    from track streams (fast export, full-density segments only), or bitmaps rendered frame-by-frame
 *    by render nodes for this export (cards not executed on this page). Pasting rules follow the
 *    preview side: single-card visuals are placed into the card's wrapper layer (position, scale,
 *    rotation, opacity, and layer order of the wrapper layer apply to it as usual); visuals produced in
 *    stage coordinates (below-dependent cards) are placed beside the wrapper layer with the same layer
 *    order, removing original contents in the wrapper layer.
 *    [boundary] `originals` (fetching stored HTML snapshots for each card frame-by-frame) is the
 *    approach before 2026-10-13, and neither new export method passes it; code is kept until snapshot
 *    removal and deleted together.
 * 3. **Media**: The export page loads media by original-size asset URL (`__pcPrepareFrameMedia`:
 *    `<video>` fetches the currently needed range without loading the whole file into memory); once
 *    loaded, draw this frame's visual into an image and replace the media placeholder in the snapshot
 *    (layer order, bounding box, crop, and filter all follow the placeholder element).
 * 4. **Rasterization**: The whole snapshot is wrapped into SVG `foreignObject`, loaded as an image
 *    via `data:` URL, and drawn onto the reused original-size canvas.
 *    Chrome tests confirm: foreignObject images with `data:` URLs do not taint the canvas (can
 *    `new VideoFrame(canvas)`), while `blob:` URLs taint it.
 *    Snapshots use only system fonts, and images are all `data:` (convention of `createSnapshot`), so
 *    SVG images cannot fetch external resources and lack nothing; external fonts bundled with cards
 *    (such as KaTeX) fall back to system fonts on this path: see report for deviations.
 *
 * Composite only one frame at a time, reusing the canvas (one at original size); media frames are
 * converted to JPEG (quality 0.95) data URLs, discarded after use.
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
import { tr as trText } from "../i18n/index.ts";

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
  __pcRender3DCut?: () => Promise<void>;
  __pcLoadProject?: (p: unknown, o?: unknown) => Promise<void>;
  /** Export page: table receiving synced user cards (online export mounts their wrapper layers so they can be replaced with original-size prerender) */
  __pcSetSyncedUserCards?: (entries: unknown[]) => void;
  __pcRealRaf?: (cb: FrameRequestCallback) => number;
  /** Installed by `src/render/stageClockEntry.ts` when `?rafControl=1`: runs a round of queued rAF callbacks (one tick), returns how many ran */
  __pcBrowserBeginFrame?: () => number;
  __pcRafFallbacks?: number;
  __pcSetFrameWindow?: (clipIds: string[] | null, startTime: number, directTime?: number) => void;
  __pcRestartCards?: () => void;
  __pcResetAnims?: () => void;
};

export interface HeavyOriginals {
  /** Original-size prerender HTML snapshot to use for this card at this moment (global frame); undefined if not in prerender set (handled by live render) */
  htmlFor(clipId: string, globalFrame: number): Promise<string | undefined>;
}

export interface CompositorOptions {
  project: Project;
  /** Export page URL (same-origin, `?export=1`); constructed from current page if not provided */
  exportUrl?: string;
  /** [boundary] Old approach: heavy cards replaced frame-by-frame with stored HTML snapshots. Neither new export passes it (see item 2 in file header) */
  originals?: HeavyOriginals | null;
  /** Ready-made sources for card visuals (track streams, bitmaps rendered frame-by-frame by render nodes); omitted = all live rendered by export page */
  layers?: FrameLayers | null;
  /** JPEG quality for media frames */
  mediaQuality?: number;
  /** Background color (final video is opaque) */
  background?: string;
  signal?: AbortSignal;
  /**
   * Current read-only ticket (C10 contract section 12: renewed by time limit during export).
   * When provided, before loading media on each frame, replace `?t=` in media URLs on the export
   * page with this ticket: the export page reloads media on each frame based on
   * `data-pc-media-src` (`frameMedia.ts`), so it remains accessible even across ticket expirations.
   */
  freshTicket?: () => string | null;
}

const EMPTY = (p: Project) => ({ width: p.width, height: p.height, fps: p.fps, duration: 1, tracks: [], media: [] });

/**
 * Cards whose visuals for entire segments are pasted by compositor (`FrameLayers.wrapperOnly`)
 * only need a wrapper layer in the export page, without running components (this is why fast
 * export is fast). The export page already supports "mount only wrapper layers for undefined
 * synced cards" (`placeholderHost.exportSyncedMountFor`, used for synced user cards);
 * therefore, in the project passed to the export page, card IDs of these clips are replaced
 * with an undefined placeholder ID present only in the sync table: not a single word of export
 * page code needs to change (those stage files exist in source versions of multiple cards;
 * changing them requires one to re-produce their prerender output). Position, scale, rotation,
 * opacity, and layer order on the wrapper layer do not depend on card ID.
 * Only replace built-in DOM cards: synced cards already take this path; clips mounting nodes
 * (media effect cards) might be used as inputs by other cards, so keep them mounted as usual,
 * and frames with visuals are pasted as normal.
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
 * URL of the same-origin export page: current page path + `?export=1&rafControl=1` + empty project
 * (project is subsequently loaded via `__pcLoadProject`).
 * `rafControl=1`: export page rAF is manually stepped from here (`src/render/stageClockEntry.ts`);
 * one tick corresponds to one beginFrame in desktop export.
 */
export function exportPageUrl(project: Project, loc: Pick<Location, "origin" | "pathname"> = location): string {
  const timeline = "data:application/json," + encodeURIComponent(JSON.stringify(EMPTY(project)));
  return `${loc.origin}${loc.pathname}?export=1&rafControl=1&timeline=${encodeURIComponent(timeline)}`;
}

/** Snapshot HTML → XHTML placed into SVG `foreignObject` (wrapped in an outer root of the same size as the stage) */
export function sceneToSvg(nodes: Iterable<Node>, width: number, height: number, css = ""): string {
  const ser = new XMLSerializer();
  let body = "";
  for (const n of nodes) body += ser.serializeToString(n);
  const style = css ? `<style><![CDATA[${css.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]></style>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width}px;height:${height}px;overflow:hidden">${style}${body}</div></foreignObject></svg>`;
}

/**
 * Full stylesheet text of export page (those with readable rules). Snapshot style inlining
 * follows "compare against same-tag baseline, omit if equal"
 * (`src/render/snapshot/inlineStyles.ts`); baseline includes global page styles (Tailwind
 * preflight: `box-sizing: border-box`, `margin: 0`, `border: 0 solid`, etc.), so snapshots must
 * be mounted in a page carrying the same styles to replay (as the stage page does).
 * SVG foreignObject has no page styles, so omitted styles revert to browser defaults: in
 * testing, `box-sizing` reverted to `content-box`, adding padding of pills and chapter bars
 * outside the inlined width/height and enlarging the whole block. Therefore, export page
 * stylesheets are included during rasterization.
 */
export function pageCssText(doc: Document): string {
  let out = "";
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; } // Cannot read rules from cross-origin stylesheets
    for (const r of Array.from(rules)) out += r.cssText + "\n";
  }
  return out;
}

/**
 * Pastes a layer of ready-made visuals into this card's wrapper layer in the snapshot (rules follow
 * the stream plane on the preview side, `src/render/Stage.tsx`):
 *   - `local`: remove original contents in wrapper layer; image is a child element of wrapper layer,
 *     placed in wrapper layer's own coordinate system: bounding box, scale, rotation, 3D transform,
 *     opacity, emphasis, and layer order of wrapper layer apply to it as usual;
 *   - `stage`: visual is produced in stage coordinates, with wrapper layer appearance already drawn
 *     inside. Remove original contents in wrapper layer; image is placed behind wrapper layer (same
 *     parent element, same layer order), overlaying lower layers normally.
 * Images are always explicitly given position and dimensions, disabling page style restrictions on
 * `<img>` (Tailwind preflight has `max-width: 100%; height: auto`).
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

/** Maximum wait time (real ms) for a cross-origin export stage request (load project, warm up, render a frame); solely to prevent hangs, relaxed to avoid false alarms from slow machines */
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
   * Sends a request to cross-origin export stage and waits for response. Do not wait indefinitely
   * when export stage does not respond (page frozen, crashed, initialization never finishes):
   * throws an error after `EXPORT_STAGE_RPC_TIMEOUT_MS` real ms; rejects immediately if export is cancelled.
   */
  private sendRpc<T = any>(msg: Record<string, unknown>, transfer?: Transferable[]): Promise<T> {
    this.throwIfAborted();
    const id = ++this.rpcSeq;
    return new Promise<T>((resolve, reject) => {
      const signal = this.opts.signal;
      const settle = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); this.pendingRpc.delete(id); };
      const onAbort = () => { settle(); reject(Object.assign(new Error(trText("Cancelled")), { cancelled: true })); };
      const timer = setTimeout(() => {
        settle();
        reject(new Error(trText("Export stage did not respond for {0} s ({1})", Math.round(EXPORT_STAGE_RPC_TIMEOUT_MS / 1000), String(msg.type))));
      }, EXPORT_STAGE_RPC_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingRpc.set(id, { resolve: (v) => { settle(); resolve(v); }, reject: (e) => { settle(); reject(e); } });
      try {
        const w = this.frameEl.contentWindow;
        if (!w) throw new Error(trText("Export stage iframe has been detached"));
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

  /** Open export page, load project, and wait for ready */
  static async open(opts: CompositorOptions): Promise<ExportCompositor> {
    // Cards whose visuals for the entire segment are pasted here: export page only mounts wrapper layers, without running components (see `withWrapperOnly`)
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
    el.title = trText("Frame-by-frame export");
    el.dataset.pc = "browser-export-frame";
    // Can only hide with opacity:0: display:none / visibility:hidden stops rAF and <video> inside (same reason as background stage)
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
            if (performance.now() - t0 > 60_000) throw new Error(trText("Export stage was not ready after 60 s"));
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
        await c.waitFor(() => c.w?.__pcReady === true && typeof c.w.__pcLoadProject === "function", 60_000, trText("Export page was not ready after 60 s"));
        // Synced user cards are not defined in export page: pass sync table to it to mount wrapper layers for these cards, replaced frame-by-frame with original-size prerender
        const synced = [...syncedUserCards().values(), ...(wrapped.replaced ? [{ id: WRAPPER_ONLY_CARD, name: "" }] : [])];
        if (synced.length) c.w.__pcSetSyncedUserCards?.(synced);
        await c.w.__pcLoadProject!(p);
        await c.waitFor(() => c.w.__pcReady === true && typeof c.w.__pcSetT === "function", 60_000, trText("Export page did not finish loading the project after 60 s"));
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
      try { if (ok()) return; } catch { /* Page has not started yet */ }
      if (performance.now() - t0 > ms) throw new Error(message);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private throwIfAborted() {
    if (this.opts.signal?.aborted) throw Object.assign(new Error(trText("Cancelled")), { cancelled: true });
  }

  /**
   * Step one tick in export page. When export page has `rafControl=1`, manually run a round of
   * rAF callbacks without waiting for real vsync: Motion's frame loop will not advance on its
   * own during composition; falls back to waiting for a real rAF when there is no manual stepping
   * interface (externally provided `exportUrl`).
   */
  private raf(): Promise<void> {
    const begin = this.w.__pcBrowserBeginFrame;
    if (typeof begin === "function") {
      begin();
      this.stats.manualTicks++;
      this.stats.rafFallbacks = this.w.__pcRafFallbacks ?? 0;
      // Let macrotasks scheduled in callbacks (React scheduler's MessageChannel, etc.) settle, consistent with the state after waiting for a real rAF
      return new Promise((resolve) => setTimeout(resolve, 0));
    }
    const raf = this.w.__pcRealRaf ?? this.w.requestAnimationFrame.bind(this.w);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      raf(() => finish());
      // When page is deemed invisible, rAF may stop: set an upper bound so export does not hang
      setTimeout(finish, 250);
    });
  }

  private async settle() { await this.w.__bfSettle?.(); }

  /** Step to this frame (following `createStepper` in `bake.mjs`, ticks supplied by rAF) */
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
    // Render two ticks before snapshot generation: Motion's JS frame loop writes new values to style only when actually rendering a frame (flushFrameLoop in `bake.mjs`)
    await this.raf();
    await this.raf();
    await this.settle();
    this.w.__pcSyncAnims?.();
  }

  /** Draw this frame of the media element as a JPEG data URL; return null if unable to draw (not loaded, tainted by cross-origin) */
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
  /** Full stylesheet text of export page, read once on the first frame (`pageCssText`) */
  private css: string | null = null;
  /**
   * Warm-up before a pass of consecutive frame rendering starting from `startFrame` (following
   * `__pcSetFrameWindow` + `warmUpAt` in `bake.mjs`): mount all cards by active criteria, set clock
   * to start point, step 3 ticks, remount cards and clear animation anchor points, then step one
   * more tick. Without this step, anchor points for Motion animations like springs fall at the
   * moment the project is loaded, causing a phase discrepancy with desktop export.
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

  /** Composite frame `frame` to `canvas`, return canvas (same instance, overwritten next frame). Frame numbers must increment frame-by-frame from start (stepping forward like desktop export) */
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

    const has3DCut = !!doc.querySelector("canvas[data-pc-3d-cut]");
    if (has3DCut) {
      const offMedia = [...doc.querySelectorAll<HTMLVideoElement | HTMLImageElement>("[data-pc-3d-offscreen] video[data-pc-media-src], [data-pc-3d-offscreen] img[data-pc-media-src]")];
      if (offMedia.length) {
        for (const el of offMedia) if (!el.crossOrigin) el.crossOrigin = "anonymous";
        const ticket = this.opts.freshTicket?.() ?? null;
        if (ticket) {
          for (const el of offMedia) {
            const src = el.getAttribute("data-pc-media-src") ?? "";
            const next = withTicket(src, ticket);
            if (next !== src) { el.setAttribute("data-pc-media-src", next); this.stats.ticketSwaps++; }
          }
        }
        await this.w.__pcPrepareFrameMedia?.();
      }
      await this.w.__pcRender3DCut?.();
    }

    t0 = performance.now();
    const snap = this.w.__pcCreateSnapshot!();
    if (snap.lossy) throw new Error(trText("This frame has a canvas whose pixels can't be read, so it can't be exported"));
    const tpl = document.createElement("template");
    tpl.innerHTML = snap.html;
    // Heavy card: replace inside wrapper layer with original-size prerender
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
    // Record media placeholders in document order first (1:1 with live media elements in export page); pasting card visuals below may replace placeholders inside a wrapper layer
    const holes = [...tpl.content.querySelectorAll<HTMLElement>("video[data-pc-media-src], img[data-pc-media-src]")];

    // Ready-made card visuals: this frame from track stream, or bitmap rendered frame-by-frame by render node (see item 2 in file header)
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

    // Media: load original size for this frame, draw to image and replace placeholder (cross-origin media must use CORS, otherwise canvas is tainted)
    t0 = performance.now();
    const live = [...doc.querySelectorAll<HTMLVideoElement | HTMLImageElement>("[data-pc-scene] video[data-pc-media-src], [data-pc-scene] img[data-pc-media-src]")]
      .filter((el) => !el.closest("[data-pc-3d-offscreen]"));
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
        // The wrapper layer containing the placeholder has been completely replaced with a ready-made frame: this asset does not need to be drawn
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
    } else if (has3DCut) {
      this.w.__pcHideFrameMedia?.();
    }
    this.stats.mediaMs += performance.now() - t0;

    // Rasterization: full snapshot → SVG foreignObject (data URL, does not taint canvas) → original-size canvas
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
        handler.reject(new Error(trText("Export compositor is closed")));
      }
      this.pendingRpc.clear();
      try {
        this.frameEl.contentWindow?.postMessage({ type: "pc-export-close" }, "*");
      } catch { /* Already closed */ }
    }
    try { this.opts.layers?.close(); } catch { /* Already closed */ }
    try { this.frameEl.remove(); } catch { /* Already removed */ }
    this.scratch.width = this.scratch.height = 0;
  }
}
