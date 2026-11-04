import { tr } from "../i18n/index.ts";
/**
 * Real images for mobile app media cells and thumbnail cards (`docs/plan/mobile-online-task.md`, pending user
 * items, item 5, user decision 2026-10-21: "yes"):
 * for video, grab the first frame (for a segment on the timeline, the frame at its in point); for images, grab the thumbnail.
 *
 * - **How assets are fetched**: only use the ready-made asset preview URL from the editor, `usePreviewMediaUrl`
 *   (`src/editor/media/previewUrl.ts` → `previewMediaUrl` in `render/mediaTier.ts`). On the online page it
 *   gives the remote asset service address carrying a read-only ticket (`product/asset-service.md`,
 *   "Read and write by ticket"), small first, then large; when the remote address is not ready or confirmed
 *   missing it gives "", and no request is sent. No separate fetch path is created, and local paths are not touched.
 * - **On demand**: a cell is queued only once it is near the viewport (`IntersectionObserver`); ones scrolled
 *   away before their turn are removed.
 * - **Throttling**: at most `MAX_ACTIVE` decodes at the same time, the rest queue; even with many assets on a phone
 *   they are not all decoded at once.
 * - **Cache**: keyed by "URL with the ticket query string removed + frame time", stored as a small JPEG (data URL),
 *   the most recently used `CACHE_MAX` are kept; ticket rotation does not refetch, and closing and reopening the
 *   panel does not refetch.
 * - **Fetch failure**: decode failure, timeout, or a cross-origin image that cannot be drawn to the canvas all count as
 *   not fetched; the cell keeps its original sampled base color plus the type icon, with no blank or broken image;
 *   failures are not cached, and it retries the next time the cell appears in the viewport.
 */

/** Maximum thumbnail width (pixels): a cell / thumbnail card is at most about 110 CSS pixels wide, enough for a 2x screen */
export const THUMB_W = 224;
/** Maximum number of simultaneous decodes */
export const MAX_ACTIVE = 2;
/** Number of cached images */
export const CACHE_MAX = 160;
/** Maximum wait per image (milliseconds); only to prevent hangs */
export const GRAB_TIMEOUT_MS = 20000;

export type ThumbKind = "video" | "image";

/** Cache key: the URL with the query string and anchor removed (the online query string is a rotating ticket); for video, plus the frame time (to 0.01 seconds) */
export function thumbKey(url: string, kind: ThumbKind, t = 0): string {
  const base = String(url || "").split(/[?#]/, 1)[0];
  return kind === "video" ? `${base}@${(Math.max(0, t) || 0).toFixed(2)}` : base;
}

/** Video frame time: clamped to [0, duration - one frame]; 0 is replaced by a tiny value so the browser really fires a seeked event */
export function seekTarget(t: number, duration: number): number {
  const d = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const x = Math.min(Math.max(0, Number.isFinite(t) ? t : 0), Math.max(0, d - 0.04));
  return x > 0 ? x : 0.001;
}

/** Scale down to a width of at most maxW, keeping the aspect ratio, at least 1 pixel */
export function fitSize(w: number, h: number, maxW = THUMB_W): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const s = Math.min(1, maxW / w);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** The hash-addressed part of the URL (`/@media/<hash>` or `.../media/<hash>` of the remote asset service) */
export function urlHash(url: string): string | null {
  const m = /\/(?:@media|media)\/([0-9a-f]{64})(?:[.?#/]|$)/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Whether fetching now would be a wasted trip (the asset service has not received all of it yet and would answer 404): the criterion
 * only asks the asset service (`mechanism/asset-service.md`, "Sync state only asks the asset service"),
 * that is, the "fully received hashes" set `tierHashes` obtained by the editor's 2-second polling (with a marker; non-empty only after it has been asked).
 * - Already asked: fetch only if the hash in the URL (or the original-size hash of this asset) is in the set;
 * - Not asked yet: if the asset is still being stored (`pending`), wait; otherwise fetch first (on failure, retry with backoff);
 * - A URL that is not hash-addressed (old asset): fetch as usual.
 */
export function fetchableNow(url: string, tierHashes: readonly string[], pending: boolean, originalHash?: string | null): boolean {
  const h = urlHash(url);
  if (!h) return true;
  // Once the original size is fully received, polling no longer asks for the small size (`hashesToAsk` in `assetTiers.ts`); the small size is uploaded before the original, so being in the set as the original also counts
  if (tierHashes.length) return tierHashes.includes(h) || (!!originalHash && tierHashes.includes(originalHash.toLowerCase()));
  return !pending;
}

export type Grab = (url: string, kind: ThumbKind, t: number) => Promise<string>;

interface Job { key: string; url: string; kind: ThumbKind; t: number; wanted: number; promise: Promise<string | null>; resolve: (v: string | null) => void }

/**
 * Queue and cache for fetching thumbnails. `grab` really decodes (`grabFrame` in the browser, a fake is injected in unit tests).
 * `request` returns a cancel function: if the request is still queued and nobody wants it anymore, it is removed and not fetched.
 */
export function createThumbLoader(opts: { grab: Grab; maxActive?: number; cacheMax?: number }) {
  const maxActive = opts.maxActive ?? MAX_ACTIVE;
  const cacheMax = opts.cacheMax ?? CACHE_MAX;
  const cache = new Map<string, string>();
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  let active = 0;
  /** Who is waiting for a given image: also notify it when it is fetched elsewhere (the same asset at the same time appears once in a cell and once in a thumbnail card, so the one that failed first need not wait for a retry) */
  const watchers = new Map<string, Set<(v: string) => void>>();

  const remember = (key: string, v: string) => {
    const fresh = !cache.has(key);
    cache.delete(key);
    cache.set(key, v);
    if (fresh) for (const w of [...(watchers.get(key) ?? [])]) w(v);
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value as string);
  };

  const pump = () => {
    while (active < maxActive && queue.length) {
      const job = queue.shift()!;
      if (job.wanted <= 0) { jobs.delete(job.key); job.resolve(null); continue; }
      active++;
      opts.grab(job.url, job.kind, job.t).then(
        (v) => { if (v) remember(job.key, v); job.resolve(v || null); },
        () => job.resolve(null),
      ).finally(() => { active--; jobs.delete(job.key); pump(); });
    }
  };

  return {
    /** The cached image (moved to the back in most-recently-used order) */
    peek(key: string): string | null {
      const v = cache.get(key);
      if (v === undefined) return null;
      remember(key, v);
      return v;
    },
    request(url: string, kind: ThumbKind, t: number, onDone: (v: string | null) => void): () => void {
      const key = thumbKey(url, kind, t);
      const hit = this.peek(key);
      if (hit) { onDone(hit); return () => {}; }
      let job = jobs.get(key);
      if (!job) {
        let resolve!: (v: string | null) => void;
        const promise = new Promise<string | null>((r) => { resolve = r; });
        job = { key, url, kind, t, wanted: 0, promise, resolve };
        jobs.set(key, job);
        queue.push(job);
      }
      const j = job;
      j.wanted++;
      let live = true;
      void j.promise.then((v) => { if (live) onDone(v); });
      pump();
      return () => {
        if (!live) return;
        live = false;
        j.wanted--;
        if (j.wanted <= 0) {
          const i = queue.indexOf(j);
          if (i >= 0) { queue.splice(i, 1); jobs.delete(j.key); j.resolve(null); }
        }
      };
    },
    /** Callback once this image is fetched (no matter who asked for it); returns an unsubscribe function */
    watch(key: string, fn: (v: string) => void): () => void {
      let set = watchers.get(key);
      if (!set) { set = new Set(); watchers.set(key, set); }
      set.add(fn);
      return () => { set!.delete(fn); if (!set!.size) watchers.delete(key); };
    },
    /** For unit tests: queued count, decoding count, cached count */
    stats() { return { queued: queue.length, active, cached: cache.size }; },
  };
}

const withTimeout = <T,>(p: Promise<T>, ms: number, cleanup: () => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(tr("Thumbnail fetch timed out"))); }, ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });

function toDataUrl(src: CanvasImageSource, w: number, h: number): string {
  const size = fitSize(w, h);
  if (!size.w) throw new Error(tr("No frame size"));
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(tr("No 2D canvas"));
  ctx.drawImage(src, 0, 0, size.w, size.h);
  // A cross-origin image without CORS taints the canvas, so this throws → counts as not fetched
  return canvas.toDataURL("image/jpeg", 0.72);
}

/** Really decode one frame in the browser and scale it into a small JPEG. For video, use a <video> that is not attached to the page, and release its source right after the grab */
export const grabFrame: Grab = (url, kind, t) => {
  if (kind === "image") {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    const p = new Promise<string>((resolve, reject) => {
      img.onload = () => { try { resolve(toDataUrl(img, img.naturalWidth, img.naturalHeight)); } catch (e) { reject(e); } };
      img.onerror = () => reject(new Error(tr("Image cannot be decoded")));
    });
    img.src = url;
    return withTimeout(p, GRAB_TIMEOUT_MS, () => { img.src = ""; }).finally(() => { img.onload = img.onerror = null; });
  }
  const v = document.createElement("video");
  v.crossOrigin = "anonymous";
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  const release = () => { v.removeAttribute("src"); try { v.load(); } catch { /* Already released */ } };
  const p = new Promise<string>((resolve, reject) => {
    v.onerror = () => reject(new Error(tr("Video cannot be decoded")));
    v.onloadedmetadata = () => {
      v.onseeked = () => { try { resolve(toDataUrl(v, v.videoWidth, v.videoHeight)); } catch (e) { reject(e); } };
      v.currentTime = seekTarget(t, v.duration);
    };
  });
  v.src = url;
  return withTimeout(p, GRAB_TIMEOUT_MS, release).finally(() => { v.onerror = v.onloadedmetadata = v.onseeked = null; release(); });
};
