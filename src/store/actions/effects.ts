import { findClip, newId, type Track, type TrackClip } from "../../kernel/project";
import { stripFilterFromCuts, withoutFilter } from "../../kernel/cuts";
import type { ClipFilter, FilterDef } from "../../kernel/filters.mjs";
import type { ClipPixelMap, PixelMapDef } from "../../kernel/pixelMap.mjs";
import { checkCrossfade, checkFade, clampDur, transitionsOf, type Transition, type TransitionKind } from "../../kernel/transitions";

import { state, setProject, clearTransitionFades, updateTrack, sortClips } from "../core";

export const effects = {

  /* ---------- 滤镜库(项目级,和素材一样所有剪辑共用) ---------- */
  /** 入库;给了 attach 就同一步挂到那一段上(一次 setProject = 一步撤销,不然撤销一次只摘掉、库里还留着) */
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
  /** 删滤镜:激活剪辑和停放剪辑里挂着它的段一并摘掉,不留指向已删滤镜的引用 */
  removeFilter(filterId: string) {
    const p = state.project;
    setProject(stripFilterFromCuts({
      ...p,
      filters: (p.filters ?? []).filter((f) => f.id !== filterId),
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.filter?.id === filterId ? withoutFilter(c) : c)) })),
    }, filterId));
  },

  /** 挂 / 换 / 摘片段上的滤镜(null = 摘掉)。找不到片段返回 false;校验在调用方 */
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

  /* ---------- 通用像素映射 ---------- */
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

  /* ---------- 转场:加了就把相关片段绑成一组(规矩在 kernel/transitions.ts) ---------- */

  /**
   * 加一处转场。
   *
   *   - crossfade:要两段首尾相接的片段。同一条序列内不能重叠,所以会把后一段往前拉出
   *     重叠、必要时挪到另一条序列(挪之前的位置记在 prevB 里,删转场时放回去);
   *   - fadeIn / fadeOut:只认一段,分别写在它的头和尾。
   *
   * 整件事一次 setProject 落地 —— 撤销一步就能全撤,不会留下「挪了但没绑」的半截状态。
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

    if (!args.otherClipId) return { ok: false, error: "交叉溶解要两段:clipId 和 otherClipId" };
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

    // 先原地(后一段本来就不在前一段那条序列上、且挪过去放得下),再找别的,最后新建一条
    const target = [bTrack, ...p.tracks.filter((t) => t.id !== bTrack.id)].find(fits);
    const newTrack: Track | null = target ? null : { id: newId("t"), name: `序列 ${p.tracks.length + 1}`, clips: [] };
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
   * 删一处转场:淡化擦掉、记录去掉,交叉溶解还会尽量把后一段放回加转场之前的位置
   * (那儿被占了就留在原地,返回 note 说明)。删完这几段就自由了。
   */
  removeTransition(transitionId: string): { ok: true; note?: string } | { ok: false; error: string } {
    const p = state.project;
    const tr = transitionsOf(p).find((x) => x.id === transitionId);
    if (!tr) return { ok: false, error: `找不到转场 ${transitionId}` };
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
          note = "后一段原来的位置被占了,留在当前位置(两段现在还重叠着,可以自己挪开)";
        }
      }
    }
    setProject({ ...next, transitions: transitionsOf(next).filter((x) => x.id !== transitionId) });
    return { ok: true, ...(note ? { note } : {}) };
  },
  /**
   * 把两段相接的素材接成交叉溶解:后一段往前拉出 dur 秒的重叠,两边各加 dur 秒的淡化。
   * 同一条序列内不允许重叠,所以后一段必须落在别的序列上——现有序列都放不下就新建一条。
   * 返回是否成功。
   */
  /**
   * 老名字,留着给已有调用方用:现在等价于 addTransition({ kind: "crossfade" })。
   * 一定要走那条路 —— 只有它会写下转场记录,把两段绑成一组;光设 fadeIn / fadeOut
   * 的话谁都能随手挪走其中一段,溶解就悄悄散了。
   */
  applyCrossfade(aId: string, bId: string, dur: number): boolean {
    return effects.addTransition({ kind: "crossfade", clipId: aId, otherClipId: bId, dur }).ok;
  },
};
