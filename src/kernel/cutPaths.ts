/**
 * Path translation for "where tracks are" in project documents.
 *
 * Tracks in the active cut live at `/tracks`, while parked ones live at `/cuts/@<cut>/tracks`
 * (storage format in kernel/cuts.ts); switching cuts (`switch_cut`, clicking tabs) moves tracks back
 * and forth between the two locations. Inverse operations (undo, "undo this step") record paths at
 * the position **at write time**; by the time of undo, the track may have moved away: applying as is
 * fails to apply because the path does not exist, and does so silently (production 2026-10-21
 * acceptance 018-retest 2: Agent switch_cut → edit → switch_cut, and subsequent undo of that edit
 * had no effect).
 *
 * Here we look up where the track lives **now** by track id and rewrite the path there:
 *   - `/tracks/@T/…`, T is now in a parked cut → `/cuts/@X/tracks/@T/…`;
 *   - `/cuts/@X/tracks/@T/…`, T is now in the active cut (`/tracks`) or another cut → rewrite there;
 *   - Track id not found (actually deleted), path does not pass through tracks, legacy projects
 *     without cuts → returned as is, handled by existing rules for unapplied operations.
 * Pure function, does not mutate input arguments.
 */
import { entityOfOp, entitiesOf, escapeSegment, parsePath, type PathOp } from "./diffProject.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const hasTrack = (tracks: unknown, id: string) => Array.isArray(tracks) && tracks.some((t) => isObj(t) && t.id === id);

/** Where track T lives now: null is active cut (/tracks), string is parked cut id, undefined is nowhere */
export function trackHome(project: unknown, trackId: string): string | null | undefined {
  if (!isObj(project)) return undefined;
  if (hasTrack(project.tracks, trackId)) return null;
  for (const c of Array.isArray(project.cuts) ? project.cuts : []) {
    if (isObj(c) && typeof c.id === "string" && hasTrack(c.tracks, trackId)) return c.id;
  }
  return undefined;
}

const seg = (s: string) => escapeSegment(s);

/** Translates a path to where the track lives now; returns unchanged if translation is not needed */
export function relocatePath(project: unknown, path: string): string {
  const segs = parsePath(path);
  if (!segs || segs.length === 0) return path;
  let rest: string[] | null = null;
  if (segs[0] === "tracks") rest = segs.slice(1);
  else if (segs[0] === "cuts" && segs[1]?.[0] === "@" && segs[2] === "tracks") rest = segs.slice(3);
  if (!rest) return path;
  const trackSeg = rest[0];
  // Only paths pointing to a track (or inside it) are translated; operations on `/tracks` array itself (inserting a new track) do not know which cut to enter, left as is
  if (trackSeg === undefined || trackSeg[0] !== "@") return path;
  const home = trackHome(project, trackSeg.slice(1));
  if (home === undefined) return path;
  const prefix = home === null ? "/tracks" : `/cuts/@${seg(home)}/tracks`;
  return prefix + "/" + rest.map(seg).join("/");
}

/** Translates paths for a sequence of operations one by one (operations with path like `move` / `insert` are handled identically) */
export function relocateOps(project: unknown, ops: readonly PathOp[]): PathOp[] {
  return ops.map((op) => {
    const path = relocatePath(project, op.path);
    return path === op.path ? op : { ...op, path };
  });
}

/**
 * Entity names used for undo conflict checks: tracks / clips do not distinguish whether they lived
 * in `/tracks` or `/cuts/@X/tracks` at the time (moving is not part of their identity):
 * `/cuts/@X/tracks/@T/clips/@C` and `/tracks/@T/clips/@C` are the same clip; edits made by others
 * while parked or while active both count as "modified later". The entity name in the spec
 * (`entityOfPath`, same convention in document service, used for notices / commit summaries) remains
 * unchanged; only docsync's undo conflict table goes through here.
 */
export function undoEntity(entity: string): string {
  const m = /^\/cuts\/@[^/]+(\/tracks\/@.*)$/.exec(entity);
  return m ? m[1] : entity;
}

export function undoEntityOfOp(op: PathOp): string {
  return undoEntity(entityOfOp(op));
}

/** Entities written by a sequence of operations (undo conflict convention), deduplicated in order of first appearance */
export function undoEntitiesOf(ops: readonly PathOp[]): string[] {
  return [...new Set(entitiesOf(ops).map(undoEntity))];
}
