export type AttachmentKind =
  | "image"
  | "video"
  | "audio"
  | "text"
  | "pdf"
  | "json"
  | "srt"
  | "other";

export interface AttachmentRecord {
  id: string;
  name: string;
  kind: AttachmentKind;
  mime?: string;
  bytes?: number;
  srcPath: string | null;
  path?: string;
  url?: string;
  status: "importing" | "ready" | "error";
  error?: string;
  jobId?: string;
  text?: string;
}

export interface AttachJobView {
  id: string;
  conversationId: string;
  status: "importing" | "ready" | "error";
  error?: string;
  attachment: AttachmentRecord;
  startedAt?: number;
}

/** 根据文件名后缀推导附件类型 */
export function kindOfName(name: string): AttachmentKind {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex === -1) return "other";
  const ext = name.slice(dotIndex + 1).toLowerCase();

  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"].includes(ext)) {
    return "image";
  }
  if (["mp4", "mov", "webm", "mkv", "avi", "m4v"].includes(ext)) {
    return "video";
  }
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) {
    return "audio";
  }
  if (ext === "pdf") {
    return "pdf";
  }
  if (["srt", "vtt"].includes(ext)) {
    return "srt";
  }
  if (ext === "json") {
    return "json";
  }
  if (["txt", "md", "markdown", "csv", "log"].includes(ext)) {
    return "text";
  }
  return "other";
}

/** 生成唯一附件 ID */
export function newAttachmentId(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `att-${time}-${rand}`;
}

/** 从 File 对象读取底层原生磁盘路径（桌面环境有，Web 浏览器环境为 null） */
export function pickSrcPath(file: File): string | null {
  const rawPath = (file as any).path;
  return typeof rawPath === "string" && rawPath.length > 0 ? rawPath : null;
}

/** 返回支持的文件后缀名字符串，供 input accept 属性使用 */
export function acceptAttr(): string {
  return [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif",
    ".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v",
    ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac",
    ".pdf",
    ".srt", ".vtt",
    ".json",
    ".txt", ".md", ".markdown", ".csv", ".log"
  ].join(",");
}

/** 通过已有本地路径向服务端导入附件 */
export async function importByPath(
  conversationId: string,
  srcPath: string,
  name: string
): Promise<AttachJobView> {
  try {
    const res = await fetch("/api/chats/attach/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, srcPath, name }),
    });
    const data = await res.json();
    if (res.ok && data?.ok && data.job) {
      return data.job;
    }
    return {
      id: newAttachmentId(),
      conversationId,
      status: "error",
      error: data?.error || `导入失败: HTTP ${res.status}`,
      attachment: {
        id: newAttachmentId(),
        name,
        kind: kindOfName(name),
        srcPath,
        status: "error",
        error: data?.error || `导入失败: HTTP ${res.status}`,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: newAttachmentId(),
      conversationId,
      status: "error",
      error: msg,
      attachment: {
        id: newAttachmentId(),
        name,
        kind: kindOfName(name),
        srcPath,
        status: "error",
        error: msg,
      },
    };
  }
}

/** 通过流式上传将浏览器中的 File 发送给服务端 */
export async function uploadFile(
  conversationId: string,
  file: File
): Promise<AttachJobView> {
  try {
    const url = `/api/chats/attach/upload?conversationId=${encodeURIComponent(
      conversationId
    )}&name=${encodeURIComponent(file.name)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    });
    const data = await res.json();
    if (res.ok && data?.ok && data.job) {
      return data.job;
    }
    return {
      id: newAttachmentId(),
      conversationId,
      status: "error",
      error: data?.error || `上传失败: HTTP ${res.status}`,
      attachment: {
        id: newAttachmentId(),
        name: file.name,
        kind: kindOfName(file.name),
        bytes: file.size,
        srcPath: null,
        status: "error",
        error: data?.error || `上传失败: HTTP ${res.status}`,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: newAttachmentId(),
      conversationId,
      status: "error",
      error: msg,
      attachment: {
        id: newAttachmentId(),
        name: file.name,
        kind: kindOfName(file.name),
        bytes: file.size,
        srcPath: null,
        status: "error",
        error: msg,
      },
    };
  }
}

/** 查询单个附件导入任务的状态 */
export async function pollJob(jobId: string): Promise<AttachJobView | null> {
  try {
    const res = await fetch(`/api/chats/attach/status?jobId=${encodeURIComponent(jobId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok && data.job ? data.job : null;
  } catch {
    return null;
  }
}

/** 轮询等待任务完成：每 600ms 检查一次，最长等待 10 分钟 */
export async function waitForJob(
  jobId: string,
  onTick?: (j: AttachJobView) => void
): Promise<AttachJobView> {
  const maxWaitMs = 10 * 60 * 1000;
  const intervalMs = 600;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const job = await pollJob(jobId);
    if (job) {
      onTick?.(job);
      if (job.status !== "importing") {
        return job;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return {
    id: jobId,
    conversationId: "",
    status: "error",
    error: "导入任务超时（超过 10 分钟）",
    attachment: {
      id: jobId,
      name: "",
      kind: "other",
      srcPath: null,
      status: "error",
      error: "导入任务超时",
    },
  };
}
