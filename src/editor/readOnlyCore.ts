/**
 * 只读（`readOnly.ts`）里不依赖 React、不依赖同步管理的那一半：只看 `io/viewOnly.ts`。
 * 处理函数、快捷键闸、拖放、导入这类不在组件里的地方从这里取，不把整个同步管理拖进来（单测也好 mock）。
 */
import { viewOnlyReason, viewOnlyText } from "./io/viewOnly";

/** 此刻这个项目是不是只给了只读权限（不含 `?observe`） */
export function memberReadOnlyNow(): boolean {
  return viewOnlyReason() === "read-only-member";
}

export interface ReadOnlyState {
  /** 这个项目只给了只读权限：会改项目的控件该置灰 */
  locked: boolean;
  /** 置灰时说的那一句（`viewOnlyText()`）；没锁时是空串 */
  why: string;
  /** 悬停说明：锁着就是 `why`，没锁就是控件自己原有的（可能没有） */
  title(own?: string): string | undefined;
}

export function readOnlyState(locked: boolean): ReadOnlyState {
  const why = locked ? viewOnlyText() : "";
  return { locked, why, title: (own) => (locked ? why : own) };
}

/**
 * 处理函数里的闸：锁着就回 true，调用方直接 return。
 * 界面上控件已经置灰，走到这里说明有一条没盖到的路（拖放、快捷键、别处派发的事件），在这里再拦一道。
 */
export function blockedByReadOnly(): boolean {
  return memberReadOnlyNow();
}
