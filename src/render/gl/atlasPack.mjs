/**
 * Atlas packing (R9 M2 "Atlas packing"): Pixel dimensions of active canvas cards → region of each
 * card in the atlas.
 *
 * **Pack by current active set, not fixed to 4096²** (one 4096² RGBA is 64 MB): repack when the set
 * changes, and page size is exactly the used region. Upper limit is 4096², or 2048² when there is
 * only one stage (`compact`, level 1 and lowest tier of the online page stage gate); open the next
 * page if one page cannot fit everything ("split across multiple pages if exceeded").
 *
 * Approach is the simplest shelf algorithm: sort descending by height, arrange to the right row
 * by row, wrap to a new row when space runs out, and move to a new page when rows cannot stack
 * further. Sorting uses entirely deterministic keys (height, width, id), so the same set always
 * produces the exact same table: region coordinates do not enter the picture, but determinism
 * makes probes and troubleshooting reproducible.
 *
 * Coordinates are **atlas image coordinates** (top-left origin, y pointing down), used directly
 * by `createImageBitmap(atlas, x, y, w, h)`; renderer converts them to GL's bottom-left origin
 * (`y_gl = page.h − y − h`). Cards larger than the limit are clamped (`clamped`), rendered at
 * the clamped size, and stretched by CSS when pasted back onto the plane: such cards should not exist
 * in the first place.
 */

export const ATLAS_MAX = 4096;
export const ATLAS_MAX_COMPACT = 2048;

/**
 * @param {Array<{ id: string, w: number, h: number }>} cards
 * @param {number} [maxSize]
 */
export function packAtlas(cards, maxSize = ATLAS_MAX) {
  const max = Math.max(1, Math.floor(maxSize));
  const items = cards.map((c) => {
    const w0 = Math.max(1, Math.round(c.w));
    const h0 = Math.max(1, Math.round(c.h));
    return { id: String(c.id), w: Math.min(w0, max), h: Math.min(h0, max), clamped: w0 > max || h0 > max };
  });
  items.sort((a, b) => b.h - a.h || b.w - a.w || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  /** @type {Array<{ w: number, h: number, items: Array<{ id: string, x: number, y: number, w: number, h: number, clamped: boolean }> }>} */
  const pages = [];
  let page = null;
  let shelfY = 0;
  let shelfH = 0;
  let cursorX = 0;
  const open = () => {
    page = { w: 0, h: 0, items: [] };
    pages.push(page);
    shelfY = 0;
    shelfH = 0;
    cursorX = 0;
  };
  for (const it of items) {
    if (!page) open();
    if (cursorX + it.w > max) {
      // New line
      shelfY += shelfH;
      shelfH = 0;
      cursorX = 0;
    }
    if (shelfY + it.h > max) {
      // New page
      open();
    }
    page.items.push({ id: it.id, x: cursorX, y: shelfY, w: it.w, h: it.h, clamped: it.clamped });
    cursorX += it.w;
    shelfH = Math.max(shelfH, it.h);
    page.w = Math.max(page.w, cursorX);
    page.h = Math.max(page.h, shelfY + shelfH);
  }
  return { pages };
}

/** Identity of an active set: Same string = no need to repack */
export function layoutKeyOf(cards) {
  return cards.map((c) => `${c.id}:${Math.max(1, Math.round(c.w))}x${Math.max(1, Math.round(c.h))}`).sort().join("|");
}
