/**
 * The **stage side** of the placeholder plane (product/rendering.md "Fallback order"; interface: see
 * `placeholder/contract.ts`).
 *
 * It does four things, none of which touches React or imports the placeholder component itself (the
 * component is imported by `Stage.tsx`; once B is delivered, only that one import line is swapped):
 *
 *   1. **Whether to mount**: only previews that a human watches (the stage page, the `front` role)
 *      mount it. The export page, prerender and Agent query renders never call
 *      `setPlaceholdersEnabled(true)`; `StageView` turns it off on `setRole('back')`. While it is off,
 *      `Stage` renders no nodes at all and injects no stylesheet, so the export pixel baseline is
 *      unaffected.
 *   2. **Who is shown** (`placeholderWanted`, a pure function): T1 end of the fallback chain
 *      (suppressed, the stream is blank this tick, and no snapshot is attached), T2 `.pc-awaiting`
 *      (the snapshot has not arrived and the stream is not drawing this tick either), T3
 *      `.pc-settling` with no snapshot attached (invisible frame catch-up), T4 light cards waiting for
 *      the background catch-up run swap (suppressed, and the dispatch table says it is a light card at
 *      this moment). In online browser mode, cards this device cannot run (user cards, media effect
 *      cards) always get the hourglass `awaiting` when there is no snapshot / stream to paste, until
 *      the render node's result arrives and replaces it (user decision, 2026-10-21: there is no
 *      "local PC-assisted render" case).
 *   3. **Show / hide**: after every tick / every plane commit, `StageView` uses the result above to
 *      toggle the slot's `hidden` with only the contract's `setPlaceholderShown`, bypassing React
 *      commits (`applyPlaceholders`). Becoming visible only after a full 120 ms is handled by the
 *      placeholder component's CSS.
 *   4. **Geometry** (`geometryFor`): the stream manifest's entity box (`tight ?? bound`) → the ink box
 *      measured at this card's last live render → if neither exists, just a small hourglass badge at
 *      the center of the position box (`badge`, no noise fill). Coordinates are always relative to the
 *      wrapper layer, in stage pixels.
 *
 * # Slot
 *
 * `Stage` mounts a `[data-pc-placeholder-slot]` in each card's wrapper layer (at the same level as the
 * snapshot / stream planes, `position:absolute;
 * inset:0`, `hidden` by default), and the placeholder component renders inside the slot. What gets
 * toggled is the slot's `hidden`: the contract does not specify the initial visibility of the
 * component's root element, and the component is stateless pure rendering, so the slot holds it, and
 * no React commit wipes out a `hidden` that was toggled by hand (the prop is always `true`, so React
 * never rewrites it). Screenshots, ink sampling, pixel scans and hit tests treat the slot and the
 * component root element alike (`isPlaceholderNode`).
 */
import {
  PLACEHOLDER_ATTR, PLACEHOLDER_SLOT_ATTR, PLACEHOLDER_STATIC_ATTR, setPlaceholderShown,
  type PlaceholderBox, type PlaceholderGeometry, type PlaceholderReason,
} from "./placeholder/contract.ts";
import { cardRunnableHere, getCard, graphCardsRunnableHere, isUserCardId } from "../kernel/registry.ts";
import { hourglassFit, type PlaceholderFit } from "./placeholderFit.ts";

/**
 * The slot in the wrapper layer that holds the placeholder component (the constant lives in the
 * contract; it is re-exported here for existing referrers)
 */
export { PLACEHOLDER_SLOT_ATTR };
/** Slot or component root element: exclusion / hit testing both go by it */
export const PLACEHOLDER_SELECTOR = `[${PLACEHOLDER_SLOT_ATTR}],[${PLACEHOLDER_ATTR}]`;

/** Whether this node is part of the placeholder (slot, component root element, or anything inside them) */
export function isPlaceholderNode(el: Element | null | undefined): boolean {
  return !!el && typeof el.closest === "function" && !!el.closest(PLACEHOLDER_SELECTOR);
}

/* ------------------------------------------------------------------ 1. Whether to mount */

let enabled = false;

/**
 * Only `StageView` (the stage page, the `front` role) turns it on. Off by default: the export page /
 * prerender / background stage have no nodes at all
 */
export function setPlaceholdersEnabled(on: boolean): void {
  enabled = !!on;
}

export function placeholdersEnabled(): boolean {
  return enabled;
}

let styleEl: HTMLStyleElement | null = null;
/** The placeholder component's whole stylesheet, injected once when enabled (the export page never gets here) */
export function ensurePlaceholderStyle(css: string): void {
  if (styleEl || typeof document === "undefined" || !css) return;
  styleEl = document.createElement("style");
  styleEl.dataset.pcPlaceholder = "1";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
}

/**
 * Remove the stylesheet (`setRole('back')`): after the K5 swap this stage has become the background
 * stage, so "the background stage does not inject placeholder styles" has to hold for it too. When it
 * is promoted again, `Stage` injects the stylesheet anew.
 */
export function removePlaceholderStyle(): void {
  styleEl?.remove();
  styleEl = null;
}

/* ------------------------------------------------------------------ 2. Who is shown */

export interface PlaceholderState {
  /** Cards suppressed during playback (classify as heavy, plus the extra suppression of K3(b)) */
  suppressed: ReadonlySet<string>;
  /** Cards that have a snapshot plane attached right now */
  snapshots: ReadonlyMap<string, unknown> | ReadonlySet<string>;
  /** `.pc-awaiting`: the snapshot for this frame has not arrived yet */
  awaiting: ReadonlySet<string>;
  /** `.pc-settling`: frame catch-up is in progress, invisibly */
  settling: ReadonlyMap<string, unknown>;
  /** Cards whose stream picture is present this tick (`StreamPlayer.showingClips()`) */
  streamShowing: ReadonlySet<string>;
  /**
   * Cards that are suppressed but classified as light at this moment (K3(b)'s `vtOk = false` light cards
   * waiting for the background catch-up run); by default, the set from `setCatchingUpClips` is used
   */
  isLight?: (clipId: string) => boolean;
  /**
   * Cards that are present right now and that this device cannot run (user cards and media effect cards
   * in online browser mode; `localOnlyClipIds`). They paste a snapshot / stream following the fallback
   * order; when nothing can be pasted they show the hourglass `awaiting`, also while paused, and the
   * render node's result replaces it automatically once it arrives. Whether they are suppressed or
   * waiting for a snapshot does not matter. Empty by default.
   */
  unsupported?: ReadonlySet<string>;
}

/**
 * The cards of T4 (suppressed, classified as light at this moment: waiting for the swap after the
 * background catch-up run). `StageView` works them out from the dispatch table when it receives
 * `setSuppressed`
 */
let catchingUp: ReadonlySet<string> = new Set();
export function setCatchingUpClips(ids: Iterable<string>): void {
  catchingUp = new Set(ids);
}
export function isCatchingUpClip(clipId: string): boolean {
  return catchingUp.has(clipId);
}

/**
 * Which cards show a placeholder this tick, and why (T1~T4; cards this device cannot run get the
 * hourglass `awaiting` at the end of the fallback order: the result is produced by the render node)
 */
export function placeholderWanted(s: PlaceholderState): Map<string, PlaceholderReason> {
  const out = new Map<string, PlaceholderReason>();
  const unsupported = s.unsupported;
  // Cards this device cannot run: not shown while a snapshot or stream is pasted on; otherwise the
  // hourglass (the result comes from the render node and replaces it automatically on arrival)
  if (unsupported) {
    for (const id of unsupported) {
      if (s.snapshots.has(id) || s.streamShowing.has(id)) continue;
      out.set(id, "awaiting");
    }
  }
  const skip = (id: string) => !!unsupported?.has(id);
  for (const id of s.suppressed) {
    if (skip(id)) continue;
    if (s.snapshots.has(id) || s.streamShowing.has(id)) continue;
    // T4: light cards waiting to swap after the background catch-up run; the rest are T1 (end of the
    // fallback chain)
    out.set(id, (s.isLight ?? isCatchingUpClip)(id) ? "catching-up" : "no-data");
  }
  // T2: the snapshot has not arrived (the stage removes `.pc-awaiting` after the 500 ms fallback, and
  // the placeholder is withdrawn with it)
  // Not shown if this card's stream is drawing this tick (single-card stream, the group stream it is in,
  // a below-dependent stream; one still holding the previous card's segment also counts): the stream
  // comes first in the fallback order, so when the stream is drawing the placeholder gets no turn. A layer
  // that is over budget and emits no stream has no track and is not in `streamShowing`, so it is shown
  // as before
  for (const id of s.awaiting) if (!skip(id) && !s.streamShowing.has(id)) out.set(id, "awaiting");
  // T3: invisible frame catch-up, with no snapshot underneath
  for (const id of s.settling.keys()) {
    if (skip(id)) continue;
    if (!s.snapshots.has(id) && !out.has(id)) out.set(id, "catching-up");
  }
  return out;
}

/* ------------------------------------------------------------------ 2b. Cards this machine cannot render (unsupported) */

/**
 * Online browser mode (product/platforms.md "Online browser"): for user cards and media effect cards
 * that this device cannot run (transpilation failed, they reference modules the page does not have,
 * there is no isolated environment, or graphics capability is insufficient), a prerender output is
 * pasted if one exists, the same as for built-in cards (always treated as heavy cards: suppressed during
 * playback, no live render, no catch-up when stopped); when nothing can be pasted, the hourglass is
 * shown at the end of the fallback order, and the render node's result replaces it automatically on
 * arrival (user decision, 2026-10-21: there is no "local PC-assisted render").
 *
 * Switch: the online page (`ONLINE`) and `platform=browser` on the stage address (used by screenshots
 * and probes). What the desktop, export, prerender and the Agent see is always off.
 */
let onlineBrowser = false;
export function setOnlineBrowserMode(on: boolean): void {
  onlineBrowser = !!on;
}
export function onlineBrowserMode(): boolean {
  return onlineBrowser;
}

/*
 * User cards synced into the export page of online frame-by-frame export (the `?export=1` document
 * with the same origin as the editor page, in the iframe opened by `src/export/frameCompositor.ts`):
 * this document does not execute card code and has no definitions for them, but export has to replace
 * the wrapper layer of these cards in every frame with the original-size prerender (contract section 8,
 * "Online export"), so the wrapper layers must be mounted first. The editor page hands the sync table
 * to the export page via `__pcSetSyncedUserCards` and turns this switch on; it only takes effect for
 * "synced cards without a definition". Built-in cards, media effect cards and desktop export stay
 * exactly as they were (the switch is only turned on by online export).
 */
let exportSyncedMount = false;
export function setExportSyncedMount(on: boolean): void {
  exportSyncedMount = !!on;
}
export function exportSyncedMountFor(cardId: string | undefined, def: unknown): boolean {
  return exportSyncedMount && !def && !!cardId && isUserCardId(cardId);
}

/**
 * Whether this document can run media effect cards: check the registry
 * (`registry.graphCardsRunnableHere`, true only for a stage that executes cards)
 */
export function graphCardsHere(): boolean {
  return graphCardsRunnableHere();
}

/**
 * Whether this user card can run on this page: check the registry (`registry.cardRunnableHere`; a synced
 * card counts only when both stages, or the one stage when there is a single stage, have reported `ready`)
 */
export function userCardRunnableHere(cardId: string): boolean {
  return cardRunnableHere(cardId);
}

/**
 * Whether this card cannot be rendered on the current platform right now. `isUserCard` defaults to the
 * registry's `isUserCardId` (the build-time custom card registration plus the user cards synced from the
 * content store); for how media effect cards are judged, see `needsLocalPc`.
 */
export function unsupportedHere(
  cardId: string | undefined,
  def: { card?: unknown; audio?: unknown; Component?: unknown } | undefined,
  isUserCard: (cardId: string) => boolean = isUserCardId,
): boolean {
  if (!onlineBrowser) return false;
  return needsLocalPc(cardId, def, isUserCard);
}

/**
 * Whether this card cannot run on this page and has to rely on a render node
 * (`docs/plan/online-card-exec-contract.md` sections 6 and 8). A synced user card has no definition on the
 * editor page (`def` is undefined) and is recognized via `isUserCard`; an id that neither side knows (an
 * unknown card) returns false.
 *
 * User cards: those that can run on this page do not count: repository user cards that are already in the
 * bundle at build time (they are the page's own code), and synced ones whose run state is `ready` (the
 * editor page looks at the state the stage reports back; the stage looks at whether it loaded the card
 * successfully itself). Transpilation failures, references to modules the page does not have, and missing
 * isolated environments still count as before.
 *
 * Media effect card = one that writes `card()` (the picture is executed by the host on the GPU), or one that
 * writes only `audio()` and has no picture component (an audio media effect card). A built-in audio motion
 * card that has a picture component and also carries `audio()` is not a media effect card: its picture is an
 * ordinary DOM card that the online page renders as usual (the sound is composed separately by the host,
 * `product/platforms.md` "Platform boundaries of card sound"). Before 2026-10-06 this code treated every card
 * that wrote `audio()` as a media effect card, so the picture of a built-in audio card was counted as
 * "cannot run on this machine" on the online page, and export kept waiting for the original-size prerender.
 */
export function needsLocalPc(
  cardId: string | undefined,
  def: { card?: unknown; audio?: unknown; Component?: unknown } | undefined,
  isUserCard: (cardId: string) => boolean = isUserCardId,
  runnable: (cardId: string) => boolean = userCardRunnableHere,
  graphRunnable: () => boolean = graphCardsHere,
): boolean {
  if (!cardId) return false;
  /*
   * Media effect cards (the picture comes from card(), or there is only audio()): they run only in a
   * document that can run media effect cards: a cross-origin stage whose picture half is allowed to execute
   * and has enough graphics capability (`registry.graphCardsRunnableHere`, written by the stage; contract
   * 4.3). On the editor page, on a same-origin single stage, and in desktop online-emulation mode they can
   * never run. In a document that can run media effect cards, then look at the card itself (the user-card
   * branch below: loaded successfully, nothing has gone wrong).
   */
  if (!!def && (typeof def.card === "function" || (typeof def.audio === "function" && !def.Component)) && !graphRunnable()) return true;
  // User cards: those that can run on this page do not count (repository user cards already in the bundle at
  // build time; synced ones that loaded successfully, `registry.cardRunnableHere`)
  if (isUserCard(cardId)) return !runnable(cardId);
  return false;
}

/*
 * Size of the placeholder on screen (`placeholderFit.ts`): the parent page shrinks the stage iframe into the
 * preview frame with CSS `scale(preview scale)`, and the placeholder component has to compensate for it.
 * The parent page sends the preview scale via `setViewScale` (both desktop and online send it), and when
 * `Stage` renders the placeholder component it computes `fit` from the clip's box, this layer's scale and
 * that preview scale.
 */
let viewScale = 1;
/** Records the parent page's preview scale; returns true if changed (`StageView` re-renders once on that) */
export function setPlaceholderViewScale(scale: unknown): boolean {
  const s = Number(scale);
  const next = Number.isFinite(s) && s > 0 ? s : 1;
  if (next === viewScale) return false;
  viewScale = next;
  return true;
}
export function placeholderViewScale(): number {
  return viewScale;
}

const fitCache = new Map<string, { key: string; fit: PlaceholderFit }>();
/**
 * How to place this card's placeholder component (wrapper-layer local pixels): the hourglass only
 * cancels out the preview scale.
 * It does not exceed the box: the badge form goes by the position box (`size`), the fill form by the
 * entity box. The same input returns the same object (the placeholder component is `React.memo`).
 */
export function placeholderFitFor(clipId: string, reason: PlaceholderReason, geometry: PlaceholderGeometry,
  size: { width: number; height: number }, layerScale: unknown): PlaceholderFit {
  const box = geometry.kind === "solid" ? { width: geometry.box.width, height: geometry.box.height } : { width: size.width, height: size.height };
  void reason; // Every reason shows the same hourglass, placed the same way (the parameters are kept: callers and unit tests still pass them as before)
  const fit = hourglassFit({ box, viewScale, layerScale });
  const key = String(fit.scale);
  const hit = fitCache.get(clipId);
  if (hit && hit.key === key) return hit.fit;
  if (fitCache.size > 512) fitCache.clear();
  fitCache.set(clipId, { key, fit });
  return fit;
}

/**
 * Clips this device cannot run in online browser mode (`unsupportedHere`; the definition is taken from
 * the registry). Returns an empty set while the mode is off.
 * Based on this, the stage mounts no component but still mounts the snapshot / stream planes, and the
 * placeholder shows the hourglass at the end of the fallback order.
 */
export function localOnlyClipIds(clips: Iterable<{ id: string; cardId?: string }>): Set<string> {
  const out = new Set<string>();
  if (!onlineBrowser) return out;
  for (const c of clips) if (c.cardId && unsupportedHere(c.cardId, getCard(c.cardId))) out.add(c.id);
  return out;
}

/* ------------------------------------------------------------------ 3. Show / hide */

/**
 * Maximum number of hourglasses spinning on screen at once (the placeholder component's
 * `maxAnimated`, registered by `Stage`)
 */
let animatedLimit = Infinity;
export function setMaxAnimated(n: number): void {
  animatedLimit = Number.isFinite(n) && n >= 0 ? n : Infinity;
}

/** The cards that were shown last time (so that the next pass can turn them off) */
let shown = new Set<string>();
/**
 * Since when each card has been shown (real wall clock; probes use it to list the gap within the
 * 120 ms delay separately)
 */
const since = new Map<string, number>();
/**
 * On the stage page, `performance.now` / `Date.now` are both taken over as stage time; use
 * `__pcRealNow` to measure real time
 */
const realNow = (): number => {
  const w = globalThis as unknown as { __pcRealNow?: () => number };
  return typeof w.__pcRealNow === "function" ? w.__pcRealNow() : Date.now();
};

/**
 * Toggles the slots' `hidden` according to `wanted`. Only these cards are touched: the ones to be shown
 * this tick + the ones that were shown last tick.
 * `slotOf` finds the slot in this card's wrapper layer (skipped if it is not mounted: the card has just
 * exited, or `Stage` has not committed yet).
 * Returns how many are shown this time (for diagnostics / probes).
 */
export function applyPlaceholders(wanted: ReadonlyMap<string, PlaceholderReason>, slotOf: (clipId: string) => HTMLElement | null): number {
  let n = 0;
  for (const id of new Set([...wanted.keys(), ...shown])) {
    const slot = slotOf(id);
    if (!slot) continue;
    const on = wanted.has(id);
    setPlaceholderShown(slot, on);
    if (on) {
      n++;
      const reason = wanted.get(id)!;
      if (slot.getAttribute("data-pc-placeholder-reason") !== reason) slot.setAttribute("data-pc-placeholder-reason", reason);
    }
    // When more than `maxAnimated` are on screen at once, the extra hourglasses stay still (the contract's
    // `PLACEHOLDER_STATIC_ATTR`, which only touches the slot attribute)
    const still = on && n > animatedLimit;
    if (slot.hasAttribute(PLACEHOLDER_STATIC_ATTR) !== still) slot.toggleAttribute(PLACEHOLDER_STATIC_ATTR, still);
  }
  const now = realNow();
  for (const id of wanted.keys()) if (!shown.has(id) || !since.has(id)) since.set(id, now);
  for (const id of [...since.keys()]) if (!wanted.has(id)) since.delete(id);
  shown = new Set(wanted.keys());
  return n;
}

/** Since when this card has been shown (real wall-clock milliseconds); undefined if not shown */
export function shownSince(clipId: string): number | undefined {
  return since.get(clipId);
}

/** Withdraw all of them (on `setRole('back')`, when turned off) */
export function hideAllPlaceholders(slotOf: (clipId: string) => HTMLElement | null): void {
  applyPlaceholders(new Map(), slotOf);
}

export function shownPlaceholders(): ReadonlySet<string> {
  return shown;
}

/* ------------------------------------------------------------------ 4. Geometry */

/** The stream manifest's entity box (wrapper-layer coordinates). `StageView` wires it to `StreamPlayer.boxOf` */
let streamBoxOf: (clipId: string) => { x: number; y: number; w: number; h: number } | null = () => null;
export function setStreamBoxSource(fn: typeof streamBoxOf): void {
  streamBoxOf = fn;
}

/**
 * Group streams that are over budget: the whole group has only one position rectangle (the union of its
 * members), and every member's placeholder is spread over it, so N members stack N identical boxes.
 * In each group, keep only the topmost of the members that show a placeholder this tick (each item of
 * `groups` is in painter's order, the last one is on top) and remove the rest from `wanted`.
 * Modifies `wanted` in place and returns it.
 */
export function keepTopOfGroups<T>(wanted: Map<string, T>, groups: readonly (readonly string[])[]): Map<string, T> {
  for (const members of groups) {
    const showing = members.filter((id) => wanted.has(id));
    for (const id of showing.slice(0, -1)) wanted.delete(id);
  }
  return wanted;
}

/**
 * Converts a rectangle in stage coordinates into the coordinates of one layer's own wrapper layer (the
 * position rectangles of over-budget group streams and below-dependent streams are in stage coordinates,
 * while the placeholder sits inside the wrapper layer).
 *
 * The conversion uses two rectangles measured on screen: `ref` is the element where the origin of the
 * stage coordinates lives (the positioned ancestor of the wrapper layer, under which the stream's stage
 * plane is also mounted), and `wrap` is the wrapper layer; `*Width` is each one's width in its own layout
 * (without transforms). Only wrapper layers that are a translation plus a uniform scale are accepted:
 * rotated, skewed or 3D ones (a `transform` that is not such a matrix) return null, and that layer is
 * positioned the old way.
 */
export function stageBoxToLocal(
  box: { x: number; y: number; w: number; h: number },
  at: { ref: { left: number; top: number; width: number }; refWidth: number; wrap: { left: number; top: number; width: number }; wrapWidth: number; transform?: string | null },
): { x: number; y: number; w: number; h: number } | null {
  const t = at.transform;
  if (t && t !== "none") {
    const m = /^matrix\(([^)]+)\)$/.exec(t.trim())?.[1].split(",").map(Number);
    if (!m || m.length !== 6 || Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6 || Math.abs(m[0] - m[3]) > 1e-6 || !(m[0] > 0)) return null;
  }
  // Stage pixels → screen pixels (preview scale); the wrapper layer's own pixels → screen pixels
  // (preview scale × this layer's scale)
  const view = at.ref.width / at.refWidth;
  const own = at.wrap.width / at.wrapWidth;
  if (!(view > 0) || !(own > 0) || !Number.isFinite(view) || !Number.isFinite(own)) return null;
  const r = (n: number) => Math.round(n * 100) / 100;
  return { x: r((at.ref.left + box.x * view - at.wrap.left) / own), y: r((at.ref.top + box.y * view - at.wrap.top) / own), w: r((box.w * view) / own), h: r((box.h * view) / own) };
}

/**
 * Over-budget layers: the position rectangle of the segment this frame falls in, from the stream manifest
 * (already converted to wrapper-layer coordinates). `StageView` wires it to `StreamPlayer.overBoxOf` /
 * `stageBoxOf`.
 * It only covers this frame and is **not recorded into `streamBoxes`**: when this layer later cannot be
 * converted to a rectangle (the wrapper layer rotated, the next segment was not measured), it is
 * positioned the old way and does not reuse the previous segment's rectangle.
 */
let overBoxOf: (clipId: string) => { x: number; y: number; w: number; h: number } | null = () => null;
export function setOverBoxSource(fn: typeof overBoxOf): void {
  overBoxOf = fn;
}

/**
 * Streams within budget: boxes the manifest has measured, kept even after the stream stops (usable
 * next time if the new one is not ready in time)
 */
const streamBoxes = new Map<string, PlaceholderBox>();
/** Ink boxes measured at the last live render (wrapper-layer coordinates) */
const inkBoxes = new Map<string, PlaceholderBox>();

/**
 * The ink box measured after a real render (`StageView` debounced sampling in the paused state). If it
 * cannot be measured (`null`: nothing was drawn, or the content fills the whole card, which
 * `measureContentBox` does not tell apart), it is not recorded: better to fall back to the badge than to
 * fill the card with noise when the measurement is unreliable.
 */
export function noteInkBox(clipId: string, box: PlaceholderBox | null): void {
  if (box && box.width > 0 && box.height > 0) inkBoxes.set(clipId, box);
}

/** Cleared when the project changes: a clipId can be reused */
export function resetPlaceholderGeometry(): void {
  streamBoxes.clear();
  inkBoxes.clear();
  geometryCache.clear();
  fitCache.clear();
}

const geometryCache = new Map<string, { key: string; geometry: PlaceholderGeometry }>();

/**
 * This card's placeholder geometry (relative to the wrapper layer, in stage pixels). `size` is the size of
 * the wrapper layer (= the position box).
 * The same input returns the same object (the placeholder component is `React.memo`, and it re-renders
 * only when the geometry object changes).
 */
export function geometryFor(clipId: string, size: { width: number; height: number }): PlaceholderGeometry {
  const fresh = streamBoxOf(clipId);
  if (fresh && fresh.w > 0 && fresh.h > 0) streamBoxes.set(clipId, { left: fresh.x, top: fresh.y, width: fresh.w, height: fresh.h });
  const stream = streamBoxes.get(clipId);
  const ink = inkBoxes.get(clipId);
  const over = overBoxOf(clipId);
  let geometry: PlaceholderGeometry;
  if (over && over.w > 0 && over.h > 0) geometry = { kind: "solid", box: { left: over.x, top: over.y, width: over.w, height: over.h } };
  else if (stream) geometry = { kind: "solid", box: stream };
  else if (ink) geometry = { kind: "solid", box: ink };
  else geometry = { kind: "badge", center: { x: size.width / 2, y: size.height / 2 } };
  const key = JSON.stringify(geometry);
  const hit = geometryCache.get(clipId);
  if (hit && hit.key === key) return hit.geometry;
  geometryCache.set(clipId, { key, geometry });
  return geometry;
}
