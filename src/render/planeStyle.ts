/**
 * Stylesheet for the four stage planes (E7).
 *
 * Mechanism follows solid mode in `solidMode.ts`: **the component stays permanently mounted,
 * a class is added to the wrapper layer, and the stylesheet hides the subtree; what needs to be
 * displayed is the sibling plane inside the wrapper layer**: no key changes, no child node type
 * changes, React will not unmount and remount, and `pinAnimations` anchors are preserved (if anchors
 * are lost, the user sees "every time it pauses, text flies in again").
 *
 * Four classes:
 *
 *   `.pc-snapshot`   Overlaid with HTML snapshots (C3 / C4): subtree `display:none`, exempting
 *                    three planes;
 *   `.pc-suppressed` Heavy cards during playback (E7 item 5): likewise `display:none`, exempting
 *                    three planes: paste stream if available, paste nearest snapshot if missing,
 *                    transparent if neither;
 *   `.pc-awaiting`   Snapshot for this frame has not arrived yet (E0 `setTime({ awaiting })`):
 *                    `visibility:hidden`, removed by `StageView` after a 500 ms fallback to reveal
 *                    the live component: **better to reveal initial state than be permanently invisible**
 *                    (`visibility:hidden` causes `solid.ts` `isSolid` to judge it as not an entity,
 *                    so `hitTest` cannot hit it);
 *   `.pc-settling`   Performing frame catch-up using subtree virtual time (K5 pass 1): also
 *                    `visibility:hidden`. **Cannot use `display:none`**: if subtree has no layout
 *                    boxes, layout measurements like `layoutId` are all wrong, CSS animations get
 *                    cancelled to `idle`, `pinAnimations` is skipped directly, and `syncIn` cannot
 *                    pin a single step.
 *
 * When the three `display:none` classes coexist, the three rules **form a union** (not CSS
 * specificity; do not attempt to override with `display:block`); the latter two use `visibility`,
 * which do not conflict with the first three and likewise form a union. `.pc-settling` is mutually
 * exclusive with both `.pc-snapshot` and `.pc-suppressed`; mutual exclusivity is guaranteed by
 * `Stage` / `StageView`, not by CSS.
 *
 * The export page does not pass these props, so not a single character from this stylesheet will
 * be injected: pixel-by-pixel baselines remain unaffected.
 */

import { PLACEHOLDER_ATTR } from "./placeholder/contract.ts";
import { PLACEHOLDER_SLOT_ATTR } from "./placeholderHost.ts";

/**
 * All planes must be exempted: proxy color blocks, snapshot planes, stream planes, and placeholder
 * planes (slots and component root elements; product/rendering.md "Fallback order"): placeholders
 * are displayed precisely when the subtree is hidden (suppression / awaiting snapshot / frame
 * catch-up); hiding them together with these rules defeats the purpose of mounting them.
 */
const PLANES = `:not([data-pc-snapshot-plane]):not([data-pc-proxy-plane]):not([data-pc-stream-plane]):not([${PLACEHOLDER_SLOT_ATTR}]):not([${PLACEHOLDER_ATTR}])`;

export const PLANE_CSS = [
  `.pc-snapshot > *${PLANES} { display: none !important; }`,
  `.pc-suppressed > *${PLANES} { display: none !important; }`,
  `.pc-awaiting > *${PLANES} { visibility: hidden !important; }`,
  `.pc-settling > *${PLANES} { visibility: hidden !important; }`,
].join("\n");

let injected = false;

/** Injected once. Only hosts that actually use these props (stage page) will call it */
export function ensurePlaneStyle(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.dataset.pcPlanes = "1";
  s.textContent = PLANE_CSS;
  document.head.appendChild(s);
}
