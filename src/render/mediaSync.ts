/**
 * What to do this frame when aligning media layers with the playhead.
 *
 * # Why extracted separately
 *
 * The original approach was a single rule: during playback, if drift exceeds 0.2s,
 * set `el.currentTime = target`.
 * This worked fine at the beginning of the timeline, but caused stuttering in the middle section
 * because **the cost of drift correction grows with what is being corrected, without any damping**:
 *
 *   1. `el.play()` has its own startup latency, so the video clock naturally lags slightly
 *      behind the playhead;
 *   2. Once lag exceeds 0.2s, a hard seek is triggered. Seeking in the middle of a file is
 *      expensive: keyframes are every 5 seconds (measured at 5s in actual user media), so the
 *      browser must decode up to 150 frames starting from the previous keyframe to display a frame;
 *   3. During these 100~500ms, the playhead keeps advancing, so when seek settles, drift is
 *      again over 0.2s → seek again;
 *   4. This enters a self-sustaining loop: every correction creates a justification for the next
 *      correction, stuttering playback every few hundred milliseconds.
 *
 * The first dozen seconds were fine because `preload="auto"` had already buffered the beginning,
 * and 0s is a keyframe, making seeks virtually free: startup lag never reached 0.2s, so the loop
 * never started.
 *
 * # Current approach
 *
 * Separates "drift correction" and "re-alignment" into two distinct operations:
 *
 *   - **Use playback rate changes for small drifts** (fine-tune `playbackRate` by ±10%) to catch up
 *     gradually. Rate changes do not interrupt decoding, carry no cost, and therefore do not create
 *     reasons for further correction;
 *   - **Seek only when truly desynchronized** (threshold relaxed to 0.5s), with a cooldown period
 *     between seeks, and issue no new commands while `el.seeking` is true: together, these two
 *     rules break the self-sustaining loop at its root.
 *
 * Pure function, does not touch DOM, easy to unit test: all thresholds and state machines live
 * here; the caller is only responsible for passing in el readings and executing the results.
 */

/** Drift must exceed this threshold to be considered "desynchronized" and worth paying the seek cost */
export const HARD_SEEK_SEC = 0.5;
/** Minimum interval between drift-correction seeks, allowing the decoder time to feed new frames */
export const SEEK_COOLDOWN_MS = 700;
/** Drifts below this are considered aligned, with no correction needed (video frames naturally have 1/framerate granularity) */
export const IN_SYNC_SEC = 0.04;
/** Upper limit for playback rate drift correction: ±10% is undetectable to eyes and ears; beyond that, pitch shifts become audible */
export const MAX_RATE_SKEW = 0.1;
/** Align more precisely when paused: seeks do not compete with playback, and the user is inspecting frame by frame */
export const PAUSED_SEEK_SEC = 0.03;
/**
 * Minimum interval between seeks while scrubbing the playhead.
 *
 * Previously when paused, any drift over 0.03s immediately triggered a seek; during scrubbing,
 * every mouse movement triggered one: measured 154 seeks over a 3-second scrub, each decoding
 * from keyframe to target, forcing the decoder to restart repeatedly. While no new commands are
 * issued during seeking, this rule reins in the "seek settles quickly" case (moving forward
 * within the same GOP is virtually free):
 * at 50ms per seek, at most 60 times in 3 seconds. Any dropped seek is caught up by the caller
 * via retryInMs, avoiding loss.
 * Once released, scrubbing reverts to false, immediately aligning precisely to 0.03s.
 */
export const SCRUB_SEEK_MIN_MS = 50;

export interface SyncInput {
  /** Current element time, or null if metadata has not loaded and cannot be read */
  elTime: number;
  /** Whether the element is currently seeking */
  seeking: boolean;
  /** Whether the element is currently paused */
  paused: boolean;
  /** The element has reached the end of the media (`el.ended`). Default false */
  ended?: boolean;
  /** Playhead time mapped to this media */
  target: number;
  /**
   * Base playback rate: clip speed (`TrackClip.speed`, default 1). Playback aligns to it, ±10% drift
   * correction multiplies onto it, and pause stays at it (resuming playback does not carry residual
   * rate changes). Drift and thresholds are still calculated in media seconds.
   */
  baseRate?: number;
  /** Timeline is playing */
  playing: boolean;
  /** Scrubbing the playhead (see isScrubbing in timeline/useScrub.ts); only affects seek density when paused */
  scrubbing?: boolean;
  /** Current time (ms), used to compute cooldown */
  now: number;
  /** Timestamp of the last drift-correction seek initiated by us, or 0 if none */
  lastSeekAt: number;
}

export interface SyncPlan {
  /** Set currentTime to this value; null means leave unchanged */
  seekTo: number | null;
  /** Set playbackRate to this value; null means leave unchanged */
  rate: number | null;
  /** Whether to call play() */
  play: boolean;
  /** Whether to call pause() */
  pause: boolean;
  /**
   * Seek was due but skipped (too close to previous seek during scrubbing); re-evaluate after this
   * many milliseconds; null means no catch-up needed.
   * The caller must perform the catch-up: once scrubbing stops, no new render will trigger sync,
   * leaving the image frozen on the old frame without it.
   */
  retryInMs: number | null;
}

const NOTHING: SyncPlan = { seekTo: null, rate: null, play: false, pause: false, retryInMs: null };

/**
 * What to do with the element this frame.
 *
 * The caller simply applies the returned instructions; when `seekTo` is non-null, update
 * `lastSeekAt` to `now`.
 *
 * New positions arriving while seeking are ignored here, so the caller must also call again
 * upon `seeked` with the **latest** target:
 * otherwise, if the last scrub action falls mid-seek, the final position will never be caught up
 * (driveMedia in render/mediaDrive.ts).
 */
export function planSync(input: SyncInput): SyncPlan {
  const { elTime, seeking, paused, target, playing, scrubbing, now, lastSeekAt } = input;
  if (!Number.isFinite(target) || target < 0 || !Number.isFinite(elTime)) return NOTHING;
  // Clip speed; defaults to (or invalid fallback) 1, where each `base` below was previously hardcoded to 1
  const base = typeof input.baseRate === "number" && Number.isFinite(input.baseRate) && input.baseRate > 0 ? input.baseRate : 1;

  // Do nothing until seek has settled. This rule is key to breaking the self-sustaining loop:
  // during seeking, currentTime reads as the target value rather than actual progress; computing
  // drift with it yields "still far off", triggering yet another seek and discarding all previous
  // decoding work: the frame never displays.
  if (seeking) return playing && paused ? { ...NOTHING, play: true } : NOTHING;

  if (!playing) {
    // Pause: reset playback rate first (to clip speed), so resuming playback does not carry the previous adjustment
    const rate = base;
    const needSeek = Math.abs(elTime - target) > PAUSED_SEEK_SEC;
    const wait = scrubbing ? SCRUB_SEEK_MIN_MS - (now - lastSeekAt) : 0;
    if (needSeek && wait > 0) return { seekTo: null, rate, play: false, pause: !paused, retryInMs: wait };
    return { seekTo: needSeek ? target : null, rate, play: false, pause: !paused, retryInMs: null };
  }

  const drift = target - elTime; // Positive = video lags behind the playhead
  const off = Math.abs(drift);

  /*
   * Element reached the end of the media while the playhead is still within this clip (audio finished
   * slightly ahead of the playhead, or the clip is longer than the media).
   * At this point, **play() must not be called again**: the browser handles play() on an "ended
   * element" by restarting from the beginning: audio from the start briefly plays at the clip end,
   * then drift exceeds 0.5s and it gets hard-sought back to the end, playing the tail again. Once
   * ended, wait quietly for the playhead to leave this clip;
   * only seek back and resume playback if the playhead actually moves backward (exceeding the
   * hard-seek threshold); after seeking, the element is no longer "ended".
   */
  if (input.ended) {
    if (drift >= -HARD_SEEK_SEC) return { ...NOTHING, rate: base };
    if (now - lastSeekAt < SEEK_COOLDOWN_MS) return { ...NOTHING, rate: base };
    return { seekTo: target, rate: base, play: true, pause: false, retryInMs: null };
  }

  if (off > HARD_SEEK_SEC) {
    // Truly desynchronized. But hold off if cooldown has not elapsed: decoding for the previous seek
    // may still be in flight; issuing another one now would just restart it, which is the exact shape
    // of the original loop.
    if (now - lastSeekAt < SEEK_COOLDOWN_MS) return { ...NOTHING, rate: base, play: paused };
    return { seekTo: target, rate: base, play: paused, pause: false, retryInMs: null };
  }

  if (off <= IN_SYNC_SEC) return { seekTo: null, rate: base, play: paused, pause: false, retryInMs: null };

  /*
   * Moderate drift: catch up by adjusting playback rate.
   *
   * Drift between 0.04~0.5s maps linearly to ±10% rate: speed up if lagging, slow down if ahead.
   * A 0.2s drift with a ~4% rate difference catches up in about 5 seconds with continuous frames:
   * whereas this range previously fell right into the hard-seek trigger zone, paying the mid-file
   * seek cost every time.
   */
  const skew = (drift / HARD_SEEK_SEC) * MAX_RATE_SKEW;
  const rate = base * (1 + Math.max(-MAX_RATE_SKEW, Math.min(MAX_RATE_SKEW, skew)));
  return { seekTo: null, rate, play: paused, pause: false, retryInMs: null };
}

/*
 * ────────────────────────────── Double-buffered slots ──────────────────────────────
 *
 * Each track is fixed with two <video> elements (slots 0 / 1): one plays the current clip,
 * while the other preloads the next clip.
 *
 * Why: previously, switching clips created a new player and sought into the middle of the file;
 * with keyframes every 5 seconds, each switch required decoding hundreds of frames before a frame
 * appeared. In a real project with 25 cuts across 88.7 seconds, median frame display latency at
 * transitions was measured at ~200ms before the change. Switches within the same file are never
 * contiguous in the source file, so simply "reusing players by media" does not help and cannot
 * avoid that seek:
 * the only option is to **pay in advance**: when PREROLL_SEC remains before the start of the next
 * clip, load it into the empty slot, seek to the start and pause, waiting for
 * requestVideoFrameCallback to confirm "this frame is rendered"; at the transition boundary,
 * simply switch visibility and let it play.
 *
 * Below is a pure function: given what the two slots currently hold and what the current and next
 * clips are, it returns what each slot should hold, which is playing, which is on standby, and
 * which to display this frame. Executed in render/VideoTrack.tsx.
 */

/** How long before next clip start to begin preloading (seconds). Measured: mid-clip seek settling takes 70-600ms for 1080p with 5s keyframes. */
export const PREROLL_SEC = 1;
/**
 * When the new clip takes too long to render a frame (no time to preload: clip is shorter than
 * `PREROLL_SEC`, or playhead just jumped position during playback), hold the previous clip's
 * last frame for at most this long; cut hard once exceeded, rather than leaving the picture
 * stuck on the previous clip.
 */
export const NOT_READY_GRACE_SEC = 0.5;
/** Tolerance for judging "contiguous": the previous clip's end and this clip's start must differ by less than this to let the previous clip's last frame fill in. */
const TOUCH_SEC = 0.05;

/** A clip that a slot can hold: only video clips enter slots; image clips render <img> directly. */
export interface SlotClip {
  id: string;
  url: string;
  start: number;
  end: number;
  /** Start point within asset (mediaOffset). */
  offset: number;
  /** Clip speed (`TrackClip.speed`); defaults to 1. The asset range occupied by this clip is offset ~ offset + (end − start) × speed. */
  speed?: number;
}

export interface SlotState {
  /** Which clip this slot currently holds; null if not yet loaded. */
  clip: SlotClip | null;
  /** A frame from this loaded clip has rendered (requestVideoFrameCallback has fired with a timestamp inside this clip's asset range). */
  ready: boolean;
}

export interface SlotsInput {
  slots: readonly SlotState[];
  /** Which slot was displayed in the previous frame; null if none was displayed. */
  shown: number | null;
  /** The video clip on this track at the current moment. */
  cur: SlotClip | null;
  /** The first video clip on this track after t (nextVideoLayerAfter in kernel/project.ts). */
  next: SlotClip | null;
  t: number;
  playing: boolean;
  /**
   * Whether there is still quota for tier switch warm-up (there is a limit on concurrently warmed
   * layers on the same page, `MAX_WARMING` in `VideoTrack`). Defaults to true. When quota is
   * exhausted, the previous tier continues playing without loading the new tier, rechecked on the
   * next render.
   */
  canWarm?: boolean;
}

export interface SlotsPlan {
  /** Which clip each slot should load; unchanged if identical to slots[i].clip, null means never loaded. */
  load: (SlotClip | null)[];
  /** The slot playing the current clip and following the playhead. */
  active: number | null;
  /** The slot preloaded with the next clip and paused at its start. */
  preload: number | null;
  /** Which slot is displayed in this frame. */
  shown: number | null;
  /**
   * Slot for tier switch warm-up (C6.6 section 4 "Page tier switch"): the new tier of the same clip
   * is loaded here, muted and following the playhead. Marked ready only after caller confirms its
   * yielded frame aligns to within one frame of the on-screen tier (`tierAligned`); once ready,
   * next planning run swaps it to active + shown in a single commit. null when no tier switch.
   */
  warm: number | null;
}

/** `HTMLMediaElement.NETWORK_NO_SOURCE` (pure function avoids DOM constants here). */
const NETWORK_NO_SOURCE = 3;

/**
 * The tier that just became complete on asset service: elements previously mounted with it that
 * failed to load (404: waiting for uploader) must call `load()` once again.
 *
 * **Elements whose src was just swapped in this round do not count** (`freshSrc`): once src
 * changes, the browser's resource selection algorithm immediately sets `networkState` to
 * `NETWORK_NO_SOURCE`, looking identical to "mount failed" when loading has actually just begun.
 * A tier switch round is precisely this scenario (complete → tier switch URL → warming slot src
 * swap in the same commit); previously it would immediately call `load()` again, aborting and
 * restarting the just-issued request and seek, delaying tier switches on slow networks (C6.6 T9-X2).
 */
export function reloadOnComplete(input: {
  /** The tier loaded in this slot is now complete on the asset service. */
  doneNow: boolean;
  /** This slot was already evaluated after becoming complete (evaluated while in use, or src was swapped after arrival): evaluate only once after complete. */
  seenBefore: boolean;
  /** Slot holds content. */
  hasClip: boolean;
  /** src was freshly swapped in this round. */
  freshSrc: boolean;
  /**
   * Slot is currently in use (playing current clip, warming for tier switch, preparing next clip).
   * Defaults to true. Idle slots are not reloaded: reloading only contends for bandwidth with
   * playability probing (cross-machine T9 `ht9a0927`, `docs/archive/agent-reports/AGENT-tier-reload-seek.md`);
   * the caller must ensure it gets evaluated again when its turn to be used arrives.
   */
  inUse?: boolean;
  /** Element reported an error (`el.error` is non-null). */
  error: boolean;
  networkState: number;
}): boolean {
  const { doneNow, seenBefore, hasClip, freshSrc, error, networkState, inUse = true } = input;
  if (!doneNow || seenBefore || !hasClip || freshSrc || !inUse) return false;
  return error || networkState === NETWORK_NO_SOURCE;
}

/**
 * Tier switch alignment criterion (C6.6 section 8 research findings, item 4): the `mediaTime` of
 * the frame yielded by the new tier must differ from the on-screen tier's current timestamp
 * (target timestamp when paused) by no more than one frame (at project frame rate) to be aligned.
 * Only microsecond-level tolerance is given to absorb floating-point errors; differences exceeding
 * one frame must wait for the next frame before switching.
 */
export function tierAligned(mediaTime: number, reference: number, fps: number): boolean {
  if (!Number.isFinite(mediaTime) || !Number.isFinite(reference)) return false;
  const frame = 1 / (fps > 0 ? fps : 30);
  return Math.abs(mediaTime - reference) <= frame + 0.000001;
}

/** Extrapolates the frame already yielded in foreground to expected display time of warming frame, then compares the two tiers. */
export function frontTimeAtDisplay(front: { mediaTime: number; expectedDisplayTime: number }, warmExpectedDisplayTime: number, rate = 1): number {
  // Asset time advances with clip speed: Δ seconds of wall clock means Δ × rate seconds in asset (bit-identical when rate defaults to 1)
  return front.mediaTime + (warmExpectedDisplayTime - front.expectedDisplayTime) / 1000 * rate;
}

export function planSlots(input: SlotsInput): SlotsPlan {
  const { slots, shown, cur, next, t, playing, canWarm = true } = input;
  const load = slots.map((s) => s.clip);
  // Slot matching requires identical id **and** url: a tier switch on the same clip (`playbackUrl`
  // in `mediaTier.ts` changed URL) is a new clip and must reload and wait to render again
  // (A1 "tier switch = slot-level clip switch"); comparing only id would never load the new URL
  const holding = (c: SlotClip) => load.findIndex((x) => x?.id === c.id && x?.url === c.url);
  const sameUrl = (url: string) => {
    const i = load.findIndex((c) => c?.url === url);
    return i < 0 ? null : i;
  };

  // (0) Tier switch (C6.6): the displayed slot holds the previous tier of this clip and has already
  //     rendered a frame: previous tier continues as active (keeps playing during playback, stays
  //     put when paused), while the new tier loads into the other slot to warm up; swapped only once
  //     the new tier is aligned and renders a frame (ready). This way the previous tier holds the
  //     screen during tier switch: no freeze, no jump, playback position stays unchanged.
  if (cur && shown !== null && load[shown]?.id === cur.id && load[shown]?.url !== cur.url && slots[shown]?.ready) {
    const other = 1 - shown;
    const warmed = load[other]?.id === cur.id && load[other]?.url === cur.url;
    if (warmed && slots[other]?.ready) {
      // Aligned and rendered: swapped in a single commit; previous tier steps down starting this tick
      return { load, active: other, preload: null, shown: other, warm: null };
    }
    if (!warmed && !canWarm) return { load, active: shown, preload: null, shown, warm: null };
    load[other] = cur;
    return { load, active: shown, preload: null, shown, warm: other };
  }

  // (1) Which slot holds the current clip
  let active: number | null = null;
  if (cur) {
    active = holding(cur);
    if (active < 0) {
      if (!playing) {
        // When paused, scrubbing lands wherever: use only the currently displayed slot, matching original
        // single-element behavior. If none displayed, pick one holding the same file (no reload needed),
        // or slot 0 if neither matches.
        // Exception: displayed slot holds previous tier of this clip (tier switch): load new tier into
        // the other slot, displayed slot holds the frame, swap once rendered
        active = shown !== null && load[shown]?.id === cur.id ? 1 - shown : (shown ?? sameUrl(cur.url) ?? 0);
      } else {
        // Playing but not preloaded: load into other slot; currently displayed one holds last frame (see (3))
        active = shown !== null ? 1 - shown : (sameUrl(cur.url) ?? 0);
      }
      load[active] = cur;
    }
  }

  // (2) Which slot to display this frame
  let show: number | null = null;
  if (cur && active !== null) {
    const ready = slots[active].clip?.id === cur.id && slots[active].clip?.url === cur.url && slots[active].ready;
    const held = shown !== null && shown !== active ? slots[shown].clip : null;
    if (ready) show = active;
    // Tier switch for the same clip (same id, changed URL): keep previous tier holding the screen
    // until new tier renders, whether paused or playing: A1 "no visual jumps during tier switch".
    // Never reaches here if url never changes (already matched by holding slot with same id and url)
    else if (held && held.id === cur.id) show = shown;
    else if (!playing || t - cur.start >= NOT_READY_GRACE_SEC) show = active;
    // New clip hasn't rendered yet: if contiguous, hold previous clip on its last frame; better than flashing black or a stale frame from elsewhere
    else if (held && Math.abs(cur.start - held.end) < TOUCH_SEC) show = shown;
    // Non-contiguous (gap in between or jumped via seek): leave empty like a newly created player, wait for it to render
    else show = null;
  }

  // (3) Preload next clip into the other slot: do only during playback. Scrubbing back and forth
  //     while paused causes the standby slot to seek repeatedly, forcing both decoders to restart.
  //     The slot currently filling in cannot be used for loading; wait until the new clip renders.
  let preload: number | null = null;
  if (playing && next && next.start > t && next.start - t <= PREROLL_SEC) {
    let p = holding(next);
    if (p < 0) p = active !== null ? 1 - active : (sameUrl(next.url) ?? 0);
    if (p !== active && p !== show) {
      load[p] = next;
      preload = p;
    }
  }

  return { load, active, preload, shown: show, warm: null };
}
