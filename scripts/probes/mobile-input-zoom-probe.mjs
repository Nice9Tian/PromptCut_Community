/**
 * Acceptance check probe for mobile browsers auto-zooming on input tap and not zooming back out
 * on blur (`src/ui/focusZoomReset.ts` and touchscreen input font sizes in `src/index.css`).
 * Runs entirely on this machine: local hosted suite + simulated nginx proxy (`lib/mobile-env.mjs`),
 * online build serving as page, without connecting to real hosted side.
 *
 *   npx vite build --mode online
 *   node scripts/probes/mobile-input-zoom-probe.mjs [--dist dist-online] [--base-port 5850] [--doc-port 5858] [--asset-port 5859]
 *
 * Enter mobile app start page with Android Chrome emulation (375×812, touchscreen):
 *   F On touchscreen (`pointer: coarse` holds), every text input on page, plus input / textarea /
 *     select temporarily inserted into mobile app UI and page root, has computed font size
 *     ≥ 16px (iOS Safari zooms on focus for inputs < 16px; Android Chrome zooms by a multiple
 *     calculated from font size for "readability");
 *   Z Pinch to zoom in on page, tap input to type, blur → fallback temporarily replaces viewport
 *     with content containing `maximum-scale=1` then restores original, pinch-to-zoom still works
 *     after restoration;
 *   K Moving focus from one input to the next does not modify viewport (does not interrupt
 *     continuous typing); only final blur modifies it;
 *   N When inputs are not touched, viewport is not modified (ignores pages zoomed in by user).
 * Limitations of emulation (tested on headless Chrome, 2026-10-21): focusing a small-font input
 * does not auto-zoom, and modifying viewport does not pull existing zoom back to 1, so "truly
 * zoomed in, truly zoomed back out" can only be seen on real devices; this probe verifies the
 * cause of zooming is eliminated and fallback updates viewport in sequence.
 * The last line of the result is a JSON line (`ok`, `fails`, various numbers).
 */
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv } from './lib/mobile-env.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 240_000).unref();

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));

const fails = [];
const out = { ok: false, F: {}, Z: {}, K: {}, N: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scale = (page) => page.evaluate(() => window.visualViewport?.scale ?? null);
const viewportMeta = (page) => page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null);
/**
 * CDP pulls two touch points apart from the center line (zoomIn) or pinches them together to
 * zoom the page in or out. `Input.synthesizePinchGesture` does not take effect in headless mode;
 * pull distance is not proportional to final scale (headless Chrome tests show 100→200 px reaches
 * the 5x ceiling), probe only checks "whether it zoomed in" (> 1.5).
 */
async function pinch(page, zoomIn) {
  const cx = 187, y = 420;
  const [d0, d1] = zoomIn ? [100, 200] : [240, 40];
  const pts = (d) => [{ x: cx - d / 2, y, id: 0 }, { x: cx + d / 2, y, id: 1 }];
  await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(d0) });
  for (let i = 1; i <= 20; i++) { await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d0 + ((d1 - d0) * i) / 20) }); await sleep(16); }
  await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(600);
}
const pinchTo = (page) => pinch(page, true);
async function resetZoom(page) {
  for (let i = 0; i < 3 && (await scale(page)) > 1.01; i++) await pinch(page, false);
}

const env = await startMobileEnv({
  dist: DIST, basePort: Number(arg('--base-port', 5850)), docPort: Number(arg('--doc-port', 5858)), assetPort: Number(arg('--asset-port', 5859)),
  name: `input-zoom-${Date.now().toString(36)}`,
});
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 180_000, args: [...PROBE_CHROME_ARGS, '--no-first-run'] });
try {
  const page = await env.newPage(browser, 'phone');
  await page.goto(`${env.origin}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('.pcm input.text-in', { visible: true, timeout: 90_000 });
  await sleep(500);
  const base = await viewportMeta(page);
  out.viewport = base;

  /* Record every viewport change (fallback relies solely on modifying it) */
  await page.evaluate(() => {
    const m = document.querySelector('meta[name="viewport"]');
    window.__metaLog = [];
    new MutationObserver(() => window.__metaLog.push(m.getAttribute('content'))).observe(m, { attributes: true });
  });
  const metaLog = () => page.evaluate(() => window.__metaLog.splice(0));

  /* F: Font size */
  out.F = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('input, textarea, select')]
      .filter((e) => e.offsetParent !== null && !['checkbox', 'radio', 'range', 'button', 'submit', 'file'].includes(e.type))
      .map((e) => ({ name: e.name || e.dataset.pcm || e.type || e.tagName, fontSize: parseFloat(getComputedStyle(e).fontSize) }));
    const host = document.querySelector('.pcm');
    const probe = [];
    for (const [where, parent] of [['pcm', host], ['body', document.body]]) {
      for (const html of ['<input type="text" style="font-size:11px">', '<input type="search">', '<textarea style="font:12px/1 sans-serif"></textarea>', '<select><option>a</option></select>']) {
        const box = document.createElement('div'); box.innerHTML = html; const el = box.firstElementChild; parent.appendChild(el);
        probe.push({ name: `${where}:${el.tagName.toLowerCase()}${el.type ? '[' + el.type + ']' : ''}`, fontSize: parseFloat(getComputedStyle(el).fontSize) });
        el.remove();
      }
    }
    return { coarse: matchMedia('(pointer: coarse)').matches, inputs: visible, probe };
  });
  check(out.F.coarse, 'F (pointer: coarse) should hold under touch emulation', out.F);
  check(out.F.inputs.length > 0, 'F the start page should have text input boxes', out.F);
  for (const i of [...out.F.inputs, ...out.F.probe]) check(i.fontSize >= 16, `F input box ${i.name} font size should be ≥ 16px`, i);

  /* Z: zoom in → tap input to type → blur → temporarily add maximum-scale=1 to viewport then restore */
  await pinchTo(page);
  out.Z.zoomed = await scale(page);
  check(out.Z.zoomed > 1.5, 'Z the page should zoom in after a two-finger pinch', out.Z);
  const first = await page.$('.pcm input.text-in');
  await first.tap();
  // At 5x zoom, input may be outside viewport; focus directly if tap misses: verifies after blur, not tap
  await first.evaluate((el) => { if (document.activeElement !== el) el.focus(); });
  await page.keyboard.type('probe');
  await sleep(300);
  out.Z.whileTyping = await metaLog();
  check(out.Z.whileTyping.length === 0, 'Z the viewport is not touched while typing', out.Z);
  await page.evaluate(() => document.activeElement?.blur());
  await sleep(1200);
  out.Z.afterBlur = await metaLog();
  out.Z.metaAfter = await viewportMeta(page);
  check(out.Z.afterBlur.length === 2 && /maximum-scale=1$/.test(out.Z.afterBlur[0]) && out.Z.afterBlur[1] === base, 'Z after blur, the viewport first gets maximum-scale=1 added, then the original content is restored', { base, log: out.Z.afterBlur });
  check(out.Z.metaAfter === base, 'Z the final viewport is the original content', { base, after: out.Z.metaAfter });
  out.Z.scaleAfterBlur = await scale(page);
  await resetZoom(page);
  await pinchTo(page);
  out.Z.pinchAgain = await scale(page);
  check(out.Z.pinchAgain > 1.5, 'Z pinch zoom still works after restoring', out.Z);
  await resetZoom(page);
  await metaLog();

  /* K: Move focus from one input to the next */
  // Community edition start page has only one input, add one: focus shift check does not care which input
  await page.evaluate(() => {
    const all = document.querySelectorAll('.pcm input.text-in');
    if (all.length < 2) all[0].after(Object.assign(document.createElement('input'), { className: 'text-in' }));
  });
  const inputs = await page.$$('.pcm input.text-in');
  if (check(inputs.length >= 2, 'K the start page should have two or more input boxes', { n: inputs.length })) {
    await pinchTo(page);
    await inputs[0].evaluate((el) => el.focus());
    await page.evaluate(() => { const all = [...document.querySelectorAll('.pcm input.text-in')]; all[1].focus(); });
    await sleep(800);
    out.K.afterMove = await metaLog();
    check(out.K.afterMove.length === 0, 'K the viewport is not touched when focus moves to the next input box', out.K);
    await page.evaluate(() => document.activeElement?.blur());
    await sleep(1200);
    out.K.afterBlur = await metaLog();
    check(out.K.afterBlur.length === 2, 'K the viewport changes only on the final blur', out.K);
    await resetZoom(page);
    await metaLog();
  }

  /* N: Input not touched */
  await pinchTo(page);
  await page.evaluate(() => { document.body.focus(); document.body.blur(); });
  await sleep(1200);
  out.N.log = await metaLog();
  check(out.N.log.length === 0, 'N the viewport is not touched when no input box is touched', out.N);

  check(page.errors.length === 0, 'no uncaught exceptions on the page', page.errors.slice(0, 3));
} catch (e) {
  fails.push(`Exception: ${e?.stack ?? e}`);
} finally {
  await browser.close().catch(() => {});
  await env.close();
}
out.ok = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
