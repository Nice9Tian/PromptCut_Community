/**
 * Acceptance probe for conflict merge window (0.7.19, branch claude/conflict-merge): run through
 * each of the desktop and mobile interfaces, take screenshots.
 * Entirely local: local hosted setup + two nginx-like proxies (`lib/mobile-env.mjs`), online build
 * as the page, no remote connections.
 *
 *   npx vite build --mode online
 *   node scripts/probes/conflict-merge-probe.mjs [--dist dist-online] [--out out/conflict-merge] [--base-port 5890] [--base2-port 5893] [--doc-port 5896] [--asset-port 5897]
 *
 * Roles: A (desktop interface, first proxy), B (another member, second proxy), A's phone (same
 * user "A", mobile interface, first proxy).
 *   D1 Disconnect A only: while A is disconnected, A changes c1 opacity twice and duration, changes
 *      c4 name, deletes c2; B simultaneously changes c1 opacity, changes c2, deletes c4
 *   D2 A reconnects: offline batches transfer item by item into the pending merge table, conflict
 *      merge window opens automatically; level 1 by item (c1, c2, c4), level 2 by property (only
 *      one for c1 opacity)
 *   D3 "Select non-conflicting items" checks only c1 duration; click "Merge": B's side sees
 *      duration changed, opacity remains B's
 *   D4 Close window via "Maybe later": "Merge conflicts" button remains at the top of the
 *      navigation bar
 *   D5 A's phone (same user) enters project: conflict banner displays same table (pending merge
 *      table stored in document service, by project × user); check, merge, or delete selected in
 *      panel item by item; banner collapses when done, desktop "Merge conflicts" button disappears
 *      too
 *   D6 When online browser is disconnected, "Import media" is grayed out with "Currently offline"
 *      (desktop and mobile)
 * The last line of the result is a JSON line; screenshots are written to --out.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv, gateClear } from './lib/mobile-env.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'conflict-merge')));
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, steps: {} };
const step = (k, v) => { out.steps[k] = v; console.log(JSON.stringify({ step: k, ...((v && typeof v === 'object') ? v : { v }) })); };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`Timed out waiting for: ${what}`); return null; }
    await sleep(every);
  }
}
const shots = [];
const shot = async (page, name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f }).catch(() => {}); shots.push(f); };
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const clipOf = (page, id) => store(page, 'return S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === args[0]) ?? null;', id);
const textOf = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? null, sel);
const clickSel = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e || e.disabled) return false; e.click(); return true; }, sel);
const tap = async (page, sel) => {
  await gateClear(page);
  const r = await page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const q = e.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; }, sel);
  if (!r) throw new Error(`Cannot click ${sel}`);
  await page.touchscreen.tap(r.x, r.y);
  await sleep(350);
};

const project = {
  version: 1, id: `merge-probe-${Date.now().toString(36)}`, name: 'Merge conflicts demo', width: 1920, height: 1080, fps: 30, duration: 12, themeId: 'midnight', media: [],
  tracks: [{ id: 't-1', name: 'Track 1', clips: [
    { id: 'c1', cardId: 'mu-blur-fade', start: 0, end: 2, params: {}, opacity: 0.4, label: 'Opening' },
    { id: 'c2', cardId: 'mu-typing', start: 2.5, end: 4.5, params: {}, label: 'Typing' },
    { id: 'c3', cardId: 'blur-text', start: 5, end: 7, params: {}, label: 'Slogan' },
    { id: 'c4', cardId: 'checklist', start: 7.5, end: 9.5, params: {}, label: 'Checklist' },
  ] }],
  cuts: [{ id: 'cut-1', name: 'Cut 1' }], activeCutId: 'cut-1',
};

const env = await startMobileEnv({
  dist: DIST, basePort: Number(arg('--base-port', 5890)), base2Port: Number(arg('--base2-port', 5893)),
  docPort: Number(arg('--doc-port', 5896)), assetPort: Number(arg('--asset-port', 5897)), name: `merge-probe-${Date.now().toString(36)}`,
});
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--window-position=-32000,-32000'] });
try {
  const seeded = await env.seed(project);
  check(!/error|reject/i.test(`${seeded.opened}${seeded.seeded}`), 'Written into the initial project on the creator\'s behalf', seeded);

  const A = await env.newPage(browser, 'desktop');
  await env.enter(A, { layout: 'desktop', username: 'jia' });
  const B = await env.newPage(browser, 'desktop');
  await env.enter(B, { layout: 'desktop', username: 'yi', via: 2 });
  await until('A and B both see the four clips', async () => (await clipOf(A, 'c4')) && (await clipOf(B, 'c4')), 60_000);
  await sleep(1500);

  /* ---------------- D1 Disconnect A only ---------------- */
  env.proxy.cutWs();
  await sleep(800);
  await store(A, 'S.actions.updateClip("c1", { opacity: 0.6 }); return true;');
  await sleep(200);
  await store(A, 'S.actions.updateClip("c1", { opacity: 0.9 }); return true;');
  await store(A, 'S.actions.updateClip("c4", { label: "Checklist (edited by A)" }); return true;');
  await store(A, 'S.actions.removeClip("c2"); return true;');
  // Change c1 duration: directly modify end time (same as a moveClip modification)
  await store(A, 'S.actions.moveClip("c1", { start: 0, end: 2.4 }); return true;');
  const unsent = await until('A is judged offline with unsubmitted changes', () => A.$('[data-pc="offline-unsent"]'), 150_000, 500);
  step('D1-offline', { unsent: !!unsent, text: unsent ? await textOf(A, '[data-pc="offline-unsent"]') : null });
  await shot(A, 'desktop-0-offline');
  // Gray out "Import media" when disconnected (D6 desktop)
  const importBtn = await A.evaluate(() => { const b = document.querySelector('[data-pc-add="media"]'); return b ? { disabled: b.disabled, text: b.innerText, title: b.title } : null; });
  step('D6-desktop-import', importBtn);
  check(importBtn?.disabled && /Currently offline/.test(importBtn.text), 'D6 when the desktop app is offline, import media is grayed out and the hint says currently offline', importBtn);
  await shot(A, 'desktop-6-import-offline');
  await store(B, 'S.actions.updateClip("c1", { opacity: 0.7 }); return true;');
  await store(B, 'S.actions.updateClip("c2", { label: "Typing (edited by B)" }); return true;');
  await store(B, 'S.actions.removeClip("c4"); return true;');
  await sleep(2000);

  /* ---------------- D2 A reconnects: window opens automatically ---------------- */
  env.proxy.blockWs = false;
  const win = await until('Merge conflicts window opened', () => A.$('[data-pc="conflict-merge"]'), 150_000, 500);
  await sleep(800);
  const rows = await A.evaluate(() => [...document.querySelectorAll('[data-pc="merge-thing"]')].map((li) => ({
    key: li.getAttribute('data-key'), head: li.querySelector('.pc-merge-thing-head')?.innerText.replace(/\s+/g, ' '),
    props: [...li.querySelectorAll('[data-pc="merge-prop"]')].map((p) => p.innerText.replace(/\s+/g, ' ')),
  })));
  step('D2-rows', { open: !!win, summary: await textOf(A, '[data-pc="merge-summary"]'), rows });
  const keys = rows.map((r) => r.key).sort();
  check(JSON.stringify(keys) === JSON.stringify(['offline:clip:c1', 'offline:clip:c2', 'offline:clip:c4']), 'D2 level 1 is per object: one entry each for c1, c2, c4', keys);
  // Expand c1 to view level 2
  await A.evaluate(() => { for (const li of document.querySelectorAll('[data-pc="merge-thing"]')) { const b = li.querySelector('.pc-merge-expand'); if (b?.getAttribute('aria-expanded') === 'false') b.click(); } });
  await sleep(300);
  const c1Props = await A.evaluate(() => [...document.querySelectorAll('[data-pc="merge-thing"][data-key="offline:clip:c1"] [data-pc="merge-prop"]')].map((p) => p.innerText.replace(/\s+/g, ' ').trim()));
  step('D2-c1-props', { c1Props });
  check(c1Props.length === 2 && c1Props.some((t) => t.includes('Opacity 0.4 → 0.9 (cloud is now 0.7)')) && c1Props.some((t) => t.startsWith('Time')), 'D2 c1 level 2: opacity has only one entry (changed twice), time has one entry, and it states what the cloud value is now', c1Props);
  await shot(A, 'desktop-1-window');

  /* ---------------- D3 Select non-conflicting items → Merge ---------------- */
  await clickSel(A, '[data-pc="merge-select-clean"]');
  await sleep(300);
  const picked = await A.evaluate(() => [...document.querySelectorAll('[data-pc="merge-prop"] input:checked')].map((i) => i.closest('[data-pc="merge-prop"]').innerText.replace(/\s+/g, ' ').trim()));
  step('D3-picked', { picked });
  check(picked.length === 1 && picked[0].startsWith('Time'), 'D3 selecting conflict-free items ticks only the length of c1', picked);
  await shot(A, 'desktop-2-select-clean');
  await clickSel(A, '[data-pc="merge-apply"]');
  await sleep(1500);
  const note = await textOf(A, '[data-pc="merge-note"]');
  const bC1 = await until('B sees that the length of c1 changed', async () => { const c = await clipOf(B, 'c1'); return c && c.end === 2.4 ? c : null; }, 20_000);
  const statusChip = await textOf(A, '[data-pc="sync-online-status"]');
  step('D3-merged', { note, bC1: bC1 && { end: bC1.end, opacity: bC1.opacity }, statusChip });
  check(!statusChip || !statusChip.includes('have been submitted'), 'D2 after offline changes move into the pending merge table, the top bar does not say "Changes made offline are all submitted"', statusChip);
  check(bC1 && bC1.opacity === 0.7, 'D3 after merging: length follows A, opacity stays B\'s', bC1);
  await shot(A, 'desktop-3-merged');

  /* ---------------- D4 Maybe later → navigation bar button ---------------- */
  await clickSel(A, '[data-pc="merge-close"]');
  await sleep(500);
  const navBtn = await textOf(A, '[data-pc="conflict-merge-open"]');
  step('D4-nav-button', { navBtn });
  check(!!navBtn && navBtn.includes('Merge conflicts'), 'D4 after the window is closed, the "Merge conflicts" button is still at the top of the navigation bar', navBtn);
  await shot(A, 'desktop-4-nav-button');

  /* ---------------- D5 Same user's phone ---------------- */
  const M = await env.newPage(browser, 'phone');
  await env.enter(M, { layout: 'mobile', username: 'jia' });
  const bar = await until('the conflict bar on mobile', () => M.$('[data-pcm="cfbar"]'), 60_000, 500);
  step('D5-bar', { bar: bar ? await textOf(M, '[data-pcm="cfbar-text"]') : null });
  check(!!bar, 'D5 the same user sees the same pending merge table on mobile (conflict bar)');
  await shot(M, 'mobile-1-bar');
  // Bubble when entering project (e.g. "Switched to low memory mode") covers "Process" on right of banner; click element directly if unable to click
  await tap(M, '[data-pcm="cfbar-open"]');
  if (!(await M.$('[data-pcm="sheet-conflict"]'))) await clickSel(M, '[data-pcm="cfbar-open"]');
  await M.waitForSelector('[data-pcm="sheet-conflict"]', { visible: true, timeout: 20_000 });
  await sleep(500);
  const mRows = await M.evaluate(() => [...document.querySelectorAll('[data-pcm="cf-thing"]')].map((g) => ({ key: g.getAttribute('data-key'), text: g.innerText.replace(/\s+/g, ' ') })));
  step('D5-sheet', { mRows });
  check(mRows.length === 3, 'D5 the mobile panel has three level-1 entries (c1 with only opacity left, c2, c4)', mRows);
  await shot(M, 'mobile-2-sheet');
  // Check entire c4 row (I modified, others deleted) → Merge = restore along with my modifications
  await M.evaluate(() => document.querySelector('[data-pcm="cf-thing"][data-key="offline:clip:c4"] .cf-head input')?.click());
  await sleep(300);
  await shot(M, 'mobile-3-picked');
  await tap(M, '[data-pcm="cf-merge"]');
  const restored = await until('B sees c4 restored', async () => { const c = await clipOf(B, 'c4'); return c && c.label === 'Checklist (edited by A)' ? c : null; }, 20_000);
  step('D5-restored', { restored: restored && { label: restored.label }, note: await textOf(M, '[data-pcm="cf-note"]') });
  // Check all remaining items (c1 opacity, c2 deletion) → Delete selected: keep current state in cloud
  await M.evaluate(() => { for (const i of document.querySelectorAll('[data-pcm="cf-thing"] .cf-head input')) if (!i.checked) i.click(); });
  // Panel repaints after checking; wait for "Delete selected" to become clickable
  await M.waitForSelector('[data-pcm="cf-drop"]:not([disabled])', { timeout: 5000 });
  await sleep(300);
  await tap(M, '[data-pcm="cf-drop"]');
  await sleep(1200);
  const doneText = await textOf(M, '[data-pcm="cf-close"]');
  step('D5-done', { close: doneText });
  check(doneText === 'Done', 'D5 after clearing, the close button becomes "Done"', doneText);
  await shot(M, 'mobile-4-done');
  const bC2 = await clipOf(B, 'c2');
  check(bC2 && bC2.label === 'Typing (edited by B)', 'D5 delete selected: c2 keeps the current cloud state (the version B edited)', bC2);
  await tap(M, '[data-pcm="cf-close"]');
  const barGone = await until('the mobile bar collapses', async () => !(await M.$('[data-pcm="cfbar"]')), 20_000);
  const navGone = await until('the desktop "Merge conflicts" button disappears too', async () => !(await A.$('[data-pc="conflict-merge-open"]')), 20_000);
  step('D5-cleared', { barGone: !!barGone, navGone: !!navGone });
  await shot(M, 'mobile-5-cleared');
  await shot(A, 'desktop-5-cleared');

  /* ---------------- D6 Gray out import when mobile is disconnected ---------------- */
  env.proxy.cutWs();
  await until('mobile detected as offline', () => M.evaluate(() => document.querySelector('[data-pc="offline-unsent"]') !== null || true), 5_000);
  await sleep(6000);
  await tap(M, '[data-pcm="sub-image"]').catch(() => {});
  await M.waitForSelector('[data-pcm="sheet-assets"]', { visible: true, timeout: 20_000 }).catch(() => {});
  const mImport = await until('mobile import button grayed out', async () => {
    const r = await M.evaluate(() => { const b = document.querySelector('[data-pcm="import"]'); return b ? { disabled: b.disabled, text: b.innerText } : null; });
    return r?.disabled ? r : null;
  }, 60_000, 500);
  const dropzone = await M.evaluate(() => { const b = document.querySelector('[data-pcm="import-dropzone"]'); return b ? { disabled: b.disabled, text: b.innerText } : null; });
  step('D6-mobile-import', { head: mImport, dropzone });
  check(mImport && /Currently offline/.test(mImport.text), 'D6 when mobile is offline, import is grayed out and the hint says currently offline', mImport);
  check(!dropzone || (dropzone.disabled && /Currently offline/.test(dropzone.text)), 'D6 the import on the blank area of the mobile media library is grayed out too', dropzone);
  await shot(M, 'mobile-6-import-offline');
  env.proxy.blockWs = false;

  out.errors = { A: A.errors, M: M.errors };
} catch (e) {
  fails.push(`Exception: ${e?.stack ?? e}`);
} finally {
  await browser.close().catch(() => {});
  await env.close();
}
out.ok = fails.length === 0;
out.fails = fails;
out.shots = shots;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
