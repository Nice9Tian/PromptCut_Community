/**
 * Cloud chat attachments (contract section 9.5, (user decision, 2026-10-07: attachment button
 * available under cloud)). Pure functions, used directly by Node unit tests.
 *
 * Cloud does not use local attachment endpoints (under `/api/`; online build must not request
 * `/api/*`, see gatekeeper manifest `server/test/c10a-online-api-paths.json`), so
 * `src/ai/attachments.ts` is not imported (it carries those local endpoints); only things needed
 * by page side are kept here:
 *   - Server response → `ChatAttachment` used by input area attachment bar and chat bubble;
 *   - File picker dialog `accept` (consistent with local);
 *   - Attachment-related error messages.
 *
 * (formerly in `src/ai/cloud/attach.ts`, moved up to public side `src/ai/cloudAttach.ts`)
 */
import type { ChatAttachment } from "./types.ts";
import { tr } from "../i18n/index.ts";

/** Limit for a single attachment (server 512 MB; returns 413 `too-large` when exceeded; same message is also used when chat working directory is full) */
export const CLOUD_ATTACH_MAX_BYTES = 512 * 1024 * 1024;

/** File picker dialog `accept`: consistent with local (`acceptAttr` in `src/ai/attachments.ts`) */
export const CLOUD_ATTACH_ACCEPT = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif",
  ".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v",
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac",
  ".pdf", ".srt", ".vtt", ".json",
  ".txt", ".md", ".markdown", ".csv", ".log",
].join(",");

/** Hover description for cloud attachment upload (attachment button) */
export const CLOUD_ATTACH_TITLE = tr("Add attachment: upload files to this cloud chat's working directory so the Cloud Agent can use them (max 512 MB each)");

export const CLOUD_ATTACH_TOO_LARGE = tr("File too large, the cloud can't accept it (each file must be 512 MB or less, and this chat's working directory also has a total size limit).");
/** Sent attachment only with no text: server does not accept empty messages */
export const CLOUD_ATTACH_NEED_TEXT = tr("Write one sentence explaining how you want the Cloud Agent to use these files.");

/** Placeholder id of an attachment in input area (matched against during upload, failed retry, and removal) */
export function newCloudAttachId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

/** Type inferred by page side from filename (used as placeholder during upload; type given by server in response takes precedence) */
export function cloudAttachKindOfName(name: string): ChatAttachment["kind"] {
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (ext === "srt" || ext === "vtt") return "srt";
  if (ext === "json") return "json";
  if (["txt", "md", "markdown", ".csv", "csv", "log"].includes(ext)) return "text";
  return "other";
}

/** Type returned by server (`video` / `image` / `audio` / `text` / `file`) → `ChatAttachment.kind`; unrecognized types are inferred from filename */
export function cloudAttachKind(serverKind: unknown, name: string): ChatAttachment["kind"] {
  switch (serverKind) {
    case "video": case "image": case "audio": case "text": return serverKind;
    default: return cloudAttachKindOfName(name);
  }
}

/** Upload response `{ name, url, size, kind, text? }` (contract section 2.3) */
export interface CloudAttachmentInfo {
  name: string;
  /** Formatted as `work:attachments/<filename>`; passed back in `attachments: [{ url }]` of the next message */
  url: string;
  size: number;
  kind: ChatAttachment["kind"];
  text?: string;
}

export function normalizeAttachmentInfo(raw: unknown, fallbackName: string): CloudAttachmentInfo | null {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.url !== "string" || !o.url) return null;
  const name = typeof o.name === "string" && o.name ? o.name : fallbackName;
  return {
    name,
    url: o.url,
    size: typeof o.size === "number" && Number.isFinite(o.size) ? o.size : 0,
    kind: cloudAttachKind(o.kind, name),
    ...(typeof o.text === "string" ? { text: o.text } : {}),
  };
}

/** Attached when sending: only uploaded and in current chat; others count as "not attached", returning count for UI hints */
export function pickSendable(list: readonly ChatAttachment[], conversationId: string): { usable: ChatAttachment[]; skipped: number } {
  const usable = list.filter((a) => a.status === "ready" && !!a.url && (!a.conversationId || a.conversationId === conversationId));
  return { usable, skipped: list.length - usable.length };
}

/** Display format of attachments in sent messages: bubbles only need name and icon, without file content */
export function bubbleAttachments(list: readonly ChatAttachment[]): ChatAttachment[] {
  return list.map((a) => ({ url: a.url, name: a.name, kind: a.kind, bytes: a.bytes, status: "ready" as const }));
}
