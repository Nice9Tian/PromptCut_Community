/**
 * The single conversion point for 3D space. The CSS half and the three.js half both take their numbers
 * from here; each is not allowed to compute its own.
 *
 * # Why there must be only one place
 *
 * `layout.ts` has to compute CSS `perspective` and `transform`, and later layer B has to compute the
 * three.js camera. Both sides compute the same thing. If they were written separately, as soon as one
 * place changed without the other being synced, the picture would **silently drift out of place**:
 * no error, no crash, just "doesn't look quite right", and that kind of problem is the hardest to
 * track down. So the numbers come out only here, and both sides are callers.
 *
 * # Scale convention
 *
 * **1 world unit = 1 stage pixel**, and the screen plane is `z = 0`.
 * This must be pinned down: once world units and pixels are decoupled, the moment 3D mode is turned
 * on the whole picture would suddenly rescale, when the user only wanted a card tilted a bit.
 *
 * # d is not a free parameter
 *
 * Once the scale is pinned down, camera distance and field of view are locked together:
 *
 *     d = H / (2 · tan(fov/2))
 *
 * So **only fov is exposed, and d is derived from it**; do not turn it around and make people fill in
 * d. There are two reasons:
 *
 * 1. In a portrait project H is 1920, and the perspective strength of the same d changes with it; fov
 *    is a direct expression of "how strong the perspective is" and is stable across aspect ratios.
 * 2. Intuition about d is misleading. `d = 100` looks like a reasonable camera distance but actually
 *    corresponds to **fov 159°**, which is a fisheye.
 *
 * # Coordinate system
 *
 * The stage uses screen coordinates (origin at top left, y pointing down), while three.js is
 * right-handed (origin centered, y pointing up).
 * When converting, **y must be flipped**, and the positive direction of `z` is **toward the viewer**
 * (consistent with CSS `translateZ(+)`).
 * The camera is placed at `+z`: the three.js default camera looks toward −z, so placing it at +d is
 * the natural orientation, and also the one aligned with CSS.
 * Writing −d would either put the camera with its back to the screen or make the sign of z opposite
 * to CSS; both are "looks wrong but hard to say why" bugs.
 */

import { resolveFrameSize } from "./frameSize.mjs";

/** Default perspective strength. 40° is steady; 50° is pronounced; 30° is close to orthographic */
export const DEFAULT_FOV_DEG = 40;

/**
 * Reasonable range for fov. Too small and there is no sense of perspective, too large and it turns
 * fisheye (the 159° figure is what d=100 converts to)
 */
export const MIN_FOV_DEG = 5;
export const MAX_FOV_DEG = 120;

export interface StageSize {
  width: number;
  height: number;
}

export interface Camera3D {
  /** Field of view (degrees), vertical */
  fovDeg: number;
  /** Camera distance to the z=0 plane, unit = stage pixels. Also the CSS perspective value */
  distance: number;
  /** Aspect ratio, for three.js's PerspectiveCamera */
  aspect: number;
  /** Camera position (world coordinates). Always on +z */
  position: [number, number, number];
  near: number;
  far: number;
}

export function clampFov(fovDeg: number | undefined): number {
  const v = Number(fovDeg);
  if (!Number.isFinite(v)) return DEFAULT_FOV_DEG;
  return Math.min(MAX_FOV_DEG, Math.max(MIN_FOV_DEG, v));
}

/**
 * Derive the camera from fov and aspect ratio.
 *
 * `distance` is also the CSS `perspective` value: CSS `perspective: N px` is mathematically
 * "the viewer is N pixels from the z=0 plane", the same quantity in the same unit as d here.
 * So layer A (DOM + CSS 3D) and layer B (three.js) are aligned by nature, with no calibration needed.
 * three.js's own CSS3DRenderer does exactly this.
 */
export function cameraFor(stage: StageSize, fovDeg?: number): Camera3D {
  const fov = clampFov(fovDeg);
  const h = Math.max(1, stage.height);
  const distance = h / (2 * Math.tan((fov * Math.PI) / 360));
  return {
    fovDeg: fov,
    distance,
    aspect: Math.max(1e-6, stage.width / h),
    position: [0, 0, distance],
    // near is 1 pixel; far is generous: a card pushed back beyond ten times the camera distance has
    // already shrunk to a dot
    near: 1,
    far: distance * 10,
  };
}

/**
 * The perspective value CSS needs (pixels). It is just the camera distance; it has its own name so that
 * the call site reads as what it means
 */
export function perspectivePx(stage: StageSize, fovDeg?: number): number {
  return cameraFor(stage, fovDeg).distance;
}

/** The reverse: the fov equivalent to a given camera distance. For debugging and docs */
export function fovForDistance(stage: StageSize, distance: number): number {
  const h = Math.max(1, stage.height);
  return (2 * Math.atan(h / (2 * Math.max(1e-6, distance))) * 180) / Math.PI;
}

export interface StagePoint {
  /** Stage pixels, origin at top left, x pointing right */
  x: number;
  /** Stage pixels, origin at top left, **y pointing down** */
  y: number;
  /** Positive toward the viewer, unit still stage pixels. Default 0 = the screen plane */
  z?: number;
}

export type WorldPoint = [number, number, number];

/**
 * Normalize `-0`.
 *
 * The y axis has to be flipped, and `-(540 - 540)` yields **`-0`** rather than `0`. Numerically the
 * two are equal, but `Object.is` and `assert.deepEqual` tell them apart, and `JSON.stringify(-0)`
 * outputs `0`, so "the object in memory" and "the object saved and read back" would be unequal even
 * though the value has not changed.
 * Adding `+ 0` smooths it out (`-0 + 0 === +0`). It looks like a pointless step, but delete it and
 * someone will spend half a day chasing a bogus inconsistency.
 */
const nz = (v: number): number => v + 0;

/**
 * Stage coordinates → world coordinates. The origin moves from the top left to the picture center, y is
 * flipped, and z is unchanged (on both sides "positive toward the viewer").
 */
export function stageToWorld(p: StagePoint, stage: StageSize): WorldPoint {
  return [
    nz(p.x - stage.width / 2),
    nz(-(p.y - stage.height / 2)),
    nz(p.z ?? 0),
  ];
}

/** World coordinates → stage coordinates. The inverse operation of stageToWorld */
export function worldToStage(w: WorldPoint, stage: StageSize): Required<StagePoint> {
  return {
    x: nz(w[0] + stage.width / 2),
    y: nz(-w[1] + stage.height / 2),
    z: nz(w[2]),
  };
}

/**
 * The position and scale at which a point lands on the screen after perspective projection.
 *
 * It serves two purposes: solid mode needs to know how large to draw the proxy plane, and the bounding
 * box needs to know how much room it takes after projection.
 * The formula is a pinhole camera: the closer to the camera (the larger z), the bigger it is drawn,
 * `scale = d / (d − z)`.
 * `z ≥ d` means the point has gone behind the camera or exactly onto it; projection is meaningless
 * then, so it returns null, and the caller decides for itself whether to hide or clamp; do not make
 * that decision for it here.
 */
export function projectStage(
  p: StagePoint,
  stage: StageSize,
  fovDeg?: number,
): { x: number; y: number; scale: number } | null {
  const { distance } = cameraFor(stage, fovDeg);
  const z = p.z ?? 0;
  const denom = distance - z;
  if (denom <= 1e-6) return null;
  const scale = distance / denom;
  const cx = stage.width / 2;
  const cy = stage.height / 2;
  return {
    x: cx + (p.x - cx) * scale,
    y: cy + (p.y - cy) * scale,
    scale,
  };
}

/**
 * Near-clip fraction of camera focal distance `d` for 2D boards placed in 3D space.
 *
 * `cameraFor().near` stays 1 stage pixel so genuine 3D geometry (`scene-3d`) can approach the lens,
 * whereas a flat DOM board at `d - z = 1 px` scales by `d / 1 ≈ 1484×` (at 1080p, 40° fov) and swells
 * across the entire frame right before crossing `z = d`. Clipping boards at `0.15 · d` caps perspective
 * magnification at `~6.7×` and culls boards cleanly before and after crossing the camera plane.
 */
export const BOARD_NEAR_RATIO = 0.15;

/** Structural frame subset accepted by 3D board helpers (kept independent of `types.ts` and `layout.ts`). */
export interface BoardFrame3D {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  anchor?: readonly [number, number];
  scale?: number;
  rotate?: number;
  rotateX?: number;
  rotateY?: number;
  translateZ?: number;
}

/** Normalized `[0..1]` content rectangle within a board (origin at top-left, matching `alphaBox`). */
export interface BoardSubBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Optional camera pose override for walk-through or orbited viewpoints; defaults to `cameraFor(stage, fovDeg)`. */
export interface CameraPose3D {
  /** Camera position in world coordinates (default: `[0, 0, distance]`) */
  position?: WorldPoint;
  /** Unit vector along the camera's line of sight (default: `[0, 0, -1]`) */
  forward?: WorldPoint;
  /** Near-clip distance along `forward` in stage pixels (default: `boardNearDistance(stage, fovDeg)`) */
  near?: number;
}

/** Near-clip distance (stage pixels) for 2D boards viewed through the stage camera. */
export function boardNearDistance(stage: StageSize, fovDeg?: number): number {
  const cam = cameraFor(stage, fovDeg);
  return Math.max(cam.near, cam.distance * BOARD_NEAR_RATIO);
}

function unitForward(fwd: WorldPoint | undefined): WorldPoint {
  if (!fwd) return [0, 0, -1];
  const len = Math.hypot(fwd[0], fwd[1], fwd[2]);
  if (!(len > 1e-9)) return [0, 0, -1];
  return [nz(fwd[0] / len), nz(fwd[1] / len), nz(fwd[2] / len)];
}

/**
 * World coordinates of the four corners of a placed board (top-left → top-right → bottom-right → bottom-left).
 *
 * Uses the exact transform chain of `frameCss` / `visualBox` (`rotate → scale → rotateY → rotateX → translateZ`
 * around the anchor, then `stageToWorld`), optionally restricted to a normalized `[0..1]` `subBox` when the
 * board geometry has been cropped to its non-transparent content box.
 */
export function boardWorldCorners(
  frame: BoardFrame3D | undefined,
  stage: StageSize,
  subBox?: BoardSubBox,
): [WorldPoint, WorldPoint, WorldPoint, WorldPoint] {
  const size = resolveFrameSize(frame as any, stage);
  const w = size.w;
  const h = size.h;
  const fx = frame?.x ?? 0;
  const fy = frame?.y ?? 0;
  const ax = frame?.anchor?.[0] ?? 0;
  const ay = frame?.anchor?.[1] ?? 0;
  const scale = frame?.scale ?? 1;
  const rotate = frame?.rotate ?? 0;
  const rotateX = frame?.rotateX ?? 0;
  const rotateY = frame?.rotateY ?? 0;
  const translateZ = frame?.translateZ ?? 0;

  const baseLeft = fx - ax * w;
  const baseTop = fy - ay * h;
  const left = subBox ? baseLeft + subBox.x * w : baseLeft;
  const top = subBox ? baseTop + subBox.y * h : baseTop;
  const bw = subBox ? subBox.w * w : w;
  const bh = subBox ? subBox.h * h : h;

  const rad = (rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = (rotateX * Math.PI) / 180;
  const ry = (rotateY * Math.PI) / 180;
  const cosX = Math.cos(rx);
  const sinX = Math.sin(rx);
  const cosY = Math.cos(ry);
  const sinY = Math.sin(ry);
  const has3d = !!(rotateX || rotateY || translateZ);

  const rawCorners: [number, number][] = [
    [left, top],
    [left + bw, top],
    [left + bw, top + bh],
    [left, top + bh],
  ];

  const out = rawCorners.map(([cxi, cyi]) => {
    const dx0 = (cxi - fx) * scale;
    const dy0 = (cyi - fy) * scale;
    let x = dx0 * cos - dy0 * sin;
    let y = dx0 * sin + dy0 * cos;
    let z = 0;
    if (has3d) {
      const nx = x * cosY + z * sinY;
      z = -x * sinY + z * cosY;
      x = nx;
      const ny = y * cosX - z * sinX;
      z = y * sinX + z * cosX;
      y = ny;
      z += translateZ;
    }
    return stageToWorld({ x: fx + x, y: fy + y, z }, stage);
  });

  return out as [WorldPoint, WorldPoint, WorldPoint, WorldPoint];
}

/**
 * Signed depth range of a placed board along the camera's forward ray (`> 0` in front of the camera,
 * `<= 0` on or behind the camera plane).
 */
export function boardCameraDepthRange(
  frame: BoardFrame3D | undefined,
  stage: StageSize,
  fovDeg?: number,
  pose?: CameraPose3D,
  subBox?: BoardSubBox,
): { minDepth: number; maxDepth: number; centerDepth: number; near: number } {
  const cam = cameraFor(stage, fovDeg);
  const pos = pose?.position ?? cam.position;
  const fwd = unitForward(pose?.forward);
  const near = pose?.near ?? Math.max(cam.near, cam.distance * BOARD_NEAR_RATIO);
  const corners = boardWorldCorners(frame, stage, subBox);
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  let sum = 0;
  for (const c of corners) {
    const d = (c[0] - pos[0]) * fwd[0] + (c[1] - pos[1]) * fwd[1] + (c[2] - pos[2]) * fwd[2];
    if (d < minDepth) minDepth = d;
    if (d > maxDepth) maxDepth = d;
    sum += d;
  }
  return {
    minDepth: nz(minDepth),
    maxDepth: nz(maxDepth),
    centerDepth: nz(sum / 4),
    near: nz(near),
  };
}

/**
 * Whether a placed 2D board has passed behind (or into the near-clip zone of) the camera and must be culled.
 *
 * Returns `true` once every corner of the board lies at or behind the near plane (`maxDepth <= near`),
 * while tilted boards that straddle `near` rely on the matching camera near plane (`boardNearDistance`)
 * to clip the near portion without exploding perspective scale.
 */
export function isBoardBehindCamera(
  frame: BoardFrame3D | undefined,
  stage: StageSize,
  fovDeg?: number,
  pose?: CameraPose3D,
  subBox?: BoardSubBox,
): boolean {
  const { maxDepth, near } = boardCameraDepthRange(frame, stage, fovDeg, pose, subBox);
  return maxDepth <= near;
}
