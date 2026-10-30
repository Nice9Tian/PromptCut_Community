import { useMemo } from "react";
import { createTypingSchedule, typingScheduleOptionsFromParams } from "../../kernel/typingEvents";
import type { TypingScheduleOptions } from "../../kernel/typingEvents";
import type { CardDef, CardProps } from "../../kernel/types";
import { TypingAnimation } from "./vendor/typing-animation";

interface Params extends TypingScheduleOptions {
  text: string;
  duration: number;
}

function TypingAnimationCard({ params, t, sourceOffset = 0, mountClockMs }: CardProps<Params>) {
  const schedule = useMemo(() => createTypingSchedule(typingScheduleOptionsFromParams({ ...params })),
    [params.text, params.duration, params.delayMs, params.punctuationPauseMs, params.newlinePauseMs, params.jitterMs, params.seed, params.pauses, params.punctuationSound, params.whitespaceSound]);
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-transparent px-32" style={{ fontFamily: "var(--pc-font, system-ui, sans-serif)" }}>
      <TypingAnimation
        text={params.text}
        duration={params.duration}
        schedule={schedule}
        t={t}
        sourceOffset={sourceOffset}
        mountClockMs={mountClockMs}
        className="font-bold"
        style={{ fontSize: 80, lineHeight: "1.2", color: "var(--pc-fg, #f3f4f6)", textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))" }}
      />
    </div>
  );
}

export const typingAnimationCard: CardDef<Params> = {
  id: "mu-typing",
  name: "打字机",
  description: "逐字打印动画",
  useWhen: "逐字打印一行普通文字。**默认播放时长等于可见字素数乘以每字毫秒数**(默认 120ms,20 字就要 2.4 秒)，可选延迟、停顿与固定种子节奏变化，clip 给短了会打不完。需覆盖整段本地时间。此卡不发声；需要键盘声时显式生成独立音频段。要终端/代码风格用 terminal-3d。",
  tags: ["打字机","逐字","文字"],
  source: "magicui",
  // 保留原有 stateful 能力审阅；有舞台 t 时按共享事件随机访问，无 t 的独立预览沿 rAF 时钟。
  frameMode: "stateful",
  defaults: { text: "这是一段打字机测试文字", duration: 120 },
  controls: [
    { key: "text", label: "文本", type: "text" },
    { key: "duration", label: "每字毫秒", type: "number", min: 0, max: 60000 },
    { key: "delayMs", label: "开始延迟毫秒", type: "number", min: 0, max: 60000 },
    { key: "punctuationPauseMs", label: "标点后停顿毫秒", type: "number", min: 0, max: 60000 },
    { key: "newlinePauseMs", label: "换行后停顿毫秒", type: "number", min: 0, max: 60000 },
    { key: "jitterMs", label: "节奏抖动毫秒", type: "number", min: 0, max: 60000, hint: "不能超过每字毫秒；相同种子保持相同节奏。" },
    { key: "seed", label: "固定种子", type: "number", min: 0, max: 4294967295, step: 1 },
  ],
  parts: [
    { id: "text", label: "文字", role: "text", params: ["text", "duration", "delayMs", "punctuationPauseMs", "newlinePauseMs", "jitterMs", "seed"], enterMs: 0, settleMs: 1320 },
  ],
  lifecycle: { settleMs: 1320, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const settle = createTypingSchedule(typingScheduleOptionsFromParams({ ...p })).settleMs;
    return { settleMs: settle, parts: { text: { settleMs: settle } } };
  },
  Component: TypingAnimationCard,
};
