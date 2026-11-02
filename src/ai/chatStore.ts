import type { ChatMessage } from "./types";
import { onlinePage } from "../online/pageFlag";

export interface ChatSummary {
  id: string;
  title: string;
  provider?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview?: string;
}

export interface StoredChat {
  id: string;
  title?: string;
  provider?: string;
  sessionId?: string;
  createdAt?: number;
  updatedAt?: number;
  messages: ChatMessage[];
}

/** 生成符合 /^[A-Za-z0-9_-]{1,64}$/ 规范的新会话 ID */
export function newChatId(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `c-${time}-${rand}`;
}

/** 获取会话概要列表（按更新时间倒序） */
export async function listChats(q?: string): Promise<ChatSummary[]> {
  if (onlinePage()) return []; // 在线浏览器模式没有本机对话记录
  try {
    const url = q ? `/api/chats/list?q=${encodeURIComponent(q)}` : "/api/chats/list";
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`Failed to fetch chat history: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    if (data && data.ok && Array.isArray(data.items)) {
      return data.items;
    }
    return [];
  } catch (err: unknown) {
    console.warn("Network error fetching chat history:", err);
    return [];
  }
}

/** 根据会话 ID 读取完整会话内容 */
export async function getChat(id: string): Promise<StoredChat | null> {
  try {
    const res = await fetch(`/api/chats/get?id=${encodeURIComponent(id)}`);
    if (!res.ok) {
      console.warn(`Failed to read chat: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (data && data.ok && data.chat) {
      return data.chat;
    }
    return null;
  } catch (err: unknown) {
    console.warn("Network error reading chat:", err);
    return null;
  }
}

/** 保存完整会话到服务端（防抖与原子落盘） */
export async function saveChat(chat: StoredChat): Promise<void> {
  try {
    const res = await fetch("/api/chats/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chat),
    });
    if (!res.ok) {
      console.warn(`Failed to save chat: HTTP ${res.status}`);
    }
  } catch (err: unknown) {
    console.warn("Network error saving chat:", err);
  }
}

/** 删除指定会话及其关联工作空间目录 */
export async function deleteChat(id: string): Promise<void> {
  try {
    const res = await fetch("/api/chats/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      console.warn(`Failed to delete chat: HTTP ${res.status}`);
    }
  } catch (err: unknown) {
    console.warn("Network error deleting chat:", err);
  }
}
