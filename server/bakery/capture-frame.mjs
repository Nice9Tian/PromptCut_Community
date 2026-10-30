import { waitFrameReady } from './frame-ready.mjs';
import { pngIntegrityError } from './png-integrity.mjs';

/** A compositor tick can acknowledge beginFrame before a surface is ready.
 * Retry at the same timeline time, bounded to four attempts. Never reset the
 * animation or return the previous frame when Chrome has not supplied pixels.
 *
 * `prime`: when no screenshot was requested for a while and the DOM changed a
 * few ticks ago, Chrome's next screenshot can return an older drawn frame
 * although the DOM is current (Tokyo project: sparse frame 200 came back at
 * alpha 44 with the card at opacity 1; a `--frames 155-156` export's first
 * frame showed the previous card; scripts/verify-stale-capture.mjs reproduces
 * it). One discarded screenshot at the same timeline time brings the drawn
 * output up to date. Measured: it does not change animation state (a primed
 * and an unprimed capture of the same frame are pixel-identical). Callers skip
 * it only when they captured the immediately preceding timeline frame.
 *
 * `clip` (R8 / G1, optional): capture only this stage rectangle `{ x, y, w, h }`
 * (integers, already expanded to even width and height by the caller). The
 * beginFrame screenshot has no clip parameter of its own, so the rectangle is
 * applied as the visible viewport of the device-metrics override: layout is
 * not affected (the page still sees its full viewport; measured: innerWidth and
 * element boxes unchanged), only the drawn surface shrinks. It also makes the
 * PNG encode proportionally cheaper (1920×1080 → 400×240: 29 ms → 3 ms per
 * shot on this machine). `clip: null` restores the full viewport. Callers that
 * never pass `clip` are unaffected: no CDP call is made for them.
 */
export async function captureFrame(bakery, screenshot, signal, { prime = true, clip } = {}) {
  if (clip !== undefined) await applyCaptureClip(bakery, clip);
  if (bakery.page) await waitFrameReady(bakery, signal);
  if (prime) {
    if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
    await bakery.beginFrame({ screenshot });
  }
  let corruption = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
    const result = await bakery.beginFrame({ screenshot });
    if (result.screenshotData) {
      const buffer = Buffer.from(result.screenshotData, 'base64');
      // Chrome occasionally returns a PNG whose IDAT bytes fail their CRC
      // (Tokyo export: one frame in 2661). ffmpeg's PNG pipe then drops that
      // frame and can lose sync for the rest of the movie. The timeline has
      // not moved, so a new tick paints the same frame.
      corruption = screenshot?.format === 'png' ? pngIntegrityError(buffer) : null;
      if (!corruption) return buffer;
      console.warn('[capture-frame] corrupt PNG screenshot', { attempt: attempt + 1, corruption });
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 8));
      continue;
    }
    // Distinguish a compositor/surface failure from unfinished control loads.
    // Only query on failure; the normal screenshot path stays small.
    if (bakery.page) {
      const state = await bakery.page.evaluate(() => ({
        time: window.__pcExportMs, fonts: document.fonts.status,
        controls: window.__pcFrameWorkStatus?.() || [],
        images: [...document.images].filter(img => img.getAttribute('src') && !img.complete).length,
        videos: [...document.querySelectorAll('video[src]')].map(v => ({ readyState: v.readyState, seeking: v.seeking })),
      }));
      console.warn('[capture-frame] empty compositor screenshot', { attempt: attempt + 1, hasDamage: result.hasDamage, ...state });
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 8));
  }
  throw new Error(corruption
    ? `Chrome returned a corrupt PNG after 4 compositor ticks: ${corruption}`
    : 'Chrome did not return the requested frame after 4 compositor ticks');
}

const sameClip = (a, b) => (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/**
 * Apply (or clear) the capture rectangle on this page. Remembered on the bakery
 * so an unchanged rectangle costs nothing per frame. Anything that resets the
 * device metrics (`page.setViewport`) must forget it: `forgetCaptureClip`.
 */
export async function applyCaptureClip(bakery, clip) {
  const next = clip ? { x: Math.round(clip.x), y: Math.round(clip.y), w: Math.round(clip.w), h: Math.round(clip.h) } : null;
  if (next && (next.w <= 0 || next.h <= 0 || next.w % 2 || next.h % 2)) throw new Error(`capture clip must have a positive even size: ${JSON.stringify(clip)}`);
  if (bakery.captureClip !== undefined && sameClip(bakery.captureClip, next)) return;
  const view = bakery.page?.viewport?.() || {};
  const width = view.width || bakery.viewportWidth || 1920;
  const height = view.height || bakery.viewportHeight || 1080;
  await bakery.client.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: view.deviceScaleFactor || 1, mobile: false,
    ...(next ? { viewport: { x: next.x, y: next.y, width: next.w, height: next.h, scale: 1 } } : {}),
  });
  bakery.captureClip = next;
  // The drawn surface changes size with the override. The first ticks after a
  // resize can come back without pixels (measured: four empty compositor
  // screenshots in a row on a freshly reset page). Spend one discarded, cheap
  // tick here so the next real capture lands on the resized surface.
  await bakery.beginFrame?.({ screenshot: { format: 'jpeg', quality: 0 } }).catch(() => {});
}

/** The device metrics were reset elsewhere (e.g. `page.setViewport`): the next clip must be sent again. */
export function forgetCaptureClip(bakery) {
  bakery.captureClip = undefined;
}
