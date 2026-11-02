/**
 * Aggregation and throttling of "user is editing" (plan docs/plan/agent-workflow-plan.md A2;
 * semantics: user-workflow.md "Protection").
 * Pure logic, does not touch the store, sends no requests: the wiring is in ./userEditing.ts,
 * and the tests are in ./userEditingCore.test.mjs.
 *
 * Criterion (plan section 4, item 1 [ruling]): a clip (a card is also a clip) counts as "being
 * edited" if and only if
 *   - it is being dragged (timeline drag / duration change, move on the stage, caption bar drag), or
 *   - its text is being edited (editing text on the stage, double-click to edit caption text), or
 *   - it is selected, and the user touched it while it was selected, less than 30 seconds after
 *     the last touch.
 * Selecting without touching does not count; after deselecting, the "touched" record is void.
 *
 * Push: push as soon as the state changes (the leading edge is sent immediately, then at most once
 * every 250 ms, and at the end of the window the latest copy is sent: no per-frame sends while
 * dragging); when non-empty, a heartbeat every 5 seconds, and if the server gets no renewal for
 * 15 seconds it assumes the page is gone; "just touched" entries carry the remaining
 * milliseconds and drop out automatically when due.
 */

export type EditingKind = "drag" | "text" | "recent";

export interface EditingEntity {
  clipId: string;
  kind: EditingKind;
  /** Only carried by recent: how many milliseconds remain until the 30-second expiry */
  remainingMs?: number;
}

export const USER_EDITING_TIMING = Object.freeze({
  /** Within how long after a touch while selected it counts as "being edited" */
  recentMs: 30_000,
  /** Minimum interval between two pushes */
  throttleMs: 250,
  /** How often to send a heartbeat when non-empty (the server's expiry time is 3 times this, see
   *  ttlMs in server/agent/user-editing.mjs) */
  heartbeatMs: 5_000,
});

const RANK: Record<EditingKind, number> = { drag: 0, text: 1, recent: 2 };

export interface EditingTrackerOptions {
  send: (entities: EditingEntity[]) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  recentMs?: number;
  throttleMs?: number;
  heartbeatMs?: number;
}

export interface EditingTracker {
  /** A UI position (slot) starts / ends dragging or text-editing a clip; clipId null means the end */
  setActive(slot: string, clipId: string | null, kind: "drag" | "text"): void;
  /** Current selection (the first one is the primary selection) */
  setSelection(ids: readonly string[]): void;
  /** Clips touched by this user change (the caller has already excluded changes made by tools the
   *  Agent had the page run) */
  touch(ids: readonly string[]): void;
  /** The complete state right now */
  snapshot(): EditingEntity[];
  /** Send switch: while off, only record the state and do not send; when turned on, resend once
   *  immediately */
  setEnabled(on: boolean): void;
  dispose(): void;
}

export function createEditingTracker(o: EditingTrackerOptions): EditingTracker {
  const now = o.now ?? (() => Date.now());
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const recentMs = o.recentMs ?? USER_EDITING_TIMING.recentMs;
  const throttleMs = o.throttleMs ?? USER_EDITING_TIMING.throttleMs;
  const heartbeatMs = o.heartbeatMs ?? USER_EDITING_TIMING.heartbeatMs;

  /** slot → { clipId, kind } */
  const active = new Map<string, { clipId: string; kind: "drag" | "text" }>();
  let selection: string[] = [];
  /** clipId → time of the last touch (only recorded while selected) */
  const touched = new Map<string, number>();

  let enabled = false;
  let disposed = false;
  let lastKey = "[]";
  let lastSentAt = -Infinity;
  let timer: unknown = null;
  let timerAt = Infinity;

  function snapshot(): EditingEntity[] {
    const t = now();
    const byClip = new Map<string, EditingEntity>();
    for (const { clipId, kind } of active.values()) {
      const old = byClip.get(clipId);
      if (!old || RANK[kind] < RANK[old.kind]) byClip.set(clipId, { clipId, kind });
    }
    for (const id of selection) {
      const at = touched.get(id);
      if (at === undefined || byClip.has(id)) continue;
      const left = at + recentMs - t;
      if (left > 0) byClip.set(id, { clipId: id, kind: "recent", remainingMs: left });
    }
    return [...byClip.values()].sort((a, b) => (a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : 0));
  }

  /** Key for comparison: excludes the remaining milliseconds (they change every moment) */
  const keyOf = (list: EditingEntity[]) => JSON.stringify(list.map((e) => [e.clipId, e.kind]));

  function arm(at: number) {
    if (disposed) return;
    if (timer !== null && timerAt <= at) return;
    if (timer !== null) clearTimer(timer);
    timerAt = at;
    timer = setTimer(() => { timer = null; timerAt = Infinity; flush(); }, Math.max(0, at - now()));
  }

  /** The next time to wake up: the heartbeat, or the earliest-expiring "just touched" entry */
  function nextWake(list: EditingEntity[]): number {
    let at = Infinity;
    if (list.length) at = lastSentAt + heartbeatMs;
    for (const e of list) if (e.kind === "recent" && e.remainingMs !== undefined) at = Math.min(at, now() + e.remainingMs + 1);
    return at;
  }

  function flush() {
    if (disposed || !enabled) return;
    const t = now();
    const list = snapshot();
    const key = keyOf(list);
    const changed = key !== lastKey;
    const heartbeatDue = list.length > 0 && t - lastSentAt >= heartbeatMs;
    if (changed || heartbeatDue) {
      if (t - lastSentAt < throttleMs) { arm(lastSentAt + throttleMs); return; }
      lastKey = key;
      lastSentAt = t;
      try { o.send(list); } catch { /* If it cannot be sent, wait for the next time */ }
    }
    const wake = nextWake(list);
    if (wake < Infinity) arm(wake);
  }

  return {
    setActive(slot, clipId, kind) {
      if (clipId) {
        const cur = active.get(slot);
        if (cur && cur.clipId === clipId && cur.kind === kind) return;
        active.set(slot, { clipId, kind });
      } else if (!active.delete(slot)) return;
      flush();
    },
    setSelection(ids) {
      const next = ids.filter((x) => typeof x === "string");
      if (next.length === selection.length && next.every((x, i) => x === selection[i])) return;
      selection = next;
      // For a clip that is deselected, its "touched" record is void
      for (const id of [...touched.keys()]) if (!next.includes(id)) touched.delete(id);
      flush();
    },
    touch(ids) {
      const t = now();
      let any = false;
      for (const id of ids) {
        if (!selection.includes(id)) continue;
        touched.set(id, t);
        any = true;
      }
      if (any) flush();
    },
    snapshot,
    setEnabled(on) {
      enabled = on;
      if (on) { lastKey = "\u0000"; flush(); }
      else if (timer !== null) { clearTimer(timer); timer = null; timerAt = Infinity; }
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
