import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  kicker: string;
  kickerZh: string;
  value: number;
  prefix: string;
  suffix: string;
  footEn: string;
  footZh: string;
  countMs: number;
}

function StatProofCard({ params }: CardProps<Params>) {
  const v = useMotionValue(0);
  // 数字直接同步写进 DOM,不走 React state:导出时每帧截图前 React 的异步提交会和截图抢跑,
  // 实测 10~15% 的帧数字停在上一帧的值,导两遍不一样。同步写就落在 Motion 的同一次 rAF 里。
  // 写法照 magicui/vendor/number-ticker.tsx;初值写死在 JSX 里,免得重挂载后首帧空一下。
  const numRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const durationSec = params.countMs > 0 ? params.countMs / 1000 : 1.4;
    const controls = animate(v, params.value, {
      duration: durationSec,
      ease: easeExpoOut,
    });
    const unsub = v.on("change", (latest) => {
      if (numRef.current) numRef.current.textContent = String(Math.round(latest));
    });
    return () => {
      controls.stop();
      unsub();
    };
  }, [params.value, v, params.countMs]);

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass flex flex-col items-center gap-2 px-12 py-10 min-w-[500px]">
        <motion.div
          className="flex flex-col items-center gap-1 opacity-80"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: easeExpoOut }}
        >
          <div className="text-xl tracking-[0.2em] font-mono uppercase font-bold">{params.kicker}</div>
          <div className="text-lg tracking-widest">{params.kickerZh}</div>
        </motion.div>

        <div className="flex items-baseline my-4">
          {params.prefix && <span className="text-6xl font-bold mr-2 opacity-90">{params.prefix}</span>}
          <span
            className="text-[160px] font-bold leading-none"
            style={{ color: accentOf(params), fontVariantNumeric: "tabular-nums" }}
          >
            <span ref={numRef}>0</span>
          </span>
          {params.suffix && <span className="text-6xl font-bold ml-2 opacity-90">{params.suffix}</span>}
        </div>

        <motion.div
          className="flex flex-col items-center gap-1 opacity-60"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.4, ease: easeExpoOut }}
        >
          <div className="text-sm tracking-widest uppercase">{params.footEn}</div>
          <div className="text-base">{params.footZh}</div>
        </motion.div>
      </div>
    </div>
  );
}

export const statProof: CardDef<Params> = {
  id: "stat-proof",
  name: "数字实证",
  description: "巨型数字滚动及中英注脚",
  useWhen: "口播里出现要当证据用的核心数字(+80%、3 倍、2 万)时,用巨型数字配前后缀、中英引导字和中英数据来源注脚做实证版式。数值取整显示。只想要机械翻牌滚轮手感的大整数计数用 odometer。",
  tags: ["数字","实证","数据","注脚"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    kicker: "PERFORMANCE",
    kickerZh: "性能表现",
    value: 99,
    prefix: "+",
    suffix: "%",
    footEn: "DATA SOURCED FROM INTERNAL TESTING",
    footZh: "数据来自内部测试",
    countMs: 1200,
  },
  controls: [
    ...hudControls,
    { key: "kicker", label: "英文引导字", type: "text" },
    { key: "kickerZh", label: "中文引导字", type: "text" },
    { key: "value", label: "目标数值", type: "number" },
    { key: "prefix", label: "前缀", type: "text" },
    { key: "suffix", label: "后缀", type: "text" },
    { key: "footEn", label: "英文注脚", type: "text" },
    { key: "footZh", label: "中文注脚", type: "text" },
    { key: "countMs", label: "动画时长(ms)", type: "number", min: 100, max: 1800, step: 100 },
  ],
  parts: [
    { id: "title", label: "引导字", role: "group", params: ["kicker", "kickerZh"], enterMs: 0, settleMs: 600 },
    { id: "value", label: "数值", role: "text", params: ["value", "prefix", "suffix", "countMs"], enterMs: 0, settleMs: 1200 },
    { id: "foot", label: "注脚", role: "group", params: ["footEn", "footZh"], enterMs: 400, settleMs: 1200 },
  ],
  lifecycle: { settleMs: 1200, after: "hold", exit: ["fade"] },
  Component: StatProofCard,
};
