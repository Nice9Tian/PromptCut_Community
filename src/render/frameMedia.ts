/**
 * 视频 seek 目标比要求的时刻晚 2 ms,不依赖素材帧率;和 `src/render/cards/mediaSource.ts` 的 `CARD_SEEK_LEAD` 同一个数,
 * 也是下面出画判断的容差。不从那里 import:这个模块要在 React 之前装好,不拉素材分档那一串依赖。
 */
const SEEK_LEAD = 0.002;

/** 帧时长读不到时,判「呈现的是不是目标那一帧」用的宽窗(秒):容得下 4 fps 以上的素材 */
const LOOSE_WINDOW = 0.25;
/** 只有宽窗认可、严窗(按帧时长)不认可的呈现,等这么久(ms)仍没有严窗认可的呈现就照宽窗收下,不卡死 */
const LOOSE_ACCEPT_MS = 1000;

/** 视频元素当前帧的时长(秒);读不到(没有 WebCodecs、帧没有时长)给 null。素材帧率不变时每帧一样。 */
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
 * 这一帧的素材(视频 seek / 图片加载)。
 *
 * 原来写在 `server/bakery/frame-media.mjs`(当时在 `scripts/`)、由 puppeteer 的 `evaluateOnNewDocument` 注入;现在是页面
 * bundle 的一部分(J1),但 `window.__pcHideFrameMedia` / `window.__pcPrepareFrameMedia` 这两个
 * 名字和语义原样不动 —— `server/bakery/frame-media.mjs` 的 `prepareFrameMedia`(Node 侧)和
 * `server/bakery/capture-snapshot.mjs` 还是照旧调它们。
 *
 * 必须在 React 之前装好:推进动画的过程中一律不给素材赋 URL。
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
          // seek 目标加 SEEK_LEAD:取「时间戳不超过要求时刻的最后一帧」,要求时刻正好落在帧边界上时取边界上这一帧
          // (同 `src/render/cards/mediaSource.ts` 的 CARD_SEEK_LEAD;原样 seek 时浮点误差 + 浏览器按微秒截断会取到前一帧)
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
