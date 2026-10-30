import type { MediaAsset } from "../../kernel/project";

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

export const KIND_LABEL: Record<AssetKind, string> = { video: "视频", audio: "配乐", image: "图片" };

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
    const detected = mime || "未知 MIME";
    return {
      kind: null, extensionKind, mimeKind, extension, mime,
      conflict: true,
      reason: `文件“${file.name}”的扩展名表示${KIND_LABEL[extensionKind]}，但检测到 MIME 为 ${detected}，不能按${KIND_LABEL[extensionKind]}导入。请把它放入“${KIND_LABEL[extensionKind]}”素材，或改用与实际内容匹配的扩展名。`,
    };
  }
  if (mimeKind) return { kind: mimeKind, extensionKind, mimeKind, extension, mime };
  if (extensionKind) return { kind: extensionKind, extensionKind, mimeKind, extension, mime };
  return {
    kind: null, extensionKind, mimeKind, extension, mime,
    reason: `无法识别文件“${file.name}”的类型。请使用视频、音频或图片文件，并保留正确的扩展名。`,
  };
}

export function classifyFile(file: Pick<File, "name" | "type">): AssetKind | null {
  return classifyFileDetailed(file).kind;
}
