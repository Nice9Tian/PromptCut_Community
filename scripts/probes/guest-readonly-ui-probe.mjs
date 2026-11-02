/**
 * Read-only presentation probe for the editor when a guest enters someone else's project
 * (read-only permissions) ((user decision, 2026-10-23): guests are always read-only, and the UI
 * must make it immediately obvious that changes cannot be made).
 * Real Chrome (puppeteer), editor `?editor&aimock=1&nosetup=1`. "Read-only permissions" are toggled
 * with `setProjectAccess('r')` from `io/viewOnly.ts`, then triggers UI re-render via a state
 * notification from sync management (the real path toggles via syncManager when entering a project;
 * see `src/editor/readOnly.ts`).
 *
 * Usage:
 *   node scripts/probes/guest-readonly-ui-probe.mjs [--port 5243] [--out out/guest-readonly-ui-probe] [--origin http://127.0.0.1:N] [--keep]
 * Ports allocated from 5240 to 5249; by default starts an editor instance (stages occupy +1, +2),
 * torn down after running. `--origin` uses an existing external instance instead.
 *
 * Acceptance check (one JSON line per item, last line is summary, exits with code 1 on failure):
 *   R0 Read/write (not entered shared project): Undo clickable, "Track" clickable, media import
 *      clickable, timeline clips have drag handles, row header buttons clickable, all three preview
 *      tools clickable, input area can send (edit box and Send available), parameters panel
 *      (after selecting a clip) controls clickable: everything as usual, no read-only markers.
 *   R1 Switch to read-only: <html> has data-pc-readonly=member, top bar badge is "View only" and
 *      hover shows viewOnlyText().
 *   R2 Timeline: row header mute / hide / lock, "+ Track", "New cut" grayed out and hover shows
 *      that message; clips have no drag handles; actually dragging a clip, pressing Delete, or
 *      right-clicking leaves project contents unchanged (right-click only shows a single line of
 *      gray explanation); clicking once can still select.
 *   R3 Parameters panel: after selecting a clip, Start / End in "Edit" section, card switch
 *      dropdown, and parameter controls are all disabled; code tab text box is read-only and
 *      selectable.
 *   R4 Media library and animations: import button grayed out; card cells not draggable
 *      (draggable=false), clicking once does not add clips to the timeline, hover shows that message.
 *   R5 Preview: Move and Text tools grayed out (Select available); Play / Pause as normal;
 *      Export clickable as normal.
 *   R6 Right rail Agent: edit box, Send, preset buttons disabled, placeholder text is that message;
 *      no guide animation.
 *   R7 Top bar: Undo / Redo grayed out; rename cannot be opened; in "Project" menu, Save and Save
 *      archive are grayed out, "Project settings…" opens but settings items are disabled, "OK"
 *      grayed out.
 *   R8 The old ?observe=1 path remains unchanged: badge is still "Read-only view", Save is grayed
 *      out, while none of the newly added locks are present ("+ Track", input area, parameter
 *      controls available as usual).
 *   R9 Switch back to read/write: the above items are restored to clickable, and the <html> marker
 *      is removed.
 *   M1-M3 Mobile app (`--mobile`: start another online-mode dev server, `?layout=mobile`): an
 *      explanation note appears below top bar (no hover on mobile), entire sub-navigation bar row
 *      is grayed out, Undo grayed out, Playback and Export as normal; Agent input area replaced
 *      with explanation; in timeline tab, dragging a card clip after clicking to select does not
 *      move (moves under read/write as a control), and align button is grayed out.
 * Screenshots written to --out: ro-full.png, ro-timeline.png, ro-params.png, ro-agent.png,
 *   ro-library.png, ro-project-menu.png, ro-settings.png, rw-full.png, observe-full.png,
 *   ro-mobile.png, ro-mobile-agent.png.
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer, viteBin, waitHttp, killTree, REPO } from '../lib/dev-server.mjs';

const PORT = Number(flagArg('port', 5243));
if (PORT < 5240 || PORT > 5249) throw new Error(`Port ${PORT} is not within 5240-5249, the range assigned to this probe`);
const MOBILE_PORT = Number(flagArg('mobile-port', 5246));
if (MOBILE_PORT < 5240 || MOBILE_PORT > 5247) throw new Error(`Port ${MOBILE_PORT} is not within 5240-5249, the range assigned to this probe (needs three consecutive ports)`);
const OUT = path.resolve(REPO, flagArg('out', 'out/guest-readonly-ui-probe'));
const KEEP = process.argv.includes('--keep');
const WITH_MOBILE = process.argv.includes('--mobile');
const GIVEN_ORIGIN = flagArg('origin', null);
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, extra = {}) => {
  const r = { check: name, ok: !!ok, ...extra };
  results.push(r);
  console.log(JSON.stringify(r));
  return !!ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

let server = null;
let mobileServer = null;
let tmp = null;
let browser = null;
const serverEnv = () => ({
  PROMPTCUT_NO_PORT_FILE: '1',
  PROMPTCUT_PUSH: '0',
  PROMPTCUT_CHATS_DIR: path.join(tmp, 'chats'),
  PROMPTCUT_WORK_DIR: path.join(tmp, 'work'),
  PROMPTCUT_DATA_DIR: path.join(tmp, 'data'),
  PROMPTCUT_AI_CONFIG: path.join(tmp, 'ai.json'),
});
try {
  let origin = GIVEN_ORIGIN;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-guest-ro-'));
  if (!origin) {
    server = await startDevServer({ port: PORT, logFile: path.join(tmp, 'vite.log'), env: serverEnv() });
    origin = server.origin;
  }

  browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1600, height: 1000 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--force-device-scale-factor=1'],
  });

  const openEditor = async (base, query, size = { width: 1600, height: 1000 }) => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e?.message ?? e)));
    page.on('dialog', (d) => { void d.accept().catch(() => {}); });
    await page.setViewport(size);
    await page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded' });
    await waitFor(() => page.evaluate(() => !!window.__pcStore), 120_000, 'window.__pcStore');
    // The whole-page "Measuring cards" overlay appears about 2 s after load and is dismissed about
    // 3 s later; after dismissal, heavy cards still show an hourglass at each moment: 7 consecutive
    // seconds without an overlay is considered stable (while covered, clicks fall onto the overlay)
    let calm = 0;
    const t0 = Date.now();
    while (calm < 7000 && Date.now() - t0 < 120_000) {
      const measuring = await page.evaluate(() => document.body.innerText.includes('Measuring card')).catch(() => true);
      calm = measuring ? 0 : calm + 500;
      await sleep(500);
    }
    return page;
  };
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

  /** Check the status of an element on the page (takes the first visible one) */
  const stateOf = (page, sel) => page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((n) => n.getClientRects().length > 0) ?? document.querySelector(sel);
    if (!el) return { found: false };
    const off = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || !!el.closest('fieldset:disabled');
    return {
      found: true,
      off,
      disabled: el.matches(':disabled'),
      inDisabledFieldset: !!el.closest('fieldset:disabled'),
      aria: el.getAttribute('aria-disabled'),
      title: el.getAttribute('title') ?? '',
      readOnly: el.readOnly === true,
      draggable: el.draggable === true,
      placeholder: el.getAttribute('placeholder') ?? '',
      text: (el.textContent ?? '').trim().slice(0, 40),
    };
  }, sel);
  const countOf = (page, sel) => page.evaluate((sel) => document.querySelectorAll(sel).length, sel);
  const projectJson = (page) => page.evaluate(() => JSON.stringify(window.__pcStore.getState().project));
  const clipIds = (page) => page.evaluate(() => window.__pcStore.getState().project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  const clickVisible = async (page, sel) => {
    const ok = await page.evaluate((sel) => {
      const el = [...document.querySelectorAll(sel)].find((n) => n.getClientRects().length > 0);
      if (!el) return false;
      el.click();
      return true;
    }, sel);
    if (!ok) throw new Error(`Cannot click ${sel}`);
  };
  // prefix: online-mode dev server places the page under /editor/ (base in vite.config.ts),
  // module paths include it accordingly
  const setAccess = async (page, access, prefix = '') => {
    await page.evaluate(async (access, prefix) => {
      const vo = await import(`${prefix}/src/editor/io/viewOnly.ts`);
      vo.setProjectAccess(access);
      // Trigger UI re-render via a state notification from sync management (the real path toggles when
      // syncManager enters / leaves a project)
      const sm = await import(`${prefix}/src/editor/sync/syncManager.ts`);
      sm.pushToast('probe', 'info', 1);
    }, access, prefix);
    await sleep(500);
  };
  const WHY = (page, prefix = '') => page.evaluate(async (prefix) => (await import(`${prefix}/src/editor/io/viewOnly.ts`)).viewOnlyText(), prefix);
  /** Drop a card onto the timeline's first track (synthetic HTML5 drag-and-drop events; puppeteer cannot do real drag-and-drop): returns "whether drop target accepted" and "how many clips were added" */
  const tryDrop = (page) => page.evaluate(() => {
    const st = window.__pcStore.getState();
    const cardId = st.project.tracks.flatMap((t) => t.clips).find((c) => c.cardId)?.cardId;
    const row = document.querySelector('[data-track-id]');
    const rect = row.getBoundingClientRect();
    const count = () => window.__pcStore.getState().project.tracks.reduce((n, t) => n + t.clips.length, 0);
    const dt = new DataTransfer();
    dt.setData('application/x-promptcut-card', cardId);
    const mk = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + 2600, clientY: rect.top + 20 });
    const over = mk('dragover');
    row.dispatchEvent(over);
    const before = count();
    row.dispatchEvent(mk('drop'));
    return { cardId, accepted: over.defaultPrevented, added: count() - before, newTrackZone: document.querySelectorAll('[data-pc="new-track-zone"]').length };
  });

  /* ── R0 Read/write ── */
  const page = await openEditor(origin, '?editor&aimock=1&nosetup=1');
  const ids = await clipIds(page);
  check('R0.has-clips', ids.length >= 3, { n: ids.length });
  // Make an edit so undo has something to click
  await page.evaluate((id) => window.__pcStore.actions.setClipParams(id, { probe: 1 }, { merge: true }), ids[0]);
  await sleep(300);
  const rw = {
    undo: await stateOf(page, '[data-pc="undo-btn"] button'),
    addTrack: await stateOf(page, '[data-pc="add-track"]'),
    media: await stateOf(page, '[data-pc-add="media"]'),
    rowBtn: await stateOf(page, '[data-pc-track-header] .pc-tl-row-acts button'),
    cutAdd: await stateOf(page, '[data-pc="cut-add"]'),
    composer: await stateOf(page, '[data-pc="ai-input"]'),
    tools: await page.evaluate(() => [...document.querySelectorAll('.pc-pv-tool')].map((b) => b.disabled)),
    rename: await stateOf(page, '.pc-projname--btn'),
  };
  const trimRw = await countOf(page, '.pc-clip-trim');
  check('R0.topbar-and-timeline-enabled', !rw.undo.off && !rw.addTrack.off && !rw.rowBtn.off && !rw.cutAdd.off && !rw.rename.off && rw.rename.aria === null && trimRw > 0, { rw, trimRw });
  check('R0.library-and-agent-enabled', !rw.media.off && !rw.composer.off && rw.tools.every((d) => d === false), { rw });
  check('R0.no-readonly-marker', (await page.evaluate(() => document.documentElement.dataset.pcReadonly ?? null)) === null && (await countOf(page, '[data-pc="viewonly-badge"]')) === 0);
  await page.evaluate((id) => window.__pcStore.actions.select([id]), ids[0]);
  await clickVisible(page, '[data-pc-rail="edit"]');
  await sleep(700);
  const rwParams = { start: await stateOf(page, '[data-pc="clip-start"]'), sw: await stateOf(page, '[data-pc="switch-card"]') };
  check('R0.params-enabled', rwParams.start.found && !rwParams.start.off && rwParams.sw.found && !rwParams.sw.off, { rwParams });
  await shot(page, 'rw-full.png');

  /* ── R1 Switch to read-only ── */
  await setAccess(page, 'r');
  const why = await WHY(page);
  await waitFor(() => page.evaluate(() => document.documentElement.dataset.pcReadonly === 'member'), 5000, 'html read-only flag');
  const badge = await stateOf(page, '[data-pc="viewonly-badge"]');
  check('R1.html-marker', (await page.evaluate(() => document.documentElement.dataset.pcReadonlyWhy)) === why && why.length > 5, { why });
  check('R1.badge', badge.found && badge.text === 'View only' && badge.title === why, { badge });

  /* ── R2 Timeline ── */
  const before = await projectJson(page);
  const hdr = await page.evaluate(() => [...document.querySelectorAll('[data-pc-track-header] .pc-tl-row-acts button')].map((b) => ({ d: b.disabled, t: b.title })));
  const addTrack = await stateOf(page, '[data-pc="add-track"]');
  const cutAdd = await stateOf(page, '[data-pc="cut-add"]');
  const trimRo = await countOf(page, '.pc-clip-trim');
  check('R2.row-buttons-off', hdr.length >= 6 && hdr.every((b) => b.d && b.t === why), { hdr: hdr.slice(0, 3) });
  check('R2.add-track-and-cut-off', addTrack.off && addTrack.title === why && cutAdd.off && cutAdd.title === why, { addTrack, cutAdd });
  check('R2.no-trim-handles', trimRo === 0, { trimRo });
  // Actually drag a clip / press Delete / right-click
  const box = await page.evaluate((id) => {
    const r = document.querySelector(`[data-clip-id="${id}"]`).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, ids[1]);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 8, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  check('R2.drag-does-not-change-project', (await projectJson(page)) === before);
  const selected = await page.evaluate(() => window.__pcStore.getState().selection);
  check('R2.click-still-selects', selected.includes(ids[1]), { selected });
  await page.keyboard.press('Delete');
  await sleep(200);
  check('R2.delete-key-blocked', (await projectJson(page)) === before && (await clipIds(page)).length === ids.length);
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await sleep(300);
  const menu = await page.evaluate(() => [...document.querySelectorAll('[data-pc="tl-ctxmenu"] .pc-tl-ctxmenu-item')].map((n) => ({ text: n.textContent.trim(), off: n.getAttribute('aria-disabled') === 'true' })));
  check('R2.context-menu-only-explains', menu.length >= 1 && menu.every((m) => m.off || m.text.startsWith('View captions') || m.text === 'Quote into input box') && menu.some((m) => m.text === why), { menu });
  await shot(page, 'ro-timeline.png');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  // Drop a card onto the timeline: drop target does not accept, no clips added;
  // "New track" drop zone is not rendered either
  const dropRo = await tryDrop(page);
  check('R2.drop-refused', dropRo.cardId && dropRo.accepted === false && dropRo.added === 0 && dropRo.newTrackZone === 0, { dropRo });
  // The asset import function itself also blocks (paths not covered such as file drag-and-drop)
  const importErr = await page.evaluate(async () => {
    const { importMediaFiles } = await import('/src/editor/left/importAssets.ts');
    try { await importMediaFiles([new File(['x'], 'a.mp4', { type: 'video/mp4' })]); return null; } catch (e) { return String(e.message); }
  });
  check('R2.import-function-refuses', importErr === why, { importErr });

  /* ── R3 Parameters panel ── */
  await page.evaluate((id) => window.__pcStore.actions.select([id]), ids[0]);
  await sleep(500);
  const p = {
    start: await stateOf(page, '[data-pc="clip-start"]'),
    end: await stateOf(page, '[data-pc="clip-end"]'),
    sw: await stateOf(page, '[data-pc="switch-card"]'),
  };
  const formControls = await page.evaluate(() => {
    const pane = document.querySelector('[data-pc="inspector"]');
    const els = [...pane.querySelectorAll('input, select, textarea, button')].filter((e) => e.getClientRects().length > 0 && !e.closest('[role="tablist"]') && !e.closest('.pc-lib-chips') && !e.matches('.pc-left-collapse'));
    return { total: els.length, off: els.filter((e) => e.disabled || e.closest('fieldset:disabled') || e.readOnly).length, enabled: els.filter((e) => !(e.disabled || e.closest('fieldset:disabled') || e.readOnly)).map((e) => e.outerHTML.slice(0, 90)) };
  });
  check('R3.header-fields-off', p.start.off && p.end.off && p.sw.off, { p });
  check('R3.all-form-controls-off', formControls.total > 3 && formControls.enabled.length === 0, formControls);
  await shot(page, 'ro-params.png');
  await page.evaluate(() => document.querySelector('[data-pc-tab="code"]').click());
  await sleep(400);
  const code = await stateOf(page, '[data-pc="code-editor"]');
  check('R3.code-readonly-but-selectable', code.found && code.readOnly && !code.disabled, { code });
  await page.evaluate(() => document.querySelector('[data-pc-tab="form"]').click());

  /* ── R4 Media library and animations ── */
  await clickVisible(page, '[data-pc-rail="library"]');
  await sleep(500);
  const media = await stateOf(page, '[data-pc-add="media"]');
  check('R4.import-off', media.off && media.title === why, { media });
  await shot(page, 'ro-library.png');
  await clickVisible(page, '[data-pc-rail="animations"]');
  await sleep(800);
  // Card cells are inside groups; open the first group that has cards
  let cell = { found: false };
  for (let i = 0; i < 6 && !cell.found; i++) {
    await page.evaluate((i) => { const els = [...document.querySelectorAll('[data-pc-group]')]; els[i]?.click(); }, i);
    await sleep(700);
    cell = await stateOf(page, '[data-pc-card]');
  }
  const clipsBefore = (await clipIds(page)).length;
  if (cell.found) await clickVisible(page, '[data-pc-card]');
  await sleep(300);
  check('R4.card-cell-inert', cell.found && cell.aria === 'true' && !cell.draggable && cell.title.endsWith(why) && (await clipIds(page)).length === clipsBefore, { cell, clipsBefore });

  /* ── R5 Preview ── */
  const tools = await page.evaluate(() => [...document.querySelectorAll('.pc-pv-tool')].map((b) => ({ d: b.disabled, t: b.title })));
  check('R5.tools', tools.length === 3 && !tools[0].d && tools[1].d && tools[2].d && tools[1].t.endsWith(why) && tools[2].t.endsWith(why), { tools });
  await page.evaluate(() => window.__pcStore.actions.togglePlay());
  await sleep(400);
  const playing = await page.evaluate(() => window.__pcStore.getState().playing);
  await page.evaluate(() => window.__pcStore.actions.pause());
  check('R5.playback-still-works', playing === true);
  const exportBtn = await page.evaluate(() => { const b = [...document.querySelectorAll('.pc-btn--primary')].find((x) => x.textContent.includes('Export video')); return b ? { off: b.disabled } : null; });
  check('R5.export-still-enabled', exportBtn && exportBtn.off === false, { exportBtn });

  /* ── R6 Right rail Agent ── */
  const ai = {
    input: await stateOf(page, '[data-pc="ai-input"]'),
    send: await stateOf(page, '[data-pc="ai-send"]'),
    preset: await stateOf(page, '[data-pc="ai-start-preset"]'),
    animated: await page.evaluate(() => document.querySelector('[data-pc="ai-start"]')?.getAttribute('data-pc-start-animated') ?? null),
    guide: await page.evaluate(() => document.querySelector('[data-pc="ai-composer"]')?.getAttribute('data-pc-guide') ?? null),
  };
  check('R6.composer-off', ai.input.disabled && ai.input.placeholder === why && ai.send.disabled && ai.send.title === why, { ai });
  check('R6.start-page-no-invite', ai.preset.disabled && ai.preset.title === why && ai.animated === '0' && ai.guide === null, { ai });
  await shot(page, 'ro-agent.png');

  /* ── R7 Top bar ── */
  const undo = await stateOf(page, '[data-pc="undo-btn"] button');
  const undoTip = await page.evaluate(() => document.querySelector('[data-pc="undo-btn"]').title);
  const rename = await stateOf(page, '.pc-projname--btn');
  check('R7.undo-redo-off', undo.disabled && undo.title === why && undoTip === why, { undo, undoTip });
  check('R7.rename-off', rename.aria === 'true' && rename.title === why, { rename });
  await page.evaluate(() => document.querySelector('.pc-projname--btn').click());
  await sleep(200);
  check('R7.rename-does-not-open', (await countOf(page, '.pc-projname--editing')) === 0);
  await clickVisible(page, '.pc-proj-btn');
  await sleep(300);
  const menuItems = await page.evaluate(() => [...document.querySelectorAll('.pc-proj-item')].map((b) => ({ t: b.querySelector('b')?.textContent, d: b.disabled, title: b.title })));
  const byName = (n) => menuItems.find((m) => m.t === n);
  check('R7.save-items-off', byName('Save project')?.d && byName('Save project').title === why && byName('Save as package…')?.d && byName('Save as package…').title === why, { menuItems });
  check('R7.settings-openable', byName('Project settings…') && !byName('Project settings…').d, { menuItems });
  await shot(page, 'ro-project-menu.png');
  await page.evaluate(() => [...document.querySelectorAll('.pc-proj-item')].find((b) => b.querySelector('b')?.textContent === 'Project settings…').click());
  await sleep(500);
  const dlg = await page.evaluate(() => {
    const d = document.querySelector('.pc-dialog');
    const fields = [...d.querySelectorAll('#pc-proj-name, #pc-proj-fps, #pc-proj-duration, #pc-proj-creativity, .pc-dialog-opt')];
    const confirmBtn = d.querySelector('.pc-btn--primary');
    return { note: d.querySelector('[data-pc="settings-readonly-note"]')?.textContent ?? null, fields: fields.length, off: fields.filter((e) => e.disabled || e.closest('fieldset:disabled')).length, confirmDisabled: confirmBtn.disabled, confirmTitle: confirmBtn.title, cancel: [...d.querySelectorAll('.pc-dialog-foot .pc-btn')][0].textContent };
  });
  check('R7.settings-dialog-readonly', dlg.note === why && dlg.fields >= 5 && dlg.off === dlg.fields && dlg.confirmDisabled && dlg.confirmTitle === why && dlg.cancel === 'Close', { dlg });
  await shot(page, 'ro-settings.png');
  await page.keyboard.press('Escape');
  await sleep(300);
  // Desktop app title bar menu (also rendered in this build): Edit → Undo / Redo,
  // File → Save project are grayed out, explanation is that message
  const titlebar = {};
  for (const [menu, cmds] of [['Edit', ['undo', 'redo']], ['File', ['save-project', 'export-video']]]) {
    await page.evaluate((menu) => [...document.querySelectorAll('.pc-titlebar-menu-button')].find((b) => b.textContent.trim() === menu).click(), menu);
    await sleep(250);
    for (const c of cmds) titlebar[c] = await page.evaluate((c) => { const b = document.querySelector(`[data-pc="titlebar-${c}"]`); return b ? { d: b.getAttribute('aria-disabled') === 'true', t: b.title } : null; }, c);
    await page.keyboard.press('Escape');
    await sleep(150);
  }
  check('R7.titlebar-menu', titlebar.undo?.d && titlebar.undo.t === why && titlebar.redo?.d && titlebar['save-project']?.d && titlebar['save-project'].t === why && titlebar['export-video'] && !titlebar['export-video'].d, { titlebar });
  await shot(page, 'ro-full.png');

  /* ── R9 Switch back to read/write ── */
  await setAccess(page, 'rw');
  await sleep(300);
  const back = {
    marker: await page.evaluate(() => document.documentElement.dataset.pcReadonly ?? null),
    addTrack: await stateOf(page, '[data-pc="add-track"]'),
    composer: await stateOf(page, '[data-pc="ai-input"]'),
    trim: await countOf(page, '.pc-clip-trim'),
    tools: await page.evaluate(() => [...document.querySelectorAll('.pc-pv-tool')].map((b) => b.disabled)),
    badge: await countOf(page, '[data-pc="viewonly-badge"]'),
    fences: await countOf(page, 'fieldset.pc-ro-fence[disabled]'),
  };
  const dropRw = await tryDrop(page);
  check('R9.drop-accepted-again', dropRw.accepted === true && dropRw.added === 1 && dropRw.newTrackZone === 1, { dropRw });
  check('R9.back-to-readwrite', back.marker === null && !back.addTrack.off && !back.composer.off && back.trim > 0 && back.tools.every((d) => !d) && back.badge === 0 && back.fences === 0, { back });
  await page.close();

  /* ── R8 ?observe=1 old path ── */
  const ob = await openEditor(origin, '?editor&aimock=1&nosetup=1&observe=1');
  const obState = {
    badge: await stateOf(ob, '[data-pc="viewonly-badge"]'),
    addTrack: await stateOf(ob, '[data-pc="add-track"]'),
    composer: await stateOf(ob, '[data-pc="ai-input"]'),
    media: await stateOf(ob, '[data-pc-add="media"]'),
    tools: await ob.evaluate(() => [...document.querySelectorAll('.pc-pv-tool')].map((b) => b.disabled)),
    marker: await ob.evaluate(() => document.documentElement.dataset.pcReadonly ?? null),
    fences: await countOf(ob, 'fieldset.pc-ro-fence[disabled]'),
    trim: await countOf(ob, '.pc-clip-trim'),
  };
  await ob.evaluate(() => document.querySelector('.pc-proj-btn').click());
  await sleep(300);
  const obMenu = await ob.evaluate(() => [...document.querySelectorAll('.pc-proj-item')].map((b) => ({ t: b.querySelector('b')?.textContent, d: b.disabled })));
  check('R8.observe-badge-unchanged', obState.badge.found && obState.badge.text === 'Read-only view' && obState.badge.title.includes('?observe=1'), { badge: obState.badge });
  check('R8.observe-save-off', obMenu.find((m) => m.t === 'Save project')?.d === true, { obMenu });
  check('R8.observe-has-no-new-locks', obState.marker === null && !obState.addTrack.off && !obState.composer.off && !obState.media.off && obState.tools.every((d) => !d) && obState.fences === 0 && obState.trim > 0, obState);
  await shot(ob, 'observe-full.png');
  await ob.close();

  /* ── Mobile app: only appears in online builds; start another online-mode dev server here ── */
  if (WITH_MOBILE) {
    const logFile = path.join(tmp, 'vite-online.log');
    const child = spawn(process.execPath, [viteBin(), '--mode', 'online', '--port', String(MOBILE_PORT), '--strictPort', '--host', '127.0.0.1'], {
      cwd: REPO, env: { ...process.env, BROWSER: 'none', ...serverEnv() }, stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')], windowsHide: true,
    });
    mobileServer = { stop: () => killTree(child.pid) };
    await waitHttp(`http://127.0.0.1:${MOBILE_PORT}/`, () => true, 120_000, 'online-mode dev server').catch(() => {});
    const mob = await openEditor(`http://127.0.0.1:${MOBILE_PORT}/editor`, '?editor&layout=mobile', { width: 390, height: 844 });
    await waitFor(() => mob.evaluate(() => !!document.querySelector('[data-pcm="editor"]')), 60_000, 'mobile app editor page');
    await setAccess(mob, 'r', '/editor');
    const mWhy = await WHY(mob, '/editor');
    const m = await mob.evaluate(() => ({
      flag: document.querySelector('[data-pcm="editor"]')?.getAttribute('data-readonly'),
      sub: [...document.querySelectorAll('[data-pcm="subnav-preview"] button')].map((b) => ({ d: b.disabled, t: b.title })),
      undo: document.querySelector('[data-pcm="undo"]')?.disabled,
      play: document.querySelector('[data-pcm="play"]')?.disabled,
      exportBtn: document.querySelector('[data-pcm="top-export"]')?.disabled,
      bar: document.querySelector('[data-pcm="ro-bar"]')?.textContent ?? null,
    }));
    check('M1.mobile-subnav-off', m.bar === mWhy && m.flag === '1' && m.sub.length > 0 && m.sub.every((b) => b.d && b.t === mWhy) && m.undo === true && m.play === false && m.exportBtn === false, { m });
    await shot(mob, 'ro-mobile.png');
    await mob.evaluate(() => document.querySelector('[data-pcm="pg-agent"]').click());
    await sleep(1200);
    const a = await mob.evaluate(() => ({
      composer: document.querySelector('[data-pcm="agent-composer"]')?.getAttribute('data-readonly') ?? null,
      note: document.querySelector('[data-pcm="agent-composer"] .note')?.textContent ?? null,
      input: !!document.querySelector('[data-pcm="chat-input"]'),
      start: document.querySelector('[data-pcm="agent-start"]')?.getAttribute('data-readonly') ?? null,
    }));
    check('M2.mobile-agent-composer-explains', a.composer === '1' && a.note === mWhy && !a.input, { a });
    await shot(mob, 'ro-mobile-agent.png');
    // Timeline tab: dragging to translate card clip after click-select: does not move in read-only,
    // moves in read/write
    const mobProject = () => mob.evaluate(() => JSON.stringify(window.__pcStore.getState().project));
    const dragClip = async () => {
      const box = await mob.evaluate(() => { const r = document.querySelector('[data-pcm="clip"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await mob.mouse.click(box.x, box.y); // Click to select first
      await sleep(300);
      await mob.mouse.move(box.x, box.y);
      await mob.mouse.down();
      await mob.mouse.move(box.x + 70, box.y, { steps: 6 });
      await mob.mouse.up();
      await sleep(400);
    };
    await mob.evaluate(async () => {
      const { allCards } = await import('/editor/src/kernel/registry.ts');
      window.__pcStore.actions.addCardClip(allCards()[0].id, 2, {});
    });
    await mob.evaluate(() => document.querySelector('[data-pcm="pg-timeline"]').click());
    await sleep(1200);
    const mBefore = await mobProject();
    await dragClip();
    check('M3.mobile-timeline-drag-refused', (await mobProject()) === mBefore, { clips: await mob.evaluate(() => document.querySelectorAll('[data-pcm="clip"]').length) });
    const align = await mob.evaluate(() => [...document.querySelectorAll('[data-pcm="align-start"],[data-pcm="align-end"]')].map((b) => b.disabled));
    check('M3.mobile-align-off', align.length === 2 && align.every(Boolean), { align });
    await shot(mob, 'ro-mobile-timeline.png');
    await setAccess(mob, 'rw', '/editor');
    const mBefore2 = await mobProject();
    await dragClip();
    check('M3.mobile-timeline-drag-works-in-readwrite', (await mobProject()) !== mBefore2);
    await mob.close();
  }
} catch (e) {
  check('probe.run', false, { error: String(e?.stack ?? e) });
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ summary: { total: results.length, failed: failed.length, failedChecks: failed.map((r) => r.check) } }));
  if (browser && !KEEP) await browser.close().catch(() => {});
  if (server && !KEEP) server.stop();
  if (mobileServer && !KEEP) mobileServer.stop();
  process.exitCode = failed.length ? 1 : 0;
}
