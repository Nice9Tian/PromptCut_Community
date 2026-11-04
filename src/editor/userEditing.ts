/**
 * Wiring for "user is editing" (plan docs/plan/agent-workflow-plan.md A2): collects the editing
 * state from all over the editor (the aggregation and throttling logic is in
 * ./userEditingCore.ts) and pushes it to the editor process's POST /api/agent/editing;
 * when the Agent reads or writes these clips, the server marks "user is editing" in the tool
 * result (server/agent/user-editing.mjs).
 *
 * How each place reports:
 *   - Dragging, text editing: the component calls useUserEditing(slot, clipId | null, kind),
 *     passing the clip id when the drag / edit starts and null when it ends;
 *   - "Touched after selecting": this listens to the store's selection and this page's own
 *     changes (onLocalCommit); if a selected clip is modified, a note is made.
 *     Changes made while a tool that the Agent had the page run (src/ai/mcpExecutor.ts) is
 *     executing do not count as the user touching it (beginAgentTool / endAgentTool).
 */
import { useEffect } from "react";
import { getState, subscribe, onLocalCommit } from "../store/project";
import type { Project } from "../kernel/project";
import { createEditingTracker, type EditingEntity } from "./userEditingCore";
import { publishEditing } from "./sync/presence";

/** Session id of this page (the server replaces the state reported by this page wholesale by it) */
const session = `ue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Compile-time constant of the online build; for how it is written and why, see "Online build pruning" in `src/online/pageFlag.ts` */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/**
 * The online page has no editor process (C10a contract section 2), hence no local Agent to hint
 * to: do not send, and in the online build this /api path is pruned together with it.
 * Desktop / local: do not wait for the response, do not read the body: it is only a hint, and
 * if it arrives a beat late, the hint is merely missed once.
 */
const sendLocal: (entities: EditingEntity[]) => void = ONLINE_BUILD ? () => {} : (entities) => {
  try {
    void fetch("/api/agent/editing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, entities }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* If it cannot be sent, wait for the next time */ }
};

/**
 * Also publish a copy through this page's document service connection (A3 phase two,
 * src/editor/sync/presence.ts): based on it, the editor processes of other members of a shared
 * project hint their Agents "User <member> is editing". The online page takes this path too (it
 * has no editor process, only a document service connection).
 */
const send = (entities: EditingEntity[]) => {
  sendLocal(entities);
  try { publishEditing(session, entities); } catch { /* Presence state is incidental */ }
};

const tracker = createEditingTracker({ send });

/** A tool that the Agent had the page run is executing (may be nested): during this time this
 *  page's changes do not count as the user touching it */
let agentToolDepth = 0;
export function beginAgentTool() { agentToolDepth += 1; }
export function endAgentTool() { agentToolDepth = Math.max(0, agentToolDepth - 1); }
/** Whether any tool that the Agent had the page run is currently executing (saving has to wait
 *  for it to finish writing, `io/localWrites.ts`) */
export function agentToolRunning(): boolean { return agentToolDepth > 0; }

/** Between two projects, which of these clips changed objects (immutable updates: a modified
 *  clip is always a new object) */
function changedClips(prev: Project, next: Project, ids: readonly string[]): string[] {
  if (!ids.length) return [];
  const find = (p: Project, id: string) => {
    for (const t of p.tracks) for (const c of t.clips) if (c.id === id) return c;
    return undefined;
  };
  return ids.filter((id) => {
    const a = find(prev, id);
    const b = find(next, id);
    return !!b && a !== b;
  });
}

let started = 0;
let offs: Array<() => void> = [];

/** Start pushing when the editor mounts (src/editor/right/index.tsx, at the same moment as the
 *  Agent's tool channel); returns a stop function */
export function startUserEditing(): () => void {
  started += 1;
  if (started === 1) {
    tracker.setSelection(getState().selection);
    let lastSel = getState().selection;
    offs = [
      subscribe(() => {
        const sel = getState().selection;
        if (sel !== lastSel) { lastSel = sel; tracker.setSelection(sel); }
      }),
      onLocalCommit((prev, next) => {
        if (agentToolDepth > 0) return;
        const ids = changedClips(prev, next, getState().selection);
        if (ids.length) tracker.touch(ids);
      }),
    ];
    tracker.setEnabled(true);
  }
  return () => {
    started = Math.max(0, started - 1);
    if (started > 0) return;
    for (const off of offs) off();
    offs = [];
    tracker.setEnabled(false);
  };
}

/**
 * A component reports "which clip is being dragged / text-edited at this position". slot is
 * unique across the whole page (include the clip id when the same component has several
 * instances). Removed when clipId is null or the component unmounts.
 */
export function useUserEditing(slot: string, clipId: string | null | undefined, kind: "drag" | "text") {
  useEffect(() => {
    tracker.setActive(slot, clipId || null, kind);
    return () => tracker.setActive(slot, null, kind);
  }, [slot, clipId, kind]);
}

/** For tests and diagnostics: the state that would be reported right now */
export function userEditingSnapshot(): EditingEntity[] {
  return tracker.snapshot();
}
