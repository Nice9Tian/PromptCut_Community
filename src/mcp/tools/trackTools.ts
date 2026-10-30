/**
 * Agent 的序列工具:list_tracks / remove_track / update_track / move_track。
 *
 * 来自一份真实对话导出(对话诊断-20260911-150542):用户说「整理一下轨道」「把空的轨道都删掉」,
 * Agent 手上只有 add_track —— 能建不能删、不能改名、不能调上下顺序,只好把 9 条空序列和
 * 「序列 2 / 序列 6 改名配乐」都甩回给用户手点。想先看一眼有哪些序列,get_project 又有 16 万字符。
 *
 * 校验和门槛都在这里,store 只管改文档;抽成工厂是为了能在 node 里直接测(trackTools.test.mjs)。
 */

import type { Project, Track } from "../../kernel/project";
import { transitionsOf } from "../../kernel/transitions";
import { timelineDigest } from "./toolEcho";

export interface TrackStore {
  getState(): { project: Project };
  actions: {
    addTrack(name?: string, opts?: { index?: number }): Track;
    removeTracks(trackIds: string[]): void;
    updateTrack(trackId: string, patch: Partial<Pick<Track, "name" | "hidden" | "locked" | "muted">>): void;
    moveTrack(trackId: string, toIndex: number): void;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const NAME_MAX = 40;

/** 一条序列的一览:够决定删不删、叫什么、放哪一层,不带 clip 明细 */
export function describeTrack(t: Track, index: number) {
  const cards = t.clips.filter((c) => c.cardId).length;
  const span = t.clips.length ? [round2(Math.min(...t.clips.map((c) => c.start))), round2(Math.max(...t.clips.map((c) => c.end)))] : null;
  return {
    trackId: t.id,
    index,
    name: t.name,
    clipCount: t.clips.length,
    ...(t.clips.length ? { cards, media: t.clips.length - cards, span } : { empty: true }),
    ...(t.hidden ? { hidden: true } : null),
    ...(t.muted ? { muted: true } : null),
    ...(t.locked ? { locked: true } : null),
  };
}

export function describeTracks(p: Project) {
  return p.tracks.map(describeTrack);
}

function findTrack(p: Project, trackId: unknown): Track {
  const id = typeof trackId === "string" ? trackId.trim() : "";
  if (!id) throw new Error("trackId 必填(list_tracks 里拿)");
  const t = p.tracks.find((x) => x.id === id);
  if (!t) {
    const known = p.tracks.map((x) => `${x.id}「${x.name}」`).join("、");
    throw new Error(`当前剪辑里没有序列 ${id}。现有:${known}。序列只属于当前激活的剪辑,要动别的剪辑的序列先 user_interface_switch_cut(会动所有成员的界面)`);
  }
  return t;
}

export function createTrackTools(store: TrackStore) {
  const project = () => store.getState().project;

  return {
    listTracks() {
      const p = project();
      return {
        ok: true,
        tracks: describeTracks(p),
        hint: "index 0 在时间轴最上面、画在最上层。empty:true 的是空序列。hidden 不出现在预览和导出里;muted 声音不进成片;locked 是用户锁住保护的,上面的片段改不了。",
      };
    },

    addTrack(args: { name?: unknown; index?: unknown }) {
      const name = args?.name === undefined ? undefined : String(args.name).trim();
      if (name !== undefined && (!name || name.length > NAME_MAX)) throw new Error(`name 不能为空,也别超过 ${NAME_MAX} 个字`);
      let index: number | undefined;
      if (args?.index !== undefined) {
        index = Number(args.index);
        if (!Number.isInteger(index) || index < 0) throw new Error("index 是从 0 起的整数,0 = 最上面一条");
      }
      const t = store.actions.addTrack(name, index === undefined ? {} : { index });
      const p = project();
      return { ok: true, id: t.id, name: t.name, clips: [], index: p.tracks.findIndex((x) => x.id === t.id), tracks: describeTracks(p) };
    },

    /**
     * 删序列,可一次删几条(一步撤销)。门槛和 remove_cut 一个道理:
     * 空的直接删;有内容的要 force + reason,理由回显给用户;锁定的不删;最后一条不删。
     */
    removeTrack(args: { trackId?: unknown; trackIds?: unknown; force?: unknown; reason?: unknown }) {
      const p = project();
      const raw = Array.isArray(args?.trackIds) ? args.trackIds : args?.trackId !== undefined ? [args.trackId] : [];
      if (raw.length === 0) throw new Error("给 trackId(一条)或 trackIds(几条一起删)");
      const targets = [...new Map(raw.map((id) => { const t = findTrack(p, id); return [t.id, t] as const; })).values()];
      if (targets.length >= p.tracks.length) throw new Error("至少要留一条序列;要清空整条剪辑就删里面的片段,或者 remove_cut");

      const locked = targets.filter((t) => t.locked);
      if (locked.length) {
        throw new Error(
          `${locked.map((t) => `「${t.name}」`).join("、")}锁定着 —— 那是用户锁住保护的,不删。` +
            "只有用户明确说要删它时,才先 update_track({ trackId, locked: false }) 解锁再删。",
        );
      }
      const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
      const full = targets.filter((t) => t.clips.length > 0);
      if (full.length && !args?.force) {
        throw new Error(
          `${full.map((t) => `「${t.name}」(${t.clips.length} 段)`).join("、")}上面还有内容,删序列会连片段一起删掉。` +
            "确实要删就传 force:true 并在 reason 里写明理由(用户会看到);只想清掉空序列就把这几条从 trackIds 里拿掉。",
        );
      }
      if (args?.force && !reason) throw new Error("force 删除必须在 reason 里写明理由,用户会看到这句话");

      const gone = new Set(targets.flatMap((t) => t.clips.map((c) => c.id)));
      const doomed = transitionsOf(p).filter((tr) => gone.has(tr.aId) || (tr.bId !== undefined && gone.has(tr.bId)));
      store.actions.removeTracks(targets.map((t) => t.id));
      const q = project();
      return {
        ok: true,
        removed: targets.map((t) => ({ trackId: t.id, name: t.name, clipCount: t.clips.length })),
        ...(reason && full.length ? { reason } : null),
        ...(doomed.length
          ? { note: `顺带撤掉了 ${doomed.length} 处挂在被删片段上的转场,留在别的序列上的那一头淡化已擦掉` }
          : null),
        tracks: describeTracks(q),
        timeline: timelineDigest(q),
      };
    },

    /** 改名 / 隐藏 / 静音 / 锁定,给哪个改哪个 */
    updateTrack(args: { trackId?: unknown; name?: unknown; hidden?: unknown; muted?: unknown; locked?: unknown }) {
      const t = findTrack(project(), args?.trackId);
      const patch: Partial<Pick<Track, "name" | "hidden" | "locked" | "muted">> = {};
      if (args.name !== undefined) {
        const name = String(args.name).trim();
        if (!name || name.length > NAME_MAX) throw new Error(`name 不能为空,也别超过 ${NAME_MAX} 个字`);
        patch.name = name;
      }
      for (const key of ["hidden", "muted", "locked"] as const) {
        if (args[key] === undefined) continue;
        if (typeof args[key] !== "boolean") throw new Error(`${key} 要传 true 或 false,收到 ${JSON.stringify(args[key])}`);
        patch[key] = args[key] as boolean;
      }
      if (Object.keys(patch).length === 0) throw new Error("name / hidden / muted / locked 至少给一个");
      store.actions.updateTrack(t.id, patch);
      const p = project();
      const i = p.tracks.findIndex((x) => x.id === t.id);
      const notes: string[] = [];
      if (patch.hidden) notes.push("隐藏后这条序列不出现在预览和导出里(声音也没了),不是删除");
      if (patch.muted) notes.push("静音后这条序列的声音不进预览和成片,画面照常");
      if (patch.locked) notes.push("锁定后这条序列上的片段改不了、删不了,序列本身也删不了");
      return { ok: true, track: describeTrack(p.tracks[i], i), ...(notes.length ? { note: notes.join(";") } : null) };
    },

    /** 调上下顺序:index 0 = 最上面、画在最上层 */
    moveTrack(args: { trackId?: unknown; index?: unknown }) {
      const p = project();
      const t = findTrack(p, args?.trackId);
      const index = Number(args?.index);
      const last = p.tracks.length - 1;
      if (!Number.isInteger(index) || index < 0 || index > last) throw new Error(`index 要是 0~${last} 的整数(0 = 最上面一条)`);
      store.actions.moveTrack(t.id, index);
      return {
        ok: true,
        note: "时间轴上靠上的序列画在上层;声音不分上下层,只有画面的遮挡关系变了",
        tracks: describeTracks(project()),
      };
    },
  };
}
