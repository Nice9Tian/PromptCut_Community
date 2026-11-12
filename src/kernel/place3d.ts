import { frameBox, resolveFrame, type Size } from "./layout.ts";
import {
  boardCameraDepthRange,
  boardWorldCorners,
  cameraFor,
  stageToWorld,
  type BoardSubBox,
  type CameraPose3D,
  type WorldPoint,
} from "./space3d.ts";
import type { ClipFrame } from "./types.ts";

/**
 * How a card or media board is laid out in 3D world space.
 *
 * The CSS y axis points down while Three.js y points up, so:
 *   - rotation about y uses the same sign (`x' = x*cos(theta) + z*sin(theta)`);
 *   - rotation about x and about z are negated;
 *   - `translateZ` uses positive = toward the viewer on both sides.
 *
 * Transform order matches `frameCss`: `translateZ * rotateX * rotateY * scale * rotate`
 * (rightmost applies first: roll -> scale -> spin -> tilt -> translation).
 */
export type { BoardSubBox };

export interface Placement3D {
  /** World coordinates of the anchor (transform origin) */
  pivot: [number, number, number];
  /** Offset of the board center relative to the anchor (world coordinates) */
  meshOffset: [number, number, number];
  /** Board size (the frame's box) */
  size: { width: number; height: number };
  /** Rotation about x, in radians. Already negated */
  tiltX: number;
  /** Rotation about y, in radians. Same sign as CSS */
  spinY: number;
  /** Rotation about z, in radians. Already negated */
  rollZ: number;
  scale: number;
  /** Translation along depth, world unit = stage pixel, positive = toward the viewer */
  translateZ: number;
}

const RAD = Math.PI / 180;

export function placeClip3D(frame: ClipFrame | undefined, stage: Size): Placement3D {
  const f = resolveFrame(frame, stage);
  const box = frameBox(frame, stage);
  const [ax, ay] = stageToWorld({ x: f.x, y: f.y, z: 0 }, stage);
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  return {
    pivot: [ax, ay, 0],
    // Negate y: stage coordinates grow downward, world coordinates upward
    meshOffset: [cx - f.x, -(cy - f.y), 0],
    size: { width: box.width, height: box.height },
    tiltX: -f.rotateX * RAD,
    spinY: f.rotateY * RAD,
    rollZ: -f.rotate * RAD,
    scale: f.scale,
    translateZ: f.translateZ,
  };
}

export interface SortableBoard3D {
  id: string;
  frame?: ClipFrame;
  /** Normalized `[0..1]` cropped content box within the board, if cropped */
  subBox?: BoardSubBox;
  /** Painter/track index (`0` = bottom track, larger = higher track); breaks ties at equal depth */
  trackOrder: number;
}

export interface SortedBoard3D {
  id: string;
  /** Back-to-front draw order (`1` = farthest / drawn first, `N` = closest / drawn last) */
  renderOrder: number;
  /** Signed camera-space depth of the board center along the camera forward ray */
  centerDepth: number;
}

const DEPTH_TIE_EPS = 1e-4;
const PLANE_EPS = 1e-3;

interface PreparedBoard {
  id: string;
  trackOrder: number;
  centerDepth: number;
  corners: [WorldPoint, WorldPoint, WorldPoint, WorldPoint];
  normal: WorldPoint | null;
  projBox: { u0: number; u1: number; v0: number; v1: number };
}

function cross(a: WorldPoint, b: WorldPoint): WorldPoint {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: WorldPoint, b: WorldPoint): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub(a: WorldPoint, b: WorldPoint): WorldPoint {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function norm(v: WorldPoint): WorldPoint | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-8)) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cameraBasis(fwdRaw: WorldPoint | undefined): { right: WorldPoint; up: WorldPoint; fwd: WorldPoint } {
  const fwd = norm(fwdRaw ?? [0, 0, -1]) ?? [0, 0, -1];
  const refUp: WorldPoint = Math.abs(fwd[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const right = norm(cross(fwd, refUp)) ?? [1, 0, 0];
  const up = norm(cross(right, fwd)) ?? [0, 1, 0];
  return { right, up, fwd };
}

function boxesOverlap(
  a: { u0: number; u1: number; v0: number; v1: number },
  b: { u0: number; u1: number; v0: number; v1: number },
): boolean {
  return a.u0 <= b.u1 + 1e-6 && a.u1 >= b.u0 - 1e-6 && a.v0 <= b.v1 + 1e-6 && a.v1 >= b.v0 - 1e-6;
}

function planeOrder(behind: PreparedBoard, front: PreparedBoard, camPos: WorldPoint): -1 | 0 | 1 {
  if (front.normal) {
    const p0 = front.corners[0];
    const camSide = dot(front.normal, sub(camPos, p0));
    if (Math.abs(camSide) > PLANE_EPS) {
      let minS = Infinity;
      let maxS = -Infinity;
      for (const c of behind.corners) {
        const s = dot(front.normal, sub(c, p0));
        if (s < minS) minS = s;
        if (s > maxS) maxS = s;
      }
      const coplanar = Math.max(Math.abs(minS), Math.abs(maxS)) <= PLANE_EPS;
      if (!coplanar) {
        if (camSide > 0) {
          if (maxS <= PLANE_EPS) return 1;
          if (minS >= -PLANE_EPS) return -1;
        } else {
          if (minS >= -PLANE_EPS) return 1;
          if (maxS <= PLANE_EPS) return -1;
        }
      } else {
        return 0;
      }
    }
  }
  if (behind.normal) {
    const p0 = behind.corners[0];
    const camSide = dot(behind.normal, sub(camPos, p0));
    if (Math.abs(camSide) > PLANE_EPS) {
      let minS = Infinity;
      let maxS = -Infinity;
      for (const c of front.corners) {
        const s = dot(behind.normal, sub(c, p0));
        if (s < minS) minS = s;
        if (s > maxS) maxS = s;
      }
      const coplanar = Math.max(Math.abs(minS), Math.abs(maxS)) <= PLANE_EPS;
      if (!coplanar) {
        if (camSide > 0) {
          if (minS >= -PLANE_EPS) return 1;
          if (maxS <= PLANE_EPS) return -1;
        } else {
          if (maxS <= PLANE_EPS) return 1;
          if (minS >= -PLANE_EPS) return -1;
        }
      }
    }
  }
  return 0;
}

/**
 * Sort 3D boards back-to-front (painter's algorithm) relative to the active camera.
 */
export function sortBoardsByDepth(
  items: readonly SortableBoard3D[],
  stage: Size,
  fovDeg?: number,
  pose?: CameraPose3D,
): SortedBoard3D[] {
  if (!items.length) return [];
  const cam = cameraFor(stage, fovDeg);
  const camPos = pose?.position ?? cam.position;
  const { right, up, fwd } = cameraBasis(pose?.forward);

  const prepared: PreparedBoard[] = items.map((item) => {
    const corners = boardWorldCorners(item.frame, stage, item.subBox);
    const { centerDepth } = boardCameraDepthRange(item.frame, stage, fovDeg, pose, item.subBox);
    const normal = norm(cross(sub(corners[1], corners[0]), sub(corners[3], corners[0])));
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const c of corners) {
      const rel = sub(c, camPos);
      const d = Math.max(1, dot(rel, fwd));
      const u = dot(rel, right) / d;
      const v = dot(rel, up) / d;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    return {
      id: item.id,
      trackOrder: item.trackOrder,
      centerDepth,
      corners,
      normal,
      projBox: { u0, u1, v0, v1 },
    };
  });

  prepared.sort((a, b) => {
    const diff = b.centerDepth - a.centerDepth;
    if (Math.abs(diff) > DEPTH_TIE_EPS) return diff;
    return a.trackOrder - b.trackOrder;
  });

  const n = prepared.length;
  for (let i = 0; i < n; i++) {
    const moved = new Set<string>();
    let j = i + 1;
    while (j < n) {
      const cur = prepared[i];
      const cand = prepared[j];
      if (boxesOverlap(cur.projBox, cand.projBox) && planeOrder(cand, cur, camPos) === 1 && !moved.has(cand.id)) {
        moved.add(cur.id);
        prepared.splice(j, 1);
        prepared.splice(i, 0, cand);
        j = i + 1;
        continue;
      }
      j++;
    }
  }

  return prepared.map((b, idx) => ({
    id: b.id,
    renderOrder: idx + 1,
    centerDepth: b.centerDepth,
  }));
}
