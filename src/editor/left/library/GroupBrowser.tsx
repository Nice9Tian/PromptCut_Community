import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { playEnter } from "../../enterMotion";
import { CategoryChips } from "./CategoryChips";
import { GroupBox } from "./GroupBox";
import { DetailChips, GroupDetail } from "./GroupDetail";
import type { GroupCategory, GroupData, GroupDef } from "./groups";
import { tr } from "../../../i18n/index.ts";

const EMPTY: GroupData = { items: [] };

export interface GroupBrowserProps {
  groups: readonly GroupDef[];
  /** The contents of each group under the current search term */
  data: Record<string, GroupData>;
  /** Searching: groups with no match are hidden in the overview */
  searching: boolean;
  /** The open group (null = overview). State is held by the section, so external events such as a finished import can also open a group */
  openId: string | null;
  onOpen: (id: string | null) => void;
  /** Called by the "Import…" placeholder in an empty media group */
  onImport?: () => void;
  /** Message shown when a search has no hits */
  noMatch: string;
}

/**
 * Group browser: overview (category pills + group boxes) ⇄ group detail (pill row + masonry layout).
 *
 * - Search still applies while a group is open: it filters within that group only and does not close it;
 * - The overview's scroll container stays mounted (just hidden), so closing a group returns to the
 *   previous scroll position;
 * - If the open group id is not in the table (an old value saved before the redesign), an effect falls
 *   back to the overview; state is never changed during render;
 * - When the group table has only one category ("Animations" is all visual groups) the category pills
 *   have nothing to filter: the overview draws no pill row, and the detail pill row skips the category
 *   pill too, leaving only "All / group name ×". This is decided on the whole table, not on the groups
 *   left after a search, so nothing flickers while searching.
 */
export function GroupBrowser({ groups, data, searching, openId, onOpen, onImport, noMatch }: GroupBrowserProps) {
  const [category, setCategory] = useState<GroupCategory | null>(null);
  const open = openId ? (groups.find((g) => g.id === openId) ?? null) : null;
  const singleCategory = new Set(groups.map((g) => g.category)).size <= 1;

  useEffect(() => {
    if (openId && !open) onOpen(null);
  }, [openId, open, onOpen]);

  // Opening a group: the detail slides in from the right; closing it: the overview slides back from the
  // left; the pill row is a different set, so it fades in (enterMotion).
  // Only reacts to "the open group changed": it does not replay when the section is switched away or
  // the drawer is collapsed and shown again
  const barRef = useRef<HTMLDivElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const openKey = open?.id ?? null;
  const prevOpen = useRef(openKey);
  useLayoutEffect(() => {
    const prev = prevOpen.current;
    prevOpen.current = openKey;
    if (prev === openKey) return;
    playEnter(barRef.current?.firstElementChild, "pc-enter-fade");
    if (openKey) playEnter(detailRef.current, "pc-enter-from-right");
    else playEnter(overviewRef.current, "pc-enter-from-left");
  }, [openKey]);

  const countOf = (g: GroupDef) => data[g.id]?.items.length ?? 0;
  // When searching, keep only groups with hits; when not searching, card groups with 0 items are hidden and media groups show the "Import…" placeholder
  const available = groups.filter((g) => (searching ? countOf(g) > 0 : countOf(g) > 0 || g.empty !== "hide"));
  const visible = category && !singleCategory ? available.filter((g) => g.category === category) : available;

  const byCategory: Record<GroupCategory, { id: string; title: string }[]> = { visual: [], audio: [] };
  for (const g of available) byCategory[g.category].push({ id: g.id, title: g.title });

  // A single-category overview has no pill row, so the whole bar is not rendered (otherwise an empty strip of bottom padding is left)
  const showBar = open !== null || !singleCategory;

  return (
    <div className="pc-lib-browser">
      {showBar && (
        <div className="pc-lib-bar" ref={barRef}>
          {open ? (
            <DetailChips
              def={open}
              showCategory={!singleCategory}
              onAll={() => {
                setCategory(null);
                onOpen(null);
              }}
              onCategory={(c) => {
                setCategory(c);
                onOpen(null);
              }}
              onClose={() => onOpen(null)}
            />
          ) : (
            <CategoryChips active={category} onCategory={setCategory} onOpenGroup={onOpen} groupsByCategory={byCategory} />
          )}
        </div>
      )}

      <div className="pc-lib-scroll pc-left-scroll" ref={overviewRef} style={{ display: open ? "none" : "flex" }}>
        {visible.length === 0 ? (
          <div className="pc-left-note">{searching ? noMatch : tr("No groups to show in this category")}</div>
        ) : (
          visible.map((g) => (
            <GroupBox key={g.id} def={g} data={data[g.id] ?? EMPTY} onOpen={() => onOpen(g.id)} onImport={onImport} />
          ))
        )}
      </div>

      {open && (
        // Keyed by group id: switching groups gives a new scroll container, starting from the top
        <div key={open.id} className="pc-lib-scroll pc-left-scroll" ref={detailRef}>
          <GroupDetail def={open} data={data[open.id] ?? EMPTY} searching={searching} />
        </div>
      )}
    </div>
  );
}
