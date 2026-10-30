/** Pure, bounded, random-access sound synthesis. No AudioContext, filesystem, timer or RNG state. */
import { createTypingSchedule, normalizeTypingScheduleOptions, TYPING_SCHEDULE_VERSION, typingRandom } from "./typingEvents.ts";
import type { TypingKeyType, TypingSchedule, TypingScheduleOptions } from "./typingEvents.ts";
export type { TypingScheduleOptions } from "./typingEvents.ts";

/** Increment whenever sampling, envelope, noise, event mapping or headroom math changes. */
export const SOUND_SYNTH_VERSION = "promptcut-sound-v1";
export const SOUND_EFFECT_LIMITS = Object.freeze({
  maxDurationSeconds: 60, maxEvents: 10_000, maxBlockFrames: 65_536,
  maxVoiceFrames: 32_000_000, maxSimultaneousEvents: 64,
  sampleRates: [8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000] as readonly number[],
});
export interface NotificationSoundParams {
  frequency: number;
  waveform: "sine" | "triangle" | "bell";
  /** Seconds per note, including attack and release. */
  duration: number;
  attack: number;
  release: number;
  gain: number;
  /** Semitone offsets from frequency. */
  notes: number[];
  /** Seconds between note onsets. */
  interval: number;
}
export interface KeyboardSoundParams {
  tone: "soft" | "mechanical";
  duration: number;
  frequency: number;
  brightness: number;
  variation: number;
  gain: number;
}
export const NOTIFICATION_SOUND_DEFAULTS: Readonly<NotificationSoundParams> = Object.freeze({
  frequency: 880, waveform: "bell", duration: 0.4, attack: 0.005, release: 0.08, gain: 0.35, notes: [0], interval: 0.12,
});
export const KEYBOARD_SOUND_DEFAULTS: Readonly<KeyboardSoundParams> = Object.freeze({
  tone: "soft", duration: 0.075, frequency: 1800, brightness: 0.45, variation: 0.15, gain: 0.3,
});
export interface SoundEffectEvent {
  /** Stable event identity, independent of the order requests are rendered. */
  id: number;
  frame: number;
  velocity: number;
  keyType: TypingKeyType | "note";
  /** Semitone offset, only for notification notes. */
  note?: number;
}
interface SoundEffectRecipeBase {
  schemaVersion: 1;
  synthVersion: string;
  seed: number;
  sampleRate: number;
  channels: 1 | 2;
  /** Full asset duration. Explicit cropping does not alter the source samples; clip fades belong to the existing mixer. */
  frames: number;
  events: SoundEffectEvent[];
}
export type SoundEffectRecipe =
  | (SoundEffectRecipeBase & { preset: "notification"; params: NotificationSoundParams; typingSource?: never })
  | (SoundEffectRecipeBase & { preset: "keyboard"; params: KeyboardSoundParams; typingSource?: TypingSchedule });
export interface SoundEffectRecipeOptions { seed?: number; sampleRate?: number; channels?: 1 | 2; frames?: number }

const fail = (message: string): never => { throw new Error(`Sound effect: ${message}`); };
function number(value: unknown, min: number, max: number, name: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${name} must be ${integer ? "an integer " : ""}in [${min}, ${max}]`);
  return value as number;
}
function notificationParams(input: Partial<NotificationSoundParams>): NotificationSoundParams {
  const p = { ...NOTIFICATION_SOUND_DEFAULTS, ...input };
  number(p.frequency, 80, 4000, "frequency");
  if (!["sine", "triangle", "bell"].includes(p.waveform)) fail("unsupported notification waveform");
  number(p.duration, 0.02, 5, "duration");
  number(p.attack, 0.001, p.duration, "attack");
  number(p.release, 0.001, p.duration, "release");
  number(p.gain, 0, 1, "gain");
  number(p.interval, 0, 5, "interval");
  if (!Array.isArray(p.notes) || !p.notes.length || p.notes.length > 8) fail("notes must contain 1–8 semitone offsets");
  return { frequency: p.frequency, waveform: p.waveform, duration: p.duration, attack: p.attack, release: p.release,
    gain: p.gain, notes: p.notes.map((n) => number(n, -24, 24, "note")), interval: p.interval };
}
function keyboardParams(input: Partial<KeyboardSoundParams>): KeyboardSoundParams {
  const p = { ...KEYBOARD_SOUND_DEFAULTS, ...input };
  if (!["soft", "mechanical"].includes(p.tone)) fail("unsupported keyboard tone");
  return { tone: p.tone, duration: number(p.duration, 0.01, 0.5, "duration"), frequency: number(p.frequency, 100, 6000, "frequency"),
    brightness: number(p.brightness, 0, 1, "brightness"), variation: number(p.variation, 0, 0.5, "variation"), gain: number(p.gain, 0, 1, "gain") };
}
function format(options: SoundEffectRecipeOptions) {
  const sampleRate = options.sampleRate ?? 48000;
  if (!SOUND_EFFECT_LIMITS.sampleRates.includes(sampleRate)) fail("unsupported sampleRate");
  const channels = options.channels ?? 2;
  if (channels !== 1 && channels !== 2) fail("channels must be 1 or 2");
  return { sampleRate, channels, seed: number(options.seed ?? 0, 0, 0xffffffff, "seed", true) };
}
export function createNotificationRecipe(params: Partial<NotificationSoundParams> = {}, options: SoundEffectRecipeOptions = {}): SoundEffectRecipe {
  const p = notificationParams(params), f = format(options);
  const events = p.notes.map((note, id) => ({ id, note, frame: Math.round(id * p.interval * f.sampleRate), velocity: 1, keyType: "note" as const }));
  return validateSoundEffectRecipe({ schemaVersion: 1, synthVersion: SOUND_SYNTH_VERSION, preset: "notification", params: p,
    ...f, events, frames: options.frames ?? events.at(-1)!.frame + Math.ceil(p.duration * f.sampleRate) });
}
export function createTypingSoundRecipe(typing: TypingScheduleOptions, params: Partial<KeyboardSoundParams> = {}, options: SoundEffectRecipeOptions = {}): SoundEffectRecipe {
  const schedule = createTypingSchedule({ ...typing, seed: typing.seed ?? options.seed ?? 0 });
  const p = keyboardParams(params), f = format({ ...options, seed: options.seed ?? schedule.source.seed });
  const events = schedule.events.filter((event) => event.sound).map((event) => ({ id: event.id, frame: Math.round(event.atMs * f.sampleRate / 1000),
    velocity: event.keyType === "punctuation" ? 0.8 : event.keyType === "space" ? 0.65 : 1, keyType: event.keyType }));
  const naturalFrames = Math.max(Math.ceil(schedule.settleMs * f.sampleRate / 1000), (events.at(-1)?.frame ?? 0) + (events.length ? Math.ceil(p.duration * f.sampleRate) : 0));
  return validateSoundEffectRecipe({ schemaVersion: 1, synthVersion: SOUND_SYNTH_VERSION, preset: "keyboard", params: p,
    ...f, events, frames: options.frames ?? Math.max(1, naturalFrames), typingSource: schedule });
}

/** Validate persisted recipes before allocation. Unknown versions are never rendered as today's synth. */
export function validateSoundEffectRecipe(input: unknown): SoundEffectRecipe {
  if (!input || typeof input !== "object") return fail("recipe is required");
  const r = input as SoundEffectRecipe;
  if (r.schemaVersion !== 1) fail("unsupported recipe schemaVersion");
  if (r.synthVersion !== SOUND_SYNTH_VERSION) fail(`unsupported synthVersion ${String(r.synthVersion)}`);
  for (const key of ["seed", "sampleRate", "channels", "frames"]) if (!Object.hasOwn(r, key)) fail(`recipe is missing ${key}`);
  const f = format(r);
  number(r.frames, 1, f.sampleRate * SOUND_EFFECT_LIMITS.maxDurationSeconds, "frames (duration budget)", true);
  if (r.preset !== "notification" && r.preset !== "keyboard") fail("unsupported preset");
  if (!r.params || typeof r.params !== "object") fail("params are required");
  for (const key of Object.keys(r.preset === "notification" ? NOTIFICATION_SOUND_DEFAULTS : KEYBOARD_SOUND_DEFAULTS)) {
    if (!Object.hasOwn(r.params, key) || (r.params as unknown as Record<string, unknown>)[key] === undefined) fail(`complete recipe params are missing ${key}`);
  }
  const params = r.preset === "notification" ? notificationParams(r.params) : keyboardParams(r.params);
  if (!Array.isArray(r.events) || r.events.length > SOUND_EFFECT_LIMITS.maxEvents) fail("event count exceeds resource budget");
  const ids = new Set<number>();
  const events = r.events.map((e) => {
    if (!e || typeof e !== "object") return fail("invalid event");
    const id = number(e.id, 0, 0xffffffff, "event id", true);
    if (ids.has(id)) fail("event ids must be unique");
    ids.add(id);
    number(e.frame, 0, f.sampleRate * SOUND_EFFECT_LIMITS.maxDurationSeconds, "event frame", true);
    number(e.velocity, 0, 1, "event velocity");
    if (!["key", "punctuation", "space", "newline", "note"].includes(e.keyType)) fail("unsupported event keyType");
    if (r.preset === "notification" && e.keyType !== "note") fail("notification events must be notes");
    if (r.preset === "keyboard" && e.keyType === "note") fail("keyboard events cannot be notes");
    const event: SoundEffectEvent = { id, frame: e.frame, velocity: e.velocity, keyType: e.keyType };
    if (r.preset === "notification") event.note = number(e.note, -24, 24, "event note");
    return event;
  }).sort((a, b) => a.frame - b.frame || a.id - b.id);
  const voiceFrames = Math.ceil(params.duration * f.sampleRate);
  if (voiceFrames * events.length > SOUND_EFFECT_LIMITS.maxVoiceFrames) fail("voice sample work exceeds resource budget; split the sound into shorter assets");
  if (maximumOverlap(events, voiceFrames) > SOUND_EFFECT_LIMITS.maxSimultaneousEvents) fail("simultaneous events exceed the 64-voice resource budget; reduce event density or split the sound");
  if (r.preset === "notification" && events.some((e) => params.frequency * 2 ** ((e.note ?? 0) / 12) >= f.sampleRate * 0.45)) fail("note frequency exceeds the sampleRate bandwidth");
  if (r.preset === "keyboard" && params.frequency * 1.5 >= f.sampleRate * 0.45) fail("keyboard frequency exceeds the sampleRate bandwidth");
  const base = { schemaVersion: 1 as const, synthVersion: SOUND_SYNTH_VERSION, ...f, frames: r.frames, events };
  if (r.preset === "notification") return { ...base, preset: r.preset, params: params as NotificationSoundParams };
  let typingSource: TypingSchedule | undefined;
  if (r.typingSource !== undefined) {
    const s = r.typingSource;
    if (!s || s.version !== TYPING_SCHEDULE_VERSION || !s.source || !Array.isArray(s.events) || s.events.length > SOUND_EFFECT_LIMITS.maxEvents) fail("invalid typing source schedule");
    // Validate metadata without resegmenting: Unicode engines may evolve, persisted event boundaries may not.
    for (const key of ["text", "duration", "delayMs", "punctuationPauseMs", "newlinePauseMs", "jitterMs", "seed", "punctuationSound", "whitespaceSound", "pauses"]) {
      if (!Object.hasOwn(s.source, key) || (s.source as unknown as Record<string, unknown>)[key] === undefined) fail(`complete typing source is missing ${key}`);
    }
    if (!Array.isArray(s.source.pauses)) fail("typing source pauses must be an array");
    const source = normalizeTypingScheduleOptions(s.source);
    const pauses = new Map(source.pauses.map((p) => [p.afterIndex, p.durationMs]));
    let extraMs = 0;
    if (typeof s.source.text !== "string" || s.source.text.length > 100_000) fail("invalid typing source text");
    let priorMs = -1, priorOffset = 0;
    const typingEvents = s.events.map((e, i) => {
      if (!e || typeof e !== "object") return fail("invalid typing event");
      number(e.atMs, 0, 60_000, "typing event atMs");
      number(e.endOffset, priorOffset + 1, s.source.text.length, "typing event endOffset", true);
      if (e.id !== i || e.atMs < priorMs || typeof e.grapheme !== "string" || s.source.text.slice(priorOffset, e.endOffset) !== e.grapheme || typeof e.sound !== "boolean" || !["key", "punctuation", "space", "newline"].includes(e.keyType)) fail("invalid typing event");
      extraMs += source.jitterMs * (typingRandom(source.seed, i) * 2 - 1);
      const expectedMs = source.delayMs + (i + 1) * source.duration + extraMs;
      const expectedSound = e.keyType === "space" || e.keyType === "newline" ? source.whitespaceSound : e.keyType === "punctuation" ? source.punctuationSound : true;
      if (e.atMs !== expectedMs || e.sound !== expectedSound) fail("typing source timing or sound policy does not match its events");
      extraMs += (pauses.get(i) ?? 0) + (e.keyType === "punctuation" ? source.punctuationPauseMs : e.keyType === "newline" ? source.newlinePauseMs : 0);
      priorMs = e.atMs; priorOffset = e.endOffset;
      return { ...e };
    });
    if (priorOffset !== s.source.text.length || s.settleMs !== (typingEvents.at(-1)?.atMs ?? 0)) fail("typing source schedule does not cover text");
    if (source.pauses.some((p) => p.afterIndex >= typingEvents.length)) fail("typing source pause index is outside the text");
    const expected = typingEvents.filter((e) => e.sound);
    if (expected.length !== events.length || expected.some((e, i) => e.id !== events[i].id || Math.round(e.atMs * f.sampleRate / 1000) !== events[i].frame || e.keyType !== events[i].keyType)) fail("audio events do not match typing source schedule");
    typingSource = { version: s.version, source, events: typingEvents, settleMs: s.settleMs };
  }
  return { ...base, preset: "keyboard", params: params as KeyboardSoundParams, ...(typingSource ? { typingSource } : {}) };
}

/** Canonical recipe identity, deliberately not the WAV byte-content hash. No lossy hash collisions. */
export function soundEffectReuseKey(recipe: SoundEffectRecipe): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
    if (typeof value === "number" && !Number.isFinite(value)) fail("reuse key cannot contain non-finite numbers");
    return value;
  };
  return `sound-effect:${JSON.stringify(canonical(recipe))}`;
}

function envelope(age: number, frames: number, attack: number, release: number): number {
  return Math.max(0, Math.min(1, age / attack, (frames - 1 - age) / release));
}
/** FIR coefficients have absolute sum <= 1; sample-addressed noise needs no preroll or state. */
function noise(seed: number, event: number, sample: number, brightness: number): number {
  const rand = (i: number) => typingRandom((seed ^ Math.imul(event + 1, 0x45d9f3b)) >>> 0, i) * 2 - 1;
  const a = rand(sample), b = rand(sample - 1), c = rand(sample + 1);
  return (1 - brightness) * (0.5 * a + 0.25 * b + 0.25 * c) + brightness * 0.5 * (a - b);
}
function voice(r: SoundEffectRecipe, event: SoundEffectEvent, age: number, frames: number): number {
  const t = age / r.sampleRate, p = r.params;
  if (r.preset === "notification") {
    const p = r.params, hz = p.frequency * 2 ** ((event.note ?? 0) / 12), phase = 2 * Math.PI * hz * t;
    let tone = Math.sin(phase);
    if (p.waveform === "triangle") {
      let sum = 0, weight = 0;
      for (let h = 1; h <= 9 && hz * h < r.sampleRate * 0.45; h += 2) { const w = 1 / (h * h); sum += (h % 4 === 1 ? 1 : -1) * Math.sin(phase * h) * w; weight += w; }
      tone = sum / weight;
    } else if (p.waveform === "bell") {
      const wobble = typingRandom(r.seed, event.id) * Math.PI * 2;
      let sum = tone * 0.7, weight = 0.7;
      if (hz * 2.76 < r.sampleRate * 0.45) { sum += 0.2 * Math.sin(phase * 2.76 + wobble) * Math.exp(-t * 9); weight += 0.2; }
      if (hz * 4.07 < r.sampleRate * 0.45) { sum += 0.1 * Math.sin(phase * 4.07 + wobble) * Math.exp(-t * 16); weight += 0.1; }
      tone = sum / weight;
    }
    return tone * Math.exp(-3.5 * t / p.duration) * envelope(age, frames, p.attack * r.sampleRate, p.release * r.sampleRate);
  }
  const k = r.params;
  const variation = 1 + (typingRandom(r.seed, event.id) * 2 - 1) * k.variation;
  const hz = k.frequency * variation * (event.keyType === "punctuation" ? 0.88 : event.keyType === "space" ? 0.7 : 1);
  const phase = 2 * Math.PI * hz * t;
  const ring = Math.sin(phase) * Math.exp(-t * (k.tone === "mechanical" ? 65 : 95));
  const transient = Math.sin(phase * 0.47) * Math.exp(-t * 350);
  const hiss = noise(r.seed, event.id, age, k.brightness) * Math.exp(-t * (k.tone === "mechanical" ? 110 : 180));
  return (0.48 * hiss + 0.4 * ring + 0.12 * transient) * envelope(age, frames, 0.0007 * r.sampleRate, Math.min(0.01, p.duration / 3) * r.sampleRate);
}
/** Worst-case overlap normalization provides headroom without clipping or request-dependent gain. */
function maximumOverlap(events: SoundEffectEvent[], duration: number): number {
  let left = 0, maximum = 1;
  for (let right = 0; right < events.length; right++) {
    while (events[left].frame + duration <= events[right].frame) left++;
    maximum = Math.max(maximum, right - left + 1);
  }
  return maximum;
}

export function renderSoundEffectBlock(input: SoundEffectRecipe, range: { start: number; count: number; sampleRate?: number }): Float32Array {
  const r = validateSoundEffectRecipe(input);
  number(range.start, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "range start", true);
  number(range.count, 0, SOUND_EFFECT_LIMITS.maxBlockFrames, "range count (block budget)", true);
  if (!Number.isSafeInteger(range.start + range.count)) fail("range end is not a safe sample index");
  if (range.sampleRate !== undefined && range.sampleRate !== r.sampleRate) fail("render sampleRate must equal recipe sampleRate");
  const frames = Math.ceil(r.params.duration * r.sampleRate), gain = r.params.gain * 0.8 / maximumOverlap(r.events, frames);
  const mono = new Float64Array(range.count);
  const end = Math.min(range.start + range.count, r.frames);
  for (const event of r.events) {
    if (event.frame >= end) break;
    const begin = Math.max(0, range.start, event.frame), finish = Math.min(end, event.frame + frames);
    for (let at = begin; at < finish; at++) mono[at - range.start] += voice(r, event, at - event.frame, frames) * event.velocity * gain;
  }
  const output = new Float32Array(range.count * r.channels);
  for (let i = 0; i < range.count; i++) for (let channel = 0; channel < r.channels; channel++) output[i * r.channels + channel] = mono[i];
  return output;
}
