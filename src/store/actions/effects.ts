import { findClip, newId, type Track, type TrackClip } from "../../kernel/project";
import { stripFilterFromCuts, withoutFilter } from "../../kernel/cuts";
import type { ClipFilter, FilterDef } from "../../kernel/filters.mjs";
import type { ClipPixelMap, PixelMapDef } from "../../kernel/pixelMap.mjs";
import { checkCrossfade, checkFade, clampDur, transitionsOf, type Transition, type TransitionKind } from "../../kernel/transitions";

import { state, setProject, clearTransitionFades, updateTrack, sortClips } from "../core";
import { tr as trText } from "../../i18n/index.ts";

export const effects = {

  /* ---------- Filter library (project-level, shared across all cuts like assets) ---------- */
  /**
   * Stores into the library; if attach is provided, attaches to that clip in the same step
   * (one setProject = one undo step; otherwise, a single undo only detaches it while it remains
   * in the library)
   */
  addFilter(def: FilterDef, attach?: { clipId: string; filter: ClipFilter }) {
    const p = state.project;
    let tracks = p.tracks;
    if (attach) {
      const hit = findClip(p, attach.clipId);
      if (hit) tracks = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === attach.clipId ? { ...c, filter: attach.filter } : c)) })).tracks;
    }
    setProject({ ...p, tracks, filters: [...(p.filters ?? []), def] });
  },
  updateFilter(filterId: string, def: FilterDef) {
    setProject({ ...state.project, filters: (state.project.filters ?? []).map((f) => (f.id === filterId ? def : f)) });
  },
  /**
   * Deletes a filter: clips with it attached in active and parked cuts are also detached,
   * leaving no references pointing to the deleted filter
   */
  removeFilter(filterId: string) {
    const p = state.project;
    setProject(stripFilterFromCuts({
      ...p,
      filters: (p.filters ?? []).filter((f) => f.id !== filterId),
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.filter?.id === filterId ? withoutFilter(c) : c)) })),
    }, filterId));
  },

  /**
   * Attaches / replaces / detaches a filter on a clip (null = detach). Returns false if clip
   * is not found; validation is on the caller
   */
  setClipFilter(clipId: string, filter: ClipFilter | null): boolean {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id !== clipId ? c : filter ? { ...c, filter } : withoutFilter(c))),
    })));
    return true;
  },

  /* ---------- Generic pixel maps ---------- */
  addPixelMap(def: PixelMapDef, attach?: { clipId: string; pixelMap: ClipPixelMap }) {
    const p = state.project;
    let tracks = p.tracks;
    if (attach) {
      const hit = findClip(p, attach.clipId);
      if (hit) tracks = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => c.id === attach.clipId ? { ...c, pixelMap: attach.pixelMap } : c) })).tracks;
    }
    setProject({ ...p, tracks, pixelMaps: [...(p.pixelMaps ?? []), def] });
  },
  updatePixelMap(id: string, def: PixelMapDef) {
    setProject({ ...state.project, pixelMaps: (state.project.pixelMaps ?? []).map((x) => x.id === id ? def : x) });
  },
  removePixelMap(id: string) {
    const p = state.project;
    setProject({ ...p, pixelMaps: (p.pixelMaps ?? []).filter((x) => x.id !== id), tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => c.pixelMap?.id === id ? (() => { const { pixelMap, ...rest } = c; return rest; })() : c) })) });
  },
  setClipPixelMap(clipId: string, pixelMap: ClipPixelMap | null): boolean {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => c.id === clipId ? (pixelMap ? { ...c, pixelMap } : (() => { const { pixelMap: _, ...rest } = c; return rest; })()) : c) })));
    return true;
  },

  /* ---------- Transitions: adding one binds related clips into a group (rules in kernel/transitions.ts) ---------- */

  /**
   * Adds a transition.
   *
   *   - crossfade: requires two consecutive clips touching end-to-end. Since clips cannot overlap
   *     within the same track, the second clip is pulled forward to create an overlap and moved to
   *     another track if necessary (its position before moving is recorded in prevB and restored
   *     when deleting the transition);
   *   - fadeIn / fadeOut: only operates on a single clip, written to its start and end respectively.
   *
   * The entire operation is committed in a single setProject: a single undo step reverts everything,
   * without leaving a half-finished state where it was "moved but not bound".
   */
  addTransition(args: { kind: TransitionKind; clipId: string; otherClipId?: string; dur?: number }):
    { ok: true; transition: Transition } | { ok: false; error: string } {
    const p = state.project;
    const dur = clampDur(args.dur, args.kind === "crossfade" ? 0.5 : 0.6);

    if (args.kind === "fadeIn" || args.kind === "fadeOut") {
      const chk = checkFade(p, args.clipId, args.kind, dur);
      if (!chk.ok) return chk;
      const tr: Transition = { id: newId("tx"), kind: args.kind, aId: args.clipId, dur: chk.dur };
      const hit = findClip(p, args.clipId)!;
      const next = updateTrack(p, hit.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === args.clipId ? { ...c, [args.kind]: chk.dur } : c)),
      }));
      setProject({ ...next, transitions: [...transitionsOf(next), tr] });
      return { ok: true, transition: tr };
    }

    if (!args.otherClipId) return { ok: false, error: trText("A crossfade needs two clips: clipId and otherClipId") };
    const chk = checkCrossfade(p, args.clipId, args.otherClipId, dur);
    if (!chk.ok) return chk;
    const { a, b } = chk;
    const aTrack = findClip(p, a.id)!.track;
    const bTrack = findClip(p, b.id)!.track;
    const len = b.end - b.start;
    const newStart = Math.max(0, b.start - chk.dur);
    const fits = (tr: Track) =>
      !tr.locked && tr.id !== aTrack.id &&
      !tr.clips.some((c) => c.id !== b.id && Math.max(newStart, c.start) < Math.min(newStart + len, c.end) - 1e-6);

    // Try in-place first (the second clip was not on the first clip's track to begin with, and fits
    // when moved), then look for others, finally create a new track
    const target = [bTrack, ...p.tracks.filter((t) => t.id !== bTrack.id)].find(fits);
    const newTrack: Track | null = target ? null : { id: newId("t"), name: trText("Track {0}", p.tracks.length + 1), clips: [] };
    const targetId = target?.id ?? newTrack!.id;

    const movedB: TrackClip = { ...b, start: newStart, end: newStart + len, fadeIn: chk.dur };
    let tracks = p.tracks.map((t) => {
      let clips = t.clips.filter((c) => c.id !== b.id);
      if (t.id === aTrack.id) clips = clips.map((c) => (c.id === a.id ? { ...c, fadeOut: chk.dur } : c));
      if (t.id === targetId) clips = sortClips([...clips, movedB]);
      return { ...t, clips };
    });
    if (newTrack) tracks = [...tracks, { ...newTrack, clips: [movedB] }];

    const tr: Transition = {
      id: newId("tx"), kind: "crossfade", aId: a.id, bId: b.id, dur: chk.dur,
      prevB: { start: b.start, trackId: bTrack.id },
    };
    setProject({ ...p, tracks, transitions: [...transitionsOf(p), tr] });
    return { ok: true, transition: tr };
  },

  /**
   * Deletes a transition: clears fades, removes the record, and crossfade also tries to restore
   * the second clip to its position before the transition was added (if that spot is occupied,
   * it stays in place and returns note explaining). Once deleted, these clips are freed.
   */
  removeTransition(transitionId: string): { ok: true; note?: string } | { ok: false; error: string } {
    const p = state.project;
    const tr = transitionsOf(p).find((x) => x.id === transitionId);
    if (!tr) return { ok: false, error: trText("Transition {0} not found", transitionId) };
    let next = clearTransitionFades(p, tr);
    let note: string | undefined;
    if (tr.kind === "crossfade" && tr.bId && tr.prevB) {
      const hit = findClip(next, tr.bId);
      if (hit) {
        const len = hit.clip.end - hit.clip.start;
        const home = next.tracks.find((t) => t.id === tr.prevB!.trackId);
        const free = home && !home.locked && !home.clips.some(
          (c) => c.id !== tr.bId && Math.max(tr.prevB!.start, c.start) < Math.min(tr.prevB!.start + len, c.end) - 1e-6,
        );
        if (free) {
          const moved: TrackClip = { ...hit.clip, start: tr.prevB.start, end: tr.prevB.start + len };
          next = {
            ...next,
            tracks: next.tracks.map((t) => {
              let clips = t.clips.filter((c) => c.id !== tr.bId);
              if (t.id === home!.id) clips = sortClips([...clips, moved]);
              return { ...t, clips };
            }),
          };
        } else {
          note = trText("The original position of the later clip is occupied, so it stays at its current position (the two clips still overlap; you can move them apart yourself)");
        }
      }
    }
    setProject({ ...next, transitions: transitionsOf(next).filter((x) => x.id !== transitionId) });
    return { ok: true, ...(note ? { note } : {}) };
  },
  /**
   * Connects two adjacent media clips with a crossfade: the second clip is pulled forward to create
   * a dur-second overlap, with dur seconds of fade added to each side. Overlapping within the same
   * track is not allowed, so the second clip must land on another track: if no existing track can fit
   * it, a new one is created. Returns whether successful.
   */
  /**
   * Legacy name kept for existing callers: now equivalent to addTransition({ kind: "crossfade" }).
   * Must follow that path: only it writes down the transition record and binds the two clips into
   * a group; merely setting fadeIn / fadeOut allows anyone to move one of the clips away at will,
   * silently breaking the crossfade.
   */
  applyCrossfade(aId: string, bId: string, dur: number): boolean {
    return effects.addTransition({ kind: "crossfade", clipId: aId, otherClipId: bId, dur }).ok;
  },
};
