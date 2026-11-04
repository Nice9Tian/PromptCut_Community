import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./railOverflow.css";
import { tr } from "../../i18n/index.ts";

/**
 * Overflow handling when the rail is too short vertically: the last slot becomes "▾ n", and clicking it opens
 * a popover attached to the rail that lists the items that do not fit.
 * Shared by the upper half of the rail (sections / script / Agent, RailBar) and the cut group beside the
 * timeline (CutTabs).
 */

/**
 * How much height is left from the top edge of el to the bottom edge of the scrolling list (its parent) it is
 * in. Recomputed when the list size changes (window resize, timeline dragged taller).
 * Uses only the difference of offsetTop, not absolute coordinates: cards have a rise-up entrance animation,
 * and measuring absolute positions would catch it mid-animation.
 */
export function useRoomBelow(ref: React.RefObject<HTMLElement | null>, list: () => HTMLElement | null | undefined): number {
  const [room, setRoom] = useState(Infinity);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = list();
    if (!el || !box) return;
    const measure = () => {
      const pad = parseFloat(getComputedStyle(box).paddingBottom || "0") || 0;
      setRoom(Math.round(box.clientHeight - pad - (el.offsetTop - box.offsetTop)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
    // list is a function that fetches the elements and is new on every render; attach it only once by ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
  return room;
}

/** The "▾ n" button is 24 high + 4 spacing */
export const RAIL_MORE_H = 28;

export const RailMoreButton = forwardRef<
  HTMLButtonElement,
  { count: number; open: boolean; hasActive?: boolean; onToggle: () => void; onPointerDown?: React.PointerEventHandler<HTMLButtonElement>; title?: string; dataPc: string }
>(function RailMoreButton({ count, open, hasActive, onToggle, onPointerDown, title, dataPc }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`pc-rail-more${open ? " is-open" : ""}${hasActive ? " has-active" : ""}`}
      data-pc={dataPc}
      aria-haspopup="menu"
      aria-expanded={open}
      title={title ?? tr("{0} more", count)}
      onPointerDown={onPointerDown}
      onClick={onToggle}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{count}</span>
    </button>
  );
});

/**
 * Popover: attached to the "▾" button, pops out toward the inside of the rail (rightward for the left rail,
 * leftward for the right rail), with its bottom edge aligned to the button's bottom edge (shifted up if it
 * does not fit).
 * Portaled to body so the overflow of the rail list does not clip it; closes on click outside or Esc.
 */
export function RailOverflowMenu({
  anchor,
  onClose,
  children,
  dataPc,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  dataPc: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const side = anchor.closest<HTMLElement>("[data-pc-dock-rail]")?.dataset.pcDockRail === "right" ? "right" : "left";
    const w = menuRef.current?.offsetWidth ?? 160;
    const h = menuRef.current?.offsetHeight ?? 0;
    const left = side === "left" ? r.right + 8 : r.left - 8 - w;
    const top = Math.max(8, Math.min(r.bottom - h, window.innerHeight - h - 8));
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || anchor?.contains(t)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={menuRef}
      className="pc-rail-menu"
      data-pc={dataPc}
      role="menu"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
