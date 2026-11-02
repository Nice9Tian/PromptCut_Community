/**
 * "Main content" of the mobile app thumbnail timeline (semantics `workflow/editing.md` "Mobile app
 * interface"; term `glossary.md` "Main content"; mechanism `mechanism/platforms.md` "Main content of the
 * mobile app thumbnail timeline").
 *
 * It is taken in two steps (user decision, 2026-10-23: "we need an algorithm for a simplified match... get it working first (something
 * that can be displayed, with thumbnails for both start time and end time)"):
 * 1. **Main track**: the video segments, image segments and cut segments on the main track of the
 *    current cut (the lowest track holding videos / images / cut segments), plus the next segment
 *    that they crossfade into (a crossfade moves the next segment onto another track,
 *    `kernel/transitions.ts`).
 * 2. **Fill gaps**: from 0 to the end of the last visible content, gaps not covered by step 1 and
 *    longer than `GAP_MIN` are filled by time with the visible segments (audio segments do not count)
 *    on the other tracks that are not hidden: at each gap, among the segments covering that moment, pick
 *    the longest (on a tie pick the track that is lower), and if no segment covers that moment, jump
 *    to the segment that starts earliest within the gap; a segment filled in only takes the part that
 *    falls inside the gap (trimming off the part overlapping step 1), so there is only one block at
 *    any moment and the blocks do not overlap in time order. A very long segment (for example a
 *    background card laid underneath) can fill a piece in several gaps, in which case the same id
 *    appears more than once. In a project with only cards, step 1 yields no block at all, and the
 *    whole strip relies on step 2.
 *
 * Pure function: only reads the Project, does not touch the store. A segment that was filled in and
 * then trimmed is a new object (same id), not the one in the project.
 */
import { isImageMedia, type MediaAsset, type Project, type Track, type TrackClip } from "../kernel/project.ts";
import { transitionsOf, timingLock, type Transition } from "../kernel/transitions.ts";
import { tr as trText } from "../i18n/index.ts";

export type ClipKind = "video" | "image" | "audio" | "cut" | "card";

function mediaOf(p: Project, clip: TrackClip): MediaAsset | undefined {
  return clip.mediaId ? p.media.find((m) => m.id === clip.mediaId) : undefined;
}

export function clipKind(p: Project, clip: TrackClip): ClipKind {
  if (clip.cutId) return "cut";
  const m = mediaOf(p, clip);
  if (m) return m.kind === "audio" ? "audio" : isImageMedia(m) ? "image" : "video";
  return "card";
}

/** Segments that can be main content: video segments, image segments, cut segments */
export function isMainKind(p: Project, clip: TrackClip): boolean {
  const k = clipKind(p, clip);
  return k === "video" || k === "image" || k === "cut";
}

/** Main track: the lowest track (the last one in tracks) that holds main content; if none does, the lowest track */
export function mainTrackOf(p: Project): Track | undefined {
  for (let i = p.tracks.length - 1; i >= 0; i--) {
    if (p.tracks[i].clips.some((c) => isMainKind(p, c))) return p.tracks[i];
  }
  return p.tracks[p.tracks.length - 1];
}

/** Gaps shorter than this are not filled (seconds); when all visible content is very short, 5% of it is used, so short projects can still be filled. See step 2 in the file header */
const GAP_MIN = 0.5;
const GAP_FRAC = 0.05;
const EPS = 1e-6;

/** Step 1: video / image / cut segments on the main track, plus the next segment they crossfade into */
function mainTrackClips(p: Project): TrackClip[] {
  const track = mainTrackOf(p);
  if (!track) return [];
  const picked = new Map<string, TrackClip>();
  for (const c of track.clips) if (isMainKind(p, c)) picked.set(c.id, c);
  // The next segment crossfaded into (possibly on another track) counts too
  const all = new Map(p.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const tr of transitionsOf(p)) {
      if (tr.kind !== "crossfade" || !tr.bId || !picked.has(tr.aId) || picked.has(tr.bId)) continue;
      const b = all.get(tr.bId);
      if (b && isMainKind(p, b)) { picked.set(b.id, b); grew = true; }
    }
  }
  return [...picked.values()];
}

/** A filled-in segment keeps only the [s, e) piece; the in point of a video segment moves later accordingly, and the thumbnail still takes the first frame of this piece */
function trimTo(c: TrackClip, s: number, e: number): TrackClip {
  if (Math.abs(s - c.start) < EPS && Math.abs(e - c.end) < EPS) return c;
  const out: TrackClip = { ...c, start: s, end: e };
  if (c.mediaId && s > c.start) out.mediaOffset = (c.mediaOffset ?? 0) + (s - c.start);
  return out;
}

export function mainClipsOf(p: Project): TrackClip[] {
  const base = mainTrackClips(p);
  const taken = new Set(base.map((c) => c.id));
  // Candidates: visible segments on tracks that are not hidden and not yet taken; record the track position (larger = lower)
  const cands: { c: TrackClip; lvl: number }[] = [];
  p.tracks.forEach((t, lvl) => {
    if (t.hidden) return;
    for (const c of t.clips) if (!taken.has(c.id) && c.end - c.start > EPS && clipKind(p, c) !== "audio") cands.push({ c, lvl });
  });
  const end = Math.max(0, ...base.map((c) => c.end), ...cands.map((x) => x.c.end));
  const gapMin = Math.min(GAP_MIN, end * GAP_FRAC);
  // Gaps not covered by step 1
  const covered = [...base].sort((a, b) => a.start - b.start);
  const gaps: [number, number][] = [];
  let x = 0;
  for (const c of covered) {
    if (c.start > x + EPS) gaps.push([x, c.start]);
    x = Math.max(x, c.end);
  }
  if (end > x + EPS) gaps.push([x, end]);
  const out = [...base];
  for (const [g0, g1] of gaps) {
    if (g1 - g0 < gapMin) continue;
    let at = g0;
    while (at < g1 - EPS) {
      const live = cands.filter((k) => k.c.end > at + EPS && k.c.start < g1 - EPS);
      if (!live.length) break;
      const here = live.filter((k) => k.c.start <= at + EPS);
      if (!here.length) { at = Math.min(...live.map((k) => k.c.start)); continue; }
      const best = here.reduce((a, b) => {
        const da = a.c.end - a.c.start, db = b.c.end - b.c.start;
        return db > da + EPS || (Math.abs(db - da) <= EPS && b.lvl > a.lvl) ? b : a;
      });
      const e = Math.min(best.c.end, g1);
      out.push(trimTo(best.c, at, e));
      at = e;
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Transition between two main-content segments: first recognize a crossfade between the two segments, then the fade-out of the previous one and the fade-in of the next one. If none, it is null (a "+" is drawn on the thumbnail timeline).
 */
export function boundaryTransition(p: Project, a: TrackClip, b: TrackClip): Transition | null {
  const list = transitionsOf(p);
  return (
    list.find((tr) => tr.kind === "crossfade" && tr.aId === a.id && tr.bId === b.id) ??
    list.find((tr) => tr.kind === "fadeOut" && tr.aId === a.id) ??
    list.find((tr) => tr.kind === "fadeIn" && tr.aId === b.id) ??
    null
  );
}

/** What a clip is called in the UI: display name → media name → cut name → card id */
export function clipName(p: Project, clip: TrackClip, cardName?: (cardId: string) => string | undefined): string {
  if (clip.label) return clip.label;
  const m = mediaOf(p, clip);
  if (m) return m.name;
  if (clip.cutId) return p.cuts?.find((c) => c.id === clip.cutId)?.name ?? trText("Cut segment");
  return cardName?.(clip.cardId) ?? clip.cardId ?? trText("Clips");
}

export interface ReorderPlan {
  /** The segment to move and its new start (duration unchanged) */
  moves: { id: string; start: number }[];
}

/**
 * Reorder main content: lay out in the new order, keeping the gap between each of the original
 * positions (new start of segment k = start of the original k-th position + the difference of the
 * durations of the segments before it).
 * Only computes, does not modify; returns `{ error }` when it does not fit (collides with other
 * segments on the main track) or a transition locks it (the relative time is part of the transition,
 * `kernel/transitions.ts`).
 */
export function planReorder(p: Project, order: string[]): ReorderPlan | { error: string } {
  const main = mainClipsOf(p);
  const byId = new Map(main.map((c) => [c.id, c]));
  if (order.length !== main.length || order.some((id) => !byId.has(id))) return { error: trText("The main content changed, please try again.") };
  const moves: { id: string; start: number }[] = [];
  let shift = 0;
  order.forEach((id, k) => {
    const slot = main[k];
    const c = byId.get(id)!;
    const start = slot.start + shift;
    shift += (c.end - c.start) - (slot.end - slot.start);
    if (Math.abs(start - c.start) > 1e-6) moves.push({ id, start });
  });
  if (!moves.length) return { moves };
  if (moves.some((m) => timingLock(p, m.id))) return { error: trText("Segments with transitions need the transition removed before reordering.") };
  const track = mainTrackOf(p)!;
  // Clips added by gap filling (not on the main track, or only a slice of them taken) do not take part in reordering: their positions are decided by another track
  const real = new Map(track.clips.map((c) => [c.id, c] as const));
  if (moves.some(({ id }) => { const c = byId.get(id)!, r = real.get(id); return !r || Math.abs(r.start - c.start) > EPS || Math.abs(r.end - c.end) > EPS; }))
    return { error: trText("These segments are not all on the main track. Adjust positions in the timeline tab.") };
  const moved = new Set(moves.map((m) => m.id));
  const companions = new Set(track.clips.filter((c) => c.soundEffect?.sourceClipId && moved.has(c.soundEffect.sourceClipId)).map((c) => c.id));
  const placed = track.clips
    .filter((c) => !companions.has(c.id))
    .map((c) => {
      const m = moves.find((x) => x.id === c.id);
      return m ? { start: m.start, end: m.start + (c.end - c.start) } : { start: c.start, end: c.end };
    })
    .sort((a, b) => a.start - b.start);
  if (placed.some((c, i) => c.start < -1e-6 || (i > 0 && c.start < placed[i - 1].end - 1e-6))) return { error: trText("The new order does not fit on the main track.") };
  return { moves };
}

/** Total duration of the main content (sum of the clip durations; written in the thumbnail timeline's title row) */
export function mainTotal(clips: TrackClip[]): number {
  return clips.reduce((s, c) => s + (c.end - c.start), 0);
}

/**
 * Thumbnail cards have equal widths: convert the ratio f of the current-frame marker inside card i to project time.
 * Between two cards (at a transition marker) it takes the start of the next clip.
 * `pos` is the marker's position in the card sequence: the integer part is the card index, the fractional part is the ratio inside the card; past the end it returns the end of the last clip.
 */
export function timeAtCardPos(clips: TrackClip[], pos: number): number {
  if (!clips.length) return 0;
  if (pos <= 0) return clips[0].start;
  const i = Math.floor(pos);
  if (i >= clips.length) return clips[clips.length - 1].end;
  const c = clips[i];
  return c.start + (pos - i) * (c.end - c.start);
}

/** The reverse: project time → position in the card sequence. A time in the gap between two clips counts as the start of the next clip, and a time after the last clip counts as the end */
export function cardPosAtTime(clips: TrackClip[], t: number): number {
  if (!clips.length) return 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (t < c.start) return i;
    if (t < c.end - 1e-9) return i + (t - c.start) / Math.max(1e-6, c.end - c.start);
  }
  return clips.length;
}
