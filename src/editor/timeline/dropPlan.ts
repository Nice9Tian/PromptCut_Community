import type { Project } from "../../kernel/project";
import { planPlacement } from "../../store/project";
import { formatTime, snapTime } from "./utils";
import { checkCrossfade, checkFade, clampDur, planTransitionDrop, TRANSITION_LABEL } from "../../kernel/transitions";
import { describeEmphasis } from "../../kernel/emphasis";
import { cutCycleReason } from "../../kernel/cutSegments";
import { type DragPayload } from "../dnd";
import { tr } from "../../i18n/index.ts";

/**
 * The full description of "what this drag will turn into". It is computed once on dragover to draw the drop
 * preview, and once more on drop to land accordingly.
 * Both use the same function, so what you see is always what lands.
 */
export interface DropPlan {
  /** Landing on an existing track = the track id; landing on a new track = null (see newTrackIndex) */
  trackId: string | null;
  /** The position in the tracks array where the new track is inserted (null when landing on an existing track) */
  newTrackIndex: number | null;
  start: number;
  end: number;
  /** ok = lands in place; shift = the spot is taken, so it shifts to the next free gap; forbidden = cannot land */
  status: "ok" | "shift" | "forbidden";
  /** One line of explanation shown on the drop preview */
  hint: string;
  /** The name shown on the drop preview */
  label: string;
}

export type DropTarget = { trackId: string } | { newTrackIndex: number };

/** Emphasis lands on a given span: the clip directly underneath at the moment of the drop */
export function clipAt(project: Project, trackId: string, sec: number): { id: string; start: number; end: number } | null {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || track.locked) return null;
  const c = track.clips.find((x) => sec >= x.start && sec < x.end);
  return c ? { id: c.id, start: c.start, end: c.end } : null;
}

/** The conclusion of the transition drop computation: on drop, call addTransition accordingly */
export interface TransitionPlan {
  kind: "crossfade" | "fadeIn" | "fadeOut";
  aId: string;
  bId?: string;
  dur: number;
}

/**
 * Preview while dragging a transition over the timeline: a crossfade on a seam, fade in / fade out at the
 * two ends of a clip, and anywhere else it says plainly "drag to either end of a clip or the seam between
 * two clips". Cases that cannot be added (empty in the middle, duration too short) are also explained
 * here, to avoid an error only after release.
 */
export function planTransition(
  project: Project,
  kind: "crossfade" | "fadeIn" | "fadeOut",
  trackId: string,
  rawSec: number,
  dur: number,
): { plan: TransitionPlan | null; status: "ok" | "forbidden"; hint: string; span: { start: number; end: number } | null } {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return { plan: null, status: "forbidden", hint: tr("Track not found"), span: null };
  if (track.locked) return { plan: null, status: "forbidden", hint: tr("Track is locked"), span: null };
  const spot = planTransitionDrop(project, trackId, rawSec);
  if (!spot) {
    return { plan: null, status: "forbidden", hint: kind === "crossfade" ? tr("Drop where two clips meet end to start") : tr("Drop at the start or end of a clip"), span: null };
  }
  // Only the kind being dragged is accepted: dragging "fade in" onto a seam still gives fade in (at the head of the later clip)
  const wanted = kind === "crossfade" ? spot : { kind, aId: spot.kind === "crossfade" && kind === "fadeIn" ? spot.bId! : spot.aId };
  const d = clampDur(dur);
  if (wanted.kind === "crossfade") {
    const chk = checkCrossfade(project, wanted.aId, wanted.bId!, d);
    if (!chk.ok) return { plan: null, status: "forbidden", hint: chk.error, span: null };
    return {
      plan: { kind: "crossfade", aId: chk.a.id, bId: chk.b.id, dur: chk.dur },
      status: "ok",
      hint: tr("Crossfade {0}s", chk.dur.toFixed(1)),
      span: { start: chk.b.start - chk.dur, end: chk.b.start },
    };
  }
  const side = wanted.kind as "fadeIn" | "fadeOut";
  const chk = checkFade(project, wanted.aId, side, d);
  if (!chk.ok) return { plan: null, status: "forbidden", hint: chk.error, span: null };
  const span = side === "fadeIn"
    ? { start: chk.clip.start, end: chk.clip.start + chk.dur }
    : { start: chk.clip.end - chk.dur, end: chk.clip.end };
  return { plan: { kind: side, aId: chk.clip.id, dur: chk.dur }, status: "ok", hint: `${tr(TRANSITION_LABEL[side])} ${chk.dur.toFixed(1)}s`, span };
}

export function planDrop(
  project: Project,
  payload: DragPayload,
  target: DropTarget,
  rawSec: number,
  opts: { altKey: boolean; pxPerSec: number; t: number },
): DropPlan {
  // Emphasis takes no space either: it is added to whichever clip it lands on
  if (payload.kind === "emphasis") {
    const base = { label: payload.name, trackId: null as string | null, newTrackIndex: null as number | null };
    if ("newTrackIndex" in target) {
      return { ...base, start: rawSec, end: rawSec, status: "forbidden", hint: tr("Emphasis must land on an existing clip") };
    }
    const hit = clipAt(project, target.trackId, rawSec);
    if (!hit) return { ...base, trackId: target.trackId, start: rawSec, end: rawSec, status: "forbidden", hint: tr("Drop onto a clip") };
    return {
      ...base, trackId: target.trackId, start: hit.start, end: hit.end, status: "ok",
      hint: describeEmphasis(payload.emphasis),
    };
  }

  // A transition takes no space; it binds to clips already on the timeline, so it can only land on an existing track
  if (payload.kind === "transition") {
    const base = { label: payload.name, trackId: null as string | null, newTrackIndex: null as number | null };
    if ("newTrackIndex" in target) {
      return { ...base, start: rawSec, end: rawSec, status: "forbidden", hint: tr("A transition must land on an existing clip and cannot create a track") };
    }
    const r = planTransition(project, payload.transition, target.trackId, rawSec, payload.duration);
    return {
      ...base,
      trackId: target.trackId,
      start: r.span?.start ?? rawSec,
      end: r.span?.end ?? rawSec,
      status: r.status,
      hint: r.hint,
    };
  }
  const dur = Math.max(0.1, payload.duration);
  const start = Math.max(0, snapTime(rawSec, opts.altKey, project, opts.t, undefined, opts.pxPerSec));
  const base = { label: payload.name, trackId: null as string | null, newTrackIndex: null as number | null };

  // Cut: not accepted when dropping it into itself or when it would create a circular reference (at any depth); the drop preview states the reason (workflow/materials.md "Cuts in the media library")
  if (payload.kind === "cut") {
    const reason = project.activeCutId ? cutCycleReason(project, project.activeCutId, payload.cutId) : null;
    if (reason) {
      return { ...base, ...("trackId" in target ? { trackId: target.trackId } : { newTrackIndex: target.newTrackIndex }), start, end: start + dur, status: "forbidden", hint: reason };
    }
  }

  if ("newTrackIndex" in target) {
    return {
      ...base,
      newTrackIndex: target.newTrackIndex,
      start,
      end: start + dur,
      status: "ok",
      hint: tr("Release = create a new track"),
    };
  }

  const track = project.tracks.find((t) => t.id === target.trackId);
  if (!track) {
    return { ...base, start, end: start + dur, status: "forbidden", hint: tr("Track not found") };
  }
  if (track.locked) {
    return { ...base, trackId: track.id, start, end: start + dur, status: "forbidden", hint: tr("Track is locked") };
  }

  const placed = planPlacement(track, start, dur);
  return {
    ...base,
    trackId: track.id,
    start: placed.start,
    end: placed.end,
    status: placed.shifted ? "shift" : "ok",
    hint: placed.shifted ? tr("This spot is taken, moved to {0}", formatTime(placed.start)) : formatTime(placed.start),
  };
}
