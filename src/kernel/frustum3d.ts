import { cameraFor, DEFAULT_FOV_DEG, stageToWorld, type StageSize, type WorldPoint } from "./space3d.ts";
import type { ResolvedCamera3D } from "./camera.d.mts";

/**
 * Four-sided camera frustum pyramid in 3D world space:
 * 8 line segments (4 image-plane base edges + 4 ridges from `apex` to `corners`).
 */
export interface Frustum2D {
  /** World coordinates of the four image-plane corners: top-left -> top-right -> bottom-right -> bottom-left */
  corners: WorldPoint[];
  /** Pyramid apex: the world position of the camera */
  apex: WorldPoint;
  /** Line segment endpoints, 6 numbers per segment (`x1,y1,z1, x2,y2,z2`), ready for `THREE.LineSegments` */
  positions: number[];
}

const nz = (n: number) => (Object.is(n, -0) ? 0 : n + 0);

/**
 * Frustum pyramid for the static 2D stage camera at `(0, 0, cameraDistance(stage.height, fovDeg))`
 * looking straight at `z = 0`.
 */
export function frustum2d(stage: StageSize, fovDeg?: number | null): Frustum2D {
  const w = Math.max(1, stage.width);
  const h = Math.max(1, stage.height);
  const size = { width: w, height: h };

  const corners: WorldPoint[] = [
    stageToWorld({ x: 0, y: 0 }, size),
    stageToWorld({ x: w, y: 0 }, size),
    stageToWorld({ x: w, y: h }, size),
    stageToWorld({ x: 0, y: h }, size),
  ];

  const fov = typeof fovDeg === "number" && Number.isFinite(fovDeg) && fovDeg > 0 ? fovDeg : DEFAULT_FOV_DEG;
  const apex = cameraFor(size, fov).position;

  const positions: number[] = [];
  const seg = (a: WorldPoint, b: WorldPoint) => {
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  };

  for (let i = 0; i < 4; i++) seg(corners[i], corners[(i + 1) % 4]);
  for (const c of corners) seg(apex, c);

  return { corners, apex, positions };
}

/**
 * Frustum pyramid for an arbitrary resolved 3D camera (`resolveCamera3DAt`), drawn from `cam.position`
 * out along `cam.forward` to focal distance `cam.distance` (`H / (2 * tan(fov / 2))`).
 */
export function cameraFrustum3D(stage: StageSize, cam: ResolvedCamera3D): Frustum2D {
  const w = Math.max(1, stage.width);
  const h = Math.max(1, stage.height);
  const hw = w / 2;
  const hh = h / 2;
  const apex: WorldPoint = [nz(cam.position[0]), nz(cam.position[1]), nz(cam.position[2])];
  const dist = cam.distance;
  const cx = apex[0] + cam.forward[0] * dist;
  const cy = apex[1] + cam.forward[1] * dist;
  const cz = apex[2] + cam.forward[2] * dist;
  const [rx, ry, rz] = cam.right;
  const [ux, uy, uz] = cam.up;

  const corner = (sx: number, sy: number): WorldPoint => [
    nz(cx + rx * sx + ux * sy),
    nz(cy + ry * sx + uy * sy),
    nz(cz + rz * sx + uz * sy),
  ];

  const corners: WorldPoint[] = [
    corner(-hw, +hh),
    corner(+hw, +hh),
    corner(+hw, -hh),
    corner(-hw, -hh),
  ];

  const positions: number[] = [];
  const seg = (a: WorldPoint, b: WorldPoint) => {
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  };
  for (let i = 0; i < 4; i++) seg(corners[i], corners[(i + 1) % 4]);
  for (const c of corners) seg(apex, c);

  return { corners, apex, positions };
}
