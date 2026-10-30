import { useCallback, useEffect, useRef, useState } from "react";
import { ALL_GROUPS } from "../cardScope";
import { CardScopeBar } from "./CardScopeBar";
import { UserCardMenu } from "./UserCardMenu";
import { SearchBox } from "./SearchBox";
import { SectionHead } from "./SectionHead";
import { useOpenGroup } from "./stored";
import { ANIMATION_GROUPS, ANIMATION_GROUP_IDS } from "./library/groups";
import { GroupBrowser } from "./library/GroupBrowser";
import { useCardGroups, useCardLibrary, usePartsList } from "./library/cardGroups";

/**
 * 「动画」分区:搜索 + 卡片筛选 → 分组(定制卡片 / Magic UI / 自家卡片 / 部件库 / Lottie 动效 / 粒子背景)。
 *
 * 这几组全是视觉类,GroupBrowser 看组表只有一种分类,就不画「所有 / 视觉 / 音频」胶囊行。
 * 卡片列表和可见性只有一个来源(useCardLibrary),几个卡片组共用 —— 归属表只加载一次,筛选一改所有组一起变。
 * 定制卡的右键换档菜单挂在这一级常驻渲染,总览、组详情、搜索结果里都弹得出来;
 * 部件「加进组合卡」之类的提示 PartCell 自己画在卡上,不走分区提示条。
 *
 * index.tsx 静态导入这里:index → AnimationsSection → cardGroups → CardCell → previewZoom → prewarmBoxes,
 * window.__pcPreviewBoxes 靠这条链挂上,别改成 lazy。
 */
export function AnimationsSection() {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const searching = q !== "";
  const [openGroup, setOpenGroup] = useOpenGroup("animations", ANIMATION_GROUP_IDS);

  const cards = useCardLibrary(q);
  const parts = usePartsList(q);
  const [userMenu, setUserMenu] = useState<{ cardId: string; x: number; y: number } | null>(null);
  const openUserMenu = useCallback((e: React.MouseEvent, cardId: string) => {
    e.preventDefault();
    setUserMenu({ cardId, x: e.clientX, y: e.clientY });
  }, []);
  const closeUserMenu = useCallback(() => setUserMenu(null), []);
  const data = useCardGroups(cards, parts, searching, openUserMenu);

  // 搜索框右边的筛选浮层(CardScopeBar):点外面或按 Esc 收起
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scopeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!scopeWrapRef.current?.contains(e.target as Node)) setScopeOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setScopeOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [scopeOpen]);
  const v = cards.vis;
  const narrowed = !v.base || !v.custom || !v.project || ALL_GROUPS.some((g) => v.groups[g] === false);

  return (
    <div data-pc="animations" className="pc-left-section">
      <SectionHead title="动画">
        <div className="pc-left-searchrow" ref={scopeWrapRef}>
          <SearchBox value={search} onChange={setSearch} placeholder="搜索动画、卡片…" dataPc="animations-search" />
          <button
            type="button"
            className={`pc-icon-btn pc-left-filter${narrowed ? " is-narrowed" : ""}`}
            data-pc="scope-toggle"
            aria-pressed={scopeOpen}
            aria-haspopup="dialog"
            title={narrowed ? "卡片筛选:有档位关着,点开调整" : "卡片筛选:基础 / 自定义 / 项目"}
            onClick={() => setScopeOpen((o) => !o)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z" />
            </svg>
          </button>
          {scopeOpen && (
            <div className="pc-lib-popover" role="dialog" aria-label="卡片筛选">
              <div className="pc-lib-popover-title">卡片筛选</div>
              <div className="pc-lib-popover-hint">关掉哪一档,卡库和 AI 助手看到的卡片同时生效</div>
              <CardScopeBar onChange={cards.setVis} />
            </div>
          )}
        </div>
      </SectionHead>

      <GroupBrowser
        groups={ANIMATION_GROUPS}
        data={data}
        searching={searching}
        openId={openGroup}
        onOpen={setOpenGroup}
        noMatch="没有匹配的动画或卡片"
      />

      {userMenu && (
        <UserCardMenu
          cardId={userMenu.cardId}
          entry={cards.scopes[userMenu.cardId]}
          x={userMenu.x}
          y={userMenu.y}
          onClose={closeUserMenu}
          onChanged={cards.reloadScopes}
        />
      )}
    </div>
  );
}
