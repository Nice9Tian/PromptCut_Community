/**
 * 重连后把离线批次转进待合并表(纯逻辑,Node 单测可载入)。
 *
 * 断网期间项目被别人改过时,DocSync 的离线批次第一条被拒、停下(`paused`)。这时手里有三份:
 *   - 我这边:DocSync 的本地副本(基准 + 我的离线修改);
 *   - 基准:断网时最后确认的那一版 = 本地副本按待确认队列的逆操作倒着退回去;
 *   - 云端现在:DocSync 的已确认副本(显示与合并时现取)。
 * 基准 → 我这边逐项比出待合并的东西(`mergeItems.ts`),交给待合并表;之后 DocSync 回到云端现状、照常同步,
 * 离线修改只留在待合并表里,由用户在「冲突合并」窗口里逐项合并或删除(`product/document-service.md`「冲突」「离线」)。
 */
import { applyOps, type PathOp } from "../../kernel/diffProject";
import type { Project } from "../../kernel/project";
import { diffThings, type MergeThing } from "./mergeItems";

export interface JournalLike {
  project: Project;
  rev: number;
  offlineRev: number | null;
  pending: { opId: string; ops: PathOp[]; inverse: PathOp[] }[];
}

/** 本地副本按待确认队列的逆操作倒着退回去,得到断网前最后确认的那一版;退不回去回 null */
export function offlineBase(journal: JournalLike): Project | null {
  let p: Project = journal.project;
  for (let i = journal.pending.length - 1; i >= 0; i--) {
    const inv = journal.pending[i].inverse;
    if (!inv.length) {
      // 根替换建项目的那条没有逆操作:基准就是没有项目,离线批次不该停在这里
      return null;
    }
    const r = applyOps(p, inv);
    if (!r.ok) return null;
    p = r.value;
  }
  return p;
}

/** 离线批次 → 待合并的东西;算不出基准回 null(调用方退回整份处理) */
export function offlineThings(journal: JournalLike, meta: { batch: string; at: number }): MergeThing[] | null {
  const base = offlineBase(journal);
  if (!base) return null;
  return diffThings(base, journal.project, { source: "offline", batch: meta.batch, baseRev: journal.offlineRev ?? journal.rev, at: meta.at });
}
