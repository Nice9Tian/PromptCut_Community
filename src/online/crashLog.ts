/**
 * 在线浏览器的崩溃记录(语义 `product/platforms.md`「在线浏览器」的三道闸门;做法 `mechanism/platforms.md`「三道闸门」的「崩溃记录」)。
 *
 * 手机浏览器内存超限时整页被系统杀掉,页面收不到通知,所以每一步动手之前先留一条记录,重新载入时据此判断上次死在哪。
 * 记录写在同步的页面本地存储(`localStorage`,编辑器页的源)里,跟设备走、不跟项目走,每条带时间与软件版本。
 *
 * # 判「崩了」
 *
 * 这次载入离上次「还活着」的时刻不到 `CRASH_WINDOW_MS`(1 分钟,用户定),而且上次没有留下「正常离开」,也不处在「在后台」。崩一次就算。
 *
 * - 「还活着」:每留一步记录时更新;之后定时更新(`HEARTBEAT_MS`),运行中途崩掉、随即重新载入的也接得住;
 * - 「正常离开」:`pagehide` 时记下(关页面、刷新、跳走);
 * - 「在后台」:`visibilitychange` 到 hidden 时记下,回到前台清掉。在后台被系统回收不算崩。
 *
 * # 一个设备、几个标签页
 *
 * 同一个源的几个标签页共用这份 `localStorage`。每个标签页有自己的一段(`tabs[<标签页 id>]`:还活着的时刻、正常离开、在后台、上一步),
 * 标签页 id 存在 `sessionStorage`(同一个标签页刷新、崩了重新载入都还在)。三道闸门的结果(舞台闸门到了哪一级、崩了几次、护栏、
 * 解码上限调低了几级、测崩的卡)是设备级的,放在 `device` 里,几个标签页共用。
 *
 * 载入时先看自己这个标签页上次的那一段;`sessionStorage` 丢了(新开的标签页)就看别的标签页留下的、像崩了的那几段 —— 那些标签页
 * 可能还开着(另一个标签页正在用),所以先经 `BroadcastChannel` 问一声,有回音的就是活着的,不算崩(`judgeLoad` 的 `alive` 参数)。
 *
 * 本模块是纯的(存储、时钟、标签页 id 都注入),Node 单测直接用;页面里的接线在 `stageGate.ts`。
 */

export const CRASH_LOG_KEY = "pc.online.crashLog";
export const CRASH_TAB_KEY = "pc.online.tab";
export const CRASH_LOG_VERSION = 1;
/** 判「崩了」的窗口:这次载入离上次「还活着」不到这么久(1 分钟,2026-10-07 用户定) */
export const CRASH_WINDOW_MS = 60_000;
/**
 * 「还活着」定时更新的间隔〔裁〕。崩了之后要在 `CRASH_WINDOW_MS - HEARTBEAT_MS` 之内重新载入才接得住,所以越短越好;
 * 每次是一次 `localStorage.setItem`(这台 PC 上实测一条约 2 KB 的记录写一次几十微秒,数字见报告「数字与依据」),5 秒一次可以忽略。
 */
export const HEARTBEAT_MS = 5_000;
/** 别的标签页的那一段多久没更新就当作已经关了,清掉(不影响判崩:判崩只看 1 分钟以内的) */
export const TAB_STALE_MS = 24 * 3600_000;
/** 设备级的「测崩的卡」最多记这么多张(先进先出) */
export const HEAVY_CARDS_MAX = 500;
/** 查看口留最近几次判定 */
export const HISTORY_MAX = 12;

export type StageLevel = 1 | 2 | 3;

/** 每一步动手之前留的记录:舞台闸门的一步、素材闸门载入原尺寸、即时渲染闸门测一张卡、走完之后在某一级运行 */
export type CrashStep =
  | { kind: "stage"; what: "open-visible" | "visible-ready" | "try-back" | "dual-loaded" | "try-separate" | "separate-ready" }
  | { kind: "running"; level: StageLevel; lowest: boolean }
  | { kind: "media"; capLevel: number }
  | { kind: "measure"; key: string; cardId: string | null };

export interface TabRecord {
  /** 这一段是哪次载入写的(载入时刻) */
  startedAt: number;
  version: string;
  alive: number;
  left: boolean;
  background: boolean;
  step: CrashStep | null;
}

export interface DeviceRecord {
  /** 写这份设备记录的软件版本;和当前不同就是升级了,清零 */
  version: string;
  stage: {
    /** 上一次使用到达的级别;`lowest` 为真时是最低一档(一个舞台) */
    reached: StageLevel | null;
    lowest: boolean;
    /** 崩了几次(往上试成功一次、软件升级时清零) */
    crashes: number;
    /** 护栏到什么时候;null = 没有护栏 */
    guardUntil: number | null;
    /** 上一次使用往上试过(下次载入没判崩就算试成功,清零) */
    tried: boolean;
  };
  /** 素材闸门:载入原尺寸撑崩过几次,解码上限就调低几级 */
  media: { lowered: number };
  /** 即时渲染闸门:测崩了的卡(identityKey);基准卡测崩记 `@benchmark` */
  heavyCards: string[];
}

export interface CrashLog {
  v: number;
  device: DeviceRecord;
  tabs: Record<string, TabRecord>;
  /** 最近几次载入的判定(查看口用) */
  history: { at: number; tab: string; crashed: boolean; step: CrashStep | null; note: string }[];
}

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem?(k: string): void }

export function emptyDevice(version: string): DeviceRecord {
  return { version, stage: { reached: null, lowest: false, crashes: 0, guardUntil: null, tried: false }, media: { lowered: 0 }, heavyCards: [] };
}

export function emptyLog(version: string): CrashLog {
  return { v: CRASH_LOG_VERSION, device: emptyDevice(version), tabs: {}, history: [] };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const level = (v: unknown): StageLevel | null => (v === 1 || v === 2 || v === 3 ? v : null);

function parseStep(v: unknown): CrashStep | null {
  if (!isObj(v)) return null;
  if (v.kind === "stage" && typeof v.what === "string" && ["open-visible", "visible-ready", "try-back", "dual-loaded", "try-separate", "separate-ready"].includes(v.what)) {
    return { kind: "stage", what: v.what as Extract<CrashStep, { kind: "stage" }>["what"] };
  }
  if (v.kind === "running" && level(v.level)) return { kind: "running", level: level(v.level)!, lowest: v.lowest === true };
  if (v.kind === "media" && num(v.capLevel) !== null) return { kind: "media", capLevel: num(v.capLevel)! };
  if (v.kind === "measure" && typeof v.key === "string" && v.key) return { kind: "measure", key: v.key.slice(0, 256), cardId: typeof v.cardId === "string" ? v.cardId.slice(0, 128) : null };
  return null;
}

/** 读记录;读不到、坏了、版本对不上都回空记录(不抛) */
export function readCrashLog(store: KV | null, version: string): CrashLog {
  let raw: unknown = null;
  try { raw = JSON.parse(store?.getItem(CRASH_LOG_KEY) ?? "null"); } catch { raw = null; }
  if (!isObj(raw) || raw.v !== CRASH_LOG_VERSION) return emptyLog(version);
  const d = isObj(raw.device) ? raw.device : {};
  const st = isObj(d.stage) ? d.stage : {};
  const device: DeviceRecord = {
    version: typeof d.version === "string" ? d.version : "",
    stage: {
      reached: level(st.reached),
      lowest: st.lowest === true,
      crashes: Math.max(0, Math.floor(num(st.crashes) ?? 0)),
      guardUntil: num(st.guardUntil),
      tried: st.tried === true,
    },
    media: { lowered: Math.max(0, Math.floor(num(isObj(d.media) ? d.media.lowered : null) ?? 0)) },
    heavyCards: Array.isArray(d.heavyCards) ? d.heavyCards.filter((k): k is string => typeof k === "string" && !!k).slice(-HEAVY_CARDS_MAX) : [],
  };
  const tabs: Record<string, TabRecord> = {};
  if (isObj(raw.tabs)) {
    for (const [id, t] of Object.entries(raw.tabs)) {
      if (!isObj(t) || !id) continue;
      const alive = num(t.alive);
      if (alive === null) continue;
      tabs[id] = { startedAt: num(t.startedAt) ?? alive, version: typeof t.version === "string" ? t.version : "", alive, left: t.left === true, background: t.background === true, step: parseStep(t.step) };
    }
  }
  const history = Array.isArray(raw.history) ? raw.history.filter(isObj).slice(-HISTORY_MAX).map((h) => ({
    at: num(h.at) ?? 0, tab: typeof h.tab === "string" ? h.tab : "", crashed: h.crashed === true, step: parseStep(h.step), note: typeof h.note === "string" ? h.note.slice(0, 200) : "",
  })) : [];
  return { v: CRASH_LOG_VERSION, device, tabs, history };
}

export function writeCrashLog(store: KV | null, log: CrashLog): boolean {
  try { store?.setItem(CRASH_LOG_KEY, JSON.stringify(log)); return !!store; } catch { return false; }
}

/** 这一段像不像崩了(只看它自己:离现在不到 1 分钟、没正常离开、不在后台) */
export function looksCrashed(tab: TabRecord | undefined, now: number): boolean {
  if (!tab) return false;
  return now - tab.alive < CRASH_WINDOW_MS && now >= tab.alive - 1000 && !tab.left && !tab.background;
}

export interface LoadJudgement {
  /** 判为崩了 */
  crashed: boolean;
  /** 崩在哪一步(没崩为 null) */
  step: CrashStep | null;
  /** 判据来自哪个标签页的那一段 */
  fromTab: string | null;
}

/**
 * 载入时判上次崩没崩。`tab` 是这个标签页的 id(`sessionStorage` 里有就是刷新 / 崩了重新载入,没有就是新开的标签页,`fresh` 为真);
 * `alive` 是此刻还活着的别的标签页(经 `BroadcastChannel` 问出来的)。
 * 自己这一段像崩了就是崩了;新开的标签页再看别的标签页留下的、像崩了而且没回音的那几段,取最近的那一段。
 */
export function judgeLoad(log: CrashLog, opts: { tab: string; fresh: boolean; now: number; alive?: ReadonlySet<string> }): LoadJudgement {
  const own = log.tabs[opts.tab];
  if (looksCrashed(own, opts.now)) return { crashed: true, step: own!.step, fromTab: opts.tab };
  if (!opts.fresh) return { crashed: false, step: null, fromTab: null };
  let best: [string, TabRecord] | null = null;
  for (const [id, t] of Object.entries(log.tabs)) {
    if (id === opts.tab || opts.alive?.has(id) || !looksCrashed(t, opts.now)) continue;
    if (!best || t.alive > best[1].alive) best = [id, t];
  }
  return best ? { crashed: true, step: best[1].step, fromTab: best[0] } : { crashed: false, step: null, fromTab: null };
}

/** 别的标签页里像崩了、要问一声还在不在的那几段 */
export function tabsToPing(log: CrashLog, tab: string, now: number): string[] {
  return Object.entries(log.tabs).filter(([id, t]) => id !== tab && looksCrashed(t, now)).map(([id]) => id);
}

/** 关了很久的标签页的那一段清掉 */
export function pruneTabs(log: CrashLog, now: number, keep: string): CrashLog {
  const tabs: Record<string, TabRecord> = {};
  for (const [id, t] of Object.entries(log.tabs)) if (id === keep || now - t.alive < TAB_STALE_MS) tabs[id] = t;
  return { ...log, tabs };
}

/** 一段新的标签页记录(载入时写:还活着、没离开、前后台照实) */
export function freshTab(now: number, version: string, background: boolean, step: CrashStep | null): TabRecord {
  return { startedAt: now, version, alive: now, left: false, background, step };
}

/** 往设备记录里加一张测崩的卡(去重,先进先出) */
export function addHeavyCard(device: DeviceRecord, key: string): DeviceRecord {
  const list = device.heavyCards.filter((k) => k !== key);
  list.push(key);
  return { ...device, heavyCards: list.slice(-HEAVY_CARDS_MAX) };
}

/** 新的标签页 id(16 个字符,只是区分标签页,不是凭证) */
export function newTabId(random: () => number = Math.random): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 16; i++) s += a[Math.floor(random() * a.length) % a.length];
  return s;
}
