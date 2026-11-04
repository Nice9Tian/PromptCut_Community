import type { ReactNode } from "react";
import { setRailCollapsed } from "../sideRails";
import { useDockSide } from "../dock/dockSide";
import { tr } from "../../i18n/index.ts";

/**
 * Shared head of the five left rail sections: a title row (section name + "Collapse panel") + the
 * section's own main button / search / pill (children) below.
 *
 * A section can be dragged to the right rail (dock/), and the collapse button follows the side it
 * is on: on the left it sits at the top right and collapses to the left
 * (`data-pc="left-collapse"`); on the right it sits at the top left and collapses to the right
 * (`data-pc="right-collapse"`).
 * The collapse button takes the same path as "clicking the current rail item again" (sideRails):
 * the column-width transition in Editor.tsx and the card fade-out work as before, and no
 * animation is done here. After collapsing the rail stays, and clicking the current item expands
 * it again.
 */
export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  const side = useDockSide("left");
  const collapse = (
    <button
      type="button"
      className="pc-icon-btn pc-left-collapse"
      data-pc={`${side}-collapse`}
      title={tr("Collapse panel")}
      aria-label={tr("Collapse panel")}
      onClick={() => setRailCollapsed(side, true)}
    >
      {/* Panel outline + a sidebar line on the side next to the rail + an arrow toward the rail: collapse toward that side */}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
        {side === "left" ? (
          <>
            <path d="M9 4.5v15" />
            <path d="M16 9.5 13.5 12l2.5 2.5" />
          </>
        ) : (
          <>
            <path d="M15 4.5v15" />
            <path d="M8 9.5 10.5 12 8 14.5" />
          </>
        )}
      </svg>
    </button>
  );
  return (
    <div className="pc-left-head">
      <div className={`pc-left-titlerow${side === "right" ? " is-right" : ""}`}>
        {side === "right" && collapse}
        <div className="pc-section-title">{title}</div>
        {side === "left" && collapse}
      </div>
      {children}
    </div>
  );
}
