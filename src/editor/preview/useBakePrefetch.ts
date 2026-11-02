import { useEffect, useMemo, useRef, useState } from "react";
import { planBakes, defaultBudgetBytes, type BakeMoment, type BakeTier } from "./bakePlan";
import { clipFingerprint, momentId, publishCoverage, type ClipCoverage } from "./bakeCoverage";
import { isScrubbing } from "../timeline/useScrub";
import { prerenderUrl } from "../../render/prerender";
import { tr as trText } from "../../i18n/index.ts";

/**
 * Pre-render textures while idle. See bakePlan.ts for the queueing rules; this file only decides
 * **when to start**.
 *
 * # Three rules that must not be broken
 *
 * 1. **Don't fight the user.** One prerender starts a Chrome and takes four or five seconds, and
 *    the server's render path is **serial** (enqueue). So if the image the user is looking at
 *    queues behind a prerender, it has to wait idly: it was meant to speed things up, but instead
 *    it causes a stall. Hence: send only when the browser is idle, and yield immediately as soon
 *    as the foreground has a render request (see the gate below).
 * 2. **One render at a time.** Sending them concurrently just queues them on the server and
 *    makes "yielding" impossible.
 * 3. **Don't start while dragging.** Dragging the progress bar changes t continuously, and
 *    re-queueing at every step is pointless. Wait until it has stopped for a while (IDLE_MS).
 *
 * # Why the inventory has to ask the server
 *
 * The cache is recorded on the server (the bytes are in the asset service's `px`, and "input
 * hash → content hash" is in a small index on the prerender side, see server/bake-store.mjs),
 * and the browser forgets everything once the page is closed: what the last editor session
 * prerendered is not recognized by the frontend at all. So each round first asks
 * /api/vision/bake-status once: which ones already exist, how large each is, and which old
 * snapshots are unclaimed. Without asking, disk usage can never be computed accurately.
 *
 * It also solves another thing: **the key is only the one the server computes.** Prerender,
 * inventory and cleanup share `bakeTarget`, and the frontend does not compute its own set: if
 * two places each compute their own, sooner or later you get "clearly prerendered but treated as
 * not rendered", with no error.
 *
 * # Which moments to prerender is not decided here
 *
 * A card moves during its few seconds, so what must be rendered is **several moments**; which
 * ones to pick is the job of `bakeTime.ts`, computed by the caller and passed in. This file only
 * decides "when to start" and "in what order, and how many to keep".
 */

/** How long the user must stop before it counts as "idle" */
const IDLE_MS = 600;
/** How long to rest after a round before the next inventory: don't keep waking the server and disk */
const REST_MS = 4000;
/**
 * How long to rest when there is nothing to do.
 *
 * If, after everything is rendered, we still asked every REST_MS, it would be **listing the
 * directory and stat-ing hundreds of files every 4 seconds until the page is closed**.
 * That is what was measured: nothing happens in the UI, while bake-status requests keep coming
 * one after another in the network panel.
 * So with nothing to do we back off by doubling each time, up to once a minute; as soon as the
 * user changes anything, it drops back to REST_MS (see the backoff reset).
 */
const IDLE_MAX_MS = 60000;

/**
 * Yield gate for foreground rendering.
 *
 * When the 3D view sees a missing texture it sends a render request itself (that is the one the
 * user is staring at), and server rendering is serial. Call it once before and once after the
 * foreground starts work, and prerender will stop and wait for it.
 */
let foreground = 0;
export function beginForegroundBake() { foreground++; }
export function endForegroundBake() { foreground = Math.max(0, foreground - 1); }

/** One moment to prerender. Which moments is picked by the caller (see sampleTimesFor in bakeTime.ts) */
export interface WantedMoment {
  clipId: string;
  t: number;
  start: number;
  end: number;
  /** Low frame rate or original frame rate. If not set, low frame rate is assumed */
  tier?: BakeTier;
  /** Whether this moment falls on a cell of the **original frame rate** (a point like 0.5 seconds exists in both tiers, so this is separate from tier) */
  fine?: boolean;
}

export interface PrefetchStatus {
  /**
   * Already rendered: `<clipId>@<t>` → texture URL.
   * The key includes the moment, because the same card is rendered at several moments, and
   * storing by clipId alone would make them overwrite each other.
   */
  ready: Map<string, string>;
  /** Total disk space used by the files already rendered (measured bytes) */
  footprintBytes: number;
  budgetBytes: number;
  fileCount: number;
  /** The one being rendered (shown in the status bar) */
  baking: { clipId: string; phase: string } | null;
  /** How many are still queued */
  queued: number;
  /** How many expired files this round deleted */
  evicted: number;
  error: string | null;
}

const EMPTY: PrefetchStatus = {
  ready: new Map(), footprintBytes: 0, budgetBytes: 0, fileCount: 0,
  baking: null, queued: 0, evicted: 0, error: null,
};

/** Callback when the browser is idle; without requestIdleCallback it degrades to a short timeout */
function onIdle(fn: () => void, timeout = 2000): () => void {
  const ric = (globalThis as any).requestIdleCallback;
  if (typeof ric === "function") {
    const id = ric(fn, { timeout });
    return () => (globalThis as any).cancelIdleCallback?.(id);
  }
  const id = setTimeout(fn, 200);
  return () => clearTimeout(id);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// momentId is defined in bakeCoverage.ts (pure; the coverage table also keeps its books by it); it is re-exported here for Scene3DView to use
export { momentId } from "./bakeCoverage";

// canonFrameT is defined in bakePlan.ts (pure function, unit-testable); re-exported here so
// Scene3DView needs only one import
export { canonFrameT } from "./bakePlan";

export function useBakePrefetch({
  project,
  t,
  moments,
  enabled,
  budgetBytes,
}: {
  project: any;
  t: number;
  /** All moments of the whole video that need prerendering. Computed by the caller and passed in
   * (sampleTimesFor in bakeTime.ts) */
  moments: WantedMoment[];
  enabled: boolean;
  budgetBytes?: number;
}): PrefetchStatus {
  const [status, setStatus] = useState<PrefetchStatus>(EMPTY);
  /*
   * project / t / moments go through refs: they change on every drag tick, and putting them in the
   * effect dependencies would restart the whole scheduling round nonstop, so it would stay stuck at
   * the "inventory" step and never render a single one.
   * The effect only depends on enabled; the loop reads the latest values each time.
   */
  const projRef = useRef(project);
  projRef.current = project;
  const tRef = useRef(t);
  tRef.current = t;
  const momentsRef = useRef(moments);
  momentsRef.current = moments;
  /**
   * Current content fingerprint of each card. It must be included when publishing coverage: the side
   * that draws the bars uses it to decide "does this coverage still count", so a bar turns white on
   * the very frame a card is edited, without waiting for a publish here.
   */
  const fingerprints = useMemo(() => {
    const m = new Map<string, string>();
    for (const tr of project?.tracks ?? []) for (const c of tr.clips ?? []) m.set(c.id, clipFingerprint(c));
    return m;
  }, [project]);
  const fpRef = useRef(fingerprints);
  fpRef.current = fingerprints;
  /** Moment of the last change: used to tell whether the user is still dragging */
  const touchedAt = useRef(Date.now());
  useEffect(() => { touchedAt.current = Date.now(); }, [project, t]);

  const budget = budgetBytes ?? defaultBudgetBytes((navigator as any)?.deviceMemory);

  useEffect(() => {
    if (!enabled) { setStatus(EMPTY); return; }
    let dead = false;
    let cancelIdle: (() => void) | null = null;
    const ready = new Map<string, string>();
    /** The moment currently being rendered (to mark it on the green bar). Reset to null when done */
    let latestBakingAt: number | null = null;

    /** Wait until the browser is idle, the user has stopped, and the foreground is not rendering */
    const waitIdle = () => new Promise<void>((resolve) => {
      const attempt = () => {
        if (dead) return resolve();
        // While a hand is still on the playhead, do nothing: every drag step changes t, and what gets rendered is all fleeting positions
        const quiet = Date.now() - touchedAt.current >= IDLE_MS && !isScrubbing();
        if (quiet && foreground === 0) return resolve();
        cancelIdle = onIdle(attempt);
      };
      cancelIdle = onIdle(attempt);
    });

    /**
     * Send the coverage to the green bar. `bakingAt` is read from `latestBakingAt`: it changes while
     * rendering, and this function is called once after each inventory, so it must not close over the
     * value of that one instant.
     */
    const publishBaked = (all: BakeMoment[], known: Map<string, number>, fpAtRequest: Map<string, string>) => {
      let bytes = 0;
      for (const b of known.values()) bytes += b;
      const isBaked = (m: { key?: string }) => !!m.key && known.has(m.key);

      /*
       * **Publish per card**, each entry carrying that card's content fingerprint at the time.
       *
       * If published as one combined entry, only this loop could update it, and this loop publishes only
       * after the current batch finishes rendering and another inventory is taken, so "after editing a
       * card the bar doesn't budge". With per-card storage, the side that draws the bars compares against
       * the current project's fingerprints and knows which entry is stale, without waiting here.
       */
      const byClip = new Map<string, BakeMoment[]>();
      for (const m of all) {
        const list = byClip.get(m.clipId);
        if (list) list.push(m);
        else byClip.set(m.clipId, [m]);
      }

      const clips: ClipCoverage[] = [];
      const baked = new Set<string>();
      for (const [clipId, ms] of byClip) {
        /*
         * Use the fingerprint from **the moment the request was sent**, not the current one.
         *
         * The inventory is asynchronous: after the request goes out the user may already have edited the
         * card. Stamping a "before the edit" inventory result with the "current fingerprint" puts a valid
         * stamp on stale data. Measured: 29ms after an edit the bar correctly turned white, then the
         * in-flight inventory came back at 591ms and painted it over again, even though the card had not
         * been re-rendered at all. A bar that says it's ready when dragging there takes five seconds is
         * exactly the most unacceptable kind of lie.
         *
         * With the fingerprint from that time attached, such stale results don't match the current project,
         * and the side that draws the bars filters them out automatically.
         */
        const fp = fpAtRequest.get(clipId);
        // If no fingerprint can be found, the card wasn't in the project at that time, so its coverage is meaningless
        if (!fp) continue;
        clips.push({
          clipId,
          fp,
          // Where it sat at the moment of publishing. If the user later moves the card, the bar-drawing side shifts by the difference (see ClipCoverage.start)
          start: ms[0]?.start ?? 0,
          moments: ms.map((m) => ({
            clipId: m.clipId, id: momentId(m.clipId, m.t), key: m.key,
            t: m.t, start: m.start, end: m.end, tier: m.tier, fine: m.fine,
          })),
        });
        // The keys the inventory reports as "on disk" are the moments that have already been rendered
        for (const m of ms) if (isBaked(m)) baked.add(momentId(m.clipId, m.t));
      }
      publishCoverage({ clips, baked, bakingAt: latestBakingAt, bytes });
    };

    const post = async (url: string, payload: unknown, signal?: AbortSignal) => {
      /*
       * Prerendering stays attached for a long time and sends two batches at once, so it goes to the
       * **prerender process's origin** and doesn't take connections from the editor's own origin
       * (the browser allows only about 6 per origin; when they are full, the modules, assets and APIs the
       * editor needs all have to queue, see src/render/prerender.ts).
       */
      const res = await fetch(await prerenderUrl(url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || trText("{0} failed (HTTP {1})", url, res.status));
      return data;
    };

    /** Back off when there is nothing to do; drop back to the shortest when there is work or the user moved */
    let backoff = REST_MS;

    /**
     * Rest, but **wake up immediately when the user moves**.
     *
     * This used to be a single `await sleep(backoff)`, and backoff doubles up to 60 seconds once
     * everything is rendered. Consequence: change a card's parameters, and its cached segments are
     * invalidated on the spot, yet the yellow-green bars on the progress bar are still there and the
     * board still shows the pre-edit image, so **it could take up to a minute** to refresh. What the
     * user sees is "I changed it and nothing happened".
     *
     * So it sleeps in small slices and checks touchedAt between slices (editing the project or
     * dragging the playhead both update it). The cost of checking every 250ms is negligible: it only
     * compares timestamps, with no requests and no disk access.
     */
    const restUntilTouched = async (ms: number) => {
      const since = touchedAt.current;
      const until = Date.now() + ms;
      while (!dead && Date.now() < until) {
        if (touchedAt.current !== since) return;
        await sleep(Math.min(250, ms));
      }
    };

    (async () => {
      while (!dead) {
        let didSomething = false;
        const roundStartedAt = touchedAt.current;
        try {
          await waitIdle();
          if (dead) return;

          const proj = projRef.current;
          const now = tRef.current;
          const wanted = momentsRef.current;
          if (!wanted.length) { await restUntilTouched(backoff); backoff = Math.min(IDLE_MAX_MS, backoff * 2); continue; }

          // Snapshot what every card looks like at **this moment**. The inventory is asynchronous and the project may have changed by the time it returns (see publishBaked)
          const fpAtRequest = fpRef.current;
          /* ① Inventory: which already exist, how big each is, and which are still unclaimed */
          const st = await post("/api/vision/bake-status", {
            project: proj,
            clips: wanted.map((m) => ({ clipId: m.clipId, t: m.t })),
            size: 1024,
          });
          if (dead) return;

          /*
           * Always use the key computed by the server (bakeTarget). The frontend doesn't compute its own
           * set: if both sides compute separately, sooner or later something "was clearly prerendered but
           * is treated as not rendered", with no error, just five seconds of extra waiting for nothing.
           * The inventory comes back matched one-to-one by (clipId, t), so the order is the order of wanted.
           */
          const known = new Map<string, number>();
          const planMoments: BakeMoment[] = [];
          for (const it of st.items ?? []) {
            // For ones that can't be rendered (media clips and the like) the server returns an error; skip them and don't keep retrying
            if (!it.key) continue;
            const w = wanted.find((m) => m.clipId === it.clipId && m.t === it.t);
            if (!w) continue;
            /*
             * **The tier must be passed along.** If it's dropped, every moment falls back to coarse:
             * the UI shows "low frame rate 23/496, original frame rate 0/0", and the queue has no priority
             * order anymore, and there's no error either, the two tiers quietly merge into one.
             */
            planMoments.push({ clipId: w.clipId, t: w.t, start: w.start, end: w.end, key: it.key, tier: w.tier ?? "coarse", fine: !!w.fine });
            if (typeof it.bytes === "number") {
              known.set(it.key, it.bytes);
              if (it.url) ready.set(momentId(w.clipId, w.t), it.url);
            }
          }
          // Old unclaimed files also count toward usage: if they aren't counted, things on disk can never be deleted
          for (const o of st.orphans ?? []) known.set(o.key, o.bytes);

          /*
           * Send "which segments can already show a picture immediately" to the green bar at the top of the timeline.
           *
           * Send it using **the result of this round's inventory**, not the copy the frontend remembers:
           * the inventory is requested from the server, and files prerendered the last time the editor was
           * open count too; if only what was rendered in this session counted, the green bar would grow
           * from zero even though the files have long been on disk.
           */
          publishBaked(planMoments, known, fpAtRequest);

          /* ② Queue: in front of the playhead → both sides → tile from 0; the same list also yields what to delete */
          const plan = planBakes({ moments: planMoments, t: now, budgetBytes: budget, known });

          /* ③ Delete first, then render: the freed space can be used in this very round */
          let evicted = 0;
          if (plan.evict.length) {
            // All keys come from the server, which will compare them against its own index again; only index entries are deleted (the bytes stay in the asset service)
            const gone = await post("/api/vision/bake-evict", { keys: plan.evict });
            evicted = gone.deleted?.length ?? 0;
            for (const k of gone.deleted ?? []) known.delete(k);
            if (evicted) didSomething = true;
          }
          if (dead) return;

          let footprint = plan.footprintBytes;
          setStatus({
            ready: new Map(ready), footprintBytes: footprint, budgetBytes: budget,
            fileCount: st.fileCount ?? 0, baking: null, queued: plan.jobs.length, evicted, error: null,
          });

          /*
           * ④ **Render batch by batch**, each batch filling the server's render pool.
           *
           * It used to send them one at a time, but the server can run several in parallel (7 on a 28-core
           * machine). Sending one at a time leaves 6 slots idle, waiting. The batch size follows the
           * concurrency the server reports; don't guess it in the frontend: that number is computed from the
           * machine's core count and free memory, which only the server knows.
           *
           * Batches shouldn't get bigger: once a batch is sent it can't change its mind midway, and the user
           * may drag away at any time. Exactly filling the pool wastes no slots and doesn't make "go back and
           * re-plan" wait too long.
           */
          const lot = Math.max(1, Math.min(8, Number(st.concurrency) || 1));
          /**
           * How many requests are in flight at the same time.
           *
           * **A batch that exactly fills the pool doesn't mean the pool stays full.** The cards in a batch
           * differ a lot in workload (prerendering a card has to advance from frame 0 to its own frame, so
           * the cost depends on how far back on the timeline it sits, not on how long it is itself). A
           * request returns only after **the slowest card** finishes, so at the tail of every batch the pool
           * collapses: the slots that finished first sit idle, waiting for the last card. The bigger the
           * batch, the longer the tail.
           *
           * So two batches are kept in flight: when A is finishing, B's work is already in the pool and no
           * slot goes empty.
           *
           * Why 2 and not more: the browser gives only about 6 HTTP/1.1 connections per origin, and **the
           * textures themselves also use these connections** to be fetched. Scene3DView stepped on this
           * once: with 4 render requests in flight, even the GET to fetch an already-rendered image couldn't
           * get in line, which showed up as "dragging back to an already prerendered spot doesn't refresh".
           * Two batches (plus one for the foreground card) still leave three connections for images, which
           * is enough.
           */
          const INFLIGHT = 2;
          /**
           * Max number of same-card moments to piggyback on one trip. **The part along the way is almost
           * free**: the server advances from frame 0, and "render frame F" has already advanced through
           * 0..F, so the card's other moments ≤F cost only one more screenshot (about 78ms), whereas a
           * separate trip takes 4400ms. The cap exists because a request that runs too long is a bigger
           * loss when cancelled as the user drags away (though not wasted: the server still writes to disk).
           */
          const RIDE_ALONG = 48;
          const taken = new Set<number>();
          let done = 0;
          /** Batches already sent and not yet returned. `at` is the earliest moment in the batch (the green bar marks it) */
          const flying = new Set<{ at: number; p: Promise<void> }>();
          /** The earliest moment among the in-flight batches: the green bar marks this, not any single batch's own */
          const bakingAtNow = () => (flying.size ? Math.min(...[...flying].map((f) => f.at)) : null);

          /** Send a batch out and register it in flying; on return it removes itself and updates the green bar */
          const launch = (batch: typeof plan.jobs) => {
            const entry = { at: Math.min(...batch.map((j) => j.t)), p: Promise.resolve() };
            // Register first, then start running: the other way around, the delete in finally could run before the add
            flying.add(entry);
            latestBakingAt = bakingAtNow();
            publishBaked(planMoments, known, fpAtRequest);
            setStatus((s) => ({
              ...s, baking: { clipId: batch[0].clipId, phase: batch[0].phase },
              queued: Math.max(0, plan.jobs.length - done),
            }));
            entry.p = (async () => {
              try {
                /*
                 * Cancel this batch as soon as the user moves. Measured: without cancelling, "from editing a card
                 * to the progress bar updating" takes 11.8 seconds, of which 7.8 seconds is just waiting for this
                 * batch to finish rendering, and what it is rendering is the **pre-edit** version, long obsolete.
                 *
                 * Cancelling is not wasteful: the server doesn't stop because of it and the image is still written
                 * to disk (see bakeInFlight in bakeOne), this round just no longer waits for it.
                 */
                const ac = new AbortController();
                const stopWatch = (async () => {
                  while (!ac.signal.aborted && !dead) {
                    if (touchedAt.current !== roundStartedAt) return ac.abort();
                    await sleep(200);
                  }
                })();
                const out = await post("/api/vision/bake-batch", {
                  project: projRef.current,
                  clips: batch.map((j) => ({ clipId: j.clipId, t: j.t })),
                  size: 1024,
                }, ac.signal).finally(() => { ac.abort(); void stopWatch; });
                for (const b of out.baked ?? []) {
                  /*
                   * Store by "card + moment", and use the moment **the server returned**: a batch has several cards,
                   * and identifying by batch[0]'s t would record the whole batch as the same moment (with no error,
                   * just textures that don't match).
                   */
                  ready.set(momentId(b.clipId, b.t), b.url);
                  if (typeof b.bytes === "number") footprint += b.bytes;
                  // This moment can now be viewed; record it in known, and the green bar paints it at the next publish
                  const j = batch.find((x) => x.clipId === b.clipId && x.t === b.t);
                  if (j && typeof b.bytes === "number") known.set(j.key, b.bytes);
                }
              } catch (e: any) {
                // A batch failing to render shouldn't stall the whole round; the next inventory will meet them again.
                // Cancelled ones certainly don't count as errors: the project changed and we gave up on our own
                if (!dead && e?.name !== "AbortError") setStatus((s) => ({ ...s, error: String(e?.message || e) }));
              } finally {
                flying.delete(entry);
                done += batch.length;
                latestBakingAt = bakingAtNow();
                // Update the green bar as each batch returns, not after the whole round finishes: the user wants to watch it grow segment by segment
                publishBaked(planMoments, known, fpAtRequest);
                setStatus((s) => ({
                  ...s,
                  ready: new Map(ready),
                  footprintBytes: footprint,
                  baking: flying.size ? s.baking : null,
                  queued: Math.max(0, plan.jobs.length - done),
                }));
              }
            })();
          };
          for (let i = 0; i < plan.jobs.length; i += 1) {
            if (taken.has(i)) continue;
            /*
             * **The order of batches is unchanged**: still take the next unsent job in plan.jobs order
             * (nearest to the playhead first), filling the server's pool. What changed is only that "each
             * card piggybacks its other moments", and that part comes along the way.
             */
            const batch: typeof plan.jobs = [];
            const clipsIn = new Set<string>();
            for (let k = i; k < plan.jobs.length && clipsIn.size < lot; k++) {
              if (taken.has(k)) continue;
              const j = plan.jobs[k];
              if (!clipsIn.has(j.clipId)) {
                if (clipsIn.size >= lot) break;
                clipsIn.add(j.clipId);
              }
              taken.add(k); batch.push(j);
            }
            // Then piggyback these cards' later moments in the queue, capped per card
            const perClip = new Map<string, number>();
            for (const j of batch) perClip.set(j.clipId, (perClip.get(j.clipId) ?? 0) + 1);
            for (let k = 0; k < plan.jobs.length; k++) {
              if (taken.has(k)) continue;
              const j = plan.jobs[k];
              if (!clipsIn.has(j.clipId)) continue;
              const n = perClip.get(j.clipId) ?? 0;
              if (n >= RIDE_ALONG) continue;
              perClip.set(j.clipId, n + 1);
              taken.add(k); batch.push(j);
            }
            if (dead) return;
            /*
             * Stop when full. **At most it exceeds by the batches still in flight** (a few dozen KB × INFLIGHT):
             * the size isn't known before rendering, and estimating a size for a few dozen KB would build the
             * whole thing on guesses instead.
             */
            if (footprint >= budget) break;
            await waitIdle();
            if (dead) return;
            /*
             * If the user touched anything after this round started → the queue in hand no longer counts; go
             * back and re-plan.
             *
             * This used to be `Date.now() - touchedAt.current < IDLE_MS`, which **never holds**: the
             * `waitIdle()` above is defined as "returns only after being quiet for a full IDLE_MS", so by the
             * time we reach this line the difference is necessarily ≥ IDLE_MS. That means this exit path never
             * took effect.
             *
             * Measured consequence: a round queued over four hundred jobs, 7 per batch at about 5 seconds each,
             * so for a full five minutes **there was not a single re-inventory**. If you edited a card in that
             * time, its yellow-green stripes on the progress bar didn't budge, because republishing coverage
             * only happens after the next inventory. What the user sees is "I changed it for ages and nothing
             * happened".
             *
             * Compare timestamps rather than durations: any difference from the time work started means
             * something changed midway.
             */
            if (touchedAt.current !== roundStartedAt) break;

            didSomething = true;
            /*
             * If there's no room in the pool, wait for one to return. **Wait for just one, not all**: waiting
             * for all falls back to the old "batch by batch, waiting for the slowest" behavior, and the tail
             * still collapses.
             */
            if (flying.size >= INFLIGHT) await Promise.race([...flying].map((f) => f.p));
            if (dead) return;
            if (touchedAt.current !== roundStartedAt) break;
            launch(batch);
          }
          /*
           * All of this round's jobs have been sent; wait for the pending batches to return before the next
           * inventory. Without waiting, the next round would re-plan using an inventory result that is "not
           * yet on disk" and queue the ones currently rendering a second time.
           */
          await Promise.allSettled([...flying].map((f) => f.p));
        } catch (e: any) {
          if (!dead) setStatus((s) => ({ ...s, baking: null, error: String(e?.message || e) }));
        }
        /*
         * This round did work, or the user touched something meanwhile → next round right away;
         * otherwise everything is already rendered, so back off with doubling each time, to avoid
         * spinning and asking the server constantly.
         */
        /*
         * We got back here because **something changed**: re-plan immediately, don't rest. The plan in
         * hand is obsolete, and resting 4 seconds only makes the user stare at a wrong progress bar for 4
         * more seconds. The waitIdle at the start of the next round guarantees "quiet for 600ms", so
         * continuous edits get merged naturally and won't turn into a flood of requests.
         */
        const changed = touchedAt.current !== roundStartedAt;
        backoff = changed ? 0 : didSomething ? REST_MS : Math.min(IDLE_MAX_MS, backoff * 2);
        if (backoff > 0) await restUntilTouched(backoff);
      }
    })();

    return () => { dead = true; cancelIdle?.(); };
  }, [enabled, budget]);

  return status;
}
