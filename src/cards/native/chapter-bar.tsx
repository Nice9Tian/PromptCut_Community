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
   * The **shared layout id** of the highlight block. Neither of the two parts can be dropped:
   *
   *   useId():   when two chapter bars are placed on the same screen, a hardcoded string would make
   *              the two fight over the same layoutId, and the highlight flies around between them.
   *   playToken: a remount needs a new id. `layoutId` is a "shared layout": the old node disappears and
   *              the new node appears, Motion treats this as a transition and lets the new highlight
   *              slide over from the old position. But a remount is a **replay**, not a transition.
   *              useId() cannot stop this: after a remount at the same tree position it is the same
   *              value.
   *
   * This is not fussiness: on a preview jump it remounts (StageView's setToken), while every export
   * pass is a brand-new page that never meets an old node. So the same frame differs between the two
   * sides: in testing the highlight in the preview had a projection-compensated translateY(-13.442px)
   * and the export had none; the first render on a brand-new page is byte-identical, which is direct
   * evidence for this.
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
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
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
