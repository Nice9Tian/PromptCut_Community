/**
 * Cut segment: a clip placed in a cut track that references another cut (`product/project-model.md`
 * "Cut", "Clip").
 *
 * # Storage
 *
 * A cut segment is an ordinary `TrackClip`, except it has neither `cardId` (empty string) nor
 * `mediaId`; instead it carries `cutId` (which cut is referenced) and `cutOffset` (start second
 * in referenced cut, default 0). Box, fades, opacity, independent mute (`audioMuted`), and volume
 * (`audioVolume`) share the same names and meanings as media clips.
 * Referenced rather than copied: when referenced cut changes, visuals and audio referencing it
 * update together everywhere.
 *
 * When read by pages from 0.7.18 or earlier: `flattenOverlay` skips clips without `cardId`, and
 * `videoLayersAt` skips clips without `mediaId`, so they simply do not render or produce sound while
 * fields are preserved as is (verified against Argon review comments Section 3 Decision 7).
 *
 * # How visuals are rendered (`mechanism/rendering.md` "Cut segment")
 *
 * The render side does not split cut segments into ordinary clips, but treats it as a "card":
 * `flattenOverlay` yields a timeline clip with `cardId: CUT_SEGMENT_CARD`, attaching the sub-project
 * of the referenced cut (`cut` field). Stage gives it a normal card wrapper layer (box, opacity,
 * fades, and layer order are all identical to cards); inside the wrapper layer hangs a nested scene,
 * rendering full frames of referenced cut at `cutOffset + (t - segment start)`. Preview, export,
 * prerender, and Agent frame viewing all go through the same `FrameScene` / `Stage`, so the same
 * moment produces the same frame.
 *
 * # How audio is produced
 *
 * On the audio side there is no "nested scene" to mount, so audible clips from referenced cut
 * are time-shifted and clipped into the segment window, assembled into a project used solely for
 * mixing (`audioProjectOf`). Fades of each cut segment layer are written as envelopes (`cutEnv`),
 * multiplied by `opacityAt` and individual mixers.
 *
 * Pure functions, does not touch store. Directly testable in node (`cutSegments.test.mjs`).
 */
import type { Cut, Project, Track, TrackClip } from "./project.ts";
import type { Transition } from "./transitions.ts";

/** Card id for cut segments in timeline (`Timeline`). Not in registry; Stage recognizes it by `clip.cut` */
export const CUT_SEGMENT_CARD = "@cut";

/** Fallback when parked cut lacks duration; same number as new cut default duration in `cuts.ts` */
const FALLBACK_CUT_DURATION = 30;

/** Hard limit on nesting depth. Normal projects never reach it (cycle prevention bounds depth to cut count); only guards against bad data stalling render */
export const MAX_CUT_DEPTH = 32;

import type { CutEnvelope } from "./cutAudio.mjs";
import { clipFrameMode } from "./frameMode.mjs";
import { getCard } from "./registry.ts";

/** Whether this clip is a cut segment */
export function isCutSegment(c: { cutId?: unknown } | null | undefined): boolean {
  return !!c && typeof c.cutId === "string" && c.cutId.length > 0;
}

/**
 * Once placed, which cut a cut segment references cannot be changed (user decision, 2026-10-21;
 * `workflow/editing.md` "Cut segment properties", `product/project-model.md` "Clip").
 * The properties panel has no UI to change references; returned if Agent's `set_cut_segment` has
 * `cutId` / `name` or store action has `cutId`.
 */
export const CUT_SEGMENT_REF_FIXED = "The cut referenced by a cut segment cannot be changed; to replace it, delete this segment and place a new one with add_cut_segment";

/** Currently active cut id (returns undefined for legacy projects without `cuts`) */
export function activeCutIdOf(p: Pick<Project, "cuts" | "activeCutId">): string | undefined {
  const cuts = Array.isArray(p.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

export interface CutContent {
  id: string;
  name: string;
  tracks: Track[];
  duration: number;
  transitions: Transition[];
}

/**
 * Content of a cut. Active cut lives on `Project.tracks`, parked cuts in respective entries
 * (storage format in `kernel/cuts.ts`).
 * Returns null when not found or parked entry lacks `tracks` (bad data): caller handles as
 * "dangling reference" without throwing.
 */
export function cutContent(p: Project, cutId: string): CutContent | null {
  const cuts = Array.isArray(p.cuts) ? p.cuts : [];
  const entry = cuts.find((c) => c.id === cutId);
  if (!entry) return null;
  if (cutId === activeCutIdOf(p)) {
    return { id: entry.id, name: entry.name, tracks: p.tracks, duration: p.duration, transitions: Array.isArray(p.transitions) ? p.transitions : [] };
  }
  if (!Array.isArray(entry.tracks)) return null;
  return {
    id: entry.id, name: entry.name, tracks: entry.tracks,
    duration: typeof entry.duration === "number" && entry.duration > 0 ? entry.duration : FALLBACK_CUT_DURATION,
    transitions: Array.isArray(entry.transitions) ? entry.transitions : [],
  };
}

/** Total cut duration (displayed in media library, default cut segment length when dragged in); returns 0 if not found */
export function cutDuration(p: Project, cutId: string): number {
  return cutContent(p, cutId)?.duration ?? 0;
}

/** Cut IDs directly referenced in a set of tracks (deduplicated, in order of appearance) */
export function segmentTargets(tracks: readonly Track[] | undefined): string[] {
  const out: string[] = [];
  for (const tr of tracks ?? []) for (const c of tr.clips ?? []) {
    if (isCutSegment(c) && !out.includes(c.cutId!)) out.push(c.cutId!);
  }
  return out;
}

/** Whether this track set has cut segments (if none, nothing to expand and caller returns as is) */
export function hasCutSegments(tracks: readonly Track[] | undefined): boolean {
  for (const tr of tracks ?? []) for (const c of tr.clips ?? []) if (isCutSegment(c)) return true;
  return false;
}

/** Reference graph: which cuts are directly referenced by each cut */
export function cutEdges(p: Project): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const c of Array.isArray(p.cuts) ? p.cuts : []) {
    const content = cutContent(p, c.id);
    edges.set(c.id, content ? segmentTargets(content.tracks) : []);
  }
  return edges;
}

/** Cut IDs reachable from `from` (including cuts it references, cuts referenced by those... at any depth); excludes `from` itself unless cyclic */
export function reachableCuts(p: Project, from: string, edges: Map<string, string[]> = cutEdges(p)): Set<string> {
  const seen = new Set<string>();
  const stack = [...(edges.get(from) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of edges.get(id) ?? []) if (!seen.has(next)) stack.push(next);
  }
  return seen;
}

/**
 * Whether placing cut `child` into cut `host` would cause a circular reference: placing into
 * itself, or `child` already references `host` (at any depth).
 * If so, returns a human-readable reason; returns null if not. Drag-and-drop, Agent tools,
 * and document write share this check.
 */
export function cutCycleReason(p: Project, hostCutId: string, childCutId: string): string | null {
  const name = (id: string) => (Array.isArray(p.cuts) ? p.cuts.find((c) => c.id === id)?.name : undefined) ?? id;
  if (hostCutId === childCutId) return `Cannot place cut "${name(childCutId)}" inside itself`;
  const edges = cutEdges(p);
  const reach = reachableCuts(p, childCutId, edges);
  if (reach.has(hostCutId)) {
    const direct = (edges.get(childCutId) ?? []).includes(hostCutId);
    return direct
      ? `Cut "${name(childCutId)}" already references "${name(hostCutId)}"; placing it here would create a circular reference`
      : `Cut "${name(childCutId)}" indirectly references "${name(hostCutId)}"; placing it here would create a circular reference`;
  }
  return null;
}

/** Existing circular references in project (can be produced by collaborative merges): reports each cycle once, for check and repair */
export function cutCycles(p: Project): string[][] {
  const edges = cutEdges(p);
  const out: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 0) visit(next);
      else if (s === 1) out.push(stack.slice(stack.indexOf(next)));
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of edges.keys()) if ((state.get(id) ?? 0) === 0) visit(id);
  return out;
}

/**
 * Read-only "view of project when switched to cut `cutId`": `tracks` / total duration / transitions
 * are replaced with that cut's content, while remaining project-level fields stay as is.
 * Used where calculations must be done based on "the cut where clip resides" (e.g. generating card
 * audio in referenced cut before export: identity and synthesis are calculated using this cut's
 * tracks, giving the same result as user switching over and generating). Active cut is returned
 * as is; returns null if not found. Not persisted to disk, not added to store.
 */
export function cutViewProject(p: Project, cutId: string): Project | null {
  if (!cutId || cutId === activeCutIdOf(p)) return p;
  const content = cutContent(p, cutId);
  if (!content) return null;
  return {
    ...p,
    tracks: content.tracks,
    duration: content.duration,
    transitions: content.transitions,
    activeCutId: cutId,
    cuts: (p.cuts ?? []).map((c) => {
      if (c.id !== cutId) return c;
      const { tracks: _t, duration: _d, transitions: _x, t: _pt, ...rest } = c;
      return rest;
    }) as Cut[],
  };
}

/** Finds clip in cut `cutId` (defaults to active cut); returns read-only view of that cut and the clip */
export function findClipInCut(p: Project, cutId: string | undefined, clipId: string): { view: Project; track: Track; clip: TrackClip } | null {
  const view = cutId ? cutViewProject(p, cutId) : p;
  if (!view) return null;
  for (const track of view.tracks) for (const clip of track.clips) if (clip.id === clipId) return { view, track, clip };
  return null;
}

/** Cuts that directly reference cut `cutId`, and which segments in each */
export function cutReferences(p: Project, cutId: string): { cutId: string; name: string; clipIds: string[] }[] {
  const out: { cutId: string; name: string; clipIds: string[] }[] = [];
  for (const c of Array.isArray(p.cuts) ? p.cuts : []) {
    const content = cutContent(p, c.id);
    if (!content) continue;
    const clipIds = content.tracks.flatMap((tr) => tr.clips.filter((cl) => cl.cutId === cutId).map((cl) => cl.id));
    if (clipIds.length) out.push({ cutId: c.id, name: c.name, clipIds });
  }
  return out;
}

/* ───────────────────── Delete: along with referencing cut segments ───────────────────── */

/** Removes a set of clips, clearing transitions referencing them and wiping the fade clean on the other end (same rule as store `removeClip`) */
function dropClips(tracks: Track[], transitions: Transition[], ids: Set<string>): { tracks: Track[]; transitions: Transition[] } {
  if (!ids.size) return { tracks, transitions };
  const doomed = transitions.filter((tr) => ids.has(tr.aId) || (tr.bId !== undefined && ids.has(tr.bId)));
  let next = tracks.map((t) => (t.clips.some((c) => ids.has(c.id)) ? { ...t, clips: t.clips.filter((c) => !ids.has(c.id)) } : t));
  const clear = (clipId: string | undefined, side: "fadeIn" | "fadeOut") => {
    if (!clipId || ids.has(clipId)) return;
    next = next.map((t) => (t.clips.some((c) => c.id === clipId) ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, [side]: 0 } : c)) } : t));
  };
  for (const tr of doomed) {
    if (tr.kind === "crossfade") { clear(tr.aId, "fadeOut"); clear(tr.bId, "fadeIn"); }
    else clear(tr.aId, tr.kind === "fadeIn" ? "fadeIn" : "fadeOut");
  }
  return { tracks: next, transitions: doomed.length ? transitions.filter((tr) => !doomed.includes(tr)) : transitions };
}

/**
 * Deletes cut segments referencing `cutId` across all cuts (active and parked), along with their
 * transitions.
 * Deleting the cut itself is handled by `removeCut` in `kernel/cuts.ts`; it calls this first.
 */
export function stripCutReferences(p: Project, cutId: string): Project {
  const hit = (tracks: Track[] | undefined) => new Set((tracks ?? []).flatMap((t) => t.clips.filter((c) => c.cutId === cutId).map((c) => c.id)));
  let next = p;
  const activeIds = hit(p.tracks);
  if (activeIds.size) {
    const r = dropClips(p.tracks, Array.isArray(p.transitions) ? p.transitions : [], activeIds);
    next = { ...next, tracks: r.tracks, ...(p.transitions || r.transitions.length ? { transitions: r.transitions } : {}) };
  }
  if (Array.isArray(p.cuts) && p.cuts.some((c) => c.tracks && hit(c.tracks).size)) {
    next = {
      ...next,
      cuts: p.cuts.map((c) => {
        const ids = hit(c.tracks);
        if (!ids.size || !c.tracks) return c;
        const r = dropClips(c.tracks, c.transitions ?? [], ids);
        return { ...c, tracks: r.tracks, transitions: r.transitions };
      }),
    };
  }
  return next;
}

/* ───────────────────── Rendering: sub-projects and timeline clips ───────────────────── */

/** Sub-project for rendering carries an extra path (cut IDs traversed from root cut) to prevent cycles. In-memory only, not persisted to disk */
export type CutRenderProject = Project & { cutPath?: readonly string[] };

/** Payload carried by cut segment clips in timeline (`Timeline`) */
export interface CutSegmentRender {
  cutId: string;
  /**
   * Which second of referenced cut corresponds to timeline clip start. Without pre-roll it is
   * `cutOffset`; with pre-roll it is `cutOffset - pre-roll` (timeline clip start is also advanced
   * by same amount, so "parent time t ↔ referenced cut offset + (t - clip start)" remains invariant).
   */
  offset: number;
  /** Visible start of cut segment on parent cut (seconds). Pre-roll section precedes it: nested scene advances, visuals stay hidden */
  from: number;
  /** Total duration of referenced cut at this moment: portions where `offset + local time` exceeds it are transparent and silent */
  duration: number;
  /** Sub-project of referenced cut (`tracks` replaced with its content, remaining project-level fields stay as is) */
  project: CutRenderProject;
  /** Frame push policy: direct if sub-project has no cards advancing by history; random seek does not push from segment start */
  frameMode: "direct" | "stateful";
}

/** List used merely to compare "which project-level fields match" for sub-projects; rebuilds sub-project when changed */
const SUB_DEPS = ["width", "height", "fps", "themeId", "camera3dFov", "media", "filters", "pixelMaps", "audioFx", "cardNodes", "style", "glRoute", "id", "name"] as const;

const subMemo = new WeakMap<object, Map<string, { deps: unknown[]; sub: CutRenderProject }>>();

/**
 * Rendering sub-project for cut `cutId`. `path` is the path from root to parent cut; if `cutId`
 * is already on the path (cycle), not found (dangling reference), or too deep, returns null:
 * caller skips this segment without throwing or blanking the screen.
 *
 * Memoized by object reference of `p.cuts`: querying repeatedly for the same project (`FrameScene`
 * calls `flattenOverlay` once with a trimmed project for each clip) yields the same sub-project
 * object, so Stage's memo is not wasted.
 */
export function cutSubProject(p: CutRenderProject, cutId: string): CutRenderProject | null {
  if (!Array.isArray(p.cuts)) return null;
  const root = activeCutIdOf(p);
  const path = p.cutPath ?? (root ? [root] : []);
  if (path.includes(cutId) || path.length >= MAX_CUT_DEPTH) return null;
  const key = `${path.join(">")}>${cutId}`;
  const deps = SUB_DEPS.map((k) => (p as unknown as Record<string, unknown>)[k]);
  // Active cut content is on p.tracks: referenced cut will not be root (cycle), but a parent cut along
  // path might reference any cut other than "currently active cut": those are all in cuts. Therefore
  // the key only checks cuts reference and project-level fields.
  let byKey = subMemo.get(p.cuts);
  if (!byKey) { byKey = new Map(); subMemo.set(p.cuts, byKey); }
  const hit = byKey.get(key);
  if (hit && hit.deps.every((d, i) => d === deps[i])) return hit.sub;
  const content = cutContent(p, cutId);
  if (!content) return null;
  const { _cardRender: _drop, cutPath: _path, ...rest } = p as CutRenderProject & { _cardRender?: unknown };
  const sub: CutRenderProject = {
    ...rest,
    tracks: content.tracks,
    duration: content.duration,
    transitions: content.transitions,
    activeCutId: cutId,
    // In sub-project, the "active" cut is the referenced one: entry carries no tracks/duration/transitions, while preserving kind/cameras/space/fov
    cuts: p.cuts.map((c) => {
      if (c.id !== cutId) return c;
      const { tracks: _t, duration: _d, transitions: _x, t: _pt, ...rest } = c;
      return rest;
    }) as Cut[],
    cutPath: [...path, cutId],
  };
  byKey.set(key, { deps, sub });
  return sub;
}

/*
 * Card frame push policy queries the registry directly. Note: do not let registry (or frameMode.mjs,
 * types.ts) import this module in reverse: they are in the source closure of card audio identity
 * (`render/audioCardSourceVersion.test.mjs`), and adding one more file would cause all previously
 * generated card audio for users to be judged expired.
 * Unit tests can replace it using `setCutClipFrameMode`.
 */
type ModeOf = (clip: TrackClip) => "direct" | "stateful";
const registryMode: ModeOf = (clip) => (clipFrameMode(clip, getCard(clip.cardId)) === "direct" ? "direct" : "stateful");
let modeOfClip: ModeOf | null = registryMode;
/** For unit tests: replaces card lookup policy; pass null to restore registry lookup */
export function setCutClipFrameMode(fn: ModeOf | null): void {
  modeOfClip = fn ?? registryMode;
}

const modeMemo = new WeakMap<object, "direct" | "stateful">();
/** Sub-project frame push policy: stateful if any card clip (or nested cut segment) advances by history; conservatively stateful if lookup fails */
export function cutFrameMode(sub: CutRenderProject): "direct" | "stateful" {
  const hit = modeMemo.get(sub);
  if (hit) return hit;
  let mode: "direct" | "stateful" = "direct";
  outer: for (const tr of sub.tracks) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (isCutSegment(c)) {
        const inner = cutSubProject(sub, c.cutId!);
        if (inner && cutFrameMode(inner) === "stateful") { mode = "stateful"; break outer; }
        continue;
      }
      if (!c.cardId && !c.nodeId) continue; // Media clips are fetched directly by timestamp
      if (!modeOfClip || modeOfClip(c) !== "direct") { mode = "stateful"; break outer; }
    }
  }
  modeMemo.set(sub, mode);
  return mode;
}

/** Same number as `CARD_MOUNT_LEAD` in `render/frameWindow.mjs`: cards mount this much in advance */
const MOUNT_LEAD = 0.05;

/**
 * To correctly render sub-project at time τ, what is the earliest second in sub-project to start
 * pushing forward from (≤ τ).
 * Cards currently mounted that advance by history must push from their own start; nested cut
 * segments are calculated using their timeline clip start (including their own pre-roll).
 */
export function cutHistoryStart(sub: CutRenderProject, tau: number): number {
  let h = tau;
  for (const tr of sub.tracks) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (isCutSegment(c)) {
        const inner = cutSubProject(sub, c.cutId!);
        if (!inner || cutFrameMode(inner) === "direct") continue;
        const mount = c.start - cutPreroll(sub, c, inner);
        if (tau >= mount - MOUNT_LEAD && tau < c.end) h = Math.min(h, mount);
        continue;
      }
      if (!c.cardId && !c.nodeId) continue;
      if (!(tau >= c.start - MOUNT_LEAD && tau < c.end)) continue;
      if (modeOfClip && modeOfClip(c) === "direct") continue;
      h = Math.min(h, c.start);
    }
  }
  return h;
}

/**
 * Cut segment pre-roll (seconds): when `cutOffset > 0`, cards in referenced cut that are midway
 * through playback at `cutOffset` and advance by history must push from their own start to match.
 * The approach shifts timeline clip start earlier by this amount (nested scene starts pushing
 * from earlier, keeping visuals hidden before true start). Cannot shift past 0: when segment
 * borders timeline start, pre-roll is clamped to segment start.
 */
export function cutPreroll(p: CutRenderProject, clip: TrackClip, sub: CutRenderProject | null = cutSubProject(p, clip.cutId!)): number {
  if (!sub || cutFrameMode(sub) === "direct") return 0;
  const offset = Math.max(0, clip.cutOffset ?? 0);
  if (offset <= 0) return 0;
  const need = offset - cutHistoryStart(sub, offset);
  return Math.max(0, Math.min(need, clip.start));
}

/**
 * Timeline clip emitted by `flattenOverlay`: cut segment item carries an extra `cut`. Not written
 * into `Clip` in `types.ts` (which is inside the source closure of card audio identity).
 */
export type TimelineCutClip = import("./types").Clip & { cut?: CutSegmentRender };
/** Whether timeline clip is a cut segment; if so, returns its render info */
export function cutOf(clip: unknown): CutSegmentRender | undefined {
  return (clip as TimelineCutClip | null)?.cut;
}

/** Render info emitted for cut segments in `flattenOverlay`; returns null if dangling or circular */
export function cutSegmentRender(p: CutRenderProject, clip: TrackClip): CutSegmentRender | null {
  if (!isCutSegment(clip)) return null;
  const sub = cutSubProject(p, clip.cutId!);
  if (!sub) return null;
  const pre = cutPreroll(p, clip, sub);
  return { cutId: clip.cutId!, offset: Math.max(0, clip.cutOffset ?? 0) - pre, from: clip.start, duration: sub.duration, project: sub, frameMode: cutFrameMode(sub) };
}

/* ───────────────────── Envelopes and audio (implemented in cutAudio.mjs: export mixing directly imports on server) ───────────────────── */

export { envelopeAt, audioProjectOf } from "./cutAudio.mjs";
export type { CutEnvelope, CutAudioOrigin } from "./cutAudio.mjs";
