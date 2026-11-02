/**
 * Source: ported from Magic UI (https://magicui.design/docs/components/animated-shiny-text)
 * MIT License
 * Local changes: translator automatically rewrote @/lib/utils → ../magicui/vendor/cn;
 * wrapped into CardDef.
 */
import type { CardDef, CardProps } from "../../kernel/types";
import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type FC,
} from "react"

import { cn } from "../magicui/vendor/cn"

export interface AnimatedShinyTextProps extends ComponentPropsWithoutRef<"span"> {
  shimmerWidth?: number
}

const AnimatedShinyText: FC<AnimatedShinyTextProps> = ({
  children,
  className,
  shimmerWidth = 100,
  ...props
}) => {
  return (
    <span
      style={
        {
          "--shiny-width": `${shimmerWidth}px`,
        } as CSSProperties
      }
      className={cn(
        "mx-auto max-w-md text-neutral-600/70 dark:text-neutral-400/70",

        // Shine effect
        "animate-shiny-text bg-size-[var(--shiny-width)_100%] bg-clip-text bg-position-[0_0] bg-no-repeat [transition:background-position_1s_cubic-bezier(.6,.6,0,1)_infinite]",

        // Shine gradient
        "bg-linear-to-r from-transparent via-black/80 via-50% to-transparent dark:via-white/80",

        className
      )}
      {...props}
    >
      {children}
    </span>
  )
}


interface Params { text: string; shimmerWidth: number }

function ShinyTextCard({ params }: CardProps<Params>) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <AnimatedShinyText shimmerWidth={params.shimmerWidth} className="text-[140px] font-bold max-w-none">
        {params.text}
      </AnimatedShinyText>
    </div>
  );
}

export const muAnimatedShinyText: CardDef<Params> = {
  id: "mu-animated-shiny-text",
  name: "Shiny text",
  description: "A highlight sweeps across the text, looping",
  useWhen: "Use when a word or short phrase needs a \"glowing\" emphasis; the highlight loops every 8 seconds and never stops, suited to light backgrounds. No number rolling, no rotating through multiple words.",
  tags: ["Text", "highlight", "shine"],
  source: "magicui",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: { text: "PromptCut", shimmerWidth: 200 },
  controls: [
    { key: "text", label: "Text", type: "text" },
    { key: "shimmerWidth", label: "Highlight width (px)", type: "number", min: 50, max: 600, step: 10 },
  ],
  Component: ShinyTextCard,
};
