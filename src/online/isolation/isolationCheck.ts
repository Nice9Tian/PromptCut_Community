/**
 * Stage startup self-check: verifies document boundary (base-uri) with real cross-origin and
 * response-header CSP.
 * Does not judge execution capability by external fetch, redirects, or WebRTC/Trusted Types
 * egress interception.
 * Still fails if same-origin, meta-only, or policy missing; parent page approval and ticketless
 * gate are checked separately.
 */
import { STAGE_CSP_HEADER_ONLY_DIRECTIVE } from "../stagePolicy.mjs";
import type { HardenReport } from "./harden.ts";
import { SCOPE_GUARD_CRITICAL } from "./scopeGuard.ts";

/*
 * Self-check timeout uses a **real-time** timer: stage replaces `setTimeout` with one that follows
 * stage time (`render/stageClock.ts`, does not run when not playing).
 * If self-check used it, cases where only `<meta>` took effect would wait indefinitely for a result.
 * Capture the original at module load time (before stage clock is installed);
 * once stage clock is installed, its exposed escape hatch `__pcRealSetTimeout` takes precedence.
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

/** Checks policy with base-uri document boundary, not proving isolation by blocked external fetch. */
export const ISOLATION_CHECK_BASE_PATH = "/__pc-policy-probe__/";
/**
 * Two URLs on stage origin for self-check (relative to online build base): first returns 204,
 * second redirects to first
 */
export const ISOLATION_OK_PATH = "_iso/ok";
export const ISOLATION_REDIRECT_PATH = "_iso/redirect";
/** How long to wait for each item */
export const ISOLATION_CHECK_TIMEOUT_MS = 2500;

export type IsolationFailure =
  | "same-origin"        // Stage and parent page are same-origin
  | "no-policy"          // Content Security Policy did not take effect
  | "meta-only"          // Only <meta> fallback took effect; response header did not arrive
  | "not-hardened"       // Hardening was not installed
  | "check-error";       // Self-check itself errored

export interface IsolationReport {
  ok: boolean;
  crossOrigin: boolean;
  /** Where the policy comes from */
  csp: "header" | "meta" | "none";
  /**
   * Keep legacy report enum readable; current policy is always `none`, and does not use egress
   * guards as an execution condition.
   */
  egress: "allowlist" | "script" | "none";
  hardened: boolean;
  trustedTypes: HardenReport["trustedTypes"];
  reasons: IsolationFailure[];
}

export interface IsolationCheckDeps {
  win?: Window & typeof globalThis;
  /** Online build base (`/editor/`) */
  base: string;
  harden: HardenReport | null;
  timeoutMs?: number;
}

/**
 * Storage in stage documents that can survive this document: if these are not contained,
 * hardening is considered not installed (recorded as `storage:<name>:…` in step 6b of `harden.ts`).
 */
const CRITICAL_STORAGE = ["localStorage", "sessionStorage", "indexedDB", "caches"] as const;

/**
 * Critical item errors in the hardening report: storage (step 6b `storage:`) and cross-document
 * channel guards (step 6c `scope:`, including `integrity` where guard verification fails).
 * If even one is present, it is a "fail-open" (cards obtain real storage or native threads), and
 * self-check determines "hardening not installed" (review P3, 2026-10-23). Pure function.
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

/** Draw conclusions from facts. Pure function, unit tests verify item by item */
export function judgeIsolation(f: { crossOrigin: boolean; csp: IsolationReport["csp"]; allowlist?: boolean; harden: HardenReport | null }): IsolationReport {
  const reasons: IsolationFailure[] = [];
  // Installed, and critical items are all installed (when only checking "whether installed",
  // even if an item cannot be locked it still reports pass, and cards get real storage)
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
    if (w.parent === w) return false; // Not in an iframe
    void w.parent.location.href;
    return false;
  } catch {
    return true;
  }
}

/** Whether policy is enforced and where it originates */
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
      // Response headers and <meta> each report once in arbitrary order: wait briefly to see if
      // the response header one arrives
      settle ??= realTimeout(finish, 150);
    };
    const deadline = realTimeout(finish, timeoutMs);
    w.document.addEventListener("securitypolicyviolation", onViolation);
    const probe = w.document.createElement("base");
    probe.href = `${w.location.origin}${ISOLATION_CHECK_BASE_PATH}`;
    // Remove immediately so as not to change subsequent relative URLs in documents without a policy.
    // Violation events are still delivered asynchronously by the browser.
    w.document.head.appendChild(probe);
    probe.remove();
  });
}

/** Run a self-check. Does not throw: returns `ok: false` with reason `check-error` on error */
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
