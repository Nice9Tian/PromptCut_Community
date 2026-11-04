/**
 * The context menu of a sidebar row: rename / pin / archive / delete.
 *
 * All three kinds of rows (group, project, Agent chat) share this one. Esc, clicking elsewhere and
 * scrolling all close it; the up and down keys move through the items and Enter selects. The context
 * menu can only be opened with the mouse, but once opened it must be completable by keyboard, otherwise
 * screen-reader users get stuck here.
 *
 * The position follows the mouse click and is pulled back when it is next to the viewport edge, so the
 * menu is not half cut off.
 *
 * Where everything landed after the business layer was wired in on 2026-10-23 (`ops` in `OnlineStart.tsx`):
 *   - Pin, archive, manual order and groups are all recorded only in this browser (`vibeOrg.ts`);
 *     archived items are in the "Archived" card at the bottom of the sidebar, where right-click offers
 *     "Unarchive";
 *   - Groups can be renamed and deleted (deleting a group just puts its projects back under "Projects"
 *     and leaves the projects themselves alone); projects get an extra "Move to group" entry;
 *   - Cloud projects and cloud chats cannot be renamed here in this version (chats have no rename entry,
 *     `workflow/production.md` "Cloud chats"; renaming a project needs an interface of the document
 *     service, which does not exist yet), so that item is grayed out with an explanation on hover;
 *     deleting a chat needs a confirmation first and cannot be undone (`product/agent.md` "Chat limits
 *     and deletion"); deleting a cloud project is not done here in this version, grayed out with an
 *     explanation.
 *   - Projects in the sidebar that are **expanded but not opened** (issue #15, `browseChats.ts`): the
 *     chats under them can only be viewed and clicked into, and all four items are grayed out with the
 *     explanation "Open this project first": deleting a chat goes through the service currently connected
 *     to that project, and pin and archive are also recorded under the currently open project.
 */
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { TreeKind } from "./treeKind";
import type { MoveTarget } from "./vibeOrg";
import { tr } from "../i18n/index.ts";

export interface MenuAt {
  id: string;
  kind: TreeKind;
  name: string;
  pinned: boolean;
  /** Mouse click position (viewport coordinates) */
  x: number;
  y: number;
}

/** Roughly how big the menu is, used to decide whether to pull it back. The width is aligned with the min-width of `.ps-menu` */
const MENU = { w: 168, h: 148, pad: 8 };
/** Menu height added by each additional "Move to group" item */
const ITEM_H = 30;

const KIND_WORD: Record<TreeKind, string> = { group: tr("Group"), project: tr("Project"), chat: tr("chat") };

/** Explanation for when an item cannot be done; when given, the item is grayed out and the text is attached to hover */
export type MenuBlock = string | null | undefined;

export function RowMenu(props: {
  at: MenuAt;
  onClose: () => void;
  onRename: () => void;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /** This row is already archived: the "Archive" item becomes "Unarchive" */
  archived?: boolean;
  renameBlocked?: MenuBlock;
  deleteBlocked?: MenuBlock;
  /**
   * Explanation for when pin and archive cannot be done (issue #15): chats listed in browse state belong
   * to **another** project, while pin and archive are recorded under "the currently open project", so
   * doing it here would land on the wrong project. Open that project first, then organize
   */
  pinBlocked?: MenuBlock;
  archiveBlocked?: MenuBlock;
  /**
   * Projects only: which group to move to (`null` means move out of the group). A `blocked` value means
   * it cannot be put in (a local project into a cloud group, etc.): grayed out with an explanation
   */
  moveTargets?: MoveTarget[];
  onMove?: (groupId: string | null) => void;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = box.current?.querySelector<HTMLButtonElement>("button");
    first?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    // Clicking elsewhere or scrolling closes it: use capture so the row's own handler does not swallow the event
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", props.onClose, true);
    window.addEventListener("resize", props.onClose);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", props.onClose, true);
      window.removeEventListener("resize", props.onClose);
    };
  }, [props]);

  // Pull back when next to the right or bottom edge
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const left = Math.min(props.at.x, vw - MENU.w - MENU.pad);
  const h = MENU.h + (props.moveTargets?.length ?? 0) * ITEM_H;
  const top = Math.max(MENU.pad, Math.min(props.at.y, vh - h - MENU.pad));

  const item = (label: string, onPick: () => void, extra?: { danger?: boolean; pc?: string; blocked?: MenuBlock }) => (
    <button
      key={label}
      type="button"
      className={`ps-menu-item${extra?.danger ? " is-danger" : ""}`}
      data-pc={extra?.pc}
      disabled={!!extra?.blocked}
      title={extra?.blocked ?? undefined}
      onClick={() => {
        onPick();
        props.onClose();
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={box}
      className="ps-menu"
      role="menu"
      aria-label={tr("Actions for {0} \"{1}\"", KIND_WORD[props.at.kind], props.at.name)}
      data-pc="start-row-menu"
      style={{ left, top }}
    >
      <div className="ps-menu-head" title={props.at.name}>{props.at.name}</div>
      {item(tr("Rename"), props.onRename, { pc: "start-menu-rename", blocked: props.renameBlocked })}
      {!props.archived && item(props.at.pinned ? tr("Unpin") : tr("Bring to front"), props.onPin, { pc: "start-menu-pin", blocked: props.pinBlocked })}
      {item(props.archived ? tr("Unarchive") : tr("Archive"), props.onArchive, { pc: "start-menu-archive", blocked: props.archiveBlocked })}
      {props.moveTargets && props.onMove && props.moveTargets.length > 0 && <div className="ps-menu-sep" />}
      {props.moveTargets && props.onMove && props.moveTargets.map((g) =>
        item(g.id === null ? tr("Remove from group") : tr("Move to \"{0}\"", g.name), () => props.onMove!(g.id), { pc: "start-menu-move", blocked: g.blocked }))}
      <div className="ps-menu-sep" />
      {item(tr("Delete"), props.onDelete, { danger: true, pc: "start-menu-delete", blocked: props.deleteBlocked })}
    </div>
  );
}
