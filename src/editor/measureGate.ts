/**
 * 测量的开工门(在线浏览器模式;C10 契约第 9 节「识别」的配套)。
 *
 * 在线页面打开后,内容库里同步来的用户卡要等卡片源码第一次同步完(`sync/onlineCardSources.ts`)才认得出来。在那之前它们
 * 被当成未知 id,测量(`probeRunner.ts` 的常驻探针、单舞台的界限搜索)可能在后台舞台上把它测一次、记一条成本记录。
 * 所以在线页面的测量等这道门:卡片源码第一次同步完成(成功,或者回了失败)就开;一直没回音时最多等
 * `MEASURE_GATE_MAX_MS`,照常开始。
 *
 * **按连接算**:门是为某一条共享项目连接开的。连接换了(换项目、重连到另一个项目、离开再进 —— 同步表会清空重取),
 * 下一次问门时门重新关上,直到新连接的卡片源码第一次同步有了结果,最多同样等 `MEASURE_GATE_MAX_MS`。
 * 连接由 `setMeasureGateLink` 给(在线页面的 `Preview` 接到 `currentSharedLink()` 上);没连着(null)时不重新关。
 *
 * **再等同步来的卡第一次载入有结果**(`docs/plan/online-card-exec-contract.md` 第 6 节):本页能执行同步来的用户卡时,卡片源码同步完之后
 * 它们还要转译、交给舞台载入;在那之前运行状态是 `loading`,还没有成本身份。门等到没有 `loading` 的卡(成功或失败都算有结果)再开,
 * 免得第一轮测量排队时漏掉它们、界面先按「没测过」摆一遍。仍受同一个 `MEASURE_GATE_MAX_MS` 封顶;门开之后才载入成功的卡
 * 由运行状态的通知另排一轮补测(`ProbeGate.tsx`)。本页不能执行时没有 `loading` 的卡,这一条不起作用。
 *
 * 桌面运行环境(不是在线页面)一开始就是开的,也不按连接关。Node 单测里 `onlinePage()` 恒为 false,同样是开的。
 */
import { onlinePage } from "../online/pageFlag";
import { anyCardLoading, onCardRunStatesChanged } from "../kernel/registry";

/** 卡片源码第一次同步最多等这么久(毫秒),过了照常开始测量 */
export const MEASURE_GATE_MAX_MS = 10_000;

export type MeasureGateReason = "desktop" | "synced" | "failed" | "timeout";

type Timer = ReturnType<typeof setTimeout>;
let state: "unset" | "held" | "open" = "unset";
let timer: Timer | null = null;
let waiters: Array<() => void> = [];
/** 此刻的共享项目连接(`setMeasureGateLink`);没给 = 不按连接关 */
let linkOf: (() => unknown) | null = null;
/** 门是为哪条连接开的 / 正在为哪条连接等 */
let openFor: unknown = null;
let heldFor: unknown = null;
let maxMs = MEASURE_GATE_MAX_MS;
/** 卡片源码已经同步完、只差同步来的卡载入出结果:记下那一次的结论,等运行状态里没有 `loading` 了再开 */
let pendingRelease: { ok: boolean; link: unknown } | null = null;
let offRunStates: (() => void) | null = null;
let cardLoading: () => boolean = anyCardLoading;
const diag = { heldAt: null as number | null, openedAt: null as number | null, reason: null as MeasureGateReason | null, holds: 0, links: 0, confirmedAt: null as number | null };
/** 单测可以换掉计时与时钟 */
let clock: { now: () => number; setTimer: (fn: () => void, ms: number) => Timer; clearTimer: (t: Timer) => void } = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t),
};

function currentLink(): unknown {
  if (!linkOf) return null;
  try { return linkOf() ?? null; } catch { return null; }
}

function open(reason: MeasureGateReason, link: unknown = currentLink() ?? heldFor): void {
  if (state === "open") return;
  state = "open";
  pendingRelease = null;
  if (timer !== null) clock.clearTimer(timer);
  timer = null;
  if (link !== null && link !== openFor) diag.links++;
  openFor = link;
  if (reason === "synced" || reason === "failed") diag.confirmedAt = clock.now();
  diag.openedAt = clock.now();
  diag.reason = reason;
  const list = waiters;
  waiters = [];
  for (const w of list) { try { w(); } catch { /* 等门的一方坏了不影响别人 */ } }
}

function hold(link: unknown, ms: number): void {
  state = "held";
  pendingRelease = null;
  heldFor = link;
  diag.holds++;
  diag.heldAt = clock.now();
  diag.openedAt = null;
  diag.reason = null;
  if (timer !== null) clock.clearTimer(timer);
  timer = clock.setTimer(() => { timer = null; open("timeout"); }, Math.max(0, ms));
}

/** 问门之前:第一次按是不是在线页面定初值;在线页面的连接换了就重新关上 */
function check(): void {
  if (state === "unset") {
    if (onlinePage()) holdMeasureForCardSources();
    else open("desktop", null);
    return;
  }
  if (state === "open" && diag.reason !== "desktop") {
    const link = currentLink();
    if (link !== null && link !== openFor) hold(link, maxMs);
  }
}

/** 此刻的共享项目连接从哪取(在线页面的 `Preview` 接上;换了连接就按新连接重新关门) */
export function setMeasureGateLink(fn: (() => unknown) | null): void {
  linkOf = fn;
}

/**
 * 关门等卡片源码(在线页面的 `Preview` 在开始同步卡片源码时叫;门已经开过就什么都不做 —— 连接换了的重新关门由问门时判)。
 * 从这一刻起最多等 `ms`,过了自己开。
 */
export function holdMeasureForCardSources(ms: number = MEASURE_GATE_MAX_MS): void {
  if (state !== "unset") return;
  maxMs = ms;
  hold(currentLink(), ms);
}

/**
 * 卡片源码第一次同步有了结果:`ok` 为 true 是同步完了,false 是回了失败。两种都开门。
 * `link` 是这次同步用的连接:不是此刻的连接(同步回来时又换了)就不算;门已经开着时,记下它是为这条连接开的。
 */
export function releaseMeasureGate(ok: boolean, link?: unknown): void {
  if (link !== undefined && linkOf && link !== currentLink()) return;
  if (state === "open") {
    // 门开着时新连接的卡片源码先同步完了(还没人问门):记下为它开的,之后不再为它关
    if (link !== undefined && diag.reason !== "desktop") {
      if (link !== null && link !== openFor) diag.links++;
      openFor = link;
      diag.confirmedAt = clock.now();
    }
    return;
  }
  if (state === "unset") state = "held";
  const target = link !== undefined ? link : currentLink() ?? heldFor;
  if (cardLoading()) {
    // 同步来的卡还在转译或载入:先不开,等它们有了结果(`settleCardLoading`);计时照走,到点照开
    pendingRelease = { ok, link: target };
    offRunStates ??= onCardRunStatesChanged(settleCardLoading);
    return;
  }
  open(ok ? "synced" : "failed", target);
}

/** 运行状态变了:卡片源码已同步完、又没有还在载入的卡了,就开门 */
function settleCardLoading(): void {
  if (!pendingRelease || state === "open" || cardLoading()) return;
  const { ok, link } = pendingRelease;
  pendingRelease = null;
  open(ok ? "synced" : "failed", link);
}

/** 门开了没有(第一次问时按是不是在线页面定初值;在线页面换了连接就重新关上) */
export function measureGateOpen(): boolean {
  check();
  return state === "open";
}

/** 等到门开(已经开着就马上回) */
export function whenMeasureGateOpen(): Promise<void> {
  check();
  if (state === "open") return Promise.resolve();
  return new Promise((resolve) => { waiters.push(resolve); });
}

/**
 * 诊断、探针用。`holds`:关过几次门(换了连接、问门时新连接还没同步完,重新关一次加一);`links`:门为几条连接开过
 * (开门、或门开着时新连接先同步完,都算);`confirmedAt`:最近一次卡片源码同步有结果的时刻。
 */
export function measureGateDiag() {
  return { state, heldAt: diag.heldAt, openedAt: diag.openedAt, reason: diag.reason, holds: diag.holds, links: diag.links, confirmedAt: diag.confirmedAt,
    waitedMs: diag.openedAt !== null && diag.heldAt !== null ? diag.openedAt - diag.heldAt : null };
}

/** 单测用:回到刚载入的样子,可换掉计时与时钟 */
export function resetMeasureGate(next?: Partial<typeof clock> & { cardLoading?: () => boolean }): void {
  if (timer !== null) clock.clearTimer(timer);
  timer = null;
  state = "unset";
  pendingRelease = null;
  offRunStates?.();
  offRunStates = null;
  cardLoading = next?.cardLoading ?? anyCardLoading;
  waiters = [];
  linkOf = null;
  openFor = null;
  heldFor = null;
  maxMs = MEASURE_GATE_MAX_MS;
  diag.heldAt = null;
  diag.openedAt = null;
  diag.reason = null;
  diag.holds = 0;
  diag.links = 0;
  diag.confirmedAt = null;
  clock = {
    now: next?.now ?? (() => Date.now()),
    setTimer: next?.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: next?.clearTimer ?? ((t) => clearTimeout(t)),
  };
}
