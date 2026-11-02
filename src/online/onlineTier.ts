/**
 * Tier during this online browser session (semantics in `product/platforms.md` "Online browser":
 * terms, identity, three gates, lowest tier; implementation in `mechanism/platforms.md` "Three gates").
 * Replaces the old tier set on 2026-09-27 (revoked by user decision, 2026-10-07): does not
 * pre-classify tiers by device type, but determines what this device can achieve via the stage gate,
 * asset gate, and on-demand render gate.
 *
 * Only holds **this page's session state** and values derived from it; determination logic lives elsewhere:
 * - Stage gate logic and crash logs: `stageGate.ts`, `crashLog.ts` (determines on page load which level
 *   to attempt this time, and reports the reached level during attempts);
 * - On-demand render gate baseline card too slow: measurement side of `Preview` reports
 *   `markLowest("benchmark")`;
 * - Identity: `deviceKind.ts` (re-evaluates iPad based on the level reached by stage gate).
 *
 * Four tiers (named by user decision, 2026-10-08):
 * - Top-spec mode: two stages each with a dedicated renderer (stage gate level 3);
 * - Standard mode: two stages share a renderer (level 2);
 * - Lite mode: only one stage (level 1);
 * - Low-spec mode: lowest tier (cannot run even the baseline card, or cannot sustain a single stage).
 *
 * Desktop runtime environments bypass this: when `online` is false, values always match desktop
 * behavior (dual stage, dedicated instance each, not lowest tier, PC identity).
 *
 * Does not import `mode.ts` (it reads `import.meta.env`, absent in Node unit tests); whether online
 * is passed in by callers via `initTier` on page load.
 */
import type { DeviceKind } from "./deviceKind.ts";
import { tr } from "../i18n/index.ts";

/** Three levels of stage gate: 1 one stage; 2 two stages share one canvas renderer; 3 two stages each use a dedicated renderer */
export type StageLevel = 1 | 2 | 3;
/** Four tiers */
export type TierName = "top" | "standard" | "lite" | "low";
/** WebGL render route for canvas cards (`GlRoute` in `render/costDevice.mjs`): route 1 uses dedicated instance each, route 2 shares */
export type TierGlRoute = "perDocument" | "shared";

export interface TierState {
  online: boolean;
  /** Which level the stage gate attempts this time (set on page load, unchanged during this session; 1 = open only one stage) */
  target: StageLevel;
  /** Level already reached (moves upward during attempts; unchanged once completed) */
  reached: StageLevel;
  /** Whether the stage gate has finished (tier bubble displayed only after completion) */
  gate: "trying" | "done";
  /** Lowest tier: `stage` cannot sustain even one stage (crashes before visible stage is ready), `benchmark` cannot run baseline card; null if not lowest tier */
  lowest: null | "stage" | "benchmark";
  /** Identity (iPad re-evaluated based on reached level) */
  identity: DeviceKind;
  /**
   * On-demand render gate baseline card: not tested yet (`pending`), runs fine (`ok`), too slow
   * (`slow`, enters lowest tier), skipped (`skipped`: already lowest tier or desktop).
   * Tier bubble waits for its conclusion before appearing (waits at most `BUBBLE_WAIT_MS`).
   */
  benchmark: "pending" | "ok" | "slow" | "skipped";
}

const DESKTOP: TierState = Object.freeze({ online: false, target: 3, reached: 3, gate: "done", lowest: null, identity: "desktop", benchmark: "skipped" }) as TierState;

let state: TierState = DESKTOP;
const listeners = new Set<(s: TierState) => void>();

function emit(): void {
  for (const l of [...listeners]) { try { l(state); } catch { /* One broken subscriber does not affect others */ } }
}

/** Set on page load (online pages called by `beginStageGate` in `stageGate.ts`; not called on desktop, always desktop state) */
export function initTier(next: Omit<TierState, "reached" | "gate" | "benchmark"> & Partial<Pick<TierState, "reached" | "gate" | "benchmark">>): void {
  const reached = next.reached ?? 1;
  state = {
    online: next.online, target: next.target, reached, gate: next.gate ?? (next.target === reached ? "done" : "trying"), lowest: next.lowest, identity: next.identity,
    benchmark: next.benchmark ?? (next.lowest ? "skipped" : "pending"),
  };
  start = { route: next.online && reached < 3 ? "shared" : "perDocument", lowest: next.online && next.lowest !== null };
  emit();
}

/**
 * Initial setup determined on page load (stage iframe URL is built only from it: if URL changes,
 * iframe must reload; cannot change mid-attempt or after baseline card reaches a conclusion).
 * Initial route: trials start with shared (level 2); set to dedicated instance each if settled at level 3.
 */
let start: { route: TierGlRoute; lowest: boolean } = { route: "perDocument", lowest: false };
export function tierStart(): Readonly<typeof start> {
  return start;
}

export function tierState(): Readonly<TierState> {
  return state;
}

export function subscribeTier(cb: (s: TierState) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Stage gate advanced one level upward (monotonic increase; completes once reaching `target`) */
export function markReached(level: StageLevel): void {
  if (!state.online || level <= state.reached) return;
  const reached = Math.min(level, state.target) as StageLevel;
  state = { ...state, reached, gate: reached >= state.target ? "done" : state.gate };
  emit();
}

/**
 * Stage gate stops at this level for this session, attempting no further (handshake fallback
 * retreats to single stage, or upward attempt failed).
 * Affects only this session: `target` drops to match, marking completion.
 */
export function settleAt(level: StageLevel): void {
  if (!state.online) return;
  if (state.gate === "done" && state.reached === level && state.target === level) return;
  state = { ...state, target: level, reached: level, gate: "done" };
  emit();
}

/** Enters lowest tier (one-way; unchanged during this session) */
export function markLowest(reason: "stage" | "benchmark"): void {
  if (!state.online || state.lowest) return;
  state = { ...state, lowest: reason };
  emit();
}

/** Baseline card conclusion (enters lowest tier if too slow) */
export function setBenchmark(result: "ok" | "slow" | "skipped"): void {
  if (!state.online || state.benchmark === result) return;
  state = { ...state, benchmark: result, lowest: result === "slow" && !state.lowest ? "benchmark" : state.lowest };
  emit();
}

/** Tier bubble waits at most this long for baseline card (counted after stage gate completes) */
export const BUBBLE_WAIT_MS = 15_000;
/** Duration to display tier bubble before auto-dismissing ("auto-dismiss after a few seconds", user decision) */
export const BUBBLE_SHOW_MS = 5_000;

/** Identity changed (iPad re-evaluated based on reached level) */
export function setIdentity(identity: DeviceKind): void {
  if (!state.online || state.identity === identity) return;
  state = { ...state, identity };
  emit();
}

/* ------------------------------------------------------------------ Derived from state */

/** Open only one stage (stage gate stopped at level 1; lowest tier is also one stage) */
export function singleStageTier(s: TierState = state): boolean {
  return s.online && s.target === 1;
}

/** Lowest tier: no on-demand render during playback, renders layer-by-layer after stopping; assets use small size */
export function lowestTier(s: TierState = state): boolean {
  return s.online && s.lowest !== null;
}

/** Mobile identity (not a render node, produces sparse version only, uses mobile app UI) */
export function phoneIdentity(s: TierState = state): boolean {
  return s.online && s.identity === "phone";
}

/** Which canvas render route the stage should use now: dedicated instance each upon reaching level 3, shared for others (level 1 has only one stage, its shared Worker is in the editor page) */
export function tierGlRoute(s: TierState = state): TierGlRoute {
  if (!s.online) return "perDocument";
  return s.reached >= 3 ? "perDocument" : "shared";
}

/** Which of the four tiers */
export function tierName(s: TierState = state): TierName {
  if (s.lowest) return "low";
  if (s.reached >= 3) return "top";
  if (s.reached === 2) return "standard";
  return "lite";
}

/** Tier bubble text (user decision, 2026-10-08, `product/platforms.md` "Terms" under "Online browser") */
export const TIER_BUBBLE_TEXT: Readonly<Record<TierName, string>> = Object.freeze({
  top: tr("This device is running in top-spec mode"),
  standard: tr("This device is running in standard mode"),
  lite: tr("This device is running in lite mode: complex effects are handed off to cloud rendering"),
  low: tr("This device is running in low-spec mode: playback only shows frames that are already rendered"),
});

/** Names of the four tiers (for the viewer) */
export const TIER_LABEL: Readonly<Record<TierName, string>> = Object.freeze({
  top: tr("Top mode"),
  standard: tr("Standard mode"),
  lite: tr("Lite mode"),
  low: tr("Low mode"),
});

/** For tests */
export function resetTierForTest(next: TierState | null = null): void {
  state = next ?? DESKTOP;
  start = { route: state.online && state.reached < 3 ? "shared" : "perDocument", lowest: state.online && state.lowest !== null };
  listeners.clear();
}
