import type { PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { prefersReducedMotion } from "../enterMotion";
import { isAgentItem, type ItemId, type Side } from "./railLayout";
import { moveRailItem } from "./railStore";

/**
 * rail 项的拖放。用指针事件自己做,不用 HTML5 drag(那套拖影不跟样式、拖过预览 iframe 会断)。
 *
 *   按下(左键 / 主指针)→ 记下起点,还不算拖;
 *   移动距离超过 DRAG_THRESHOLD_PX(4px,欧氏距离)→ 开始拖:按钮克隆一份当跟手的半透明图标(data-pc="rail-drag-ghost"),
 *     原位那一项变淡(data-pc-dragging),对按钮 setPointerCapture,滑过预览 iframe 也不断;
 *   拖动中 → 指针落在哪条 rail 上(左右各放宽 8px),按各项的竖向中线算出落点,
 *     画一条落点指示线(data-pc="rail-drop-indicator",带 data-pc-drop-side / data-pc-drop-index),那条 rail 挂 data-pc-drop-target;
 *   松开 → 在 rail 上就 moveRailItem(落点按画出来的项数,含被拖项本身),吞掉紧跟着的那次 click;不在 rail 上 = 放弃;
 *   Esc / pointercancel / 窗口失焦 → 取消,松开时同样吞掉 click。
 * 没超过阈值就松开 = 普通点击,照旧切换 / 收起。
 *
 * 放下之后两条 rail 上的项做一次 FLIP 过渡(220ms,house 曲线;系统要求减少动效时不做)。
 */

export const DRAG_THRESHOLD_PX = 4;
/** 指针在 rail 左右多宽的范围里也算落在这条 rail 上 */
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
  /** 跟手克隆的元素:普通项是按钮本身,成组的项是整组 */
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

/** rail 项按钮的 onPointerDown */
export function beginRailPointer(e: ReactPointerEvent<HTMLElement>, item: ItemId): void {
  if (e.button !== 0 || !e.isPrimary) return;
  if (session) finish();
  const button = e.currentTarget;
  const slot = button.closest<HTMLElement>("[data-pc-dock-item]");
  // 成组的项(剪辑组):按住组里任何一个按钮,拖起来的是整组
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
    // 没拖起来:普通点击,click 照常到按钮上
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
  // 克隆出来的不许再被当成 rail 项找到
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
    // 指针已经不在了(合成事件等):没有捕获也能拖,只是滑进 iframe 会断
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
  // 一侧 rail 分上下两截(RailBar 的 head / tail):下面那截的落点要加上上面那截的项数
  const offset = Number(list.dataset.pcDockOffset) || 0;
  // 落点 = 中线在指针上方的项数
  let gap = 0;
  for (const slot of slots) {
    const r = slot.getBoundingClientRect();
    if (y < r.top + r.height / 2) break;
    gap++;
  }
  s.target = { side, gap: gap + offset };

  // 指示线画在两项之间那 4px 缝的中间。落点前一项是这一侧最后一个 Agent(下面紧跟着「+」)时:
  // 拖的是 Agent 就画在 Agent 和「+」之间(放下后它排在「+」上面),拖别的就画在「+」下面
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
  // 刚出现、或者换了一条 rail:直接到位,不从上一个位置滑过来
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
    // 已经放开了
  }
}

/**
 * 拖完松手紧跟着会来一次 click(落在按钮或它的祖先上),不吞掉就会被当成「点当前项 = 收起」。
 * 浏览器在处理同一次松开时就派发 click,排在任何定时器之前,所以 0ms 之后撤掉监听就够了。
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
  // 同步提交:下面紧接着要量放下之后的位置做 FLIP
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
