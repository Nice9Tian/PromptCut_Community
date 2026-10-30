/**
 * 手机版片段上的叠加卡角标。
 *
 * # 为什么手机上不画桌面那条带
 *
 * 手机片段只有 30px 高(`mobile.css` 的 `.clip`)。按桌面的比例切一条 13px 的带,
 * 剩 17px 放名字已经勉强,而带里每张卡只有 13px 高、40px 宽 —— 低于任何能点中的触摸目标。
 * 所以手机上只留一个计数角标(位置和尺寸跟现有的「已静音」角标一样),
 * 真要改在点片段本来就会弹出的「调整」表单里。
 *
 * # 最窄那一档的角标不吃点击
 *
 * 名字都挤没了的时候,角标几乎就是整个片段:用户多半是想选中这一段,手指一歪却进了叠加卡。
 * 那一档把整块热区还给片段,入口交给子导航里的「叠加层」。
 */

/** 这个宽度以上角标写「叠加 N」,以下只写数字 */
export const OVM_WIDE_PX = 120;
/** 这个宽度以下角标只是个记号,不吃点击 —— 它占掉了片段三分之一还多 */
export const OVM_TAP_PX = 64;

export interface OverlayBadgePlan {
  text: string;
  /** 点得动吗。点不动时整块热区归片段 */
  tappable: boolean;
}

/** 这一段上挂了 `count` 张、片段宽 `widthPx` 时,角标怎么画;没挂就不画 */
export function planOverlayBadge(widthPx: number, count: number): OverlayBadgePlan | null {
  if (!(count > 0)) return null;
  return {
    text: widthPx >= OVM_WIDE_PX ? `叠加 ${count}` : String(count),
    tappable: widthPx >= OVM_TAP_PX,
  };
}
