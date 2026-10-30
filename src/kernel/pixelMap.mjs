/**
 * 通用像素映射的纯内核。
 *
 * 这里故意不接 DOM、Canvas 或 ffmpeg：定义和表达式在编辑器、see_frames、导出
 * 之间共用，具体渲染器只需要调用 mapRgba。表达式复用滤镜里的安全解析器，绝不
 * 使用 eval / Function。
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
  if (!raw || typeof raw !== "object") throw new FilterExprError(`${label} 要是素材、颜色、transparent 或表达式对象`);
  const stage = raw.stage ?? "origin";
  if (!PIXEL_MAP_STAGES.includes(stage)) throw new FilterExprError(`${label}.stage 只能是 origin 或 after_filters`);
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
      if (typeof out[k] !== "string" || !out[k].trim()) throw new FilterExprError(`${label}.${k} 要是表达式`);
      try { compiledOf(out[k].trim(), PIXEL_VARS); } catch (e) { throw new FilterExprError(`${label}.${k} 表达式有问题:${e.message}`); }
    }
    return out;
  }
  throw new FilterExprError(`${label} 写法不认识`);
}

function sequenceOf(raw) {
  if (raw == null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SEQUENCE) throw new FilterExprError(`colorSequence 要是 1~${MAX_SEQUENCE} 个颜色`);
  const out = raw.map((v, i) => {
    const c = parseColor(v);
    if (!c) throw new FilterExprError(`colorSequence[${i}] 不是颜色`);
    return String(v).trim();
  });
  return out;
}

export function normalizePixelMapDef(input) {
  if (!input || typeof input !== "object") throw new FilterExprError("像素映射定义要是一个对象");
  const name = str(input.name);
  if (!name || name.length > 40) throw new FilterExprError("name 必填,40 字以内");
  const where = str(input.where);
  if (!where) throw new FilterExprError("where 必填:用 r/g/b/a/luma/x/y/t 写选区权重");
  try { compiledOf(where, PIXEL_VARS); } catch (e) { throw new FilterExprError(`where 表达式有问题:${e.message}`); }
  const source = input.source == null ? { stage: "origin" } : input.source;
  if (!source || typeof source !== "object") throw new FilterExprError("source 要是对象");
  const stage = source.stage ?? "origin";
  if (!PIXEL_MAP_STAGES.includes(stage)) throw new FilterExprError("source.stage 只能是 origin 或 after_filters");
  const to = input.to == null && input.colorSequence?.to?.length
    ? { kind: "color", value: String(input.colorSequence.to[input.colorSequence.to.length - 1]) }
    : sourceOf(input.to, "to");
  const mode = input.mode ?? "continuous";
  if (!PIXEL_MAP_MODES.includes(mode)) throw new FilterExprError("mode 只能是 continuous 或 discrete");
  const from = sequenceOf(input.colorSequence?.from);
  const seqTo = sequenceOf(input.colorSequence?.to);
  if ((from && !seqTo) || (!from && seqTo)) throw new FilterExprError("colorSequence 要同时提供 from 和 to");
  if (from && seqTo && to.kind !== "color") throw new FilterExprError("colorSequence 不需要 to,或 to 只能留空");
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

/** 将一个 0~1 RGBA 像素映射成新像素。媒体目标由渲染器提供 targetRgba。 */
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

/* ================================================================== 分类:A 整帧调色 / B 逐像素 / C 翻译不了 */

/**
 * 像素映射有三条去向(见 docs/archive/restructure_planning/render_pipeline_restructure.md 3.9):
 *
 *   A 整帧调色  where 恒定、to 只是颜色到颜色的函数 → 等价于一串 curves / matrix 滤镜步骤。
 *              这种活交给 create_filter:预览走 SVG 滤镜、导出走 lutrgb / colorchannelmixer,
 *              两边都在 GPU 合成器上做,不占每拍预算。工具据此**拒绝**并回一份现成的 ops。
 *   B 逐像素    where 引用颜色 / x / y / t 做选区,或 to 是 transparent、另一段素材、通道互相
 *              依赖的非线性表达式 → 只能逐像素算,走 compilePixelMapGlsl 的 WebGL 后端。
 *   C 翻译不了  表达式里有 GLSL 没有对应物的写法 → 拒绝,并指出是哪一处。
 *
 * A 的判据不只看形状:形状对上之后还要**逐值核对**等价滤镜和 mapRgba 算出来的是不是同一个
 * 像素(0~255 全值域,差 ≤ 1 级)。核不过就当 B —— 比如 step() 这种阶跃函数,33 点的取样表
 * 表示不了;又比如颜色序列本质是「按最近邻取色」的阶梯函数。这样「判了 A 就一定能换」是
 * 有保证的,不靠人肉推演。
 */

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const CURVE_POINTS = MAX_TABLE_POINTS;
const LINEAR_VARS = ["r", "g", "b", "luma"];

const astOf = (v) => typeof v === "number" ? { t: "num", v } : parseExpr(String(v), PIXEL_VARS).ast;
const usesOf = (v) => typeof v === "number" ? new Set() : parseExpr(String(v), PIXEL_VARS).uses;
const envOf = (r, g, b, a = 1, x = 0, y = 0, t = 0) => ({ r, g, b, a, luma: r * 0.2126 + g * 0.7152 + b * 0.0722, x, y, t });
/** 只放一个通道有值的 env:每通道只依赖自己的表达式用它取样 */
const chanEnv = (ch, v) => envOf(ch === "r" ? v : 0, ch === "g" ? v : 0, ch === "b" ? v : 0);

/** where 是不是恒定;是就回它的常数值(已夹到 0~1),否则回 null */
function constWhere(def) {
  const { uses } = parseExpr(def.where, PIXEL_VARS);
  if (uses.size) return null;
  return clamp01(compiledOf(def.where, PIXEL_VARS).fn(envOf(0, 0, 0)));
}

/** to.a 是不是恒等(等价滤镜动不了 alpha,所以不恒等就不能判 A) */
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

/** 每通道只依赖自己 → 一步 curves(33 点取样;where 的常数权重折进表里) */
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

/** r/g/b 的线性组合(luma 也是线性的) → 一步 matrix;系数用基向量探出来,准不准由逐值核对说了算 */
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

/** 整帧换成一种颜色 = 把原色按 1-w 压住、再加 w 倍的目标色 */
function colorCandidate(def, w) {
  const c = parseColor(def.to.value);
  if (!c || c[3] !== 1) return null;
  const values = [1 - w, 0, 0, 0, 1 - w, 0, 0, 0, 1 - w].map(round6);
  const offset = [0, 1, 2].map((i) => round6(c[i] * w));
  if (offset.some((v) => v < -1 || v > 1)) return null;
  return [{ kind: "matrix", values, offset }];
}

/**
 * 颜色序列:from 全是灰阶时,取色只由 r/g/b 的**算术平均**决定(sequenceTarget 用的是 RGB
 * 欧氏最近邻,到灰点 (v,v,v) 的距离在 v = 均值时最小 —— 不是 0.2126/0.7152/0.0722 那套亮度权重)。
 * 于是等价物 = 一步把均值铺到三个通道的 matrix + 一步查表。w 必须是 1:混合会用到原色,
 * 而 matrix 那一步已经把原色抹掉了。
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

/** 逐值核对的取样点:256 级灰阶 + 每通道 256 级(另两通道 0 / 0.5 / 1)+ 33³ 网格 */
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

/** 等价滤镜和 mapRgba 在不透明像素上最多差几级(0~255) */
export function pixelMapOpsDiff(def, ops, samples = verifySamples()) {
  let worst = 0;
  for (const rgb of samples) {
    const ref = mapRgba(def, [rgb[0], rgb[1], rgb[2], 1]);
    if (Math.round(ref[3] * 255) !== 255) return 255; // 等价滤镜动不了 alpha
    const got = applyTableOps(ops, rgb);
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(Math.round(ref[k] * 255) - Math.round(got[k] * 255));
      if (d > worst) { worst = d; if (worst > 8) return worst; }
    }
  }
  return worst;
}

/** A 类的等价滤镜步骤;判不了 A 时回 { why } 说明卡在哪 */
function flatColorOps(def) {
  const w = constWhere(def);
  if (w === null) {
    const used = [...parseExpr(def.where, PIXEL_VARS).uses].join(" ");
    return { why: `where 引用了 ${used},是逐像素选区` };
  }
  const to = def.to ?? {};
  let candidates = [];
  let shapeWhy = "";
  if (def.colorSequence) {
    candidates = [sequenceCandidate(def, w)];
    shapeWhy = w !== 1
      ? "colorSequence 配上不是 1 的 where:混合要用到原色,而整帧调色那一步已经把原色抹掉了"
      : "colorSequence 的 from 不全是灰阶(取色是 RGB 最近邻,不是按一个标量查表),或 to 里有半透明色";
  } else if (to.kind === "expr") {
    if (!alphaIsIdentity(def)) return { why: "to.a 会改 alpha,曲线 / 矩阵做不到" };
    candidates = [curvesCandidate(def, w), matrixCandidate(def, w)];
    shapeWhy = "to 的通道之间互相依赖:既不是每通道只依赖自己(曲线),也不是 r/g/b 的线性组合(矩阵)";
  } else if (to.kind === "color") {
    candidates = [colorCandidate(def, w)];
    shapeWhy = "to 是半透明颜色,曲线 / 矩阵改不了 alpha";
  } else if (to.kind === "transparent") return { why: "to 是 transparent,曲线 / 矩阵改不了 alpha" };
  else if (to.kind === "media") return { why: "to 是另一段素材,要逐像素取第二张纹理" };
  else return { why: `to 的写法「${to.kind ?? "(空)"}」不是整帧调色` };

  let worstSeen = Infinity;
  for (const ops of candidates) {
    if (!ops) continue;
    let checked;
    try { checked = normalizeFilterDef({ name: def.name || "调色", ops }).ops; } catch { continue; }
    const diff = pixelMapOpsDiff(def, checked);
    if (diff <= 1) return { ops: checked, diff, w };
    worstSeen = Math.min(worstSeen, diff);
  }
  if (!Number.isFinite(worstSeen)) return { why: shapeWhy };
  return { why: `形状像整帧调色,但取样成曲线 / 矩阵之后逐值差到 ${worstSeen} 级(>1),表示不了,只能逐像素算` };
}

/**
 * 给一条(已 normalize 的)像素映射定性。返回:
 *   { kind: "A", ops, filter, diff, reason, alphaNote? }  整帧调色:ops 可以直接交给 create_filter
 *   { kind: "B", backend: "webgl", reason, usesTarget }   逐像素:接单,走 WebGL 后端
 *   { kind: "C", reason }                                 翻译不了
 */
export function classifyPixelMap(def) {
  const flat = flatColorOps(def);
  if (flat.ops) {
    const alphaNote = def.to?.kind === "expr"
      ? undefined
      : "等价滤镜只改 RGB;原定义在半透明像素上还会把 alpha 一并推向目标色,素材不透明时两者一致。";
    return {
      kind: "A",
      reason: "这是整帧调色:where 是个常数,to 只是颜色到颜色的函数,等价于一串 curves / matrix 滤镜步骤。",
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

/* ================================================================== GLSL 后端 */

export class PixelMapGlslError extends FilterExprError {}

/** 解析器的函数集 → GLSL。名字一样的在这里,不一样的在 emitCall 里单独处理 */
const GLSL_FUNCS = {
  sin: "sin", cos: "cos", tan: "tan", abs: "abs", sqrt: "sqrt", exp: "exp", log: "log",
  floor: "floor", ceil: "ceil", sign: "sign", min: "min", max: "max", mod: "mod", clamp: "clamp",
};

function glf(v) {
  if (!Number.isFinite(v)) throw new PixelMapGlslError(`表达式里出现了 ${v},翻译不了`);
  const s = String(v);
  return /[.e]/i.test(s) ? s : `${s}.0`;
}

const literalInt = (n) => n.t === "num" && Number.isInteger(n.v) ? n.v
  : n.t === "neg" && n.a.t === "num" && Number.isInteger(n.a.v) ? -n.a.v : null;
const isEvenIntLiteral = (n) => { const k = literalInt(n); return k !== null && k % 2 === 0; };

/**
 * 保守判断一棵子树恒不为负。GLSL 的 pow 在底数为负时无定义,而 JS 的 Math.pow 对负底数 +
 * 整数指数是有定义的,所以两边对不上的写法要当场说翻译不了(C 类)。
 * 像素映射的变量 r g b a luma x y 都在 0~1,t 是片段内秒数、不为负,所以变量一律算非负。
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
    throw new PixelMapGlslError(`「${emitExpr(aNode)} ^ ${B}」翻译不了:底数可能是负数,而 GLSL 的 pow 在底数为负时无定义。把底数包进 abs(),或把指数写成整数常量`);
  }
  if (k === 0) return "1.0";
  return k % 2 === 0 ? `pow(abs(${A}), ${B})` : `(sign(${A}) * pow(abs(${A}), ${B}))`;
}

function emitCall(n) {
  const a = n.args.map(emitExpr);
  if (n.name === "pow") return emitPow(n.args[0], n.args[1]);
  // GLSL 的 round() 在正好 .5 时往哪边取由实现决定;Math.round 恒为向上,floor(x+0.5) 和它逐值一致
  if (n.name === "round") return `floor((${a[0]}) + 0.5)`;
  if (n.name === "lerp") return `mix(${a[0]}, ${a[1]}, ${a[2]})`;
  if (n.name === "min" || n.name === "max") return a.reduce((l, r) => `${n.name}(${l}, ${r})`);
  if (n.name === "step" || n.name === "smoothstep" || n.name === "clamp") return `${n.name}(${a.join(", ")})`;
  const g = Object.hasOwn(GLSL_FUNCS, n.name) ? GLSL_FUNCS[n.name] : null;
  if (!g) throw new PixelMapGlslError(`函数 ${n.name}() 在 GLSL 里没有对应物,翻译不了`);
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
  throw new PixelMapGlslError(`表达式里有翻译不了的节点「${n?.t}」`);
}

const emitSrc = (v) => emitExpr(astOf(v));
const vec4Of = (c) => `vec4(${c.map(glf).join(", ")})`;

export const PIXEL_MAP_VERTEX_GLSL = `#version 300 es
// 三个顶点铺满整个视口,不用顶点缓冲
void main() {
  float u = float((gl_VertexID << 1) & 2);
  float v = float(gl_VertexID & 2);
  gl_Position = vec4(u * 2.0 - 1.0, v * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** 颜色序列那一段:最近邻找下标,再按 mode 取色 / 插值。和 sequenceTarget 逐句对应 */
function sequenceGlsl(def) {
  const from = def.colorSequence.from.map(parseColor);
  const to = def.colorSequence.to.map(parseColor);
  const nf = from.length, nt = to.length;
  const decls = `const float PC_SEQ_EPS = 1e-6;\n`
    + `const vec4 PC_FROM[${nf}] = vec4[${nf}](${from.map(vec4Of).join(", ")});\n`
    + `const vec4 PC_TO[${nt}] = vec4[${nt}](${to.map(vec4Of).join(", ")});\n`;
  /*
   * 距离比的是平方(和 Math.hypot 的大小顺序一样,少一次开方)。减 PC_SEQ_EPS 是为了对上
   * sequenceTarget 的「并列时取靠前那个」:JS 在 float64 上算,GLSL 只有 float32,正好并列的
   * 像素两边会各自往不同方向舍入 —— 实测 testsrc2 上 from = [#000, #808080, #fff] 时
   * r+g+b 恰好等于 192 的像素就是精确并列,不加这一下会选到后一个、整块颜色跳掉。
   * 取 1e-6:float32 在 0~3 这个量级的误差约 1e-7,而 8 位输入能产生的相邻非并列距离差
   * 至少是 2·v/255 量级(灰阶序列约 4e-3),差着三个数量级,不会误伤。
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
 * 把一条像素映射翻译成 WebGL2 的片元着色器。纯函数、可单测。
 *
 * 口径逐条照 mapRgba:输入先夹到 0~1;luma = .2126r + .7152g + .0722b;x / y 是列 / 行除以
 * 画面宽 / 高(y 从**上**往下数,和 ImageData 的行序一致);t 是 uniform;where 夹到 0~1,
 * 为 0 时原样返回;continuous 按 w 混合;discrete 的语义照 sequenceTarget。
 * lerp → mix、^ → pow、round → floor(x+0.5),其余函数一一对应。
 *
 * 返回 { fragment, vertex, usesTarget, usesTime, key }。
 */
export function compilePixelMapGlsl(def) {
  if (!def || typeof def !== "object") throw new PixelMapGlslError("像素映射定义要是一个对象");
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
    if (!c) throw new PixelMapGlslError(`to.value「${to.value}」不是颜色`);
    target = `  target = ${vec4Of(c)};\n`;
  } else if (to.kind === "transparent") target = `  target = vec4(src.rgb, 0.0);\n`;
  else if (to.kind === "media") target = `  target = uHasTarget ? pc01v(texture(uTarget, uv)) : src;\n`;
  else if (to.kind === "expr") {
    const ch = ["r", "g", "b", "a"].map((k) => `pc01(${emitSrc(to[k] ?? k)})`);
    target = `  target = vec4(${ch.join(", ")});\n`;
  } else throw new PixelMapGlslError(`to 的写法「${to.kind ?? "(空)"}」翻译不了`);

  const fragment = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uTex;
uniform sampler2D uTarget;
uniform bool uHasTarget;
uniform float uT;
uniform vec2 uSize;
out vec4 fragColor;

// mapRgba 的 clamp01:非有限数按 0 算,再夹进 0~1
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

/* ------------------------------------------------------------------ 项目里的查找 */

/**
 * 片段挂着的像素映射定义;没挂、定义被删了、或者这一段上停用了(`clip.pixelMap.off`)都给 null。
 *
 * 滤镜和音频效果各有一个这样的口(`filterOfClip`、`audioFxOfClip`),像素映射原先没有 ——
 * 画面那边是在 FrameScene 里就地 find 的,所以停用这件事要多处各判一遍。收成一处。
 */
export function pixelMapOfClip(project, clip) {
  if (!clip || !clip.pixelMap || !clip.pixelMap.id || clip.pixelMap.off) return null;
  return (project?.pixelMaps || []).find((d) => d.id === clip.pixelMap.id) || null;
}

/** 内容哈希:program 按它缓存(和 filters 的 svgFilterId 同一套) */
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
// mapRgba 本身不再进任何渲染路径(逐像素 CPU 循环已整体删除,见 render/pixelMapGl.ts),
// 只留给单测和 GPU / CPU 对照用。
if (typeof window !== "undefined") window.__pcMapRgba = mapRgba;
