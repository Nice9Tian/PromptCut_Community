/**
 * The shortcut gate for read-only projects (`readOnly.ts`): Delete / Backspace deleting the selected clip and
 * Ctrl+Z / Ctrl+Y undo and redo all modify the project.
 * These keys are handled by `src/Editor.tsx` in the window's bubble phase (criterion: focus is not in an input),
 * and that file is not owned by this part,
 * so they are intercepted first in the window's **capture phase**: when read-only, these keys never reach it. Keys
 * that do not modify the project, such as Space (play / pause) and the arrow keys, are not intercepted.
 *
 * Same approach as `saveLock.ts`: it is attached as soon as the module loads (the earlier, the further ahead of
 * other listeners on the same target), and does nothing when not locked.
 */
import { isTypingTarget, undoRedoKey } from "./undoKeys";
import { memberReadOnlyNow } from "./readOnlyCore";

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target?: unknown;
}

/** Whether this key press is a "project-modifying shortcut" (looks only at the key, not at the lock) */
export function isProjectEditKey(e: KeyLike): boolean {
  if (isTypingTarget(e.target)) return false;
  if (undoRedoKey(e)) return true;
  return e.key === "Delete" || e.key === "Backspace";
}

function swallow(e: KeyboardEvent) {
  if (!memberReadOnlyNow() || !isProjectEditKey(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

const guarded = new WeakSet<object>();

/** Attach in the window's capture phase (idempotent) */
export function installReadOnlyKeyGuard(target: EventTarget | undefined = (globalThis as { window?: EventTarget }).window): void {
  if (!target || guarded.has(target)) return;
  guarded.add(target);
  target.addEventListener("keydown", swallow as EventListener, { capture: true });
}

installReadOnlyKeyGuard();
