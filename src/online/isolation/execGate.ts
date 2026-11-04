/**
 * The **execution gate** on the stage side (contract `docs/plan/online-card-exec-contract.md`
 * section 3.1 "Prerequisites for execution").
 *
 * Before executing code for any user card or media effect card, the loader (`loader.ts` in chunk T)
 * first checks `cardExecGate().allowed`; if false, it does not execute and maps `reason` to that
 * card's runtime state `not-isolated`. Conditions for the gate to remain open; if any condition is
 * missing, it closes:
 *
 *   - This document is a cross-origin stage (`stage.html` from online build), hardening is
 *     installed, and self-check passed (`isolationCheck.ts`);
 *   - The parent page approved (`setMediaPolicy` carries `cardExec: true`: master switch is on,
 *     both stages passed self-check, and ticket handoff succeeded);
 *   - **This document has never seen an asset ticket**. For a document where the parent page
 *     provided a tier selection policy with tickets (legacy approach `?t=`), the gate is
 *     permanently closed: the other half of "no secrets if executing";
 *   - Hardening has never intercepted anything (code attempting to create subframes); if it has,
 *     the gate is permanently closed.
 *
 * The gate is one-way: once permanently closed, this document will not open it again (a stage
 * reload is a new document and starts over).
 */
import type { IsolationReport } from "./isolationCheck.ts";

export type ExecGateReason =
  | "ok"
  | "not-stage"       // Not a cross-origin stage document (editor page, same-origin single stage, export page, desktop runtime environment)
  | "checking"        // Self-check has not produced a result yet
  | "not-isolated"    // Self-check failed
  | "parent"          // Parent page did not approve (master switch is off, other stage failed, ticket handoff failed)
  | "ticket-seen"     // This document has seen an asset ticket
  | "breach";         // Hardening has intercepted code attempting to create subframes

export interface ExecGateState {
  allowed: boolean;
  reason: ExecGateReason;
  /** Self-check result (for diagnostics, descriptions in parameters panel) */
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
/** Whether the gate has ever been opened (user code may have run in documents that were opened) */
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
  for (const l of [...listeners]) { try { l(); } catch { /* Subscriber failure does not affect the gate */ } }
}

/**
 * Whether code for user cards and media effect cards can be executed right now. Object identity
 * does not change when state does not change (can be passed directly to `useSyncExternalStore`).
 */
export function cardExecGate(): ExecGateState {
  return cached;
}

/**
 * Whether this document can execute card visuals: same as the execution gate, does not require
 * browser support for egress allowlists, Trusted Types, or WebRTC interception.
 * Actual GPU, asset, and syntax capabilities of media effect cards are still judged separately
 * by the runtime.
 */
export function cardVisualExecAllowed(): boolean {
  return cached.allowed;
}

export function subscribeCardExecGate(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** This document is a cross-origin stage (called by `stageGuard.ts` when installing hardening) */
export function markIsolatedStageDocument(): void {
  inner.stage = true;
  update();
}

/** Self-check produced a result */
export function setIsolationReport(report: IsolationReport): void {
  inner.isolation = report;
  update();
}

/**
 * Tier selection policy delivered by the parent page (`setMediaPolicy`): with tickets → permanently
 * closed; `cardExec` is true → parent page approves, false or omitted → parent page does not approve.
 * Returns "whether tickets in this policy can be used": once the gate has been opened (user code
 * may have executed), subsequent tickets are rejected, and the caller discards them.
 */
export function noteMediaPolicy(policy: { ticket?: string | null; cardExec?: boolean } | null | undefined): { acceptTicket: boolean } {
  const hasTicket = typeof policy?.ticket === "string" && policy.ticket !== "";
  // Check "has it ever opened" before changing state: user code may have run in documents that were
  // opened; tickets can no longer enter
  const wasOpen = everOpened;
  if (hasTicket && !wasOpen) inner.ticketSeen = true;
  inner.parentAllows = policy?.cardExec === true && !hasTicket;
  update();
  return { acceptTicket: hasTicket && !wasOpen };
}

/** Hardening intercepted code attempting to create subframes: permanently closed */
export function noteBreach(): void {
  inner.breached = true;
  update();
}

/** For unit tests */
export function resetExecGateForTest(): void {
  inner.stage = false; inner.isolation = null; inner.parentAllows = false; inner.ticketSeen = false; inner.breached = false;
  everOpened = false;
  listeners.clear();
  cached = judge(inner);
}
