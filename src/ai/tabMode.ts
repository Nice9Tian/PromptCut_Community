/**
 * Which tab of the desktop app's AI panel has selected "Cloud" (contract 9.5): recorded only on
 * this tab, in memory only.
 * "Cloud" is never selected automatically and is not recorded as a global default; after a page
 * refresh or an app restart each tab returns to the local connection type, and cloud chats are
 * found again in the "Cloud" group of the history list (contract 7.4).
 *
 * (Originally in `src/ai/cloud/tabMode.ts`, moved up to the public side `src/ai/tabMode.ts`)
 */
import { useSyncExternalStore } from "react";

export interface CloudTabMode {
  selected: boolean;
  /** A cloud chat entered from the history list; used once after entering the cloud tab */
  conversationId: string | null;
}

const OFF: CloudTabMode = Object.freeze({ selected: false, conversationId: null });
const modes = new Map<string, CloudTabMode>();
const listeners = new Set<() => void>();

const emit = () => { for (const l of [...listeners]) l(); };

export function selectCloudTab(tabId: string, conversationId: string | null = null): void {
  modes.set(tabId, { selected: true, conversationId });
  emit();
}

export function leaveCloudTab(tabId: string): void {
  if (!modes.delete(tabId)) return;
  emit();
}

export function getCloudTab(tabId: string): CloudTabMode {
  return modes.get(tabId) ?? OFF;
}

export function useCloudTab(tabId: string): CloudTabMode {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => getCloudTab(tabId),
    () => OFF,
  );
}
