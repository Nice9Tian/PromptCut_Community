import { openBakery, bakeFrames } from '../server/bakery/index.mjs';
import { postFrame } from '../server/png-post.mjs';

/**
 * Resident render worker: **one process guards one Chrome instance, taking jobs pass by pass**.
 *
 * # Why it exists
 *
 * Previously, every render spawned a node process, launched a Chrome instance, and navigated to the
 * export page once. This cost was **fixed**:
 * In benchmarks, `--frames 0-0` (spawn process + launch Chrome + load page + advance frame 0 +
 * capture 1 screenshot) took 4211 ms, where advancing the frame and capturing the screenshot
 * together took only ~100 ms. In other words, when the user drags to a new position in the 3D view
 * and the board remains a color block for several seconds, **four seconds are spent waiting for a
 * browser to boot**.
 *
 * Meanwhile, server/bakery had long separated the "prerender room" (openBakery / bakery.reset /
 * bakeFrames), and verified reproducibility across reuses: opening a new page creates a fresh
 * renderer that has never had virtual time enabled, equivalent to launching a brand-new browser -
 * see comments in openBakery and reset. Here we simply put that mechanism into a persistent process.
 *
 * # Why IPC instead of stdin/stdout
 *
 * The prerender process itself writes `PAGE LOG:` and progress to stdout; when errors occur, the
 * parent process needs the last few lines as error info. Staging protocol messages into that same
 * pipe would force both sides to guess "is this line a log or a message?". Using `process.send`
 * provides a separate channel, keeping them isolated.
 *
 * # Messages
 *
 *   prewarm    { url }            Launch Chrome now and stay parked on export page; don't wait for
 *                                 work to arrive before booting
 *   bake       { id, opts }       Render one pass (server/bakery bakeFrames)
 *   post       { id, items }      Pixel work before handing off this frame (composite asset layer,
 *                                 fill background color, scale down), see server/png-post.mjs. Done
 *                                 here to avoid blocking parent process event loop (Vite serving
 *                                 modules to the editor)
 *   cancel     { id }             Discard this pass. **Only replaces page, does not replace
 *                                 browser** (see exception in rule 1 below)
 *   invalidate {}                 Card source code changed: spare page loaded old modules, discard
 *
 * Returned to parent process: ready, started, done, error (cancelled tasks include cancelled:
 * true), hot (no pending job, spare page is ready, next pass only needs to have the project fed into
 * it: the pair of hot standby renderers in the UI uses this to determine "who is hot").
 *
 * # Three self-preservation rules
 *
 * 1. **Always discard a bakery that encountered an error.** When prerendering fails mid-way, the
 *    page may have un-drained tasks lingering: continuing to render on such a page in the next pass
 *    produces untrustworthy results and **raises no errors**. So it is better to pay for a 3-second
 *    reboot.
 *    The exception is **cancellation**: it stops between two frames (bakeFrames inspects signal at
 *    the start of each frame), so the page is not mid-execution, and the next pass was already going
 *    to replace it with a fresh page (resetWith), closing the old page: no need to restart browser.
 * 2. **Proactively restart after rendering MAX_JOBS passes.** Chrome gradually leaks memory over
 *    long runs (each pass creates a new renderer; old ones close, but the browser process's own
 *    heap does not drop back down). Running multiple Chrome instances on this machine has hit
 *    0xC0000142, so it is better to swap in a new one periodically.
 * 3. **Exit automatically after idling for IDLE_EXIT_MS.** A worker takes about 300~500 MB; once
 *    prerendering stops, it simply sits there hogging memory. After exiting, the parent process
 *    spins it back up when work arrives next time: the user waits then, but only once.
 */

/** How many passes to render before replacing with a new browser */
const MAX_JOBS = Number(process.env.PROMPTCUT_WORKER_MAX_JOBS) || 40;
/**
 * How long to idle before exiting automatically (in milliseconds).
 *
 * **Passing 0 = never exit**, reserved for the dedicated foreground resident worker: its entire
 * purpose is "whenever the user releases the mouse, a warm Chrome is ready to pick it up immediately";
 * exiting after 3 minutes of idle would make the user wait for another startup when returning to
 * scrub the timeline after editing parameters.
 */
const rawIdle = process.env.PROMPTCUT_WORKER_IDLE_MS;
const IDLE_EXIT_MS = rawIdle === undefined || rawIdle === "" ? 180000 : Number(rawIdle);

let bakery = null;
/** How many passes this bakery has rendered */
let jobsDone = 0;
let idleTimer = null;
/** The currently running pass: cancel messages locate its AbortController by id */
let current = null;
/** Prerender jobs already received and not yet completed (including those queued on this process chain). Reports hot only when this is 0 */
let jobsInHand = 0;
/** Jobs still queued on this process chain and cancelled before running. Only recorded while jobs are still on hand, and capped so it will not keep growing */
const cancelledEarly = new Set();
const CANCELLED_EARLY_MAX = 200;
/** Last used export page URL: reopen the spare page with it after invalidate */
let lastUrl = null;

function cancelledError() {
  return Object.assign(new Error('Cancelled'), { cancelled: true });
}

function armIdleExit() {
  clearTimeout(idleTimer);
  if (!(IDLE_EXIT_MS > 0)) return; // 0 / invalid = resident, see above
  idleTimer = setTimeout(async () => {
    try { await bakery?.close(); } catch { /* Exit even if it cannot be closed; do not leave the process hanging here */ }
    process.exit(0);
  }, IDLE_EXIT_MS);
  // Timers should not pin the process: we must be able to exit naturally after the parent process disconnects
  idleTimer.unref?.();
}

/** Drop the current bakery (on error or expiration). Failing to close is not a failure: the system will reclaim it when the process exits */
async function dropBakery() {
  const old = bakery;
  bakery = null;
  jobsDone = 0;
  try { await old?.close(); } catch { /* ignore */ }
}

/**
 * Prepare a bakery parked at `url`.
 *
 * Three cases: none → open one (openBakery will goto on its own); exists but parked at another
 * URL → reset to switch to a new page; exists and parked right at this URL → **still must reset**.
 * This last case is easily mistaken for a skippable step, but it cannot be skipped: after the
 * previous render pass, the page has already been pushed to the end, animation anchors are all
 * built, and rendering another pass in place will not produce frame 0.
 */
async function bakeryFor(url) {
  lastUrl = url;
  if (!bakery) {
    bakery = await openBakery({ url });
    return bakery;
  }
  /*
   * If a spare page is available, do not navigate: directly inject this pass's project into a fresh
   * empty page opened in advance (see resetWith in server/bakery/chrome.mjs). If the project cannot
   * be obtained (no timeline in the URL, cannot fetch it back), fall back to the old way: open a new
   * page and navigate there.
   */
  const project = await projectOf(url).catch(() => null);
  if (project) await bakery.resetWith(project, emptyUrlOf(url));
  else await bakery.reset(null, url);
  return bakery;
}

/** Empty project export page on the same origin: the spare page stays parked here, mounting no cards */
function emptyUrlOf(url) {
  const empty = { width: 1920, height: 1080, fps: 30, duration: 1, clips: [] };
  return `${new URL(url).origin}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty)))}`;
}

/** Project JSON pointed to by the timeline parameter in the export page URL (decode directly for data:; fetch from the same origin for relative URLs like /@export/...) */
async function projectOf(url) {
  const u = new URL(url);
  const tl = u.searchParams.get('timeline');
  if (!tl) return null;
  if (tl.startsWith('data:')) {
    const comma = tl.indexOf(',');
    return JSON.parse(decodeURIComponent(tl.slice(comma + 1)));
  }
  const res = await fetch(new URL(tl, u.origin));
  if (!res.ok) throw new Error(`Failed to fetch project, HTTP ${res.status}`);
  return await res.json();
}

/**
 * Open the spare page needed for the next pass while idle. Do not wait for it: resetWith in the
 * next pass will wait on its own.
 * Reply with hot only when the spare page is ready and **no other jobs are on hand**: the pair of
 * hot-standby renderers in the UI relies on it to pick "who is hot"; reporting hot while jobs
 * are still queued on hand causes the parent process to treat a busy machine as hot and dispatch
 * jobs to it.
 */
function preloadNext(url) {
  try {
    const p = bakery?.preload(emptyUrlOf(url));
    // Cannot open the spare page (browser is already gone) and no jobs on hand: drop bakery and reopen one on the next warmup, so it does not stay cold forever
    p?.then((s) => { if (s && jobsInHand === 0) process.send?.({ type: 'hot' }); }, () => { if (jobsInHand === 0) dropBakery(); });
  } catch { /* If the URL is invalid, let it go; take the old path on the next pass */ }
}

async function runJob(opts, signal) {
  if (jobsDone >= MAX_JOBS) await dropBakery();
  try {
    const b = await bakeryFor(opts.url);
    // Opening a page (especially a cold start) ignores signal; check once opened, and if no longer needed, do not push frames
    if (signal.aborted) throw cancelledError();
    const baked = await bakeFrames(b, { ...opts, signal });
    jobsDone++;
    preloadNext(opts.url);
    return baked;
  } catch (e) {
    if (e?.cancelled) {
      // See the exception to rule 1 of "Three self-preservation rules": parked between two frames, only switch pages. Next pass's resetWith will close this old page
      preloadNext(opts.url);
      throw e;
    }
    // See rule 1 of "Three self-preservation rules": this page is no longer trustworthy (spare page closes with the browser)
    await dropBakery();
    throw e;
  }
}

/** Only do one job at a time: concurrency is determined by the pool on the parent process side, one worker, one Chrome, one pass */
let chain = Promise.resolve();

process.on('message', (msg) => {
  if (!msg) return;
  /*
   * **Warmup**: start Chrome and load the export page now; do not wait until the first job arrives to
   * start up.
   *
   * Used for the resident worker in the foreground. Jobs are dispatched only the moment the user
   * releases after scrubbing the timeline; if Chrome is not running yet, they must wait roughly
   * 1.3 seconds longer: and this 1.3 seconds can easily be paid while they are still scrubbing.
   * Any export page URL will do for warmup: when a real job arrives, it will reset to its own
   * project URL.
   */
  if (msg.type === 'prewarm') {
    /*
     * If warmup fails (observed: "Browser target is not found": the browser behind the bakery in hand
     * is already gone), drop the bakery. Previously errors were swallowed here and the bakery was
     * kept, causing every subsequent warmup to fail on the same dead browser and never report hot,
     * while the hot standby side could only watch it stay "idle, not hot" indefinitely; after dropping
     * it, the next warmup (prompted by hot-standby inspection every 5 seconds) will open a new one.
     */
    chain = chain.then(() => bakeryFor(msg.url).then(() => preloadNext(msg.url), () => dropBakery()));
    return;
  }
  /*
   * Cancel. For the pass currently running: flip its signal, and bakeFrames will stop at the start
   * of the next frame; for those still queued on the chain that have not started: record them, and
   * reply directly with cancelled when their turn comes; for those already completed: do nothing.
   * Do not reply with error here: replies are uniformly sent by that pass's own teardown, avoiding
   * replying twice for the same id.
   */
  if (msg.type === 'cancel') {
    if (current && current.id === msg.id) current.ac.abort();
    else if (jobsInHand > 0) {
      if (cancelledEarly.size >= CANCELLED_EARLY_MAX) cancelledEarly.clear();
      cancelledEarly.add(msg.id);
    }
    return;
  }
  /*
   * Card source code changed. The spare page was opened in advance and loaded the module
   * **before modification**: injecting the next project into it renders the old card without
   * throwing errors. Discard it and open a new one on the fly for the next pass (or prepare a new
   * one when idle).
   */
  if (msg.type === 'invalidate') {
    chain = chain.then(() => {
      bakery?.dropSpare?.();
      if (lastUrl) preloadNext(lastUrl);
    });
    return;
  }
  if (msg.type === 'post') {
    chain = chain.then(async () => {
      try {
        const results = [];
        for (const item of msg.items || []) results.push(await postFrame(item));
        process.send?.({ type: 'done', id: msg.id, result: results });
      } catch (e) {
        process.send?.({ type: 'error', id: msg.id, message: e?.message || String(e) });
      }
      /*
       * Report hot again once post-processing is complete. It was reported at the teardown of the
       * frame-rendering pass, but at that point the parent process was still waiting for this
       * post-processing step and this machine was still considered busy, so that report was ignored
       * (the parent process only acknowledges hot when idle); if not supplemented here, "hot" will stay
       * at 0 indefinitely, and hot-standby scheduling falls back to "pick an idle one", where a new job
       * might land on a machine that is still opening its spare page.
       */
      if (jobsInHand === 0 && bakery?.spare) bakery.spare.then((s) => { if (s && jobsInHand === 0) process.send?.({ type: 'hot' }); }, () => {});
    });
    return;
  }
  if (msg.type !== 'bake') return;
  clearTimeout(idleTimer);
  jobsInHand++;
  chain = chain.then(async () => {
    /*
     * Acknowledge with "accepted" first. The parent process relies on it to distinguish between two
     * types of failure: crashing after the job started running (cannot resend, files may have already
     * been written), and **never having started running at all**: the latter has only one cause:
     * at the moment the job was dispatched, this worker happened to hit idle timeout and exited on
     * its own. In that case, the parent process switches to a new worker and retries, and the user
     * sees no anomaly whatsoever (see retries in runExport).
     */
    process.send?.({ type: 'started', id: msg.id });
    try {
      if (cancelledEarly.delete(msg.id)) {
        process.send?.({ type: 'error', id: msg.id, message: 'Cancelled', cancelled: true });
        return;
      }
      const ac = new AbortController();
      current = { id: msg.id, ac };
      try {
        const result = await runJob(msg.opts || {}, ac.signal);
        process.send?.({ type: 'done', id: msg.id, result });
      } catch (e) {
        process.send?.({ type: 'error', id: msg.id, message: e?.message || String(e), cancelled: !!e?.cancelled });
      } finally {
        current = null;
      }
    } finally {
      jobsInHand--;
      armIdleExit();
      // All jobs on hand are cleared, and the spare page is present: tell the parent process that this machine is hot again (if there is no spare page, preloadNext will report once it is opened)
      if (jobsInHand === 0 && bakery?.spare) bakery.spare.then((s) => { if (s && jobsInHand === 0) process.send?.({ type: 'hot' }); }, () => {});
    }
  });
});

// If the parent process is gone, do not leave a Chrome instance burning memory in the background
process.on('disconnect', async () => {
  try { await bakery?.close(); } catch { /* ignore */ }
  process.exit(0);
});

armIdleExit();
process.send?.({ type: 'ready' });
