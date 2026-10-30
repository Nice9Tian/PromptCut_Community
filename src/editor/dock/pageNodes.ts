import { SIDES, effectiveActive, isSectionItem, type ItemId, type Side } from "./railLayout";
import { getRailLayout } from "./railStore";

/**
 * reverse portal 的节点表:每一页(五个分区、剧本页、各 AiPanel)各有一个固定的 DOM 节点,
 * React 在 DockPages 里用 createPortal 把页面内容渲染进这个节点 —— 那一处的 React 树永远不动。
 * 两侧的抽屉 / 面板(DockHost)只是空壳,由 placePages() 把属于这一侧的节点挪进去。
 *
 * 所以把一页从左边拖到右边,只是这个节点换了个父元素:组件实例、state、正在跑的对话都不受影响。
 * 挪 DOM 会丢的东西在这里补:
 *   - 滚动位置:挪之前记下节点里所有滚过的元素,挪完(显示出来时)写回;贴底的按贴底写回;
 *   - 焦点:焦点在节点里就挪完再聚焦回去;
 *   - 能用 Element.moveBefore(状态保留的移动)时优先用它,视频、动画、焦点都不打断;不能用就 appendChild,
 *     同一个同步任务里拔出再插入,<video> 不会被暂停。
 * ResizeObserver 自己会在新位置报一次新尺寸,瀑布流(Masonry)照常重排,不用管。
 *
 * 一侧的宿主没挂载时,节点停在 DockPages 里一个 display:none 的停车位。
 */

const nodes = new Map<ItemId, HTMLElement>();
const hosts: Record<Side, HTMLElement | null> = { left: null, right: null };
let park: HTMLElement | null = null;

/** [元素, scrollTop, scrollLeft, 当时是否贴底] */
type ScrollSnap = Array<[Element, number, number, boolean]>;
/** 隐藏着挪过去的节点:滚动位置先记着,等它显示出来再写回 */
const pendingScroll = new WeakMap<HTMLElement, ScrollSnap>();

/** 这一页的固定节点;第一次要的时候建(还不在文档里,等宿主来领) */
export function pageNode(id: ItemId): HTMLElement {
  let node = nodes.get(id);
  if (!node) {
    node = document.createElement("div");
    node.className = "pc-dock-page";
    node.dataset.pcDockPage = id;
    // 分区的配色层级、输入框焦点样式按它挑(shell.css / left.css),不再靠「在不在 [data-pc=left] 里」
    node.dataset.pcDockKind = isSectionItem(id) ? "section" : "ai";
    node.style.display = "none";
    nodes.set(id, node);
  }
  return node;
}

/** 已经建过的节点(没建过返回 null,不会顺手建) */
export function peekPageNode(id: ItemId): HTMLElement | null {
  return nodes.get(id) ?? null;
}

/** 关掉的 Agent 分页:portal 已经卸载,节点本身也扔掉 */
export function releasePageNodes(keep: ReadonlySet<ItemId>): void {
  for (const [id, node] of nodes) {
    if (keep.has(id)) continue;
    node.remove();
    nodes.delete(id);
  }
}

/** 宿主挂载时登记,返回注销函数。注销后要再 placePages() 一次,把这一侧的节点收回停车位 */
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
 * 挪之前记滚动位置。节点此刻是隐藏的(不是这一侧的选中页)也尽量记:
 * 父元素有布局盒时临时把它显示出来量一下再藏回去 —— 同一个同步任务里完成,不会画出来,ResizeObserver 也看不到净变化。
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
  // 新宽度下内容会重排(瀑布流下一帧才重新量),下一帧再对一次
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
      // 某些情况下(比如跨 shadow root)会抛,退回普通移动
    }
  }
  if (!moved) target.appendChild(node);
  setShown(node, show, snap);
  if (show && hadFocus && hadFocus.isConnected && document.activeElement !== hadFocus) {
    hadFocus.focus({ preventScroll: true });
  }
}

/**
 * 把每一页的节点放到它该在的地方:所在一侧的宿主(没挂载就停车位),并只显示这一侧此刻选中的那一页。
 * 幂等,谁都可以随时调:宿主挂载 / 卸载、布局变化后都调一次。
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
