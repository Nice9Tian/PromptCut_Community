import { newId, type Project, type Track } from "../../kernel/project";
import { transitionsOf } from "../../kernel/transitions";

import { state, set, setProject, clearTransitionFades, updateTrack, pruneCardNodes } from "../core";
import { tr as trText } from "../../i18n/index.ts";

export const tracks = {

  /* ---------- Tracks ---------- */
  /**
   * Adds a track. If opts.index is provided, inserts at that position (used for creating tracks
   * by "dragging between tracks" on the timeline); if omitted, appends to the end of the array.
   */
  addTrack(name?: string, opts: { index?: number } = {}): Track {
    const n = state.project.tracks.length + 1;
    const track: Track = { id: newId("t"), name: name ?? trText("Track {0}", n), clips: [] };
    const tracks = [...state.project.tracks];
    const at = opts.index == null ? tracks.length : Math.max(0, Math.min(tracks.length, opts.index));
    tracks.splice(at, 0, track);
    setProject({ ...state.project, tracks });
    return track;
  },
  removeTrack(trackId: string) {
    tracks.removeTracks([trackId]);
  },
  /**
   * Deletes tracks (single undo step). Transitions attached to clips on them are removed together,
   * and fades on the other end remaining on other tracks are cleared: same principle as removeClip;
   * previously, deleting tracks ignored transitions, leaving transitions pointing to non-existent clips.
   */
  removeTracks(trackIds: string[]) {
    const p = state.project;
    const ids = new Set(trackIds);
    const gone = new Set(p.tracks.filter((t) => ids.has(t.id)).flatMap((t) => t.clips.map((c) => c.id)));
    const doomed = transitionsOf(p).filter((tr) => gone.has(tr.aId) || (tr.bId !== undefined && gone.has(tr.bId)));
    let next: Project = { ...p, tracks: p.tracks.filter((t) => !ids.has(t.id)) };
    for (const tr of doomed) next = clearTransitionFades(next, tr);
    if (doomed.length) next = { ...next, transitions: transitionsOf(next).filter((tr) => !doomed.includes(tr)) };
    setProject(pruneCardNodes(next));
    if (state.selection.some((id) => gone.has(id))) set({ selection: state.selection.filter((id) => !gone.has(id)) });
  },
  updateTrack(trackId: string, patch: Partial<Pick<Track, "name" | "hidden" | "locked" | "muted">>) {
    setProject(updateTrack(state.project, trackId, (t) => ({ ...t, ...patch })));
  },
  moveTrack(trackId: string, toIndex: number) {
    const tracks = [...state.project.tracks];
    const i = tracks.findIndex((t) => t.id === trackId);
    if (i < 0) return;
    const [tr] = tracks.splice(i, 1);
    tracks.splice(Math.max(0, Math.min(tracks.length, toIndex)), 0, tr);
    setProject({ ...state.project, tracks });
  },
};
