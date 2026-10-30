import { useSyncExternalStore } from "react";

/**
 * AI 面板的显示偏好,模块级 store。
 *
 * 以前是每个 AiPanel 各自 useState 一份,多开几个分页之后,在一页里切了「详细」,
 * 别的页还是老样子,要到刷新才对齐。这两样是「这个人喜欢怎么看」,不是「这段对话」的属性,
 * 所以所有分页共用这一份;顶栏的「思考」按钮和 AI 设置里的「详细模式」开关改的都是它。
 *
 * localStorage 键名 aiViewMode / aiShowThinking 不能改:aiSessionKeys.test.mjs、
 * envReport.test.mjs 钉着它们,诊断报告也按这两个名字读。
 */

/** 显示模式:简洁只看回复,详细连每一步工具调用一起看 */
const VIEW_KEY = "aiViewMode";
/** 「显示思考」是长期偏好,记在本地;默认关——思考是过程,不是结论 */
const THINKING_KEY = "aiShowThinking";

export type ViewMode = "simple" | "verbose";

let currentView: ViewMode = (() => {
  try {
    return localStorage.getItem(VIEW_KEY) === "verbose" ? "verbose" : "simple";
  } catch {
    return "simple";
  }
})();

let currentShowThinking = (() => {
  try {
    return localStorage.getItem(THINKING_KEY) === "1";
  } catch {
    return false;
  }
})();

let snapshot = { view: currentView, showThinking: currentShowThinking };
const listeners = new Set<() => void>();

function emit() {
  snapshot = { view: currentView, showThinking: currentShowThinking };
  listeners.forEach((l) => l());
}

export function subscribeViewPrefs(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot() {
  return snapshot;
}

export function useViewPrefs() {
  return useSyncExternalStore(subscribeViewPrefs, getSnapshot);
}

export function setViewMode(next: ViewMode) {
  if (currentView === next) return;
  currentView = next;
  try {
    localStorage.setItem(VIEW_KEY, next);
  } catch {
    /* 隐私模式下写不了,忽略 */
  }
  emit();
}

export function setShowThinking(next: boolean) {
  if (currentShowThinking === next) return;
  currentShowThinking = next;
  try {
    localStorage.setItem(THINKING_KEY, next ? "1" : "0");
  } catch {
    /* 隐私模式下写不了,忽略 */
  }
  emit();
}

