/**
 * Commit timing probe for editor panel number inputs and sliders
 * (`docs/archive/agent-reports/AGENT-number-input-undo.md`; semantics workflow/editing.md
 * "Undo, Redo" (user decision, 2026-10-20)).
 * Actually opens editor, types, presses keys, and drags on "Opacity" slider and number input in cut
 * segment properties panel, checks store and undo stack, taking step-by-step screenshots.
 * Page connects to document service bundled with dev server, so it uses document service commit
 * and undo (not snapshot stack).
 *
 *   node scripts/probes/number-input-undo-probe.mjs --origin http://127.0.0.1:5390 --out <screenshot-dir>
 *
 * dev server must be started first (three consecutive ports are free; do not touch 5190-5192).
 *
 * Assertions (one line PASS/FAIL each, last line prints a JSON line, exit code 1 on failure):
 *   N1 Number input changes 1 to 0.3: after typing each key "0", ".", "3", opacity in project does
 *      not change, no commit at all (intermediate 0 does not enter project, cut segment will not
 *      become transparent); exactly one commit of 0.3 after Enter; one undo returns to 1
 *   N2 Esc discards draft: does not commit, input displays back to original value
 *   N3 Empty / partial value blur: does not commit, input displays back to original value
 *   N4 Blur (clicking elsewhere) commits once; one undo returns to original value
 *   N5 Ctrl+Z can undo immediately after Enter (Enter blurs input so global undo shortcut is not
 *      blocked by input box)
 *   N6 Arrow keys continuous stepping: each step commits immediately, consecutive presses merged
 *      into one undo step; pressing again after pausing longer than window starts a new step
 *   N7 Slider single drag (pausing 400 ms midway): undo stack has only one step; commit count
 *      throttled during dragging (far fewer than pointer moves); project has final value after release
 *   N8 Slider keyboard consecutive presses merged into one undo step
 *   N9 Opacity is never committed as 0 throughout the process
 *   M1 Card clip "Start / End" number inputs (Inspector): typing does not commit, Enter commits once,
 *      one undo returns to original value
 *   M2 Card parameters panel number inputs (ParamsForm): same as above
 *   M3 Drag left/right on parameter name to fine-tune (ParamsForm): one drag produces one undo step,
 *      commits are throttled
 *   M4 3D panel (Frame3DForm) slider single drag produces one undo step, number input commits only on Enter
 *   M5 Media clip filter parameter number input (ClipFilterForm): project does not change when typing,
 *      Enter commits once, one undo returns to original value
 *   E0 Zero page errors
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 10 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ORIGIN = arg('--origin', 'http://127.0.0.1:5390');
const OUT = path.resolve(arg('--out', 'out/number-input-undo'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const fails = [];
const check = (key, cond, note, extra) => {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) fails.push(`${key}: ${note}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''}`);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${key} ${note}${!cond && extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : ''}`);
};

const NUM = '[data-pc="cut-segment-opacity-num"]';
const RANGE = '[data-pc="cut-segment-opacity"]';

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

  /* Preparation: Cut 2 (one card 0-6 s), a cut segment in Cut 1 referencing Cut 2 at 1 s */
  const ids = await page.evaluate(() => {
    const a = window.__pcStore.actions;
    a.newProject('Number box undo');
    const c2 = a.addCut('Cut 2', { switchTo: true });
    a.addCardClip('punch-pill', 0, { duration: 6, params: { text: '剪辑二' } });
    a.setProjectMeta({ duration: 6 });
    const root = window.__pcStore.getState().project.cuts[0].id;
    a.switchCut(root);
    a.select([]);
    const seg = a.addCutSegment(c2.id, 1, {});
    a.select([]);
    a.seek(2); // Place playhead inside cut segment, visible on stage (screenshot proves it does not become transparent when typing "0")
    // Record each updateClip call (called once every time panel opacity is committed)
    window.__calls = [];
    window.__all = [];
    const orig = a.updateClip.bind(a);
    a.updateClip = (id, patch) => { window.__calls.push({ patch, t: performance.now() }); window.__all.push(patch.opacity); return orig(id, patch); };
    return { root, c2: c2.id, seg: seg.id };
  });
  await sleep(800);
  const seg = () => page.evaluate((id) => window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id) ?? null, ids.seg);
  const opacity = async () => (await seg()).opacity ?? 1;
  const calls = () => page.evaluate(() => window.__calls.map((c) => c.patch.opacity));
  const resetCalls = () => page.evaluate(() => { window.__calls.length = 0; });
  const boxText = () => page.$eval(NUM, (el) => el.value);
  const undo = async () => { await page.evaluate(() => window.__pcStore.actions.undo()); await sleep(250); };
  const focusBox = async () => { await page.click(NUM, { clickCount: 3 }); };
  const clearBox = async () => { await focusBox(); await page.keyboard.press('Backspace'); };

  const segEl = await page.$(`[data-pc-cut-segment="${ids.c2}"]`);
  if (segEl) await segEl.click();
  await sleep(400);
  const editShown = await page.evaluate(() => { const el = document.querySelector('[data-pc="inspector"]'); return !!el && el.getBoundingClientRect().width > 0; });
  if (!editShown) await page.evaluate(() => document.querySelector('[data-pc-rail="edit"]')?.click());
  await sleep(800);
  await page.waitForSelector(NUM, { timeout: 20_000 });
  await shot('00-panel');

  /* N1 Number input 1 → 0.3 */
  await resetCalls();
  await clearBox();
  const trace = [];
  for (const key of ['0', '.', '3']) {
    await page.keyboard.press(key);
    await sleep(120);
    trace.push({ key, box: await boxText(), stored: await opacity(), calls: (await calls()).length });
    if (key === '0') await shot('01-typing-0-stage-still-visible');
  }
  await panelShot('02-typing-0.3-not-committed');
  const noneYet = trace.every((x) => x.stored === 1 && x.calls === 0);
  await page.keyboard.press('Enter');
  await sleep(400);
  const afterEnter = { calls: await calls(), stored: await opacity(), box: await boxText() };
  await panelShot('03-after-enter');
  await shot('03b-after-enter-stage');
  await undo();
  const afterUndo = await opacity();
  check('N1', noneYet && afterEnter.calls.length === 1 && afterEnter.calls[0] === 0.3 && afterEnter.stored === 0.3 && afterUndo === 1,
    'While typing "0", ".", "3", the opacity in the project stays 1 with zero commits; after Enter, exactly one commit of 0.3; one undo returns to 1', { trace, afterEnter, afterUndo });

  /* N2 Esc */
  await resetCalls();
  await clearBox();
  await page.keyboard.type('0.7');
  await page.keyboard.press('Escape');
  await sleep(150);
  const escBox = await boxText();
  await page.keyboard.press('Tab');
  await sleep(250);
  check('N2', escBox === '1' && (await calls()).length === 0 && (await opacity()) === 1, 'Esc discards the draft: the box goes back to 1, and there is no commit after blur either', { escBox, calls: await calls() });

  /* N3 Empty value */
  await resetCalls();
  await clearBox();
  await page.keyboard.press('Tab');
  await sleep(250);
  const emptyBox = await boxText();
  await clearBox();
  await page.keyboard.type('-');
  await page.keyboard.press('Tab');
  await sleep(250);
  const halfBox = await boxText();
  check('N3', emptyBox === '1' && halfBox === '1' && (await calls()).length === 0 && (await opacity()) === 1, 'Empty or partial value ("-") on blur: no commit, the box shows 1 again', { emptyBox, halfBox, calls: await calls() });

  /* N4 Commit on blur */
  await resetCalls();
  await clearBox();
  await page.keyboard.type('0.6');
  await sleep(150);
  const midCalls = (await calls()).length;
  await page.click('[data-pc="cut-segment-form"] .font-semibold'); // Click elsewhere, input blurs
  await sleep(300);
  const blurCalls = await calls();
  const blurStored = await opacity();
  await undo();
  check('N4', midCalls === 0 && blurCalls.length === 1 && blurCalls[0] === 0.6 && blurStored === 0.6 && (await opacity()) === 1, 'Commits 0.6 exactly once, on blur; one undo returns to 1', { midCalls, blurCalls, blurStored });

  /* N5 Ctrl+Z after Enter */
  await clearBox();
  await page.keyboard.type('0.4');
  await page.keyboard.press('Enter');
  await sleep(300);
  const set04 = await opacity();
  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  await sleep(400);
  check('N5', set04 === 0.4 && (await opacity()) === 1, 'After Enter commits 0.4, pressing Ctrl+Z directly reverts to 1 (the box has lost focus, so the global undo key works)', { set04, after: await opacity() });

  /* N6 Arrow key stepping */
  await resetCalls();
  await page.click(NUM);
  await page.keyboard.press('ArrowDown');
  await sleep(60);
  const s1 = { calls: (await calls()).length, stored: await opacity() };
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await sleep(300);
  const s3 = { calls: (await calls()).length, stored: await opacity() };
  await page.keyboard.press('Tab');
  await undo();
  const s3u = await opacity();
  // Pause longer than the window (1 second) then press again: start a new step
  await page.click(NUM);
  await page.keyboard.press('ArrowDown');
  await sleep(1300);
  await page.keyboard.press('ArrowDown');
  await sleep(300);
  await page.keyboard.press('Tab');
  await undo();
  const gapAfter1 = await opacity();
  await undo();
  const gapAfter2 = await opacity();
  check('N6', s1.calls === 1 && s1.stored === 0.95 && s3.calls === 3 && Math.abs(s3.stored - 0.85) < 1e-9 && s3u === 1 && Math.abs(gapAfter1 - 0.95) < 1e-9 && gapAfter2 === 1,
    'Arrow keys: each press commits immediately (0.95, 0.9, 0.85), and one undo after consecutive presses returns to 1; pressing again after a 1.3 second gap starts a new step (one undo only goes back to 0.95)', { s1, s3, s3u, gapAfter1, gapAfter2 });

  /* N7 Single slider drag */
  await resetCalls();
  const box = await page.$eval(RANGE, (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const y = box.y + box.h / 2;
  const thumbX = box.x + box.w - 6; // Value 1: handle at the far right
  await page.mouse.move(thumbX, y);
  await page.mouse.down();
  let moves = 0;
  const midShot = box.x + box.w * 0.35;
  for (let i = 0; i <= 40; i++) {
    const x = thumbX - (thumbX - box.x) * (i / 40) * 0.8;
    await page.mouse.move(x, y);
    moves++;
    await sleep(8);
    if (i === 20) { await shot('04-slider-mid-drag'); await sleep(400); } // Hold still for 400 ms, exceeding the default merge window
  }
  const duringDrag = (await calls()).length;
  await page.mouse.up();
  await sleep(400);
  const dragCalls = await calls();
  const finalVal = await opacity();
  const last = dragCalls[dragCalls.length - 1];
  await panelShot('05-slider-after-drag');
  await undo();
  const dragUndo = await opacity();
  await page.evaluate(() => window.__pcStore.actions.redo());
  await sleep(250);
  check('N7', dragCalls.length >= 2 && dragCalls.length <= 30 && dragCalls.length < moves / 2 && Math.abs(finalVal - last) < 1e-9 && finalVal < 0.5 && dragUndo === 1,
    `One slider drag (${moves} pointer moves, pausing 400 ms midway): ${dragCalls.length} commits (rate-limited); after release the project holds the final value ${finalVal}; one undo returns to 1`, { moves, duringDrag, total: dragCalls.length, finalVal, last, dragUndo });
  await undo(); // Already redone, undo 1 again to ensure clean state
  const back = await opacity();

  /* N8 Slider keyboard */
  await resetCalls();
  await page.focus(RANGE);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await sleep(300);
  const keyCalls = (await calls()).length;
  const keyVal = await opacity();
  await undo();
  check('N8', back === 1 && keyCalls === 3 && keyVal < 1 && (await opacity()) === 1, 'Pressing the slider arrow keys 3 times in a row commits 3 times; one undo returns to 1', { back, keyCalls, keyVal });

  const everCalls = await page.evaluate(() => window.__all);
  check('N9', everCalls.length > 0 && !everCalls.includes(0), `${everCalls.length} commits in the whole run, and opacity was never committed as 0`, { everCalls: everCalls.slice(0, 12) });
  /* ---- Other panels: card clip start / end, parameter number input, parameter name drag, 3D panel ---- */
  const cardId = await page.evaluate(() => {
    const a = window.__pcStore.actions;
    a.switchCut(window.__pcStore.getState().project.cuts[0].id);
    const c = a.addCardClip('blur-text', 0, { duration: 5, params: { text: 'Parameters panel' } });
    a.select([c.id]);
    a.seek(1);
    window.__mcalls = [];
    for (const name of ['setClipParams', 'setClipFrame', 'moveClip']) {
      const orig = a[name].bind(a);
      a[name] = (...args) => { window.__mcalls.push({ name, args: JSON.stringify(args.slice(1)) }); return orig(...args); };
    }
    return c.id;
  });
  await sleep(1000);
  const clipNow = () => page.evaluate((id) => window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id), cardId);
  const mcalls = () => page.evaluate(() => window.__mcalls.length);
  const mreset = () => page.evaluate(() => { window.__mcalls.length = 0; });
  const selectAllAndClear = async (sel) => { await page.click(sel); await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); };

  // M1 Start / end
  await mreset();
  const end0 = (await clipNow()).end;
  await selectAllAndClear('[data-pc="clip-end"]');
  await page.keyboard.type('4.5');
  await sleep(150);
  const m1mid = { calls: await mcalls(), end: (await clipNow()).end };
  await page.keyboard.press('Enter');
  await sleep(300);
  const m1after = { calls: await mcalls(), end: (await clipNow()).end };
  await undo();
  check('M1', m1mid.calls === 0 && m1mid.end === end0 && m1after.calls === 1 && m1after.end === 4.5 && (await clipNow()).end === end0,
    'Typing 4.5 into "End": zero commits while typing, one commit on Enter, one undo restores the original value', { end0, m1mid, m1after, undone: (await clipNow()).end });

  // M2 Parameter number input
  const numParam = await page.evaluate(() => { const el = document.querySelector('input[type="number"][data-pc-param]'); return el ? { key: el.getAttribute('data-pc-param'), value: el.value, min: el.min, max: el.max, step: el.step } : null; });
  if (!numParam) {
    check('M2', false, 'No number box found in this card\'s parameters panel', numParam);
    check('M3', false, 'Cannot find a draggable parameter name', numParam);
  } else {
    const sel = `input[type="number"][data-pc-param="${numParam.key}"]`;
    const before = (await clipNow()).params[numParam.key];
    await mreset();
    await selectAllAndClear(sel);
    const lo = numParam.min !== '' ? Number(numParam.min) : 1;
    const hi = numParam.max !== '' ? Number(numParam.max) : lo + 10;
    const target = String(Math.round((lo + hi) / 2));
    await page.keyboard.type(target);
    await sleep(150);
    const mid = { calls: await mcalls(), v: (await clipNow()).params[numParam.key] };
    await page.keyboard.press('Enter');
    await sleep(300);
    const after = { calls: await mcalls(), v: (await clipNow()).params[numParam.key] };
    await panelShot('06-params-number-after-enter');
    await undo();
    const undone = (await clipNow()).params[numParam.key];
    check('M2', mid.calls === 0 && mid.v === before && after.calls === 1 && after.v === Number(target) && undone === before,
      `Typing ${target} into parameter "${numParam.key}": zero commits while typing, one commit on Enter, one undo restores the original value`, { numParam, before, mid, after, undone });

    // M3 Parameter name drag
    await mreset();
    const lab = await page.$eval(`[data-pc-drag="${numParam.key}"]`, (el) => { const b = el.getBoundingClientRect(); return { x: b.x + 10, y: b.y + b.height / 2 }; });
    await page.mouse.move(lab.x, lab.y);
    await page.mouse.down();
    let mv = 0;
    for (let i = 1; i <= 30; i++) { await page.mouse.move(lab.x + i * 3, lab.y); mv++; await sleep(8); if (i === 15) await sleep(400); }
    await page.mouse.up();
    await sleep(400);
    const dragCalls = await mcalls();
    const dragged = (await clipNow()).params[numParam.key];
    await undo();
    const dragUndone = (await clipNow()).params[numParam.key];
    check('M3', dragCalls >= 2 && dragCalls < mv / 2 && dragged !== before && dragUndone === before,
      `Dragging left and right on the parameter name (${mv} pointer moves, pausing 400 ms midway): ${dragCalls} commits (rate-limited), value ${before} → ${dragged}; one undo returns to ${before}`, { dragCalls, mv, before, dragged, dragUndone });
  }

  // M4 3D panel
  await mreset();
  const rbox = await page.$eval('[data-pc="frame3d-rotateY"]', (el) => { el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await sleep(200);
  const rbox2 = await page.$eval('[data-pc="frame3d-rotateY"]', (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const ry = rbox2.y + rbox2.h / 2;
  const startX = rbox2.x + rbox2.w / 2; // Value 0: handle in the center
  await page.mouse.move(startX, ry);
  await page.mouse.down();
  let rmv = 0;
  for (let i = 1; i <= 30; i++) { await page.mouse.move(startX + i * 2, ry); rmv++; await sleep(8); if (i === 15) await sleep(400); }
  await page.mouse.up();
  await sleep(400);
  const rcalls = await mcalls();
  const rval = ((await clipNow()).frame?.rotateY) ?? 0;
  await panelShot('07-frame3d-after-drag');
  await undo();
  const rundone = ((await clipNow()).frame?.rotateY) ?? 0;
  await mreset();
  const rnum = await page.evaluate(() => { const row = document.querySelector('[data-pc="frame3d-rotateY"]').parentElement; return [...row.querySelectorAll('input[type="number"]')].length; });
  const rnumSel = '[data-pc="frame3d-rotateY"] ~ input[type="number"]';
  await page.click(rnumSel, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type('30');
  await sleep(150);
  const nmid = await mcalls();
  await page.keyboard.press('Enter');
  await sleep(300);
  const nval = ((await clipNow()).frame?.rotateY) ?? 0;
  const ncalls = await mcalls();
  await undo();
  const nundone = ((await clipNow()).frame?.rotateY) ?? 0;
  check('M4', rcalls >= 2 && rcalls < rmv / 2 && rval !== 0 && rundone === 0 && rnum === 1 && nmid === 0 && ncalls === 1 && nval === 30 && nundone === 0,
    `3D: one slider drag (${rmv} moves) commits ${rcalls}, value ${rval}, one undo returns to 0; typing 30 into the number box gives zero commits while typing, one on Enter, and one undo returns to 0`, { rcalls, rmv, rval, rundone, rnum, nmid, ncalls, nval, nundone });

  // M5 Filter parameters
  const fclip = await page.evaluate(() => {
    const a = window.__pcStore.actions;
    const m = a.addMedia({ kind: 'image', name: 'Image.svg', url: '/favicon.svg', width: 64, height: 64 });
    const c = a.addMediaClip(m.id, 0, { duration: 4 });
    a.addFilter({ id: 'f-probe', name: 'Probe brightness', params: { amount: { default: 1, min: 0, max: 3, label: 'Amount' } }, ops: [{ kind: 'brightness', value: 'amount' }] }, { clipId: c.id, filter: { id: 'f-probe' } });
    a.select([c.id]);
    return c.id;
  });
  await sleep(1000);
  const fstored = () => page.evaluate((id) => window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.filter?.params?.amount ?? null, fclip);
  const FSEL = '[data-pc="clip-filter-param-amount"]';
  await page.waitForSelector(FSEL, { timeout: 15_000 });
  const f0 = await fstored();
  await selectAllAndClear(FSEL);
  await page.keyboard.type('2');
  await sleep(150);
  const fmid = await fstored();
  await page.keyboard.press('Enter');
  await sleep(300);
  const fafter = await fstored();
  await panelShot('08-filter-param-after-enter');
  await undo();
  const fundone = await fstored();
  check('M5', fmid === f0 && fafter === 2 && fundone === f0, 'Typing 2 into a filter parameter: the project does not change while typing, one commit on Enter, one undo restores the original value', { f0, fmid, fafter, fundone });

  check('E0', errors.length === 0, 'Page has zero errors', errors);
} finally {
  await browser.close();
}
console.log(JSON.stringify({ ok: fails.length === 0, results, fails }));
process.exit(fails.length ? 1 : 0);
