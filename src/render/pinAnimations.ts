/**
 * WAAPI / CSS animation time pinning.
 *
 * A driven clock can control Motion's frame loop and a card's own rAF, but cannot control CSS
 * animation / transition / WAAPI: they run on the compositor thread and follow the browser's own
 * clock. The approach is the same as `__pcSyncAnims` in export view: record stage time when each
 * animation first appears as an anchor, then pin `currentTime` to "now - anchor" each frame and
 * pause it, so values depend solely on time, independent of machine speed. The prerequisite is that
 * an animation is paused at 0 at creation: guaranteed by `patchAnimate` installed by `stageClock`.
 * Without it, animations would be born as `finished` following the real time of `document.timeline`,
 * and the "skip finished" line below would skip the entire entrance.
 *
 * # Three sub-tree entry points (R3:K3 / K5)
 *
 * The stage needs to do three things per **clip**; global `sync` / `reset` is too coarse:
 *
 *   - `resetIn(el)`  Before remounting a clip, discards only its own anchors (rebuilding the entire
 *                    `WeakMap` would clear other cards as well, causing their entrance animations to
 *                    replay from the start at that moment);
 *   - `syncIn(el, stageMs)` Pins animations only within this clip subtree: used by K3(a') `seekOk`
 *                    one-step positioning and K5 first-path subtree frame catch-up. **Time base is
 *                    always global stage milliseconds**: feeding local milliseconds causes anchors
 *                    to land on a local base, adding `clip.start × 1000` to target when handed back
 *                    to global `sync`, triggering `finish()` straight to the final state;
 *   - `sync(nowMs, skip)` Pins globally, but skips animations in wrapper layer subtrees inside
 *                    `skip`: clips currently catching up frames on their own (`.pc-settling`) or
 *                    suppressed (`.pc-suppressed`) cannot be wound back by the global clock.
 *
 * # Delivering End Callbacks on the Spot
 *
 * When an animation is wound to the end, `finish()` is called. The browser does not notify
 * immediately: the "end event" is queued until the document's **next real frame output** to dispatch,
 * while stage frame-pushing does not wait for real frames (background stage outputs roughly one frame
 * per second when pushing frames, and catch-up runs yield only microtasks between frames, outputting
 * no frames at all). Motion relies on the animation's `onfinish` to know it has finished playing
 * (writing back final values, tearing down animations, notifying those waiting for it); however late
 * the event is, its knowledge of the animation remains stale by that much: cards that change words
 * (`AnimatePresence mode="wait"`) therefore produce different visuals every time for the same pushed
 * frame, while other cards leave traces of "animation still attached, final value not written back"
 * (see `docs/reports/AGENT-rr-a1-verify.md` for actual tests and teardown).
 *
 * Therefore, we do not wait for the browser here: after each `sync` / `syncIn` finishes pinning
 * everything it needs to, it invokes `onfinish` **on the spot** for all animations wound to the end
 * in this pass. When an animation counts as finished is thus determined solely by stage time,
 * independent of whether the browser outputs frames.
 *
 *   - The browser will still dispatch its own end event later. Callbacks already delivered cannot be
 *     invoked again (Motion's callback would rewrite final values, while the next animation may have
 *     already started on that same property), so upon delivery, `onfinish` is temporarily replaced
 *     with a placeholder that swallows only this occurrence and restores the original afterwards.
 *   - Wait until all pinning finishes before delivery: callbacks teardown animations and modify
 *     styles, which cannot be interleaved between pinning other animations.
 *   - Only manages callbacks attached via the `onfinish` property (which is how Motion attaches
 *     them). The `finished` Promise already settles inside `finish()` and does not wait for frame
 *     output anyway. Listeners attached via `addEventListener('finish')`, CSS animation `animationend`,
 *     and transition `transitionend` still wait for browser frame output: redispatching these events
 *     on the spot would make it impossible to intercept only the listeners already received during
 *     the browser's own pass. Neither built-in cards nor Motion use them.
 */
export interface AnimationPinner {
  /**
   * Called once per frame run: `nowMs` = current stage time.
   * `skip`: animations in these wrapper layer (`[data-pc-clip]`) subtrees are not pinned in this frame
   * (K5 first path / E7 item 5).
   */
  sync(nowMs: number, skip?: ReadonlySet<Element>): void;
  /** Pins animations only in `el` subtree; time base is likewise **global stage milliseconds** (K3(a') / K5 first path) */
  syncIn(el: AnimationHost | null | undefined, stageMs: number): void;
  /**
   * Number of animations wound to the end in the latest `sync` / `syncIn` (their end callbacks have
   * been delivered on the spot). Callers use this to know whether this frame needs to wait for another
   * React commit (`bakeFrame` in `StageView.tsx`).
   */
  endedInLastSync(): number;
  /** Called once before remounting a card to discard old anchors */
  reset(): void;
  /** Discards anchors only for animations in `el` subtree (remount by clip, K3); other cards are untouched */
  resetIn(el: AnimationHost | null | undefined): void;
}

/*
 * # Exemption for Placeholders
 *
 * CSS animations belonging to placeholder components themselves (`pc-ph-` prefix,
 * `isPlaceholderAnimation` in contract) govern "display only if 120 ms threshold is missed" and
 * hourglass spinning, and **follow real time**. Pinning them would leave the virtual clock frozen in
 * paused state, permanently stranding the placeholder at invisible millisecond 0. Therefore,
 * whole-page `sync` and subtree `syncIn` both skip them; matching only by prefix, while other card
 * animations are pinned as usual.
 */
import { isPlaceholderAnimation } from "./placeholder/contract.ts";

/** Something that can yield animations in its subtree. In production it is an `Element`; unit tests provide a mock */
export interface AnimationHost {
  getAnimations(options?: { subtree?: boolean }): Animation[];
}

/** Which clip's wrapper layer this animation is attached to (null if not found: belongs to no clip) */
function clipWrapperOf(a: Animation): Element | null {
  const target = (a.effect as KeyframeEffect | null)?.target ?? null;
  return target && typeof target.closest === "function" ? target.closest("[data-pc-clip]") : null;
}

type FinishHandler = NonNullable<Animation["onfinish"]>;

/**
 * End event on an animation "delivered on the spot, browser not yet dispatched": original callback,
 * replacing placeholder, remaining count.
 */
interface OwedFinish {
  handler: FinishHandler;
  guard: FinishHandler;
  count: number;
}

export function createAnimationPinner(doc: Document = document): AnimationPinner {
  let anchors = new WeakMap<Animation, number>();
  /**
   * Animations wound to the end in this pass; end callbacks are delivered together after pinning (see
   * header "Delivering End Callbacks on the Spot").
   */
  let ended: Animation[] = [];
  const owed = new WeakMap<Animation, OwedFinish>();

  /** Invokes `onfinish` of this animation on the spot, and makes the browser's later re-dispatch a no-op */
  const deliverFinish = (a: Animation): void => {
    let debt = owed.get(a);
    // Placeholder was replaced by something else (callback modified `onfinish` itself): invalidate old
    // record, use what is currently attached
    if (debt && a.onfinish !== debt.guard) {
      owed.delete(a);
      debt = undefined;
    }
    const handler = debt ? debt.handler : a.onfinish;
    if (typeof handler !== "function") return;
    if (debt) debt.count++;
    else {
      const fresh: OwedFinish = {
        handler,
        count: 1,
        guard: () => {
          if (--fresh.count > 0) return;
          owed.delete(a);
          if (a.onfinish === fresh.guard) a.onfinish = fresh.handler;
        },
      };
      owed.set(a, fresh);
      a.onfinish = fresh.guard;
    }
    try {
      handler.call(a, new AnimationPlaybackEvent("finish", { currentTime: a.currentTime, timelineTime: a.timeline?.currentTime ?? null }));
    } catch (err) {
      console.error("[pinAnimations] end callback threw an error", err);
    }
  };

  /** Number of animations wound to the end in the latest pass (`endedInLastSync`) */
  let lastEnded = 0;

  /** Animations wound to the end in this pass, delivering end callbacks one by one */
  const deliverEnded = (): void => {
    // Take first then invoke: if another sync is triggered inside callback, newly wound animations belong to that pass
    const batch = ended;
    ended = [];
    lastEnded = batch.length;
    for (const a of batch) deliverFinish(a);
  };

  /** Pins an animation to nowMs. Returns false to indicate this animation can be ignored (already ended / not yet started) */
  const pin = (a: Animation, nowMs: number): void => {
    if (a.playState === "finished" || a.playState === "idle") return;
    if (isPlaceholderAnimation(a as Animation & { animationName?: string })) return;
    let anchor = anchors.get(a);
    if (anchor === undefined) {
      anchor = nowMs;
      anchors.set(a, anchor);
    }
    const target = Math.max(0, nowMs - anchor);
    const end = a.effect?.getComputedTiming().endTime;
    if (typeof end === "number" && Number.isFinite(end) && target >= end) {
      // Past the end: finish() lets Motion commit final state and returns CSS animation to natural style,
      // consistent with normal playback completion. Motion's commit is in its end callback, invoked on the
      // spot by deliverEnded after this pass finishes pinning, without waiting for browser frame output
      a.finish();
      ended.push(a);
      return;
    }
    if (a.playState !== "paused") a.pause();
    a.currentTime = target;
  };

  return {
    reset() {
      anchors = new WeakMap<Animation, number>();
    },
    resetIn(el) {
      if (!el) return;
      for (const a of el.getAnimations({ subtree: true })) anchors.delete(a);
    },
    sync(nowMs: number, skip?: ReadonlySet<Element>) {
      for (const a of doc.getAnimations()) {
        // Filter out placeholder's own animations and already ended / not started ones first; avoid looking
        // up wrapper layers for them (P4 performance fix)
        if (a.playState === "finished" || a.playState === "idle") continue;
        if (isPlaceholderAnimation(a as Animation & { animationName?: string })) continue;
        /*
         * Clips currently catching up frames on their own / suppressed are not pinned in this frame.
         * Criterion is "whether the closest [data-pc-clip] above this animation's target element is in
         * skip": cannot check target itself, since animations can start at any layer inside a card.
         */
        if (skip?.size) {
          const wrap = clipWrapperOf(a);
          if (wrap && skip.has(wrap)) continue;
        }
        pin(a, nowMs);
      }
      deliverEnded();
    },
    syncIn(el, stageMs: number) {
      if (!el) return;
      for (const a of el.getAnimations({ subtree: true })) pin(a, stageMs);
      deliverEnded();
    },
    endedInLastSync: () => lastEnded,
  };
}
