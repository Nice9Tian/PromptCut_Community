// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * Interface language acceptance: walks every Vibe mode screen and the Classic editor in English,
 * Simplified Chinese and Japanese, and takes a screenshot of each.
 *
 *   node scripts/probes/i18n-screens-probe.mjs [--out <folder>] [--port <port>] [--editor http://127.0.0.1:5213]
 *
 * Without --editor it starts its own dev server with temporary project, chat and config folders.
 * With --editor it uses that server as it is, so give it one with disposable data.
 *
 * Acceptance, each failure is one line in `fails` of the JSON printed last:
 *   L1 English screens show no Chinese or Japanese, apart from the language menu and project data.
 *   L2 Chinese and Japanese screens show no English sentence or label that should have been translated,
 *      also inside a line that mixes in some Chinese.
 *   L3 No button, tab or menu item has its text cut off, in any language.
 *   L4 Switching language in Vibe mode and in the editor comes back to the same project.
 *   L5 No page errors.
 * Screens: home, agent setup, row menu, new project, chat, side panel, detail editing,
 * detail editing with the side panel closed, Classic editor, Classic start page.
 * Exit code 0 passes, 1 fails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startDevServer } from '../lib/dev-server.mjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 20 * 60_000).unref();

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'i18n-screens')));
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, screens: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CJK = /[぀-ヿ㐀-鿿]/;
/** Text that is data or a language's own name, not interface text */
const ALLOW = /^(简体中文|日本語|English|PromptCut)$/;
const SAMPLE_USER = 'Make a 30-second product intro';
const SAMPLE_AGENT = 'The first cut is on the timeline.';

let server = null;
let editor = arg('--editor', '');
const port = Number(arg('--port', '0')) || undefined;
if (!editor) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-screens-'));
  fs.writeFileSync(path.join(box, 'ai.json'), JSON.stringify({ defaultProvider: 'claude' }));
  server = await startDevServer({
    port,
    env: { PROMPTCUT_AI_CONFIG: path.join(box, 'ai.json'), PROMPTCUT_PROJECTS_DIR: path.join(box, 'projects'), PROMPTCUT_CHATS_DIR: path.join(box, 'chats') },
    logFile: path.join(box, 'vite.log'),
  });
  editor = server.origin;
}

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function inspect(page) {
  return page.evaluate(() => {
    // Project names are the user's data, not interface text
    const names = [...document.querySelectorAll('[data-pc="start-side-project"] .ps-row-name, [data-pc="start-project-tile"] [title]')].map((e) => e.textContent.trim()).filter(Boolean);
    const strip = (t) => names.reduce((acc, n) => acc.split(n).join(""), t);
    const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.01; };
    const texts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.trim();
      const el = n.parentElement;
      if (!t || !el || ['SCRIPT', 'STYLE', 'OPTION', 'CODE', 'PRE'].includes(el.tagName) || !visible(el)) continue;
      if (el.closest('[data-pc="stage-frame"], [data-pc="preview"], [data-pc="language-menu"], [data-i18n-data]')) continue;
      texts.push(strip(t));
    }
    for (const el of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
      if (!visible(el) || el.closest('[data-pc="language-menu"]')) continue;
      for (const a of ['title', 'placeholder', 'aria-label']) { const v = el.getAttribute(a); if (v) texts.push(strip(v)); }
    }
    const cut = [];
    for (const el of document.querySelectorAll('button, [role="tab"], [role="menuitem"], a, label, th')) {
      if (!visible(el) || !el.textContent.trim()) continue;
      const s = getComputedStyle(el);
      if (s.overflowX !== 'visible' && s.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2) cut.push(el.textContent.trim().slice(0, 50));
      if (s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 2 && !el.title) cut.push('…' + el.textContent.trim().slice(0, 50));
    }
    // Uncollapsed button label spans use overflow:hidden for collapse transitions and must not clip text
    for (const span of document.querySelectorAll('button:not(.pc-btn--collapsed) .pc-btn-label')) {
      if (!visible(span) || !span.textContent.trim()) continue;
      if (span.scrollWidth > span.clientWidth + 1) cut.push(span.textContent.trim().slice(0, 50));
    }
    // Vertical rail labels must sit on a single line and fit inside their .pc-rail-item pill
    for (const span of document.querySelectorAll('.pc-dock-rail .pc-rail-item span:not(.pc-rr-glyph)')) {
      if (!visible(span) || !span.textContent.trim()) continue;
      const btn = span.closest('.pc-rail-item');
      if (!btn) continue;
      const sr = span.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      if (sr.height > 18 || sr.width > br.width - 1 || span.scrollWidth > span.clientWidth + 1) {
        cut.push(span.textContent.trim().slice(0, 50));
      }
    }
    return { texts: [...new Set(texts)], cut: [...new Set(cut)] };
  });
}

async function walk(locale) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => fails.push(`L5 ${locale} page error: ${String(e).slice(0, 200)}`));
  const report = {};
  const shot = async (name) => {
    await sleep(700);
    await page.screenshot({ path: path.join(OUT, `${locale}-${name}.png`) });
    const { texts, cut } = await inspect(page);
    report[name] = { cut };
    for (const c of cut) fails.push(`L3 ${locale}/${name} text cut off: ${c}`);
    if (locale === 'en') {
      for (const t of texts) if (CJK.test(t) && !ALLOW.test(t)) fails.push(`L1 ${locale}/${name}: ${t.slice(0, 80)}`);
    } else {
      for (const t of texts) {
        if (ALLOW.test(t) || t === SAMPLE_USER || t === SAMPLE_AGENT) continue;
        // A label of two words is enough ("Shot detection"), also inside a line that mixes in some
        // Chinese (a translated prefix with an English reason after it). Commands quoted in a hint
        // are not interface text.
        const runs = t.split(/[぀-ヿ㐀-鿿　-〿＀-￯]+/).map((r) => r.replace(/\b(npm run|pip install) [\w-]+/g, ''));
        if (runs.some((r) => /\b[A-Z]?[a-z]+ [a-z]{3,}\b/.test(r))) fails.push(`L2 ${locale}/${name}: ${t.slice(0, 80)}`);
      }
    }
  };
  const click = async (pc) => {
    const h = await page.$(`[data-pc="${pc}"]`);
    if (!h) { fails.push(`${locale}: no ${pc} on screen`); return false; }
    const r = await h.boundingBox();
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    return true;
  };
  const closeDialog = () => page.evaluate(() => {
    for (const b of document.querySelectorAll('button')) if (['Close', '关闭', '閉じる'].includes(b.textContent.trim())) { b.click(); return; } // i18n-allow: the close button in each language
  });

  await page.goto(`${editor}/?ui=vibe&lang=${locale}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(7000);
  await shot('agent-setup');
  await closeDialog();
  await sleep(800);
  await shot('home');

  // A new project opens the desktop New Project dialog first, then lands on its chat page.
  await click('start-side-new');
  await sleep(600);
  if (await page.$('[data-pc="new-project-local-confirm"]')) {
    await shot('new-project-dialog');
    await click('new-project-local-confirm');
  }
  await sleep(6000);
  await page.evaluate(async (user, agent) => {
    const lc = await import('/src/ai/liveChat.ts');
    const at = await import('/src/ai/agentTabs.ts');
    lc.getChatStore(at.getActiveTabId()).replace([{ id: 'u', role: 'user', text: user, parts: [{ type: 'text', text: user }] }, { id: 'a', role: 'assistant', text: agent, parts: [{ type: 'text', text: agent }] }]);
  }, SAMPLE_USER, SAMPLE_AGENT);
  await sleep(1000);
  await shot('chat');
  const row = await page.$('[data-pc="start-side-project"]');
  if (row) {
    const r = await row.boundingBox();
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2, { button: 'right' });
    await shot('row-menu');
    await page.keyboard.press('Escape');
    await page.mouse.click(760, 450);
  }
  await click('start-ext-detail');
  await sleep(5000);
  await shot('detail');
  await click('start-chat-ext-toggle');
  await sleep(800);
  await shot('detail-no-panel');
  await click('start-chat-ext-toggle');
  await sleep(500);

  // Language switch in Vibe mode comes back to this project's chat
  const other = locale === 'ja' ? 'en' : 'ja';
  const projectBefore = await page.$eval('[data-pc="start-chat-name"]', (e) => e.textContent).catch(() => null);
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }).catch(() => null), page.select('[data-pc="language-menu"] select', other)]);
  await sleep(9000);
  const backVibe = await page.$('[data-pc="start-chat"]');
  if (!backVibe) fails.push(`L4 ${locale}: Vibe language switch did not come back to the chat page`);
  const projectAfter = await page.$eval('[data-pc="start-chat-name"]', (e) => e.textContent).catch(() => null);
  if (projectBefore && projectBefore !== projectAfter) fails.push(`L4 ${locale}: chat changed from ${projectBefore} to ${projectAfter}`);
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }).catch(() => null), page.select('[data-pc="language-menu"] select', locale)]);
  await sleep(9000);

  await click('start-ext-detail');
  await sleep(4000);
  await click('start-enter-traditional');
  await sleep(14_000);
  await shot('classic');

  // Language switch in the editor comes back to the editor
  await page.evaluate(() => [...document.querySelectorAll('button[aria-expanded]')].find((x) => !x.className.includes('pc-titlebar') && x.getBoundingClientRect().top < 100)?.click());
  await sleep(500);
  await shot('classic-more-menu');
  await Promise.all([page.waitForNavigation({ timeout: 30_000 }).catch(() => null), page.select('[data-pc="language-menu"] select', other)]);
  await sleep(14_000);
  if (!(await page.$('[data-pc="editor"]'))) fails.push(`L4 ${locale}: editor language switch did not come back to the editor`);
  await page.close();
  await ctx.close();

  const ctx2 = await browser.createBrowserContext();
  const start = await ctx2.newPage();
  await start.setViewport({ width: 1440, height: 900 });
  await start.goto(`${editor}/?lang=${locale}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(5000);
  await start.screenshot({ path: path.join(OUT, `${locale}-classic-start.png`) });
  await ctx2.close();
  out.screens[locale] = report;
}

try {
  for (const locale of ['en', 'zh-CN', 'ja']) await walk(locale);
} catch (e) {
  fails.push(`walk stopped: ${e.message}`);
} finally {
  await browser.close();
  server?.stop?.();
}
out.ok = fails.length === 0;
out.fails = [...new Set(fails)];
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ok: out.ok, out: OUT, fails: out.fails.length, first: out.fails.slice(0, 30) }));
process.exit(out.ok ? 0 : 1);
