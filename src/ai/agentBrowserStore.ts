/**
 * State of the "Agent browser" tab and panel (desktop shell mode).
 *
 * When an agent encounters login/captcha and calls web_handoff, Node only returns a shell flag in shell mode;
 * here we **do not interrupt the user with popups**, but only light up pending: the "Browser" tab in the top bar starts blinking and pops up
 * a "Pending action" bubble, letting the user decide when to click over. Only after clicking is the sub-webview placed into the panel.
 *
 * Placed at module level like collectLoginStore: there is no component context inside the executor (mcpExecutor).
 */
import { useSyncExternalStore } from "react";

export interface AgentBrowserState {
  /** Whether the agent webview exists in the shell (not present when running npm run dev in a browser; the tab is completely hidden) */
  available: boolean;
  /** Panel is open (sub-webview placed over the editing area) */
  open: boolean;
  /** Agent is waiting for user: blinking tab + bubble */
  pending: boolean;
  /** Reason displayed to the user, for example "Bilibili QR code login" */
  reason: string;
  /** Sequence number of panel openings, incremented on each open, used by components to reset internal state */
  seq: number;
}

let state: AgentBrowserState = { available: false, open: false, pending: false, reason: "", seq: 0 };
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const set = (patch: Partial<AgentBrowserState>) => { state = { ...state, ...patch }; emit(); };

export function setAgentBrowserAvailable(available: boolean): void {
  if (state.available !== available) set({ available });
}

/** Agent hands the browser to the user: lights up the tab without opening the panel. If the panel is already open, only updates the reason */
export function requestAgentBrowser(reason = ""): void {
  set({ reason, pending: !state.open });
}

/** User clicked the tab (or requested to view directly from elsewhere): opens the panel and clears pending */
export function openAgentBrowser(reason?: string): void {
  set({ open: true, pending: false, reason: reason ?? state.reason, seq: state.seq + 1 });
}

export function closeAgentBrowser(): void {
  if (!state.open && !state.pending) return;
  set({ open: false, pending: false });
}

export function toggleAgentBrowser(): void {
  if (state.open) closeAgentBrowser();
  else openAgentBrowser();
}

export function getAgentBrowserState(): AgentBrowserState {
  return state;
}

export function useAgentBrowserState(): AgentBrowserState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => state,
    () => state,
  );
}
