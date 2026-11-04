import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { type GroupLayout, unitsFor, columnsFor, colWidth, tileHeight, masonry } from "./layout";

export interface MasonryProps {
  layout: GroupLayout;
  items: { id: string; node: ReactNode; aspect?: number }[];
}

/**
 * Masonry container: measures its own width → computes unit and column counts → gives each item a height
 * by tileHeight → masonry() assigns it to the shortest column.
 * Rendered as N vertical flex columns, without computing top by absolute positioning. Items fill the
 * cell they are given according to fill.
 * When the section is hidden (display:none) the measured width is 0; in that case the previous width
 * is kept and nothing is re-laid out.
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
