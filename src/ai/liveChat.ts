import { useSyncExternalStore } from "react";
import type { ChatMessage } from "./types.ts";

/**
 * 当前项目正在进行的 AI 对话。
 *
 * (和 chatStore.ts 不是一回事:那个管的是服务端的历史会话归档,
 *  这里管的是「此刻屏幕上这一段」。)
 *
 * 以前它是 useAiChat 里的一个 useState,并按 provider 存进 localStorage
 * (`aiChat:claude`)—— 那意味着对话跟着「用哪个模型」走、跨项目共用同一份,
 * 打开另一个项目还接着上一个项目的话。但对话其实是**项目的一部分**:
 * 它记录的正是这条片子怎么做出来的。
 *
 * 所以挪成模块级 store:组件外也读得到(存 .proc 要收集、打开 .proc 要灌回),
 * 并且随项目整体换掉。
 *
 * 多 Agent 分页之后一个页面上同时有好几段对话,每一页一份 store(getChatStore(tabId))。
 * 「主」那一页(MAIN_TAB)还是原来那份:存进 .proc、随项目切换的只有它 ——
 * 别的页是临时开来并行干活的 Agent,它们各自的历史走服务端的会话归档就够了。
 */

export const MAIN_TAB = "main";

/**
 * 是不是「主页」:随 .proc 存取的那一页。老版本里它的 id 就是 "main";分页清单按项目分开之后,
 * 项目自带的主对话页叫「项目ID_main」(`agentTabs.setAgentProject` 在项目的 .proc 带着对话时补出来)。
 * 两种叫法都认,对话 store 共用同一份。新开的会话(「项目ID_<随机>」)都不是主页。
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

/** 某一页的对话 store。没有就建一份空的;关掉的页用 dropChatStore 收掉 */
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

/** 和 React 的 setState 一样,支持直接给值或给更新函数(主页那一份) */
export function setMessages(next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) {
  main.set(next);
}

/** 换项目 / 新建项目时整体换掉(主页那一份) */
export function replaceMessages(next: unknown) {
  main.replace(next);
}

export function useChatMessages(store: ChatStore = main): ChatMessage[] {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * 存进 .proc 的那一份。
 *
 * 只留可见对话和工具调用摘要:执行轨迹(trace)体积很大而且只对当场排查有用,
 * 没跑完的消息(pending)存下来也复原不了,一并去掉。
 * 条数封顶,免得一个长项目把 .proc 撑到几十兆。
 */
export function messagesForSave(limit = 100, from: ChatStore = main): ChatMessage[] {
  return from.get()
    .filter((m) => !m.pending)
    .slice(-limit)
    .map(({ trace, traceBytes, traceTruncated, ...rest }) => rest);
}
