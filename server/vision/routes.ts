/**
 * HTTP routes for vision. Moved verbatim from `configureServer` in server/vite-plugin-vision.ts.
 *
 * Registered separately on both sides: `registerEditorSide` (editor process, using hot-standby
 * renderers + legacy address forwarding) and `registerPrerenderSide` (prerender process: view
 * images / prerender / inventory / cleanup).
 *
 * **Route handler bodies retain their pre-move indentation (6 spaces)**: they were originally
 * embedded in `configureServer`; not re-indenting allows proving "this is just a move, not a
 * single word was changed" through a verbatim diff.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { ViteDevServer } from "vite";
import { isolateClip } from "../vision-project.mjs";
import { overLimit } from "../http-guard.mjs";
import { exportsRunning } from "../render-pool-state.mjs";
import { proxyToPrerender } from "../prerender-client.mjs";
import { assetServiceOrigin } from "../asset-client";
import { ingestFile } from "../media-ingest.mjs";
import { buildAudioPlan, buildFfmpegArgs, playableAudioPlan } from "../bakery/mux-audio.mjs";
import { ffprobeOf } from "../bakery/ffmpeg.mjs";
import { switchCut, normalizeCuts } from "../../src/kernel/cuts.ts";
import { contentEndOf } from "../../src/kernel/duration.ts";
import { activeCutEntry, cutKindOf } from "../../src/kernel/camera.mjs";
import { EXTRACT_TIMEOUT_MS, ffmpegCommand, mediaHashOf, mediaSourceOf } from "./ffmpeg-frames";
import { abortOnClose, originOf, outRoot, resolveMediaUrls, sendJson } from "./http";
import { enqueue, maxConcurrentRenders, renderRunning } from "./render-queue";
import { renderFrames, renderOneFrame } from "./render";
import { bakeClip, bakeOne, bakeTarget } from "./bake";
import { bakedOf, evictBakes, listBakes } from "./bake-cache";
import { renderWorkers } from "./worker-pool";
import { createUiRenderer } from "./ui-renderer";

/**
 * Vision endpoints on the editor side.
 *
 * Render pool, export, and Agent image viewing all live in the prerender process
 * (vite.prerender.config.ts); only these remain here:
 *   - /api/ui-render/bake-batch: user foreground rendering, routed through the pair of hot-standby
 *     renderers above;
 *   - Legacy addresses (/api/vision/*, /api/ai/visual): forwarded as-is to prerender, providing a
 *     fallback for callers that have not yet switched to direct connection.
 */
export function registerEditorSide(server: ViteDevServer, root: string) {
  const ui = createUiRenderer(root, () => originOf(server));
  server.httpServer?.on("close", () => ui.stop());
  server.httpServer?.once("listening", () => {
    // Start both hot-standby instances on startup: waiting until the user scrubs for the first time
    // would make them wait several extra seconds
    setTimeout(() => { try { ui.prewarm(); } catch { /* If they fail to start, wait until first use to start them */ } }, 1000);
  });

  server.middlewares.use("/api/ui-render/status", (_req, res) => sendJson(res, 200, { ok: true, ...ui.status() }));

  server.middlewares.use("/api/ui-render/bake-batch", (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
    let body = "";
    let over = false;
    req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Request body exceeds 64MB"); });
    req.on("end", async () => {
      if (over) return;
      try {
        const { project, clips, size, bg } = JSON.parse(body || "{}");
        if (!project || !Array.isArray(project.tracks)) return sendJson(res, 400, { ok: false, error: "Missing project" });
        if (!Array.isArray(clips) || !clips.length) return sendJson(res, 400, { ok: false, error: "Missing clips" });
        const resolved = resolveMediaUrls(project).project;
        const signal = abortOnClose(res);
        const byClip = new Map<string, number[]>();
        for (const c of clips) {
          if (!c || typeof c.clipId !== "string") continue;
          const arr = byClip.get(c.clipId);
          if (arr) arr.push(Number(c.t)); else byClip.set(c.clipId, [Number(c.t)]);
        }
        const baked: any[] = [];
        const failed: any[] = [];
        /*
         * **Render multiple cards within the same request sequentially**, submitting the next card only
         * after one finishes rendering.
         *
         * The interrupt / preemption rules of the hot-standby renderer are meant for when "the user
         * switches to another point in time": when a new request arrives, the one that just started for
         * the old request is abandoned. If multiple cards from the same batch are submitted together,
         * they will interrupt and preempt each other: actual testing showed that in a batch of N cards,
         * only two or three succeeded, while the rest returned "replaced by new request", and the 3D view
         * would pop up "N cards failed to render". Cards in a single request form a cohesive set and
         * should not compete with each other. Sequential rendering is not slow: hot standby is designed
         * for "someone picking it up immediately", not for parallelism within a batch.
         */
        for (const [clipId, ts] of byClip) {
          if (signal.aborted) {
            failed.push({ clipId, error: "The requester no longer needs it", cancelled: true });
            continue;
          }
          try {
            baked.push(...await bakeClip(root, originOf(server), resolved, clipId, ts, size, bg, "box", 1, { signal, runner: ui.run }));
          } catch (e: any) {
            failed.push({ clipId, error: e?.message || String(e), cancelled: !!e?.cancelled });
          }
        }
        sendJson(res, 200, { ok: true, baked, failed });
      } catch (e: any) {
        sendJson(res, 500, { ok: false, error: e?.message || String(e) });
      }
    });
  });

  // Fallback for legacy addresses: forward as-is to prerender (disconnections are propagated, and
  // prerender drops queued jobs upon disconnection)
  server.middlewares.use("/api/vision", (req, res) => proxyToPrerender(req, res));
  server.middlewares.use("/api/ai/visual", (req, res) => proxyToPrerender(req, res));
}

/**
 * All vision routes on the prerender process side. Originally written directly in `configureServer`
 * of `visionPlugin`, now moved here in its entirety; the plugin shell is only responsible for
 * calling it when `isPrerender` is true.
 */
export function registerPrerenderSide(server: ViteDevServer, root: string) {
      // The editor side relies on this to determine whether prerender is up (readiness check for
      // vite-plugin-prerender)
      server.middlewares.use("/api/prerender/health", (_req, res) => sendJson(res, 200, {
        ok: true, role: "prerender", concurrency: maxConcurrentRenders(), running: renderRunning, exporting: exportsRunning(),
      }));

      /*
       * POST /api/vision/sheet { media, start, end, grid }: shot sheet used by see_frames media mode
       * (source: "media"). One JPEG per shot: extracts grid frames (4 = 2×2, 9 = 3×3) at equal intervals
       * from start to end, 480 wide per cell, completed in one pass with ffmpeg (fps filter for frame
       * extraction + tile for grid assembly), without writing intermediate frames. media is that media
       * record in the project; bytes are fetched only via HTTP from the asset service (mediaSourceOf in
       * ffmpeg-frames.ts); this process does not read the local content store directory
       * (docs/semantics/product/asset-service.md "Responsibilities").
       * Cached under out/sheets by asset content hash, range, and grid count, so paging back does not
       * re-extract: content addressed by hash is immutable; identical hashes mean identical frames.
       * Assets without a hash (stored by filename during transition periods, or absolute paths of legacy
       * .proc) may have changed content at the same address; they are not cached and extracted fresh
       * each time.
       */
      server.middlewares.use("/api/vision/sheet", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 1024 * 1024, "Request body exceeds 1MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { media, start, end, grid } = JSON.parse(body || "{}");
            const file = mediaSourceOf(media);
            if (!file) return sendJson(res, 404, { ok: false, error: "The asset service is unreachable, or this asset record has no address" });
            const s0 = Number(start), s1 = Number(end);
            if (!Number.isFinite(s0) || !Number.isFinite(s1) || s1 <= s0) return sendJson(res, 400, { ok: false, error: "start / end must be numbers of seconds and end > start" });
            const g = grid === 9 ? 9 : 4;
            const cols = g === 9 ? 3 : 2;
            const ffmpeg = ffmpegCommand();
            if (!ffmpeg) return sendJson(res, 500, { ok: false, error: "ffmpeg not found on this machine" });
            const eps = 0.05;
            const dur = Math.max(0.1, s1 - s0 - eps);
            const hash = mediaHashOf(media);
            const dir = path.join(outRoot(root), "sheets");
            await fsp.mkdir(dir, { recursive: true });
            const key = hash
              ? createHash("sha1").update(`media:${hash}|${s0.toFixed(2)}|${s1.toFixed(2)}|${g}`).digest("hex").slice(0, 20)
              : `once-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            const out = path.join(dir, `${key}.jpg`);
            let cached = !!hash && fs.existsSync(out);
            if (!cached) {
              // First check with the asset service whether these bytes exist: if not, return 404 truthfully
              // instead of letting ffmpeg report confusing errors against a 404 URL.
              // Fetch only 1 byte using GET + Range: the legacy route /api/media/file does not respond to HEAD
              const probe = await fetch(file, { headers: { Range: "bytes=0-0" } }).catch(() => null);
              probe?.body?.cancel().catch(() => {});
              if (!probe || !probe.ok) return sendJson(res, 404, { ok: false, error: `Could not fetch this asset from the asset service (${probe ? `HTTP ${probe.status}` : "unreachable"}); re-import it and try again` });
            }
            if (!cached) {
              await new Promise<void>((resolve, reject) => {
                const args = [
                  "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
                  "-ss", (s0 + eps).toFixed(3), "-t", dur.toFixed(3), "-i", file,
                  // fps extracts grid frames, scales to 480 width, and tile arranges them into cols columns; when
                  // there are fewer than grid frames (shot is too short), remaining cells retain background color
                  "-vf", `fps=${(g / dur).toFixed(6)},scale=480:-2:flags=fast_bilinear,tile=${cols}x${cols}:padding=2:margin=2:color=0x111318`,
                  "-frames:v", "1", "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", out,
                ];
                const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
                let err = "";
                child.stderr.on("data", (c) => { err += c; });
                const timer = setTimeout(() => { child.kill(); reject(new Error("ffmpeg contact sheet timed out")); }, EXTRACT_TIMEOUT_MS * 2);
                child.on("error", (e) => { clearTimeout(timer); reject(e); });
                child.on("close", (code) => {
                  clearTimeout(timer);
                  // Do not leave half-written images on failure: the one with a hash would otherwise be treated as a
                  // cache hit next time
                  if (code !== 0 || !fs.existsSync(out)) {
                    fs.rmSync(out, { force: true });
                    return reject(new Error(`ffmpeg exit code ${code}${err ? `:${err.trim().slice(-300)}` : ""}`));
                  }
                  resolve();
                });
              });
            }
            let base64: string;
            try {
              base64 = (await fsp.readFile(out)).toString("base64");
            } finally {
              // The one that is not cached is deleted after use
              if (!hash) await fsp.rm(out, { force: true }).catch(() => {});
            }
            const frames = Array.from({ length: g }, (_, k) => Math.round((s0 + eps + (dur * k) / g) * 100) / 100);
            sendJson(res, 200, { ok: true, grid: g, cols, frames, cached, __image: { mime: "image/jpeg", base64 } });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /*
       * /api/ai/visual: "visible tool results" in the chat panel (execution side see withVisual in
       * src/ai/mcpExecutor.ts).
       *
       *   POST /                    { tool, images?, clipId?, before?, after?, render? } → { visualId, … }
       *   GET  /<visualId>.json     this record
       *   GET  /file/<name>         saved bitmaps (the frames returned by see_frames at that time)
       *   GET  /gif/<key>.gif       8-frame GIF of a card
       *
       * GIFs **are rendered only when the user opens them**: POST only stores "how to render" (what that
       * card looked like at the time, a mini-project after isolateClip); only the first GET renders,
       * encodes, and saves to disk, reading from cache afterwards: Agent tool calls only incur one
       * additional local file write.
       *
       * Who requests it determines which queue to join (`docs/semantics/product/rendering.md` "Action
       * previews in AI panel can jump the queue", `mechanism/rendering.md` "Query rendering and prerender
       * process"):
       *   - User clicks on GET are **user-triggered**: `lane: "preview"`, inserted before all pending
       *     tasks in the normal prerender queue (FramePipeline's `'queue'` lane), without interrupting
       *     the currently running item; **does not occupy the Agent's dedicated instance**, nor does it
       *     go through vision's priority queue (that is a separate queue; queuing ahead of it cannot
       *     jump ahead of prerender pending tasks, and during export, priority 0 is stopped entirely).
       *   - The model's get_gif (`/render`) is requested by the Agent itself: routed to the Agent
       *     dedicated instance as usual (`lane: "agent"`), with vision queue foreground priority (1).
       * When both sides are rendering the same key concurrently, they share that pass (`gifInflight`):
       * the later arrival waits for the pass that started first, without rendering another pass.
       */
      // After moving into server/vision/, this relative path needs to go up one more level (the original
      // file was under server/, written as "./ai-visual.mjs")
      const visualLib = () => import(new URL("../ai-visual.mjs", import.meta.url).href);
      /*
       * Render specs (spec-<key>.json), visualization records (v-*.json), bitmaps, and GIFs all land in
       * this **directory shared across multiple processes** (T1a review #13): `outRoot` =
       * `PROMPTCUT_EXPORT_DIR` (defaults to `<root>/out`); the prerender process spawned by the editor
       * process inherits the same value, and when split (cloud-task.md I4(d)), the `user` / `agent`
       * processes do the same. Therefore, specs written by the model's `get_gif` in the `agent` process
       * can still be read when the user's GET opening the GIF or the model's `/render` request is routed
       * to the `user` process; pixels are rendered only in the `user` process (cloud-task.md resolution
       * 12).
       * Writes always write to a temporary file first before renaming (`atomicWrite` in `ai-visual.mjs`),
       * so other processes never read partial content.
       * `gifInflight` deduplicates only within the current process: if two processes open the same
       * unrendered GIF simultaneously, each renders once with identical results, and the later rename
       * overwrites the earlier one.
       */
      const visualDir = () => path.join(outRoot(root), "ai-visual");
      const gifInflight = new Map<string, Promise<{ gif: string; grid: string; times: number[] }>>();

      async function saveCardSpec(project: any, clipId: string) {
        const visual = await visualLib();
        const iso = isolateClip(resolveMediaUrls(project).project, clipId, { preserveContext: true });
        if (!iso) return null;
        const times = visual.sampleTimes(iso.clip);
        const key = visual.specKey(iso.project, clipId);
        const dir = visualDir();
        await visual.writeJson(dir, visual.gifPaths(dir, key).spec, { project: iso.project, clipId, times });
        return { key, clip: iso.clip, gif: `/api/ai/visual/gif/${key}.gif` };
      }

      function ensureGif(key: string, who: "user" | "model") {
        const running = gifInflight.get(key);
        if (running) return running;
        const job = (async () => {
          const visual = await visualLib();
          const dir = visualDir();
          const p = visual.gifPaths(dir, key);
          const spec = await visual.readJson(dir, p.spec);
          if (!spec) throw Object.assign(new Error("Could not find the render spec for this animated image (out/ai-visual may have been cleaned up)"), { status: 404 });
          if (fs.existsSync(p.gif) && fs.existsSync(p.grid)) return { gif: p.gif, grid: p.grid, times: spec.times };
          const ffmpeg = ffmpegCommand();
          if (!ffmpeg) throw new Error("ffmpeg not found on this machine, cannot make animated images");
          const notes: string[] = [];
          const fps = spec.project.fps || 30;
          const maxFrame = Math.max(0, Math.floor((spec.project.duration || 0) * fps) - 1);
          const frameOf = (t: number) => Math.min(maxFrame, Math.max(0, Math.round(t * fps)));
          const frames = who === "user"
            ? await renderFrames(root, originOf(server), spec.project, spec.times, notes, 0, { lane: "preview" })
            : await enqueue(() => renderFrames(root, originOf(server), spec.project, spec.times, notes, 1, { lane: "agent" }), 1, 25000);
          const bufs = spec.times.map((t: number) => frames.get(frameOf(t))?.buf).filter(Boolean) as Buffer[];
          if (!bufs.length) throw new Error("No frame was rendered");
          // GIFs shown to users are cropped to the region where this card appeared (scaling full screen down
          // to ~100px wide makes text unreadable); sheets delivered to the Agent remain full screen as usual
          const crop = await visual.contentCrop(bufs).catch(() => null);
          await visual.encodeGif({ ffmpeg, frames: bufs, outGif: p.gif, outGrid: p.grid, crop });
          return { gif: p.gif, grid: p.grid, times: spec.times };
        })().finally(() => gifInflight.delete(key));
        gifInflight.set(key, job);
        return job;
      }

      server.middlewares.use("/api/ai/visual", (req, res) => {
        const url = String(req.url || "/").split("?")[0];
        // `code`: passed through as-is when the mode does not accept requests (`NO_AGENT_LANE` /
        // `NO_PRERENDER` in the prerender process, `prerender-mode.mjs`), so callers can distinguish them
        const fail = (e: any) => sendJson(res, e?.status || 500, { ok: false, error: e?.message || String(e), ...(typeof e?.code === "string" ? { code: e.code } : {}) });

        if (req.method === "GET") {
          (async () => {
            const visual = await visualLib();
            const dir = visualDir();
            let m: RegExpExecArray | null;
            if ((m = /^\/(v-[0-9a-z]{6,40})\.json$/.exec(url))) {
              const rec = await visual.readJson(dir, `${m[1]}.json`);
              return rec ? sendJson(res, 200, { ok: true, record: rec }) : sendJson(res, 404, { ok: false, error: "No such visualization record" });
            }
            if ((m = /^\/file\/([^/]+)$/.exec(url))) {
              const name = visual.safeFileName(m[1]);
              const file = name && path.join(dir, name);
              if (!file || !fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: "No such file" });
              const ext = path.extname(file).slice(1);
              res.setHeader("Content-Type", ext === "jpg" ? "image/jpeg" : `image/${ext}`);
              res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
              return fs.createReadStream(file).pipe(res);
            }
            if ((m = /^\/gif\/([0-9a-f]{16})\.gif$/.exec(url))) {
              const g = await ensureGif(m[1], "user");
              res.setHeader("Content-Type", "image/gif");
              res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
              return fs.createReadStream(g.gif).pipe(res);
            }
            sendJson(res, 404, { ok: false, error: "API not available" });
          })().catch(fail);
          return;
        }
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "GET / POST only" });

        /*
         * `POST /api/ai/visual/render { key }`: renders a GIF according to the already written spec,
         * returning the sheet (for the model to view) and the GIF address.
         * **This is one of the only two entry points for GIF pixel rendering (the other being the user GET
         * click above), both belonging to the `user` role** (cloud-task.md resolution 12: Agent process
         * only writes Specs, while rendering is always handled by the `user` process on the user's local
         * machine).
         * The model's `get_gif` takes two steps: first `POST /api/ai/visual` to write only the spec
         * (`'agent'`), then call here to render (`'user'`); after splitting (I4), this route goes to the
         * `user` process, and the Agent process does not perform any GIF rendering.
         */
        if (url === "/render") {
          let raw = "";
          let tooBig = false;
          req.on("data", (c) => { if (tooBig) return; raw += c; tooBig = overLimit(req, res, raw.length, 64 * 1024, "Request body exceeds 64KB"); });
          req.on("end", async () => {
            if (tooBig) return;
            try {
              const { key } = JSON.parse(raw || "{}");
              if (typeof key !== "string" || !/^[0-9a-f]{16}$/.test(key)) return sendJson(res, 400, { ok: false, error: "Missing a valid key" });
              const g = await ensureGif(key, "model");
              const grid = (await fsp.readFile(g.grid)).toString("base64");
              sendJson(res, 200, { ok: true, times: g.times, gifUrl: `/api/ai/visual/gif/${key}.gif`, grid });
            } catch (e: any) {
              fail(e);
            }
          });
          return;
        }

        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Request body exceeds 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const visual = await visualLib();
            const dir = visualDir();
            // This only writes specs and records without rendering GIFs (resolution 12); the `render` field
            // passed by legacy callers no longer triggers rendering, which now goes through `/render`
            const { tool, images, clipId, before, after } = JSON.parse(body || "{}");
            const record: any = { tool: String(tool || ""), createdAt: new Date().toISOString() };
            if (Array.isArray(images) && images.length) {
              record.images = [];
              for (const im of images.slice(0, 16)) {
                if (!im?.base64) continue;
                const saved = await visual.saveImage(dir, { mime: im.mime, base64: im.base64 });
                record.images.push({ url: saved.url, label: String(im.label || "") });
              }
            }
            let afterSpec: any = null;
            if (typeof clipId === "string" && clipId) {
              record.clipId = clipId;
              const beforeSpec = before && Array.isArray(before.tracks) ? await saveCardSpec(before, clipId) : null;
              afterSpec = after && Array.isArray(after.tracks) ? await saveCardSpec(after, clipId) : null;
              if (beforeSpec) record.before = { gif: beforeSpec.gif };
              if (afterSpec) record.after = { gif: afterSpec.gif };
              if (beforeSpec && afterSpec) record.diff = visual.diffClips(beforeSpec.clip, afterSpec.clip);
            }
            const visualId = visual.newVisualId();
            await visual.writeJson(dir, `${visualId}.json`, record);

            // If a spec exists, return the key for `get_gif` to take to `/render`; if not (clip is missing),
            // the caller reports an error truthfully
            sendJson(res, 200, { ok: true, visualId, ...(afterSpec ? { gifKey: afterSpec.key, gifUrl: afterSpec.gif } : {}) });
          } catch (e: any) {
            fail(e);
          }
        });
      });

      server.middlewares.use("/api/vision/snapshot", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Request body exceeds 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { project, t, clipId, times, view } = JSON.parse(body || "{}");
            // If the caller disconnects (the Agent gave up waiting, or the page canceled the request), stop
            // rendering: remove queued items and halt running ones
            const signal = abortOnClose(res);
            if (!project || !Array.isArray(project.tracks)) {
              return sendJson(res, 400, { ok: false, error: "Missing project" });
            }
            if (view !== undefined && view !== "camera" && view !== "space") {
              return sendJson(res, 400, { ok: false, error: `view must be "camera" or "space", got ${JSON.stringify(view)}` });
            }

            const resolved = resolveMediaUrls(project);
            let target = resolved.project;
            let at = Number(t);
            const notes: string[] = [];
            if (resolved.unresolved.length) {
              notes.push(`The server could not fetch files for these assets, so their layer in the frame is empty (not a card problem): ${resolved.unresolved.join(", ")}.`);
            }
            if (clipId) {
              const iso = isolateClip(target, clipId, { preserveContext: true });
              if (!iso) return sendJson(res, 404, { ok: false, error: `No clip with id ${clipId} on the timeline.` });
              target = iso.project;
              // If no time is specified, take the midpoint of this clip: start and end boundaries are often
              // stuck on entrance / exit animations, and using that frame to judge "what this card looks like"
              // will see a semi-transparent intermediate state.
              if (!Number.isFinite(at)) at = (iso.clip.start + iso.clip.end) / 2;
              notes.push(iso.context ? `Rendered clip ${clipId}, keeping the composite background below it that it needs.` : `Showing only clip ${clipId}; other clips are kept only as invisible input dependencies.`);
            } else if (view === "space" || view === "camera") {
              target = { ...target, _renderView: view };
              if (view === "space") {
                notes.push("Rendered in Space overview mode (showing spatial layout and active camera frustum; use view=\"camera\" for the actual output frame).");
              }
            }
            if (!Number.isFinite(at)) at = 0;

            /*
             * Clamp `at` to the project duration first, **then** render with it and use it in the response.
             *
             * `renderOneFrame` clamps internally anyway (frame numbers exceeding duration render to an empty
             * stage), but previously `t` in the response returned the **input parameter**. So when "you
             * requested t=30, but what actually rendered was the final frame at the end of the video", the
             * return value still confidently stated t:30: the model was looking at a frame different from
             * what it requested, yet had no clue that truncation had occurred, assuming "this point in time
             * looks like this". Reporting one thing while rendering another is the hardest kind of bug to
             * track down.
             */
            const fpsOf = target.fps || 30;
            const lastT = Math.max(0, Math.floor((target.duration || 0) * fpsOf) - 1) / fpsOf;
            if (at > lastT) {
              notes.push(`The requested ${at} s is beyond the length of the whole video (${target.duration} s); rendered the last frame at ${lastT.toFixed(2)} s instead.`);
              at = lastT;
            }

            notes.push("The gray checkerboard in the frame is **transparent**, not frame content: nothing is drawn there. The checkerboard is not visible where a card covers it.") ;
            /*
             * times: view multiple points in time at once, **combined into a single render pass** (renderFrames:
             * pushes forward from frame 0, capturing these frames along the way).
             *
             * Previously, the frontend called this endpoint for each point in time individually, restarting
             * from frame 0 for each image: viewing 8 points in time pushed 8 times. Advancing frames is the
             * real bottleneck: one frame takes about 20ms, and the 19th second is 570 frames; whereas
             * preparing a pass (changing pages in a resident worker) takes only about 0.3 seconds. Pushing to
             * the latest point in time in one pass reduces cost from "the sum of frame counts across all times"
             * to "the maximum frame count". Captured images are byte-for-byte identical to rendering frame by
             * frame: single frames via frames `F-F` likewise advance from frame 0 to F.
             */
            const list = Array.isArray(times) ? times.map(Number).filter(Number.isFinite).slice(0, 10) : [];
            if (list.length) {
              const maxFrame = Math.round(lastT * fpsOf);
              const clamped = list.map((x) => Math.min(Math.max(0, x), lastT));
              if (clamped.some((x, i) => x !== list[i])) {
                notes.push(`Some times are beyond the length of the video (${target.duration} s); rendered at the last frame, ${lastT.toFixed(2)} s.`);
              }
              // Image scaling is performed in the render worker (post.shrink); what is received here is already
              // the one shown to the model, needing only base64 encoding
              const shots = await enqueue(
                () => renderFrames(root, originOf(server), target, clamped, notes, 1, { signal, post: { shrink: true } }),
                1, 25000, signal,
              );
              const frames: any[] = [];
              const images: any[] = [];
              clamped.forEach((x, i) => {
                const r = shots.get(Math.min(maxFrame, Math.max(0, Math.round(x * fpsOf))));
                if (!r) return;
                // D3: entity rectangles (stage pixel coordinates); the text portion has already been written into
                // notes by renderFrames
                frames.push({ t: x, clipId: clipId || null, width: r.width, height: r.height, rects: r.rects ?? null });
                images.push({ mime: "image/png", base64: r.buf.toString("base64"), label: `t=${list[i]}s` });
              });
              return sendJson(res, 200, {
                ok: true,
                view: clipId ? "clip" : (view === "space" ? "space" : "camera"),
                frames,
                // The asset layer extracts frames independently per frame; when a file cannot be fetched, every
                // frame logs the exact same message: deduplicate
                note: [`${images.length} frames, in the order of times, each labeled with its time.`, ...new Set(notes)].join(" "),
                __images: images,
              });
            }
            /*
             * **Foreground priority (1), not the default 0.**
             *
             * see_frames is the image that the model is actively blocking and waiting for: the most foreground
             * of all foreground tasks. However, it originally used default priority and therefore fell into the
             * restriction pumpRenderQueue reserves for background work: background work can only use `max - 1`
             * slots, and must queue with idle prerendering on a first-come, first-served basis. In other words,
             * the design of "always reserving one slot for the foreground" happened to block the real foreground
             * out.
             *
             * The queue watchdog gives 25 seconds: plus the 120-second cap for rendering itself, totaling 145
             * seconds, which falls right within the 150-second tool timeout for see_frames: guaranteeing that
             * before timing out, it can provide a message with a **clear explanation of the cause**, rather
             * than having upper layers return a helpless "no response".
             */
            const shot = await enqueue(
              () => renderOneFrame(root, originOf(server), target, at, notes, 1, { signal, post: { shrink: true } }),
              1, 25000, signal,
            );
            const { width, height } = shot;
            const base64 = shot.buf.toString("base64");

            sendJson(res, 200, {
              ok: true,
              t: at,
              clipId: clipId || null,
              view: clipId ? "clip" : (view === "space" ? "space" : "camera"),
              width,
              height,
              // D3: entity rectangles (stage pixel coordinates); the text portion has already been written into
              // notes by renderOneFrame
              rects: shot.rects ?? null,
              note: notes.join(" "),
              // This shape is agreed upon with harness/agent.mjs (and mcp-server.mjs on the CLI path):
              // encountering __image passes it into the context as an image block instead of mixing base64 into
              // the JSON text of tool results: otherwise the model cannot see the image and wastes hundreds of
              // thousands of characters.
              __image: { mime: "image/png", base64 },
            });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /**
       * POST /api/vision/bake { project, clipId, t, size }: prerenders a card into a transparent-background
       * PNG, stored into `px` via the asset service.
       *
       * It shares the same render pipeline with /snapshot (isolateClip + renderOneFrame), with only two
       * differences: no image scaling (textures require original size), and the result is **stored via the
       * asset service** as `/api/asset/px/<content-hash>` rather than stuffed into context for the model
       * to view (`bakeOne` in `bake.ts`, `server/bake-store.mjs`). Returns 500 when the asset service is
       * unreachable, with `error` stating the address and reason.
       *
       * # Why this path will not cause preview and export to diverge
       *
       * Because prerendering is a **one-time step that occurs earlier**: the one rendering this image is
       * the exact renderer that exports the final video (server/bakery/). Afterwards, both preview and
       * export simply load the same file, and neither performs rasterization. The statement "browsers
       * have no DOM → bitmap primitive" is true, but it does not imply "so it cannot be done": as long
       * as rasterization is not required **on the spot**, this server-side pipeline can produce that
       * bitmap all along.
       *
       * # It is a snapshot, not live
       *
       * The card's animation freezes at frame t; when card parameters change, the texture does not update
       * with them and must be re-rendered. This limitation is visible (the visual clearly freezes), so it
       * is acceptable: silent divergence is what cannot be accepted.
       */
      /**
       * POST /api/vision/bake-batch { project, clips: [{clipId, t}], size, bg }: query a batch at once.
       *
       * Used by the 3D view (not an MCP tool; the Agent side only needs the single-card bake_card).
       * Implementation-wise, it simply **renders sequentially**, gaining speed from caching: the cache
       * key computes a hash from "inputs" (card content + t + size + bg), so the same card with the same
       * parameters is only rendered once for real, and however many times the 3D view is opened
       * afterwards, it hits the index and returns directly.
       *
       * We tried spreading N cards into N time slots of a single project and rendering them in one pass;
       * actual testing showed 4 cards took 18.7 seconds, while single cards took 4.7~6.5 seconds: it was
       * not faster at all: the bottleneck is not launching Chrome, but that the path must **walk the
       * entire timeline frame by frame** (4 spread-out cards mean 120 frames), while `--frames` in
       * bakeFrames only accepts contiguous intervals and cannot pick out those 4 frames. So that path was
       * removed; the true way to be fast is cache hits: cards in user hands are mostly prerendered, which
       * is precisely the premise for "generally not using proxies".
       */
      server.middlewares.use("/api/vision/bake-batch", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Request body exceeds 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { project, clips, size, bg, priority } = JSON.parse(body || "{}");
            if (!project || !Array.isArray(project.tracks)) return sendJson(res, 400, { ok: false, error: "Missing project" });
            if (!Array.isArray(clips) || !clips.length) return sendJson(res, 400, { ok: false, error: "Missing clips" });
            const resolved = resolveMediaUrls(project).project;
            const baked: any[] = [];
            const failed: any[] = [];
            const pri = Number(priority) > 0 ? 1 : 0;
            /*
             * Textures for the 3D view are not Agent requests and do not enter the Agent dedicated instance
             * (`mechanism/rendering.md` "Agent priority is only queue jumping"): idle prefetch (priority 0) is
             * normal prerendering, queued at the tail of the normal prerender queue, which the Agent dedicated
             * instance can pick up when idle; what the user is currently waiting to see (priority 1) is inserted
             * ahead of pending normal prerender tasks.
             */
            const lane = pri > 0 ? "preview" : "prerender";
            // When prerender changes plans, in-flight batches are aborted: after disconnection, drop all
            // unstarted renders in this batch so they do not hold up Chrome
            const signal = abortOnClose(res);
            /*
             * **Group by card first.** Multiple points in time for the same card are combined into a single
             * render pass (see bakeClip): the export script pushes forward from frame 0; "rendering frame F"
             * has already pushed 0..F once, so other points in time ≤F for the same card come along for free.
             * Actual testing with 7 points in time for the same card: separate passes took 31.0s → one pass
             * took 2.7s, and byte-for-byte identical.
             *
             * Grouping **does not alter the batch order**: the caller sends them sorted by distance from the
             * playhead, and Map is used here to preserve the order of first appearance, so the closest card is
             * still rendered first: the rule "render near the playhead first" is not sacrificed.
             */
            const byClip = new Map<string, number[]>();
            for (const c of clips) {
              if (!c || typeof c.clipId !== "string") continue;
              const arr = byClip.get(c.clipId);
              if (arr) arr.push(Number(c.t)); else byClip.set(c.clipId, [Number(c.t)]);
            }
            /*
             * **Submit everything at once and let the render pool run in parallel**, rather than awaiting one
             * by one here.
             * A single failure does not bring down the entire batch, so allSettled is used: the 3D view
             * applies textures as soon as it receives them.
             */
            const settled = await Promise.allSettled(
              [...byClip].map(([clipId, ts]) => bakeClip(root, originOf(server), resolved, clipId, ts, size, bg, "box", pri, { signal, lane })
                .then((r) => r, (e) => { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { clipId }); })),
            );
            for (const s of settled) {
              if (s.status === "fulfilled") baked.push(...s.value);
              else failed.push({ clipId: (s.reason as any)?.clipId, error: (s.reason as any)?.message || String(s.reason) });
            }
            sendJson(res, 200, { ok: true, baked, failed });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });
      /**
       * POST /api/vision/bake-status { project, clips: [{clipId, t}], size, bg }: Prerender "inventory".
       *
       * Query only, no rendering: tells the scheduler **which ones are already rendered and their
       * individual sizes**, as well as which old snapshots (orphans) no longer needed by this project
       * are still recorded in the index.
       *
       * Why the server must answer: cache is kept on the server (bytes in asset service, "input hash →
       * content hash" in index), whereas closing the browser page once forgets everything: the frontend
       * recognizes nothing prerendered from the last time the editor was open.
       * "Already rendered" requires that it exists in the index and this chunk is fully collected on
       * the asset service (`bakedOf`, sync status queries only the asset service); returns 500 when the
       * asset service is unreachable.
       *
       * The key algorithm exists in only one place, bakeTarget (shared by prerender, inventory, and
       * cleanup), so issues such as "already prerendered but treated as unrendered" or "deleted a file
       * currently in use" will not fail to reconcile.
       */
      server.middlewares.use("/api/vision/bake-status", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Request body exceeds 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { project, clips, size, bg } = JSON.parse(body || "{}");
            if (!project || !Array.isArray(project.tracks)) return sendJson(res, 400, { ok: false, error: "Missing project" });
            const resolved = resolveMediaUrls(project).project;
            const onDisk = new Map((await listBakes(root)).map((f) => [f.key, f]));
            const items: any[] = [];
            const mine = new Set<string>();
            for (const c of Array.isArray(clips) ? clips : []) {
              if (!c || typeof c.clipId !== "string") continue;
              try {
                const { key, name } = bakeTarget(resolved, c.clipId, Number(c.t), size, bg, "box");
                mine.add(key);
                items.push({ clipId: c.clipId, t: Number(c.t), key, name, url: null, bytes: null });
              } catch (e: any) {
                // Report things that cannot be rendered, like media clips, faithfully to prevent the scheduler
                // from retrying endlessly
                items.push({ clipId: c.clipId, t: Number(c.t), key: null, bytes: null, error: e?.message || String(e) });
              }
            }
            // Which keys requested by this project are rendered: present in index and fully collected on
            // asset service (if gone from asset service, index entry is deleted on the spot)
            const baked = await bakedOf(root, [...mine]);
            for (const it of items) {
              const hit = it.key ? baked.get(it.key) : undefined;
              if (hit) { it.url = hit.url; it.bytes = hit.bytes; }
              else if (it.key) onDisk.delete(it.key);
            }
            /*
             * Snapshots currently unused by this project. The vast majority are **older versions left behind
             * after parameter changes**: the cache key is a hash of card content; changing parameters once adds
             * an entry, and old ones will never be hit again.
             * During editing, this is the main driver of file count growth, far more common than "the video is
             * too long to fit".
             */
            const orphans = [...onDisk.values()].filter((f) => !mine.has(f.key));
            const totalBytes = [...onDisk.values()].reduce((s, f) => s + f.bytes, 0);
            /*
             * concurrency: pool size, prerendering uses it to decide how many frames to dispatch at once to
             * keep it saturated.
             * running: how many renders are actually running right now. Background uses at most concurrency-1
             *   (reserving one for foreground), so these two numbers are the only reliable observation point
             *   for "whether slots were preserved".
             *
             * Do not count directory numbers under out/export-vision-* to gauge concurrency: those directories
             * are deleted fire-and-forget (see finally in renderOneFrame); finished ones not yet deleted will
             * overlap with running ones: in testing, 7 slots measured as 10, which was an incorrect measurement
             * tool, not exceeded concurrency.
             */
            sendJson(res, 200, {
              ok: true, items, orphans, totalBytes, fileCount: onDisk.size,
              concurrency: maxConcurrentRenders(), running: renderRunning,
              // How many resident workers are alive. It is 0 when cold; after rendering it should stabilize at
              // the number used by concurrency; if it stays equal to running while constantly changing, workers
              // are being repeatedly killed and restarted (see killWorker)
              workers: renderWorkers.length,
              // Whether the dedicated hot Chrome for foreground is present. It should stay at 1 long term:
              // dropping to 0 indicates the resident instance was not kept
              reservedWorkers: renderWorkers.filter((w) => w.reserved && !w.dead).length,
            });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /**
       * POST /api/vision/bake-evict { keys: ["a1b2c3d4e5f6", ...] }: Evict these PNG snapshots.
       *
       * Passes keys (12-digit hash), not paths: which entry to delete is compared by the server against
       * its own index, deleting only index entries without touching files outside the index. Bytes
       * remain in the asset service (no deletion API), see evictBakes in bake-cache.ts.
       */
      server.middlewares.use("/api/vision/bake-evict", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 4 * 1024 * 1024, "Request body exceeds 4MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { keys } = JSON.parse(body || "{}");
            const out = await evictBakes(root, keys);
            sendJson(res, 200, { ok: true, ...out });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      server.middlewares.use("/api/vision/bake", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Request body exceeds 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { project, clipId, t, size, bg } = JSON.parse(body || "{}");
            if (!project || !Array.isArray(project.tracks)) return sendJson(res, 400, { ok: false, error: "Missing project" });
            if (!clipId) return sendJson(res, 400, { ok: false, error: "Missing clipId: only one card can be rendered at a time" });
            // Same principle as /snapshot: bake_card is a call the model is blocking on waiting for, queued at
            // the very front of the prerender pool (priority 1), and should not queue behind idle prerendering.
            // fit keeps the default square: textures must be square
            const signal = abortOnClose(res);
            const out = await bakeOne(root, originOf(server), resolveMediaUrls(project).project, clipId, Number(t), size, bg, "square", 1, undefined, { signal });
            sendJson(res, 200, { ok: true, ...out });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /**
       * POST /api/vision/prerender-cut { project, cutId?, name? }:
       * Renders a 3D cut deterministically frame-by-frame into an H.264 `.mp4` video and ingests it into
       * the asset service content store so callers can create a new 2D cut referencing that video while
       * preserving the original 3D cut untouched (Issue #12 Section 6 / Open item 11.e).
       */
      server.middlewares.use("/api/vision/prerender-cut", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "Request body exceeds 64MB"); });
        req.on("end", async () => {
          if (over) return;
          let tmpDir: string | null = null;
          try {
            const { project, cutId, name } = JSON.parse(body || "{}");
            if (!project || !Array.isArray(project.tracks)) {
              return sendJson(res, 400, { ok: false, error: "Missing project" });
            }
            const ffmpeg = ffmpegCommand();
            if (!ffmpeg) {
              return sendJson(res, 500, { ok: false, error: "ffmpeg not found on this machine" });
            }
            const signal = abortOnClose(res);
            const normalized = normalizeCuts(project);
            const targetId = typeof cutId === "string" && cutId ? cutId : normalized.activeCutId!;
            const targetMeta = (normalized.cuts ?? []).find((c) => c.id === targetId);
            if (!targetMeta) {
              return sendJson(res, 404, { ok: false, error: `Cut not found ${targetId}` });
            }
            if (cutKindOf(targetMeta) !== "3d") {
              return sendJson(res, 400, { ok: false, error: `Cut "${targetMeta.name}" is already a 2D cut; only 3D cuts can be pre-rendered to a 2D cut.` });
            }
            const switched = switchCut(normalized, targetId, 0).project;
            const fps = Math.max(1, switched.fps || 30);
            const contentEnd = contentEndOf(switched.tracks);
            const rawDur = contentEnd > 0
              ? Math.min(switched.duration || contentEnd, contentEnd)
              : Math.min(switched.duration || 1, 2);
            const dur = Math.max(1 / fps, rawDur);
            const totalFrames = Math.max(1, Math.round(dur * fps));
            const times = Array.from({ length: totalFrames }, (_, f) => f / fps);
            const resolved = resolveMediaUrls({ ...switched, duration: totalFrames / fps }).project;
            const notes: string[] = [];
            const shots = await enqueue(
              () => renderFrames(root, originOf(server), resolved, times, notes, 1, { signal, lane: "preview" }),
              1,
              60000,
              signal,
            );
            const bufs: Buffer[] = [];
            let lastBuf: Buffer | null = null;
            for (let f = 0; f < totalFrames; f++) {
              const hit = shots.get(f)?.buf ?? lastBuf;
              if (hit) {
                lastBuf = hit;
                bufs.push(hit);
              }
            }
            if (!bufs.length) {
              return sendJson(res, 500, { ok: false, error: "No frames were rendered for the 3D cut" });
            }

            tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pc-prerender-cut-"));
            const videoMp4 = path.join(tmpDir, "video.mp4");
            await new Promise<void>((resolve, reject) => {
              const args = [
                "-y", "-hide_banner", "-loglevel", "error",
                "-f", "image2pipe", "-vcodec", "png", "-framerate", String(fps), "-i", "-",
                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart",
                videoMp4,
              ];
              const proc = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
              let errText = "";
              proc.stderr.on("data", (d) => { errText += d; });
              proc.on("error", reject);
              proc.stdin.on("error", () => { /* handled by close code */ });
              proc.on("close", (code) => {
                if (code === 0 && fs.existsSync(videoMp4)) resolve();
                else reject(new Error(`ffmpeg video encode exited with code ${code}${errText ? `: ${errText.trim().slice(-300)}` : ""}`));
              });
              (async () => {
                for (const buf of bufs) {
                  if (!proc.stdin.write(buf)) {
                    await new Promise<void>((r) => proc.stdin.once("drain", () => r()));
                  }
                }
                proc.stdin.end();
              })().catch((e) => {
                try { proc.kill(); } catch {}
                reject(e);
              });
            });

            let finalMp4 = videoMp4;
            try {
              const rawPlan = buildAudioPlan(resolved, tmpDir, fs.existsSync, (m: any) => mediaSourceOf(m));
              const nonCardPlan = rawPlan.filter((p: any) => !p.cardAudio);
              const audioPlan = nonCardPlan.length ? playableAudioPlan(nonCardPlan, ffprobeOf(ffmpeg)) : [];
              if (audioPlan.length > 0) {
                const muxedMp4 = path.join(tmpDir, "muxed.mp4");
                const muxArgs = buildFfmpegArgs(videoMp4, audioPlan, muxedMp4, totalFrames / fps);
                await new Promise<void>((resolve, reject) => {
                  const proc = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", ...muxArgs], {
                    stdio: ["ignore", "ignore", "pipe"],
                    windowsHide: true,
                  });
                  let errText = "";
                  proc.stderr.on("data", (d) => { errText += d; });
                  proc.on("error", reject);
                  proc.on("close", (code) => {
                    if (code === 0 && fs.existsSync(muxedMp4)) resolve();
                    else reject(new Error(`ffmpeg audio mux exited with code ${code}${errText ? `: ${errText.trim().slice(-300)}` : ""}`));
                  });
                });
                finalMp4 = muxedMp4;
              }
            } catch {
              // Keep silent video if optional audio mux fails
            }

            const baseLabel = String(name || `${targetMeta.name}-2d`).replace(/[^\w\u4e00-\u9fff\u3040-\u30ff.-]+/g, "-").replace(/^-+|-+$/g, "") || "cut-2d";
            const fileName = baseLabel.toLowerCase().endsWith(".mp4") ? baseLabel : `${baseLabel}.mp4`;
            const ingested = await ingestFile({
              file: finalMp4,
              name: fileName,
              origin: assetServiceOrigin,
            });
            sendJson(res, 200, {
              ok: true,
              ...ingested,
              duration: totalFrames / fps,
              width: resolved.width || 1920,
              height: resolved.height || 1080,
            });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          } finally {
            if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          }
        });
      });
}
