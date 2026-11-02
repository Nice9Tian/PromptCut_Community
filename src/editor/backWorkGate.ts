/**
 * The background stage's background work is judged idle by the editor page, and start / stop are sent over RPC (C10 contract section 2 "Placement and pacing of the background stage" [ruling: probe P2]).
 *
 * The background stage is stacked in place with `opacity: 0`: its own `requestIdleCallback` mostly fires only at timeout (advancing just 1-4.7 frames per second), so it cannot be used for pacing;
 * the browser does not stop it for you when the page is hidden either (a headless tab switch still gives 1.2-2 frames per second, a headed minimize still 24-27 frames). So the parent page (opaque, rAF and rIC normal) decides:
 *
 *   on ⇔ page visible ∧ the parent's rAF gap has not stayed above `RAF_GAP_PAUSE_MS` ∧ the parent's own `requestIdleCallback` has fired within `IDLE_STALE_MS`
 *
 * When the decision changes, call `back.setBackWork(on)`; also resend once when the background stage changes hands (K5 swap, iframe reload). Inside the stage, frames advance one by one with `setTimeout(0)`,
 * and this flag is checked between frames (`backGate` in `StageView.tsx`).
 *
 * Only enabled on the dual stage of the online dual stage (`Preview.tsx`); the desktop runtime stays as is and does not send this RPC.
 */
import type { StageRpcClient } from "../render/stageRpc";

/** If the parent page's rAF gap stays above this long, pause background work (C10 contract section 2) */
export const RAF_GAP_PAUSE_MS = 500;
/** If the parent page's rIC has not fired for this long, treat the parent page as not idle */
export const IDLE_STALE_MS = 1000;
/** How often to decide (when the page is hidden rAF stops, and this timer is how that gets noticed) */
export const BACK_WORK_CHECK_MS = 200;

export interface BackWorkInput {
  visible: boolean;
  now: number;
  lastRafAt: number;
  lastIdleAt: number;
}

/** Pure decision: whether to turn on, and the reason when not */
export function judgeBackWork({ visible, now, lastRafAt, lastIdleAt }: BackWorkInput): { on: boolean; reason: "hidden" | "raf-gap" | "busy" | null } {
  if (!visible) return { on: false, reason: "hidden" };
  if (now - lastRafAt > RAF_GAP_PAUSE_MS) return { on: false, reason: "raf-gap" };
  if (now - lastIdleAt > IDLE_STALE_MS) return { on: false, reason: "busy" };
  return { on: true, reason: null };
}

export interface BackWorkGateDeps {
  /** The current background stage (the back of the dual stage); null if there is none */
  back: () => StageRpcClient | null;
  now?: () => number;
  visible?: () => boolean;
}

export interface BackWorkDiag {
  on: boolean;
  reason: string | null;
  /** How many times the decision changed */
  changes: number;
  /** How many times setBackWork was sent */
  sent: number;
  /** How many times paused, and how many for each reason */
  pauses: Record<string, number>;
}

let diag: BackWorkDiag = { on: true, reason: null, changes: 0, sent: 0, pauses: {} };

export function backWorkDiag(): BackWorkDiag {
  return { ...diag, pauses: { ...diag.pauses } };
}

/** Start deciding; returns a stop function (on stop, sends one "on" to the background stage, handing it back to the default state) */
export function startBackWorkGate(deps: BackWorkGateDeps): () => void {
  const now = deps.now ?? (() => performance.now());
  const visible = deps.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  let lastRafAt = now();
  let lastIdleAt = now();
  let stopped = false;
  let current = true;
  let sentTo: StageRpcClient | null = null;
  let sentOn: boolean | null = null;
  diag = { on: true, reason: null, changes: 0, sent: 0, pauses: {} };

  let raf = 0;
  const onRaf = () => { lastRafAt = now(); if (!stopped) raf = requestAnimationFrame(onRaf); };
  raf = requestAnimationFrame(onRaf);

  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const cic = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
  let idleId = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const onIdle = () => {
    lastIdleAt = now();
    if (stopped) return;
    // Asking every 100 ms is enough: queueing rIC back to back would keep occupying the idle period
    idleTimer = setTimeout(() => { idleTimer = null; if (!stopped) scheduleIdle(); }, 100);
  };
  const scheduleIdle = () => {
    if (typeof ric === "function") idleId = ric(onIdle, { timeout: 2000 });
    else idleTimer = setTimeout(onIdle, 50);
  };
  scheduleIdle();

  const push = () => {
    const back = deps.back();
    if (!back || back.disposed) { sentTo = null; sentOn = null; return; }
    if (back === sentTo && sentOn === current) return;
    sentTo = back;
    sentOn = current;
    diag.sent++;
    void back.setBackWork(current).catch(() => { sentTo = null; sentOn = null; });
  };

  const check = () => {
    if (stopped) return;
    const j = judgeBackWork({ visible: visible(), now: now(), lastRafAt, lastIdleAt });
    if (j.on !== current) {
      current = j.on;
      diag.changes++;
      if (!j.on && j.reason) diag.pauses[j.reason] = (diag.pauses[j.reason] ?? 0) + 1;
    }
    diag.on = current;
    diag.reason = j.reason;
    push();
  };
  const timer = setInterval(check, BACK_WORK_CHECK_MS);
  const onVisibility = () => {
    // Back to the foreground: rAF has just resumed, so pretend it has just fired once, otherwise "no rAF while hidden" would be judged as an overlong gap and cost one extra paused round
    if (visible()) { lastRafAt = now(); lastIdleAt = now(); }
    check();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  check();

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    clearInterval(timer);
    if (idleTimer) clearTimeout(idleTimer);
    if (idleId && typeof cic === "function") cic(idleId);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    const back = deps.back();
    if (back && !back.disposed && sentOn === false) void back.setBackWork(true).catch(() => {});
  };
}
