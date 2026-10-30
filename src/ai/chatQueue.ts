import { useSyncExternalStore } from "react";
import type { ChatAttachment } from "./types.ts";

/**
 * 每个 AI 分页一份的输入队列:Agent 正在跑时用户又交了一句,就先排在这里,
 * 这一轮真正落定后由 useAiChat 发出队首(见 useAiChat 里的 pumpQueue)。
 *
 * 只放内存,不持久化:队列是「这会儿打算接着说的话」,刷新页面或关掉分页就不该还在,
 * 否则一打开编辑器就有几句陈年旧话自己发出去。
 *
 * 分两层:下面的 withXxx 是不碰任何全局状态的纯函数(单测直接测它们);
 * 再往下是按分页 id 存的模块级 store 和 React hook。
 */

export interface QueuedItem {
  id: string;
  text: string;
  attachments?: ChatAttachment[];
  createdAt: number;
}

export interface QueueState {
  items: QueuedItem[];
  /**
   * 用户点了「停止」(或回退打断了运行)之后队列暂停:一轮结束也不自动发,
   * 等用户点「继续」。队列清空时自动解除。
   */
  paused: boolean;
}

export const EMPTY_QUEUE: QueueState = Object.freeze({ items: Object.freeze([]) as unknown as QueuedItem[], paused: false });

/* ---------------- 纯函数核心 ---------------- */

/** 追加到队尾 */
export function withEnqueued(s: QueueState, item: QueuedItem): QueueState {
  return { ...s, items: [...s.items, item] };
}

/** 删掉某一条;删空了顺手解除暂停 */
export function withRemoved(s: QueueState, id: string): QueueState {
  if (!s.items.some((x) => x.id === id)) return s;
  const items = s.items.filter((x) => x.id !== id);
  return { items, paused: items.length ? s.paused : false };
}

/** 改某一条的文字 / 附件 */
export function withUpdated(s: QueueState, id: string, patch: Partial<Pick<QueuedItem, "text" | "attachments">>): QueueState {
  if (!s.items.some((x) => x.id === id)) return s;
  return { ...s, items: s.items.map((x) => (x.id === id ? { ...x, ...patch } : x)) };
}

/** 取出队首:返回 [队首, 剩下的队列];空队列返回 [undefined, 原样] */
export function withShifted(s: QueueState): [QueuedItem | undefined, QueueState] {
  if (!s.items.length) return [undefined, s];
  const [head, ...rest] = s.items;
  return [head, { items: rest, paused: rest.length ? s.paused : false }];
}

export function withPaused(s: QueueState, paused: boolean): QueueState {
  // 空队列没有「暂停」可言
  const next = paused && s.items.length > 0;
  return s.paused === next ? s : { ...s, paused: next };
}

/* ---------------- 按分页存的 store ---------------- */

const queues = new Map<string, QueueState>();
const listeners = new Set<() => void>();
let counter = 0;

function commit(tabId: string, next: QueueState) {
  const prev = queues.get(tabId) ?? EMPTY_QUEUE;
  if (next === prev) return;
  if (next.items.length === 0 && !next.paused) queues.delete(tabId);
  else queues.set(tabId, next);
  for (const fn of listeners) fn();
}

export function getQueueState(tabId: string): QueueState {
  return queues.get(tabId) ?? EMPTY_QUEUE;
}

export function getQueue(tabId: string): QueuedItem[] {
  return getQueueState(tabId).items;
}

export function enqueue(tabId: string, input: { text: string; attachments?: ChatAttachment[] }): QueuedItem {
  const item: QueuedItem = {
    id: `q-${Date.now().toString(36)}-${(++counter).toString(36)}`,
    text: input.text,
    ...(input.attachments && input.attachments.length ? { attachments: input.attachments } : {}),
    createdAt: Date.now(),
  };
  commit(tabId, withEnqueued(getQueueState(tabId), item));
  return item;
}

/** 删掉一条,返回被删的那条(没有就是 undefined) */
export function remove(tabId: string, id: string): QueuedItem | undefined {
  const s = getQueueState(tabId);
  const hit = s.items.find((x) => x.id === id);
  if (hit) commit(tabId, withRemoved(s, id));
  return hit;
}

export function update(tabId: string, id: string, patch: Partial<Pick<QueuedItem, "text" | "attachments">>): void {
  commit(tabId, withUpdated(getQueueState(tabId), id, patch));
}

export function shift(tabId: string): QueuedItem | undefined {
  const [head, next] = withShifted(getQueueState(tabId));
  commit(tabId, next);
  return head;
}

export function clear(tabId: string): void {
  commit(tabId, EMPTY_QUEUE);
}

export function isPaused(tabId: string): boolean {
  return getQueueState(tabId).paused;
}

export function setPaused(tabId: string, paused: boolean): void {
  commit(tabId, withPaused(getQueueState(tabId), paused));
}

/** 任意分页的队列变了都会通知;useSyncExternalStore 按快照引用判断自己那一页变没变 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useQueue(tabId: string): QueueState {
  return useSyncExternalStore(subscribe, () => getQueueState(tabId), () => getQueueState(tabId));
}

/** 只给测试用 */
export function _resetQueues(): void {
  queues.clear();
  counter = 0;
}
