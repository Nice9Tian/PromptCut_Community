/**
 * The real picture on media cells and thumbnail cards (rules in the header of `thumbs.ts`). Before it is obtained, or when it cannot be, nothing is drawn, and the outer sampled-color background stays visible as before.
 */
import { useEffect, useRef, useState } from "react";
import type { MediaAsset } from "../kernel/project";
import { usePreviewMediaUrl } from "../editor/media/previewUrl";
import { useTierHashes } from "../editor/media/assetTiers";
import { originalHashOf } from "../render/mediaTier";
import { createThumbLoader, fetchableNow, grabFrame, thumbKey, type ThumbKind } from "./thumbs";

const loader = createThumbLoader({ grab: grabFrame });

/** Fetch only once it is near the viewport (a small margin of one extra screen in every direction) */
const NEAR = "120px";
/**
 * When a fetch fails, wait a bit and retry (a freshly imported asset is still uploading, so the asset service
 * answers 404): 2, 4, 8, 15, 15, 15 seconds, then stop. Start over from the beginning when the cell
 * shows up again (panel reopened) or the asset finishes uploading (`pending` changed). This only keeps
 * freshly imported cells from staying on the base color forever.
 */
const RETRY_MS = [2000, 4000, 8000, 15000, 15000, 15000];

/**
 * Get a thumbnail for an asset (and a frame time). Returns a ref to attach to an <img> and a URL: when the URL
 * is null, show nothing. Always null, with no request sent, for audio, no asset, or a preview URL of "" (the
 * remote URL of the online page is not ready yet, or confirmed missing).
 */
export function useThumb(media: MediaAsset | null | undefined, t = 0): { ref: React.RefObject<HTMLImageElement | null>; src: string | null } {
  const kind: ThumbKind | null = media?.kind === "video" ? "video" : media?.kind === "image" ? "image" : null;
  const url = usePreviewMediaUrl(kind ? media : null);
  const ref = useRef<HTMLImageElement | null>(null);
  const key = kind && url ? thumbKey(url, kind, t) : "";
  const [attempt, setAttempt] = useState(0);
  const pending = !!media?.pending;
  // Do not fetch until the asset service has received all of this one (otherwise a run of 404s in the console right after import); once complete, start fetching as soon as the polling result changes
  const tiers = useTierHashes();
  const canFetch = !!url && fetchableNow(url, tiers, pending, media ? originalHashOf(media) : null);
  useEffect(() => setAttempt(0), [key, pending]);
  useEffect(() => (key ? loader.watch(key, (v) => setGot({ key, src: v })) : undefined), [key]);
  const [got, setGot] = useState<{ key: string; src: string } | null>(() => (key ? (() => { const s = loader.peek(key); return s ? { key, src: s } : null; })() : null));

  useEffect(() => {
    if (!key || !kind || !canFetch) return;
    const hit = loader.peek(key);
    if (hit) { setGot({ key, src: hit }); return; }
    const el = ref.current;
    let cancel: (() => void) | null = null;
    let retry = 0;
    const start = () => {
      if (cancel) return;
      cancel = loader.request(url, kind, t, (v) => {
        if (v) { setGot({ key, src: v }); return; }
        if (attempt < RETRY_MS.length) retry = window.setTimeout(() => setAttempt((n) => n + 1), RETRY_MS[attempt]);
      });
    };
    const stop = () => { cancel?.(); cancel = null; window.clearTimeout(retry); };
    if (!el || typeof IntersectionObserver === "undefined") { start(); return stop; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) start();
      else stop();
    }, { rootMargin: NEAR });
    io.observe(el);
    return () => { io.disconnect(); stop(); };
    // The ticket in the url rotates; if the key is unchanged, do not refetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, pending, canFetch]);

  return { ref, src: got && got.key === key ? got.src : null };
}

/** The image laid over the cell / thumbnail card base color; a transparent placeholder when nothing was fetched (kept so the viewport observer can still measure it) */
export function ThumbImg({ thumb }: { thumb: { ref: React.RefObject<HTMLImageElement | null>; src: string | null } }) {
  return <img ref={thumb.ref} className="thumb-img" alt="" draggable={false} data-pcm="thumb-img" data-ready={thumb.src ? "1" : undefined}
    src={thumb.src ?? undefined} style={thumb.src ? undefined : { opacity: 0 }} />;
}
