/**
 * Parent-page side delivery of snapshots / suppression (the consumer of C4, C5 and A3c).
 *
 * R6 finished the "can we get it" half (`snapshotSource.ts` with its ready-index SSE and byte
 * fetching, `snapshotPick.mjs` with its pure look-back frame-picking function,
 * `dataMirror.pushWanted`). This file is the scheduling half:
 *
 * - For each playhead position, split out the set of heavy cards `H(t)` for this moment using the
 *   `pipelineAt` of `planDispatch.currentPlan()`, and pick one frame per heavy card from the ready
 *   index (`pickLayerSnapshot`: look back within the same interval, never across intervals,
 *   **never wait**);
 * - **One delivery baseline per iframe** (A3c): `patch` is a delta against the last delivery, and
 *   `null` = remove. `setProject` replaces the whole thing, and the K5 role swap must carry
 *   `reset`. A `settled` message deletes the clipId from the baseline; otherwise, when C4 next
 *   picks the same frame, the baseline would judge it "already mounted", skip delivery, and expose
 *   a stale live component;
 * - **DOM swaps are throttled**: at most once every 33 ms (C4). The delivery that carries `reset`
 *   (the first delivery after a swap) is not throttled;
 * - **One delivery is <= 2 MB** (A3c): one packet at a time, packed by fallback level (no stream >
 *   over budget). Whatever does not fit is delivered on the next beat, not removed.
 *
 * # Why fetching bytes must not block `setTime`
 *
 * The overall rule is "never wait". So this is split into a synchronous half and an asynchronous
 * half: `pickForSetTime(t)` returns **synchronously** the bytes already in hand (`have`), and
 * starts `fetchSnapshot` on the spot for the missing frames; once they arrive they go out through
 * the separate `setSnapshots` delivery. When dragging across the entry point of a stateful card,
 * the cache-hit copy takes effect in the same React commit as `t` (no flash of the initial state);
 * a layer that missed is hidden by `.pc-awaiting` for 500 ms.
 *
 * # Fallback order (mechanism/rendering.md, "Fallback order")
 *
 * Heavy cards are pasted with the track stream, **the same for playing, pausing and dragging**
 * (2026-10-13 user decision: the per-card HTML snapshot is void): the full-density stream for this
 * frame → the sparse stream (the nearest one no later than this frame) → the placeholder. The
 * parent page handles three things on its side:
 *
 *   1. Stream planes are sent only for the ones whose segment containing this frame is ready and
 *      that the decoder budget lets through (`planesWithinBudget`, the same function as the
 *      stage);
 *   2. Suppression: while playing it is all heavy cards; while paused / dragging it is the heavy
 *      cards that "have a stream for this frame but have not yet caught up to the exact live
 *      render" (`FeedPlan.scrub`). Cards that have already caught up to the exact live render are
 *      not suppressed and their stream planes are still sent; the stage only uses them to decode
 *      the frame under the playhead first (so the first beat of playback is ready);
 *   3. **A card covered by a stream does not read snapshots** (see "Boundary of the snapshot
 *      path" below): no frame picking, no byte fetching, no delivery, no waiting.
 *
 * **Cards that depend on the layer below** (the frosted-glass kind, and cards the review table
 * does not cover) follow the same order, with only two differences (`streamLayers`):
 * Its stream is produced in stage coordinates, and the stream plane carries `plane: "stage"` (the
 * stage mounts the canvas under the stage root); its stream is valid only for the version of the
 * layer below at the time it was produced, and that layer carries the input signature from when
 * the stream was produced (`inputSig`). If it does not match what the parent page computes from
 * the current project, it is **stale**: treat the card as having no stream and fall through to the
 * next step.
 *
 * When the stream cannot draw on this beat, the stage keeps the previous one, for at most the
 * duration of one segment, and only then shows the placeholder (`streamPlayer`, `StageView`).
 *
 * **With only one stage** (lite mode and the lowest tier, when the online browser performs poorly;
 * 2026-10-13 user decision: "paste only the sparse version of the track stream, and give few
 * decoders alive at the same time") it follows this same order too, with these differences only:
 * The stream plane carries `first` (the stage decodes only the first frame of each segment, even
 * if that segment is full-density); the budget for streams on screen at once uses the small set
 * (`sparseStreamBudget`: 4 decoders, total aspect ratio of two full-screen 1080p cards); the
 * fallback order of this tier is "first frame of the stream segment → placeholder".
 * **With only one stage** (first level of the stage gate, the lowest tier, handshake failure
 * fallback) there is no background stage that can catch up to exact and then swap: while paused or
 * dragging, heavy cards are always suppressed, and after stopping the stage catches up one exact
 * live-render frame layer by layer in the visible stage (`syncPlanes`, `settleLayers` of
 * `Preview`).
 *
 * # Snapshots have been withdrawn (Ji-2)
 *
 * The per-card HTML snapshot has been fully taken offline. Heavy cards are pasted with the track
 * stream when playing, pausing and dragging; a heavy card that cannot be pasted with a stream on
 * this frame (the stream is not ready yet, over budget, or there is no stream) enters scrub in the
 * paused/dragging state and shows the placeholder (a pure remotion card that can be live-rendered
 * is live-rendered directly). picks always returns an empty table, wanted always returns an empty
 * array, and deliverSnapshots is retired to a no-op that returns 0.
 */
import { cardMountedAt } from "../render/frameWindow.mjs";
import type { ReadyKind } from "../render/snapshotPick.mjs";
import { applyReadyMessage, HttpSnapshotSource, type ReadyIndex, type ReadyMessage, type SnapshotSource } from "../render/snapshotSource";
import { pipelineAt } from "../render/pipelinePlan.mjs";
import { mirrorKey } from "../render/dataMirror";
import type { Project, TrackClip } from "../kernel/project";
import type { StageRole, StageRpcClient } from "../render/stageRpc";
import * as planDispatch from "./planDispatch";
import type { CardCostRecord } from "../render/cardCostKey.mjs";

type CostResolver = (project: Project, clipId: string) => CardCostRecord | undefined;
let costResolver: CostResolver | null = null;
let dualStageResolver: (() => boolean) | null = null;

export function setCostResolver(fn: CostResolver | null, dual?: (() => boolean) | null): void {
  costResolver = fn;
  if (dual !== undefined) dualStageResolver = dual;
}
import { cardRunStatesGen, cardsRegistryGen, syncedUserCardsGen, getCard } from "../kernel/registry";
import { localOnlyClipIds, onlineBrowserMode } from "../render/placeholderHost";
import { planesWithinBudget, rangesHave, streamPlanesFor, type StreamPlaneRequest } from "../render/streamPlayer";
import { localStreamPixels, sparseStreamBudget, stageStreamPixels, STREAM_BUDGET_MIN_FPS } from "../render/streamBudget.mjs";
import { isStreamOrigin, streamSegmentOf } from "../render/streamSegments.mjs";
import { streamInputSig, streamSigStale } from "../render/streamInputSig.mjs";
import { cardCapabilities, clipFrameMode } from "../kernel/frameMode.mjs";
import { flatPlanProject, isFlatClipId } from "../kernel/cutFlatten.mjs";

/** C4: DOM swap at most once per rAF, interval ≥ 33 ms */
export const SNAPSHOT_THROTTLE_MS = 33;
/** A3c: one `setSnapshots` delivery ≤ 2 MB (the reply's `bytes` is the measured opening; split if exceeded) */
export const SNAPSHOT_DELIVERY_MAX_BYTES = 2 * 1024 * 1024;
/** A lost iframe reply must not leave the delivery baseline committed forever. */
export const SNAPSHOT_DELIVERY_TIMEOUT_MS = 8000;
/** C4: report at most 8 gaps at a time to the prerender process */
export const MAX_WANTED = 8;

/**
 * All `stream` layers in the ready index (for a single-card stream the member is the card itself;
 * a group stream hangs on the topmost card of the group and carries `groupClipIds`).
 * `originFrame` is this stream's own first frame (segments are counted from it,
 * `render/streamSegments.mjs`); layers without it (sent by producers from before the segment rule
 * changed) can't convert frame numbers to segment numbers, so they are not collected here: treat
 * the card as having no stream.
 */
interface StreamLayer { clipId: string; key: string; ranges: Array<[number, number]>; groupClipIds?: string[]; originFrame: number; members: string[]; plane?: "stage"; px?: number }
/**
 * The encoded aspect ratio of a stream (the budget multiplies it by the frame rate,
 * `render/streamBudget.mjs`; the side that partitions streams uses the same formula):
 * for streams produced in stage coordinates (group streams, streams depending on the layers below)
 * it is the full frame; for a single-card stream it is the upper bound of its rectangle (the
 * wrapper layer's box expanded by a margin, clamped inside the frame).
 * Each project (an immutable object) caches one clipId → pixel count table. If the card isn't found
 * in the project it returns undefined (the budget side treats it as a full-screen card).
 */
const streamPixels = new WeakMap<Project, Map<string, number | undefined>>();
function streamPixelsOf(project: Project, clipId: string, stage: boolean): number | undefined {
  const size = { width: Number(project.width) || 1920, height: Number(project.height) || 1080 };
  if (stage) return stageStreamPixels(size);
  let byClip = streamPixels.get(project);
  if (!byClip) { byClip = new Map(); streamPixels.set(project, byClip); }
  if (!byClip.has(clipId)) {
    let found: TrackClip | undefined;
    // Cards inside a cut segment are in the flattened view (`kernel/cutFlatten.mjs`)
    for (const track of flatPlanProject(project).tracks ?? []) { found = (track.clips ?? []).find((c) => c.id === clipId); if (found) break; }
    byClip.set(clipId, found ? localStreamPixels(found.frame, size) : undefined);
  }
  return byClip.get(clipId);
}
function streamLayers(project: Project): StreamLayer[] {
  const out: StreamLayer[] = [];
  for (const [clipId, byKind] of readyIndex) {
    const layer = byKind.get("stream");
    if (!layer || !isStreamOrigin(layer.originFrame)) continue;
    const below = layer.streamKind === "below";
    // Stream depending on the layers below: in the short window where the lower layers have changed but the prerender process hasn't switched versions yet, the ready index still holds the old stream; don't attach one whose signature doesn't match
    if (below && belowStreamStale(project, clipId, layer.inputSig)) continue;
    out.push({ clipId, key: layer.key, ranges: layer.ranges as Array<[number, number]>, groupClipIds: layer.groupClipIds, originFrame: layer.originFrame,
      members: layer.groupClipIds?.length ? layer.groupClipIds : [clipId], ...(below ? { plane: "stage" as const } : {}),
      px: streamPixelsOf(project, clipId, below || (layer.groupClipIds?.length ?? 0) > 1) });
  }
  return out;
}

/**
 * Whether a stream depending on the layers below is stale: the input signature that layer carries
 * (the project version at production time) doesn't match the one computed from the current
 * project. The signature covers the target card and each layer below it: clip inputs, sampling
 * window, box, opacity, fade in/out, trajectory, and the stacking order of the lower layers
 * (`render/streamInputSig.mjs`); layers above are not included.
 * It counts as stale only when both sides have a signature, the algorithm version is the same, and
 * they differ (`streamSigStale`); a layer that carries no signature is not judged (attach as is).
 * Each project (an immutable object) caches one clipId → signature table: the parent page asks on
 * every tick, and nothing is recomputed as long as the project isn't a new object.
 */
const belowSigs = new WeakMap<Project, Map<string, string | null>>();
function belowSigOf(project: Project, clipId: string): string | null {
  let byClip = belowSigs.get(project);
  if (!byClip) { byClip = new Map(); belowSigs.set(project, byClip); }
  if (!byClip.has(clipId)) byClip.set(clipId, streamInputSig(project, { clipIds: [clipId], kind: "below" }));
  return byClip.get(clipId) ?? null;
}
function belowStreamStale(project: Project, clipId: string, layerSig: string | undefined): boolean {
  if (!layerSig) return false;
  return streamSigStale(layerSig, belowSigOf(project, clipId));
}

export type PickTier = "none" | "over";

/** The frame picked for a card at this moment (backward-compatible type signature) */
export interface Pick {
  clipId: string;
  kind: ReadyKind;
  key: string;
  localFrame: number;
  /** Comparison key of the delivery baseline: the DOM is swapped only when it changes */
  id: string;
  tier: PickTier;
}

interface Baseline {
  needsReset: boolean;
  lastSentAt: number;
  /** Cards already settled in the paused state (exact live render, the stage lifted suppression itself): no longer suppressed while paused (root cause B) */
  settled: Set<string>;
  /** After the second-path swap in the paused state: the whole stage is exact */
  settledAll: boolean;
}

const newBaseline = (): Baseline => ({ needsReset: false, lastSentAt: 0, settled: new Set(), settledAll: false });

const baselines: Record<StageRole, Baseline> = { front: newBaseline(), back: newBaseline() };

let source: SnapshotSource = new HttpSnapshotSource();
let readyIndex: ReadyIndex = new Map();
let unsubscribe: (() => void) | null = null;
let subscribedTo = "";
/** Re-deliver once after arrival: attached by the host (`Preview`) */
let onArrive: (() => void) | null = null;

/** Tests / probes: swap in a different snapshot source */
export function setSnapshotSource(next: SnapshotSource): void {
  source = next;
}

/**
 * Tell the host to refresh after state arrives. Pass null to detach.
 */
export function setSnapshotArrive(notify: (() => void) | null): void {
  onArrive = notify;
}

/** What the ready index looks like right now (read by the acceptance-check probe) */
export function currentReadyIndex(): ReadyIndex {
  return readyIndex;
}

/** Safe probe diagnostics for a paused online page; no snapshot bytes or tickets. */
export function snapshotFeedDebug(head: Playhead) {
  const planned = planFeed(head);
  return {
    ready: [...readyIndex].map(([clipId, kinds]) => ({ clipId, kinds: [...kinds].map(([kind, layer]) => ({ kind, key: layer.key.slice(0, 12), ranges: layer.ranges.length })) })),
    heavy: planned.heavy,
    picks: [],
    // Which cards the stream planes sent to the stage cover at this moment, and which cards are suppressed while paused / dragging (attach stream)
    streams: planned.streamPlanes.map((p) => ({ clipIds: p.clipIds, key: (p.key ?? "").slice(0, 12), originFrame: p.originFrame ?? null, plane: p.plane ?? null })),
    // Streams depending on the layers below that are in the ready index but whose input signature doesn't match the current project (the lower layers changed; don't attach the old stream)
    staleBelow: [...readyIndex].filter(([clipId, kinds]) => {
      const layer = kinds.get("stream");
      return layer?.streamKind === "below" && belowStreamStale(head.project, clipId, layer.inputSig);
    }).map(([clipId]) => clipId),
    scrub: planned.scrub,
    mounted: [],
    reset: baselines.front.needsReset,
    settled: [...baselines.front.settled],
    settledAll: baselines.front.settledAll,
    settledLog: settledLog.slice(),
  };
}

/**
 * Subscribe to the ready index (C3's SSE, the page connects directly to the prerender process).
 * **Keyed by session only** (root cause E): every edit bumps `localRev` by 1; this used to clear
 * the table and reconnect, while the server's `/api/frames/ready` doesn't look at session /
 * localRev at all, so during the reconnect gap, heavy cards that were playing all went transparent.
 * Now the client doesn't clear the table preemptively: old layers are held up as "keep using the
 * old prerender output", and are cleared once the prerender process sends `reset` (when this
 * session's preload changed version, Item 4).
 * Reconnect only when the project changes (the session changed).
 */
export function syncSnapshotSubscription(notify: () => void): void {
  onArrive = notify;
  const key = mirrorKey();
  const want = key ? key.session : "";
  if (want === subscribedTo) return;
  unsubscribe?.();
  unsubscribe = null;
  subscribedTo = want;
  readyIndex = new Map();
  if (!key) return;
  unsubscribe = source.subscribeReady(key.session, key.localRev, (message: ReadyMessage) => {
    applyReadyMessage(readyIndex, message);
    if (message.type !== "done") onArrive?.();
  });
}

export function stopSnapshotFeed(): void {
  unsubscribe?.();
  unsubscribe = null;
  subscribedTo = "";
  onArrive = null;
  readyIndex = new Map();
  baselines.front = newBaseline();
  baselines.back = newBaseline();
}

/** `setProject` replaces the whole thing / K5 role swap: the next delivery carries `reset` */
export function markBaselineReset(role: StageRole): void {
  baselines[role].needsReset = true;
}

/**
 * K5 first path settled: the stage lifted suppression itself, and the parent page records it in the
 * settled table.
 */
export function noteSettled(role: StageRole, clipIds: readonly string[]): void {
  const base = baselines[role];
  for (const id of clipIds) {
    base.settled.add(id);
  }
}

/**
 * After the K5 second-path swap in the paused state: the new `front` was re-run from the whole
 * background scene, and **the whole stage** is exact live render (root cause B).
 * While paused no card is suppressed any more, until the next `setTime` / playback.
 */
export function markAllSettled(role: StageRole): void {
  noteSettledLog("all", role, "");
  baselines[role].settledAll = true;
}

/**
 * "Drop the fallback once stopped" (product/rendering.md, last item of "Fallback order"): cards in
 * the paused state that have already caught up to exact live render are no longer covered by the
 * stream while paused.
 * Cleared on the next `setTime` (`clearSettled`) or on playback.
 */
/** Diagnostics: the most recent settled clears and sets (who, when), used by probes to investigate "placeholder removed, then covered again" */
const settledLog: { at: number; op: string; role: StageRole; why: string }[] = [];
function noteSettledLog(op: string, role: StageRole, why: string) {
  settledLog.push({ at: Math.round(performance.now()), op, role, why });
  if (settledLog.length > 30) settledLog.shift();
}
export function clearSettled(role: StageRole, why = ""): void {
  if (baselines[role].settled.size || baselines[role].settledAll) noteSettledLog("clear", role, why);
  const base = baselines[role];
  if (base.settled.size) base.settled = new Set();
  base.settledAll = false;
}

function isSettled(role: StageRole, clipId: string): boolean {
  const base = baselines[role];
  return base.settledAll || base.settled.has(clipId);
}

/* --------------------------------------------------------------- Per-tick snapshot swap (retired, signature kept for compatibility) */

let beatSwap = false;

export function setBeatSwap(on: boolean, _opts: { swapMs?: number; occupied?: (t: number) => number; costOf?: ((project: Project, clipId: string) => number) | null } = {}): void {
  beatSwap = !!on;
}

/** For probes to read */
export function beatSwapDebug() {
  return { on: beatSwap, swapMs: 0, perLayer: false, knownSizes: 0, last: null, deliveries: 0, underThrottle: 0, placeholders: 0 };
}

/** The top-to-bottom order of these cards: tracks follow their order in the project (the first track is on top), and within the same track later clips cover earlier ones */
export function topDownOrder(project: Project, clipIds: Iterable<string>): string[] {
  const want = new Set(clipIds);
  const out: string[] = [];
  for (const tr of project.tracks) {
    for (let i = tr.clips.length - 1; i >= 0; i--) {
      const id = tr.clips[i].id;
      if (want.has(id)) { out.push(id); want.delete(id); }
    }
  }
  for (const id of want) out.push(id);
  return out;
}

/* --------------------------------------------------------------- Frame picking and downgrade */

/** This layer's sampling window. `firstFrame` uses the same formula as the prerender process's `cardSampling(start, fps)` */
function samplingOf(clip: { start: number; end: number }, fps: number): { firstFrame: number; count: number } {
  const firstFrame = Math.max(0, Math.ceil(clip.start * fps - 1e-9));
  const phase = firstFrame / fps - clip.start;
  const count = Math.max(1, Math.ceil((clip.end - clip.start - phase) * fps - 1e-9));
  return { firstFrame, count };
}

/**
 * K6: cards that have been downgraded but whose dead media isn't ready yet. **Live-rendered as
 * usual** (the picture the user sees is unchanged, just possibly slow); only on the tick after
 * they become ready do they switch into `suppressed` / `streamPlanes`, the same mechanism as the
 * other heavy cards.
 *
 * Now that every card's HTML snapshot is void, only `streamLayers(project)` is consulted (the
 * segment containing each frame is ready).
 */
const pendingDemote = new Set<string>();

export function markPendingDemote(clipId: string): void {
  pendingDemote.add(clipId);
}

export function pendingDemotes(): ReadonlySet<string> {
  return pendingDemote;
}

/**
 * "Ready" is judged by the current playback position (mechanism/rendering.md, section "Downgrade";
 * root cause D): starting from the current position, `min(fps, clip remaining frames)` frames are
 * all covered by the track stream, by segment (every segment these frames fall in is within the
 * same stream's ready interval; for a group stream, count the members).
 */
function demoteReady(project: Project, clipId: string, globalFrame: number, localFrame: number, count: number, fps: number): boolean {
  const need = Math.max(0, Math.min(fps, count - localFrame) - 1);
  for (const layer of streamLayers(project)) {
    if (!layer.members.includes(clipId)) continue;
    // Which segments of this stream these frames fall in: converted from this stream's own first frame (frames before the first frame give negative segments, which are not in the ready interval)
    const firstSeg = streamSegmentOf(Math.max(0, globalFrame), layer.originFrame);
    const lastSeg = streamSegmentOf(Math.max(0, globalFrame + need), layer.originFrame);
    let all = true;
    for (let seg = firstSeg; seg <= lastSeg && all; seg++) all = rangesHave(layer.ranges, seg);
    if (all) return true;
  }
  return false;
}

/**
 * Cards that cannot run on this page in online browser mode (media effect cards, user cards that cannot run,
 * `placeholderHost.needsLocalPc`; C10 contract section 9; user cards that can run on this page do not count
 * since 2026-10-06):
 * if a prerender output exists, attach it as is, same as built-in cards. On this device they are **always
 * treated as heavy cards**: no matter what the dispatch table says (table not computed yet, old record says
 * light), they are suppressed during playback; when stopped they are not caught up (there is no component to
 * catch up), so the "exact" state (`settled`) in the paused state does not hold for them, and they always go
 * into scrub stream attachment or show a placeholder.
 * The decision rule is the same as the stage's (`localOnlyClipIds`); the switch is `setOnlineBrowserMode`,
 * which is always off on desktop, so here it is always an empty set.
 */
let localOnlyMemo: { project: Project; key: string; ids: ReadonlySet<string> } | null = null;
const NO_IDS: ReadonlySet<string> = new Set();
export function localOnlyOf(project: Project): ReadonlySet<string> {
  if (!onlineBrowserMode()) return NO_IDS;
  const key = `${cardsRegistryGen()}:${syncedUserCardsGen()}:${cardRunStatesGen()}`;
  if (localOnlyMemo && localOnlyMemo.project === project && localOnlyMemo.key === key) return localOnlyMemo.ids;
  // Cards inside cut segments count too (virtual clips in the flattened view, `kernel/cutFlatten.mjs`)
  const ids = localOnlyClipIds(flatPlanProject(project).tracks.flatMap((tr) => tr.clips));
  localOnlyMemo = { project, key, ids };
  return ids;
}

/**
 * Card clips active at this moment (same basis as the live path of `Stage` / `FrameScene`: includes LEAD).
 * A cut segment is replaced by the cards inside it (the flattened view of `kernel/cutFlatten.mjs`;
 * user decision, 2026-10-21: cards inside a cut segment behave as when there is no cut segment: light cards
 * are live rendered, heavy cards each attach their own stream, and show a placeholder when there is no stream)
 */
function activeCardClips(project: Project, t: number): TrackClip[] {
  const out: TrackClip[] = [];
  for (const tr of flatPlanProject(project).tracks) {
    if (tr.hidden) continue;
    for (const clip of tr.clips) {
      if (!clip.cardId && !clip.nodeId) continue;
      if (cardMountedAt(clip, t)) out.push(clip);
    }
  }
  return out;
}

/**
 * Whether this card inside a cut segment can produce its own single-card stream (standalone card; the kind
 * for which `soloStreamKind` in `streamPlanRules.mjs` returns `'flat'`).
 * The capability table uses the same algorithm as this card's node in the card graph (`cardCapabilities`)
 */
export function flatStreamable(clip: TrackClip): boolean {
  const def = clip.cardId ? getCard(clip.cardId) : undefined;
  return cardCapabilities(def, { ...def?.defaults, ...clip.params }, clip.parts as Parameters<typeof cardCapabilities>[2]).compositing === "independent";
}

export interface Playhead {
  project: Project;
  t: number;
  /** The suppression set exists only during playback (C5 / K5: no suppression while dragging or paused, attach streams instead) */
  playing: boolean;
  /**
   * There is only one stage: cards judged heavy are always suppressed during playback, dragging and pause
   * (`pumpFeed` of the parent page `Preview`);
   * when stopped, the stage catches up the current frame layer by layer (`settleLayers`), and layers that are
   * drawn take `settled` just like with two stages, without being covered by the stream again.
   */
  single?: boolean;
  /**
   * Attach only the sparse version (only one stage: lean mode and the lowest tier, i.e. devices whose stage gate
   * did not reach dual stage): stream planes carry `first` (each segment decodes only its first frame),
   * the budget uses `sparseStreamBudget`; the online source on the page side also takes only the sparse version
   * (`small` of `snapshotSource.ts`)
   */
  sparseOnly?: boolean;
}

export interface FeedPlan {
  /** Cards judged heavy at this moment (during playback this is the argument of `setSuppressed`, merged with the extra suppression of K3(b)) */
  heavy: string[];
  /** Snapshots have been removed, always an empty table (signature kept for backward compatibility) */
  picks: Map<string, Pick>;
  /** Gap reporting has been removed, always an empty array (signature kept for backward compatibility) */
  wanted: { clipId: string; frame: number }[];
  /**
   * Stream planes sent to the stage at this moment (already truncated by the budget of concurrent streams,
   * `planesWithinBudget`): the streams of heavy cards whose segment containing this frame is already ready.
   * Present during playback, pause and dragging. With only one stage each one carries `first` (the stage decodes
   * only the first frame of each segment).
   */
  streamPlanes: StreamPlaneRequest[];
  /**
   * The streams that exist for this frame but exceed the budget (each carries `over: true`). The stage builds no
   * decoder for them and only fetches the manifest; the placeholder is laid out by the position rectangle of the
   * segment containing this frame in the manifest. Sent to the stage together with `streamPlanes`
   * (`streamPlanesAt`).
   */
  overPlanes: StreamPlaneRequest[];
  /**
   * Cards the parent page should suppress while paused / dragging:
   * heavy cards that have not caught up to exact live render (and localOnly cards).
   * Those with a stream for this frame attach the stream; without a stream, a remotion-style card does not enter
   * scrub (the live component is exposed and computed on the spot), and other heavy cards enter scrub and show
   * a placeholder.
   * Always empty during playback (what is suppressed during playback is `heavy`).
   */
  scrub: string[];
}

/**
 * The delivery plan at this moment. **Pure computation, no fetch, no RPC**, so the acceptance probe can look
 * at it on its own.
 *
 * The fallback order (mechanism/rendering.md, "Fallback order") is on the parent page side:
 * stream planes carry only the streams that exist for this frame and are allowed by the decoder budget;
 * those over budget are marked `over`.
 */
export function planFeed({ project, t, playing, single, sparseOnly }: Playhead): FeedPlan {
  const plan = planDispatch.currentPlan();
  const fps = Math.max(1, project.fps || 30);
  const globalFrame = Math.max(0, Math.floor(t * fps + 1e-6));
  const heavy: string[] = [];
  const clips: { clip: TrackClip; firstFrame: number; count: number }[] = [];
  const localOnly = localOnlyOf(project);
  for (const clip of activeCardClips(project, t)) {
    // Cards that this device cannot run are always treated as heavy cards (online browser mode; see `localOnlyOf`)
    if (pipelineAt(plan, clip.id, t) !== "heavy" && !localOnly.has(clip.id)) continue;
    // Among cards inside cut segments only standalone cards produce streams (`'flat'` in `streamPlanRules.mjs`); the others (depending on a lower layer, source dependency, not reviewed) are still live rendered in the nested scene, not suppressed
    if (isFlatClipId(clip.id) && !flatStreamable(clip)) continue;
    const { firstFrame, count } = samplingOf(clip, fps);
    if (pendingDemote.has(clip.id)) {
      // K6: before the dead asset is ready, live render as usual, **do not enter heavy** (so it is not suppressed and no stream planes are sent)
      if (!demoteReady(project, clip.id, globalFrame, globalFrame - firstFrame, count, fps)) continue;
      pendingDemote.delete(clip.id);
    }
    heavy.push(clip.id);
    clips.push({ clip, firstFrame, count });
  }

  let streamPlanes: StreamPlaneRequest[] = [];
  let overPlanes: StreamPlaneRequest[] = [];
  const wantedStream = new Set<string>();
  const scrub = new Set<string>();
  const layers = streamLayers(project);
  if (layers.length) {
    const members = new Set(heavy);
    if (playing) for (const id of extraSuppressed) members.add(id);
    const all = streamPlanesFor(layers, members, globalFrame);
    const pixelsOf = new Map(layers.map((l) => [l.key, l.px]));
    streamPlanes = sparseOnly
      ? planesWithinBudget(all, STREAM_BUDGET_MIN_FPS, (p) => pixelsOf.get(p.key ?? ""), sparseStreamBudget())
      : planesWithinBudget(all, fps, (p) => pixelsOf.get(p.key ?? ""));
    if (streamPlanes.length < all.length) {
      const within = new Set(streamPlanes);
      overPlanes = all.filter((p) => !within.has(p)).map((p) => ({ ...p, over: true as const }));
    }
    if (sparseOnly) streamPlanes = streamPlanes.map((p) => ({ ...p, first: true as const }));
    for (const p of all) for (const id of p.clipIds) wantedStream.add(id);
    if (!playing) {
      for (const p of all) {
        if (p.clipIds.some((id) => !isSettled("front", id) || localOnly.has(id))) {
          for (const id of p.clipIds) scrub.add(id);
        }
      }
    }
  }

  if (!playing) {
    for (const { clip } of clips) {
      if (wantedStream.has(clip.id)) continue;
      if (!isSettled("front", clip.id) || localOnly.has(clip.id)) {
        const def = clip.cardId ? getCard(clip.cardId) : undefined;
        const isDirect = clipFrameMode(clip, def) === "direct";
        const runnableRemotion = isDirect && !localOnly.has(clip.id) && !single;
        if (!runnableRemotion) {
          if (costResolver && !localOnly.has(clip.id) && !single) {
            const record = costResolver(project, clip.id);
            const dual = dualStageResolver ? dualStageResolver() : true;
            if (!record || (record.vtOk === false && !dual)) {
              continue;
            }
          }
          scrub.add(clip.id);
        }
      }
    }
  }

  return { heavy: heavy.sort(), picks: new Map(), wanted: [], streamPlanes, overPlanes, scrub: [...scrub].sort() };
}

/**
 * Take the snapshots that this `setTime` can carry along (retired, signature kept for compatibility).
 * Only runs `clearSettled("front")` and returns an empty snapshot.
 */
export function pickForSetTime(head: Playhead): { snapshots: Record<string, string | null>; awaiting: string[] } {
  clearSettled("front", `setTime ${head.t}`);
  return { snapshots: {}, awaiting: [] };
}

/**
 * Deliver snapshots (retired, signature kept for compatibility).
 * Clears settled during playback and returns 0.
 */
export async function deliverSnapshots(_stage: StageRpcClient, role: StageRole, head: Playhead): Promise<number> {
  if (head.playing) clearSettled(role, "playing");
  return 0;
}

/**
 * K3(b): during playback, **light cards** with `vtOk = false` that are waiting for a background rerun must
 * also be suppressed (subtree hidden, `t` frozen).
 * It has no stream plane: while waiting, the stage shows a placeholder at its position (T4,
 * product/rendering.md, "Fallback order": "swap after the background stage reruns" is also opaque), so the
 * user does not see it jump through a wrong state. After the swap this set is cleared.
 */
let extraSuppressed: readonly string[] = [];
export function setExtraSuppressed(clipIds: readonly string[]): void {
  extraSuppressed = [...clipIds];
}

/**
 * R8: the stream planes at this moment (C3 final stage: synthesized from layers with `kind: 'stream'` in the
 * ready index): the streams of heavy cards that have a stream for this frame, present during playback, pause
 * and dragging,
 * **already truncated by the budget of concurrent streams** (`planesWithinBudget`, the same function as the
 * stage's); those over budget follow after them, carrying `over: true` (the stage takes only their manifests
 * to lay out placeholders).
 * The parent page, at the same place where it sends `setSuppressed(...)`, sends `setStreamPlanes(...)`
 * **before it** (the stage hides the live subtree only after the first frame of the stream is drawn).
 */
export function streamPlanesAt(head: Playhead): StreamPlaneRequest[] {
  const feed = planFeed(head);
  return feed.overPlanes.length ? [...feed.streamPlanes, ...feed.overPlanes] : feed.streamPlanes;
}

/**
 * Which cards to suppress at this moment. During playback: all heavy cards (C5 / K5), plus those waiting for
 * the swap after the background rerun.
 * Paused / dragging: heavy cards that have not caught up to exact live render (`FeedPlan.scrub`): attach the
 * stream or a placeholder, and do not expose live components that are not advanced into place.
 */
export function suppressedAt(head: Playhead): string[] {
  const feed = planFeed(head);
  if (!head.playing) return feed.scrub;
  if (!extraSuppressed.length) return feed.heavy;
  return [...new Set([...feed.heavy, ...extraSuppressed])].sort();
}

/** For tests */
export function resetSnapshotFeed(): void {
  stopSnapshotFeed();
  beatSwap = false;
  pendingDemote.clear();
  costResolver = null;
  dualStageResolver = null;
  source = new HttpSnapshotSource();
}

