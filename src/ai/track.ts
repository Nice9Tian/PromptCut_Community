/**
 * Frontend glue for motion tracking: start the job, poll, and get the trajectory.
 *
 * Both tiers run on the server: with the extension installed it uses BootsTAPIR, and without it
 * it falls back to numpy template matching.
 * This side is only responsible for starting the job, waiting for the result, and storing it.
 * Unlike shot detection, the trajectory is **not written into the project document**: the query
 * points are pointed out fresh by the user each time, and the same media can be tracked with many
 * sets of points, so putting them into project would only make the project file grow without
 * bound. So the result stays in memory, held by the Map in right/index.tsx, which is enough for
 * get_track to fetch it once.
 */

import { readSseStream } from "../editor/io/stt";
import type { PerceptionMediaRef } from "./perceptionMedia";
import { tr } from "../i18n/index.ts";

export interface TrackPoint {
  /** The query points specified by the user [frame number, x, y], in original pixels */
  query: [number, number, number];
  /** Per-frame coordinates, in original pixels */
  xy: [number, number][];
  /**
   * Whether it is visible in each frame. False when occluded or moved out of frame, in which case xy
   * is the model's guess
   */
  visible: boolean[];
  /**
   * This point was not tracked at all; only the fallback tier gives this (not enough texture, too close
   * to the edge). If note is given, the whole xy is a placeholder and visible is all false: do not use
   * it to bind a card.
   */
  note?: string;
}

export interface TrackJobState {
  status: "running" | "done" | "error";
  /**
   * undefined until the job finishes: which tier is used is chosen on the Python side and only known
   * when the result comes back
   */
  engine?: "bootstapir" | "template";
  percent: number;
  message?: string;
  width?: number;
  height?: number;
  frames?: number;
  points?: TrackPoint[];
}

export interface TrackResult {
  engine: "bootstapir" | "template";
  createdAt: string;
  width: number;
  height: number;
  frames: number;
  points: TrackPoint[];
}

/**
 * Which tier tracking can reach.
 *
 * ready speaks only for the neural network tier. **ready being false does not mean tracking is
 * impossible**: without the extension there is still numpy template matching (engine = "template"),
 * which is considerably worse in accuracy and robustness but works.
 * Only engine being null means neither tier can be used (not even Python is present).
 */
export async function trackStatus(): Promise<{
  ready: boolean;
  engine: "bootstapir" | "template" | null;
  reason?: string;
  detail?: unknown;
}> {
  const r = await fetch("/api/track/status");
  if (!r.ok) throw new Error(tr("Cannot find the status of the motion tracking extension"));
  return r.json();
}

/**
 * Send only the asset identifier; the server fetches the bytes through the asset service (see
 * perceptionMedia.ts)
 */
export async function startTracking(
  media: PerceptionMediaRef,
  points: number[][],
): Promise<string> {
  const r = await fetch("/api/track/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId: media.id, media, points }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || tr("Motion tracking failed to start"));
  return data.jobId as string;
}

export async function pollTrackJob(jobId: string): Promise<TrackJobState> {
  const r = await fetch(`/api/track/job/${jobId}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || tr("Cannot find this tracking job"));
  return data.job as TrackJobState;
}

/**
 * Wait for a job to finish. The polling interval is 1 second: the neural network tier takes about
 * 26 seconds for 250 frames and the fallback tier a little over 1 second for the same number of
 * frames, so one shared cadence for both tiers is enough.
 */
export async function waitForTrack(
  jobId: string,
  onProgress?: (pct: number, engine: TrackResult["engine"] | undefined) => void,
): Promise<TrackResult> {
  for (;;) {
    const job = await pollTrackJob(jobId);
    onProgress?.(job.percent, job.engine);
    if (job.status === "error") throw new Error(job.message || tr("Motion tracking failed"));
    if (job.status === "done") {
      return {
        // A job that finished without reporting engine can only mean the result event on the Python side is
        // missing a field. Treating it as template is the **conservative** side: the caller will thereby
        // warn "this is a downgraded result, do not take it too seriously", while mislabeling it as
        // bootstapir the other way round would make people take a rough result for accurate data.
        engine: job.engine ?? "template",
        createdAt: new Date().toISOString(),
        width: job.width ?? 0,
        height: job.height ?? 0,
        frames: job.frames ?? 0,
        points: job.points ?? [],
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Installs the motion tracking extension (torch + BootsTAPIR weights, close to 400 MB).
 *
 * It reads the pip log as a stream instead of waiting for it to finish before replying: this step
 * takes several minutes, and if nothing is shown in between, nobody can tell whether it is
 * installing or hung.
 */
export async function installTrack(
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; needsModel: boolean; modelPath?: string; log: string[] }> {
  const res = await fetch("/api/track/install", { method: "POST" });
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || tr("/api/track/install returned {0}", res.status));
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
      // The dependencies are installed, but the BootsTAPIR weights are not in requirements and ship only
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
