/**
 * Stage gate (semantics in `product/platforms.md` "Online browser" -> "Stage gate"; mechanism
 * in `mechanism/platforms.md` "Three gates" -> "Stage gate steps") and crash record wiring shared
 * across the three gates.
 *
 * Three tiers, from low to high: 1 one stage; 2 two stages share one canvas renderer; 3 two stages
 * each use their own. On every clean page open, test from low to high; whichever tier crashes the
 * page, after reload stay at the tier below it, and do not test higher during this session.
 * A single crash counts. After crashing, a guard is active: reopening within the guard directly
 * stops at the tier reached last time; guard starts at 30 minutes and doubles with each crash
 * (user decision), reset to zero upon one successful upward test or software upgrade.
 * Chromium-based browsers on Android only test higher if reporting at least 8 GB memory.
 *
 * This file is split into two halves:
 * - `decideStageGate`: pure decision logic (given previous record, current crash-test result, and
 *   environment, returns how to proceed this time and how to update device record), used directly
 *   by Node unit tests;
 * - `beginStageGate`: page-side wiring (reads/writes crash records, queries other tabs,
 *   periodically updates "still alive", records normal exit and backgrounding, retains records
 *   for each gate), called once on page load in `boot.ts`, passing result to `onlineTier.ts`.
 *
 * Handshake fault tolerance (falls back to single stage if handshake fails or drops) does not go
 * through here: handles current session only, without leaving crash records (`Preview` calls
 * `settleAt(1)`).
 */
import {
  CRASH_TAB_KEY, HEARTBEAT_MS, addHeavyCard, emptyDevice, freshTab, judgeLoad, newTabId, pruneTabs, readCrashLog, tabsToPing, writeCrashLog,
  type CrashLog, type CrashStep, type DeviceRecord, type KV, type LoadJudgement, type StageLevel,
} from "./crashLog.ts";
import { judgeDeviceKind, resolveIpad, type DeviceKind, type DeviceKindResult } from "./deviceKind.ts";
import { initTier, markLowest, markReached, setIdentity, settleAt, tierState, type TierName } from "./onlineTier.ts";

/** Guard start point: wait 30 minutes after 1st crash (user decision), then double with each crash */
export const GUARD_BASE_MS = 30 * 60_000;
/** Chromium-based browsers on Android only test higher if reporting at least this memory (GiB, `navigator.deviceMemory` reports up to 8) (user decision) */
export const ANDROID_TRY_MEMORY_GIB = 8;
/** Timeout waiting for response when a newly opened tab queries whether other tabs are still alive [ruling] */
export const TAB_PING_MS = 200;
/** Key for baseline card in table of crashed cards */
export const BENCHMARK_KEY = "@benchmark";

/** Guard duration after n-th crash: 30 minutes × 2^(n−1) */
export function guardMsOf(crashes: number): number {
  const n = Math.max(1, Math.floor(crashes));
  return GUARD_BASE_MS * 2 ** Math.min(n - 1, 30);
}

export interface GateEnv {
  now: number;
  /** Software version (code version of online build; `dev` for development builds) */
  version: string;
  /** Platform reported by Chromium-based browsers (`navigator.userAgentData.platform`); null if not reported */
  platform: string | null;
  /** `navigator.deviceMemory` (GiB); null if not reported */
  deviceMemory: number | null;
  /** Identity (desktop / mobile, `ipadLike` pending reclassification by stage gate) */
  identity: DeviceKindResult;
  /** Forced tier for development and acceptance check only (`?tier=top|standard|lite|low`); null if omitted */
  forced?: TierName | null;
}

export type GateReason = "trial" | "crash" | "guard" | "android-memory" | "forced";

export interface GateDecision {
  /** Which tier to test up to this time (if fixed, this is the tier it stays at) */
  target: StageLevel;
  /** Initial tier reached (starts from 1 if testing) */
  reached: StageLevel;
  /** Do not test higher */
  fixed: boolean;
  lowest: null | "stage" | "benchmark";
  reason: GateReason;
  /** Identity for this run (iPad is pre-judged by reachable tier: staying at tier 1 counts as mobile, testing higher starts as desktop) */
  identity: DeviceKind;
  /** Modified device record (written back to crash record) */
  device: DeviceRecord;
  /** One-line summary for inspector */
  note: string;
}

/** Crashed at stage step, which tier to stop at this time (`lowest` is true = cannot even support one stage) */
export function levelAfterCrash(step: CrashStep | null): { level: StageLevel; lowest: boolean } | null {
  if (!step) return { level: 1, lowest: true };
  if (step.kind === "stage") {
    switch (step.what) {
      case "open-visible": return { level: 1, lowest: true };
      case "visible-ready": case "try-back": return { level: 1, lowest: false };
      case "dual-loaded": case "try-separate": return { level: 2, lowest: false };
      case "separate-ready": return { level: 2, lowest: false };
    }
  }
  if (step.kind === "running") {
    if (step.lowest || step.level === 1) return { level: 1, lowest: true };
    return { level: (step.level - 1) as StageLevel, lowest: false };
  }
  if (step.kind === "measure" && step.key === BENCHMARK_KEY) return { level: 1, lowest: true };
  return null;
}

const FORCED: Record<TierName, { level: StageLevel; lowest: boolean }> = {
  top: { level: 3, lowest: false }, standard: { level: 2, lowest: false }, lite: { level: 1, lowest: false }, low: { level: 1, lowest: true },
};

/**
 * How to proceed through stage gate this time (`mechanism/platforms.md` "Stage gate steps"
 * items 1-3).
 * If crashed while testing a specific card (on-demand render gate), record that card in crashed
 * cards; if crashed while loading original size (asset gate), lower decoding limit by one tier;
 * neither counts as a stage crash, but this run also does not count as "one successful upward
 * test".
 */
export function decideStageGate(log: CrashLog, judged: LoadJudgement, env: GateEnv): GateDecision {
  let device: DeviceRecord = log.device.version === env.version ? log.device : emptyDevice(env.version);
  const upgraded = log.device.version !== env.version && log.device.version !== "";
  const out = (d: Omit<GateDecision, "device" | "identity">, dev: DeviceRecord): GateDecision => {
    const identity = env.identity.ipadLike ? resolveIpad(env.identity, d.fixed ? d.reached : 2) : env.identity.kind;
    return { ...d, identity, device: dev };
  };
  if (env.forced) {
    const f = FORCED[env.forced];
    return out({ target: f.level, reached: f.level, fixed: true, lowest: f.lowest ? "stage" : null, reason: "forced", note: `Forced tier ${env.forced} (for development and acceptance checks)` }, device);
  }
  const stageCrash = judged.crashed && !upgraded ? levelAfterCrash(judged.step) : null;
  if (judged.crashed && !upgraded && judged.step?.kind === "measure" && judged.step.key !== BENCHMARK_KEY) {
    device = addHeavyCard(device, judged.step.key);
  }
  if (judged.crashed && !upgraded && judged.step?.kind === "media") {
    device = { ...device, media: { lowered: device.media.lowered + 1 } };
  }
  if (stageCrash) {
    const crashes = device.stage.crashes + 1;
    const guardUntil = env.now + guardMsOf(crashes);
    const benchmark = judged.step?.kind === "measure" && judged.step.key === BENCHMARK_KEY;
    const lowest = stageCrash.lowest ? (benchmark ? "benchmark" : "stage") : null;
    device = { ...device, stage: { reached: stageCrash.level, lowest: !!lowest, crashes, guardUntil, tried: false } };
    return out({
      target: stageCrash.level, reached: stageCrash.level, fixed: true, lowest, reason: "crash",
      note: `Last crash at ${stepText(judged.step)}, this time stopped at ${lowest ? "Lowest tier" : `level ${stageCrash.level}`}; crash #${crashes}, guard ${Math.round(guardMsOf(crashes) / 60_000)} min`,
    }, device);
  }
  // One successful upward test (tested last time, not judged crashed on load this time): crash count reset to zero, guard removed
  if (device.stage.tried && !judged.crashed) device = { ...device, stage: { ...device.stage, crashes: 0, guardUntil: null, tried: false } };
  else device = { ...device, stage: { ...device.stage, tried: false } };
  const g = device.stage.guardUntil;
  if (g !== null && env.now < g) {
    const reached = device.stage.reached ?? 1;
    const lowest = device.stage.lowest ? "stage" : null;
    return out({ target: reached, reached, fixed: true, lowest, reason: "guard", note: `Within guard (${Math.ceil((g - env.now) / 60_000)} min left): stopped at ${lowest ? "Lowest tier" : `level ${reached}`}, not trying higher` }, device);
  }
  if (g !== null) device = { ...device, stage: { ...device.stage, guardUntil: null } };
  if (/android/i.test(env.platform ?? "") && !(Number(env.deviceMemory) >= ANDROID_TRY_MEMORY_GIB)) {
    device = { ...device, stage: { ...device.stage, reached: 1, lowest: false } };
    return out({ target: 1, reached: 1, fixed: true, lowest: null, reason: "android-memory", note: `Android Chromium reports ${env.deviceMemory ?? "unknown"} GB of memory, below ${ANDROID_TRY_MEMORY_GIB} GB: stopped at one stage, no trial` }, device);
  }
  device = { ...device, stage: { ...device.stage, tried: true, lowest: false } };
  return out({ target: 3, reached: 1, fixed: false, lowest: null, reason: "trial", note: upgraded ? "Software upgraded: reset, trying from low to high" : "Try from low to high" }, device);
}

export function stepText(step: CrashStep | null): string {
  if (!step) return "(no record)";
  switch (step.kind) {
    case "stage": return {
      "open-visible": "Opening visible stage", "visible-ready": "Visible stage ready", "try-back": "Starting background stage trial", "dual-loaded": "Both stages loaded",
      "try-separate": "Starting trial with a separate renderer per stage", "separate-ready": "Separate renderers ready",
    }[step.what];
    case "running": return step.lowest ? "Lowest tier running" : `Level ${step.level} running`;
    case "media": return `Loading media at original size (decode cap level ${step.capLevel})`;
    case "measure": return step.key === BENCHMARK_KEY ? "Measuring benchmark card" : `Measuring card ${step.cardId ?? step.key}`;
  }
}

/* ------------------------------------------------------------------ Page side */

export interface GateDeps {
  local?: KV | null;
  session?: KV | null;
  now?: () => number;
  version: string;
  /** Queries other tabs whether they are still alive (`BroadcastChannel`); returns ids currently alive */
  ping?: (ids: string[]) => Promise<Set<string>>;
  env?: Partial<Pick<GateEnv, "platform" | "deviceMemory" | "identity" | "forced">>;
  /** Backgrounding and exit (defaults to listening to `document` / `window` events); not hooked in unit tests */
  listen?: boolean;
  hidden?: () => boolean;
}

export interface StageGateSession {
  readonly tab: string;
  readonly decision: GateDecision;
  readonly judged: LoadJudgement;
  /** Stage gate step (recorded before taking action) */
  stage(what: Extract<CrashStep, { kind: "stage" }>["what"]): void;
  /** Stage gate advanced upward by one tier */
  reached(level: StageLevel): void;
  /** Handshake fault tolerance falling back to single stage: applies only to current run, leaves no crash record */
  fallback(level: StageLevel): void;
  /** Stage gate completed (periodically updates "still alive" afterward; counts as this tier if crashed) */
  done(): void;
  /** On-demand render gate: before / after testing this card */
  measureStart(key: string, cardId: string | null): void;
  measureEnd(): void;
  /** Baseline card cannot run: enters lowest tier this time (applies to this run only; crash-tested ones managed by crash records) */
  benchmarkSlow(): void;
  /** Asset gate: before loading original size (which tier of decoding limit) / loading concluded */
  mediaStart(capLevel: number): void;
  mediaEnd(): void;
  /** Cards that crashed during testing (identityKey) */
  heavyCards(): ReadonlySet<string>;
  /** Number of crashes from loading original size (decoding limit lowered by how many tiers) */
  mediaLowered(): number;
  /** Inspector: current results and crash records across gates (excluding credentials) */
  snapshot(): GateSnapshot;
  dispose(): void;
}

export interface GateSnapshot {
  tab: string;
  decision: Omit<GateDecision, "device">;
  judged: LoadJudgement;
  tier: ReturnType<typeof tierState>;
  log: CrashLog;
  step: CrashStep | null;
}

/** Reads browser environment (only Chromium-based browsers have `userAgentData`, `deviceMemory`) */
export function readGateEnv(): Pick<GateEnv, "platform" | "deviceMemory" | "identity"> {
  const nav = (typeof navigator !== "undefined" ? navigator : null) as (Navigator & { userAgentData?: { platform?: string; mobile?: boolean }; deviceMemory?: number }) | null;
  const platform = typeof nav?.userAgentData?.platform === "string" ? nav.userAgentData.platform : null;
  const deviceMemory = typeof nav?.deviceMemory === "number" ? nav.deviceMemory : null;
  const identity = judgeDeviceKind({ ua: nav?.userAgent ?? "", uaData: nav?.userAgentData ?? null, maxTouchPoints: nav?.maxTouchPoints ?? 0 });
  return { platform, deviceMemory, identity };
}

/** Forced tier in URL (for development and acceptance check only, `?tier=top|standard|lite|low`) */
export function forcedTierOf(search: string): TierName | null {
  try {
    const v = new URLSearchParams(search).get("tier");
    return v === "top" || v === "standard" || v === "lite" || v === "low" ? v : null;
  } catch {
    return null;
  }
}

const safe = (pick: () => KV | undefined): KV | null => { try { return pick() ?? null; } catch { return null; } };

/**
 * Queries other tabs via `BroadcastChannel` to check if they are still alive: sends `ping` (with
 * the query id), and open tabs reply with `pong`. Waits for `TAB_PING_MS`.
 * Browsers without `BroadcastChannel` return empty (treating those segments as crashed anyway).
 */
export const CRASH_CHANNEL = "pc-online-crashlog";
export function pingTabs(ids: string[], waitMs = TAB_PING_MS): Promise<Set<string>> {
  const BC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (!ids.length || typeof BC !== "function") return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const alive = new Set<string>();
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BC(CRASH_CHANNEL);
      ch.onmessage = (e) => { const d = e.data as { type?: string; id?: string }; if (d?.type === "pong" && typeof d.id === "string" && ids.includes(d.id)) alive.add(d.id); };
      ch.postMessage({ type: "ping", ids });
    } catch { resolve(alive); return; }
    setTimeout(() => { try { ch?.close(); } catch { /* Closed */ } resolve(alive); }, waitMs);
  });
}

/**
 * Opens the stage gate on page load: reads crash records, determines whether it crashed last
 * time (a newly opened tab asks other tabs first), decides how to proceed this time, writes back
 * records, and hands off to `onlineTier.ts`.
 * Subsequent steps are logged by callers (`Preview`, measurement, assets) via the returned session.
 */
export async function beginStageGate(deps: GateDeps): Promise<StageGateSession> {
  const local = deps.local !== undefined ? deps.local : safe(() => (globalThis as { localStorage?: KV }).localStorage);
  const session = deps.session !== undefined ? deps.session : safe(() => (globalThis as { sessionStorage?: KV }).sessionStorage);
  const now = deps.now ?? Date.now;
  const hidden = deps.hidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden");
  let tab: string | null = null;
  try { tab = session?.getItem(CRASH_TAB_KEY) ?? null; } catch { tab = null; }
  const fresh = !tab;
  if (!tab) {
    tab = newTabId();
    try { session?.setItem(CRASH_TAB_KEY, tab); } catch { /* Cannot persist: this time only */ }
  }
  const myTab = tab;
  let log = readCrashLog(local, deps.version);
  const t0 = now();
  const ask = fresh ? tabsToPing(log, myTab, t0) : [];
  const alive = ask.length ? await (deps.ping ?? pingTabs)(ask).catch(() => new Set<string>()) : new Set<string>();
  const judged = judgeLoad(log, { tab: myTab, fresh, now: t0, alive });
  const env: GateEnv = { now: t0, version: deps.version, ...readGateEnv(), ...deps.env, forced: deps.env?.forced ?? null } as GateEnv;
  const decision = decideStageGate(log, judged, env);
  const firstStep: CrashStep = decision.fixed && decision.lowest ? { kind: "running", level: 1, lowest: true } : { kind: "stage", what: "open-visible" };
  log = pruneTabs({ ...log, device: decision.device }, t0, myTab);
  log.tabs = { ...log.tabs, [myTab]: freshTab(t0, deps.version, hidden(), firstStep) };
  // The segment judged as crashed (left by another tab) has already been counted: mark as left
  // to avoid the next newly opened tab counting it again
  if (judged.crashed && judged.fromTab && judged.fromTab !== myTab && log.tabs[judged.fromTab]) log.tabs[judged.fromTab] = { ...log.tabs[judged.fromTab], left: true };
  log.history = [...log.history, { at: t0, tab: myTab, crashed: judged.crashed, step: judged.step, note: decision.note }].slice(-12);
  writeCrashLog(local, log);

  initTier({ online: true, target: decision.target, reached: decision.reached, gate: decision.fixed ? "done" : "trying", lowest: decision.lowest, identity: decision.identity });

  const forced = decision.reason === "forced";
  let step: CrashStep | null = firstStep;
  let doneLevel: StageLevel | null = decision.fixed ? decision.target : null;
  let beforeMeasure: CrashStep | null = null;
  let beforeMedia: CrashStep | null = null;
  let benchmarkSlow = false;
  const update = (patch: (t: CrashLog["tabs"][string], log: CrashLog) => Partial<CrashLog["tabs"][string]> | null, device?: (d: DeviceRecord) => DeviceRecord) => {
    const cur = readCrashLog(local, deps.version);
    const mine = cur.tabs[myTab] ?? freshTab(now(), deps.version, hidden(), step);
    const p = patch(mine, cur);
    if (p) cur.tabs = { ...cur.tabs, [myTab]: { ...mine, ...p } };
    if (device) cur.device = device(cur.device.version === deps.version ? cur.device : emptyDevice(deps.version));
    writeCrashLog(local, cur);
  };
  const setStep = (s: CrashStep | null) => { step = s; update(() => ({ step: s, alive: now(), left: false })); };
  const runningStep = (): CrashStep => ({ kind: "running", level: doneLevel ?? tierState().reached, lowest: tierState().lowest !== null });

  const onPagehide = () => update(() => ({ left: true, alive: now() }));
  const onPageshow = () => update(() => ({ left: false, alive: now(), background: hidden() }));
  const onVisibility = () => update(() => ({ background: hidden(), alive: now() }));
  const onChannel = (e: MessageEvent) => {
    const d = e.data as { type?: string; ids?: unknown };
    if (d?.type === "ping" && Array.isArray(d.ids) && d.ids.includes(myTab)) { try { channel?.postMessage({ type: "pong", id: myTab }); } catch { /* Closed */ } }
  };
  let channel: BroadcastChannel | null = null;
  const timer = setInterval(() => update((t) => ({ alive: now(), background: hidden(), left: t.left && !hidden() ? false : t.left })), HEARTBEAT_MS);
  (timer as { unref?: () => void }).unref?.();
  if (deps.listen !== false && typeof window !== "undefined") {
    window.addEventListener("pagehide", onPagehide);
    window.addEventListener("pageshow", onPageshow);
    document.addEventListener("visibilitychange", onVisibility);
    const BC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    if (typeof BC === "function") { try { channel = new BC(CRASH_CHANNEL); channel.onmessage = onChannel; } catch { channel = null; } }
  }

  const s: StageGateSession = {
    tab: myTab,
    decision,
    judged,
    stage(what) { if (doneLevel === null) setStep({ kind: "stage", what }); },
    reached(level) {
      markReached(level);
      if (forced) return;
      update(() => null, (d) => ({ ...d, stage: { ...d.stage, reached: Math.max(d.stage.reached ?? 1, level) as StageLevel, lowest: false } }));
    },
    fallback(level) {
      settleAt(level);
      // Only for the current run: does not change tier in device records, leaves no crash record;
      // the upward trial attempt does not count (does not clear)
      update(() => null, (d) => ({ ...d, stage: { ...d.stage, tried: false } }));
      doneLevel = level;
      if (decision.identity !== resolveIpad(env.identity, level)) setIdentity(resolveIpad(env.identity, level));
      setStep(runningStep());
    },
    done() {
      if (doneLevel !== null && step?.kind === "running") return;
      const t = tierState();
      doneLevel = t.reached;
      if (t.gate !== "done") settleAt(t.reached);
      // iPad: reaching tier 2 or tier 3 counts as desktop, staying at tier 1 counts as mobile
      // (user decision, 2026-10-21)
      if (decision.identity !== resolveIpad(env.identity, t.reached)) setIdentity(resolveIpad(env.identity, t.reached));
      if (!forced) update(() => null, (d) => ({ ...d, stage: { ...d.stage, reached: t.reached, lowest: t.lowest !== null } }));
      setStep(runningStep());
    },
    measureStart(key, cardId) { beforeMeasure = step?.kind === "measure" ? beforeMeasure : step; setStep({ kind: "measure", key, cardId }); },
    // Return to the step before measurement; if the gate finished during measurement (that step
    // was a stage gate step and is now obsolete), return "tier X running"
    measureEnd() { const back = beforeMeasure ?? runningStep(); beforeMeasure = null; setStep(back.kind === "measure" || (back.kind === "stage" && doneLevel !== null) ? runningStep() : back); },
    benchmarkSlow() {
      if (benchmarkSlow) return;
      benchmarkSlow = true;
      markLowest("benchmark");
      if (doneLevel !== null && step?.kind === "running") setStep(runningStep());
    },
    mediaStart(capLevel) { if (step?.kind === "measure") return; beforeMedia = step?.kind === "media" ? beforeMedia : step; setStep({ kind: "media", capLevel }); },
    mediaEnd() { if (step?.kind !== "media") return; const back = beforeMedia ?? runningStep(); beforeMedia = null; setStep(back.kind === "stage" && doneLevel !== null ? runningStep() : back); },
    heavyCards: () => new Set(readCrashLog(local, deps.version).device.heavyCards),
    mediaLowered: () => readCrashLog(local, deps.version).device.media.lowered,
    snapshot() {
      const { device: _d, ...rest } = decision;
      return { tab: myTab, decision: rest, judged, tier: tierState(), log: readCrashLog(local, deps.version), step };
    },
    dispose() {
      clearInterval(timer);
      if (deps.listen !== false && typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPagehide);
        window.removeEventListener("pageshow", onPageshow);
        document.removeEventListener("visibilitychange", onVisibility);
      }
      try { channel?.close(); } catch { /* Closed */ }
    },
  };
  return s;
}

/**
 * Synchronously predicts identity for this run (used to select UI: `Shell.tsx` must decide between
 * mobile app and desktop app UI at page load and cannot wait to ask other tabs).
 * Only checks this tab's own previous segment, writing no records. iPad: within the guard, those
 * that crashed and stayed at tier 1 count as mobile; those attempting an upward trial start as
 * desktop (if falling back to single stage mid-trial, UI is not switched again this time).
 */
export function predictIdentity(version: string, search = typeof location !== "undefined" ? location.search : ""): DeviceKind {
  const local = safe(() => (globalThis as { localStorage?: KV }).localStorage);
  const session = safe(() => (globalThis as { sessionStorage?: KV }).sessionStorage);
  let tab: string | null = null;
  try { tab = session?.getItem(CRASH_TAB_KEY) ?? null; } catch { tab = null; }
  const log = readCrashLog(local, version);
  const now = Date.now();
  const judged = tab ? judgeLoad(log, { tab, fresh: false, now }) : { crashed: false, step: null, fromTab: null };
  return decideStageGate(log, judged, { now, version, ...readGateEnv(), forced: forcedTierOf(search) }).identity;
}

/* ------------------------------------------------------------------ The session for this page */

let pageGate: StageGateSession | null = null;
let pageGateWait: Promise<StageGateSession> | null = null;
const gateListeners = new Set<(g: StageGateSession) => void>();

/** Stage gate session for this page (opened by `boot.ts`; null before opening completes) */
export function stageGate(): StageGateSession | null {
  return pageGate;
}

/** Wait for this page's stage gate session to finish opening */
export function whenStageGate(): Promise<StageGateSession> | null {
  return pageGateWait;
}

export function onStageGate(cb: (g: StageGateSession) => void): () => void {
  if (pageGate) cb(pageGate);
  gateListeners.add(cb);
  return () => { gateListeners.delete(cb); };
}

/** Called by `boot.ts`: opens the stage gate for this page */
export function bootStageGate(deps: GateDeps): Promise<StageGateSession> {
  pageGateWait ??= beginStageGate(deps).then((g) => {
    pageGate = g;
    for (const l of [...gateListeners]) { try { l(g); } catch { /* The subscriber is broken */ } }
    return g;
  });
  return pageGateWait;
}

/** For tests */
export function resetStageGateForTest(): void {
  pageGate?.dispose();
  pageGate = null;
  pageGateWait = null;
  gateListeners.clear();
}

export type { StageLevel };
