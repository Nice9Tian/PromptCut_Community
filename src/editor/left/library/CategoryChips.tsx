import { useEffect, useRef, useState } from "react";
import { CATEGORIES, type GroupCategory } from "./groups";
import { tr } from "../../../i18n/index.ts";

export interface CategoryChipsProps {
  active: GroupCategory | null;
  /** Click the pill itself: show only the groups of this category (null = all) */
  onCategory: (cat: GroupCategory | null) => void;
  /** Click an item in the ▾ menu: open that group directly */
  onOpenGroup: (groupId: string) => void;
  /** The groups that can currently be opened under each category */
  groupsByCategory: Record<GroupCategory, { id: string; title: string }[]>;
}

/** Filter chip row at the top of the overview: `All` / `Visual ▾` / `Audio ▾` */
export function CategoryChips({ active, onCategory, onOpenGroup, groupsByCategory }: CategoryChipsProps) {
  const [menu, setMenu] = useState<GroupCategory | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Small menu: click outside or press Esc to close
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  return (
    <div ref={ref} className="pc-lib-chips" role="toolbar" aria-label={tr("Category")}>
      <button
        type="button"
        className={`pc-chip${active === null ? " is-on" : ""}`}
        data-pc-category="all"
        aria-pressed={active === null}
        onClick={() => {
          setMenu(null);
          onCategory(null);
        }}
      >
        {tr("All")}
      </button>
      {CATEGORIES.map((cat) => {
        const groups = groupsByCategory[cat] ?? [];
        return (
          <div key={cat} className={`pc-chip pc-lib-split${active === cat ? " is-on" : ""}`} data-pc-category={cat}>
            <button
              type="button"
              className="pc-lib-split-main"
              aria-pressed={active === cat}
              onClick={() => {
                setMenu(null);
                onCategory(cat);
              }}
            >
              {tr(cat === "visual" ? "Visual" : "Audio")}
            </button>
            <button
              type="button"
              className="pc-lib-split-caret"
              aria-haspopup="menu"
              aria-expanded={menu === cat}
              title={tr("Groups in \"{0}\"", cat)}
              onClick={() => setMenu((m) => (m === cat ? null : cat))}
            >
              <svg className="pc-chip-caret" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M3.5 5.5 7 9l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {menu === cat && (
              <div className="pc-lib-menu" role="menu">
                {groups.length === 0 ? (
                  <div className="pc-lib-menu-empty">{tr("No groups to open")}</div>
                ) : (
                  groups.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      role="menuitem"
                      className="pc-lib-menu-item"
                      data-pc-menu-group={g.id}
                      onClick={() => {
                        setMenu(null);
                        onOpenGroup(g.id);
                      }}
                    >
                      {g.title}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
