import { useSyncExternalStore } from "react";

/**
 * Display preferences of the AI panel, a module-level store.
 *
 * Previously each AiPanel kept its own useState copy; with several tabs open, toggling "Detailed" in
 * one page left the others unchanged until a refresh. These two are "how this person likes to view
 * things", not properties of "this chat", so all tabs share this one copy; the top bar's "Thinking"
 * button and the "Detailed mode" switch in AI settings both change it.
 *
 * The localStorage keys aiViewMode / aiShowThinking must not be changed: aiSessionKeys.test.mjs and
 * envReport.test.mjs pin them, and the diagnostic report also reads these two names.
 */

/** Display mode: concise shows only replies, detailed shows every tool call too */
const VIEW_KEY = "aiViewMode";
/** "Show thinking" is a long-term preference, stored locally; off by default: thinking is process, not conclusion */
const THINKING_KEY = "aiShowThinking";

export type ViewMode = "simple" | "verbose";

let currentView: ViewMode = (() => {
  try {
    return localStorage.getItem(VIEW_KEY) === "verbose" ? "verbose" : "simple";
  } catch {
    return "simple";
  }
})();

let currentShowThinking = (() => {
  try {
    return localStorage.getItem(THINKING_KEY) === "1";
  } catch {
    return false;
  }
})();

let snapshot = { view: currentView, showThinking: currentShowThinking };
const listeners = new Set<() => void>();

function emit() {
  snapshot = { view: currentView, showThinking: currentShowThinking };
  listeners.forEach((l) => l());
}

export function subscribeViewPrefs(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot() {
  return snapshot;
}

export function useViewPrefs() {
  return useSyncExternalStore(subscribeViewPrefs, getSnapshot);
}

export function setViewMode(next: ViewMode) {
  if (currentView === next) return;
  currentView = next;
  try {
    localStorage.setItem(VIEW_KEY, next);
  } catch {
    /* Cannot write in private mode, ignore */
  }
  emit();
}

export function setShowThinking(next: boolean) {
  if (currentShowThinking === next) return;
  currentShowThinking = next;
  try {
    localStorage.setItem(THINKING_KEY, next ? "1" : "0");
  } catch {
    /* Cannot write in private mode, ignore */
  }
  emit();
}

