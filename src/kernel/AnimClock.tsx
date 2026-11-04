import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { isExportMode } from "./clock";

/**
 * Animation speed multiplier layer (for preview): sets playbackRate of all Web Animations in the
 * container to speed on every frame.
 * Does nothing during export: animation time is explicitly pinned on every frame by __pcSyncAnims
 * in ExportView, rather than relying on playbackRate.
 *
 * `style` is an escape hatch for 3D. While it looks like "conveniently adding style for flexibility",
 * it was actually forced: CSS `perspective` **only applies to direct children**, and this layer is
 * precisely the direct parent of the card div. Attaching further outside (such as the stage cell),
 * perspective silently fails: the card is tilted, but parallel lines remain parallel: it is affine
 * stretching, not perspective, without throwing any error. So this param should only be passed by
 * Stage, do not use it for anything else.
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
