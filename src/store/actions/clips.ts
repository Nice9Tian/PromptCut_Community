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
  /** 往序列里加一张卡。不给 trackId 就挑一条这段时间空着的序列。返回 clip。 */
  addCardClip(cardId: string, start: number, opts: { trackId?: string; duration?: number; params?: Record<string, unknown>; parts?: PartInstance[] } = {}): TrackClip | null {
    const def = getCard(cardId);
    if (!def) return null;
    assertAudiovisualCardKind(def);
    // 音频素材效果卡拖进时间轴是个既无声又无画的空片段(没有 nodeId,消费方只看节点):
    // 它只能经 apply_card 挂到片段上。
    if (def.kind === "audio" && !isAudiovisualCard(def)) throw new Error("音频素材效果卡请用 apply_card");
    const p = state.project;
    const track = opts.trackId ? p.tracks.find((t) => t.id === opts.trackId) : p.tracks[0];
    if (!track) return null;
    const dur = opts.duration ?? DEFAULT_CARD_DUR;
    const target = opts.trackId ? track : pickTrack(p, start, dur);
    if (!target) return null;
    // 参数在写入时就展开成完整的一份,不留「空 = 用默认值」这种隐式状态。
    // 调用方(界面、AI)照旧只传要改的项,但存进 clip 的是全量:
    // 存的和渲染的一致,代码页能直接看,导出的项目也不会因为以后调了卡片默认值而变样。
    let clip: TrackClip = { id: newId("c"), cardId, ...(isAudiovisualCard(def) ? { embeddedAudio: true } : {}), start, end: start + dur, params: { ...def.defaults, ...(opts.params ?? {}) }, ...(opts.parts?.length ? { parts: opts.parts } : {}) };
    clip = placeOrShift(target, clip);
    setProject(updateTrack(p, target.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) })));
    set({ selection: [clip.id] });
    return clip;
  },
  /** 往序列里加一段素材。不给 trackId 就挑一条这段时间空着的序列。 */
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
   * 新建一条序列,并把片段直接落上去。一次手势 = 一步撤销(时间轴上「拖到序列之间」和「拖到新建落区」用)。
   * 新序列是空的,所以片段一定落在 start 上,不会被顺延。
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
      if (def.kind === "audio" && !isAudiovisualCard(def)) throw new Error("音频素材效果卡请用 apply_card");
      const dur = spec.duration ?? DEFAULT_CARD_DUR;
      clip = { id: newId("c"), cardId: spec.cardId!, ...(isAudiovisualCard(def) ? { embeddedAudio: true } : {}), start, end: start + dur, params: { ...def.defaults } };
    } else {
      const media = p.media.find((m) => m.id === spec.mediaId);
      if (!media) return null;
      const dur = spec.duration ?? media.duration ?? DEFAULT_MEDIA_DUR;
      clip = { id: newId("v"), cardId: "", mediaId: media.id, mediaOffset: 0, start, end: start + dur, params: {}, label: media.name, ...(media.soundEffect ? { soundEffect: { ...media.soundEffect, requestId: newId("sound-request") } } : {}) };
    }
    const track: Track = { id: newId("t"), name: `序列 ${p.tracks.length + 1}`, clips: [clip] };
    const tracks = [...p.tracks];
    const at = spec.index == null ? tracks.length : Math.max(0, Math.min(tracks.length, spec.index));
    tracks.splice(at, 0, track);
    setProject({ ...p, tracks, duration: isCard ? p.duration : Math.max(p.duration, clip.end) });
    set({ selection: [clip.id] });
    return clip;
  },
  /** 移动 / 缩放 clip(可跨序列)。 */
  moveClip(clipId: string, patch: { start?: number; end?: number; trackId?: string }) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return;
    /*
     * 挂着转场的片段:相对关系是转场的一部分,不许单独动。
     * 允许的只有「整组一起平移」—— 那不改相对关系,转场照旧成立。
     * 改长度、换序列都会把转场弄坏,直接拒绝(要改先删转场)。
     */
    if (timingLock(p, clipId)) {
      const wantStart = patch.start ?? hit.clip.start;
      // 只给 start:意思是「把这段挪到这儿」,时长不变(单独修边本来就会被下面拒掉,
      // 按修边理解等于永远拒绝,那 Agent 就没法平移整组了)
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
     * 剪辑段(kernel/cutSegments.ts):修头 = 起点偏移跟着走(画面留在原处),往前拉不能越过被引用剪辑的开头;
     * 往后拉出点不能超出被引用剪辑此刻剩下的长度。被引用剪辑事后变短、段已经超出的,不自动裁,
     * 只是出点不能再往外拉(Argon 审核意见决定 4 补充 1)。整段平移不动偏移。
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
    if (!clip) return; // 目标位置放不下整段:拒绝移动,不压扁
    // A trim advances the existing source clock; translation (both boundaries) keeps the source offset.
    if ((clip.soundEffect || clip.cardId === "mu-typing" || clipHasEmbeddedAudio(p, clip, getCard)) && Math.abs((clip.end - hit.clip.end) - (clip.start - hit.clip.start)) > 1e-9) {
      // 变速段按倍率推进源时钟(kernel/clipTime.mjs);缺省 1 保留原来的写法
      clip = { ...clip, mediaOffset: Math.max(0, clipSpeed(hit.clip) === 1 ? (hit.clip.mediaOffset ?? 0) + clip.start - hit.clip.start : mediaOffsetAfter(hit.clip, clip.start - hit.clip.start)) };
    }
    const placed = clip;
    let next = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }));
    next = updateTrack(next, target.id, (t) => ({ ...t, clips: sortClips([...t.clips, placed]) }));
    const linked = moveSoundCompanions(next, hit.clip, placed);
    if (linked) setProject(linked);
  },
  /**
   * 改片段自身的属性(不是卡片参数):淡入淡出、整体不透明度、显示名。
   * 两段素材重叠 + 各自淡化 = 交叉溶解,所以「转场」不需要单独的对象,改这几个字段就够。
   */
  updateClip(clipId: string, patch: Partial<Pick<TrackClip, "fadeIn" | "fadeOut" | "opacity" | "label">>): { ok: boolean; blocked?: ("fadeIn" | "fadeOut")[] } {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false };
    // 转场管着的淡化不许直接改:那是转场的时长,改了两边就对不上。要改先删转场再重加
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
   * 改素材段的播放速度(`TrackClip.speed`,kernel/clipTime.mjs)。一次调用一步撤销(连带挪动的段一起)。
   *
   * - 速度 0.25～4 倍,超出范围**拒绝并说明**(不夹到边界:手动输入的数被悄悄改掉,用户不知道实际是几倍);取到百分之一倍。
   * - 保住入点(起点、`mediaOffset` 不动),用到的那截素材不变,终点按新速度重算:素材 4 秒、2 倍速 → 2 秒。
   * - **变长会和下一段重合时把后面的段推开**(用户 2026-10-23 定:「变长以后如果会重合就推着后移,但是变短的时候尾部留空。」):
   *   同一条序列里排在它后面的所有段整体后移「新终点 − 下一段起点」(相对关系不变,原有空档先被吃掉);被推的段挂着转场时整组一起推,
   *   声音伴随段跟着走;推不动就整个拒绝并说明,**不截断**。变短时尾部留空,后面的段不动。
   * - **挂着转场的段可以改速度**(用户 2026-10-23 定「可以改」):
   *   - 淡入、淡出、交叉溶解的淡化都写在片段两端(fadeIn / fadeOut 相对片段),跟着片段两端走,时长不变;
   *   - 这一段是交叉溶解的**前一段**:后一段(在另一条序列上)跟着终点平移同样多,溶解的重叠长度不变——变长往后挪、变短往前挪;
   *     后一段所在序列上它后面的段照上面的推开规则让位;往前挪撞上那条序列上前面的段就拒绝;
   *   - 这一段是交叉溶解的**后一段**:起点不动,前一段不动,重叠不变;
   *   - 新长度装不下它身上的转场时,转场跟着缩到比新长度短一点(用户 2026-10-23 定「气泡提示即可」),结果里带上缩了哪几条、
   *     从几秒到几秒,界面弹气泡说清楚;是交叉溶解的后一段时,溶解缩短靠这一段整体往后挪那么多(入点内容不变)。
   * - 改回 1 删掉 `speed` 字段,不留 `speed: 1`(身份键才逐字回到原样)。只给视频段与声音段;序列锁着的拒绝。
   * 〔裁〕第一版变速的视频段不出原声,界面写明;声音段(含音画分离出来的)随倍率变速变调。
   */
  setClipSpeed(clipId: string, speed: number): { ok: true; pushed?: { clips: number; by: number }; moved?: string[]; transitions?: { kind: Transition["kind"]; from: number; to: number }[] } | { ok: false; error: string } {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false, error: "找不到这个片段" };
    // 速度是素材的属性:套了素材效果卡的视频段(片段同时带 cardId)也认,取帧走素材节点的倍率(kernel/clipTime.mjs 的 withMediaRates)
    const media = hit.clip.mediaId && !hit.clip.cutId ? p.media.find((m) => m.id === hit.clip.mediaId) : undefined;
    if (!media || (media.kind !== "video" && media.kind !== "audio")) return { ok: false, error: "只有视频段和声音段能改速度" };
    if (hit.track.locked) return { ok: false, error: "请先解锁序列" };
    if (!speedInRange(speed)) return { ok: false, error: `速度要在 ${CLIP_SPEED_MIN}～${CLIP_SPEED_MAX} 倍之间` };
    const next = normalizeSpeed(speed);
    if (next === null) return { ok: false, error: "速度要是正数" };
    if (next === clipSpeed(hit.clip)) return { ok: true };
    const start = hit.clip.start;
    const end = start + mediaSpanOf(hit.clip) / next;
    let fadePatches = new Map<string, Partial<TrackClip>>();
    const len = end - start;
    if (len < 0.1) return { ok: false, error: "这一段太短，改成这个速度后不到 0.1 秒" };
    const own = transitionsOfClip(p, clipId);
    /*
     * 转场装不下时跟着缩(用户 2026-10-23 定:挂着转场「可以改」,装不下「气泡提示即可」):这一段身上比新长度还长(或一样长)的转场
     * 缩到「比新长度短一点」(和加转场时「转场要比片段短」同一条规矩,取到百分之一秒,不短于 MIN_TRANSITION_DUR),
     * 结果里带上每一条缩了多少(`transitions`),界面弹气泡说清楚。连最短的转场都装不下才拒绝。
     */
    const shrunk = new Map<string, { kind: Transition["kind"]; from: number; to: number }>();
    for (const tr of own) {
      if (tr.dur < len - 1e-9) continue;
      const to = Math.max(MIN_TRANSITION_DUR, Math.floor((len - 0.01) * 100) / 100);
      if (!(to < len)) return { ok: false, error: `改成 ${speedLabel(next)} 后这一段只有 ${len.toFixed(2)} 秒，连最短的转场（${MIN_TRANSITION_DUR} 秒）都装不下；先删掉转场` };
      shrunk.set(tr.id, { kind: tr.kind, from: tr.dur, to });
    }
    const durOf = (tr: Transition) => shrunk.get(tr.id)?.to ?? tr.dur;
    /** 这一段是交叉溶解的后一段、溶解缩短了:这一段整段往后挪「缩掉的那么多」,重叠才跟着变短(入点内容不变) */
    const asB = own.find((tr) => tr.kind === "crossfade" && tr.bId === clipId);
    const lateBy = asB && shrunk.has(asB.id) ? asB.dur - durOf(asB) : 0;
    const delta = end - hit.clip.end;
    let placed: TrackClip = { ...withSpeed(hit.clip, next), start: start + lateBy, end: end + lateBy };

    /** 要平移的段 → 平移量。交叉溶解的后一段跟着终点走(溶解缩短时再多挪缩掉的那么多) */
    const moves = new Map<string, number>();
    const asA = own.find((tr) => tr.kind === "crossfade" && tr.aId === clipId && tr.bId);
    const partner = asA?.bId;
    if (partner) moves.set(partner, delta + lateBy + (asA!.dur - durOf(asA!)));
    /** 一条序列上「这一段(新终点 end2,原终点 end1)」后面的段:碰上了就整体推开 */
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
    if (moves.has(clipId)) return { ok: false, error: "后面的段和这一段绑在同一组转场里，推不开；先删掉转场" };
    const lockedTrack = p.tracks.find((t) => t.locked && t.clips.some((c) => moves.has(c.id)));
    if (lockedTrack) return { ok: false, error: `要挪的段在锁着的序列「${lockedTrack.name}」上；先解锁那条序列` };

    // 缩了的转场:片段两端的淡化跟着改(交叉溶解两头都改),转场记录换新对象
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
    // 平移:被挪的段的声音伴随段先拿出来,挪完再按各自的源片段平移回去(同 moveClip 整组平移的做法)
    let base: import("../../kernel/project").Project = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? placed : c)) }));
    if (fadePatches.size) {
      base = { ...base, tracks: base.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id !== clipId && fadePatches.has(c.id) ? { ...c, ...fadePatches.get(c.id) } : c)) })),
        transitions: transitionsOf(base).map((tr) => (shrunk.has(tr.id) ? { ...tr, dur: durOf(tr) } : tr)) };
    }
    if (moves.size) {
      const companions = new Map(base.tracks.map((t) => [t.id, t.clips.filter((c) => c.soundEffect?.sourceClipId && moves.has(c.soundEffect.sourceClipId))]));
      const lockedCompanion = base.tracks.find((t) => t.locked && companions.get(t.id)!.length);
      if (lockedCompanion) return { ok: false, error: `要挪的段的声音在锁着的序列「${lockedCompanion.name}」上；先解锁那条序列` };
      let moved: import("../../kernel/project").Project | null = { ...base, tracks: base.tracks.map((t) => ({ ...t, clips: sortClips([
        ...t.clips.filter((c) => !companions.get(t.id)!.includes(c)).map((c) => (moves.has(c.id) ? { ...c, start: c.start + moves.get(c.id)!, end: c.end + moves.get(c.id)! } : c)),
        ...companions.get(t.id)!,
      ]) })) };
      for (const id of moves.keys()) {
        const before = findClip(base, id)?.clip, after = moved ? findClip(moved, id)?.clip : undefined;
        if (before && after && moved) moved = moveSoundCompanions(moved, before, after, false);
        if (!moved) return { ok: false, error: "要挪的段的声音伴随段挪不开，没有改速度" };
      }
      base = moved!;
    }
    base = updateTrack(base, hit.track.id, (t) => ({ ...t, clips: sortClips(t.clips) }));
    // 自己的声音伴随段:溶解缩短把这一段往后挪了时先整体平移,再按新长度裁到片段里
    const linked = moveSoundCompanions(base, hit.clip, placed, false);
    if (!linked) return { ok: false, error: "这一段的声音伴随段放不下，没有改速度" };
    // 挪完整体核一遍:任何序列上重叠或跑到 0 之前都整个拒绝(不截断)
    const clash = linked.tracks.find((t) => { const s2 = sortClips(t.clips); return s2.some((c, i) => c.start < -1e-9 || (i > 0 && c.start < s2[i - 1].end - 1e-9)); });
    if (clash) return { ok: false, error: `挪动后序列「${clash.name}」上的段会重叠，没有改速度` };
    setProject(linked);
    return { ok: true, ...(pushedBy > 0 ? { pushed: { clips: [...moves.keys()].filter((id) => id !== partner).length, by: pushedBy } } : {}),
      ...(partner || lateBy > 0 ? { moved: [...(partner ? [partner] : []), ...(lateBy > 0 ? [clipId] : [])] } : {}),
      ...(shrunk.size ? { transitions: [...shrunk.values()] } : {}) };
  },
  removeClip(clipId: string) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return;
    // 片段没了,引用它的转场也就没了意义:一并撤掉,并把另一头的淡化擦干净,
    // 免得留下一段「无缘无故淡出」的画面
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
  /** 在 t 处把 clip 一切为二 */
  splitClip(clipId: string, t: number): TrackClip | null {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit || t <= hit.clip.start + 0.05 || t >= hit.clip.end - 0.05) return null;
    // 切开会凭空多出一段,转场两头就对不上了 —— 先删转场
    if (timingLock(p, clipId)) return null;
    if (hit.track.locked || p.tracks.some(track => track.locked && track.clips.some(c => c.soundEffect?.sourceClipId === clipId))) return null;
    const left: TrackClip = { ...hit.clip, end: t };
    // 后半段的素材起点按片段速度推进(kernel/clipTime.mjs;缺省 1 与原来的 off + (t − start) 逐位相同),速度原样带着
    let right: TrackClip = { ...hit.clip, id: newId("c"), start: t, mediaOffset: mediaOffsetAfter(hit.clip, t - hit.clip.start), ...(hit.clip.parts ? { parts: JSON.parse(JSON.stringify(hit.clip.parts)) } : {}) };
    // 剪辑段:后半段从被引用剪辑的「前半段的偏移 + 前半段的长度」开始(不用 mediaOffset)
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
    // 同样写全:先铺新卡的默认值,再把旧卡里同名的参数覆盖上去
    const kept: Record<string, unknown> = {};
    if (opts.keepParams) {
      for (const k of Object.keys(def.defaults)) if (k in hit.clip.params) kept[k] = hit.clip.params[k];
    }
    const params: Record<string, unknown> = { ...def.defaults, ...kept };
    // 换成别的卡时部件树跟着丢:parts 只属于组合卡,留着会让舞台继续画旧的部件、面板还当它是组合卡
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
