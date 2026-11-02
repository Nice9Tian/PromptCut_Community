/**
 * Free layout of the two side rails: pure logic (no React, localStorage or DOM); the module-level store is in
 * railStore.ts.
 * Test: node --experimental-test-module-mocks --test src/editor/dock/railLayout.test.mjs
 *
 * Items on a rail: the five left rail sections, the script tab, every Agent tab (`agent:<tabId>`), and the cut
 * group (`cuts`). Any item can be dragged to any position on either rail;
 * the drawer / panel on each side shows the item currently selected on that side. Adding and removing Agent
 * tabs still belongs to ai/agentTabs.ts; the layout only records positions.
 *
 * The cut group is not a page: it is one whole block (all cuts + create new), switching cuts in place on the
 * rail, with no drawer to open.
 * So it is never the selected item, and the whole group moves together when dragged; when it is the only item
 * left on a side, that side counts as having no page (drawer collapsed).
 *
 * Data shape (localStorage `pc.rail.layout.v1`):
 *   { left: ItemId[], right: ItemId[], active: { left: ItemId | null, right: ItemId | null } }
 * An item appears on one side only once; when a side is empty its active is null.
 */

export type Side = "left" | "right";
export const SIDES: readonly Side[] = ["left", "right"];

export type SectionId = "library" | "animations" | "effects" | "edit" | "captions";
/** Fixed order of the left rail sections: missing sections are added back at the end of the left side in this order */
export const SECTION_IDS: readonly SectionId[] = ["library", "animations", "effects", "edit", "captions"];

export type AgentItemId = `agent:${string}`;
/** Cut group: all cuts of the timeline placed on the rail as one group */
export const CUTS_ITEM = "cuts";
export type ItemId = SectionId | "script" | AgentItemId | typeof CUTS_ITEM;

export interface RailLayout {
  left: ItemId[];
  right: ItemId[];
  active: Record<Side, ItemId | null>;
}

const AGENT_PREFIX = "agent:";

export function agentItem(tabId: string): AgentItemId {
  return `${AGENT_PREFIX}${tabId}`;
}

/** `agent:<id>` → id; returns null if it is not an Agent item */
export function agentIdOf(item: string): string | null {
  return item.startsWith(AGENT_PREFIX) && item.length > AGENT_PREFIX.length ? item.slice(AGENT_PREFIX.length) : null;
}

export function isAgentItem(item: string): item is AgentItemId {
  return agentIdOf(item) !== null;
}

export function isSectionItem(item: string): item is SectionId {
  return (SECTION_IDS as readonly string[]).includes(item);
}

/** Items that have a page (can be selected and shown in the drawer). The cut group has none */
export function isPageItem(item: string): boolean {
  return item !== CUTS_ITEM;
}

/** AI items: script and Agent */
export function isAiItem(item: string): boolean {
  return item === "script" || isAgentItem(item);
}

export function otherSide(side: Side): Side {
  return side === "left" ? "right" : "left";
}

export function sideOf(layout: RailLayout, item: string): Side | null {
  if ((layout.left as string[]).includes(item)) return "left";
  if ((layout.right as string[]).includes(item)) return "right";
  return null;
}

/**
 * Items drawn on this side's rail (all of them; both sides are always shown, and an emptied rail stays as a
 * drop target).
 */
export function visibleItems(items: readonly ItemId[]): ItemId[] {
  return items.slice();
}

/**
 * The item actually selected on this side right now (shown in the drawer). When the recorded active is not on
 * this side (or is the cut group, which has no page),
 * fall back to the first item with a page on this side. This only falls back in display; the recorded value
 * is not changed.
 */
export function effectiveActive(layout: RailLayout, side: Side): ItemId | null {
  const shown = visibleItems(layout[side]).filter(isPageItem);
  const want = layout.active[side];
  return want && shown.includes(want) ? want : (shown[0] ?? null);
}

/**
 * After which item the "+" is drawn: the index of the last Agent item on this side; returns -1 if there is no
 * Agent item (no "+" drawn).
 * The input is the drawn list (visibleItems); Agents are visible in both modes, so the result is the same.
 */
export function plusAnchor(items: readonly ItemId[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (isAgentItem(items[i])) return i;
  return -1;
}

/**
 * After removing some items from old, the "neighbor" of the item that was at index:
 * look upward first (the same direction as switching to the left tab after agentTabs.closeTab closes a tab),
 * then downward;
 * when the removed item is an Agent item, look among the remaining Agent items first (closing Agent 1 should
 * switch to another Agent, not jump to the script or a section; verified by testing, 2026-10-20), and widen
 * the search if none is found;
 * if isVisible is given, look among visible items first, and widen the search if none is found. Returns null
 * if there is none.
 */
function neighborOf(old: readonly ItemId[], index: number, keep: ReadonlySet<ItemId>, isVisible?: (id: ItemId) => boolean): ItemId | null {
  const kinds: ((id: ItemId) => boolean)[] = isAgentItem(old[index]) ? [isAgentItem, () => true] : [() => true];
  const visible = isVisible ? [isVisible, () => true] : [() => true];
  const passes = kinds.flatMap(kind => visible.map(vis => (id: ItemId) => kind(id) && vis(id)));
  for (const pass of passes) {
    // The cut group cannot be the selected item
    const ok = (id: ItemId) => isPageItem(id) && pass(id);
    for (let i = index - 1; i >= 0; i--) if (keep.has(old[i]) && ok(old[i])) return old[i];
    for (let i = index + 1; i < old.length; i++) if (keep.has(old[i]) && ok(old[i])) return old[i];
  }
  return null;
}

/** Reassemble the lists of both sides + active into a new one (does not modify the passed-in object) */
function withLists(layout: RailLayout, lists: Record<Side, ItemId[]>, active: Record<Side, ItemId | null>): RailLayout {
  return { left: lists.left, right: lists.right, active: { left: active.left, right: active.right } };
}

export interface LegacyState {
  /** Old key pc.left.section */
  section?: string | null;
  /** Old key pc.right.page: "script" / "agent" */
  rightPage?: string | null;
  /** The page currently active in agentTabs */
  activeTabId?: string | null;
}

/**
 * Default layout = the layout before the redesign: five sections on the left, script + all Agents on the
 * right.
 * The selected items reuse the old keys, so after upgrading, existing users stay on the page they were on.
 */
export function defaultLayout(agentIds: readonly string[], legacy: LegacyState = {}): RailLayout {
  // The cut group was removed on 2026-10-20 (its entry moved to the media library cut group and the tab bar above the timeline), so the default layout no longer has it
  const left: ItemId[] = [...SECTION_IDS];
  const right: ItemId[] = ["script", ...agentIds.map(agentItem)];
  const section: SectionId = legacy.section && isSectionItem(legacy.section) ? legacy.section : "library";
  const tab = legacy.activeTabId && agentIds.includes(legacy.activeTabId) ? legacy.activeTabId : agentIds[0];
  const rightActive: ItemId = legacy.rightPage === "script" || !tab ? "script" : agentItem(tab);
  return { left, right, active: { left: section, right: rightActive } };
}

/**
 * Which side a new Agent goes to (when there is no hint of "which side's + it was opened from"):
 * the right if the right has an Agent, otherwise the left if the left has one, and the right if neither does.
 */
function placementSide(layout: RailLayout): Side {
  if (layout.right.some(isAgentItem)) return "right";
  if (layout.left.some(isAgentItem)) return "left";
  return "right";
}

/** Whether this side has any page item (having only the cut group counts as none) */
export function hasPages(items: readonly ItemId[]): boolean {
  return items.some(isPageItem);
}

/** Insert an Agent item after the last Agent item on this side (put it at the end if this side has no Agent) */
export function insertAgent(layout: RailLayout, side: Side, item: AgentItemId): RailLayout {
  if (sideOf(layout, item)) return layout;
  const list = layout[side].slice();
  const at = plusAnchor(list);
  list.splice(at >= 0 ? at + 1 : list.length, 0, item);
  const lists = { left: layout.left, right: layout.right };
  lists[side] = list;
  const active = { ...layout.active };
  if (!active[side]) active[side] = item;
  return withLists(layout, lists, active);
}

/** Select an item (changes the active of whichever side it is on); returns the input as is if it is not in the layout */
export function withActive(layout: RailLayout, item: ItemId): RailLayout {
  const side = sideOf(layout, item);
  if (!side || !isPageItem(item) || layout.active[side] === item) return layout;
  return withLists(layout, { left: layout.left, right: layout.right }, { ...layout.active, [side]: item });
}

export interface SyncResult {
  layout: RailLayout;
  /** Newly added Agent items, in agentIds order */
  added: AgentItemId[];
  /** Sides that became empty this time because Agents were deleted */
  emptied: Side[];
}

/**
 * Align the Agent items in the layout with agentTabs:
 *   - Agent items that are already closed are removed; if one was the selected item of its side, the adjacent
 *     item is selected instead (up first, then down), and if that side becomes empty its active is set to null;
 *   - Agents not yet in the layout are added: if a hint is given (created from that side's "+"), insert it
 *     after the last Agent on that side and select it,
 *     otherwise place it by placementSide.
 * When nothing changed, the returned layout is the very object that was passed in.
 */
export function syncAgents(layout: RailLayout, agentIds: readonly string[], hint: Side | null = null): SyncResult {
  const alive = new Set(agentIds.map(agentItem));
  let next = layout;
  const emptied: Side[] = [];
  for (const side of SIDES) {
    const old = next[side];
    if (!old.some((id) => isAgentItem(id) && !alive.has(id))) continue;
    const kept = old.filter((id) => !isAgentItem(id) || alive.has(id));
    const active = { ...next.active };
    const cur = active[side];
    if (cur && !kept.includes(cur)) active[side] = neighborOf(old, old.indexOf(cur), new Set(kept));
    if (!hasPages(kept)) {
      active[side] = null;
      emptied.push(side);
    }
    const lists = { left: next.left, right: next.right };
    lists[side] = kept;
    next = withLists(next, lists, active);
  }
  const added: AgentItemId[] = [];
  for (const id of agentIds) {
    const item = agentItem(id);
    if (sideOf(next, item)) continue;
    next = insertAgent(next, hint ?? placementSide(next), item);
    added.push(item);
  }
  if (hint && added.length) next = withActive(next, added[added.length - 1]);
  return { layout: next, added, emptied };
}

/**
 * A layout that was read back must be validated:
 *   - keep only known items (remove Agents that no longer exist), and keep only the first occurrence of
 *     duplicates;
 *   - missing left rail sections are added back at the end of the left side in the fixed order, a missing
 *     script is added back at the top of the right side, and missing Agents are placed by the syncAgents rules;
 *   - if active is not on that side, fall back to the selected item of fallback (if it is still on that side),
 *     then to the first item on that side.
 * If the shape is plainly wrong (not an object, left / right not arrays), use fallback directly.
 */
export function validateLayout(raw: unknown, agentIds: readonly string[], fallback: RailLayout = defaultLayout(agentIds)): RailLayout {
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as { left?: unknown; right?: unknown; active?: unknown };
  if (!Array.isArray(r.left) || !Array.isArray(r.right)) return fallback;
  const known = new Set(agentIds);
  const seen = new Set<string>();
  const clean = (arr: unknown[]): ItemId[] => {
    const out: ItemId[] = [];
    for (const v of arr) {
      if (typeof v !== "string" || seen.has(v)) continue;
      const agent = agentIdOf(v);
      // A cut group (CUTS_ITEM) stored in an old layout is dropped when read: neither rail has it since 2026-10-20
      if (!(isSectionItem(v) || v === "script" || (agent !== null && known.has(agent)))) continue;
      seen.add(v);
      out.push(v as ItemId);
    }
    return out;
  };
  const left = clean(r.left);
  const right = clean(r.right);
  for (const s of SECTION_IDS) if (!seen.has(s)) left.push(s);
  if (!seen.has("script")) right.unshift("script");
  let layout: RailLayout = { left, right, active: { left: null, right: null } };
  layout = syncAgents(layout, agentIds).layout;

  const want = r.active && typeof r.active === "object" ? (r.active as Record<string, unknown>) : {};
  const active: Record<Side, ItemId | null> = { left: null, right: null };
  for (const side of SIDES) {
    const list = layout[side] as string[];
    const a = want[side];
    const fb = fallback.active[side];
    if (typeof a === "string" && list.includes(a) && isPageItem(a)) active[side] = a as ItemId;
    else if (fb && list.includes(fb) && isPageItem(fb)) active[side] = fb;
    else active[side] = layout[side].find(isPageItem) ?? null;
  }
  return { left: layout.left, right: layout.right, active };
}

/**
 * Convert a drop index on the rail (counting only drawn items, including the dragged item) into an insert
 * position in the full list.
 * Dropping between two items = insert before the latter item; dropping at the end = insert after the last
 * drawn item (hidden sections do not move along).
 */
export function gapToFullIndex(full: readonly ItemId[], shown: readonly ItemId[], gap: number): number {
  if (shown.length === 0) return full.length;
  const g = Math.max(0, Math.min(Number.isFinite(gap) ? Math.trunc(gap) : shown.length, shown.length));
  if (g < shown.length) return full.indexOf(shown[g]);
  return full.indexOf(shown[shown.length - 1]) + 1;
}

export interface MoveResult {
  layout: RailLayout;
  from: Side;
  to: Side;
  /** The source side thereby becomes empty (its drawer must be collapsed) */
  emptied: Side | null;
}

/**
 * Put an item at gapIndex of the toSide list (gapIndex counts the list as if the dragged item were still in
 * its original place, consistent with the drop position seen while dragging).
 *   - The dragged item becomes the selected item of the target side (the cut group is not a page and is not
 *     selected, so the target side's selected item stays unchanged);
 *   - When crossing sides and it was the selected item of the source side, the source side selects an adjacent
 *     item (up first, then down, preferring visible ones per isVisible); if the source side has no page item
 *     left, active is set to null and emptied is reported.
 * Returns null if the item is not in the layout.
 */
export function moveItem(
  layout: RailLayout,
  item: ItemId,
  toSide: Side,
  gapIndex: number,
  isVisible?: (id: ItemId) => boolean,
): MoveResult | null {
  const from = sideOf(layout, item);
  if (!from) return null;
  const src = layout[from];
  const fromIdx = src.indexOf(item);
  const target = (from === toSide ? src : layout[toSide]).slice();
  let idx = Math.max(0, Math.min(Number.isFinite(gapIndex) ? Math.trunc(gapIndex) : target.length, target.length));
  if (from === toSide) {
    target.splice(fromIdx, 1);
    if (fromIdx < idx) idx--;
  }
  target.splice(idx, 0, item);

  const lists = { left: layout.left, right: layout.right };
  const active = { ...layout.active };
  let emptied: Side | null = null;
  if (from !== toSide) {
    const rest = src.filter((id) => id !== item);
    lists[from] = rest;
    if (!hasPages(rest)) {
      active[from] = null;
      emptied = from;
    } else if (active[from] === item) {
      active[from] = neighborOf(src, fromIdx, new Set(rest), isVisible);
    }
  }
  lists[toSide] = target;
  if (isPageItem(item)) active[toSide] = item;
  return { layout: withLists(layout, lists, active), from, to: toSide, emptied };
}

/** Whether two layouts have the same content (to decide whether to write before saving) */
export function sameLayout(a: RailLayout, b: RailLayout): boolean {
  return (
    a.active.left === b.active.left &&
    a.active.right === b.active.right &&
    a.left.length === b.left.length &&
    a.right.length === b.right.length &&
    a.left.every((id, i) => id === b.left[i]) &&
    a.right.every((id, i) => id === b.right[i])
  );
}
