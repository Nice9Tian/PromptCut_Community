import { useMemo, useSyncExternalStore } from "react";
import { useTimelineContext } from "./TimelineContext";
import { useStore } from "../../store/project";
import { useScrub } from "./useScrub";
import {
  clipFingerprint, getCoverage, idleSpans, mergeSegments, subscribeCoverage, visibleCoverage,
  type CoverageSegment,
} from "../preview/bakeCoverage";
import { xOfTime } from "./utils";
import { tr as trText } from "../../i18n/index.ts";
import { isBoardBehindCamera } from "../../kernel/space3d";

/** Progress bar height (px). Enough to be seen, without crowding the timeline */
export const RENDER_H = 2;

/**
 * Prerender progress bar (the strip at the top in AE). It is the bottom edge line of the time ruler (Ruler).
 *
 * # The two colors mean two different things
 *
 * **Yellow = the low frame rate tier is already there.** Dragging there gives a picture at once, but
 * at that moment it is at most 0.25 seconds off the playhead.
 * This tier covers the whole video first: its cost is only a fraction of the original frame rate.
 *
 * **Green = the original frame rate tier is there too.** That span is frame-accurate. It starts
 * rendering only after the low frame rate tier is completely filled.
 *
 * **Blank = nothing at all; dragging there waits for a live render (about 4 seconds per frame).**
 *
 * # Edit a card and its span turns white **on the same frame**
 *
 * Coverage is stored **per card**, each entry carrying the content fingerprint of that card at the
 * time (see ClipCoverage in bakeCoverage).
 * On every render, this compares against the fingerprints of the **current project**, and anything
 * that does not match is simply not drawn.
 *
 * So "the strip turns white right after a card edit" does not depend on anything asynchronous: the
 * moment the user changes a parameter, the project in the store is replaced, and this component
 * wipes that card on this very frame: no waiting for a recount, no waiting for prerender, and no
 * possible race.
 *
 * It used to be different: coverage was stored as one strip merged from all cards, **and only the
 * prerender loop could update it**, and that loop had to finish the current batch and then recount
 * before it was its turn to publish. So after a card edit the strip did not budge, which looked like
 * it was stuck on prerender.
 * That was a structural problem, not poorly tuned timing: so this change fixes the structure.
 *
 * # Two hard requirements on drawing
 *
 * 1. **It draws time spans that are really covered, not a percentage.** A prerendered moment covers
 *    up to the next moment of the same card. A percentage progress bar cannot do this: it can show
 *    90%, yet the user drags into the remaining 10% and waits just the same.
 * 2. **Better to draw too little than too much.** Drawing one extra cell is lying: it clearly has to
 *    wait five seconds there, yet the bar is colored.
 */
export function RenderBar() {
  const { pxPerSec } = useTimelineContext();
  const project = useStore((s) => s.project);
  const duration = useStore((s) => Math.max(s.project.duration, s.t + 10));
  const startScrub = useScrub();
  /*
   * Subscribe to the module-level store. Use useSyncExternalStore instead of rolling your own
   * useState + useEffect: it guarantees that under concurrent rendering the value read and the value
   * subscribed to are the same one, so you never get "the picture used an old value".
   */
  const cov = useSyncExternalStore(subscribeCoverage, getCoverage, getCoverage);

  /**
   * What each card in the current project looks like and where it currently sits. Fingerprint → current start.
   *
   * Fingerprint changed → that card's coverage is invalidated on the same frame (parameter edit, trim, aspect ratio change).
   * Fingerprint unchanged but start changed → coverage shifts along (moving does not change pixels, so
   * the prerendered images are still usable). Both are in visibleCoverage.
   */
  const liveFps = useMemo(() => {
    const map = new Map<string, number>();
    for (const tr of project?.tracks ?? []) for (const c of tr.clips ?? []) map.set(clipFingerprint(c), c.start);
    return map;
  }, [project]);

  // The filtering + merging logic lives in bakeCoverage (pure functions, with unit tests pinning this behavior)
  const shown = useMemo(() => visibleCoverage(cov, liveFps), [cov, liveFps]);

  /**
   * Spans that "have nothing to render anyway" are colored just like rendered ones.
   *
   * Blank seconds, media clips (video / images are bitmaps already; `bakeTarget` flatly refuses to
   * prerender them), scene-3d (real geometry in the 3D view, no texture needed): dragging there
   * immediately gives what it should look like.
   * By the bar's contract ("dragging onto green always gives a picture at once") they should be green.
   *
   * Without this, a fully rendered video would always keep a few white patches, and the user could
   * not tell "not rendered yet" from "nothing to render anyway"; it would look like prerender is
   * stuck there and not moving.
   */
  const idle = useMemo(() => {
    const busy: { start: number; end: number }[] = [];
    const stageSize = { width: project?.width ?? 1920, height: project?.height ?? 1080 };
    for (const tr of project?.tracks ?? []) {
      for (const c of tr.clips ?? []) {
        if ((c as any).mediaId || c.cardId === "scene-3d" || isBoardBehindCamera(c.frame, stageSize, project?.camera3dFov)) continue;
        busy.push({ start: c.start, end: c.end });
      }
    }
    return idleSpans(busy, project?.duration ?? 0);
  }, [project]);

  const x0 = xOfTime(0, pxPerSec);
  const width = Math.max(0, xOfTime(duration, pxPerSec) - x0);

  const band = (segs: CoverageSegment[], cls: string) =>
    segs.map((seg, i) => {
      const left = xOfTime(seg.start, pxPerSec);
      const w = xOfTime(seg.end, pxPerSec) - left;
      // When zoomed far out, a span may be under 1px. Give it a floor, or the whole strip looks unrendered
      if (w <= 0) return null;
      return <div key={`${cls}-${seg.start}-${i}`} className={cls} style={{ left, width: Math.max(1, w) }} />;
    });

  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const title = shown.coarseTotal === 0
    ? trText("Prerender: not started yet. Switching to the \"3D\" tab of the preview panel prerenders automatically when idle")
    : [
        trText("Low frame rate (yellow) {0}/{1} ({2}%): dragging there shows a frame immediately, off by at most 0.25 s", shown.coarseBaked, shown.coarseTotal, pct(shown.coarseBaked, shown.coarseTotal)),
        trText("Original frame rate (green) {0}/{1} ({2}%): frame-accurate", shown.fullBaked, shown.fullTotal, pct(shown.fullBaked, shown.fullTotal)),
        trText("Blank = must wait for on-demand rendering (about 4 s per frame). Using {0}MB", (cov.bytes / 1048576).toFixed(1)),
        ...(shown.stale ? [trText("{0} cards were just edited, their segments are invalidated and are being prerendered again", shown.stale)] : []),
      ].join("\n");

  return (
    <div
      data-pc="render-bar"
      className="pc-tl-renderbar relative overflow-hidden select-none touch-none cursor-ew-resize"
      style={{ height: RENDER_H }}
      // Like the ruler, you can drag the playhead here: it sits right under the ruler, and clicking these few pixels with no response would make people think the UI froze
      onPointerDown={(e) => startScrub(e, { jumpToPointer: true })}
      title={title}
    >
      {/* Bottom groove: the length of the whole video, marking "how much is still not prerendered" */}
      <div className="pc-tl-renderbar-track absolute top-0 bottom-0" style={{ left: x0, width }} />
      {/* Lay yellow (low frame rate) first, then cover it with green (original frame rate): green always falls within yellow */}
      {band(mergeSegments([...shown.coarse, ...idle]), "pc-tl-renderbar-coarse absolute top-0 bottom-0")}
      {band(mergeSegments([...shown.full, ...idle]), "pc-tl-renderbar-done absolute top-0 bottom-0")}
      {/*
        Mark the moment currently rendering separately. It hasn't entered any tier's coverage yet
        (rendering unfinished), but users can see that "progress is stuck here", instead of staring at a
        frozen bar wondering if it crashed.
      */}
      {cov.bakingAt !== null && (
        <div
          className="pc-tl-renderbar-now absolute top-0 bottom-0"
          style={{ left: xOfTime(cov.bakingAt, pxPerSec) }}
        />
      )}
    </div>
  );
}
