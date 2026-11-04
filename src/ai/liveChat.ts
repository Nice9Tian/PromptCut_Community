import { useSyncExternalStore } from "react";
import type { ChatMessage } from "./types.ts";

/**
 * The AI chat currently in progress for the current project.
 *
 * (Not the same thing as chatStore.ts: that one manages the server's archive of past sessions,
 *  while this one manages "the segment on the screen right now".)
 *
 * It used to be a useState inside useAiChat, stored in localStorage per provider
 * (`aiChat:claude`). That meant the chat followed "which model is used" and was shared across
 * projects, so opening another project would pick up the previous project's conversation. But the
 * chat is really **part of the project**: it records exactly how this video was made.
 *
 * So it became a module-level store: readable from outside components too (saving .proc needs to
 * collect it, opening .proc needs to pour it back in), and replaced as a whole along with the
 * project.
 *
 * With multi-Agent tabs, one page has several chats at the same time, one store per tab
 * (getChatStore(tabId)). The "main" tab (MAIN_TAB) is still the original one: it is the only one
 * saved into .proc and switched along with the project. The other tabs are Agents opened
 * temporarily to work in parallel, and it is enough for their histories to go through the server's
 * session archive.
 */

export const MAIN_TAB = "main";

/**
 * Whether this is the "main tab": the one saved and loaded with .proc. In old versions its id was
 * simply "main"; after the tab manifests were split per project, a project's own main chat tab is
 * called "projectId_main" (`agentTabs.setAgentProject` fills it in when the project's .proc carries
 * a chat). Both names are recognized and share the same chat store. Newly opened sessions
 * ("projectId_<random>") are never the main tab.
 */
export function isMainTab(tabId: string): boolean {
  return tabId === MAIN_TAB || tabId.endsWith(`_${MAIN_TAB}`);
}

export interface ChatStore {
  get(): ChatMessage[];
  set(next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])): void;
  replace(next: unknown): void;
  subscribe(fn: () => void): () => void;
}

function createStore(): ChatStore {
  let messages: ChatMessage[] = [];
  const listeners = new Set<() => void>();
  const emit = () => { for (const fn of listeners) fn(); };
  return {
    get: () => messages,
    set(next) {
      const value = typeof next === "function" ? next(messages) : next;
      if (value === messages) return;
      messages = value;
      emit();
    },
    replace(next) {
      messages = Array.isArray(next) ? (next as ChatMessage[]) : [];
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

const stores = new Map<string, ChatStore>();

/**
 * The chat store of a given tab. Creates an empty one if there is none; a closed tab is cleaned up
 * with dropChatStore
 */
export function getChatStore(tabId: string = MAIN_TAB): ChatStore {
  const key = isMainTab(tabId) ? MAIN_TAB : tabId;
  let s = stores.get(key);
  if (!s) {
    s = createStore();
    stores.set(key, s);
  }
  return s;
}

export function dropChatStore(tabId: string): void {
  if (isMainTab(tabId)) return;
  stores.delete(tabId);
}

const main = getChatStore(MAIN_TAB);

export function getMessages(): ChatMessage[] {
  return main.get();
}

/** Like React's setState, accepts either a value or an updater function (for the main tab's store) */
export function setMessages(next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) {
  main.set(next);
}

/** Replaced as a whole when switching projects / creating a new project (the main tab's store) */
export function replaceMessages(next: unknown) {
  main.replace(next);
}

export function useChatMessages(store: ChatStore = main): ChatMessage[] {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * The copy that is saved into .proc.
 *
 * Only the visible chat and tool-call summaries are kept: the execution trace (trace) is very large
 * and useful only for on-the-spot troubleshooting, and unfinished messages (pending) could not be
 * restored even if saved, so both are dropped.
 * The number of entries is capped, so that one long project does not bloat .proc to tens of MB.
 */
export function messagesForSave(limit = 100, from: ChatStore = main): ChatMessage[] {
  return from.get()
    .filter((m) => !m.pending)
    .slice(-limit)
    .map(({ trace, traceBytes, traceTruncated, ...rest }) => rest);
}
