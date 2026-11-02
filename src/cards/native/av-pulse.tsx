/** PromptCut 原创声画示例：同一个片段的脉冲与提示音共用源时间。 */
import type { CardDef, CardProps } from "../../kernel/types";
import { createNotificationRecipe } from "../../kernel/soundEffects";
import { cardSoundBlock } from "./sound-effects";
interface Params { color: string; frequency: number; gain: number; duration: number }
function Pulse({ params, t = 0 }: CardProps<Params>) {
  const progress = Math.min(1, Math.max(0, t / params.duration));
  return <div className="absolute inset-0" style={{ display: "grid", placeItems: "center" }}>
    <div style={{ width: 180 + progress * 100, height: 180 + progress * 100, borderRadius: "50%",
      border: `8px solid ${params.color}`, opacity: 1 - progress }} />
  </div>;
}
export const audiovisualPulse: CardDef<Params> = {
  id: "av-pulse", name: "Audio-visual cue pulse", source: "native",
  description: "A ring expands with a short notification sound; the visual and the sound belong to the same clip and can be muted independently.",
  useWhen: "Use when a short confirmation motion graphic needs to sync precisely with a notification sound; the card sound is generated after adding.",
  frameMode: "direct", kind: "animation", inputs: {},
  defaults: { color: "#60a5fa", frequency: 880, gain: 0.3, duration: 0.3 },
  controls: [
    { key: "color", label: "Color", type: "color" },
    { key: "frequency", label: "Frequency", type: "number", min: 80, max: 3000 },
    { key: "gain", label: "Sound level", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "duration", label: "Pulse duration", type: "number", min: 0.08, max: 2, step: 0.01 },
  ],
  Component: Pulse,
  audio: (_sources, range, params) => cardSoundBlock(createNotificationRecipe({ frequency: params.frequency, gain: params.gain, duration: params.duration }), range),
  lifecycle: { after: "hold", exit: ["fade"] },
};
