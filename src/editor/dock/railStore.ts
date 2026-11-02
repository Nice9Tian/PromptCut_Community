import { useSyncExternalStore } from "react";
// First hook up "the tab manifest follows the current project", so that the first read of getTabs() below gets the current project's manifest
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
 * Module-level store for the free layout of the side rails (pure logic in railLayout.ts).
 *
 *   - The layout is stored in localStorage `pc.rail.layout.v1`; if never stored, it is generated as it looked
 *     before the redesign, and the selected items reuse the old keys
 *     `pc.left.section` / `pc.right.page` / the current page of agentTabs.
 *   - Subscribes to agentTabs: closed Agents are removed from the layout and newly opened ones are added (to
 *     whichever side's "+" they were opened from).
 *   - The collapsed state still belongs to sideRails (`pc.rail.<side>.collapsed`); this module only calls it
 *     when something should collapse / expand:
 *     a side dragged empty is forced to collapse, and the target side expands when an item is dropped / opened.
 *
 * When a section is selected, `pc.left.section` is still written as before (scripts/left-check.mjs reads it),
 * and when an Agent is selected, activateTab is still called as before.
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
    // If the stored data is corrupt, treat it as never stored
    return fallback;
  }
}

function persist(next: RailLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* Even if it cannot be stored, make it take effect for this session */
  }
}

let layout: RailLayout = initialLayout();
persist(layout);
// Force-collapse the drawer of a side dragged empty (having only the cut group counts as empty): it was empty
// when the editor was last closed, and the sideRails key was cleared, so it must stay collapsed too
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

/** Which side this item is on (returns null if it is not in the layout) */
export function railSideOf(item: ItemId): Side | null {
  return sideOf(layout, item);
}

/** Follow-up actions after selecting an item: an Agent syncs to the current page of agentTabs, a section is still recorded in pc.left.section */
function noteActivated(item: ItemId) {
  const tabId = agentIdOf(item);
  if (tabId) activateTab(tabId);
  else if (isSectionItem(item)) writeStored("pc.left.section", item);
}

/**
 * Select an item (changes whichever side it is on). expand = also expand that side (used when something
 * external needs to bring a page out, e.g. captionsBus).
 */
export function activateRailItem(item: ItemId, opts: { expand?: boolean } = {}): void {
  const side = sideOf(layout, item);
  if (!side) return;
  commit(withActive(layout, item));
  noteActivated(item);
  if (opts.expand) setRailCollapsed(side, false);
}

/** Click an item on the rail: clicking the item currently selected on this side = collapse / expand; clicking another item = switch to it and expand */
export function clickRailItem(side: Side, item: ItemId): void {
  if (effectiveActive(layout, side) === item) {
    toggleRailCollapsed(side);
    return;
  }
  activateRailItem(item, { expand: true });
}

/**
 * Drag-and-drop settle. shownGap is the drop position among the items drawn on the target rail (including the
 * dragged item itself, consistent with the indicator line while dragging).
 * After the drop: the dragged item becomes the selected item of the target side and the target side expands;
 * the source side selects an adjacent item, and collapses if it became empty.
 */
export function moveRailItem(item: ItemId, side: Side, shownGap: number): void {
  const full = layout[side];
  const gap = gapToFullIndex(full, visibleItems(full), shownGap);
  const res = moveItem(layout, item, side, gap);
  if (!res) return;
  commit(res.layout);
  noteActivated(item);
  if (res.emptied) setRailCollapsed(res.emptied, true);
  // The cut group has no page: moving it over does not need to expand the target side's drawer
  if (isPageItem(item)) setRailCollapsed(side, false);
}

/** "+" of this side: open a new Agent tab, insert it after the last Agent on this side, and open it on this side */
let pendingAddSide: Side | null = null;
export function addAgentOnSide(side: Side): void {
  pendingAddSide = side;
  let tabId: string;
  try {
    tabId = addTab().id;
  } finally {
    pendingAddSide = null;
  }
  // The subscription callback has already placed and selected it; this is a second safety net (e.g. the callback did not run for some other reason)
  const item = agentItem(tabId);
  if (!sideOf(layout, item)) commit(syncAgents(layout, getTabs().map((t) => t.id), side).layout);
  activateRailItem(item, { expand: true });
}

// Fires on every change of agentTabs (including field-only changes like busy / unread); when nothing was added or removed, syncAgents returns the input as is and nothing is written to disk
let lastProjectId = getAgentProjectId();
subscribeTabs(() => {
  const hint = pendingAddSide;
  const res = syncAgents(layout, getTabs().map((t) => t.id), hint);
  // Switched project, or closed all sessions and returned to the start page: when this manifest's current page (the project's current Agent / start page) is newly added to the rail, select it along the way (without expanding).
  // Otherwise its position used to be an Agent of another project, and after it is closed, active would fall back to the script or a section
  const projectChanged = getAgentProjectId() !== lastProjectId;
  lastProjectId = getAgentProjectId();
  const activeItem = agentItem(getActiveTabId());
  const next = (projectChanged || res.added.includes(activeItem)) && sideOf(res.layout, activeItem) ? withActive(res.layout, activeItem) : res.layout;
  if (next === layout) return;
  commit(next);
  for (const side of res.emptied) setRailCollapsed(side, true);
  if (hint && res.added.length) setRailCollapsed(hint, false);
});

// For automated verification: puppeteer can read the layout directly and move items without dragging
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
