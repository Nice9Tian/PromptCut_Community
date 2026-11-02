/**
 * Frontend glue for subject detection: check the tier, start the job, poll, and fold the result into
 * Subjects.
 *
 * Detection runs on the server (YuNet + RT-DETR, plus Grounding DINO when the full tier is
 * installed); this side only waits and stores. Unlike motion tracking, the result **must be written
 * into the project document** (MediaAsset.subjects). The sampling times are computed per shot and
 * are stable for the same media, so once stored there is no need to rerun next time; the tracking
 * query points, by contrast, are pointed out fresh each time, and storing them would only make the
 * project file grow without bound.
 */
import { readSseStream } from "../editor/io/stt";
import type { PerceptionMediaRef } from "./perceptionMedia";
import type { Subjects, SubjectSample } from "../kernel/project";
import { tr } from "../i18n/index.ts";

export interface SubjectJobState {
  status: "running" | "done" | "error";
  /**
   * undefined until the job finishes: which tier is used is chosen on the Python side and only known
   * when the result comes back
   */
  engine?: "light" | "full";
  percent: number;
  message?: string;
  width?: number;
  height?: number;
  prompt?: string;
  samples?: SubjectSample[];
  /**
   * Number of samples whose frame extraction failed. undefined = the server did not report it (old
   * version), which is not the same as 0
   */
  failedCount?: number;
  /** "full" when it was meant to run full but fell back to light midway */
  fellBackFrom?: "full";
  fallbackReason?: string;
}

/**
 * Which tier it can run at.
 *
 * **There is no fallback tier**: engine being null means detection really cannot be done (the
 * dependencies are not installed or there is no Python), which differs from motion tracking. When a
 * caller meets null it should fall back to "judge by looking at the image", and not pretend that a
 * downgraded engine is still running.
 */
export async function subjectStatus(): Promise<{
  ready: boolean;
  engine: "light" | "full" | null;
  reason?: string;
  detail?: unknown;
}> {
  const r = await fetch("/api/subject/status");
  if (!r.ok) throw new Error(tr("Cannot find the status of the subject detection extension"));
  return r.json();
}

/**
 * Send only the asset identifier; the server fetches the bytes through the asset service (see
 * perceptionMedia.ts)
 */
export async function startSubjectDetection(
  media: PerceptionMediaRef,
  times: number[],
  prompt?: string,
): Promise<string> {
  const r = await fetch("/api/subject/detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId: media.id, media, times, ...(prompt ? { prompt } : null) }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || tr("Subject detection failed to start"));
  return data.jobId as string;
}

export async function pollSubjectJob(jobId: string): Promise<SubjectJobState> {
  const r = await fetch(`/api/subject/job/${jobId}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || tr("Cannot find this subject detection job"));
  return data.job as SubjectJobState;
}

/**
 * Cancel a running job. The server kills the whole process tree with taskkill /F /T (python + the
 * ffmpeg it started)
 */
export async function cancelSubjectJob(jobId: string): Promise<void> {
  await fetch(`/api/subject/job/${jobId}/cancel`, { method: "POST" }).catch(() => {});
}

/**
 * Wait for a job to finish. The polling interval is 1 second: one sample is one ffmpeg seek plus one
 * forward pass, tens of milliseconds at the light tier and a few hundred at the full tier, so twenty
 * or thirty samples usually take from a few seconds to a dozen or so.
 *
 * **A total time limit is required**: this used to be a `for(;;)` infinite loop, and once Python hung
 * (ffmpeg waiting forever on a bad file) the job stayed in running forever, this Promise never
 * resolved, and the caller's progress bar spun until the end of time. The default of 20 minutes is
 * a realistic number below the server's cap (20 seconds per frame × 200 frames is at most ~67
 * minutes): a fully configured full tier was measured at about 9 minutes, so 20 minutes is already a
 * twofold margin. On timeout it cancels proactively and throws, so the error branch on the
 * subjectJobs side catches it and list_shots can tell the model "stop polling".
 */
export async function waitForSubjects(
  jobId: string,
  onProgress?: (pct: number, engine: SubjectJobState["engine"]) => void,
  timeoutMs = 20 * 60 * 1000,
): Promise<Subjects> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      await cancelSubjectJob(jobId);
      throw new Error(
        tr("Subject detection did not finish within {0} minutes and was canceled.", Math.round(timeoutMs / 60000))
        + tr(" You can reduce the sampling points (pass times yourself), or first confirm the tier with subject_status: the full tier is an order of magnitude slower than light."),
      );
    }
    const job = await pollSubjectJob(jobId);
    onProgress?.(job.percent, job.engine);
    if (job.status === "error") throw new Error(job.message || tr("Subject detection failed"));
    if (job.status === "done") {
      return {
        // Finishing without reporting engine can only mean the result event on the Python side is missing a
        // field. Treating it as light is the **conservative** side: the caller will thereby know "the prompt
        // did not take effect, only person/face", while mislabeling it as full the other way round would
        // make people think the targets were searched for according to the prompt.
        engine: job.engine ?? "light",
        createdAt: new Date().toISOString(),
        prompt: job.prompt ?? "",
        width: job.width ?? 0,
        height: job.height ?? 0,
        samples: job.samples ?? [],
        // When the server did not report failedCount (old-version Python), count it ourselves, and do not
        // leave undefined: the reading side uses it to decide "how many samples this conclusion rests on".
        failedCount: job.failedCount ?? (job.samples ?? []).filter((s) => s.failed).length,
        ...(job.fellBackFrom === "full"
          ? { fellBackFrom: "full" as const, fallbackReason: job.fallbackReason }
          : null),
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Installs the light tier of subject detection (onnxruntime, about 30 MB).
 *
 * The full tier (torch + transformers + the 690 MB Grounding DINO weights) is not installed online
 * and ships only with the extension library package: installing such a huge lump online means
 * starting over from scratch after a single interruption.
 *
 * It reads the pip log as a stream instead of waiting for it to finish before replying: if nothing
 * is shown in between, there is no telling whether it is installing or hung.
 */
export async function installSubject(
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; needsModel: boolean; modelPath?: string; log: string[] }> {
  const res = await fetch("/api/subject/install", { method: "POST" });
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || tr("/api/subject/install returned {0}", res.status));
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
      // The dependencies are installed, but the YuNet / RT-DETR weights are not in requirements and ship
      // only with the extension library package.
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
      const full = detail ? `${msg}\n${detail}` : msg;
      log.push("[error] " + full);
      onLog?.("[error] " + full);
    }
  });
  return { ok, needsModel, modelPath, log };
}
