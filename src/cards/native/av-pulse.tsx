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
  id: "av-pulse", name: "声画提示脉冲", source: "native",
  description: "圆环随短提示音扩散；画面与声音属于同一片段，可独立静音。",
  useWhen: "需要短促的确认动效与提示音精确同步时；添加后生成卡片声音。",
  frameMode: "direct", kind: "animation", inputs: {},
  defaults: { color: "#60a5fa", frequency: 880, gain: 0.3, duration: 0.3 },
  controls: [
    { key: "color", label: "颜色", type: "color" },
    { key: "frequency", label: "频率", type: "number", min: 80, max: 3000 },
    { key: "gain", label: "声音强度", type: "number", min: 0, max: 1, step: 0.05 },
    { key: "duration", label: "脉冲时长", type: "number", min: 0.08, max: 2, step: 0.01 },
  ],
  Component: Pulse,
  audio: (_sources, range, params) => cardSoundBlock(createNotificationRecipe({ frequency: params.frequency, gain: params.gain, duration: params.duration }), range),
  lifecycle: { after: "hold", exit: ["fade"] },
};
