import { actions, getState, subscribe } from "../../store/project";
import type { MediaAsset } from "../../kernel/project";
import { isViewOnly } from "./viewOnly";
import { confirmedMissing, MISSING_NAME_MARK, hasMissingMark, withoutMissingMark } from "../../audio/missingMaterialRecord";
import { publishMissingMaterials, type MissingMaterialNotice } from "./missingMaterialBus";
import { onGoneConversion } from "../sync/recoveryAssociation";
import { transcodeVideoSmall, sha256Blob } from "../../online/mediaTranscode";
import { enqueueOnlineMedia } from "../../online/mediaUploadQueue";
import { onlinePage } from "../../online/pageFlag";
import { classifyFileDetailed } from "./mediaKinds";
import { tr } from "../../i18n/index.ts";

/**
 * Compile-time constant of the online build (usage and rationale in "online build pruning" of
 * `src/online/pageFlag.ts`). Online browser mode has no local content store and no transcoding:
 * import media is grayed out (C10 contract, section 10), and the small-variant backfill of media does not
 * run either (`Preview` does not start it under `ONLINE`). The entry points below simply return empty in
 * the online build, and the /api/media/upload, adopt and tiers calls behind them are pruned together
 * (M8 leftover L24).
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/**
 * Import = ingest first, then reference (A1).
 *
 * **Why the hash is not computed in the page**: the asset key is the sha256 of the file content, and
 * reading a 4 GB video once on the main thread is a long task of several seconds; even reading in a Worker
 * would move the whole byte content into page memory. Instead the File is handed directly to fetch as the
 * body: the browser streams it from disk and the page holds none of the bytes; the server
 * (storeMediaStream in server/vite-plugin-media.ts) updates the sha256 while writing to disk, again with
 * constant memory and no long task. When done it returns a `<hash>`, and the asset address is
 * /@media/<hash>. So the main thread and the dev server event loop stay free during the whole import, and
 * the timeline remains editable as usual.
 *
 * During upload the asset is first marked `pending: true`, `url: ""`: the media layer draws an
 * "uploading" placeholder, and a blob: address that the render process / export process cannot reach
 * never appears again.
 */

export interface UploadedMedia {
  hash: string;
  ext: string;
  name: string;
  /** Absolute path in the local content store (old code from the migration period still reads it) */
  path?: string;
  /** /@media/<hash> */
  url: string;
  bytes: number;
  /** The library already had the same content */
  deduped?: boolean;
  /**
   * C6.6 two tiers (video only): `original` is just `hash` (those missing faststart have already been
   * remuxed, and the hash is the one after remuxing), `small` is the small-variant hash; while the small
   * variant is still being transcoded locally in the background it is null and `smallState` is pending, to
   * be filled in by watchSmallTier.
   */
  tiers?: { original: string; small: string | null };
  /** State of the small variant: pending / ready / failed / none (no video stream) */
  smallState?: string;
}

/** The two tier fields in the server response → those two items of UploadedMedia */
function tiersOf(data: { tiers?: { original?: unknown; small?: unknown }; small?: unknown }): Pick<UploadedMedia, "tiers" | "smallState"> {
  const t = data?.tiers;
  if (!t || typeof t.original !== "string") return {};
  return {
    tiers: { original: t.original, small: typeof t.small === "string" ? t.small : null },
    smallState: typeof data.small === "string" ? data.small : undefined,
  };
}

/**
 * Import media on the online browser side: the page computes the content hash directly and uploads in
 * chunks to the asset service; videos are transcoded in the browser into a small MP4, and queued as
 * "all small variants first, then the original".
 */
export async function uploadOnlineMediaFile(
  file: File,
  opts?: { transcode?: typeof transcodeVideoSmall },
): Promise<UploadedMedia | null> {
  try {
    const detected = classifyFileDetailed(file);
    const kind = detected.kind;
    const ext = file.name.split(".").pop()?.toLowerCase() || (kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "png");
    const transcode = opts?.transcode ?? transcodeVideoSmall;

    if (kind === "video") {
      let smallResult = null;
      try {
        smallResult = await transcode(file);
      } catch {
        smallResult = null;
      }
      const originalHash = await sha256Blob(file);

      if (smallResult) {
        const tiers = { original: originalHash, small: smallResult.hash };
        await enqueueOnlineMedia({
          id: originalHash,
          name: file.name,
          tiers: [
            { tier: "small", hash: smallResult.hash, ext: "mp4", blob: smallResult.blob },
            { tier: "original", hash: originalHash, ext, blob: file },
          ],
        });
        return {
          hash: originalHash,
          ext,
          name: file.name,
          url: `/@media/${originalHash}`,
          bytes: file.size,
          tiers,
          smallState: "ready",
        };
      } else {
        const tiers = { original: originalHash, small: null };
        await enqueueOnlineMedia({
          id: originalHash,
          name: file.name,
          tiers: [{ tier: "original", hash: originalHash, ext, blob: file }],
        });
        return {
          hash: originalHash,
          ext,
          name: file.name,
          url: `/@media/${originalHash}`,
          bytes: file.size,
          tiers,
          smallState: "none",
        };
      }
    } else {
      // Images and audio: no small tier, compute SHA-256 directly and enter the upload queue
      const originalHash = await sha256Blob(file);
      const tiers = { original: originalHash, small: null };
      await enqueueOnlineMedia({
        id: originalHash,
        name: file.name,
        tiers: [{ tier: "original", hash: originalHash, ext, blob: file }],
      });
      return {
        hash: originalHash,
        ext,
        name: file.name,
        url: `/@media/${originalHash}`,
        bytes: file.size,
        tiers,
        smallState: "none",
      };
    }
  } catch (err) {
    console.warn(`[io] Online media import error: ${file.name}`, err);
    return null;
  }
}

/** Stream a File into the local content store and get back its content hash. Gives null on failure (the caller is responsible for notifying) */
export async function uploadMediaFile(
  file: File,
  opts?: { transcode?: typeof transcodeVideoSmall; forceOnline?: boolean },
): Promise<UploadedMedia | null> {
  if (ONLINE_BUILD || onlinePage() || opts?.forceOnline) {
    return uploadOnlineMediaFile(file, opts);
  }
  try {
    // tiers=1: for video the server does the faststart check (remux in the same container if missing) and
    // generates the small variant in the background (C6.6)
    const res = await fetch(`/api/media/upload/${encodeURIComponent(file.name)}?tiers=1`, { method: "POST", body: file });
    if (!res.ok) {
      console.warn(`[io] Failed to upload asset (HTTP ${res.status}): ${file.name}`);
      return null;
    }
    const data = await res.json();
    if (!data?.ok || typeof data.hash !== "string") {
      console.warn(`[io] Asset upload did not return a content hash: ${file.name}`);
      return null;
    }
    return {
      hash: data.hash,
      ext: String(data.ext || ""),
      name: String(data.name || file.name),
      path: typeof data.path === "string" ? data.path : undefined,
      url: String(data.url || `/@media/${data.hash}`),
      bytes: Number(data.bytes) || file.size,
      deduped: !!data.deduped,
      ...tiersOf(data),
    };
  } catch (err) {
    console.warn(`[io] Asset upload error: ${file.name}`, err);
    return null;
  }
}

/**
 * Compute the content key for a file that is **already in the server asset directory** (the kind
 * downloaded by media collection).
 *
 * No upload: the file is already on the server, and sending hundreds of MB back again is pure waste; the
 * server computes the sha256 in place as a stream and attaches it to the content store (see adoptMediaFile
 * in vite-plugin-media.ts). On failure gives null, and that media is handled like a migration-period asset
 * without a hash (it can still play by file name).
 */
export async function adoptServerMedia(filePath: string): Promise<UploadedMedia | null> {
  return (await adoptServerMediaVerdict(filePath)).up;
}

/**
 * The editor process's answer to "can this file be fetched"; only two count as a definite "no":
 * - `absent`: 404, the file really does not exist (including html that falls through to the page fallback);
 * - `outside`: 403 with `X-PC-Media-Verdict: outside`, the path is not in the asset directory and this
 *   endpoint will never serve it (paths from another machine are mostly like this).
 * Everything else is `unsure`: other 403s, 5xx, rate limiting, errors in the request itself. Failing to
 * read does not mean it does not exist, so we do not conclude it is missing from this.
 */
export type MediaVerdict = "found" | "absent" | "outside" | "unsure";
export function mediaVerdictOf(res: { ok: boolean; status: number; headers: { get(name: string): string | null } }): MediaVerdict {
  if (res.ok) return HTML_TYPE.test(res.headers.get("content-type") || "") ? "absent" : "found";
  if (res.status === 404) return "absent";
  if (res.status === 403 && res.headers.get("x-pc-media-verdict") === "outside") return "outside";
  return "unsure";
}
const HTML_TYPE = new RegExp("text/html", "i");

/** Same as adoptServerMedia, with an extra verdict: when nothing is obtained, it tells "does not exist" from "cannot tell" */
export async function adoptServerMediaVerdict(filePath: string): Promise<{ up: UploadedMedia | null; verdict: MediaVerdict }> {
  if (ONLINE_BUILD) return { up: null, verdict: "unsure" };
  try {
    const res = await fetch(`/api/media/adopt?path=${encodeURIComponent(filePath)}&tiers=1`, { method: "POST" });
    if (!res.ok) {
      console.warn(`[io] Failed to backfill asset hash (HTTP ${res.status}): ${filePath}`);
      const verdict = mediaVerdictOf(res);
      return { up: null, verdict: verdict === "found" ? "unsure" : verdict };
    }
    const data = await res.json();
    if (!data?.ok || typeof data.hash !== "string") return { up: null, verdict: "unsure" };
    return { verdict: "found", up: {
      hash: data.hash,
      ext: String(data.ext || ""),
      name: String(data.name || ""),
      path: typeof data.path === "string" ? data.path : filePath,
      url: String(data.url || `/@media/${data.hash}`),
      bytes: Number(data.bytes) || 0,
      deduped: !!data.deduped,
      ...tiersOf(data),
    } };
  } catch (err) {
    console.warn(`[io] Asset hash backfill error: ${filePath}`, err);
    return { up: null, verdict: "unsure" };
  }
}

/**
 * Write the ingest result back to the media table.
 *
 * Goes through `actions.updateMedia` (not onto the undo stack: undo governs the timeline and should not
 * take in "media finished uploading" as well), and writes back a copy as a new object. **Do not modify in
 * place** the record in the store: in a shared project the store's project is the local copy of docsync,
 * and fields changed in place are invisible to diffProject, so hash / tiers / pending never reach the
 * document service, and on other devices this media stays pending forever (this is how C6.6 T9 found it).
 *
 * When the upload fails, do not fall back to blob:. That kind of address cannot be opened by the render
 * process or the export process, and keeping it only blows up somewhere farther away (see the notes in
 * importAssets.ts). The asset keeps an empty address and pending goes back to false, so the media layer
 * is transparent, and the user just imports it again.
 */
export function applyUploadedMedia(mediaId: string, up: UploadedMedia | null, { imported = true }: { imported?: boolean } = {}): void {
  const media = getState().project.media.find((m) => m.id === mediaId);
  if (!media) return;
  const patch: Partial<Omit<MediaAsset, "id">> = { pending: undefined, path: up?.path ?? media.path ?? "" };
  if (up) {
    patch.url = up.url;
    patch.hash = up.hash;
    patch.ext = up.ext || undefined;
    patch.size = up.bytes || undefined;
    // Two tiers (C6.6): the project records only two hashes, not the sync state (whether the upload is
    // finished is only asked of the asset service's chunks)
    if (up.tiers) patch.tiers = up.tiers.small ? { original: up.tiers.original, small: up.tiers.small } : { original: up.tiers.original };
  }
  actions.updateMedia(mediaId, patch);
  if (up?.tiers && !up.tiers.small && up.smallState === "pending") watchSmallTier(mediaId, up.tiers.original);
  // Import done (all import paths converge here): in a shared project, hand it to the upload queue by hash; if the upload target is not ready yet, note it down first (see BackfillHooks.afterImport)
  if (up && imported && importHook) {
    const fresh = getState().project.media.find((m) => m.id === mediaId);
    if (fresh) { try { void Promise.resolve(importHook(fresh)).catch(() => {}); } catch { /* An error in the attached work does not affect the import */ } }
  }
}

/** `hooks.afterImport` attached by `startTierBackfill`; if not attached (online build, unit tests) nothing is done */
let importHook: ((media: MediaAsset) => unknown) | null = null;

/** The small variant is transcoded locally in the background; ask once every this long */
const SMALL_POLL_MS = 2000;
/** Ask for at most this long */
const SMALL_POLL_LIMIT_MS = 6 * 60 * 60 * 1000;
const watching = new Set<string>();

/**
 * Once the small variant is ready, write its hash into `project.media[i].tiers.small` (C6.6). What is
 * asked is the local `GET /api/media/tiers?hashes=<original variant>` (the local transcoding registry,
 * not the sync state). Stop when the media is deleted, its original variant changed, transcoding failed,
 * or it is certain there is no small variant. Runs only within an editor session: once the page is closed
 * it asks no more (the small variant is still generated locally and uploaded as usual, only this media's
 * project record has no small; other devices handle it as "fetch the original variant directly while
 * there is no small variant yet").
 */
export function watchSmallTier(mediaId: string, original: string): void {
  if (ONLINE_BUILD || onlinePage()) return;
  const key = `${mediaId}:${original}`;
  if (watching.has(key)) return;
  watching.add(key);
  const started = Date.now();
  const stop = () => { watching.delete(key); };
  const tick = async () => {
    const media = getState().project.media.find((m) => m.id === mediaId);
    if (!media || (media.tiers?.original ?? media.hash) !== original || media.tiers?.small || Date.now() - started > SMALL_POLL_LIMIT_MS) return stop();
    let state: string | null = null;
    let small: string | null = null;
    try {
      const res = await fetch(`/api/media/tiers?hashes=${original}`);
      const data = res.ok ? await res.json() : null;
      const item = data?.items?.[original];
      state = typeof item?.state === "string" ? item.state : null;
      small = typeof item?.small === "string" ? item.small : null;
    } catch { /* Ask again next time */ }
    if (state === "ready" && small) {
      writeSmallTier(mediaId, original, small);
      return stop();
    }
    if (state && state !== "pending") return stop();
    setTimeout(() => { void tick(); }, SMALL_POLL_MS);
  };
  setTimeout(() => { void tick(); }, SMALL_POLL_MS);
}

/* ---------------- Backfill small variants when a project is opened (C6.6 design draft, section 9, item 2) ---------------- */

/** Original-variant hashes for which this page has already asked for backfill (not asked again within the same session; those whose small variant is being transcoded are kept watched by watchSmallTier) */
const backfillAsked = new Set<string>();

/**
 * Videos in the project that lack `tiers.small` and were ingested by hash: ask the editor process to
 * backfill-transcode them (`POST /api/media/tiers/backfill`). Only those whose original variant is in the
 * local content store are transcoded (those not there return `absent`; we do not fetch an original
 * variant just to transcode a small variant), and once transcoded `tiers.small` is written back. If the
 * page closes before the small variant is ready, it is backfilled the next time the project is opened.
 * With no local editor (online browser mode) the request fails and nothing is done.
 * Returns how many were asked this time.
 */
export async function backfillSmallTiers(project = getState().project): Promise<number> {
  if (ONLINE_BUILD || onlinePage() || isViewOnly()) return 0; // Online pages have no local transcoding; read-only pages do not change the project
  const want: { mediaId: string; hash: string; name: string }[] = [];
  for (const m of project.media ?? []) {
    // Those already judged "confirmed missing" are not asked: the content store does not have them, so no small variant can be made
    if (m.kind !== "video" || m.pending || m.tiers?.small || confirmedMissing(m)) continue;
    const hash = String(m.tiers?.original ?? m.hash ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash) || backfillAsked.has(hash)) continue;
    backfillAsked.add(hash);
    want.push({ mediaId: m.id, hash, name: m.name ?? "" });
  }
  if (!want.length) return 0;
  let items: Record<string, { state?: string; small?: string }> = {};
  try {
    const res = await fetch("/api/media/tiers/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: want.map(({ hash, name }) => ({ hash, name })) }),
    });
    if (!res.ok) { for (const w of want) backfillAsked.delete(w.hash); return 0; }
    items = (await res.json())?.items ?? {};
  } catch {
    for (const w of want) backfillAsked.delete(w.hash);
    return 0;
  }
  for (const w of want) {
    const it = items[w.hash];
    if (it?.state === "ready" && typeof it.small === "string") writeSmallTier(w.mediaId, w.hash, it.small);
    else if (it?.state === "pending") watchSmallTier(w.mediaId, w.hash);
  }
  return want.length;
}

/** Write the small-variant hash into this media's `tiers` (only if its original variant has not changed); for the approach see the notes of applyUploadedMedia */
function writeSmallTier(mediaId: string, original: string, small: string): void {
  const fresh = getState().project.media.find((m) => m.id === mediaId);
  if (!fresh || (fresh.tiers?.original ?? fresh.hash) !== original || fresh.tiers?.small) return;
  actions.updateMedia(mediaId, { tiers: { original, small } });
}

/**
 * Backfill small variants when a project is opened (and when the media table changes), returning a stop
 * function. Called when the preview is attached.
 * The same original variant is asked only once per page session; if the media table has not changed, no ask.
 * At the same moment, ingest old media without a hash in the background (`ingestUnhashedMedia`): those whose
 * file the local machine cannot get are marked "(missing)"; when done, hand over to `hooks.afterIngest`
 * (those whose hash was filled in while hosted in the cloud enter the upload queue, see `sync/backfillUpload.ts`).
 */
export function startTierBackfill(hooks: BackfillHooks = {}): () => void {
  if (ONLINE_BUILD) return () => {};
  const myImportHook = hooks.afterImport ?? null;
  importHook = myImportHook;
  const background = async () => {
    // Those whose file the local machine cannot get are marked "(missing)". Judged only in local projects: not marked in shared projects
    // (see BackfillHooks.shared); also not judged when it still carries a collaboration association and is merely not connected
    // (offline, authentication needed, waiting for the host), since then it is normal for media that exists only remotely to be absent locally,
    // and a verdict would also be synced to all members on reconnect (see BackfillHooks.associated).
    // If the project changes midway through the check (switched project, got connected, entered a cloud project), stop and do not write this round's conclusion.
    const local = () => !hooks.shared?.() && !hooks.associated?.();
    const started = loadMark();
    const allowed = () => local() && sameLoad(started);
    const r = await ingestUnhashedMedia({ background: true, markMissing: local(), allowed });
    // Those with a hash but absent from the local content store (a .proc stored by another machine) are marked the same way; in shared projects it is normal for the local machine not to have them, so no verdict
    if (allowed()) await checkHashedMedia({ allowed });
    await hooks.afterIngest?.(r);
  };
  let lastMedia: unknown = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    const media = getState().project.media;
    if (media === lastMedia) return;
    lastMedia = media;
    // While the project is just being opened, yield first (measurement, first frame), ask later
    if (timer) clearTimeout(timer);
    // Backfill-ingest old media without a hash first (old projects heal themselves), then backfill small variants; writing back to the media table after ingest triggers another check, so newly added videos get asked too
    timer = setTimeout(() => { timer = null; void background().catch(() => {}); void backfillSmallTiers(); }, 1500);
  };
  const unsub = subscribe(check);
  check();
  // A stale cloud project was just turned into a local project: the media table did not change (content as is), but it is now a local project, so judge again
  const again = () => { lastMedia = null; ingestBackgroundFailed.clear(); check(); };
  recheckers.add(again);
  return () => { recheckers.delete(again); unsub(); if (timer) clearTimeout(timer); if (importHook === myImportHook) importHook = null; };
}

const recheckers = new Set<() => void>();
onGoneConversion(() => { for (const again of [...recheckers]) again(); });

/** Which project is loaded at this moment (`loadProject` adds one each time); the background check spans several requests, and uses this on return to see whether the project changed */
const loadMark = () => ({ token: getState().projectLoadToken, id: getState().project.id });
const sameLoad = (mark: ReturnType<typeof loadMark>) => getState().projectLoadToken === mark.token && getState().project.id === mark.id;

/* ---------------- Backfill: old assets with no hash whose bytes this machine can still get ---------------- */

/*
 * Some assets in old projects only have a `path`, with the URL `/api/media/file?path=…` or `/@media/<file name>`,
 * and no content hash (voiceovers generated before 0.7.7, assets imported during the migration period).
 * The two places that pick assets by hash (saving a `.procp` package, `mediaEntries` in procp.ts, and handing
 * assets to the upload queue when "move to cloud" is on, `existingMediaItems` in assetTiers.ts) only recognize
 * hashes, so these assets were silently left out.
 * Semantics `product/asset-service.md`, "the ingest step cannot be skipped": this code backfills them into
 * the local content store.
 *
 * How: if the file in the asset directory can be located (it has a `path`, or its URL contains `path=`), go
 * through `adoptServerMedia` (the server computes the hash in place and hard-links the file into the content
 * store, so no bytes are sent back). If the server does not accept that path (not inside the asset directory,
 * or the path does not match after moving to another machine), fetch the bytes through the existing read
 * endpoints (`/api/media/file?path=…`, `/@media/<file name>`) and ingest them with `uploadMediaFile`.
 * The result is written back to the asset table with `applyUploadedMedia` (a new object, no in-place edits).
 *
 * Three call sites: before packaging, before handing assets to the upload queue for "move to cloud", and in
 * the background after a project opens (same moment as `startTierBackfill`).
 * The online build and read-only pages do not do this (no local content store, and they do not modify the
 * project).
 */

const HASH_RE = /^[0-9a-f]{64}$/i;

/** This asset has a valid content hash */
export function hasMediaHash(m: { hash?: string } | null | undefined): boolean {
  return HASH_RE.test(String(m?.hash ?? ""));
}

/** Places where this machine may be able to get an asset's bytes: the path to try first (adopt), then the read URLs (fetch bytes, then ingest) */
export function localSourcesOf(m: Pick<MediaAsset, "path" | "url" | "name">): { paths: string[]; urls: string[] } {
  const paths: string[] = [];
  const urls: string[] = [];
  const addPath = (p: string | null | undefined) => { if (p && !paths.includes(p)) paths.push(p); };
  const addUrl = (u: string) => { if (u && !urls.includes(u)) urls.push(u); };
  const url = String(m.url || "");
  if (url.startsWith("/api/media/file?")) {
    try { addPath(new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("path")); } catch { /* If the URL is broken, look only at path */ }
  }
  addPath(m.path);
  if (url.startsWith("/api/media/file?")) addUrl(url);
  else if (url.startsWith("/@media/") && !HASH_RE.test(url.slice("/@media/".length).split(/[.?]/)[0])) addUrl(url.split("?")[0]);
  for (const p of paths) addUrl(`/api/media/file?path=${encodeURIComponent(p)}`);
  for (const p of paths) {
    const base = p.split(/[/\\]/).pop();
    if (base) addUrl(`/@media/${encodeURIComponent(base)}`);
  }
  return { paths, urls };
}

/** The hash when the URL itself is `/@media/<hash>` (content-addressed) */
function hashInUrl(url: string | undefined): string | null {
  const u = String(url || "");
  if (!u.startsWith("/@media/")) return null;
  const h = u.slice("/@media/".length).split(/[.?/]/)[0];
  return HASH_RE.test(h) ? h.toLowerCase() : null;
}

function uploadNameOf(m: Pick<MediaAsset, "name" | "path">): string {
  const fromPath = m.path ? m.path.split(/[/\\]/).pop() : "";
  const name = withoutMissingMark(m.name || "");
  return fromPath || name || "media";
}

/**
 * Backfill one asset: adopt if possible, otherwise fetch the bytes and upload. If neither works, `up` is null.
 * `unreachable`: every path and every read URL **explicitly** answered "not there" (for the verdict see
 * `mediaVerdictOf`: 404, falling through to the page fallback, path outside the asset directory)
 * — this machine really cannot get the file. Other non-2xx responses (no permission, 5xx, rate limit), bytes
 * fetched but upload failed, and request errors (the editor process is not running) do not count, because
 * then it is unclear whether the file exists.
 */
async function ingestOne(m: MediaAsset): Promise<{ up: UploadedMedia | null; unreachable: boolean }> {
  const { paths, urls } = localSourcesOf(m);
  let unsure = false;
  for (const p of paths) {
    const { up, verdict } = await adoptServerMediaVerdict(p);
    if (up) return { up, unreachable: false };
    if (verdict === "unsure") unsure = true;
  }
  for (const u of urls) {
    try {
      const res = await fetch(u);
      const verdict = mediaVerdictOf(res);
      // Explicitly not there (404, page fallback, path outside the asset directory): try the next URL; any other failure means the read did not succeed, so it is unclear
      if (verdict === "unsure") { unsure = true; continue; }
      if (verdict !== "found") continue;
      // Safety net: a response that falls through to the page fallback (index.html) is not an asset
      if (/text\/html/i.test(res.headers.get("content-type") || "")) continue;
      unsure = true; // Bytes fetched: the file exists, it just was not ingested
      const blob = await res.blob();
      const up = await uploadMediaFile(new File([blob], uploadNameOf(m)));
      if (up) return { up, unreachable: false };
    } catch { unsure = true; /* Next URL */ }
  }
  return { up: null, unreachable: !unsure && urls.length > 0 };
}

export interface IngestResult {
  /** IDs of the assets that got a hash this time */
  ingested: string[];
  /**
   * Assets that could not be backfilled. `unreachable`: this machine really cannot get the file through the
   * read endpoints (see ingestOne);
   * entries without this flag are unclear (bytes fetched but ingest failed, the editor process is not running,
   * or there is no URL at all).
   */
  failed: { id: string; name: string; unreachable?: boolean }[];
}

/**
 * Two things the background check after opening a project can hook into (passed by `Preview` to
 * `startTierBackfill`, see `sync/backfillUpload.ts`).
 * It does not import the sync layer directly: `syncManager` cannot be loaded in Node unit tests, and this
 * also avoids making io depend on sync.
 */
export interface BackfillHooks {
  /**
   * Whether this file still carries a collaboration link (connected or not). If it does, do not judge assets
   * missing: while disconnected it is normal for this machine not to have the remote assets, and judging them
   * would write into the content waiting to sync and send it to all members after reconnecting.
   */
  associated?: () => boolean;
  /** Whether this is currently a shared project. In a shared project, assets are not marked "(missing)": whether they can be fetched is up to this machine and should not be synced to other members */
  shared?: () => boolean;
  /** After the background backfill finishes (when "move to cloud" is on, hand the newly hashed assets to the upload queue and list the ones that could not be backfilled to the user) */
  afterIngest?: (r: IngestResult) => unknown;
  /**
   * After an asset import completes and the hash is written back (`applyUploadedMedia`; user imports,
   * voiceovers and media collection all go through here). In a shared project it is used to hand assets to the
   * upload queue by hash: for assets imported after the shared project opens but before the editor process gets
   * the upload target, the enqueue on the editor process side sees a local target and drops it as a no-op, so
   * the page has to remember them and hand them over once ready (queueImportedMedia in `media/assetTiers.ts`).
   */
  afterImport?: (media: MediaAsset) => unknown;
}

/** Sources currently being backfilled (when packaging and the background trigger at the same time, backfill only once) */
const ingestInflight = new Map<string, Promise<{ up: UploadedMedia | null; unreachable: boolean }>>();
/** Sources the background tried to backfill and failed: within the same session the background does not retry (packaging and "move to cloud" still try once more) */
const ingestBackgroundFailed = new Set<string>();

/**
 * Backfill into the local content store the entries in the asset table that have no valid hash but whose
 * bytes this machine can still get, and write the hashes back.
 * Entries still importing (`pending`) are left alone: ingest is the import path's job. Returns which ones
 * were backfilled and which could not be.
 * `background`: done in the background after opening a project; failures are recorded and the background
 * does not retry within the same session.
 * `markMissing`: files this machine really cannot get (`unreachable`) are marked "(missing)" following the
 * old rule used when opening a project: clear the URL and prefix the name with a marker
 * (restoreMediaUrls in `mediaUrls.ts`; assets with an empty URL are skipped by preview and export, so nothing
 * waits on a URL that cannot be opened). `path` is kept, so after switching back to a machine that has the
 * file, or after the file is put back in place, the next backfill still succeeds (the marker is removed then).
 */
export async function ingestUnhashedMedia(opts: { background?: boolean; markMissing?: boolean; allowed?: () => boolean } = {}): Promise<IngestResult> {
  const out: IngestResult = { ingested: [], failed: [] };
  if (ONLINE_BUILD || isViewOnly()) return out;
  // The project may have changed while waiting for requests: before judging missing again, check whether it is still allowed (`allowed`), and never write across projects
  const mark = loadMark();
  const mayMark = () => !!opts.markMissing && sameLoad(mark) && (opts.allowed?.() ?? true);
  const media = getState().project.media ?? [];
  const byId = new Map(media.map((m) => [m.id, m]));
  // Several records from the same source (same file) are backfilled together
  const groups = new Map<string, MediaAsset[]>();
  for (const m of media) {
    if (m.pending || hasMediaHash(m)) continue;
    // The "audio only" copy points to the same file as the source video: if the source video has a hash, use it directly
    const src = m.soundOf ? byId.get(m.soundOf) : undefined;
    const direct = src && hasMediaHash(src) ? String(src.hash).toLowerCase() : hashInUrl(m.url);
    if (direct) {
      const fresh = getState().project.media.find((x) => x.id === m.id);
      if (fresh && !hasMediaHash(fresh)) {
        actions.updateMedia(m.id, { hash: direct, url: `/@media/${direct}`, pending: undefined, ...(src && hasMediaHash(src) && src.ext ? { ext: src.ext } : {}) });
        out.ingested.push(m.id);
      }
      continue;
    }
    const { paths, urls } = localSourcesOf(m);
    const key = paths[0] ?? urls[0] ?? "";
    if (!key) {
      out.failed.push({ id: m.id, name: m.name });
      // No hash, no path, and no readable URL (a dead URL already cleared on open): nothing to recover it with, so likewise judge it missing
      if (mayMark() && !m.url && !m.soundOf) markMediaMissing(m.id);
      continue;
    }
    const g = groups.get(key);
    if (g) g.push(m); else groups.set(key, [m]);
  }
  for (const [key, list] of groups) {
    if (opts.background && ingestBackgroundFailed.has(key)) continue;
    let p = ingestInflight.get(key);
    if (!p) {
      p = ingestOne(list[0]).finally(() => ingestInflight.delete(key));
      ingestInflight.set(key, p);
    }
    const { up, unreachable } = await p;
    if (!sameLoad(mark)) return out; // The project changed: this round ends here, write nothing
    if (!up) {
      if (opts.background) ingestBackgroundFailed.add(key);
      for (const m of list) {
        out.failed.push({ id: m.id, name: m.name, ...(unreachable ? { unreachable: true } : {}) });
        if (unreachable && mayMark()) markMediaMissing(m.id);
      }
      continue;
    }
    ingestBackgroundFailed.delete(key);
    for (const m of list) {
      const fresh = getState().project.media.find((x) => x.id === m.id);
      if (!fresh || hasMediaHash(fresh)) continue; // Deleted in the meantime, or already backfilled elsewhere
      // Two tiers where derived audio is not attached to the video
      // Newly hashed assets go to the upload queue through hooks.afterIngest (queueBackfilledMedia), so they are not handed over again here as "import"
      applyUploadedMedia(m.id, fresh.soundOf ? { ...up, tiers: undefined, smallState: undefined } : up, { imported: false });
      // Previously marked "(missing)" on another machine and now fetched: remove the marker, together with the "confirmed missing" record (the placeholder disappears with it)
      if (hasMissingMark(fresh.name) || fresh.missingMaterial) actions.updateMedia(m.id, { name: nameWithoutMissing(fresh.name), missingMaterial: undefined });
      out.ingested.push(m.id);
    }
  }
  return out;
}

/** Original-size hashes of assets that were asked about and are in the local content store (hashes are immutable, once present always present; absent ones are asked again each round, since they may be imported in the meantime) */
const hashPresent = new Set<string>();

/**
 * Whether the local content store has the bytes of hashed assets (`GET /api/media/local?hashes=…`, an
 * existing endpoint of the asset service). Only called in local projects:
 * in a shared project it is normal for this machine not to have them (pulled from the remote asset service
 * on demand).
 * - Those that are absent are marked "(missing)" (same as markMediaMissing: clear the URL, add a marker to
 *   the name; the hash is kept, so the next open still looks them up by hash);
 * - Those that were marked before and are now present (a file with the same content was imported, or a
 *   package carrying these bytes was opened) get the marker removed and `/@media/<hash>` restored.
 * If the editor process cannot answer, nothing is changed. Returns which ones were re-marked and which were
 * restored.
 */
export async function checkHashedMedia(opts: { allowed?: () => boolean } = {}): Promise<{ missing: string[]; restored: string[] }> {
  const out = { missing: [] as string[], restored: [] as string[] };
  if (ONLINE_BUILD || isViewOnly()) return out;
  // Several requests must be awaited below; if the project changes in the meantime (or judging is no longer allowed), stop and do not write this round's conclusions into another project
  const mark = loadMark();
  const go = () => sameLoad(mark) && (opts.allowed?.() ?? true);
  const hashOf = (m: MediaAsset) => String(m.tiers?.original || m.hash || "").toLowerCase();
  const ask = [...new Set((getState().project.media ?? [])
    .filter((m) => !m.pending && hasMediaHash(m))
    .map(hashOf)
    .filter((h) => HASH_RE.test(h) && !hashPresent.has(h)))];
  const answered = new Set<string>();
  for (let i = 0; i < ask.length; i += 40) {
    const part = ask.slice(i, i + 40);
    try {
      const res = await fetch(`/api/media/local?hashes=${part.join(",")}`, { cache: "no-store" });
      if (!res.ok) continue;
      const body = (await res.json()) as { hashes?: unknown };
      if (!Array.isArray(body?.hashes)) continue;
      for (const h of body.hashes) hashPresent.add(String(h).toLowerCase());
      for (const h of part) answered.add(h);
    } catch { /* Editor process is not running: do not judge this batch */ }
  }
  if (!go()) return out;
  // For those not in the content store, look once more by the local path recorded originally (order of asset recovery: assets stored from the package and assets already in the content store both come before it, see `workflow/materials.md`):
  // if the file is still in place and its content matches, hook it back into the content store in place, and it does not count as missing; if the file in place has changed (hash mismatch), record it and explain it separately in the dialog.
  const changed = new Set<string>();
  /** Those that could not be read when looked up by the original path (no permission, 5xx, request error): unclear whether the file exists, so not judged this round */
  const unsure = new Set<string>();
  const triedPath = new Set<string>();
  for (const m of getState().project.media ?? []) {
    if (m.pending || !hasMediaHash(m) || !m.path) continue;
    const h = hashOf(m);
    if (hashPresent.has(h) || !answered.has(h) || h !== String(m.hash).toLowerCase() || triedPath.has(`${h}
${m.path}`)) continue;
    triedPath.add(`${h}
${m.path}`);
    const { up, verdict } = await adoptServerMediaVerdict(m.path);
    if (!go()) return out;
    if (up && up.hash.toLowerCase() === h) hashPresent.add(h);
    else if (up) changed.add(h);
    else if (verdict === "unsure") unsure.add(h);
  }
  if (!go()) return out;
  const notices: MissingMaterialNotice[] = [];
  for (const m of getState().project.media ?? []) {
    if (m.pending || !hasMediaHash(m)) continue;
    const h = hashOf(m);
    const url = `/@media/${String(m.hash).toLowerCase()}`;
    if (hashPresent.has(h)) {
      if (hasMissingMark(m.name) || !m.url || m.missingMaterial) {
        actions.updateMedia(m.id, { name: nameWithoutMissing(m.name), url: m.url || url, missingMaterial: undefined });
        out.restored.push(m.id);
      }
    } else if (answered.has(h) && !unsure.has(h)) {
      // Already judged and the record still matches: do not write again (this is the case after save and reopen: the placeholder stays, no more dialog)
      if (hasMissingMark(m.name) && confirmedMissing(m)) continue;
      console.warn(`[io] Missing asset: ${m.name} (${m.hash})`);
      // Keep the hash-based URL (restoreMediaUrls also gives this one after save and reopen, so the record matches); picture, sound and export do not try to fetch it when they see the record
      const name = hasMissingMark(m.name) ? m.name : `${MISSING_NAME_MARK}${m.name}`;
      actions.updateMedia(m.id, { url, name, missingMaterial: missingRecordOf({ ...m, url, name }) });
      out.missing.push(m.id);
      notices.push({ id: m.id, name: nameWithoutMissing(m.name), kind: m.kind, ...(changed.has(h) ? { changed: true } : {}) });
    }
  }
  publishMissingMaterials(notices);
  return out;
}

const nameWithoutMissing = withoutMissingMark;

/** URL used after an asset with no hash and no path is judged missing: only so it is not left empty (the timeline's sounding manifest skips assets with an empty URL); nobody will actually fetch it */
const NOWHERE_URL = "/@media/__missing__";

/**
 * The "confirmed missing" record (shape: see `MediaAsset.missingMaterial`): written only in local projects,
 * after the editor process explicitly answered "not there".
 * It records the asset's kind, name, URL, hash and path at the moment of judging; the picture and sound
 * placeholders are enabled only if these match the asset's current state verbatim.
 * A video is recorded as missing both picture and sound (the asset is gone, so there is no way to know
 * whether it had sound), an image has only picture, and an audio asset has only sound.
 */
function missingRecordOf(m: MediaAsset): NonNullable<MediaAsset["missingMaterial"]> {
  return {
    v: 1, mediaId: m.id, reason: "confirmed-missing",
    original: { kind: m.kind, name: m.name, url: m.url, ...(m.hash ? { hash: m.hash } : {}), ...(m.path ? { path: m.path } : {}) },
    visual: m.kind !== "audio", audio: m.kind !== "image",
  };
}

/** Mark "(missing)": clear the URL and add a marker to the name (written back as a new object; already marked ones are not marked again) */
function markMediaMissing(mediaId: string): void {
  const fresh = getState().project.media.find((x) => x.id === mediaId);
  if (!fresh || hasMediaHash(fresh) || fresh.pending) return;
  const name = hasMissingMark(fresh.name) ? fresh.name : `${MISSING_NAME_MARK}${fresh.name}`;
  if (name === fresh.name && confirmedMissing(fresh)) return;
  console.warn(`[io] Missing asset: ${fresh.name} (${fresh.path || fresh.url})`);
  // Do not clear the URL: keep the original read URL (restoreMediaUrls gives this one by path after save and reopen), and if there is none, give a nonexistent placeholder URL
  const url = fresh.url || NOWHERE_URL;
  actions.updateMedia(mediaId, { url, name, missingMaterial: missingRecordOf({ ...fresh, url, name }) });
  publishMissingMaterials([{ id: fresh.id, name: nameWithoutMissing(fresh.name), kind: fresh.kind }]);
}

/** For unit tests */
export function resetTierBackfillForTest(): void {
  importHook = null;
  backfillAsked.clear();
  ingestBackgroundFailed.clear();
  ingestInflight.clear();
  hashPresent.clear();
}
