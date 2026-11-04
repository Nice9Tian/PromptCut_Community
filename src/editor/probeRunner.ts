/**
 * K1's **resident probe** (the driver on the parent-page side).
 *
 * When a project opens, every active card is measured one by one under the loading overlay
 * (`ProbeGate`) before editing starts (pinned rendering 5). Cards added afterwards, and cards whose
 * `cardCostKey` changed, are then measured on the background stage, which no longer blocks the UI.
 *
 * The offline version is `scripts/probe-card-costs.mjs`; it does the same job with the same numbers:
 * the `device` string (`src/render/costDevice.mjs`) and the statistics definitions
 * (`src/render/probeSummary.mjs`) are the same code, so records measured by the two paths recognize
 * each other and can be compared side by side.
 *
 * # How one card is measured (K1)
 *
 * 1. `pushProject('back', reduced project, { reset: true })`: **measure only one clip at a time**.
 *    `render` has no clipId, so without reducing the project the stage would push all currently active
 *    cards together, and the measured numbers would be polluted without any error.
 *    The shape is the same as `legacyTimeline` in `FrameScene`: one track, one clip.
 *    It must go through `pushProject` rather than calling `setProject` directly: the latter bypasses
 *    the baseline, so a later `syncProject` silently sends nothing because "nothing changed compared
 *    with the baseline", and `back` stays on the reduced project forever (a pitfall called out in E0).
 * 2. A `stepped` card takes three passes:
 *    - **timing pass** `render(last frame, { jump: true, probe: 'time', maxCatchUp: Infinity })`,
 *      which yields the per-frame live render time `steps`; **the `{ aborted: true, reason: 'timeout' }`
 *      returned when the cap is hit is the normal path for long clips, not a failure** (R4a report §8,
 *      item 8); `catchUpMs` is extrapolated from the frames already pushed;
 *    - **snapshot pass** `render(…, { probe: 'snapshot' })`, which yields the per-frame timings of the
 *      three parts of generate snapshots (`snapshotSteps` in the response, one round trip; to get the
 *      same numbers the offline script sent 40 round trips, one per frame, which is too slow under the
 *      loading overlay). It is still bound by the one-tick budget, and truncation does not affect any
 *      decision;
 *    - **two-pass boolean probe** `render(…, { probe: 'booleans' })`: `vtOk` / `seekOk` / `seekMs`
 *      run entirely inside the stage (it needs `pinner.syncIn` to pin the subtree's virtual time, which
 *      the parent page cannot reach).
 * 3. A `direct` card: sample local frames at random, seeded by cardId, and send one
 *    `setTime(t, { probe: true })` for each, until `STEP_MIN_SAMPLES` is reached (top up if 8 is not
 *    enough, otherwise the percentiles cannot be reached), `catchUpMs = 0`.
 * 4. The parent page fills in `device` / `mode` / `measuredAt` / `demoted: false` and then does a
 *    **PUT of the whole record** (`costs-store` replaces the whole record, and `validRecord` requires
 *    `identityKey` + `device`).
 *    `demoted: false` must be **written explicitly**: `STICKY_FLAGS` means "keep the old value if it
 *    is not supplied", so if it is omitted, once K6 has written `true`, every re-measurement gets
 *    `true` carried back, and the card is permanently classified as heavy (3.3).
 *
 * # Skipping what has already been measured
 *
 * A card is skipped entirely when a record already exists for the same `(identityKey, device)`
 * **and `demoted !== true`** (last sentence of pinned rendering 5: if the identity has not changed,
 * reuse it directly). When `costs` is a full hit, no card is measured and the overlay never appears
 * for even one frame.
 *
 * # Queuing and cut-off
 *
 * The whole job for each card is queued once through the single-flight queue of `stageJobs`, at the
 * lowest tier, `'probe'`: when a catch-up run (K5) or a page-side measurement (D4) comes in, the probe
 * yields; as soon as `ctx.signal` fires it stops, and this card is re-queued from the start
 * (E0: "after `settled` or an aborted catch-up run... the probe re-queues from the start of the
 * current card").
 *
 * An aborted `render` response follows E0's five rules (`renderAbortAction`):
 *   `'timeout'` is ignored (normal path), `'project'` is re-sent (re-send the reduced project first,
 *   at most 3 times), `'superseded'` is discarded, `'detached'` starts over with another client,
 *   `'role'` is treated as an error.
 *
 * **When the project changes, the queue is rebuilt for the new project**: `syncProbeRun(project)`
 * increments the generation, the card currently running exits once it finishes, then `costs` is
 * fetched again, `identityKey` is recomputed, and the queue is rebuilt. Newly added cards, and cards
 * whose `cardCostKey` changed, are naturally measured afterwards.
 *
 * # After a card is measured (online page: the sparse track stream is produced at measurement time)
 *
 * `docs/semantics/mechanism/rendering.md` "Measurement": the second pass produces a sparse track
 * stream for cards classified as heavy; on the online page the background stage produces it itself,
 * right after this card's first pass.
 * Only one hook is left here, `setCardMeasuredHook`: during the round that the loading overlay blocks,
 * after each card is measured and its record merged into the dispatch table, it is called once and
 * awaited (so the overlay waits for the sparse version); whether to produce one and how long to wait
 * (50 seconds at most) is decided by the side that plugs in (`browserNodeHost.ts` → `measure()` in
 * `online/pageStreams.ts`).
 * Re-measurements that do not block the UI do not call it: whatever needs filling in afterwards is
 * produced only when idle. When nothing plugs in (desktop app), nothing changes at all.
 */
import { flatPlanProject, isFlatClipId } from "../kernel/cutFlatten.mjs";
import type { Project } from "../kernel/project";
import { costDeviceString, readGpuRenderer, resolveGlRoute } from "../render/costDevice.mjs";
import { budgetOf } from "../render/pipelinePlan.mjs";
import { resolveTuning, PROBE_MAX_FRAMES, type PipelineTuning } from "../render/pipelineTuning.mjs";
import { summarizeProbe } from "../render/probeSummary.mjs";
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import type { RenderAborted, RenderReply, SetTimeAborted, SetTimeReply, StageRpcClient } from "../render/stageRpc";
import { clipIdentityOf, resetClipIdentityCache } from "./costIdentity";
import { mergePlanCosts, setPlanCosts } from "./planDispatch";
import { backStage, pushProject, stageCapabilities, whenStageReady } from "./stageBridge";
import { MAX_PROJECT_RESENDS, currentBackJob, renderAbortAction, runBackJob } from "./stageJobs";
import { measureGateOpen, whenMeasureGateOpen } from "./measureGate";
import { tierGlRoute, tierState } from "../online/onlineTier";

/* ------------------------------------------------------------------ progress */

export interface ProbeProgress {
  /** This round is still measuring */
  running: boolean;
  /**
   * Whether this round **should block the UI**. Only "the first round of opening a project" is true
   * (pinned render 5); cards added afterwards are re-measured in the background and no longer block
   * (K1: "the fallback dispatch is used only for the few seconds while a new card hasn't finished
   * being measured").
   */
  blocking: boolean;
  /** How many cards this round will measure */
  total: number;
  /** How many cards have been measured */
  done: number;
  /** The id of the card being measured (for the text on the overlay) */
  card: string | null;
  /** Those that couldn't be measured (for diagnostics, doesn't block the flow) */
  failed: string[];
}

const IDLE: ProbeProgress = { running: false, blocking: true, total: 0, done: 0, card: null, failed: [] };

let progress: ProbeProgress = IDLE;
const listeners = new Set<(p: ProbeProgress) => void>();

export function probeProgress(): ProbeProgress {
  return progress;
}

export function onProbeProgress(cb: (p: ProbeProgress) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function setProgress(patch: Partial<ProbeProgress>): void {
  progress = { ...progress, ...patch };
  for (const cb of listeners) cb(progress);
}

/* ------------------------------------------------------------------ Constants */

/** At mount, give it a real task boundary before starting to measure: React has to build the tree, and Motion has to resolve keyframes */
const MOUNT_SETTLE_MS = 150;
/** A canvas card (three.js / tsParticles) also has to wait for it to set up the canvas asynchronously, otherwise what is measured is an empty shell */
const CANVAS_WAIT_TRIES = 20;
const CANVAS_WAIT_STEP_MS = 50;
/** The maximum number of retries per card (the cap for `'project'` resends + one client swap) */
const MAX_ATTEMPTS = MAX_PROJECT_RESENDS + 1;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ hook after a card is measured */

export interface CardMeasuredInfo {
  /** Which version of the project was measured (the object in the store) */
  project: Project;
  /** All clips with the same identity as the card just measured (several clips of one card are measured once) */
  clipIds: string[];
  cardId: string;
  identityKey: string;
  /** Number of this loading-mask round: changes each time the mask appears (project opened, fps switched) */
  round: number;
  /** Whether this round of measurement was invalidated (project changed, connection switched) */
  stale: () => boolean;
}
type CardMeasuredHook = (info: CardMeasuredInfo) => Promise<unknown>;
let cardMeasuredHook: CardMeasuredHook | null = null;
/**
 * Attaches the "after a card is measured" hook; returns the unsubscribe function. Only called in a round
 * blocked by the loading mask; once called, wait for it to return (it manages its own limit)
 */
export function setCardMeasuredHook(hook: CardMeasuredHook | null): () => void {
  cardMeasuredHook = hook;
  return () => { if (cardMeasuredHook === hook) cardMeasuredHook = null; };
}
/** Number of this loading-mask round */
let maskRound = 0;
/**
 * Other measurements under the mask (the boundary search over the two stages, `Preview.tsx`) also go through
 * the same hook after measuring a card: produce a sparse version for cards judged heavy, and wait for it.
 * The mask number is the same as the resident probe's (one mask round has a single 50-second limit for waiting
 * on the sparse version). When nobody is attached (desktop app), it does nothing.
 */
export async function runCardMeasuredHook(info: Omit<CardMeasuredInfo, "round">): Promise<void> {
  const hook = cardMeasuredHook;
  if (!hook) return;
  try { await hook({ ...info, round: maskRound }); }
  catch (err) { console.warn("[probeRunner] Error in the hook after a card is measured", err); }
}

/* ------------------------------------------------------------------ identity and device */

/** `import.meta.env.DEV`: the desktop app runs the vite dev server, so dispatch uses the record for the current run mode (3.1) */
const RUN_MODE: "dev" | "build" = import.meta.env.DEV ? "dev" : "build";

/**
 * Local machine identity (J4). `compact` / `offscreenGl` take **the copy reported by the stage handshake**:
 * the offline probe uses it too, and probing again in the main document would be a second implementation
 * that drifts.
 */
/*
 * The GPU renderer string does not change within a page session: read it once and remember it (C6.6
 * integration, T4). Previously every round created a new WebGL context to read it and then released it,
 * which added a few to a dozen milliseconds on every project change while editing. A result of `unknown`
 * (the context could not be created) is not remembered; it is read again next time.
 */
let gpuRenderer: string | null = null;
function gpuRendererOnce(): string {
  if (gpuRenderer) return gpuRenderer;
  const r = readGpuRenderer(document);
  if (r !== "unknown") gpuRenderer = r;
  return r;
}

function deviceStringOf(tuning: PipelineTuning): string {
  const caps = stageCapabilities("back");
  return costDeviceString({
    ua: navigator.userAgent,
    renderer: gpuRendererOnce(),
    compact: !!caps?.compact,
    offscreenGl: !!caps?.offscreenGl,
    // Effective route (M2): desktop uses the project option, default route 1; online page uses the stage gate (`onlineTier.ts`). Switching route is like switching machines: old records miss and are probed again
    glRoute: effectiveGlRoute(currentProject),
    mode: RUN_MODE,
    tuning,
  });
}

/* ------------------------------------------------------------------ Which cards to probe */

interface ProbeJob {
  clipId: string;
  cardId: string;
  identityKey: string;
  /** Declared frame mode: `direct` samples, the others push frames */
  frameMode: string;
  canvasHeavy: boolean;
  /** Axis three of the review table. Only `independent` cards store probe frames as prerender assets (last sentence of K1) */
  independent: boolean;
  fps: number;
  lenSec: number;
  durationFrames: number;
  /** Shrunken project: one clip per track, shaped like `legacyTimeline` of `FrameScene` */
  project: Project;
}

/** Shrunken project (K1 "measure only one clip at a time") */
function shrinkProject(project: Project, track: Project["tracks"][number], clip: Project["tracks"][number]["clips"][number]): Project {
  return {
    ...project,
    duration: Math.max(1 / Math.max(1, project.fps || 30), clip.end - clip.start),
    media: [],
    filters: undefined,
    cardNodes: undefined,
    tracks: [{ ...track, hidden: false, clips: [{ ...clip, start: 0, end: clip.end - clip.start }] }],
  } as Project;
}

function planJobs(project: Project, costs: CardCostRecord[], device: string): ProbeJob[] {
  // The identity key and capability table are shared with `planDispatch` (`costIdentity.ts`):
  // the record the probe writes and the key the dispatch table looks up must be computed by the same algorithm
  const { identityKeys, capabilities: capsOf } = clipIdentityOf(project);

  // Skip the whole card if a record exists and demoted !== true (last sentence of pinned render 5)
  const known = new Set(costs.filter((r) => r.device === device && r.demoted !== true).map((r) => r.identityKey));
  const fps = Math.max(1, project.fps || 30);
  const jobs: ProbeJob[] = [];
  const seen = new Set<string>();
  // Cards inside a cut segment are still measured (flattened view of `kernel/cutFlatten.mjs`; the clip id is
  // `<segment id>~<card clip id>`): in the shrunken project it is a single top-level card
  for (const track of flatPlanProject(project).tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (!clip.cardId && !clip.nodeId) continue;
      const identityKey = identityKeys[clip.id];
      if (!identityKey) continue;
      // Several clips of the same card have the same identity, so they are measured only once
      if (seen.has(identityKey) || known.has(identityKey)) continue;
      seen.add(identityKey);
      const caps = capsOf.get(clip.id) ?? {};
      const lenSec = Math.max(1 / fps, Number(clip.end) - Number(clip.start));
      jobs.push({
        clipId: clip.id,
        cardId: clip.cardId ?? clip.nodeId ?? "?",
        identityKey,
        frameMode: typeof caps.frameMode === "string" ? caps.frameMode : "stateful",
        canvasHeavy: caps.canvasHeavy === true,
        // Probe frames of cards inside a cut segment are not used as prerender assets (they only produce a
        // single-card track stream, and the isolated project would have to carry the cut segment chain)
        independent: caps.compositing === "independent" && !isFlatClipId(clip.id),
        fps,
        lenSec,
        durationFrames: Math.max(1, Math.round(lenSec * fps)),
        project: shrinkProject(project, track, clip),
      });
    }
  }
  return jobs;
}

/* ------------------------------------------------------------------ Endpoints */

/**
 * Where cost records are stored (C10 contract section 3): in the desktop runtime it is `GET / PUT /api/data/costs`
 * of the editor process; for the online two-stage setup `Preview` swaps in the `costs` table of the in-page
 * snapshot store L2 (`src/online/l2Costs.ts`, `mode=build`, no re-measurement after closing and reopening).
 * `forwardFrames`: whether probe frames are forwarded to the prerender process (the online page has no
 * prerender process, so it does not forward).
 */
export interface CostBackend {
  load(): Promise<{ costs: CardCostRecord[]; tuning: PipelineTuning }>;
  save(records: CardCostRecord[]): Promise<boolean>;
  forwardFrames?: boolean;
}
const httpBackend: CostBackend = { load: () => getCostsHttp(), save: (records) => putCostsHttp(records), forwardFrames: true };
let backend: CostBackend = httpBackend;

/** Swap the storage location of cost records; null goes back to the editor process */
export function setCostBackend(next: CostBackend | null): void {
  backend = next ?? httpBackend;
}

/**
 * Subscription hook left at the point where a measurement is written to the cost records (C10 contract
 * section 18, item 7): on every write, the record just measured is sent to the subscriber (`stored`: whether
 * the write succeeded). The shared cost records on the document service side are attached here by
 * `claude/c10-cost` (wired up by the lead session at integration).
 */
const costRecordListeners = new Set<(records: CardCostRecord[], info: { stored: boolean }) => void>();
export function onCostRecords(cb: (records: CardCostRecord[], info: { stored: boolean }) => void): () => void {
  costRecordListeners.add(cb);
  return () => { costRecordListeners.delete(cb); };
}

async function getCosts(): Promise<{ costs: CardCostRecord[]; tuning: PipelineTuning }> {
  return backend.load();
}

async function putCosts(records: CardCostRecord[]): Promise<boolean> {
  const stored = await backend.save(records).catch(() => false);
  for (const l of [...costRecordListeners]) { try { l(records, { stored }); } catch { /* A broken subscriber does not affect measurement */ } }
  return stored;
}

/** Clips that were measured (for diagnostics and probes; latest 200): which clip, which card, identity key, when measuring started */
const probedLog: Array<{ clipId: string; cardId: string; identityKey: string; at: number }> = [];
export function probeRunDiag() {
  return { probed: probedLog.map((e) => ({ ...e })), running: progress.running, done: progress.done, total: progress.total };
}

/** Diagnostics for probe frames: how many frames arrived, and how many of them are compressed transferable bytes (C10 contract section 2, "large output") */
const probeFrameStats = { frames: 0, gzFrames: 0, gzBytes: 0, htmlBytes: 0 };
export function probeFrameDiag() {
  return { ...probeFrameStats };
}

async function getCostsHttp(): Promise<{ costs: CardCostRecord[]; tuning: PipelineTuning }> {
  try {
    const res = await fetch("/api/data/costs");
    if (!res.ok) return { costs: [], tuning: resolveTuning(null) };
    const data = await res.json();
    return {
      costs: Array.isArray(data?.costs) ? (data.costs as CardCostRecord[]) : [],
      tuning: resolveTuning(data?.tuning),
    };
  } catch {
    // Plugin not attached / offline: this round uses default coefficients and skips no card (the PUT after
    // measuring will also fail, but that should not block the UI)
    return { costs: [], tuning: resolveTuning(null) };
  }
}

async function putCostsHttp(records: CardCostRecord[]): Promise<boolean> {
  try {
    const res = await fetch("/api/data/costs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records }),
    });
    return res.ok;
  } catch {
    return false;
  }
}



/* ------------------------------------------------------------------ Measure one card */

const isAborted = (r: RenderReply): r is RenderAborted => !!r && (r as { aborted?: boolean }).aborted === true;
/** A `setTime` carrying `probe` can only be rejected by the role gate (`{ aborted: true, reason: 'role' }`) */
const isSetTimeAborted = (r: SetTimeReply): r is SetTimeAborted => !!r && (r as { aborted?: boolean }).aborted === true;

type Attempt =
  | { kind: "ok"; record: CardCostRecord }
  /** Reschedule this card from the start (`'project'` / `'detached'` / more urgent work took the queue) */
  | { kind: "retry" }
  /** Do not try again this round (`'role'` / threw an error) */
  | { kind: "fail" };

/** Random numbers seeded by cardId, the same implementation as the offline probe: rerunning on the same machine samples the same frames, so results are comparable */
const seedOf = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/**
 * Whether the canvas card has set up its canvas. **The iframe's document cannot be reached cross-origin**
 * (the offline probe side is same-origin and queries `[data-pc-clip] canvas` directly), so we ask
 * `rectsWithBounds({ pixels: 'all' })` instead: it makes the stage read the canvas pixels once and compute
 * the bounding box of the content; if a box comes out, something was really drawn on the canvas.
 */
async function waitForCanvas(stage: StageRpcClient, clipId: string): Promise<void> {
  for (let i = 0; i < CANVAS_WAIT_TRIES; i++) {
    try {
      const list = await stage.rectsWithBounds({ pixels: "all", clipIds: [clipId] });
      const box = list.find((r) => r.clipId === clipId)?.bounds;
      if (box && box.width > 1 && box.height > 1) break;
    } catch {
      return;
    }
    await sleep(CANVAS_WAIT_STEP_MS);
  }
  await sleep(MOUNT_SETTLE_MS);
}

async function probeCardOnce(
  job: ProbeJob,
  stage: StageRpcClient,
  signal: AbortSignal,
  tuning: PipelineTuning,
  device: string,
  stale: () => boolean,
): Promise<Attempt> {
  /** Translate an abort reply into "what to do with this card" following the five rules of E0 */
  const onAbort = (r: RenderAborted): Attempt | null => {
    if (r.reason === "role" && (stage !== backStage() || signal.aborted)) return { kind: "retry" };
    switch (renderAbortAction(r.reason, currentBackJob())) {
      case "ignore": return null;            // 'timeout': the normal path for long clips, not a failure
      case "resend": return { kind: "retry" };
      case "rebind": return { kind: "retry" };
      case "drop": return { kind: "retry" };
      case "error": return { kind: "fail" };
    }
  };

  // Measure one clip at a time: swap in the shrunken project first, then render (in the wrong order, all
  // active cards would be pushed together on the full project)
  await pushProject("back", job.project, { reset: true });
  if (stale() || signal.aborted) return { kind: "retry" };
  await stage.setTime(0);
  await sleep(MOUNT_SETTLE_MS);
  if (job.canvasHeavy) await waitForCanvas(stage, job.clipId);
  if (stale() || signal.aborted) return { kind: "retry" };

  const steps: number[] = [];
  const inline: number[] = [];
  const raster: number[] = [];
  const serialize: number[] = [];
  let kind: "random" | "stepped";
  let totalFrames = job.durationFrames;
  let truncated = false;
  let booleans: { vtOk?: boolean; seekOk?: boolean; seekMs?: number | null } = {};

  if (job.frameMode === "direct") {
    kind = "random";
    /*
     * Sample local frames with a fixed random sequence, **drawing up to STEP_MIN_SAMPLES** (K1: if 8 draws are
     * not enough, draw more):
     * without the extra draws, 8 samples do not reach the percentile, and `robustStep` has to fall back to the max.
     */
    const want = Math.max(8, Math.min(tuning.STEP_MIN_SAMPLES, job.durationFrames));
    const rnd = mulberry32(seedOf(job.cardId));
    const picks = new Set<number>();
    for (let i = 0; i < want * 64 && picks.size < Math.min(want, job.durationFrames); i++) picks.add(Math.floor(rnd() * job.durationFrames));
    const frames = [...picks].sort((a, b) => a - b);
    for (const n of frames) {
      if (stale() || signal.aborted) return { kind: "retry" };
      const r = await stage.setTime(n / job.fps, { probe: true });
      if (isSetTimeAborted(r)) {
        // K5 may swap the visible and background stages during the setTime round trip; the old client then becomes front.
        // Retry from the new back only when the stage has changed hands or been preempted by high-priority work.
        return stage !== backStage() || signal.aborted ? { kind: "retry" } : { kind: "fail" };
      }
      // stepMs is taken by the stage **before** it waits for that one real rAF, so it no longer includes vsync (last item of 3.8)
      steps.push(Number(r.stepMs) || 0);
      inline.push(Number(r.snapshot?.inlineMs) || 0);
      raster.push(Number(r.snapshot?.rasterMs) || 0);
      serialize.push(Number(r.snapshot?.serializeMs) || 0);
    }
    totalFrames = frames.length;
  } else {
    kind = "stepped";
    const lastSec = Math.max(0, job.lenSec - 1 / job.fps);
    totalFrames = Math.max(1, Math.round(lastSec * job.fps) + 1);

    /* ---- Timing pass: only advance, do not generate snapshots ---- */
    const timePass = await stage.render(lastSec, { jump: true, probe: "time", maxCatchUp: Infinity, maxFrames: PROBE_MAX_FRAMES });
    if (isAborted(timePass)) {
      const out = onAbort(timePass);
      if (out) return out;
      truncated = true;                        // 'timeout': hit the cap, normal path
    }
    for (const s of (timePass as { steps?: number[] }).steps ?? []) steps.push(Number(s) || 0);
    if (stale() || signal.aborted) return { kind: "retry" };



    /* ---- Two-pass boolean probe: the whole pass runs inside the stage (K1) ---- */
    const boolPass = await stage.render(lastSec, { jump: true, probe: "booleans" });
    if (isAborted(boolPass)) {
      const out = onAbort(boolPass);
      if (out) return out;
    } else if (boolPass.booleans) {
      booleans = boolPass.booleans;
    }
  }

  const summary = summarizeProbe({ kind, steps, inline, raster, serialize, totalFrames, truncated }, tuning);
  const capped = summary.stepMs * tuning.COST_SCALE > budgetOf(job.fps);
  const round = (x: number) => Number(x.toFixed(3));

  return {
    kind: "ok",
    record: {
      identityKey: job.identityKey,
      fps: job.fps,
      // Five numbers are reported separately (3.8 + K1); the old frameMs is removed, with no compatibility kept
      stepMs: round(summary.stepMs),
      stepMaxMs: round(summary.stepMaxMs),
      inlineMs: round(summary.inlineMs),
      rasterMs: round(summary.rasterMs),
      serializeMs: round(summary.serializeMs),
      catchUpMs: round(summary.catchUpMs),
      // Number of frames actually sampled by the timing pass (the shared cost records need it; when missing, the
      // transcription takes it from stepN in the `device` string, see `samplesOf` in `sharedCosts.ts`)
      ...(summary.samples > 0 ? { samples: summary.samples } : {}),
      ...(capped ? { capped: true } : {}),
      kind,
      ...(typeof booleans.vtOk === "boolean" ? { vtOk: booleans.vtOk } : {}),
      ...(typeof booleans.seekOk === "boolean" ? { seekOk: booleans.seekOk } : {}),
      ...(booleans.seekMs !== undefined ? { seekMs: booleans.seekMs === null ? null : round(booleans.seekMs) } : {}),
      mode: RUN_MODE,
      // **Write false explicitly** (3.3): STICKY_FLAGS means "keep the old value if not supplied"; if we do not
      // write it, once K6 has written true, every re-measurement will be pasted back to true and this card would be
      // judged heavy forever. pinnedHeavy is left for manual pinning and is not written here.
      demoted: false,
      measuredAt: Date.now(),
      device,
    },
  };
}

/* ------------------------------------------------------------------ main loop */

let currentProject: Project | null = null;
let queuedIdentity: string | null = null;
let queuedBackend: CostBackend | null = null;
let queuedDeviceInputs = "";
/** +1 whenever the project changes: the round in progress winds down accordingly and reschedules for the new project */
let generation = 0;
let settledGeneration = 0;
let looping = false;
/** Whether the "first round after opening a project" has passed; later top-up measurements no longer block the UI */
let firstPassDone = false;

const hasCardClip = (p: Project | null): boolean =>
  !!p && !!flatPlanProject(p).tracks?.some((tr) => tr.clips?.some((c) => !!c.cardId || !!c.nodeId));

/** The preload for this project can use the measured costs. */
export function probeSettledFor(project: Project): boolean {
  return currentProject === project && settledGeneration === generation;
}

/**
 * Called once when the project changes (`ProbeGate` calls it in an effect). The same object reference does
 * not reschedule: the store updates immutably, so if the reference is unchanged, nothing has changed.
 */
export function syncProbeRun(project: Project | null): void {
  if (project === currentProject) return;
  queueProbeRun(project, identitySignature(project));
}

function identitySignature(project: Project | null): string | null {
  if (!project) return null;
  const { identityKeys, capabilities } = clipIdentityOf(project);
  return JSON.stringify(Object.keys(identityKeys).sort().map((clipId) => {
    const caps = capabilities.get(clipId) ?? {};
    return [clipId, identityKeys[clipId], typeof caps.frameMode === "string" ? caps.frameMode : "stateful",
      caps.canvasHeavy === true, caps.compositing === "independent"];
  }));
}

function deviceInputs(project: Project | null): string {
  const caps = stageCapabilities("back");
  return JSON.stringify([!!caps?.compact, !!caps?.offscreenGl, effectiveGlRoute(project)]);
}

/** Effective canvas render route: the online page follows the stage gate (`tierGlRoute`); desktop uses the project option, default route 1 */
function effectiveGlRoute(project: Project | null): "perDocument" | "shared" {
  return tierState().online ? tierGlRoute() : resolveGlRoute(project?.glRoute ?? null);
}

function queueProbeRun(project: Project | null, identity: string | null): void {
  /*
   * **Switching fps must go through the loading mask again** (project option of pinned architecture 7 + "measure
   * on every project open" of render 5). `cardCostKey` folds fps into the identity key, so after the frame rate
   * changes the records of all cards mismatch and none can be reused; this round has as many cards to measure
   * as when opening a new project. Without blocking behind the mask, the user would see a stretch of measuring
   * while editing, during which the dispatch table is still the fallback one. So we reset `firstPassDone`,
   * making this round `blocking` again. The budget `B = 1000/fps × 70%` changes too, so re-measuring is a must.
   */
  if (project && currentProject && Number(project.fps) !== Number(currentProject.fps)) { if (firstPassDone) maskRound++; firstPassDone = false; }
  currentProject = project;
  queuedIdentity = identity;
  queuedBackend = backend;
  queuedDeviceInputs = deviceInputs(project);
  generation++;
  if (!looping) void runLoop();
}

/**
 * Card code changed while the project did not (C6.6 section 5: sync installed cards edited by someone else):
 * the source version in `cardCostKey` changes with it, but `syncProbeRun` returns early by project reference
 * and `clipIdentityOf` is memoized by project reference, so neither notices;
 * although hot updates of card modules rerun this module along the import chain, in practice it does not
 * reschedule (C6.6 probe).
 * Here we clear the identity cache and reschedule a round for the current project: cards whose identity key
 * changed and that have no record are measured under the existing rules (the dispatch table is recomputed at
 * the start of this round).
 * One batch of hot updates may send several notifications: a notification with the same identity and
 * measurement environment keeps the measurement in progress and does not increment the generation.
 * Called by `ProbeGate.tsx` after the registry's `onCardsUpdated` notification and after the stage has
 * installed the new code.
 */
export function requeueProbeRun(project: Project | null): void {
  resetClipIdentityCache();
  const identity = identitySignature(project);
  if (project === currentProject && identity === queuedIdentity && backend === queuedBackend
    && deviceInputs(project) === queuedDeviceInputs && progress.failed.length === 0) return;
  queueProbeRun(project, identity);
}

/**
 * Hook for the on-demand render gate (the online page attaches it to `online/stageGate.ts` via `Preview`):
 * leave a crash record before measuring each card and clear it afterwards; cards that crashed during
 * measurement (`skip`) are not measured again and are treated directly as heavy cards
 * (`planDispatch.setPlanForcedHeavy`). Not attached on desktop.
 */
export interface ProbeMeasureHooks {
  before?(identityKey: string, cardId: string): void;
  after?(identityKey: string): void;
  skip?(identityKey: string): boolean;
}
let measureHooks: ProbeMeasureHooks = {};
export function setProbeMeasureHooks(next: ProbeMeasureHooks | null): void {
  measureHooks = next ?? {};
}

/**
 * When the online page has two stages and the project already has cost records measured by other machines
 * (semantics `product/platforms.md`, "light/heavy classification": if records exist, bisect and measure only
 * a few cards to draw the line), opening a project first has the boundary search measure only a few cards in
 * the background stage (`Preview`'s boundary search, under the mask), and the resident probe waits for it to
 * settle:
 * - `holdProbe()`: do not start yet (called by `Preview` when a project is opened);
 * - `releaseProbe({ blocking })`: start; `blocking: false` = this round does not block the UI (the boundary
 *   search already drew the line under the mask, and the probe measures the remaining cards in the background
 *   to fill in the records that K3/K5 need; once that is done, the dispatch table switches to judging by cost
 *   records). Cards without records are still measured one by one under the mask (`blocking: true`).
 * Desktop never calls it; it stays open.
 */
let holdGate: { promise: Promise<void>; release: () => void } | null = null;
export function holdProbe(): void {
  if (holdGate) return;
  let release = () => {};
  const promise = new Promise<void>((r) => { release = r; });
  holdGate = { promise, release };
}
export function releaseProbe({ blocking = true }: { blocking?: boolean } = {}): void {
  if (!blocking) firstPassDone = true;
  const g = holdGate;
  holdGate = null;
  g?.release();
}
export function probeHeld(): boolean {
  return holdGate !== null;
}

async function runLoop(): Promise<void> {
  looping = true;
  try {
    // E1: start only once the background stage is ready (do not reach into Preview's internal stageReady)
    await whenStageReady("back");
    for (;;) {
      /*
       * Online page: wait for the first sync of card source code to finish (user cards that arrive by sync have
       * unknown ids until then and cannot be measured; `measureGate.ts`). Asked at the start of every round:
       * when the project / connection changes, the gate closes again and waits for the new project's card source
       * to sync. On desktop this gate is open from the start.
       */
      await whenMeasureGateOpen();
      while (holdGate) await holdGate.promise;
      const gen = generation;
      const project = currentProject;
      if (!project) break;

      const { costs, tuning } = await getCosts();
      const device = deviceStringOf(tuning);
      // The K2 table follows `costs` / `tuning` (setPlan of E0)
      setPlanCosts(costs, tuning);
      if (gen !== generation) continue;          // The project changed again while pulling costs: reschedule

      const jobs = planJobs(project, costs, device);
      const blocking = !firstPassDone;
      setProgress({ running: jobs.length > 0, blocking, total: jobs.length, done: 0, card: jobs[0]?.cardId ?? null, failed: [] });

      const failed: string[] = [];
      let done = 0;
      for (const job of jobs) {
        // The gate closed again during this round (connection switched): wind down, and wait for the gate at the start of the next round
        if (gen !== generation || !measureGateOpen()) break;
        setProgress({ card: job.cardId, done });
        if (measureHooks.skip?.(job.identityKey)) { done++; setProgress({ done }); continue; }
        probedLog.push({ clipId: job.clipId, cardId: job.cardId, identityKey: job.identityKey, at: Date.now() });
        if (probedLog.length > 200) probedLog.splice(0, probedLog.length - 200);
        try { measureHooks.before?.(job.identityKey, job.cardId); } catch { /* Failing to save a crash record does not block measurement */ }
        let record: CardCostRecord | null;
        try {
          record = await probeCard(job, tuning, device, () => gen !== generation);
        } finally {
          try { measureHooks.after?.(job.identityKey); } catch { /* Same as above */ }
        }
        if (gen !== generation) break;
        if (record) {
          await putCosts([record]);
          // The table follows the new record. Merge in place instead of another GET: we already have this record in hand
          mergePlanCosts([record]);
          // In a round blocked by the mask: right after this card's first pass, produce a sparse track stream for it
          // (online page; whether it is judged heavy, whether to produce it and how long to wait is up to the attached party)
          const hook = cardMeasuredHook;
          if (hook && blocking) {
            const { identityKeys } = clipIdentityOf(project);
            const clipIds = Object.keys(identityKeys).filter((id) => identityKeys[id] === job.identityKey);
            try { await hook({ project, clipIds, cardId: job.cardId, identityKey: job.identityKey, round: maskRound, stale: () => gen !== generation }); }
            catch (err) { console.warn("[probeRunner] Error in the hook after a card is measured", err); }
            if (gen !== generation) break;
          }
        } else {
          failed.push(job.cardId);
        }
        done++;
        setProgress({ done, failed: [...failed] });
      }

      if (gen !== generation || !measureGateOpen()) continue;          // Project or connection changed midway: schedule a new round from the start
      // This round is done. Only when the project really has card clips does the "first round after opening a
      // project" count as passed: an empty project / one not yet loaded does not count, otherwise the mask would
      // not appear when the real project arrives.
      if (hasCardClip(project)) firstPassDone = true;
      setProgress({ running: false, card: null });
      if (gen === generation) {
        settledGeneration = gen;
        // A zero-job pass never changes the visible progress, but preload still
        // needs to hear that its project is ready.
        setProgress({ running: false });
        break;
      }
    }
  } catch (err) {
    // A failed probe must not keep the editor stuck behind the mask: record a diagnostic and let it through
    console.error("[probeRunner] Error in this probe round", err);
    queuedIdentity = null; // Transient RPC/storage errors still allow the next notification to retry.
    settledGeneration = generation;
    setProgress({ running: false, card: null });
    firstPassDone = true;
  } finally {
    looping = false;
    // The project changed again while winding down: go on to run the next round
    if (generation !== 0 && currentProject && progress.running) void runLoop();
  }
}

/** One card: queued into the single-flight queue, retried at most a few times following the rules of E0 */
async function probeCard(job: ProbeJob, tuning: PipelineTuning, device: string, stale: () => boolean): Promise<CardCostRecord | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (stale()) return null;
    let out: Attempt;
    try {
      out = await runBackJob("probe", (ctx) => probeCardOnce(job, ctx.stage, ctx.signal, tuning, device, stale));
    } catch {
      // The iframe is being swapped / the RPC threw: swap the client and try again
      await whenStageReady("back").catch(() => undefined);
      continue;
    }
    if (out.kind === "ok") return out.record;
    if (out.kind === "fail") return null;
  }
  return null;
}

/** For tests: restore the driver to its just-loaded state */
export function resetProbeRunner(): void {
  currentProject = null;
  queuedIdentity = null;
  queuedBackend = null;
  queuedDeviceInputs = "";
  generation = 0;
  settledGeneration = 0;
  firstPassDone = false;
  holdGate = null;
  maskRound = 0;
  cardMeasuredHook = null;
  progress = IDLE;
  listeners.clear();
  probedLog.length = 0;
}
