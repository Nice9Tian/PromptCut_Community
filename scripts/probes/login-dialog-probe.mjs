// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * Login dialog of the online browser (issue #2, user 2026-11-03): logged-out visitors land on the Vibe
 * mode start page, and signing in happens in a dialog over it.
 *
 * Runs the real `OnlineStart` + `LoginDialog` in `src/start/login-dialog-harness.tsx`, which plugs a fake
 * account business layer and a fake account client into the extension slots (the community edition has no
 * account layer of its own). Google's script is stood in for by a plain button, or blocked to test
 * "can't reach Google". No cloud, no account service.
 *
 *   node scripts/probes/login-dialog-probe.mjs [--out <screenshot-dir>] [--port 5980] [--no-shots]
 * Port range 5980-5989 (one port; this probe starts no stage).
 *
 * Acceptance (each failure is a line in `fails` of the JSON printed last; exit code 0 passes, 1 fails):
 *   D1  Logged out the page is the start page, not a login page; the top bar's account slot shows "Sign in"
 *       and no account chip.
 *   D2  "Sign in" opens a modal dialog on the choose page: Account login, the Google button, Sign up with
 *       email, the terms line linking /terms and /privacy, and "Continue as guest".
 *   D3  Esc, the backdrop and × each close it, and focus goes back to "Sign in".
 *   D4  Tab and Shift+Tab never leave the dialog.
 *   D5  Account login turns the page forward (ps-ld-in-fwd), Back turns it back (ps-ld-in-back);
 *       under reduced motion there is no animation.
 *   D6  A wrong password shows the error inside the dialog and keeps it open; the right one closes it and
 *       the account chip shows the name.
 *   D7  Logged out, expanding the sidebar and sending a sentence each open the dialog; after signing in the
 *       sentence is carried on (a project is created).
 *   D8  Email sign-up: register → adopt the session → send the code → verify page (stays open while signed
 *       in); a wrong code shows the mapped error; the right code closes it.
 *   D9  Sending the code fails (email taken): the verify page says the account is ready, shows the error
 *       in the page language, and offers to send again.
 *   D10 A client without `register` hides "Sign up with email" and the "No account?" link.
 *   D11 Google unreachable: the note is shown and the other two ways remain.
 *   D12 First Google sign-in: the pick page names the email; creating the account closes the dialog.
 *   D13 Opened at a project's direct address while logged out: the dialog opens by itself.
 *   D14 "Continue as guest" signs in as a guest and closes the dialog.
 *   D15 Phone width (375): the dialog fits inside the viewport with no horizontal scroll.
 *   D16 The archived full-page login is still there with `?login=page`.
 *   D17 Chinese and Japanese: the choose page's title, subtitle and buttons are the website dialog's wording.
 *   D18 No page errors.
 * Screenshots (unless --no-shots): every page × en / zh-CN / ja × studio-dark / studio-light.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 10 * 60_000).unref();

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'login-dialog-shots')));
const PORT = Number(arg('--port', 5980));
const SHOTS = !argv.includes('--no-shots');
if (PORT < 5980 || PORT > 5989) throw new Error(`Port ${PORT} is not within 5980-5989, the range assigned to this probe`);
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const results = {};
const check = (cond, label, extra) => { results[label] = !!cond; if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portOpen = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
if (await portOpen(PORT)) throw new Error(`Port ${PORT} is already in use`);

const vite = await createViteServer({
  configFile: false, root: ROOT, plugins: [react()], appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, hmr: false, fs: { strict: true, deny: ['**/.git/**', '**/out/**', '**/.env*', '**/*.{pem,key,crt}'] } },
});
const HTML = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%}#root{height:100%}</style></head><body><div id="root"></div><script type="module" src="/src/start/login-dialog-harness.tsx"></script></body></html>';
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
  if (pathname === '/' || pathname.startsWith('/editor')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(HTML);
    return;
  }
  // The device identity the account client is made with (`ensureDevice` in syncManager)
  if (pathname === '/api/docservice/device') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deviceId: 'harness-device', deviceName: 'Harness' }));
    return;
  }
  if (pathname.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"ok":false}'); return; }
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (!pathname.startsWith('/src/') && !pathname.startsWith('/node_modules/') && !pathname.startsWith('/@') && !pathname.startsWith('/__vite') && !pathname.startsWith('/server/')) { res.writeHead(404); res.end(); return; }
  vite.middlewares(req, res, () => { res.writeHead(404); res.end(); });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });

const browser = await puppeteer.launch({ headless: true, protocolTimeout: 300_000, args: [...PROBE_CHROME_ARGS, '--no-first-run'] });
const errors = [];

/** Open the harness with these address switches, skin and size */
async function open(query = '', { skin = 'studio-dark', width = 1280, height = 820, reduced = false, blockGoogle = false } = {}) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${query}: ${String(e?.message ?? e)}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/accounts\.google\.com|ERR_FAILED|404/.test(m.text())) errors.push(`${query}: console:${m.text()}`); });
  if (blockGoogle) {
    await page.setRequestInterception(true);
    page.on('request', (r) => (r.url().includes('accounts.google.com') ? r.abort() : r.continue()));
  }
  await page.evaluateOnNewDocument((s) => { try { localStorage.setItem('pc.skin', s); localStorage.setItem('pc.skin.studioMigrated', '1'); } catch { /* ignore */ } }, skin);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }]);
  await page.setViewport({ width, height });
  await page.goto(`http://127.0.0.1:${PORT}/editor/${query ? `?${query}` : ''}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-pc="start-online"], [data-pc="start-vibe-login"]', { timeout: 120_000 });
  await sleep(300);
  return page;
}
const has = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);
const dialogPage = (page) => page.evaluate(() => document.querySelector('[data-pc="start-login-dialog"]')?.getAttribute('data-page') ?? null);
const click = async (page, sel) => { await page.waitForSelector(sel, { visible: true, timeout: 10_000 }); await page.click(sel); };
const type = async (page, sel, value) => {
  await page.waitForSelector(sel, { visible: true, timeout: 10_000 });
  await page.focus(sel);
  await page.evaluate((s) => document.querySelector(s).select(), sel);
  await page.keyboard.press('Backspace');
  await page.type(sel, value);
};
const waitPage = (page, name) => page.waitForFunction((n) => document.querySelector('[data-pc="start-login-dialog"]')?.getAttribute('data-page') === n, { timeout: 10_000 }, name).then(() => true, () => false);
const waitClosed = (page) => page.waitForFunction(() => !document.querySelector('[data-pc="start-login-dialog"]'), { timeout: 10_000 }).then(() => true, () => false);
const harnessLog = (page) => page.evaluate(() => [...window.__loginHarness.log]);
const inDialog = (page) => page.evaluate(() => !!document.activeElement?.closest('[data-pc="start-login-dialog"]'));
const cur = '[data-pc="start-login-dialog"] .ps-ld-page.is-current';

try {
  /* ---------------- D1–D6 ---------------- */
  {
    const page = await open();
    check(await has(page, '[data-pc="start-online"]') && !(await has(page, '[data-pc="start-login"]')), 'D1.start-page-not-login-page');
    check(await has(page, '[data-pc="start-sign-in"]') && !(await has(page, '[data-pc="start-top-account"]')), 'D1.sign-in-in-account-slot');

    await click(page, '[data-pc="start-sign-in"]');
    // "Sign up with email" shows once the account client is made (it needs the device identity first)
    await page.waitForSelector('[data-pc="start-login-register"]', { timeout: 5_000 }).catch(() => {});
    const d2 = await page.evaluate(() => {
      const d = document.querySelector('[data-pc="start-login-dialog"]');
      const links = [...(d?.querySelectorAll('.ps-ld-terms a') ?? [])].map((a) => new URL(a.href).pathname);
      return {
        modal: d?.getAttribute('role') === 'dialog' && d?.getAttribute('aria-modal') === 'true',
        page: d?.getAttribute('data-page'),
        account: !!d?.querySelector('[data-pc="start-login-account"]'),
        google: !!d?.querySelector('[data-pc="harness-google-button"]'),
        register: !!d?.querySelector('[data-pc="start-login-register"]'),
        guest: !!d?.querySelector('[data-pc="start-login-guest"]'),
        links,
      };
    });
    await sleep(50);
    check(d2.modal && d2.page === 'choose' && d2.account && d2.google && d2.register && d2.guest && d2.links.join(',') === '/terms,/privacy', 'D2.choose-page', d2);
    check(await inDialog(page), 'D2.focus-inside');

    // D4 focus trap
    let trapped = true;
    for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); if (!(await inDialog(page))) trapped = false; }
    for (let i = 0; i < 14; i++) { await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); if (!(await inDialog(page))) trapped = false; }
    check(trapped, 'D4.focus-trapped');

    // D3 close three ways, focus back to the opener
    await page.keyboard.press('Escape');
    const escClosed = await waitClosed(page);
    const focusBack = await page.evaluate(() => document.activeElement?.getAttribute('data-pc'));
    check(escClosed && focusBack === 'start-sign-in', 'D3.esc-closes-focus-back', { escClosed, focusBack });
    await click(page, '[data-pc="start-sign-in"]');
    await page.mouse.click(8, 400);
    check(await waitClosed(page), 'D3.backdrop-closes');
    await click(page, '[data-pc="start-sign-in"]');
    await click(page, '[data-pc="start-login-close"]');
    check(await waitClosed(page), 'D3.x-closes');

    // D5 page turn
    await click(page, '[data-pc="start-sign-in"]');
    await click(page, '[data-pc="start-login-account"]');
    const fwd = await page.evaluate((s) => getComputedStyle(document.querySelector(s)).animationName, cur);
    await waitPage(page, 'login');
    await sleep(400);
    await click(page, `${cur} [data-pc="start-login-back"]`);
    const back = await page.evaluate((s) => getComputedStyle(document.querySelector(s)).animationName, cur);
    check(fwd === 'ps-ld-in-fwd' && back === 'ps-ld-in-back', 'D5.page-turn', { fwd, back });
    await sleep(400);

    // D6 wrong then right password
    await click(page, '[data-pc="start-login-account"]');
    await waitPage(page, 'login'); await sleep(400);
    await type(page, `${cur} input[name="username"]`, 'mei');
    await type(page, `${cur} input[name="password"]`, 'nope-nope');
    await click(page, '[data-pc="start-login-submit"]');
    await page.waitForSelector(`${cur} [data-pc="start-login-error"]`, { timeout: 10_000 }).catch(() => {});
    const err = await text(page, `${cur} [data-pc="start-login-error"]`);
    check(!!err && (await dialogPage(page)) === 'login', 'D6.wrong-password-error-in-dialog', { err });
    await type(page, `${cur} input[name="password"]`, 'right-password');
    await click(page, '[data-pc="start-login-submit"]');
    const closed = await waitClosed(page);
    await sleep(200);
    const name = await text(page, '[data-pc="start-account-name"]');
    check(closed && name === 'mei' && !(await has(page, '[data-pc="start-sign-in"]')), 'D6.right-password-signs-in', { closed, name });
    await page.close();
  }

  /* ---------------- D5 reduced motion ---------------- */
  {
    const page = await open('', { reduced: true });
    await click(page, '[data-pc="start-sign-in"]');
    await click(page, '[data-pc="start-login-account"]');
    const anim = await page.evaluate((s) => getComputedStyle(document.querySelector(s)).animationName, cur);
    const others = await page.evaluate(() => [...document.querySelectorAll('.ps-ld-page')].filter((p) => getComputedStyle(p).display !== 'none').length);
    check(anim === 'none' && others === 1, 'D5.reduced-motion-no-animation', { anim, others });
    await page.close();
  }

  /* ---------------- D7 sidebar and sentence ---------------- */
  {
    const page = await open();
    const collapsed = await page.evaluate(() => document.querySelector('[data-pc="start-side-collapse"]')?.getAttribute('aria-pressed'));
    if (collapsed === 'true') { await click(page, '[data-pc="start-side-collapse"]'); await sleep(200); }
    await click(page, '[data-pc="start-side-collapse"]');
    const side = await waitPage(page, 'choose');
    check(side, 'D7.expand-sidebar-asks-login', { collapsed });
    await page.keyboard.press('Escape'); await waitClosed(page);
    await page.waitForSelector('.ps-prompt textarea, [data-pc="start-prompt"] textarea, textarea', { visible: true });
    const ta = await page.$('textarea');
    await ta.type('Make a 30-second product intro');
    await page.keyboard.press('Enter');
    const asked = await waitPage(page, 'choose');
    await click(page, '[data-pc="start-login-account"]'); await waitPage(page, 'login'); await sleep(400);
    await type(page, `${cur} input[name="username"]`, 'mei');
    await type(page, `${cur} input[name="password"]`, 'right-password');
    await click(page, '[data-pc="start-login-submit"]');
    await waitClosed(page);
    await sleep(800);
    const log = await harnessLog(page);
    check(asked && log.some((l) => l.startsWith('create:')), 'D7.sentence-asks-login-then-carries-on', { asked, log });
    await page.close();
  }

  /* ---------------- D8 email sign-up ---------------- */
  {
    const page = await open();
    await click(page, '[data-pc="start-sign-in"]');
    await click(page, '[data-pc="start-login-register"]'); await waitPage(page, 'register'); await sleep(400);
    await type(page, `${cur} input[name="email"]`, 'mei@example.com');
    await type(page, `${cur} input[name="new-username"]`, 'mei');
    await type(page, `${cur} input[name="new-password"]`, 'password-1');
    await type(page, `${cur} input[name="new-password-2"]`, 'password-2');
    await click(page, '[data-pc="start-register-submit"]');
    const mismatch = await text(page, `${cur} [data-pc="start-login-error"]`);
    await type(page, `${cur} input[name="new-password-2"]`, 'password-1');
    await click(page, '[data-pc="start-register-submit"]');
    const atVerify = await waitPage(page, 'verify');
    await sleep(450);
    const lead = await text(page, `${cur} .ps-ld-lead`);
    const log = await harnessLog(page);
    const signedIn = await has(page, '[data-pc="start-top-account"]');
    check(!!mismatch && atVerify && /mei@example\.com/.test(lead ?? '') && signedIn && ['register:mei', 'adopt', 'email-start:mei@example.com'].every((x) => log.includes(x)), 'D8.register-then-verify', { mismatch, atVerify, lead, signedIn, log });
    await type(page, `${cur} input[name="code"]`, '000000');
    await click(page, '[data-pc="start-verify-submit"]');
    await page.waitForSelector(`${cur} [data-pc="start-login-error"]`, { timeout: 10_000 }).catch(() => {});
    const bad = await text(page, `${cur} [data-pc="start-login-error"]`);
    check(bad === 'The code is wrong or has expired.', 'D8.bad-code-mapped', { bad });
    await type(page, `${cur} input[name="code"]`, '123456');
    await click(page, '[data-pc="start-verify-submit"]');
    check(await waitClosed(page) && (await harnessLog(page)).includes('email-confirm:123456'), 'D8.code-closes');
    await page.close();
  }

  /* ---------------- D9 email taken ---------------- */
  {
    const page = await open('lang=zh-CN');
    await click(page, '[data-pc="start-sign-in"]');
    await click(page, '[data-pc="start-login-register"]'); await waitPage(page, 'register'); await sleep(400);
    await type(page, `${cur} input[name="email"]`, 'taken@example.com');
    await type(page, `${cur} input[name="new-username"]`, 'mei');
    await type(page, `${cur} input[name="new-password"]`, 'password-1');
    await type(page, `${cur} input[name="new-password-2"]`, 'password-1');
    await click(page, '[data-pc="start-register-submit"]');
    await waitPage(page, 'verify'); await sleep(450);
    const d9 = await page.evaluate((s) => ({
      lead: document.querySelector(`${s} .ps-ld-lead`)?.textContent,
      err: document.querySelector(`${s} [data-pc="start-login-error"]`)?.textContent,
      resend: !!document.querySelector(`${s} [data-pc="start-verify-send"]`),
    }), cur);
    check(d9.lead === '账号已经建好，也已登录。' && d9.err === '这个邮箱已经绑定了别的账号。' && d9.resend, 'D9.email-taken-resend', d9);
    await type(page, `${cur} input[name="email"]`, 'mei@example.com');
    await click(page, '[data-pc="start-verify-send"]');
    await page.waitForSelector(`${cur} [data-pc="start-verify-submit"]`, { timeout: 10_000 }).catch(() => {});
    check(await has(page, `${cur} [data-pc="start-verify-submit"]`), 'D9.resend-goes-to-code');
    await click(page, '[data-pc="start-verify-later"]');
    check(await waitClosed(page), 'D9.later-closes');
    await page.close();
  }

  /* ---------------- D10 no register ---------------- */
  {
    const page = await open('register=0');
    await click(page, '[data-pc="start-sign-in"]');
    await sleep(1000);
    const reg = await has(page, '[data-pc="start-login-register"]');
    await click(page, '[data-pc="start-login-account"]'); await waitPage(page, 'login'); await sleep(400);
    const link = await has(page, `${cur} [data-pc="start-login-to-register"]`);
    check(!reg && !link, 'D10.no-register-hidden', { reg, link });
    await page.close();
  }

  /* ---------------- D11 Google unreachable ---------------- */
  {
    const page = await open('google=unreachable', { blockGoogle: true });
    await click(page, '[data-pc="start-sign-in"]');
    await page.waitForSelector('[data-pc="start-login-google-off"]', { timeout: 15_000 }).catch(() => {});
    const note = await text(page, '[data-pc="start-login-google-off"]');
    check(note === 'Can’t reach Google right now. Use account login or sign up with email instead.' && await has(page, '[data-pc="start-login-account"]') && await has(page, '[data-pc="start-login-register"]'), 'D11.google-unreachable-note', { note });
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'en-dark-choose-google-unreachable.png') });
    await page.close();
  }

  /* ---------------- D12 first Google sign-in ---------------- */
  {
    const page = await open('gnew=1');
    await click(page, '[data-pc="start-sign-in"]');
    await click(page, '[data-pc="harness-google-button"]');
    const atPick = await waitPage(page, 'pick');
    await sleep(450);
    const lead = await text(page, `${cur} .ps-ld-lead`);
    await type(page, `${cur} input[name="pick-username"]`, 'meimei');
    await click(page, '[data-pc="start-login-google-create"]');
    const closed = await waitClosed(page);
    await sleep(200);
    check(atPick && /mei@example\.com/.test(lead ?? '') && closed && (await text(page, '[data-pc="start-account-name"]')) === 'meimei', 'D12.google-pick-name', { atPick, lead, closed });
    await page.close();
  }

  /* ---------------- D13 direct address ---------------- */
  {
    const page = await open('addr=project');
    check(await waitPage(page, 'choose'), 'D13.direct-address-opens-dialog');
    await page.close();
  }

  /* ---------------- D14 guest ---------------- */
  {
    const page = await open();
    await click(page, '[data-pc="start-sign-in"]');
    await click(page, '[data-pc="start-login-guest"]');
    const closed = await waitClosed(page);
    await sleep(200);
    check(closed && (await text(page, '[data-pc="start-account-name"]')) === 'Guest-3944', 'D14.guest');
    await page.close();
  }

  /* ---------------- D15 phone width ---------------- */
  {
    const page = await open('', { width: 375, height: 760 });
    await click(page, '[data-pc="start-sign-in"]').catch(() => {});
    const opened = await waitPage(page, 'choose');
    await sleep(350);
    const box = await page.evaluate(() => {
      const r = document.querySelector('[data-pc="start-login-dialog"]').getBoundingClientRect();
      const m = document.querySelector('[data-pc="start-login-dialog-mask"]');
      return { left: r.left, right: r.right, sw: m.scrollWidth, cw: m.clientWidth };
    });
    // Only the dialog is judged here: the desktop start page under it is not laid out for 375 (phones get the mobile app)
    check(opened && box.left >= 0 && box.right <= 375 && box.sw <= box.cw, 'D15.phone-width-fits', { opened, box });
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'en-dark-phone-choose.png') });
    await page.close();
  }

  /* ---------------- D16 archived page ---------------- */
  {
    const page = await open('login=page');
    check(await has(page, '[data-pc="start-vibe-login"] [data-pc="start-login"]'), 'D16.archived-login-page');
    await page.close();
  }

  /* ---------------- D17 wording + screenshots ---------------- */
  const WORDING = {
    'zh-CN': { title: '登录 VisuHive', lead: '一个账号，官网、网页版和桌面版通用', account: '账号登录', register: '邮箱注册', signIn: '登录' },
    ja: { title: 'VisuHive にログイン', lead: '1 つのアカウントで、公式サイト・Web 版・デスクトップ版を使えます', account: 'アカウントでログイン', register: 'メールで登録', signIn: 'ログイン' },
    en: { title: 'Sign in to VisuHive', lead: 'One account for the website, web app and desktop app', account: 'Account login', register: 'Sign up with email', signIn: 'Sign in' },
  };
  for (const lang of ['en', 'zh-CN', 'ja']) {
    for (const skin of SHOTS ? ['studio-dark', 'studio-light'] : ['studio-dark']) {
      const tag = `${lang}-${skin.replace('studio-', '')}`;
      const shot = (name) => (SHOTS ? page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`) }) : null);
      const page = await open(`lang=${lang}&gnew=1`, { skin });
      await shot('page-signed-out');
      await click(page, '[data-pc="start-sign-in"]');
      await page.waitForSelector('[data-pc="start-login-register"]', { timeout: 5_000 }).catch(() => {});
      await sleep(450);
      if (skin === 'studio-dark') {
        const w = await page.evaluate(() => ({
          title: document.querySelector('[data-ld-page="choose"] .ps-ld-title')?.textContent,
          lead: document.querySelector('[data-ld-page="choose"] .ps-ld-lead')?.textContent,
          account: document.querySelector('[data-pc="start-login-account"] span')?.textContent,
          register: document.querySelector('[data-pc="start-login-register"] span')?.textContent,
          signIn: document.querySelector('[data-pc="start-sign-in"]')?.textContent,
        }));
        check(JSON.stringify(w) === JSON.stringify(WORDING[lang]), `D17.wording-${lang}`, w);
      }
      await shot('1-choose');
      await click(page, '[data-pc="start-login-account"]'); await waitPage(page, 'login'); await sleep(450);
      await type(page, `${cur} input[name="username"]`, 'mei');
      await type(page, `${cur} input[name="password"]`, 'nope-nope');
      await shot('2-login');
      await click(page, `${cur} [data-pc="start-login-to-register"]`); await waitPage(page, 'register'); await sleep(450);
      await shot('3-register');
      await type(page, `${cur} input[name="email"]`, 'taken@example.com');
      await type(page, `${cur} input[name="new-username"]`, 'mei');
      await type(page, `${cur} input[name="new-password"]`, 'password-1');
      await type(page, `${cur} input[name="new-password-2"]`, 'password-1');
      await click(page, '[data-pc="start-register-submit"]'); await waitPage(page, 'verify'); await sleep(450);
      await shot('5-verify-send-failed');
      await type(page, `${cur} input[name="email"]`, 'mei@example.com');
      await click(page, '[data-pc="start-verify-send"]');
      await page.waitForSelector(`${cur} [data-pc="start-verify-submit"]`, { timeout: 10_000 }).catch(() => {});
      await sleep(200);
      await shot('4-verify');
      await page.close();
      // The pick page (first Google sign-in) needs a fresh, logged-out page
      const p2 = await open(`lang=${lang}&gnew=1`, { skin });
      await click(p2, '[data-pc="start-sign-in"]');
      await click(p2, '[data-pc="harness-google-button"]'); await waitPage(p2, 'pick'); await sleep(450);
      if (SHOTS) await p2.screenshot({ path: path.join(OUT, `${tag}-6-pick.png`) });
      await p2.close();
    }
  }

  check(errors.length === 0, 'D18.no-page-errors', errors);
} finally {
  await browser.close().catch(() => {});
  server.close();
  await vite.close().catch(() => {});
}

const passed = Object.values(results).filter(Boolean).length;
console.log(JSON.stringify({ ok: fails.length === 0, passed, total: Object.keys(results).length, out: OUT, fails }));
process.exit(fails.length === 0 ? 0 : 1);
