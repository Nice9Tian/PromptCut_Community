import type { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { findClip } from "../../kernel/project";
import { CUT_SEGMENT_REF_FIXED, cutCycleReason, cutDuration, cutReferences, isCutSegment } from "../../kernel/cutSegments";
import { listCuts, resolveCut } from "../../kernel/cuts";
import { timelineDigest } from "../tools/toolEcho";
import { clipGuard } from "../common";

/**
 * 剪辑段的 Agent 工具(`product/project-model.md`「剪辑」「片段」,kernel/cutSegments.ts):
 *   - `add_cut_segment`:在激活剪辑里放一个引用别的剪辑的剪辑段;放进自己、会循环引用(任意深度)时拒绝并说明原因;
 *   - `set_cut_segment`:改剪辑段从被引用剪辑的哪一秒开始;引用哪条剪辑不能改(2026-10-21 用户定),带了 cutId / name 就拒(起止、框、不透明度、淡入淡出用 update_clip /
 *     set_position / set_rect,音量与静音用 set_clip_volume / set_clip_muted,切分与复制用 split_clip / duplicate_clip)。
 *
 * 两个工具在 `EditorApi`(src/ai/mcpExecutor.ts)上各有自己的方法,路由表(src/mcp/routes.mjs)直连;
 * 本机(编辑台的工具执行器)与云端(托管档在项目副本上执行,server/agent/ssr-host.mjs)走同一张表、同一份实现。
 */
type Args = Record<string, any>;

function segmentInfo(clipId: string) {
  const p = getState().project;
  const hit = findClip(p, clipId);
  if (!hit || !isCutSegment(hit.clip)) return null;
  const c = hit.clip;
  const name = p.cuts?.find((x) => x.id === c.cutId)?.name ?? null;
  const total = cutDuration(p, c.cutId!);
  return {
    clipId: c.id, trackId: hit.track.id, cutId: c.cutId!, cutName: name, cutOffset: c.cutOffset ?? 0,
    start: c.start, end: c.end, cutDuration: total,
    // 被引用剪辑事后变短:超出它总时长的那一截透明无声
    beyondCutEnd: Math.max(0, (c.end - c.start) - Math.max(0, total - (c.cutOffset ?? 0))),
    ...(c.frame ? { frame: c.frame } : {}), ...(c.opacity !== undefined ? { opacity: c.opacity } : {}),
    ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}), ...(c.fadeOut ? { fadeOut: c.fadeOut } : {}),
    ...(c.audioVolume !== undefined ? { audioVolume: c.audioVolume } : {}), ...(c.audioMuted ? { audioMuted: true } : {}),
  };
}

export const cutSegmentHandlers: Pick<EditorApi, "addCutSegment" | "setCutSegment"> = {
  addCutSegment: (args: Args) => {
    const p = getState().project;
    const cut = resolveCut(p, { cutId: args.cutId, name: args.name });
    const reason = p.activeCutId ? cutCycleReason(p, p.activeCutId, cut.id) : null;
    if (reason) throw new Error(reason);
    if (typeof args.start !== "number" || !Number.isFinite(args.start) || args.start < 0) throw new Error(`start 必须是不小于 0 的秒数,收到 ${JSON.stringify(args.start)}`);
    const clip = actions.addCutSegment(cut.id, args.start, {
      ...(args.trackId ? { trackId: String(args.trackId) } : {}),
      ...(typeof args.duration === "number" ? { duration: args.duration } : {}),
      ...(typeof args.cutOffset === "number" ? { offset: args.cutOffset } : {}),
    });
    clipGuard.noteCreated(clip.id);
    return { ok: true, segment: segmentInfo(clip.id), timeline: timelineDigest(getState().project) };
  },
  setCutSegment: (args: Args) => {
    const p = getState().project;
    const hit = findClip(p, String(args.clipId ?? ""));
    if (!hit) throw new Error(`找不到 clip ${args.clipId}`);
    if (!isCutSegment(hit.clip)) throw new Error(`clip ${args.clipId} 不是剪辑段;卡片段、素材段用 update_clip`);
    // 引用哪条剪辑不能改(2026-10-21 用户定):要换就删掉这段重新放
    if (args.cutId !== undefined || args.name !== undefined) throw new Error(CUT_SEGMENT_REF_FIXED);
    if (args.cutOffset !== undefined && (typeof args.cutOffset !== "number" || !Number.isFinite(args.cutOffset) || args.cutOffset < 0)) {
      throw new Error(`cutOffset 必须是不小于 0 的秒数,收到 ${JSON.stringify(args.cutOffset)}`);
    }
    actions.setCutSegment(hit.clip.id, { ...(args.cutOffset !== undefined ? { cutOffset: args.cutOffset } : {}) });
    clipGuard.noteMutation();
    return { ok: true, segment: segmentInfo(hit.clip.id), timeline: timelineDigest(getState().project) };
  },
};

/** remove_cut 的门槛:有内容、或被别的剪辑引用着,都要 force + reason;返回删前说明 */
export function removeCutGate(cutId: string, force: boolean, reason?: string): string | null {
  const p = getState().project;
  const info = listCuts(p).find((c) => c.id === cutId)!;
  const refs = cutReferences(p, cutId).filter((r) => r.cutId !== cutId);
  if (refs.length && !force) {
    const list = refs.map((r) => `「${r.name}」(${r.clipIds.length} 段:${r.clipIds.join("、")})`).join("、");
    return `「${info.name}」正被这些剪辑引用:${list}。删除会连同引用它的剪辑段一起删掉(可撤销);确实要删就传 force:true 并在 reason 里写明理由`;
  }
  if (info.clipCount > 0 && !force) return `「${info.name}」里有 ${info.clipCount} 段内容,不能直接删;确实要删就传 force:true 并在 reason 里写明理由`;
  if (force && !(reason && reason.trim())) return "force 删除必须在 reason 里写明理由";
  return null;
}

export { segmentInfo };
