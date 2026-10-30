/**
 * 左侧栏:全部项目,三级结构(用户 2026-10-23 定的形状)。
 *
 *   分组
 *     ├ 项目
 *     │   └ 项目 Agent(这个项目里的 Agent 对话)
 *     └ 分组 Agent(跨这个分组里几个项目的对话)
 *
 * 三种东西各有自己的前置图标:分组是叠起来的方块,项目是取景框,Agent 是一颗星芒并染上 Agent 专属色
 * (`--ui-agent`,和编辑器 rail 上的 Agent 头像同一个色)。层级用缩进和一条竖导线表示,不画逐行的拐角 ——
 * 拐角要分「最后一个」和「中间的」,行一多就容易错位。
 *
 * 每一行都能右键(重命名 / 置顶 / 归档 / 删除,见 `RowMenu.tsx`)、都能拖着排序。**置顶和排序都只在
 * 自己同级里生效**:分组里的项目 A 置顶,只在那个分组里顶上去(规则与纯函数在 `treeState.ts`)。
 * 右边那条缝能拖,改侧栏宽度,记在本机(`sideWidth.ts`)。
 *
 * 点分组把右边那排筛成这个分组里的项目;点项目名进这个项目(连上云端文档服务,`OnlineStart.tsx` 的 `openProject`),
 * 它底下列出当前账号看得到的项目 Agent(云端 Agent 对话)和一行「新对话」;点 Agent 进聊天页。
 *
 * **展开和打开是两回事**(issue #15,2026-10-26):行首那颗小三角只管展开 / 收起,不切换当前项目,
 * 想同时展开几个项目就展开几个;点项目名才是打开。没打开的项目底下列的是只读的一份(`browseChats.ts` 现取一次
 * 那个项目的委托票据去要列表),那些对话只能点进去 —— 点了就是打开那个项目并进那条对话。
 * 给了 `browse` 才有这套行为:桌面版的本机项目没有这条路(对话在当前打开的那个项目的本机状态里),照旧只有打开的那个能展开。
 * 搜索只筛这一栏(右边那排跟着当前分组走,不跟搜索走),免得一边打字一边整页都在跳;
 * 搜得到的只有已经展开过的项目,这一点在搜索框底下写明。
 *
 * 2026-10-23 接业务层:项目来自云端项目列表(桌面版是本机草稿),对话来自云端 Agent 服务(桌面版是本机 Agent)。
 * 分组分两套、互相放不进:本地分组装本机草稿项目、存本机;云端分组装云端项目、存云端(`vibeOrg.ts` 文件头)。
 * 每个分组、每个项目都带 `realm`,右键「移到分组」里另一套的分组置灰并说明。「分组 Agent」语义里没有,这一版不做。
 * 归档的东西收在最下面「已归档」那一段里,右键能取消归档。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { ReactNode } from "react";
import { RowMenu, type MenuAt, type MenuBlock } from "./RowMenu";
import { SIDE_WIDTH } from "./sideWidth";
import { WidthGrip } from "./WidthGrip";
import type { TreeKind } from "./treeKind";
import { ordered, visible, type Place } from "./treeState";
import type { VibeChat, VibeGroup, VibeProject } from "./types";
import { moveTargetsFor } from "./vibeOrg";

/**
 * 整块筛选用的那两行(「全部项目」和「没放进分组」)先归档,默认不显示 —— **用户 2026-10-23 要求的**:
 * 「这个块不需要,归档他」「这两个也不需要,直接按条目显示项目」。代码留着,改回 true 就回来;
 * 记录另见 `docs/plan/user-decisions-2026-10-23.md`。
 *
 * 它们没了之后:没放进分组的项目在「项目」那张卡里直接一条条列出来;要筛回「全部」靠顶栏那颗房子
 * (`OnlineStart.tsx` 的 `onHome` 一并把作用域设回 all)。
 */
const SHOW_SCOPE_ROWS = false;

/** 右边那排现在显示哪一堆 */
export type Scope = { kind: "all" } | { kind: "group"; id: string } | { kind: "loose" };

export const scopeKeyOf = (s: Scope): string => (s.kind === "group" ? `group:${s.id}` : s.kind);

/** 侧栏对外要的一组改动。全由 `OnlineStart` 拿着状态去做,这一栏只管什么时候调 */
export interface TreeOps {
  rename: (kind: TreeKind, id: string, name: string) => void;
  pin: (kind: TreeKind, id: string) => void;
  /** 归档 / 取消归档(按它现在的状态切) */
  archive: (kind: TreeKind, id: string) => void;
  remove: (kind: TreeKind, id: string) => void;
  reorder: (kind: TreeKind, dragId: string, overId: string, place: Place) => void;
  /** 项目移到某个分组(null 是移出分组) */
  move: (projectId: string, groupId: string | null) => void;
  /** 这一行哪几项做不了、为什么 */
  blocked: (kind: TreeKind, id: string) => { rename?: MenuBlock; remove?: MenuBlock; pin?: MenuBlock; archive?: MenuBlock };
}

/**
 * 展开没打开的项目时,它底下那一份对话从哪来(`browseChats.ts`;给了才允许展开没打开的项目)。
 * 桌面版不给:那边的对话在当前打开项目的本机状态里,没有这条路
 */
export interface BrowseSide {
  /** 用户展开了一个没打开的项目:该去取它的对话列表了 */
  open: (projectId: string) => void;
  /** 这一支底下写的那一行(正在取、取不到、这个项目没有云端 Agent…);没有就不写 */
  note: (projectId: string) => { text: string; retry?: () => void } | null;
}

/** 分组:两片叠起来的方块 */
function GroupIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3" y="7" width="13" height="13" rx="2" />
      <path d="M7.5 7V5.5A1.5 1.5 0 0 1 9 4h10.5A1.5 1.5 0 0 1 21 5.5V16a1.5 1.5 0 0 1-1.5 1.5H18" />
    </svg>
  );
}

/** 项目:取景框 */
function ProjectIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="M8 5.5v13M16 5.5v13" />
    </svg>
  );
}

/** Agent:星芒 */
function AgentIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.8c.5 4.3 2.1 6.1 6.4 6.6-4.3.5-5.9 2.3-6.4 6.6-.5-4.3-2.1-6.1-6.4-6.6 4.3-.5 5.9-2.3 6.4-6.6Z" />
      <path d="M18.4 15.2c.3 2.3 1.1 3.2 3.4 3.5-2.3.3-3.1 1.2-3.4 3.5-.3-2.3-1.1-3.2-3.4-3.5 2.3-.3 3.1-1.2 3.4-3.5Z" opacity="0.65" />
    </svg>
  );
}

/** 全部项目:网格 */
function AllIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}

/** 置顶的那个小图钉 */
function PinIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M14.2 2.3 21.7 9.8l-1.8 1.8-1.5-.5-3.6 3.6.4 3.3-1.7 1.7-4-4-4.6 4.6-1.1-1.1 4.6-4.6-4-4 1.7-1.7 3.3.4 3.6-3.6-.5-1.5z" />
    </svg>
  );
}

/** 一行要的全部东西。三种行共用这一个渲染器,否则右键、拖动、重命名要抄三遍 */
interface RowSpec {
  kind: TreeKind;
  id: string;
  name: string;
  pinned: boolean;
  /** 同级的键:只有键相同的两行之间才允许拖动排序 */
  sib: string;
  icon: JSX.Element;
  /** 有下一层时给箭头;`undefined` 是叶子(位置仍然留着,好对齐) */
  expanded?: boolean;
  /**
   * 给了的话,行首那颗小三角是一颗**单独的键**:点它只展开 / 收起,不触发 `onClick`(issue #15)。
   * 不给就还是一个纯标记(分组那种点整行就展开的)
   */
  onToggle?: () => void;
  count?: number;
  current?: boolean;
  className?: string;
  pc: string;
  label: string;
  onClick: () => void;
}

export function ProjectSidebar(props: {
  groups: VibeGroup[];
  projects: VibeProject[];
  /** 看得到的对话:此刻连着那个项目的实时一份,加上展开过的别的项目那份只读的(`browse`) */
  chats: VibeChat[];
  /** 此刻连着的项目;它那一行标成当前项,缺省展开 */
  connectedId: string | null;
  /** 没打开的项目底下那一份对话打哪来;不给就只有打开的那个项目能展开(桌面版) */
  browse?: BrowseSide;
  scope: Scope;
  onScope: (s: Scope) => void;
  onCreate: () => void;
  /** 新建项目做不了(没登录、游客已经建过)时的说明 */
  createBlocked?: string | null;
  onOpen: (id: string) => void;
  onOpenChat: (chat: VibeChat) => void;
  onNewChat: (projectId: string) => void;
  /** 某个项目底下的「新对话」开不了（游客每个项目只能开一个对话）时的说明；有说明的那一行置灰、悬停写它，点一下仍交给 `onNewChat`（由它把这句话摆出来） */
  newChatBlocked?: (projectId: string) => string | null;
  onNewGroup: () => void;
  /**
   * 「新建分组」那一行悬停时说的话:这一套分组存在哪、装什么(本地分组 / 云端分组,见 `vibeOrg.ts` 文件头)
   */
  groupNote?: string;
  /** 新建分组做不了(游客没有分组)时的说明;给了就置灰并挂在悬停上 */
  newGroupBlocked?: string | null;
  /** 「分组」那张卡里「新建分组」下面的一行状态(云端分组没同步上时);没有就不显示 */
  groupStatus?: string | null;
  /** 「项目」那张卡顶上的一行状态(正在取列表、取不到、重试);没有就不显示 */
  notice?: ReactNode;
  /** 聊天页正开着的那条对话:它那一行标成当前项 */
  openChatId: string | null;
  /** 收起来了没有。收起时整条滑出去、宽度收到 0,收起键在顶栏上 */
  collapsed: boolean;
  ops: TreeOps;
  width: number;
  onWidth: (px: number) => void;
  onWidthCommit: (px: number) => void;
  /**
   * 在当前宽度上加减。方向键必须走这一条,不能自己算 `width + step` ——
   * 按住方向键时连发的几下都在同一帧里,每一下读到的 `width` 都还是旧的,算出来是同一个数,宽度就卡住不动了。
   */
  onWidthNudge: (delta: number) => void;
}): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /** 每张卡收起来没有(用户 2026-10-23:每一个块都可以收起,和右边那条拓展栏一样)。缺省都是开的 */
  const [cards, setCards] = useState<Record<string, boolean>>({});
  const cardOpen = (k: string) => cards[k] !== false;
  const toggleCard = (k: string) => setCards((c) => ({ ...c, [k]: !cardOpen(k) }));
  const [query, setQuery] = useState("");
  /** 搜索框是不是正被用着(点进去了);打了字的话松开焦点也不收 —— 收回去就看不见自己搜的是什么了 */
  const [typing, setTyping] = useState(false);
  /**
   * 「新建项目」那颗键有多宽。搜索框平时就停在它左边(`right` 给到这个数),展开时 `right` 走到 0 盖住它。
   * 量出来而不是写死:键上的字、字号、皮肤换了都不用回来改这个数。
   */
  const [newW, setNewW] = useState(0);
  const newBtn = useRef<HTMLButtonElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = newBtn.current;
    if (!el) return;
    const measure = () => setNewW(el.offsetWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [renaming, setRenaming] = useState<{ kind: TreeKind; id: string; name: string } | null>(null);
  /** 正在拖的那一行;dragover 时读它判同级(dataTransfer 在 dragover 里读不到内容) */
  const drag = useRef<{ kind: TreeKind; id: string; sib: string } | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; place: Place } | null>(null);

  const q = query.trim().toLowerCase();
  const hit = (text: string) => !q || text.toLowerCase().includes(q);
  /** 搜索框展开着没有:点进去了,或者里面还有字 */
  const searchOpen = typing || query !== "";

  // 归档的不进树;显示顺序由 ordered 定(置顶的在自己这一段的最前面)
  const groups = ordered(visible(props.groups));
  const allProjects = visible(props.projects);
  const allChats = visible(props.chats);

  const chatsOfProject = (id: string) => ordered(allChats.filter((c) => c.projectId === id));
  /** 项目自己名字命中,或它底下哪条对话命中,都算要显示 */
  const projectShows = (p: VibeProject) => hit(p.name) || chatsOfProject(p.id).some((c) => hit(c.name));
  const projectsOf = (groupId: string | null) =>
    ordered(allProjects.filter((p) => p.groupId === groupId && projectShows(p)));

  /** 同级的键:分组一级,同一分组里的项目一级,挂在同一个项目(或分组)上的对话各一级 */
  const chatSib = (c: VibeChat) => `chat:p:${c.projectId}`;
  const projectSib = (p: VibeProject) => `project:${p.realm}:${p.groupId ?? "loose"}`;
  const archivedGroups = props.groups.filter((g) => g.archived);
  const archivedProjects = props.projects.filter((p) => p.archived);
  const archivedChats = props.chats.filter((c) => c.archived);
  const archivedCount = archivedGroups.length + archivedProjects.length + archivedChats.length;

  const current = props.scope;
  const isAt = (s: Scope) =>
    s.kind === current.kind && (s.kind !== "group" || (current.kind === "group" && s.id === current.id));

  /**
   * 一段的头:和右边那条拓展栏的段头同一套(`.ps-card-*`),点了收起里面那一截。
   * 整栏是**一张**面板,段与段之间不再各自成卡(issue #5,形状在 `start.css` 的 `.ps-side-scroll`)。
   */
  const cardHead = (key: string, title: string, count: number): JSX.Element => (
    <div className="ps-card-head">
      <button
        type="button"
        className="ps-card-toggle"
        data-pc="start-side-card"
        data-card={key}
        aria-expanded={cardOpen(key)}
        onClick={() => toggleCard(key)}
      >
        <span className="ps-card-caret" data-open={cardOpen(key)} aria-hidden="true">›</span>
        {title}
      </button>
      <span className="ps-card-count">{count}</span>
    </div>
  );

  /** 一行。右键、拖动、重命名都在这儿,三种行只是传进来的 spec 不同 */
  const row = (spec: RowSpec): JSX.Element => {
    const isRenaming = renaming?.kind === spec.kind && renaming.id === spec.id;
    const dropping = dropAt?.id === spec.id ? dropAt.place : null;
    const common = {
      "data-dragging": drag.current?.id === spec.id || undefined,
      "data-drop": dropping ?? undefined,
    };

    if (isRenaming) {
      // 改名时那一行换成输入框。<input> 不能放在 <button> 里,所以整行换成 div
      return (
        <div key={spec.id} className={`ps-row is-renaming${spec.className ? ` ${spec.className}` : ""}`} data-pc={spec.pc} {...common}>
          <span className="ps-row-caret" data-empty={spec.expanded === undefined} aria-hidden="true">›</span>
          <span className={`ps-row-icon${spec.kind === "chat" ? " is-agent" : ""}`}>{spec.icon}</span>
          <input
            className="ps-rename"
            data-pc="start-rename-input"
            autoFocus
            defaultValue={spec.name}
            aria-label={`重命名${spec.name}`}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                props.ops.rename(spec.kind, spec.id, e.currentTarget.value);
                setRenaming(null);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRenaming(null);
              }
            }}
            // 点到别处就当改完了(和改名框里按回车一致);按 Esc 走上面那一支,不会走到这里
            onBlur={(e) => {
              props.ops.rename(spec.kind, spec.id, e.currentTarget.value);
              setRenaming(null);
            }}
          />
        </div>
      );
    }

    /*
     * 一行是**一个 div 里的两颗键**(issue #15):左边小三角只管展开 / 收起,右边整条是「点进去」。
     * 不做成「一颗键里套一个 span、点它时 stopPropagation」—— 那样拖拽的 `onMouseDown` 拦不住,
     * 键盘也走不到小三角上。右键菜单、放下(drop)挂在外面这个 div 上(位置按整行算),
     * 拖起(dragstart)挂在主键上,和原来一行一颗键时的手感一样。
     */
    return (
      <div
        key={spec.id}
        className={`ps-row${spec.className ? ` ${spec.className}` : ""}`}
        {...common}
        data-current={spec.current || undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          setRenaming(null);
          setMenu({ id: spec.id, kind: spec.kind, name: spec.name, pinned: spec.pinned, x: e.clientX, y: e.clientY });
        }}
        onDragOver={(e) => {
          const d = drag.current;
          // 只许同级之间排序:别的一律不接(不 preventDefault 就是不允许放)
          if (!d || d.id === spec.id || d.kind !== spec.kind || d.sib !== spec.sib) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const box = e.currentTarget.getBoundingClientRect();
          setDropAt({ id: spec.id, place: e.clientY < box.top + box.height / 2 ? "before" : "after" });
        }}
        onDragLeave={() => setDropAt((at) => (at?.id === spec.id ? null : at))}
        onDrop={(e) => {
          const d = drag.current;
          if (!d || !dropAt) return;
          e.preventDefault();
          props.ops.reorder(spec.kind, d.id, spec.id, dropAt.place);
          drag.current = null;
          setDropAt(null);
        }}
      >
        {spec.onToggle ? (
          <button
            type="button"
            className="ps-row-caret ps-row-caret-btn"
            data-pc={`${spec.pc}-caret`}
            data-group={spec.kind === "group" ? spec.id : undefined}
            data-project={spec.kind === "project" ? spec.id : undefined}
            data-agent={spec.kind === "chat" ? spec.id : undefined}
            data-open={spec.expanded}
            aria-expanded={!!spec.expanded}
            aria-label={`${spec.expanded ? "收起" : "展开"}${spec.name}`}
            title={spec.expanded ? "收起" : "展开，看这个项目里的对话"}
            onClick={spec.onToggle}
          >
            ›
          </button>
        ) : (
          <span className="ps-row-caret" data-empty={spec.expanded === undefined} data-open={spec.expanded} aria-hidden="true">›</span>
        )}
        <button
          type="button"
          className="ps-row-main"
          data-pc={spec.pc}
          data-group={spec.kind === "group" ? spec.id : undefined}
          data-project={spec.kind === "project" ? spec.id : undefined}
          data-agent={spec.kind === "chat" ? spec.id : undefined}
          aria-label={spec.label}
          aria-expanded={spec.onToggle ? undefined : spec.expanded}
          aria-current={spec.current}
          title={spec.name}
          draggable
          onClick={spec.onClick}
          onDragStart={(e) => {
            drag.current = { kind: spec.kind, id: spec.id, sib: spec.sib };
            e.dataTransfer.effectAllowed = "move";
            // 有的浏览器不带数据就不开始拖
            e.dataTransfer.setData("text/plain", spec.id);
          }}
          onDragEnd={() => {
            drag.current = null;
            setDropAt(null);
          }}
        >
          <span className={`ps-row-icon${spec.kind === "chat" ? " is-agent" : ""}`}>{spec.icon}</span>
          <span className="ps-row-name">{spec.name}</span>
          {spec.pinned && <span className="ps-row-pin" title="已置顶"><PinIcon /></span>}
          {spec.count !== undefined && <span className="ps-row-count">{spec.count}</span>}
        </button>
      </div>
    );
  };

  const chatRow = (chat: VibeChat) =>
    row({
      kind: "chat",
      id: chat.id,
      name: chat.state === "running" ? `${chat.name} · 进行中` : chat.visibility === "private" ? `${chat.name} · 私有${chat.readOnly ? "（只读）" : ""}` : chat.name,
      pinned: !!chat.pinned,
      sib: chatSib(chat),
      icon: <AgentIcon />,
      className: "is-agent",
      current: props.openChatId === chat.id,
      pc: "start-side-agent",
      label: `Agent 对话 ${chat.name}${chat.visibility === "private" ? "，私有" : ""}${chat.pinned ? "（已置顶）" : ""}`,
      onClick: () => props.onOpenChat(chat),
    });

  /** 一个项目,连同它底下的项目 Agent */
  const newChatRow = (projectId: string) => {
    const blocked = props.newChatBlocked?.(projectId) ?? null;
    return (
    <button key="new-chat" type="button" className={`ps-row is-agent${blocked ? " is-blocked" : ""}`} data-pc="start-side-new-chat" aria-label="新对话"
      aria-disabled={blocked ? true : undefined} title={blocked ?? undefined} onClick={() => props.onNewChat(projectId)}>
      <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
      <span className="ps-row-icon is-agent" aria-hidden="true">＋</span>
      <span className="ps-row-name ps-muted">新对话</span>
    </button>
    );
  };

  const projectBlock = (p: VibeProject) => {
    const chats = chatsOfProject(p.id);
    const connected = props.connectedId === p.id;
    const browse = props.browse;
    /*
     * 搜索时自动展开命中的那一支:不然搜到了却看不见在哪。
     * 平时:用户自己点过小三角的听他的;没点过时,连着的那个缺省展开,别的缺省收着(issue #15)。
     * `browse` 不给(桌面版)时只有连着的那个展得开 —— 别的项目底下没有东西可列。
     */
    const expanded = q ? chats.some((c) => hit(c.name)) : (open[p.id] ?? connected);
    const canExpand = !!browse || connected;
    const toggle = () => {
      const next = !(open[p.id] ?? connected);
      setOpen((o) => ({ ...o, [p.id]: next }));
      // 展开一个没打开的项目:这时才去取它的对话(收起、已经打开着的那个都不取)
      if (next && browse && !connected) browse.open(p.id);
    };
    const note = canExpand && expanded && browse && !connected ? browse.note(p.id) : null;
    return (
      <div key={p.id}>
        {row({
          kind: "project",
          id: p.id,
          name: p.name,
          pinned: !!p.pinned,
          sib: projectSib(p),
          icon: <ProjectIcon />,
          expanded: canExpand ? expanded : undefined,
          onToggle: canExpand ? toggle : undefined,
          current: connected && !props.openChatId,
          pc: "start-side-project",
          label: `项目 ${p.name}${chats.length ? `，${chats.length} 个 Agent 对话` : ""}${p.pinned ? "，已置顶" : ""}`,
          onClick: () => props.onOpen(p.id),
        })}
        {canExpand && expanded && (
          <div className="ps-sub">
            {chats.map(chatRow)}
            {note && (
              <p className="ps-side-hint" role="status" data-pc="start-side-browse-note" data-project={p.id}>
                {note.text}
                {note.retry && (
                  <button type="button" className="ps-link" data-pc="start-side-browse-retry" onClick={note.retry}>重试</button>
                )}
              </p>
            )}
            {newChatRow(p.id)}
          </div>
        )}
      </div>
    );
  };

  /** 「已归档」那张卡里的一行:点了、右键都出菜单(取消归档、删除),不进去 */
  const archivedRow = (kind: TreeKind, id: string, name: string, icon: JSX.Element) => (
    <button key={`${kind}:${id}`} type="button" className={`ps-row is-archived${kind === "chat" ? " is-agent" : ""}`} data-pc="start-side-archived-row"
      data-kind={kind} data-id={id} aria-label={`已归档的${kind === "group" ? "分组" : kind === "project" ? "项目" : "对话"} ${name}`} title={`${name}（右键取消归档）`}
      onClick={(e) => setMenu({ id, kind, name, pinned: false, x: e.clientX, y: e.clientY })}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ id, kind, name, pinned: false, x: e.clientX, y: e.clientY }); }}>
      <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
      <span className={`ps-row-icon${kind === "chat" ? " is-agent" : ""}`}>{icon}</span>
      <span className="ps-row-name ps-muted">{name}</span>
    </button>
  );

  return (
    <aside
      className="ps-side"
      data-pc="start-side"
      data-collapsed={props.collapsed}
      /* 收起就是把 flex-basis 收到 0;宽度本来就是行内样式给的,收起也得走行内,不然类选择器压不过它 */
      style={{ flexBasis: props.collapsed ? 0 : `${props.width}px` }}
    >
      {/* 里面这一层钉住原来的宽度:收的时候内容整块滑出去,不会先被挤成一条再消失 */}
      <div className="ps-side-inner" style={{ width: `${props.width}px` }}>
      {/* 面板只有一张(issue #5):搜索与新建那一行、下面的列表,都在这张里面 */}
      <div className="ps-side-panel" data-pc="start-side-panel">
      {/*
        头一行:左边搜索、右边「新建项目」。点进搜索框,它向右长出去**盖住**新建那颗键(用户 2026-10-24),
        动画只动一个 `right`(240ms,和侧栏收起同一条缓动),没有位移抖动;收回去时新建键原样露出来 ——
        它一直在原地,只是被盖着。
      */}
      <div className="ps-side-head" data-searching={searchOpen}>
        <button ref={newBtn} type="button" className="ps-side-new" data-pc="start-side-new" disabled={!!props.createBlocked}
          title={props.createBlocked ?? undefined} aria-hidden={searchOpen || undefined} tabIndex={searchOpen ? -1 : undefined}
          onClick={props.onCreate}>
          <span aria-hidden="true">＋</span>新建项目
        </button>

        <label className="ps-search" style={newW ? { right: searchOpen ? 0 : newW + 6 } : undefined}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4.5 4.5" />
          </svg>
          <input
            ref={searchBox}
            type="search"
            value={query}
            /* 收着的时候只有一小条,长的那句放不下;展开了再写全 */
            placeholder={searchOpen ? "搜项目和对话" : "搜索"}
            aria-label="搜项目和对话"
            data-pc="start-side-search"
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            /* Esc:清空并退出,搜索框收回去,新建键露出来 */
            onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); searchBox.current?.blur(); } }}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/*
            清空那一颗:搜完了点它,搜索框收回去、新建键露出来。只有有字的时候在。
            `onMouseDown` 要拦掉 —— 它在 <label> 里,不拦的话按下去会把焦点送进输入框,清完又算「正在用」,收不回去。
          */}
          {query && (
            <button type="button" className="ps-search-clear" data-pc="start-side-search-clear" aria-label="清空搜索"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setQuery(""); setTyping(false); }}>
              ✕
            </button>
          )}
        </label>
      </div>

      <div className="ps-side-scroll">
        {/* 搜索搜得到的只有已经取回来的对话:没展开过的项目底下是什么,这一页还不知道(issue #15) */}
        {q && props.browse && (
          <p className="ps-side-hint" data-pc="start-side-search-scope">搜索只覆盖已经展开过的项目。</p>
        )}
        {SHOW_SCOPE_ROWS && (
        <div className="ps-side-group">
          <button
            type="button"
            className="ps-row"
            data-pc="start-scope-all"
            aria-label={`全部项目，共 ${allProjects.length} 个`}
            aria-current={isAt({ kind: "all" })}
            onClick={() => props.onScope({ kind: "all" })}
          >
            <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
            <span className="ps-row-icon"><AllIcon /></span>
            <span className="ps-row-name">全部项目</span>
            <span className="ps-row-count">{allProjects.length}</span>
          </button>
        </div>
        )}

        <div className="ps-side-group" data-open={cardOpen("groups")}>
          {cardHead("groups", "分组", groups.length)}
          {cardOpen("groups") && <div className="ps-side-body">
          {groups.map((g) => {
            const rows = projectsOf(g.id);
            const expanded = q ? rows.length > 0 : !!open[g.id];
            return (
              <div key={g.id}>
                {row({
                  kind: "group",
                  id: g.id,
                  name: g.name,
                  pinned: !!g.pinned,
                  sib: `group:${g.realm}`,
                  icon: <GroupIcon />,
                  expanded,
                  count: rows.length,
                  current: isAt({ kind: "group", id: g.id }),
                  pc: "start-scope-group",
                  label: `分组 ${g.name}，${rows.length} 个项目${g.pinned ? "，已置顶" : ""}`,
                  onClick: () => {
                    props.onScope({ kind: "group", id: g.id });
                    setOpen((o) => ({ ...o, [g.id]: !o[g.id] }));
                  },
                })}
                {expanded && (
                  <div className="ps-sub">
                    {rows.map(projectBlock)}
                    {rows.length === 0 && <p className="ps-side-hint">分组是空的：在项目上右键「移到分组」。</p>}
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" className="ps-row" data-pc="start-new-group" aria-label="新建分组" disabled={!!props.newGroupBlocked}
            title={props.newGroupBlocked ?? props.groupNote} onClick={props.onNewGroup}>
            <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
            <span className="ps-row-icon" aria-hidden="true">＋</span>
            <span className="ps-row-name ps-muted">新建分组</span>
          </button>
          {props.groupStatus && <div className="ps-side-hint" role="status" data-pc="start-group-status">{props.groupStatus}</div>}
          </div>}
        </div>

        <div className="ps-side-group" data-open={cardOpen("projects")}>
          {cardHead("projects", "项目", projectsOf(null).length)}
          {cardOpen("projects") && <div className="ps-side-body">
          {SHOW_SCOPE_ROWS && (
          <button
            type="button"
            className="ps-row"
            data-pc="start-scope-loose"
            aria-label={`未分组，${projectsOf(null).length} 个项目`}
            aria-current={isAt({ kind: "loose" })}
            onClick={() => props.onScope({ kind: "loose" })}
          >
            <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
            <span className="ps-row-icon"><AllIcon /></span>
            <span className="ps-row-name">没放进分组</span>
            <span className="ps-row-count">{projectsOf(null).length}</span>
          </button>
          )}
          {props.notice && <div className="ps-side-hint" role="status" data-pc="start-side-notice">{props.notice}</div>}
          {/* 没放进分组的项目直接一条条列,不再套在「没放进分组」那一行底下(用户 2026-10-23) */}
          {projectsOf(null).map(projectBlock)}
          </div>}
        </div>

        {archivedCount > 0 && (
          <div className="ps-side-group" data-open={cards.archived === true} data-pc="start-side-archived">
            {/* 已归档缺省收着:平时不占地方,要找回来才点开 */}
            <div className="ps-card-head">
              <button type="button" className="ps-card-toggle" data-pc="start-side-card" data-card="archived" aria-expanded={cards.archived === true}
                onClick={() => setCards((c) => ({ ...c, archived: c.archived !== true }))}>
                <span className="ps-card-caret" data-open={cards.archived === true} aria-hidden="true">›</span>
                已归档
              </button>
              <span className="ps-card-count">{archivedCount}</span>
            </div>
            {cards.archived === true && <div className="ps-side-body">
              {archivedGroups.map((g) => archivedRow("group", g.id, g.name, <GroupIcon />))}
              {archivedProjects.map((p) => archivedRow("project", p.id, p.name, <ProjectIcon />))}
              {archivedChats.map((c) => archivedRow("chat", c.id, c.name, <AgentIcon />))}
              <p className="ps-side-hint">右键「取消归档」放回原处。</p>
            </div>}
          </div>
        )}
      </div>
      </div>

      </div>

      {/* 右边那条缝:平时不画线,鼠标压上来才亮(`WidthGrip.tsx`)。收起时没有 */}
      {!props.collapsed && (
        <WidthGrip
          spec={SIDE_WIDTH}
          side="right"
          width={props.width}
          label="侧栏宽度"
          pc="start-side-grip"
          onWidth={props.onWidth}
          onWidthCommit={props.onWidthCommit}
          onWidthNudge={props.onWidthNudge}
        />
      )}

      {menu && (() => {
        const blocked = props.ops.blocked(menu.kind, menu.id);
        const project = menu.kind === "project" ? props.projects.find((p) => p.id === menu.id) : undefined;
        const archived = menu.kind === "group" ? !!props.groups.find((g) => g.id === menu.id)?.archived
          : menu.kind === "project" ? !!project?.archived : !!props.chats.find((c) => c.id === menu.id)?.archived;
        // 别的套的分组也列,置灰并说明(本地项目放不进云端分组,云端项目放不进本地分组)
        const moveTargets = project && !archived ? moveTargetsFor(project, props.groups) : undefined;
        return (
          <RowMenu
            at={menu}
            archived={archived}
            renameBlocked={blocked.rename}
            deleteBlocked={blocked.remove}
            pinBlocked={blocked.pin}
            archiveBlocked={blocked.archive}
            moveTargets={moveTargets}
            onMove={(gid) => props.ops.move(menu.id, gid)}
            onClose={() => setMenu(null)}
            onRename={() => setRenaming({ kind: menu.kind, id: menu.id, name: menu.name })}
            onPin={() => props.ops.pin(menu.kind, menu.id)}
            onArchive={() => props.ops.archive(menu.kind, menu.id)}
            onDelete={() => props.ops.remove(menu.kind, menu.id)}
          />
        );
      })()}
    </aside>
  );
}
