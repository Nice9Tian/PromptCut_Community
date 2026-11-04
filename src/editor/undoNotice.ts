/**
 * Copy for the "partly not undone" / "nothing undone" notices of undo / redo (c65-undo-draft.md
 * sections 2 and 3, and copy table 4~10).
 * Pure function: the notice in `SyncOverlays.tsx` uses it to get the title and the collapse rule,
 * and unit tests drive it directly.
 */
import type { SkippedEntity, UndoResult } from "../store/docsync";
import { tr } from "../i18n/index.ts";

/** Collapse when there are more than this many entries (draft: list at most 3; with more than 3,
 *  list the first 2, and the 3rd line is "N more (click to expand)") */
export const NOTICE_FOLD_AT = 3;

export function undoNoticeTitle(done: boolean, redo: boolean): string {
  if (done) return redo ? tr("Redone, but these were overwritten by later changes and not restored:") : tr("Undone, but these were overwritten by later changes and not reverted:");
  return redo ? tr("Couldn't redo. These items were changed afterwards, so they keep their current state:") : tr("Couldn't undo. These were all changed afterwards, so they keep their current state:");
}

/** Copy for the collapsed line; N is the total count (the Chinese convention of "and N more",
 *  c65-editor report section 3, item 5) */
export const foldLine = (total: number) => tr("and {0} more (click to expand)", total);

export interface UndoNoticeText {
  title: string;
  /** Lines shown after collapsing */
  lines: string[];
  /** All lines (when expanded) */
  all: string[];
}

/**
 * Everything was undone and nothing failed to apply → null (no notice is shown); otherwise return
 * the title and the lines. Each line is "entity (modified by whom)"; if the inverse operation
 * cannot be applied (the parent has been deleted), write "entity (no longer exists, cannot be
 * rolled back)".
 */
export function undoNotice(
  result: Pick<UndoResult, "done" | "skipped" | "failed">,
  { redo = false, nameOf, whoOf }: { redo?: boolean; nameOf: (entity: string) => string; whoOf: (by: SkippedEntity["by"]) => string },
): UndoNoticeText | null {
  const skipped = result.skipped ?? [];
  const failed = result.failed ?? [];
  if (!skipped.length && !failed.length) return null;
  const all = [
    ...skipped.map((s) => tr("{0} (changed by {1})", nameOf(s.entity), whoOf(s.by))),
    ...failed.map((e) => tr("{0} (no longer exists, cannot be reverted)", nameOf(e))),
  ];
  const lines = all.length > NOTICE_FOLD_AT ? [...all.slice(0, NOTICE_FOLD_AT - 1), foldLine(all.length)] : all;
  return { title: undoNoticeTitle(result.done, redo), lines, all };
}
