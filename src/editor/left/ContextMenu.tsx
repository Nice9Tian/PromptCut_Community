import { useEffect, useLayoutEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string; /** 悬停说明(置灰的项说清为什么点不了) */ title?: string }

export function ContextMenu({ x, y, items, onClose }: { x:number; y:number; items:ContextMenuItem[]; onClose:()=>void }) {
  const [pos, setPos] = useState({ left: x, top: y });
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const ww = window.innerWidth;
      const wh = window.innerHeight;
      
      let newLeft = x;
      let newTop = y;
      
      if (x + rect.width > ww - 6) {
        newLeft = ww - rect.width - 6;
      }
      if (y + rect.height > wh - 6) {
        newTop = wh - rect.height - 6;
      }
      
      setPos({ left: newLeft, top: newTop });
    }
  }, [x, y]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    
    const onScroll = () => onClose();
    const onResize = () => onClose();
    const onBlur = () => onClose();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("scroll", onScroll, { capture: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose]);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div 
      data-pc="ctxmenu"
      ref={ref}
      onContextMenu={onContextMenu}
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      className="min-w-32 rounded border border-neutral-700 bg-neutral-900 shadow-xl py-1 z-[900] text-xs"
    >
      {items.map((item, i) => (
        <button
          key={i}
          role="menuitem"
          data-pc-item={item.label}
          disabled={item.disabled}
          title={item.title}
          onClick={() => {
            if (item.disabled) return;
            onClose();
            item.onClick();
          }}
          className={`w-full text-left px-3 py-1.5 hover:bg-neutral-800 disabled:opacity-40 flex items-center gap-3 justify-between ${item.danger ? 'text-red-400' : 'text-neutral-200'}`}
        >
          <span>{item.label}</span>
          {item.hint && <span className="text-neutral-500">{item.hint}</span>}
        </button>
      ))}
    </div>,
    document.body
  );
}
