/**
 * Thumbnail timeline (semantics `workflow/editing.md`, "Mobile app UI"; demo script rounds 4 and 9): only the main content, with equal-width cards labeled with duration,
 * a fixed current-frame marker in the center, and the cards scrolling underneath. Pressing and dragging left or right = scrolling = adjusting the current time (with a finger the browser does native horizontal swipe, with inertia; the mouse takes the manual path); tap a card to select it (tap again to deselect); select first, then long-press and drag = reorder;
 * tapping a transition ◇ does the same thing as tapping a card (selects in place); the "+" where there is no transition opens the transition category of the card library.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { Project, TrackClip } from "../kernel/project";
import { clipSpeed, isSpeedChanged, speedLabel } from "../kernel/clipTime.mjs";
import { clipMakesNoSound } from "../editor/timeline/clipSilence";
import { ThumbImg, useThumb } from "./Thumb";
import type { Transition } from "../kernel/transitions";
import { boundaryTransition, cardPosAtTime, clipKind, mainTotal, timeAtCardPos } from "./mainContent";
import { Icon } from "./icons";
import { fmtDur, tint } from "./ui";
import { tr as trText } from "../i18n/index.ts";

/** How long a long press must last to count as picking up for reordering */
const LIFT_MS = 350;

export function ThumbStrip(props: {
  project: Project;
  clips: TrackClip[];
  t: number;
  playing: boolean;
  /** The selected thumbnail card (clip id) or transition (transition id) */
  selected: string | null;
  onSelect: (sel: { clipId: string } | { transition: Transition } | null) => void;
  onReorder: (order: string[]) => void;
  onScrub: (t: number) => void;
  onAddMedia: () => void;
  onAddTransition: (a: TrackClip, b: TrackClip) => void;
  /** Read-only project (guest): long-press drag to reorder is not wired up; tap to select, scrolling, and viewing all work as usual */
  locked?: boolean;
}) {
  const { project, clips, selected } = props;
  const sc = useRef<HTMLDivElement>(null);
  /** The scroll position we set ourselves (following the current time); when the scroll event sees it, it does not change the time back */
  const progSl = useRef(0);
  /**
   * When the most recent scroll that was "not set by us" happened.
   *
   * The sync effect below has no dependency array and runs on every render; originally it only stood aside while a finger was down (`dragging`).
   * Once native horizontal swipe is left to the browser, that is not enough: **during the inertia phase after release `dragging` is already false**,
   * and any re-render in that period (cards being measured, progress ticking, the Agent editing all cause one)
   * makes the effect snap scrollLeft back to the position for the "current time". It feels like "no matter how you swipe it goes back, and the white line does not move".
   * So we record one more timestamp: if the user scrolled within the last 400 milliseconds, do not touch it.
   */
  const userScrollAt = useRef(0);
  const suppressClick = useRef(false);
  const dragging = useRef(false);

  const blocks = () => [...(sc.current?.querySelectorAll<HTMLElement>(".mblock") ?? [])];
  /** The position of the current-frame marker (in the center) within the card sequence: the integer part is which card, the fractional part is the ratio within the card */
  /**
   * How long the i-th card takes along the scroll direction: measured from its left edge to **the left edge of the next card** (the last one is measured to its own right edge).
   *
   * Why not "the card's own width": between two segments sits a transition marker `.mark` (width 24, 3 margin on each side, 30px in total).
   * If computed by card width, these 30px belong to no segment, and both ends go wrong: when playback reaches a segment boundary the thumbnail strip jumps 30px;
   * when the user scrolls by hand into these 30px, `posFromScroll` always returns an integer and the time is stuck at the start of the next segment. The more segments, the more such dead zones.
   * With the gap merged into the previous segment, the position conversion is continuous and invertible over the whole strip, and when the white line passes the transition marker the previous segment has just played to its end, which also reads well.
   * (Found in passing on 2026-10-25 while investigating the iOS "cannot swipe" issue; the user said "fix it" on the spot.)
   */
  const spanOf = (bl: HTMLElement[], i: number): [number, number] => {
    const l = bl[i].offsetLeft;
    return [l, i + 1 < bl.length ? bl[i + 1].offsetLeft : l + bl[i].offsetWidth];
  };
  const posFromScroll = (): number => {
    const el = sc.current!;
    const x = el.scrollLeft + el.clientWidth / 2;
    const bl = blocks();
    for (let i = 0; i < bl.length; i++) {
      const [l, r] = spanOf(bl, i);
      if (x < l) return i;
      if (x < r) return i + (x - l) / (r - l);
    }
    return bl.length;
  };
  /*
   * The `offsetLeft` used here is measured relative to `.mainstrip`, not to the scroll container:
   * `.strip-scroll` itself is not positioned, and `offsetParent` lands on the outer `.mainstrip` (which is position: relative).
   * The result is correct only because `.strip-scroll` happens to sit at x = 0 inside `.mainstrip` with no border.
   * **Do not add a left margin or border to `.strip-scroll`**, and do not give it `position: relative` either (that would make
   * `offsetParent` the scroll container itself, so `offsetLeft` is measured from the padding edge, losing the left blank space).
   * Either one makes the calculation here wrong and hard to track down. When the left and right blank space was changed on 2026-10-25 from placeholder divs to container padding,
   * it was rechecked: padding does not affect `offsetLeft` (the first card is still at 50%), so that change was safe.
   */
  const scrollForPos = (pos: number): number => {
    const el = sc.current!;
    const bl = blocks();
    if (!bl.length) return 0;
    const i = Math.min(Math.floor(pos), bl.length - 1);
    const f = pos >= bl.length ? 1 : pos - i;
    const [l, r] = spanOf(bl, i);
    return l + f * (r - l) - el.clientWidth / 2;
  };

  // On play, tapping a tick, or switching cuts, the thumbnail timeline follows the current time (it stays still while a finger is down)
  useLayoutEffect(() => {
    const el = sc.current;
    if (!el || !el.clientWidth || dragging.current || performance.now() - userScrollAt.current < 400) return;
    const want = scrollForPos(cardPosAtTime(clips, props.t));
    if (Math.abs(el.scrollLeft - want) < 1) return;
    el.scrollLeft = want;
    progSl.current = el.scrollLeft;
  });

  useEffect(() => {
    const el = sc.current;
    if (!el) return;
    const onScroll = () => {
      if (!el.clientWidth || Math.abs(el.scrollLeft - progSl.current) < 1.5) return;
      // A mismatch with progSl = this change was not set by us, the user is swiping (finger drag, inertia, and mouse wheel all count)
      userScrollAt.current = performance.now();
      progSl.current = el.scrollLeft;
      props.onScrub(timeAtCardPos(clips, posFromScroll()));
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  });

  const onPointerDown = (e: React.PointerEvent) => {
    const el = sc.current!;
    const target = (e.target as HTMLElement).closest<HTMLElement>(".mblock, .mark.has");
    const isBlock = !!target?.classList.contains("mblock");
    const id = target?.dataset.id ?? null;
    const x0 = e.clientX, sl0 = el.scrollLeft;
    /*
     * When a finger swipes on a place that is **not selected**, horizontal swiping is left to the browser (`touch-action: pan-x` on `.strip-scroll`),
     * and we must not push scrollLeft again here, since pushing from both sides scrolls twice as fast.
     * Native swiping is turned off on the selected card (CSS `.mblock.sel { touch-action: none }`), because it must support long-press drag to reorder,
     * so that card still takes the manual path below; the mouse also always takes the manual path.
     */
    const nativePan = e.pointerType === "touch" && !(isBlock && id && selected === id);
    let mode: "pending" | "scroll" | "reorder" = "pending";
    let timer = 0;
    dragging.current = true;
    if (!props.locked && isBlock && id && selected === id) {
      timer = window.setTimeout(() => { if (mode === "pending") { mode = "reorder"; target!.classList.add("lift"); } }, LIFT_MS);
    }
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (mode === "pending" && Math.abs(dx) > 6) { window.clearTimeout(timer); mode = "scroll"; }
      if (mode === "scroll" && !nativePan) el.scrollLeft = sl0 - dx;
      else if (mode === "reorder") target!.style.transform = `translateX(${dx}px)`;
    };
    const end = (ev: PointerEvent) => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      dragging.current = false;
      if (mode !== "pending") { suppressClick.current = true; window.setTimeout(() => { suppressClick.current = false; }, 0); }
      if (mode === "reorder" && id) {
        const cx = target!.getBoundingClientRect().left + target!.offsetWidth / 2;
        target!.classList.remove("lift");
        target!.style.transform = "";
        const sibs = blocks().filter((b) => b !== target);
        let idx = 0;
        sibs.forEach((s, i) => { const r = s.getBoundingClientRect(); if (cx > r.left + r.width / 2) idx = i + 1; });
        const order = clips.map((c) => c.id).filter((x) => x !== id);
        order.splice(idx, 0, id);
        if (order.join() !== clips.map((c) => c.id).join()) props.onReorder(order);
      } else if (mode === "pending" && ev.type === "pointerup" && target && id) {
        if (isBlock) props.onSelect(selected === id ? null : { clipId: id });
        else {
          const k = Number(target.dataset.k);
          const tr = boundaryTransition(project, clips[k], clips[k + 1]);
          if (tr) props.onSelect(selected === tr.id ? null : { transition: tr });
        }
      }
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const total = Math.round(mainTotal(clips) * 10) / 10;
  return (
    <>
      <div className="mainhead"><b>{trText("Thumbnail timeline")}</b><span data-pcm="main-sum">{clips.length ? trText("{0} clips · {1} total", clips.length, fmtDur(total)) : trText("Nothing here yet. Tap + to add media")}</span></div>
      <div className="mainstrip" data-pcm="main-strip">
        <div className="cf-line" title={trText("Current frame")} data-pcm="frame-line" />
        <div
          ref={sc}
          className="strip-scroll"
          onPointerDown={onPointerDown}
          onClickCapture={(e) => { if (suppressClick.current) { e.stopPropagation(); e.preventDefault(); } }}
        >
          <button type="button" className="madd" aria-label={trText("Add media")} title={trText("Add media")} data-pcm="main-add" onClick={props.onAddMedia}><Icon name="plus" /></button>
          {clips.map((c, i) => {
            const tr = i < clips.length - 1 ? boundaryTransition(project, c, clips[i + 1]) : null;
            // A speed-changed segment plays no original audio ([ruling], kernel/clipTime.mjs): show the mute icon like a muted one, and append the speed multiplier after the duration
            const muted = !!c.audioMuted || clipMakesNoSound(project, c);
            // A long segment added by gap filling may appear in several places as separate pieces (the same id), so the key includes the start point
            const key = `${c.id}@${c.start}`;
            return [
              <div
                key={key}
                className={selected === c.id ? "mblock sel" : "mblock"}
                data-id={c.id}
                data-kind={clipKind(project, c)}
                data-pcm="mblock"
                style={{ background: `linear-gradient(135deg, ${tint(c.mediaId ?? c.cutId ?? c.id)}, var(--shade-art))` }}
              >
                <BlockThumb project={project} clip={c} />
                <span className="no">{i + 1}</span>
                <span className="du">{fmtDur(c.end - c.start)}{isSpeedChanged(c) && c.mediaId ? ` ${speedLabel(clipSpeed(c))}` : ""}{muted && <Icon name="mute" />}</span>
              </div>,
              i < clips.length - 1 && (
                tr
                  ? <button key={`m-${key}`} type="button" className={selected === tr.id ? "mark has sel" : "mark has"} data-id={tr.id} data-k={i} data-pcm="mark" title={trText("Transition")}>◇</button>
                  : <button key={`m-${key}`} type="button" className="mark" data-k={i} data-pcm="mark-add" title={trText("Add transition")} onClick={() => props.onAddTransition(c, clips[i + 1])}>{trText("+")}</button>
              ),
            ];
          })}
        </div>
      </div>
    </>
  );
}

const KIND_ICON = { video: "video", image: "image", cut: "clip", card: "card", audio: "audio" } as const;

/**
 * The thumbnail card image: for a video segment, the frame at its in point; for an image segment, the thumbnail; underneath is the type icon. For card clips, cut segments, and when nothing is fetched,
 * what shows is the sampled base color + type icon (+ the duration on the card), with no blank and no broken image
 */
function BlockThumb({ project, clip }: { project: Project; clip: TrackClip }) {
  const media = clip.mediaId && !clip.cardId ? project.media.find((m) => m.id === clip.mediaId) : undefined;
  const thumb = useThumb(media, media?.kind === "video" ? clip.mediaOffset ?? 0 : 0);
  return (
    <>
      <span className="kic" data-pcm="mblock-icon"><Icon name={KIND_ICON[clipKind(project, clip)]} /></span>
      {media && media.kind !== "audio" ? <ThumbImg thumb={thumb} /> : null}
    </>
  );
}
