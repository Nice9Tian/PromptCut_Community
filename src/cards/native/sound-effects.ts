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
  id: "sound-notification", name: "合成提示音", source: "native", kind: "audio", frameMode: "direct", inputs: {},
  description: "原生合成的短提示音，支持柔和叮声、正弦、三角音色与短音列；无需录音素材。",
  useWhen: "给完成、揭晓、强调或转场加一个短提示音。先调现有参数；用生成音效入口保存 WAV 后作为独立音频段，避免与同一音频图卡重复播放。",
  tags: ["音频", "音效", "提示音", "叮", "合成", "notification"],
  defaults: { ...NOTIFICATION_SOUND_DEFAULTS, notes: "0", seed: 0 },
  controls: [
    { key: "frequency", label: "基频 Hz", type: "number", min: 80, max: 4000, step: 10 },
    { key: "waveform", label: "音色", type: "select", options: [{ value: "bell", label: "柔和叮声" }, { value: "sine", label: "正弦" }, { value: "triangle", label: "三角" }] },
    { key: "duration", label: "每音秒数", type: "number", min: 0.02, max: 5, step: 0.01 },
    { key: "attack", label: "起音秒数", type: "number", min: 0.001, max: 5, step: 0.001 },
    { key: "release", label: "收尾秒数", type: "number", min: 0.001, max: 5, step: 0.001 },
    { key: "gain", label: "音量", type: "number", min: 0, max: 1, step: 0.01, hint: "密集音符自动预留线性混音余量，不削波。" },
    { key: "notes", label: "音列半音", type: "text", hint: "1–8 个逗号分隔的半音偏移，范围 -24 到 24；例如 0,7,12。" },
    { key: "interval", label: "音符间隔秒", type: "number", min: 0, max: 5, step: 0.01 },
    { key: "seed", label: "固定种子", type: "number", min: 0, max: 4294967295, step: 1 },
  ],
  audio: (_sources, range, p) => {
    if (typeof p.notes !== "string" || !p.notes.trim()) throw new Error("提示音音列不能为空");
    const notes = p.notes.split(",").map((n) => { if (!n.trim()) throw new Error("音列包含空音符"); return Number(n.trim()); });
    return cardSoundBlock(createNotificationRecipe({ ...p, notes }, { seed: p.seed, sampleRate: range.sampleRate }), range);
  },
};

export const keyboardSoundCard: CardDef<KeyboardCardParams> = {
  id: "sound-keyboard", name: "合成键盘声", source: "native", kind: "audio", frameMode: "direct", inputs: {},
  description: "短瞬态、带限噪声与衰减共振合成的敲击声；与打字机共享字素事件，不是实体键盘录音。",
  useWhen: "为打字机文字单独配键盘声；复制文字、每字毫秒、延迟、停顿、抖动与种子，再生成持久 WAV 音频段。视觉卡始终静音，空格和换行默认静音，标点默认发声。",
  tags: ["音频", "音效", "键盘", "打字", "合成", "keyboard"],
  defaults: { ...KEYBOARD_SOUND_DEFAULTS, text: "这是一段打字机测试文字", duration: 120, keyDuration: 0.075, delayMs: 0, punctuationPauseMs: 0, newlinePauseMs: 0,
    jitterMs: 0, seed: 0, punctuationSound: "on", whitespaceSound: "off" },
  controls: [
    { key: "text", label: "文本", type: "text" },
    { key: "duration", label: "每字毫秒", type: "number", min: 0, max: 60000, step: 1 },
    { key: "delayMs", label: "开始延迟毫秒", type: "number", min: 0, max: 60000, step: 10 },
    { key: "punctuationPauseMs", label: "标点后停顿毫秒", type: "number", min: 0, max: 60000, step: 10 },
    { key: "newlinePauseMs", label: "换行后停顿毫秒", type: "number", min: 0, max: 60000, step: 10 },
    { key: "jitterMs", label: "节奏抖动毫秒", type: "number", min: 0, max: 60000, step: 1, hint: "不能超过每字毫秒。相同种子保持相同节奏。" },
    { key: "punctuationSound", label: "标点发声", type: "select", options: [{ value: "on", label: "发声" }, { value: "off", label: "静音" }] },
    { key: "whitespaceSound", label: "空格和换行", type: "select", options: [{ value: "off", label: "静音" }, { value: "on", label: "发声" }] },
    { key: "tone", label: "敲击音色", type: "select", options: [{ value: "soft", label: "柔和" }, { value: "mechanical", label: "明亮机械感" }] },
    { key: "keyDuration", label: "单次尾音秒", type: "number", min: 0.01, max: 0.5, step: 0.005 },
    { key: "frequency", label: "共振基频 Hz", type: "number", min: 100, max: 6000, step: 50 },
    { key: "brightness", label: "明亮度", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "variation", label: "敲击变化", type: "number", min: 0, max: 0.5, step: 0.01 },
    { key: "gain", label: "音量", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "seed", label: "固定种子", type: "number", min: 0, max: 4294967295, step: 1 },
  ],
  audio: (_sources, range, p) => cardSoundBlock(createTypingSoundRecipe(typingScheduleOptionsFromParams({ ...p }), { tone: p.tone,
    duration: p.keyDuration, frequency: p.frequency, brightness: p.brightness, variation: p.variation, gain: p.gain }, { seed: p.seed, sampleRate: range.sampleRate }), range),
};
