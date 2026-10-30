/**
 * 撤销 / 重做「部分没撤」「全部没撤」提示条的文案(c65-undo-draft.md 第 2、3 节与文案表 4～10)。
 * 纯函数:`SyncOverlays.tsx` 的提示条用它取标题与折叠规则,单测直接驱动。
 */
import type { SkippedEntity, UndoResult } from "../store/docsync";

/** 多于这么多处就折叠(稿件:最多列 3 处;多于 3 处时列前 2 处,第 3 行「等 N 处 (点击展开)」) */
export const NOTICE_FOLD_AT = 3;

export function undoNoticeTitle(done: boolean, redo: boolean): string {
  if (done) return redo ? "重做了，但这几处被后续的新修改覆盖，未做恢复：" : "撤销了，但这几处被后续的新修改覆盖，未做退回：";
  return redo ? "没重做成。这几处后来都被改过了，保留了现在的样子：" : "没撤成。这几处后来都被改过了，保留了现在的样子：";
}

/** 折叠行的文案;N 取总数(中文「等 N 处」的习惯,c65-editor 报告第 3 节第 5 条) */
export const foldLine = (total: number) => `等 ${total} 处 (点击展开)`;

export interface UndoNoticeText {
  title: string;
  /** 折叠后显示的行 */
  lines: string[];
  /** 全部的行(展开后) */
  all: string[];
}

/**
 * 撤成了、也没有落不下去的 → null(不弹提示);否则回标题与各行。每行是「实体 (由 谁 修改)」,
 * 逆操作落不下去(父级已被删)的写「实体 (已不存在，没法退回)」。
 */
export function undoNotice(
  result: Pick<UndoResult, "done" | "skipped" | "failed">,
  { redo = false, nameOf, whoOf }: { redo?: boolean; nameOf: (entity: string) => string; whoOf: (by: SkippedEntity["by"]) => string },
): UndoNoticeText | null {
  const skipped = result.skipped ?? [];
  const failed = result.failed ?? [];
  if (!skipped.length && !failed.length) return null;
  const all = [
    ...skipped.map((s) => `${nameOf(s.entity)} (由 ${whoOf(s.by)} 修改)`),
    ...failed.map((e) => `${nameOf(e)} (已不存在，没法退回)`),
  ];
  const lines = all.length > NOTICE_FOLD_AT ? [...all.slice(0, NOTICE_FOLD_AT - 1), foldLine(all.length)] : all;
  return { title: undoNoticeTitle(result.done, redo), lines, all };
}
