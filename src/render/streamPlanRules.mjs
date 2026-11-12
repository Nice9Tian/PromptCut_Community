/**
 * Criteria for "which card produces which type of stream" when partitioning track streams: the
 * **sole source of truth**. Both prerender process and render host (`planStreams` in
 * `server/frame-stream.mjs`) and online page (`planPageStreams` in `src/online/pageStreamPlan.ts`)
 * fetch from here, so both sides judge "which streams occupy decoder budget, and which standalone cards
 * merge into group streams" identically: page only produces single-card streams for planar standalone
 * cards, but the two categories of cards that form solo streams (`soloStreamKind`) and below-dependent
 * streams (`belowTargets`) are also counted toward budget per the splitter's algorithm
 * (`docs/reports/AGENT-rr-page-plan-parity.md`).
 *
 * Originally written in `server/frame-stream.mjs`, moved here verbatim; re-exported there under original
 * name as before. Pure function: does not touch files, network, or registry.
 * `control` is an item in the card plan (`clipId`, `count`, `sampling`, `compositing`, or
 * `capabilities.compositing`); `clip` and `track` are clips and tracks in the project.
 */
import { mountFrameOf } from './frameWindow.mjs';
import { has3DFrameExpr, hasAnimatedFrameSize } from '../kernel/frameExpr.mjs';
import { activeCutKind } from '../kernel/camera.mjs';

/** Outer box uses 3D transform (at least one of `rotateX`, `rotateY`, `translateZ` is non-zero) */
export const frame3d = frame => !!(frame?.rotateX || frame?.rotateY || frame?.translateZ);

/**
 * Whether this card is a **planar standalone card** (the kind in single-card streams that can merge
 * with adjacent standalone cards into group streams). **Accepts only `independent`**: frosted glass
 * (`belowDependent`) needs to sample lower layers; `unknown` is always treated as `belowDependent`
 * (G1 "Which cards do not enter streams"). Source-dependent cards (transitions, media effect cards
 * connected to media) and standalone cards whose frame uses 3D (or belong to a `"3d"` cut) are not here:
 * they also produce single-card streams, but form solo streams without merging into group streams;
 * criteria are in `soloStreamKind` below.
 */
export function streamEligible(control, clip, track, project = null) {
  if (!control?.clipId || !clip || !track) return false;
  if (track.hidden || track.sourceOnly) return false;
  if (!clip.cardId) return false;
  // Cards flattened from cut segments form solo streams (`'flat'` in `soloStreamKind`) and do not merge into group streams
  if (clip.flat) return false;
  // In a 3D cut, each card is textured onto its own 3D board and must never merge into a 2D stage group stream
  if (project?.cutKind === '3d' || activeCutKind(project) === '3d') return false;
  if (hasAnimatedFrameSize(clip.frameExpr)) return false;
  const compositing = control.capabilities?.compositing ?? control.compositing;
  if (compositing !== 'independent') return false;
  if (frame3d(clip.frame) || has3DFrameExpr(clip.frameExpr)) return false;
  return Number.isInteger(control.count) && control.count > 0;
}

/** Card node in project whose `id` has this value (`project.cardNodes`; array, or object keyed by id in legacy data) */
export function cardNodeOf(project, nodeId) {
  if (typeof nodeId !== 'string' || !nodeId) return null;
  const raw = project?.cardNodes;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  return list.find(node => node?.id === nodeId) ?? null;
}

/**
 * Whether this clip is a **media effect card connected to inputs** (such as transitions or filters
 * applied to media): the node attached to the clip is a visual-producing media effect card node
 * (criteria same as `graphVisualNode` in `src/render/cards/GraphCard.tsx`), and it has inputs
 * (connected to media, connected to other clips, or connected to another media effect card;
 * even if the clip targeted by an input has been deleted, it still counts: the edge is still
 * recorded on the node). Media effect cards without inputs (those generating visuals themselves)
 * do not count.
 */
export function graphCardWithInputs(project, clip) {
  const node = cardNodeOf(project, clip?.nodeId);
  if (!node || node.adapter !== 'card' || node.kind === 'audio') return false;
  return !!node.inputs && typeof node.inputs === 'object' && Object.keys(node.inputs).length > 0;
}

/**
 * Two categories of cards that **form solo streams** (`docs/semantics/mechanism/rendering.md`
 * "Heavy pipeline: prerender", "How to produce, by card"; (user decision, 2026-10-13), Section 1,
 * Item 7 of `docs/plan/user-decisions-2026-10-13.md`). Each produces a single-card stream
 * (`kind: 'card'`, `plane: 'local'`, same shape as single-card streams of standalone cards, going
 * through the same set of sparse and full density versions, segments, position rectangles, and
 * task queues), except they do not participate in group stream merging and are not produced by
 * browsers (see below):
 *
 *   - `'source'` **Source-dependent card**: transitions, media effect cards applied onto video:
 *     visuals depend on other media or other clips. Rendered together with the video it uses:
 *     its source clips are kept in the isolated project (hidden tracks are `sourceOnly`, producing
 *     no visuals, reachable when the media effect card resolves inputs), and the stream contains
 *     the visuals of "video after passing through this card"; when pasted, this stream replaces
 *     the original visuals of this card (the kind applied onto video; this section of video was
 *     originally drawn by this card and is not drawn separately).
 *     Criteria: review table states `sourceDependent`; or not reviewed (`unknown`, legacy generic
 *     term `context`) while the clip has an attached media effect card node connected to inputs
 *     (`graphCardWithInputs`). Visuals of media effect cards are executed on canvas by the host
 *     according to its description and cannot sample lower layers, so they do not go through
 *     "below-dependent streams". The stream key carries the entire source chain along inputs
 *     (`streamMemberKey` in `CardFrameCache.plan`: the asset itself, asset trim start, time mapping
 *     of each input, parameters and source code versions of upstream cards); the page's input
 *     signature does the same (`src/render/layerInputSig.mjs`); if any changes, the old stream is
 *     no longer pasted;
 *   - `'spatial'` **Standalone card whose frame uses 3D transform**: the stream contains planar
 *     visuals before transform (in the isolated project, the frame retains only position, width,
 *     and height, `localClip`); when pasted, the stream plane is a child of the wrapper layer, and
 *     the wrapper layer carries 3D transform as usual, so visuals transform accordingly. The 3D
 *     properties do not enter the stream key (they are not in the stream).
 *
 *   - `'flat'` **Standalone card flattened from cut segments** (`src/kernel/cutFlatten.mjs`;
 *     (user decision, 2026-10-21): cards inside cut segments work the same as without cut segments,
 *     heavy cards each follow track streams): the stream contains visuals of this card in its own
 *     wrapper layer (identical for both planar and 3D frames; 3D properties are not in the stream);
 *     when pasted, the layers outside the nested scene (segment frame, opacity, fade in/out) are
 *     applied as usual. The isolated project producing the stream must carry this cut segment chain
 *     (`isolatedFlatProject`), so it is not merged into group streams (group streams are drawn in
 *     stage coordinates; cards in nested scenes cannot be placed in them). Browsers also produce
 *     those with planar frames ([ruling] R02: online browsers also produce streams for heavy cards
 *     in cut segments; those with 3D frames, like top-level `'spatial'`, are only produced by the
 *     desktop app and render host; see `browserStreamInputOf` in `render-node/split.mjs`). Accepts
 *     only standalone cards: below-dependent, source-dependent, or unreviewed cards inside cut
 *     segments do not produce streams and are live rendered in nested scenes as before ([ruling]
 *     R01 2026-10-23 (overruled by user, "producing stream with lower layers together", treated as
 *     unfeasible: frosted glass in nested scenes samples layers outside the segment through the cut
 *     segment; a stream carrying only lower layers in the segment does not match live render)).
 *
 * When both categories apply simultaneously, it counts as `'source'` (frame 3D is still not in the
 * stream). Other cards return null: planar standalone cards use `streamEligible`; below-dependent
 * cards and unreviewed cards without inputs use `belowStreamEligible` (regardless of whether the frame
 * has 3D: when 3D is present, 3D placement is rendered into the stream).
 *
 * Do not participate in group stream merging: group streams are produced in stage coordinates, and
 * members' appearance (including 3D) is fully rendered into the stream, which conflicts with "stream
 * contains visuals before transform"; source-dependent cards are mostly fully opaque, and merging them
 * into group streams would flatten layer relationships sandwiched in between. Each occupies one
 * decoder and counts toward the budget.
 *
 * Browsers do not produce them (except planar-frame ones in `'flat'`, see above): source-dependent
 * cards need to decode media and execute media effect cards; the browser's pixel-fetching path for cards
 * with 3D frames has not been verified; the browser portion cannot be split out (`browserStreamInputOf`
 * in `render-node/split.mjs`), and online pages producing streams locally do not recognize them either
 * (`src/online/pageStreamPlan.ts`), only counting them toward the budget.
 */
export function soloStreamKind(control, clip, track, project) {
  if (!control?.clipId || !clip || !track) return null;
  if (track.hidden || track.sourceOnly) return null;
  if (!clip.cardId) return null;
  if (hasAnimatedFrameSize(clip.frameExpr)) return null;
  if (!(Number.isInteger(control.count) && control.count > 0)) return null;
  const compositing = control.capabilities?.compositing ?? control.compositing;
  // Cards flattened from cut segments (`kernel/cutFlatten.mjs`, clips with `flat`): standalone cards form solo streams (see `'flat'` above); others do not produce streams
  if (clip.flat) return compositing === 'independent' ? 'flat' : null;
  if (compositing === 'sourceDependent') return 'source';
  const is3DCut = project?.cutKind === '3d' || activeCutKind(project) === '3d';
  if (compositing === 'independent') return (is3DCut || frame3d(clip.frame) || has3DFrameExpr(clip.frameExpr)) ? 'spatial' : null;
  if (compositing === 'belowDependent') return null;
  return graphCardWithInputs(project, clip) ? 'source' : null;
}

/**
 * Besides which cards are accepted by "below-dependent streams" (Section 5.1 of the contract),
 * whether the other two categories of cards enter:
 *   - `sourceDependent` (does not enter): source-dependent cards (transitions, media effect cards
 *     connected to media). (user decision, 2026-10-13) specified that they form solo streams
 *     (`soloStreamKind` above), so `planStreams` picks them out first;
 *   - `frame3d` (**enters**): **cards that are below-dependent (or unreviewed and not connected to
 *     inputs) whose frame also uses 3D transform**. Their visuals depend on what they cover on
 *     screen, and "visuals before transform" cannot be produced, so they are produced as normal
 *     below-dependent streams: in stage coordinates, 3D placement (`rotateX`, `rotateY`, `translateZ`,
 *     along with project perspective `camera3dFov`) is rendered into the stream as-is; when pasted,
 *     the plane is mounted under the stage root without further transform (stage perspective only
 *     acts on direct children with 3D transform; the plane has no transform and is unaffected).
 *     Consequence: changing the 3D angle requires the stream to be re-produced: the 3D properties
 *     are in the target card's cached content key (`appearance.frame` in `server/card-cache.mjs`) and
 *     in the page's input signature (`frame` in `streamInputSig.mjs`); modifying them changes both key
 *     and signature, so the old stream stops being pasted immediately. [ruling: lead session
 *     2026-10-14, settled on recommended "Jia", user can overturn; `AGENT-rr-below-3d.md`]
 *     Differential layer extraction still holds for it (both are whole screenshots calculated
 *     pixel-by-pixel, regardless of card placement); except masks for frosted-glass frames do not
 *     accept those with 3D (`axisAligned` in `capture-below.mjs`: frame is not a rounded rectangle
 *     after projection); that area is calculated using minimum opacity, and covering it back still
 *     equals the original visuals.
 * **Standalone cards** whose frame uses 3D do not take this path (their stream contains visuals before
 * transform, `'spatial'` in `soloStreamKind`), regardless of how this is set.
 */
export const BELOW_STREAM_RULES = Object.freeze({ sourceDependent: false, frame3d: true });

/**
 * From which moment playback mounting is calculated: clips flattened from cut segments (with `flat`)
 * start from the earliest moment the nested scene mounts (`flat.mount`; preroll will not be earlier
 * than it); other clips use themselves (returns the same object as-is). Verbatim identical to the
 * one with the same name in `server/frame-stream.mjs`; used by the online page when calculating budgets
 * (`src/online/pageStreamPlan.ts`; decoder windows for cards forming solo streams in cut segments are
 * calculated from this frame, matching the splitter).
 */
export function mountClipOf(clip) {
  const mount = clip?.flat?.mount;
  return Number.isFinite(mount) ? { ...clip, start: Math.min(clip.start, mount) } : clip;
}

/**
 * Whether this card enters "below-dependent streams". Accepts: cards whose lower-layer dependency is
 * "below-dependent" (`belowDependent`), the legacy generic term `context`, or "unknown" (`unknown`,
 * cards not covered by the review table; unwritten or unrecognized values are also treated as unknown);
 * also accepts those with 3D frames (`rules.frame3d`).
 * Standalone cards never enter here (planar ones go to single-card streams `streamEligible`, those
 * with 3D form solo streams `soloStreamKind`); source-dependent cards depend on `rules`.
 * Cannot be true simultaneously with `streamEligible`.
 */
export function belowStreamEligible(control, clip, track, rules = BELOW_STREAM_RULES, project = null) {
  if (!control?.clipId || !clip || !track) return false;
  if (track.hidden || track.sourceOnly) return false;
  if (!clip.cardId) return false;
  if (project?.cutKind === '3d' || activeCutKind(project) === '3d') return false;
  if (hasAnimatedFrameSize(clip.frameExpr)) return false;
  // Cards flattened from cut segments do not produce below-dependent streams (frosted glass in nested scenes live renders as before; [ruling] R01 2026-10-23 was overruled, treated as unfeasible)
  if (clip.flat) return false;
  const spatial = frame3d(clip.frame) || has3DFrameExpr(clip.frameExpr);
  if (spatial && rules?.frame3d !== true) return false;
  const compositing = control.capabilities?.compositing ?? control.compositing;
  if (compositing === 'independent') return false;
  else if (compositing === 'sourceDependent') { if (rules?.sourceDependent !== true) return false; }
  return Number.isInteger(control.count) && control.count > 0;
}

/**
 * Target cards that need to produce "below-dependent streams" in this version, in painter's order.
 * Each entry carries the `from..to` range where it occupies a decoder (same algorithm as
 * single-card streams).
 * `where`: clip id → `{ clip, track }`; `orderOf`: clip id → painter's order;
 * `taken`: cards that already formed solo streams (no longer produce this stream).
 */
export function belowTargets(plan, { picked, where, fps, total, orderOf, taken = null, project = null }) {
  const out = [];
  const seen = new Set();
  for (const control of plan) {
    if (!control?.clipId || seen.has(control.clipId) || taken?.has(control.clipId) || !picked(control.clipId)) continue;
    const at = where.get(control.clipId);
    if (!at || !belowStreamEligible(control, at.clip, at.track, BELOW_STREAM_RULES, project)) continue;
    const firstFrame = control.sampling?.firstFrame ?? Math.ceil(at.clip.start * fps - 1e-9);
    const lastFrame = Math.min(total - 1, firstFrame + control.count - 1);
    if (lastFrame < firstFrame) continue;
    seen.add(control.clipId);
    out.push({ control, clip: at.clip, order: orderOf.get(control.clipId) ?? 0, firstFrame, from: Math.min(mountFrameOf(at.clip, fps), firstFrame), to: lastFrame });
  }
  return out.sort((a, b) => a.order - b.order);
}
