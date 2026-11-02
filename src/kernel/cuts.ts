/**
 * Pure logic for multiple cuts (timelines): normalization, switching, creation, renaming,
 * deletion, and listing.
 *
 * Data model see `Cut` in project.ts: content is only stored once: tracks/duration of the active
 * cut live on `Project`, while parked ones carry their own. None of the functions here touch the
 * store; they take `Project` as input and output a new `Project`, making them easy to test in node.
 */
// Import with .ts extension: this module must run unit tests directly in node (node --test uses
// strip-types and will not append extensions to "./project"). tsconfig has
// allowImportingTsExtensions enabled (permitted under noEmit).
// ids must reuse newId from project.ts: two counters each starting from 0 would collide into the
// same t-… id within the same millisecond.
import { newId, type Cut, type Project, type Track } from "./project.ts";
import { activeCutIdOf, cutCycleReason, cutDuration, cutReferences, stripCutReferences } from "./cutSegments.ts";
import { contentEndOf, effectiveDuration, manualDurationFor } from "./duration.ts";

/**
 * Default cut count: new projects and legacy files without a `cuts` field only get "Cut 1" added;
 * the rest are created by the user or Agent (user decision, 2026-10-20: "3 cuts by default is
 * unexpected: the user didn't create that many, so keeping just one is enough").
 * Projects that already carry `cuts` are kept as is without pruning.
 */
export const DEFAULT_CUT_COUNT = 1;
const DEFAULT_CUT_DURATION = 30;

function emptyTracks(): Track[] {
  return [
    { id: newId("t"), name: "Track 1", clips: [] },
    { id: newId("t"), name: "Track 2", clips: [] },
  ];
}

/** Next default name: Cut N, N = max of existing "Cut numbers" + 1 */
export function nextCutName(cuts: Cut[]): string {
  let max = 0;
  for (const c of cuts) {
    const m = /^(?:剪辑|Cut)\s*(\d+)$/.exec(c.name.trim()); // i18n-allow
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Cut ${max + 1}`;
}

/**
 * Normalizes project into a valid multi-cut shape. Idempotent, called once on load:
 *   - No `cuts`: current `tracks` becomes "Cut 1" (no empty cuts added when `DEFAULT_CUT_COUNT` is 1);
 *   - `activeCutId` not in `cuts`: take the first cut;
 *   - The active cut entry should not carry `tracks` (content lives on `Project`). If it does and
 *     `Project.tracks` is empty, bring it in: this happens when the file was manually edited,
 *     preferring to preserve content; otherwise drop what is in the entry;
 *   - Parked cut entries missing `tracks` / `duration` get empty ones padded.
 */
export function normalizeCuts(p: Project): Project {
  let cuts: Cut[] = Array.isArray(p.cuts) ? p.cuts.map((c) => ({ ...c })) : [];
  let tracks = p.tracks;
  let duration = p.duration;

  if (cuts.length === 0) {
    cuts = [{ id: "cut-1", name: "Cut 1" }];
    for (let i = 2; i <= DEFAULT_CUT_COUNT; i++) {
      cuts.push({ id: `cut-${i}`, name: `Cut ${i}`, tracks: emptyTracks(), duration: DEFAULT_CUT_DURATION });
    }
  }
  let activeId = p.activeCutId;
  if (!activeId || !cuts.some((c) => c.id === activeId)) activeId = cuts[0].id;

  cuts = cuts.map((c) => {
    if (c.id === activeId) {
      if (c.tracks && tracks.length === 0) {
        tracks = c.tracks;
        if (typeof c.duration === "number") duration = c.duration;
      }
      const { tracks: _t, duration: _d, transitions: _x, ...rest } = c;
      return rest;
    }
    return {
      ...c,
      tracks: Array.isArray(c.tracks) ? c.tracks : emptyTracks(),
      duration: typeof c.duration === "number" && c.duration > 0 ? c.duration : DEFAULT_CUT_DURATION,
      transitions: Array.isArray(c.transitions) ? c.transitions : [],
    };
  });

  return { ...p, tracks, duration, cuts, activeCutId: activeId };
}

/** Summary for media library / tab bar / `list_cuts`. Active cut numbers come from `Project.tracks` */
export function listCuts(p: Project): {
  id: string; name: string; active: boolean; trackCount: number; clipCount: number; duration: number;
  /** Cuts that directly reference this cut (which segments in each) */
  referencedBy: { cutId: string; name: string; clipIds: string[] }[];
  /** Which cuts are directly referenced by cut segments in this cut */
  references: string[];
}[] {
  const q = normalizeCuts(p);
  return q.cuts!.map((c) => {
    const active = c.id === q.activeCutId;
    const tracks = active ? q.tracks : c.tracks ?? [];
    const refs: string[] = [];
    for (const t of tracks) for (const cl of t.clips) if (cl.cutId && !refs.includes(cl.cutId)) refs.push(cl.cutId);
    return {
      id: c.id,
      name: c.name,
      active,
      trackCount: tracks.length,
      clipCount: tracks.reduce((n, t) => n + t.clips.length, 0),
      duration: active ? q.duration : c.duration ?? DEFAULT_CUT_DURATION,
      referencedBy: cutReferences(q, c.id),
      references: refs,
    };
  });
}

/** Finds cut by id or name; throws if not found, listing existing cuts in error message for model */
export function resolveCut(p: Project, ref: { cutId?: string; name?: string }): Cut {
  const q = normalizeCuts(p);
  const cuts = q.cuts!;
  if (ref.cutId) {
    const hit = cuts.find((c) => c.id === ref.cutId);
    if (hit) return hit;
  }
  if (ref.name) {
    const want = ref.name.trim();
    const hit = cuts.find((c) => c.name.trim() === want);
    if (hit) return hit;
  }
  const names = cuts.map((c) => `${c.name}(${c.id})`).join(", ");
  throw new Error(`Cut not found ${JSON.stringify(ref.cutId ?? ref.name ?? "")}; existing: ${names}`);
}

/**
 * Switch to another cut. Current content (`tracks` / `duration` / playhead `t`) is saved back to
 * its entry, and the target's content is swapped in.
 * Returns new project and target playhead when last left. Returns as is if target is current.
 */
export function switchCut(p: Project, cutId: string, t: number): { project: Project; t: number } {
  const q = normalizeCuts(p);
  if (cutId === q.activeCutId) return { project: q, t };
  const target = q.cuts!.find((c) => c.id === cutId);
  if (!target) throw new Error(`Cut not found ${cutId}`);

  const cuts = q.cuts!.map((c) => {
    if (c.id === q.activeCutId) return { ...c, tracks: q.tracks, duration: q.duration, transitions: q.transitions ?? [], t };
    if (c.id === cutId) {
      const { tracks: _t, duration: _d, transitions: _x, t: _pt, ...rest } = c;
      return rest;
    }
    return c;
  });
  return {
    project: { ...q, tracks: target.tracks ?? emptyTracks(), duration: target.duration ?? DEFAULT_CUT_DURATION, transitions: target.transitions ?? [], cuts, activeCutId: cutId },
    t: target.t ?? 0,
  };
}

/** Creates a new parked cut (without switching). Name defaults to Cut N */
export function addCut(p: Project, name?: string): { project: Project; cut: Cut } {
  const q = normalizeCuts(p);
  const cut: Cut = {
    id: newId("cut"),
    name: (name ?? "").trim() || nextCutName(q.cuts!),
    tracks: emptyTracks(),
    duration: DEFAULT_CUT_DURATION,
    transitions: [],
  };
  return { project: { ...q, cuts: [...q.cuts!, cut] }, cut };
}

export function renameCut(p: Project, cutId: string, name: string): Project {
  const q = normalizeCuts(p);
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Cut name cannot be empty");
  if (!q.cuts!.some((c) => c.id === cutId)) throw new Error(`Cut not found ${cutId}`);
  return { ...q, cuts: q.cuts!.map((c) => (c.id === cutId ? { ...c, name: trimmed } : c)) };
}

/**
 * Deletes a cut. The last cut cannot be deleted. If deleting the active cut, switch to an
 * adjacent cut first (preferring the left); `switchedTo` in return tells caller where it switched
 * to and what playhead should be.
 *
 * When referenced by other cuts (cut segments), cut segments referencing it are deleted along
 * with transitions bound to them (`product/project-model.md` "Cut": first explain which cuts use
 * it, and delete together with referencing cut segments upon confirmation).
 * Explanation and confirmation are caller's concern (UI shows confirmation popup, Agent tool
 * requires `force`); `removedSegments` is returned here for caller reporting.
 */
export function removeCut(p: Project, cutId: string, t: number): { project: Project; switchedTo: string | null; t: number; removedSegments: { cutId: string; name: string; clipIds: string[] }[] } {
  let q = normalizeCuts(p);
  const idx = q.cuts!.findIndex((c) => c.id === cutId);
  if (idx < 0) throw new Error(`Cut not found ${cutId}`);
  if (q.cuts!.length <= 1) throw new Error("This is the last cut and cannot be deleted; to clear it, delete the segments inside");
  const removedSegments = cutReferences(q, cutId).filter((r) => r.cutId !== cutId);
  q = stripCutReferences(q, cutId);

  let switchedTo: string | null = null;
  let nextT = t;
  if (cutId === q.activeCutId) {
    const neighbor = q.cuts![idx > 0 ? idx - 1 : idx + 1];
    const s = switchCut(q, neighbor.id, t);
    q = s.project;
    nextT = s.t;
    switchedTo = neighbor.id;
  }
  return { project: { ...q, cuts: q.cuts!.filter((c) => c.id !== cutId) }, switchedTo, t: nextT, removedSegments };
}

/**
 * Places cut `childCutId` as a cut segment into a track of the active cut. Pure function: returns
 * new project and new segment; throws if it does not fit (overlaps), causes circular reference,
 * or cut is not found, with human-readable error message (used by drop notice bar and Agent tools).
 *
 * Default cut segment length = remaining duration of referenced cut (starting from `offset`);
 * even if `duration` is given, it cannot exceed this.
 */
export function placeCutSegment(
  p: Project,
  childCutId: string,
  start: number,
  opts: { trackId?: string; duration?: number; offset?: number; id?: string } = {},
): { project: Project; clip: import("./project.ts").TrackClip } {
  const q = normalizeCuts(p);
  const host = q.activeCutId!;
  if (!q.cuts!.some((c) => c.id === childCutId)) throw new Error(`Cut not found ${childCutId}`);
  const reason = cutCycleReason(q, host, childCutId);
  if (reason) throw new Error(reason);
  const offset = Math.max(0, opts.offset ?? 0);
  const total = cutDuration(q, childCutId);
  const room = total - offset;
  if (!(room > 0.05)) throw new Error(`Cut "${q.cuts!.find((c) => c.id === childCutId)!.name}" has no content left to place from second ${offset} (total duration ${total} s)`);
  const dur = Math.min(opts.duration ?? room, room);
  if (!(dur > 0)) throw new Error("Cut segment length must be greater than 0");
  const s = Math.max(0, start);
  const track = opts.trackId ? q.tracks.find((t) => t.id === opts.trackId) : q.tracks[0];
  if (!track) throw new Error(`Track not found ${opts.trackId ?? ""}`);
  if (track.locked) throw new Error(`Track "${track.name}" is locked`);
  const clip = {
    id: opts.id ?? newId("k"), cardId: "", cutId: childCutId, start: s, end: s + dur, params: {},
    ...(offset > 0 ? { cutOffset: offset } : {}),
  };
  if (track.clips.some((c) => c.start < clip.end - 1e-9 && clip.start < c.end - 1e-9)) throw new Error(`Track "${track.name}" already has a clip at ${s} ~ ${s + dur} s`);
  const tracks = q.tracks.map((t) => (t.id === track.id ? { ...t, clips: [...t.clips, clip].sort((a, b) => a.start - b.start) } : t));
  return { project: { ...q, tracks, duration: Math.max(q.duration, clip.end) }, clip };
}

/** Assets are project-level: deleting an asset must clear clips referencing it in parked cuts, not just the active cut */
export function stripMediaFromCuts(p: Project, mediaId: string): Project {
  if (!p.cuts) return p;
  return {
    ...p,
    cuts: p.cuts.map((c) =>
      c.tracks ? { ...c, tracks: c.tracks.map((t) => ({ ...t, clips: t.clips.filter((cl) => cl.mediaId !== mediaId) })) } : c),
  };
}

/** Strips filter field from clip (removes entire key; saved result is as if never attached) */
export function withoutFilter<T extends { filter?: unknown }>(clip: T): T {
  const { filter: _gone, ...rest } = clip;
  return rest as T;
}

/** Strips audio effects field from clip (removes entire key) */
export function withoutAudioFx<T extends { audioFx?: unknown }>(clip: T): T {
  const { audioFx: _gone, ...rest } = clip;
  return rest as T;
}

/** Audio effects are like filters: deleting an effect must strip it from clips in parked cuts */
export function stripAudioFxFromCuts(p: Project, fxId: string): Project {
  if (!p.cuts) return p;
  return {
    ...p,
    cuts: p.cuts.map((c) =>
      c.tracks
        ? { ...c, tracks: c.tracks.map((t) => ({ ...t, clips: t.clips.map((cl) => (cl.audioFx?.id === fxId ? withoutAudioFx(cl) : cl)) })) }
        : c),
  };
}

/** Filters are also project-level: deleting a filter strips it from parked cuts, like `stripMediaFromCuts` */
export function stripFilterFromCuts(p: Project, filterId: string): Project {
  if (!p.cuts) return p;
  return {
    ...p,
    cuts: p.cuts.map((c) =>
      c.tracks
        ? { ...c, tracks: c.tracks.map((t) => ({ ...t, clips: t.clips.map((cl) => (cl.filter?.id === filterId ? withoutFilter(cl) : cl)) })) }
        : c),
  };
}

/* ---------- Modify clips in parked cuts in place (without switching active cut) ----------
 *
 * The active cut lives on `Project.tracks` and parked cuts live in `cuts[].tracks`, so `findClip`
 * only finds clips in the active cut. Previously, for an Agent to modify a card in another cut,
 * it had to switch over via `switch_cut` (`activeCutId` is a shared project field, flipping all
 * members' UI together) and switch back afterwards: two redundant writes (occurred every round
 * online, 2026-10-21).
 *
 * Approach: swap the project into the form where "that cut is active" (`cutEditView`), allowing
 * existing store actions written for the active cut to work as usual, then fold the new project
 * committed by each action back into the real shape (`foldCutEdit`): only `tracks` / `duration` /
 * `transitions` in that cut's entry are modified, leaving `activeCutId` and active cut content
 * untouched. Folding back creates all new objects without mutating the project object in store.
 */

/** Which parked cut contains this clip (excluding active cut); returns null if none */
export function parkedCutOfClip(p: Project, clipId: string): { cutId: string; cutName: string } | null {
  const active = activeCutIdOf(p);
  for (const c of Array.isArray(p.cuts) ? p.cuts : []) {
    if (c.id === active || !Array.isArray(c.tracks)) continue;
    for (const t of c.tracks) if (t.clips.some((cl) => cl.id === clipId)) return { cutId: c.id, cutName: c.name };
  }
  return null;
}

/**
 * Edit view treating `cutId` as active cut: replaces `tracks` / `duration` / `transitions` with
 * its content, while genuinely active cut steps back into an entry carrying its own content.
 * Returns null if not the active cut or not a parked cut with content (caller proceeds in place).
 */
export function cutEditView(real: Project, cutId: string): Project | null {
  const activeId = activeCutIdOf(real);
  if (!activeId || cutId === activeId) return null;
  const target = (real.cuts ?? []).find((c) => c.id === cutId);
  if (!target || !Array.isArray(target.tracks)) return null;
  const cuts = real.cuts!.map((c) => {
    if (c.id === activeId) return { ...c, tracks: real.tracks, duration: real.duration, transitions: real.transitions ?? [] };
    if (c.id === cutId) {
      const { tracks: _t, duration: _d, transitions: _x, ...rest } = c;
      return rest;
    }
    return c;
  });
  return {
    ...real,
    tracks: target.tracks,
    duration: typeof target.duration === "number" && target.duration > 0 ? target.duration : DEFAULT_CUT_DURATION,
    transitions: target.transitions ?? [],
    cuts,
    activeCutId: cutId,
  };
}

/** Total duration of parked cuts follows content: same rule as `agent-exec.mjs` `settleDuration` and timeline (min 1s) */
function settleCutDuration(before: { tracks: Track[]; duration: number }, afterTracks: Track[], afterDuration: number): number {
  if (afterTracks === before.tracks && afterDuration === before.duration) return afterDuration;
  const end = contentEndOf(afterTracks);
  const manual = afterDuration !== before.duration ? manualDurationFor(afterDuration, end) : manualDurationFor(before.duration, contentEndOf(before.tracks));
  const target = effectiveDuration(end, afterDuration, manual);
  if (Math.abs(target - afterDuration) <= 1e-6) return afterDuration;
  const val = Math.max(1, target);
  return Math.abs(val - afterDuration) < 1e-6 ? afterDuration : val;
}

/**
 * After project in `cutEditView` is modified by actions into `edited`, fold back into real shape:
 * `real` is the real project before entering the view.
 * Project-level changes (assets, effects library, card nodes...) follow `edited`; active cut's
 * `tracks` / `duration` / `transitions` / `activeCutId` use those from `real`;
 * `cutId` entry accepts `tracks` / `duration` / `transitions` from `edited` (total duration follows content).
 */
export function foldCutEdit(real: Project, edited: Project, cutId: string): Project {
  const activeId = activeCutIdOf(real)!;
  const realTarget = real.cuts!.find((c) => c.id === cutId)!;
  const realActiveEntry = real.cuts!.find((c) => c.id === activeId)!;
  const beforeDuration = typeof realTarget.duration === "number" && realTarget.duration > 0 ? realTarget.duration : DEFAULT_CUT_DURATION;
  const duration = settleCutDuration({ tracks: realTarget.tracks!, duration: beforeDuration }, edited.tracks, edited.duration);
  // If entry originally lacked transitions key and remains empty, avoid creating an extra key
  const nowT = edited.transitions ?? [];
  const transitions = realTarget.transitions !== undefined ? nowT : nowT.length ? nowT : undefined;
  const entry: Cut = {
    ...realTarget,
    tracks: edited.tracks,
    ...(duration === beforeDuration && realTarget.duration === undefined ? {} : { duration }),
    ...(transitions === undefined ? {} : { transitions }),
  };
  const cuts = (edited.cuts ?? real.cuts!).map((c) => (c.id === activeId ? realActiveEntry : c.id === cutId ? entry : c));
  const out: Project = { ...edited, tracks: real.tracks, duration: real.duration, cuts, activeCutId: real.activeCutId };
  if (real.transitions === undefined) delete out.transitions;
  else out.transitions = real.transitions;
  return out;
}
