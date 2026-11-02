/**
 * The desktop "Merge conflicts" window and the "Merge conflicts" button on the navigation bar
 * (semantics `workflow/editing.md`, "Undo and redo"; `workflow/project.md`, "Temporarily offline
 * projects and saving"; `product/document-service.md`, "Conflicts"; user decisions, 2026-10-18 and
 * 2026-10-22).
 *
 * - Two-level checkable list: the first level is the thing that was changed, the second level is
 *   each of its changed properties, stating what it was changed to and what the cloud has now; once
 *   expanded, single items can be checked on their own;
 * - At the top "Select conflict-free items" and "Clear all selections"; at the bottom "Merge" and
 *   "Delete selected", plus a close button ("Later" while selectable items remain, "Done" when none
 *   are left);
 * - As long as there are pending items, the "Merge conflicts" button is shown at the top of the
 *   navigation bar.
 * Offline reconnection and the undo conflicts of 0.7.20 share this one window (the source of each
 * entry in the list is told apart by `source`; display and operations do not differ).
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { setMergeOpen, useSync } from "./syncManager";
import { mergeBarText, useConflictMerge, useMergeCounts } from "./useConflictMerge";
import type { ThingRow } from "./mergeItems";
import "./sync.css";
import { tr } from "../../i18n/index.ts";

/** What to say when the document service does not accept the pending merge table (over the limit: the whole entry is rejected, nothing is lost; it is resubmitted automatically after some are handled) */
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

/** The "Merge conflicts" button at the top of the navigation bar: shown only when there are pending items */
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
