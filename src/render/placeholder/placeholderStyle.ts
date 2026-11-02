import { NOISE_TILE } from "./noise";

/**
 * Performance downgrade switch: opened during P4 under the circuit breaker protocol (main thread
 * p90 exceeded limit per tick), turned back off after user accepted +2.5 ms on playback start,
 * restoring noise and rotation. When enabled, downgrades to a **minimal static placeholder**: solid
 * background + static hourglass, no noise, no spinning. The 120 ms appearance delay remains (a
 * one-shot opacity animation). `maxAnimated` / `layersFor` in `index.ts` follow it.
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
