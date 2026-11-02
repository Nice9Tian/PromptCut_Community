// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * Acceptance probe for rendering the chat panel in the side panel when Vibe mode "detail
 * editing" is expanded (issue #4, user decision, 2026-10-26).
 *
 * No cloud connection, no project, no real stage mounted: `src/start/extchat-harness.tsx` renders
 * that side panel in isolation using mock messages provided by the probe, served via Vite
 * middleware mode (same approach as `mobile-agent-view-probe.mjs`).
 *
 *   node scripts/probes/vibe-ext-chat-probe.mjs [--out <screenshot-dir>] [--port 5952]
 *   Port: 5950-5959 assigned to this probe
 *
 * Acceptance (each item adds a line to `fails` in the final JSON line):
 *   V1 Only the **latest Agent response** retains full text; remaining Agent responses and all
 *      user bubbles are collapsed (`data-folded`); the full-text one is labeled "Latest response"
 *      above.
 *   V2 Collapsed text is exactly two lines: visible height of the text in the bubble is ~2 lines,
 *      and is indeed truncated.
 *   V3 The collapsed round of "Agent operations" is folded as a whole block, additionally labeled
 *      "… N more operations", where N matches the number of operations in this round.
 *   V4 Clicking a collapsed bubble expands only that bubble (`data-folded` removed, operation cards
 *      displayed), while others remain collapsed.
 *   V5 "Jia": top two sections are expanded as usual, chat panel consumes the remaining height of
 *      this panel (bottom edge flush with panel bottom padding), and input box is pinned to the
 *      bottom of the panel itself, inside the panel.
 *   V6 Short sentences that fit in a single line do not appear clickable: collapsed (`data-folded`)
 *      but without `data-more`.
 *   V7 At minimum width 250px (`EXT_WIDTH.min` in `sideWidth.ts`), no horizontal overflow and no
 *      page errors.
 * Screenshots: `ext-chat-<width>.png`, `ext-chat-expanded.png`. The last line is a JSON line:
 * { ok, fails, ... }. Exit code 0 for pass, 1 for fail.
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

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 5 * 60_000).unref();

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'vibe-ext-chat-shots')));
const PORT = Number(arg('--port', 5952));
if (PORT < 5950 || PORT > 5959) throw new Error(`Port ${PORT} is not within 5950-5959, the range assigned to this probe`);
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, V1: {}, V2: {}, V3: {}, V4: {}, V5: {}, V6: {}, V7: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 500))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portOpen = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
if (await portOpen(PORT)) throw new Error(`Port ${PORT} is already in use`);

const vite = await createViteServer({
  configFile: false, root: ROOT, plugins: [react()], appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, hmr: false, fs: { strict: true, deny: ['**/.git/**', '**/out/**', '**/.env*', '**/*.{pem,key,crt}'] } },
});
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
  if (pathname === '/' || pathname === '/harness.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%}#root{height:100%}</style></head><body><div id="root"></div><script type="module" src="/src/start/extchat-harness.tsx"></script></body></html>');
    return;
  }
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (!pathname.startsWith('/src/') && !pathname.startsWith('/node_modules/') && !pathname.startsWith('/@') && !pathname.startsWith('/__vite') && !pathname.startsWith('/server/')) { res.writeHead(404); res.end(); return; }
  vite.middlewares(req, res, () => { res.writeHead(404); res.end(); });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });

/* -- Mock messages: two rounds of responses with operations, user text between; last user message is only one line -- */
const now = Date.now();
const tool = (name, input = {}, ok) => ({ kind: 'tool', name: `mcp__promptcut__${name}`, input, ...(ok === undefined ? {} : { ok }) });
const say = (text) => tool('send_message', { to: 'user', text }, true);
const MSGS = [
  { id: 'u1', role: 'user', text: 'Make a 60-second single-take animation with code: a floor plan photo on a desk > scan and straighten > walls grow out of the lines, doors, windows and furniture settle into place, the camera passes through the balcony door into the living room, and the picture uses path tracing to converge from noise to photorealistic quality > narrate in turn following the floor plan.' },
  { id: 'a1', role: 'assistant', text: '', startedAt: now, finishedAt: now, outcome: 'completed', parts: [
    say('OK. I\'ll first split this video into 6 parts: desktop still life; scan and straighten; wall growth; doors, windows and furniture settling into place; walking through the door into the hall; path tracing convergence. First I\'ll set up the project and lay out the cards for the first two parts as well, so you can take a look and see whether the pacing is right.'),
    tool('add_clip', { name: 'Floor plan photo' }, true),
    tool('add_clip', { name: 'Scan and straighten' }, true),
  ] },
  { id: 'u2', role: 'user', text: 'A bit slower' },
  { id: 'a2', role: 'assistant', text: '', startedAt: now, finishedAt: now, outcome: 'completed', parts: [
    say('I have stretched "Wall growth" from 5 to 8 seconds, and the following parts are pushed back. The whole piece is now 62 seconds. Should I squeeze the last narration part down to 6 seconds to bring it back to exactly 60 seconds?'),
    tool('set_clip_param', { id: 'c2' }, true),
  ] },
];
const base = { messages: MSGS, width: 320, canSend: true, whyNot: null };

const browser = await puppeteer.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], protocolTimeout: 300_000, args: [...PROBE_CHROME_ARGS, '--no-first-run'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text()}`); });
  await page.setViewport({ width: 1440, height: 840 });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__extChatHarness, { timeout: 120_000 });

  const render = async (s) => { await page.evaluate((st) => window.__extChatHarness.render(st), s); await sleep(400); };
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

  /** What each message in the panel currently looks like */
  const readRows = () => page.evaluate(() => [...document.querySelectorAll('[data-pc="start-ext-chat-msg"]')].map((row) => {
    const holder = row.querySelector('.ps-xbubble, .ps-xbody');
    const p = holder?.querySelector('.ps-xtext');
    const cs = p ? getComputedStyle(p) : null;
    return {
      from: row.dataset.from,
      folded: holder?.hasAttribute('data-folded') ?? null,
      more: holder?.hasAttribute('data-more') ?? null,
      cursor: holder ? getComputedStyle(holder).cursor : null,
      textH: p ? Math.round(p.clientHeight) : null,
      scrollH: p ? Math.round(p.scrollHeight) : null,
      lineH: cs ? Math.round(parseFloat(cs.lineHeight)) : null,
      opsVisible: !!holder?.querySelector('.ps-xops') && getComputedStyle(holder.querySelector('.ps-xops')).display !== 'none',
      opsCount: holder?.querySelectorAll('.ps-xops-list li').length ?? 0,
      more_text: holder?.querySelector('.ps-xmore')?.textContent ?? null,
      head: (p?.textContent ?? '').slice(0, 14),
    };
  }));

  /* ================================================================ V1-V3, V6 */
  await render({ ...base, width: 320 });
  await shot('ext-chat-320');
  {
    const rows = await readRows();
    out.V1 = rows.map((r) => ({ from: r.from, folded: r.folded, more: r.more, head: r.head }));
    check(rows.length === 4, 'V1 all four messages were rendered', rows.length);
    check(rows.slice(0, 3).every((r) => r.folded === true), 'V1 the old Agent replies and user bubbles are all collapsed', rows.map((r) => r.folded));
    check(rows[3]?.folded === false || rows[3]?.folded === null, 'V1 the latest Agent reply keeps its full text', rows[3]);
    const latestTag = await page.$eval('.ps-xlatest', (e) => e.textContent).catch(() => null);
    check(latestTag === 'Latest reply', 'V1 the full-text one is tagged "Latest reply" above it', latestTag);

    const long = rows[0];
    out.V2 = long;
    check(long.textH !== null && long.lineH !== null && Math.abs(long.textH - long.lineH * 2) <= 2, 'V2 the collapsed text is exactly two lines', long);
    check(long.scrollH - long.textH > 2, 'V2 it was indeed truncated (it is not just exactly two lines)', long);

    const foldedAgent = rows[1];
    out.V3 = foldedAgent;
    check(foldedAgent.from === 'agent' && !foldedAgent.opsVisible, 'V3 the "Agent operations" of the collapsed round are folded', foldedAgent);
    check(foldedAgent.more_text === `… ${foldedAgent.opsCount} more operations` && foldedAgent.opsCount === 2, 'V3 it states how many more operations there are, and the count matches', foldedAgent);
    check(rows[3].opsVisible === true, 'V3 the latest one\'s operations are shown as usual', rows[3]);

    const short = rows[2];
    out.V6 = short;
    check(short.folded === true && short.more === false, 'V6 a short sentence that fits on one line stays collapsed but does not look expandable', short);
    check(short.cursor !== 'zoom-in', 'V6 no zoom-in cursor on the short sentence', short);
    check(rows[0].more === true && rows[0].cursor === 'zoom-in', 'V6 only the one that is actually truncated gets zoom-in', rows[0]);
  }

  /* ================================================================ V4 Expand one */
  {
    await page.evaluate(() => document.querySelectorAll('[data-pc="start-ext-chat-msg"]')[1].querySelector('.ps-xbody').click());
    await sleep(300);
    await shot('ext-chat-expanded');
    const rows = await readRows();
    out.V4 = rows.map((r) => ({ from: r.from, folded: r.folded, opsVisible: r.opsVisible }));
    check(rows[1].folded === false, 'V4 the row that was clicked is expanded', rows[1]);
    check(rows[1].opsVisible === true, 'V4 the operations card appears after expanding', rows[1]);
    check(rows[0].folded === true && rows[2].folded === true, 'V4 the other rows stay collapsed', out.V4);
  }

  /* ================================================================ V5 Height allocation ("Jia") */
  {
    await render({ ...base, width: 320 });
    const box = await page.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) }; };
      const secs = [...document.querySelectorAll('[data-pc="harness-ext-sec"]')].map((e) => ({ h: Math.round(e.getBoundingClientRect().height), bodyShown: !!e.querySelector('.ps-ext-body') && getComputedStyle(e.querySelector('.ps-ext-body')).display !== 'none' }));
      const ext = document.querySelector('[data-pc="start-ext"]');
      const pad = parseFloat(getComputedStyle(ext).paddingBottom);
      return { ext: r('[data-pc="start-ext"]'), chat: r('[data-pc="start-ext-chat"]'), list: r('[data-pc="start-ext-chat-list"]'), foot: r('.ps-ext-chat-foot'), input: r('.ps-ext-chat-foot [data-pc="start-chat-input"]'), secs, pad };
    });
    out.V5 = box;
    check(box.secs.length === 2 && box.secs.every((s) => s.bodyShown && s.h > 40), 'V5 the two sections above stay expanded as usual', box.secs);
    check(Math.abs(box.chat.bottom - (box.ext.bottom - box.pad)) <= 1, 'V5 the chat panel takes up the remaining height, with its bottom edge flush against the side panel\'s bottom padding', box);
    check(box.chat.h > box.secs[0].h, 'V5 the chat panel is taller than the section above it', box);
    check(box.foot.bottom <= box.chat.bottom && box.foot.top >= box.list.bottom - 1, 'V5 the input box is pinned to the panel\'s own bottom, inside the panel', box);
  }

  /* ================================================================ V7 Minimum width 250 */
  {
    await render({ ...base, width: 250 });
    await shot('ext-chat-250');
    const narrow = await page.evaluate(() => {
      const ext = document.querySelector('[data-pc="start-ext"]');
      const list = document.querySelector('[data-pc="start-ext-chat-list"]');
      return {
        extW: Math.round(ext.getBoundingClientRect().width),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        listOverflowX: list.scrollWidth - list.clientWidth,
        rows: document.querySelectorAll('[data-pc="start-ext-chat-msg"]').length,
      };
    });
    out.V7 = { ...narrow, errors };
    check(narrow.extW === 250, 'V7 this side panel is exactly 250 wide', narrow);
    check(narrow.overflowX <= 0 && narrow.listOverflowX <= 0, 'V7 no horizontal overflow at 250 wide', narrow);
    check(errors.length === 0, 'V7 the page has no errors', errors.slice(0, 3));
  }
} finally {
  await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
  await vite.close().catch(() => {});
}

out.ok = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
