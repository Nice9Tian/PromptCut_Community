/**
 * UI state of the "Conflict merge" window (shared by the desktop window `ConflictMerge.tsx` and the
 * mobile app panel `src/mobile/sheets.tsx`):
 * the two-level list is computed from the current project (`mergeRows` in `mergeItems.ts`), and the
 * actions of the checkboxes, the two buttons at the top and the three buttons at the bottom are all
 * here.
 *
 * "Re-check on every Merge click" is done in two places: when the list is recomputed and the cloud
 * value of a checked second-level item has changed (someone else changed it again while the window
 * was open), uncheck it on the spot and say so; on clicking "Merge", check once more against the
 * cloud value recorded when it was displayed (`syncManager.mergeSelected`).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../store/project";
import {
  mergeCounts,
  mergeRows,
  pruneSelection,
  selectedCount,
  selectNonConflict,
  thingCheck,
  toggleProp,
  toggleThing,
  type Box,
  type Selection,
  type ThingRow,
} from "./mergeItems";
import { deleteSelected, mergeSelected, useSync } from "./syncManager";
import { tr } from "../../i18n/index.ts";

export interface ConflictMergeState {
  rows: ThingRow[];
  sel: Selection;
  counts: { total: number; conflicts: number };
  selected: number;
  /** Connected to the document service (the "Merge" button works) */
  online: boolean;
  /** Result of the latest action, or the "just changed by someone else" notice */
  note: string | null;
  /** There are still options: the close button reads "Later"; when none are left it reads "Done" */
  hasItems: boolean;
  /** Why the document service does not accept a pending merge list (old service, over the limit) */
  blocked: string | null;
  check(row: ThingRow): "all" | "some" | "none";
  toggleThing(row: ThingRow): void;
  toggleProp(row: ThingRow, prop: string): void;
  selectNonConflict(): void;
  clearAll(): void;
  merge(): void;
  remove(): void;
}

const sameCloud = (a: Box | undefined, b: Box) => JSON.stringify(a ?? null) === JSON.stringify(b);

export function useConflictMerge(): ConflictMergeState {
  const things = useSync((v) => v.merge.things);
  const blocked = useSync((v) => v.merge.blocked);
  const online = useSync((v) => v.active && v.status === "online");
  const project = useStore((s) => s.project);
  const rows = useMemo(() => mergeRows(project, things), [project, things]);
  const [sel, setSel] = useState<Selection>(new Map());
  const [note, setNote] = useState<string | null>(null);
  /** Cloud value of each secondary item at display time (checked against when "Merge" is clicked) */
  const seen = useRef(new Map<string, Box>());

  useEffect(() => {
    const prev = seen.current;
    const next = new Map<string, Box>();
    const changed: string[] = [];
    for (const r of rows) for (const p of r.props) {
      next.set(p.id, p.cloud);
      if (prev.has(p.id) && !sameCloud(prev.get(p.id), p.cloud) && sel.get(r.key)?.has(p.prop)) changed.push(p.id);
    }
    seen.current = next;
    if (changed.length) {
      setSel((s) => {
        const out: Selection = new Map();
        for (const [k, props] of s) {
          const kept = new Set([...props].filter((x) => !changed.includes(`${k}|${x}`)));
          if (kept.size) out.set(k, kept);
        }
        return out;
      });
      setNote(tr("{0} items were just changed by someone else and have been unchecked. Review the current values before deciding.", changed.length));
    } else {
      setSel((s) => pruneSelection(rows, s));
    }
    // Follows the list only; changing the checkboxes does not recompute
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  return {
    rows,
    sel,
    counts: mergeCounts(rows),
    selected: selectedCount(rows, sel),
    online,
    note,
    hasItems: rows.length > 0,
    blocked,
    check: (row) => thingCheck(row, sel),
    toggleThing: (row) => setSel((s) => toggleThing(row, s)),
    toggleProp: (row, prop) => setSel((s) => toggleProp(row, prop, s)),
    selectNonConflict: () => setSel((s) => selectNonConflict(rows, s)),
    clearAll: () => setSel(new Map()),
    merge: () => {
      const r = mergeSelected(sel, seen.current);
      setNote(r.message);
      if (r.stale?.length) {
        setSel((s) => {
          const out: Selection = new Map();
          for (const [k, props] of s) {
            const kept = new Set([...props].filter((x) => !r.stale!.includes(`${k}|${x}`)));
            if (kept.size) out.set(k, kept);
          }
          return out;
        });
      } else setSel(new Map());
    },
    remove: () => {
      const r = deleteSelected(sel);
      setNote(r.message);
      setSel(new Map());
    },
  };
}

/** Count for the conflict banner and the nav bar button (needed even when the window is closed) */
export function useMergeCounts(): { total: number; conflicts: number } {
  const things = useSync((v) => v.merge.things);
  const project = useStore((s) => s.project);
  return useMemo(() => mergeCounts(mergeRows(project, things)), [project, things]);
}

/** The sentence on the banner and the button: "N changes pending merge, M of them in conflict" */
export function mergeBarText(c: { total: number; conflicts: number }): string {
  return tr("{0} changes to merge{1}", c.total, c.conflicts ? tr(", {0} of them in conflict", c.conflicts) : "");
}
