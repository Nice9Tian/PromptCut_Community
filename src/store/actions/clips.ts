import { DEFAULT_CARD_DUR, DEFAULT_MEDIA_DUR, findClip, newId, type Track, type TrackClip } from "../../kernel/project";
import { getCard } from "../../kernel/registry";
import { isAudiovisualCard, clipHasEmbeddedAudio, assertAudiovisualCardKind } from "../../kernel/cardAudioRendition.mjs";
import { cloneCardClipInstance } from "../../kernel/cardAuthoring.mjs";
import type { PartInstance } from "../../kernel/types";
import { fadeOwner, groupOf, MIN_TRANSITION_DUR, timingLock, transitionsOf, transitionsOfClip, type Transition } from "../../kernel/transitions";
import { cutDuration } from "../../kernel/cutSegments";
import { CLIP_SPEED_MAX, CLIP_SPEED_MIN, clipSpeed, mediaOffsetAfter, mediaSpanOf, normalizeSpeed, speedInRange, speedLabel, withSpeed } from "../../kernel/clipTime.mjs";

import {
  state, set,
  setProject,
  clearTransitionFades,
  updateTrack,
  pruneCardNodes,
  shiftClipsBy,
  sortClips,
  resolveOverlap,
  placeOrShift, pickTrack
} from "../core";
import { tr as trText } from "../../i18n/index.ts";

/** Keep linked WAV companions on the same timeline anchor; reject overlaps instead of silently shifting audio. */
function moveSoundCompanions(p: import("../../kernel/project").Project, before: TrackClip, after: TrackClip, checkOverlap = true): import("../../kernel/project").Project | null {
  const dt = after.start - before.start;
  const translating = Math.abs((after.end - before.end) - dt) < 1e-9;
  let blocked = false;
  const tracks = p.tracks.map(track => {
    const linked = track.clips.filter(c => c.soundEffect?.sourceClipId === before.id);
    if (!linked.length) return track;
    if (track.locked) { blocked = true; return track; }
    const updated = track.clips.flatMap(c => {
      if (c.soundEffect?.sourceClipId !== before.id) return [c];
      if (translating) return [{ ...c, start: c.start + dt, end: c.end + dt }];
      const sourceShift = dt - ((after.mediaOffset ?? 0) - (before.mediaOffset ?? 0));
      const shiftedStart = c.start + sourceShift, shiftedEnd = c.end + sourceShift;
      const start = Math.max(shiftedStart, after.start), end = Math.min(shiftedEnd, after.end);
      return end > start ? [{ ...c, start, end, mediaOffset: (c.mediaOffset ?? 0) + start - shiftedStart }] : [];
    });
    const sorted = sortClips(updated);
    if (checkOverlap && sorted.some((c, i) => c.start < 0 || (i > 0 && c.start < sorted[i - 1].end - 1e-9))) blocked = true;
    return { ...track, clips: sorted };
  });
  return blocked ? null : { ...p, tracks };
}

export const clips = {

  /* ---------- clip ---------- */
  /** Add a card to a track. If trackId is not provided, pick a track that is free during this time. Returns clip. */
  addCardClip(cardId: string, start: number, opts: { trackId?: string; duration?: number; params?: Record<string, unknown>; parts?: PartInstance[] } = {}): TrackClip | null {
    const def = getCard(cardId);
    if (!def) return null;
    assertAudiovisualCardKind(def);
    // Dragging an audio media effect card into the timeline yields an empty clip with neither sound
    // nor picture (no nodeId, consumers only inspect nodes): it can only be attached to clips via apply_card.
    if (def.kind === "audio" && !isAudiovisualCard(def)) throw new Error(trText("For audio media effect cards, use apply_card"));
    const p = state.project;
    const track = opts.trackId ? p.tracks.find((t) => t.id === opts.trackId) : p.tracks[0];
    if (!track) return null;
    const dur = opts.duration ?? DEFAULT_CARD_DUR;
    const target = opts.trackId ? track : pickTrack(p, start, dur);
    if (!target) return null;
    // Parameters are expanded into a complete set upon writing, leaving no implicit states like
    // "empty = use default value". Callers (UI, AI) still only pass fields to change, but what gets
    // stored into clip is the full set: stored values match rendering, can be inspected directly in
    // the code tab, and exported projects won't change if card defaults are adjusted later.
    let clip: TrackClip = { id: newId("c"), cardId, ...(isAudiovisualCard(def) ? { embeddedAudio: true } : {}), start, end: start + dur, params: { ...def.defaults, ...(opts.params ?? {}) }, ...(opts.parts?.length ? { parts: opts.parts } : {}) };
    clip = placeOrShift(target, clip);
    setProject(updateTrack(p, target.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) })));
    set({ selection: [clip.id] });
    return clip;
  },
  /** Add a media clip to a track. If trackId is not provided, pick a track that is free during this time. */
  addMediaClip(mediaId: string, start: number, opts: { trackId?: string; duration?: number; mediaOffset?: number } = {}): TrackClip | null {
    const p = state.project;
    const media = p.media.find((m) => m.id === mediaId);
    if (!media) return null;
    const track = opts.trackId ? p.tracks.find((t) => t.id === opts.trackId) : p.tracks[0];
    if (!track) return null;
    const dur = opts.duration ?? media.duration ?? DEFAULT_MEDIA_DUR;
    const target = opts.trackId ? track : pickTrack(p, start, dur);
    if (!target) return null;
    let clip: TrackClip = { id: newId("v"), cardId: "", mediaId, mediaOffset: opts.mediaOffset ?? 0, start, end: start + dur, params: {}, label: media.name, ...(media.soundEffect ? { soundEffect: { ...media.soundEffect, requestId: newId("sound-request") } } : {}) };
    clip = placeOrShift(target, clip);
    const duration = Math.max(p.duration, clip.end);
    setProject({ ...updateTrack(p, target.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) })), duration });
    set({ selection: [clip.id] });
    return clip;
  },
  /**
   * Create a new track and place the clip directly on it. One gesture = one-step undo (used for
   * "drag between tracks" and "drag to new track drop zone" on the timeline). The new track is empty,
   * so the clip always lands at start without being shifted forward.
   */
  addClipOnNewTrack(spec: { index?: number; cardId?: string; mediaId?: string; start: number; duration?: number }): TrackClip | null {
    const p = state.project;
    const start = Math.max(0, spec.start);
    let clip: TrackClip;
    const isCard = !!spec.cardId;
    if (isCard) {
      const def = getCard(spec.cardId!);
      if (!def) return null;
      assertAudiovisualCardKind(def);
      if (def.kind === "audio" && !isAudiovisualCard(def)) throw new Error(trText("For audio media effect cards, use apply_card"));
      const dur = spec.duration ?? DEFAULT_CARD_DUR;
      clip = { id: newId("c"), cardId: spec.cardId!, ...(isAudiovisualCard(def) ? { embeddedAudio: true } : {}), start, end: start + dur, params: { ...def.defaults } };
    } else {
      const media = p.media.find((m) => m.id === spec.mediaId);
      if (!media) return null;
      const dur = spec.duration ?? media.duration ?? DEFAULT_MEDIA_DUR;
      clip = { id: newId("v"), cardId: "", mediaId: media.id, mediaOffset: 0, start, end: start + dur, params: {}, label: media.name, ...(media.soundEffect ? { soundEffect: { ...media.soundEffect, requestId: newId("sound-request") } } : {}) };
    }
    const track: Track = { id: newId("t"), name: trText("Track {0}", p.tracks.length + 1), clips: [clip] };
    const tracks = [...p.tracks];
    const at = spec.index == null ? tracks.length : Math.max(0, Math.min(tracks.length, spec.index));
    tracks.splice(at, 0, track);
    setProject({ ...p, tracks, duration: isCard ? p.duration : Math.max(p.duration, clip.end) });
    set({ selection: [clip.id] });
    return clip;
  },
  /** Move / resize clip (can span across tracks). */
  moveClip(clipId: string, patch: { start?: number; end?: number; trackId?: string }) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return;
    /*
     * Clips with transitions attached: relative positions are part of the transition and must not
     * move independently. The only permitted action is "translate the whole group together": that
     * preserves relative positions, keeping transitions valid. Changing duration or switching tracks
     * breaks transitions and is rejected immediately (delete transitions first to modify).
     */
    if (timingLock(p, clipId)) {
      const wantStart = patch.start ?? hit.clip.start;
      // Only start is provided: means "move this clip here" with duration unchanged (trimming edges alone
      // would already be rejected below; interpreting as trim equals permanent rejection, which prevents
      // Agent from translating the whole group)
      const wantEnd = patch.end ?? (patch.start !== undefined ? wantStart + (hit.clip.end - hit.clip.start) : hit.clip.end);
      const lenChanged = Math.abs(wantEnd - wantStart - (hit.clip.end - hit.clip.start)) > 1e-3;
      const trackChanged = !!patch.trackId && patch.trackId !== hit.track.id;
      if (lenChanged || trackChanged) return;
      const dt = wantStart - hit.clip.start;
      if (Math.abs(dt) < 1e-6) return;
      const members = groupOf(p, clipId).members;
      // Ignore companions' old positions while checking the source group; they move atomically below.
      const memberSet = new Set(members);
      const companions = new Map(p.tracks.map(track => [track.id, track.clips.filter(c => c.soundEffect?.sourceClipId && memberSet.has(c.soundEffect.sourceClipId))]));
      const collisionProject = { ...p, tracks: p.tracks.map(track => ({ ...track, clips: track.clips.filter(c => !companions.get(track.id)!.includes(c)) })) };
      let next = shiftClipsBy(collisionProject, members, dt);
      if (next) {
        next = { ...next, tracks: next.tracks.map(track => ({ ...track, clips: sortClips([...track.clips, ...companions.get(track.id)!]) })) };
        for (const member of members) {
          const before = findClip(p, member)?.clip, after = findClip(next, member)?.clip;
          if (before && after) next = moveSoundCompanions(next, before, after, false);
          if (!next) return;
        }
        if (next.tracks.some(track => {
          const sorted = sortClips(track.clips);
          return sorted.some((c, i) => c.start < 0 || (i > 0 && c.start < sorted[i - 1].end - 1e-9));
        })) return;
        setProject(next);
      }
      return;
    }
    const targetId = patch.trackId ?? hit.track.id;
    const target = p.tracks.find((t) => t.id === targetId);
    if (!target || target.locked) return;
    let clip: TrackClip | null = { ...hit.clip, start: patch.start ?? hit.clip.start, end: patch.end ?? hit.clip.end };
    if (clip.end - clip.start < 0.1) clip.end = clip.start + 0.1;
    /*
     * Cut segments (kernel/cutSegments.ts): trimming head = start offset tracks along (video stays in
     * place), pulling forward cannot cross the beginning of the referenced cut; pulling backward cannot
     * exceed the remaining duration of the referenced cut at this moment. If the referenced cut later
     * becomes shorter and the segment already exceeds it, it is not automatically cut, but the out
     * point cannot be pulled out any further (Argon review decision 4 supplement 1). Translating the
     * entire segment leaves the offset untouched.
     */
    if (clip.cutId) {
      const trimming = Math.abs((clip.end - hit.clip.end) - (clip.start - hit.clip.start)) > 1e-9;
      let offset = Math.max(0, hit.clip.cutOffset ?? 0);
      if (trimming && Math.abs(clip.start - hit.clip.start) > 1e-9) {
        offset += clip.start - hit.clip.start;
        if (offset < 0) { clip.start -= offset; offset = 0; }
      }
      const maxEnd = clip.start + Math.max(0.1, cutDuration(p, clip.cutId) - offset);
      if (clip.end > maxEnd && clip.end > hit.clip.end + 1e-9) clip.end = Math.max(maxEnd, hit.clip.end);
      const { cutOffset: _old, ...rest } = clip;
      clip = offset > 0 ? { ...rest, cutOffset: offset } : rest;
    }
    const collisionTarget = { ...target, clips: target.clips.filter(c => c.soundEffect?.sourceClipId !== clipId) };
    clip = resolveOverlap(collisionTarget, clip);
    if (!clip) return; // Target position cannot fit the entire clip: reject move, do not squash
    // A trim advances the existing source clock; translation (both boundaries) keeps the source offset.
    if ((clip.soundEffect || clip.cardId === "mu-typing" || clipHasEmbeddedAudio(p, clip, getCard)) && Math.abs((clip.end - hit.clip.end) - (clip.start - hit.clip.start)) > 1e-9) {
      // Speed-changed clips advance the source clock by rate multiplier (kernel/clipTime.mjs);
      // default 1 retains original syntax
      clip = { ...clip, mediaOffset: Math.max(0, clipSpeed(hit.clip) === 1 ? (hit.clip.mediaOffset ?? 0) + clip.start - hit.clip.start : mediaOffsetAfter(hit.clip, clip.start - hit.clip.start)) };
    }
    const placed = clip;
    let next = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }));
    next = updateTrack(next, target.id, (t) => ({ ...t, clips: sortClips([...t.clips, placed]) }));
    const linked = moveSoundCompanions(next, hit.clip, placed);
    if (linked) setProject(linked);
  },
  /**
   * Modify a clip's own properties (not card parameters): fade-in/fade-out, overall opacity,
   * display name. Two overlapping media clips + respective fading = crossfade, so "transitions"
   * do not need a separate object; modifying these fields is sufficient.
   */
  updateClip(clipId: string, patch: Partial<Pick<TrackClip, "fadeIn" | "fadeOut" | "opacity" | "label">>): { ok: boolean; blocked?: ("fadeIn" | "fadeOut")[] } {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false };
    // Fades managed by transitions cannot be modified directly: that is the transition duration, and
    // modifying it causes mismatches between both ends. To modify, delete the transition first and re-add
    const blocked: ("fadeIn" | "fadeOut")[] = [];
    const clean: typeof patch = { ...patch };
    for (const side of ["fadeIn", "fadeOut"] as const) {
      if (clean[side] !== undefined && fadeOwner(p, clipId, side)) {
        blocked.push(side);
        delete clean[side];
      }
    }
    if (Object.keys(clean).length === 0) return { ok: blocked.length === 0, ...(blocked.length ? { blocked } : {}) };
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === clipId ? { ...c, ...clean } : c)),
    })));
    return { ok: true, ...(blocked.length ? { blocked } : {}) };
  },
  /**
   * Modifies the playback speed of a media clip (`TrackClip.speed`, kernel/clipTime.mjs). One call =
   * one-step undo (along with clips moved together).
   *
   * - Speed 0.25-4x; values out of range are **rejected with an explanation** (not clamped to
   *   boundaries: silently altering manually entered values leaves users unaware of the actual
   *   multiplier); rounded to hundredths (0.01x).
   * - Preserves the in point (start point and `mediaOffset` remain untouched); the used media portion
   *   stays unchanged, and the end point is recalculated from the new speed: 4s media, 2x speed → 2s.
   * - **When lengthening overlaps the next clip, push subsequent clips backward** (user decision,
   *   2026-10-23: "If lengthening causes overlap, push subsequent clips backward, but leave trailing
   *   space when shortening."):
   *   All clips following it on the same track shift backward as a whole by "new end point - next clip
   *   start point" (relative positions unchanged, existing gaps consumed first); when pushed clips have
   *   transitions attached, push the entire group together, and companion audio clips follow along;
   *   if they cannot be pushed, reject entirely with an explanation, **do not truncate**. When
   *   shortening, leave trailing space, and subsequent clips do not move.
   * - **Clips with transitions can change speed** (user decision, 2026-10-23: "can change"):
   *   - Fade-in, fade-out, and crossfade fades are written on both ends of the clip (fadeIn / fadeOut
   *     relative to the clip), following both ends of the clip with durations unchanged;
   *   - When this clip is the **first clip** of a crossfade: the second clip (on another track)
   *     translates by the same amount following the end point, keeping crossfade overlap duration
   *     unchanged: moves backward when lengthening, forward when shortening; clips behind the second
   *     clip on its track yield according to the push rules above; moving forward and colliding with
   *     preceding clips on that track is rejected;
   *   - When this clip is the **second clip** of a crossfade: start point does not move, the first
   *     clip does not move, and overlap remains unchanged;
   *   - When the new duration cannot fit transitions on it, transitions shrink to slightly shorter
   *     than the new duration (user decision, 2026-10-23: "bubble notice is sufficient"); the result
   *     includes which transitions shrank, from what second to what second, and the UI pops up a
   *     bubble notice to explain clearly; when it is the second clip of a crossfade, crossfade
   *     shortening is achieved by moving this clip backward as a whole by that amount (in point
   *     content remains unchanged).
   * - Changing back to 1 deletes the `speed` field, leaving no `speed: 1` (so the identity key returns
   *   to its exact original form). Only for video and audio clips; reject if the track is locked.
   * [ruling] The first version of speed-changed video clips does not output original audio, stated
   * clearly in the UI; audio clips (including those from audio-visual separation) shift tempo and
   * pitch with the rate multiplier.
   */
  setClipSpeed(clipId: string, speed: number): { ok: true; pushed?: { clips: number; by: number }; moved?: string[]; transitions?: { kind: Transition["kind"]; from: number; to: number }[] } | { ok: false; error: string } {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false, error: trText("Clip not found") };
    // Speed is a media property: video clips wrapped with a media effect card (clip also carries cardId)
    // also recognize it; frame fetching uses the media node's rate (withMediaRates in kernel/clipTime.mjs)
    const media = hit.clip.mediaId && !hit.clip.cutId ? p.media.find((m) => m.id === hit.clip.mediaId) : undefined;
    if (!media || (media.kind !== "video" && media.kind !== "audio")) return { ok: false, error: trText("Only video clips and audio clips can change speed") };
    if (hit.track.locked) return { ok: false, error: trText("Unlock the track first") };
    if (!speedInRange(speed)) return { ok: false, error: trText("Speed must be between {0} and {1}x", CLIP_SPEED_MIN, CLIP_SPEED_MAX) };
    const next = normalizeSpeed(speed);
    if (next === null) return { ok: false, error: trText("Speed must be a positive number") };
    if (next === clipSpeed(hit.clip)) return { ok: true };
    const start = hit.clip.start;
    const end = start + mediaSpanOf(hit.clip) / next;
    let fadePatches = new Map<string, Partial<TrackClip>>();
    const len = end - start;
    if (len < 0.1) return { ok: false, error: trText("This clip is too short; at this speed it would be under 0.1 seconds") };
    const own = transitionsOfClip(p, clipId);
    /*
     * Transitions shrink when they cannot fit (user decision, 2026-10-23: clips with transitions "can
     * change", when cannot fit "bubble notice is sufficient"): transitions on this clip that are longer
     * than (or equal to) the new duration shrink to "slightly shorter than the new duration" (same rule
     * as "transitions must be shorter than clips" when adding transitions, rounded to hundredths of a
     * second, not shorter than MIN_TRANSITION_DUR); the result includes how much each shrank
     * (`transitions`), and the UI pops up a bubble notice to state clearly. Only reject if even the
     * shortest transition cannot fit.
     */
    const shrunk = new Map<string, { kind: Transition["kind"]; from: number; to: number }>();
    for (const tr of own) {
      if (tr.dur < len - 1e-9) continue;
      const to = Math.max(MIN_TRANSITION_DUR, Math.floor((len - 0.01) * 100) / 100);
      if (!(to < len)) return { ok: false, error: trText("After changing to {0} this clip is only {1} seconds, which can't even fit the shortest transition ({2} seconds); delete the transition first", speedLabel(next), len.toFixed(2), MIN_TRANSITION_DUR) };
      shrunk.set(tr.id, { kind: tr.kind, from: tr.dur, to });
    }
    const durOf = (tr: Transition) => shrunk.get(tr.id)?.to ?? tr.dur;
    /**
     * This clip is the second clip of a crossfade and crossfade is shortened: this entire clip moves
     * backward by the shortened amount so overlap shortens accordingly (in point content remains
     * unchanged)
     */
    const asB = own.find((tr) => tr.kind === "crossfade" && tr.bId === clipId);
    const lateBy = asB && shrunk.has(asB.id) ? asB.dur - durOf(asB) : 0;
    const delta = end - hit.clip.end;
    let placed: TrackClip = { ...withSpeed(hit.clip, next), start: start + lateBy, end: end + lateBy };

    /**
     * Clips to translate → translation offset. The second clip of a crossfade follows the end point
     * (and shifts further by the shortened amount when crossfade is shortened)
     */
    const moves = new Map<string, number>();
    const asA = own.find((tr) => tr.kind === "crossfade" && tr.aId === clipId && tr.bId);
    const partner = asA?.bId;
    if (partner) moves.set(partner, delta + lateBy + (asA!.dur - durOf(asA!)));
    /**
     * Clips behind "this clip (new end end2, original end end1)" on a track: pushed away as a whole
     * when encountering overlap
     */
    const pushAfter = (trackId: string, selfId: string, end1: number, end2: number) => {
      const track = p.tracks.find((t) => t.id === trackId)!;
      const followers = track.clips.filter((c) => c.id !== selfId && c.id !== clipId && !moves.has(c.id) && c.soundEffect?.sourceClipId !== selfId && c.start >= end1 - 1e-9);
      const blocker = followers.reduce((min, c) => Math.min(min, c.start), Infinity);
      if (!(end2 > blocker + 1e-9)) return 0;
      const dt = end2 - blocker;
      for (const c of followers) for (const m of groupOf(p, c.id).members) if (!moves.has(m)) moves.set(m, dt);
      return dt;
    };
    let pushedBy = pushAfter(hit.track.id, clipId, hit.clip.end, end + lateBy);
    if (partner) {
      const b = findClip(p, partner)!;
      pushedBy = Math.max(pushedBy, pushAfter(b.track.id, partner, b.clip.end, b.clip.end + moves.get(partner)!));
    }
    if (moves.has(clipId)) return { ok: false, error: trText("The following clips share the same transition group as this clip and can't be pushed apart; delete the transition first") };
    const lockedTrack = p.tracks.find((t) => t.locked && t.clips.some((c) => moves.has(c.id)));
    if (lockedTrack) return { ok: false, error: trText("The clip to move is on the locked track \"{0}\"; unlock that track first", lockedTrack.name) };

    // Shrunk transitions: fades on both ends of the clip change accordingly (both ends change for
    // crossfade), and the transition record is replaced with a new object
    if (shrunk.size) {
      const fades = new Map<string, Partial<TrackClip>>();
      const set = (id: string, patch: Partial<TrackClip>) => fades.set(id, { ...fades.get(id), ...patch });
      for (const tr of own) {
        if (!shrunk.has(tr.id)) continue;
        const d = durOf(tr);
        if (tr.kind === "fadeIn") set(tr.aId, { fadeIn: d });
        else if (tr.kind === "fadeOut") set(tr.aId, { fadeOut: d });
        else { set(tr.aId, { fadeOut: d }); if (tr.bId) set(tr.bId, { fadeIn: d }); }
      }
      placed = { ...placed, ...fades.get(clipId) };
      fadePatches = fades;
    }
    // Translation: companion audio clips of moved clips are extracted first; after moving, translate
    // them back according to their respective source clips (same approach as translating the entire
    // group in moveClip)
    let base: import("../../kernel/project").Project = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? placed : c)) }));
    if (fadePatches.size) {
      base = { ...base, tracks: base.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id !== clipId && fadePatches.has(c.id) ? { ...c, ...fadePatches.get(c.id) } : c)) })),
        transitions: transitionsOf(base).map((tr) => (shrunk.has(tr.id) ? { ...tr, dur: durOf(tr) } : tr)) };
    }
    if (moves.size) {
      const companions = new Map(base.tracks.map((t) => [t.id, t.clips.filter((c) => c.soundEffect?.sourceClipId && moves.has(c.soundEffect.sourceClipId))]));
      const lockedCompanion = base.tracks.find((t) => t.locked && companions.get(t.id)!.length);
      if (lockedCompanion) return { ok: false, error: trText("The sound of the clip to move is on the locked track \"{0}\"; unlock that track first", lockedCompanion.name) };
      let moved: import("../../kernel/project").Project | null = { ...base, tracks: base.tracks.map((t) => ({ ...t, clips: sortClips([
        ...t.clips.filter((c) => !companions.get(t.id)!.includes(c)).map((c) => (moves.has(c.id) ? { ...c, start: c.start + moves.get(c.id)!, end: c.end + moves.get(c.id)! } : c)),
        ...companions.get(t.id)!,
      ]) })) };
      for (const id of moves.keys()) {
        const before = findClip(base, id)?.clip, after = moved ? findClip(moved, id)?.clip : undefined;
        if (before && after && moved) moved = moveSoundCompanions(moved, before, after, false);
        if (!moved) return { ok: false, error: trText("The companion audio clip of the clip to move can't be moved; speed was not changed") };
      }
      base = moved!;
    }
    base = updateTrack(base, hit.track.id, (t) => ({ ...t, clips: sortClips(t.clips) }));
    // Own companion audio clip: when crossfade shortening shifts this clip backward, translate as a
    // whole first, then trim into the clip according to the new duration
    const linked = moveSoundCompanions(base, hit.clip, placed, false);
    if (!linked) return { ok: false, error: trText("The companion audio clip of this clip doesn't fit; speed was not changed") };
    // Verify entirely after moving: reject completely (do not truncate) if any track has overlap or
    // runs before 0
    const clash = linked.tracks.find((t) => { const s2 = sortClips(t.clips); return s2.some((c, i) => c.start < -1e-9 || (i > 0 && c.start < s2[i - 1].end - 1e-9)); });
    if (clash) return { ok: false, error: trText("After the move, clips on track \"{0}\" would overlap; speed unchanged", clash.name) };
    setProject(linked);
    return { ok: true, ...(pushedBy > 0 ? { pushed: { clips: [...moves.keys()].filter((id) => id !== partner).length, by: pushedBy } } : {}),
      ...(partner || lateBy > 0 ? { moved: [...(partner ? [partner] : []), ...(lateBy > 0 ? [clipId] : [])] } : {}),
      ...(shrunk.size ? { transitions: [...shrunk.values()] } : {}) };
  },
  removeClip(clipId: string) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return;
    // When a clip is gone, transitions referencing it lose meaning: remove them together, and wipe
    // clean the fade on the other end to avoid leaving video that "fades out for no reason"
    const doomed = transitionsOfClip(p, clipId);
    let next = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }));
    for (const tr of doomed) next = clearTransitionFades(next, tr);
    if (doomed.length) next = { ...next, transitions: transitionsOf(next).filter((tr) => !doomed.includes(tr)) };
    setProject(pruneCardNodes(next));
    set({ selection: state.selection.filter((id) => id !== clipId) });
  },
  duplicateClip(clipId: string): TrackClip | null {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return null;
    const len = hit.clip.end - hit.clip.start;
    let clip: TrackClip = { ...hit.clip, id: newId("c"), start: hit.clip.end, end: hit.clip.end + len, ...(hit.clip.parts ? { parts: JSON.parse(JSON.stringify(hit.clip.parts)) } : {}) };
    clip = placeOrShift(hit.track, clip);
    if (clip.soundEffect) clip = { ...clip, soundEffect: { ...clip.soundEffect, requestId: newId("sound-request"), sourceClipId: undefined } };
    const cloned = cloneCardClipInstance(p, hit.clip.id, clip.id, hit.clip.nodeId);
    if (cloned.nodeId !== hit.clip.nodeId) clip = { ...clip, nodeId: cloned.nodeId };
    setProject(updateTrack(cloned.project, hit.track.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) })));
    set({ selection: [clip.id] });
    return clip;
  },
  /** Split clip in two at t */
  splitClip(clipId: string, t: number): TrackClip | null {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit || t <= hit.clip.start + 0.05 || t >= hit.clip.end - 0.05) return null;
    // Splitting creates an extra clip out of nowhere, causing transition ends to mismatch:
    // delete transitions first
    if (timingLock(p, clipId)) return null;
    if (hit.track.locked || p.tracks.some(track => track.locked && track.clips.some(c => c.soundEffect?.sourceClipId === clipId))) return null;
    const left: TrackClip = { ...hit.clip, end: t };
    // Media start point of the second half advances by clip speed (kernel/clipTime.mjs; default 1 is
    // bitwise identical to original off + (t − start)), carrying speed as is
    let right: TrackClip = { ...hit.clip, id: newId("c"), start: t, mediaOffset: mediaOffsetAfter(hit.clip, t - hit.clip.start), ...(hit.clip.parts ? { parts: JSON.parse(JSON.stringify(hit.clip.parts)) } : {}) };
    // Cut segments: second half starts from the referenced cut's "first-half offset + first-half
    // duration" (does not use mediaOffset)
    if (hit.clip.cutId) {
      const { mediaOffset: _m, ...rest } = right;
      right = { ...rest, cutOffset: Math.max(0, hit.clip.cutOffset ?? 0) + (t - hit.clip.start) };
    }
    if (right.soundEffect) right = { ...right, soundEffect: { ...right.soundEffect, requestId: newId("sound-request") } };
    const cloned = cloneCardClipInstance(p, hit.clip.id, right.id, hit.clip.nodeId, t - hit.clip.start);
    if (cloned.nodeId !== hit.clip.nodeId) right = { ...right, nodeId: cloned.nodeId };
    let next = updateTrack(cloned.project, hit.track.id, (t2) => ({ ...t2, clips: sortClips([...t2.clips.filter((c) => c.id !== clipId), left, right]) }));
    next = { ...next, tracks: next.tracks.map(track => ({ ...track, clips: sortClips(track.clips.flatMap(c => {
      if (c.soundEffect?.sourceClipId !== clipId) return [c];
      if (c.end <= t) return [c];
      const rightLink = { ...c.soundEffect, requestId: newId("sound-request"), sourceClipId: right.id };
      if (c.start >= t) return [{ ...c, soundEffect: rightLink }];
      return [{ ...c, end: t }, { ...c, id: newId("v"), start: t, mediaOffset: (c.mediaOffset ?? 0) + t - c.start, soundEffect: rightLink }];
    })) })) };
    setProject(next);
    return right;
  },

  setClipParams(clipId: string, params: Record<string, unknown>, opts: { merge?: boolean } = { merge: true }) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return;
    const merged = opts.merge === false ? params : { ...hit.clip.params, ...params };
    setProject(updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, params: merged } : c)) })));
  },
  setClipCard(clipId: string, cardId: string, opts: { keepParams?: boolean } = {}) {
    const p = state.project;
    const hit = findClip(p, clipId);
    const def = getCard(cardId);
    if (!hit || !def) return;
    assertAudiovisualCardKind(def);
    // Also write fully: populate new card defaults first, then overwrite with matching parameters
    // from the old card
    const kept: Record<string, unknown> = {};
    if (opts.keepParams) {
      for (const k of Object.keys(def.defaults)) if (k in hit.clip.params) kept[k] = hit.clip.params[k];
    }
    const params: Record<string, unknown> = { ...def.defaults, ...kept };
    // Part tree is discarded when switching to another card: parts only belongs to composite cards;
    // keeping it makes the stage keep rendering old parts and the panel still treat it as a composite card
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        const { parts: _parts, cardAudio: _cardAudio, embeddedAudio: _embeddedAudio, nodeId: _nodeId, ...rest } = c;
        return { ...rest, cardId, params, ...(isAudiovisualCard(def) ? { embeddedAudio: true } : {}), ...(cardId === "composite" && c.parts ? { parts: c.parts } : {}) };
      }),
    })));
  },
};
