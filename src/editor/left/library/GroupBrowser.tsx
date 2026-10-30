import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { playEnter } from "../../enterMotion";
import { CategoryChips } from "./CategoryChips";
import { GroupBox } from "./GroupBox";
import { DetailChips, GroupDetail } from "./GroupDetail";
import type { GroupCategory, GroupData, GroupDef } from "./groups";

const EMPTY: GroupData = { items: [] };

export interface GroupBrowserProps {
  groups: readonly GroupDef[];
  /** 每个组在当前搜索词下的内容 */
  data: Record<string, GroupData>;
  /** 正在搜索:总览里没有命中的组隐藏 */
  searching: boolean;
  /** 打开的组(null = 总览)。状态由分区持有,导入完成之类的外部事件也能打开组 */
  openId: string | null;
  onOpen: (id: string | null) => void;
  /** 空的素材类组里「导入…」占位调它 */
  onImport?: () => void;
  /** 搜索没有任何命中时的说明 */
  noMatch: string;
}

/**
 * 分组浏览:总览(分类胶囊 + 组框) ⇄ 组详情(胶囊行 + 瀑布流)。
 *
 * - 打开组时搜索照常生效,只在这个组里过滤,不会把组关掉;
 * - 总览的滚动容器常驻挂载(只是隐藏),关掉组回来还停在原来的位置;
 * - 打开的组 id 不在表里(改版前存下的旧值)就在 effect 里退回总览,不在渲染期间改状态;
 * - 组表里只有一种分类(「动画」全是视觉组)时分类胶囊没得筛:总览不画胶囊行,
 *   组详情的胶囊行也不画分类那一颗,只剩「所有 / 组名 ×」。按整张表判断,不按搜索后剩下的组,搜索时不会忽隐忽现。
 */
export function GroupBrowser({ groups, data, searching, openId, onOpen, onImport, noMatch }: GroupBrowserProps) {
  const [category, setCategory] = useState<GroupCategory | null>(null);
  const open = openId ? (groups.find((g) => g.id === openId) ?? null) : null;
  const singleCategory = new Set(groups.map((g) => g.category)).size <= 1;

  useEffect(() => {
    if (openId && !open) onOpen(null);
  }, [openId, open, onOpen]);

  // 打开组:详情从右边滑进来;关掉组:总览从左边滑回来;胶囊行换了一套,跟着淡入(enterMotion)。
  // 只认「打开的组变了」这一件事,分区被切走 / 抽屉收起再显示时不会重放
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
  // 搜索时只留有命中的组;不搜时 0 项的卡片类组不显示,素材类组显示「导入…」占位
  const available = groups.filter((g) => (searching ? countOf(g) > 0 : countOf(g) > 0 || g.empty !== "hide"));
  const visible = category && !singleCategory ? available.filter((g) => g.category === category) : available;

  const byCategory: Record<GroupCategory, { id: string; title: string }[]> = { 视觉: [], 音频: [] };
  for (const g of available) byCategory[g.category].push({ id: g.id, title: g.title });

  // 单一分类的总览没有胶囊行,整条 bar 不渲染(否则留下一截空的下内边距)
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
          <div className="pc-left-note">{searching ? noMatch : "这一类下面没有可显示的组"}</div>
        ) : (
          visible.map((g) => (
            <GroupBox key={g.id} def={g} data={data[g.id] ?? EMPTY} onOpen={() => onOpen(g.id)} onImport={onImport} />
          ))
        )}
      </div>

      {open && (
        // 按组 id 做 key:换一个组就是新的滚动容器,从顶上开始看
        <div key={open.id} className="pc-lib-scroll pc-left-scroll" ref={detailRef}>
          <GroupDetail def={open} data={data[open.id] ?? EMPTY} searching={searching} />
        </div>
      )}
    </div>
  );
}
