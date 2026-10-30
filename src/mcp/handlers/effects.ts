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
      hint: "转场把它引用的片段绑成一组:那几段的相对时间关系锁住了,单独改时长 / 换序列 / 切开都会被拒。整组平移不受限制。要单独调先 remove_transition。",
    };
  },
  addTransition: (args) => {
    const kind = String(args.kind ?? "") as TransitionKind;
    if (!["crossfade", "fadeIn", "fadeOut"].includes(kind)) {
      throw new Error(`kind 只能是 crossfade / fadeIn / fadeOut,收到 ${JSON.stringify(args.kind)}`);
    }
    const r = actions.addTransition({ kind, clipId: args.clipId, otherClipId: args.otherClipId, dur: args.dur });
    if (!r.ok) throw new Error(r.error);
    clipGuard.noteMutation();
    const p = getState().project;
    return {
      ok: true, transition: r.transition, describe: describeTransition(p, r.transition),
      group: [r.transition.aId, ...(r.transition.bId ? [r.transition.bId] : [])],
      note: "这几段现在绑成一组:相对时间关系锁住了(整组平移仍然可以)。要单独调先 remove_transition。",
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
      if (!content) throw new Error(`剪辑「${cut.name}」(${cut.id})没有可读的内容`);
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
      note: `已切换到「${cut.name}」。切换会改共享的激活剪辑,让所有成员的界面一起翻;只是要改别的剪辑里已有的片段时不需要它——` +
        "把 clipId(list_cuts 的 cutId 参数 / get_project 的 parkedCuts 里有)直接交给 update_clip 等就地改;看别的剪辑的画面用 see_frames 的 cutId。" +
        "上面的 timeline 现在是这条的;之前激活的那条已停放,它里面的片段同样可以直接改。",
    };
  },
  // 只建不切(2026-10-21 用户定):切换激活剪辑会动所有成员的界面,要切另调 user_interface_switch_cut
  addCut: (args) => {
    const cut = actions.addCut(args?.name, { switchTo: false });
    clipGuard.noteMutation();
    const p = getState().project;
    return {
      ok: true, cut: { id: cut.id, name: cut.name }, activeCutId: p.activeCutId, cuts: listCuts(p),
      note: `已新建「${cut.name}」(${cut.id}),没有切过去,激活的剪辑不变。要往里新增片段先 user_interface_switch_cut(会动所有成员的界面);也可以用 add_cut_segment 把它当剪辑段放进当前剪辑。`,
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
