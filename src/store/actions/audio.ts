import { findClip, findSoundAsset, newId, soundAssetFrom, type MediaAsset, type Track, type TrackClip } from "../../kernel/project";
import { stripAudioFxFromCuts, withoutAudioFx } from "../../kernel/cuts";
import type { AudioFxDef, ClipAudioFx } from "../../kernel/audioFx.mjs";
import { getCard } from "../../kernel/registry";
import { isSpeedChanged } from "../../kernel/clipTime.mjs";
import { clipHasAudio, clipHasEmbeddedAudio } from "../../kernel/cardAudioRendition.mjs";

import { state, setProject, updateTrack } from "../core";
import { tr } from "../../i18n/index.ts";

export const audio = {

  /** Only modify audio, not video opacity; validate first before writing in one pass when multiple clips are selected. */
  setClipsMuted(clipIds: string[], muted: boolean) {
    const p = state.project;
    if (!Array.isArray(clipIds) || !clipIds.length || clipIds.length > 100 || clipIds.some(id => typeof id !== "string")) return { ok: false, code: "INVALID_CLIP_IDS", error: tr("Select 1 to 100 clips") };
    if (typeof muted !== "boolean") return { ok: false, code: "INVALID_MUTE", error: tr("muted must be a boolean") };
    const ids = new Set(clipIds);
    for (const id of ids) {
      const hit = findClip(p, id);
      if (!hit) return { ok: false, code: "CLIP_NOT_FOUND", clipId: id, error: tr("Clip not found") };
      if (hit.track.locked) return { ok: false, code: "TRACK_LOCKED", clipId: id, error: tr("Unlock the track first") };
      if (!clipHasAudio(p, hit.clip, getCard)) return { ok: false, code: "NO_CLIP_AUDIO", clipId: id, error: tr("This clip has no audio") };
    }
    if ([...ids].some(id => !!findClip(p, id)!.clip.audioMuted !== muted)) setProject({ ...p, tracks: p.tracks.map(track => ({
      ...track, clips: track.clips.map(clip => ids.has(clip.id) ? { ...clip, audioMuted: muted } : clip),
    })) });
    return { ok: true, clipIds: [...ids], muted };
  },

  setClipMuted(clipId: string, muted: boolean) {
    return audio.setClipsMuted([clipId], muted);
  },

  /* ---------- Asset ---------- */

  /**
   * "Create as audio": derives an audio-only asset from a video clip (adds an entry to the media
   * library, placed into the soundtrack tab). Only one copy is derived for the same video; subsequent
   * calls return the same entry. Images have no audio; audio assets are returned as is.
   */
  setClipVolume(clipId: string, volume: number) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false, error: tr("Clip not found") };
    if (hit.track.locked) return { ok: false, error: tr("Unlock the track first") };
    if (!clipHasAudio(p, hit.clip, getCard)) return { ok: false, error: tr("Volume can only be adjusted for media or cards that have sound") };
    if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 1) return { ok: false, error: tr("Volume must be a number between 0 and 1") };
    if (volume !== (hit.clip.audioVolume ?? 1)) {
      setProject(updateTrack(p, hit.track.id, (track) => ({
        ...track, clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, audioVolume: volume } : clip),
      })));
    }
    return { ok: true, clipId, volume, muted: !!(hit.clip.audioMuted || hit.track.muted), hidden: !!hit.track.hidden };
  },

  separateAudio(clipId: string) {
    const result = audio.separateAudios([clipId]);
    return result.ok ? { ok: true as const, ...result.items![0] } : result;
  },

  /** Multi-select separation: rejects any embedded audio card or invalid selection before writing to the project. */
  separateAudios(clipIds: string[]) {
    const p = state.project;
    if (!Array.isArray(clipIds) || !clipIds.length || clipIds.length > 100 || clipIds.some(id => typeof id !== "string")) return { ok: false, code: "INVALID_CLIP_IDS", error: tr("Select 1 to 100 clips") };
    const ids = new Set(clipIds);
    const hits = [];
    for (const clipId of ids) {
      const hit = findClip(p, clipId);
      if (!hit) return { ok: false, code: "CLIP_NOT_FOUND", clipId, error: tr("Clip not found") };
      if (clipHasEmbeddedAudio(p, hit.clip, getCard)) return { ok: false, code: "EMBEDDED_CARD_AUDIO_UNSEPARABLE", clipId,
        error: tr("The sound of a motion graphics card is written in the card code, so the audio track cannot be separated. You can mute the card on its own. No clips were modified.") };
      if (hit.track.locked) return { ok: false, code: "TRACK_LOCKED", clipId, error: tr("Unlock the track first") };
      const src = p.media.find(m => m.id === hit.clip.mediaId);
      if (!src || src.kind !== "video") return { ok: false, code: "NOT_VIDEO_MEDIA", clipId, error: tr("Only the audio of regular video media can be separated. No clips were modified.") };
      if (hit.clip.audioMuted) return { ok: false, code: "ALREADY_MUTED", clipId, error: tr("This video is already muted or its audio is already separated. No clips were modified.") };
      hits.push({ ...hit, src });
    }
    const media = [...p.media], generated = new Map<string, Track[]>();
    const items: { clipId: string; audioClipId: string; trackId: string; mediaId: string }[] = [];
    for (const hit of hits) {
      const asset = findSoundAsset({ ...p, media }, hit.src.id) ?? soundAssetFrom(hit.src, newId("m"));
      if (!media.includes(asset)) media.push(asset);
      const sound: TrackClip = {
        id: newId("c"), cardId: "", mediaId: asset.id, params: {}, label: asset.name,
        start: hit.clip.start, end: hit.clip.end, mediaOffset: hit.clip.mediaOffset,
        opacity: hit.clip.opacity, fadeIn: hit.clip.fadeIn, fadeOut: hit.clip.fadeOut, audioVolume: hit.clip.audioVolume,
        // Speed-changed clips can also be separated (user decision, 2026-10-23: "can be separated, log
        // distortion issue as a todo"): the separated audio clip carries the same speed, shifting tempo
        // and pitch with the rate multiplier
        ...(isSpeedChanged(hit.clip) ? { speed: hit.clip.speed } : null),
        ...(hit.clip.audioFx ? { audioFx: hit.clip.audioFx } : null),
      };
      const track: Track = { id: newId("t"), name: asset.name, muted: hit.track.muted, hidden: hit.track.hidden, clips: [sound] };
      generated.set(hit.track.id, [...(generated.get(hit.track.id) ?? []), track]);
      items.push({ clipId: hit.clip.id, audioClipId: sound.id, trackId: track.id, mediaId: asset.id });
    }
    const tracks = p.tracks.flatMap(track => [
      { ...track, clips: track.clips.map(clip => ids.has(clip.id) ? { ...clip, audioMuted: true } : clip) },
      ...(generated.get(track.id) ?? []),
    ]);
    setProject({ ...p, tracks, media });
    return { ok: true, items };
  },

  audioFromVideo(mediaId: string): { ok: true; media: MediaAsset; created: boolean } | { ok: false; error: string } {
    const p = state.project;
    const src = p.media.find((m) => m.id === mediaId);
    if (!src) return { ok: false, error: tr("Asset {0} not found", mediaId) };
    if (src.kind === "image") return { ok: false, error: tr("\"{0}\" is an image and has no sound", src.name) };
    if (src.kind === "audio") return { ok: true, media: src, created: false };
    const had = findSoundAsset(p, mediaId);
    if (had) return { ok: true, media: had, created: false };
    const media = soundAssetFrom(src, newId("m"));
    // Media library additions and deletions do not enter the undo stack, just like addMedia:
    // undo manages the timeline, not the media bin
    setProject({ ...p, media: [...p.media, media] }, { undoable: false });
    return { ok: true, media, created: true };
  },

  /**
   * Converts a video clip on the timeline to audio **in place**: video is removed, audio remains
   * as is (position, duration, in-media offset, and fade-in/fade-out are all preserved). That audio
   * asset is also added to the media library and can be dragged directly later.
   */
  convertClipToAudio(clipId: string): { ok: true; mediaId: string; created: boolean; already?: boolean } | { ok: false; error: string } {
    const hit = findClip(state.project, clipId);
    if (!hit) return { ok: false, error: tr("Clip {0} not found", clipId) };
    if (clipHasEmbeddedAudio(state.project, hit.clip, getCard)) return { ok: false, error: tr("The embedded sound of a motion graphics card cannot be separated or converted to a sound; you can mute the card on its own") };
    if (!hit.clip.mediaId) return { ok: false, error: tr("This clip is a card, not media, so there is no sound to convert") };
    // Convert speed-changed clip to audio: clip becomes an audio clip carrying speed, shifting tempo
    // and pitch with the rate multiplier (same as audio-visual separation, user decision, 2026-10-23)
    const r = audio.audioFromVideo(hit.clip.mediaId);
    if (!r.ok) return r;
    if (r.media.id === hit.clip.mediaId) return { ok: true, mediaId: r.media.id, created: false, already: true };
    const p = state.project; // audioFromVideo has already been written once; retrieve the new one here
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      // The name is also changed accordingly: leaving "Interview.mp4" on the timeline would make users
      // think video is still present
      clips: t.clips.map((c) => (c.id === clipId ? { ...c, mediaId: r.media.id, label: r.media.name } : c)),
    })));
    return { ok: true, mediaId: r.media.id, created: r.created };
  },
  /* ---------- Audio effects library (project-level, same pattern as filter library) ---------- */
  /** Store into library; if attach is given, attach to that clip in the same step (one-step undo, same as addFilter) */
  addAudioFx(def: AudioFxDef, attach?: { clipId: string; fx: ClipAudioFx }) {
    const p = state.project;
    let tracks = p.tracks;
    if (attach) {
      const hit = findClip(p, attach.clipId);
      if (hit) tracks = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === attach.clipId ? { ...c, audioFx: attach.fx } : c)) })).tracks;
    }
    setProject({ ...p, tracks, audioFx: [...(p.audioFx ?? []), def] });
  },
  updateAudioFx(fxId: string, def: AudioFxDef) {
    setProject({ ...state.project, audioFx: (state.project.audioFx ?? []).map((f) => (f.id === fxId ? def : f)) });
  },
  /** Delete effect: clips attaching it in both the active cut and parked cuts are detached together */
  removeAudioFx(fxId: string) {
    const p = state.project;
    setProject(stripAudioFxFromCuts({
      ...p,
      audioFx: (p.audioFx ?? []).filter((f) => f.id !== fxId),
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.audioFx?.id === fxId ? withoutAudioFx(c) : c)) })),
    }, fxId));
  },
  /**
   * Attach / replace / detach audio effects on a clip (null = detach). Returns false if clip is
   * not found; validation is on the caller
   */
  setClipAudioFx(clipId: string, fx: ClipAudioFx | null): boolean {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id !== clipId ? c : fx ? { ...c, audioFx: fx } : withoutAudioFx(c))),
    })));
    return true;
  },
};
