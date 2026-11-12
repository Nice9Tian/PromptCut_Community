import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { actions, getState, useStore } from "../../store/project";
import { findClip } from "../../kernel/project";
import { addPart } from "../../kernel/parts";
import { getPart } from "../../kernel/partRegistry";
import type { PartDef } from "../../kernel/partTypes";
import type { PartInstance } from "../../kernel/types";
import { COMPOSITE_CARD_ID } from "../../cards/native/composite";
import { isComposite } from "../../kernel/envelope";
import { AnimClock } from "../../kernel/AnimClock";
import { PartTree } from "../../render/PartTree";
import { themeStyle } from "../../themes";
import { PreviewCard } from "./PreviewCard";
import { usePreviewZoom, zoomFor } from "./previewZoom";
import { AnimationThumb } from "./AnimationThumb";
import { tr } from "../../i18n/index.ts";

/**
 * One cell in the left rail's "Parts library": same shell (PreviewCard) and same hover preview as the card
 * cell (CardCell).
 *
 * How the preview works: place this part into a 1920×1080 composite card canvas at its defaultFrame, and
 * run it through the PartTree that actually renders composite cards on the stage. What you see in the
 * preview is what you would see after adding it to the timeline. While hovering, t advances with the clock,
 * so parts that follow t (Lottie, typewriter, chapter bar) animate too.
 * Zoom uses the largest bounding box over the full run of the motion graphics, measured once and cached
 * (previewZoom.ts).
 *
 * Click: if a composite card is currently selected, add the part to it; otherwise create a new composite
 * card at the playhead containing just this one part.
 * A part cannot go on the timeline on its own; it always lives inside a composite card.
 */
export function PartCell({ def, fill, aspect }: { def: PartDef<any>; fill?: boolean; aspect?: number }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [hot, setHot] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [t, setT] = useState(0);
  const viewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const project = useStore((s) => s.project);

  const flash = (text: string) => { setMsg(text); setTimeout(() => setMsg(null), 1800); };

  // Instance used for the preview: default parameters + default frame, identical to what add_part produces
  // when called without parameters
  const preview = useMemo<PartInstance[]>(
    () => [{ id: "preview", partId: def.id, params: { ...def.defaults }, ...(def.defaultFrame ? { frame: { ...def.defaultFrame } } : {}) }],
    [def],
  );

  const animMs = animMsOf(def);
  const zoom = usePreviewZoom(`part:${def.id}`, stageRef, hot, animMs);

  useLayoutEffect(() => {
    if (hot && viewRef.current) {
      const rect = viewRef.current.getBoundingClientRect();
      setBox({ w: rect.width, h: rect.height });
    }
  }, [hot]);

  // While hovering, t follows the clock: PartTree uses t to decide mounting and the progress of parts that
  // follow the timeline (during the measurement run, measure at t = 0)
  useEffect(() => {
    if (!hot || zoom.measuring) { setT(0); return; }
    const t0 = performance.now();
    let raf = 0;
    const tick = () => { setT((performance.now() - t0) / 1000); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hot, zoom.token, zoom.measuring]);

  const onClick = () => {
    try {
      const st = getState();
      const sel = st.selection[0] ? findClip(st.project, st.selection[0]) : null;
      if (sel && isComposite(sel.clip)) {
        const { tree } = addPart(sel.clip.parts ?? [], { partId: def.id }, getPart);
        actions.setClipParts(sel.clip.id, tree);
        flash(tr("Added to the selected composite card"));
        return;
      }
      const tt = Math.round(st.t * 10) / 10;
      const { tree } = addPart([], { partId: def.id }, getPart);
      const clip = actions.addCardClip(COMPOSITE_CARD_ID, tt, { parts: tree });
      if (!clip) { flash(tr("No motion track, create one on the timeline first")); return; }
      actions.select([clip.id]);
      flash(tr("Created a new composite card"));
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  };

  const { scale, left, top } = zoomFor(zoom.box, box, project);

  const view = (
    <div ref={viewRef} className="absolute inset-0">
      {!hot && <AnimationThumb kind="part" def={def} />}
      {hot && box.w > 0 && box.h > 0 && (
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
              // Hide the measurement run with opacity, not visibility: visibility is inherited by every child element,
              // so whoever measures the bounding box sees everything as hidden and measures nothing
              opacity: zoom.measuring ? 0 : 1,
            }}
          >
            <div ref={stageRef} className="pc-stage" style={{ position: "relative", width: "100%", height: "100%" }} key={zoom.token}>
              <AnimClock speed={1}>
                <PartTree parts={preview} size={{ width: project.width, height: project.height }} t={t} playToken={zoom.token} />
              </AnimClock>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <PreviewCard
      attrs={{ "data-pc-part-cell": def.id }}
      title={tr(def.name)}
      subtitle={def.role}
      caption="always"
      preview={view}
      hoverDelayMs={180}
      onHover={setHot}
      edits
      onClick={onClick}
      error={msg}
      titleAttr={tr("{0}\nClick = add to the selected composite card; if none is selected, create a new one at the playhead", def.description)}
      fill={fill}
      aspect={aspect}
    />
  );
}

/** Animation duration of the part (milliseconds): settleMs computed with default parameters, else 1500 */
function animMsOf(def: PartDef<any>): number {
  try {
    const v = def.settleMs?.(def.defaults);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  } catch { /* Computation blew up, use defaults */ }
  return 1500;
}
