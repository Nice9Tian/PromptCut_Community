import { SIDES, effectiveActive, isSectionItem, type ItemId, type Side } from "./railLayout";
import { getRailLayout } from "./railStore";

/**
 * Node table of the reverse portal: each page (five sections, the script page, each AiPanel) has one fixed DOM node,
 * and React uses createPortal in DockPages to render the page content into this node; the React tree at that spot never moves.
 * The drawers / panels on the two sides (DockHost) are just empty shells, and placePages() moves the nodes belonging to that side into them.
 *
 * So dragging a page from left to right only changes the parent element of this node: component instances, state, and running chats are all unaffected.
 * What moving DOM loses is made up here:
 *   - scroll position: before moving, record every scrolled element in the node, and write it back after moving (when shown); ones pinned to the bottom are written back as pinned to the bottom;
 *   - focus: if focus is inside the node, focus it again after moving;
 *   - when Element.moveBefore (state-preserving move) is available, prefer it, so video, animation, and focus are not interrupted; if not, use appendChild,
 *     removing and inserting within the same synchronous task, so <video> is not paused.
 * ResizeObserver reports the new size at the new position by itself, and the masonry layout (Masonry) reflows as usual, no need to handle it.
 *
 * When the host of a side is not mounted, the node parks in a display:none parking slot in DockPages.
 */

const nodes = new Map<ItemId, HTMLElement>();
const hosts: Record<Side, HTMLElement | null> = { left: null, right: null };
let park: HTMLElement | null = null;

/** [element, scrollTop, scrollLeft, whether it was pinned to the bottom then] */
type ScrollSnap = Array<[Element, number, number, boolean]>;
/** Nodes moved while hidden: the scroll position is remembered first and written back when the node is shown */
const pendingScroll = new WeakMap<HTMLElement, ScrollSnap>();

/** The fixed node of this page; created the first time it is needed (not yet in the document, waiting for a host to claim it) */
export function pageNode(id: ItemId): HTMLElement {
  let node = nodes.get(id);
  if (!node) {
    node = document.createElement("div");
    node.className = "pc-dock-page";
    node.dataset.pcDockPage = id;
    // The section's color layering and input focus style are chosen by it (shell.css / left.css), no longer by "whether inside [data-pc=left]"
    node.dataset.pcDockKind = isSectionItem(id) ? "section" : "ai";
    node.style.display = "none";
    nodes.set(id, node);
  }
  return node;
}

/** Nodes already created (returns null if never created, and does not create one on the side) */
export function peekPageNode(id: ItemId): HTMLElement | null {
  return nodes.get(id) ?? null;
}

/** Closed Agent tab: the portal is already unmounted, and the node itself is discarded too */
export function releasePageNodes(keep: ReadonlySet<ItemId>): void {
  for (const [id, node] of nodes) {
    if (keep.has(id)) continue;
    node.remove();
    nodes.delete(id);
  }
}

/** Register when a host mounts, and return an unregister function. After unregistering, call placePages() once more to take this side's nodes back to the parking slot */
export function registerDockHost(side: Side, el: HTMLElement): () => void {
  hosts[side] = el;
  return () => {
    if (hosts[side] === el) hosts[side] = null;
  };
}

export function registerDockPark(el: HTMLElement): () => void {
  park = el;
  return () => {
    if (park === el) park = null;
  };
}

function collectScroll(root: HTMLElement): ScrollSnap {
  const out: ScrollSnap = [];
  const visit = (el: Element) => {
    if (el.scrollTop === 0 && el.scrollLeft === 0) return;
    out.push([el, el.scrollTop, el.scrollLeft, el.scrollHeight - el.clientHeight - el.scrollTop < 2]);
  };
  visit(root);
  root.querySelectorAll("*").forEach(visit);
  return out;
}

/**
 * Record scroll positions before moving. Even if the node is hidden at the moment (not the selected page of this side), try to record:
 * when the parent element has a layout box, temporarily show it, measure, and hide it again; done within the same synchronous task, so it is never painted, and ResizeObserver sees no net change.
 */
function snapshotScroll(node: HTMLElement): ScrollSnap {
  const pending = pendingScroll.get(node);
  if (pending) return pending;
  if (!node.isConnected) return [];
  if (node.style.display !== "none") return collectScroll(node);
  if (!node.parentElement || node.parentElement.getClientRects().length === 0) return [];
  node.style.display = "";
  try {
    return collectScroll(node);
  } finally {
    node.style.display = "none";
  }
}

function applyScroll(snap: ScrollSnap) {
  const put = () => {
    for (const [el, top, left, atEnd] of snap) {
      if (!el.isConnected) continue;
      const wantTop = atEnd ? el.scrollHeight : top;
      if (Math.abs(el.scrollTop - wantTop) > 1 && !(atEnd && el.scrollHeight - el.clientHeight - el.scrollTop < 2)) el.scrollTop = wantTop;
      if (el.scrollLeft !== left) el.scrollLeft = left;
    }
  };
  put();
  // Content reflows at the new width (the masonry layout only re-measures in the next frame), so align once more in the next frame
  requestAnimationFrame(put);
}

function setShown(node: HTMLElement, show: boolean, snap?: ScrollSnap) {
  if (!show) {
    if (node.style.display !== "none") node.style.display = "none";
    if (snap?.length) pendingScroll.set(node, snap);
    return;
  }
  if (node.style.display === "none") node.style.display = "";
  const restore = snap ?? pendingScroll.get(node);
  pendingScroll.delete(node);
  if (restore?.length && node.isConnected) applyScroll(restore);
}

type MoveBefore = (node: Node, child: Node | null) => void;

function moveNode(node: HTMLElement, target: HTMLElement, show: boolean) {
  const snap = snapshotScroll(node);
  const active = document.activeElement;
  const hadFocus = active instanceof HTMLElement && active !== document.body && node.contains(active) ? active : null;
  let moved = false;
  const moveBefore = (target as unknown as { moveBefore?: MoveBefore }).moveBefore;
  if (typeof moveBefore === "function" && node.isConnected && target.isConnected && node.ownerDocument === target.ownerDocument) {
    try {
      moveBefore.call(target, node, null);
      moved = true;
    } catch {
      // In some cases (e.g. across a shadow root) it throws; fall back to a plain move
    }
  }
  if (!moved) target.appendChild(node);
  setShown(node, show, snap);
  if (show && hadFocus && hadFocus.isConnected && document.activeElement !== hadFocus) {
    hadFocus.focus({ preventScroll: true });
  }
}

/**
 * Put each page's node where it belongs: the host of its side (the parking slot if not mounted), and show only the page currently selected on this side.
 * Idempotent, anyone can call it at any time: call it once after a host mounts / unmounts and after a layout change.
 */
export function placePages(): void {
  const layout = getRailLayout();
  for (const side of SIDES) {
    const host = hosts[side];
    const active = host ? effectiveActive(layout, side) : null;
    for (const id of layout[side]) {
      const node = nodes.get(id);
      if (!node) continue;
      node.dataset.pcDockSide = side;
      const target = host ?? park;
      const show = !!host && id === active;
      if (target && node.parentNode !== target) moveNode(node, target, show);
      else setShown(node, show);
    }
  }
}
