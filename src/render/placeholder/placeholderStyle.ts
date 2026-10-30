import { NOISE_TILE } from "./noise";

/**
 * 性能降级开关:P4 曾按熔断协议打开(每拍主线程 p90 超标),用户接受起播 +2.5 ms 后关回,恢复噪点与转动。打开时降级为
 * **极简静态占位符** —— 纯色底 + 静止沙漏,不铺噪点、不转。120 ms 出现延迟仍保留(只跑一次的 opacity 动画)。
 * `index.ts` 的 `maxAnimated` / `layersFor` 跟着它走。
 */
export const PERF_DEGRADED = false;

const NOISE_RULES = PERF_DEGRADED ? "" : `
[data-pc-placeholder-plane][data-pc-placeholder-kind="solid"] {
  background-image: ${NOISE_TILE};
  background-repeat: repeat;
}`;

const TURN_RULES = PERF_DEGRADED ? "" : `
[data-pc-placeholder-plane] .pc-ph-hourglass {
  transform-origin: 50% 50%;
  animation: pc-ph-turn 1800ms ease-in-out infinite;
}
[data-pc-placeholder-static] .pc-ph-hourglass,
[data-pc-placeholder-plane][data-pc-placeholder-static] .pc-ph-hourglass {
  animation: none;
}
@keyframes pc-ph-turn { from { transform: rotate(0deg); } to { transform: rotate(180deg); } }`;

export const PLACEHOLDER_CSS = `
[data-pc-placeholder-plane] {
  position: absolute;
  box-sizing: border-box;
  overflow: hidden;
  animation: pc-ph-reveal 120ms steps(1, end) 1;
}
[data-pc-placeholder-plane][data-pc-placeholder-kind="solid"] {
  background-color: #30343d;
}
[data-pc-placeholder-plane][data-pc-placeholder-kind="badge"] {
  border-radius: 50%;
  background: #30343d;
}
[data-pc-placeholder-plane] .pc-ph-center {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 28px;
  height: 28px;
  transform: translate(-50%, -50%);
}
[data-pc-placeholder-plane] .pc-ph-hourglass {
  display: block;
  width: 28px;
  height: 28px;
}${NOISE_RULES}${TURN_RULES}
@keyframes pc-ph-reveal { from { opacity: 0; } to { opacity: 1; } }
`;
