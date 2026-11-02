import { useId } from "react";
import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  chapters: string;
  showProgress: string;
  progMode: string;
  progAccent: string;
  progAlpha: number;
}

function ChapterBarCard({ params, t = 0, duration = 6, playToken = 0 }: CardProps<Params>) {
  /*
   * 高亮块的**共享布局 id**。两截都不能少:
   *
   *   useId()    —— 同屏摆两张章节条时,写死的字符串会让两张抢同一个 layoutId,高亮在两张卡之间乱飞。
   *   playToken  —— 重挂载要换一个新 id。`layoutId` 是「共享布局」:旧节点消失、新节点出现,
   *                 Motion 会把这当成一次过渡,让新高亮从旧位置滑过去。而重挂载是**重播**,
   *                 不是过渡。useId() 挡不住这个 —— 它在同一个树位置上重挂载后是同一个值。
   *
   * 这不是洁癖:预览跳转时会重挂载(StageView 的 setToken),导出每一趟都是全新页面、
   * 永远碰不到旧节点。于是同一帧两边不一样 —— 实测预览里高亮被投影补了 translateY(-13.442px),
   * 导出是 none;全新页面上第一次渲染则逐字节相同,正是这条的直接证据。
   */
  const gid = `${useId()}-${playToken}`;
  const rawChapters = params.chapters.split("|").filter(Boolean);
  const chaps = rawChapters.map((raw) => {
    const lastSpace = raw.lastIndexOf(" ");
    const name = raw.substring(0, lastSpace).trim();
    const start = parseFloat(raw.substring(lastSpace + 1));
    return { name, start };
  });

  let curIdx = 0;
  for (let i = 0; i < chaps.length; i++) {
    if (t >= chaps[i].start) {
      curIdx = i;
    }
  }

  const curStart = chaps[curIdx]?.start ?? 0;
  const nextStart = curIdx < chaps.length - 1 ? chaps[curIdx + 1].start : duration;
  let progress = (t - curStart) / (nextStart - curStart);
  if (isNaN(progress)) progress = 0;
  progress = Math.max(0, Math.min(1, progress));

  const pAccent = params.progAccent && params.progAccent.trim() ? params.progAccent : accentOf(params);

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`} style={{ alignItems: "flex-start", paddingTop: "80px" }}>
      <motion.div
        className="hud-glass"
        style={{ padding: "20px 32px", display: "flex", gap: "32px", borderRadius: "100px", alignItems: "center" }}
        initial={{ y: -120, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.8, ease: easeExpoOut }}
      >
        {chaps.map((chap, i) => {
          const isPast = i < curIdx;
          const isCur = i === curIdx;
          
          let color = "var(--pc-fg-faint)";
          if (isCur) color = accentOf(params);
          else if (isPast) color = "var(--pc-fg-muted)";

          return (
            <div key={i} className="relative px-8 py-4 rounded-full text-[48px] font-bold" style={{ zIndex: 1 }}>
              {isCur && (
                <motion.div
                  layoutId={`chapter-bg-${gid}`}
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

export const chapterBar: CardDef<Params> = {
  id: "chapter-bar",
  name: "Chapter navigation",
  description: "Chapter progress pinned to the top",
  useWhen: "The video is split into several chapters and needs a persistent progress indicator at the top to tell viewers which section is being covered. **Each line of chapters is formatted as \"chapter name, space, start seconds\"**; if the seconds are missing, progress stops working; a single horizontal row only fits 3 to 5 short chapter names. This card follows the timeline, so the clip must cover the whole span, not just a short piece.",
  tags: ["chapters","navigation","progress","persistent"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    position: "center",
    chapters: "选题 0|脚本 2|剪辑 4",
    showProgress: "true",
    progMode: "fill",
    progAccent: "",
    progAlpha: 0.45,
  },
  controls: [
    ...hudControls,
    { key: "chapters", label: "Chapters (name, seconds)", type: "text" },
    { key: "showProgress", label: "Show progress", type: "select", options: [{ value: "true", label: "yes" }, { value: "false", label: "no" }] },
    { key: "progMode", label: "Progress mode", type: "select", options: [{ value: "fill", label: "Fill" }, { value: "line", label: "Underline" }] },
    { key: "progAccent", label: "Progress color", type: "color" },
    { key: "progAlpha", label: "Progress opacity", type: "number", step: 0.1 },
  ],
  parts: [
    { id: "chapters", label: "chapters", role: "list", params: ["chapters", "showProgress", "progMode", "progAccent", "progAlpha"], enterMs: 0, settleMs: 800 },
  ],
  lifecycle: { settleMs: 800, after: "evolve", exit: ["fade"] },
  Component: ChapterBarCard,
};
