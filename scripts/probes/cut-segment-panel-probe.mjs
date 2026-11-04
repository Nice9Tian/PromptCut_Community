/**
 * UI probe for cut segment properties panel and media library cut cells (cut segment initial
 * version limitations follow-up, items 1 and 5 of
 * `docs/archive/agent-reports/AGENT-cut-segment-followups.md`).
 * Actually opens editor, clicks, fills, and drags on panel, checks against store, and takes
 * step-by-step screenshots.
 *
 *   node scripts/probes/cut-segment-panel-probe.mjs --origin http://127.0.0.1:5370 --out <screenshot-dir>
 *
 * dev server must be started beforehand (three consecutive ports free; avoid 5190-5192).
 *
 * Assertions (one PASS/FAIL line per item, last line prints a JSON line, exits with code 1 on failure):
 *   P1 Click cut segment on timeline: editor section displays cut segment panel (referenced cut
 *      name, offset, start/end, frame, opacity, fade-in/fade-out, volume, mute, "Open referenced cut")
 *   P2 Change start offset: cutOffset in store updates, out point clamped to remaining length of
 *      referenced cut; undo once restores original value
 *   P3 Which cut is referenced cannot be changed (user decision, 2026-10-21): no "Reference" dropdown
 *      in panel (nor any other select), "Open referenced cut" button is still present
 *   P4 Frame: change X, Y, scale → frame; "Fill" clears frame; undo back (number inputs only submit
 *      on Enter, one step each for X, Y, scale, three steps in total)
 *   P5 Opacity, fade-in, fade-out → opacity / fadeIn / fadeOut; undo back
 *   P6 Volume, mute → audioVolume / audioMuted; undo back
 *   P7 Offset exceeds total duration of referenced cut: project not modified, reason stated at
 *      bottom of panel
 *   P8 Each change replaces with a new project object (no in-place modification)
 *   P9 "Open referenced cut": active cut switches to referenced one, tab bar shows its tab
 *      (same effect as double-clicking cut segment)
 *   L1 Media library "Cuts" group: cut name is a full line in both overview thumbnail and detail
 *      cells (height ≥ 14 pixels), font size not smaller than video/image cell titles
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 10 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ORIGIN = arg('--origin', 'http://127.0.0.1:5370');
const OUT = path.resolve(arg('--out', 'out/cut-segment-panel'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const fails = [];
const check = (key, cond, note, extra) => {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) fails.push(`${key}: ${note}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''}`);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${key} ${note}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : ''}`);
};

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { void d.dismiss(); });
  await page.goto(`${ORIGIN}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !!window.__pcStore, { timeout: 120_000 });
  await sleep(6000);
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const panelShot = async (name) => {
    const r = await page.evaluate(() => { const el = document.querySelector('[data-pc="inspector"]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    if (r && r.w > 0) await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: r.x, y: r.y, width: r.w, height: r.h } });
  };

  /* Setup: Cut 2 (one card 0-6s), Cut 3 (one card 0-4s), and in Cut 1 at 1s a cut segment referencing Cut 2 */
  const ids = await page.evaluate(() => {
    const a = window.__pcStore.actions;
    a.newProject('Cut segment panel');
    const c2 = a.addCut('Cut 2', { switchTo: true });
    a.addCardClip('punch-pill', 0, { duration: 6, params: { text: '剪辑二' } });
    a.setProjectMeta({ duration: 6 });
    const c3 = a.addCut('Cut 3', { switchTo: true });
    a.addCardClip('punch-pill', 0, { duration: 4, params: { text: '剪辑三' } });
    a.setProjectMeta({ duration: 4 });
    const root = window.__pcStore.getState().project.cuts[0].id;
    a.switchCut(root);
    a.select([]);
    const seg = a.addCutSegment(c2.id, 1, {});
    a.select([]);
    return { root, c2: c2.id, c3: c3.id, seg: seg.id };
  });
  await sleep(800);
  const seg = () => page.evaluate((id) => {
    const p = window.__pcStore.getState().project;
    return p.tracks.flatMap((t) => t.clips).find((c) => c.id === id) ?? null;
  }, ids.seg);
  const projectRef = () => page.evaluate(() => { window.__probeRefs = window.__probeRefs || []; window.__probeRefs.push(window.__pcStore.getState().project); return window.__probeRefs.length - 1; });
  const sameRef = (i) => page.evaluate((i) => window.__probeRefs[i] === window.__pcStore.getState().project, i);
  const undo = async () => { await page.evaluate(() => window.__pcStore.actions.undo()); await sleep(250); };
  const typeInto = async (sel, value) => {
    await page.click(sel, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(sel, String(value));
    await page.keyboard.press('Enter'); // Typing in number inputs only modifies draft; Enter (blur) submits one step
    await sleep(250);
  };
  const setRange = async (sel, value) => {
    await page.evaluate((sel, value) => {
      const el = document.querySelector(sel);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, sel, value);
    await sleep(250);
  };

  /* P1 Click cut segment → editor section displays cut segment panel */
  const segEl = await page.$(`[data-pc-cut-segment="${ids.c2}"]`);
  if (segEl) await segEl.click();
  await sleep(400);
  const editShown = await page.evaluate(() => { const el = document.querySelector('[data-pc="inspector"]'); return !!el && el.getBoundingClientRect().width > 0; });
  if (!editShown) await page.evaluate(() => document.querySelector('[data-pc-rail="edit"]')?.click());
  await sleep(600);
  const panel = await page.evaluate(() => {
    const f = document.querySelector('[data-pc="cut-segment-form"]');
    if (!f) return null;
    const has = (k) => !!f.querySelector(`[data-pc="${k}"]`);
    return {
      text: f.innerText.replace(/\s+/g, ' ').slice(0, 300),
      fields: ['cut-segment-offset', 'clip-start', 'clip-end', 'cut-segment-x', 'cut-segment-y', 'cut-segment-scale', 'cut-segment-rotate',
        'cut-segment-opacity', 'cut-segment-fadein', 'cut-segment-fadeout', 'cut-segment-volume', 'cut-segment-muted', 'cut-segment-open', 'cut-segment-frame-reset'].filter((k) => !has(k)),
    };
  });
  const sel = await page.evaluate(() => window.__pcStore.getState().selection);
  check('P1', panel && panel.fields.length === 0 && /Cut 2/.test(panel.text) && sel[0] === ids.seg, 'Clicking a cut segment: the editing section shows the cut segment panel with all items present', { panel, sel });
  await shot('01-panel-selected');
  await panelShot('01b-panel');

  /* P2 Start offset */
  let r0 = await projectRef();
  await typeInto('[data-pc="cut-segment-offset"]', 2);
  let s = await seg();
  const p8a = !(await sameRef(r0));
  check('P2', s.cutOffset === 2 && s.start === 1 && Math.abs(s.end - (1 + 6 - 2)) < 1e-6, 'Change the offset: cutOffset = 2, the out point is trimmed to the 4 seconds remaining in the referenced cut', { cutOffset: s.cutOffset, start: s.start, end: s.end });
  await panelShot('02-offset');
  await undo();
  s = await seg();
  check('P2u', (s.cutOffset ?? 0) === 0 && s.end === 7, 'Undo once: the offset and out point return to their original values', { cutOffset: s.cutOffset, end: s.end });

  /*
   * P3 Which cut is referenced cannot be changed (user decision, 2026-10-21): no "Reference"
   * dropdown in editor section, "Open referenced cut" button is still present
   */
  const refUi = await page.evaluate(() => {
    const f = document.querySelector('[data-pc="cut-segment-form"]');
    return { select: !!f?.querySelector('[data-pc="cut-segment-cut"]'), anySelect: f ? f.querySelectorAll('select').length : -1,
      open: !!f?.querySelector('[data-pc="cut-segment-open"]'), label: /Reference\s/.test(f?.innerText ?? '') };
  });
  check('P3', !refUi.select && refUi.anySelect === 0 && refUi.open, 'The editing section has no dropdown for changing the reference; the "Open referenced cut" button is still there', refUi);
  await panelShot('03-no-ref-select');

  /* P4 Frame */
  r0 = await projectRef();
  await typeInto('[data-pc="cut-segment-x"]', 100);
  await typeInto('[data-pc="cut-segment-y"]', 50);
  await setRange('[data-pc="cut-segment-scale"]', 0.5);
  s = await seg();
  const p8c = !(await sameRef(r0));
  check('P4', s.frame?.x === 100 && s.frame?.y === 50 && s.frame?.scale === 0.5, 'Changing X, Y and scale is written into frame', { frame: s.frame });
  await sleep(500);
  await shot('04-frame');
  await page.click('[data-pc="cut-segment-frame-reset"]');
  await sleep(300);
  s = await seg();
  const cleared = s.frame === undefined;
  await undo();
  s = await seg();
  check('P4r', cleared && s.frame?.scale === 0.5, '"Fill" clears frame; undo returns to scale 0.5', { frame: s.frame, cleared });
  // Number inputs only submit on Enter (user decision, 2026-10-20): filling X with 100 is one
  // step, Y with 50 is one step, scale is one step, three steps total
  let steps = 0;
  while (s.frame !== undefined && steps < 10) { await undo(); steps++; s = await seg(); }
  check('P4u', s.frame === undefined && steps === 3, `Undo ${steps} more times step by step: the box returns to fill`, { frame: s.frame, steps });

  /* P5 Opacity, fade-in/fade-out */
  r0 = await projectRef();
  await setRange('[data-pc="cut-segment-opacity"]', 0.6);
  await typeInto('[data-pc="cut-segment-fadein"]', 1);
  await typeInto('[data-pc="cut-segment-fadeout"]', 0.5);
  s = await seg();
  const p8d = !(await sameRef(r0));
  check('P5', s.opacity === 0.6 && s.fadeIn === 1 && s.fadeOut === 0.5, 'Opacity 0.6, fade-in 1, fade-out 0.5', { opacity: s.opacity, fadeIn: s.fadeIn, fadeOut: s.fadeOut });
  await panelShot('05-opacity-fades');
  await undo();
  s = await seg();
  check('P5u', s.fadeOut !== 0.5 && s.fadeIn === 1, 'Undo once: the fade-out reverts, the fade-in stays', { fadeIn: s.fadeIn, fadeOut: s.fadeOut });

  /* P6 Volume, mute */
  r0 = await projectRef();
  await setRange('[data-pc="cut-segment-volume"]', 0.4);
  await page.click('[data-pc="cut-segment-muted"]');
  await sleep(300);
  s = await seg();
  const p8e = !(await sameRef(r0));
  check('P6', s.audioVolume === 0.4 && s.audioMuted === true, 'Volume 0.4, muted', { audioVolume: s.audioVolume, audioMuted: s.audioMuted });
  await panelShot('06-volume-muted');
  await undo();
  s = await seg();
  check('P6u', !s.audioMuted && s.audioVolume === 0.4, 'Undo once: mute is canceled, the volume stays', { audioVolume: s.audioVolume, audioMuted: s.audioMuted });

  /* P7 Offset exceeds duration */
  r0 = await projectRef();
  await typeInto('[data-pc="cut-segment-offset"]', 9);
  const err = await page.evaluate(() => document.querySelector('[data-pc="cut-segment-error"]')?.textContent ?? null);
  s = await seg();
  check('P7', (await sameRef(r0)) && /exceeds/.test(err ?? '') && (s.cutOffset ?? 0) === 0, 'An offset of 9 seconds exceeds the 6 seconds of Cut 2: the project is untouched, and the panel states the reason', { err, cutOffset: s.cutOffset });
  await page.evaluate(() => document.querySelector('[data-pc="cut-segment-error"]')?.scrollIntoView({ block: 'end' }));
  await sleep(200);
  await panelShot('07-offset-error');

  check('P8', p8a && p8c && p8d && p8e, 'Every change produced a new project object', { p8a, p8c, p8d, p8e });

  /* P9 Open referenced cut */
  await page.click('[data-pc="cut-segment-open"]');
  await sleep(800);
  const st = await page.evaluate(() => ({ active: window.__pcStore.getState().project.activeCutId, tabs: [...document.querySelectorAll('[data-pc-cut-tab]')].map((el) => ({ id: el.getAttribute('data-pc-cut-tab'), on: el.classList.contains('is-on') })) }));
  check('P9', st.active === ids.c2 && st.tabs.some((t) => t.id === ids.c2 && t.on), '"Open referenced cut": activates Cut 2, and its tab in the tab bar is highlighted', st);
  await shot('09-open-referenced');
  await page.evaluate((root) => window.__pcStore.actions.switchCut(root), ids.root);
  await sleep(500);

  /* L1 Media library cut cells */
  const libShown = await page.evaluate(() => { const el = document.querySelector('[data-pc="library"]'); return !!el && el.getBoundingClientRect().width > 0; });
  if (!libShown) await page.evaluate(() => document.querySelector('[data-pc-rail="library"]')?.click());
  await sleep(600);
  // One image asset, using its detail cell title font size as control (shares title bar
  // `.pc-lib-card-title` with video cell)
  await page.evaluate(() => window.__pcStore.actions.addMedia({ kind: 'image', name: '对照图片.svg', url: '/favicon.svg', width: 64, height: 64 }));
  await sleep(600);
  await page.evaluate(() => document.querySelector('[data-pc-group="cuts"]')?.scrollIntoView());
  await sleep(400);
  const overview = await page.evaluate(() => [...document.querySelectorAll('[data-pc-group="cuts"] .pc-lib-cut-name')].map((el) => ({ t: el.textContent, fs: parseFloat(getComputedStyle(el).fontSize), h: el.getBoundingClientRect().height })));
  const gbox = await page.evaluate(() => { const b = document.querySelector('[data-pc-group="cuts"]').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await page.screenshot({ path: path.join(OUT, 'L1-overview-cuts-group.png'), clip: { x: gbox.x - 4, y: gbox.y - 4, width: gbox.w + 8, height: gbox.h + 8 } });
  await page.evaluate(() => document.querySelector('[data-pc-group="images"]')?.click());
  await sleep(800);
  const videoTitle = await page.evaluate(() => { const el = document.querySelector('.pc-lib-card-title'); return el ? { t: el.textContent, fs: parseFloat(getComputedStyle(el).fontSize), h: el.getBoundingClientRect().height } : null; });
  await shot('L1-image-detail');
  // Return to overview, open cut group details
  await page.evaluate(() => document.querySelector('[data-pc-category="all"]')?.click());
  await sleep(400);
  await page.evaluate(() => { const c = document.querySelector('[data-pc-group="cuts"]'); if (c) c.click(); else document.querySelector('[data-pc-cat-chip="cuts"], [data-pc-group-chip="cuts"]')?.click(); });
  await sleep(800);
  const detail = await page.evaluate(() => [...document.querySelectorAll('[data-pc-lib-cut] .pc-lib-cut-name')].map((el) => ({ t: el.textContent, fs: parseFloat(getComputedStyle(el).fontSize), h: el.getBoundingClientRect().height })));
  await shot('L1-detail-cuts');
  const ref = videoTitle?.fs ?? 11.5;
  check('L1', overview.length >= 2 && overview.every((n) => n.h >= 14 && n.fs >= ref) && detail.length >= 3 && detail.every((n) => n.h >= 14 && n.fs >= ref),
    `The cut name fits on one full line in both the overview thumbnail and the detail cell, with a font size no smaller than the title of image / video cells (${ref}px)`, { overview, detail, videoTitle });

  check('E0', errors.length === 0, 'Page has zero errors', errors);
} finally {
  await browser.close();
}
console.log(JSON.stringify({ ok: fails.length === 0, results, fails }));
process.exit(fails.length ? 1 : 0);
