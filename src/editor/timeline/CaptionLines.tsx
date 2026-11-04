import { useMemo, useRef, useState } from "react";
import { useTimelineContext } from "./TimelineContext";
import { actions } from "../../store/project";
import { useDrag } from "./useDrag";
import { useUserEditing } from "../userEditing";
import { ContextMenu } from "./ContextMenu";
import { captionsOf, captionBounds, MIN_CAPTION_DUR, type CaptionLine } from "../../kernel/captions";
import type { TrackClip } from "../../kernel/project";
import { useReadOnly } from "../readOnly";
import { tr } from "../../i18n/index.ts";

/**
 * The individual captions inside a captions card.
 *
 * The caption content is stored in the card's `lines` parameter, so on the timeline it is always just
 * one big color block: which line appears at which second, and over which shot, is invisible. Here each
 * caption is drawn as a small cell inside the block:
 * click to jump there, drag to move, pull an edge to change duration, double-click to edit text,
 * right-click to delete. Changes are written back to the same lines string,
 * so the picture side (the caption-track card) needs no change at all.
 *
 * All dragging is confined to this card and never crosses the left or right neighbor (decided by
 * captionBounds in kernel/captions), so two captions can never fight over the same second.
 */
export function CaptionLines({ clip, height }: { clip: TrackClip; height: number }) {
  const { pxPerSec } = useTimelineContext();
  const lines = useMemo(() => captionsOf(clip), [clip.params?.lines]);
  const dur = clip.end - clip.start;
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const ro = useReadOnly();

  // Row too short (small row height): draw only the block, no text: text that does not fit just blurs into a mess
  const showText = height >= 40;

  return (
    <>
      <div className="absolute inset-0 pointer-events-none">
        {lines.map((l, i) => (
          <CaptionBlock
            key={`${i}-${l.start}`}
            clipId={clip.id}
            clipStart={clip.start}
            line={l}
            index={i}
            lines={lines}
            dur={dur}
            pxPerSec={pxPerSec}
            showText={showText}
            editing={editing === i}
            onEdit={() => setEditing(i)}
            onEditDone={() => setEditing(null)}
            onMenu={(x, y) => setMenu({ x, y, index: i })}
          />
        ))}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={ro.locked ? [{ label: ro.why, disabled: true, action: () => {} }] : [
            { label: tr("Edit text"), action: () => setEditing(menu.index) },
            {
              label: tr("Add one here"),
              action: () => {
                // Start stuffing from the end of the current one; if it does not fit, addCaption returns -1, so do nothing
                const after = lines[menu.index];
                actions.addCaption(clip.id, { start: after ? after.end : 0, zh: tr("New caption") });
              },
            },
            { label: tr("Delete this caption"), action: () => actions.removeCaption(clip.id, menu.index) },
          ]}
        />
      )}
    </>
  );
}

function CaptionBlock({
  clipId,
  clipStart,
  line,
  index,
  lines,
  dur,
  pxPerSec,
  showText,
  editing,
  onEdit,
  onEditDone,
  onMenu,
}: {
  clipId: string;
  clipStart: number;
  line: CaptionLine;
  index: number;
  lines: CaptionLine[];
  dur: number;
  pxPerSec: number;
  showText: boolean;
  editing: boolean;
  onEdit: () => void;
  onEditDone: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  /*
   * Temporary time range during a drag: not written to the store, committed on release.
   *
   * The same value is kept in both state (needed for redraw) and a ref (needed for an accurate read on
   * release): the release callback is a closure saved by useDrag, and reading state directly may give the
   * previous frame's value, so the ref is authoritative.
   */
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const dragRef = useRef<{ start: number; end: number } | null>(null);
  /** Whether it really moved after this press: if not, treat it as a "click" */
  const movedRef = useRef(false);
  /*
   * Count double-clicks ourselves, not with the browser's dblclick.
   *
   * This block calls setPointerCapture in pointerdown (dragging needs it); once the pointer is captured,
   * the browser no longer counts two consecutive presses as one double-click: in testing the native
   * dblclick never fires. So we record the time of the last click, and a fast enough second one enters
   * text edit mode.
   */
  const lastClick = useRef(0);

  const setBoth = (v: { start: number; end: number } | null) => {
    dragRef.current = v;
    setDrag(v);
  };

  // Caption bar being dragged / double-click text edit in progress: tell the Agent the user is editing
  // this caption clip (A2)
  useUserEditing(`caption-drag:${clipId}:${index}`, drag ? clipId : null, "drag");
  useUserEditing(`caption-text:${clipId}:${index}`, editing ? clipId : null, "text");

  const start = drag ? drag.start : line.start;
  const end = drag ? drag.end : line.end;

  // This project grants read-only access only (guest): a click still jumps there to look, but no drag,
  // edge pull or double-click text edit
  const ro = useReadOnly();

  const bodyRef = useDrag(
    () => {
      movedRef.current = false;
      actions.select([clipId]);
    },
    (_e, delta) => {
      if (ro.locked) return;
      const dt = delta.x / pxPerSec;
      if (Math.abs(delta.x) > 2) movedRef.current = true;
      const { min, max } = captionBounds(lines, index, dur);
      const len = line.end - line.start;
      const s = Math.max(min, Math.min(line.start + dt, Math.max(min, max - len)));
      setBoth({ start: s, end: Math.min(max, s + len) });
    },
    () => {
      const prev = dragRef.current;
      setBoth(null);
      if (ro.locked) {
        // Read-only: only "click = move the playhead there"
        actions.seek(clipStart + line.start + 0.01);
        return;
      }
      if (movedRef.current) {
        // Really dragged: give only start, length unchanged (editCaption reads "start only" as shifting the whole caption)
        if (prev) actions.editCaption(clipId, index, { start: prev.start });
        return;
      }
      const now = Date.now();
      if (now - lastClick.current < 450) {
        lastClick.current = 0;
        onEdit();
      } else {
        lastClick.current = now;
        // Click = move the playhead onto this caption (plus a tiny bit, so it does not sit exactly on the
        // boundary and show nothing)
        actions.seek(clipStart + line.start + 0.01);
      }
    },
  );

  /** Edge trimming: one set of handles at each end, and on release start and end are written back together */
  const commitTrim = () => {
    const prev = dragRef.current;
    setBoth(null);
    if (ro.locked) return;
    if (prev) actions.editCaption(clipId, index, { start: prev.start, end: prev.end });
  };

  const leftRef = useDrag(
    () => { movedRef.current = true; },
    (_e, delta) => {
      if (ro.locked) return;
      const dt = delta.x / pxPerSec;
      const { min } = captionBounds(lines, index, dur);
      const s = Math.max(min, Math.min(line.start + dt, line.end - MIN_CAPTION_DUR));
      setBoth({ start: s, end: line.end });
    },
    commitTrim,
  );

  const rightRef = useDrag(
    () => { movedRef.current = true; },
    (_e, delta) => {
      if (ro.locked) return;
      const dt = delta.x / pxPerSec;
      const { max } = captionBounds(lines, index, dur);
      const e2 = Math.min(max, Math.max(line.end + dt, line.start + MIN_CAPTION_DUR));
      setBoth({ start: line.start, end: e2 });
    },
    commitTrim,
  );

  const width = Math.max(2, (end - start) * pxPerSec);
  const geom = { left: `${start * pxPerSec}px`, width: `${width}px` };

  /*
   * While editing text, the whole block is swapped for a shell without dragging.
   *
   * useDrag attaches a **native** pointerdown and calls setPointerCapture; the React stopPropagation on
   * the input cannot stop it. If dragging stayed, clicking into the input to place the cursor would be
   * stolen by pointer capture, and a drag would also shift this caption along the way.
   */
  if (editing) {
    return (
      <div className="pc-cap-line absolute pointer-events-auto" style={geom}>
        <input
          autoFocus
          defaultValue={line.zh}
          className="pc-cap-input"
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && v !== line.zh) actions.editCaption(clipId, index, { zh: v });
            onEditDone();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") onEditDone();
            e.stopPropagation();
          }}
        />
      </div>
    );
  }

  return (
    <div
      ref={bodyRef}
      data-pc-caption-line={index}
      className="pc-cap-line absolute pointer-events-auto"
      style={geom}
      title={`${line.start.toFixed(2)}–${line.end.toFixed(2)}s · ${line.zh || line.en}${ro.locked ? tr(" ({0})", ro.why) : tr("(double-click to edit, right-click for more)")}`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <div ref={leftRef} className="pc-cap-grip is-left" />
      {showText && <span className="pc-cap-text">{line.zh || line.en}</span>}
      <div ref={rightRef} className="pc-cap-grip is-right" />
    </div>
  );
}
