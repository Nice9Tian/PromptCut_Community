import type { MediaAsset } from "../../kernel/project";
import { tr } from "../../i18n/index.ts";

export type AssetKind = MediaAsset["kind"];

/** Extensions we can identify without trusting a browser supplied MIME type. */
export const EXT_KIND: Record<string, AssetKind> = {
  mp4: "video", m4v: "video", mov: "video", webm: "video", mkv: "video", avi: "video",
  wmv: "video", flv: "video", mpg: "video", mpeg: "video", ts: "video", m2ts: "video",
  "3gp": "video", ogv: "video",
  mp3: "audio", wav: "audio", aac: "audio", m4a: "audio", flac: "audio", ogg: "audio",
  oga: "audio", opus: "audio", wma: "audio", aiff: "audio", aif: "audio",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image",
  tif: "image", tiff: "image", avif: "image", heic: "image", heif: "image", svg: "image",
};

export const KIND_LABEL: Record<AssetKind, string> = { video: tr("Video"), audio: tr("Background music"), image: tr("Images") };

export function extensionOf(name: string): string {
  const clean = name.trim().split(/[?#]/, 1)[0];
  const match = clean.match(/\.([a-z0-9]{2,8})$/i);
  return match?.[1]?.toLowerCase() ?? "";
}

export function kindFromExtension(name: string): AssetKind | null {
  const ext = extensionOf(name);
  return ext ? EXT_KIND[ext] ?? null : null;
}

export function kindFromMime(type: string): AssetKind | null {
  const mime = type.toLowerCase().split(";", 1)[0].trim();
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  return null;
}

export interface FileClassification {
  kind: AssetKind | null;
  extensionKind: AssetKind | null;
  mimeKind: AssetKind | null;
  extension: string;
  mime: string;
  conflict?: boolean;
  reason?: string;
}

/**
 * Classify a file while refusing obvious lies such as a .jpg whose MIME says video/mp4.
 * Generic browser types (empty and application/octet-stream) are intentionally ignored.
 */
export function classifyFileDetailed(file: Pick<File, "name" | "type">): FileClassification {
  const extension = extensionOf(file.name);
  const extensionKind = extension ? EXT_KIND[extension] ?? null : null;
  const mime = (file.type || "").toLowerCase().split(";", 1)[0].trim();
  const mimeKind = kindFromMime(mime);
  const mimeIsGeneric = !mime || mime === "application/octet-stream" || mime === "binary/octet-stream";

  if (extensionKind && !mimeIsGeneric && (!mimeKind || mimeKind !== extensionKind)) {
    const detected = mime || tr("Unknown MIME");
    return {
      kind: null, extensionKind, mimeKind, extension, mime,
      conflict: true,
      reason: `The extension of file "${file.name}" indicates ${KIND_LABEL[extensionKind]}, but the detected MIME is ${detected}, so it cannot be imported as ${KIND_LABEL[extensionKind]}. Put it in the "${KIND_LABEL[extensionKind]}" media, or use an extension that matches the actual content.`,
    };
  }
  if (mimeKind) return { kind: mimeKind, extensionKind, mimeKind, extension, mime };
  if (extensionKind) return { kind: extensionKind, extensionKind, mimeKind, extension, mime };
  return {
    kind: null, extensionKind, mimeKind, extension, mime,
    reason: `Cannot recognize the type of file "${file.name}". Use a video, audio or image file and keep the correct extension.`,
  };
}

export function classifyFile(file: Pick<File, "name" | "type">): AssetKind | null {
  return classifyFileDetailed(file).kind;
}
