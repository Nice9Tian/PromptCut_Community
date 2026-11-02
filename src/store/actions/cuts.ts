import {
  switchCut as switchCutPure, addCut as addCutPure, renameCut as renameCutPure,
  removeCut as removeCutPure, placeCutSegment,
} from "../../kernel/cuts";
import { CUT_SEGMENT_REF_FIXED, cutCycleReason, cutDuration, cutReferences, isCutSegment } from "../../kernel/cutSegments";
import { findClip, newId, type Track, type TrackClip } from "../../kernel/project";

import { state, set, setProject, updateTrack, runInCutScope } from "../core";
import { tr } from "../../i18n/index.ts";

export const cuts = {

  /* ---------- Cuts (multiple timelines) ---------- */
  /**
   * Switch to another cut. Current tracks / duration / playhead are saved back to its entry, and the
   * target's are swapped in. Enters the undo stack (together with the entire project; undoing simply
   * switches back); selection is cleared, playback stops, and manual total duration is cleared: these
   * all belong to the previous cut. Playhead uses the target's position when last exited.
   */
  switchCut(cutId: string) {
    const { project, t } = switchCutPure(state.project, cutId, state.t);
    if (project === state.project) return;
    setProject(project);
    set({ t, playing: false, selection: [], playToken: state.playToken + 1, durationManual: null });
  },
  /** Create a new cut and switch to it by default (consistent with NLE conventions for creating a sequence) */
  addCut(name?: string, opts: { switchTo?: boolean } = {}) {
    const { project, cut } = addCutPure(state.project, name);
    setProject(project);
    if (opts.switchTo !== false) cuts.switchCut(cut.id);
    return cut;
  },
  renameCut(cutId: string, name: string) {
    setProject(renameCutPure(state.project, cutId, name));
  },
  /**
   * Delete a cut. Deleting the active cut switches to an adjacent one first; the last cut cannot be
   * deleted (throws in pure logic). When referenced by other cuts, cut segments referencing it are
   * deleted along with transitions (explanation and confirmation are caller responsibilities: media
   * library prompts confirmation, Agent tools require force). One-step undo restores everything.
   * Returns which cuts contain the deleted cut segments.
   */
  removeCut(cutId: string) {
    const { project, switchedTo, t, removedSegments } = removeCutPure(state.project, cutId, state.t);
    setProject(project);
    if (switchedTo) set({ t, playing: false, selection: [], playToken: state.playToken + 1, durationManual: null });
    else set({ selection: state.selection.filter((id) => !removedSegments.some((r) => r.clipIds.includes(id))) });
    return { removedSegments };
  },
  /**
   * Modify clips in a parked cut in place: actions inside fn are written as usual assuming "this cut
   * is active"; upon commit, only its entry is modified, leaving the active cut and activeCutId
   * untouched (no switching, without flipping anyone's UI). fn must be synchronous. See store/core.ts
   * `runInCutScope`.
   */
  editInCut<T>(cutId: string, fn: () => T): T {
    return runInCutScope(cutId, fn);
  },
  /** Cuts that directly reference this cut (shown to user prior to deletion) */
  cutReferences(cutId: string) {
    return cutReferences(state.project, cutId);
  },
  /** Whether placing cut `childCutId` into the active cut causes circular references; returns the reason if so */
  cutCycleReason(childCutId: string): string | null {
    const host = state.project.activeCutId;
    return host ? cutCycleReason(state.project, host, childCutId) : null;
  },
  /**
   * Places a cut segment referencing `childCutId` in the active cut (drag and drop, Agent tool).
   * If `newTrackIndex` is provided, creates a new track and places it there; circular references,
   * cut not found, or track cannot fit all throw, with human-readable error messages.
   * Default duration = remaining duration of the referenced cut (from offset onwards).
   */
  addCutSegment(childCutId: string, start: number, opts: { trackId?: string; newTrackIndex?: number; duration?: number; offset?: number } = {}): TrackClip {
    let p = state.project;
    let trackId = opts.trackId;
    if (opts.newTrackIndex !== undefined || (!trackId && !p.tracks.length)) {
      const track: Track = { id: newId("t"), name: tr("Track {0}", p.tracks.length + 1), clips: [] };
      const tracks = [...p.tracks];
      const at = Math.max(0, Math.min(tracks.length, opts.newTrackIndex ?? tracks.length));
      tracks.splice(at, 0, track);
      p = { ...p, tracks };
      trackId = track.id;
    } else if (!trackId) {
      // No track specified: pick the first one that is unlocked and unoccupied during this time
      const free = p.tracks.find((t) => !t.locked && !t.clips.some((c) => c.start < start + 0.05 && start < c.end));
      trackId = (free ?? p.tracks.find((t) => !t.locked))?.id;
    }
    const { project, clip } = placeCutSegment(p, childCutId, start, { trackId, duration: opts.duration, offset: opts.offset });
    setProject(project);
    set({ selection: [clip.id] });
    return clip;
  },
  /**
   * Changes which second of the referenced cut the cut segment starts from. Throws if the offset
   * exceeds the total duration of the referenced cut. Which cut is referenced cannot be changed
   * (user decision, 2026-10-21, `workflow/editing.md` "Cut segment properties"): to replace it,
   * delete this segment and place it again, so this action only accepts `cutOffset`, and the reference
   * cannot be changed elsewhere either. If the segment is too long after the change, the out point is
   * clamped to the remaining duration of the referenced cut (when creating or extending a cut segment,
   * it cannot exceed the referenced cut's total duration at that time).
   */
  setCutSegment(clipId: string, patch: { cutOffset?: number }): TrackClip {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit || !isCutSegment(hit.clip)) throw new Error(tr("{0} is not a cut segment", clipId));
    if (hit.track.locked) throw new Error(tr("Track \"{0}\" is locked", hit.track.name));
    if (patch && Object.hasOwn(patch, "cutId")) throw new Error(CUT_SEGMENT_REF_FIXED);
    const cutId = hit.clip.cutId!;
    const offset = Math.max(0, patch.cutOffset ?? hit.clip.cutOffset ?? 0);
    const total = cutDuration(p, cutId);
    if (offset >= total) throw new Error(tr("Offset {0} s exceeds the total duration of the referenced cut, {1} s", offset, total));
    const { cutOffset: _o, ...rest } = hit.clip;
    const next: TrackClip = { ...rest, cutId, end: Math.min(hit.clip.end, hit.clip.start + (total - offset)), ...(offset > 0 ? { cutOffset: offset } : {}) };
    setProject(updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? next : c)) })));
    return next;
  },
};
