/**
 * Shot transition detection.
 *
 * Two paths with different capabilities; the UI must make clear which one the user gets:
 *   - Extension package installed → TransNetV2(ONNX). Detects both hard cuts and dissolves,
 *     and can even provide spans for dissolves.
 *   - Not installed → Falls back to ffmpeg's scdet filter. Only recognizes hard cuts,
 *     completely blind to dissolves.
 *
 * Detection is relatively slow (~36 seconds for 5 minutes of media), so always use background
 * jobs + polling, following the same pattern as speech-to-text.
 */
import type { Plugin, Connect, ViteDevServer } from "vite";
import type { ServerResponse } from "http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { buildEnv, dataDir, findPython, pipeToSse, readBody, spawnPython } from "./vite-plugin-stt";
import { createAssetSourceResolver } from "./audio-source.mjs";
import { assetServiceOrigin } from "./asset-client";
import { mediaSourceOf } from "./vision/ffmpeg-frames";
import { pythonInput, resolveMediaSource } from "./perception-source.mjs";

/**
 * Asset record -> HTTP URL on the asset service (input to ffprobe / ffmpeg / Python). Same route
 * as the asset layer for viewing video and audio measurement (`mediaSourceOf`; `/@media/<hash>` on
 * the local asset service pulls from the remote asset service in a shared project). The `path`
 * in the request body is ignored; see `server/perception-source.mjs`.
 */
const resolveSource = createAssetSourceResolver({ origin: assetServiceOrigin, toUrl: (m, origin) => mediaSourceOf(m, origin) });

export type TransitionKind = "cut" | "dissolve";

export interface Transition {
  kind: TransitionKind;
  /** Actual start and end of transition (seconds). On hard cuts both are almost equal; a dissolve spans the entire fade */
  start: number;
  end: number;
  /** The frame with the highest confidence; align with it when drawing markers */
  time: number;
  confidence: number;
  /** Thumbnail filename, used when drawing on the timeline. Dissolves have two (one each before and after the fade), drawn stacked */
  thumbs?: string[];
}

export interface ShotsJob {
  id: string;
  mediaId?: string;
  status: "running" | "done" | "error";
  engine: "transnetv2" | "scdet";
  /** 0~100 */
  percent: number;
  message?: string;
  duration?: number;
  fps?: number;
  transitions?: Transition[];
  shots?: { start: number; end: number; inTransition: TransitionKind | null; outTransition: TransitionKind | null }[];
}

import { shotsDir, shotsThumbMiddleware } from './asset-store/shots-thumb.mjs';
import { tr } from "./i18n.mjs";

const jobs = new Map<string, ShotsJob>();

export { shotsDir, shotsThumbMiddleware } from './asset-store/shots-thumb.mjs';

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

/** Get frame rate and duration from ffprobe. Detection needs actual fps to convert frame numbers to seconds. */
async function probeVideo(env: NodeJS.ProcessEnv, video: string): Promise<{ fps: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=r_frame_rate:format=duration",
      "-of", "json", video,
    ], { env, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(tr("ffprobe could not read video info from this file")));
      try {
        const j = JSON.parse(out);
        const raw = j.streams?.[0]?.r_frame_rate ?? "0/1";
        const [n, d] = String(raw).split("/").map(Number);
        const fps = d ? n / d : Number(raw);
        const duration = Number(j.format?.duration ?? 0);
        if (!fps || !Number.isFinite(fps)) return reject(new Error(tr("Could not read the frame rate")));
        resolve({ fps, duration });
      } catch (e) {
        reject(new Error(tr("Failed to parse ffprobe output: {0}", (e as Error).message)));
      }
    });
  });
}

/**
 * Fallback when the extension is not installed: ffmpeg scdet.
 *
 * In testing, it only recognizes hard cuts: a 1-second crossfade cannot be detected under any
 * threshold; when lowering the threshold enough to see the fade, hard cuts start reporting false
 * positives and high-speed motion within a single shot triggers 12 false detections. So we stick
 * to the default threshold of 10 here and honestly only report hard cuts, without pretending it
 * can do TransNetV2's job.
 */
function detectWithScdet(env: NodeJS.ProcessEnv, video: string, onLine: (t: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-i", video, "-vf", "scdet=threshold=10", "-f", "null", "-"],
      { env, windowsHide: true });
    let buf = "";
    child.stderr.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const m = line.match(/lavfi\.scd\.time:\s*([0-9.]+)/);
        if (m) onLine(Number(m[1]));
      }
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(tr("ffmpeg exit code {0}", code)))));
  });
}

/**
 * Capture thumbnails for each transition.
 *
 * Capture one for hard cuts (the frame after the switch); capture two for dissolves (before the
 * fade starts + after it ends); drawing them stacked on the timeline makes it clear at a glance
 * that "two frames are blending together".
 */
async function grabThumbs(env: NodeJS.ProcessEnv, video: string, outDir: string,
                          jobId: string, transitions: Transition[]): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i];
    // Hard cuts take the frame after the transition; dissolves take both ends of the fade, which are precisely the two shots involved in the overlay
    const stamps = t.kind === "dissolve"
      ? [Math.max(0, t.start - 0.04), t.end + 0.04]
      : [t.end + 0.04];
    const names: string[] = [];
    for (let k = 0; k < stamps.length; k++) {
      const name = `${jobId}-${i}-${k}.jpg`;
      const dest = path.join(outDir, name);
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn("ffmpeg", [
          "-hide_banner", "-loglevel", "error",
          "-ss", String(Math.max(0, stamps[k])), "-i", video,
          "-frames:v", "1", "-vf", "scale=160:-2", "-y", dest,
        ], { env, windowsHide: true });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
      });
      if (ok) names.push(name);
    }
    if (names.length) t.thumbs = names;
  }
}

/**
 * Run a detection pass. Prefer TransNetV2; fall back to scdet if unavailable.
 * video is an HTTP URL on the asset service: ffprobe, scdet, and thumbnail capture consume the
 * URL directly; the Python side passes either the URL or a temporary file depending on whether
 * the package accepts URLs.
 */
async function runDetection(root: string, job: ShotsJob, video: string, ref: Record<string, string>): Promise<void> {
  const python = findPython(root);
  const env = python ? await buildEnv(root, python) : { ...process.env };

  let meta: { fps: number; duration: number };
  try {
    meta = await probeVideo(env, video);
  } catch (e) {
    job.status = "error";
    job.message = (e as Error).message;
    return;
  }
  job.fps = meta.fps;
  job.duration = meta.duration;

  const useTransNet = python != null && await new Promise<boolean>((resolve) => {
    const child = spawnPython(python!, ["-m", "promptcut_shots", "status"], env);
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => resolve(false));
    child.on("close", () => {
      try {
        const line = out.split(/\r?\n/).find((l) => l.includes('"event"'));
        resolve(Boolean(line && JSON.parse(line).ready));
      } catch { resolve(false); }
    });
  });

  job.engine = useTransNet ? "transnetv2" : "scdet";

  if (useTransNet) {
    let input: { input: string; cleanup: () => void };
    try {
      input = await pythonInput({ src: video, ref, python: python!, env, pkg: "promptcut_shots", spawnPython });
    } catch (e) {
      job.status = "error";
      job.message = (e as Error).message;
      return;
    }
    await new Promise<void>((resolve) => {
      const child = spawnPython(python!, [
        "-m", "promptcut_shots", "detect", input.input, "--fps", String(meta.fps),
      ], env);
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.event === "progress" && typeof ev.percent === "number") job.percent = ev.percent;
            else if (ev.event === "result") {
              job.transitions = ev.transitions;
              job.shots = ev.shots;
              job.duration = ev.duration;
            } else if (ev.event === "error") {
              job.status = "error";
              job.message = ev.message;
            }
          } catch { /* Ignore lines that are not JSON */ }
        }
      });
      // Keep stderr as well. emit_error on the Python side goes to stdout, but if the interpreter
      // itself crashes (import failure, segfault, killed), it only dumps tracebacks to stderr;
      // if we only read stdout, the user gets an empty message and cannot diagnose anything.
      const stderrTail: string[] = [];
      child.stderr?.on("data", (d) => {
        for (const line of d.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          stderrTail.push(line);
          if (stderrTail.length > 20) stderrTail.shift();
        }
      });
      child.on("error", (e) => { job.status = "error"; job.message = e.message; resolve(); });
      child.on("close", (code) => {
        // If no result was obtained and no error event was received, rely on the exit code and stderr
        // to explain what happened
        if (code !== 0 && job.status !== "error" && !job.transitions) {
          job.status = "error";
          job.message = stderrTail.join("\n").trim() || tr("Shot detection process exited abnormally (code {0})", code);
        }
        resolve();
      });
    }).finally(() => input.cleanup());
  } else {
    const times: number[] = [];
    try {
      await detectWithScdet(env, video, (t) => {
        times.push(t);
        job.percent = Math.min(95, job.percent + 3);
      });
    } catch (e) {
      job.status = "error";
      job.message = (e as Error).message;
      return;
    }
    // scdet only gives a single timestamp with no span, so start and end are identical and it is
    // always treated as a hard cut
    job.transitions = times.map((t) => ({ kind: "cut" as const, start: t, end: t, time: t, confidence: 1 }));
    let cursor = 0;
    job.shots = [];
    for (const t of times) {
      if (t > cursor) job.shots.push({ start: cursor, end: t, inTransition: job.shots.length ? "cut" : null, outTransition: "cut" });
      cursor = t;
    }
    if (meta.duration > cursor) {
      job.shots.push({ start: cursor, end: meta.duration, inTransition: times.length ? "cut" : null, outTransition: null });
    }
  }

  if (job.status === "error") return;

  if (job.transitions?.length) {
    try {
      await grabThumbs(env, video, shotsDir(root), job.id, job.transitions);
    } catch { /* Failure to capture thumbnails does not affect detection results */ }
  }
  job.percent = 100;
  job.status = "done";
}

export function shotsPlugin(options: { projectStores?: any; projectAccess?: any } = {}): Plugin {
  return {
    name: "vite-plugin-shots",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      server.middlewares.use(shotsThumbMiddleware(root, options));

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/shots")) return next();
        const url = req.url.split("?")[0];

        // GET /api/shots/status: whether the extension is installed
        if (req.method === "GET" && url === "/api/shots/status") {
          const python = findPython(root);
          if (!python) return sendJson(res, 200, { ok: true, ready: false, engine: "scdet", reason: tr("No usable Python") });
          const env = await buildEnv(root, python);
          const child = spawnPython(python, ["-m", "promptcut_shots", "status"], env);
          let out = "";
          child.stdout.on("data", (d) => { out += d.toString(); });
          child.on("error", () => sendJson(res, 200, { ok: true, ready: false, engine: "scdet" }));
          child.on("close", () => {
            try {
              const line = out.split(/\r?\n/).find((l) => l.includes('"event"'));
              const info = line ? JSON.parse(line) : {};
              sendJson(res, 200, { ok: true, ready: !!info.ready, engine: info.ready ? "transnetv2" : "scdet", detail: info });
            } catch {
              sendJson(res, 200, { ok: true, ready: false, engine: "scdet" });
            }
          });
          return;
        }

        // POST /api/shots/install: install onnxruntime, stream logs via SSE
        if (req.method === "POST" && url === "/api/shots/install") {
          const python = findPython(root);
          if (!python) return sendJson(res, 400, { ok: false, error: tr("No usable Python") });
          const env = await buildEnv(root, python);
          return pipeToSse(spawnPython(python, ["-m", "promptcut_shots", "install"], env), res);
        }

        // POST /api/shots/detect { mediaId, media: { id, name, kind, url, hash } }: start a background job.
        // Assets are fetched via the asset service (see server/perception-source.mjs): returns 404 if the
        // asset does not exist, 502 if the asset service is unreachable; path in the request body is ignored.
        if (req.method === "POST" && url === "/api/shots/detect") {
          try {
            const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
            const source = await resolveMediaSource(body, resolveSource);
            if (!source.ok) return sendJson(res, source.status, { ok: false, error: source.error, ...(source.kind ? { kind: source.kind } : null) });
            const video = source.src;
            const job: ShotsJob = {
              id: randomUUID().slice(0, 8),
              mediaId: body.mediaId ?? source.media.id,
              status: "running",
              engine: "scdet",
              percent: 0,
            };
            jobs.set(job.id, job);
            // Do not await: return jobId to the frontend immediately; progress is polled
            void runDetection(root, job, video, source.media).catch((e) => {
              job.status = "error";
              job.message = e instanceof Error ? e.message : String(e);
            });
            return sendJson(res, 200, { ok: true, jobId: job.id });
          } catch (e) {
            return sendJson(res, 400, { ok: false, error: (e as Error).message });
          }
        }

        // GET /api/shots/job/<id>
        const jobMatch = req.method === "GET" && url.match(/^\/api\/shots\/job\/([\w-]+)$/);
        if (jobMatch) {
          const job = jobs.get(jobMatch[1]);
          if (!job) return sendJson(res, 404, { ok: false, error: tr("Job not found, the service may have restarted") });
          return sendJson(res, 200, { ok: true, job });
        }

        // GET /api/shots/thumb/<filename>: thumbnail on the timeline
        const thumbMatch = !options.projectStores && req.method === "GET" && url.match(/^\/api\/shots\/thumb\/([\w.-]+)$/);
        if (thumbMatch) {
          const file = path.join(shotsDir(root), thumbMatch[1]);
          // The filename is already strictly constrained by regex; verify once more here that it did not
          // escape the directory
          if (!file.startsWith(shotsDir(root) + path.sep)) return sendJson(res, 400, { ok: false });
          try {
            const data = await fs.readFile(file);
            res.setHeader("Content-Type", "image/jpeg");
            res.setHeader("Cache-Control", "max-age=3600");
            return res.end(data);
          } catch {
            return sendJson(res, 404, { ok: false, error: tr("Thumbnail not found") });
          }
        }

        return next();
      });
    },
  };
}
