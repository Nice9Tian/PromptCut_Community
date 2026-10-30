/**
 * 在线浏览器这一次使用期间的档位（语义 `product/platforms.md`「在线浏览器」：名词、身份、三道闸门、最低一档；
 * 做法 `mechanism/platforms.md`「三道闸门」）。取代 2026-09-27 定的旧档位（2026-10-07 用户定撤销）：不按设备种类预先分档，
 * 由舞台闸门、素材闸门、即时渲染闸门判出这台设备能做到哪一步。
 *
 * 这里只放**本页会话的状态**与由它推出来的几样东西，判法在别处：
 * - 舞台闸门的判法与崩溃记录：`stageGate.ts`、`crashLog.ts`（页面载入时定下这次要试到哪一级，试的过程中报到达的级别）；
 * - 即时渲染闸门的基准卡跑不动：`Preview` 的测量一侧报 `markLowest("benchmark")`；
 * - 身份：`deviceKind.ts`（iPad 按舞台闸门到达的级别改判）。
 *
 * 四档（2026-10-08 用户定名）：
 * - 顶配模式：两个舞台各一套渲染器（舞台闸门第三级）；
 * - 标准模式：两个舞台共用渲染器（第二级）；
 * - 精简模式：只有一个舞台（第一级）；
 * - 低配模式：最低一档（基准卡都跑不动，或一个舞台都撑不住）。
 *
 * 桌面运行环境不经这里：`online` 为假时各项恒为桌面的样子（双舞台、各一套、不是最低一档、身份电脑）。
 *
 * 不引 `mode.ts`（它读 `import.meta.env`，Node 单测里没有）；在线与否由调用方在页面载入时 `initTier` 传进来。
 */
import type { DeviceKind } from "./deviceKind.ts";

/** 舞台闸门的三级：1 一个舞台；2 两个舞台共用一套 canvas 渲染器；3 两个舞台各用一套 */
export type StageLevel = 1 | 2 | 3;
/** 四档 */
export type TierName = "top" | "standard" | "lite" | "low";
/** canvas 卡的 WebGL 渲染路线（`render/costDevice.mjs` 的 `GlRoute`）：路线 1 各一套、路线 2 共用 */
export type TierGlRoute = "perDocument" | "shared";

export interface TierState {
  online: boolean;
  /** 舞台闸门这次要试到哪一级（页面载入时定，这次使用期间不变；1 = 只开一个舞台） */
  target: StageLevel;
  /** 已经到达的级别（试的过程中往上走；试完不再变） */
  reached: StageLevel;
  /** 舞台闸门走完没有（走完才显示档位气泡） */
  gate: "trying" | "done";
  /** 最低一档：`stage` 一个舞台都撑不住（崩在可见舞台就绪之前）、`benchmark` 基准卡都跑不动；不是最低一档为 null */
  lowest: null | "stage" | "benchmark";
  /** 身份（iPad 已按到达的级别改判） */
  identity: DeviceKind;
  /**
   * 即时渲染闸门的基准卡:还没测(`pending`)、跑得动(`ok`)、跑不动(`slow`,进最低一档)、不测(`skipped`:已经是最低一档、桌面)。
   * 档位气泡等它有了结论才出(最多等 `BUBBLE_WAIT_MS`)。
   */
  benchmark: "pending" | "ok" | "slow" | "skipped";
}

const DESKTOP: TierState = Object.freeze({ online: false, target: 3, reached: 3, gate: "done", lowest: null, identity: "desktop", benchmark: "skipped" }) as TierState;

let state: TierState = DESKTOP;
const listeners = new Set<(s: TierState) => void>();

function emit(): void {
  for (const l of [...listeners]) { try { l(state); } catch { /* 一个订阅方坏了不影响别人 */ } }
}

/** 页面载入时定下（在线页面由 `stageGate.ts` 的 `beginStageGate` 调；桌面不调，恒为桌面的样子） */
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
 * 页面载入时定下的起手样子(舞台 iframe 的地址只按它拼:地址变了 iframe 就得重新载入,试的途中、基准卡出结论之后都不能变)。
 * 起手的路线:要试的从共用起(第二级);定下停在第三级的各一套。
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

/** 舞台闸门往上走到了一级（只升不降；到了 `target` 即走完） */
export function markReached(level: StageLevel): void {
  if (!state.online || level <= state.reached) return;
  const reached = Math.min(level, state.target) as StageLevel;
  state = { ...state, reached, gate: reached >= state.target ? "done" : state.gate };
  emit();
}

/**
 * 舞台闸门这次停在这一级、不再往上试（握手容错退回单舞台、或往上试的那一步没成）。
 * 只管当次：`target` 跟着落下来，走完。
 */
export function settleAt(level: StageLevel): void {
  if (!state.online) return;
  if (state.gate === "done" && state.reached === level && state.target === level) return;
  state = { ...state, target: level, reached: level, gate: "done" };
  emit();
}

/** 进最低一档（只进不出；这次使用期间不变） */
export function markLowest(reason: "stage" | "benchmark"): void {
  if (!state.online || state.lowest) return;
  state = { ...state, lowest: reason };
  emit();
}

/** 基准卡的结论(跑不动的同时进最低一档) */
export function setBenchmark(result: "ok" | "slow" | "skipped"): void {
  if (!state.online || state.benchmark === result) return;
  state = { ...state, benchmark: result, lowest: result === "slow" && !state.lowest ? "benchmark" : state.lowest };
  emit();
}

/** 档位气泡最多等基准卡这么久(舞台闸门走完之后算) */
export const BUBBLE_WAIT_MS = 15_000;
/** 档位气泡显示多久后自动消失(「几秒后自动消失」,用户定) */
export const BUBBLE_SHOW_MS = 5_000;

/** 身份改了（iPad 按到达的级别改判） */
export function setIdentity(identity: DeviceKind): void {
  if (!state.online || state.identity === identity) return;
  state = { ...state, identity };
  emit();
}

/* ------------------------------------------------------------------ 由状态推出来的 */

/** 只开一个舞台（舞台闸门停在第一级；最低一档也是一个舞台） */
export function singleStageTier(s: TierState = state): boolean {
  return s.online && s.target === 1;
}

/** 最低一档：播放时不做任何即时渲染，停下后逐层渲；素材用小尺寸 */
export function lowestTier(s: TierState = state): boolean {
  return s.online && s.lowest !== null;
}

/** 身份为手机（不当渲染节点、只产稀疏版、用手机版界面） */
export function phoneIdentity(s: TierState = state): boolean {
  return s.online && s.identity === "phone";
}

/** 此刻舞台该用哪条 canvas 渲染路线：到达第三级各一套，其余共用（第一级只有一个舞台，共用的那一个 Worker 在编辑器页里） */
export function tierGlRoute(s: TierState = state): TierGlRoute {
  if (!s.online) return "perDocument";
  return s.reached >= 3 ? "perDocument" : "shared";
}

/** 四档里的哪一档 */
export function tierName(s: TierState = state): TierName {
  if (s.lowest) return "low";
  if (s.reached >= 3) return "top";
  if (s.reached === 2) return "standard";
  return "lite";
}

/** 档位气泡的文字（2026-10-08 用户定，`product/platforms.md`「在线浏览器」的「名词」） */
export const TIER_BUBBLE_TEXT: Readonly<Record<TierName, string>> = Object.freeze({
  top: "这台设备运行在顶配模式",
  standard: "这台设备运行在标准模式",
  lite: "这台设备运行在精简模式：复杂的效果交给云端渲染",
  low: "这台设备运行在低配模式：播放时只显示已渲染好的画面",
});

/** 四档的名字（查看口用） */
export const TIER_LABEL: Readonly<Record<TierName, string>> = Object.freeze({
  top: "顶配模式",
  standard: "标准模式",
  lite: "精简模式",
  low: "低配模式",
});

/** 测试用 */
export function resetTierForTest(next: TierState | null = null): void {
  state = next ?? DESKTOP;
  start = { route: state.online && state.reached < 3 ? "shared" : "perDocument", lowest: state.online && state.lowest !== null };
  listeners.clear();
}
