import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { isExportMode } from "./clock";

/**
 * 动画倍速层(预览用):每帧把容器内所有 Web Animations 的 playbackRate 设为 speed。
 * 导出时不做任何事:动画时间由 ExportView 的 __pcSyncAnims 每帧显式钉住,不靠 playbackRate。
 *
 * `style` 是给三维用的口子。看着像是「顺手加个 style 更灵活」,其实是被逼的:
 * CSS 的 `perspective` **只作用于直接子元素**,而这一层正好是卡片 div 的直接父元素。
 * 挂到更外面(比如舞台那一格)透视会静悄悄地失效 —— 卡片照样斜,但平行线还平行,
 * 是仿射拉伸不是透视,而且不报任何错。所以这个参数只该由 Stage 传,别拿它做别的。
 */
export function AnimClock({ speed = 1, style, children }: { speed?: number; style?: CSSProperties; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || isExportMode()) return;
    let raf = 0;
    const apply = () => {
      const eff = speed;
      for (const a of el.getAnimations({ subtree: true })) {
        if (a.playbackRate !== eff) a.playbackRate = eff;
      }
      raf = requestAnimationFrame(apply);
    };
    apply();
    return () => cancelAnimationFrame(raf);
  }, [speed]);
  return (
    <div ref={ref} style={{ position: "absolute", inset: 0, ...style }}>
      {children}
    </div>
  );
}
