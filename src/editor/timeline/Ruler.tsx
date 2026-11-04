import { useTimelineContext } from "./TimelineContext";
import { useStore } from "../../store/project";
import { useScrub } from "./useScrub";
import { xOfTime } from "./utils";
import { RenderBar } from "./RenderBar";
import { tr } from "../../i18n/index.ts";

/** Major tick label: mm:ss (00:05, 01:30). With a 0.5 second step a major tick can land on something like 2.5 seconds, so add one decimal digit (00:02.5) */
function mss(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.round((t - m * 60) * 1000) / 1000;
  const mm = String(m).padStart(2, "0");
  return Number.isInteger(s) ? `${mm}:${String(s).padStart(2, "0")}` : `${mm}:${s.toFixed(1).padStart(4, "0")}`;
}

/** Ruler height (px). The header of the track column (index.tsx) and the position of the playhead handle are both laid out by it */
export const RULER_H = 22;

/**
 * Time ruler: the only one at the top of the timeline (there is no longer a start-end range bar).
 * A major tick (every 5 cells) is a vertical line followed by an mm:ss time on its right; minor ticks are short vertical lines. All use a muted color so they do not compete with clips for attention.
 * The bottom edge line is the prerender progress (RenderBar), which takes no row of its own.
 */
export function Ruler() {
  const { pxPerSec } = useTimelineContext();
  const duration = useStore((s) => Math.max(s.project.duration, s.t + 10));
  const startScrub = useScrub();

  let step = 1;
  if (pxPerSec < 10) step = 10;
  else if (pxPerSec < 20) step = 5;
  else if (pxPerSec <= 200) step = 1;
  else if (pxPerSec <= 400) step = 0.5;
  else step = 0.1;

  // Prevent duration being stretched huge by content (tens of thousands of seconds) and generating tens of thousands of tick nodes that freeze the page: above 1200, jump up one tier
  while (duration / step > 1200) {
    if (step === 1) step = 2;
    else if (step === 2) step = 5;
    else if (step === 5) step = 10;
    else if (step === 10) step = 30;
    else if (step === 30) step = 60;
    else step *= 2;
  }

  const ticks: number[] = [];
  for (let i = 0; i <= duration; i += step) ticks.push(Math.round(i * 1000) / 1000);

  return (
    <div
      data-pc="ruler"
      className="pc-tl-ruler relative cursor-ew-resize overflow-hidden select-none touch-none"
      style={{ height: RULER_H }}
      onPointerDown={(e) => startScrub(e, { jumpToPointer: true })}
      title={tr("Press and drag = move the playhead (hold Alt to disable snapping)")}
    >
      {ticks.map((tick) => {
        const isMajor = Math.abs(tick % Math.max(1, step * 5)) < 1e-6 || tick === 0;
        return (
          <div
            key={tick}
            className={`pc-tl-tick${isMajor ? " is-major" : ""}`}
            style={{ left: `${xOfTime(tick, pxPerSec)}px` }}
          >
            {isMajor && <span className="pc-tl-tick-label">{mss(tick)}</span>}
          </div>
        );
      })}
      <div className="pc-tl-ruler-progress">
        <RenderBar />
      </div>
    </div>
  );
}
