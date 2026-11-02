import '../lib/no-user-dirs.mjs';
/**
 * Probe verifying that the browser version does not render the application titlebar
 * ((user decision, 2026-10-22): omit "Show top menu bar" and the three − □ × buttons; desktop app
 * unchanged). Opens one editor page each in headless Chrome to inspect the real DOM rather than
 * reading source code:
 *
 *   node scripts/probes/browser-titlebar-probe.mjs [--online-port 5960] [--desktop-port 5963] [--out out/browser-titlebar]
 *
 * Starts two dev servers itself (`PROMPTCUT_NO_PORT_FILE=1`, no shared port file written; each takes
 * "port + 1" and "+ 2" as stage ports, so three consecutive ports must be free):
 *   - Online: `vite --mode online` (compile-time constant `VITE_PC_ONLINE=1`), opens `/?editor`;
 *   - Desktop: `vite` (default mode), opens `/?editor`.
 *
 * Checks (one JSON line `{ check, ok, ... }` per item, final line `{ summary }`; exit code 1 on failure):
 *   O1 Online: editor top bar is present (`.pc-bar--main`), and `.pc-titlebar`, `.pc-titlebar-menus`,
 *      `.pc-titlebar-window-controls`, and `.pc-window-control` are absent from the page, as are
 *      buttons in the application menu (`nav[aria-label="Application menu"]`).
 *   O2 Online: no empty placeholder: editor top bar sits against the top edge of the page (top y = 0).
 *   O3 Online: top bar "⋯" menu contains: Skin…, Shortcuts, About PromptCut; clicking "Shortcuts"
 *      and "About PromptCut" each opens a dialog once (dialog text matches).
 *   O4 Online: entry points for the other five items are on the top bar: Undo, Redo, Home,
 *      Export video (buttons are present, undo and redo buttons are present).
 *   D1 Desktop: `.pc-titlebar` is present; menu bar (File/Edit/View/Help) and three window buttons
 *      (Minimize/Maximize/Close) are all present.
 *   D2 Desktop: clicking "File" opens its menu containing "Export video" and "Back to home";
 *      clicking "Help" opens its menu containing "Shortcuts" and "About PromptCut".
 *   D3 Desktop: top bar "⋯" menu does not contain "Shortcuts" or "About PromptCut" (no duplication).
 * Screenshots written to `--out`: `online-editor.png` (online, neither titlebar group present),
 * `online-more-menu.png` (online, "⋯" menu expanded), `desktop-editor.png` (desktop, both groups present),
 * `desktop-file-menu.png` (desktop, "File" menu expanded).
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const ONLINE_PORT = Number(arg('online-port', '5960'));
const DESKTOP_PORT = Number(arg('desktop-port', '5963'));
const OUT = path.resolve(ROOT, arg('out', 'out/browser-titlebar'));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const report = (check, ok, extra = {}) => { results.push({ check, ok }); console.log(JSON.stringify({ check, ok, ...extra })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');

function startVite(port, mode) {
  const args = [viteBin, ...(mode ? ['--mode', mode] : []), '--port', String(port), '--strictPort', '--host', '127.0.0.1'];
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, PROMPTCUT_NO_PORT_FILE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.getLog = () => log;
  return child;
}
async function waitHttp(port, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await sleep(300);
  }
  return false;
}
const killTree = (child) => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* Exited */ } };

const servers = [startVite(ONLINE_PORT, 'online'), startVite(DESKTOP_PORT, null)];
let browser;
try {
  for (const [s, port] of [[servers[0], ONLINE_PORT], [servers[1], DESKTOP_PORT]]) {
    if (!(await waitHttp(port))) { report('dev-server', false, { port, log: s.getLog().slice(-600) }); throw new Error(`dev server ${port} did not start`); }
  }
  browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-size=1500,900'], defaultViewport: { width: 1500, height: 900 } });

  async function openEditor(port) {
    const page = await browser.newPage();
    const dialogs = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await page.goto(`http://127.0.0.1:${port}/?editor`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pc-bar--main', { timeout: 60000 });
    await sleep(1500); // Let skin and layout settle
    return { page, dialogs };
  }
  const textOf = (page, sel) => page.$$eval(sel, (els) => els.map((e) => (e.textContent || '').trim()));
  const clickByText = async (page, sel, text) => {
    const handles = await page.$$(sel);
    for (const h of handles) {
      const t = await h.evaluate((e) => (e.textContent || '').trim());
      if (t.startsWith(text)) { await h.click(); return true; }
    }
    return false;
  };

  // ---------------- Online
  {
    const { page, dialogs } = await openEditor(ONLINE_PORT);
    const probe = await page.evaluate(() => ({
      online: Boolean(document.querySelector('.pc-bar--main')),
      titlebar: document.querySelectorAll('.pc-titlebar').length,
      menus: document.querySelectorAll('.pc-titlebar-menus').length,
      controls: document.querySelectorAll('.pc-titlebar-window-controls').length,
      controlBtns: document.querySelectorAll('.pc-window-control').length,
      menuButtons: [...document.querySelectorAll('button')].filter((b) => b.classList.contains('pc-titlebar-menu-button') || b.closest('nav[aria-label="Application menu"]')).map((b) => (b.textContent || '').trim()),
      barTop: document.querySelector('.pc-bar--main')?.getBoundingClientRect().top,
    }));
    report('O1 online: the title bar\'s menu row and the window buttons are all absent', probe.online && probe.titlebar === 0 && probe.menus === 0 && probe.controls === 0 && probe.controlBtns === 0 && probe.menuButtons.length === 0, probe);
    report('O2 online: the top bar sits flush against the top edge of the page, with no empty placeholder', probe.barTop === 0, { barTop: probe.barTop });
    await page.screenshot({ path: path.join(OUT, 'online-editor.png') });

    // O4 Entry points for the other five items are on the top bar
    const entries = await page.evaluate(() => ({
      undo: Boolean(document.querySelector('[data-pc="undo-btn"] button')),
      redo: Boolean(document.querySelector('[data-pc="redo-btn"] button')),
      labels: [...document.querySelectorAll('.pc-bar--main .pc-btn')].map((b) => (b.textContent || '').trim()),
    }));
    report('O4 online: the entries for Undo, Redo, Home and Export video are on the top bar', entries.undo && entries.redo && entries.labels.includes('home page') && entries.labels.includes('Export video'), entries);

    // O3 "⋯" menu
    await page.click('button[title="More settings"]');
    await page.waitForSelector('.pc-more-menu', { timeout: 5000 });
    const items = await textOf(page, '.pc-more-menu .pc-btn');
    report('O3a online: the "⋯" menu contains Skin…, Keyboard shortcuts, About PromptCut', ['Skin…', 'Keyboard shortcuts', 'About PromptCut'].every((t) => items.includes(t)), { items });
    await page.screenshot({ path: path.join(OUT, 'online-more-menu.png') });
    await page.click('[data-pc="more-shortcuts"]');
    await sleep(300);
    await page.click('button[title="More settings"]');
    await page.waitForSelector('[data-pc="more-about"]', { timeout: 5000 });
    await page.click('[data-pc="more-about"]');
    await sleep(300);
    report('O3b online: clicking "Keyboard shortcuts" and "About PromptCut" each pops up the matching description', dialogs.length === 2 && dialogs[0].startsWith('Space Play/pause') && dialogs[1].startsWith('PromptCut'), { dialogs });
    await page.close();
  }

  // ---------------- Desktop
  {
    const { page } = await openEditor(DESKTOP_PORT);
    const probe = await page.evaluate(() => ({
      titlebar: document.querySelectorAll('.pc-titlebar').length,
      menuButtons: [...document.querySelectorAll('.pc-titlebar-menu-button')].map((b) => (b.textContent || '').trim()),
      controls: [...document.querySelectorAll('.pc-window-control')].map((b) => b.getAttribute('aria-label')),
      barTop: document.querySelector('.pc-bar--main')?.getBoundingClientRect().top,
    }));
    report('D1 desktop: the title bar, the menu row (File/Edit/View/Help) and the three window buttons are all present', probe.titlebar === 1 && JSON.stringify(probe.menuButtons) === JSON.stringify(['File', 'Edit', 'View', 'Help']) && JSON.stringify(probe.controls) === JSON.stringify(['Minimize', 'Maximize', 'Close']), probe);
    await page.screenshot({ path: path.join(OUT, 'desktop-editor.png') });

    await clickByText(page, '.pc-titlebar-menu-button', 'File');
    await page.waitForSelector('.pc-titlebar-menu', { timeout: 5000 });
    const fileItems = await textOf(page, '.pc-titlebar-menu .pc-titlebar-menu-item');
    await page.screenshot({ path: path.join(OUT, 'desktop-file-menu.png') });
    // When a menu is open, moving the mouse over another menu name switches to it (onMouseEnter);
    // hover is used here, as clicking would collapse the menu that was just switched to
    const helpBtn = (await page.$$('.pc-titlebar-menu-button'))[3];
    await helpBtn.hover();
    await sleep(300);
    const helpItems = await textOf(page, '.pc-titlebar-menu .pc-titlebar-menu-item');
    report('D2 desktop: the "File" menu contains Export video, Back to home; the "Help" menu contains Keyboard shortcuts, About PromptCut',
      fileItems.some((t) => t.startsWith('Export video')) && fileItems.some((t) => t.startsWith('Back to home')) && helpItems.some((t) => t.startsWith('Keyboard shortcuts')) && helpItems.some((t) => t.startsWith('About PromptCut')), { fileItems, helpItems });

    await page.keyboard.press('Escape');
    await sleep(300);
    const stillOpen = await page.$$eval('.pc-titlebar-menu', (els) => els.length);
    await page.click('button[title="More settings"]');
    try { await page.waitForSelector('.pc-more-menu', { timeout: 5000 }); } catch (e) { await page.screenshot({ path: path.join(OUT, 'debug-d3.png') }); console.log(JSON.stringify({ debug: 'd3', stillOpen })); throw e; }
    const items = await textOf(page, '.pc-more-menu .pc-btn');
    report('D3 desktop: the "⋯" menu does not contain Keyboard shortcuts or About PromptCut (no duplicates)', !items.includes('Keyboard shortcuts') && !items.includes('About PromptCut'), { items });
    await page.close();
  }
} catch (e) {
  report('probe', false, { error: String(e?.stack || e).slice(0, 800) });
} finally {
  try { await browser?.close(); } catch { /* Closed */ }
  for (const s of servers) killTree(s);
}
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: { ok: failed === 0, checks: results.length, failed } }));
process.exit(failed === 0 ? 0 : 1);
