/**
 * Frontend glue for shot-change detection: start the job, poll, and write the result into the store.
 *
 * Detection runs on the server (TransNetV2, with scdet as the fallback); this side only waits and
 * stores.
 */
import { readSseStream } from "../editor/io/stt";
import type { PerceptionMediaRef } from "./perceptionMedia";
import type { Shots } from "../kernel/project";
import { tr } from "../i18n/index.ts";

export interface ShotsJobState {
  status: "running" | "done" | "error";
  engine: "transnetv2" | "scdet";
  percent: number;
  message?: string;
  transitions?: Shots["transitions"];
  shots?: Shots["shots"];
}

/**
 * Whether the extension is installed. It works without it too, only falling back to scdet and
 * unable to recognize dissolves.
 */
export async function shotsStatus(): Promise<{ ready: boolean; engine: string; detail?: unknown }> {
  const r = await fetch("/api/shots/status");
  if (!r.ok) throw new Error(tr("Cannot find the status of the shot detection extension"));
  return r.json();
}

/**
 * Send only the asset identifier; the server fetches the bytes through the asset service (see
 * perceptionMedia.ts)
 */
export async function startShotDetection(media: PerceptionMediaRef): Promise<string> {
  const r = await fetch("/api/shots/detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId: media.id, media }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || tr("Shot detection failed to start"));
  return data.jobId as string;
}

export async function pollShotJob(jobId: string): Promise<ShotsJobState> {
  const r = await fetch(`/api/shots/job/${jobId}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || tr("Cannot find this detection job"));
  return data.job as ShotsJobState;
}

/**
 * Wait for a job to finish. Detecting 5 minutes of media takes about 36 seconds, so the polling
 * interval is 1 second.
 */
export async function waitForShots(jobId: string, onProgress?: (pct: number, engine: string) => void): Promise<Shots> {
  for (;;) {
    const job = await pollShotJob(jobId);
    onProgress?.(job.percent, job.engine);
    if (job.status === "error") throw new Error(job.message || tr("Shot detection failed"));
    if (job.status === "done") {
      return {
        engine: job.engine,
        createdAt: new Date().toISOString(),
        transitions: job.transitions ?? [],
        shots: job.shots ?? [],
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Installs the shot detection extension (onnxruntime + TransNetV2 weights).
 *
 * The server's `/api/shots/install` has always been there; only this client function was missing,
 * so the card on the start page could only look at the status, with no entry to install. Like
 * installTrack, it reads the pip log as a stream: this step takes tens of seconds, and if nothing
 * is shown in between, there is no telling whether it is installing or hung.
 */
export async function installShots(
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; needsModel: boolean; modelPath?: string; log: string[] }> {
  const res = await fetch("/api/shots/install", { method: "POST" });
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || tr("/api/shots/install returned {0}", res.status));
  }
  const log: string[] = [];
  let ok = true;
  let needsModel = false;
  let modelPath: string | undefined;
  await readSseStream(res.body, (ev) => {
    if (ev.event === "log") {
      const line = ev.line ?? ev.data ?? "";
      log.push(line);
      onLog?.(line);
    } else if (ev.event === "installed") {
      // The dependencies are installed, but the TransNetV2 weights are not in requirements and ship only
      // with the extension library package.
      // This is not a failure but "one step short", and must be reported separately from a real install
      // failure.
      needsModel = !!ev.needsModel;
      // The model in SttEvent is the speech-to-text model name (string), with the same name but a
      // different type from the object here, so narrow it in place instead of touching that shared event
      // type
      modelPath = (ev as unknown as { model?: { path?: string } }).model?.path;
    } else if (ev.event === "error") {
      ok = false;
      // The useful line is in stderr (pip's actual error, which file is missing), while message is often
      // just "process exit code N". If only message were used, the user would always see a sentence they
      // cannot act on.
      const msg = ev.message ?? tr("Install failed");
      const detail = typeof ev.stderr === "string" ? ev.stderr.trim() : "";
      const full = detail ? `${msg}
${detail}` : msg;
      log.push("[error] " + full);
      onLog?.("[error] " + full);
    }
  });
  return { ok, needsModel, modelPath, log };
}
