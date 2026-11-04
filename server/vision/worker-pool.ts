/**
 * Resident render worker pool (each worker guards a Chrome instance behind it). Ported verbatim
 * from server/vite-plugin-vision.ts.
 *
 * **This module state can only be written here**: `renderWorkers` (pool), `renderJobSeq` (request id),
 * `lastRenderOrigin` (callback origin for warm-up, written by ui-renderer via `setLastRenderOrigin`).
 *
 * Dependency direction: worker-pool → render-queue (takes only `cancelError`), unidirectional.
 * The queue manages "whether there is a slot", while this manages "whether the Chrome on that slot
 * is hot": when building the priority channel for Agent-dedicated Chrome in the future, changes
 * will be in `pickWorker` / `spawnWorker`, without touching the queue.
 */
import { fork, spawn } from "node:child_process";
import path from "node:path";
import { cancelError } from "./render-queue";

/** Wall-clock limit for a single render: launch Chrome + warm-up + 1 frame; exceeding means stuck */
export const RENDER_TIMEOUT_MS = 120000;
/**
 * Limit to wait for a worker response after requesting cancellation. It stops between two frames
 * (approx. 20~30 ms per frame) or right after opening a page, normally tens of milliseconds;
 * cold-starting Chrome takes ~6 s at slowest. If exceeded, consider it hung and kill the instance.
 */
export const CANCEL_GRACE_MS = 15000;

/** Everything passed to render process for a prerender pass. Field names match opts in server/bakery */
export interface RenderJobOpts {
  url: string;
  out: string;
  frames: string;
  fps: number;
  /** Capture only these frames (discrete sampling). If omitted, defaults to interval in frames */
  targetFrames?: number[];
}

/**
 * # Resident render worker pool
 *
 * Previously, every render spawned a node process, launched a Chrome instance, and exited the
 * entire process once rendered. **This fixed overhead is an order of magnitude larger than
 * prerendering itself**, measured in testing (1920×1080, only frame 0 requested, with vite and
 * Chrome already warm):
 *
 * ```
 *   162ms  Launching Puppeteer...        ← process startup + import puppeteer takes only 155ms
 *   643ms  Warm-up 3 frames...
 *  1109ms  Export finished in 0.4s.      ← work is done here
 *  4030ms  Process exit                  ← remaining 2.9s is entirely browser.close() waiting for Chrome teardown
 * ```
 *
 * In other words, only one second out of four is spent doing work, and **nearly three seconds are
 * spent waiting for Chrome to shut down**: and these three seconds fall squarely on the user:
 * runExport only resolves on `child.on("close")`.
 *
 * After switching to resident workers, the same job measured **4030ms → 810ms** (first pass
 * 1261ms, including launching Chrome). The savings come neither from starting processes nor
 * loading pages, but precisely from that "startup + shutdown".
 *
 * ## How determinism of reuse is guaranteed
 *
 * It is not guaranteed here; it is guaranteed by `bakery.reset()` in server/bakery/chrome.mjs:
 * each pass opens a **brand new page** (a clean renderer, virtual time never enabled on it,
 * equivalent to launching a brand new browser), and the old page is immediately closed.
 * There are byte-for-byte benchmarked data over there (reused render vs. fresh browser render,
 * four passes pairwise 6/6 all 0 frames). Here we only ensure **a suspicious worker is not kept
 * in service**: timeouts, crashes, or anything that reported errors are killed and restarted
 * (the worker has another layer on its side, see the "three self-preservation rules" in
 * render-worker.mjs).
 *
 * ## Why worker count does not need to be recalculated
 *
 * Concurrency limits are guarded by the `enqueue` pool (see maxConcurrentRenders), and jobs
 * arriving here will not exceed it anyway. So here we just need to "use an idle one if available,
 * launch a new one if not", without calculating again: if the two places compute independently,
 * sooner or later reconciliation mismatches will occur like "pool says 7 can run, but there are
 * only 3 workers". Surplus workers are reaped by their own idle timeouts.
 */
export interface RenderWorker {
  child: import("node:child_process").ChildProcess;
  busy: boolean;
  /** Pending jobs on this worker: request id → result callback; `started` indicates if actually running */
  pending: Map<number, { ok: (result?: any) => void; fail: (e: Error) => void; timer: NodeJS.Timeout | null; started: boolean }>;
  /**
   * Holds a prepared blank page (worker replied with hot): when the next pass arrives, just inject
   * the project and rendering starts in ~3~4 ms. The hot-standby renderer pair in the UI selects
   * "who is hot" based on this (docs/archive/topics/decoupling-plan.md Section 3.2).
   */
  hot: boolean;
  /**
   * Hot received while busy: counted as hot when releasing busy at teardown (hot often arrives
   * with done, see spawnWorker).
   */
  hotPending?: boolean;
  /** How many times hot was received and when latest occurred (hot-standby details, for debugging) */
  hotMsgs?: number;
  lastHotAt?: number;
  /** When last prompted for warm-up by hot-standby inspection (same instance not prompted within 5s) */
  warmingAt?: number;
  /** Callback when turning hot (used by hot-standby scheduler to dispatch pending tasks) */
  onHot?: () => void;
  /** Last few lines of stdout/stderr, used as error messages on failure */
  tail: string[];
  /** Can no longer accept jobs (killed due to timeout / exited on its own) */
  dead: boolean;
  /**
   * Reserved for foreground. **Background jobs must not touch it under any circumstances.**
   *
   * Allocating slots by concurrency limit in the pool already leaves one slot for the foreground,
   * but that only solves "whether there is a slot", not "whether the Chrome on that slot is hot":
   * background prerendering will occupy all existing workers, so when the user releases to request
   * an image, a new one must be spun up on the fly: another startup. Keeping a dedicated, pre-warmed,
   * never-idle-exiting one ensures someone immediately picks up wherever the user scrubs and releases.
   */
  reserved: boolean;
}

export const renderWorkers: RenderWorker[] = [];
let renderJobSeq = 0;
/**
 * Origin URL used in the most recent render. Warm-up requires an openable export page URL, but
 * warm-up happens when "there are no jobs yet" and no opts.url is available: recording one is
 * enough, since the entire development server has only one origin anyway.
 */
let lastRenderOrigin: string | null = null;

/** Remove a worker from the pool and kill it; mark all pending jobs on it as failed */
export function killWorker(w: RenderWorker, why: Error) {
  if (w.dead) return;
  w.dead = true;
  const at = renderWorkers.indexOf(w);
  if (at >= 0) renderWorkers.splice(at, 1);
  for (const p of w.pending.values()) { clearTimeout(p.timer); p.fail(why); }
  w.pending.clear();
  // The render process also spawns a Chrome instance; killing only the process leaves orphans
  if (process.platform === "win32" && w.child.pid) spawn("taskkill", ["/PID", String(w.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else w.child.kill("SIGKILL");
}

export function spawnWorker(root: string, reserved = false): RenderWorker {
  const child = fork(path.resolve(root, "scripts/render-worker.mjs"), [], {
    cwd: root,
    // Keep stdout/stderr as error messages; protocol uses the 4th IPC channel, not mixed with logs
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    // When the parent process has no console (e.g. render host spawned by vite detached from console),
    // omitting this opens a visible console window on Windows
    windowsHide: true,
    // Foreground resident instance must not exit on idle (0 = never), otherwise the user will wait for
    // another launch after tweaking parameters for a while
    env: reserved ? { ...process.env, PROMPTCUT_WORKER_IDLE_MS: "0" } : process.env,
  });
  const w: RenderWorker = { child, busy: false, pending: new Map(), tail: [], dead: false, reserved, hot: false };
  const keep = (chunk: Buffer) => { w.tail.push(chunk.toString()); if (w.tail.length > 20) w.tail.shift(); };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("message", (msg: any) => {
    if (msg?.type === "hot") {
      w.hotMsgs = (w.hotMsgs ?? 0) + 1;
      w.lastHotAt = Date.now();
      /*
       * Workers report hot only when idle with no jobs. But it often arrives immediately following "done":
       * both messages are dispatched in the same tick, when runOnWorker has not had time to release busy
       * yet. Record it while busy, and count as hot when releasing busy during teardown (see runOnWorker):
       * dropping it directly would keep "hot" permanently at 0.
       */
      if (w.busy) {
        w.hotPending = true;
        return;
      }
      w.hot = true;
      w.onHot?.();
      return;
    }
    const p = msg ? w.pending.get(msg.id) : undefined;
    if (!p) return;
    if (msg.type === "started") { p.started = true; return; }
    if (msg.type !== "done" && msg.type !== "error") return;
    w.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    // busy is released by the dispatcher after the entire pass (render + post-processing) ends,
    // see runOnWorker
    if (msg.type === "done") p.ok(msg.result);
    else {
      /*
       * When a worker throws an error, it has already discarded that bakery on its own (see rule 1 of
       * render-worker), and the process itself remains clean, so **do not kill**: on the next pass it
       * will reopen a browser. Cancelled ones did not even discard the bakery, only switching pages.
       */
      p.fail(Object.assign(new Error(String(msg.message || "Render failed")), { cancelled: !!msg.cancelled }));
    }
  });
  const bury = (code: number | null) => {
    if (w.dead) return;
    const msg = w.tail.join("").trim().slice(-600);
    killWorker(w, new Error(code === 3221225794
      ? "Render process failed to start (0xC0000142). Too many browser instances are open at once; wait for the export to finish before viewing frames."
      : `Render process exited abnormally (code ${code})${msg ? `:${msg}` : ""}`));
  };
  child.on("error", (e) => { if (!w.dead) killWorker(w, e instanceof Error ? e : new Error(String(e))); });
  child.on("exit", bury);
  renderWorkers.push(w);
  // Launch Chrome as soon as foreground instance is spawned: waiting until user releases to launch
  // makes them wait ~1.3s longer
  if (reserved && lastRenderOrigin) child.send({ type: "prewarm", url: `${lastRenderOrigin}/?export=1` });
  return w;
}

/**
 * Pick a worker for a job. **Foreground and background take two separate paths.**
 *
 *   Foreground (the image the user released and is waiting to view): uses only the reserved one:
 *     it is hot, dedicated, and never exits on idle, unreachable no matter how busy the background
 *     is. After dispatching, **immediately prepare another hot one** to prevent nobody picking up
 *     if the user scrubs twice in a row.
 *   Background (idle prerendering): uses only non-reserved ones, launching a new one if none are idle.
 *     **Never touch reserved**: a prerender job takes 5~6 seconds; occupying it renders this entire
 *     mechanism useless.
 *
 * The concurrency limit of the pool (see pumpRenderQueue) manages "whether there is a slot", while
 * this manages "whether the Chrome on that slot is hot": two distinct concerns, missing either
 * forces the user to wait for a launch.
 */
function pickWorker(root: string, priority: number): RenderWorker {
  if (priority > 0) {
    const w = renderWorkers.find((x) => x.reserved && !x.busy && !x.dead) ?? spawnWorker(root, true);
    w.busy = true;
    ensureSpareWorker(root);
    return w;
  }
  const w = renderWorkers.find((x) => !x.reserved && !x.busy && !x.dead) ?? spawnWorker(root, false);
  w.busy = true;
  return w;
}

/**
 * Spawn another and warm up when no idle foreground worker is available: landing site for
 * "prepare another immediately after rendering starts".
 */
function ensureSpareWorker(root: string) {
  if (renderWorkers.some((x) => x.reserved && !x.busy && !x.dead)) return;
  spawnWorker(root, true);
}

/**
 * Run a prerender pass. Single frame and batch share the same timeout / error handling.
 *
 * Timeout handling kills processes as before, but kills the entire worker (along with the Chrome
 * it guards): keeping a stuck page is more expensive than reopening one: output rendered on it on
 * the next pass cannot be trusted, and it produces no error.
 */
/** Pixel work before handing off frame, handled by render worker (postFrame in server/png-post.mjs) */
export interface PostItem {
  cards: string;
  layers?: string[];
  out: string;
  bg?: string | null;
  stats?: boolean;
  shrink?: boolean;
}

/**
 * A render pass: renders frames first (opts), then optionally performs post-processing (post is
 * called only after frame rendering finishes, when asset layers are also extracted).
 * post returning null = nothing to do, caller reads frame files directly.
 */
export interface RenderJob2 {
  opts: RenderJobOpts;
  post?: () => Promise<PostItem[] | null>;
}

/** Who runs a job pass: render pool (runExport) or the UI hot-standby renderer pair (uiRenderer.run) */
export type Runner = (job: RenderJob2, signal?: AbortSignal) => Promise<any[] | null>;

/**
 * Send a message to a worker and wait for it to reply. On timeout, kill both the worker and Chrome
 * (keeping a stuck page is costlier than reopening one: anything rendered on it in the next pass
 * is untrusted, and no error is reported).
 *
 * Once `signal` is aborted, stop waiting: for frame rendering, tell the worker to stop in passing
 * (it stops between two frames, only changing pages without replacing the browser), and return
 * "cancelled" immediately here. The error that returns later from the worker finds no waiter and
 * is dropped directly.
 */
function callWorker(
  w: RenderWorker,
  msg: { type: string; id: number; [k: string]: any },
  timeoutMs: number,
  signal?: AbortSignal,
  entry: { ok: (r?: any) => void; fail: (e: Error) => void; timer: NodeJS.Timeout | null; started: boolean } =
    { ok: () => {}, fail: () => {}, timer: null, started: false },
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = msg.id;
    entry.ok = resolve;
    entry.fail = reject;
    entry.timer = setTimeout(() => {
      w.pending.delete(id);
      killWorker(w, new Error(`Render timed out (${timeoutMs / 1000} s).`));
      reject(new Error(`Render timed out (${timeoutMs / 1000} s).`));
    }, timeoutMs);
    w.pending.set(id, entry);
    if (signal?.aborted) {
      // Abandoned before being sent: don't send at all, nor send cancel (worker would record an unused id)
      w.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      return reject(cancelError());
    }
    /*
     * Cancel: tell the worker to stop, but **do not release here**: wait for its reply (it stops
     * between two frames, or finds it was cancelled after opening the page) before this worker is truly
     * freed up. Previously this rejected immediately and busy became false right away: the render
     * pool's running count was undercounted, Chrome was over-dispatched, the next job pass dispatched
     * to the same machine still had to queue behind the old job, and the hot-standby "interrupt" could
     * not free up a truly idle machine. Post-processing (post) is very fast, do not cancel it; let it
     * finish. If the worker delays replying for too long, consider it frozen and kill the entire
     * instance.
     */
    const onAbort = () => {
      if (!w.pending.has(id) || msg.type !== "bake") return;
      w.child.send({ type: "cancel", id }, () => {});
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        if (!w.pending.has(id)) return;
        w.pending.delete(id);
        killWorker(w, new Error(`Worker still had not stopped ${CANCEL_GRACE_MS / 1000} s after cancellation`));
        reject(cancelError());
      }, CANCEL_GRACE_MS);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    w.child.send(msg, (e) => {
      if (!e) return;
      w.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      killWorker(w, e);
      reject(e);
    });
  });
}

/**
 * Run a complete pass on this worker: render frames, then (if needed) post-process. **The same
 * worker does both steps**: frame files are right in the directory it just wrote, and the whole
 * pass counts as one slot, so the scheduler does not need split accounting.
 * Release busy on finish: whether success, failure, or cancellation.
 */
export async function runOnWorker(w: RenderWorker, job: RenderJob2, signal?: AbortSignal): Promise<any[] | null> {
  w.hot = false;
  w.hotPending = false;
  try {
    const entry = { ok: () => {}, fail: () => {}, timer: null, started: false };
    try {
      await callWorker(w, { type: "bake", id: ++renderJobSeq, opts: job.opts }, RENDER_TIMEOUT_MS, signal, entry);
    } catch (e: any) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { notStarted: !entry.started });
    }
    if (!job.post) return null;
    // Only found that caller no longer wants it after rendering frames: skip post-processing
    if (signal?.aborted) throw cancelError();
    const items = await job.post();
    if (!items || !items.length) return null;
    return await callWorker(w, { type: "post", id: ++renderJobSeq, items }, RENDER_TIMEOUT_MS, signal);
  } finally {
    w.busy = false;
    // Worker already reported hot while busy (standby page ready, idle): now released, catch up
    if (w.hotPending && !w.dead) {
      w.hotPending = false;
      w.hot = true;
      w.onHot?.();
    }
  }
}

/**
 * Run a pass in the render pool. Single-frame and batch share the same timeout / error handling.
 */
export async function runExport(root: string, job: RenderJob2, priority = 0, signal?: AbortSignal, retry = true): Promise<any[] | null> {
  try { lastRenderOrigin = new URL(job.opts.url).origin; } catch { /* Do not record if the address is invalid; prewarming is naturally skipped */ }
  const w = pickWorker(root, priority);
  try {
    return await runOnWorker(w, job, signal);
  } catch (e: any) {
    /*
     * **Resend jobs that have not started running.** There is only one cause: at the moment of
     * dispatching the job, this worker happened to time out from being idle and exited on its own
     * (IPC is asynchronous, and no one can prevent this timing). Without retrying, users would
     * randomly hit "Render process exited unexpectedly" once in a while, yet clicking again next time
     * works fine: the hardest kind of intermittent issue to investigate.
     *
     * Jobs that fail after starting are **not** resent: by then half the output may have already been
     * written to disk, and the worker has already discarded the errored bakery, so the next pass is
     * clean by default. Cancelled jobs are naturally not resent either.
     */
    if (retry && e?.notStarted && !e?.cancelled) return await runExport(root, job, priority, signal, false);
    throw e;
  }
}


/**
 * Ultra-thin setter for `lastRenderOrigin`. Originally createUiRenderer assigned directly to this
 * module-level variable; after splitting out, ESM import bindings are read-only: there is still
 * only this single copy of state, but writing to it must go through here.
 */
export function setLastRenderOrigin(origin: string) {
  lastRenderOrigin = origin;
}

/** On card source change, tell all render workers in process to drop standby pages (old modules) */
export function invalidateWorkers() {
  for (const w of renderWorkers) {
    if (w.dead) continue;
    w.hot = false;
    try { w.child.send({ type: "invalidate" }, () => {}); } catch { /* Unreachable workers will restart on the next pass anyway */ }
  }
}
