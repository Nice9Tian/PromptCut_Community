import { useLayoutEffect, useRef } from "react";
import { playEnter } from "../enterMotion";
import { useRailCollapsed } from "../sideRails";
import { peekPageNode, placePages, registerDockHost } from "./pageNodes";
import { effectiveActive, hasPages, visibleItems, type Side } from "./railLayout";
import { useRailLayout } from "./railStore";
import "./dock.css";

/**
 * 一侧的抽屉 / 面板卡片 = reverse portal 的宿主。它自己**不渲染任何 React 子节点**,
 * 里面的页面节点全由 pageNodes.placePages() 挪进挪出(React 不认识这些子节点,也就不会去动它们)。
 *
 * 宽度按侧走,不按项走:左侧仍是 .pc-left-drawer(--pc-left-drawer-w,pc.left.drawerW),右侧仍是 .pc-right-card
 * (--pc-right-panel-w,pc.right.panelW);收起 / 展开的淡入淡出也还是 left.css / chat.css 那两套。
 * 这一侧一个看得见的页面项都没有(被拖空,或者只剩剪辑组)时强制收起。
 *
 * 选中项换了(点 rail、拖进来一项)而抽屉本来就开着:新露出来的那一页淡入、上浮一点(enterMotion);
 * 收起着切、或者同时展开了,交给卡片自己的展开动画,不叠两层。
 */
export function DockHost({ side }: { side: Side }) {
  const layout = useRailLayout();
  const collapsedFlag = useRailCollapsed(side);
  const collapsed = collapsedFlag || !hasPages(visibleItems(layout[side]));
  const active = effectiveActive(layout, side);
  const ref = useRef<HTMLDivElement>(null);

  // 登记宿主;卸载时注销并再放一次,把这一侧的节点收回停车位(否则节点会跟着宿主一起脱离文档)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const off = registerDockHost(side, el);
    placePages();
    return () => {
      off();
      placePages();
    };
  }, [side]);

  // 布局、模式、收起状态任何一样变了都会重渲到这里:把节点摆到位、只显示选中页。幂等,多跑一次没关系
  useLayoutEffect(() => {
    placePages();
  });

  const prev = useRef({ active, collapsed });
  useLayoutEffect(() => {
    const p = prev.current;
    prev.current = { active, collapsed };
    if (!active || p.active === active || collapsed || p.collapsed) return;
    playEnter(peekPageNode(active), "pc-enter-rise");
  }, [active, collapsed]);

  return (
    <div
      ref={ref}
      className={`pc-card-surface pc-dock-host ${side === "left" ? "pc-left-drawer" : "pc-right-card"}`}
      data-pc={side === "left" ? "left-drawer" : undefined}
      data-pc-dock-host={side}
      data-pc-collapsed={collapsed ? "" : undefined}
      style={{ display: collapsed ? "none" : "flex" }}
    />
  );
}
