/**
 * 来源: 复刻自 Magic UI (https://magicui.design/docs/components/word-rotate)
 * MIT License
 * 
 * 本地改动:
 * - 移除了 setInterval，改用 requestAnimationFrame + performance.now() 轮播。
 * - 从 motion/react 导入。
 * - 使用本地 cn。
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "./cn";

interface WordRotateProps {
  words: string[];
  duration?: number;
  framerProps?: any;
  className?: string;
}

export function WordRotate({
  words,
  duration = 2500,
  framerProps = {
    initial: { opacity: 0, y: -50 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 50 },
    transition: { duration: 0.25, ease: "easeOut" },
  },
  className,
}: WordRotateProps) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let rAF: number;
    const t0 = performance.now();

    /**
     * 第几个词**只由「挂载以来过了多久」决定**,不累加、不漂移。
     *
     * 原来是 `now - lastTick >= duration` 命中后 `lastTick = now` —— 每轮换一次就把相位挪到
     * 「哪一帧先看见它」的那个时刻上,于是周期实际是 duration + 一帧,而且相位记在状态里。
     * 在导出里这条会咬人:轮换恰好落在某一帧时,看到的是换词过渡的哪一段,取决于这一帧之前
     * 一共推过多少帧 —— 也就是**这张卡摆在时间轴哪个位置**。实测(duration=1000、30fps、
     * 取片内第 2 秒):摆在 0/0.5/1 秒处预渲染出来是一张图,摆在 2/3/4/6/12 秒处是另一张,
     * 差 22599 个像素、最大通道差 250(换句话说板子上显示的是上一个词还是下一个词)。
     * 而卡片参数一个字都没改。
     *
     * 改成 floor(elapsed / duration) 之后,同样的片内时刻永远算出同样的下标,和绝对位置无关。
     * 顺带把真机上那个「周期比 duration 多一帧」的漂移也修了。
     * setIndex 传同一个值时 React 自己会跳过重渲染,所以每帧都算不会多花什么。
     */
    const tick = (now: number) => {
      setIndex(Math.floor(Math.max(0, now - t0) / duration) % words.length);
      rAF = requestAnimationFrame(tick);
    };

    rAF = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rAF);
  }, [words, duration]);

  return (
    <div className="overflow-hidden py-2">
      <AnimatePresence mode="wait">
        <motion.h1
          key={words[index]}
          className={cn(className)}
          {...framerProps}
        >
          {words[index]}
        </motion.h1>
      </AnimatePresence>
    </div>
  );
}
