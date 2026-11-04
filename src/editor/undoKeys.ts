/**
 * Shortcut detection for undo / redo (c65-undo-draft.md section 1): Ctrl/Cmd+Z undoes;
 * Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo; it does not count when focus is in an input, a text area
 * or an editable element (left to the input itself). Pure function, used by the keydown handler
 * in `Editor.tsx`, and driven directly by unit tests.
 */
export type UndoRedo = "undo" | "redo";

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target?: unknown;
}

/** Whether focus is in a place where text is typed */
export function isTypingTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}

export function undoRedoKey(e: KeyLike): UndoRedo | null {
  if (!(e.ctrlKey || e.metaKey) || isTypingTarget(e.target)) return null;
  // While Shift is held, e.key is an uppercase "Z", so compare in lowercase
  const k = (e.key ?? "").toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && !e.shiftKey) return "redo";
  return null;
}
