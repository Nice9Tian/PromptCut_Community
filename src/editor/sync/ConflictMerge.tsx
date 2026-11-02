/**
 * 桌面的「冲突合并」窗口与导航栏上的「冲突合并」按钮(语义 `workflow/editing.md`「撤销、重做」,`workflow/project.md`
 * 「暂时离线项目与保存」,`product/document-service.md`「冲突」;2026-10-18、2026-10-22 用户定)。
 *
 * - 两级可勾选列表:一级是被改的那样东西,二级是它被改的各个属性,写明改成什么、云端现在是什么;展开后可单独勾一项;
 * - 顶端「选中无冲突项」「取消全部勾选」;底部「合并」「删除选中」,以及关闭按钮(还有可选项是「下次再说」,没有了是「完成」);
 * - 只要还有待处理的项,导航栏顶端就显示「冲突合并」按钮。
 * 离线重连与 0.7.20 的撤销冲突共用这一个窗口(列表里的来源由 `source` 区分,显示与操作不分)。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { setMergeOpen, useSync } from "./syncManager";
import { mergeBarText, useConflictMerge, useMergeCounts } from "./useConflictMerge";
import type { ThingRow } from "./mergeItems";
import "./sync.css";
import { tr } from "../../i18n/index.ts";

/** 文档服务不收待合并表时的说法(超限:整条不收、什么都不丢;处理掉一些之后自动再交) */
export const MERGE_BLOCKED_TEXT: Record<string, string> = {
  unsupported: tr("The document service version is outdated; items pending merge exist only on this device for now."),
  "too-large": tr("Too many items pending merge for the document service to store; they exist only on this device for now. They will be resubmitted automatically after you merge or delete some."),
  "too-many": tr("Too many items pending merge for the document service to store; they exist only on this device for now. They will be resubmitted automatically after you merge or delete some."),
};
export const mergeBlockedText = (reason: string) => MERGE_BLOCKED_TEXT[reason] ?? tr("Items pending merge exist only on this device for now ({0}).", reason);

function Check(props: { state: "all" | "some" | "none"; onChange: () => void; label: string; pc: string }) {
  return (
    <input
      type="checkbox"
      className="pc-merge-check"
      aria-label={props.label}
      data-pc={props.pc}
      checked={props.state === "all"}
      ref={(el) => { if (el) el.indeterminate = props.state === "some"; }}
      onChange={props.onChange}
    />
  );
}

function ThingItem(props: { row: ThingRow; m: ReturnType<typeof useConflictMerge> }) {
  const { row, m } = props;
  const [open, setOpen] = useState(row.conflict);
  return (
    <li className={`pc-merge-thing${row.conflict ? " is-conflict" : ""}`} data-pc="merge-thing" data-key={row.key}>
      <div className="pc-merge-thing-head">
        <Check state={m.check(row)} onChange={() => m.toggleThing(row)} label={tr("Select {0}", row.label)} pc="merge-thing-check" />
        <button type="button" className="pc-merge-expand" aria-expanded={open} title={open ? tr("Collapse") : tr("Expand items")} onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"}
        </button>
        <span className="pc-merge-label" title={row.label}>{row.label}</span>
        <span className="pc-merge-kind">{row.changeText}</span>
        <span className={`pc-merge-chip${row.conflict ? " is-conflict" : ""}`}>{row.conflict ? tr("Has conflicts") : tr("No conflicts")}</span>
        <span className="pc-merge-n">{tr("{0} items", row.props.length)}</span>
      </div>
      {open ? (
        <ul className="pc-merge-props">
          {row.props.map((p) => (
            <li key={p.prop} className={p.conflict ? "is-conflict" : undefined} data-pc="merge-prop" data-prop={p.prop}>
              <Check state={m.sel.get(row.key)?.has(p.prop) ? "all" : "none"} onChange={() => m.toggleProp(row, p.prop)} label={tr("Select {0}", p.text)} pc="merge-prop-check" />
              <span className="pc-merge-text">{p.text}</span>
              {p.conflict ? <span className="pc-merge-chip is-conflict">{tr("Conflict")}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ConflictMergeDialog() {
  const open = useSync((v) => v.mergeOpen);
  if (!open) return null;
  return <DialogBody />;
}

function DialogBody() {
  const m = useConflictMerge();
  const close = () => setMergeOpen(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return createPortal(
    <div className="pc-dialog-mask">
      <div className="pc-dialog pc-sync-dialog pc-merge-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-merge-title" data-pc="conflict-merge">
        <div className="pc-merge-top">
          <div id="pc-merge-title" className="pc-dialog-title">{tr("Merge conflicts")}</div>
          <div className="pc-sync-hint" data-pc="merge-summary">{m.hasItems ? mergeBarText(m.counts) : tr("No changes to merge.")}</div>
        </div>
        {m.hasItems ? (
          <div className="pc-merge-tools">
            <button type="button" className="pc-btn" data-pc="merge-select-clean" onClick={m.selectNonConflict}>{tr("Select non-conflicting items")}</button>
            <button type="button" className="pc-btn" data-pc="merge-clear" onClick={m.clearAll}>{tr("Clear all selections")}</button>
            <span className="pc-sync-hint">{tr("{0} selected", m.selected)}</span>
          </div>
        ) : null}
        <div className="pc-dialog-body pc-merge-body">
          {m.hasItems ? (
            <ul className="pc-merge-list">
              {m.rows.map((r) => <ThingItem key={r.key} row={r} m={m} />)}
            </ul>
          ) : (
            <div className="pc-merge-empty">{tr("All done.")}</div>
          )}
          {m.blocked ? <div className="pc-sync-hint pc-merge-warn" data-pc="merge-blocked">{mergeBlockedText(m.blocked)}</div> : null}
          {!m.online && m.hasItems ? <div className="pc-sync-hint pc-merge-warn" data-pc="merge-offline">{tr("You are offline: you can \"Delete selected\" for now, then \"Merge\" once connected.")}</div> : null}
          {m.note ? <div className="pc-sync-hint" role="status" data-pc="merge-note">{m.note}</div> : null}
        </div>
        <div className="pc-dialog-foot pc-merge-foot">
          {m.hasItems ? (
            <>
              <button type="button" className="pc-btn pc-btn--primary" data-pc="merge-apply" disabled={!m.selected || !m.online} title={m.online ? tr("Write the selected items into the project as changed on your side") : tr("You are offline")} onClick={m.merge}>{tr("Merge")}</button>
              <button type="button" className="pc-btn" data-pc="merge-delete" disabled={!m.selected} title={tr("Discard the selected items and leave the cloud as it is")} onClick={m.remove}>{tr("Delete selected")}</button>
            </>
          ) : null}
          <span style={{ flex: 1 }} />
          <button type="button" className="pc-btn" data-pc="merge-close" onClick={close}>{m.hasItems ? tr("Later") : tr("Done")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 导航栏顶端的「冲突合并」按钮:有待处理的项才显示 */
export function ConflictMergeButton() {
  const c = useMergeCounts();
  if (!c.total) return null;
  return (
    <button
      type="button"
      className={`pc-sync-chip pc-sync-chip--merge${c.conflicts ? " has-conflict" : ""}`}
      data-pc="conflict-merge-open"
      title={mergeBarText(c)}
      onClick={() => setMergeOpen(true)}
    >
      <span className="pc-sync-chip-dot" />
      {tr("Merge conflicts")}
      <span className="pc-merge-badge">{c.total}</span>
    </button>
  );
}
