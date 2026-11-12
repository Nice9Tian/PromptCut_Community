/**
 * "Input signature" (`inputSig`) of a layer table entry: generates a digest of this layer's clip
 * inputs, which the page computes against the current project to compare and recognize whether that
 * layer in the layer table is the prerender output of **this clip version** (semantics
 * `product/rendering.md` "Fallback order", `product/platforms.md` "Online browser mode": paste as-is
 * only when prerender output exists for this frame; a layer with old parameters is not the output
 * of this frame).
 *
 * Why not compare keys directly: the online page cannot compute layer keys: the key includes the
 * render node's environment fingerprint, card code version, and font fingerprint, and the page
 * cannot run user cards either (C10 contract section 5 "Page does not compute keys"). The signature
 * only takes the part available to both sides that members can modify: clip inputs in project data.
 * When the render node writes the layer table, it computes against its acknowledged project version
 * (`entry.project`), while the page computes against its own project; both sides produce the same
 * signature for the same project data.
 *
 * Included in signature (aligned with "the project data half" in `cardSnapshotIdentity` of the
 * shared snapshot key `server/card-identity.mjs`):
 *   - Clip: `cardId`, `params`, `parts`, `emphasis`, `mediaId`, `mediaOffset`, speed `speed`
 *     (when not 1), `filter`, `pixelMap`, box width/height (`frame.w` / `frame.h`), duration
 *     (`end - start`), sampling phase (fractional part of `start` in the frame grid);
 *   - Library entries referenced by clip: the entry in `project.filters` / `project.pixelMaps`,
 *     asset `hash` (or id if absent);
 *   - Media effect card (`nodeId`): this node in `project.cardNodes` and nodes reachable along
 *     `inputs`; when an input points to another clip (`@clip/<id>/…`), recursively fetch that clip's
 *     signature inputs, plus its start offset relative to this clip;
 *   - Project: aspect ratio width/height, fps, `camera3dFov`, `themeId`, `style`;
 *   - Cards flattened out of cut segments (virtual clips in `kernel/cutFlatten.mjs`): its `flat`
 *     (local time when start is exposed, which cut segment layers it passed through).
 * Excluded from signature: x / y / anchor point / scale / rotation, opacity, fade in/out, motion,
 * volume and audio effects, whole-frame translation of clips on timeline: they are not in the
 * snapshot (A2(5)); when modified, the original layer is still pasted as-is. Card source code,
 * fonts, and environment are excluded from signature (the page cannot obtain values with the same
 * criteria): when these change, the page updates after the render node changes keys and rewrites
 * the layer table (just like before).
 *
 * Signatures carry an algorithm version prefix (`i1-`); the page only compares signatures of the
 * same version, and skips comparison when versions differ or either side lacks a signature (paste
 * as-is as before, backwards compatible). Hashing uses `hashString` from `changedClips.mjs`
 * (dual-channel FNV-1a, 64-bit): the requirement is "do both sides compute the same value?", not
 * collision resistance; both the page and Node can compute synchronously.
 *
 * Pure function, does not import editor; shared between server (`layerMapOf` in
 * `server/artifact-transfer.mjs`) and page (`snapshotSource.ts`, `src/export/originals.ts`).
 */
import { cardJson } from "../kernel/cardGraph.mjs";
import { hashString } from "./changedClips.mjs";
import { speedKeyPart } from "../kernel/clipTime.mjs";
import { stripOuterFrameExpr } from "../kernel/frameExpr.mjs";

/** Version of signature algorithm; increment by one when signature inputs change */
export const LAYER_INPUT_SIG_VERSION = 1;
const PREFIX = `i${LAYER_INPUT_SIG_VERSION}-`;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Fractional part of start point in frame grid (one-millionth of a frame, integer): invariant under whole-frame translation, changes with sub-frame shifts (sampling phase goes into shared snapshot key) */
function phaseOf(start, fps) {
  const x = Number(start) * fps;
  if (!Number.isFinite(x)) return null;
  const first = Math.ceil(x - 1e-9);
  return Math.round((first - x) * 1e6);
}

function clipsOf(project) {
  const out = new Map();
  for (const track of Array.isArray(project?.tracks) ? project.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
      if (clip && typeof clip.id === "string" && !out.has(clip.id)) out.set(clip.id, clip);
    }
  }
  return out;
}

function nodesOf(project) {
  const raw = project?.cardNodes;
  const list = Array.isArray(raw) ? raw : isObj(raw) ? Object.values(raw) : [];
  const out = new Map();
  for (const node of list) if (node && typeof node.id === "string" && !out.has(node.id)) out.set(node.id, node);
  return out;
}

const libraryEntry = (list, ref) => {
  const id = isObj(ref) ? ref.id : undefined;
  if (typeof id !== "string") return undefined;
  return (Array.isArray(list) ? list : []).find((x) => x?.id === id) ?? null;
};

/**
 * Signature inputs for this clip (unhashed object); returns null if clip is not in project.
 * Exported for unit tests to inspect criteria.
 * @param {any} project
 * @param {string} clipId
 */
export function clipInputs(project, clipId) {
  const clips = clipsOf(project);
  const nodes = nodesOf(project);
  const media = new Map((Array.isArray(project?.media) ? project.media : []).filter((m) => m && typeof m.id === "string").map((m) => [m.id, m]));
  const fps = Math.max(1, Number(project?.fps) || 30);

  const describeClip = (clip, seen) => {
    if (seen.has(`clip:${clip.id}`)) return { cycle: true };
    const inner = new Set(seen).add(`clip:${clip.id}`);
    const start = Number(clip.start) || 0;
    const mediaEntry = typeof clip.mediaId === "string" ? media.get(clip.mediaId) : undefined;
    return {
      cardId: clip.cardId, params: clip.params, parts: clip.parts, emphasis: clip.emphasis,
      mediaId: clip.mediaId, mediaOffset: clip.mediaOffset,
      // Clip speed: only included when not 1 (`speedKeyPart` in `kernel/clipTime.mjs`); default 1 signature is unchanged verbatim
      ...speedKeyPart(clip),
      media: clip.mediaId === undefined ? undefined : mediaEntry ? (mediaEntry.hash ?? mediaEntry.id) : null,
      filter: clip.filter, filterDef: clip.filter ? libraryEntry(project?.filters, clip.filter) : undefined,
      pixelMap: clip.pixelMap, pixelMapDef: clip.pixelMap ? libraryEntry(project?.pixelMaps, clip.pixelMap) : undefined,
      size: isObj(clip.frame) ? { w: clip.frame.w, h: clip.frame.h } : undefined,
      ...(stripOuterFrameExpr(clip.frameExpr) ? { sizeExpr: stripOuterFrameExpr(clip.frameExpr) } : null),
      duration: (Number(clip.end) || 0) - start,
      phase: phaseOf(start, fps),
      node: typeof clip.nodeId === "string" && clip.nodeId ? describeNode(clip.nodeId, inner, start) : undefined,
      // Cards flattened from cut segments (`kernel/cutFlatten.mjs`): head trimmed amount, which segment layers it passed through. Top-level clips lack this entry, leaving signature unchanged
      ...(clip.flat && typeof clip.flat === "object" ? { flat: clip.flat } : null),
    };
  };

  const describeRef = (nodeId, seen, selfStart) => {
    if (nodes.has(nodeId)) return describeNode(nodeId, seen, selfStart);
    const m = /^@clip\/([^/]+)\/(.+)$/.exec(nodeId);
    const other = m ? clips.get(m[1]) : undefined;
    if (other) return { clip: describeClip(other, seen), part: m[2], rel: (Number(other.start) || 0) - selfStart };
    return { missing: nodeId };
  };

  const describeNode = (nodeId, seen, selfStart) => {
    if (seen.has(`node:${nodeId}`)) return { cycle: nodeId };
    const inner = new Set(seen).add(`node:${nodeId}`);
    const node = nodes.get(nodeId);
    if (!node) return describeRef(nodeId, inner, selfStart);
    const { id: _id, inputs, ...rest } = node;
    const described = {};
    for (const [name, ref] of Object.entries(isObj(inputs) ? inputs : {})) {
      const target = typeof ref === "string" ? ref : isObj(ref) && typeof ref.nodeId === "string" ? ref.nodeId : null;
      if (!target) { described[name] = { bad: true }; continue; }
      described[name] = { ref: describeRef(target, inner, selfStart), offset: isObj(ref) ? ref.offset : undefined, rate: isObj(ref) ? ref.rate : undefined };
    }
    return { ...rest, inputs: described };
  };

  const clip = clips.get(clipId);
  if (!clip) return null;
  return {
    stage: { width: project?.width, height: project?.height, fps: project?.fps, camera3dFov: project?.camera3dFov, themeId: project?.themeId, style: project?.style },
    clip: describeClip(clip, new Set()),
  };
}

/**
 * Input signature of clip (`i1-<16-digit hex>`); returns null (no comparison) if clip is not in
 * project or input contains unserializable values.
 * @param {any} project
 * @param {string} clipId
 * @returns {string | null}
 */
export function clipInputSig(project, clipId) {
  try {
    const inputs = clipInputs(project, clipId);
    if (!inputs) return null;
    return PREFIX + hashString(cardJson(inputs));
  } catch {
    return null;
  }
}

/**
 * Signature of that layer in layer table vs page-computed signature: both exist, same algorithm
 * version, and differ → this layer is expired (not the output of this clip version).
 * Either side lacks a signature, or versions differ → not judged expired (paste as-is as before:
 * backwards compatible with old layer tables, old pages, and old nodes).
 * @param {unknown} layerSig
 * @param {unknown} pageSig
 */
export function inputSigStale(layerSig, pageSig) {
  if (typeof layerSig !== "string" || typeof pageSig !== "string") return false;
  if (!layerSig.startsWith(PREFIX) || !pageSig.startsWith(PREFIX)) return false;
  return layerSig !== pageSig;
}

/** A clipId → signature cache per project (immutable object): does not recompute unless project object reference changes */
const cache = new WeakMap();
/**
 * Cached `clipInputSig` (the page queries every tick; store does not mutate project in place,
 * so caching by object reference avoids reading stale values).
 * @param {any} project
 * @param {string} clipId
 */
export function cachedClipInputSig(project, clipId) {
  if (!project || typeof project !== "object") return null;
  let byClip = cache.get(project);
  if (!byClip) { byClip = new Map(); cache.set(project, byClip); }
  if (byClip.has(clipId)) return byClip.get(clipId);
  const sig = clipInputSig(project, clipId);
  byClip.set(clipId, sig);
  return sig;
}
