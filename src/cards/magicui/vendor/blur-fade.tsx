/**
 * 来源: 复刻自 Magic UI (https://magicui.design/docs/components/blur-fade)
 * MIT License
 * 
 * 本地改动:
 * - 从 motion/react 导入。
 * - 增加 startImmediately 参数跳过 useInView。
 * - 引入本地 cn。
 * - 移除了写死的 0.04 延迟，完全由参数传入的 delay 控制。
 */
import { useRef } from "react";
import { AnimatePresence, motion, Variants } from "motion/react";
import { cn } from "./cn";

interface BlurFadeProps {
  children: React.ReactNode;
  className?: string;
  variant?: {
    hidden: { y: number };
    visible: { y: number };
  };
  duration?: number;
  delay?: number;
  yOffset?: number;
  startImmediately?: boolean;
  blur?: string;
}

export function BlurFade({
  children,
  className,
  variant,
  duration = 0.4,
  delay = 0,
  yOffset = 6,
  startImmediately = true,
  blur = "6px",
}: BlurFadeProps) {
  const ref = useRef(null);
  const inView = startImmediately ? true : false;
  
  const defaultVariants: Variants = {
    hidden: { y: yOffset, opacity: 0, filter: `blur(${blur})` },
    visible: { y: -yOffset, opacity: 1, filter: `blur(0px)` },
  };
  const combinedVariants = variant || defaultVariants;

  return (
    <AnimatePresence>
      <motion.div
        ref={ref}
        initial="hidden"
        animate={inView ? "visible" : "hidden"}
        exit="hidden"
        variants={combinedVariants}
        transition={{
          delay: delay,
          duration,
          ease: "easeOut",
        }}
        className={className}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
