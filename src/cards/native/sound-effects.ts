/** Original PromptCut TypeScript synthesis presets; no recorded or third-party audio samples. */
import type { CardDef, GraphAudioRange } from "../../kernel/types";
import { createNotificationRecipe, createTypingSoundRecipe, renderSoundEffectBlock, KEYBOARD_SOUND_DEFAULTS, NOTIFICATION_SOUND_DEFAULTS } from "../../kernel/soundEffects.ts";
import type { KeyboardSoundParams, NotificationSoundParams, SoundEffectRecipe } from "../../kernel/soundEffects.ts";
import { typingScheduleOptionsFromParams } from "../../kernel/typingEvents.ts";

interface NotificationCardParams extends Omit<NotificationSoundParams, "notes"> { notes: string; seed: number }
interface KeyboardCardParams extends Omit<KeyboardSoundParams, "duration"> {
  text: string; duration: number; keyDuration: number; delayMs: number; punctuationPauseMs: number; newlinePauseMs: number;
  jitterMs: number; seed: number; punctuationSound: "on" | "off"; whitespaceSound: "on" | "off";
}

/** Host cardAudio requests up to 1,048,576 frames; keep inner synthesis blocks small. */
export async function cardSoundBlock(recipe: SoundEffectRecipe, range: GraphAudioRange): Promise<Float32Array> {
  if (!Number.isSafeInteger(range.count) || range.count < 0 || range.count > 1_048_576 || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.start + range.count)) {
    throw new Error("Sound card range exceeds the host block budget");
  }
  const output = new Float32Array(range.count * recipe.channels);
  for (let offset = 0; offset < range.count; offset += 4096) {
    const count = Math.min(4096, range.count - offset);
    output.set(renderSoundEffectBlock(recipe, { ...range, start: range.start + offset, count }), offset * recipe.channels);
    // Yield only generation flow work; the timer never enters the sample formula.
    if (offset + count < range.count) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return output;
}

export const notificationSoundCard: CardDef<NotificationCardParams> = {
  id: "sound-notification", name: "Synthesized notification sound", source: "native", kind: "audio", frameMode: "direct", inputs: {},
  description: "A short, natively synthesized notification sound with soft bell, sine and triangle voices and short note sequences; no recorded media needed.",
  useWhen: "Add a short notification sound for completion, reveal, emphasis or a transition. Tune the existing parameters first; save a WAV through the sound effect generation entry and use it as a standalone audio segment, to avoid playing twice with the same audio graph card.",
  tags: ["audio", "Sound effect", "Notification sound", "叮", "synthesis", "notification"],
  defaults: { ...NOTIFICATION_SOUND_DEFAULTS, notes: "0", seed: 0 },
  controls: [
    { key: "frequency", label: "Base frequency Hz", type: "number", min: 80, max: 4000, step: 10 },
    { key: "waveform", label: "Voice", type: "select", options: [{ value: "bell", label: "Soft bell" }, { value: "sine", label: "Sine" }, { value: "triangle", label: "Triangle" }] },
    { key: "duration", label: "Seconds per note", type: "number", min: 0.02, max: 5, step: 0.01 },
    { key: "attack", label: "Attack seconds", type: "number", min: 0.001, max: 5, step: 0.001 },
    { key: "release", label: "Release seconds", type: "number", min: 0.001, max: 5, step: 0.001 },
    { key: "gain", label: "Volume", type: "number", min: 0, max: 1, step: 0.01, hint: "Dense notes automatically reserve linear mixing headroom, without clipping." },
    { key: "notes", label: "Note semitones", type: "text", hint: "1-8 comma-separated semitone offsets, range -24 to 24; for example 0,7,12." },
    { key: "interval", label: "Note interval seconds", type: "number", min: 0, max: 5, step: 0.01 },
    { key: "seed", label: "Fixed seed", type: "number", min: 0, max: 4294967295, step: 1 },
  ],
  audio: (_sources, range, p) => {
    if (typeof p.notes !== "string" || !p.notes.trim()) throw new Error("提示音音列不能为空");
    const notes = p.notes.split(",").map((n) => { if (!n.trim()) throw new Error("音列包含空音符"); return Number(n.trim()); });
    return cardSoundBlock(createNotificationRecipe({ ...p, notes }, { seed: p.seed, sampleRate: range.sampleRate }), range);
  },
};

export const keyboardSoundCard: CardDef<KeyboardCardParams> = {
  id: "sound-keyboard", name: "Synthesized keyboard sound", source: "native", kind: "audio", frameMode: "direct", inputs: {},
  description: "Keystroke sounds synthesized from short transients, band-limited noise and decaying resonance; shares grapheme events with the typewriter, not a recording of a physical keyboard.",
  useWhen: "Add a separate keyboard sound for typewriter text; copy the text, milliseconds per character, delay, pause, jitter and seed, then generate a persistent WAV audio segment. Visual cards are always muted, spaces and newlines are muted by default, and punctuation sounds by default.",
  tags: ["audio", "Sound effect", "keyboard", "Typing", "synthesis", "keyboard"],
  defaults: { ...KEYBOARD_SOUND_DEFAULTS, text: "这是一段打字机测试文字", duration: 120, keyDuration: 0.075, delayMs: 0, punctuationPauseMs: 0, newlinePauseMs: 0,
    jitterMs: 0, seed: 0, punctuationSound: "on", whitespaceSound: "off" },
  controls: [
    { key: "text", label: "Text", type: "text" },
    { key: "duration", label: "Milliseconds per character", type: "number", min: 0, max: 60000, step: 1 },
    { key: "delayMs", label: "Start delay (ms)", type: "number", min: 0, max: 60000, step: 10 },
    { key: "punctuationPauseMs", label: "Pause after punctuation (ms)", type: "number", min: 0, max: 60000, step: 10 },
    { key: "newlinePauseMs", label: "Pause after line break (ms)", type: "number", min: 0, max: 60000, step: 10 },
    { key: "jitterMs", label: "Rhythm jitter (ms)", type: "number", min: 0, max: 60000, step: 1, hint: "Cannot exceed milliseconds per character. The same seed keeps the same rhythm." },
    { key: "punctuationSound", label: "Punctuation sound", type: "select", options: [{ value: "on", label: "Sound" }, { value: "off", label: "Muted" }] },
    { key: "whitespaceSound", label: "Spaces and newlines", type: "select", options: [{ value: "off", label: "Muted" }, { value: "on", label: "Sound" }] },
    { key: "tone", label: "Keystroke voice", type: "select", options: [{ value: "soft", label: "Soft" }, { value: "mechanical", label: "Bright mechanical" }] },
    { key: "keyDuration", label: "Single-key tail (s)", type: "number", min: 0.01, max: 0.5, step: 0.005 },
    { key: "frequency", label: "Resonance base frequency (Hz)", type: "number", min: 100, max: 6000, step: 50 },
    { key: "brightness", label: "Brightness", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "variation", label: "Keystroke variation", type: "number", min: 0, max: 0.5, step: 0.01 },
    { key: "gain", label: "Volume", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "seed", label: "Fixed seed", type: "number", min: 0, max: 4294967295, step: 1 },
  ],
  audio: (_sources, range, p) => cardSoundBlock(createTypingSoundRecipe(typingScheduleOptionsFromParams({ ...p }), { tone: p.tone,
    duration: p.keyDuration, frequency: p.frequency, brightness: p.brightness, variation: p.variation, gain: p.gain }, { seed: p.seed, sampleRate: range.sampleRate }), range),
};
