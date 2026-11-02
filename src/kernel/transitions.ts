import type { Project, Track, TrackClip } from "./project.ts";

/**
 * A transition = a record + the fades of the segments it manages, and it **binds those segments into
 * a group**.
 *
 * Transitions used to not be objects: two overlapping segments each with a fade counted as a
 * crossfade, and anyone could casually move one of the segments away, and the dissolve would quietly
 * fall apart (fadeIn / fadeOut still remained there, and the picture would fade for no apparent
 * reason). Now:
 *
 *   - Adding a transition = putting a record into `project.transitions` and writing the fadeIn /
 *     fadeOut at both ends;
 *   - Clips with a record have their **relative timing locked**: they cannot be moved individually,
 *     resized or split. Translating the whole group together is allowed (that does not change the
 *     relative relationship);
 *   - To adjust one on its own, delete the transition first. On deletion the fades are cleared, and
 *     the later segment is moved back to its original position as far as possible.
 *
 * A segment can have a fade-in, a fade-out and crossfades with the segments before and after at the
 * same time; a crossfade strings two segments into a group, so A-B-C joined by two dissolves is one
 * group of three segments (groupOf walks the connected components).
 *
 * This file is pure functions: it only reads Project and returns conclusions, and does not touch the
 * store or modify anything.
 */
export type TransitionKind = "crossfade" | "fadeIn" | "fadeOut";

export interface Transition {
  id: string;
  kind: TransitionKind;
  /** Crossfade: the earlier segment; fade-in / fade-out: that segment */
  aId: string;
  /** Only crossfades have it: the later segment */
  bId?: string;
  /** Seconds */
  dur: number;
  /**
   * To create the overlap, a crossfade pulls the later segment forward and, when necessary, moves it to
   * another track.
   * This records where it was originally, so that it can be put back when the transition is deleted.
   */
  prevB?: { start: number; trackId: string };
}

export const MIN_TRANSITION_DUR = 0.1;
export const MAX_TRANSITION_DUR = 10;

export function transitionsOf(p: Project): Transition[] {
  return Array.isArray(p.transitions) ? p.transitions : [];
}

/** All transitions that reference this clip */
export function transitionsOfClip(p: Project, clipId: string): Transition[] {
  return transitionsOf(p).filter((tr) => tr.aId === clipId || tr.bId === clipId);
}

/**
 * Whether the fade on one side of this clip is managed by some transition (if so, it must not be
 * edited by hand)
 */
export function fadeOwner(p: Project, clipId: string, side: "fadeIn" | "fadeOut"): Transition | null {
  for (const tr of transitionsOf(p)) {
    if (tr.kind === "fadeIn" && side === "fadeIn" && tr.aId === clipId) return tr;
    if (tr.kind === "fadeOut" && side === "fadeOut" && tr.aId === clipId) return tr;
    if (tr.kind === "crossfade") {
      if (side === "fadeOut" && tr.aId === clipId) return tr;
      if (side === "fadeIn" && tr.bId === clipId) return tr;
    }
  }
  return null;
}

/**
 * The group this clip belongs to: all clips chained together by crossfades (a connected component).
 * Fade-in / fade-out do not chain others and lock only their own segment. When the clip does not exist
 * or is not referenced by any transition, it returns just itself.
 */
export function groupOf(p: Project, clipId: string): { members: string[]; transitions: Transition[] } {
  const all = transitionsOf(p);
  const members = new Set<string>([clipId]);
  const used = new Set<Transition>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const tr of all) {
      if (tr.kind !== "crossfade" || !tr.bId) continue;
      const hitA = members.has(tr.aId);
      const hitB = members.has(tr.bId);
      if (!hitA && !hitB) continue;
      if (!used.has(tr)) {
        used.add(tr);
        grew = true;
      }
      if (!hitA) { members.add(tr.aId); grew = true; }
      if (!hitB) { members.add(tr.bId); grew = true; }
    }
  }
  // Fade-ins and fade-outs also count as transitions of this group (they lock the same clips)
  for (const tr of all) {
    if (tr.kind !== "crossfade" && members.has(tr.aId)) used.add(tr);
  }
  return { members: [...members], transitions: [...used] };
}

function clipName(p: Project, clipId: string): string {
  for (const t of p.tracks) {
    for (const c of t.clips) {
      if (c.id !== clipId) continue;
      if (c.label) return c.label;
      const m = c.mediaId ? p.media.find((x) => x.id === c.mediaId) : null;
      return m?.name ?? c.cardId ?? clipId;
    }
  }
  return clipId;
}

const KIND_LABEL: Record<TransitionKind, string> = { crossfade: "Crossfade", fadeIn: "Fade in", fadeOut: "Fade out" };

/**
 * Is the timing of this clip locked by a transition? If locked, returns a message that can be sent
 * straight back to the Agent.
 *
 * "Locked" refers to the **relative relationship**: moving one segment individually, resizing or
 * splitting is not allowed. Translating the whole group together is unaffected (the store's moveClip
 * moves the whole group together).
 */
export function timingLock(p: Project, clipId: string): { transitions: Transition[]; members: string[]; message: string } | null {
  const hits = transitionsOfClip(p, clipId);
  if (hits.length === 0) return null;
  const { members } = groupOf(p, clipId);
  const parts = hits.map((tr) => {
    const who = tr.kind === "crossfade" ? `and "${clipName(p, tr.aId === clipId ? tr.bId! : tr.aId)}"` : "";
    return `${KIND_LABEL[tr.kind]}${who}(transitionId ${tr.id})`;
  });
  const others = members.filter((id) => id !== clipId);
  const groupNote = others.length ? `Others in this group: ${others.map((id) => `${clipName(p, id)}(${id})`).join(", ")}.` : "";
  return {
    transitions: hits,
    members,
    message:
      `This clip has transitions attached: ${parts.join(";")}. The transitions bind it with related clips into one group, so changing its time alone would break them. ${groupNote}` +
      `To change it, first call remove_transition({transitionId}). Shifting the whole group together is not restricted: move any one clip with update_clip and the rest of the group follows.`,
  };
}

function findClipIn(p: Project, clipId: string): { clip: TrackClip; track: Track } | null {
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

export function clampDur(dur: unknown, fallback = 0.5): number {
  const v = typeof dur === "number" && Number.isFinite(dur) ? dur : fallback;
  return Math.min(MAX_TRANSITION_DUR, Math.max(MIN_TRANSITION_DUR, v));
}

/**
 * Validation before adding a crossfade. Returns the two segments in sorted order (a first), or a
 * sentence giving the reason for refusal
 */
export function checkCrossfade(
  p: Project,
  aId: string,
  bId: string,
  dur: number,
): { ok: true; a: TrackClip; b: TrackClip; dur: number } | { ok: false; error: string } {
  if (aId === bId) return { ok: false, error: "A crossfade needs two different clips" };
  const A = findClipIn(p, aId);
  const B = findClipIn(p, bId);
  if (!A) return { ok: false, error: `Clip ${aId} not found` };
  if (!B) return { ok: false, error: `Clip ${bId} not found` };
  // Whichever comes first is a: getting the argument order backwards is common, so sort it here
  // instead of making the Agent retry
  const [first, second] = A.clip.start <= B.clip.start ? [A, B] : [B, A];
  for (const hit of [first, second]) {
    const lock = transitionsOfClip(p, hit.clip.id).find((tr) => tr.kind === "crossfade");
    if (lock) {
      return { ok: false, error: `"${clipName(p, hit.clip.id)}" already has a crossfade (transitionId ${lock.id}); a clip can take part in at most one crossfade, so delete that one first` };
    }
  }
  const d = clampDur(dur);
  const shortest = Math.min(first.clip.end - first.clip.start, second.clip.end - second.clip.start);
  if (d >= shortest) {
    return { ok: false, error: `Transition of ${d}s is longer than one of the clips (shortest clip is ${shortest.toFixed(1)}s), use a shorter duration` };
  }
  // They must meet end to end (or already overlap): two clips with a big gap between them cannot
  // be joined by a transition
  const gap = second.clip.start - first.clip.end;
  if (gap > 0.001) {
    return { ok: false, error: `There is a ${gap.toFixed(1)}s gap between the two clips, and a crossfade can only join two clips that touch end to start. First move the later clip to the end of the earlier one` };
  }
  return { ok: true, a: first.clip, b: second.clip, dur: d };
}

/** Validation before adding a fade-in / fade-out */
export function checkFade(
  p: Project,
  clipId: string,
  kind: "fadeIn" | "fadeOut",
  dur: number,
): { ok: true; clip: TrackClip; dur: number } | { ok: false; error: string } {
  const hit = findClipIn(p, clipId);
  if (!hit) return { ok: false, error: `Clip ${clipId} not found` };
  const already = transitionsOfClip(p, clipId).find((tr) => tr.kind === kind && tr.aId === clipId);
  if (already) return { ok: false, error: `This clip already has a ${KIND_LABEL[kind].toLowerCase()} (transitionId ${already.id})` };
  // A fade-in can only be added at the start and a fade-out only at the end: that is their definition,
  // not an option.
  // An end that already takes part in a crossfade cannot take another fade on top: two sets of fades on
  // the same end would fight each other.
  const owner = fadeOwner(p, clipId, kind);
  if (owner) {
    return { ok: false, error: `The ${kind === "fadeIn" ? "start" : "end"} of this clip is already taken by a crossfade (transitionId ${owner.id}), so a ${KIND_LABEL[kind].toLowerCase()} cannot be added` };
  }
  const d = clampDur(dur);
  const len = hit.clip.end - hit.clip.start;
  if (d >= len) return { ok: false, error: `${KIND_LABEL[kind]} of ${d}s is longer than the clip itself (${len.toFixed(1)}s)` };
  return { ok: true, clip: hit.clip, dur: d };
}

/**
 * When a transition is dragged to some position on the timeline, which kind should be added?
 *
 *   - dropped where two segments meet end to end (within EDGE seconds either side of the seam) →
 *     crossfade;
 *   - dropped at the **start** of a segment → fade-in; dropped at the **end** → fade-out;
 *   - dropped in the middle → add nothing (returns null), and the UI uses this to show "Drag to the
 *     ends of a clip or to the seam between two clips".
 */
export function planTransitionDrop(
  p: Project,
  trackId: string,
  sec: number,
  edge = 0.6,
): { kind: TransitionKind; aId: string; bId?: string } | null {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return null;
  const clips = [...track.clips].sort((x, y) => x.start - y.start);
  // Check seams first: two segments that meet, with the drop target close enough to the seam
  for (let i = 0; i < clips.length - 1; i++) {
    const a = clips[i];
    const b = clips[i + 1];
    if (Math.abs(b.start - a.end) > 0.001) continue;
    if (Math.abs(sec - a.end) <= edge) return { kind: "crossfade", aId: a.id, bId: b.id };
  }
  const inside = clips.find((c) => sec >= c.start - edge && sec <= c.end + edge);
  if (!inside) return null;
  const fromStart = sec - inside.start;
  const fromEnd = inside.end - sec;
  const near = Math.min(edge, (inside.end - inside.start) / 3);
  if (fromStart <= near) return { kind: "fadeIn", aId: inside.id };
  if (fromEnd <= near) return { kind: "fadeOut", aId: inside.id };
  return null;
}

/** A one-line description for the UI */
export function describeTransition(p: Project, tr: Transition): string {
  if (tr.kind === "crossfade") return `${clipName(p, tr.aId)} → ${clipName(p, tr.bId ?? "")} crossfade ${tr.dur.toFixed(1)}s`;
  return `${clipName(p, tr.aId)} ${KIND_LABEL[tr.kind].toLowerCase()} ${tr.dur.toFixed(1)}s`;
}

export { KIND_LABEL as TRANSITION_LABEL };
