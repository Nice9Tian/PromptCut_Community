import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useAgentTabs } from "../../ai/agentTabs";
import { getChatStore } from "../../ai/liveChat";
import type { ChatMessage } from "../../ai/types";
import { useRailCollapsed } from "../sideRails";
import { agentItem, effectiveActive, sideOf } from "./railLayout";
import { useRailLayout } from "./railStore";

/**
 * The "waiting for you to look" marker on an Agent item in the rail.
 *
 *   running                → flowing light on the avatar background (RailBar adds is-busy by tab.busy; not recorded here)
 *   finished               → blue dot (done), waiting for the user to open this page
 *   stopped / failed       → yellow dot (interrupted), likewise waiting for the user
 *
 * Only recorded if **the user is not looking at this page at that moment**: it counts as being looked at when this page is the selected item of its side's rail, that whole side is shown, and the panel is not collapsed.
 * Cleared when the user switches to this page (or expands the collapsed panel); also cleared when this page starts running again (only the flowing light shows while running).
 * Markers live only in memory and are not persisted: after a refresh nothing is "waiting for you".
 */
export type AgentAttention = "done" | "interrupted";

let marks: ReadonlyMap<string, AgentAttention> = new Map();
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setMark(tabId: string, value: AgentAttention | null): void {
  if ((marks.get(tabId) ?? null) === value) return;
  const next = new Map(marks);
  if (value) next.set(tabId, value);
  else next.delete(tabId);
  marks = next;
  for (const fn of listeners) fn();
}

/** Markers for all pages (the reference changes only when something changes; RailBar reads everything at once) */
export function useAgentAttentionMap(): ReadonlyMap<string, AgentAttention> {
  return useSyncExternalStore(subscribe, () => marks, () => marks);
}

/**
 * How a turn ended: it counts as finished only when outcome is explicitly completed;
 * the user stopping it (aborted), an error, any other outcome, no outcome written, and a message still left pending (not running anymore, e.g. went back to the start page while it was running and was aborted on unmount) all count as interrupted
 */
export function attentionOf(last: Pick<ChatMessage, "outcome" | "error" | "pending"> | undefined): AgentAttention {
  if (!last) return "done";
  if (last.pending || last.error) return "interrupted";
  return last.outcome === "completed" ? "done" : "interrupted";
}

function lastAssistant(tabId: string): ChatMessage | undefined {
  const msgs = getChatStore(tabId).get();
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant") return msgs[i];
  return undefined;
}

/**
 * Watches busy changes on each page to set markers, and clears markers by "whether the user is looking". Draws nothing; mount one in DockPages.
 * Made a separate component: it subscribes to the collapsed state, so on change only it re-renders, not every page under DockPages.
 */
export function AgentAttentionTracker(): null {
  const { tabs } = useAgentTabs();
  const layout = useRailLayout();
  const leftCollapsed = useRailCollapsed("left");
  const rightCollapsed = useRailCollapsed("right");
  const wasBusy = useRef(new Map<string, boolean>());

  // layout effect: when switching to that page the marker is cleared before it is painted, so the dot does not flash
  useLayoutEffect(() => {
    const viewing = (tabId: string) => {
      const item = agentItem(tabId);
      const side = sideOf(layout, item);
      if (!side) return false;
      if (side === "left" ? leftCollapsed : rightCollapsed) return false;
      return effectiveActive(layout, side) === item;
    };

    for (const t of tabs) {
      const was = wasBusy.current.get(t.id) ?? false;
      wasBusy.current.set(t.id, t.busy);
      if (t.busy) {
        if (!was) setMark(t.id, null);
        continue;
      }
      if (was && !viewing(t.id)) setMark(t.id, attentionOf(lastAssistant(t.id)));
      else if (marks.has(t.id) && viewing(t.id)) setMark(t.id, null);
    }
    // closed pages
    for (const id of [...wasBusy.current.keys()]) {
      if (tabs.some((t) => t.id === id)) continue;
      wasBusy.current.delete(id);
      setMark(id, null);
    }
  });

  return null;
}
