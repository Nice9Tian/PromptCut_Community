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

/** Generate a new session ID matching the /^[A-Za-z0-9_-]{1,64}$/ specification */
export function newChatId(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `c-${time}-${rand}`;
}

/** Get session summary list (in descending order of update time) */
export async function listChats(q?: string): Promise<ChatSummary[]> {
  if (onlinePage()) return []; // Online browser mode has no local chat history
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

/** Read full session content by session ID */
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

/** Save full session to server (debounced and atomic flush to disk) */
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

/** Delete specified session and its associated workspace directory */
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
