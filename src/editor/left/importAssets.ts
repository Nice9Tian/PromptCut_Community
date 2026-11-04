import type { MediaAsset } from "../../kernel/project";
import { actions } from "../../store/project";
import { importVideoFiles, registerMediaFile } from "../io";
import { applyUploadedMedia, uploadMediaFile } from "../io/mediaUpload";
import { classifyFileDetailed, EXT_KIND } from "../io/mediaKinds";
import { holdOnlineQueueOriginals } from "../../online/mediaUploadQueue";
import { blockedByReadOnly } from "../readOnlyCore";
import { viewOnlyText } from "../io/viewOnly";

export type AssetKind = MediaAsset["kind"];

/**
 * Generic import for "Import media": registers files by content type as video / audio / image
 * assets, so each lands in the matching tab of the media library; files with a conflicting or
 * unrecognized type are rejected.
 *
 * The video path reuses importVideoFiles from io directly. Besides registering the asset, it also
 * stores the File in io's private table (export and speech-to-text fetch the original file via
 * getMediaFile) and puts the clip at the playhead; writing a separate version here would only
 * drift from it. Audio and images have no matching entry point in io (the kind of
 * importVideoFiles is hardcoded to "video"), so they are registered here,
 * but **after registering you must call registerMediaFile to hand the original File back to io**:
 * speech-to-text and export both fetch the original file via io.getMediaFile, and if this step is
 * missed, an imported mp3 fails at transcription with "asset file is not in memory".
 * Nothing hints that the cause is a missed registration on import.
 */

/** accept for the file picker: MIME wildcards first, then a list of extensions, so the file isn't greyed out when the system doesn't recognize the MIME type */
export const MEDIA_ACCEPT = [
  "video/*",
  "audio/*",
  "image/*",
  ...Object.keys(EXT_KIND).map((ext) => `.${ext}`),
].join(",");

export { classifyFileDetailed, EXT_KIND, KIND_LABEL } from "../io/mediaKinds";
export type { FileClassification } from "../io/mediaKinds";
export const classifyFile = (file: File): AssetKind | null => classifyFileDetailed(file).kind;

/** Metadata probing is capped at 5 seconds: a bad file must not stall the whole batch import; if nothing comes back, leave it empty and fall back to the default duration later */
function withTimeout<T>(run: (settle: (v: T) => void) => void, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => settle(fallback), 5000);
    run(settle);
  });
}

function probeAudio(url: string, name: string): Promise<{ duration?: number }> {
  return withTimeout<{ duration?: number }>((settle) => {
    const el = document.createElement("audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => settle({ duration: Number.isFinite(el.duration) ? el.duration : undefined });
    el.onerror = () => {
      console.warn(`[left] failed to probe audio: ${name}`);
      settle({});
    };
    el.src = url;
  }, {});
}

function probeImage(url: string, name: string): Promise<{ width?: number; height?: number }> {
  return withTimeout<{ width?: number; height?: number }>((settle) => {
    const img = new Image();
    img.onload = () => settle({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
    img.onerror = () => {
      console.warn(`[left] failed to probe image: ${name}`);
      settle({});
    };
    img.src = url;
  }, {});
}

/**
 * Registers one audio / image asset.
 *
 * The asset address is always /@media/<content hash> (A1), never blob: ...
 * the render process and the export process both live outside the browser and cannot reach blob:,
 * and the "blob → File" table in io is private, so assets registered outside never get into it.
 * blob: is used here only as a throwaway probe address (to get duration / width and height),
 * and is revoked once probing is done.
 * While storing (upload + hashing) is in progress, the asset stays pending and the media layer
 * draws an "Uploading" placeholder; on failure it does not fall back to blob:, it leaves the
 * address empty (see io/mediaUpload.ts).
 */
export async function registerAsset(file: File, kind: "audio" | "image"): Promise<string> {
  const blobUrl = URL.createObjectURL(file);
  const meta = kind === "audio" ? await probeAudio(blobUrl, file.name) : await probeImage(blobUrl, file.name);
  URL.revokeObjectURL(blobUrl);

  const media = actions.addMedia({
    kind,
    name: file.name,
    url: "",
    pending: true,
    duration: (meta as { duration?: number }).duration,
    width: (meta as { width?: number }).width,
    height: (meta as { height?: number }).height,
  });
  registerMediaFile(media.id, file);
  applyUploadedMedia(media.id, await uploadMediaFile(file));
  return media.id;
}

export interface ImportResult {
  counts: Record<AssetKind, number>;
  /** Names of files skipped because their type could not be recognized */
  skipped: string[];
  /** Category of the first accepted file, used to take the user to the matching tab */
  firstKind: AssetKind | null;
  /** Files with a conflicting type or no recognizable type at all, plus fix suggestions for the user */
  rejected: string[];
}

export async function importMediaFiles(files: FileList | File[]): Promise<ImportResult> {
  // Read-only project (guest): importing media is a write. The button is already greyed out; reaching here means a
  // path not covered, such as drag and drop
  if (blockedByReadOnly()) throw new Error(viewOnlyText());
  const releaseHold = holdOnlineQueueOriginals();
  try {
    const counts: Record<AssetKind, number> = { video: 0, audio: 0, image: 0 };
    const skipped: string[] = [];
    const rejected: string[] = [];
    let firstKind: AssetKind | null = null;

    const videos: File[] = [];
    const rest: { file: File; kind: "audio" | "image" }[] = [];
    for (const file of Array.from(files)) {
      const detected = classifyFileDetailed(file);
      const kind = detected.kind;
      if (!kind) {
        skipped.push(file.name);
        if (detected.reason) rejected.push(detected.reason);
        continue;
      }
      if (!firstKind) firstKind = kind;
      if (kind === "video") videos.push(file);
      else rest.push({ file, kind });
    }

    if (videos.length > 0) {
      counts.video = (await importVideoFiles(videos)).length;
    }
    for (const { file, kind } of rest) {
      await registerAsset(file, kind);
      counts[kind] += 1;
    }

    return { counts, skipped, firstKind, rejected };
  } finally {
    releaseHold();
  }
}
