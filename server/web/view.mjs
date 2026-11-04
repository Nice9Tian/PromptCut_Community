/**
 * The layer that "lets the model see the webpage": an image + a clickable manifest.
 *
 * ## Why not image-only, and why not tree-only
 *
 * Measured in practice (MDN fetch doc page, 1280x800 viewport):
 *   - Full a11y tree: 1362 nodes, 193k characters ≈ 48k tokens. Context fills up after two reads.
 *   - Keep only interactive elements in viewport: 47 elements ≈ 620 tokens.
 *   - Screenshot with 800px long edge ≈ 640 tokens.
 * Image + manifest totals about 1.2k tokens, nearly 40x cheaper than the full tree, while giving
 * the model both vision and callable handles.
 *
 * The division of labor: **image handles "reading", manifest handles "clicking"**, with no overlap
 * between the two. The manifest contains only interactive elements, leaving out all static text:
 * that text is in the image, copying it again would just waste money.
 *
 * ## Why scale the long edge to 800 rather than fixing at 800x600
 *
 * Fixed dimensions change the aspect ratio (1280x800 is 1.6, 800x600 is 1.33), squishing the image
 * horizontally; when restoring coordinates reported by the model back to the page, different axis
 * ratios make errors likely. Matching the long edge + uniform scaling yields **only a single scale**,
 * so forward and reverse transforms both multiply or divide by the same number.
 *
 * ## Why scale with clip.scale instead of deviceScaleFactor, let alone resizing after capture
 *
 * We tried all three approaches:
 *   - Resizing with pngjs after capture: pure CPU resampling, blocking the main thread (see
 *     attitude toward synchronous operations in server/harness/README);
 *   - Changing `deviceScaleFactor` before capturing: **learned the hard way**. In a headed window,
 *     setViewport is a real window resize; while the page is navigating, it hangs: in actual
 *     testing, `web_view` blocked for the full 45-second timeout before returning, and a single
 *     capture requires two round trips (set before capturing, restore after), effectively two resizes;
 *   - `clip.scale`: Chrome outputs the scaled bitmap directly during the compositing phase,
 *     **the viewport stays completely still**, with no resize, no layout reflow, and no restoration
 *     step. This is the way.
 *
 * An added benefit: when the viewport does not change, the coordinate system for elementFromPoint
 * naturally stays unchanged too, so hit testing will not skew due to the screenshot action.
 */
import { VIEWPORT, IMAGE_LONG_EDGE } from './browser.mjs';

/** Image coordinates = page coordinates x scale. Never upscaled: returned as-is when the viewport is smaller than 800 */
export function scaleOf(viewport = VIEWPORT) {
  return Math.min(1, IMAGE_LONG_EDGE / Math.max(viewport.width, viewport.height));
}

/**
 * **Actual current size** of this page. Both screenshots and hit testing must use it, rather than
 * falling back to their own constants.
 *
 * `page.viewport()` returns our configured dimensions when emulation is active, but **returns null
 * without emulation**. In shell mode (the agent browser is a child webview in the Tauri main window),
 * when web_handoff hands the panel to the user, it calls `setViewport(null)` to remove emulation so
 * the webview tracks the panel: calculating with the constant 1280x800 at this point causes two bugs,
 * in two different ways:
 *
 *   1. **Screenshots**: clip is larger than the actual viewport, so puppeteer turns on
 *      captureBeyondViewport, reapplying device metrics emulation: the panel the user is
 *      interacting with instantly misaligns;
 *   2. **Hit testing**: image coordinates are converted back using 1280x800 while the page is
 *      actually a different size, **clicks silently land in the wrong spot**. This is worse than
 *      misalignment because it throws no errors.
 *
 * Therefore both sides fetch from here, only falling back to constants when measurement is unavailable.
 */
export async function liveViewport(page) {
  const vp = page.viewport();
  if (vp && vp.width > 0 && vp.height > 0) return vp;
  try {
    const m = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (m && m.width > 0 && m.height > 0) return m;
  } catch { /* Page crashed / cannot evaluate: falling back to constants is better than throwing */ }
  return VIEWPORT;
}

/** Manifest limit. Dense pages (admin systems, product lists) can have hundreds per screen; returning all is like returning none */
const MAX_ITEMS = 60;

/**
 * The half running inside the page: tags interactive elements with a uid and measures their
 * bounding boxes on the image.
 *
 * The `data-pcuid` set on the DOM is the only contract between view and hit: `click_at` hit testing
 * relies on it to translate "the clicked element" back to a uid. Each capture renumbers elements,
 * so IDs are only valid for the most recent screenshot; this must be explicitly stated in the tool
 * description, otherwise the model will attempt to click `e7` from three rounds ago.
 */
/* c8 ignore start: this function body is serialized and sent into the page for execution, not run in node */
function tagAndList(scale, maxItems) {
  const SEL = 'a[href],button,input,select,textarea,summary,'
    + '[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[contenteditable=true]';
  // Clear marks from the previous round: the page may not have navigated, only scrolled; leftover
  // uids cause hit testing to point to elements no longer in the viewport
  for (const el of document.querySelectorAll('[data-pcuid]')) el.removeAttribute('data-pcuid');

  /**
   * Can this element **actually be clicked** at its location?
   *
   * Simply checking getBoundingClientRect is not enough: it returns layout position, **ancestor overflow
   * clipping is not reflected in it**. In cases like the MDN sidebar where "an element is positioned
   * there but clipped by an ancestor", the rect looks completely normal, yet elementsFromPoint cannot
   * detect it at all: keeping it in the manifest gives the model an unclickable ID, exactly what this
   * repository fears most under the "model can see it but cannot invoke it" rule (see the three aligned
   * comments in server/test/tool-schema.test.mjs).
   *
   * Probe the center plus four inset points: the center being covered by something else is common (e.g.
   * a tooltip covering an icon); as long as one point lands on the element itself (or its descendant),
   * it counts as clickable.
   *
   * Returns 'ok' | 'covered' | 'ghost':
   *   - covered is "present, but covered by an upper layer": keep and mark it; the model needs to know
   *     this button exists, but must close the overlay layer first;
   *   - ghost is "completely undetectable": drop it directly; keeping it only misleads the model.
   */
  const reachability = (el, r) => {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const cx = clamp((r.left + r.right) / 2, 1, innerWidth - 1);
    const cy = clamp((r.top + r.bottom) / 2, 1, innerHeight - 1);
    const inset = Math.min(4, r.width / 4, r.height / 4);
    const pts = [[cx, cy],
      [clamp(r.left + inset, 1, innerWidth - 1), cy],
      [clamp(r.right - inset, 1, innerWidth - 1), cy],
      [cx, clamp(r.top + inset, 1, innerHeight - 1)],
      [cx, clamp(r.bottom - inset, 1, innerHeight - 1)]];
    for (const [x, y] of pts) {
      const stack = document.elementsFromPoint(x, y);
      for (const hit of stack) {
        if (hit === el || el.contains(hit)) return 'ok';
        // Detected something else, but this element is also on the z-axis → covered, not absent
        if (stack.includes(el)) return 'covered';
      }
    }
    return 'ghost';
  };

  const vis = [];
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    // Drop elements completely outside the viewport; **keep those straddling the boundary**: elements
    // half-clipped by the top are visible in the image; if missing from the manifest, the model will
    // think nothing is there
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none') continue;
    const reach = reachability(el, r);
    if (reach === 'ghost') continue;
    vis.push({ el, r, covered: reach === 'covered' });
  }

  // Reading order: first bucket by line (24px per tier, about one line of text), then sort by x within
  // each tier. This aligns the manifest order with the visual top-to-bottom, left-to-right order in the
  // image, so the model can scan against it without rummaging through DOM order
  vis.sort((a, b) => (Math.floor(a.r.top / 24) - Math.floor(b.r.top / 24)) || (a.r.left - b.r.left));

  const total = vis.length;
  // When exceeding limit, keep larger elements by area: misclicking small icons has low cost, large buttons are the primary path
  const kept = total <= maxItems
    ? vis
    : vis.slice().sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height).slice(0, maxItems)
        .sort((a, b) => (Math.floor(a.r.top / 24) - Math.floor(b.r.top / 24)) || (a.r.left - b.r.left));

  const px = (v) => Math.round(v * scale);
  const items = kept.map((o, i) => {
    const u = 'e' + (i + 1);
    o.el.setAttribute('data-pcuid', u);
    const name = (
      o.el.getAttribute('aria-label') || o.el.innerText || o.el.value ||
      o.el.getAttribute('placeholder') || o.el.getAttribute('title') || o.el.getAttribute('alt') || ''
    ).trim().replace(/\s+/g, ' ').slice(0, 40);
    const row = {
      u,
      t: o.el.tagName.toLowerCase(),
      n: name,
      b: [px(o.r.left), px(o.r.top), px(o.r.right), px(o.r.bottom)],
    };
    // Tell the model what is currently in the input box, otherwise it will not know whether to clear it first
    if (o.el.tagName === 'INPUT' || o.el.tagName === 'TEXTAREA') {
      row.v = String(o.el.value || '').slice(0, 30);
      if (o.el.type) row.it = o.el.type;
    }
    // Covered by an upper layer: keep in the manifest (the model needs to know this button exists)
    // but mark it: clicking directly hits the layer above; the correct action is to close the popup/banner first
    if (o.covered) row.covered = true;
    return row;
  });
  return { items, total, url: location.href, title: document.title.slice(0, 120) };
}
/* c8 ignore stop */

/**
 * Captures a screenshot + outputs a manifest. The returned `image` is wrapped in `__image`: that is
 * the shape recognized by `harness/agent.mjs`, which extracts the image from the JSON and attaches
 * it separately to the end of the message (base64 left in the JSON would be fed into history as plain text).
 */
export async function captureView(page, { maxItems = MAX_ITEMS, quality = 70 } = {}) {
  // Use measured dimensions, do not fall back to constants: in shell mode, viewport emulation is removed
  // when the user interacts with the panel; calculating with constants causes clip to go out of bounds
  // and reapplies emulation, immediately misaligning the screen the user is viewing
  const viewport = await liveViewport(page);
  const scale = scaleOf(viewport);

  // Taking a screenshot before navigation settles will wait forever (experienced: hung for the full
  // 45-second timeout). Wait a moment for readyState, but proceed regardless if it times out: half an
  // image is still more useful than a timeout error, and some sites never reach complete.
  await page.waitForFunction(() => document.readyState !== 'loading', { timeout: 8000 })
    .catch(() => { /* On timeout, capture current state as-is; don't drag down the entire action */ });

  const { items, total, url, title } = await page.evaluate(tagAndList, scale, maxItems);

  // clip.scale lets Chrome scale the image during compositing, **the viewport stays completely still**.
  // See file header for why deviceScaleFactor is not used.
  const base64 = await page.screenshot({
    type: 'webp',
    quality,
    encoding: 'base64',
    clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale },
  });

  const img = { width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) };
  return {
    url,
    title,
    image: { width: img.width, height: img.height },
    clickable: items,
    ...(total > items.length
      ? { omitted: total - items.length, note: `${total - items.length} more interactive elements in the viewport are not listed (the largest ${items.length} by area were kept). Scroll and run web_view again, or tell me what you are looking for.` }
      : {}),
    hint: `The image is ${img.width}x${img.height}; b in clickable is the element's pixel bounding box on this image [x1,y1,x2,y2]. The numbers are valid only for this screenshot; after scrolling or navigating you must run web_view again.`,
    __image: { base64, mime: 'image/webp' },
  };
}
