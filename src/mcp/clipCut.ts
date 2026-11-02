/**
 * Handling for Agent tools modifying clips by clipId when the clip is in a **parked cut**
 * (`product/project-model.md` "Cut": only one cut is active at any given moment).
 *
 * Previously, these tools could only find clips in the active cut (`findClip` only inspects
 * `Project.tracks`); to modify cards in other cuts, the Agent had to switch over using
 * `switch_cut` (now named `user_interface_switch_cut`), make changes, and then switch back:
 * `activeCutId` is a shared project field, so every switch flips the UI for all members,
 * along with one guaranteed-to-fail call and two redundant writes (occurred every round
 * in production, 2026-10-21).
 *
 * Now `inClipCut` wraps that invocation where clipId is in a parked cut: it executes as usual
 * in that cut's edit view (`actions.editInCut`), and commits only modify entries for that cut
 * without switching; the response clarifies which cut the clip is in, `timeline` belongs to
 * that cut, and since tools inspecting visuals only look at the active cut, `look` is stripped.
 * Only wraps synchronous tools that solely modify the clip's own properties (update_clip /
 * set_clip / get_clip / set_position / set_rect / align / nudge / set_emphasis /
 * set_clip_volume / set_clip_muted); when other tools searching by clipId cannot find it,
 * use `clipMissingError` to explain which cut the clip is in.
 */
import { getState, actions } from "../store/project";
import { activeCutIdOf } from "../kernel/cutSegments";
import { parkedCutOfClip } from "../kernel/cuts";
import { findClip, type Project } from "../kernel/project";

/** "Clip not found" error: clarifies where it is and what to do when the clip is in another cut */
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

/** Tags the response with the cut where the clip resides; adds cutId to `look` calls (passing cutId to see_frames allows viewing inactive cuts without switching) */
function annotate(result: unknown, cut: { cutId: string; cutName: string }): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { look: lookIn, timeline, ...rest } = result as Record<string, unknown>;
  const look = lookIn && typeof lookIn === "object" && !Array.isArray(lookIn)
    ? { ...(lookIn as Record<string, unknown>), args: { ...((lookIn as { args?: Record<string, unknown> }).args ?? {}), cutId: cut.cutId } }
    : null;
  // In the edit view, "other cuts" are computed taking this one as active (the active one becomes "other"), which is inverted for the model, so remove it
  const { otherCuts: _other, ...timelineRest } = (timeline && typeof timeline === "object" ? timeline : {}) as Record<string, unknown>;
  return {
    ...rest,
    ...(look ? { look } : null),
    ...(timeline && typeof timeline === "object" ? { timeline: timelineRest } : null),
    cut: { id: cut.cutId, name: cut.cutName, active: false },
    cutNote: `This card is in the inactive cut "${cut.cutName}" and was handled in place without switching cuts (other people's editors are unchanged); the timeline in the reply belongs to that cut.` +
      ` To see its frames, call see_frames with cutId: "${cut.cutId}" (no switch needed); get_layout / get_gif only see the active cut.`,
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

/** Tools that can only modify clips in the active cut (delete, duplicate, split...): gives an explicit reason when the clip is in a parked cut, rather than silently doing nothing */
export function assertClipNotParked(clipId: string): void {
  const project = getState().project;
  if (!findClip(project, clipId) && parkedCutOfClip(project, clipId)) throw clipMissingError(clipId);
}
