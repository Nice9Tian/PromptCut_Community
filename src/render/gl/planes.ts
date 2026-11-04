/**
 * gl planes currently attached in this document (R9 M1 / M3).
 *
 * `Stage` renders a `<canvas data-pc-gl-plane={clipId}>` (`GlPlane`) in the wrapper layer for clips
 * with a `canvas` contract. On each commit, in a layout effect, it registers "what to draw for this
 * tick" here: local seconds `t`, local frame number, parameters, remount generation, dimensions,
 * and whether to draw this tick. `glHost` reads this table when sending `beat`: so the host only
 * needs to commit via `flushSync` first, then `glHost.beat()`, to get the frame just committed.
 *
 * Module-level singleton: each document (the two stages, export page) has its own module instance,
 * independent of each other.
 */

export interface GlPlaneEntry {
  clipId: string;
  canvas: HTMLCanvasElement;
  kind: "gl" | "three" | "2d";
  programId: string;
  /** Canvas pixel dimensions (= clip entity box) */
  w: number;
  h: number;
  /** Local seconds passed to the card (same value as `t` passed to the component) */
  t: number;
  /** Local frame number for this tick: same formula as wrapper layer `data-pc-local-frame`; written to `data-pc-gl-frame` after bitmap paste */
  frame: number;
  params: Record<string, unknown>;
  paramsKey: string;
  /** Remount generation (`remountGen ?? playToken`): changed = this card needs `reset` */
  gen: number;
  /** In `suppressed`, or in `snapshots` and not in `settling`: do not draw this tick (M3) */
  skip: boolean;
  textures: Array<{ name: string; url: string }>;
  stage: { width: number; height: number; camera3dFov?: number };
}

export const glPlanes = new Map<string, GlPlaneEntry>();
