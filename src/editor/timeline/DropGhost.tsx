import { useTimelineContext } from "./TimelineContext";
import type { DropPlan } from "./dropPlan";
import { xOfTime } from "./utils";

/**
 * 落点预览:拖动过程中画出「松手后片段会长在哪、多长」。
 * 蓝 = 就落在这;黄 = 这段被占了,会顺延到后面的空档;红 = 落不下。
 */
export function DropGhost({ plan }: { plan: DropPlan }) {
  const { pxPerSec } = useTimelineContext();

  const tone =
    plan.status === "forbidden"
      ? "border-red-500 bg-red-500/20 text-red-100"
      : plan.status === "shift"
        ? "border-amber-400 bg-amber-400/20 text-amber-100"
        : "border-[var(--ui-accent)] bg-[var(--ui-accent-soft)] text-[var(--ui-fg)]";

  return (
    <div
      data-pc="drop-ghost"
      className={`absolute top-1 bottom-1 z-30 flex items-center gap-2 rounded border border-dashed px-1.5 overflow-hidden pointer-events-none ${tone}`}
      style={{
        left: `${xOfTime(plan.start, pxPerSec)}px`,
        width: `${Math.max(4, (plan.end - plan.start) * pxPerSec)}px`,
      }}
    >
      <span className="truncate text-[11px] font-medium">{plan.label}</span>
      {plan.hint && <span className="ml-auto truncate text-[10px] opacity-80">{plan.hint}</span>}
    </div>
  );
}
