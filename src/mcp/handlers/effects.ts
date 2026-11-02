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
  /* ---------- 剪辑(多条时间轴) ---------- */
  // 每条剪辑带上引用关系(referencedBy:哪些剪辑的哪几段引用了它;references:它里面的剪辑段引用了谁)
  // 给了 cutId 就多返回那条剪辑的 timeline 一览(各序列和片段的 id、起止):不用 user_interface_switch_cut 就能拿到要改的片段 id,
  // 拿到以后 update_clip / set_clip / get_clip / set_rect… 直接按 clipId 改(见 mcp/clipCut.ts)
  listCuts: (args) => {
    const p = getState().project;
    const out: Record<string, unknown> = { activeCutId: p.activeCutId, cuts: listCuts(p) };
    if (args?.cutId !== undefined) {
      const cut = resolveCut(p, { cutId: String(args.cutId) });
      const content = cutContent(p, cut.id);
      if (!content) throw new Error(`Cut "${cut.name}" (${cut.id}) has no readable content`);
      // 这里的 digest 是借 p 拼出来的别条剪辑的内容,「别的剪辑」提示对它没有意义
      const { otherCuts: _drop, ...digest } = timelineDigest({ ...p, tracks: content.tracks, duration: content.duration });
      out.timeline = { cutId: cut.id, name: cut.name, active: cut.id === activeCutIdOf(p), ...digest };
    } else {
      // 不指定剪辑时,把所有停放剪辑里的片段(有上限)直接列出来:模型拿到 clipId 就不必为了「看进去」而 user_interface_switch_cut
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
        "Pass the clipId (found in list_cuts' cutId parameter / get_project's parkedCuts) directly to update_clip etc. to edit in place; to see another cut's picture, use see_frames' cutId." +
        "The timeline above is now this cut's; the previously active one is parked, and the clips inside it can likewise be edited directly.",
    };
  },
  // 只建不切(2026-10-21 用户定):切换激活剪辑会动所有成员的界面,要切另调 user_interface_switch_cut
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
    // 门槛和 remove_clip 一个道理:有内容、或被别的剪辑引用着(剪辑段),都不能一句话删掉,要 force + reason,理由回显给用户
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
