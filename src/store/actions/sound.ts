import { findClip, newId, type MediaAsset, type SoundEffectClipLink, type TrackClip, type Track } from "../../kernel/project";
import { assertSoundRecipeSize } from "../../audio/soundGeneration";
import { diffProject } from "../../kernel/diffProject";
import { state, setProject, set, sortClips } from "../core";

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
  /** 导出前补齐声音时用:不改用户当前的选区,也不进撤销栈(只是把同一份声音的素材记录补回来) */
  silent?: boolean;
}

export const sound = {
  /** Upload has finished. Asset registration and clip replacement are one immutable commit. */
  commitSoundEffect(spec: CommitSoundEffectOptions): { mediaId: string; clipId?: string; reused: boolean } {
    assertSoundRecipeSize(spec.link.recipe);
    const p = state.project;
    if (p.id !== spec.projectId || p.activeCutId !== spec.cutId) throw new Error("项目或剪辑已切换,未应用音效");
    if (spec.link.sourceClipId && spec.expectedSource !== JSON.stringify(findClip(p, spec.link.sourceClipId)?.clip)) throw new Error("原打字片段已改变,请重新生成");
    const target = spec.replaceClipId ? findClip(p, spec.replaceClipId) : null;
    if (spec.replaceClipId && (!target || JSON.stringify(target.clip) !== spec.expectedClip)) throw new Error("音效片段已改变,请重新生成");
    if (target?.track.locked) throw new Error("请先解锁音效序列");
    if (target && (!target.clip.soundEffect || target.clip.nodeId)) throw new Error("只能重生成已有的 WAV 音效片段");
    // Retrying a completed request, including after reopening, does not create another clip.
    const prior = p.tracks.flatMap(t => t.clips).find(c => c.soundEffect?.requestId === spec.link.requestId);
    if (prior && prior.id !== spec.replaceClipId) {
      if (prior.soundEffect?.reuseKey !== spec.link.reuseKey) throw new Error("requestId 已用于不同音效");
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
      if (end <= old.start) throw new Error("新配方在此素材偏移后没有声音,请先调整片段范围");
      if (target.track.clips.some(c => c.id !== old.id && c.start < end && c.end > old.start)) throw new Error("重生成后的尾音与同序列片段重叠,请先腾出空间");
      clip = { ...old, end, mediaId: media.id, soundEffect: spec.link, label: media.name };
      tracks = p.tracks.map(t => t.id === target.track.id ? { ...t, clips: t.clips.map(c => c.id === clip!.id ? clip! : c) } : t);
    } else if (spec.start !== undefined) {
      const start = spec.start;
      const duration = spec.duration ?? media.duration ?? 0;
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) throw new Error("音效时间范围无效");
      // An audio tail never silently changes the project out point.
      const end = Math.min(start + duration, p.duration);
      if (end <= start) throw new Error("音效起点在项目出点之外,请调整起点");
      const fits = (t: Track) => !t.locked && !t.clips.some(c => c.start < end && c.end > start);
      let track = spec.trackId ? p.tracks.find(t => t.id === spec.trackId) : p.tracks.find(fits);
      if (spec.trackId && (!track || !fits(track))) throw new Error("指定序列不存在、已锁定或音效范围与已有片段重叠");
      clip = { id: newId("v"), cardId: "", mediaId: media.id, params: {}, label: media.name, start, end, mediaOffset: spec.mediaOffset ?? 0, soundEffect: spec.link };
      if (!track) {
        track = { id: newId("t"), name: "音效", clips: [clip] };
        tracks = [...p.tracks, track];
      } else tracks = p.tracks.map(t => t.id === track!.id ? { ...t, clips: sortClips([...t.clips, clip!]) } : t);
    }
    if (!existing || clip) {
      const next = { ...p, media: existing ? p.media : [...p.media, media], tracks };
      const patch = diffProject(p, next).ops;
      if (patch.some(op => op.path === "") || new TextEncoder().encode(JSON.stringify(patch)).byteLength > 224 * 1024) {
        throw new Error("音效变更超过共享项目安全提交上限,请拆成多段生成");
      }
      setProject(next, { undoable: !!clip && !spec.silent });
    }
    if (clip && !spec.silent) set({ selection: [clip.id] });
    return { mediaId: media.id, ...(clip ? { clipId: clip.id } : {}), reused: !!existing };
  },
};
