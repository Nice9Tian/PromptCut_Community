import type { CardCostRecord } from './cardCostKey.d.mts';

/**
 * K3(b) "actual catch-up amount" (pinned render 4: `t_c = (t − t_start) × FPS × t_oc`).
 * `frames` is the number of frames from the in point to this moment; returns milliseconds,
 * capped at the full-clip `catchUpMs`. If calculation fails, returns the full-clip cost
 * (or 0 if that is also absent; caller handles fallback).
 */
export function catchUpEstimateMs(
  record: Partial<CardCostRecord> | null | undefined,
  frames: number,
): number;

/** Whole-scene catch-up run cost: backlog pushed to `t` (ms) and wall clock per second
 * of timeline thereafter (ms / s). See `.mjs` comments */
export function sceneCatchUpCost(
  entries: readonly { start: number; end: number; record?: Partial<CardCostRecord> | null }[],
  t: number,
  fps: number,
  activeAt?: (entry: { start: number; end: number }, t: number) => boolean,
): { backlogMs: number; ratePerSec: number };

/** How many milliseconds ahead the target tick for playback-state swap should be;
 * returns null if background frame pushing is slower than playback (cannot catch up) */
export function playingLeadMs(backlogMs: number, ratePerSec: number): number | null;
