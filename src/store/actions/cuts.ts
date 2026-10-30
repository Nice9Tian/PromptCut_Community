import {
  switchCut as switchCutPure, addCut as addCutPure, renameCut as renameCutPure,
  removeCut as removeCutPure, placeCutSegment,
} from "../../kernel/cuts";
import { CUT_SEGMENT_REF_FIXED, cutCycleReason, cutDuration, cutReferences, isCutSegment } from "../../kernel/cutSegments";
import { findClip, newId, type Track, type TrackClip } from "../../kernel/project";

import { state, set, setProject, updateTrack, runInCutScope } from "../core";

export const cuts = {

  /* ---------- 剪辑(多条时间轴) ---------- */
  /**
   * 切到另一条剪辑。当前的 tracks / duration / 播放头存回它的条目,目标的换进来。
   * 进撤销栈(整份 project 一起,撤销就是切回去);选中清空、停播、总时长手动值清掉 —— 这些都是
   * 上一条剪辑的东西。播放头用目标上次离开时的。
   */
  switchCut(cutId: string) {
    const { project, t } = switchCutPure(state.project, cutId, state.t);
    if (project === state.project) return;
    setProject(project);
    set({ t, playing: false, selection: [], playToken: state.playToken + 1, durationManual: null });
  },
  /** 新建一条剪辑,默认切过去(和剪辑软件新建序列的习惯一致) */
  addCut(name?: string, opts: { switchTo?: boolean } = {}) {
    const { project, cut } = addCutPure(state.project, name);
    setProject(project);
    if (opts.switchTo !== false) cuts.switchCut(cut.id);
    return cut;
  },
  renameCut(cutId: string, name: string) {
    setProject(renameCutPure(state.project, cutId, name));
  },
  /**
   * 删一条剪辑。删激活那条会先切到相邻的;最后一条不能删(纯逻辑里会抛)。
   * 被别的剪辑引用着时,引用它的剪辑段连同转场一起删(说明与确认是调用方的事:素材库弹确认、
   * Agent 工具要 force)。一步撤销就全回来。返回删掉的剪辑段在哪些剪辑里。
   */
  removeCut(cutId: string) {
    const { project, switchedTo, t, removedSegments } = removeCutPure(state.project, cutId, state.t);
    setProject(project);
    if (switchedTo) set({ t, playing: false, selection: [], playToken: state.playToken + 1, durationManual: null });
    else set({ selection: state.selection.filter((id) => !removedSegments.some((r) => r.clipIds.includes(id))) });
    return { removedSegments };
  },
  /**
   * 就地改停放剪辑里的片段:fn 里的 actions 照常按「这条剪辑当激活」写,提交时只改它的条目,
   * 激活剪辑与 activeCutId 不动(不切换、不翻任何人的界面)。fn 必须同步。见 store/core.ts `runInCutScope`。
   */
  editInCut<T>(cutId: string, fn: () => T): T {
    return runInCutScope(cutId, fn);
  },
  /** 直接引用了这条剪辑的那些剪辑(删之前给人看) */
  cutReferences(cutId: string) {
    return cutReferences(state.project, cutId);
  },
  /** 把剪辑 `childCutId` 放进激活剪辑会不会循环引用;会的话返回原因 */
  cutCycleReason(childCutId: string): string | null {
    const host = state.project.activeCutId;
    return host ? cutCycleReason(state.project, host, childCutId) : null;
  },
  /**
   * 在激活剪辑里放一个引用 `childCutId` 的剪辑段(拖放、Agent 工具)。`newTrackIndex` 给了就新建一条序列放上去;
   * 循环引用、找不到剪辑、序列放不下都抛,错误信息给人看。默认长度 = 被引用剪辑(从 offset 起)剩下的长度。
   */
  addCutSegment(childCutId: string, start: number, opts: { trackId?: string; newTrackIndex?: number; duration?: number; offset?: number } = {}): TrackClip {
    let p = state.project;
    let trackId = opts.trackId;
    if (opts.newTrackIndex !== undefined || (!trackId && !p.tracks.length)) {
      const track: Track = { id: newId("t"), name: `序列 ${p.tracks.length + 1}`, clips: [] };
      const tracks = [...p.tracks];
      const at = Math.max(0, Math.min(tracks.length, opts.newTrackIndex ?? tracks.length));
      tracks.splice(at, 0, track);
      p = { ...p, tracks };
      trackId = track.id;
    } else if (!trackId) {
      // 不指定序列:挑第一条这段时间空着、没锁的
      const free = p.tracks.find((t) => !t.locked && !t.clips.some((c) => c.start < start + 0.05 && start < c.end));
      trackId = (free ?? p.tracks.find((t) => !t.locked))?.id;
    }
    const { project, clip } = placeCutSegment(p, childCutId, start, { trackId, duration: opts.duration, offset: opts.offset });
    setProject(project);
    set({ selection: [clip.id] });
    return clip;
  },
  /**
   * 改剪辑段从被引用剪辑的哪一秒开始。偏移超出被引用剪辑的总长抛。
   * 引用哪条剪辑不能改(2026-10-21 用户定,`workflow/editing.md`「剪辑段的属性」):要换就删掉这段重新放,
   * 所以这个动作只收 `cutOffset`,别处也换不了引用。
   * 改完段太长的话出点截到被引用剪辑剩下的长度(新建或拉长剪辑段时不能超出被引用剪辑当时的总时长)。
   */
  setCutSegment(clipId: string, patch: { cutOffset?: number }): TrackClip {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit || !isCutSegment(hit.clip)) throw new Error(`${clipId} 不是剪辑段`);
    if (hit.track.locked) throw new Error(`序列「${hit.track.name}」锁着`);
    if (patch && Object.hasOwn(patch, "cutId")) throw new Error(CUT_SEGMENT_REF_FIXED);
    const cutId = hit.clip.cutId!;
    const offset = Math.max(0, patch.cutOffset ?? hit.clip.cutOffset ?? 0);
    const total = cutDuration(p, cutId);
    if (offset >= total) throw new Error(`偏移 ${offset} 秒超出了被引用剪辑的总时长 ${total} 秒`);
    const { cutOffset: _o, ...rest } = hit.clip;
    const next: TrackClip = { ...rest, cutId, end: Math.min(hit.clip.end, hit.clip.start + (total - offset)), ...(offset > 0 ? { cutOffset: offset } : {}) };
    setProject(updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? next : c)) })));
    return next;
  },
};
