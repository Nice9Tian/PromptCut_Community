/**
 * Online browser crash log (semantics: three gates in `product/platforms.md` "Online browser";
 * mechanism: "Crash log" under "Three gates" in `mechanism/platforms.md`).
 *
 * When a mobile browser exceeds memory limits, the system kills the whole page without notice, so
 * a record is left before every step to determine where it died upon reload. Records are written to
 * synchronous page local storage (`localStorage`, editor page origin), tied to the device rather
 * than the project, each with timestamp and software version.
 *
 * # Determining "crashed"
 *
 * This load occurred within `CRASH_WINDOW_MS` (1 minute, user decision) since the last "still alive"
 * timestamp, without a recorded "clean exit", and not while "in background". A single crash counts.
 *
 * - "still alive": updated whenever a step record is written; periodically updated afterwards
 *   (`HEARTBEAT_MS`), catching mid-run crashes followed immediately by a reload;
 * - "clean exit": recorded on `pagehide` (closing page, reload, navigation);
 * - "in background": recorded when `visibilitychange` transitions to hidden, cleared upon returning
 *   to foreground. Being reclaimed by the system while in the background does not count as a crash.
 *
 * # One device, multiple tabs
 *
 * Multiple tabs from the same origin share this `localStorage`. Each tab has its own section
 * (`tabs[<tab id>]`: alive timestamp, clean exit, in background, previous step), with tab id stored
 * in `sessionStorage` (preserved across refreshes and crash reloads within the same tab). The
 * results of the three gates (stage gate tier reached, crash count, guards, decoding cap tier
 * downgrades, cards that crashed during testing) are device-level, stored in `device`, and shared
 * among tabs.
 *
 * On load, it first checks the previous section for its own tab; if `sessionStorage` was lost
 * (newly opened tab), it inspects sections left by other tabs that look crashed: those tabs might
 * still be open (in active use by another tab), so it queries via `BroadcastChannel` first; any tab
 * that responds is alive and not counted as crashed (`alive` parameter in `judgeLoad`).
 *
 * This module is pure (storage, clock, tab id are all injected), directly usable in Node unit
 * tests; wiring in the page is in `stageGate.ts`.
 */

export const CRASH_LOG_KEY = "pc.online.crashLog";
export const CRASH_TAB_KEY = "pc.online.tab";
export const CRASH_LOG_VERSION = 1;
/** Window for determining "crashed": this load occurred within this duration since the last "still alive" (1 minute, user decision, 2026-10-07) */
export const CRASH_WINDOW_MS = 60_000;
/**
 * Interval for periodic "still alive" updates [ruling]. After a crash, a reload must happen within
 * `CRASH_WINDOW_MS - HEARTBEAT_MS` to be caught, so shorter is better; each write is a
 * `localStorage.setItem` (benchmarked on this PC at tens of microseconds for a ~2 KB record; see
 * "Numbers and rationale" in report), making once every 5 seconds negligible.
 */
export const HEARTBEAT_MS = 5_000;
/** How long without updates before another tab's section is treated as closed and cleared (does not affect crash determination, which only considers the last 1 minute) */
export const TAB_STALE_MS = 24 * 3600_000;
/** Maximum number of cards recorded in device-level "cards that crashed during testing" (FIFO) */
export const HEAVY_CARDS_MAX = 500;
/** Retains the last few determinations for the inspector */
export const HISTORY_MAX = 12;

export type StageLevel = 1 | 2 | 3;

/** Record left before taking each step: a stage gate step, asset gate loading original size, on-demand render gate testing a card, running at a given tier after completion */
export type CrashStep =
  | { kind: "stage"; what: "open-visible" | "visible-ready" | "try-back" | "dual-loaded" | "try-separate" | "separate-ready" }
  | { kind: "running"; level: StageLevel; lowest: boolean }
  | { kind: "media"; capLevel: number }
  | { kind: "measure"; key: string; cardId: string | null };

export interface TabRecord {
  /** Which load wrote this section (load timestamp) */
  startedAt: number;
  version: string;
  alive: number;
  left: boolean;
  background: boolean;
  step: CrashStep | null;
}

export interface DeviceRecord {
  /** Software version that wrote this device record; reset if different from current version (upgrade) */
  version: string;
  stage: {
    /** Tier reached during last use; when `lowest` is true, it is the lowest tier (one stage) */
    reached: StageLevel | null;
    lowest: boolean;
    /** Crash count (reset upon one successful step-up or software upgrade) */
    crashes: number;
    /** When the guard expires; null = no guard */
    guardUntil: number | null;
    /** Attempted a step-up during last use (counted as successful and reset if next load is not classified as crashed) */
    tried: boolean;
  };
  /** Asset gate: how many times loading original size caused a crash; decoding cap is lowered by this many tiers */
  media: { lowered: number };
  /** On-demand render gate: cards that crashed during testing (`identityKey`); baseline card crash recorded as `@benchmark` */
  heavyCards: string[];
}

export interface CrashLog {
  v: number;
  device: DeviceRecord;
  tabs: Record<string, TabRecord>;
  /** Determinations from recent loads (used by the inspector) */
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

/** Reads records; returns an empty record if unreadable, corrupted, or version mismatch (does not throw) */
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

/** Whether this section looks crashed (checks only itself: less than 1 minute ago, no clean exit, not in background) */
export function looksCrashed(tab: TabRecord | undefined, now: number): boolean {
  if (!tab) return false;
  return now - tab.alive < CRASH_WINDOW_MS && now >= tab.alive - 1000 && !tab.left && !tab.background;
}

export interface LoadJudgement {
  /** Classified as crashed */
  crashed: boolean;
  /** Which step crashed (null if not crashed) */
  step: CrashStep | null;
  /** Which tab's section provided the determination evidence */
  fromTab: string | null;
}

/**
 * Determines whether the previous session crashed on load. `tab` is this tab's id (present in
 * `sessionStorage` for a refresh or crash reload; absent for a newly opened tab, where `fresh` is
 * true); `alive` lists other tabs currently alive (queried via `BroadcastChannel`).
 * If its own section looks crashed, it is classified as crashed; a newly opened tab additionally
 * inspects sections left by other tabs that look crashed and did not respond, taking the most
 * recent one.
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

/** Sections from other tabs that look crashed and need to be pinged to see if they are still alive */
export function tabsToPing(log: CrashLog, tab: string, now: number): string[] {
  return Object.entries(log.tabs).filter(([id, t]) => id !== tab && looksCrashed(t, now)).map(([id]) => id);
}

/** Clears sections for tabs that have been closed for a long time */
export function pruneTabs(log: CrashLog, now: number, keep: string): CrashLog {
  const tabs: Record<string, TabRecord> = {};
  for (const [id, t] of Object.entries(log.tabs)) if (id === keep || now - t.alive < TAB_STALE_MS) tabs[id] = t;
  return { ...log, tabs };
}

/** A new tab section record (written on load: alive, not exited, foreground/background status recorded accurately) */
export function freshTab(now: number, version: string, background: boolean, step: CrashStep | null): TabRecord {
  return { startedAt: now, version, alive: now, left: false, background, step };
}

/** Adds a card that crashed during testing to the device record (deduplicated, FIFO) */
export function addHeavyCard(device: DeviceRecord, key: string): DeviceRecord {
  const list = device.heavyCards.filter((k) => k !== key);
  list.push(key);
  return { ...device, heavyCards: list.slice(-HEAVY_CARDS_MAX) };
}

/** New tab id (16 characters, only used to distinguish tabs, not a credential) */
export function newTabId(random: () => number = Math.random): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 16; i++) s += a[Math.floor(random() * a.length) % a.length];
  return s;
}
