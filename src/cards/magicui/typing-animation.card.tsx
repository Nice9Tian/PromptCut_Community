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
  name: "Typewriter",
  description: "Character-by-character typing animation",
  useWhen: "Types out a line of plain text character by character. **The default playback duration equals the number of visible graphemes times milliseconds per character** (default 120ms, so 20 characters take 2.4 seconds), with optional delay, pauses and seeded rhythm variation; if the clip is too short the typing will not finish. It must cover the whole local time range. This card makes no sound; when keyboard sound is needed, explicitly generate a separate audio clip. For terminal/code style use terminal-3d.",
  tags: ["Typewriter","character by character","Text"],
  source: "magicui",
  // Keep the original stateful capability review; with a stage t, random access goes by the shared
  // events, and a standalone preview without t follows the rAF clock.
  frameMode: "stateful",
  defaults: { text: "这是一段打字机测试文字", duration: 120 },
  controls: [
    { key: "text", label: "Text", type: "text" },
    { key: "duration", label: "Milliseconds per character", type: "number", min: 0, max: 60000 },
    { key: "delayMs", label: "Start delay (ms)", type: "number", min: 0, max: 60000 },
    { key: "punctuationPauseMs", label: "Pause after punctuation (ms)", type: "number", min: 0, max: 60000 },
    { key: "newlinePauseMs", label: "Pause after line break (ms)", type: "number", min: 0, max: 60000 },
    { key: "jitterMs", label: "Rhythm jitter (ms)", type: "number", min: 0, max: 60000, hint: "Must not exceed milliseconds per character; the same seed keeps the same rhythm." },
    { key: "seed", label: "Fixed seed", type: "number", min: 0, max: 4294967295, step: 1 },
  ],
  parts: [
    { id: "text", label: "Text", role: "text", params: ["text", "duration", "delayMs", "punctuationPauseMs", "newlinePauseMs", "jitterMs", "seed"], enterMs: 0, settleMs: 1320 },
  ],
  lifecycle: { settleMs: 1320, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const settle = createTypingSchedule(typingScheduleOptionsFromParams({ ...p })).settleMs;
    return { settleMs: settle, parts: { text: { settleMs: settle } } };
  },
  Component: TypingAnimationCard,
};
