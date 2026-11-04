import { prepareFrameMedia } from './frame-media.mjs';
import { captureFrame } from './capture-frame.mjs';

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
  await bakery.page.evaluate(h => {
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
  }, html);
  try {
    await bakery.page.evaluate(async () => {
      const box = document.getElementById('pc-frame-snapshot');
      // A missing optional image should render as an empty layer, just like the
      // live export page.  `decode()` rejects for a broken URL; letting that
      // reject the whole frame would make one unavailable asset block every
      // other track and would diverge from the normal browser preview.
      await Promise.all([...box.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
      await document.fonts.ready;
    });
    const hooked = options.afterFonts ? await options.afterFonts(bakery.page) : undefined;
    /*
     * Do not load assets if not capturing screenshots. Assets exist only for visuals: this layout pass
     * neither rasterizes, and contentBox for media clips is calculated from project data (D4(b)) anyway,
     * so reloading them is purely a wasted decode: moreover, missing asset files would crash the entire
     * query ("Video decode failed"), which is precisely a scenario where boxes must still be returned.
     * The hook position is unaffected: it was already before prepareFrameMedia in the first place.
     */
    if (options.screenshot === false) return hooked;
    await prepareFrameMedia(bakery);
    return await captureFrame(bakery, screenshot);
  } finally {
    await bakery.page.evaluate(() => {
      const box = document.getElementById('pc-frame-snapshot');
      for (const v of box?.querySelectorAll('video') || []) { v.removeAttribute('src'); v.load(); }
      box?.remove();
      const root = document.getElementById('root');
      if (root) { root.style.display = root.dataset.pcDisplay || ''; delete root.dataset.pcDisplay; }
    });
  }
}
