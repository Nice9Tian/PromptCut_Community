/**
 * K2 dispatch table delivery (E0's `setPlan`).
 *
 * Whenever `costs`, the project or `tuning` changes, the parent page recomputes a table with
 * `planPipelines` (together with `clipCostIndex`) and sends `{ plan, costs }` to `front`. **Sets are
 * serialized as arrays on the wire** (`wirePlan.ts`); the stage turns them back into `Set`s on
 * receipt and provides the `pipelineAt` lookup.
 *
 * **The two sides do not exchange tables, they only sync `costs`** (last item of K2): the prerender
 * process computes the table itself from the same `planPipelines`, the same `costs` and the same
 * `tuning`, and the results are identical field by field. It is sent to the stage here because **the
 * stage does not pull `costs`** (it is cross-origin and only talks over RPC), not because the two
 * sides need to reconcile tables.
 *
 * # Resend on role promotion
 *
 * K5 (5) / K3(b) (5): after `setRole('front')` the parent page must send a `setPlan` **first**, in
 * the same batch, because the new `front` had no table while it was `back`. That send is
 * `sendPlanTo('front')`, which R5 calls directly.
 *
 * # Who feeds it
 *
 * - Project: `ProbeGate` calls `setPlanProject(project)` in an effect;
 * - `costs` / `tuning`: the copy `probeRunner` fetches at the start of each round, plus one record
 *   merged in after each record is written (another GET would cost every card an extra round trip,
 *   and we already hold the record).
 */
import { flatPlanProject } from "../kernel/cutFlatten.mjs";
import { activeCutKind } from "../kernel/camera.mjs";
import type { Project } from "../kernel/project";
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import { clipWeight, planPipelines, type PipelinePlan } from "../render/pipelinePlan.mjs";
import { resolveTuning, type PipelineTuning } from "../render/pipelineTuning.mjs";
import type { StageRole } from "../render/stageRpc";
import { wirePlan } from "../render/wirePlan";
import { clipIdentityOf } from "./costIdentity";
import { frontStage, backStage } from "./stageBridge";
import { onCardRunStatesChanged, onCardsUpdated, onSyncedUserCardsChanged, unknownCardClipIds } from "../kernel/registry";

let project: Project | null = null;
let costs: CardCostRecord[] = [];
let tuning: PipelineTuning = resolveTuning(null);
let plan: PipelinePlan | null = null;
/**
 * The two switches of the online page (semantics `product/platforms.md` "Online browser"; both are always off on desktop, and the two tables are the same one):
 * - **Judge by boundary search** (`search`): with only one stage there is no background stage to measure card by card, so light/heavy follows the boundary search result (`searchLight`,
 *   `src/editor/costSearch.ts`). Until the search finishes, `searchLight` is null: there is no result, the manifest plan is not sent, and everything in the judged table counts as heavy.
 * - **Lowest tier** (`lowest`): in the **display table** (`currentPlan`, sent to the stage and used by `snapshotFeed` for suppression and frame selection) every card is judged heavy at every position,
 *   with no on-demand render during playback, including cards that would be judged light (with no prerender output it is a placeholder, drawn layer by layer when playback stops).
 * The **judged table** (`judgedPlan`) decides which clips the manifest plan sends and which ones this machine renders frame by frame on export: with boundary-search judging it follows `searchLight`, otherwise the cost records.
 */
let search = false;
let lowest = false;
/** identityKey of the cards the boundary search judged light; null = no result yet */
let searchLight: ReadonlySet<string> | null = null;
/**
 * On-demand render gate: a card whose measurement crashed the page (the crashed-while-measured card in the crash record, `online/stageGate.ts`) is treated as a heavy card right away and not measured again
 * (semantics `product/platforms.md` "On-demand render gate": a card whose measurement crashed the page is treated as a heavy card after reload).
 */
let forcedHeavy: ReadonlySet<string> = new Set();
let judged: PipelinePlan | null = null;
/** Whether the 3D view is on (when on, standalone light cards are also included in prerenderSet, the set of per-card track streams to prerender) */
let view3d = false;
/**
 * L4 (online page, C10 contract section 6, item 1 of section 18): at dispatch time, the fixed per-beat cost of each heavy card is replaced with the measured frame-swap cost `swapMs`
 * (`opts.deadMs` of `planPipelines`), the same number as `fitBeatSwaps` in `beatSwap.mjs` uses during playback. null = desktop `DEAD_MS`.
 */
let deadMs: number | null = null;
/** Frame-swap cost of each heavy card (provided by the host: `layerSwapMs` in `swapCost.ts`, per card kind); null = `deadMs` for every card */
let deadMsOf: ((project: Project, clipId: string) => number) | null = null;
/** Serialized form of the table that was actually sent last time, used to skip resending when nothing changed */
let sentWire = "";
let lastNotifiedWire = "";
let scheduled = false;
const planListeners = new Set<() => void>();

/** Notified after the dispatch table or cost records are recomputed and the content changed (Preview uses it while paused to resend the stream plane / suppression and resettle the current frame) */
export function onPlanUpdated(cb: () => void): () => void {
  planListeners.add(cb);
  return () => { planListeners.delete(cb); };
}

/** The dispatch table computed at this moment (for R5 / acceptance probes). In the lowest tier it is the display table (everything judged heavy); for judging, see `judgedPlan` */
export function currentPlan(): PipelinePlan | null {
  return plan;
}

/** The table for the light/heavy judgment: the same table as `currentPlan` when not in the lowest tier; with boundary-search judging it follows that result (everything is judged heavy while there is no result) */
export function judgedPlan(): PipelinePlan | null {
  return judged;
}

export function currentCosts(): CardCostRecord[] {
  return costs;
}

/** The tunable coefficients in effect at this moment (the stage gets the same copy through `setPlan`, so K3 / K5 tiering must agree) */
export function currentTuning(): PipelineTuning {
  return tuning;
}

/** 3D view on / off. When on, standalone light cards are also included in prerenderSet, so the 3D board can attach track streams */
export function setPlan3DView(on: boolean): void {
  if (view3d === !!on) return;
  view3d = !!on;
  schedule();
}

/** Whether 3D mode is on at this moment */
export function plan3DView(): boolean {
  return view3d;
}

function recompute(): void {
  if (!project) {
    plan = null;
    judged = null;
    return;
  }
  const { identityKeys, frameModes } = clipIdentityOf(project);
  const fps = Math.max(1, project.fps || 30);
  const at = project;
  const of = deadMsOf;
  const dead = deadMs !== null ? { deadMs: of ? (clipId: string) => of(at, clipId) : deadMs } : {};
  /*
   * Card clips defined on neither side (unknown cards) are not drawn by the stage: they are not treated as heavy cards and do not enter the prerender set (same on desktop and online; `knownCardsOnly`).
   * Without removing them, they have no identity and no cost record, so they would fall back to heavy by declaration and enter the manifest plan.
   */
  // Replace each cut segment with the cards inside it (`kernel/cutFlatten.mjs`): cards in a cut segment are dispatched together with the cards on the parent timeline. Unchanged when there are no cut segments
  const planned = knownCardsOnly(flatPlanProject(project));
  const cutKind = activeCutKind(project);
  const opts3D = {
    cutKind,
    ...(view3d || cutKind === "3d" ? { includeLightCardsFor3D: true } : {}),
    ...(view3d ? { view3d: true } : {}),
  };
  const light = searchLight && forcedHeavy.size ? [...searchLight].filter((k) => !forcedHeavy.has(k)) : searchLight;
  const judge = search ? { searchLight: light ?? [] } : {};
  const planCosts = forcedHeavy.size ? withForcedHeavy(costs, forcedHeavy) : costs;
  judged = planPipelines(planned, planCosts, fps, { tuning, identityKeys, frameModes, ...judge, ...opts3D, ...dead });
  plan = lowest ? planPipelines(planned, planCosts, fps, { tuning, identityKeys, frameModes, allHeavy: true, ...opts3D, ...dead }) : judged;
}

/** Pin cards whose measurement crashed as heavy (`pinnedHeavy`, which `clipWeight` in `pipelinePlan.mjs` honors); for those with no record, add one that carries only the identity */
function withForcedHeavy(list: CardCostRecord[], keys: ReadonlySet<string>): CardCostRecord[] {
  const seen = new Set<string>();
  const out = list.map((r) => {
    if (!keys.has(r.identityKey)) return r;
    seen.add(r.identityKey);
    return { ...r, pinnedHeavy: true } as CardCostRecord;
  });
  for (const k of keys) if (!seen.has(k)) out.push({ identityKey: k, pinnedHeavy: true } as unknown as CardCostRecord);
  return out;
}

/** Cards whose measurement crashed (identityKey): treated as heavy cards directly. The same set is not recomputed */
export function setPlanForcedHeavy(keys: Iterable<string>): void {
  const next = new Set(keys);
  if (next.size === forcedHeavy.size && [...next].every((k) => forcedHeavy.has(k))) return;
  forcedHeavy = next;
  schedule();
}

/** The project with unknown card clips removed (only for `planPipelines` to see; returns the same object unchanged when there are no unknown cards) */
export function knownCardsOnly(p: Project): Project {
  const unknown = unknownCardClipIds(p.tracks.flatMap((tr) => tr.clips));
  if (!unknown.size) return p;
  return { ...p, tracks: p.tracks.map((tr) => ({ ...tr, clips: tr.clips.filter((c) => !unknown.has(c.id)) })) };
}

/**
 * Send the table to a given role. **Resend on role promotion** goes through it (K5 (5) / K3(b) (5)).
 * Returns whether it was actually sent (false if the stage is not ready yet, or the table did not change).
 */
export async function sendPlanTo(role: StageRole, opts: { force?: boolean } = {}): Promise<boolean> {
  if (!plan) return false;
  const stage = role === "front" ? frontStage() : backStage();
  if (!stage || stage.disposed) return false;
  // clipId → identityKey / frameMode are sent along together: the stage looks up vtOk / seekOk by clipId (K3 / K5)
  const wire = wirePlan(plan, clipIdentityOf(project), tuning);
  const serialized = JSON.stringify({ wire, costs });
  // A resend (force) always sends: a new front that was back has no table, so "same as last time" does not hold for it
  if (!opts.force && role === "front" && serialized === sentWire) return false;
  try {
    await stage.setPlan({ plan: wire, costs });
    if (role === "front") sentWire = serialized;
    return true;
  } catch {
    // The iframe is being swapped: the next change will resend, and R5 calls again itself for the role promotion send
    return false;
  }
}

/** Batch for one beat, then compute and send: one probe round writes 20 records in a row, and the table should not be computed 20 times */
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    recompute();
    const wire = plan && project ? JSON.stringify({ wire: wirePlan(plan, clipIdentityOf(project), tuning), costs }) : "";
    const changed = wire !== lastNotifiedWire;
    lastNotifiedWire = wire;
    void sendPlanTo("front");
    if (changed) {
      for (const cb of [...planListeners]) {
        try { cb(); } catch { /* A subscriber error does not affect dispatch */ }
      }
    }
  });
}

/*
 * The synced user card table changed in online browser mode (C10 contract section 9): which clips this machine cannot run changes with it, and they all count as heavy cards (`costIdentity.ts`
 * gives them no identity), so recompute and resend once. Desktop has no such table and never triggers this.
 */
onSyncedUserCardsChanged(() => schedule());
/*
 * The run state of synced cards changed (load success, failure, generation change; `docs/plan/online-card-exec-contract.md` sections 6 and 8): cards this page can run get an identity and are
 * judged light or heavy by the cost records, and those that cannot run go back to being all heavy, so recompute and resend once. Desktop has no run state and never triggers this.
 */
onCardRunStatesChanged(() => schedule());
/* Card code changed (hot update installed a new card): a previously unknown card may now be recognized and must re-enter the table */
onCardsUpdated(() => schedule());

/** The project changed (called from the effect in `ProbeGate`). Does nothing if the reference did not change */
export function setPlanProject(next: Project | null): void {
  if (next === project) return;
  project = next;
  schedule();
}

/** The whole `costs` / `tuning` was replaced (the copy the probe gets from `GET /api/data/costs` at the start of each round) */
export function setPlanCosts(nextCosts: CardCostRecord[], nextTuning: PipelineTuning): void {
  costs = [...nextCosts];
  tuning = resolveTuning(nextTuning);
  schedule();
}

/**
 * Merge the records just written into the copy in hand, in place (deduplicated by `(identityKey, device)`,
 * the same key as the upsert in `costs-store.mjs`). Saves one GET per card.
 */
export function mergePlanCosts(records: readonly CardCostRecord[]): void {
  if (!records.length) return;
  const keyOf = (r: CardCostRecord) => `${r.identityKey} ${r.device}`;
  const byKey = new Map(costs.map((r) => [keyOf(r), r]));
  for (const r of records) byKey.set(keyOf(r), r);
  costs = [...byKey.values()];
  schedule();
}

/** Judge light/heavy by boundary search (turned on by `Preview` when there is only one stage). Recompute and resend only on change; when turned off, the search result is dropped */
export function setPlanSearch(on: boolean): void {
  if (search === !!on) return;
  search = !!on;
  if (!search) searchLight = null;
  schedule();
}

/** Whether light/heavy is being judged by boundary search at this moment */
export function planSearch(): boolean {
  return search;
}

/** Lowest tier on / off (the display table is judged all heavy). Recompute and resend only on change */
export function setPlanLowest(on: boolean): void {
  if (lowest === !!on) return;
  lowest = !!on;
  schedule();
}

/** Whether the lowest tier is on at this moment (the display table is judged all heavy) */
export function planLowest(): boolean {
  return lowest;
}

/**
 * Boundary search result: identityKey of the cards judged light (`null` = withdraw the result, and judging goes back to everything heavy). The same set is not recomputed.
 * The table is recomputed synchronously (no beat batching): the manifest plan and export need the judged table right after getting the result.
 */
export function setPlanSearchLight(keys: Iterable<string> | null): void {
  const next = keys === null ? null : new Set(keys);
  const same = next === null ? searchLight === null
    : searchLight !== null && next.size === searchLight.size && [...next].every((k) => searchLight!.has(k));
  if (same) return;
  searchLight = next;
  recompute();
  schedule();
}

/** Whether there is a result when judging light/heavy by boundary search (the search finished); always true when not judging by it */
export function searchJudged(): boolean {
  return !search || searchLight !== null;
}

/** Cards the boundary search judged light (for diagnostics and probes) */
export function planSearchLight(): ReadonlySet<string> | null {
  return searchLight;
}

/**
 * L4: the online page replaces the per-beat heavy card cost of dispatch with the measured frame-swap cost (`null` goes back to desktop `DEAD_MS`). Recompute and resend only on change.
 * If `of` is given, each clip takes its own (per card kind, the same number as the per-layer cost of `fitBeatSwaps` during playback); `ms` is only a fallback when it cannot give one.
 */
export function setPlanDeadMs(ms: number | null, of: ((project: Project, clipId: string) => number) | null = null): void {
  const next = ms !== null && Number.isFinite(ms) && ms >= 0 ? ms : null;
  const nextOf = next !== null ? of : null;
  if (next === deadMs && nextOf === deadMsOf) return;
  deadMs = next;
  deadMsOf = nextOf;
  schedule();
}

/**
 * How many milliseconds per beat the live-rendered cards in the light pipeline take at this moment (the "already used" of item 1 of C10 contract section 18): the sum of
 * `clipWeight(...).w` over every card in the `light` set at the current position, on the same basis as the greedy pass of `planPipelines`. Returns 0 when not at any position (no table, or in a gap).
 */
export function lightCostAt(t: number): number {
  if (!plan || !project) return 0;
  const seg = plan.segments.find((s) => t >= s.fromSec && t < s.toSec);
  if (!seg || !seg.light.size) return 0;
  const fps = Math.max(1, project.fps || 30);
  const { identityKeys, frameModes } = clipIdentityOf(project);
  const byKey = new Map(costs.map((r) => [r.identityKey, r]));
  let sum = 0;
  for (const clipId of seg.light) {
    const key = identityKeys[clipId];
    const w = clipWeight(key ? byKey.get(key) : undefined, frameModes[clipId], fps, tuning).w;
    if (Number.isFinite(w)) sum += w;
  }
  return sum;
}

/** For tests */
export function resetPlanDispatch(): void {
  search = false;
  lowest = false;
  view3d = false;
  searchLight = null;
  forcedHeavy = new Set();
  judged = null;
  deadMs = null;
  deadMsOf = null;
  project = null;
  costs = [];
  tuning = resolveTuning(null);
  plan = null;
  sentWire = "";
  lastNotifiedWire = "";
  scheduled = false;
}
