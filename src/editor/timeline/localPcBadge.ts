/**
 * 时间轴片段的卡名(C10 契约第 9 节)。纯函数,单测直接载入。
 * 原先这里还判「本地 PC 辅助渲染」的徽标出不出,2026-10-21 用户定撤掉(没有这种情况),文件名沿用。
 */

/** 卡片段的标签:构建时定义的名字 → 同步表里的名字(`knownCardName` 已按这个顺序取好)→「未知卡片」 */
export const UNKNOWN_CARD_LABEL = "未知卡片";
export function clipCardLabel(knownName: string | null | undefined): string {
  return typeof knownName === "string" ? knownName : UNKNOWN_CARD_LABEL;
}
