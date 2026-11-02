/**
 * Subject detection: where people are in the frame and which side is empty.
 *
 * Used to answer requirements like "don't let cards cover people's faces": before this, it could only
 * rely on see_frames to let the model guess from images, and when it guessed wrong you couldn't tell.
 *
 * Two tiers with very different capabilities; both UI and tool descriptions must clarify which tier
 * the user receives:
 *   - light: YuNet (face) + RT-DETR-R18 (human body), running on onnxruntime. Recognizes only person / face.
 *   - full: adds Grounding DINO tiny, capable of finding targets by arbitrary text prompts
 *     ("cat", "phone", "red car").
 * Which tier to use is decided on the Python side based on dependencies and weights; Node does not guess.
 * When neither tier is available, engine is null, with **no fallback tier**: unlike motion tracking,
 * callers must fall back to see_frames to inspect images accordingly.
 *
 * Frame sampling detection is much faster than shot detection (one ffmpeg seek + one forward pass per sample),
 * but an asset often has 20-30 samples and still exceeds MCP bridge invocation timeouts, so it likewise runs
 * via background jobs + polling.
 */
import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse } from "http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { buildEnv, findPython, pipeToSse, readBody, spawnPython } from "./vite-plugin-stt";
import { createAssetSourceResolver } from "./audio-source.mjs";
import { assetServiceOrigin } from "./asset-client";
import { mediaSourceOf } from "./vision/ffmpeg-frames";
import { pythonInput, resolveMediaSource } from "./perception-source.mjs";
// Sampling upper limit shares the same constant with the frontend: previously the server had 200 while
// kernel had no limit, so the default path "calculate automatically when times is omitted" inevitably
// hit this 400 on long assets.
import { MAX_SUBJECT_TIMES } from "../src/kernel/project";
import { tr } from "./i18n.mjs";

export type SafeSide = "left" | "right" | "top" | "bottom";

export interface SubjectBox {
  /** The light tier has only person / face; the full tier has nouns from the prompt */
  label: string;
  /** Original video pixels */
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

export interface SubjectSample {
  /** Seconds within the asset */
  t: number;
  boxes: SubjectBox[];
  safeSide: SafeSide;
  occupancy: { left: number; right: number; top: number; bottom: number };
  /** This frame failed to be sampled (seek out of bounds, corrupted section in file). Empty boxes and occupancy of all four 0s are placeholders; the reader side must filter them out first */
  failed?: boolean;
  /** Reason provided by the Python side when failed */
  reason?: string;
}

export interface SubjectJob {
  id: string;
  mediaId?: string;
  status: "running" | "done" | "error";
  /** undefined before completion: which tier is selected by the Python side, known only once results return */
  engine?: "light" | "full";
  /** 0~100 */
  percent: number;
  message?: string;
  width?: number;
  height?: number;
  prompt?: string;
  samples?: SubjectSample[];
  /** Number of failed entries in samples. Provided by the Python result event; count manually if unavailable */
  failedCount?: number;
  /** Set to "full" when originally intending to run full but falling back to light halfway through. Checking only engine would make it look as though the user only had light installed originally */
  fellBackFrom?: "full";
  fallbackReason?: string;
  /** Internal use: running child process pid and timeout timer, used to kill the process tree on cancellation/timeout */
  pid?: number;
  timer?: NodeJS.Timeout;
  /** Already cancelled or killed by timeout; close callback must not modify message again */
  killed?: boolean;
}

const jobs = new Map<string, SubjectJob>();

/** Asset record → HTTP address on asset service. Written identically to vite-plugin-shots.ts, see server/perception-source.mjs */
const resolveSource = createAssetSourceResolver({ origin: assetServiceOrigin, toUrl: (m, origin) => mediaSourceOf(m, origin) });

/** How long to keep in the table after the job completes (done/error): kept briefly for the final poll; any longer is a pure leak */
const JOB_TTL_MS = 10 * 60 * 1000;

/** Maximum number of frames to sample at once. Each frame requires one ffmpeg seek; hundreds of frames would monopolize the machine. Shares a constant with kernel */
const MAX_TIMES = MAX_SUBJECT_TIMES;

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

/**
 * Run `promptcut_subject status` once and retrieve that line of JSON.
 *
 * The contract requires that "it must successfully emit a line of valid JSON even if nothing is
 * installed", so failing to get JSON here is always treated as an environment issue rather than
 * "extension not installed": the messages shown to users for the two cases are completely different.
 */
async function readStatus(root: string): Promise<
  { ok: true; info: Record<string, unknown> } | { ok: false; reason: string }
> {
  const python = findPython(root);
  if (!python) return { ok: false, reason: tr("No usable Python") };
  const env = await buildEnv(root, python);
  return new Promise((resolve) => {
    const child = spawnPython(python, ["-m", "promptcut_subject", "status"], env);
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e) => resolve({ ok: false, reason: tr("Interpreter failed to start: {0}", e.message) }));
    child.on("close", () => {
      const line = out.split(/\r?\n/).find((l) => l.includes('"event"'));
      if (!line) {
        // The last line of stderr is usually the traceback line: returning only "no status returned"
        // is equivalent to leaving the user troubleshooting in the dark.
        const tail = err.split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(" ");
        return resolve({ ok: false, reason: tail || tr("The interpreter returned no parseable status") });
      }
      try {
        resolve({ ok: true, info: JSON.parse(line) });
      } catch {
        resolve({ ok: false, reason: tr("Status is not valid JSON") });
      }
    });
  });
}

/**
 * Run a detection pass. engine is selected on the Python side; Node is only responsible for passing
 * arguments and receiving events.
 * video is an HTTP address on the asset service: newer packages pass the address directly, spawning
 * ffmpeg at each sample timestamp to fetch only that segment via Range; older packages stream to a
 * temporary file first then pass the path (see server/perception-source.mjs), deleting it after running.
 */
async function runDetection(
  root: string,
  job: SubjectJob,
  video: string,
  ref: Record<string, string>,
  times: number[],
  prompt: string | undefined,
  engine: string | undefined,
  maxSide: number | undefined,
): Promise<void> {
  const python = findPython(root);
  if (!python) {
    job.status = "error";
    job.message = tr("No usable Python, so subject detection can be neither installed nor run");
    return;
  }
  const env = await buildEnv(root, python);
  let input: { input: string; cleanup: () => void };
  try {
    input = await pythonInput({ src: video, ref, python, env, pkg: "promptcut_subject", spawnPython });
  } catch (e) {
    job.status = "error";
    job.message = (e as Error).message;
    return;
  }
  // Cancellation goes through killTree, and the close callback still fires; finally is used here to ensure temporary files are deleted regardless of how it finalizes
  try {
    await runDetectionOn(python, env, job, input.input, times, prompt, engine, maxSide);
  } finally {
    input.cleanup();
  }
}

async function runDetectionOn(
  python: string,
  env: NodeJS.ProcessEnv,
  job: SubjectJob,
  video: string,
  times: number[],
  prompt: string | undefined,
  engine: string | undefined,
  maxSide: number | undefined,
): Promise<void> {
  const args = ["-m", "promptcut_subject", "detect", video, "--times", times.join(",")];
  if (prompt) args.push("--prompt", prompt);
  if (engine) args.push("--engine", engine);
  if (maxSide) args.push("--max-side", String(maxSide));

  // 20-second margin per frame, 120-second floor. Full tier was measured at 2.7 s/frame; 20 seconds is
  // a 7x margin; the 120-second floor is reserved for model loading (full tier cold start measured
  // ~4 seconds, longer on HDDs).
  const limitMs = Math.max(120_000, times.length * 20_000);

  await new Promise<void>((resolve) => {
    const child = spawnPython(python, args, env);
    job.pid = child.pid;
    // Cap timer. Full tier measured 2.7 s/frame; a full 200 samples takes 9 minutes with a peak of ~2 GB,
    // during which previously nothing could stop it; if ffmpeg hangs waiting on a corrupted file, the job
    // stays in running forever, while frontend waitForSubjects polls in an infinite loop and spins
    // indefinitely. 20 s/frame is a 7x margin over measured full tier (2.7 s/frame), plus a 120-second
    // floor for model loading (~4 seconds for full tier, longer on cold start).
    job.timer = setTimeout(() => {
      job.killed = true;
      job.status = "error";
      job.message = tr("Subject detection timed out (over {0} seconds) and was force-stopped.", Math.round(limitMs / 1000))
        + tr("Reduce the number of times, or first confirm the tier with subject_status (the full tier is very slow).");
      killTree(child.pid);
    }, limitMs);
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.event === "progress") {
            const total = Number(ev.total) || times.length;
            const done = Number(ev.done) || 0;
            job.percent = Math.max(0, Math.min(99, Math.round((done / total) * 100)));
          } else if (ev.event === "result") {
            job.engine = ev.engine;
            job.width = ev.width;
            job.height = ev.height;
            job.prompt = ev.prompt ?? prompt ?? "";
            job.samples = ev.samples;
            // failedCount prefers the count from the Python side; older versions without this field count manually
            // (samples that failed frame sampling have failed:true). Leave undefined when unable to count, do not
            // report 0: "none failed" and "unknown whether any failed" are not the same thing.
            job.failedCount = Number.isFinite(Number(ev.failedCount))
              ? Number(ev.failedCount)
              : Array.isArray(ev.samples)
                ? (ev.samples as SubjectSample[]).filter((s) => s?.failed).length
                : undefined;
            if (ev.fellBackFrom === "full") {
              job.fellBackFrom = "full";
              job.fallbackReason = typeof ev.fallbackReason === "string" ? ev.fallbackReason : undefined;
            }
          } else if (ev.event === "error") {
            job.status = "error";
            job.message = ev.message;
          }
        } catch { /* Ignore lines that are not JSON */ }
      }
    });
    // Keep stderr: emit_error on the Python side goes to stdout, but interpreter crashes
    // (import failure, corrupted model file, killed) only spit tracebacks to stderr; reading
    // only stdout gives the user an empty message with nothing to troubleshoot.
    const stderrTail: string[] = [];
    child.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > 20) stderrTail.shift();
      }
    });
    child.on("error", (e) => { job.status = "error"; job.message = e.message; resolve(); });
    child.on("close", (code) => {
      if (job.timer) { clearTimeout(job.timer); job.timer = undefined; }
      job.pid = undefined;
      // When killed by timeout/cancellation, the message is already written; don't overwrite it with
      // "Process exited abnormally (code 1)": that makes people think Python crashed,
      // when the real reason is that we killed it ourselves.
      if (job.killed) { resolve(); return; }
      if (job.status !== "error" && !job.samples) {
        job.status = "error";
        job.message = stderrTail.join("\n").trim()
          || (code === 0 ? tr("Subject detection returned no result") : tr("Subject detection process exited abnormally (code {0})", code));
      }
      resolve();
    });
  });

  if (job.status === "error") return;
  job.percent = 100;
  job.status = "done";
}

/**
 * Kill the entire process tree.
 *
 * On Windows, child.kill() only kills python.exe itself; ffmpeg spawned by it becomes an
 * orphan and continues to hold files and CPU; taskkill /F /T is what reaps children and
 * grandchildren together. That is what stt does (killJob), copied verbatim here.
 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }).unref();
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch { /* The process may have just exited on its own; failing to kill it is not an error */ }
}

/** Delete from the table 10 minutes after done/error. Without deletion, jobs only grow, accumulating dozens per cut */
function retireLater(id: string): void {
  setTimeout(() => {
    const j = jobs.get(id);
    if (j && j.status !== "running") jobs.delete(id);
  }, JOB_TTL_MS).unref?.();
}

export function subjectPlugin(): Plugin {
  return {
    name: "vite-plugin-subject",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/subject")) return next();
        const url = req.url.split("?")[0];

        // GET /api/subject/status: which tier can be run
        if (req.method === "GET" && url === "/api/subject/status") {
          const r = await readStatus(root);
          if (!r.ok) {
            return sendJson(res, 200, { ok: true, ready: false, engine: null, reason: r.reason });
          }
          const info = r.info as {
            engine?: "light" | "full" | null;
            light?: { ready?: boolean };
            full?: { ready?: boolean };
          };
          // engine directly trusts the determination on the Python side: it checks both whether
          // dependencies can be imported and whether weights exist, which is more accurate than
          // inferring from a boolean here.
          const engine = info.engine ?? null;
          return sendJson(res, 200, {
            ok: true,
            ready: engine !== null,
            engine,
            detail: info,
          });
        }

        // POST /api/subject/install: install light tier dependencies (onnxruntime) online via pip,
        // streaming logs via SSE. The full tier is torch + transformers + 690 MB weights, which is not
        // installed online and is only shipped with the extension library package.
        if (req.method === "POST" && url === "/api/subject/install") {
          const python = findPython(root);
          if (!python) return sendJson(res, 400, { ok: false, error: tr("No usable Python") });
          const env = await buildEnv(root, python);
          // Cannot include -I: -I implies -E, which will **completely ignore PYTHONPATH**, while buildEnv
          // relies on PYTHONPATH to pass packages to non-embeddable interpreters (python/.venv, or
          // PROMPTCUT_PYTHON pointing to a conda environment). In testing, with -I this path always reports
          // No module named promptcut_subject, while status/detect (neither has -I) in the same environment
          // works fine. The built-in embeddable interpreter does not recognize PYTHONPATH in the first place
          // and uses the promptcut_pylibs.pth hook, so removing -I has no side effects on it.
          return pipeToSse(spawnPython(python, ["-m", "promptcut_subject", "install"], env), res);
        }

        // POST /api/subject/detect { mediaId, media: { id, name, kind, url, hash }, times, prompt? }: start a background job.
        // Assets are fetched via asset service (see server/perception-source.mjs): return 404 if the
        // asset is missing, return 502 if asset service is unreachable; ignore path in the request body.
        if (req.method === "POST" && url === "/api/subject/detect") {
          try {
            const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
            const raw: unknown = body.times;
            if (!Array.isArray(raw) || raw.length === 0) {
              return sendJson(res, 400, { ok: false, error: "times needs at least one timestamp (in seconds), written as [1.2, 5.4]" });
            }
            const times = raw
              .map(Number)
              .filter((t) => Number.isFinite(t) && t >= 0)
              .sort((a, b) => a - b);
            if (times.length === 0) {
              return sendJson(res, 400, { ok: false, error: "None of the values in times is a valid number of seconds" });
            }
            if (times.length > MAX_TIMES) {
              return sendJson(res, 400, {
                ok: false,
                error: `At most ${MAX_TIMES} sample times per request (received ${times.length}), please split into batches`,
              });
            }
            const source = await resolveMediaSource(body, resolveSource);
            if (!source.ok) return sendJson(res, source.status, { ok: false, error: source.error, ...(source.kind ? { kind: source.kind } : null) });
            const video = source.src;
            const job: SubjectJob = {
              id: randomUUID().slice(0, 8),
              mediaId: body.mediaId ?? source.media.id,
              status: "running",
              percent: 0,
              prompt: typeof body.prompt === "string" ? body.prompt : "",
            };
            jobs.set(job.id, job);
            // Do not await: return jobId to the frontend immediately; progress is polled
            void runDetection(
              root, job, video, source.media, times,
              typeof body.prompt === "string" && body.prompt.trim() ? body.prompt : undefined,
              typeof body.engine === "string" ? body.engine : undefined,
              Number.isFinite(Number(body.maxSide)) ? Number(body.maxSide) : undefined,
            ).catch((e) => {
              job.status = "error";
              job.message = e instanceof Error ? e.message : String(e);
            }).finally(() => retireLater(job.id));
            return sendJson(res, 200, { ok: true, jobId: job.id, times: times.length });
          } catch (e) {
            return sendJson(res, 400, { ok: false, error: (e as Error).message });
          }
        }

        // POST /api/subject/job/<id>/cancel: abort a running job.
        // Full tier at top-spec can run for over nine minutes; without this route, both users and the Agent
        // would just have to wait.
        const cancelMatch = req.method === "POST" && url.match(/^\/api\/subject\/job\/([\w-]+)\/cancel$/);
        if (cancelMatch) {
          const job = jobs.get(cancelMatch[1]);
          if (!job) return sendJson(res, 404, { ok: false, error: tr("Job not found, the service may have restarted") });
          if (job.status !== "running") {
            return sendJson(res, 200, { ok: true, cancelled: false, status: job.status, message: "The job has already finished" });
          }
          job.killed = true;
          job.status = "error";
          job.message = tr("Subject detection was cancelled");
          if (job.timer) { clearTimeout(job.timer); job.timer = undefined; }
          killTree(job.pid);
          retireLater(job.id);
          return sendJson(res, 200, { ok: true, cancelled: true });
        }

        // GET /api/subject/job/<id>
        const jobMatch = req.method === "GET" && url.match(/^\/api\/subject\/job\/([\w-]+)$/);
        if (jobMatch) {
          const job = jobs.get(jobMatch[1]);
          if (!job) return sendJson(res, 404, { ok: false, error: tr("Job not found, the service may have restarted") });
          // timer is Node's Timeout object, JSON.stringify produces an empty shell, and pid should not be
          // exposed to the frontend: only return fields in the contract.
          const { timer: _timer, pid: _pid, killed: _killed, ...safe } = job;
          return sendJson(res, 200, { ok: true, job: safe });
        }

        return next();
      });
    },
  };
}
