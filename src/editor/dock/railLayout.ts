/**
 * 两条侧边 rail 的自由布局:纯逻辑(不碰 React、localStorage、DOM),模块级 store 在 railStore.ts。
 * 测试:node --experimental-test-module-mocks --test src/editor/dock/railLayout.test.mjs
 *
 * rail 上的项:左栏五个分区、剧本页、每个 Agent 分页(`agent:<tabId>`)、剪辑组(`cuts`)。任何一项都能拖到任意一条 rail 的任意位置;
 * 每一侧的抽屉 / 面板显示这一侧当前选中的那一项。Agent 分页的增删仍归 ai/agentTabs.ts,布局只记位置。
 *
 * 剪辑组不是页面:它是一整块(所有剪辑 + 新建),在 rail 上就地切换剪辑,没有抽屉可开。
 * 所以它永远不当选中项,拖动时整组一起挪;一侧只剩它时,这一侧算没有页面(抽屉收起)。
 *
 * 数据形状(localStorage `pc.rail.layout.v1`):
 *   { left: ItemId[], right: ItemId[], active: { left: ItemId | null, right: ItemId | null } }
 * 一项只在一侧出现一次;一侧为空时那一侧的 active 是 null。
 */

export type Side = "left" | "right";
export const SIDES: readonly Side[] = ["left", "right"];

export type SectionId = "library" | "animations" | "effects" | "edit" | "captions";
/** 左栏分区的固定顺序:缺了的分区按这个顺序补回左边末尾 */
export const SECTION_IDS: readonly SectionId[] = ["library", "animations", "effects", "edit", "captions"];

export type AgentItemId = `agent:${string}`;
/** 剪辑组:时间轴的所有剪辑整组放在 rail 上 */
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

/** `agent:<id>` → id;不是 Agent 项返回 null */
export function agentIdOf(item: string): string | null {
  return item.startsWith(AGENT_PREFIX) && item.length > AGENT_PREFIX.length ? item.slice(AGENT_PREFIX.length) : null;
}

export function isAgentItem(item: string): item is AgentItemId {
  return agentIdOf(item) !== null;
}

export function isSectionItem(item: string): item is SectionId {
  return (SECTION_IDS as readonly string[]).includes(item);
}

/** 有页面(能被选中、在抽屉里显示)的项。剪辑组没有 */
export function isPageItem(item: string): boolean {
  return item !== CUTS_ITEM;
}

/** AI 类项:剧本和 Agent */
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
 * 这一侧 rail 上画出来的项(全部;两侧永远显示,拖空的 rail 也留着当落点)。
 */
export function visibleItems(items: readonly ItemId[]): ItemId[] {
  return items.slice();
}

/**
 * 这一侧此刻真正选中(抽屉里显示)的项。记下的 active 不在这一侧(或是没有页面的剪辑组)时,
 * 退到这一侧第一个有页面的项 —— 只是显示上退,不改记下的值。
 */
export function effectiveActive(layout: RailLayout, side: Side): ItemId | null {
  const shown = visibleItems(layout[side]).filter(isPageItem);
  const want = layout.active[side];
  return want && shown.includes(want) ? want : (shown[0] ?? null);
}

/**
 * 「+」画在哪一项后面:这一侧最后一个 Agent 项的下标;没有 Agent 项返回 -1(不画「+」)。
 * 传进来的是画出来的那份列表(visibleItems),Agent 在两种模式下都看得见,所以结果一样。
 */
export function plusAnchor(items: readonly ItemId[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (isAgentItem(items[i])) return i;
  return -1;
}

/**
 * 从 old 里拿掉一些项之后,原来 index 处那一项的「相邻项」:
 * 先往上找(和 agentTabs.closeTab 关页后切到左边那页一个方向),再往下找;
 * 拿掉的是 Agent 项时先在剩下的 Agent 项里找(关掉 Agent 1 要切到别的 Agent,不跳到剧本或分区,2026-10-20 实测),找不到再放宽;
 * 给了 isVisible 就先在看得见的项里找,找不到再放宽。都没有返回 null。
 */
function neighborOf(old: readonly ItemId[], index: number, keep: ReadonlySet<ItemId>, isVisible?: (id: ItemId) => boolean): ItemId | null {
  const kinds: ((id: ItemId) => boolean)[] = isAgentItem(old[index]) ? [isAgentItem, () => true] : [() => true];
  const visible = isVisible ? [isVisible, () => true] : [() => true];
  const passes = kinds.flatMap(kind => visible.map(vis => (id: ItemId) => kind(id) && vis(id)));
  for (const pass of passes) {
    // 剪辑组不能当选中项
    const ok = (id: ItemId) => isPageItem(id) && pass(id);
    for (let i = index - 1; i >= 0; i--) if (keep.has(old[i]) && ok(old[i])) return old[i];
    for (let i = index + 1; i < old.length; i++) if (keep.has(old[i]) && ok(old[i])) return old[i];
  }
  return null;
}

/** 两侧列表 + active 重新拼一份(不改传进来的对象) */
function withLists(layout: RailLayout, lists: Record<Side, ItemId[]>, active: Record<Side, ItemId | null>): RailLayout {
  return { left: lists.left, right: lists.right, active: { left: active.left, right: active.right } };
}

export interface LegacyState {
  /** 旧键 pc.left.section */
  section?: string | null;
  /** 旧键 pc.right.page:"script" / "agent" */
  rightPage?: string | null;
  /** agentTabs 当前激活的页 */
  activeTabId?: string | null;
}

/**
 * 默认布局 = 改版前的布局:左边五个分区,右边剧本 + 各 Agent。
 * 选中项沿用旧键,老用户升级后停在原来那一页。
 */
export function defaultLayout(agentIds: readonly string[], legacy: LegacyState = {}): RailLayout {
  // 剪辑组 2026-10-20 撤掉(入口挪到素材库剪辑组与时间轴上方标签栏),默认布局里不再有它
  const left: ItemId[] = [...SECTION_IDS];
  const right: ItemId[] = ["script", ...agentIds.map(agentItem)];
  const section: SectionId = legacy.section && isSectionItem(legacy.section) ? legacy.section : "library";
  const tab = legacy.activeTabId && agentIds.includes(legacy.activeTabId) ? legacy.activeTabId : agentIds[0];
  const rightActive: ItemId = legacy.rightPage === "script" || !tab ? "script" : agentItem(tab);
  return { left, right, active: { left: section, right: rightActive } };
}

/**
 * 新 Agent 放哪一侧(没有「从哪一侧的 + 点出来的」提示时):
 * 右边有 Agent 就放右边,否则左边有就放左边,都没有放右边。
 */
function placementSide(layout: RailLayout): Side {
  if (layout.right.some(isAgentItem)) return "right";
  if (layout.left.some(isAgentItem)) return "left";
  return "right";
}

/** 这一侧有没有页面项(只剩剪辑组也算没有) */
export function hasPages(items: readonly ItemId[]): boolean {
  return items.some(isPageItem);
}

/** 把 Agent 项插到这一侧最后一个 Agent 项后面(这一侧没有 Agent 就放末尾) */
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

/** 选中某一项(它在哪一侧就改哪一侧的 active);不在布局里原样返回 */
export function withActive(layout: RailLayout, item: ItemId): RailLayout {
  const side = sideOf(layout, item);
  if (!side || !isPageItem(item) || layout.active[side] === item) return layout;
  return withLists(layout, { left: layout.left, right: layout.right }, { ...layout.active, [side]: item });
}

export interface SyncResult {
  layout: RailLayout;
  /** 新补进来的 Agent 项,按 agentIds 顺序 */
  added: AgentItemId[];
  /** 这次因为删掉 Agent 而变空的侧 */
  emptied: Side[];
}

/**
 * 让布局里的 Agent 项和 agentTabs 对齐:
 *   - 已经关掉的 Agent 项拿掉;它是那一侧的选中项就改选相邻一项(先上后下),那一侧空了 active 置 null;
 *   - 布局里还没有的 Agent 补进去:给了 hint(从那一侧的「+」新建)就插在那一侧最后一个 Agent 后面并选中它,
 *     没给就按 placementSide 放。
 * 什么都没变时返回的 layout 就是传进来的那个对象。
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
 * 读出来的布局要校验:
 *   - 只认识的项留下(已经不存在的 Agent 拿掉),重复的只留第一次出现;
 *   - 缺的左栏分区按固定顺序补回左边末尾,缺的剧本补回右边顶上,缺的 Agent 按 syncAgents 的规则放;
 *   - active 不在那一侧就退回 fallback 的选中项(还在那一侧的话),再退回那一侧第一项。
 * 形状根本不对(不是对象、left / right 不是数组)直接用 fallback。
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
      // 老布局里存着的剪辑组(CUTS_ITEM)读进来就丢掉:2026-10-20 起左右栏都没有它
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
 * rail 上的落点下标(只数画出来的项,含被拖的那一项)换成完整列表里的插入位置。
 * 落在两项之间 = 插到后面那一项前面;落在最后 = 插到最后一个画出来的项后面(隐藏着的分区不跟着挪)。
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
  /** 源侧因此变空(要收起那一侧的抽屉) */
  emptied: Side | null;
}

/**
 * 把一项放到 toSide 列表的 gapIndex 处(gapIndex 按「被拖项还在原位」的列表数,和拖动时看到的落点一致)。
 *   - 被拖的项成为目标侧的选中项(剪辑组不是页面,不当选中项,目标侧选中项不变);
 *   - 跨侧时它原来是源侧的选中项,源侧改选相邻一项(先上后下,isVisible 看得见的优先);源侧没有页面项了 active 置 null、报 emptied。
 * 项不在布局里返回 null。
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

/** 两份布局内容是否一样(存盘前判断要不要写) */
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
