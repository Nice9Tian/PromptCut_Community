import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { describeTransition, transitionsOf, type TransitionKind } from "../../kernel/transitions";
import { timelineDigest } from "../tools/toolEcho";
import { listCuts, resolveCut } from "../../kernel/cuts";
import { parkedCutsIndex } from "../../kernel/agentScopes.mjs";
import { getCard } from "../../kernel/registry";
import { cutContent, activeCutIdOf } from "../../kernel/cutSegments";
import { removeCutGate } from "./cutSegments";

import { clipGuard, filterTools, pixelMapTools } from "../common";

export const effectsHandlers = {
  listFilters: () => filterTools.listFilters(),
  createFilter: (args) => { const r = filterTools.createFilter(args); clipGuard.noteMutation(); return r; },
  updateFilter: (args) => { const r = filterTools.updateFilter(args); clipGuard.noteMutation(); return r; },
  removeFilter: (args) => { const r = filterTools.removeFilter(args); clipGuard.noteMutation(); return r; },
  applyFilter: (args) => { const r = filterTools.applyFilter(args); clipGuard.noteMutation(); return r; },
  listPixelMaps: () => pixelMapTools.listPixelMaps(),
  createPixelMap: (args) => { const r = pixelMapTools.createPixelMap(args); clipGuard.noteMutation(); return r; },
  updatePixelMap: (args) => { const r = pixelMapTools.updatePixelMap(args); clipGuard.noteMutation(); return r; },
  removePixelMap: (args) => { const r = pixelMapTools.removePixelMap(args); clipGuard.noteMutation(); return r; },
  applyPixelMap: (args) => { const r = pixelMapTools.applyPixelMap(args); clipGuard.noteMutation(); return r; },
  listMediaEffects: (args) => pixelMapTools.listMediaEffects(args),
  listTransitions: () => {
    const p = getState().project;
    return {
      ok: true,
      transitions: transitionsOf(p).map((tr) => ({ ...tr, describe: describeTransition(p, tr) })),
      hint: "A transition binds the clips it references into one group: their relative timing is locked, and changing duration alone, changing track or splitting any of them will be rejected. Moving the whole group is not restricted. To adjust one individually, run remove_transition first.",
    };
  },
  addTransition: (args) => {
    const kind = String(args.kind ?? "") as TransitionKind;
    if (!["crossfade", "fadeIn", "fadeOut"].includes(kind)) {
      throw new Error(`kind must be crossfade / fadeIn / fadeOut, received ${JSON.stringify(args.kind)}`);
    }
    const r = actions.addTransition({ kind, clipId: args.clipId, otherClipId: args.otherClipId, dur: args.dur });
    if (!r.ok) throw new Error(r.error);
    clipGuard.noteMutation();
    const p = getState().project;
    return {
      ok: true, transition: r.transition, describe: describeTransition(p, r.transition),
      group: [r.transition.aId, ...(r.transition.bId ? [r.transition.bId] : [])],
      note: "These segments are now bound into one group: their relative timing is locked (moving the whole group is still allowed). To adjust one individually, run remove_transition first.",
      timeline: timelineDigest(p),
    };
  },
  removeTransition: (args) => {
    const r = actions.removeTransition(String(args.transitionId ?? ""));
    if (!r.ok) throw new Error(r.error);
    clipGuard.noteMutation();
    return { ok: true, ...(r.note ? { note: r.note } : {}), timeline: timelineDigest(getState().project) };
  },
  /* ---------- Cuts (multiple timelines) ---------- */
  // Each cut includes reference relationships (referencedBy: which cuts and segments reference it;
  // references: which cuts the cut segments inside it reference). When cutId is provided,
  // additionally return an overview of that cut's timeline (ids, start, and end for each track and
  // clip): obtain the clip id to modify without user_interface_switch_cut, and after obtaining it,
  // update_clip / set_clip / get_clip / set_rect… can modify directly by clipId (see mcp/clipCut.ts)
  listCuts: (args) => {
    const p = getState().project;
    const out: Record<string, unknown> = { activeCutId: p.activeCutId, cuts: listCuts(p) };
    if (args?.cutId !== undefined) {
      const cut = resolveCut(p, { cutId: String(args.cutId) });
      const content = cutContent(p, cut.id);
      if (!content) throw new Error(`Cut "${cut.name}" (${cut.id}) has no readable content`);
      // The digest here is the content of another cut assembled using p; the "other cut" hint is
      // meaningless for it
      const { otherCuts: _drop, ...digest } = timelineDigest({ ...p, tracks: content.tracks, duration: content.duration });
      out.timeline = { cutId: cut.id, name: cut.name, active: cut.id === activeCutIdOf(p), ...digest };
    } else {
      // When no cut is specified, list clips from all parked cuts directly (with an upper limit):
      // once the model obtains clipId, it does not need to call user_interface_switch_cut just to
      // "look inside"
      const parkedCuts = parkedCutsIndex(p, { cardName: (id) => getCard(id)?.name });
      if (parkedCuts) out.parkedCuts = parkedCuts;
    }
    return out;
  },
  switchCut: (args) => {
    const cut = resolveCut(getState().project, args);
    actions.switchCut(cut.id);
    clipGuard.noteMutation();
    const p = getState().project;
    return {
      ok: true, activeCutId: p.activeCutId, cuts: listCuts(p), timeline: timelineDigest(p),
      note: `Switched to "${cut.name}". Switching changes the shared active cut and flips every member's interface together; it is not needed when you only want to edit clips that already exist in another cut:` +
        " Pass the clipId (found in list_cuts' cutId parameter / get_project's parkedCuts) directly to update_clip etc. to edit in place; to see another cut's picture, use see_frames' cutId." +
        " The timeline above is now this cut's; the previously active one is parked, and the clips inside it can likewise be edited directly.",
    };
  },
  // Create only, do not switch (user decision, 2026-10-21): switching the active cut affects all
  // members' UIs; to switch, call user_interface_switch_cut separately
  addCut: (args) => {
    const cut = actions.addCut(args?.name, { switchTo: false });
    clipGuard.noteMutation();
    const p = getState().project;
    return {
      ok: true, cut: { id: cut.id, name: cut.name }, activeCutId: p.activeCutId, cuts: listCuts(p),
      note: `Created "${cut.name}" (${cut.id}) without switching to it; the active cut is unchanged. To add clips into it, first run user_interface_switch_cut (this moves every member's interface); or use add_cut_segment to place it into the current cut as a cut segment.`,
    };
  },
  renameCut: (args) => {
    const cut = resolveCut(getState().project, { cutId: args.cutId });
    actions.renameCut(cut.id, args.name);
    return { ok: true, cuts: listCuts(getState().project) };
  },
  removeCut: (args) => {
    const p = getState().project;
    const cut = resolveCut(p, { cutId: args.cutId });
    // The gate follows the same logic as remove_clip: if it has content or is referenced by other cuts
    // (cut segments), it cannot be deleted in a single prompt; force + reason are required, and the
    // reason is echoed to the user
    const blocked = removeCutGate(cut.id, !!args.force, args.reason);
    if (blocked) throw new Error(blocked);
    const before = p.activeCutId;
    const { removedSegments } = actions.removeCut(cut.id);
    clipGuard.noteMutation();
    const q = getState().project;
    return {
      ok: true, removed: cut.id,
      ...(before === cut.id ? { switchedTo: q.activeCutId } : null),
      ...(args.reason ? { reason: args.reason } : null),
      ...(removedSegments.length ? { removedSegments } : null),
      cuts: listCuts(q),
    };
  },
} satisfies Partial<EditorApi>;
