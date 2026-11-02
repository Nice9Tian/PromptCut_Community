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

/** Video element current frame duration (seconds); null if unreadable (no WebCodecs or duration). Uniform across fixed frame-rate asset frames. */
function frameSpan(v: HTMLVideoElement): number | null {
  if (typeof VideoFrame === "undefined") return null;
  try {
    const frame = new VideoFrame(v);
    const length = frame.duration;
    frame.close();
    return length ? length / 1e6 : null;
  } catch { return null; }
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
  window.__pcHideFrameMedia = () => {
    for (const v of document.querySelectorAll<HTMLElement>("video[data-pc-media-src], img[data-pc-media-src]")) {
      v.style.visibility = "hidden";
      if (v.hasAttribute("src")) {
        if (v.tagName === "VIDEO") (v as HTMLVideoElement).pause();
        v.removeAttribute("src");
        if (v.tagName === "VIDEO") (v as HTMLVideoElement).load();
      }
    }
  };
  window.__pcPrepareFrameMedia = async () => {
    const scope: ParentNode = document.getElementById("pc-frame-snapshot") || document;
    await Promise.all([...scope
      .querySelectorAll<HTMLElement>("video[data-pc-media-src], img[data-pc-media-src]")]
      .map((el) => new Promise<void>((resolve, reject) => {
        if (el.tagName === "IMG") {
          const v = el as HTMLImageElement;
          const loaded = () => finishImage();
          const failed = () => finishImage(new Error(`Image load failed: ${v.dataset.pcMediaSrc}`));
          const finishImage = (error?: Error) => {
            clearTimeout(timer);
            v.removeEventListener("load", loaded); v.removeEventListener("error", failed);
            error ? reject(error) : resolve();
          };
          const timer = setTimeout(() => finishImage(new Error(`Image load timed out: ${v.dataset.pcMediaSrc}`)), 20000);
          v.addEventListener("load", loaded, { once: true });
          v.addEventListener("error", failed, { once: true });
          v.style.visibility = v.dataset.pcMediaHidden === "true" ? "hidden" : "visible";
          v.src = v.dataset.pcMediaSrc!;
          if (v.complete && v.naturalWidth) { clearTimeout(timer); finishImage(); }
          return;
        }
        const v = el as HTMLVideoElement;
        let sought = false, finished = false, presented = false, frameRequest = 0, looseTimer = 0;
        let target: number | null = null;
        const events = ["loadedmetadata", "loadeddata", "seeked", "canplay", "error"];
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          clearTimeout(looseTimer);
          v.cancelVideoFrameCallback?.(frameRequest);
          events.forEach((e) => v.removeEventListener(e, check));
          error ? reject(error) : resolve();
        };
        const check = () => {
          if (v.error) return finish(new Error(`Video decode failed: ${v.dataset.pcMediaSrc} (${v.error.code})`));
          if (v.readyState < 1) return;
          // Add SEEK_LEAD to seek target: pick "the last frame whose timestamp does not exceed requested
          // time", picking the boundary frame when requested time lands exactly on it
          // (same as CARD_SEEK_LEAD in `src/render/cards/mediaSource.ts`; seeking as-is can pick previous
          // frame due to floating-point error + browser truncation to microseconds)
          const requested = Math.max(0, Number(v.dataset.pcMediaTime)) + SEEK_LEAD;
          target = Math.max(0, Math.min(requested, Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.000001) : requested));
          if (!sought) {
            sought = true;
            if (Math.abs(v.currentTime - target) > 0.000001) { v.currentTime = target; return; }
          }
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
        const rejected: string[] = [];
        const onPresented: VideoFrameRequestCallback = (_now, meta) => {
          if (finished) return;
          // A frame may be presented before check() has seen metadata.
          const want = target ?? Math.max(0, Number(v.dataset.pcMediaTime)) + SEEK_LEAD;
          const before = want - meta.mediaTime;
          const span = frameSpan(v);
          const strict = meta.mediaTime <= want + SEEK_LEAD && before < (span ?? LOOSE_WINDOW) + 0.000002;
          if (strict) { clearTimeout(looseTimer); presented = true; check(); return; }
          rejected.push(`${meta.mediaTime.toFixed(3)}@rs${v.readyState}${v.seeking ? "S" : ""}`);
          if (meta.mediaTime <= want + SEEK_LEAD && before < LOOSE_WINDOW) {
            clearTimeout(looseTimer);
            looseTimer = window.setTimeout(() => { if (!finished) { presented = true; check(); } }, LOOSE_ACCEPT_MS);
          }
          frameRequest = v.requestVideoFrameCallback(onPresented);
        };
        frameRequest = v.requestVideoFrameCallback(onPresented);
        const timer = setTimeout(() => {
          const state = `target=${v.dataset.pcMediaTime} current=${v.currentTime} readyState=${v.readyState} seeking=${v.seeking} rejectedPresentations=[${rejected.slice(-4).join(",")}]`;
          finish(new Error(v.readyState >= 2 && !v.seeking
            ? `Video frame was not presented (${state}): ${v.dataset.pcMediaSrc}`
            : `Video seek timed out (${state}): ${v.dataset.pcMediaSrc}`));
        }, 20000);
        events.forEach((e) => v.addEventListener(e, check));
        v.style.visibility = v.dataset.pcMediaHidden === "true" ? "hidden" : "visible";
        v.preload = "auto";
        v.src = v.dataset.pcMediaSrc!;
        v.load();
        check();
      })));
    document.dispatchEvent(new Event("pc:frame-media-ready"));
  };
}
