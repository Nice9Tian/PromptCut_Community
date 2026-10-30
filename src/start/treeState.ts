/**
 * 侧栏那棵树的排序、置顶、归档、重命名、删除 —— 都是纯函数,不碰界面,好单测(`treeState.test.mjs`)。
 *
 * **置顶只对自己同级生效**(用户 2026-10-23 定):分组里的项目 A 置顶,只在那个分组里顶上去,
 * 不会跑到别的分组前面,也不会越到分组这一层。拖动排序同理 —— 只在同一份同级列表里挪,
 * 拖到别的同级上去不动。「同级」怎么算由调用方给一个 `siblingKey`:
 *   - 分组:全部分组是一级,键恒定;
 *   - 项目:同一个分组里的项目是一级(没放进分组的自成一级);
 *   - Agent 对话:挂在同一个项目上的是一级,挂在同一个分组上的是另一级。
 *
 * 一律返回新数组、新对象,不原地改(仓库约束:共享项目靠对象身份判断改动)。
 */

export interface Flagged {
  id: string;
  /** 在自己同级里排到最前面 */
  pinned?: boolean;
  /** 归档了就不在树里显示 */
  archived?: boolean;
}

export interface Named extends Flagged {
  name: string;
}

/** 落点:放在目标的前面还是后面 */
export type Place = "before" | "after";

/**
 * 同级列表的显示顺序:置顶的排前面,两段各自保持原来的先后。
 * 传进来的必须已经是**一份同级**(调用方按 siblingKey 筛过),这个函数不认同级关系。
 */
export function ordered<T extends Flagged>(siblings: T[]): T[] {
  return [...siblings.filter((x) => x.pinned), ...siblings.filter((x) => !x.pinned)];
}

/** 树里看得见的:没归档的 */
export function visible<T extends Flagged>(items: T[]): T[] {
  return items.filter((x) => !x.archived);
}

/**
 * 把 `dragId` 挪到 `overId` 的前面或后面。
 *
 * 两者不同级就原样返回 —— 这一条是「只在同级里排序」的落点。插入位置紧挨着 `overId`,
 * 所以挪完还在同一段同级里,不会漏到隔壁去。
 */
export function reorder<T extends Flagged>(
  all: T[],
  siblingKey: (item: T) => string,
  dragId: string,
  overId: string,
  place: Place,
): T[] {
  if (dragId === overId) return all;
  const drag = all.find((x) => x.id === dragId);
  const over = all.find((x) => x.id === overId);
  if (!drag || !over) return all;
  if (siblingKey(drag) !== siblingKey(over)) return all;
  const rest = all.filter((x) => x.id !== dragId);
  const at = rest.findIndex((x) => x.id === overId);
  if (at < 0) return all;
  const next = [...rest];
  next.splice(place === "before" ? at : at + 1, 0, drag);
  return next;
}

/** 置顶 / 取消置顶 */
export function togglePin<T extends Flagged>(all: T[], id: string): T[] {
  return all.map((x) => (x.id === id ? { ...x, pinned: !x.pinned } : x));
}

/** 归档 / 取消归档 */
export function setArchived<T extends Flagged>(all: T[], id: string, archived: boolean): T[] {
  return all.map((x) => (x.id === id ? { ...x, archived } : x));
}

/** 重命名。空白名字不接受(照原样返回),界面上按「取消」处理 */
export function rename<T extends Named>(all: T[], id: string, name: string): T[] {
  const next = name.trim();
  if (!next) return all;
  return all.map((x) => (x.id === id ? { ...x, name: next } : x));
}

/** 删除一条 */
export function removeById<T extends Flagged>(all: T[], id: string): T[] {
  return all.filter((x) => x.id !== id);
}
