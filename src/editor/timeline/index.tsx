/**
 * Bottom timeline: multiple tracks, clip drag / resize / cross-track moves, playhead, snapping, context
 * menu, and receiving cards and media dragged from the left rail.
 * Tracks have no kinds: card clips and media clips can both go on the same track; **the upper track is
 * drawn on the upper layer**, consistent with what you see here.
 */
import { useEffect } from "react";
import type { TrackClip } from "../../kernel/project";
import type { OverlayItem } from "./overlays";
import { useStore, actions, getState } from "../../store/project";
import { TimelineProvider, useTimelineContext } from "./TimelineContext";
import { TrackHeader } from "./TrackHeader";
import { xOfTime, HEADER_W_MIN, HEADER_W_MAX, TAIL_SLACK_PX, contentEndOf } from "./utils";
import { effectiveDuration } from "../../kernel/duration";
import { useDurationFollowsContent } from "./durationSync";
import { TrackRow } from "./TrackRow";
import { CameraLaneHeader, CameraLaneRow } from "./CameraLane";
import { Ruler, RULER_H } from "./Ruler";
import { InsertZones } from "./InsertZones";
import { NewTrackZone } from "./NewTrackZone";
import { Playhead } from "./Playhead";
import { Toolbar } from "./Toolbar";
import { CutTabBar } from "./CutTabs";
import { Scrollbar } from "./Scrollbar";
import { ResizeHandle } from "../ResizeHandle";
import { IconPlus } from "../../ui/icons";
import { memberReadOnlyNow } from "../readOnlyCore";
import { useReadOnly } from "../readOnly";
import "./timeline.css";
import { tr } from "../../i18n/index.ts";

// For debugging and automated tests only, not an official interface
if (typeof window !== "undefined") {
  (window as any).__pcStore = { getState, actions };
}

function TimelineInner() {
  const tracks = useStore((s) => s.project.tracks);
  const duration = useStore((s) => s.project.duration);
  const durationManual = useStore((s) => s.durationManual);
  const { scrollRef, trackAreaRef, pxPerSec, setDropPlan, headerW, setHeaderW, commitHeaderW, resetHeaderW, trackH } = useTimelineContext();
  const t = useStore(s => s.t);
  const ro = useReadOnly();
  
  // The playback range follows the visible content.
  //
  // It used to only grow and never shrink (Math.max(duration, content end + margin)): deleting clips did not
  // shrink the range, and a new project started at 30 seconds, so the range always had a big empty stretch
  // that could play out as a black screen, and it even looked like a "minimum duration" limit. Now: the
  // content end is the upper bound of the range, dragging it shorter counts as truncation (allowed), and
  // dragging it longer is clamped back to the content end.
  //
  // Normally it is aligned before rendering (durationSync.ts: whenever the store changes, a microtask is
  // queued ahead of React's render flush), so one edit renders only once; the effect below stays as a
  // fallback: if it is still wrong after rendering, patch it once as before.
  useDurationFollowsContent();
  useEffect(() => {
    // A read-only project (guest) does not change the total duration: this is a write and the server would reject it (same as durationSync.ts)
    if (memberReadOnlyNow()) return;
    const target = effectiveDuration(contentEndOf(tracks), duration, durationManual);
    if (Math.abs(target - duration) > 1e-6) {
      actions.syncDuration(target);
    }
  }, [tracks, duration, durationManual]);

  // The content layer is measured from MIN_TIME (the gap before second 0 also takes width), with some extra room on the right for dragging
  const contentWidth = xOfTime(Math.max(duration, t + 5), pxPerSec) + TAIL_SLACK_PX;
  // Ruler + the empty row below = exactly one track height: the space above the first track is one track's height. When the row height is shorter than the ruler, no empty row is left
  const topGapH = Math.max(0, trackH - RULER_H);

  return (
    <div data-pc="timeline" className="flex flex-col h-full bg-neutral-900 border-t border-neutral-800 text-neutral-300 select-none overflow-hidden text-sm relative">
      {/* Cut tab bar (workflow/editing.md "Cut tabs"): one tab per opened cut, × only closes the tab */}
      <CutTabBar />
      <Toolbar />
      <div className="flex-1 min-h-0 overflow-auto pc-tl-scroll" ref={scrollRef}>
        {/* Keep both sticky columns as tall as the complete scroll content. */}
        <div className="pc-tl-content flex min-h-full min-w-full w-max">
        
        {/* Left Headers Column */}
        <div className="pc-tl-headers relative flex-shrink-0 sticky left-0 bg-neutral-900 z-30 flex flex-col" style={{ width: headerW }}>
          {/* Empty header as tall as the ruler: no text, just a placeholder, so the row headers below line up with the track rows on the right */}
          <div className="pc-tl-hdr flex-shrink-0 sticky top-0 bg-neutral-950 z-40" style={{ height: RULER_H }} aria-hidden="true" />
          {/* An empty row is added below the ruler, which together with the ruler is exactly one track height (follows the current row height); the track area on the right gets the same filler */}
          <div className="pc-tl-toprow flex-shrink-0" style={{ height: topGapH }} aria-hidden="true" />
          <CameraLaneHeader />

          {/* Row headers form their own layer (isolation): a row header being dragged (z-40) only overrides other row headers within this layer, and never covers the sticky header above */}
          <div className="flex-1 flex flex-col" style={{ isolation: "isolate" }}>
            {tracks.map((track, i) => (
              <TrackHeader key={track.id} track={track} index={i} />
            ))}
            <div className="pc-tl-addtrack-wrap">
              <button type="button" className="pc-tl-addtrack" data-pc="add-track" disabled={ro.locked} title={ro.title()} onClick={() => actions.addTrack()}>
                <IconPlus size={12} />
                {tr("Tracks")}
              </button>
            </div>
          </div>
          <div className="pc-tl-header-resize absolute inset-y-0 right-0 w-1.5 z-40">
            <ResizeHandle
              axis="x"
              value={headerW}
              min={HEADER_W_MIN}
              max={HEADER_W_MAX}
              onChange={setHeaderW}
              onCommit={commitHeaderW}
              onReset={resetHeaderW}
              title={tr("Drag to resize the row header, double-click to reset")}
            />
          </div>
        </div>

        {/* Tracks Area */}
        <div className="pc-tl-tracks flex-1 relative flex flex-col" ref={trackAreaRef} style={{ minWidth: contentWidth }}>
          <div className="flex-shrink-0 sticky top-0 bg-neutral-950 z-20" style={{ height: RULER_H }}>
            <Ruler />
          </div>
          {/* As tall as the empty row in the left row header column: the clip layer (.pc-tl-rows below) shifts down as a whole, and position calculations inside the layer are relative to itself, so they are unaffected */}
          <div className="pc-tl-toprow flex-shrink-0" style={{ height: topGapH }} aria-hidden="true" />
          <CameraLaneRow />
          {/*
            The clip layer forms its own layer (isolation): z-indices for selected clip (z-20), drop target
            preview (z-30), insertion seam (z-40), dragging row (z-40), and lock overlay (z-50) are compared
            only within this layer; the entire layer sits below the sticky range bar / ruler / green bar (z-20)
            and the left row header column (z-30). Previously this layer was not an independent stacking
            context: selected clip and ruler were both z-20 with DOM order behind, so vertical scrolling would
            overlap the ruler. The context menu therefore portals to body (ContextMenu.tsx) rather than
            staying in this layer and being covered by the ruler.
          */}
          <div
            className="pc-tl-rows flex-1 relative"
            style={{ isolation: "isolate" }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDropPlan(null);
            }}
          >
            {tracks.map((track, i) => (
              <TrackRow key={track.id} track={track} index={i} />
            ))}
            <NewTrackZone />
            <InsertZones />
          </div>
          <Playhead />
        </div>
        </div>
      </div>
      <Scrollbar />
    </div>
  );
}

/**
 * `quoteClip`: right-clicking a clip adds an extra item "Quote into input box". Only Vibe mode detail
 * editing passes it (`src/start/DetailEdit.tsx`: right-click a card to quote it into the input box below
 * where you talk to the Agent); the editor does not pass it.
 */
export function TimelineView(props: {
  quoteClip?: (clip: TrackClip, label: string) => void;
  quoteOverlay?: (clip: TrackClip, item: OverlayItem) => void;
} = {}) {
  return (
    <TimelineProvider quoteClip={props.quoteClip} quoteOverlay={props.quoteOverlay}>
      <TimelineInner />
    </TimelineProvider>
  );
}
