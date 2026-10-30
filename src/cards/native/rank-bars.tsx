import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  title: string;
  rows: string;
  suffix: string;
}

function NumberTicker({ value, duration }: { value: number; duration: number }) {
  const v = useMotionValue(0);
  // 数字直接同步写进 DOM,不走 React state:导出时每帧截图前 React 的异步提交会和截图抢跑,
  // 实测 10~15% 的帧数字停在上一帧的值,导两遍不一样。同步写就落在 Motion 的同一次 rAF 里。
  // 写法照 magicui/vendor/number-ticker.tsx;初值写死在 JSX 里,免得重挂载后首帧空一下。
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const controls = animate(v, value, {
      duration: duration,
      ease: easeExpoOut,
    });
    const unsub = v.on("change", (latest) => {
      if (ref.current) ref.current.textContent = String(Math.round(latest));
    });
    return () => {
      controls.stop();
      unsub();
    };
  }, [value, v, duration]);

  return <span ref={ref}>0</span>;
}

function RankBarsCard({ params }: CardProps<Params>) {
  const rowData = params.rows.split("|").map((r) => {
    const [name, val] = r.split(",");
    return { name: name?.trim() || "", value: parseFloat(val) || 0 };
  });

  const maxVal = Math.max(...rowData.map((r) => r.value));
  const validMaxVal = maxVal > 0 ? maxVal : 1;

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass flex flex-col gap-8 min-w-[1000px]">
        {params.title && <div className="text-5xl font-bold">{params.title}</div>}
        <div className="flex flex-col gap-6">
          {rowData.map((row, i) => {
            const isFirst = row.value === maxVal && maxVal > 0;
            const widthPct = (row.value / validMaxVal) * 100;
            return (
              <motion.div
                key={i}
                className="flex items-center gap-4"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: i * 0.12, ease: easeExpoOut }}
              >
                <div className="w-44 text-3xl text-right opacity-90 truncate">{row.name}</div>
                <div className="flex-1 h-10 bg-black/20 rounded-full overflow-hidden relative">
                  <motion.div
                    className="absolute left-0 top-0 bottom-0 rounded-full"
                    style={{
                      backgroundColor: isFirst ? accentOf(params) : "rgba(255, 255, 255, 0.4)",
                    }}
                    initial={{ width: "0%" }}
                    animate={{ width: `${widthPct}%` }}
                    transition={{ duration: 0.9, delay: i * 0.12, ease: easeExpoOut }}
                  />
                </div>
                <div
                  className="w-32 text-4xl font-bold font-mono"
                  style={{
                    color: isFirst ? accentOf(params) : "var(--pc-fg, #f3f4f6)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <NumberTicker value={row.value} duration={0.9 + i * 0.12} />
                  {params.suffix && <span className="text-xl ml-1">{params.suffix}</span>}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const rankBars: CardDef<Params> = {
  id: "rank-bars",
  name: "排名条",
  description: "柱状条形排名及滚动数值",
  useWhen: "3 到 5 个项目比大小、排榜单时用条形图,条长和整数数值一起滚动,最大值那条自动高亮。**卡片不会自动排序**,rows 要按数值从大到小传进来;项目名不超过 5 字,超出会被截断。单个数字不要用,两项对决用 versus-card,时间走势用 growth-curve。",
  tags: ["排名","条形图","对比","榜单"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    title: "TOP 渠道转化率",
    rows: "微信,85|抖音,62|小红书,45|快手,30",
    suffix: "%",
  },
  controls: [
    ...hudControls,
    { key: "title", label: "标题", type: "text" },
    { key: "rows", label: "数据行 (名称,数值|名称,数值)", type: "text" },
    { key: "suffix", label: "数值后缀", type: "text" },
  ],
  parts: [
    { id: "title", label: "标题", role: "text", params: ["title"], enterMs: 0, settleMs: 0 },
    { id: "rows", label: "数据行", role: "list", params: ["rows", "suffix"], enterMs: 0, settleMs: 3 * 120 + 900 },
  ],
  lifecycle: { settleMs: 1260, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const rows = Math.max(1, p.rows.split("|").filter(Boolean).length);
    const settle = (rows - 1) * 120 + 900;
    return { settleMs: settle, parts: { rows: { settleMs: settle } } };
  },
  Component: RankBarsCard,
};
