/**
 * Preview tool row (color diagnosis and correction v2, full screen, top of the middle rail).
 * It is laid directly on the L0 canvas with no bar background: three 28-square tool buttons
 * (selected: L3 background + accent outline); on the right are the monospace small text for
 * aspect ratio / frame rate, the current zoom ratio, and the "Fit window" button.
 */
import { useStore } from "../../store/project";
import { IconCursor, IconText, IconMove } from "../../ui/icons";
import { useReadOnly } from "../readOnly";
import "./preview.css";
import { tr } from "../../i18n/index.ts";

export type ToolType = "select" | "text" | "move";

const TOOLS: { key: ToolType; label: string; Icon: typeof IconCursor }[] = [
  { key: "select", label: tr("Select"), Icon: IconCursor },
  { key: "move", label: tr("Move"), Icon: IconMove },
  { key: "text", label: tr("Text"), Icon: IconText },
];

export function ToolBar({
  tool,
  onToolChange,
  zoom,
  fitted,
  onFit,
}: {
  tool: ToolType;
  onToolChange: (tool: ToolType) => void;
  /** Current zoom ratio (1 = one picture pixel takes one screen pixel) */
  zoom: number;
  /** Whether it is automatically fitting to the window */
  fitted: boolean;
  onFit: () => void;
}) {
  const width = useStore((s) => s.project.width);
  const height = useStore((s) => s.project.height);
  const fps = useStore((s) => s.project.fps);
  // This project only grants read-only access (guest): the move and text tools would change the project, so they are grayed out; select works as usual
  const ro = useReadOnly();
  return (
    <div className="pc-pv-tools" role="toolbar" aria-label={tr("Preview tools")}>
      {TOOLS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          className={`pc-pv-tool${tool === key ? " is-on" : ""}`}
          aria-pressed={tool === key}
          disabled={ro.locked && key !== "select"}
          onClick={() => onToolChange(key)}
          title={ro.locked && key !== "select" ? `${label}:${ro.why}` : label}
        >
          <Icon size={14} />
        </button>
      ))}
      <span className="pc-pv-meta">
        {width} × {height} · {fps} fps · {Math.round(zoom * 100)}%
      </span>
      {/*
        Previously this was a <span> that read "Fit window" but could not be clicked: it was merely
        stating "currently fitting to window", yet looked like a button with no response on click. Now
        that the scroll wheel zooms and middle click pans, it has a purpose: click once after adjusting
        the view manually to return to fitting the window. While still auto-fitting, the button is
        disabled (clicking produces no change anyway, better to make that clear directly).
      */}
      <button
        type="button"
        className={`pc-pv-badge pc-pv-fit${fitted ? " is-on" : ""}`}
        onClick={onFit}
        disabled={fitted}
        title={fitted ? tr("The frame is automatically fitting to the window. Scroll to zoom, middle-drag to pan") : tr("Back to fit window (scroll to zoom, middle-drag to pan)")}
      >
        {tr("Fit window")}
      </button>
    </div>
  );
}
