/**
 * Left sidebar: all projects, a three-level structure (the shape decided by the user on 2026-10-23).
 *
 *   Group
 *     ├ Project
 *     │   └ Project Agent (Agent chats in this project)
 *     └ Group Agent (chats spanning several projects in this group)
 *
 * Each of the three kinds has its own leading icon: a group is stacked squares, a project is a
 * viewfinder, and an Agent is a starburst tinted with the Agent-specific color
 * (`--ui-agent`, the same color as the Agent avatar on the editor rail). Levels are shown with
 * indentation and one vertical guide line; no per-row corner connectors are drawn, because corners
 * must distinguish "last" from "middle" and are easily misaligned once there are many rows.
 *
 * Every row can be right-clicked (rename / pin / archive / delete, see `RowMenu.tsx`) and dragged to
 * reorder. **Pinning and ordering only take effect among siblings**: pinning project A in a group only
 * moves it to the top within that group (rules and pure functions are in `treeState.ts`).
 * The seam on the right can be dragged to change the sidebar width, which is stored locally
 * (`sideWidth.ts`).
 *
 * Clicking a group filters the row on the right down to the projects in that group; clicking a project
 * name enters that project (connects to the cloud document service, `openProject` in
 * `OnlineStart.tsx`). Below it are listed the project Agents the current account can see (Cloud Agent
 * chats) and a "New chat" row; clicking an Agent goes to the chat page.
 *
 * **Expanding and opening are two different things** (issue #15, 2026-10-26): the small triangle at
 * the start of a row only expands / collapses and does not switch the current project; to expand
 * several projects, expand several. Clicking the project name is what opens it. Under a project that
 * is not open, a read-only copy is listed (`browseChats.ts` fetches that project's delegation ticket
 * once to request the list), and those chats can only be clicked into: clicking opens that project and
 * enters that chat.
 * This behavior exists only when `browse` is given: local projects in the desktop app have no such
 * path (chats live in the local state of the currently open project), so as before only the open one
 * can be expanded.
 * Search only filters this column (the row on the right follows the current group, not the search), so
 * the whole page does not jump while typing; search finds only projects that have been expanded, which
 * is stated under the search box.
 *
 * 2026-10-23 connected to the business layer: projects come from the cloud project list (local drafts
 * in the desktop app), and chats come from the cloud Agent service (local Agents in the desktop app).
 * Groups come in two sets that cannot hold each other's items: local groups hold local draft projects
 * and are stored locally; cloud groups hold cloud projects and are stored in the cloud (file header of
 * `vibeOrg.ts`). Every group and every project carries `realm`; in the right-click "Move to group"
 * menu, groups of the other set are grayed out with an explanation. "Group Agent" does not exist in
 * the semantics, so this version does not implement it.
 * Archived items are collected at the bottom in the "Archived" section, and right-click can unarchive
 * them.
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
import { tr } from "../i18n/index.ts";

/**
 * The two rows used for the whole-block filter ("All projects" and "Not in a group") are archived
 * first and hidden by default -- **requested by the user on 2026-10-23**:
 * "This block is not needed, archive it", "These two are not needed either, just show projects as
 * items". The code is kept; set it back to true and they return.
 * See also the record in `docs/plan/user-decisions-2026-10-23.md`.
 *
 * Without them: projects not in a group are listed one by one directly in the "Projects" card; to
 * filter back to "all", use the house icon in the top bar
 * (`onHome` in `OnlineStart.tsx` also resets the scope to all).
 */
const SHOW_SCOPE_ROWS = false;

/** Which set the row on the right currently shows */
export type Scope = { kind: "all" } | { kind: "group"; id: string } | { kind: "loose" };

export const scopeKeyOf = (s: Scope): string => (s.kind === "group" ? `group:${s.id}` : s.kind);

/** The set of changes the sidebar needs from outside. `OnlineStart` holds the state and performs all
 * of them; this column only decides when to call */
export interface TreeOps {
  rename: (kind: TreeKind, id: string, name: string) => void;
  pin: (kind: TreeKind, id: string) => void;
  /** Archive / unarchive (toggled according to its current state) */
  archive: (kind: TreeKind, id: string) => void;
  remove: (kind: TreeKind, id: string) => void;
  reorder: (kind: TreeKind, dragId: string, overId: string, place: Place) => void;
  /** Move a project to a group (null means move out of the group) */
  move: (projectId: string, groupId: string | null) => void;
  /** Which items of this row cannot be done, and why */
  blocked: (kind: TreeKind, id: string) => { rename?: MenuBlock; remove?: MenuBlock; pin?: MenuBlock; archive?: MenuBlock };
}

/**
 * Where the chats under a project that is not open come from when it is expanded (`browseChats.ts`;
 * expanding a project that is not open is only allowed when this is given).
 * Not given in the desktop app: there the chats live in the local state of the currently open
 * project, so there is no such path
 */
export interface BrowseSide {
  /** The user expanded a project that is not open: time to fetch its chat list */
  open: (projectId: string) => void;
  /** The line written under this branch (loading, cannot be loaded, this project has no Cloud Agent...);
   * if none, nothing is written */
  note: (projectId: string) => { text: string; retry?: () => void } | null;
}

/** Group: two stacked squares */
function GroupIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3" y="7" width="13" height="13" rx="2" />
      <path d="M7.5 7V5.5A1.5 1.5 0 0 1 9 4h10.5A1.5 1.5 0 0 1 21 5.5V16a1.5 1.5 0 0 1-1.5 1.5H18" />
    </svg>
  );
}

/** Project: viewfinder */
function ProjectIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="M8 5.5v13M16 5.5v13" />
    </svg>
  );
}

/** Agent: starburst */
function AgentIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.8c.5 4.3 2.1 6.1 6.4 6.6-4.3.5-5.9 2.3-6.4 6.6-.5-4.3-2.1-6.1-6.4-6.6 4.3-.5 5.9-2.3 6.4-6.6Z" />
      <path d="M18.4 15.2c.3 2.3 1.1 3.2 3.4 3.5-2.3.3-3.1 1.2-3.4 3.5-.3-2.3-1.1-3.2-3.4-3.5 2.3-.3 3.1-1.2 3.4-3.5Z" opacity="0.65" />
    </svg>
  );
}

/** All projects: grid */
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

/** The little pin for pinned items */
function PinIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M14.2 2.3 21.7 9.8l-1.8 1.8-1.5-.5-3.6 3.6.4 3.3-1.7 1.7-4-4-4.6 4.6-1.1-1.1 4.6-4.6-4-4 1.7-1.7 3.3.4 3.6-3.6-.5-1.5z" />
    </svg>
  );
}

/** Everything one row needs. The three kinds of rows share this one renderer; otherwise right-click,
 * dragging and renaming would have to be copied three times */
interface RowSpec {
  kind: TreeKind;
  id: string;
  name: string;
  pinned: boolean;
  /** Sibling key: drag-to-reorder is only allowed between two rows with the same key */
  sib: string;
  icon: JSX.Element;
  /** Gives the arrow when there is a next level; `undefined` is a leaf (the slot is still kept, for
   * alignment) */
  expanded?: boolean;
  /**
   * If given, the small triangle at the start of the row is a **separate button**: clicking it only
   * expands / collapses and does not trigger `onClick` (issue #15).
   * If not given, it is still a plain marker (as with groups, where clicking the whole row expands it)
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
  /** Visible chats: the live copy of the project connected right now, plus the read-only copies of other
   * projects that have been expanded (`browse`) */
  chats: VibeChat[];
  /** The project connected right now; its row is marked as the current item and expanded by default */
  connectedId: string | null;
  /** Where the chats under a project that is not open come from; if not given, only the open project can
   * be expanded (desktop app) */
  browse?: BrowseSide;
  scope: Scope;
  onScope: (s: Scope) => void;
  onCreate: () => void;
  /** Explanation for when creating a project is not possible (not logged in, the guest has already
   * created one) */
  createBlocked?: string | null;
  onOpen: (id: string) => void;
  onOpenChat: (chat: VibeChat) => void;
  onNewChat: (projectId: string) => void;
  /** Explanation for when "New chat" under a project cannot be opened (a guest can only open one chat per
   * project); the row with an explanation is grayed out and hover shows it, and a click is still passed
   * to `onNewChat` (which displays this sentence) */
  newChatBlocked?: (projectId: string) => string | null;
  onNewGroup: () => void;
  /**
   * Text shown when hovering the "New group" row: where this set of groups is stored and what it holds
   * (local groups / cloud groups, see the file header of `vibeOrg.ts`)
   */
  groupNote?: string;
  /** Explanation for when creating a group is not possible (guests have no groups); if given, the row is
   * grayed out and the text is attached to hover */
  newGroupBlocked?: string | null;
  /** The status line under "New group" in the "Groups" card (when cloud groups are not synced); if none,
   * not shown */
  groupStatus?: string | null;
  /** The status line at the top of the "Projects" card (loading the list, cannot be loaded, retry); if
   * none, not shown */
  notice?: ReactNode;
  /** The chat currently open on the chat page: its row is marked as the current item */
  openChatId: string | null;
  /** Whether it is collapsed. When collapsed, the whole thing slides out and the width shrinks to 0; the
   * collapse button is on the top bar */
  collapsed: boolean;
  ops: TreeOps;
  width: number;
  onWidth: (px: number) => void;
  onWidthCommit: (px: number) => void;
  /**
   * Add or subtract on the current width. Arrow keys must go through this one; do not compute
   * `width + step` yourself --
   * when an arrow key is held, the repeated presses all land in the same frame, and each one reads the
   * old `width`, computes the same number, and the width gets stuck.
   */
  onWidthNudge: (delta: number) => void;
}): JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /** Whether each card is collapsed (user, 2026-10-23: every block can be collapsed, same as the side
   * panel on the right). All open by default */
  const [cards, setCards] = useState<Record<string, boolean>>({});
  const cardOpen = (k: string) => cards[k] !== false;
  const toggleCard = (k: string) => setCards((c) => ({ ...c, [k]: !cardOpen(k) }));
  const [query, setQuery] = useState("");
  /** Whether the search box is in use (clicked into); if text has been typed, it does not collapse on
   * blur either -- collapsing would hide what you searched for */
  const [typing, setTyping] = useState(false);
  /**
   * How wide the "New project" button is. The search box normally sits to its left (`right` is set to
   * this number), and when expanded `right` goes to 0 and covers it.
   * Measured rather than hard-coded: if the button's text, font size or skin changes, this number does
   * not need to be revisited.
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
  /** The row being dragged; read it on dragover to check siblings (dataTransfer content cannot be read
   * during dragover) */
  const drag = useRef<{ kind: TreeKind; id: string; sib: string } | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; place: Place } | null>(null);

  const q = query.trim().toLowerCase();
  const hit = (text: string) => !q || text.toLowerCase().includes(q);
  /** Whether the search box is expanded: clicked into, or still has text in it */
  const searchOpen = typing || query !== "";

  // Archived items do not go into the tree; display order is decided by ordered (pinned items come first
  // in their own section)
  const groups = ordered(visible(props.groups));
  const allProjects = visible(props.projects);
  const allChats = visible(props.chats);

  const chatsOfProject = (id: string) => ordered(allChats.filter((c) => c.projectId === id));
  /** A match on the project's own name, or on any chat under it, counts as one to show */
  const projectShows = (p: VibeProject) => hit(p.name) || chatsOfProject(p.id).some((c) => hit(c.name));
  const projectsOf = (groupId: string | null) =>
    ordered(allProjects.filter((p) => p.groupId === groupId && projectShows(p)));

  /** Sibling key: groups are one level, projects in the same group are one level, and chats attached to
   * the same project (or group) are one level each */
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
   * Section header: the same set as the section headers of the side panel on the right (`.ps-card-*`);
   * clicking it collapses the part inside.
   * The whole column is **one** panel, and sections no longer each become a card (issue #5, shape in
   * `.ps-side-scroll` of `start.css`).
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

  /** One row. Right-click, dragging and renaming all live here; the three kinds of rows differ only in
   * the spec passed in */
  const row = (spec: RowSpec): JSX.Element => {
    const isRenaming = renaming?.kind === spec.kind && renaming.id === spec.id;
    const dropping = dropAt?.id === spec.id ? dropAt.place : null;
    const common = {
      "data-dragging": drag.current?.id === spec.id || undefined,
      "data-drop": dropping ?? undefined,
    };

    if (isRenaming) {
      // While renaming, the row is replaced with an input. <input> cannot go inside <button>, so the whole
      // row becomes a div
      return (
        <div key={spec.id} className={`ps-row is-renaming${spec.className ? ` ${spec.className}` : ""}`} data-pc={spec.pc} {...common}>
          <span className="ps-row-caret" data-empty={spec.expanded === undefined} aria-hidden="true">›</span>
          <span className={`ps-row-icon${spec.kind === "chat" ? " is-agent" : ""}`}>{spec.icon}</span>
          <input
            className="ps-rename"
            data-pc="start-rename-input"
            autoFocus
            defaultValue={spec.name}
            aria-label={tr("Rename {0}", spec.name)}
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
            // Clicking elsewhere counts as done (consistent with pressing Enter in the rename box); pressing Esc
            // takes the branch above and never gets here
            onBlur={(e) => {
              props.ops.rename(spec.kind, spec.id, e.currentTarget.value);
              setRenaming(null);
            }}
          />
        </div>
      );
    }

    /*
     * A row is **two buttons in one div** (issue #15): the small triangle on the left only expands /
     * collapses, and the whole strip on the right is "click to enter".
     * It is not made as "one button with a span inside, calling stopPropagation when it is clicked":
     * that way the drag `onMouseDown` cannot be intercepted, and the keyboard cannot reach the small
     * triangle. The context menu and drop are attached to the outer div (position is computed over the
     * whole row), and dragstart is attached to the main button, which feels the same as when a row was
     * one button.
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
          // Only reordering among siblings is allowed: accept nothing else (without preventDefault, dropping is
          // not allowed)
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
            aria-label={`${spec.expanded ? tr("Collapse") : tr("Expand")}${spec.name}`}
            title={spec.expanded ? tr("Collapse") : tr("Expand to see the chats in this project")}
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
            // Some browsers do not start dragging without data
            e.dataTransfer.setData("text/plain", spec.id);
          }}
          onDragEnd={() => {
            drag.current = null;
            setDropAt(null);
          }}
        >
          <span className={`ps-row-icon${spec.kind === "chat" ? " is-agent" : ""}`}>{spec.icon}</span>
          <span className="ps-row-name">{spec.name}</span>
          {spec.pinned && <span className="ps-row-pin" title={tr("Pinned")}><PinIcon /></span>}
          {spec.count !== undefined && <span className="ps-row-count">{spec.count}</span>}
        </button>
      </div>
    );
  };

  const chatRow = (chat: VibeChat) =>
    row({
      kind: "chat",
      id: chat.id,
      name: chat.state === "running" ? tr("{0} · running", chat.name) : chat.visibility === "private" ? tr("{0} · private{1}", chat.name, chat.readOnly ? tr(" (read-only)") : "") : chat.name,
      pinned: !!chat.pinned,
      sib: chatSib(chat),
      icon: <AgentIcon />,
      className: "is-agent",
      current: props.openChatId === chat.id,
      pc: "start-side-agent",
      label: tr("Agent chat {0}{1}{2}", chat.name, chat.visibility === "private" ? tr(", private") : "", chat.pinned ? tr(" (pinned)") : ""),
      onClick: () => props.onOpenChat(chat),
    });

  /** One project, together with the project Agents under it */
  const newChatRow = (projectId: string) => {
    const blocked = props.newChatBlocked?.(projectId) ?? null;
    return (
    <button key="new-chat" type="button" className={`ps-row is-agent${blocked ? " is-blocked" : ""}`} data-pc="start-side-new-chat" aria-label={tr("New chat")}
      aria-disabled={blocked ? true : undefined} title={blocked ?? undefined} onClick={() => props.onNewChat(projectId)}>
      <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
      <span className="ps-row-icon is-agent" aria-hidden="true">{tr("+")}</span>
      <span className="ps-row-name ps-muted">{tr("New chat")}</span>
    </button>
    );
  };

  const projectBlock = (p: VibeProject) => {
    const chats = chatsOfProject(p.id);
    const connected = props.connectedId === p.id;
    const browse = props.browse;
    /*
     * While searching, automatically expand the branch that matched: otherwise you find it but cannot see
     * where it is.
     * Otherwise: if the user has clicked the small triangle, follow that; if not, the connected one is
     * expanded by default and the others are collapsed by default (issue #15).
     * When `browse` is not given (desktop app), only the connected one can be expanded -- there is
     * nothing to list under the other projects.
     */
    const expanded = q ? chats.some((c) => hit(c.name)) : (open[p.id] ?? connected);
    const canExpand = !!browse || connected;
    const toggle = () => {
      const next = !(open[p.id] ?? connected);
      setOpen((o) => ({ ...o, [p.id]: next }));
      // Expanding a project that is not open: only now fetch its chats (collapsing, or the one already open,
      // does not fetch)
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
          label: tr("Project {0}{1}{2}", p.name, chats.length ? tr(", {0} Agent chats", chats.length) : "", p.pinned ? tr(", pinned") : ""),
          onClick: () => props.onOpen(p.id),
        })}
        {canExpand && expanded && (
          <div className="ps-sub">
            {chats.map(chatRow)}
            {note && (
              <p className="ps-side-hint" role="status" data-pc="start-side-browse-note" data-project={p.id}>
                {note.text}
                {note.retry && (
                  <button type="button" className="ps-link" data-pc="start-side-browse-retry" onClick={note.retry}>{tr("Retry")}</button>
                )}
              </p>
            )}
            {newChatRow(p.id)}
          </div>
        )}
      </div>
    );
  };

  /** A row in the "Archived" card: clicking and right-clicking both bring up the menu (unarchive, delete);
   * it does not enter */
  const archivedRow = (kind: TreeKind, id: string, name: string, icon: JSX.Element) => (
    <button key={`${kind}:${id}`} type="button" className={`ps-row is-archived${kind === "chat" ? " is-agent" : ""}`} data-pc="start-side-archived-row"
      data-kind={kind} data-id={id} aria-label={tr("Archived {0} {1}", kind === "group" ? tr("Group") : kind === "project" ? tr("Project") : tr("chat"), name)} title={tr("{0} (right-click to unarchive)", name)}
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
      /* Collapsing means shrinking flex-basis to 0; the width is given by an inline style to begin with, so
         collapsing must also go inline, otherwise a class selector cannot override it */
      style={{ flexBasis: props.collapsed ? 0 : `${props.width}px` }}
    >
      {/* This inner layer pins the original width: when collapsing, the content slides out as one block and
   is not first squeezed into a strip and then gone */}
      <div className="ps-side-inner" style={{ width: `${props.width}px` }}>
      {/* There is only one panel (issue #5): the search-and-create row and the list below it are both inside this one */}
      <div className="ps-side-panel" data-pc="start-side-panel">
      {/*
        Top row: search on the left, "New project" on the right. Focusing the search box expands it to the
        right to **cover** the new project button (user decision, 2026-10-24); the animation only changes
        `right` (240ms, same easing as sidebar collapse) without positional jitter; when collapsing, the
        new project button is revealed unchanged: it stays in place the whole time, simply covered.
      */}
      <div className="ps-side-head" data-searching={searchOpen}>
        <button ref={newBtn} type="button" className="ps-side-new" data-pc="start-side-new" disabled={!!props.createBlocked}
          title={props.createBlocked ?? undefined} aria-hidden={searchOpen || undefined} tabIndex={searchOpen ? -1 : undefined}
          onClick={props.onCreate}>
          <span aria-hidden="true">{tr("+")}</span>{tr("New project")}
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
            /* When collapsed there is only a small strip, and the long sentence does not fit; write it in full once expanded */
            placeholder={searchOpen ? tr("Search projects and chats") : tr("Search")}
            aria-label={tr("Search projects and chats")}
            data-pc="start-side-search"
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            /* Esc: clear and exit, the search box retracts, the new-project button shows again */
            onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); searchBox.current?.blur(); } }}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/*
            The clear button: click it after searching to collapse the search box and reveal the new project
            button. Only present when there is text. Intercept `onMouseDown`: it is inside <label>; without
            intercepting, clicking sends focus to the input box, treating it as "in use" after clearing so it
            cannot collapse.
          */}
          {query && (
            <button type="button" className="ps-search-clear" data-pc="start-side-search-clear" aria-label={tr("Clear search")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setQuery(""); setTyping(false); }}>
              ✕
            </button>
          )}
        </label>
      </div>

      <div className="ps-side-scroll">
        {/* Search only finds chats that have already been fetched: what is under a project that was never
   expanded is not known to this page yet (issue #15) */}
        {q && props.browse && (
          <p className="ps-side-hint" data-pc="start-side-search-scope">{tr("Search only covers projects you have expanded.")}</p>
        )}
        {SHOW_SCOPE_ROWS && (
        <div className="ps-side-group">
          <button
            type="button"
            className="ps-row"
            data-pc="start-scope-all"
            aria-label={tr("All projects, {0} in total", allProjects.length)}
            aria-current={isAt({ kind: "all" })}
            onClick={() => props.onScope({ kind: "all" })}
          >
            <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
            <span className="ps-row-icon"><AllIcon /></span>
            <span className="ps-row-name">{tr("All projects")}</span>
            <span className="ps-row-count">{allProjects.length}</span>
          </button>
        </div>
        )}

        <div className="ps-side-group" data-open={cardOpen("groups")}>
          {cardHead("groups", tr("Group"), groups.length)}
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
                  label: tr("Group {0}, {1} projects{2}", g.name, rows.length, g.pinned ? tr(", pinned") : ""),
                  onClick: () => {
                    props.onScope({ kind: "group", id: g.id });
                    setOpen((o) => ({ ...o, [g.id]: !o[g.id] }));
                  },
                })}
                {expanded && (
                  <div className="ps-sub">
                    {rows.map(projectBlock)}
                    {rows.length === 0 && <p className="ps-side-hint">{tr("This group is empty: right-click a project and choose \"Move to group\".")}</p>}
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" className="ps-row" data-pc="start-new-group" aria-label={tr("New group")} disabled={!!props.newGroupBlocked}
            title={props.newGroupBlocked ?? props.groupNote} onClick={props.onNewGroup}>
            <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
            <span className="ps-row-icon" aria-hidden="true">{tr("+")}</span>
            <span className="ps-row-name ps-muted">{tr("New group")}</span>
          </button>
          {props.groupStatus && <div className="ps-side-hint" role="status" data-pc="start-group-status">{props.groupStatus}</div>}
          </div>}
        </div>

        <div className="ps-side-group" data-open={cardOpen("projects")}>
          {cardHead("projects", tr("Project"), projectsOf(null).length)}
          {cardOpen("projects") && <div className="ps-side-body">
          {SHOW_SCOPE_ROWS && (
          <button
            type="button"
            className="ps-row"
            data-pc="start-scope-loose"
            aria-label={tr("Ungrouped, {0} projects", projectsOf(null).length)}
            aria-current={isAt({ kind: "loose" })}
            onClick={() => props.onScope({ kind: "loose" })}
          >
            <span className="ps-row-caret" data-empty aria-hidden="true">›</span>
            <span className="ps-row-icon"><AllIcon /></span>
            <span className="ps-row-name">{tr("Not in a group")}</span>
            <span className="ps-row-count">{projectsOf(null).length}</span>
          </button>
          )}
          {props.notice && <div className="ps-side-hint" role="status" data-pc="start-side-notice">{props.notice}</div>}
          {/* Projects not in any group are listed directly one by one, no longer nested under an "Ungrouped" row
   (user decision, 2026-10-23) */}
          {projectsOf(null).map(projectBlock)}
          </div>}
        </div>

        {archivedCount > 0 && (
          <div className="ps-side-group" data-open={cards.archived === true} data-pc="start-side-archived">
            {/* Archived is collapsed by default: it takes no space normally and is opened only when you want something back */}
            <div className="ps-card-head">
              <button type="button" className="ps-card-toggle" data-pc="start-side-card" data-card="archived" aria-expanded={cards.archived === true}
                onClick={() => setCards((c) => ({ ...c, archived: c.archived !== true }))}>
                <span className="ps-card-caret" data-open={cards.archived === true} aria-hidden="true">›</span>
                {tr("Archived")}
              </button>
              <span className="ps-card-count">{archivedCount}</span>
            </div>
            {cards.archived === true && <div className="ps-side-body">
              {archivedGroups.map((g) => archivedRow("group", g.id, g.name, <GroupIcon />))}
              {archivedProjects.map((p) => archivedRow("project", p.id, p.name, <ProjectIcon />))}
              {archivedChats.map((c) => archivedRow("chat", c.id, c.name, <AgentIcon />))}
              <p className="ps-side-hint">{tr("Right-click \"Unarchive\" to put it back.")}</p>
            </div>}
          </div>
        )}
      </div>
      </div>

      </div>

      {/* The divider on the right: no line is drawn normally, it lights up only when the mouse presses on it
   (`WidthGrip.tsx`). Absent when collapsed */}
      {!props.collapsed && (
        <WidthGrip
          spec={SIDE_WIDTH}
          side="right"
          width={props.width}
          label={tr("Sidebar width")}
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
        // Groups of the other realm are listed too, grayed out with an explanation (a local project cannot go
        // into a cloud group, and a cloud project cannot go into a local group)
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
