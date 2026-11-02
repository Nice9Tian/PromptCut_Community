import { actions, getState } from "../../store/project";
import type { MediaAsset } from "../../kernel/project";
import { applyUploadedMedia, type UploadedMedia } from "./mediaUpload";
import { onlineUnsupported } from "../../online/onlineUnsupported";
import { tr } from "../../i18n/index.ts";

/**
 * Import media from the user's cloud drive (task brief `docs/plan/drive-connector-task.md`, section 5).
 *
 * # Difference from local import: the page has no File
 *
 * In local import the bytes pass through the page, so `importVideoFiles` in `io/index.ts` can use `blob:`
 * to probe duration and size, and can also store the File in io's private table for speech-to-text.
 * On the cloud drive path **the bytes do not pass through the page**: the editor process pulls straight
 * from the drive and adds to the store directly; the page only hands over a file id and a ticket. So
 * here:
 *
 * - Metadata is probed through `/@media/<hash>` after it is stored (the bytes are in the local content
 *   store by then), not through `blob:`;
 * - `registerMediaFile` is not called; the page has no File to register. **Cost**: this kind of media
 *   cannot be used for speech-to-text for now, and `io/stt.ts` will answer "media file is not in
 *   memory". This is the same situation as "media after opening an existing project", not a defect
 *   newly introduced by this path; it is noted in the to-dos of section 9 of the task brief.
 *
 * # Placeholder first, then the content
 *
 * Same as local import: first put an entry with `pending: true` into the media library, so the user sees
 * at once that it is uploading; once the pull is done and stored, fill in the address, hash, the two
 * tiers and duration and size. All import paths end up in `applyUploadedMedia`.
 */

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export interface StorageProviderConfig {
  kind: string;
  label: string;
  configured: boolean;
  /** Whether this machine supports A2 (handing the long-term authorization over to it for safekeeping). False when only the first three are configured; one-time authorization still works */
  canManage?: boolean;
  scope?: string | null;
  clientId?: string;
  apiKey?: string;
  appId?: string;
  redirectUri?: string;
  /** When not configured properly, says why; shown to the user as is */
  reason?: string;
  /** When one-time authorization works but hosting does not, says why */
  manageReason?: string;
}

/** Connected cloud drives. Meta info only, no tokens at all */
export interface StorageConnection {
  projectId: string;
  userId: string;
  provider: string;
  grantedScope: string;
  createdAt: number;
  updatedAt: number;
}

export interface PickedFile {
  id: string;
  name: string;
  /** The type given by the Picker, used to predict which group it lands in; the final answer is what the server reads */
  mimeType?: string;
  sizeBytes?: number;
}

export interface StorageImportResult extends UploadedMedia {
  source?: { kind: string; fileId: string; name: string; mimeType: string; size: number };
  pulled?: { bytes: number; total: number; resumedFrom: number; segments: number };
}

/** Whether the cloud drive connector can be used in this build: the online browser has no local editor process, so it cannot pull */
export const storageImportSupported = !ONLINE_BUILD;

/** Read the server's public parameters. If they cannot be read, treat it as not configured and grey out the UI */
export async function loadStorageProviders(): Promise<StorageProviderConfig[]> {
  if (!storageImportSupported) return [];
  try {
    const res = await fetch("/api/media/storage/config");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.providers) ? (data.providers as StorageProviderConfig[]) : [];
  } catch {
    return [];
  }
}

/**
 * In the online browser build, `/api/media/storage/*` has no peer: these endpoints are served by the
 * **local editor process**, which the online page does not have.
 *
 * Every function below inlines an `if (!storageImportSupported) throw …` at its start, **not extracted
 * into a helper function**. Extracting it would make it impossible to prune: `storageImportSupported` is
 * a compile-time constant `false` in the online build, so the inlined check is always true and the code
 * after it, together with the `/api/…` literals, is pruned by the bundler; with a function call, the
 * bundler cannot statically decide that what follows is unreachable, and the literals stay in the output.
 *
 * **This is not just about saving a few lines**: the online API ratchet C10A-API-03 requires that the
 * "`/api/` paths in the output" match `server/test/c10a-online-api-paths.json` entry by entry. When it was
 * merged on 2026-10-24, the connect / disconnect / import functions missed this check, the literals got
 * into the online output, and that gate went red once; after the fix they no longer appear, and those
 * three entries were removed from the manifest too (the test also asserts that the manifest must not
 * contain paths that are no longer in the output). I first wrote it as a function and the output still
 * had them; only inlining pruned them. That is why this looks verbose.
 */
async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(String(data?.message || tr("Request failed (HTTP {0})", res.status)));
  return data;
}

/** A2: list the connected cloud drives. If they cannot be read, treat it as none */
export async function loadConnections(): Promise<StorageConnection[]> {
  if (!storageImportSupported) return [];
  try {
    const res = await fetch("/api/media/storage/connections");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.connections) ? (data.connections as StorageConnection[]) : [];
  } catch {
    return [];
  }
}

/** A2: hand the authorization code to the editor process in exchange for a refresh token. The page never touches the refresh token */
export async function connectStorage(provider: string, code: string, codeVerifier: string): Promise<void> {
  if (!storageImportSupported) throw new Error(onlineUnsupported(tr("Import from cloud drive")));
  await postJson("/api/media/storage/connect", { kind: provider, code, codeVerifier });
}

/** A2: disconnect. The response says whether the drive side managed to revoke */
export async function disconnectStorage(provider: string): Promise<{ revoked: boolean; why?: string }> {
  if (!storageImportSupported) throw new Error(onlineUnsupported(tr("Import from cloud drive")));
  const data = await postJson("/api/media/storage/disconnect", { kind: provider });
  return { revoked: !!data.revoked, ...(data.why ? { why: String(data.why) } : {}) };
}

function kindOf(mimeType: string | undefined, name: string): MediaAsset["kind"] {
  const mt = String(mimeType || "").toLowerCase();
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  if (mt.startsWith("image/")) return "image";
  // The Picker sometimes gives no mimeType; fall back to the file extension
  const ext = name.toLowerCase().split(".").pop() || "";
  if (["mp4", "mov", "m4v", "webm", "mkv", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(ext)) return "audio";
  return "image";
}

/** Probe duration / width and height. Failing to probe is not a failure: leave it empty and let later steps use defaults (same fallback as local import) */
function probe(url: string, kind: MediaAsset["kind"], name: string): Promise<{ duration?: number; width?: number; height?: number }> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: { duration?: number; width?: number; height?: number }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    // Same 5 second limit as local import: a bad file must not hang the import
    const timer = setTimeout(() => settle({}), 5000);

    if (kind === "image") {
      const img = new Image();
      img.onload = () => settle({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
      img.onerror = () => { console.warn(`[storage] Failed to probe image: ${name}`); settle({}); };
      img.src = url;
      return;
    }
    const el = document.createElement(kind === "video" ? "video" : "audio") as HTMLVideoElement;
    el.preload = "metadata";
    el.muted = true;
    el.onloadedmetadata = () => settle({
      duration: Number.isFinite(el.duration) ? el.duration : undefined,
      width: el.videoWidth || undefined,
      height: el.videoHeight || undefined,
    });
    el.onerror = () => { console.warn(`[storage] Failed to probe media: ${name}`); settle({}); };
    el.src = url;
  });
}

/**
 * Import a selected cloud drive file into the media library.
 *
 * @param token One-time access token (A3). Pass `null` for A2: the editor process exchanges for a ticket itself using the credentials it hosts
 * @param place Whether to also drop a video at the playhead (same as local video import)
 * @returns The id of the new media
 */
export async function importFromStorage(
  provider: string,
  token: string | null,
  file: PickedFile,
  { place = true }: { place?: boolean } = {},
): Promise<string> {
  if (!storageImportSupported) throw new Error(onlineUnsupported(tr("Import from cloud drive")));
  const kind = kindOf(file.mimeType, file.name);

  // Placeholder first: the user sees at once that this one is uploading
  const media = actions.addMedia({ kind, name: file.name, url: "", pending: true });

  let uploaded: StorageImportResult;
  try {
    const res = await fetch("/api/media/storage/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No token means A2: let the editor process exchange for a ticket itself with the hosted credentials
      body: JSON.stringify({ kind: provider, fileId: file.id, name: file.name, ...(token ? { token } : {}) }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(String(data?.message || tr("Import failed (HTTP {0})", res.status)));
    }
    uploaded = data as StorageImportResult;
  } catch (err) {
    // On failure, remove the placeholder; do not leave an entry in the media library that is "uploading" forever
    actions.removeMedia(media.id);
    throw err;
  }

  // The bytes are already in the local content store, so only now can duration and size be probed
  const meta = await probe(uploaded.url, kind, file.name);
  if (meta.duration !== undefined || meta.width !== undefined || meta.height !== undefined) {
    actions.updateMedia(media.id, {
      ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
      ...(meta.width !== undefined ? { width: meta.width } : {}),
      ...(meta.height !== undefined ? { height: meta.height } : {}),
    });
  }

  applyUploadedMedia(media.id, uploaded);

  if (kind === "video" && place) {
    actions.addMediaClip(media.id, getState().t);
  }
  return media.id;
}
