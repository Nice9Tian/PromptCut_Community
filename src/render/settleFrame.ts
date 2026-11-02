/**
 * Single-stage "catch up current frame on stop" (semantics `product/rendering.md` "Precise on stop",
 * `product/platforms.md` "Online browser" "Stop" and "Lowest tier"; mechanism
 * `mechanism/rendering.md` "Bounds search and cost record" "Catch up one frame on stop"): when there
 * is only one stage (stage gate level 1, lowest tier, fallback to single stage on handshake failure),
 * there is no background stage to catch up to precision before swapping; upon pause, click or scrub
 * release, or playback reaching the end, all cards for this current frame are live rendered once in
 * the visible stage, including heavy cards.
 *
 * - Before being drawn, layers display in fallback order (stream paste if track stream exists,
 *   placeholder if none), replacing layer by layer as each is drawn;
 * - **No time limit** (user decision, 2026-10-07, lowest tier "after stop... replace layer by layer
 *   once rendered, no time limit"): draws continuously until all are drawn, or until interrupted by a
 *   new seek / playback / project switch. `timeoutMs` is reserved for testing and diagnostics (clamped
 *   only when a positive number is provided);
 * - Frame-push cards are calculated by catching up from in point to current frame;
 * - User cards and media effect cards that cannot run on this page do not catch up
 *   (`localOnlyClipIds`): if prerender output exists for this frame, paste as is; if none, show
 *   hourglass and wait for render nodes (user decision, 2026-10-21: no "Local PC assisted rendering"
 *   prompt);
 * - Next playback returns to playback appearance (lowest tier only pastes prerender output).
 *
 * Contains only the pure parts here (ordering, driving, result shapes); stage-side drawing logic
 * lives in `settleLayers` of `StageView`. Does not import editor; loaded directly by Node unit tests.
 */

/** Upper bound when a time limit is provided (value passed from parent page is clamped here; omitted = no time limit) */
export const SETTLE_MAX_MS = 60_000;
/** Upper limit for parent page to wait for response when no time limit is set (reloading an alive window in place loses responses and cannot hang forever; stage continues drawing regardless) */
export const SETTLE_RPC_CAP_MS = 10 * 60_000;

/** How a card catches up: direct seek (drawn in a single commit), step frame-by-frame from in point, or cannot render on this device (do not catch up) */
export type SettleKind = "direct" | "catchup" | "unsupported";

export interface SettleItem {
  clipId: string;
  kind: SettleKind;
  /** How many frames a frame-push card must step from in point (0 for direct seek) */
  frames: number;
}

/** Result of catching up one frame on stop (response from stage RPC `settleLayers`, recorded into diagnostics by parent page) */
export interface SettleResult {
  /** false: interrupted by a new seek / playback / project switch, or stage cannot perform it (`reason`) */
  ok: boolean;
  reason?: "superseded" | "role" | "no-project" | "rpc";
  sec: number;
  /** Time limit for this run; null = no time limit */
  timeoutMs: number | null;
  /** Wall-clock time from start of catch-up to completion */
  ms: number;
  /** Drawn layers and elapsed time from start when drawn */
  drawn: { clipId: string; ms: number }[];
  /** Layers not yet drawn when time limit expired that maintain fallback; unrendered layers when interrupted are also recorded here */
  timedOut: string[];
  /** Layers that do not catch up (user cards and media effect cards that cannot run on this page: prerender output pasted, or hourglass if none) */
  skipped: string[];
}

/** Time limit given by parent page: non-positive (including omitted) means no time limit (null); clamped to upper bound if exceeded */
export function clampSettleTimeout(ms: unknown): number | null {
  if (ms === null || ms === undefined) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(SETTLE_MAX_MS, Math.floor(n));
}

/**
 * How this card catches up. `unsupported` (user cards and media effect cards that cannot run on
 * this page) does not catch up; `direct` frame mode or playhead right at in point is drawn in a
 * single commit; the rest steps frame-by-frame from in point to current frame.
 */
export function settleKindOf(o: { unsupported: boolean; frameMode: string | undefined; mountFrame: number; targetFrame: number }): SettleItem["kind"] {
  if (o.unsupported) return "unsupported";
  if (o.frameMode === "direct" || o.targetFrame <= o.mountFrame) return "direct";
  return "catchup";
}

/**
 * Catch-up order: direct seek first (drawn in a single commit); frame-push cards ordered by number
 * of frames to step from least to most: get as many layers drawn early as possible and replaced as
 * soon as possible. Ties ordered by clipId. `unsupported` cards do not enter the queue and are
 * listed separately.
 */
export function orderSettle(items: readonly SettleItem[]): { queue: SettleItem[]; skipped: string[] } {
  const queue = items.filter((it) => it.kind !== "unsupported");
  const skipped = items.filter((it) => it.kind === "unsupported").map((it) => it.clipId).sort();
  const rank = (it: SettleItem) => (it.kind === "direct" ? 0 : 1);
  queue.sort((a, b) => rank(a) - rank(b) || a.frames - b.frames || (a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : 0));
  return { queue, skipped };
}

/** Result of drawing a layer: drawn, timed out, interrupted */
export type DrawOutcome = "drawn" | "timeout" | "aborted";

/**
 * Draws layer by layer in `orderSettle` sequence. When no time limit is set, `deadline` is `Infinity`,
 * drawing until all are drawn or interrupted; when a time limit is given (`draw` also checks `deadline`
 * itself, returning `timeout` if time limit is reached mid-step), layers that haven't started drawing
 * when time limit expires are also recorded into `timedOut`. When interrupted (`aborted()` or `draw`
 * returns `aborted`), returns `ok: false`, and unrendered layers are likewise recorded into `timedOut`
 * (they remain covered on the stage side anyway).
 */
export async function runSettle(o: {
  sec: number;
  items: readonly SettleItem[];
  /** Omitted / null = no time limit */
  timeoutMs?: number | null;
  now: () => number;
  draw: (item: SettleItem, deadline: number) => Promise<DrawOutcome>;
  aborted?: () => boolean;
}): Promise<SettleResult> {
  const started = o.now();
  const timeoutMs = clampSettleTimeout(o.timeoutMs);
  const deadline = timeoutMs === null ? Infinity : started + timeoutMs;
  const { queue, skipped } = orderSettle(o.items);
  const drawn: SettleResult["drawn"] = [];
  const timedOut: string[] = [];
  const finish = (ok: boolean, rest: SettleItem[] = []): SettleResult => {
    for (const it of rest) timedOut.push(it.clipId);
    return { ok, ...(ok ? {} : { reason: "superseded" as const }), sec: o.sec, timeoutMs, ms: o.now() - started, drawn, timedOut, skipped };
  };
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (o.aborted?.()) return finish(false, queue.slice(i));
    if (o.now() >= deadline) return finish(true, queue.slice(i));
    const outcome = await o.draw(item, deadline);
    if (outcome === "drawn") drawn.push({ clipId: item.clipId, ms: o.now() - started });
    else if (outcome === "timeout") timedOut.push(item.clipId);
    else return finish(false, queue.slice(i));
  }
  return finish(true);
}
