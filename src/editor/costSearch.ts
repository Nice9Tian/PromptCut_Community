/**
 * Light/heavy classification when there is only one stage: shared cost records plus boundary search
 * (semantics `product/platforms.md`, "Online browser", "Light/heavy classification" and "On-demand
 * render gate"; `mechanism/rendering.md`, "Boundary search and cost records"; contract
 * `docs/plan/c10-contract.md`, section 3). The pure part is in `src/render/boundarySearch.mjs`; this
 * is the driver on the page side: fetch the records, measure in the only stage, hand the result to
 * dispatch (`planDispatch.setPlanSearchLight`), and write it to the document service after measuring.
 * With only one stage (the stage gate stays at the first tier, or the handshake failed and fell
 * back), the visible stage is borrowed for measuring; with two stages and records already measured by
 * other machines in the project, measuring happens in the background stage (`borrow: false`), and
 * after the line is drawn the resident probe (`probeRunner.ts`) finishes measuring the remaining
 * cards in the background without blocking the UI; with two stages and no record at all, the resident
 * probe still measures them one by one under the mask.
 *
 * # Flow
 *
 * 1. When the project opens, read all cost records of this project through the document service
 *    connection of the shared project (`listSharedCosts` in `sharedCosts.ts`), and also get the
 *    fingerprint of this machine's environment;
 * 2. Every card in the project (deduplicated by `identityKey`; user cards and media effect cards
 *    that cannot run on this page do not take part and are treated as heavy) is handed to
 *    `boundarySearch`: with records, bisection measures only a few cards; without records, they are
 *    measured one by one (`measureUnrecorded`, user decision 2026-10-07);
 * 3. Measurement is done in **its own stage**: with only one stage, no background stage is opened.
 *    During measurement it is temporarily switched to the `back` role (the probe gate of the stage
 *    only recognizes `back`), one clip at a time (a shrunk project, same as `probeRunner.ts`), only
 *    the timing pass runs, no snapshots are generated (`render(…, { probe: 'time' })`; `direct` cards
 *    run frame by frame over seeded random frames with `setTime(…, { probe: true })`), and the
 *    per-frame time is taken on the same basis as `summarizeProbe`; after measuring, it is switched
 *    back to `front`, the whole project is reloaded, and the caller (`Preview`) re-posts the picture,
 *    suppression and snapshots;
 * 4. Before measuring each card, a crash record is left via `beforeMeasure` (on-demand render gate:
 *    if measuring a card crashes the page, then after reload this card is directly treated as a heavy
 *    card), and `afterMeasure` is called after measuring;
 * 5. Results measured on this machine are stored under "card identity + this machine's environment
 *    fingerprint" through the injected `store` (`getCost` / `putCost`) and reused on the next open;
 *    those truly measured are written to the document service via `publish` (every online browser
 *    writes after measuring, user decision 2026-10-07);
 * 6. When new cards are added to the project later: those with records are classed by the existing
 *    boundary, and those without records get the few cards measured (`measureNewCards`; relevant
 *    measurements are updated as the project changes).
 *
 * # UI
 *
 * When a real measurement in the stage is needed (if local reuse hits everything, nothing is measured
 * at all), a mask identical to the desktop loading mask (`CostSearchGate`) is put up: while the stage
 * measures, the picture is switched to the shrunk project, and the mask blocks this stretch of
 * picture and editing operations (semantics `product/rendering.md`, "Measurement": measure under the
 * loading mask when the project opens; the measurement mask is the only exception to "the preview is
 * never silently transparent"). During measurement the parent page does not post snapshots, send
 * suppression, or move time (`costSearchMeasuring()`). Fetching records and classifying are both
 * fast and do not block the UI.
 */
import type { Project } from "../kernel/project";
import type { RenderAborted, RenderReply, SetTimeAborted, SetTimeReply, StageRpcClient } from "../render/stageRpc";
import { boundarySearch, classifyWithBoundary, localCostKey, maxMeasurements, type BoundaryResult, type CostStore } from "../render/boundarySearch.mjs";
import { budgetOf } from "../render/pipelinePlan.mjs";
import { PROBE_MAX_FRAMES, resolveTuning, type PipelineTuning } from "../render/pipelineTuning.mjs";
import { summarizeProbe } from "../render/probeSummary.mjs";
import { listSharedCosts, type PageEnvironment, type SharedCostInput, type SharedCostRecord } from "./sharedCosts";
import { tr } from "../i18n/index.ts";

type Request = (msg: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
type Clip = Project["tracks"][number]["clips"][number];

/* ------------------------------------------------------------------ State (the mask and the parent page's gate read it) */

export interface CostSearchState {
  /** Currently measuring in the stage (the mask is up) */
  measuring: boolean;
  /** How many cards have been truly measured in this round */
  done: number;
  /** Maximum number of cards to measure (`maxMeasurements`) */
  estimate: number;
  /** The card being measured (cardId) */
  card: string | null;
}

const IDLE: CostSearchState = { measuring: false, done: 0, estimate: 0, card: null };
let state: CostSearchState = IDLE;
const listeners = new Set<(s: CostSearchState) => void>();

function setState(patch: Partial<CostSearchState>) {
  state = { ...state, ...patch };
  for (const cb of listeners) cb(state);
}

export function costSearchState(): CostSearchState {
  return state;
}
/**
 * After the boundary search over two stages finishes, for the stretch where sparse versions are
 * produced for the measured heavy cards (`mechanism/rendering.md`, "Measurement": the online page
 * produces them in the first pass right after this card), the loading mask still blocks:
 * `holdCostSearchMask` puts it up (showing which card is being produced), `releaseCostSearchMask`
 * takes it down.
 */
export function holdCostSearchMask(card: string | null, done = 0, estimate = 0): void {
  setState({ measuring: true, card, done, estimate });
}
export function releaseCostSearchMask(): void {
  if (state.measuring) setState({ measuring: false, card: null });
}
export function onCostSearch(cb: (s: CostSearchState) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
/** The stage is currently occupied by measurement: the parent page does not post snapshots, send suppression, move time, or push the project */
export function costSearchMeasuring(): boolean {
  return state.measuring;
}

/* ------------------------------------------------------------------ Measure one card */

/** After mounting, wait for a real task boundary before starting to measure (same as `probeRunner.ts`) */
const MOUNT_SETTLE_MS = 150;
const CANVAS_WAIT_TRIES = 20;
const CANVAS_WAIT_STEP_MS = 50;
/** How many times a card is retried at most after being interrupted by a project reload (`'project'`) */
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isAborted = (r: RenderReply): r is RenderAborted => !!r && (r as { aborted?: boolean }).aborted === true;
const isSetTimeAborted = (r: SetTimeReply): r is SetTimeAborted => !!r && (r as { aborted?: boolean }).aborted === true;
const seedOf = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export interface MeasureJob {
  clipId: string;
  cardId: string;
  frameMode: string;
  canvasHeavy: boolean;
  fps: number;
  lenSec: number;
  durationFrames: number;
  project: Project;
}

/** Shrunk project: one clip per track, starting from 0 (same as `shrinkProject` in `probeRunner.ts`) */
export function shrinkProject(project: Project, track: Project["tracks"][number], clip: Clip): Project {
  return {
    ...project,
    duration: Math.max(1 / Math.max(1, project.fps || 30), clip.end - clip.start),
    media: [],
    filters: undefined,
    cardNodes: undefined,
    tracks: [{ ...track, hidden: false, clips: [{ ...clip, start: 0, end: clip.end - clip.start }] }],
  } as Project;
}

/** For each identityKey in the project, take the first clip as the measurement task */
export function measureJobsOf(project: Project, identityKeys: Record<string, string>, capabilities: ReadonlyMap<string, Record<string, unknown>>): Map<string, MeasureJob> {
  const fps = Math.max(1, project.fps || 30);
  const out = new Map<string, MeasureJob>();
  for (const track of project.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (!clip.cardId && !clip.nodeId) continue;
      const key = identityKeys[clip.id];
      if (!key || out.has(key)) continue;
      const caps = capabilities.get(clip.id) ?? {};
      const lenSec = Math.max(1 / fps, Number(clip.end) - Number(clip.start));
      out.set(key, {
        clipId: clip.id,
        cardId: clip.cardId ?? clip.nodeId ?? "?",
        frameMode: typeof caps.frameMode === "string" ? caps.frameMode : "stateful",
        canvasHeavy: caps.canvasHeavy === true,
        fps,
        lenSec,
        durationFrames: Math.max(1, Math.round(lenSec * fps)),
        project: shrinkProject(project, track, clip),
      });
    }
  }
  return out;
}

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

/**
 * In the stage (already switched to `back`), measure the live render per-frame time of one card:
 * timing only, no snapshots generated. Returns `{ stepMs, samples }`, or null if it cannot be
 * measured; returns `'retry'` if interrupted by a project reload.
 */
export async function measureOnce(
  stage: StageRpcClient,
  job: MeasureJob,
  pushProject: (project: Project) => Promise<void>,
  tuning: PipelineTuning,
): Promise<{ stepMs: number; samples: number } | null | "retry"> {
  await pushProject(job.project);
  await stage.setTime(0);
  await sleep(MOUNT_SETTLE_MS);
  if (job.canvasHeavy) await waitForCanvas(stage, job.clipId);
  const steps: number[] = [];
  let kind: "random" | "stepped";
  let totalFrames = job.durationFrames;
  let truncated = false;
  if (job.frameMode === "direct") {
    kind = "random";
    const want = Math.max(8, Math.min(tuning.STEP_MIN_SAMPLES, job.durationFrames));
    const rnd = mulberry32(seedOf(job.cardId));
    const picks = new Set<number>();
    for (let i = 0; i < want * 64 && picks.size < Math.min(want, job.durationFrames); i++) picks.add(Math.floor(rnd() * job.durationFrames));
    const frames = [...picks].sort((a, b) => a - b);
    for (const n of frames) {
      const r = await stage.setTime(n / job.fps, { probe: true });
      if (isSetTimeAborted(r)) return null;
      steps.push(Number(r.stepMs) || 0);
    }
    totalFrames = frames.length;
  } else {
    kind = "stepped";
    const lastSec = Math.max(0, job.lenSec - 1 / job.fps);
    totalFrames = Math.max(1, Math.round(lastSec * job.fps) + 1);
    const timePass = await stage.render(lastSec, { jump: true, probe: "time", maxCatchUp: Infinity, maxFrames: PROBE_MAX_FRAMES });
    if (isAborted(timePass)) {
      if (timePass.reason === "project" || timePass.reason === "superseded") return "retry";
      if (timePass.reason !== "timeout") return null;
      truncated = true; // Hit the cap: the normal path for long clips, computed from the frames already pushed
    }
    for (const s of (timePass as { steps?: number[] }).steps ?? []) steps.push(Number(s) || 0);
  }
  if (!steps.length) return null;
  const summary = summarizeProbe({ kind, steps, inline: [], raster: [], serialize: [], totalFrames, truncated }, tuning);
  return { stepMs: Number(summary.stepMs.toFixed(3)), samples: steps.length };
}

/* ------------------------------------------------------------------ One search round */

export interface CostSearchDeps {
  request: Request;
  projectId: string;
  project: Project;
  environment: PageEnvironment;
  identityKeys: Record<string, string>;
  capabilities: ReadonlyMap<string, Record<string, unknown>>;
  /** Clips that cannot run on this page (user cards that failed to load, media effect cards): they do not take part and are treated as heavy */
  unsupported: (clip: Clip) => boolean;
  /** The stage used for measuring: with only one stage it is that one (borrowed, `borrow` defaults to true); with two stages it is the background stage (`borrow: false`, no role switch, no reload, no mask over the visible stage) */
  stage: () => StageRpcClient | null;
  /** Borrow the visible stage to measure (only one stage). Pass false when measuring in the background stage with two stages */
  borrow?: boolean;
  /** Reload a whole project into this stage (`stageBridge.pushProject('front', p, { reset: true })`) */
  pushProject: (project: Project) => Promise<void>;
  /** Measurement done: called after switching back to `front`; the caller re-posts the whole project, time, suppression and snapshots */
  restore: () => Promise<void> | void;
  /** The whole project right now (used for the reload after measuring) */
  currentProject: () => Project;
  store: CostStore;
  tuning?: PipelineTuning;
  mode?: "dev" | "build";
  /** Before measuring this card (the on-demand render gate leaves a crash record); `key` is the identityKey */
  beforeMeasure?: (key: string, cardId: string) => void;
  /** This card is done measuring (whether or not a result was obtained) */
  afterMeasure?: (key: string) => void;
  /** Write truly measured records to the document service (every online browser writes after measuring); a failure does not affect classification */
  publish?: (records: SharedCostInput[]) => Promise<unknown> | void;
}

export interface CostSearchOutcome {
  result: BoundaryResult;
  records: SharedCostRecord[];
  envFingerprint: string;
  /** Cards that take part in the search (identityKey) */
  keys: string[];
  /** User cards and media effect cards that cannot run on this page (identityKey): treated as heavy */
  forcedHeavy: string[];
  /** Cards classed light (identityKey), handed to `setPlanSearchLight` */
  light: Set<string>;
  elapsedMs: number;
}

/** Cards in the project to classify: those taking part in the search plus those this device cannot render (both deduplicated by identityKey) */
export function keysOf(project: Project, identityKeys: Record<string, string>, unsupported: (clip: Clip) => boolean): { keys: string[]; forcedHeavy: string[] } {
  const keys = new Set<string>();
  const forced = new Set<string>();
  for (const track of project.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (!clip.cardId && !clip.nodeId) continue;
      const key = identityKeys[clip.id];
      if (!key) continue;
      (unsupported(clip) ? forced : keys).add(key);
    }
  }
  for (const k of forced) keys.delete(k);
  return { keys: [...keys].sort(), forcedHeavy: [...forced].sort() };
}

/**
 * Run one round of boundary search. Throws if the records cannot be fetched (not connected, rejected),
 * and the caller retries later; a stage error during measurement counts as that card being unable to run.
 */
export async function runCostSearch(deps: CostSearchDeps): Promise<CostSearchOutcome> {
  const started = Date.now();
  const tuning = resolveTuning(deps.tuning ?? null);
  const { records, envFingerprint } = await listSharedCosts({ request: deps.request, projectId: deps.projectId, environment: deps.environment });
  const { keys, forcedHeavy } = keysOf(deps.project, deps.identityKeys, deps.unsupported);
  const jobs = measureJobsOf(deps.project, deps.identityKeys, deps.capabilities);
  const fps = Math.max(1, deps.project.fps || 30);
  const withRecords = new Set(records.map((r) => r.identityKey));
  const estimate = maxMeasurements(keys.filter((k) => withRecords.has(k)).length) + keys.filter((k) => !withRecords.has(k)).length;

  const lease = createLease(deps, estimate, jobs, tuning);
  let result: BoundaryResult;
  try {
    result = await boundarySearch({
      keys, records, budgetMs: budgetOf(fps), measure: lease.measure, store: deps.store, envFingerprint,
      scale: tuning.COST_SCALE, mode: deps.mode ?? "build", measureUnrecorded: true,
    });
  } finally {
    await lease.end();
  }
  await publishMeasured(deps, lease.fresh);
  const light = new Set(result.light);
  for (const k of forcedHeavy) light.delete(k);
  return { result, records, envFingerprint, keys, forcedHeavy, light, elapsedMs: Date.now() - started };
}

/**
 * Borrow the only stage to measure: the first time a real measurement is needed, switch it to `back`
 * and put up the mask; `end` switches back to `front`, reloads the whole project, and takes down the mask.
 * `fresh` collects what was truly measured in this round (excluding local reuse hits), and it is
 * written to the document service after measuring.
 */
function createLease(deps: CostSearchDeps, estimate: number, jobs: Map<string, MeasureJob>, tuning: PipelineTuning) {
  let leased: StageRpcClient | null = null;
  let done = 0;
  const fresh: SharedCostInput[] = [];
  const measure = async (key: string): Promise<{ stepMs: number; samples: number } | null> => {
    const job = jobs.get(key);
    const stage = deps.stage();
    if (!job || !stage) return null;
    if (!leased) {
      setState({ measuring: true, done: 0, estimate, card: job.cardId });
      if (deps.borrow !== false) { try { await stage.setRole("back", { job: "probe" }); } catch { return null; } }
      leased = stage;
    }
    setState({ card: job.cardId, done });
    try { deps.beforeMeasure?.(key, job.cardId); } catch { /* Failing to save a crash record does not block measurement */ }
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const r = await measureOnce(stage, job, deps.pushProject, tuning);
        if (r === "retry") continue;
        if (r) fresh.push({ identityKey: key, stepMs: r.stepMs, samples: r.samples, measuredAt: Date.now(), mode: deps.mode ?? "build" });
        return r;
      }
      return null;
    } catch {
      return null;
    } finally {
      try { deps.afterMeasure?.(key); } catch { /* Same as above */ }
      done++;
      setState({ done });
    }
  };
  const end = async () => {
    if (!leased) return;
    const stage: StageRpcClient = leased;
    leased = null;
    if (deps.borrow === false) { setState({ measuring: false, card: null }); return; }
    try { await stage.setRole("front"); } catch { /* The iframe was replaced: the new handshake will reset the role */ }
    try { await deps.pushProject(deps.currentProject()); } catch { /* Same as above */ }
    setState({ measuring: false, card: null });
    try { await deps.restore(); } catch { /* The caller handles it itself */ }
  };
  return { measure, end, fresh };
}

async function publishMeasured(deps: CostSearchDeps, fresh: SharedCostInput[]): Promise<void> {
  if (!fresh.length || !deps.publish) return;
  try { await deps.publish(fresh); } catch { /* A failed write does not affect classification; write again at the next measurement */ }
}

/**
 * New cards were added to the project after the search finished: those with no shared cost record
 * that were also never measured on this machine get measured (relevant measurements are updated as
 * the project changes; those with records are classed by the existing boundary, not measured).
 * Returns the result after the extra measuring (`result.measured` now includes these cards); returns
 * it unchanged if nothing needs measuring. During measurement it likewise borrows the stage, puts up
 * the mask, and leaves crash records.
 */
export async function measureNewCards(outcome: CostSearchOutcome, deps: Omit<CostSearchDeps, "request" | "projectId" | "environment">): Promise<CostSearchOutcome> {
  const { keys, forcedHeavy } = keysOf(deps.project, deps.identityKeys, deps.unsupported);
  const withRecords = new Set(outcome.records.map((r) => r.identityKey));
  const todo = keys.filter((k) => !withRecords.has(k) && !outcome.result.measured.has(k));
  if (!todo.length) return outcome;
  const tuning = resolveTuning(deps.tuning ?? null);
  const jobs = measureJobsOf(deps.project, deps.identityKeys, deps.capabilities);
  const lease = createLease(deps as CostSearchDeps, todo.length, jobs, tuning);
  const measured = new Map(outcome.result.measured);
  try {
    for (const key of todo) {
      const local = await (async () => { try { return await deps.store.getCost(localCostKey(key, outcome.envFingerprint)); } catch { return undefined; } })() as { stepMs?: unknown } | undefined;
      if (local && typeof local.stepMs === "number" && Number.isFinite(local.stepMs)) { measured.set(key, { ms: local.stepMs, cached: true, failed: false }); continue; }
      const r = await lease.measure(key);
      const ok = !!r && Number.isFinite(r.stepMs) && r.stepMs >= 0;
      measured.set(key, { ms: ok ? r!.stepMs : Infinity, cached: false, failed: !ok });
      if (ok) {
        try { await deps.store.putCost(localCostKey(key, outcome.envFingerprint), { identityKey: key, envFingerprint: outcome.envFingerprint, stepMs: r!.stepMs, samples: r!.samples, measuredAt: Date.now(), mode: deps.mode ?? "build" }); } catch { /* If it cannot be stored, measure again next time */ }
      }
    }
  } finally {
    await lease.end();
  }
  await publishMeasured(deps as CostSearchDeps, lease.fresh);
  const result = { ...outcome.result, measured };
  const light = classifyWithBoundary(result, keys, outcome.records).light;
  for (const k of forcedHeavy) light.delete(k);
  return { ...outcome, result, keys, forcedHeavy, light };
}

/**
 * The project changed again after the search finished (cards added, parameters changed): classify by
 * the existing boundary (`classifyWithBoundary`; new cards with no record and no measurement are
 * measured first by `measureNewCards`). Returns the identityKeys classed light.
 */
export function reclassify(outcome: CostSearchOutcome, project: Project, identityKeys: Record<string, string>, unsupported: (clip: Clip) => boolean): Set<string> {
  const { keys } = keysOf(project, identityKeys, unsupported);
  return classifyWithBoundary(outcome.result, keys, outcome.records).light;
}

/* ------------------------------------------------------------------ Baseline card (criterion for the "lowest tier" of the on-demand render gate) */

/**
 * Baseline card [ruling]: the built-in "punch pill" (`punch-pill`, a one-line capsule that pops in,
 * a DOM card, written with `motion`, with one blurred glow layer), default parameters, 2 seconds.
 * Semantics `product/platforms.md`, "Lowest tier": a device that cannot even run the simplest
 * baseline card goes to the lowest tier. The line for "cannot run" uses the same formula as the
 * heavy classification (per-frame time × cost multiplier > budget B, `budgetOf` in
 * `pipelinePlan.mjs`): if this device classes even this card as heavy, other cards are all the more so.
 */
export const BENCHMARK_CARD_ID = "punch-pill";
export const BENCHMARK_SECONDS = 2;
export const BENCHMARK_FPS = 30;

/** The shrunk project and measurement task of the baseline card */
export function benchmarkJob(): MeasureJob {
  const fps = BENCHMARK_FPS;
  const clip = { id: "pc-benchmark-clip", cardId: BENCHMARK_CARD_ID, start: 0, end: BENCHMARK_SECONDS, params: {} } as unknown as Clip;
  const project = {
    version: 1, id: "pc-benchmark", name: tr("Baseline card"), width: 1920, height: 1080, fps, duration: BENCHMARK_SECONDS, themeId: "midnight", media: [],
    tracks: [{ id: "pc-benchmark-track", name: "Baseline", clips: [clip] }],
  } as unknown as Project;
  return { clipId: clip.id, cardId: BENCHMARK_CARD_ID, frameMode: "stateful", canvasHeavy: false, fps, lenSec: BENCHMARK_SECONDS, durationFrames: BENCHMARK_SECONDS * fps, project };
}

export interface BenchmarkOutcome {
  /** `ok` can run, `slow` cannot run (goes to the lowest tier), `unknown` was not measured (the stage is switching, interrupted): does not count as unable to run */
  verdict: "ok" | "slow" | "unknown";
  stepMs: number | null;
  budgetMs: number;
  scale: number;
}

/** Judged from the per-frame time: per-frame time × cost multiplier > budget B means it cannot run */
export function benchmarkVerdict(stepMs: number | null, tuning: PipelineTuning = resolveTuning(null)): BenchmarkOutcome {
  const budgetMs = budgetOf(BENCHMARK_FPS);
  const scale = tuning.COST_SCALE;
  if (stepMs === null || !Number.isFinite(stepMs)) return { verdict: "unknown", stepMs: null, budgetMs, scale };
  return { verdict: stepMs * scale > budgetMs ? "slow" : "ok", stepMs, budgetMs, scale };
}

/**
 * Measure the baseline card in one stage. When `borrow` is true (only one stage): borrow the visible
 * stage, switch back after measuring, reload the whole project, `restore` (same as boundary search);
 * when false (there is a background stage): the caller supplies `stage` and `pushProject` in the
 * background stage's single-flight queue. Before and after measuring, a crash record is left via
 * `beforeMeasure` / `afterMeasure`.
 */
export async function runBenchmark(deps: Pick<CostSearchDeps, "stage" | "pushProject" | "restore" | "currentProject" | "beforeMeasure" | "afterMeasure" | "tuning"> & { borrow: boolean }): Promise<BenchmarkOutcome> {
  const tuning = resolveTuning(deps.tuning ?? null);
  const job = benchmarkJob();
  const key = "@benchmark";
  if (deps.borrow) {
    const lease = createLease({ ...deps, mode: "build" } as unknown as CostSearchDeps, 1, new Map([[key, job]]), tuning);
    let r: { stepMs: number } | null = null;
    try { r = await lease.measure(key); } finally { await lease.end(); }
    return benchmarkVerdict(r?.stepMs ?? null, tuning);
  }
  const stage = deps.stage();
  if (!stage) return benchmarkVerdict(null, tuning);
  try { deps.beforeMeasure?.(key, BENCHMARK_CARD_ID); } catch { /* Failing to save does not block */ }
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await measureOnce(stage, job, deps.pushProject, tuning);
      if (r === "retry") continue;
      return benchmarkVerdict(r?.stepMs ?? null, tuning);
    }
    return benchmarkVerdict(null, tuning);
  } catch {
    return benchmarkVerdict(null, tuning);
  } finally {
    try { deps.afterMeasure?.(key); } catch { /* Same as above */ }
  }
}

/** For tests */
export function resetCostSearch(): void {
  state = IDLE;
  listeners.clear();
}
