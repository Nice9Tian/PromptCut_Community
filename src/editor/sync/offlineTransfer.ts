/**
 * After reconnecting, move the offline batch into the pending merge items (pure logic, loadable in Node unit tests).
 *
 * If the project was changed by someone else while offline, the first entry of DocSync's offline batch
 * is rejected and it stops (`paused`). At that point there are three copies at hand:
 *   - Mine: DocSync's local copy (baseline + my offline changes);
 *   - Baseline: the last version confirmed before going offline = the local copy rolled back by the
 *     inverse operations of the unconfirmed queue;
 *   - Cloud now: DocSync's confirmed copy (fetched fresh for display and merging).
 * Comparing baseline → mine item by item yields the pending merge items (`mergeItems.ts`), which are handed
 * to the pending merge table; after that DocSync returns to the current cloud state and syncs as usual,
 * and the offline changes remain only in the pending merge table, where the user merges or deletes them
 * item by item in the "Conflict merge" window (`product/document-service.md`, "Conflicts" and "Offline").
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

/** Roll the local copy back through the inverse operations of the unconfirmed queue to get the last version confirmed before going offline; return null if it cannot be rolled back */
export function offlineBase(journal: JournalLike): Project | null {
  let p: Project = journal.project;
  for (let i = journal.pending.length - 1; i >= 0; i--) {
    const inv = journal.pending[i].inverse;
    if (!inv.length) {
      // The root replacement that created the project has no inverse: the baseline is "no project", so the offline batch should not stop here
      return null;
    }
    const r = applyOps(p, inv);
    if (!r.ok) return null;
    p = r.value;
  }
  return p;
}

/** Offline batch → pending merge items; return null if no baseline can be computed (the caller falls back to handling the whole copy) */
export function offlineThings(journal: JournalLike, meta: { batch: string; at: number }): MergeThing[] | null {
  const base = offlineBase(journal);
  if (!base) return null;
  return diffThings(base, journal.project, { source: "offline", batch: meta.batch, baseRev: journal.offlineRev ?? journal.rev, at: meta.at });
}
