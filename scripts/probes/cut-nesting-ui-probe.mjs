/**
 * Local UI probe for cut task (`docs/plan/cut-nesting-task.md` "Acceptance check"): actually opens
 * the editor, clicking, dragging, and capturing screenshots item by item.
 *
 *   node scripts/probes/cut-nesting-ui-probe.mjs --origin http://127.0.0.1:5350 --out <screenshot-dir>
 *
 * The dev server must be started beforehand (three consecutive ports must be free; do not touch
 * 5190-5192). Stage iframe uses Puppeteer's frame handle.
 * Drag-and-drop uses `DragEvent` + `DataTransfer` constructed in the page, dispatched to media
 * library cells and timeline tracks (running through the same set of React event handlers as manual
 * dragging).
 *
 * Assertions (one conclusion per item, the last line prints a JSON line):
 *   A1 New project has only "Cut 1" (only one item in store, tab bar, and media library cut group;
 *      no "×" on the tab)
 *   A2 Media library shows a "Cuts" group, displaying name and duration
 *   A3 Click a cut in the media library: opens a tab above the timeline and activates it
 *   A4 Click elsewhere, switch left rail sections, lose focus: tabs remain present
 *   A5 Click "×" only closes the tab, while the cut remains in the media library; the last tab has
 *      no "×"
 *   A6 Drag cut 2 into cut 1's track: a cut segment appears; preview renders cut 2's content
 *   A7 Modify cut 2, cut 1 updates accordingly (preview differs before and after)
 *   A8 Drag cut 1 into cut 1, or drag cut 1 inside cut 2 (A→B→A): drop target preview is highlighted
 *      in red with reasons stated, releasing does not drop
 *   A9 Delete a referenced cut: confirmation dialog explains which cuts are using it; upon
 *      confirmation, cut segments are deleted together; all restored after undo
 *   A10 Select a cut segment: no "Reference" dropdown to switch references in editing section
 *      (which cut is referenced cannot be changed; user decision, 2026-10-21), "Open referenced cut"
 *      button is still there
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 12 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ORIGIN = arg('--origin', 'http://127.0.0.1:5350');
const OUT = path.resolve(arg('--out', 'out/cut-nesting-ui'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const fails = [];
const check = (key, cond, note, extra) => {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) fails.push(`${key}: ${note}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''}`);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${key} ${note}`);
};

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { console.log('[dialog]', d.message()); void d.dismiss(); });
  await page.goto(`${ORIGIN}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !!window.__pcStore, { timeout: 120_000 });
  await sleep(6000);
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const state = () => page.evaluate(() => {
    const p = window.__pcStore.getState().project;
    return {
      cuts: (p.cuts ?? []).map((c) => ({ id: c.id, name: c.name })), active: p.activeCutId,
      tabs: [...document.querySelectorAll('[data-pc-cut-tab]')].map((el) => ({ id: el.getAttribute('data-pc-cut-tab'), on: el.classList.contains('is-on'), close: !!el.querySelector('[data-pc="cut-tab-close"]') })),
      segments: p.tracks.flatMap((t) => t.clips).filter((c) => c.cutId).map((c) => ({ id: c.id, cutId: c.cutId, start: c.start, end: c.end })),
    };
  });
  const stageText = async () => {
    const texts = [];
    for (const f of page.frames().filter((fr) => fr.url().includes('stage=1'))) {
      texts.push(await f.evaluate(() => ({ text: document.body.innerText, cutScenes: document.querySelectorAll('[data-pc-cut-scene]').length })).catch(() => ({ text: '', cutScenes: 0 })));
    }
    return texts;
  };
  const openLibraryGroup = async () => {
    // Only click rail if media library section is not exposed (clicking an already expanded item
    // collapses the drawer; hidden section tabs do not update with the store)
    const shown = await page.evaluate(() => { const el = document.querySelector('[data-pc="library"]'); return !!el && el.getBoundingClientRect().width > 0; });
    if (!shown) await page.evaluate(() => document.querySelector('[data-pc-rail="library"]')?.click());
    await sleep(300);
    const open = await page.$('[data-pc-open-group="cuts"]');
    if (!open) await page.evaluate(() => document.querySelector('[data-pc-group="cuts"]')?.click());
    await sleep(400);
  };

  /* A1 New project */
  await page.evaluate(() => window.__pcStore.actions.newProject('Cut acceptance check'));
  await sleep(2500);
  let s = await state();
  check('A1', s.cuts.length === 1 && s.cuts[0].name === 'Cut 1' && s.tabs.length === 1 && !s.tabs[0].close, 'A new project has only Cut 1, and the tab bar has one tab without ×', s);
  await openLibraryGroup();
  await shot('01-new-project-one-cut');

  /* A2 Media library cut group */
  const lib = await page.evaluate(() => [...document.querySelectorAll('[data-pc-lib-cut]')].map((el) => el.innerText.replace(/\s+/g, ' ')));
  check('A2', lib.length === 1 && /Cut 1/.test(lib[0]) && /\d+:\d\d/.test(lib[0]), 'the "Cuts" group in the media library lists Cut 1 and its duration', lib);

  /* Create cut 2 ("+" in tab bar), place a card and a video inside */
  await page.click('[data-pc="cut-add"]');
  await sleep(800);
  s = await state();
  const cut2 = s.cuts.find((c) => c.name === 'Cut 2')?.id;
  await page.evaluate(() => {
    const a = window.__pcStore.actions;
    const media = a.addMedia({ kind: 'video', name: 'fixture.mp4', url: '/@media/392128b6b4d1ba0f32751a1fb23df75e9f08cfc3981b1a19a457c5ff4ebb7e95', duration: 8, width: 320, height: 180, hash: '392128b6b4d1ba0f32751a1fb23df75e9f08cfc3981b1a19a457c5ff4ebb7e95' });
    const tracks = window.__pcStore.getState().project.tracks;
    a.addMediaClip(media.id, 0, { trackId: tracks[1].id, duration: 6 });
    a.addCardClip('punch-pill', 0, { trackId: tracks[0].id, duration: 6, params: { text: '剪辑二的卡' } });
  });
  await sleep(800);

  /* A3 Click cut in media library: open tab and activate. First close cut 2's tab and return to cut 1 */
  await page.evaluate((id) => document.querySelector(`[data-pc-cut-tab="${id}"] [data-pc="cut-tab-close"]`)?.click(), cut2);
  await sleep(600);
  await openLibraryGroup();
  s = await state();
  check('A5', s.tabs.length === 1 && s.cuts.length === 2 && s.active !== cut2 && !s.tabs[0].close, '× only closes the tab: Cut 2 is still there; with only one tab left there is no ×', s);
  const libAfterClose = await page.evaluate(() => [...document.querySelectorAll('[data-pc-lib-cut]')].map((el) => el.getAttribute('data-pc-lib-cut')));
  check('A5b', libAfterClose.includes(cut2), 'after closing the tab, Cut 2 is still in the media library', libAfterClose);
  await shot('02-tab-closed-cut-still-in-library');
  await openLibraryGroup();
  await page.evaluate((id) => document.querySelector(`[data-pc-lib-cut="${id}"]`)?.click(), cut2);
  await sleep(800);
  s = await state();
  check('A3', s.active === cut2 && s.tabs.some((t) => t.id === cut2 && t.on), 'single-clicking Cut 2 in the media library opens and activates a tab above the timeline', s);
  await shot('03-click-library-opens-tab');

  /* A4 Click elsewhere, switch section, lose focus */
  await page.mouse.click(780, 400); // Preview
  await page.evaluate(() => document.querySelector('[data-pc-rail="animations"]')?.click());
  await sleep(300);
  await page.evaluate(() => { document.activeElement?.blur?.(); window.dispatchEvent(new Event('blur')); });
  await page.mouse.click(1300, 300); // AI panel
  await sleep(500);
  s = await state();
  check('A4', s.tabs.length === 2, 'both tabs are still there after clicking the preview, switching the left rail section, losing focus, and clicking the AI panel', s);
  await shot('04-tabs-survive-focus-loss');

  /* A6 Return to cut 1, drag cut 2 into cut 1's track */
  const cut1 = s.cuts.find((c) => c.name === 'Cut 1').id;
  await page.evaluate((id) => document.querySelector(`[data-pc-cut-tab="${id}"] [role="tab"]`)?.click(), cut1);
  await sleep(800);
  await openLibraryGroup();
  const drag = async (cutId, x, holdShot) => page.evaluate(async ({ cutId, x, holdShot }) => {
    const tile = document.querySelector(`[data-pc-lib-cut="${cutId}"]`);
    const row = document.querySelector('[data-track-id]');
    if (!tile || !row) return { error: 'no tile/row' };
    const dt = new DataTransfer();
    tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const r = row.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + x, clientY: r.top + r.height / 2 };
    row.dispatchEvent(new DragEvent('dragenter', opts));
    row.dispatchEvent(new DragEvent('dragover', opts));
    await new Promise((res) => setTimeout(res, 300));
    const ghost = row.querySelector('.pc-drop-ghost, [data-pc="drop-ghost"]')?.innerText ?? row.innerText;
    const red = row.className.includes('bg-red');
    if (holdShot) return { ghost, red, held: true, rowSel: row.getAttribute('data-track-id') };
    row.dispatchEvent(new DragEvent('drop', opts));
    tile.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return { ghost, red };
  }, { cutId, x, holdShot });
  const dropRes = await drag(cut2, 40, false);
  await sleep(1200);
  s = await state();
  const segOk = s.segments.length === 1 && s.segments[0].cutId === cut2 && Math.abs(s.segments[0].end - s.segments[0].start - 6) < 0.05;
  await page.evaluate((t) => window.__pcStore.actions.seek(t), s.segments[0] ? s.segments[0].start + 2 : 2);
  await sleep(5000);
  let st = await stageText();
  check('A6', segOk && st.some((x) => x.cutScenes > 0 && x.text.includes('剪辑二的卡')), 'Cut 2 dragged into Cut 1: a cut segment appears, and the preview draws the card of Cut 2', { dropRes, segments: s.segments, stage: st.map((x) => ({ cutScenes: x.cutScenes, has: x.text.includes('剪辑二的卡') })) });
  await shot('05-cut2-dropped-into-cut1');

  /* A10 Cut segment parameters panel (user decision, 2026-10-21): no "Reference" dropdown
   * to switch references in editing section, "Open referenced cut" button is still there */
  {
    const segEl = await page.$(`[data-pc-cut-segment="${cut2}"]`);
    if (segEl) await segEl.click();
    await sleep(400);
    const editShown = await page.evaluate(() => { const el = document.querySelector('[data-pc="inspector"]'); return !!el && el.getBoundingClientRect().width > 0; });
    if (!editShown) await page.evaluate(() => document.querySelector('[data-pc-rail="edit"]')?.click());
    await sleep(600);
    const form = await page.evaluate(() => {
      const f = document.querySelector('[data-pc="cut-segment-form"]');
      return f ? { refSelect: !!f.querySelector('[data-pc="cut-segment-cut"]'), selects: f.querySelectorAll('select').length,
        open: !!f.querySelector('[data-pc="cut-segment-open"]'), offset: !!f.querySelector('[data-pc="cut-segment-offset"]'), text: f.innerText.replace(/\s+/g, ' ').slice(0, 160) } : null;
    });
    check('A10', !!form && !form.refSelect && form.selects === 0 && form.open && form.offset,
      'cut segment panel: no "Reference" dropdown; the "Open referenced cut" button and the start offset are still there', form);
    await shot('05b-cut-segment-panel');
    // Subsequent drag-and-drop requires media library cells: switch back to media library
    await openLibraryGroup();
  }

  /* A7 Modify cut 2, cut 1 updates accordingly */
  await page.evaluate((id) => {
    const a = window.__pcStore.actions;
    a.switchCut(id);
    const clip = window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.cardId === 'punch-pill');
    a.setClipParams(clip.id, { text: '改过的剪辑二' });
  }, cut2);
  await sleep(500);
  await page.evaluate((id) => window.__pcStore.actions.switchCut(id), cut1);
  await sleep(500);
  await page.evaluate((t) => window.__pcStore.actions.seek(t), s.segments[0].start + 2);
  await sleep(5000);
  st = await stageText();
  check('A7', st.some((x) => x.text.includes('改过的剪辑二')) && !st.some((x) => x.text.includes('剪辑二的卡')), 'editing the card of Cut 2, the Cut 1 preview changes with it', st.map((x) => x.text.slice(0, 80)));
  await shot('06-edit-cut2-reflects-in-cut1');

  /* A8 Reject self-reference and A→B→A */
  const selfDrag = await drag(cut1, 400, true);
  await shot('07-reject-self');
  await page.evaluate(() => { const row = document.querySelector('[data-track-id]'); row.dispatchEvent(new DragEvent('dragleave', { bubbles: true })); window.dispatchEvent(new Event('dragend')); });
  const selfDrop = await drag(cut1, 400, false);
  await sleep(500);
  const afterSelf = (await state()).segments.length;
  await page.evaluate((id) => document.querySelector(`[data-pc-lib-cut="${id}"]`)?.click(), cut2);
  await sleep(800);
  await openLibraryGroup();
  const loopDrag = await drag(cut1, 500, true);
  await shot('08-reject-a-b-a');
  await page.evaluate(() => { const row = document.querySelector('[data-track-id]'); row.dispatchEvent(new DragEvent('dragleave', { bubbles: true })); window.dispatchEvent(new Event('dragend')); });
  await drag(cut1, 500, false);
  await sleep(500);
  const loopSegs = (await state()).segments.length;
  check('A8', /into itself/.test(selfDrag.ghost) && selfDrag.red && afterSelf === 1 && /circular reference/.test(loopDrag.ghost) && loopDrag.red && loopSegs === 0,
    'Dragging Cut 1 into Cut 1 and dragging Cut 1 inside Cut 2: both turn red with the reason stated, and releasing does not drop it', { selfDrag, selfDrop, afterSelf, loopDrag, loopSegs });

  /* A9 Delete referenced cut */
  await page.evaluate((id) => document.querySelector(`[data-pc-cut-tab="${id}"] [role="tab"]`)?.click(), cut1);
  await sleep(600);
  await openLibraryGroup();
  await page.evaluate((id) => {
    const tile = document.querySelector(`[data-pc-lib-cut="${id}"]`);
    tile.querySelector('[data-pc="lib-cut-delete"]').click();
  }, cut2);
  await sleep(500);
  const dialogText = await page.evaluate(() => document.body.innerText.match(/Cut "Cut 2" is used by[^\n]*\n?[^\n]*/)?.[0] ?? '');
  await shot('09-delete-referenced-confirm');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Delete')?.click());
  await sleep(800);
  const afterDelete = await state();
  await page.evaluate(() => window.__pcStore.actions.undo());
  await sleep(800);
  const afterUndo = await state();
  check('A9', /used by/.test(dialogText) && /also delete/.test(dialogText) && afterDelete.cuts.length === 1 && afterDelete.segments.length === 0 && afterUndo.cuts.length === 2 && afterUndo.segments.length === 1,
    'Deleting a referenced cut: the confirmation dialog states who is using it; after deletion the cut segments are gone too; undo brings everything back', { dialogText, afterDelete, afterUndo });
  await shot('10-after-undo');
  console.log('page errors:', errors.slice(0, 5));
} finally {
  await browser.close();
}
console.log(JSON.stringify({ ok: fails.length === 0, fails, results }));
process.exit(fails.length ? 1 : 0);
