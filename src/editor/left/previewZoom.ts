import { useEffect, useMemo, useState, type RefObject } from "react";
import { measureAcrossTime, type Box } from "../../render/contentBox";
import { lookupBox, rememberBox } from "./previewBoxes";
import { startPrewarm } from "./prewarmBoxes";
import { getState } from "../../store/project";

/**
 * Preview card zoom: scale by the bounding box of the largest content over the **full run** of the motion
 * graphics.
 *
 * The box has two sources (previewBoxes.ts):
 *   1. **Already computed**: the static table shipped with the package (`src/cards/preview-boxes.json`) or
 *      the local cache. Used directly on hover, one step, no measurement run, no black screen;
 *   2. **Measured on the spot**: if the table lacks it (cards newly created by users / AI, newly added
 *      parts, static table not yet generated), fall back to the DOM measurement here: mount the stage
 *      hidden first (opacity 0), and once the animation is built, step through the Web Animations inside
 *      one by one and measure the union; after measuring, store it in the cache, zoom in, and play it
 *      normally from the start.
 *
 * Also, the first use of this hook (= the first time the cards tab is opened) kicks off the background
 * top-up measuring (prewarmBoxes.tsx), which slowly computes the cards missing from the table off-screen,
 * after which everything takes path 1.
 */
export interface PreviewZoom {
  /** Box used for zooming; null = content fills the whole frame, show the whole frame */
  box: Box | null;
  /** Measurement run in progress: stage is hidden */
  measuring: boolean;
  /** +1 on every replay, used as a key to remount */
  token: number;
}

const MAX_MEASURE_MS = 4000;
/** After mounting, wait for the animation to be built before measuring; motion only creates Web Animations on the frame after mount */
const SETTLE_DELAY_MS = 80;

/** To re-measure after a card's source hot update: previewBoxes' forgetBoxes drops the cache, then refresh the page */
export { forgetBoxes as invalidatePreviewZoom } from "./previewBoxes";

export function usePreviewZoom(key: string, stageRef: RefObject<HTMLElement | null>, hot: boolean, animMs: number): PreviewZoom {
  const [measured, setMeasured] = useState<{ key: string; box: Box | null } | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [token, setToken] = useState(0);
  const { width, height } = getState().project;

  // Look up the table once at render time: if the box were applied after the effect runs, the first frame
  // would be drawn at the whole frame first, and the jump would be visible to the eye
  const known = useMemo(() => lookupBox(key, width, height), [key, width, height, measured]);

  // The first cell to use the preview = the cards tab is open, so start up the background top-up measuring
  useEffect(() => { startPrewarm(); }, []);

  useEffect(() => {
    if (!hot) return;
    setToken((n) => n + 1);

    // Already computed (static table / local cache / measured earlier in this session): use it directly, do not measure again
    if (lookupBox(key, width, height).has) {
      setMeasuring(false);
      return;
    }

    // Not computed: measure it on the spot
    setMeasuring(true);
    const total = Math.min(MAX_MEASURE_MS, Math.max(400, animMs) + 300);
    const timer = window.setTimeout(() => {
      const stage = stageRef.current;
      let union: Box | null = null;
      try {
        union = stage ? measureAcrossTime(stage, total) : null;
      } catch {
        union = null; // If measuring blew up, use the whole frame, do not leave the preview stuck
      }
      rememberBox(key, width, height, union);
      setMeasured({ key, box: union });
      setMeasuring(false);
      // After measuring, play it again from the start at normal speed
      setToken((n) => n + 1);
    }, SETTLE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hot, key, animMs, stageRef, width, height]);

  return { box: measured?.key === key ? measured.box : known.box, measuring, token };
}

/** If there is a box, zoom in to the box (with a margin); otherwise the whole frame; returns where to place the stage and the scale */
export function zoomFor(box: Box | null, view: { w: number; h: number }, stage: { width: number; height: number }, pad = 0.1) {
  const fullScale = view.w && view.h ? Math.min(view.w / stage.width, view.h / stage.height) : 1;
  let scale = fullScale;
  let left = (view.w - stage.width * scale) / 2;
  let top = (view.h - stage.height * scale) / 2;
  if (box) {
    const bw = Math.max(1, box.r - box.l);
    const bh = Math.max(1, box.b - box.t);
    scale = Math.min(view.w / (bw * (1 + pad * 2)), view.h / (bh * (1 + pad * 2)));
    // Do not zoom in farther than the whole frame (fall back to the whole frame when the box was mismeasured as a huge area), and do not magnify until it blurs into a mosaic
    scale = Math.max(fullScale, Math.min(scale, 2));
    const cx = (box.l + box.r) / 2;
    const cy = (box.t + box.b) / 2;
    left = view.w / 2 - cx * scale;
    top = view.h / 2 - cy * scale;
  }
  return { scale, left, top };
}
