import { findClip, newId, type MediaAsset, type SoundEffectClipLink, type TrackClip, type Track } from "../../kernel/project";
import { assertSoundRecipeSize } from "../../audio/soundGeneration";
import { diffProject } from "../../kernel/diffProject";
import { state, setProject, set, sortClips } from "../core";
import { tr } from "../../i18n/index.ts";

/** The project moved on under the generated sound: callers tell this apart by the flag, not by the wording */
const staleError = (message: string) => Object.assign(new Error(message), { stale: true });

export interface CommitSoundEffectOptions {
  projectId?: string;
  cutId?: string;
  asset: Omit<MediaAsset, "id">;
  link: SoundEffectClipLink;
  start?: number;
  duration?: number;
  mediaOffset?: number;
  trackId?: string;
  replaceClipId?: string;
  /** Expected whole clip values make an in-flight render stale on a user edit, split or removal. */
  expectedClip?: string;
  expectedSource?: string;
  /**
   * Used when backfilling sound before export: does not change current user selection or enter
   * the undo stack (merely restores asset records for the same sound)
   */
  silent?: boolean;
}

export const sound = {
  /** Upload has finished. Asset registration and clip replacement are one immutable commit. */
  commitSoundEffect(spec: CommitSoundEffectOptions): { mediaId: string; clipId?: string; reused: boolean } {
    assertSoundRecipeSize(spec.link.recipe);
    const p = state.project;
    if (p.id !== spec.projectId || p.activeCutId !== spec.cutId) throw staleError(tr("The project or cut has changed; sound effect not applied"));
    if (spec.link.sourceClipId && spec.expectedSource !== JSON.stringify(findClip(p, spec.link.sourceClipId)?.clip)) throw staleError(tr("The original typing clip has changed, please regenerate"));
    const target = spec.replaceClipId ? findClip(p, spec.replaceClipId) : null;
    if (spec.replaceClipId && (!target || JSON.stringify(target.clip) !== spec.expectedClip)) throw staleError(tr("The sound effect clip has changed, please regenerate"));
    if (target?.track.locked) throw new Error(tr("Unlock the sound effect track first"));
    if (target && (!target.clip.soundEffect || target.clip.nodeId)) throw new Error(tr("Only existing WAV sound effect clips can be regenerated"));
    // Retrying a completed request, including after reopening, does not create another clip.
    const prior = p.tracks.flatMap(t => t.clips).find(c => c.soundEffect?.requestId === spec.link.requestId);
    if (prior && prior.id !== spec.replaceClipId) {
      if (prior.soundEffect?.reuseKey !== spec.link.reuseKey) throw new Error(tr("requestId was already used for a different sound effect"));
      return { mediaId: prior.mediaId!, clipId: prior.id, reused: true };
    }
    const existing = p.media.find(m => m.kind === "audio" && m.hash === spec.asset.hash && m.soundEffect?.reuseKey === spec.link.reuseKey);
    const media: MediaAsset = existing ?? { ...spec.asset, id: newId("m") };
    let tracks = p.tracks;
    let clip: TrackClip | undefined;
    if (target) {
      // Range, offset, gain, fades and effects survive regeneration; there is never a graph audio node.
      const old = target.clip;
      const source = spec.link.sourceClipId ? findClip(p, spec.link.sourceClipId)?.clip : undefined;
      const offset = old.mediaOffset ?? 0;
      const sourceEnd = spec.link.recipe.preset === "keyboard" && source ? source.end : Infinity;
      const oldRecipe = old.soundEffect!.recipe;
      const oldNaturalEnd = Math.min(p.duration, sourceEnd, old.start + oldRecipe.frames / oldRecipe.sampleRate - offset);
      const newNaturalEnd = Math.min(p.duration, sourceEnd, old.start + spec.link.recipe.frames / spec.link.recipe.sampleRate - offset);
      const wasUncropped = Math.abs(old.end - oldNaturalEnd) <= 1 / oldRecipe.sampleRate;
      const end = wasUncropped ? newNaturalEnd : Math.min(old.end, newNaturalEnd);
      if (end <= old.start) throw new Error(tr("The new recipe is silent after this media offset, please adjust the clip range first"));
      if (target.track.clips.some(c => c.id !== old.id && c.start < end && c.end > old.start)) throw new Error(tr("The tail of the regenerated sound overlaps clips on the same track, please make room first"));
      clip = { ...old, end, mediaId: media.id, soundEffect: spec.link, label: media.name };
      tracks = p.tracks.map(t => t.id === target.track.id ? { ...t, clips: t.clips.map(c => c.id === clip!.id ? clip! : c) } : t);
    } else if (spec.start !== undefined) {
      const start = spec.start;
      const duration = spec.duration ?? media.duration ?? 0;
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) throw new Error(tr("Invalid sound effect time range"));
      // An audio tail never silently changes the project out point.
      const end = Math.min(start + duration, p.duration);
      if (end <= start) throw new Error(tr("The sound effect start is beyond the project out point, please adjust the start"));
      const fits = (t: Track) => !t.locked && !t.clips.some(c => c.start < end && c.end > start);
      let track = spec.trackId ? p.tracks.find(t => t.id === spec.trackId) : p.tracks.find(fits);
      if (spec.trackId && (!track || !fits(track))) throw new Error(tr("The specified track does not exist, is locked, or the sound effect range overlaps existing clips"));
      clip = { id: newId("v"), cardId: "", mediaId: media.id, params: {}, label: media.name, start, end, mediaOffset: spec.mediaOffset ?? 0, soundEffect: spec.link };
      if (!track) {
        track = { id: newId("t"), name: tr("Sound effect"), clips: [clip] };
        tracks = [...p.tracks, track];
      } else tracks = p.tracks.map(t => t.id === track!.id ? { ...t, clips: sortClips([...t.clips, clip!]) } : t);
    }
    if (!existing || clip) {
      const next = { ...p, media: existing ? p.media : [...p.media, media], tracks };
      const patch = diffProject(p, next).ops;
      if (patch.some(op => op.path === "") || new TextEncoder().encode(JSON.stringify(patch)).byteLength > 224 * 1024) {
        throw new Error(tr("The sound effect change exceeds the safe commit limit for shared projects, please split it into several generations"));
      }
      setProject(next, { undoable: !!clip && !spec.silent });
    }
    if (clip && !spec.silent) set({ selection: [clip.id] });
    return { mediaId: media.id, ...(clip ? { clipId: clip.id } : {}), reused: !!existing };
  },
};
