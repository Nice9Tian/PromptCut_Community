/**
 * Pure kernel for generic pixel maps.
 *
 * Deliberately does not touch DOM, Canvas, or ffmpeg here: definitions and expressions are shared
 * between editor, see_frames, and export, and concrete renderers only need to call mapRgba.
 * Expressions reuse the safe parser from filters and never use eval / Function.
 */
import { compiledOf, parseExpr, astToFn, applyTableOps, normalizeFilterDef, MAX_TABLE_POINTS, FilterExprError } from "./filters.mjs";

export const PIXEL_MAP_MODES = ["continuous", "discrete"];
export const PIXEL_MAP_STAGES = ["origin", "after_filters"];
export const MAX_PIXEL_MAPS = 16;
export const MAX_SEQUENCE = 64;
const PIXEL_VARS = ["r", "g", "b", "a", "luma", "x", "y", "t"];
const HEX = /^#([0-9a-f]{3,8})$/i;

const clamp01 = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
const str = (v) => typeof v === "string" ? v.trim() : "";

export function parseColor(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  const m = HEX.exec(s);
  if (!m) {
    const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(s);
    if (!rgb) return null;
    return [clamp01(Number(rgb[1]) / 255), clamp01(Number(rgb[2]) / 255), clamp01(Number(rgb[3]) / 255), rgb[4] == null ? 1 : clamp01(Number(rgb[4]))];
  }
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length === 6) h += "ff";
  if (h.length !== 8) return null;
  return [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

function sourceOf(raw, label) {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (value.toLowerCase() === "transparent") return { kind: "transparent" };
    if (parseColor(value)) return { kind: "color", value };
    if (value) return { kind: "media", mediaId: value, stage: "origin" };
  }
  if (!raw || typeof raw !== "object") throw new FilterExprError(`${label} must be a media, color, transparent or expression object`);
  const stage = raw.stage ?? "origin";
  if (!PIXEL_MAP_STAGES.includes(stage)) throw new FilterExprError(`${label}.stage must be origin or after_filters`);
  if (typeof raw.mediaId === "string" && raw.mediaId.trim()) return { kind: "media", mediaId: raw.mediaId.trim(), stage, ...(raw.filterId ? { filterId: String(raw.filterId) } : null) };
  if (typeof raw.value === "string") {
    if (raw.value.trim().toLowerCase() === "transparent") return { kind: "transparent" };
    if (parseColor(raw.value)) return { kind: "color", value: raw.value.trim() };
  }
  if (raw.kind === "media" && typeof raw.mediaId === "string") return { kind: "media", mediaId: raw.mediaId.trim(), stage, ...(raw.filterId ? { filterId: String(raw.filterId) } : null) };
  if (raw.kind === "color" && parseColor(raw.color ?? raw.value)) return { kind: "color", value: String(raw.color ?? raw.value).trim() };
  if (raw.kind === "transparent") return { kind: "transparent" };
  if (raw.kind === "expr" || ["r", "g", "b"].some((k) => typeof raw[k] === "string" || typeof raw[k] === "number")) {
    const out = { kind: "expr", r: raw.r ?? "r", g: raw.g ?? "g", b: raw.b ?? "b", a: raw.a ?? "a" };
    for (const k of ["r", "g", "b", "a"]) {
      if (typeof out[k] === "number") continue;
      if (typeof out[k] !== "string" || !out[k].trim()) throw new FilterExprError(`${label}.${k} must be an expression`);
      try { compiledOf(out[k].trim(), PIXEL_VARS); } catch (e) { throw new FilterExprError(`${label}.${k} has an invalid expression: ${e.message}`); }
    }
    return out;
  }
  throw new FilterExprError(`${label} has an unrecognized format`);
}

function sequenceOf(raw) {
  if (raw == null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SEQUENCE) throw new FilterExprError(`colorSequence must have 1~${MAX_SEQUENCE} colors`);
  const out = raw.map((v, i) => {
    const c = parseColor(v);
    if (!c) throw new FilterExprError(`colorSequence[${i}] is not a color`);
    return String(v).trim();
  });
  return out;
}

export function normalizePixelMapDef(input) {
  if (!input || typeof input !== "object") throw new FilterExprError("A pixel map definition must be an object");
  const name = str(input.name);
  if (!name || name.length > 40) throw new FilterExprError("name is required, up to 40 characters");
  const where = str(input.where);
  if (!where) throw new FilterExprError("where is required: write the selection weight using r/g/b/a/luma/x/y/t");
  try { compiledOf(where, PIXEL_VARS); } catch (e) { throw new FilterExprError(`where has an invalid expression: ${e.message}`); }
  const source = input.source == null ? { stage: "origin" } : input.source;
  if (!source || typeof source !== "object") throw new FilterExprError("source must be an object");
  const stage = source.stage ?? "origin";
  if (!PIXEL_MAP_STAGES.includes(stage)) throw new FilterExprError("source.stage must be origin or after_filters");
  const to = input.to == null && input.colorSequence?.to?.length
    ? { kind: "color", value: String(input.colorSequence.to[input.colorSequence.to.length - 1]) }
    : sourceOf(input.to, "to");
  const mode = input.mode ?? "continuous";
  if (!PIXEL_MAP_MODES.includes(mode)) throw new FilterExprError("mode must be continuous or discrete");
  const from = sequenceOf(input.colorSequence?.from);
  const seqTo = sequenceOf(input.colorSequence?.to);
  if ((from && !seqTo) || (!from && seqTo)) throw new FilterExprError("colorSequence requires both from and to");
  if (from && seqTo && to.kind !== "color") throw new FilterExprError("colorSequence does not need to, or to must be left empty");
  return {
    name,
    ...(str(input.description) ? { description: str(input.description).slice(0, 200) } : null),
    source: { stage, ...(source.mediaId ? { mediaId: String(source.mediaId), ...(source.filterId ? { filterId: String(source.filterId) } : null) } : null) },
    where,
    to,
    mode,
    ...(from ? { colorSequence: { from, to: seqTo, mode } } : null),
  };
}

export function compilePixelMap(def) {
  const where = compiledOf(def.where, PIXEL_VARS).fn;
  const to = def.to?.kind === "expr" ? Object.fromEntries(["r", "g", "b", "a"].map((k) => [k, typeof def.to[k] === "number" ? () => def.to[k] : compiledOf(def.to[k], PIXEL_VARS).fn])) : null;
  const seqFrom = def.colorSequence?.from?.map(parseColor);
  const seqTo = def.colorSequence?.to?.map(parseColor);
  return { where, to, seqFrom, seqTo };
}

const compiledCache = new WeakMap();
function compiledCached(def) {
  if (!def || typeof def !== "object") return compilePixelMap(def);
  let hit = compiledCache.get(def);
  if (!hit) { hit = compilePixelMap(def); compiledCache.set(def, hit); }
  return hit;
}

function sequenceTarget(rgba, seqFrom, seqTo, mode) {
  if (!seqFrom?.length || !seqTo?.length) return null;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < seqFrom.length; i++) { const d = dist(rgba, seqFrom[i]); if (d < best) { best = d; idx = i; } }
  if (mode === "discrete" || seqTo.length === 1) return seqTo[Math.min(idx, seqTo.length - 1)];
  const p = seqFrom.length === 1 ? 0 : idx / (seqFrom.length - 1);
  const q = p * (seqTo.length - 1);
  const i = Math.min(seqTo.length - 2, Math.max(0, Math.floor(q)));
  const f = q - i;
  return seqTo[i].map((v, k) => v + (seqTo[i + 1][k] - v) * f);
}

/** Maps a 0~1 RGBA pixel to a new pixel. For media targets, the renderer provides targetRgba. */
export function mapRgba(def, rgba, env = {}, targetRgba = null) {
  const input = [clamp01(rgba?.[0] ?? 0), clamp01(rgba?.[1] ?? 0), clamp01(rgba?.[2] ?? 0), clamp01(rgba?.[3] ?? 1)];
  const e = { r: input[0], g: input[1], b: input[2], a: input[3], luma: input[0] * 0.2126 + input[1] * 0.7152 + input[2] * 0.0722, x: env.x ?? 0, y: env.y ?? 0, t: env.t ?? 0 };
  const compiled = compiledCached(def);
  const w = clamp01(compiled.where(e));
  if (w <= 0) return input;
  let target = sequenceTarget(input, compiled.seqFrom, compiled.seqTo, def.mode);
  if (!target) {
    if (def.to?.kind === "color") target = parseColor(def.to.value);
    else if (def.to?.kind === "transparent") target = [input[0], input[1], input[2], 0];
    else if (def.to?.kind === "expr") {
      const c = compiled.to;
      target = ["r", "g", "b", "a"].map((k) => clamp01(c[k](e)));
    } else target = targetRgba ? targetRgba.map(clamp01) : input;
  }
  return input.map((v, i) => v * (1 - w) + target[i] * w);
}

/* ================================================================== Classification: A whole-frame color grading / B per-pixel / C untranslatable */

/**
 * Pixel maps have three destinations (see docs/archive/restructure_planning/render_pipeline_restructure.md 3.9):
 *
 *   A whole-frame color grading  where is constant, to is only a color-to-color function → equivalent
 *                                to a series of curves / matrix filter steps. This work is handed to
 *                                create_filter: preview uses SVG filters, export uses lutrgb /
 *                                colorchannelmixer, both run on the GPU compositor and do not consume
 *                                the per-tick budget. The tool rejects accordingly and returns
 *                                ready-made ops.
 *   B per-pixel                  where references color / x / y / t to make selections, or to is
 *                                transparent, another media clip, or a non-linear expression with
 *                                cross-channel dependencies → can only be computed per-pixel, using
 *                                the WebGL backend of compilePixelMapGlsl.
 *   C untranslatable             expression contains constructs with no GLSL equivalent → reject
 *                                and point out where.
 *
 * Qualifying for A checks more than shape: once the shape matches, it also performs a **value-by-value
 * check** to verify whether the equivalent filter and mapRgba compute the same pixel (across the full
 * 0~255 range, difference ≤ 1 level). If verification fails, treat as B: for example, step functions
 * like step() cannot be represented by a 33-point sampling table; likewise, a color sequence is
 * essentially a step function that "samples color by nearest neighbor". This guarantees that
 * "classified as A means definitely swappable", without relying on manual deduction.
 */

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const CURVE_POINTS = MAX_TABLE_POINTS;
const LINEAR_VARS = ["r", "g", "b", "luma"];

const astOf = (v) => typeof v === "number" ? { t: "num", v } : parseExpr(String(v), PIXEL_VARS).ast;
const usesOf = (v) => typeof v === "number" ? new Set() : parseExpr(String(v), PIXEL_VARS).uses;
const envOf = (r, g, b, a = 1, x = 0, y = 0, t = 0) => ({ r, g, b, a, luma: r * 0.2126 + g * 0.7152 + b * 0.0722, x, y, t });
/** env with a value in only one channel: used for sampling expressions where each channel depends only on itself */
const chanEnv = (ch, v) => envOf(ch === "r" ? v : 0, ch === "g" ? v : 0, ch === "b" ? v : 0);

/** Whether where is constant; if so, returns its constant value (clamped to 0~1), otherwise returns null */
function constWhere(def) {
  const { uses } = parseExpr(def.where, PIXEL_VARS);
  if (uses.size) return null;
  return clamp01(compiledOf(def.where, PIXEL_VARS).fn(envOf(0, 0, 0)));
}

/** Whether to.a is identity (equivalent filters cannot touch alpha, so if not identity it cannot be classified as A) */
function alphaIsIdentity(def) {
  if (def.to?.kind !== "expr") return false;
  const raw = def.to.a ?? "a";
  for (const n of usesOf(raw)) if (n !== "a") return false;
  const fn = astToFn(astOf(raw));
  for (let i = 0; i < 256; i++) {
    const a = i / 255;
    if (Math.round(clamp01(fn(envOf(0, 0, 0, a))) * 255) !== i) return false;
  }
  return true;
}

/** Each channel depends only on itself → one-step curves (33-point sampling; constant weight of where folded into table) */
function curvesCandidate(def, w) {
  const out = { kind: "curves" };
  for (const ch of ["r", "g", "b"]) {
    for (const n of usesOf(def.to[ch])) if (n !== ch) return null;
    const fn = astToFn(astOf(def.to[ch]));
    out[ch] = Array.from({ length: CURVE_POINTS }, (_, i) => {
      const v = i / (CURVE_POINTS - 1);
      return round6(clamp01(v * (1 - w) + clamp01(fn(chanEnv(ch, v))) * w));
    });
  }
  return [out];
}

/**
 * Linear combination of r/g/b (luma is also linear) → one-step matrix; coefficients probed with
 * basis vectors, accuracy decided by value-by-value check.
 */
function matrixCandidate(def, w) {
  for (const ch of ["r", "g", "b"]) {
    for (const n of usesOf(def.to[ch])) if (!LINEAR_VARS.includes(n)) return null;
  }
  const fns = ["r", "g", "b"].map((ch) => astToFn(astOf(def.to[ch])));
  const at = (r, g, b) => fns.map((f) => f(envOf(r, g, b)));
  const d = at(0, 0, 0);
  const basis = [at(1, 0, 0), at(0, 1, 0), at(0, 0, 1)].map((v) => v.map((x, i) => x - d[i]));
  const values = [];
  for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) values.push(round6(w * basis[j][k] + (j === k ? 1 - w : 0)));
  const offset = d.map((v) => round6(w * v));
  if (values.some((v) => !Number.isFinite(v) || v < -4 || v > 4)) return null;
  if (offset.some((v) => !Number.isFinite(v) || v < -1 || v > 1)) return null;
  return [{ kind: "matrix", values, offset }];
}

/** Replace whole frame with a single color = suppress original color by 1-w, then add w times target color */
function colorCandidate(def, w) {
  const c = parseColor(def.to.value);
  if (!c || c[3] !== 1) return null;
  const values = [1 - w, 0, 0, 0, 1 - w, 0, 0, 0, 1 - w].map(round6);
  const offset = [0, 1, 2].map((i) => round6(c[i] * w));
  if (offset.some((v) => v < -1 || v > 1)) return null;
  return [{ kind: "matrix", values, offset }];
}

/**
 * Color sequence: when from is entirely grayscale, color selection is determined solely by the
 * **arithmetic mean** of r/g/b (sequenceTarget uses RGB Euclidean nearest neighbor; distance to gray
 * point (v,v,v) is minimal when v = mean, not the 0.2126/0.7152/0.0722 luminance weights).
 * Thus equivalent = one-step matrix spreading the mean across all three channels + one-step lookup
 * table. w must be 1: blending uses original color, and the matrix step has already wiped it out.
 */
function sequenceCandidate(def, w) {
  if (w !== 1 || !def.colorSequence) return null;
  const from = def.colorSequence.from.map(parseColor);
  const to = def.colorSequence.to.map(parseColor);
  if (!from.every((c) => Math.abs(c[0] - c[1]) < 1e-9 && Math.abs(c[1] - c[2]) < 1e-9)) return null;
  if (!to.every((c) => c[3] === 1)) return null;
  const third = round6(1 / 3);
  const curves = { kind: "curves", r: [], g: [], b: [] };
  for (let i = 0; i < CURVE_POINTS; i++) {
    const v = i / (CURVE_POINTS - 1);
    const tgt = sequenceTarget([v, v, v, 1], from, to, def.mode);
    ["r", "g", "b"].forEach((ch, k) => curves[ch].push(round6(clamp01(tgt[k]))));
  }
  return [{ kind: "matrix", values: Array(9).fill(third), offset: [0, 0, 0] }, curves];
}

/**
 * Sample points for value-by-value check: 256 grayscale levels + 256 levels per channel (other two
 * channels 0 / 0.5 / 1) + 33³ grid.
 */
function* verifySamples() {
  for (let i = 0; i < 256; i++) { const v = i / 255; yield [v, v, v]; }
  for (let c = 0; c < 3; c++) for (const other of [0, 128 / 255, 1]) for (let i = 0; i < 256; i++) {
    const s = [other, other, other];
    s[c] = i / 255;
    yield s;
  }
  const step = 255 / (CURVE_POINTS - 1);
  for (let i = 0; i < CURVE_POINTS; i++) for (let j = 0; j < CURVE_POINTS; j++) for (let k = 0; k < CURVE_POINTS; k++) {
    yield [Math.round(i * step) / 255, Math.round(j * step) / 255, Math.round(k * step) / 255];
  }
}

/** Maximum level difference between equivalent filter and mapRgba on opaque pixels (0~255) */
export function pixelMapOpsDiff(def, ops, samples = verifySamples()) {
  let worst = 0;
  for (const rgb of samples) {
    const ref = mapRgba(def, [rgb[0], rgb[1], rgb[2], 1]);
    if (Math.round(ref[3] * 255) !== 255) return 255; // Equivalent filters cannot touch alpha
    const got = applyTableOps(ops, rgb);
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(Math.round(ref[k] * 255) - Math.round(got[k] * 255));
      if (d > worst) { worst = d; if (worst > 8) return worst; }
    }
  }
  return worst;
}

/** Equivalent filter steps for class A; returns { why } explaining what blocked it when not class A */
function flatColorOps(def) {
  const w = constWhere(def);
  if (w === null) {
    const used = [...parseExpr(def.where, PIXEL_VARS).uses].join(" ");
    return { why: `where references ${used}, so it is a per-pixel selection` };
  }
  const to = def.to ?? {};
  let candidates = [];
  let shapeWhy = "";
  if (def.colorSequence) {
    candidates = [sequenceCandidate(def, w)];
    shapeWhy = w !== 1
      ? "colorSequence with a where other than 1: blending needs the original color, but the whole-frame color grading step has already erased it"
      : "colorSequence from is not all grayscale (color picking is RGB nearest neighbor, not a lookup by a single scalar), or to contains semi-transparent colors";
  } else if (to.kind === "expr") {
    if (!alphaIsIdentity(def)) return { why: "to.a changes alpha, which a curve / matrix cannot do" };
    candidates = [curvesCandidate(def, w), matrixCandidate(def, w)];
    shapeWhy = "The channels of to depend on each other: it is neither per-channel self-dependent (curve) nor a linear combination of r/g/b (matrix)";
  } else if (to.kind === "color") {
    candidates = [colorCandidate(def, w)];
    shapeWhy = "to is a semi-transparent color, and a curve / matrix cannot change alpha";
  } else if (to.kind === "transparent") return { why: "to is transparent, and a curve / matrix cannot change alpha" };
  else if (to.kind === "media") return { why: "to is another media clip, which requires sampling a second texture per pixel" };
  else return { why: `The form of to "${to.kind ?? "(empty)"}" is not whole-frame color grading` };

  let worstSeen = Infinity;
  for (const ops of candidates) {
    if (!ops) continue;
    let checked;
    try { checked = normalizeFilterDef({ name: def.name || "Color grading", ops }).ops; } catch { continue; }
    const diff = pixelMapOpsDiff(def, checked);
    if (diff <= 1) return { ops: checked, diff, w };
    worstSeen = Math.min(worstSeen, diff);
  }
  if (!Number.isFinite(worstSeen)) return { why: shapeWhy };
  return { why: `It looks like whole-frame color grading, but after sampling into a curve / matrix the per-value difference reaches ${worstSeen} levels (>1), which cannot be represented, so it can only be computed per pixel` };
}

/**
 * Classifies a (normalized) pixel map. Returns:
 *   { kind: "A", ops, filter, diff, reason, alphaNote? }  whole-frame color grading: ops can be
 *                                                         passed directly to create_filter
 *   { kind: "B", backend: "webgl", reason, usesTarget }   per-pixel: accepted, uses WebGL backend
 *   { kind: "C", reason }                                 untranslatable
 */
export function classifyPixelMap(def) {
  const flat = flatColorOps(def);
  if (flat.ops) {
    const alphaNote = def.to?.kind === "expr"
      ? undefined
      : "The equivalent filter only changes RGB; on semi-transparent pixels the original definition also pushes alpha toward the target color. The two agree when the media is opaque.";
    return {
      kind: "A",
      reason: "This is whole-frame color grading: where is a constant and to is just a color-to-color function, equivalent to a series of curves / matrix filter steps.",
      ops: flat.ops,
      filter: { name: def.name, ...(def.description ? { description: def.description } : null), ops: flat.ops },
      diff: flat.diff,
      ...(alphaNote ? { alphaNote } : null),
    };
  }
  let glsl;
  try { glsl = compilePixelMapGlsl(def); } catch (e) { return { kind: "C", reason: e.message }; }
  return { kind: "B", backend: "webgl", reason: flat.why, usesTarget: glsl.usesTarget };
}

/* ================================================================== GLSL backend */

export class PixelMapGlslError extends FilterExprError {}

/**
 * Parser function set → GLSL. Same-named functions are here; differing ones are handled separately
 * in emitCall.
 */
const GLSL_FUNCS = {
  sin: "sin", cos: "cos", tan: "tan", abs: "abs", sqrt: "sqrt", exp: "exp", log: "log",
  floor: "floor", ceil: "ceil", sign: "sign", min: "min", max: "max", mod: "mod", clamp: "clamp",
};

function glf(v) {
  if (!Number.isFinite(v)) throw new PixelMapGlslError(`The expression produced ${v}, which cannot be translated`);
  const s = String(v);
  return /[.e]/i.test(s) ? s : `${s}.0`;
}

const literalInt = (n) => n.t === "num" && Number.isInteger(n.v) ? n.v
  : n.t === "neg" && n.a.t === "num" && Number.isInteger(n.a.v) ? -n.a.v : null;
const isEvenIntLiteral = (n) => { const k = literalInt(n); return k !== null && k % 2 === 0; };

/**
 * Conservatively determines that a subtree is always non-negative. GLSL pow is undefined when the
 * base is negative, whereas JS Math.pow is defined for negative base + integer exponent, so
 * expressions where the two sides mismatch must be reported as untranslatable on the spot (class C).
 * Pixel map variables r, g, b, a, luma, x, y are all in 0~1, and t is seconds within the clip and
 * non-negative, so variables are all considered non-negative.
 */
function isNonNegative(n) {
  if (n.t === "num") return n.v >= 0;
  if (n.t === "var") return true;
  if (n.t === "neg") return false;
  if (n.t === "bin") {
    if (n.op === "+" || n.op === "*" || n.op === "/") return isNonNegative(n.a) && isNonNegative(n.b);
    if (n.op === "%") return isNonNegative(n.b);
    if (n.op === "^") return isNonNegative(n.a) || isEvenIntLiteral(n.b);
    return false;
  }
  if (n.t === "call") {
    if (["abs", "sqrt", "exp", "step", "smoothstep"].includes(n.name)) return true;
    if (n.name === "min") return n.args.every(isNonNegative);
    if (n.name === "max") return n.args.some(isNonNegative);
    if (n.name === "clamp") return isNonNegative(n.args[1]) && isNonNegative(n.args[2]);
    if (n.name === "mod") return isNonNegative(n.args[1]);
    if (n.name === "pow") return isNonNegative(n.args[0]) || isEvenIntLiteral(n.args[1]);
  }
  return false;
}

function emitPow(aNode, bNode) {
  const A = emitExpr(aNode), B = emitExpr(bNode);
  if (isNonNegative(aNode)) return `pow(${A}, ${B})`;
  const k = literalInt(bNode);
  if (k === null) {
    throw new PixelMapGlslError(`"${emitExpr(aNode)} ^ ${B}" cannot be translated: the base may be negative, and GLSL pow is undefined for a negative base. Wrap the base in abs(), or write the exponent as an integer constant`);
  }
  if (k === 0) return "1.0";
  return k % 2 === 0 ? `pow(abs(${A}), ${B})` : `(sign(${A}) * pow(abs(${A}), ${B}))`;
}

function emitCall(n) {
  const a = n.args.map(emitExpr);
  if (n.name === "pow") return emitPow(n.args[0], n.args[1]);
  // In GLSL, which direction round() rounds at exactly .5 is implementation-defined; Math.round is
  // always upwards, and floor(x+0.5) matches it value-by-value.
  if (n.name === "round") return `floor((${a[0]}) + 0.5)`;
  if (n.name === "lerp") return `mix(${a[0]}, ${a[1]}, ${a[2]})`;
  if (n.name === "min" || n.name === "max") return a.reduce((l, r) => `${n.name}(${l}, ${r})`);
  if (n.name === "step" || n.name === "smoothstep" || n.name === "clamp") return `${n.name}(${a.join(", ")})`;
  const g = Object.hasOwn(GLSL_FUNCS, n.name) ? GLSL_FUNCS[n.name] : null;
  if (!g) throw new PixelMapGlslError(`Function ${n.name}() has no GLSL equivalent and cannot be translated`);
  return `${g}(${a.join(", ")})`;
}

function emitExpr(n) {
  if (n.t === "num") return glf(n.v);
  if (n.t === "var") return n.name === "t" ? "uT" : n.name;
  if (n.t === "neg") return `(-${emitExpr(n.a)})`;
  if (n.t === "bin") {
    if (n.op === "^") return emitPow(n.a, n.b);
    if (n.op === "%") return `mod(${emitExpr(n.a)}, ${emitExpr(n.b)})`;
    return `(${emitExpr(n.a)} ${n.op} ${emitExpr(n.b)})`;
  }
  if (n.t === "call") return emitCall(n);
  throw new PixelMapGlslError(`The expression contains a node "${n?.t}" that cannot be translated`);
}

const emitSrc = (v) => emitExpr(astOf(v));
const vec4Of = (c) => `vec4(${c.map(glf).join(", ")})`;

export const PIXEL_MAP_VERTEX_GLSL = `#version 300 es
// Three vertices cover the whole viewport, no vertex buffer needed
void main() {
  float u = float((gl_VertexID << 1) & 2);
  float v = float(gl_VertexID & 2);
  gl_Position = vec4(u * 2.0 - 1.0, v * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * Color sequence section: finds index by nearest neighbor, then picks color / interpolates by mode;
 * corresponds statement-by-statement with sequenceTarget.
 */
function sequenceGlsl(def) {
  const from = def.colorSequence.from.map(parseColor);
  const to = def.colorSequence.to.map(parseColor);
  const nf = from.length, nt = to.length;
  const decls = `const float PC_SEQ_EPS = 1e-6;\n`
    + `const vec4 PC_FROM[${nf}] = vec4[${nf}](${from.map(vec4Of).join(", ")});\n`
    + `const vec4 PC_TO[${nt}] = vec4[${nt}](${to.map(vec4Of).join(", ")});\n`;
  /*
   * Distances are compared squared (same ordering as Math.hypot, saving one square root).
   * Subtracting PC_SEQ_EPS is to match sequenceTarget's "pick earlier one on tie": JS computes on
   * float64 while GLSL only has float32, so exactly tied pixels would round in different directions
   * on each side: testing on testsrc2 showed that when from = [#000, #808080, #fff], pixels where
   * r+g+b equals exactly 192 are an exact tie; without this nudge, the later one is selected, causing
   * the entire color block to jump.
   * 1e-6 is chosen: float32 error at the 0~3 magnitude is ~1e-7, while the adjacent non-tied distance
   * difference produced by 8-bit input is at least on the order of 2·v/255 (~4e-3 for grayscale
   * sequences), differing by three orders of magnitude, so it will not cause collateral damage.
   */
  let body = `  int idx = 0;\n  float best = 1e30;\n`
    + `  for (int i = 0; i < ${nf}; i++) {\n`
    + `    vec3 dv = src.rgb - PC_FROM[i].rgb;\n`
    + `    float dd = dot(dv, dv);\n`
    + `    if (dd < best - PC_SEQ_EPS) { best = dd; idx = i; }\n  }\n`;
  if (def.mode === "discrete" || nt === 1) {
    body += `  target = PC_TO[min(idx, ${nt - 1})];\n`;
  } else {
    body += `  float seqP = ${nf === 1 ? "0.0" : `float(idx) / ${glf(nf - 1)}`};\n`
      + `  float seqQ = seqP * ${glf(nt - 1)};\n`
      + `  int i0 = int(clamp(floor(seqQ), 0.0, ${glf(nt - 2)}));\n`
      + `  float seqF = seqQ - float(i0);\n`
      + `  target = PC_TO[i0] + (PC_TO[i0 + 1] - PC_TO[i0]) * seqF;\n`;
  }
  return { decls, body };
}

/**
 * Translates a pixel map into a WebGL2 fragment shader. Pure function, unit-testable.
 *
 * Specs follow mapRgba item-by-item: input is first clamped to 0~1; luma = .2126r + .7152g + .0722b;
 * x / y are column / row divided by frame width / height (y counts from **top** to bottom, matching
 * ImageData row order); t is a uniform; where is clamped to 0~1, returned as-is when 0; continuous
 * blends by w; discrete semantics follow sequenceTarget.
 * lerp → mix, ^ → pow, round → floor(x+0.5), and remaining functions map one-to-one.
 *
 * Returns { fragment, vertex, usesTarget, usesTime, key }.
 */
export function compilePixelMapGlsl(def) {
  if (!def || typeof def !== "object") throw new PixelMapGlslError("A pixel map definition must be an object");
  const where = emitSrc(def.where);
  const seq = def.colorSequence ? sequenceGlsl(def) : null;
  const to = def.to ?? {};
  const sources = [def.where, ...(to.kind === "expr" ? ["r", "g", "b", "a"].map((k) => to[k] ?? k) : [])];
  const usesTime = sources.some((s) => usesOf(s).has("t"));
  let decls = seq ? seq.decls : "";
  let target;
  if (seq) target = seq.body;
  else if (to.kind === "color") {
    const c = parseColor(to.value);
    if (!c) throw new PixelMapGlslError(`to.value "${to.value}" is not a color`);
    target = `  target = ${vec4Of(c)};\n`;
  } else if (to.kind === "transparent") target = `  target = vec4(src.rgb, 0.0);\n`;
  else if (to.kind === "media") target = `  target = uHasTarget ? pc01v(texture(uTarget, uv)) : src;\n`;
  else if (to.kind === "expr") {
    const ch = ["r", "g", "b", "a"].map((k) => `pc01(${emitSrc(to[k] ?? k)})`);
    target = `  target = vec4(${ch.join(", ")});\n`;
  } else throw new PixelMapGlslError(`The form of to "${to.kind ?? "(empty)"}" cannot be translated`);

  const fragment = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uTex;
uniform sampler2D uTarget;
uniform bool uHasTarget;
uniform float uT;
uniform vec2 uSize;
out vec4 fragColor;

// clamp01 of mapRgba: non-finite values count as 0, then clamp to 0~1
float pc01(float v) { if (!(v > 0.0)) return 0.0; return v > 1.0 ? 1.0 : v; }
vec4 pc01v(vec4 v) { return vec4(pc01(v.r), pc01(v.g), pc01(v.b), pc01(v.a)); }
${decls}
void main() {
  float col = gl_FragCoord.x - 0.5;
  float row = uSize.y - gl_FragCoord.y - 0.5;
  vec2 uv = vec2((col + 0.5) / uSize.x, (row + 0.5) / uSize.y);
  vec4 src = pc01v(texture(uTex, uv));
  float r = src.r;
  float g = src.g;
  float b = src.b;
  float a = src.a;
  float luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
  float x = col / uSize.x;
  float y = row / uSize.y;
  float w = pc01(${where});
  if (!(w > 0.0)) { fragColor = src; return; }
  vec4 target;
${target}  fragColor = src * (1.0 - w) + target * w;
}
`;
  return {
    fragment,
    vertex: PIXEL_MAP_VERTEX_GLSL,
    usesTarget: !seq && to.kind === "media",
    usesTime,
    key: hash36(fragment),
  };
}

/* ------------------------------------------------------------------ Lookups in project */

/**
 * Pixel map definition attached to the clip; returns null if not attached, definition was deleted,
 * or disabled on this clip (`clip.pixelMap.off`).
 *
 * Filters and audio effects each have an accessor like this (`filterOfClip`, `audioFxOfClip`);
 * pixel maps previously did not: the video side called find in-place in FrameScene, so whether it
 * was disabled had to be checked separately in multiple places. Consolidated into one place.
 */
export function pixelMapOfClip(project, clip) {
  if (!clip || !clip.pixelMap || !clip.pixelMap.id || clip.pixelMap.off) return null;
  return (project?.pixelMaps || []).find((d) => d.id === clip.pixelMap.id) || null;
}

/** Content hash: program is cached by it (same scheme as svgFilterId in filters) */
export function hash36(text) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// The export page runs the same function inside its Chrome context when it has
// to rasterize a pixel map. Keeping this as an explicit bridge avoids eval and
// keeps the expression parser shared by editor, export and see_frames.
// mapRgba itself no longer enters any render path (per-pixel CPU loop removed entirely, see
// render/pixelMapGl.ts), kept only for unit tests and GPU / CPU comparison.
if (typeof window !== "undefined") window.__pcMapRgba = mapRgba;
