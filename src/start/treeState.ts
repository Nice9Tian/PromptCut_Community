/**
 * Sorting, pinning, archiving, renaming and deleting for the sidebar tree: all pure functions that do
 * not touch the UI, which makes them easy to unit test (`treeState.test.mjs`).
 *
 * **Pinning only takes effect among one's own siblings** (user decision, 2026-10-23): if project A in a
 * group is pinned, it moves to the top only inside that group, and does not jump ahead of other groups,
 * nor across to the group level. Drag-and-drop sorting works the same way: it only moves within one
 * sibling list, and dragging onto a different sibling level does nothing. How "siblings" are determined
 * is given by the caller as a `siblingKey`:
 *   - Groups: all groups form one level, with a constant key;
 *   - Projects: the projects in the same group form one level (those not in any group form a level of
 *     their own);
 *   - Agent chats: those attached to the same project form one level, and those attached to the same
 *     group form another level.
 *
 * Always return new arrays and new objects, never modify in place (repository constraint: shared
 * projects detect changes by object identity).
 */

export interface Flagged {
  id: string;
  /** Sorts to the very front among its own siblings */
  pinned?: boolean;
  /** Once archived it is no longer shown in the tree */
  archived?: boolean;
}

export interface Named extends Flagged {
  name: string;
}

/** Drop target: placed before or after the target */
export type Place = "before" | "after";

/**
 * Display order of a sibling list: pinned ones first, with each of the two parts keeping its original
 * order.
 * What is passed in must already be **one sibling list** (filtered by the caller using siblingKey); this
 * function does not know about sibling relationships.
 */
export function ordered<T extends Flagged>(siblings: T[]): T[] {
  return [...siblings.filter((x) => x.pinned), ...siblings.filter((x) => !x.pinned)];
}

/** Visible in the tree: those not archived */
export function visible<T extends Flagged>(items: T[]): T[] {
  return items.filter((x) => !x.archived);
}

/**
 * Moves `dragId` to before or after `overId`.
 *
 * If the two are not siblings, it returns the input unchanged: this is where the rule "sort only among
 * siblings" is enforced. The insertion position is right next to `overId`, so after the move it is still
 * within the same sibling run and does not leak into the neighboring one.
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

/** Pin / unpin */
export function togglePin<T extends Flagged>(all: T[], id: string): T[] {
  return all.map((x) => (x.id === id ? { ...x, pinned: !x.pinned } : x));
}

/** Archive / unarchive */
export function setArchived<T extends Flagged>(all: T[], id: string, archived: boolean): T[] {
  return all.map((x) => (x.id === id ? { ...x, archived } : x));
}

/** Rename. A blank name is not accepted (returned as is), and the UI treats it as "Cancel" */
export function rename<T extends Named>(all: T[], id: string, name: string): T[] {
  const next = name.trim();
  if (!next) return all;
  return all.map((x) => (x.id === id ? { ...x, name: next } : x));
}

/** Delete one entry */
export function removeById<T extends Flagged>(all: T[], id: string): T[] {
  return all.filter((x) => x.id !== id);
}
