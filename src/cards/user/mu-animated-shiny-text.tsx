/**
 * 来源: 搬自 Magic UI (https://magicui.design/docs/components/animated-shiny-text)
 * MIT License
 * 本地改动: 翻译器自动改写 @/lib/utils → ../magicui/vendor/cn;包成 CardDef。
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
  name: "闪光文字",
  description: "一道高光从文字上扫过,循环",
  useWhen: "一个词或短句要「发光」地强调时用;高光 8 秒一循环、不会停,适合浅色底。不做数字滚动,不做多词轮换。",
  tags: ["文字", "高光", "闪光"],
  source: "magicui",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: { text: "PromptCut", shimmerWidth: 200 },
  controls: [
    { key: "text", label: "文字", type: "text" },
    { key: "shimmerWidth", label: "高光宽度(px)", type: "number", min: 50, max: 600, step: 10 },
  ],
  Component: ShinyTextCard,
};
