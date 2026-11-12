/**
 * Frame-by-frame prerender on an already-open bakery.
 *
 * Split out from scripts/export-frames.mjs (pure refactor, verbatim move); the bakery itself is in
 * ./chrome.mjs.
 */

import path from 'path';
import fs from 'fs/promises';
import { captureSnapshot } from './capture-snapshot.mjs';
import { captureFrame, forgetCaptureClip, applyCaptureClip } from './capture-frame.mjs';
import { framesInWindow } from '../../src/render/frameWindow.mjs';
import { waitFrameReady } from './frame-ready.mjs';
import { prepareFrameMedia } from './frame-media.mjs';

/**
 * Push-draw: for stepped frames without capturing images, actually draw a tick as well and discard
 * the image.
 *
 * Why (measured on export page on 2026-10-14, runnable via `scripts/probes/push-draw-probe.mjs`):
 *   - `beginFrame` without screenshots does not guarantee that the renderer will run this tick's
 *     main-thread frame. Once something has been drawn on the page, after two or three consecutive
 *     ticks without screenshots, `requestAnimationFrame` stops firing completely until the next tick
 *     with a screenshot (raw rAF counted step-by-step: after mounting a card, 1 1 1 0 0 0 … stays
 *     0; following each step with a discarded screenshot restores it to running every tick).
 *   - Motion waits for the next rAF after mounting to build animations. Therefore, for motion-style
 *     cards mounted at such times, animations are not built until the next frame that is actually
 *     drawn: JS-driven ones count from that moment (Motion specifies that if built >40 ms late, it
 *     does not backdate), while those handed off to WAAPI are anchored to an even later frame by
 *     `__pcSyncAnims`. From then on, they continuously lag behind by that many frames, and no check
 *     can catch it.
 *   - The trigger condition is not "another layer is placed on top", but "there is no rAF on the
 *     tick when this card is mounted": the page first has an earlier-mounted card (on top,
 *     underneath, or non-overlapping, it makes no difference), and then pushes through a card that
 *     enters midway. Stepping through like this happens when exporting only a segment
 *     (`--frames a-b`), sampling frames (`targetFrames`), during stream replay segments, and during
 *     the sparse pass (when there is more than one card on a page). Full export captures screenshots
 *     every frame and is unaffected.
 *
 * Measured pattern (records from the same probe): after a tick with a screenshot, the renderer can
 * still run two or three main-thread frames with "visual changes", and then stops to wait for the
 * next tick with a screenshot; ticks without visual changes do not consume this headroom. Full
 * export captures a screenshot every frame and is always within the headroom.
 *
 * Solution: for stepped frames, append a `beginFrame` with a screenshot (cheapest JPEG, immediately
 * discarded) after `step`, identical to the extra tick when "an image is captured for this frame".
 * Thus the ticks experienced by the page match full export, and frames where images are captured
 * are pixel-for-pixel identical to the same frame in full export.
 *   - **Do not push-draw if there is no visual change in this frame** (`pushDrawNeeded`): `step`
 *     determined static (no running animations, DOM unchanged, no new rAF requests, no visible
 *     canvas or video; see `ExportView`'s `__pcStaticProbe`), this tick also did not report visual
 *     changes (`hasDamage`), and a tick has already been drawn earlier in this pass. Actually
 *     drawing a frame is not cheap (tens of milliseconds per frame for 1920×1080 heavy scenes,
 *     similar to capturing an image), so static frames do not need to pay for it. In practice,
 *     frames with mounted cards on the page are almost always judged as "changing" (with cards
 *     mounted, there is at least one DOM change per frame), so what is saved is mainly frames
 *     without cards;
 *   - Paths that capture images every frame (full export, full-density segments produced following
 *     a lease) do not run a single extra tick, remaining unchanged byte-for-byte;
 *   - Warm-up (`warmUpAt`) is untouched; unrendered leftovers from warm-up are cleared by the first
 *     frame of this pass (the first frame is always drawn, and like the first frame capturing an
 *     image, it draws two ticks);
 *   - Assets are not loaded on push-draw frames (`prepareFrameMedia` runs only before frames with
 *     actual image capture); discarded images are not passed to `onFrame`, not written to disk,
 *     and do not enter the encoder.
 *
 * Shards in parallel export do not push-draw (`export-unified.mjs` and `shards.mjs` pass
 * `pushDraw: false` to them): shards are only cut at frames where "no stateful cards span across"
 * (`src/render/shardPlan.mjs`), and cards pushed through prior to the cut point have all been
 * unmounted by the cut point, so not push-drawing is also correct (verified against the probe's
 * shards check); if push-drawn, each shard would have to actually redraw all preceding frames,
 * making three shards slower than a single process (measured, see report).
 *
 * `PROMPTCUT_PUSH_DRAW=0` (or `opts.pushDraw === false`) turns it off, used only by probes to
 * compare with "before fix"; never set in production.
 */
export const PUSH_DRAW_SHOT = Object.freeze({ format: 'jpeg', quality: 0 });
export function pushDrawEnabled(opts = {}, env = process.env) {
  if (typeof opts?.pushDraw === 'boolean') return opts.pushDraw;
  return String(env?.PROMPTCUT_PUSH_DRAW ?? '1').trim() !== '0';
}
/**
 * Whether to push-draw this stepped frame (see file header). `isStatic`: return value of `step`;
 * `damaged`: whether any tick in this frame reported visual changes (`step.last.damaged`);
 * `drawnBefore`: whether drawing occurred earlier in this pass (or this lease): the unrendered first
 * frame is always drawn; `previousDrawn`: whether the immediately preceding frame was drawn.
 *
 * Reported changes count only if the previous frame was not drawn: after a tick with a screenshot,
 * the next tick without a screenshot always reports a change (measured, even on an empty page),
 * which is an echo of the previous tick. It serves as a fallback for changes invisible to
 * `__pcStaticProbe` (animated images, etc.): such pages push-draw every other frame, never
 * exhausting the renderer's headroom.
 */
export function pushDrawNeeded({ isStatic, damaged, drawnBefore, previousDrawn }) {
  return !drawnBefore || !isStatic || (!!damaged && !previousDrawn);
}
/**
 * Draw a tick and discard it. `prime`: draw an extra tick first: used only on the first frame of
 * this pass (the first frame capturing an image draws two ticks, see `captureFrame`'s `prime`).
 * Like `captureFrame`, if this tick does not yield a visual frame, resend at the same timestamp, up
 * to four ticks; no error is thrown if it fails to yield (this image is discarded anyway). Returns
 * the total number of ticks issued.
 */
export async function drawDiscarded(bakery, prime, signal) {
  const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });
  let ticks = 0;
  if (prime) {
    if (signal?.aborted) throw cancelled();
    await bakery.beginFrame({ screenshot: PUSH_DRAW_SHOT });
    ticks++;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw cancelled();
    const result = await bakery.beginFrame({ screenshot: PUSH_DRAW_SHOT });
    ticks++;
    if (result?.screenshotData) break;
  }
  return ticks;
}

/**
 * Render a range of frames on an already open bakery. Returns parameters for ffmpeg.
 *
 * opts:
 *   format/quality: 'png' with alpha (required for export deliverables), 'jpeg' without (sufficient
 *                   for preview prerenders).
 *                   PNG uses optimizeForSpeed: still lossless (benchmarked byte-for-byte identical
 *                   to standard PNG after decoding), just compresses faster and doubles file size.
 *   staticSkip:     frames with static visuals directly reuse previous image without capturing.
 *                   See ExportView's __pcStaticProbe for criteria.
 *   verifyEvery:    force an actual capture for comparison after consecutively reusing this many
 *                   frames.
 *   targetFrames:   capture only these frames; during fullFrame, only steps back through history
 *                   for cards required by target.
 *   seekFromActiveClips: false preserves reference path advancing from 0, used for pixel-by-pixel
 *                   regression comparison.
 *   glassFrames:    Set<frameNumber>: these frames have assets underneath; after capturing card,
 *                   capture another frosted-glass mask (PAGE_PRELUDE's __bfGlassOn)
 *                   to <out>/glass/%06d.png. Frames without glass write no file; return value's
 *                   glass contains count written and glass blur amount.
 */
export async function bakeFrames(bakery, opts = {}) {
  const { page, client, beginFrame, waitNet } = bakery;
  const outDir = opts.out || 'out';
  const warmFrames = opts.warm ?? 3;
  const format = opts.format === 'jpeg' ? 'jpeg' : 'png';
  const quality = opts.quality ?? 80;
  const wantStaticSkip = opts.staticSkip ?? false;
  const verifyEvery = opts.verifyEvery ?? 10;
  const ext = format === 'jpeg' ? 'jpg' : 'png';

  const framesDir = path.join(outDir, 'frames');
  // When PC_EXPORT_TRACE=1, records page clock and all animation states per frame
  // to <out>/trace.json for troubleshooting determinism issues
  const trace = process.env.PC_EXPORT_TRACE ? [] : null;
  await fs.mkdir(framesDir, { recursive: true });

  const timeline = await page.evaluate(() => window.__pcTimeline);
  if (!timeline) throw new Error('Timeline not found');

  const width = timeline.width || 1920;
  const height = timeline.height || 1080;
  const fps = opts.fps || timeline.fps || 30;
  let startFrame = 0;
  let endFrame = Math.floor((timeline.duration || 20) * fps) - 1;
  if (opts.frames) {
    const [a, b] = opts.frames.split('-').map(Number);
    startFrame = a;
    endFrame = b;
  }
  /*
   * Capture only these frames (discrete sampling). The full visual is stepped forward from the
   * earliest history frame of cards required by target; HTML sampling still covers all history.
   * Preserves original card mount timestamps without skipping frames in interval, avoiding
   * distortion in delta-integrated animations. Steps through in a single pass, capturing screenshots
   * along the way.
   * Static skip must be disabled in this mode: lastBuf might be from dozens of frames ago, and
   * reusing it directly would flatten the timeline.
   */
  const targetFrames = Array.isArray(opts.targetFrames) && opts.targetFrames.length
    ? new Set(opts.targetFrames.map((n) => Math.max(0, Math.round(Number(n)))))
    : null;
  if (targetFrames) {
    startFrame = Math.min(...targetFrames);
    endFrame = Math.max(...targetFrames);
  }
  const staticSkip = targetFrames ? false : wantStaticSkip;
  const frameWindow = opts.fullFrame && targetFrames && opts.seekFromActiveClips !== false && !opts.snapshotOnly && !opts.domCache
    ? await page.evaluate(({ frames, fps }) => {
      if (!window.__pcPlanFrameWindow) throw new Error('Frame window planner is unavailable');
      return window.__pcPlanFrameWindow(frames, fps);
    }, { frames: [...targetFrames], fps }) : null;
  const advanceStartFrame = frameWindow?.startFrame ?? 0;
  const renderRanges = frameWindow?.ranges ?? [[advanceStartFrame, endFrame]];
  const sortedTargets = targetFrames ? [...targetFrames].sort((a, b) => a - b) : [];
  const directFrameAt = frame => frameWindow ? (sortedTargets.find(n => n >= frame) ?? frame) : frame;
  // Mount after planning, including the full-history / HTML paths. This also
  // clears the selection when a bakery is reused for a different kind of pass.
  await page.evaluate(({ clipIds, time, directTime }) => {
    if (!window.__pcSetFrameWindow) throw new Error('Frame window API is unavailable');
    window.__pcSetFrameWindow(clipIds, time, directTime);
  }, { clipIds: frameWindow?.clipIds ?? null, time: advanceStartFrame / fps, directTime: directFrameAt(advanceStartFrame) / fps });
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  // Turn on transparent background once, without using puppeteer's omitBackground (which toggles per
  // capture, and toggling itself triggers repaints)
  if (format !== 'jpeg') {
    await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  }
  const shotParams = format === 'jpeg'
    ? { format: 'jpeg', quality }
    : { format: 'png', optimizeForSpeed: true };

  /*
   * Step Motion's JS frame loop by one tick before generating snapshots.
   *
   * There are two types of animations on cards, with different ways to pin them:
   *   - Those handed to WAAPI (opacity, tweened transform) have currentTime explicitly pinned each
   *     frame by __pcSyncAnims, which getComputedStyle reflects immediately, so snapshots get the
   *     correct values;
   *   - Those driven by Motion's own JS frame loop (spring, MotionValue) write new values to inline
   *     style only when batch processing runs a tick, and nothing pins them.
   * And this tick **runs only when a frame is actually drawn**: benchmarks show that beginFrame
   * without screenshots (including noDisplayUpdates, or sending after creating DOM damage)
   * consistently fails to advance Motion's frameData.timestamp, while those with screenshot can.
   * Thus the full-frame path captures screenshots every frame and DOM is always for the current
   * frame; HTML snapshots are generated before screenshots, capturing stale values written during
   * the previous frame draw: in a pure-sampling snapshotOnly pass where not a single image is
   * captured, the entire duration is frozen at frame 1's phase (punch-pill spring: scale(0.933311)
   * forever after frame 1, whereas export correctly produces 1.0678 → 1.0037 → …).
   *
   * Therefore, draw a tick and discard the image before generating snapshots. Added only on the
   * snapshot side: full-frame export does not generate snapshots, takes no extra steps, and byte-for-
   * byte baseline is unaffected. Use the cheapest image (jpeg quality 0), since it is immediately
   * discarded anyway.
   *
   * `prime`: if nothing was drawn at the previous timestamp (no screenshot captured, nor was this
   * tick stepped), **draw two ticks**. If only one tick is drawn, Motion's value remains at the phase
   * from the previous frame draw: benchmarked on punch-pill capturing only frame 8 (frames 0-7 only
   * advance time without screenshots), after stepping one tick the pill in snapshot is still frame
   * 1's `scale(0.933311)`, while live render is already `none`. This is the same issue and criterion
   * as `captureFrame`'s `prime`: it can only be omitted if the immediately preceding frame was drawn.
   */
  const FLUSH_SHOT = { format: 'jpeg', quality: 0 };
  const flushFrameLoop = async (prime) => {
    if (prime) await beginFrame({ screenshot: FLUSH_SHOT });
    await beginFrame({ screenshot: FLUSH_SHOT });
  };

  const render3DCut = async () => {
    let done = false;
    let failure;
    const pending = page.evaluate(() => window.__pcRender3DCut?.())
      .catch((e) => { failure = e; })
      .finally(() => { done = true; });
    while (!done) {
      await beginFrame();
      if (!done) await new Promise((r) => setTimeout(r, 4));
    }
    await pending;
    if (failure) throw failure;
    await beginFrame();
  };

  /** Capture one: issue a tick and request a screenshot for this tick. At this point animations are
   *  pinned and page clock is quantized; visuals will not change further in this tick.
   *  prime: capture and discard an image first if no screenshot was captured at the previous
   *  timestamp, see captureFrame. primeCapture:false is used only for regression comparisons. */
  const shoot = async (prime = true) => {
    const captureOpts = { prime: prime && opts.primeCapture !== false };
    // MOV/full-scene cache: keep the live scene (including video/image media)
    // visible. HTML snapshots deliberately remove video sources, so they can
    // never be used as the full-frame movie source.
    if (opts.fullFrame) {
      await prepareFrameMedia(bakery);
      if (await page.evaluate(() => !!document.querySelector("canvas[data-pc-3d-cut]"))) {
        await flushFrameLoop(prime);
        await render3DCut();
      }
      return captureFrame(bakery, shotParams, opts.signal, captureOpts);
    }
    if (!opts.glassFrames) {
      // Pixel maps and 3D cuts rasterize hidden source media into canvases before creating the HTML snapshot.
      const { hasPixelMap, has3DCut } = await page.evaluate(() => ({
        hasPixelMap: !!document.querySelector("canvas[data-pc-pixel-map]"),
        has3DCut: !!document.querySelector("canvas[data-pc-3d-cut]"),
      }));
      if (hasPixelMap || has3DCut) {
        await prepareFrameMedia(bakery);
        if (hasPixelMap) {
          await beginFrame();
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        }
      }
      // prime checks only "whether previous frame had screenshot", unaware if renderPass already stepped
      // this frame: prefer drawing an extra tick (idempotent)
      await flushFrameLoop(prime);
      if (has3DCut) {
        await render3DCut();
      }
      const snapshot = await page.evaluate(() => window.__pcCreateSnapshot());
      if (has3DCut) {
        await page.evaluate(() => window.__pcHideFrameMedia?.());
      }
      if (snapshot.lossy) throw new Error(`Cannot snapshot ${snapshot.lossy} canvas elements`);
      return captureSnapshot(bakery, snapshot.html, shotParams);
    }
    await prepareFrameMedia(bakery);
    if (await page.evaluate(() => !!document.querySelector("canvas[data-pc-3d-cut]"))) {
      await flushFrameLoop(prime);
      await render3DCut();
    }
    return captureFrame(bakery, shotParams, opts.signal, captureOpts);
  };

  // How to step a frame is provided by createStepper (shared with bakeStream); whether to capture
  // screenshot is decided by caller
  const step = createStepper(bakery, { fps, directFrameAt, signal: opts.signal, trace });

  // Warm-up stops at start point of this frame stepping; `frameWindow` stays in this closure, passed
  // here to warmUpAt
  const warmUp = () => warmUpAt(bakery, step, { startFrame: advanceStartFrame, warmFrames, frameWindow, signal: opts.signal });

  const totalFrames = targetFrames ? targetFrames.size : endFrame - startFrame + 1;
  const durationSec = (totalFrames / fps).toFixed(3);
  let reused = 0;
  // Push-draw: whether enabled, and total extra ticks issued in this pass for stepped frames
  // (for diagnostics and unit tests only)
  const pushDraw = pushDrawEnabled(opts);
  let pushDrawn = 0;

  /*
   * HTML sampling cache (opts.domCache): after capturing each frame, generate an HTML snapshot of
   * the stage and write it to <out>/dom/%06d.html.gz after gzip. For subsequent recapturing (changing
   * formats, progressive rollout, multi-process parallelism), use scripts/replay-frames.mjs without
   * stepping from frame 0 again. Benchmarked snapshot generation: 10~36 ms/frame, 8~15 KB/frame after
   * gzip. For frames reused via static skip, snapshots also reuse the previous one.
   */
  const domDir = opts.domCache ? path.join(outDir, 'dom') : null;
  const gzip = domDir ? (await import('node:zlib')).gzipSync : null;
  if (domDir) await fs.mkdir(domDir, { recursive: true });
  let domLossy = 0;

  const glassFrames = opts.glassFrames instanceof Set && opts.glassFrames.size ? opts.glassFrames : null;
  const glassDir = glassFrames ? path.join(outDir, 'glass') : null;
  if (glassDir) await fs.mkdir(glassDir, { recursive: true });
  const glass = { dir: glassDir, list: [], blurs: new Set() };
  /** Frosted-glass mask for this frame; returns null if there is no visible glass. Timestamp for
   *  this extra tick remains pinned as usual, with rAF loop idling (see exportClock.ts) */
  const shootGlass = async () => {
    const info = await page.evaluate(() => window.__bfGlassOn());
    if (!info) return null;
    for (const b of info.blurs) glass.blurs.add(b);
    try {
      // Card image was just captured at same timestamp, visuals are up to date, no need to warm up again
      return await shoot(false);
    } finally {
      await page.evaluate(() => window.__bfGlassOff());
    }
  };

  /** Run through all frames. When allowSkip is false, faithfully capture every frame. Returns frame
   *  number of misjudgments, or null if none. */
  const renderPass = async (allowSkip) => {
    let lastBuf = null;  // Previous **actually captured** image
    let lastShotFrame = null; // Frame number of previous actual capture: warm-up can be skipped only if immediately preceding frame was captured
    let lastDrawnFrame = null; // Which frame the previous tick with a screenshot landed on (counts both actual captures and the tick stepped before snapshot generation), see flushFrameLoop
    let lastDom = null;  // Stage from previous snapshot generation (gzipped)
    let runLen = 0;      // Number of consecutive frames reused so far
    // Mask corresponding to previous actual capture: undefined = not captured yet (null = captured,
    // no glass). When static frames reuse card images, masks are reused together
    let lastGlass;
    reused = 0;
    pushDrawn = 0;
    domLossy = 0;
    glass.list = [];
    glass.blurs.clear();
    // Keep disk writes streaming with a small bounded queue.  The old code
    // appended one fs.writeFile Promise per frame; each pending Promise kept
    // its PNG Buffer alive until the whole movie finished, so a long export
    // grew to several gigabytes before ffmpeg even started.
    const writes = [];
    const queueWrite = async (file, data) => {
      writes.push(fs.writeFile(file, data));
      if (writes.length >= 4) await Promise.all(writes.splice(0));
    };
    for (const i of framesInWindow(renderRanges)) {
      /*
       * Cancellation takes effect only between frames: at this point, stepping, draining, and capturing
       * for the previous frame are all finished, so the page is not in midway. Callers (render-worker)
       * can simply replace with a new page based on this, without treating whole browser as suspect and
       * restarting.
       */
      if (opts.signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      const wantShot = targetFrames ? targetFrames.has(i) : i >= startFrame;
      const isStatic = await step(i, wantShot);
      const snapshotWanted = domDir || (opts.onSnapshot && (!opts.snapshotFrames || opts.snapshotFrames.has(i)));
      if (snapshotWanted) {
        await flushFrameLoop(lastDrawnFrame !== i - 1);
        lastDrawnFrame = i;
        const { html, lossy, controls } = await page.evaluate(() => window.__pcCreateSnapshot());
        if (lossy) throw new Error('HTML snapshot contains unreadable canvases');
        if (opts.onSnapshot && snapshotWanted) await opts.onSnapshot(i, html, controls);
        if (domDir) await fs.writeFile(path.join(domDir, String(i).padStart(6, '0') + '.html.gz'), gzip(Buffer.from(html, 'utf8')));
      }
      // Unified export first runs a complete HTML sampling pass (B).  That
      // pass intentionally does not write PNGs, but it still has to report
      // progress; otherwise the UI remains at its initial 0/1 for the whole
      // sampling pass and looks frozen on long projects.
      if (opts.onProgress) opts.onProgress(i, totalFrames, { sampled: true });
      if (!opts.quiet && opts.onProgressLog && ((i - startFrame + 1) % 10 === 0 || i === endFrame)) {
        console.log(`Exported frame ${i} (${i - startFrame + 1}/${totalFrames})`);
      }
      if (!wantShot || opts.snapshotOnly) {
        // Push-draw (see file header): if this frame does not capture an image, was not drawn for snapshot
        // generation, and visuals have changed, draw a tick and discard it. Accounted as "captured" so next
        // frame does not need to discard one first
        if (pushDraw && lastDrawnFrame !== i && pushDrawNeeded({ isStatic, damaged: step.last.damaged, drawnBefore: lastDrawnFrame !== null, previousDrawn: lastDrawnFrame === i - 1 })) {
          pushDrawn += await drawDiscarded(bakery, lastDrawnFrame === null, opts.signal);
          lastShotFrame = lastDrawnFrame = i;
        }
        continue;
      }

      let buf;
      let fresh = true;
      if (allowSkip && isStatic && lastBuf) {
        runLen++;
        if (runLen % verifyEvery === 0) {
          // Cheap insurance: force an actual capture and comparison every verifyEvery consecutive reused
          // frames. If mismatched, invalidate the entire pass and rerun
          const real = await shoot(lastShotFrame !== i - 1);
          lastShotFrame = lastDrawnFrame = i;
          if (!real.equals(lastBuf)) { await Promise.all(writes.splice(0)); return i; }
          lastBuf = real;
          buf = real;
        } else {
          buf = lastBuf;
          reused++;
          fresh = false;
        }
      } else {
        runLen = 0;
        buf = await shoot(lastShotFrame !== i - 1);
        lastShotFrame = lastDrawnFrame = i;
        lastBuf = buf;
      }
      const name = String(i).padStart(6, '0');
      // A full export can hand the PNG straight to a local ffmpeg pipe.  The
      // callback is awaited before the next frame, so the screenshot Buffer is
      // released as soon as ffmpeg accepts it and never accumulates in Node.
      if (opts.onFrame) await opts.onFrame(i, buf);
      // Writing to disk does not block the next frame (streaming exports may deliberately skip PNG files)
      if (opts.writeFrames !== false) await queueWrite(path.join(framesDir, `${name}.${ext}`), buf);
      if (fresh) lastGlass = undefined;
      if (glassFrames && glassFrames.has(i)) {
        if (lastGlass === undefined) lastGlass = await shootGlass();
        if (lastGlass) {
          glass.list.push(i);
          await queueWrite(path.join(glassDir, `${name}.png`), lastGlass);
        }
      }
      if (!opts.quiet && (process.env.PC_EXPORT_VERBOSE || (i - startFrame + 1) % 10 === 0 || i === endFrame)) {
        console.log(`Exported frame ${i} (${i - startFrame + 1}/${totalFrames})`);
      }
    }
    await Promise.all(writes.splice(0));
    return null;
  };

  const startTime = Date.now();
  let mismatchAt = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      console.warn(`Static skip misjudged frame ${mismatchAt} (reused frame differs from the real capture), rerunning with skip disabled`);
    }
    await warmUp();
    mismatchAt = await renderPass(staticSkip && attempt === 0);
    if (mismatchAt === null) break;
  }

  if (trace) await fs.writeFile(path.join(outDir, 'trace.json'), JSON.stringify(trace, null, 1));
  if (domDir) {
    // Replay needs aspect ratio, frame rate, and which export page to fetch fonts and stylesheets from
    // (timeline parameter removed: all content is in snapshots)
    const exportUrl = page.url().replace(/([?&])timeline=[^&]*&?/, '$1').replace(/[?&]$/, '');
    await fs.writeFile(path.join(domDir, 'manifest.json'), JSON.stringify({
      width, height, fps, startFrame, endFrame, themeId: timeline.themeId ?? null, exportUrl, lossyCanvases: domLossy,
    }, null, 1));
    if (domLossy) console.warn(`HTML sample cache: ${domLossy} canvases could not be read back as pixels, so they will be empty on replay`);
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Export finished in ${elapsed}s (${totalFrames} frames${reused ? `, ${reused} reused` : ''}${glass.list.length ? `, ${glass.list.length} glass masks` : ''}).`);
  return {
    framesDir, ext, fps, width, height, startFrame, endFrame, advanceStartFrame,
    advancedFrames: renderRanges.reduce((sum, [a, b]) => sum + b - a + 1, 0),
    totalFrames, durationSec, reused, elapsed, domDir, pushDrawn,
    glass: { dir: glass.dir, list: glass.list, blurs: [...glass.blurs] },
  };
}

/**
 * How to step a frame (extracted from `bakeFrames`, **ported verbatim**, reused across `bakeFrames`
 * and `bakeStream`: step 1 of G4).
 *
 * One frame = dispatch time → wait for network → drain → step one tick (rAF after React commits
 * and Motion animation building both occur in this tick) → wait for network → drain → pin
 * animations → drain → probe → wait for assets. Whether to capture screenshot is decided by
 * caller. Returns whether visuals are static for this frame.
 *
 * Outer variables actually used by closure match this signature: `page` / `beginFrame` / `waitNet`
 * destructured from `bakery`, `waitFrameReady(bakery, signal)`, `fps`, `directFrameAt`, and `trace`.
 * `staticSkip` and `frameWindow` remain with caller.
 */
export function createStepper(bakery, { fps, directFrameAt = frame => frame, signal, trace = null }) {
  const { page, waitNet } = bakery;
  // Push-draw needs to know whether any tick in this frame reported visual changes (`hasDamage`);
  // ticks themselves run as usual, merely inspecting the receipt
  const beginFrame = async (extra) => { const result = await bakery.beginFrame(extra); if (result?.hasDamage) step.last.damaged = true; return result; };
  const readyHost = { page, beginFrame, waitNet };
  const step = async (frameIndex, wantTrace) => {
    step.last = { frame: frameIndex, damaged: false };
    // Both counters must be retrieved before stepping and compared after stepping; retrieval and
    // dispatch time are merged into a single evaluate
    const before = await page.evaluate(({ sec, directSec }) => {
      const n = { raf: window.__pcRafCount ?? 0, mut: window.__pcMutationCount ?? 0 };
      window.__pcHideFrameMedia?.();
      window.__pcSetT(sec, directSec);
      return n;
    }, { sec: frameIndex / fps, directSec: directFrameAt(frameIndex) / fps });
    // Requests issued during mounting (dynamic imports, assets) must settle first before stepping this tick
    await waitNet();
    await page.evaluate(() => window.__bfSettle());
    await beginFrame();
    await waitNet();
    /*
     * Drain → pin animations → drain again → probe, completed in a single in-page call.
     * Drain before pinning: queued commits in this tick must settle first so newly created animations
     * are visible to __pcSyncAnims.
     * Drain again after pinning: __pcSyncAnims calls finish() on animations past end point, Motion
     * writes final state to style in onfinish callback: that is a queued task, visible to probe's mut
     * only after draining.
     */
    let probe = await page.evaluate(async () => {
      await window.__bfSettle();
      if (window.__pcSyncAnims) window.__pcSyncAnims();
      await window.__bfSettle();
      return window.__pcStaticProbe ? window.__pcStaticProbe() : null;
    });
    if (probe?.finished) {
      // WAAPI finish events and AnimatePresence's replacement child need a
      // compositor tick, then a React commit and a second tick to create the
      // entering animation. Drain these at the SAME timeline time. Otherwise
      // taking an intermediate screenshot supplies those ticks by accident,
      // and a random seek differs from a sequential export by one subtitle frame.
      const finished = probe.finished;
      for (let pass = 0; pass < 2; pass++) {
        await beginFrame();
        probe = await page.evaluate(async () => {
          await window.__bfSettle();
          window.__pcSyncAnims?.();
          await window.__bfSettle();
          return window.__pcStaticProbe?.();
        });
      }
      if (probe) probe.finished += finished;
    }
    if (trace && wantTrace) trace.push(await page.evaluate((i) => ({
      i, perfNow: performance.now(), timelineNow: document.timeline.currentTime, probeMs: window.__pcProbeMs,
      anims: document.getAnimations().map((a) => [a.playState, a.currentTime, a.startTime, a.effect && a.effect.target && a.effect.target.className && String(a.effect.target.className).slice(0, 24)]),
    }), frameIndex));
    // Wait for network once more: for requests issued by newly mounted components in this tick, there
    // is no guarantee whether requestWillBeSent event or beginFrame reply reaches Node first, and the
    // waitNet above might happen to see 0 in flight. After an in-page round trip, events have caught up;
    // takes no time when there are no requests.
    await waitNet();
    // Extra ticks issued while waiting for ready (which async loaders rely on to advance) also pass
    // through the same wrapper: visual changes they report must likewise be recorded
    await waitFrameReady(readyHost, signal);
    // Considered static only when all four conditions hold simultaneously, missing any will render a
    // corrupted frame: see ExportView's __pcStaticProbe for rationale.
    // finished: number of animations settled by __pcSyncAnims in this frame. The animation jumps to
    // final state in this frame, visuals changed, but after settling anims no longer contains it and
    // DOM did not move: looking only at anims will falsely judge as static in the frame where animation ends.
    const isStatic = !!probe && probe.anims === 0 && probe.finished === 0 && probe.mut === before.mut
      && probe.raf === before.raf && !probe.video && !probe.canvas;
    if (process.env.PC_STATIC_TRACE) {
      console.log(`  static check frame ${frameIndex}: anims=${probe?.anims} finished=${probe?.finished} mut=${before.mut}->${probe?.mut} raf=${before.raf}->${probe?.raf} video=${probe?.video} canvas=${probe?.canvas} => ${isStatic ? 'still' : 'changing'}`);
    }
    step.last.isStatic = isStatic;
    return isStatic;
  };
  /** Most recently stepped frame: `{ frame, damaged, isStatic }` (for push-draw) */
  step.last = { frame: null, damaged: false, isStatic: false };
  return step;
}

/**
 * Warm-up (extracted from `bakeFrames`'s `warmUp` closure, ported verbatim).
 *
 * Warm-up stops at start point of this frame stepping, cannot return to 0 to mount irrelevant
 * cards or reset target card's entrance phase. Step an entire frame and discard after remounting:
 * remounting invalidates and repaints entire page, letting this fall on discarded frame.
 * `frameWindow` passed in by caller (frame window planning in `bakeFrames`; always null in
 * `bakeStream`).
 */
export async function warmUpAt(bakery, step, { startFrame, warmFrames = 3, frameWindow = null, signal }) {
  const { page, beginFrame } = bakery;
  // Direct React cards need a layout/capture at t, not animation warm-up or
  // a restart from their clip start. The ordinary step below commits them.
  if (frameWindow && !frameWindow.replayClipIds.length) return;
  console.log(`Warm-up ${warmFrames} frames...`);
  for (let i = 0; i < warmFrames; i++) {
    // Warm-up also checks cancellation: otherwise, cancellation takes effect only after warm-up
    // finishes and enters per-frame loop, keeping worker occupied during this time
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    await step(startFrame, false);
    await beginFrame();
  }
  await page.evaluate(() => { window.__pcRestartCards && window.__pcRestartCards(); window.__pcResetAnims && window.__pcResetAnims(); });
  await drawDiscarded(bakery, true, signal);
  await step(startFrame, false);
  await drawDiscarded(bakery, false, signal);
}

/** Screenshot parameters for track stream: PNG with alpha (consumed by ffmpeg's image2pipe),
 *  matching bakeFrames's PNG specifications */
const STREAM_SHOT = { format: 'png', optimizeForSpeed: true };

/**
 * Continuous frame output for track stream (step 2 of G4; alongside `bakeFrames`, **`bakeFrames`
 * behavior unchanged verbatim**).
 *
 * Attaches a "stream lease" `{ streamSignature, lastFrame, stepper, dirty }` to bakery:
 *
 *   - **Lease match** (same stream, `fromFrame === lastFrame + 1`, not dirtied by others): skip
 *     `__pcSetFrameWindow` and warm-up, and continue stepping frame-by-frame from current page state
 *     using `stepper` in lease (`window.__pcExportMs` holds previous frame's value, `__pcSetT` steps
 *     as usual). Producing N consecutive segments incurs page navigation cost only once;
 *   - **Otherwise** (first run, stream switch, segment jump, signature change, `dirty`): take
 *     `bakeFrames` remount path: `__pcSetFrameWindow(null, …)` (**`clipIds` always null**:
 *     mounting deferred to `FrameScene` activity criteria; cards entering later in continuous mode
 *     mount as usual), warm-up, and pay for a full replay from mount frame (without capturing
 *     screenshots).
 *
 * The page loads the **isolated project for this stream** (brought in via `bakery.reset` by caller
 * upon broken lease), so even when all members mount, the page contains only pixels from this stream;
 * `clip` further confines screenshots within G1 expanded bounding box.
 *
 * opts:
 *   streamSignature      stream signature (lease breaks if changed)
 *   fromFrame / toFrame  **global** frames to output in this pass (closed interval; one segment is
 *                        15 frames)
 *   stride               capture every N frames (G2 sparse segments; 1 = full density)
 *   mountFrame           earliest mount frame across cards in this stream (`mountFrameOf`); replayed
 *                        from min(it, fromFrame) upon broken lease
 *   clip                 capture rectangle `{ x, y, w, h }` (even width/height), see `captureFrame`
 *   hasMedia             whether isolated project contains asset layers (only then call
 *                        `prepareFrameMedia` before capture)
 *   beforeCapture        `(frame) => Promise`: hook before capture (tested for entity boxes, G1)
 *   capture              `(frame, shoot, { primed }) => Promise`: how this frame is fetched is
 *                        decided by caller (canvas direct capture in `./capture-canvas.mjs`):
 *                        whatever it returns is received by `onFrame`; `shoot()` is original
 *                        capture (returns PNG), `primed` indicates whether it discards one first.
 *                        omitted = capture screenshot every frame
 *   onFrame              `(frame, png) => Promise`: hand off frame-by-frame, `await` provides
 *                        backpressure (G4: encoder double buffering relies on this)
 *   signal               takes effect only between frames
 *
 * Returns `{ reset, replayed, captured, captureMs, stepMs, pushDrawn, pushDrawMs }` (for scheduler
 * to measure `firstMs` / `frameMs`; the latter two are extra ticks issued and milliseconds spent
 * on push-draw, see file header).
 */
export async function bakeStream(bakery, opts) {
  const { page, client } = bakery;
  const { streamSignature, fromFrame, toFrame, signal } = opts;
  if (!streamSignature) throw new Error('bakeStream needs a stream signature');
  if (!Number.isInteger(fromFrame) || !Number.isInteger(toFrame) || fromFrame < 0 || toFrame < fromFrame) throw new Error(`bakeStream frame range is invalid: ${fromFrame}..${toFrame}`);
  const stride = Math.max(1, Math.round(Number(opts.stride) || 1));
  const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });
  let lease = bakery.streamLease;
  // A replaced page (`bakery.reset` replaced with a new page) also counts as broken: stepper in lease
  // is bound to old page
  const continues = !!lease && !lease.dirty && lease.page === page && lease.streamSignature === streamSignature && fromFrame === lease.lastFrame + 1;
  let reset = false;
  if (!continues) {
    const timeline = await page.evaluate(() => window.__pcTimeline);
    if (!timeline) throw new Error('Timeline not found');
    const fps = opts.fps || timeline.fps || 30;
    const width = timeline.width || 1920;
    const height = timeline.height || 1080;
    const startFrame = Math.max(0, Math.min(fromFrame, Number.isInteger(opts.mountFrame) ? opts.mountFrame : fromFrame));
    const stepper = createStepper(bakery, { fps, directFrameAt: frame => frame, signal, trace: null });
    // Mounting deferred to FrameScene activity criteria: clipIds is always null (task brief "won't do":
    // bakeStream with non-empty clipIds)
    await page.evaluate(({ time }) => {
      if (!window.__pcSetFrameWindow) throw new Error('Frame window API is unavailable');
      window.__pcSetFrameWindow(null, time, time);
    }, { time: startFrame / fps });
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    forgetCaptureClip(bakery);
    await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    // The screenshot rectangle is determined before warmup: changing device metrics resizes the
    // compositing surface, and those few warmup ticks settle it into place.
    if (opts.clip !== undefined) await applyCaptureClip(bakery, opts.clip);
    await warmUpAt(bakery, stepper, { startFrame, warmFrames: opts.warm ?? 3, frameWindow: null, signal });
    lease = bakery.streamLease = { streamSignature, lastFrame: startFrame - 1, lastShot: null, stepper, dirty: false, fps, page };
    reset = true;
  }
  const stats = { reset, replayed: 0, captured: 0, captureMs: 0, stepMs: 0, pushDrawn: 0, pushDrawMs: 0 };
  const pushDraw = pushDrawEnabled(opts);
  /**
   * Frame-push catch-up paint (see file header): for replayed frames and frames in sparse segments
   * where images are not captured, paint one tick each and discard it if visuals changed; book them
   * as "captured", so the next frame does not need to discard one first.
   */
  const drawPushed = async (frame, isStatic) => {
    if (!pushDraw) return;
    const drawnBefore = lease.lastShot !== null;
    if (!pushDrawNeeded({ isStatic, damaged: lease.stepper.last?.damaged, drawnBefore, previousDrawn: lease.lastShot === frame - 1 })) return;
    const started = Date.now();
    stats.pushDrawn += await drawDiscarded(bakery, !drawnBefore, signal);
    lease.lastShot = frame;
    stats.pushDrawMs += Date.now() - started;
  };
  for (let frame = lease.lastFrame + 1; frame <= toFrame; frame++) {
    if (signal?.aborted) throw cancelled();
    const stepStarted = Date.now();
    const isStatic = await lease.stepper(frame, false);
    stats.stepMs += Date.now() - stepStarted;
    lease.lastFrame = frame;
    if (frame < fromFrame) { stats.replayed++; await drawPushed(frame, isStatic); continue; }
    if ((frame - fromFrame) % stride !== 0) { await drawPushed(frame, isStatic); continue; }
    const shotStarted = Date.now();
    await opts.beforeCapture?.(frame);
    if (opts.hasMedia) await prepareFrameMedia(bakery);
    // prime only checks "whether the immediately preceding frame was captured" (same criterion as
    // bakeFrames), and counts across passes too.
    const primed = lease.lastShot !== frame - 1;
    const shoot = async () => {
      const shot = await captureFrame(bakery, STREAM_SHOT, signal, { prime: primed, clip: opts.clip ?? null });
      lease.lastShot = frame;
      return shot;
    };
    // If the caller provides `capture`, it decides how to fetch this frame (direct canvas grab, or
    // call `shoot()` to screenshot as before); if omitted, it falls back to the original single
    // screenshot.
    const png = opts.capture ? await opts.capture(frame, shoot, { primed }) : await shoot();
    stats.captureMs += Date.now() - shotStarted;
    stats.captured++;
    await opts.onFrame?.(frame, png);
  }
  return stats;
}

/**
 * If another call (anchor frame `bakery.reset`, any `bakeFrames`) has run on this session: the
 * lease is invalidated (the `dirty` bit of D5), and the next `bakeStream` is treated as a broken
 * lease and pays for a full replay.
 */
export function dirtyStreamLease(bakery) {
  if (bakery?.streamLease) bakery.streamLease.dirty = true;
}
