/**
 * 按撤销按钮(含 AI 栏「撤销这一步」)遇到冲突时,把被挡住的那几样接进「冲突合并」窗口(0.7.20;0.7.19 的窗口留的口子)。
 *
 * 语义:`workflow/editing.md`「撤销、重做」、`product/document-service.md`「冲突」:撤回按修改项逐条核对;
 * 要撤的那一步改过的地方之后没有别人再改,直接撤回;别人在它基础上又改过,弹出与暂时离线重连共用的「冲突合并」窗口,由用户决定。
 *
 * DocSync 按实体(片段、项目设置……)挡:实体里有一处被别人改过,整样都没撤(`UndoResult.skipped`),并给出那一步落地后的项目
 * 和只撤这几样之后的项目(`UndoResult.conflict`)。这里再按修改项(属性)细分:
 * - 云端现在仍是那一步落地后的值(没人改过这一项):直接撤(`direct`,一次不进撤销栈的修改,它是这次撤销的一部分);
 * - 云端已经就是撤回后的值:什么都不做;
 * - 别人改过(或删了):进待合并表,来源 `undo`,窗口里写「落地后的值 → 撤回后的值(云端现在是 …)」。
 * 改密退出触发的撤回不走这里(服务器上逐项撤、不弹窗口,`server/account/logout-rollback.mjs`)。
 */
import type { Project } from "../../kernel/project";
import { applyMerge, diffThings, mergeRows, removeFromTable, type DiffMeta, type MergeThing, type Selection } from "./mergeItems";

export interface UndoConflictPlan {
  /** 要进待合并表、打开窗口的(真的冲突) */
  things: MergeThing[];
  /** 不冲突、直接撤的:落地后的项目;没有就是 null */
  direct: Project | null;
  /** 直接撤了几项(二级项数) */
  directCount: number;
}

export function undoConflictPlan(current: Project, conflict: { landed: Project; reverted: Project }, meta: Omit<DiffMeta, "source">,
  opts: { manualDuration?: number | null } = {}): UndoConflictPlan {
  const things = diffThings(conflict.landed, conflict.reverted, { ...meta, source: "undo" });
  const rows = mergeRows(current, things);
  const clean: Selection = new Map(), same: { key: string; props: string[] }[] = [];
  for (const row of rows) {
    const ok = row.props.filter((p) => p.state === "clean").map((p) => p.prop);
    if (ok.length) clean.set(row.key, new Set(ok));
    const done = row.props.filter((p) => p.state === "same").map((p) => p.prop);
    if (done.length) same.push({ key: row.key, props: done });
  }
  let left = same.length ? removeFromTable(things, same) : things, direct: Project | null = null, directCount = 0;
  if (clean.size) {
    const r = applyMerge(current, left, clean, opts);
    if (r.done.length) {
      direct = r.project;
      left = removeFromTable(left, r.done);
      directCount = r.done.reduce((n, d) => n + d.props.filter((p) => clean.get(d.key)?.has(p)).length, 0);
    }
  }
  return { things: left, direct, directCount };
}
