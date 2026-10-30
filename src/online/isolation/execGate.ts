/**
 * 舞台这一侧的**执行闸门**(契约 `docs/plan/online-card-exec-contract.md` 第 3.1 节「执行的前提」)。
 *
 * 加载器(块 T 的 `loader.ts`)执行任何用户卡、素材效果卡的代码之前先问 `cardExecGate().allowed`;为假就不执行,
 * 把 `reason` 映射成那张卡的运行状态 `not-isolated`。闸门开着的条件,缺一条就关:
 *
 *   - 本文档是跨源舞台(在线构建的 `stage.html`),加固装上了、自检通过(`isolationCheck.ts`);
 *   - 父页点了头(`setMediaPolicy` 带 `cardExec: true`:总开关开着、两个舞台都自检通过、票据交接成功);
 *   - **本文档从没见过素材票据**。父页给过带票据的取档策略(旧办法 `?t=`)的文档,闸门永久关上 —— 「要执行就不放秘密」的另一半;
 *   - 没出过加固拦下的事(有代码试图造子框架),出过就永久关上。
 *
 * 闸门是单向的:永久关上之后本文档不再打开(舞台重载是新的文档,重新来过)。
 */
import type { IsolationReport } from "./isolationCheck.ts";

export type ExecGateReason =
  | "ok"
  | "not-stage"       // 不是跨源舞台的文档(编辑器页、同源单舞台、导出页、桌面运行环境)
  | "checking"        // 自检还没出结果
  | "not-isolated"    // 自检没过
  | "parent"          // 父页没点头(总开关关着、另一台舞台没过、票据交接没成)
  | "ticket-seen"     // 本文档见过素材票据
  | "breach";         // 加固拦下过试图造子框架的代码

export interface ExecGateState {
  allowed: boolean;
  reason: ExecGateReason;
  /** 自检结果(诊断、给参数面板的说明用) */
  isolation: IsolationReport | null;
}

interface Inner {
  stage: boolean;
  isolation: IsolationReport | null;
  parentAllows: boolean;
  ticketSeen: boolean;
  breached: boolean;
}

const inner: Inner = { stage: false, isolation: null, parentAllows: false, ticketSeen: false, breached: false };
const listeners = new Set<() => void>();
/** 闸门开过没有(开过的文档里可能跑过用户代码) */
let everOpened = false;
let cached: ExecGateState = judge(inner);

function judge(s: Inner): ExecGateState {
  const reason: ExecGateReason =
    !s.stage ? "not-stage"
    : s.breached ? "breach"
    : s.ticketSeen ? "ticket-seen"
    : !s.isolation ? "checking"
    : !s.isolation.ok ? "not-isolated"
    : !s.parentAllows ? "parent"
    : "ok";
  return { allowed: reason === "ok", reason, isolation: s.isolation };
}

function update(): void {
  const next = judge(inner);
  if (next.allowed === cached.allowed && next.reason === cached.reason && next.isolation === cached.isolation) return;
  cached = next;
  if (next.allowed) everOpened = true;
  for (const l of [...listeners]) { try { l(); } catch { /* 订阅方坏了不影响闸门 */ } }
}

/** 此刻能不能执行用户卡、素材效果卡的代码。对象身份在状态没变时不变(可直接给 `useSyncExternalStore`) */
export function cardExecGate(): ExecGateState {
  return cached;
}

/**
 * 本文档能不能执行卡片画面：与执行闸门相同，不要求浏览器支持出口白名单、Trusted Types 或 WebRTC 拦截。
 * 素材效果卡的实际GPU/素材/语法能力仍由运行时另判。
 */
export function cardVisualExecAllowed(): boolean {
  return cached.allowed;
}

export function subscribeCardExecGate(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 本文档是跨源舞台(`stageGuard.ts` 在装加固时调) */
export function markIsolatedStageDocument(): void {
  inner.stage = true;
  update();
}

/** 自检出结果了 */
export function setIsolationReport(report: IsolationReport): void {
  inner.isolation = report;
  update();
}

/**
 * 父页下发的取档策略(`setMediaPolicy`):带票据 → 永久关上;`cardExec` 为真 → 父页点头,为假或没带 → 父页不点头。
 * 回「这份策略里的票据能不能用」:闸门开过(执行过用户代码的可能)之后再来的票据一律不收,调用方把它丢掉。
 */
export function noteMediaPolicy(policy: { ticket?: string | null; cardExec?: boolean } | null | undefined): { acceptTicket: boolean } {
  const hasTicket = typeof policy?.ticket === "string" && policy.ticket !== "";
  // 先看「开过没有」再改状态:开过的文档里可能跑过用户代码,票据不能再进来
  const wasOpen = everOpened;
  if (hasTicket && !wasOpen) inner.ticketSeen = true;
  inner.parentAllows = policy?.cardExec === true && !hasTicket;
  update();
  return { acceptTicket: hasTicket && !wasOpen };
}

/** 加固拦下了试图造子框架的代码:永久关上 */
export function noteBreach(): void {
  inner.breached = true;
  update();
}

/** 单测用 */
export function resetExecGateForTest(): void {
  inner.stage = false; inner.isolation = null; inner.parentAllows = false; inner.ticketSeen = false; inner.breached = false;
  everOpened = false;
  listeners.clear();
  cached = judge(inner);
}
