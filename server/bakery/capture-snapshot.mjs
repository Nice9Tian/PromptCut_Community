import { prepareFrameMedia } from './frame-media.mjs';
import { captureFrame } from './capture-frame.mjs';

const SNAPSHOT_PRIME_SHOT = Object.freeze({ format: 'jpeg', quality: 0 });

/**
 * Single in-page implementation that sanitizes snapshot HTML, mounts `#pc-frame-snapshot`,
 * and waits for image decode and font readiness. Accepts either a raw HTML string or an
 * in-page snapshot object `{ html, lossy }` passed via a Puppeteer JSHandle.
 */
async function mountSnapshotDom(input) {
  let h = input;
  if (input && typeof input === 'object') {
    if (input.lossy) return { lossy: input.lossy, hasMedia: false, mounted: false };
    h = input.html;
  }
  const root = document.getElementById('root');
  if (root) { root.dataset.pcDisplay = root.style.display; root.style.display = 'none'; }
  const box = document.createElement('div');
  box.id = 'pc-frame-snapshot';
  box.style.cssText = 'position:absolute;left:0;top:0';
  const template = document.createElement('template');
  template.innerHTML = h;
  // Portable snapshots are data, never an executable page restored from a .proc file.
  template.content.querySelectorAll('script,iframe,object,embed,base,meta,link').forEach(el => el.remove());
  for (const element of template.content.querySelectorAll('*')) {
    for (const attr of [...element.attributes]) {
      if (/^on/i.test(attr.name) || /^(?:javascript|vbscript):/i.test(attr.value.trim())) element.removeAttribute(attr.name);
    }
  }
  box.appendChild(template.content);
  document.body.appendChild(box);
  document.documentElement.getBoundingClientRect();
  // A missing optional image should render as an empty layer, just like the
  // live export page.  `decode()` rejects for a broken URL; letting that
  // reject the whole frame would make one unavailable asset block every
  // other track and would diverge from the normal browser preview.
  await Promise.all([...box.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
  await document.fonts.ready;
  return { lossy: 0, hasMedia: !!box.querySelector('video[data-pc-media-src], img[data-pc-media-src]'), mounted: true };
}

async function unmountSnapshotBox(bakery) {
  await bakery.page.evaluate(() => {
    const box = document.getElementById('pc-frame-snapshot');
    for (const v of box?.querySelectorAll('video') || []) { v.removeAttribute('src'); v.load(); }
    box?.remove();
    const root = document.getElementById('root');
    if (root) { root.style.display = root.dataset.pcDisplay || ''; delete root.dataset.pcDisplay; }
  });
}

/**
 * A, B->C and export all rasterize the same frozen HTML in the same document.
 *
 * `options` (D4(b) `/api/cards/layout`):
 *   - `afterFonts(page)`: **position hardcoded after `document.fonts.ready` and before `prepareFrameMedia`**:
 *     too early measures text boxes with fallback fonts; too late and assets are already reloaded,
 *     where `<video>` would push the layout out of place.
 *   - `screenshot: false`: runs only hooks, **completely skips `captureFrame`** (layout requests do
 *     not pay for an unnecessary 1080p PNG); returns the hook result instead of PNG.
 */
export async function captureSnapshot(bakery, html, screenshot = { format: 'png', optimizeForSpeed: true }, options = {}) {
  const state = (await bakery.page.evaluate(mountSnapshotDom, html)) || { lossy: 0, hasMedia: false, mounted: true };
  if (state.lossy) throw new Error(`Cannot snapshot ${state.lossy} canvas elements`);
  try {
    const hooked = options.afterFonts ? await options.afterFonts(bakery.page) : undefined;
    /*
     * Do not load assets if not capturing screenshots. Assets exist only for visuals: this layout pass
     * neither rasterizes, and contentBox for media clips is calculated from project data (D4(b)) anyway,
     * so reloading them is purely a wasted decode: moreover, missing asset files would crash the entire
     * query ("Video decode failed"), which is precisely a scenario where boxes must still be returned.
     * The hook position is unaffected: it was already before prepareFrameMedia in the first place.
     */
    if (options.screenshot === false) return hooked;
    if (state.hasMedia) await prepareFrameMedia(bakery);
    return await captureFrame(bakery, screenshot, undefined, {
      prime: true,
      primeScreenshot: SNAPSHOT_PRIME_SHOT,
      skipReady: !state.hasMedia && !options.afterFonts,
    });
  } finally {
    if (state.mounted !== false) await unmountSnapshotBox(bakery);
  }
}
