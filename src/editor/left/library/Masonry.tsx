import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { type GroupLayout, unitsFor, columnsFor, colWidth, tileHeight, masonry } from "./layout";

export interface MasonryProps {
  layout: GroupLayout;
  items: { id: string; node: ReactNode; aspect?: number }[];
}

/**
 * 瀑布流容器:量自己的宽 → 算单位数和列数 → 每项按 tileHeight 给高 → masonry() 分到最矮的列。
 * 渲染成 N 个纵向 flex 列,不用绝对定位算 top。项目本身按 fill 铺满给它的格子。
 * 所在分区被隐藏(display:none)时量到的宽是 0,这时沿用上一次的宽,不重排。
 */
export function Masonry({ layout, items }: MasonryProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [innerW, setInnerW] = useState(216);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.clientWidth > 0) setInnerW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) setInnerW(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = columnsFor(layout, unitsFor(innerW));
  const cw = colWidth(innerW, cols);
  const heights = items.map((item) => tileHeight(layout, item.aspect, cols, cw));
  const { items: placed } = masonry(heights, cols);

  const columns: ReactNode[][] = Array.from({ length: cols }, () => []);
  items.forEach((item, i) => {
    columns[placed[i].col].push(
      <div key={item.id} className="pc-lib-masonry-cell" style={{ height: heights[i] }}>
        {item.node}
      </div>,
    );
  });

  return (
    <div ref={ref} className="pc-lib-masonry" data-pc-layout={layout} data-pc-cols={cols}>
      {columns.map((col, i) => (
        <div key={i} className="pc-lib-masonry-col">
          {col}
        </div>
      ))}
    </div>
  );
}
