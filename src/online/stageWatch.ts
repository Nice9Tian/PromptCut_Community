/**
 * Watch after handshake between both stages in online dual stage mode (C10 contract section 2
 * "Disconnect after handshake" [ruling], 2026-09-30).
 *
 * Only falls back to same-origin single stage (`stageOrigins.ts`) if initial handshake fails
 * within `STAGE_HANDSHAKE_TIMEOUT_MS`. Previously unhandled if one stage freezes or crashes after
 * handshaking (cross-origin iframe render process crashed, parent page receives no events, and
 * `contentWindow` does not close): as soon as visible stage disconnects, preview stays blank
 * or stuck on stale frame forever. This is addressed here:
 *
 * - **Heartbeat**: query each handshaked stage once every `STAGE_PING_INTERVAL_MS` (caller provides
 *   `ping`, Preview uses cheapest `size()` RPC); if there is no response within
 *   `STAGE_LOST_AFTER_MS`, consider that stage disconnected. Do not evaluate when page is hidden
 *   (timers and stages are throttled in background tabs); do not evaluate on a tick where parent
 *   page's own timer arrives very late (parent page main thread blocked), only restarting the timing.
 * - **Reload that stage first**: same approach as original "reload that stage's entire page if
 *   card code failed to swap" (caller provides `reload`).
 * - **Fall back to single stage if reload still fails to re-handshake**: if `pc-stage-ready` from
 *   that stage is not received within `STAGE_RECONNECT_TIMEOUT_MS` (20 seconds, same as initial
 *   handshake) after reload, or if `STAGE_MAX_RELOADS` reloads have already occurred within
 *   `STAGE_RELOAD_WINDOW_MS` (repeated disconnections), caller's `fallback` takes same fallback
 *   path as when initial handshake fails (`markStageHandshake("failed")`). After fallback, this
 *   watcher is invalidated and will no longer reload any stage.
 *
 * All numbers are parameters of the three-tier mechanism. This module belongs to render layer:
 * no editor imports, clock and timers are injectable (unit tests use fake timers).
 */
import { STAGE_HANDSHAKE_TIMEOUT_MS, type StageLetter } from "./stageOrigins.ts";

/** Heartbeat interval */
export const STAGE_PING_INTERVAL_MS = 5000;
/** Considered disconnected if no response for this long (three heartbeat ticks; a synchronous catch-up run in the stage cannot take this long) */
export const STAGE_LOST_AFTER_MS = 15_000;
/** Time limit to wait for that stage to re-handshake after reload: same as initial handshake */
export const STAGE_RECONNECT_TIMEOUT_MS = STAGE_HANDSHAKE_TIMEOUT_MS;
/** If parent page's heartbeat timer arrives later than this, consider parent page itself blocked and skip evaluating this tick */
export const STAGE_TICK_LATE_MS = STAGE_PING_INTERVAL_MS * 2;
/** Repeated disconnections: if another reload is needed after reaching `STAGE_MAX_RELOADS` reloads within this window, directly fall back to single stage */
export const STAGE_MAX_RELOADS = 3;
export const STAGE_RELOAD_WINDOW_MS = 10 * 60_000;

type Timer = unknown;

export interface StageWatchDeps {
  ids: readonly StageLetter[];
  /** Check once whether this stage is still alive: returns Promise (fulfilled = alive; rejected or never responds = no response); returns null = no client at the moment */
  ping(id: StageLetter): Promise<unknown> | null;
  /** Reload this stage (original approach: discard its RPC client, `frame.src = frame.src`) */
  reload(id: StageLetter, reason: string): void;
  /** Fall back to same-origin single stage (same path as initial handshake failure) */
  fallback(reason: string): void;
  /** Page is hidden (do not evaluate) */
  hidden?(): boolean;
  now?(): number;
  setTimer?(fn: () => void, ms: number): Timer;
  clearTimer?(t: Timer): void;
  /** Diagnostics */
  log?(msg: string): void;
}

export type StageWatchStatus = "pending" | "alive" | "reloading";

export interface StageWatch {
  /** Handshake succeeded for this stage (`pc-stage-ready`): start / resume watch */
  ready(id: StageLetter): void;
  /** Externally determined that this stage disconnected (e.g. caller has other evidence): same handling as heartbeat timeout */
  lost(id: StageLetter, reason: string): void;
  /** Whether fallback has occurred */
  readonly fellBack: boolean;
  status(id: StageLetter): StageWatchStatus;
  /** How many times reloaded (diagnostics and testing) */
  readonly reloads: number;
  dispose(): void;
}

interface Slot {
  status: StageWatchStatus;
  lastAlive: number;
  inflight: boolean;
  /** Advance generation on each ready / reload; heartbeat responses from older generations are ignored */
  gen: number;
  deadline: Timer | null;
}

export function createStageWatch(deps: StageWatchDeps): StageWatch {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: Timer) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const hidden = deps.hidden ?? (() => false);
  const log = deps.log ?? (() => {});
  const slots = new Map<StageLetter, Slot>();
  for (const id of deps.ids) slots.set(id, { status: "pending", lastAlive: now(), inflight: false, gen: 0, deadline: null });
  const reloadTimes: number[] = [];
  let reloads = 0;
  let disposed = false;
  let fellBack = false;
  let tickTimer: Timer | null = null;
  let lastTick = now();

  const stopAll = () => {
    disposed = true;
    if (tickTimer !== null) { clearTimer(tickTimer); tickTimer = null; }
    for (const s of slots.values()) if (s.deadline !== null) { clearTimer(s.deadline); s.deadline = null; }
  };

  const fallback = (reason: string) => {
    if (disposed) return;
    fellBack = true;
    stopAll();
    log(`Falling back to a single stage: ${reason}`);
    try { deps.fallback(reason); } catch { /* Do not retry even if caller failed */ }
  };

  const armDeadline = (id: StageLetter, s: Slot) => {
    const gen = s.gen;
    s.deadline = setTimer(() => {
      s.deadline = null;
      if (disposed || s.status !== "reloading" || s.gen !== gen) return;
      // Do not evaluate while page is hidden: iframe loading and stage startup may both be throttled; grant a full time window when returning to foreground
      if (hidden()) { armDeadline(id, s); return; }
      fallback(`Stage ${id} reloaded after disconnecting and did not reconnect within ${Math.round(STAGE_RECONNECT_TIMEOUT_MS / 1000)} s`);
    }, STAGE_RECONNECT_TIMEOUT_MS);
  };

  const lost = (id: StageLetter, reason: string) => {
    if (disposed) return;
    const s = slots.get(id);
    if (!s || s.status !== "alive") return;
    const t = now();
    while (reloadTimes.length && t - reloadTimes[0] > STAGE_RELOAD_WINDOW_MS) reloadTimes.shift();
    if (reloadTimes.length >= STAGE_MAX_RELOADS) {
      fallback(`Stage ${id} keeps disconnecting (reloaded ${reloadTimes.length} times within ${Math.round(STAGE_RELOAD_WINDOW_MS / 60_000)} min): ${reason}`);
      return;
    }
    reloadTimes.push(t);
    reloads++;
    s.status = "reloading";
    s.gen++;
    s.inflight = false;
    log(`Stage ${id} disconnected, reloading it: ${reason}`);
    try { deps.reload(id, reason); } catch { /* Still wait for timeout if reload fails, fall back when time is up */ }
    armDeadline(id, s);
  };

  const tick = () => {
    tickTimer = null;
    if (disposed) return;
    const t = now();
    const late = t - lastTick > STAGE_TICK_LATE_MS;
    lastTick = t;
    if (hidden() || late) {
      // Skip evaluation: restart timing to avoid treating an alive stage as disconnected on the tick when returning to foreground / parent page recovers
      for (const s of slots.values()) if (s.status === "alive") s.lastAlive = t;
    } else {
      for (const [id, s] of slots) {
        if (s.status !== "alive") continue;
        if (t - s.lastAlive > STAGE_LOST_AFTER_MS) { lost(id, `No heartbeat reply for ${Math.round((t - s.lastAlive) / 1000)} s`); continue; }
        if (s.inflight) continue;
        let p: Promise<unknown> | null = null;
        try { p = deps.ping(id); } catch { p = null; }
        if (!p) continue;
        s.inflight = true;
        const gen = s.gen;
        p.then(() => {
          if (s.gen !== gen) return;
          s.inflight = false;
          s.lastAlive = now();
        }, () => {
          if (s.gen !== gen) return;
          s.inflight = false;
        });
      }
    }
    if (!disposed) tickTimer = setTimer(tick, STAGE_PING_INTERVAL_MS);
  };
  tickTimer = setTimer(tick, STAGE_PING_INTERVAL_MS);

  return {
    ready(id) {
      if (disposed) return;
      const s = slots.get(id);
      if (!s) return;
      if (s.deadline !== null) { clearTimer(s.deadline); s.deadline = null; }
      if (s.status === "reloading") log(`Stage ${id} reconnected after reload`);
      s.status = "alive";
      s.gen++;
      s.inflight = false;
      s.lastAlive = now();
    },
    lost,
    get fellBack() { return fellBack; },
    get reloads() { return reloads; },
    status(id) { return slots.get(id)?.status ?? "pending"; },
    dispose() { stopAll(); },
  };
}
