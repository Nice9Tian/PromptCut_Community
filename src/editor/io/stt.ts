import type { Transcript, TranscriptSegment } from "../../kernel/project";
import { getMediaFile } from "./index";
import { actions } from "../../store/project";
import { onlineUnsupported } from "../../online/pageFlag";

/**
 * 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」)。在线浏览器模式没有本机语音识别
 * (那要编辑器进程与内置 Python;入口都已置灰),三个入口一进来就报「暂不支持」,在线构建里后面的 /api/stt 调用整段剪掉(M8 遗留 L24)。
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export interface SttEngineStatus {
  installed: boolean;
  version?: string;
}

/** Python 侧一行一个 JSON 的事件形状(字段按 event 类型出现) */
export interface SttEvent {
  event?: string;
  /** log 事件 */
  line?: string;
  data?: string;
  stream?: string;
  /** error 事件 */
  message?: string;
  stderr?: string;
  /** progress 事件 */
  done?: number;
  total?: number;
  /** segment 事件 */
  start?: number;
  end?: number;
  text?: string;
  /** done 事件 */
  engine?: string;
  model?: string;
  language?: string;
  segments?: TranscriptSegment[];
  [key: string]: unknown;
}

export interface SttStatus {
  python?: string;
  engines: {
    "faster-whisper": SttEngineStatus;
    whisper: SttEngineStatus;
  };
  cuda: boolean;
  models: string[];
  error?: string;
}

/** 查询 STT 服务状态(Python 版本、引擎是否安装、可用模型等) */
export async function sttStatus(): Promise<SttStatus> {
  // 在线浏览器模式没有本机语音识别(那要编辑器进程与内置 Python)
  if (ONLINE_BUILD) throw new Error(onlineUnsupported("语音识别"));
  const res = await fetch("/api/stt/status");
  if (res.status === 503) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "STT 服务不可用(503):找不到内置 Python,重装一次安装包即可。");
  }
  if (!res.ok) {
    throw new Error(`/api/stt/status 返回 ${res.status}`);
  }
  return res.json();
}

/** 安装指定引擎(流式读取 pip 日志) */
export async function sttInstall(
  engine: string,
  onLog?: (line: string) => void
): Promise<{ ok: boolean; log: string[] }> {
  if (ONLINE_BUILD) throw new Error(onlineUnsupported("语音识别"));
  const res = await fetch("/api/stt/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine }),
  });

  if (res.status === 503) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "STT 服务不可用(503)");
  }
  if (!res.ok || !res.body) {
    throw new Error(`/api/stt/install 返回 ${res.status}`);
  }

  const log: string[] = [];
  let ok = true;
  await readSseStream(res.body, (ev) => {
    if (ev.event === "log") {
      const line = ev.line ?? ev.data ?? "";
      log.push(line);
      onLog?.(line);
    } else if (ev.event === "error") {
      ok = false;
      const msg = ev.message ?? "安装失败";
      log.push("[error] " + msg);
      onLog?.("[error] " + msg);
    }
  });
  return { ok, log };
}

/** 转写媒体文件 */
export async function transcribeMedia(
  mediaId: string,
  opts?: { engine?: string; model?: string; language?: string },
  onProgress?: (
    p: { done: number; total: number } | { log: string } | { segment: TranscriptSegment }
  ) => void
): Promise<Transcript> {
  if (ONLINE_BUILD) throw new Error(onlineUnsupported("语音识别"));
  const file = getMediaFile(mediaId);
  if (!file) {
    throw new Error("素材文件不在内存里(可能是打开的项目),请重新导入");
  }

  const engine = opts?.engine ?? "faster-whisper";
  const model = opts?.model ?? "small";
  const language = opts?.language;

  // 生成 jobId(时间戳 + 随机)
  const jobId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);

  // 上传文件
  const uploadRes = await fetch(
    `/api/stt/upload/${jobId}/${encodeURIComponent(file.name)}`,
    { method: "POST", body: file }
  );
  if (!uploadRes.ok) {
    throw new Error(`文件上传失败: ${uploadRes.status} ${await uploadRes.text()}`);
  }

  // 启动转写(SSE 流)
  const transcribeRes = await fetch("/api/stt/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, engine, model, language }),
  });

  if (transcribeRes.status === 503) {
    const data = await transcribeRes.json().catch(() => ({}));
    throw new Error(data.error ?? "STT 服务不可用(503)");
  }
  if (!transcribeRes.ok || !transcribeRes.body) {
    throw new Error(`/api/stt/transcribe 返回 ${transcribeRes.status}`);
  }

  let finalTranscript: Transcript | null = null;

  await readSseStream(transcribeRes.body, (ev) => {
    if (ev.event === "progress") {
      onProgress?.({ done: ev.done ?? 0, total: ev.total ?? 0 });
    } else if (ev.event === "segment") {
      onProgress?.({ segment: { start: ev.start ?? 0, end: ev.end ?? 0, text: ev.text ?? "" } });
    } else if (ev.event === "log") {
      const line = ev.line ?? ev.data ?? "";
      if (line) onProgress?.({ log: line });
    } else if (ev.event === "done") {
      finalTranscript = {
        engine: ev.engine ?? engine,
        model: ev.model ?? model,
        language: ev.language ?? language,
        createdAt: new Date().toISOString(),
        segments: ev.segments ?? [],
      };
    } else if (ev.event === "error") {
      throw new Error(ev.message ?? "转写失败");
    }
  });

  if (!finalTranscript) {
    throw new Error("转写未收到 done 事件");
  }

  // 写入 store
  actions.setMediaTranscript(mediaId, finalTranscript);
  return finalTranscript;
}

/** 解析 SSE 流,逐事件调用 callback(可能 throw) */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: SttEvent) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  const emit = (block: string) => {
    const dataLine = block
      .split("\n")
      .find((l) => l.startsWith("data:"));
    if (!dataLine) return;
    const jsonStr = dataLine.slice("data:".length).trim();
    if (!jsonStr) return;
    try {
      const ev = JSON.parse(jsonStr) as SttEvent;
      onEvent(ev);
    } catch { /* 忽略非 JSON */ }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE 事件以 \n\n 分隔
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const block of events) emit(block);
    }
    /*
     * 流结束时缓冲区里剩下的那一段也要发。
     *
     * 上面按 \n\n 切,最后一段(还没等到分隔符的部分)留在 buf 里等下一次读取。可服务端
     * 把最后一个事件写完就直接关流的话,那个 \n\n 永远不会来 —— 已经完整收到的 done 事件
     * 就这么烂在 buf 里被丢掉,调用方报「转写未收到 done 事件」,而数据其实是到齐了的。
     * decode() 不带 stream 是让 TextDecoder 把它自己的尾巴也吐出来。
     */
    buf += decoder.decode();
    if (buf.trim()) emit(buf);
  } finally {
    reader.releaseLock();
  }
}
