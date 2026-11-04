/**
 * The "overlay band" inside a clip: draws what is attached to this segment (filters, pixel maps,
 * audio effects, media effect cards).
 *
 * Before this, nothing on the timeline showed whether a clip had anything attached; you had to dig
 * through the inspector in the left rail.
 *
 * # This slot is kept on every clip
 *
 * Transparent when nothing is attached: no background and no divider. If it were kept only for clips
 * with attachments, names in the same row would sit at uneven heights.
 *
 * # What opens where
 *
 * Click a card → what can be done with that one; click `+N` → everything attached to this segment.
 * Both open the "Overlay cards" branch of the clip context menu, just from different entry points
 * (the menu itself is assembled in `ClipView.tsx`).
 * Every button in the band swallows pointerdown: otherwise the clip's drag takes over the press and
 * the menu never opens.
 */
import { useEffect, useRef } from "react";
import type { MouseEvent } from "react";
import type { OverlayItem } from "./overlays";
import { BAND_H, OVERLAY_KIND_NAME, overlayGlyph, planBand } from "./overlays";
import type { RowSize } from "./utils";
import { tr } from "../../i18n/index.ts";

export interface OverlayBandProps {
  items: OverlayItem[];
  rowSize: RowSize;
  /** Width in the band reserved for cards (provided by planClipLayout) */
  avail: number;
  /** Clip too narrow: no cards, the band holds only a `+N` */
  countOnly: boolean;
  /** Read-only projects get no "+" */
  frozen: boolean;
  /** Open what can be done with this one */
  onOpenOne: (index: number, at: { x: number; y: number }) => void;
  /** Open everything attached to this segment */
  onOpenAll: (at: { x: number; y: number }) => void;
}

const at = (e: MouseEvent) => ({ x: e.clientX, y: e.clientY });

/**
 * Left click and right click on a button in the band do the same thing: start from where you clicked.
 * The right click must be handled here: otherwise the event bubbles up to the clip and the clip's
 * context menu opens, so a user who clicked one specific card would have to go through the
 * "Overlay cards" entry all over again.
 */
function press(run: (at: { x: number; y: number }) => void) {
  const fire = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    run(at(e));
  };
  return { onClick: fire, onContextMenu: fire };
}

/**
 * Buttons in the band swallow pointerdown themselves.
 *
 * The clip's drag (`useDrag`) uses a **native** listener and calls `setPointerCapture` as soon as the
 * press happens: React's `onPointerDown` is delegated at the root, so by the time it runs the clip's
 * handler has long finished and the pointer is already captured by the clip ->
 * the `click` of this press is dispatched to the clip, and the button in the band never receives it.
 * So a real DOM listener is attached here: the button is a descendant, bubbling passes through it
 * first, and stopping it there keeps the event from reaching the clip.
 */
function useOwnPointerDown<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onDown = (e: Event) => {
      if ((e.target as HTMLElement | null)?.closest?.("button")) e.stopPropagation();
    };
    el.addEventListener("pointerdown", onDown);
    return () => el.removeEventListener("pointerdown", onDown);
  }, []);
  return ref;
}

export function OverlayBand({ items, rowSize, avail, countOnly, frozen, onOpenOne, onOpenAll }: OverlayBandProps) {
  const bandRef = useOwnPointerDown<HTMLDivElement>();
  const h = BAND_H[rowSize];
  if (!h) return null;
  const empty = items.length === 0;
  const plan = empty || countOnly ? { shown: [], hidden: items.length } : planBand(items, avail);
  return (
    <div ref={bandRef} className={`pc-ov-band${empty ? " is-empty" : ""}`} style={{ height: h }} data-pc-overlays={items.length || undefined}>
      {plan.shown.map((it, i) => (
        <button
          key={it.kind + it.refId}
          type="button"
          className={`pc-ov-chip${it.off ? " is-off" : ""}`}
          title={it.off
            ? tr("{0}: {1} (disabled, has no effect on this segment)", OVERLAY_KIND_NAME[it.kind], it.name)
            : tr("{0}: {1}{2}", OVERLAY_KIND_NAME[it.kind], it.name, it.value ? tr(" ({0})", it.value) : "")}
          data-pc-overlay={it.kind}
          {...press((p) => onOpenOne(i, p))}
        >
          <span className="g">{overlayGlyph(it)}</span>
          <span className="n">{it.name}</span>
        </button>
      ))}
      {plan.hidden > 0 && (
        <button
          type="button"
          className="pc-ov-more"
          title={tr("{0} overlay cards, click to choose", items.length)}
          data-pc-overlay-more={plan.hidden}
          {...press(onOpenAll)}
        >
          {`+${plan.hidden}`}
        </button>
      )}
      {!countOnly && !frozen && (
        <button
          type="button"
          className="pc-ov-add"
          title={tr("What is attached to this segment")}
          aria-label={tr("Overlay card")}
          {...press(onOpenAll)}
        >
          ⋯
        </button>
      )}
    </div>
  );
}

/**
 * The small row height tier has no band: `+N` sits after the name, right-aligned; any shorter and
 * only it is left.
 * Same action as the `+N` in the band, and it is styled to match.
 */
export function OverlayPill({ count, onOpenAll }: { count: number; onOpenAll: (at: { x: number; y: number }) => void }) {
  const ref = useOwnPointerDown<HTMLButtonElement>();
  return (
    <button
      ref={ref}
      type="button"
      className="pc-ov-pill"
      title={tr("{0} overlay cards, click to choose", count)}
      data-pc-overlay-more={count}
      {...press(onOpenAll)}
    >
      {`+${count}`}
    </button>
  );
}
