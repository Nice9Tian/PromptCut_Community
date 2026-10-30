import type { CardCostRecord } from './cardCostKey.d.mts';

/**
 * K3(b) 的「实际要追多少」（pinned 渲染 4：`t_c = (t − t_start) × FPS × t_oc`）。
 * `frames` 是从入点到此刻的帧数；回毫秒，封顶在整段 `catchUpMs` 上，
 * 算不出来就回整段代价（再没有就是 0，调用方自己兜底）。
 */
export function catchUpEstimateMs(
  record: Partial<CardCostRecord> | null | undefined,
  frames: number,
): number;

/** 整场景补跑的代价：推到 `t` 的积压（毫秒）与此后每秒时间线的墙钟（毫秒 / 秒）。见 `.mjs` 注释 */
export function sceneCatchUpCost(
  entries: readonly { start: number; end: number; record?: Partial<CardCostRecord> | null }[],
  t: number,
  fps: number,
  activeAt?: (entry: { start: number; end: number }, t: number) => boolean,
): { backlogMs: number; ratePerSec: number };

/** 播放态互换的目标拍要领先多少毫秒；后台推帧比播放慢（追不上）回 null */
export function playingLeadMs(backlogMs: number, ratePerSec: number): number | null;
