import { useLayoutEffect, useRef } from "react";
import { playEnter } from "../enterMotion";
import { useRailCollapsed } from "../sideRails";
import { peekPageNode, placePages, registerDockHost } from "./pageNodes";
import { effectiveActive, hasPages, visibleItems, type Side } from "./railLayout";
import { useRailLayout } from "./railStore";
import "./dock.css";

/**
 * The drawer / panel card on one side = the host of the reverse portal. It **renders no React children** itself;
 * the page nodes inside are all moved in and out by pageNodes.placePages() (React does not know about these children, so it will not touch them).
 *
 * Width follows the side, not the item: the left is still .pc-left-drawer (--pc-left-drawer-w, pc.left.drawerW), the right is still .pc-right-card
 * (--pc-right-panel-w, pc.right.panelW); the collapse / expand fade is also still the two sets in left.css / chat.css.
 * When this side has no visible page item at all (dragged empty, or only the cut group remains) it is forced to collapse.
 *
 * When the selected item changes (click on the rail, an item dragged in) while the drawer is already open: the newly revealed page fades in and floats up a little (enterMotion);
 * if it was collapsed when switching, or expanded at the same time, leave it to the card's own expand animation and do not stack two.
 */
export function DockHost({ side }: { side: Side }) {
  const layout = useRailLayout();
  const collapsedFlag = useRailCollapsed(side);
  const collapsed = collapsedFlag || !hasPages(visibleItems(layout[side]));
  const active = effectiveActive(layout, side);
  const ref = useRef<HTMLDivElement>(null);

  // Register the host; on unmount unregister and place once more, to take this side's nodes back to the parking slot (otherwise the nodes would leave the document together with the host)
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

  // A change in layout, mode, or collapsed state re-renders down to here: put the nodes in place and show only the selected page. Idempotent, running it once more does no harm
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
