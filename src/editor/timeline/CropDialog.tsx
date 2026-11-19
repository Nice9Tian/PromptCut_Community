/**
 * Crop dialog (the timeline toolbar's Crop, `EditTools.tsx`): the clip's picture at the playhead with a
 * crop rectangle on it. Drag inside the rectangle to move it, drag its handles to resize it, or pick an
 * aspect ratio; arrow keys move it too. OK writes the crop with `actions.cropClip`, which also reshapes
 * the clip's box to the cropped part (kernel/mediaPicture.mjs `boxForCrop`); Reset goes back to the whole
 * picture.
 *
 * The picture is shown as it plays (mirrored when the clip is mirrored, not rotated: a crop is cut out of
 * the picture before the box turns it), and the rectangle is edited in those shown coordinates
 * (`cropRect.ts`).
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { findClip, isImageMedia } from "../../kernel/project";
import { mediaAspect } from "../../kernel/mediaPicture.mjs";
import { mediaTimeAt } from "../../kernel/clipTime.mjs";
import { actions, getState, useStore } from "../../store/project";
import { usePreviewMediaUrl } from "../media/previewUrl";
import { FULL_RECT, fitRatio, fractionRatio, mirrorRect, moveRect, resizeRect, type CropHandle, type CropRect } from "./cropRect";
import { tr } from "../../i18n/index.ts";

/** Aspect ratio presets (width / height in pixels): null = free, "source" = the picture's own */
const RATIOS: { key: string; label: () => string; px: number | "source" | null }[] = [
  { key: "free", label: () => tr("Free"), px: null },
  { key: "source", label: () => tr("Original"), px: "source" },
  { key: "16:9", label: () => "16:9", px: 16 / 9 },
  { key: "9:16", label: () => "9:16", px: 9 / 16 },
  { key: "4:3", label: () => "4:3", px: 4 / 3 },
  { key: "3:4", label: () => "3:4", px: 3 / 4 },
  { key: "1:1", label: () => "1:1", px: 1 },
];
const HANDLES: CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** Arrow keys move the rectangle by this fraction of the picture (Shift: ten times as far) */
const KEY_STEP = 0.01;
const pct = (f: number) => `${f * 100}%`;

export function CropDialog({ clipId, onClose }: { clipId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // Select stable values (the clip object, a boolean): a fresh object per read would re-render forever
  const clip = useStore((s) => findClip(s.project, clipId)?.clip);
  const locked = useStore((s) => !!findClip(s.project, clipId)?.track.locked);
  const media = useStore((s) => (clip?.mediaId ? s.project.media.find((m) => m.id === clip.mediaId) : undefined));
  const src = usePreviewMediaUrl(media) || undefined;
  const mirrored = !!clip?.flipX;
  // Which second of the media to show: the playhead's, when it is inside the clip, else the clip's first frame
  const [atSec] = useState(() => (clip ? mediaTimeAt(clip, Math.min(Math.max(getState().t, clip.start), clip.end - 1e-3)) : 0));
  const [rect, setRect] = useState<CropRect>(() => mirrorRect(clip?.crop ?? FULL_RECT, mirrored));
  const [ratioKey, setRatioKey] = useState("free");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    // No element when the clip was already gone on the first render (it closes right away, below)
    const el = dialog.current;
    if (!el) return;
    el.showModal();
    return () => el.close();
  }, []);
  // The clip went away (deleted here or by someone else, undone): nothing left to crop
  useEffect(() => { if (!clip || !media) onClose(); }, [clip, media, onClose]);
  if (!clip || !media) return null;

  // The picture's aspect ratio: as the asset recorded it (what rendering uses), else as it loads here
  const aspect = mediaAspect(media) ?? (natural ? natural.w / natural.h : null);
  const preset = RATIOS.find((r) => r.key === ratioKey)!;
  const ratio = aspect === null || preset.px === null ? null : preset.px === "source" ? 1 : fractionRatio(preset.px, aspect);
  const size = media.width && media.height ? { w: media.width, h: media.height } : natural;

  const pickRatio = (key: string) => {
    setRatioKey(key);
    const px = RATIOS.find((r) => r.key === key)!.px;
    if (px !== null && aspect !== null) setRect((r) => fitRatio(r, px === "source" ? 1 : fractionRatio(px, aspect)));
  };
  const apply = () => {
    if (aspect === null) return;
    const result = actions.cropClip(clip.id, mirrorRect(rect, mirrored), { sourceAspect: aspect });
    if (!result.ok) setError(result.error);
    else onClose();
  };

  return createPortal(
    <dialog ref={dialog} className="pc-crop-dialog" aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onKeyDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <form onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <h3 id={titleId}>{tr("Crop")}</h3>
        <p className="pc-crop-name">{clip.label || media.name}</p>
        <CropView src={src} image={isImageMedia(media)} atSec={atSec} mirrored={mirrored} aspect={aspect}
          rect={rect} ratio={ratio} onRect={setRect} onNatural={setNatural} onError={() => setError(tr("The picture could not be loaded"))} />
        <RatioPicker value={ratioKey} onPick={pickRatio} />
        <CropFooter size={size} rect={rect} error={error} canApply={aspect !== null && !locked}
          onReset={() => { setRatioKey("free"); setRect(FULL_RECT); }} onCancel={onClose} />
      </form>
    </dialog>, document.body,
  );
}

/** Size of the crop in source pixels, an error if any, and the buttons (OK submits the dialog's form) */
function CropFooter({ size, rect, error, canApply, onReset, onCancel }: {
  size: { w: number; h: number } | null; rect: CropRect; error: string; canApply: boolean; onReset: () => void; onCancel: () => void;
}) {
  return (
    <>
      <p className="pc-crop-meta">{size ? tr("Cropped size {0} × {1} px", Math.round(rect.w * size.w), Math.round(rect.h * size.h)) : tr("Loading the picture…")}</p>
      {error && <p role="alert">{error}</p>}
      <div className="pc-crop-actions">
        <button type="button" onClick={onReset}>{tr("Reset crop")}</button>
        <button type="button" onClick={onCancel}>{tr("Cancel")}</button>
        <button type="submit" disabled={!canApply}>{tr("OK")}</button>
      </div>
    </>
  );
}

/** The aspect ratio presets, one pressed */
function RatioPicker({ value, onPick }: { value: string; onPick: (key: string) => void }) {
  return (
    <div className="pc-crop-ratios" role="group" aria-label={tr("Aspect ratio")}>
      {RATIOS.map((r) => (
        <button key={r.key} type="button" className={value === r.key ? "is-on" : ""} aria-pressed={value === r.key} onClick={() => onPick(r.key)}>
          {r.label()}
        </button>
      ))}
    </div>
  );
}

/** The picture with the crop rectangle over it; drags and arrow keys report a new rectangle through `onRect` */
function CropView({ src, image, atSec, mirrored, aspect, rect, ratio, onRect, onNatural, onError }: {
  src: string | undefined; image: boolean; atSec: number; mirrored: boolean; aspect: number | null;
  rect: CropRect; ratio: number | null;
  onRect: (r: CropRect) => void; onNatural: (n: { w: number; h: number }) => void; onError: () => void;
}) {
  const view = useRef<HTMLDivElement>(null);
  /** The drag in progress: what is dragged, where the pointer started, the picture's size on screen, the rectangle at the start */
  const drag = useRef<{ what: "move" | CropHandle; x: number; y: number; w: number; h: number; from: CropRect } | null>(null);

  const begin = (what: "move" | CropHandle) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !view.current) return;
    e.preventDefault();
    e.stopPropagation();
    const box = view.current.getBoundingClientRect();
    drag.current = { what, x: e.clientX, y: e.clientY, w: box.width, h: box.height, from: rect };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const follow = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !d.w || !d.h) return;
    const dx = (e.clientX - d.x) / d.w;
    const dy = (e.clientY - d.y) / d.h;
    onRect(d.what === "move" ? moveRect(d.from, dx, dy) : resizeRect(d.from, d.what, dx, dy, ratio));
  };
  const end = () => { drag.current = null; };
  const nudge = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? KEY_STEP * 10 : KEY_STEP;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    onRect(moveRect(rect, d[0], d[1]));
  };

  const mediaStyle: React.CSSProperties = mirrored ? { transform: "scaleX(-1)" } : {};
  return (
    <div className="pc-crop-stage">
      {/* Sized to the picture's own aspect ratio (once known), so the rectangle's fractions are fractions of the picture */}
      <div ref={view} className="pc-crop-picture" style={aspect ? { aspectRatio: String(aspect), width: `min(100%, ${aspect * 100}cqh)` } : undefined}>
        {!src ? null : image ? (
          <img src={src} alt="" style={mediaStyle} onError={onError}
            onLoad={(e) => onNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        ) : (
          <video src={src} muted playsInline preload="auto" style={mediaStyle} onError={onError}
            onLoadedMetadata={(e) => { const v = e.currentTarget; v.currentTime = atSec; onNatural({ w: v.videoWidth, h: v.videoHeight }); }} />
        )}
        {aspect && (
          <div className="pc-crop-rect" tabIndex={0} role="slider" aria-label={tr("Crop area")} aria-valuetext={tr("{0}% × {1}% of the picture", Math.round(rect.w * 100), Math.round(rect.h * 100))}
            style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
            onPointerDown={begin("move")} onPointerMove={follow} onPointerUp={end} onPointerCancel={end} onKeyDown={nudge}>
            {HANDLES.map((h) => <span key={h} className={`pc-crop-handle is-${h}`} onPointerDown={begin(h)} />)}
          </div>
        )}
      </div>
    </div>
  );
}
