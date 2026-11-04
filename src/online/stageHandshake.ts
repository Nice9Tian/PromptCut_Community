/**
 * Timing for the **initial handshake** of two cross-origin stages in online dual stage (C10
 * contract Section 2; semantics `mechanism/rendering.md` "Stage").
 *
 * Previous approach: as soon as the editor mounted the stages, it started a
 * `STAGE_HANDSHAKE_TIMEOUT_MS` (20 s) timer; if both stages had not shaken hands when time
 * expired, it fell back to same-origin single stage and never returned to dual stage within this
 * page session. Under slow networks (Alibaba Cloud, 2026-09-30: stage page main script 4.26 MB,
 * ~90-280 KB/s), downloading a single stage alone took 15-46 s; an undamaged stage was judged as a
 * handshake failure, leaving the page permanently stuck in single stage and unable to serve as a
 * pure browser node (`single-stage` in `browserNode.ts`).
 *
 * Current approach [ruling: 2026-09-30 `claude/stage-handshake`]:
 *
 * - **Each stage is timed individually, starting from that stage iframe's `load`**: `load` also
 *   fires cross-origin and only fires after the stage page's main script finishes executing
 *   (module scripts are deferred), while the stage sends `pc-stage-ready` in its mount effect,
 *   so there is inherently very little delay between "loaded" and "handshake". If
 *   `STAGE_HANDSHAKE_TIMEOUT_MS` elapses after load without a handshake = stage is truly broken,
 *   falling back as before. When the stage origin returns an error page (5xx) or fails to
 *   connect, the iframe also fires `load`, so both failure modes still fall back after ~20
 *   seconds, similar to before. Another `load` on the same stage (reload) restarts timing.
 * - **Total upper bound**: If `STAGE_HANDSHAKE_TOTAL_MS` elapses since opening (when this timer
 *   was created) without both stages shaking hands, fall back as well (fallback for "must never
 *   fail to show picture": cases where the stage page never fires `load` also have an end).
 * - **Interim same-origin single stage** ("must never fail to show picture"): If the visible stage
 *   (`ids[0]`, i.e. A) has not shaken hands after `STAGE_INTERIM_AFTER_MS` (20 s, same point in
 *   time as the original fallback) since opening, report `interim`: the caller displays picture
 *   with same-origin single stage first, while the original two cross-origin iframes are kept
 *   and turned into hidden prewarming iframes that continue loading (once downloaded, the main
 *   script enters HTTP cache; `/editor/assets/` is long-cached). Timing continues as before: the
 *   two prewarming stages still report `loaded` / `ready`; once both shake hands, report `ok`
 *   (caller switches back to dual stage, only once); if either stage fails to shake hands 20 s
 *   after load, or reaches the total upper bound, report `fail` (stay in single stage).
 * - Once both stages have shaken hands, this timer shuts down; subsequent disconnections are
 *   guarded by `stageWatch.ts` (numbers there remain unchanged).
 *
 * This module belongs to the render layer (`src/online/`): does not import editor, timers are
 * injectable (mock clocks for unit tests).
 */
import { STAGE_HANDSHAKE_TIMEOUT_MS, type StageLetter } from "./stageOrigins.ts";

/**
 * Total upper bound since opening to wait for both stages to shake hands [ruling]. Set to 2
 * minutes: under Alibaba Cloud's slowest tier (~90 KB/s), uncompressed stage page main scripts
 * take ~47 s sequentially for each of the two stages, and ~15 s each when compressed (1.33 MB),
 * both fitting within 2 minutes; under even slower networks, prioritize showing picture by falling
 * back to same-origin single stage.
 */
export const STAGE_HANDSHAKE_TOTAL_MS = 120_000;
/**
 * If the visible stage has not shaken hands after this long since opening, show picture with
 * same-origin single stage first (same point in time as the original single-stage fallback; blank
 * wait time is no longer than before).
 */
export const STAGE_INTERIM_AFTER_MS = 20_000;

type Timer = unknown;

export interface StageHandshakeDeps {
  ids: readonly StageLetter[];
  /** Handshake failed: falls back to same-origin single stage (`markStageHandshake("failed", reason)`) */
  fail(reason: string): void;
  /** Both stages completed handshake (`markStageHandshake("ok")`) */
  ok?(): void;
  /**
   * Visible stage (`ids[0]`) has not shaken hands by `interimMs`: show picture with same-origin
   * single stage first, convert two cross-origin stages to prewarm
   * (`markStageHandshake("interim")`). Omitted if not provided.
   */
  interim?(reason: string): void;
  /** Default `STAGE_INTERIM_AFTER_MS` */
  interimMs?: number;
  /** Handshake timeout for each stage starting from `load`, default `STAGE_HANDSHAKE_TIMEOUT_MS` */
  perStageMs?: number;
  /** Total upper bound since opening, default `STAGE_HANDSHAKE_TOTAL_MS` */
  totalMs?: number;
  now?(): number;
  setTimer?(fn: () => void, ms: number): Timer;
  clearTimer?(t: Timer): void;
}

export type StageHandshakePhase = "waiting" | "interim" | "ok" | "failed" | "disposed";

export interface StageHandshakeSlot {
  /** Timestamp of most recent `load` (relative to opening); null if never loaded */
  loadedAt: number | null;
  /** Timestamp of handshake (relative to opening); null if not shaken hands */
  readyAt: number | null;
  /** Number of times `load` was triggered */
  loads: number;
}

export interface StageHandshake {
  /** This stage iframe triggered `load` (new document loaded): starts / restarts its handshake timeout */
  loaded(id: StageLetter): void;
  /** This stage completed handshake (`pc-stage-ready`) */
  ready(id: StageLetter): void;
  readonly phase: StageHandshakePhase;
  /** Diagnostics */
  status(): { phase: StageHandshakePhase; elapsedMs: number; interimAt: number | null; slots: Record<string, StageHandshakeSlot>; reason: string | null };
  dispose(): void;
}

export function createStageHandshake(deps: StageHandshakeDeps): StageHandshake {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: Timer) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const perStageMs = deps.perStageMs ?? STAGE_HANDSHAKE_TIMEOUT_MS;
  const totalMs = deps.totalMs ?? STAGE_HANDSHAKE_TOTAL_MS;
  const t0 = now();
  let phase: StageHandshakePhase = "waiting";
  let reason: string | null = null;
  let interimAt: number | null = null;
  const interimMs = deps.interimMs ?? STAGE_INTERIM_AFTER_MS;
  const front = deps.ids[0];
  const live = () => phase === "waiting" || phase === "interim";
  const slots = new Map<StageLetter, StageHandshakeSlot & { deadline: Timer | null }>();
  for (const id of deps.ids) slots.set(id, { loadedAt: null, readyAt: null, loads: 0, deadline: null });

  const clearAll = () => {
    clearTimer(total);
    if (interimTimer !== null) clearTimer(interimTimer);
    for (const s of slots.values()) if (s.deadline !== null) { clearTimer(s.deadline); s.deadline = null; }
  };
  const summary = () => {
    const got = deps.ids.filter((id) => slots.get(id)!.readyAt !== null);
    const loaded = deps.ids.filter((id) => slots.get(id)!.loadedAt !== null);
    return `Stages handshaken: ${got.join(", ") || "none"}; stages loaded: ${loaded.join(", ") || "none"}`;
  };
  const failWith = (why: string) => {
    if (!live()) return;
    phase = "failed";
    reason = `${why} (${summary()})`;
    clearAll();
    deps.fail(reason);
  };

  const total: Timer = setTimer(() => failWith(`Both stages did not complete the handshake within ${Math.round(totalMs / 1000)} s of opening`), totalMs);
  const interimTimer: Timer | null = deps.interim ? setTimer(() => {
    if (phase !== "waiting" || slots.get(front)!.readyAt !== null) return;
    phase = "interim";
    interimAt = now() - t0;
    deps.interim!(`Visible stage ${front} did not complete the handshake ${Math.round(interimMs / 1000)} s after attaching; showing output from a same-origin single stage for now and warming up both stage origins (${summary()})`);
  }, interimMs) : null;

  return {
    loaded(id) {
      const s = slots.get(id);
      if (!s || !live() || s.readyAt !== null) return;
      s.loads++;
      s.loadedAt = now() - t0;
      if (s.deadline !== null) clearTimer(s.deadline);
      s.deadline = setTimer(() => {
        s.deadline = null;
        if (s.readyAt === null) failWith(`Stage ${id} did not complete the handshake ${Math.round(perStageMs / 1000)} s after loading`);
      }, perStageMs);
    },
    ready(id) {
      const s = slots.get(id);
      if (!s || !live()) return;
      if (s.readyAt === null) s.readyAt = now() - t0;
      if (s.deadline !== null) { clearTimer(s.deadline); s.deadline = null; }
      if (deps.ids.every((x) => slots.get(x)!.readyAt !== null)) {
        phase = "ok";
        clearAll();
        deps.ok?.();
      }
    },
    get phase() { return phase; },
    status() {
      const out: Record<string, StageHandshakeSlot> = {};
      for (const [id, s] of slots) out[id] = { loadedAt: s.loadedAt, readyAt: s.readyAt, loads: s.loads };
      return { phase, elapsedMs: now() - t0, interimAt, slots: out, reason };
    },
    dispose() {
      if (live()) phase = "disposed";
      clearAll();
    },
  };
}
