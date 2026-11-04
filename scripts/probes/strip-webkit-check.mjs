/**
 * Measure scroll area of the strip in **real WebKit** (the one installed by Playwright), comparing
 * "placeholder div" and "container padding" approaches side by side. Only measure without judging,
 * exit code is always 0: see "Do not use it as a gatekeeper" below for reasons.
 *
 *   node scripts/probes/strip-webkit-check.mjs
 *
 * Why this exists: On 2026-10-24, user could not scroll mini timeline on iPhone (iOS 18.1.1);
 * local headless Chrome (Blink) tested fine every time, wasting two rounds. After installing
 * Playwright's WebKit, difference between WebKit and Blink could be measured locally.
 *
 * **Do not use it as a gatekeeper** (measured on 2026-10-24): Playwright installs the **latest WebKit
 * at that time**; local copy is **27.2** (`Version/27.2 Safari/605.1.15` in UA), while user's
 * phone is iOS 18.1.1: several generations apart in between. The issue this time was: iOS 18.1 does
 * not count zero-height empty placeholders into `scrollWidth`, whereas WebKit 27.2 **does** (local
 * test measured `scroll 494 / scrollable 80` for both approaches, and trailing placeholder measured
 * `207x0` was still included). Therefore, **identical readings on this machine between the two
 * versions do not mean they are identical on user's phone**: it only proves "this difference does
 * not exist on new WebKit", but cannot prove older iOS. To truly verify older iOS behavior, the only
 * way is to have user open diagnostic page on phone (see item 2 of "Lessons learned this time" in
 * `docs/archive/agent-reports/AGENT-claude-strip-snapback.md`).
 */
import { webkit } from 'playwright-core';

const W = 414; // CSS width of the user's iPhone

/** The properties verbatim identical to `.pcm .strip-scroll` in `src/mobile/mobile.css` */
const COMMON = `display:flex;align-items:center;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;
  min-height:80px;touch-action:pan-x;overscroll-behavior-x:contain;user-select:none;-webkit-user-select:none;`;

/** Two approaches: placeholder div for left/right spacing (before modification) / container's own padding (after modification, current online version) */
const PAGE = (mode) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; }
  .strip { ${COMMON} ${mode === 'padding' ? 'padding: 6px 50% 10px calc(50% - 46px);' : 'padding: 6px 0 10px;'} }
  .strip::-webkit-scrollbar { display: none; }
  .spl { flex: none; width: calc(50% - 46px); }
  .spr { flex: none; width: 50%; }
  .add { flex: none; width: 40px; height: 64px; margin-right: 6px; background: #333; }
  .blk { flex: none; width: 80px; height: 64px; background: #777; }
</style>
<div class="strip">${mode === 'padding' ? '' : '<div class="spl"></div>'}<div class="add"></div><div class="blk"></div>${mode === 'padding' ? '' : '<div class="spr"></div>'}</div>`;

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: W, height: 800 } });
const out = {};

for (const mode of ['spacer', 'padding']) {
  await page.setContent(PAGE(mode));
  await page.waitForTimeout(120);
  out[mode] = await page.evaluate(() => {
    const el = document.querySelector('.strip');
    const spr = document.querySelector('.spr');
    const box = spr?.getBoundingClientRect();
    el.scrollLeft = 40;
    return {
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      range: el.scrollWidth - el.clientWidth,
      setTo40ReadBack: Math.round(el.scrollLeft),
      trailingPlaceholder: box ? `${box.width}x${box.height}` : 'none (this version has no placeholder div)',
    };
  });
}
const version = await browser.version();
const ua = await page.evaluate(() => navigator.userAgent);
await browser.close();

console.log(JSON.stringify({ engine: 'webkit', version, ua, viewport: W, ...out }, null, 1));

const same = out.spacer.range === out.padding.range;
console.log(same
  ? `\n==> This machine's WebKit (${version}) reads the same for both variants (each can scroll ${out.padding.range}).`
    + `
    It is several generations newer than the user's iOS 18.1.1, and in it a zero-height placeholder counts toward scrollWidth.`
    + `
    **This does not constitute evidence that "older iOS is fine too"**: do not use this line as a gatekeeper, see the top of this file.`
  : `\n==> The two variants read differently: placeholder ${out.spacer.range}, padding ${out.padding.range}.`
    + `\n    This machine's WebKit (${version}) already shows the difference, so it can serve as the local gatekeeper for this class of regression.`);
