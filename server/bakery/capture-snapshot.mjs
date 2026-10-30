import { prepareFrameMedia } from './frame-media.mjs';
import { captureFrame } from './capture-frame.mjs';

/**
 * A, B->C and export all rasterize the same frozen HTML in the same document.
 *
 * `options`(D4(b) `/api/cards/layout`):
 *   - `afterFonts(page)`:**位置写死在 `document.fonts.ready` 之后、`prepareFrameMedia` 之前** ——
 *     早了量到的是回退字体的文字框,晚了素材已经装回来、`<video>` 会把布局顶掉。
 *   - `screenshot: false`:只跑钩子、**完全跳过 `captureFrame`**(layout 请求不白付一张 1080p PNG),
 *     这时返回的是钩子的结果,不是 PNG。
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
     * 不截图就不装素材。素材只为画面存在:layout 这一趟既不栅格化,素材段的 contentBox
     * 又一律按项目数据算(D4(b)),装回来纯属白付一次解码 —— 而且素材文件缺了会直接
     * 把整次查询打挂("Video decode failed"),而那正是必须照样回框的场景。
     * 钩子的位置不受影响:它本来就在 prepareFrameMedia 之前。
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
