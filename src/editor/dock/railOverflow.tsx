import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./railOverflow.css";

/**
 * rail 竖向放不下时的收纳:最后一格换成「▾ n」,点开一个贴着 rail 弹出的子窗口,列出放不下的项。
 * rail 上半截(分区 / 剧本 / Agent,RailBar)和时间轴旁边的剪辑组(CutTabs)共用。
 */

/**
 * el 的顶边到它所在滚动列表(父元素)底边还剩多高。列表尺寸变了(窗口缩放、时间轴拖高)就重算。
 * 只用 offsetTop 的差,不用绝对坐标:卡片入场有一段上浮动画,量绝对位置会量到动画中途。
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
    // list 是取元素的函数,每次渲染都是新的;只按 ref 挂一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
  return room;
}

/** 「▾ n」按钮高 24 + 间距 4 */
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
      title={title ?? `还有 ${count} 项`}
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
 * 子窗口:贴着「▾」按钮、朝 rail 里侧(左 rail 往右、右 rail 往左)弹出,底边和按钮底边对齐(放不下就往上挪)。
 * portal 到 body,不被 rail 列表的 overflow 裁掉;点外面或 Esc 关。
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
