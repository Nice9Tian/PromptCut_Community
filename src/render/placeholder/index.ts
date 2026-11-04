import { PERF_DEGRADED } from "./placeholderStyle";

export { PlaceholderPlane } from "./placeholderPlane";
export { PLACEHOLDER_CSS, PERF_DEGRADED } from "./placeholderStyle";

/**
 * Maximum number of spinning hourglasses on the same screen. When downgraded (`PERF_DEGRADED`),
 * none spin; when not downgraded, based on Agent B measurements: one spins, the rest are static
 * (stage adds `data-pc-placeholder-static` to the slot).
 */
export const maxAnimated = PERF_DEGRADED ? 0 : 1;
export function layersFor(n: number): number {
  // When not downgraded, only that one spinning hourglass adds a layer (measured by B); after downgrade
  // there are no resident animations, adding no layers
  if (PERF_DEGRADED) return 0;
  return Number.isFinite(n) && n > 0 ? 1 : 0;
}
