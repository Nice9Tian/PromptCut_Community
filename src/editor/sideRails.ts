import { useSyncExternalStore } from "react";
import { getLocale, type Locale } from "../i18n/index.ts";

/**
 * Whether the drawer / panel beside the left and right vertical rails is collapsed.
 * Editor.tsx uses it to compute the column widths on both sides; clicking an already selected item
 * on a rail toggles it, and to pull a panel out from outside, set it to false directly.
 */
export type RailSide = "left" | "right";

/** Rail width (px) per UI language, kept in lockstep with --ui-rail-w in skins.ts and studio.css */
export function railWidthFor(locale: Locale): number {
  if (locale === "ja") return 88;
  if (locale === "en") return 80;
  return 64;
}

/** Width of the rail itself (px), corresponds to --ui-rail-w in studio.css */
export const RAIL_W = railWidthFor(getLocale());

const keyOf = (side: RailSide) => `pc.rail.${side}.collapsed`;

/** Read the initial collapsed state from localStorage (with exception guard) */
function readInitial(side: RailSide): boolean {
  try {
    return localStorage.getItem(keyOf(side)) === "1";
  } catch {}
  return false;
}

const collapsed: Record<RailSide, boolean> = { left: readInitial("left"), right: readInitial("right") };
const listeners = new Set<() => void>();

/** Whether it is currently collapsed */
export function isRailCollapsed(side: RailSide): boolean {
  return collapsed[side];
}

/** Set the collapsed state and persist it to localStorage */
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

/** Collapsed ↔ expanded */
export function toggleRailCollapsed(side: RailSide): void {
  setRailCollapsed(side, !collapsed[side]);
}

/** Subscribe to collapsed-state changes on either side */
export function subscribeRails(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React hook: whether one side is collapsed */
export function useRailCollapsed(side: RailSide): boolean {
  return useSyncExternalStore(subscribeRails, () => collapsed[side], () => false);
}
