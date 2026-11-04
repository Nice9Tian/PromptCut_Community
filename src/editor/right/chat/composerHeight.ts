import { useSyncExternalStore } from "react";

/**
 * Height of the input area (Composer), a module-level store shared by all assistant tabs.
 *
 * The default (null) follows how .ai-composer is written in chat.css and takes one third of the panel height; once the user drags the top-right drag handle,
 * it is recorded as a pixel value and every tab's input box follows: this is "how tall this person likes the input box", not a property of a given chat,
 * for the same reason as viewPrefs.ts. During a drag only memory changes, and localStorage is written on release; double-clicking the handle returns to the default.
 */

const KEY = "pc.ai.composerH";
/** Same as the min-height of .ai-composer in chat.css */
export const COMPOSER_MIN_H = 140;
/** Maximum ratio of the panel height: the panel is measured at the start of the drag, and the height is clamped by it */
export const COMPOSER_MAX_RATIO = 0.7;
/** The message area keeps at least this height (same as the min-height of .ai-messages in chat.css): however tall the input box gets, it must not squeeze it out */
export const MESSAGES_MIN_H = 80;

function readInitial(): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= COMPOSER_MIN_H ? Math.round(n) : null;
  } catch {
    return null;
  }
}

let current: number | null = readInitial();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function getComposerHeight(): number | null {
  return current;
}

/** Called every frame during a drag: only changes memory and notifies the tabs, does not persist */
export function setComposerHeight(px: number): void {
  const next = Math.max(COMPOSER_MIN_H, Math.round(px));
  if (next === current) return;
  current = next;
  emit();
}

/** Called on release: writes the current height into localStorage (deletes the key if null) */
export function persistComposerHeight(): void {
  try {
    if (current === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(current));
  } catch {
    /* Even if it cannot be stored, make it take effect for this session */
  }
}

/** Double-click the handle: back to the default one third */
export function resetComposerHeight(): void {
  const changed = current !== null;
  current = null;
  persistComposerHeight();
  if (changed) emit();
}

export function subscribeComposerHeight(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useComposerHeight(): number | null {
  return useSyncExternalStore(subscribeComposerHeight, getComposerHeight, getComposerHeight);
}
