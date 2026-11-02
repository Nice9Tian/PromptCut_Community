/**
 * Toggle for the "Site login" dialog.
 *
 * The dialog opens from two places: the "Media collection" card on the start page (clicked by the
 * user), and the MCP tool collect_login (called by the agent). The latter runs in the executor in
 * index.tsx and cannot access any component's setState, so the toggle is placed at the module level
 * and components subscribe via useSyncExternalStore.
 */
import { useSyncExternalStore } from "react";

export type LoginMethod = "qr" | "browser";

export interface CollectLoginState {
  open: boolean;
  site: string;
  method: LoginMethod;
  /** Open sequence number, incremented on each open; components use it to reset internal state */
  seq: number;
}

let state: CollectLoginState = { open: false, site: "bilibili", method: "qr", seq: 0 };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openCollectLogin(site = "bilibili", method: LoginMethod = "qr"): void {
  state = { open: true, site, method, seq: state.seq + 1 };
  emit();
}

export function closeCollectLogin(): void {
  if (!state.open) return;
  state = { ...state, open: false };
  emit();
}

export function getCollectLoginState(): CollectLoginState {
  return state;
}

export function useCollectLoginState(): CollectLoginState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => state,
    () => state,
  );
}
