/**
 * K5 second path: after a full-scene catch-up run in the background, cards with `vtOk = false`
 * (Motion's JS-driven animations) **swap roles**.
 *
 * Why it has to be the whole scene: `advanceToAsync` changes the module-level `now`, and the `sync`
 * of `pinAnimations` pins every animation, while the JS animations of these cards only follow the
 * global frame timestamp. A single card cannot be advanced with subtree virtual time (that is exactly
 * what `vtOk` tests), so the background stage has to run the whole show from the earliest
 * `mountFrameOf` up to `t`, and then the identities of the two iframes are exchanged.
 *
 * # Order (E0 / K5, no step may be skipped)
 *
 *  1. `setRole('back', { job: 'catchup' })` (through the single-flight queue of `stageJobs`:
 *     **catch-up run > page-side measurement > probe**, so queuing it makes the probe yield) →
 *     `pushProject('back', current project, { reset: true })`
 *     (the probe may have replaced the background stage with a shrunken project, and sending
 *     `setProject` directly would bypass the baseline of `stageBridge`);
 *  2. `render(t, { jump: true, maxCatchUp: Infinity })` (without `maxCatchUp`,
 *     `DEFAULT_MAX_CATCH_UP = 6000` would cut off the start);
 *  3. `setMediaT(t)`, wait for `{ type: 'mediaReady' }` for at most 300 ms, and swap anyway on timeout;
 *  4. **Swap**: first exchange the visibility of the two iframes in one React commit (the parent
 *     page's "current front" pointer switches at the same moment), **then** `oldFront.setRole('back')`
 *     and wait for the reply, **finally** `back.setRole('front')`;
 *  5. Re-send to the new `front`: `setPlan` (it had no table while it was `back`) / `setLocalHashes` /
 *     `setSnapshots(new Map(), { reset: true })` / `setPlaying(false)` / `setScrubbing(false)` /
 *     `setProxy`;
 *  6. The new `front` posts `{ type: 'settled', sec, clipIds: [] }` (done on the stage side inside
 *     `setRole('front')`).
 *
 * # Swap while playing (K3(b))
 *
 * The target is not `store.t` but the **target tick `T`** (= `store.t` + estimated catch-up duration,
 * rounded to the tick grid; the estimate is computed from the playback position, see
 * `guessCatchUpMs`): the arguments of (1)(2)(3) are all `T` (using `store.t` would make the `mediaT`
 * of the new `front` off by about one second after the swap and force a hard seek). After the
 * catch-up, send `pause({ atSec: T })` to the old `front` to **arm the stop**, and when
 * `frame.sec === T` arrives (compared by tick index, not by float) do (4)(5), with the end of (5)
 * changed to `play(T)` + `setPlaying(true)`. If the visible stage already reached `T` (replies
 * `passed`), take `T' = store.t + last estimate × 2`, continue pushing `back` (without `jump`) and
 * arm again; if it still cannot catch up after two tries, downgrade per K6.
 *
 * Only initiated for cards that **start playing from the middle of the card**: cards that walk
 * through the mount frame tick by tick during this round of playback and enter naturally do not
 * initiate (`playingSwapTargets`, rules in `src/render/playEntry.mjs`).
 */
import { getState } from "../store/project";
import { flattenOverlay, type Project } from "../kernel/project";
import { cutOf } from "../kernel/cutSegments";
import { flatPlanProject, isFlatClipId } from "../kernel/cutFlatten.mjs";
import { cardMountedAt, mountFrameOf } from "../render/frameWindow.mjs";
import { createPlayRun, enteredNaturally, notePlayBeat, notePlaySeam, notePlayStart } from "../render/playEntry.mjs";
import { catchUpEstimateMs, playingLeadMs, sceneCatchUpCost } from "../render/catchUpEstimate.mjs";
import { clipWeight, pipelineAt } from "../render/pipelinePlan.mjs";
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import type { StageEvent, StageRpcClient } from "../render/stageRpc";
import { backStage, frontStage, onStageEvent, pushProject, syncProject } from "./stageBridge";
import { runBackJob } from "./stageJobs";
import { currentCosts, currentPlan, currentTuning, sendPlanTo } from "./planDispatch";
import { clipIdentityOf } from "./costIdentity";
import { clearSettled, markAllSettled, markBaselineReset, setExtraSuppressed, streamPlanesAt, suppressedAt } from "./snapshotFeed";
import { onStageDemote } from "./demote";

/** K5 (3): wait for the media layer of the background stage to draw a frame, at most this long (real wall clock); swap anyway on timeout */
export const MEDIA_READY_TIMEOUT_MS = 300;
/** K3(b): estimated catch-up duration when there is no `catchUpMs` */
export const DEFAULT_CATCHUP_GUESS_MS = 1000;
/** K3(b): fallback while the armed stop waits for `frame(T)` */
export const ARM_WAIT_TIMEOUT_MS = 5000;

export interface SwapHost {
  /**
   * Switch "which one is the visible stage" to the other iframe: exchange visibility in one React
   * commit and re-register the two roles in `stageBridge`. Returns the two clients after the swap.
   *
   * The background iframe may only be hidden with `opacity: 0; pointer-events: none`, **never
   * `display: none` / `visibility: hidden`**: once the whole OOPIF leaves the render tree,
   * `requestVideoFrameCallback` no longer fires, and the `mediaReady` of step (3) can only wait until
   * timeout.
   */
  swapRoles(): { front: StageRpcClient | null; back: StageRpcClient | null } | null;
  /** Current entity mode (must be re-sent to the new `front` after the swap, since it was the default value while it was `back`) */
  proxy(): boolean;
  /** Local asset hash table of A1 */
  localHashes(): string[];
  /**
   * Only one stage (tier 1 of the online page stage gate, the lowest tier, fallback after a failed
   * handshake): there is no background stage, so the paths that pause, catch up to live render and then
   * swap are never taken. On stop, the visible stage catches up one frame layer by layer
   * (`settleLayers`). Not given = two stages.
   */
  singleStage?(): boolean;
}

/** Diagnostics: results of the last few paused-state second paths (for the probe) */
const swapLog: { at: number; t: number; stale: number; ready: boolean; swapped: boolean; error?: string }[] = [];
export function stageSwapDebug() {
  return swapLog.slice();
}
/** Diagnostics: for each paused-state second path, the reason it entered, the criteria and the reason it left (C10-A4 troubleshooting; for the probe) */
const swapTrace: Record<string, unknown>[] = [];
function trace(entry: Record<string, unknown>): void {
  swapTrace.push({ at: Math.round(performance.now()), ...entry });
  if (swapTrace.length > 40) swapTrace.shift();
}
export function stageSwapTrace() {
  return swapTrace.slice();
}
/** Diagnostics: per card, explains why `staleOnBackCatchUp` accepts or rejects it */
export function staleExplain(project: Project, t: number): Record<string, unknown>[] {
  const plan = currentPlan();
  const fps = Math.max(1, project.fps || 30);
  const { identityKeys, frameModes } = clipIdentityOf(project);
  return activeCardClips(project, t).map((clip) => {
    const record = recordOf(project, clip.id);
    let tier: string | undefined;
    try { if (record) tier = clipWeight(record, frameModes[clip.id], fps, currentTuning()).tier; } catch { tier = "error"; }
    return { id: clip.id.slice(0, 8), pipeline: pipelineAt(plan, clip.id, t) ?? null, key: identityKeys[clip.id]?.slice(0, 10) ?? null, record: !!record, vtOk: record?.vtOk, tier };
  });
}

/** Whether there is only one stage right now (the host decides; no host = two stages) */
export function swapBlockedBySingleStage(): boolean {
  try { return host?.singleStage?.() === true; } catch { return false; }
}

let host: SwapHost | null = null;
export function setSwapHost(next: SwapHost | null): void {
  host = next;
}

/** The run currently in progress (only one at a time: there is only one background stage) */
let running = false;
/** Diagnostics: which path is holding `running` */
let runningKind: "settle" | "playing" | null = null;
/** Last estimated catch-up duration (doubled the second time in K3(b)) */
let lastGuessMs = 0;
/** A settle that arrives while the second path is running: only the **last** one is remembered, and it is done after the current one ends (R5-15) */
let pendingSettleT: number | null = null;
/** Which run is holding `running` (after yielding, the old run must not touch `running` again when it finishes) */
let runSeq = 0;
let owner = 0;
/**
 * Abort switch of the playing-state swap in progress. On stop (pause / click / drag release /
 * playback reaching the end), the paused-state second path uses it to **preempt** the playing-state
 * catch-up run instead of waiting for it to finish by itself (C10-A4 follow-up). It is cleared on
 * entering the swap step (`swapAndDress`) and can no longer be preempted: the new `front`, halfway
 * through the swap, is not dressed yet, so let it finish, and the stop that came in is redone when
 * it finishes, per R5-15.
 */
let playingAbort: AbortController | null = null;
/** Diagnostics: number of yields and the most recent one */
let preemptCount = 0;
/**
 * The catch-up `render` still running on the background stage after being preempted (the parent
 * page no longer waits for its reply). Step (1) `pushProject(reset)` of the paused-state second path
 * aborts it as `'project'` the next time the stage yields; when there is no card to catch up at this
 * moment, `abortOrphanRender` aborts it separately, so that it does not push in vain in the
 * background for a dozen seconds.
 */
let orphanRender: Promise<unknown> | null = null;

/** Race `p` against the abort signal: if the signal arrives first, return `null` (without waiting for `p`) */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

/** Record a catch-up `render` that nobody waits for: once it settles (finished pushing or aborted) it no longer counts as an orphan */
function markOrphan(p: Promise<unknown>): void {
  orphanRender = p;
  const clear = () => { if (orphanRender === p) orphanRender = null; };
  p.then(clear, clear);
}

/**
 * Abort the catch-up run on the background stage that nobody waits for. Queued in the `catchup` tier
 * (the probe yields); `pushProject(reset)` makes the stage answer the in-flight `render` with
 * `'project'` the next time it yields (during `job: 'catchup'` it is always discarded and not
 * re-sent). This project is the current project anyway, and when the probe later wants a shrunken
 * project it reloads it by itself as usual.
 */
async function abortOrphanRender(project: Project): Promise<void> {
  // Do not check `orphanRender` here first: at the moment of preemption, the preempted job has not had time to record it yet; the job queued behind it records it when it starts
  await runBackJob("catchup", async (ctx) => {
    if (!orphanRender || !ctx.stage || ctx.stage === frontStage()) return;
    trace({ op: "orphan-abort" });
    await pushProject("back", project, { reset: true });
  });
}

export function swapInFlight(): boolean {
  return running;
}

/* ------------------------------------------------------------------ criteria */

/** Card clips active at this moment */
function activeCardClips(project: Project, t: number) {
  const out: { id: string; start: number; end: number }[] = [];
  for (const tr of project.tracks) {
    if (tr.hidden) continue;
    for (const clip of tr.clips) {
      if (!clip.cardId && !clip.nodeId) continue;
      if (cardMountedAt(clip, t)) out.push(clip);
    }
  }
  return out;
}

/** clipId → the K1 record of this card (`costs` is indexed by `identityKey`, the record has no clipId) */
function recordOf(project: Project, clipId: string): CardCostRecord | undefined {
  const key = clipIdentityOf(project).identityKeys[clipId];
  if (!key) return undefined;
  return currentCosts().find((r) => r.identityKey === key);
}

/**
 * **Cut segments** (`kernel/cutSegments.ts`) currently mounted that must be advanced by history.
 * They are not cards in the registry, have no cost record and do not enter the dispatch table, and
 * the subtree virtual time of the stage cannot advance the cards inside that follow the global clock,
 * so both jumping and starting playback from the middle of a segment need a full-scene catch-up run
 * in the background followed by a swap (the same second path as cards with `vtOk = false`). Those
 * stopped on the mount frame need no catch-up.
 */
export function statefulSegmentsAt(project: Project, t: number): { id: string; start: number; end: number }[] {
  const fps = Math.max(1, project.fps || 30);
  const frame = Math.round(t * fps);
  return flattenOverlay(project).clips.filter((c) => cutOf(c)?.frameMode === "stateful" && cardMountedAt(c, t) && frame > mountFrameOf(c, fps));
}

/**
 * Whether there is a card that is "classified heavy + `vtOk = false`" at this moment: if so, it must
 * take the second path (full-scene catch-up run, then swap). As soon as there is one, the whole scene
 * goes (a `vtOk` card that is catching up by itself being overwritten by the full-scene result is
 * harmless).
 */
export function needsBackCatchUp(project: Project, t: number): string[] {
  const plan = currentPlan();
  const out: string[] = [];
  for (const clip of activeCardClips(project, t)) {
    if (pipelineAt(plan, clip.id, t) !== "heavy") continue;
    const record = recordOf(project, clip.id);
    /*
     * **Cards without a cost record do not take this path** (end of K1: the fallback dispatch is only
     * used for the few seconds while "a new card has not been measured yet"). Without a record,
     * `clipWeight` classifies every stateful card as heavy by declaration, while `vtOk` is `undefined`.
     * Read as "if it is not true, take the second path", **right after a project is opened and before
     * the probe finishes measuring, it would run a full-scene catch-up and swap**: measured in
     * `editor-preview-smoke --stage`, adding two cards and then doing a `seek` swapped the identity once,
     * while the background stage was running the K1 probe at that time (the catch-up run is queued in the
     * `catchup` tier and pushes the whole probe out). The record is recomputed as soon as `setPlan`
     * arrives, and then which path to take is naturally settled.
     */
    if (!record) continue;
    if (record.vtOk === true) continue;   // The first path catches up by itself
    out.push(clip.id);
  }
  /*
   * Cards inside a cut segment that are classified heavy and attached to their own stream (or
   * placeholder) (virtual clips of `kernel/cutFlatten.mjs`): when stopped, their live subtree in the
   * nested scene is still frozen at the moment suppression started. The first path of the stage
   * (subtree virtual time) only recognizes top-level clips, and cards in a nested scene cannot be
   * advanced, so all those that must be advanced by history go through a full-scene catch-up run in
   * the background followed by a swap (until the catch-up run is done they stay attached to the stream
   * or placeholder as before). Remotion-style ones need no catch-up: once suppression is lifted they
   * are drawn correctly on the spot.
   */
  const { frameModes } = clipIdentityOf(project);
  for (const tr of flatPlanProject(project).tracks) {
    if (tr.hidden) continue;
    for (const clip of tr.clips) {
      if (!isFlatClipId(clip.id) || !clip.cardId || !cardMountedAt(clip, t)) continue;
      if (pipelineAt(plan, clip.id, t) !== "heavy" || frameModes[clip.id] === "direct") continue;
      if (clipIdentityOf(project).capabilities.get(clip.id)?.compositing !== "independent") continue;
      if (!recordOf(project, clip.id)) continue;
      out.push(clip.id);
    }
  }
  return out;
}

/**
 * **Light cards** that must wait for the background catch-up run during playback (the `vtOk = false`
 * branch of K3(b)).
 *
 * K2 classifies it as light (live render at every position), but its whole `catchUpMs` exceeds the
 * budget of one tick and it cannot be advanced with subtree virtual time, so when the playhead enters
 * it, the only option is a full-scene catch-up run in the background followed by a swap. While
 * waiting it is in the `suppressed` of `front`, and the stage shows a placeholder at its position
 * (T4).
 */
export function playingCatchUpTargets(project: Project, t: number): string[] {
  const plan = currentPlan();
  const fps = Math.max(1, project.fps || 30);
  const { frameModes } = clipIdentityOf(project);
  const out: string[] = [];
  for (const clip of activeCardClips(project, t)) {
    if (pipelineAt(plan, clip.id, t) !== "light") continue;
    const record = recordOf(project, clip.id);
    // Same as `needsBackCatchUp`: cards that have not been measured do not initiate a swap
    if (!record) continue;
    if (record.vtOk === true) continue;    // Catch up by itself inside the visible stage (the mechanism of the K5 first path)
    if (clipWeight(record, frameModes[clip.id], fps, currentTuning()).tier !== "catchup-b") continue;
    out.push(clip.id);
  }
  return out;
}

/* ------------------------------------------------------------------ natural entrance and starting playback from the middle of a card */

/**
 * The start of this round of playback and which tick it has reported (`src/render/playEntry.mjs`).
 * The playing-state swap is only for cards that "start playing from the middle of the card": for
 * tier (b) light cards with `vtOk = false` that walk through the mount frame tick by tick in
 * continuous playback and enter naturally, the visible stage advances tick by tick on the global
 * clock and mounts them at their own mount frame, so the state is already correct and no swap is
 * initiated (`AGENT-pause-precise.md`, "What was not done and observations", item 1).
 */
const playRun = createPlayRun();
/** Diagnostics: number of times a playing-state swap was not initiated because of natural entrance, and the most recent one */
let naturalSkips = 0;
let lastNaturalSkip: { t: number; ids: string[] } | null = null;
/** Diagnostics: cards in this round of playback for which no swap was initiated because of natural entrance (full clipId; cleared when playback starts) */
let naturalSkipped = new Set<string>();

function projectFps(): number {
  return Math.max(1, getState().project?.fps || 30);
}

/** Play pressed (or the stage changed and the ticks restart): this round of playback starts from `fromSec`. The host calls it before sending `play(fromSec)` */
export function notePlayRunStart(fromSec: number): void {
  notePlayStart(playRun, fromSec, projectFps());
  naturalSkipped = new Set();
}

/** The visible stage reports a tick (`frame` event). The host calls it before computing the target of the playing-state swap; returns whether this tick is continuous, repeated or broken */
export function notePlayFrame(sec: number): "continuous" | "repeat" | "break" {
  return notePlayBeat(playRun, sec, projectFps());
}

/**
 * Cards for which the playing-state swap **must be initiated** at this tick during playback:
 * `playingCatchUpTargets` minus those that entered naturally during this round of playback. The
 * paused-state second path (`staleOnBackCatchUp`) does not go through here and still takes all
 * tier (b) light cards with `vtOk = false`.
 */
export function playingSwapTargets(project: Project, t: number): string[] {
  const segments = statefulSegmentsAt(project, t);
  const all = [...playingCatchUpTargets(project, t), ...segments.map((c) => c.id)];
  if (!all.length) return all;
  const fps = Math.max(1, project.fps || 30);
  const clipOf = new Map([...activeCardClips(project, t), ...segments].map((c) => [c.id, c]));
  const out: string[] = [];
  const natural: string[] = [];
  for (const id of all) {
    const clip = clipOf.get(id);
    if (clip && enteredNaturally(playRun, mountFrameOf(clip, fps))) natural.push(id);
    else out.push(id);
  }
  if (natural.length) {
    naturalSkips++;
    lastNaturalSkip = { t, ids: natural };
    for (const id of natural) naturalSkipped.add(id);
  }
  return out;
}

/**
 * All cards that can only become exact through a background catch-up run on **pause / timeline
 * click / drag release** (R5-12).
 *
 * Two kinds combined:
 *   - those classified **heavy** with `vtOk = false` (`needsBackCatchUp`): the second path already
 *     took them originally;
 *   - those classified **light**, tier (b), with `vtOk = false` (`playingCatchUpTargets`): `routeJump`
 *     of the stage does `continue` on them (the comment says "the second path is initiated by the
 *     parent page"), while the parent page in the paused state only looks at the former kind, so
 *     after a jump they stay in the wrong state given by the global `clock.set`, and nobody catches
 *     them up, violating pinned architecture 9 (exact live render when paused).
 *
 * The second path is a **full-scene** catch-up run followed by a swap anyway, so taking this extra
 * kind costs nothing more: it only makes the moment when "only cards of this kind are stale" also
 * really go through one swap.
 */
export function staleOnBackCatchUp(project: Project, t: number): string[] {
  return [...new Set([...needsBackCatchUp(project, t), ...playingCatchUpTargets(project, t), ...statefulSegmentsAt(project, t).map((c) => c.id)])].sort();
}

/**
 * Estimate how long this card needs to catch up (used for the target tick `T` of K3(b)).
 *
 * **Estimated by playback position, no longer always by the worst cost of the whole segment**
 * (pinned rendering 4; volume K3(b), "the actual number of frames to catch up takes the playhead
 * landing point by the formula of pinned rendering 4"): a long motion goes through virtual time, and
 * the frame the playhead is currently standing on is the number of frames to catch up ->
 *
 *   `t_c = (t − t_start) × fps × t_oc`
 *
 * `t_oc` is the worst time of a single frame, taken as `stepMaxMs` of the cost record (what K1
 * measures is "the slowest frame in the stepping process"), falling back to `stepMs` at p90 when
 * there is none. The whole-segment `catchUpMs` is the total cost of rushing from frame 0 to the
 * **last frame**: estimating by it when the playhead has just entered the clip pushes the target tick
 * `T` out by several seconds, the visible stage waits in vain, that card sits under a placeholder in
 * `suppressed` for much longer, while `back` actually finishes catching up in a few dozen
 * milliseconds.
 *
 * The position estimate is **capped at the whole-segment cost** (the smaller of the two): `t_oc` is
 * the single-frame worst, and multiplying it over the full segment would be more pessimistic than
 * the measured total cost of the whole segment. If the position cannot be computed (no `t_oc`, or
 * the clip cannot be obtained), fall back to the whole-segment cost, and to 1 second if there is
 * none.
 *
 * **Only changes "how much to catch up", the actual value taken**: the light/heavy dispatch of K2 is
 * still judged by the whole-segment worst (pinned rendering 3, not a word of `clipWeight` changes).
 *
 * **The catch-up run pushes the whole scene, so what is estimated is the whole show** (C10-A4
 * follow-up): every card on stage (heavy ones too, since the background stage has no dispatch table
 * and live renders the whole show) is estimated by the formula above from max(in point, push start
 * point) to `t`, and the results are summed. With only the target card, it is the same as before.
 * `clipIds` is only used to judge "whether the target card has a number"; if none has, add 1 second
 * as a fallback.
 */
export function guessCatchUpMs(project: Project, clipIds: readonly string[], t: number): number {
  return sceneCostOf(project, clipIds, t).backlogMs;
}

/**
 * All card clips on stage (except hidden tracks) together with cost records: when the background
 * stage catches up it live renders the whole show, and heavy cards are pushed too.
 */
function sceneEntries(project: Project) {
  const out: { id: string; start: number; end: number; record: CardCostRecord | undefined }[] = [];
  for (const tr of project.tracks) {
    if (tr.hidden) continue;
    for (const clip of tr.clips) {
      if (!clip.cardId && !clip.nodeId) continue;
      out.push({ id: clip.id, start: clip.start, end: clip.end, record: recordOf(project, clip.id) });
    }
  }
  return out;
}

/**
 * The backlog of the full-scene catch-up run to `t` and the push rate afterwards
 * (`sceneCatchUpCost`).
 *
 * **Heavy cards in the same scene are counted together** (C10-A4 follow-up): before, only the
 * `catchUpMs` of the target light card itself was used, but the background stage pushes the whole
 * show frame by frame from the earliest in point, and slow heavy cards have to be pushed on every
 * frame. Measured: a 90 ms light card with 9 heavy cards at 40 ms/frame took 11 seconds to catch up
 * to 1.03 seconds, and the target tick had long been passed by the visible stage.
 *
 * When the target card itself has no number at all (no cost record, which should not initiate), add
 * a fallback of 1 second to the backlog.
 */
function sceneCostOf(project: Project, clipIds: readonly string[], t: number): { backlogMs: number; ratePerSec: number } {
  const fps = Math.max(1, project.fps || 30);
  const entries = sceneEntries(project);
  const { backlogMs, ratePerSec } = sceneCatchUpCost(entries, t, fps, cardMountedAt);
  const known = entries.some((e) => clipIds.includes(e.id) && catchUpEstimateMs(e.record, Math.max(0, t - e.start) * fps) > 0);
  return { backlogMs: backlogMs + (known ? 0 : DEFAULT_CATCHUP_GUESS_MS), ratePerSec };
}

/**
 * Check before a playing-state swap is initiated: how far the target tick is ahead of the playhead;
 * **if it cannot catch up, do not initiate** (C10-A4 follow-up).
 *
 * There are two ways it cannot catch up:
 *   - `rate`: the background stage needs more than 1 second of wall clock to push 1 second of
 *     timeline (the cards on stage add up to more than one tick per frame): the visible stage moves
 *     forward at 1 second per second, so the background can never reach the target tick;
 *   - `past-end`: the resolved target tick falls after all of these target cards have exited:
 *     after the swap they are no longer on screen.
 *
 * In both cases a swap used to be initiated: the full-scene catch-up run occupied the background
 * stage for a dozen seconds in vain (measurement and claiming both had to yield), and all it got was
 * a downgrade after "the armed stop has passed" twice. Playback is not meant to chase exactness
 * anyway ("exact on stop" in `product/rendering.md` only covers stopping), so here we simply do not
 * initiate; the moment it stops, the paused-state second path makes it an exact live render as usual.
 */
export function planPlayingSwap(project: Project, clipIds: readonly string[], t: number):
  { ok: true; leadMs: number; backlogMs: number; ratePerSec: number } | { ok: false; reason: "rate" | "past-end"; backlogMs: number; ratePerSec: number; leadMs: number | null } {
  const { backlogMs, ratePerSec } = sceneCostOf(project, clipIds, t);
  const leadMs = playingLeadMs(backlogMs, ratePerSec);
  if (leadMs === null) return { ok: false, reason: "rate", backlogMs, ratePerSec, leadMs };
  let lastEnd = -Infinity;
  for (const tr of project.tracks) for (const clip of tr.clips) if (clipIds.includes(clip.id)) lastEnd = Math.max(lastEnd, clip.end);
  if (t + leadMs / 1000 >= lastEnd) return { ok: false, reason: "past-end", backlogMs, ratePerSec, leadMs };
  return { ok: true, leadMs, backlogMs, ratePerSec };
}

/* ------------------------------------------------------------------ waiting for events */

function waitForEvent(match: (e: StageEvent) => boolean, timeoutMs: number): Promise<StageEvent | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (e: StageEvent | null) => {
      if (done) return;
      done = true;
      off();
      window.clearTimeout(timer);
      resolve(e);
    };
    const off = onStageEvent((e) => { if (match(e)) finish(e); });
    const timer = window.setTimeout(() => finish(null), timeoutMs);
  });
}

/* ------------------------------------------------------------------ Main flow */

interface BackReady {
  back: StageRpcClient;
  /** Which second the background stage has caught up to */
  atSec: number;
}

/**
 * (1)(2)(3): catch the background stage up to `targetSec` and wait for its media layer to produce a
 * frame. Queued in the `catchup` tier of `stageJobs` (the probe yields as a whole, and any
 * `'project'` that comes out of an abort is always discarded, an exception to E0).
 */
async function catchUpBack(project: Project, targetSec: number, preempt?: AbortSignal): Promise<BackReady | null> {
  // Only one stage: there is no background stage to catch up, so queue no step at all
  if (swapBlockedBySingleStage()) return null;
  trace({ op: "catchup-queued", t: targetSec });
  return await runBackJob("catchup", async (ctx) => {
    const back = ctx.stage;
    trace({ op: "catchup-start", t: targetSec, back: !!back, sameAsFront: back === frontStage() });
    if (preempt?.aborted) return null;
    if (!back || back === frontStage()) return null;   // legacy single stage: no background to swap with
    // (1) The probe may have replaced it with a shrunken project, so reload it entirely and update the stageBridge baseline
    await pushProject("back", project, { reset: true });
    if (ctx.signal.aborted || preempt?.aborted) return null;
    // (2) Catch the whole scene up from the earliest mountFrameOf to the target tick. Without maxCatchUp the start would be cut off at 6000 ms
    const pending = back.render(targetSec, { jump: true, maxCatchUp: Infinity });
    /*
     * Once preempted (stopped), **do not wait for this render's response**: hand the single-flight queue
     * to the paused-state second path on the spot. Its step (1) `pushProject(reset)` cuts this render off
     * the next time the stage yields. Waiting for the response means waiting for the stage to push the
     * whole show to the target beat (C10-A4 measured about 1.5 seconds, ten-odd seconds for heavy projects).
     */
    const reply = await untilAborted(pending, preempt);
    if (reply === null) { markOrphan(pending); trace({ op: "catchup-preempted", t: targetSec }); return null; }
    trace({ op: "catchup-rendered", t: targetSec, aborted: "aborted" in reply ? reply.aborted : false, reason: (reply as { reason?: string }).reason });
    if ("aborted" in reply && reply.aborted) return null;
    if (ctx.signal.aborted || preempt?.aborted) return null;
    // (3) The asset layer is in place too (wait at most 300 ms, swap anyway on timeout)
    const ready = waitForEvent((e) => e.type === "mediaReady", MEDIA_READY_TIMEOUT_MS);
    await back.setMediaT(targetSec);
    await untilAborted(ready, preempt);
    if (preempt?.aborted) return null;
    return { back, atSec: targetSec };
  });
}

/** (4)(5): swap, and fill in the state the new `front` should have */
async function swapAndDress(sec: number, playing: boolean): Promise<StageRpcClient | null> {
  dressError = null;
  const oldFront = frontStage();
  const swapped = host?.swapRoles();
  if (!swapped?.front) return null;
  const next = swapped.front;
  // Swap visibility first (the line above), **then** oldFront.setRole('back') and wait for the response, **last** back.setRole('front')
  if (oldFront && oldFront !== next) {
    try { await oldFront.setRole("back"); } catch { /* The iframe is being swapped */ }
  }
  try { await next.setRole("front"); } catch { return null; }

  /* (5) As a back it had no table, no hash, and its entity mode was the default: none of these can be skipped */
  const project = getState().project;
  try {
    /*
     * Root cause A: the new `front` holds the copy loaded at step (1) when the catch-up run started; user
     * edits during the catch-up run were only pushed to the `front` of that time.
     * The baseline follows the client (`swapStageClients` in `stageBridge`), so pushing once more here is
     * an **increment**: deleted clips are removed on the spot; with no edits the baseline is identical and
     * nothing is sent. Both the paused-state and playing-state swap paths go through here.
     */
    await syncProject("front", project);
    // Resend the dispatch table: it had none as a `back` (E0's "must resend when the role is promoted")
    await sendPlanTo("front", { force: true });
    await next.setLocalHashes(host?.localHashes() ?? []);
    if (playing) {
      clearSettled("front", "playing");
      /*
       * Playing-state swap: set up the three sets first, then play(T). **Send the stream plane first, the
       * suppression after** (same order as `syncPlanes` in `Preview`): when the stage receives the
       * suppression it already knows a stream is coming for this card, so before the stream draws its first
       * frame it does not hide the exact picture the catch-up run produced (`streamWaiting` in `StageView`).
       * Sent the other way round, the stage hides the live subtree on the spot, and this layer is empty until
       * the first stream frame arrives (about 0.1 seconds).
       */
      await next.setStreamPlanes(streamPlanesAt({ project, t: sec, playing: true }));
      await next.setSuppressed(suppressedAt({ project, t: sec, playing: true }));
      await next.setScrubbing(false);
      await next.setProxy(host?.proxy() ?? false);
      await next.play(sec);
      await next.setPlaying(true);
    } else {
      markBaselineReset("front");
      markAllSettled("front");
      await next.setStreamPlanes(streamPlanesAt({ project, t: sec, playing: false }));
      await next.setSuppressed(suppressedAt({ project, t: sec, playing: false }));
      await next.setPlaying(false);
      await next.setScrubbing(false);
      await next.setProxy(host?.proxy() ?? false);
    }
  } catch (e) { dressError = String((e as Error)?.message ?? e).slice(0, 160); /* The iframe is being swapped: the next setTime will lay the state out again */ }
  return next;
}
let dressError: string | null = null;

/**
 * The paused-state second path (K5): after `setTime(t, { settle: true })`, it runs as soon as any
 * duplicate-check card has `vtOk = false`.
 */
export async function runSettleSwap(t: number): Promise<boolean> {
  /*
   * **A new request arriving while running is not dropped; remember the last one** (R5-15). This used
   * to be a plain `return false`: with real rapid clicks on the timeline (intervals shorter than the few
   * hundred milliseconds of one catch-up run), the position of the last click was never swapped in, and
   * the duplicate-check `vtOk = false` card stayed on the snapshot. Now, after the current run finishes
   * or aborts, it runs again with the last `t`; the ones overwritten in between never needed to run.
   */
  // Only one stage: after pausing, no background stage catches up to live render (the visible stage does the stop-and-catch-up-one-frame layer by layer)
  if (swapBlockedBySingleStage()) { trace({ op: "settle", t, out: "single" }); return false; }
  /*
   * **A playing-state catch-up run yields immediately** (follow-up to C10-A4): if what is running at stop
   * time is a playing-state swap, abort it on the spot and take over `running`; the paused-state second
   * path starts right away without waiting for it to wind down. The target beat of that whole-scene
   * catch-up run is "playhead + estimated time", and the beat it pushes out is useless after the stop;
   * it used to be that the stop had to wait until it finished pushing (measured about 1.5 seconds) and
   * released `running` before its turn came.
   * If playback is still going (not stopped), or it has already entered the swap step (`playingAbort`
   * cleared), it is only recorded as before, and done when it winds down.
   */
  let preempted = false;
  if (running) {
    if (runningKind === "playing" && playingAbort && !getState().playing) {
      trace({ op: "settle", t, out: "preempt" });
      playingAbort.abort();
      playingAbort = null;
      preemptCount++;
      preempted = true;
    } else {
      trace({ op: "settle", t, out: "running", runningKind });
      pendingSettleT = t;
      return false;
    }
  }
  running = true;
  runningKind = "settle";
  const me = owner = ++runSeq;
  try {
    let target = t;
    for (;;) {
      pendingSettleT = null;
      let swapped = false;
      const project = getState().project;
      const stale = staleOnBackCatchUp(project, target).length;
      trace({ op: "settle", t: target, stale, plan: !!currentPlan(), costs: currentCosts().length, ...(stale ? {} : { cards: staleExplain(project, target) }) });
      // This beat needs no catch-up run, but a playing-state catch-up run just preempted may still be pushing on the background stage: cut it off separately (when a catch-up run is needed, step (1) cuts it along the way)
      if (!stale && (preempted || orphanRender)) await abortOrphanRender(project);
      preempted = false;
      if (stale) {
        const ready = await catchUpBack(project, target);
        // The user moved again during the catch-up run: this run is void (the round below redoes it with the latest `t`)
        if (ready && Math.abs(getState().t - target) <= 1e-6 && !getState().playing) {
          swapped = !!(await swapAndDress(target, false));
        }
        swapLog.push({ at: Math.round(performance.now()), t: target, stale, ready: !!ready, swapped, ...(dressError ? { error: dressError } : {}) });
        if (swapLog.length > 10) swapLog.shift();
      }
      const next = pendingSettleT;
      // No new request, or the new request is the beat just done: finish
      if (next === null || Math.abs(next - target) <= 1e-6 || getState().playing) return swapped;
      target = next;
    }
  } finally {
    if (owner === me) {
      running = false;
      runningKind = null;
      pendingSettleT = null;
    }
  }
}

/**
 * Playing-state swap (K3(b)). Target beat `T = store.t + estimated catch-up duration`, rounded to the
 * beat grid.
 *
 * Only **after** `back` has caught up and `mediaReady` is the armed stop set on the old `front`: the
 * other way round, the visible stage would stop while `back` is not ready, with no upper bound on how
 * long it stops. If the armed stop returns `{ passed: true }` (the visible stage reached `T` first),
 * take `T' = store.t + previous estimate × 2`, push `back` on (without `jump`) and arm once more;
 * if it still cannot catch up after two tries, do not swap (that card stays in `suppressed`, waiting
 * for the dead asset after the K6 downgrade).
 */
export async function runPlayingSwap(pendingIds: readonly string[]): Promise<boolean> {
  if (running) return false;
  if (swapBlockedBySingleStage()) return false;
  const project = getState().project;
  if (!pendingIds.length) return false;
  /*
   * If the estimate says it cannot catch up, do not start (follow-up to C10-A4, `planPlayingSwap`): no
   * suppression, no background task queued, no `running` taken. It used to start anyway, and the
   * whole-scene catch-up run wasted the background stage for ten-odd seconds, finally "armed stop
   * already passed" twice and then downgraded.
   */
  const plan = planPlayingSwap(project, pendingIds, getState().t);
  lastPlayingPlan = { at: Math.round(performance.now()), t: getState().t, ids: [...pendingIds], ...plan };
  playingPlans.push(lastPlayingPlan);
  if (playingPlans.length > 20) playingPlans.shift();
  if (!plan.ok) {
    trace({ op: "playing", t: getState().t, ids: pendingIds.map((id) => id.slice(0, 8)), out: `skip-${plan.reason}`, backlogMs: Math.round(plan.backlogMs), ratePerSec: Math.round(plan.ratePerSec) });
    return false;
  }
  running = true;
  runningKind = "playing";
  const me = owner = ++runSeq;
  const abort = new AbortController();
  playingAbort = abort;
  trace({ op: "playing", t: getState().t, ids: pendingIds.map((id) => id.slice(0, 8)), leadMs: Math.round(plan.leadMs), backlogMs: Math.round(plan.backlogMs), ratePerSec: Math.round(plan.ratePerSec) });
  // While waiting, these cards go into front's suppressed (subtree hidden, t frozen: with no plane the stage shows a placeholder T4)
  setExtraSuppressed(pendingIds);
  /**
   * Cannot catch up both times: **reclassify as heavy (K6), and do not return to live render** (R5-11).
   *
   * The plan says explicitly that this card is an exception: its live-rendered state is wrong to begin
   * with (`vtOk = false`, the subtree's virtual time cannot drive it), and it only waits in `suppressed`
   * when it cannot catch up, so until the dead asset is ready it stays in `suppressed` (showing a
   * placeholder), unlike other downgraded cards that "live render as usual until ready".
   * It used to be a plain `return false` here, and `setExtraSuppressed([])` in `finally` put it back
   * to live render, and `swapTried` also stopped this round of playback from retrying: the state was
   * wrong and nobody fixed it.
   */
  const giveUp = async (): Promise<false> => {
    gaveUp = true;
    for (const id of pendingIds) { try { await onStageDemote(id); } catch { /* No record / PUT failed: K6 will come again on the next beat */ } }
    return false;
  };
  let gaveUp = false;
  try {
    const fps = Math.max(1, project.fps || 30);
    // The lead is estimated for the whole scene (heavy cards of the same scene are pushed together), including the stretch "catching up while the visible stage chases"
    lastGuessMs = plan.leadMs;
    const beatOf = (sec: number) => Math.round(sec * fps);
    let target = Math.ceil((getState().t + lastGuessMs / 1000) * fps) / fps;
    let ready = await catchUpBack(project, target, abort.signal);
    if (!ready) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const oldFront = frontStage();
      if (!oldFront || !getState().playing || abort.signal.aborted) return false;
      const armed = waitForEvent((e) => e.type === "frame" && beatOf(e.sec) >= beatOf(target), ARM_WAIT_TIMEOUT_MS);
      const reply = await untilAborted(oldFront.pause({ atSec: target }), abort.signal);
      if (!reply) return false;
      if (reply.ok && reply.passed) {
        // The visible stage reached T first: take T' and **keep pushing** back (without jump, continuing from T)
        // If it cannot catch up both times → reclassify as heavy (K6) and stay in suppressed (R5-11)
        if (attempt >= 1) return giveUp();
        lastGuessMs *= 2;
        target = Math.ceil((getState().t + lastGuessMs / 1000) * fps) / fps;
        const back = backStage();
        if (!back) return false;
        const pending = back.render(target, { maxCatchUp: Infinity });
        const again = await untilAborted(pending, abort.signal);
        if (!again) { markOrphan(pending); return false; }
        if ("aborted" in again && again.aborted) return false;
        const media = waitForEvent((e) => e.type === "mediaReady", MEDIA_READY_TIMEOUT_MS);
        await back.setMediaT(target);
        await untilAborted(media, abort.signal);
        continue;
      }
      if (!reply.ok) return false;
      await untilAborted(armed, abort.signal);
      // Stopped (preempted), or no longer playing when the armed stop timed out: do not swap to the playing state
      if (abort.signal.aborted || !getState().playing) return false;
      // Once in the swap step it can no longer be preempted: the new front mid-swap is not fully equipped yet (the stop does its part when this winds down, per R5-15)
      if (playingAbort === abort) playingAbort = null;
      // After the swap, the new front's H(T) does not contain them (they were classified light), so clear this copy first
      setExtraSuppressed([]);
      const swapped = !!(await swapAndDress(target, true));
      // The new visible stage swapped in is exact for the whole scene at frame T, and reports beats on from T: count it as continuous (start point unchanged)
      if (swapped) notePlaySeam(playRun, target, fps);
      return swapped;
    }
    return giveUp();
  } finally {
    const preempted = owner !== me;
    trace({ op: "playing-end", t: getState().t, gaveUp, preempted, pendingSettleT: preempted ? null : pendingSettleT });
    if (playingAbort === abort) playingAbort = null;
    // Giving up that time does **not** clear: that card's live-rendered state is wrong, so until the dead asset is ready it stays in suppressed (R5-11)
    if (!gaveUp) setExtraSuppressed([]);
    // Preempted by the paused-state second path: `running` now belongs to it, and the handoff below is not this code's turn either
    if (!preempted) {
      running = false;
      runningKind = null;
      /*
       * **A paused-state settle arriving while running is handed to the paused-state path** (the other half
       * of R5-15; C10-A4).
       * A stop is normally preempted on the spot already (see `runSettleSwap`); what reaches here are the
       * cases that cannot be preempted: at the moment of the stop it had already entered the swap step, or
       * the store was still playing when the settle came. Before, only the paused-state path consumed
       * `pendingSettleT`, and winding down here neither did it nor handed it over: the duplicate-check
       * `vtOk = false` card stayed on the snapshot until the next jump or playback, violating "exact once
       * stopped". If playback has started again by the time it winds down, do not redo it: the next stop
       * will come around again by itself.
       */
      const next = pendingSettleT;
      pendingSettleT = null;
      if (next !== null && !getState().playing) void runSettleSwap(next).catch(() => { /* The background stage is being swapped: the next setTime will start over */ });
    }
  }
}

/** Diagnostics: the start decision of the latest playing-state swap (lead, backlog, rate, or why it did not start) and the yield count (for the probe) */
let lastPlayingPlan: Record<string, unknown> | null = null;
/** Diagnostics: the latest 20 start decisions (with the full clipId) */
const playingPlans: Record<string, unknown>[] = [];
export function stageSwapPlayingDebug() {
  return { lastPlan: lastPlayingPlan, plans: playingPlans.slice(), preemptCount, orphan: !!orphanRender,
    playRun: { ...playRun }, naturalSkips, lastNaturalSkip, naturalSkipped: [...naturalSkipped] };
}

/** For tests */
export function resetStageSwap(): void {
  running = false;
  runningKind = null;
  pendingSettleT = null;
  lastGuessMs = 0;
  host = null;
  playingAbort = null;
  orphanRender = null;
  owner = 0;
  preemptCount = 0;
  lastPlayingPlan = null;
  playRun.startFrame = null;
  playRun.lastFrame = null;
  playRun.breaks = 0;
  naturalSkips = 0;
  lastNaturalSkip = null;
  naturalSkipped = new Set();
  playingPlans.length = 0;
}
