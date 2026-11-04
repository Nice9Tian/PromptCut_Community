import type { Transcript, TranscriptSegment } from "../../kernel/project";
import { getMediaFile } from "./index";
import { actions } from "../../store/project";
import { onlineUnsupported } from "../../online/onlineUnsupported";
import { tr } from "../../i18n/index.ts";

/**
 * Compile-time constant of the online build (for how it is written and why, see "online build pruning" in
 * `src/online/pageFlag.ts`). The online browser mode has no local speech recognition (that needs the
 * editor process and the built-in Python; the entry points are all greyed out), so all three entry points
 * report "not supported yet" as soon as they are entered, and in the online build the /api/stt calls after
 * that are pruned away entirely (M8 leftover L24).
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export interface SttEngineStatus {
  installed: boolean;
  version?: string;
}

/** Shape of the events from the Python side, one JSON per line (fields appear depending on the event type) */
export interface SttEvent {
  event?: string;
  /** log event */
  line?: string;
  data?: string;
  stream?: string;
  /** error event */
  message?: string;
  stderr?: string;
  /** progress event */
  done?: number;
  total?: number;
  /** segment event */
  start?: number;
  end?: number;
  text?: string;
  /** done event */
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

/** Query the STT service status (Python version, whether the engine is installed, available models, etc.) */
export async function sttStatus(): Promise<SttStatus> {
  // The online browser mode has no local speech recognition (that needs the editor process and the built-in Python)
  if (ONLINE_BUILD) throw new Error(onlineUnsupported(tr("Speech recognition")));
  const res = await fetch("/api/stt/status");
  if (res.status === 503) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? tr("STT service unavailable (503): the bundled Python was not found, reinstall the installer once."));
  }
  if (!res.ok) {
    throw new Error(tr("/api/stt/status returned {0}", res.status));
  }
  return res.json();
}

/** Install the given engine (reads the pip log as a stream) */
export async function sttInstall(
  engine: string,
  onLog?: (line: string) => void
): Promise<{ ok: boolean; log: string[] }> {
  if (ONLINE_BUILD) throw new Error(onlineUnsupported(tr("Speech recognition")));
  const res = await fetch("/api/stt/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine }),
  });

  if (res.status === 503) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? tr("STT service unavailable (503)"));
  }
  if (!res.ok || !res.body) {
    throw new Error(tr("/api/stt/install returned {0}", res.status));
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
      const msg = ev.message ?? tr("Install failed");
      log.push("[error] " + msg);
      onLog?.("[error] " + msg);
    }
  });
  return { ok, log };
}

/** Transcribe a media file */
export async function transcribeMedia(
  mediaId: string,
  opts?: { engine?: string; model?: string; language?: string },
  onProgress?: (
    p: { done: number; total: number } | { log: string } | { segment: TranscriptSegment }
  ) => void
): Promise<Transcript> {
  if (ONLINE_BUILD) throw new Error(onlineUnsupported(tr("Speech recognition")));
  const file = getMediaFile(mediaId);
  if (!file) {
    throw new Error(tr("The media file is not in memory (it may be from an opened project), please import it again"));
  }

  const engine = opts?.engine ?? "faster-whisper";
  const model = opts?.model ?? "small";
  const language = opts?.language;

  // Generate a jobId (timestamp + random)
  const jobId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);

  // Upload the file
  const uploadRes = await fetch(
    `/api/stt/upload/${jobId}/${encodeURIComponent(file.name)}`,
    { method: "POST", body: file }
  );
  if (!uploadRes.ok) {
    throw new Error(tr("File upload failed: {0} {1}", uploadRes.status, await uploadRes.text()));
  }

  // Start transcription (SSE stream)
  const transcribeRes = await fetch("/api/stt/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, engine, model, language }),
  });

  if (transcribeRes.status === 503) {
    const data = await transcribeRes.json().catch(() => ({}));
    throw new Error(data.error ?? tr("STT service unavailable (503)"));
  }
  if (!transcribeRes.ok || !transcribeRes.body) {
    throw new Error(tr("/api/stt/transcribe returned {0}", transcribeRes.status));
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
      throw new Error(ev.message ?? tr("Transcription failed"));
    }
  });

  if (!finalTranscript) {
    throw new Error(tr("Transcription did not receive a done event"));
  }

  // Write to the store
  actions.setMediaTranscript(mediaId, finalTranscript);
  return finalTranscript;
}

/** Parse the SSE stream and call callback for each event (may throw) */
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
    } catch { /* Ignore non-JSON */ }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by \n\n
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const block of events) emit(block);
    }
    /*
     * What is left in the buffer when the stream ends must be sent too.
     *
     * Above, we split on \n\n, and the last piece (the part that has not yet seen its separator) stays in
     * buf waiting for the next read. But if the server closes the stream right after writing the last
     * event, that \n\n never comes: a done event that was fully received just rots in buf and gets dropped,
     * and the caller reports "transcription did not receive a done event", although the data had all
     * arrived. decode() without stream makes the TextDecoder flush its own tail as well.
     */
    buf += decoder.decode();
    if (buf.trim()) emit(buf);
  } finally {
    reader.releaseLock();
  }
}
