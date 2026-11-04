import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ContextMenuHead, ContextMenuItem } from "./types";

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** Menu header: which segment / which card is being changed. If not given there is no header (old callers unchanged to the letter) */
  head?: ContextMenuHead;
  onClose: () => void;
}

/** The menu keeps at least this much distance from the viewport edge */
const EDGE = 6;
/** How long after the mouse leaves before the next level closes (no closing if you turn into the next level midway) */
const SUB_CLOSE_MS = 220;

export function ContextMenu({ x, y, items, head, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp back when near the right edge / bottom of the window: the timeline is at the very bottom of the
  // window, and right-clicking a low clip used to make the menu poke out of the window.
  // Measure in a layout effect and then change the position, so it is already clamped before the browser paints
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - r.width - EDGE));
    const top = Math.max(EDGE, Math.min(y, window.innerHeight - r.height - EDGE));
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  }, [x, y, items.length]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      // The next level is a separate portal, not inside the ref; it marks itself with data-pc="tl-ctxsub"
      const t = e.target as HTMLElement | null;
      if (ref.current && !ref.current.contains(t) && !t?.closest?.('[data-pc="tl-ctxsub"]')) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Once the timeline or window scrolls / zooms, the position the menu points at is wrong, so just close it
    const close = () => onClose();
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", close, { capture: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  // The layer holding clips / row headers is its own stacking context (isolation in index.tsx), so a menu
  // left inside it would be covered by the sticky ruler and row header column, hence the portal to body.
  // React events still bubble along the component tree, same as when it was mounted inside the clip; colors
  // can no longer rely on the recolor rules under [data-pc="timeline"] and use skin variables directly
  // (.pc-tl-ctxmenu, timeline.css).
  return createPortal(
    <Panel ref={ref} left={pos.left} top={pos.top} items={items} head={head} onClose={onClose} />,
    document.body,
  );
}

/**
 * First-level panel. An item with `sub` opens the next level on the right on hover, and the next level
 * is this same component: "clip menu → overlay card → what this card can do" share one piece of code.
 */
function Panel({
  ref, left, top, items, head, onClose, nested,
}: {
  ref?: React.Ref<HTMLDivElement>;
  left: number;
  top: number;
  items: ContextMenuItem[];
  head?: ContextMenuHead;
  onClose: () => void;
  nested?: boolean;
}) {
  const [open, setOpen] = useState<{ index: number; left: number; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const hold = () => clearTimeout(timer.current);
  const release = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(null), SUB_CLOSE_MS);
  };

  const openSub = (index: number, el: HTMLElement) => {
    hold();
    const r = el.getBoundingClientRect();
    setOpen({ index, left: r.right + 4, top: r.top - 4 });
  };

  const body = (
    <div
      ref={ref}
      data-pc={nested ? "tl-ctxsub" : "tl-ctxmenu"}
      className="pc-tl-ctxmenu fixed min-w-[150px] py-1 text-sm"
      style={{ left, top }}
      onMouseEnter={hold}
      onMouseLeave={release}
    >
      {head && (
        <div className={`pc-tl-ctxhead${head.of ? " is-fill" : ""}`} data-track-kind={head.trackKind}>
          <b>{head.title}</b>
          {head.of && <span>{head.of}</span>}
        </div>
      )}
      {items.map((item, i) => (
        <div
          key={i}
          title={item.title}
          aria-disabled={item.disabled || undefined}
          className={`pc-tl-ctxmenu-item px-3 py-1.5 cursor-pointer ${item.sub ? "has-sub" : ""} ${item.danger ? "is-danger" : ""} ${item.dim ? "is-dim" : ""} ${item.disabled ? (item.title ? "opacity-50 cursor-default" : "opacity-50 pointer-events-none") : ""}`}
          onMouseEnter={(e) => (item.sub ? openSub(i, e.currentTarget) : (hold(), setOpen(null)))}
          onClick={(e) => {
            if (item.disabled) return;
            // An item with a next level does not run itself: a click also expands it, which works for touch screens and for people used to clicking
            if (item.sub) { openSub(i, e.currentTarget); return; }
            item.action();
            onClose();
          }}
        >
          <span className="lb">{item.label}</span>
          {item.hint && <span className="hint">{item.hint}</span>}
          {item.sub && <span className="chev">›</span>}
        </div>
      ))}
    </div>
  );

  if (!open || !items[open.index]?.sub) return body;
  return (
    <>
      {body}
      {createPortal(
        <SubPanel left={open.left} top={open.top} items={items[open.index].sub!} onClose={onClose} onHold={hold} onRelease={release} />,
        document.body,
      )}
    </>
  );
}

/** Next level: measure the position first, then clamp it back so it does not poke out of the window */
function SubPanel({
  left, top, items, onClose, onHold, onRelease,
}: {
  left: number;
  top: number;
  items: ContextMenuItem[];
  onClose: () => void;
  onHold: () => void;
  onRelease: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left, top });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const l = Math.max(EDGE, Math.min(left, window.innerWidth - r.width - EDGE));
    const t = Math.max(EDGE, Math.min(top, window.innerHeight - r.height - EDGE));
    setPos((p) => (p.left === l && p.top === t ? p : { left: l, top: t }));
  }, [left, top, items.length]);
  return (
    <div onMouseEnter={onHold} onMouseLeave={onRelease}>
      <Panel ref={ref} left={pos.left} top={pos.top} items={items} onClose={onClose} nested />
    </div>
  );
}
