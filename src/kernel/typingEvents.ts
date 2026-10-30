/** Shared visual/audio typing clock. Times are local milliseconds, never wall-clock time. */
export const TYPING_SCHEDULE_VERSION = "promptcut-typing-v1";
export const MAX_TYPING_GRAPHEMES = 10_000;
export type TypingKeyType = "key" | "punctuation" | "space" | "newline";

export interface TypingScheduleOptions {
  text: string;
  /** Milliseconds per visible grapheme. The first character appears after one interval. */
  duration?: number;
  delayMs?: number;
  punctuationPauseMs?: number;
  newlinePauseMs?: number;
  jitterMs?: number;
  seed?: number;
  punctuationSound?: boolean;
  whitespaceSound?: boolean;
  /** Additional pause after a grapheme, indexed from zero. */
  pauses?: { afterIndex: number; durationMs: number }[];
}
export interface TypingEvent {
  id: number;
  grapheme: string;
  /** UTF-16 boundary for slicing the original text without breaking a grapheme. */
  endOffset: number;
  atMs: number;
  keyType: TypingKeyType;
  sound: boolean;
}
export interface TypingSchedule {
  version: typeof TYPING_SCHEDULE_VERSION;
  source: Required<TypingScheduleOptions>;
  events: TypingEvent[];
  settleMs: number;
}

function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Typing ${name} must be in [${min}, ${max}]`);
  return value;
}
/** Stateless integer mixing: independent of request order or how much text was rendered. */
export function typingRandom(seed: number, index: number): number {
  let n = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  return ((n ^ (n >>> 16)) >>> 0) / 0x100000000;
}

export function normalizeTypingScheduleOptions(options: TypingScheduleOptions): Required<TypingScheduleOptions> {
  if (!options || typeof options !== "object") throw new Error("Typing options are required");
  if (options.pauses !== undefined && (!Array.isArray(options.pauses) || options.pauses.length > MAX_TYPING_GRAPHEMES)) throw new Error("Typing pauses must be an array within the resource budget");
  for (const pause of options.pauses ?? []) if (!pause || typeof pause !== "object") throw new Error("Typing pause must be an object");
  if (typeof options.text !== "string" || options.text.length > 100_000) throw new Error("Typing text must be a string of at most 100000 UTF-16 units");
  const source: Required<TypingScheduleOptions> = {
    text: options.text,
    duration: bounded(options.duration ?? 120, 0, 60_000, "duration"),
    delayMs: bounded(options.delayMs ?? 0, 0, 3_600_000, "delayMs"),
    punctuationPauseMs: bounded(options.punctuationPauseMs ?? 0, 0, 60_000, "punctuationPauseMs"),
    newlinePauseMs: bounded(options.newlinePauseMs ?? 0, 0, 60_000, "newlinePauseMs"),
    jitterMs: bounded(options.jitterMs ?? 0, 0, 60_000, "jitterMs"),
    seed: bounded(options.seed ?? 0, 0, 0xffffffff, "seed"),
    punctuationSound: options.punctuationSound ?? true,
    whitespaceSound: options.whitespaceSound ?? false,
    pauses: (options.pauses ?? []).map((pause) => ({ ...pause })),
  };
  if (!Number.isInteger(source.seed)) throw new Error("Typing seed must be an unsigned integer");
  if (typeof source.punctuationSound !== "boolean" || typeof source.whitespaceSound !== "boolean") throw new Error("Typing sound policies must be booleans");
  if (source.jitterMs > source.duration) throw new Error("Typing jitterMs cannot exceed duration");
  if (source.pauses.length > MAX_TYPING_GRAPHEMES) throw new Error("Typing pause count exceeds resource budget");
  const pauseMap = new Map<number, number>();
  for (const pause of source.pauses) {
    bounded(pause.afterIndex, 0, MAX_TYPING_GRAPHEMES - 1, "pause index");
    if (!Number.isInteger(pause.afterIndex)) throw new Error("Typing pause index must be an integer");
    bounded(pause.durationMs, 0, 60_000, "pause durationMs");
    if (pauseMap.has(pause.afterIndex)) throw new Error("Typing pause indices must be unique");
    pauseMap.set(pause.afterIndex, pause.durationMs);
  }
  source.pauses.sort((a, b) => a.afterIndex - b.afterIndex);
  return source;
}

export function createTypingSchedule(options: TypingScheduleOptions): TypingSchedule {
  const source = normalizeTypingScheduleOptions(options);
  const pauseMap = new Map(source.pauses.map((p) => [p.afterIndex, p.durationMs]));
  // Intl.Segmenter follows Unicode extended grapheme clusters (CJK, emoji ZWJ, marks, flags).
  // Persist the resulting events with audio recipes so reopening does not resegment old audio.
  const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locale: string, options: { granularity: string }) => { segment(text: string): Iterable<{ segment: string; index: number }> } }).Segmenter;
  if (!Segmenter) throw new Error("Typing requires Intl.Segmenter for Unicode grapheme boundaries");
  const events: TypingEvent[] = [];
  let extraMs = 0;
  for (const { segment: grapheme, index } of new Segmenter("und", { granularity: "grapheme" }).segment(source.text)) {
    const id = events.length;
    if (id >= MAX_TYPING_GRAPHEMES) throw new Error("Typing grapheme count exceeds resource budget");
    const keyType: TypingKeyType = /[\r\n\u2028\u2029]/u.test(grapheme) ? "newline" : /^\s+$/u.test(grapheme) ? "space" : /^\p{P}/u.test(grapheme) ? "punctuation" : "key";
    extraMs += source.jitterMs * (typingRandom(source.seed, id) * 2 - 1);
    const atMs = source.delayMs + (id + 1) * source.duration + extraMs;
    events.push({ id, grapheme, endOffset: index + grapheme.length, atMs, keyType,
      sound: keyType === "space" || keyType === "newline" ? source.whitespaceSound : keyType === "punctuation" ? source.punctuationSound : true });
    extraMs += (pauseMap.get(id) ?? 0) + (keyType === "punctuation" ? source.punctuationPauseMs : keyType === "newline" ? source.newlinePauseMs : 0);
  }
  for (const index of pauseMap.keys()) if (index >= events.length) throw new Error("Typing pause index is outside the text");
  return { version: TYPING_SCHEDULE_VERSION, source, events, settleMs: events.at(-1)?.atMs ?? 0 };
}

/**
 * 事件边界的浮点容差(毫秒)。舞台给的 t 是「帧时刻相减再乘 1000」,整帧边界会差出 1e-13 量级
 * (如 69/30 - 51/30 = 0.5999999999999999,换成毫秒是 599.9999999999999),不加容差,边界那一帧会少一个字,
 * 与旧实现(整数毫秒时钟)逐帧对不上。1e-6 ms(1 纳秒)远小于任何真实的事件间隔与音频采样间隔。
 *
 * 容差只补「按秒相减再换毫秒」这一种算法。经过毫秒本来就是两个毫秒钟点相减时(旧实现的算法:
 * 当前帧毫秒 − 挂载那一帧的毫秒,见 `typingMountClockMs`;以及没有舞台 t 的独立预览),旧实现自己就带着那点浮点误差
 * (30 fps 下 197/30*1000 − 179/30*1000 = 599.9999999999991,旧实现那一帧就是少一个字),
 * 要逐帧一致就得照样不补:这两处给 `boundaryEpsilonMs` 传 0。
 */
export const TYPING_BOUNDARY_EPSILON_MS = 1e-6;

/**
 * 「挂载钟」的经过毫秒:当前舞台时刻与卡片挂载时刻(都是秒)各自换成毫秒再相减。
 * 算式与旧打字卡逐位相同(它读的是被钉成 `秒 * 1000` 的页面时钟),所以不要改写成 `(now - mounted) * 1000`。
 */
export function typingMountClockMs(nowSec: number, mountedSec: number): number {
  return nowSec * 1000 - mountedSec * 1000;
}

/** Inclusive event boundary; binary search supports arbitrary seek without replaying state. */
export function typingTextAt(schedule: TypingSchedule, elapsedMs: number, boundaryEpsilonMs: number = TYPING_BOUNDARY_EPSILON_MS): string {
  if (Number.isNaN(elapsedMs)) return "";
  const limit = elapsedMs + boundaryEpsilonMs;
  let lo = 0, hi = schedule.events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (schedule.events[mid].atMs <= limit) lo = mid + 1;
    else hi = mid;
  }
  return lo ? schedule.source.text.slice(0, schedule.events[lo - 1].endOffset) : "";
}

/** mu-typing and its companion generator use exactly the same optional parameter mapping. */
export function typingScheduleOptionsFromParams(params: Record<string, unknown>): TypingScheduleOptions {
  const optionalNumber = (key: string): number | undefined => {
    const value = params[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number") throw new Error(`Typing ${key} must be a number`);
    return value;
  };
  if (params.text !== undefined && typeof params.text !== "string") throw new Error("Typing text must be a string");
  const policy = (key: string): boolean | undefined => {
    const value = params[key];
    if (value === undefined) return undefined;
    if (value === true || value === "on") return true;
    if (value === false || value === "off") return false;
    throw new Error(`Typing ${key} must be on or off`);
  };
  return { text: (params.text as string | undefined) ?? "", duration: optionalNumber("duration"), delayMs: optionalNumber("delayMs"),
    punctuationPauseMs: optionalNumber("punctuationPauseMs"), newlinePauseMs: optionalNumber("newlinePauseMs"), jitterMs: optionalNumber("jitterMs"),
    seed: optionalNumber("seed"), punctuationSound: policy("punctuationSound"), whitespaceSound: policy("whitespaceSound"),
    ...(params.pauses !== undefined ? { pauses: params.pauses as TypingScheduleOptions["pauses"] } : {}) };
}
