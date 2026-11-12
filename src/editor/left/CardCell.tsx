import { useState, useRef, useLayoutEffect } from "react";
import { useStore, actions, getState } from "../../store/project";
import { AnimClock } from "../../kernel/AnimClock";
import { themeStyle } from "../../themes";
import type { CardDef } from "../../kernel/types";
import { DEFAULT_CARD_DUR } from "../../kernel/project";
import { clearDragPayload, MIME_CARD, setDragPayload } from "../dnd";
import { PreviewCard } from "./PreviewCard";
import { usePreviewZoom, zoomFor } from "./previewZoom";
import { AnimationThumb } from "./AnimationThumb";
import { tr } from "../../i18n/index.ts";

/**
 * One cell in the card library: a square preview card (PreviewCard). When not hovered it shows the name and
 * description; after 180ms of hovering it plays the animation once inside the card; click to add it at the
 * playhead, drag to drop it onto the timeline.
 *
 * The preview zoom is not based on the whole aspect ratio but on **the largest bounding box of the content
 * over the full run of the motion graphics** (previewZoom.ts): the first hover runs it once on a hidden stage
 * at accelerated speed to measure the box and caches it, then zooms in in one step and plays from the start
 * at normal speed; every later hover uses the cache directly, with no more measuring and no jitter. In a
 * 1920×1080 frame, a 400px title shrinks to a speck in a 130px card when scaled to the whole frame, but
 * scaling to the box keeps it readable.
 */
export function CardCell({ def, fill, aspect }: { def: CardDef<any>; fill?: boolean; aspect?: number }) {
  const [hot, setHot] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [error, setError] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const project = useStore((s) => s.project);

  // How long the animation is: the settle time declared by the card (computed with default parameters), or 1.5s if there is none
  const animMs = animMsOf(def);
  /*
   * Media effect cards (`card` / `audio`) and non-DOM canvas cards (`webgl` / `2d`) cannot mount bare inside a DOM
   * preview stage without their GPU host, so hovering keeps their rendered representative-frame thumbnail visible.
   */
  const live = hot && typeof def.Component === "function" && (!def.canvas || def.canvas.kind === "dom2d");
  // When `live` is true it must be a function; JSX can't hold a non-null assertion, so take it once here
  const Live = def.Component!;
  const zoom = usePreviewZoom(`card:${def.id}`, stageRef, live, animMs);

  useLayoutEffect(() => {
    if (hot && viewRef.current) {
      const rect = viewRef.current.getBoundingClientRect();
      setBox({ w: rect.width, h: rect.height });
    }
  }, [hot]);

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(MIME_CARD, def.id);
    e.dataTransfer.effectAllowed = "copy";
    setDragPayload({ kind: "card", cardId: def.id, name: def.name, duration: DEFAULT_CARD_DUR });
    (e.target as HTMLElement).classList.add("opacity-50");
  };

  const onDragEnd = (e: React.DragEvent) => {
    (e.target as HTMLElement).classList.remove("opacity-50");
    clearDragPayload();
  };

  const onClick = () => {
    const t = Math.round(getState().t * 10) / 10;
    const clip = actions.addCardClip(def.id, t, {});
    if (!clip) {
      setError(true);
      setTimeout(() => setError(false), 2000);
    }
  };

  const { scale, left, top } = zoomFor(zoom.box, box, project);

  const preview = (
    <div ref={viewRef} className="absolute inset-0">
      {!live && <AnimationThumb kind="card" def={def} />}
      {live && box.w > 0 && box.h > 0 && (
        <div data-pc="preview" className="absolute inset-0 overflow-hidden bg-black/60 pointer-events-none" style={{ ...themeStyle(project.themeId) }}>
          <div
            style={{
              position: "absolute",
              left,
              top,
              width: project.width,
              height: project.height,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
              // Don't show the measurement run to people: that pass is at accelerated speed, and after measuring it plays again from the start at normal speed.
              // Hide it with opacity rather than visibility: visibility is inherited by every child, so whoever measures the bounding box sees everything as hidden and can't measure anything
              opacity: zoom.measuring ? 0 : 1,
            }}
          >
            <div ref={stageRef} className="pc-stage" style={{ position: "relative", width: "100%", height: "100%" }} key={zoom.token}>
              <AnimClock speed={1}>
                <Live params={def.defaults} playToken={zoom.token} />
              </AnimClock>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <PreviewCard
      attrs={{ "data-pc-card": def.id }}
      title={tr(def.name)}
      caption="always"
      preview={preview}
      hoverDelayMs={180}
      onHover={setHot}
      draggable
      edits
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      error={error ? tr("No motion track, create one on the timeline first") : null}
      titleAttr={tr("Click = add at the playhead; drag = drop at a position on the timeline")}
      fill={fill}
      aspect={aspect}
    />
  );
}

/** Animation duration of the card (milliseconds): timing computed with default parameters > static lifecycle value > 1500 */
function animMsOf(def: CardDef<any>): number {
  try {
    const dyn = def.timing?.(def.defaults)?.settleMs;
    if (typeof dyn === "number" && Number.isFinite(dyn)) return dyn;
  } catch { /* If the computation blows up, use the static value */ }
  const st = def.lifecycle?.settleMs;
  return typeof st === "number" && Number.isFinite(st) ? st : 1500;
}
