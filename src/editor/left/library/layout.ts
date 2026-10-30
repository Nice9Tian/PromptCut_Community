export type GroupLayout = "big_16_9" | "big_strip" | "middle_cube" | "small_cube";

export const CUBE = 64;
export const GAP = 8;

export function unitsFor(innerW: number): number {
  return Math.max(3, Math.floor((innerW + GAP) / (CUBE + GAP)));
}

export function columnsFor(layout: GroupLayout, units: number): number {
  if (layout === "small_cube") return units;
  if (layout === "middle_cube") return Math.max(1, Math.floor(units / 2));
  return Math.max(1, Math.floor(units / 3)); // big_16_9 or big_strip
}

export function colWidth(innerW: number, cols: number): number {
  return (innerW - (cols - 1) * GAP) / cols;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function tileHeight(layout: GroupLayout, aspect: number | undefined, cols: number, colW: number): number {
  if (layout === "small_cube") {
    return colW;
  }
  if (layout === "middle_cube") {
    return aspect !== undefined ? colW * clamp(aspect, 0.75, 1.5) : colW;
  }
  if (layout === "big_strip") {
    return 56;
  }
  // big_16_9
  if (aspect === undefined) {
    return colW * 9 / 16;
  }
  if (cols === 1) {
    return colW * clamp(aspect, 9 / 21, 4 / 3);
  }
  return colW * clamp(aspect, 9 / 21, 16 / 9);
}

export interface MasonryItem {
  col: number;
  y: number;
}

export function masonry(heights: number[], cols: number): { items: MasonryItem[], totalHeight: number } {
  const colHeights = new Array(cols).fill(0);
  const items: MasonryItem[] = [];
  
  for (const h of heights) {
    let minH = colHeights[0];
    let minCol = 0;
    for (let c = 1; c < cols; c++) {
      if (colHeights[c] < minH) {
        minH = colHeights[c];
        minCol = c;
      }
    }
    items.push({ col: minCol, y: minH });
    colHeights[minCol] = minH + h + GAP;
  }
  
  let totalHeight = colHeights[0];
  for (let c = 1; c < cols; c++) {
    if (colHeights[c] > totalHeight) {
      totalHeight = colHeights[c];
    }
  }
  if (totalHeight > 0) {
    totalHeight -= GAP; // remove last gap
  }
  
  return { items, totalHeight };
}
