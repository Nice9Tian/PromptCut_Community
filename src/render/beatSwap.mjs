/**
 * "Per-tick snapshot swap" budget during online dual-stage playback (C10 contract
 * `docs/plan/c10-contract.md` section 6, section 18 item 1; semantics `product/rendering.md`
 * "Fallback order", `product/platforms.md` "Online browser mode").
 *
 * The online page has no prerender process, hence no track stream: heavy layers swap HTML snapshots
 * once per tick. The cost of swapping a snapshot counts toward the per-tick budget; heavy layers
 * that cannot fit display placeholders for this tick (step 4 of fallback order).
 *
 *   deadMs = max(0, B - occupiedMs)          B = budgetOf(fps) = 1000 / fps × 0.7
 *                                            (same budget as dispatch in `pipelinePlan.mjs`)
 *   Accumulating each layer's own frame swap cost layer by layer from top to bottom; starting from
 *   (and including) the layer where the accumulation exceeds deadMs, placeholders are displayed
 *
 * The frame swap cost of each layer is provided by the caller (`costOf`; swap-tuning measurements,
 * `scripts/probes/swap-cost-probe.mjs`): estimated by size (`swapCostOfSize`) when this layer's snapshot
 * size is known, or by card kind (`SWAP_MS_BY_KIND`) when unknown; for layers where the card kind is
 * unrecognized or the caller does not provide per-layer costs, falls back to default `SWAP_MS`
 * (fallback). Legacy calls providing only `swapMs` use the same cost for every layer, yielding the
 * same result as the original `floor(deadMs / swapMs)`.
 *
 * "Occupied" is the sum of weights of cards live rendered in the light pipeline for this tick
 * (`lightCostAt` in `planDispatch.ts`, using the same standard as `w` in `clipWeight`). Heavy layers
 * are taken in the order provided by the caller (ordered by caller from top to bottom: topmost
 * layers swapped first); no layers after the one that cannot fit are swapped, even if cheaper:
 * placeholders only appear on lower layers, avoiding "placeholder on upper layer, swap on lower
 * layer as usual". Output is stable for the same input.
 *
 * Pure function: same version for browser and Node.
 */
import { budgetOf } from './pipelinePlan.mjs';

/** Default cost of swapping a snapshot once (milliseconds): fallback when card kind is unrecognized or caller does not provide per-layer costs (C10 contract section 6) */
export const SWAP_MS = 3;

/**
 * Frame swap cost by card kind (milliseconds; swap-tuning measurements, additional duration the
 * visible stage main thread spends per tick for each extra layer swapped, see
 * `swap-cost-probe.mjs`; takes the measured median across card kinds rounded up to 0.5: DOM 25
 * cards 1.7, Lottie 5 cards 6.3, canvas 7 cards 3.7). Used only when the snapshot size of this
 * layer is not yet known (dispatch, first delivery of this layer); Lottie long-tail cases (27-31 ms
 * for large frames) are caught by size-based estimation.
 *   - `dom`: ordinary DOM cards (including cards with frosted glass `backdrop-filter`,
 *     `filter: blur`, and user cards declared as DOM);
 *   - `lottie`: Lottie cards (many SVG nodes, large snapshots);
 *   - `canvas`: canvas cards (canvas rasterized into inline bitmaps in snapshots: particles, 3D,
 *     cards sharing a WebGL renderer).
 * Numbers are tier-3 mechanisms (`docs/semantics/mechanism/rendering.md` "Fallback order").
 */
export const SWAP_MS_BY_KIND = Object.freeze({ dom: 2, lottie: 6.5, canvas: 4 });

/**
 * Estimation method when snapshot size of this layer is known (swap-tuning empirical fit, see
 * `swap-cost-probe.mjs`): frame swap costs are roughly proportional to snapshot character count;
 * DOM and Lottie SVG both belong to "text", with similar cost per KB; canvas card snapshots are
 * almost entirely inline bitmaps (one long attribute value), much cheaper per KB.
 *
 *   cost = baseMs + (bitmap ? bitmapMsPerKB : textMsPerKB) × characters / 1024
 *
 * Snapshot sizes within the same card kind can differ by tenfold (measured DOM cards 12-144 KB,
 * Lottie 65-733 KB); size-based estimation is more accurate than card-kind estimation (median error
 * across 37 cards relative to measurement: 11% by size, 32% by card kind, 64% for flat 3 ms);
 * falls back to card kind when this layer has not been delivered yet (size unknown). Numbers are
 * tier-3 mechanisms (`mechanism/rendering.md` "Fallback order").
 */
export const SWAP_COST_MODEL = Object.freeze({ baseMs: 0.8, textMsPerKB: 0.04, bitmapMsPerKB: 0.009 });

/**
 * Estimates frame swap cost of this layer by snapshot size; returns `null` if size is not positive
 * (caller falls back to card kind).
 * @param {{ bytes?: number, bitmap?: boolean } | null | undefined} size `bytes`: character count of
 *   snapshot HTML; `bitmap`: contains inline bitmap (`data:image/`)
 * @param {{ baseMs: number, textMsPerKB: number, bitmapMsPerKB: number }} [model]
 * @returns {number | null}
 */
export function swapCostOfSize(size, model = SWAP_COST_MODEL) {
  const bytes = Number(size?.bytes);
  if (!(bytes > 0)) return null;
  const perKB = size.bitmap ? model.bitmapMsPerKB : model.textMsPerKB;
  const v = model.baseMs + perKB * bytes / 1024;
  return v > 0 ? v : null;
}

/**
 * Which card kind a layer belongs to. Returns `null` if unrecognized (falls back to `SWAP_MS`).
 *
 * @param {{ cardId?: string | null, known?: boolean, source?: string, canvas?: boolean, canvasHeavy?: boolean } | null | undefined} desc
 *   `known`: whether the definition of this card exists on this page (no = user card whose code is
 *   not here, content cannot be recognized);
 *   `canvas`: definition declares canvas contract (except `dom2d`); `canvasHeavy`: review table or
 *   definition marks canvas as heavy.
 * @returns {'dom' | 'lottie' | 'canvas' | null}
 */
export function swapKindOf(desc) {
  const id = typeof desc?.cardId === 'string' ? desc.cardId : '';
  if (!id) return null;
  if (id === 'lottie' || id.startsWith('lottie-')) return 'lottie';
  if (id === 'particles' || id.startsWith('particles-')) return 'canvas';
  if (desc.known === false) return null;
  if (desc.canvas === true || desc.canvasHeavy === true) return 'canvas';
  return 'dom';
}

/**
 * Frame swap cost for this card kind; returns `fallback` if unrecognized (`null`) or missing from table.
 * @param {string | null | undefined} kind
 * @param {Readonly<Record<string, number>>} [table]
 * @param {number} [fallback]
 */
export function swapCostOf(kind, table = SWAP_MS_BY_KIND, fallback = SWAP_MS) {
  const v = kind ? Number(table?.[kind]) : NaN;
  return v > 0 ? v : fallback;
}

/**
 * @param {{ fps: number, occupiedMs?: number, layers: readonly string[], swapMs?: number, costOf?: (id: string) => number | null | undefined }} input
 *   `swapMs`: same cost for every layer (legacy call; defaults to `SWAP_MS`, also fallback when
 *   `costOf` returns no value);
 *   `costOf`: each layer's own cost (milliseconds); uses `swapMs` if returned value is not positive.
 * @returns {{ swap: string[], placeholder: string[], deadMs: number, fit: number, usedMs: number }}
 */
export function fitBeatSwaps({ fps, occupiedMs = 0, layers, swapMs = SWAP_MS, costOf }) {
  const rate = Math.max(1, Number(fps) || 30);
  const occupied = Math.max(0, Number(occupiedMs) || 0);
  const uniform = Number(swapMs) > 0 ? Number(swapMs) : SWAP_MS;
  const deadMs = Math.max(0, budgetOf(rate) - occupied);
  const list = [];
  const seen = new Set();
  for (const id of layers ?? []) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(key);
  }
  const costAt = (id) => {
    if (typeof costOf !== 'function') return uniform;
    let v;
    try { v = Number(costOf(id)); } catch { v = NaN; }
    return v > 0 ? v : uniform;
  };
  let fit = 0;
  let usedMs = 0;
  for (const id of list) {
    const next = usedMs + costAt(id);
    // Floating point: cases that fit exactly like 17.5 = 5 × 3.5 should not fit one fewer layer due to 17.500000000000004
    if (next > deadMs + 1e-9) break;
    usedMs = next;
    fit++;
  }
  return { swap: list.slice(0, fit), placeholder: list.slice(fit), deadMs, fit, usedMs };
}
