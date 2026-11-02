/**
 * When the undo button (including the AI panel's "Undo this step") hits a conflict, route the
 * blocked items into the "Conflict merge" window (0.7.20; the hook left by the 0.7.19 window).
 *
 * Semantics: `workflow/editing.md` "Undo, redo", `product/document-service.md` "Conflicts": undo is
 * checked per modified item; if nobody else changed what that step changed afterwards, undo
 * directly; if others changed more on top of it, bring up the "Conflict merge" window shared with
 * reconnecting after a temporary offline period, and the user decides.
 *
 * DocSync blocks by entity (clip, project settings, ...): if one place in an entity was changed by
 * someone else, the whole entity is not undone (`UndoResult.skipped`), and it gives the project
 * after that step landed and the project after undoing only these entities (`UndoResult.conflict`).
 * Here we subdivide by modified item (property):
 * - the cloud is still at the value after that step landed (nobody changed this item): undo
 *   directly (`direct`, a change that does not enter the undo stack, as part of this undo);
 * - the cloud already has the undone value: do nothing;
 * - others changed (or deleted) it: enter the pending merge items with source `undo`, and the window
 *   shows "value after landing → value after undo (the cloud is now ...)".
 * The undo triggered by a password-change logout does not go through here (it is undone item by
 * item on the server, with no window, `server/account/logout-rollback.mjs`).
 */
import type { Project } from "../../kernel/project";
import { applyMerge, diffThings, mergeRows, removeFromTable, type DiffMeta, type MergeThing, type Selection } from "./mergeItems";

export interface UndoConflictPlan {
  /** Those that go into the pending merge items and open the window (real conflicts) */
  things: MergeThing[];
  /** Those without conflict, undone directly: the project after landing; null if none */
  direct: Project | null;
  /** How many items were undone directly (number of second-level items) */
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
