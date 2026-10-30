import { newId, type Project, type Track } from "../../kernel/project";
import { transitionsOf } from "../../kernel/transitions";

import { state, set, setProject, clearTransitionFades, updateTrack, pruneCardNodes } from "../core";

export const tracks = {

  /* ---------- 轨道 ---------- */
  /** 加一条序列。opts.index 给了就插在那个位置(时间轴上「拖到序列之间」新建用),不给就加在数组末尾。 */
  addTrack(name?: string, opts: { index?: number } = {}): Track {
    const n = state.project.tracks.length + 1;
    const track: Track = { id: newId("t"), name: name ?? `序列 ${n}`, clips: [] };
    const tracks = [...state.project.tracks];
    const at = opts.index == null ? tracks.length : Math.max(0, Math.min(tracks.length, opts.index));
    tracks.splice(at, 0, track);
    setProject({ ...state.project, tracks });
    return track;
  },
  removeTrack(trackId: string) {
    tracks.removeTracks([trackId]);
  },
  /**
   * 删几条序列(一步撤销)。上面片段挂着的转场一并撤掉、留在别的序列上那一头的淡化擦干净 ——
   * 和 removeClip 一个道理;以前只删序列不管转场,会留下指向不存在片段的转场。
   */
  removeTracks(trackIds: string[]) {
    const p = state.project;
    const ids = new Set(trackIds);
    const gone = new Set(p.tracks.filter((t) => ids.has(t.id)).flatMap((t) => t.clips.map((c) => c.id)));
    const doomed = transitionsOf(p).filter((tr) => gone.has(tr.aId) || (tr.bId !== undefined && gone.has(tr.bId)));
    let next: Project = { ...p, tracks: p.tracks.filter((t) => !ids.has(t.id)) };
    for (const tr of doomed) next = clearTransitionFades(next, tr);
    if (doomed.length) next = { ...next, transitions: transitionsOf(next).filter((tr) => !doomed.includes(tr)) };
    setProject(pruneCardNodes(next));
    if (state.selection.some((id) => gone.has(id))) set({ selection: state.selection.filter((id) => !gone.has(id)) });
  },
  updateTrack(trackId: string, patch: Partial<Pick<Track, "name" | "hidden" | "locked" | "muted">>) {
    setProject(updateTrack(state.project, trackId, (t) => ({ ...t, ...patch })));
  },
  moveTrack(trackId: string, toIndex: number) {
    const tracks = [...state.project.tracks];
    const i = tracks.findIndex((t) => t.id === trackId);
    if (i < 0) return;
    const [tr] = tracks.splice(i, 1);
    tracks.splice(Math.max(0, Math.min(tracks.length, toIndex)), 0, tr);
    setProject({ ...state.project, tracks });
  },
};
