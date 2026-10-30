import React from "react";
import type { ChatSummary } from "../../ai/chatStore";
import type { CloudChatItem } from "../../ai/chatTypes";
import { CLOUD_CHAT_TEXT } from "../../ai/chatTexts";
import "./ChatHistoryDrawer.css";

/** 历史列表里「云端」一组(契约 7.4):这位成员在这个项目里的云端对话,在跑的带「进行中」 */
export interface CloudHistoryGroup {
  items: CloudChatItem[];
  loading: boolean;
  /** 当前打开的云端对话 */
  currentId?: string | null;
  onPick(id: string): void;
  /** 这一条这个账号能不能删（开对话的人删自己的；项目创建者删任何人的）；不给就整组没有删除按钮 */
  canDelete?(item: CloudChatItem): boolean;
  onDelete?(item: CloudChatItem): void;
  /** 这位账号在这个项目里的对话已满上限：顶上给一行提示 */
  limitReached?: boolean;
  /** 这位账号在这个项目里自己开的对话数(实时)：显示在「云端」标题后面 */
  ownedCount?: number;
  /** 这个账号在一个项目里最多能开几个（账号 50，游客 1）；不给按 50 */
  limit?: number;
  /** 满额时顶上那一行用什么话；不给用账号那一句（「已满，先删几个」）。游客用「每个项目只能开一个对话」那一句 */
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
  /** 头部的「新对话」:清掉当前分页的消息、另起一段会话归档(「✦」菜单里也有同一项) */
  onNewChat?(): void;
  /** 新对话开不了（游客每个项目只能开一个对话）时的说明：给了就把头部的「新对话」置灰、悬停写这一句 */
  newChatDisabledReason?: string;
  /** 「云端」一组;不给就没有这一组(放本机的项目、没开协作的项目) */
  cloud?: CloudHistoryGroup;
  /** 在线页面没有本机对话记录:只列云端一组 */
  hideLocal?: boolean;
}

const CLOUD_STATE_TEXT: Record<string, string> = { running: "进行中", interrupted: "已中断", failed: "出错", revoked: "已失效" };

/** 格式化会话更新时间：今天的显示 HH:MM，今年的显示 M月D日，更早显示 YYYY-M-D */
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
    return `${d.getMonth() + 1}月${d.getDate()}日`;
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
    <div className="chat-history-drawer" role="dialog" aria-label="对话历史">
      {/* 头部:标题、新对话、关闭 */}
      <div className="chat-drawer-header">
        <span className="chat-drawer-title">对话历史</span>
        <div className="chat-drawer-head-actions">
          {onNewChat && (
            <button type="button" className="chat-drawer-new-btn" data-pc="chat-new" disabled={!!newChatDisabledReason} title={newChatDisabledReason} onClick={onNewChat}>
              新对话
            </button>
          )}
          <button
            type="button"
            className="chat-drawer-close-btn"
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      {/* 搜索框 */}
      <div className="chat-drawer-search-wrap">
        <input
          type="text"
          className="chat-drawer-search-input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="搜索对话…"
        />
      </div>

      {/* 会话列表 */}
      <div className="chat-drawer-list">
        {hideLocal ? null : loading ? (
          <div className="chat-drawer-empty">读取中…</div>
        ) : items.length === 0 ? (
          <div className="chat-drawer-empty">还没有历史对话</div>
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
                    {formatChatTime(item.updatedAt)} · {item.messageCount} 条消息
                  </div>
                </div>
                <button
                  className="chat-drawer-delete-btn"
                  title="删除对话"
                  aria-label="删除对话"
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
            <div className="chat-drawer-group-title">云端{cloud.ownedCount !== undefined && <span data-pc="chat-cloud-count" data-owned={cloud.ownedCount}> · {CLOUD_CHAT_TEXT.countLabel(cloud.ownedCount, cloud.limit)}</span>}</div>
            {cloud.limitReached && <div className="chat-drawer-limit" data-pc="chat-cloud-limit" role="status">{cloud.limitText ?? CLOUD_CHAT_TEXT.limitHint}</div>}
            {cloud.loading && cloudItems.length === 0 ? (
              <div className="chat-drawer-empty">读取中…</div>
            ) : cloudItems.length === 0 ? (
              <div className="chat-drawer-empty">这个项目里还没有云端对话</div>
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
                      {item.deleting ? CLOUD_CHAT_TEXT.deleting : (CLOUD_STATE_TEXT[item.state] ?? "云端")}
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
