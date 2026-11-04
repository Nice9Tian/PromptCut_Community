import React from "react";
import type { ChatSummary } from "../../ai/chatStore";
import type { CloudChatItem } from "../../ai/chatTypes";
import { CLOUD_CHAT_TEXT } from "../../ai/chatTexts";
import "./ChatHistoryDrawer.css";
import { tr } from "../../i18n/index.ts";

/** The "Cloud" group in the history list (contract 7.4): this member's cloud chats in this project, with running ones marked "In progress" */
export interface CloudHistoryGroup {
  items: CloudChatItem[];
  loading: boolean;
  /** The cloud chat currently open */
  currentId?: string | null;
  onPick(id: string): void;
  /** Whether this account can delete this entry (the person who opened the chat deletes their own; the project creator deletes anyone's); if not given, the whole group has no delete button */
  canDelete?(item: CloudChatItem): boolean;
  onDelete?(item: CloudChatItem): void;
  /** This account's chats in this project have reached the limit: show a hint line at the top */
  limitReached?: boolean;
  /** Number of chats this account has opened itself in this project (live): shown after the "Cloud" title */
  ownedCount?: number;
  /** Maximum number this account can open in one project (account 50, guest 1); defaults to 50 if not given */
  limit?: number;
  /** The wording of the top line when the limit is reached; if not given, use the account one ("Full, delete some first"). Guests use the "Only one chat per project" one */
  limitText?: string;
}

export interface ChatHistoryDrawerProps {
  open: boolean;
  onClose(): void;
  items: ChatSummary[];
  loading: boolean;
  query: string;
  onQueryChange(q: string): void;
  currentId: string;
  onPick(id: string): void;
  onDelete(id: string): void;
  /** The "New chat" in the header: clears the messages of the current tab and starts a new session archive (the same item is also in the "✦" menu) */
  onNewChat?(): void;
  /** Explanation for when a new chat cannot be opened (a guest can only open one chat per project): if given, the header's "New chat" is grayed out and this line is shown on hover */
  newChatDisabledReason?: string;
  /** The "Cloud" group; if not given there is no such group (projects kept on this machine, projects without collaboration enabled) */
  cloud?: CloudHistoryGroup;
  /** The online page has no local chat records: only the Cloud group is listed */
  hideLocal?: boolean;
}

const CLOUD_STATE_TEXT: Record<string, string> = { running: tr("In progress"), interrupted: tr("Interrupted"), failed: tr("Error"), revoked: tr("Expired") };

/** Format a session's update time: today shows HH:MM, this year shows M/D, earlier shows YYYY-M-D */
function formatChatTime(timestamp: number): string {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const isThisYear = d.getFullYear() === now.getFullYear();
  if (isThisYear) {
    return tr("{0}/{1}", d.getMonth() + 1, d.getDate());
  }
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function ChatHistoryDrawer(props: ChatHistoryDrawerProps) {
  const {
    open,
    onClose,
    items,
    loading,
    query,
    onQueryChange,
    currentId,
    onPick,
    onDelete,
    onNewChat,
    newChatDisabledReason,
    cloud,
    hideLocal,
  } = props;

  if (!open) return null;
  const q = query.trim().toLowerCase();
  const cloudItems = cloud ? cloud.items.filter((c) => !q || c.title.toLowerCase().includes(q)) : [];

  return (
    <div className="chat-history-drawer" role="dialog" aria-label={tr("Chat history")}>
      {/* Header: title, new chat, close */}
      <div className="chat-drawer-header">
        <span className="chat-drawer-title">{tr("Chat history")}</span>
        <div className="chat-drawer-head-actions">
          {onNewChat && (
            <button type="button" className="chat-drawer-new-btn" data-pc="chat-new" disabled={!!newChatDisabledReason} title={newChatDisabledReason} onClick={onNewChat}>
              {tr("New chat")}
            </button>
          )}
          <button
            type="button"
            className="chat-drawer-close-btn"
            title={tr("Close")}
            aria-label={tr("Close")}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Search box */}
      <div className="chat-drawer-search-wrap">
        <input
          type="text"
          className="chat-drawer-search-input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={tr("Search chats…")}
        />
      </div>

      {/* Session list */}
      <div className="chat-drawer-list">
        {hideLocal ? null : loading ? (
          <div className="chat-drawer-empty">{tr("Loading…")}</div>
        ) : items.length === 0 ? (
          <div className="chat-drawer-empty">{tr("No chat history yet")}</div>
        ) : (
          items.map((item) => {
            const isCurrent = item.id === currentId;
            return (
              <div
                key={item.id}
                className={`chat-drawer-item ${isCurrent ? "is-current" : ""}`}
                onClick={() => onPick(item.id)}
              >
                <div className="chat-drawer-item-body">
                  <div className="chat-drawer-item-title" title={item.title}>
                    {item.title}
                  </div>
                  <div className="chat-drawer-item-meta">
                    {tr("{0} · {1} messages", formatChatTime(item.updatedAt), item.messageCount)}
                  </div>
                </div>
                <button
                  className="chat-drawer-delete-btn"
                  title={tr("Delete chat")}
                  aria-label={tr("Delete chat")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(item.id);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
        {cloud && (
          <div className="chat-drawer-group" data-pc="chat-cloud-group">
            <div className="chat-drawer-group-title">{tr("Cloud")}{cloud.ownedCount !== undefined && <span data-pc="chat-cloud-count" data-owned={cloud.ownedCount}> · {CLOUD_CHAT_TEXT.countLabel(cloud.ownedCount, cloud.limit)}</span>}</div>
            {cloud.limitReached && <div className="chat-drawer-limit" data-pc="chat-cloud-limit" role="status">{cloud.limitText ?? CLOUD_CHAT_TEXT.limitHint}</div>}
            {cloud.loading && cloudItems.length === 0 ? (
              <div className="chat-drawer-empty">{tr("Loading…")}</div>
            ) : cloudItems.length === 0 ? (
              <div className="chat-drawer-empty">{tr("No cloud chats in this project yet")}</div>
            ) : (
              cloudItems.map((item) => (
                <div
                  key={item.id}
                  className={`chat-drawer-item ${item.id === cloud.currentId ? "is-current" : ""}`}
                  data-pc="chat-cloud-item"
                  data-chat-id={item.id}
                  data-state={item.state}
                  onClick={() => cloud.onPick(item.id)}
                >
                  <div className="chat-drawer-item-body">
                    <div className="chat-drawer-item-title" title={item.title}>
                      {item.title}
                    </div>
                    <div className="chat-drawer-item-meta">
                      {item.updatedAt ? `${formatChatTime(item.updatedAt)} · ` : ""}
                      {item.deleting ? CLOUD_CHAT_TEXT.deleting : (CLOUD_STATE_TEXT[item.state] ?? tr("Cloud"))}
                      {item.startedOn ? ` · ${item.startedOn}` : ""}
                    </div>
                  </div>
                  {cloud.onDelete && cloud.canDelete?.(item) && (
                    <button
                      type="button"
                      className="chat-drawer-delete-btn"
                      data-pc="chat-cloud-delete"
                      title={item.deleting ? CLOUD_CHAT_TEXT.deleteResumeTitle : CLOUD_CHAT_TEXT.deleteButtonTitle}
                      aria-label={item.deleting ? CLOUD_CHAT_TEXT.deleteResumeTitle : CLOUD_CHAT_TEXT.deleteButtonTitle}
                      onClick={(e) => {
                        e.stopPropagation();
                        cloud.onDelete?.(item);
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
