import { confirmedMissing } from "../src/audio/missingMaterialRecord";
import type { Plugin, ViteDevServer, Connect } from "vite";
import type { ServerResponse } from "http";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { createReadStream } from "fs";
import { spawn } from "child_process";
import type { AddressInfo } from "net";
import { exportBegin, exportEnd } from "./render-pool-state.mjs";
import { exportOriginalsGate } from "./export-originals";
import { hashFromUrl, originalHashOf } from "../src/render/mediaTier";
import { EXPORT_KEEP, claimExportDir, pruneExportDir, sweepExportRoot } from "./storage-leftovers.mjs";
import { tr as trText } from "./i18n.mjs";

interface ExportJob {
  id: string;
  status: "running" | "done" | "error" | "cancelled";
  done: number;
  total: number;
  /**
   * Which step is in progress: render = Chrome renders cards frame-by-frame, compose = ffmpeg merges
   * assets and encodes. done/total is the frame count of this step
   */
  stage?: "render" | "compose";
  message?: string;
  outDir: string;
  /** Absolute path, for "Open folder" and retrieving outputs; not returned outside the browser */
  absOutDir: string;
  /** Render child process; on cancel, kill its descendants too (it also spawns Chrome and ffmpeg) */
  child?: ReturnType<typeof spawn>;
  cancelled?: boolean;
}

/** Outputs allowed to be fetched by the browser, with allowlist blocking arbitrary disk reads */
const DELIVERABLES = ["preview.mp4", "overlay.mov"] as const;

const jobs = new Map<string, ExportJob>();
let lastJobId: string | null = null;

function sanitizeFilename(name: string) {
  return name.replace(/[/\\]/g, "").replace(/\.\./g, "");
}

/**
 * Export root directory. In the desktop app, root is runtime/app under installation directory, and
 * final video must not land there (deleted on uninstall), so it prefers PROMPTCUT_EXPORT_DIR set by
 * the shell (default %USERPROFILE%VideosPromptCut); falls back to <root>/out during development.
 */
function outRoot(root: string): string {
  return process.env.PROMPTCUT_EXPORT_DIR || path.resolve(root, "out");
}

function inside(file: string, dir: string): boolean {
  const target = path.resolve(file);
  const base = path.resolve(dir);
  return target === base || target.startsWith(base + path.sep);
}

/** The same PromptCut-owned folders exposed by vite-plugin-media. */
function allowedMediaRoots(root: string): string[] {
  const roots = [path.resolve(outRoot(root), "media"), path.join(os.homedir(), "Videos", "PromptCut", "media")];
  if (process.env.PROMPTCUT_MEDIA_DIR) roots.push(path.resolve(process.env.PROMPTCUT_MEDIA_DIR));
  return roots;
}

/**
 * Which URL each asset should use in the project received by export page (written back to
 * `project.media[].url`, modifying this export's own JSON copy in place).
 *
 * - **Those with a valid hash**: Hash is the asset's identity, recognizing only the asset service's
 *   hash-based URL `/@media/<original-size-asset-hash>` (same rule as `render-project.mjs` and
 *   `vite-plugin-vision.ts`). Do not check `path`: that is the drop target on importing machine;
 *   opening a `.proc` carrying the other party's path directly on another machine and exporting will
 *   cause decoding to fail if read by path (discovered 2026-09-30 by `claude/pack-hash`).
 *   URLs that are already this hash (`/@media/<hash>` or written with an extension) are kept as is.
 * - **Those without a hash and with empty URL** (legacy assets where files cannot be fetched locally
 *   after opening project and are marked "(missing)", see `src/editor/io/mediaUpload.ts`):
 *   Leave URL empty, no longer read by `path`: paths on that machine cannot be read here, and reading
 *   them causes export page decoding to fail, invalidating the entire export. Returned in `skipped`,
 *   where `dropSkippedMediaClips` removes clips referencing it from this export's timeline, and
 *   informs user (`skippedMedia` in `/api/export` response). Those uploading (`pending`) are not
 *   included here, proceeding as usual.
 * - **Those without a hash** (legacy assets during transition period): Route through protected read
 *   endpoint `/api/media/file?path=…` by `path` as usual; if path is in PromptCut's asset catalog and
 *   file exists, use resolved absolute path (legacy `.proc` may simultaneously carry an expired
 *   short URL `/@media/<filename>`).
 * - Assets uploaded by browser into staging area (`/@export/media/<file>`) are replaced with URLs in
 *   this export's directory.
 *
 * `opts` is for unit tests: asset catalog and "whether file exists" can be substituted.
 */
export async function normalizeExportMedia(
  project: any,
  root: string,
  id: string,
  opts: { roots?: string[]; exists?: (file: string) => Promise<boolean> } = {},
): Promise<{ skipped: Array<{ id: string; name: string }> }> {
  const skipped: Array<{ id: string; name: string }> = [];
  if (!project?.media || !Array.isArray(project.media)) return { skipped };
  const roots = opts.roots ?? allowedMediaRoots(root);
  const exists = opts.exists ?? (async (file: string) => { try { await fs.access(file); return true; } catch { return false; } });
  for (const m of project.media) {
    if (!m || typeof m !== "object") continue;
    // Assets deemed "confirmed missing" do not change URLs or get skipped: placeholder reconciliation
    // records for video and audio match the asset URL verbatim (src/audio/missingMaterial.ts);
    // during export, these clips output placeholders at original positions without reading their files.
    // Determination uses the same function as video and audio sides (counted only when record matches
    // category, name, URL, and hash of asset)
    if (confirmedMissing(m) && m.url) continue;
    const hash = originalHashOf(m);
    if (hash) {
      const url = String(m.url || "");
      if (hashFromUrl(url) !== hash || !url.includes(hash)) m.url = `/@media/${hash}`;
      continue;
    }
    if (!String(m.url || "") && !m.pending) {
      // Already marked missing: leave URL empty, do not read by path (see function header)
      m.url = "";
      skipped.push({ id: String(m.id ?? ""), name: String(m.name ?? "") });
      continue;
    }
    const rawPath = typeof m.path === "string" ? m.path : "";
    if (rawPath) {
      // Projects from the desktop media library carry an absolute path,
      // while the export page only knows HTTP URLs. Route it through the
      // guarded media endpoint so legacy projects render their real files.
      const file = path.resolve(rawPath);
      const usable = roots.some((dir) => inside(file, dir)) && await exists(file);
      m.url = `/api/media/file?path=${encodeURIComponent(usable ? file : rawPath)}`;
      continue;
    }
    if (m.url && String(m.url).startsWith("/@export/media/")) {
      const fileName = String(m.url).split("/").pop();
      if (fileName) m.url = `/@export/${id}/media/${fileName}`;
    }
  }
  return { skipped };
}

/**
 * Remove clips referencing `skipped` assets from this exported project (modifying the export's own
 * JSON copy in place), skipping this section instead of causing the export page to fail decoding.
 * Returns assets that genuinely had clips removed (each asset listed once, with count of removed
 * clips); missing assets with no clip references do not affect export and are not listed.
 */
export function dropSkippedMediaClips(project: any, skipped: Array<{ id: string; name: string }>): Array<{ id: string; name: string; clips: number }> {
  if (!skipped.length || !Array.isArray(project?.tracks)) return [];
  const byId = new Map(skipped.map((m) => [m.id, m]));
  const hits = new Map<string, number>();
  for (const tr of project.tracks) {
    if (!tr || !Array.isArray(tr.clips)) continue;
    tr.clips = tr.clips.filter((c: any) => {
      const mid = c?.mediaId;
      if (typeof mid !== "string" || !byId.has(mid)) return true;
      hits.set(mid, (hits.get(mid) ?? 0) + 1);
      return false;
    });
  }
  return skipped.filter((m) => hits.has(m.id)).map((m) => ({ ...m, clips: hits.get(m.id)! }));
}

async function handleMediaUpload(req: Connect.IncomingMessage, res: ServerResponse, root: string) {
  const rawName = req.url?.split("/").pop();
  if (!rawName) {
    res.statusCode = 400;
    res.end("Missing filename");
    return;
  }
  const name = decodeURIComponent(rawName);
  const safeName = sanitizeFilename(name);
  const stagingDir = path.resolve(outRoot(root), ".export-staging", "media");
  await fs.mkdir(stagingDir, { recursive: true });
  
  const destPath = path.resolve(stagingDir, safeName);
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", async () => {
    const buffer = Buffer.concat(chunks);
    await fs.writeFile(destPath, buffer);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ url: `/@export/media/${encodeURIComponent(safeName)}` }));
  });
}

/**
 * Clean up output directory after export process exits: keep only final video, transparent layer,
 * and project.json (`pruneExportDir` in `storage-leftovers.mjs`).
 * Performed on success, cancellation, and failure: frames / parts left behind by cancellation and
 * failure are similarly large chunks of waste; existing final videos and transparent layers are kept
 * as is, so this export remains visible in list. On cancellation, Chrome / ffmpeg grandchild
 * processes might exit slightly later than render process and still hold files; retry a few times
 * after a brief interval for those that cannot be deleted.
 */
async function cleanupExportDir(dir: string, { framesOnly = false } = {}) {
  // Exports with --no-video only produce frame-by-frame PNGs, which are outputs and not deleted
  const keep = framesOnly ? [...EXPORT_KEEP, "frames"] : EXPORT_KEEP;
  for (let attempt = 0; attempt < 4; attempt++) {
    const report = await pruneExportDir(dir, { keep, log: (m: string) => console.log(m) });
    if (!report.skipped.some((s: { reason: string }) => s.reason !== "link")) return report;
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  return null;
}

async function handleExportStart(req: Connect.IncomingMessage, res: ServerResponse, server: ViteDevServer, root: string) {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      let project = body;
      let frames: string | undefined;
      let fps: number | undefined;
      let noVideo: boolean | undefined;
      let workers: number | string | undefined;
      if (body.project) {
        project = body.project;
        frames = body.frames;
        fps = body.fps;
        noVideo = body.noVideo;
        workers = body.workers;
      }

      // C6.6: Export only uses original-size assets. If original-size assets referenced by clips
      // are not all present on current asset service, do not render final video (design doc Section 9, item 3)
      const gate = await exportOriginalsGate(project);
      if (!gate.ok) {
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "awaiting-uploader", code: "awaiting-uploader", message: gate.message, missing: gate.missing }));
        return;
      }

      const { id, outDir } = await claimExportDir(outRoot(root));
      const mediaDir = path.resolve(outDir, "media");
      await fs.mkdir(mediaDir, { recursive: true });
      
      // Move staging media
      const stagingDir = path.resolve(outRoot(root), ".export-staging", "media");
      try {
        const files = await fs.readdir(stagingDir);
        for (const file of files) {
          await fs.rename(path.resolve(stagingDir, file), path.resolve(mediaDir, file));
        }
      } catch (e) {
        // staging dir might not exist, ignore
      }
      
      // Asset URL: use hash if present, use path only if absent; for those marked missing, skip clips
      // containing them and inform user (see normalizeExportMedia for rules)
      const { skipped } = await normalizeExportMedia(project, root, id);
      const skippedMedia = dropSkippedMediaClips(project, skipped);
      if (skippedMedia.length) console.warn(`[export] Skipping clips whose media is missing: ${skippedMedia.map((m) => `${m.name || m.id}×${m.clips}`).join(", ")}`);
      
      const projectJsonPath = path.resolve(outDir, "project.json");
      await fs.writeFile(projectJsonPath, JSON.stringify(project, null, 2));
      
      lastJobId = id;
      // Path returned to browser: out/export-<id> relative to project root during development;
      // absolute path in desktop app (with PROMPTCUT_EXPORT_DIR set)
      const relOutDir = process.env.PROMPTCUT_EXPORT_DIR ? outDir : `out/export-${id}`;
      // The child does not print its first frame until Chrome has loaded and
      // sampled the project.  Seed the job with the real render total so the
      // dialog never shows the misleading 0/1 while that work is underway.
      const renderFps = Number(fps) > 0 ? Number(fps) : Number(project.fps) || 30;
      const renderTotal = frames && /^\d+\s*-\s*\d+$/.test(frames)
        ? (() => { const [a, b] = frames.split("-").map(Number); return Math.max(1, b - a + 1); })()
        : Math.max(1, Math.floor((Number(project.duration) || 0) * renderFps));
      const job: ExportJob = { id, status: "running", done: 0, total: renderTotal, stage: "render", outDir: relOutDir, absOutDir: outDir };
      jobs.set(id, job);
      
      // Spawn child process
      let port = server.config.server.port;
      if (!port) {
        const address = server.httpServer?.address() as AddressInfo;
        port = address?.port || 5190;
      }
      
      const args = [
        "scripts/export-frames.mjs",
        "--url",
        `http://127.0.0.1:${port}/?export=1&timeline=/@export/${id}/project.json`,
        "--out",
        relOutDir,
        // Parallelize by machine resources by default; each chunk still pushes from frame 0,
        // and only splits at safe card boundaries.
        "--workers",
        workers !== undefined && workers !== null && workers !== ""
          ? String(workers)
          : (process.env.PROMPTCUT_EXPORT_WORKERS || "auto"),
      ];
      if (frames) {
        args.push("--frames", frames);
      }
      if (fps) {
        args.push("--fps", String(fps));
      }
      if (noVideo) {
        args.push("--no-video");
      }
      
      const child = spawn(process.execPath, args, { cwd: root, windowsHide: true });
      job.child = child;
      /*
       * Accounting (render-pool-state.mjs): export also spawns Chrome and consumes cores, so the
       * render pool must count it when calculating slots, and idle prerendering is paused during
       * export (docs/archive/topics/decoupling-plan.md section 3.3 "Export has lowest priority").
       * Record completion only once: when a child process fails to start, there may only be error
       * and no close, so both paths must be handled.
       */
      exportBegin();
      let accounted = true;
      const settle = () => {
        if (!accounted) return;
        accounted = false;
        exportEnd();
      };
      child.on("error", settle);
      child.on("close", settle);

      let stderrLog: string[] = [];
      child.stdout.on("data", (data) => {
        const str = data.toString();
        // Both steps report progress separately: "Exported frame 0 (1/90)" is Chrome rendering cards,
        // and "Composited frame 45/90" is ffmpeg compositing assets.
        // A chunk of output may contain multiple lines; take the last line
        const composed = [...str.matchAll(/Composited frame (\d+)\/(\d+)/g)].pop();
        const rendered = [...str.matchAll(/Exported frame \d+ \((\d+)\/(\d+)\)/g)].pop();
        const m = composed || rendered;
        if (m) {
          job.stage = composed ? "compose" : "render";
          job.done = parseInt(m[1], 10);
          job.total = parseInt(m[2], 10);
        }
      });
      
      child.stderr.on("data", (data) => {
        stderrLog.push(data.toString());
        if (stderrLog.length > 10) stderrLog.shift();
      });
      
      child.on("close", async (code) => {
        job.child = undefined;
        // Clean up the directory before reporting completion: when the UI displays "Done", the
        // directory is already in its final state (final video and transparent layer remain untouched,
        // file retrieval is unaffected)
        await cleanupExportDir(outDir, { framesOnly: !!noVideo }).catch(() => {});
        if (job.cancelled) {
          job.status = "cancelled";
          job.message = "Cancelled";
        } else if (code === 0) {
          job.status = "done";
        } else {
          job.status = "error";
          const tail = stderrLog.join("").trim();
          // 0xC0000142 = STATUS_DLL_INIT_FAILED: the child process failed to even load DLLs, so stderr
          // is empty. Reporting a bare decimal number is incomprehensible, so give a plain-English message here.
          job.message = tail
            || (code === 3221225794
              ? trText("Render process failed to start (0xC0000142). This is usually caused by too many browser instances open at once. Close some and try again; if it keeps happening, restart the app.")
              : trText("Render process exited abnormally (code {0})", code));
        }
      });
      
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id, outDir: relOutDir, skippedMedia }));
    } catch (err: unknown) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
    }
  });
}

function handleProgress(req: Connect.IncomingMessage, res: ServerResponse) {
  // /api/export/<id>
  const parts = req.url?.split("/") || [];
  const id = parts.pop()?.split("?")[0];
  if (!id) {
    res.statusCode = 400;
    res.end("Missing ID");
    return;
  }
  
  const job = jobs.get(id);
  if (!job) {
    res.statusCode = 404;
    res.end("Job not found");
    return;
  }
  
  const isSSE = req.headers.accept === "text/event-stream" || req.url?.includes("sse=1");
  if (isSSE) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    
    const sendEvent = () => {
      res.write(`data: ${JSON.stringify({ done: job.done, total: job.total, stage: job.stage, status: job.status, message: job.message })}\n\n`);
    };
    
    sendEvent();
    
    if (job.status !== "running") {
      res.end();
      return;
    }
    
    const interval = setInterval(() => {
      sendEvent();
      if (job.status !== "running") {
        clearInterval(interval);
        res.end();
      }
    }, 500);
    
    req.on("close", () => {
      clearInterval(interval);
    });
  } else {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ done: job.done, total: job.total, stage: job.stage, status: job.status, message: job.message }));
  }
}

async function serveFile(filePath: string, req: Connect.IncomingMessage, res: ServerResponse) {
  try {
    const stat = await fs.stat(filePath);
    const range = req.headers.range;
    
    let contentType = "application/octet-stream";
    if (filePath.endsWith(".json")) contentType = "application/json";
    else if (filePath.endsWith(".mp4")) contentType = "video/mp4";
    else if (filePath.endsWith(".webm")) contentType = "video/webm";
    else if (filePath.endsWith(".mov")) contentType = "video/quicktime";
    else if (filePath.endsWith(".png")) contentType = "image/png";
    else if (filePath.endsWith(".wav")) contentType = "audio/wav";
    
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;
      
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": contentType,
      });
      
      const stream = (await import("fs")).createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      });
      const stream = (await import("fs")).createReadStream(filePath);
      stream.pipe(res);
    }
  } catch (err) {
    res.statusCode = 404;
    res.end("Not found");
  }
}

/** Stream a deliverable to the browser. Only whitelisted filenames are accepted; paths are not accepted. */
async function handleDeliverable(res: ServerResponse, id: string, name: string) {
  const job = jobs.get(id);
  if (!job) {
    res.statusCode = 404;
    return res.end("Unknown export job");
  }
  if (!(DELIVERABLES as readonly string[]).includes(name)) {
    res.statusCode = 400;
    return res.end("Not a deliverable");
  }
  const file = path.resolve(job.absOutDir, name);
  // The name comes from the whitelist; confirm once more here that it has not escaped the deliverables directory
  if (!file.startsWith(path.resolve(job.absOutDir) + path.sep)) {
    res.statusCode = 400;
    return res.end("Path escaped output dir");
  }
  try {
    const stat = await fs.stat(file);
    res.setHeader("Content-Type", name.endsWith(".mov") ? "video/quicktime" : "video/mp4");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "no-store");
    // Stream the finished movie to the browser.  A multi-gigabyte Buffer here
    // would duplicate the export in the Vite process just as the child is
    // closing Chrome/ffmpeg.
    createReadStream(file).on("error", () => { if (!res.headersSent) res.statusCode = 404; res.destroy(); }).pipe(res);
  } catch {
    res.statusCode = 404;
    res.end(trText("Output not generated yet"));
  }
}

/** Reveal the deliverables directory in the file manager. Windows uses explorer; other platforms use their own. */
function handleReveal(res: ServerResponse, id: string) {
  const job = jobs.get(id);
  if (!job) {
    res.statusCode = 404;
    return res.end("Unknown export job");
  }
  const opener = process.platform === "win32" ? "explorer.exe"
    : process.platform === "darwin" ? "open" : "xdg-open";
  // explorer returns exit code 1 when opening a directory; this is not a failure, so ignore the exit code
  spawn(opener, [job.absOutDir], { detached: true, stdio: "ignore" }).unref();
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, dir: job.outDir }));
}

/**
 * Cancel export. The render process also spawns Chrome and ffmpeg itself; killing only that
 * process leaves orphans, so on Windows use taskkill /T to terminate the entire process tree.
 */
function handleCancel(res: ServerResponse, id: string) {
  const job = jobs.get(id);
  if (!job) {
    res.statusCode = 404;
    return res.end("Unknown export job");
  }
  if (job.status === "running" && job.child) {
    job.cancelled = true;
    const pid = job.child.pid;
    if (process.platform === "win32" && pid) {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      job.child.kill("SIGTERM");
    }
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}

export function exportPlugin(): Plugin {
  return {
    name: "vite-plugin-export",
    configureServer(server) {
      const root = server.config.root;
      // Startup cleanup: temporary vision tool exports left behind by dead processes
      // `export-vision-<pid>-*` (only this pattern is recognized)
      void sweepExportRoot(outRoot(root), { log: (m: string) => console.log(m) }).catch(() => {});
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        
        // POST /api/export/media/<filename>
        if (req.method === "POST" && req.url.startsWith("/api/export/media/")) {
          return handleMediaUpload(req, res, root);
        }
        
        // POST /api/export
        if (req.method === "POST" && req.url === "/api/export") {
          return handleExportStart(req, res, server, root);
        }
        
        // GET /api/export/<id>/file/<name>: hand deliverables to the browser so it can write them to
        // the location chosen by the user via "Save as" (uses the same File System Access API as saving projects)
        const fileMatch = req.method === "GET" && req.url.match(/^\/api\/export\/([^/]+)\/file\/([^/?]+)$/);
        if (fileMatch) {
          return handleDeliverable(res, fileMatch[1], decodeURIComponent(fileMatch[2]));
        }

        // POST /api/export/audio-mix/<id>: the audio mix page (src/AudioMixView.tsx) returns rendered
        // mix.wav as-is, writes it to export-<id>/audio/mix.wav, and server/bakery uses ffmpeg to
        // composite into preview.mp4.
        // The path has the shape "prefix + id" because api-guard only allows raw bodies by prefix
        // (RAW_BODY_PREFIXES)
        const mixMatch = req.method === "POST" && req.url.match(/^\/api\/export\/audio-mix\/([^/?]+)$/);
        if (mixMatch) {
          const id = sanitizeFilename(mixMatch[1]);
          const dir = path.resolve(outRoot(root), `export-${id}`, "audio");
          try {
            await fs.mkdir(dir, { recursive: true });
            // Write directly to disk without assembling in memory: float32 stereo 48k is 1.4 GB per hour.
            // Cap at 3 GB (about two hours)
            const MAX = 3 * 1024 * 1024 * 1024;
            let bytes = 0;
            let over = false;
            const out = (await import("fs")).createWriteStream(path.resolve(dir, "mix.wav"));
            await new Promise<void>((resolve, reject) => {
              req.on("data", (c: Buffer) => {
                if (over) return;
                bytes += c.length;
                if (bytes > MAX) { over = true; out.destroy(); req.destroy(); return; }
                out.write(c);
              });
              req.on("end", () => out.end(() => resolve()));
              req.on("error", reject);
              out.on("error", reject);
            });
            if (over) {
              res.statusCode = 413;
              return res.end(JSON.stringify({ ok: false, error: trText("Audio mix exceeds 3 GB, not saved") }));
            }
            const buf = { length: bytes };
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify({ ok: true, bytes: buf.length }));
          } catch (e) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
          }
        }

        // POST /api/export/<id>/reveal: open the deliverables directory in the file manager
        const revealMatch = req.method === "POST" && req.url.match(/^\/api\/export\/([^/]+)\/reveal$/);
        if (revealMatch) {
          return handleReveal(res, revealMatch[1]);
        }

        // DELETE /api/export/<id>: cancel
        const cancelMatch = req.method === "DELETE" && req.url.match(/^\/api\/export\/([^/?]+)$/);
        if (cancelMatch) {
          return handleCancel(res, cancelMatch[1]);
        }

        // GET /api/export/<id>
        if (req.method === "GET" && req.url.startsWith("/api/export/")) {
          return handleProgress(req, res);
        }
        
        // GET /@export/<id>/project.json or /@export/project.json
        if (req.method === "GET" && req.url.startsWith("/@export/")) {
          const url = req.url.split("?")[0];
          let match = url.match(/^\/@export\/([^/]+)\/project\.json$/);
          if (match) {
            const id = match[1];
            return serveFile(path.resolve(outRoot(root), `export-${id}`, "project.json"), req, res);
          }
          if (url === "/@export/project.json") {
            if (!lastJobId) return res.end("{}");
            return serveFile(path.resolve(outRoot(root), `export-${lastJobId}`, "project.json"), req, res);
          }
          
          match = url.match(/^\/@export\/([^/]+)\/media\/(.+)$/);
          if (match) {
            const id = match[1];
            const name = sanitizeFilename(decodeURIComponent(match[2]));
            return serveFile(path.resolve(outRoot(root), `export-${id}`, "media", name), req, res);
          }
          // GET /@export/<id>/audio/<file>: the audio mix page reads the trimmed wav and plan.json
          match = url.match(/^\/@export\/([^/]+)\/audio\/([^/]+)$/);
          if (match) {
            const id = sanitizeFilename(match[1]);
            const name = sanitizeFilename(decodeURIComponent(match[2]));
            return serveFile(path.resolve(outRoot(root), `export-${id}`, "audio", name), req, res);
          }
          match = url.match(/^\/@export\/media\/(.+)$/);
          if (match) {
            const name = sanitizeFilename(decodeURIComponent(match[1]));
            if (lastJobId) {
              const checkPath = path.resolve(outRoot(root), `export-${lastJobId}`, "media", name);
              try {
                await fs.access(checkPath);
                return serveFile(checkPath, req, res);
              } catch (e) {
                // fall back to staging
              }
            }
            return serveFile(path.resolve(outRoot(root), ".export-staging", "media", name), req, res);
          }
        }
        
        next();
      });
    }
  };
}
