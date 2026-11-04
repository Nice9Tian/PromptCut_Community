import { motion } from "motion/react";
import { useId } from "react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut, accentOf } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * Chapter navigation bar.
 * Extracted from chapter-bar, highlights current chapter as time progresses.
 * Entrance: slides in from above.
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
   * Shared layout id must include playToken. `useId()` only solves "two copies on the same screen
   * competing for the same id", but cannot solve **remounting**: `layoutId` is for shared layout;
   * when an old node disappears and a new node appears, Motion treats it as a transition, sliding the
   * new highlight from the old position: remounting is a replay, not a transition. And `useId()`
   * produces the same value after remounting at the same tree position. Preview seeks cause remounts
   * and each export pass is a brand-new page, resulting in differences on the same frame between the
   * two sides (tested in chapter-bar, see description there).
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
  name: "Chapter navigation",
  description: "Chapter progress bar pinned to the top",
  useWhen: "Use when the video is split into several chapters and needs a persistent progress indicator. Each line of chapters has the format \"chapter name, space, start seconds\"; if the seconds are missing, progress breaks. A single horizontal row fits only 3 to 5 short chapter names. This part follows the timeline, so it must cover the whole video rather than a short stretch. Set totalSec to the full duration, as it determines how the last chapter's progress is computed.",
  tags: ["chapters","navigation","progress","persistent"],
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
    { key: "chapters", label: "Chapters (name, seconds)", type: "text" },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 120, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
    { key: "showProgress", label: "Show progress", type: "select", options: [{ value: "true", label: "yes" }, { value: "false", label: "no" }] },
    { key: "progMode", label: "Progress mode", type: "select", options: [{ value: "fill", label: "Fill" }, { value: "line", label: "Underline" }] },
    { key: "progAccent", label: "Progress color", type: "color" },
    { key: "progAlpha", label: "Progress opacity", type: "number", step: 0.1 },
    { key: "totalSec", label: "Total duration (seconds)", type: "number", step: 0.5 },
    { key: "accent", label: "Theme color", type: "color" },
  ],
  defaultFrame: { x: 960, y: 120, w: 1000, h: 100, anchor: [0.5, 0.5] },
  settleMs: () => 800,
  after: "evolve",
  Component: ListChaptersPart,
};
