import "./debug";
import "./left.css";
import { DockHost } from "../dock/DockHost";
import { RailBar } from "../dock/RailBar";

/**
 * Left rail = left-side rail + left-side host card (free side layout, see src/editor/dock/).
 *
 *   rail   Defaults to media library / animations / effects / edit / captions, but any item on the
 *          rail (including script and the Agent tab) can be dragged around;
 *          item positions and the selected item live in dock/railStore.ts (`pc.rail.layout.v1`).
 *          Clicking another item = switch to it (expanding if collapsed);
 *          clicking the currently selected item = collapse / expand the drawer (sideRails).
 *   drawer Just the host (DockHost): shows the page of the item currently selected on this side.
 *          The pages themselves are rendered once each in dock/DockPages.tsx and stay mounted,
 *          so switching back and forth or dragging to the other side never loses scroll position,
 *          search text or drafts.
 *          When collapsed the whole block is display:none; the column width is computed by
 *          Editor.tsx from sideRails.
 *
 * When a section is selected, a copy is still kept in localStorage `pc.left.section`
 * (scripts/left-check.mjs reads it).
 * The timeline / media library right-click "Transcribe captions" goes through captionsBus: it
 * activates the side that holds the captions section, expands it, and focuses that media
 * (wired up in DockPages).
 */
export function LeftPanel() {
  return (
    <div data-pc="left" className="pc-left">
      <RailBar side="left" />
      <DockHost side="left" />
    </div>
  );
}
