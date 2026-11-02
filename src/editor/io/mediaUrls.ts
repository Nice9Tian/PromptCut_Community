import type { MediaAsset } from "../../kernel/project";
import { kindFromExtension, type AssetKind } from "./mediaKinds.ts";
import { publishMediaMigrations, type MediaKindMigration } from "./mediaMigrationBus.ts";
import { confirmedMissing, MISSING_NAME_MARK, hasMissingMark } from "../../audio/missingMaterialRecord.ts";
import { tr } from "../../i18n/index.ts";

/**
 * How an asset URL stays playable across "save → reopen".
 *
 * A freshly imported asset in the editor has a blob: url from URL.createObjectURL. It only lives in the
 * current page, and after saving into .proc and reopening it is a dead URL. The only thing that can find the
 * file again across sessions is path: on import the file is uploaded to the server's asset directory
 * (see importVideoFiles / importVideoFromServer in index.ts), and it can be fetched by file name through
 * /@media/<file name>.
 *
 * Previously only the old-format import importProjectFile did this conversion; after .proc switched to
 * parseProc, this step was bypassed, and after opening a project the url was a bare file name, so <video>
 * got index.html: the video layer in the preview was empty, the export page waited forever for the video to
 * be ready, and export stuck at frame 0. So both paths now call this, and there is only one set of rules.
 *
 * This file imports no runtime modules, so unit tests can load it directly (see mediaUrls.test.mjs).
 */

/**
 * URL of the asset key (content sha256). Since A1 this is the only correct asset URL:
 * rename the file, change mtime, open on another machine, and as long as the content is the same it is
 * still this URL.
 */
export function mediaUrlFromHash(hash: string | undefined): string | null {
  return hash && /^[0-9a-f]{64}$/i.test(hash) ? `/@media/${hash.toLowerCase()}` : null;
}

/** URL of this file in the server's asset directory. Returns null if there is no path */
export function mediaUrlFromPath(path: string | undefined, opts: { external?: boolean } = {}): string | null {
  const base = path ? path.split(/[/\\]/).pop() : "";
  if (!base) return null;
  // Projects imported from an older installation may point at a real file in
  // the user's Videos/PromptCut/media directory.  Keep the compact /@media
  // form for normal assets, but let the loader ask the server to resolve that
  // durable path when it is outside the current project's out/media folder.
  return opts.external
    ? `/api/media/file?path=${encodeURIComponent(path || "")}`
    : `/@media/${encodeURIComponent(base)}`;
}

/** URLs that do not expire with the page: network URLs, data:, same-origin absolute paths (/@media/...) */
function isDurable(url: string): boolean {
  return /^(https?:|data:)/.test(url) || url.startsWith("/");
}


/**
 * Asset table read back from a file → playable asset table. Does not modify the input.
 *
 * - Has a hash (imported after A1): replace with /@media/<hash>, highest priority — the hash is the
 *   identity, and the file is in the content store;
 * - Only has a path (old .proc from the migration period): replace with /@media/<file name> (same as the
 *   old-format import);
 * - No path but the URL is already usable: keep as is;
 * - The rest (dead blob:, bare file name): clear the url, prefix the name with "(missing)", and record it in
 *   missing —
 *   assets with an empty url are skipped by preview and export, so nothing waits on a URL that cannot be
 *   opened.
 */
export function restoreMediaUrls(media: MediaAsset[], opts: { externalPathUrl?: boolean } = {}): { media: MediaAsset[]; missing: MediaAsset[]; moved: MediaKindMigration[] } {
  const missing: MediaAsset[] = [];
  const moved: MediaKindMigration[] = [];
  const out = media.map((m) => {
    const extKind = kindFromExtension(m.name) ?? kindFromExtension(m.path || "") ?? kindFromExtension(m.url || "");
    // A derived audio asset intentionally keeps audio kind even when its source is .mp4.
    const shouldMove = !!extKind && extKind !== m.kind && !(m.kind === "audio" && m.soundOf);
    // Assets judged "confirmed missing" are left as is: the placeholder checks that the record and the asset have the same kind, name and URL verbatim, and changing any of them here would invalidate the placeholder
    // (recovering and clearing the record is the job of the background check in mediaUpload.ts).
    if (confirmedMissing(m) && m.url) {
      return m.pending ? { ...m, pending: undefined } : m;
    }
    const normalized = shouldMove ? { ...m, kind: extKind as AssetKind } : m;
    if (shouldMove) moved.push({ id: m.id, name: m.name, from: m.kind, to: extKind as AssetKind });
    // With a content hash, only /@media/<hash> is used — the file is stored by hash in the content store, and path is just where it was at the time.
    // pending means "not finished uploading in this session"; when read back from a file it is always stale, so clear it while here.
    const fromHash = mediaUrlFromHash(normalized.hash);
    if (fromHash) return { ...normalized, url: fromHash, pending: undefined };
    const fromPath = mediaUrlFromPath(normalized.path, { external: opts.externalPathUrl });
    if (fromPath) return { ...normalized, url: fromPath, pending: undefined };
    const url = normalized.url || "";
    if (!url || isDurable(url)) return normalized.pending ? { ...normalized, pending: undefined } : normalized;
    missing.push(normalized);
    return { ...normalized, url: "", pending: undefined, name: hasMissingMark(normalized.name) ? normalized.name : `${MISSING_NAME_MARK}${normalized.name}` };
  });
  publishMediaMigrations(moved);
  return { media: out, missing, moved };
}
