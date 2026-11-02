/**
 * Full timeline (semantics `workflow/editing.md` "Mobile app interface"; demo rounds 4 and 10): zoom by
 * time, ticks, multiple tracks, playhead, handles at both ends after a clip is selected. Press and
 * drag left or right on blank space = horizontal scroll (the playhead stays), tap on blank space =
 * deselect, tap or drag the ruler = move the playhead.
 * Zoom: "−" and "+" center on the playhead, "Fit width", and two-finger pinch centers on the midpoint
 * of the two fingers; during a pinch there is no dragging, no selecting and no playhead moving.
 * Dragging a clip previews locally, and `moveClip` is called once on release (one drag = one undo
 * step). The position of a segment on the main track is determined by order, only dragging the two
 * ends to change the duration is allowed.
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { Project, Track, TrackClip } from "../kernel/project";
import { clipSpeed, speedLabel } from "../kernel/clipTime.mjs";
import { clipMakesNoSound } from "../editor/timeline/clipSilence";
import { clipKind, clipName } from "./mainContent";
import { PX_MAX, PX_MIN, TL_PAD, ZOOM_STEP, clampPx, fitPx, playheadX, rulerStep, timeToX, zoomAround } from "./zoom";
import { overlaysOfClip } from "../editor/timeline/overlays";
import { planOverlayBadge } from "./overlayBadge";
import { Icon } from "./icons";
import { tr as trText } from "../i18n/index.ts";

/** For this long after a pinch is released, lifting the finger is not treated as a tap */
const PINCH_GRACE_MS = 350;
/** Dragging snaps to 0.5 seconds */
const SNAP = 0.5;

export interface FullTimelineHandle { fit: () => void }

function laneLabel(p: Project, t: Track, i: number): string {
  const kinds = new Set(t.clips.map((c) => clipKind(p, c)));
  if (kinds.has("video") || kinds.has("image")) return trText("V");
  if (kinds.has("cut")) return trText("C");
  if (kinds.has("audio") && kinds.size === 1) return trText("A");
  if (kinds.has("card")) return trText("FX");
  return String(i + 1);
}

type Drag = { id: string; start: number; end: number } | null;

export const FullTimeline = forwardRef<FullTimelineHandle, {
  project: Project;
  t: number;
  playing: boolean;
  selected: string | null;
  mainTrackId: string | undefined;
  cardName: (cardId: string) => string | undefined;
  onSelect: (clipId: string | null) => void;
  onScrub: (t: number) => void;
  onCommitMove: (clipId: string, patch: { start: number; end: number }) => void;
  onAlign: (which: "start" | "end") => void;
  /** Tap the overlay card badge on a clip: select this segment and open "Adjust" at the overlay card section */
  onOverlays: (clipId: string) => void;
  /** Read-only project (guest): dragging to pan / change start and end, and aligning to the playhead are not wired up; tap-select, zoom and playhead work as usual */
  locked?: boolean;
  /** Hover hint when greyed out (the `viewOnlyText()` sentence, supplied by the caller) */
  lockedWhy?: string;
}>(function FullTimeline(props, ref) {
  const { project, selected } = props;
  const total = Math.max(project.duration, ...project.tracks.flatMap((t) => t.clips.map((c) => c.end)), 1);
  const [px, setPx] = useState(22);
  const pxRef = useRef(px);
  pxRef.current = px;
  const [drag, setDrag] = useState<Drag>(null);
  const sc = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  /** Pinch: pointerId of the two fingers → position; the token is +1 each time a pinch starts / ends, and a gesture whose drag was interrupted by a pinch is invalidated by it */
  const pinch = useRef<{ d0: number; px0: number; tA: number } | null>(null);
  const pinchGen = useRef(0);
  const pinchUntil = useRef(0);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const pendingScroll = useRef<number | null>(null);
  const pinching = (g: number) => !!pinch.current || g !== pinchGen.current || Date.now() < pinchUntil.current;

  const applyZoom = (np: number, scrollLeft: number) => {
    pendingScroll.current = scrollLeft;
    setPx(np);
  };
  useLayoutEffect(() => {
    if (pendingScroll.current !== null && sc.current) { sc.current.scrollLeft = pendingScroll.current; pendingScroll.current = null; }
  });
  const fit = () => {
    const el = sc.current;
    if (!el) return;
    applyZoom(fitPx(el.clientWidth, total), 0);
  };
  useImperativeHandle(ref, () => ({ fit }));
  // Entering the timeline defaults to "Fit width"
  useEffect(() => { requestAnimationFrame(fit); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const zoomBy = (f: number) => {
    const el = sc.current!;
    const r = zoomAround(px, el.scrollLeft, playheadX(px, el.scrollLeft, props.t), px * f);
    applyZoom(r.px, r.scrollLeft);
  };

  // While playing, keep the playhead within the visible range
  useEffect(() => {
    const el = sc.current;
    if (!el || !props.playing) return;
    const x = timeToX(px, props.t);
    if (x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - 60;
    if (x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 60);
  }, [props.t, props.playing, px]);

  // Two-finger pinch: get both touch points first in the capture phase, so the second finger no longer triggers selecting, dragging on blank space, etc.
  useEffect(() => {
    const el = sc.current!;
    const pts = () => [...ptrs.current.values()];
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.current.size < 2) return;
      e.stopPropagation();
      if (ptrs.current.size === 2) {
        const [a, b] = pts();
        const rl = el.getBoundingClientRect().left, mid = (a.x + b.x) / 2;
        pinch.current = { d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), px0: pxRef.current, tA: (el.scrollLeft + mid - rl - TL_PAD) / pxRef.current };
        pinchGen.current++;
        setDrag(null);
      }
    };
    const move = (e: PointerEvent) => {
      if (!ptrs.current.has(e.pointerId)) return;
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pc = pinch.current;
      if (!pc || ptrs.current.size < 2) return;
      const [a, b] = pts();
      const mid = (a.x + b.x) / 2, rl = el.getBoundingClientRect().left;
      const np = clampPx(pc.px0 * Math.hypot(a.x - b.x, a.y - b.y) / pc.d0);
      applyZoom(np, Math.max(0, pc.tA * np + TL_PAD - (mid - rl)));
    };
    const end = (e: PointerEvent) => {
      if (!ptrs.current.delete(e.pointerId)) return;
      if (pinch.current && ptrs.current.size < 2) { pinch.current = null; pinchGen.current++; pinchUntil.current = Date.now() + PINCH_GRACE_MS; }
    };
    el.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
    };
  }, []);

  const timeAt = (clientX: number) => {
    const r = inner.current!.getBoundingClientRect();
    return Math.max(0, Math.min(total, (clientX - r.left - TL_PAD) / pxRef.current));
  };

  /** Ruler: tap or drag = move the playhead. On touch screens wait until the finger has moved or been lifted and moved again, to avoid accidental moves at the start of a pinch */
  const onRulerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    const g = pinchGen.current, touch = e.pointerType !== "mouse";
    let done = !touch;
    if (!touch) props.onScrub(timeAt(e.clientX));
    const mv = (ev: PointerEvent) => { if (!pinching(g)) { props.onScrub(timeAt(ev.clientX)); done = true; } };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      if (!done && !pinching(g)) props.onScrub(timeAt(ev.clientX));
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  /** Blank space: press and drag left or right = horizontal scroll; tap once = deselect */
  const onBlankDown = (e: React.PointerEvent) => {
    const el = sc.current!;
    const x0 = e.clientX, sl0 = el.scrollLeft, g = pinchGen.current;
    let moved = false;
    const mv = (ev: PointerEvent) => {
      if (pinching(g)) return;
      if (Math.abs(ev.clientX - x0) > 4) moved = true;
      if (moved) el.scrollLeft = sl0 - (ev.clientX - x0);
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      if (!moved && !pinching(g) && selected) props.onSelect(null);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  /** Clip: tap to select; once selected, drag to pan, drag the two ends to change start and end; on the main track only the two ends can be dragged */
  const onClipDown = (e: React.PointerEvent, c: TrackClip, onMain: boolean) => {
    e.stopPropagation();
    const g0 = pinchGen.current;
    if (selected !== c.id) {
      if (e.pointerType === "mouse") { props.onSelect(c.id); return; }
      // Touch screen: only count as selected when the finger lifts, so a two-finger pinch starting on a clip does not select it either
      const x0 = e.clientX;
      let moved = false;
      const mv = (ev: PointerEvent) => { if (Math.abs(ev.clientX - x0) > 6) moved = true; };
      const up = () => {
        window.removeEventListener("pointermove", mv);
        window.removeEventListener("pointerup", up);
        if (!moved && !pinching(g0)) props.onSelect(c.id);
      };
      window.addEventListener("pointermove", mv);
      window.addEventListener("pointerup", up);
      return;
    }
    if (props.locked) return;
    const cls = (e.target as HTMLElement).classList;
    const edge = cls.contains("l") ? "l" : cls.contains("r") ? "r" : "m";
    if (onMain && edge === "m") return;
    const x0 = e.clientX, s0 = c.start, e0 = c.end, g = pinchGen.current;
    let moved = false;
    let cur = { id: c.id, start: s0, end: e0 };
    const mv = (ev: PointerEvent) => {
      if (pinching(g)) return;
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (!moved) return;
      const dt = Math.round((ev.clientX - x0) / pxRef.current / SNAP) * SNAP;
      if (edge === "m") { const s = Math.max(0, s0 + dt); cur = { id: c.id, start: s, end: s + (e0 - s0) }; }
      else if (edge === "r") cur = { id: c.id, start: s0, end: Math.max(s0 + SNAP, e0 + dt) };
      else cur = { id: c.id, start: Math.max(0, Math.min(e0 - SNAP, s0 + dt)), end: e0 };
      setDrag(cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (pinching(g) || !moved) return; // A pinch interrupted the drag: restore, no undo record
      if (Math.abs(cur.start - s0) > 1e-6 || Math.abs(cur.end - e0) > 1e-6) props.onCommitMove(c.id, { start: cur.start, end: cur.end });
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const step = rulerStep(px);
  const ticks: number[] = [];
  for (let s = 0; s <= total + 1e-6; s += step) ticks.push(s);
  const width = total * px + TL_PAD + 60;
  return (
    <div className="pane-edit" data-pcm="full-timeline">
      <div className="timeline">
        <div ref={sc} className="tl-scroll" data-pcm="tl-scroll">
          <div ref={inner} className="tl-inner" style={{ width }} data-px={px} onPointerDown={onBlankDown}>
            <div className="ruler" data-pcm="ruler" onPointerDown={onRulerDown}>
              {ticks.map((s) => <span key={s} style={{ left: timeToX(px, s) }}>{+s.toFixed(1)}s</span>)}
            </div>
            {project.tracks.map((tr, i) => (
              <div key={tr.id} className="lane" data-lane={tr.id}>
                <div className="lane-head"><span>{laneLabel(project, tr, i)}</span></div>
                {tr.clips.map((c) => {
                  const d = drag?.id === c.id ? drag : c;
                  const kind = clipKind(project, c);
                  return (
                    <div
                      key={c.id}
                      className={`clip k-${kind}${c.id === selected ? " sel" : ""}`}
                      data-id={c.id}
                      data-pcm="clip"
                      style={{ left: timeToX(px, d.start), width: Math.max((d.end - d.start) * px - 2, 18) }}
                      onPointerDown={(e) => onClipDown(e, c, tr.id === props.mainTrackId && kind !== "card" && kind !== "audio")}
                    >
                      <span className="h l" />
                      {clipName(project, c, props.cardName)}
                      {/* Overlay card: on mobile, strips are not drawn (cards in strips are smaller than clickable size),
                          leaving only a count badge. The narrowest tier ignores clicks: the badge spans almost the entire
                          clip, delegating the entry point to "Overlay layer" in sub-navigation */}
                      {(() => {
                        const plan = planOverlayBadge(
                          Math.max((d.end - d.start) * px - 2, 18),
                          overlaysOfClip(project, c, { cardName: props.cardName }).length,
                        );
                        if (!plan) return null;
                        const title = `${plan.text.startsWith(trText("Overlay")) ? plan.text : trText("{0} overlay cards", plan.text)}${plan.tappable ? trText(", tap to edit in \"Adjust\"") : trText(", clip is too short, tap this one and use \"Overlays\" below")}`;
                        return plan.tappable
                          ? <button type="button" className="ovm" data-pcm="clip-overlays" title={title}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => { e.stopPropagation(); props.onOverlays(c.id); }}>{plan.text}</button>
                          : <span className="ovm is-flat" data-pcm="clip-overlays" title={title}>{plan.text}</span>;
                      })()}
                      {c.audioMuted && <span className="mute"><Icon name="mute" />{trText("Muted")}</span>}
                      {/* Speed-change segment: show the multiplier and "no original audio" ([ruling] the first version of speed-change segments outputs no original audio, kernel/clipTime.mjs) */}
                      {!c.audioMuted && clipMakesNoSound(project, c) && <span className="mute" data-pcm="clip-speed" title={trText("Speed-changed clips play no original audio")}><Icon name="mute" />{trText("{0} no original audio", speedLabel(clipSpeed(c)))}</span>}
                      <span className="h r" />
                    </div>
                  );
                })}
              </div>
            ))}
            <div className="playhead" data-pcm="playhead" style={{ left: timeToX(px, props.t) }} />
          </div>
        </div>
      </div>
      <div className="tl-tools">
        <div className="zoom">
          <button type="button" data-pcm="zoom-out" aria-label={trText("Zoom out")} title={trText("Zoom out")} disabled={px <= PX_MIN + 1e-6} onClick={() => zoomBy(1 / ZOOM_STEP)}><Icon name="minus" /></button>
          <button type="button" data-pcm="zoom-in" aria-label={trText("Zoom in")} title={trText("Zoom in")} disabled={px >= PX_MAX - 1e-6} onClick={() => zoomBy(ZOOM_STEP)}><Icon name="plus" /></button>
          <button type="button" data-pcm="zoom-fit" aria-label={trText("Fit width")} title={trText("Fit width")} onClick={fit}><Icon name="fit" />{trText("Fit width")}</button>
        </div>
        <span className="spacer" />
        <button type="button" data-pcm="align-start" disabled={props.locked} title={props.locked ? props.lockedWhy : trText("Align start to playhead")} onClick={() => props.onAlign("start")}><Icon name="alignStart" />{trText("Start")}</button>
        <button type="button" data-pcm="align-end" disabled={props.locked} title={props.locked ? props.lockedWhy : trText("Align end to playhead")} onClick={() => props.onAlign("end")}>{trText("End")}<Icon name="alignEnd" /></button>
      </div>
    </div>
  );
});
