import { reachableMediaIds } from "../kernel/cutIdentity.mjs";
import type { MediaAsset, Project } from "../kernel/project";
import { playableOnThisHost, probePlayable, shouldProbe } from "./playability.ts";

/**
 * "Which URL to play at this moment": asset tier switch criterion
 * (`docs/semantics/product/asset-service.md` "Two tiers of assets", "Pull";
 * `docs/plan/c66-design.md` section 4).
 *
 * Placed in src/render/ rather than src/editor/ because stage bundles (preview / prerender / export
 * page) must also import it: the stage cannot reach any module on the editor side.
 *
 * # Who uses it (T1a review #5)
 *
 * Only a few paths for **real-time playback**: `VideoTrack` in stage (video slots and image
 * layers), `PixelMappedMedia` in `FrameScene` live path, and sound layers in editor main document
 * (`AudioLayer` in `MediaLayers`). Export, prerender, `see_frames`, and placeholder path in
 * `FrameScene` **always use `media.url` (original-size asset)** without passing through here:
 * export and pixel-level inspection only use original-size assets.
 *
 * # Rules
 *
 * `localHashes` (identifier retained) = **set of hashes reported as `complete` by the currently
 * connected asset service**; the criterion only checks this (`mechanism/asset-service.md`
 * "Ask only the asset service for sync status"); whether local cache hit disk or what is written
 * in project document does not count. The set is obtained by main document polling
 * `GET media/<hash>/chunks` every 2 seconds (`src/editor/media/assetTiers.ts`); once polled, the
 * set always contains a **marker** (`TIERS_KNOWN_LOCAL` / `TIERS_KNOWN_REMOTE`), distinguishing
 * "polled, none complete" from "not yet polled".
 *
 *   0. Set is empty (not yet polled) → provide small-size asset if available, otherwise original-size
 *      asset: the first frame on opening a project does not pull original-size asset directly
 *      (A1 "small first, then original").
 *   1. Original-size asset in set → original-size asset; but when **this device cannot play the
 *      original-size asset** (local cache `playability.ts`) and small-size asset is also in set →
 *      small-size asset.
 *   2. Original-size asset not in set, small-size asset in set → small-size asset (small first, then original).
 *   3. Neither tier in set → original-size asset ("pull original-size asset directly when no small-size
 *      asset exists yet"; when neither tier has finished uploading, it can only give original-size
 *      asset, and that layer waits for uploader).
 *
 * When both original-size and small-size assets are present but playability is still unknown: provide
 * small-size asset first and probe in background; if probed playable, switch back to original-size
 * asset on next render ("pull small-size asset first for display, then pull original-size asset to
 * replace it"). Only probe when both tiers are truly available: do not fetch the first frame of
 * original-size asset in vain.
 *
 * URLs do not include extensions: hash is identity, Content-Type is provided by server based on
 * extension recorded when stored (resolveHashFile / contentTypeForExt in server/vite-plugin-media.ts).
 *
 * `opts.cloudBase`: if provided, replaces `/@media/...` with an absolute URL (online browser mode
 * calls remote asset service directly).
 * `opts.playable`: where to read playability from, defaults to local cache (unit test injection).
 */

/** Polled once, currently connected to local asset service. */
export const TIERS_KNOWN_LOCAL = "@known:local";
/** Polled once, currently connected to remote asset service (playability probe uses remote timeout). */
export const TIERS_KNOWN_REMOTE = "@known:remote";

type TierMedia = Pick<MediaAsset, "url" | "hash" | "tiers"> & Partial<Pick<MediaAsset, "ext" | "kind" | "width" | "height">>;
type HashList = ReadonlySet<string> | readonly string[];

export interface TierChoice {
  /** URL to mount. */
  url: string;
  /** Which tier is mounted. */
  tier: "small" | "original" | "none";
  /** Polled once, but mounted tier is not yet complete on current asset service: this layer is waiting for uploader. */
  awaiting: boolean;
}

function asSet(list: HashList): ReadonlySet<string> {
  return list instanceof Set ? list as ReadonlySet<string> : new Set(list as readonly string[]);
}

/* ------------------------------------------------------------------ *
 * Online browser mode and media gate (`docs/plan/c10a-contract.md` section 8; semantics
 * `product/platforms.md` "Online browser": "Media gate" and "Lowest tier")
 * ------------------------------------------------------------------ */

/**
 * Tier selection policy on this side (main document or stage, one copy each). Defaults to desktop
 * runtime environment, identical to C6.6.
 *
 * - `smallOnly`: lowest tier. **Video assets only pull small size**: always provides small size if
 *   available (when polled once and not yet complete, this layer waits for uploader without
 *   pulling); video without small size displays a "Waiting for uploader" badge and placeholder on
 *   this layer, **does not pull original size** (except export, which does not pass through here).
 * - `decodeMaxPixels`: media gate decoding limit (measured once on open, remains unchanged during
 *   this session; `src/online/mediaGate.ts`). Video assets whose width × height exceeds it are
 *   treated like `smallOnly` (evaluated per asset, not an all-or-nothing cutoff for the entire
 *   device); those not exceeding it proceed normally. null = unlimited (desktop, not yet measured).
 * - `smallFirst`: media gate network speed (monitors actual asset download speed, adjusted
 *   dynamically). Slow: when both tiers exist, display small size first and probe original size in
 *   background (fetch its first frame), switching to original size once confirmed playable; Fast:
 *   when both tiers exist, pull only original size (do not mount small size first). Provided only
 *   on online pages.
 * - `remote`: in online browser mode there is no local editor process proxying `/@media/*`, so
 *   hash-addressed URLs are replaced with remote asset service's
 *   `GET <base>/media/<hash>?t=<read-only ticket>` (`server/asset-service.ts` "Read/write with ticket":
 *   query string only accepts `r` tickets). `<video>` / `<img>` cannot carry `Authorization`
 *   headers, so tickets go through query strings.
 *
 * The stage is a separate document; its copy is pushed by parent page via RPC `setMediaPolicy` (`stageRpc.ts`).
 */
export interface MediaTierPolicy {
  smallOnly: boolean;
  decodeMaxPixels: number | null;
  smallFirst: boolean;
  /** Online pages must not request the local /@media route before the remote URL is ready. */
  online: boolean;
  remote: { base: string; ticket: string | null } | null;
}
// Vite online build replaces constants by full property name; import.meta.env does not exist in Node unit tests.
let policy: MediaTierPolicy = { smallOnly: false, decodeMaxPixels: null, smallFirst: true, online: typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1", remote: null };

export function setMediaTierPolicy(next: Partial<MediaTierPolicy>): void {
  const remote = next.remote === undefined ? policy.remote
    : next.remote && next.remote.base ? { base: next.remote.base.replace(/\/+$/, ""), ticket: next.remote.ticket || null } : null;
  const prev = policy;
  const decode = next.decodeMaxPixels === undefined ? policy.decodeMaxPixels
    : typeof next.decodeMaxPixels === "number" && Number.isFinite(next.decodeMaxPixels) && next.decodeMaxPixels > 0 ? Math.floor(next.decodeMaxPixels) : null;
  policy = { smallOnly: next.smallOnly ?? policy.smallOnly, decodeMaxPixels: decode, smallFirst: next.smallFirst ?? policy.smallFirst, online: next.online ?? policy.online, remote };
  if (prev.smallOnly === policy.smallOnly && prev.decodeMaxPixels === policy.decodeMaxPixels && prev.smallFirst === policy.smallFirst && prev.online === policy.online
    && prev.remote?.base === policy.remote?.base && prev.remote?.ticket === policy.remote?.ticket) {
    policy = prev; // Unchanged: do not replace object, do not notify (subscribers check by object identity)
    return;
  }
  for (const l of [...policyListeners]) { try { l(); } catch { /* A broken subscriber does not affect the others */ } }
}

const policyListeners = new Set<() => void>();
/** Notifies when tier selection policy changes (online page remote asset service ready, ticket changed, media gate result changed); returns unsubscribe. Media preview in editor relies on this to redraw. */
export function subscribeMediaTierPolicy(cb: () => void): () => void {
  policyListeners.add(cb);
  return () => { policyListeners.delete(cb); };
}

export function mediaTierPolicy(): MediaTierPolicy {
  return policy;
}

const IMAGE_EXT = /^(png|jpe?g|gif|webp|avif|bmp|svg|tiff?|heic)$/i;
/** Assets that by C6.6 design never have a small-size asset tier: image, audio. */
function noSmallTierByDesign(media: TierMedia): boolean {
  if (media.kind === "audio" || media.kind === "image") return true;
  const ext = String(media.ext || "").replace(/^\./, "");
  return IMAGE_EXT.test(ext);
}

/**
 * Whether this asset only uses small size: lowest tier (`smallOnly`), or width × height exceeds
 * media gate decoding limit (`decodeMaxPixels`; assets without recorded dimensions are not judged
 * by it). Images and audio are not handled here (they have no small size by design, see `chooseTier`).
 */
export function smallOnlyFor(media: Pick<TierMedia, "width" | "height">, p: Pick<MediaTierPolicy, "smallOnly" | "decodeMaxPixels"> = policy): boolean {
  if (p.smallOnly) return true;
  const limit = p.decodeMaxPixels;
  if (limit === null || !(limit > 0)) return false;
  const w = Number(media.width), h = Number(media.height);
  if (!(w > 0) || !(h > 0)) return false;
  return w * h > limit;
}

/** Converts hash-addressed URL (`/@media/<hash>`) to remote asset service retrieval URL; leaves other URLs as is. */
export function remoteMediaUrl(url: string, remote: MediaTierPolicy["remote"] = policy.remote): string {
  if (!remote || !url) return url;
  const hash = hashFromUrl(url);
  if (!hash) return url;
  const q = remote.ticket ? `?t=${encodeURIComponent(remote.ticket)}` : "";
  return `${remote.base}/media/${hash}${q}`;
}

const resolvedParamsCache = new WeakMap<object, WeakMap<MediaTierPolicy, Record<string, unknown>>>();

/**
 * When the stage passes parameters to cards, replace strings of the form `/@media/<hash>[.extension]`
 * with the remote asset service address (e.g. `/media-s/<sid>/media/<hash>`).
 * In the desktop runtime environment (`!p.online && !p.remote`), return as-is; on online pages
 * before the remote address is ready (`p.online && !p.remote`), replace with an empty string
 * to avoid requesting non-existent `/@media/…`.
 */
export function resolveCardParams<T extends Record<string, unknown>>(params: T, p: MediaTierPolicy = policy): T {
  if (!params || typeof params !== "object" || (!p.online && !p.remote)) return params;
  let byPolicy = resolvedParamsCache.get(params);
  const hit = byPolicy?.get(p);
  if (hit) return hit as T;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "string" || !hashFromUrl(v)) continue;
    const mapped = p.remote ? remoteMediaUrl(v, p.remote) : "";
    if (mapped === v) continue;
    if (!out) out = { ...params };
    out[k] = mapped;
  }
  const result = (out as T) ?? params;
  if (!byPolicy) {
    byPolicy = new WeakMap();
    resolvedParamsCache.set(params, byPolicy);
  }
  byPolicy.set(p, result);
  return result;
}

export function chooseTier(
  media: TierMedia,
  localHashes: HashList = [],
  opts: { cloudBase?: string; playable?: (hash: string) => boolean | undefined; probe?: boolean; smallOnly?: boolean; decodeMaxPixels?: number | null; smallFirst?: boolean; online?: boolean; remote?: MediaTierPolicy["remote"] } = {},
): TierChoice {
  const original = originalUrl(media);
  const complete = asSet(localHashes);
  const originalHash = (media.tiers?.original || media.hash || hashFromUrl(original) || "").toLowerCase();
  const smallHash = (media.tiers?.small || "").toLowerCase();
  const smallTier = !!smallHash && smallHash !== originalHash;
  const small = smallTier ? `/@media/${smallHash}` : null;
  const remote = opts.remote !== undefined ? opts.remote : policy.remote;
  const pick = (tier: "small" | "original", awaiting: boolean): TierChoice => {
    const url = tier === "small" && small ? small : original;
    if ((opts.online ?? policy.online) && !remote && hashFromUrl(url)) return { url: "", tier: "none", awaiting: true };
    return { url: remoteMediaUrl(withBase(url, opts.cloudBase), remote), tier: url ? tier : "none", awaiting: awaiting && !!url && !!originalHash };
  };
  /*
   * Small-only (lowest tier, or exceeds media gate decoding limit; c10a section 8 approach). Video
   * addressed by hash without a small tier is given no URL and waits for uploader; with small tier:
   * provide it before asking asset service (the "small" in "small first, then original"); if asked
   * and not yet complete, wait without falling back to original size. Legacy assets without hashes
   * during migration bypass asset service and are provided as is (only one copy exists anyway).
   */
  const smallOnly = smallOnlyFor(media, { smallOnly: opts.smallOnly ?? policy.smallOnly, decodeMaxPixels: opts.decodeMaxPixels !== undefined ? opts.decodeMaxPixels : policy.decodeMaxPixels });
  if (smallOnly) {
    if (!originalHash) return pick("original", false);
    /*
     * By C6.6 design, image and audio do not generate small-size assets (`c66-design.md` "Only for
     * video"). Under the literal "wait for uploader if no small size", they would wait forever, so
     * "pull small size only" is enforced only for video; images and audio receive original size as
     * usual [deviation, see report].
     */
    if (!smallTier && noSmallTierByDesign(media)) return pick("original", false);
    if (!small) return { url: "", tier: "none", awaiting: true };
    if (!complete.size || complete.has(smallHash)) return pick("small", false);
    return { url: "", tier: "none", awaiting: true };
  }
  // 0. Asset service not yet queried: small first, then original
  if (!complete.size) return pick(small ? "small" : "original", false);
  const hasOriginal = !!originalHash && complete.has(originalHash);
  const hasSmall = smallTier && complete.has(smallHash);
  if (hasOriginal) {
    if (!hasSmall) return pick("original", false);
    const playable = (opts.playable ?? playableOnThisHost)(originalHash);
    if (playable === true) return pick("original", false);
    // The playability probe is itself a fetch. Wait for the hosted asset address
    // just as the visible media element does.
    if (playable === undefined && opts.probe !== false && shouldProbe(originalHash)
      && !((opts.online ?? policy.online) && !remote && hashFromUrl(original))) {
      void probePlayable(originalHash, remoteMediaUrl(withBase(original, opts.cloudBase), remote), media.ext, media.kind === "audio" ? "audio" : "video",
        { remote: !!opts.cloudBase || !!remote || complete.has(TIERS_KNOWN_REMOTE) });
    }
    // Media gate network speed is fast enough (detected by stage on online page, `netSpeed.ts`):
    // pull original size only, do not mount small size first; playability is still probed in
    // background, falling back to small size if unplayable
    if (playable === undefined && (opts.smallFirst ?? policy.smallFirst) === false) return pick("original", false);
    return pick("small", false);
  }
  if (hasSmall) return pick("small", false);
  return pick("original", true);
}

export function playbackUrl(
  media: TierMedia,
  localHashes: HashList = [],
  opts: { cloudBase?: string; playable?: (hash: string) => boolean | undefined; probe?: boolean; smallOnly?: boolean; decodeMaxPixels?: number | null; smallFirst?: boolean; online?: boolean; remote?: MediaTierPolicy["remote"] } = {},
): string {
  return chooseTier(media, localHashes, opts).url;
}

/**
 * Which URL to use for **human-facing media preview** in editor (thumbnails in media library,
 * waveforms in timeline and media library, still frames of transition cards).
 *
 * - Desktop runtime environment (`policy.online` is false): `media.url` as is, identical to before.
 * - Online browser mode: no local editor process exists, so the `/@media/*` route does not exist
 *   (the two `404 /@media/<original-size hash>` errors on mobile during c10a 2026-09-27 Alibaba Cloud
 *   demo were sent using `media.url` by media library thumbnail `<video src>` and timeline waveform
 *   `fetch`). Here, URLs are replaced with remote asset service URLs according to tier selection
 *   criteria: video using small-only (lowest tier, exceeding decoding limit) receives only small-size
 *   asset (or "" if missing, without pulling original size); others receive the small tier in
 *   "small first, then original"; returns "" when remote URL is not yet ready. The caller mounts
 *   no src and sends no request upon receiving "".
 *   Does not probe playability (`probe: false`): previews are just thumbnails, not worth fetching
 *   the first frame of original size.
 */
export function previewMediaUrl(media: TierMedia, p: MediaTierPolicy = policy): string {
  if (!p.online) return media.url;
  return chooseTier(media, [], { probe: false, smallOnly: p.smallOnly, decodeMaxPixels: p.decodeMaxPixels, online: true, remote: p.remote }).url;
}

/**
 * Which URL to use where **original size** is required (measuring asset dimensions, packaging
 * and saving, rendering cards into canvas; C10 section 10 / final item of handoff doc section 4).
 * - Desktop runtime environment: `media.url` as is, identical to before.
 * - Online browser mode: original size on remote asset service (with read-only ticket); returns ""
 *   when remote URL is not yet ready (caller sends no request). Assets that use small-only (lowest
 *   tier, exceeding decoding limit) normally do not pull original size; caller decides whether to
 *   use it (`smallOnlyFor`).
 */
export function originalMediaUrl(media: Pick<MediaAsset, "url" | "hash">, p: MediaTierPolicy = policy): string {
  if (!p.online) return media.url;
  const url = originalUrl(media);
  if (!url) return "";
  if (!p.remote) return hashFromUrl(url) ? "" : url;
  return remoteMediaUrl(url, p.remote);
}

/** URL of original-size asset: `media.url` is identity (`/@media/<original hash>`); construct one only if no URL but has hash */
function originalUrl(media: Pick<MediaAsset, "url" | "hash">): string {
  if (media.url) return media.url;
  return media.hash ? `/@media/${media.hash}` : "";
}

function withBase(url: string, base?: string): string {
  if (!base || !url.startsWith("/@media/")) return url;
  return base.replace(/\/+$/, "") + url;
}

/** Asset hash in URL (/@media/<hash> or /@media/<hash>.<ext>); returns null if not a hash URL */
export function hashFromUrl(url: string): string | null {
  const m = /^\/@media\/([0-9a-f]{64})(?:\.[A-Za-z0-9]+)?$/i.exec(String(url || "").split(/[?#]/, 1)[0]);
  return m ? m[1].toLowerCase() : null;
}

/** Original-size hash of asset (only for hash-addressed; returns null if stored by filename during migration) */
export function originalHashOf(media: Pick<MediaAsset, "url" | "hash" | "tiers">): string | null {
  const h = (media.tiers?.original || media.hash || hashFromUrl(media.url) || "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}

/** Small-size hash of asset (null if no small-size asset or small-size asset is original-size asset) */
export function smallHashOf(media: Pick<MediaAsset, "url" | "hash" | "tiers">): string | null {
  const s = (media.tiers?.small || "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) && s !== originalHashOf(media) ? s : null;
}

/* ------------------------------------------------------------------ *
 * Prefetch order and export interception (C6.6 Section 4)
 * ------------------------------------------------------------------ */

/** Sort asset IDs by clip order on timeline; assets unused on timeline are placed last (in asset table order) */
function mediaInTimelineOrder(project: Pick<Project, "tracks" | "media">): MediaAsset[] {
  const firstUse = new Map<string, number>();
  for (const tr of project.tracks ?? []) {
    for (const c of tr.clips ?? []) {
      if (!c.mediaId) continue;
      const at = Number.isFinite(c.start) ? c.start : 0;
      const had = firstUse.get(c.mediaId);
      if (had === undefined || at < had) firstUse.set(c.mediaId, at);
    }
  }
  const index = new Map((project.media ?? []).map((m, i) => [m.id, i]));
  return [...(project.media ?? [])].sort((a, b) => {
    const ua = firstUse.get(a.id), ub = firstUse.get(b.id);
    if (ua !== undefined && ub !== undefined) return ua - ub || (index.get(a.id)! - index.get(b.id)!);
    if (ua !== undefined) return -1;
    if (ub !== undefined) return 1;
    return index.get(a.id)! - index.get(b.id)!;
  });
}

export interface PrefetchItem {
  hash: string;
  tier: "small" | "original";
  mediaId: string;
}

/**
 * Prefetch queue after opening a project (A1 "prefetch queue"): for each hash referenced by the
 * project, **all small-size assets first, then all original-size assets**, within each tier ordered
 * by clip order on the timeline. Each hash appears only once. Only includes hash-addressed assets.
 */
export function prefetchOrder(project: Pick<Project, "tracks" | "media">): PrefetchItem[] {
  const ordered = mediaInTimelineOrder(project);
  const seen = new Set<string>();
  const out: PrefetchItem[] = [];
  const add = (hash: string | null, tier: PrefetchItem["tier"], mediaId: string) => {
    if (!hash || seen.has(hash)) return;
    seen.add(hash);
    out.push({ hash, tier, mediaId });
  };
  for (const m of ordered) add(smallHashOf(m), "small", m.id);
  for (const m of ordered) add(originalHashOf(m), "original", m.id);
  return out;
}

export interface MissingOriginal {
  mediaId: string;
  name: string;
  hash: string;
}

/**
 * Interception before export (A1 "export uses original-size assets only"): among hash-addressed
 * assets used on the timeline, those whose original-size asset is not yet `complete` on the current
 * asset service. `complete` is the set of hashes reported as complete by the current asset service.
 * Empty array = can export. Assets without hashes during migration are not intercepted here (they
 * do not go through the asset service).
 */
export function missingOriginals(project: Pick<Project, "tracks" | "media">, complete: HashList): MissingOriginal[] {
  const have = asSet(complete);
  // Assets used in cuts referenced by cut segments also count (kernel/cutIdentity.mjs): export needs to render them
  const used = reachableMediaIds(project);
  const out: MissingOriginal[] = [];
  const seen = new Set<string>();
  for (const m of mediaInTimelineOrder(project)) {
    if (!used.has(m.id)) continue;
    const h = originalHashOf(m);
    if (!h || have.has(h) || seen.has(h)) continue;
    seen.add(h);
    out.push({ mediaId: m.id, name: m.name || h.slice(0, 12), hash: h });
  }
  return out;
}

export interface ExportGateResult {
  ok: boolean;
  /** When intercepted, it is `awaiting-uploader` */
  code?: "awaiting-uploader";
  message?: string;
  missing: MissingOriginal[];
}

/**
 * Interception before export, in the shape of "query one hash": `has(hash)` returns whether this
 * original-size asset is `complete` on the **current asset service** (treated as absent if
 * unqueryable). Only queries original sizes of hash-bearing assets referenced by clips, not small
 * sizes.
 * The page (`src/editor/media/assetTiers.ts`) and the prerender process's `/api/export`
 * (`server/export-originals.ts`) share this criterion.
 */
export async function checkExportOriginals(
  { project, has }: { project: Pick<Project, "tracks" | "media">; has: (hash: string) => boolean | Promise<boolean> },
): Promise<ExportGateResult> {
  const complete: string[] = [];
  for (const m of missingOriginals(project, [])) {
    try { if (await has(m.hash)) complete.push(m.hash); } catch { /* If unqueryable, treat as incomplete */ }
  }
  const missing = missingOriginals(project, complete);
  if (!missing.length) return { ok: true, missing: [] };
  return { ok: false, code: "awaiting-uploader", message: awaitingUploaderMessage(missing), missing };
}

/** Notice text for "Waiting for uploader" (shown to the user when export is intercepted) */
export function awaitingUploaderMessage(missing: readonly MissingOriginal[]): string {
  const names = missing.map((m) => m.name);
  const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? ` and ${names.length} more` : "");
  // Follow glossary.md "original-size asset, small-size asset" (replacing old terms "original video"
  // and "small version"); UI text and code comments both use the new terms
  return `Waiting for uploader: the original sizes of these media have not finished uploading. Export uses only original media sizes, so export again once the upload is done: ${shown}`;
}
