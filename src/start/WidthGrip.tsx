/**
 * 能拖宽窄的那条缝。左边的项目栏、聊天页右边的拓展栏共用这一个。
 *
 * **平时不画线**(用户 2026-10-23 定:不要常驻的竖线),只有鼠标压上来、或者用键盘聚焦到它时才亮一条
 * 强调色的线 —— 所以两栏和主区之间平时是连着的一片,要拖的时候才看得见边界在哪。
 *
 * 双击回默认宽度;方向键也能调(Shift 走大步)—— 只能用鼠标就把键盘用户关在门外了。
 */
import type { JSX, PointerEvent as ReactPointerEvent } from "react";
import { clampWidth, type WidthSpec } from "./sideWidth";

export function WidthGrip(props: {
  spec: WidthSpec;
  /** 缝在哪一边:栏在左边就是 `right`,栏在右边就是 `left` */
  side: "left" | "right";
  width: number;
  label: string;
  pc: string;
  /** 拖的过程中每帧调 */
  onWidth: (px: number) => void;
  /** 松手、双击、按键时调(这一个才写进本机) */
  onWidthCommit: (px: number) => void;
  /**
   * 在当前宽度上加减。方向键必须走这一条,不能自己算 `width + step` ——
   * 按住方向键时连发的几下都在同一帧里,每一下读到的 `width` 都还是旧的,算出来是同一个数,宽度就卡住不动了。
   */
  onWidthNudge: (delta: number) => void;
}): JSX.Element {
  /** 栏在右边时,鼠标往左拖是变宽,所以方向要反过来 */
  const dir = props.side === "right" ? 1 : -1;

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const grip = e.currentTarget;
    const startX = e.clientX;
    const startW = props.width;
    grip.setPointerCapture(e.pointerId);
    const at = (ev: PointerEvent) => clampWidth(props.spec, startW + (ev.clientX - startX) * dir);
    const move = (ev: PointerEvent) => props.onWidth(at(ev));
    const up = (ev: PointerEvent) => {
      props.onWidthCommit(at(ev));
      grip.releasePointerCapture(e.pointerId);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  };

  return (
    <div
      className="ps-grip"
      data-side={props.side}
      data-pc={props.pc}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuemin={props.spec.min}
      aria-valuemax={props.spec.max}
      aria-valuenow={props.width}
      tabIndex={0}
      onPointerDown={onDown}
      onDoubleClick={() => props.onWidthCommit(props.spec.def)}
      onKeyDown={(e) => {
        const step = (e.shiftKey ? 32 : 8) * dir;
        if (e.key === "ArrowLeft") { e.preventDefault(); props.onWidthNudge(-step); }
        if (e.key === "ArrowRight") { e.preventDefault(); props.onWidthNudge(step); }
        if (e.key === "Home") { e.preventDefault(); props.onWidthCommit(props.spec.def); }
      }}
    />
  );
}
