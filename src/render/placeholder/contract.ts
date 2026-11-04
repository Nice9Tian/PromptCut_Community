/**
 * Handoff interface for the placeholder plane (P0 final draft of preview fallback task).
 *
 * When reaching the end of the fallback order, the preview displays an "hourglass + noise"
 * placeholder at the card's position instead of transparency (for semantics see
 * `docs/semantics/product/rendering.md` "Fallback order"). Each side manages one half:
 *
 *   - **Stage side** (Stage / StageView / streamPlayer, etc.): decides which card and when to
 *     display, calculates geometry, handles exclusion for screenshots / ink sampling / pixel
 *     scanning, animation pinning exemptions, and hit testing;
 *   - **Placeholder component side** (implementations under `src/render/placeholder/` other than
 *     this file): how it looks, and how to achieve near-zero overhead.
 *
 * This file only contains types, constants, and two pure functions recognized by both sides;
 * modifying it requires mutual awareness, no unilateral changes.
 *
 * # Where it mounts
 *
 * The placeholder plane is a **sibling plane** of the wrapper layer `[data-pc-clip]` (same level
 * as snapshot plane and stream plane), so coordinates, rotation, scaling, 3D perspective, opacity,
 * and z-index are all inherited from the wrapper layer. It is **mounted only in human-viewed
 * previews**: export pages, prerender processes, Agent query rendering, and background stage do
 * not mount it, nor is the stylesheet injected.
 *
 * # Visibility
 *
 * The stage side toggles only via `setPlaceholderShown` (`hidden` attribute = `display:none`),
 * bypassing React commits. The stylesheet on the placeholder component side guarantees: **truly
 * visible only after `PLACEHOLDER_SHOW_DELAY_MS` has elapsed since becoming displayed** (pure CSS
 * implementation; CSS animations restart timing when `display` switches back from none), so users
 * do not see it during shorter gaps.
 */

/** Marker attribute on placeholder plane elements. Screenshots, ink sampling, and pixel scanning skip nodes with it; hit testing hits on it count as hitting its card */
export const PLACEHOLDER_ATTR = "data-pc-placeholder-plane";

/** Placeholder is shown only after falling-behind state lasts this long (debouncing, settled, immutable) */
export const PLACEHOLDER_SHOW_DELAY_MS = 120;

/** CSS animation names / WAAPI animation IDs of the placeholder component all start with this; animation pinning is exempted only via `isPlaceholderAnimation` */
export const PLACEHOLDER_ANIMATION_PREFIX = "pc-ph-";

/**
 * Reason for showing the placeholder (for diagnostics, can also determine subtle visual
 * differences; appearance is not required to change with it).
 *
 *   - `no-data`      T1: end of fallback chain, this layer does not yet have any prerender output;
 *   - `over-budget`  T1: stream exceeds decoder budget, and frame-switch budget cannot accommodate
 *                    snapshots;
 *   - `awaiting`     T2: snapshot for this frame has not arrived yet;
 *   - `catching-up`  T3 / T4: catch up frames invisibly, or wait for background stage catch-up run
 *                    before swapping.
 *
 * Cards that cannot be rendered on this device (user cards and media effect cards that cannot run
 * in online browser mode) are likewise `awaiting` (hourglass) when nothing can be pasted: results
 * are produced by render nodes and automatically swapped in upon arrival. The former `unsupported`
 * ("computer + offline" icon and "Local PC assisted rendering" prompt) was removed (user decision,
 * 2026-10-21): "In neither case does 'Local PC assisted rendering' exist."
 */
export type PlaceholderReason = "no-data" | "over-budget" | "awaiting" | "catching-up";

/**
 * Slot (added to interface in P3): the stage attaches a `position:absolute; inset:0` slot in each
 * card's wrapper layer, and the placeholder component renders inside it. Visibility toggles the
 * **slot's** `hidden` attribute (the component is stateless, so React commits will not overwrite
 * manually toggled values); the component root element itself does not carry `hidden`.
 *
 * `PLACEHOLDER_FIXED_ATTR`: originally marked "resident slots" (used by the now-removed
 * `unsupported` icon). The stage no longer mounts resident slots; the constant is kept only so
 * legacy screenshot / probe scripts recognize this name.
 */
export const PLACEHOLDER_SLOT_ATTR = "data-pc-placeholder-slot";
export const PLACEHOLDER_FIXED_ATTR = "data-pc-placeholder-fixed";

/**
 * When placeholders displayed on the same screen exceed `maxAnimated`, the stage adds this
 * attribute to the **slot** for excess ones, causing the component stylesheet to keep the hourglass
 * static (still visible).
 */
export const PLACEHOLDER_STATIC_ATTR = "data-pc-placeholder-static";

/** Rectangle, relative to wrapper layer, stage pixels */
export interface PlaceholderBox { left: number; top: number; width: number; height: number }

/**
 * Geometry, provided by the stage side:
 *   - `solid`: measurable entity box: noise fills the entity box, hourglass centered;
 *   - `badge`: unmeasurable entity box: displays a small hourglass badge **only** at the center of
 *     the position box, without noise (settled, immutable). `center` is the position box center,
 *     relative to wrapper layer, stage pixels.
 */
export type PlaceholderGeometry =
  | { kind: "solid"; box: PlaceholderBox }
  | { kind: "badge"; center: { x: number; y: number } };

export interface PlaceholderPlaneProps {
  clipId: string;
  geometry: PlaceholderGeometry;
  reason: PlaceholderReason;
  /**
   * Size on screen (computed by stage side based on preview scale, this layer's scale, and box;
   * `placeholderFit.ts`): `scale` is the component's magnification factor in wrapper layer coordinates.
   * Omitted = scale 1 (drawn as-is in stage pixels). The hourglass only scales the hourglass itself
   * (the badge circle, the middle one in solid form), while noise still fills the entity box as usual.
   */
  fit?: { scale: number };
}

/**
 * Shape required of modules delivered by the placeholder component side
 * (`src/render/placeholder/index.ts` exports these names).
 *
 * - `PlaceholderPlane`: pure rendering: no state, no effect, no timers, no rAF, no layout reads;
 *   does not re-render if props do not change (React.memo). Root element must carry
 *   `PLACEHOLDER_ATTR` and position via `position:absolute` solely according to `geometry`;
 *   **must not set `pointer-events:none`** (hit testing relies on `elementsFromPoint`, hitting the
 *   placeholder counts as hitting its card). Return value is a React element, typed here as
 *   `unknown` to keep this file free of React dependencies.
 * - `PLACEHOLDER_CSS`: full stylesheet (noise texture inlined), injected once upon stage startup;
 *   must not override `[hidden]`'s `display:none`.
 * - `maxAnimated`: when placeholders on the same screen exceed this number, excess hourglasses
 *   become static (still visible, not made transparent).
 * - `layersFor(n)`: estimated newly added composite layers when there are n placeholders on screen
 *   (measured experimentally, used by stage side for upper-limit protection).
 */
export interface PlaceholderModule {
  PlaceholderPlane: (props: PlaceholderPlaneProps) => unknown;
  PLACEHOLDER_CSS: string;
  maxAnimated: number;
  layersFor(n: number): number;
}

/** Whether this Animation belongs to the placeholder itself (CSS animations check `animationName`, WAAPI checks `id`) */
export function isPlaceholderAnimation(a: { id?: string; animationName?: string }): boolean {
  const name = a.animationName ?? a.id ?? "";
  return typeof name === "string" && name.startsWith(PLACEHOLDER_ANIMATION_PREFIX);
}

/** Sole entry point for stage side to toggle visibility: bypasses React commits, mutates only `hidden` attribute */
export function setPlaceholderShown(el: { hidden: boolean }, on: boolean): void {
  if (el.hidden === on) el.hidden = !on;
}
