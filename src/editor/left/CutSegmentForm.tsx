import { useState, type ReactNode } from "react";
import { actions, useStore } from "../../store/project";
import type { TrackClip } from "../../kernel/project";
import type { ClipFrame } from "../../kernel/types";
import { resolveFrame } from "../../kernel/layout";
import { cutDuration } from "../../kernel/cutSegments";
import { fadeOwner } from "../../kernel/transitions";
import { openCutInTimeline } from "../timeline/CutTabs";
import { NumberField } from "../fields/NumberField";
import { RangeField } from "../fields/RangeField";
import { tr } from "../../i18n/index.ts";

/**
 * Properties of a cut segment in the editing section (the cut segment entry under "Clip" in `product/project-model.md`): which second
 * of the referenced cut to start from, plus the same start/end, frame, opacity, fade in/out, volume and mute as a media clip. Which cut
 * is referenced cannot be changed (user decision, 2026-10-21, `workflow/editing.md`, "Properties of a cut segment"), so there is no
 * dropdown here for swapping the reference; to change it, delete this segment and drag in a new one from the media library.
 *
 * Every item goes through an existing store action (`setCutSegment`, `moveClip`, `setClipFrame`, `updateClip`, `setClipVolume`, `setClipMuted`),
 * which write a new object back into the project and push onto the undo stack; rejections such as an offset exceeding the total length of
 * the referenced cut are shown as-is under the form.
 * "Open referenced cut" has the same effect as double-clicking the cut segment on the timeline (`openCutInTimeline`).
 *
 * The number field and slider are the shared NumberField / RangeField in `../fields/`: typing in the number field only changes the draft,
 * and Enter or blur commits one step; one slider drag records only one undo step (user decision, 2026-10-20, `docs/semantics/workflow/editing.md`, "Undo and redo").
 */
export function CutSegmentForm({ clip }: { clip: TrackClip }) {
  const project = useStore((s) => s.project);
  const [err, setErr] = useState<string | null>(null);
  const cuts = project.cuts ?? [];
  const cutId = clip.cutId!;
  const target = cuts.find((c) => c.id === cutId);
  const total = cutDuration(project, cutId);
  const offset = clip.cutOffset ?? 0;
  const len = clip.end - clip.start;
  const beyond = Math.max(0, len - Math.max(0, total - offset));
  const track = project.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
  const locked = !!track?.locked;

  /** Run a store action: both thrown errors and returned { ok: false, error } are shown */
  const run = (fn: () => unknown) => {
    try {
      const r = fn() as { ok?: boolean; error?: string; blocked?: string[] } | undefined;
      if (r && typeof r === "object" && r.ok === false) setErr(r.error ?? (r.blocked?.length ? tr("The fade on this side is controlled by a transition; delete the transition first to change it") : tr("Not changed")));
      else if (r && typeof r === "object" && r.blocked?.length) setErr(tr("The fade on this side is controlled by a transition; delete the transition first to change it"));
      else setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const stage = { width: project.width, height: project.height };
  const frame = resolveFrame(clip.frame, stage);
  const patchFrame = (p: Partial<ClipFrame>) => run(() => actions.setClipFrame(clip.id, { ...(clip.frame ?? { x: 0, y: 0 }), ...p } as ClipFrame));

  const row = (label: string, body: ReactNode, hint?: string) => (
    <div className="flex items-center gap-2" title={hint}>
      <span className="w-14 shrink-0 pc-left-muted">{label}</span>
      {body}
    </div>
  );
  const numberBox = (dataPc: string, value: number, step: number, onValue: (n: number) => void, opts: { min?: number; max?: number; disabled?: boolean } = {}) => (
    <NumberField attrs={{ "data-pc": dataPc }} value={value} step={step} min={opts.min} max={opts.max} disabled={opts.disabled || locked} onCommit={onValue} className="w-14 shrink-0 pc-left-input is-sm" />
  );
  const sub = (text: string) => <span className="shrink-0 whitespace-nowrap pc-left-muted">{text}</span>;
  const slider = (dataPc: string, value: number, min: number, max: number, step: number, onValue: (n: number) => void, disabled = false) => (
    <RangeField attrs={{ "data-pc": dataPc }} min={min} max={max} step={step} value={value} disabled={disabled || locked} onValue={onValue} className="flex-1 min-w-0 pc-left-range" />
  );

  const fadeInLocked = !!fadeOwner(project, clip.id, "fadeIn");
  const fadeOutLocked = !!fadeOwner(project, clip.id, "fadeOut");
  const volume = clip.audioVolume ?? 1;
  const muted = !!clip.audioMuted;

  return (
    <div data-pc="cut-segment-form" className="flex-1 min-h-0 overflow-y-auto pc-left-scroll flex flex-col gap-2 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold pc-left-strong truncate">{tr("Cut segment · {0}", target?.name ?? tr("(referenced cut was deleted)"))}</div>
        <button
          type="button"
          data-pc="cut-segment-open"
          className="pc-left-btn is-sm shrink-0"
          disabled={!target}
          title={tr("Open and activate the referenced cut in the tab bar above the timeline (same as double-clicking the cut segment)")}
          onClick={() => openCutInTimeline(cutId)}
        >
          {tr("Open referenced cut")}
        </button>
      </div>

      {locked && <div className="pc-left-faint">{tr("The track it is on is locked; unlock it first to edit")}</div>}

      {row(tr("Start offset"), (
        <>
          {numberBox("cut-segment-offset", offset, 0.1, (n) => run(() => actions.setCutSegment(clip.id, { cutOffset: Math.max(0, n) })), { min: 0 })}
          <span className="pc-left-faint whitespace-nowrap">{tr("s, {0} s total", total.toFixed(2))}</span>
        </>
      ), tr("At which second of the referenced cut playback starts"))}

      <div className="flex items-center gap-2" title={tr("Segment length {0} s", len.toFixed(2))}>
        {sub(tr("Start"))}
        {numberBox("clip-start", clip.start, 0.1, (n) => run(() => actions.moveClip(clip.id, { start: n })), { min: 0 })}
        {sub(tr("End"))}
        {numberBox("clip-end", clip.end, 0.1, (n) => run(() => actions.moveClip(clip.id, { end: n })), { min: 0 })}
      </div>
      {beyond > 0.0005 && (
        <div data-pc="cut-segment-beyond" className="pc-left-faint">
          {tr("The referenced cut got shorter: the last {0} s go beyond its total duration, and that part is transparent and silent", beyond.toFixed(2))}
        </div>
      )}

      <div className="mt-1 pt-2 pc-left-divider flex items-center justify-between">
        <span className="font-semibold pc-left-strong">{tr("Box")}</span>
        <button
          type="button"
          data-pc="cut-segment-frame-reset"
          className="pc-left-btn is-sm"
          disabled={!clip.frame || locked}
          title={tr("Clear the box and fill the whole frame")}
          onClick={() => run(() => actions.setClipFrame(clip.id, undefined))}
        >
          {tr("Fill")}
        </button>
      </div>
      {row(tr("Position"), (
        <>
          <span className="shrink-0 pc-left-faint">X</span>
          {numberBox("cut-segment-x", frame.x, 1, (n) => patchFrame({ x: n }))}
          <span className="shrink-0 pc-left-faint">Y</span>
          {numberBox("cut-segment-y", frame.y, 1, (n) => patchFrame({ y: n }))}
        </>
      ), tr("Anchor position (pixels)"))}
      {row(tr("Scale"), (
        <>
          {slider("cut-segment-scale", frame.scale, 0.05, 2, 0.01, (n) => patchFrame({ scale: n }))}
          {numberBox("cut-segment-scale-num", frame.scale, 0.01, (n) => patchFrame({ scale: Math.max(0.01, n) }), { min: 0.01 })}
        </>
      ))}
      {row(tr("Rotate"), (
        <>
          {slider("cut-segment-rotate", frame.rotate, -180, 180, 1, (n) => patchFrame({ rotate: n }))}
          {numberBox("cut-segment-rotate-num", frame.rotate, 1, (n) => patchFrame({ rotate: n }))}
          <span className="pc-left-faint">°</span>
        </>
      ))}

      <div className="mt-1 pt-2 pc-left-divider font-semibold pc-left-strong">{tr("Frame")}</div>
      {row(tr("Opacity"), (
        <>
          {slider("cut-segment-opacity", clip.opacity ?? 1, 0, 1, 0.01, (n) => run(() => actions.updateClip(clip.id, { opacity: n })))}
          {numberBox("cut-segment-opacity-num", clip.opacity ?? 1, 0.05, (n) => run(() => actions.updateClip(clip.id, { opacity: Math.max(0, Math.min(1, n)) })), { min: 0, max: 1 })}
        </>
      ))}
      <div className="flex items-center gap-2" title={fadeInLocked || fadeOutLocked ? tr("For a side controlled by a transition, delete the transition first to change it") : tr("Fade picture and sound together (seconds)")}>
        {sub(tr("Fade in"))}
        {numberBox("cut-segment-fadein", clip.fadeIn ?? 0, 0.1, (n) => run(() => actions.updateClip(clip.id, { fadeIn: Math.max(0, Math.min(len, n)) })), { min: 0, disabled: fadeInLocked })}
        {sub(tr("Fade out"))}
        {numberBox("cut-segment-fadeout", clip.fadeOut ?? 0, 0.1, (n) => run(() => actions.updateClip(clip.id, { fadeOut: Math.max(0, Math.min(len, n)) })), { min: 0, disabled: fadeOutLocked })}
        <span className="shrink-0 pc-left-faint">{tr("s")}</span>
      </div>

      <div className="mt-1 pt-2 pc-left-divider font-semibold pc-left-strong">{tr("Sound")}</div>
      {row(tr("Volume"), (
        <>
          {slider("cut-segment-volume", volume, 0, 1, 0.01, (n) => run(() => actions.setClipVolume(clip.id, n)))}
          {numberBox("cut-segment-volume-num", volume, 0.05, (n) => run(() => actions.setClipVolume(clip.id, Math.max(0, Math.min(1, n)))), { min: 0, max: 1 })}
        </>
      ), tr("Multiplies the whole mix of the referenced cut"))}
      <label className="flex items-center gap-2 pc-left-muted">
        <input
          data-pc="cut-segment-muted"
          type="checkbox"
          checked={muted}
          disabled={locked}
          onChange={(e) => run(() => actions.setClipMuted(clip.id, e.target.checked))}
        />
        {tr("Mute (silences only this segment, picture unchanged)")}
      </label>

      {err && <div data-pc="cut-segment-error" className="text-red-400 mt-1" role="alert">{err}</div>}
    </div>
  );
}

