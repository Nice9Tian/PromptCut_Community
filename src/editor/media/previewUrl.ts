import { useSyncExternalStore } from "react";
import type { MediaAsset } from "../../kernel/project";
import { confirmedMissing } from "../../audio/missingMaterialRecord";
import { mediaTierPolicy, previewMediaUrl, subscribeMediaTierPolicy, type MediaTierPolicy } from "../../render/mediaTier";

/**
 * The address of media previews (thumbnails, waveforms, still frames) in the editor; redraws when the
 * tier selection policy changes (`previewMediaUrl` in `mediaTier.ts`).
 * In the desktop runtime it is `media.url` as is; in online browser mode it becomes the address of the
 * remote asset service, and while not ready it is "" (no src is set, no request is sent).
 */
export function useMediaTierPolicy(): MediaTierPolicy {
  return useSyncExternalStore(subscribeMediaTierPolicy, mediaTierPolicy, mediaTierPolicy);
}

export function usePreviewMediaUrl(media: Pick<MediaAsset, "url" | "hash" | "tiers" | "ext" | "kind"> | undefined | null): string {
  const policy = useMediaTierPolicy();
  // The address of an asset judged "confirmed missing" is left uncleared (the record must match it), but
  // nothing can be fetched from that address: thumbnails and waveforms are never attached and no request is sent
  if (media && confirmedMissing(media as MediaAsset)) return "";
  return media ? previewMediaUrl(media, policy) : "";
}

/** For things like waveforms that must be read in full and then decoded, the cache strips the query
 * string from the address (the online query string is a rotating ticket; a ticket change must not cause a
 * re-download) */
export function previewCacheKey(url: string): string {
  return String(url || "").split(/[?#]/, 1)[0];
}
