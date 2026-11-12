/**
 * The "input signature" (`inputSig`) for each row of the layer table `streams` table: digest of
 * that revision of project inputs that generated this track stream. The online page calculates the
 * same signature against the current project; if it mismatches, it is a stream from stale inputs
 * and will not be played (`mechanism/rendering.md` "Fallback order" rule "layers from stale inputs
 * are not pasted", applied here to streams).
 *
 * Why not directly use the snapshot layer's `clipInputSig` (`layerInputSig.mjs`): streams and
 * snapshots contain different things.
 *   - Snapshots are sampled by a clip's **local frames**, with position, scale, and fade not
 *     included in the snapshot, so the clip can still be pasted even when shifted by whole frames
 *     or moved;
 *   - Streams are segmented by **global frame numbers** (`streamPlayer.ts`), so if a clip moves on
 *     the timeline, every frame of the stale stream will no longer match the time;
 *   - Group streams are drawn in stage coordinates; member placement (position, scale, rotation,
 *     opacity, fade, motion) and stacking order between members are all drawn into the stream.
 *
 * Included in signature:
 *   - `clipInputSig` of each member (the clip's own input; see `layerInputSig.mjs` for criteria);
 *   - Sampling window of each member on the timeline: global frame number of the first frame, frame
 *     count (same as `cardSampling` in prerender), and which frame it is truncated to by the
 *     project duration;
 *   - Group streams additionally include: bounding box, opacity, fade, and motion of each member;
 *     id sequence of members sorted in painter's order; other frame layers sandwiched between
 *     members that overlap in time (must be empty when writing the layer table; if not empty on the
 *     page, someone inserted a layer into the middle of the group, and this group stream's
 *     stacking order is already invalid).
 *   - Below-dependent streams (`kind: 'below'`, Section 5.2 of
 *     `docs/plan/prerender-products-contract.md`) additionally include: target card's bounding box,
 *     opacity, fade, and motion (such streams are produced in stage coordinates, with appearance
 *     drawn into the stream); the clip signature, sampling window, bounding box, opacity, fade,
 *     and motion for each frame layer sorted below the target card in painter's order and
 *     overlapping it in time (`belowLayersOf`), listed in painter's order. If any lower layer
 *     changes its parameters, position, time, or stacking order, or if lower layers are added or
 *     removed, the signature changes; changes to layers above the target card are never included in
 *     the signature.
 * Excluded from signature: card source code, fonts, and environment (the page cannot obtain values
 * by the same criteria); when these change, render nodes rewrite the layer table with new keys.
 *
 * Signatures carry an algorithm version prefix (`s1-`), compared using the same logic as
 * `inputSigStale`: considered stale only when present on both sides, sharing the same version, and
 * differing.
 * Pure function; shared between the server (`layerMapOf` in `server/artifact-transfer.mjs`) and
 * the page (`snapshotSource.ts`).
 */
import { cardJson } from "../kernel/cardGraph.mjs";
import { hashString } from "./changedClips.mjs";
import { clipInputSig } from "./layerInputSig.mjs";
import { flatPlanProject } from "../kernel/cutFlatten.mjs";
import { hasFrameExpr } from "../kernel/frameExpr.mjs";

/** Version of signature algorithm; increment by one when signature inputs change */
export const STREAM_INPUT_SIG_VERSION = 1;
const PREFIX = `s${STREAM_INPUT_SIG_VERSION}-`;

/**
 * Clip sampling window (same formula as `samplingOf` in `snapshotFeed.ts` and `cardSampling` in
 * prerender), then truncated by project duration
 */
function windowOf(clip, fps, total) {
  const start = Number(clip.start) || 0;
  const end = Number(clip.end) || 0;
  const firstFrame = Math.max(0, Math.ceil(start * fps - 1e-9));
  const phase = firstFrame / fps - start;
  const count = Math.max(1, Math.ceil((end - start - phase) * fps - 1e-9));
  return { firstFrame, count, last: Math.min(total - 1, firstFrame + count - 1) };
}

/**
 * Relaxation margin (seconds) for "whether there is time overlap": cards are mounted this far
 * ahead of their in point (same as `CARD_MOUNT_LEAD` in `frameWindow.mjs`). Only used to determine
 * which lower layers count: better to count an extra layer (more invalidations) than to miss one.
 */
const BELOW_OVERLAP_LEAD = 0.05;

/**
 * Visual layers **below** this clip in painter's order that overlap with it in time, lower ones
 * first. Returns `{ clip, order, below: [{ id, clip, order }] }`; returns null when the clip is
 * not in the project, or does not produce visuals itself (its track is hidden).
 *
 * The identity of a "below-dependent stream" relies entirely on this: calculating stream keys on
 * the server (`planStreams` in `server/frame-stream.mjs`), building isolated projects
 * (`isolatedBelowProject`), and calculating input signatures on the page (`streamInputs` below) use
 * the exact same function, so all three places stay consistent on "which layers count as lower
 * layers, and who is below whom". Criteria:
 *   - Visual layer = its track is not hidden, duration is positive, and it is a card clip
 *     (`cardId`), a media effect card clip with an attached node (`nodeId`), or a visual media clip
 *     (asset is not audio-only); cut segments are flattened first (`flatPlanProject` in
 *     `kernel/cutFlatten.mjs`: replaced with the cards and assets inside them), so signatures and
 *     lower-layer determinations look at those inner layers; media effect card clips that only
 *     output audio are also included (cannot distinguish here whether it produces visuals), which
 *     only causes extra invalidations;
 *   - Painter's order matches `FrameScene`: earlier tracks in `project.tracks` are on top, and later
 *     clips in the same track are on top;
 *   - Time overlap is computed in seconds, relaxing both ends by a mount lead time. No further
 *     filtering by "whether it touches this area" (Section 5.2 of the contract: the first version
 *     prefers over-invalidation).
 * @param {any} project
 * @param {string} clipId
 */
export function belowLayersOf(raw, clipId) {
  // Replace cut segments with their inner layers (as-is if none); page and server take the same determination from here
  const project = flatPlanProject(raw);
  const tracks = Array.isArray(project?.tracks) ? project.tracks : [];
  const media = new Map((Array.isArray(project?.media) ? project.media : []).filter((m) => m && typeof m.id === "string").map((m) => [m.id, m]));
  const span = (clip) => ({ start: Number(clip.start) || 0, end: Number(clip.end) || 0 });
  const where = new Map();
  tracks.forEach((track, ti) => {
    (Array.isArray(track?.clips) ? track.clips : []).forEach((clip, ci) => {
      if (!clip || typeof clip.id !== "string" || where.has(clip.id)) return;
      const m = typeof clip.mediaId === "string" ? media.get(clip.mediaId) : null;
      const { start, end } = span(clip);
      const visual = !track?.hidden && !track?.sourceOnly && end > start && (!!clip.cardId || !!clip.nodeId || (!!m && m.kind !== "audio"));
      where.set(clip.id, { clip, order: (tracks.length - 1 - ti) * 1e6 + ci, visual });
    });
  });
  const at = where.get(clipId);
  if (!at || !at.visual) return null;
  const own = span(at.clip);
  const below = [];
  for (const [id, it] of where) {
    if (id === clipId || !it.visual || it.order >= at.order) continue;
    const s = span(it.clip);
    if (s.start - BELOW_OVERLAP_LEAD < own.end && s.end > own.start - BELOW_OVERLAP_LEAD) below.push({ id, clip: it.clip, order: it.order });
  }
  below.sort((a, b) => a.order - b.order);
  return { clip: at.clip, order: at.order, below };
}

/** Signature inputs for below-dependent streams: entry each for target card and lower layers (clip signature, sampling window, appearance) in painter's order. Returns null if uncomputable */
function belowInputs(project, clipId, fps, total) {
  const found = belowLayersOf(project, clipId);
  if (!found) return null;
  const describe = (id, clip) => {
    const sig = clipInputSig(project, id);
    if (!sig) return null;
    return { id, sig, window: windowOf(clip, fps, total), frame: clip.frame, ...(hasFrameExpr(clip.frameExpr) ? { frameExpr: clip.frameExpr } : {}), opacity: clip.opacity, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, motion: clip.motion };
  };
  const target = describe(clipId, found.clip);
  if (!target) return null;
  const below = [];
  for (const layer of found.below) {
    const item = describe(layer.id, layer.clip);
    if (!item) return null;
    below.push(item);
  }
  return { v: STREAM_INPUT_SIG_VERSION, kind: "below", members: [target], below };
}

/**
 * Signature input for this stream (the unhashed object); returns null if a member is not in the
 * project or if a member's clip signature cannot be computed. Exported for unit tests to inspect
 * criteria.
 * @param {any} project
 * @param {{ clipIds: readonly string[], kind?: string }} stream
 */
export function streamInputs(raw, stream) {
  const project = flatPlanProject(raw);
  const ids = Array.isArray(stream?.clipIds) ? stream.clipIds.filter((id) => typeof id === "string" && id) : [];
  if (!ids.length) return null;
  // Below-dependent streams: only target card as member; lower layers are project-defined (not listed in layer table row: must recognize added lower layers)
  if (stream?.kind === "below") {
    if (ids.length !== 1) return null;
    const rate = Math.max(1, Number(project?.fps) || 30);
    return belowInputs(project, ids[0], rate, Math.max(1, Math.floor((Number(project?.duration) || 0) * rate)));
  }
  const fps = Math.max(1, Number(project?.fps) || 30);
  const total = Math.max(1, Math.floor((Number(project?.duration) || 0) * fps));
  const tracks = Array.isArray(project?.tracks) ? project.tracks : [];
  const media = new Map((Array.isArray(project?.media) ? project.media : []).filter((m) => m && typeof m.id === "string").map((m) => [m.id, m]));
  /** Clip id → { clip, order, visual }; `order` is painter's order (first track on top, later clips cover earlier ones in same track) */
  const where = new Map();
  tracks.forEach((track, ti) => {
    (Array.isArray(track?.clips) ? track.clips : []).forEach((clip, ci) => {
      if (!clip || typeof clip.id !== "string" || where.has(clip.id)) return;
      const m = typeof clip.mediaId === "string" ? media.get(clip.mediaId) : null;
      const visual = !track.hidden && !track.sourceOnly && (!!clip.cardId || !!clip.nodeId || (!!m && m.kind !== "audio"));
      where.set(clip.id, { clip, order: (tracks.length - 1 - ti) * 1e6 + ci, visual });
    });
  });
  const group = stream?.kind === "group" || ids.length > 1;
  const members = [];
  for (const id of ids) {
    const at = where.get(id);
    if (!at) return null;
    const sig = clipInputSig(project, id);
    if (!sig) return null;
    const { clip } = at;
    members.push({
      id, sig, window: windowOf(clip, fps, total),
      ...(group ? { frame: clip.frame, ...(hasFrameExpr(clip.frameExpr) ? { frameExpr: clip.frameExpr } : {}), opacity: clip.opacity, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, motion: clip.motion } : {}),
    });
  }
  if (!group) return { v: STREAM_INPUT_SIG_VERSION, kind: "card", members };
  const set = new Set(ids);
  const orders = ids.map((id) => where.get(id).order);
  const lo = Math.min(...orders), hi = Math.max(...orders);
  const from = Math.min(...ids.map((id) => Number(where.get(id).clip.start) || 0));
  const to = Math.max(...ids.map((id) => Number(where.get(id).clip.end) || 0));
  const between = [];
  for (const [id, at] of where) {
    if (set.has(id) || !at.visual || at.order <= lo || at.order >= hi) continue;
    if ((Number(at.clip.start) || 0) < to && (Number(at.clip.end) || 0) > from) between.push(id);
  }
  return {
    v: STREAM_INPUT_SIG_VERSION, kind: "group", members,
    paint: [...ids].sort((a, b) => where.get(a).order - where.get(b).order),
    between: between.sort(),
  };
}

/**
 * Input signature of this stream (`s1-<16-digit hex>`); returns null if cannot be computed
 * (no comparison).
 * @param {any} project
 * @param {{ clipIds: readonly string[], kind?: string }} stream
 * @returns {string | null}
 */
export function streamInputSig(project, stream) {
  try {
    const inputs = streamInputs(project, stream);
    if (!inputs) return null;
    return PREFIX + hashString(cardJson(inputs));
  } catch {
    return null;
  }
}

/** Signatures from layer table row vs page: both exist, same algorithm version, and differ → stream is expired. Otherwise not expired (backward compatibility) */
export function streamSigStale(rowSig, pageSig) {
  if (typeof rowSig !== "string" || typeof pageSig !== "string") return false;
  if (!rowSig.startsWith(PREFIX) || !pageSig.startsWith(PREFIX)) return false;
  return rowSig !== pageSig;
}
