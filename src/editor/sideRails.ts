import { useSyncExternalStore } from "react";

/**
 * 左右两条竖向 rail 旁边的抽屉 / 面板是否收起。
 * Editor.tsx 按它算两侧列宽;rail 上点已选中的项时切换,外部要把面板拉出来时直接设 false。
 */
export type RailSide = "left" | "right";

/** rail 本身的宽度(px),和 studio.css 里的 --ui-rail-w 对应 */
export const RAIL_W = 64;

const keyOf = (side: RailSide) => `pc.rail.${side}.collapsed`;

/** 从 localStorage 读取初始收起状态(带异常保护) */
function readInitial(side: RailSide): boolean {
  try {
    return localStorage.getItem(keyOf(side)) === "1";
  } catch {}
  return false;
}

const collapsed: Record<RailSide, boolean> = { left: readInitial("left"), right: readInitial("right") };
const listeners = new Set<() => void>();

/** 当前是否收起 */
export function isRailCollapsed(side: RailSide): boolean {
  return collapsed[side];
}

/** 设置收起状态并持久化至 localStorage */
export function setRailCollapsed(side: RailSide, value: boolean): void {
  if (collapsed[side] === value) return;
  collapsed[side] = value;
  try {
    localStorage.setItem(keyOf(side), value ? "1" : "0");
  } catch {}
  for (const listener of listeners) {
    listener();
  }
}

/** 收起 ↔ 展开 */
export function toggleRailCollapsed(side: RailSide): void {
  setRailCollapsed(side, !collapsed[side]);
}

/** 订阅任一侧的收起状态变化 */
export function subscribeRails(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React hook:某一侧是否收起 */
export function useRailCollapsed(side: RailSide): boolean {
  return useSyncExternalStore(subscribeRails, () => collapsed[side], () => false);
}
