import type { CardDef } from "../../kernel/types";
import type { PartDef } from "../../kernel/partTypes";
import { userCardSources } from "../../kernel/registry";
import { cyrb53 } from "../../render/cyrb53.mjs";
import { unionBox, type Box } from "../../render/contentBox";
import type { ThumbStageApi, ThumbStageRequest, ThumbStageResult } from "../../render/thumbStageTypes";
import { lookupBox, rememberBox } from "./previewBoxes";

/**
 * Offscreen representative-frame thumbnail service for the Classic mode Animation panel.
 *
 * Lazily boots a single hidden `?stage=1&thumb=1` same-origin iframe (`ThumbStageView`) when the
 * first animation tile enters or approaches the viewport, prioritizes visible tiles ahead of
 * prewarm tiles, caches deterministic results in memory by `(kind, id, signature, stageSize, theme)`,
 * and yields a macrotask between items so the editor UI remains smooth.
 */

export interface AnimationThumbEntry extends ThumbStageResult {
  key: string;
}

interface PendingJob {
  key: string;
  req: ThumbStageRequest;
  priority: number;
  listeners: Set<(entry: AnimationThumbEntry) => void>;
}

const memCache = new Map<string, AnimationThumbEntry>();
const inFlight = new Map<string, PendingJob>();
const queue: PendingJob[] = [];

let pumping = false;
let stageIframe: HTMLIFrameElement | null = null;
let stagePromise: Promise<ThumbStageApi> | null = null;

function itemSignature(kind: "card" | "part", def: CardDef<any> | PartDef<any>): string {
  let defaultsJson = "";
  try {
    defaultsJson = JSON.stringify(def.defaults ?? {});
  } catch {
    defaultsJson = String(def.id);
  }
  let extra = "";
  if (kind === "card") {
    const c = def as CardDef<any>;
    if (c.source === "user") {
      const user = userCardSources();
      const file = user.fileOf[c.id];
      const src = file ? (user.files[file] ?? "") : "";
      if (src) extra = cyrb53(src);
      else if (c.Component) extra = cyrb53(Function.prototype.toString.call(c.Component));
      else if (c.card) extra = cyrb53(Function.prototype.toString.call(c.card));
    }
  }
  return cyrb53(`${kind}:${def.id}:${defaultsJson}:${extra}`);
}

export function buildThumbKey(
  kind: "card" | "part",
  def: CardDef<any> | PartDef<any>,
  width: number,
  height: number,
  themeId?: string,
): string {
  const w = Math.max(16, Math.round(width || 1920));
  const h = Math.max(16, Math.round(height || 1080));
  const theme = themeId || "default";
  const sig = itemSignature(kind, def);
  return `${kind}:${def.id}:${w}x${h}:${theme}:${sig}`;
}

export function getCachedThumb(key: string): AnimationThumbEntry | undefined {
  return memCache.get(key);
}

function dropStageIframe(): void {
  if (stageIframe) {
    try { stageIframe.remove(); } catch { /* Ignore */ }
    stageIframe = null;
  }
  stagePromise = null;
}

function ensureThumbStage(): Promise<ThumbStageApi> {
  if (stagePromise) return stagePromise;
  stagePromise = new Promise<ThumbStageApi>((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("data-pc-thumb-stage", "1");
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.style.cssText = [
      "position:fixed",
      "left:-10000px",
      "top:-10000px",
      "width:1920px",
      "height:1080px",
      "opacity:0",
      "pointer-events:none",
      "border:0",
      "z-index:-1",
    ].join(";");

    const platform = new URLSearchParams(location.search).get("platform") === "browser" ? "&platform=browser" : "";
    iframe.src = `${location.pathname}?stage=1&thumb=1${platform}`;
    stageIframe = iframe;

    let settled = false;
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };

    const tryResolve = () => {
      if (settled) return;
      try {
        const api = (iframe.contentWindow as (Window & { __pcThumbStage?: ThumbStageApi }) | null)?.__pcThumbStage;
        if (api) {
          settled = true;
          cleanup();
          resolve(api);
        }
      } catch (err) {
        settled = true;
        cleanup();
        dropStageIframe();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const onMessage = (e: MessageEvent) => {
      if (e.source === iframe.contentWindow && e.data?.type === "pc-thumb-stage-ready") {
        tryResolve();
      }
    };

    const timer = window.setTimeout(() => {
      tryResolve();
      if (!settled) {
        settled = true;
        cleanup();
        dropStageIframe();
        reject(new Error("Timed out waiting for thumbnail stage iframe"));
      }
    }, 12000);

    window.addEventListener("message", onMessage);
    iframe.addEventListener("load", () => {
      // Allow React's initial useEffect inside ThumbStageView to attach __pcThumbStage.
      window.setTimeout(tryResolve, 0);
    });
    document.body.appendChild(iframe);
  });
  return stagePromise;
}

function finalizeEntry(key: string, req: ThumbStageRequest, raw: ThumbStageResult): AnimationThumbEntry {
  const boxKey = `${req.kind}:${req.id}`;
  const known = lookupBox(boxKey, req.width, req.height);
  const mergedBox: Box | null = known.has ? unionBox(raw.box, known.box) : raw.box;
  if (!known.has && raw.ok) {
    rememberBox(boxKey, req.width, req.height, mergedBox);
  }
  const entry: AnimationThumbEntry = {
    ...raw,
    box: mergedBox,
    key,
  };
  memCache.set(key, entry);
  return entry;
}

async function pumpQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length > 0) {
      queue.sort((a, b) => b.priority - a.priority);
      const job = queue.shift()!;
      if (job.listeners.size === 0) {
        inFlight.delete(job.key);
        continue;
      }
      const cached = memCache.get(job.key);
      if (cached) {
        inFlight.delete(job.key);
        for (const cb of job.listeners) cb(cached);
        continue;
      }

      let res: ThumbStageResult;
      try {
        const stage = await ensureThumbStage();
        res = await stage.sample(job.req);
      } catch (err) {
        console.warn("[animationThumbnails] stage sample error:", err);
        res = { ok: false, t: 0, phase: 0.62, score: 0, box: null, mode: "dom" };
      }

      const entry = finalizeEntry(job.key, job.req, res);
      inFlight.delete(job.key);
      for (const cb of job.listeners) cb(entry);

      // Yield a macrotask between items so pointer/scroll/input events in the editor run without delay.
      await new Promise<void>((r) => window.setTimeout(r, 0));
    }
  } finally {
    pumping = false;
    if (queue.length > 0) void pumpQueue();
  }
}

export function requestAnimationThumb(
  key: string,
  req: ThumbStageRequest,
  priority: number,
  onReady: (entry: AnimationThumbEntry) => void,
): () => void {
  const hit = memCache.get(key);
  if (hit) {
    onReady(hit);
    return () => {};
  }

  let job = inFlight.get(key);
  if (!job) {
    job = { key, req, priority, listeners: new Set() };
    inFlight.set(key, job);
    queue.push(job);
  } else if (priority > job.priority) {
    job.priority = priority;
  }

  job.listeners.add(onReady);
  void pumpQueue();

  return () => {
    const active = inFlight.get(key);
    if (!active) return;
    active.listeners.delete(onReady);
    if (active.listeners.size === 0) {
      const idx = queue.indexOf(active);
      if (idx >= 0) queue.splice(idx, 1);
      inFlight.delete(key);
    }
  };
}

/* ── Shared IntersectionObserver across all visible / near-viewport tiles ──────────────── */

type VisibilityCallback = (priority: number) => void;
const observedCallbacks = new WeakMap<Element, VisibilityCallback>();
let sharedObserver: IntersectionObserver | null = null;

function getSharedObserver(): IntersectionObserver | null {
  if (sharedObserver) return sharedObserver;
  if (typeof IntersectionObserver === "undefined") return null;
  sharedObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const cb = observedCallbacks.get(e.target);
        if (cb) cb(e.intersectionRatio > 0 ? 2 : 1);
      }
    },
    { rootMargin: "260px" },
  );
  return sharedObserver;
}

export function observeThumbElement(el: Element, onVisible: VisibilityCallback): () => void {
  const obs = getSharedObserver();
  if (!obs) {
    onVisible(2);
    return () => {};
  }
  observedCallbacks.set(el, onVisible);
  obs.observe(el);
  return () => {
    observedCallbacks.delete(el);
    obs.unobserve(el);
  };
}

/* ── Diagnostic / probe hook (read + cache reset for determinism verification) ─────────── */

export interface AnimationThumbsDebug {
  clearCache(): void;
  stats(): { cached: number; queued: number; inFlight: number };
}

declare global {
  interface Window {
    __pcAnimationThumbs?: AnimationThumbsDebug;
  }
}

if (typeof window !== "undefined") {
  window.__pcAnimationThumbs = {
    clearCache() {
      memCache.clear();
    },
    stats() {
      return { cached: memCache.size, queued: queue.length, inFlight: inFlight.size };
    },
  };
}
