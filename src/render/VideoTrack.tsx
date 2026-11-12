import { useLayoutEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { frameCss } from "../kernel/layout";
import { resolveClipFrameAt } from "../kernel/frameExpr.mjs";
import { isImageMedia, type MediaAsset, type Project, type TrackClip } from "../kernel/project";
import type { FilterDef } from "../kernel/filters.mjs";
import { clipSpeed, mediaSpanOf } from "../kernel/clipTime.mjs";
import { shouldMuteNativeAudio } from "../audio/cardAudio";
import { driveMedia, filterOf, lastSeekAt, releaseMedia, targetTimeOf } from "./mediaDrive";
import { frontTimeAtDisplay, planSlots, reloadOnComplete, tierAligned, type SlotClip } from "./mediaSync";
import { chooseTier, hashFromUrl, playbackUrl } from "./mediaTier";
import { playabilityVersion, subscribePlayability } from "./playability";
import { confirmedMissingVisual, missingMaterialLabel } from "../audio/missingMaterial";
import { MissingMaterial } from "./MissingMaterial";

/**
 * Visual layer of a track (video / image). E7 rule 1: media layer moved into stage, rendered by
 * `FrameScene`'s `live` variant.
 *
 * Visual layers are mounted **per track**, not per clip: each track has two resident `<video>`
 * elements, one for the current clip, one preloaded with the next clip (see `mediaSync.ts`
 * `planSlots` for why and how they alternate). Previously it was `key={clip.id}`, creating a new
 * player for every clip switch and seeking mid-file, leaving a blank for 100-200 ms at boundaries
 * before the frame appeared.
 *
 * Each element syncs with the playhead independently. How sync should be done is in `mediaSync.ts`
 * (pure functions, with unit tests), executed in `mediaDrive.ts`; this file only passes element
 * readings and carries out the results.
 *
 * # Two things **not** done here
 *
 *  1. **Do not import `src/audio/previewAudio`**: audio routing belongs to the editor main document
 *     (`MediaLayers`'s `AudioLayer`); stage is always `muted` and editor only renders `audioOnly`,
 *     so not a single audio node is connected along this path.
 *  2. **Do not import `src/editor/timeline/useScrub`**: `scrubbing` comes from props (passed down
 *     by the parent page via `setScrubbing`). Both are to keep editor modules out of the stage bundle.
 */

const NO_HASHES: readonly string[] = [];

/**
 * Upper limit on layers warming up for tier switches concurrently on the same page (C6.6
 * Section 8 research conclusion item 4: decoding two streams concurrently takes extra decoders
 * and frame buffers, ~3.1 MB per 1080p frame; warm up only a few layers and let the rest wait for
 * quota). Counted per track; a single track warms up at most one at a time.
 */
export const MAX_WARMING = 2;
const warming = new Set<object>();

export interface VideoLayer {
  clip: TrackClip;
  media: MediaAsset;
  opacity: number;
}

/** Which clip a resident `<video>` currently holds, and whether that clip has rendered a frame */
export interface Slot {
  clip: SlotClip | null;
  /** The full clip currently loaded: needed for positioning the frame (frame) and emphasis */
  full: TrackClip | null;
  ready: boolean;
  /** Incremented whenever the loaded content changes; stale frame callbacks recognize they are expired and no-op */
  token: number;
  /** Opacity when last displayed: the stand-in last frame is drawn with this opacity */
  opacity: number;
}
const emptySlot = (): Slot => ({ clip: null, full: null, ready: false, token: 0, opacity: 1 });

/**
 * Only video clips enter slots; image clips and clips without URLs do not.
 * `url` goes through tier switch criteria (`playbackUrl` in `mediaTier.ts`, T1a review #5):
 * switching tiers for the same clip = url changed = new clip; `planSlots` matches slots by
 * "both id and url are identical". When the set is empty, it uses `media.url`, as before.
 */
function slotClipOf(clip: TrackClip, media: MediaAsset, localHashes: readonly string[]): SlotClip | null {
  if (isImageMedia(media) || !media.url) return null;
  // Media using only small size (lowest tier, exceeds decoding limit) without a small-size asset get
  // no URL (c10a Section 8): do not enter slots; this layer only shows "waiting for uploader"
  const url = playbackUrl(media, localHashes);
  if (!url) return null;
  // Clip speed (omitted when default 1, verbatim identical to the original object)
  return { id: clip.id, url, start: clip.start, end: clip.end, offset: clip.mediaOffset ?? 0, ...(clipSpeed(clip) !== 1 ? { speed: clipSpeed(clip) } : null) };
}

/**
 * This media timestamp belongs to this clip (with 0.1s margin: rendered frame timestamp is
 * at most one frame earlier than target).
 */
function inClipRange(c: SlotClip, mediaTime: number) {
  return mediaTime >= c.offset - 0.1 && mediaTime <= c.offset + mediaSpanOf(c) + 0.1;
}

export function VideoTrack({
  project,
  cur,
  next,
  t,
  playing,
  scrubbing,
  muted,
  gain = 1,
  stage,
  filters,
  onMediaFrame,
  localHashes = NO_HASHES,
}: {
  project: Project;
  /** Filter library of the project (clip.filter of a clip references one entry) */
  filters?: FilterDef[];
  /** The visual clip of this track at this moment (the entry belonging to it in videoLayersAt), or null if none */
  cur: VideoLayer | null;
  /** The first visual clip on this track after t (nextVideoLayerAfter) */
  next: { clip: TrackClip; media: MediaAsset } | null;
  t: number;
  playing: boolean;
  scrubbing: boolean;
  muted: boolean;
  /** Master preview volume, multiplied on top of fade in/out */
  gain?: number;
  /** Video dimensions: needed to calculate clip frames */
  stage: { width: number; height: number };
  /**
   * A frame of this track has actually been drawn to screen (K5 step (4) `mediaReady`: only dare to
   * swap after the background stage catch-up run finishes and the media has rendered a frame).
   * The stage connects it to `postStageEvent({ type: 'mediaReady' })`; editor does not pass it.
   */
  onMediaFrame?: (mediaTime: number) => void;
  /**
   * Hashes reported as `complete` by the currently connected asset service (A1's `localHashes`),
   * which tier switch criteria exclusively check. Default empty set = asset service not yet queried
   * (mounts small-size asset if available). Source: main document polls `GET media/<hash>/chunks`
   * every 2 seconds (`src/editor/media/assetTiers.ts`), dispatched via `setLocalHashes`.
   */
  localHashes?: readonly string[];
}) {
  const el0 = useRef<HTMLVideoElement>(null);
  const el1 = useRef<HTMLVideoElement>(null);
  const els = [el0, el1];
  const slots = useRef<Slot[]>([emptySlot(), emptySlot()]);
  /**
   * Whether each slot has evaluated "whether to reload failed elements" after its tier is fully
   * available (evaluated only when in use; reset to false when not fully available).
   */
  const completeSeen = useRef<boolean[]>([false, false]);
  /** Previously planned warm-up slot / playback slot (read here when frame callbacks arrive outside render) */
  const warmRef = useRef<number | null>(null);
  const activeRef = useRef<number | null>(null);
  const shownRef = useRef<number | null>(null);
  const displayedFrames = useRef<Array<{ mediaTime: number; expectedDisplayTime: number; token: number } | null>>([null, null]);
  // Frame callbacks arrive outside render: when paused, there is no playback loop driving re-renders,
  // so we must trigger one ourselves for the display to switch
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // Re-render once when playability probe reaches a conclusion (`playability.ts`): switch tiers
  // immediately even when paused
  useSyncExternalStore(subscribePlayability, playabilityVersion, playabilityVersion);
  const warmKey = useRef({}).current;
  const canWarm = warming.has(warmKey) || warming.size < MAX_WARMING;
  const missing = cur && confirmedMissingVisual(cur.media) ? cur : null;
  const curV = cur && !missing ? slotClipOf(cur.clip, cur.media, localHashes) : null;
  const nextV = next && !confirmedMissingVisual(next.media) ? slotClipOf(next.clip, next.media, localHashes) : null;
  // When the browser has decoded a visible frame but this component's first callback has not arrived
  // yet, plan tier switch assuming "has visuals from previous tier".
  const planningSlots = slots.current.map((s, i) => i === shownRef.current && (els[i].current?.readyState ?? 0) >= 2 ? { ...s, ready: true } : s);
  if (shownRef.current !== null && curV && slots.current[shownRef.current].clip?.id === curV.id && slots.current[shownRef.current].clip?.url !== curV.url) {
    const other = 1 - shownRef.current;
    // The other slot may have rendered frames as ordinary media before original-size assets arrived;
    // only ready produced by alignment in this warm-up round can switch.
    if (planningSlots[shownRef.current].ready && warmRef.current !== other && planningSlots[other].clip?.id === curV.id && planningSlots[other].clip?.url === curV.url) {
      planningSlots[other] = { ...planningSlots[other], ready: false };
    } else if (warmRef.current === other && planningSlots[other].ready && playing) {
      // Foreground continues advancing between frame callback and React commit; verify again with the
      // latest delivered frames from both slots at commit time.
      const front = displayedFrames.current[shownRef.current];
      const warm = displayedFrames.current[other];
      if (!front || !warm || front.token !== slots.current[shownRef.current].token || warm.token !== slots.current[other].token ||
        !tierAligned(warm.mediaTime, frontTimeAtDisplay(front, warm.expectedDisplayTime), project.fps || 30)) {
        planningSlots[other] = { ...planningSlots[other], ready: false };
      }
    }
  }
  const plan = planSlots({ slots: planningSlots, shown: shownRef.current, cur: curV, next: nextV, t, playing, canWarm });
  // The "now" required by tier switch alignment criteria: frame callbacks arrive outside render, read the latest
  const live = useRef({ t, playing, cur, fps: project.fps || 30, shown: plan.shown as number | null });
  live.current = { t, playing, cur, fps: project.fps || 30, shown: plan.shown };
  const complete = new Set(localHashes);
  const fullOf = (i: number): TrackClip | null => {
    const id = plan.load[i]?.id;
    if (id && id === cur?.clip.id) return cur.clip;
    if (id && id === next?.clip.id) return next.clip;
    return slots.current[i].full;
  };

  /**
   * Hook for K5 step (4): when **not switching clips** within the same clip, `s.clip?.id === c.id`
   * below will not re-register rVFC, so "whether the media layer rendered a frame after `back` catch-up
   * run to T'" has to wait the full 300 ms. Each time the parent page changes `mediaT`, `t` changes;
   * a deviation exceeding `PAUSED_SEEK_SEC` indicates an actual seek: re-register rVFC here to report
   * as soon as a frame renders, without waiting for the full fallback timeout.
   */
  const armed = useRef(false);
  const armFrame = (el: HTMLVideoElement, i: number) => {
    if (!onMediaFrame || armed.current) return;
    armed.current = true;
    el.requestVideoFrameCallback((_now, meta) => {
      armed.current = false;
      if (slots.current[i].clip) onMediaFrame(meta.mediaTime);
    });
  };

  // currentTime is the playhead reading, not the frame already handed off to the compositor.
  // Continuously record delivered frame timestamps for both slots so a foreground reference
  // at the same display timestamp is available when warmup callbacks arrive.
  useLayoutEffect(() => {
    const ids: Array<{ el: HTMLVideoElement; id: number }> = [];
    for (let i = 0; i < 2; i++) {
      const el = els[i].current;
      if (!el) continue;
      const onFrame: VideoFrameRequestCallback = (_now, meta) => {
        displayedFrames.current[i] = { mediaTime: meta.mediaTime, expectedDisplayTime: meta.expectedDisplayTime, token: slots.current[i].token };
        ids[i] = { el, id: el.requestVideoFrameCallback(onFrame) };
      };
      ids[i] = { el, id: el.requestVideoFrameCallback(onFrame) };
    }
    return () => { for (const entry of ids) if (entry) entry.el.cancelVideoFrameCallback(entry.id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    // Slot for tier switch warmup: delivered frame must align with the active tier on screen within
    // one frame to qualify (C6.6 "frame error does not exceed one frame"): during playback compare
    // with current timestamp of the displayed tier, during pause compare with target timestamp.
    // Check if it is a warm-up slot (`warmRef`) only during evaluation: a slot might initially mount
    // as an ordinary clip (e.g. failed while waiting for uploader) and only later become a warm-up slot
    const aligned = (i: number, c: SlotClip, mediaTime: number, expectedDisplayTime?: number) => {
      const now = live.current;
      if (!now.cur || now.cur.clip.id !== c.id) return false;
      const front = now.shown !== null && now.shown !== i ? els[now.shown].current : null;
      const frontFrame = now.shown !== null ? displayedFrames.current[now.shown] : null;
      const ref = now.playing
        ? front && !front.paused && frontFrame && frontFrame.token === slots.current[now.shown!].token && expectedDisplayTime !== undefined
          ? frontTimeAtDisplay(frontFrame, expectedDisplayTime, clipSpeed(now.cur.clip)) : NaN
        : targetTimeOf(now.cur.clip, now.t);
      const ok = tierAligned(mediaTime, ref, now.fps);
      if (!ok && now.playing && Number.isFinite(ref)) {
        const warm = els[i].current;
        const realNow = (window.__pcRealNow ?? performance.now.bind(performance))();
        if (warm && !warm.seeking && realNow - (lastSeekAt.get(warm) ?? 0) > 120) {
          warm.currentTime = ref;
          lastSeekAt.set(warm, realNow);
        }
      }
      // Probe inspection port (`scripts/probes/tier-switch-probe.mjs`): recorded only when an array,
      // same approach as __pcFallbackTrace
      const trace = (window as unknown as { __pcTierTrace?: unknown[] }).__pcTierTrace;
      if (ok && Array.isArray(trace)) trace.push({ clipId: c.id, url: c.url, mediaTime, ref, fps: now.fps, playing: now.playing, expectedDisplayTime, frontFrame });
      return ok;
    };
    // requestVideoFrameCallback: counts as ready only when this clip actually drew a frame to the
    // screen (not seeked, at which point the frame may not have been delivered yet)
    const arm = (i: number, c: SlotClip, el: HTMLVideoElement) => {
      const s = slots.current[i];
      const tok = ++s.token;
      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (s.token !== tok) return;
        if (warmRef.current === i) {
          const ok = aligned(i, c, meta.mediaTime, meta.expectedDisplayTime);
          if (s.ready !== ok || ok) { s.ready = ok; bump(); }
          el.requestVideoFrameCallback(onFrame);
        } else if (inClipRange(c, meta.mediaTime)) {
          s.ready = true;
          bump();
          if (i === shownRef.current || i === activeRef.current) onMediaFrame?.(meta.mediaTime);
        } else el.requestVideoFrameCallback(onFrame);
      };
      el.requestVideoFrameCallback(onFrame);
    };
    const prevWarm = warmRef.current;
    warmRef.current = plan.warm;
    activeRef.current = plan.active;
    /** Slot whose loaded content changed this round (src may have just changed) */
    const fresh = [false, false];
    plan.load.forEach((c, i) => {
      const s = slots.current[i];
      const el = els[i].current;
      if (!el || !c) return;
      if (s.clip?.id === c.id && s.clip?.url === c.url) {
        // Loaded content unchanged but just became a warm-up slot: previous "has rendered a frame"
        // evaluated as an ordinary clip does not count; re-evaluate based on alignment
        if (i === plan.warm && prevWarm !== i) { s.ready = false; arm(i, c, el); }
        return;
      }
      // Switching tiers for the same clip (url changed) is also a clip switch: clear cooldown, wait for
      // frame rendering again; playback position is aligned back by driveMedia below
      // Switched clips: previous frame rendering no longer counts. src was swapped by React beforehand
      // (kept if same file, reusing decoder and buffers)
      s.clip = c;
      s.full = fullOf(i);
      s.ready = false;
      fresh[i] = true;
      displayedFrames.current[i] = null;
      // Cooldown is for "correction within the same clip"; switching clips is a fresh start,
      // do not let cooldown left from the previous clip block this alignment
      lastSeekAt.delete(el);
      arm(i, c, el);
      if (i === plan.preload) {
        // Standby slot: paused at the start of the next clip. When src just changed, readyState is
        // still 0; this records "seek over once metadata arrives"
        releaseMedia(el);
        el.currentTime = c.offset;
      }
    });

    for (let i = 0; i < 2; i++) {
      const el = els[i].current;
      if (!el) continue;
      const s = slots.current[i];
      // Tier that just became fully available on the asset service: reload elements that previously
      // mounted with it and failed (404: waiting for uploader).
      // Elements whose src just changed this round do not count (`reloadOnComplete`): networkState was
      // NO_SOURCE to begin with, so calling load() again would only interrupt the newly started load.
      // Idle slots do not count either: reloading would only compete for bandwidth with playability
      // probes; they are not marked "evaluated" and will reload when their turn comes to play or warm up.
      // Reloading comes **before** driving: seeks issued after load() are what count (whether prior seeks
      // are preserved after load() depends on the browser).
      const h = s.clip ? hashFromUrl(s.clip.url) : null;
      const doneNow = !!h && complete.has(h);
      const inUse = i === plan.active || i === plan.warm || i === plan.preload;
      if (s.clip && reloadOnComplete({ doneNow, seenBefore: completeSeen.current[i], hasClip: true, freshSrc: fresh[i], error: !!el.error, networkState: el.networkState, inUse })) {
        el.load();
        s.ready = false;
        lastSeekAt.delete(el);
        arm(i, s.clip, el);
        // Standby slots bypass driveMedia: paused back at the start of the next clip, just like when switching clips
        if (i === plan.preload) el.currentTime = s.clip.offset;
      }
      completeSeen.current[i] = doneNow && (completeSeen.current[i] || fresh[i] || inUse);
      if (i === plan.active && cur) {
        // Audio fades as video fades: audio from the two clips will not overlap to double volume during crossfades
        // An audio media effect card node replaces this video's native soundtrack. The visual remains in
        // its usual slot while AudioLayer loads and plays the generated WAV separately.
        const target = targetTimeOf(cur.clip, t);
        // Re-register rVFC if deviation crosses the "should seek when paused" gate (see armFrame)
        if (Math.abs(el.currentTime - target) > 0.03) armFrame(el, i);
        driveMedia(el, { target, playing, volume: shouldMuteNativeAudio(project, cur.clip, muted) ? 0 : cur.opacity * gain * (cur.clip.audioVolume ?? 1), scrubbing, rate: clipSpeed(cur.clip) });
        slots.current[i].opacity = cur.opacity;
      } else if (i === plan.warm && cur) {
        // Foreground decoded frames during playback may lag behind stage clock; warm-up tier follows
        // foreground directly to avoid seeking into the future upon initial mounting.
        const front = plan.shown !== null ? els[plan.shown].current : null;
        driveMedia(el, { target: playing && front ? front.currentTime : targetTimeOf(cur.clip, t), playing, volume: 0, scrubbing, rate: clipSpeed(cur.clip) });
        if (playing && front && el.playbackRate !== front.playbackRate) el.playbackRate = front.playbackRate;
      } else {
        releaseMedia(el);
      }
      // Fallback: cases like seeking in place within the same file will not deliver new frames, so rVFC
      // does not fire; counts as ready if decoding is done and timestamps align
      // Warm-up slot: while paused in place, if current frame is decoded (HAVE_CURRENT_DATA) and aligned,
      // it also counts as ready (staying in place will not deliver new frames, frame callbacks will never
      // arrive); during playback only alignment reported by frame callbacks is accepted
      const settle = i === plan.warm
        ? !playing && el.paused && aligned(i, s.clip ?? ({} as SlotClip), el.currentTime)
        : !!s.clip && inClipRange(s.clip, el.currentTime);
      if (s.clip && !s.ready && !el.seeking && el.readyState >= 2 && settle) {
        s.ready = true;
        bump();
        if (i === plan.shown || i === plan.active) onMediaFrame?.(el.currentTime);
      }
    }
    shownRef.current = plan.shown;
    if (plan.warm !== null) warming.add(warmKey);
    else warming.delete(warmKey);
  });

  // Do not leave timers or "catch up once settled" touching elements that no longer exist upon unmount
  useLayoutEffect(() => {
    const a = el0.current;
    const b = el1.current;
    return () => {
      releaseMedia(a);
      releaseMedia(b);
      warming.delete(warmKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * This outer layer is the **clip frame** (clip.frame): fills the screen if there is no frame,
   * as before; if a frame is set, positions according to the frame: written to by set_rect /
   * set_position / align / nudge, and dragging in preview.
   * Previously the media layer did not recognize this field, so setting video positions wrote the data
   * but nothing moved; only cards showed any effect.
   */
  const effFrameOf = (clip: TrackClip | null) =>
    clip?.frameExpr
      ? resolveClipFrameAt(clip.frame, clip.frameExpr, Math.max(0, t - clip.start), clip.end - clip.start)
      : clip?.frame;
  const boxOf = (clip: TrackClip | null) => ({ position: "absolute" as const, overflow: "hidden" as const, ...frameCss(effFrameOf(clip), stage) });
  const image = cur && !missing && isImageMedia(cur.media) && cur.media.url && playbackUrl(cur.media, localHashes) ? cur : null;
  // A1: Assets not yet stored (uploading + computing hash while writing to disk) have no address;
  // this layer renders an "Uploading" placeholder: do not attach an empty src (an empty src is
  // treated as the page address, showing broken images in <img> and decode errors in <video>).
  // Once uploaded, media.url becomes /@media/<hash>, and the placeholder disappears automatically.
  const uploading = cur && cur.media.pending && !cur.media.url ? cur : null;
  // C6.6: Polling responded, but the tier this layer needs to mount has not fully arrived on the
  // current asset service: the image is transparent, with "Waiting for uploader" shown in the corner
  // (A1 "that layer is transparent and shows a notice"; rendering.md "no layer in the preview is
  // transparent without notice").
  // Assets determined as "confirmed missing" will not arrive: this layer already renders the
  // "Asset not found" placeholder, and no longer stacks "Waiting for uploader".
  const awaiting = cur && !missing && !uploading && cur.media.url && chooseTier(cur.media, localHashes, { probe: false }).awaiting ? cur : null;
  return (
    <>
      {[0, 1].map((i) => {
        const clip = fullOf(i);
        const shown = i === plan.shown;
        const opacity = shown ? (i === plan.active && cur ? cur.opacity : slots.current[i].opacity) : 0;
        return (
          // Slots not shown are hidden with visibility: Chrome 152 was tested to still decode paused videos
          // and still trigger rVFC callbacks even with visibility:hidden.
          // D3 step 4: write data-pc-clip on **the visible slot** so media clips enter rects() / hitTest;
          // do not write on hidden slots (if written, there would be two wrapper layers with the same clipId,
          // and rects deduplicating by clipId might pick the hidden one).
          <div key={i} data-pc-clip={shown && clip && !missing ? clip.id : undefined} data-pc-media={shown && clip && !missing ? "" : undefined}
            style={{ ...boxOf(clip), visibility: shown && !missing ? "visible" : "hidden" }}>
            {/* When src is an empty string, pass undefined: `<video src="">` is treated by the browser as
 * "downloading the current page again", see srcOf in FrameScene */}
            <video
              ref={els[i]}
              src={plan.load[i]?.url || undefined}
              muted={muted}
              playsInline
              preload="auto"
              style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", opacity, filter: clip ? filterOf(clip, filters, t) : undefined }}
            />
          </div>
        );
      })}
      {missing && <div data-pc-clip={missing.clip.id} data-pc-media="" data-pc-confirmed-missing="1" style={{ ...boxOf(missing.clip), opacity: missing.opacity, filter: filterOf(missing.clip, filters, t), pointerEvents: "none" }}>
        <MissingMaterial name={missingMaterialLabel(missing.media)} />
      </div>}
      {image && (
        <div key={`${image.clip.id}:${awaiting ? "wait" : "ok"}`} data-pc-clip={image.clip.id} data-pc-media="" style={boxOf(image.clip)}>
          <img src={playbackUrl(image.media, localHashes) || undefined} alt="" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", opacity: image.opacity, filter: filterOf(image.clip, filters, t) }} />
        </div>
      )}
      {uploading && (
        <div
          key={`pending-${uploading.clip.id}`}
          data-pc-media-pending="1"
          style={{ ...boxOf(uploading.clip), display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.35)", color: "rgba(255,255,255,.72)", fontSize: 14 }}
        >
          Uploading…
        </div>
      )}
      {awaiting && (
        <div key={`awaiting-${awaiting.clip.id}`} data-pc-media-awaiting="1" style={{ ...boxOf(awaiting.clip), pointerEvents: "none" }}>
          <span style={{ position: "absolute", left: 16, bottom: 16, padding: "4px 16px", borderRadius: 999, background: "rgba(0,0,0,.45)", color: "rgba(255,255,255,.8)", fontSize: 28 }}>
            Waiting for the uploader
          </span>
        </div>
      )}
    </>
  );
}
