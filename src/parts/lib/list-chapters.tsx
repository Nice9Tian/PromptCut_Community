import { motion } from "motion/react";
import { useId } from "react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut, accentOf } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * 章节导航条。
 * 从 chapter-bar 拆出，随时间推进高亮当前章节。
 * 进场: 从上方滑入。
 */
interface Params {
  chapters: string;
  size: number;
  showProgress: string;
  progMode: string;
  progAccent: string;
  progAlpha: number;
  totalSec: number;
  accent: string;
}

function ListChaptersPart({ params, t, width, height, playToken }: PartProps<Params>) {
  /*
   * 共享布局 id 要带上 playToken。useId() 只解决「同屏两份抢同一个 id」,
   * 解决不了**重挂载**:`layoutId` 是共享布局,旧节点消失、新节点出现时 Motion 会当成一次过渡,
   * 让新高亮从旧位置滑过去 —— 而重挂载是重播,不是过渡。而 useId() 在同一个树位置重挂载后是同一个值。
   * 预览跳转会重挂载、导出每趟都是全新页面,于是同一帧两边不一样(chapter-bar 上实测过,见那边的说明)。
   */
  const layoutId = `${useId()}-${playToken}`;
  const rawChapters = params.chapters.split("|").filter(Boolean);
  const chaps = rawChapters.map((raw: string) => {
    const lastSpace = raw.lastIndexOf(" ");
    const name = raw.substring(0, lastSpace).trim();
    const start = parseFloat(raw.substring(lastSpace + 1));
    return { name, start };
  });

  const n = Math.max(1, chaps.length);
  const size = fitOr(params.size, {
    width: width - 64 - (n - 1) * 32 - n * 64,
    height,
    text: chaps.map((c) => c.name).join(""),
    lineHeight: 1.25 + 32 / 48,
    max: 120,
  });

  let curIdx = 0;
  for (let i = 0; i < chaps.length; i++) {
    if (t >= chaps[i].start) {
      curIdx = i;
    }
  }

  const curStart = chaps[curIdx]?.start ?? 0;
  const nextStart = curIdx < chaps.length - 1 ? chaps[curIdx + 1].start : params.totalSec;
  let progress = (t - curStart) / (nextStart - curStart);
  if (isNaN(progress)) progress = 0;
  progress = Math.max(0, Math.min(1, progress));

  const pAccent = params.progAccent && params.progAccent.trim() ? params.progAccent : accentOf(params);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "center", width }}>
      <motion.div
        className="hud-glass"
        style={{ padding: "20px 32px", display: "flex", gap: "32px", borderRadius: "100px", alignItems: "center", alignSelf: "flex-start" }}
        initial={{ y: -120, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.8, ease: easeExpoOut }}
      >
        {chaps.map((chap: { name: string, start: number }, i: number) => {
          const isPast = i < curIdx;
          const isCur = i === curIdx;
          
          let color = "var(--pc-fg-faint)";
          if (isCur) color = accentOf(params);
          else if (isPast) color = "var(--pc-fg-muted)";

          return (
            <div key={i} className="relative px-8 py-4 rounded-full font-bold" style={{ zIndex: 1, fontSize: size }}>
              {isCur && (
                <motion.div
                  layoutId={`chapter-bg-${layoutId}`}
                  className="absolute inset-0"
                  style={{ backgroundColor: accentOf(params), opacity: 0.18, zIndex: -1, borderRadius: "9999px" }}
                  transition={{ duration: 0.4, ease: easeExpoOut }}
                />
              )}
              {isCur && params.showProgress === "true" && params.progMode === "fill" && (
                <div
                  className="absolute inset-0 rounded-full overflow-hidden"
                  style={{ zIndex: -1 }}
                >
                  <div
                    className="absolute inset-y-0 left-0"
                    style={{
                      backgroundColor: pAccent,
                      opacity: params.progAlpha,
                      width: `${progress * 100}%`,
                    }}
                  />
                </div>
              )}
              {isCur && params.showProgress === "true" && params.progMode === "line" && (
                <div
                  className="absolute bottom-0 left-0 h-2"
                  style={{
                    backgroundColor: pAccent,
                    opacity: params.progAlpha,
                    width: "100%",
                    transform: `scaleX(${progress})`,
                    transformOrigin: "left",
                    zIndex: -1
                  }}
                />
              )}
              <span style={{ color, position: "relative", zIndex: 1 }}>{chap.name}</span>
            </div>
          );
        })}
      </motion.div>
    </div>
  );
}

export const listChapters: PartDef<Params> = {
  id: "list-chapters",
  name: "章节导航",
  description: "常驻顶部的章节进度条",
  useWhen: "视频分成了几个章节、需要一条常驻的进度指示;chapters 每行格式是「章节名 空格 起始秒数」,漏了秒数进度会失效;横排单行只放得下 3 到 5 个短章节名;这个部件跟着时间轴走,要覆盖整段而不是一小截;totalSec 要填整段时长,它决定最后一章的进度怎么算。",
  tags: ["章节","导航","进度","常驻"],
  role: "list",
  from: "chapter-bar",
  defaults: {
    chapters: "选题 0|脚本 2|剪辑 4",
    size: 0,
    showProgress: "true",
    progMode: "fill",
    progAccent: "",
    progAlpha: 0.45,
    totalSec: 6,
    accent: "",
  },
  controls: [
    { key: "chapters", label: "章节(名称 秒)", type: "text" },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 120, step: 2, hint: "0 表示按部件的框自动算;想固定就填具体像素" },
    { key: "showProgress", label: "显示进度", type: "select", options: [{ value: "true", label: "是" }, { value: "false", label: "否" }] },
    { key: "progMode", label: "进度模式", type: "select", options: [{ value: "fill", label: "填充" }, { value: "line", label: "底线" }] },
    { key: "progAccent", label: "进度颜色", type: "color" },
    { key: "progAlpha", label: "进度透明度", type: "number", step: 0.1 },
    { key: "totalSec", label: "整段时长(秒)", type: "number", step: 0.5 },
    { key: "accent", label: "主题色", type: "color" },
  ],
  defaultFrame: { x: 960, y: 120, w: 1000, h: 100, anchor: [0.5, 0.5] },
  settleMs: () => 800,
  after: "evolve",
  Component: ListChaptersPart,
};
