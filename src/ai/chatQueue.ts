import { useSyncExternalStore } from "react";
import type { ChatAttachment } from "./types.ts";

/**
 * An input queue per AI tab: when the user submits another message while the Agent is running,
 * it is queued here first; after this round has truly settled, useAiChat dispatches the head
 * of the queue (see pumpQueue in useAiChat).
 *
 * Kept only in memory, not persisted: the queue represents "what you intend to say next right
 * now"; it should not remain after refreshing the page or closing the tab, otherwise reopening
 * the editor would automatically send several stale messages.
 *
 * Two layers: withXxx below are pure functions that touch no global state (unit tests test them
 * directly); further below are module-level stores keyed by tab id and React hooks.
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
   * Queue pauses after the user clicks "Stop" (or a rollback interrupts the run): does not send
   * automatically when a round finishes, waiting for user to click "Continue". Automatically
   * cleared when the queue is emptied.
   */
  paused: boolean;
}

export const EMPTY_QUEUE: QueueState = Object.freeze({ items: Object.freeze([]) as unknown as QueuedItem[], paused: false });

/* ---------------- Pure function core ---------------- */

/** Append to the end of the queue */
export function withEnqueued(s: QueueState, item: QueuedItem): QueueState {
  return { ...s, items: [...s.items, item] };
}

/** Delete an item; clear pause when emptied */
export function withRemoved(s: QueueState, id: string): QueueState {
  if (!s.items.some((x) => x.id === id)) return s;
  const items = s.items.filter((x) => x.id !== id);
  return { items, paused: items.length ? s.paused : false };
}

/** Modify text / attachments of an item */
export function withUpdated(s: QueueState, id: string, patch: Partial<Pick<QueuedItem, "text" | "attachments">>): QueueState {
  if (!s.items.some((x) => x.id === id)) return s;
  return { ...s, items: s.items.map((x) => (x.id === id ? { ...x, ...patch } : x)) };
}

/** Dequeue head: returns [head, remaining queue]; empty queue returns [undefined, as is] */
export function withShifted(s: QueueState): [QueuedItem | undefined, QueueState] {
  if (!s.items.length) return [undefined, s];
  const [head, ...rest] = s.items;
  return [head, { items: rest, paused: rest.length ? s.paused : false }];
}

export function withPaused(s: QueueState, paused: boolean): QueueState {
  // An empty queue cannot be "paused"
  const next = paused && s.items.length > 0;
  return s.paused === next ? s : { ...s, paused: next };
}

/* ---------------- Store per tab ---------------- */

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

/** Delete an item and return the deleted item (or undefined if not found) */
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

/** Notifies whenever any tab queue changes; useSyncExternalStore determines if its own tab changed by snapshot reference */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useQueue(tabId: string): QueueState {
  return useSyncExternalStore(subscribe, () => getQueueState(tabId), () => getQueueState(tabId));
}

/** For testing only */
export function _resetQueues(): void {
  queues.clear();
  counter = 0;
}
