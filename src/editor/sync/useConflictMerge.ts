/**
 * 「冲突合并」窗口的界面状态(桌面窗口 `ConflictMerge.tsx` 与手机版面板 `src/mobile/sheets.tsx` 共用):
 * 两级列表按当前项目现算(`mergeItems.ts` 的 `mergeRows`),勾选、顶端两个按钮、底部三个按钮的动作都在这里。
 *
 * 「每次点合并时重新核对」在两处做:列表重算时某个已勾选的二级项的云端值变了(窗口开着时别人又改了它),
 * 当场取消勾选并说一句;点「合并」时再按显示时记下的云端值核一遍(`syncManager.mergeSelected`)。
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

export interface ConflictMergeState {
  rows: ThingRow[];
  sel: Selection;
  counts: { total: number; conflicts: number };
  selected: number;
  /** 连着文档服务(能点「合并」) */
  online: boolean;
  /** 最近一次操作的结果,或「刚被别人改过」的提醒 */
  note: string | null;
  /** 还有可选项:关闭按钮叫「下次再说」;没有了叫「完成」 */
  hasItems: boolean;
  /** 文档服务不收待合并表时的原因(旧服务、超限) */
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
  /** 显示时各二级项的云端值(点「合并」时拿它核对) */
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
      setNote(`${changed.length} 项刚被别人改过，已取消勾选，请看过现在的值再决定。`);
    } else {
      setSel((s) => pruneSelection(rows, s));
    }
    // 只跟着列表变;勾选变了不重算
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

/** 冲突横条与导航栏按钮的计数(不开窗口时也要) */
export function useMergeCounts(): { total: number; conflicts: number } {
  const things = useSync((v) => v.merge.things);
  const project = useStore((s) => s.project);
  return useMemo(() => mergeCounts(mergeRows(project, things)), [project, things]);
}

/** 横条与按钮上的那句话:「N 处改动待合并，其中 M 处有冲突」 */
export function mergeBarText(c: { total: number; conflicts: number }): string {
  return `${c.total} 处改动待合并${c.conflicts ? `，其中 ${c.conflicts} 处有冲突` : ""}`;
}
