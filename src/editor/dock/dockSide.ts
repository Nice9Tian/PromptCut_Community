import { createContext, useContext, useSyncExternalStore } from "react";
import { sideOf, type ItemId, type Side } from "./railLayout";
import { getRailLayout, subscribeRailLayout } from "./railStore";

/**
 * 「我这一页是 rail 上的哪一项」。DockPages 给每一页包一层;页面里的组件(分区头部、助手顶栏、剧本页顶栏)
 * 靠它读「我现在在哪一侧」,决定收起钮放哪个角、收哪一侧。
 */
export const DockPageContext = createContext<ItemId | null>(null);

/**
 * 当前页所在的一侧。不在任何页里(或者这一项暂时不在布局里)时用 fallback。
 * 只在侧变了的时候重渲:useSyncExternalStore 取的是字符串快照。
 */
export function useDockSide(fallback: Side): Side {
  const id = useContext(DockPageContext);
  const read = (): Side => (id ? sideOf(getRailLayout(), id) : null) ?? fallback;
  return useSyncExternalStore(subscribeRailLayout, read, read);
}
