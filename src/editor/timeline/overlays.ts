/**
 * Overlay cards: the things attached to a clip (filters, pixel maps, audio effects, media effect
 * cards), gathered on the timeline into one "overlay band" inside the clip.
 *
 * # Why gather them into one concept
 *
 * Today these four each take a separate field on the clip (`filter` / `pixelMap` / `audioFx` /
 * `nodeId`), and the timeline shows nothing about them: whether a clip has anything attached can
 * only be found by digging through the inspector in the left rail.
 * Here they are put into a single manifest; the band and the menu only read this manifest and do
 * not care which field each one is stored in.
 *
 * # Order is processing order
 *
 * Left to right in the band and top to bottom in the menu is the order the picture actually goes
 * through: pixel map (the one taking the media's raw output) → filter → pixel map (the one taking
 * the output after the filter) → media effect card; the sound branch (audio effects) comes last.
 * Which of the two a pixel map takes depends on `source.stage` in its definition.
 *
 * # Compute only, no drawing
 *
 * Width estimation and the degradation tiers are pure functions, run directly by unit tests
 * (`overlays.test.mjs`); drawing is in `OverlayBand.tsx`.
 */
import type { Project, TrackClip } from "../../kernel/project";
import { describeFilter } from "../../kernel/filters.mjs";
import { describeAudioFx } from "../../kernel/audioFx.mjs";
import type { RowSize } from "./utils";
import { tr } from "../../i18n/index.ts";

export type OverlayKind = "pixelMap" | "filter" | "card" | "audioFx";

export interface OverlayItem {
  kind: OverlayKind;
  /** The id of the definition in the library; for a media effect card it is the node id */
  refId: string;
  name: string;
  /** A one-line parameter summary, shown only in the menu when the band has no room for it */
  value: string;
  /**
   * Whether it consumes the host's picture / sound (downstream type) or injects state before the host
   * renders (upstream type).
   * Today all four are downstream; upstream ones like the camera do not exist yet, the field is kept
   * ahead of time, and the UI tells them apart with ▾ / ▴.
   */
  upstream: boolean;
  /**
   * Disabled on this segment: the attachment and the per-segment parameters are kept, they just have
   * no effect. Drawn in the band as a dashed outline + struck-through name.
   *
   * **This manifest still lists disabled ones**: it is "what is attached to this segment", not "what
   * is in effect on this segment right now".
   * Whether something takes effect is decided by each one's resolver (`filterOfClip` /
   * `pixelMapOfClip` / `audioFxOfClip`).
   */
  off: boolean;
  /** Whether it can be toggled disabled in the menu. A media effect card is a node in the node graph; bypassing it has to be done on the graph, which this version does not offer */
  canToggle: boolean;
  /**
   * Whether it can be removed. For the first three, clearing one field is enough; a media effect card
   * has to be taken off the chain, with downstream reconnected to its upstream
   * (`detachCardNode` in `kernel/cardAuthoring.mjs`),
   * so only those with a `source` input can be removed: transition A/B and cards with no input cannot.
   */
  canDetach: boolean;
}

export const OVERLAY_KIND_NAME: Record<OverlayKind, string> = {
  pixelMap: tr("Pixel map"),
  filter: tr("Filters"),
  card: tr("Media effect card"),
  audioFx: tr("Audio effects"),
};

/** Downstream ▾ consumes the host's output; upstream ▴ injects state before the host renders */
export function overlayGlyph(item: OverlayItem): string {
  return item.upstream ? "▴" : "▾";
}

interface Libs {
  /** Get the display name of a card (registry's knownCardName; unit tests supply a fake) */
  cardName: (cardId: string) => string | undefined;
}

/** The things attached to this clip, in processing order */
export function overlaysOfClip(project: Project, clip: TrackClip, libs: Libs): OverlayItem[] {
  const out: OverlayItem[] = [];
  if (Array.isArray(clip.preOverlays)) {
    for (const pre of clip.preOverlays) {
      if (!pre || typeof pre.cardId !== "string") continue;
      const summary = Object.entries(pre.params ?? {})
        .slice(0, 3)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(", ");
      out.push({
        kind: "card",
        refId: pre.id,
        name: (pre.cardId && libs.cardName(pre.cardId)) || pre.cardId || tr("Camera card"),
        value: summary,
        upstream: true,
        off: !!pre.off,
        canToggle: false,
        canDetach: true,
      });
    }
  }
  const pm = clip.pixelMap ? (project.pixelMaps ?? []).find((d) => d.id === clip.pixelMap!.id) : undefined;
  const pmItem: OverlayItem | null = pm
    ? { kind: "pixelMap", refId: pm.id, name: pm.name, value: pm.description || pm.where || "",
        upstream: false, off: !!clip.pixelMap?.off, canToggle: true, canDetach: true }
    : null;
  // A pixel map that takes the output after the filter goes after the filter; one that takes the media's raw output goes before it
  const pmAfterFilters = pm?.source?.stage === "after_filters";
  if (pmItem && !pmAfterFilters) out.push(pmItem);

  const f = clip.filter ? (project.filters ?? []).find((d) => d.id === clip.filter!.id) : undefined;
  if (f) out.push({ kind: "filter", refId: f.id, name: f.name, value: safeDescribe(() => describeFilter(f)),
    upstream: false, off: !!clip.filter?.off, canToggle: true, canDetach: true });

  if (pmItem && pmAfterFilters) out.push(pmItem);

  if (clip.nodeId) {
    const node = (project.cardNodes ?? []).find((n) => n.id === clip.nodeId);
    const cardId = typeof node?.cardId === "string" ? node.cardId : "";
    // No input, and it is this segment's own card: that is the clip's content (the materialized base), not something overlaid on top
    const isOwnBase = !!node && cardId === clip.cardId && !Object.keys(node.inputs ?? {}).length;
    if (node && !isOwnBase) {
      out.push({
        kind: "card",
        refId: node.id,
        name: (cardId && libs.cardName(cardId)) || cardId || tr("Media effect card"),
        value: typeof node.kind === "string" ? node.kind : "",
        upstream: false,
        // A node is wired to inputs and outputs; bypassing it is not just clearing a field
        off: false,
        canToggle: false,
        // Condition for being removable: it has a `source` input, so downstream can be reconnected to upstream
        canDetach: !!(node.inputs as Record<string, unknown> | undefined)?.source,
      });
    }
  }

  const fx = clip.audioFx ? (project.audioFx ?? []).find((d) => d.id === clip.audioFx!.id) : undefined;
  if (fx) out.push({ kind: "audioFx", refId: fx.id, name: fx.name, value: safeDescribe(() => describeAudioFx(fx)),
    upstream: false, off: !!clip.audioFx?.off, canToggle: true, canDetach: true });

  return out;
}

/** If the definition in the library has the wrong shape, better to write no summary than to blow up the whole timeline */
function safeDescribe(fn: () => string): string {
  try {
    return fn() || "";
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ Dimensions */

/** Height of the overlay band. The small row height tier draws no band (the clip's net height is only 20px; with a band the host would be left with 7px) */
export const BAND_H: Record<RowSize, number> = { small: 0, medium: 13, large: 20 };

/** Below this width: the band holds only +N, and the body does not write the duration either */
export const NARROW_PX = 72;

/** Total left and right padding of the clip body */
const BODY_PAD = 14;
/** If there is no room for even one character plus an ellipsis, do not draw the name: a lone "…" looks worse than nothing */
const MIN_NAME = 18;

/** How wide a card takes in the band (estimated from name length; a Chinese character is about 10px) */
export function chipWidth(name: string): number {
  return 24 + [...name].length * 10;
}

/** How wide the `+N` badge takes */
export function countWidth(n: number): number {
  return 17 + String(n).length * 6;
}

export interface BandPlan {
  /** The cards that fit in the band, in original order */
  shown: OverlayItem[];
  /** Number of cards folded into `+N` */
  hidden: number;
}

/**
 * How many cards fit in the band. Those that do not fit are folded into `+N`, and the height does
 * not grow with the count.
 * `keepIndex` is the currently selected card: if it gets squeezed into `+N`, swap it into the last
 * slot, because picking from the menu and then not seeing it is as good as not picking.
 */
export function planBand(items: OverlayItem[], availPx: number, keepIndex = -1): BandPlan {
  const gap = 3;
  const total = items.reduce((s, it) => s + chipWidth(it.name) + gap, 0);
  if (total <= availPx) return { shown: items.slice(), hidden: 0 };
  let budget = availPx - countWidth(items.length);
  const shown: OverlayItem[] = [];
  for (const it of items) {
    const need = chipWidth(it.name) + gap;
    if (need > budget) break;
    budget -= need;
    shown.push(it);
  }
  if (keepIndex >= 0 && keepIndex < items.length && shown.length && !shown.includes(items[keepIndex])) {
    shown[shown.length - 1] = items[keepIndex];
  }
  return { shown, hidden: items.length - shown.length };
}

export interface ClipLayoutPlan {
  /** Whether to draw the overlay band (the small row height tier draws none on the whole row) */
  band: boolean;
  /** The band holds only a `+N`, no cards */
  countOnly: boolean;
  /** Small row height tier: `+N` sits after the name, right-aligned */
  pill: boolean;
  /** Whether the body writes the duration */
  duration: boolean;
  /** Whether the body draws the name */
  name: boolean;
  /** Width in the band reserved for cards */
  bandAvail: number;
}

/**
 * The tiers a clip goes through as it gets shorter.
 *
 * Medium / large row height: `name · duration` → `name` → `na…` → no name (the band still has `+N`).
 * The small row height has no band; `+N` sits after the name, right-aligned, and any shorter leaves
 * only that badge.
 *
 * The band slot is kept on **every** clip (transparent and undrawn when nothing is attached): if it
 * were kept only for clips with attachments, names in the same row would sit at uneven heights.
 */
export function planClipLayout(widthPx: number, rowSize: RowSize, count: number): ClipLayoutPlan {
  const narrow = widthPx < NARROW_PX;
  const band = rowSize !== "small";
  const pill = !band && count > 0;
  const pillW = pill ? countWidth(count) + 5 : 0;
  return {
    band,
    countOnly: narrow,
    pill,
    duration: !narrow,
    name: widthPx - BODY_PAD - pillW >= MIN_NAME,
    // The "+" on the right appears only when not narrow (15px); the band's total left and right padding is 6px
    bandAvail: Math.max(0, widthPx - 6 - (narrow ? 0 : 15)),
  };
}
