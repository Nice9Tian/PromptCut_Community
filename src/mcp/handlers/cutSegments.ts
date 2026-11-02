import type { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { findClip } from "../../kernel/project";
import { CUT_SEGMENT_REF_FIXED, cutCycleReason, cutDuration, cutReferences, isCutSegment } from "../../kernel/cutSegments";
import { listCuts, resolveCut } from "../../kernel/cuts";
import { timelineDigest } from "../tools/toolEcho";
import { clipGuard } from "../common";

/**
 * Agent tools for cut segments (`product/project-model.md` "Cut", "Clip", kernel/cutSegments.ts):
 *   - `add_cut_segment`: place a cut segment referencing another cut into the active cut; reject
 *     and explain the reason when placing into itself or causing circular reference (at any depth);
 *   - `set_cut_segment`: modify which second of the referenced cut the cut segment starts from;
 *     which cut is referenced cannot be changed (user decision, 2026-10-21), reject if cutId / name
 *     is passed (use update_clip / set_position / set_rect for start/end, box, opacity, fade;
 *     use set_clip_volume / set_clip_muted for volume and mute; use split_clip / duplicate_clip
 *     for split and duplicate).
 *
 * Both tools have their own methods on `EditorApi` (src/ai/mcpExecutor.ts), directly connected via
 * the routing table (src/mcp/routes.mjs); local (tool executor in editor) and cloud (hosted tier
 * executing on project replicas, server/agent/ssr-host.mjs) share the same table and the same
 * implementation.
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
    // When the referenced cut becomes shorter after the fact: the portion exceeding its total duration
    // is transparent and silent
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
    if (typeof args.start !== "number" || !Number.isFinite(args.start) || args.start < 0) throw new Error(`start must be a number of seconds not less than 0, received ${JSON.stringify(args.start)}`);
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
    if (!hit) throw new Error(`clip ${args.clipId} not found`);
    if (!isCutSegment(hit.clip)) throw new Error(`clip ${args.clipId} is not a cut segment; use update_clip for card clips and media clips`);
    // Which cut is referenced cannot be changed (user decision, 2026-10-21): to change it, delete this
    // segment and place it again
    if (args.cutId !== undefined || args.name !== undefined) throw new Error(CUT_SEGMENT_REF_FIXED);
    if (args.cutOffset !== undefined && (typeof args.cutOffset !== "number" || !Number.isFinite(args.cutOffset) || args.cutOffset < 0)) {
      throw new Error(`cutOffset must be a number of seconds not less than 0, received ${JSON.stringify(args.cutOffset)}`);
    }
    actions.setCutSegment(hit.clip.id, { ...(args.cutOffset !== undefined ? { cutOffset: args.cutOffset } : {}) });
    clipGuard.noteMutation();
    return { ok: true, segment: segmentInfo(hit.clip.id), timeline: timelineDigest(getState().project) };
  },
};

/**
 * Gate for remove_cut: if it has content or is referenced by other cuts, require force + reason;
 * return pre-deletion explanation
 */
export function removeCutGate(cutId: string, force: boolean, reason?: string): string | null {
  const p = getState().project;
  const info = listCuts(p).find((c) => c.id === cutId)!;
  const refs = cutReferences(p, cutId).filter((r) => r.cutId !== cutId);
  if (refs.length && !force) {
    const list = refs.map((r) => `"${r.name}" (${r.clipIds.length} segments: ${r.clipIds.join(", ")})`).join(", ");
    return `"${info.name}" is referenced by these cuts: ${list}. Deleting it will also delete the cut segments that reference it (undoable); if you really want to delete, pass force:true and state the reason in reason`;
  }
  if (info.clipCount > 0 && !force) return `"${info.name}" contains ${info.clipCount} segments of content and cannot be deleted directly; if you really want to delete, pass force:true and state the reason in reason`;
  if (force && !(reason && reason.trim())) return "A force delete must state the reason in reason";
  return null;
}

export { segmentInfo };
