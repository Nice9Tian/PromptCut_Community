import type { PartDef, PartProps } from "../../kernel/partTypes";
import { BlurFade } from "../../cards/magicui/vendor/blur-fade";
import { accentOf } from "../../cards/native/hud";
import { fitOr } from "../fit";

/**
 * Blur-fade text: extracted from mu-blur-fade.
 * Reuses Magic UI's BlurFade, supports custom text and theme color, centered within part box.
 */
interface Params {
  text: string;
  size: number;
  accent: string;
}

function BlurFadePart({ params, width, height }: PartProps<Params>) {
  const size = fitOr(params.size, { width, height, text: params.text, max: 240 });
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        fontFamily: "var(--pc-font, system-ui, sans-serif)",
      }}
    >
      <BlurFade startImmediately={true} delay={0} yOffset={20}>
        <h2
          className="font-bold"
          style={{
            fontSize: size,
            color: accentOf(params),
            textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))",
            margin: 0,
          }}
        >
          {params.text}
        </h2>
      </BlurFade>
    </div>
  );
}

export const textBlurfade: PartDef<Params> = {
  id: "text-blurfade",
  name: "Blur fade-in (whole)",
  description: "Text emerges from a blur as a whole",
  useWhen: "Magic UI's whole-block blur reveal, suited to a short title or a single sentence; for a rhythm where word chunks emerge one by one, use text-blur.",
  tags: ["fade-in", "blur", "Text"],
  role: "text",
  from: "mu-blur-fade",
  defaults: {
    text: "你好世界",
    size: 0,
    accent: "",
  },
  controls: [
    { key: "text", label: "Text", type: "text", required: true },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 240, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
    { key: "accent", label: "Main color (leave empty to use theme color)", type: "color" },
  ],
  defaultFrame: { x: 360, y: 440, w: 1200, h: 200 },
  settleMs: () => 400,
  after: "hold",
  Component: BlurFadePart,
};
