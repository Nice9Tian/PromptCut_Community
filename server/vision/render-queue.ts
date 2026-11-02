/**
 * Render concurrency queue (priority + slots). Copied verbatim from server/vite-plugin-vision.ts.
 *
 * **This module state can only be written here**: `renderWaiting` (queued jobs) and `renderRunning`
 * (how many are running). Other modules only dispatch jobs via `enqueue` and read `renderRunning` for
 * accounting: duplicating it would mean two separate concurrency limits.
 *
 * It knows nothing about Chrome: it only knows that "a job is a function returning a promise". The
 * worker pool conversely imports `cancelError` from this module; the direction is worker-pool →
 * render-queue, unidirectional and acyclic.
 */
import os from "node:os";
import { exportsRunning, onPoolChange } from "../render-pool-state.mjs";

/**
 * Render pool: **runs a few in parallel, but with an upper limit**, split into two priority tiers.
 *
 * # Why there is an upper limit instead of running unbounded
 *
 * Every render must spawn a Chrome instance. A hard lesson was learned on this machine: when too
 * many concurrent browser instances ran during export, the render process exited directly with
 * **0xC0000142** (STATUS_DLL_INIT_FAILED): it failed to even load DLLs, giving no useful diagnostic
 * information (vite-plugin-export.ts still has a note specifically explaining this error code).
 * So the upper limit here is not conservatism, but a **hard-won lesson**: running unbounded does not
 * bring speed, but rather a batch of renders failing mysteriously.
 *
 * The limit is determined per machine (see maxConcurrentRenders), overridable via
 * `PROMPTCUT_RENDER_CONCURRENCY`.
 *
 * # Why split by priority
 *
 * Originally this was a promise chain, strictly FIFO: back then the queue only contained
 * user-triggered requests, so FIFO was correct. Once idle prerendering was introduced, a pile of
 * jobs with nobody waiting on them sat in the queue long-term; when the user scrubbed the progress
 * bar, the frame they were staring at had to wait behind them: in testing, jumping to a new position
 * took **19.5 seconds** to show an image, whereas a single frame took only 4 seconds.
 *
 * Queue-jumping only applies to jobs **not yet started**: currently running Chrome instances are not
 * interrupted (interrupting wastes seconds burned for nothing). So foreground jobs wait at most for
 * one slot to free up, rather than the entire queue.
 */
interface RenderJob { run: () => Promise<any>; ok: (v: any) => void; fail: (e: any) => void; priority: number; queueTimer?: NodeJS.Timeout }
const renderWaiting: RenderJob[] = [];
export let renderRunning = 0;

/**
 * How many renders can run concurrently.
 *
 * Each render = one node + one Chrome, consuming both CPU cores and memory (measured at ~300-500MB
 * each). So both sides must be bounded: one quota calculated by CPU cores, another by **free
 * memory**, taking the smaller value. The cap of 8 is an artificial ceiling: additional concurrency
 * yields diminishing returns, while the risk of 0xC0000142 rises with instance count.
 */
export function maxConcurrentRenders(): number {
  const override = Number(process.env.PROMPTCUT_RENDER_CONCURRENCY);
  if (Number.isFinite(override) && override >= 1) return Math.min(16, Math.floor(override));
  const byCpu = Math.floor((os.cpus()?.length || 4) / 4);
  // Leaves 700MB margin for each instance, and always reserves 2GB for the system
  const byMem = Math.floor((os.freemem() - 2 * 1024 ** 3) / (700 * 1024 * 1024));
  return Math.max(1, Math.min(8, byCpu, Number.isFinite(byMem) ? byMem : 8));
}

/**
 * **Always reserve one slot for the foreground.**
 *
 * Priority queue-jumping only solves "who queues first", not "is there an available slot": idle
 * prerendering would fill up the pool, so after a user edited a card and was staring at the screen
 * waiting for that frame, they had to wait for some unawaited job to finish before getting a slot.
 * Measured once at 13.6 seconds: queue-jumping worked, but all 7 ahead were already running, and you
 * cannot jump ahead of running jobs.
 *
 * So the background (priority 0) can use at most `max - 1`, leaving that remaining slot specifically
 * empty for the foreground. The cost is 1/7 less throughput, in exchange for **the user never having
 * to wait on a job nobody is waiting for**.
 *
 * Machines with only one slot cannot reserve one (reserving it leaves nobody working), falling back
 * to the original behavior then.
 */
function pumpRenderQueue() {
  const max = maxConcurrentRenders();
  /*
   * Export also occupies slots (it spawns its own Chrome without going through this queue, see
   * render-pool-state.mjs). Per plan section 3.3: during export, **idle prerendering is paused
   * entirely**: prerendering speculatively renders for the 3D view, which the user is unlikely to be
   * watching during export; Agent jobs run as usual and can use all slots outside export (export
   * occupies at most max - 1 slots, auto-sharded by resources by default).
   */
  const exporting = exportsRunning();
  while (renderWaiting.length) {
    // The queue is sorted by priority; the queue head is the next one that should run
    const next = renderWaiting[0];
    if (next.priority <= 0 && exporting > 0) break;
    const limit = next.priority > 0 ? max : Math.max(1, max - 1);
    if (renderRunning + exporting >= limit) break;
    const item = renderWaiting.shift()!;
    // Queue watchdog only covers queuing; once running, it is governed by runExport's RENDER_TIMEOUT_MS
    if (item.queueTimer) clearTimeout(item.queueTimer);
    renderRunning++;
    Promise.resolve()
      .then(item.run)
      .then(item.ok, item.fail)
      .finally(() => { renderRunning--; pumpRenderQueue(); });
  }
}

/**
 * Higher priority runs earlier. Pass 1 for foreground (what user is waiting to see); idle
 * prerendering uses default 0.
 *
 * `queueTimeoutMs`: **Do not wait if queued for too long.**
 *
 * `RENDER_TIMEOUT_MS` in runExport is counted from "the moment the job is dispatched", which does
 * not cover the earlier queuing phase. Thus a job could sit in the queue indefinitely without any
 * armed watchdog: the upper layer (see timeoutMs of see_frames in mcp-tools.mjs) times out and gives
 * up first, replying "did not return within N seconds", which explains nothing: was rendering stuck,
 * or did its turn never even come? The next steps for the two are completely different. Attaching
 * a dedicated watchdog to queuing removes it from the queue on timeout and clarifies that it timed
 * out **in the queue**.
 */
/** Error thrown when caller aborts (disconnected / cancelled). Has cancelled so caller does not treat it as render failure */
export function cancelError(): Error {
  return Object.assign(new Error("The requester no longer wants this image; render cancelled"), { cancelled: true });
}

// As soon as export finishes, paused prerendering resumes dispatching
onPoolChange(() => pumpRenderQueue());

/**
 * `signal`: Triggered when the caller disconnects (or the Agent has given up waiting). Those still
 * queued are directly removed; running ones are stopped by the job inspecting the same signal to
 * halt workers (see runOnWorker). Previously the server never inspected disconnects: when the page
 * cut off requests, jobs remained in the queue and rendered anyway, wasting a Chrome instance.
 */
export function enqueue<T>(job: () => Promise<T>, priority = 0, queueTimeoutMs = 0, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((ok, fail) => {
    if (signal?.aborted) return fail(cancelError());
    const item: RenderJob = { run: job, ok, fail, priority };
    signal?.addEventListener("abort", () => {
      const at = renderWaiting.indexOf(item);
      if (at < 0) return; // Already running; left to the job itself to stop
      renderWaiting.splice(at, 1);
      if (item.queueTimer) clearTimeout(item.queueTimer);
      fail(cancelError());
    }, { once: true });
    if (queueTimeoutMs > 0) {
      item.queueTimer = setTimeout(() => {
        const at = renderWaiting.indexOf(item);
        if (at < 0) return; // Already running; not handled here
        renderWaiting.splice(at, 1);
        fail(new Error(
          `Waited more than ${Math.round(queueTimeoutMs / 1000)} seconds in the render queue without getting a turn (${renderRunning} still rendering ahead).`
          + ` This is not a problem with this card: look again in a while, or wait for the current export / prerender to finish.`,
        ));
      }, queueTimeoutMs);
    }
    // Inserted after all items with priority not lower than its own: equal priority remains FIFO
    const at = renderWaiting.findIndex((w) => w.priority < priority);
    if (at < 0) renderWaiting.push(item); else renderWaiting.splice(at, 0, item);
    pumpRenderQueue();
  });
}
