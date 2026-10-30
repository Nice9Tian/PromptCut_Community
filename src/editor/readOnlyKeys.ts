/**
 * 只读项目里的快捷键闸（`readOnly.ts`）：Delete / Backspace 删选中的片段、Ctrl+Z / Ctrl+Y 撤销重做，都会改项目。
 * 这几个键由 `src/Editor.tsx` 在 window 的冒泡阶段接（判据：焦点不在输入框里），那个文件不归这一块管，
 * 所以在 window 的**捕获阶段**先拦：只读时这几个键到不了它。空格（播放 / 暂停）、方向键这类不改项目的键不拦。
 *
 * 跟 `saveLock.ts` 同一个做法：模块载入就挂（越早越排在同一站的其它监听前面），没锁时什么都不做。
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

/** 这一下按键是不是「改项目的快捷键」（只看键，不看锁） */
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

/** 在 window 的捕获阶段挂上（幂等） */
export function installReadOnlyKeyGuard(target: EventTarget | undefined = (globalThis as { window?: EventTarget }).window): void {
  if (!target || guarded.has(target)) return;
  guarded.add(target);
  target.addEventListener("keydown", swallow as EventListener, { capture: true });
}

installReadOnlyKeyGuard();
