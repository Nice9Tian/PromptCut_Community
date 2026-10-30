/**
 * 撤销 / 重做的快捷键判定(c65-undo-draft.md 第 1 节):Ctrl/Cmd+Z 撤销;Ctrl/Cmd+Shift+Z 与 Ctrl/Cmd+Y 重做;
 * 焦点在输入框、文本框、可编辑元素里时不算(交给输入框自己)。纯函数,`Editor.tsx` 的 keydown 用它,单测直接驱动。
 */
export type UndoRedo = "undo" | "redo";

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target?: unknown;
}

/** 焦点是不是在输入的地方 */
export function isTypingTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}

export function undoRedoKey(e: KeyLike): UndoRedo | null {
  if (!(e.ctrlKey || e.metaKey) || isTypingTarget(e.target)) return null;
  // 按着 Shift 时 e.key 是大写的 "Z",所以按小写比
  const k = (e.key ?? "").toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && !e.shiftKey) return "redo";
  return null;
}
