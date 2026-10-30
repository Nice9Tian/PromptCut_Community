import { useSyncExternalStore } from "react";

/**
 * 输入区(Composer)的高度,模块级 store,所有助手分页共用一份。
 *
 * 默认(null)照 chat.css 里 .ai-composer 的写法占面板高度的三分之一;用户拖过右上角的拖柄之后
 * 记成像素值,每一页的输入框都跟着变 —— 这是「这个人习惯多高的输入框」,不是某一段对话的属性,
 * 理由同 viewPrefs.ts。拖动过程中只改内存,松手才写 localStorage;双击拖柄回到默认。
 */

const KEY = "pc.ai.composerH";
/** 和 chat.css 里 .ai-composer 的 min-height 一致 */
export const COMPOSER_MIN_H = 140;
/** 最高占面板高度的比例:拖动开始那一刻量面板,按它夹住 */
export const COMPOSER_MAX_RATIO = 0.7;
/** 消息区至少留这么高(和 chat.css 里 .ai-messages 的 min-height 一致):输入框再高也不能把它挤没 */
export const MESSAGES_MIN_H = 80;

function readInitial(): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= COMPOSER_MIN_H ? Math.round(n) : null;
  } catch {
    return null;
  }
}

let current: number | null = readInitial();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function getComposerHeight(): number | null {
  return current;
}

/** 拖动中逐帧调:只改内存并通知各分页,不落盘 */
export function setComposerHeight(px: number): void {
  const next = Math.max(COMPOSER_MIN_H, Math.round(px));
  if (next === current) return;
  current = next;
  emit();
}

/** 松手时调:把此刻的高度写进 localStorage(null 就删掉键) */
export function persistComposerHeight(): void {
  try {
    if (current === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(current));
  } catch {
    /* 存不下也让本次会话生效 */
  }
}

/** 双击拖柄:回到默认的三分之一 */
export function resetComposerHeight(): void {
  const changed = current !== null;
  current = null;
  persistComposerHeight();
  if (changed) emit();
}

export function subscribeComposerHeight(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useComposerHeight(): number | null {
  return useSyncExternalStore(subscribeComposerHeight, getComposerHeight, getComposerHeight);
}
