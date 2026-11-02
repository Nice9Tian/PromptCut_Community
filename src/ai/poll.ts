/**
 * A small utility for background polling in the page (chat list, deletion notices, resuming a
 * half-finished deletion). No React; there are Node unit tests (`poll.test.mjs`).
 *
 * Rules (review, 2026-10-13):
 *   - Only one in flight at a time: if the previous one has not come back, the next is not sent;
 *   - Backoff on failure: each consecutive failure doubles the delay, capped at `maxMs`; success
 *     returns to `baseMs`;
 *   - Stop when the login expires (`run` returns `"stop"`), and do not come back;
 *   - When the page is not visible, the next one is not scheduled; when it becomes visible again
 *     (`kick()`), run one immediately and then continue scheduling.
 */
export interface Poller {
  start(): void;
  stop(): void;
  /**
   * Run once immediately (when back in the foreground, or when someone in the page touched a chat);
   * does nothing if one is in flight or it has stopped
   */
  kick(): void;
  describe(): { running: boolean; inflight: boolean; failures: number; nextDelayMs: number; stopped: boolean };
}

export function createPoller(o: {
  /** Returning `"stop"` means no need to come back (login expired); a throw counts as failure, back off */
  run: () => Promise<"stop" | void>;
  baseMs: number;
  maxMs?: number;
  visible?: () => boolean;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}): Poller {
  const maxMs = o.maxMs ?? 60_000;
  const visible = o.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
  const schedule = o.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = o.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let started = false, stopped = false, inflight = false, failures = 0;
  const delay = () => Math.min(maxMs, o.baseMs * 2 ** Math.min(failures, 16));

  function arm() {
    if (!started || stopped || inflight || timer !== null || !visible()) return;
    timer = schedule(() => { timer = null; void tick(); }, delay());
  }
  async function tick() {
    if (!started || stopped || inflight) return;
    if (!visible()) return; // Not visible: do not schedule the next one; deal with it when kick() comes back
    inflight = true;
    try {
      const out = await o.run();
      if (out === "stop") { stopped = true; return; }
      failures = 0;
    } catch {
      failures += 1;
    } finally {
      inflight = false;
    }
    arm();
  }
  return {
    start() { if (started) return; started = true; stopped = false; void tick(); },
    stop() { stopped = true; started = false; if (timer !== null) { cancel(timer); timer = null; } },
    kick() { if (!started || stopped || inflight) return; if (timer !== null) { cancel(timer); timer = null; } void tick(); },
    describe: () => ({ running: started && !stopped, inflight, failures, nextDelayMs: delay(), stopped }),
  };
}
