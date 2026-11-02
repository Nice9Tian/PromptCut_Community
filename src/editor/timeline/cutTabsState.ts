import { useSyncExternalStore } from "react";

/**
 * "Which cuts are open" in the cut tab bar above the timeline (`workflow/editing.md` "Cut tabs").
 *
 * This is local UI state: it does not go into the project document and is not synced to other members
 * (`product/project-model.md` "Cut"; for how it is stored see `mechanism/project-model.md`): it is
 * stored per project id in the local storage of the browser / desktop app, and restored after a refresh
 * or reopening the project. Reads and writes are all wrapped in try/catch: in a private window or when
 * storage is disabled it stays in memory only, without affecting use.
 *
 * Rules (pure function `reconcileTabs`, unit test in cutTabsState.test.mjs):
 *   - The active cut is always among the tabs (when the Agent switches to it or undo switches back, the tab is added automatically);
 *   - Cuts that no longer exist (deleted, deleted by a collaborator, or a creation that was undone) are removed from the tabs automatically;
 *   - When none is left (new project, old storage), the only tab is the active one.
 * Tabs are closed only when the user clicks "×"; losing focus, clicking elsewhere or switching panels never touches them.
 */

const KEY = (projectId: string) => `pc.cutTabs.v1:${projectId}`;

/** Tab order read from storage, after aligning with the project */
export function reconcileTabs(stored: readonly string[] | null | undefined, cutIds: readonly string[], activeId: string | undefined): string[] {
  const exists = new Set(cutIds);
  const out: string[] = [];
  for (const id of stored ?? []) if (exists.has(id) && !out.includes(id)) out.push(id);
  if (activeId && exists.has(activeId) && !out.includes(activeId)) out.push(activeId);
  if (!out.length && cutIds.length) out.push(activeId && exists.has(activeId) ? activeId : cutIds[0]);
  return out;
}

/** Which cut to switch to after closing a tab (when the closed one is the active one): prefer the right neighbor, else the left neighbor; returns null if it cannot be closed (only one left) */
export function closeTab(tabs: readonly string[], id: string, activeId: string | undefined): { tabs: string[]; switchTo: string | null } | null {
  if (tabs.length <= 1 || !tabs.includes(id)) return null;
  const i = tabs.indexOf(id);
  const rest = tabs.filter((x) => x !== id);
  const switchTo = id === activeId ? rest[Math.min(i, rest.length - 1)] : null;
  return { tabs: rest, switchTo };
}

let memory = new Map<string, string[]>();
const listeners = new Set<() => void>();
let version = 0;

function read(projectId: string): string[] | null {
  const hit = memory.get(projectId);
  if (hit) return hit;
  try {
    const raw = globalThis.localStorage?.getItem(KEY(projectId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      memory.set(projectId, parsed);
      return parsed;
    }
  } catch { /* Storage unavailable: stay in memory only */ }
  return null;
}

function write(projectId: string, tabs: string[]): void {
  const prev = memory.get(projectId);
  if (prev && prev.length === tabs.length && prev.every((x, i) => x === tabs[i])) return;
  memory.set(projectId, tabs);
  version++;
  try { globalThis.localStorage?.setItem(KEY(projectId), JSON.stringify(tabs)); } catch { /* Same as above */ }
  for (const l of [...listeners]) l();
}

/** Tabs of the current project (already aligned with the project) */
export function openTabs(projectId: string, cutIds: readonly string[], activeId: string | undefined): string[] {
  return reconcileTabs(read(projectId), cutIds, activeId);
}

/** Write the aligned result back (called after the component renders; only writes if different from what is stored) */
export function saveTabs(projectId: string, tabs: string[]): void {
  write(projectId, tabs);
}

/** Open the tab of a cut (does not switch; switching is the store's switchCut) */
export function openTab(projectId: string, cutIds: readonly string[], activeId: string | undefined, id: string): void {
  const tabs = openTabs(projectId, cutIds, activeId);
  if (!tabs.includes(id)) write(projectId, [...tabs, id]);
}

export function setTabs(projectId: string, tabs: string[]): void {
  write(projectId, tabs);
}

/** For tests */
export function resetCutTabsMemory(): void {
  memory = new Map();
  version++;
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

/** Subscribe in a component to "tabs changed" */
export function useCutTabsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}
