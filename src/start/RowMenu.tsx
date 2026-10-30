/**
 * 侧栏行的右键菜单:重命名 / 置顶 / 归档 / 删除。
 *
 * 三种行(分组、项目、Agent 对话)共用这一个。按 Esc、点别处、滚动都关掉;上下键在项里走,
 * 回车选中 —— 右键菜单只能用鼠标开,但开出来之后得能用键盘走完,不然用读屏的人卡在这儿。
 *
 * 位置按鼠标点,贴着视口边时往回收,免得菜单被切掉一半。
 *
 * 2026-10-23 接业务层后各样落在哪(`OnlineStart.tsx` 的 `ops`):
 *   - 置顶、归档、手排顺序、分组都只记在这台浏览器里(`vibeOrg.ts`);归档的东西在侧栏最下面「已归档」那张卡里,
 *     在那儿右键是「取消归档」;
 *   - 分组可以改名、删除(删分组只是把里面的项目放回「项目」,项目本身不动);项目多一组「移到分组」;
 *   - 云端项目、云端对话这一版不能在这里改名(对话没有改名入口,`workflow/production.md`「云端对话」;项目改名要文档服务的
 *     接口,还没有),那一项置灰并悬停说明;删除对话要先确认、不能撤销(`product/agent.md`「对话的上限与删除」);
 *     删除云端项目这一版不在这里做,置灰并说明。
 *   - 侧栏里**展开着但没打开**的项目(issue #15,`browseChats.ts`):它底下那些对话只能看、只能点进去,
 *     四项全部置灰并说明「先打开这个项目」—— 删对话走的是当前连着那个项目的服务,置顶归档也记在当前项目名下。
 */
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { TreeKind } from "./treeKind";
import type { MoveTarget } from "./vibeOrg";

export interface MenuAt {
  id: string;
  kind: TreeKind;
  name: string;
  pinned: boolean;
  /** 鼠标点的位置(视口坐标) */
  x: number;
  y: number;
}

/** 菜单大概多大,用来判断要不要往回收。宽度和 `.ps-menu` 的 min-width 对齐 */
const MENU = { w: 168, h: 148, pad: 8 };
/** 「移到分组」每多一项,菜单高这么多 */
const ITEM_H = 30;

const KIND_WORD: Record<TreeKind, string> = { group: "分组", project: "项目", chat: "对话" };

/** 一项做不了时的说明;给了就置灰并挂在悬停上 */
export type MenuBlock = string | null | undefined;

export function RowMenu(props: {
  at: MenuAt;
  onClose: () => void;
  onRename: () => void;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /** 这一行已经归档了:「归档」那一项换成「取消归档」 */
  archived?: boolean;
  renameBlocked?: MenuBlock;
  deleteBlocked?: MenuBlock;
  /**
   * 置顶、归档做不了时的说明(issue #15):浏览态列出来的对话属于**别的**项目,
   * 而置顶归档记的是「当前打开的项目」名下,在这里做会落到别人头上。先打开那个项目再整理
   */
  pinBlocked?: MenuBlock;
  archiveBlocked?: MenuBlock;
  /** 项目才有:移到哪个分组(`null` 是移出分组)。`blocked` 有值是放不进去(本地项目对云端分组等):置顶灰并说明 */
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
    // 点别处、滚动都关:用 capture,免得被行自己的 handler 吃掉
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

  // 贴着右边或下边时往回收
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
      aria-label={`${KIND_WORD[props.at.kind]}「${props.at.name}」的操作`}
      data-pc="start-row-menu"
      style={{ left, top }}
    >
      <div className="ps-menu-head" title={props.at.name}>{props.at.name}</div>
      {item("重命名", props.onRename, { pc: "start-menu-rename", blocked: props.renameBlocked })}
      {!props.archived && item(props.at.pinned ? "取消置顶" : "置顶", props.onPin, { pc: "start-menu-pin", blocked: props.pinBlocked })}
      {item(props.archived ? "取消归档" : "归档", props.onArchive, { pc: "start-menu-archive", blocked: props.archiveBlocked })}
      {props.moveTargets && props.onMove && props.moveTargets.length > 0 && <div className="ps-menu-sep" />}
      {props.moveTargets && props.onMove && props.moveTargets.map((g) =>
        item(g.id === null ? "移出分组" : `移到「${g.name}」`, () => props.onMove!(g.id), { pc: "start-menu-move", blocked: g.blocked }))}
      <div className="ps-menu-sep" />
      {item("删除", props.onDelete, { danger: true, pc: "start-menu-delete", blocked: props.deleteBlocked })}
    </div>
  );
}
