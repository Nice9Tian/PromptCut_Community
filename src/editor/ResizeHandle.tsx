import { useRef } from "react";

/**
 * 面板拖杆。左栏 / 右栏 / 时间轴共用这一根:
 * - axis="x" 拖出宽度,axis="y" 拖出高度
 * - invert:拖动方向和尺寸增长方向相反(右栏往左拖变宽、时间轴往上拖变高)
 * - 双击回到默认尺寸
 *
 * 拖动期间给 <body> 打上 data-pc-resizing:预览是个 iframe,鼠标滑进去就收不到
 * pointermove 了(虽然有 setPointerCapture 兜底,但按下时若捕获失败就会断),
 * 所以直接让它这会儿不吃鼠标事件。顺带把光标和禁选也统一成拖动态。
 *
 * 给了 `onNudge` 的那一根还能用键盘调(氛围式详细编辑里那一根这么用,issue #40):
 * 能 Tab 到、方向键一下一下地调、Shift 走大步、Home 复位 —— 只能用鼠标就把键盘用户关在门外了
 * (和开始页两条栏的拖缝一个道理,`src/start/WidthGrip.tsx`)。不给就还是原来那样,不进 Tab 顺序。
 */
export function ResizeHandle({
  axis,
  value,
  min,
  max,
  invert = false,
  disabled = false,
  onChange,
  onCommit,
  onReset,
  onNudge,
  title,
  pc,
}: {
  axis: "x" | "y";
  value: number;
  min: number;
  max: number | (() => number);
  invert?: boolean;
  disabled?: boolean;
  onChange: (next: number) => void;
  onCommit: () => void;
  onReset?: () => void;
  /**
   * 在当前尺寸上加减(px)。给了它这一根才吃键盘。
   *
   * 为什么不是自己算 `value + step`:按住方向键时连发的几下都在同一帧里,每一下读到的 `value` 都还是旧的,
   * 算出来是同一个数,尺寸就卡住不动了 —— 怎么接住见各调用方(同 `WidthGrip.tsx` 的 `onWidthNudge`)。
   */
  onNudge?: (delta: number) => void;
  title?: string;
  /** 探针用的记号(`data-pc`) */
  pc?: string;
}) {
  const latest = useRef(value);
  latest.current = value;

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const start = axis === "x" ? e.clientX : e.clientY;
    const startValue = value;
    const sign = invert ? -1 : 1;

    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // 指针已经不在了(合成事件等),没有捕获也能拖
    }
    document.body.dataset.pcResizing = axis;
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const now = axis === "x" ? ev.clientX : ev.clientY;
      const upper = typeof max === "function" ? max() : max;
      onChange(Math.max(min, Math.min(upper, startValue + (now - start) * sign)));
    };
    const onUp = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        // 已经放开了
      }
      delete document.body.dataset.pcResizing;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onCommit();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const cursorClass = disabled ? "" : (axis === "x" ? "cursor-col-resize" : "cursor-row-resize");
  const disabledClass = disabled ? "is-disabled" : "";

  const keyboard = !!onNudge && !disabled;
  /** 方向键按下去那一下,分隔条往屏幕哪个方向走 */
  const stepKeys = axis === "x" ? { less: "ArrowLeft", more: "ArrowRight" } : { less: "ArrowUp", more: "ArrowDown" };

  return (
    <div
      data-pc-resize={axis}
      data-pc={pc}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={keyboard ? title : undefined}
      aria-valuenow={keyboard ? Math.round(value) : undefined}
      aria-valuemin={keyboard ? min : undefined}
      aria-valuemax={keyboard && typeof max === "number" ? max : undefined}
      tabIndex={keyboard ? 0 : undefined}
      style={{ pointerEvents: disabled ? "none" : "auto" }}
      className={`pc-gutter shrink-0 touch-none flex items-center justify-center ${
        axis === "x" ? "w-2 h-full" : "h-2 w-full"
      } ${cursorClass} ${disabledClass}`}
      title={title ?? (onReset ? "拖动调整大小,双击复位" : "拖动调整大小")}
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (!keyboard) return;
        // 屏幕上往 less 那头走是负向;invert 的那一根(右栏、时间轴)尺寸增长方向正好相反
        const screen = (e.shiftKey ? 32 : 8) * (invert ? -1 : 1);
        if (e.key === stepKeys.less) { e.preventDefault(); onNudge?.(-screen); }
        if (e.key === stepKeys.more) { e.preventDefault(); onNudge?.(screen); }
        if (e.key === "Home" && onReset) { e.preventDefault(); onReset(); }
      }}
    />
  );
}
