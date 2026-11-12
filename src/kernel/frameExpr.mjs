/**
 * Time-varying expressions for clip frame fields (x, y, w, h, scale, rotate, rotateX, rotateY, translateZ).
 *
 * Reuses the deterministic expression grammar and compiler in `./filters.mjs` (`BASE_VARS = ["t", "d", "p"]`,
 * `parseExpr`, `compiledOf`, `FilterExprError`). Pure JS (.mjs + .d.mts) so both browser bundles and Node
 * server pipelines import the exact same evaluation and cache-key rules.
 */

import { BASE_VARS, FilterExprError, compiledOf, parseExpr } from "./filters.mjs";

export const FRAME_EXPR_KEYS = Object.freeze([
  "x",
  "y",
  "w",
  "h",
  "scale",
  "rotate",
  "rotateX",
  "rotateY",
  "translateZ",
]);

const FRAME_EXPR_KEY_SET = new Set(FRAME_EXPR_KEYS);
const POSITIVE_FRAME_KEYS = new Set(["w", "h", "scale"]);
const THREE_D_FRAME_KEYS = new Set(["rotateX", "rotateY", "translateZ"]);

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const nz = (n) => n + 0;

/**
 * Validate a single frame expression string for `key`, throwing a descriptive Error on syntax errors,
 * unknown variables, NaN/Infinity, or non-positive sizes/scales on trial sample timestamps.
 */
export function validateFrameExpr(raw, key = "value") {
  if (!FRAME_EXPR_KEY_SET.has(key)) {
    throw new FilterExprError(
      `frameExpr does not recognize "${key}"; allowed keys: ${FRAME_EXPR_KEYS.join(", ")}`,
    );
  }
  if (typeof raw !== "string" || !raw.trim()) {
    throw new FilterExprError(`frameExpr.${key} must be a non-empty expression string`);
  }
  const expr = raw.trim();
  let fn;
  try {
    ({ fn } = compiledOf(expr, BASE_VARS));
  } catch (e) {
    throw new FilterExprError(`frameExpr.${key} has an invalid expression: ${e.message}`);
  }
  for (const d of [1, 10]) {
    for (const t of [0, d * 0.37, d]) {
      const p = t / d;
      const v = fn({ t, d, p });
      if (!Number.isFinite(v)) {
        throw new FilterExprError(
          `frameExpr.${key} evaluated to ${v} at t=${round6(t)}, d=${d}; rewrite to avoid division by 0 or log(0)`,
        );
      }
      if (POSITIVE_FRAME_KEYS.has(key) && !(v > 0)) {
        throw new FilterExprError(
          `frameExpr.${key} must evaluate greater than 0, got ${round6(v)} at t=${round6(t)}, d=${d}`,
        );
      }
    }
  }
  return expr;
}

/**
 * Normalize a full `frameExpr` object (e.g. from `set_clip` envelope or `set_position`).
 * Returns `undefined` when empty or nullish so clips without expressions omit the property completely.
 */
export function normalizeFrameExprMap(input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new FilterExprError("frameExpr must be an object mapping frame keys to expression strings, or null");
  }
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!FRAME_EXPR_KEY_SET.has(k)) {
      throw new FilterExprError(
        `frameExpr does not recognize "${k}"; allowed keys: ${FRAME_EXPR_KEYS.join(", ")}`,
      );
    }
    if (v === undefined || v === null || v === "") continue;
    out[k] = validateFrameExpr(v, k);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Merge a partial patch into an existing `frameExpr` map.
 * Setting a key to `null` or `""` clears that expression; setting a key to a numeric value via
 * `clearKeys` also removes any expression previously driving that key unless explicitly re-set in `patch`.
 */
export function mergeFrameExpr(prev, patch, clearKeys = []) {
  const next = {};
  if (prev && typeof prev === "object") {
    for (const k of FRAME_EXPR_KEYS) {
      if (typeof prev[k] === "string" && prev[k].trim()) next[k] = prev[k].trim();
    }
  }
  for (const k of clearKeys) delete next[k];
  if (patch !== undefined) {
    if (patch === null) return undefined;
    if (typeof patch !== "object" || Array.isArray(patch)) {
      throw new FilterExprError("frameExpr must be an object mapping frame keys to expression strings, or null");
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!FRAME_EXPR_KEY_SET.has(k)) {
        throw new FilterExprError(
          `frameExpr does not recognize "${k}"; allowed keys: ${FRAME_EXPR_KEYS.join(", ")}`,
        );
      }
      if (v === undefined) continue;
      if (v === null || v === "") {
        delete next[k];
      } else {
        next[k] = validateFrameExpr(v, k);
      }
    }
  }
  return Object.keys(next).length ? next : undefined;
}

/** True when at least one valid frame key carries a non-empty expression string. */
export function hasFrameExpr(frameExpr) {
  if (!frameExpr || typeof frameExpr !== "object") return false;
  for (const k of FRAME_EXPR_KEYS) {
    if (typeof frameExpr[k] === "string" && frameExpr[k].trim()) return true;
  }
  return false;
}

/** True when `rotateX`, `rotateY`, or `translateZ` is driven by a `frameExpr`. */
export function has3DFrameExpr(frameExpr) {
  if (!frameExpr || typeof frameExpr !== "object") return false;
  for (const k of THREE_D_FRAME_KEYS) {
    if (typeof frameExpr[k] === "string" && frameExpr[k].trim()) return true;
  }
  return false;
}

/** True when `w` or `h` is driven by a `frameExpr` (inner card layout box changes over time). */
export function hasAnimatedFrameSize(frameExpr) {
  if (!frameExpr || typeof frameExpr !== "object") return false;
  return (
    (typeof frameExpr.w === "string" && frameExpr.w.trim().length > 0) ||
    (typeof frameExpr.h === "string" && frameExpr.h.trim().length > 0)
  );
}

/**
 * Strip outer-wrapper pose expressions (`x`, `y`, `scale`, `rotate`, `rotateX`, `rotateY`, `translateZ`)
 * when baking an inner card's own local canvas, keeping only `w` / `h` if present.
 */
export function stripOuterFrameExpr(frameExpr) {
  if (!frameExpr || typeof frameExpr !== "object") return undefined;
  const out = {};
  if (typeof frameExpr.w === "string" && frameExpr.w.trim()) out.w = frameExpr.w.trim();
  if (typeof frameExpr.h === "string" && frameExpr.h.trim()) out.h = frameExpr.h.trim();
  return Object.keys(out).length ? out : undefined;
}

function fallbackField(frame, key) {
  const existing = frame?.[key];
  if (typeof existing === "number" && Number.isFinite(existing)) return existing;
  if (key === "scale") return 1;
  if (key === "w" || key === "h") return undefined;
  return 0;
}

/**
 * Deterministically evaluate a clip's `ClipFrame` at `localT` seconds from clip start (`clipDuration` seconds).
 *
 * Returns `frame` untouched (exact reference) when `frameExpr` is empty/undefined so clips without
 * expressions take zero overhead and keep byte-identical rendering.
 */
export function resolveClipFrameAt(frame, frameExpr, localT, clipDuration) {
  if (!hasFrameExpr(frameExpr)) return frame;
  const d = Math.max(1e-6, Number(clipDuration) || 0);
  const t = clamp(Number(localT) || 0, 0, d);
  const p = clamp(t / d, 0, 1);
  const env = { t, d, p };

  const out = {
    ...(frame || {}),
    x: typeof frame?.x === "number" && Number.isFinite(frame.x) ? frame.x : 0,
    y: typeof frame?.y === "number" && Number.isFinite(frame.y) ? frame.y : 0,
  };

  for (const key of FRAME_EXPR_KEYS) {
    const raw = frameExpr[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    let v;
    try {
      v = compiledOf(raw.trim(), BASE_VARS).fn(env);
    } catch {
      v = NaN;
    }
    if (!Number.isFinite(v)) {
      const fb = fallbackField(frame, key);
      if (fb !== undefined) out[key] = fb;
      continue;
    }
    if (POSITIVE_FRAME_KEYS.has(key)) {
      v = Math.max(1e-3, v);
    }
    out[key] = nz(round6(v));
  }
  return out;
}
