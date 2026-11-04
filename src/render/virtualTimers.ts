/**
 * `setTimeout` / `setInterval` registered on the virtual clock (E4b).
 *
 * The stage takes over all four timing mechanisms: `performance.now` / `requestAnimationFrame` are
 * in `stageClock.ts`, `Date.now()` / parameterless `new Date()` are in `kernel/pinEntropy.ts`, and
 * this manages the remaining two. Cards using `setInterval` for a typewriter advancing every 100 ms
 * or `setTimeout` to schedule the next animation step must follow the stage's tick under virtual
 * time: otherwise the probe measures a card running wildly against the wall clock, and catch-up
 * run state will not match export.
 *
 * This does not touch `window` and only does bookkeeping: **when to settle is decided by the clock**
 * (`stageClock`'s `tick` calls `settle(now)` once per tick), so it can be unit-tested outside the
 * browser.
 *
 * # Two rules
 *
 *  1. **No settling on jumps** (`clock.set` clock adjustments, `maxCatchUp` trimming start point):
 *     call `shift(delta)` to shift the due time of each pending timer as a whole, preserving
 *     remaining time: equivalent to the clock stopping during that skipped duration. Otherwise,
 *     a large jump by `setTime` would run hundreds of `setInterval` callbacks all at once.
 *  2. **Separate ID space from real timers**: virtual IDs start at `VIRTUAL_TIMER_BASE`. The stage's
 *     own wall-clock timers (RPC timeouts, `.pc-awaiting` 500 ms fallback, media layer) go through
 *     `__pcRealSetTimeout` and receive real IDs, while clearing calls the intercepted
 *     `clearTimeout`: this boundary keeps the two separated.
 */

/** Starting point of virtual timer IDs. Anything smaller is always a real timer ID */
export const VIRTUAL_TIMER_BASE = 1_000_000_000;

/**
 * Maximum callbacks triggered in a single settle. Prevents self-feeding loops like "registering
 * another 0 ms timer inside a callback"
 */
export const MAX_FIRES_PER_SETTLE = 10_000;

interface VirtualTimer {
  id: number;
  cb: (...args: unknown[]) => void;
  args: unknown[];
  /** Due virtual milliseconds */
  due: number;
  /** null = one-shot; otherwise repeat interval */
  interval: number | null;
  /** Registration sequence number: orders timers with the same `due` */
  seq: number;
}

export interface VirtualTimers {
  /**
   * Register one. `repeat` = `setInterval`. Returns 0 and does not register if handler is not a
   * function (string eval flavor)
   */
  set(handler: unknown, ms: unknown, args: unknown[], repeat: boolean, now: number): number;
  /** Remove. Returns `false` if this is not a virtual ID: caller should forward it to the real one */
  clear(id: unknown): boolean;
  /** Settle timers due up to `now`, returning how many times they triggered */
  settle(now: number): number;
  /** Jump: shifts due time of each pending timer by `delta`, preserving remaining time */
  shift(delta: number): void;
  /** How many are currently pending */
  size(): number;
}

export function createVirtualTimers(): VirtualTimers {
  const timers = new Map<number, VirtualTimer>();
  let nextId = VIRTUAL_TIMER_BASE;
  let seq = 0;

  return {
    set(handler, ms, args, repeat, now) {
      if (typeof handler !== "function") return 0;
      const delay = Math.max(0, Number(ms) || 0);
      const id = nextId++;
      timers.set(id, {
        id,
        cb: handler as (...a: unknown[]) => void,
        args,
        due: now + delay,
        interval: repeat ? delay : null,
        seq: seq++,
      });
      return id;
    },
    clear(id) {
      if (typeof id !== "number" || id < VIRTUAL_TIMER_BASE) return false;
      timers.delete(id);
      return true;
    },
    settle(now) {
      /*
       * One-shot timers newly registered **after** this settle starts are pushed to the next tick
       * (`seq >= limit`), even if already due: otherwise self-feeding loops like `setTimeout(loop, 0)`
       * would run infinitely in a single tick. `setInterval` re-queuing reuses its original `seq`,
       * so it can still catch up in the same tick (when a tick spans multiple periods).
       */
      const limit = seq;
      let fired = 0;
      while (fired < MAX_FIRES_PER_SETTLE) {
        let best: VirtualTimer | null = null;
        for (const t of timers.values()) {
          if (t.due > now || t.seq >= limit) continue;
          if (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t;
        }
        if (!best) return fired;
        if (best.interval === null) timers.delete(best.id);
        // An interval of 0 makes "catch-up" an infinite loop; treat as 1 ms per browser convention
        else best.due += Math.max(1, best.interval);
        fired++;
        try {
          best.cb(...best.args);
        } catch (err) {
          console.error("[stageClock] timer callback threw an error", err);
        }
      }
      console.warn("[stageClock] timer fire count hit the limit within one tick, the rest is pushed to the next tick");
      return fired;
    },
    shift(delta) {
      if (!delta) return;
      for (const t of timers.values()) t.due += delta;
    },
    size: () => timers.size,
  };
}
