import { frameCss, frameBox, type Size } from "../kernel/layout";
import { getPart } from "../kernel/partRegistry";
import type { PartInstance } from "../kernel/types";

/**
 * Composite card rendering: mounts the part instance tree level by level onto the canvas.
 *
 *   - One `<div data-pc-part>` layer per instance, positioned using `frameCss` like cards (relative
 *     to parent box, scaled and rotated around anchor);
 *   - Not mounted before `enterMs`, mounted only when due: entrance animation starts from that moment,
 *     following the same principle as cards mounting by `clip.start`;
 *   - The `t` received by a part already subtracts its `enterMs`, and received `width` / `height` are
 *     the dimensions of its own box;
 *   - Child instances mount inside parent instance box, whose dimensions act as the parent
 *     coordinate system for child instances.
 * Unregistered part IDs render a visible placeholder to keep the entire card from becoming empty.
 */
export function PartTree({ parts, size, t, playToken }: { parts: PartInstance[]; size: Size; t: number; playToken: number }) {
  return (
    <>
      {parts.map((inst) => {
        const enter = (inst.enterMs ?? 0) / 1000;
        // Mounts slightly early like LEAD in Stage, so the first entrance frame lands right on enterMs
        if (t < enter - 0.05) return null;
        const def = getPart(inst.partId);
        const box = frameBox(inst.frame, size);
        const inner: Size = { width: box.width, height: box.height };
        return (
          <div key={`${inst.id}:${playToken}`} data-pc-part={inst.id} data-pc-part-def={inst.partId} style={frameCss(inst.frame, size)}>
            {def ? (
              <def.Component params={{ ...def.defaults, ...inst.params }} t={Math.max(0, t - enter)} playToken={playToken} width={inner.width} height={inner.height} />
            ) : (
              <div style={{ position: "absolute", inset: 0, border: "2px dashed #f87171", color: "#f87171", font: "20px system-ui", padding: 12 }}>
                Missing part {inst.partId}
              </div>
            )}
            {inst.children?.length ? <PartTree parts={inst.children} size={inner} t={Math.max(0, t - enter)} playToken={playToken} /> : null}
          </div>
        );
      })}
    </>
  );
}
