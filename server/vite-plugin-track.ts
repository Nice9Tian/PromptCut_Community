/**
 * Server-side interface for motion tracking.
 *
 * Endpoint shape is copied from vite-plugin-shots, and Python-side process/environment/SSE tools
 * are directly imported from vite-plugin-stt: that `._pth` and pylibs handling is delicate,
 * do not copy it a second time.
 *
 * Tracking is divided into two tiers:
 *   - Extension installed → BootsTAPIR, arbitrary point tracking, with occlusion detection
 *   - Not installed      → Frontend JS template matching fallback (not run here)
 * The engine field in `status` is the tier tag for frontend and AI.
 */
import type { Plugin, ServerResponse } from "vite";
import type { Connect } from "vite";
import { randomUUID } from "node:crypto";

import {
  findPython,
  buildEnv,
  spawnPython,
  pipeToSse,
  readBody,
} from "./vite-plugin-stt";
import { createAssetSourceResolver } from "./audio-source.mjs";
import { assetServiceOrigin } from "./asset-client";
import { mediaSourceOf } from "./vision/ffmpeg-frames";
import { pythonInput, resolveMediaSource } from "./perception-source.mjs";
import { tr } from "./i18n.mjs";

/** Asset record → HTTP address on asset service. Written identically to vite-plugin-shots.ts, see server/perception-source.mjs */
const resolveSource = createAssetSourceResolver({ origin: assetServiceOrigin, toUrl: (m, origin) => mediaSourceOf(m, origin) });

type TrackEngine = "bootstapir" | "template";

interface TrackPoint {
  query: [number, number, number];
  xy: [number, number][];
  visible: boolean[];
  /** This point could not be tracked (insufficient texture, on the edge); only provided by fallback tier. If provided, do not use this trajectory */
  note?: string;
}

interface TrackJob {
  id: string;
  mediaId?: string;
  status: "running" | "done" | "error";
  /**
   * Which tier is running. **Subject to the engine in the result event**, do not hardcode when
   * starting the job: tier selection is determined on the Python side according to status
   * (uses neural network if extension is installed, uses template matching if not); guessing on
   * the Node side will only report template as bootstapir when the extension is not installed.
   */
  engine?: TrackEngine;
  percent: number;
  message?: string;
  width?: number;
  height?: number;
  frames?: number;
  points?: TrackPoint[];
}

const jobs = new Map<string, TrackJob>();

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

/**
 * Run tracking once. stdout produces one JSON per line, dispatched by event.
 * video is an HTTP address on asset service; if the Python package accepts a URL, pass the URL,
 * while older packages stream to a temporary file first (see server/perception-source.mjs) and delete after run.
 */
function runTracking(
  root: string,
  job: TrackJob,
  video: string,
  points: number[][],
  ref: Record<string, string>,
): Promise<void> {
  return new Promise(async (resolveRun) => {
    const python = findPython(root);
    if (!python) {
      job.status = "error";
      job.message = tr("No usable Python, cannot run the tracking extension.");
      return resolveRun();
    }
    const env = await buildEnv(root, python);
    let input: { input: string; cleanup: () => void };
    try {
      input = await pythonInput({ src: video, ref, python, env, pkg: "promptcut_track", spawnPython });
    } catch (e) {
      job.status = "error";
      job.message = (e as Error).message;
      return resolveRun();
    }
    const resolve = () => { input.cleanup(); resolveRun(); };
    // Cannot add -I: isolated mode ignores PYTHONPATH, so promptcut_track cannot be imported.
    // Only install uses -I (that step does not need our package on path).
    let child: ReturnType<typeof spawnPython>;
    try {
      child = spawnPython(
        python,
        ["-m", "promptcut_track", "track", "--video", input.input,
         "--points", JSON.stringify(points)],
        env,
      );
    } catch (e) {
      // Even if startup fails (e.g. .cmd interpreter rejects arguments with metacharacters), clean up:
      // temporary files must be deleted, and the job must fall back to error
      job.status = "error";
      job.message = (e as Error).message;
      return resolve();
    }

    // Keep stderr: human-readable messages from the Python side and actual crash stack traces are all here.
    // If only stdout is read, once the process crashes only an exit code remains, making debugging impossible.
    let errTail = "";
    child.stderr?.on("data", (d: Buffer) => {
      errTail = (errTail + d.toString("utf-8")).slice(-2000);
    });

    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf-8");
      // Split by line; the last segment may be incomplete, keep it waiting for the next batch
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.includes('"event"')) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.event === "progress" && typeof ev.percent === "number") {
          job.percent = ev.percent as number;
        } else if (ev.event === "result") {
          if (ev.engine === "bootstapir" || ev.engine === "template") {
            job.engine = ev.engine;
          }
          job.width = ev.width as number;
          job.height = ev.height as number;
          job.frames = ev.frames as number;
          job.points = ev.points as TrackPoint[];
          job.percent = 100;
        } else if (ev.event === "error") {
          job.status = "error";
          job.message = String(ev.message ?? tr("Tracking failed"));
        }
      }
    });

    child.on("error", (e) => {
      job.status = "error";
      job.message = e.message;
      resolve();
    });
    child.on("close", (code) => {
      if (job.status !== "error") {
        // Exit code 0 without results is also considered a failure: half-finished results are harder to debug than errors
        job.status = code === 0 && job.points ? "done" : "error";
        if (job.status === "error" && !job.message) {
          job.message = errTail.trim()
            ? tr("Tracking process exited abnormally (code {0}): {1}", code, errTail.trim().slice(-500))
            : tr("Tracking process exited abnormally (code {0})", code);
        }
      }
      resolve();
    });
  });
}

export function trackPlugin(): Plugin {
  return {
    name: "vite-plugin-track",
    configureServer(server) {
      const root = server.config.root;

      server.middlewares.use(async (req: Connect.IncomingMessage, res, next) => {
        if (!req.url?.startsWith("/api/track")) return next();
        const url = req.url.split("?")[0];

        // GET /api/track/status: whether the extension is installed
        if (req.method === "GET" && url === "/api/track/status") {
          const python = findPython(root);
          if (!python) {
            // Set engine to null instead of "template": fallback tier is also run by Python
            // (numpy does template matching), so neither tier can be used without an interpreter.
            // Reporting as template makes callers think tracking is still possible, resulting in every call failing.
            return sendJson(res, 200, {
              ok: true, ready: false, engine: null,
              reason: tr("No usable Python"),
            });
          }
          const env = await buildEnv(root, python);
          const child = spawnPython(python, ["-m", "promptcut_track", "status"], env);
          let out = "";
          child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
          child.on("error", () =>
            sendJson(res, 200, { ok: true, ready: false, engine: null,
                                 reason: tr("Interpreter failed to start") }));
          child.on("close", () => {
            try {
              const line = out.split(/\r?\n/).find((l) => l.includes('"event"'));
              const info = line ? JSON.parse(line) : {};
              // engine directly trusts the determination on the Python side: it checks torch, weights,
              // and numpy together, which is more accurate than inferring from ready here.
              sendJson(res, 200, {
                ok: true,
                ready: !!info.ready,
                engine: info.engine ?? null,
                detail: info,
              });
            } catch {
              sendJson(res, 200, { ok: true, ready: false, engine: null,
                                   reason: tr("The interpreter returned no parseable status") });
            }
          });
          return;
        }

        // POST /api/track/install: install torch, streaming logs via SSE (190 MB, takes a while to run)
        if (req.method === "POST" && url === "/api/track/install") {
          const python = findPython(root);
          if (!python) return sendJson(res, 400, { ok: false, error: tr("No usable Python") });
          const env = await buildEnv(root, python);
          return pipeToSse(spawnPython(python, ["-m", "promptcut_track", "install"], env), res);
        }

        // POST /api/track/track { mediaId, media: { id, name, kind, url, hash }, points }: start a background job.
        // Assets are fetched via asset service (see server/perception-source.mjs): return 404 if the
        // asset is missing, return 502 if asset service is unreachable; ignore path in the request body.
        if (req.method === "POST" && url === "/api/track/track") {
          try {
            const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
            const points = body.points;
            if (!Array.isArray(points) || points.length === 0
                || !points.every((p: unknown) => Array.isArray(p) && p.length === 3
                    && p.every((v) => typeof v === "number" && Number.isFinite(v)))) {
              return sendJson(res, 400, {
                ok: false,
                error: tr("points must be written as [[frame number, x, y], ...], with at least one point"),
              });
            }

            const source = await resolveMediaSource(body, resolveSource);
            if (!source.ok) return sendJson(res, source.status, { ok: false, error: source.error, ...(source.kind ? { kind: source.kind } : null) });
            const video = source.src;

            const job: TrackJob = {
              id: randomUUID().slice(0, 8),
              mediaId: body.mediaId ?? source.media.id,
              status: "running",
              percent: 0,
            };
            jobs.set(job.id, job);
            // Do not await: return jobId to the frontend immediately; progress is polled
            void runTracking(root, job, video, points, source.media).catch((e) => {
              job.status = "error";
              job.message = e instanceof Error ? e.message : String(e);
            });
            return sendJson(res, 200, { ok: true, jobId: job.id });
          } catch (e) {
            return sendJson(res, 400, { ok: false, error: (e as Error).message });
          }
        }

        // GET /api/track/job/<id>
        const jobMatch = req.method === "GET" && url.match(/^\/api\/track\/job\/([\w-]+)$/);
        if (jobMatch) {
          const job = jobs.get(jobMatch[1]);
          if (!job) return sendJson(res, 404, { ok: false, error: tr("Job not found, the service may have restarted") });
          return sendJson(res, 200, { ok: true, job });
        }

        return next();
      });
    },
  };
}
