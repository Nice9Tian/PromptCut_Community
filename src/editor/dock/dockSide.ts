import { createContext, useContext, useSyncExternalStore } from "react";
import { sideOf, type ItemId, type Side } from "./railLayout";
import { getRailLayout, subscribeRailLayout } from "./railStore";

/**
 * "Which item on the rail is this page." DockPages wraps each page with it; components inside a page (section header, assistant top bar, script page top bar)
 * use it to read "which side am I on now", to decide which corner the collapse button goes in and which side it collapses.
 */
export const DockPageContext = createContext<ItemId | null>(null);

/**
 * The side the current page is on. Uses fallback when not inside any page (or this item is temporarily not in the layout).
 * Re-renders only when the side changes: useSyncExternalStore takes a string snapshot.
 */
export function useDockSide(fallback: Side): Side {
  const id = useContext(DockPageContext);
  const read = (): Side => (id ? sideOf(getRailLayout(), id) : null) ?? fallback;
  return useSyncExternalStore(subscribeRailLayout, read, read);
}
