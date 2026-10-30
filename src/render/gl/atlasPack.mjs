/**
 * 图集打包(R9 M2「图集打包」):活跃 canvas 卡的像素尺寸 → 每张卡在图集里的区域。
 *
 * **按当前活跃集合打包,不固定 4096²**(一张 4096² RGBA 就是 64 MB):集合变了就重打包,
 * 页面尺寸就是用到的那一块。上限 4096²、只有一个舞台(`compact`,在线页面舞台闸门第一级与最低一档)2048²,一页放不下就开下一页(「超了分多张」)。
 *
 * 做法是最朴素的 shelf:按高度降序排好,一行一行往右摆,摆不下换行,行摞不下换页。
 * 排序全用确定的键(高、宽、id),同一个集合永远算出同一张表 —— 区域坐标进不了画面,
 * 但确定性让探针和排错可复现。
 *
 * 坐标是**图集图像坐标**(左上角原点、y 向下),`createImageBitmap(atlas, x, y, w, h)` 直接用;
 * 渲染器换算成 GL 的左下角原点(`y_gl = page.h − y − h`)。
 * 比上限还大的卡夹到上限(`clamped`),画面按夹过的尺寸画、贴回平面时由 CSS 拉伸 —— 这种卡本来就不该有。
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
      // 换行
      shelfY += shelfH;
      shelfH = 0;
      cursorX = 0;
    }
    if (shelfY + it.h > max) {
      // 换页
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

/** 一份活跃集合的身份:同一串 = 不用重打包 */
export function layoutKeyOf(cards) {
  return cards.map((c) => `${c.id}:${Math.max(1, Math.round(c.w))}x${Math.max(1, Math.round(c.h))}`).sort().join("|");
}
