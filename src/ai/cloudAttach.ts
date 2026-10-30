/**
 * 云端对话的附件(契约 9.5 节,〔用户 2026-10-07 定〕云端下附件按钮可用)。纯函数,Node 单测直接用。
 *
 * 云端不走本机的附件接口(`/api/` 下的;在线构建不许请求 `/api/*`,守门清单见 `server/test/c10a-online-api-paths.json`),
 * 所以不引 `src/ai/attachments.ts`(它带着那几个本机接口);这里只放页面一侧要的几样:
 *   - 服务端回包 → 输入区附件条与对话气泡用的 `ChatAttachment`;
 *   - 选文件对话框的 `accept`(与本机一致);
 *   - 附件相关的出错话。
 *
 * （原在 `src/ai/cloud/attach.ts`，上移至公开侧 `src/ai/cloudAttach.ts`）
 */
import type { ChatAttachment } from "./types.ts";

/** 单个附件的上限(服务端 512 MB;超了回 413 `too-large`,同样的话也用于对话工作目录满了) */
export const CLOUD_ATTACH_MAX_BYTES = 512 * 1024 * 1024;

/** 选文件对话框的 `accept`:与本机一致(`src/ai/attachments.ts` 的 `acceptAttr`) */
export const CLOUD_ATTACH_ACCEPT = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif",
  ".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v",
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac",
  ".pdf", ".srt", ".vtt", ".json",
  ".txt", ".md", ".markdown", ".csv", ".log",
].join(",");

/** 云端附件上传的悬停说明(附件按钮) */
export const CLOUD_ATTACH_TITLE = "添加附件:文件传到云端这个对话的工作目录,让云端 Agent 用得上(单个不超过 512 MB)";

export const CLOUD_ATTACH_TOO_LARGE = "文件太大了,云端收不下(单个文件不超过 512 MB,这个对话的工作目录也有总量上限)。";
/** 只发了附件、没写话:服务端不收空消息 */
export const CLOUD_ATTACH_NEED_TEXT = "请写一句话,说明想让云端 Agent 怎么用这些文件。";

/** 输入区上一个附件的占位 id(上传期间、失败重试、移除都靠它对上) */
export function newCloudAttachId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

/** 页面一侧按文件名猜的类型(上传期间占位用;回包里服务端给的类型为准) */
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

/** 服务端回的类型(`video` / `image` / `audio` / `text` / `file`) → `ChatAttachment.kind`;不认识的按文件名猜 */
export function cloudAttachKind(serverKind: unknown, name: string): ChatAttachment["kind"] {
  switch (serverKind) {
    case "video": case "image": case "audio": case "text": return serverKind;
    default: return cloudAttachKindOfName(name);
  }
}

/** 上传回包 `{ name, url, size, kind, text? }`(契约第 2.3 节) */
export interface CloudAttachmentInfo {
  name: string;
  /** 形如 `work:attachments/<文件名>`;下一条消息的 `attachments: [{ url }]` 带回去 */
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

/** 发消息时带上的:只要传好了的、且属于当前对话的;其余算「没带上」,返回它们的个数供界面提示 */
export function pickSendable(list: readonly ChatAttachment[], conversationId: string): { usable: ChatAttachment[]; skipped: number } {
  const usable = list.filter((a) => a.status === "ready" && !!a.url && (!a.conversationId || a.conversationId === conversationId));
  return { usable, skipped: list.length - usable.length };
}

/** 发出去的消息里附件的显示形状:气泡只要名字与图标,不带文件内容 */
export function bubbleAttachments(list: readonly ChatAttachment[]): ChatAttachment[] {
  return list.map((a) => ({ url: a.url, name: a.name, kind: a.kind, bytes: a.bytes, status: "ready" as const }));
}
