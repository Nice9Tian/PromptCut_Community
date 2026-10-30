import { useEffect, useRef, useState } from "react";
import { CATEGORIES, type GroupCategory } from "./groups";

export interface CategoryChipsProps {
  active: GroupCategory | null;
  /** 点胶囊本体:只看这一类的组(null = 所有) */
  onCategory: (cat: GroupCategory | null) => void;
  /** 点 ▾ 菜单里的一项:直接打开那个组 */
  onOpenGroup: (groupId: string) => void;
  /** 每一类下面当前能打开的组 */
  groupsByCategory: Record<GroupCategory, { id: string; title: string }[]>;
}

/** 总览顶部的筛选胶囊行:`所有` / `视觉 ▾` / `音频 ▾` */
export function CategoryChips({ active, onCategory, onOpenGroup, groupsByCategory }: CategoryChipsProps) {
  const [menu, setMenu] = useState<GroupCategory | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // 小菜单:点外面或按 Esc 收起
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
    <div ref={ref} className="pc-lib-chips" role="toolbar" aria-label="分类">
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
        所有
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
              {cat}
            </button>
            <button
              type="button"
              className="pc-lib-split-caret"
              aria-haspopup="menu"
              aria-expanded={menu === cat}
              title={`「${cat}」里的组`}
              onClick={() => setMenu((m) => (m === cat ? null : cat))}
            >
              <svg className="pc-chip-caret" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M3.5 5.5 7 9l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {menu === cat && (
              <div className="pc-lib-menu" role="menu">
                {groups.length === 0 ? (
                  <div className="pc-lib-menu-empty">没有可打开的组</div>
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
