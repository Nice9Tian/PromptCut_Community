/**
 * Scene graph coordinate conversion: local box ⇄ screen absolute position, and CSS needed by Stage.
 *
 * There is only one principle: **only store local coordinates (ClipFrame); world coordinates are
 * always derived here and never persisted to disk.**
 * When the Agent sets world coordinates, they are inverse-solved into local coordinates here and
 * stored; when setting local coordinates, world coordinates update automatically. If both were
 * stored, they would eventually drift, and no one could tell which is real.
 *
 * The card-level parent coordinate system is the stage (origin at top-left), so currently
 * world == local, and inverse-solving is an identity; function signatures are all written as
 * "parent box → child box", so when part-level elements (title / rows inside cards…) are integrated
 * in the future, it is just one more level of recursion without changing the interface.
 *
 * ⚠ A pitfall that must be documented in tool descriptions: setting world coordinates ≠ pinning to
 * the screen. The inverse-solved result is stored locally, so when the parent node moves later, child
 * nodes follow (titles naturally should follow the card). Wanting to "pin here on screen regardless
 * of how the parent node moves" is a different intent (pin / extract from group), not this approach.
 */
import type { CSSProperties } from "react";
import type { ClipFrame } from "./types";
import { cameraFor, projectStage } from "./space3d.ts";
import { resolveFrameSize } from "./frameSize.mjs";

export interface Size {
  width: number;
  height: number;
}

/** Rectangle in parent coordinate system (before scaling and rotation) */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Shape of ClipFrame after filling in default values */
export interface FrameResolved {
  x: number;
  y: number;
  w: number;
  h: number;
  anchor: [number, number];
  scale: number;
  rotate: number;
  /** Rotation around horizontal axis (degrees). 0 = no flip */
  rotateX: number;
  /** Rotation around vertical axis (degrees). 0 = no flip */
  rotateY: number;
  /** Depth translation (stage pixels), positive toward viewer. 0 = on the screen plane */
  translateZ: number;
}

/** Fill in default values: no frame = fills parent coordinate system */
export function resolveFrame(frame: ClipFrame | undefined, parent: Size): FrameResolved {
  // w/h uses src/kernel/frameSize.mjs: the server's shared snapshot key must calculate the exact
  // same frame width and height.
  const size = resolveFrameSize(frame, parent);
  return {
    x: frame?.x ?? 0,
    y: frame?.y ?? 0,
    w: size.w,
    h: size.h,
    anchor: frame?.anchor ?? [0, 0],
    scale: frame?.scale ?? 1,
    rotate: frame?.rotate ?? 0,
    rotateX: frame?.rotateX ?? 0,
    rotateY: frame?.rotateY ?? 0,
    translateZ: frame?.translateZ ?? 0,
  };
}

/**
 * Whether this frame uses 3D.
 *
 * Both `frameCss` (whether to write preserve-3d) and `visualBox` (whether to apply projection) query
 * this: writing `rotateX || rotateY || translateZ` in both places would definitely lead to missing
 * one place when adding a fourth 3D field in the future; missing it produces no error, but one
 * side would silently compute in 2D.
 */
export function frameIs3D(frame: ClipFrame | undefined | FrameResolved): boolean {
  return !!(frame?.rotateX || frame?.rotateY || frame?.translateZ);
}

/** Rectangle of the frame in parent coordinates: anchor at (x,y), top-left = (x,y) minus anchor offset in frame */
export function frameBox(frame: ClipFrame | undefined, parent: Size): Box {
  const f = resolveFrame(frame, parent);
  return { left: f.x - f.anchor[0] * f.w, top: f.y - f.anchor[1] * f.h, width: f.w, height: f.h };
}

/** Description of a node in world coordinates (the world portion returned by get_layout) */
export interface WorldPlacement {
  /** World coordinates of the anchor point */
  x: number;
  y: number;
  anchor: [number, number];
  w: number;
  h: number;
  scale: number;
  rotate: number;
  /** Rectangle in world coordinates (before scaling and rotation, i.e. the canvas) */
  box: Box;
  /** Bounding rectangle **after** scaling and rotation. Use this, not box, to check occlusion, edge alignment, or going off-screen */
  visualBox: Box;
}

/**
 * Axis-aligned bounding box (AABB) occupied on screen after transformation.
 *
 * The four corners undergo **the exact same sequence of transformations as frameCss**, finally
 * landing on screen via perspective projection. In CSS, transform lists apply right-to-left;
 * `frameCss` specifies `translateZ rotateX rotateY scale rotate`, so the order is:
 * 2D rotation first → scale → rotate around y → rotate around x → translate along z → projection.
 *
 * `fovDeg` is the project's `camera3dFov`:
 *   - Omitted (project has not enabled 3D) = no perspective; the 3D properties only cause affine
 *     compression (rotateY compresses width to cos θ times), which is exactly what really happens
 *     on screen: so they still must be calculated and cannot be treated as nonexistent;
 *   - Passed = pinhole camera projection, using the same formula as CSS perspective (see space3d.ts).
 *
 * **Downgrade when crossing the camera plane**: when a card is pushed onto or behind the camera
 * (translateZ ≥ camera distance), projection is meaningless. Here, corner z coordinates are clamped
 * just in front of the camera, yielding a **huge but finite** box: `clampToStage` already skips
 * clamping boxes larger than the stage (see comments there), and `get_layout` makes it obvious at a
 * glance that "this card flew off". Infinity is not returned because it propagates into NaN, and
 * NaN silently ruins every subsequent check.
 */
export function visualBox(frame: ClipFrame | undefined, parent: Size, fovDeg?: number): Box {
  const f = resolveFrame(frame, parent);
  const b = frameBox(frame, parent);
  const rad = (f.rotate * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rx = (f.rotateX * Math.PI) / 180;
  const ry = (f.rotateY * Math.PI) / 180;
  const cosX = Math.cos(rx), sinX = Math.sin(rx);
  const cosY = Math.cos(ry), sinY = Math.sin(ry);
  const is3D = frameIs3D(f);
  // The camera exists only when the project has 3D enabled; without it, it is parallel projection.
  const distance = fovDeg ? cameraFor(parent, fovDeg).distance : Infinity;
  const zCap = Number.isFinite(distance) ? distance * 0.98 : Infinity;

  const corners: [number, number][] = [
    [b.left, b.top], [b.left + b.width, b.top], [b.left, b.top + b.height], [b.left + b.width, b.top + b.height],
  ];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [cxi, cyi] of corners) {
    // Around anchor point: 2D rotation first, then scale (uniform scale and rotation commute, order does
    // not matter)
    const dx0 = (cxi - f.x) * f.scale;
    const dy0 = (cyi - f.y) * f.scale;
    let x = dx0 * cos - dy0 * sin;
    let y = dx0 * sin + dy0 * cos;
    let z = 0;
    if (is3D) {
      // rotateY:x' = x·cosθ + z·sinθ,z' = −x·sinθ + z·cosθ
      const nx = x * cosY + z * sinY;
      z = -x * sinY + z * cosY;
      x = nx;
      // rotateX:y' = y·cosθ − z·sinθ,z' = y·sinθ + z·cosθ
      const ny = y * cosX - z * sinX;
      z = y * sinX + z * cosX;
      y = ny;
      z += f.translateZ;
    }
    const sx = f.x + x;
    const sy = f.y + y;
    let px = sx, py = sy;
    if (fovDeg && is3D) {
      const p = projectStage({ x: sx, y: sy, z: Math.min(z, zCap) }, parent, fovDeg);
      // zCap guarantees that p will not be null; if truly null, fall back to the unprojected point,
      // which is better than NaN
      if (p) { px = p.x; py = p.y; }
    }
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
  }
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Local box → world description. Card-level: parent = stage, origins coincide, so this simply
 * completes the frame and computes two rectangles. When part-level is integrated, change this to:
 * `box.left`/`top` of `parentWorld` plus local `x`, `y`, multiplied by `scale`.
 *
 * Fields are **listed individually** rather than `...f`: `resolveFrame` still carries `rotateX` /
 * `rotateY` / `translateZ`; spreading them would add three zeros to `world` for every clip (including
 * legacy projects that never touched 3D), whereas the semantics of `world` is "appearance on screen
 * after projection", and those three are local quantities **before** projection: Agents seeing them
 * might assume 3D can also be written to `world`. They are in `frame.local` and should be viewed there.
 */
export function worldOf(frame: ClipFrame | undefined, parent: Size, fovDeg?: number): WorldPlacement {
  const f = resolveFrame(frame, parent);
  return {
    x: f.x, y: f.y, anchor: f.anchor, w: f.w, h: f.h, scale: f.scale, rotate: f.rotate,
    box: frameBox(frame, parent),
    visualBox: visualBox(frame, parent, fovDeg),
  };
}

/**
 * World coordinates → local coordinates (converts provided fields only). Card-level is identity;
 * signature is kept for part-level. The incoming x, y are "anchor world coordinates", matching the
 * stored semantics, so dimensions do not need to be known.
 */
export function localFromWorld(world: Partial<ClipFrame>, _parent: Size): Partial<ClipFrame> {
  return { ...world };
}

/** Input parameters for set_position */
export interface PositionArgs {
  space?: "world" | "local";
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  anchor?: [number, number];
  scale?: number;
  rotate?: number;
  /** Tilt around horizontal axis (degrees), positive = top edge tilts inward. Requires camera3dFov enabled for perspective */
  rotateX?: number;
  /** Rotation around vertical axis (degrees), positive = right edge rotates inward. Same as above */
  rotateY?: number;
  /** Depth translation (stage pixels), positive toward viewer */
  translateZ?: number;
}

/**
 * Converts `set_position` arguments into a patch to merge into frame: validates numeric values and
 * converts according to space.
 * Only returns provided fields: caller merges `{ ...prev, ...patch }`, keeping unpassed fields.
 * Throws if validation fails; error messages are presented to the Agent, so use clear plain language.
 */
export function framePatchFromArgs(args: PositionArgs, parent: Size): Partial<ClipFrame> {
  const out: Partial<ClipFrame> = {};
  const num = (k: keyof PositionArgs, v: unknown, check?: (n: number) => string | null) => {
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} must be a finite number, got ${JSON.stringify(v)}`);
    const bad = check?.(v);
    if (bad) throw new Error(bad);
    (out as Record<string, unknown>)[k] = v;
  };
  num("x", args.x);
  num("y", args.y);
  num("w", args.w, (n) => (n > 0 ? null : `w must be greater than 0, got ${n}`));
  num("h", args.h, (n) => (n > 0 ? null : `h must be greater than 0, got ${n}`));
  num("scale", args.scale, (n) => (n > 0 ? null : `scale must be greater than 0, got ${n}; to hide a card use remove_clip or opacity, do not shrink it to 0`));
  num("rotate", args.rotate);
  // 3D. Angles have no bounds (rotating 720° is a valid animation intent), and translateZ is also
  // unbounded: being pushed behind the camera will be classified as invisible by projectStage, which
  // is the rendering layer's responsibility and should not be decided during argument validation.
  num("rotateX", args.rotateX);
  num("rotateY", args.rotateY);
  num("translateZ", args.translateZ);
  if (args.anchor !== undefined) {
    const a = args.anchor;
    if (!Array.isArray(a) || a.length !== 2 || !a.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new Error(`anchor must be two numbers [ax, ay], e.g. [0.5, 0.5] for the center, got ${JSON.stringify(a)}`);
    }
    out.anchor = [a[0], a[1]];
  }
  if (Object.keys(out).length === 0) {
    throw new Error("set_position needs at least one of x / y / w / h / anchor / scale / rotate / rotateX / rotateY / translateZ, or clear:true");
  }
  return args.space === "world" ? localFromWorld(out, parent) : out;
}

/**
 * Styles required by Stage.
 *
 * When there is no frame, output the legacy setup **as is** (inset:0 + optional trajectory translation)
 * without changing a single byte: legacy project export results have pixel-by-pixel baselines, so take
 * no risks here. Only when frame is present do we take the left/top/width/height path, composing
 * transform in the order of "trajectory translation → scale → rotation" around the anchor point.
 * Identity scale / rotate are omitted from transform: even for scale(1), the mere presence of the
 * transform property may cause the compositor to switch rasterization paths.
 */
export function frameCss(frame: ClipFrame | undefined, parent: Size, translate?: { dx: number; dy: number }): CSSProperties {
  const parts: string[] = [];
  if (translate) parts.push(`translate(${translate.dx}px, ${translate.dy}px)`);
  if (!frame) {
    return {
      position: "absolute",
      inset: 0,
      ...(parts.length ? { transform: parts.join(" "), willChange: "transform" } : null),
    };
  }
  const f = resolveFrame(frame, parent);
  const box = frameBox(frame, parent);
  /*
   * The 3D items are placed **before** scale / rotate (leftmost in CSS = applied later = outer layer),
   * corresponding to the mental model of "lay out in the 2D plane first, then place the entire card
   * into 3D space": if reversed, tilting would be stretched by subsequent scaling, and users
   * adjusting scale would see perspective distorting.
   *
   * When all three items are 0, not a single character is added to transform: legacy project exports
   * have pixel-by-pixel baselines, and even an extra identity transform could cause the compositor to
   * switch rasterization paths.
   */
  if (f.translateZ !== 0) parts.push(`translateZ(${f.translateZ}px)`);
  if (f.rotateX !== 0) parts.push(`rotateX(${f.rotateX}deg)`);
  if (f.rotateY !== 0) parts.push(`rotateY(${f.rotateY}deg)`);
  if (f.scale !== 1) parts.push(`scale(${f.scale})`);
  if (f.rotate !== 0) parts.push(`rotate(${f.rotate}deg)`);
  return {
    position: "absolute",
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    transformOrigin: `${f.anchor[0] * 100}% ${f.anchor[1] * 100}%`,
    ...(parts.length ? { transform: parts.join(" ") } : null),
    ...(translate ? { willChange: "transform" } : null),
    /*
     * Only write preserve-3d when 3D is actually used; cards without 3D still follow the exact same path
     * as before.
     *
     * It controls whether **child elements inside this card** can have their own spatial relationships,
     * not how this card itself is projected: the card's own perspective is determined by perspective on
     * the parent layer (see render/Stage.tsx).
     *
     * Also note an empirical observation because it is counterintuitive: `opacity` / `filter` /
     * `overflow:hidden` do indeed **force this element's transform-style back to flat**, but that only
     * affects its subtree; **the card's own projection does not change at all**. For the same
     * rotateY(40°) card, adding each of the three properties:
     *   baseline / +opacity:0.5 / +filter:drop-shadow / +overflow:hidden
     *   bounding box is always 154.88×133.93, left and right heights are always 133.93 / 108.69: all four
     *   groups bit-for-bit identical.
     * Stage writes opacity (fade in/out) and filter (emphasis) outside the card, so this must be pinned
     * down: those two properties will **not** cause cards positioned in space to suddenly flatten.
     */
    ...(frameIs3D(f) ? { transformStyle: "preserve-3d" as const } : null),
  };
}

/* ------------------------------------------------------------------------------------------
 * Below are several other expressions for the Agent: rectangle, align, nudge. They all merely
 * convert the wording into the same ClipFrame; there is no second format for stored data.
 * ---------------------------------------------------------------------------------------- */

/** Two diagonal points, in any order */
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function normRect(r: Rect): Box {
  for (const k of ["x1", "y1", "x2", "y2"] as const) {
    if (typeof r[k] !== "number" || !Number.isFinite(r[k])) throw new Error(`${k} must be a finite number, got ${JSON.stringify(r[k])}`);
  }
  const box = { left: Math.min(r.x1, r.x2), top: Math.min(r.y1, r.y2), width: Math.abs(r.x2 - r.x1), height: Math.abs(r.y2 - r.y1) };
  if (!(box.width > 0 && box.height > 0)) throw new Error(`Rectangle must have a positive width and height, got x1=${r.x1} y1=${r.y1} x2=${r.x2} y2=${r.y2}`);
  return box;
}

function checkAlign(a: unknown, name: string): [number, number] {
  if (!Array.isArray(a) || a.length !== 2 || !a.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error(`${name} must be two numbers [ax, ay], e.g. [0.5, 0.5] for the center, got ${JSON.stringify(a)}`);
  }
  return [a[0], a[1]];
}

/**
 * Place the card into a rectangle.
 *   fit (default): canvas dimensions remain unchanged, scaled as a whole to just fit inside the
 *     rectangle (preserving aspect ratio), aligned in the rectangle per align. Most cards are
 *     designed for 1920×1080, which is what "place in left half of screen" should do: content is
 *     guaranteed to stay inside the rectangle after scaling.
 *   canvas: canvas is this rectangle (w/h = rectangle dimensions, scale resets to 1). Content lays
 *     out in the new canvas per the card's own rules and may overflow (rank-bars has a built-in min-w
 *     1000px, which spills out if placed into a 960-wide canvas).
 * Neither mode touches rotate; "fitting inside" in fit does not consider the bounding box after rotation.
 */
export function rectToFrame(
  rect: Rect,
  opts: { mode?: "fit" | "canvas"; align?: [number, number] },
  prev: ClipFrame | undefined,
  parent: Size,
): ClipFrame {
  const r = normRect(rect);
  const align = opts.align === undefined ? ([0.5, 0.5] as [number, number]) : checkAlign(opts.align, "align");
  const mode = opts.mode ?? "fit";
  if (mode !== "fit" && mode !== "canvas") throw new Error(`mode must be fit or canvas, got ${JSON.stringify(mode)}`);
  const x = r.left + align[0] * r.width;
  const y = r.top + align[1] * r.height;
  if (mode === "canvas") {
    return { ...prev, x, y, w: r.width, h: r.height, anchor: align, scale: 1 };
  }
  const p = resolveFrame(prev, parent);
  const scale = Math.min(r.width / p.w, r.height / p.h);
  return { ...prev, x, y, w: p.w, h: p.h, anchor: align, scale };
}

export type AlignH = "left" | "center" | "right";
export type AlignV = "top" | "center" | "bottom";

/**
 * Align to edges or center of the parent coordinate system, with margins. The anchor point follows
 * alignment (aligning right places the anchor on the right); scaling is around the anchor, so the
 * visible box after scaling also clings to the same edge. Rotation causes corners to protrude, which
 * is ignored. Passing only h or only v keeps the other direction unchanged.
 */
export function alignToFrame(
  h: AlignH | undefined,
  v: AlignV | undefined,
  margin: number,
  prev: ClipFrame | undefined,
  parent: Size,
): ClipFrame {
  if (h === undefined && v === undefined) throw new Error("align needs at least one of h (left/center/right) or v (top/center/bottom)");
  if (h !== undefined && !["left", "center", "right"].includes(h)) throw new Error(`h must be left / center / right, got ${JSON.stringify(h)}`);
  if (v !== undefined && !["top", "center", "bottom"].includes(v)) throw new Error(`v must be top / center / bottom, got ${JSON.stringify(v)}`);
  if (typeof margin !== "number" || !Number.isFinite(margin)) throw new Error(`margin must be a finite number, got ${JSON.stringify(margin)}`);
  const p = resolveFrame(prev, parent);
  const ax = h === "left" ? 0 : h === "right" ? 1 : h === "center" ? 0.5 : p.anchor[0];
  const ay = v === "top" ? 0 : v === "bottom" ? 1 : v === "center" ? 0.5 : p.anchor[1];
  const x = h === "left" ? margin : h === "right" ? parent.width - margin : h === "center" ? parent.width / 2 : p.x;
  const y = v === "top" ? margin : v === "bottom" ? parent.height - margin : v === "center" ? parent.height / 2 : p.y;
  return { ...prev, x, y, anchor: [ax, ay] };
}

/**
 * For a card filling the stage and not scaled down, alignment shows no visible effect: the canvas is
 * already the same size as the stage, so snapping to any edge is identical. Used to add a notice to
 * the align return value.
 */
export function alignIsInvisible(frame: ClipFrame | undefined, parent: Size): boolean {
  const f = resolveFrame(frame, parent);
  return f.w >= parent.width && f.h >= parent.height && f.scale >= 1;
}

/**
 * Clamps the box back into the parent coordinate system: shifts back by however much the visible box
 * (after scaling and rotation) exceeds any edge. Boxes larger than the parent coordinate system
 * cannot be clamped back and are returned as is: that is a matter of scale, not position.
 * Used for clamp in nudge / set_position: "300 more to the right" should not push cards off-screen.
 *
 * # Conversion and iteration required in 3D
 *
 * The out-of-bounds delta is measured on screen **after projection**, while `x/y` stores local
 * coordinates **before projection**, differing by a factor of `d/(d−z)`. Directly adding the on-screen
 * overflow to x results in:
 *   - negative z (pushed inward, ratio < 1): not moved enough, still off-screen after clamping. In
 *     testing, clamping a card with translateZ:-800 three consecutive times left the right edge at
 *     2002.5 → 1948.9 → 1930.1, never reaching 1920;
 *   - positive z (toward viewer, ratio > 1): over-moved. In testing, clamping a card with
 *     translateZ:700 ended with the right edge at 849.6, more than half a screen away from the
 *     intended 1920: the card stayed on screen, but got dragged to a position nobody asked for.
 *
 * Therefore, divide by the projection ratio at the anchor before moving. Rotated cards have different
 * ratios across the four corners and cannot be resolved in a single step, so iterate several rounds
 * until converging to a fixed point: convergence is fast, and pure translateZ takes just one round.
 */
const CLAMP_PASSES = 6;

export function clampToStage(frame: ClipFrame | undefined, parent: Size, fovDeg?: number): ClipFrame {
  const f0 = resolveFrame(frame, parent);
  let cur: ClipFrame = { ...frame, x: f0.x, y: f0.y };
  let moved = false;

  for (let pass = 0; pass < CLAMP_PASSES; pass++) {
    const f = resolveFrame(cur, parent);
    const vb = visualBox(cur, parent, fovDeg);
    let dx = 0;
    let dy = 0;
    if (vb.width <= parent.width) {
      if (vb.left < 0) dx = -vb.left;
      else if (vb.left + vb.width > parent.width) dx = parent.width - (vb.left + vb.width);
    }
    if (vb.height <= parent.height) {
      if (vb.top < 0) dy = -vb.top;
      else if (vb.top + vb.height > parent.height) dy = parent.height - (vb.top + vb.height);
    }
    if (dx === 0 && dy === 0) break;
    // Projection ratio at the anchor: the anchor is the transform origin and unaffected by rotation,
    // so its depth is simply translateZ
    const k = fovDeg && frameIs3D(f)
      ? projectStage({ x: f.x, y: f.y, z: f.translateZ }, parent, fovDeg)?.scale || 1
      : 1;
    cur = { ...cur, x: f.x + dx / k, y: f.y + dy / k };
    moved = true;
    // In 2D, a single round is an exact solution without needing another pass (also ensuring results
    // are bit-for-bit identical to before)
    if (k === 1) break;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) break;
  }

  if (!moved) return { ...frame, x: f0.x, y: f0.y };
  const f = resolveFrame(cur, parent);
  return { ...frame, x: f.x, y: f.y };
}

export type SafeSide = "left" | "right" | "top" | "bottom";

/**
 * Subject detection says "this side is empty" → a rectangle that can be fed directly to set_rect.
 * left/right is half screen, top/bottom is a 1/3 band (consistent with sections used by subject
 * detection to calculate occupancy), leaving margins on all sides.
 */
export function rectForSafeSide(side: SafeSide, parent: Size, margin = 40): Rect {
  const W = parent.width, H = parent.height;
  switch (side) {
    case "left": return { x1: margin, y1: margin, x2: W / 2 - margin, y2: H - margin };
    case "right": return { x1: W / 2 + margin, y1: margin, x2: W - margin, y2: H - margin };
    case "top": return { x1: margin, y1: margin, x2: W - margin, y2: H / 3 - margin };
    case "bottom": return { x1: margin, y1: (H * 2) / 3 + margin, x2: W - margin, y2: H - margin };
    default: throw new Error(`safeSide must be left / right / top / bottom, got ${JSON.stringify(side)}`);
  }
}

/** Add/subtract on top of existing values: add pixels to position, multiply scale, add angles to rotation */
export function nudgeFrame(
  d: { dx?: number; dy?: number; scaleBy?: number; rotateBy?: number },
  prev: ClipFrame | undefined,
  parent: Size,
): ClipFrame {
  for (const k of ["dx", "dy", "scaleBy", "rotateBy"] as const) {
    const v = d[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) throw new Error(`${k} must be a finite number, got ${JSON.stringify(v)}`);
  }
  if (d.scaleBy !== undefined && !(d.scaleBy > 0)) throw new Error(`scaleBy is a multiplier and must be greater than 0 (0.5 = shrink to half, 2 = double the size), got ${d.scaleBy}`);
  if (d.dx === undefined && d.dy === undefined && d.scaleBy === undefined && d.rotateBy === undefined) {
    throw new Error("nudge needs at least one of dx / dy / scaleBy / rotateBy");
  }
  const p = resolveFrame(prev, parent);
  return {
    ...prev,
    x: p.x + (d.dx ?? 0),
    y: p.y + (d.dy ?? 0),
    ...(d.scaleBy !== undefined ? { scale: p.scale * d.scaleBy } : null),
    ...(d.rotateBy !== undefined ? { rotate: p.rotate + d.rotateBy } : null),
  };
}
