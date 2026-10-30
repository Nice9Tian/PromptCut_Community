/**
 * 滤镜:定义、随时间变化的参数表达式,以及三条合成管线各自要的形状。
 *
 *   预览(MediaLayers)        → cssFilter(resolveOps(...))             CSS filter 字符串
 *   导出(export-compose)     → ffmpegChain + sendcmdScript            ffmpeg 滤镜 + 逐帧改参数
 *   see_frames(vision-compose)→ ffmpegStaticChain(resolveOps(... t))  某一刻的常量滤镜
 *
 * 规则只在这里写一次:三条管线都从 resolveOps() 拿「这一刻每一步的数值」,再各自翻译。
 * 纯 JS(类型在 filters.d.mts),是为了 node 直接跑的服务端合成也能 import。
 *
 * # 为什么是这几种
 *
 * 每一种都要在 CSS 和 ffmpeg 里算出**同一个像素**,否则编辑台看到的和导出的对不上。
 * 这里只收 CSS Filter Effects 规范里有精确矩阵 / 线性公式定义、ffmpeg 又能逐项复刻的:
 *   - brightness / contrast / invert:规范里是 feComponentTransfer 的线性函数 → ffmpeg lutrgb。
 *     实测 lutrgb 和精确公式四舍五入后 256 级逐级一致;colorlevels 会先把黑白点截成整数级,对比度 2.5 时差 2 级;
 *     eq 更不行:它在 YUV 上改亮度(加法)、对比度只动 Y,和 CSS 的 RGB 乘法对不上。
 *   - saturate / hue / grayscale / sepia:规范给了 3×3 矩阵 → ffmpeg colorchannelmixer 逐项填(实测最多差 1 级)。
 *     colorchannelmixer 每项只能在 -2~2,所以 saturate 上限是 2(系数最大 0.072+0.928×2)。
 *   - blur:规范是 stdDeviation = 半径的高斯 → ffmpeg gblur 的 sigma,边缘处理见 ffmpegChain。
 * 每一步单独截断到 0~1,和 Chrome 把每个滤镜函数当一个独立颜色滤镜(各自 clamp)一致。
 *
 * # 时间表达式
 *
 * 参数可以是数字,也可以是一段表达式字符串,例如 "1 + 0.2*sin(t*2*PI)"。
 * 自己写的小语法(不是 eval / Function):只认数字、+ - * / % ^、括号、白名单函数和下面这些变量:
 *   t = 片段内的秒数(从片段开头算,所以同一个滤镜挂到哪段都一样用)
 *   d = 片段时长(秒)   p = t / d(0~1 的进度)   PI、E
 *   以及滤镜自己声明的参数名(params),挂到片段上时可以逐段改值。
 */

/* ------------------------------------------------------------------ 种类 */

export const FILTER_KINDS = {
  brightness: { label: "亮度", min: 0, max: 3, neutral: 1, hint: "1 = 原样,<1 变暗,>1 变亮(乘法)" },
  contrast: { label: "对比度", min: 0, max: 3, neutral: 1, hint: "1 = 原样,>1 拉开明暗,<1 压向中灰" },
  saturate: { label: "饱和度", min: 0, max: 2, neutral: 1, hint: "0 = 无色,1 = 原样,2 = 两倍" },
  hue: { label: "色相", min: -180, max: 180, neutral: 0, unit: "°", hint: "色相旋转角度" },
  grayscale: { label: "黑白", min: 0, max: 1, neutral: 0, hint: "0~1,1 = 完全黑白" },
  sepia: { label: "复古", min: 0, max: 1, neutral: 0, hint: "0~1,老照片的褐色调" },
  invert: { label: "反色", min: 0, max: 1, neutral: 0, hint: "0~1,1 = 负片" },
  blur: { label: "模糊", min: 0, max: 40, neutral: 0, unit: "px", hint: "高斯模糊,单位是片段框内的像素(框缩小了模糊也跟着缩;铺满画面的段就是画布像素)" },
};

/**
 * 查表 / 矩阵类的步骤:整帧调色(曲线、通道混色、按通道偏移)。它们不是一个数,是一张表,所以不走
 * value / 表达式那一套,也不随时间变(要动起来就和上面八种叠着用)。预览走 SVG 滤镜
 * (feComponentTransfer type=table、feColorMatrix —— 合成器在 GPU 上做,不占主线程),导出走
 * lutrgb / colorchannelmixer,两边都是「分段线性 + 每步截到 0~1」,口径一致。
 *
 *   { kind: "curves", rgb?: number[], r?: number[], g?: number[], b?: number[] }
 *       每张表 2~33 个 0~1 的数,均匀铺在输入 0~1 上、点之间线性插值;rgb 是三个通道共用的简写,
 *       单独给的通道优先;没给的通道原样。
 *   { kind: "matrix", values: number[9], offset?: number[3] }
 *       values 行优先 3×3:[rr rg rb  gr gg gb  br bg bb],每个 -4~4;offset 每通道 -1~1,
 *       在混色**截断之后**再加(两边后端同一顺序)。
 */
export const TABLE_KINDS = {
  curves: { label: "曲线", hint: "每通道一张 0~1 的取样表(2~33 点,线性插值);rgb 是三通道共用的简写" },
  matrix: { label: "颜色矩阵", hint: "values 是行优先 3×3 混色矩阵(-4~4),offset 是混色之后每通道再加的量(-1~1)" },
};
export const MAX_TABLE_POINTS = 33;
/** 一个滤镜里最多几步 curves:导出时每步是三条 lutrgb 表达式,太多会把 ffmpeg 的滤镜串撑得很长 */
export const MAX_CURVES_OPS = 4;
const IDENTITY_TABLE = [0, 1];
const IDENTITY_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const isTableKind = (kind) => Object.hasOwn(TABLE_KINDS, kind);

function tableOf(raw, label) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_TABLE_POINTS) throw new FilterExprError(`${label} 要是 2~${MAX_TABLE_POINTS} 个 0~1 的数`);
  return raw.map((v, k) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new FilterExprError(`${label}[${k}] 要在 0~1 之间,收到 ${v}`);
    return round6(v);
  });
}

/** 校验并补齐一步查表 / 矩阵(存进工程的就是补齐后的形状) */
function normalizeTableOp(op, i) {
  if (op.value !== undefined) throw new FilterExprError(`ops[${i}] ${op.kind} 不用 value:curves 给 rgb / r / g / b 表,matrix 给 values(和 offset)`);
  if (op.kind === "curves") {
    const shared = op.rgb === undefined ? null : tableOf(op.rgb, `ops[${i}].rgb`);
    const out = { kind: "curves" };
    let any = !!shared;
    for (const ch of ["r", "g", "b"]) {
      if (op[ch] !== undefined) { out[ch] = tableOf(op[ch], `ops[${i}].${ch}`); any = true; }
      else out[ch] = shared ? [...shared] : [...IDENTITY_TABLE];
    }
    if (!any) throw new FilterExprError(`ops[${i}] curves 至少给 rgb / r / g / b 里的一张表,例:{ "kind": "curves", "rgb": [0, 0.2, 0.55, 0.85, 1] }`);
    return out;
  }
  if (!Array.isArray(op.values) || op.values.length !== 9) throw new FilterExprError(`ops[${i}] matrix 的 values 要是 9 个数(行优先 3×3),原样是 [1,0,0, 0,1,0, 0,0,1]`);
  const values = op.values.map((v, k) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < -4 || v > 4) throw new FilterExprError(`ops[${i}].values[${k}] 要在 -4~4 之间,收到 ${v}`);
    return round6(v);
  });
  let offset = [0, 0, 0];
  if (op.offset !== undefined) {
    if (!Array.isArray(op.offset) || op.offset.length !== 3) throw new FilterExprError(`ops[${i}].offset 要是 3 个数 [r, g, b]`);
    offset = op.offset.map((v, k) => {
      if (typeof v !== "number" || !Number.isFinite(v) || v < -1 || v > 1) throw new FilterExprError(`ops[${i}].offset[${k}] 要在 -1~1 之间,收到 ${v}`);
      return round6(v);
    });
  }
  return { kind: "matrix", values, offset };
}

/**
 * 一张取样表在 0~1 上的值(均匀铺开、线性插值),和 SVG 那边 feFuncR / feFuncG / feFuncB
 * 的 type="table"、导出那边的 tableLutExpr 同一个公式。
 */
export function sampleTable(table, v) {
  const n = table.length - 1;
  if (n <= 0) return table[0] ?? 0;
  const q = clamp(v, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(q));
  return table[i] + (table[i + 1] - table[i]) * (q - i);
}

/**
 * 一步查表 / 矩阵在数值上做什么(输入输出都是 0~1 的 [r, g, b])。
 * 预览的 SVG 滤镜和导出的 lutrgb / colorchannelmixer 都按这个算,像素映射的分类器
 * 拿它核对「等价滤镜」到底等不等价。每一步各自截到 0~1,矩阵的 offset 在混色截断**之后**再加。
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

/** 依次跑完几步查表 / 矩阵(其余种类的步骤原样跳过 —— 分类器只生成这两种) */
export function applyTableOps(ops, rgb) {
  let out = rgb;
  for (const op of ops) if (isTableKind(op.kind)) out = applyTableOp(op, out);
  return out;
}

const sameList = (a, b) => a.length === b.length && a.every((v, k) => v === b[k]);
/** 这一步是不是原样(导出时省掉、预览时不挂滤镜) */
export function isNeutralOp(op) {
  if (op.kind === "curves") return ["r", "g", "b"].every((ch) => sameList(op[ch] ?? IDENTITY_TABLE, IDENTITY_TABLE));
  if (op.kind === "matrix") return sameList(op.values ?? IDENTITY_MATRIX, IDENTITY_MATRIX) && (op.offset ?? [0, 0, 0]).every((v) => v === 0);
  return op.value === FILTER_KINDS[op.kind].neutral;
}

export const MAX_OPS = 12;
export const MAX_PARAMS = 8;
export const MAX_EXPR_LEN = 300;
const MAX_NODES = 200;

/* ------------------------------------------------------------------ 表达式 */

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
  "参数可以写数字,或一段随时间变化的表达式字符串。变量:t = 片段内秒数(从片段开头算),d = 片段时长,p = t/d(0~1 进度)," +
  "以及你在 params 里声明的参数名。运算:+ - * / % ^ 和括号。函数:sin cos tan abs sqrt exp log floor ceil round sign " +
  "min max pow mod clamp(x,lo,hi) lerp(a,b,x) step(edge,x) smoothstep(e0,e1,x)。常量 PI、E。" +
  "例:\"1 + 0.2*sin(t*2*PI)\"(亮度每秒呼吸一次)、\"lerp(0, 8, smoothstep(0, 1, t))\"(模糊在第一秒内慢慢起来)、" +
  "\"p\"(配 grayscale:整段从彩色慢慢褪成黑白)。";

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
    throw new FilterExprError(`第 ${i + 1} 个字符「${c}」不认识`);
  }
  return out;
}

/**
 * 解析成一棵语法树。vars 是允许出现的变量名(t/d/p + 滤镜声明的参数)。
 * 返回 { ast, uses: Set<变量名> }。语法错、未知名字都在这里抛,文案写给模型看。
 *
 * 节点形状(像素映射的分类器和 GLSL 翻译要按形状看,所以是数据不是闭包):
 *   { t: "num", v }                     数字字面量和 PI / E
 *   { t: "var", name }                  变量
 *   { t: "neg", a }                     一元负号
 *   { t: "bin", op: "+-* /%^", a, b }   二元运算
 *   { t: "call", name, args }           白名单函数
 */
export function parseExpr(src, vars = BASE_VARS) {
  if (typeof src !== "string") throw new FilterExprError("表达式要是字符串");
  if (src.length > MAX_EXPR_LEN) throw new FilterExprError(`表达式太长(上限 ${MAX_EXPR_LEN} 字符)`);
  const allowed = new Set(vars);
  const toks = tokenize(src);
  let pos = 0;
  let nodes = 0;
  const uses = new Set();
  const peek = () => toks[pos];
  const eat = (k) => {
    const tk = toks[pos];
    if (!tk || tk.k !== k) throw new FilterExprError(`第 ${tk ? tk.at + 1 : src.length + 1} 个字符附近缺少「${k}」`);
    pos++;
    return tk;
  };
  const node = (n) => {
    if (++nodes > MAX_NODES) throw new FilterExprError("表达式太复杂了");
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
    if (!tk) throw new FilterExprError("表达式不完整");
    if (tk.k === "num") { pos++; return node({ t: "num", v: tk.v }); }
    if (tk.k === "(") { pos++; const inner = add(); eat(")"); return inner; }
    if (tk.k === "id") {
      pos++;
      const name = tk.v;
      // 一律 Object.hasOwn:`name in CONSTS` 会认下 __proto__ / constructor 这类从 Object 继承来的名字
      if (peek() && peek().k === "(") {
        const spec = Object.hasOwn(FUNCS, name) ? FUNCS[name] : null;
        if (!spec) throw new FilterExprError(`没有函数 ${name}(能用的:${Object.keys(FUNCS).join(" ")})`);
        pos++;
        const args = [];
        if (!(peek() && peek().k === ")")) {
          args.push(add());
          while (peek() && peek().k === ",") { pos++; args.push(add()); }
        }
        eat(")");
        const arity = spec[0];
        if (arity > 0 && args.length !== arity) throw new FilterExprError(`${name} 要 ${arity} 个参数,给了 ${args.length} 个`);
        if (arity < 0 && args.length < -arity) throw new FilterExprError(`${name} 至少要 ${-arity} 个参数`);
        return node({ t: "call", name, args });
      }
      if (Object.hasOwn(CONSTS, name)) return node({ t: "num", v: CONSTS[name] });
      if (!allowed.has(name)) {
        throw new FilterExprError(`不认识「${name}」。能用的变量:${[...allowed].join(" ")}(参数名要先在 params 里声明)`);
      }
      uses.add(name);
      return node({ t: "var", name });
    }
    throw new FilterExprError(`第 ${tk.at + 1} 个字符「${tk.k}」放错了地方`);
  };

  const ast = add();
  if (pos < toks.length) throw new FilterExprError(`第 ${toks[pos].at + 1} 个字符开始多出来了`);
  return { ast, uses };
}

/** 语法树 → 求值闭包。形状和 parseExpr 的注释一一对应 */
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
 * 编译成一个求值函数。vars 是允许出现的变量名(t/d/p + 滤镜声明的参数)。
 * 返回 { fn(env) → number, uses: Set<变量名> }。语法错、未知名字都在这里抛,文案写给模型看。
 */
export function compileExpr(src, vars = BASE_VARS) {
  const { ast, uses } = parseExpr(src, vars);
  return { fn: astToFn(ast), uses, ast };
}

/** 白名单函数名与各自的参数个数(负数 = 至少这么多);像素映射翻译 GLSL 时要逐个对上 */
export const FUNC_ARITY = Object.freeze(Object.fromEntries(Object.entries(FUNCS).map(([k, v]) => [k, v[0]])));

const compiled = new Map();
/** 带缓存的 compileExpr(同一条表达式预览每帧都要算) */
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

/* ------------------------------------------------------------------ 定义校验 */

const PARAM_NAME = /^[a-z][A-Za-z0-9_]{0,23}$/;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

/**
 * 自定义参数的声明表 { 名字: { default, min?, max?, label? } | 数字 } 洗成规范形状。
 * 视频滤镜和音频效果(kernel/audioFx.mjs)共用这一份规则,所以导出;extraReserved 是各自不许撞的名字。
 */
export function normalizeParamDecls(rawParams, extraReserved = RESERVED) {
  const params = {};
  const raw = rawParams && typeof rawParams === "object" ? rawParams : {};
  const keys = Object.keys(raw);
  if (keys.length > MAX_PARAMS) throw new FilterExprError(`params 最多 ${MAX_PARAMS} 个`);
  for (const key of keys) {
    if (!PARAM_NAME.test(key) || extraReserved.has(key)) {
      throw new FilterExprError(`参数名「${key}」不行:小写字母开头、只含字母数字下划线,且不能和 ${[...extraReserved].join(" ")} 重名`);
    }
    const r = raw[key];
    const spec = typeof r === "number" ? { default: r } : r && typeof r === "object" ? r : null;
    if (!spec || typeof spec.default !== "number" || !Number.isFinite(spec.default)) throw new FilterExprError(`参数 ${key} 要有数字 default`);
    const min = typeof spec.min === "number" && Number.isFinite(spec.min) ? spec.min : undefined;
    const max = typeof spec.max === "number" && Number.isFinite(spec.max) ? spec.max : undefined;
    if (min !== undefined && max !== undefined && min > max) throw new FilterExprError(`参数 ${key} 的 min 大于 max`);
    if ((min !== undefined && spec.default < min) || (max !== undefined && spec.default > max)) throw new FilterExprError(`参数 ${key} 的 default 超出了 min~max`);
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
 * 把模型 / 界面交来的滤镜定义洗成规范形状,不合规就抛(文案写给模型看)。
 * 返回 { name, description?, params?, ops }(id / createdAt 由调用方加)。
 */
export function normalizeFilterDef(input) {
  if (!input || typeof input !== "object") throw new FilterExprError("滤镜定义要是一个对象");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 30) throw new FilterExprError("name 必填,30 字以内(素材库里显示这个名字)");
  const description = typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, 200) : undefined;

  const params = normalizeParamDecls(input.params, RESERVED);
  const keys = Object.keys(params);
  const vars = [...BASE_VARS, ...keys];

  if (!Array.isArray(input.ops) || input.ops.length === 0) throw new FilterExprError(`ops 至少一步,例:[{ "kind": "brightness", "value": 1.2 }]`);
  if (input.ops.length > MAX_OPS) throw new FilterExprError(`ops 最多 ${MAX_OPS} 步`);
  const ops = input.ops.map((op, i) => {
    const kind = op && op.kind;
    if (isTableKind(kind)) return normalizeTableOp(op, i);
    const spec = Object.hasOwn(FILTER_KINDS, kind) ? FILTER_KINDS[kind] : null;
    if (!spec) throw new FilterExprError(`ops[${i}].kind「${kind}」不认识,只有:${[...Object.keys(FILTER_KINDS), ...Object.keys(TABLE_KINDS)].join(" / ")}`);
    const value = op.value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new FilterExprError(`ops[${i}].value 不是有限数字`);
      if (value < spec.min || value > spec.max) throw new FilterExprError(`ops[${i}] ${kind} 要在 ${spec.min}~${spec.max} 之间,收到 ${value}`);
      return { kind, value };
    }
    if (typeof value !== "string" || !value.trim()) throw new FilterExprError(`ops[${i}].value 要是数字或表达式字符串`);
    try {
      compileExpr(value.trim(), vars);
    } catch (e) {
      throw new FilterExprError(`ops[${i}] ${kind} 的表达式有问题:${e.message}`);
    }
    return { kind, value: value.trim() };
  });

  if (ops.filter((op) => op.kind === "curves").length > MAX_CURVES_OPS) throw new FilterExprError(`curves 最多 ${MAX_CURVES_OPS} 步(几条曲线先合成一张表再给)`);
  const def = { name, ...(description ? { description } : null), ...(keys.length ? { params } : null), ops };
  // 抽几个时刻试算一遍:算出 NaN / 无穷(比如 log(0)、除以 0)当场说,别等到导出
  for (const d of [1, 10]) {
    for (const t of [0, d * 0.37, d]) {
      for (const [i, op] of def.ops.entries()) {
        if (typeof op.value !== "string") continue;
        const v = compiledOf(op.value, vars).fn(envOf(def, undefined, t, d));
        if (!Number.isFinite(v)) throw new FilterExprError(`ops[${i}] ${op.kind} 在 t=${round6(t)}、d=${d} 时算出了 ${v},换个写法(注意除以 0、log(0))`);
      }
    }
  }
  return def;
}

/** 片段上的参数覆盖:只留声明过的键,夹进 min~max。不合法的键直接报错 */
export function normalizeClipParams(def, input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object") throw new FilterExprError("params 要是对象");
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const spec = def.params && Object.hasOwn(def.params, k) ? def.params[k] : null;
    if (!spec) throw new FilterExprError(`滤镜「${def.name}」没有参数 ${k}${def.params ? `(有:${Object.keys(def.params).join(" ")})` : "(它没声明参数)"}`);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new FilterExprError(`参数 ${k} 要是数字`);
    out[k] = clamp(v, spec.min ?? -Infinity, spec.max ?? Infinity);
  }
  return Object.keys(out).length ? out : undefined;
}

/* ------------------------------------------------------------------ 求值 */

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
 * 这一刻每一步的数值。t 是片段内秒数,d 是片段时长。算不出来(NaN)的一步退回中性值,超范围的夹住。
 * 返回 [{ kind, value }],和 def.ops 一一对应(中性的步骤也保留 —— ffmpeg 那边要固定的滤镜结构)。
 */
export function resolveOps(def, clipParams, t, d) {
  const vars = [...BASE_VARS, ...Object.keys(def.params || {})];
  const env = envOf(def, clipParams, t, d);
  return def.ops.map((op) => {
    // 查表 / 矩阵不随时间变,原样带过去(工程文件里存的就是补齐后的形状;手改坏了的按原样算)
    if (isTableKind(op.kind)) {
      if (op.kind === "curves") return { kind: "curves", r: Array.isArray(op.r) ? op.r : IDENTITY_TABLE, g: Array.isArray(op.g) ? op.g : IDENTITY_TABLE, b: Array.isArray(op.b) ? op.b : IDENTITY_TABLE };
      return { kind: "matrix", values: Array.isArray(op.values) && op.values.length === 9 ? op.values : IDENTITY_MATRIX, offset: Array.isArray(op.offset) && op.offset.length === 3 ? op.offset : [0, 0, 0] };
    }
    const spec = FILTER_KINDS[op.kind];
    let v;
    // 表达式来自工程文件,可能是别的版本存的、手改过的(引用了已删掉的参数名):编译失败按中性算,
    // 不能在预览的 render 里抛 —— 那是整个编辑台白屏
    try {
      v = typeof op.value === "number" ? op.value : compiledOf(op.value, vars).fn(env);
    } catch {
      v = spec.neutral;
    }
    if (!Number.isFinite(v)) v = spec.neutral;
    return { kind: op.kind, value: round6(clamp(v, spec.min, spec.max)) };
  });
}

/** 有没有随时间变的步骤(用到 t 或 p)。没有的话导出直接用常量滤镜,不用逐帧发命令 */
export function isAnimated(def) {
  const vars = [...BASE_VARS, ...Object.keys(def.params || {})];
  return def.ops.some((op) => {
    if (typeof op.value !== "string") return false;
    try {
      const { uses } = compiledOf(op.value, vars);
      return uses.has("t") || uses.has("p");
    } catch {
      return false; // 编译不过的表达式按中性算(见 resolveOps),自然也不算动画
    }
  });
}

/** 一句话描述,给界面列表和工具回显用 */
export function describeFilter(def) {
  return def.ops
    .map((op) => {
      if (op.kind === "curves") return `${TABLE_KINDS.curves.label} ${["r", "g", "b"].map((ch) => `${ch}:${(op[ch] ?? IDENTITY_TABLE).length}点`).join(" ")}`;
      if (op.kind === "matrix") return `${TABLE_KINDS.matrix.label}${(op.offset ?? []).some((v) => v !== 0) ? " + 偏移" : ""}`;
      const spec = FILTER_KINDS[op.kind];
      return `${spec.label} ${typeof op.value === "number" ? `${op.value}${spec.unit ?? ""}` : op.value}`;
    })
    .join(" · ");
}

/* ------------------------------------------------------------------ 预览:CSS */

/**
 * CSS filter 字符串。pxScale:画布 1 像素在这个元素的坐标里是多少 CSS 像素(元素本身按画布尺寸布局、
 * 外面整体 transform 缩放时传 1 —— 预览的 MediaLayers 就是这样)。中性的步骤跳过;全是中性返回 ""。
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

/* ------------------------------------------------------------------ 预览:查表 / 矩阵的 SVG 滤镜 */

const fmt = (list) => list.map((v) => round6(v)).join(" ");

/** 同一份内容同一个 id:挂到多少段上文档里都只有一份 <filter> */
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
 * <filter> 里面的内容。color-interpolation-filters 必须是 sRGB:SVG 滤镜缺省在线性光里算,
 * 而 CSS 的滤镜函数和导出那边的 lutrgb / colorchannelmixer 都是直接在 sRGB 数值上算。
 * matrix 的 offset 单独成一步(feComponentTransfer linear),和导出那边「混色截断之后再加」同一顺序。
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
 * 保证当前文档里有这一步的 <filter>,返回它的 id。没有 document(Node 侧算导出链)时只回 id。
 * 定义收在 body 末尾一个 0×0 的 <svg> 里 —— 不在场景根下面,所以不会进 HTML 快照,也不挡命中。
 * 只增不删:一个工程用到的不同表有限,留着比在 render 里做引用计数便宜。
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
  // 只改颜色、不扩边:滤镜区域就是元素自己的框(缺省会往外多算 10%)
  filter.setAttribute("x", "0"); filter.setAttribute("y", "0"); filter.setAttribute("width", "100%"); filter.setAttribute("height", "100%");
  filter.innerHTML = svgFilterMarkup(op);
  host.appendChild(filter);
  return id;
}

/* ------------------------------------------------------------------ 导出 / see_frames:ffmpeg */

/** CSS Filter Effects 规范里的矩阵(行优先 3×3),见 https://drafts.fxtf.org/filter-effects/#FilterFunction */
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
 * 线性映射 out = slope·in + icpt(0~1 上,再截到 0~1)写成 lutrgb 表达式(8 位取值 val)。
 * lutrgb 按每个取值预先算一张表,结果先 (int) 截断再夹进 0~255 —— +0.5 把截断变成四舍五入。
 * 表达式里不能有逗号:sendcmd 用逗号分隔命令。linear 留着给单测对照公式。
 */
function linearLut(slope, icpt) {
  const s = round6(slope);
  const c = round6(icpt * 255 + 0.5);
  const expr = `val*${s}${c < 0 ? "" : "+"}${c}`;
  return { filter: "lutrgb", opts: { r: expr, g: expr, b: expr }, linear: { slope: s, icpt: round6(icpt) } };
}

/**
 * 某一刻的数值 → ffmpeg 滤镜步骤 [{ filter, opts }]。
 * 结构只由种类决定(同一个滤镜不管 t 是多少,步骤的个数和种类都一样),导出逐帧改参数靠这一点。
 * blurScale:画布 1 像素在这条 ffmpeg 链里是多少像素(素材层按缩放后的框尺寸处理时就是框的 scale)。
 */
/**
 * 分段线性表 → lutrgb 表达式(val 是 0~255)。表达式里不能有逗号(sendcmd 和滤镜串都拿逗号当分隔),
 * 所以不用 clip / min / max:写成「首段直线 + 每个拐点一个折页」,max(0, u) = (u + abs(u)) / 2。
 * 末尾 +0.5 同 linearLut(lutrgb 先截断再夹)。斜率没变的拐点省掉,所以直线段多的表很短。
 */
export function tableLutExpr(table) {
  const n = table.length - 1;
  const w = 255 / n;
  const slopeOf = (k) => (table[k + 1] - table[k]) * n; // 输出 0~255 对输入 0~255 的斜率
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
     * 模糊对不到逐像素:Chrome 软件渲染用 Skia 的三次盒式近似,GPU(编辑台预览)又是另一套高斯核。
     * 实测 σ=4、testsrc2 上和 Chrome 软件渲染比:gblur steps=1 最大差 32 级 / 平均 3.6,steps=3 为 18 / 2.1,
     * steps=6 为 14 / 1.6(肉眼看不出差别,差在锐利细节的边上)。三次盒式 boxblur 平均差不多,但 gblur 的 sigma
     * 能用 sendcmd 逐帧改,所以取 gblur steps=6。
     */
    if (kind === "blur") return { filter: "gblur", opts: { sigma: round6(Math.max(0, v * blurScale)), steps: 6 } };
    const m = colorMatrix(kind, v);
    const opts = {};
    MIXER_KEYS.forEach((k, i) => { opts[k] = round6(m[i]); });
    return { filter: "colorchannelmixer", opts };
  });
}

/** 模糊要补的透明边宽:3σ 以外高斯的权重已经小于千分之三 */
export const blurPadOf = (sigma) => Math.max(1, Math.ceil(sigma * 3));

/**
 * 滤镜串:"lutrgb@f0_0=r=...,colorchannelmixer@f0_1=rr=...".
 * tag 给了就给每个实例起名 `<filter>@<tag>_<i>`,导出逐帧发命令时靠名字找到它。
 *
 * 模糊前后要包一层:Chrome 的 blur 在元素边外取的是透明(按预乘颜色算),框的边缘会化成半透明、露出底下;
 * gblur 默认把边上的像素往外复制,边缘是实的。所以先预乘、四周补一圈透明、模糊、裁回、反预乘 ——
 * 和 Chrome 同一个取法。blurPad 是补多宽(逐帧变化时按整段最大的 σ 算,见 sendcmdScript)。
 * 输入要带 alpha(gbrap / rgba)。
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

/** 不随时间变的滤镜:中性的步骤直接省掉,全是中性返回 ""(调用方就不往链上接东西) */
export function ffmpegStaticChain(ops, blurScale = 1) {
  const live = ops.filter((op) => !isNeutralOp(op));
  return live.length ? ffmpegChain(ffmpegStages(live, blurScale)) : "";
}

/**
 * 逐帧改参数的 sendcmd 脚本(交给 `sendcmd=f=<文件>`),以及模糊要补的边宽。
 * frames:[{ ts: 这一帧在 sendcmd 所在位置的流时间(秒), t: 片段内秒数 }],调用方按自己链上的时间基准算好。
 * 每帧一行,把所有步骤的所有参数都发一遍(结构不变,只换数);时间戳往前挪 1/4 帧,免得浮点比较差一点点错过这一帧。
 */
export function sendcmdScript(def, clipParams, d, frames, tag, blurScale = 1, fps = 30) {
  const lead = 0.25 / fps;
  const lines = [];
  let maxSigma = 0;
  // 数值和上一帧一样就不发:慢变化的表达式大部分帧值不变(round6 之后),脚本能小几倍,sendcmd 逐帧扫的区间也少
  let prev = "";
  for (const { ts, t } of frames) {
    const stages = ffmpegStages(resolveOps(def, clipParams, t, d), blurScale);
    const cmds = [];
    stages.forEach((s, i) => {
      if (s.fixed) return; // 查表 / 矩阵不随时间变,建链时给的就是终值,不用逐帧重发
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

/* ------------------------------------------------------------------ 项目里的查找 */

/**
 * 片段挂着的滤镜定义(找不到就 null —— 滤镜被删了,片段按没滤镜画)。
 *
 * **停用(`clip.filter.off`)的按没挂算**:挂载和逐段参数都留着,只是这一段上不生效。
 * 闸门放在这里,预览、导出、ffmpeg 链、缓存签名就都跟着走 —— 各处自己判一遍必然漏。
 */
export function filterOfClip(project, clip) {
  if (!clip || !clip.filter || !clip.filter.id || clip.filter.off) return null;
  return (project.filters || []).find((f) => f.id === clip.filter.id) || null;
}

/** 片段在时间轴时刻 T 的滤镜数值;没挂或找不到定义返回 null */
export function clipFilterOpsAt(project, clip, T) {
  const def = filterOfClip(project, clip);
  if (!def) return null;
  return resolveOps(def, clip.filter.params, T - clip.start, clip.end - clip.start);
}
