import { useSyncExternalStore } from "react";
import { memberReadOnlyNow } from "./readOnlyCore";

/**
 * 左栏 → 时间轴的拖放载荷。
 *
 * HTML5 拖放在 dragover 阶段读不到 dataTransfer 的内容(只能读 types),
 * 但落点预览必须知道拖的是什么、多长。所以拖开始时在这里存一份载荷,
 * 时间轴 dragover 时直接读;dragend / drop 之后清掉。
 * dataTransfer 仍然照常写(见 docs/archive/EDITOR-DESIGN.md 的拖放契约),跨窗口拖进来时还能靠 types 判断种类。
 */

export const MIME_CARD = "application/x-promptcut-card";
export const MIME_MEDIA = "application/x-promptcut-media";
export const MIME_TRANSITION = "application/x-promptcut-transition";
export const MIME_EMPHASIS = "application/x-promptcut-emphasis";
/** 素材库「剪辑」组里拖出来的一条剪辑:落到序列上就是一个引用它的剪辑段(kernel/cutSegments.ts) */
export const MIME_CUT = "application/x-promptcut-cut";

export type DragPayload =
  | { kind: "card"; cardId: string; name: string; duration: number; params?: Record<string, unknown> }
  | { kind: "media"; mediaId: string; name: string; duration: number }
  /** 剪辑:落在激活剪辑的序列上就放一个引用它的剪辑段;放进自己或会循环引用时不接受并说明原因 */
  | { kind: "cut"; cutId: string; name: string; duration: number }
  /** 转场:拖到两段的接缝上是交叉溶解,拖到一段的头 / 尾是淡入 / 淡出(见 kernel/transitions.ts) */
  | { kind: "transition"; transition: "crossfade" | "fadeIn" | "fadeOut"; name: string; duration: number }
  /** 强调:拖到哪一段上就给哪一段加阴影 / 描边(见 kernel/emphasis.ts) */
  | { kind: "emphasis"; emphasis: { kind: "shadow" | "outline"; color?: string; size?: number; opacity?: number; dx?: number; dy?: number }; name: string; duration: number };

let payload: DragPayload | null = null;
const subs = new Set<() => void>();

function emit() {
  for (const f of subs) f();
}

export function setDragPayload(p: DragPayload) {
  // 只读项目(游客)里拖出来的东西落不下去:不记载荷,时间轴就不会摆出落点预览和「新建序列」的落区
  if (memberReadOnlyNow()) return;
  payload = p;
  emit();
  // dragend 不一定落在源元素上(拖出窗口、拖到别的应用都可能丢),这里兜底清一次。
  // 注意用冒泡阶段:捕获阶段会赶在时间轴的 drop 之前把载荷清掉。
  window.addEventListener("dragend", clearDragPayload, { once: true });
  window.addEventListener("drop", clearDragPayload, { once: true });
}

export function clearDragPayload() {
  if (!payload) return;
  payload = null;
  emit();
}

export function getDragPayload(): DragPayload | null {
  return payload;
}

/** dataTransfer.types 里有没有我们认识的载荷(跨窗口拖进来时只能靠它) */
export function hasDragType(types: readonly string[] | DOMStringList): boolean {
  const list = Array.from(types as ArrayLike<string>);
  return list.includes(MIME_CARD) || list.includes(MIME_MEDIA) || list.includes(MIME_TRANSITION) || list.includes(MIME_EMPHASIS) || list.includes(MIME_CUT);
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

/** 组件里读「现在正拖着什么」(没在拖 = null) */
export function useDragPayload(): DragPayload | null {
  return useSyncExternalStore(subscribe, () => payload, () => payload);
}
