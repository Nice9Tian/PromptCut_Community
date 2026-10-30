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
  name: "模糊浮现",
  description: "文字从模糊中浮现",
  useWhen: "Magic UI 的整块模糊浮现。要词块逐个浮现的节奏感优先用 blur-text。",
  tags: ["浮现","模糊","文字"],
  source: "magicui",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: { text: "你好世界", accent: "", position: "center" },
  controls: [
    { key: "text", label: "文本", type: "text" },
    { key: "accent", label: "主色(留空用主题色)", type: "color" },
    {
      key: "position",
      label: "位置",
      type: "select",
      options: [
        { value: "center", label: "居中" },
        { value: "bottom", label: "底部" },
      ],
    },
  ],
  parts: [
    { id: "text", label: "文字", role: "text", params: ["text", "accent", "position"], enterMs: 0, settleMs: 400 },
  ],
  lifecycle: { settleMs: 400, after: "hold", exit: ["fade"] },
  Component: BlurFadeCard,
};
