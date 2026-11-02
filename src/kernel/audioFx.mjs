/**
 * 音频效果:定义、随时间变化的参数表达式,以及预览 / 导出共用的数值。
 *
 * 和 kernel/filters.mjs(视频滤镜)一个路数:效果是项目级的库(project.audioFx),片段用 clip.audioFx 引用;
 * 参数可以写表达式(t / d / p + 自定义参数),规则只在这里写一次。
 *
 * # 为什么两条管线都是 Web Audio
 *
 * 视频滤镜要在 CSS 和 ffmpeg 里各实现一遍、逐像素对齐(见 filters.mjs 头注释)。声音这边不这么干:
 * 编辑台预览用浏览器的 Web Audio 实时播,导出时在同一个 Chrome 里用 OfflineAudioContext 把同一张节点图
 * 离线渲成 wav,再由 ffmpeg 合进成片(server/bakery/audio-mix.mjs 的 mixAudioInChrome)。
 * 同一份代码(src/audio/fxChain.ts)、同一套 DSP,天然一致 —— 压缩器、混响这类东西 ffmpeg 和浏览器的算法
 * 本来就不一样,硬对是对不齐的。实测:OfflineAudioContext 同一输入渲两次逐样本相同,88.7 秒立体声
 * 过「高通 + 压缩 + 2 秒卷积 + 增益」0.82 秒;highpass 和 ffmpeg 的同参数差 -91.8 dB。
 *
 * 这个文件只管「数值」:哪几种效果、参数范围、这一刻每个参数是多少、混响的脉冲响应怎么生成。
 * 节点怎么接在 src/audio/fxChain.ts(浏览器)。纯 JS 是为了 node 直接跑的服务端和单测也能 import。
 *
 * # 时间表达式
 *
 * 和视频滤镜同一套小语法(filters.mjs 的 compileExpr):t = 片段内秒数、d = 片段时长、p = t/d,
 * 以及效果自己声明的参数名。每一步的每个参数都可以是数字或表达式。
 */

import { BASE_VARS, compiledOf, FilterExprError, MAX_EXPR_LEN, normalizeParamDecls, RESERVED } from "./filters.mjs";

/* ------------------------------------------------------------------ 种类 */

/**
 * 每种效果的参数表。default 是「没填」时的值;neutral 给出来的种类,全部参数都等于 neutral 时这一步等于没接
 * (预览和导出都直接跳过,省节点)。
 */
export const AUDIO_FX_KINDS = {
  gain: {
    label: "Gain",
    hint: "Raises or lowers the overall level, in decibels. +6 dB is about twice as loud, -6 dB about half; it can go above 0 dB, which is the only way to amplify a sound that is too quiet (clip volume maxes out at 1)",
    params: { db: { label: "Decibels", default: 0, min: -60, max: 24, unit: "dB", neutral: 0 } },
  },
  highpass: {
    label: "High-pass",
    hint: "Filters out low frequencies below freq: removes rumble and handheld wind noise, keeps voices from sounding muffled. Typical for voice: 80~120 Hz",
    params: { freq: { label: "Cutoff frequency", default: 120, min: 20, max: 20000, unit: "Hz" }, q: { label: "Q", default: 0.707, min: 0.1, max: 20 } },
  },
  lowpass: {
    label: "Low-pass",
    hint: "Filters out high frequencies above freq: removes hiss, gives the muffled feel of \"behind a wall / old radio\". Telephone sound is about 3400 Hz",
    params: { freq: { label: "Cutoff frequency", default: 8000, min: 20, max: 20000, unit: "Hz" }, q: { label: "Q", default: 0.707, min: 0.1, max: 20 } },
  },
  peaking: {
    label: "Peaking EQ",
    hint: "Raises or lowers db decibels around freq; the larger q is, the narrower the range. Voice clarity is often boosted 2~4 dB at 2~4 kHz; harsh sibilance is cut a few dB at 6~8 kHz",
    params: {
      freq: { label: "Center frequency", default: 1000, min: 20, max: 20000, unit: "Hz" },
      q: { label: "Q", default: 1, min: 0.1, max: 20 },
      db: { label: "Decibels", default: 0, min: -24, max: 24, unit: "dB", neutral: 0 },
    },
  },
  lowshelf: {
    label: "Low shelf",
    hint: "Raises or lowers everything below freq by db decibels: thickens / thins the low end",
    params: { freq: { label: "Corner frequency", default: 200, min: 20, max: 20000, unit: "Hz" }, db: { label: "Decibels", default: 0, min: -24, max: 24, unit: "dB", neutral: 0 } },
  },
  highshelf: {
    label: "High shelf",
    hint: "Raises or lowers everything above freq by db decibels: brightens / muffles",
    params: { freq: { label: "Corner frequency", default: 4000, min: 20, max: 20000, unit: "Hz" }, db: { label: "Decibels", default: 0, min: -24, max: 24, unit: "dB", neutral: 0 } },
  },
  compressor: {
    label: "Compressor",
    hint: "Reduces the part above threshold by ratio, evening out sound that swings between loud and quiet (voiceover typically uses threshold -24, ratio 3~4). attack / release are in seconds",
    params: {
      threshold: { label: "Threshold", default: -24, min: -100, max: 0, unit: "dB" },
      ratio: { label: "Ratio", default: 4, min: 1, max: 20 },
      knee: { label: "Knee", default: 30, min: 0, max: 40, unit: "dB" },
      attack: { label: "Attack", default: 0.003, min: 0, max: 1, unit: "s" },
      release: { label: "Release", default: 0.25, min: 0, max: 1, unit: "s" },
    },
  },
  limiter: {
    label: "Limiter",
    hint: "Pushes peaks down to around ceiling decibels (not a hard wall: compression ratio 20, attack 1 ms, hot signals may exceed it by a few tenths of a dB and transients may slip through), preventing clipping pops. Put it on the loudest segments when the peak exceeds 0 dB after mixing; leave ceiling a margin of -1~-2",
    params: { ceiling: { label: "Ceiling", default: -1, min: -20, max: 0, unit: "dB" } },
  },
  delay: {
    label: "Echo",
    hint: "Repeats once every time seconds, feedback is the decay of each repeat, mix is the proportion of echo",
    params: {
      time: { label: "Interval", default: 0.3, min: 0.01, max: 2, unit: "s" },
      feedback: { label: "Feedback", default: 0.3, min: 0, max: 0.9 },
      mix: { label: "Mix", default: 0.3, min: 0, max: 1, neutral: 0 },
    },
  },
  reverb: {
    label: "Reverb",
    hint: "Sense of space. decay is how long the tail is (seconds): small room 0.4, big hall 2~3; mix is the proportion of reverb, usually 0.1~0.25 for voiceover",
    params: {
      decay: { label: "Decay", default: 1.5, min: 0.1, max: 8, unit: "s" },
      mix: { label: "Mix", default: 0.25, min: 0, max: 1, neutral: 0 },
    },
  },
  pan: {
    label: "Pan",
    hint: "-1 full left, 0 center, 1 full right",
    params: { pan: { label: "Position", default: 0, min: -1, max: 1, neutral: 0 } },
  },
};

export const MAX_AUDIO_OPS = 8;
export { MAX_EXPR_LEN };

/** 效果的参数名也不能和种类的参数名撞(不然表达式里写 freq 分不清是自定义的还是这一步的) */
const KIND_PARAM_NAMES = new Set(Object.values(AUDIO_FX_KINDS).flatMap((k) => Object.keys(k.params)));
const AUDIO_RESERVED = new Set([...RESERVED, ...KIND_PARAM_NAMES]);

export const AUDIO_EXPR_HELP =
  "Every parameter of each step can be a number or a time-varying expression string. Variables: t = seconds within the clip (counted from the clip start), d = clip duration, p = t/d (progress 0~1)," +
  "and the parameter names you declare in params. Operators: + - * / % ^ and parentheses. Functions: sin cos tan abs sqrt exp log floor ceil round sign " +
  "min max pow mod clamp(x,lo,hi) lerp(a,b,x) step(edge,x) smoothstep(e0,e1,x). Constants PI, E." +
  "e.g. { kind:'gain', db:'lerp(-18, 0, smoothstep(0, 1, t))' } (rises from -18 dB back to the original sound within the first second), " +
  "{ kind:'lowpass', freq:'lerp(400, 12000, p)' } (the whole segment slowly brightens from muffled).";

/* ------------------------------------------------------------------ 定义校验 */

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

/**
 * 把模型 / 界面交来的效果定义洗成规范形状,不合规就抛(文案写给模型看)。
 * ops 每一步是 { kind, <参数名>: 数字 | 表达式 },没填的参数取种类的 default。
 * 返回 { name, description?, params?, ops }(id / createdAt 由调用方加)。
 */
export function normalizeAudioFxDef(input) {
  if (!input || typeof input !== "object") throw new FilterExprError("The effect definition must be an object");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 30) throw new FilterExprError("name is required, max 30 characters (this name is shown in the media library)");
  const description = typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, 200) : undefined;

  const params = normalizeParamDecls(input.params, AUDIO_RESERVED);
  const keys = Object.keys(params);
  const vars = [...BASE_VARS, ...keys];

  if (!Array.isArray(input.ops) || input.ops.length === 0) throw new FilterExprError(`ops needs at least one step, e.g. [{ "kind": "gain", "db": -12 }]`);
  if (input.ops.length > MAX_AUDIO_OPS) throw new FilterExprError(`ops allows at most ${MAX_AUDIO_OPS} steps`);
  const ops = input.ops.map((op, i) => {
    const kind = op && op.kind;
    const spec = Object.hasOwn(AUDIO_FX_KINDS, kind) ? AUDIO_FX_KINDS[kind] : null;
    if (!spec) throw new FilterExprError(`ops[${i}].kind "${kind}" is not recognized, only: ${Object.keys(AUDIO_FX_KINDS).join(" / ")}`);
    // 兼容 { kind, params: {...} } 的写法;扁平的 { kind, freq, q } 是主要形态
    const src = op.params && typeof op.params === "object" ? { ...op.params, ...op, params: undefined } : op;
    const out = { kind };
    for (const key of Object.keys(src)) {
      if (key === "kind" || key === "params") continue;
      if (!Object.hasOwn(spec.params, key)) {
        throw new FilterExprError(`ops[${i}] ${kind} has no parameter ${key} (available: ${Object.keys(spec.params).join(" / ")})`);
      }
    }
    for (const [key, ps] of Object.entries(spec.params)) {
      const value = src[key];
      if (value === undefined || value === null) { out[key] = ps.default; continue; }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new FilterExprError(`ops[${i}].${key} is not a finite number`);
        if (value < ps.min || value > ps.max) throw new FilterExprError(`ops[${i}] ${kind}: ${key} must be between ${ps.min}~${ps.max}, got ${value}`);
        out[key] = value;
        continue;
      }
      if (typeof value !== "string" || !value.trim()) throw new FilterExprError(`ops[${i}].${key} must be a number or an expression string`);
      try {
        compiledOf(value.trim(), vars);
      } catch (e) {
        throw new FilterExprError(`ops[${i}] ${kind}: the expression for ${key} has a problem: ${e.message}`);
      }
      out[key] = value.trim();
    }
    return out;
  });

  const def = { name, ...(description ? { description } : null), ...(keys.length ? { params } : null), ops };
  // 抽几个时刻试算一遍:NaN / 无穷当场说,别等到导出
  for (const d of [1, 10]) {
    for (const t of [0, d * 0.37, d]) {
      const env = envOf(def, undefined, t, d);
      for (const [i, op] of def.ops.entries()) {
        for (const [key, value] of Object.entries(op)) {
          if (key === "kind" || typeof value !== "string") continue;
          const v = compiledOf(value, vars).fn(env);
          if (!Number.isFinite(v)) throw new FilterExprError(`ops[${i}] ${op.kind}: ${key} evaluates to ${v} at t=${round6(t)}, d=${d}, rewrite it (watch for division by 0 and log(0))`);
        }
      }
    }
  }
  return def;
}

/** 片段上的参数覆盖:只留声明过的键,夹进 min~max。不合法的键直接报错 */
export function normalizeAudioClipParams(def, input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object") throw new FilterExprError("params must be an object");
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const spec = def.params && Object.hasOwn(def.params, k) ? def.params[k] : null;
    if (!spec) throw new FilterExprError(`Effect "${def.name}" has no parameter ${k}${def.params ? `(available: ${Object.keys(def.params).join(" ")})` : "(it declares no parameters)"}`);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new FilterExprError(`Parameter ${k} must be a number`);
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
 * 这一刻每一步的数值。t 是片段内秒数,d 是片段时长。算不出来(NaN)的退回 default,超范围的夹住。
 * 返回 [{ kind, values: { 参数名: 数字 } }],和 def.ops 一一对应(节点图的结构只由种类决定,逐帧只换数)。
 */
export function resolveAudioOps(def, clipParams, t, d) {
  const vars = [...BASE_VARS, ...Object.keys(def.params || {})];
  const env = envOf(def, clipParams, t, d);
  return def.ops.map((op) => {
    const spec = AUDIO_FX_KINDS[op.kind];
    const values = {};
    for (const [key, ps] of Object.entries(spec.params)) {
      const raw = op[key];
      let v;
      // 同 filters.mjs 的 resolveOps:工程文件里的坏表达式按 default 算,不在预览 / 混音里抛
      try {
        v = typeof raw === "number" ? raw : typeof raw === "string" ? compiledOf(raw, vars).fn(env) : ps.default;
      } catch {
        v = ps.default;
      }
      if (!Number.isFinite(v)) v = ps.default;
      values[key] = round6(clamp(v, ps.min, ps.max));
    }
    return { kind: op.kind, values };
  });
}

/** 这一步是不是「等于没接」:声明了 neutral 的参数全在中性值上(增益 0 dB、混响 mix 0……) */
export function isNeutralOp(op) {
  const spec = AUDIO_FX_KINDS[op.kind];
  const neutralKeys = Object.entries(spec.params).filter(([, ps]) => ps.neutral !== undefined);
  if (!neutralKeys.length) return false;
  return neutralKeys.every(([key, ps]) => op.values[key] === ps.neutral);
}

/** 有没有随时间变的参数(用到 t 或 p)。没有的话预览只在挂上时设一次参数,导出也不用逐步排自动化 */
export function isAudioFxAnimated(def) {
  const vars = [...BASE_VARS, ...Object.keys(def.params || {})];
  return def.ops.some((op) =>
    Object.entries(op).some(([key, value]) => {
      if (key === "kind" || typeof value !== "string") return false;
      try {
        const { uses } = compiledOf(value, vars);
        return uses.has("t") || uses.has("p");
      } catch {
        return false;
      }
    }),
  );
}

/** 一句话描述,给界面列表和工具回显用 */
export function describeAudioFx(def) {
  return def.ops
    .map((op) => {
      const spec = AUDIO_FX_KINDS[op.kind];
      const parts = Object.entries(spec.params)
        .filter(([key, ps]) => op[key] !== undefined && op[key] !== ps.default)
        .map(([key, ps]) => `${ps.label} ${typeof op[key] === "number" ? `${op[key]}${ps.unit ?? ""}` : op[key]}`);
      return parts.length ? `${spec.label}(${parts.join(", ")})` : spec.label;
    })
    .join(" · ");
}

/* ------------------------------------------------------------------ 混响脉冲响应 */

/** 确定性的 PRNG(mulberry32):预览和导出、这台机器和那台机器,同一个 decay 生成同一条尾巴 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 合成一条混响脉冲响应:白噪声 × 指数衰减,decay 秒后衰减 60 dB(RT60)。
 * 左右两声道用不同的种子,才有立体的扩散感。返回 [左, 右] 两条 Float32Array,长度 = decay × sampleRate。
 * 纯函数、确定性,单测能验;真正放进 ConvolverNode 在 src/audio/fxChain.ts。
 */
export function reverbImpulse(sampleRate, decay, seed = 1) {
  const dec = clamp(decay, 0.05, 10);
  const len = Math.max(1, Math.round(dec * sampleRate));
  const k = Math.log(1000) / (dec * sampleRate); // e^(-k·n):n = decay·sr 时为 1/1000(-60 dB)
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const rnd = mulberry32(seed * 7919 + ch * 104729 + 17);
    const buf = new Float32Array(len);
    for (let i = 0; i < len; i++) buf[i] = (rnd() * 2 - 1) * Math.exp(-k * i);
    // 归一:让整条尾巴的能量和一个单位脉冲相当,mix 0.25 在长短尾巴上听起来差不多响
    let e = 0;
    for (let i = 0; i < len; i++) e += buf[i] * buf[i];
    const g = e > 0 ? 1 / Math.sqrt(e) : 1;
    for (let i = 0; i < len; i++) buf[i] *= g;
    out.push(buf);
  }
  return out;
}

/* ------------------------------------------------------------------ 预设 */

/**
 * 素材库「音频效果」页里「从预设新建」的几条。刻意少:够常见场景起步,细调让 Agent 或人改参数。
 * 每条经 normalizeAudioFxDef 洗过才进库(单测保证它们全都合规)。
 */
export const AUDIO_FX_PRESETS = [
  {
    name: "Vocal clarity",
    description: "Voiceover / interview voice: remove low-frequency rumble, boost 2~4 kHz slightly, then compress to even out loud and quiet parts",
    ops: [{ kind: "highpass", freq: 100 }, { kind: "peaking", freq: 3000, q: 1, db: 3 }, { kind: "compressor", threshold: -24, ratio: 3 }],
  },
  {
    name: "Duck background",
    description: "Make music / ambient sound yield to the voice: lower everything by amount dB (default -12); after attaching, adjust segment by segment as needed",
    params: { amount: { default: -12, min: -40, max: 0, label: "Decibels" } },
    ops: [{ kind: "gain", db: "amount" }],
  },
  {
    name: "Telephone",
    description: "Narrow band of 300~3400 Hz, as if coming from a phone / walkie-talkie",
    ops: [{ kind: "highpass", freq: 300, q: 1 }, { kind: "lowpass", freq: 3400, q: 1 }, { kind: "gain", db: 3 }],
  },
  {
    name: "Room reverb",
    description: "Natural feel of a small space, short tail",
    ops: [{ kind: "reverb", decay: 0.6, mix: 0.18 }],
  },
  {
    name: "Hall reverb",
    description: "Wide space, long tail, suits intro / outro text",
    ops: [{ kind: "reverb", decay: 2.5, mix: 0.3 }],
  },
  {
    name: "Anti-clipping limiter",
    description: "Keeps peaks below -1 dB; attach it to the loudest segments when the mix clips after layering",
    ops: [{ kind: "limiter", ceiling: -1 }],
  },
  {
    name: "Muffled through a wall",
    description: "Low-pass at 600 Hz, as if heard through a wall / from the next room",
    ops: [{ kind: "lowpass", freq: 600, q: 0.8 }, { kind: "gain", db: 2 }],
  },
];

/* ------------------------------------------------------------------ 项目里的查找 */

/** 片段挂着的效果定义(找不到就 null —— 效果被删了,片段按没效果播) */
export function audioFxOfClip(project, clip) {
  // 停用(`clip.audioFx.off`)的按没挂算:预览的 Web Audio 图和导出的 ffmpeg 混音共用这一处
  if (!clip || !clip.audioFx || !clip.audioFx.id || clip.audioFx.off) return null;
  return (project.audioFx || []).find((f) => f.id === clip.audioFx.id) || null;
}

/** 片段在时间轴时刻 T 的效果数值;没挂或找不到定义返回 null */
export function clipAudioFxAt(project, clip, T) {
  const def = audioFxOfClip(project, clip);
  if (!def) return null;
  return resolveAudioOps(def, clip.audioFx.params, T - clip.start, clip.end - clip.start);
}
