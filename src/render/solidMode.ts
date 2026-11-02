import { measureContentBox, measureInk, type Ink } from "./contentBox";

/**
 * Solid mode: paints each card as a color block during browsing without rendering real content.
 * Renders real content once paused.
 *
 * # ⚠ Currently not enabled anywhere
 *
 * 2D preview in the editor once switched here during playback, but it was later reverted: the
 * contract of the 2D page is "what you see in preview = what you get in export", and replacing
 * cards with color blocks during playback broke this: when users hit play they want to see what the
 * final video looks like, not a composition sketch. Proxies now live only in the 3D view
 * (`src/editor/preview/Scene3DView.tsx`), and merely as a transition while "textures have not
 * finished rendering yet", swapping in the real image as soon as rendering finishes.
 *
 * This system was kept rather than deleted because the idea of "downgrade during browsing, real
 * render when paused" remains valid: if preview stuttering is actually encountered in the future
 * (many frosted glass elements on screen at once, etc.), it can be hooked back up. Remember two
 * rules when hooking it back up: it must be enabled **explicitly** (`?stage=1&proxy=1`), and the
 * export path must never receive this parameter.
 *
 * # Hard rule: never enter Agent's eyes
 *
 * `see_frames` goes through `server/bakery/` to launch a separate Chrome and load `?export=1`,
 * bypassing the editor window entirely. So as long as solid mode lives on the `?stage=1` path,
 * vision cannot read it at all.
 *
 * Furthermore, it must be **explicitly enabled**:
 *
 *     ?stage=1            → real render (default)
 *     ?stage=1&proxy=1    → solid mode (added only by editor preview)
 *
 * If designed in reverse (on by default, off for export), a single missed check could let export
 * silently output colored boxes, and that error would throw no exception, only to be chased as a
 * rendering bug for hours. **The degradation direction must be "slow but correct".**
 *
 * `src/StageView.tsx` starts with "what you see in preview = what you get in export". Solid mode is
 * an exception to this statement, broken in a **self-evident** way (no one mistakes colored boxes
 * for a finished product), and broken only on the human side.
 *
 * # Tier switches cannot rely on unmount and remount
 *
 * The anchor point in `src/render/pinAnimations.ts` is the "stage time **at first appearance**".
 * If a card is unmounted and remounted, it receives a new anchor point, and its entrance animation
 * replays from the beginning the moment it is upgraded: what the user sees is "every time you
 * pause, the text flies in all over again".
 *
 * Therefore real cards remain mounted continuously, merely hidden by a CSS rule:
 *   - `display:none` skips layout and paint → backdrop-filter / blur overhead drops to zero, which
 *     is exactly what needs to be saved;
 *   - Elements remain in the DOM → anchor points are not lost;
 *   - Animations are already pinned and paused by pinAnimations → hiding costs almost nothing.
 *
 * Using class + stylesheet rather than wrapping the card in an extra div: wrapping in a div causes
 * React to remount the card at the moment of switching, stumbling directly into the pitfall above.
 *
 * # Omitting color blocks for full-bleed backgrounds is intentional
 *
 * The color block box comes from measureContentBox, which skips elements that "occupy over 90% of
 * this card" as background. Consequently, cards like full-screen gradients or particle underlays
 * are invisible in solid mode: which is just right: solid mode is meant to answer "will overlaying
 * this clash or cover up subjects?", while background underlays are precisely the category that
 * does not need inspection. Drawing everything would flood the screen with a wash of color, making
 * it impossible to judge anything.
 */

/**
 * Whether this page pass can use solid mode. Checks only the URL, regardless of whether
 * it is currently active.
 */
export function proxyAllowed(): boolean {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).has("proxy");
}

/**
 * Ink color cache for cards, by clipId.
 *
 * "The instance layer comes for free": following "paused = real render", every real render of a
 * card is a sampling opportunity. **The longer it is used, the more accurate solid mode becomes**:
 * when the user changes accent or copy, the block updates accordingly. Cards that have never had a
 * real render have no entry; proxy planes fall back to a neutral gray and self-heal after browsing.
 */
const inkByClip = new Map<string, Ink>();

/**
 * The area where this card actually painted content, coordinates **relative to the card's own box**
 * (not the stage). null = content substantially fills this card, proxy plane uses inset:0 directly.
 *
 * Uses the content box instead of the card box: most cards are full-screen canvases with content
 * only in a small patch in the middle. Drawing color blocks with the card box covers the entire
 * screen, making composition impossible to evaluate: and "is this block too heavy when overlaid?"
 * is precisely the question solid mode needs to answer.
 */
const boxByClip = new Map<string, { left: number; top: number; width: number; height: number } | null>();

export interface Proxy {
  /** Color used by the proxy plane, already in an rgba() format ready to write directly to CSS */
  color: string;
  /** Rectangle relative to the card's own box; null = fills the entire card */
  box: { left: number; top: number; width: number; height: number } | null;
}

/**
 * Used for cards that have never been sampled. Neutral gray, semi-transparent: immediately
 * recognizable as "this area has not been measured yet" without being overpowering.
 */
const UNKNOWN: Proxy = { color: "rgba(148, 163, 184, 0.35)", box: null };

export function proxyOf(clipId: string): Proxy {
  const ink = inkByClip.get(clipId);
  if (!ink) return UNKNOWN;
  const [r, g, b] = ink.rgb;
  // If cover is too low the block is barely visible; set a lower bound: it must convey that
  // "something is here"
  const a = Math.max(0.12, Math.min(1, ink.cover));
  return { color: `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`, box: boxByClip.get(clipId) ?? null };
}

/**
 * Samples once after a real render. Each `[data-pc-clip]` is measured independently.
 *
 * Called only on that real render frame: under solid mode the screen shows color blocks, and
 * measuring them is equivalent to copying the previous conclusion and degrading it further.
 * If unmeasurable (canvas has not drawn yet, entire card is transparent), keep the previous
 * conclusion without overwriting with null: if a single empty measurement cleared the color,
 * color blocks would flicker on and off during browsing.
 */
export function sampleAll(stageEl: HTMLElement): void {
  for (const el of stageEl.querySelectorAll<HTMLElement>("[data-pc-clip]")) {
    const id = el.getAttribute("data-pc-clip");
    if (!id) continue;
    /*
     * Content box and ink color are measured in the same pass: measureContentBox unions the rectangles
     * of all elements with "painted content" in this card, with coordinates relative to the element
     * passed in (here the card itself), perfectly suited for direct use by proxy planes. It returns
     * null when "content fills the entire card": at that point the plane should fill the card,
     * matching the semantics exactly.
     */
    const box = measureContentBox(el);
    const ink = measureInk(el, box);
    if (ink) inkByClip.set(id, ink);
    boxByClip.set(id, box ? { left: box.l, top: box.t, width: box.r - box.l, height: box.b - box.t } : null);
  }
}

/**
 * Cleared when switching projects: clipId gets reused, so retaining old colors would
 * misattribute them.
 */
export function resetInk(): void {
  inkByClip.clear();
  boxByClip.clear();
}

/**
 * Stylesheet hiding real cards. Injected only once along the solid mode path.
 *
 * `.pc-proxy > *` matches root elements of card components (and the proxy plane itself, so it must
 * be excluded). `!important` is used because cards themselves may set display: this rule must win.
 */
let styleInjected = false;
export function ensureProxyStyle(): void {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;
  const s = document.createElement("style");
  s.dataset.pcProxy = "1";
  s.textContent = `.pc-proxy > *:not([data-pc-proxy-plane]) { display: none !important; }`;
  document.head.appendChild(s);
}
