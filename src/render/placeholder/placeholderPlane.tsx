import { memo } from "react";
import type { CSSProperties } from "react";
import type { PlaceholderPlaneProps } from "./contract";

/** 倍数 1 时不写 transform(按舞台像素原样画,DOM 与以前相同) */
const scaled = (s: number | undefined): number => (typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 1);

/**
 * 占位平面。沙漏形态:solid 铺噪点、沙漏居中;badge 只有 28×28 的沙漏徽标。
 * 本机渲染不了的卡同样是沙漏(2026-10-21 起没有「本地 PC 辅助渲染」的图标)。
 * 沙漏是否静止由舞台给外面的槽位加 `data-pc-placeholder-static` 决定(contract 的 `PLACEHOLDER_STATIC_ATTR`)。
 *
 * `fit`(舞台一侧按预览缩放、这一层的缩放与框算好,`placeholderFit.ts`):沙漏按 `fit.scale` 放大(徽标的圆、铺满形态中间
 * 那个;噪点不缩放)。中心不动。
 */
export const PlaceholderPlane = memo(function PlaceholderPlane({ clipId, geometry, reason, fit }: PlaceholderPlaneProps) {
  const solid = geometry.kind === "solid";
  const s = scaled(fit?.scale);
  const style: CSSProperties = solid
    ? { position: "absolute", left: geometry.box.left, top: geometry.box.top, width: geometry.box.width, height: geometry.box.height }
    : { position: "absolute", left: geometry.center.x - 14, top: geometry.center.y - 14, width: 28, height: 28, ...(s !== 1 ? { transform: `scale(${s})` } : null) };
  return <div data-pc-placeholder-plane="" data-pc-placeholder-kind={geometry.kind}
    data-pc-placeholder-clip={clipId} data-pc-placeholder-reason={reason}
    role="status" aria-label="系统正在加载" style={style}>
    <span className="pc-ph-center" aria-hidden="true" style={solid && s !== 1 ? { transform: `translate(-50%, -50%) scale(${s})` } : undefined}>
      <svg className="pc-ph-hourglass" viewBox="0 0 28 28" aria-hidden="true">
        <path d="M7 4h14M7 24h14M9 5c0 4 1 5 5 9-4 4-5 5-5 9m10-18c0 4-1 5-5 9 4 4 5 5 5 9" fill="none" stroke="#e8edf2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.5 8h7L14 12zM11 21h6l-3-3z" fill="#e8edf2" />
      </svg>
    </span>
  </div>;
});
