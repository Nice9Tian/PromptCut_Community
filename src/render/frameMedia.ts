/**
 * Video seek target is 2 ms later than the requested timestamp, independent of media frame rate;
 * same number as `CARD_SEEK_LEAD` in `src/render/cards/mediaSource.ts`, and also the tolerance for
 * the out-of-frame check below. Not imported from there: this module must be installed before React,
 * without pulling in that asset tiering dependency chain.
 */
const SEEK_LEAD = 0.002;

/** Wide window (seconds) to determine "whether presentation is target frame" when frame duration is unreadable: accommodates assets of 4 fps or higher */
const LOOSE_WINDOW = 0.25;
/** For presentations accepted only by wide window and not strict window (by frame duration), wait this long (ms); if still none, accept by wide window to avoid hanging */
const LOOSE_ACCEPT_MS = 1000;

interface PresentedVideoState {
  src: string;
  mediaTime: number;
  span: number | null;
}

const activeMedia = new Set<HTMLElement>();
const presentedFrames = new WeakMap<HTMLVideoElement, PresentedVideoState>();

/** Video element current frame duration (seconds) and presentation timestamp; null if unreadable (no WebCodecs or duration). Uniform across fixed frame-rate asset frames. */
function readVideoFrameInfo(v: HTMLVideoElement): { timestamp: number; span: number | null } | null {
  if (typeof VideoFrame === "undefined") return null;
  try {
    const frame = new VideoFrame(v);
    const ts = frame.timestamp;
    const length = frame.duration;
    frame.close();
    return { timestamp: ts / 1e6, span: length ? length / 1e6 : null };
  } catch {
    return null;
  }
}

function matchesStrictWindow(mediaTime: number, span: number | null, want: number): boolean {
  const before = want - mediaTime;
  return mediaTime <= want + SEEK_LEAD && before < (span ?? LOOSE_WINDOW) + 0.000002;
}

function unloadMediaElement(el: HTMLElement): void {
  if (el.tagName === "VIDEO") {
    const v = el as HTMLVideoElement;
    v.pause();
    presentedFrames.delete(v);
  }
  el.removeAttribute("src");
  if (el.tagName === "VIDEO") (el as HTMLVideoElement).load();
  activeMedia.delete(el);
}

/**
 * Hide media before advancing timeline state. Retaining `src` on connected elements that were
 * already prepared on a previous screenshot frame (with unchanged `data-pc-media-src`) does not
 * violate "never assign URLs to assets while advancing animations": newly mounted elements during
 * non-captured advance steps still carry no `src` and trigger zero network/decoder activity, while
 * already-prepared elements stay paused and hidden without reassigning URLs and are unloaded as
 * soon as they leave the DOM or switch `data-pc-media-src`.
 */
function hideFrameMedia(): void {
  for (const el of [...activeMedia]) {
    if (!el.isConnected || !el.hasAttribute("src") || el.getAttribute("src") !== el.dataset.pcMediaSrc) {
      unloadMediaElement(el);
    }
  }
  for (const el of document.querySelectorAll<HTMLElement>("video[data-pc-media-src], img[data-pc-media-src]")) {
    el.style.visibility = "hidden";
    if (!el.hasAttribute("src")) continue;
    if (el.tagName === "VIDEO" && !(el as HTMLVideoElement).paused) (el as HTMLVideoElement).pause();
    if (!activeMedia.has(el) || el.getAttribute("src") !== el.dataset.pcMediaSrc) {
      unloadMediaElement(el);
    }
  }
}

function prepareImage(v: HTMLImageElement): Promise<void> {
  const wantSrc = v.dataset.pcMediaSrc!;
  v.style.visibility = v.dataset.pcMediaHidden === "true" ? "hidden" : "visible";
  if (v.getAttribute("src") === wantSrc && v.complete && v.naturalWidth > 0) {
    activeMedia.add(v);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const loaded = () => finishImage();
    const failed = () => finishImage(new Error(`Image load failed: ${wantSrc}`));
    const finishImage = (error?: Error) => {
      clearTimeout(timer);
      v.removeEventListener("load", loaded);
      v.removeEventListener("error", failed);
      if (error) { unloadMediaElement(v); reject(error); } else resolve();
    };
    const timer = setTimeout(() => finishImage(new Error(`Image load timed out: ${wantSrc}`)), 20000);
    v.addEventListener("load", loaded, { once: true });
    v.addEventListener("error", failed, { once: true });
    activeMedia.add(v);
    v.src = wantSrc;
    if (v.complete && v.naturalWidth) finishImage();
  });
}

function targetTimeOf(v: HTMLVideoElement): number {
  // Add SEEK_LEAD to seek target: pick "the last frame whose timestamp does not exceed requested
  // time", picking the boundary frame when requested time lands exactly on it
  // (same as CARD_SEEK_LEAD in `src/render/cards/mediaSource.ts`; seeking as-is can pick previous
  // frame due to floating-point error + browser truncation to microseconds)
  const requested = Math.max(0, Number(v.dataset.pcMediaTime)) + SEEK_LEAD;
  return Math.max(0, Math.min(requested, Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.000001) : requested));
}

function samePresentedFrame(v: HTMLVideoElement, wantSrc: string, prev: PresentedVideoState | undefined, target: number): boolean {
  if (!prev || prev.src !== wantSrc || prev.span === null) return false;
  const cur = readVideoFrameInfo(v);
  return !!cur && cur.span !== null && Math.abs(cur.timestamp - prev.mediaTime) <= 0.000002
    && matchesStrictWindow(prev.mediaTime, cur.span, target);
}

function prepareVideo(v: HTMLVideoElement): Promise<void> {
  const wantSrc = v.dataset.pcMediaSrc!;
  const prev = presentedFrames.get(v);
  const reuse = activeMedia.has(v) && v.getAttribute("src") === wantSrc && v.readyState >= 1 && !v.error;
  return new Promise<void>((resolve, reject) => {
    let sought = false, finished = false, presented = false, frameRequest = 0, looseTimer = 0;
    let target: number | null = null;
    const events = ["loadedmetadata", "loadeddata", "seeked", "canplay", "error"];
    const rejected: string[] = [];
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(looseTimer);
      v.cancelVideoFrameCallback?.(frameRequest);
      events.forEach((e) => v.removeEventListener(e, check));
      if (error) { unloadMediaElement(v); reject(error); } else resolve();
    };
    const acceptPresented = (mediaTime: number, span: number | null) => {
      clearTimeout(looseTimer);
      presentedFrames.set(v, { src: wantSrc, mediaTime, span });
      presented = true;
      check();
    };
    const check = () => {
      if (v.error) return finish(new Error(`Video decode failed: ${wantSrc} (${v.error.code})`));
      if (v.readyState < 1) return;
      target = targetTimeOf(v);
      if (!sought) {
        sought = true;
        if (Math.abs(v.currentTime - target) > 0.000001) { v.currentTime = target; return; }
      }
      if (!v.seeking && v.readyState >= 2 && !presented && reuse && samePresentedFrame(v, wantSrc, prev, target)) presented = true;
      if (!v.seeking && v.readyState >= 2 && presented) finish();
    };
    // readyState/seeked only mean the frame is decoded. The compositor gets
    // it a few BeginFrames later; a screenshot in between has a transparent
    // video layer (Tokyo project: the first captured frame of a run, and
    // sparse frames 1500/1510 on every attempt). The presented-frame callback
    // is the signal that the settled frame reached the compositor. Measured
    // under beginFrame control, it also fires for covered, hidden, offscreen
    // and zero-size videos.
    // Judge a presentation by its media time, not by seeking/readyState when
    // the callback runs: the sought frame can be presented before `seeked`
    // (observed: mediaTime 12.095 for target 12.1 while readyState was 1),
    // and a paused video presents nothing afterwards. The frame covering the
    // target starts at or just before it, less than one frame duration before
    // (read from the current VideoFrame). A wider window let a stale frame through:
    // a reloaded element first presents frame 0, which passed for any target under
    // 0.25 s even when `seeked` fired before the sought frame reached the
    // compositor. Without a readable duration the old 0.25 s window (sources down
    // to 4 fps) still applies; a presentation only the wide window admits is taken
    // after LOOSE_ACCEPT_MS so odd durations (a video track shorter than the clip)
    // cannot stall the export.
    const onPresented: VideoFrameRequestCallback = (_now, meta) => {
      if (finished) return;
      // A frame may be presented before check() has seen metadata.
      const want = target ?? Math.max(0, Number(v.dataset.pcMediaTime)) + SEEK_LEAD;
      const span = readVideoFrameInfo(v)?.span ?? null;
      if (matchesStrictWindow(meta.mediaTime, span, want)) return acceptPresented(meta.mediaTime, span);
      rejected.push(`${meta.mediaTime.toFixed(3)}@rs${v.readyState}${v.seeking ? "S" : ""}`);
      if (meta.mediaTime <= want + SEEK_LEAD && want - meta.mediaTime < LOOSE_WINDOW) {
        clearTimeout(looseTimer);
        looseTimer = window.setTimeout(() => { if (!finished) acceptPresented(meta.mediaTime, span); }, LOOSE_ACCEPT_MS);
      }
      frameRequest = v.requestVideoFrameCallback(onPresented);
    };
    frameRequest = v.requestVideoFrameCallback(onPresented);
    const timer = setTimeout(() => {
      const state = `target=${v.dataset.pcMediaTime} current=${v.currentTime} readyState=${v.readyState} seeking=${v.seeking} rejectedPresentations=[${rejected.slice(-4).join(",")}]`;
      finish(new Error(v.readyState >= 2 && !v.seeking ? `Video frame was not presented (${state}): ${wantSrc}` : `Video seek timed out (${state}): ${wantSrc}`));
    }, 20000);
    events.forEach((e) => v.addEventListener(e, check));
    v.style.visibility = v.dataset.pcMediaHidden === "true" ? "hidden" : "visible";
    activeMedia.add(v);
    if (!reuse) { presentedFrames.delete(v); v.preload = "auto"; v.src = wantSrc; v.load(); }
    check();
  });
}

/**
 * Asset for this frame (video seek / image loading).
 *
 * Originally written in `server/bakery/frame-media.mjs` (then in `scripts/`) and injected via
 * puppeteer's `evaluateOnNewDocument`; now part of the page bundle (J1), but the two names and
 * semantics `window.__pcHideFrameMedia` / `window.__pcPrepareFrameMedia` remain untouched:
 * `prepareFrameMedia` in `server/bakery/frame-media.mjs` (Node side) and
 * `server/bakery/capture-snapshot.mjs` still call them as before.
 *
 * Must be set up before React: never assign URLs to assets while advancing animations.
 */
export function installFrameMedia(): void {
  window.__pcHideFrameMedia = hideFrameMedia;
  window.__pcPrepareFrameMedia = async () => {
    const scope: ParentNode = document.getElementById("pc-frame-snapshot") || document;
    const els = [...scope.querySelectorAll<HTMLElement>("video[data-pc-media-src], img[data-pc-media-src]")];
    await Promise.all(els.map((el) => el.tagName === "IMG" ? prepareImage(el as HTMLImageElement) : prepareVideo(el as HTMLVideoElement)));
    document.dispatchEvent(new Event("pc:frame-media-ready"));
  };
}
