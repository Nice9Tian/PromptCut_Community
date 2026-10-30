/**
 * 同步相关的浮层:撤销提示条、气泡、离线对话框、阻断弹窗(c65-undo-draft.md 第 2、3、6 节,c65-ux-draft.md 第 5 节)。
 * 文案一字不差照两份稿件的文案表;稿件里待裁定的地方按 c65-design.md 第 8、9 节的裁定。
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

/** 提示条停留多久(稿件:约 8 秒后消失,带关闭按钮) */
const NOTICE_MS = 8000;
/** 多于这么多处就折叠(稿件:最多列 3 处;src/editor/undoNotice.ts) */
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
    ...n.result.skipped.map((s) => ({ entity: s.entity, label: entityLabel(s.entity, n.project), by: `由 ${writerLabel(s.by, self, names)} 修改` })),
    ...n.result.failed.map((e) => ({ entity: e, label: entityLabel(e, n.project), by: "已不存在，没法退回" })),
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
        <button type="button" className="pc-undo-bar-close" aria-label="关闭" title="关闭" onClick={dismissNotice}>
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
          你可以{" "}
          <button type="button" className="pc-undo-entity" disabled={!firstJumpable} onClick={() => firstJumpable && jumpToEntity(firstJumpable.entity)}>
            [点击这里]
          </button>{" "}
          查看被修改处的现状，或直接手动调整。
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
          <button type="button" className="pc-undo-bar-close" aria-label="关闭" onClick={() => dismissToast(t.id)}>
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
        <button type="button" className="pc-dialog-x" title="暂不决定，保留离线修改先查看项目" aria-label="关闭" onClick={() => setOfflineOpen(false)}>
          ×
        </button>
        <div id="pc-offline-title" className="pc-dialog-title">
          断网期间项目有新改动
        </div>
        <div className="pc-dialog-body">
          <div className="pc-sync-hint" style={{ fontSize: 13, color: "var(--ui-fg)" }}>
            你有 {paused.queued} 步断网期间的修改。但这段时间项目有以下改动，可能会和你的修改重叠：
          </div>
          <ul className="pc-offline-list">
            {summary.length ? (
              summary.map((s, i) => (
                <li key={i}>
                  {s.who}：{s.what.join("、") || "（没有列出具体位置）"}
                </li>
              ))
            ) : (
              <li>（文档服务没有列出具体改动）</li>
            )}
          </ul>
          <div style={{ fontSize: 13 }}>还要把你的修改加进去吗？</div>
          <div className="pc-sync-choices-v">
            <button type="button" className="pc-dialog-opt" style={{ justifyContent: "flex-start" }} onClick={replayOffline}>
              加进去（可能会盖掉他们刚改的地方）
            </button>
            <button type="button" className="pc-dialog-opt" style={{ justifyContent: "flex-start" }} onClick={discardOffline}>
              不要了，用现在的最新版本
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const BLOCKED_TEXT = {
  kicked: "你已被创建者踢出该项目，无法继续编辑。想回来，找创建者撤销。",
  removed: "你已被移出名单，连接已断开，无法继续编辑。",
  deleted: "项目已被创建者删除。回开始页新建或打开别的项目。",
} as const;

function BlockingDialog() {
  const blocked = useSync((v) => v.blocked);
  if (!blocked) return null;
  return createPortal(
    <div className="pc-dialog-mask" style={{ zIndex: 2000 }}>
      <div className="pc-dialog pc-sync-dialog" role="alertdialog" aria-modal="true" data-pc="blocked-dialog">
        <div className="pc-dialog-body">
          <div style={{ fontSize: 14, lineHeight: 1.6 }}>{BLOCKED_TEXT[blocked]}</div>
          {blocked === "removed" ? <div className="pc-sync-hint">找创建者把你加回名单，再重新打开。</div> : null}
        </div>
        <div className="pc-dialog-foot">
          <button type="button" className="pc-btn pc-btn--primary" onClick={leaveBlocked}>
            开始页
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 在线页面离线且有未提交的改动(C10 契约第 10 节,表 A「常驻提示」):顶栏下方常驻一行提示,按改动存没存下来说两种话
 * (〔裁:2026-10-22 主会话〕)。只在改动只在这个页面里时挂浏览器原生的离开确认(`beforeunload`)。
 */
function OfflineUnsentNotice() {
  const store = useSync((v) => v.offlineStore);
  const on = useSync((v) => offlineUnsent(v.status, v.unconfirmed));
  const atRisk = useSync((v) => unsentAtRisk(v.status, v.unconfirmed, v.offlineStore));
  useEffect(() => {
    if (!atRisk) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (takeLeaveAllowance()) return; // 新版本提示条上已点过「仍要刷新」，不再问第二遍
      e.preventDefault();
      e.returnValue = ""; // 旧浏览器要设它才弹原生的离开确认
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
 * 挂在编辑器根上一次。手机版界面(`src/mobile/`)把离线对话框与冲突合并窗口换成自己的冲突合并面板(`offlineDialog: false`),
 * 其余浮层照用这里的。离线对话框(整份「加进去 / 不要了」)只在离线批次算不出逐项差异时才会出现,平时由冲突合并窗口接手。
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
