/**
 * The pair of resident hot-standby renderers (A / B) on the editor side. Ported verbatim from
 * server/vite-plugin-vision.ts.
 *
 * All state resides in the closure of `createUiRenderer` (slots / running / pending), with no
 * module-level mutable state; the only write elsewhere is the worker pool's `lastRenderOrigin`,
 * via `setLastRenderOrigin`.
 * Dependency direction: ui-renderer → worker-pool → render-queue, unidirectional.
 */
import { cancelError } from "./render-queue";
import { runOnWorker, setLastRenderOrigin, spawnWorker } from "./worker-pool";
import type { RenderWorker, RenderJob2, Runner } from "./worker-pool";

/*
 * ===================== Editor side: resident hot-standby renderers (A / B) =====================
 *
 * User foreground rendering (textures at the current moment in the 3D view, the frame needed when
 * scrubbing the playhead) **does not enter the prerender pool**, handled specifically by the two
 * Chrome instances guarded by the editor itself (docs/archive/topics/decoupling-plan.md Section 3.2
 * "Interactive interface"). Original quote:
 * "The interaction side needs to keep two chrome renderers, always keeping one in a hot state...
 * A is rendering, and when a new task arrives at this time, hand it over to hot-state B immediately
 * while clearing A, after which B is rendering and A is on hot standby".
 *
 * Why two instances: after a Chrome instance is interrupted, it must switch to a new page before
 * reuse (approx. 310 ms, cold start 5.6 s, injecting the project into a ready blank page takes only
 * 3~4 ms, see hybrid-sampling-plan.md E0). Alternating between the two instances ensures new
 * requests always land on the hot one, paying the page-switch cost in the background. The two
 * instances are two independent processes: if one crashes, the other continues to hold up.
 *
 * Dispatch rules:
 *   1. If there is a hot (or at least idle) instance, hand off to it;
 *   2. Both instances busy: if the currently rendering one has only run for a short segment
 *      (< UI_INTERRUPT_MS), interrupt it and free it up for the new one; if substantial work was
 *      done, let it finish rendering: the result still enters cache (bakeOne written to disk),
 *      hitting directly when scrubbing back;
 *   3. Neither instance can be freed up: the new request enters "pending", keeping only the latest
 *      one, and earlier ones return directly with "replaced by new request";
 *   4. The threshold in rule 2 is essential: scrubbing the playhead generates dozens of requests
 *      per second; interrupting on every arrival would cause both instances to loop endlessly
 *      between "interrupt → new page", unable to produce a single image.
 * Requester disconnections are also judged by rule 2: stop if just started; finish rendering and
 * enter cache if substantial work was done.
 */

/** Maximum elapsed time of the rendering pass to allow interruption (ms, estimated, tuned by tests) */
const UI_INTERRUPT_MS = 150;

interface UiRequest {
  job: RenderJob2;
  signal?: AbortSignal;
  resolve: (v: any[] | null) => void;
  reject: (e: Error) => void;
  /** Already retried once on another instance (non-cancellation failures retry only once) */
  retried?: boolean;
}

export function createUiRenderer(root: string, originFn: () => string) {
  const slots: RenderWorker[] = [];
  const running = new Map<RenderWorker, { ac: AbortController; startedAt: number }>();
  let pending: UiRequest | null = null;

  const ensure = () => {
    for (let i = slots.length - 1; i >= 0; i--) if (slots[i].dead) slots.splice(i, 1);
    while (slots.length < 2) {
      // Warm-up requires an openable export page URL: simply the editor's own origin
      setLastRenderOrigin(originFn());
      const w = spawnWorker(root, true);
      w.onHot = () => dispatch();
      slots.push(w);
    }
  };

  /*
   * **Inspection: always keep hot** (user's exact words: "always keep one hot to respond at any time").
   *
   * "Hot" is maintained by workers reporting hot, but in several cases they will not report again:
   * after a job fails the worker loses its browser (bakery is empty, will not restart on its own);
   * when cards are modified repeatedly, spare pages are discarded and reopened, failing midway.
   * In testing after a full end-to-end run, both instances stopped at "idle, not hot", with the last
   * hot 45 seconds ago.
   * Check every 2 seconds: send a warm-up to an idle but not hot instance (launches a browser if none
   * exists; if one exists, navigates to a new page, prepares a spare page, and reports hot once ready).
   * The same instance is not prompted again within 5 seconds. Does nothing when hot, incurring zero cost.
   */
  const keepWarm = setInterval(() => {
    const now = Date.now();
    for (const w of slots) {
      if (w.dead || w.busy || w.hot) continue;
      if (w.warmingAt && now - w.warmingAt < 5000) continue;
      w.warmingAt = now;
      try { w.child.send({ type: "prewarm", url: `${originFn()}/?export=1` }, () => {}); } catch { /* Undeliverable ones will be replaced in the next ensure round */ }
    }
  }, 2000);
  keepWarm.unref?.();

  /** Pick one: hot preferred, then idle (page-switch / just spawned is fine; worker waits for spare page) */
  const freeSlot = () => slots.find((w) => !w.dead && !w.busy && w.hot) ?? slots.find((w) => !w.dead && !w.busy);

  const start = (w: RenderWorker, req: UiRequest) => {
    const ac = new AbortController();
    const startedAt = Date.now();
    // Requester disconnected: stop if just started; let it finish rendering if substantial work was done,
    // result enters cache
    const onOuter = () => { if (Date.now() - startedAt < UI_INTERRUPT_MS) ac.abort(); };
    req.signal?.addEventListener("abort", onOuter, { once: true });
    w.busy = true;
    running.set(w, { ac, startedAt });
    runOnWorker(w, req.job, ac.signal)
      .then(req.resolve, (e: any) => {
        /*
         * For failures not cancelled and not abandoned by the requester, retry once on another instance.
         * In testing, consecutive interrupts and page switches occasionally hit "Browser target is not found"
         * (the browser behind this instance was lost; the worker discarded it, and inspection restarts
         * within seconds). The user is looking at this image, so do not let this one-time failure leak into
         * the UI. Retry only once; if it fails a second time, report it faithfully.
         */
        if (!e?.cancelled && !req.retried && !req.signal?.aborted) {
          // Resubmit with retried: if it fails a second time, it takes reject below and will not retry endlessly
          submit({ ...req, retried: true });
          return;
        }
        req.reject(e);
      })
      .finally(() => {
        running.delete(w);
        req.signal?.removeEventListener("abort", onOuter);
        dispatch();
      });
  };

  const dispatch = () => {
    if (!pending) return;
    ensure();
    const w = freeSlot();
    if (!w) return;
    const req = pending;
    pending = null;
    start(w, req);
  };

  /**
   * Submit a request: run if idle, otherwise interrupt or queue into pending per rules 2 / 3.
   * Retries also go through here (with retried).
   */
  const submit = (req: UiRequest) => {
    ensure();
    if (req.signal?.aborted) return req.reject(cancelError());
    const w = freeSlot();
    if (w) return start(w, req);
    // Rule 2: interrupt an instance that just started
    for (const [, r] of running) {
      if (Date.now() - r.startedAt < UI_INTERRUPT_MS) { r.ac.abort(); break; }
    }
    // Rule 3: keep only the latest one
    if (pending) pending.reject(Object.assign(new Error("Replaced by a newer request"), { cancelled: true }));
    pending = req;
    req.signal?.addEventListener("abort", () => {
      if (pending !== req) return;
      pending = null;
      req.reject(cancelError());
    }, { once: true });
  };

  const run: Runner = (job, signal) => new Promise((resolve, reject) => submit({ job, signal, resolve, reject }));

  return {
    run,
    prewarm: ensure,
    /**
     * Stop inspection on shutdown (when vite restarts in the same process, the old instance should not
     * still be sending messages to dead workers).
     */
    stop: () => clearInterval(keepWarm),
    status: () => ({
      workers: slots.filter((w) => !w.dead).length,
      hot: slots.filter((w) => !w.dead && w.hot && !w.busy).length,
      busy: slots.filter((w) => !w.dead && w.busy).length,
      pending: pending ? 1 : 0,
      // Details per instance: check this when troubleshooting why "hot" did not return
      detail: slots.map((w) => ({
        pid: w.child.pid, dead: w.dead, hot: w.hot, busy: w.busy, hotPending: !!w.hotPending,
        hotMsgs: w.hotMsgs ?? 0, lastHotAgoMs: w.lastHotAt ? Date.now() - w.lastHotAt : null,
      })),
    }),
  };
}
