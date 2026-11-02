/**
 * **Arrangement** for stream generation on this page (task brief `docs/plan/render-refactor-task.md`
 * "Jia-2"; for implementation and [ruling], see `docs/plan/browser-stream-task.md` "Generate streams
 * on this page").
 *
 * When there are no nodes capable of splitting online, an online page with desktop identity
 * generates single-card track streams itself during idle time on the background stage, pushes them
 * to the asset service, and plays them itself; output is the same as produced via the queue (keys,
 * manifest, and that row in the layer table are identical; planned in `pageStreamPlan.ts`, verified
 * against the server), directly usable by other members' pages, desktop apps coming online later,
 * and render hosts.
 *
 * This module contains only criteria and ordering, without touching stage, network, or storage:
 * they are injected by the host (`src/editor/browserNodeHost.ts`) via `deps`. The host calls `tick()`
 * once per tick.
 *
 * # When it is this page's turn to produce [ruling]
 *
 *   1. This page is a browser node (all conditions for being a node are met, fingerprint obtained,
 *      encoder probed), or a page that produces sparse versions only for this page (identity is
 *      mobile, only one stage; (user decision, 2026-10-14) "mobile and tablet also produce sparse
 *      versions for this page"): lowest tier does not produce;
 *   2. This page's version of manifest plan has been published (manifest = clips classified as
 *      heavy by this page itself: only for projects it opened itself and cards it needs to play),
 *      in which single-card streams that this page can produce do not yet have outputs;
 *   3. **No splitting nodes online took on this plan**: `PAGE_STREAM_WAIT_MS` has elapsed since the
 *      plan was published and it remains unclaimed (still `open` in the queue). How to detect:
 *      publish the same plan task again (the queue only merges for the same result key without
 *      spawning a new task), and the response includes its current status; query once every
 *      `PAGE_STREAM_POLL_MS` while there is work to do. Status `claimed` / `done` means a node
 *      took on the work: do not produce; if currently producing, stop after finishing the current
 *      frame (segments already pushed are retained by task id, and when a splitter sends the same
 *      task to the queue, this page's node claims it and backfills only missing ones). `failed`
 *      (splitter tried and could not complete) is treated the same as `open`;
 *   4. Idle (`deps.isIdle()`: host's idle criteria, plus this page's node holds no claims).
 *
 * # Check first, produce only if missing
 *
 * Before starting each segment task, check two places: whether this page's own key has a manifest in
 * the content store covering this segment and chunks are all on the asset service (produced by
 * another page with the same fingerprint or on the previous open); whether the layer table has
 * another **playable** single-card stream for this card (produced by desktop apps, render hosts, or
 * pages with different fingerprints; playable criteria match the playback side: same content key,
 * or unexpired input signature), whose manifest covers this segment and chunks are all present. If
 * found, use directly without producing. During production, recheck once every
 * `PAGE_STREAM_RECHECK_MS`; if produced elsewhere, finish the current frame, stop, and switch to the
 * existing one.
 *
 * # Layer table
 *
 * When there is no splitter, no one writes the layer table: before starting work, this page merges
 * its row into the layer table in the content store (`mergeLayerStreams`, modifying only its own
 * rows in `streams`), and verifies whether it is still present every `PAGE_STREAM_ROWS_MS` thereafter
 * (if two pages write concurrently, the later write overwrites the earlier one). If this page's row
 * is gone and the table already has a complete stream produced by someone else for this card, do not
 * write back (avoids overwriting back and forth with another layer-table writer). Once a splitter
 * takes on the work, stop writing (the layer table belongs to it).
 *
 * # Yield
 *
 * Rules match browser nodes claiming tasks (D8 of `browserNode.ts`): playback, scrubbing, or more
 * urgent work arriving on the background stage: stop after the current frame finishes, or abort if
 * not finished within `YIELD_FRAME_MAX_MS`; when the page is hidden, abort immediately without
 * waiting for the current frame. Already-pushed segments are kept, and missing ones are backfilled
 * when idle.
 *
 * # Two passes: sparse first, then full density (`docs/semantics/mechanism/rendering.md` "Heavy pipeline: prerender")
 *
 * Each stream is produced in two passes (`passes`, default `[sparse, full density]`): the sparse pass
 * captures only the first frame of each segment (task is `pageStreamTasks(…, { density: 'sparse' })`,
 * identical field-by-field to sparse stream tasks emitted by the splitter), while the full density
 * pass captures every frame; both passes share the same result key and manifest key, with manifests
 * merged by the host. **The full density pass starts only after sparse passes for all streams have
 * settled (produced, found existing, or dropped in this version)**: if a sparse segment is backing
 * off, full density also waits. "Check first" recognizes according to the density of this pass: for
 * the sparse pass, having one version (sparse or full density) for each segment in the manifest
 * counts as present; for the full density pass, every segment must be full density.
 *
 * # Produce sparse versions during measurement (`measure()`; semantics same as "Measurement" above)
 *
 * When opening a project and measuring card by card under the loading overlay, after finishing the
 * first pass (timing) for a card and classifying as heavy, the measurer (`src/editor/probeRunner.ts`)
 * immediately calls `measure()`: to produce the sparse pass of this card's single-card stream: check
 * first (use directly if already on the asset service), merge this page's row into the layer table,
 * produce, write the manifest, and ask the host to acknowledge it. This path does not wait for the
 * manifest plan, does not ask if there is a splitter, and does not check whether idle (user cannot
 * act under the overlay; page hiding still aborts). It only runs the sparse pass, leaving full
 * density for idle time.
 *
 * Overlay waiting for sparse versions has a wall-clock cap of `MEASURE_SPARSE_MAX_MS` (50 seconds):
 * counted from the first call to `measure()` under this round of overlay; when reached, whatever is
 * currently producing stops after the current frame (pushed segments are retained by task id),
 * `measure()` returns immediately, and subsequent calls in this round return immediately; unfinished
 * items are deferred to the idle path (continued in the order above after the manifest plan is
 * published, with matching task ids, backfilling only missing segments). The cap only governs
 * producing sparse versions under the overlay without cutting off measurement itself ("too slow" is
 * judged per frame). Clocks and waiting for this page to become a node (obtaining fingerprint,
 * probing encoder, at most `MEASURE_READY_WAIT_MS`) are driven by `tick()`, so the host must call
 * `tick()` as usual before `measure()` returns.
 *
 * The accounting state used for measurement (`measure`'s ctx) is kept until the manifest plan is
 * published (this page's rows in the layer table are verified as usual); once the plan is published
 * (published at a time no earlier than it), it switches to the plan's copy, and sparse tasks run
 * "check first" once more, finding what was produced during measurement.
 *
 * This module belongs to the render layer (`src/online/`): does not import editor.
 */
import type { NodeTask } from "./browserNode.ts";
import { STREAM_SEGMENT_FRAMES, YIELD_FRAME_MAX_MS, type YieldCause } from "./browserNode.ts";
import { candidateSpans, layerStreamCandidates, mergeLayerStreams, pageStreamRow, pageStreamTasks, type PageStreamRow, type PageStreamSpec } from "./pageStreamPlan.ts";
import { packedSize, avcCodecFor } from "../render/streamEncode.ts";

/**
 * After the manifest plan is published and no one claims it, wait this long before this page
 * produces it itself (tier 3 number; idle splitters claim plans within one second, leaving margin
 * while busy with other work)
 */
export const PAGE_STREAM_WAIT_MS = 5000;
/** How often to poll plan status while there is work to do */
export const PAGE_STREAM_POLL_MS = 2000;
/** During production, how often to check "whether produced elsewhere" */
export const PAGE_STREAM_RECHECK_MS = 5000;
/** How often to verify whether this page's rows are still in the layer table */
export const PAGE_STREAM_ROWS_MS = 20_000;
/** Stop retrying a segment task after this many consecutive failures (in this version) */
export const PAGE_STREAM_ATTEMPTS = 3;
/**
 * Maximum time the loading overlay waits for sparse versions when opening a project (wall clock;
 * `docs/semantics/mechanism/rendering.md` "Measurement": wait up to 50s for sparse versions under
 * overlay, then enter editing, producing the rest at idle time). Counted from the first wait for
 * sparse versions under this round of overlay. This number is written only in this place.
 */
export const MEASURE_SPARSE_MAX_MS = 50_000;
/**
 * Maximum wait time during measurement for this page to become a node (obtain fingerprint, probe
 * encoder); counted within the 50s above. If timed out, this card is deferred to idle time
 */
export const MEASURE_READY_WAIT_MS = 3000;

/** Status of this version of manifest plan in the queue; `none` = unreachable (not published, disconnected) */
export type PlanState = "none" | "open" | "claimed" | "done" | "failed";

/** Latest successfully published manifest plan from this page (`current()` in `planPublisher.ts`) */
export interface PublishedPlan {
  /** Plan task id (`plan:<project>@<version>#clips:<signature>`) */
  id: string;
  projectId: string;
  projectRev: number;
  /** Manifest: clips classified as heavy by the page itself */
  clips: readonly string[];
  /** Time of successful publish */
  at: number;
}

/**
 * A stream production pass: `stride` takes one frame every few frames (1 = take every frame, full
 * density; greater than 1 is a sparse pass with sparse stream tasks)
 */
export interface PageStreamPass { name: string; stride: number }
/** Default two passes: sparse first (capturing only the first frame of each segment), then full density */
export const PAGE_STREAM_PASSES: readonly PageStreamPass[] = [{ name: "sparse", stride: STREAM_SEGMENT_FRAMES }, { name: "dense", stride: 1 }];

/** A card to produce sparse version for during measurement (input parameter of `measure()`) */
export interface MeasureRequest {
  /** Sequence number of this overlay round (changes each time overlay appears): 50s clock is computed by it */
  round: number | string;
  projectId: string;
  /** Which version of confirmed project to compute streams with (host retains this version) */
  projectRev: number;
  /** Clips of this card just measured (clips of the same card share the same identity, given together) */
  clips: readonly string[];
  /**
   * All clips currently classified as heavy by this page (criteria for merging into group streams
   * inspect all; produces only those in `clips`)
   */
  heavy: readonly string[];
  /** This round of measurement is invalidated (project changed): stop */
  stale?: () => boolean;
}
/** Result of `measure()`: `ok` sparse versions for this card have all settled; others are reasons for incomplete */
export interface MeasureOutcome {
  result: "ok" | "none" | "deadline" | "incapable" | "busy" | "stale" | "stopped" | "interrupted" | "failed";
  /**
   * Number of tasks settled this time: produced by this page, found existing under own key, found
   * existing under another candidate; `left` incomplete tasks (deferred to idle time)
   */
  produced: number; have: number; elsewhere: number; left: number;
}

export interface PageStreamsDeps {
  now: () => number;
  /**
   * Whether this page can currently produce streams: is a browser node, obtained fingerprint, probed
   * encoder, has code fingerprint
   */
  capable: () => boolean;
  /** Whether idle (host's idle criteria, plus this page's node holds no claims) */
  isIdle: () => boolean;
  /** Latest successfully published manifest plan from this page; returns null if none */
  plan: () => PublishedPlan | null;
  /** Query the queue for this version of manifest plan's status; returns `none` if unreachable */
  planState: () => Promise<PlanState>;
  /**
   * Single-card streams this page can produce in this version (`planPageStreams` in
   * `pageStreamPlan.ts`, host computes from confirmed project of that version); returns null if
   * computation fails (retry later)
   */
  specs: (plan: PublishedPlan) => Promise<{ specs: PageStreamSpec[]; skipped: Record<string, string>; project: unknown } | null>;
  /**
   * Code version embedded in the page (written into task's `requires.codeVersion`, same shape as
   * tasks emitted by splitter)
   */
  codeVersion?: string | null;
  /**
   * One of the "check first" queries: this page's own key, this segment's manifest is in the content
   * store, and chunks are all on the asset service
   */
  lookupOwn: (task: NodeTask, need: { dense: boolean }) => Promise<boolean>;
  /**
   * Pre-check 2: result key of another candidate; the manifest for this segment is in the content
   * store and all chunks are on the asset service. `need.dense`: requires every segment to be full
   * density (not required for a sparse pass).
   */
  lookupOther: (resultKey: string, range: { from: number; to: number }, need: { dense: boolean }) => Promise<boolean>;
  /** Existing layer table in the content store (returns null if none); throws on read failure. */
  readLayerMap: (project: unknown) => Promise<unknown | null>;
  /** Writes the entire layer table back to the content store. */
  writeLayerMap: (project: unknown, body: Record<string, unknown>) => Promise<void>;
  /**
   * Produce a segment: request pixels frame by frame from the background stage, feed to encoder,
   * and push segments; write the manifest once all segments are complete. Before each frame, check
   * `yielding()`; if true, stop after completing the current frame and return `yielded`; stop as
   * early as possible (throws) when `signal` aborts. `stride` is how many frames per sample in this
   * pass.
   */
  produce: (job: { task: NodeTask; project: unknown; stride: number; signal: AbortSignal; yielding: () => boolean }) => Promise<"done" | "yielded">;
  /**
   * An available stream exists for this result key (produced by this page or found via pre-check):
   * the host tells the online source to recognize it and immediately refetches the layer table.
   */
  onAlive?: (resultKey: string) => void;
  /**
   * How many passes to produce and how dense each pass is; defaults to sparse first then full
   * density (`PAGE_STREAM_PASSES`).
   */
  passes?: readonly PageStreamPass[];
  /** Upper limit for overlay waiting on the sparse version; defaults to `MEASURE_SPARSE_MAX_MS`. */
  measureMaxMs?: number;
  measureReadyMs?: number;
  waitMs?: number;
  pollMs?: number;
  recheckMs?: number;
  rowsMs?: number;
  /**
   * Only produce sparse versions for this page (mobile identity, only one stage): only produces
   * sparse versions; calls VideoEncoder.isConfigSupported to check config before producing streams.
   * Defaults to false.
   */
  sparseOnly?: boolean | (() => boolean);
  /**
   * Checks whether encoder config is supported (unit test stub injection, defaults to checking
   * globalThis.VideoEncoder.isConfigSupported).
   */
  isConfigSupported?: (config: Record<string, unknown>) => Promise<{ supported?: boolean } | boolean>;
}

type TaskState = "todo" | "produced" | "have" | "elsewhere" | "failed";
interface Job { task: NodeTask; spec: PageStreamSpec; pass: PageStreamPass; passIndex: number; state: TaskState; fails: number; retryAt: number; via: string | null }
interface Ctx {
  /**
   * Accounting record during measurement (no manifest plan; `plan` is a stand-in composed from
   * project and version).
   */
  measure: boolean;
  plan: PublishedPlan;
  specs: PageStreamSpec[] | null;
  /**
   * The row in the layer table for each stream (result key → row; both pre-check and writing layer
   * table use its input signature).
   */
  rows: Map<string, PageStreamRow>;
  skipped: Record<string, string>;
  project: unknown;
  jobs: Job[];
  /**
   * Streams belonging to this page (produced, in production, or found its own key already exists):
   * the layer table must have this page's row.
   */
  mine: Set<string>;
  rowsAt: number;
  specsAt: number;
  probe: { state: PlanState; at: number; flying: boolean };
}
interface Run {
  job: Job;
  controller: AbortController;
  yieldCause: YieldCause | null;
  yieldAt: number | null;
  /**
   * Non-yielding stop reasons: `splitter` (a splitter claimed the work), `elsewhere` (produced
   * elsewhere), `plan-changed`, `stopped`, `deadline` (overlay timed out waiting for sparse version),
   * `stale`.
   */
  stop: string | null;
  recheckAt: number;
  rechecking: boolean;
}

export interface PageStreamsDebug {
  /** `off` not producing (not a node, no plan), `planning` computing streams for this revision,
   *  `none` this revision has nothing this page can produce, `waiting` waiting for a splitter,
   *  `taken` a splitter claimed the work, `checking` pre-checking, `producing` producing,
   *  `idle-wait` waiting idle, `done` all available, `measuring` accounting record during measurement
   *  (manifest plan not yet published) */
  state: "off" | "planning" | "none" | "waiting" | "taken" | "checking" | "producing" | "idle-wait" | "done" | "measuring";
  planId: string | null;
  planState: PlanState;
  /** How long since the plan was published. */
  waitedMs: number | null;
  streams: { clipId: string; contentKey: string; streamKey: string; firstSegment: number; lastSegment: number; mine: boolean }[];
  jobs: { id: string; clipId: string; pass: string; state: TaskState; via: string | null; fails: number }[];
  skipped: Record<string, string>;
  running: { id: string; yield: string | null; stop: string | null } | null;
  counters: {
    /**
     * Number of tasks completed by this page, found its own key existing via pre-check, and found
     * another candidate existing.
     */
    produced: number; have: number; elsewhere: number; failed: number;
    /** Start count (recorded once each time entering `produce`, and again upon returning after yielding). */
    starts: number;
    yields: Record<string, number>;
    stops: Record<string, number>;
    aborts: number;
    probes: number; rowsWritten: number; rowsFailed: number;
    /**
     * Count of times not written back when this page's row is no longer in the layer table and someone
     * else's fully produced stream is present.
     */
    rowsYielded: number;
  };
  /**
   * Producing sparse version during measurement: overlay ID for this round, clock start and end
   * timestamps, call count, counts of each outcome, settled task counts for each, and whether
   * currently waiting.
   */
  measure: {
    round: number | string | null; startedAt: number | null; deadlineAt: number | null; calls: number; active: boolean;
    results: Record<string, number>; produced: number; have: number; elsewhere: number; left: number;
    log: { at: number; clips: string[]; result: string; ms: number; produced: number; have: number; elsewhere: number; left: number }[];
  };
  lastError: string | null;
}

export interface PageStreams {
  tick(): void;
  /**
   * Yielding (same rules as browser nodes): abort immediately on `hidden`; otherwise stop after
   * completing the current frame.
   */
  yieldFor(cause: YieldCause): void;
  /**
   * Whether currently producing or waiting for a sparse version during measurement (used by host to
   * prevent nodes from claiming concurrently: both paths share the same background stage workload).
   */
  running(): boolean;
  /**
   * Produce sparse version during measurement: called after measuring the first pass of a card and
   * classifying as heavy. Pre-checks, producing only if absent; overlay waits for it, at most until
   * 50 seconds for this round expires (returns immediately on timeout). Does not throw. Before
   * returning, host must call `tick()` as usual (drives the clock).
   */
  measure(req: MeasureRequest): Promise<MeasureOutcome>;
  /** Going offline or switching projects: stop and clear accounting for this revision. */
  stop(reason?: string): void;
  debug(): PageStreamsDebug;
}

export function createPageStreams(deps: PageStreamsDeps): PageStreams {
  const passes: readonly PageStreamPass[] = deps.passes?.length ? deps.passes : PAGE_STREAM_PASSES;
  const isLow = () => typeof deps.sparseOnly === "function" ? deps.sparseOnly() : !!deps.sparseOnly;
  /** Whether this pass is sparse (task is a sparse stream task, pre-check does not require full density). */
  const sparse = (pass: PageStreamPass) => pass.stride > 1;
  const effectivePasses = (): readonly PageStreamPass[] => {
    if (isLow()) {
      const sp = passes.filter(sparse);
      return sp.length ? sp : [{ name: "sparse", stride: STREAM_SEGMENT_FRAMES }];
    }
    return passes;
  };
  let consecutiveErrors = 0;
  const checkEncoderSupported = async (spec: PageStreamSpec): Promise<boolean> => {
    const w = spec.bound?.w || 640;
    const h = spec.bound?.h || 360;
    const fps = spec.fps || 30;
    const size = packedSize(w, h);
    const config = {
      codec: avcCodecFor(size.width, size.height),
      width: size.width,
      height: size.height,
      framerate: fps,
      avc: { format: "avc" },
      latencyMode: "quality",
    };
    if (typeof deps.isConfigSupported === "function") {
      try {
        const r = await deps.isConfigSupported(config);
        return typeof r === "boolean" ? r : r?.supported === true;
      } catch {
        return false;
      }
    }
    const ve = (globalThis as any).VideoEncoder;
    if (typeof ve?.isConfigSupported === "function") {
      try {
        const r = await ve.isConfigSupported(config);
        return typeof r === "boolean" ? r : r?.supported === true;
      } catch {
        return false;
      }
    }
    return false;
  };
  const measureMaxMs = deps.measureMaxMs ?? MEASURE_SPARSE_MAX_MS, measureReadyMs = deps.measureReadyMs ?? MEASURE_READY_WAIT_MS;
  const waitMs = deps.waitMs ?? PAGE_STREAM_WAIT_MS, pollMs = deps.pollMs ?? PAGE_STREAM_POLL_MS;
  const recheckMs = deps.recheckMs ?? PAGE_STREAM_RECHECK_MS, rowsMs = deps.rowsMs ?? PAGE_STREAM_ROWS_MS;
  let ctx: Ctx | null = null;
  let run: Run | null = null;
  /** Computing streams, pre-checking, or writing the layer table: only do one at a time. */
  let working = false;
  let phase: "planning" | "checking" | null = null;
  let lastError: string | null = null;
  const counters: PageStreamsDebug["counters"] = { produced: 0, have: 0, elsewhere: 0, failed: 0, starts: 0, yields: {}, stops: {}, aborts: 0, probes: 0, rowsWritten: 0, rowsFailed: 0, rowsYielded: 0 };
  const bump = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1; };
  const fail = (e: unknown) => { lastError = String((e as Error)?.message ?? e).slice(0, 200); };
  const alive = (key: string) => { try { deps.onAlive?.(key); } catch { /* The host is broken */ } };

  const stopRun = (reason: string, abort = false) => {
    const r = run;
    if (!r) return;
    if (!r.stop) r.stop = reason;
    if (abort) r.controller.abort();
  };

  /* --- Producing sparse version during measurement: clock for this round of overlay, waiting invocation --- */
  let clock: { round: number | string; startedAt: number } | null = null;
  interface Measuring { req: MeasureRequest; at: number; done: boolean; resolve: (out: MeasureOutcome) => void; out: MeasureOutcome }
  let measuring: Measuring | null = null;
  /** Wait for the next tick (woken up in `tick()`). */
  let tickWaiters: (() => void)[] = [];
  const nextTick = () => new Promise<void>((resolve) => { tickWaiters.push(resolve); });
  const mstats: PageStreamsDebug["measure"] = { round: null, startedAt: null, deadlineAt: null, calls: 0, active: false, results: {}, produced: 0, have: 0, elsewhere: 0, left: 0, log: [] };
  const endMeasure = (m: Measuring, result: MeasureOutcome["result"]) => {
    if (m.done) return;
    m.done = true;
    if (measuring === m) measuring = null;
    m.out.result = result;
    bump(mstats.results, result);
    mstats.produced += m.out.produced; mstats.have += m.out.have; mstats.elsewhere += m.out.elsewhere; mstats.left += m.out.left;
    mstats.log.push({ at: m.at, clips: [...m.req.clips], result, ms: deps.now() - m.at, produced: m.out.produced, have: m.out.have, elsewhere: m.out.elsewhere, left: m.out.left });
    if (mstats.log.length > 40) mstats.log.splice(0, mstats.log.length - 40);
    m.resolve({ ...m.out });
  };

  /**
   * Whether any other candidate for this stream in layer table `map` has a manifest covering segment
   * `[from, to]` entirely and all chunks present. Returns that candidate's result key.
   */
  const coveredBy = async (c: Ctx, spec: PageStreamSpec, map: unknown, from: number, to: number, dense = true): Promise<string | null> => {
    const row = c.rows.get(spec.streamKey) ?? pageStreamRow(c.project, spec);
    for (const cand of layerStreamCandidates(map, row)) {
      if (cand.resultKey === spec.streamKey) continue;
      const spans = candidateSpans(cand, from, to);
      if (!spans?.length) continue;
      let all = true;
      for (const [a, b] of spans) if (!(await deps.lookupOther(cand.resultKey, { from: a, to: b }, { dense }).catch(() => false))) { all = false; break; }
      if (all) return cand.resultKey;
    }
    return null;
  };

  /** Merge rows belonging to this page into the layer table; does not write if there are no changes. */
  const syncRows = async (c: Ctx): Promise<void> => {
    c.rowsAt = deps.now();
    if (!c.mine.size) return;
    try {
      const existing = await deps.readLayerMap(c.project);
      if (ctx !== c) return;
      const listed = (key: string, row: PageStreamRow) => layerStreamCandidates(existing, row).some((x) => x.resultKey === key);
      const rows: PageStreamRow[] = [];
      for (const spec of c.specs ?? []) {
        if (!c.mine.has(spec.streamKey)) continue;
        const row = c.rows.get(spec.streamKey) ?? pageStreamRow(c.project, spec);
        // This page's row is not in the table (not written yet, or overwritten by another party writing the
        // layer table), and this card in the table already has someone else's fully produced stream: do not
        // write back.
        if (!listed(spec.streamKey, row) && await coveredBy(c, spec, existing, spec.firstSegment, spec.lastSegment)) {
          if (ctx !== c) return;
          c.mine.delete(spec.streamKey);
          counters.rowsYielded++;
          continue;
        }
        rows.push(row);
      }
      if (ctx !== c || !rows.length) return;
      const body = mergeLayerStreams(existing, { project: c.project as Record<string, any>, rows, now: deps.now() });
      if (!body) return;
      await deps.writeLayerMap(c.project, body);
      counters.rowsWritten++;
    } catch (e) {
      counters.rowsFailed++;
      fail(e);
      // Write failed: verify again on the next tick.
      c.rowsAt = -Infinity;
    }
  };

  /**
   * Pre-check: whether results for this segment exist. Returns the found result key (its own or
   * another candidate's), or null if none.
   */
  const check = async (c: Ctx, job: Job): Promise<{ resultKey: string; own: boolean } | null> => {
    const range = { from: job.task.range!.from, to: job.task.range!.to };
    // Sparse pass: counted as present if each segment has any revision; full density pass requires
    // every segment to be full density.
    const dense = !sparse(job.pass);
    if (await deps.lookupOwn(job.task, { dense }).catch(() => false)) return { resultKey: job.task.resultKey, own: true };
    let map: unknown = null;
    try { map = await deps.readLayerMap(c.project); } catch { return null; }
    const other = await coveredBy(c, job.spec, map, range.from, range.to, dense);
    return other ? { resultKey: other, own: false } : null;
  };

  const settle = (c: Ctx, job: Job, found: { resultKey: string; own: boolean }) => {
    job.state = found.own ? "have" : "elsewhere";
    job.via = found.resultKey;
    if (found.own) { counters.have++; c.mine.add(job.spec.streamKey); } else counters.elsewhere++;
    alive(found.resultKey);
  };

  /**
   * Tasks for these streams in this pass (sparse pass produces sparse stream tasks with `:sparse`
   * appended to id; field-by-field identical to those from splitters).
   */
  const jobsOf = (c: Ctx, specs: readonly PageStreamSpec[], pass: PageStreamPass, passIndex: number): Job[] =>
    specs.flatMap((spec) => pageStreamTasks(spec, { projectId: c.plan.projectId, projectRev: c.plan.projectRev, codeVersion: deps.codeVersion ?? null,
      derivedFrom: c.measure ? null : c.plan.id, density: sparse(pass) ? "sparse" : null })
      .map((task): Job => ({ task, spec, pass, passIndex, state: "todo", fails: 0, retryAt: -Infinity, via: null })));

  const loadSpecs = async (c: Ctx) => {
    working = true;
    phase = "planning";
    c.specsAt = deps.now();
    try {
      const got = await deps.specs(c.plan);
      if (ctx !== c || !got) return;
      c.specs = got.specs;
      c.skipped = got.skipped;
      c.project = got.project;
      c.rows = new Map(got.specs.map((spec) => [spec.streamKey, pageStreamRow(got.project, spec)]));
      c.jobs = effectivePasses().flatMap((pass, passIndex) => jobsOf(c, got.specs, pass, passIndex));
    } catch (e) {
      fail(e);
    } finally {
      working = false;
      phase = null;
    }
  };

  const taken = (c: Ctx) => c.probe.state === "claimed" || c.probe.state === "done";

  const pollPlan = (c: Ctx) => {
    const now = deps.now();
    // `done` is terminal: a splitter claimed this revision, no need to ask again (republishing a task
    // past retention will recreate it).
    if (c.probe.flying || c.probe.state === "done" || now - c.probe.at < pollMs) return;
    c.probe.flying = true;
    c.probe.at = now;
    counters.probes++;
    void deps.planState().then((s) => { if (ctx === c) c.probe.state = s; }, () => { if (ctx === c) c.probe.state = "none"; }).finally(() => { c.probe.flying = false; });
  };

  const start = (c: Ctx, job: Job): Promise<void> => {
    const r: Run = { job, controller: new AbortController(), yieldCause: null, yieldAt: null, stop: null, recheckAt: deps.now() + recheckMs, rechecking: false };
    run = r;
    counters.starts++;
    let work: Promise<"done" | "yielded">;
    try {
      work = deps.produce({ task: job.task, project: c.project, stride: job.pass.stride, signal: r.controller.signal, yielding: () => r.yieldCause !== null || r.stop !== null });
    } catch (e) { work = Promise.reject(e); }
    return work.then((out) => {
      if (out === "done") {
        job.state = "produced";
        job.via = job.task.resultKey;
        counters.produced++;
        consecutiveErrors = 0;
        alive(job.task.resultKey);
        // Manifest for this segment entered the content store: immediately verify this page's row in the
        // layer table once.
        if (ctx === c) c.rowsAt = -Infinity;
      } else if (r.stop) bump(counters.stops, r.stop);
      else bump(counters.yields, r.yieldCause ?? "urgent");
    }, (e) => {
      if (r.controller.signal.aborted) {
        counters.aborts++;
        if (r.stop) bump(counters.stops, r.stop); else bump(counters.yields, r.yieldCause ?? "hidden");
        return;
      }
      fail(e);
      job.fails++;
      consecutiveErrors++;
      // Failed: retry after backoff; drop this segment (in this revision) if failing consecutively.
      if (job.fails >= PAGE_STREAM_ATTEMPTS || (e as { retryable?: boolean })?.retryable === false || (isLow() && consecutiveErrors >= 3)) {
        job.state = "failed";
        counters.failed++;
      } else {
        job.retryAt = deps.now() + 2000 * job.fails;
      }
    }).finally(() => { if (run === r) run = null; });
  };

  /**
   * Pick next segment: pre-check; start work only if not found, still idle, and no one has claimed
   * the work.
   */
  const step = async (c: Ctx) => {
    working = true;
    phase = "checking";
    try {
      const now = deps.now();
      // One pass at a time: do not start later passes (full density) while earlier passes (sparse) still
      // have unsettled tasks: those in backoff also count as unsettled, wait for them.
      const todo = c.jobs.filter((j) => j.state === "todo");
      const pass = todo.reduce((min, j) => Math.min(min, j.passIndex), Infinity);
      const job = todo.find((j) => j.passIndex === pass && now >= j.retryAt);
      if (!job) return;
      const found = await check(c, job);
      if (ctx !== c) return;
      if (found) { settle(c, job, found); if (found.own) await syncRows(c); return; }
      if (taken(c) || !deps.isIdle() || !deps.capable()) return;
      if (isLow()) {
        if (consecutiveErrors >= 3) {
          job.state = "failed";
          counters.failed++;
          return;
        }
        const supported = await checkEncoderSupported(job.spec);
        if (!supported) {
          job.state = "failed";
          counters.failed++;
          return;
        }
      }
      // Write this row into the layer table before starting work: other pages (and this page's online
      // source) locate this stream's manifest from it.
      if (!c.mine.has(job.spec.streamKey)) { c.mine.add(job.spec.streamKey); await syncRows(c); }
      // Found someone else fully produced it while writing (`syncRows` removed this stream from this
      // page's ownership): do not start work, pre-check on the next tick will recognize it.
      if (ctx !== c || run || taken(c) || !deps.isIdle() || !c.mine.has(job.spec.streamKey)) return;
      void start(c, job);
    } catch (e) {
      fail(e);
    } finally {
      working = false;
      phase = null;
    }
  };

  /**
   * Check again mid-production: if already available elsewhere, stop after completing current frame
   * and switch to existing one.
   */
  const recheck = (c: Ctx, r: Run) => {
    const now = deps.now();
    if (r.rechecking || r.stop || now < r.recheckAt) return;
    r.rechecking = true;
    r.recheckAt = now + recheckMs;
    void check(c, r.job).then((found) => {
      if (!found || run !== r || ctx !== c || r.job.state !== "todo") return;
      stopRun("elsewhere");
      settle(c, r.job, found);
    }, () => {}).finally(() => { r.rechecking = false; });
  };

  const drop = (reason: string) => {
    stopRun(reason, true);
    ctx = null;
  };

  const newCtx = (plan: PublishedPlan, measure: boolean): Ctx =>
    ({ measure, plan, specs: null, rows: new Map(), skipped: {}, project: null, jobs: [], mine: new Set(), rowsAt: -Infinity, specsAt: -Infinity, probe: { state: "none", at: -Infinity, flying: false } });

  /**
   * Overlay timed out waiting for sparse version, or this measurement round was invalidated:
   * producing stops after completing the current frame (aborts per yield timeout if delayed too
   * long), and the waiting invocation returns immediately.
   */
  const cutMeasure = (m: Measuring, why: "deadline" | "stale" | "stopped") => {
    const r = run;
    if (r && ctx?.measure) {
      if (!r.stop) r.stop = why;
      if (r.yieldAt === null) r.yieldAt = deps.now();
    }
    endMeasure(m, why);
  };

  /**
   * Sparse pass for this card during measurement: pre-checks, producing only if absent. Checks
   * whether this invocation is still waiting after each step (stops proceeding on timeout).
   */
  const runMeasure = async (m: Measuring): Promise<MeasureOutcome["result"]> => {
    const { req } = m;
    const eff = effectivePasses();
    const sparsePass = eff.findIndex(sparse);
    if (sparsePass < 0 || !req.clips.length) return "none";
    // Wait for this page to become a node (obtain fingerprint, probe encoder): at most
    // `measureReadyMs`; if timed out, this card is deferred to idle time.
    const readyBy = deps.now() + measureReadyMs;
    for (;;) {
      let ok = false;
      try { ok = deps.capable() === true; } catch { ok = false; }
      if (ok) break;
      if (deps.now() >= readyBy) return "incapable";
      await nextTick();
      if (m.done) return "stopped";
    }
    // This accounting record: reused for same project and revision (cards added one by one in this
    // round); if manifest plan's record exists, stop and replace it first.
    const id = `measure:${req.projectId}@${req.projectRev}`;
    if (!ctx || !ctx.measure || ctx.plan.id !== id) {
      if (run) {
        stopRun("measure", true);
        // Wait for it to finalize (returns immediately after abort).
        for (let i = 0; run && i < 40; i++) { await nextTick(); if (m.done) return "stopped"; }
        if (run) return "busy";
      }
      ctx = newCtx({ id, projectId: req.projectId, projectRev: req.projectRev, clips: [], at: deps.now() }, true);
      ctx.specs = [];
    }
    const c = ctx;
    const got = await deps.specs({ ...c.plan, clips: [...new Set([...req.heavy, ...req.clips])] });
    if (m.done) return "stopped";
    if (ctx !== c) return "interrupted";
    if (!got) return "incapable";
    c.project = got.project;
    Object.assign(c.skipped, got.skipped);
    const wanted = new Set(req.clips);
    const known = new Set((c.specs ?? []).map((spec) => spec.streamKey));
    const fresh = got.specs.filter((spec) => wanted.has(spec.topClipId) && !known.has(spec.streamKey));
    for (const spec of fresh) { c.specs!.push(spec); c.rows.set(spec.streamKey, pageStreamRow(got.project, spec)); }
    const mine = new Set(got.specs.filter((spec) => wanted.has(spec.topClipId)).map((spec) => spec.streamKey));
    c.jobs.push(...jobsOf(c, fresh, eff[sparsePass], sparsePass));
    const jobs = c.jobs.filter((j) => mine.has(j.spec.streamKey) && j.state === "todo");
    if (!jobs.length) return c.jobs.some((j) => mine.has(j.spec.streamKey)) ? "ok" : "none";
    m.out.left = jobs.length;
    let failed = false;
    for (const job of jobs) {
      if (job.state !== "todo") { m.out.left--; continue; }
      const found = await check(c, job);
      if (m.done) return "stopped";
      if (ctx !== c) return "interrupted";
      if (found) {
        settle(c, job, found);
        m.out.left--;
        if (found.own) { m.out.have++; await syncRows(c); if (m.done) return "stopped"; } else m.out.elsewhere++;
        continue;
      }
      // Write this row into the layer table before starting work (this page's online source and other
      // pages locate this stream's manifest from it).
      if (!c.mine.has(job.spec.streamKey)) { c.mine.add(job.spec.streamKey); await syncRows(c); if (m.done) return "stopped"; }
      if (ctx !== c) return "interrupted";
      // Found someone else fully produced it while writing: next pre-check will recognize it for this
      // segment; do not produce here.
      if (!c.mine.has(job.spec.streamKey)) continue;
      if (run) return "busy";
      if (isLow()) {
        if (consecutiveErrors >= 3) {
          job.state = "failed";
          counters.failed++;
          failed = true;
          break;
        }
        const supported = await checkEncoderSupported(job.spec);
        if (!supported) {
          job.state = "failed";
          counters.failed++;
          failed = true;
          break;
        }
      }
      await start(c, job);
      if (m.done) return "stopped";
      if (ctx !== c) return "interrupted";
      if ((job.state as TaskState) === "produced") { m.out.produced++; m.out.left--; await syncRows(c); if (m.done) return "stopped"; continue; }
      if ((job.state as TaskState) === "have" || (job.state as TaskState) === "elsewhere") { m.out.left--; continue; }
      // Failed (aborted due to page hidden, stage error): remaining work for this card is deferred to
      // idle time.
      failed = true;
      break;
    }
    return failed ? "failed" : m.out.left > 0 ? "interrupted" : "ok";
  };

  return {
    tick() {
      const now = deps.now();
      // The invocation waiting during measurement: clock expired, this round invalidated, returns immediately.
      const m = measuring;
      if (m && clock && now - clock.startedAt >= measureMaxMs) cutMeasure(m, "deadline");
      else if (m) { let stale = false; try { stale = m.req.stale?.() === true; } catch { stale = false; } if (stale) cutMeasure(m, "stale"); }
      if (tickWaiters.length) { const wake = tickWaiters; tickWaiters = []; for (const w of wake) w(); }
      const plan = deps.plan();
      let capable = false;
      try { capable = deps.capable() === true; } catch { capable = false; }
      // Accounting record during measurement: kept until manifest plan is published (no plan does not
      // count as "not producing"); not replaced before waiting invocation returns.
      const mc = ctx?.measure ? ctx : null;
      if (mc && capable && (measuring || !plan || plan.projectId !== mc.plan.projectId || plan.at < mc.plan.at)) {
        const r = run;
        if (r && r.yieldAt !== null && now - r.yieldAt >= YIELD_FRAME_MAX_MS && !r.controller.signal.aborted) r.controller.abort();
        // Whether this page's rows are still in the layer table (same as below).
        if (!measuring && !working && mc.mine.size && now - mc.rowsAt >= rowsMs) { working = true; void syncRows(mc).finally(() => { working = false; }); }
        return;
      }
      if (!plan || !capable) { if (ctx || run) drop(!plan ? "no-plan" : "incapable"); return; }
      if (!ctx || ctx.plan.id !== plan.id) {
        // Switched to a new revision (or manifest changed): immediately stop production for old revision
        // (streams for that revision are likely already stale).
        if (run) stopRun("plan-changed", true);
        ctx = newCtx(plan, false);
      }
      const c = ctx;
      const r = run;
      // Current frame delayed too long after yielding (gate for background work closed during
      // playback/scrubbing): do not wait any longer, abort.
      if (r && r.yieldAt !== null && now - r.yieldAt >= YIELD_FRAME_MAX_MS && !r.controller.signal.aborted) r.controller.abort();
      if (!c.specs) { if (!working && now - c.specsAt >= 1000) void loadSpecs(c); return; }
      if (!c.jobs.length) return;
      const pending = c.jobs.some((j) => j.state === "todo");
      // No more work, stop querying queue (do not send a single extra message).
      if (pending || r) pollPlan(c);
      if (taken(c)) { if (r) stopRun("splitter"); return; }
      // Whether this page's rows are still in the layer table (later writes overwrite earlier writes).
      if (!working && c.mine.size && now - c.rowsAt >= rowsMs) { working = true; void syncRows(c).finally(() => { working = false; }); return; }
      if (r) { recheck(c, r); return; }
      if (!pending || working) return;
      if (c.probe.state !== "open" && c.probe.state !== "failed") return;
      if (now - c.plan.at < waitMs) return;
      let idle = false;
      try { idle = deps.isIdle() === true; } catch { idle = false; }
      if (!idle) return;
      void step(c);
    },
    yieldFor(cause) {
      const r = run;
      if (!r) return;
      if (cause === "hidden") { if (!r.yieldCause) r.yieldCause = cause; r.controller.abort(); return; }
      if (!r.yieldCause) { r.yieldCause = cause; r.yieldAt = deps.now(); }
    },
    running: () => run !== null || measuring !== null,
    measure(req) {
      const now = deps.now();
      mstats.calls++;
      const blank = (result: MeasureOutcome["result"]): MeasureOutcome => { bump(mstats.results, result); return { result, produced: 0, have: 0, elsewhere: 0, left: 0 }; };
      if (measuring) return Promise.resolve(blank("busy"));
      // Clock for this round of overlay: starts counting from first time waiting for sparse version.
      if (!clock || clock.round !== req.round) {
        clock = { round: req.round, startedAt: now };
        Object.assign(mstats, { round: req.round, startedAt: now, deadlineAt: now + measureMaxMs });
      }
      if (now - clock.startedAt >= measureMaxMs) return Promise.resolve(blank("deadline"));
      return new Promise<MeasureOutcome>((resolve) => {
        const m: Measuring = { req, at: now, done: false, resolve, out: { result: "ok", produced: 0, have: 0, elsewhere: 0, left: 0 } };
        measuring = m;
        void runMeasure(m).then((result) => endMeasure(m, result), (e) => { fail(e); endMeasure(m, "failed"); });
      });
    },
    stop(reason = "stopped") {
      const m = measuring;
      drop(reason);
      if (m) endMeasure(m, "stopped");
      if (tickWaiters.length) { const wake = tickWaiters; tickWaiters = []; for (const w of wake) w(); }
    },
    debug() {
      const c = ctx;
      const now = deps.now();
      let state: PageStreamsDebug["state"] = "off";
      if (c) {
        if (c.measure) state = run ? "producing" : "measuring";
        else if (!c.specs) state = "planning";
        else if (!c.jobs.length) state = "none";
        else if (run) state = "producing";
        else if (taken(c)) state = "taken";
        else if (!c.jobs.some((j) => j.state === "todo")) state = "done";
        else if (phase === "checking") state = "checking";
        else if ((c.probe.state !== "open" && c.probe.state !== "failed") || now - c.plan.at < waitMs) state = "waiting";
        else state = "idle-wait";
      }
      return {
        state, planId: c?.plan.id ?? null, planState: c?.probe.state ?? "none", waitedMs: c ? now - c.plan.at : null,
        streams: (c?.specs ?? []).map((s) => ({ clipId: s.topClipId, contentKey: s.contentKey, streamKey: s.streamKey, firstSegment: s.firstSegment, lastSegment: s.lastSegment, mine: c!.mine.has(s.streamKey) })),
        jobs: (c?.jobs ?? []).map((j) => ({ id: j.task.id, clipId: j.spec.topClipId, pass: j.pass.name, state: j.state, via: j.via, fails: j.fails })),
        skipped: { ...(c?.skipped ?? {}) },
        running: run ? { id: run.job.task.id, yield: run.yieldCause, stop: run.stop } : null,
        counters: { ...counters, yields: { ...counters.yields }, stops: { ...counters.stops } },
        measure: { ...mstats, active: measuring !== null, results: { ...mstats.results }, log: mstats.log.map((e) => ({ ...e, clips: [...e.clips] })) },
        lastError,
      };
    },
  };
}
