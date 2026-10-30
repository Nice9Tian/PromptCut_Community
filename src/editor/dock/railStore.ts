import { useSyncExternalStore } from "react";
// 先接上「分页清单跟着当前项目走」,下面第一次读 getTabs() 时才是当前项目的清单
import "../../ai/agentTabsProject";
import { activateTab, addTab, getActiveTabId, getAgentProjectId, getTabs, subscribeTabs } from "../../ai/agentTabs";
import { setRailCollapsed, toggleRailCollapsed } from "../sideRails";
import { writeStored } from "../left/stored";
import {
  SIDES,
  agentIdOf,
  agentItem,
  defaultLayout,
  effectiveActive,
  gapToFullIndex,
  hasPages,
  isPageItem,
  isSectionItem,
  moveItem,
  sameLayout,
  sideOf,
  syncAgents,
  validateLayout,
  visibleItems,
  withActive,
  type ItemId,
  type RailLayout,
  type Side,
} from "./railLayout";

/**
 * 侧边 rail 自由布局的模块级 store(纯逻辑在 railLayout.ts)。
 *
 *   - 布局存 localStorage `pc.rail.layout.v1`;没存过就按改版前的样子生成,选中项沿用旧键
 *     `pc.left.section` / `pc.right.page` / agentTabs 的当前页。
 *   - 订阅 agentTabs:关掉的 Agent 从布局里拿掉,新开的补进来(从哪一侧的「+」点的就放哪一侧)。
 *   - 收起状态仍归 sideRails(`pc.rail.<side>.collapsed`),这里只在该收 / 该展开的时候调它:
 *     一侧被拖空强制收起,项放下 / 点开时展开目标侧。
 *
 * 分区被选中时照旧写 `pc.left.section`(scripts/left-check.mjs 读它),Agent 被选中时照旧 activateTab。
 */

const STORAGE_KEY = "pc.rail.layout.v1";

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function initialLayout(): RailLayout {
  const agentIds = getTabs().map((t) => t.id);
  const fallback = defaultLayout(agentIds, {
    section: readRaw("pc.left.section"),
    rightPage: readRaw("pc.right.page"),
    activeTabId: getActiveTabId(),
  });
  const stored = readRaw(STORAGE_KEY);
  if (!stored) return fallback;
  try {
    return validateLayout(JSON.parse(stored), agentIds, fallback);
  } catch {
    // 存坏了就当没存过
    return fallback;
  }
}

function persist(next: RailLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 存不下也让本次会话生效 */
  }
}

let layout: RailLayout = initialLayout();
persist(layout);
// 拖空的一侧抽屉强制收起(只剩剪辑组也算空):上次关掉编辑器时就是空的,sideRails 那边的键又被清过,也要收着
for (const side of SIDES) if (!hasPages(layout[side])) setRailCollapsed(side, true);

const listeners = new Set<() => void>();

function commit(next: RailLayout) {
  if (next === layout || sameLayout(next, layout)) return;
  layout = next;
  persist(next);
  for (const fn of listeners) fn();
}

export function getRailLayout(): RailLayout {
  return layout;
}

export function subscribeRailLayout(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useRailLayout(): RailLayout {
  return useSyncExternalStore(subscribeRailLayout, getRailLayout, getRailLayout);
}

/** 这一项在哪一侧(不在布局里返回 null) */
export function railSideOf(item: ItemId): Side | null {
  return sideOf(layout, item);
}

/** 选中一项之后的连带动作:Agent 同步到 agentTabs 的当前页,分区照旧记 pc.left.section */
function noteActivated(item: ItemId) {
  const tabId = agentIdOf(item);
  if (tabId) activateTab(tabId);
  else if (isSectionItem(item)) writeStored("pc.left.section", item);
}

/**
 * 选中一项(在哪一侧就改哪一侧)。expand = 顺手把那一侧展开(外部要把某一页拉出来时用,比如 captionsBus)。
 */
export function activateRailItem(item: ItemId, opts: { expand?: boolean } = {}): void {
  const side = sideOf(layout, item);
  if (!side) return;
  commit(withActive(layout, item));
  noteActivated(item);
  if (opts.expand) setRailCollapsed(side, false);
}

/** rail 上点一项:点的是这一侧此刻选中的项 = 收起 / 展开;点别的项 = 切过去并展开 */
export function clickRailItem(side: Side, item: ItemId): void {
  if (effectiveActive(layout, side) === item) {
    toggleRailCollapsed(side);
    return;
  }
  activateRailItem(item, { expand: true });
}

/**
 * 拖放落定。shownGap 是目标 rail 上画出来的那些项里的落点(含被拖项本身,和拖动时的指示线一致)。
 * 放下之后:被拖项成为目标侧选中项、展开目标侧;源侧改选相邻一项,源侧空了收起源侧。
 */
export function moveRailItem(item: ItemId, side: Side, shownGap: number): void {
  const full = layout[side];
  const gap = gapToFullIndex(full, visibleItems(full), shownGap);
  const res = moveItem(layout, item, side, gap);
  if (!res) return;
  commit(res.layout);
  noteActivated(item);
  if (res.emptied) setRailCollapsed(res.emptied, true);
  // 剪辑组没有页面:挪过去不用展开目标侧的抽屉
  if (isPageItem(item)) setRailCollapsed(side, false);
}

/** 这一侧的「+」:新开一个 Agent 分页,插在这一侧最后一个 Agent 后面,并在这一侧打开 */
let pendingAddSide: Side | null = null;
export function addAgentOnSide(side: Side): void {
  pendingAddSide = side;
  let tabId: string;
  try {
    tabId = addTab().id;
  } finally {
    pendingAddSide = null;
  }
  // 订阅回调里已经放好并选中了;这里再兜一次(比如回调因为别的原因没跑到)
  const item = agentItem(tabId);
  if (!sideOf(layout, item)) commit(syncAgents(layout, getTabs().map((t) => t.id), side).layout);
  activateRailItem(item, { expand: true });
}

// agentTabs 每次变化(含忙碌 / 未读这类只改字段的)都来一遍;没有增删时 syncAgents 原样返回,不会写盘
let lastProjectId = getAgentProjectId();
subscribeTabs(() => {
  const hint = pendingAddSide;
  const res = syncAgents(layout, getTabs().map((t) => t.id), hint);
  // 换了项目、或把会话全关光回到开始页:这一份清单的当前页(项目的当前 Agent / 开始页)新补进 rail 时顺手选中它(不展开)。
  // 否则它的位置原先是别的项目的 Agent,关掉后 active 会退到剧本或分区
  const projectChanged = getAgentProjectId() !== lastProjectId;
  lastProjectId = getAgentProjectId();
  const activeItem = agentItem(getActiveTabId());
  const next = (projectChanged || res.added.includes(activeItem)) && sideOf(res.layout, activeItem) ? withActive(res.layout, activeItem) : res.layout;
  if (next === layout) return;
  commit(next);
  for (const side of res.emptied) setRailCollapsed(side, true);
  if (hint && res.added.length) setRailCollapsed(hint, false);
});

// 自动化验证用:puppeteer 里能直接读布局、不经拖动也能挪项
declare global {
  interface Window {
    __pcRailLayout?: {
      get: typeof getRailLayout;
      move: typeof moveRailItem;
      activate: typeof activateRailItem;
      click: typeof clickRailItem;
    };
  }
}
if (typeof window !== "undefined") {
  window.__pcRailLayout = { get: getRailLayout, move: moveRailItem, activate: activateRailItem, click: clickRailItem };
}
