/**
 * Sync-related overlays: undo notice bar, bubble, offline dialog, blocking dialog (c65-undo-draft.md
 * sections 2, 3, 6, c65-ux-draft.md section 5). Copy follows the copy tables of the two drafts word
 * for word; where the drafts left items to be ruled on, the rulings in c65-design.md sections 8 and
 * 9 apply.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  dismissNotice,
  dismissToast,
  discardOffline,
  displayNames,
  jumpToEntity,
  leaveBlocked,
  me,
  pausedSummary,
  replayOffline,
  setOfflineOpen,
  useSync,
  type UndoNoticeView,
} from "./syncManager";
import { clipOfEntity, entityLabel, writerLabel } from "./labels";
import { ONLINE } from "../../online/mode";
import { offlineUnsent, offlineUnsentText, unsentAtRisk } from "./onlineStatus";
import { takeLeaveAllowance } from "./leavePrompt";
import { foldLine, NOTICE_FOLD_AT, undoNoticeTitle } from "../undoNotice";
import { ConflictMergeDialog } from "./ConflictMerge";
import "./sync.css";
import { tr } from "../../i18n/index.ts";

/** How long the notice bar stays (draft: disappears after about 8 seconds, with a close button) */
const NOTICE_MS = 8000;
/** Collapse when there are more places than this (draft: list at most 3 places; src/editor/undoNotice.ts) */
const FOLD_AT = NOTICE_FOLD_AT;

interface Item {
  entity: string;
  label: string;
  by: string;
}

function itemsOf(n: UndoNoticeView): Item[] {
  const names = displayNames();
  const self = me();
  return [
    ...n.result.skipped.map((s) => ({ entity: s.entity, label: entityLabel(s.entity, n.project), by: tr("Changed by {0}", writerLabel(s.by, self, names)) })),
    ...n.result.failed.map((e) => ({ entity: e, label: entityLabel(e, n.project), by: tr("No longer exists, cannot be reverted") })),
  ];
}

function UndoNoticeBar({ n }: { n: UndoNoticeView }) {
  const [expanded, setExpanded] = useState(false);
  const hover = useRef(false);
  useEffect(() => {
    setExpanded(false);
    let left = NOTICE_MS;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      if (!hover.current) left -= now - last;
      last = now;
      if (left <= 0) dismissNotice();
    }, 250);
    return () => clearInterval(timer);
  }, [n.id]);

  const items = itemsOf(n);
  const redo = n.kind === "redo";
  const title = undoNoticeTitle(n.result.done, redo);
  const fold = items.length > FOLD_AT && !expanded;
  const shown = fold ? items.slice(0, FOLD_AT - 1) : items;
  const firstJumpable = items.find((it) => clipOfEntity(it.entity) || it.entity.startsWith("/meta/"));

  return createPortal(
    <div
      className="pc-undo-bar"
      role="status"
      data-pc="undo-notice"
      onMouseEnter={() => (hover.current = true)}
      onMouseLeave={() => (hover.current = false)}
    >
      <div className="pc-undo-bar-head">
        <div className="pc-undo-bar-title">{title}</div>
        <button type="button" className="pc-undo-bar-close" aria-label={tr("Close")} title={tr("Close")} onClick={dismissNotice}>
          ×
        </button>
      </div>
      <ul className="pc-undo-bar-list">
        {shown.map((it, i) => (
          <li key={`${it.entity}-${i}`}>
            <button
              type="button"
              className="pc-undo-entity"
              disabled={!clipOfEntity(it.entity) && !it.entity.startsWith("/meta/")}
              onClick={() => jumpToEntity(it.entity)}
            >
              {it.label}
            </button>{" "}
            <span className="pc-undo-by">({it.by})</span>
          </li>
        ))}
        {fold ? (
          <li>
            <button type="button" className="pc-undo-entity" onClick={() => setExpanded(true)}>
              {foldLine(items.length)}
            </button>
          </li>
        ) : null}
      </ul>
      {!n.result.done ? (
        <div className="pc-sync-hint">
          {tr("You can{0}", " ")}
          <button type="button" className="pc-undo-entity" disabled={!firstJumpable} onClick={() => firstJumpable && jumpToEntity(firstJumpable.entity)}>
            {tr("[click here]")}
          </button>{tr("{0}see the current state of the changed spots, or adjust manually.", " ")}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function Toasts() {
  const toasts = useSync((v) => v.toasts);
  if (!toasts.length) return null;
  return createPortal(
    <div className="pc-toasts" data-pc="sync-toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`pc-toast${t.tone === "warn" ? " pc-toast--warn" : ""}`} role="status">
          <span>{t.text}</span>
          {t.action ? (
            <button type="button" className="pc-toast-action" data-pc={t.action.pc} onClick={t.action.run}>
              {t.action.label}
            </button>
          ) : null}
          <button type="button" className="pc-undo-bar-close" aria-label={tr("Close")} onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

function OfflineDialog() {
  const open = useSync((v) => v.offlineOpen && v.status === "paused");
  const paused = useSync((v) => v.paused);
  if (!open || !paused) return null;
  const summary = pausedSummary();
  return createPortal(
    <div className="pc-dialog-mask">
      <div className="pc-dialog pc-sync-dialog" role="dialog" aria-modal="true" aria-labelledby="pc-offline-title" data-pc="offline-dialog" style={{ position: "relative" }}>
        <button type="button" className="pc-dialog-x" title={tr("Decide later, keep offline changes and review the project first")} aria-label={tr("Close")} onClick={() => setOfflineOpen(false)}>
          ×
        </button>
        <div id="pc-offline-title" className="pc-dialog-title">
          {tr("The project changed while you were offline")}
        </div>
        <div className="pc-dialog-body">
          <div className="pc-sync-hint" style={{ fontSize: 13, color: "var(--ui-fg)" }}>
            {tr("You have {0} offline changes. But the project changed in the meantime in the following ways, which may overlap with your changes:", paused.queued)}
          </div>
          <ul className="pc-offline-list">
            {summary.length ? (
              summary.map((s, i) => (
                <li key={i}>
                  {tr("{0}: {1}", s.who, s.what.join(tr(", ")) || tr("(no specific locations listed)"))}
                </li>
              ))
            ) : (
              <li>{tr("(the document service did not list specific changes)")}</li>
            )}
          </ul>
          <div style={{ fontSize: 13 }}>{tr("Do you still want to add your changes?")}</div>
          <div className="pc-sync-choices-v">
            <button type="button" className="pc-dialog-opt" style={{ justifyContent: "flex-start" }} onClick={replayOffline}>
              {tr("Add them (may overwrite what they just changed)")}
            </button>
            <button type="button" className="pc-dialog-opt" style={{ justifyContent: "flex-start" }} onClick={discardOffline}>
              {tr("No, use the latest version")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const BLOCKED_TEXT = {
  kicked: tr("You were kicked out of this project by the creator and can no longer edit. To come back, ask the creator to revoke it."),
  removed: tr("You have been removed from the list and disconnected, so you can no longer edit."),
  deleted: tr("The project was deleted by its creator. Go back to the start page to create or open another project."),
} as const;

function BlockingDialog() {
  const blocked = useSync((v) => v.blocked);
  if (!blocked) return null;
  return createPortal(
    <div className="pc-dialog-mask" style={{ zIndex: 2000 }}>
      <div className="pc-dialog pc-sync-dialog" role="alertdialog" aria-modal="true" data-pc="blocked-dialog">
        <div className="pc-dialog-body">
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>{BLOCKED_TEXT[blocked]}</div>
          {blocked === "removed" ? <div className="pc-sync-hint">{tr("Ask the creator to add you back to the list, then reopen.")}</div> : null}
        </div>
        <div className="pc-dialog-foot">
          <button type="button" className="pc-btn pc-btn--primary" onClick={leaveBlocked}>
            {tr("start page")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Online page offline with uncommitted changes (C10 contract section 10, table A "permanent
 * notice"): a permanent line of notice below the top bar, with two messages depending on whether the
 * changes were saved ([ruling: 2026-10-22 lead session]). The browser's native leave confirmation
 * (`beforeunload`) is only attached when the changes exist only in this page.
 */
function OfflineUnsentNotice() {
  const store = useSync((v) => v.offlineStore);
  const on = useSync((v) => offlineUnsent(v.status, v.unconfirmed));
  const atRisk = useSync((v) => unsentAtRisk(v.status, v.unconfirmed, v.offlineStore));
  useEffect(() => {
    if (!atRisk) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (takeLeaveAllowance()) return; // "Refresh anyway" was already clicked on the new-version notice bar, do not ask a second time
      e.preventDefault();
      e.returnValue = ""; // Old browsers only show the native leave confirmation if this is set
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [atRisk]);
  if (!on) return null;
  return createPortal(
    <div className="pc-offline-unsent" role="status" data-pc="offline-unsent" data-store={store}>
      {offlineUnsentText(store)}
    </div>,
    document.body,
  );
}

/**
 * Mounted once at the editor root. The mobile app UI (`src/mobile/`) replaces the offline dialog and
 * the conflict merge window with its own conflict merge panel (`offlineDialog: false`), and the
 * other overlays are used from here as is. The offline dialog (the whole "Add it / Discard") only
 * appears when the offline batch cannot compute per-item differences, and normally the conflict
 * merge window takes over.
 */
export function SyncOverlays(props: { offlineDialog?: boolean } = {}) {
  const notice = useSync((v) => v.notice);
  return (
    <>
      {notice ? <UndoNoticeBar n={notice} /> : null}
      <Toasts />
      {ONLINE ? <OfflineUnsentNotice /> : null}
      {props.offlineDialog === false ? null : <OfflineDialog />}
      {props.offlineDialog === false ? null : <ConflictMergeDialog />}
      <BlockingDialog />
    </>
  );
}
