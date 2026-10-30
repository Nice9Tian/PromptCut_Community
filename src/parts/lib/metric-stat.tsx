import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useRef } from "react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut, accentOf } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * 数据证明。
 * 从 stat-proof 拆出来的文字部件，包含巨型滚动数字及中英注脚。
 * 进场: 引导字淡入下移，数值滚动，注脚稍后淡入。
 */
interface Params {
  kicker: string;
  kickerZh: string;
  value: number;
  prefix: string;
  suffix: string;
  footEn: string;
  footZh: string;
  countMs: number;
  accent: string;
  size: number;
}

function MetricStatPart({ params, width, height }: PartProps<Params>) {
  const v = useMotionValue(0);
  const numRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const durationSec = params.countMs > 0 ? params.countMs / 1000 : 1.4;
    const controls = animate(v, params.value, {
      duration: durationSec,
      ease: easeExpoOut,
    });
    const unsub = v.on("change", (latest: number) => {
      if (numRef.current) numRef.current.textContent = String(Math.round(latest));
    });
    return () => {
      controls.stop();
      unsub();
    };
  }, [params.value, v, params.countMs]);

  const size = fitOr(params.size, { width: width - 96, height: height - 80, text: (params.prefix || "") + String(params.value) + (params.suffix || ""), lines: 1.5, max: 400 });

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "center", alignItems: "center", width, height }}>
      <div className="hud-glass flex flex-col items-center justify-center gap-2 px-12 py-10 w-full h-full">
        <motion.div
          className="flex flex-col items-center gap-1 opacity-80"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: easeExpoOut }}
        >
          <div className="tracking-[0.2em] font-mono uppercase font-bold" style={{ fontSize: size * 0.125 }}>{params.kicker}</div>
          <div className="tracking-widest" style={{ fontSize: size * 0.1125 }}>{params.kickerZh}</div>
        </motion.div>

        <div className="flex items-baseline my-4">
          {params.prefix && <span className="font-bold mr-2 opacity-90" style={{ fontSize: size * 0.375 }}>{params.prefix}</span>}
          <span
            className="font-bold leading-none"
            style={{ color: accentOf(params), fontVariantNumeric: "tabular-nums", fontSize: size }}
          >
            <span ref={numRef}>0</span>
          </span>
          {params.suffix && <span className="font-bold ml-2 opacity-90" style={{ fontSize: size * 0.375 }}>{params.suffix}</span>}
        </div>

        <motion.div
          className="flex flex-col items-center gap-1 opacity-60"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.4, ease: easeExpoOut }}
        >
          <div className="tracking-widest uppercase" style={{ fontSize: size * 0.0875 }}>{params.footEn}</div>
          <div style={{ fontSize: size * 0.1 }}>{params.footZh}</div>
        </motion.div>
      </div>
    </div>
  );
}

export const metricStat: PartDef<Params> = {
  id: "metric-stat",
  name: "数字实证",
  description: "巨型数字滚动及中英注脚",
  useWhen: "要当证据用的核心数字(+80%、3 倍、2 万),带前后缀、中英引导字和中英来源注脚;数值取整显示;只要机械翻牌滚轮手感的大整数用 metric-odometer,百分比进度环用 metric-ring。",
  tags: ["数字","实证","数据","注脚"],
  role: "text",
  from: "stat-proof",
  defaults: {
    kicker: "PERFORMANCE",
    kickerZh: "性能表现",
    value: 99,
    prefix: "+",
    suffix: "%",
    footEn: "DATA SOURCED FROM INTERNAL TESTING",
    footZh: "数据来自内部测试",
    countMs: 1200,
    accent: "",
    size: 0,
  },
  controls: [
    { key: "kicker", label: "英文引导字", type: "text" },
    { key: "kickerZh", label: "中文引导字", type: "text" },
    { key: "value", label: "目标数值", type: "number" },
    { key: "prefix", label: "前缀", type: "text" },
    { key: "suffix", label: "后缀", type: "text" },
    { key: "footEn", label: "英文注脚", type: "text" },
    { key: "footZh", label: "中文注脚", type: "text" },
    { key: "countMs", label: "动画时长(ms)", type: "number", min: 100, max: 1800, step: 100 },
    { key: "accent", label: "主题色", type: "color" },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 400, step: 2, hint: "0 表示按部件的框自动算;想固定就填具体像素" },
  ],
  defaultFrame: { x: 960, y: 540, w: 600, h: 460, anchor: [0.5, 0.5] },
  settleMs: (p: Params) => (p.countMs > 0 ? p.countMs : 1400),
  after: "hold",
  Component: MetricStatPart,
};
