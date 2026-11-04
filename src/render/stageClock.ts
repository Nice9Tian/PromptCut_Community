/**
 * Driven clock (dedicated to render surface ?stage=1).
 *
 * The preview window should not "play on its own by wall-clock time": it needs to display that
 * frame at timeline t. So time is taken over in this standalone document of the render surface:
 * performance.now() reads the value we supply, and requestAnimationFrame is no longer triggered
 * by the browser, but queued and run explicitly by tick(). Both Motion's frame loop and cards' own
 * rAF loops read these two, so "which frame it is now" is entirely up to us.
 *
 * Same idea as the export kernel (kernel/exportClock.ts): time there is driven by CDP virtual time,
 * while time here is driven by t dispatched from the editor. Card code is identical on both sides,
 * so what you see in preview = what you get in export.
 *
 * But taking over performance.now and rAF alone is not enough. The page also has a third clock:
 * document.timeline.currentTime (WAAPI's own, real time, never resets to zero). When Motion creates
 * WAAPI animations, it writes startTime as the taken-over performance.now (stage time, starting
 * from 0), but WAAPI interprets it according to the third clock: thus as soon as an animation is
 * born, currentTime is "how long the page has already been open", jumping past endTime straight
 * to finished. pinAnimations then according to contract skips finished, causing all entrance
 * animations in preview to jump directly to their final state. Testing showed dragging to t=0.1s:
 * 20 animations on the export page paused at 100ms, while all 20 on the preview page were finished.
 * exportClock's patchAnimate cures this, and must also be installed here.
 *
 * Can only be installed in the render surface iframe. Installing it on the editor's main document
 * would freeze the editor's own UI animations as well.
 *
 * # Four timing mechanisms (E4b)
 *
 * Taking over performance.now / rAF alone is not enough: cards can also keep time using `setTimeout` /
 * `setInterval` (typewriters, numbers advanced by intervals). Under virtual time they run erratically
 * against wall clock time: probes measure a card that follows real time, and the state produced by
 * catch-up runs does not match export. So here the four functions are replaced with fake timers
 * registered on the virtual clock: when `tick` advances `now`, they fire in order of expiration
 * (in order of registration within the same `now`), with every step settled by `advanceTo` /
 * `advanceToAsync`.
 *
 * **Jumps via `set(ms)` and clamping the start with `maxCatchUp` do not settle**: timers within
 * the skipped time range do not fire, and the remaining time of each pending timer is maintained
 * (equivalent to the clock pausing during jumps), so `setTime` does not run hundreds of
 * `setInterval` callbacks all at once. Cards that accumulate state via timers are inherently
 * `vtOk = false`; their correct state is obtained by step-by-step catch-up runs (settling at each step)
 * on the background stage, while visible stage jumps only seek to avoid lag.
 *
 * **The stage's own wall-clock timers always use real ones**: RPC timeouts, `pause({ atSec })` arming
 * timeouts, `mediaReady` 300 ms, `.pc-awaiting` 500 ms fallback (virtual clock does not advance in
 * paused state; using virtual timers they would never fire, leaving cards permanently invisible),
 * and the asset layer. The entry points are `__pcRealSetTimeout` / `__pcRealSetInterval`; virtual
 * timer ids start from `1e9`, so `clearTimeout(realId)` still hits the real one.
 *
 * The fourth item (`Date.now()` / parameterless `new Date()`) is **not in this file**:
 * `kernel/pinEntropy.ts` already pins it to "fixed epoch + current frame milliseconds", and it reads
 * this exact clock (`__pcStageClock.now()`), shared with the export page. This file is only
 * responsible for saving the real one into `__pcRealDateNow` before taking over.
 */
import { patchAnimate } from "../kernel/exportClock";
import { createVirtualTimers } from "./virtualTimers";

export interface StageClock {
  now(): number;
  /** Directly sets the clock to a specific millisecond without running frames (used to set the time origin before remounting) */
  set(ms: number): void;
  /**
   * Run a frame: dial clock to ms and execute queued rAF callbacks for this frame. **Returns the
   * number of callbacks run.**
   *
   * This count is the criterion for "whether any card moved on its own during this frame": both
   * cards' own loops and Motion's frame loop rely on rAF; if there are none, it means no one will
   * modify their state on this frame. Callers use it to decide whether to commit React: when
   * catching up hundreds of frames, nothing happens on most frames, so there is no need to render
   * every single frame.
   */
  tick(ms: number): number;
  /**
   * How many virtual timers are currently pending (for unit tests / probes: whether `clearInterval`
   * actually removed it).
   */
  pendingTimers(): number;
  /**
   * Advance from current time to target, running frames in steps.
   * Must run in steps: Motion's frame loop clamps single-frame delta to a 40ms ceiling (preventing
   * jumps when switching back to the tab); if a step spans several seconds, the animation only
   * advances 40ms.
   *
   * **Each step lands on the frame grid, with timestamps calculated directly from frame numbers
   * rather than incrementally accumulated** (see `frameGrid`): no matter which frame you advance
   * from, the timestamp of frame k is always the same number. When the starting point is not on the
   * frame grid (dialed via `set`, trimmed by `maxCatchUp`), the first step moves to the next grid
   * point; when `target` is not on the frame grid, the last step moves to `target`.
   * `fps`: project frame rate; if provided, arrange the frame grid by it; if omitted, inferred from `step`.
   */
  advanceTo(target: number, opts?: { step?: number; fps?: number; maxCatchUp?: number; onFrame?: (ms: number, ran: number) => void }): void;
  /**
   * Performs catch-up run just like `advanceTo`, but **yields a microtask between each frame**.
   *
   * Why this is needed: frames produced by synchronous catch-up runs differ from "pushing frame
   * by frame", and exports always do the latter. In actual tests on the same preview page at the
   * same t=1.8s, jumping versus pushing frame by frame results in a difference of 129,000 pixels
   * for particles and 22,000 pixels for word-rotate: the differences stem from things that
   * **cannot cross synchronous blocks**: Motion parsing keyframes, AnimatePresence swapping
   * components, and particle engine asynchronous loading, all of which require a task boundary
   * to advance.
   *
   * Yielding microtasks rather than real frames: microtasks drain within the same task without
   * waiting for vsync, taking only tens of milliseconds for hundreds of frames; waiting for real
   * frames to skip 6 seconds would mean waiting for 180 vsyncs = 3 seconds, which is unusable.
   *
   * `abort` allows a new render to abort the previous in-flight catch-up run (which occurs when
   * scrubbing the playhead rapidly).
   */
  advanceToAsync(target: number, opts?: {
    step?: number;
    /** Project frame rate. If provided, arrange frame grid by it; if not, infer from `step` (see `frameGrid`). */
    fps?: number;
    maxCatchUp?: number;
    /** Called **before running this frame**: commit React. Same order as export step: it also calls __pcSetT first, then advances virtual time */
    onFrame?: (ms: number) => void;
    /**
     * Called after running rAF callbacks for this frame: pin animations (animations newly created
     * in this frame can only be retrieved at this point).
     * **If it returns a Promise, await it** (R9 M3: each frame of probe snapshot generation must
     * wait for GL Worker's `done`); if returning `void`, do not yield an extra microtask.
     */
    afterFrame?: (ms: number) => void | Promise<void>;
    abort?: () => boolean;
    /**
     * Yields a **macrotask** (a real `setTimeout 0`), not just a microtask, every this many frames
     * pushed. Used by background stage probes (K1): when a card pushes hundreds of frames, the main
     * thread cannot remain occupied continuously; RPC messages from the parent page and the iframe's
     * own resize must have a chance to come in. Default does not yield (only yields microtasks).
     */
    yieldEvery?: number;
    /**
     * "Stop flag" checked once between frames (Section 2 of C10 contract: background jobs are
     * started / stopped by editor page via RPC). If it returns a Promise, wait for it to settle
     * (while stopped, neither push nor discard; once resumed, continue pushing); if returning `void`,
     * push as usual. Only called between frames; does not change any pushed frames. None by default.
     */
    gate?: () => void | Promise<void>;
  }): Promise<void>;
}

const DEFAULT_STEP = 1000 / 60;

/**
 * Frame grid for pushing frames: timestamp of the k-th frame, and which frame the next step
 * should advance to starting from a given timestamp.
 *
 * **Timestamps are calculated directly from frame numbers, not accumulated frame by frame.** At
 * 30 fps, one step is 33.333… ms, which is not an exactly representable number; timestamps
 * accumulated frame by frame differ in the last few digits from direct calculation: pushing from
 * the start to frame 60 yields 1999.9999999999982, whereas the target computed by the caller
 * using "(frame number / fps) * 1000" is 2000. When cards judge "whether reached" by timestamp
 * (a card changing a word every whole second takes the integer part of "elapsed ms / 1000"), it
 * falls one frame late; when pushing one step forward from the previous frame, "previous frame
 * timestamp + step" is sometimes smaller than the target by the last digit, requiring an extra
 * tick in this frame. For actual measurements and breakdown, see
 * `docs/reports/AGENT-rr-a1-verify.md` "Reason 2".
 *
 *   - When the frame rate is known, frame k = `k / fps * 1000`. This is the same formula and same
 *     operation order as the caller calculating the target timestamp (`frame / fps` to get
 *     seconds, then `* 1000`), with bit-for-bit identical landing values. Writing it another way
 *     (such as `k * step`) may still produce a different last digit. The frame rate is supplied by
 *     the caller (`fps`); when omitted, it is inferred from step: if step matches exactly one frame
 *     of an integer frame rate (`1000 / fps`, which callers always provide), it is recognized.
 *   - For steps where the frame rate cannot be recognized, use `k * step`: likewise without
 *     accumulation, except bit-for-bit equality with caller target is not guaranteed (the final
 *     step still advances directly to the target itself as usual).
 *
 * `after(ms)`: The first frame number strictly later than `ms`. When `ms` itself sits on the frame
 * grid or differs only by a floating-point mantissa (within one-millionth of a frame), it counts as
 * this frame, and the next step advances to the frame after it: do not run an extra tick for a
 * trailing fraction. `reaches(k, target)`: Whether frame k has reached `target` (with the same
 * tolerance); once reached, the caller steps directly to `target` itself.
 */
export function frameGrid(step: number, fps?: number): { at(k: number): number; after(ms: number): number; reaches(k: number, target: number): boolean } {
  const perSec = 1000 / step;
  const rounded = Math.round(perSec);
  // Use the frame rate supplied by caller only if it matches step (if mismatched, follow step; do not guess)
  const rate = fps && Math.abs(perSec - fps) < 1e-9 * fps ? fps : rounded >= 1 && Math.abs(perSec - rounded) < 1e-9 * rounded ? rounded : 0;
  const at = rate ? (k: number) => (k / rate) * 1000 : (k: number) => k * step;
  const slack = step * 1e-6;
  return {
    at,
    after: (ms) => Math.floor((ms + slack) / step) + 1,
    reaches: (k, target) => at(k) >= target - slack,
  };
}
/** Catch-up run ceiling (ms): if lagging by more than this, advance clock directly to target - ceiling first, then step through this final section */
const DEFAULT_MAX_CATCH_UP = 6000;

export function installStageClock(): StageClock {
  const w = window as Window & { __pcStageClock?: StageClock };
  if (w.__pcStageClock) return w.__pcStageClock;

  // WAAPI animations are paused at 0 upon creation; time thereafter is determined entirely
  // by pinAnimations anchor points (see "Third Clock" at file header)
  patchAnimate();

  let now = 0;
  let nextId = 1;
  let queue: { id: number; cb: FrameRequestCallback }[] = [];

  /*
   * Keep a copy of the real wall clock (J4 / K1): after takeover, performance.now is strictly
   * equal to stage time; measuring probe duration, elapsedMs in RPC responses, and tick length
   * of K4 can no longer use it. Similarly keep a real copy of setTimeout (E4b: in paused state,
   * virtual clock does not advance; the 500 ms fallback for .pc-awaiting relies on real clock).
   */
  window.__pcRealNow = performance.now.bind(performance);
  window.__pcRealSetTimeout = window.setTimeout.bind(window);
  window.__pcRealSetInterval = window.setInterval.bind(window);
  // Date.now is taken over by pinEntropy (which reads this very clock); here we only keep the real copy before takeover
  window.__pcRealDateNow ??= Date.now.bind(Date);
  performance.now = () => now;
  /*
   * Keep a copy of the original rAF. **After takeover, there is no longer any way in the page
   * to "wait for the browser to paint a frame"**: yet some tasks must wait: Motion keyframe
   * parsing must cross a task boundary; the catch-up run upon seeking runs synchronously and
   * does not give it time, leaving the card stuck on the initial frame (see settle notes
   * in StageView).
   * Mounted under the same name as exportClock, keeping access consistent on both sides.
   */
  window.__pcRealRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = (id: number) => {
    queue = queue.filter((e) => e.id !== id);
  };

  /* -- E4b: replace setTimeout / setInterval with fake timers registered on virtual clock -- */

  const realClearTimeout = window.clearTimeout.bind(window);
  const realClearInterval = window.clearInterval.bind(window);
  const timers = createVirtualTimers();

  /**
   * Advances clock but **does not settle** (seeks via `set`, trimming start point via `maxCatchUp`).
   * Preserves remaining time of each pending timer: equivalent to clock stopping during skipped time.
   */
  const jumpTo = (ms: number): void => {
    timers.shift(ms - now);
    now = ms;
  };

  window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
    timers.set(handler, ms, args, false, now)) as typeof window.setTimeout;
  window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
    timers.set(handler, ms, args, true, now)) as typeof window.setInterval;
  // Real ids (stage's own wall-clock timers) are forwarded to the real copy: id spaces on both
  // sides are separated by VIRTUAL_TIMER_BASE
  window.clearTimeout = ((id?: number) => { if (!timers.clear(id) && typeof id === "number") realClearTimeout(id); }) as typeof window.clearTimeout;
  window.clearInterval = ((id?: number) => { if (!timers.clear(id) && typeof id === "number") realClearInterval(id); }) as typeof window.clearInterval;

  const tick = (ms: number): number => {
    now = ms;
    // Time arrives first, timers fire first: within the same tick, state read by rAF callbacks is already advanced by timers
    timers.settle(now);
    // Drain before running: rAF re-registered in callbacks belongs to the next frame; otherwise it
    // calls itself infinitely within the same frame
    const due = queue;
    queue = [];
    for (const e of due) {
      try {
        e.cb(ms);
      } catch (err) {
        console.error("[stageClock] rAF callback threw an error", err);
      }
    }
    return due.length;
  };

  const clock: StageClock = {
    now: () => now,
    set: (ms) => {
      // E4b: seeks do not settle timers; remaining time of each pending timer is preserved
      jumpTo(ms);
    },
    tick,
    pendingTimers: () => timers.size(),
    advanceTo(target, opts = {}) {
      const step = opts.step ?? DEFAULT_STEP;
      const maxCatchUp = opts.maxCatchUp ?? DEFAULT_MAX_CATCH_UP;
      if (target < now) {
        // Stepping backward: caller is responsible for remounting; here we only advance the clock
        // (E4b: backward motion is a seek, do not settle timers)
        jumpTo(target);
        opts.onFrame?.(target, tick(target));
        return;
      }
      // Trimming start point is also a seek: timers in the trimmed section do not trigger (E4b)
      if (target - now > maxCatchUp) jumpTo(target - maxCatchUp);
      // Each step lands on the frame grid (timestamps calculated directly from frame numbers, not
      // accumulated); the final step reaches target itself
      const grid = frameGrid(step, opts.fps);
      let ms = now;
      for (let k = grid.after(ms); ms < target; k++) {
        ms = grid.reaches(k, target) ? target : grid.at(k);
        opts.onFrame?.(ms, tick(ms));
      }
      if (now !== target) {
        opts.onFrame?.(target, tick(target));
      }
    },
    async advanceToAsync(target, opts = {}) {
      const step = opts.step ?? DEFAULT_STEP;
      const maxCatchUp = opts.maxCatchUp ?? DEFAULT_MAX_CATCH_UP;
      if (target < now) {
        jumpTo(target);
        opts.onFrame?.(target);
        tick(target);
        const back = opts.afterFrame?.(target);
        if (back) await back;
        return;
      }
      if (target - now > maxCatchUp) jumpTo(target - maxCatchUp);
      /*
       * Order within a frame: **yield microtask → advance clock → commit React → run rAF callbacks →
       * pin animations**.
       *
       * Aligned step-by-step with export step(): over there `__pcSetT(sec)` writes `__pcExportMs` first,
       * then commits via flushSync, then `advance(budget)` pushes one notch of virtual time to run this
       * frame, and finally `__pcSyncAnims()` pins animations. Without the "advance clock first" step,
       * performance.now read during React render would still be from previous frame; if reversed,
       * anything that needs to **measure layout** would lag behind export by one frame: in testing,
       * the highlight around layoutId in chapter-bar had translateY(-13.442px) added by projection
       * in preview, whereas export was none: that 13.44 is exactly displacement of parent element
       * in one frame.
       *
       * Yielding microtasks leaves room for things that cannot cross synchronous blocks (Motion
       * keyframe parsing, particle engine asynchronous loading).
       */
      let ms = now;
      let ran = 0;
      const realTimeout = window.__pcRealSetTimeout ?? window.setTimeout.bind(window);
      // Each step lands on the frame grid (timestamps calculated directly from frame numbers, not
      // accumulated); the final step reaches target itself
      const grid = frameGrid(step, opts.fps);
      for (let k = grid.after(ms); ms < target; k++) {
        if (opts.yieldEvery && ran > 0 && ran % opts.yieldEvery === 0) await new Promise<void>((r) => realTimeout(r, 0));
        else await Promise.resolve();
        if (opts.gate && ran > 0) { const g = opts.gate(); if (g) await g; }
        if (opts.abort?.()) return;
        ran++;
        ms = grid.reaches(k, target) ? target : grid.at(k);
        now = ms;                 // Advance clock first: React render reads this exact frame
        opts.onFrame?.(ms);       // Commit
        tick(ms);                 // Run rAF callbacks for this frame
        const after = opts.afterFrame?.(ms);    // Pin animations
        if (after) await after;   // (canvas card: wait for done of this frame)
      }
      await Promise.resolve();
      if (opts.abort?.()) return;
      if (now !== target) {
        now = target; opts.onFrame?.(target); tick(target);
        const last = opts.afterFrame?.(target);
        if (last) await last;
      }
    },
  };

  w.__pcStageClock = clock;
  return clock;
}
