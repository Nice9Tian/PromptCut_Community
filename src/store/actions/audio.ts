import { findClip, findSoundAsset, newId, soundAssetFrom, type MediaAsset, type Track, type TrackClip } from "../../kernel/project";
import { stripAudioFxFromCuts, withoutAudioFx } from "../../kernel/cuts";
import type { AudioFxDef, ClipAudioFx } from "../../kernel/audioFx.mjs";
import { getCard } from "../../kernel/registry";
import { isSpeedChanged } from "../../kernel/clipTime.mjs";
import { clipHasAudio, clipHasEmbeddedAudio } from "../../kernel/cardAudioRendition.mjs";

import { state, setProject, updateTrack } from "../core";

export const audio = {

  /** 只改声音，不改画面不透明度；选中多段时先校验再一次写入。 */
  setClipsMuted(clipIds: string[], muted: boolean) {
    const p = state.project;
    if (!Array.isArray(clipIds) || !clipIds.length || clipIds.length > 100 || clipIds.some(id => typeof id !== "string")) return { ok: false, code: "INVALID_CLIP_IDS", error: "请选择 1 到 100 个片段" };
    if (typeof muted !== "boolean") return { ok: false, code: "INVALID_MUTE", error: "muted 必须是布尔值" };
    const ids = new Set(clipIds);
    for (const id of ids) {
      const hit = findClip(p, id);
      if (!hit) return { ok: false, code: "CLIP_NOT_FOUND", clipId: id, error: "找不到片段" };
      if (hit.track.locked) return { ok: false, code: "TRACK_LOCKED", clipId: id, error: "请先解锁序列" };
      if (!clipHasAudio(p, hit.clip, getCard)) return { ok: false, code: "NO_CLIP_AUDIO", clipId: id, error: "这个片段没有音频" };
    }
    if ([...ids].some(id => !!findClip(p, id)!.clip.audioMuted !== muted)) setProject({ ...p, tracks: p.tracks.map(track => ({
      ...track, clips: track.clips.map(clip => ids.has(clip.id) ? { ...clip, audioMuted: muted } : clip),
    })) });
    return { ok: true, clipIds: [...ids], muted };
  },

  setClipMuted(clipId: string, muted: boolean) {
    return audio.setClipsMuted([clipId], muted);
  },

  /* ---------- 素材 ---------- */

  /**
   * 「创建为声音」:给一段视频派生出只有声音的那一份素材(素材库里多一条,进配乐页)。
   * 同一段视频只派生一份,再调返回的是同一条。图片没有声音;本来就是声音的原样返回。
   */
  setClipVolume(clipId: string, volume: number) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false, error: "找不到片段" };
    if (hit.track.locked) return { ok: false, error: "请先解锁序列" };
    if (!clipHasAudio(p, hit.clip, getCard)) return { ok: false, error: "只能调整带声音的素材或卡片音量" };
    if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 1) return { ok: false, error: "音量必须是 0 到 1 之间的数字" };
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

  /** 一次多选分离：任何内嵌音频卡片或无效选择都在写项目之前拒绝。 */
  separateAudios(clipIds: string[]) {
    const p = state.project;
    if (!Array.isArray(clipIds) || !clipIds.length || clipIds.length > 100 || clipIds.some(id => typeof id !== "string")) return { ok: false, code: "INVALID_CLIP_IDS", error: "请选择 1 到 100 个片段" };
    const ids = new Set(clipIds);
    const hits = [];
    for (const clipId of ids) {
      const hit = findClip(p, clipId);
      if (!hit) return { ok: false, code: "CLIP_NOT_FOUND", clipId, error: "找不到片段" };
      if (clipHasEmbeddedAudio(p, hit.clip, getCard)) return { ok: false, code: "EMBEDDED_CARD_AUDIO_UNSEPARABLE", clipId,
        error: "动效卡片的声音写在卡片代码里，不能分离音轨。可以单独静音该卡片。未修改任何片段。" };
      if (hit.track.locked) return { ok: false, code: "TRACK_LOCKED", clipId, error: "请先解锁序列" };
      const src = p.media.find(m => m.id === hit.clip.mediaId);
      if (!src || src.kind !== "video") return { ok: false, code: "NOT_VIDEO_MEDIA", clipId, error: "只能分离普通视频素材的音频。未修改任何片段。" };
      if (hit.clip.audioMuted) return { ok: false, code: "ALREADY_MUTED", clipId, error: "此视频已静音或已分离音频。未修改任何片段。" };
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
        // 变速段也能分离(用户 2026-10-23 定「可以分离,失真问题记待办」):分出来的声音段带着同样的速度,随倍率变速变调
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
    if (!src) return { ok: false, error: `找不到素材 ${mediaId}` };
    if (src.kind === "image") return { ok: false, error: `「${src.name}」是图片,没有声音` };
    if (src.kind === "audio") return { ok: true, media: src, created: false };
    const had = findSoundAsset(p, mediaId);
    if (had) return { ok: true, media: had, created: false };
    const media = soundAssetFrom(src, newId("m"));
    // 素材库的增删和 addMedia 一样不进撤销栈:撤销管的是时间轴,不是素材柜
    setProject({ ...p, media: [...p.media, media] }, { undoable: false });
    return { ok: true, media, created: true };
  },

  /**
   * 把时间轴上的一段视频**就地**转成声音:画面没了,声音照旧(位置、长度、素材内偏移、
   * 淡入淡出全部保留)。素材库里同时会多出那份声音素材,以后能直接再拖。
   */
  convertClipToAudio(clipId: string): { ok: true; mediaId: string; created: boolean; already?: boolean } | { ok: false; error: string } {
    const hit = findClip(state.project, clipId);
    if (!hit) return { ok: false, error: `找不到片段 ${clipId}` };
    if (clipHasEmbeddedAudio(state.project, hit.clip, getCard)) return { ok: false, error: "动效卡片的内嵌声音不能分离或转换为声音；可以单独静音该卡片" };
    if (!hit.clip.mediaId) return { ok: false, error: "这段是卡片,不是素材,没有声音可转" };
    // 变速段转换为声音:片段带着速度变成声音段,随倍率变速变调(同音画分离,用户 2026-10-23 定)
    const r = audio.audioFromVideo(hit.clip.mediaId);
    if (!r.ok) return r;
    if (r.media.id === hit.clip.mediaId) return { ok: true, mediaId: r.media.id, created: false, already: true };
    const p = state.project; // audioFromVideo 已经写过一次,这里要拿新的
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      // 名字也跟着换:时间轴上还挂着「访谈.mp4」会让人以为画面还在
      clips: t.clips.map((c) => (c.id === clipId ? { ...c, mediaId: r.media.id, label: r.media.name } : c)),
    })));
    return { ok: true, mediaId: r.media.id, created: r.created };
  },
  /* ---------- 音频效果库(项目级,和滤镜库一个路数) ---------- */
  /** 入库;给了 attach 就同一步挂到那一段上(一步撤销,同 addFilter) */
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
  /** 删效果:激活剪辑和停放剪辑里挂着它的段一并摘掉 */
  removeAudioFx(fxId: string) {
    const p = state.project;
    setProject(stripAudioFxFromCuts({
      ...p,
      audioFx: (p.audioFx ?? []).filter((f) => f.id !== fxId),
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.audioFx?.id === fxId ? withoutAudioFx(c) : c)) })),
    }, fxId));
  },
  /** 挂 / 换 / 摘片段上的音频效果(null = 摘掉)。找不到片段返回 false;校验在调用方 */
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
