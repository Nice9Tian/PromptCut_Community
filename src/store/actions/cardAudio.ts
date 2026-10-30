import type { MediaAsset, Project } from "../../kernel/project";
import { findClip, newId } from "../../kernel/project";
import type { CardAudioRendition } from "../../kernel/cardAudioRendition.mjs";
import { activeCutIdOf, findClipInCut } from "../../kernel/cutSegments";
import { diffProject } from "../../kernel/diffProject";
import { state, setProject } from "../core";

/**
 * 素材已入库后才提交；同一次项目替换关联 WAV 和原视觉片段，一步撤销。
 * `clipCutId`:片段住在哪条剪辑里(缺省激活的那条)。被剪辑段引用的剪辑里的有声卡,导出前在它自己那条剪辑里生成
 * (`src/editor/io/exportSounds.ts`),结果写回那条停放剪辑的条目。
 */
export function commitCardAudio(args: { projectId?: string; cutId?: string; clipCutId?: string; loadToken: number; clipId: string; expectedClip: string;
  media: Omit<MediaAsset, 'id'>; rendition: Omit<CardAudioRendition, 'mediaId'> }) {
  const p = state.project;
  const parked = !!args.clipCutId && args.clipCutId !== activeCutIdOf(p);
  const hit = parked ? findClipInCut(p, args.clipCutId, args.clipId) : findClip(p, args.clipId);
  if (state.projectLoadToken !== args.loadToken || p.id !== args.projectId || p.activeCutId !== args.cutId ||
      !hit || hit.track.locked || JSON.stringify(hit.clip) !== args.expectedClip) throw new Error("片段或项目已变化，旧的声音生成结果不会覆盖当前内容");
  const mediaId = newId("card-sound");
  const withSound = (tracks: Project["tracks"]) => tracks.map(track => track.id !== hit.track.id ? track : { ...track,
    clips: track.clips.map(clip => clip.id !== args.clipId ? clip : { ...clip, cardAudio: { ...args.rendition, mediaId } }) });
  const next: Project = parked
    ? { ...p, media: [...p.media, { ...args.media, id: mediaId }],
      cuts: (p.cuts ?? []).map(c => c.id === args.clipCutId && c.tracks ? { ...c, tracks: withSound(c.tracks) } : c) }
    : { ...p, media: [...p.media, { ...args.media, id: mediaId }], tracks: withSound(p.tracks) };
  const patch = diffProject(p, next).ops;
  if (patch.some(op => op.path === "") || new TextEncoder().encode(JSON.stringify(patch)).byteLength > 224 * 1024)
    throw new Error("卡片声音记录超过共享项目安全提交上限，请缩短卡片或精简参数");
  setProject(next);
  return { clipId: args.clipId, mediaId };
}
