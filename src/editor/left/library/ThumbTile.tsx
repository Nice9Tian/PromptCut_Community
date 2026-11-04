import type { ReactNode } from "react";

/**
 * Thumbnail preview in an overview group box: same look as PreviewCard, but display only ——
 * no click, drag or context menu, and no data-pc-card / data-pc-media hooks (those belong only to the
 * real cards in the detail),
 * otherwise clicking a thumbnail would both add to the playhead and open the group, and automation
 * scripts would find two elements with the same name.
 *
 * The one exception is `onHover` (hover to play a video thumbnail): when given, this cell takes the
 * pointer (.is-hoverplay flips back the pointer-events: none of the group box's thumbnail area), but
 * it only listens for enter and leave; a click still bubbles up to the group box to open the group.
 */
export function ThumbTile({
  title,
  subtitle,
  preview,
  badge,
  name,
  desc,
  onHover,
}: {
  /** Title bar pressed against the bottom edge */
  title?: string;
  subtitle?: string;
  /** Picture area content (image, video first frame, diagram) */
  preview?: ReactNode;
  badge?: ReactNode;
  /** The "name + description" text picture of a motion graphics card when not hovered */
  name?: string;
  desc?: string;
  /** Pointer enters / leaves this cell */
  onHover?: (hot: boolean) => void;
}) {
  return (
    <div
      className={`pc-lib-card is-static${onHover ? " is-hoverplay" : ""}`}
      onMouseEnter={onHover ? () => onHover(true) : undefined}
      onMouseLeave={onHover ? () => onHover(false) : undefined}
    >
      <div className="pc-lib-card-view">
        {preview}
        {name != null && (
          <div className="pc-lib-card-text">
            <div className="pc-lib-card-name">{name}</div>
            {desc && <div className="pc-lib-card-desc">{desc}</div>}
          </div>
        )}
      </div>
      {title ? (
        <div className="pc-lib-card-cap">
          <div className="pc-lib-card-title">{title}</div>
          {(badge != null || subtitle) && (
            <div className="pc-lib-card-meta">
              {badge != null && <span className="pc-lib-card-badge">{badge}</span>}
              {subtitle && <span className="pc-lib-card-sub">{subtitle}</span>}
            </div>
          )}
        </div>
      ) : (
        badge != null && <span className="pc-lib-card-badge is-corner">{badge}</span>
      )}
    </div>
  );
}
