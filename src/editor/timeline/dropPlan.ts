import type { Project } from "../../kernel/project";
import { planPlacement } from "../../store/project";
import { formatTime, snapTime } from "./utils";
import { checkCrossfade, checkFade, clampDur, planTransitionDrop, TRANSITION_LABEL } from "../../kernel/transitions";
import { describeEmphasis } from "../../kernel/emphasis";
import { cutCycleReason } from "../../kernel/cutSegments";
import { type DragPayload } from "../dnd";

/**
 * 「这一拖会落成什么样」的完整描述。dragover 时算一次画成落点预览,drop 时再算一次照着落。
 * 两次用的是同一个函数,所以看到的和落下的一定一致。
 */
export interface DropPlan {
  /** 落在已有序列 = 序列 id;落在新序列 = null(看 newTrackIndex) */
  trackId: string | null;
  /** 新序列插在 tracks 数组的第几位(落在已有序列时为 null) */
  newTrackIndex: number | null;
  start: number;
  end: number;
  /** ok = 原位落下;shift = 原位被占,顺延到后面的空档;forbidden = 落不下 */
  status: "ok" | "shift" | "forbidden";
  /** 落点预览上显示的一行说明 */
  hint: string;
  /** 落点预览上显示的名字 */
  label: string;
}

export type DropTarget = { trackId: string } | { newTrackIndex: number };

/** 强调落在哪一段上:落点那一刻正下方的片段 */
export function clipAt(project: Project, trackId: string, sec: number): { id: string; start: number; end: number } | null {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || track.locked) return null;
  const c = track.clips.find((x) => sec >= x.start && sec < x.end);
  return c ? { id: c.id, start: c.start, end: c.end } : null;
}

/** 转场落点算出来的结论:落下时照着它调 addTransition */
export interface TransitionPlan {
  kind: "crossfade" | "fadeIn" | "fadeOut";
  aId: string;
  bId?: string;
  dur: number;
}

/**
 * 拖着转场在时间轴上晃时的预演:接缝上给交叉溶解,片段两端给淡入 / 淡出,
 * 别的地方明说「拖到片段两端或两段接缝处」。加不上的(中间空着、时长不够)也在这儿就说清楚,
 * 免得松手才报错。
 */
export function planTransition(
  project: Project,
  kind: "crossfade" | "fadeIn" | "fadeOut",
  trackId: string,
  rawSec: number,
  dur: number,
): { plan: TransitionPlan | null; status: "ok" | "forbidden"; hint: string; span: { start: number; end: number } | null } {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return { plan: null, status: "forbidden", hint: "找不到这条序列", span: null };
  if (track.locked) return { plan: null, status: "forbidden", hint: "序列已锁定", span: null };
  const spot = planTransitionDrop(project, trackId, rawSec);
  if (!spot) {
    return { plan: null, status: "forbidden", hint: kind === "crossfade" ? "拖到两段首尾相接的地方" : "拖到片段的开头或结尾", span: null };
  }
  // 拖的是哪一种就只认哪一种:拖着「淡入」落在接缝上,给的还是淡入(落在后一段的头上)
  const wanted = kind === "crossfade" ? spot : { kind, aId: spot.kind === "crossfade" && kind === "fadeIn" ? spot.bId! : spot.aId };
  const d = clampDur(dur);
  if (wanted.kind === "crossfade") {
    const chk = checkCrossfade(project, wanted.aId, wanted.bId!, d);
    if (!chk.ok) return { plan: null, status: "forbidden", hint: chk.error, span: null };
    return {
      plan: { kind: "crossfade", aId: chk.a.id, bId: chk.b.id, dur: chk.dur },
      status: "ok",
      hint: `交叉溶解 ${chk.dur.toFixed(1)}s`,
      span: { start: chk.b.start - chk.dur, end: chk.b.start },
    };
  }
  const side = wanted.kind as "fadeIn" | "fadeOut";
  const chk = checkFade(project, wanted.aId, side, d);
  if (!chk.ok) return { plan: null, status: "forbidden", hint: chk.error, span: null };
  const span = side === "fadeIn"
    ? { start: chk.clip.start, end: chk.clip.start + chk.dur }
    : { start: chk.clip.end - chk.dur, end: chk.clip.end };
  return { plan: { kind: side, aId: chk.clip.id, dur: chk.dur }, status: "ok", hint: `${TRANSITION_LABEL[side]} ${chk.dur.toFixed(1)}s`, span };
}

export function planDrop(
  project: Project,
  payload: DragPayload,
  target: DropTarget,
  rawSec: number,
  opts: { altKey: boolean; pxPerSec: number; t: number },
): DropPlan {
  // 强调也不占地方:落在哪一段上就给哪一段加
  if (payload.kind === "emphasis") {
    const base = { label: payload.name, trackId: null as string | null, newTrackIndex: null as number | null };
    if ("newTrackIndex" in target) {
      return { ...base, start: rawSec, end: rawSec, status: "forbidden", hint: "强调要落在已有的片段上" };
    }
    const hit = clipAt(project, target.trackId, rawSec);
    if (!hit) return { ...base, trackId: target.trackId, start: rawSec, end: rawSec, status: "forbidden", hint: "拖到某一段片段上" };
    return {
      ...base, trackId: target.trackId, start: hit.start, end: hit.end, status: "ok",
      hint: describeEmphasis(payload.emphasis),
    };
  }

  // 转场不占地方,它绑的是已经在时间轴上的片段 —— 只能落在已有序列上
  if (payload.kind === "transition") {
    const base = { label: payload.name, trackId: null as string | null, newTrackIndex: null as number | null };
    if ("newTrackIndex" in target) {
      return { ...base, start: rawSec, end: rawSec, status: "forbidden", hint: "转场要落在已有片段上,不能新建序列" };
    }
    const r = planTransition(project, payload.transition, target.trackId, rawSec, payload.duration);
    return {
      ...base,
      trackId: target.trackId,
      start: r.span?.start ?? rawSec,
      end: r.span?.end ?? rawSec,
      status: r.status,
      hint: r.hint,
    };
  }
  const dur = Math.max(0.1, payload.duration);
  const start = Math.max(0, snapTime(rawSec, opts.altKey, project, opts.t, undefined, opts.pxPerSec));
  const base = { label: payload.name, trackId: null as string | null, newTrackIndex: null as number | null };

  // 剪辑:放进自己或会循环引用(任意深度)时不接受,落点预览上写明原因(workflow/materials.md「素材库里的剪辑」)
  if (payload.kind === "cut") {
    const reason = project.activeCutId ? cutCycleReason(project, project.activeCutId, payload.cutId) : null;
    if (reason) {
      return { ...base, ...("trackId" in target ? { trackId: target.trackId } : { newTrackIndex: target.newTrackIndex }), start, end: start + dur, status: "forbidden", hint: reason };
    }
  }

  if ("newTrackIndex" in target) {
    return {
      ...base,
      newTrackIndex: target.newTrackIndex,
      start,
      end: start + dur,
      status: "ok",
      hint: "松手 = 新建一条序列",
    };
  }

  const track = project.tracks.find((t) => t.id === target.trackId);
  if (!track) {
    return { ...base, start, end: start + dur, status: "forbidden", hint: "找不到这条序列" };
  }
  if (track.locked) {
    return { ...base, trackId: track.id, start, end: start + dur, status: "forbidden", hint: "序列已锁定" };
  }

  const placed = planPlacement(track, start, dur);
  return {
    ...base,
    trackId: track.id,
    start: placed.start,
    end: placed.end,
    status: placed.shifted ? "shift" : "ok",
    hint: placed.shifted ? `这里被占用,顺延到 ${formatTime(placed.start)}` : formatTime(placed.start),
  };
}
