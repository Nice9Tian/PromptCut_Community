/**
 * 按 clipId 改片段的 Agent 工具,片段在**停放的剪辑**里时的处理(`product/project-model.md`「剪辑」:同一时刻只有一条剪辑处于激活状态)。
 *
 * 以前这些工具只找得到激活剪辑里的片段(`findClip` 只看 `Project.tracks`),Agent 要改别的剪辑里的卡只能
 * `switch_cut`(现名 `user_interface_switch_cut`)切过去、改完再切回来:`activeCutId` 是共享的项目字段,每次切换所有成员的界面一起翻,
 * 还有一次必败的调用和两次多余的写入(2026-10-21 线上每轮都有)。
 *
 * 现在 `inClipCut` 包住 clipId 在停放剪辑里的那次调用:在那条剪辑的编辑视图里照常执行(`actions.editInCut`),
 * 提交只改那条剪辑的条目,不切换;回包标明片段在哪条剪辑、`timeline` 是那条剪辑的,看画面的工具只看激活的剪辑所以去掉 `look`。
 * 只包同步的、只改片段自己属性的工具(update_clip / set_clip / get_clip / set_position / set_rect / align / nudge /
 * set_emphasis / set_clip_volume / set_clip_muted);其余按 clipId 找的工具找不到时,用 `clipMissingError` 说清片段在哪条剪辑里。
 */
import { getState, actions } from "../store/project";
import { activeCutIdOf } from "../kernel/cutSegments";
import { parkedCutOfClip } from "../kernel/cuts";
import { findClip, type Project } from "../kernel/project";

/** 「找不到 clip」的报错:片段在别的剪辑里时点明在哪、该怎么办 */
export function clipMissingMessage(p: Project, clipId: string): string {
  const parked = parkedCutOfClip(p, clipId);
  if (!parked) return `clip ${clipId} not found`;
  const active = (p.cuts ?? []).find((c) => c.id === activeCutIdOf(p));
  return `Clip ${clipId} not found: it is not in the active cut${active ? `"${active.name}"` : ""}; it is in cut "${parked.cutName}" (${parked.cutId}); ` +
    "This tool only changes clips in the active cut. First use user_interface_switch_cut to switch to that cut, then retry (this affects the editor of all members; update_clip / set_clip / get_clip / set_position / set_rect / align / nudge / set_emphasis / set_clip_volume / set_clip_muted need no switch)";
}

export function clipMissingError(clipId: string): Error {
  return new Error(clipMissingMessage(getState().project, clipId));
}

/** 回包标上片段所在的剪辑;`look` 的调用补上 cutId(see_frames 传 cutId 就能看没激活的剪辑,不用切换) */
function annotate(result: unknown, cut: { cutId: string; cutName: string }): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { look: lookIn, timeline, ...rest } = result as Record<string, unknown>;
  const look = lookIn && typeof lookIn === "object" && !Array.isArray(lookIn)
    ? { ...(lookIn as Record<string, unknown>), args: { ...((lookIn as { args?: Record<string, unknown> }).args ?? {}), cutId: cut.cutId } }
    : null;
  // 编辑视图里「别的剪辑」是以这条为激活算出来的(激活的那条成了「别的」),对模型是颠倒的,去掉
  const { otherCuts: _other, ...timelineRest } = (timeline && typeof timeline === "object" ? timeline : {}) as Record<string, unknown>;
  return {
    ...rest,
    ...(look ? { look } : null),
    ...(timeline && typeof timeline === "object" ? { timeline: timelineRest } : null),
    cut: { id: cut.cutId, name: cut.cutName, active: false },
    cutNote: `This card is in the inactive cut "${cut.cutName}" and was handled in place without switching cuts (other people's editors are unchanged); the timeline in the reply belongs to that cut.` +
      `To see its frames, call see_frames with cutId: "${cut.cutId}" (no switch needed); get_layout / get_gif only see the active cut.`,
  };
}

export function inClipCut<A extends { clipId?: unknown }, R>(handler: (args: A) => R): (args: A) => R {
  return (args: A): R => {
    const clipId = typeof args?.clipId === "string" ? args.clipId : "";
    const project = getState().project;
    const parked = clipId && !findClip(project, clipId) ? parkedCutOfClip(project, clipId) : null;
    if (!parked) return handler(args);
    return annotate(actions.editInCut(parked.cutId, () => handler(args)), parked) as R;
  };
}

/** 只能改激活剪辑里片段的工具(删、复制、切分……):片段在停放的剪辑里时给出明确的原因,而不是静默什么都没做 */
export function assertClipNotParked(clipId: string): void {
  const project = getState().project;
  if (!findClip(project, clipId) && parkedCutOfClip(project, clipId)) throw clipMissingError(clipId);
}
