/**
 * 舞台闸门(语义 `product/platforms.md`「在线浏览器」的「舞台闸门」;做法 `mechanism/platforms.md`「三道闸门」的「舞台闸门的步骤」)
 * 与三道闸门共用的崩溃记录接线。
 *
 * 三级,从低到高:1 一个舞台;2 两个舞台共用一套 canvas 渲染器;3 两个舞台各用一套。每次全新打开页面时从低往高试,哪一级把页面撑崩了,
 * 重新载入后就停在它的下一级,这次使用期间不再往上试。崩一次就算。崩过之后有一段护栏:护栏内重新打开直接停在上次到达的那一级;
 * 护栏从 30 分钟起每崩一次翻一倍(用户定),往上试成功一次或软件升级时清零。安卓上的 Chromium 系报到 8 GB 内存才往上试。
 *
 * 本文件分两半:
 * - `decideStageGate`:纯的判法(给上次的记录、这次的判崩结果与环境,回这次怎么走、设备记录怎么改),Node 单测直接用;
 * - `beginStageGate`:页面一侧的接线(读写崩溃记录、问别的标签页、定时更新「还活着」、记正常离开与在后台、各闸门留记录),
 *   在 `boot.ts` 里页面载入时调一次,结果交给 `onlineTier.ts`。
 *
 * 握手容错(握不上、握上又断就退回单舞台)不经这里:只管当次、不留崩溃记录(`Preview` 调 `settleAt(1)`)。
 */
import {
  CRASH_TAB_KEY, HEARTBEAT_MS, addHeavyCard, emptyDevice, freshTab, judgeLoad, newTabId, pruneTabs, readCrashLog, tabsToPing, writeCrashLog,
  type CrashLog, type CrashStep, type DeviceRecord, type KV, type LoadJudgement, type StageLevel,
} from "./crashLog.ts";
import { judgeDeviceKind, resolveIpad, type DeviceKind, type DeviceKindResult } from "./deviceKind.ts";
import { initTier, markLowest, markReached, setIdentity, settleAt, tierState, type TierName } from "./onlineTier.ts";

/** 护栏的起点:第 1 次崩后等 30 分钟(用户定),之后每崩一次翻一倍 */
export const GUARD_BASE_MS = 30 * 60_000;
/** 安卓上的 Chromium 系报到这么多内存(GiB,`navigator.deviceMemory` 最高报 8)才往上试(用户定) */
export const ANDROID_TRY_MEMORY_GIB = 8;
/** 新开的标签页问别的标签页还在不在,等回音的时限〔裁〕 */
export const TAB_PING_MS = 200;
/** 基准卡在测崩的卡表里的键 */
export const BENCHMARK_KEY = "@benchmark";

/** 第 n 次崩后的护栏时长:30 分钟 × 2^(n−1) */
export function guardMsOf(crashes: number): number {
  const n = Math.max(1, Math.floor(crashes));
  return GUARD_BASE_MS * 2 ** Math.min(n - 1, 30);
}

export interface GateEnv {
  now: number;
  /** 软件版本(在线构建的代码版本;开发构建为 `dev`) */
  version: string;
  /** Chromium 系报的系统(`navigator.userAgentData.platform`);不报为 null */
  platform: string | null;
  /** `navigator.deviceMemory`(GiB);不报为 null */
  deviceMemory: number | null;
  /** 身份(电脑 / 手机,`ipadLike` 待舞台闸门改判) */
  identity: DeviceKindResult;
  /** 只给开发和验收用的强制档位(`?tier=top|standard|lite|low`);不给为 null */
  forced?: TierName | null;
}

export type GateReason = "trial" | "crash" | "guard" | "android-memory" | "forced";

export interface GateDecision {
  /** 这次要试到哪一级(固定的就是停的那一级) */
  target: StageLevel;
  /** 起手到达的级别(试的话从 1 起) */
  reached: StageLevel;
  /** 不往上试 */
  fixed: boolean;
  lowest: null | "stage" | "benchmark";
  reason: GateReason;
  /** 这次的身份(iPad 已按能到的级别预判:停在第一级的算手机,要试的先按电脑) */
  identity: DeviceKind;
  /** 改过的设备记录(写回崩溃记录) */
  device: DeviceRecord;
  /** 给查看口的一句话 */
  note: string;
}

/** 崩在舞台这一步,这次停在哪一级(`lowest` 为真 = 一个舞台都撑不住) */
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
 * 这次舞台闸门怎么走(`mechanism/platforms.md`「舞台闸门的步骤」第 1～3 条)。
 * 崩在测某张卡(即时渲染闸门)的,那张卡记进测崩的卡;崩在载入原尺寸(素材闸门)的,解码上限调低一级;这两种不算舞台崩,
 * 但这次也不算「往上试成功一次」。
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
    return out({ target: f.level, reached: f.level, fixed: true, lowest: f.lowest ? "stage" : null, reason: "forced", note: `强制档位 ${env.forced}(开发与验收用)` }, device);
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
      note: `上次崩在 ${stepText(judged.step)},这次停在${lowest ? "最低一档" : `第 ${stageCrash.level} 级`};第 ${crashes} 次崩,护栏 ${Math.round(guardMsOf(crashes) / 60_000)} 分钟`,
    }, device);
  }
  // 往上试成功一次(上次试了、这次载入没判崩):崩的次数清零,护栏撤掉
  if (device.stage.tried && !judged.crashed) device = { ...device, stage: { ...device.stage, crashes: 0, guardUntil: null, tried: false } };
  else device = { ...device, stage: { ...device.stage, tried: false } };
  const g = device.stage.guardUntil;
  if (g !== null && env.now < g) {
    const reached = device.stage.reached ?? 1;
    const lowest = device.stage.lowest ? "stage" : null;
    return out({ target: reached, reached, fixed: true, lowest, reason: "guard", note: `护栏内(还剩 ${Math.ceil((g - env.now) / 60_000)} 分钟):停在${lowest ? "最低一档" : `第 ${reached} 级`},不往上试` }, device);
  }
  if (g !== null) device = { ...device, stage: { ...device.stage, guardUntil: null } };
  if (/android/i.test(env.platform ?? "") && !(Number(env.deviceMemory) >= ANDROID_TRY_MEMORY_GIB)) {
    device = { ...device, stage: { ...device.stage, reached: 1, lowest: false } };
    return out({ target: 1, reached: 1, fixed: true, lowest: null, reason: "android-memory", note: `安卓 Chromium 系报的内存 ${env.deviceMemory ?? "未知"} GB,不到 ${ANDROID_TRY_MEMORY_GIB} GB:停在一个舞台,不试` }, device);
  }
  device = { ...device, stage: { ...device.stage, tried: true, lowest: false } };
  return out({ target: 3, reached: 1, fixed: false, lowest: null, reason: "trial", note: upgraded ? "软件升级了:清零,从低往高试" : "从低往高试" }, device);
}

export function stepText(step: CrashStep | null): string {
  if (!step) return "(没有记录)";
  switch (step.kind) {
    case "stage": return {
      "open-visible": "开可见舞台", "visible-ready": "可见舞台就绪", "try-back": "开始试后台舞台", "dual-loaded": "双舞台已载入",
      "try-separate": "开始试每个舞台各一套渲染器", "separate-ready": "各一套渲染器就绪",
    }[step.what];
    case "running": return step.lowest ? "最低一档运行中" : `第 ${step.level} 级运行中`;
    case "media": return `载入素材原尺寸(解码上限第 ${step.capLevel} 级)`;
    case "measure": return step.key === BENCHMARK_KEY ? "测基准卡" : `测卡 ${step.cardId ?? step.key}`;
  }
}

/* ------------------------------------------------------------------ 页面一侧 */

export interface GateDeps {
  local?: KV | null;
  session?: KV | null;
  now?: () => number;
  version: string;
  /** 问别的标签页还在不在(`BroadcastChannel`);回此刻还活着的那几个 id */
  ping?: (ids: string[]) => Promise<Set<string>>;
  env?: Partial<Pick<GateEnv, "platform" | "deviceMemory" | "identity" | "forced">>;
  /** 后台与离开(缺省接 `document` / `window` 的事件);单测不接 */
  listen?: boolean;
  hidden?: () => boolean;
}

export interface StageGateSession {
  readonly tab: string;
  readonly decision: GateDecision;
  readonly judged: LoadJudgement;
  /** 舞台闸门的一步(动手之前留) */
  stage(what: Extract<CrashStep, { kind: "stage" }>["what"]): void;
  /** 舞台闸门往上走到了一级 */
  reached(level: StageLevel): void;
  /** 握手容错退回单舞台:只管当次,不留崩溃记录 */
  fallback(level: StageLevel): void;
  /** 舞台闸门走完(之后定时更新「还活着」,崩了按这一级算) */
  done(): void;
  /** 即时渲染闸门:测这张卡之前 / 之后 */
  measureStart(key: string, cardId: string | null): void;
  measureEnd(): void;
  /** 基准卡跑不动:这次进最低一档(只管这一次;测崩了的由崩溃记录管) */
  benchmarkSlow(): void;
  /** 素材闸门:要载入原尺寸之前(解码上限第几级) / 载入告一段落 */
  mediaStart(capLevel: number): void;
  mediaEnd(): void;
  /** 测崩过的卡(identityKey) */
  heavyCards(): ReadonlySet<string>;
  /** 载入原尺寸撑崩过几次(解码上限调低几级) */
  mediaLowered(): number;
  /** 查看口:当前各闸门的结果与崩溃记录(不含凭证) */
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

/** 读浏览器的环境(Chromium 系才有 `userAgentData`、`deviceMemory`) */
export function readGateEnv(): Pick<GateEnv, "platform" | "deviceMemory" | "identity"> {
  const nav = (typeof navigator !== "undefined" ? navigator : null) as (Navigator & { userAgentData?: { platform?: string; mobile?: boolean }; deviceMemory?: number }) | null;
  const platform = typeof nav?.userAgentData?.platform === "string" ? nav.userAgentData.platform : null;
  const deviceMemory = typeof nav?.deviceMemory === "number" ? nav.deviceMemory : null;
  const identity = judgeDeviceKind({ ua: nav?.userAgent ?? "", uaData: nav?.userAgentData ?? null, maxTouchPoints: nav?.maxTouchPoints ?? 0 });
  return { platform, deviceMemory, identity };
}

/** 地址里的强制档位(只给开发和验收用,`?tier=top|standard|lite|low`) */
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
 * 经 `BroadcastChannel` 问别的标签页还在不在:发 `ping`(带要问的 id),还开着的标签页回 `pong`。等 `TAB_PING_MS`。
 * 没有 `BroadcastChannel` 的浏览器回空(那几段照像崩了算)。
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
    setTimeout(() => { try { ch?.close(); } catch { /* 已关 */ } resolve(alive); }, waitMs);
  });
}

/**
 * 页面载入时开舞台闸门:读崩溃记录、判上次崩没崩(新开的标签页先问别的标签页)、定这次怎么走、写回记录、交给 `onlineTier.ts`。
 * 之后的每一步由调用方(`Preview`、测量、素材)经回的会话留记录。
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
    try { session?.setItem(CRASH_TAB_KEY, tab); } catch { /* 存不了:只这一次 */ }
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
  // 判崩的那一段(别的标签页留下的)已经算过了:标成离开,免得下一个新开的标签页再算一遍
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
    if (d?.type === "ping" && Array.isArray(d.ids) && d.ids.includes(myTab)) { try { channel?.postMessage({ type: "pong", id: myTab }); } catch { /* 关了 */ } }
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
      // 只管当次:不改设备记录的级别、不留崩溃记录;往上试的那一次不算(不清零)
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
      // iPad:到了第二级或第三级算电脑,停在第一级算手机(2026-10-21 用户定)
      if (decision.identity !== resolveIpad(env.identity, t.reached)) setIdentity(resolveIpad(env.identity, t.reached));
      if (!forced) update(() => null, (d) => ({ ...d, stage: { ...d.stage, reached: t.reached, lowest: t.lowest !== null } }));
      setStep(runningStep());
    },
    measureStart(key, cardId) { beforeMeasure = step?.kind === "measure" ? beforeMeasure : step; setStep({ kind: "measure", key, cardId }); },
    // 回到测之前那一步;闸门在测的这段时间里走完了(那一步是舞台闸门的某一步,已经过时),回「第几级运行中」
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
      try { channel?.close(); } catch { /* 已关 */ }
    },
  };
  return s;
}

/**
 * 同步预判这次的身份(选界面用:`Shell.tsx` 在页面载入时就要定手机版还是桌面版界面,等不及问别的标签页)。
 * 只看自己这个标签页上次的那一段,不写记录。iPad:护栏内、崩过停在第一级的算手机;要往上试的先按电脑(试的途中退回单舞台的,这次界面不再换)。
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

/* ------------------------------------------------------------------ 本页的那一个会话 */

let pageGate: StageGateSession | null = null;
let pageGateWait: Promise<StageGateSession> | null = null;
const gateListeners = new Set<(g: StageGateSession) => void>();

/** 本页的舞台闸门会话(`boot.ts` 开;还没开完时为 null) */
export function stageGate(): StageGateSession | null {
  return pageGate;
}

/** 等本页的舞台闸门会话开好 */
export function whenStageGate(): Promise<StageGateSession> | null {
  return pageGateWait;
}

export function onStageGate(cb: (g: StageGateSession) => void): () => void {
  if (pageGate) cb(pageGate);
  gateListeners.add(cb);
  return () => { gateListeners.delete(cb); };
}

/** `boot.ts` 调:开本页的舞台闸门 */
export function bootStageGate(deps: GateDeps): Promise<StageGateSession> {
  pageGateWait ??= beginStageGate(deps).then((g) => {
    pageGate = g;
    for (const l of [...gateListeners]) { try { l(g); } catch { /* 订阅方坏了 */ } }
    return g;
  });
  return pageGateWait;
}

/** 测试用 */
export function resetStageGateForTest(): void {
  pageGate?.dispose();
  pageGate = null;
  pageGateWait = null;
  gateListeners.clear();
}

export type { StageLevel };
