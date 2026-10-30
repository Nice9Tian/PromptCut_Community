import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ContextMenuHead, ContextMenuItem } from "./types";

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** 菜单头:动的是哪一段 / 哪一张。不给就没有头(老调用方一个字不变) */
  head?: ContextMenuHead;
  onClose: () => void;
}

/** 菜单离视口边缘至少留这么多 */
const EDGE = 6;
/** 鼠标离开之后多久收起下一级(中途拐进下一级不收) */
const SUB_CLOSE_MS = 220;

export function ContextMenu({ x, y, items, head, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 靠窗口右边 / 底部时往回夹:时间轴就在窗口最下面,右键靠下的片段时菜单原来会戳出窗口。
  // layout effect 里量完再改位置,浏览器画出来之前就已经夹好了
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
      // 下一级是另开的 portal,不在 ref 里;它自己标了 data-pc="tl-ctxsub"
      const t = e.target as HTMLElement | null;
      if (ref.current && !ref.current.contains(t) && !t?.closest?.('[data-pc="tl-ctxsub"]')) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 时间轴或窗口一滚动 / 缩放,菜单指着的位置就不对了,直接关掉
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

  // 片段 / 行头所在的层是独立层叠上下文(index.tsx 的 isolation),菜单留在里面会被吸顶的标尺和行头列压住,
  // 所以 portal 到 body。React 事件仍按组件树冒泡,和原来挂在片段里一样;颜色不再能靠 [data-pc="timeline"] 下的换色规则,
  // 直接用皮肤变量(.pc-tl-ctxmenu,timeline.css)。
  return createPortal(
    <Panel ref={ref} left={pos.left} top={pos.top} items={items} head={head} onClose={onClose} />,
    document.body,
  );
}

/**
 * 一级面板。带 `sub` 的项鼠标停上去在右边开下一级,下一级还是这个组件 ——
 * 「片段菜单 → 叠加卡 → 这一张能做的事」三级共用一份代码。
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
            // 带下一级的项自己不执行:点一下也当成展开,触屏和习惯点击的人都走得通
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

/** 下一级:位置量完再往回夹,免得戳出窗口 */
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
