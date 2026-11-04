// With a .ts suffix: this file must be runnable directly by node --test, and node cannot resolve relative imports without the suffix (same for place3d.ts)
import { cameraFor, DEFAULT_FOV_DEG, stageToWorld, type StageSize, type WorldPoint } from "../../kernel/space3d.ts";

/**
 * "2D view frustum": a **four-sided pyramid that opens from the camera out to the aspect ratio**,
 * drawing the space seen by the 2D page into 3D.
 *
 * # The question it answers
 *
 * The 3D page is for orbiting around to see how cards are placed in space, but after a couple of
 * orbits it is easy to get lost: which direction is the "front"? What part is actually visible in
 * the final video? An aspect-ratio rectangle alone is not enough: a rectangle only says "the
 * aspect ratio is on this plane", not **where it is viewed from**. And "is this card actually
 * in the picture" can only be judged from the line-of-sight direction.
 *
 * So what is drawn is a pyramid: **the apex at the camera, the base at the aspect ratio**.
 * Eight lines: four base edges + four ridges.
 *
 * # The camera position can always be computed; there is no "no camera" case
 *
 * There used to be two cases here: if the project did not set `camera3dFov` it was treated as
 * orthographic, no pyramid was drawn, and four parallel lines were pulled from the four corners
 * toward the viewer instead. That was wrong, and it contradicted the code right next to this
 * file: the initial camera position of `Scene3DView` itself uses
 * `cameraFor(stage, project.camera3dFov ?? DEFAULT_FOV_DEG)`, which means **when fov is not set
 * the whole project is already viewed through that 40° camera**. Since that camera is always
 * there, the pyramid should be drawn from it here, rather than setting up a separate rule to
 * draw four parallel lines poking out.
 *
 * # Scale and signs are copied from space3d
 *
 * 1 world unit = 1 stage pixel, the screen plane is z=0, the camera is at +z, and y is flipped.
 * **Not one of these may be re-derived here**: `stageToWorld` and `cameraFor` have already been
 * reconciled value by value with the CSS side (see the notes in space3d.ts), and here we only
 * call them. Computing them again would open a door for "the two sides quietly drifting apart".
 */

export interface Frustum2D {
  /** World coordinates of the four corners of the aspect ratio. Order follows stage coordinates: top-left → top-right → bottom-right → bottom-left */
  corners: WorldPoint[];
  /** Pyramid apex: the position of the 2D camera. Always has a value */
  apex: WorldPoint;
  /**
   * Line segment endpoints, **6 numbers per line** (x1,y1,z1, x2,y2,z2).
   * This layout is meant to be fed directly into the BufferAttribute of THREE.LineSegments, with
   * no further conversion.
   * Eight lines in total: four base edges + four ridges.
   */
  positions: number[];
}

/**
 * @param stage   aspect ratio
 * @param fovDeg  field of view of the perspective camera. When not set (undefined / null /
 *                not a number), use DEFAULT_FOV_DEG, exactly the same as how Scene3DView
 *                picks its initial camera position
 */
export function frustum2d(stage: StageSize, fovDeg?: number | null): Frustum2D {
  const w = Math.max(1, stage.width);
  const h = Math.max(1, stage.height);
  const size = { width: w, height: h };

  // Stage corners (origin top-left, y down); converting to world coordinates is stageToWorld's job
  const corners: WorldPoint[] = [
    stageToWorld({ x: 0, y: 0 }, size),
    stageToWorld({ x: w, y: 0 }, size),
    stageToWorld({ x: w, y: h }, size),
    stageToWorld({ x: 0, y: h }, size),
  ];

  /*
   * Pick the fov explicitly instead of passing fovDeg straight to cameraFor: `clampFov(null)`
   * treats null as 0, then clamps to the lower limit of 5°. That is an extremely narrow
   * telephoto, and the camera would be pushed to a place a dozen times the aspect ratio away, with
   * the pyramid as thin as a needle. But null means "not set" and should take the default 40°.
   */
  const fov = typeof fovDeg === "number" && Number.isFinite(fovDeg) && fovDeg > 0 ? fovDeg : DEFAULT_FOV_DEG;
  const apex = cameraFor(size, fov).position;

  const positions: number[] = [];
  const seg = (a: WorldPoint, b: WorldPoint) => { positions.push(a[0], a[1], a[2], b[0], b[1], b[2]); };

  // Base: the ring of the aspect ratio, four edges joined end to end
  for (let i = 0; i < 4; i++) seg(corners[i], corners[(i + 1) % 4]);
  // Four ridges: camera → the four corners of the aspect ratio
  for (const c of corners) seg(apex, c);

  return { corners, apex, positions };
}
