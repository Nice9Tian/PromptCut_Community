export interface ContextMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  /** 悬停说明(置灰的项说清为什么点不了;带了它的置灰项仍接悬停,点了照样不做) */
  title?: string;
  /** 右边那一列小字:参数摘要、张数这类 */
  hint?: string;
  /** 这一项带下一级:鼠标停上去在右边展开。带了它的项自己不执行 action */
  sub?: ContextMenuItem[];
  /** 危险项(删除、摘掉)画成警示色 */
  danger?: boolean;
  /** 压暗 + 名字划掉:停用的叠加卡,还在、只是不生效 */
  dim?: boolean;
}

/**
 * 菜单头:动的是哪一段 / 哪一张。
 *
 * 只有**自己就是整张菜单**的时候才写:点带里某一张卡弹出来的那张菜单,头是「在动谁」的唯一凭据,
 * 所以填底、底色取那一段的轨道色,选错了一眼看得出来。
 * 一级一级走下来的下级面板不写头 —— 上一级还在屏幕上,再写一遍只是占一行。
 */
export interface ContextMenuHead {
  title: string;
  /** 填底时右边那半:这一张挂在哪一段 */
  of?: string;
  /** 轨道色按它取(clipTrackKind 的值) */
  trackKind?: string;
}
