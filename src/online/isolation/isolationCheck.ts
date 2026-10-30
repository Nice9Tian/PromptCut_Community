/** 舞台启动自检：验证真实跨源和响应头CSP的文档边界(base-uri)。
 * 不用外部fetch、重定向或WebRTC/Trusted Types出口拦截判断是否能执行。
 * 同源、只有meta或没有策略仍不通过；父页点头及无票据闸门另核。
 */
import { STAGE_CSP_HEADER_ONLY_DIRECTIVE } from "../stagePolicy.mjs";
import type { HardenReport } from "./harden.ts";
import { SCOPE_GUARD_CRITICAL } from "./scopeGuard.ts";

/*
 * 自检的时限用**真实时间**的定时器:舞台把 `setTimeout` 换成跟着舞台时间走的那一份(`render/stageClock.ts`,不播放时不走),
 * 自检要是用了它,只有 `<meta>` 生效那种情况会永远等不到结论。模块载入时(舞台时钟装上之前)先把原装的取下来;
 * 舞台时钟装上之后它自己留的口子 `__pcRealSetTimeout` 优先。
 */
const nativeSetTimeout: typeof setTimeout | null = typeof setTimeout === "function" ? setTimeout.bind(globalThis) : null;
const nativeClearTimeout: typeof clearTimeout | null = typeof clearTimeout === "function" ? clearTimeout.bind(globalThis) : null;
function realTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const hatch = (globalThis as { __pcRealSetTimeout?: typeof setTimeout }).__pcRealSetTimeout;
  return (hatch ?? nativeSetTimeout ?? setTimeout)(fn, ms);
}
function realClear(t: ReturnType<typeof setTimeout> | null | undefined): void {
  if (t !== null && t !== undefined) (nativeClearTimeout ?? clearTimeout)(t);
}

/** 用base-uri文档边界检查策略，不以外部fetch被拦证明隔离。 */
export const ISOLATION_CHECK_BASE_PATH = "/__pc-policy-probe__/";
/** 舞台源上给自检用的两个地址(相对在线构建的 base):前者回 204,后者重定向到前者 */
export const ISOLATION_OK_PATH = "_iso/ok";
export const ISOLATION_REDIRECT_PATH = "_iso/redirect";
/** 每一项等多久 */
export const ISOLATION_CHECK_TIMEOUT_MS = 2500;

export type IsolationFailure =
  | "same-origin"        // 舞台与父页同源
  | "no-policy"          // 内容安全策略没生效
  | "meta-only"          // 只有 <meta> 兜底生效,响应头没到
  | "not-hardened"       // 加固没装上
  | "check-error";       // 自检自己出错

export interface IsolationReport {
  ok: boolean;
  crossOrigin: boolean;
  /** 策略出自哪里 */
  csp: "header" | "meta" | "none";
  /** 旧报告枚举保持可读；当前策略恒为 `none`，不以出口护栏作为执行条件 */
  egress: "allowlist" | "script" | "none";
  hardened: boolean;
  trustedTypes: HardenReport["trustedTypes"];
  reasons: IsolationFailure[];
}

export interface IsolationCheckDeps {
  win?: Window & typeof globalThis;
  /** 在线构建的 base(`/editor/`) */
  base: string;
  harden: HardenReport | null;
  timeoutMs?: number;
}

/** 舞台文档里能活过本文档的存储:这几样没收住,加固就算没装上(`harden.ts` 6b 步记的 `storage:<名字>:…`) */
const CRITICAL_STORAGE = ["localStorage", "sessionStorage", "indexedDB", "caches"] as const;

/**
 * 加固报告里的关键项错误:存储(6b 步 `storage:`)与跨文档通道守卫(6c 步 `scope:`,含守卫核对不过的 `integrity`)。
 * 有一条,就是「开着门失败」(卡片拿到真实存储或原生线程),自检判「加固没装上」(2026-10-23 审查 P3)。纯函数
 */
export function criticalHardenErrors(errors: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  if (!Array.isArray(errors)) return out;
  for (const e of errors) {
    const s = String(e);
    if (CRITICAL_STORAGE.some((k) => s.startsWith(`storage:${k}:`)) || SCOPE_GUARD_CRITICAL.some((k) => s.startsWith(`scope:${k}:`))) out.push(s);
  }
  return out;
}

/** 由各项事实下结论。纯函数,单测逐条核 */
export function judgeIsolation(f: { crossOrigin: boolean; csp: IsolationReport["csp"]; allowlist?: boolean; harden: HardenReport | null }): IsolationReport {
  const reasons: IsolationFailure[] = [];
  // 装了,而且关键项都装上了(只看「装了没有」时,某项锁不上照样报通过,卡片拿到的是真实存储)
  const hardened = !!f.harden?.installed && criticalHardenErrors(f.harden.errors).length === 0;
  const trustedTypes = f.harden?.trustedTypes ?? "unsupported";
  const egress: IsolationReport["egress"] = "none";
  if (!f.crossOrigin) reasons.push("same-origin");
  if (f.csp === "none") reasons.push("no-policy");
  else if (f.csp === "meta") reasons.push("meta-only");
  if (!hardened) reasons.push("not-hardened");
  return { ok: reasons.length === 0, crossOrigin: f.crossOrigin, csp: f.csp, egress, hardened, trustedTypes, reasons };
}

function isCrossOrigin(w: Window): boolean {
  try {
    if (w.parent === w) return false; // 不在 iframe 里
    void w.parent.location.href;
    return false;
  } catch {
    return true;
  }
}

/** 策略在不在强制、出自哪里 */
function checkPolicy(w: Window & typeof globalThis, timeoutMs: number): Promise<IsolationReport["csp"]> {
  return new Promise((resolve) => {
    let best: IsolationReport["csp"] = "none";
    let settle: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      w.document.removeEventListener("securitypolicyviolation", onViolation);
      realClear(deadline);
      realClear(settle);
      resolve(best);
    };
    const onViolation = (e: SecurityPolicyViolationEvent) => {
      if (e.disposition !== "enforce" || e.effectiveDirective !== "base-uri" || !String(e.blockedURI).includes(ISOLATION_CHECK_BASE_PATH)) return;
      if (String(e.originalPolicy).includes(STAGE_CSP_HEADER_ONLY_DIRECTIVE)) { best = "header"; finish(); return; }
      if (best === "none") best = "meta";
      // 响应头与 <meta> 两份各报一次,先后不定:再等一小会儿看响应头那一份来不来
      settle ??= realTimeout(finish, 150);
    };
    const deadline = realTimeout(finish, timeoutMs);
    w.document.addEventListener("securitypolicyviolation", onViolation);
    const probe = w.document.createElement("base");
    probe.href = `${w.location.origin}${ISOLATION_CHECK_BASE_PATH}`;
    // 立即移除，不在没有策略的文档中改变后续相对URL。违规事件仍由浏览器异步送达。
    w.document.head.appendChild(probe);
    probe.remove();
  });
}

/** 跑一遍自检。不抛:出错回 `ok: false`、原因 `check-error` */
export async function runIsolationCheck(deps: IsolationCheckDeps): Promise<IsolationReport> {
  const w = deps.win ?? window;
  const timeoutMs = deps.timeoutMs ?? ISOLATION_CHECK_TIMEOUT_MS;
  try {
    const crossOrigin = isCrossOrigin(w);
    const csp = await checkPolicy(w, timeoutMs);
    return judgeIsolation({ crossOrigin, csp, harden: deps.harden });
  } catch {
    return { ok: false, crossOrigin: false, csp: "none", egress: "none", hardened: false, trustedTypes: deps.harden?.trustedTypes ?? "unsupported", reasons: ["check-error"] };
  }
}
