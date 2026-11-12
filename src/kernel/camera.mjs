/**
 * Cut kinds (`"2d" | "3d"`), dedicated camera lane (`cut.cameras`), and deterministic 2D / 3D
 * camera resolution at timeline time `t`.
 *
 * Pure JS (.mjs + .d.mts) with zero browser or Three.js dependencies so kernel, render, editor,
 * MCP handlers, and Node server frame pipelines share a single source of truth.
 */

import { BASE_VARS, FilterExprError, compiledOf, parseExpr } from "./filters.mjs";

export const CUT_KINDS = Object.freeze(["2d", "3d"]);
export const CAMERA_2D_KEYS = Object.freeze(["x", "y", "zoom", "rotate"]);
export const CAMERA_3D_KEYS = Object.freeze(["x", "y", "z", "rx", "ry", "rz", "fovDeg"]);

/** Mirrors `space3d.ts` constants so `.mjs` callers stay independent of `.ts` modules. */
const DEFAULT_FOV_DEG = 40;
const MIN_FOV_DEG = 5;
const MAX_FOV_DEG = 120;
const BOARD_NEAR_RATIO = 0.15;
const EPS = 1e-9;

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const nz = (n) => (Object.is(n, -0) ? 0 : n + 0);

function clampFovDeg(fovDeg) {
  const v = Number(fovDeg);
  if (!Number.isFinite(v)) return DEFAULT_FOV_DEG;
  return clamp(v, MIN_FOV_DEG, MAX_FOV_DEG);
}

/** Pinhole focal distance `d = H / (2 * tan(fov / 2))` matching `cameraFor` in `space3d.ts`. */
export function cameraDistanceForStage(height, fovDeg = DEFAULT_FOV_DEG) {
  const fov = clampFovDeg(fovDeg);
  const h = Math.max(1, Number(height) || 1080);
  return h / (2 * Math.tan((fov * Math.PI) / 360));
}

/** Declared cut kind; defaults to `"2d"` and is never guessed from content. */
export function cutKindOf(cut) {
  return cut?.kind === "3d" ? "3d" : "2d";
}

/** Active cut entry in `project.cuts`, or `undefined` for legacy single-cut projects without `cuts`. */
export function activeCutEntry(project) {
  const cuts = Array.isArray(project?.cuts) ? project.cuts : [];
  if (!cuts.length) return undefined;
  if (project.activeCutId) {
    const hit = cuts.find((c) => c && c.id === project.activeCutId);
    if (hit) return hit;
  }
  return cuts[0];
}

/** Active cut kind (`"2d"` by default). */
export function activeCutKind(project) {
  return cutKindOf(activeCutEntry(project));
}

/**
 * Effective 3D perspective FOV for a cut:
 * - On `"3d"` cuts: `cut.camera3dFov ?? project.camera3dFov ?? DEFAULT_FOV_DEG` (`40`).
 * - On `"2d"` cuts: `cut.camera3dFov ?? project.camera3dFov` (`undefined` when unset so legacy 2D cuts stay flat).
 */
export function effectiveCamera3dFov(project, cut = activeCutEntry(project)) {
  const raw = cut?.camera3dFov ?? project?.camera3dFov;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return clampFovDeg(raw);
  return cutKindOf(cut) === "3d" ? DEFAULT_FOV_DEG : undefined;
}

/** Default 3D FOV number (`40` fallback) when resolving 3D cameras. */
export function defaultCutFovDeg(project, cut = activeCutEntry(project)) {
  return clampFovDeg(cut?.camera3dFov ?? project?.camera3dFov ?? DEFAULT_FOV_DEG);
}

/** Canvas space dimensions of a 2D cut (defaults to `project.width` x `project.height`). */
export function cutSpaceSize(project, cut = activeCutEntry(project)) {
  const w = typeof cut?.spaceWidth === "number" && Number.isFinite(cut.spaceWidth) && cut.spaceWidth > 0
    ? cut.spaceWidth
    : (Number(project?.width) || 1920);
  const h = typeof cut?.spaceHeight === "number" && Number.isFinite(cut.spaceHeight) && cut.spaceHeight > 0
    ? cut.spaceHeight
    : (Number(project?.height) || 1080);
  return { width: w, height: h };
}

function validateNumOrExpr(raw, key, checkRange) {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new FilterExprError(`camera params.${key} must be a finite number`);
    const err = checkRange?.(raw);
    if (err) throw new FilterExprError(err);
    return nz(raw);
  }
  if (typeof raw === "string") {
    const expr = raw.trim();
    if (!expr) throw new FilterExprError(`camera params.${key} cannot be an empty string`);
    let fn;
    try {
      ({ fn } = compiledOf(expr, BASE_VARS));
    } catch (e) {
      throw new FilterExprError(`camera params.${key} has an invalid expression: ${e.message}`);
    }
    for (const d of [1, 10]) {
      for (const t of [0, d * 0.37, d]) {
        const v = fn({ t, d, p: t / d });
        if (!Number.isFinite(v)) {
          throw new FilterExprError(
            `camera params.${key} evaluated to ${v} at t=${round6(t)}, d=${d}; rewrite to avoid division by 0 or log(0)`,
          );
        }
        const err = checkRange?.(v, ` at t=${round6(t)}, d=${d}`);
        if (err) throw new FilterExprError(err);
      }
    }
    return expr;
  }
  throw new FilterExprError(`camera params.${key} must be a number or expression string, got ${JSON.stringify(raw)}`);
}

/**
 * Validate and normalize camera `params` for a `"2d"` or `"3d"` cut.
 * When `opts.partial` is true, `null` or `""` values are kept as `null` markers so `mergeCameraParams` can delete them.
 */
export function validateCameraParams(params, kind = "2d", opts = {}) {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new FilterExprError("camera params must be an object");
  }
  const cutKind = kind === "3d" ? "3d" : "2d";
  const allowed = new Set(cutKind === "3d" ? CAMERA_3D_KEYS : CAMERA_2D_KEYS);
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (!allowed.has(k)) {
      const hint =
        cutKind === "2d" && CAMERA_3D_KEYS.includes(k)
          ? ` (this cut is "2d"; use zoom/x/y/rotate for a 2D camera, or switch the cut to "3d" via set_cut_kind first)`
          : cutKind === "3d" && k === "zoom"
            ? ` (this cut is "3d"; move z or animate fovDeg instead of 2D zoom)`
            : "";
      throw new FilterExprError(
        `camera params does not recognize "${k}" for a ${cutKind.toUpperCase()} cut; allowed: ${[...allowed].join(", ")}${hint}`,
      );
    }
    if (v === undefined) continue;
    if (opts.partial && (v === null || v === "")) {
      out[k] = null;
      continue;
    }
    const checkRange =
      k === "zoom"
        ? (n, at = "") => (n > 0 ? null : `camera params.zoom must be greater than 0, got ${round6(n)}${at}`)
        : k === "fovDeg"
          ? (n, at = "") =>
            n >= MIN_FOV_DEG && n <= MAX_FOV_DEG
              ? null
              : `camera params.fovDeg must be between ${MIN_FOV_DEG} and ${MAX_FOV_DEG} degrees, got ${round6(n)}${at}`
          : undefined;
    out[k] = validateNumOrExpr(v, k, checkRange);
  }
  return out;
}

/** Merge a partial validated camera params patch into existing `prev` params. */
export function mergeCameraParams(prev, patch, kind = "2d") {
  const checked = validateCameraParams(patch, kind, { partial: true });
  const allowed = new Set(kind === "3d" ? CAMERA_3D_KEYS : CAMERA_2D_KEYS);
  const out = {};
  if (prev && typeof prev === "object") {
    for (const [k, v] of Object.entries(prev)) {
      if (allowed.has(k) && v !== undefined && v !== null) out[k] = v;
    }
  }
  for (const [k, v] of Object.entries(checked)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/**
 * Enforce camera lane invariants:
 * - `start >= 0`, `end > start`, integer `row >= 0`.
 * - Non-overlap within the same `row` (adjacent touching `a.end === b.start` is allowed; higher `row` overrides lower `row`).
 */
export function assertCameraLaneNoOverlap(cameras, candidate, ignoreId) {
  const start = Number(candidate?.start);
  const end = Number(candidate?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || !(end > start)) {
    throw new Error(`Camera start/end must be finite numbers with 0 <= start < end (got start=${candidate?.start}, end=${candidate?.end})`);
  }
  const rawRow = candidate?.row ?? 0;
  if (!Number.isFinite(rawRow) || rawRow < 0 || Math.floor(rawRow) !== rawRow) {
    throw new Error(`Camera row must be a non-negative integer (0, 1, 2...), got ${JSON.stringify(rawRow)}`);
  }
  const row = rawRow;
  for (const existing of Array.isArray(cameras) ? cameras : []) {
    if (!existing || existing.id === ignoreId) continue;
    const erow = existing.row ?? 0;
    if (erow !== row) continue;
    if (existing.start < end - EPS && start < existing.end - EPS) {
      throw new Error(
        `Camera lane row ${row} already has camera "${existing.name || existing.id}" (${existing.start}s ~ ${existing.end}s) overlapping ${start}s ~ ${end}s. ` +
          `Place cameras end-to-start on row ${row}, or put an override camera on row ${row + 1}.`,
      );
    }
  }
}

/** Sort camera clips deterministically by `(row ?? 0, start, id)`. */
export function sortCameraClips(cameras) {
  return [...(Array.isArray(cameras) ? cameras : [])].sort((a, b) => {
    const ra = a?.row ?? 0;
    const rb = b?.row ?? 0;
    if (ra !== rb) return ra - rb;
    if (a.start !== b.start) return a.start - b.start;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Active camera clip at timeline time `t` (`start <= t && t < end`, `enabled !== false`).
 * Highest `row` wins ("upper row overrides lower row", Issue #12 Section 4.4).
 */
export function activeCameraClipAt(cameras, t) {
  if (!Array.isArray(cameras) || cameras.length === 0) return null;
  const time = Number(t) || 0;
  let winner = null;
  let winnerRow = -1;
  for (const cam of cameras) {
    if (!cam || cam.enabled === false) continue;
    if (!(time >= cam.start && time < cam.end)) continue;
    const row = typeof cam.row === "number" && Number.isFinite(cam.row) ? cam.row : 0;
    if (winner === null || row > winnerRow || (row === winnerRow && cam.start >= winner.start)) {
      winner = cam;
      winnerRow = row;
    }
  }
  return winner;
}

function evalParam(raw, env, fallback) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : fallback;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const v = compiledOf(raw.trim(), BASE_VARS).fn(env);
      return Number.isFinite(v) ? v : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function clipEnvAt(cam, t) {
  const d = Math.max(1e-6, (Number(cam.end) || 0) - (Number(cam.start) || 0));
  const localT = clamp((Number(t) || 0) - (Number(cam.start) || 0), 0, d);
  return { t: localT, d, p: clamp(localT / d, 0, 1) };
}

/**
 * Evaluate the active 2D camera at timeline time `t`.
 * Uncovered moments return the identity camera `{ x: 0, y: 0, zoom: 1, rotate: 0, activeClipId: null }`.
 */
export function resolveCamera2DAt(cameras, t) {
  const cam = activeCameraClipAt(cameras, t);
  if (!cam) {
    return { x: 0, y: 0, zoom: 1, rotate: 0, activeClipId: null };
  }
  const env = clipEnvAt(cam, t);
  const p = cam.params || {};
  const x = nz(round6(evalParam(p.x, env, 0)));
  const y = nz(round6(evalParam(p.y, env, 0)));
  const zoom = nz(round6(Math.max(1e-3, evalParam(p.zoom, env, 1))));
  const rotate = nz(round6(evalParam(p.rotate, env, 0)));
  return { x, y, zoom, rotate, activeClipId: cam.id };
}

/** True when a resolved 2D camera equals the identity view (no CSS wrapper transform needed). */
export function isIdentityCamera2D(cam) {
  if (!cam) return true;
  return cam.x === 0 && cam.y === 0 && cam.zoom === 1 && cam.rotate === 0;
}

/**
 * Deterministic CSS transform for a 2D camera wrapper sized `stage.width` x `stage.height`.
 *
 * Transform order around `(stage.width / 2, stage.height / 2)`:
 *   translate(-cam.x, -cam.y) -> rotate(-cam.rotate) -> scale(cam.zoom)
 * In CSS right-to-left order: `scale(zoom) rotate(-rotate deg) translate(-x px, -y px)`.
 */
export function camera2DCssTransform(cam, stage) {
  if (!cam || isIdentityCamera2D(cam)) return null;
  const cx = (Number(stage?.width) || 1920) / 2;
  const cy = (Number(stage?.height) || 1080) / 2;
  const parts = [];
  if (cam.zoom !== 1) parts.push(`scale(${cam.zoom})`);
  if (cam.rotate !== 0) parts.push(`rotate(${nz(-cam.rotate)}deg)`);
  if (cam.x !== 0 || cam.y !== 0) parts.push(`translate(${nz(-cam.x)}px, ${nz(-cam.y)}px)`);
  if (!parts.length) return null;
  return {
    transformOrigin: `${cx}px ${cy}px`,
    transform: parts.join(" "),
  };
}

/**
 * Evaluate the active 3D camera at timeline time `t` in Three.js world coordinates (`space3d.ts` convention:
 * origin at stage center, +x right, +y up, +z toward viewer; Euler rotation order `"YXZ"` in degrees).
 *
 * Uncovered moments return the straight-on default view at `(0, 0, cameraDistance(stage.height, defaultFovDeg))`
 * with `rx = 0, ry = 0, rz = 0, fovDeg = defaultFovDeg`, identical to legacy static 3D framing.
 */
export function resolveCamera3DAt(cameras, stage, t, defaultFovDeg = DEFAULT_FOV_DEG) {
  const baseFov = clampFovDeg(defaultFovDeg);
  const cam = activeCameraClipAt(cameras, t);
  let x = 0;
  let y = 0;
  let z;
  let rx = 0;
  let ry = 0;
  let rz = 0;
  let fovDeg = baseFov;

  if (cam) {
    const env = clipEnvAt(cam, t);
    const p = cam.params || {};
    fovDeg = clampFovDeg(evalParam(p.fovDeg, env, baseFov));
    const defaultZ = cameraDistanceForStage(stage?.height, fovDeg);
    x = nz(round6(evalParam(p.x, env, 0)));
    y = nz(round6(evalParam(p.y, env, 0)));
    z = nz(round6(evalParam(p.z, env, defaultZ)));
    rx = nz(round6(evalParam(p.rx, env, 0)));
    ry = nz(round6(evalParam(p.ry, env, 0)));
    rz = nz(round6(evalParam(p.rz, env, 0)));
  } else {
    z = nz(round6(cameraDistanceForStage(stage?.height, fovDeg)));
  }

  // Exact basis vectors for Three.js Euler(rxRad, ryRad, rzRad, "YXZ"): R = R_y(ry) * R_x(rx) * R_z(rz)
  const rxRad = (rx * Math.PI) / 180;
  const ryRad = (ry * Math.PI) / 180;
  const rzRad = (rz * Math.PI) / 180;
  const cosX = Math.cos(rxRad);
  const sinX = Math.sin(rxRad);
  const cosY = Math.cos(ryRad);
  const sinY = Math.sin(ryRad);
  const cosZ = Math.cos(rzRad);
  const sinZ = Math.sin(rzRad);

  const right = [
    nz(round6(cosY * cosZ + sinY * sinX * sinZ)),
    nz(round6(cosX * sinZ)),
    nz(round6(-sinY * cosZ + cosY * sinX * sinZ)),
  ];
  const forward = [
    nz(round6(-sinY * cosX)),
    nz(round6(sinX)),
    nz(round6(-cosY * cosX)),
  ];
  const up = [
    nz(round6(-sinZ * cosY + cosZ * sinX * sinY)),
    nz(round6(cosZ * cosX)),
    nz(round6(sinZ * sinY + cosZ * sinX * cosY)),
  ];

  const focalDist = cameraDistanceForStage(stage?.height, fovDeg);
  const near = nz(Math.max(1, focalDist * BOARD_NEAR_RATIO));
  const far = nz(Math.max(focalDist * 10, Math.hypot(x, y, z) + focalDist * 12));

  return {
    x,
    y,
    z,
    rx,
    ry,
    rz,
    fovDeg,
    position: [x, y, z],
    right,
    forward,
    up,
    near,
    far,
    distance: focalDist,
    activeClipId: cam ? cam.id : null,
  };
}

/** Default 2D camera pose when no camera clip covers `t`. */
export function defaultCamera2D() {
  return { x: 0, y: 0, zoom: 1, rotate: 0 };
}

/** Default straight-on 3D camera pose when no camera clip covers `t`. */
export function defaultCamera3D(project, cut = activeCutEntry(project)) {
  const fovDeg = defaultCutFovDeg(project, cut);
  const z = nz(round6(cameraDistanceForStage(project?.height, fovDeg)));
  return { x: 0, y: 0, z, rx: 0, ry: 0, rz: 0, fovDeg };
}

/** Validate an expression string (exported convenience for tests and MCP tools). */
export { parseExpr };
