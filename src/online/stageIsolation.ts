/**
 * Editor-side **stage isolation session** (contract `docs/plan/online-card-exec-contract.md`
 * Sections 3.1, 3.2, 4.1).
 *
 * Manages three things:
 *   1. Receives self-check results (`pc-stage-isolation`) from the two cross-origin stages,
 *      validating by shape;
 *   2. Which path each stage takes to fetch assets: self-check passed and ticket handoff
 *      succeeded -> **cookie** (stage uses `/media-s/<sid>/media/<hash>`, ticket never enters
 *      stage scripts); otherwise -> **legacy approach** (ticket dispatched via RPC, appended to
 *      `?t=` in URL; such stage documents do not execute user cards);
 *   3. Whether this page can execute user cards and media effect cards at this moment
 *      (`onlineCardExec()`): master switch is on, is dual stage, both stages use cookies, and no
 *      hardening breach has occurred.
 *
 * Two one-way rules ("no secrets if executing"):
 *   - Once approval has been given in this page session (`cardExec: true` was sent to a stage),
 *     thereafter **no stage will ever receive tickets again**: if any stage subsequently fails
 *     self-check or handoff fails, it receives a ticketless cookie base URL (if it cannot fetch
 *     assets, so be it) without falling back to the legacy approach;
 *   - If an incident intercepted by hardening (`breach`) has occurred, this page session no
 *     longer approves execution.
 *
 * Master switch (host can disable): setting `"onlineCardExec": false` in runtime config
 * `editor/runtime-config.json` falls back entirely to the original approach (no execution, tickets
 * routed through `?t=` as before); enabled by default. If runtime config cannot be read, there is
 * no stage origin, which defaults to same-origin single stage with no execution.
 *
 * This module belongs to the render layer (`src/online/`): does not import editor; handoff
 * requests and clocks are injectable (for unit tests).
 */
import { isSid, mediaGrantUrl, mediaSBase } from "./stagePolicy.mjs";
import type { StageLetter } from "./stageOrigins.ts";
import type { IsolationFailure, IsolationReport } from "./isolation/isolationCheck.ts";
import type { BreachKind } from "./isolation/harden.ts";

/**
 * Cross-origin stage iframe `sandbox` (contract Section 3.3): only enables scripts and retains its
 * own origin; disallows popups, top-level navigation, forms, modals, downloads.
 */
export const STAGE_SANDBOX = "allow-scripts allow-same-origin";
/**
 * How long to wait for this stage's self-check results after handshake; if exceeded, treated as
 * not isolated (this stage uses the legacy approach).
 */
export const ISOLATION_REPORT_WAIT_MS = 4000;
/** Timeout for handoff requests */
export const MEDIA_GRANT_TIMEOUT_MS = 8000;

export type StageMediaMode = "cookie" | "legacy";

/**
 * Reason why this page does not execute user cards or media effect cards (for parameters panel
 * explanation and diagnostics; `ok` = executable).
 */
export type CardExecReason =
  | "ok"
  | "switch-off"     // Host disabled the master switch
  | "no-stage"       // No cross-origin stage mounted yet (unable to read stage origin, page unloading)
  | "pending"        // Still waiting for stage self-check or ticket handoff
  | "not-isolated"   // A stage failed self-check
  | "grant-failed"   // Ticket handoff failed
  | "breach";        // Hardening has intercepted code attempting to create subframes

export interface CardExecState {
  enabled: boolean;
  reason: CardExecReason;
  /** Reasons why stages failed self-check (diagnostics) */
  detail: Partial<Record<StageLetter, IsolationFailure[]>>;
  /** Compatibility diagnostic field: `none` when current policy executes, null when it does not */
  egress: "none" | null;
}

const FAILURES: readonly IsolationFailure[] = ["same-origin", "no-policy", "meta-only", "not-hardened", "check-error"];
const BREACHES: readonly BreachKind[] = ["html", "create", "insert", "observed", "define"];

/**
 * Validates self-check results sent by stage by shape (all stage messages treated as untrusted
 * input); returns null if invalid.
 */
export function sanitizeIsolationReport(d: unknown): IsolationReport | null {
  if (!d || typeof d !== "object") return null;
  const r = d as Record<string, unknown>;
  const csp = r.csp === "header" || r.csp === "meta" || r.csp === "none" ? r.csp : null;
  const egress = r.egress === "allowlist" || r.egress === "script" || r.egress === "none" ? r.egress : null;
  const tt = r.trustedTypes === "enforced" || r.trustedTypes === "created" || r.trustedTypes === "unsupported" || r.trustedTypes === "failed" ? r.trustedTypes : null;
  if (!csp || !egress || !tt || typeof r.ok !== "boolean" || typeof r.crossOrigin !== "boolean" || typeof r.hardened !== "boolean" || !Array.isArray(r.reasons)) return null;
  const reasons = r.reasons.filter((x): x is IsolationFailure => FAILURES.includes(x as IsolationFailure)).slice(0, FAILURES.length);
  // Do not trust stage's own conclusions: recompute from individual facts (fails if any is missing)
  const ok = r.ok === true && reasons.length === 0 && r.crossOrigin === true && csp === "header" && r.hardened === true;
  return { ok, crossOrigin: r.crossOrigin, csp, egress, hardened: r.hardened, trustedTypes: tt, reasons };
}

export function sanitizeBreach(d: unknown): BreachKind | null {
  return BREACHES.includes(d as BreachKind) ? (d as BreachKind) : null;
}

/**
 * Generates a 32-digit hexadecimal stage asset path id (isolated by account plus project, kept
 * secret from stages of other projects, scoping cookie and cache to a single path segment).
 */
export function newSid(random: (bytes: Uint8Array) => void = (b) => { crypto.getRandomValues(b); }): string {
  const bytes = new Uint8Array(16);
  random(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** The isolation-related portion of the tier selection policy handed to the stage */
export interface StageMediaPlan {
  mode: StageMediaMode;
  /**
   * Base URL for stage asset fetching: cookie uses `/media-s/<sid>`; legacy approach uses caller's
   * original base URL (null here, caller fills it in).
   */
  base: string | null;
  /** Only legacy approach carries tickets; always null for cookie */
  ticket: string | null;
  /**
   * Whether this stage can execute user cards (stage itself must also verify self-check and
   * "never seen tickets").
   */
  cardExec: boolean;
  /**
   * Stage document has already received another project's path id; caller must reload this stage
   * completely and not send policy.
   */
  reload?: boolean;
}

export const STAGE_SID_STORAGE_PREFIX = "pc.stageSid.v1:";

const STAGE_SID_RE = /^[0-9a-f]{32}$/;

export interface StageSidScope {
  accountId: string | null;
  /**
   * Which project's assets the stage is reading (path id follows it; editor page provides it based
   * on the project connected to assets).
   */
  projectId: string | null;
  /**
   * Which project's card code the stage is executing right now (editor page provides it based on
   * currently open project). When both are provided but differ from `projectId` (the interval where
   * the page switches projects in place while asset connections have not yet switched over), this
   * page does not approve execution: new project cards must not enter a stage document holding the
   * previous project's path id.
   */
  codeProjectId?: string | null;
}

export interface StageSidStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StageSidStore {
  sidFor(scope: StageSidScope): string;
}

function scopeKeyOf(scope: StageSidScope): { persistent: boolean; key: string } {
  const accountId = typeof scope?.accountId === "string" && scope.accountId.length > 0 ? scope.accountId : null;
  const projectId = typeof scope?.projectId === "string" && scope.projectId.length > 0 ? scope.projectId : null;
  if (accountId !== null && projectId !== null) {
    return {
      persistent: true,
      key: `${STAGE_SID_STORAGE_PREFIX}${encodeURIComponent(accountId)}:${encodeURIComponent(projectId)}`,
    };
  }
  const aTag = scope?.accountId === null || scope?.accountId === undefined ? "n" : `s:${encodeURIComponent(String(scope.accountId))}`;
  const pTag = scope?.projectId === null || scope?.projectId === undefined ? "n" : `s:${encodeURIComponent(String(scope.projectId))}`;
  return {
    persistent: false,
    key: `mem:${aTag}:${pTag}`,
  };
}

/**
 * Allocates and reuses stage asset path id by "account + project" (`mechanism/platforms.md`
 * "Path id fixed by account plus project"): persists in the editor page's own `localStorage` under
 * `pc.stageSid.v1:<accountId>:<projectId>` when both identifiers are non-empty; falls back to
 * this page session's memory if either identifier is missing or storage is unavailable; different
 * scopes never share the same path id.
 */
export function createStageSidStore(opts: {
  storage?: StageSidStorage | null | (() => StageSidStorage | null);
  random?: (bytes: Uint8Array) => void;
} = {}): StageSidStore {
  const random = opts.random;
  const byKey = new Map<string, string>();
  const usedSids = new Set<string>();
  const freshSid = (): string => {
    for (let i = 0; i < 16; i++) {
      const s = newSid(random);
      if (!usedSids.has(s)) {
        usedSids.add(s);
        return s;
      }
    }
    const fallback = newSid(random);
    usedSids.add(fallback);
    return fallback;
  };
  const getStorage = (): StageSidStorage | null => {
    try {
      if ("storage" in opts) {
        return typeof opts.storage === "function" ? opts.storage() : (opts.storage ?? null);
      }
      return typeof globalThis !== "undefined" ? (globalThis.localStorage ?? null) : null;
    } catch {
      return null;
    }
  };
  return {
    sidFor(scope: StageSidScope): string {
      const { persistent, key } = scopeKeyOf(scope);
      const cached = byKey.get(key);
      if (cached !== undefined) return cached;
      if (!persistent) {
        const sid = freshSid();
        byKey.set(key, sid);
        return sid;
      }
      let sid: string | null = null;
      const st = getStorage();
      if (st) {
        try {
          const raw = st.getItem(key);
          if (typeof raw === "string" && STAGE_SID_RE.test(raw) && !usedSids.has(raw)) {
            sid = raw;
            usedSids.add(sid);
          }
        } catch {
          sid = null;
        }
      }
      if (sid === null) {
        sid = freshSid();
        if (st) {
          try {
            st.setItem(key, sid);
          } catch {
            // If write fails, still retain the path id in this page session's memory
          }
        }
      }
      byKey.set(key, sid);
      return sid;
    },
  };
}

export interface StageIsolationDeps {
  /** Master switch (runtime config) */
  enabled(): boolean;
  /**
   * Hands off ticket to stage origin; returns true on success. Defaults to `fetch` (cross-origin
   * POST with credentials).
   */
  grant?(stageOrigin: string, sid: string, ticket: string): Promise<boolean>;
  sid?: string;
  sidStore?: StageSidStore;
  storage?: StageSidStorage | null | (() => StageSidStorage | null);
  reportWaitMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

interface Slot {
  /** Self-check results for this stage (current document); cleared on handshake */
  report: IsolationReport | null;
  /** Awaiters waiting for results after handshake */
  waiters: Array<(r: IsolationReport | null) => void>;
  mode: StageMediaMode | null;
  /**
   * Path id already received by this stage's current document; cleared on handshake (new document),
   * a stage document only ever receives one path id in its lifetime.
   */
  docSid: string | null;
  /**
   * Ticket, path id, and stage origin used during last successful handoff (same set is not handed
   * off repeatedly).
   */
  granted: { ticket: string; sid: string; origin: string } | null;
  /**
   * In-flight handoff (only one request is sent for the same ticket, path id, and stage origin; tier
   * selection policy is calculated several times in rapid succession).
   */
  granting: { key: string; done: Promise<boolean> } | null;
  /** Handshake generation: discarded if late results do not match the generation */
  gen: number;
}

export interface StageIsolationSession {
  readonly sid: string;
  /**
   * Switches current account and project scope; recalculates state and notifies subscribers when
   * path id changes.
   */
  setScope(scope: StageSidScope): void;
  /** This stage shook hands (new document): clear old self-check results and tier selection method */
  handshake(id: StageLetter): void;
  /** This stage sent self-check results */
  report(id: StageLetter, report: IsolationReport | null): void;
  /** This stage (or any stage) reported an incident intercepted by hardening */
  breach(kind: BreachKind): void;
  /**
   * Computes tier selection method for this stage right now (waits for self-check results, sends
   * handoff requests). If `active` is false (this stage is not in current layout), returns legacy
   * approach directly.
   * If `ticket` is null (not yet connected to asset service), skips handoff and returns legacy
   * approach's empty ticket.
   */
  plan(id: StageLetter, ctx: { active: boolean; stageOrigin: string | null; ticket: string | null }): Promise<StageMediaPlan>;
  /**
   * Which stages are currently mounted (dual stage `["A", "B"]`; only one stage `["A"]`: stage gate
   * tier 1, lowest tier, fallback on handshake failure; none mounted `[]`): recomputes whether
   * execution is allowed. All stages are cross-origin isolated without exception (user decision,
   * 2026-10-14); a single stage can likewise execute user cards and media effect cards, depending
   * solely on mounted stages.
   */
  setStages(ids: readonly StageLetter[]): void;
  state(): CardExecState;
  subscribe(cb: () => void): () => void;
}

/**
 * Default handoff: cross-origin POST with credentials, ticket placed in `Authorization` header;
 * only 204 counts as success.
 */
export async function grantMediaCookie(stageOrigin: string, sid: string, ticket: string, fetchImpl: typeof fetch = fetch, timeoutMs = MEDIA_GRANT_TIMEOUT_MS): Promise<boolean> {
  if (!isSid(sid)) return false;
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
  try {
    const res = await fetchImpl(mediaGrantUrl(stageOrigin, sid), {
      method: "POST", credentials: "include", cache: "no-store", headers: { Authorization: `Bearer ${ticket}` }, signal: ctrl?.signal,
    });
    return res.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createStageIsolation(deps: StageIsolationDeps): StageIsolationSession {
  const sidStore = deps.sidStore ?? createStageSidStore("storage" in deps ? { storage: deps.storage } : {});
  let currentSid = deps.sid ?? newSid();
  let currentScopeKey: string | null = null;
  /** Asset project does not match card code project (see `StageSidScope.codeProjectId`) */
  let scopeMismatch = false;
  const grant = deps.grant ?? ((origin, s, ticket) => grantMediaCookie(origin, s, ticket));
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const waitMs = deps.reportWaitMs ?? ISOLATION_REPORT_WAIT_MS;
  const slots: Record<StageLetter, Slot> = {
    A: { report: null, waiters: [], mode: null, docSid: null, granted: null, granting: null, gen: 0 },
    B: { report: null, waiters: [], mode: null, docSid: null, granted: null, granting: null, gen: 0 },
  };
  let IDS: StageLetter[] = [];
  let breached = false;
  /** Whether approval was given (after approval, no stage receives tickets anymore) */
  let everAllowed = false;
  let grantFailed = false;
  const listeners = new Set<() => void>();
  let cached: CardExecState = { enabled: false, reason: "no-stage", detail: {}, egress: null };

  const judge = (): CardExecState => {
    const detail: CardExecState["detail"] = {};
    for (const id of IDS) { const r = slots[id].report; if (r && !r.ok) detail[id] = r.reasons; }
    const off = (reason: CardExecReason): CardExecState => ({ enabled: false, reason, detail, egress: null });
    if (!deps.enabled()) return off("switch-off");
    if (!IDS.length) return off("no-stage");
    if (breached) return off("breach");
    if (IDS.some((id) => slots[id].report && !slots[id].report!.ok)) return off("not-isolated");
    if (IDS.some((id) => slots[id].mode === "legacy")) return off(grantFailed ? "grant-failed" : "not-isolated");
    if (scopeMismatch || IDS.some((id) => (slots[id].docSid !== null && slots[id].docSid !== currentSid) || slots[id].mode !== "cookie" || !slots[id].report || slots[id].granted?.sid !== currentSid)) return off("pending");
    const egress = "none" as const;
    return { enabled: true, reason: "ok", detail, egress };
  };
  const update = () => {
    const next = judge();
    if (next.enabled) everAllowed = true;
    if (next.enabled === cached.enabled && next.reason === cached.reason && next.egress === cached.egress && JSON.stringify(next.detail) === JSON.stringify(cached.detail)) return;
    cached = next;
    for (const l of [...listeners]) { try { l(); } catch { /* The subscriber is broken */ } }
  };

  const waitReport = (id: StageLetter): Promise<IsolationReport | null> => {
    const slot = slots[id];
    if (slot.report) return Promise.resolve(slot.report);
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: IsolationReport | null) => { if (done) return; done = true; clearTimer(timer); resolve(r); };
      const timer = setTimer(() => {
        const i = slot.waiters.indexOf(finish);
        if (i >= 0) slot.waiters.splice(i, 1);
        finish(null);
      }, waitMs);
      slot.waiters.push(finish);
    });
  };

  return {
    get sid() {
      return currentSid;
    },
    setScope(scope) {
      const code = typeof scope?.codeProjectId === "string" && scope.codeProjectId.length > 0 ? scope.codeProjectId : null;
      const media = typeof scope?.projectId === "string" && scope.projectId.length > 0 ? scope.projectId : null;
      const mismatch = code !== null && media !== null && code !== media;
      const { key } = scopeKeyOf(scope);
      if (key === currentScopeKey && mismatch === scopeMismatch) return;
      scopeMismatch = mismatch;
      if (key !== currentScopeKey) {
        currentScopeKey = key;
        currentSid = sidStore.sidFor(scope);
      }
      update();
    },
    handshake(id) {
      const slot = slots[id];
      slot.gen++;
      slot.report = null;
      slot.mode = null;
      slot.docSid = null;
      slot.granted = null;
      slot.granting = null;
      for (const w of slot.waiters.splice(0)) w(null);
      update();
    },
    report(id, report) {
      const slot = slots[id];
      slot.report = report ?? { ok: false, crossOrigin: false, csp: "none", egress: "none", hardened: false, trustedTypes: "unsupported", reasons: ["check-error"] };
      for (const w of slot.waiters.splice(0)) w(slot.report);
      update();
    },
    breach() {
      breached = true;
      update();
    },
    setStages(ids) {
      const next = (["A", "B"] as StageLetter[]).filter((id) => ids.includes(id));
      if (next.length === IDS.length && next.every((id, i) => IDS[i] === id)) return;
      IDS = next;
      update();
    },
    async plan(id, ctx) {
      const slot = slots[id];
      if (!ctx.stageOrigin) {
        throw new Error(`[stageIsolation] Cross-origin isolated stage is not configured or unavailable, same-origin fallback forbidden: stage ${id}`);
      }
      const reloadPlan = (): StageMediaPlan => {
        update();
        return { mode: "cookie", base: null, ticket: null, cardExec: false, reload: true };
      };
      const needReload = (): boolean => slot.docSid !== null && slot.docSid !== currentSid;
      const withSidBase = (cardExec: boolean): StageMediaPlan => {
        if (needReload()) return reloadPlan();
        slot.docSid = currentSid;
        return { mode: "cookie", base: mediaSBase(currentSid), ticket: null, cardExec };
      };
      const safeFallback = (): StageMediaPlan => {
        if (needReload()) return reloadPlan();
        slot.mode = "legacy";
        update();
        return withSidBase(false);
      };
      if (needReload()) return reloadPlan();
      if (!ctx.active || !deps.enabled()) return safeFallback();
      const gen = slot.gen;
      const report = await waitReport(id);
      if (gen !== slot.gen) return safeFallback(); // This stage shook hands again while waiting: this attempt is invalidated, a new handshake will follow
      if (needReload()) return reloadPlan();
      // Did not receive results (legacy stage page does not send it, or stage is stuck): record as
      // self-check error
      if (!report) slot.report = { ok: false, crossOrigin: false, csp: "none", egress: "none", hardened: false, trustedTypes: "unsupported", reasons: ["check-error"] };
      if (!report?.ok) return safeFallback();
      if (!ctx.ticket) {
        // No ticket yet (asset service not connected): do not hand off, do not fall back to legacy
        // approach: this stage is already classified as isolated, wait for ticket before retrying
        return withSidBase(false);
      }
      const planSid = currentSid;
      if (!(slot.granted && slot.granted.ticket === ctx.ticket && slot.granted.sid === planSid && slot.granted.origin === ctx.stageOrigin)) {
        const key = JSON.stringify([ctx.stageOrigin, planSid, ctx.ticket]);
        if (slot.granting?.key !== key) slot.granting = { key, done: grant(ctx.stageOrigin, planSid, ctx.ticket) };
        const flying = slot.granting;
        const ok = await flying.done;
        if (slot.granting === flying) slot.granting = null;
        if (gen !== slot.gen) return safeFallback();
        if (currentSid !== planSid || needReload()) return reloadPlan();
        if (!ok) {
          // Handoff failed during ticket renewal: stay on cookies (old cookie usable until expiration),
          // do not fall back to legacy approach
          if (slot.mode === "cookie" && slot.granted?.sid === currentSid) return withSidBase(cached.enabled);
          grantFailed = true;
          return safeFallback();
        }
        slot.granted = { ticket: ctx.ticket, sid: planSid, origin: ctx.stageOrigin };
      }
      if (needReload()) return reloadPlan();
      slot.docSid = currentSid;
      slot.mode = "cookie";
      update();
      return { mode: "cookie", base: mediaSBase(currentSid), ticket: null, cardExec: cached.enabled };
    },
    state: () => cached,
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}

/* ------------------------------------------------------------------ Page instance (editor page module level) */

let pageSession: StageIsolationSession | null = null;
let pageEnabled: () => boolean = () => true;
const pageListeners = new Set<() => void>();
const OFF: CardExecState = Object.freeze({ enabled: false, reason: "no-stage", detail: {}, egress: null }) as CardExecState;

/** Isolation session for this page (lazy creation; `enabled` reads master switch in runtime config) */
export function pageStageIsolation(enabled?: () => boolean): StageIsolationSession {
  if (enabled) pageEnabled = enabled;
  if (!pageSession) {
    pageSession = createStageIsolation({ enabled: () => pageEnabled() });
    pageSession.subscribe(() => { for (const l of [...pageListeners]) { try { l(); } catch { /* The subscriber is broken */ } } });
  }
  return pageSession;
}

/**
 * Whether this page can execute user cards and media effect cards right now, and if not, why
 * (chunks T and L use this to determine "Can this card run on this page" and the description in
 * the parameters panel).
 * If no session has been created yet (desktop runtime environment, stage not yet mounted), returns
 * "single stage, do not execute".
 */
export function onlineCardExec(): CardExecState {
  return pageSession ? pageSession.state() : OFF;
}

export function subscribeOnlineCardExec(cb: () => void): () => void {
  pageListeners.add(cb);
  return () => { pageListeners.delete(cb); };
}

/** For unit tests */
export function resetPageStageIsolationForTest(): void {
  pageSession = null;
  pageEnabled = () => true;
  pageListeners.clear();
}
