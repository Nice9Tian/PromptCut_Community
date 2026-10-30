import { PERF_DEGRADED } from "./placeholderStyle";

export { PlaceholderPlane } from "./placeholderPlane";
export { PLACEHOLDER_CSS, PERF_DEGRADED } from "./placeholderStyle";

/**
 * 同屏最多几个沙漏在转。降级(`PERF_DEGRADED`)时一个都不转;
 * 不降级时按智能体 B 的实测:一个在转,其余静止(舞台给槽位加 `data-pc-placeholder-static`)。
 */
export const maxAnimated = PERF_DEGRADED ? 0 : 1;
export function layersFor(n: number): number {
  // 不降级时只有那一个在转的沙漏新增一层(B 实测);降级后没有常驻动画,不新增层
  if (PERF_DEGRADED) return 0;
  return Number.isFinite(n) && n > 0 ? 1 : 0;
}
