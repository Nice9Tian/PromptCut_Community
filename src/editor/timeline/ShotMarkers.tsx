/**
 * Shot change markers on the timeline.
 *
 * A hard cut draws a vertical line plus a thumbnail (the frame after the change); a dissolve is drawn
 * as a range, with the thumbnails of the two shots before and after the fade **stacked**: the picture
 * blending together is more obvious with two stacked images than with any text.
 *
 * Position conversion goes through mediaOffset: a clip may cover only a middle part of the asset, and a
 * transition happening at T seconds in the asset is at clip.start + (T - mediaOffset) / speed on the
 * timeline (speed is the clip speed, see kernel/clipTime.mjs).
 */
import { useStore } from "../../store/project";
import type { ShotTransition, TrackClip } from "../../kernel/project";
import { mediaSpanOf, timelineSpanOf } from "../../kernel/clipTime.mjs";
import { useTimelineContext } from "./TimelineContext";
import { tr } from "../../i18n/index.ts";

/** Thumbnails that are too small are hard to see, and ones that are too large cover the clip itself, so when the row is not tall enough only the vertical line is kept */
const THUMB_MIN_ROW_H = 40;

/**
 * Compile-time constant of the online build (see "Online build pruning" in `src/online/pageFlag.ts` for how
 * it is written and why). Thumbnails live in the shot detection directory of the editor process,
 * and the online page only draws vertical lines; both markers check it again, so the online build prunes
 * them together with the `/api/shots/thumb/` URL (M8 leftover L24).
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export function ShotMarkers({ clip, rowHeight }: { clip: TrackClip; rowHeight: number }) {
  const { pxPerSec } = useTimelineContext();
  const media = useStore((s) =>
    clip.mediaId ? s.project.media.find((m) => m.id === clip.mediaId) : undefined,
  );

  const transitions = media?.shots?.transitions;
  if (!transitions?.length) return null;

  const offset = clip.mediaOffset ?? 0;
  const visibleFrom = offset;
  const visibleTo = offset + mediaSpanOf(clip);
  // Thumbnails live in the shot detection directory of the editor process (`/api/shots/thumb/`); the online page has no editor process, so it only draws vertical lines and sends no requests (C10 contract, section 10)
  const showThumbs = !ONLINE_BUILD && rowHeight >= THUMB_MIN_ROW_H;

  return (
    <div className="pc-shot-layer" aria-hidden>
      {transitions.map((t, i) => {
        // Only draw transitions that fall within the visible range of this clip
        if (t.end < visibleFrom || t.start > visibleTo) return null;
        const left = timelineSpanOf(clip, t.start - offset) * pxPerSec;
        const width = Math.max(1, timelineSpanOf(clip, t.end - t.start) * pxPerSec);
        return t.kind === "dissolve"
          ? <DissolveMark key={i} t={t} left={left} width={width} showThumbs={showThumbs} />
          : <CutMark key={i} t={t} left={left} showThumbs={showThumbs} />;
      })}
    </div>
  );
}

/**
 * Thumbnails must not use loading="lazy".
 *
 * They sit in an overflow:hidden marker layer, and the CSS has a fixed height and width:auto:
 * until loaded they have no intrinsic size, so the computed width is 0; the browser sees a zero-area
 * element and decides it is not visible, so it does not load it; and without loading it never gets a size.
 * A dead loop, and not a single image shows up (confirmed by testing).
 * Give it width/height attributes so the browser reserves space at 16:9 first, and load immediately:
 * each one is only 2 KB.
 */
function thumbUrl(name: string): string {
  return `/api/shots/thumb/${encodeURIComponent(name)}`;
}

function CutMark({ t, left, showThumbs }: { t: ShotTransition; left: number; showThumbs: boolean }) {
  const thumb = t.thumbs?.[0];
  return (
    <div className="pc-shot-cut" style={{ left }} title={tr("Hard cut {0}s", t.time.toFixed(2))}>
      <div className="pc-shot-line" />
      {!ONLINE_BUILD && showThumbs && thumb && (
        // Wrap it in the same .pc-shot-stack as the dissolve: the marker itself has width 0 (it is just a line),
        // and an absolutely positioned img computing width:auto against a zero-width containing block gets 0.
        // Wrap it in a container that has a width and
        // let the img be statically positioned, and it will expand by its own aspect ratio.
        <span className="pc-shot-stack pc-shot-stack--cut">
          <img className="pc-shot-thumb" src={thumbUrl(thumb)} alt="" draggable={false} width={160} height={90} />
        </span>
      )}
    </div>
  );
}

function DissolveMark(
  { t, left, width, showThumbs }: { t: ShotTransition; left: number; width: number; showThumbs: boolean },
) {
  const [a, b] = t.thumbs ?? [];
  return (
    <div
      className="pc-shot-dissolve"
      style={{ left, width }}
      title={tr("Dissolve {0}~{1}s", t.start.toFixed(2), t.end.toFixed(2))}
    >
      {/* A thin line at each end of the fade, with a thin background layer between them to show "this stretch is blending" */}
      <div className="pc-shot-line pc-shot-line--start" />
      <div className="pc-shot-line pc-shot-line--end" />
      {!ONLINE_BUILD && showThumbs && a && (
        <span className="pc-shot-stack">
          <img className="pc-shot-thumb" src={thumbUrl(a)} alt="" draggable={false} width={160} height={90} />
          {b && (
            // The later image sits on top of the earlier one, semi-transparent: that is the "two stacked images"
            <img className="pc-shot-thumb pc-shot-thumb--over" src={thumbUrl(b)} alt="" draggable={false} width={160} height={90} />
          )}
        </span>
      )}
    </div>
  );
}
