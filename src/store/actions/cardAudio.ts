import type { MediaAsset, Project } from "../../kernel/project";
import { findClip, newId } from "../../kernel/project";
import type { CardAudioRendition } from "../../kernel/cardAudioRendition.mjs";
import { activeCutIdOf, findClipInCut } from "../../kernel/cutSegments";
import { diffProject } from "../../kernel/diffProject";
import { state, setProject } from "../core";
import { tr } from "../../i18n/index.ts";

/**
 * Committed only after the asset is stored; associates WAV and original visual clip in the same
 * project replacement, with one-step undo. `clipCutId`: which cut the clip belongs to (defaults
 * to the active one). Audio cards in cuts referenced by cut segments are generated in their own
 * cut prior to export (`src/editor/io/exportSounds.ts`), and results are written back to that
 * parked cut entry.
 */
export function commitCardAudio(args: { projectId?: string; cutId?: string; clipCutId?: string; loadToken: number; clipId: string; expectedClip: string;
  media: Omit<MediaAsset, 'id'>; rendition: Omit<CardAudioRendition, 'mediaId'> }) {
  const p = state.project;
  const parked = !!args.clipCutId && args.clipCutId !== activeCutIdOf(p);
  const hit = parked ? findClipInCut(p, args.clipCutId, args.clipId) : findClip(p, args.clipId);
  if (state.projectLoadToken !== args.loadToken || p.id !== args.projectId || p.activeCutId !== args.cutId ||
      !hit || hit.track.locked || JSON.stringify(hit.clip) !== args.expectedClip) throw new Error(tr("The clip or project has changed, the old sound generation result will not overwrite the current content"));
  const mediaId = newId("card-sound");
  const withSound = (tracks: Project["tracks"]) => tracks.map(track => track.id !== hit.track.id ? track : { ...track,
    clips: track.clips.map(clip => clip.id !== args.clipId ? clip : { ...clip, cardAudio: { ...args.rendition, mediaId } }) });
  const next: Project = parked
    ? { ...p, media: [...p.media, { ...args.media, id: mediaId }],
      cuts: (p.cuts ?? []).map(c => c.id === args.clipCutId && c.tracks ? { ...c, tracks: withSound(c.tracks) } : c) }
    : { ...p, media: [...p.media, { ...args.media, id: mediaId }], tracks: withSound(p.tracks) };
  const patch = diffProject(p, next).ops;
  if (patch.some(op => op.path === "") || new TextEncoder().encode(JSON.stringify(patch)).byteLength > 224 * 1024)
    throw new Error(tr("The card's sound record exceeds the safe commit limit of a shared project; shorten the card or simplify its parameters"));
  setProject(next);
  return { clipId: args.clipId, mediaId };
}
