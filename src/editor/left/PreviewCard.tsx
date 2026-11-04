import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReadOnly } from "../readOnly";

/**
 * The left rail's unified preview card: motion graphics cards, parts, transitions, emphasis, video and
 * images all look like this.
 *
 * A card = picture area + a title bar pressed against the bottom edge + (optional) an accent-colored
 * progress bar along the bottom edge.
 * What goes in the picture area is up to the caller (`preview`); this only handles the shell: size, hover,
 * drag, right click, title, corner badge, progress bar, error message. Hover state is maintained here and
 * passed back (`onHover`); videos should only play on hover and motion graphics cards should only start
 * animating on hover, both relying on this one signal.
 *
 * Size can be given in two ways: `fill` fills the cell given from outside (the masonry layout has already
 * fixed the height by tileHeight), otherwise `aspect` (height / width, default square) is used.
 * Media is center-cropped with object-fit: cover.
 *
 * Styles are in .pc-lib-card* of left.css. It **does not reuse** the `.cursor-grab.bg-neutral-900` skin
 * rules: on hover they draw a 3px accent-colored inner shadow on the card's left edge, and once the preview
 * fills the card that becomes a colored edge leaking into the picture. The hover state here only draws an
 * outline, no inner shadow.
 */
export interface PreviewCardProps {
  title: string;
  subtitle?: string;
  /** Picture area content. When null, only the title and description are shown (this is how a motion graphics card looks when not hovered) */
  preview: ReactNode;
  /** 0..1, draws the accent-colored progress bar along the bottom edge; null / undefined draws nothing */
  progress?: number | null;
  /** Hover delay (milliseconds): a motion graphics card waits a moment before animating, so that sweeping the mouse across does not make them all perform at once */
  hoverDelayMs?: number;
  onHover?: (hot: boolean) => void;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  /** A fleeting error message (e.g. "no motion track"), shown whenever non-empty */
  error?: string | null;
  /** One more row below the picture area (the action buttons of a seam card on the transitions tab) */
  footer?: ReactNode;
  /** Things like data-* attributes set on the root node, which automated tests use to locate them */
  attrs?: Record<string, string>;
  titleAttr?: string;
  /** When the title bar is shown: always / only on hover (when a motion graphics card is not hovered, its name is already written in the picture area) */
  caption?: "always" | "hover";
  /** Height / width; square if not given. Ignored when fill is set */
  aspect?: number;
  /** Small dark pill at the bottom left (video duration 0:13) */
  badge?: ReactNode;
  /** Fill the parent container (a masonry cell) */
  fill?: boolean;
  /**
   * Clicking or dragging it changes the project (add to the timeline, add into a composite card, apply
   * emphasis / a transition to a clip). When this project only grants read-only access (guest), a card with
   * this item does not accept clicks or drags, and hovering states the reason; view-only things such as hover
   * preview and the right-click menu work as usual.
   */
  edits?: boolean;
}

export function PreviewCard(props: PreviewCardProps) {
  const {
    title, subtitle, preview, progress, hoverDelayMs = 0, onHover, onClick, onContextMenu, draggable, onDragStart, onDragEnd,
    error, footer, attrs, titleAttr, caption = "always", aspect, badge, fill, edits,
  } = props;
  const ro = useReadOnly();
  const frozen = !!edits && ro.locked;
  const [hot, setHot] = useState(false);
  const timer = useRef<number | null>(null);
  const hotRef = useRef(false);

  const setHotBoth = (v: boolean) => {
    if (hotRef.current === v) return;
    hotRef.current = v;
    setHot(v);
    onHover?.(v);
  };

  const enter = () => {
    if (timer.current) window.clearTimeout(timer.current);
    if (hoverDelayMs > 0) {
      timer.current = window.setTimeout(() => setHotBoth(true), hoverDelayMs);
    } else {
      setHotBoth(true);
    }
  };
  const leave = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setHotBoth(false);
  };

  // On unmount, do not leave a timer behind, and do not let the parent think it is still hovered
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const showCaption = caption === "always" || hot;
  const pct = typeof progress === "number" && Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null;
  const hasBadge = badge != null && badge !== false;

  return (
    <div className={`pc-lib-card-wrap${fill ? " is-fill" : ""}`}>
      <div
        {...attrs}
        className={`pc-lib-card${hot ? " is-hot" : ""}${draggable && !frozen ? " is-grab" : ""}${onClick && !frozen ? " is-click" : ""}${frozen ? " is-readonly" : ""}`}
        aria-disabled={frozen || undefined}
        draggable={draggable && !frozen}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onDragStart={(e) => { leave(); onDragStart?.(e); }}
        onDragEnd={onDragEnd}
        onClick={frozen ? undefined : onClick}
        onContextMenu={onContextMenu}
        title={frozen ? `${title}\n${ro.why}` : titleAttr}
        style={fill ? undefined : { aspectRatio: `1 / ${aspect && aspect > 0 ? aspect : 1}` }}
      >
        <div className="pc-lib-card-view">{preview}</div>
        {showCaption ? (
          <div className="pc-lib-card-cap">
            <div className="pc-lib-card-title">{title}</div>
            {(hasBadge || subtitle) && (
              <div className="pc-lib-card-meta">
                {hasBadge && <span className="pc-lib-card-badge">{badge}</span>}
                {subtitle && <span className="pc-lib-card-sub">{subtitle}</span>}
              </div>
            )}
          </div>
        ) : (
          hasBadge && <span className="pc-lib-card-badge is-corner">{badge}</span>
        )}
        {pct !== null && (
          <div className="pc-lib-card-bar" aria-hidden="true">
            <div className="pc-lib-card-bar-fill" style={{ width: `${pct * 100}%` }} />
          </div>
        )}
        {error && <div className="pc-lib-card-err">{error}</div>}
      </div>
      {footer}
    </div>
  );
}
