/**
 * Filters: definitions, time-varying parameter expressions, and the shapes required by each of the
 * three composition pipelines.
 *
 *   Preview (MediaLayers)       → cssFilter(resolveOps(...))            CSS filter string
 *   Export (export-compose)     → ffmpegChain + sendcmdScript           ffmpeg filter + per-frame param changes
 *   see_frames (vision-compose) → ffmpegStaticChain(resolveOps(... t))  constant filter at a given moment
 *
 * Rules are written only once here: all three pipelines take "the values of each step at this moment"
 * from resolveOps(), then translate them individually.
 * Pure JS (types in filters.d.mts) so server-side composition running directly in Node can also import it.
 *
 * # Why these specific types
 *
 * Every type must compute the **exact same pixel** in CSS and ffmpeg, otherwise what is seen in the
 * editor will not match what is exported.
 * Here we only include those with exact matrix / linear formula definitions in the CSS Filter Effects
 * spec that ffmpeg can clone item-by-item:
 *   - brightness / contrast / invert: linear function of feComponentTransfer in the spec → ffmpeg lutrgb.
 *     In tests, lutrgb and the rounded exact formula match across all 256 levels step-by-step;
 *     colorlevels truncates black/white points to integer levels first, differing by 2 levels at contrast 2.5;
 *     eq is even worse: it changes brightness in YUV (additive) and contrast touches only Y, which
 *     does not match CSS RGB multiplication.
 *   - saturate / hue / grayscale / sepia: spec provides a 3×3 matrix → filled item-by-item in
 *     ffmpeg colorchannelmixer (in tests differs by at most 1 level).
 *     colorchannelmixer items are restricted to -2~2, so the saturate upper limit is 2
 *     (maximum coefficient 0.072+0.928×2).
 *   - blur: spec defines Gaussian with stdDeviation = radius → sigma of ffmpeg gblur; see
 *     ffmpegChain for edge handling.
 * Each step is clamped individually to 0~1, consistent with Chrome treating each filter function
 * as an independent color filter (clamped individually).
 *
 * # Time expressions
 *
 * Parameters can be numbers or expression strings, for example "1 + 0.2*sin(t*2*PI)".
 * Custom lightweight grammar (not eval / Function): recognizes only numbers, + - * / % ^, parentheses,
 * whitelisted functions, and the following variables:
 *   t = seconds within the clip (measured from clip start, so attaching to any clip works identically)
 *   d = clip duration (seconds)   p = t / d (progress from 0~1)   PI, E
 *   and parameter names declared by the filter itself (params), whose values can be modified per clip
 *   when attached to a clip.
 */

/* ------------------------------------------------------------------ Kinds */

export const FILTER_KINDS = {
  brightness: { label: "Brightness", min: 0, max: 3, neutral: 1, hint: "1 = unchanged, <1 darker, >1 brighter (multiplicative)" },
  contrast: { label: "Contrast", min: 0, max: 3, neutral: 1, hint: "1 = unchanged, >1 widens light and dark, <1 pulls toward mid-gray" },
  saturate: { label: "Saturation", min: 0, max: 2, neutral: 1, hint: "0 = colorless, 1 = unchanged, 2 = double" },
  hue: { label: "Hue", min: -180, max: 180, neutral: 0, unit: "°", hint: "Hue rotation angle" },
  grayscale: { label: "Black and white", min: 0, max: 1, neutral: 0, hint: "0~1, 1 = fully black and white" },
  sepia: { label: "Vintage", min: 0, max: 1, neutral: 0, hint: "0~1, brown tone of old photos" },
  invert: { label: "Invert colors", min: 0, max: 1, neutral: 0, hint: "0~1, 1 = negative" },
  blur: { label: "blur", min: 0, max: 40, neutral: 0, unit: "px", hint: "Gaussian blur, in pixels within the clip frame (if the frame shrinks the blur shrinks with it; a clip filling the screen uses canvas pixels)" },
};

/**
 * Lookup table / matrix steps: whole-frame color grading (curves, channel mixing, per-channel offsets).
 * They are tables rather than single numbers, so they do not use the value / expression mechanism and
 * do not vary over time (to animate them, layer them with the eight types above). Preview uses SVG
 * filters (feComponentTransfer type=table, feColorMatrix: compositor runs on GPU without blocking the
 * main thread); export uses lutrgb / colorchannelmixer. Both sides use "piecewise linear + clamp to
 * 0~1 at each step", maintaining consistent behavior.
 *
 *   { kind: "curves", rgb?: number[], r?: number[], g?: number[], b?: number[] }
 *       Each table has 2~33 numbers in 0~1, spread evenly across input 0~1 with linear interpolation
 *       between points; rgb is a shorthand shared by all three channels; individually specified
 *       channels take precedence; unspecified channels remain as-is.
 *   { kind: "matrix", values: number[9], offset?: number[3] }
 *       values is row-major 3×3: [rr rg rb  gr gg gb  br bg bb], each -4~4; offset is -1~1 per channel,
 *       added **after mixing clamp** (both backends follow the same order).
 */
export const TABLE_KINDS = {
  curves: { label: "Curve", hint: "One 0~1 sample table per channel (2~33 points, linear interpolation); rgb is a shorthand shared by all three channels" },
  matrix: { label: "Color matrix", hint: "values is a row-major 3×3 color mixing matrix (-4~4), offset is the amount added to each channel after mixing (-1~1)" },
};
export const MAX_TABLE_POINTS = 33;
/** Max curves steps in a filter: each step is 3 lutrgb expressions on export; too many bloat the ffmpeg chain */
export const MAX_CURVES_OPS = 4;
const IDENTITY_TABLE = [0, 1];
const IDENTITY_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const isTableKind = (kind) => Object.hasOwn(TABLE_KINDS, kind);

function tableOf(raw, label) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_TABLE_POINTS) throw new FilterExprError(`${label} must be 2~${MAX_TABLE_POINTS} numbers in 0~1`);
  return raw.map((v, k) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new FilterExprError(`${label}[${k}] must be between 0 and 1, got ${v}`);
    return round6(v);
  });
}

/** Validate and complete a lookup table / matrix step (stored in the project in its completed shape) */
function normalizeTableOp(op, i) {
  if (op.value !== undefined) throw new FilterExprError(`ops[${i}] ${op.kind} does not use value: curves takes an rgb / r / g / b table, matrix takes values (and offset)`);
  if (op.kind === "curves") {
    const shared = op.rgb === undefined ? null : tableOf(op.rgb, `ops[${i}].rgb`);
    const out = { kind: "curves" };
    let any = !!shared;
    for (const ch of ["r", "g", "b"]) {
      if (op[ch] !== undefined) { out[ch] = tableOf(op[ch], `ops[${i}].${ch}`); any = true; }
      else out[ch] = shared ? [...shared] : [...IDENTITY_TABLE];
    }
    if (!any) throw new FilterExprError(`ops[${i}] curves needs at least one table among rgb / r / g / b, e.g. { "kind": "curves", "rgb": [0, 0.2, 0.55, 0.85, 1] }`);
    return out;
  }
  if (!Array.isArray(op.values) || op.values.length !== 9) throw new FilterExprError(`ops[${i}] matrix values must be 9 numbers (row-major 3×3); the identity is [1,0,0, 0,1,0, 0,0,1]`);
  const values = op.values.map((v, k) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < -4 || v > 4) throw new FilterExprError(`ops[${i}].values[${k}] must be between -4 and 4, got ${v}`);
    return round6(v);
  });
  let offset = [0, 0, 0];
  if (op.offset !== undefined) {
    if (!Array.isArray(op.offset) || op.offset.length !== 3) throw new FilterExprError(`ops[${i}].offset must be 3 numbers [r, g, b]`);
    offset = op.offset.map((v, k) => {
      if (typeof v !== "number" || !Number.isFinite(v) || v < -1 || v > 1) throw new FilterExprError(`ops[${i}].offset[${k}] must be between -1 and 1, got ${v}`);
      return round6(v);
    });
  }
  return { kind: "matrix", values, offset };
}

/**
 * Value of a sample table over 0~1 (evenly spread, linearly interpolated), using the same formula
 * as SVG feFuncR / feFuncG / feFuncB type="table" and tableLutExpr on the export side.
 */
export function sampleTable(table, v) {
  const n = table.length - 1;
  if (n <= 0) return table[0] ?? 0;
  const q = clamp(v, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(q));
  return table[i] + (table[i + 1] - table[i]) * (q - i);
}

/**
 * Numerical operation of a lookup table / matrix step (inputs and outputs are [r, g, b] in 0~1).
 * Both preview SVG filters and export lutrgb / colorchannelmixer calculate using this; the pixel map
 * classifier uses it to verify whether "equivalent filters" are truly equivalent. Each step is
 * clamped to 0~1 individually; the matrix offset is added **after** mixing clamp.
 */
export function applyTableOp(op, rgb) {
  if (op.kind === "curves") {
    return ["r", "g", "b"].map((ch, i) => clamp(sampleTable(op[ch] ?? IDENTITY_TABLE, clamp(rgb[i], 0, 1)), 0, 1));
  }
  const m = op.values ?? IDENTITY_MATRIX;
  const off = op.offset ?? [0, 0, 0];
  const [r, g, b] = [0, 1, 2].map((i) => clamp(rgb[i], 0, 1));
  return [0, 1, 2].map((k) => clamp(clamp(m[k * 3] * r + m[k * 3 + 1] * g + m[k * 3 + 2] * b, 0, 1) + off[k], 0, 1));
}

/** Sequentially run lookup table / matrix steps (other step types skipped as-is: classifier only generates these two) */
export function applyTableOps(ops, rgb) {
  let out = rgb;
  for (const op of ops) if (isTableKind(op.kind)) out = applyTableOp(op, out);
  return out;
}

const sameList = (a, b) => a.length === b.length && a.every((v, k) => v === b[k]);
/** Whether this step is a no-op (omitted during export, no filter attached during preview) */
export function isNeutralOp(op) {
  if (op.kind === "curves") return ["r", "g", "b"].every((ch) => sameList(op[ch] ?? IDENTITY_TABLE, IDENTITY_TABLE));
  if (op.kind === "matrix") return sameList(op.values ?? IDENTITY_MATRIX, IDENTITY_MATRIX) && (op.offset ?? [0, 0, 0]).every((v) => v === 0);
  return op.value === FILTER_KINDS[op.kind].neutral;
}

export const MAX_OPS = 12;
export const MAX_PARAMS = 8;
export const MAX_EXPR_LEN = 300;
const MAX_NODES = 200;

/* ------------------------------------------------------------------ Expressions */

const FUNCS = {
  sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan], abs: [1, Math.abs],
  sqrt: [1, Math.sqrt], exp: [1, Math.exp], log: [1, Math.log], floor: [1, Math.floor],
  ceil: [1, Math.ceil], round: [1, Math.round], sign: [1, Math.sign],
  min: [-2, Math.min], max: [-2, Math.max],
  pow: [2, Math.pow],
  mod: [2, (a, b) => a - b * Math.floor(a / b)],
  clamp: [3, (x, a, b) => Math.min(Math.max(x, a), b)],
  lerp: [3, (a, b, x) => a + (b - a) * x],
  step: [2, (edge, x) => (x < edge ? 0 : 1)],
  smoothstep: [3, (e0, e1, x) => {
    const k = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return k * k * (3 - 2 * k);
  }],
};
const CONSTS = { PI: Math.PI, E: Math.E };
export const BASE_VARS = ["t", "d", "p"];
export const RESERVED = new Set([...BASE_VARS, ...Object.keys(CONSTS), ...Object.keys(FUNCS)]);

export const EXPR_HELP =
  "Parameters can be numbers, or an expression string that varies over time. Variables: t = seconds within the clip (counted from the clip start), d = clip duration, p = t/d (progress, 0~1)," +
  "and the parameter names you declare in params. Operators: + - * / % ^ and parentheses. Functions: sin cos tan abs sqrt exp log floor ceil round sign " +
  "min max pow mod clamp(x,lo,hi) lerp(a,b,x) step(edge,x) smoothstep(e0,e1,x). Constants PI, E." +
  "Examples: \"1 + 0.2*sin(t*2*PI)\" (brightness pulses once per second), \"lerp(0, 8, smoothstep(0, 1, t))\" (blur ramps up slowly over the first second)," +
  "\"p\" (with grayscale: the whole clip slowly fades from color to black and white).";

export class FilterExprError extends Error {}

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) { out.push({ k: "num", v: Number(num[0]), at: i }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ k: "id", v: id[0], at: i }); i += id[0].length; continue; }
    if ("+-*/%^(),".includes(c)) { out.push({ k: c, at: i }); i++; continue; }
    throw new FilterExprError(`Unrecognized character ${c} at position ${i + 1}`);
  }
  return out;
}

/**
 * Parse into an AST. vars are permitted variable names (t/d/p + parameters declared by the filter).
 * Returns { ast, uses: Set<variable name> }. Syntax errors and unknown names are thrown here,
 * with messages written for the model.
 *
 * Node shapes (inspected by shape for pixel map classifier and GLSL translation, so data not closures):
 *   { t: "num", v }                     numeric literals and PI / E
 *   { t: "var", name }                  variables
 *   { t: "neg", a }                     unary minus
 *   { t: "bin", op: "+-* /%^", a, b }   binary operations
 *   { t: "call", name, args }           whitelisted functions
 */
export function parseExpr(src, vars = BASE_VARS) {
  if (typeof src !== "string") throw new FilterExprError("The expression must be a string");
  if (src.length > MAX_EXPR_LEN) throw new FilterExprError(`Expression too long (limit ${MAX_EXPR_LEN} characters)`);
  const allowed = new Set(vars);
  const toks = tokenize(src);
  let pos = 0;
  let nodes = 0;
  const uses = new Set();
  const peek = () => toks[pos];
  const eat = (k) => {
    const tk = toks[pos];
    if (!tk || tk.k !== k) throw new FilterExprError(`Missing "${k}" near character ${tk ? tk.at + 1 : src.length + 1}`);
    pos++;
    return tk;
  };
  const node = (n) => {
    if (++nodes > MAX_NODES) throw new FilterExprError("Expression too complex");
    return n;
  };

  const add = () => {
    let l = mul();
    while (peek() && (peek().k === "+" || peek().k === "-")) {
      const op = toks[pos++].k;
      l = node({ t: "bin", op, a: l, b: mul() });
    }
    return l;
  };
  const mul = () => {
    let l = unary();
    while (peek() && (peek().k === "*" || peek().k === "/" || peek().k === "%")) {
      const op = toks[pos++].k;
      l = node({ t: "bin", op, a: l, b: unary() });
    }
    return l;
  };
  const unary = () => {
    if (peek() && (peek().k === "-" || peek().k === "+")) {
      const neg = toks[pos++].k === "-";
      const a = unary();
      return neg ? node({ t: "neg", a }) : a;
    }
    return power();
  };
  const power = () => {
    const base = atom();
    if (peek() && peek().k === "^") {
      pos++;
      return node({ t: "bin", op: "^", a: base, b: unary() });
    }
    return base;
  };
  const atom = () => {
    const tk = peek();
    if (!tk) throw new FilterExprError("Incomplete expression");
    if (tk.k === "num") { pos++; return node({ t: "num", v: tk.v }); }
    if (tk.k === "(") { pos++; const inner = add(); eat(")"); return inner; }
    if (tk.k === "id") {
      pos++;
      const name = tk.v;
      // Always Object.hasOwn: `name in CONSTS` matches names like __proto__ / constructor inherited from Object
      if (peek() && peek().k === "(") {
        const spec = Object.hasOwn(FUNCS, name) ? FUNCS[name] : null;
        if (!spec) throw new FilterExprError(`No function ${name} (available: ${Object.keys(FUNCS).join(" ")})`);
        pos++;
        const args = [];
        if (!(peek() && peek().k === ")")) {
          args.push(add());
          while (peek() && peek().k === ",") { pos++; args.push(add()); }
        }
        eat(")");
        const arity = spec[0];
        if (arity > 0 && args.length !== arity) throw new FilterExprError(`${name} takes ${arity} arguments, got ${args.length}`);
        if (arity < 0 && args.length < -arity) throw new FilterExprError(`${name} needs at least ${-arity} arguments`);
        return node({ t: "call", name, args });
      }
      if (Object.hasOwn(CONSTS, name)) return node({ t: "num", v: CONSTS[name] });
      if (!allowed.has(name)) {
        throw new FilterExprError(`Unknown "${name}". Available variables: ${[...allowed].join(" ")} (parameter names must be declared in params first)`);
      }
      uses.add(name);
      return node({ t: "var", name });
    }
    throw new FilterExprError(`Character ${tk.k} at position ${tk.at + 1} is misplaced`);
  };

  const ast = add();
  if (pos < toks.length) throw new FilterExprError(`Extra content starting at character ${toks[pos].at + 1}`);
  return { ast, uses };
}

/** AST → evaluation closure. Shapes correspond one-to-one with comments in parseExpr */
export function astToFn(n) {
  if (n.t === "num") { const v = n.v; return () => v; }
  if (n.t === "var") { const name = n.name; return (e) => e[name]; }
  if (n.t === "neg") { const a = astToFn(n.a); return (e) => -a(e); }
  if (n.t === "bin") {
    const a = astToFn(n.a), b = astToFn(n.b);
    switch (n.op) {
      case "+": return (e) => a(e) + b(e);
      case "-": return (e) => a(e) - b(e);
      case "*": return (e) => a(e) * b(e);
      case "/": return (e) => a(e) / b(e);
      case "%": return (e) => FUNCS.mod[1](a(e), b(e));
      default: return (e) => Math.pow(a(e), b(e));
    }
  }
  const f = FUNCS[n.name][1];
  const args = n.args.map(astToFn);
  return (e) => f(...args.map((g) => g(e)));
}

/**
 * Compile into an evaluation function. vars are permitted variable names (t/d/p + filter-declared params).
 * Returns { fn(env) → number, uses: Set<variable name> }. Syntax errors and unknown names are thrown
 * here, with messages written for the model.
 */
export function compileExpr(src, vars = BASE_VARS) {
  const { ast, uses } = parseExpr(src, vars);
  return { fn: astToFn(ast), uses, ast };
}

/** Whitelisted functions and parameter counts (negative = at least this many); matched 1:1 in pixel map GLSL translation */
export const FUNC_ARITY = Object.freeze(Object.fromEntries(Object.entries(FUNCS).map(([k, v]) => [k, v[0]])));

const compiled = new Map();
/** compileExpr with cache (the same expression is evaluated every frame during preview) */
export function compiledOf(src, vars) {
  const key = `${vars.join(",")} ${src}`;
  let c = compiled.get(key);
  if (!c) {
    c = compileExpr(src, vars);
    if (compiled.size > 500) compiled.clear();
    compiled.set(key, c);
  }
  return c;
}

/* ------------------------------------------------------------------ Definition validation */

const PARAM_NAME = /^[a-z][A-Za-z0-9_]{0,23}$/;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

/**
 * Normalize custom parameter declarations { name: { default, min?, max?, label? } | number } into
 * canonical shape. Video filters and audio effects (kernel/audioFx.mjs) share this rule, so it is
 * exported; extraReserved holds names that each must not collide with.
 */
export function normalizeParamDecls(rawParams, extraReserved = RESERVED) {
  const params = {};
  const raw = rawParams && typeof rawParams === "object" ? rawParams : {};
  const keys = Object.keys(raw);
  if (keys.length > MAX_PARAMS) throw new FilterExprError(`params allows at most ${MAX_PARAMS}`);
  for (const key of keys) {
    if (!PARAM_NAME.test(key) || extraReserved.has(key)) {
      throw new FilterExprError(`Parameter name "${key}" is invalid: it must start with a lowercase letter, contain only letters, digits and underscores, and not collide with ${[...extraReserved].join(" ")}`);
    }
    const r = raw[key];
    const spec = typeof r === "number" ? { default: r } : r && typeof r === "object" ? r : null;
    if (!spec || typeof spec.default !== "number" || !Number.isFinite(spec.default)) throw new FilterExprError(`Parameter ${key} needs a numeric default`);
    const min = typeof spec.min === "number" && Number.isFinite(spec.min) ? spec.min : undefined;
    const max = typeof spec.max === "number" && Number.isFinite(spec.max) ? spec.max : undefined;
    if (min !== undefined && max !== undefined && min > max) throw new FilterExprError(`Parameter ${key} has min greater than max`);
    if ((min !== undefined && spec.default < min) || (max !== undefined && spec.default > max)) throw new FilterExprError(`Parameter ${key} has a default outside min~max`);
    params[key] = {
      default: spec.default,
      ...(min !== undefined ? { min } : null),
      ...(max !== undefined ? { max } : null),
      ...(typeof spec.label === "string" && spec.label.trim() ? { label: spec.label.trim().slice(0, 20) } : null),
    };
  }
  return params;
}

/**
 * Normalize filter definitions provided by the model / UI into canonical shape, throwing if invalid
 * (messages written for the model). Returns { name, description?, params?, ops }
 * (id / createdAt added by caller).
 */
export function normalizeFilterDef(input) {
  if (!input || typeof input !== "object") throw new FilterExprError("The filter definition must be an object");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 30) throw new FilterExprError("name is required, max 30 characters (this name is shown in the media library)");
  const description = typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, 200) : undefined;

  const params = normalizeParamDecls(input.params, RESERVED);
  const keys = Object.keys(params);
  const vars = [...BASE_VARS, ...keys];

  if (!Array.isArray(input.ops) || input.ops.length === 0) throw new FilterExprError(`ops needs at least one step, e.g. [{ "kind": "brightness", "value": 1.2 }]`);
  if (input.ops.length > MAX_OPS) throw new FilterExprError(`ops allows at most ${MAX_OPS} steps`);
  const ops = input.ops.map((op, i) => {
    const kind = op && op.kind;
    if (isTableKind(kind)) return normalizeTableOp(op, i);
    const spec = Object.hasOwn(FILTER_KINDS, kind) ? FILTER_KINDS[kind] : null;
    if (!spec) throw new FilterExprError(`ops[${i}].kind "${kind}" is not recognized, only: ${[...Object.keys(FILTER_KINDS), ...Object.keys(TABLE_KINDS)].join(" / ")}`);
    const value = op.value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new FilterExprError(`ops[${i}].value is not a finite number`);
      if (value < spec.min || value > spec.max) throw new FilterExprError(`ops[${i}] ${kind} must be between ${spec.min} and ${spec.max}, got ${value}`);
      return { kind, value };
    }
    if (typeof value !== "string" || !value.trim()) throw new FilterExprError(`ops[${i}].value must be a number or an expression string`);
    try {
      compileExpr(value.trim(), vars);
    } catch (e) {
      throw new FilterExprError(`ops[${i}] ${kind} has an invalid expression: ${e.message}`);
    }
    return { kind, value: value.trim() };
  });

  if (ops.filter((op) => op.kind === "curves").length > MAX_CURVES_OPS) throw new FilterExprError(`curves allows at most ${MAX_CURVES_OPS} steps (merge several curves into one table first)`);
  const def = { name, ...(description ? { description } : null), ...(keys.length ? { params } : null), ops };
  // Sample a few timestamps for trial runs: report NaN / infinity (e.g. log(0), div by 0) immediately, not at export
  for (const d of [1, 10]) {
    for (const t of [0, d * 0.37, d]) {
      for (const [i, op] of def.ops.entries()) {
        if (typeof op.value !== "string") continue;
        const v = compiledOf(op.value, vars).fn(envOf(def, undefined, t, d));
        if (!Number.isFinite(v)) throw new FilterExprError(`ops[${i}] ${op.kind} evaluated to ${v} at t=${round6(t)}, d=${d}; rewrite it (watch for division by 0, log(0))`);
      }
    }
  }
  return def;
}

/** Parameter override on clips: keep only declared keys clamped to min~max. Invalid keys throw an error directly */
export function normalizeClipParams(def, input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object") throw new FilterExprError("params must be an object");
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const spec = def.params && Object.hasOwn(def.params, k) ? def.params[k] : null;
    if (!spec) throw new FilterExprError(`Filter "${def.name}" has no parameter ${k}${def.params ? `(available: ${Object.keys(def.params).join(" ")})` : "(it declares no parameters)"}`);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new FilterExprError(`Parameter ${k} must be a number`);
    out[k] = clamp(v, spec.min ?? -Infinity, spec.max ?? Infinity);
  }
  return Object.keys(out).length ? out : undefined;
}

/* ------------------------------------------------------------------ Evaluation */

function envOf(def, clipParams, t, d) {
  const dd = Math.max(0, Number(d) || 0);
  const tt = clamp(Number(t) || 0, 0, dd || Infinity);
  const env = { t: tt, d: dd, p: dd > 0 ? tt / dd : 0 };
  for (const [k, spec] of Object.entries(def.params || {})) {
    const v = clipParams && typeof clipParams[k] === "number" ? clipParams[k] : spec.default;
    env[k] = clamp(v, spec.min ?? -Infinity, spec.max ?? Infinity);
  }
  return env;
}

/**
 * Values of each step at this moment. t is seconds within the clip, d is clip duration. Steps that
 * cannot be evaluated (NaN) fall back to neutral values; out-of-range values are clamped. Returns
 * [{ kind, value }], matching def.ops one-to-one (neutral steps are also kept: ffmpeg requires a
 * fixed filter structure).
 */
export function resolveOps(def, clipParams, t, d) {
  const vars = [...BASE_VARS, ...Object.keys(def.params || {})];
  const env = envOf(def, clipParams, t, d);
  return def.ops.map((op) => {
    // Lookup tables / matrices are static, passed as-is (project stores completed shape; broken manual edits evaluate as-is)
    if (isTableKind(op.kind)) {
      if (op.kind === "curves") return { kind: "curves", r: Array.isArray(op.r) ? op.r : IDENTITY_TABLE, g: Array.isArray(op.g) ? op.g : IDENTITY_TABLE, b: Array.isArray(op.b) ? op.b : IDENTITY_TABLE };
      return { kind: "matrix", values: Array.isArray(op.values) && op.values.length === 9 ? op.values : IDENTITY_MATRIX, offset: Array.isArray(op.offset) && op.offset.length === 3 ? op.offset : [0, 0, 0] };
    }
    const spec = FILTER_KINDS[op.kind];
    let v;
    // Expressions come from project files, possibly saved by other versions or edited by hand
    // (referencing deleted parameter names): evaluate as neutral on compilation failure; do not throw
    // in preview render, which would blank the entire editor
    try {
      v = typeof op.value === "number" ? op.value : compiledOf(op.value, vars).fn(env);
    } catch {
      v = spec.neutral;
    }
    if (!Number.isFinite(v)) v = spec.neutral;
    return { kind: op.kind, value: round6(clamp(v, spec.min, spec.max)) };
  });
}

/** Whether steps vary over time (using t or p). If not, export uses constant filters directly without per-frame commands */
export function isAnimated(def) {
  const vars = [...BASE_VARS, ...Object.keys(def.params || {})];
  return def.ops.some((op) => {
    if (typeof op.value !== "string") return false;
    try {
      const { uses } = compiledOf(op.value, vars);
      return uses.has("t") || uses.has("p");
    } catch {
      return false; // Expressions that fail to compile evaluate as neutral (see resolveOps), naturally not counting as animation
    }
  });
}

/** One-sentence description, for UI lists and tool echo */
export function describeFilter(def) {
  return def.ops
    .map((op) => {
      if (op.kind === "curves") return `${TABLE_KINDS.curves.label} ${["r", "g", "b"].map((ch) => `${ch}: ${(op[ch] ?? IDENTITY_TABLE).length} points`).join(" ")}`;
      if (op.kind === "matrix") return `${TABLE_KINDS.matrix.label}${(op.offset ?? []).some((v) => v !== 0) ? " + offset" : ""}`;
      const spec = FILTER_KINDS[op.kind];
      return `${spec.label} ${typeof op.value === "number" ? `${op.value}${spec.unit ?? ""}` : op.value}`;
    })
    .join(" · ");
}

/* ------------------------------------------------------------------ Preview: CSS */

/**
 * CSS filter string. pxScale: how many CSS pixels correspond to 1 canvas pixel in this element's
 * coordinates (pass 1 when element itself is laid out at canvas size and scaled by outer transform:
 * this is how preview MediaLayers works). Neutral steps are skipped; returns "" if all are neutral.
 */
export function cssFilter(ops, pxScale = 1) {
  const parts = [];
  for (const op of ops) {
    const { kind, value: v } = op;
    if (isTableKind(kind)) {
      if (!isNeutralOp(op)) parts.push(`url(#${ensureSvgFilter(op)})`);
      continue;
    }
    if (v === FILTER_KINDS[kind].neutral) continue;
    if (kind === "brightness") parts.push(`brightness(${v})`);
    else if (kind === "contrast") parts.push(`contrast(${v})`);
    else if (kind === "saturate") parts.push(`saturate(${v})`);
    else if (kind === "hue") parts.push(`hue-rotate(${v}deg)`);
    else if (kind === "grayscale") parts.push(`grayscale(${v})`);
    else if (kind === "sepia") parts.push(`sepia(${v})`);
    else if (kind === "invert") parts.push(`invert(${v})`);
    else if (kind === "blur") parts.push(`blur(${round6(v * pxScale)}px)`);
  }
  return parts.join(" ");
}

/* ------------------------------------------------------------------ Preview: SVG filters for lookup tables / matrices */

const fmt = (list) => list.map((v) => round6(v)).join(" ");

/** Same content shares the same id: only one <filter> exists in the document regardless of how many clips it is attached to */
export function svgFilterId(op) {
  const text = JSON.stringify(op.kind === "curves" ? [op.r, op.g, op.b] : [op.values, op.offset]);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `pc-f-${op.kind[0]}${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/**
 * Content inside <filter>. color-interpolation-filters must be sRGB: SVG filters calculate in linear
 * light by default, whereas CSS filter functions and export lutrgb / colorchannelmixer calculate
 * directly on sRGB values. Matrix offset is a separate step (feComponentTransfer linear), in the
 * same order as export: "added after mixing clamp".
 */
export function svgFilterMarkup(op) {
  if (op.kind === "curves") {
    return `<feComponentTransfer>${["R", "G", "B"].map((C) => `<feFunc${C} type="table" tableValues="${fmt(op[C.toLowerCase()])}"/>`).join("")}</feComponentTransfer>`;
  }
  const m = op.values;
  const mix = `<feColorMatrix type="matrix" values="${fmt([m[0], m[1], m[2], 0, 0, m[3], m[4], m[5], 0, 0, m[6], m[7], m[8], 0, 0, 0, 0, 0, 1, 0])}"/>`;
  const off = op.offset ?? [0, 0, 0];
  if (off.every((v) => v === 0)) return mix;
  return `${mix}<feComponentTransfer>${["R", "G", "B"].map((C, k) => `<feFunc${C} type="linear" slope="1" intercept="${round6(off[k])}"/>`).join("")}</feComponentTransfer>`;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFS_ID = "pc-filter-defs";

/**
 * Ensure <filter> for this step exists in the current document and return its id. When there is no
 * document (Node side computing export chains), return only the id. Definitions are placed in a 0×0
 * <svg> at the end of body: not under scene root, so they do not enter HTML snapshots or block hit
 * testing. Append-only: projects use limited distinct tables; keeping them is cheaper than reference
 * counting in render.
 */
export function ensureSvgFilter(op, doc = typeof document === "undefined" ? null : document) {
  const id = svgFilterId(op);
  if (!doc || !doc.body || doc.getElementById(id)) return id;
  let host = doc.getElementById(DEFS_ID);
  if (!host) {
    host = doc.createElementNS(SVG_NS, "svg");
    host.setAttribute("id", DEFS_ID);
    host.setAttribute("width", "0");
    host.setAttribute("height", "0");
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none");
    doc.body.appendChild(host);
  }
  const filter = doc.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", id);
  filter.setAttribute("color-interpolation-filters", "sRGB");
  // Only change colors, do not expand bounds: filter region is the element's own box (defaults to 10% outward expansion)
  filter.setAttribute("x", "0"); filter.setAttribute("y", "0"); filter.setAttribute("width", "100%"); filter.setAttribute("height", "100%");
  filter.innerHTML = svgFilterMarkup(op);
  host.appendChild(filter);
  return id;
}

/* ------------------------------------------------------------------ Export / see_frames: ffmpeg */

/** Matrices in CSS Filter Effects specification (row-major 3×3), see https://drafts.fxtf.org/filter-effects/#FilterFunction */
export function colorMatrix(kind, v) {
  if (kind === "saturate") {
    const s = v;
    return [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
  }
  if (kind === "grayscale") {
    const s = 1 - v;
    return [0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s, 0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s, 0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s];
  }
  if (kind === "sepia") {
    const s = 1 - v;
    return [0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s, 0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s, 0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s];
  }
  if (kind === "hue") {
    const a = (v * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    return [
      0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
    ];
  }
  return null;
}

const MIXER_KEYS = ["rr", "rg", "rb", "gr", "gg", "gb", "br", "bg", "bb"];
const LUT_KEYS = ["r", "g", "b"];

/**
 * Linear mapping out = slope·in + icpt (on 0~1, then clamped to 0~1) written as a lutrgb expression
 * (8-bit value val). lutrgb precomputes a table for each value, truncating result to (int) first then
 * clamping into 0~255: +0.5 turns truncation into rounding. No commas allowed in expressions:
 * sendcmd separates commands with commas. linear is retained for unit tests to verify the formula.
 */
function linearLut(slope, icpt) {
  const s = round6(slope);
  const c = round6(icpt * 255 + 0.5);
  const expr = `val*${s}${c < 0 ? "" : "+"}${c}`;
  return { filter: "lutrgb", opts: { r: expr, g: expr, b: expr }, linear: { slope: s, icpt: round6(icpt) } };
}

/**
 * Values at a given moment → ffmpeg filter steps [{ filter, opts }].
 * Structure is determined solely by type (for the same filter regardless of t, step count and types
 * remain identical); export relies on this to update parameters per frame.
 * blurScale: how many pixels correspond to 1 canvas pixel in this ffmpeg chain (when an asset layer
 * is processed at scaled box size, this is the box scale).
 */
/**
 * Piecewise linear table → lutrgb expression (val is 0~255). No commas allowed in expressions
 * (sendcmd and filter chains both use commas as delimiters), so clip / min / max are avoided: written
 * as "initial straight segment + one ramp per inflection point", max(0, u) = (u + abs(u)) / 2.
 * Trailing +0.5 matches linearLut (lutrgb truncates before clamping). Inflection points where slope
 * does not change are omitted, so tables with many straight segments remain very short.
 */
export function tableLutExpr(table) {
  const n = table.length - 1;
  const w = 255 / n;
  const slopeOf = (k) => (table[k + 1] - table[k]) * n; // Slope of output 0~255 relative to input 0~255
  const signed = (c, body) => (c === 0 ? "" : `${c < 0 ? "-" : "+"}${Math.abs(c)}${body}`);
  let expr = String(round6(table[0] * 255 + 0.5)) + signed(round6(slopeOf(0)), "*val");
  for (let k = 1; k < n; k++) {
    const x = round6(k * w);
    expr += signed(round6((slopeOf(k) - slopeOf(k - 1)) / 2), `*(val-${x}+abs(val-${x}))`);
  }
  return expr;
}

export function ffmpegStages(ops, blurScale = 1) {
  return ops.flatMap((op) => {
    const { kind, value: v } = op;
    if (kind === "curves") return [{ filter: "lutrgb", fixed: true, opts: { r: tableLutExpr(op.r), g: tableLutExpr(op.g), b: tableLutExpr(op.b) } }];
    if (kind === "matrix") {
      const opts = {};
      MIXER_KEYS.forEach((k, i) => { opts[k] = round6(op.values[i]); });
      const stages = [{ filter: "colorchannelmixer", fixed: true, opts }];
      const off = op.offset ?? [0, 0, 0];
      if (off.some((x) => x !== 0)) {
        const add = (x) => { const c = round6(x * 255 + 0.5); return `val${c < 0 ? "" : "+"}${c}`; };
        stages.push({ filter: "lutrgb", fixed: true, opts: { r: add(off[0]), g: add(off[1]), b: add(off[2]) } });
      }
      return stages;
    }
    if (kind === "brightness") return linearLut(v, 0);
    if (kind === "contrast") return linearLut(v, 0.5 - 0.5 * v);
    if (kind === "invert") return linearLut(1 - 2 * v, v);
    /*
     * Blur cannot match pixel-by-pixel: Chrome software rendering uses Skia's triple box approximation,
     * while GPU (editor preview) uses another set of Gaussian kernels. In tests with σ=4 on testsrc2
     * compared to Chrome software rendering: gblur steps=1 max diff 32 levels / avg 3.6, steps=3 is
     * 18 / 2.1, steps=6 is 14 / 1.6 (imperceptible to the naked eye, differences lie along sharp detail
     * edges). Triple box blur boxblur is similar on average, but gblur's sigma can be modified per frame
     * using sendcmd, so gblur steps=6 is chosen.
     */
    if (kind === "blur") return { filter: "gblur", opts: { sigma: round6(Math.max(0, v * blurScale)), steps: 6 } };
    const m = colorMatrix(kind, v);
    const opts = {};
    MIXER_KEYS.forEach((k, i) => { opts[k] = round6(m[i]); });
    return { filter: "colorchannelmixer", opts };
  });
}

/** Transparent padding width needed for blur: Gaussian weight beyond 3σ is already below 0.3% */
export const blurPadOf = (sigma) => Math.max(1, Math.ceil(sigma * 3));

/**
 * Filter chain: "lutrgb@f0_0=r=...,colorchannelmixer@f0_1=rr=...".
 * When tag is provided, names each instance `<filter>@<tag>_<i>`; export finds it by name when
 * sending per-frame commands.
 *
 * Blur needs to be wrapped before and after: Chrome's blur samples transparent outside element bounds
 * (using premultiplied colors), dissolving box edges into semitransparency and revealing what lies
 * beneath; gblur duplicates edge pixels outward by default, leaving solid edges. Therefore:
 * premultiply first, pad transparent borders around, blur, crop back, un-premultiply: identical to
 * Chrome's approach. blurPad is padding width (calculated from maximum σ across entire clip when
 * varying per frame; see sendcmdScript). Input must include alpha (gbrap / rgba).
 */
export function ffmpegChain(stages, tag, blurPad) {
  return stages
    .map((s, i) => {
      const name = tag ? `${s.filter}@${tag}_${i}` : s.filter;
      const body = `${name}=${Object.entries(s.opts).map(([k, v]) => `${k}=${v}`).join(":")}`;
      if (s.filter !== "gblur") return body;
      const P = blurPad ?? blurPadOf(s.opts.sigma);
      return `premultiply=inplace=1,pad=iw+${2 * P}:ih+${2 * P}:${P}:${P}:color=black@0,${body},crop=iw-${2 * P}:ih-${2 * P}:${P}:${P},unpremultiply=inplace=1`;
    })
    .join(",");
}

/** Static filters: neutral steps are omitted directly; returns "" if all are neutral (caller attaches nothing to chain) */
export function ffmpegStaticChain(ops, blurScale = 1) {
  const live = ops.filter((op) => !isNeutralOp(op));
  return live.length ? ffmpegChain(ffmpegStages(live, blurScale)) : "";
}

/**
 * sendcmd script for updating parameters per frame (passed to `sendcmd=f=<file>`), and padding width
 * needed for blur.
 * frames: [{ ts: stream time (seconds) of this frame at sendcmd position, t: seconds within clip }],
 * caller calculates based on its own chain timebase.
 * One line per frame, sending all parameters for all steps (structure unchanged, only numbers swapped);
 * timestamps shifted forward by 1/4 frame so tiny floating-point discrepancies do not miss the frame.
 */
export function sendcmdScript(def, clipParams, d, frames, tag, blurScale = 1, fps = 30) {
  const lead = 0.25 / fps;
  const lines = [];
  let maxSigma = 0;
  // Skip sending if values match previous frame: slowly changing expressions stay identical across
  // most frames (after round6), shrinking the script several-fold and narrowing sendcmd scan intervals
  let prev = "";
  for (const { ts, t } of frames) {
    const stages = ffmpegStages(resolveOps(def, clipParams, t, d), blurScale);
    const cmds = [];
    stages.forEach((s, i) => {
      if (s.fixed) return; // Lookup tables / matrices do not vary over time; final values are provided when building the chain, without needing per-frame resending
      const name = `${s.filter}@${tag}_${i}`;
      const keys = s.filter === "colorchannelmixer" ? MIXER_KEYS : s.filter === "lutrgb" ? LUT_KEYS : ["sigma"];
      for (const k of keys) cmds.push(`${name} ${k} ${s.opts[k]}`);
      if (s.filter === "gblur") maxSigma = Math.max(maxSigma, s.opts.sigma);
    });
    const body = cmds.join(", ");
    if (body === prev) continue;
    prev = body;
    lines.push(`${round6(Math.max(0, ts - lead))} ${body};`);
  }
  return { script: lines.join("\n") + "\n", blurPad: blurPadOf(maxSigma) };
}

/* ------------------------------------------------------------------ Lookups in project */

/**
 * Filter definition attached to a clip (null if not found: filter was deleted, clip rendered
 * without filters).
 *
 * **Disabled (`clip.filter.off`) counts as unattached**: attachment and per-clip parameters are
 * preserved, but do not take effect on this clip.
 * The gate is placed here so preview, export, ffmpeg chain, and cache signatures all follow:
 * checking individually everywhere would inevitably miss cases.
 */
export function filterOfClip(project, clip) {
  if (!clip || !clip.filter || !clip.filter.id || clip.filter.off) return null;
  return (project.filters || []).find((f) => f.id === clip.filter.id) || null;
}

/** Filter values for a clip at timeline moment T; returns null if not attached or definition not found */
export function clipFilterOpsAt(project, clip, T) {
  const def = filterOfClip(project, clip);
  if (!def) return null;
  return resolveOps(def, clip.filter.params, T - clip.start, clip.end - clip.start);
}
