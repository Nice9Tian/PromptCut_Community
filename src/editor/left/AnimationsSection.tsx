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
import { tr } from "../../i18n/index.ts";

/**
 * "Animations" section: search + card filter → groups (custom cards / Magic UI / built-in cards / parts library / Lottie motion graphics / particle backgrounds).
 *
 * These groups are all visual, and GroupBrowser sees only one category in the group table, so it does not
 * draw the "All / Visual / Audio" pill row. The card list and visibility have a single source
 * (useCardLibrary), shared by several card groups: the membership table is loaded only once, and one filter
 * change updates all groups together. The right-click tier-switch menu of custom cards is mounted at this
 * level and always rendered, so it can pop up in the overview, group detail and search results; hints like
 * a part being "added to a composite card" are drawn by PartCell itself on the card, not through the
 * section's hint bar.
 *
 * index.tsx statically imports this: index → AnimationsSection → cardGroups → CardCell → previewZoom →
 * prewarmBoxes, and window.__pcPreviewBoxes gets attached through this chain, so do not change it to lazy.
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

  // Filter popover to the right of the search box (CardScopeBar): click outside or press Esc to close it
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
      <SectionHead title={tr("Animation")}>
        <div className="pc-left-searchrow" ref={scopeWrapRef}>
          <SearchBox value={search} onChange={setSearch} placeholder={tr("Search animations, cards…")} dataPc="animations-search" />
          <button
            type="button"
            className={`pc-icon-btn pc-left-filter${narrowed ? " is-narrowed" : ""}`}
            data-pc="scope-toggle"
            aria-pressed={scopeOpen}
            aria-haspopup="dialog"
            title={narrowed ? tr("Card filter: some tiers are off, click to adjust") : tr("Card filter: basic / custom / project")}
            onClick={() => setScopeOpen((o) => !o)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z" />
            </svg>
          </button>
          {scopeOpen && (
            <div className="pc-lib-popover" role="dialog" aria-label={tr("Card filter")}>
              <div className="pc-lib-popover-title">{tr("Card filter")}</div>
              <div className="pc-lib-popover-hint">{tr("Turning off a tier takes effect for the cards seen in the card library and by the AI assistant at the same time")}</div>
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
        noMatch={tr("No matching animations or cards")}
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
