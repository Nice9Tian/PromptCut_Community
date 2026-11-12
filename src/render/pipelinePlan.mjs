/**
 * K2 dispatch algorithm: optimization problem of "as many live-rendered cards as possible."
 * **Pure function; same code for browser and Node.**
 *
 * Both ends do not exchange dispatch tables, only synchronizing `costs` (and `tuning`): the page
 * uses it to decide how each tick renders, and the prerender process uses it to decide which cards
 * to prerender. Therefore, the same input must produce **field-by-field identical** tables on both
 * ends: here no reading files, no inspecting environment variables, no using `Date` /
 * `Math.random`, and no relying on the insertion order of any `Map` / `Set` (all containers to
 * iterate are sorted by clipId before creation).
 *
 * # Two things, do not confuse (task brief "Components and Terminology")
 *
 * - **Real-time classification** into light / heavy applies only to "(position, card)" and is
 *   computed dynamically per position: `segments[i].heavy` / `.light`, queried with `pipelineAt`.
 *   The hot stage uses it to decide whether to live render or paste dead assets.
 * - **Prerender set** `prerenderSet` is the static set of "which cards enter the prerender pipeline"
 *   = union of cards classified as heavy at any position. Cards in the set are prerendered for their
 *   **entire duration**, not trimmed by position. A card can be in the set while also being
 *   classified as light and live-rendered at certain positions.
 *
 * # Segmentation
 *
 * Boundaries = union of in points and out points of all card clips (pinned render 8), deduplicated
 * in ascending order; between two adjacent boundaries is a position.
 * Media clips (only `mediaId`, no `cardId` / `nodeId`) are not cards, and do not participate in
 * segmentation or dispatch.
 *
 * # How each position is computed
 *
 * Budget `B = 1000 / fps × 0.7` (pinned render 3: reserve 30% for asset layers, plane frame swaps,
 * and React itself).
 * First assign a weight per tick `w` to each active card (see `clipWeight`), then add them to the
 * light pipeline one by one in **ascending greedy order** by `w`, stopping condition:
 * `Σ w + Σ fixed costs of each heavy card > B` (`DEAD_MS` per card on desktop). Ascending greedy
 * order is optimal for "maximum count", so small and medium cards enter first while heavy cards are
 * crowded out; when all cards are heavy, the light pipeline may contain none.
 *
 * The sum contains `w` rather than bare `stepMs`: otherwise several tier-(b) cards would
 * simultaneously be classified as light, the real cost of this tick would be several times the
 * budget, dropping frames inevitably, and both ends would fail to compute the same table.
 */
import { cardCostKey } from './cardCostKey.mjs';
import { resolveTuning } from './pipelineTuning.mjs';
import { activeCutKind } from '../kernel/camera.mjs';

/**
 * Fixed cost (ms) of pasting one frame of dead asset per tick for a heavy card. `unknown` cards
 * are treated as `belowDependent` and paste local tier snapshots when classified as heavy, which
 * also includes this cost. Only L4 (online browser mode, without a prerender process and without
 * reconciling tables between both ends) uses `opts.deadMs` to replace it with measured frame swap cost.
 */
export const DEAD_MS = 0.3;

/**
 * Light/heavy classification determined by bounds search (when the online page has only one stage;
 * semantics in `product/platforms.md` "Online browser" -> "Light/heavy classification",
 * `mechanism/rendering.md` "Bounds search and cost records") and display for the lowest tier:
 * - Cards classified as heavy are pinned as heavy and do not participate in greedy selection;
 * - Cards classified as light (results of bounds search, `opts.searchLight`) have weight 0 and are not
 *   crowded out by budget: here light/heavy is determined per card, without greedy selection per position.
 */
const SEARCH_HEAVY = Object.freeze({ pinned: true, w: Infinity, tier: 'capped' });
const SEARCH_LIGHT = Object.freeze({ pinned: false, w: 0, tier: 'search-light' });

/** Frame catch-up upper bound (K2): advance at most 4 more local time steps per tick beyond current frame, catching up at most `2 × fps` ticks. */
export const CATCHUP_STEPS_PER_BEAT = 4;
export const maxCatchUpBeats = (fps) => 2 * fps;

/** Budget formula from pinned render 3. Leave `COST_SCALE` untouched (K2 "Tunable coefficients"). */
export const budgetOf = (fps) => (1000 / fps) * 0.7;

/** Whether this segment is a card clip (media clips have no cards and do not participate in dispatch) */
const isCardClip = (clip) => !!clip && typeof clip.id === 'string' && (typeof clip.cardId === 'string' || typeof clip.nodeId === 'string');

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** All card clips in the project, sorted by clipId (iteration order must be identical on both ends) */
function cardClipsOf(project) {
  const clips = [];
  for (const track of project?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (!isCardClip(clip)) continue;
      const start = Number(clip.start), end = Number(clip.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const in3dCut = clip.in3dCut === true || clip.flat?.in3dCut === true;
      clips.push({ id: clip.id, cardId: clip.cardId, nodeId: clip.nodeId, start, end, ...(in3dCut ? { in3dCut: true } : null) });
    }
  }
  return clips.sort((a, b) => byId(a.id, b.id));
}

/** `identityKeys` / `frameModes` accept both Maps and plain objects */
const lookup = (table, key) => {
  if (!table || !key) return undefined;
  if (typeof table === 'function') {
    try { return table(key); } catch { return undefined; }
  }
  if (typeof table.get === 'function') return table.get(key);
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
};

/** Determines whether a card is a standalone card in 3D mode (scene-3d itself is excluded outside) */
function isIndependentCard(clip, opts) {
  if (typeof opts.isIndependent === 'function') {
    try {
      const res = opts.isIndependent(clip) ?? (clip.id ? opts.isIndependent(clip.id) : undefined) ?? (clip.cardId ? opts.isIndependent(clip.cardId) : undefined);
      if (res !== undefined) return Boolean(res);
    } catch { return false; }
  }
  const comp = lookup(opts.compositing, clip.cardId) ?? lookup(opts.compositing, clip.id);
  if (typeof comp === 'string') return comp === 'independent';

  const caps = lookup(opts.capabilities, clip.cardId) ?? lookup(opts.capabilities, clip.id);
  if (caps && typeof caps === 'object' && typeof caps.compositing === 'string') {
    return caps.compositing === 'independent';
  }

  // When omitted, includes everything except scene-3d
  return true;
}

/**
 * Weight per tick of a card at any position, and "whether it is classified as heavy at every position."
 *
 * Weights are **identical** across positions (frame-push cards evaluate worst-case cost across the
 * entire segment; last sentence of pinned render 3). Only the greedy peers (other active cards at
 * that position) differ, so the same card may still be crowded out of the light pipeline at crowded
 * positions (this is the layer of dynamic per-position calculation in pinned render 8).
 *
 * `COST_SCALE` is multiplied into each **measured** cost (`stepMs` / `catchUpMs` / `seekMs`): both the
 * heavy classification comparison and the weight are multiplied. The frame catch-up bound step uses
 * the ratio `catchUpMs / (4 × stepMs)`; numerator and denominator are multiplied together, so it is
 * naturally unaffected.
 *
 * Exported only for diagnostics and unit tests ("which tier this card uses and its weight");
 * `planPipelines` uses the same copy internally.
 */
export function clipWeight(record, frameMode, fps, tuningOrOverrides) {
  const B = budgetOf(fps);
  const tuning = resolveTuning(tuningOrOverrides);
  const scale = tuning.COST_SCALE;

  /*
   * Cards without cost records fall back according to declarations (last paragraph of K1): `direct`
   * is considered light, the rest heavy, updated once probe results arrive.
   * The weight of `direct` is set to 0: its exact cost is not yet known, but it is declared as an
   * inexpensive random-access card, so place it at the front of greedy selection without consuming
   * budget; this is merely a fallback for the few seconds before a new card finishes measurement,
   * replaced with real `stepMs` as soon as the probe returns.
   */
  if (!record) {
    return frameMode === 'direct'
      ? { pinned: false, w: 0, tier: 'declared-light' }
      : { pinned: true, w: Infinity, tier: 'declared-heavy' };
  }

  const stepMs = (Number(record.stepMs) || 0) * scale;
  /*
   * `capped` (including `demoted` / `pinnedHeavy`) is classified as heavy at every position
   * (evaluation is still performed per position, with the result always heavy).
   * It recognizes both the flag written by the probe in the record and recalculates on the spot with
   * current fps and `COST_SCALE`: "changing `COST_SCALE` without restarts or code changes alters the
   * decision next time the project opens" relies on this recalculation rule.
   */
  if (record.capped === true || record.demoted === true || record.pinnedHeavy === true) return { pinned: true, w: Infinity, tier: 'capped' };
  if (stepMs > B) return { pinned: true, w: Infinity, tier: 'capped' };

  // Random-access card: weight is always stepMs
  if (record.kind === 'random') return { pinned: false, w: stepMs, tier: 'direct' };

  /*
   * (a') Can seek directly, and the worst-case seek (jumping directly from frame 0 to the last frame)
   * is within one tick's budget: weight `stepMs`; no matter how long the segment is, neither frame
   * catch-up nor dead assets are needed.
   * `seekMs: null` = that measurement pass exceeded the 200 ms cap and cost is unknown: do not
   * estimate linearly (which gives an optimistic lower bound); follow frame-push card rules across
   * the board, which is conservative, matching the standard when `catchUpMs` truncation extrapolates.
   * Those without a `seekOk` record are treated as `false`.
   */
  const rawSeek = record.seekMs;
  const seekMs = rawSeek === null || rawSeek === undefined ? null : Number(rawSeek) * scale;
  if (record.seekOk === true && seekMs !== null && Number.isFinite(seekMs) && seekMs <= B) return { pinned: false, w: stepMs, tier: 'seek' };

  // Frame-push card: evaluated by worst-case cost across the whole segment, uniform across positions
  const catchUpMs = (Number(record.catchUpMs) || 0) * scale;
  if (catchUpMs <= B) return { pinned: false, w: stepMs, tier: 'catchup-a' };          // (a) Catch up within one tick upon entering the clip
  const beats = stepMs > 0 ? catchUpMs / (CATCHUP_STEPS_PER_BEAT * stepMs) : Infinity;
  if (beats <= maxCatchUpBeats(fps)) return { pinned: false, w: (1 + CATCHUP_STEPS_PER_BEAT) * stepMs, tier: 'catchup-b' };
  // Exceeds frame catch-up upper bound: excluded from greedy selection, classified as heavy at every
  // position, enters prerender set for the entire segment
  return { pinned: true, w: Infinity, tier: 'over-catchup' };
}

/**
 * Dispatch table for K2.
 *
 * @param {any} project Project (only reads `id` / `cardId` / `nodeId` / `start` / `end` of
 *   `tracks[].clips[]`)
 * @param {any[]} costs Cost records from K1 (the copy returned by `GET /api/data/costs`, already
 *   filtered by current device / mode)
 * @param {number} fps Project frame rate
 * @param {object} [opts] `deadMs` (only L4 replaces with measured frame swap cost: number is the
 *   same for every card, function retrieves per clip), `tuning` (overrides or an already-resolved
 *   copy), `identityKeys` / `frameModes` (clip → cost record index; see `clipCostIndex`),
 *   `searchLight` (set of identityKeys of cards classified as light by bounds search; when
 *   provided, ignores cost records and declarations, cards in the set are classified as light at
 *   every position, all others classified as heavy at every position; `src/render/boundarySearch.mjs`),
 *   `allHeavy` (every card is classified as heavy at every position. Used by display for the lowest
 *   tier: never live renders during playback, only pastes prerender output; `currentPlan` in
 *   `src/editor/planDispatch.ts`; light/heavy classification itself checks `searchLight`),
 *   `includeLightCardsFor3D` / `view3d` (when 3D mode is enabled, includes standalone cards
 *   originally classified as light into the single-card track stream production plan prerenderSet;
 *   scene-3d itself is a true 3D mesh in the 3D view and remains excluded as usual, so that during
 *   3D view playback all card boards have track streams available to paste),
 *   `capabilities` / `compositing` / `isIndependent` (capability table / function to determine
 *   whether a card is a standalone card; when omitted, includes everything except scene-3d)
 */
export function planPipelines(project, costs, fps, opts = {}) {
  const rate = Math.max(1, Number(fps) || 30);
  // resolveTuning is idempotent (values within range are kept as is), so an already-resolved copy
  // remains unchanged if passed in again
  const tuning = resolveTuning(opts.tuning);
  /*
   * Fixed cost per tick for each heavy card. Number: same for each card (`DEAD_MS` on desktop,
   * `swapMs` in legacy online calls); function: retrieved per clip (frame swap cost by card kind
   * online, `SWAP_MS_BY_KIND` in `beatSwap.mjs`); falls back to `DEAD_MS` if no positive number is returned.
   */
  const deadFn = typeof opts.deadMs === 'function' ? opts.deadMs : null;
  const deadUniform = !deadFn && Number.isFinite(Number(opts.deadMs)) ? Number(opts.deadMs) : DEAD_MS;
  const deadOf = (clipId) => {
    if (!deadFn) return deadUniform;
    let v;
    try { v = Number(deadFn(clipId)); } catch { v = NaN; }
    return Number.isFinite(v) && v >= 0 ? v : DEAD_MS;
  };
  const B = budgetOf(rate);

  const clips = cardClipsOf(project);

  // Cost records are indexed by identityKey. If there are multiple entries for the same key
  // (should not happen; PUT deduplicates by (identityKey, device)), take the last entry,
  // consistent with upsert semantics.
  const byKey = new Map();
  for (const record of costs ?? []) {
    if (record && typeof record.identityKey === 'string') byKey.set(record.identityKey, record);
  }

  // Bounds search classification: identityKeys of cards classified as light
  const searchLight = opts.allHeavy !== true && opts.searchLight != null ? new Set(opts.searchLight) : null;

  // Compute weight for each card once (identical across positions)
  const weights = new Map();
  for (const clip of clips) {
    const key = lookup(opts.identityKeys, clip.id);
    const record = typeof key === 'string' ? byKey.get(key) : undefined;
    let weight;
    if (opts.allHeavy === true) weight = SEARCH_HEAVY;
    else if (searchLight) weight = typeof key === 'string' && searchLight.has(key) ? SEARCH_LIGHT : SEARCH_HEAVY;
    else weight = clipWeight(record, lookup(opts.frameModes, clip.id), rate, tuning);
    weights.set(clip.id, weight);
  }

  // Segment boundaries = union of in points and out points of all cards, deduplicated in ascending order
  const bounds = [...new Set(clips.flatMap((clip) => [clip.start, clip.end]))].sort((a, b) => a - b);

  const segments = [];
  const prerender = new Set();
  for (let i = 0; i + 1 < bounds.length; i++) {
    const fromSec = bounds[i], toSec = bounds[i + 1];
    // Boundaries are the union of in points and out points, so each card either covers this position
    // entirely or does not intersect it; checking the midpoint once is sufficient
    const mid = (fromSec + toSec) / 2;
    const active = clips.filter((clip) => clip.start <= mid && mid < clip.end);

    const pinnedCount = active.filter((clip) => weights.get(clip.id).pinned).length;
    const candidates = active.filter((clip) => !weights.get(clip.id).pinned)
      // Ascending greedy order; identical weights are ordered by clipId so both ends are field-by-field identical
      .sort((a, b) => weights.get(a.id).w - weights.get(b.id).w || byId(a.id, b.id));

    const light = new Set();
    let sum = 0;
    // Heavy cards remaining after inserting the i-th: those pinned + candidates ranked behind it.
    // Each calculates its own fixed cost (the old "heavy card count × deadMs" was a special case where
    // every card was identical)
    const pinnedDead = active.filter((clip) => weights.get(clip.id).pinned).reduce((acc, clip) => acc + deadOf(clip.id), 0);
    const restDead = new Array(candidates.length + 1).fill(0);
    for (let i = candidates.length - 1; i >= 0; i--) restDead[i] = restDead[i + 1] + deadOf(candidates[i].id);
    for (const [i, clip] of candidates.entries()) {
      // Light/heavy from bounds search is classified per card; cards classified as light are not crowded out by budget
      if (searchLight) { light.add(clip.id); continue; }
      const next = sum + weights.get(clip.id).w;
      if (next + pinnedDead + restDead[i + 1] > B) break;   // Stop when it no longer fits: subsequent ones will only be more expensive
      sum = next;
      light.add(clip.id);
    }

    const heavy = active.map((clip) => clip.id).filter((id) => !light.has(id));
    for (const id of heavy) prerender.add(id);
    // Sets are built after sorting by clipId so serialization is byte-for-byte identical on both ends
    segments.push({ fromSec, toSec, heavy: new Set(heavy.sort(byId)), light: new Set([...light].sort(byId)) });
  }

  const mirror = typeof globalThis !== 'undefined' ? (globalThis.__PC_LATEST_MIRROR__?.() ?? null) : null;
  const mirrorClips = (mirror?.project?.tracks ?? []).flatMap((t) => t?.clips ?? []) ?? [];
  const cardIdOfClip = (clip) => clip?.cardId ?? mirrorClips.find((c) => c?.id === clip?.id)?.cardId;

  const hasScene3d = clips.some((c) => cardIdOfClip(c) === 'scene-3d' || c.cardId === 'scene-3d' || c.nodeId === 'scene-3d')
    || mirrorClips.some((c) => c?.cardId === 'scene-3d');
  const is3DCut = opts.cutKind === '3d' || project?.cutKind === '3d' || activeCutKind(project) === '3d' || activeCutKind(mirror?.project) === '3d';
  const for3D = opts.includeLightCardsFor3D === true || opts.view3d === true || is3DCut || (opts.includeLightCardsFor3D !== false && hasScene3d);
  for (const clip of clips) {
    if (!for3D && clip.in3dCut !== true) continue;
    const cid = cardIdOfClip(clip);
    if (cid === 'scene-3d' || clip.cardId === 'scene-3d' || clip.nodeId === 'scene-3d') continue;
    if (isIndependentCard(clip, opts)) {
      prerender.add(clip.id);
    }
  }

  return { segments, prerenderSet: new Set([...prerender].sort(byId)) };
}

/**
 * Which pipeline the hot stage uses for a card at a given moment. Outside positions (the card is
 * inactive at this moment), returns `'light'`: inactive cards occupy neither pipeline, and callers
 * would not render them anyway.
 */
export function pipelineAt(plan, clipId, tSec) {
  const t = Number(tSec);
  for (const segment of plan?.segments ?? []) {
    if (!(t >= segment.fromSec) || !(t < segment.toSec)) continue;
    return segment.heavy.has(clipId) ? 'heavy' : 'light';
  }
  return 'light';
}

/**
 * Clip → node used for cost identity.
 *
 * 1. Node in the graph carrying this clip's `clipId` (base node synthesized by `cardGraph.mjs` for
 *    media clips and regular cards);
 * 2. If absent, check the clip's **own media effect card node** (the one pointed to by `clip.nodeId`,
 *    or `@clip/<id>/card` synthesized on the spot when only `cardId` exists): callers use
 *    `opts.ownNode(node, clip)` to specify whether it counts. Audio motion cards (visuals are
 *    components, with separate `audio()`) follow the media effect card branch; their nodes have no
 *    `clipId`, so before 2026-10-06 they had no cost identity, were never measured, and their
 *    visuals were always treated as heavy cards on both desktop and online. Their visuals are just
 *    a regular DOM card and can be measured, so `costIdentity.ts` returns true for them.
 *    Omitted `ownNode` = never counted (same as before).
 *
 * The node itself is untouched (do not write `clipId` onto the node): node content enters the key
 * of prerender output (`cardNodeIdentities` in `server/card-identity.mjs`), and changing it would
 * invalidate all existing prerender output. Cost keys already omit `clipId` (`cardCostKey`), and
 * `costKey` computed on the prerender process side from output nodes (`server/card-cache.mjs`) uses
 * the same node and the same key as here.
 *
 * @param {any} project
 * @param {any} graph
 * @param {{ ownNode?: (node: any, clip: any) => boolean }} [opts]
 * @returns {Map<string, any>} clipId → node
 */
export function clipCostNodes(project, graph, opts = {}) {
  const byClip = new Map(), byId = new Map();
  for (const node of graph?.nodes ?? []) {
    if (typeof node?.id === 'string') byId.set(node.id, node);
    if (typeof node?.clipId === 'string' && !byClip.has(node.clipId)) byClip.set(node.clipId, node);
  }
  const ownNode = typeof opts?.ownNode === 'function' ? opts.ownNode : null;
  if (ownNode) {
    for (const track of project?.tracks ?? []) {
      for (const clip of track?.clips ?? []) {
        if (!isCardClip(clip) || byClip.has(clip.id)) continue;
        // The node pointed to by the clip is not in the graph (the graph is flattened one step back
        // without card graph nodes, `costGraph` in `costIdentity.ts`): check the one synthesized on the spot
        const node = (typeof clip.nodeId === 'string' && clip.nodeId ? byId.get(clip.nodeId) : undefined) ?? byId.get(`@clip/${clip.id}/card`);
        if (node?.adapter === 'card' && ownNode(node, clip)) byClip.set(clip.id, node);
      }
    }
  }
  return byClip;
}

/**
 * Clip → cost record index (clip → node → `cardCostKey`, same standard as
 * `scripts/probe-card-costs.mjs`).
 *
 * `planPipelines` itself is a pure function and cannot reach the card registry, so "which card this
 * segment is, and what its source version is" is computed once by callers and passed into
 * `opts.identityKeys` / `opts.frameModes`. The page side already computes the same copy in
 * `ProbeGate` (used by the probe's "skip if already measured"), and the prerender process computes
 * it once at 4-frame batch boundaries.
 *
 * @param {any} project Project (needs `fps` and in/out points of each segment to calculate
 *   `durationFrames`)
 * @param {any} graph Result of `projectCardGraph(project, getCard)`
 * @param {(node: any) => string | null} [sourceVersionOf] Source version of that card (following the
 *   algorithm in `ExportView.tsx`)
 * @param {{ ownNode?: (node: any, clip: any) => boolean }} [opts] See `clipCostNodes`
 */
export function clipCostIndex(project, graph, sourceVersionOf = () => null, opts = {}) {
  const fps = Math.max(1, Number(project?.fps) || 30);
  const nodeByClip = clipCostNodes(project, graph, opts);
  const identityKeys = {}, frameModes = {};
  for (const track of project?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (!isCardClip(clip)) continue;
      const node = nodeByClip.get(clip.id);
      if (!node) continue;
      const mode = node.capabilities?.frameMode;
      if (typeof mode === 'string') frameModes[clip.id] = mode;
      const durationFrames = Math.max(1, Math.round((Number(clip.end) - Number(clip.start)) * fps));
      identityKeys[clip.id] = cardCostKey(node, sourceVersionOf(node), fps, durationFrames);
    }
  }
  return { identityKeys, frameModes };
}
