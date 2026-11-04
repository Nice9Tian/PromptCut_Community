import type { CardDef, CardProps } from "../../kernel/types";
import { BlurFade } from "./vendor/blur-fade";
import { accentOf } from "../native/hud";

interface Params {
  text: string;
  accent: string;
  position: "center" | "bottom";
}

function BlurFadeCard({ params }: CardProps<Params>) {
  const isBottom = params.position === "bottom";
  return (
    <div className={`absolute inset-0 flex ${isBottom ? 'items-end pb-32' : 'items-center'} justify-center bg-transparent`} style={{ fontFamily: "var(--pc-font, system-ui, sans-serif)" }}>
      <BlurFade startImmediately={true} delay={0} yOffset={20}>
        <h2 className="text-[96px] font-bold" style={{ color: accentOf(params), textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))" }}>
          {params.text}
        </h2>
      </BlurFade>
    </div>
  );
}

export const blurFadeCard: CardDef<Params> = {
  id: "mu-blur-fade",
  name: "Blur fade",
  description: "Text fades in from blur",
  useWhen: "Magic UI's whole-block blur fade. For the rhythm of word chunks fading in one by one, prefer blur-text.",
  tags: ["fade-in","blur","Text"],
  source: "magicui",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: { text: "你好世界", accent: "", position: "center" },
  controls: [
    { key: "text", label: "Text", type: "text" },
    { key: "accent", label: "Main color (leave empty to use theme color)", type: "color" },
    {
      key: "position",
      label: "Position",
      type: "select",
      options: [
        { value: "center", label: "Center" },
        { value: "bottom", label: "Bottom" },
      ],
    },
  ],
  parts: [
    { id: "text", label: "Text", role: "text", params: ["text", "accent", "position"], enterMs: 0, settleMs: 400 },
  ],
  lifecycle: { settleMs: 400, after: "hold", exit: ["fade"] },
  Component: BlurFadeCard,
};
