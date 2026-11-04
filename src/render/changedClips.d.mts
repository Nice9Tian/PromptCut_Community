import type { Project, Track, TrackClip } from "../kernel/project";

/** Top-level field list compared by reference (same set as frameClient's signature) */
export const TOP_FIELDS: readonly string[];

/** Change in a clip on a track; `clip: null` = this clip was deleted */
export interface ClipPatch {
  id: string;
  clip: TrackClip | null;
}

/** Changes for a track */
export interface TrackPatch {
  id: string;
  /** Entire track replaced (newly added track). If provided, ignore the three items below */
  track?: Track;
  /** Track's own properties (all own keys other than `clips`); provided as a full group if any changes */
  props?: Record<string, unknown>;
  /** Per-clip deltas */
  clips?: ClipPatch[];
  /** New order of clip IDs; present only when order or set has changed */
  clipOrder?: string[];
}

/**
 * Patch between two projects. This is what future stage RPC `setProject(patch)` will receive.
 *
 * - `kind: "full"`: Full project. Used when any top-level field other than `tracks` changes,
 *   or when there is no baseline.
 * - `kind: "tracks"`: Only tracks changed. `order` is the new order of track IDs (`null` indicates
 *   neither track set nor order changed; when non-null, **tracks not included were deleted**),
 *   and `tracks` contains per-track deltas.
 */
export type ProjectPatch =
  | { kind: "full"; project: Project }
  | { kind: "tracks"; order: string[] | null; tracks: TrackPatch[] };

export function hashString(s: string): string;
/** Project render identity hash (covers TOP_FIELDS only), cached with a three-level WeakMap */
export function projectHash(project: Project): string;
/** Snapshot of recalculation count (cache miss count), for testing */
export function hashStats(): { fields: number; tracks: number; clips: number; values: number };
export function resetHashStats(): void;
/** Two-level diff */
export function changedClips(prev: Project | null | undefined, next: Project): ProjectPatch;
/** No changes in the patch? */
export function isEmptyPatch(patch: ProjectPatch | null | undefined): boolean;
/** Applies the patch and returns the new project; throws on mismatch */
export function applyProjectPatch(project: Project, patch: ProjectPatch): Project;
