/**
 * Audio effects: definitions, time-varying parameter expressions, and values shared
 * across preview / export.
 *
 * Same approach as kernel/filters.mjs (video filters): effects are a project-level library
 * (project.audioFx), referenced by clips via clip.audioFx; parameters can use expressions
 * (t / d / p + custom parameters), with rules written only once here.
 *
 * # Why both pipelines use Web Audio
 *
 * Video filters must be implemented separately in CSS and ffmpeg, aligned pixel-by-pixel
 * (see the file header comment in filters.mjs). Audio does not do this: editor preview plays
 * in real time using browser Web Audio; during export, OfflineAudioContext renders the same
 * node graph to wav offline in the same Chrome, which ffmpeg then mixes into the final video
 * (mixAudioInChrome in server/bakery/audio-mix.mjs).
 * The same code (src/audio/fxChain.ts) and the same DSP are naturally consistent: algorithms
 * for things like compressors and reverbs inherently differ between ffmpeg and browsers, so
 * forcing them to match never aligns. Tested: rendering the same input twice in
 * OfflineAudioContext is sample-by-sample identical; 88.7 seconds of stereo through
 * "highpass + compression + 2s convolution + gain" takes 0.82 seconds; highpass differs
 * from ffmpeg with the same parameters by -91.8 dB.
 *
 * This file only handles "values": which effect kinds, parameter ranges, what each parameter
 * is at this instant, and how reverb impulse responses are generated. How nodes connect is in
 * src/audio/fxChain.ts (browser). Plain JS is used so node-run server side and unit tests can
 * also import it directly.
 *
 * # Time expressions
 *
 * Same mini-grammar as video filters (compileExpr in filters.mjs): t = seconds within clip,
 * d = clip duration, p = t/d, plus parameter names declared by the effect itself. Each parameter
 * at each step can be a number or an expression.
 */

import { BASE_VARS, compiledOf, FilterExprError, MAX_EXPR_LEN, normalizeParamDecls, RESERVED } from "./filters.mjs";

/* ------------------------------------------------------------------ Kinds */

/**
 * Parameter table for each effect kind. default is the value when omitted; for kinds providing
 * neutral, when all parameters equal neutral this step acts as not connected (both preview and
 * export skip it directly to save nodes).
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

/** Effect parameter names cannot collide with kind parameter names (otherwise writing freq in an expression cannot distinguish custom vs. this step) */
const KIND_PARAM_NAMES = new Set(Object.values(AUDIO_FX_KINDS).flatMap((k) => Object.keys(k.params)));
const AUDIO_RESERVED = new Set([...RESERVED, ...KIND_PARAM_NAMES]);

export const AUDIO_EXPR_HELP =
  "Every parameter of each step can be a number or a time-varying expression string. Variables: t = seconds within the clip (counted from the clip start), d = clip duration, p = t/d (progress 0~1)," +
  "and the parameter names you declare in params. Operators: + - * / % ^ and parentheses. Functions: sin cos tan abs sqrt exp log floor ceil round sign " +
  "min max pow mod clamp(x,lo,hi) lerp(a,b,x) step(edge,x) smoothstep(e0,e1,x). Constants PI, E." +
  "e.g. { kind:'gain', db:'lerp(-18, 0, smoothstep(0, 1, t))' } (rises from -18 dB back to the original sound within the first second), " +
  "{ kind:'lowpass', freq:'lerp(400, 12000, p)' } (the whole segment slowly brightens from muffled).";

/* ------------------------------------------------------------------ Definition validation */

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

/**
 * Normalizes effect definitions submitted by models / UI into canonical shape, throwing if
 * invalid (copy written for models).
 * Each step in ops is { kind, <paramName>: number | expression }; omitted parameters take the
 * kind's default.
 * Returns { name, description?, params?, ops } (id / createdAt added by caller).
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
    // Compatible with { kind, params: {...} } format; flat { kind, freq, q } is the primary form
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
  // Sample a few timestamps for trial runs: report NaN / infinity immediately, don't wait for export
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

/** Parameter override on clips: keep only declared keys clamped to min~max. Invalid keys throw an error directly */
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
 * Numerical values of each step at this instant. t is seconds within clip, d is clip duration.
 * Uncomputable values (NaN) fall back to default, and out-of-range values are clamped.
 * Returns [{ kind, values: { paramName: number } }], mapping 1:1 with def.ops (node graph
 * structure is determined solely by kind; frame-by-frame only swaps numbers).
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
      // Same as resolveOps in filters.mjs: bad expressions in project files evaluate to default, not thrown in preview / mix
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

/** Whether this step "acts as not connected": parameters declaring neutral are all at neutral values (gain 0 dB, reverb mix 0...) */
export function isNeutralOp(op) {
  const spec = AUDIO_FX_KINDS[op.kind];
  const neutralKeys = Object.entries(spec.params).filter(([, ps]) => ps.neutral !== undefined);
  if (!neutralKeys.length) return false;
  return neutralKeys.every(([key, ps]) => op.values[key] === ps.neutral);
}

/** Whether any parameters vary over time (using t or p). If none, preview sets parameters once on attach, and export does not need step-by-step automation */
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

/** One-sentence description, for UI lists and tool echo */
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

/* ------------------------------------------------------------------ Reverb impulse response */

/** Deterministic PRNG (mulberry32): the same decay generates the same tail across preview, export, and different machines */
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
 * Synthesizes a reverb impulse response: white noise × exponential decay, decaying 60 dB after
 * decay seconds (RT60).
 * Left and right channels use different seeds to produce a stereo sense of diffusion. Returns
 * [left, right] Float32Array pair, length = decay × sampleRate.
 * Pure function, deterministic, verifiable by unit tests; actually placed into ConvolverNode
 * in src/audio/fxChain.ts.
 */
export function reverbImpulse(sampleRate, decay, seed = 1) {
  const dec = clamp(decay, 0.05, 10);
  const len = Math.max(1, Math.round(dec * sampleRate));
  const k = Math.log(1000) / (dec * sampleRate); // e^(-k·n): 1/1000 (-60 dB) when n = decay·sr
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const rnd = mulberry32(seed * 7919 + ch * 104729 + 17);
    const buf = new Float32Array(len);
    for (let i = 0; i < len; i++) buf[i] = (rnd() * 2 - 1) * Math.exp(-k * i);
    // Normalize: match total tail energy to a unit impulse, so mix 0.25 sounds equally loud on long and short tails
    let e = 0;
    for (let i = 0; i < len; i++) e += buf[i] * buf[i];
    const g = e > 0 ? 1 / Math.sqrt(e) : 1;
    for (let i = 0; i < len; i++) buf[i] *= g;
    out.push(buf);
  }
  return out;
}

/* ------------------------------------------------------------------ Presets */

/**
 * Presets under "New from preset" on the "Audio effects" page in the media library. Deliberately
 * minimal: enough to get started in common scenarios; fine-tuning lets Agents or humans tweak
 * parameters.
 * Each item is sanitized via normalizeAudioFxDef before being stored (unit tests ensure all of
 * them are valid).
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

/* ------------------------------------------------------------------ Lookups in project */

/** Effect definition attached to clip (null if not found: effect was deleted, clip plays without fx) */
export function audioFxOfClip(project, clip) {
  // Disabled (`clip.audioFx.off`) counts as not attached: shared by preview Web Audio graph and export ffmpeg mix
  if (!clip || !clip.audioFx || !clip.audioFx.id || clip.audioFx.off) return null;
  return (project.audioFx || []).find((f) => f.id === clip.audioFx.id) || null;
}

/** Effect values of clip at timeline time T; returns null if not attached or definition not found */
export function clipAudioFxAt(project, clip, T) {
  const def = audioFxOfClip(project, clip);
  if (!def) return null;
  return resolveAudioOps(def, clip.audioFx.params, T - clip.start, clip.end - clip.start);
}
