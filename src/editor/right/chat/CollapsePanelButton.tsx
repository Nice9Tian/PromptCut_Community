import { setRailCollapsed } from "../../sideRails";
import { useDockSide } from "../../dock/dockSide";
import type { Side } from "../../dock/railLayout";
import "./chat.css";
import { tr } from "../../../i18n/index.ts";

/**
 * Icon for "Collapse panel": the panel frame, a sidebar strip on the edge next to the rail, and a
 * pair of arrows pointing toward the rail on the other edge: the panel collapses toward that side
 * into the rail.
 * The icon library has none, so draw one on the spot, with specs per ui/icons: 24 canvas, 1.5
 * stroke, currentColor.
 */
function IconCollapse({ side, size = 16 }: { side: Side; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      {side === "right" ? (
        <>
          <path d="M16.5 4v16" />
          <path d="M6.5 9l3 3-3 3" />
          <path d="M10.5 9l3 3-3 3" />
        </>
      ) : (
        <>
          <path d="M7.5 4v16" />
          <path d="M17.5 9l-3 3 3 3" />
          <path d="M13.5 9l-3 3 3 3" />
        </>
      )}
    </svg>
  );
}

/**
 * The "Collapse panel" shared by the assistant tab top bar (ChatHeader, and the simple top bar when
 * no driver is installed) and the script page top bar.
 * It follows the side this tab is on (dock/): on the right it goes at the far left of the top bar
 * and collapses the right side; on the left it goes at the far right of the top bar and collapses
 * the left side.
 * The top bar puts one at each end, placement="start" / "end", and the one that does not match the
 * current side is not rendered, so the keyboard Tab order matches the visible position.
 * After collapsing, click the current item on the rail to expand: it is the same switch as "click
 * the selected item again" (sideRails).
 */
export function CollapsePanelButton({ placement }: { placement?: "start" | "end" }) {
  const side = useDockSide("right");
  if (placement && placement !== (side === "right" ? "start" : "end")) return null;
  return (
    <button
      type="button"
      className={`pc-icon-btn pc-collapse-btn is-${side}`}
      data-pc={`${side}-collapse`}
      title={tr("Collapse panel")}
      aria-label={tr("Collapse panel")}
      onClick={() => setRailCollapsed(side, true)}
    >
      <IconCollapse side={side} />
    </button>
  );
}
