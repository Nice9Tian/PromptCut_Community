// Internal mutable state and write primitives exported by this file (state, listeners, history,
// future, emit, set, setProject, and pure function helpers) are only for src/store/actions, with
// package-private visibility; external code always goes through project.ts: it only re-exports
// the public names EditorState / planPlacement / getState / subscribe / useStore / actions.
import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import { createEmptyProject, type Project, type Track, type TrackClip } from "../kernel/project";
import { type Transition } from "../kernel/transitions";
import { cutEditView, foldCutEdit } from "../kernel/cuts";
import { tr } from "../i18n/index.ts";

/**
 * Editor state store (singleton). All panels, timeline, and MCP tools read and write through here,
 * never modifying the Project object directly.
 * Usage: const project = useStore(s => s.project);  actions.addClip(...)
 * Every action is synchronous and produces a new object (immutable update), making undo and React
 * re-renders straightforward.
 */

export interface EditorState {
  /** Changes only when a project is opened/replaced; async jobs must not survive reopening. */
  projectLoadToken: number;
  project: Project;
  /** Playhead (seconds) */
  t: number;
  playing: boolean;
  /** Incremented by 1 on each seek/replay; Stage uses it to remount cards */
  playToken: number;
  /** Selected clip ids (multi-selection allowed; first is primary) */
  selection: string[];
  /** Selected camera clip id on the active cut's camera lane (mutually exclusive with clip selection) */
  selectedCameraId: string | null;
  /** Project file path (null if unsaved) */
  filePath: string | null;
  dirty: boolean;
  /** Total duration manually set by user dragging the range marker, null if never set */
  durationManual: number | null;
  /**
   * Last used 3D camera FOV. Recorded here when closing 3D (camera3dFov wiped), restoring that value
   * when reopened.
   *
   * **Not persisted to disk**: saved file should look identical to never having opened 3D. Kept in
   * store rather than a module variable because module variables persist across projects: if project
   * A adjusted it to 60 and closed it, opening project B that never opened 3D would mysteriously get
   * 60. Stored here, loadProject cleanly clears it.
   */
  lastCamera3dFov: number | null;
  /**
   * Master preview volume 0–1 (affects preview only, not saved to project; export mixes original
   * audio via ffmpeg)
   */
  volume: number;
  /** Preview mute toggle, tracked separately from volume so unmuting restores original volume */
  muted: boolean;
}

type Listener = () => void;

/** Preview volume is stored locally, independent of the project */
export const VOLUME_KEY = "pc.volume";
export function readVolume(): number {
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "");
    if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
  } catch {}
  return 0.7;
}

export let state: EditorState = {
  projectLoadToken: 0,
  project: createEmptyProject(),
  t: 0,
  playing: false,
  playToken: 1,
  selection: [],
  selectedCameraId: null,
  filePath: null,
  dirty: false,
  durationManual: null,
  lastCamera3dFov: null,
  volume: readVolume(),
  muted: false,
};
export const listeners = new Set<Listener>();
export const history: Project[] = [];
export const future: Project[] = [];

export function emit() {
  for (const l of listeners) l();
}

export function set(patch: Partial<EditorState>) {
  if (cutScope) { outsideCutScope(() => set(patch)); return; }
  state = { ...state, ...patch };
  emit();
}

/*
 * Modifies clips in parked cuts in place (Agent's update_clip, etc.; see "Modify clips in parked
 * cuts in place" in kernel/cuts.ts).
 *
 * `runInCutScope(cutId, fn)` replaces `state.project` during fn execution with a view where "that
 * cut is active", allowing existing actions written for active cuts (`findClip(state.project, …)` +
 * `setProject`) to work as-is; during this time, `setProject` folds the new project produced by the
 * action back to its real shape before committing (the undo stack and document service sync both see
 * the real shape, where only that cut's entry content changed, leaving activeCutId and the active
 * cut untouched), and `set` also switches back to the real project before notifying listeners: so no
 * listeners or sync layer ever see the view. fn must be synchronous.
 */
let cutScope: { cutId: string; real: Project } | null = null;

/**
 * When doing external work in scope (commit, notify listeners): switch back to real project
 * first, then rebuild view based on the post-work real project when done
 */
function outsideCutScope<T>(fn: () => T): T {
  const sc = cutScope!;
  cutScope = null;
  state = { ...state, project: sc.real };
  try {
    return fn();
  } finally {
    sc.real = state.project;
    const view = cutEditView(sc.real, sc.cutId);
    if (view) {
      state = { ...state, project: view };
      cutScope = sc;
    }
  }
}

export function runInCutScope<T>(cutId: string, fn: () => T): T {
  if (cutScope) {
    if (cutScope.cutId !== cutId) throw new Error(tr("Cannot edit another cut while editing one cut"));
    return fn();
  }
  const real = state.project;
  const view = cutEditView(real, cutId);
  if (!view) return fn(); // Already the active one, or not found: proceed as normal
  cutScope = { cutId, real };
  state = { ...state, project: view };
  let out: T;
  try {
    out = fn();
  } finally {
    const sc = cutScope as { cutId: string; real: Project } | null;
    cutScope = null;
    if (sc) state = { ...state, project: sc.real };
  }
  if (out && typeof (out as { then?: unknown }).then === "function") {
    throw new Error(tr("runInCutScope can only wrap synchronous functions (the async second half is no longer in this cut's view)"));
  }
  return out;
}

export interface SetProjectOptions {
  /** false: does not enter undo stack */
  undoable?: boolean;
  /**
   * Consecutive edits with the same key within the merge window are merged into a single step
   * on the undo stack (a single slider drag, continuous number input stepping). If omitted, behaves
   * as before with one step per edit. When not passed, uses the one enclosed by `withMerge`.
   */
  mergeKey?: string;
  /**
   * Merge window (in milliseconds, rolling forward from the last merge); defaults to
   * `MERGE_WINDOW_MS` if omitted. `Infinity` = key only, ignoring time (key for a single drag
   * is unique)
   */
  mergeWindowMs?: number;
}

/**
 * Party that takes over project writes and undo when connected to document service (attached
 * by bindStore in docsync.ts). When not attached (default), behaves as before: whole replacement
 * + history / future snapshot stack. Both modes share the same interface for actions and UI:
 * setProject / undo / redo / canUndo / canRedo.
 */
export interface ProjectSyncHooks {
  /**
   * Changes locally to next; returns the copy actually committed (key order may differ from next,
   * contents identical)
   */
  commit(prev: Project, next: Project, opts: SetProjectOptions): Project;
  /** Replaces entirely with another copy of content (opening .proc, etc.); returns the committed copy */
  load(project: Project): Project;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /**
   * Waits until all local edits receive confirmation from the document service (waited on before
   * saving .proc); absent when not connected to document service
   */
  whenSettled?(opts?: { timeoutMs?: number }): Promise<{ rev: number; project: Project }>;
}

let projectSync: ProjectSyncHooks | null = null;

export function attachProjectSync(hooks: ProjectSyncHooks | null) {
  projectSync = hooks;
}

export function getProjectSync(): ProjectSyncHooks | null {
  return projectSync;
}

/**
 * Merge criteria in snapshot stack mode: last edit with mergeKey, and the committed copy of
 * project from it
 */
let lastMerge: { key: string; at: number; project: Project } | null = null;
export const MERGE_WINDOW_MS = 300;

/**
 * Attributes project edits occurring in `fn` to the same mergeKey: relied on by UI slider drags
 * and number input stepping, without adding an extra parameter to every action. Runs synchronously;
 * inner scopes override outer scopes when nested, and restore upon exit.
 */
let ambientMerge: { key: string; windowMs?: number } | null = null;
export function withMerge<T>(merge: { key: string; windowMs?: number }, fn: () => T): T {
  const outer = ambientMerge;
  ambientMerge = merge;
  try { return fn(); } finally { ambientMerge = outer; }
}

/**
 * Local edits from this page (committed via setProject; remote changes and undo / redo do not
 * pass through here). "User is editing" (src/editor/userEditing.ts) uses this to determine
 * whether "the selected clip was just touched by the user".
 */
type LocalCommitListener = (prev: Project, next: Project) => void;
const localCommitListeners = new Set<LocalCommitListener>();

export function onLocalCommit(fn: LocalCommitListener): () => void {
  localCommitListeners.add(fn);
  return () => { localCommitListeners.delete(fn); };
}

function noteLocalCommit(prev: Project, next: Project) {
  if (prev === next) return;
  for (const fn of localCommitListeners) {
    try { fn(prev, next); } catch { /* Errors in listeners do not affect mutations */ }
  }
}

/** Modifies project document (enters undo stack) */
export function setProject(next: Project, opts: SetProjectOptions = {}) {
  if (cutScope) {
    if (next === state.project) return; // View committed as-is = no changes, avoids producing a new project out of thin air
    const folded = foldCutEdit(cutScope.real, next, cutScope.cutId);
    outsideCutScope(() => setProject(folded, opts));
    return;
  }
  if (ambientMerge && opts.mergeKey === undefined) opts = { ...opts, mergeKey: ambientMerge.key, mergeWindowMs: opts.mergeWindowMs ?? ambientMerge.windowMs };
  const prev = state.project;
  if (projectSync) {
    const landed = projectSync.commit(state.project, next, opts);
    set({ project: landed, dirty: true });
    noteLocalCommit(prev, landed);
    return;
  }
  if (opts.undoable !== false) {
    const now = Date.now();
    // Continuous input in the same number input: previous step was this, no intermediate edits,
    // within 300 ms → do not start a new step
    const merge = !!opts.mergeKey && lastMerge !== null && lastMerge.key === opts.mergeKey && lastMerge.project === state.project && now - lastMerge.at <= (opts.mergeWindowMs ?? MERGE_WINDOW_MS) && history.length > 0;
    if (!merge) {
      history.push(state.project);
      if (history.length > 100) history.shift();
    }
    future.length = 0;
    lastMerge = opts.mergeKey ? { key: opts.mergeKey, at: now, project: next } : null;
  }
  set({ project: next, dirty: true });
  noteLocalCommit(prev, next);
}

/** Clears fades written by a transition (clips may no longer exist; skipped if not found) */
export function clearTransitionFades(p: Project, tr: Transition): Project {
  const clear = (clipId: string | undefined, side: "fadeIn" | "fadeOut") => {
    if (!clipId) return;
    p = {
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, [side]: 0 } : c)),
      })),
    };
  };
  if (tr.kind === "crossfade") {
    clear(tr.aId, "fadeOut");
    clear(tr.bId, "fadeIn");
  } else {
    clear(tr.aId, tr.kind === "fadeIn" ? "fadeIn" : "fadeOut");
  }
  return p;
}

export function updateTrack(p: Project, trackId: string, fn: (t: Track) => Track): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? fn(t) : t)) };
}

/**
 * Prunes unneeded media effect card nodes after deleting clips / tracks.
 *
 * The only writer for cardNodes is cardAuthoring, and clips are its sole entry point, so the
 * criterion is "whether it is reachable starting from remaining clips". Unreachable nodes, as well
 * as those whose inputs point to that composite source (`@clip/<id>/source`) of a deleted clip,
 * are pruned along with their downstream nodes: leaving them would require projectCardGraph to fall
 * back on the edge-dropping rule every time, which is reserved for legacy projects where "the graph
 * is already saved to disk".
 */
export function pruneCardNodes(p: Project): Project {
  const nodes = p.cardNodes;
  if (!nodes?.length) return p;
  const clips = p.tracks.flatMap((t) => t.clips);
  const liveClipIds = new Set(clips.map((c) => c.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const refsOf = (n: (typeof nodes)[number]) =>
    Object.values(n.inputs ?? {}).map((r) => (typeof r === "string" ? r : r?.nodeId)).filter((x): x is string => !!x);
  const keep = new Set<string>();
  const walk = (id?: string) => {
    if (!id || keep.has(id) || !byId.has(id)) return;
    keep.add(id);
    for (const ref of refsOf(byId.get(id)!)) walk(ref);
  };
  for (const clip of clips) walk(clip.nodeId);
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of [...keep]) {
      const dangling = refsOf(byId.get(id)!).some((ref) => {
        if (ref.startsWith("@clip/")) {
          const owner = /^@clip\/(.+)\/[^/]+$/.exec(ref);
          return !owner || !liveClipIds.has(owner[1]);
        }
        return !keep.has(ref);
      });
      if (dangling) { keep.delete(id); changed = true; }
    }
  }
  if (keep.size === nodes.length) return p;
  const next: Project = { ...p, cardNodes: nodes.filter((n) => keep.has(n.id)) };
  if (!clips.some((c) => c.nodeId && !keep.has(c.nodeId))) return next;
  // Clips whose nodes are gone have their nodeId cleared: keeping it would be a reference
  // to a nonexistent node
  return { ...next, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => {
    if (!c.nodeId || keep.has(c.nodeId)) return c;
    const { nodeId: _gone, ...rest } = c;
    return rest;
  }) })) };
}

/**
 * Translates a group of clips as a whole by dt seconds. Clips cannot overlap within a track
 * and cannot be pushed before 0: if any clip cannot fit, the entire group remains untouched
 * (returns null), avoiding half-baked results like "moving halfway". Relative relationships
 * within the group are preserved intact, so transitions will not break.
 */
export function shiftClipsBy(p: Project, ids: string[], dt: number): Project | null {
  const set = new Set(ids);
  let found = 0;
  const tracks = p.tracks.map((t) => ({
    ...t,
    clips: sortClips(
      t.clips.map((c) => {
        if (!set.has(c.id)) return c;
        found++;
        return { ...c, start: c.start + dt, end: c.end + dt };
      }),
    ),
  }));
  if (found !== set.size) return null;
  for (const t of tracks) {
    for (let i = 0; i < t.clips.length; i++) {
      if (t.clips[i].start < -1e-6) return null;
      if (i > 0 && t.clips[i].start < t.clips[i - 1].end - 1e-6) return null;
    }
  }
  return { ...p, tracks };
}

export function sortClips(clips: TrackClip[]): TrackClip[] {
  return [...clips].sort((a, b) => a.start - b.start);
}

/**
 * No overlapping within tracks: clamps clip between adjacent clips, keeping duration unchanged.
 * Returns null when the gap cannot fit the entire segment (caller rejects this move), instead of
 * crushing the clip.
 */
export function resolveOverlap(track: Track, clip: TrackClip): TrackClip | null {
  const others = track.clips.filter((c) => c.id !== clip.id);
  let { start, end } = clip;
  const len = Math.max(0.1, end - start);
  const mid = start + len / 2;
  const prev = others.filter((c) => c.end <= mid).sort((a, b) => b.end - a.end)[0];
  const next = others.filter((c) => c.start >= mid).sort((a, b) => a.start - b.start)[0];
  const lo = prev ? prev.end : 0;
  const hi = next ? next.start : Infinity;
  if (hi - lo < len - 1e-6) return null;
  start = Math.max(lo, Math.min(start, hi - len));
  end = start + len;
  return { ...clip, start: Math.max(0, start), end };
}

/** For additions: if it cannot fit in place, find the first gap after it that fits (duration unchanged). */
export function placeOrShift(track: Track, clip: TrackClip): TrackClip {
  const fit = resolveOverlap(track, clip);
  if (fit) return fit;
  const len = Math.max(0.1, clip.end - clip.start);
  const sorted = [...track.clips].filter((c) => c.id !== clip.id).sort((a, b) => a.start - b.start);
  let cursor = clip.start;
  for (const c of sorted) {
    if (c.end <= cursor) continue;
    if (c.start - cursor >= len) break;
    cursor = Math.max(cursor, c.end);
  }
  return { ...clip, start: cursor, end: cursor + len };
}

/**
 * Drop target dry run: calculates where the new clip will land using the exact same rules as card
 * placement, but does not modify the document.
 * Used by the timeline drop target preview to ensure the "position seen while dragging" matches
 * the position where it actually lands after release.
 * shifted = could not fit in place and was shifted to a later gap.
 */
export function planPlacement(track: Track, start: number, dur: number): { start: number; end: number; shifted: boolean } {
  const from = Math.max(0, start);
  const probe: TrackClip = { id: "__probe", cardId: "", start: from, end: from + dur, params: {} };
  const placed = placeOrShift(track, probe);
  return { start: placed.start, end: placed.end, shifted: Math.abs(placed.start - from) > 1e-6 };
}

/**
 * Which track to land on when no track is specified: pick the first track that is free during this
 * time range (tracks no longer have types, so only check whether it is occupied).
 * If none can fit, use the first unlocked track and let placeOrShift shift it later.
 */
export function pickTrack(p: Project, start: number, dur: number): Track | undefined {
  const free = p.tracks.find(
    (t) => !t.locked && !t.clips.some((c) => Math.max(start, c.start) < Math.min(start + dur, c.end)),
  );
  return free ?? p.tracks.find((t) => !t.locked) ?? p.tracks[0];
}


;

export function getState(): EditorState {
  return state;
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * "This subtree is currently invisible, do not follow store updates for now". Under `true`, for
 * section tabs in the dock that are unselected or on a collapsed side (`DockPages` wraps each
 * section): `useStore` does not subscribe and keeps returning the value read when it was last
 * visible, without re-rendering on every project change (moving clips, changing parameters);
 * in the commit where it is exposed again, it re-reads from the store at that time, giving
 * the same result as following along the whole time.
 *
 * Why this exists (tiers-probe T4,docs/archive/agent-reports/AGENT-perf-t4.md): section tabs
 * are permanently mounted and merely display:none; previously, every edit re-rendered the entire
 * tree of the invisible effects library, node graph, and captions list, crowding into the same
 * synchronous task with the visible timeline and preview (useSyncExternalStore updates cannot be
 * sliced), and exceeding 50 ms as soon as background transcoding or uploading competed for CPU.
 */
const StoreHoldContext = createContext(false);
export const StoreHold = StoreHoldContext.Provider;
const holdSubscribe = () => () => {};

export function useStore<T>(selector: (s: EditorState) => T): T {
  const held = useContext(StoreHoldContext);
  const last = useRef<{ value: T } | null>(null);
  // If it is invisible when first mounted (last has no value yet), read once as normal;
  // afterwards, keep returning the previous value while invisible
  const read = () => (held && last.current ? last.current.value : selector(state));
  const value = useSyncExternalStore(held ? holdSubscribe : subscribe, read, read);
  last.current = { value };
  return value;
}
/** The UI owns project-opening policy; the store only calls its registered hook. */
let projectLoader: ((project: Project) => Project) | null = null;
export function setProjectLoader(loader: (project: Project) => Project) { projectLoader = loader; }
export function getProjectLoader() { return projectLoader; }
