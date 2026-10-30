import type { Control } from "../../kernel/types";

/**
 * 粒子配置的「函数翻译」:把一份 tsParticles 配置(素材目录里的原始 JSON)翻译成
 * 一组能调的旋钮(controls + defaults),以及把旋钮的值写回配置的函数。
 *
 * 为什么不直接把配置暴露出去:那是几十行嵌套 JSON,Agent 拿到只能整份重写,改错一个键
 * 整张卡就黑了。翻译之后对外只有 count / speed / size / color / opacity / links 这几个
 * 有名字、有范围的参数 —— 这就是「约定封装」:原始配置留在素材目录里,Agent 只碰旋钮。
 *
 * 翻译是保守的:配置里**有**的旋钮才露出来(没有 links 的配置就没有 links 参数),
 * 值保持原来的形状(range 就还是 range,按比例缩放)。旋钮值和默认值一样就不写回,
 * 所以不动任何旋钮时 apply 出来的配置和原配置逐字节一样(size 为 0 这种越界的原值也不会被夹掉)。
 */

export interface ParticleKnobs {
  controls: Control[];
  defaults: Record<string, unknown>;
  /** 把旋钮值写回配置(返回新对象,不改原配置) */
  apply(config: Record<string, any>, params: Record<string, unknown>): Record<string, any>;
}

type Range = { min: number; max: number };
const isRange = (v: unknown): v is Range => !!v && typeof v === "object" && typeof (v as Range).min === "number" && typeof (v as Range).max === "number";

/** 取一个「数或区间」的代表值:区间取中点 */
function numOf(v: unknown, fallback: number): number {
  if (typeof v === "number") return v;
  if (isRange(v)) return (v.min + v.max) / 2;
  return fallback;
}

/** 把「数或区间」按比例缩放到新的代表值,保持形状 */
function scaleTo(v: unknown, target: number): unknown {
  if (isRange(v)) {
    const mid = (v.min + v.max) / 2;
    if (mid <= 0) return { min: target, max: target };
    const k = target / mid;
    return { min: v.min * k, max: v.max * k };
  }
  return target;
}

function firstColor(v: unknown): string | null {
  if (typeof v === "string") return v === "random" ? null : v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return null;
}

const get = (o: any, path: string[]): unknown => path.reduce((x, k) => (x && typeof x === "object" ? x[k] : undefined), o);
function set(o: any, path: string[], value: unknown): void {
  let cur = o;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

const P = ["particles"];

type Writer = { key: string; fn: (cfg: any, params: Record<string, unknown>) => void };

export function translateParticlesConfig(config: Record<string, any>): ParticleKnobs {
  const controls: Control[] = [];
  const defaults: Record<string, unknown> = {};
  const writers: Writer[] = [];

  // 数量
  const count = get(config, [...P, "number", "value"]);
  if (typeof count === "number") {
    controls.push({ key: "count", label: "数量", type: "number", min: 0, max: Math.max(400, count * 3), step: 5, hint: "原配置 " + count });
    defaults.count = count;
    writers.push({ key: "count", fn: (cfg, p) => { if (typeof p.count === "number") set(cfg, [...P, "number", "value"], Math.max(0, p.count | 0)); } });
  }

  // 速度
  const speed = get(config, [...P, "move", "speed"]);
  if (typeof speed === "number" || isRange(speed)) {
    const v = numOf(speed, 1);
    controls.push({ key: "speed", label: "速度", type: "number", min: 0, max: Math.max(10, v * 4), step: 0.1, hint: "原配置 " + v });
    defaults.speed = v;
    writers.push({ key: "speed", fn: (cfg, p) => { if (typeof p.speed === "number") set(cfg, [...P, "move", "speed"], scaleTo(speed, Math.max(0, p.speed))); } });
  }

  // 大小
  const size = get(config, [...P, "size", "value"]);
  if (typeof size === "number" || isRange(size)) {
    const v = numOf(size, 3);
    controls.push({ key: "size", label: "大小(px)", type: "number", min: 0.5, max: Math.max(20, v * 4), step: 0.5, hint: "原配置 " + v });
    defaults.size = v;
    writers.push({ key: "size", fn: (cfg, p) => { if (typeof p.size === "number") set(cfg, [...P, "size", "value"], scaleTo(size, Math.max(0.5, p.size))); } });
  }

  // 颜色:只有单色或颜色数组才露出来(random 和复杂动画的不动)
  const colorRaw = get(config, [...P, "color", "value"]);
  const color = firstColor(colorRaw);
  if (color) {
    controls.push({ key: "color", label: "颜色", type: "color", hint: "原配置 " + color + (Array.isArray(colorRaw) ? "(多色时只替换第一种)" : "") });
    defaults.color = color;
    writers.push({ key: "color", fn: (cfg, p) => {
      if (typeof p.color !== "string" || !p.color.trim()) return;
      set(cfg, [...P, "color", "value"], Array.isArray(colorRaw) ? [p.color, ...colorRaw.slice(1)] : p.color);
    } });
  }

  // 不透明度
  const opacity = get(config, [...P, "opacity", "value"]);
  if (typeof opacity === "number" || isRange(opacity)) {
    const v = numOf(opacity, 1);
    controls.push({ key: "opacity", label: "不透明度", type: "number", min: 0, max: 1, step: 0.05, hint: "原配置 " + v });
    defaults.opacity = v;
    writers.push({ key: "opacity", fn: (cfg, p) => { if (typeof p.opacity === "number") set(cfg, [...P, "opacity", "value"], scaleTo(opacity, Math.min(1, Math.max(0, p.opacity)))); } });
  }

  // 连线:配置里有 links 段才露
  const links = get(config, [...P, "links"]);
  if (links && typeof links === "object") {
    const on = (links as any).enable !== false;
    controls.push({ key: "links", label: "连线", type: "select", options: [{ value: "yes", label: "有" }, { value: "no", label: "无" }] });
    defaults.links = on ? "yes" : "no";
    writers.push({ key: "links", fn: (cfg, p) => { if (p.links === "yes" || p.links === "no") set(cfg, [...P, "links", "enable"], p.links === "yes"); } });
  }

  return {
    controls,
    defaults,
    apply(cfg, params) {
      // 深拷贝再写:set 会沿路径就地改,不能碰原配置
      const out = JSON.parse(JSON.stringify(cfg));
      for (const w of writers) {
        if (params[w.key] === undefined || params[w.key] === defaults[w.key]) continue;
        w.fn(out, params);
      }
      return out;
    },
  };
}
