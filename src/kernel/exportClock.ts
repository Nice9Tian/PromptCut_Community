import { installPinnedEntropy } from "./pinEntropy";

/**
 * Page clock quantization in export mode.
 *
 * The export script advances virtual time by one step each frame, but where React commits and rAF
 * callbacks land within this step depends on how much virtual time was consumed during page load,
 * which differs across two exports. Any animation reading performance.now() or rAF timestamps
 * (Motion frame loops, third-party rAF loops) will consequently drift by fractional frames.
 *
 * Here both are pinned to the current frame's export millisecond window.__pcExportMs: no matter
 * when callbacks run within the same frame, the time read is identical, achieving frame-by-frame
 * determinism. Web Animations / CSS animations do not follow this route; ExportView's
 * __pcSyncAnims explicitly pins currentTime on every frame.
 *
 * ⚠ There are actually **three** clocks on the page; the third was never documented and is the
 * source of a batch of determinism bugs:
 *   1. performance.now(): pinned here to __pcExportMs, starting from 0 on each pass.
 *   2. CDP virtual time: advanced one step per frame by the export script.
 *   3. document.timeline.currentTime: WAAPI's own timeline, **monotonically increasing and never
 *      resetting to zero**, and the unbudgeted policy:'advance' in server/bakery/bake.mjs shoot()
 *      causes it to surge by billions of milliseconds in one go on static frames (measured in one
 *      pass to accumulate 2.6 billion ≈ 33 days).
 * Motion sets startTime to time.now() when creating WAAPI animations, which is clock #1's reading
 * (export milliseconds), while WAAPI interprets it using clock #3: the two coordinate systems do
 * not align, so an animation may overshoot endTime and become finished upon creation;
 * __pcSyncAnims then explicitly skips finished, immediately rendering the card in its final state.
 * The patchAnimate() below cuts off the influence of clock #3 on the visuals.
 *
 * Installed only in export view; falls back to the real clock when __pcExportMs is not yet in
 * place (before timeline loading).
 */
export function installExportClock(): void {
  const w = window as Window & { __pcExportClockInstalled?: boolean };
  if (w.__pcExportClockInstalled) return;
  w.__pcExportClockInstalled = true;

  const realNow = performance.now.bind(performance);
  performance.now = () => (typeof window.__pcExportMs === "number" ? window.__pcExportMs : realNow());

  const realRaf = window.requestAnimationFrame.bind(window);
  // Keep a copy of original rAF for export script: it waits for rAF each frame, and going through
  // the wrapped layer would bump __pcRafCount, making static determination permanently false.
  window.__pcRealRaf = realRaf;
  window.__pcRafCount = 0;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    // Counter used for static frame determination: see explanation of __pcRafCount in clock.ts.
    window.__pcRafCount = (window.__pcRafCount ?? 0) + 1;
    return realRaf((ts) => cb(typeof window.__pcExportMs === "number" ? window.__pcExportMs : ts));
  };
  /*
   * Regarding rAF running multiple times in screenshot window: conclusion: **ignore it**, do not add
   * anything more here. That short stretch of virtual time during screenshots runs freely, and rAF
   * triggers multiple times at real tempo. Previously there was concern that loops like canvas
   * particles would take extra steps because of this; two blocking approaches were tried, both wrong:
   *   - CDP Emulation.setScriptExecutionDisabled: dropping pending rAF callbacks entirely killed
   *     Motion's frame loop, completely freezing animations from frame 5 onwards: three passes froze
   *     identically and byte-by-byte comparisons revealed nothing; it was only caught by comparing
   *     frame 10 and frame 30 within the same pass.
   *   - Holding back callbacks in this wrapper and firing after capture: changed which vsync
   *     callbacks landed on, causing 1/5 jitter on the word-rotate transition frame; without holding
   *     it back it was 0/5.
   * In practice, leaving it unblocked is also deterministic: timestamps are pinned, so extra ticks
   * in the same frame compute the same number for time-reading loops (Motion, word-rotate), while for
   * delta-driven loops (tsParticles), a delta of 0 is just an idle spin: particles had 0 differences
   * across 6 passes.
   */

  /*
   * DOM mutation counter: the primary driver for static frame determination.
   *
   * The rAF counter above cannot catch Motion's JS animations: motion-dom's frameloop stores original
   * requestAnimationFrame into the batcher (frameloop/frame.mjs) during **module evaluation**, and
   * ESM import evaluation happens before this function is called, so substitution never reaches it.
   * Advancing installation timing could cover it, but that would also swap out the timestamp source
   * Motion receives: tampering with the foundation of determinism for a heuristic is not worth it.
   *
   * Take another approach: however JS animations bypass rAF, they must write new values back to style
   * or text nodes each frame; that cannot be avoided. So watch DOM mutations. This also covers the
   * frames where cards remount (getAnimations() is still empty then because Motion waits until the
   * next frame to build animations, while visuals are already changing).
   */
  patchAnimate();

  /*
   * Pinning random numbers / wall clock / crypto: moved to pinEntropy.ts.
   * Normally it is already installed by render/stageClockEntry.ts before all imports (third-party
   * libraries capture Math.random at module load time, so installing late cannot reach them); calling
   * it here again is just a fallback, and duplicate calls are no-ops. Previously Math.random here fell
   * back to true randomness before the timeline was ready: lottie expression randomness leaked in
   * through exactly that hole, see the header comment of pinEntropy.ts. __pcResetRandom is provided
   * by it, and __pcRestartCards calls it as usual to rewind the seed to the start.
   */
  installPinnedEntropy();

  window.__pcMutationCount = 0;
  new MutationObserver((records) => {
    window.__pcMutationCount = (window.__pcMutationCount ?? 0) + records.length;
  }).observe(document.documentElement, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
}

/**
 * Pause WAAPI animations at 0 upon creation, leaving time exclusively driven by __pcSyncAnims
 * thereafter.
 *
 * Why this is done: when Motion creates WAAPI animations, it writes startTime as time.now()
 * (= pinned performance.now, which is export milliseconds, starting from 0 each pass), while
 * WAAPI interprets startTime using document.timeline.currentTime: the latter increases
 * monotonically and never resets to zero, surging into billions in a single pass (see "three clocks"
 * in the file header). Thus "what timeline has already reached the moment rendering begins" directly
 * dictates whether newly created animations are born finished:
 *   - Reusing the same document for two consecutive passes: on the second pass timeline has reached
 *     16.4 billion, so all animations are born finished; __pcSyncAnims skips finished, rendering
 *     cards straight into their final state: rank-bars differs by 26 frames, growth-curve by 65.
 *   - Even opening a fresh page for each pass is unsafe: whether timeline is 590 or 650ms at render
 *     start depends on how long that load took, so animations whose endTime falls in this window
 *     (rank-bars first row: delay 0 / dur 500) randomly finish upon birth. Testing two fresh
 *     browsers rendering the same rank-bars showed a 16-frame difference (frames 0-11 missed the
 *     entire row entrance), meaning **the existing one-off export path was never deterministic in
 *     the first place**, like flipping a coin twice and often landing on the same side.
 *
 * Fix: pause animations as soon as created and pin to 0, swallowing the JS setter for startTime on
 * this instance (Motion itself noted in NativeAnimationExtended comments: "setting startTime on a
 * paused WAAPI animation will unpause it"). From then on animation time comes entirely from
 * __pcSyncAnims anchors, independent of timeline. Tested (90 frames / 1920x1080 / 30fps / PNG byte-
 * by-byte comparison): reusing bakery for two renders, rank-bars 26 → 0 frames; between two fresh
 * browsers, rank-bars 16 → 0 frames; odometer / ring-metric / type-shift were originally 0 and not
 * broken. The 65 frames in growth-curve also vanished, though it has another fixed 23-pixel residual
 * per frame (antialiasing on glass plate rounded corners, occurring equally in fresh vs fresh,
 * unrelated to this fix), see the header comment in server/bakery/chrome.mjs.
 *
 * ⚠ This change must be paired with settle() (draining React's pending commits) each frame in
 * server/bakery/bake.mjs: once animations actually play, "which frame card mount commits land on"
 * starts affecting visuals, something that previously raced against screenshots in the screenshot
 * window. Adding only this layer without settle causes npm run verify to show red for 12 frames at
 * card transitions on the demo timeline; with both present it is 90/90.
 *
 * ⚠ Convention: animation.startTime is always null in export pages; do not perform arithmetic with
 * it. a.finish() follows internal specification logic without passing through this accessor,
 * converging to endTime as usual.
 * ⚠ Export artifacts will change (correctly): animations with endTime less than "timeline when render
 * starts" never played entrances before, and now fade in normally. Any pixel-by-pixel baseline
 * snapshots must be regenerated.
 *
 * The render plane (?stage=1, render/stageClock.ts) also installs this layer for the exact same
 * reason: performance.now there is likewise taken over as stage time starting from 0, while
 * document.timeline remains real time. In testing, scrubbing to t=0.1s showed all 20 animations in
 * export page paused at 100ms, while all 20 in preview page were finished (currentTime 1440):
 * entrance animations in preview always jumped straight to final state, failing to match export;
 * after installing this, differences between preview and export returned to antialiasing levels.
 */
export function patchAnimate(): void {
  const w = window as Window & { __pcAnimatePatched?: boolean };
  if (w.__pcAnimatePatched) return;
  w.__pcAnimatePatched = true;
  const realAnimate = Element.prototype.animate;
  Element.prototype.animate = function (
    this: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ): Animation {
    const a = realAnimate.call(this, keyframes, options);
    try {
      a.pause();
      a.currentTime = 0;
      Object.defineProperty(a, "startTime", { get: () => null, set: () => {}, configurable: true });
    } catch {
      // Let abnormal implementations pass: better for this animation to be nondeterministic than
      // crashing the entire export page
    }
    return a;
  };
}
