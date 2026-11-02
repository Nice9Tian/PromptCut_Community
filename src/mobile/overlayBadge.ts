import { tr } from "../i18n/index.ts";
/**
 * The overlay card badge on a clip in the mobile app.
 *
 * # Why the phone does not draw the desktop strip
 *
 * A phone clip is only 30px high (`.clip` in `mobile.css`). Cutting a 13px strip at the desktop's proportion
 * leaves 17px for the name, which is already barely enough, and each card in the strip is only 13px high and 40px wide, below any touch target that can be hit.
 * So the phone keeps only a count badge (its position and size are like the existing "muted" badge),
 * and real edits go in the "Adjust" form that tapping a clip pops up anyway.
 *
 * # The badge at the narrowest tier does not take clicks
 *
 * When the name has been squeezed out entirely, the badge is almost the whole clip: users mostly want to select this clip, but a slip of the finger lands in an overlay card.
 * At that tier the whole hit area is given back to the clip, and the entry is left to "Overlay" in the sub-navigation.
 */

/** At or above this width the badge reads "Overlay N"; below it, only the number */
export const OVM_WIDE_PX = 120;
/** Below this width the badge is just a marker and does not take clicks: it takes up more than a third of the clip */
export const OVM_TAP_PX = 64;

export interface OverlayBadgePlan {
  text: string;
  /** Whether it can be clicked. When not, the whole hit area belongs to the clip */
  tappable: boolean;
}

/** How to draw the badge when this clip has `count` cards attached and the clip width is `widthPx`; draw nothing if none are attached */
export function planOverlayBadge(widthPx: number, count: number): OverlayBadgePlan | null {
  if (!(count > 0)) return null;
  return {
    text: widthPx >= OVM_WIDE_PX ? tr("Overlay {0}", count) : String(count),
    tappable: widthPx >= OVM_TAP_PX,
  };
}
