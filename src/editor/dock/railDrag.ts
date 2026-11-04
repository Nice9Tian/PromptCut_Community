import type { PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { prefersReducedMotion } from "../enterMotion";
import { isAgentItem, type ItemId, type Side } from "./railLayout";
import { moveRailItem } from "./railStore";

/**
 * Drag and drop of rail items. Done by hand with pointer events, not HTML5 drag (whose drag image ignores styles and which breaks when dragging over the preview iframe).
 *
 *   Press (left button / primary pointer) → record the start point, not yet a drag;
 *   Move distance exceeds DRAG_THRESHOLD_PX (4px, Euclidean distance) → drag starts: the button is cloned as a semi-transparent icon following the pointer (data-pc="rail-drag-ghost"),
 *     the item in its original place fades (data-pc-dragging), setPointerCapture on the button, so it does not break when sliding over the preview iframe;
 *   While dragging → whichever rail the pointer is over (8px wider on each side), the drop position is computed from the vertical midline of each item,
 *     a drop indicator line is drawn (data-pc="rail-drop-indicator", with data-pc-drop-side / data-pc-drop-index), and that rail gets data-pc-drop-target;
 *   Release → if over a rail, moveRailItem (drop position counted by drawn items, including the dragged item itself), and swallow the click that follows immediately; not over a rail = abandon;
 *   Esc / pointercancel / window blur → cancel, and the click is swallowed on release likewise.
 * Release without exceeding the threshold = a plain click, switching / collapsing as before.
 *
 * After the drop, the items on both rails do one FLIP transition (220ms, house curve; skipped when the system asks for reduced motion).
 */

export const DRAG_THRESHOLD_PX = 4;
/** How far to the left and right of a rail the pointer still counts as being on this rail */
const RAIL_SLOP_PX = 8;
const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

interface DropTarget {
  side: Side;
  gap: number;
}

interface Session {
  pointerId: number;
  item: ItemId;
  button: HTMLElement;
  /** The element cloned to follow the pointer: for a normal item it is the button itself, for a grouped item it is the whole group */
  grab: HTMLElement;
  slot: HTMLElement | null;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  dragging: boolean;
  canceled: boolean;
  ghost: HTMLElement | null;
  line: HTMLElement | null;
  target: DropTarget | null;
}

let session: Session | null = null;

/** onPointerDown of a rail item button */
export function beginRailPointer(e: ReactPointerEvent<HTMLElement>, item: ItemId): void {
  if (e.button !== 0 || !e.isPrimary) return;
  if (session) finish();
  const button = e.currentTarget;
  const slot = button.closest<HTMLElement>("[data-pc-dock-item]");
  // Grouped item (cut group): pressing any button in the group drags the whole group
  const grab = slot?.hasAttribute("data-pc-dock-group") ? slot : button;
  const rect = grab.getBoundingClientRect();
  session = {
    pointerId: e.pointerId,
    item,
    button,
    grab,
    slot,
    startX: e.clientX,
    startY: e.clientY,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    dragging: false,
    canceled: false,
    ghost: null,
    line: null,
    target: null,
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
}

function onMove(ev: PointerEvent) {
  const s = session;
  if (!s || ev.pointerId !== s.pointerId || s.canceled) return;
  if (!s.dragging) {
    if (Math.hypot(ev.clientX - s.startX, ev.clientY - s.startY) <= DRAG_THRESHOLD_PX) return;
    startDrag(s);
  }
  ev.preventDefault();
  placeGhost(s, ev.clientX, ev.clientY);
  updateTarget(s, ev.clientX, ev.clientY);
}

function onUp(ev: PointerEvent) {
  const s = session;
  if (!s || ev.pointerId !== s.pointerId) return;
  if (!s.dragging) {
    // Not dragged: a plain click, so the click reaches the button as usual
    finish();
    return;
  }
  swallowNextClick();
  if (!s.canceled) updateTarget(s, ev.clientX, ev.clientY);
  const target = s.canceled ? null : s.target;
  const ghostRect = s.ghost?.getBoundingClientRect() ?? null;
  finish();
  if (target) drop(s.item, target, ghostRect);
}

function onCancel(ev: PointerEvent) {
  if (!session || ev.pointerId !== session.pointerId) return;
  finish();
}

function onKey(ev: KeyboardEvent) {
  const s = session;
  if (ev.key !== "Escape" || !s?.dragging || s.canceled) return;
  ev.preventDefault();
  ev.stopPropagation();
  s.canceled = true;
  clearVisuals(s);
}

function onBlur() {
  finish();
}

function startDrag(s: Session) {
  s.dragging = true;
  const rect = s.grab.getBoundingClientRect();
  const ghost = s.grab.cloneNode(true) as HTMLElement;
  // The clone must never be found as a rail item again
  for (const el of [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>("*"))]) {
    for (const attr of ["id", "data-pc", "data-pc-rail", "data-pc-agent-tab", "data-pc-dock-item", "data-pc-dock-group", "data-pc-cut", "aria-pressed", "aria-expanded", "aria-current", "aria-selected"]) {
      el.removeAttribute(attr);
    }
  }
  ghost.classList.add("pc-dock-ghost");
  ghost.setAttribute("data-pc", "rail-drag-ghost");
  ghost.setAttribute("aria-hidden", "true");
  ghost.tabIndex = -1;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.appendChild(ghost);
  s.ghost = ghost;

  const line = document.createElement("div");
  line.className = "pc-dock-drop-line";
  line.setAttribute("data-pc", "rail-drop-indicator");
  line.setAttribute("aria-hidden", "true");
  line.hidden = true;
  document.body.appendChild(line);
  s.line = line;

  s.slot?.setAttribute("data-pc-dragging", "");
  document.body.dataset.pcRailDragging = "";
  try {
    s.button.setPointerCapture(s.pointerId);
  } catch {
    // The pointer is already gone (synthetic events etc.): dragging works without capture, but sliding into an iframe breaks it
  }
}

function placeGhost(s: Session, x: number, y: number) {
  if (s.ghost) s.ghost.style.transform = `translate3d(${Math.round(x - s.offsetX)}px, ${Math.round(y - s.offsetY)}px, 0)`;
}

function railAt(x: number, y: number): HTMLElement | null {
  for (const rail of Array.from(document.querySelectorAll<HTMLElement>("[data-pc-dock-rail]"))) {
    const r = rail.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (x >= r.left - RAIL_SLOP_PX && x <= r.right + RAIL_SLOP_PX && y >= r.top && y <= r.bottom) return rail;
  }
  return null;
}

function updateTarget(s: Session, x: number, y: number) {
  const rail = railAt(x, y);
  for (const el of Array.from(document.querySelectorAll("[data-pc-drop-target]"))) {
    if (el !== rail) el.removeAttribute("data-pc-drop-target");
  }
  if (!rail) {
    s.target = null;
    hideLine(s);
    return;
  }
  rail.setAttribute("data-pc-drop-target", "");
  const side = rail.dataset.pcDockRail === "left" ? "left" : "right";
  const list = rail.querySelector<HTMLElement>("[data-pc-dock-list]") ?? rail;
  const slots = Array.from(list.querySelectorAll<HTMLElement>("[data-pc-dock-item]"));
  // One side's rail has an upper and a lower half (head / tail of RailBar): the drop position of the lower half
  // must add the item count of the upper half
  const offset = Number(list.dataset.pcDockOffset) || 0;
  // Drop position = number of items whose midline is above the pointer
  let gap = 0;
  for (const slot of slots) {
    const r = slot.getBoundingClientRect();
    if (y < r.top + r.height / 2) break;
    gap++;
  }
  s.target = { side, gap: gap + offset };

  // The indicator line is drawn in the middle of the 4px gap between two items. When the item before the drop
  // position is the last Agent on this side (directly followed by "+"): if an Agent is being dragged, draw it
  // between the Agent and "+" (after the drop it sits above "+"); if anything else is dragged, draw it below "+"
  const listRect = list.getBoundingClientRect();
  let lineY: number;
  if (slots.length === 0) {
    lineY = listRect.top + 8;
  } else if (gap === 0) {
    lineY = slots[0].getBoundingClientRect().top - 2;
  } else {
    const prev = slots[gap - 1];
    const next = prev.nextElementSibling;
    const add = next instanceof HTMLElement && next.hasAttribute("data-pc-dock-add") ? next : null;
    lineY = (add && !isAgentItem(s.item) ? add : prev).getBoundingClientRect().bottom + 2;
  }
  lineY = Math.max(listRect.top + 1, Math.min(listRect.bottom - 1, lineY));
  showLine(s, rail.getBoundingClientRect(), lineY, side, gap + offset);
}

function showLine(s: Session, railRect: DOMRect, y: number, side: Side, gap: number) {
  const line = s.line;
  if (!line) return;
  const w = Math.max(24, railRect.width - 20);
  // Just appeared, or switched to another rail: snap into place, do not slide in from the previous position
  const jump = line.hidden || line.dataset.pcDropSide !== side;
  if (jump) line.style.transition = "none";
  line.hidden = false;
  line.style.width = `${w}px`;
  line.style.transform = `translate3d(${Math.round(railRect.left + (railRect.width - w) / 2)}px, ${Math.round(y - 1)}px, 0)`;
  line.dataset.pcDropSide = side;
  line.dataset.pcDropIndex = String(gap);
  if (jump) {
    void line.offsetWidth;
    line.style.transition = "";
  }
}

function hideLine(s: Session) {
  if (!s.line) return;
  s.line.hidden = true;
  delete s.line.dataset.pcDropSide;
  delete s.line.dataset.pcDropIndex;
}

function clearVisuals(s: Session) {
  s.ghost?.remove();
  s.ghost = null;
  s.line?.remove();
  s.line = null;
  s.target = null;
  s.slot?.removeAttribute("data-pc-dragging");
  delete document.body.dataset.pcRailDragging;
  for (const el of Array.from(document.querySelectorAll("[data-pc-drop-target]"))) el.removeAttribute("data-pc-drop-target");
}

function finish() {
  const s = session;
  if (!s) return;
  session = null;
  window.removeEventListener("pointermove", onMove, true);
  window.removeEventListener("pointerup", onUp, true);
  window.removeEventListener("pointercancel", onCancel, true);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", onBlur);
  clearVisuals(s);
  try {
    if (s.button.hasPointerCapture(s.pointerId)) s.button.releasePointerCapture(s.pointerId);
  } catch {
    // Already released
  }
}

/**
 * Right after a drag is released a click follows (landing on the button or one of its ancestors); if it is
 * not swallowed it is treated as "click the current item = collapse".
 * The browser dispatches that click while handling the same release, before any timer, so removing the
 * listener after 0ms is enough.
 */
function swallowNextClick() {
  const swallow = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

function railRects(): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-pc-dock-rail] [data-pc-dock-item], [data-pc-dock-rail] [data-pc-dock-add]"))) {
    rects.set(flipKey(el), el.getBoundingClientRect());
  }
  return rects;
}

function flipKey(el: HTMLElement): string {
  return el.dataset.pcDockItem ?? `+${el.dataset.pcDockAdd ?? ""}`;
}

function drop(item: ItemId, target: DropTarget, ghostRect: DOMRect | null) {
  const before = railRects();
  if (ghostRect) before.set(item, ghostRect);
  // Commit synchronously: the next step measures the position after the drop to do FLIP
  flushSync(() => moveRailItem(item, target.side, target.gap));
  if (prefersReducedMotion()) return;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-pc-dock-rail] [data-pc-dock-item], [data-pc-dock-rail] [data-pc-dock-add]"))) {
    const now = el.getBoundingClientRect();
    if (now.width === 0 && now.height === 0) continue;
    const old = before.get(flipKey(el));
    if (!old) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: EASE });
      continue;
    }
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }], { duration: 220, easing: EASE });
  }
}
