import { memo } from "react";
import type { CSSProperties } from "react";
import type { PlaceholderPlaneProps } from "./contract";

/** Do not write transform when scale is 1 (drawn as-is in stage pixels, DOM is identical to before) */
const scaled = (s: number | undefined): number => (typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 1);

/**
 * Placeholder plane. Hourglass forms: solid fills noise with centered hourglass; badge has only
 * the 28×28 hourglass badge. Cards that cannot be rendered locally also use the hourglass (starting
 * 2026-10-21, there is no "Local PC assisted rendering" icon). Whether the hourglass is static is
 * determined by the stage adding `data-pc-placeholder-static` to the outer slot (contract's
 * `PLACEHOLDER_STATIC_ATTR`).
 *
 * `fit` (computed by stage side based on preview scale, this layer's scale, and box;
 * `placeholderFit.ts`): hourglass scales by `fit.scale` (badge circle, the one in the middle of
 * solid form; noise does not scale). Center remains fixed.
 */
export const PlaceholderPlane = memo(function PlaceholderPlane({ clipId, geometry, reason, fit }: PlaceholderPlaneProps) {
  const solid = geometry.kind === "solid";
  const s = scaled(fit?.scale);
  const style: CSSProperties = solid
    ? { position: "absolute", left: geometry.box.left, top: geometry.box.top, width: geometry.box.width, height: geometry.box.height }
    : { position: "absolute", left: geometry.center.x - 14, top: geometry.center.y - 14, width: 28, height: 28, ...(s !== 1 ? { transform: `scale(${s})` } : null) };
  return <div data-pc-placeholder-plane="" data-pc-placeholder-kind={geometry.kind}
    data-pc-placeholder-clip={clipId} data-pc-placeholder-reason={reason}
    role="status" aria-label="System is loading" style={style}>
    <span className="pc-ph-center" aria-hidden="true" style={solid && s !== 1 ? { transform: `translate(-50%, -50%) scale(${s})` } : undefined}>
      <svg className="pc-ph-hourglass" viewBox="0 0 28 28" aria-hidden="true">
        <path d="M7 4h14M7 24h14M9 5c0 4 1 5 5 9-4 4-5 5-5 9m10-18c0 4-1 5-5 9 4 4 5 5 5 9" fill="none" stroke="#e8edf2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.5 8h7L14 12zM11 21h6l-3-3z" fill="#e8edf2" />
      </svg>
    </span>
  </div>;
});
