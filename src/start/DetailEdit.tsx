/**
 * "Detail editing": the section header button of the "Visuals" section in the side panel opens it, and it
 * expands to fill the whole chat area (user decision, 2026-10-23).
 *
 * **It takes the input box along too** (revised by user decision, 2026-10-26, issue #4): the input box used
 * to stay right below the timeline, and the user said that position "feels odd", so it was moved into the
 * chat panel newly built in the right side panel (`ExtChatPanel.tsx`). Its purpose is unchanged:
 * right-click a card here to quote it into the input box, then tell the Agent "change this one like so";
 * what `onQuote` fills is whichever input box is current at that moment. If the person collapses the side
 * panel, it returns to the bottom of the chat column; this code does not need to handle either case.
 *
 * Shape: the stage and a row of transport controls on top, the timeline below. **The gap between the two
 * can be dragged** (user request, 2026-10-26, issue #40): the timeline box height used to be hard-coded in
 * CSS, so when viewing a long video you could neither make the timeline taller nor enlarge the picture.
 * Now it is the same drag handle as the one above the timeline in the Classic mode editing desk
 * (`src/editor/ResizeHandle.tsx`), and the dragged height is remembered on this machine.
 *
 * The stage is the project's real picture (`VibeStage.tsx`); the timeline **is the real editor timeline**
 * (`src/editor/timeline/`), not a separately drawn view-only one: dragging, trimming, cross-track moves,
 * snapping, splitting, deleting and cut labels are all there.
 * This matches the `user-workflow.md`, "Working mode" row: in Vibe mode "mostly the Agent does the work;
 * the user can also adjust it themselves: go into detail editing from "Visuals" in the right side panel,
 * where the timeline is adjustable". Only the full editor (media library, effects, AI panel) counts as
 * "entering Classic mode".
 *
 * The first version, made on 2026-10-23, was a self-drawn read-only track (not draggable, not editable),
 * which did not match the semantics above, so the same day it was replaced with the real timeline.
 * The real timeline's right-click menu has one extra item on this page, "Quote into input box"
 * (`quoteClip` of `TimelineView`, passed on this page only), written the same way as the editor's
 * "Quote to AI" (`@card name (clip id)`, `quoteToken` in `src/mobile/agentView.ts`), which the Agent understands.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { actions, useStore } from "../store/project";
import { TimelineView } from "../editor/timeline";
import { ResizeHandle } from "../editor/ResizeHandle";
import { OVERLAY_QUOTE_KIND, quoteToken } from "../mobile/agentView";
import { overlayQuoteId } from "../editor/timeline/overlayActions";
import { VibeStage } from "./VibeStage";
import { tr } from "../i18n/index.ts";

const secs = (t: number) => `${t.toFixed(2)} s`;

/** Minimum height of the timeline box (px): any shorter and the toolbar and one track row no longer fit */
const TL_MIN_H = 160;
/** Takes at most seventy percent of this page: the top must always leave a picture that is clear at a glance (matches the max-height of `.ps-detail-tl` in `start.css`) */
const TL_MAX_RATIO = 0.7;
/**
 * The dragged height is remembered on this machine and is the same the next time it opens, for the same
 * reason as the two sidebar widths (the opening section of `sideWidth.ts`).
 * If never saved, no inline height is written, and the CSS default that follows the window is used;
 * double-click reset also falls back to this one.
 */
const TL_H_KEY = "pc.start.detailTlH";

function readTlH(): number | null {
  try {
    const saved = localStorage.getItem(TL_H_KEY);
    if (saved === null) return null;
    const n = Number(saved);
    // If the stored value is corrupt (hand-edited, or something else written by an old version), treat it as never saved and fall back to the CSS default height; do not write NaN into the style
    return Number.isFinite(n) && n >= TL_MIN_H ? Math.round(n) : null;
  } catch {
    return null;
  }
}

function writeTlH(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(TL_H_KEY);
    else localStorage.setItem(TL_H_KEY, String(Math.round(px)));
  } catch {
    // Incognito windows and browsers with site data disabled throw right away; if it cannot be saved, it only takes effect for this one open, with no error
  }
}

export function DetailEdit(props: {
  /**
   * Switch to **Classic mode**: open the editor (left rail + preview + timeline + AI panel, `workflow/editing.md`, "Editor").
   * User ruling, 2026-10-23: do not invent a separate name "Pro mode"; use "Classic mode", which already exists in the semantics.
   */
  onPro: () => void;
  onClose: () => void;
  /** Quote a card into the input box */
  onQuote: (text: string) => void;
}): JSX.Element {
  const duration = useStore((s) => Math.max(0.1, s.project.duration));
  const total = useStore((s) => s.project.duration);
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);

  const rootRef = useRef<HTMLDivElement>(null);
  const tlRef = useRef<HTMLDivElement>(null);
  const [tlH, setTlH] = useState<number | null>(() => readTlH());
  /**
   * The height at this moment. During a drag, `ResizeHandle` calls the closures captured at the instant of
   * pressing down, so reading state gives a stale value; therefore saving to this machine on release and
   * key repeat both go through this ref (same as `usePanelSize` in `Editor.tsx`).
   */
  const latestH = useRef(tlH);
  latestH.current = tlH;

  // When no height was saved, measure the CSS default height once: the resize handle needs a number as its start, otherwise the first drag jumps from somewhere else
  useLayoutEffect(() => {
    if (tlH === null && tlRef.current) setTlH(tlRef.current.clientHeight);
  }, [tlH]);

  const maxTlH = () => Math.max(TL_MIN_H, (rootRef.current?.clientHeight ?? window.innerHeight) * TL_MAX_RATIO);
  const sizeTl = (px: number) => {
    const next = Math.round(Math.max(TL_MIN_H, Math.min(maxTlH(), px)));
    latestH.current = next;
    setTlH(next);
    return next;
  };

  return (
    <div className="ps-detail" data-pc="start-detail" ref={rootRef}>
      <header className="ps-detail-head">
        <span className="ps-detail-title">{tr("Detail editing")}</span>
        <span className="ps-detail-sub">{tr("The timeline is adjustable; right-click a card to quote it into the input box")}</span>
        <span className="ps-rail-spacer" />
        {/*
          This page belongs to Vibe mode: talk to the Agent, glance here, make quick adjustments; clicking
          this switches to "Classic mode", which opens the complete editor (`user-workflow.md` "Working
          mode").
        */}
        <button type="button" className="ps-mode-btn" data-pc="start-enter-traditional" title={tr("Open the editor to work by hand: left rail + preview + timeline + AI panel")} onClick={props.onPro}>
          {tr("Enter Classic mode")}
        </button>
        <button type="button" className="ps-ghost-btn" data-pc="start-detail-close" onClick={props.onClose}>
          {tr("Collapse")}
        </button>
      </header>

      <div className="ps-detail-stage">
        <VibeStage className="ps-detail-screen" pc="start-detail-stage" />
      </div>

      <div className="ps-detail-transport">
        <button type="button" className="ps-detail-play" data-pc="start-detail-play" aria-label={playing ? tr("Pause") : tr("Play")} onClick={() => actions.togglePlay()}>
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.6 19 12 7 19.4z" /></svg>
          )}
        </button>
        <button type="button" className="ps-ghost-btn" data-pc="start-detail-rewind" onClick={() => { actions.pause(); actions.seek(0); }}>
          {tr("Back to start")}
        </button>
        <input type="range" className="ps-detail-scrub" data-pc="start-detail-scrub" min={0} max={duration} step={0.05}
          value={Math.min(t, duration)} aria-label={tr("Progress")} onPointerDown={() => window.getSelection()?.removeAllRanges()} onChange={(e) => actions.seek(Number(e.target.value))} />
        <span className="ps-detail-time">{secs(t)} / {secs(total)}</span>
      </div>

      {/*
       * The gap between the stage and the timeline (issue #40): normally no line is drawn at all, and one lights up
       * only when the mouse presses on it; drag it to change the timeline height ---
       * the timeline takes whatever is dragged out, and the stage above takes the rest. Double-click returns to
       * the default height; it can be reached with Tab and adjusted with arrow keys (Shift for big steps, Home to reset).
       *
       * It is the very one above the timeline in the Classic mode editing desk (`src/editor/ResizeHandle.tsx`):
       * the stage is an iframe, and once the mouse slides into it, pointermove is no longer received; that one
       * makes the iframe ignore mouse events during a drag, and writing another one ourselves would mean
       * stepping into this pit again.
       */}
      <ResizeHandle
        axis="y"
        pc="start-detail-grip"
        value={tlH ?? TL_MIN_H}
        min={TL_MIN_H}
        max={maxTlH}
        invert
        onChange={sizeTl}
        onCommit={() => writeTlH(latestH.current)}
        onReset={() => { latestH.current = null; setTlH(null); writeTlH(null); }}
        onNudge={(delta) => writeTlH(sizeTl((latestH.current ?? TL_MIN_H) + delta))}
        title={tr("Drag to resize the timeline height, double-click to reset")}
      />

      {/*
       * The real timeline. It is `h-full` itself, so this box needs a definite height (if never dragged, it is
       * the `.ps-detail-tl` size in CSS), and the stage above takes the rest. Row height, zoom and cut labels
       * are all in its own built-in toolbar, so no second set is provided here.
       */}
      <div className="ps-detail-tl" data-pc="start-detail-tl" ref={tlRef} style={tlH === null ? undefined : { flexBasis: `${tlH}px` }}>
        <TimelineView
          quoteClip={(clip, label) => props.onQuote(quoteToken({ id: clip.id, label }))}
          // An overlay card is one level finer than a clip: two same-named dim overlays on one clip are common, and without saying which one, the Agent can only ask back
          quoteOverlay={(clip, item) => props.onQuote(quoteToken({ id: overlayQuoteId(clip, item), label: item.name, kind: OVERLAY_QUOTE_KIND }))}
        />
      </div>
    </div>
  );
}
