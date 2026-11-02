import type { ComponentType } from "react";
import type { ClipFrame, Control } from "./types";

/**
 * Parts library contract.
 *
 * A part is the **smallest independently renderable unit**: a title, a bulleted list, a circular
 * progress ring, a Lottie segment. Cards used to be monolithic JSX, with parts only serving as a
 * "specification" externally (CardDef.parts); now parts can truly be placed individually, enter
 * individually, and have parameters modified individually: clip.parts in composite cards
 * (cardId "composite") is a part instance tree, which the stage renders and positions level by
 * level (render/PartTree.tsx). The Agent adds, removes, and edits this tree via add_part /
 * set_part / remove_part, still operating on the envelope (kernel/envelope.ts) without ever
 * touching component source code.
 *
 * Division of responsibilities between parts and cards: cards are "a composite pattern" (a full
 * preset set of parts + layout + timing), while parts are individual components. Existing cards
 * continue to work as-is and are not forced into part compositions; new compositions are built
 * from parts.
 */

export interface PartProps<P> {
  params: P;
  /** Seconds since this part entered (enterMs already deducted); passed by the stage every frame */
  t: number;
  /** Incremented by 1 on each replay, used as a key to remount just like cards */
  playToken: number;
  /**
   * Size of this part's box in parent coordinates (pixels). Parts lay out against it; do not assume
   * 1920×1080.
   * Convention: parts with text include a `size` parameter, **0 = auto-fit to box** (computed via
   * fitOr in parts/fit.ts), positive number = fixed pixels. Default is 0, so the Agent only needs to
   * position the box without guessing font sizes; fill in a number when precise control is needed.
   */
  width: number;
  height: number;
}

export interface PartDef<P = Record<string, unknown>> {
  /**
   * Globally unique, kebab-case, prefixed by category: text-title, list-pins, metric-ring,
   * media-lottie.
   */
  id: string;
  name: string;
  /** One sentence describing appearance and entrance animation */
  description: string;
  /** Selection guide for the Agent: what content should use it, and distinction from similar parts */
  useWhen?: string;
  tags?: string[];
  role: "text" | "media" | "list" | "decor" | "group";
  /** Which card it was extracted from (card id), or omitted if newly written */
  from?: string;
  defaults: P;
  controls: Control[];
  /**
   * Default box (relative to parent coordinates; composite card's parent coordinates is its canvas,
   * default 1920×1080).
   * Omitted = fills parent box. Used when Agent calls add_part without frame, so provide a position
   * that "looks decent right away".
   */
  defaultFrame?: ClipFrame;
  /**
   * Duration until entrance animation settles (ms), calculated from current params; defaults to 0
   * (shown immediately on mount).
   */
  settleMs?: (params: P) => number;
  /** After settling: hold (freeze) / loop (repeat) / evolve (constantly changing) */
  after?: "hold" | "loop" | "evolve";
  Component: ComponentType<PartProps<P>>;
}
