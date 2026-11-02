import { frameBox, resolveFrame, type Size } from "../../kernel/layout.ts";
import { stageToWorld } from "../../kernel/space3d.ts";
import type { ClipFrame } from "../../kernel/types";

/**
 * How a card should be laid out in the 3D view.
 *
 * It is split out because **the signs here are the easiest place in the whole project to get
 * backwards, and the hardest to notice**:
 * the CSS y axis points down while three's points up, so
 *   - for rotation about y the two matrices are identical (x' = x·cosθ + z·sinθ): **use as is**;
 *   - for rotation about x and about z, **negate**;
 *   - for translateZ both sides use "positive = toward the viewer": use as is.
 * Getting it backwards raises no error; the picture just "looks off". So it is a pure function plus
 * unit tests: using visualBox from the kernel side, which has already been checked bit by bit
 * against a real browser, as the baseline, the projected boxes computed on both sides must agree.
 *
 * The transform order copies frameCss: `translateZ · rotateX · rotateY · scale · rotate` (the
 * rightmost applies first), so from the inside out it is roll → scale → spin → tilt → translation.
 */
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
